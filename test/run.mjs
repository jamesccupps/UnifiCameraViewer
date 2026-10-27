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
const FFMPEG = process.env.FFMPEG_PATH || require("ffmpeg-static") || "ffmpeg";
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
      { id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Lobby", "Dock", "Stair"] },
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
    { at: 9500, do: "menu-click", win: 0, label: "Show time" },
    { at: 9500, do: "menu-click", win: 1, label: "Show time" },
    { at: 10500, do: "menu-click", win: 0, label: "Quality: Medium" },
    { at: 11000, do: "menu-click", win: 0, label: "Show time: on" },
  ];
  const { result, config } = await runApp({
    userData, results, seconds: 16, extraArgs: ["--mock"],
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
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
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

  const run1 = await runApp({
    userData, results: path.join(userData, "results-1"), seconds: 11, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 3000, do: "manager-js", js: clickInCard("Garage", "Hide all") },
        { at: 4500, do: "manager-js", js: readButtons },
        { at: 5000, do: "tray-click", label: "Show cameras" },
        { at: 6000, do: "manager-js", js: setQualityForAll("Garage", 1) },
        { at: 8500, do: "tray-click", label: "Hide cameras" },
        { at: 9500, do: "tray-click", label: "Bring cameras to front" },
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
  const sameBounds = (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  check("Garage Hide all clicked in the camera list", hideB?.value === true, hideB?.error);
  check("Hide all hid only Garage's window and paused its stream",
    afterHideB[keys.ramp]?.visible === false && afterHideB[keys.ramp]?.status === "paused" && afterHideB[keys.lobby]?.visible && afterHideB[keys.dock]?.visible,
    `${vis(afterHideB)} ramp=${afterHideB[keys.ramp]?.status}`);
  check("camera list shows Restore, Show cameras and a hidden camera",
    buttons?.garage?.includes("Restore") && !buttons.garage.includes("Hide all") && buttons.header === "Show cameras" && buttons.rampStatus?.includes("hidden"),
    JSON.stringify(buttons));
  check("Show cameras brought the window back live at the same place",
    afterShow[keys.ramp]?.visible === true && afterShow[keys.ramp]?.status === "live" && sameBounds(afterShow[keys.ramp]?.bounds, firstSample[keys.ramp]?.bounds),
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
      c?.visible && c.status === "live" && c.decodedFrames >= 30 && sameBounds(c.bounds, firstSample[key]?.bounds),
      c && `status=${c.status} frames=${c.decodedFrames} ${JSON.stringify(c.bounds)} vs ${JSON.stringify(firstSample[key]?.bounds)}`);
  }
  check("hidden flags cleared after Show cameras", Object.values(keys).every((k) => run2.config.windows[k]?.open === true && !run2.config.windows[k]?.hidden));
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
        mockLiveviews: [{ id: "lv1", name: "Entrances", slots: [0, 2, null, 1] }] },
      { id: B, name: "Garage", host: "mock-b", username: "m", password: null, mockCameras: ["Ramp"] },
    ],
    windows: {
      [keys.lobby]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [keys.dock]: { open: true, bounds: { x: 0, y: 290, width: 480, height: 270 }, channel: 2 },
      [keys.ramp]: { open: true, bounds: { x: 500, y: 0, width: 480, height: 270 }, channel: 2 },
    },
    settings: { startHidden: false },
  }, null, 2));

  const saveJs = `(() => {
    document.getElementById("btn-save-layout").click();
    const f = document.getElementById("layout-form");
    f.name.value = "Everything";
    f.requestSubmit();
    return true;
  })()`;
  const importJs = `(() => {
    const sel = document.getElementById("import-liveview");
    const options = [...sel.options].map((o) => o.textContent);
    sel.value = ${JSON.stringify(`${A}|lv1`)};
    sel.dispatchEvent(new Event("change"));
    return options;
  })()`;
  const applyJs = (name) => `(() => {
    const li = [...document.querySelectorAll("#layout-list li")].find((l) => l.querySelector("b")?.textContent === ${JSON.stringify(name)});
    const btn = li && [...li.querySelectorAll("button")].find((b) => b.textContent === "Apply");
    btn?.click();
    return !!btn;
  })()`;
  const { result, config } = await runApp({
    userData, results, seconds: 11, extraArgs: ["--mock"],
    env: {
      PANES_SELFTEST_ACTIONS: JSON.stringify([
        { at: 2500, do: "manager-js", js: saveJs },
        { at: 3500, do: "manager-js", js: importJs },
        { at: 5000, do: "manager-js", js: applyJs("Building · Entrances") },
        { at: 8000, do: "tray-click", label: "Everything" },
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
  const sameBounds = (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const names = config.layouts?.map((l) => l.name) ?? [];

  check("Save current layout stored the on-screen windows", names.includes("Everything") && Object.keys(config.layouts.find((l) => l.name === "Everything").windows).length === 3, JSON.stringify(names));
  check("Protect liveview offered for import", byJs("import-liveview")?.value?.includes("Entrances (3 cameras)"), JSON.stringify(byJs("import-liveview")?.value ?? byJs("import-liveview")?.error));
  check("imported liveview saved as a layout", names.includes("Building · Entrances"), JSON.stringify(names));
  check("applying the liveview layout opened exactly its cameras", applyAct?.value === true && openSet(mid) === "dock,lobby,stair", `${openSet(mid)} ${applyAct?.error ?? ""}`);
  const [l, s, d] = [mid[keys.lobby]?.bounds, mid[keys.stair]?.bounds, mid[keys.dock]?.bounds];
  check("liveview slots tiled as a 2x2 grid (lobby, stair / empty, dock)",
    l && s && d && l.x < s.x && Math.abs(l.y - s.y) < 3 && d.y > l.y && Math.abs(d.x - s.x) < 3,
    JSON.stringify({ l, s, d }));
  check("liveview layout windows live", ["lobby", "stair", "dock"].every((n) => mid[keys[n]]?.status === "live"),
    JSON.stringify(["lobby", "stair", "dock"].map((n) => mid[keys[n]]?.status)));
  check("tray Layouts switched back: same windows at the same places",
    openSet(end) === "dock,lobby,ramp" && ["lobby", "dock", "ramp"].every((n) => sameBounds(end[keys[n]]?.bounds, first[keys[n]]?.bounds) && end[keys[n]]?.status === "live"),
    `${openSet(end)} ${JSON.stringify(["lobby", "dock", "ramp"].map((n) => [end[keys[n]]?.bounds, first[keys[n]]?.bounds]))}`);
  check("window left out of the layout is closed in config", config.windows[keys.stair]?.open === false);
  console.log(`  results: ${results}`);
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
    consoles: [{ id: A, name: "Building", host: "mock-a", username: "m", password: null, mockCameras: ["Shadows", "Shadows Limited"] }],
    windows: {
      [`${A}/aaaaaaaa-cam0`]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2 },
      [`${A}/aaaaaaaa-cam1`]: { open: true, bounds: { x: 500, y: 0, width: 480, height: 270 }, channel: 2, range: "limited" },
    },
    settings: { startHidden: true, showNames: false },
  }, null, 2));
  const { result } = await runApp({ userData, results, seconds: 6, extraArgs: ["--mock"] });
  const shot = (suffix) => path.join(results, Object.keys(result.windows).find((n) => n.endsWith(suffix)) ?? "missing.png");
  const auto = { left: regionLuma(shot("Building_Shadows.png"), [0.1, 0.15, 0.3, 0.6]), right: regionLuma(shot("Building_Shadows.png"), [0.6, 0.15, 0.3, 0.6]) };
  const limited = { right: regionLuma(shot("Shadows_Limited.png"), [0.6, 0.15, 0.3, 0.6]) };
  const live = Object.values(last(result)).every((c) => c.status === "live");
  check("both shadow cameras live", live);
  check("Auto shows full-range shadows (Y=24 displays ~24, not crushed)", auto.right > 19 && auto.right < 29 && auto.left < 4, JSON.stringify(auto));
  check("Limited override shows the crushed TV-range reading (~9)", limited.right > 4 && limited.right < 14, JSON.stringify(limited));
  console.log(`  results: ${dir}  ${results}`);
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

    const importJs = `(() => {
      const sel = document.getElementById("import-liveview");
      const options = [...sel.options].map((o) => o.textContent);
      sel.value = [...sel.options].find((o) => o.parentElement.label === "Building")?.value ?? "";
      sel.dispatchEvent(new Event("change"));
      return options;
    })()`;
    const { result, config } = await runApp({
      userData, results, seconds: 16,
      env: { PANES_SELFTEST_ACTIONS: JSON.stringify([{ at: 5000, do: "manager-js", js: importJs }]) },
    });
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
    const opts = result.actions[0]?.value ?? [];
    check("Protect liveviews read through the library", opts.includes("Building Entrances (3 cameras)") && opts.includes("Garage Entrances (3 cameras)"), JSON.stringify(result.actions[0]?.value ?? result.actions[0]?.error));
    const imported = config.layouts?.find((l) => l.name === "Building · Building Entrances");
    const slotKeys = [1, 0, 2].map((i) => `${ids.B}/${cam(P.building, i)}`);
    const ib = slotKeys.map((k) => imported?.windows[k]?.bounds);
    check("imported liveview: first camera of each slot, empty slot skipped, grid order kept",
      imported && Object.keys(imported.windows).length === 3 && ib.every(Boolean) && ib[0].x < ib[1].x && ib[2].y > ib[0].y && Math.abs(ib[2].x - ib[1].x) < 3,
      JSON.stringify(imported && Object.keys(imported.windows)));
    console.log(`  results: ${results}`);
  } finally {
    for (const s of servers) s.kill();
  }
}

// ---------------------------------------------------------------------------------------------

try {
  if (suite === "mock" || suite === "all") await mockSuite();
  if (suite === "hide" || suite === "all") await hideSuite();
  if (suite === "range" || suite === "all") await rangeSuite();
  if (suite === "layouts" || suite === "all") await layoutsSuite();
  if (suite === "e2e" || suite === "all") await e2eSuite();
} catch (err) {
  console.error(`\nTest run failed: ${err.message}`);
  failures++;
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
