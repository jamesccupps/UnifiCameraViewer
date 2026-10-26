import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CameraStream } from "./camera-stream.js";
import { ConsoleConnection, channelList, fisheyeInfo, resolveChannel } from "./console-connection.js";
import { createLogger } from "./log.js";
import { decryptPassword, DEFAULT_SETTINGS, encryptPassword, newId, Store } from "./store.js";
import { debounce, normalizeHost, throttle } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");
const MOCK = process.argv.includes("--mock");
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

  createTray();
  applyLoginItem();
  registerIpc();

  const MockConnection = MOCK ? (await import("./mock.js")).MockConnection : null;
  for (const cfg of store.data.consoles) startConnection(cfg, MockConnection);

  const openKeys = Object.entries(store.data.windows).filter(([, w]) => w.open).map(([k]) => k);
  for (const key of openKeys) openCameraWindow(key);

  if (!store.data.consoles.length || !openKeys.length || !store.settings.startHidden) showManager();

  if (process.env.PANES_SELFTEST_DIR) {
    (await import("./selftest.js")).runSelfTest({ camWins, log, connections, store, hooks: { cameraContextMenuTemplate, updateDewarp, sendCommand } });
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

function openCameraWindow(key, { focus = false } = {}) {
  const existing = camWins.get(key);
  if (existing) {
    existing.win.showInactive();
    existing.win.moveTop();
    highlight(existing);
    return;
  }
  const [consoleId, cameraId] = key.split("/");
  if (!consoleId || !cameraId || !store.data.consoles.some((c) => c.id === consoleId)) return;

  const entry = (store.data.windows[key] ??= { open: true, bounds: null, channel: null, onTop: false, name: "" });
  entry.open = true;
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
    send: (channel, payload) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); },
    log: log.child(`cam ${cameraId.slice(-6)}`),
  });

  win.loadFile(path.join(__dirname, "renderer", "camera.html"));
  if (process.env.PANES_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
  // Never steal focus from whatever the operator is using (exacqVision etc.).
  win.once("ready-to-show", () => { if (focus) win.show(); else win.showInactive(); });

  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    entry.bounds = win.getBounds();
    store.save();
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
      store.save();
      notifyManager();
    }
  });
  notifyManager();
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
    showNames: !!store.settings.showNames,
    locked: !!store.settings.lockLayout,
    onTop: !!entry.onTop,
    channel: cw.stream?.channel ?? entry.channel ?? null,
    channels: cam ? channelList(cam).map(({ id, label }) => ({ id, label })) : [],
    fisheye: cam ? fisheyeInfo(cam).fisheye : !!entry.dewarp,
    dewarp: entry.dewarp ?? null,
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
  return [
    { label: "Quad view", type: "radio", checked: mode === "quad", click: () => setMode("quad") },
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

function toggleOnTop(cw) {
  const entry = store.data.windows[cw.key];
  entry.onTop = !entry.onTop;
  cw.win.setAlwaysOnTop(entry.onTop, "floating");
  store.save();
  refreshCameraMeta(cw);
  notifyManager();
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
    cw.win.showInactive();
  }
}

function bringAllToFront() {
  for (const cw of camWins.values()) {
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
    { type: "separator" },
    { label: "Always on top", type: "checkbox", checked: !!entry.onTop, click: () => toggleOnTop(cw) },
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
  }
  for (const cw of camWins.values()) refreshCameraMeta(cw);
  notifyManager();
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
    width: 760,
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
  return {
    mock: MOCK,
    settings: { ...store.settings },
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
        return { ...cam, key, open: !!cw, channel: cw?.stream?.channel ?? w?.channel ?? null, onTop: !!w?.onTop, status: cw?.stream?.status ?? null };
      });
      return {
        id: c.id,
        name: c.name,
        host: c.host,
        username: c.username,
        state: conn?.state ?? "idle",
        message: conn?.message ?? "",
        controllerName: conn?.controllerName ?? null,
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

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Camera list…", click: () => showManager() },
    { label: "Bring cameras to front", click: () => bringAllToFront() },
    { label: "Lock layout", type: "checkbox", checked: !!store.settings.lockLayout, click: (item) => setSetting("lockLayout", item.checked) },
    { type: "separator" },
    { label: "Quit Protect Panes", click: () => { quitting = true; app.quit(); } },
  ]));
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
  handle("mgr:close-camera", (key) => camWins.get(String(key))?.win.close());
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
  handle("mgr:bring-to-front", () => bringAllToFront());
  handle("mgr:reset-positions", () => tileOpenWindows());
  handle("mgr:open-all", (consoleId) => {
    const conn = connections.get(String(consoleId));
    for (const cam of conn?.cameras() ?? []) openCameraWindow(`${consoleId}/${cam.id}`);
  });
  handle("mgr:quit", () => { quitting = true; app.quit(); });
}
