# Protect Panes

UniFi Protect live view, one camera per window. Place each window anywhere on the screen, at any size, next to whatever else you run (exacqVision, etc.). Positions are remembered. Connects to several consoles at once (e.g. Building and Garage).

- **No RTSP/RTSPS.** Video comes over the console's own livestream connection, the same one Protect's web UI uses. You can leave RTSPS turned off on every camera.
- **Direct, local login.** Signs into each console by IP with a local account. No UI.com, no cloud, no MFA prompt.
- **Light on resources.** One process, GPU video decoding, Medium quality by default, and minimized windows stop streaming.
- **Live view only.** No playback, timeline or events.

## Install (Windows 10/11, 64-bit)

**Installer (recommended):** download `ProtectPanes-Setup.exe` from the [latest release](https://github.com/jamesccupps/UnifiCameraViewer/releases/latest) and run it.
- It installs for your Windows user only, with no admin prompt, into `%LOCALAPPDATA%\Programs\protect-panes`.
- It adds Start menu and desktop shortcuts, and appears in **Settings → Apps** for uninstalling.
- The app isn't code-signed, so Windows shows *Windows protected your PC*: click **More info**, then **Run anyway**.

**Portable:** download `ProtectPanes-win32-x64.zip` instead and unzip it somewhere permanent in your own profile, e.g. `%LOCALAPPDATA%\Programs\Protect Panes` (next to where Setup.exe installs). Avoid `C:\Program Files`, which in-place updates can't write to, and folders made at the root of `C:\` such as `C:\Tools`: Windows lets every account on the PC change those, so another user could swap the app for something that runs as you. Then run `ProtectPanes.exe`.

Either way, you can turn on **Start with Windows** in the app.

## Set up each console

On each UniFi OS console (UDM / UNVR / Cloud Key), create a local account for this app:

- In UniFi OS, add a new admin/user and choose the option that **restricts it to local access only**. Don't use a UI.com (cloud) account: those require MFA and won't work.
- Give it **View Only** access in Protect. It never needs anything more.

Then, in Protect Panes, click **Add console**. Enter a name ("Building"), the console's IP address, and the local username and password. Repeat for the second console ("Garage").

## Use

- The camera list has three tabs: **Cameras**, **Layouts** and **Settings**. Hover over any button for a short explanation.
- On **Cameras**, flip a camera's switch to open its window. **Show all** opens every camera on that console, and **Close all** closes them. Each camera remembers its place. Type in **Find a camera…** to narrow a long list.
- Each camera in the list shows a **preview**, a still from the camera refreshed about once a minute while the list is open. Hover it for a bigger one. The layout editor shows them too: a small one beside each camera in its list, and the camera's picture in each tile you fill (a 360° camera shows its raw fisheye there, whatever view the tile is set to). Turn them off in **Settings → Show camera previews**.
- **Hide from list** on a camera's row tucks a camera you don't use into **Hidden from list** at the bottom of its console, for example cameras that are offline for now. **Show all** and the layout editor skip it. Expand the section and click **Show in list** to bring it back.
- **Arrange** tiles the camera windows on your screen. Cameras tab → **Arrange** picks the best-fitting grid for that screen's size and shape; **Layouts** has fixed choices (2×2, 1+5, 1+7, 3×3, 2+8, 1+12, 4×4, 5×5). The camera at the top left gets the big tile. With **Match each camera's quality to its tile size** on, small tiles get the Low stream and big ones Medium or High. The tray menu has **Arrange windows** too.
- **Move** a window by hovering over it and dragging the bar that appears at the top. **Resize** from any edge. With **Keep video shape** on, windows snap to the camera's aspect ratio so there are no black bars.
- **Right-click** a camera for quality (High / Medium / Low), Always on top, Lock layout, Reconnect, or Close.
- **Right-click → Adjust picture…** opens Brightness and Contrast sliders for that camera. It changes how the picture is shown, not what the camera records, and can't bring back detail lost in very dark areas.
- **Right-click → Apply to all cameras** copies that window's quality, always on top, name, time, color range or picture to every camera on both consoles, including ones you haven't opened yet. In the camera list, **Quality for all…** sets one console's cameras at once.
- **Hide cameras** (tray menu or the top of the camera list) takes every camera window off the screen and pauses its video. **Show cameras** puts exactly those windows back where they were, even after a restart. Each console also has **Hide all** / **Restore** for just its own cameras.
- **New layout…** (Layouts tab) opens the layout editor: pick a screen and a grid, then drag cameras from the list onto the tiles. Double-click a camera to fill the next tile, or drag tiles onto each other to swap them. **Use what's on screen** starts from the windows you have open. Each 360° camera can show as Quad (the default), Single view, Panorama or raw Fisheye in its tile. **Save and apply** puts it on screen; **Edit** on a saved layout reopens it.
- **Grid windows**: in the layout editor, set **Open as → One grid window** to put all the cameras in tiles of a single window, like a Protect liveview. Move it, resize it, maximize it or put it in full screen (right-click → **Full screen**) like any window. Its tiles follow its size, and each tile picks its stream quality from its size. Right-click a tile for that camera's options in this grid (quality, 360° view, color range, picture, name, time, **Remove from grid**) and the grid's own (**Layout**, **Edit grid…**, Always on top, **Close grid**). Right-click an empty tile to **Put a camera here**. **Double-click a tile** (or right-click → **Enlarge this tile**) to fill the grid window with that camera; double-click again (or **Show all tiles**) to go back. On a 360° tile in Quad view, double-click enlarges one of its views instead, so use the menu there. Grid windows are listed on the Layouts tab and in the tray's **Grid windows**, reopen where they were at the next start, and hide with **Hide cameras**. A camera can be in its own window and in a grid at the same time, with different settings in each.
- **Layouts**: you can also arrange the windows by hand, then **Save current arrangement…** in the camera list. Switch between layouts from the camera list or the tray menu's **Layouts**. **Import a Protect liveview…** opens one of the console's saved liveviews in the layout editor. It has the same grid, each camera is in the same tile, and it's set to open as one grid window. Change anything you like, including **Open as**, then save. A Protect tile that cycles through several cameras keeps cycling in a grid window, as often as Protect has it set, and the editor marks it with ↻. Each switch shows *Connecting…* briefly while the next camera's stream starts. Separate windows show the tile's first camera only. To stop a tile cycling, drop a camera onto it in the editor.
- Small windows shrink the name label to just the status dot. **Right-click → Show name** turns the label off for one window; **Show camera names** in settings turns it off everywhere.
- **Lock layout** (tray menu, right-click menu, or settings) stops windows from being moved or resized and hides the hover bar. Use it once everything is placed.
- Closing the camera list doesn't stop anything. The cameras keep running, and the tray icon brings the list back. **Quit** is in the tray menu and the list.
- **Find** flashes a camera's window. **Reset window positions** pulls every window back onto the main screen if a monitor was unplugged.
- **Settings → Move to another PC**: **Export settings…** saves your consoles, layouts, grid windows, window places and settings to a .json file. It holds no passwords, since those are locked to your Windows account. On the other PC, **Import settings…** replaces its settings with the file's and restarts the app.
  - A console that's already there with the same address and username keeps its saved password. For the others, enter it once with **⋯ → Edit console…**.
  - Start with Windows stays as each PC has it.
  - The settings it replaced are kept next to `config.json` as `config.json.before-import`.

## 360° cameras (AI 360 and other fisheyes)

A fisheye camera opens in **quad view**: four virtual pan/tilt/zoom views of the one stream, laid out like an Axis quad view. Protect tells the app which cameras are fisheye and how they're mounted (ceiling / wall / desk). The image circle is found automatically from the picture.

- **Drag** inside a view to aim it, and **scroll** to zoom. Each view remembers where it's pointed.
- **Double-click** a view to enlarge it to the whole window. Double-click again to return to the quad.
- **Right-click → 360° view** to switch to **Single view** (one direction, whole window), **Panorama** (ceiling: the full 360° as two 180° strips; wall: one 180° strip) or back to the raw fisheye. **Aspect ratio** in the same menu sets the window's shape: 16:9 (the default), 4:3, 3:2, 1:1, 21:9, or **Any shape** to size it freely. The views fill whatever shape you pick. In a grid window, the tile sets the shape instead. The same menu has Mount, Lens field of view, Reset views and **Adjust image circle…**, for when the auto-detected circle is off: drag and scroll to fit the green circle to the edge of the round picture, then click Done.
- Quad and panorama views show the date and time in the corner, since the camera's own timestamp is cut out by the dewarp. It's this PC's clock, so keep the PC's time synced. **Right-click → Show time** turns it on or off for any window.
- **Lock layout** also locks the views, so a wall display can't get nudged.

Dewarping is done by the graphics chip on the one stream that's already being decoded, so a 360° camera costs no extra bandwidth. Ordinary Intel integrated graphics (e.g. a Dell OptiPlex) handle it easily. If a PC has no working graphics driver, the app falls back to drawing on the CPU at reduced resolution and shows a one-time notice.

## Files

`%APPDATA%\Protect Panes\`

- `config.json`: consoles, window positions and settings. Passwords are encrypted with Windows DPAPI, tied to your Windows user account.
- `protect-panes.log`: connection log, useful when something won't connect.

## Troubleshooting

| What you see | Fix |
|---|---|
| "Login rejected" | Use a local-only account, not a UI.com login. Re-enter the password with **Edit**. |
| "Can't reach console" | Check the IP. The app retries on its own every 5-60 s. |
| "Camera offline" | The camera is disconnected in Protect. The window recovers when it's back. |
| H.265 message | This PC can't decode HEVC. In Protect, set that camera to Standard (H.264) encoding. |
| Picture behind / choppy | Right-click → pick **Medium** or **Low**. High (4K) streams cost the most GPU. |
| Shadows look crushed / washed out | Many UniFi cameras send full-range video without saying so; the app corrects this automatically. If one camera still looks wrong, try **Right-click → Color range → Full** or **Limited**. |

## Updating the app

Installed copies (from `ProtectPanes-Setup.exe`, 1.3.0 on) and portable copies from 1.3.1 on can update themselves.

1. The camera list's **Settings → Updates** shows the **update location**. By default it's this project's latest GitHub release. To update from your own copy instead, set it to a folder (for example `\\server\share\Protect Panes`) or web address holding `ProtectPanes-win32-x64.zip` plus `latest.json`. Clear it to turn update checks off.
2. Click **Check for updates**. A newer version is downloaded and checked first: it has to carry the release signature this copy of the app trusts, and match its signed checksum. Anything else is refused.
3. Click **Install … and restart**. The app closes, installs the new version and opens again. Installer copies run the new installer silently; portable copies swap their folder. Settings and layouts carry over.

From 1.4.0 on, most updates are small. When a release uses the same Electron as the copy you're running, only the app's own file changes, so the download is a couple of MB instead of 120-160 MB. Releases that move to a new Electron still come as the full installer or zip. One side effect on installed copies: Settings → Apps keeps showing the version the installer last wrote until the next full update. The app's own About section always shows the real version.

The folder the app lives in has to be one you can write to and other accounts can't, e.g. `%LOCALAPPDATA%\Programs\Protect Panes`, not `C:\Program Files` or a folder at the root of `C:\`. When an update location is set, the app also checks once at startup (one small request for `latest.json`) and says so in the list and the tray menu. It never downloads without a click.

Portable copies older than 1.3.1 can't update themselves. 1.2.0 and 1.3.0 download the update, then fail with *a file in it is still in use* and reopen the old version. Install once by hand: quit the app (tray → **Quit**) and run `ProtectPanes-Setup.exe` (your settings carry over), or replace the folder with the latest zip.

## Keeping up with new Protect versions

Protect Panes talks to Protect through the [unifi-protect](https://github.com/hjdhjd/unifi-protect) library, the same one homebridge-unifi-protect uses. It tracks Protect firmware changes. If a future Protect update breaks login or video, rebuild with the latest library (needs Node.js 22.20+):

```
npm install
npm install unifi-protect@latest
npm run build:win
```

The new build lands in `dist\`. Your settings in `%APPDATA%` carry over.

## Development

```
npm install
npm start              # run from source (quit the installed app first)
npm run mock           # fake consoles with test patterns
npm test               # regression tests: mock cameras + fake UniFi OS consoles (~6 min)
npm run build:win      # portable Windows build + zip in dist\
```

The tests run the real app. Its windows stay invisible and click-through, and never take the focus, so you can keep working while they run. Set `PANES_TEST_SHOW=1` to watch them.

See `CLAUDE.md` for architecture, gotchas and the test harness, and `ROADMAP.md` for what's been asked for and how each item was investigated.

## License

MIT. See `LICENSE`.
