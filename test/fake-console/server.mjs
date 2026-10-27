// Fake UniFi OS + Protect console for end-to-end tests. TEST ONLY - never point real users at it.
//
//   node test/fake-console/server.mjs <port> <mode> <namePrefix>
//
// mode "ok":      login works (user "viewer" / "secret"), 4 cameras:
//                   cam0  normal; its livestream socket is dropped every 10 s (forces reconnect + discontinuity)
//                   cam1  normal; sends a bogus codec string (exercises the renderer's codec fallback)
//                   cam2  offline (state DISCONNECTED)
//                   cam3  AI 360 fisheye, ceiling mount, only when FAKE_FISHEYE=<png> is set
// mode "badauth": every login gets 401.
//
// Speaks exactly what the unifi-protect library needs: POST /api/auth/login, GET /proxy/protect/api/bootstrap,
// WSS /proxy/protect/ws/updates, GET /proxy/protect/api/ws/livestream -> WSS livestream framed as
// [type:1][len:3][payload] (248 codec, 250 init, 249 begin, 251 moof, 254 mdat header, 252 video, 255 end),
// and GET /proxy/protect/api/cameras/<id>/snapshot?w=<width> -> a JPEG (logged as "snapshot <id> w=<width>").
// Video comes from ffmpeg (FFMPEG_PATH, the ffmpeg-static dev dependency, or ffmpeg on PATH).
import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8443);
const mode = process.argv[3] || "ok";
const prefix = process.argv[4] || "Fake";
const FISHEYE = process.env.FAKE_FISHEYE || "";
const USER = "viewer";
const PASS = "secret";
const log = (...a) => console.log(`[fake:${port}]`, ...a);

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return createRequire(import.meta.url)("ffmpeg-static") || "ffmpeg"; } catch { return "ffmpeg"; }
}

const SIZES = { 0: [1920, 1080], 1: [1280, 720], 2: [640, 360] };
const SQUARE = { 0: [1920, 1920], 1: [1280, 1280], 2: [640, 640] };

const cameraId = (p, i) => `${p}cam${i}`.padEnd(24, "0");

const cameras = [0, 1, 2, ...(FISHEYE ? [3] : [])].map((i) => {
  const fish = i === 3;
  return {
    id: cameraId(port, i),
    name: fish ? `${prefix} Lobby 360` : `${prefix} Cam ${i + 1}`,
    displayName: fish ? `${prefix} Lobby 360` : `${prefix} Cam ${i + 1}`,
    modelKey: "camera",
    type: fish ? "UVC AI 360" : "UVC G5 Bullet",
    marketName: fish ? "AI 360" : "G5 Bullet",
    state: i === 2 ? "DISCONNECTED" : "CONNECTED",
    isAdopted: true,
    isAdoptedByOther: false,
    isAdopting: false,
    ispSettings: { mountPosition: fish ? "ceiling" : "wall", isFlippedHorizontal: false, isFlippedVertical: false },
    featureFlags: { hasSpeaker: false, hasPackageCamera: false, isDoorbell: false, hasLuxCheck: false, hasFisheye: fish },
    channels: [0, 1, 2].map((ch) => ({
      id: ch, name: ["High", "Medium", "Low"][ch], enabled: true,
      width: (fish ? SQUARE : SIZES)[ch][0], height: (fish ? SQUARE : SIZES)[ch][1],
      fps: 15, bitrate: 2_000_000, isRtspEnabled: false, rtspAlias: "", videoId: `video${ch}`,
    })),
  };
});

const bootstrap = () => ({
  authUserId: "user1",
  accessKey: "x",
  lastUpdateId: "update-1",
  cameras,
  nvr: { id: "nvr1", modelKey: "nvr", name: `${prefix} NVR`, host: "127.0.0.1", version: "7.0.0", marketName: "UNVR", type: "UNVR", upSince: 1, lastSeen: Date.now() },
  users: [{ id: "user1", modelKey: "user", name: USER, permissions: [], role: "viewer" }],
  // A 2x2 liveview: cam1, cam0, an empty slot, then a cycling slot (only its first camera counts).
  liveviews: [{
    id: "liveview1", modelKey: "liveview", name: `${prefix} Entrances`, isDefault: false, isGlobal: true, layout: 4, owner: "user1",
    slots: [[1], [0], [], [2, 0]].map((ids) => ({ cameras: ids.map((i) => cameraId(port, i)), cycleMode: "time", cycleInterval: 10 })),
  }],
  // The library's reducer expects every collection to be present, even if empty.
  fobs: [], viewers: [], chimes: [], lights: [], sensors: [], relays: [], ringtones: [], groups: [], bridges: [],
});

const server = https.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      let creds = {};
      try { creds = JSON.parse(body); } catch { /* ignore */ }
      if (mode === "badauth" || creds.username !== USER || creds.password !== PASS) {
        log("login rejected for", creds.username);
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ code: "AUTHENTICATION_FAILED_INVALID_CREDENTIALS" }));
        return;
      }
      log("login ok");
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "TOKEN=faketoken; path=/; secure; httponly", "x-updated-csrf-token": "csrf-123" })
        .end(JSON.stringify({ username: USER }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "x-csrf-token": "csrf-000", "content-type": "text/html" }).end("<html></html>");
      return;
    }
    if (!(req.headers.cookie || "").includes("TOKEN=faketoken")) { res.writeHead(401).end(); return; }
    if (url.pathname === "/proxy/protect/api/bootstrap") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(bootstrap()));
      return;
    }
    const snap = url.pathname.match(/^\/proxy\/protect\/api\/cameras\/([^/]+)\/snapshot$/);
    if (req.method === "GET" && snap) {
      log("snapshot", snap[1], `w=${url.searchParams.get("w")}`);
      const w = Math.round(Number(url.searchParams.get("w") || 640) / 2) * 2;
      snapshotJpeg(w, Math.round((w * 9) / 16 / 2) * 2).then(
        (jpg) => res.writeHead(200, { "content-type": "image/jpeg" }).end(jpg),
        () => res.writeHead(500).end(),
      );
      return;
    }
    if (url.pathname === "/proxy/protect/api/ws/livestream") {
      log("livestream negotiate", url.searchParams.get("camera"), "channel", url.searchParams.get("channel"));
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ url: `wss://127.0.0.1:${port}/live?camera=${url.searchParams.get("camera")}&channel=${url.searchParams.get("channel")}` }));
      return;
    }
    res.writeHead(404).end();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "https://x");
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/proxy/protect/ws/updates") return; // the library only needs it open
    if (url.pathname === "/live") return streamTo(ws, url.searchParams.get("camera"), Number(url.searchParams.get("channel")));
    ws.close();
  });
});

function snapshotJpeg(w, h) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=1`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

function frame(type, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(4);
  h.writeUInt8(type, 0);
  h.writeUIntBE(payload.length, 1, 3);
  return Buffer.concat([h, payload]);
}

function streamTo(ws, camId, channel) {
  const idx = cameras.findIndex((c) => c.id === camId);
  const fish = idx === 3;
  const [w, h] = (fish ? SQUARE : SIZES)[channel] ?? SIZES[1];
  const video = fish
    ? ["-loop", "1", "-framerate", "15", "-i", FISHEYE]
    : ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=15`];
  const vf = fish ? `scale=${w}:${h}` : `hue=h=${idx * 90 + (port % 7) * 20}`;
  const proc = spawn(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-re",
    ...video,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "30",
    "-c:a", "aac", "-b:a", "32k",
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "100000", "pipe:1",
  ], { stdio: ["ignore", "pipe", "inherit"] });

  let buf = Buffer.alloc(0);
  let init = [];
  let moof = null;
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(0);
      const type = buf.toString("latin1", 4, 8);
      if (size < 8 || buf.length < size) break;
      const box = Buffer.from(buf.subarray(0, size));
      buf = buf.subarray(size);
      if (ws.readyState !== ws.OPEN) return;
      if (type === "ftyp") init.push(box);
      else if (type === "moov") {
        init.push(box);
        const codec = idx === 1 ? "H264-main-bogus" : "avc1.4d401f,mp4a.40.2";
        ws.send(Buffer.concat([frame(248, Buffer.from(codec)), frame(250, Buffer.concat(init))]));
        init = [];
      } else if (type === "moof") moof = box;
      else if (type === "mdat" && moof) {
        // Split the mdat like the controller does: header frame, then payload as "video".
        ws.send(Buffer.concat([frame(249), frame(251, moof), frame(254, box.subarray(0, 8)), frame(252, box.subarray(8)), frame(255)]));
        moof = null;
      }
    }
  });
  ws.on("close", () => proc.kill("SIGKILL"));
  if (idx === 0 && mode === "ok") setTimeout(() => ws.terminate(), 10_000);
}

server.listen(port, "127.0.0.1", () => log(`listening (${mode})`));
