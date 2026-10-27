# Roadmap

Owner requests after running 1.1.0 on the real consoles (2026-10-26). Each item records what's already known from the code and the live run, the likely approach, and what's still open. Nothing here is built yet.

Evidence from that session: self-test run against both real consoles (scratch copy of the config). It covered the 4 saved windows, 3 normal and one 360° camera in quad, all on channel 2 (Low, 640×360 / 640×640). All 4 were live at 0.35-0.44 s lag with 0-1 dropped frames over 20 s, and the quad ran on hardware GL (Iris Xe, D3D11).

---

## 1. Picture looks dark / should be lighter

**Status:** cause found and fixed (2026-10-27), unreleased. Falsification test 2 below hit:
- Every measured camera sends full-range luma, but three of the four don't flag it. Chromium reads those as limited range and turns everything below Y=16 solid black. One camera's picture in the app was 6.0% pure black, against 0.1% for a correct PC-range decode.
- The app now rewrites the SPS to declare full range (`src/avc-range.js`). Afterwards it measured 0.02%. Shadows keep their detail; mid-tones barely move.
- Right-click → **Color range** overrides per camera.
- Not built: the brightness/contrast control. It's only worth doing if pictures still look dark next to Protect's own viewer. Test 1 below (side by side with Protect's web view) still needs the owner.

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

**Status:** built, unreleased. Mock-suite tests cover it. Not yet tried on the real consoles.

- Global: camera list → **Show camera names** (`settings.showNames`) hides the dot and label in every window. It's the master switch.
- Per window: right-click → **Show name** (`windows[key].hideName`). It's greyed out while the global switch is off.
- Small windows: when the full label would be wider than 50% of the window (`LABEL_MAX_SHARE` in camera.js), only the dot is shown. The full label comes back when the window is widened. It's measured on every resize, so long and short names each collapse at their own width.
- Open: whether 50% feels right on the real windows. A 353 px window with a 27-character label sits just under the line, at about 47%. Also open: whether the dot alone should hide on very small windows.

## 3. Time on 360° dewarp views

**Status:** built (2026-10-27), unreleased, as option (a) below. Right-click → **Show time** (`windows[key].clock`) overrides the default for any window. Format: `YYYY-MM-DD HH:MM:SS`. It shows only over live video and hides on windows too narrow for it. `npm run test:mock` covers it.

Background: confirmed app limitation. Normal cameras show the camera's own timestamp bottom-right. The 360° quad shows none, because the timestamp is in a corner of the fisheye frame, outside the circle the dewarp samples.

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

## 7. Hide all / put them back the way they were

**Status:** built (2026-10-27), unreleased. `npm run test:hide` covers it. Decisions: hidden survives a restart; Bring cameras to front and Reset window positions leave hidden windows hidden; Show all stays literal. The notes below are the design as proposed.

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

---

## Housekeeping found along the way

- Electron 45 warns that `safeStorage.decryptString` (sync) is deprecated in favor of `decryptStringAsync`. It works today, but it will break on a future Electron bump. Move store.js to the async API before upgrading Electron.
