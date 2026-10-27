// One-time setup: create the Ed25519 key that signs releases for the in-app updater.
//
//   node scripts/make-signing-key.js
//
// The private key is written to %USERPROFILE%\.protect-panes\update-signing-key.pem (or
// PANES_SIGNING_KEY) and never goes in the repo. The public key is written into
// src/update-key.js and ships inside the app, which refuses any update not signed by the
// private key. Back the private key up: lose it and installed copies can't be updated in place
// any more (they'd need one manual reinstall of a build carrying a new public key).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_FILE = process.env.PANES_SIGNING_KEY || path.join(os.homedir(), ".protect-panes", "update-signing-key.pem");
const PUBLIC_FILE = path.resolve("src", "update-key.js");

if (fs.existsSync(KEY_FILE)) {
  console.error(`${KEY_FILE} already exists; refusing to replace it. Releases signed with a new key can't update copies that trust the old one.`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
fs.writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
const pem = publicKey.export({ type: "spki", format: "pem" }).trim();
fs.writeFileSync(PUBLIC_FILE, `// Public half of the release-signing key (scripts/make-signing-key.js). The updater installs only
// releases whose latest.json is signed by the matching private key, which never leaves the
// maintainer's machine.
export const UPDATE_PUBLIC_KEY = ${JSON.stringify(pem + "\n")};
`);
console.log(`private key: ${KEY_FILE}  (back this up; keep it out of the repo)`);
console.log(`public key:  ${PUBLIC_FILE}`);
