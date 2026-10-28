import { EventEmitter } from "node:events";
import { ProtectAuthError, ProtectAuthorizationError, ProtectClient } from "unifi-protect";
import { bareLivestream, livestreamParams } from "./bare-livestream.js";
import { errorText, sleep } from "./util.js";

// A refused login isn't always a wrong password. The library reports every non-2xx login answer as
// ProtectAuthError, including the 502/503 UniFi OS gives while it boots, and after a power cut the PC
// can be up first. So a refused login is retried too, slowly enough that a real wrong password stays
// far from any lockout: about 6 tries in the first 20 minutes, then one every 10 minutes.
const AUTH_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const authRetryMs = (failures) => AUTH_RETRY_MS[Math.min(failures, AUTH_RETRY_MS.length - 1)];

const CERT_CHANGED = "This console presented a different security certificate than before, so nothing was sent to it. "
  + "If it was reset or updated, that's expected: trust the new certificate. If not, something else may be answering at its address.";

/*
 * One logged-in session to one UniFi OS console (UDM / UNVR / Cloud Key).
 *
 * Login goes straight to https://<host>/api/auth/login with a LOCAL account - no ui.com, no cloud,
 * no MFA prompt. The unifi-protect library then keeps the session alive on its own: it re-logs in
 * before the token expires, reconnects the realtime channel after a console reboot, and recovers
 * livestreams. This class only adds the initial connect-with-backoff and a simple state for the UI.
 *
 * state: "idle" | "connecting" | "connected" | "reconnecting" | "error" | "authfailed" | "certchanged"
 * events: "state" (any change)
 */
export class ConsoleConnection extends EventEmitter {
  #cfg;
  #getPassword;
  #log;
  #connect;
  #authRetryMs;
  #certChanged;
  #abort = null;
  #client = null;
  #disposables = [];
  #stops = 0;

  state = "idle";
  message = "";

  /**
   * opts.certChanged() says the console presented a different TLS certificate than the trusted one
   * (cert-pins.js). opts.connect and opts.authRetryMs replace ProtectClient.connect and the retry
   * delays (unit tests).
   */
  constructor(cfg, getPassword, log, { connect = (o) => ProtectClient.connect(o), authRetryMs: retry = authRetryMs, certChanged = () => false } = {}) {
    super();
    this.#cfg = cfg;
    this.#getPassword = getPassword;
    this.#log = log;
    this.#connect = connect;
    this.#authRetryMs = retry;
    this.#certChanged = certChanged;
  }

  get id() { return this.#cfg.id; }
  get name() { return this.#cfg.name || this.#cfg.host; }
  get host() { return this.#cfg.host; }
  get controllerName() { return this.#client?.controllerName ?? null; }

  start() {
    if (this.#abort) return;
    this.#abort = new AbortController();
    this.#run(this.#abort.signal);
  }

  async stop() {
    const stop = ++this.#stops;
    this.#abort?.abort();
    this.#abort = null;
    await this.#teardown();
    // Two restarts in a row (Reconnect clicked twice, a slow client close): the newer one may have
    // connected while this teardown ran, and must not be marked idle under a live client.
    if (stop === this.#stops && !this.#abort) this.#set("idle", "");
  }

  async restart(cfg) {
    if (cfg) this.#cfg = cfg;
    await this.stop();
    this.start();
  }

  /** Live camera projection from the library, or undefined. */
  camera(id) {
    try { return this.#client?.camera(id); } catch { return undefined; }
  }

  /**
   * A livestream for a camera the library can't stream (bare-livestream.js): the socket URL is
   * negotiated the way the library does it, through its logged-in transport.
   */
  bareLivestream(cam, channel, signal) {
    const client = this.#client;
    const host = this.#cfg.host;
    const fps = cam.config.channels?.find((c) => c.id === channel)?.fps;
    return bareLivestream({
      fps: fps > 0 ? fps : 30,
      signal,
      log: this.#log,
      resolveUrl: async (sig) => {
        if (!client) throw new Error("not connected");
        const res = await client.transport.send(`https://${host}/proxy/protect/api/ws/livestream?${livestreamParams(cam.id, channel)}`, sig ? { signal: sig } : {});
        res.ensureOk();
        const body = res.json();
        if (typeof body?.url !== "string") throw new Error("the livestream endpoint sent no socket URL");
        const url = new URL(body.url);
        url.hostname = new URL(`https://${host}`).hostname; // like the library: the console's address, not the one it reports
        return url.toString();
      },
    });
  }

  /** Plain camera list for the UI. */
  cameras() {
    if (!this.#client) return [];
    const out = [];
    for (const cam of this.#client.cameras) {
      try {
        const cfg = cam.config;
        if (cfg.isAdopted === false) continue;
        out.push({
          id: cam.id,
          // Text whatever the console sends: one null or numeric name made the sort below throw,
          // and with it every camera list render and Apply to all.
          name: String(cam.name ?? "Camera"),
          online: cam.isOnline,
          model: cfg.marketName || cfg.type || "",
          channels: channelList(cam),
          fisheye: fisheyeInfo(cam).fisheye,
        });
      } catch { /* camera vanished mid-read */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  /**
   * Protect's saved liveviews (the web UI's camera grids) as
   * { id, name, slots: [{ cameras: [cameraId], seconds }] }. A slot with several cameras cycles
   * through them every `seconds` (Protect's cycleInterval). cycleMode isn't read: the library
   * doesn't say what values it takes, so every cycling slot cycles on time.
   */
  liveviews() {
    if (!this.#client) return [];
    try {
      return this.#client.liveviews.map((lv) => ({
        id: lv.id,
        name: String(lv.name ?? "Liveview"),
        slots: (lv.slots ?? []).map((s) => ({
          cameras: [...new Set((Array.isArray(s?.cameras) ? s.cameras : []).filter((id) => typeof id === "string" && id))],
          seconds: Number(s?.cycleInterval) || null,
        })),
      }));
    } catch {
      return [];
    }
  }

  async #run(signal) {
    let delay = 5_000;
    let authFailures = 0;
    while (!signal.aborted) {
      this.#set("connecting", `Connecting to ${this.#cfg.host}…`);
      // A saved password that can't be decrypted (Windows profile moved, "Local State" reset) won't
      // fix itself, and it isn't a network problem: it was shown as "Can't reach console" and retried
      // every minute.
      let password;
      try {
        password = await this.#getPassword();
      } catch (err) {
        this.#log.warn(`the saved password can't be decrypted: ${errorText(err)}`);
        this.#set("authfailed", "The saved password can't be read on this PC any more. Enter it again (⋯ → Edit console…).");
        return;
      }
      try {
        const client = await this.#connect({
          host: this.#cfg.host,
          username: this.#cfg.username,
          password,
          signal,
          log: this.#libLog(),
        });
        if (signal.aborted) {
          await client[Symbol.asyncDispose]().catch(() => {});
          return;
        }
        this.#client = client;
        this.#watch(client);
        // What the camera list shows. client.cameras also has every camera the console can see on the
        // network, adopted by another console included: 29 on a console with 14.
        const cams = this.cameras();
        this.#log.info(`connected to ${client.controllerName ?? this.#cfg.host}, ${cams.length} cameras (${cams.filter((c) => c.online).length} online)`);
        this.#set("connected", "");
        return;
      } catch (err) {
        if (signal.aborted) return;
        if (this.#certChanged()) { // nothing was sent: stop until the owner trusts the new certificate
          this.#set("certchanged", CERT_CHANGED);
          return;
        }
        if (err instanceof ProtectAuthError || err instanceof ProtectAuthorizationError) {
          const wait = this.#authRetryMs(authFailures++);
          const again = `Trying again in ${wait < 60_000 ? `${Math.round(wait / 1000)} s` : `${Math.round(wait / 60_000)} min`}.`;
          this.#log.warn(`login rejected: ${errorText(err)}; ${again.toLowerCase()}`);
          this.#set("authfailed", err instanceof ProtectAuthError
            ? `Login rejected. Use a local-only account (not a UI.com account) and check the password. ${again}`
            : `Logged in, but this account has no access to Protect. ${again}`);
          await sleep(wait, signal);
          continue;
        }
        this.#log.warn(`connect failed: ${errorText(err)}`);
        this.#set("error", `${errorText(err)} - retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  #watch(client) {
    const map = {
      healthy: ["connected", ""],
      degraded: ["connected", "Connection degraded"],
      throttled: ["connected", "Console is rate-limiting requests"],
      lost: ["reconnecting", "Console unreachable - reconnecting…"],
      reconnecting: ["reconnecting", "Reconnecting to console…"],
    };
    this.#disposables.push(client.connection.on("stateChanged", ({ to, reason }) => {
      // A certificate that changes mid-session: the library keeps trying, and each try is refused.
      const [state, message] = to !== "healthy" && this.#certChanged() ? ["certchanged", CERT_CHANGED] : map[to] ?? ["connected", ""];
      this.#log.info(`connection ${to}${reason ? ` (${reason})` : ""}`);
      this.#set(state, message);
    }));
  }

  async #teardown() {
    for (const d of this.#disposables.splice(0)) {
      try { d[Symbol.dispose](); } catch { /* ignore */ }
    }
    const client = this.#client;
    this.#client = null;
    if (client) await client[Symbol.asyncDispose]().catch(() => {});
  }

  #set(state, message) {
    if (this.state === state && this.message === message) return;
    this.state = state;
    this.message = message;
    // A listener that throws mustn't reach #run: inside its try it looked like a failed connect
    // (the live client leaked and a second one logged in), outside it the loop died unhandled.
    try {
      this.emit("state");
    } catch (err) {
      this.#log.error(`a connection state listener failed: ${errorText(err)}`);
    }
  }

  #libLog() {
    const log = this.#log;
    return {
      debug: (m, ...p) => log.debug(m, ...p),
      info: (m, ...p) => log.debug(m, ...p), // the library is chatty at info; keep the file readable
      warn: (m, ...p) => log.warn(m, ...p),
      error: (m, ...p) => log.error(m, ...p),
    };
  }
}

/**
 * Is this a fisheye (360°) camera, and how is it mounted? Protect reports both:
 * featureFlags.hasFisheye and ispSettings.mountPosition (ceiling / wall / desk).
 */
export function fisheyeInfo(cam) {
  let cfg;
  try { cfg = cam?.config; } catch { cfg = null; }
  if (!cfg) return { fisheye: false, mount: "ceiling" };
  const fisheye = !!cfg.featureFlags?.hasFisheye || /\b360\b/.test(`${cfg.marketName ?? ""} ${cfg.type ?? ""}`);
  const pos = String(cfg.ispSettings?.mountPosition ?? "").toLowerCase();
  const mount = pos.includes("wall") ? "wall" : /desk|floor|table/.test(pos) ? "desk" : "ceiling";
  return { fisheye, mount };
}

const CHANNEL_NAMES = ["High", "Medium", "Low"];

/** Enabled quality channels for a camera projection: [{ id, label, width, height }]. */
export function channelList(cam) {
  let channels = [];
  try { channels = cam?.config?.channels ?? []; } catch { return []; }
  return channels
    .filter((c) => c && c.enabled !== false && Number.isInteger(c.id))
    .map((c) => ({
      id: c.id,
      width: c.width,
      height: c.height,
      label: `${CHANNEL_NAMES[c.id] ?? c.name ?? `Channel ${c.id}`}${c.width ? ` · ${c.width}×${c.height}` : ""}`,
    }));
}

/**
 * Pick the channel to stream. Default is Medium (id 1): sharp enough for a monitor wall at a
 * fraction of the decode cost of High. Falls back to the closest available channel.
 */
export function resolveChannel(cam, wanted) {
  return pickChannel(channelList(cam).map((c) => c.id), wanted);
}

/** resolveChannel's choice from a list of enabled channel ids (the camera list has only those). */
export function pickChannel(ids, wanted) {
  ids = [...ids];
  if (!ids.length) return 0;
  const want = Number.isInteger(wanted) ? wanted : 1;
  if (ids.includes(want)) return want;
  // Prefer the next lower-quality channel (higher id), then anything.
  return ids.filter((id) => id > want).sort((a, b) => a - b)[0] ?? ids.sort((a, b) => b - a)[0];
}
