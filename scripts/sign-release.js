// Writes latest.json next to a release zip: { payload, signature }, where payload is base64 JSON
//   { app, version, file, size, sha256,
//     installer?: { file, size, sha256 },
//     asar?: { file, size, sha256, electron, unpacked: { size, sha256 } },
//     published }
// and signature is Ed25519 over the payload bytes. The app verifies it with src/update-key.js before
// downloading anything. 1.2.x clients ignore `installer`, and 1.3.x ignore `asar`; both update from
// the zip (1.3.x installer copies from the installer). `asar` is app.asar alone, gzip'd, for copies
// already on the same Electron (`electron`); `unpacked` is what the helper checks after gunzip.
//
//   node scripts/sign-release.js [zip] [version] [installer]
//     defaults: the dist zip, package.json's version, and the dist installer and
//     ProtectPanes-app.asar.gz when present, for the Electron package-lock.json names
//
// Node's own modules only, and no node_modules needed: the release workflow signs in a job of its
// own that never installs or runs the build's dependencies, so none of them can read the key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const DEFAULT_KEY_FILE = process.env.PANES_SIGNING_KEY || path.join(os.homedir(), ".protect-panes", "update-signing-key.pem");

const hashData = (data) => ({ size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
const hashOf = (file) => hashData(fs.readFileSync(file));
const describe = (file) => ({ file: path.basename(file), ...hashOf(file) });

/**
 * @param {{ gz: string, unpacked?: string, electron: string } | null} asar - without `unpacked`, the
 *   unpacked hash is the .gz's own content, which is what the helper checks after gunzip anyway
 */
export function signRelease({ zip, installer = null, asar = null, version, keyFile = DEFAULT_KEY_FILE, out = path.join(path.dirname(zip), "latest.json") }) {
  const unpacked = asar && (asar.unpacked ? hashOf(asar.unpacked) : hashData(zlib.gunzipSync(fs.readFileSync(asar.gz))));
  const payload = Buffer.from(JSON.stringify({
    app: "protect-panes",
    version,
    ...describe(zip),
    ...(installer && { installer: describe(installer) }),
    ...(asar && { asar: { ...describe(asar.gz), electron: asar.electron, unpacked } }),
    published: new Date().toISOString(),
  }));
  const signature = crypto.sign(null, payload, crypto.createPrivateKey(fs.readFileSync(keyFile)));
  fs.writeFileSync(out, JSON.stringify({ payload: payload.toString("base64"), signature: signature.toString("base64") }, null, 2));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const zip = path.resolve(process.argv[2] || path.join("dist", "ProtectPanes-win32-x64.zip"));
  const setup = path.resolve(process.argv[4] || path.join(path.dirname(zip), "ProtectPanes-Setup.exe"));
  const gz = path.join(path.dirname(zip), "ProtectPanes-app.asar.gz");
  // The Electron the build ran on: npm ci installs exactly the lockfile's.
  const electron = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages?.["node_modules/electron"]?.version;
  if (fs.existsSync(gz) && !/^\d+\.\d+\.\d+$/.test(electron ?? "")) throw new Error("package-lock.json doesn't name the Electron version the app.asar is for");
  console.log("signed:", signRelease({
    zip,
    installer: fs.existsSync(setup) ? setup : null,
    asar: fs.existsSync(gz) ? { gz, electron } : null,
    version: process.argv[3] || pkg.version,
  }));
}
