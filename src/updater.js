import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/*
 * In-place updates from a release folder: an https:// base URL or a folder path (LAN share).
 * The folder holds latest.json and the zip it names (scripts/build-win.js writes both).
 *
 * The exe isn't code-signed, so the Ed25519 signature on latest.json is the only thing between
 * this download path and running someone else's code. Order matters: verify the manifest's
 * signature, only then download, check the zip's size and SHA-256 against the signed values, and
 * only then hand it to the swap helper. Older or equal versions are never installed, so a
 * replayed old manifest can't downgrade the app.
 *
 * No Electron imports here, so test/run.mjs can drive it under plain Node.
 */

export const MANIFEST = "latest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

/** Numeric x.y.z compare: 1 if a > b, -1 if a < b, 0 if equal. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** "https" or "path" for a usable update location, null otherwise (plain http is refused). */
export function sourceKind(source) {
  const s = String(source ?? "").trim();
  if (/^https:\/\/[^\s/]+/i.test(s)) return "https";
  // A drive path, or \\server\share. Not the device forms (\\?\, \\.\) and not WebDAV's host@SSL@port
  // or host@port, which went over plain HTTP despite "http is refused".
  if (/^(?:[a-zA-Z]:[\\/]|\\\\(?![?.]\\)[^\\@]+\\[^\\]+)/.test(s)) return "path";
  return null;
}

/** Check latest.json's signature and shape. Returns the signed payload; throws on anything off. */
export function verifyManifest(text, publicKeyPem) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("The update manifest isn't valid JSON."); }
  const payload = Buffer.from(String(doc?.payload ?? ""), "base64");
  const signature = Buffer.from(String(doc?.signature ?? ""), "base64");
  if (!payload.length || signature.length !== 64) throw new Error("The update manifest isn't signed.");
  let ok = false;
  try { ok = crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), signature); } catch { ok = false; }
  if (!ok) throw new Error("The update manifest's signature doesn't match this app's key - not installing it.");
  let p;
  try { p = JSON.parse(payload.toString("utf8")); } catch { throw new Error("The update manifest is malformed."); }
  // Bare file names only: no paths, nothing to traverse.
  const fileOk = (f, ext) => typeof f?.file === "string" && new RegExp(`^[\\w.-]+\\.${ext}$`).test(f.file)
    && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.size) && f.size > 0 && f.size <= MAX_ZIP_BYTES;
  const hashOk = (h) => /^[0-9a-f]{64}$/.test(h?.sha256) && Number.isInteger(h?.size) && h.size > 0 && h.size <= MAX_ZIP_BYTES;
  const valid = p?.app === "protect-panes"
    && /^\d+\.\d+\.\d+$/.test(p.version)
    && fileOk(p, "zip")
    && (p.installer === undefined || fileOk(p.installer, "exe"))
    && (p.asar === undefined || (fileOk(p.asar, "asar\\.gz") && /^\d+\.\d+\.\d+$/.test(p.asar.electron) && hashOk(p.asar.unpacked)));
  if (!valid) throw new Error("The update manifest is malformed.");
  return p;
}

function join(source, name) {
  return sourceKind(source) === "https"
    ? new URL(name, source.endsWith("/") ? source : `${source}/`).href
    : path.join(source, name);
}

async function readSmall(source, name, fetchImpl, timeoutMs) {
  const where = join(source, name);
  if (sourceKind(source) === "path") {
    const st = await fs.promises.stat(where);
    if (st.size > MAX_MANIFEST_BYTES) throw new Error("The update manifest is too large.");
    return fs.promises.readFile(where, "utf8");
  }
  // Bounded in time and in bytes as it's read: the whole body used to be read before the size check,
  // with no timeout, so an endless answer filled memory (at every launch) and a trickle left checks
  // stuck "busy" until a restart.
  const signal = AbortSignal.timeout(timeoutMs);
  const late = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(`${where} didn't answer in time.`)), { once: true });
  });
  late.catch(() => {}); // only a loss of the race below matters
  const read = async () => {
    const res = await fetchImpl(where, { redirect: "follow", cache: "no-store", signal });
    if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`);
    if (Number(res.headers?.get?.("content-length")) > MAX_MANIFEST_BYTES) throw new Error("The update manifest is too large.");
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ? Readable.fromWeb(res.body) : []) {
      size += chunk.length;
      if (size > MAX_MANIFEST_BYTES) throw new Error("The update manifest is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  // Raced as well as passed down: a fetch whose body ignores the signal still can't hold this up.
  return Promise.race([read(), late]);
}

/**
 * Copy/download a release file to `dest`, hashing as it goes. Returns { size, sha256 }. On failure
 * the file is closed before returning, so the caller can delete it (Windows keeps listing a file
 * deleted while still open).
 */
async function fetchTo(source, name, dest, limit, fetchImpl, idleMs) {
  const where = join(source, name);
  // A download that stops sending is given up after idleMs without a byte (it used to wait forever).
  const stall = new AbortController();
  let idle = null;
  const poke = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stall.abort(new Error("The update download stalled.")), idleMs);
  };
  let input;
  try {
    if (sourceKind(source) === "path") {
      input = fs.createReadStream(where);
    } else {
      poke();
      const res = await fetchImpl(where, { redirect: "follow", cache: "no-store", signal: stall.signal });
      if (!res.ok || !res.body) throw new Error(`${where}: HTTP ${res.status}`);
      input = Readable.fromWeb(res.body);
    }
    const hash = crypto.createHash("sha256");
    let size = 0;
    const out = fs.createWriteStream(dest);
    try {
      await pipeline(input, async function* (chunks) {
        for await (const chunk of chunks) {
          if (idle) poke();
          size += chunk.length;
          if (size > limit) throw new Error("The update download is larger than the signed size.");
          hash.update(chunk);
          yield chunk;
        }
      }, out);
    } catch (err) {
      if (!out.closed) await new Promise((resolve) => out.once("close", resolve));
      throw stall.signal.aborted ? stall.signal.reason : err;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    clearTimeout(idle);
  }
}

/**
 * state.status: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error"
 * events: "state"
 */
export class Updater extends EventEmitter {
  #opts;
  #busy = false;
  state = { status: "idle", version: null, message: "" };

  /**
   * @param {object} opts
   * @param {string} opts.currentVersion
   * @param {() => string} opts.getSource
   * @param {string} opts.publicKey     - PEM
   * @param {string} opts.stageDir      - where downloads are kept until installed
   * @param {"folder" | "installer"} [opts.installKind] - how this copy was installed: unzipped folder
   *   (update = swap the folder) or Setup.exe (update = run the new installer, which keeps its uninstaller)
   * @param {string} [opts.electronVersion] - the running Electron. A release built for the same one
   *   updates either kind by replacing resources\app.asar alone (a few MB instead of the zip).
   * @param {typeof fetch} [opts.fetch]
   * @param {{ manifestMs?: number, idleMs?: number }} [opts.timeouts] - for latest.json, and for a
   *   download that stops sending
   * @param {object} opts.log
   */
  constructor(opts) {
    super();
    this.#opts = { fetch: globalThis.fetch, installKind: "folder", ...opts, timeouts: { manifestMs: 15_000, idleMs: 60_000, ...opts?.timeouts } };
  }

  #set(status, extra = {}) {
    this.state = { status, version: null, message: "", ...extra };
    this.emit("state", this.state);
  }

  /** Read and verify latest.json; with download, also fetch and verify the zip. */
  async check({ download = true } = {}) {
    if (this.#busy) return this.state;
    this.#busy = true;
    const { getSource, publicKey, currentVersion, stageDir, log } = this.#opts;
    const source = String(getSource() ?? "").trim();
    try {
      if (!sourceKind(source)) throw new Error("Set an update location first: an https:// address or a folder.");
      this.#set("checking");
      const manifest = verifyManifest(await readSmall(source, MANIFEST, this.#opts.fetch, this.#opts.timeouts.manifestMs), publicKey);
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        this.#set("current", { version: manifest.version, message: `Up to date (${currentVersion}).` });
        return this.state;
      }
      if (!download) {
        this.#set("available", { version: manifest.version, message: `Version ${manifest.version} is available.` });
        return this.state;
      }
      // Installed copies keep their Settings -> Apps entry at the version Setup.exe last wrote; it
      // catches up on the next full update (a new Electron), which goes through the installer.
      const sameElectron = !!manifest.asar && manifest.asar.electron === this.#opts.electronVersion;
      const kind = sameElectron ? "asar" : this.#opts.installKind === "installer" ? "installer" : "folder";
      const want = { asar: manifest.asar, installer: manifest.installer, folder: manifest }[kind];
      if (!want) throw new Error(`Version ${manifest.version} has no installer. Download it from the release page.`);
      this.#set("downloading", { version: manifest.version, message: `Downloading ${manifest.version}…` });
      fs.mkdirSync(stageDir, { recursive: true });
      const name = { asar: `ProtectPanes-${manifest.version}-app.asar.gz`, installer: `ProtectPanes-Setup-${manifest.version}.exe`, folder: `ProtectPanes-${manifest.version}.zip` }[kind];
      const file = path.join(stageDir, name);
      const part = `${file}.part`;
      fs.rmSync(part, { force: true });
      let got;
      try {
        got = await fetchTo(source, want.file, part, want.size, this.#opts.fetch, this.#opts.timeouts.idleMs);
        if (got.size !== want.size || got.sha256 !== want.sha256) {
          throw new Error("The downloaded update doesn't match its signed checksum - not installing it.");
        }
      } catch (err) {
        fs.rmSync(part, { force: true }); // never leave unverified bytes where they could be mistaken for the update
        throw err;
      }
      fs.renameSync(part, file);
      log?.info(`update ${manifest.version} (${kind}) downloaded and verified (${got.size} bytes, sha256 ${got.sha256.slice(0, 12)}…)`);
      this.#set("ready", {
        version: manifest.version, kind, file, unpackedSha256: kind === "asar" ? want.unpacked.sha256 : undefined,
        message: `Version ${manifest.version} is ready to install (${(got.size / 1e6).toFixed(1)} MB downloaded).`,
      });
    } catch (err) {
      log?.warn(`update check: ${err.message}`);
      this.#set("error", { message: err.message });
    } finally {
      this.#busy = false;
    }
    return this.state;
  }

  /**
   * Hand the verified zip to the swap helper, which waits for `pid` to exit, replaces installDir
   * and relaunches. The caller quits the app right after this returns.
   */
  install({ installDir, exeName, pid, noLaunch = false }) {
    if (this.state.status !== "ready" || !this.state.file) throw new Error("No verified update is ready.");
    const parent = path.dirname(installDir);
    try {
      fs.rmSync(fs.mkdtempSync(path.join(parent, ".pp-write-test-")), { recursive: true, force: true });
    } catch {
      throw new Error(`Can't write to ${parent}. Move Protect Panes to a folder you can write to (for example %LOCALAPPDATA%\\Programs\\Protect Panes), or replace the folder by hand.`);
    }
    const script = path.join(this.#opts.stageDir, "apply-update.ps1");
    const log = path.join(this.#opts.stageDir, "apply-update.log");
    fs.writeFileSync(script, HELPER_PS1, "utf8");
    fs.rmSync(log, { force: true });
    const q = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`; // PowerShell single-quoted literal
    const payload = {
      installer: `-Installer ${q(this.state.file)}`,
      asar: `-AsarGz ${q(this.state.file)} -AsarSha256 ${q(this.state.unpackedSha256)}`,
      folder: `-Zip ${q(this.state.file)}`,
    }[this.state.kind ?? "folder"];
    const invoke = `& ${q(script)} -WaitPid ${Number(pid)} ${payload} -Target ${q(installDir)} -Exe ${q(exeName)} -Log ${q(log)}${noLaunch ? " -NoLaunch" : ""}`;
    /*
     * Measured on Windows 11: a detached powershell.exe (DETACHED_PROCESS, no console) exits 0 at
     * once without running anything, and a non-detached child sits in libuv's kill-on-close job, so
     * it would die with the app. A detached cmd.exe running "start" gives PowerShell its own console
     * outside that job. Nothing on cmd's line is a path: the call travels base64-encoded, so no
     * "&" or "%" in a user or folder name can be read by cmd.
     * cwd: started from Explorer or a shortcut, the app's working folder is the install folder, and
     * Windows won't rename a folder that's any process's working folder, the helper's included.
     */
    const encoded = Buffer.from(invoke, "utf16le").toString("base64");
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "/min", "powershell.exe", "-NoProfile", "-NonInteractive",
      "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { cwd: this.#opts.stageDir, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { script, log };
  }
}

/*
 * Runs after the app exits.
 *   -Zip: unpacks next to the install folder (same volume, so the swap is a rename), checks the
 *         new folder has the exe, renames the old folder aside, moves the new one in, and rolls
 *         back if that fails.
 *   -Installer: runs the verified Setup.exe silently, as electron-builder's own updater does
 *         (/S --updated). The installer replaces the files and keeps its uninstaller and shortcuts.
 *   -AsarGz: gunzips the verified download next to resources\app.asar, checks the result against
 *         the signed -AsarSha256, swaps the one file and puts the old one back if that fails.
 * Whichever ran, it relaunches the version that ended up in place.
 */
export const HELPER_PS1 = String.raw`param(
  [int]$WaitPid, [string]$Zip, [string]$Installer, [string]$AsarGz, [string]$AsarSha256, [string]$Target, [string]$Exe, [string]$Log, [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
function Say([string]$m) { Add-Content -LiteralPath $Log -Value ("{0:s} {1}" -f (Get-Date), $m) }
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$work = "$Target.new-$stamp"
$old = "$Target.old-$stamp"
try {
  Say "update: waiting for process $WaitPid to exit"
  for ($i = 0; $i -lt 60 -and (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
  if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { throw "the app didn't exit" }
  if ($Installer) {
    $p = Start-Process -FilePath $Installer -ArgumentList '/S', '--updated' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "the installer exited with code $($p.ExitCode)" }
    Say "update: installer finished"
    Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
  } elseif ($AsarGz) {
    $res = Join-Path $Target 'resources'
    $cur = Join-Path $res 'app.asar'
    $tmp = Join-Path $res "app.asar.new-$stamp"
    $bak = Join-Path $res "app.asar.old-$stamp"
    try {
      $in = [IO.File]::OpenRead($AsarGz)
      try {
        $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
        $out = [IO.File]::Create($tmp)
        try { $gz.CopyTo($out) } finally { $out.Dispose(); $gz.Dispose() }
      } finally { $in.Dispose() }
      # .NET, not Get-FileHash: started from PowerShell 7 (GitHub's runners, or a user's pwsh window),
      # Windows PowerShell inherits pwsh's PSModulePath and Get-FileHash isn't found (measured in CI).
      $sha = [Security.Cryptography.SHA256]::Create()
      $fs = [IO.File]::OpenRead($tmp)
      try { $hash = -join ($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) } finally { $fs.Dispose(); $sha.Dispose() }
      if ($hash -ne $AsarSha256.ToLowerInvariant()) { throw "the unpacked app.asar doesn't match its signed checksum" }
    } catch {
      # Whatever failed before the swap, don't leave a half-made app.asar next to the real one.
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      throw
    }
    $moved = $false
    for ($i = 0; $i -lt 10 -and -not $moved; $i++) {
      try { Move-Item -LiteralPath $cur -Destination $bak; $moved = $true } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $moved) {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      throw "couldn't replace $cur (still in use)"
    }
    try {
      Move-Item -LiteralPath $tmp -Destination $cur
    } catch {
      Say "update: move failed, restoring the old app.asar: $_"
      Move-Item -LiteralPath $bak -Destination $cur -Force
      throw
    }
    Say "update: installed app.asar into $Target"
    Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $AsarGz -Force -ErrorAction SilentlyContinue
  } else {
    Expand-Archive -LiteralPath $Zip -DestinationPath $work -Force
    $new = Get-ChildItem -LiteralPath $work -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName $Exe) } | Select-Object -First 1
    if ($new) { $new = $new.FullName } elseif (Test-Path -LiteralPath (Join-Path $work $Exe)) { $new = $work } else { throw "the update has no $Exe" }
    $moved = $false
    for ($i = 0; $i -lt 10 -and -not $moved; $i++) {
      try { Rename-Item -LiteralPath $Target -NewName (Split-Path $old -Leaf); $moved = $true } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $moved) { throw "couldn't move $Target aside (a file in it is still in use)" }
    try {
      Move-Item -LiteralPath $new -Destination $Target
    } catch {
      Say "update: move failed, restoring the old version: $_"
      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
      Rename-Item -LiteralPath $old -NewName (Split-Path $Target -Leaf)
      throw
    }
    Say "update: installed into $Target"
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
  }
} catch {
  Say "update failed: $_"
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $Target $Exe) }
Say "update: done"
`;
