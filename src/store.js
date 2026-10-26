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
 *   windows:  { "<consoleId>/<cameraId>": { open, bounds: {x,y,width,height}, channel, onTop, name } },
 *   settings: { lockLayout, showNames, lockAspect, hideFromTaskbar, startHidden, launchAtLogin }
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
});

function defaults() {
  return { version: 1, consoles: [], windows: {}, settings: { ...DEFAULT_SETTINGS } };
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

export function encryptPassword(plain) {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: "safe", data: safeStorage.encryptString(plain).toString("base64") };
  }
  // Only reachable on Linux desktops without a keyring; Windows always has DPAPI.
  return { enc: "plain", data: Buffer.from(plain, "utf8").toString("base64") };
}

export function decryptPassword(stored) {
  if (!stored?.data) return "";
  if (stored.enc === "safe") return safeStorage.decryptString(Buffer.from(stored.data, "base64"));
  return Buffer.from(stored.data, "base64").toString("utf8");
}

export function newId() {
  return crypto.randomUUID();
}
