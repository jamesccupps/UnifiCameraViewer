import { Agent, WebSocket } from "undici";

/*
 * Livestreams for cameras adopted by UniFi Access (a UA G3 Pro door reader, for one).
 *
 * Protect's livestream socket carries frames of [type:1][length:3][payload]. For an ordinary camera
 * each ~100 ms fragment is "begin", the sample data as "video"/"audio", the boxes as "moof"/"mdat",
 * then "end", and the library emits a media segment on "end". A UA G3 Pro's socket (seen
 * 2026-10-28) carries the codec, the init segment, one "begin", then only "video" frames: one H.264
 * access unit each, with 4-byte NAL lengths. There's no moof/mdat/end, no timestamps (asking for
 * extendedVideoMetadata changes nothing) and no audio, though the init declares an AAC track. So
 * the library buffers it forever and the window stays black.
 *
 * This reads that socket itself, with the library's request parameters. Without allowPartialGOP
 * and progressive the reader sends nothing after the init segment.
 * - Each access unit becomes its own moof+mdat. The audio track comes out of the init: a player
 *   told about audio waits for it before it plays anything.
 * - There are no timestamps, so each frame lasts the channel's nominal frame time, nudged by a
 *   quarter of the drift from the wall clock. Network bursts then don't come out as jerky motion,
 *   and the timeline still keeps up with the camera.
 * - If one of these cameras does send begin/moof/mdat/end, those segments are put together the way
 *   the library does, with the init left as it is.
 *
 * The result has what CameraStream uses of a library subscription: async iteration of
 * { type: "init", codec, data } and { type: "media", data }, `state`, `initSegment` and
 * Symbol.asyncDispose.
 */

const FRAME = { timestamp: 247, codec: 248, begin: 249, init: 250, moof: 251, video: 252, audio: 253, mdat: 254, end: 255 };
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "edts", "dinf"]);
const BARE_AFTER = 15;       // video frames with no moof/mdat/end before calling a stream bare
const STALL_MS = 10_000;     // no frame for this long: close, and CameraStream starts over
const SYNC = 0x02000000;     // trun sample flags: depends on nothing (a keyframe)
const NON_SYNC = 0x01010000; // depends on others, not a sync sample

// --- MP4 boxes -------------------------------------------------------------------------------

function boxes(buf) {
  const out = [];
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i);
    if (size < 8 || i + size > buf.length) break;
    out.push({ type: buf.toString("latin1", i + 4, i + 8), raw: buf.subarray(i, i + size), body: buf.subarray(i + 8, i + size) });
    i += size;
  }
  return out;
}

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

const fullBox = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };

/** The first box of `type` anywhere under `buf` (through the usual containers), or null. */
function find(buf, type) {
  for (const b of boxes(buf)) {
    if (b.type === type) return b;
    if (CONTAINERS.has(b.type)) {
      const hit = find(b.body, type);
      if (hit) return hit;
    }
  }
  return null;
}

const trackId = (trak) => { const t = find(trak.body, "tkhd").body; return t.readUInt32BE(t[0] === 1 ? 20 : 12); };
const handler = (trak) => find(trak.body, "hdlr")?.body.toString("latin1", 8, 12);
const timescale = (trak) => { const m = find(trak.body, "mdhd").body; return m.readUInt32BE(m[0] === 1 ? 20 : 12); };

/**
 * The init segment with only its video track: { data, trackId, timescale, nalLength, hevc }.
 * Throws if there's no video track.
 */
export function videoOnlyInit(init) {
  const top = boxes(init);
  const moov = top.find((b) => b.type === "moov");
  const inMoov = moov ? boxes(moov.body) : [];
  const video = inMoov.find((b) => b.type === "trak" && handler(b) === "vide");
  if (!video) throw new Error("the init segment has no video track");
  const id = trackId(video);
  const kids = inMoov.flatMap((b) => {
    if (b.type === "trak") return b === video ? [b.raw] : [];
    if (b.type === "mvex") return [box("mvex", ...boxes(b.body).filter((x) => x.type !== "trex" || x.body.readUInt32BE(4) === id).map((x) => x.raw))];
    return [b.raw];
  });
  const config = find(video.body, "avcC") ?? find(video.body, "hvcC");
  const hevc = config?.type === "hvcC";
  // avcC: lengthSizeMinusOne is the low 2 bits of byte 4; hvcC: of byte 21.
  const nalLength = config ? (config.body[hevc ? 21 : 4] & 3) + 1 : 4;
  return {
    data: Buffer.concat([...top.filter((b) => b.type !== "moov").map((b) => b.raw), box("moov", ...kids)]),
    trackId: id,
    timescale: timescale(video),
    nalLength,
    hevc,
  };
}

/** Whether an access unit (NAL units with `nalLength`-byte lengths) holds a keyframe. */
export function isKeyframe(sample, nalLength = 4, hevc = false) {
  for (let i = 0; i + nalLength < sample.length; ) {
    const len = sample.readUIntBE(i, nalLength);
    const head = sample[i + nalLength];
    const type = hevc ? (head >> 1) & 0x3f : head & 0x1f;
    if (hevc ? type >= 16 && type <= 21 : type === 5) return true;
    i += nalLength + len;
  }
  return false;
}

/** One access unit as a moof+mdat for track `trackId`, starting at `decodeTime`. */
export function fragment(seq, id, decodeTime, duration, sample, sync) {
  const build = (offset) => box("moof",
    fullBox("mfhd", 0, 0, u32(seq)),
    box("traf",
      fullBox("tfhd", 0, 0x020000, u32(id)), // default-base-is-moof
      fullBox("tfdt", 1, 0, u64(decodeTime)),
      // data-offset, sample-duration, sample-size and sample-flags present; one sample.
      fullBox("trun", 0, 0x000701, u32(1), u32(offset), u32(duration), u32(sample.length), u32(sync ? SYNC : NON_SYNC))));
  const size = build(0).length;
  return Buffer.concat([build(size + 8), box("mdat", sample)]);
}

// --- The socket ------------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {(signal: AbortSignal) => Promise<string>} opts.resolveUrl - the negotiated wss:// URL
 * @param {number} [opts.fps] - the channel's frame rate (the nominal frame time)
 * @param {AbortSignal} [opts.signal]
 * @param {(url: string) => object} [opts.connect] - a WebSocket (tests pass a fake)
 * @param {() => number} [opts.now] - milliseconds
 * @param {{ debug?: Function, warn?: Function }} [opts.log]
 */
export function bareLivestream({ resolveUrl, fps = 30, signal, connect = null, now = () => performance.now(), log = {} }) {
  const queue = [];
  let wake = null;
  let done = false;
  let failure = null;
  let ws = null;
  let agent = null;
  let stallTimer = null;

  // Ending on purpose (dispose, abort) ends the iteration quietly; anything else ends it with an error.
  const sub = {
    state: "connecting",
    initSegment: null,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (done && !failure) return; // disposed or aborted: what's still queued is for nobody now
        if (queue.length) { yield queue.shift(); continue; }
        if (failure) throw failure;
        if (done) return;
        await new Promise((r) => { wake = r; });
      }
    },
    async [Symbol.asyncDispose]() { finish(); },
  };

  const push = (seg) => {
    queue.push(seg);
    wake?.();
  };
  function finish(err = null) {
    if (done) return;
    done = true;
    failure = err;
    clearTimeout(stallTimer);
    try { ws?.close(); } catch { /* already closed */ }
    agent?.close().catch(() => {});
    wake?.();
  }
  const kick = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => finish(new Error(`no video for ${STALL_MS / 1000} s`)), STALL_MS);
  };

  // Stream state. `mode` stays null until the stream shows which kind it is.
  let codec = "";
  let rawInit = null;
  let video = null; // videoOnlyInit() of rawInit
  let mode = null;  // "framed" | "bare"
  let held = [];    // video frames seen before the mode is known
  let seg = { moof: [], mdat: [], video: [], audio: [] };
  let seq = 1;
  let dts = 0;
  let t0 = null;
  let started = false;

  const emitInit = (data, c) => {
    sub.initSegment = { codec: c, data };
    push({ type: "init", codec: c, data });
  };
  const media = (data) => {
    sub.state = "live";
    push({ type: "media", data });
  };

  function bare(sample, at) {
    if (!started) {
      if (!isKeyframe(sample, video.nalLength, video.hevc)) return; // a decoder has to start on one
      started = true;
      t0 = at;
    }
    const nominal = Math.round(video.timescale / fps);
    const drift = ((at - t0) * video.timescale) / 1000 - dts; // > 0: behind the wall clock
    const duration = Math.round(Math.min(nominal * 2, Math.max(nominal / 2, nominal + drift / 4)));
    media(fragment(seq++, video.trackId, dts, duration, sample, isKeyframe(sample, video.nalLength, video.hevc)));
    dts += duration;
  }

  function decide(next) {
    mode = next;
    if (mode === "bare") {
      emitInit(video.data, codec.split(",")[0].trim());
      for (const f of held) bare(f.sample, f.at);
    } else {
      emitInit(rawInit, codec);
    }
    held = [];
  }

  function onFrame(type, payload, at) {
    switch (type) {
      case FRAME.codec:
        codec = payload.toString();
        break;
      case FRAME.init:
        rawInit = Buffer.from(payload);
        try {
          video = videoOnlyInit(rawInit);
        } catch (err) {
          finish(err);
        }
        // A new init means a new decoder on the page: the timeline starts over at a keyframe.
        mode = null;
        held = [];
        started = false;
        dts = 0;
        break;
      case FRAME.begin:
        seg = { moof: [], mdat: [], video: [], audio: [] };
        break;
      case FRAME.moof:
      case FRAME.mdat:
        if (!mode) decide("framed");
        seg[type === FRAME.moof ? "moof" : "mdat"].push(Buffer.from(payload));
        break;
      case FRAME.end:
        if (!mode) decide("framed");
        if (mode === "framed") media(Buffer.concat([...seg.moof, ...seg.mdat, ...seg.video, ...seg.audio]));
        seg = { moof: [], mdat: [], video: [], audio: [] };
        break;
      case FRAME.video:
        if (!video) break;
        if (mode === "bare") bare(Buffer.from(payload), at);
        else {
          seg.video.push(Buffer.from(payload));
          if (!mode) {
            held.push({ sample: Buffer.from(payload), at });
            if (held.length >= BARE_AFTER) decide("bare");
          }
        }
        break;
      case FRAME.audio:
        if (mode !== "bare") seg.audio.push(Buffer.from(payload));
        break;
      default: // timestamps, which aren't asked for
    }
  }

  let carry = Buffer.alloc(0);
  function onMessage(data) {
    if (typeof data === "string") return;
    kick();
    const at = now();
    const buf = carry.length ? Buffer.concat([carry, Buffer.from(data)]) : Buffer.from(data);
    let o = 0;
    while (buf.length - o >= 4) {
      const len = buf.readUIntBE(o + 1, 3);
      if (buf.length < o + 4 + len) break;
      if (!Object.values(FRAME).includes(buf[o])) {
        log.debug?.(`unknown livestream frame type ${buf[o]}; dropping the rest of this message`);
        o = buf.length;
        break;
      }
      onFrame(buf[o], buf.subarray(o + 4, o + 4 + len), at);
      if (done) return;
      o += 4 + len;
    }
    carry = Buffer.from(buf.subarray(o));
  }

  (async () => {
    try {
      const url = await resolveUrl(signal);
      if (done || signal?.aborted) return finish();
      if (connect) ws = connect(url);
      else {
        // Like the library's sessions: an agent of its own, certificate checks off (the console's
        // certificate is self-signed). cert-pins.js still checks it against the pinned one.
        agent = new Agent({ connect: { rejectUnauthorized: false } });
        ws = new WebSocket(url, { dispatcher: agent });
      }
      ws.binaryType = "arraybuffer";
      ws.addEventListener("message", (e) => onMessage(e.data));
      // Closed by the console, not by us: an error, so CameraStream waits before trying again
      // instead of reconnecting in a tight loop.
      ws.addEventListener("close", (e) => finish(new Error(`the livestream socket closed (${e?.code ?? "no code"})`)));
      ws.addEventListener("error", (e) => finish(new Error(`livestream socket error: ${e?.message ?? e?.error?.message ?? "unknown"}`)));
      kick();
    } catch (err) {
      finish(signal?.aborted ? null : err);
    }
  })();
  signal?.addEventListener("abort", () => finish(), { once: true });

  return sub;
}

/** The library's livestream request, as its sessions send it (transport/livestream-session.js). */
export function livestreamParams(cameraId, channel) {
  return new URLSearchParams({
    allowPartialGOP: "",
    camera: cameraId,
    channel: String(channel),
    chunkSize: "4096",
    fragmentDurationMillis: "100",
    lens: "0",
    progressive: "",
    rebaseTimestampsToZero: "true",
    requestId: `${cameraId}-${channel}`,
    type: "fmp4",
    useWallClock: "false",
  });
}
