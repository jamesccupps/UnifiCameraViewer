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
 *   layouts:  [{ id, name, windows: { "<consoleId>/<cameraId>": { bounds, channel, onTop, hideName, clock, range, dewarp } } }]
 * }
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
  return { version: 1, consoles: [], windows: {}, settings: { ...DEFAULT_SETTINGS }, layouts: [] };
}

export class Store {
  #file;
  #data;
  #timer = null;

  constructor() {
    this.#file = path.join(app.getPath("userData"), "config.json");
    this.#data = this.#load();
  }

  get file() { return this.#file; }
  get data() { return this.#data; }
  get settings() { return this.#data.settings; }

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Keep a copy of a corrupt file rather than silently overwriting it.
        try { fs.copyFileSync(this.#file, this.#file + ".corrupt"); } catch { /* ignore */ }
      }
      return defaults();
    }
    const d = defaults();
    return {
      version: 1,
      consoles: Array.isArray(raw.consoles) ? raw.consoles.filter((c) => c && c.id && c.host) : [],
      windows: raw.windows && typeof raw.windows === "object" ? raw.windows : {},
      settings: { ...d.settings, ...(raw.settings ?? {}) },
      layouts: Array.isArray(raw.layouts) ? raw.layouts.filter((l) => l && l.id && l.name && l.windows && typeof l.windows === "object") : [],
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
      fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
      fs.renameSync(tmp, this.#file);
    } catch (err) {
      console.error("config save failed", err);
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
  // Only reachable on Linux desktops without a keyring; Windows always has DPAPI.
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
