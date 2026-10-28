import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
 * config.json lives in the app's userData folder (%APPDATA%\Protect Panes on Windows).
 *
 * {
 *   version: 1,
 *   consoles: [{ id, name, host, username, password: { enc: "safe" | "plain", data: base64 } }],
 *   windows:  { "<consoleId>/<cameraId>": { open, hidden, listHidden, bounds: {x,y,width,height}, channel, onTop, name, hideName, clock, range, dewarp } },
 *   settings: { lockLayout, showNames, lockAspect, hideFromTaskbar, startHidden, launchAtLogin },
 *   layouts:  [{ id, name, windows: { "<consoleId>/<cameraId>": { bounds, channel, onTop, hideName, clock, range, picture, dewarp } }, editor? }],
 *   grids:    [{ id, name, templateId, bounds, open, hidden, onTop, editor?, tiles: [{ key, channel, range, picture, hideName, clock, dewarp } | null] }]
 * }
 * (grids: see src/grid-window.js)
 *
 * Passwords are encrypted with Electron safeStorage, which on Windows is DPAPI bound to the
 * current Windows user - the file is useless if copied to another account or machine.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  lockLayout: false,
  showNames: true,
  lockAspect: true,
  hideFromTaskbar: true,
  startHidden: true,
  launchAtLogin: false,
  arrangeQuality: true, // Arrange / layouts pick each camera's stream quality from its tile size
  showPreviews: true,   // snapshot thumbnails in the camera list (src/previews.js)
  // https:// base URL or folder holding latest.json + the release zip (see updater.js). The default is
  // this project's latest GitHub release; blank turns update checks off.
  updateSource: "https://github.com/jamesccupps/UnifiCameraViewer/releases/latest/download",
});

function defaults() {
  return { version: 1, consoles: [], windows: {}, settings: { ...DEFAULT_SETTINGS }, layouts: [], grids: [] };
}

/*
 * Saving survives a power cut. NTFS journals a rename but not file data, so a config written and
 * renamed into place without a flush could come back as a file of zeros, and the app started with
 * no consoles. Now each save writes config.json.tmp and fsyncs it, moves the current config.json
 * to config.json.bak, then moves the new one in. Loading falls back to the .bak when config.json is
 * missing (a save cut off between its two moves) or unreadable, and keeps an unreadable file as
 * config.json.corrupt-<time>.
 */
export class Store {
  #file;
  #data;
  #timer = null;
  #fileIsGood = false; // config.json parsed (or was written here): fit to become the next .bak
  #log = null;
  #problems = [];      // found while loading, before there's a logger

  constructor() {
    this.#file = path.join(app.getPath("userData"), "config.json");
    this.#data = this.#load();
  }

  get file() { return this.#file; }
  get data() { return this.#data; }
  get settings() { return this.#data.settings; }

  /** Where load and save problems go (the store is created before the logger). */
  setLogger(log) {
    this.#log = log;
    for (const p of this.#problems.splice(0)) log.warn(p);
  }

  #problem(text) {
    if (this.#log) this.#log.error(text);
    else this.#problems.push(text);
  }

  #load() {
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    let raw;
    try {
      raw = read(this.#file);
      this.#fileIsGood = true;
    } catch (err) {
      if (err.code !== "ENOENT") {
        const kept = `${this.#file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        try { fs.copyFileSync(this.#file, kept); } catch { /* ignore */ }
        this.#problem(`config.json couldn't be read (${err.message}); kept it as ${path.basename(kept)}`);
      }
      try {
        raw = read(this.#file + ".bak");
        this.#problem("loaded config.json.bak, the settings from before the last save");
      } catch {
        return defaults();
      }
    }
    const d = defaults();
    const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    return {
      ...(isObject(raw) ? raw : {}), // keys a newer version wrote survive a downgrade and upgrade
      version: 1,
      consoles: Array.isArray(raw.consoles) ? raw.consoles.filter((c) => c && c.id && c.host) : [],
      // A hand-edited or future-version entry that isn't an object used to crash startup, every launch.
      windows: isObject(raw.windows) ? Object.fromEntries(Object.entries(raw.windows).filter(([, w]) => isObject(w))) : {},
      settings: { ...d.settings, ...(raw.settings ?? {}) },
      layouts: Array.isArray(raw.layouts)
        ? raw.layouts.filter((l) => l && l.id && l.name && isObject(l.windows))
          .map((l) => ({ ...l, windows: Object.fromEntries(Object.entries(l.windows).filter(([, w]) => isObject(w))) }))
        : [],
      grids: Array.isArray(raw.grids)
        ? raw.grids.filter((g) => g && g.id && g.name && typeof g.templateId === "string" && Array.isArray(g.tiles))
          .map((g) => ({ ...g, tiles: g.tiles.map((t) => (t && typeof t.key === "string" ? t : null)) }))
        : [],
    };
  }

  /** Coalesce bursts of changes (window drags) into one write. */
  save() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = this.#file + ".tmp";
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(this.#data, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (this.#fileIsGood) fs.renameSync(this.#file, this.#file + ".bak");
      fs.renameSync(tmp, this.#file);
      this.#fileIsGood = true;
    } catch (err) {
      this.#problem(`config save failed: ${err.message}`);
    }
  }
}

// The async safeStorage API: Electron 45 deprecated the sync one. On Windows both use the same
// DPAPI-protected key in "Local State" and the same "v10" format, so each reads what the other
// wrote (checked against 1.3.x configs) and going back to an older version still works.
export async function encryptPassword(plain) {
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    return { enc: "safe", data: (await safeStorage.encryptStringAsync(plain)).toString("base64") };
  }
  // Windows always has DPAPI; if it somehow says otherwise, refuse rather than quietly save the
  // password as base64. Only Linux desktops without a keyring get the plain fallback.
  if (process.platform === "win32") throw new Error("Windows couldn't encrypt the password, so it wasn't saved. Try again.");
  return { enc: "plain", data: Buffer.from(plain, "utf8").toString("base64") };
}

/** onReEncrypt(plain) runs when Electron says the saved copy should be encrypted again (a new key). */
export async function decryptPassword(stored, onReEncrypt = null) {
  if (!stored?.data) return "";
  if (stored.enc === "safe") {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.data, "base64"));
    if (shouldReEncrypt) onReEncrypt?.(result);
    return result;
  }
  return Buffer.from(stored.data, "base64").toString("utf8");
}

export function newId() {
  return crypto.randomUUID();
}
