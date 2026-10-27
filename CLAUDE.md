# Protect Panes - notes for Claude Code

Windows desktop app (Electron) that shows UniFi Protect **live view only**, one borderless window per camera. Each window can sit anywhere on screen at any size, positions are remembered, and it supports several consoles at once. It runs on a Dell OptiPlex (Intel integrated graphics) next to exacqVision, so camera windows must never steal focus. The owner has two UniFi OS consoles on the same LAN, "Building" and "Garage", and signs in with **local-only** accounts.

Hard requirements, all deliberate:
- **No RTSP/RTSPS.** Video comes from Protect's own livestream websocket (fMP4) via the `unifi-protect` library. The owner keeps RTSPS off.
- **Direct login by IP** with a local account. No ui.com/cloud, no MFA.
- **Low resource use.** Medium channel by default, GPU decode via MSE, minimized windows stop streaming, WebGL only for 360° windows.

Current version: **1.1.0** (adds 360° dewarping). The owner has run 1.0 and 1.1 on the real consoles and confirmed they work.

## Commands

```
npm install
npm start                 # run from source (uses the real config - quit the installed app first, see Gotchas)
npm run mock              # fake consoles with ffmpeg test patterns, no network
npm test                  # all test suites below (~1.5 min, windows flash on screen)
npm run test:mock         # mock cameras: playback, forced reconnect, 360° quad/panorama, real mouse PTZ input, name label
npm run test:hide         # Hide cameras / Show cameras / per-console Hide all, across two launches
npm run test:range        # SPS color-range rewrite (unit, ffmpeg fixtures) + displayed pixel levels in Chromium
npm run test:e2e          # fake UniFi OS consoles over HTTPS/WSS through the real unifi-protect library
npm run build:win         # portable build -> dist/Protect Panes-win32-x64/ + dist/ProtectPanes-win32-x64.zip
```

**Run `npm test` after any change and before building.** It prints PASS/FAIL per check, and keeps screenshots of every window plus `result.json` (per-window playback stats) in the printed results folder. **Look at the screenshots** for anything visual. Tests use their own temp settings folder, so they never touch the real config and can run while the app is open.

`PANES_DEVTOOLS=1 npm start` opens detached DevTools for every window. `PANES_DEBUG=1` adds debug lines to the log.

## Layout

```
src/main.js                 App lifecycle, camera windows, camera list window, tray, context menu, IPC, settings, dewarp settings
src/console-connection.js   One logged-in console (ProtectClient), connect/backoff, state; channelList / resolveChannel / fisheyeInfo
src/camera-stream.js        Pumps one camera's livestream subscription to its window (init/media/status), reconnect handling
src/avc-range.js            Rewrites the H.264 SPS in the init segment to declare full color range (see Gotchas)
src/store.js                config.json load/save (debounced, atomic), DPAPI password encryption via safeStorage
src/log.js, src/util.js     File logger (rolls at 2 MB); sleep/debounce/throttle/normalizeHost
src/preload-camera.cjs      Camera window bridge - IN/OUT channel allowlists
src/preload-manager.cjs     Camera list bridge - invoke allowlist
src/renderer/camera.*       Camera window: MSE playback, live-edge tracking, codec fallback, hover bar, status, notices
src/renderer/dewarp.js      360°: WebGL fisheye dewarp (quad / panorama), PTZ input, circle auto-detect, calibration UI
src/renderer/manager.*      Camera list + settings window (vanilla DOM, no innerHTML with camera/console names)
src/mock.js                 Dev-only fake consoles/cameras (--mock); PANES_MOCK_FISHEYE adds a 360 camera
src/selftest.js             Dev-only harness, active only when PANES_SELFTEST_DIR is set
test/run.mjs                Test runner (mock, hide, range and e2e suites with assertions)
test/fake-console/          Fake UniFi OS console (HTTPS + WSS) and its throwaway self-signed cert
test/fixtures/              Synthetic fisheye frames with known geometry (ceiling circle truth: x .513, y .4938, r .4818)
scripts/build-win.js        @electron/packager build + zip (no Wine needed); ELECTRON_ZIP_DIR to use a pre-downloaded runtime
```

## How video flows

1. `ConsoleConnection` → `ProtectClient.connect({ host, username, password })` (unifi-protect **v5** API).
2. `CameraStream` → `cam.livestream({ source: { type: "channel", channel }, urgency: () => 5000, discardOnDispose: true })`, an async iterable of `Segment`s:
   - `{ type: "init", codec, data }`
   - `{ type: "media", data, discontinuity? }`
3. Main forwards these to the window as `cam:init` `{ codec, data, reset }` and `cam:media` (a `Uint8Array` copy; `seg.data` can be a view into a pooled buffer). `cam:status` carries live / connecting / reconnecting / waiting / offline / paused / error.
4. The renderer appends to a MediaSource `SourceBuffer`:
   - It holds about 0.2-0.7 s behind live: it plays 1.15× faster when behind, and jumps forward past 1.5 s.
   - It trims history older than 12 s.
   - Anything unrecoverable sends `cam:reset`, and main restarts the subscription.
5. On reconnect the library rebases timestamps to zero and flags `discontinuity`. Main then resends init with `reset: true`, and the renderer rebuilds the MediaSource.
6. 360°: `Dewarper` reads `<video>` frames as a WebGL texture (on `requestVideoFrameCallback`) and draws the views. The video element stays rendered *under* the canvas: rVFC doesn't fire for hidden videos.

## IPC

Adding a channel means editing **both** the preload allowlist and `registerIpc()` in main.js. Main identifies camera windows by `event.sender.id`, never by anything the renderer sends.

- **Camera → main:** `cam:ready`, `cam:aspect {width,height}`, `cam:reset`, `cam:context-menu`, `cam:toggle-top`, `cam:close`, `cam:dewarp {views?, pano?, focus?, circle?}`
- **Main → camera:** `cam:init`, `cam:media`, `cam:status`, `cam:meta`, `cam:highlight`, `cam:command {cmd: "calibrate" | "autodetect"}`
- **Camera list (invoke):** `mgr:state`, `mgr:save-console`, `mgr:remove-console`, `mgr:reconnect`, `mgr:open-camera`, `mgr:close-camera`, `mgr:find-camera`, `mgr:set-channel`, `mgr:set-setting`, `mgr:bring-to-front`, `mgr:reset-positions`, `mgr:open-all`, `mgr:hide-cameras consoleId|null`, `mgr:show-cameras consoleId|null`, `mgr:quit`
- **Main → camera list:** `mgr:changed` (throttled). The list also polls every 3 s while visible, for online/offline status.

## Config and logs

`%APPDATA%\Protect Panes\`:

- `config.json`:
  - `consoles[]`: `{id, name, host, username, password: {enc: "safe" | "plain", data}}`
  - `windows["<consoleId>/<cameraId>"]`: `{open, bounds, channel, onTop, name, hideName, hidden, clock, range, dewarp}`. `range` is `"full" | "limited"` (absent = auto). `clock` true/false overrides the default (on in quad/panorama, off otherwise). `hideName` hides one window's label; `settings.showNames` off hides all of them. `hidden` (with `open: true`) means taken off screen by Hide cameras / Hide all.
  - `settings`: `{lockLayout, showNames, lockAspect, hideFromTaskbar, startHidden, launchAtLogin}`
- `protect-panes.log`: connection log. Rolls to `.log.1` at 2 MB.

Passwords are DPAPI-encrypted (`safeStorage`) and tied to the Windows user. `enc: "plain"` is base64 and only exists in tests and on Linux without a keyring. **Never print or log decrypted passwords.**

`dewarp`: `{mode: "off" | "quad" | "panorama", mount: "ceiling" | "wall" | "desk", lensFov, circle: {x, y, r} | null, views: [{pan, tilt, fov} × 4], focus, pano: {pan, tilt}}`
- Angles are degrees. `fov` is vertical FOV. Pan wraps to (-180, 180]; tilt clamps to ±90.
- `circle` is normalized: `x` = center x / video width, `y` = center y / video height, `r` = radius / video height.
- `undefined` means never decided. On first view, `ensureDewarp()` turns on quad for fisheye cameras. `null` means a normal camera.

## Gotchas

- **Single-instance lock is per settings folder.** `npm start` with the default folder just focuses the already-running installed app. Quit it first (tray → Quit), or set `PANES_USER_DATA=<folder>` to run separately.
- **unifi-protect is v5.** Don't follow older examples that use `ProtectApi` / `ProtectLivestream` / `getBootstrap()`; those are v4. Read `node_modules/unifi-protect/dist/*.d.ts`. It needs Node ≥ 22.20 inside Electron; Electron 45 ships Node 24. Version is pinned on purpose. When Protect firmware breaks something, bump the library first, then run `npm test`.
- **Console host must be a bare IP/hostname.** The library rewrites the livestream WS hostname to the configured host, and `host:port` doesn't rewrite. The tests use ports only because they're local fakes.
- **Codec strings from the console aren't guaranteed to be valid RFC 6381.** `pickMime()` falls back to `codecFromInit()`, which parses avcC/hvcC/av1C/mp4a from the init segment. An H.265 camera needs hardware HEVC decode. If that's missing, the window tells the user to switch the camera to H.264.
- **WebGL fallback.** `app.commandLine.appendSwitch("enable-unsafe-swiftshader")` lets Chromium render WebGL on the CPU when there's no usable GPU driver. Without it, current Chromium disables WebGL and 360° silently degrades to raw fisheye. `Dewarper` detects a software renderer and draws at half resolution. The GL context is created lazily, only for windows in a dewarp mode.
- **Fisheye model is equidistant** (r ∝ θ), 180° lens default. Mount → lens frames live in `LENS` in dewarp.js. Pan 0 = top of the fisheye image for ceiling mounts. This was verified with synthetic frames only, not a real AI 360 lens; real lenses may need a lens-profile curve.
- **Circle auto-detect.** It scans 120 rays for the point where the picture goes dark for good, then fits with RANSAC + a Kasa least-squares fit. The test fixture deliberately includes an OSD timestamp and black boxes inside the circle. Keep both passing if you touch it.
- **Name label auto-collapse.** `fitLabel()` in camera.js measures the full label on every resize and title change. When the label is wider than `LABEL_MAX_SHARE` (50%) of the window, only the status dot is shown. Measuring is deliberate, because a fixed breakpoint fits short names or long ones, never both.
- **Aspect lock.** The renderer reports the aspect it wants: the video size normally, 16:9 in dewarp modes. Main calls `setAspectRatio` and snaps the window height. Calibration deliberately doesn't change aspect.
- **Color range (why pictures looked dark).** Measured on the owner's cameras (2026-10-27, Low channel):
  - Every camera sends full-range luma (0-255). The worst garage camera had 4% of picture pixels below 16.
  - Only some flag it: one camera's SPS says `pc, bt709`. Three others have a VUI with no `video_signal_type`.
  - Chromium reads unflagged streams as limited, so everything below 16 went solid black: 6% of one camera's picture in the app, against 0.1% in a PC-range decode.
  - `applyRange()` (avc-range.js) rewrites the avcC SPS in `CameraStream`'s `sendInit` to declare full range.
  - Chromium ignores the range bit unless `colour_description_present_flag` is set, so the rewrite also writes BT.709 when there's no colour description.
  - Streams that already flag a range are left alone. Right-click → Color range (`range`) overrides.
  - Fixture-tested: no flag, flagged pc, flagged tv, and no VUI. Each one decodes bit-identically after the rewrite.
  - Verified live afterwards: pure black dropped to 0.02%. H.265 isn't handled.
- **App clock on 360° views.** The camera's own timestamp sits in a corner of the fisheye frame, which no dewarped view samples. `updateClock()` draws PC time minus the buffer lag, bottom right.
  - It shows only while the stream is live: a ticking clock over a frozen picture would claim it's live.
  - It hides when it would take more than 45% of the window width (below the label's 50%, so the two never overlap).
  - It's PC time, not NVR time.
- **Hidden vs closed vs minimized.**
  - Hide cameras (tray, list header) and Hide all (per console) apply to the windows on screen; minimized ones are skipped. Each window gets `win.hide()` plus `CameraStream.pause()`, so its renderer stays alive and Show only waits for a keyframe.
  - At launch, hidden windows aren't created at all. Show cameras creates them.
  - Any explicit open (switch, Find, Show all, Show cameras) clears `hidden`. Bring to front and Reset window positions leave hidden windows hidden.
  - If nothing is on screen at launch, the camera list opens even with Start hidden on.
- **Windows never steal focus.** Use `showInactive()`, never `show()`/`focus()` for camera windows: exacqVision is in use on the same screen.
- **Moving vs aiming.** The window drag region is only the hover bar (`-webkit-app-region: drag`). The picture itself takes right-click (context menu) and, in 360° views, drag/scroll for PTZ. Lock layout disables both window moves and PTZ.
- `src/mock.js` and `src/selftest.js` ship inside the build but do nothing unless `--mock` or `PANES_SELFTEST_DIR` is set.
- ffmpeg for mock/tests comes from `FFMPEG_PATH`, then the `ffmpeg-static` dev dependency, then PATH.

## Testing against the real consoles

The owner's PC has the real config. To try a change live:

1. Quit the installed app (tray → Quit).
2. Run `PANES_DEVTOOLS=1 npm start`.
3. Check `%APPDATA%\Protect Panes\protect-panes.log` for connection errors.

To experiment without disturbing the saved layout, copy `config.json` **and `Local State`** into a scratch folder and run with `PANES_USER_DATA` pointing at it. `safeStorage` encrypts with an AES key stored in `Local State` (`os_crypt.encrypted_key`, itself DPAPI-wrapped), so with `config.json` alone every console fails with "Error while decrypting the ciphertext provided to safeStorage.decryptString". With both files the passwords decrypt for the same Windows user. Adding `PANES_SELFTEST_DIR` to that run gives `result.json` plus screenshots of the real cameras, then the app exits.

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
- `tray-click` `{label}`: same, for the tray menu (no `win`)
- `manager-js` `{js}`: runs JS in the camera list window and stores the result as `value` (no `win`). The list must be open (`startHidden: false`).

`PANES_SELFTEST_DUMP_SEC=n` saves the first n seconds of each window's stream as `<cameraId>.mp4` in the results folder. That's how the color-range finding was measured (`ffmpeg -i` for flags, `signalstats` for levels). Against real consoles it records real video, so delete the dumps afterwards.

Action results carry `t` (epoch ms), so a check can compare against the samples taken before an action. Each sample row also has main-process `visible` and `bounds` per window.

`win` is the index in window-open order. That's config order.

## Releasing

1. Bump `version` in package.json.
2. `npm test`
3. `npm run build:win`
4. Hand over `dist/ProtectPanes-win32-x64.zip`. The owner quits the app and replaces the folder; settings in `%APPDATA%` carry over.

The exe is unsigned, so SmartScreen shows "Run anyway" on first launch.

## Known limitations / not built

Owner-requested features, with findings and open questions, are in `ROADMAP.md`.

- Live view only: no playback, timeline, events, audio or two-way talk.
- PTZ cameras can't be steered; only the 360° virtual PTZ exists.
- One window per camera: the same camera can't be open twice.
- No named layout presets.
- Doorbell package-camera lens isn't exposed (the library supports `source: {type: "lens"}`).
- Desk-mount panorama and lens FOV > 180° are implemented but have only light test coverage.
