// Writes latest.json next to a release zip: { payload, signature }, where payload is base64 JSON
// { app, version, file, size, sha256, installer?: { file, size, sha256 }, published } and signature
// is Ed25519 over the payload bytes. The app verifies it with src/update-key.js before downloading
// anything. 1.2.x clients ignore `installer` and update from the zip.
//
//   node scripts/sign-release.js [zip] [version] [installer]   (defaults: dist zip, package.json version, dist installer if present)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_KEY_FILE = process.env.PANES_SIGNING_KEY || path.join(os.homedir(), ".protect-panes", "update-signing-key.pem");

const describe = (file) => {
  const data = fs.readFileSync(file);
  return { file: path.basename(file), size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
};

export function signRelease({ zip, installer = null, version, keyFile = DEFAULT_KEY_FILE, out = path.join(path.dirname(zip), "latest.json") }) {
  const payload = Buffer.from(JSON.stringify({
    app: "protect-panes",
    version,
    ...describe(zip),
    ...(installer && { installer: describe(installer) }),
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
  console.log("signed:", signRelease({ zip, installer: fs.existsSync(setup) ? setup : null, version: process.argv[3] || pkg.version }));
}
