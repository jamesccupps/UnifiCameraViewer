import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

/*
 * Test double for ConsoleConnection, used only with `--mock`. Each fake camera is an ffmpeg test
 * pattern encoded to fragmented MP4 the same way Protect sends it (init segment, then ~100 ms
 * moof+mdat fragments), so the whole window/MSE path can be exercised without a console.
 * Uses FFMPEG_PATH, else the ffmpeg-static dev dependency, else ffmpeg on PATH.
 * Set PANES_MOCK_RESTART_SEC to force a mid-stream reconnect (discontinuity) on the first camera
 * of each console. cfg.mockOffline lists camera names (without the console prefix) that are offline.
 * cfg.mockConnectMs delays "connected" (default 400 ms), like a console that's slow to log in.
 * cfg.mockDropout { camera, offMs, onMs } takes that camera (by name, without the console prefix)
 * offline offMs after connecting and back at onMs. Its streams stall the way the library's do: they
 * park in "recovering" without ending, and pick up again (with a discontinuity) once it's back.
 * Each camera counts its subscriptions, for the self-test result.
 */

export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return createRequire(import.meta.url)("ffmpeg-static") || "ffmpeg"; } catch { return "ffmpeg"; }
}

const SIZES = { 0: [1920, 1080], 1: [1280, 720], 2: [640, 360] };

export class MockConnection extends EventEmitter {
  #cfg;
  #cams;
  state = "idle";
  message = "";

  constructor(cfg) {
    super();
    this.#cfg = cfg;
    const base = cfg.name || "Mock";
    const names = cfg.mockCameras ?? ["Lobby", "Loading Dock", "Stair B", "Parking"];
    this.#cams = names.map((n, i) => new MockCamera(`${cfg.id.slice(0, 8)}-cam${i}`, `${base} ${n}`, i, { online: !(cfg.mockOffline ?? []).includes(n) }));
    // PANES_MOCK_FISHEYE=<png> adds a 360° ceiling camera that loops that fisheye image.
    if (process.env.PANES_MOCK_FISHEYE && cfg.mockFisheye !== false) {
      this.#cams.push(new MockCamera(`${cfg.id.slice(0, 8)}-cam360`, `${base} 360`, names.length, { image: process.env.PANES_MOCK_FISHEYE, mount: process.env.PANES_MOCK_FISHEYE_MOUNT || "ceiling" }));
    }
  }

  get id() { return this.#cfg.id; }
  get name() { return this.#cfg.name || this.#cfg.host; }
  get host() { return this.#cfg.host; }
  get controllerName() { return `${this.name} (mock)`; }
  /** Snapshot requests that reached the "console", for the self-test result. */
  get snapshotCount() { return this.#cams.reduce((n, c) => n + c.snapshots, 0); }
  get subscriptionCounts() { return Object.fromEntries(this.#cams.map((c) => [c.id, c.subscriptions])); }

  start() {
    this.#set("connecting", "Connecting…");
    const connectMs = this.#cfg.mockConnectMs ?? 400;
    setTimeout(() => this.#set("connected", ""), connectMs);
    const drop = this.#cfg.mockDropout;
    const cam = drop && this.#cams.find((c) => c.name === `${this.#cfg.name || "Mock"} ${drop.camera}`);
    if (cam) {
      setTimeout(() => cam.setOnline(false), connectMs + drop.offMs);
      if (drop.onMs) setTimeout(() => cam.setOnline(true), connectMs + drop.onMs);
    }
  }
  async stop() { this.#set("idle", ""); }
  async restart(cfg) { if (cfg) this.#cfg = cfg; await this.stop(); this.start(); }

  camera(id) { return this.state === "connected" ? this.#cams.find((c) => c.id === id) : undefined; }
  cameras() {
    if (this.state !== "connected") return [];
    return this.#cams.map((c) => ({ id: c.id, name: c.name, online: c.isOnline, model: c.image ? "Mock AI 360" : "Mock G5", channels: c.channelList, fisheye: !!c.image }));
  }

  /** cfg.mockLiveviews: [{ id, name, slots: [camera index | null] }]. */
  liveviews() {
    if (this.state !== "connected") return [];
    return (this.#cfg.mockLiveviews ?? []).map((lv) => ({
      id: lv.id,
      name: lv.name,
      slots: lv.slots.map((i) => (i === null ? null : this.#cams[i]?.id ?? null)),
    }));
  }

  #set(state, message) { this.state = state; this.message = message; this.emit("state"); }
}

const SQUARE = { 0: [1920, 1920], 1: [1280, 1280], 2: [640, 640] };

class MockCamera {
  constructor(id, name, index, { image = null, mount = "ceiling", online = true } = {}) {
    this.id = id;
    this.name = name;
    this.index = index;
    this.image = image;
    // A camera named "... Shadows" sends what several real UniFi cameras do: full-range luma (here
    // Y=0 left, Y=24 right) with no range flag in the SPS. Tests check it isn't crushed to black.
    this.shadows = /\bShadows\b/.test(name);
    // "... Broken" sends a valid init, then fragments no decoder accepts (each first NAL length is
    // corrupt), like a stream the GPU's decoder takes on and then rejects every time.
    this.broken = /\bBroken\b/.test(name);
    // "... Rewind" restarts its encoder 12 s in WITHOUT flagging the discontinuity, so its new
    // fragments (timestamps from zero) land behind the playhead: appends succeed, the picture freezes
    // until the new timeline reaches the old one (another 12 s), unless something restarts it.
    this.rewind = /\bRewind\b/.test(name);
    this.isOnline = online;
    this.snapshots = 0;
    this.subscriptions = 0;
    this.live = new Set();
    const sizes = image ? SQUARE : SIZES;
    this.config = {
      marketName: image ? "AI 360" : "G5 Bullet",
      featureFlags: { hasFisheye: !!image },
      ispSettings: { mountPosition: mount },
      channels: [0, 1, 2].map((ch) => ({ id: ch, name: ["High", "Medium", "Low"][ch], enabled: true, width: sizes[ch][0], height: sizes[ch][1] })),
    };
    this.channelList = this.config.channels.map((c) => ({ id: c.id, label: `${c.name} · ${c.width}×${c.height}`, width: c.width, height: c.height }));
  }

  /** One JPEG of the camera's picture, like Protect's /snapshot endpoint (Camera.snapshot in the library). */
  snapshot({ width = 640, signal } = {}) {
    this.snapshots++;
    const w = Math.round(width / 2) * 2;
    const h = this.image ? w : Math.round((w * 9) / 16 / 2) * 2;
    const input = this.image
      ? ["-i", this.image, "-vf", `scale=${w}:${h}`]
      : ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=1`, "-vf", `hue=h=${this.index * 70}`];
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", ...input, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
      const chunks = [];
      proc.stdout.on("data", (c) => chunks.push(c));
      proc.on("error", (err) => reject(new Error(`mock camera needs ffmpeg: ${err.message}`)));
      proc.on("exit", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited with ${code}`))));
      signal?.addEventListener("abort", () => proc.kill("SIGKILL"), { once: true });
    });
  }

  setOnline(on) {
    this.isOnline = on;
    for (const sub of this.live) on ? sub.recover() : sub.stall();
  }

  livestream({ source, signal }) {
    // Once per camera: a later subscription (quality change, Show cameras) must not be cut off again.
    let restartSec = this.index === 0 && !this.restartUsed ? Number(process.env.PANES_MOCK_RESTART_SEC || 0) : 0;
    if (this.rewind && !this.restartUsed) restartSec = 12;
    if (restartSec) this.restartUsed = true;
    this.subscriptions++;
    const sub = new MockSubscription({
      channel: source?.channel ?? 0, hue: this.index * 70, label: this.name, signal, restartSec, flagRestart: !this.rewind,
      image: this.image, shadows: this.shadows, broken: this.broken,
      onDone: () => this.live.delete(sub),
    });
    this.live.add(sub);
    if (!this.isOnline) sub.stall();
    return sub;
  }
}

class MockSubscription {
  #queue = [];
  #waiters = [];
  #done = false;
  #error = null;
  #proc = null;
  #signal;
  #opts;
  #pendingDiscontinuity = false;
  initSegment = null;
  state = "connecting";

  constructor(opts) {
    this.#opts = opts;
    this.#signal = opts.signal;
    this.#signal?.addEventListener("abort", () => this.#finish(), { once: true });
    this.#spawn();
    if (opts.restartSec > 0) {
      this.restartTimer = setTimeout(() => {
        // Simulate the library's reconnect: new encoder, timestamps restart at zero.
        this.#proc?.kill("SIGKILL");
        this.#pendingDiscontinuity = opts.flagRestart !== false;
        this.#spawn();
      }, opts.restartSec * 1000);
    }
  }

  get codec() { return this.initSegment?.codec ?? ""; }

  /** Camera unreachable: no more video, but the subscription parks in "recovering" instead of ending. */
  stall() {
    if (this.#done) return;
    const proc = this.#proc;
    this.#proc = null; // so its exit doesn't end the subscription
    proc?.kill("SIGKILL");
    this.state = "recovering";
  }

  /** Camera back: like the library's recovery, a new encoder whose timestamps restart at zero. */
  recover() {
    if (this.#done || this.#proc) return;
    this.#pendingDiscontinuity = true;
    this.#spawn();
  }

  #spawn() {
    const image = this.#opts.image;
    const [w, h] = (image ? SQUARE : SIZES)[this.#opts.channel] ?? SIZES[1];
    let input;
    if (image) input = ["-loop", "1", "-framerate", "15", "-i", image, "-vf", `scale=${w}:${h},drawbox=x=mod(t*80\\,${w}):y=${Math.round(h * 0.5)}:w=24:h=24:color=red:t=fill`];
    else if (this.#opts.shadows) input = ["-f", "lavfi", "-i", `color=c=black:size=${w}x${h}:rate=15`, "-vf", "format=yuv420p,geq=lum='if(lt(X,W/2),0,24)':cb=128:cr=128"];
    else input = ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=15`, "-vf", `hue=h=${this.#opts.hue}`];
    const args = [
      "-hide_banner", "-loglevel", "error", "-re",
      ...input,
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-g", "30", "-an",
      "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "100000",
      "pipe:1",
    ];
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "inherit"] });
    this.#proc = proc;
    let buf = Buffer.alloc(0);
    let initParts = [];
    let moof = null;
    let haveInit = false;
    proc.stdout.on("data", (chunk) => {
      if (proc !== this.#proc) return;
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const size = buf.readUInt32BE(0);
        const type = buf.toString("latin1", 4, 8);
        if (size < 8 || buf.length < size) break;
        const box = buf.subarray(0, size);
        buf = buf.subarray(size);
        if (type === "ftyp" || type === "moov") {
          initParts.push(Buffer.from(box));
          if (type === "moov") {
            const data = Buffer.concat(initParts);
            initParts = [];
            haveInit = true;
            const first = !this.initSegment;
            this.initSegment = { codec: avcCodec(data), data };
            if (first) this.#push({ type: "init", data, codec: this.initSegment.codec });
          }
        } else if (type === "moof") {
          moof = Buffer.from(box);
        } else if (type === "mdat" && moof && haveInit) {
          const seg = { type: "media", data: Buffer.concat([moof, box]) };
          if (this.#opts.broken) seg.data.writeUInt32BE(0x7fffffff, moof.length + 8);
          if (this.#pendingDiscontinuity) { seg.discontinuity = true; this.#pendingDiscontinuity = false; }
          moof = null;
          this.state = "live";
          this.#push(seg);
        }
      }
    });
    proc.on("exit", () => {
      if (proc === this.#proc && !this.#done) this.#finish();
    });
    // No ffmpeg (a packaged build, or none on PATH): fail this subscription like a dropped stream,
    // so CameraStream backs off and retries, instead of an uncaught error in the main process.
    proc.on("error", (err) => {
      if (proc !== this.#proc || this.#done) return;
      this.#error = new Error(`mock camera needs ffmpeg: ${err.message}`);
      this.#finish();
    });
  }

  #push(item) {
    const w = this.#waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.#queue.push(item);
  }

  #finish() {
    if (this.#done) return;
    this.#done = true;
    this.state = "closed";
    this.#opts.onDone?.();
    clearTimeout(this.restartTimer);
    this.#proc?.kill("SIGKILL");
    for (const w of this.#waiters.splice(0)) {
      if (this.#error) w.reject(this.#error);
      else w.resolve({ value: undefined, done: true });
    }
    this.#queue = [];
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ value: this.#queue.shift(), done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: async () => { this.#finish(); return { value: undefined, done: true }; },
    };
  }

  async [Symbol.asyncDispose]() { this.#finish(); }
}

function avcCodec(init) {
  const i = init.indexOf("avcC", 0, "latin1");
  if (i < 0) return "avc1.4d401f";
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(init[i + 5])}${hex(init[i + 6])}${hex(init[i + 7])}`;
}
