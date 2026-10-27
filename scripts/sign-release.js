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
//     ProtectPanes-app.asar.gz (with the packaged app's own app.asar) when present
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_KEY_FILE = process.env.PANES_SIGNING_KEY || path.join(os.homedir(), ".protect-panes", "update-signing-key.pem");

const hashOf = (file) => {
  const data = fs.readFileSync(file);
  return { size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
};
const describe = (file) => ({ file: path.basename(file), ...hashOf(file) });

/** @param {{ gz: string, unpacked: string, electron: string } | null} asar */
export function signRelease({ zip, installer = null, asar = null, version, keyFile = DEFAULT_KEY_FILE, out = path.join(path.dirname(zip), "latest.json") }) {
  const payload = Buffer.from(JSON.stringify({
    app: "protect-panes",
    version,
    ...describe(zip),
    ...(installer && { installer: describe(installer) }),
    ...(asar && { asar: { ...describe(asar.gz), electron: asar.electron, unpacked: hashOf(asar.unpacked) } }),
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
  const unpacked = path.join(path.dirname(zip), "Protect Panes-win32-x64", "resources", "app.asar");
  const electron = createRequire(import.meta.url)("electron/package.json").version;
  console.log("signed:", signRelease({
    zip,
    installer: fs.existsSync(setup) ? setup : null,
    asar: fs.existsSync(gz) && fs.existsSync(unpacked) ? { gz, unpacked, electron } : null,
    version: process.argv[3] || pkg.version,
  }));
}
