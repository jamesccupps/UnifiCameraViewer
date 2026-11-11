# Security policy

Protect Panes keeps the logins for your UniFi Protect consoles and installs its own updates, so security reports are welcome.

## Reporting a vulnerability

Report it privately through GitHub: **[Report a vulnerability](https://github.com/jamesccupps/UnifiCameraViewer/security/advisories/new)**, in this repository's Security tab. Please don't open a public issue for it.

Include:
- the version (camera list → **Settings → About**) and how it was installed: `ProtectPanes-Setup.exe`, the portable zip or Scoop;
- what you did, what happened, and what an attacker would gain;
- a proof of concept, if you have one.

Leave out real console addresses, passwords and camera images. Use a documentation address such as `192.0.2.10` in examples.

One person maintains Protect Panes, so there's no fixed response time. A confirmed problem is fixed in a new release, and the advisory is published once that release is out. You're credited in it unless you'd rather not be.

## Supported versions

Only the latest release gets fixes. Installed copies hear about a new release within a day and update from **Settings → Updates**; Scoop copies update with `scoop update protectpanes`. See [Updating the app](README.md#updating-the-app) for older copies that can't update themselves.

## What the app protects

Reports about any of these are in scope:

- **Saved passwords.** Console passwords are encrypted with Windows DPAPI for your Windows user (Electron's `safeStorage`). They never go into the log or into a settings export.
- **Console connections.** Consoles use self-signed certificates, so the app remembers each console's certificate (its SHA-256) the first time it connects. It refuses a different one before it logs in. Changing a console's address forgets its certificate and asks for the password again.
- **The app's windows.** No window can navigate away, open another window or get a browser permission. The main process answers only the app's own pages.
- **Updates.** An update installs only if `latest.json` carries the release's Ed25519 signature and the download matches its signed size and SHA-256. Older versions are refused, and plain `http://` update locations aren't accepted. The release workflow uses the signing key only in a job that runs none of the build's dependencies.
- **Releases.** From 1.4.8 `ProtectPanes.exe`, its uninstaller and `ProtectPanes-Setup.exe` are Authenticode-signed by James Cupps, in release jobs that run no npm code. Each release's SHA-256 sums are in `latest.json`, and in `SHA256SUMS.txt` for releases after 1.4.8.
- **The packaged exe.** It can't be run as Node (`ELECTRON_RUN_AS_NODE`), it ignores `NODE_OPTIONS` and `--inspect`, and it loads its code only from `app.asar`.

## Known limits

These are deliberate. They aren't vulnerabilities on their own, though a way around one of them is.

- **Programs running as your Windows user can read the saved passwords.** DPAPI keeps them from other accounts and other PCs, not from malware running as you. That's why the console account should have **View Only** access in Protect and nothing more.
- **The first connection to a console is trusted as is.** Make sure the address really is your console when you add it. After a reset, an update or a replaced console, a new certificate makes the app stop and ask before trusting it.
- **Whoever can write to the app's folder can replace the app.** Install it where only your account can write, such as Setup.exe's `%LOCALAPPDATA%\Programs\protect-panes`, not a folder at the root of `C:\`, which other accounts can change.
- **A shared folder or web address set as the update location** still needs the release signature. Whoever can write there can stop updates, but can't install anything of their own.
- **The in-app updater checks the Ed25519 signature, not Authenticode.**
- **The update helper is a hidden PowerShell window** started with `-EncodedCommand` and `-ExecutionPolicy Bypass`, once per update. Some security tools flag that pattern. It runs only after the checks above pass.

## Out of scope

- UniFi OS, UniFi Protect and the cameras themselves: report those to Ubiquiti.
- The [unifi-protect](https://github.com/hjdhjd/unifi-protect) library, Electron and Chromium: report those upstream. If Protect Panes needs a release to pick up the fix, report it here too.
- Attacks that need administrator rights, or code already running as your Windows user.
- Releases older than the latest.
