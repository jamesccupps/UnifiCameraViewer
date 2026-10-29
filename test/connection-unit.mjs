// Unit checks for ConsoleConnection with a fake ProtectClient.connect. test/run.mjs runs this under
// Electron's Node (ELECTRON_RUN_AS_NODE=1), since unifi-protect needs Node >= 22.20. Prints one
// JSON object of results; run.mjs makes the assertions.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ProtectAuthError, ProtectLivestreamUnavailableError } from "unifi-protect";
import { bareLivestream, videoOnlyInit } from "../src/bare-livestream.js";
import { CameraStream } from "../src/camera-stream.js";
import { ConsoleConnection } from "../src/console-connection.js";
import { splitBoxes, trackSamples } from "./fake-console/fmp4.mjs";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const fakeClient = () => ({
  controllerName: "Fake",
  cameras: [],
  connection: { on: () => ({ [Symbol.dispose]() {} }) },
  async [Symbol.asyncDispose]() {},
});
const until = async (fn, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return fn();
};

const out = {};

// UniFi OS answers 502/503 to a login while it boots, which the library reports as ProtectAuthError.
// The console must keep being retried and connect once the login is accepted.
{
  let calls = 0;
  const conn = new ConsoleConnection({ id: "c1", host: "h" }, async () => "pw", quiet, {
    connect: async () => {
      if (++calls <= 2) throw new ProtectAuthError("refused");
      return fakeClient();
    },
    authRetryMs: () => 20,
  });
  const states = [];
  conn.on("state", () => states.push(conn.state));
  conn.start();
  await until(() => conn.state === "connected");
  out.refusedThenAccepted = { calls, states, state: conn.state };
  await conn.stop();
}

// Reconnect clicked twice while the old client is slow to close: the second restart connects, and
// the first one finishing its teardown afterwards must not mark the console idle.
{
  const slowClient = () => ({ ...fakeClient(), async [Symbol.asyncDispose]() { await new Promise((r) => setTimeout(r, 200)); } });
  const conn = new ConsoleConnection({ id: "c2", host: "h" }, async () => "pw", quiet, { connect: async () => slowClient() });
  conn.start();
  await until(() => conn.state === "connected");
  const states = [];
  conn.on("state", () => states.push(conn.state));
  await Promise.all([conn.restart(), conn.restart()]);
  await new Promise((r) => setTimeout(r, 400)); // well past the slow close
  out.overlappingRestarts = { state: conn.state, states };
  await conn.stop();
}

// A saved password that can't be decrypted: say so, once, instead of retrying it as a network error.
{
  let calls = 0;
  const conn = new ConsoleConnection({ id: "c3", host: "h" }, async () => { throw new Error("Error while decrypting the ciphertext"); }, quiet, {
    connect: async () => { calls++; return fakeClient(); },
  });
  conn.start();
  await until(() => conn.state === "authfailed", 1_000);
  await new Promise((r) => setTimeout(r, 200));
  out.undecryptable = { state: conn.state, message: conn.message, calls };
  await conn.stop();
}

// No password saved (a console imported from another PC): say so instead of logging in with none.
{
  let calls = 0;
  const conn = new ConsoleConnection({ id: "c4", host: "h" }, async () => "", quiet, {
    connect: async () => { calls++; return fakeClient(); },
  });
  conn.start();
  await until(() => conn.state === "authfailed", 1_000);
  await new Promise((r) => setTimeout(r, 200));
  out.noPassword = { state: conn.state, message: conn.message, calls };
  await conn.stop();
}

// A "state" listener that throws must not be taken for a failed connect (a leaked client and a
// second login) or kill the connect loop.
{
  let calls = 0;
  const conn = new ConsoleConnection({ id: "c4", host: "h" }, async () => "pw", quiet, { connect: async () => { calls++; return fakeClient(); } });
  conn.on("state", () => { if (conn.state === "connected" || conn.state === "connecting") throw new Error("listener bug"); });
  let threw = false;
  try { conn.start(); } catch { threw = true; }
  await new Promise((r) => setTimeout(r, 300));
  out.throwingListener = { state: conn.state, calls, threw };
  await conn.stop().catch(() => {});
}

// The channel a window will use, from the enabled ones: the wish if it's there, else the next lower
// quality, else anything; Medium when nothing was asked for.
{
  const { pickChannel } = await import("../src/console-connection.js");
  out.pickChannel = [pickChannel([0, 1, 2], undefined), pickChannel([0, 2], undefined), pickChannel([0, 2], 1), pickChannel([0], 2), pickChannel([], 1)];
}

// Odd camera names from a console (null, a number) must not break the camera list.
{
  const cam = (id, name) => ({ id, name, isOnline: true, config: { channels: [{ id: 1, enabled: true }] } });
  const conn = new ConsoleConnection({ id: "c5", host: "h" }, async () => "pw", quiet, {
    connect: async () => ({ ...fakeClient(), cameras: [cam("a", null), cam("b", 42), cam("c", "Lobby")] }),
  });
  conn.start();
  await until(() => conn.state === "connected");
  try { out.oddNames = conn.cameras().map((c) => c.name); } catch (err) { out.oddNames = String(err); }
  await conn.stop();
}

// CameraStream: a stream that never starts is tried later and later; video in between resets that.
// The camera's stream fails to establish 3 times, sends one fragment, then fails for good.
{
  const at = [];
  let n = 0;
  const failing = () => ({ next: async () => { throw new ProtectLivestreamUnavailableError("never started", { attempts: 4, phase: "establish" }); } });
  const sub = () => {
    at.push(performance.now());
    const ok = ++n === 4;
    let sent = false;
    return {
      state: ok ? "live" : "connecting",
      initSegment: { codec: "avc1.4d401f", data: new Uint8Array(8) },
      [Symbol.asyncIterator]: () => (ok
        ? { next: async () => { if (sent) throw new ProtectLivestreamUnavailableError("gone", {}); sent = true; return { value: { type: "media", data: new Uint8Array(8) }, done: false }; } }
        : failing()),
      async [Symbol.asyncDispose]() {},
    };
  };
  const cam = { isOnline: true, config: { channels: [{ id: 1, enabled: true }] }, livestream: sub };
  const stream = new CameraStream({
    getConnection: () => ({ state: "connected", name: "C", camera: () => cam }),
    cameraId: "cam", resolveChannel: () => 1, send: () => {}, log: quiet, unavailableRetryMs: [40, 120, 360],
  });
  stream.start();
  await until(() => at.length >= 6, 3_000);
  stream.stop();
  out.neverStarts = { gaps: at.slice(1).map((t, i) => Math.round(t - at[i])) };
}

// CameraStream paused (a window minimized or hidden) while its subscription still has segments to
// give, as the Access reader does with what it already queued: nothing more goes to the page, and the
// status stays "paused" instead of flipping back to "live".
{
  const sends = [];
  const sub = () => ({
    state: "live",
    initSegment: { codec: "avc1.4d401f", data: new Uint8Array(8) },
    async *[Symbol.asyncIterator]() {
      yield { type: "init", codec: "avc1.4d401f", data: new Uint8Array(8) };
      for (let i = 0; i < 40; i++) { // ignores the abort, like segments already queued
        await new Promise((r) => setTimeout(r, 5));
        yield { type: "media", data: new Uint8Array(8) };
      }
    },
    async [Symbol.asyncDispose]() {},
  });
  const cam = { isOnline: true, config: { channels: [{ id: 1, enabled: true }] }, livestream: sub };
  const stream = new CameraStream({
    getConnection: () => ({ state: "connected", name: "C", camera: () => cam }),
    cameraId: "cam", resolveChannel: () => 1, send: (ch, p) => sends.push({ ch, state: p?.state }), log: quiet,
  });
  stream.start();
  await until(() => sends.some((s) => s.ch === "cam:media"));
  const at = sends.length;
  stream.pause();
  await new Promise((r) => setTimeout(r, 150));
  const after = sends.slice(at);
  out.pausedWithSegmentsLeft = {
    mediaAfter: after.filter((s) => s.ch === "cam:media").length,
    statusesAfter: after.filter((s) => s.ch === "cam:status").map((s) => s.state),
    status: stream.status.state,
  };
  stream.stop();
}

// CameraStream on a subscription that keeps ending without an error (the library's iteration ends
// when its recovery gives up): it waits before subscribing again, like after an error, instead of
// renegotiating back to back. Each fake stream ends after a timer, so a loop that doesn't wait still
// lets this script's own timers run.
{
  let subs = 0;
  const statuses = [];
  const sub = () => {
    subs++;
    return {
      state: "connecting",
      initSegment: null,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), 5)) }),
      async [Symbol.asyncDispose]() {},
    };
  };
  const cam = { isOnline: true, config: { channels: [{ id: 1, enabled: true }] }, livestream: sub };
  const stream = new CameraStream({
    getConnection: () => ({ state: "connected", name: "C", camera: () => cam }),
    cameraId: "cam", resolveChannel: () => 1, send: (ch, p) => { if (ch === "cam:status") statuses.push(p.state); }, log: quiet, restartGapMs: 100,
  });
  stream.start();
  await new Promise((r) => setTimeout(r, 400));
  stream.stop();
  out.endsCleanly = { subs, reconnecting: statuses.includes("reconnecting") };
}

// UniFi Access readers (bare-livestream.js). ffmpeg makes 2 s of real fragmented MP4 with an AAC
// track; it goes into bareLivestream through a fake socket the way each kind of camera sends it.
{
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static");
  const made = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-c:a", "aac", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "100000", "pipe:1",
  ], { maxBuffer: 50e6 });
  const { boxes } = splitBoxes(made.stdout);
  const init = Buffer.concat(boxes.filter((b) => b.type === "ftyp" || b.type === "moov").map((b) => b.data));
  const fragments = [];
  for (let i = 0; i < boxes.length; i++) if (boxes[i].type === "moof" && boxes[i + 1]?.type === "mdat") fragments.push([boxes[i].data, boxes[i + 1].data]);
  const samples = fragments.flatMap(([moof, mdat]) => trackSamples(moof, mdat, 1));
  const frame = (type, payload = Buffer.alloc(0)) => { const h = Buffer.alloc(4); h[0] = type; h.writeUIntBE(payload.length, 1, 3); return Buffer.concat([h, payload]); };
  const decodedFrames = (bytes) => {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-i", "pipe:0", "-map", "0:v:0", "-f", "null", "-"], { input: bytes, maxBuffer: 50e6 });
    return Number([...String(r.stderr).matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1] ?? -1);
  };
  const traks = (data) => (data.toString("latin1").match(/trak/g) ?? []).length;

  // Feeds `messages` (each [atMs, Buffer]) to a stream and collects what it yields until the socket closes.
  const run = async (messages) => {
    const on = {};
    let clock = 0;
    const sock = { addEventListener: (ev, fn) => { on[ev] = fn; }, close() {}, binaryType: "" };
    const sub = bareLivestream({ resolveUrl: async () => "wss://fake", connect: () => sock, fps: 15, now: () => clock });
    await until(() => on.message);
    for (const [at, data] of messages) { clock = at; on.message({ data }); }
    on.close({ code: 1006 });
    const got = [];
    let endedWith = null;
    try { for await (const seg of sub) got.push(seg); } catch (err) { endedWith = err.message; }
    return { got, endedWith, state: sub.state };
  };

  // As the UA G3 Pro sends it: codec, init (AAC declared), one begin, then bare samples, two per
  // message every 133 ms (network bursts at 15 fps).
  const bare = await run([
    [0, Buffer.concat([frame(248, Buffer.from("avc1.64000d,mp4a.40.2")), frame(250, init), frame(249)])],
    ...Array.from({ length: Math.ceil(samples.length / 2) }, (_, k) => [k * 133.33, Buffer.concat(samples.slice(k * 2, k * 2 + 2).map((s) => frame(252, s)))]),
  ]);
  const v = videoOnlyInit(init);
  const media = bare.got.filter((s) => s.type === "media").map((s) => s.data);
  // Each fragment: tfdt (version 1: flags, then a 64-bit time) and the one trun sample's duration
  // (after flags, sample_count and data_offset).
  const timing = media.map((m) => {
    const tfdt = m.indexOf("tfdt");
    const trun = m.indexOf("trun");
    return { dts: Number(m.readBigUInt64BE(tfdt + 8)), duration: m.readUInt32BE(trun + 16) };
  });
  const nominal = v.timescale / 15;
  const last = timing.at(-1);
  const lastArrivalMs = (Math.ceil(samples.length / 2) - 1) * 133.33;
  out.bareReader = {
    initCodec: bare.got[0]?.codec,
    initTraks: bare.got[0] && traks(Buffer.from(bare.got[0].data)),
    rawTraks: traks(init),
    samples: samples.length,
    media: media.length,
    decoded: decodedFrames(Buffer.concat([bare.got[0].data, ...media])),
    contiguous: timing.every((t, i) => i === 0 || t.dts === timing[i - 1].dts + timing[i - 1].duration),
    durationsInRange: timing.every((t) => t.duration >= nominal / 2 && t.duration <= nominal * 2),
    // How far the last frame's time is from when it arrived, in frames.
    driftFrames: last && Math.abs((last.dts / v.timescale) * 1000 - lastArrivalMs) / (1000 / 15),
    state: bare.state,
    endedWith: bare.endedWith,
  };

  // The usual framing (begin, video, moof, mdat header, end): segments as the library makes them,
  // with the init left alone.
  const framed = await run(fragments.map(([moof, mdat], k) => [k * 100, Buffer.concat([
    ...(k === 0 ? [frame(248, Buffer.from("avc1.64000d,mp4a.40.2")), frame(250, init)] : []),
    frame(249), frame(251, moof), frame(254, mdat.subarray(0, 8)), frame(252, mdat.subarray(8)), frame(255)])]));
  out.framedReader = {
    initCodec: framed.got[0]?.codec,
    initSame: !!framed.got[0] && Buffer.compare(Buffer.from(framed.got[0].data), init) === 0,
    fragments: fragments.length,
    media: framed.got.filter((s) => s.type === "media").length,
    sameBytes: framed.got.filter((s) => s.type === "media").every((s, k) => Buffer.compare(Buffer.from(s.data), Buffer.concat(fragments[k])) === 0),
  };

  // Disposed (as CameraStream does on stop or pause) with segments still queued: the iteration ends
  // there, quietly. It used to hand over everything queued first.
  {
    const on = {};
    const sock = { addEventListener: (ev, fn) => { on[ev] = fn; }, close() {}, binaryType: "" };
    const sub = bareLivestream({ resolveUrl: async () => "wss://fake", connect: () => sock, fps: 15, now: () => 0 });
    await until(() => on.message);
    on.message({ data: Buffer.concat([frame(248, Buffer.from("avc1.64000d,mp4a.40.2")), frame(250, init), frame(249), ...samples.slice(0, 20).map((s) => frame(252, s))]) });
    const it = sub[Symbol.asyncIterator]();
    const first = await it.next();
    await sub[Symbol.asyncDispose]();
    let after = 0;
    let endedWith = null;
    try { while (!(await it.next()).done) after++; } catch (err) { endedWith = err.message; }
    out.disposedWithQueue = { first: first.value?.type, after, endedWith };
  }
}

console.log(JSON.stringify(out));
