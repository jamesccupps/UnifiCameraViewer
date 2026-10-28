#!/usr/bin/env node
// Run the packaged build (the folder build-win.js makes) from two install folders, a plain one and
// one with spaces, "&", "%" and "'" in its name, and check its pages still get IPC answers: the
// camera list gets its state, and a camera window its title. Tests run from source, where the pages
// load from the repo; only a packaged run loads them from inside app.asar, through whatever path the
// install has. (1.4.3's own-page IPC check first failed exactly there: Chromium writes a "%" in a
// folder name raw.) No network: the one console is unreachable. The release workflow runs this.
//
//   node scripts/check-packaged.mjs "dist/Protect Panes-win32-x64"
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dist = path.resolve(process.argv[2] ?? "dist/Protect Panes-win32-x64");
if (!fs.existsSync(path.join(dist, "ProtectPanes.exe"))) {
  console.error(`no ProtectPanes.exe in ${dist}`);
  process.exit(2);
}

async function runFrom(folderName) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "pp-packaged-"));
  try {
    const app = path.join(root, folderName, "Protect Panes");
    fs.cpSync(dist, app, { recursive: true });
    const data = path.join(root, "data");
    fs.mkdirSync(data);
    const A = "aaaaaaaa-0000-4000-8000-000000000001";
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({
      version: 1,
      consoles: [{ id: A, name: "Nowhere", host: "127.0.0.1:9", username: "u", password: null }],
      windows: { [`${A}/cam1`]: { open: true, bounds: { x: 0, y: 0, width: 480, height: 270 }, channel: 2, name: "Lobby" } },
      settings: { startHidden: false, updateSource: "" },
    }));
    const results = path.join(root, "results");
    const actions = [
      { at: 4000, do: "manager-js", js: `panes.invoke("mgr:state").then((s) => s.consoles.map((c) => c.name).join())` },
      { at: 4000, do: "camera-js", win: 0, js: "document.title" },
    ];
    const child = spawn(path.join(app, "ProtectPanes.exe"), [], {
      cwd: app,
      env: { ...process.env, PANES_USER_DATA: data, PANES_SELFTEST_DIR: results, PANES_SELFTEST_SEC: "7", PANES_SELFTEST_ACTIONS: JSON.stringify(actions) },
      stdio: "ignore",
    });
    const killer = setTimeout(() => child.kill(), 60_000);
    await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(killer);
    const result = JSON.parse(fs.readFileSync(path.join(results, "result.json"), "utf8"));
    const value = (doing) => result.actions.find((a) => a.act.do === doing)?.value ?? null;
    return { folder: folderName, list: value("manager-js"), title: value("camera-js") };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let failed = 0;
for (const folder of ["Programs", "Jo & 100% O'Brien"]) {
  const r = await runFrom(folder);
  const ok = r.list === "Nowhere" && r.title === "Lobby";
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  packaged app in "${folder}": camera list ${JSON.stringify(r.list)}, camera window ${JSON.stringify(r.title)}`);
}
process.exit(failed ? 1 : 0);
