import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

/*
 * Development-only harness, active only when PANES_SELFTEST_DIR is set. Opens the camera list,
 * waits, then saves a screenshot of every window plus each camera window's playback stats
 * (lag behind live, decoded frames, rebuilds) to the folder, and exits.
 */
export function runSelfTest({ camWins, log, connections, hooks }) {
  const dir = process.env.PANES_SELFTEST_DIR;
  const waitMs = Number(process.env.PANES_SELFTEST_SEC || 20) * 1000;
  const samples = [];
  fs.mkdirSync(dir, { recursive: true });

  // PANES_SELFTEST_DUMP_SEC=n: save the first n seconds of each window's stream (init + fragments,
  // a playable fragmented MP4) as <cameraId>.mp4, for checking the encoder's color flags offline.
  const dumpSec = Number(process.env.PANES_SELFTEST_DUMP_SEC || 0);
  if (dumpSec > 0) {
    for (const cw of camWins.values()) {
      const wc = cw.win.webContents;
      const send = wc.send.bind(wc);
      const file = path.join(dir, `${cw.cameraId}.mp4`);
      let startedAt = 0;
      let done = false;
      wc.send = (channel, payload) => {
        if (!done && channel === "cam:init") {
          if (startedAt) done = true; // a second init means the stream restarted; keep the clean part
          else { startedAt = Date.now(); fs.writeFileSync(file, payload.data); }
        } else if (!done && startedAt && channel === "cam:media") {
          if (Date.now() - startedAt > dumpSec * 1000) done = true;
          else fs.appendFileSync(file, payload);
        }
        return send(channel, payload);
      };
    }
  }

  const sample = async () => {
    const row = { t: Date.now(), cams: {} };
    for (const [key, cw] of camWins) {
      try {
        const stats = await cw.win.webContents.executeJavaScript("window.__panesStats && window.__panesStats()");
        row.cams[key] = { ...stats, visible: cw.win.isVisible(), bounds: cw.win.getBounds() };
      } catch (err) { row.cams[key] = { error: String(err) }; }
    }
    samples.push(row);
  };
  const timer = setInterval(sample, 2_000);

  const findItem = (items, label) => {
    for (const i of items) {
      if (i.label === label) return i;
      const sub = i.submenu && findItem(i.submenu, label);
      if (sub) return sub;
    }
    return null;
  };
  const managerWindow = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Protect Panes");

  // PANES_SELFTEST_ACTIONS: JSON list of { at, do, win, ... } driving camera windows with real input.
  // tray-click and manager-js don't need a camera window.
  const results = [];
  const APP_ACTIONS = new Set(["tray-click", "manager-js"]);
  for (const act of JSON.parse(process.env.PANES_SELFTEST_ACTIONS || "[]")) {
    setTimeout(async () => {
      let value;
      if (APP_ACTIONS.has(act.do)) {
        try {
          if (act.do === "tray-click") {
            const item = findItem(hooks.trayMenuTemplate(), act.label);
            if (!item?.click) throw new Error(`no tray item "${act.label}"`);
            item.click(item);
          } else {
            const mgr = managerWindow();
            if (!mgr) throw new Error("camera list isn't open");
            value = await mgr.webContents.executeJavaScript(act.js);
          }
          results.push({ act, ok: true, t: Date.now(), value });
        } catch (err) {
          results.push({ act, error: String(err), t: Date.now() });
        }
        return;
      }
      const cw = [...camWins.values()][act.win ?? 0];
      if (!cw) { results.push({ act, error: "no window" }); return; }
      const wc = cw.win.webContents;
      const mouse = (type, [x, y], extra = {}) => wc.sendInputEvent({ type, x, y, button: "left", clickCount: 1, ...extra });
      try {
        switch (act.do) {
          case "drag": {
            mouse("mouseDown", act.from);
            const steps = 10;
            for (let i = 1; i <= steps; i++) {
              const x = act.from[0] + ((act.to[0] - act.from[0]) * i) / steps;
              const y = act.from[1] + ((act.to[1] - act.from[1]) * i) / steps;
              mouse("mouseMove", [Math.round(x), Math.round(y)]);
              await new Promise((r) => setTimeout(r, 20));
            }
            mouse("mouseUp", act.to);
            break;
          }
          case "wheel":
            wc.sendInputEvent({ type: "mouseWheel", x: act.pos[0], y: act.pos[1], deltaX: 0, deltaY: act.dy, canScroll: true });
            break;
          case "dblclick":
            mouse("mouseDown", act.pos, { clickCount: 1 }); mouse("mouseUp", act.pos, { clickCount: 1 });
            mouse("mouseDown", act.pos, { clickCount: 2 }); mouse("mouseUp", act.pos, { clickCount: 2 });
            break;
          case "menu": {
            const { Menu } = await import("electron");
            const tpl = hooks.cameraContextMenuTemplate(cw);
            Menu.buildFromTemplate(tpl);
            const labels = (items) => items.map((i) => i.type === "separator" ? "--" : i.submenu ? { [i.label]: labels(i.submenu) } : `${i.checked ? "[x] " : ""}${i.label}`);
            results.push({ act, menu: labels(tpl) });
            break;
          }
          case "dewarp":
            hooks.updateDewarp(cw, act.changes);
            break;
          case "command":
            hooks.sendCommand(cw, act.cmd);
            break;
          case "key":
            wc.sendInputEvent({ type: "keyDown", keyCode: act.key });
            wc.sendInputEvent({ type: "keyUp", keyCode: act.key });
            break;
          case "resize":
            cw.win.setSize(act.size[0], act.size[1]);
            break;
          case "menu-click": {
            const item = findItem(hooks.cameraContextMenuTemplate(cw), act.label);
            if (!item?.click) throw new Error(`no menu item "${act.label}"`);
            item.click(item);
            break;
          }
        }
        results.push({ act, ok: true, t: Date.now(), value });
      } catch (err) {
        results.push({ act, error: String(err) });
      }
    }, act.at);
  }

  // Optionally drive the camera list like a user would (dev only).
  if (process.env.PANES_SELFTEST_MANAGER_JS) {
    setTimeout(async () => {
      const mgr = managerWindow();
      try {
        const out = await mgr.webContents.executeJavaScript(process.env.PANES_SELFTEST_MANAGER_JS);
        fs.writeFileSync(path.join(dir, "manager-script.json"), JSON.stringify(out, null, 2));
      } catch (err) {
        fs.writeFileSync(path.join(dir, "manager-script.json"), JSON.stringify({ error: String(err) }));
      }
    }, 1_500);
  }

  setTimeout(async () => {
    clearInterval(timer);
    await sample();
    const result = { connections: {}, windows: {}, samples, actions: results };
    for (const [id, c] of connections) result.connections[id] = { state: c.state, message: c.message, cameras: c.cameras().length };
    if (process.env.PANES_SELFTEST_SHOWBAR) {
      for (const cw of camWins.values()) await cw.win.webContents.executeJavaScript("document.getElementById('bar').style.opacity = 1").catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    let i = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isVisible()) continue;
      const img = await win.webContents.capturePage();
      const name = `${String(i++).padStart(2, "0")}-${win.getTitle().replace(/[^a-z0-9]+/gi, "_")}.png`;
      fs.writeFileSync(path.join(dir, name), img.toPNG());
      result.windows[name] = win.getBounds();
    }
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    log.info(`self-test written to ${dir}`);
    app.exit(0);
  }, waitMs);
}
