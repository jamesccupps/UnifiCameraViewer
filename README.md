# Protect Panes

UniFi Protect live view, one camera per window. Place each window anywhere on the screen, at any size, next to whatever else you run (exacqVision, etc.). Positions are remembered. Connects to several consoles at once (e.g. Building and Garage).

- **No RTSP/RTSPS.** Video comes over the console's own livestream connection, the same one Protect's web UI uses. You can leave RTSPS turned off on every camera.
- **Direct, local login.** Signs into each console by IP with a local account. No UI.com, no cloud, no MFA prompt.
- **Light on resources.** One process, GPU video decoding, Medium quality by default, and minimized windows stop streaming.
- **Live view only.** No playback, timeline or events.

## Install (Windows 10/11, 64-bit)

1. Unzip `ProtectPanes-win32-x64.zip` somewhere permanent, e.g. `C:\Program Files\Protect Panes` or `C:\Tools\Protect Panes`.
2. Run `ProtectPanes.exe`. The app isn't code-signed, so the first launch shows *Windows protected your PC*: click **More info**, then **Run anyway**.
3. Optionally pin it to the taskbar, or turn on **Start with Windows** in the app.

## Set up each console

On each UniFi OS console (UDM / UNVR / Cloud Key), create a local account for this app:

- In UniFi OS, add a new admin/user and choose the option that **restricts it to local access only**. Don't use a UI.com (cloud) account: those require MFA and won't work.
- Give it **View Only** access in Protect. It never needs anything more.

Then, in Protect Panes, click **Add console**. Enter a name ("Building"), the console's IP address, and the local username and password. Repeat for the second console ("Garage").

## Use

- In the camera list, flip a camera's switch to open its window. **Show all** opens every camera on that console.
- **Move** a window by hovering over it and dragging the bar that appears at the top. **Resize** from any edge. With **Keep video shape** on, windows snap to the camera's aspect ratio so there are no black bars.
- **Right-click** a camera for quality (High / Medium / Low), Always on top, Lock layout, Reconnect, or Close.
- **Lock layout** (tray menu, right-click menu, or settings) stops windows from being moved or resized and hides the hover bar. Use it once everything is placed.
- Closing the camera list doesn't stop anything. The cameras keep running, and the tray icon brings the list back. **Quit** is in the tray menu and the list.
- **Find** flashes a camera's window. **Reset window positions** pulls every window back onto the main screen if a monitor was unplugged.

## 360° cameras (AI 360 and other fisheyes)

A fisheye camera opens in **quad view**: four virtual pan/tilt/zoom views of the one stream, laid out like an Axis quad view. Protect tells the app which cameras are fisheye and how they're mounted (ceiling / wall / desk). The image circle is found automatically from the picture.

- **Drag** inside a view to aim it, and **scroll** to zoom. Each view remembers where it's pointed.
- **Double-click** a view to enlarge it to the whole window. Double-click again to return to the quad.
- **Right-click → 360° view** to switch to **Panorama** (ceiling: the full 360° as two 180° strips; wall: one 180° strip) or back to the raw fisheye. The same menu has Mount, Lens field of view, Reset views and **Adjust image circle…**, for when the auto-detected circle is off: drag and scroll to fit the green circle to the edge of the round picture, then click Done.
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
npm test               # regression tests: mock cameras + fake UniFi OS consoles
npm run build:win      # portable Windows build + zip in dist\
```

See `CLAUDE.md` for architecture, gotchas and the test harness.
