// Writes latest.json next to a release zip: { payload, signature }, where payload is base64 JSON
// { app, version, file, size, sha256, published } and signature is Ed25519 over the payload bytes.
// The app verifies it with src/update-key.js before downloading anything.
//
//   node scripts/sign-release.js [zip] [version]      (defaults: dist zip, package.json version)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_KEY_FILE = process.env.PANES_SIGNING_KEY || path.join(os.homedir(), ".protect-panes", "update-signing-key.pem");

export function signRelease({ zip, version, keyFile = DEFAULT_KEY_FILE, out = path.join(path.dirname(zip), "latest.json") }) {
  const data = fs.readFileSync(zip);
  const payload = Buffer.from(JSON.stringify({
    app: "protect-panes",
    version,
    file: path.basename(zip),
    size: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    published: new Date().toISOString(),
  }));
  const signature = crypto.sign(null, payload, crypto.createPrivateKey(fs.readFileSync(keyFile)));
  fs.writeFileSync(out, JSON.stringify({ payload: payload.toString("base64"), signature: signature.toString("base64") }, null, 2));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const zip = path.resolve(process.argv[2] || path.join("dist", "ProtectPanes-win32-x64.zip"));
  console.log("signed:", signRelease({ zip, version: process.argv[3] || pkg.version }));
}
