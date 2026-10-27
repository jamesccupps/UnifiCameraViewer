// Check a release folder the way installed copies will: latest.json's signature against the public
// key built into the app (src/update-key.js), then the size and SHA-256 of the zip, the installer and
// the gzip'd app.asar, and of app.asar once unpacked.
//
//   node scripts/verify-release.mjs [dir] [expectedVersion]     (default dir: dist)
//
// Exits non-zero on any mismatch, so the release workflow stops before publishing.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { verifyManifest } from "../src/updater.js";
import { UPDATE_PUBLIC_KEY } from "../src/update-key.js";

const dir = path.resolve(process.argv[2] || "dist");
const expected = process.argv[3]?.replace(/^v/, "");
const manifest = verifyManifest(fs.readFileSync(path.join(dir, "latest.json"), "utf8"), UPDATE_PUBLIC_KEY);
if (expected && manifest.version !== expected) throw new Error(`latest.json says ${manifest.version}, expected ${expected}`);

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
for (const f of [manifest, manifest.installer, manifest.asar].filter(Boolean)) {
  const data = fs.readFileSync(path.join(dir, f.file));
  if (data.length !== f.size || sha(data) !== f.sha256) throw new Error(`${f.file}: size/sha256 don't match latest.json`);
  console.log(`ok  ${f.file}  ${data.length} bytes  sha256 ${f.sha256}`);
  if (f === manifest.asar) {
    const raw = zlib.gunzipSync(data);
    if (raw.length !== f.unpacked.size || sha(raw) !== f.unpacked.sha256) throw new Error(`${f.file}: unpacked app.asar doesn't match latest.json`);
    console.log(`ok  ${f.file} unpacked  ${raw.length} bytes, for Electron ${f.electron}`);
  }
}
console.log(`ok  latest.json  version ${manifest.version}, signed by the key this app trusts`);
