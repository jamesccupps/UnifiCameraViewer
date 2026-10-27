# Roadmap

Owner requests after running 1.1.0 on the real consoles (2026-10-26), and later. Each item records what's already known from the code and the live run, the likely approach, and what's still open. Items 1-7 shipped in 1.2.0 and 8-11 in 1.3.0. The follow-ups built for 1.4.0 are: #1's brightness/contrast, #5's grid window, #6's small updates, the housekeeping item, and the new #12 and #13.

Evidence from that session: self-test run against both real consoles (scratch copy of the config). It covered the 4 saved windows, 3 normal and one 360° camera in quad, all on channel 2 (Low, 640×360 / 640×640). All 4 were live at 0.35-0.44 s lag with 0-1 dropped frames over 20 s, and the quad ran on hardware GL (Iris Xe, D3D11).

---

## 1. Picture looks dark / should be lighter

**Status:** cause found and fixed (2026-10-27), shipped in 1.2.0. Falsification test 2 below hit:
- Every measured camera sends full-range luma, but three of the four don't flag it. Chromium reads those as limited range and turns everything below Y=16 solid black. One camera's picture in the app was 6.0% pure black, against 0.1% for a correct PC-range decode.
- The app now rewrites the SPS to declare full range (`src/avc-range.js`). Afterwards it measured 0.02%. Shadows keep their detail; mid-tones barely move.
- Right-click → **Color range** overrides per camera.
- Brightness/contrast: built for 1.4.0 at the owner's request (2026-10-27). Right-click → **Adjust picture…** has Brightness and Contrast sliders (50-200 %), saved per window as `picture`. It's a CSS filter on the video and the dewarp canvas. The range suite measures it on screen: brightness 200 % shows Y=24 as ~48, and contrast 50 % lifts black to ~64. It's cosmetic and can't recover shadow detail the encoder dropped. Test 1 below (side by side with Protect's web view) still needs the owner.

Original notes:

Known:
- Nothing in the app alters color. There are no CSS filters on `<video>`, and the dewarp fragment shader is a plain `texture2D` passthrough.
- Overlays only darken their own area: the name label (`rgba(0,0,0,.55)`) and the hover bar (`.78`, only while hovering).
- The saved windows all use the Low channel. It's softer, but that alone shouldn't change brightness.

Falsification tests, in order:
1. Same camera, same channel, same moment: screenshot Protect's web live view and the Protect Panes window side by side and compare mean luma. If they match, the darkness is the camera's exposure or image settings in Protect, not this app.
2. If Panes is darker, capture an init + media segment and check the H.264 VUI `video_full_range_flag` / `colour_primaries` (`ffprobe -show_streams`). A range mismatch between what the camera flags and what Chromium assumes would crush the blacks.

Possible app-side fix if (1) points at us: a per-window brightness/contrast adjustment (CSS `filter`, GPU-cheap). Tradeoff: it's cosmetic. It won't recover shadow detail the encoder already threw away.

## 2. Hide the status dot + camera name, and collapse it on small windows

**Status:** built, shipped in 1.2.0. Mock-suite tests cover it. Not yet tried on the real consoles.

- Global: camera list → **Show camera names** (`settings.showNames`) hides the dot and label in every window. It's the master switch.
- Per window: right-click → **Show name** (`windows[key].hideName`). It's greyed out while the global switch is off.
- Small windows: when the full label would be wider than 50% of the window (`LABEL_MAX_SHARE` in camera.js), only the dot is shown. The full label comes back when the window is widened. It's measured on every resize, so long and short names each collapse at their own width.
- Open: whether 50% feels right on the real windows. A 353 px window with a 27-character label sits just under the line, at about 47%. Also open: whether the dot alone should hide on very small windows.

## 3. Time on 360° dewarp views

**Status:** built (2026-10-27), shipped in 1.2.0, as option (a) below. Right-click → **Show time** (`windows[key].clock`) overrides the default for any window. Format: `YYYY-MM-DD HH:MM:SS`. It shows only over live video and hides on windows too narrow for it. `npm run test:mock` covers it.

Background: confirmed app limitation. Normal cameras show the camera's own timestamp bottom-right. The 360° quad shows none, because the timestamp is in a corner of the fisheye frame, outside the circle the dewarp samples.

Options:
- **(a) App-drawn clock** in a corner of the dewarp canvas, from the PC clock, offset by the measured live lag (~0.2-0.7 s). Simple and always legible. Tradeoff: it's PC time, not NVR time. If the PC isn't on NTP it won't match recordings.
- **(b) Copy the camera's own timestamp region** from the raw fisheye frame and composite it into the canvas. It's the camera's real time, true to the frame. Tradeoff: the timestamp's position and size vary by model and setting. At 640×640 Low it's barely readable, and it needs a calibration step like the image circle.
- (c) Stream timestamps: not usable. The library rebases timestamps to zero on every (re)connect.

Recommend (a), on by default in dewarp modes only, with a per-window toggle and the format matched to Protect's timestamp.

## 4. Apply to all cameras

**Status:** built (2026-10-27), shipped in 1.2.0.
- Right-click → **Apply to all cameras** copies quality, always on top, show name, show time and color range, one at a time or all of them, to every camera on every console, including ones never opened.
- The camera list has **Quality for all…** per console.
- Applying High with more than 6 windows on screen asks first. Dewarp settings aren't copied, since they're per lens.
- `npm test` covers it (mock and hide suites).

Original notes: quality (`channel`), always-on-top and dewarp settings were per window only.

- Add **Apply to all** at two scopes: per console (in its card) and global. Settings: quality, always on top, name label (once per-window exists, #2), and the clock (#3).
- Guard: High on dozens of cameras will saturate Intel iGPU decode. A two-console site can easily have 50+ cameras. Show the count and confirm before applying High.
- Dewarp mode/mount should apply only to fisheye cameras.

## 5. Dashboards / grids / saved views like UniFi

**Status:** built (2026-10-27) as (a) plus Protect liveview import, shipped in 1.2.0.
- Named layouts are saved from the camera list and switched from the list or the tray.
- Import tiles a liveview's slots as an even grid, using the first camera of each slot. Uneven layouts and slot cycling aren't reproduced.
- `npm run test:layouts` and the e2e suite cover it; the e2e suite checks the real library's `client.liveviews`.
- (b), the grid window: built for 1.4.0 at the owner's request.
  - The layout editor's **Open as → One grid window** makes one framed window with a WebContentsView per tile running the ordinary camera page. Each tile keeps 360° dewarp and PTZ, the clock, picture and the right-click menu.
  - Tiles have their own settings, so a camera can look different in a grid and in its window. Quality follows the tile's size unless the tile picks one.
  - Grids are managed from the tile menu (Layout, Edit grid…, Full screen, Close grid, Remove from grid; "Put a camera here" on an empty tile), the Layouts tab and the tray.
  - They reopen at launch and hide with Hide cameras. `npm run test:grid` covers it.
  - Not built: slot cycling, importing a Protect liveview as a grid, and "enlarge this tile".

Original notes:

Two different features:
- **(a) Named layouts.** Save the set of open windows plus their bounds, quality and dewarp state under a name, and switch between them from the tray or the list. This fits the free-floating, one-window-per-camera design and is mostly config work (`layouts{name: windows-snapshot}`).
- **(b) Grid window.** One window holding N cameras in a grid, like Protect's Liveview. This breaks "one window per camera": it needs several MSE players in one renderer plus layout code, and per-tile hover/PTZ.
- **Import from Protect:** the library already exposes the console's saved liveviews (`client.liveviews` → `{name, layout, slots[{cameras[], cycleMode, cycleInterval}]}`). Either (a) or (b) could offer "Import liveview" instead of building layouts by hand. Cycling slots would be new work.

Recommend (a) first, plus importing Protect liveviews as named layouts. Do (b) only if floating windows turn out to be the wrong shape for a dashboard screen.

## 6. Update in place instead of downloading a new zip

**Status:** built (2026-10-27) as the recommended in-app updater, shipped in 1.2.0.
- Settings → Updates takes an https:// URL or a folder holding a release.
- Install requires an Ed25519-signed `latest.json` and a zip that matches its signed checksum.
- A PowerShell helper swaps the folder, with rollback, then relaunches.
- `npm run test:update` covers it, including the real helper.
- Signing key: `%USERPROFILE%\.protect-panes\update-signing-key.pem`, public half in `src/update-key.js`.
- The asar-only delta: built for 1.4.0.
  - A release also carries `ProtectPanes-app.asar.gz` (~1.5 MB). The signed manifest gives it the Electron version it needs and the size/SHA-256 of the unpacked file.
  - Copies on that Electron, installed or portable, download only that. The helper checks the unpacked hash and swaps `resources\app.asar` with rollback.
  - Everything else falls back to the full installer or zip.
  - Tradeoff: an installed copy's Settings → Apps version lags until the next full update.
- Default update location: this repo's latest GitHub release (`releases/latest/download`).
- Portable copies of 1.2.0 and 1.3.0 started from Explorer or a shortcut could not install: the helper inherited the install folder as its working folder, which blocks renaming it. Fixed in 1.3.1. Installed copies were not affected.

Original notes: releases were an unsigned portable zip (~159 MB), and the owner replaced the folder by hand.

Options:
- **Squirrel / electron `autoUpdater`.** Needs an installer, an update feed, and realistically code signing. That's a lot of process for a single-site tool.
- **In-app updater (recommended):**
  1. Check a manifest at a configured source (a LAN share or a GitHub release).
  2. Download the zip and verify a SHA-256 plus an **Ed25519 signature** against a public key compiled into the app. The exe is unsigned, so this signature is the only thing standing between the update path and arbitrary code execution.
  3. Stage the new build beside the current one, quit, swap folders with a small helper, and relaunch. Settings in `%APPDATA%` carry over.
- **Cheaper variant:** ship only `resources/app.asar` when the Electron version hasn't changed (a few MB instead of 159), with a full zip for Electron bumps.
- Constraint: the install folder must be writable by the user (e.g. `C:\Tools\Protect Panes` or `%LOCALAPPDATA%`), not `Program Files`, or the swap needs elevation.
- Open: where updates are published (LAN share vs GitHub), and whether to check automatically or only on "Check for updates".

## 7. Hide all / put them back the way they were

**Status:** built (2026-10-27), shipped in 1.2.0. `npm run test:hide` covers it. Decisions: hidden survives a restart; Bring cameras to front and Reset window positions leave hidden windows hidden; Show all stays literal. The notes below are the design as proposed.

Requested 2026-10-27.

Known from the code:
- **Show all** (per console, `mgr:open-all`) opens a window for *every* camera on that console, which can be dozens. There's no inverse.
- Closing a window already remembers its position, size, quality and 360° views, so one camera reopens where it was. What isn't remembered is *which set* was on screen.
- Each window can be minimized, and its stream pauses (`CameraStream.pause()`). There's no minimize-all, though. And with **Hide cameras from taskbar** on (as in the real config), a minimized window has no taskbar button; only **Bring cameras to front** gets it back.

Proposed:
- **Hide cameras / Show cameras**, a global toggle in the tray menu and the camera list header. Hide takes every window currently on screen off the screen and pauses its stream (no bandwidth, no decode). Show brings back exactly that set, at the same positions and sizes and with the same 360° views, without stealing focus (`showInactive()`).
- **Hide all** per console, next to Show all: the same thing for one console's windows. While any of them are hidden, the button reads **Restore**.
- Both use one per-window flag (`windows[key].hidden`), so the camera list can show hidden windows distinctly from closed ones.

How to hide, with tradeoffs:
- **`win.hide()` + paused stream (recommended).** Bounds are untouched, and restore is quick: about 1-2 s to the first frame, because the stream has to restart and wait for a keyframe. Cost: each hidden window keeps its renderer process and some GPU memory, which is fine for the handful normally on screen.
- **Minimize.** Same cost as hide, but it plays the Windows minimize animation per window, and with taskbar hiding on there's no way back except Bring to front.
- **Close and remember the set.** Frees the memory, but restoring means recreating every window and reconnecting its stream, so it's slower. It survives a restart for free via the existing `open` flag.

Open:
- Should "hidden" survive an app restart? Suggestion: yes. At launch, skip creating hidden windows (saves memory) and create them on Show.
- Should **Bring cameras to front** also un-hide hidden windows, or only raise the visible ones? Today it restores everything, minimized ones included.
- Should **Show all** keep meaning "every camera on the console", or become "restore what I had" when windows are hidden? Suggestion: keep it literal, and let Restore / Show cameras do the putting back.

## 8. One download: an installer

**Status:** built (2026-10-27), shipped in 1.3.0. `ProtectPanes-Setup.exe` is a per-user NSIS installer with shortcuts and an uninstaller, published alongside the zip. Installer copies update by running the new installer silently; zip copies keep the folder swap. CI installs, starts and uninstalls it on a throwaway runner.

## 9. Arrange windows and Close all

**Status:** built (2026-10-27), shipped in 1.3.0.
- **Arrange** tiles the windows on a screen: Auto (best fit for that screen's size and shape) or fixed layouts (1, 2×2, 1+5, 1+7, 3×3, 2+8, 1+12, 4×4, 5×5). The top-left camera gets the big tile.
- Optionally each camera's quality follows its tile size.
- **Close all** per console is the opposite of Show all.
- `npm run test:arrange` covers it.

## 10. Layout editor (exacqVision-style)

**Status:** built (2026-10-27), shipped in 1.3.0.
- Pick a screen and a layout, then drag cameras from the list into tiles (or double-click them), swap tiles by dragging, or start from what's on screen.
- Each 360° camera gets a view per tile: Quad (default), Single, Panorama or Fisheye.
- Save, or save and apply. Edit reopens it.
- `npm run test:editor` covers it.

## 11. Easier camera list

**Status:** built (2026-10-27), shipped in 1.3.0.
- Cameras / Layouts / Settings tabs, and hover tips on every control.
- A camera filter, and a per-console "⋯" menu for the rarely used actions.
- An About section with the version, the project page and the log folder.

## 12. Hide unused cameras in the camera list

Requested 2026-10-27: "a few cameras that are offline because they aren't being used right now".

**Status:** built for 1.4.0.
- **Hide** on a camera's row (`windows[key].listHidden`) moves it into a collapsed **Hidden from list (N)** section at the bottom of its console, with **Show in list** to put it back.
- Show all and the layout editor skip it, its window closes, and the camera count leaves it out.
- `npm run test:list` covers it.

## 13. Previews in the camera list

Requested 2026-10-27: "a way to show a preview or screenshot in the camera selection window".

**Status:** built for 1.4.0.
- Each camera row has a still from Protect's snapshot endpoint (the read-only one its web UI uses for thumbnails, through the library's `Camera.snapshot()`). Hovering it, or a camera in the layout editor, shows a bigger one with its age.
- Requests are limited:
  - each picture is kept 30 s;
  - at most 3 requests run at once;
  - offline cameras are never asked;
  - only rows on screen while the list is visible are fetched, refreshed about once a minute.
- Settings → **Show camera previews** turns it off.
- `npm run test:list` and the e2e suite cover it; e2e checks a real JPEG through the library.

---

## Housekeeping found along the way

- Done for 1.4.0: store.js uses safeStorage's async API (the sync one is deprecated in Electron 45 and would break on a later upgrade). On the owner's real config, the async API reads passwords the sync one saved, and the reverse also works, so going back to 1.3.x still works. e2e checks a password saved the 1.3.x way.
