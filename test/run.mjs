#!/usr/bin/env node
// Protect Panes regression tests. Runs the real app (Electron) against fake cameras, drives it with
// real mouse input, then checks playback stats, dewarp state, saved config and screenshots.
//
//   node test/run.mjs mock   - mock consoles (no network): playback, forced reconnect, 360° quad/panorama, PTZ input
//   node test/run.mjs e2e    - fake UniFi OS consoles over HTTPS/WSS through the real unifi-protect library:
//                              login, bad password, unreachable console, offline camera, socket drops,
//                              bogus codec string, fisheye detection from Protect's flags
//   node test/run.mjs all    - both
//
// Camera windows will appear on screen for ~15 s per suite (on Linux without a display, xvfb-run is used).
// Screenshots, result.json and the app log are kept in the printed results folder.
// Runs in its own settings folder, so it doesn't touch your real config and can run while the app is open.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const ELECTRON = require("electron");
const CEILING_TRUTH = { x: 0.513, y: 0.4938, r: 0.4818 }; // where fisheye-ceiling.png's image circle really is

const suite = process.argv[2] || "all";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `protect-panes-${label}-`));
}

function electronCommand() {
  const args = [ROOT];
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  if (process.platform === "linux" && !process.env.DISPLAY) {
    const hasXvfb = spawnSync("which", ["xvfb-run"]).status === 0;
    if (hasXvfb) return { cmd: "xvfb-run", args: ["-a", "-s", "-screen 0 1920x1080x24", ELECTRON, ...args] };
  }
  return { cmd: ELECTRON, args };
}

async function runApp({ userData, results, seconds, extraArgs = [], env = {} }) {
  const { cmd, args } = electronCommand();
  fs.mkdirSync(results, { recursive: true });
  const out = fs.createWriteStream(path.join(results, "app-output.log"));
  const child = spawn(cmd, [...args, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, PANES_USER_DATA: userData, PANES_SELFTEST_DIR: results, PANES_SELFTEST_SEC: String(seconds), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const killer = setTimeout(() => child.kill(), (seconds + 60) * 1000);
  await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(killer);
  const file = path.join(results, "result.json");
  if (!fs.existsSync(file)) throw new Error(`app produced no result.json - see ${path.join(results, "app-output.log")}`);
  return {
    result: JSON.parse(fs.readFileSync(file, "utf8")),
    config: JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8")),
  };
}

const last = (result) => result.samples[result.samples.length - 1]?.cams ?? {};
const near = (a, b, tol) => a && b && Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.r - b.r) < tol;
const fmtCircle = (c) => (c ? `x=${c.x.toFixed(4)} y=${c.y.toFixed(4)} r=${c.r.toFixed(4)}` : "none");

// ---------------------------------------------------------------------------------------------
// Mock suite

async function mockSuite() {
  console.log("\nMock suite (fake cameras, no network)");
  const userData = tmpDir("mock");
  const results = path.join(userData, "results");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = {
    lobby: `${A}/aaaaaaaa-cam0`,
    dock: `${A}/aaaaaaaa-cam1`,
    quad: `${A}/aaaaaaaa-cam360`,
    pano: `${B}/bbbbbbbb-cam360`,
    ramp: `${B}/bbbbbbbb-cam0`,
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 1 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
      [keys.quad]: { open: true, bounds: { x: 500, y: 0, width: 960, height: 540 }, channel: 1 },
      [keys.pano]: {
        open: true, bounds: { x: 500, y: 560, width: 960, height: 540 }, channel: 1,
        dewarp: { mode: "panorama", mount: "ceiling", lensFov: 180, circle: null, views: [0, 90, -90, 180].map((pan) => ({ pan, tilt: -35, fov: 62 })), focus: -1, pano: { pan: 0, tilt: -35 } },
      },
      [keys.ramp]: { open: true, bounds: { x: 0, y: 580, width: 200, height: 113 }, channel: 2 },
    },
    settings: { startHidden: true },
  }, null, 2));

  const actions = [
    { at: 4000, do: "drag", win: 2, from: [240, 135], to: [340, 175] },
    { at: 5500, do: "dblclick", win: 2, pos: [720, 405] },
    { at: 6500, do: "menu", win: 3 },
    { at: 8000, do: "resize", win: 1, size: [200, 113] },
    { at: 8000, do: "resize", win: 4, size: [480, 270] },
    { at: 9000, do: "menu-click", win: 3, label: "Show name" },
  ];
  const { result, config } = await runApp({
    userData, results, seconds: 14, extraArgs: ["--mock"],
    env: { PANES_MOCK_FISHEYE: path.join(FIXTURES, "fisheye-ceiling.png"), PANES_MOCK_RESTART_SEC: "5", PANES_SELFTEST_ACTIONS: JSON.stringify(actions) },
  });
  const cams = last(result);

  for (const [name, key] of Object.entries(keys)) {
    const c = cams[key];
    check(`${name}: live and decoding`, c?.status === "live" && c.decodedFrames >= 30, c && `status=${c.status} frames=${c.decodedFrames}`);
    check(`${name}: near live edge (lag < 1.5 s)`, c && c.lag < 1.5, c && `lag=${c.lag?.toFixed(2)}`);
    check(`${name}: no renderer errors`, c && c.errors.length === 0 && c.resetRequests === 0, c && JSON.stringify(c.errors));
  }
  check("forced reconnect rebuilt the decoder and recovered", cams[keys.lobby]?.rebuilds >= 2, `rebuilds=${cams[keys.lobby]?.rebuilds}`);
  check("360 camera auto-switched to quad view", cams[keys.quad]?.dewarp?.active && cams[keys.quad]?.dewarp?.mode === "quad", JSON.stringify(cams[keys.quad]?.dewarp));
  check("panorama view active", cams[keys.pano]?.dewarp?.active && cams[keys.pano]?.dewarp?.mode === "panorama");
  const qd = config.windows[keys.quad]?.dewarp;
  check("image circle auto-detected within 1%", near(qd?.circle, CEILING_TRUTH, 0.01), `${fmtCircle(qd?.circle)} vs truth ${fmtCircle(CEILING_TRUTH)}`);
  check("default quad directions 0/90/-90/180", JSON.stringify(qd?.views?.slice(1).map((v) => v.pan)) === "[90,-90,180]", JSON.stringify(qd?.views?.map((v) => v.pan)));
  check("drag panned + tilted view 1 and it was saved", qd && qd.views[0].pan < -15 && qd.views[0].tilt > -30, qd && JSON.stringify(qd.views[0]));
  check("double-click enlarged view 4 and it was saved", qd?.focus === 3, `focus=${qd?.focus}`);
  const menu = result.actions.find((a) => a.act.do === "menu");
  check("context menu builds with 360° submenu", !!menu?.menu?.some((i) => typeof i === "object" && i["360° view"]), menu?.error);
  const resizedAt = result.actions.find((a) => a.act.do === "resize")?.t ?? 0;
  const before = result.samples.filter((s) => s.t < resizedAt).at(-1)?.cams ?? {};
  const label = (c) => c && JSON.stringify(c.label);
  check("small window shows only the status dot", before[keys.ramp]?.label?.compact === true, label(before[keys.ramp]));
  check("normal-size window shows the full name label", cams[keys.lobby]?.label?.compact === false, label(cams[keys.lobby]));
  check("shrinking a window collapses its label to the dot", before[keys.dock]?.label?.compact === false && cams[keys.dock]?.label?.compact === true, `${label(before[keys.dock])} -> ${label(cams[keys.dock])}`);
  check("enlarging a window brings the full label back", cams[keys.ramp]?.label?.compact === false, label(cams[keys.ramp]));
  const hideClick = result.actions.find((a) => a.act.do === "menu-click");
  check("context menu has a checked Show name item", !!menu?.menu?.includes("[x] Show name"), JSON.stringify(menu?.menu));
  check("Show name in the menu hides that window's label and saves it", hideClick?.ok && cams[keys.pano]?.label?.shown === false && config.windows[keys.pano]?.hideName === true, hideClick?.error ?? `${label(cams[keys.pano])} hideName=${config.windows[keys.pano]?.hideName}`);
  check("other windows keep their labels", [keys.lobby, keys.dock, keys.quad, keys.ramp].every((k) => cams[k]?.label?.shown === true));
  console.log(`  results: ${results}`);
}

// ---------------------------------------------------------------------------------------------
// End-to-end suite against fake consoles

function startConsole(port, mode, prefix, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "test", "fake-console", "server.mjs"), String(port), mode, prefix], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake console ${port} didn't start`)), 10_000);
    child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(timer); resolve(child); } });
    child.on("exit", (code) => reject(new Error(`fake console ${port} exited (${code})`)));
  });
}

async function e2eSuite() {
  console.log("\nEnd-to-end suite (fake UniFi OS consoles, real unifi-protect library)");
  const P = { building: 18443, garage: 18444, bad: 18445 };
  const servers = await Promise.all([
    startConsole(P.building, "ok", "Building", { FAKE_FISHEYE: path.join(FIXTURES, "fisheye-ceiling.png") }),
    startConsole(P.garage, "ok", "Garage"),
    startConsole(P.bad, "badauth", "Nope"),
  ]);
  try {
    const userData = tmpDir("e2e");
    const results = path.join(userData, "results");
    const pw = { enc: "plain", data: Buffer.from("secret").toString("base64") };
    const ids = { B: "11111111-0000-4000-8000-000000000001", G: "22222222-0000-4000-8000-000000000002", X: "33333333-0000-4000-8000-000000000003", D: "44444444-0000-4000-8000-000000000004" };
    const cam = (port, i) => `${port}cam${i}`.padEnd(24, "0");
    const keys = {
      drops: `${ids.B}/${cam(P.building, 0)}`,
      bogusCodec: `${ids.B}/${cam(P.building, 1)}`,
      offline: `${ids.B}/${cam(P.building, 2)}`,
      fisheye: `${ids.B}/${cam(P.building, 3)}`,
      garage: `${ids.G}/${cam(P.garage, 0)}`,
      badLogin: `${ids.X}/whatever00000000000000`,
    };
    const win = (x, y, w, h, channel) => ({ open: true, bounds: { x, y, width: w, height: h }, channel });
    fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
      version: 1,
      consoles: [
        { id: ids.B, name: "Building", host: `127.0.0.1:${P.building}`, username: "viewer", password: pw },
        { id: ids.G, name: "Garage", host: `127.0.0.1:${P.garage}`, username: "viewer", password: pw },
        { id: ids.X, name: "Wrong Password", host: `127.0.0.1:${P.bad}`, username: "viewer", password: { enc: "plain", data: Buffer.from("nope").toString("base64") } },
        { id: ids.D, name: "Unplugged", host: "127.0.0.1:9", username: "viewer", password: pw },
      ],
      windows: {
        [keys.drops]: win(0, 0, 480, 270, 1),
        [keys.bogusCodec]: win(0, 290, 480, 270, 1),
        [keys.offline]: win(0, 580, 480, 270, 1),
        [keys.fisheye]: win(500, 0, 960, 540, 1),
        [keys.garage]: win(500, 560, 600, 338, 0),
        [keys.badLogin]: win(1120, 560, 480, 270, 1),
      },
      settings: { startHidden: false },
    }, null, 2));

    const { result, config } = await runApp({ userData, results, seconds: 16 });
    const cams = last(result);
    const conn = result.connections;
    check("Building console connected", conn[ids.B]?.state === "connected", JSON.stringify(conn[ids.B]));
    check("Garage console connected", conn[ids.G]?.state === "connected", JSON.stringify(conn[ids.G]));
    check("wrong password reported as login failure", conn[ids.X]?.state === "authfailed", JSON.stringify(conn[ids.X]));
    check("unreachable console reported and retrying", conn[ids.D]?.state === "error", JSON.stringify(conn[ids.D]));
    for (const name of ["drops", "bogusCodec", "fisheye", "garage"]) {
      const c = cams[keys[name]];
      check(`${name}: live and decoding`, c?.status === "live" && c.decodedFrames >= 30, c && `status=${c.status} frames=${c.decodedFrames}`);
      check(`${name}: near live edge (lag < 1.5 s)`, c && c.lag < 1.5, c && `lag=${c.lag?.toFixed(2)}`);
    }
    check("dropped livestream socket recovered", cams[keys.drops]?.rebuilds >= 2 && cams[keys.drops]?.resetRequests === 0, `rebuilds=${cams[keys.drops]?.rebuilds}`);
    check("bogus codec string fell back to codec from init segment", /avc1\./.test(cams[keys.bogusCodec]?.mime ?? "") && !/bogus/i.test(cams[keys.bogusCodec]?.mime ?? ""), cams[keys.bogusCodec]?.mime);
    check("offline camera shows offline", cams[keys.offline]?.status === "offline", cams[keys.offline]?.status);
    check("camera on wrong-password console shows an error", cams[keys.badLogin]?.status === "error", cams[keys.badLogin]?.status);
    check("garage High channel is 1920x1080", cams[keys.garage]?.videoWidth === 1920 && cams[keys.garage]?.videoHeight === 1080);
    const fd = config.windows[keys.fisheye]?.dewarp;
    check("fisheye detected from Protect flags -> quad view, ceiling mount", cams[keys.fisheye]?.dewarp?.active && fd?.mode === "quad" && fd?.mount === "ceiling", JSON.stringify({ mode: fd?.mode, mount: fd?.mount }));
    check("fisheye image circle auto-detected within 1%", near(fd?.circle, CEILING_TRUTH, 0.01), fmtCircle(fd?.circle));
    check("normal cameras don't create a WebGL context", cams[keys.garage]?.dewarp?.gl === false);
    console.log(`  results: ${results}`);
  } finally {
    for (const s of servers) s.kill();
  }
}

// ---------------------------------------------------------------------------------------------

try {
  if (suite === "mock" || suite === "all") await mockSuite();
  if (suite === "e2e" || suite === "all") await e2eSuite();
} catch (err) {
  console.error(`\nTest run failed: ${err.message}`);
  failures++;
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
