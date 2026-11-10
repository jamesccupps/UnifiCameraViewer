// Builds the Windows x64 release:
//   dist/Protect Panes-win32-x64/ProtectPanes.exe   the app folder (@electron/packager)
//   dist/ProtectPanes-win32-x64.zip                 that folder zipped: portable copies, and what 1.2.x updates from
//   dist/ProtectPanes-Setup.exe                     per-user installer wrapping the same folder (Windows only)
//   dist/ProtectPanes-app.asar.gz                   just resources/app.asar, gzip'd: the small update for copies on the same Electron
//   dist/latest.json                                signed manifest for in-app updates, when the signing key is present
// The installer is electron-builder's NSIS target in --prepackaged mode, so the zip and the
// installer carry byte-identical app files.
//
// Nothing is Authenticode-signed here: the release workflow signs, in jobs that run no npm code. For
// those, this build also keeps the uninstaller electron-builder made, as
// dist/ProtectPanes-uninstaller.exe (scripts/installer-sign-hook.js).
//
//   node scripts/build-win.js        all of the above
//   node scripts/build-win.js --installer --uninstaller <unsigned> <signed>
//       only Setup.exe, from the app folder already in dist/ (the release workflow's installer job,
//       around the signed exe), with <signed> in place of the uninstaller this build makes, which must
//       be <unsigned> byte for byte
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { installerSignHook } from "./installer-sign-hook.js";
import { DEFAULT_KEY_FILE, signRelease } from "./sign-release.js";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const args = process.argv.slice(2);
const installerOnly = args[0] === "--installer";
if (installerOnly && !(args.length === 4 && args[1] === "--uninstaller")) {
  throw new Error("usage: node scripts/build-win.js --installer --uninstaller <unsigned> <signed>");
}
if (!installerOnly && args.length) throw new Error(`unknown arguments: ${args.join(" ")}`);

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

async function packageApp() {
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
    ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/test($|\/)/, /^\/\.git/, /^\/\.github($|\/)/, /^\/release-notes($|\/)/, /^\/site($|\/)/,/^\/CLAUDE\.md$/, /^\/ROADMAP\.md$/, /^\/\.gitignore$/, /\.log$/],
    // Optional: use a pre-downloaded electron-vX-win32-x64.zip instead of fetching it.
    ...(process.env.ELECTRON_ZIP_DIR && { electronZipDir: process.env.ELECTRON_ZIP_DIR }),
  }));

  console.log("packaged:", appPath);

  // Fuses, flipped before the zip and the installer are made from this folder. With Electron's
  // defaults the shipped exe doubles as node.exe (ELECTRON_RUN_AS_NODE), honours NODE_OPTIONS, opens
  // a debugger on --inspect, and loads a resources\app folder when app.asar is missing. Same-user
  // malware could still read what this user can, so this doesn't guard the passwords; it stops the
  // exe being used as a Node runtime or a debug target.
  // Not EnableEmbeddedAsarIntegrityValidation: a small update replaces app.asar under an unchanged
  // exe, so the hash embedded in the exe would no longer match and the app wouldn't start.
  // Changing these changes the exe: that release needs release-notes/vX.Y.Z.full-update.
  // The release workflow Authenticode-signs the exe after this; flipping a fuse later would break it.
  await flipFuses(path.join(appPath, "ProtectPanes.exe"), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log("fuses: no run-as-node, no NODE_OPTIONS, no --inspect, app.asar only");

  fs.copyFileSync("README.md", path.join(appPath, "README.md"));
  return appPath;
}

function zipApp(appPath) {
  const zip = path.resolve("dist", "ProtectPanes-win32-x64.zip");
  fs.rmSync(zip, { force: true });
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${appPath}' -DestinationPath '${zip}'`], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-qr9", zip, path.basename(appPath)], { cwd: path.dirname(appPath), stdio: "inherit" });
  }
  console.log("zipped:", zip);
  return zip;
}

// Windows only. `hook` is offered every file electron-builder would sign (installer-sign-hook.js).
async function buildInstaller(appPath, hook) {
  const { build, Platform, Arch } = createRequire(import.meta.url)("electron-builder");
  const out = path.resolve("dist", "installer");
  fs.rmSync(out, { recursive: true, force: true });
  await build({
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    prepackaged: appPath,
    // On CI electron-builder publishes by default. Releases go out only through the release
    // workflow, after its checks.
    publish: "never",
    config: {
      appId: "protect-panes", // = app.setAppUserModelId() in main.js, so the taskbar groups shortcut and windows
      productName: "Protect Panes",
      copyright: "MIT License",
      directories: { output: out },
      win: {
        icon: "assets/icon.ico",
        executableName: "ProtectPanes",
        // sha256 only, so the hook is offered each file once (the default asks for sha1, then sha256)
        signtoolOptions: { sign: hook, signingHashAlgorithms: ["sha256"] },
      },
      nsis: {
        // Per-user, no admin prompt: installs to %LOCALAPPDATA%\Programs\protect-panes, which the
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
  if (hook.uninstallers() !== 1) {
    throw new Error(`electron-builder offered ${hook.uninstallers()} uninstallers to the signing hook, not 1: has it changed how it names them?`);
  }
  const installer = path.resolve("dist", "ProtectPanes-Setup.exe");
  fs.rmSync(installer, { force: true });
  fs.renameSync(path.join(out, "ProtectPanes-Setup.exe"), installer);
  fs.rmSync(out, { recursive: true, force: true });
  console.log("installer:", installer);
  return installer;
}

// Everything the app itself is lives in app.asar (no native modules, nothing unpacked), so a copy
// already on this Electron only needs that file. The manifest names the Electron it was built for,
// which is all an installed copy compares. A release that changes anything else in the folder (the
// icon, the exe's metadata, packager or builder options) has a release-notes/vX.Y.Z.full-update file:
// then there's no small update, and every copy takes the full one.
function smallUpdate(appPath) {
  const asarRaw = path.join(appPath, "resources", "app.asar");
  const asarGz = path.resolve("dist", "ProtectPanes-app.asar.gz");
  const fullUpdateOnly = path.join("release-notes", `v${pkg.version}.full-update`);
  const electron = createRequire(import.meta.url)("electron/package.json").version;
  if (fs.existsSync(fullUpdateOnly)) {
    fs.rmSync(asarGz, { force: true }); // an older build's would otherwise be signed and shipped with this one
    console.log(`no small update: ${fullUpdateOnly} says this release changes more than app.asar`);
    return null;
  }
  fs.writeFileSync(asarGz, zlib.gzipSync(fs.readFileSync(asarRaw), { level: 9 }));
  console.log(`app.asar: ${asarGz} (${(fs.statSync(asarGz).size / 1e6).toFixed(1)} MB, for Electron ${electron})`);
  return { gz: asarGz, unpacked: asarRaw, electron };
}

if (installerOnly) {
  // The installer job's pass: the signed app folder, unzipped where packager puts it.
  const appPath = path.join("dist", "Protect Panes-win32-x64");
  if (!fs.existsSync(path.join(appPath, "ProtectPanes.exe"))) throw new Error(`no ProtectPanes.exe in ${appPath}`);
  await buildInstaller(appPath, installerSignHook({ swap: { unsigned: path.resolve(args[2]), signed: path.resolve(args[3]) } }));
} else {
  const appPath = await packageApp();
  const zip = zipApp(appPath);
  let installer = null;
  if (process.platform === "win32") {
    const uninstaller = path.resolve("dist", "ProtectPanes-uninstaller.exe");
    fs.rmSync(uninstaller, { force: true });
    installer = await buildInstaller(appPath, installerSignHook({ keepTo: uninstaller }));
    console.log("uninstaller, for the release workflow to sign:", uninstaller);
  }
  const asar = smallUpdate(appPath);

  // latest.json lets installed copies update in place (Settings -> Updates). Publish it with the zip,
  // the installer and the asar (when there is one).
  if (fs.existsSync(DEFAULT_KEY_FILE)) console.log("signed:", signRelease({ zip, installer, asar, version: pkg.version }));
  else console.warn(`not signed: no key at ${DEFAULT_KEY_FILE} (run node scripts/make-signing-key.js once)`);
}
