// Builds a portable Windows x64 app folder and zips it:
//   dist/Protect Panes-win32-x64/ProtectPanes.exe
//   dist/ProtectPanes-win32-x64.zip
// Runs on Windows, macOS or Linux (no Wine needed).
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_KEY_FILE, signRelease } from "./sign-release.js";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const [appPath] = await packager({
  dir: ".",
  out: "dist",
  platform: "win32",
  arch: "x64",
  overwrite: true,
  asar: true,
  prune: true,
  executableName: "ProtectPanes",
  icon: "assets/icon.ico",
  appVersion: pkg.version,
  appCopyright: "MIT License",
  win32metadata: {
    CompanyName: "Protect Panes",
    FileDescription: "Protect Panes - UniFi Protect live view windows",
    ProductName: "Protect Panes",
    InternalName: "ProtectPanes",
  },
  ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/test($|\/)/, /^\/\.git/, /^\/CLAUDE\.md$/, /^\/ROADMAP\.md$/, /^\/\.gitignore$/, /\.log$/],
  // Optional: use a pre-downloaded electron-vX-win32-x64.zip instead of fetching it.
  ...(process.env.ELECTRON_ZIP_DIR && { electronZipDir: process.env.ELECTRON_ZIP_DIR }),
});

console.log("packaged:", appPath);
fs.copyFileSync("README.md", path.join(appPath, "README.md"));

const zip = path.resolve("dist", "ProtectPanes-win32-x64.zip");
fs.rmSync(zip, { force: true });
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${appPath}' -DestinationPath '${zip}'`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-qr9", zip, path.basename(appPath)], { cwd: path.dirname(appPath), stdio: "inherit" });
}
console.log("zipped:", zip);

// latest.json lets installed copies update in place (Settings -> Updates). Publish it with the zip.
if (fs.existsSync(DEFAULT_KEY_FILE)) console.log("signed:", signRelease({ zip, version: pkg.version }));
else console.warn(`not signed: no key at ${DEFAULT_KEY_FILE} (run node scripts/make-signing-key.js once)`);
