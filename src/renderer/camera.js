"use strict";

/*
 * Plays the Protect fMP4 livestream through Media Source Extensions and keeps it pinned to the
 * live edge. The main process sends an init segment (with its RFC 6381 codec string), then ~100 ms
 * fragments. Anything unrecoverable asks the main process to restart the stream ("cam:reset").
 */

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");
const labelEl = document.getElementById("label");
const labelText = document.getElementById("label-text");
const clockEl = document.getElementById("clock");
const dot = document.getElementById("dot");
const barTitle = document.getElementById("bar-title");
const barConsole = document.getElementById("bar-console");
const btnTop = document.getElementById("btn-top");
const highlightEl = document.getElementById("highlight");
const noticeEl = document.getElementById("notice");
const dewarpCanvas = document.getElementById("dewarp");
const pictureEl = document.getElementById("picture");
const picInputs = { brightness: document.getElementById("pic-brightness"), contrast: document.getElementById("pic-contrast") };

// camera.html?tile=1 is a tile in a grid window: the grid's frame moves, sizes and closes it.
if (new URLSearchParams(location.search).has("tile")) document.body.classList.add("tile");

const MAX_QUEUE = 150;        // ~15 s of fragments waiting to append => we're not keeping up
const MAX_LAG_S = 1.5;        // jump to live if further behind than this
const CATCHUP_LAG_S = 0.5;    // play slightly fast above this
const KEEP_BEHIND_S = 12;     // seconds of decoded history to keep before trimming
const LABEL_MAX_SHARE = 0.5;  // a name label wider than this share of the window shrinks to just the dot
const CLOCK_MAX_SHARE = 0.45; // below the label's share, so the two bottom corners never meet
const RESET_GAP_MS = 3_000;   // between stream restarts; doubles while restarts keep failing...
const RESET_GAP_MAX_MS = 60_000; // ...up to this
const DECODE_HELP_AFTER = 3;  // failed restarts in a row before saying it's this PC's decoder
const DECODE_HELP = "This PC couldn't decode this stream. Try Medium or Low quality from the right-click menu.";
const STUCK_MS = 5_000;       // fragments arriving but no new frame this long => restart the stream
const CLOCK_FRESH_MS = 1_500; // the clock shows only if a new frame came this recently

let mediaSource = null;
let sourceBuffer = null;
let mime = "";
let queue = [];
let lastTrim = 0;
let lastResetRequest = 0;
let resetTimer = null;
let failedResets = 0;         // restarts asked for since a frame was last shown
let lastAspect = "";
let streamState = "connecting";
let codecError = "";          // sticky: a live stream we can't decode stays an error
let meta = { title: "", consoleName: "" };
let clockWanted = false;
let clockFits = true;
let picture = { brightness: 1, contrast: 1 };
let pictureSave = null;

// Exposed for the self-test harness only.
const stats = { appended: 0, rebuilds: 0, jumps: 0, resetRequests: 0, errors: [] };
window.__panesStats = () => {
  const b = video.buffered;
  const end = b.length ? b.end(b.length - 1) : 0;
  const q = video.getVideoPlaybackQuality?.();
  return {
    ...stats,
    queue: queue.length,
    currentTime: video.currentTime,
    bufferedEnd: end,
    lag: end - video.currentTime,
    paused: video.paused,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    decodedFrames: q?.totalVideoFrames ?? null,
    droppedFrames: q?.droppedVideoFrames ?? null,
    mime,
    status: streamState,
    failedResets,
    statusText: statusEl.classList.contains("hidden") ? "" : statusText.textContent,
    label: { shown: !document.body.classList.contains("no-names"), compact: labelEl.classList.contains("compact") },
    clock: { wanted: clockWanted, shown: !clockEl.classList.contains("hidden"), text: clockEl.textContent },
    picture: { filter: video.style.filter, canvasFilter: dewarpCanvas.style.filter, panel: !pictureEl.classList.contains("hidden") },
    dewarp: dewarper.stats(),
  };
};

// 360° cameras: the Dewarper paints quad/panorama views from the same decoded video.
const dewarper = new Dewarper(video, dewarpCanvas, {
  onChange: (patch) => panes.send("cam:dewarp", patch),
  onError: (msg) => notice(msg, 10_000),
});

// ---------------------------------------------------------------------------------------------
// MSE pipeline

// The console sends an RFC 6381 codec string; if Chromium rejects it (format drift between
// Protect versions), derive one from the init segment's sample entries instead.
function codecFromInit(init) {
  const bytes = init instanceof Uint8Array ? init : new Uint8Array(init);
  const find = (tag) => {
    const t = [...tag].map((c) => c.charCodeAt(0));
    outer: for (let i = 0; i + 4 <= bytes.length; i++) {
      for (let j = 0; j < 4; j++) if (bytes[i + j] !== t[j]) continue outer;
      return i;
    }
    return -1;
  };
  const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");
  const parts = [];

  let i;
  if ((i = find("avcC")) >= 0) {
    const entry = find("avc3") >= 0 ? "avc3" : "avc1";
    parts.push(`${entry}.${hex(bytes[i + 5])}${hex(bytes[i + 6])}${hex(bytes[i + 7])}`.toLowerCase());
  } else if ((i = find("hvcC")) >= 0) {
    const entry = find("hev1") >= 0 ? "hev1" : "hvc1";
    const b = (k) => bytes[i + 4 + k];
    const space = ["", "A", "B", "C"][b(1) >> 6];
    const tier = (b(1) >> 5) & 1 ? "H" : "L";
    const profile = b(1) & 0x1f;
    let compat = ((b(2) << 24) | (b(3) << 16) | (b(4) << 8) | b(5)) >>> 0;
    let rev = 0;
    for (let k = 0; k < 32; k++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const constraints = [6, 7, 8, 9, 10, 11].map(b);
    while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
    parts.push(`${entry}.${space}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier}${b(12)}.${constraints.map((c) => hex(c)).join(".")}`);
  } else if ((i = find("av1C")) >= 0) {
    const b1 = bytes[i + 5];
    const b2 = bytes[i + 6];
    const depth = (b2 & 0x40) ? ((b2 & 0x20) ? 12 : 10) : 8;
    parts.push(`av01.${b1 >> 5}.${String(b1 & 0x1f).padStart(2, "0")}${(b2 & 0x80) ? "H" : "M"}.${String(depth).padStart(2, "0")}`);
  }
  if (find("mp4a") >= 0) parts.push("mp4a.40.2");
  return parts.join(", ");
}

function pickMime(codec, initData) {
  const candidates = [];
  if (codec) candidates.push(String(codec).replace(/\s+/g, "").replace(/,/g, ", "));
  const derived = codecFromInit(initData);
  if (derived) candidates.push(derived);
  // Last resort: video only, in case the audio entry is what's being rejected.
  if (derived.includes(",")) candidates.push(derived.split(",")[0]);
  if (!window.MediaSource) return { mime: "", tried: candidates };
  for (const c of candidates) {
    const m = `video/mp4; codecs="${c}"`;
    if (MediaSource.isTypeSupported(m)) return { mime: m, tried: candidates };
  }
  return { mime: "", tried: candidates };
}

function rebuild(codec, initData) {
  teardown();
  const pick = pickMime(codec, initData);
  mime = pick.mime;
  if (!mime) {
    const hevc = pick.tried.some((c) => /^(hvc1|hev1)/i.test(c));
    codec = pick.tried.join(" / ") || codec;
    codecError = hevc
      ? "This PC can't decode H.265 in this app. In Protect, set this camera to Standard (H.264) encoding, or pick another quality from the right-click menu."
      : `This stream's codec isn't supported (${codec}).`;
    showStatus("error", codecError);
    updateDot();
    panes.send("cam:unsupported"); // no point pulling video nothing here can play
    return;
  }
  codecError = "";
  stats.rebuilds++;
  queue = [initData];
  const ms = new MediaSource();
  mediaSource = ms;
  const url = URL.createObjectURL(ms);
  video.src = url;
  // A frame on screen means the restarts worked.
  video.requestVideoFrameCallback(() => {
    if (!failedResets) return;
    failedResets = 0;
    if (streamState === "live" && !codecError) hideStatus();
    updateDot();
  });
  ms.addEventListener("sourceopen", () => {
    URL.revokeObjectURL(url);
    if (ms !== mediaSource) return;
    try {
      const sb = ms.addSourceBuffer(mime);
      sb.mode = "segments";
      sb.addEventListener("updateend", onUpdateEnd);
      sb.addEventListener("error", () => requestReset("sourcebuffer error"));
      sourceBuffer = sb;
    } catch (err) {
      requestReset(`addSourceBuffer: ${err.name}`);
      return;
    }
    pump();
  }, { once: true });
}

function teardown() {
  if (sourceBuffer) sourceBuffer.removeEventListener("updateend", onUpdateEnd);
  sourceBuffer = null;
  if (mediaSource && mediaSource.readyState === "open") {
    try { mediaSource.endOfStream(); } catch { /* ignore */ }
  }
  mediaSource = null;
  queue = [];
  video.removeAttribute("src");
  video.load();
}

function pump() {
  const sb = sourceBuffer;
  if (!sb || sb.updating || !queue.length || mediaSource?.readyState !== "open") return;
  const chunk = queue.shift();
  try {
    sb.appendBuffer(chunk);
    stats.appended++;
  } catch (err) {
    if (err.name === "QuotaExceededError") {
      queue.unshift(chunk);
      if (!trim(true)) requestReset("buffer full"); // nothing old enough to drop: start over
      return;
    }
    requestReset(`append: ${err.name}`);
  }
}

function onUpdateEnd() {
  keepLive();
  if (trim(false)) return; // remove() fires another updateend, which resumes pumping
  pump();
}

function keepLive() {
  const b = video.buffered;
  if (!b.length) return;
  const start = b.start(b.length - 1);
  const end = b.end(b.length - 1);

  if (video.currentTime < start || end - video.currentTime > MAX_LAG_S) {
    video.currentTime = Math.max(start, end - 0.25);
    stats.jumps++;
  }
  const lag = end - video.currentTime;
  if (lag > CATCHUP_LAG_S) video.playbackRate = 1.15;
  else if (lag < 0.25) video.playbackRate = 1.0;

  if (video.paused) video.play().catch(() => { /* retried on next fragment */ });
}

function trim(force) {
  const sb = sourceBuffer;
  const now = performance.now();
  if (!sb || sb.updating || (!force && now - lastTrim < 10_000)) return false;
  lastTrim = now;
  const b = video.buffered;
  if (!b.length) return false;
  const removeEnd = video.currentTime - KEEP_BEHIND_S;
  if (removeEnd <= b.start(0) + 1) return false;
  try {
    sb.remove(b.start(0), removeEnd);
    return true;
  } catch {
    return false;
  }
}

// A reset asked for too soon after the last one waits for the gap instead of being dropped. Dropping
// it left the MediaSource closed while main sent "live", so a stream that failed to decode every time
// (one the GPU's decoder accepts, then rejects) showed black with a green dot, cycling forever. The
// gap doubles while restarts keep failing, and after a few the window says what's wrong.
function requestReset(reason) {
  stats.errors.push(String(reason));
  if (stats.errors.length > 20) stats.errors.shift();
  if (resetTimer) return; // one is already waiting
  teardown();
  if (failedResets >= DECODE_HELP_AFTER) showStatus("error", DECODE_HELP);
  else showStatus("reconnecting", "Reconnecting…");
  updateDot();
  const gap = Math.min(RESET_GAP_MS * 2 ** failedResets, RESET_GAP_MAX_MS);
  resetTimer = setTimeout(() => {
    resetTimer = null;
    lastResetRequest = performance.now();
    stats.resetRequests++;
    failedResets++;
    panes.send("cam:reset", reason);
  }, Math.max(0, lastResetRequest + gap - performance.now()));
}

video.addEventListener("error", () => requestReset(`video error ${video.error?.code ?? ""}`));

// Fragments that keep appending while no new frame decodes leave a frozen picture under a green
// dot, and nothing else notices: a hung decoder, or a restart whose timestamps went back to zero
// without a discontinuity flag, so its video lands behind the playhead. Stalls with no fragments
// coming are the library's to detect. A hidden or covered window may legitimately stop presenting.
let lastFrames = -1;
let lastFrameAt = 0;
let appendedAtFrame = 0;
function decodedFrames() {
  return video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
}
setInterval(() => {
  const frames = decodedFrames();
  const now = performance.now();
  if (frames !== lastFrames || streamState !== "live" || document.hidden || !mediaSource) {
    lastFrames = frames;
    lastFrameAt = now;
    appendedAtFrame = stats.appended;
    return;
  }
  if (now - lastFrameAt > STUCK_MS && stats.appended - appendedAtFrame >= 10) {
    lastFrameAt = now;
    appendedAtFrame = stats.appended;
    requestReset("no new frames");
  }
}, 1_000);
video.addEventListener("resize", reportAspect);

// Dewarped layouts keep their chosen shape (16:9 by default, 0x0 = any shape) whatever the
// fisheye's own; otherwise follow the video.
function reportAspect() {
  const pref = dewarper.preferredAspect();
  let size = null;
  if (pref === 0) size = { width: 0, height: 0 };
  else if (pref) size = { width: Math.round(pref * 1000), height: 1000 };
  else if (video.videoWidth && video.videoHeight) size = { width: video.videoWidth, height: video.videoHeight };
  if (!size) return;
  const key = `${size.width}x${size.height}`;
  if (key === lastAspect) return;
  lastAspect = key;
  panes.send("cam:aspect", size);
}
// Coming back from being covered or a sleeping display can leave us far behind.
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepLive(); });

// ---------------------------------------------------------------------------------------------
// Messages from the main process

panes.on("cam:init", ({ codec, data, reset }) => {
  if (reset || !sourceBuffer || !mime.includes(codec)) rebuild(codec, data);
  else { queue.push(data); pump(); }
});

panes.on("cam:media", (data) => {
  if (!mediaSource) return; // waiting for an init segment
  queue.push(data);
  if (queue.length > MAX_QUEUE) {
    requestReset("decoder falling behind");
    return;
  }
  pump();
});

panes.on("cam:status", ({ state, text }) => {
  streamState = state;
  if ((state === "live" || state === "error") && codecError) showStatus("error", codecError); // the detailed advice wins
  else if (state === "live" && failedResets >= DECODE_HELP_AFTER) showStatus("error", DECODE_HELP);
  else if (state === "live") hideStatus();
  else showStatus(state, text);
  updateDot();
  updateClock();
});

panes.on("cam:meta", (m) => {
  meta = m;
  document.title = m.title;
  labelText.textContent = m.consoleName ? `${m.title} · ${m.consoleName}` : m.title;
  barTitle.textContent = m.title;
  barConsole.textContent = m.consoleName || "";
  document.body.classList.toggle("no-names", !m.showNames);
  document.body.classList.toggle("locked", !!m.locked);
  btnTop.classList.toggle("active", !!m.onTop);
  fitLabel();
  clockWanted = !!m.clock;
  fitClock();
  // While the panel is open the sliders are the truth; a meta refresh mid-drag mustn't snap them back.
  if (pictureEl.classList.contains("hidden")) {
    picture = { brightness: m.picture?.brightness ?? 1, contrast: m.picture?.contrast ?? 1 };
    applyPicture();
  }
  dewarper.setConfig(m.dewarp);
  dewarper.setInteractive(!m.locked);
  reportAspect();
});

panes.on("cam:command", ({ cmd }) => {
  if (cmd === "calibrate") {
    dewarper.startCalibration(document.getElementById("calib"), document.getElementById("calib-hint"));
  } else if (cmd === "autodetect") {
    notice(dewarper.autoDetect() ? "Image circle detected." : "Couldn't find the image circle - use Adjust image circle instead.", 4_000);
  } else if (cmd === "picture") {
    pictureEl.classList.remove("hidden");
  }
});

// ---------------------------------------------------------------------------------------------
// Adjust picture…: brightness / contrast as a CSS filter on the video and the 360° canvas. It's GPU-
// cheap and cosmetic: it can't bring back shadow detail the camera's encoder already threw away.

function applyPicture() {
  const { brightness: b, contrast: c } = picture;
  const filter = b === 1 && c === 1 ? "" : `brightness(${b}) contrast(${c})`;
  video.style.filter = filter;
  dewarpCanvas.style.filter = filter;
  for (const [k, input] of Object.entries(picInputs)) {
    input.value = String(Math.round(picture[k] * 100));
    document.getElementById(`pic-${k}-val`).textContent = `${input.value}%`;
  }
}

function savePicture(now = false) {
  clearTimeout(pictureSave);
  if (now) panes.send("cam:picture", picture);
  else pictureSave = setTimeout(() => panes.send("cam:picture", picture), 250);
}

for (const [k, input] of Object.entries(picInputs)) {
  input.addEventListener("input", () => {
    picture = { ...picture, [k]: Number(input.value) / 100 };
    applyPicture();
    savePicture();
  });
}
document.getElementById("pic-reset").addEventListener("click", () => {
  picture = { brightness: 1, contrast: 1 };
  applyPicture();
  savePicture(true);
});
const closePicture = () => {
  savePicture(true);
  pictureEl.classList.add("hidden");
};
document.getElementById("pic-done").addEventListener("click", closePicture);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pictureEl.classList.contains("hidden")) closePicture(); });

panes.on("cam:highlight", () => {
  highlightEl.classList.remove("on");
  void highlightEl.offsetWidth; // restart the animation
  highlightEl.classList.add("on");
});

// ---------------------------------------------------------------------------------------------
// UI

const spinner = statusEl.querySelector(".spinner");
let shownStatus = "";
function showStatus(state, text) {
  // A new status gets a fresh ~20 s of spinning (the CSS stops it after that).
  if (`${state}|${text}` !== shownStatus || statusEl.classList.contains("hidden")) {
    shownStatus = `${state}|${text}`;
    spinner.style.animationName = "none";
    void spinner.offsetWidth; // a style flush, so clearing the override starts the animation over
    spinner.style.animationName = "";
  }
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", state === "error" || state === "offline" || state === "paused");
  statusText.textContent = text || "";
}

function hideStatus() {
  statusEl.classList.add("hidden");
}

let noticeTimer = null;
function notice(text, ms) {
  noticeEl.textContent = text;
  noticeEl.classList.remove("hidden");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => noticeEl.classList.add("hidden"), ms);
}

// The full label is measured on every resize and name change: names run from "Dock" to
// "North Parking Level 2 Stairwell · Garage", so a fixed breakpoint would be wrong for most of them.
function fitLabel() {
  labelEl.classList.remove("compact");
  labelEl.classList.toggle("compact", labelEl.scrollWidth > window.innerWidth * LABEL_MAX_SHARE);
}
window.addEventListener("resize", () => { fitLabel(); fitClock(); });

// The PC's clock, set back by how far playback runs behind the newest buffered video. It's PC time,
// not NVR time, so it agrees with recordings only as well as the two clocks do (keep both on NTP).
function clockText() {
  const b = video.buffered;
  const lag = b.length ? Math.max(0, b.end(b.length - 1) - video.currentTime) : 0;
  const d = new Date(Date.now() - lag * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Only over live video: a ticking clock on a frozen or reconnecting picture would claim it's live.
// "Live" alone isn't enough: the library reports a stall only after 5 s, so the clock also needs a
// frame within the last 1.5 s.
let clockFrames = -1;
let clockFrameAt = 0;
function updateClock() {
  const frames = decodedFrames();
  if (frames !== clockFrames) {
    clockFrames = frames;
    clockFrameAt = performance.now();
  }
  const fresh = performance.now() - clockFrameAt < CLOCK_FRESH_MS;
  const show = clockWanted && clockFits && streamState === "live" && !codecError && fresh;
  if (show) clockEl.textContent = clockText();
  clockEl.classList.toggle("hidden", !show);
}

// The text is fixed-width (tabular digits), so its width only needs measuring on resize.
function fitClock() {
  clockEl.textContent = clockText();
  clockEl.classList.remove("hidden");
  clockFits = clockEl.scrollWidth <= window.innerWidth * CLOCK_MAX_SHARE;
  updateClock();
}
setInterval(() => { if (clockWanted) updateClock(); }, 250);

function updateDot() {
  dot.className = "dot";
  if (codecError || failedResets >= DECODE_HELP_AFTER) dot.classList.add("bad");
  else if (streamState === "live") dot.classList.add("live");
  else if (streamState === "error" || streamState === "offline") dot.classList.add("bad");
  else dot.classList.add("warn");
}

document.getElementById("btn-close").addEventListener("click", () => panes.send("cam:close"));
document.getElementById("btn-top").addEventListener("click", () => panes.send("cam:toggle-top"));
document.getElementById("btn-menu").addEventListener("click", () => panes.send("cam:context-menu"));
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  panes.send("cam:context-menu");
});
// In a grid, double-click fills the grid window with this tile (and back), unless a 360° Quad view
// used it to enlarge one of its views.
window.addEventListener("dblclick", (e) => {
  if (document.body.classList.contains("tile") && !e.defaultPrevented) panes.send("cam:enlarge");
});

showStatus("connecting", "Connecting…");
updateDot();
panes.send("cam:ready");
