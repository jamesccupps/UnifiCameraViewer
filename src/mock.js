import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

/*
 * Test double for ConsoleConnection, used only with `--mock`. Each fake camera is an ffmpeg test
 * pattern encoded to fragmented MP4 the same way Protect sends it (init segment, then ~100 ms
 * moof+mdat fragments), so the whole window/MSE path can be exercised without a console.
 * Uses FFMPEG_PATH, else the ffmpeg-static dev dependency, else ffmpeg on PATH.
 * Set PANES_MOCK_RESTART_SEC to force a mid-stream reconnect (discontinuity) on the first camera
 * of each console.
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
    this.#cams = names.map((n, i) => new MockCamera(`${cfg.id.slice(0, 8)}-cam${i}`, `${base} ${n}`, i));
    // PANES_MOCK_FISHEYE=<png> adds a 360° ceiling camera that loops that fisheye image.
    if (process.env.PANES_MOCK_FISHEYE && cfg.mockFisheye !== false) {
      this.#cams.push(new MockCamera(`${cfg.id.slice(0, 8)}-cam360`, `${base} 360`, names.length, { image: process.env.PANES_MOCK_FISHEYE, mount: process.env.PANES_MOCK_FISHEYE_MOUNT || "ceiling" }));
    }
  }

  get id() { return this.#cfg.id; }
  get name() { return this.#cfg.name || this.#cfg.host; }
  get host() { return this.#cfg.host; }
  get controllerName() { return `${this.name} (mock)`; }

  start() {
    this.#set("connecting", "Connecting…");
    setTimeout(() => this.#set("connected", ""), 400);
  }
  async stop() { this.#set("idle", ""); }
  async restart(cfg) { if (cfg) this.#cfg = cfg; await this.stop(); this.start(); }

  camera(id) { return this.state === "connected" ? this.#cams.find((c) => c.id === id) : undefined; }
  cameras() {
    if (this.state !== "connected") return [];
    return this.#cams.map((c) => ({ id: c.id, name: c.name, online: true, model: c.image ? "Mock AI 360" : "Mock G5", channels: c.channelList, fisheye: !!c.image }));
  }

  #set(state, message) { this.state = state; this.message = message; this.emit("state"); }
}

const SQUARE = { 0: [1920, 1920], 1: [1280, 1280], 2: [640, 640] };

class MockCamera {
  constructor(id, name, index, { image = null, mount = "ceiling" } = {}) {
    this.id = id;
    this.name = name;
    this.index = index;
    this.image = image;
    // A camera named "... Shadows" sends what several real UniFi cameras do: full-range luma (here
    // Y=0 left, Y=24 right) with no range flag in the SPS. Tests check it isn't crushed to black.
    this.shadows = /\bShadows\b/.test(name);
    this.isOnline = true;
    const sizes = image ? SQUARE : SIZES;
    this.config = {
      marketName: image ? "AI 360" : "G5 Bullet",
      featureFlags: { hasFisheye: !!image },
      ispSettings: { mountPosition: mount },
      channels: [0, 1, 2].map((ch) => ({ id: ch, name: ["High", "Medium", "Low"][ch], enabled: true, width: sizes[ch][0], height: sizes[ch][1] })),
    };
    this.channelList = this.config.channels.map((c) => ({ id: c.id, label: `${c.name} · ${c.width}×${c.height}`, width: c.width, height: c.height }));
  }

  livestream({ source, signal }) {
    const restartSec = this.index === 0 ? Number(process.env.PANES_MOCK_RESTART_SEC || 0) : 0;
    return new MockSubscription({ channel: source?.channel ?? 0, hue: this.index * 70, label: this.name, signal, restartSec, image: this.image, shadows: this.shadows });
  }
}

class MockSubscription {
  #queue = [];
  #waiters = [];
  #done = false;
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
        this.#pendingDiscontinuity = true;
        this.#spawn();
      }, opts.restartSec * 1000);
    }
  }

  get codec() { return this.initSegment?.codec ?? ""; }

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
    clearTimeout(this.restartTimer);
    this.#proc?.kill("SIGKILL");
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
    this.#queue = [];
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ value: this.#queue.shift(), done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push({ resolve }));
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
