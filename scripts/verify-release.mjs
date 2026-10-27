// Check a release folder the way installed copies will: latest.json's signature against the public
// key built into the app (src/update-key.js), then the size and SHA-256 of the zip and installer.
//
//   node scripts/verify-release.mjs [dir] [expectedVersion]     (default dir: dist)
//
// Exits non-zero on any mismatch, so the release workflow stops before publishing.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyManifest } from "../src/updater.js";
import { UPDATE_PUBLIC_KEY } from "../src/update-key.js";

const dir = path.resolve(process.argv[2] || "dist");
const expected = process.argv[3]?.replace(/^v/, "");
const manifest = verifyManifest(fs.readFileSync(path.join(dir, "latest.json"), "utf8"), UPDATE_PUBLIC_KEY);
if (expected && manifest.version !== expected) throw new Error(`latest.json says ${manifest.version}, expected ${expected}`);

for (const f of [manifest, manifest.installer].filter(Boolean)) {
  const data = fs.readFileSync(path.join(dir, f.file));
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  if (data.length !== f.size || sha !== f.sha256) throw new Error(`${f.file}: size/sha256 don't match latest.json`);
  console.log(`ok  ${f.file}  ${data.length} bytes  sha256 ${sha}`);
}
console.log(`ok  latest.json  version ${manifest.version}, signed by the key this app trusts`);
