# Protect Panes - notes for Claude Code

Windows desktop app (Electron) that shows UniFi Protect **live view only**, one borderless window per camera. Each window can sit anywhere on screen at any size, positions are remembered, and it supports several consoles at once. It runs on a Dell OptiPlex (Intel integrated graphics) next to exacqVision, so camera windows must never steal focus. The owner has two UniFi OS consoles on the same LAN, "Building" and "Garage", and signs in with **local-only** accounts.

Hard requirements, all deliberate:
- **No RTSP/RTSPS.** Video comes from Protect's own livestream websocket (fMP4) via the `unifi-protect` library. The owner keeps RTSPS off.
- **Direct login by IP** with a local account. No ui.com/cloud, no MFA.
- **Low resource use.** Medium channel by default, GPU decode via MSE, minimized windows stop streaming, WebGL only for 360° windows.

Current version: **1.4.9**, released through the GitHub Actions release workflow. Each version's additions (ROADMAP.md has the detail):
- **1.2.0:** color-range fix for crushed shadows, name label collapse and per-window hide, clock on 360° views, Apply to all, Hide / Show cameras, named layouts with Protect liveview import, signed in-place updates.
- **1.3.0:** the Setup.exe installer, Arrange and Close all, the layout editor, the tabbed camera list with hover tips, 360° Single view, and undici patched for security.
- **1.3.1:** portable copies' in-app update fixed (the helper's working folder blocked the swap); Arrange / "Use what's on screen" missing just-shown windows.
- **1.4.0:** grid windows, Hide from list, camera previews, Adjust picture (brightness / contrast), small app.asar-only updates, async safeStorage.
- **1.4.1:** a click in the camera list brings it back above a camera opened from it. The first release 1.4.0 copies take as a small update.
- **1.4.2:** an aspect ratio choice for 360° views (16:9, 4:3, 3:2, 1:1, 21:9, any shape). Start with Windows touches the Run key only when it needs changing, never in test runs (a Defender ASEP alert).
- **1.4.3:** enlarge a grid tile; import a Protect liveview as a grid window, with its cycling tiles; previews in the layout editor; settings export / import (no passwords); cameras on UniFi Access door readers (UA G3 Pro). Security: TLS pinning on first use, and pages that can't navigate, open windows or get permissions, with IPC answering only the app's own pages. Fixes: windows growing at fractional scaling, places after a monitor returns, config.json surviving a power cut, logins retried while UniFi OS boots, offline cameras and streams that never start backing off, frozen pictures and crashed pages restarting, 360° through a GPU reset, and a camera list that no longer flickers.
- **1.4.4:** fixes from a full review.
  - Security: the update location stays per PC on import, imported settings are type-checked, and releases are signed in a job that never runs the build's dependencies.
  - Fixes: Access reader windows stay paused; saves survive a deleted config.json; import cleans up addresses, drops duplicate console ids and reads a byte-order mark; incomplete 360° records are filled in; a stream that keeps ending waits before reconnecting; "in grid" covers only what a cycling tile shows.
  - Also: a project page (site/), and `release-notes/vX.Y.Z.full-update` for releases that must skip the small update.
- **1.4.5:** security updates from a second review: Electron 45.0.0 → 45.2.3 (Chromium MediaSource and ffmpeg fixes among them), Electron fuses on the packaged exe, the update helper started by System32 paths, and undici 8.12.4. Grid → Layout asks before a smaller layout drops cameras. A full update for every copy, since the Electron version changed. Not taken from that review yet: B2/P3 (enlarging a tile restarts its stream; the real fix is starting the new stream before stopping the old), the smaller fixes B3, B4, B6, B7, U3 and U5, and unifi-protect 5.4.0 (wait for a 5.4.1, or a firmware update that breaks 5.3.1).
- **1.4.6:** the rest of that review's smaller fixes: a 360° aim survives a settings refresh mid-drag (B3), a click's list refresh still renders during a poll's (B4), layouts drop removed consoles' cameras (B6), one camera-key check for the list's IPC (B7), a daily update check (U5), and doc drift (D1-D3). A small update for 1.4.5 copies. Still open: U3 (Win+↑ on a locked window, unverified: testing it means sending Win+↑ to the owner's foreground window), B2/P3, and unifi-protect 5.4.0.
- **1.4.7:** make-before-break for grid tiles (B2/P3 for tiles, ROADMAP #5's pre-buffering): a cycle step, an Enlarge, a resize and a tile's Quality menu keep the old picture until the new stream's first frame. Copies installed with Scoop leave updates to `scoop update` (an in-app full update confused Scoop's records). Install with Scoop in the README and on the project page. A small update for 1.4.5 and 1.4.6 copies. Still open: U3, camera windows' quality changes (P3's other half), tiles resuming after Enlarge still show "Connecting…", and unifi-protect 5.4.0.
- **1.4.8:** Authenticode-signed (James Cupps, Azure Artifact Signing): the exe, the uninstaller and Setup.exe, from release jobs that run no npm code (see Releasing). Nothing else changes. A full update for every copy (`release-notes/v1.4.8.full-update`), so each gets the signed exe.
- **1.4.9:** Electron 45.2.3 → 45.3.1: Chromium 156.0.8078.96, backported Chromium/Dawn/V8 fixes, eMudhra's revoked intermediates no longer trusted, and a Windows fix for hidden owned windows that DWM drew as blank boxes (Electron #55630; Hide cameras / Hide all checked by the hide suite). Nothing else changes. electron-builder stays at 26.17.0: an upgrade goes in its own change, with a signtest tag, because the uninstaller swap needs it to make the same uninstaller every run. The first release with `SHA256SUMS.txt`. A full update for every copy, since the Electron version changed.

The owner ran 1.0 to 1.2 on the real consoles, and their installed copy updated itself from 1.3.1 to 1.4.0 in the app (the installer path). Later versions are tested against the real consoles only through runs from source on a copy of the config. For 1.4.3 the owner used such a run themselves before the release: liveview import, enlarge, reconnect and the Access reader.

`SECURITY.md` tells reporters what the app protects and what it doesn't: saved passwords, TLS pinning, pages that can't leave, the updater's checks, release signing and the fuses. Keep it in step when any of those change. Reports come in through GitHub's private vulnerability reporting (on since 2026-11-11).

## Commands

```
npm install
npm start                 # run from source (uses the real config - quit the installed app first, see Gotchas)
npm run mock              # fake consoles with ffmpeg test patterns, no network
npm test                  # all test suites below (~6 min; windows are invisible, PANES_TEST_SHOW=1 to watch)
npm run test:mock         # mock cameras: playback, forced reconnect, 360° quad/panorama, real mouse PTZ input, name label, Apply to all
npm run test:hide         # Hide cameras / Show cameras / per-console Hide all, across two launches
npm run test:bounds       # window and grid sizes stay put across launches at a forced 150 % scale; a monitor dropping out and back
npm run test:connection   # ConsoleConnection and CameraStream unit checks with fake library objects (runs under Electron's Node)
npm run test:config       # config.json recovery (.bak fallback) and odd shapes that must not stop startup
npm run test:security     # pages can't navigate, open windows or get permissions; IPC answers only the app's pages
npm run test:streams      # stream recovery: a camera going offline while viewed, a stream that never decodes, a frozen picture, a crashed camera page, a lost WebGL context, an unplayable codec
npm run test:range        # SPS color-range rewrite (unit, ffmpeg fixtures) + displayed pixel levels in Chromium, Adjust picture
npm run test:layouts      # save / apply named layouts, import a Protect liveview, switch from the tray
npm run test:update       # signed manifest, verified download, the real swap helper (folder, installer, app.asar), camera-list Updates
npm run test:arrange      # layout geometry (unit) + Arrange / Close all on real windows
npm run test:editor       # layout editor: synthetic drag-and-drop into tiles, 360° view per tile, Edit, fill from screen
npm run test:list         # camera list: Hide from list, previews (thumbnails, hover, request caching, setting)
npm run test:grid         # grid windows: built in the editor, tiles live, tile/grid menus, Hide/Show, relaunch, layout switch (a smaller one asks first)
npm run test:transfer     # settings export/import: no passwords in the file, which passwords survive an import, this-PC settings, backup
npm run test:cycle        # cycling grid tiles: order, per-camera settings, stops when hidden, no leftover streams, import and re-save; no blank tile on a switch or a quality change
npm run test:e2e          # fake UniFi OS consoles over HTTPS/WSS through the real unifi-protect library (incl. snapshots, 1.3.x passwords)
npm run test:release      # release.yml's rules (which jobs can sign, what runs in them) and the uninstaller swap; no app runs
npm run build:win         # dist/Protect Panes-win32-x64/ + zip + ProtectPanes-Setup.exe + ProtectPanes-app.asar.gz + latest.json (signed)
                          #   + ProtectPanes-uninstaller.exe; no Authenticode (the release workflow does that, see Releasing)
```

**Run `npm test` after any change and before building.** It prints PASS/FAIL per check, and keeps screenshots of every window plus `result.json` (per-window playback stats) in the printed results folder. **Look at the screenshots** for anything visual. Tests use their own temp settings folder, so they never touch the real config and can run while the app is open.

Test windows are real windows at their real places and sizes, but `keepWindowsOutOfTheWay()` (selftest.js) makes every window invisible, click-through, unfocusable and taskbar-less from the moment it's created. The owner works on this PC while tests run, and visible test windows kept taking the focus. Screenshots (`capturePage`) and pixel checks are unaffected. Self-test runs also turn off Chromium's `CalculateNativeWinOcclusion`. Otherwise a test window covered by the user's windows counts as hidden: `document.hidden` stops the camera list's previews, which once failed the e2e preview check while the owner worked. `PANES_TEST_SHOW=1` keeps the windows visible.

`PANES_DEVTOOLS=1 npm start` opens detached DevTools for every window. `PANES_DEBUG=1` adds debug lines to the log.

## Layout

```
src/main.js                 App lifecycle, camera windows and grid windows' players, camera list window, tray, context menus, IPC, settings, dewarp settings
src/console-connection.js   One logged-in console (ProtectClient), connect/backoff, state; channelList / resolveChannel / fisheyeInfo
src/cert-pins.js            TLS trust on first use for the consoles: wraps tls.connect, checks each console's certificate SHA-256
src/camera-stream.js        Pumps one camera's livestream subscription to its page (init/media/status), reconnect handling
src/bare-livestream.js      Livestreams for UniFi Access cameras (UA G3 Pro): reads Protect's socket itself and builds the fMP4 (no Electron imports)
src/avc-range.js            Rewrites the H.264 SPS in the init segment to declare full color range (see Gotchas)
src/grid.js                 Screen layouts (1, 2x2, 1+5 … 5x5, Auto), cell rects, aspect fit, reading order, quality-for-tile-size (no Electron imports)
src/grid-window.js          Grid windows: one framed window, a WebContentsView per tile running camera.html?tile=1, tile geometry
src/window-bounds.js        placeWindow / windowBounds: bounds that survive save and restore at fractional scaling
src/previews.js             Camera-list stills: Protect snapshot → data: URL, 30 s cache, 3 requests at a time (no Electron imports)
src/updater.js              In-place updates: verify signed latest.json, verified download, swap helper for folder / installer / app.asar (no Electron imports)
src/update-key.js           Release-signing PUBLIC key (generated by scripts/make-signing-key.js)
src/store.js                config.json load/save (debounced; fsync, .bak, fallback on load), DPAPI password encryption via async safeStorage
src/log.js, src/util.js     File logger (rolls at 2 MB); sleep/debounce/throttle/normalizeHost
src/preload-camera.cjs      Camera page bridge (windows and tiles) - IN/OUT channel allowlists
src/preload-grid.cjs        Grid window's own page bridge: grid:layout in, grid:context-menu out
src/preload-manager.cjs     Camera list bridge - invoke allowlist
src/renderer/camera.*       Camera page: MSE playback, live-edge tracking, codec fallback, hover bar, status, notices, Adjust picture panel
src/renderer/dewarp.js      360°: WebGL fisheye dewarp (quad / panorama), PTZ input, circle auto-detect, calibration UI
src/renderer/grid-window.*  The page under a grid window's tiles: empty-tile placeholders, right-click
src/renderer/manager.*      Camera list: Cameras / Layouts / Settings tabs, previews, hover tips (data-tip), vanilla DOM, no innerHTML with camera/console names
src/mock.js                 Dev-only fake consoles/cameras (--mock); PANES_MOCK_FISHEYE adds a 360 camera, cfg.mockOffline marks cameras offline, cfg.mockDropout takes one offline and back mid-run, "… Broken" never decodes, "… Rewind" freezes, "… Bogus" has no playable codec, "… NoMedium" has Medium off
src/selftest.js             Dev-only harness, active only when PANES_SELFTEST_DIR is set
test/run.mjs                Test runner (all the suites above, with assertions)
test/legacy-password.cjs    Writes a password the way 1.3.x did (sync safeStorage), for the e2e upgrade check
test/connection-unit.mjs    ConsoleConnection with a fake ProtectClient.connect (run under Electron's Node by the connection suite)
test/fake-console/          Fake UniFi OS console (HTTPS + WSS + snapshots) and its throwaway self-signed cert
test/fixtures/              Synthetic fisheye frames with known geometry (ceiling circle truth: x .513, y .4938, r .4818)
scripts/build-win.js        @electron/packager folder, Electron fuses flipped, zip, then electron-builder NSIS --prepackaged on that same folder -> Setup.exe; signs latest.json if the key exists
.github/workflows/test.yml  CI: npm test on windows-latest, plus a real Setup.exe install / start / uninstall on the runner
scripts/sign-release.js     Writes latest.json {payload, signature} for a zip, installer and app.asar.gz (Ed25519, private key outside the repo)
scripts/make-signing-key.js One-time: create the signing key pair (refuses to overwrite)
scripts/verify-release.mjs  Check a release folder like installed copies will (signature, sizes, hashes); the release workflow gates on it
scripts/check-packaged.mjs  Run the built app from a plain and an awkward install folder; checks its pages still get IPC answers (release workflow)
.github/workflows/release.yml  Tag vX.Y.Z -> build job: test, build, smoke-test the installer; publish job (no dependencies installed): sign with the UPDATE_SIGNING_KEY secret, verify, publish
release-notes/vX.Y.Z.md     Release text the workflow publishes
site/                       The project page, https://jamesccupps.github.io/UnifiCameraViewer/ (see Project page); left out of the build
.github/workflows/pages.yml Publishes site/ plus assets/icon.png to GitHub Pages when they change on main
```

## How video flows

1. `ConsoleConnection` → `ProtectClient.connect({ host, username, password })` (unifi-protect **v5** API).
2. `CameraStream` → `cam.livestream({ source: { type: "channel", channel }, urgency: () => 5000, discardOnDispose: true })`, an async iterable of `Segment`s:
   - `{ type: "init", codec, data }`
   - `{ type: "media", data, discontinuity? }`
3. Main forwards these to the window as `cam:init` `{ codec, data, reset }` and `cam:media`. Media segments go as the library built them (each in its own buffer, `Buffer.alloc`, offset 0; IPC copies anyway). Only a view into a larger buffer is copied first, so no neighbouring bytes go along. `cam:status` carries live / connecting / reconnecting / waiting / offline / paused / error.
4. The renderer appends to a MediaSource `SourceBuffer`:
   - It holds about 0.2-0.7 s behind live: it plays 1.15× faster when behind, and jumps forward past 1.5 s.
   - It trims history older than 12 s.
   - Anything unrecoverable sends `cam:reset`, and main restarts the subscription. Resets are at least 3 s apart; one asked for sooner waits rather than being dropped (dropping it once left a closed MediaSource under a "live" status: black with a green dot). The gap doubles while restarts fail with no frame shown in between (up to 60 s), and after 3 the window says the PC couldn't decode the stream and suggests a lower quality. A frame on screen (`requestVideoFrameCallback`) clears the count. The mock's "… Broken" camera sends fragments no decoder takes; the streams suite checks it.
   - A 1 s watchdog restarts the stream when fragments keep appending (10+) but `totalVideoFrames` hasn't moved for 5 s while live and visible: a hung decoder, or a restart whose timestamps went back to zero without a discontinuity flag (its video lands behind the playhead, and the picture froze until the new timeline caught up). Stalls with no fragments arriving are the library's to detect. The mock's "… Rewind" camera does the unflagged restart.
5. On reconnect the library rebases timestamps to zero and flags `discontinuity`. Main then resends init with `reset: true`, and the renderer rebuilds the MediaSource.
   - **The held frame** (since 1.4.10). Every init is `reset: true`, so every stream start rebuilds: another quality, a resume after a pause (minimize, Hide cameras, a tile behind an enlarged one), a reconnect, a page-asked reset. `rebuild()` and `requestReset()` first copy the video's last frame onto `#hold`, a canvas over the video (`holdLastFrame()`). The new stream's first frame (`requestVideoFrameCallback`) releases it and shrinks it to 1×1, since a 4K frame is about 33 MB. Not in a 360° view: the Dewarper draws only when the video has a frame, so its canvas keeps the last view anyway. Released at once when the new stream can't play (codec error). It gets the Adjust picture filter too.
   - A `connecting` status over a picture says nothing for `QUIET_MS` (4 s). After `live` (a quality change) the overlay stays hidden, because the picture is current. After `paused` it shows dimmed, with no words (`.status.quiet`), because the picture is older. After 4 s without video it says "Connecting…" as before. Never after a failed decode (`failedResets`): that says what's happening at once.
   - Before: "Connecting…" for about half a second, then black until the first frame. Measured with the mock: no blank probe at 100 ms on this PC, so the black was short; the words were what showed. The mock suite (a window's Quality change) and the grid suite (tiles coming back after Enlarge) probe the page every 100 ms. Both fail on 1.4.9 because of the words.
6. 360°: `Dewarper` reads `<video>` frames as a WebGL texture (on `requestVideoFrameCallback`) and draws the views. The video element stays rendered *under* the canvas: rVFC doesn't fire for hidden videos.

## IPC

Adding a channel means editing **both** the preload allowlist and `registerIpc()` in main.js. Main identifies camera pages (windows and grid tiles) by `event.sender.id` → `senders` → player, never by anything the renderer sends. Every handler also checks that the sending frame's URL is the app's own page for that role (`ourPage()` → `isFileUrlOf()` in util.js: camera.html, grid-window.html, manager.html). The comparison isn't a plain decode, because Chromium and Node spell paths differently, as measured in a packaged build: Chromium leaves a `%` in a folder name raw (`100%%20O'Brien`, which no decoder accepts) and `~` as is, while Node 24 writes `%25` and `%7E`. Both sides are brought to one form by decoding printable-ASCII escapes only. The first version decoded the URL; it threw on the raw `%`, so a packaged app in such a folder answered no IPC at all. Tests from source couldn't see it. `scripts/check-packaged.mjs` runs the built app from a plain and an awkward folder, and the release workflow runs it.

**No page can leave.** `web-contents-created` blocks `will-navigate`, `will-redirect` and webviews, and denies `window.open`; the default session refuses every permission request. Before 1.4.3 a file or link dropped onto any window navigated it, and the dropped page kept that window's IPC: on the camera list it could re-point a saved console at another host, which then got the password. `loadFile` and `reload` are programmatic and unaffected.

- **Camera → main:** `cam:ready`, `cam:aspect {width,height}`, `cam:reset`, `cam:unsupported`, `cam:enlarge` (a grid tile's double-click), `cam:shown` (the first frame after an init; a grid tile's next page takes over), `cam:context-menu`, `cam:toggle-top`, `cam:close`, `cam:dewarp {views?, pano?, focus?, circle?, auto?}`, `cam:picture {brightness, contrast}`
- **Main → camera:** `cam:init`, `cam:media`, `cam:status`, `cam:meta`, `cam:highlight`, `cam:command {cmd: "calibrate" | "autodetect" | "picture"}`
- **Grid window page:** in `grid:layout {rects, filled}`, out `grid:context-menu tileIndex|null`.
- **Camera list (invoke):** `mgr:state`, `mgr:save-console`, `mgr:remove-console`, `mgr:reconnect`, `mgr:trust-cert consoleId`, `mgr:open-camera`, `mgr:close-camera`, `mgr:find-camera`, `mgr:set-channel`, `mgr:set-setting`, `mgr:bring-to-front`, `mgr:reset-positions`, `mgr:open-all`, `mgr:hide-cameras consoleId|null`, `mgr:show-cameras consoleId|null`, `mgr:apply-all {consoleId|null, changes}`, `mgr:save-layout name`, `mgr:apply-layout id`, `mgr:delete-layout id`, `mgr:liveview-draft {consoleId, liveviewId}` (→ an editor draft `{name, displayId, templateId, cells, left}`; nothing is saved), `mgr:set-update-source`, `mgr:check-update`, `mgr:install-update`, `mgr:close-all consoleId`, `mgr:arrange {templateId}`, `mgr:save-editor-layout {id?, as: "windows" | "grid", name, displayId, templateId, cells: [{key, mode} | null], apply}`, `mgr:set-list-hidden {key, hidden}`, `mgr:preview key` (→ `{url, at}` or null), `mgr:open-grid id`, `mgr:close-grid id`, `mgr:delete-grid id`, `mgr:open-log-folder`, `mgr:export-settings` / `mgr:import-settings` (main shows the file dialogs and the import's confirmation; → `{path}` / `{restarting}` or null when canceled), `mgr:open-project` (a fixed URL; the renderer can't pass one), `mgr:raise` (the list's pointerdown, see Windows never steal focus), `mgr:quit`. `changes` goes through `cleanChanges()`, which keeps only `channel`, `onTop`, `hideName`, `clock`, `range` and `picture`.
- **Main → camera list:** `mgr:changed` (throttled). The list also polls every 3 s while visible, for online/offline status. Both skip the re-render while a dialog, a ⋯ menu or a dropdown is open (`select:open`, not a focused select: a used quality select keeps the focus, which once stopped status updates for hours). ⋯ menus close on Esc and when the list loses focus. `mgr:state` carries `openEditor: gridId` once when a tile's menu asked for Edit grid….

## Config and logs

`%APPDATA%\Protect Panes\`:

- `config.json`:
  - `consoles[]`: `{id, name, host, username, password: {enc: "safe" | "plain", data}, certSha256?}`. `certSha256` is the console's TLS certificate fingerprint, saved the first time it's seen (see Gotchas: TLS pinning).
  - `windows["<consoleId>/<cameraId>"]`: `{open, bounds, channel, onTop, name, hideName, hidden, listHidden, clock, range, picture, dewarp}`. `range` is `"full" | "limited"` (absent = auto). `clock` true/false overrides the default (on in quad/panorama, off otherwise). `hideName` hides one window's label; `settings.showNames` off hides all of them. `hidden` (with `open: true`) means taken off screen by Hide cameras / Hide all. `listHidden` is Hide from list. `picture` is `{brightness, contrast}` (0.5-2, absent = both 1).
  - `settings`: `{lockLayout, showNames, lockAspect, hideFromTaskbar, startHidden, launchAtLogin, arrangeQuality, showPreviews, updateSource}`. `arrangeQuality` (default on) lets Arrange set each camera's channel from its tile's physical width: up to 700 px Low, up to 1400 px Medium, above that High. `updateSource` is an `https://` base URL or a folder (UNC or drive path) holding `latest.json` and the zip. Plain http is refused. It defaults to `https://github.com/jamesccupps/UnifiCameraViewer/releases/latest/download`, and blank turns checks off. `runApp()` in the tests blanks it unless a suite sets one, so tests never touch the network.
  - `layouts[]`: `{id, name, windows: {"<consoleId>/<cameraId>": {bounds, channel, onTop, hideName, clock, range, picture, dewarp}}, editor?}`. Saving under an existing name (case-insensitive) replaces it. `editor: {displayId, templateId, cells}` is present only on layouts built in the layout editor, and is what its Edit button reopens.
  - `grids[]`: `{id, name, templateId, bounds, open, hidden?, onTop?, editor: {displayId}, tiles: [{key, channel?, range?, picture?, hideName?, clock?, dewarp?, cycle?: {seconds, then: [{key, ...the same settings}]}} | null]}`. A tile has its own settings, separate from the camera's window, so a 360° camera can be Panorama in a grid and Quad in its window. A tile with no `channel` follows its tile size.
- `config.json.bak`: the config.json from before the last save. Each save writes `config.json.tmp`, fsyncs it, moves config.json to `.bak`, then moves the new one in. NTFS journals renames but not data, so before 1.4.3 a power cut just after a save could leave config.json full of zeros, and the app started empty without a word. Loading falls back to `.bak` when config.json is missing (a save cut off between the two moves) or unreadable. An unreadable file is kept as `config.json.corrupt-<time>`, and it never becomes the next `.bak`. A config.json deleted while the app runs (a sync tool, antivirus) is written again by the next save, and the `.bak` stays as it was. Before, the move to `.bak` threw first, and every save failed until a restart. Load and save problems go to the log (`store.setLogger()`; the store exists before the logger).
- Loading drops window and layout entries that aren't objects, and a grid on a template without fixed cells (`auto`, or an unknown id) shows as 2×2. Either one used to crash startup on every launch. Top-level keys this version doesn't know are carried through, so a downgrade and upgrade keeps them. A startup failure goes to the log and, outside test runs, a `showErrorBox`; before, it exited with nothing shown.
- `protect-panes.log`: connection log. Rolls to `.log.1` at 2 MB.

Passwords are DPAPI-encrypted (`safeStorage`, the async API since 1.4.0) and tied to the Windows user. `enc: "plain"` is base64 and only exists in tests and on Linux without a keyring. **Never print or log decrypted passwords.**

`dewarp`: `{mode: "off" | "quad" | "panorama", mount: "ceiling" | "wall" | "desk", lensFov, circle: {x, y, r} | null, views: [{pan, tilt, fov} × 4], focus, pano: {pan, tilt}, aspect?}`
- `aspect` is the shape the window keeps in a dewarp mode: `"16:9"` (absent), `"4:3"`, `"3:2"`, `"1:1"`, `"21:9"` or `"free"` (no lock). The views fill whatever shape the canvas has, so this only changes the lock. `preferredAspect()` returns 0 for free, and the page reports it to main as `cam:aspect {0, 0}`, which clears `cw.aspect`. Grid tiles don't offer it.
- Angles are degrees. `fov` is vertical FOV. Pan wraps to (-180, 180]; tilt clamps to ±90.
- `circle` is normalized: `x` = center x / video width, `y` = center y / video height, `r` = radius / video height.
- `undefined` means never decided. On first view, `ensureDewarp()` turns on quad for fisheye cameras. `null` means a normal camera.
- A saved record with a field missing or invalid (a hand-edited or crafted file; the app always writes whole ones) gets it filled in from its mount's defaults by `completeDewarp()` when the camera is shown, before the page sees it. The page's drawing assumes every field: a panorama without `pano` threw on every frame and showed a blank view. Something that isn't a record at all is decided again, like `undefined`.
- **The lens is per camera, the view is per copy.** `mount`, `lensFov` and `circle` describe the physical lens. The window entry, every layout and every grid tile keep their own `dewarp` copy. Before 1.4.3 a circle fixed in the window was undone by the next layout switch and never reached the camera's grid tiles.
  - `shareLens()` writes a lens edit into every copy, open or closed: a circle from Adjust image circle or Auto-detect, a mount or lens FOV from the menu. Another mount resets that copy's views.
  - `applyLayout()` keeps the lens the camera has, not the one the layout was saved with.
  - A page guesses a circle on first view when its copy has none, and sends it with `auto: true`. If another copy already has a circle, that one wins and the guess isn't spread (`knownCircle()`).
  - The grid suite's third run checks all three.

## Gotchas

- **Single-instance lock is per settings folder.** `npm start` with the default folder just focuses the already-running installed app. Quit it first (tray → Quit), or set `PANES_USER_DATA=<folder>` to run separately.
- **unifi-protect is v5.** Don't follow older examples that use `ProtectApi` / `ProtectLivestream` / `getBootstrap()`; those are v4. Read `node_modules/unifi-protect/dist/*.d.ts`. It needs Node ≥ 22.20 inside Electron; Electron 45 ships Node 24. Version is pinned on purpose. When Protect firmware breaks something, bump the library first, then run `npm test`.
- **The library's live recovery never gives up.** With `urgency` set, a subscription whose camera went offline (or whose channel was turned off in Protect) stays `recovering` and renegotiates every few seconds for as long as the window is open: about 1000 requests an hour, each one counted by the library's per-console circuit breaker. `CameraStream`'s 1 s monitor drops the subscription when it's recovering and the camera is offline or the channel is gone. The loop then shows "Camera offline" and checks every 10 s, or picks another channel. The cost: a camera that comes back takes up to 10 s to show, not about 4. The mock's `cfg.mockDropout` stalls a stream the same way; the streams suite checks it.
- **Shared sessions.** The library pools one livestream session per camera and channel, so a window and a grid tile of the same camera at the same quality share one websocket. Restarting only one player's subscription rejoins that session. `reconnectStream()` (Reconnect stream, in window and tile menus) stops every player on it first, then starts them. e2e checks the fake console sees a new negotiation.
- **A stream that never starts** (the library gives up establishing it and throws `ProtectLivestreamUnavailableError`) is retried after 10 s, 30 s, 2 min, then every 5 min; any video resets that. It used to be a flat 10 s forever, each try a ~30 s establish phase with about 4 negotiations. Subscribers only ever get that error or `ProtectCodecChangeError` from the library's pool, so there is no 403 branch (there was one, unreachable). A subscription whose iteration just ends, with no error (the library's recovery gave up), waits `RESTART_GAP_MS` (3 s, as after other stream errors) and shows "Reconnecting…" before subscribing again. Until 1.4.3 it resubscribed at once, so such a camera was renegotiated back to back.
- **TLS pinning (cert-pins.js).** Consoles have self-signed certificates, so the library connects with certificate checks off on its HTTP pool, events stream and livestreams. Before 1.4.3 anyone on the LAN who took over a console's address got the local password at the next login.
  - Now each console's certificate SHA-256 is saved on first use (`certSha256`), and every later TLS connection to that host:port must match. A mismatch destroys the socket at `secureConnect`, before undici sends anything. Ours runs first because it's registered inside the wrapped `tls.connect`, before undici adds its own.
  - It wraps `tls.connect` rather than handing the library a dispatcher and a WebSocket factory: an injected factory gets only the URL, and the events stream would lose its auth headers. Non-console hosts are untouched; the updater uses Chromium's `net.fetch` anyway.
  - A mismatch puts the console in `certchanged`, with no retry. Its card shows "Trust the new certificate…", which confirms with both fingerprints and calls `mgr:trust-cert`. A mid-session change shows the same state while the library keeps retrying, and every try is refused.
  - Changing a console's host drops its pin and needs the password typed again: another address is another device, and a mistyped IP would otherwise get the saved password.
  - Limits: the first connection is trusted as is, and a console reset or update can make a new certificate, which the owner then accepts.
  - Not installed in `--mock` (no TLS). e2e checks first use, refusal before login and trusting.
- **A refused login is retried.** The library turns every non-2xx login answer into `ProtectAuthError`, including the 502/503 UniFi OS gives while it boots. Before 1.4.3 that stopped the console for good at "Login failed", so after a power cut that brought the PC up first, every camera on it stayed dark until Reconnect. `ConsoleConnection` now retries refused logins (and "no access to Protect") after 15 s, 30 s, 1, 2, 5, then every 10 min, which keeps a real wrong password far from any lockout. The state stays `authfailed` in between. Saving the console retries at once.
- **Unit checks that need unifi-protect** run under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), since the library needs Node ≥ 22.20 and a plain `node` may be older. `test/connection-unit.mjs` is one: `ConsoleConnection` takes `{ connect, authRetryMs }` so a fake can stand in for `ProtectClient.connect`.
- **Console host must be a bare IP/hostname.** The library rewrites the livestream WS hostname to the configured host, and `host:port` doesn't rewrite. The tests use ports only because they're local fakes.
- **Codec strings from the console aren't guaranteed to be valid RFC 6381.** `pickMime()` falls back to `codecFromInit()`, which parses avcC/hvcC/av1C/mp4a from the init segment. An H.265 camera needs hardware HEVC decode. If that's missing, the window tells the user to switch the camera to H.264, and sends `cam:unsupported`: main stops that stream (`CameraStream.halt()`) so the console isn't asked for video nothing can play. Another quality, Reconnect stream, a page reload or a restore after minimizing starts it again. The mock's "… Bogus" camera sends such a codec.
- **WebGL fallback.** `app.commandLine.appendSwitch("enable-unsafe-swiftshader")` lets Chromium render WebGL on the CPU when there's no usable GPU driver. Without it, current Chromium disables WebGL and 360° silently degrades to raw fisheye. `Dewarper` detects a software renderer and draws at half resolution. The GL context is created lazily, only for windows in a dewarp mode.
- **Leaving 360° gives the GPU memory back:** the hidden canvas shrinks to 1×1 by itself, and the video-sized texture (15-20 MB at High) is reset to 1×1 too; the next frame uploads a full one. The "needs WebGL" notice shows once, not on every settings refresh.
- **WebGL context loss** (driver update, GPU reset): the lost/restored listeners are registered once, in the `Dewarper` constructor. They used to be added in `#initGl`, which the restore handler re-ran, so they doubled on every restore and each restore recompiled the program 2^(k-1) times. A restore re-runs only `#setupGl` (program, quad, texture). If the context isn't back after 5 s (Chromium blocks WebGL after repeated GPU crashes), `glBroken` hides the canvas and shows the raw fisheye with a notice, until a restore. The streams suite loses and restores it through `WEBGL_lose_context`.
- **Fisheye model is equidistant** (r ∝ θ), 180° lens default. Mount → lens frames live in `LENS` in dewarp.js. Pan 0 = top of the fisheye image for ceiling mounts. This was verified with synthetic frames only, not a real AI 360 lens; real lenses may need a lens-profile curve.
- **Circle auto-detect.** It scans 120 rays for the point where the picture goes dark for good, then fits with RANSAC + a Kasa least-squares fit. The test fixture deliberately includes an OSD timestamp and black boxes inside the circle. Keep both passing if you touch it.
- **Name label auto-collapse.** `fitLabel()` in camera.js measures the full label on every resize and title change. When the label is wider than `LABEL_MAX_SHARE` (50%) of the window, only the status dot is shown. Measuring is deliberate, because a fixed breakpoint fits short names or long ones, never both.
- **Aspect lock.** The renderer reports the aspect it wants: the video size normally, 16:9 in dewarp modes. Main calls `setAspectRatio` and snaps the window height. Calibration deliberately doesn't change aspect.
- **Monitors coming and going.** When a monitor drops out (unplugged, a KVM switch, DisplayPort sleep), Windows moves its windows onto the other screens. Saving those moves made them the layout for good. Now for 3 s after any `display-removed` / `-added` / `-metrics-changed`, moves aren't saved (camera windows and grids). 1.5 s after a monitor is added or changes, every window whose saved place fits on screen again goes back there (`restoreSavedPlaces()`). Saved bounds are reused only if the window's top edge, where its drag strip is, lands on a work area (`fitsOnScreen()`); before, a window with only its bottom on screen couldn't be dragged back. The bounds suite fires the events itself and moves the windows the way Windows would. Whether Windows' own move events always arrive inside that 3 s isn't verified with a real monitor.
- **Window bounds round trip (window-bounds.js).** At fractional scaling Electron rounds a window's edges outward when it reads bounds back, so `getBounds()` can be 1 DIP bigger than what `setBounds()` just set, and constructor bounds come out 2-4 DIP bigger. Saving `getBounds()` made camera and grid windows grow on every launch (measured at 150 %: 480 → 482 → 485 → 489 wide with the aspect lock off; on, the lock hid it).
  - Set bounds with `placeWindow(win, b)`, which also runs right after each window is constructed.
  - Read the bounds to save or compute from with `windowBounds(win)`. It returns the placed bounds until the window really moves or resizes, so a restore is a fixed point.
  - Plain `getBounds()` is fine for picking a display or a reading order.
  - `npm run test:bounds` forces the scale with Chromium's `--force-device-scale-factor=1.5`, so it reproduces at any scale, CI's 100 % included. The owner's displays have been 150 % and 200 %; 200 % never rounds.
- **Color range (why pictures looked dark).** Measured on the owner's cameras (2026-10-27, Low channel):
  - Every camera sends full-range luma (0-255). The worst garage camera had 4% of picture pixels below 16.
  - Only some flag it: one camera's SPS says `pc, bt709`. Three others have a VUI with no `video_signal_type`.
  - Chromium reads unflagged streams as limited, so everything below 16 went solid black: 6% of one camera's picture in the app, against 0.1% in a PC-range decode.
  - `applyRange()` (avc-range.js) rewrites the avcC SPS in `CameraStream`'s `sendInit` to declare full range.
  - Chromium ignores the range bit unless `colour_description_present_flag` is set, so the rewrite also writes BT.709 when there's no color description.
  - Streams that already flag a range are left alone. Right-click → Color range (`range`) overrides.
  - Fixture-tested: no flag, flagged pc, flagged tv, and no VUI. Each one decodes bit-identically after the rewrite.
  - Verified live afterwards: pure black dropped to 0.02%. H.265 isn't handled.
- **App clock on 360° views.** The camera's own timestamp sits in a corner of the fisheye frame, which no dewarped view samples. `updateClock()` draws PC time minus the buffer lag, bottom right.
  - It shows only while the stream is live and a new frame arrived within 1.5 s: a ticking clock over a frozen picture would claim it's live, and the library reports a stall only after 5 s. A camera below about 1 fps would make it flicker.
  - It hides when it would take more than 45% of the window width (below the label's 50%, so the two never overlap).
  - It's PC time, not NVR time.
- **Apply to all.** There are two entry points:
  - Right-click → Apply to all cameras copies this window's current value for quality, always on top, show name, show time and color range (one at a time or all of them) to every camera on every console.
  - The camera list's per-console "Quality for all…" does the same for quality only.
  - `allCameraKeys()` includes cameras that have never been opened. They get a window entry with `open: false`, so they open with the setting later.
  - Applying High with more than 6 windows on screen asks first.
- **Arrange** (`arrangeWindows()`, grid.js).
  - Which screen: from the camera list, the list's screen; from the tray, the screen under the mouse.
  - Which windows: the on-screen windows on that screen. If none are there, every on-screen window.
  - Order: reading order by **top edge**, then x. Centers were wrong: after a 1+5, a small top-right tile's center is higher than the big tile's, so the big tile stopped being first.
  - Sizing: each window is fitted to its own aspect (`cw.aspect`, default 16:9) inside its cell, with a 2 px gap. Windows past the last cell stay put, and the call returns `{arranged, left}`.
  - Auto picks the column count that maximizes tile width for that work area, so 16:9, ultrawide and portrait screens get different grids.
- **Layout editor** (manager.js `ed` model, main `saveEditorLayout()`).
  - The renderer only sends ids and choices; main validates them (console ids, template, view mode) and computes bounds with grid.js on the chosen display.
  - Each camera goes in one cell. Quality is picked by tile size when `arrangeQuality` is on.
  - 360° cells set `dewarp.mode`. "single" is quad with `focus ≥ 0`.
  - Drag data types are `text/x-protect-panes-camera` (from the palette) and `…-cell` (tile to tile, which swaps). The tests dispatch synthetic `DragEvent("drop")` with a constructed `DataTransfer`; Chromium lets `getData` read it.
  - `screens[]` in `mgr:state` lists each display with its on-screen windows in reading order, for "Use what's on screen". Its labels snap odd physical widths to even, because Electron rounds DIPs (3440 px at 150% shows as 3441).
- **Camera list CSP:** `style-src 'self'` blocks `style=""` attributes, so positioning goes through CSSOM: `el(…, {style: {...}})` uses `Object.assign(node.style)`. A `setAttribute("style")` silently does nothing, which is how the Arrange thumbnails first rendered blank.
- **Hover tips:** any element with `data-tip` (or `el(…, {tip})`) gets the floating `#tip`, a `popover="manual"` like the preview so it can sit above the layout editor's modal dialog (as a fixed div no tip ever showed in the editor). It is measured from 0,0 each time. It shows after 400 ms, also on keyboard focus, and re-attaches if a re-render replaced the element. Don't add `title` as well, or you get two tooltips.
- **Camera list re-renders patch, they don't replace.** The render functions still build a fresh tree from `state`. `patchChildren()` / `patch()` (manager.js) then fit it onto what's on screen: it keeps elements, syncs their attributes, text and the properties attributes don't hold (`checked`, `value`, `selected`, `open`), and hands them the new tree's handlers. Elements are matched by `data-key` (console cards, camera rows, layout and grid rows, Arrange buttons), otherwise by tag in order.
  - `el()`'s `on…` handlers live in a table on the node (`listen()` / `dispatch()`), so a kept node runs the newest closure, never one holding old state.
  - Before 1.4.3 every poll and change replaced the console cards outright. That lost a click whose mousedown landed on the old node, cleared text selections, moved keyboard focus to the body (only some controls had a `data-focus-key`), closed an open dropdown on any `mgr:changed`, and swapped every thumbnail `<img>`.
  - The 3 s poll and `mgr:changed` skip rendering when `mgr:state` is identical to last time; refreshes after a click always render, so a control whose action changed nothing snaps back.
  - A refresh asked for while one runs doesn't get its own `mgr:state`: main answers in order and reads the state as it answers, so the running one's state already comes after anything that caller saw finish. A click's refresh still sets `renderAnyway` on the running one. Until 1.4.6 it was dropped, and a toggle clicked during a poll could stay as clicked. (A second review guessed the list could show stale state for 3 s; the ordering rules that out.)
  - Measured with 50 mock cameras: about 7 ms per render either way (building the tree is the cost), and an idle poll now renders nothing. The list suite checks a row, its thumbnail, a text selection and focus on a keyless button all survive a re-render.
- **Layouts.**
  - Save current layout snapshots the on-screen windows (not hidden). It takes live bounds from the window unless it's minimized or maximized, then copies `LAYOUT_FIELDS` from the entry.
  - `applyLayout()` closes every open window not in the layout, writes the saved fields over each entry, moves or restarts existing windows, and calls `openCameraWindow`, which creates the window or un-hides it.
  - Layouts are switchable from the tray (Layouts submenu) and the camera list.
  - Cameras of a console that's gone come out of everything at startup and on Remove console (`pruneCameras()`): window entries, grid tiles and their cycles, and each layout's windows and editor cells (and their cycles). Until 1.4.6 layouts kept them: applying skipped them, but the Layouts tab counted them and an export carried them. The layouts suite's second run checks both paths.
- **Protect liveview import.**
  - `ConsoleConnection.liveviews()` maps `client.liveviews` to `{id, name, slots: [{cameras: [cameraId], seconds}]}`. `seconds` is Protect's `cycleInterval`.
  - `cycleMode` isn't read. The library types it as a plain string, and the fake console's "time" is the only value seen. So every slot with several cameras cycles on time, and a mode that switches on motion (if Protect has one) isn't reproduced. Unverified on a real console: the mode values, and that `cycleInterval` is in seconds.
  - `liveviewDraft()` makes a layout editor draft and saves nothing.
    - The template is the one with as many tiles as the liveview has slots, or the next bigger one. Protect's liveview layouts and the editor's templates are the same set (1, 2x2, 1+5 … 5x5), so a 6-slot liveview opens as 1 + 5.
    - A camera is the first camera of one tile only: a slot whose first camera is already placed starts with its next one. It can still come round in other tiles' cycles.
    - A slot with more cameras becomes a cell with `cycle: {keys: [the others], seconds}`. The editor shows "↻ cycles N cameras". Separate windows ignore the cycle and show the first camera.
    - Slots past the biggest template's last tile are counted (`left`), and the editor says how many came out.
  - The editor opens it as new, set to one grid window, with "Open as" still changeable. Saving goes through the editor's normal path. So separate windows get the editor's tile rects and quality from tile size, not the old even grid at each window's current quality.
  - Unverified: that Protect's slot order for an uneven layout (1 + 5, 2 + 8, 1 + 12) matches the editor's cell order (big tiles first, then reading order). Only 2x2 liveviews have been checked against the library, using the fake console's. Check an uneven liveview on a real console.
  - The fake console serves one 2x2 liveview, including an empty slot and a cycling slot. The mock serves whatever `mockLiveviews` lists (a slot can be an array of camera indexes; `seconds` per liveview).
- **UniFi Access cameras (bare-livestream.js).** A UA G3 Pro door reader (`isAdoptedByAccessApp`) stayed black. Found on the owner's site, 2026-10-28, by logging the raw socket:
  - Its livestream socket sends `codec`, `init`, one `begin`, then only `video` frames: one H.264 access unit each (4-byte NAL lengths), ~30 a second. There's no `moof`/`mdat`/`end`, no timestamps (`extendedVideoMetadata` changes nothing) and no audio, though the init declares an AAC track and the codec string says `mp4a.40.2`.
  - The library emits a media segment only on `end`, so it buffered forever and stayed `connecting` until its 30 s establishing deadline, then retried. Protect *does* send the video: 1.5 MB in 10 s.
  - Without `allowPartialGOP` and `progressive` the reader sends nothing after the init, at any `fragmentDurationMillis`. So `livestreamParams()` copies the library's request exactly.
  - `CameraStream` uses `conn.bareLivestream()` for these cameras. It negotiates the socket URL through the library's `client.transport` (public API), as the library's own sessions do, and opens it with undici and its own agent (certificate checks off; cert-pins.js still checks the pin).
  - Each access unit becomes one moof+mdat (`fragment()`). The init loses its audio trak and trex (`videoOnlyInit()`), because the page's player waits for audio it's told about. The codec string loses `mp4a`.
  - Timing: each frame lasts the channel's nominal frame time plus a quarter of the drift from the wall clock, clamped to 0.5-2x. Frames arrive in bursts (a keyframe spans messages), so arrival times alone would be jerky. The timeline is contiguous, so there are no gaps to stall on.
  - A stream that sends moof/mdat/end within its first 15 video frames is treated as framed: segments are assembled like the library's, with the init left alone. No Access camera has been seen doing this; it's there so one that streams normally still plays.
  - A socket the console closes, or 10 s with no frames, ends the stream with an error, so `CameraStream` waits 3 s before retrying instead of reconnecting in a tight loop.
  - No pooling: the same reader in a window and a grid tile is two sockets.
  - The fake console's `FAKE_ACCESS=1` adds a door reader (cam4) that streams this way (e2e, on Garage). `test/connection-unit.mjs` feeds ffmpeg's real fMP4 through a fake socket and checks the decode, the timeline and the framed fallback.
  - Only a UA G3 Pro has been seen. Other Access devices with cameras (intercoms, G3 Reader Pro) are untested.
- **Settings export / import (main.js `exportSettings` / `importSettings`).**
  - The file is `{format: "protect-panes-settings", formatVersion: 1, appVersion, exportedAt, consoles, windows, layouts, grids, settings}`.
  - Consoles go without `password`, which is DPAPI-encrypted for this Windows account and unreadable anywhere else. `launchAtLogin` and `updateSource` stay as each PC has them, both ways (`THIS_PC_SETTINGS`).
  - `updateSource` is per PC because a file could otherwise aim update checks at `\\some-host\share`. The app opens that at every start, and Windows sends the host the user's network credentials; the signature check doesn't help there.
  - The other settings are imported only if this version knows them and the value has the default's type. Anything else takes its default, so `lockLayout: "false"` (text) doesn't read as on.
  - Import replaces everything through `store.replace()`, the same checks as loading config.json. It keeps the old file as `config.json.before-import`, then `app.relaunch()` + `app.exit(0)`, so windows, grids, connections and the tray come up as at any start. `exit`, not `quit`: quit handlers would write the old windows' state over the new settings.
  - A saved password stays only with a console of the **same address and username** (`consoleKey` + username). Matching on id alone would let an edited file send it to another host.
  - This PC's pin for an address wins over the file's.
  - Imported addresses are cleaned up the way Add console does it (`normalizeHost`), so `https://10.0.0.5/` is `10.0.0.5`, both for the login and for matching passwords and pins.
  - Only one console per id is kept (store.js `#oneConsolePerId`, which config.json loading uses too), and the one left out is logged. A second console with the same id started a connection of its own, and the first kept running unseen.
  - A console left with no password says "No password saved…" and doesn't log in (ConsoleConnection). It used to try an empty password and retry for good.
  - Tests can't click file dialogs: in a self-test run `PANES_TEST_FILE` is the file, and an import goes ahead without asking and doesn't relaunch. `npm run test:transfer` covers it.
- **Cycling grid tiles (grid-window.js).**
  - A tile with `cycle: {seconds, then: [{key, ...tile settings}]}` shows its own camera, then each of `then`, every `seconds` (clamped to 3-3600). `tileMembers(tile)` is `[tile, ...then]`; anything that looks for a camera in a grid (lens sharing, "in grid X", Put a camera here, removing a console) goes through it.
  - Each member is a settings record of its own, and the player's `cw.tile` is the member it shows. So quality, picture and the 360° view are per camera, and a menu change while Dock is showing changes Dock's.
  - A switch makes a new WebContentsView and closes the old one rather than reloading the page. A reload kept the webContents id, so a message the old page sent late (an auto-detected circle, an aspect) would be taken for the new camera's. Since 1.4.7 the new page loads under the old one, which stays on screen until the next camera's first frame (Grid windows: Make-before-break). Until then each switch showed a black tile with "Connecting…" while the stream started.
  - The new player takes over the old one's `autoChannel` (`makePlayer({like})`), so it starts on the tile's size-based quality instead of Medium and a restart.
  - A tile nobody can see (grid hidden or minimized, behind an enlarged tile) doesn't switch. The timer keeps ticking and skips.
  - The editor keeps a cell's cycle when the camera is dragged to another tile. Dropping a camera onto a cycling tile replaces the cycle. Edit grid… gets cycles back from `mgr:state` (`editor.cells[i].cycle`), and saving keeps each member's record (matched by key).
  - `store.js` `loadTile()` drops a cycle with no valid members.
  - `npm run test:cycle` covers it.
- **In-place updates (updater.js).** The updater doesn't check Authenticode (releases are signed since 1.4.8), so the Ed25519 signature on `latest.json` is the only gate before downloaded code runs. Keep these steps in this order:
  1. Verify the manifest signature against `UPDATE_PUBLIC_KEY`.
  2. Validate the payload: `app`, an x.y.z version, sha256, size, and a bare `.zip` file name.
  3. Require a newer version (no downgrades).
  4. Download to `.part` while hashing, then check size and sha256 against the signed values. On any failure, close the file, then delete it.

  Checking: at startup, then every 24 h (since 1.4.6; a wall PC used to hear of a release only at its next start). Both only say there's an update (`check({ download: false })`); downloading waits for a click. The timer skips "downloading" and "ready": a check resets "ready", and the download would start over. `PANES_UPDATE_CHECK_MS` shortens the timer in self-test runs only; the update suite's real-key run counts the checks in its log.

  Installing:
  - Only the packaged app installs (`app.isPackaged`).
  - `PANES_UPDATE_PUBKEY_FILE` swaps the key for tests, and only from source.
  - Downloads stage in `%LOCALAPPDATA%\Protect Panes\updates`, not the roaming profile.
  - The helper (`HELPER_PS1`):
    - waits for the app's PID to exit;
    - extracts to `<install>.new-<ts>` (same volume, so the swap is a rename);
    - requires `ProtectPanes.exe` in it;
    - renames the old folder to `.old-<ts>` (10 tries for in-use files), moves the new one in, and rolls back on failure;
    - relaunches whichever version ended up in place;
    - logs to `apply-update.log` and ends with "update: done".
  - **The after-update note (ROADMAP #14).** The relaunch has no arguments, so `installUpdate()` leaves `after-update.json` in the updates folder after `install()` returns: the version being installed and whether camera or grid windows were on screen. The next start reads it once and deletes it (`takeAfterUpdateNote()`), and ignores it after 10 minutes.
    - The version matches and cameras were on screen: windows open with `raise` (`showInactive()` + `moveTop()`, no focus), and the camera list is created minimized.
    - The version doesn't match: the update didn't install. The list shows as usual, and its Updates line says so (`failedUpdate`).
    - Before this, the list's `show()` put it over the cameras after every update.

  Launching the helper (measured): a `detached` powershell.exe never runs, because it gets no console. A non-detached one dies with the app (libuv's kill-on-close job). So it goes `cmd /c start /min powershell -EncodedCommand <base64>`. The only path on cmd's line is PowerShell's own under `SystemRoot`, because `&` and `%` are legal in user and folder names. The test installs into `Tools & 100% O'Brien\` on purpose. It also starts with `cwd` set to the updates folder. Launched from Explorer or a shortcut, the app's working folder is the install folder, and Windows refuses to rename a folder that is any process's working folder. 1.2.0 and 1.3.0 passed that working folder down to the helper, so their own helper blocked the swap. That's why the test runs `install()` from inside the install folder.

  Since 1.4.5 cmd.exe and powershell.exe are started by their System32 paths. cmd's search, which `start` uses, looks in the working folder before PATH, so a `powershell.exe` in the updates folder ran instead of the real one (measured with a planted stand-in). Only this user can write there, so it was defense in depth, but it's the one place the app runs a program on purpose. `NoDefaultCurrentDirectoryInExePath` turns that search off. **Claude Code's shells set it (process-level only; it isn't in the user's or the machine's environment), so a cwd-search experiment run from them shows nothing.** The update suite clears it and plants node.exe as `powershell.exe` in the updates folder for the first swap.

  The install folder's parent must be writable; Program Files isn't.

  **Install kinds** (`installKind()` in main.js). A Scoop copy is a third kind that never installs an update itself (Releasing: Scoop copies don't update themselves). The other two:
  - **Installer installs:** ProtectPanes-Setup.exe is a per-user NSIS oneClick installer to `%LOCALAPPDATA%\Programs\protect-panes`, with an `Uninstall ProtectPanes.exe` beside the app. Both names were measured by the CI install job: electron-builder names the folder after the package name and the uninstaller after the exe. Its uninstall registry entry has no `InstallLocation`. These update by downloading `installer` from the manifest and running it as `/S --updated`, the same flags electron-updater uses. Swapping in the zip there would delete the uninstaller.
  - **Folder installs:** unzipped copies, and every 1.2.x, update by folder swap from the zip. `latest.json` keeps the zip fields at the top level so 1.2.x clients keep working; `installer` is an extra field they ignore.
  - The fake-installer test is a copy of node.exe preloading a script via `NODE_OPTIONS` (forward slashes: a backslash is an escape inside its quotes).
  - The real installer is exercised only in CI. Running it here would add shortcuts and an uninstall entry to the dev PC.

  Build retries: packager's final rename of its temp folder into `dist\` sometimes fails with EPERM right after the files are written. It happened twice here, and electron-builder hit the same on its cache, most likely antivirus scanning fresh executables. `build-win.js` retries it.
- **Hidden vs closed vs minimized.**
  - Hide cameras (tray, list header) and Hide all (per console) apply to the windows on screen; minimized ones are skipped. Each window gets `win.hide()` plus `CameraStream.pause()`, so its renderer stays alive and Show only waits for a keyframe.
  - At launch, hidden windows aren't created at all. Show cameras creates them.
  - Any explicit open (switch, Find, Show all, Show cameras) clears `hidden`. Bring to front and Reset window positions leave hidden windows hidden.
  - If nothing is on screen at launch, the camera list opens even with Start hidden on.
- **Crashed camera pages** are reloaded (`reloadOnCrash()`, windows and tiles): on `render-process-gone` the stream stops and the page reloads after 1 s, doubling up to 60 s while it keeps crashing within a minute. The reloaded page's `cam:ready` restarts the stream, or leaves it paused. `clean-exit` and pages no longer in `senders` (closed on purpose) are left alone. Before this a crashed page stayed black for good while its stream kept pulling video. `unresponsive` and GPU `child-process-gone` are logged.
- **Players** (main.js): a player is one camera page and its stream, `{key, consoleId, cameraId, win, wc, stream, aspect}`. It's either a camera window (`camWins`) or a grid tile, which also has `{gw, tile, index, autoChannel}`. Per-camera functions find settings through `entryOf(cw)`: the tile for a tile, `store.data.windows[key]` for a window. Send to the page with `cw.wc`, never `cw.win.webContents`; a tile's `win` is its grid window. Window-only things (aspect lock, bounds, Close this camera, Always on top) check `cw.gw` first.
- **Grid windows** (grid-window.js).
  - One framed BrowserWindow, plus a `WebContentsView` per tile loading `camera.html?tile=1`. Tile mode only hides the hover bar; everything else in the camera page works unchanged. The frame is the native one, so move, resize, maximize and full screen come for free.
  - A view's webContents isn't closed with its window: `#drop()` closes it, or its renderer lingers.
  - `sync()` matches views to `grid.tiles` by tile object identity, so a layout switch or a new camera keeps the other tiles' pages and streams. Anything that rebuilds `tiles` must reuse the existing tile objects: `saveEditorGrid()` once copied them (`{ ...kept }`), so every editor save of an open grid closed and reopened all its pages and streams. It now mutates the kept tile and refreshes each player's meta (a changed 360° view). The grid suite checks JS markers survive both a layout switch and an editor save.
  - Tile quality: `tileQuality()` sets `autoChannel` from the tile's physical width (debounced 600 ms after a resize, so a drag doesn't restart streams). A tile `channel` set from its menu overrides it. A tile that's playing changes quality make-before-break (`restream()`, below).
  - **Make-before-break** (`#replace()` / `#swap()`, since 1.4.7; review B2/P3). A cycle step and a playing tile's quality change (its size, so Enlarge and resizes; its Quality menu, `setTileChannel`) load a new page under the tile's, in the same rect. The old page keeps playing.
    - The new page takes over (`ready()`) at its first frame: `cam:shown`, which the page sends from `requestVideoFrameCallback` after each init. It also takes over when its stream reports offline or error, so the tile says so instead of showing the camera before, and after `SWAP_MAX_MS` (10 s, logged at info) whatever it has.
    - A view another view covers completely gets no frames at all (measured: with `backgroundThrottling: false` its first frame still came only when it was uncovered). So while a page loads under it, the one on screen is one pixel narrower (`uncover()`). That column shows the new page: black until its video starts.
    - Hide, minimize, and an Enlarge that hides the tile let a page on its way in take over first (`#settle()`), then pause. A newer change replaces one still loading; a cycle tick waits for it.
    - `players` (and the harness's `grid:` tiles) are the pages on screen; `upcoming(index)` is the one loading. Both are in `senders`, so either one's IPC works.
    - The cost: a renderer process per switch, and two streams for the second or two it takes.
    - Camera windows still restart in place: Arrange's quality and a window's Quality menu tear the stream down and wait for a keyframe. Since 1.4.10 the page holds the last frame meanwhile (How video flows, the held frame), so the picture freezes for that second instead of going blank. It isn't the old stream still playing: that would need two streams per window.
    - The cycle suite probes the tile's on-screen page every 150 ms through a cycle step, a Quality menu change and an Enlarge. Each must never show a page without a frame, or one that rebuilt its decoder on screen. All three fail on 1.4.6.
  - The Layout submenu (`setGridTemplate()`) keeps the placed cameras in order and closes up the gaps, so a smaller layout drops the ones past its last tile, with their tile settings, and saves at once. Since 1.4.5 it asks first, naming them (and noting a tile's cycle); before, a 3 × 3 switched to 2 × 2 lost five cameras without a word. A bigger layout doesn't ask. The layout editor drops them the same way, but only says so: nothing is saved until Save.
  - `page-title-updated` is prevented, or the page's `<title>` renames the window.
  - Hide / Show cameras (global only) hide grids too; per-console Hide all doesn't, since a grid mixes consoles.
  - The base page (`grid-window.*`) draws empty tiles and sends `grid:context-menu` with the tile index. An empty tile's menu offers "Put a camera here".
  - **Enlarge a tile:** double-click (the page sends `cam:enlarge` in tile mode, unless a 360° Quad view took the double-click for its own focus and called `preventDefault`) or the tile menu's Enlarge this tile / Show all tiles. `GridWindow.enlarge(index)` gives that tile the whole content area and hides the other views (`setVisible(false)`, zero rects) with their streams paused. `tileQuality` skips zero rects, so they keep their quality for coming back. Show, restore and `sync()` resume only the tiles shown. Not saved: a grid reopens as a grid. The grid suite's fourth run enlarges from the menu and by double-click.
- **Hide from list** (`windows[key].listHidden`): the camera moves to the collapsed section at the bottom of its console, `openAllCameras()` and the editor palette skip it, and its window closes. A hidden window's status in the list reads "window hidden" so the two kinds of hiding don't read the same.
- **Camera previews** (previews.js): `Camera.snapshot({ width: 480 })`, the library's GET `/proxy/protect/api/cameras/<id>/snapshot?w=`, the read-only endpoint the web UI uses.
  - Kept 30 s per camera, failures too, so an offline or refusing camera isn't asked again on every re-render. At most 3 requests at a time. Offline cameras are never asked. Only a JPEG (FF D8) up to 2 MB becomes a preview; a console answering with hundreds of MB used to be base64'd into both processes.
  - The list asks only for rows on screen (IntersectionObserver) while visible, and refreshes after 60 s; hovering asks for one under 15 s old.
  - Offline rows are never asked, and a "no picture" answer is retried after 10 s. Before a console connects, its saved cameras show as placeholder (offline) rows. Asking for those and keeping the miss for 60 s left 7 of 9 rows empty on the real consoles, though Protect answers snapshots in 67-300 ms there. The list suite reproduces it with `cfg.mockConnectMs`.
  - The hover picture is a `popover="manual"`: a plain fixed div can't sit above a modal `<dialog>` (top layer). Opening a modal makes Chromium send its own `pointerover` for what's now under the real cursor, which clears the hover; tests wait 300 ms after opening the editor before hovering.
- **Adjust picture** is a CSS `filter: brightness() contrast()` on `<video>` and the dewarp canvas; `capturePage` includes it, which is how the range suite measures it. While the panel is open, `cam:meta` doesn't overwrite the sliders.
- **safeStorage is async** (store.js). On Windows the sync and async APIs share the DPAPI-wrapped key in `Local State` and the "v10" format, so each reads what the other wrote (checked on the owner's real config, and in e2e via `test/legacy-password.cjs`). Chromium writes a newly created key to `Local State` only on a normal shutdown or ~10 s later: a script that encrypts and then calls `app.exit()` loses the key, and with it the password. Use `app.quit()`.
- **Small updates.** A release also carries `ProtectPanes-app.asar.gz`; `latest.json`'s signed `asar` entry has its `electron` version and the unpacked size/SHA-256. A copy on that same Electron, installed or portable, downloads only that; the helper's `-AsarGz` mode gunzips next to `resources\app.asar`, checks the unpacked hash, swaps the one file and rolls back on failure.
  - It's `.gz`, not `.asar`, so Electron's patched `fs` never treats the download as an archive.
  - The helper hashes with `[Security.Cryptography.SHA256]`, not `Get-FileHash`. Started from PowerShell 7 (GitHub's runners, or a user's pwsh window), Windows PowerShell inherits pwsh's `PSModulePath` and `Get-FileHash` isn't found. That failed the first v1.4.0 release run, and it can't be reproduced on a PC without pwsh. Keep the helper off cmdlets that come from modules where a .NET call does the job. Expand-Archive and Move-Item worked in that same run.
  - Everything the app is lives in app.asar (no native modules, nothing unpacked). A new Electron needs nothing: the manifest's `asar.electron` is the new version, so copies on the old one take the full update.
  - **A release that changes anything else in the folder** (packager or builder options, the icon, the exe's metadata, the fuses) **needs a `release-notes/vX.Y.Z.full-update` file** (any content; a line saying why).
    - With it, `build-win.js` makes no .gz and deletes an old one, so `latest.json` has no `asar` entry and every copy takes the full update.
    - `sign-release.js` refuses to sign if a .gz turns up anyway.
    - The release workflow publishes only the files there are.
    - Before 1.4.4 the .gz was always built, signed and published, so the rule ("delete it before signing") couldn't be followed through CI.
    - Checked with a local build carrying the marker: no .gz, a manifest without `asar` that verifies, the upload list without it, and signing refused once a .gz was put back.
  - An installed copy's Settings → Apps version stays at what Setup.exe last wrote until the next full update.
- **Electron fuses (build-win.js, since 1.4.5).** Right after packaging, before the zip and Setup.exe are made from the folder, `flipFuses()` (`@electron/fuses`, pinned) turns off `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`, and turns on `OnlyLoadAppFromAsar`.
  - What it stops: the shipped exe working as node.exe (`ELECTRON_RUN_AS_NODE`), honoring `NODE_OPTIONS`, opening a debugger on `--inspect`, and loading a `resources\app` folder when app.asar is missing. It doesn't protect the passwords from malware running as the same user.
  - Not `EnableEmbeddedAsarIntegrityValidation`: a small update swaps app.asar under an unchanged exe, the embedded hash would no longer match, and the app wouldn't start.
  - Only the packaged exe is changed. `node_modules/electron/dist/electron.exe` keeps Electron's defaults, which the tests rely on (`ELECTRON_RUN_AS_NODE` for the unit checks). The fake installer in the update suite is a copy of node.exe, so its `NODE_OPTIONS` still works.
  - Checked on the 1.4.5 build against a copy set back to the defaults. On the defaults copy, each of the four worked; on the fused build, none did (the `NODE_OPTIONS` fuse checked on its own, with run-as-node left on). Even with the defaults, a `resources\app` folder loads only when app.asar is gone, so that fuse buys little: whoever can delete app.asar can replace it. check-packaged passes, and Setup.exe and the zip carry the same exe as the folder.
  - Don't test the no-app.asar case with the fuse on: Electron throws "Unable to find a valid app" and shows a main-process error dialog on the screen.
- **Start with Windows and Defender.** Microsoft Defender raised "Anomaly detected in ASEP registry" (Medium) on the owner's PC in 1.4.0.
  - The cause: `applyLoginItem()` called `setLoginItemSettings` on every launch. With the setting off, Electron deletes the `protect-panes` value (the AppUserModelId) under `HKCU\…\CurrentVersion\Run` and `…\Explorer\StartupApproved\Run`. A test suite launches the app dozens of times.
  - Now it reads `getLoginItemSettings()` and writes only when that differs from the setting (`syncLoginItem()`, util.js).
  - Test and scratch-config runs (`PANES_SELFTEST_DIR` / `PANES_USER_DATA`) never touch the real startup entries. A test config with `launchAtLogin: true` used to write `electron.exe` into Run.
  - Still in the alert: the update helper's hidden, `-EncodedCommand`, `-ExecutionPolicy Bypass` PowerShell, once per update. That's deliberate (see In-place updates). Since 1.4.8 the exe that starts it is code-signed, which should make both look less suspicious; not checked against Defender.
- **Windows never steal focus.** Use `showInactive()`, never `show()`/`focus()` for camera windows: exacqVision is in use on the same screen.
  - The catch, reported by the owner in 1.4.0: a camera or grid window opened from the camera list appears above it, while the list stays the active window underneath. On Windows, clicking a window that's already active doesn't raise it, so the list stayed covered until you clicked elsewhere and back. The list now sends `mgr:raise` (→ `managerWin.moveTop()`) on every pointerdown.
  - The list suite checks the real z-order with Win32 `GetWindow(GW_HWNDPREV)` through PowerShell (`sampleZOrder()`); Electron exposes no z-order. Without the fix the check fails.
- **Moving vs aiming.** The window drag region is only the hover bar (`-webkit-app-region: drag`). The picture itself takes right-click (context menu) and, in 360° views, drag/scroll for PTZ. Lock layout disables both window moves and PTZ.
  - The aim goes to main when the mouse is let go, and 400 ms after the last wheel step (`aimPending` until then). Every `cam:meta` calls `Dewarper.setConfig()` with the saved copy, so while a drag runs or an aim is pending it keeps the page's `views` and `pano` (same mode and mount only). Until 1.4.6 a refresh mid-drag (a connection event, a Settings toggle, a lens change in another copy) snapped the view back, and one in the 400 ms after a drag lost the whole drag. The mock suite's second run checks both.
- `src/mock.js` and `src/selftest.js` ship inside the build but do nothing unless `--mock` or `PANES_SELFTEST_DIR` is set.
- ffmpeg for mock/tests comes from `FFMPEG_PATH`, then the `ffmpeg-static` dev dependency, then PATH.

## Testing against the real consoles

The owner's PC has the real config. To try a change live:

1. Quit the installed app (tray → Quit).
2. Run `PANES_DEVTOOLS=1 npm start`.
3. Check `%APPDATA%\Protect Panes\protect-panes.log` for connection errors.

To experiment without disturbing the saved layout, copy `config.json` **and `Local State`** into a scratch folder and run with `PANES_USER_DATA` pointing at it. `safeStorage` encrypts with an AES key stored in `Local State` (`os_crypt.encrypted_key`, itself DPAPI-wrapped), so with `config.json` alone every console fails to decrypt its password (since 1.4.3 the console says "The saved password can't be read on this PC any more. Enter it again" and isn't retried; the log has safeStorage's own error). With both files the passwords decrypt for the same Windows user. Adding `PANES_SELFTEST_DIR` to that run gives `result.json` plus screenshots of the real cameras, then the app exits.

When adding a test, extend `test/run.mjs`. `PANES_SELFTEST_ACTIONS` (JSON) drives windows with real input:

- `drag` `{win, from, to}`
- `wheel` `{win, pos, dy}`. Electron's wheel `dy` sign is inverted relative to DOM `deltaY`.
- `dblclick` `{win, pos}`
- `menu` `{win}`: returns the context-menu labels
- `dewarp` `{win, changes}`
- `command` `{win, cmd}`
- `key` `{win, key}`
- `resize` `{win, size: [w, h]}`
- `menu-click` `{win, label}`: runs that context-menu item's click handler (searches submenus too)
- `camera-js` `{win, js}`: runs JS in a camera page and stores the result as `value`
- `crash` `{win}`: `forcefullyCrashRenderer()` on that camera page
- `move` `{win, to: [x, y]}`: `setPosition` on the window (a tile's moves its grid window)
- `screen-event` `{event}`: emits `display-removed` / `display-added` / `display-metrics-changed` on `screen` (no `win`)
- `tray-click` `{label}`: same, for the tray menu (no `win`)
- `manager-js` `{js}`: runs JS in the camera list window and stores the result as `value` (no `win`). The list must be open (`startHidden: false`).
- `grid-menu-click` `{grid, index, label}`: a grid window's own menu (an empty tile's, with `index`)

Any camera action takes `tile: "<grid name>#<index>"` instead of `win` to drive a grid tile. Tiles appear in samples as `grid:<grid name>#<index>`, with the view's `bounds` and the grid window's `visible`.

`PANES_SELFTEST_DUMP_SEC=n` saves the first n seconds of each window's stream as `<cameraId>.mp4` in the results folder. That's how the color-range finding was measured (`ffmpeg -i` for flags, `signalstats` for levels). Against real consoles it records real video, so delete the dumps afterwards.

Action results carry `t` (epoch ms), so a check can compare against the samples taken before an action. Each sample row also has main-process `visible` and `bounds` per window.

Message boxes never show in self-test runs: a test can't click one, and it would land on the screen of whoever is using the PC. `answerDialogs()` (selftest.js) replaces `dialog.showMessageBox`. Each question goes into result.json as `dialogs: [{t, message, detail, buttons, response}]`, and the answer is the next button index in `PANES_SELFTEST_ANSWERS` (a JSON list), else the dialog's `cancelId`. The settings import's question is skipped in tests anyway (`PANES_TEST_FILE`).

`win` is the index in window-open order. That's config order.

## Releasing

Releases are built and published by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed:
1. Bump `version` in package.json (and the lockfile: `npm install --package-lock-only --ignore-scripts`).
2. Write `release-notes/vX.Y.Z.md`, the release text. Without it the workflow falls back to GitHub's generated notes. Its Files list names `SHA256SUMS.txt` too. If the release changes anything outside app.asar but not Electron (the icon, packager or builder options), also add `release-notes/vX.Y.Z.full-update` (see Small updates).
3. `npm test`, commit, push `main`.
4. `git tag -a vX.Y.Z -m "Protect Panes X.Y.Z"` and `git push origin vX.Y.Z`.

A tag `vX.Y.Z-signtest.N` (X.Y.Z still package.json's version) runs every job except publish: for trying a change to signing without a release. Run one after any electron-builder upgrade, before releasing on it: the uninstaller swap relies on electron-builder making a byte-identical uninstaller every run and naming it `*__uninstaller.exe`. Delete the tag afterwards (`git push origin :refs/tags/<tag>`, `git tag -d <tag>`).

There are two signatures, and neither is ever made next to the build's dependencies (`npm ci`: the packager, electron-builder and everything they pull in):
- **latest.json**, Ed25519, from the `UPDATE_SIGNING_KEY` secret: what installed copies check before an update runs. Until 1.4.3 the key sat in a file while `npm run build:win` ran the packager and electron-builder, and any compromised package could have read it and signed updates for every installed copy.
- **Authenticode** on ProtectPanes.exe, the uninstaller and Setup.exe (since 1.4.8): what Windows shows as the publisher, for SmartScreen and Smart App Control. See Code signing below. Anything running in a job that's signed in to Azure could sign whatever it liked, so the jobs that sign run no npm code, no Node and never the app.

electron-builder makes the uninstaller and packs it into Setup.exe in one run, and Setup.exe must carry the signed exe, so the files go back and forth between six jobs:

**build** (Windows, read-only token, no secrets):
1. Checks the tag matches package.json (or is its `-signtest.N`).
2. Runs `npm ci`, then `npm test`.
3. Runs `npm run build:win`: the zip, Setup.exe and `ProtectPanes-app.asar.gz`, all unsigned. `scripts/installer-sign-hook.js` keeps the uninstaller electron-builder made as `dist/ProtectPanes-uninstaller.exe`.
4. Uploads the zip, that uninstaller and the .gz as the `build` artifact. This Setup.exe isn't used.

**sign-app** (Windows, `release` environment, can sign; runs only pinned actions, Microsoft's ArtifactSigning module and `scripts/authenticode.ps1`):
1. Unzips the app folder, signs ProtectPanes.exe and the uninstaller.
2. Zips the folder again with PowerShell 7's Compress-Archive, as the build did (entries named with `/`, under `Protect Panes-win32-x64`).

**installer** (Windows, read-only token, `npm ci --ignore-scripts`):
1. Unzips the signed app folder into `dist/`.
2. Runs `node scripts/build-win.js --installer --uninstaller <build's> <signed>`: Setup.exe around the signed folder. The hook puts the signed uninstaller in place of the one this run makes, but only if this run made the same file byte for byte, and otherwise stops the build. NSIS makes the same uninstaller every time for the same version and options, whatever the app folder holds: checked 2026-11-10 with three builds of 1.4.7, one with ProtectPanes.exe changed, all the same SHA-256. Checked with a stand-in signed uninstaller (50,000 random bytes added): Setup.exe grew by 50,015 bytes, and a mismatch exits 1 with no Setup.exe.

**sign-setup** (like sign-app): signs Setup.exe.

**verify** (Windows, read-only token, no `npm ci`):
1. The zip has `Protect Panes-win32-x64/ProtectPanes.exe` (Scoop's layout), and Setup.exe and the zip's exe are signed by James Cupps and timestamped (`scripts/check-signatures.ps1`, which also writes each result as an annotation).
2. Runs the packaged app from two install folders (`scripts/check-packaged.mjs`).
3. Installs Setup.exe silently and checks the installed exe's version, its signature and the uninstaller's, and that the installed exe is the zip's, byte for byte. Then uninstalls.
4. Uploads the files it checked as the `release-files` artifact.

**publish** (Ubuntu, `contents: write`, the only job that reads the `UPDATE_SIGNING_KEY` secret; skipped for a signtest):
1. Checks out the tag fresh, with no `npm ci`. Only Node's own modules and the repo's scripts run here.
2. Downloads the release files.
3. Writes the key to a temp file and signs `latest.json` (`scripts/sign-release.js`). The Electron version comes from package-lock.json, and the unpacked app.asar hash from gunzipping the .gz, so no node_modules or build folder is needed.
4. Deletes the key.
5. Runs `scripts/verify-release.mjs`: the signature against the public key built into the app, then each file's size and SHA-256. A wrong secret stops here.
6. Writes `SHA256SUMS.txt` over the files it publishes (Setup.exe, the zip, `ProtectPanes-app.asar.gz` when there is one, and the signed `latest.json`), so a download can be checked by hand too. Nothing reads it: the updater uses `latest.json`, and Scoop hashes what it downloads.
7. Runs `gh release create` with those files and `SHA256SUMS.txt`.

The limit: a compromised dependency can still tamper with what it builds, and both signatures would cover that. It can't take either identity and sign something else. `npm run test:release` checks the workflow keeps these rules (which jobs can sign in to Azure, what runs in them, who reads the key) and tests the uninstaller swap.

**Code signing** (Authenticode, from 1.4.8; earlier releases were unsigned): Azure Artifact Signing, the account and certificate Slate, NoteForge, PingerPlot and UniFi Stock Watcher use (account `SlateAccount`, profile `Slate`, endpoint `https://eus.codesigning.azure.net/`; subject `CN=James Cupps, O=James Cupps, ...`). The app registration "Slate signing" has a federated credential for `repo:jamesccupps@148652101/UnifiCameraViewer@1435835596:environment:release`. This repository's OIDC tokens carry GitHub's newer subject format, with the owner and repository IDs; the owner's older repositories send the classic `repo:jamesccupps/<repo>:...` (checked 2026-11-10 with a throwaway branch printing only the token's `sub`). The `release` environment admits `v*` tags only, and the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` secrets name the app registration. No password or key is stored. Three signatures a release. electron-builder's own `elevate.exe` (in `resources\`) and Electron's DLLs aren't ours and stay as their authors shipped them. Authenticode sits beside the Ed25519 update signature, not instead of it: the updater checks only the latter.

Installed copies find the release through `releases/latest/download/latest.json`.

**Scoop bucket.** `bucket/protectpanes.json` in [jamesccupps/scoop-bucket](https://github.com/jamesccupps/scoop-bucket) updates itself from each GitHub release (checked every 4 hours), so a release needs no Scoop work as long as these hold:
- Tag releases `vX.Y.Z` and publish them as the latest release, not a pre-release. The workflow's `gh release create` does both (no `--prerelease`).
- Keep the release file names, and the folder layout inside the zip, unchanged. The bucket uses `ProtectPanes-win32-x64.zip` with `Protect Panes-win32-x64\ProtectPanes.exe` inside (its `extract_dir` and shortcut). That folder name is packager's (productName + platform + arch), so changing `productName` or `executableName` changes the layout.
- Keep publishing the checksum file alongside: `SHA256SUMS.txt`, from the first release after 1.4.8. The bucket doesn't read it (its autoupdate has no hash source, so Scoop hashes the zip it downloads), and `latest.json`'s signed hashes are for the app's own updater.
- Sign files **before** publishing, and never replace a file on a release that's already out: Scoop and winget have recorded its hash. Fix with a new version. (The publish job already signs `latest.json` before `gh release create`. Moving a tag, as in a failed release run, is only for a release that never published.)
- If a file name or the zip layout must change, update `bucket/protectpanes.json` in jamesccupps/scoop-bucket in the same change.

**Scoop copies don't update themselves (since 1.4.7).** Why, measured 2026-11-10 with the real helper on a scratch copy of Scoop's layout (Scoop's side read from its source, not run):
- Scoop runs the app from `apps\protectpanes\current`, a read-only junction to the version folder, and Electron's `process.execPath` keeps the junction path. So until 1.4.7 the updater took it for a folder install.
- A small update wrote app.asar into Scoop's version folder. That worked; Scoop listed the old version until `scoop update`.
- A full update (a new Electron) swapped the folder. `current` became a real folder without Scoop's `manifest.json`, and the old junction stayed behind as `current.old-<ts>`: the helper's `Remove-Item` can't delete a read-only junction. That leftover shows Scoop's `install.json` through the link, so Scoop lists it as an installed version and may take it for the current one.
- Now `scoopInstall()` (updater.js) recognizes Scoop's files beside the exe (`install.json` + `manifest.json`, or `scoop-install.json` + `scoop-manifest.json`), and `installKind()` returns `"scoop"`. The updater still checks, but a newer version only shows as available, with `scoop update protectpanes` in its message; nothing is downloaded, even from the button. The update suite checks both on a junction layout; both fail on 1.4.6.
- The cost: Scoop copies always download the full zip through Scoop, never the 1.4 MB app.asar.
- 1.4.6 copies installed with Scoop still update themselves. 1.4.7 reaches them as a small update, which works, so release 1.4.7 before the next Electron bump.

The signing key:
- The private key is `%USERPROFILE%\.protect-panes\update-signing-key.pem` on the maintainer's PC, and the same content is in the repo secret `UPDATE_SIGNING_KEY`.
- Never commit it. Back it up: without it, installed copies can't update in place.
- `scripts/make-signing-key.js` refuses to replace an existing key.
- A local `npm run build:win` signs with the file, so a release can still be built by hand if CI is down. Attach the same files, plus a `SHA256SUMS.txt` made the way publish makes it (`sha256sum` over them, run in `dist/`). Such a build has no Authenticode signature.

For a first install, or a copy older than 1.2.0, use the Setup.exe or replace the folder with the zip. Settings in `%APPDATA%` carry over.

Releases before 1.4.8 are unsigned (SmartScreen's "Run anyway" on first launch). From 1.4.8 Windows names James Cupps as the publisher; SmartScreen can still warn about a new download until it has built a reputation.

**Checking that a packaged build really updates itself** (done for 1.2.0, and for 1.4.0's small update; repeat when updater.js or the helper changes).

For the small update, N+1 needn't be a second build. Unpack N's `app.asar` with `@electron/asar`, bump `version` in its package.json, repack and gzip it, and sign it with `signRelease({ zip, asar: { gz, unpacked, electron } })`. Start N from inside its folder (`Start-Process -WorkingDirectory`), as Explorer does. 1.4.0 → 1.4.1 that way:
- the log shows "1.4.1 (asar) downloaded and verified (1329732 bytes)", then "1.4.1 starting";
- `resources\` keeps only `app.asar` (plus electron-builder's `elevate.exe`);
- the exe's file version stays 1.4.0.

For a full update:
1. Build version N+1 and move its zip and `latest.json` to a scratch release folder. Delete that folder afterwards: it's validly signed.
2. Build N and copy `dist/Protect Panes-win32-x64` to a scratch `Tools\Protect Panes`.
3. Run that exe with these settings:
   - env: `PANES_USER_DATA` pointing at a scratch config with `consoles: []`, `updateSource` set to the release folder, and `startHidden: false`;
   - self-test actions: click `#btn-check-update` at ~3 s, and invoke `mgr:install-update` at ~20 s.
4. Expect:
   - the app log: "N starting", "downloaded and verified", "installing update", then "N+1 starting";
   - `apply-update.log` ending "update: done";
   - no `.old` / `.new` folders left beside the install;
   - the relaunched copy finding nothing to install.

Don't use `--mock` for this. The packaged build has no ffmpeg, so mock cameras just fail and retry.

## Project page

`site/index.html` is a hand-written page, modeled on Slate's (jamesccupps/Slate `site/`). `pages.yml` copies `site/` and `assets/icon.png` (as `images/icon.png`) into the Pages artifact and deploys it. The repository's Settings → Pages → Source must be "GitHub Actions". The page fetches the latest version from GitHub's API and links to `releases/latest/download/…`, so a release needs no redeploy. Check its feature cards when a release adds or changes something they describe. `build-win.js` ignores `site/`, so its pictures never reach `app.asar` or the small updates.

The pictures in `site/images/` are from demo mode, never the real cameras (they'd show the sites):
- Self-test runs with `--mock`, `PANES_MOCK_FISHEYE` set to the ceiling fixture, and a scratch config with the windows or grid at the places wanted.
- Just before the capture, a `manager-js` action hides `#mock-badge` and swaps the demo labels in the list's text ("Mock G5" → "G5 Bullet", "(mock)" → a console model).
- The editor shot sets `document.documentElement.style.zoom = 0.8` first, since the list's fixed 860×640 cuts the dialog off.
- The hero, the grid window and the social preview (1280×640) are put together from those captures in an offscreen Electron window, at the captures' own positions.
- A hand-written `dewarp` with only `mode` and `mount` shows a blank panorama: give it the full record (`views`, `pano`, `lensFov`, `focus`), as the app writes it.
- The page itself was checked as full-page offscreen captures at 1280 and 390 px wide, in light and dark.

## Known limitations / not built

Owner-requested features, with findings and open questions, are in `ROADMAP.md`.

- Live view only: no playback, timeline, events, audio or two-way talk.
- PTZ cameras can't be steered; only the 360° virtual PTZ exists.
- One window per camera: the same camera can't have two floating windows (it can be in a window and in grid tiles).
- Tile cycling comes only from Protect liveviews: the editor can't make or change a cycle, only keep or drop one. Cycling is on time only.
- Doorbell package-camera lens isn't exposed (the library supports `source: {type: "lens"}`).
- Desk-mount panorama and lens FOV > 180° are implemented but have only light test coverage.
