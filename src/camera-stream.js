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
      const sub = cam.livestream({
        source: { type: "channel", channel: this.channel },
        signal: AbortSignal.any([signal, dropSub.signal]),
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

      let sentInit = false;
      const sendInit = (init) => {
        const data = applyRange(init.data, this.#opts.getRange?.() ?? "auto");
        this.#send("cam:init", { codec: init.codec, data: new Uint8Array(data), reset: true });
        sentInit = true;
        this.#setStatus("live", "");
      };

      try {
        for await (const seg of sub) {
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
        if (dropped) {
          log.info(`stopped recovering ${cameraId} ch${this.channel}: ${dropped}`);
          continue;
        }
        log.info(`stream for ${cameraId} ended; restarting`);
      } catch (err) {
        if (signal.aborted) return;
        if (dropped) {
          log.info(`stopped recovering ${cameraId} ch${this.channel}: ${dropped}`);
          continue;
        }
        if (err instanceof ProtectCodecChangeError) {
          log.info(`codec changed on ${cameraId}; restarting stream`);
          continue;
        }
        const retry = this.#opts.unavailableRetryMs ?? UNAVAILABLE_RETRY_MS;
        const wait = err instanceof ProtectLivestreamUnavailableError ? retry[Math.min(unavailable++, retry.length - 1)] : 3_000;
        log.warn(`livestream ${cameraId} ch${this.channel}: ${errorText(err)}; trying again in ${Math.round(wait / 1000)} s`);
        this.#setStatus("reconnecting", "Reconnecting…");
        await this.#sleep(wait, signal);
      } finally {
        clearInterval(monitor);
        try { await sub[Symbol.asyncDispose](); } catch { /* already closed */ }
      }
    }
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
