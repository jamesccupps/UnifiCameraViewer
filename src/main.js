import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CameraStream } from "./camera-stream.js";
import { ConsoleConnection, channelList, fisheyeInfo, resolveChannel } from "./console-connection.js";
import { autoGrid, cellRects, channelForTile, fitAspect, readingOrder, templateById, TEMPLATES } from "./grid.js";
import { createLogger } from "./log.js";
import { Previews } from "./previews.js";
import { decryptPassword, DEFAULT_SETTINGS, encryptPassword, newId, Store } from "./store.js";
import { UPDATE_PUBLIC_KEY } from "./update-key.js";
import { sourceKind, Updater } from "./updater.js";
import { debounce, normalizeHost, throttle } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");
const MOCK = process.argv.includes("--mock");
const PROJECT_URL = "https://github.com/jamesccupps/UnifiCameraViewer";
const IS_WIN = process.platform === "win32";

if (process.env.PANES_USER_DATA) app.setPath("userData", process.env.PANES_USER_DATA);
else if (MOCK) app.setPath("userData", path.join(app.getPath("appData"), "Protect Panes (mock)"));
if (IS_WIN) app.setAppUserModelId("protect-panes");
// 360° dewarping uses WebGL. If the PC's graphics driver is missing or blocklisted, let Chromium fall
// back to its CPU renderer (SwiftShader) instead of disabling WebGL. The "unsafe" in the name is
// about running untrusted web pages through it; this app only renders its own local pages.
app.commandLine.appendSwitch("enable-unsafe-swiftshader");

let store;
let log;
let tray = null;
let managerWin = null;
let quitting = false;
let updater = null;
let previews = null;

const connections = new Map(); // consoleId -> ConsoleConnection
const camWins = new Map();     // key "<consoleId>/<cameraId>" -> { key, consoleId, cameraId, win, stream, aspect }
const senders = new Map();     // webContents.id -> key

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showManager());
  app.on("window-all-closed", () => { /* keep running in the tray */ });
  app.on("before-quit", () => { quitting = true; store?.flush(); });
  app.whenReady().then(init).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}

async function init() {
  store = new Store();
  log = createLogger(path.join(app.getPath("userData"), "protect-panes.log"));
  log.info(`Protect Panes ${app.getVersion()} starting${MOCK ? " (mock mode)" : ""}`);
  Menu.setApplicationMenu(null);

  if (MOCK && !store.data.consoles.length) {
    store.data.consoles.push(
      { id: newId(), name: "Building", host: "mock-building", username: "mock", password: null },
      { id: newId(), name: "Garage", host: "mock-garage", username: "mock", password: null, mockCameras: ["Bay Door", "Ramp"] },
    );
    store.flush();
  }

  // Drop window entries whose console no longer exists.
  const consoleIds = new Set(store.data.consoles.map((c) => c.id));
  for (const key of Object.keys(store.data.windows)) {
    if (!consoleIds.has(key.split("/")[0])) delete store.data.windows[key];
  }

  updater = new Updater({
    currentVersion: app.getVersion(),
    getSource: () => store.settings.updateSource,
    publicKey: updatePublicKey(),
    stageDir: updateStageDir(),
    installKind: installKind(),
    fetch: (url, init) => net.fetch(url, init), // Chromium networking: Windows proxy settings and certificate store
    log: log.child("update"),
  });
  updater.on("state", () => { notifyManager(); updateTrayMenu(); });
  previews = new Previews({
    getCamera: (key) => { const [consoleId, cameraId] = key.split("/"); return connections.get(consoleId)?.camera(cameraId); },
    log: log.child("preview"),
  });

  createTray();
  applyLoginItem();
  registerIpc();
  // At startup only say whether there's an update; downloading waits for a click.
  if (sourceKind(store.settings.updateSource)) updater.check({ download: false });

  const MockConnection = MOCK ? (await import("./mock.js")).MockConnection : null;
  for (const cfg of store.data.consoles) startConnection(cfg, MockConnection);

  // Hidden windows ("Hide cameras") stay part of the layout but aren't created until shown.
  const openKeys = Object.entries(store.data.windows).filter(([, w]) => w.open && !w.hidden).map(([k]) => k);
  for (const key of openKeys) openCameraWindow(key);

  if (!store.data.consoles.length || !openKeys.length || !store.settings.startHidden) showManager();

  if (process.env.PANES_SELFTEST_DIR) {
    (await import("./selftest.js")).runSelfTest({ camWins, log, connections, store, hooks: { cameraContextMenuTemplate, trayMenuTemplate, updateDewarp, sendCommand } });
  }
}

// ---------------------------------------------------------------------------------------------
// Consoles

function startConnection(cfg, MockConnection = null) {
  const conn = MockConnection
    ? new MockConnection(cfg)
    : new ConsoleConnection(cfg, () => decryptPassword(cfg.password), log.child(cfg.name || cfg.host));
  conn.on("state", () => {
    notifyManager();
    for (const cw of camWins.values()) {
      if (cw.consoleId !== cfg.id) continue;
      cw.stream?.kick();
      if (conn.state === "connected") refreshCameraMeta(cw);
    }
  });
  connections.set(cfg.id, conn);
  conn.start();
  return conn;
}

async function saveConsole(input) {
  const name = String(input?.name ?? "").trim().slice(0, 60);
  const host = normalizeHost(input?.host);
  const username = String(input?.username ?? "").trim();
  const password = String(input?.password ?? "");
  if (!host) throw new Error("Enter the console's IP address or hostname.");
  if (!username) throw new Error("Enter the local account username.");

  let cfg = store.data.consoles.find((c) => c.id === input?.id);
  if (!cfg) {
    if (!password) throw new Error("Enter the password.");
    cfg = { id: newId(), name: name || host, host, username, password: encryptPassword(password) };
    store.data.consoles.push(cfg);
    store.flush();
    startConnection(cfg);
  } else {
    Object.assign(cfg, { name: name || host, host, username });
    if (password) cfg.password = encryptPassword(password);
    store.flush();
    await connections.get(cfg.id)?.restart(cfg);
  }
  notifyManager();
  return cfg.id;
}

async function removeConsole(id) {
  for (const cw of [...camWins.values()]) if (cw.consoleId === id) cw.win.close();
  for (const key of Object.keys(store.data.windows)) if (key.startsWith(`${id}/`)) delete store.data.windows[key];
  store.data.consoles = store.data.consoles.filter((c) => c.id !== id);
  store.flush();
  const conn = connections.get(id);
  connections.delete(id);
  await conn?.stop();
  notifyManager();
}

// ---------------------------------------------------------------------------------------------
// Camera windows

// Every explicit open (switch, Find, Show all, Show cameras) ends with the window on screen, so it
// also clears a "hidden" flag.
function openCameraWindow(key, { focus = false, flash = true } = {}) {
  const existing = camWins.get(key);
  if (existing) {
    const entry = store.data.windows[key];
    if (entry?.hidden) {
      delete entry.hidden;
      store.save();
      existing.stream.resume();
      updateTrayMenu();
      notifyManager();
    }
    existing.win.showInactive();
    existing.win.moveTop();
    if (flash) highlight(existing);
    return;
  }
  const [consoleId, cameraId] = key.split("/");
  if (!consoleId || !cameraId || !store.data.consoles.some((c) => c.id === consoleId)) return;

  const entry = (store.data.windows[key] ??= { open: true, bounds: null, channel: null, onTop: false, name: "" });
  entry.open = true;
  delete entry.hidden;
  store.save();

  const s = store.settings;
  const bounds = fitBounds(entry.bounds) ?? nextDefaultBounds();
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    show: false,
    resizable: !s.lockLayout,
    movable: !s.lockLayout,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    minWidth: 160,
    minHeight: 90,
    alwaysOnTop: !!entry.onTop,
    skipTaskbar: !!s.hideFromTaskbar,
    backgroundColor: "#000000",
    title: cameraTitle(key),
    icon: path.join(ASSETS, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload-camera.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  const wcId = win.webContents.id;
  const cw = { key, consoleId, cameraId, win, stream: null, aspect: null };
  camWins.set(key, cw);
  senders.set(wcId, key);

  cw.stream = new CameraStream({
    getConnection: () => connections.get(consoleId),
    cameraId,
    resolveChannel: (cam) => resolveChannel(cam, store.data.windows[key]?.channel),
    getRange: () => store.data.windows[key]?.range ?? "auto",
    send: (channel, payload) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); },
    log: log.child(`cam ${cameraId.slice(-6)}`),
  });

  win.loadFile(path.join(__dirname, "renderer", "camera.html"));
  if (process.env.PANES_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
  // Never steal focus from whatever the operator is using (exacqVision etc.).
  win.once("ready-to-show", () => { if (focus) win.show(); else win.showInactive(); });
  // Arrange and the editor's "Use what's on screen" count only visible windows, per screen. The
  // notify at the end of openCamera comes before ready-to-show, so tell the list on each change.
  for (const ev of ["show", "hide", "minimize", "restore"]) win.on(ev, notifyManager);

  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    entry.bounds = win.getBounds();
    store.save();
    notifyManager(); // it may be on another screen now
  }, 250);
  win.on("move", saveBounds);
  win.on("resize", saveBounds);
  win.on("minimize", () => cw.stream.pause());
  win.on("restore", () => cw.stream.resume());
  win.on("closed", () => {
    cw.stream.stop();
    camWins.delete(key);
    senders.delete(wcId);
    if (!quitting) {
      entry.open = false;
      delete entry.hidden;
      store.save();
      updateTrayMenu();
      notifyManager();
    }
  });
  updateTrayMenu();
  notifyManager();
}

function closeCamera(key) {
  const cw = camWins.get(key);
  if (cw) return cw.win.close();
  // A window hidden at launch was never created; just drop it from the layout.
  const entry = store.data.windows[key];
  if (!entry?.open) return;
  entry.open = false;
  delete entry.hidden;
  store.save();
  updateTrayMenu();
  notifyManager();
}

// ---------------------------------------------------------------------------------------------
// Hide cameras / Show cameras: take the on-screen windows away and put exactly those back later,
// at the same places. Hidden windows pause their streams like minimized ones (no bandwidth, no
// decode) and keep their renderer, so Show only has to wait for a keyframe.

const hiddenKeys = (consoleId = null) => Object.entries(store.data.windows)
  .filter(([key, w]) => w.open && w.hidden && (!consoleId || key.startsWith(`${consoleId}/`)))
  .map(([key]) => key);

function hideCameras(consoleId = null) {
  for (const cw of camWins.values()) {
    if (consoleId && cw.consoleId !== consoleId) continue;
    const entry = store.data.windows[cw.key];
    // Minimized windows aren't on screen, so they aren't part of what Show brings back.
    if (!entry || entry.hidden || cw.win.isDestroyed() || cw.win.isMinimized()) continue;
    entry.hidden = true;
    cw.stream.pause();
    cw.win.hide();
  }
  store.save();
  updateTrayMenu();
  notifyManager();
}

function showHiddenCameras(consoleId = null) {
  for (const key of hiddenKeys(consoleId)) openCameraWindow(key, { flash: false });
  updateTrayMenu();
  notifyManager();
}

/** "Close all": the opposite of Show all. Each camera keeps its saved place for next time. */
function closeAllCameras(consoleId) {
  for (const [key, w] of Object.entries(store.data.windows)) {
    if (w.open && key.startsWith(`${consoleId}/`)) closeCamera(key);
  }
}

/** "Show all": every camera on the console except the ones hidden from the list. */
function openAllCameras(consoleId) {
  for (const cam of connections.get(consoleId)?.cameras() ?? []) {
    const key = `${consoleId}/${cam.id}`;
    if (!store.data.windows[key]?.listHidden) openCameraWindow(key);
  }
}

/**
 * Hide from list: for cameras nobody uses right now (often offline). They move to the bottom of
 * their console in the camera list, Show all and the layout editor skip them, and the window closes.
 */
function setListHidden(key, hidden) {
  const [consoleId, cameraId] = key.split("/");
  if (!cameraId || !store.data.consoles.some((c) => c.id === consoleId)) return;
  const entry = (store.data.windows[key] ??= { open: false, bounds: null, channel: null, onTop: false, name: "" });
  if (hidden) {
    entry.listHidden = true;
    if (entry.open) closeCamera(key);
  } else {
    delete entry.listHidden;
  }
  store.save();
  notifyManager();
}

// ---------------------------------------------------------------------------------------------
// Arrange windows: tile the camera windows on one screen into a layout (src/grid.js).

const onScreenWindows = () => [...camWins.values()].filter((cw) => !cw.win.isDestroyed() && cw.win.isVisible()
  && !cw.win.isMinimized() && !store.data.windows[cw.key]?.hidden);

/** The screen to arrange: the one the camera list is on, else the one under the mouse. */
function arrangeDisplay(fromManager) {
  if (fromManager && managerWin && !managerWin.isDestroyed() && managerWin.isVisible()) return screen.getDisplayMatching(managerWin.getBounds());
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/**
 * Tile the windows on `display` (or, if none are there yet, every window on screen) into the
 * template, keeping their current reading order. Windows past the template's last cell are left
 * where they are. With "Match quality to tile size" on, each camera's channel follows its tile.
 */
function arrangeWindows(templateId = "auto", display = arrangeDisplay(false)) {
  const area = display.workArea;
  const all = onScreenWindows();
  let wins = all.filter((cw) => screen.getDisplayMatching(cw.win.getBounds()).id === display.id);
  if (!wins.length) wins = all;
  if (!wins.length) return { arranged: 0, left: 0 };
  wins = readingOrder(wins, (cw) => cw.win.getBounds());
  const tpl = templateId === "auto" ? autoGrid(wins.length, area) : templateById(templateId);
  if (!tpl) throw new Error(`unknown layout ${templateId}`);
  const rects = cellRects(tpl, area);
  const n = Math.min(wins.length, rects.length);
  for (let i = 0; i < n; i++) {
    const cw = wins[i];
    const b = fitAspect(rects[i], cw.aspect ?? 16 / 9);
    if (cw.win.isMaximized()) cw.win.unmaximize();
    cw.win.setBounds(b);
    if (store.settings.arrangeQuality) {
      const ch = channelForTile(b.width * display.scaleFactor);
      if (store.data.windows[cw.key]?.channel !== ch) setChannel(cw, ch);
    }
  }
  store.save();
  notifyManager();
  return { arranged: n, left: wins.length - n };
}

// ---------------------------------------------------------------------------------------------
// Named layouts: a saved set of on-screen windows with their places and per-window settings.
// Applying one closes the windows it doesn't include and opens or moves the ones it does.

const LAYOUT_FIELDS = ["bounds", "channel", "onTop", "hideName", "clock", "range", "picture", "dewarp"];

function layoutEntry(key) {
  const entry = store.data.windows[key] ?? {};
  const cw = camWins.get(key);
  const out = {};
  for (const f of LAYOUT_FIELDS) if (entry[f] !== undefined) out[f] = structuredClone(entry[f]);
  if (cw && !cw.win.isDestroyed() && !cw.win.isMinimized() && !cw.win.isMaximized()) out.bounds = cw.win.getBounds();
  return out;
}

function putLayout(name, windows, { editor = undefined, replaceId = null } = {}) {
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) throw new Error("Give the layout a name.");
  if (!Object.keys(windows).length) throw new Error("There are no camera windows on screen to save.");
  const existing = store.data.layouts.find((l) => l.id === replaceId)
    ?? store.data.layouts.find((l) => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    Object.assign(existing, { name: clean, windows });
    if (editor) existing.editor = editor;
    else delete existing.editor;
  } else {
    store.data.layouts.push({ id: newId(), name: clean, windows, ...(editor && { editor }) });
  }
  store.save();
  updateTrayMenu();
  notifyManager();
  return (existing ?? store.data.layouts.at(-1)).id;
}

function saveCurrentLayout(name) {
  const windows = {};
  for (const [key, w] of Object.entries(store.data.windows)) {
    if (w.open && !w.hidden && camWins.has(key)) windows[key] = layoutEntry(key);
  }
  return putLayout(name, windows);
}

function applyLayout(id) {
  const layout = store.data.layouts.find((l) => l.id === id);
  if (!layout) return;
  const consoleIds = new Set(store.data.consoles.map((c) => c.id));
  const want = Object.entries(layout.windows).filter(([key]) => consoleIds.has(key.split("/")[0]));
  const wantKeys = new Set(want.map(([key]) => key));
  for (const [key, w] of Object.entries(store.data.windows)) if (w.open && !wantKeys.has(key)) closeCamera(key);
  for (const [key, saved] of want) {
    const entry = (store.data.windows[key] ??= { open: false, bounds: null, channel: null, onTop: false, name: "" });
    const restart = entry.channel !== (saved.channel ?? null) || (entry.range ?? "auto") !== (saved.range ?? "auto");
    for (const f of LAYOUT_FIELDS) {
      if (saved[f] === undefined) delete entry[f];
      else entry[f] = structuredClone(saved[f]);
    }
    entry.channel ??= null;
    const cw = camWins.get(key);
    if (cw && !cw.win.isDestroyed()) {
      if (cw.win.isMaximized()) cw.win.unmaximize();
      const b = fitBounds(entry.bounds);
      if (b) cw.win.setBounds(b);
      applyAspect(cw);
      cw.win.setAlwaysOnTop(!!entry.onTop, "floating");
      if (restart) cw.stream.restart();
      setTimeout(() => refreshCameraMeta(cw), restart ? 50 : 0);
    }
    openCameraWindow(key, { flash: false }); // creates it, or un-hides and raises it
  }
  store.save();
  updateTrayMenu();
  notifyManager();
}

function deleteLayout(id) {
  store.data.layouts = store.data.layouts.filter((l) => l.id !== id);
  store.save();
  updateTrayMenu();
  notifyManager();
}

/**
 * Turn a Protect liveview into a layout: its slots tiled as an even grid on the display the camera
 * list is on, each window the largest 16:9 that fits its cell. Protect's uneven layouts (one big
 * tile plus small ones) become even grids. The cameras keep their current per-window settings.
 */
function importLiveview(consoleId, liveviewId) {
  const conn = connections.get(consoleId);
  const lv = conn?.liveviews?.().find((l) => l.id === liveviewId);
  if (!lv) throw new Error("That liveview isn't on the console any more.");
  const n = Math.max(1, lv.slots.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const area = (managerWin && !managerWin.isDestroyed() ? screen.getDisplayMatching(managerWin.getBounds()) : screen.getPrimaryDisplay()).workArea;
  const cellW = Math.floor(area.width / cols);
  const cellH = Math.floor(area.height / rows);
  const width = Math.max(160, Math.floor(Math.min(cellW, (cellH * 16) / 9)));
  const height = Math.max(90, Math.floor((width * 9) / 16));
  const windows = {};
  lv.slots.forEach((cameraId, i) => {
    if (!cameraId) return;
    const key = `${consoleId}/${cameraId}`;
    const col = i % cols;
    const row = Math.floor(i / cols);
    windows[key] = {
      ...layoutEntry(key),
      bounds: {
        x: area.x + col * cellW + Math.floor((cellW - width) / 2),
        y: area.y + row * cellH + Math.floor((cellH - height) / 2),
        width,
        height,
      },
    };
  });
  return putLayout(`${consoleName(consoleId)} · ${lv.name}`, windows);
}

// ---------------------------------------------------------------------------------------------
// Layout editor (camera list → Layouts → New layout…): a template on a chosen screen, with a camera
// dragged into each cell. The renderer only sends ids; bounds are computed here with grid.js.

const VIEW_MODES = ["quad", "single", "panorama", "off"];

function screensForEditor() {
  const primary = screen.getPrimaryDisplay().id;
  const all = onScreenWindows();
  // Physical pixels, for the label only. Electron rounds the DIP size (3440 px at 150% = 2293.33 →
  // 2294 DIP → 3441), and nothing exposes the panel's own size. Panels are even-sized, so an odd
  // result is that rounding: snap it to even. Layout math uses the exact work area, not this.
  const even = (v) => (v % 2 ? v - 1 : v);
  const px = (d) => ({ width: even(Math.round(d.size.width * d.scaleFactor)), height: even(Math.round(d.size.height * d.scaleFactor)) });
  return screen.getAllDisplays()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d, i) => ({
      id: d.id,
      label: `Screen ${i + 1}${d.id === primary ? " (main)" : ""} · ${px(d).width}×${px(d).height}`,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === primary,
      onScreen: readingOrder(all.filter((cw) => screen.getDisplayMatching(cw.win.getBounds()).id === d.id), (cw) => cw.win.getBounds()).map((cw) => cw.key),
    }));
}

/** Validate an editor submission and turn it into layout windows; returns the layout id. */
function saveEditorLayout(input) {
  const tpl = templateById(String(input?.templateId ?? ""));
  if (!tpl?.cells) throw new Error("Pick a layout.");
  const display = screen.getAllDisplays().find((d) => d.id === Number(input?.displayId)) ?? screen.getPrimaryDisplay();
  const consoleIds = new Set(store.data.consoles.map((c) => c.id));
  const rects = cellRects(tpl, display.workArea);
  const cells = (Array.isArray(input?.cells) ? input.cells : []).slice(0, tpl.cells.length).map((c) => {
    const key = typeof c?.key === "string" ? c.key : "";
    if (!consoleIds.has(key.split("/")[0]) || !key.split("/")[1]) return null;
    return { key, mode: VIEW_MODES.includes(c.mode) ? c.mode : "quad" };
  });
  const windows = {};
  cells.forEach((c, i) => {
    if (!c || windows[c.key]) return; // a camera goes in one cell only
    const entry = layoutEntry(c.key);
    const cw = camWins.get(c.key);
    const bounds = fitAspect(rects[i], cw?.aspect ?? 16 / 9);
    const out = { ...entry, bounds };
    if (store.settings.arrangeQuality) out.channel = channelForTile(bounds.width * display.scaleFactor);
    const cam = connections.get(c.key.split("/")[0])?.camera(c.key.split("/")[1]);
    const fisheye = cam ? fisheyeInfo(cam).fisheye : !!entry.dewarp;
    if (fisheye) {
      const base = entry.dewarp ?? defaultDewarp(cam ? fisheyeInfo(cam).mount : "ceiling");
      out.dewarp = { ...structuredClone(base), mode: c.mode === "single" ? "quad" : c.mode, focus: c.mode === "single" ? Math.max(0, base.focus ?? 0) : -1 };
    }
    windows[c.key] = out;
  });
  if (!Object.keys(windows).length) throw new Error("Drag at least one camera into the layout.");
  const id = putLayout(input?.name, windows, {
    replaceId: typeof input?.id === "string" ? input.id : null,
    editor: { displayId: display.id, templateId: tpl.id, cells },
  });
  if (input?.apply) applyLayout(id);
  return id;
}

function cameraTitle(key) {
  const [consoleId, cameraId] = key.split("/");
  const conn = connections.get(consoleId);
  let name = "";
  try { name = conn?.camera(cameraId)?.name ?? ""; } catch { /* ignore */ }
  const entry = store.data.windows[key];
  if (name && entry && entry.name !== name) { entry.name = name; store.save(); }
  return name || entry?.name || "Camera";
}

function consoleName(consoleId) {
  return store.data.consoles.find((c) => c.id === consoleId)?.name ?? "";
}

function cameraMeta(cw) {
  const entry = store.data.windows[cw.key] ?? {};
  const conn = connections.get(cw.consoleId);
  const cam = conn?.camera(cw.cameraId);
  const multi = store.data.consoles.length > 1;
  ensureDewarp(cw, cam);
  return {
    title: cameraTitle(cw.key),
    consoleName: multi ? consoleName(cw.consoleId) : "",
    // The global setting is the master switch; hideName turns the label off for one window.
    showNames: !!store.settings.showNames && !entry.hideName,
    clock: showClock(entry),
    locked: !!store.settings.lockLayout,
    onTop: !!entry.onTop,
    channel: cw.stream?.channel ?? entry.channel ?? null,
    channels: cam ? channelList(cam).map(({ id, label }) => ({ id, label })) : [],
    fisheye: cam ? fisheyeInfo(cam).fisheye : !!entry.dewarp,
    dewarp: entry.dewarp ?? null,
    picture: entry.picture ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// 360° dewarping. The renderer does the work; main only owns the saved settings.

const DEWARP_MODES = ["off", "quad", "panorama"];
const MOUNTS = ["ceiling", "wall", "desk"];

function defaultViews(mount) {
  // Quad order: top-left, top-right, bottom-left, bottom-right.
  // Wall: four 45°-wide views tiling the lens's 180° (26° tall at 16:9).
  if (mount === "wall") return [-67.5, -22.5, 22.5, 67.5].map((pan) => ({ pan, tilt: -5, fov: 26 }));
  const tilt = mount === "desk" ? 35 : -35;
  return [0, 90, -90, 180].map((pan) => ({ pan, tilt, fov: 62 }));
}

function defaultDewarp(mount, mode = "quad") {
  const m = MOUNTS.includes(mount) ? mount : "ceiling";
  return {
    mode,
    mount: m,
    lensFov: 180,
    circle: null, // auto-detected from the picture on first view
    views: defaultViews(m),
    focus: -1,
    pano: { pan: 0, tilt: m === "wall" ? 0 : m === "desk" ? 35 : -35 },
  };
}

/** First time a 360° camera is shown, switch it to quad view with the mount Protect reports. */
function ensureDewarp(cw, cam) {
  const entry = store.data.windows[cw.key];
  if (!entry || entry.dewarp !== undefined || !cam) return;
  const info = fisheyeInfo(cam);
  entry.dewarp = info.fisheye ? defaultDewarp(info.mount) : null;
  store.save();
}

function updateDewarp(cw, changes) {
  const entry = store.data.windows[cw.key];
  if (!entry) return;
  const cam = connections.get(cw.consoleId)?.camera(cw.cameraId);
  const d = entry.dewarp ?? defaultDewarp(cam ? fisheyeInfo(cam).mount : "ceiling", "off");
  if (changes.mount && changes.mount !== d.mount) {
    // New mount = new geometry; start the views over.
    d.views = defaultViews(changes.mount);
    d.pano = defaultDewarp(changes.mount).pano;
    d.focus = -1;
  }
  Object.assign(d, changes);
  entry.dewarp = d;
  store.save();
  refreshCameraMeta(cw);
}

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
// Wrap to (-180, 180] so 180 stays 180.
const angle = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const a = ((v % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
};

/** Merge pan/tilt/zoom, focus and circle edits coming back from a camera window. */
function saveDewarpFromRenderer(cw, patch) {
  const d = store.data.windows[cw.key]?.dewarp;
  if (!d || !patch || typeof patch !== "object") return;
  if (Array.isArray(patch.views) && patch.views.length === 4) {
    const views = patch.views.map((v) => ({ pan: angle(v?.pan), tilt: num(v?.tilt, -90, 90), fov: num(v?.fov, 10, 120) }));
    if (views.every((v) => v.pan !== null && v.tilt !== null && v.fov !== null)) d.views = views;
  }
  if (patch.pano && typeof patch.pano === "object") {
    const pan = angle(patch.pano.pan);
    const tilt = num(patch.pano.tilt, -80, 80);
    if (pan !== null && tilt !== null) d.pano = { pan, tilt };
  }
  if (Number.isInteger(patch.focus) && patch.focus >= -1 && patch.focus <= 3) d.focus = patch.focus;
  if (patch.circle && typeof patch.circle === "object") {
    const x = num(patch.circle.x, 0, 1);
    const y = num(patch.circle.y, 0, 1);
    const r = num(patch.circle.r, 0.05, 1.5);
    if (x !== null && y !== null && r !== null) d.circle = { x, y, r };
  }
  store.save();
}

/**
 * Brightness / contrast (Adjust picture…): a CSS filter in the camera window, so it's cheap and
 * cosmetic. 1 is unchanged. Returns null for "unchanged", undefined for anything invalid.
 */
function cleanPicture(p) {
  const b = num(p?.brightness, 0.5, 2);
  const c = num(p?.contrast, 0.5, 2);
  if (b === null || c === null) return undefined;
  const r = (v) => Math.round(v * 100) / 100;
  return r(b) === 1 && r(c) === 1 ? null : { brightness: r(b), contrast: r(c) };
}

function savePictureFromRenderer(cw, patch) {
  const entry = store.data.windows[cw.key];
  const pic = cleanPicture(patch);
  if (!entry || pic === undefined) return;
  if (pic) entry.picture = pic;
  else delete entry.picture;
  store.save();
}

const pictureLabel = (p) => (p ? `${Math.round(p.brightness * 100)}% brightness, ${Math.round(p.contrast * 100)}% contrast` : "normal");

function sendCommand(cw, cmd) {
  if (!cw.win.isDestroyed()) cw.win.webContents.send("cam:command", { cmd });
}

function dewarpMenu(cw) {
  const d = store.data.windows[cw.key]?.dewarp ?? null;
  const mode = d?.mode ?? "off";
  const setMode = (m) => updateDewarp(cw, { mode: m, focus: -1 });
  const needsConfig = (fn) => () => {
    if (!store.data.windows[cw.key]?.dewarp) updateDewarp(cw, {});
    fn();
  };
  // Single view is quad with one view enlarged (the same state double-click toggles).
  const single = mode === "quad" && (d?.focus ?? -1) >= 0;
  return [
    { label: "Quad view", type: "radio", checked: mode === "quad" && !single, click: () => setMode("quad") },
    { label: "Single view", type: "radio", checked: single, click: () => updateDewarp(cw, { mode: "quad", focus: single ? d.focus : 0 }) },
    { label: "Panorama", type: "radio", checked: mode === "panorama", click: () => setMode("panorama") },
    { label: "Fisheye (no dewarp)", type: "radio", checked: mode === "off", click: () => setMode("off") },
    { type: "separator" },
    {
      label: "Mount",
      submenu: MOUNTS.map((m) => ({
        label: m[0].toUpperCase() + m.slice(1),
        type: "radio",
        checked: (d?.mount ?? "ceiling") === m,
        click: () => updateDewarp(cw, { mount: m }),
      })),
    },
    {
      label: "Lens field of view",
      submenu: [180, 190, 200, 220].map((f) => ({
        label: `${f}°`,
        type: "radio",
        checked: (d?.lensFov ?? 180) === f,
        click: () => updateDewarp(cw, { lensFov: f }),
      })),
    },
    { label: "Adjust image circle…", click: needsConfig(() => sendCommand(cw, "calibrate")) },
    { label: "Auto-detect image circle", click: needsConfig(() => sendCommand(cw, "autodetect")) },
    { label: "Reset views", enabled: !!d, click: () => updateDewarp(cw, { views: defaultViews(d.mount), pano: defaultDewarp(d.mount).pano, focus: -1 }) },
  ];
}

function refreshCameraMeta(cw) {
  if (cw.win.isDestroyed()) return;
  const meta = cameraMeta(cw);
  cw.win.setTitle(meta.title);
  cw.win.webContents.send("cam:meta", meta);
}

function highlight(cw) {
  if (!cw.win.isDestroyed()) cw.win.webContents.send("cam:highlight");
}

function setChannel(cw, channel) {
  const entry = store.data.windows[cw.key];
  if (!entry || !Number.isInteger(channel)) return;
  entry.channel = channel;
  store.save();
  cw.stream.restart();
  setTimeout(() => refreshCameraMeta(cw), 50);
}

const RANGES = ["auto", "full", "limited"];
const RANGE_LABELS = { auto: "Auto (recommended)", full: "Full (0-255)", limited: "Limited (16-235)" };
const HIGH = 0;              // Protect's channel ids: 0 High, 1 Medium, 2 Low
const HIGH_WARN_WINDOWS = 6; // more High streams than this can swamp integrated-graphics decode

// ---------------------------------------------------------------------------------------------
// Apply to all cameras: copy per-window settings to every camera, open or not, so cameras
// opened later start with them too.

function allCameraKeys(consoleId = null) {
  const keys = new Set(Object.keys(store.data.windows).filter((k) => !consoleId || k.startsWith(`${consoleId}/`)));
  for (const [id, conn] of connections) {
    if (consoleId && id !== consoleId) continue;
    for (const cam of conn.cameras()) keys.add(`${id}/${cam.id}`);
  }
  return [...keys];
}

/** Keep only known settings with valid values; the camera list sends these over IPC. */
function cleanChanges(c) {
  const out = {};
  if (Number.isInteger(c?.channel) && c.channel >= 0 && c.channel < 10) out.channel = c.channel;
  for (const k of ["onTop", "hideName", "clock"]) if (typeof c?.[k] === "boolean") out[k] = c[k];
  if (RANGES.includes(c?.range)) out.range = c.range;
  if (c && "picture" in c) {
    const pic = c.picture === null ? null : cleanPicture(c.picture);
    if (pic !== undefined) out.picture = pic;
  }
  return out;
}

function applyToAll(changes, consoleId = null) {
  changes = cleanChanges(changes);
  for (const key of allCameraKeys(consoleId)) {
    const entry = (store.data.windows[key] ??= { open: false, bounds: null, channel: null, onTop: false, name: "" });
    const cw = camWins.get(key);
    let restart = false;
    if ("channel" in changes && entry.channel !== changes.channel) { entry.channel = changes.channel; restart = true; }
    if ("range" in changes && (entry.range ?? "auto") !== changes.range) {
      if (changes.range === "auto") delete entry.range;
      else entry.range = changes.range;
      restart = true;
    }
    if ("onTop" in changes) {
      entry.onTop = changes.onTop;
      cw?.win.setAlwaysOnTop(changes.onTop, "floating");
    }
    if ("hideName" in changes) {
      if (changes.hideName) entry.hideName = true;
      else delete entry.hideName;
    }
    if ("clock" in changes) entry.clock = changes.clock;
    if ("picture" in changes) {
      if (changes.picture) entry.picture = { ...changes.picture };
      else delete entry.picture;
    }
    if (!cw || cw.win.isDestroyed()) continue;
    if (restart) {
      cw.stream.restart(); // a hidden window's paused stream stays paused and picks this up on Show
      setTimeout(() => refreshCameraMeta(cw), 50);
    } else {
      refreshCameraMeta(cw);
    }
  }
  store.save();
  notifyManager();
}

const onScreenCount = () => [...camWins.values()].filter((cw) => !store.data.windows[cw.key]?.hidden).length;

/** From a camera's right-click menu; asks first before putting many windows on High. */
async function applyToAllFromWindow(cw, changes) {
  if (changes.channel === HIGH && onScreenCount() > HIGH_WARN_WINDOWS) {
    const { response } = await dialog.showMessageBox(cw.win, {
      type: "warning",
      buttons: ["Switch to High", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Switch all ${onScreenCount()} open cameras to High?`,
      detail: "High streams are up to 4K. Decoding many at once can overload integrated graphics and make every window stutter.",
    });
    if (response !== 0) return;
  }
  applyToAll(changes);
}

function applyAllMenu(cw) {
  const entry = store.data.windows[cw.key] ?? {};
  const meta = cameraMeta(cw);
  const chan = meta.channels.find((c) => c.id === meta.channel);
  const onOff = (v) => (v ? "on" : "off");
  const values = {
    ...(chan ? { channel: chan.id } : {}),
    onTop: !!entry.onTop,
    hideName: !!entry.hideName,
    clock: showClock(entry),
    range: entry.range ?? "auto",
    picture: entry.picture ?? null,
  };
  const item = (label, changes, extra = {}) => ({ label, click: () => applyToAllFromWindow(cw, changes), ...extra });
  return [
    ...(chan ? [item(`Quality: ${chan.label.split(" · ")[0]}`, { channel: chan.id })] : []),
    item(`Always on top: ${onOff(values.onTop)}`, { onTop: values.onTop }),
    item(`Show name: ${onOff(!values.hideName)}`, { hideName: values.hideName }),
    item(`Show time: ${onOff(values.clock)}`, { clock: values.clock }),
    item(`Color range: ${RANGE_LABELS[values.range].replace(" (recommended)", "")}`, { range: values.range }),
    item(`Picture: ${pictureLabel(values.picture)}`, { picture: values.picture }),
    { type: "separator" },
    item("All of the above", values),
  ];
}

function setRange(cw, range) {
  const entry = store.data.windows[cw.key];
  if (!entry || !RANGES.includes(range)) return;
  if (range === "auto") delete entry.range;
  else entry.range = range;
  store.save();
  cw.stream.restart(); // the range is applied to the init segment, so a fresh one has to be sent
}

function toggleOnTop(cw) {
  const entry = store.data.windows[cw.key];
  entry.onTop = !entry.onTop;
  cw.win.setAlwaysOnTop(entry.onTop, "floating");
  store.save();
  refreshCameraMeta(cw);
  notifyManager();
}

// Dewarped views cut the camera's own timestamp out of the picture, so they get the app's clock
// unless the window says otherwise (`clock` true/false overrides).
const showClock = (entry) => entry.clock ?? ["quad", "panorama"].includes(entry.dewarp?.mode);

function toggleClock(cw) {
  const entry = store.data.windows[cw.key];
  entry.clock = !showClock(entry);
  store.save();
  refreshCameraMeta(cw);
}

function toggleName(cw) {
  const entry = store.data.windows[cw.key];
  entry.hideName = !entry.hideName;
  store.save();
  refreshCameraMeta(cw);
}

function applyAspect(cw) {
  if (cw.win.isDestroyed()) return;
  if (!store.settings.lockAspect || !cw.aspect) {
    cw.win.setAspectRatio(0);
    return;
  }
  cw.win.setAspectRatio(cw.aspect);
  if (cw.win.isMaximized()) return;
  // Snap the current size to the video's shape so there are no black bars.
  const b = cw.win.getBounds();
  const h = Math.round(b.width / cw.aspect);
  if (Math.abs(h - b.height) > 2) cw.win.setBounds({ ...b, height: Math.max(90, h) });
}

function fitBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  // Only reuse saved bounds if a usable part of the window lands on a connected display.
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const ix = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const iy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return ix >= 100 && iy >= 60;
  });
  if (!visible) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(160, Math.round(b.width)), height: Math.max(90, Math.round(b.height)) };
}

let cascade = 0;
function nextDefaultBounds() {
  const a = screen.getPrimaryDisplay().workArea;
  const step = (cascade++ % 10) * 32;
  return { x: a.x + 80 + step, y: a.y + 80 + step, width: 480, height: 270 };
}

function tileOpenWindows() {
  // "Reset positions": cascade every open camera window back onto the primary display.
  cascade = 0;
  for (const cw of camWins.values()) {
    const b = nextDefaultBounds();
    if (cw.win.isMaximized()) cw.win.unmaximize();
    cw.win.setBounds(b);
    applyAspect(cw);
    if (!store.data.windows[cw.key]?.hidden) cw.win.showInactive();
  }
}

function bringAllToFront() {
  for (const cw of camWins.values()) {
    if (store.data.windows[cw.key]?.hidden) continue; // hidden stays hidden until Show cameras
    if (cw.win.isMinimized()) cw.win.restore();
    cw.win.showInactive();
    cw.win.moveTop();
  }
}

function cameraContextMenu(cw) {
  Menu.buildFromTemplate(cameraContextMenuTemplate(cw)).popup({ window: cw.win });
}

function cameraContextMenuTemplate(cw) {
  const entry = store.data.windows[cw.key] ?? {};
  const meta = cameraMeta(cw);
  const template = [
    { label: meta.consoleName ? `${meta.title} - ${meta.consoleName}` : meta.title, enabled: false },
    { type: "separator" },
    ...meta.channels.map((ch) => ({
      label: ch.label,
      type: "radio",
      checked: ch.id === meta.channel,
      click: () => setChannel(cw, ch.id),
    })),
    ...(meta.channels.length ? [{ type: "separator" }] : []),
    { label: meta.fisheye ? "360° view" : "360° view (fisheye lens)", submenu: dewarpMenu(cw) },
    {
      label: "Color range",
      submenu: RANGES.map((id) => ({ label: RANGE_LABELS[id], type: "radio", checked: (entry.range ?? "auto") === id, click: () => setRange(cw, id) })),
    },
    { label: "Adjust picture…", click: () => sendCommand(cw, "picture") },
    { label: "Apply to all cameras", submenu: applyAllMenu(cw) },
    { type: "separator" },
    { label: "Always on top", type: "checkbox", checked: !!entry.onTop, click: () => toggleOnTop(cw) },
    { label: "Show name", type: "checkbox", checked: meta.showNames, enabled: !!store.settings.showNames, click: () => toggleName(cw) },
    { label: "Show time", type: "checkbox", checked: meta.clock, click: () => toggleClock(cw) },
    { label: "Lock layout", type: "checkbox", checked: !!store.settings.lockLayout, click: () => setSetting("lockLayout", !store.settings.lockLayout) },
    { label: "Reconnect stream", click: () => cw.stream.restart() },
    { type: "separator" },
    { label: "Camera list…", click: () => showManager() },
    { label: "Close this camera", click: () => cw.win.close() },
  ];
  return template;
}

// ---------------------------------------------------------------------------------------------
// Settings

function setSetting(name, value) {
  if (!(name in DEFAULT_SETTINGS) || typeof value !== "boolean") return;
  store.settings[name] = value;
  store.save();
  switch (name) {
    case "lockLayout":
      for (const cw of camWins.values()) {
        cw.win.setMovable(!value);
        cw.win.setResizable(!value);
      }
      updateTrayMenu();
      break;
    case "lockAspect":
      for (const cw of camWins.values()) applyAspect(cw);
      break;
    case "hideFromTaskbar":
      for (const cw of camWins.values()) cw.win.setSkipTaskbar(value);
      break;
    case "launchAtLogin":
      applyLoginItem();
      break;
    case "showPreviews":
      if (!value) previews.clear();
      break;
  }
  for (const cw of camWins.values()) refreshCameraMeta(cw);
  notifyManager();
}

// ---------------------------------------------------------------------------------------------
// Updates (src/updater.js). Only the packaged app installs them; from source the key can be
// swapped for tests via PANES_UPDATE_PUBKEY_FILE, which a packaged build ignores.

function updatePublicKey() {
  if (!app.isPackaged && process.env.PANES_UPDATE_PUBKEY_FILE) return fs.readFileSync(process.env.PANES_UPDATE_PUBKEY_FILE, "utf8");
  return UPDATE_PUBLIC_KEY;
}

// Not in the roaming %APPDATA% profile: a 150 MB download shouldn't roam.
function updateStageDir() {
  if (process.env.PANES_USER_DATA || !process.env.LOCALAPPDATA) return path.join(app.getPath("userData"), "updates");
  return path.join(process.env.LOCALAPPDATA, "Protect Panes", "updates");
}

// ProtectPanes-Setup.exe (NSIS) leaves "Uninstall ProtectPanes.exe" next to the app. Such copies
// update by running the new installer; swapping in the zip's folder would delete the uninstaller.
function installKind() {
  if (!app.isPackaged) return "folder";
  try {
    return fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .+\.exe$/i.test(f)) ? "installer" : "folder";
  } catch {
    return "folder";
  }
}

function setUpdateSource(value) {
  const v = String(value ?? "").trim();
  if (v && !sourceKind(v)) throw new Error("Use an https:// address or a folder path, for example \\\\server\\share\\Protect Panes.");
  store.settings.updateSource = v;
  store.save();
  notifyManager();
}

function installUpdate() {
  if (!app.isPackaged) throw new Error("Updates install only into the packaged app, not when running from source.");
  updater.install({ installDir: path.dirname(process.execPath), exeName: path.basename(process.execPath), pid: process.pid });
  log.info(`installing update ${updater.state.version}; quitting so the helper can swap the folder`);
  quitting = true;
  app.quit();
}

function applyLoginItem() {
  if (!IS_WIN && process.platform !== "darwin") return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.launchAtLogin, path: process.execPath });
}

// ---------------------------------------------------------------------------------------------
// Manager window + tray

function showManager() {
  if (managerWin && !managerWin.isDestroyed()) {
    if (managerWin.isMinimized()) managerWin.restore();
    managerWin.show();
    managerWin.focus();
    return;
  }
  managerWin = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: "Protect Panes",
    backgroundColor: "#111417",
    icon: path.join(ASSETS, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-manager.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  managerWin.loadFile(path.join(__dirname, "renderer", "manager.html"));
  if (process.env.PANES_DEVTOOLS === "1") managerWin.webContents.openDevTools({ mode: "detach" });
  managerWin.once("ready-to-show", () => managerWin.show());
  managerWin.on("close", (e) => {
    // Closing the list just hides it; the cameras keep running. Quit lives in the tray/menu.
    if (!quitting) {
      e.preventDefault();
      managerWin.hide();
    }
  });
  managerWin.on("closed", () => { managerWin = null; });
}

const notifyManager = throttle(() => {
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send("mgr:changed");
}, 250);

function managerState() {
  const shown = (consoleId = null) => [...camWins.values()]
    .filter((cw) => (!consoleId || cw.consoleId === consoleId) && !store.data.windows[cw.key]?.hidden).length;
  return {
    mock: MOCK,
    settings: { ...store.settings },
    hiddenCount: hiddenKeys().length,
    shownCount: shown(),
    layouts: store.data.layouts.map((l) => ({ id: l.id, name: l.name, count: Object.keys(l.windows).length, editor: l.editor ?? null })),
    screens: screensForEditor(),
    templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, cols: t.cols ?? null, rows: t.rows ?? null, cells: t.cells ?? null })),
    onScreenCount: onScreenWindows().length,
    update: { status: updater?.state.status, version: updater?.state.version, message: updater?.state.message, current: app.getVersion() },
    consoles: store.data.consoles.map((c) => {
      const conn = connections.get(c.id);
      const live = conn?.cameras() ?? [];
      // Keep showing saved cameras while a console is offline so they can still be closed.
      const known = new Map(live.map((cam) => [cam.id, cam]));
      for (const [key, w] of Object.entries(store.data.windows)) {
        const [cid, camId] = key.split("/");
        if (cid === c.id && !known.has(camId)) known.set(camId, { id: camId, name: w.name || "Camera", online: false, model: "", channels: [], stale: true });
      }
      const cameras = [...known.values()].map((cam) => {
        const key = `${c.id}/${cam.id}`;
        const w = store.data.windows[key];
        const cw = camWins.get(key);
        const hidden = !!(w?.open && w.hidden);
        return {
          ...cam, key, open: !!cw || hidden, hidden, listHidden: !!w?.listHidden,
          channel: cw?.stream?.channel ?? w?.channel ?? null, onTop: !!w?.onTop, status: cw?.stream?.status ?? null,
        };
      });
      return {
        id: c.id,
        name: c.name,
        host: c.host,
        username: c.username,
        state: conn?.state ?? "idle",
        message: conn?.message ?? "",
        controllerName: conn?.controllerName ?? null,
        hiddenCount: hiddenKeys(c.id).length,
        shownCount: shown(c.id),
        openCount: Object.entries(store.data.windows).filter(([key, w]) => w.open && key.startsWith(`${c.id}/`)).length,
        liveviews: (conn?.liveviews?.() ?? []).map((lv) => ({ id: lv.id, name: lv.name, count: lv.slots.filter(Boolean).length })),
        cameras,
      };
    }),
  };
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, IS_WIN ? "tray.png" : "tray.png"));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("Protect Panes");
  tray.on("click", () => showManager());
  tray.on("double-click", () => showManager());
  updateTrayMenu();
}

function trayMenuTemplate() {
  return [
    { label: "Camera list…", click: () => showManager() },
    // One toggle: while anything is hidden it puts it back, otherwise it hides what's on screen.
    hiddenKeys().length
      ? { label: "Show cameras", click: () => showHiddenCameras() }
      : { label: "Hide cameras", click: () => hideCameras() },
    { label: "Bring cameras to front", click: () => bringAllToFront() },
    {
      label: "Arrange windows",
      submenu: TEMPLATES.map((t) => ({ label: t.label, click: () => arrangeWindows(t.id, arrangeDisplay(false)) })),
    },
    ...(store.data.layouts.length
      ? [{ label: "Layouts", submenu: store.data.layouts.map((l) => ({ label: l.name, click: () => applyLayout(l.id) })) }]
      : []),
    { label: "Lock layout", type: "checkbox", checked: !!store.settings.lockLayout, click: (item) => setSetting("lockLayout", item.checked) },
    { type: "separator" },
    ...(updater?.state.status === "ready"
      ? [{
        label: `Install update ${updater.state.version} and restart`,
        click: () => { try { installUpdate(); } catch (err) { dialog.showMessageBox({ type: "error", message: err.message }); } },
      }]
      : updater?.state.status === "available" ? [{ label: `Update ${updater.state.version} available…`, click: () => showManager() }] : []),
    { label: "Quit Protect Panes", click: () => { quitting = true; app.quit(); } },
  ];
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}

// ---------------------------------------------------------------------------------------------
// IPC

function registerIpc() {
  const fromCamera = (e) => {
    const key = senders.get(e.sender.id);
    return key ? camWins.get(key) : null;
  };

  ipcMain.on("cam:ready", (e) => {
    const cw = fromCamera(e);
    if (!cw) return;
    refreshCameraMeta(cw);
    cw.stream.restart();
  });
  ipcMain.on("cam:aspect", (e, size) => {
    const cw = fromCamera(e);
    const w = Number(size?.width);
    const h = Number(size?.height);
    if (!cw || !(w > 0 && h > 0)) return;
    const aspect = w / h;
    if (cw.aspect && Math.abs(cw.aspect - aspect) < 0.001) return;
    cw.aspect = aspect;
    applyAspect(cw);
  });
  ipcMain.on("cam:reset", (e, reason) => {
    const cw = fromCamera(e);
    if (!cw) return;
    log.info(`renderer requested reset for ${cw.cameraId}: ${String(reason).slice(0, 80)}`);
    cw.stream.restart();
  });
  ipcMain.on("cam:context-menu", (e) => { const cw = fromCamera(e); if (cw) cameraContextMenu(cw); });
  ipcMain.on("cam:dewarp", (e, patch) => { const cw = fromCamera(e); if (cw) saveDewarpFromRenderer(cw, patch); });
  ipcMain.on("cam:picture", (e, patch) => { const cw = fromCamera(e); if (cw) savePictureFromRenderer(cw, patch); });
  ipcMain.on("cam:toggle-top", (e) => { const cw = fromCamera(e); if (cw) toggleOnTop(cw); });
  ipcMain.on("cam:close", (e) => { const cw = fromCamera(e); if (cw) cw.win.close(); });

  const fromManager = (e) => managerWin && !managerWin.isDestroyed() && e.sender === managerWin.webContents;
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, arg) => {
    if (!fromManager(e)) return null; // only the camera list may call these
    return fn(arg);
  });

  handle("mgr:state", () => managerState());
  handle("mgr:save-console", (input) => saveConsole(input));
  handle("mgr:remove-console", (id) => removeConsole(String(id)));
  handle("mgr:reconnect", async (id) => { await connections.get(String(id))?.restart(); });
  handle("mgr:open-camera", (key) => openCameraWindow(String(key)));
  handle("mgr:close-camera", (key) => closeCamera(String(key)));
  handle("mgr:hide-cameras", (consoleId) => hideCameras(consoleId ? String(consoleId) : null));
  handle("mgr:close-all", (consoleId) => closeAllCameras(String(consoleId)));
  handle("mgr:open-log-folder", () => shell.openPath(app.getPath("userData")));
  handle("mgr:open-project", () => shell.openExternal(PROJECT_URL)); // fixed URL; the renderer can't pass one
  handle("mgr:arrange", ({ templateId } = {}) => arrangeWindows(String(templateId ?? "auto"), arrangeDisplay(true)));
  handle("mgr:show-cameras", (consoleId) => showHiddenCameras(consoleId ? String(consoleId) : null));
  handle("mgr:find-camera", (key) => openCameraWindow(String(key)));
  handle("mgr:set-channel", ({ key, channel } = {}) => {
    const k = String(key);
    const cw = camWins.get(k);
    if (cw) return setChannel(cw, Number(channel));
    const entry = (store.data.windows[k] ??= { open: false, bounds: null, channel: null, onTop: false, name: "" });
    entry.channel = Number(channel);
    store.save();
  });
  handle("mgr:set-setting", ({ name, value } = {}) => setSetting(String(name), value));
  handle("mgr:apply-all", ({ consoleId, changes } = {}) => applyToAll(changes, consoleId ? String(consoleId) : null));
  handle("mgr:set-update-source", (value) => setUpdateSource(value));
  handle("mgr:check-update", () => updater.check({ download: true }).then(() => undefined));
  handle("mgr:install-update", () => installUpdate());
  handle("mgr:save-layout", (name) => saveCurrentLayout(name));
  handle("mgr:save-editor-layout", (input) => saveEditorLayout(input));
  handle("mgr:apply-layout", (id) => applyLayout(String(id)));
  handle("mgr:delete-layout", (id) => deleteLayout(String(id)));
  handle("mgr:import-liveview", ({ consoleId, liveviewId } = {}) => importLiveview(String(consoleId), String(liveviewId)));
  handle("mgr:bring-to-front", () => bringAllToFront());
  handle("mgr:reset-positions", () => tileOpenWindows());
  handle("mgr:open-all", (consoleId) => openAllCameras(String(consoleId)));
  handle("mgr:set-list-hidden", ({ key, hidden } = {}) => setListHidden(String(key), !!hidden));
  handle("mgr:preview", (key) => (store.settings.showPreviews ? previews.get(String(key)) : null));
  handle("mgr:quit", () => { quitting = true; app.quit(); });
}
