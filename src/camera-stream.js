import { ProtectCodecChangeError, ProtectLivestreamUnavailableError } from "unifi-protect";
import { applyRange } from "./avc-range.js";
import { channelList } from "./console-connection.js";
import { errorText } from "./util.js";

// How long a live view tolerates no video before the library declares a stall and reconnects.
const URGENCY_MS = 5_000;
// A stream that never starts (the library gives up establishing it: a camera that answers the
// negotiate but sends nothing, a 403) is tried again later and later, not every 10 s forever. Any
// video resets it.
const UNAVAILABLE_RETRY_MS = [10_000, 30_000, 120_000, 300_000];
// Before subscribing again after a stream error, or a stream that just ended.
const RESTART_GAP_MS = 3_000;
// A live stream starts over this long after its last start, plus up to a quarter more, so a PC's
// windows don't all go at once. Why: a camera page's CPU grows with the age of its player, not with
// the PC's load. On Camera Desktop (2026-11-25, 14 windows, a 35 W i3) each page cost about 4 % of
// a core plus 9 % per hour since its last restart, 360° or not (r = 0.95 over the 14), until the PC
// was pegged and the oldest players fell behind. A new subscription brings a new init, so the page
// rebuilds its player; it holds the last frame meanwhile. Where in Chromium or the library the cost
// builds up isn't known.
const REFRESH_MS = 30 * 60_000;
const REFRESH_SPREAD = 0.25;
// A refresh due while the stream isn't live (reconnecting, a stall) waits for it to be live again.
const REFRESH_RETRY_MS = 10_000;

/*
 * Pumps one camera's Protect livestream (fMP4 over the console's own websocket - no RTSP/RTSPS)
 * into one camera window. The renderer feeds the bytes to Media Source Extensions, so decoding
 * is done by Chromium's (GPU) video decoder.
 *
 * Sends to the window:
 *   "cam:init"   { codec, data, reset }   - init segment; reset=true means rebuild the decoder
 *   "cam:media"  Uint8Array               - one fMP4 fragment (~100 ms of video)
 *   "cam:status" { state, text }          - live | connecting | reconnecting | waiting | offline | paused | error
 */
export class CameraStream {
  #opts;
  #abort = null;
  #paused = false;
  #wake = null;
  #status = { state: "", text: "" };
  channel = null;

  /**
   * @param {object} opts
   * @param {() => any} opts.getConnection  - current ConsoleConnection (or mock)
   * @param {string} opts.cameraId
   * @param {(cam) => number} opts.resolveChannel
   * @param {() => string} [opts.getRange]   - "auto" | "full" | "limited" (see avc-range.js)
   * @param {(channel: string, payload: any) => void} opts.send
   * @param {object} opts.log
   * @param {number[]} [opts.unavailableRetryMs] - replaces UNAVAILABLE_RETRY_MS (unit tests)
   * @param {number} [opts.restartGapMs] - replaces RESTART_GAP_MS (unit tests)
   * @param {number} [opts.refreshMs] - replaces REFRESH_MS (tests)
   * @param {() => void} [opts.onRefresh] - a live stream started over on its timer
   */
  constructor(opts) {
    this.#opts = opts;
  }

  get status() { return this.#status; }

  start() {
    if (this.#abort || this.#paused) return;
    const ctrl = new AbortController();
    this.#abort = ctrl;
    this.#loop(ctrl.signal).catch((err) => this.#opts.log.error(`stream loop crashed: ${errorText(err)}`));
  }

  stop() {
    this.#abort?.abort();
    this.#abort = null;
    this.#wakeUp();
  }

  restart() {
    this.stop();
    this.start();
  }

  /** Stop and stay stopped with an error, until restart() (or a resume after pause()). */
  halt(text) {
    this.stop();
    this.#setStatus("error", text);
  }

  /** Stop pulling video while the window is minimized - saves bandwidth and CPU. */
  pause() {
    this.#paused = true;
    this.stop();
    this.#setStatus("paused", "Paused while minimized");
  }

  resume() {
    if (!this.#paused) return;
    this.#paused = false;
    this.start();
  }

  /** The console's state changed: re-evaluate now instead of waiting out a retry timer. */
  kick() {
    this.#wakeUp();
  }

  async #loop(signal) {
    const { getConnection, cameraId, log } = this.#opts;
    let unavailable = 0; // establish failures in a row

    while (!signal.aborted) {
      const conn = getConnection();
      if (!conn) {
        this.#setStatus("error", "Console removed");
        return;
      }
      if (conn.state !== "connected" && conn.state !== "reconnecting") {
        if (conn.state === "authfailed") this.#setStatus("error", `${conn.name}: login failed - fix it in the camera list`);
        else if (conn.state === "certchanged") this.#setStatus("error", `${conn.name}: its security certificate changed - check it in the camera list`);
        else this.#setStatus("waiting", `Connecting to ${conn.name}…`);
        await this.#sleep(15_000, signal);
        continue;
      }
      const cam = conn.camera(cameraId);
      if (!cam) {
        this.#setStatus(conn.state === "connected" ? "error" : "waiting",
          conn.state === "connected" ? "Camera not found on this console" : "Reconnecting to console…");
        await this.#sleep(15_000, signal);
        continue;
      }
      if (!cam.isOnline) {
        this.#setStatus("offline", "Camera offline");
        await this.#sleep(10_000, signal);
        continue;
      }

      this.channel = this.#opts.resolveChannel(cam);
      this.#setStatus("connecting", "Connecting…");

      const dropSub = new AbortController();
      const subSignal = AbortSignal.any([signal, dropSub.signal]);
      // A camera adopted by UniFi Access (a UA G3 Pro door reader) streams bare H.264 frames the
      // library never turns into segments: bare-livestream.js reads those itself.
      const sub = cam.config?.isAdoptedByAccessApp && conn.bareLivestream
        ? conn.bareLivestream(cam, this.channel, subSignal)
        : cam.livestream({
          source: { type: "channel", channel: this.channel },
          signal: subSignal,
          discardOnDispose: true,
          urgency: () => URGENCY_MS,
        });

      // The library hides short stalls inside the iterator (it just parks). Surface them. Its live
      // recovery never gives up, though: for a camera that went offline, or a channel turned off in
      // Protect, it would renegotiate every few seconds for as long as the window is open (about
      // 1000 requests an hour, each counted by its per-console circuit breaker). So drop the
      // subscription then, and let the loop wait for the camera or pick another channel.
      let dropped = "";
      const monitor = setInterval(() => {
        if (sub.state === "recovering") {
          const now = conn.camera(cameraId);
          if (!now?.isOnline) dropped = "camera went offline";
          else if (!channelList(now).some((c) => c.id === this.channel)) dropped = `channel ${this.channel} is no longer available`;
          if (dropped) dropSub.abort();
          else this.#setStatus("reconnecting", "Reconnecting…");
        } else if (sub.state === "live" && this.#status.state === "reconnecting") this.#setStatus("live", "");
      }, 1_000);

      // Each init rebuilds the page's player, so the refresh counts from the last one.
      let refreshing = false;
      let refreshTimer = null;
      const armRefresh = (ms) => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (this.#status.state !== "live" || sub.state === "recovering") return armRefresh(REFRESH_RETRY_MS);
          refreshing = true;
          dropSub.abort();
        }, ms);
      };

      let sentInit = false;
      const sendInit = (init) => {
        const data = applyRange(init.data, this.#opts.getRange?.() ?? "auto");
        this.#send("cam:init", { codec: init.codec, data: new Uint8Array(data), reset: true });
        sentInit = true;
        this.#setStatus("live", "");
        armRefresh((this.#opts.refreshMs ?? REFRESH_MS) * (1 + Math.random() * REFRESH_SPREAD));
      };

      try {
        for await (const seg of sub) {
          // Stopped or paused: a subscription can still hand over what it had queued. Sent anyway, it
          // reached the page after a pause and set the status back to "live" under a paused window.
          if (signal.aborted) break;
          if (seg.type === "init") {
            sendInit(seg);
            continue;
          }
          if (!sentInit || seg.discontinuity) {
            // A reconnect rebases timestamps to zero: rebuild the decoder at this keyframe.
            const init = sub.initSegment;
            if (!init) continue;
            sendInit(init);
          }
          if (this.#status.state !== "live") this.#setStatus("live", "");
          unavailable = 0;
          // The library builds each media segment in a buffer of its own (Buffer.alloc, offset 0), and
          // IPC copies what it sends anyway, so that goes as is. Only a view into a larger buffer (a
          // pooled one, like the mock's small segments) is copied, so no neighbouring bytes go along.
          const d = seg.data;
          this.#send("cam:media", d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d : new Uint8Array(d));
        }
        if (signal.aborted) return;
        if (refreshing) {
          this.#refreshed();
          continue;
        }
        if (dropped) {
          log.info(`stopped recovering ${cameraId} ch${this.channel}: ${dropped}`);
          continue;
        }
        // The library ends iteration (without an error) when its recovery gives up. Subscribing again
        // at once renegotiated back to back, each try counted by its per-console circuit breaker.
        log.info(`stream for ${cameraId} ended; restarting`);
        this.#setStatus("reconnecting", "Reconnecting…");
        await this.#sleep(this.#opts.restartGapMs ?? RESTART_GAP_MS, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (refreshing) {
          this.#refreshed();
          continue;
        }
        if (dropped) {
          log.info(`stopped recovering ${cameraId} ch${this.channel}: ${dropped}`);
          continue;
        }
        if (err instanceof ProtectCodecChangeError) {
          log.info(`codec changed on ${cameraId}; restarting stream`);
          continue;
        }
        const retry = this.#opts.unavailableRetryMs ?? UNAVAILABLE_RETRY_MS;
        const wait = err instanceof ProtectLivestreamUnavailableError ? retry[Math.min(unavailable++, retry.length - 1)] : this.#opts.restartGapMs ?? RESTART_GAP_MS;
        log.warn(`livestream ${cameraId} ch${this.channel}: ${errorText(err)}; trying again in ${Math.round(wait / 1000)} s`);
        this.#setStatus("reconnecting", "Reconnecting…");
        await this.#sleep(wait, signal);
      } finally {
        clearInterval(monitor);
        clearTimeout(refreshTimer);
        try { await sub[Symbol.asyncDispose](); } catch { /* already closed */ }
      }
    }
  }

  #refreshed() {
    this.#opts.log.debug(`refreshing ${this.#opts.cameraId} ch${this.channel} on its timer`);
    this.#opts.onRefresh?.();
  }

  #send(channel, payload) {
    this.#opts.send(channel, payload);
  }

  #setStatus(state, text) {
    if (this.#status.state === state && this.#status.text === text) return;
    this.#status = { state, text };
    this.#send("cam:status", this.#status);
  }

  #sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.#wake === finish) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  #wakeUp() {
    const w = this.#wake;
    this.#wake = null;
    w?.();
  }
}
