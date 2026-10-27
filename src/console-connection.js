import { EventEmitter } from "node:events";
import { ProtectAuthError, ProtectAuthorizationError, ProtectClient } from "unifi-protect";
import { errorText, sleep } from "./util.js";

// A refused login isn't always a wrong password. The library reports every non-2xx login answer as
// ProtectAuthError, including the 502/503 UniFi OS gives while it boots, and after a power cut the PC
// can be up first. So a refused login is retried too, slowly enough that a real wrong password stays
// far from any lockout: about 6 tries in the first 20 minutes, then one every 10 minutes.
const AUTH_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const authRetryMs = (failures) => AUTH_RETRY_MS[Math.min(failures, AUTH_RETRY_MS.length - 1)];

/*
 * One logged-in session to one UniFi OS console (UDM / UNVR / Cloud Key).
 *
 * Login goes straight to https://<host>/api/auth/login with a LOCAL account - no ui.com, no cloud,
 * no MFA prompt. The unifi-protect library then keeps the session alive on its own: it re-logs in
 * before the token expires, reconnects the realtime channel after a console reboot, and recovers
 * livestreams. This class only adds the initial connect-with-backoff and a simple state for the UI.
 *
 * state: "idle" | "connecting" | "connected" | "reconnecting" | "error" | "authfailed"
 * events: "state" (any change)
 */
export class ConsoleConnection extends EventEmitter {
  #cfg;
  #getPassword;
  #log;
  #connect;
  #authRetryMs;
  #abort = null;
  #client = null;
  #disposables = [];
  #stops = 0;

  state = "idle";
  message = "";

  /** opts.connect and opts.authRetryMs replace ProtectClient.connect and the retry delays (unit tests). */
  constructor(cfg, getPassword, log, { connect = (o) => ProtectClient.connect(o), authRetryMs: retry = authRetryMs } = {}) {
    super();
    this.#cfg = cfg;
    this.#getPassword = getPassword;
    this.#log = log;
    this.#connect = connect;
    this.#authRetryMs = retry;
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
          name: cam.name,
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
   * Protect's saved liveviews (the web UI's camera grids) as { id, name, slots: [cameraId | null] }.
   * A slot can cycle through several cameras in Protect; only its first camera is used here.
   */
  liveviews() {
    if (!this.#client) return [];
    try {
      return this.#client.liveviews.map((lv) => ({
        id: lv.id,
        name: lv.name,
        slots: (lv.slots ?? []).map((s) => s?.cameras?.[0] ?? null),
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
      try {
        const client = await this.#connect({
          host: this.#cfg.host,
          username: this.#cfg.username,
          password: await this.#getPassword(),
          signal,
          log: this.#libLog(),
        });
        if (signal.aborted) {
          await client[Symbol.asyncDispose]().catch(() => {});
          return;
        }
        this.#client = client;
        this.#watch(client);
        this.#log.info(`connected to ${client.controllerName ?? this.#cfg.host}, ${client.cameras.length} cameras`);
        this.#set("connected", "");
        return;
      } catch (err) {
        if (signal.aborted) return;
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
      const [state, message] = map[to] ?? ["connected", ""];
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
    this.emit("state");
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
  const ids = channelList(cam).map((c) => c.id);
  if (!ids.length) return 0;
  const want = Number.isInteger(wanted) ? wanted : 1;
  if (ids.includes(want)) return want;
  // Prefer the next lower-quality channel (higher id), then anything.
  return ids.filter((id) => id > want).sort((a, b) => a - b)[0] ?? ids.sort((a, b) => b - a)[0];
}
