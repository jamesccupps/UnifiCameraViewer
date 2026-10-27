// Builds the Windows x64 release:
//   dist/Protect Panes-win32-x64/ProtectPanes.exe   the app folder (@electron/packager)
//   dist/ProtectPanes-win32-x64.zip                 that folder zipped: portable copies, and what 1.2.x updates from
//   dist/ProtectPanes-Setup.exe                     per-user installer wrapping the same folder (Windows only)
//   dist/latest.json                                signed manifest for in-app updates, when the signing key is present
// The installer is electron-builder's NSIS target in --prepackaged mode, so the zip and the
// installer carry byte-identical app files.
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DEFAULT_KEY_FILE, signRelease } from "./sign-release.js";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

// Packager's last step renames its temp folder into dist/. Right after the files are written,
// Windows (antivirus scanning the new executables, most likely) sometimes refuses that with EPERM;
// seen twice on the maintainer's PC. A short wait and a retry gets through.
async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      console.warn(`${err.code} on ${err.dest ?? err.path}; retrying in 5 s (${i}/${tries - 1})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const [appPath] = await withRetry(() => packager({
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
  ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/test($|\/)/, /^\/\.git/, /^\/\.github($|\/)/, /^\/CLAUDE\.md$/, /^\/ROADMAP\.md$/, /^\/\.gitignore$/, /\.log$/],
  // Optional: use a pre-downloaded electron-vX-win32-x64.zip instead of fetching it.
  ...(process.env.ELECTRON_ZIP_DIR && { electronZipDir: process.env.ELECTRON_ZIP_DIR }),
}));

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

let installer = null;
if (process.platform === "win32") {
  const { build, Platform, Arch } = createRequire(import.meta.url)("electron-builder");
  const out = path.resolve("dist", "installer");
  fs.rmSync(out, { recursive: true, force: true });
  await build({
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    prepackaged: appPath,
    config: {
      appId: "protect-panes", // = app.setAppUserModelId() in main.js, so the taskbar groups shortcut and windows
      productName: "Protect Panes",
      copyright: "MIT License",
      directories: { output: out },
      win: { icon: "assets/icon.ico", executableName: "ProtectPanes" },
      nsis: {
        // Per-user, no admin prompt: installs to %LOCALAPPDATA%\Programs\Protect Panes, which the
        // in-app updater can write to. Settings in %APPDATA%\Protect Panes survive uninstall.
        oneClick: true,
        perMachine: false,
        artifactName: "ProtectPanes-Setup.exe",
        shortcutName: "Protect Panes",
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        runAfterFinish: true,
        deleteAppDataOnUninstall: false,
      },
      publish: null,
    },
  });
  installer = path.resolve("dist", "ProtectPanes-Setup.exe");
  fs.rmSync(installer, { force: true });
  fs.renameSync(path.join(out, "ProtectPanes-Setup.exe"), installer);
  fs.rmSync(out, { recursive: true, force: true });
  console.log("installer:", installer);
}

// latest.json lets installed copies update in place (Settings -> Updates). Publish it with the zip
// and the installer.
if (fs.existsSync(DEFAULT_KEY_FILE)) console.log("signed:", signRelease({ zip, installer, version: pkg.version }));
else console.warn(`not signed: no key at ${DEFAULT_KEY_FILE} (run node scripts/make-signing-key.js once)`);
