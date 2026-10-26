# Roadmap

Owner requests after running 1.1.0 on the real consoles (2026-10-26). Each item records what's already known from the code and the live run, the likely approach, and what's still open. Nothing here is built yet.

Evidence from that session: self-test run against both real consoles (scratch copy of the config). It covered the 4 saved windows, 3 normal and one 360° camera in quad, all on channel 2 (Low, 640×360 / 640×640). All 4 were live at 0.35-0.44 s lag with 0-1 dropped frames over 20 s, and the quad ran on hardware GL (Iris Xe, D3D11).

---

## 1. Picture looks dark / should be lighter

**Status:** cause unknown. Not reproduced from screenshots alone.

Known:
- Nothing in the app alters color. There are no CSS filters on `<video>`, and the dewarp fragment shader is a plain `texture2D` passthrough.
- Overlays only darken their own area: the name label (`rgba(0,0,0,.55)`) and the hover bar (`.78`, only while hovering).
- The saved windows all use the Low channel. It's softer, but that alone shouldn't change brightness.

Falsification tests, in order:
1. Same camera, same channel, same moment: screenshot Protect's web live view and the Protect Panes window side by side and compare mean luma. If they match, the darkness is the camera's exposure or image settings in Protect, not this app.
2. If Panes is darker, capture an init + media segment and check the H.264 VUI `video_full_range_flag` / `colour_primaries` (`ffprobe -show_streams`). A range mismatch between what the camera flags and what Chromium assumes would crush the blacks.

Possible app-side fix if (1) points at us: a per-window brightness/contrast adjustment (CSS `filter`, GPU-cheap). Tradeoff: it's cosmetic. It won't recover shadow detail the encoder already threw away.

## 2. Hide the status dot + camera name, and collapse it on small windows

**Status:** partly exists.

- A global switch already exists: camera list → **Show camera names** (`settings.showNames`). Turning it off hides the dot and the label in every window. It's currently **on** in the real config.
- Missing: a **per-window** toggle, i.e. a right-click menu item that stores `windows[key].showName` and overrides the global setting.
- Requested: when the label is shown and the window is made small, **collapse it to just the dot**. Approach: a `ResizeObserver` in camera.js collapses the label to the dot when the label is wider than ~50% of the window. Measuring is better than a fixed CSS breakpoint because names range from "Dock" to "North Parking Level 2 Stairwell · Garage".
- Open: the exact threshold, and whether the dot alone should also hide when the window is very small.

## 3. Time on 360° dewarp views

**Status:** confirmed app limitation. Normal cameras show the camera's own timestamp bottom-right. The 360° quad shows none, because the timestamp is in a corner of the fisheye frame, outside the circle the dewarp samples.

Options:
- **(a) App-drawn clock** in a corner of the dewarp canvas, from the PC clock, offset by the measured live lag (~0.2-0.7 s). Simple and always legible. Tradeoff: it's PC time, not NVR time. If the PC isn't on NTP it won't match recordings.
- **(b) Copy the camera's own timestamp region** from the raw fisheye frame and composite it into the canvas. It's the camera's real time, true to the frame. Tradeoff: the timestamp's position and size vary by model and setting. At 640×640 Low it's barely readable, and it needs a calibration step like the image circle.
- (c) Stream timestamps: not usable. The library rebases timestamps to zero on every (re)connect.

Recommend (a), on by default in dewarp modes only, with a per-window toggle and the format matched to Protect's timestamp.

## 4. Apply to all cameras

**Status:** not built. Today quality (`channel`), always-on-top and dewarp settings are per window, set from the right-click menu or the camera-list dropdown.

- Add **Apply to all** at two scopes: per console (in its card) and global. Settings: quality, always on top, name label (once per-window exists, #2), and the clock (#3).
- Guard: High on dozens of cameras will saturate Intel iGPU decode. A two-console site can easily have 50+ cameras. Show the count and confirm before applying High.
- Dewarp mode/mount should apply only to fisheye cameras.

## 5. Dashboards / grids / saved views like UniFi

**Status:** not built (already listed under "Known limitations": no named layout presets).

Two different features:
- **(a) Named layouts.** Save the set of open windows plus their bounds, quality and dewarp state under a name, and switch between them from the tray or the list. This fits the free-floating, one-window-per-camera design and is mostly config work (`layouts{name: windows-snapshot}`).
- **(b) Grid window.** One window holding N cameras in a grid, like Protect's Liveview. This breaks "one window per camera": it needs several MSE players in one renderer plus layout code, and per-tile hover/PTZ.
- **Import from Protect:** the library already exposes the console's saved liveviews (`client.liveviews` → `{name, layout, slots[{cameras[], cycleMode, cycleInterval}]}`). Either (a) or (b) could offer "Import liveview" instead of building layouts by hand. Cycling slots would be new work.

Recommend (a) first, plus importing Protect liveviews as named layouts. Do (b) only if floating windows turn out to be the wrong shape for a dashboard screen.

## 6. Update in place instead of downloading a new zip

**Status:** not built. Releases are an unsigned portable zip (~159 MB), and the owner replaces the folder by hand.

Options:
- **Squirrel / electron `autoUpdater`.** Needs an installer, an update feed, and realistically code signing. That's a lot of process for a single-site tool.
- **In-app updater (recommended):**
  1. Check a manifest at a configured source (a LAN share or a GitHub release).
  2. Download the zip and verify a SHA-256 plus an **Ed25519 signature** against a public key compiled into the app. The exe is unsigned, so this signature is the only thing standing between the update path and arbitrary code execution.
  3. Stage the new build beside the current one, quit, swap folders with a small helper, and relaunch. Settings in `%APPDATA%` carry over.
- **Cheaper variant:** ship only `resources/app.asar` when the Electron version hasn't changed (a few MB instead of 159), with a full zip for Electron bumps.
- Constraint: the install folder must be writable by the user (e.g. `C:\Tools\Protect Panes` or `%LOCALAPPDATA%`), not `Program Files`, or the swap needs elevation.
- Open: where updates are published (LAN share vs GitHub), and whether to check automatically or only on "Check for updates".

---

## Housekeeping found along the way

- Electron 45 warns that `safeStorage.decryptString` (sync) is deprecated in favor of `decryptStringAsync`. It works today, but it will break on a future Electron bump. Move store.js to the async API before upgrading Electron.
