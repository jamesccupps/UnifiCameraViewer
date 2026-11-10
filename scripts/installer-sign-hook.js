// electron-builder's signing hook for Setup.exe's build (win.signtoolOptions.sign in build-win.js).
//
// Nothing is Authenticode-signed here. Releases are signed in Azure by jobs that run no npm code, so
// the signing sign-in never meets the build's dependencies (release.yml). But electron-builder makes
// the uninstaller and packs it into Setup.exe in the same run, so the workflow builds Setup.exe twice:
//   1. The build job's ordinary build keeps the uninstaller electron-builder made (keepTo), and a
//      signing job signs it, along with ProtectPanes.exe.
//   2. The installer job builds Setup.exe again, around the signed app folder, and this hook puts the
//      signed uninstaller in place of the one just made. Only if that one is byte for byte the one
//      that was signed: NSIS makes the same uninstaller every time for the same version and options,
//      whatever the app folder holds (checked with the exe changed), so a difference means the two
//      builds weren't of the same thing, and the build stops.
// electron-builder offers this hook its own elevate.exe (theirs, not ours) and Setup.exe too; both are
// left alone. Setup.exe is signed by the next job.
import fs from "node:fs";
import path from "node:path";

// electron-builder 26 writes the uninstaller as <installer name>.__uninstaller.exe (NsisTarget)
export const UNINSTALLER_SUFFIX = "__uninstaller.exe";

/**
 * @param {{ keepTo?: string, swap?: { unsigned: string, signed: string } }} opts
 * @returns the hook, with `uninstallers()`: how many uninstallers it was offered (one per build)
 */
export function installerSignHook({ keepTo = null, swap = null } = {}) {
  let offered = 0;
  const hook = async ({ path: file }) => {
    if (!path.basename(file).endsWith(UNINSTALLER_SUFFIX)) return;
    offered++;
    if (swap) {
      if (!fs.readFileSync(file).equals(fs.readFileSync(swap.unsigned))) {
        throw new Error(`the uninstaller this build made isn't ${swap.unsigned}, the one that was signed: were both built from the same commit?`);
      }
      fs.copyFileSync(swap.signed, file);
    } else if (keepTo) {
      fs.copyFileSync(file, keepTo);
    }
  };
  hook.uninstallers = () => offered;
  return hook;
}
