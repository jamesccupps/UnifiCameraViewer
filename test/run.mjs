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
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const ELECTRON = require("electron");
const FFMPEG = process.env.FFMPEG_PATH || require("ffmpeg-static") || "ffmpeg";
const CEILING_TRUTH = { x: 0.513, y: 0.4938, r: 0.4818 }; // where fisheye-ceiling.png's image circle really is

const suite = process.argv[2] || "all";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

// Same position, and the same size give or take the one-off 1-2 DIP that setAspectRatio trims when a
// window's video (and so its aspect lock) arrives. A sample from before that compares fine with one
// after. Exact sizes across launches are the bounds suite's job.
function samePlace(a, b) {
  return !!(a && b && a.x === b.x && a.y === b.y && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2);
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
  // The default update location is GitHub; tests stay off the network unless a suite sets one.
  const cfgFile = path.join(userData, "config.json");
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { /* missing or damaged on purpose (config suite) */ }
  if (cfg && cfg.settings?.updateSource === undefined) {
    cfg.settings = { ...cfg.settings, updateSource: "" };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  }
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
  appRuns.push({ userData, results });
  const file = path.join(results, "result.json");
  if (!fs.existsSync(file)) throw new Error(`app produced no result.json - see ${path.join(results, "app-output.log")}`);
  return {
    result: JSON.parse(fs.readFileSync(file, "utf8")),
    config: (() => { try { return JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8")); } catch { return null; } })(),
  };
}

// Every app launch, so a failing suite can print what the app itself logged (CI only shows stdout).
const appRuns = [];
function printAppLogs(runs) {
  for (const { userData, results } of runs) {
    for (const file of [path.join(userData, "protect-panes.log"), path.join(results, "app-output.log")]) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-40);
      console.log(`  --- ${file} (last ${lines.length} lines)\n${lines.map((l) => `  | ${l}`).join("\n")}`);
    }
  }
}

async function runSuite(fn) {
  const failedBefore = failures;
  const firstRun = appRuns.length;
  await fn();
  if (failures > failedBefore) printAppLogs(appRuns.slice(firstRun));
}

const last = (result) => result.samples[result.samples.length - 1]?.cams ?? {};
const near = (a, b, tol) => a && b && Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.r - b.r) < tol;
const fmtCircle = (c) => (c ? `x=${c.x.toFixed(4)} y=${c.y.toFixed(4)} r=${c.r.toFixed(4)}` : "none");

// ---------------------------------------------------------------------------------------------
// Mock suite

async function mockSuite() {
  console.log("\nMock suite (fake cameras, no network)");

  // Without ffmpeg (e.g. --mock in a packaged build) a mock stream must fail like a dropped stream,
  // not throw in the main process (which pops Electron's blocking error dialog).
  {
    const { MockConnection } = await import(new URL("../src/mock.js", import.meta.url).href);
    const saved = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(os.tmpdir(), "no-such-dir", "ffmpeg.exe");
    const conn = new MockConnection({ id: "cccccccc-0000-4000-8000-000000000003", name: "T", host: "mock-t", mockCameras: ["A"] });
    conn.start();
    await new Promise((r) => setTimeout(r, 600));
    const ctrl = new AbortController();
    let outcome = "no error";
    try {
      for await (const seg of conn.camera("cccccccc-cam0").livestream({ source: { channel: 2 }, signal: ctrl.signal })) { outcome = `got ${seg.type}`; break; }
    } catch (err) {
      outcome = err.message;
    }
    ctrl.abort();
    if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved;
    check("mock camera without ffmpeg fails its stream instead of crashing", /needs ffmpeg/.test(outcome), outcome);
  }

  // Start with Windows: the Run key is only written or cleared when it doesn't match the setting.
  // (The app itself skips this in test runs, so these fakes are the only way it's exercised here.)
  {
    const { syncLoginItem } = await import(new URL("../src/util.js", import.meta.url).href);
    const calls = [];
    const run = (wanted, current) => syncLoginItem(wanted, () => ({ openAtLogin: current }), (on) => calls.push(on));
    const results = [run(false, false), run(true, true), run(true, false), run(false, true)];
    check("Start with Windows touches the Run key only when it doesn't match (off/off, on/on: no; off->on, on->off: yes)",
      JSON.stringify(results) === "[false,false,true,true]" && JSON.stringify(calls) === "[true,false]", JSON.stringify({ results, calls }));
  }

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
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 1 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
      [keys.quad]: { open: true, bounds: { x: 500, y: 0, width: 960, height: 540 }, channel: 1, picture: { brightness: 1.3, contrast: 1.1 } },
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
    { at: 9500, do: "menu-click", win: 0, label: "Show time" },
    { at: 9500, do: "menu-click", win: 1, label: "Show time" },
    { at: 10500, do: "menu-click", win: 0, label: "Quality: Medium" },
    { at: 11000, do: "menu-click", win: 0, label: "Show time: on" },
    { at: 11500, do: "menu-click", win: 2, label: "Picture: 130% brightness, 110% contrast" },
    { at: 12000, do: "menu-click", win: 2, label: "4:3" },
    { at: 12500, do: "menu-click", win: 3, label: "Any shape (no lock)" },
  ];
  const { result, config } = await runApp({
    // 20 s: the Apply-to-all quality change at 10.5 s restarts two streams, and a runner without a
    // GPU (software decode of five windows) needs several seconds to bring them back.
    userData, results, seconds: 20, extraArgs: ["--mock"],
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
  const views = menu?.menu?.find((i) => typeof i === "object" && i["360° view"])?.["360° view"] ?? [];
  check("360° view offers Quad, Single view, Panorama and Fisheye (panorama window: Panorama checked)",
    ["Quad view", "Single view", "[x] Panorama", "Fisheye (no dewarp)"].every((l) => views.includes(l)), JSON.stringify(views));
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

  const clockAt = result.actions.find((a) => a.act.label === "Show time")?.t ?? 0;
  const beforeClock = result.samples.filter((s) => s.t < clockAt).at(-1)?.cams ?? {};
  const endT = result.samples.at(-1)?.t ?? 0;
  const clockOk = (c) => {
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(c?.clock?.text ?? "");
    if (!m) return false;
    const t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return c.clock.shown && Math.abs(t - endT) < 5_000;
  };
  const clk = (c) => c && JSON.stringify(c.clock);
  check("360 quad view shows the time on its own", clockOk(cams[keys.quad]), clk(cams[keys.quad]));
  check("360 panorama shows the time on its own", clockOk(cams[keys.pano]), clk(cams[keys.pano]));
  check("normal cameras don't get the app's clock by default", beforeClock[keys.lobby]?.clock?.wanted === false && beforeClock[keys.ramp]?.clock?.shown === false, clk(beforeClock[keys.lobby]));
  check("Show time in the menu turns the clock on and saves it", clockOk(cams[keys.lobby]) && config.windows[keys.lobby]?.clock === true, `${clk(cams[keys.lobby])} clock=${config.windows[keys.lobby]?.clock}`);
  check("clock stays off on a window too small for it", cams[keys.dock]?.clock?.wanted === true && cams[keys.dock]?.clock?.shown === false, clk(cams[keys.dock]));

  const applied = result.actions.filter((a) => a.act.label?.startsWith("Quality:") || a.act.label?.startsWith("Show time:"));
  const stair = `${A}/aaaaaaaa-cam2`;
  check("Apply to all menu items ran", applied.length === 2 && applied.every((a) => a.ok), JSON.stringify(applied.map((a) => a.error ?? a.act.label)));
  check("Apply to all: Quality saved for every camera, including one never opened",
    [...Object.values(keys), stair].every((k) => config.windows[k]?.channel === 1) && config.windows[stair]?.open === false,
    JSON.stringify([...Object.values(keys), stair].map((k) => config.windows[k]?.channel)));
  check("Apply to all: open windows switched to the Medium stream", Object.values(keys).every((k) => cams[k]?.videoWidth === 1280 && cams[k]?.status === "live"),
    JSON.stringify(Object.values(keys).map((k) => `${cams[k]?.videoWidth}/${cams[k]?.status}`)));
  check("Apply to all: Show time on for every window", Object.values(keys).every((k) => cams[k]?.clock?.wanted === true && config.windows[k]?.clock === true));
  const pic = "brightness(1.3) contrast(1.1)";
  check("Apply to all: the 360 window's picture setting reached every camera, including one never opened",
    result.actions.find((a) => a.act.label?.startsWith("Picture:"))?.ok
      && Object.values(keys).every((k) => cams[k]?.picture?.filter === pic) && JSON.stringify(config.windows[stair]?.picture) === JSON.stringify({ brightness: 1.3, contrast: 1.1 }),
    JSON.stringify(Object.values(keys).map((k) => cams[k]?.picture?.filter)));
  check("the picture filter is on the 360° canvas too", cams[keys.quad]?.picture?.canvasFilter === pic && cams[keys.pano]?.picture?.canvasFilter === pic, JSON.stringify(cams[keys.quad]?.picture));

  const aspects = views.find((i) => typeof i === "object" && i["Aspect ratio"])?.["Aspect ratio"] ?? [];
  check("360° view offers an aspect ratio for the window (16:9 checked by default)",
    ["[x] 16:9 (default)", "4:3", "3:2", "1:1 (square)", "21:9 (ultrawide)", "Any shape (no lock)"].every((l) => aspects.includes(l)), JSON.stringify(aspects));
  const qb = cams[keys.quad]?.bounds;
  check("Aspect ratio 4:3 reshapes the quad window to 4:3 and saves it",
    config.windows[keys.quad]?.dewarp?.aspect === "4:3" && cams[keys.quad]?.dewarp?.aspect === "4:3" && Math.abs(cams[keys.quad]?.aspectLock - 4 / 3) < 0.001
      && qb && Math.abs(qb.width / qb.height - 4 / 3) < 0.02,
    JSON.stringify({ saved: config.windows[keys.quad]?.dewarp?.aspect, lock: cams[keys.quad]?.aspectLock, bounds: qb }));
  check("Any shape takes the panorama window's aspect lock off", config.windows[keys.pano]?.dewarp?.aspect === "free" && cams[keys.pano]?.aspectLock === null,
    JSON.stringify({ saved: config.windows[keys.pano]?.dewarp?.aspect, lock: cams[keys.pano]?.aspectLock }));
  console.log(`  results: ${results}`);
}

// ---------------------------------------------------------------------------------------------
// Hide cameras / Show cameras (mock consoles): per-console Hide all from the camera list, the tray
// toggle, Bring to front leaving hidden windows alone, and hidden windows surviving a restart.

async function hideSuite() {
  console.log("\nHide/show suite (mock consoles, two launches)");
  const userData = tmpDir("hide");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, ramp: `${B}/bbbbbbbb-cam0` };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp", "Gate NoMedium"] },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
      [keys.ramp]: { open: true, bounds: { x: 500, y: 0, width: 480, height: 270 }, channel: 2 },
    },
    settings: { startHidden: false },
  }, null, 2));

  // Click a button in a console's card by its text; returns false if it isn't there.
  const clickInCard = (consoleName, text) => `(() => {
    const card = [...document.querySelectorAll("article.panel")].find((a) => a.querySelector(".console-head b")?.textContent === ${JSON.stringify(consoleName)});
    const btn = card && [...card.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)});
    btn?.click();
    return !!btn;
  })()`;
  const setQualityForAll = (consoleName, channel) => `(() => {
    const card = [...document.querySelectorAll("article.panel")].find((a) => a.querySelector(".console-head b")?.textContent === ${JSON.stringify(consoleName)});
    const sel = card?.querySelector(".console-head select");
    if (!sel) return false;
    sel.value = ${JSON.stringify(String(channel))};
    sel.dispatchEvent(new Event("change"));
    return true;
  })()`;
  const readButtons = `(() => ({
    header: document.getElementById("btn-hide").textContent,
    garage: [...[...document.querySelectorAll("article.panel")].find((a) => a.querySelector(".console-head b")?.textContent === "Garage").querySelectorAll("button")].map((b) => b.textContent),
    rampStatus: [...document.querySelectorAll(".cam-name")].find((n) => n.querySelector("b")?.textContent === "Garage Ramp")?.querySelector("small")?.textContent,
  }))()`;
  // A closed camera whose Medium channel is off in Protect: its quality select shows what its window
  // would open at (Low), not High.
  const gateQuality = `(() => {
    const li = [...document.querySelectorAll(".cams li")].find((l) => l.querySelector(".cam-name b")?.textContent === "Garage Gate NoMedium");
    const sel = li?.querySelector("select");
    return sel ? { value: sel.value, shown: sel.selectedOptions[0]?.textContent } : null;
  })()`;

  const run1 = await runApp({
    userData, results: path.join(userData, "results-1"), seconds: 14, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2600, do: "manager-js", js: gateQuality },
        { at: 3000, do: "manager-js", js: clickInCard("Garage", "Hide all") },
        { at: 4500, do: "manager-js", js: readButtons },
        { at: 5000, do: "tray-click", label: "Show cameras" },
        { at: 12500, do: "manager-js", js: setQualityForAll("Garage", 1) }, // after the Show check: it restarts the stream
        { at: 10500, do: "tray-click", label: "Hide cameras" },
        { at: 11500, do: "tray-click", label: "Bring cameras to front" },
      ]),
    },
  });
  const act = (r, label) => r.result.actions.find((a) => a.act.label === label || (a.act.js && a.act.js.includes(label)));
  const between = (r, from, to) => r.result.samples.filter((s) => s.t > (from?.t ?? Infinity) && s.t < (to?.t ?? Infinity)).at(-1)?.cams ?? {};
  const hideB = act(run1, '"Hide all"');
  const showT = act(run1, "Show cameras");
  const hideAllT = act(run1, "Hide cameras");
  const firstSample = run1.result.samples[0]?.cams ?? {};
  const afterHideB = between(run1, hideB, showT);
  const afterShow = between(run1, showT, hideAllT);
  const end1 = last(run1.result);
  const buttons = run1.result.actions.find((a) => a.act.js === readButtons)?.value;
  const vis = (cams) => JSON.stringify(Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, cams[k]?.visible])));

  const gate = run1.result.actions.find((a) => a.act.js === gateQuality)?.value;
  check("a closed camera with Medium off shows the quality its window would open at (Low)", gate?.value === "2" && /^Low/.test(gate.shown ?? ""), JSON.stringify(gate));
  check("Garage Hide all clicked in the camera list", hideB?.value === true, hideB?.error);
  check("Hide all hid only Garage's window and paused its stream",
    afterHideB[keys.ramp]?.visible === false && afterHideB[keys.ramp]?.status === "paused" && afterHideB[keys.lobby]?.visible && afterHideB[keys.dock]?.visible,
    `${vis(afterHideB)} ramp=${afterHideB[keys.ramp]?.status}`);
  check("camera list shows Restore, Show cameras and a hidden camera",
    buttons?.garage?.includes("Restore") && !buttons.garage.includes("Hide all") && buttons.header === "Show cameras" && buttons.rampStatus?.includes("hidden"),
    JSON.stringify(buttons));
  check("Show cameras brought the window back live at the same place",
    afterShow[keys.ramp]?.visible === true && afterShow[keys.ramp]?.status === "live" && samePlace(afterShow[keys.ramp]?.bounds, firstSample[keys.ramp]?.bounds),
    `status=${afterShow[keys.ramp]?.status} ${JSON.stringify(afterShow[keys.ramp]?.bounds)} vs ${JSON.stringify(firstSample[keys.ramp]?.bounds)}`);
  check("Hide cameras hid every window, and Bring to front left them hidden",
    Object.values(keys).every((k) => end1[k]?.visible === false && end1[k]?.status === "paused"), vis(end1));
  const qa = run1.result.actions.find((a) => a.act.js?.includes("console-head select"));
  check("camera list Quality for all set only that console's cameras",
    qa?.value === true && run1.config.windows[keys.ramp]?.channel === 1 && run1.config.windows[keys.lobby]?.channel === 2 && run1.config.windows[keys.dock]?.channel === 2,
    qa?.error ?? JSON.stringify(Object.values(keys).map((k) => run1.config.windows[k]?.channel)));
  check("hidden windows saved as open + hidden", Object.values(keys).every((k) => run1.config.windows[k]?.open === true && run1.config.windows[k]?.hidden === true),
    JSON.stringify(Object.values(keys).map((k) => run1.config.windows[k])));

  // Second launch: everything was hidden at quit. Nothing should open until Show cameras, and the
  // camera list should come up even with "Start with this list hidden" on, since nothing is on screen.
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
  cfg.settings.startHidden = true;
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(cfg, null, 2));
  const run2 = await runApp({
    userData, results: path.join(userData, "results-2"), seconds: 8, extraArgs: ["--mock"],
    env: { PANES_SELFTEST_ACTIONS: JSON.stringify([{ at: 2500, do: "tray-click", label: "Show cameras" }]) },
  });
  const show2 = act(run2, "Show cameras");
  const beforeShow2 = run2.result.samples.filter((s) => s.t < show2?.t).at(-1)?.cams;
  const end2 = last(run2.result);
  check("relaunch with everything hidden opens no camera windows", beforeShow2 && Object.keys(beforeShow2).length === 0, beforeShow2 && JSON.stringify(Object.keys(beforeShow2)));
  check("relaunch shows the camera list when nothing is on screen", Object.keys(run2.result.windows).some((n) => n.includes("Protect_Panes")), JSON.stringify(Object.keys(run2.result.windows)));
  for (const [name, key] of Object.entries(keys)) {
    const c = end2[key];
    check(`after relaunch, Show cameras restored ${name} live at its saved place`,
      c?.visible && c.status === "live" && c.decodedFrames >= 30 && samePlace(c.bounds, firstSample[key]?.bounds),
      c && `status=${c.status} frames=${c.decodedFrames} ${JSON.stringify(c.bounds)} vs ${JSON.stringify(firstSample[key]?.bounds)}`);
  }
  check("hidden flags cleared after Show cameras", Object.values(keys).every((k) => run2.config.windows[k]?.open === true && !run2.config.windows[k]?.hidden));
  console.log(`  results: ${userData}`);

  // Hide cameras while a window is still loading (it hasn't shown yet): it must stay hidden when its
  // page is ready, not appear with its stream paused. (Electron 45 doesn't show a window hidden
  // before ready-to-show; this guards that.)
  const early = tmpDir("hide-early");
  fs.writeFileSync(path.join(early, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby"] }],
    windows: { [keys.lobby]: { open: false, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 } },
    settings: { startHidden: false },
  }, null, 2));
  const run3 = await runApp({
    userData: early, results: path.join(early, "results"), seconds: 6, extraArgs: ["--mock"],
    env: { PANES_SELFTEST_ACTIONS: JSON.stringify([{ at: 2500, do: "manager-js", js: `(async () => {
      await panes.invoke("mgr:open-camera", ${JSON.stringify(keys.lobby)});
      await panes.invoke("mgr:hide-cameras", null);
      return true;
    })()` }]) },
  });
  const seen3 = run3.result.samples.map((s) => s.cams[keys.lobby]).filter(Boolean);
  check("a window hidden before its first paint stays hidden",
    run3.result.actions[0]?.value === true && seen3.length > 0 && seen3.every((c) => c.visible === false && !c.decodedFrames) && run3.config.windows[keys.lobby]?.hidden === true,
    JSON.stringify({ act: run3.result.actions[0]?.error, seen: seen3.map((c) => [c.visible, c.decodedFrames]), hidden: run3.config.windows[keys.lobby]?.hidden }));
}

// ---------------------------------------------------------------------------------------------
// Stream recovery (mock consoles): what a window does when its camera or its stream misbehaves.

async function streamsSuite() {
  console.log("\nStreams suite (mock consoles, two launches)");
  // Lose the 360° canvas's WebGL context, then restore it `times` times, or (0) leave it lost.
  const loseContext = (times) => `(async () => {
    const ext = document.getElementById("dewarp").getContext("webgl").getExtension("WEBGL_lose_context");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!${times}) { ext.loseContext(); return true; }
    for (let i = 0; i < ${times}; i++) { ext.loseContext(); await wait(300); ext.restoreContext(); await wait(500); }
    return window.__panesStats().dewarp;
  })()`;
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const win = (x, y, extra = {}) => ({ open: true, bounds: { x, y, width: 480, height: 270 }, channel: 2, ...extra });
  const states = (result, k) => result.samples.map((s) => s.cams[k]?.status).filter(Boolean);
  const runs = (list) => list.filter((s, i) => s !== list[i - 1]);
  // Two launches of four or five streams each: every mock stream is its own encoder, and nine at once
  // starved each other on a busy PC.

  // 1. Stream recovery. Dock goes offline 10 s after the console connects and comes back at 16 s; the
  // library would keep its stream "recovering" (renegotiating every few seconds) the whole time.
  // Broken's fragments fail to decode every time. Rewind's encoder restarts 12 s in without flagging
  // the discontinuity: its picture would freeze until the new timestamps caught up, another 12 s.
  const userData = tmpDir("streams");
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, broken: `${A}/aaaaaaaa-cam2`, rewind: `${A}/aaaaaaaa-cam3` };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Broken", "Rewind"], mockDropout: { camera: "Dock", offMs: 10000, onMs: 16000 } }],
    windows: { [keys.lobby]: win(0, 0), [keys.dock]: win(500, 0), [keys.broken]: win(0, 300), [keys.rewind]: win(500, 300, { clock: true }) },
    settings: { startHidden: true },
  }, null, 2));
  const { result } = await runApp({ userData, results: path.join(userData, "results"), seconds: 34, extraArgs: ["--mock"] });
  const dock = runs(states(result, keys.dock));
  const reconnectingSamples = states(result, keys.dock).filter((s) => s === "reconnecting").length;
  check("a camera that goes offline while viewed reads \"offline\", not \"reconnecting\" for the whole outage",
    dock.includes("offline") && reconnectingSamples <= 1, `${dock.join(" > ")} (reconnecting in ${reconnectingSamples} samples)`);
  check("it comes back live when the camera is back", dock.at(-1) === "live" && dock.indexOf("live") < dock.indexOf("offline"), dock.join(" > "));
  const lobbyStates = states(result, keys.lobby);
  check("the other camera on the console stays live, once it's up",
    lobbyStates.includes("live") && runs(lobbyStates.slice(lobbyStates.indexOf("live"))).join() === "live", runs(lobbyStates).join(" > "));
  const subs = result.connections[A]?.subscriptions?.["aaaaaaaa-cam1"];
  check("the offline camera is subscribed again only once it's back", subs === 2, `subscriptions=${subs}`);

  // Every failed decode leads to a restart, spaced out more each time, and the window ends up saying
  // why instead of showing black with a green dot.
  const broken = result.samples.map((s) => s.cams[keys.broken]).filter((c) => c && !c.error);
  const end = broken.at(-1);
  const afterFirst = broken.filter((c) => c.resetRequests > 0);
  check("a stream that never decodes is restarted with back-off (3 s, 6 s, 12 s...)",
    end?.resetRequests >= 3 && end.resetRequests <= 5, `resetRequests=${end?.resetRequests} errors=${JSON.stringify(end?.errors?.slice(-3))}`);
  check("its window always says something once it has failed (never black under a hidden status)",
    afterFirst.length > 3 && afterFirst.every((c) => c.statusText), JSON.stringify(afterFirst.map((c) => [c.status, c.statusText])));
  // Any sample: each back-off retry shows "Connecting…" for a moment, and the last sample can land there.
  check("after 3 failed restarts it says this PC couldn't decode it", broken.some((c) => /couldn't decode/.test(c.statusText ?? "")),
    JSON.stringify(broken.map((c) => c.statusText)));

  // Fragments still arriving but no new frame: restart, and meanwhile no clock over the frozen picture.
  const rw = result.samples.map((s) => s.cams[keys.rewind]).filter((c) => c && !c.error);
  const rwEnd = rw.at(-1);
  check("a picture that freezes while fragments keep arriving is restarted",
    rwEnd?.errors?.includes("no new frames") && rwEnd.status === "live" && rwEnd.decodedFrames > rw.at(-2)?.decodedFrames,
    JSON.stringify({ errors: rwEnd?.errors, frames: rw.map((c) => c.decodedFrames) }));
  const frozen = rw.filter((c, i) => i > 0 && c.status === "live" && c.decodedFrames === rw[i - 1].decodedFrames && c.decodedFrames > 0);
  check("no clock over the frozen picture", frozen.length >= 1 && frozen.every((c) => !c.clock.shown) && rwEnd?.clock?.shown,
    JSON.stringify(rw.map((c) => [c.decodedFrames, c.clock.shown])));
  console.log(`  results: ${userData}`);

  // 2. Pages and the GPU. Stair's window and a grid tile of Lobby have their renderers crashed 8 s in.
  // The 360° window's WebGL context is lost and restored three times at 6 s; 360° is turned off and on
  // at 14 s, once it has surely drawn; then the context is lost for good at 18 s. Bogus sends a codec
  // nothing can play.
  const userData2 = tmpDir("streams-pages");
  const keys2 = { lobby: `${A}/aaaaaaaa-cam0`, stair: `${A}/aaaaaaaa-cam1`, bogus: `${A}/aaaaaaaa-cam2`, fish: `${A}/aaaaaaaa-cam360` };
  fs.writeFileSync(path.join(userData2, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Stair", "Bogus"] }],
    windows: { [keys2.lobby]: win(0, 0), [keys2.stair]: win(500, 0), [keys2.bogus]: win(0, 300), [keys2.fish]: win(500, 300) },
    grids: [{ id: "grid-1", name: "G", templateId: "2x2", bounds: { x: 1000, y: 0, width: 640, height: 400 }, open: true, tiles: [{ key: keys2.lobby, channel: 2 }, null, null, null] }],
    settings: { startHidden: true },
  }, null, 2));
  const fishStats = (tag) => `${tag} (() => { const s = window.__panesStats(); return { active: s.dewarp.active, hasFrame: s.dewarp.hasFrame, frames: s.decodedFrames }; })()`;
  const { result: r2 } = await runApp({
    userData: userData2, results: path.join(userData2, "results"), seconds: 26, extraArgs: ["--mock"],
    env: {
      PANES_MOCK_FISHEYE: path.join(FIXTURES, "fisheye-ceiling.png"),
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 6000, do: "camera-js", win: 3, js: loseContext(3) },
        { at: 8000, do: "crash", win: 1 },
        { at: 8000, do: "crash", tile: "G#0" },
        // Lobby's spinner: limited to 22 turns, and a new status starts it over.
        { at: 8500, do: "camera-js", win: 0, js: `/*spinner*/ (() => {
          const s = document.querySelector(".spinner");
          const count = getComputedStyle(s).animationIterationCount;
          showStatus("reconnecting", "test " + Date.now());
          const runningAfterRestart = s.getAnimations().some((a) => a.playState === "running");
          hideStatus();
          return { count, runningAfterRestart };
        })()` },
        // 360° off and on again once it has drawn: the texture goes back to 1x1 while off, and frames
        // come back after.
        { at: 13800, do: "camera-js", win: 3, js: fishStats("/*before*/") },
        { at: 14000, do: "dewarp", win: 3, changes: { mode: "off" } },
        { at: 14600, do: "camera-js", win: 3, js: fishStats("/*off*/") },
        { at: 14700, do: "dewarp", win: 3, changes: { mode: "quad" } },
        { at: 17000, do: "camera-js", win: 3, js: fishStats("/*on*/") },
        { at: 18000, do: "camera-js", win: 3, js: loseContext(0) },
      ]),
    },
  });

  // A crashed camera page (window or grid tile) is reloaded and plays again.
  const crashAt = r2.actions.find((a) => a.act.do === "crash")?.t ?? Infinity;
  const appLog = fs.readFileSync(path.join(userData2, "protect-panes.log"), "utf8");
  for (const [name, id] of [["window", keys2.stair], ["grid tile", "grid:G#0"]]) {
    const after = r2.samples.filter((s) => s.t > crashAt).map((s) => s.cams[id]);
    const live = after.filter((c) => c && !c.error && c.status === "live");
    const before = r2.samples.filter((s) => s.t < crashAt).at(-1)?.cams[id]?.decodedFrames ?? 0;
    check(`a crashed camera page (${name}) is reloaded and plays again`,
      r2.actions.filter((a) => a.act.do === "crash").every((a) => a.ok) && after.some((c) => !c || c.error || c.decodedFrames < before)
        && live.length >= 2 && live.at(-1).decodedFrames > live.at(-2).decodedFrames,
      JSON.stringify(r2.samples.map((s) => [s.t > crashAt, s.cams[id]?.error ? "error" : s.cams[id]?.decodedFrames])));
  }
  check("the crashes are logged", (appLog.match(/camera page for \S+ gone \(crashed/g) ?? []).length === 2,
    appLog.split(/\r?\n/).filter((l) => l.includes("gone")).join(" | "));
  const restored = r2.actions.find((a) => a.act.do === "camera-js" && a.act.js.includes("i < 3"))?.value;
  check("a 360° view whose WebGL context is lost and restored 3 times draws again, set up once per restore",
    restored?.active && !restored.glLost && restored.glSetups === 4, JSON.stringify(restored));
  const [drawn, off, on] = ["/*before*/", "/*off*/", "/*on*/"].map((tag) => r2.actions.find((a) => a.act.js?.startsWith(tag))?.value);
  check("turning 360° off lets its frame texture go, and turning it on draws again",
    drawn?.hasFrame === true && off?.active === false && off.hasFrame === false && on?.active === true && on.hasFrame === true, JSON.stringify({ drawn, off, on }));
  const fishEnd = r2.samples.at(-1)?.cams[keys2.fish]?.dewarp;
  check("a context that never comes back falls back to the raw fisheye picture", fishEnd?.glBroken && fishEnd.active === false, JSON.stringify(fishEnd));
  // Nothing here can play it: the window says so and the console isn't asked for its video any more.
  const bogusEnd = r2.samples.at(-1)?.cams[keys2.bogus];
  const conn = r2.connections[A];
  check("a stream with a codec this PC can't play is stopped, and the window says why",
    /codec isn't supported/.test(bogusEnd?.statusText ?? "") && conn?.subscriptions?.["aaaaaaaa-cam2"] === 1 && conn?.active?.["aaaaaaaa-cam2"] === 0,
    JSON.stringify({ status: bogusEnd?.statusText, subscriptions: conn?.subscriptions?.["aaaaaaaa-cam2"], active: conn?.active?.["aaaaaaaa-cam2"] }));
  const spin = r2.actions.find((a) => a.act.js?.startsWith("/*spinner*/"))?.value;
  check("the status spinner stops after about 20 s instead of spinning through a whole outage",
    spin?.count === "22" && spin.runningAfterRestart === true, JSON.stringify(spin));
  console.log(`  results: ${userData2}`);
}

// ---------------------------------------------------------------------------------------------
// config.json recovery (mock consoles): a damaged config.json, or one missing after a save that was
// cut off between its two renames, falls back to config.json.bak. (The fsync that makes the saved
// data survive a power cut can't be tested here; this covers the paths around it.)

// Settings → Move to another PC: export on one "PC", import on another (mock consoles, two launches).
// The self-test names the file (PANES_TEST_FILE) instead of the file dialogs.

async function transferSuite() {
  console.log("\nSettings export/import suite (mock consoles, two launches)");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const pw = (s) => ({ enc: "plain", data: Buffer.from(s).toString("base64") });
  const lobby = `${A}/aaaaaaaa-cam0`;
  const exportFile = path.join(tmpDir("transfer-file"), "Protect Panes settings.json");
  const invoke = (channel) => `panes.invoke(${JSON.stringify(channel)}).then((r) => r, (e) => ({ error: String(e?.message ?? e) }))`;

  // The source PC: two consoles with passwords and a pin, a layout, a grid, settings.
  const source = tmpDir("transfer-source");
  fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: pw("source-secret"), certSha256: "AA:11", mockCameras: ["Lobby"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: pw("garage-secret"), mockCameras: ["Ramp"] },
    ],
    windows: { [lobby]: { open: true, bounds: { x: 10, y: 20, width: 480, height: 270 }, channel: 2 } },
    layouts: [{ id: "lay-1", name: "Day", windows: { [lobby]: { bounds: { x: 0, y: 0, width: 640, height: 360 }, channel: 1 } } }],
    grids: [{ id: "grid-1", name: "Wall", templateId: "2x2", bounds: { x: 0, y: 0, width: 640, height: 400 }, open: false, tiles: [{ key: lobby }, null, null, null] }],
    settings: { startHidden: false, lockLayout: true, showNames: false, launchAtLogin: true, updateSource: "" },
  }, null, 2));
  const run1 = await runApp({
    userData: source, results: path.join(source, "results"), seconds: 5, extraArgs: ["--mock"],
    env: { PANES_TEST_FILE: exportFile, PANES_SELFTEST_ACTIONS: JSON.stringify([{ at: 2000, do: "manager-js", js: invoke("mgr:export-settings") }]) },
  });
  const exported = run1.result.actions[0]?.value;
  const text = fs.existsSync(exportFile) ? fs.readFileSync(exportFile, "utf8") : "";
  let file = null;
  try { file = JSON.parse(text); } catch { /* checked below */ }
  check("Export writes the file: consoles (with their trusted certificate), windows, layouts, grids, settings",
    exported?.path === exportFile && file?.format === "protect-panes-settings" && file.consoles.length === 2 && file.consoles[0].certSha256 === "AA:11"
      && file.layouts?.[0]?.name === "Day" && file.grids?.[0]?.name === "Wall" && file.windows?.[lobby]?.bounds?.x === 10 && file.settings?.lockLayout === true,
    JSON.stringify(exported ?? run1.result.actions[0]));
  const secrets = ["source-secret", "garage-secret", pw("source-secret").data, pw("garage-secret").data];
  check("the export has no passwords in it, in any form", !!text && !/"password"/.test(text) && secrets.every((s) => !text.includes(s)), text.slice(0, 200));
  check("the export leaves out this PC's own setting (Start with Windows)", file && !("launchAtLogin" in file.settings), JSON.stringify(file?.settings));

  // The target PC: the same Building console under another id (same address and username), a
  // console that shares Garage's id but not its address, and one the file doesn't have.
  const target = tmpDir("transfer-target");
  const targetFile = path.join(tmpDir("transfer-in"), "import.json");
  fs.writeFileSync(targetFile, JSON.stringify({ hello: "not an export" }));
  fs.writeFileSync(path.join(target, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: "cccccccc-0000-4000-8000-000000000003", name: "Old name", host: "mock-a", username: "m", password: pw("target-secret"), certSha256: "BB:22", mockCameras: ["Lobby"] },
      { id: B, name: "Garage", host: "mock-elsewhere", username: "m", password: pw("elsewhere-secret"), mockCameras: ["Ramp"] },
      { id: "dddddddd-0000-4000-8000-000000000004", name: "Old console", host: "mock-z", username: "m", password: null, mockCameras: ["Z"] },
    ],
    windows: {},
    settings: { startHidden: false, launchAtLogin: false, lockLayout: false, updateSource: "" },
  }, null, 2));
  // The first import gets a file that isn't an export; then the real one is put in its place.
  const swap = setTimeout(() => fs.copyFileSync(exportFile, targetFile), 3000);
  const run2 = await runApp({
    userData: target, results: path.join(target, "results"), seconds: 6, extraArgs: ["--mock"],
    env: {
      PANES_TEST_FILE: targetFile,
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2000, do: "manager-js", js: `/*bad*/ ${invoke("mgr:import-settings")}` },
        { at: 4000, do: "manager-js", js: invoke("mgr:import-settings") },
      ]),
    },
  });
  clearTimeout(swap);
  const bad = run2.result.actions.find((a) => a.act.js.startsWith("/*bad*/"))?.value;
  const good = run2.result.actions.find((a) => !a.act.js.startsWith("/*bad*/"))?.value;
  check("Import refuses a file that isn't a settings export", /isn't a Protect Panes settings export/.test(bad?.error ?? ""), JSON.stringify(bad));
  const cfg = run2.config;
  const byHost = (h) => cfg?.consoles.find((c) => c.host === h);
  check("Import replaces the consoles, layouts, grids, windows and settings with the file's",
    good?.restarting === false && cfg?.consoles.length === 2 && byHost("mock-a")?.name === "Building" && byHost("mock-b")?.name === "Garage"
      && !byHost("mock-z") && !byHost("mock-elsewhere") && cfg.layouts?.[0]?.name === "Day" && cfg.grids?.[0]?.name === "Wall"
      && cfg.windows?.[lobby]?.bounds?.x === 10 && cfg.settings.lockLayout === true && cfg.settings.showNames === false,
    JSON.stringify({ good, consoles: cfg?.consoles.map((c) => `${c.name}@${c.host}`), layouts: cfg?.layouts?.length, grids: cfg?.grids?.length }));
  check("a console already on this PC (same address and username) keeps its password, and this PC's trusted certificate",
    byHost("mock-a")?.password?.data === pw("target-secret").data && byHost("mock-a")?.certSha256 === "BB:22", JSON.stringify(byHost("mock-a")));
  check("a console that only shares an id with one here gets no password (it would go to another host)",
    byHost("mock-b") && !byHost("mock-b").password, JSON.stringify(byHost("mock-b")));
  check("Import keeps this PC's own setting (Start with Windows)", cfg?.settings.launchAtLogin === false, JSON.stringify(cfg?.settings));
  const backup = path.join(target, "config.json.before-import");
  check("Import keeps the settings it replaced as config.json.before-import",
    fs.existsSync(backup) && fs.readFileSync(backup, "utf8").includes("Old console"), backup);
}

async function configSuite() {
  console.log("\nConfig file suite (mock consoles, three launches)");
  const userData = tmpDir("config");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const file = path.join(userData, "config.json");
  const good = JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby"] }],
    windows: { [`${A}/aaaaaaaa-cam0`]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 } },
    settings: { startHidden: true, updateSource: "" },
  }, null, 2);
  const logOf = () => fs.readFileSync(path.join(userData, "protect-panes.log"), "utf8");
  const files = () => fs.readdirSync(userData).filter((f) => f.startsWith("config.json"));
  const loaded = (r) => !!r.result.connections[A];

  // 1. A damaged config.json (cut off mid-write) with a good backup.
  fs.writeFileSync(file, "{\"version\": 1, \"consoles\": [");
  fs.writeFileSync(file + ".bak", good);
  const r1 = await runApp({ userData, results: path.join(userData, "results-1"), seconds: 4, extraArgs: ["--mock"] });
  check("a damaged config.json falls back to config.json.bak, and is kept for a look",
    loaded(r1) && files().some((f) => f.startsWith("config.json.corrupt-")) && /couldn't be read/.test(logOf()) && /loaded config\.json\.bak/.test(logOf()),
    JSON.stringify({ loaded: loaded(r1), files: files() }));
  const bak = (() => { try { return JSON.parse(fs.readFileSync(file + ".bak", "utf8")); } catch { return null; } })();
  check("the damaged file doesn't become the next backup", bak?.consoles?.[0]?.id === A && r1.config?.consoles?.[0]?.id === A,
    fs.readFileSync(file + ".bak", "utf8").slice(0, 80));

  // 2. A normal launch: each save moves the previous config.json to .bak and leaves no .tmp behind.
  const before = fs.readFileSync(file, "utf8");
  const r2 = await runApp({ userData, results: path.join(userData, "results-2"), seconds: 4, extraArgs: ["--mock"] });
  check("a save keeps the previous config.json as config.json.bak, with no .tmp left",
    loaded(r2) && fs.readFileSync(file + ".bak", "utf8") === before && !files().includes("config.json.tmp"), JSON.stringify(files()));

  // 3. config.json missing but a backup there: a save cut off between its two renames.
  fs.rmSync(file);
  const r3 = await runApp({ userData, results: path.join(userData, "results-3"), seconds: 4, extraArgs: ["--mock"] });
  check("with config.json missing, the backup is loaded", loaded(r3) && r3.config?.consoles?.[0]?.id === A, JSON.stringify({ loaded: loaded(r3), files: files() }));

  // 4. Odd shapes (hand edits, or a newer version) must not stop the app starting: a null window
  // entry, a grid on Arrange's "auto" template, a null layout entry, and a key this version doesn't know.
  const odd = JSON.parse(good);
  odd.windows[`${A}/aaaaaaaa-cam9`] = null;
  odd.grids = [{ id: "g-auto", name: "Auto grid", templateId: "auto", bounds: { x: 500, y: 0, width: 640, height: 400 }, open: true, tiles: [{ key: `${A}/aaaaaaaa-cam0`, channel: 2 }] }];
  odd.layouts = [{ id: "l-1", name: "Odd", windows: { [`${A}/aaaaaaaa-cam0`]: null } }];
  odd.future = { kept: true };
  fs.writeFileSync(file, JSON.stringify(odd, null, 2));
  const r4 = await runApp({ userData, results: path.join(userData, "results-4"), seconds: 5, extraArgs: ["--mock"] });
  check("odd config shapes don't stop the app starting, and its grid opens",
    loaded(r4) && Object.keys(last(r4.result)).some((k) => k.startsWith("grid:Auto grid#")), JSON.stringify({ loaded: loaded(r4), cams: Object.keys(last(r4.result) ?? {}) }));
  check("keys this version doesn't know are kept when it saves", r4.config?.future?.kept === true, JSON.stringify(r4.config?.future));
  console.log(`  results: ${userData}`);
}

// ---------------------------------------------------------------------------------------------
// Security (mock consoles): pages can't be navigated away, open windows or get permissions, and IPC
// only answers the app's own pages.

async function securitySuite() {
  console.log("\nSecurity suite (mock consoles)");

  // A console's snapshot answer only becomes a preview if it's a JPEG of a sensible size.
  {
    const { Previews } = await import(new URL("../src/previews.js", import.meta.url).href);
    const answers = { ok: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), huge: Buffer.alloc(3 * 1024 * 1024, 0xff), png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]) };
    const previews = new Previews({ getCamera: (key) => ({ isOnline: true, snapshot: async () => answers[key] }) });
    const got = Object.fromEntries(await Promise.all(Object.keys(answers).map(async (k) => [k, (await previews.get(k))?.url?.slice(0, 23) ?? null])));
    check("camera previews take only a JPEG of a sensible size", got.ok === "data:image/jpeg;base64," && got.huge === null && got.png === null, JSON.stringify(got));
  }

  // Update locations: no device paths or WebDAV-over-HTTP forms; a manifest read is bounded in bytes
  // and time, and a download that stops sending gives up.
  {
    const { sourceKind, Updater } = await import(new URL("../src/updater.js", import.meta.url).href);
    const kinds = ["\\\\server\\share\\Protect Panes", "D:\\Releases", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "\\\\10.0.0.5@SSL@8443\\dav", "\\\\host@80\\x"].map(sourceKind);
    check("update locations: shares and drives, not device paths or WebDAV-over-HTTP", JSON.stringify(kinds) === JSON.stringify(["path", "path", null, null, null, null]), JSON.stringify(kinds));

    const endless = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }), { status: 200 });
    const silent = (_url, { signal } = {}) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
      resolve(new Response(new ReadableStream({ start() {} }), { status: 200 })); // headers, then nothing
    });
    const updater = (fetch) => new Updater({
      currentVersion: "1.0.0", getSource: () => "https://updates.invalid/pp", publicKey: "", stageDir: tmpDir("upd"), fetch,
      timeouts: { manifestMs: 500, idleMs: 500 },
    });
    const t0 = Date.now();
    const alive = setInterval(() => {}, 1_000); // AbortSignal.timeout's timer doesn't keep Node running
    const big = await updater(endless).check({ download: false });
    const slow = await updater(silent).check({ download: false });
    clearInterval(alive);
    check("an endless or silent update manifest is given up quickly, not read into memory or waited on",
      big.status === "error" && /too large/.test(big.message) && slow.status === "error" && Date.now() - t0 < 5_000,
      JSON.stringify({ big: big.message, slow: slow.message, ms: Date.now() - t0 }));
  }

  // IPC's own-page check, against the URL Chromium really wrote for a packaged app in an awkward
  // folder (a raw "%"; decoding it threw, and the camera list got no answers there).
  {
    const { isFileUrlOf } = await import(new URL("../src/util.js", import.meta.url).href);
    // Both as measured in the packaged build: Chromium's page URL, and Electron's Node 24 pathToFileURL.
    const file = String.raw`C:\Users\JAMESC~1\AppData\Local\Temp\pp\Jo & 100% O'Brien\Protect Panes\resources\app.asar\src\renderer\camera.html`;
    const chromium = "file:///C:/Users/JAMESC~1/AppData/Local/Temp/pp/Jo%20&%20100%%20O'Brien/Protect%20Panes/resources/app.asar/src/renderer/camera.html?tile=1";
    const node24 = "file:///C:/Users/JAMESC%7E1/AppData/Local/Temp/pp/Jo%20&%20100%25%20O'Brien/Protect%20Panes/resources/app.asar/src/renderer/camera.html";
    const results = [
      isFileUrlOf(chromium, file),
      isFileUrlOf(node24, file),
      isFileUrlOf("file:///E:/renderer/camera.html", file),
      isFileUrlOf(chromium.replace("camera.html", "manager.html"), file),
      isFileUrlOf("", file),
    ];
    check("IPC's own-page check matches Chromium's and Node's spelling of the page, nothing else", JSON.stringify(results) === "[true,true,false,false,false]", JSON.stringify(results));
  }

  // Text from a console (a controller name, a reason) can't forge log lines.
  {
    const { createLogger } = await import(new URL("../src/log.js", import.meta.url).href);
    const file = path.join(tmpDir("log"), "test.log");
    const saved = process.stdout.write;
    process.stdout.write = () => true; // the logger echoes to stdout too
    try { createLogger(file).warn("connection lost (%s)", "bad\r\n2026-01-01T00:00:00.000Z INFO  forged"); } finally { process.stdout.write = saved; }
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    check("a line break in logged text can't forge a log line", lines.length === 1 && lines[0].includes("bad\\n2026"), JSON.stringify(lines));
  }
  const userData = tmpDir("security");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const lobby = `${A}/aaaaaaaa-cam0`;
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby"] }],
    windows: { [lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 } },
    settings: { startHidden: false },
  }, null, 2));
  // What a dropped file does: navigate the page. A harmless local file, so nothing leaves the PC.
  const target = pathToFileURL(path.join(FIXTURES, "fisheye-ceiling.png")).href;
  const navigate = `(() => { location.href = ${JSON.stringify(target)}; return true; })()`;
  const where = "location.pathname.split('/').pop()";
  const tryOpen = "(() => { const w = window.open('about:blank'); return w === null; })()";
  const askPermission = "Notification.requestPermission()";
  // What a page that got hold of the camera list's IPC could send.
  const badIpc = `(async () => {
    await panes.invoke("mgr:set-channel", { key: "__proto__", channel: 7 });
    await panes.invoke("mgr:set-channel", { key: ${JSON.stringify(lobby)}, channel: 1.5 });
    await panes.invoke("mgr:set-channel", { key: ${JSON.stringify(`${A}/never-seen`)}, channel: NaN });
    await panes.invoke("mgr:set-setting", { name: "updateSource", value: true });
    await panes.invoke("mgr:set-setting", { name: "toString", value: true });
    return true;
  })()`;
  const { result, config } = await runApp({
    userData, results: path.join(userData, "results"), seconds: 7, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2500, do: "manager-js", js: navigate },
        { at: 2500, do: "camera-js", win: 0, js: navigate },
        { at: 3500, do: "manager-js", js: where },
        { at: 3500, do: "camera-js", win: 0, js: where },
        { at: 3600, do: "manager-js", js: tryOpen },
        { at: 3700, do: "camera-js", win: 0, js: askPermission },
        { at: 4000, do: "manager-js", js: badIpc },
      ]),
    },
  });
  const val = (doing, js) => result.actions.find((a) => a.act.do === doing && a.act.js === js);
  check("IPC input that isn't a camera key, a channel or a setting is ignored",
    val("manager-js", badIpc)?.value === true && result.objectPrototype?.length === 0 && config.windows[lobby]?.channel === 2
      && !(`${A}/never-seen` in config.windows) && config.settings.updateSource === "" && !Object.hasOwn(config.settings, "toString"),
    JSON.stringify({ act: val("manager-js", badIpc)?.error, proto: result.objectPrototype, lobby: config.windows[lobby]?.channel, settings: config.settings }));
  check("pages can't be navigated away (what a dropped file or link does)",
    val("manager-js", where)?.value === "manager.html" && val("camera-js", where)?.value === "camera.html",
    JSON.stringify([val("manager-js", where), val("camera-js", where)].map((a) => a?.value ?? a?.error)));
  check("pages can't open windows", val("manager-js", tryOpen)?.value === true, JSON.stringify(val("manager-js", tryOpen)));
  check("pages are refused permissions", val("camera-js", askPermission)?.value === "denied", JSON.stringify(val("camera-js", askPermission)));
  console.log(`  results: ${userData}`);
}

// ---------------------------------------------------------------------------------------------
// ConsoleConnection unit checks (fake ProtectClient.connect), run under Electron's Node because
// unifi-protect needs Node >= 22.20. test/connection-unit.mjs prints the results as JSON.

async function connectionSuite() {
  console.log("\nConsole connection suite (unit, fake library client)");
  const r = spawnSync(ELECTRON, [path.join(ROOT, "test", "connection-unit.mjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60_000,
  });
  let out = {};
  try { out = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)); } catch { /* checked below */ }
  check("connection unit script ran", r.status === 0 && Object.keys(out).length > 0, `${r.status} ${r.stderr?.slice(-500)}`);
  const ra = out.refusedThenAccepted;
  check("a refused login (UniFi OS booting) is retried and connects once accepted",
    ra?.state === "connected" && ra.calls === 3 && ra.states.filter((s) => s === "authfailed").length === 2, JSON.stringify(ra));
  const or = out.overlappingRestarts;
  check("two overlapping restarts leave the console connected, not idle", or?.state === "connected", JSON.stringify(or));
  const ud = out.undecryptable;
  check("a saved password that can't be decrypted says to enter it again, and isn't retried",
    ud?.state === "authfailed" && /Enter it again/.test(ud.message) && ud.calls === 0, JSON.stringify(ud));
  check("the channel a window will use: the wish, else the next lower quality, else anything", JSON.stringify(out.pickChannel) === "[1,2,2,0,0]", JSON.stringify(out.pickChannel));
  check("a camera with a null or numeric name doesn't break the camera list", JSON.stringify(out.oddNames) === JSON.stringify(["42", "Camera", "Lobby"]), JSON.stringify(out.oddNames));
  const tl = out.throwingListener;
  check("a state listener that throws doesn't turn a connect into a failure or a second login",
    tl?.state === "connected" && tl.calls === 1 && !tl.threw, JSON.stringify(tl));
  // Gaps with delays [40, 120, 360]: three failures (40, 120, 360), video, then from the start (40, 120).
  const g = out.neverStarts?.gaps ?? [];
  const near = (v, want) => v >= want * 0.8 && v < want * 1.8;
  check("a stream that never starts backs off, and video in between starts the back-off over",
    g.length >= 5 && near(g[0], 40) && near(g[1], 120) && near(g[2], 360) && near(g[3], 40) && near(g[4], 120), JSON.stringify(g));
  const np = out.noPassword;
  check("a console with no saved password (imported) asks for it, and doesn't log in with none",
    np?.state === "authfailed" && /No password saved/.test(np.message) && np.calls === 0, JSON.stringify(np));
  // UniFi Access readers (bare-livestream.js), fed ffmpeg's real fMP4 through a fake socket.
  const br = out.bareReader;
  check("Access reader: bare samples become fragments a decoder plays, every frame, video track only",
    br?.initCodec === "avc1.64000d" && br.rawTraks === 2 && br.initTraks === 1 && br.media === br.samples && br.decoded === br.samples && br.state === "live", JSON.stringify(br));
  check("Access reader: the timeline is contiguous and keeps up with the clock through network bursts",
    br?.contiguous && br.durationsInRange && br.driftFrames < 2, JSON.stringify(br && { contiguous: br.contiguous, inRange: br.durationsInRange, drift: br.driftFrames }));
  check("Access reader: a socket the console closes ends the stream with an error (so it's retried after a wait)",
    /closed/.test(br?.endedWith ?? ""), JSON.stringify(br?.endedWith));
  const fr = out.framedReader;
  check("Access reader that sends the usual begin/moof/mdat/end: segments as the library makes them, init untouched",
    fr?.initSame && fr.initCodec === "avc1.64000d,mp4a.40.2" && fr.media === fr.fragments && fr.sameBytes, JSON.stringify(fr));
}

// ---------------------------------------------------------------------------------------------
// Window sizes across launches (mock consoles): at 150 % scaling Electron reads a window back up to
// 1 DIP bigger than it was set (4 DIP for constructor bounds), and saving that made every window
// grow on each launch. Odd sizes and positions, aspect lock off so nothing snaps the size back.
// The scale is forced to 1.5 so this reproduces on any display, CI's 100 % included. Everything fits
// a 1024 x 768 screen at that scale (683 x 512 DIP, less the taskbar), which is what CI's runner has:
// a saved place that doesn't fit is moved on purpose, and that isn't what this checks.

async function boundsSuite() {
  console.log("\nWindow bounds suite (mock consoles, three launches)");
  const userData = tmpDir("bounds");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1` };
  const start = {
    [keys.lobby]: { x: 37, y: 21, width: 301, height: 171 },
    [keys.dock]: { x: 351, y: 23, width: 277, height: 157 },
    grid: { x: 11, y: 211, width: 401, height: 251 },
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock"] }],
    windows: {
      [keys.lobby]: { open: true, bounds: start[keys.lobby], channel: 2 },
      [keys.dock]: { open: true, bounds: start[keys.dock], channel: 2 },
    },
    grids: [{ id: "grid-1", name: "Odd", templateId: "2x2", bounds: start.grid, open: true, tiles: [{ key: keys.lobby, channel: 2 }, null, null, null] }],
    settings: { startHidden: true, lockAspect: false },
  }, null, 2));

  const runs = [];
  for (let i = 1; i <= 3; i++) {
    runs.push(await runApp({ userData, results: path.join(userData, `results-${i}`), seconds: 6, extraArgs: ["--mock", "--force-device-scale-factor=1.5"] }));
  }
  const saved = (r) => ({ [keys.lobby]: r.config.windows[keys.lobby]?.bounds, [keys.dock]: r.config.windows[keys.dock]?.bounds, grid: r.config.grids[0]?.bounds });
  const sameBounds = (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const scale = runs[0].result.displays?.[0]?.scaleFactor;
  check(`saved window and grid bounds unchanged after three launches (display scale ${scale})`,
    runs.every((r) => Object.entries(saved(r)).every(([k, b]) => sameBounds(b, start[k]))),
    JSON.stringify(runs.map(saved)));
  // What's on screen may read a DIP bigger than what was set, but it must be the same every launch.
  const onScreen = (r) => [keys.lobby, keys.dock].map((k) => r.result.samples.at(-1)?.cams[k]?.bounds)
    .concat(Object.entries(r.result.windows).find(([n]) => n.includes("Odd"))?.[1]);
  check("on-screen bounds identical on every launch", runs.every((r) => JSON.stringify(onScreen(r)) === JSON.stringify(onScreen(runs[0]))) && onScreen(runs[0]).every(Boolean),
    JSON.stringify(runs.map(onScreen)));

  // A monitor drops out: Windows moves its windows elsewhere (here the test does, after the event
  // Electron would send). Those moves mustn't become the saved layout, and when a monitor is added
  // again the windows go back. A third window saved with its top edge above the screen (so it
  // couldn't be dragged back) opens somewhere reachable instead.
  const cfg4 = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
  const stair = `${A}/aaaaaaaa-cam2`;
  cfg4.consoles[0].mockCameras = ["Lobby", "Dock", "Stair"];
  cfg4.windows[stair] = { open: true, bounds: { x: 200, y: -300, width: 320, height: 400 }, channel: 2 };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(cfg4, null, 2));
  const r4 = await runApp({
    userData, results: path.join(userData, "results-4"), seconds: 10, extraArgs: ["--mock", "--force-device-scale-factor=1.5"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 3000, do: "screen-event", event: "display-removed" },
        { at: 3200, do: "move", win: 0, to: [0, 0] },
        { at: 3200, do: "move", tile: "Odd#0", to: [20, 20] },
        { at: 6500, do: "screen-event", event: "display-added" },
      ]),
    },
  });
  const added = r4.result.actions.find((a) => a.act.event === "display-added")?.t ?? 0;
  const movedSample = r4.result.samples.filter((s) => s.t < added).at(-1)?.cams[keys.lobby]?.bounds;
  const endLobby = last(r4.result)[keys.lobby]?.bounds;
  check("windows moved off a monitor that went away aren't saved there, and go back when it returns",
    movedSample?.x === 0 && movedSample.y === 0 && sameBounds(r4.config.windows[keys.lobby]?.bounds, start[keys.lobby]) && sameBounds(r4.config.grids[0]?.bounds, start.grid)
      && samePlace(endLobby, start[keys.lobby]),
    JSON.stringify({ moved: movedSample, end: endLobby, saved: r4.config.windows[keys.lobby]?.bounds, grid: r4.config.grids[0]?.bounds }));
  const stairAt = last(r4.result)[stair]?.bounds;
  check("a window saved with its top edge off screen opens where it can be dragged", stairAt && stairAt.y >= 0, JSON.stringify(stairAt));
  console.log(`  results: ${userData}`);
}

// ---------------------------------------------------------------------------------------------
// Named layouts (mock consoles): save through the dialog, import a Protect liveview, apply it,
// then switch back from the tray.

async function layoutsSuite() {
  console.log("\nLayouts suite (mock consoles)");
  const userData = tmpDir("layouts");
  const results = path.join(userData, "results");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, stair: `${A}/aaaaaaaa-cam2`, ramp: `${B}/bbbbbbbb-cam0` };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair"],
        mockLiveviews: [{ id: "lv1", name: "Entrances", slots: [0, 2, null, 1] }, { id: "lv2", name: "Big lobby", slots: [0, 1, 0, 2, null, null] }] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
      [keys.ramp]: { open: true, bounds: { x: 500, y: 0, width: 480, height: 270 }, channel: 2 },
    },
    // Quality from tile size would put the imported 2x2 on High: three 1080p mock encodes starting at
    // once, which can take longer than this suite waits. The editor suite covers that setting.
    settings: { startHidden: false, arrangeQuality: false },
  }, null, 2));

  const saveJs = `(() => {
    document.getElementById("btn-save-layout").click();
    const f = document.getElementById("layout-form");
    f.name.value = "Everything";
    f.requestSubmit();
    return true;
  })()`;
  const importJs = (lv = "lv1") => `(() => {
    const sel = document.getElementById("import-liveview");
    const options = [...sel.options].map((o) => o.textContent);
    sel.value = ${JSON.stringify(`${A}|`)} + ${JSON.stringify(lv)};
    sel.dispatchEvent(new Event("change"));
    return options;
  })()`;
  const unevenJs = `(() => {
    const seen = {
      template: document.getElementById("editor-template").value,
      cells: [...document.querySelectorAll("#editor-preview .cell")].map((c) => c.querySelector("b")?.textContent ?? null),
    };
    document.getElementById("editor-cancel").click();
    return seen;
  })()`;
  // The import opens the editor with the liveview filled in; save it as separate windows.
  const draftJs = `(async () => {
    const as = document.getElementById("editor-as");
    const seen = {
      saved: (await panes.invoke("mgr:state")).layouts.map((l) => l.name),
      open: document.getElementById("editor-dialog").open,
      title: document.getElementById("editor-title").textContent,
      as: as.value, locked: as.disabled,
      name: document.getElementById("editor-name").value,
      template: document.getElementById("editor-template").value,
      cells: [...document.querySelectorAll("#editor-preview .cell")].map((c) => c.querySelector("b")?.textContent ?? null),
    };
    as.value = "windows";
    as.dispatchEvent(new Event("change"));
    document.getElementById("editor-form").requestSubmit(document.getElementById("editor-save"));
    return seen;
  })()`;
  const applyJs = (name) => `(() => {
    const li = [...document.querySelectorAll("#layout-list li")].find((l) => l.querySelector("b")?.textContent === ${JSON.stringify(name)});
    const btn = li && [...li.querySelectorAll("button")].find((b) => b.textContent === "Apply");
    btn?.click();
    return !!btn;
  })()`;
  const { result, config } = await runApp({
    userData, results, seconds: 13, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2500, do: "manager-js", js: saveJs },
        { at: 3500, do: "manager-js", js: importJs() },
        { at: 4200, do: "manager-js", js: draftJs },
        { at: 5000, do: "manager-js", js: applyJs("Building · Entrances") },
        { at: 9500, do: "tray-click", label: "Everything" }, // a newly opened window can take ~3 s to go live
        { at: 11000, do: "manager-js", js: importJs("lv2") },
        { at: 11800, do: "manager-js", js: unevenJs },
      ]),
    },
  });
  const byJs = (needle) => result.actions.find((a) => a.act.js?.includes(needle));
  const applyAct = byJs("Building · Entrances");
  const trayAct = result.actions.find((a) => a.act.do === "tray-click");
  const first = result.samples[0]?.cams ?? {};
  const mid = result.samples.filter((s) => s.t > applyAct?.t && s.t < trayAct?.t).at(-1)?.cams ?? {};
  const end = last(result);
  const openSet = (cams) => Object.keys(cams).map((k) => Object.entries(keys).find(([, v]) => v === k)?.[0] ?? k).sort().join(",");
  const names = config.layouts?.map((l) => l.name) ?? [];

  check("Save current layout stored the on-screen windows", names.includes("Everything") && Object.keys(config.layouts.find((l) => l.name === "Everything").windows).length === 3, JSON.stringify(names));
  const offered = byJs("import-liveview");
  check("Protect liveviews offered for import, each camera counted once", offered?.value?.includes("Entrances (3 cameras)") && offered.value.includes("Big lobby (3 cameras)"),
    JSON.stringify(offered?.value ?? offered?.error));
  const uneven = result.actions.find((a) => a.act.js === unevenJs);
  check("a 6-slot liveview opens as 1 + 5, slots in order, a repeated camera only once",
    uneven?.value?.template === "1+5" && JSON.stringify(uneven.value.cells) === JSON.stringify(["Building Lobby", "Building Dock", null, "Building Stair", null, null]),
    JSON.stringify(uneven?.value ?? uneven?.error));
  const draft = result.actions.find((a) => a.act.js === draftJs)?.value;
  check("import opens the editor filled in: 2x2, slots in order, as a grid window, still changeable",
    draft?.open && draft.title === "Import a Protect liveview" && draft.as === "grid" && !draft.locked && draft.name === "Building · Entrances"
      && draft.template === "2x2" && JSON.stringify(draft.cells) === JSON.stringify(["Building Lobby", "Building Stair", null, "Building Dock"]),
    JSON.stringify(draft ?? result.actions.find((a) => a.act.js === draftJs)?.error));
  check("the draft saved as a layout of separate windows, and nothing before the editor's Save",
    names.includes("Building · Entrances") && !config.grids?.length && draft && !draft.saved.includes("Building · Entrances"),
    JSON.stringify({ names, before: draft?.saved, grids: config.grids?.length }));
  check("applying the liveview layout opened exactly its cameras", applyAct?.value === true && openSet(mid) === "dock,lobby,stair", `${openSet(mid)} ${applyAct?.error ?? ""}`);
  const [l, s, d] = [mid[keys.lobby]?.bounds, mid[keys.stair]?.bounds, mid[keys.dock]?.bounds];
  check("liveview slots tiled as a 2x2 grid (lobby, stair / empty, dock)",
    l && s && d && l.x < s.x && Math.abs(l.y - s.y) < 3 && d.y > l.y && Math.abs(d.x - s.x) < 3,
    JSON.stringify({ l, s, d }));
  check("liveview layout windows live", ["lobby", "stair", "dock"].every((n) => mid[keys[n]]?.status === "live"),
    JSON.stringify(["lobby", "stair", "dock"].map((n) => mid[keys[n]]?.status)));
  check("tray Layouts switched back: same windows at the same places",
    openSet(end) === "dock,lobby,ramp" && ["lobby", "dock", "ramp"].every((n) => samePlace(end[keys[n]]?.bounds, first[keys[n]]?.bounds) && end[keys[n]]?.status === "live"),
    `${openSet(end)} ${JSON.stringify(["lobby", "dock", "ramp"].map((n) => [end[keys[n]]?.bounds, first[keys[n]]?.bounds]))}`);
  check("window left out of the layout is closed in config", config.windows[keys.stair]?.open === false);
  console.log(`  results: ${results}`);
}

// ---------------------------------------------------------------------------------------------
// In-place updates: signed manifest, verified download, the folder-swap helper, and the camera
// list's Updates section. Uses a throwaway key; the app's real key must reject what it signs.

async function updateSuite() {
  console.log("\nUpdate suite (signatures, verified download, swap helper, camera list)");
  const { compareVersions, sourceKind, verifyManifest, Updater } = await import(new URL("../src/updater.js", import.meta.url).href);
  const { UPDATE_PUBLIC_KEY } = await import(new URL("../src/update-key.js", import.meta.url).href);
  const { signRelease } = await import(new URL("../scripts/sign-release.js", import.meta.url).href);
  const crypto = await import("node:crypto");
  const dir = tmpDir("update");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  const privFile = path.join(dir, "test-key.pem");
  const pubFile = path.join(dir, "test-key.pub.pem");
  fs.writeFileSync(privFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(pubFile, pubPem);

  // A release folder like build-win.js makes: zip with a top folder holding ProtectPanes.exe, and
  // optionally the gzip'd app.asar for copies on `electron`.
  const zlib = await import("node:zlib");
  const makeRelease = (name, files, version = "9.9.9", { asar = null, electron = "45.0.0" } = {}) => {
    const rel = path.join(dir, name);
    const app = path.join(rel, "build", "Protect Panes-win32-x64");
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true });
      fs.writeFileSync(path.join(app, f), body);
    }
    const zip = path.join(rel, "ProtectPanes-win32-x64.zip");
    spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${app}' -DestinationPath '${zip}'`]);
    let asarOpt = null;
    if (asar !== null) {
      const unpacked = path.join(rel, "build", "app.asar");
      fs.writeFileSync(unpacked, asar);
      const gz = path.join(rel, "ProtectPanes-app.asar.gz");
      fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(asar)));
      asarOpt = { gz, unpacked, electron };
    }
    signRelease({ zip, asar: asarOpt, version, keyFile: privFile });
    fs.rmSync(path.join(rel, "build"), { recursive: true, force: true });
    return rel;
  };
  const good = makeRelease("good", { "ProtectPanes.exe": "v2", "resources/app.asar": "v2" });
  const manifestText = fs.readFileSync(path.join(good, "latest.json"), "utf8");

  check("compareVersions orders numerically", compareVersions("1.10.0", "1.9.9") === 1 && compareVersions("1.2.0", "1.2.0") === 0 && compareVersions("1.2.0", "1.2.1") === -1);
  check("update locations: https and folders only",
    sourceKind("https://github.com/x/y/releases/latest/download") === "https" && sourceKind("\\\\server\\share\\pp") === "path" && sourceKind("C:\\Releases") === "path"
    && sourceKind("http://lan/pp") === null && sourceKind("file:///c:/x") === null && sourceKind("releases") === null);
  check("manifest signed by the release key verifies", verifyManifest(manifestText, pubPem).version === "9.9.9");
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check("the app's real key rejects a manifest signed by another key", throws(() => verifyManifest(manifestText, UPDATE_PUBLIC_KEY)));
  const doc = JSON.parse(manifestText);
  const signed = JSON.parse(Buffer.from(doc.payload, "base64").toString());
  const edited = { ...signed, sha256: "0".repeat(64) };
  check("an edited manifest fails its signature", throws(() => verifyManifest(JSON.stringify({ ...doc, payload: Buffer.from(JSON.stringify(edited)).toString("base64") }), pubPem)));
  check("an unsigned manifest is refused", throws(() => verifyManifest(JSON.stringify({ payload: doc.payload }), pubPem)));

  let stages = 0;
  const mk = (source, current = "1.2.0", extra = {}) => {
    const stageDir = path.join(dir, `stage-${stages++}`);
    return Object.assign(new Updater({ currentVersion: current, getSource: () => source, publicKey: pubPem, stageDir, ...extra }), { stageDir });
  };
  const zipsIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".zip") || f.endsWith(".part")) : []);
  const u1 = mk(good);
  await u1.check();
  const staged = u1.state.file && crypto.createHash("sha256").update(fs.readFileSync(u1.state.file)).digest("hex");
  check("newer signed release from a folder: downloaded and verified", u1.state.status === "ready" && staged === signed.sha256, JSON.stringify(u1.state));
  const same = mk(good, "9.9.9");
  await same.check();
  check("same version isn't offered", same.state.status === "current", JSON.stringify(same.state));

  // Tampered zip: the signed manifest is fine, the bytes aren't.
  const tampered = path.join(dir, "tampered");
  fs.cpSync(good, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, "ProtectPanes-win32-x64.zip"), "x");
  const u2 = mk(tampered);
  await u2.check();
  check("a zip that doesn't match the signed checksum is refused and not kept",
    u2.state.status === "error" && /checksum|larger/.test(u2.state.message) && !u2.state.file && zipsIn(u2.stageDir).length === 0,
    `${JSON.stringify(u2.state)} left: ${JSON.stringify(zipsIn(u2.stageDir))}`);

  // https path, through an injected fetch.
  const fakeFetch = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    const file = path.join(good, name);
    return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response("nope", { status: 404 });
  };
  const u3 = mk("https://releases.example.test/pp", "1.2.0", { fetch: fakeFetch });
  await u3.check();
  check("https release: manifest and zip fetched and verified", u3.state.status === "ready", JSON.stringify(u3.state));

  // A release that also carries an installer ("Setup.exe" here is a copy of node.exe, see below).
  const setupRel = path.join(dir, "with-installer");
  fs.cpSync(good, setupRel, { recursive: true });
  const fakeSetup = path.join(setupRel, "ProtectPanes-Setup.exe");
  fs.copyFileSync(process.execPath, fakeSetup);
  signRelease({ zip: path.join(setupRel, "ProtectPanes-win32-x64.zip"), installer: fakeSetup, version: "9.9.9", keyFile: privFile });

  if (process.platform === "win32") {
    // The swap helper, for real, on throwaway folders. noLaunch keeps it from starting the "exe".
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    // install() launches the helper fully detached (it must outlive the app), so wait on its log.
    // It runs from inside installDir, as the app does when started from Explorer or a shortcut.
    const runHelper = async (updater, installDir) => {
      const cwd = process.cwd();
      process.chdir(installDir);
      let log;
      try { ({ log } = updater.install({ installDir, exeName: "ProtectPanes.exe", pid: exited, noLaunch: true })); }
      finally { process.chdir(cwd); }
      const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
      for (let i = 0; i < 120 && !/update: done/.test(read()); i++) await new Promise((r) => setTimeout(r, 500));
      return read();
    };
    // "&" and "%" mean something to cmd.exe and "'" to PowerShell; the helper must not care.
    const installRoot = path.join(dir, "Tools & 100% O'Brien");
    const installDir = path.join(installRoot, "Protect Panes");
    fs.mkdirSync(path.join(installDir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "ProtectPanes.exe"), "v1");
    fs.writeFileSync(path.join(installDir, "resources", "app.asar"), "v1");
    const log1 = await runHelper(u1, installDir);
    check("swap helper replaced the install folder with the new version",
      fs.readFileSync(path.join(installDir, "ProtectPanes.exe"), "utf8") === "v2" && fs.readFileSync(path.join(installDir, "resources", "app.asar"), "utf8") === "v2" && /installed/.test(log1),
      log1.trim());
    check("swap helper cleaned up (no .old / .new folders left)", fs.readdirSync(installRoot).length === 1, JSON.stringify(fs.readdirSync(installRoot)));

    const broken = makeRelease("broken", { "NotTheApp.exe": "?" });
    const u4 = mk(broken);
    await u4.check();
    const log2 = await runHelper(u4, installDir);
    check("an update without ProtectPanes.exe is refused and the old version stays",
      u4.state.status === "ready" && fs.readFileSync(path.join(installDir, "ProtectPanes.exe"), "utf8") === "v2" && /update failed: the update has no/.test(log2) && fs.readdirSync(installRoot).length === 1,
      log2.trim());

    // Installer installs: the stand-in "Setup.exe" is a copy of node.exe that preloads fake-setup.js
    // (via NODE_OPTIONS, inherited down the helper's cmd -> PowerShell -> Start-Process chain), so
    // the real helper runs a real exe whose behaviour and exit code the test controls.
    const fakeJs = path.join(dir, "fake-setup.js");
    fs.writeFileSync(fakeJs, [
      "const fs = require('fs'), path = require('path');",
      "fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(1)));",
      "if (process.env.FAKE_EXIT === '0') fs.writeFileSync(path.join(process.env.FAKE_TARGET, 'ProtectPanes.exe'), 'v3-from-installer');",
      "process.exit(Number(process.env.FAKE_EXIT));",
    ].join("\n"));
    const runInstaller = async (updater, exitCode) => {
      const argsFile = path.join(dir, `fake-args-${exitCode}.json`);
      // Forward slashes: inside NODE_OPTIONS quotes, a backslash is an escape character.
      Object.assign(process.env, { NODE_OPTIONS: `--require "${fakeJs.replace(/\\/g, "/")}"`, FAKE_TARGET: installDir, FAKE_EXIT: String(exitCode), FAKE_ARGS: argsFile });
      try { return { log: await runHelper(updater, installDir), args: fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, "utf8")) : null }; }
      finally { for (const k of ["NODE_OPTIONS", "FAKE_TARGET", "FAKE_EXIT", "FAKE_ARGS"]) delete process.env[k]; }
    };
    const u5 = mk(setupRel, "1.2.0", { installKind: "installer" });
    await u5.check();
    check("installer install downloads and verifies Setup.exe, not the zip", u5.state.status === "ready" && u5.state.kind === "installer" && /Setup-9\.9\.9\.exe$/.test(u5.state.file ?? ""), JSON.stringify(u5.state));
    const ok = await runInstaller(u5, 0);
    // node resolves its first argument as a script path, so the stand-in sees "/S" as "<drive>:\S".
    const silentArgs = ok.args?.length === 2 && /^([a-z]:)?[\\/]S$/i.test(ok.args[0]) && ok.args[1] === "--updated";
    check("swap helper runs the installer silently (/S --updated) and it updates in place",
      silentArgs && fs.readFileSync(path.join(installDir, "ProtectPanes.exe"), "utf8") === "v3-from-installer" && /installer finished/.test(ok.log) && fs.readdirSync(installRoot).length === 1,
      `${JSON.stringify(ok.args)} ${ok.log.trim()}`);
    const u6 = mk(setupRel, "1.2.0", { installKind: "installer" });
    await u6.check();
    const bad = await runInstaller(u6, 3);
    check("a failing installer is reported, and the helper still relaunches what's there",
      /update failed: the installer exited with code 3/.test(bad.log) && /update: done/.test(bad.log) && fs.readFileSync(path.join(installDir, "ProtectPanes.exe"), "utf8") === "v3-from-installer",
      bad.log.trim());

    // Small update: only resources\app.asar changes; the exe and everything else stay.
    const asarBody = "v4 app.asar ".repeat(2000);
    const asarRel = makeRelease("with-asar", { "ProtectPanes.exe": "v4", "resources/app.asar": asarBody }, "9.9.9", { asar: asarBody });
    const u7 = mk(asarRel, "1.2.0", { electronVersion: "45.0.0" });
    await u7.check();
    const log7 = await runHelper(u7, installDir);
    const res = path.join(installDir, "resources");
    check("the helper swaps in the new app.asar and leaves the rest of the folder alone",
      fs.readFileSync(path.join(res, "app.asar"), "utf8") === asarBody && fs.readFileSync(path.join(installDir, "ProtectPanes.exe"), "utf8") === "v3-from-installer"
        && /installed app\.asar/.test(log7) && JSON.stringify(fs.readdirSync(res)) === '["app.asar"]' && !fs.existsSync(u7.state.file),
      `${log7.trim()} resources=${JSON.stringify(fs.readdirSync(res))}`);

    // Signed, and the .gz matches, but what it unpacks to doesn't match the signed unpacked hash.
    const relSigned = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(path.join(asarRel, "latest.json"), "utf8")).payload, "base64"));
    const badAsar = path.join(dir, "bad-asar");
    fs.cpSync(asarRel, badAsar, { recursive: true });
    const badPayload = Buffer.from(JSON.stringify({ ...relSigned, version: "9.9.10", asar: { ...relSigned.asar, unpacked: { ...relSigned.asar.unpacked, sha256: "0".repeat(64) } } }));
    fs.writeFileSync(path.join(badAsar, "latest.json"), JSON.stringify({ payload: badPayload.toString("base64"), signature: crypto.sign(null, badPayload, privateKey).toString("base64") }));
    fs.writeFileSync(path.join(res, "app.asar"), "v5 keep me");
    const u8 = mk(badAsar, "1.2.0", { electronVersion: "45.0.0" });
    await u8.check();
    const log8 = await runHelper(u8, installDir);
    check("an app.asar that unpacks to the wrong checksum is refused and the old one stays",
      u8.state.kind === "asar" && /doesn't match its signed checksum/.test(log8) && fs.readFileSync(path.join(res, "app.asar"), "utf8") === "v5 keep me"
        && JSON.stringify(fs.readdirSync(res)) === '["app.asar"]',
      `${log8.trim()} resources=${JSON.stringify(fs.readdirSync(res))}`);

    // Signed and intact, but not gzip at all: unpacking itself throws, part-way through.
    const junkAsar = path.join(dir, "junk-asar");
    fs.cpSync(asarRel, junkAsar, { recursive: true });
    fs.writeFileSync(path.join(junkAsar, "ProtectPanes-app.asar.gz"), crypto.randomBytes(4096));
    const junkUnpacked = path.join(dir, "junk-unpacked.bin");
    fs.writeFileSync(junkUnpacked, "never produced");
    signRelease({ zip: path.join(junkAsar, "ProtectPanes-win32-x64.zip"), asar: { gz: path.join(junkAsar, "ProtectPanes-app.asar.gz"), unpacked: junkUnpacked, electron: "45.0.0" }, version: "9.9.11", keyFile: privFile });
    const u9 = mk(junkAsar, "1.2.0", { electronVersion: "45.0.0" });
    await u9.check();
    const log9 = await runHelper(u9, installDir);
    check("a download that won't unpack is reported, and leaves nothing half-made next to the app",
      u9.state.kind === "asar" && /update failed/.test(log9) && /update: done/.test(log9) && fs.readFileSync(path.join(res, "app.asar"), "utf8") === "v5 keep me"
        && JSON.stringify(fs.readdirSync(res)) === '["app.asar"]',
      `${log9.trim()} resources=${JSON.stringify(fs.readdirSync(res))}`);
  }

  {
    const asarRel = path.join(dir, "with-asar");
    if (!fs.existsSync(asarRel)) makeRelease("with-asar", { "ProtectPanes.exe": "v4" }, "9.9.9", { asar: "v4" });
    const gzSize = fs.statSync(path.join(asarRel, "ProtectPanes-app.asar.gz")).size;
    const same = mk(asarRel, "1.2.0", { electronVersion: "45.0.0" });
    await same.check();
    check("same Electron: the update is just the gzip'd app.asar",
      same.state.status === "ready" && same.state.kind === "asar" && same.state.file?.endsWith("-app.asar.gz") && fs.statSync(same.state.file).size === gzSize,
      JSON.stringify(same.state));
    const installed = mk(asarRel, "1.2.0", { electronVersion: "45.0.0", installKind: "installer" });
    await installed.check();
    check("installed copies on the same Electron take the small update too", installed.state.kind === "asar", JSON.stringify(installed.state));
    const older = mk(asarRel, "1.2.0", { electronVersion: "44.1.0" });
    await older.check();
    check("a different Electron gets the full zip", older.state.kind === "folder" && /\.zip$/.test(older.state.file ?? ""), JSON.stringify(older.state));
  }

  const folderCopy = mk(setupRel);
  await folderCopy.check();
  check("folder install still updates from the zip when the release also has an installer", folderCopy.state.kind === "folder" && /\.zip$/.test(folderCopy.state.file ?? ""), JSON.stringify(folderCopy.state));
  const noSetup = mk(good, "1.2.0", { installKind: "installer" });
  await noSetup.check();
  check("installer install refuses a release without an installer", noSetup.state.status === "error" && /no installer/.test(noSetup.state.message), JSON.stringify(noSetup.state));
  const sneaky = { ...signed, installer: { file: "..\\evil.exe", size: 1, sha256: "0".repeat(64) } };
  const sneakyPayload = Buffer.from(JSON.stringify(sneaky));
  const sneakyDoc = JSON.stringify({ payload: sneakyPayload.toString("base64"), signature: crypto.sign(null, sneakyPayload, privateKey).toString("base64") });
  check("a signed manifest whose installer name is a path is still refused", throws(() => verifyManifest(sneakyDoc, pubPem)));

  // In the app: the camera list's Updates section, with the test key swapped in (dev builds only).
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const launch = async (label, env, actions) => {
    const userData = tmpDir(`update-app-${label}`);
    fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
      version: 1,
      consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby"] }],
      windows: {},
      settings: { startHidden: false, updateSource: good },
    }, null, 2));
    const run = await runApp({ userData, results: path.join(userData, "results"), seconds: 8, extraArgs: ["--mock"], env: { ...env, PANES_SELFTEST_ACTIONS: JSON.stringify(actions) } });
    return { ...run, userData };
  };
  const read = `(() => ({ status: document.getElementById("update-status").textContent, check: document.getElementById("btn-check-update").textContent, install: document.getElementById("btn-install-update").classList.contains("hidden") ? null : document.getElementById("btn-install-update").textContent }))()`;
  const app1 = await launch("testkey", { PANES_UPDATE_PUBKEY_FILE: pubFile }, [
    { at: 2500, do: "manager-js", js: read },
    { at: 3000, do: "manager-js", js: `document.getElementById("btn-check-update").click(), true` },
    { at: 6000, do: "manager-js", js: read },
    { at: 6500, do: "manager-js", js: `panes.invoke("mgr:install-update").then(() => "installed?!", (e) => String(e.message))` },
    { at: 7000, do: "manager-js", js: `document.querySelector('[data-tab="settings"]').click(), document.querySelector(".updates").scrollIntoView(), true` }, // for the screenshot
  ]);
  const [startup, , afterCheck, installTry] = app1.result.actions.map((a) => a.value ?? a.error);
  check("startup check finds the update without downloading it", /9\.9\.9 is available/.test(startup?.status) && startup?.check === "Download 9.9.9", JSON.stringify(startup));
  check("Check for updates downloads, verifies and offers Install", /ready to install/.test(afterCheck?.status) && afterCheck?.install === "Install 9.9.9 and restart"
    && fs.readdirSync(path.join(app1.userData, "updates")).some((f) => f === "ProtectPanes-9.9.9.zip"), JSON.stringify(afterCheck));
  check("running from source refuses to install", /packaged app/.test(String(installTry)), String(installTry));

  const app2 = await launch("realkey", {}, [{ at: 2500, do: "manager-js", js: read }]);
  const real = app2.result.actions[0]?.value;
  check("with its real key the app refuses a release signed by another key", /signature doesn't match/.test(real?.status) && !fs.existsSync(path.join(app2.userData, "updates", "ProtectPanes-9.9.9.zip")), JSON.stringify(real));
  console.log(`  results: ${dir}`);
}

// ---------------------------------------------------------------------------------------------
// Arrange: the grid templates (unit) and tiling real windows (mock app), plus Close all.

async function arrangeSuite() {
  console.log("\nArrange suite (layout geometry + tiling real windows)");
  const g = await import(new URL("../src/grid.js", import.meta.url).href);
  const counts = Object.fromEntries(g.TEMPLATES.filter((t) => t.cells).map((t) => [t.id, t.cells.length]));
  check("templates have the advertised number of tiles",
    JSON.stringify(counts) === JSON.stringify({ 1: 1, "2x2": 4, "1+5": 6, "1+7": 8, "3x3": 9, "2+8": 10, "1+12": 13, "4x4": 16, "5x5": 25 }), JSON.stringify(counts));
  const coverage = g.TEMPLATES.filter((t) => t.cells).map((t) => {
    const hit = Array.from({ length: t.rows }, () => Array(t.cols).fill(0));
    for (const [c, r, cs = 1, rs = 1] of t.cells) for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) hit[y][x]++;
    return [t.id, hit.flat().every((n) => n === 1)];
  });
  check("every template covers its grid exactly once (no gaps, no overlaps)", coverage.every(([, ok]) => ok), JSON.stringify(coverage.filter(([, ok]) => !ok)));
  check("the big tile comes first", ["1+5", "1+7", "1+12"].every((id) => g.templateById(id).cells[0][2] > 1));
  const shape = (n, w, h) => { const a = g.autoGrid(n, { x: 0, y: 0, width: w, height: h }); return `${a.cols}x${a.rows}`; };
  const auto = { "4@16:9": shape(4, 1920, 1040), "6@16:9": shape(6, 1920, 1040), "6@21:9": shape(6, 3440, 1400), "4@portrait": shape(4, 1080, 1860), "2@16:9": shape(2, 1920, 1040) };
  check("Auto follows the screen's shape (16:9, ultrawide, portrait)",
    auto["4@16:9"] === "2x2" && auto["6@16:9"] === "3x2" && auto["6@21:9"] === "3x2" && auto["4@portrait"] === "1x4" && auto["2@16:9"] === "2x1", JSON.stringify(auto));
  const fit = g.fitAspect({ x: 0, y: 0, width: 400, height: 400 }, 16 / 9);
  check("cameras keep their shape inside a cell (centered)", fit.width === 400 && fit.height === 225 && fit.y === 87 && fit.x === 0, JSON.stringify(fit));
  check("quality follows tile size", g.channelForTile(640) === 2 && g.channelForTile(1280) === 1 && g.channelForTile(1920) === 0);

  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, stair: `${A}/aaaaaaaa-cam2`, parking: `${A}/aaaaaaaa-cam3`, ramp: `${B}/bbbbbbbb-cam0` };
  const at = (x, y) => ({ open: true, bounds: { x, y, width: 400, height: 225 }, channel: 2 });
  const userData = tmpDir("arrange");
  const results = path.join(userData, "results");
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair", "Parking"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    // Scattered on purpose; reading order by window centers is dock, stair, ramp, parking, lobby.
    windows: { [keys.lobby]: at(600, 400), [keys.dock]: at(50, 50), [keys.stair]: at(400, 50), [keys.parking]: at(50, 400), [keys.ramp]: at(700, 100) },
    settings: { startHidden: false },
  }, null, 2));
  const arrangeJs = (id) => `panes.invoke("mgr:arrange", { templateId: ${JSON.stringify(id)} })`;
  const { result, config } = await runApp({
    userData, results, seconds: 15, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 3000, do: "manager-js", js: arrangeJs("auto") },
        { at: 5500, do: "manager-js", js: `(() => { document.querySelector('[data-tab="layouts"]').click(); const b = document.querySelector('[data-template="1+5"]'); b?.click(); return !!b; })()` },
        { at: 8000, do: "manager-js", js: arrangeJs("2x2") },
        { at: 11500, do: "manager-js", js: `(() => { window.confirm = () => true; const card = [...document.querySelectorAll("article.panel")].find((a) => a.querySelector(".console-head b")?.textContent === "Garage"); const b = [...card.querySelectorAll("button")].find((x) => x.textContent === "Close all"); b?.click(); return !!b; })()` },
      ]),
    },
  });
  const acts = result.actions;
  // The first sample after a step: "last before the next step" can race with that step's effect.
  const sampleAfter = (i) => result.samples.find((s) => s.t > (acts[i]?.t ?? Infinity))?.cams ?? {};
  const order = ["dock", "stair", "ramp", "parking", "lobby"];
  const rects = (cams) => order.map((n) => cams[keys[n]]?.bounds);
  const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  // The screen the tiles landed on (the camera list's), found from the first tile's center.
  const displayOf = (r) => r && result.displays?.find(({ workArea: w }) => r.x + r.width / 2 >= w.x && r.x + r.width / 2 < w.x + w.width && r.y + r.height / 2 >= w.y && r.y + r.height / 2 < w.y + w.height);
  const afterAuto = rects(sampleAfter(0));
  const display = displayOf(afterAuto[0]);
  const area = display?.workArea;
  check("Auto arranged all five", JSON.stringify(acts[0]?.value) === JSON.stringify({ arranged: 5, left: 0 }), JSON.stringify(acts[0]?.value ?? acts[0]?.error));
  check("Auto tiles sit inside the screen without overlapping",
    afterAuto.every(Boolean) && area && afterAuto.every((r) => r.x >= area.x - 1 && r.y >= area.y - 1 && r.x + r.width <= area.x + area.width + 1 && r.y + r.height <= area.y + area.height + 1)
      && afterAuto.every((a, i) => afterAuto.every((b, j) => i === j || !overlap(a, b))),
    JSON.stringify({ area, afterAuto }));
  check("Auto keeps reading order (first camera top-left) and equal tile sizes",
    afterAuto.every(Boolean) && afterAuto[0].x <= Math.min(...afterAuto.map((r) => r.x)) && afterAuto[0].y <= Math.min(...afterAuto.map((r) => r.y))
      && Math.max(...afterAuto.map((r) => r.width)) - Math.min(...afterAuto.map((r) => r.width)) <= 2,
    JSON.stringify(afterAuto));
  const afterBig = rects(sampleAfter(1));
  check("clicking the 1 + 5 thumbnail made the first camera the big tile",
    acts[1]?.value === true && afterBig.every(Boolean) && afterBig[0].width > 1.7 * Math.max(...afterBig.slice(1).map((r) => r.width)),
    JSON.stringify(afterBig.map((r) => r && `${r.width}x${r.height}`)));
  check("2 x 2 with five windows arranges four and leaves one", JSON.stringify(acts[2]?.value) === JSON.stringify({ arranged: 4, left: 1 }), JSON.stringify(acts[2]?.value ?? acts[2]?.error));
  const scale = display?.scaleFactor ?? 1;
  const afterSquare = sampleAfter(2);
  const sq = rects(afterSquare);
  check("re-arranging after 1 + 5 keeps the big top-left camera first",
    sq[0] && sq.slice(1, 4).every((r) => r && (r.y > sq[0].y + 2 || (Math.abs(r.y - sq[0].y) <= 2 && r.x > sq[0].x))),
    JSON.stringify(sq.slice(0, 4)));
  const ro = g.readingOrder([{ n: "big", b: { x: 0, y: 0, width: 1078, height: 607 } }, { n: "small", b: { x: 1600, y: 0, width: 538, height: 303 } }, { n: "below", b: { x: 1600, y: 305, width: 538, height: 303 } }], (i) => i.b).map((i) => i.n);
  check("reading order goes by top edges (a big tile beside small ones stays first)", ro.join() === "big,small,below", ro.join());
  const quality = order.slice(0, 4).map((n) => [n, config.windows[keys[n]]?.channel, g.channelForTile((afterSquare[keys[n]]?.bounds?.width ?? 0) * scale)]);
  check("Match quality to tile size set each arranged camera's stream from its tile", quality.every(([, saved, want]) => saved === want), JSON.stringify(quality));
  const end = last(result);
  check("Close all closed only Garage's windows",
    acts[3]?.value === true && !end[keys.ramp] && config.windows[keys.ramp]?.open === false && order.slice(0, 2).every((n) => end[keys[n]]),
    `${acts[3]?.error ?? ""} open=${Object.keys(end).length} ramp=${config.windows[keys.ramp]?.open}`);
  console.log(`  results: ${results}`);
}

// ---------------------------------------------------------------------------------------------
// Layout editor: drag cameras into a template's tiles (synthetic DnD events on the real dialog),
// pick a 360° view per tile, save and apply, reopen with Edit, fill from what's on screen.

async function editorSuite() {
  console.log("\nLayout editor suite (mock consoles + a 360 camera)");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, fish: `${A}/aaaaaaaa-cam360`, ramp: `${B}/bbbbbbbb-cam0` };
  const userData = tmpDir("editor");
  const results = path.join(userData, "results");
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"], mockFisheye: false },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
    },
    settings: { startHidden: false },
  }, null, 2));
  const helpers = `
    const drop = (i, key) => { const dt = new DataTransfer(); dt.setData("text/x-protect-panes-camera", key);
      document.querySelector('[data-cell="' + i + '"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); };
    const cells = () => [...document.querySelectorAll("#editor-preview .cell")].map((c) => c.querySelector("b")?.textContent ?? null);`;
  const build = `(() => { ${helpers}
    document.querySelector('[data-tab="layouts"]').click();
    document.getElementById("btn-new-layout").click();
    document.getElementById("editor-name").value = "Wall";
    const t = document.getElementById("editor-template"); t.value = "1+5"; t.dispatchEvent(new Event("change"));
    drop(0, ${JSON.stringify(keys.fish)});
    const v = document.querySelector('[data-cell="0"] select'); v.value = "panorama"; v.dispatchEvent(new Event("change"));
    drop(3, ${JSON.stringify(keys.ramp)});
    drop(5, ${JSON.stringify(keys.ramp)}); // dropping a placed camera again moves it
    return cells(); })()`;
  const apply = `(() => { document.getElementById("editor-form").requestSubmit(document.getElementById("editor-apply")); return true; })()`;
  const reopen = `(() => { ${helpers}
    const li = [...document.querySelectorAll("#layout-list li")].find((l) => l.querySelector("b")?.textContent === "Wall");
    [...li.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
    const out = { template: document.getElementById("editor-template").value, cells: cells(), view: document.querySelector('[data-cell="0"] select')?.value };
    document.getElementById("editor-cancel").click();
    return out; })()`;
  const fill = `(() => { ${helpers}
    document.getElementById("btn-new-layout").click();
    document.getElementById("editor-fill").click();
    const out = { cells: cells().filter(Boolean), view: document.querySelector('[data-cell="0"] select')?.value };
    document.getElementById("editor-cancel").click();
    return out; })()`;
  // Camera pictures in the editor: a thumbnail per camera in the list, and each filled tile's
  // whole picture (contain) behind its name.
  const pictures = `(async () => {
    const li = [...document.querySelectorAll("#layout-list li")].find((l) => l.querySelector("b")?.textContent === "Wall");
    [...li.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
    const pics = () => [...document.querySelectorAll("#editor-preview .cell .cell-pic")];
    const ready = () => pics().length && pics().every((p) => p.querySelector("img")?.naturalWidth) && document.querySelectorAll("#editor-cameras li.cam .thumb img").length >= 3;
    for (let i = 0; i < 25 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
    const size = (r) => Math.round(r.width) + "x" + Math.round(r.height);
    const out = {
      listCams: document.querySelectorAll("#editor-cameras li.cam").length,
      listThumbs: document.querySelectorAll("#editor-cameras li.cam .thumb").length,
      listImgs: document.querySelectorAll("#editor-cameras li.cam .thumb img").length,
      tiles: pics().map((p) => {
        const img = p.querySelector("img");
        const cell = p.parentElement.getBoundingClientRect();
        const pic = p.getBoundingClientRect();
        return img ? { name: p.parentElement.querySelector("b")?.textContent, natural: img.naturalWidth + "x" + img.naturalHeight, img: size(img.getBoundingClientRect()), pic: size(pic),
          fillsTile: Math.abs(pic.width - cell.width) <= 2 && Math.abs(pic.height - cell.height) <= 2, fit: getComputedStyle(img).objectFit } : null;
      }),
      emptyPics: document.querySelectorAll("#editor-preview .cell:not(.filled) .cell-pic").length,
    };
    document.getElementById("editor-cancel").click();
    return out; })()`;
  const { result, config } = await runApp({
    userData, results, seconds: 13, extraArgs: ["--mock"],
    env: {
      PANES_MOCK_FISHEYE: path.join(FIXTURES, "fisheye-ceiling.png"),
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 3000, do: "manager-js", js: build },
        { at: 3600, do: "manager-js", js: apply },
        { at: 9000, do: "manager-js", js: reopen },
        { at: 9600, do: "manager-js", js: fill },
        { at: 10200, do: "manager-js", js: pictures },
      ]),
    },
  });
  const [built, applied, reopened, filled] = result.actions.filter((a) => a.act.js !== pictures).map((a) => a.value ?? { error: a.error });
  const pics = result.actions.find((a) => a.act.js === pictures);
  const pv = pics?.value;
  check("the layout editor shows a preview for every camera in its list",
    pv && pv.listCams > 0 && pv.listThumbs === pv.listCams && pv.listImgs >= 3, JSON.stringify(pv ?? pics?.error));
  check("each filled tile shows its camera's whole picture (the 360° one uncut), empty tiles none",
    pv?.tiles?.length === 2 && pv.tiles.every((t) => t && t.fillsTile && t.img === t.pic && t.fit === "contain") && pv.tiles.some((t) => t.natural.split("x")[0] === t.natural.split("x")[1]) && pv.emptyPics === 0,
    JSON.stringify(pv?.tiles ?? pics?.error));
  const layout = config.layouts?.find((l) => l.name === "Wall");
  check("dragging cameras into tiles places them (and re-dropping moves one)",
    JSON.stringify(built) === JSON.stringify(["Building 360", null, null, null, null, "Garage Ramp"]), JSON.stringify(built));
  check("Save and apply stored the layout with its editor settings",
    applied === true && layout && Object.keys(layout.windows).sort().join() === [keys.fish, keys.ramp].sort().join() && layout.editor?.templateId === "1+5",
    JSON.stringify(layout?.editor ?? layout ?? applied));
  check("the 360° tile kept its chosen view (Panorama)", layout?.windows[keys.fish]?.dewarp?.mode === "panorama", JSON.stringify(layout?.windows[keys.fish]?.dewarp?.mode));
  const end = last(result);
  const big = end[keys.fish]?.bounds;
  const small = end[keys.ramp]?.bounds;
  check("applying opened exactly the layout's cameras, the first tile big",
    Object.keys(end).sort().join() === [keys.fish, keys.ramp].sort().join() && big && small && big.width > 1.7 * small.width && big.x < small.x,
    JSON.stringify({ open: Object.keys(end), big, small }));
  check("the 360 window shows Panorama after apply", end[keys.fish]?.dewarp?.mode === "panorama" && end[keys.fish]?.status === "live", JSON.stringify(end[keys.fish]?.dewarp));
  check("Edit reopens the editor with the saved grid, tiles and view",
    reopened?.template === "1+5" && reopened?.cells?.[0] === "Building 360" && reopened?.cells?.[5] === "Garage Ramp" && reopened?.view === "panorama", JSON.stringify(reopened));
  check("Use what's on screen fills tiles with the open windows in reading order", JSON.stringify(filled?.cells) === JSON.stringify(["Building 360", "Garage Ramp"]), JSON.stringify(filled));
  check("Use what's on screen keeps a 360° window's current view (Panorama), not Quad", filled?.view === "panorama", JSON.stringify(filled));
  console.log(`  results: ${results}`);
}

// ---------------------------------------------------------------------------------------------
// Grid windows: several cameras in one window's tiles, built in the layout editor.

async function gridSuite() {
  console.log("\nGrid window suite (mock consoles + a 360 camera, two launches)");
  const g = await import(new URL("../src/grid.js", import.meta.url).href);
  const userData = tmpDir("grid");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, fish: `${A}/aaaaaaaa-cam360`, ramp: `${B}/bbbbbbbb-cam0` };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"], mockFisheye: false },
    ],
    windows: { [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 } },
    settings: { startHidden: false },
  }, null, 2));
  const env = { PANES_MOCK_FISHEYE: path.join(FIXTURES, "fisheye-ceiling.png") };

  const build = `(() => {
    const drop = (i, key) => { const dt = new DataTransfer(); dt.setData("text/x-protect-panes-camera", key);
      document.querySelector('[data-cell="' + i + '"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); };
    document.querySelector('[data-tab="layouts"]').click();
    document.getElementById("btn-new-layout").click();
    document.getElementById("editor-name").value = "Wall";
    const as = document.getElementById("editor-as"); as.value = "grid"; as.dispatchEvent(new Event("change"));
    const t = document.getElementById("editor-template"); t.value = "2x2"; t.dispatchEvent(new Event("change"));
    drop(0, ${JSON.stringify(keys.fish)});
    const v = document.querySelector('[data-cell="0"] select'); v.value = "panorama"; v.dispatchEvent(new Event("change"));
    drop(1, ${JSON.stringify(keys.ramp)});
    drop(3, ${JSON.stringify(keys.dock)});
    const apply = document.getElementById("editor-apply").textContent;
    document.getElementById("editor-form").requestSubmit(document.getElementById("editor-apply"));
    return apply;
  })()`;
  // Save the open grid again from the editor, as it is but with tile 0's 360° view switched to Quad.
  const resaveWall = `(async () => {
    const g = (await panes.invoke("mgr:state")).grids.find((x) => x.name === "Wall");
    const cells = g.editor.cells.map((c, i) => (c && i === 0 ? { ...c, mode: "quad" } : c));
    await panes.invoke("mgr:save-editor-layout", { id: g.id, as: "grid", name: "Wall", displayId: g.editor.displayId, templateId: g.editor.templateId, cells, apply: false });
    return true;
  })()`;
  const readRow = `(() => {
    const li = [...document.querySelectorAll("#layout-list li.grid-row")].find((l) => l.querySelector("b")?.textContent === "Wall");
    return li ? { text: li.querySelector("small").textContent, buttons: [...li.querySelectorAll("button")].map((b) => b.textContent) } : null;
  })()`;
  // The camera list says which cameras play in a grid (they read as closed before).
  const rowText = `(() => Object.fromEntries([...document.querySelectorAll(".cams li")].map((li) => [li.querySelector(".cam-name b")?.textContent,
    { status: li.querySelector(".cam-name small")?.textContent, tip: li.querySelector(".switch")?.dataset.tip }])))()`;
  // The 360° camera's snapshot is square. Its <img> has to be the thumbnail's size (contain letterboxes
  // it); it used to take its own square shape and the 36 px box cut it off.
  const squareThumb = `(async () => {
    document.querySelector('[data-tab="cameras"]').click();
    const row = () => [...document.querySelectorAll(".cams li")].find((li) => li.querySelector(".cam-name b")?.textContent === "Building 360");
    for (let i = 0; i < 30 && !row()?.querySelector(".thumb img")?.naturalWidth; i++) await new Promise((r) => setTimeout(r, 100));
    const img = row()?.querySelector(".thumb img");
    const size = (r) => Math.round(r.width) + "x" + Math.round(r.height);
    const out = img && { natural: img.naturalWidth + "x" + img.naturalHeight, img: size(img.getBoundingClientRect()), box: size(img.parentElement.getBoundingClientRect()), fit: getComputedStyle(img).objectFit };
    document.querySelector('[data-tab="layouts"]').click();
    return out ?? null;
  })()`;
  const run1 = await runApp({
    userData, results: path.join(userData, "results-1"), seconds: 19, extraArgs: ["--mock"],
    env: {
      ...env,
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2500, do: "manager-js", js: build },
        { at: 7000, do: "manager-js", js: readRow },
        { at: 7200, do: "camera-js", tile: "Wall#1", js: `getComputedStyle(document.getElementById("bar")).display` },
        { at: 7300, do: "menu", tile: "Wall#0" },
        { at: 7500, do: "menu-click", tile: "Wall#1", label: "Low · 640×360" },
        { at: 8000, do: "manager-js", js: rowText },
        { at: 8200, do: "manager-js", js: squareThumb },
        { at: 9500, do: "tray-click", label: "Hide cameras" },
        { at: 10300, do: "manager-js", js: `/*hidden*/ ${readRow}` },
        { at: 11000, do: "tray-click", label: "Show cameras" },
      ]),
    },
  });
  const acts = run1.result.actions;
  const sq = acts.find((a) => a.act.js === squareThumb);
  check("a 360° camera's square preview fits whole in its row thumbnail (not cut to the 16:9 box)",
    sq?.value && sq.value.natural.split("x")[0] === sq.value.natural.split("x")[1] && sq.value.img === sq.value.box && sq.value.fit === "contain",
    JSON.stringify(sq?.value ?? sq?.error));
  const rows = acts.find((a) => a.act.js === rowText)?.value ?? {};
  check("the camera list says which cameras are showing in a grid, and that a window would be a second stream",
    /in grid Wall/.test(rows["Building Dock"]?.status ?? "") && /second stream/.test(rows["Building Dock"]?.tip ?? "") && !/in grid/.test(rows["Building Lobby"]?.status ?? ""),
    JSON.stringify({ dock: rows["Building Dock"], lobby: rows["Building Lobby"] }));
  const [applyLabel, row, barDisplay] = acts.map((a) => a.value ?? a.error);
  const grid = run1.config.grids?.[0];
  check("the layout editor's Open as: One grid window saves a grid (Save and open)",
    applyLabel === "Save and open" && grid?.name === "Wall" && grid.templateId === "2x2" && grid.open === true
      && JSON.stringify(grid.tiles.map((t) => t?.key ?? null)) === JSON.stringify([keys.fish, keys.ramp, null, keys.dock]) && grid.tiles[0].dewarp?.mode === "panorama",
    JSON.stringify({ applyLabel, grid }));
  // The tiles were hidden and shown again at 9.5 and 11 s (test time) and can take ~3 s to be live
  // again on a busy PC; the run ends at 19 s. 15 frames (1 s) is enough to show they decode.
  const end = last(run1.result);
  const tile = (cams, i) => cams[`grid:Wall#${i}`];
  check("every filled tile is live in the one grid window", [0, 1, 3].every((i) => tile(end, i)?.status === "live" && tile(end, i).decodedFrames >= 15) && !tile(end, 2),
    JSON.stringify([0, 1, 2, 3].map((i) => tile(end, i) && `${tile(end, i).status}/${tile(end, i).decodedFrames}`)));
  check("the 360° tile shows its own view (Panorama)", tile(end, 0)?.dewarp?.active && tile(end, 0).dewarp.mode === "panorama", JSON.stringify(tile(end, 0)?.dewarp));
  const [b0, b1, b3] = [0, 1, 3].map((i) => tile(end, i)?.bounds);
  check("tiles sit in a 2 × 2 grid inside the window",
    b0 && b1 && b3 && b0.x <= 2 && b0.y <= 2 && Math.abs(b1.x - (b0.x + b0.width)) <= 4 && Math.abs(b3.y - (b0.y + b0.height)) <= 4 && Math.abs(b0.width - b1.width) <= 2,
    JSON.stringify({ b0, b1, b3 }));
  check("a tile has no window bar of its own", barDisplay === "none", String(barDisplay));
  const tileMenu = acts.find((a) => a.act.do === "menu")?.menu ?? [];
  const tileViews = tileMenu.find((i) => typeof i === "object" && i["360° view"])?.["360° view"] ?? [];
  check("a 360° tile's menu has its views but no aspect ratio (the grid sets its shape)",
    tileViews.includes("[x] Panorama") && !tileViews.some((i) => typeof i === "object" && i["Aspect ratio"]), JSON.stringify(tileViews));
  check("the floating camera window is left alone", end[keys.lobby]?.visible && end[keys.lobby].status === "live", JSON.stringify(end[keys.lobby] && { v: end[keys.lobby].visible, s: end[keys.lobby].status }));
  check("the Layouts tab lists it as an open grid window", row?.text === "grid window · 3 cameras" && row.buttons?.[0] === "Close", JSON.stringify(row));
  const scale = run1.result.displays[0]?.scaleFactor ?? 1;
  check("a tile's quality menu pins it (Low), the others follow their tile size",
    acts.find((a) => a.act.label === "Low · 640×360")?.ok && tile(end, 1)?.videoWidth === 640 && grid?.tiles[1].channel === 2
      && tile(end, 3)?.channel === g.channelForTile(b3.width * scale) && grid.tiles[3].channel === undefined,
    JSON.stringify({ ramp: tile(end, 1)?.videoWidth, dock: tile(end, 3)?.channel, want: b3 && g.channelForTile(b3.width * scale) }));
  const hideAt = acts.find((a) => a.act.label === "Hide cameras")?.t;
  const showAt = acts.find((a) => a.act.label === "Show cameras")?.t;
  const hidden = run1.result.samples.filter((s) => s.t > hideAt && s.t < showAt).at(-1)?.cams ?? {};
  const hiddenRow = acts.find((a) => a.act.js?.startsWith("/*hidden*/"))?.value;
  check("a hidden grid's row offers Show, not just Close", /hidden/.test(hiddenRow?.text ?? "") && hiddenRow.buttons.includes("Show") && !hiddenRow.buttons.includes("Close"),
    JSON.stringify(hiddenRow));
  check("Hide cameras hides the grid window and pauses its tiles", [0, 1, 3].every((i) => tile(hidden, i)?.visible === false && tile(hidden, i).status === "paused"),
    JSON.stringify([0, 1, 3].map((i) => tile(hidden, i) && `${tile(hidden, i).visible}/${tile(hidden, i).status}`)));
  check("Show cameras brings it back live", [0, 1, 3].every((i) => tile(end, i)?.visible === true), JSON.stringify([0, 1, 3].map((i) => tile(end, i)?.visible)));

  // Second launch: it reopens by itself. Fill the empty tile from its menu, switch to 1 + 5 from a
  // tile's menu (the tiles must survive it: same page, same stream), then close it from the menu.
  const run2 = await runApp({
    userData, results: path.join(userData, "results-2"), seconds: 11, extraArgs: ["--mock"],
    env: {
      ...env,
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2800, do: "camera-js", tile: "Wall#0", js: "window.__marker = 42" },
        { at: 3000, do: "grid-menu-click", grid: "Wall", index: 2, label: "Building Lobby" },
        { at: 4000, do: "menu-click", tile: "Wall#0", label: "1 + 5" },
        { at: 6500, do: "camera-js", tile: "Wall#0", js: "window.__marker ?? null" },
        { at: 6600, do: "camera-js", tile: "Wall#1", js: "window.__marker = 43" },
        { at: 7000, do: "manager-js", js: resaveWall },
        { at: 8200, do: "camera-js", tile: "Wall#0", js: "[window.__marker ?? null, window.__panesStats().dewarp.mode]" },
        { at: 8200, do: "camera-js", tile: "Wall#1", js: "window.__marker ?? null" },
        { at: 9000, do: "menu-click", tile: "Wall#0", label: "Close grid" },
      ]),
    },
  });
  const a2 = run2.result.actions;
  const closeAct = a2.find((a) => a.act.label === "Close grid");
  const first2 = run2.result.samples[0]?.cams ?? {};
  check("an open grid window reopens at launch", !!tile(first2, 0) && !!tile(first2, 3), JSON.stringify(Object.keys(first2)));
  const mid = run2.result.samples.filter((s) => s.t > a2[2]?.t && s.t < closeAct?.t).at(-1)?.cams ?? {};
  const afterResave = a2.filter((a) => a.act.do === "camera-js" && a.t > (a2.find((x) => x.act.js === resaveWall)?.t ?? Infinity)).map((a) => a.value);
  check("saving an open grid from the editor keeps its tiles' pages, and applies a changed view",
    a2.find((x) => x.act.js === resaveWall)?.value === true && afterResave.map((v) => JSON.stringify(v)).sort().join() === [JSON.stringify([42, "quad"]), "43"].sort().join(),
    JSON.stringify({ resave: a2.find((x) => x.act.js === resaveWall), afterResave }));
  check("an empty tile's menu puts a camera in it", a2[1]?.ok && run2.config.grids[0].tiles.some((t) => t?.key === keys.lobby) && Object.keys(mid).filter((k) => k.startsWith("grid:")).length === 4,
    `${a2[1]?.error ?? ""} ${JSON.stringify(Object.keys(mid))}`);
  const big = tile(mid, 0)?.bounds;
  const small = tile(mid, 1)?.bounds;
  check("Layout → 1 + 5 from a tile's menu: the first camera gets the big tile", big && small && big.width > 1.7 * small.width && run2.config.grids[0].templateId === "1+5",
    JSON.stringify({ big, small }));
  check("switching the layout keeps the tiles' pages (no reload)", a2[3]?.value === 42, JSON.stringify(a2[3]));
  check("Close grid closes it, and it stays closed", closeAct?.ok && run2.config.grids[0].open === false && !Object.keys(last(run2.result)).some((k) => k.startsWith("grid:")),
    `${closeAct?.error ?? ""} open=${run2.config.grids[0].open}`);
  console.log(`  results: ${userData}`);

  // The lens belongs to the camera, not to one view of it. A 360° camera is in a window, a grid tile
  // and a saved layout, all with image circle A. The window's circle is fixed to B (what Adjust image
  // circle sends), then the layout is applied: the tile must have B too, and the layout mustn't
  // bring A back.
  const lensDir = tmpDir("grid-lens");
  const circleA = { x: 0.5, y: 0.5, r: 0.45 };
  const quad = (circle) => ({ mode: "quad", mount: "ceiling", lensFov: 180, circle, views: [0, 90, -90, 180].map((pan) => ({ pan, tilt: -35, fov: 62 })), focus: -1, pano: { pan: 0, tilt: -35 } });
  // Garage's 360° camera has its circle (B) fixed in a closed grid's tile, and its window opens for
  // the first time: the window's first-view guess must not replace B.
  const fishB = `${B}/bbbbbbbb-cam360`;
  fs.writeFileSync(path.join(lensDir, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby"] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {
      [keys.fish]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2, dewarp: quad(circleA) },
      [fishB]: { open: true, bounds: { x: 0, y: 300, width: 480, height: 270 }, channel: 2 },
    },
    grids: [
      { id: "grid-1", name: "Lens", templateId: "2x2", bounds: { x: 500, y: 0, width: 640, height: 400 }, open: true, tiles: [{ key: keys.fish, channel: 2, dewarp: quad(circleA) }, null, null, null] },
      { id: "grid-2", name: "Garage grid", templateId: "2x2", bounds: { x: 500, y: 420, width: 640, height: 400 }, open: false, tiles: [{ key: fishB, channel: 2, dewarp: quad(CEILING_TRUTH) }, null, null, null] },
    ],
    layouts: [{ id: "lay-1", name: "Day", windows: {
      [keys.fish]: { bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2, dewarp: quad(circleA) },
      [fishB]: { bounds: { x: 0, y: 300, width: 480, height: 270 }, channel: 2, dewarp: quad(null) },
    } }],
    settings: { startHidden: true },
  }, null, 2));
  const readCircle = "window.__panesStats().dewarp.circle";
  const run3 = await runApp({
    userData: lensDir, results: path.join(lensDir, "results"), seconds: 14, extraArgs: ["--mock"],
    env: {
      ...env,
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 1500, do: "camera-js", win: 0, js: `panes.send("cam:dewarp", { circle: ${JSON.stringify(CEILING_TRUTH)} }), true` },
        { at: 4000, do: "tray-click", label: "Day" },
        { at: 11500, do: "camera-js", win: 0, js: readCircle },
        { at: 11500, do: "camera-js", tile: "Lens#0", js: readCircle },
        { at: 11500, do: "camera-js", win: 1, js: readCircle },
      ]),
    },
  });
  const isB = (c) => !!c && ["x", "y", "r"].every((k) => Math.abs(c[k] - CEILING_TRUTH[k]) < 1e-6);
  const read = (pick) => run3.result.actions.find((a) => a.act.js === readCircle && pick(a.act));
  const pages = { window: read((a) => a.win === 0)?.value, tile: read((a) => a.tile === "Lens#0")?.value, garageWindow: read((a) => a.win === 1)?.value };
  const saved = { window: run3.config.windows[keys.fish]?.dewarp?.circle, tile: run3.config.grids[0].tiles[0]?.dewarp?.circle, garageWindow: run3.config.windows[fishB]?.dewarp?.circle, garageTile: run3.config.grids[1].tiles[0]?.dewarp?.circle };
  check("a fixed image circle reaches the camera's grid tiles, and applying a layout keeps it",
    isB(pages.window) && isB(pages.tile) && isB(saved.window) && isB(saved.tile), JSON.stringify({ pages, saved }));
  check("a window's first-view circle guess doesn't replace a circle fixed in a grid tile",
    isB(pages.garageWindow) && isB(saved.garageWindow) && isB(saved.garageTile), JSON.stringify({ pages, saved }));

  // Enlarge one tile to fill the grid window and back: from the tile's menu, then by double-click.
  // The other tiles are hidden and paused meanwhile.
  const bigDir = tmpDir("grid-enlarge");
  fs.writeFileSync(path.join(bigDir, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair"] }],
    windows: {},
    grids: [{ id: "grid-big", name: "Big", templateId: "2x2", bounds: { x: 0, y: 0, width: 640, height: 400 }, open: true,
      tiles: [`${A}/aaaaaaaa-cam0`, `${A}/aaaaaaaa-cam1`, `${A}/aaaaaaaa-cam2`, null].map((key) => key && { key, channel: 2 }) }],
    settings: { startHidden: true },
  }, null, 2));
  const run4 = await runApp({
    userData: bigDir, results: path.join(bigDir, "results"), seconds: 17, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 3000, do: "menu-click", tile: "Big#1", label: "Enlarge this tile" },
        { at: 6000, do: "menu-click", tile: "Big#1", label: "Show all tiles" },
        { at: 9500, do: "dblclick", tile: "Big#0", pos: [80, 60] },
        { at: 13000, do: "dblclick", tile: "Big#0", pos: [80, 60] },
      ]),
    },
  });
  const t4 = (s, i) => s?.cams[`grid:Big#${i}`];
  const sampleAfter = (t) => run4.result.samples.find((s) => s.t > t); // samples are 2 s apart, the steps 2.5 s
  const enlargedM = sampleAfter(run4.result.actions.find((a) => a.act.label === "Enlarge this tile")?.t ?? Infinity);
  const backM = sampleAfter(run4.result.actions.find((a) => a.act.label === "Show all tiles")?.t ?? Infinity);
  const dbl = run4.result.actions.filter((a) => a.act.do === "dblclick");
  const enlargedD = sampleAfter(dbl[0]?.t ?? Infinity);
  const endD = run4.result.samples.at(-1);
  const view = (s) => [0, 1, 2].map((i) => t4(s, i) && `${t4(s, i).visible ? "shown" : "hidden"}/${t4(s, i).status}/${t4(s, i).bounds?.width}`);
  check("\"Enlarge this tile\" fills the grid window with it, and hides and pauses the others",
    t4(enlargedM, 1)?.visible && t4(enlargedM, 1).bounds.width > 500 && [0, 2].every((i) => !t4(enlargedM, i)?.visible && t4(enlargedM, i)?.status === "paused"),
    JSON.stringify(view(enlargedM)));
  check("\"Show all tiles\" goes back to the grid, all live", [0, 1, 2].every((i) => t4(backM, i)?.visible && t4(backM, i).bounds.width < 400),
    JSON.stringify(view(backM)));
  check("double-click enlarges a tile, and double-click again goes back",
    t4(enlargedD, 0)?.visible && t4(enlargedD, 0).bounds.width > 500 && !t4(enlargedD, 1)?.visible
      && [0, 1, 2].every((i) => t4(endD, i)?.visible && t4(endD, i).status === "live" && t4(endD, i).bounds.width < 400),
    JSON.stringify({ enlarged: view(enlargedD), end: view(endD) }));
}

/**
 * Windows only: sample every 100 ms whether window `above` (by title) is higher in the z-order than
 * window `below`, for `seconds`. `ready` resolves once sampling has started (compiling the Win32 shim
 * takes seconds on a slow CI runner, and a run started before that missed its first samples);
 * `stop()` ends it early; `done` resolves to [{ t: epoch ms, above: boolean }] for the samples
 * where both windows existed.
 */
function sampleZOrder(above, below, seconds) {
  const ps = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ZO {
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  public static bool Above(IntPtr a, IntPtr b) { for (IntPtr h = GetWindow(b, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) if (h == a) return true; return false; }
}
'@
"ready"
$end = (Get-Date).AddSeconds(${seconds})
while ((Get-Date) -lt $end) {
  $a = [ZO]::FindWindow([NullString]::Value, ${JSON.stringify(above)}); $b = [ZO]::FindWindow([NullString]::Value, ${JSON.stringify(below)})
  if ($a -ne [IntPtr]::Zero -and $b -ne [IntPtr]::Zero) { "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) $([ZO]::Above($a, $b))" }
  Start-Sleep -Milliseconds 100
}`;
  const child = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  child.stdout.on("data", (d) => { out += d; if (/\bready\b/.test(out)) markReady(); });
  const done = new Promise((resolve) => child.on("exit", () => {
    markReady();
    resolve(out.trim().split(/\r?\n/).filter((l) => /^\d+ /.test(l)).map((l) => {
      const [t, v] = l.split(" ");
      return { t: Number(t), above: v === "True" };
    }));
  }));
  return { ready, done, stop: () => child.kill() };
}

// ---------------------------------------------------------------------------------------------
// Camera list: Hide from list (cameras nobody uses) and putting them back.

async function listSuite() {
  console.log("\nCamera list suite (mock consoles)");
  const userData = tmpDir("list");
  const results = path.join(userData, "results");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, stair: `${A}/aaaaaaaa-cam2`, ramp: `${B}/bbbbbbbb-cam0` };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair"], mockDropout: { camera: "Stair", offMs: 9000, onMs: 14000 } },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
    },
    settings: { startHidden: false },
  }, null, 2));

  const card = (name) => `[...document.querySelectorAll("article.panel")].find((a) => a.querySelector(".console-head b")?.textContent === ${JSON.stringify(name)})`;
  const clickRow = (camName, text) => `(() => {
    const li = [...document.querySelectorAll(".cams li")].find((l) => l.querySelector(".cam-name b")?.textContent === ${JSON.stringify(camName)});
    li?.closest("details")?.setAttribute("open", "");
    const btn = li && [...li.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)});
    btn?.click();
    return !!btn;
  })()`;
  const showAll = `(() => { const btn = [...${card("Building")}.querySelectorAll("button")].find((b) => b.textContent === "Show all"); btn?.click(); return !!btn; })()`;
  const readList = `(() => {
    const c = ${card("Building")};
    return {
      count: document.getElementById("cam-count").textContent,
      listed: [...c.querySelectorAll(":scope > ul.cams .cam-name b")].map((b) => b.textContent),
      summary: c.querySelector("details.tucked > summary")?.textContent ?? null,
      tucked: [...c.querySelectorAll("details.tucked .cam-name b")].map((b) => b.textContent),
    };
  })()`;
  const readPalette = `(() => {
    document.querySelector('[data-tab="layouts"]').click();
    document.getElementById("btn-new-layout").click();
    const out = [...document.querySelectorAll("#editor-cameras li.cam")].map((li) => li.dataset.key);
    document.getElementById("editor-cancel").click();
    document.querySelector('[data-tab="cameras"]').click();
    return out;
  })()`;
  // A quality select that has just been used keeps the focus; the 3 s status re-render must go on.
  // (Stair goes offline at ~9 s and back at ~14 s: renders happen only when something changed, and
  // camera status reaches the list only through the poll.)
  const lobbyRow = `[...document.querySelectorAll(".cams li")].find((l) => l.querySelector(".cam-name b")?.textContent === "Building Lobby")`;
  const focusQuality = `(() => {
    const sel = document.querySelector('[data-focus-key="q-${keys.lobby}"]');
    sel?.focus();
    ${lobbyRow}.dataset.probe = "1"; // not in a fresh render: the next re-render's patch removes it
    return document.activeElement === sel;
  })()`;
  const rerendered = `(() => ({ rerendered: !${lobbyRow}?.hasAttribute("data-probe"), selectFocused: document.activeElement?.tagName === "SELECT" }))()`;
  // Re-renders patch what's on screen, so nodes, a text selection and the focus survive one.
  const dockRow = lobbyRow.replace("Building Lobby", "Building Dock");
  const markForPatch = `(() => {
    const row = ${lobbyRow};
    row.__marked = true;
    const img = row.querySelector(".thumb img");
    if (img) img.__marked = true;
    const name = ${dockRow}.querySelector(".cam-name b");
    const range = document.createRange();
    range.selectNodeContents(name);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Find")?.focus();
    row.dataset.probe = "1";
    return { img: !!img, selected: getSelection().toString(), focus: document.activeElement?.textContent };
  })()`;
  const afterPatch = `(() => {
    const row = ${lobbyRow};
    return {
      rerendered: !row.hasAttribute("data-probe"),
      sameRow: row.__marked === true,
      sameImg: row.querySelector(".thumb img")?.__marked === true,
      selected: getSelection().toString(),
      focus: document.activeElement?.textContent,
    };
  })()`;
  // A "⋯" menu left open (which also holds the re-renders off) closes when the list loses focus.
  const menuThenBlur = `(async () => {
    const d = ${card("Building")}.querySelector("details.menu");
    d.open = true;
    await new Promise((r) => setTimeout(r, 100));
    const opened = d.open;
    window.dispatchEvent(new Event("blur"));
    return { opened, closed: !document.querySelector("details.menu[open]") };
  })()`;
  // A hover tip inside the layout editor (a modal dialog) must show above it.
  const editorTip = `(async () => {
    document.querySelector('[data-tab="layouts"]').click();
    document.getElementById("btn-new-layout").click();
    await new Promise((r) => setTimeout(r, 300)); // opening a modal sends its own pointerover first
    const target = document.getElementById("editor-as");
    target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const tip = document.getElementById("tip");
    const out = { open: tip.matches(":popover-open"), text: tip.textContent.slice(0, 20), dialogOpen: document.getElementById("editor-dialog").open };
    document.getElementById("editor-cancel").click();
    document.querySelector('[data-tab="cameras"]').click();
    return out;
  })()`;
  // At the list's 560 px minimum, camera names keep room of their own (they were squeezed to "B…" or
  // to nothing while the model and status text kept its width).
  const narrowNames = `(() => {
    document.documentElement.style.width = "560px";
    const widths = [...document.querySelectorAll(".cams li .cam-name b")].map((b) => b.clientWidth);
    document.documentElement.style.width = "";
    return widths;
  })()`;
  // A thumbnail still loading and one the console gave no picture for look different from each other.
  const thumbStates = `(() => {
    const node = (key) => { const n = document.createElement("div"); n.dataset.previewKey = key; paintThumb(n); return n.textContent; };
    previewCache.set("test/none", { url: null, at: null, fetched: Date.now() });
    const out = { loading: node("test/never-asked"), none: node("test/none") };
    previewCache.delete("test/none");
    return out;
  })()`;
  // The console dialog warns about a port in the address, and closing it any way clears the password.
  const consoleDialog = `(async () => {
    openDialog(null);
    const f = document.getElementById("console-form");
    const hint = () => document.getElementById("host-hint").textContent;
    f.host.value = "192.168.1.1:7443"; f.host.dispatchEvent(new Event("input"));
    const withPort = hint();
    f.host.value = "192.168.1.1"; f.host.dispatchEvent(new Event("input"));
    const bare = hint();
    f.password.value = "typed";
    document.getElementById("console-dialog").close(); // what Esc does
    await new Promise((r) => setTimeout(r, 50)); // "close" fires a moment later
    return { withPort: !!withPort, bare, password: f.password.value };
  })()`;
  // Screen-reader names on the row and console buttons, and the tab strip's arrow keys.
  const a11y = `(() => {
    const row = ${lobbyRow};
    const names = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    const showAll = [...${card("Building")}.querySelectorAll("button")].find((b) => b.textContent === "Show all")?.getAttribute("aria-label");
    const cams = document.querySelector('[data-tab="cameras"]');
    cams.focus();
    cams.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const afterRight = { selected: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab, focused: document.activeElement?.dataset.tab };
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    return { names, showAll, afterRight, back: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab, dot: row.querySelector(".dot")?.getAttribute("aria-label") };
  })()`;
  const { result, config } = await runApp({
    userData, results, seconds: 22, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 19500, do: "manager-js", js: consoleDialog }, // after the selection check: the dialog takes the focus
        { at: 20000, do: "manager-js", js: thumbStates },
        { at: 20600, do: "manager-js", js: a11y },
        { at: 18000, do: "manager-js", js: editorTip },
        { at: 17200, do: "manager-js", js: narrowNames },
        { at: 13300, do: "manager-js", js: markForPatch },
        { at: 17800, do: "manager-js", js: afterPatch },
        { at: 2500, do: "manager-js", js: clickRow("Building Dock", "Hide from list") },
        { at: 3500, do: "manager-js", js: readList },
        { at: 4000, do: "manager-js", js: showAll },
        { at: 6000, do: "manager-js", js: readPalette },
        { at: 6500, do: "manager-js", js: clickRow("Building Dock", "Show in list") },
        { at: 7500, do: "manager-js", js: readList },
        { at: 8000, do: "manager-js", js: focusQuality },
        { at: 13000, do: "manager-js", js: rerendered },
        { at: 12000, do: "manager-js", js: menuThenBlur },
      ]),
    },
  });
  const act = (js) => result.actions.find((a) => a.act.js === js);
  check("the camera list keeps refreshing while a quality select has the focus",
    act(focusQuality)?.value === true && act(rerendered)?.value?.rerendered === true, JSON.stringify([act(focusQuality), act(rerendered)].map((a) => a?.value ?? a?.error)));
  check("an open console menu closes when the list loses focus", act(menuThenBlur)?.value?.opened === true && act(menuThenBlur).value.closed === true,
    JSON.stringify(act(menuThenBlur)?.value ?? act(menuThenBlur)?.error));
  const ax = act(a11y)?.value;
  check("buttons say which camera or console they act on, and the tabs follow the arrow keys",
    ax?.names?.includes("Find Building Lobby") && ax.names.includes("Hide Building Lobby from the list") && ax.showAll === "Show all on Building"
      && ax.afterRight?.selected === "layouts" && ax.afterRight.focused === "layouts" && ax.back === "cameras" && ax.dot === "online",
    JSON.stringify(ax ?? act(a11y)?.error));
  const cd = act(consoleDialog)?.value;
  check("the console dialog warns about a port in the address, and Esc clears a typed password",
    cd?.withPort === true && cd.bare === "" && cd.password === "", JSON.stringify(cd ?? act(consoleDialog)?.error));
  const ts = act(thumbStates)?.value;
  check("a loading thumbnail and one with no picture look different", ts?.loading === "…" && ts?.none === "no picture", JSON.stringify(ts ?? act(thumbStates)?.error));
  const nn = act(narrowNames)?.value;
  check("at the list's narrowest, every camera name keeps at least 60 px", Array.isArray(nn) && nn.length >= 3 && nn.every((w) => w >= 60), JSON.stringify(nn));
  const et = act(editorTip)?.value;
  check("hover tips show inside the layout editor, above the dialog", et?.dialogOpen && et.open && et.text.startsWith("Separate windows"), JSON.stringify(et ?? act(editorTip)?.error));
  const marked = act(markForPatch)?.value;
  const patched = act(afterPatch)?.value;
  check("a re-render keeps the rows, thumbnails, text selection and focus on screen",
    marked?.img && marked.selected === "Building Dock" && marked.focus === "Find"
      && patched?.rerendered && patched.sameRow && patched.sameImg && patched.selected === "Building Dock" && patched.focus === "Find",
    JSON.stringify({ marked, patched }));
  const [hid, before, all, palette, back, after] = result.actions.map((a) => a.value ?? { error: a.error });
  check("Hide on a camera row hid it from the list", hid === true && JSON.stringify(before?.listed) === JSON.stringify(["Building Lobby", "Building Stair"]),
    JSON.stringify(before ?? hid));
  check("hidden cameras sit in a collapsed Hidden from list section", before?.summary === "Hidden from list (1)" && JSON.stringify(before?.tucked) === JSON.stringify(["Building Dock"]), JSON.stringify(before));
  check("the camera count leaves them out and says how many are hidden", before?.count === "3 cameras · 1 open · 1 hidden from list", before?.count);
  const end = last(result);
  check("hiding closed the camera's window, and Show all skipped it",
    all === true && Object.keys(end).sort().join() === [keys.lobby, keys.stair].sort().join() && config.windows[keys.dock]?.open === false,
    `open=${JSON.stringify(Object.keys(end))} dock=${JSON.stringify(config.windows[keys.dock])}`);
  check("the layout editor's camera list leaves hidden cameras out",
    Array.isArray(palette) && palette.includes(keys.lobby) && palette.includes(keys.ramp) && !palette.includes(keys.dock), JSON.stringify(palette));
  check("Show in list put it back", back === true && after?.listed?.includes("Building Dock") && after.summary === null && after.count === "4 cameras · 2 open",
    JSON.stringify(after ?? back));
  check("hidden-from-list is saved per camera and cleared again", config.windows[keys.dock] && !("listHidden" in config.windows[keys.dock]), JSON.stringify(config.windows[keys.dock]));
  console.log(`  results: ${results}`);

  // Second launch: previews. Garage Spare is offline; the list re-renders every 3 s throughout.
  // The consoles take 1.5 s to connect, and Lobby and Ramp have saved (closed) windows, so until then
  // the list shows them as placeholder rows ("offline"). Their pictures must still come once connected
  // (on the real consoles, 7 of 9 rows stayed empty: the placeholder's "no picture" was kept 60 s).
  const pd = tmpDir("previews");
  fs.writeFileSync(path.join(pd, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock"], mockConnectMs: 1500 },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp", "Spare"], mockOffline: ["Spare"], mockConnectMs: 1500 },
    ],
    windows: { [keys.lobby]: { open: false, name: "Building Lobby" }, [keys.ramp]: { open: false, name: "Garage Ramp" } },
    settings: { startHidden: false },
  }, null, 2));
  const readThumbs = `(() => Object.fromEntries([...document.querySelectorAll(".cams li")].map((li) => [
    li.querySelector(".cam-name b")?.textContent,
    li.querySelector(".thumb") ? { jpeg: !!li.querySelector(".thumb img")?.src?.startsWith("data:image/jpeg"), text: li.querySelector(".thumb").textContent } : null,
  ])))()`;
  const hover = (selector) => `(async () => {
    document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const pop = document.getElementById("preview-pop");
    return { open: pop.matches(":popover-open"), jpeg: pop.querySelector("img").src.startsWith("data:image/jpeg"), caption: pop.querySelector("p").textContent };
  })()`;
  const hoverPalette = `(async () => {
    document.querySelector('[data-tab="layouts"]').click();
    document.getElementById("btn-new-layout").click();
    // Opening a modal moves what's under the real cursor, and Chromium sends its own pointerover
    // for that; hover after it, as a person would.
    await new Promise((r) => setTimeout(r, 300));
    const r = await ${hover(`#editor-cameras li.cam[data-key="${keys.ramp}"]`)};
    r.overDialog = document.getElementById("editor-dialog").open;
    document.getElementById("editor-cancel").click();
    document.querySelector('[data-tab="cameras"]').click();
    return r;
  })()`;
  const previewsOff = `(() => { const box = document.querySelector('[data-setting="showPreviews"]'); box.checked = false; box.dispatchEvent(new Event("change")); return true; })()`;
  const run2 = await runApp({
    userData: pd, results: path.join(pd, "results"), seconds: 12, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 4500, do: "manager-js", js: readThumbs },
        { at: 4800, do: "manager-js", js: hover(`.thumb[data-preview-key="${keys.lobby}"]`) },
        { at: 5500, do: "manager-js", js: hoverPalette },
        { at: 9000, do: "manager-js", js: previewsOff },
        { at: 10500, do: "manager-js", js: readThumbs },
      ]),
    },
  });
  const [thumbs, popList, popPalette, , thumbsOff] = run2.result.actions.map((a) => a.value ?? { error: a.error });
  check("each camera row shows a JPEG preview from the camera",
    thumbs?.["Building Lobby"]?.jpeg && thumbs["Building Dock"]?.jpeg && thumbs["Garage Ramp"]?.jpeg, JSON.stringify(thumbs));
  check("an offline camera's preview says offline", thumbs?.["Garage Spare"]?.text === "offline" && !thumbs["Garage Spare"].jpeg, JSON.stringify(thumbs?.["Garage Spare"]));
  check("hovering a preview shows it bigger, with the camera's name and age",
    popList?.open && popList.jpeg && /^Building Lobby · taken (just now|\d+ s ago)$/.test(popList.caption), JSON.stringify(popList));
  check("hovering a camera in the layout editor shows its preview above the dialog",
    popPalette?.open && popPalette.overDialog && popPalette.jpeg && popPalette.caption.startsWith("Garage Ramp"), JSON.stringify(popPalette));
  const asked = (id) => run2.result.connections[id]?.snapshots;
  check("re-renders and hovers reuse the picture: one request per online camera, none for the offline one",
    asked(A) === 2 && asked(B) === 1, JSON.stringify({ building: asked(A), garage: asked(B) }));
  check("Show camera previews off removes them from the list",
    run2.config.settings.showPreviews === false && thumbsOff && Object.values(thumbsOff).every((t) => t === null), JSON.stringify(thumbsOff));

  // A camera opened from the list appears above it without taking the focus, so the list stays the
  // active window under it, and on Windows clicking an active window doesn't raise it (the owner
  // couldn't get back to the list). A click anywhere in the list must bring it above the camera.
  if (process.platform === "win32") {
    const zd = tmpDir("raise");
    fs.writeFileSync(path.join(zd, "config.json"), JSON.stringify({
      version: 1,
      consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby"] }],
      windows: {},
      settings: { startHidden: false },
    }, null, 2));
    const zorder = sampleZOrder("Building Lobby", "Protect Panes", 90);
    await zorder.ready;
    const run3 = await runApp({
      userData: zd, results: path.join(zd, "results"), seconds: 9, extraArgs: ["--mock"],
      env: {
        PANES_SELFTEST_ACTIONS: JSON.stringify([
          { at: 3000, do: "manager-js", js: `(() => { document.querySelector(".switch input").click(); return true; })()` },
          { at: 6000, do: "manager-js", js: `(() => { document.getElementById("filter").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return true; })()` },
        ]),
      },
    });
    zorder.stop();
    const samples = await zorder.done;
    const clickAt = run3.result.actions[1]?.t ?? Infinity;
    const before = samples.filter((s) => s.t < clickAt - 200).at(-1);
    const after = samples.filter((s) => s.t > clickAt + 500);
    check("a camera opened from the list shows above it", before?.above === true, JSON.stringify(before));
    check("a click in the camera list brings it back above the camera", after.length > 0 && after.every((s) => !s.above), JSON.stringify(after.slice(0, 3)));
  }
}

// ---------------------------------------------------------------------------------------------
// Color range: several UniFi cameras send full-range luma without flagging it, and Chromium then
// crushes everything below 16 to black. src/avc-range.js rewrites the SPS to say full range.

const ffmpeg = (args) => spawnSync(FFMPEG, ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
const videoLine = (file) => (/Video: .*/.exec(ffmpeg(["-i", file]).stderr) ?? [""])[0];
const frameHashes = (file) => ffmpeg(["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"]).stdout.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1).trim());
const decodeErrors = (file) => ffmpeg(["-v", "error", "-i", file, "-f", "null", "-"]).stderr.trim();

function splitInit(bytes) {
  let p = 0;
  while (p + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(p);
    const type = bytes.toString("latin1", p + 4, p + 8);
    p += size;
    if (type === "moov") break;
  }
  return { init: new Uint8Array(bytes.subarray(0, p)), rest: bytes.subarray(p) };
}

/** Mean gray level of a region of a PNG (fractions of width/height). */
function regionLuma(png, [x, y, w, h]) {
  const out = ffmpeg(["-i", png, "-vf", `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG`, "-f", "null", "-"]).stderr;
  const m = /YAVG=([\d.]+)/.exec(out);
  return m ? Number(m[1]) : NaN;
}

async function rangeSuite() {
  console.log("\nColor range suite (SPS rewrite + what Chromium actually displays)");
  const { initRange, applyRange, internals } = await import(new URL("../src/avc-range.js", import.meta.url).href);
  const dir = tmpDir("range");
  const encode = (name, extra) => {
    const file = path.join(dir, `${name}.mp4`);
    ffmpeg(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "1", ...extra,
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "15",
      "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", file]);
    return file;
  };
  const write = (name, init, rest) => {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(init), rest]));
    return file;
  };

  // No VUI at all: x264 always writes one, so cut it off a real x264 SPS.
  const stripVui = (sps) => {
    const { BitReader, BitWriter, readToVui, unescapeRbsp, escapeRbsp } = internals;
    const r = new BitReader(unescapeRbsp(sps.subarray(1)));
    readToVui(r);
    const w = new BitWriter();
    w.copy(r, 0, r.pos - 1);
    w.bit(0);
    return Uint8Array.from([sps[0], ...escapeRbsp(w.finish())]);
  };

  const unflagged = encode("unflagged", []);
  const { init: u, rest: uRest } = splitInit(fs.readFileSync(unflagged));
  const variants = [
    { name: "no range flag (x264 VUI)", file: unflagged, declared: null, auto: true },
    { name: "flagged full", file: encode("pc", ["-color_range", "pc"]), declared: true, auto: true },
    // x264 only writes the signal-type block for limited range when colorimetry is set too.
    { name: "flagged limited", file: encode("tv", ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]), declared: false, auto: false },
    { name: "no VUI at all", file: write("novui", internals.mapSps(u, stripVui), uRest), declared: null, auto: true },
  ];
  for (const v of variants) {
    const { init, rest } = splitInit(fs.readFileSync(v.file));
    const declared = initRange(init);
    const auto = applyRange(init, "auto");
    const patchedFile = write(`${path.basename(v.file, ".mp4")}-auto`, auto, rest);
    const same = JSON.stringify(frameHashes(v.file)) === JSON.stringify(frameHashes(patchedFile));
    const errs = decodeErrors(patchedFile);
    check(`${v.name}: reads as ${v.declared}`, declared === v.declared, `got ${declared}`);
    check(`${v.name}: auto -> ${v.auto ? "full" : "left alone"}, decodes identically`,
      initRange(auto) === v.auto && same && !errs && (v.auto ? /\(pc/.test(videoLine(patchedFile)) : auto === init),
      `range=${initRange(auto)} sameFrames=${same} errors=${errs || "none"} ${videoLine(patchedFile)}`);
  }
  const { init: tvInit } = splitInit(fs.readFileSync(variants[2].file));
  check("Full override rewrites a limited flag", initRange(applyRange(tvInit, "full")) === true);
  check("Limited override flags an unflagged stream limited", initRange(applyRange(u, "limited")) === false);
  check("non-H.264 input is passed through untouched", applyRange(new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]), "auto").length === 8);

  // In the app: two mock cameras sending Y=0 | Y=24 full-range, unflagged. Auto should show the
  // right half at ~24; the Limited override reproduces the old crushed look (~9).
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const userData = tmpDir("range-app");
  const results = path.join(userData, "results");
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Shadows", "Shadows Limited", "Shadows Bright", "Shadows Panel"] }],
    windows: {
      [`${A}/aaaaaaaa-cam0`]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [`${A}/aaaaaaaa-cam1`]: { open: true, bounds: { x: 500, y: 0, width: 480, height: 270 }, channel: 2, range: "limited" },
      [`${A}/aaaaaaaa-cam2`]: { open: true, bounds: { x: 0, y: 300, width: 480, height: 270 }, channel: 2, picture: { brightness: 2, contrast: 1 } },
      [`${A}/aaaaaaaa-cam3`]: { open: true, bounds: { x: 500, y: 300, width: 480, height: 270 }, channel: 2 },
    },
    settings: { startHidden: true, showNames: false },
  }, null, 2));
  // Shadows Panel: right-click -> Adjust picture…, drag Contrast to 50 %, Done.
  const setContrast = `(() => {
    const panel = document.getElementById("picture");
    const s = document.getElementById("pic-contrast");
    s.value = "50";
    s.dispatchEvent(new Event("input"));
    return { open: !panel.classList.contains("hidden"), shown: document.getElementById("pic-contrast-val").textContent };
  })()`;
  const { result, config } = await runApp({
    userData, results, seconds: 8, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 3000, do: "menu-click", win: 3, label: "Adjust picture…" },
        { at: 3600, do: "camera-js", win: 3, js: setContrast },
        { at: 4200, do: "camera-js", win: 3, js: `document.getElementById("pic-done").click()` },
      ]),
    },
  });
  const shot = (suffix) => path.join(results, Object.keys(result.windows).find((n) => n.endsWith(suffix)) ?? "missing.png");
  const auto = { left: regionLuma(shot("Building_Shadows.png"), [0.1, 0.15, 0.3, 0.6]), right: regionLuma(shot("Building_Shadows.png"), [0.6, 0.15, 0.3, 0.6]) };
  const limited = { right: regionLuma(shot("Shadows_Limited.png"), [0.6, 0.15, 0.3, 0.6]) };
  const live = Object.values(last(result)).every((c) => c.status === "live");
  check("both shadow cameras live", live);
  check("Auto shows full-range shadows (Y=24 displays ~24, not crushed)", auto.right > 19 && auto.right < 29 && auto.left < 4, JSON.stringify(auto));
  check("Limited override shows the crushed TV-range reading (~9)", limited.right > 4 && limited.right < 14, JSON.stringify(limited));

  // CSS brightness(b) multiplies each channel; contrast(c) maps v to (v - 0.5) * c + 0.5 (0-1 scale).
  const bright = regionLuma(shot("Shadows_Bright.png"), [0.6, 0.15, 0.3, 0.6]);
  check("saved brightness 200 % doubles the picture (Y=24 shows ~48)", bright > 42 && bright < 54, bright.toFixed(1));
  const [panelOpen, panelSet] = result.actions.map((a) => a.value ?? a.error ?? a.ok);
  const panel = { left: regionLuma(shot("Shadows_Panel.png"), [0.1, 0.15, 0.3, 0.6]), right: regionLuma(shot("Shadows_Panel.png"), [0.6, 0.15, 0.3, 0.6]) };
  const panelEnd = last(result)[`${A}/aaaaaaaa-cam3`]?.picture;
  check("Adjust picture… opens the panel and the Contrast slider reads 50 %", panelOpen === true && panelSet?.open && panelSet.shown === "50%", JSON.stringify({ panelOpen, panelSet }));
  check("contrast 50 % lifts black to ~64 and Y=24 to ~76 on screen", panel.left > 58 && panel.left < 70 && panel.right > 70 && panel.right < 82, JSON.stringify(panel));
  check("Done closes the panel and saves the picture setting",
    panelEnd && !panelEnd.panel && panelEnd.filter === "brightness(1) contrast(0.5)" && JSON.stringify(config.windows[`${A}/aaaaaaaa-cam3`]?.picture) === JSON.stringify({ brightness: 1, contrast: 0.5 }),
    JSON.stringify({ panelEnd, saved: config.windows[`${A}/aaaaaaaa-cam3`]?.picture }));
  console.log(`  results: ${dir}  ${results}`);
}

// ---------------------------------------------------------------------------------------------
// End-to-end suite against fake consoles

function startConsole(port, mode, prefix, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "test", "fake-console", "server.mjs"), String(port), mode, prefix], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = []; // its log lines, for checks on what the app asked for
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake console ${port} didn't start`)), 10_000);
    child.stdout.on("data", (d) => {
      child.output.push(...String(d).split(/\r?\n/).filter(Boolean));
      if (String(d).includes("listening")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", (code) => reject(new Error(`fake console ${port} exited (${code})`)));
  });
}

async function e2eSuite() {
  console.log("\nEnd-to-end suite (fake UniFi OS consoles, real unifi-protect library)");
  const P = { building: 18443, garage: 18444, bad: 18445 };
  const servers = await Promise.all([
    startConsole(P.building, "ok", "Building", { FAKE_FISHEYE: path.join(FIXTURES, "fisheye-ceiling.png") }),
    startConsole(P.garage, "ok", "Garage", { FAKE_ACCESS: "1" }), // plus a UniFi Access door reader
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
      keypad: `${ids.G}/${cam(P.garage, 4)}`,
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
        [keys.keypad]: win(1620, 0, 240, 320, 1), // last, so the windows above keep their win: indexes
      },
      // Garage in a grid tile too, on the same channel: the library pools the two onto one session.
      grids: [{ id: "g-e2e", name: "E2E grid", templateId: "2x2", bounds: { x: 1120, y: 0, width: 640, height: 400 }, open: true, tiles: [{ key: keys.garage, channel: 0 }, null, null, null] }],
      settings: { startHidden: false },
    }, null, 2));

    // Garage's password saved the way 1.3.x saved it (sync safeStorage): the async API must read it.
    const legacy = process.platform === "win32";
    if (legacy) {
      const r = spawnSync(ELECTRON, [path.join(ROOT, "test", "legacy-password.cjs"), userData, ids.G, "secret"], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`legacy-password.cjs failed: ${r.stderr || r.status}`);
    }

    const importJs = `(() => {
      const sel = document.getElementById("import-liveview");
      const options = [...sel.options].map((o) => o.textContent);
      sel.value = [...sel.options].find((o) => o.parentElement.label === "Building")?.value ?? "";
      sel.dispatchEvent(new Event("change"));
      return options;
    })()`;
    // Save the imported draft the way it opens: as one grid window.
    const saveDraftJs = `(() => {
      document.getElementById("editor-form").requestSubmit(document.getElementById("editor-save"));
      return document.getElementById("editor-as").value;
    })()`;
    // A console added through the dialog: its password goes through encryptStringAsync.
    const addJs = `(() => {
      document.getElementById("btn-add").click();
      const f = document.getElementById("console-form");
      f.name.value = "Added Here";
      f.host.value = "127.0.0.1:${P.garage}";
      f.username.value = "viewer";
      f.password.value = "secret";
      f.requestSubmit();
      return true;
    })()`;
    const thumbsJs = `(() => Object.fromEntries([...document.querySelectorAll(".cams li")].map((li) => [
      li.querySelector(".cam-name b")?.textContent,
      { jpeg: !!li.querySelector(".thumb img")?.src?.startsWith("data:image/jpeg"), text: li.querySelector(".thumb")?.textContent ?? null,
        fit: li.querySelector(".thumb img") && getComputedStyle(li.querySelector(".thumb img")).objectFit },
    ])))()`;
    // Negotiations the Garage console has seen for that camera, just before Reconnect stream (12 s).
    const garageNegotiates = () => servers[1].output.filter((l) => l.includes(`livestream negotiate ${cam(P.garage, 0)}`)).length;
    let negotiatesBefore = null;
    const snap = setTimeout(() => { negotiatesBefore = garageNegotiates(); }, 10_500);
    const { result, config } = await runApp({
      userData, results, seconds: 16,
      env: {
        PANES_SELFTEST_ACTIONS: JSON.stringify([
          { at: 5000, do: "manager-js", js: importJs },
          { at: 5800, do: "manager-js", js: saveDraftJs },
          { at: 10000, do: "manager-js", js: thumbsJs },
          { at: 6800, do: "manager-js", js: addJs },
          { at: 12000, do: "menu-click", win: 4, label: "Reconnect stream" },
        ]),
      },
    });
    clearTimeout(snap);
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
    // A UniFi Access reader sends bare access units (no moof/mdat/end) and an init declaring an AAC
    // track it never sends: bare-livestream.js builds the fragments and drops the audio track.
    const kp = cams[keys.keypad];
    check("an Access door reader plays: live, decoding, portrait, video only, near the live edge",
      kp?.status === "live" && kp.decodedFrames >= 30 && kp.videoWidth === 360 && kp.videoHeight === 480 && /avc1/.test(kp.mime) && !/mp4a/.test(kp.mime) && kp.lag < 1.5,
      kp && JSON.stringify({ status: kp.status, frames: kp.decodedFrames, size: `${kp.videoWidth}x${kp.videoHeight}`, mime: kp.mime, lag: kp.lag?.toFixed(2), resets: kp.resetRequests }));
    const reconnect = result.actions.find((a) => a.act.label === "Reconnect stream");
    check("Reconnect stream reconnects even while a grid tile shares the camera's stream",
      reconnect?.ok && negotiatesBefore !== null && garageNegotiates() > negotiatesBefore && cams[keys.garage]?.status === "live" && cams["grid:E2E grid#0"]?.status === "live",
      JSON.stringify({ act: reconnect?.error, before: negotiatesBefore, after: garageNegotiates(), window: cams[keys.garage]?.status, tile: cams["grid:E2E grid#0"]?.status }));
    const fd = config.windows[keys.fisheye]?.dewarp;
    check("fisheye detected from Protect flags -> quad view, ceiling mount", cams[keys.fisheye]?.dewarp?.active && fd?.mode === "quad" && fd?.mount === "ceiling", JSON.stringify({ mode: fd?.mode, mount: fd?.mount }));
    check("fisheye image circle auto-detected within 1%", near(fd?.circle, CEILING_TRUTH, 0.01), fmtCircle(fd?.circle));
    check("normal cameras don't create a WebGL context", cams[keys.garage]?.dewarp?.gl === false);
    const opts = result.actions[0]?.value ?? [];
    check("Protect liveviews read through the library", opts.includes("Building Entrances (3 cameras)") && opts.includes("Garage Entrances (3 cameras)"), JSON.stringify(result.actions[0]?.value ?? result.actions[0]?.error));
    const imported = config.grids?.find((g) => g.name === "Building · Building Entrances");
    const slotKeys = [1, 0, null, 2].map((i) => (i === null ? null : `${ids.B}/${cam(P.building, i)}`));
    check("imported liveview saved as a 2x2 grid window: first camera of each slot, empty slot kept, slot order kept, the cycling slot's cycle read",
      imported?.templateId === "2x2" && JSON.stringify(imported.tiles.map((t) => t?.key ?? null)) === JSON.stringify(slotKeys)
        && imported.tiles[3]?.cycle?.seconds === 10 && JSON.stringify(imported.tiles[3].cycle.then.map((m) => m.key)) === JSON.stringify([`${ids.B}/${cam(P.building, 0)}`])
        && imported.tiles.slice(0, 3).every((t) => !t?.cycle)
        && result.actions.find((a) => a.act.js === saveDraftJs)?.value === "grid",
      JSON.stringify(imported ? { templateId: imported.templateId, tiles: imported.tiles.map((t) => t?.key ?? null) } : result.actions.find((a) => a.act.js === saveDraftJs)));
    if (legacy) {
      check("a password saved by 1.3.x (sync safeStorage) still logs in", config.consoles.find((c) => c.id === ids.G)?.password?.enc === "safe" && conn[ids.G]?.state === "connected",
        JSON.stringify(conn[ids.G]));
    }
    const added = config.consoles.find((c) => c.name === "Added Here");
    check("a console added in the dialog saves its password encrypted and connects with it",
      added?.password?.enc === "safe" && !String(added.password.data).includes("secret") && conn[added.id]?.state === "connected",
      JSON.stringify({ enc: added?.password?.enc, state: added && conn[added.id] }));
    const thumbs = result.actions.find((a) => a.act.js === thumbsJs)?.value ?? {};
    const asked = servers[0].output.filter((l) => l.includes(" snapshot "));
    check("camera list previews: a JPEG from Protect's snapshot endpoint, through the library",
      thumbs["Building Cam 1"]?.jpeg && asked.some((l) => l.includes(`snapshot ${cam(P.building, 0)} w=480`)),
      JSON.stringify({ thumbs, asked }));
    // A 360° camera's snapshot is square: "cover" in the 16:9 thumbnail cut the top and bottom off.
    check("row thumbnails show the whole snapshot (contain, not cropped)",
      Object.values(thumbs).some((t) => t.jpeg) && Object.values(thumbs).filter((t) => t.jpeg).every((t) => t.fit === "contain"),
      JSON.stringify(Object.fromEntries(Object.entries(thumbs).map(([n, t]) => [n, t.fit]))));
    check("an offline camera's preview says offline and the console isn't asked for it",
      thumbs["Building Cam 3"]?.text === "offline" && !thumbs["Building Cam 3"]?.jpeg && !asked.some((l) => l.includes(cam(P.building, 2))),
      JSON.stringify({ cam3: thumbs["Building Cam 3"], asked }));
    console.log(`  results: ${results}`);

    // TLS certificate pinning. The first connection trusted each console's certificate...
    const { X509Certificate } = await import("node:crypto");
    const fakeCert = new X509Certificate(fs.readFileSync(path.join(ROOT, "test", "fake-console", "cert.pem"))).fingerprint256;
    check("each console's TLS certificate is trusted on first use and saved",
      [ids.B, ids.G].every((id) => config.consoles.find((c) => c.id === id)?.certSha256 === fakeCert), JSON.stringify(config.consoles.map((c) => [c.name, c.certSha256?.slice(0, 11)])));

    // ...so a different one is refused before anything is sent, until it's trusted in the camera list.
    const cfg2 = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
    for (const w of Object.values(cfg2.windows)) w.open = false;
    for (const g of cfg2.grids ?? []) g.open = false;
    cfg2.consoles.find((c) => c.id === ids.G).certSha256 = fakeCert.replace(/^../, fakeCert.startsWith("00") ? "11" : "00");
    fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(cfg2, null, 2));
    const logins = () => servers[1].output.filter((l) => l.includes("login ok")).length;
    const loginsBefore = logins();
    let loginsWhileRefused = null;
    const snap2 = setTimeout(() => { loginsWhileRefused = logins(); }, 5_000);
    const readTrust = `(() => {
      const card = [...document.querySelectorAll("article.panel")].find((a) => a.querySelector(".console-head b")?.textContent === "Garage");
      return { button: [...card.querySelectorAll("button")].some((b) => b.textContent.startsWith("Trust the new certificate")), msg: card.querySelector(".console-msg")?.textContent ?? "" };
    })()`;
    // Pointing a saved console at another address without typing the password again: refused, so the
    // saved password never goes to whatever answers there.
    const moveHost = `panes.invoke("mgr:save-console", { id: ${JSON.stringify(ids.B)}, name: "Building", host: "127.0.0.1:${P.garage}", username: "viewer", password: "" })
      .then(() => "saved", (err) => String(err.message))`;
    const run2 = await runApp({
      userData, results: path.join(userData, "results-2"), seconds: 11,
      env: {
        PANES_SELFTEST_ACTIONS: JSON.stringify([
          { at: 5000, do: "manager-js", js: readTrust },
          { at: 6500, do: "manager-js", js: `panes.invoke("mgr:trust-cert", ${JSON.stringify(ids.G)}).then(() => true)` },
          { at: 8000, do: "manager-js", js: moveHost },
        ]),
      },
    });
    const moved = run2.result.actions.find((a) => a.act.js === moveHost)?.value;
    check("a console's address can't be changed without typing its password again",
      /password again/.test(moved ?? "") && run2.config.consoles.find((c) => c.id === ids.B)?.host === `127.0.0.1:${P.building}`, JSON.stringify(moved));
    clearTimeout(snap2);
    const shown = run2.result.actions.find((a) => a.act.js === readTrust)?.value;
    check("a console presenting a different certificate is refused before the login is sent",
      loginsWhileRefused === loginsBefore && shown?.button && /different security certificate/.test(shown.msg),
      JSON.stringify({ loginsBefore, loginsWhileRefused, shown }));
    check("trusting the new certificate in the camera list connects and saves it",
      run2.result.connections[ids.G]?.state === "connected" && run2.config.consoles.find((c) => c.id === ids.G)?.certSha256 === fakeCert && logins() > loginsBefore
        && run2.result.connections[ids.B]?.state === "connected",
      JSON.stringify({ G: run2.result.connections[ids.G], B: run2.result.connections[ids.B]?.state, logins: logins() }));
  } finally {
    for (const s of servers) s.kill();
  }
}

// ---------------------------------------------------------------------------------------------
// Cycling grid tiles (mock consoles): a tile that cycles through cameras like a Protect liveview
// slot, each camera with its own tile settings; a cycling liveview imported through the editor.

async function cycleSuite() {
  console.log("\nCycling tiles suite (mock consoles)");
  const userData = tmpDir("cycle");
  const results = path.join(userData, "results");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const keys = { lobby: `${A}/aaaaaaaa-cam0`, dock: `${A}/aaaaaaaa-cam1`, stair: `${A}/aaaaaaaa-cam2`, yard: `${A}/aaaaaaaa-cam3`, ramp: `${B}/bbbbbbbb-cam0` };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({
    version: 1,
    consoles: [
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair", "Yard"],
        mockLiveviews: [{ id: "lv", name: "Rotation", seconds: 7, slots: [[0, 1, 2], null, 3, null] }] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {},
    // Lobby on Medium and Dock on Low: each camera of the cycle keeps its own tile settings.
    grids: [{
      id: "g-cyc", name: "Cycle", templateId: "2x2", bounds: { x: 0, y: 0, width: 640, height: 400 }, open: true,
      tiles: [{ key: keys.lobby, channel: 1, cycle: { seconds: 5, then: [{ key: keys.dock, channel: 2 }, { key: keys.stair }] } }, { key: keys.ramp }, null, null],
    }, {
      // Hand-edited into nonsense: loading drops the cycle and keeps the tile.
      id: "g-bad", name: "Broken cycle", templateId: "1", bounds: { x: 700, y: 0, width: 320, height: 200 }, open: false,
      tiles: [{ key: keys.yard, cycle: { seconds: "soon", then: [null, { key: 5 }, "x"] } }],
    }],
    settings: { startHidden: false },
  }, null, 2));

  const importJs = `(() => {
    const sel = document.getElementById("import-liveview");
    sel.value = ${JSON.stringify(`${A}|lv`)};
    sel.dispatchEvent(new Event("change"));
    return true;
  })()`;
  const saveDraftJs = `(() => {
    const cell = document.querySelector('#editor-preview [data-cell="0"] .cycle');
    const seen = { text: cell?.textContent ?? null, tip: cell?.dataset.tip ?? null };
    document.getElementById("editor-form").requestSubmit(document.getElementById("editor-save"));
    return seen;
  })()`;
  // Edit grid… and Save, unchanged: the cycle has to come back from the camera list's state.
  const resaveJs = `(async () => {
    const g = (await panes.invoke("mgr:state")).grids.find((x) => x.name === "Building · Rotation");
    await panes.invoke("mgr:save-editor-layout", { id: g.id, as: "grid", name: g.name, displayId: g.editor.displayId, templateId: g.editor.templateId, cells: g.editor.cells, apply: false });
    return g.editor.cells[0];
  })()`;
  const ENLARGE_AT = 13500;
  const { result, config } = await runApp({
    userData, results, seconds: 20, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2000, do: "manager-js", js: importJs },
        { at: 2800, do: "manager-js", js: saveDraftJs },
        { at: 4000, do: "manager-js", js: resaveJs },
        // Tile 0 is hidden behind the enlarged tile 1 from here on: it should stop cycling.
        { at: ENLARGE_AT, do: "menu-click", tile: "Cycle#1", label: "Enlarge this tile" },
      ]),
    },
  });
  const name = (key) => Object.entries(keys).find(([, v]) => v === key)?.[0] ?? key;
  const enlargeAct = result.actions.find((a) => a.act.do === "menu-click");
  const t0 = result.samples.map((s) => ({ t: s.t, ...s.cams["grid:Cycle#0"] })).filter((s) => s.key);
  const before = t0.filter((s) => s.t < (enlargeAct?.t ?? Infinity));
  const after = t0.filter((s) => s.t > (enlargeAct?.t ?? Infinity) + 1000);
  const order = before.map((s) => name(s.key)).filter((k, i, a) => k !== a[i - 1]);
  check("a cycling tile shows its cameras in turn (Lobby, Dock, Stair)", order.slice(0, 3).join(",") === "lobby,dock,stair", order.join(","));
  check("each camera in the cycle reaches live in the tile", ["lobby", "dock"].every((n) => t0.some((s) => name(s.key) === n && s.status === "live")),
    JSON.stringify(t0.map((s) => `${name(s.key)}:${s.status}`)));
  const channelsOf = (n) => [...new Set(t0.filter((s) => name(s.key) === n && s.channel !== null).map((s) => s.channel))];
  check("each camera in the cycle keeps its own tile settings (Lobby Medium, Dock Low)",
    JSON.stringify(channelsOf("lobby")) === "[1]" && JSON.stringify(channelsOf("dock")) === "[2]",
    JSON.stringify({ lobby: channelsOf("lobby"), dock: channelsOf("dock") }));
  check("a cycling tile hidden behind an enlarged tile stops cycling",
    enlargeAct?.ok && after.length >= 2 && new Set(after.map((s) => s.key)).size === 1,
    JSON.stringify({ act: enlargeAct?.error, after: after.map((s) => name(s.key)) }));
  const t1 = result.samples.map((s) => s.cams["grid:Cycle#1"]).filter(Boolean);
  check("the tile next to it keeps its camera and stays live", t1.length && t1.every((s) => s.key === keys.ramp) && t1.at(-1).status === "live",
    JSON.stringify(t1.map((s) => `${name(s.key)}:${s.status}`)));
  const active = result.connections[A]?.active ?? {};
  check("cameras cycled away from leave no stream running", Object.values(active).every((n) => n === 0), JSON.stringify(active));

  const draft = result.actions.find((a) => a.act.js === saveDraftJs)?.value;
  check("an imported cycling slot shows its cycle in the editor", draft?.text === "↻ cycles 3 cameras, 7 s each" && /Building Dock, Building Stair and back, 7 s each/.test(draft.tip ?? ""), JSON.stringify(draft));
  const imported = config.grids?.find((g) => g.name === "Building · Rotation");
  const cyc = imported?.tiles[0]?.cycle;
  check("the imported grid keeps the slot's cycle and its interval, and the other slots",
    imported?.tiles[0]?.key === keys.lobby && cyc?.seconds === 7 && JSON.stringify(cyc.then.map((m) => m.key)) === JSON.stringify([keys.dock, keys.stair])
      && imported.tiles[2]?.key === keys.yard && !imported.tiles[2].cycle && imported.tiles[1] === null,
    JSON.stringify(imported?.tiles));
  const round = result.actions.find((a) => a.act.js === resaveJs)?.value;
  check("Edit grid… gets the cycle back, and saving it again keeps it",
    JSON.stringify(round?.cycle) === JSON.stringify({ keys: [keys.dock, keys.stair], seconds: 7 }) && cyc?.then.length === 2,
    JSON.stringify(round ?? result.actions.find((a) => a.act.js === resaveJs)?.error));
  const bad = config.grids?.find((g) => g.id === "g-bad");
  check("a broken cycle in config.json is dropped on load, its tile kept", bad?.tiles[0]?.key === keys.yard && !("cycle" in bad.tiles[0]), JSON.stringify(bad?.tiles));
  console.log(`  results: ${results}`);
}

// ---------------------------------------------------------------------------------------------

try {
  if (suite === "mock" || suite === "all") await runSuite(mockSuite);
  if (suite === "hide" || suite === "all") await runSuite(hideSuite);
  if (suite === "bounds" || suite === "all") await runSuite(boundsSuite);
  if (suite === "connection" || suite === "all") await runSuite(connectionSuite);
  if (suite === "streams" || suite === "all") await runSuite(streamsSuite);
  if (suite === "config" || suite === "all") await runSuite(configSuite);
  if (suite === "transfer" || suite === "all") await runSuite(transferSuite);
  if (suite === "security" || suite === "all") await runSuite(securitySuite);
  if (suite === "range" || suite === "all") await runSuite(rangeSuite);
  if (suite === "layouts" || suite === "all") await runSuite(layoutsSuite);
  if (suite === "arrange" || suite === "all") await runSuite(arrangeSuite);
  if (suite === "editor" || suite === "all") await runSuite(editorSuite);
  if (suite === "list" || suite === "all") await runSuite(listSuite);
  if (suite === "grid" || suite === "all") await runSuite(gridSuite);
  if (suite === "cycle" || suite === "all") await runSuite(cycleSuite);
  if (suite === "update" || suite === "all") await runSuite(updateSuite);
  if (suite === "e2e" || suite === "all") await runSuite(e2eSuite);
} catch (err) {
  console.error(`\nTest run failed: ${err.message}`);
  failures++;
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
