#!/usr/bin/env node
/*
 * Checks this checkout of the app against your real consoles: every camera Protect says is online
 * has to show moving video, door readers included. Run it after a UniFi OS or Protect update on a
 * console, and before a release that changes unifi-protect or the streaming code.
 *
 *   npm run check:real                  (or: node scripts/check-real-consoles.mjs)
 *   npm run check:real -- --names       also print camera names
 *   npm run check:real -- --seconds 45  stream longer (default 30)
 *   npm run check:real -- --from <dir>  settings folder (default %APPDATA%\Protect Panes)
 *
 * Read-only, and it leaves your setup alone:
 * - config.json and Local State (which holds the key to the saved passwords) are copied into a
 *   scratch folder, and the app runs on that copy. The folder is deleted at the end, Ctrl+C too.
 *   An installed copy can keep running meanwhile: the scratch copy has its own instance lock.
 * - Self-test mode keeps every window invisible, unfocusable and off the taskbar, and
 *   PANES_SELFTEST_NO_CAPTURE keeps the cameras' pictures off disk.
 * - The app logs in to each console twice (camera list, then video) and streams every online camera
 *   at Low for about 30 seconds. It changes nothing on the consoles.
 * - The output names consoles and camera models, not camera names or addresses, unless --names.
 *
 * Exit code 0 when every online camera showed video, 1 when one didn't or a console didn't connect.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const showNames = args.includes("--names");
const seconds = Math.max(15, Number(opt("--seconds", 30)) || 30);
const from = opt("--from", path.join(process.env.APPDATA ?? "", "Protect Panes"));
const TILES_PER_GRID = 16; // 4 × 4

if (process.platform !== "win32") { console.error("Windows only: the saved passwords are DPAPI-protected for this Windows user."); process.exit(2); }
if (!fs.existsSync(ELECTRON)) { console.error("No Electron in node_modules: run npm ci first."); process.exit(2); }
for (const f of ["config.json", "Local State"]) {
  if (!fs.existsSync(path.join(from, f))) { console.error(`No ${f} in ${from}. Point --from at the folder of a copy that has consoles set up.`); process.exit(2); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "protect-panes-real-check-"));
let child = null;
function cleanUp() {
  child?.kill();
  // The app's processes can hold files for a moment after it exits.
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
  }
  console.error(`Couldn't delete the scratch folder ${scratch}: it holds a copy of your saved passwords' key, so delete it by hand.`);
}
process.on("SIGINT", () => { console.error("\nStopped."); cleanUp(); process.exit(130); });

const redact = (line) => line.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<address>");
const tail = (id) => `…${String(id).slice(-4)}`;

function runApp(cfg, secs, actions = []) {
  fs.writeFileSync(path.join(scratch, "config.json"), JSON.stringify(cfg, null, 2));
  const results = path.join(scratch, `results-${Date.now()}`);
  const env = {
    ...process.env, PANES_USER_DATA: scratch, PANES_SELFTEST_DIR: results, PANES_SELFTEST_SEC: String(secs),
    PANES_SELFTEST_NO_CAPTURE: "1", PANES_SELFTEST_ACTIONS: JSON.stringify(actions),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    child = spawn(ELECTRON, [ROOT], { cwd: ROOT, env, stdio: "ignore" });
    const killer = setTimeout(() => child?.kill(), (secs + 60) * 1000);
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(killer);
      child = null;
      const file = path.join(results, "result.json");
      if (fs.existsSync(file)) resolve(JSON.parse(fs.readFileSync(file, "utf8")));
      else reject(new Error("the app exited without a result"));
    });
  });
}

function logLines(levels) {
  const file = path.join(scratch, "protect-panes.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => levels.test(l));
}

async function main() {
  const base = JSON.parse(fs.readFileSync(path.join(from, "config.json"), "utf8"));
  fs.copyFileSync(path.join(from, "Local State"), path.join(scratch, "Local State"));
  if (!base.consoles?.length) throw new Error("that config has no consoles");
  // Nothing of the saved layout opens; updates and Start with Windows stay off (PANES_USER_DATA).
  const quiet = (extra) => ({
    ...base,
    windows: Object.fromEntries(Object.entries(base.windows ?? {}).map(([k, w]) => [k, { ...w, open: false }])),
    ...extra,
    settings: { ...base.settings, startHidden: true, updateSource: "" },
  });

  // 1. Each console's cameras, from the (invisible) camera list once the consoles have connected.
  console.log(`Phase 1: reading the camera lists (${base.consoles.length} console${base.consoles.length === 1 ? "" : "s"})…`);
  const list = `panes.invoke("mgr:state").then((s) => s.consoles.map((c) => ({ id: c.id, name: c.name, state: c.state, message: c.message,
    cameras: c.cameras.filter((x) => !x.stale).map((x) => ({ id: x.id, name: x.name, online: x.online, model: x.model, fisheye: x.fisheye })) })))`;
  const phase1 = await runApp(quiet({ grids: [] }), 16, [4000, 7000, 10000, 13500].map((at) => ({ at, do: "manager-js", js: list })));
  const reads = phase1.actions.filter((a) => a.ok && Array.isArray(a.value)).map((a) => a.value);
  const consoles = reads.find((r) => r.every((c) => c.state === "connected" && c.cameras.length)) ?? reads.at(-1);
  if (!consoles) throw new Error("the camera list never answered");

  // 2. Every online camera as a tile at Low, in invisible 4 × 4 grids.
  const online = consoles.flatMap((c) => c.cameras.filter((x) => x.online).map((x) => ({ key: `${c.id}/${x.id}` })));
  const tileOf = new Map(); // "<console id>/<camera id>" -> the tile's id in the samples
  const grids = [];
  for (let i = 0; i < online.length; i += TILES_PER_GRID) {
    const group = online.slice(i, i + TILES_PER_GRID);
    const n = grids.length + 1;
    grids.push({
      id: `real-check-${n}`, name: `Check ${n}`, templateId: "4x4", open: true,
      bounds: { x: 40 * n, y: 40 * n, width: 1280, height: 720 },
      tiles: Array.from({ length: TILES_PER_GRID }, (_, j) => (group[j] ? { key: group[j].key, channel: 2 } : null)),
    });
    group.forEach((cam, j) => tileOf.set(cam.key, `grid:Check ${n}#${j}`));
  }
  let result = null;
  if (online.length) {
    console.log(`Phase 2: streaming ${online.length} online camera${online.length === 1 ? "" : "s"} for ${seconds} s…`);
    result = await runApp(quiet({ grids }), seconds);
  }

  // A camera passes when it's live, has a picture, and decoded new frames over the last 5+ seconds
  // (a changed count: a stream that rebuilt starts counting again, a frozen one doesn't move).
  const samples = result?.samples ?? [];
  const last = samples.at(-1);
  const earlier = [...samples].reverse().find((s) => last && last.t - s.t >= 5000);
  let failed = 0;
  console.log("");
  for (const c of consoles) {
    const ok = c.state === "connected";
    if (!ok) failed++;
    console.log(`${c.name}: ${c.state}${c.message ? ` (${redact(c.message)})` : ""}, ${c.cameras.length} camera${c.cameras.length === 1 ? "" : "s"}`);
    for (const cam of c.cameras) {
      const label = `${(cam.model || "camera").padEnd(18)} ${showNames ? cam.name.padEnd(24) : tail(cam.id).padEnd(6)}`;
      const reader = /^UA\b/.test(cam.model) ? "  (door reader)" : "";
      if (!cam.online) { console.log(`  --    ${label} offline in Protect, not checked${reader}`); continue; }
      const tile = tileOf.get(`${c.id}/${cam.id}`);
      const s = last?.cams[tile];
      const p = earlier?.cams[tile];
      const moving = s && p && s.decodedFrames !== p.decodedFrames;
      const good = s && !s.error && s.status === "live" && s.videoWidth > 0 && s.decodedFrames > 0 && moving;
      if (!good) failed++;
      const detail = !s ? "no sample" : s.error ? `error: ${s.error}`
        : `${s.status}${s.statusText ? ` "${redact(s.statusText)}"` : ""} ${s.videoWidth}x${s.videoHeight} frames ${s.decodedFrames}${p ? ` (+${(s.decodedFrames ?? 0) - (p.decodedFrames ?? 0)})` : ""} lag ${s.lag?.toFixed(2) ?? "?"} s`;
      console.log(`  ${good ? "OK  " : "FAIL"}  ${label} ${detail}${reader}`);
    }
  }
  const problems = logLines(/\b(WARN|ERROR)\b/);
  console.log(`\nApp log: ${problems.length} warning/error line${problems.length === 1 ? "" : "s"}${problems.length && !showNames ? " (--names prints them)" : ""}.`);
  if (showNames) for (const l of problems) console.log(`  ${redact(l)}`);
  console.log(failed ? `\n${failed} problem${failed === 1 ? "" : "s"}.` : "\nEvery online camera showed moving video.");
  return failed ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`Check failed: ${err.message}`);
  for (const l of logLines(/\b(WARN|ERROR)\b/).slice(-15)) console.error(`  ${showNames ? redact(l) : redact(l).replace(/\[[^\]]*\]/g, "[…]")}`);
} finally {
  cleanUp();
}
process.exit(code);
