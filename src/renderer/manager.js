"use strict";

/*
 * The camera list: Cameras / Layouts / Settings tabs. Vanilla DOM built with el(); camera and console
 * names only ever go in as text nodes, never innerHTML. State comes from main ("mgr:state") on every
 * mgr:changed and on a light 3 s poll for online/offline status.
 */

const consolesEl = document.getElementById("consoles");
const dialog = document.getElementById("console-dialog");
const form = document.getElementById("console-form");
const dialogError = document.getElementById("dialog-error");
const dialogTitle = document.getElementById("dialog-title");
const layoutDialog = document.getElementById("layout-dialog");
const layoutForm = document.getElementById("layout-form");
const layoutError = document.getElementById("layout-error");
const layoutList = document.getElementById("layout-list");
const importSelect = document.getElementById("import-liveview");
const filterInput = document.getElementById("filter");

let state = null;
let editingId = null;
let refreshing = false;
let openMenuFor = null; // console id whose "⋯" menu is open, kept open across re-renders
const expandedHidden = new Set(); // console ids whose "Hidden from list" section is expanded

const STATE_DOT = { connected: "live", connecting: "warn", reconnecting: "warn", idle: "warn", error: "bad", authfailed: "bad", certchanged: "bad" };
const STATE_LABEL = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  idle: "Idle",
  error: "Can't reach console",
  authfailed: "Login failed",
  certchanged: "Certificate changed",
};

const rpcError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Most 3 s polls find nothing changed; rendering then costs ~7 ms for 50 cameras and changes nothing.
// After a click, though, always render: a toggle whose action changed nothing must snap back.
// (Called as refresh() or .then(refresh) after actions; the poll and mgr:changed pass onlyIfChanged.)
let lastStateJson = "";
async function refresh(opts) {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await panes.invoke("mgr:state");
    const json = JSON.stringify(next);
    if (opts?.onlyIfChanged === true && json === lastStateJson) return;
    lastStateJson = json;
    state = next;
    render();
  } finally {
    refreshing = false;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "tip") node.dataset.tip = v;
    // CSSOM, not a style="" attribute: the page's CSP (style-src 'self') blocks inline style attributes.
    else if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) listen(node, k.slice(2), v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Handlers live in a table on the node, behind one listener per event type, so patch() can hand an
// existing node the newest handlers (whose closures see the newest state) instead of stale ones.
function listen(node, type, fn) {
  node.__on ??= {};
  if (!(type in node.__on)) node.addEventListener(type, dispatch);
  node.__on[type] = fn;
}
function dispatch(e) {
  return this.__on?.[e.type]?.call(this, e);
}

// ---------------------------------------------------------------------------------------------
// Re-rendering by patching. The list is rendered from scratch on every change and every 3 s poll,
// but the fresh tree is patched onto what's on screen instead of replacing it. Replacing it lost a
// click whose mousedown landed on the old node, cleared a text selection, moved the focus, closed an
// open dropdown on any mgr:changed, and re-decoded every thumbnail. Elements are matched by data-key
// where they have one (consoles, camera rows), otherwise by tag in order.

const keyOf = (n) => (n.nodeType === 1 ? n.dataset.key ?? null : null);
// Properties el() sets that aren't (all) reflected in attributes.
const PROPS = { INPUT: ["checked", "value", "disabled"], SELECT: ["disabled"], OPTION: ["selected", "disabled"], BUTTON: ["disabled"], DETAILS: ["open"], TEXTAREA: ["value"] };

function patchChildren(parent, kids) {
  const old = [...parent.childNodes];
  const keyed = new Map(old.filter(keyOf).map((n) => [keyOf(n), n]));
  let loose = old.filter((n) => !keyOf(n));
  const next = kids.map((k) => {
    const key = keyOf(k);
    const match = key ? keyed.get(key) : loose.find((o) => o.nodeName === k.nodeName);
    if (!match || match.nodeName !== k.nodeName) return k;
    if (key) keyed.delete(key);
    else loose = loose.filter((o) => o !== match);
    return patch(match, k);
  });
  next.forEach((n, i) => { if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] ?? null); });
  while (parent.childNodes.length > next.length) parent.lastChild.remove();
}

function patch(a, b) {
  if (a.nodeType === 3) {
    if (a.data !== b.data) a.data = b.data;
    return a;
  }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && name !== "style") a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (name !== "style" && a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.style.cssText !== b.style.cssText) a.style.cssText = b.style.cssText;
  for (const type of Object.keys(b.__on ?? {})) listen(a, type, b.__on[type]);
  for (const type of Object.keys(a.__on ?? {})) if (!(type in (b.__on ?? {}))) a.__on[type] = undefined;
  patchChildren(a, [...b.childNodes]);
  // After the children: a select's value needs its options in place first.
  for (const p of PROPS[a.nodeName] ?? []) if (a[p] !== b[p]) a[p] = b[p];
  if (a.nodeName === "SELECT" && a.value !== b.value) a.value = b.value;
  return a;
}

// ---------------------------------------------------------------------------------------------
// Hover tips: one floating box for every element with data-tip. Shows after a short pause, flips
// above the element near the bottom edge, and re-attaches after the 3 s re-render.

const tip = document.getElementById("tip");
let tipFor = null;
let tipTimer = null;
let pointer = { x: -1, y: -1 };

// A popover, like the preview: a fixed div can't sit above the layout editor's modal dialog (the top
// layer), so no tip ever showed in the editor. Measured from 0,0 each time: at its last spot near the
// right edge it wrapped narrow, and landed off-centre once it widened again.
function placeTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  tip.textContent = text;
  tip.style.left = "0px";
  tip.style.top = "0px";
  if (!tip.matches(":popover-open")) tip.showPopover();
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let top = r.bottom + 8;
  if (top + t.height > window.innerHeight - 6) top = r.top - t.height - 8;
  const left = Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 6));
  tip.style.top = `${Math.max(6, top)}px`;
  tip.style.left = `${left}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipFor = null;
  if (tip.matches(":popover-open")) tip.hidePopover();
}

function tipTarget(node) {
  const t = node?.closest?.("[data-tip]");
  return t && t.dataset.tip ? t : null;
}

document.addEventListener("pointermove", (e) => { pointer = { x: e.clientX, y: e.clientY }; });
document.addEventListener("pointerover", (e) => {
  const t = tipTarget(e.target);
  if (t === tipFor) return;
  hideTip();
  if (!t) return;
  tipFor = t;
  tipTimer = setTimeout(() => { if (tipFor === t && t.isConnected) placeTip(t); }, 400);
});
document.addEventListener("pointerdown", hideTip);
document.addEventListener("scroll", hideTip, true);
window.addEventListener("blur", hideTip);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
document.addEventListener("focusin", (e) => {
  const t = tipTarget(e.target);
  if (!t || !e.target.matches(":focus-visible")) return;
  hideTip();
  tipFor = t;
  placeTip(t);
});
document.addEventListener("focusout", hideTip);

/** After a re-render the hovered element is new; point the visible tip at its replacement. */
function reattachTip() {
  if (!tipFor || tipFor.isConnected) return;
  const wasShown = tip.matches(":popover-open");
  const t = tipTarget(document.elementFromPoint(pointer.x, pointer.y));
  hideTip();
  if (t) {
    tipFor = t;
    if (wasShown) placeTip(t);
    else tipTimer = setTimeout(() => { if (tipFor === t && t.isConnected) placeTip(t); }, 400);
  }
}

// ---------------------------------------------------------------------------------------------
// Camera previews: a still per camera row, fetched only for rows on screen while this list is
// visible and refreshed about once a minute. Hovering one, or a camera in the layout editor, shows
// it bigger. Main caches the pictures (src/previews.js), so the 3 s re-render doesn't re-ask.

const PREVIEW_REFRESH_MS = 60_000;
const PREVIEW_HOVER_MS = 15_000; // hovering asks for a fresher picture than the row keeps
// "No picture" (console still connecting, camera just back online) is asked again sooner. Before a
// console connects, its saved cameras are placeholder rows, and keeping that miss for a minute left
// most rows empty on the real consoles.
const PREVIEW_RETRY_MS = 10_000;
const previewCache = new Map();  // key -> { url, at, fetched }
const previewPending = new Set();
const previewObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && !e.target.hasAttribute("data-offline")) loadPreview(e.target.dataset.previewKey);
});
const pop = document.getElementById("preview-pop");
let popFor = null;
let popTimer = null;

async function loadPreview(key, maxAge = PREVIEW_REFRESH_MS) {
  if (!key || !state?.settings.showPreviews || document.hidden || previewPending.has(key)) return;
  const have = previewCache.get(key);
  if (have && Date.now() - have.fetched < (have.url ? maxAge : Math.min(maxAge, PREVIEW_RETRY_MS))) return;
  previewPending.add(key);
  let p = null;
  try { p = await panes.invoke("mgr:preview", key); } catch { /* shown as no picture */ }
  previewPending.delete(key);
  // A failed refresh keeps the last good picture rather than blanking the row.
  previewCache.set(key, p?.url ? { url: p.url, at: p.at, fetched: Date.now() } : { url: have?.url ?? null, at: have?.at ?? null, fetched: Date.now() });
  for (const node of document.querySelectorAll(`.thumb[data-preview-key="${CSS.escape(key)}"]`)) paintThumb(node);
  if (popFor?.dataset.previewKey === key) paintPop();
}

function thumb(cam) {
  const node = el("div", { class: "thumb", "data-preview-key": cam.key, "data-offline": cam.online ? null : "" });
  paintThumb(node);
  return node;
}

// Loading, "the console gave no picture" and offline each look different (they were all an empty box).
function paintThumb(node) {
  const p = previewCache.get(node.dataset.previewKey);
  if (node.hasAttribute("data-offline")) node.replaceChildren(el("span", {}, "offline"));
  else if (p?.url) { if (node.querySelector("img")?.getAttribute("src") !== p.url) node.replaceChildren(el("img", { src: p.url, alt: "" })); }
  else node.replaceChildren(el("span", {}, p ? "no picture" : "…"));
}

function observePreviews() {
  previewObserver.disconnect();
  for (const node of document.querySelectorAll(".thumb")) previewObserver.observe(node);
}

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 5 ? "just now" : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

function paintPop() {
  if (!popFor) return;
  const key = popFor.dataset.previewKey;
  const cam = cameraByKey().get(key);
  const p = previewCache.get(key);
  const offline = cam && !cam.online;
  const img = pop.querySelector("img");
  img.classList.toggle("hidden", !p?.url || offline);
  if (p?.url && img.getAttribute("src") !== p.url) img.src = p.url;
  const note = offline ? "offline" : p?.url ? `taken ${ago(p.at)}` : previewPending.has(key) ? "loading…" : "no picture";
  pop.querySelector("p").textContent = [cam?.name, note].filter(Boolean).join(" · ");
  // Beside the hovered thing, flipped to its left near the right edge, kept inside the window.
  const r = popFor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = r.right + 10;
  if (left + w > window.innerWidth - 6) left = r.left - w - 10;
  pop.style.left = `${Math.max(6, Math.min(left, window.innerWidth - w - 6))}px`;
  pop.style.top = `${Math.max(6, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 6))}px`;
}

function hidePop() {
  clearTimeout(popTimer);
  popTimer = null;
  popFor = null;
  if (pop.matches(":popover-open")) pop.hidePopover();
}

// A popover, not a positioned div: it has to sit above the layout editor's modal dialog.
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest?.("[data-preview-key]");
  if (t === popFor) return;
  hidePop();
  if (!t || !state?.settings.showPreviews) return;
  popFor = t;
  popTimer = setTimeout(() => {
    if (popFor !== t || !t.isConnected) return;
    pop.showPopover();
    paintPop();
    loadPreview(t.dataset.previewKey, PREVIEW_HOVER_MS);
  }, 300);
});
document.addEventListener("pointerdown", hidePop);
// Camera and grid windows opened from here appear above the list without taking the focus, so the
// list stays the active window underneath them, and on Windows clicking the already-active window
// doesn't bring it forward. Raise it on any click, as clicking a window normally does.
document.addEventListener("pointerdown", () => panes.invoke("mgr:raise"), true);
document.addEventListener("scroll", hidePop, true);
window.addEventListener("blur", hidePop);

/** After a re-render the hovered row is new; keep the preview on its replacement. */
function reattachPop() {
  if (!popFor || popFor.isConnected) return;
  const key = popFor.dataset.previewKey;
  const t = document.elementFromPoint(pointer.x, pointer.y)?.closest?.("[data-preview-key]");
  if (t?.dataset.previewKey !== key) { hidePop(); return; }
  popFor = t;
  if (pop.matches(":popover-open")) paintPop();
}

// ---------------------------------------------------------------------------------------------
// Tabs

for (const btn of document.querySelectorAll("[data-tab]")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}
function showTab(name) {
  for (const btn of document.querySelectorAll("[data-tab]")) btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  for (const panel of document.querySelectorAll(".tab-panel")) panel.classList.toggle("hidden", panel.id !== `tab-${name}`);
  hideTip();
}

// ---------------------------------------------------------------------------------------------
// Render

function render() {
  document.getElementById("mock-badge").classList.toggle("hidden", !state.mock);
  const hideBtn = document.getElementById("btn-hide");
  hideBtn.textContent = state.hiddenCount ? "Show cameras" : "Hide cameras";
  hideBtn.dataset.tip = state.hiddenCount
    ? "Put the hidden camera windows back exactly where they were."
    : "Take every camera window off the screen and pause its video. Show cameras puts them back where they were, even after a restart.";
  hideBtn.disabled = !state.hiddenCount && !state.shownCount;
  for (const input of document.querySelectorAll("[data-setting]")) input.checked = !!state.settings[input.dataset.setting];
  document.getElementById("about-version").textContent = `version ${state.update?.current ?? ""}`;

  const focusedKey = document.activeElement?.dataset?.focusKey;
  const scroll = document.querySelector("main").scrollTop;

  renderConsoles();
  renderArrange();
  renderLayouts();
  renderUpdate();

  // Patching keeps the focused element itself; this is for one that was replaced.
  if (focusedKey && document.activeElement?.dataset?.focusKey !== focusedKey) document.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus();
  document.querySelector("main").scrollTop = scroll;
  reattachTip();
  observePreviews();
  reattachPop();

  // A grid tile's menu asked for "Edit grid…".
  const asked = state.openEditor && state.grids?.find((g) => g.id === state.openEditor);
  if (asked && !editorDialog.open && !dialog.open && !layoutDialog.open) {
    showTab("layouts");
    openEditor(asked, "grid");
  }
}

// ---------------------------------------------------------------------------------------------
// Cameras tab

function renderConsoles() {
  const q = filterInput.value.trim().toLowerCase();
  const all = state.consoles.flatMap((c) => c.cameras);
  const open = all.filter((cam) => cam.open).length;
  const tucked = all.filter((cam) => cam.listHidden).length;
  const matching = q ? all.filter((cam) => matches(cam, q)).length : all.length;
  document.getElementById("cam-count").textContent = q
    ? `${matching} of ${plural(all.length, "camera")}`
    : `${plural(all.length - tucked, "camera")} · ${open} open${tucked ? ` · ${tucked} hidden from list` : ""}`;
  document.getElementById("btn-arrange-auto").disabled = !state.onScreenCount;
  patchChildren(consolesEl, state.consoles.length ? state.consoles.map((c) => renderConsole(c, q)) : [renderEmpty()]);
}

const matches = (cam, q) => `${cam.name} ${cam.model ?? ""}`.toLowerCase().includes(q);

function renderEmpty() {
  return el("div", { class: "panel empty-state" },
    el("h2", {}, "No consoles yet"),
    el("p", {}, "Add each UniFi OS console you want to show cameras from, for example the building NVR and the garage NVR."),
    el("button", { class: "primary", onclick: () => openDialog(null) }, "Add console"),
  );
}

function consoleMenu(c) {
  const close = () => { openMenuFor = null; };
  const details = el("details", {
    class: "menu",
    open: openMenuFor === c.id,
    ontoggle: (e) => { openMenuFor = e.target.open ? c.id : (openMenuFor === c.id ? null : openMenuFor); },
  },
  el("summary", { "aria-label": `More for ${c.name}`, tip: "More: edit the address or login, reconnect, or remove this console." }, "⋯"),
  el("div", { class: "menu-items" },
    el("button", { onclick: () => { close(); openDialog(c); } }, "Edit console…"),
    el("button", { onclick: () => { close(); panes.invoke("mgr:reconnect", c.id).then(refresh); } }, "Reconnect"),
    el("hr"),
    el("button", {
      class: "danger",
      onclick: async () => {
        close();
        if (!confirm(`Remove ${c.name}? Its camera windows will close, and its saved login is deleted.`)) return;
        await panes.invoke("mgr:remove-console", c.id);
        refresh();
      },
    }, "Remove console…"),
  ));
  return details;
}

function renderConsole(c, q) {
  const dotClass = STATE_DOT[c.state] ?? "warn";
  const subtitle = [c.host, c.controllerName && c.controllerName !== c.name ? c.controllerName : null].filter(Boolean).join(" · ");
  const connected = c.state === "connected";
  const tuckedCount = c.cameras.filter((cam) => cam.listHidden).length;
  const head = el("div", { class: "console-head" },
    el("span", { class: `dot ${dotClass}`, tip: STATE_LABEL[c.state] ?? c.state }),
    el("div", { class: "title" }, el("b", {}, c.name), el("span", {}, subtitle)),
    el("div", { class: "buttons" },
      el("button", {
        class: "small", disabled: !connected,
        tip: `Open a window for every camera on ${c.name}${tuckedCount ? `, except the ${tuckedCount} hidden from the list` : ""}.`,
        onclick: () => panes.invoke("mgr:open-all", c.id).then(refresh),
      }, "Show all"),
      el("button", {
        class: "small", disabled: !c.openCount,
        tip: `Close every ${c.name} window. Each camera remembers its place for next time.`,
        onclick: async () => {
          if (!confirm(`Close ${plural(c.openCount, "camera window")} from ${c.name}?`)) return;
          await panes.invoke("mgr:close-all", c.id);
          refresh();
        },
      }, "Close all"),
      c.hiddenCount
        ? el("button", {
          class: "small",
          tip: `Put ${c.name}'s hidden windows back where they were.`,
          onclick: () => panes.invoke("mgr:show-cameras", c.id).then(refresh),
        }, "Restore")
        : el("button", {
          class: "small", disabled: !c.shownCount,
          tip: `Take ${c.name}'s windows off the screen and pause their video. Restore puts them back.`,
          onclick: () => panes.invoke("mgr:hide-cameras", c.id).then(refresh),
        }, "Hide all"),
      el("select", {
        class: "small", "aria-label": `Quality for every camera on ${c.name}`, "data-focus-key": `qa-${c.id}`,
        disabled: !connected,
        tip: `Set every camera on ${c.name}, open or not, to one stream quality.`,
        onchange: async (e) => {
          const channel = Number(e.target.value);
          e.target.value = "";
          if (!Number.isInteger(channel)) return;
          if (channel === 0 && c.shownCount > 6
            && !confirm(`Switch all ${c.cameras.length} cameras on ${c.name} to High? Decoding many High streams at once can overload integrated graphics.`)) return;
          await panes.invoke("mgr:apply-all", { consoleId: c.id, changes: { channel } });
          refresh();
        },
      },
      el("option", { value: "", selected: true }, "Quality…"),
      ...["High", "Medium", "Low"].map((n, id) => el("option", { value: String(id) }, n))),
      consoleMenu(c),
    ),
  );

  const msg = c.message || (connected ? "" : STATE_LABEL[c.state]);
  const bad = c.state === "error" || c.state === "authfailed" || c.state === "certchanged";
  const trust = c.cert?.seen ? el("p", { class: "console-msg" }, el("button", {
    class: "small",
    "data-focus-key": `trust-${c.id}`,
    tip: "Accept the certificate the console presents now. Only do this if you know why it changed.",
    onclick: () => {
      const short = (fp) => (fp ? `${fp.slice(0, 47)}…` : "none");
      const ok = confirm(`${c.name} (${c.host}) now presents a different security certificate.\n\n`
        + `Trusted:  ${short(c.cert.trusted)}\nNow:      ${short(c.cert.seen)}\n\n`
        + "Resetting or updating a console can make a new certificate, and then this is expected. "
        + "If neither happened, something else may be answering at this address: don't trust it, and check the network.\n\n"
        + "Trust the new certificate and connect?");
      if (ok) panes.invoke("mgr:trust-cert", c.id).then(refresh);
    },
  }, "Trust the new certificate…")) : null;
  const cams = q ? c.cameras.filter((cam) => matches(cam, q)) : c.cameras;
  const shown = cams.filter((cam) => !cam.listHidden);
  const tucked = cams.filter((cam) => cam.listHidden);
  let empty = null;
  if (!c.cameras.length) empty = connected ? "No cameras on this console." : "Cameras appear here once connected.";
  else if (!cams.length) empty = "No matching cameras.";

  const list = empty || shown.length
    ? el("ul", { class: `cams${state.settings.showPreviews ? " with-previews" : ""}` }, empty ? el("li", { class: "empty" }, empty) : shown.map((cam) => renderCamera(cam)))
    : null;
  return el("article", { class: "panel", "data-key": c.id }, head, msg ? el("p", { class: `console-msg${bad ? " bad" : ""}` }, msg) : null, trust, list, renderTucked(c, tucked));
}

/** The collapsed "Hidden from list" section at the bottom of a console's card. */
function renderTucked(c, tucked) {
  if (!tucked.length) return null;
  return el("details", {
    class: "tucked",
    open: expandedHidden.has(c.id),
    ontoggle: (e) => { if (e.target.open) expandedHidden.add(c.id); else expandedHidden.delete(c.id); },
  },
  el("summary", { tip: "Cameras you hid from this list. Show all and the layout editor skip them. Expand to put one back." }, `Hidden from list (${tucked.length})`),
  el("ul", { class: "cams" }, tucked.map((cam) => el("li", { "data-key": cam.key },
    el("div", { class: "cam-name" },
      el("span", { class: `dot ${cam.online ? "live" : "bad"}` }),
      el("b", { title: cam.name }, cam.name),
      el("small", {}, [cam.model, cam.fisheye ? "360°" : null, cam.online ? null : cam.stale ? "not available" : "offline"].filter(Boolean).join(" · "))),
    el("button", {
      class: "small",
      "data-focus-key": `unhide-${cam.key}`,
      tip: "Put this camera back in the list.",
      onclick: () => panes.invoke("mgr:set-list-hidden", { key: cam.key, hidden: false }).then(refresh),
    }, "Show in list")))));
}

function renderCamera(cam) {
  const toggleId = `t-${cam.key}`;
  const grids = cam.inGrids ?? [];
  const inGrid = grids.length ? `in grid ${grids.join(", ")}` : "";
  const toggleTip = cam.open ? "Close this camera's window. It remembers its place."
    : grids.length ? `Open a window for this camera. It's already showing in grid ${grids.join(", ")}; a window adds a second stream of it.`
      : "Open a window for this camera.";
  const toggle = el("label", { class: "switch", tip: toggleTip },
    el("input", {
      type: "checkbox",
      id: toggleId,
      checked: cam.open,
      "aria-label": `Show ${cam.name}`,
      "data-focus-key": toggleId,
      onchange: async (e) => {
        await panes.invoke(e.target.checked ? "mgr:open-camera" : "mgr:close-camera", cam.key);
        refresh();
      },
    }),
    el("span"),
  );

  let dot = "bad";
  if (cam.online) dot = cam.open && !cam.hidden && cam.status?.state && cam.status.state !== "live" ? "warn" : "live";
  let statusText = "";
  if (!cam.online) statusText = cam.stale ? "not available" : "offline";
  else if (cam.hidden) statusText = "window hidden";
  else if (cam.open && cam.status?.state && cam.status.state !== "live") statusText = cam.status.text;
  else if (!cam.open && inGrid) statusText = inGrid;

  const name = el("div", { class: "cam-name" },
    el("span", { class: `dot ${dot}` }),
    el("b", { title: cam.name }, cam.name),
    el("small", {}, [cam.model, cam.fisheye ? "360°" : null, statusText].filter(Boolean).join(" · ")),
  );

  // "Medium · 720p", not "Medium · 1280×720": the long form took the name's room on a narrow list.
  // The full sizes are in the tip. Square (360°) streams keep both numbers.
  const shortLabel = (ch) => {
    const name = ch.label.split(" · ")[0];
    if (!ch.height) return name;
    return ch.width === ch.height ? `${name} · ${ch.width}×${ch.height}` : `${name} · ${ch.height}p`;
  };
  const sizes = cam.channels.filter((ch) => ch.width).map((ch) => `${ch.label.split(" · ")[0]} ${ch.width}×${ch.height}`).join(", ");
  const channelSelect = cam.channels.length
    ? el("select", {
      "aria-label": `Quality for ${cam.name}`,
      "data-focus-key": `q-${cam.key}`,
      tip: `Stream quality. Medium suits most windows; High (up to 4K) costs the most graphics power.${sizes ? ` ${sizes}.` : ""}`,
      onchange: (e) => panes.invoke("mgr:set-channel", { key: cam.key, channel: Number(e.target.value) }).then(refresh),
    }, cam.channels.map((ch) => el("option", { value: String(ch.id), selected: ch.id === (cam.channel ?? 1) }, shortLabel(ch))))
    : el("span");

  const find = el("button", {
    class: "small ghost",
    disabled: !cam.open,
    tip: cam.hidden ? "Bring this camera's hidden window back." : "Flash this camera's window so you can spot it.",
    onclick: () => panes.invoke("mgr:find-camera", cam.key),
  }, "Find");

  const hide = el("button", {
    class: "small ghost",
    "data-focus-key": `hide-${cam.key}`,
    tip: `Hide from this list, for a camera nobody uses right now. It moves to "Hidden from list" at the bottom, and Show all skips it.${cam.open ? " Its window closes." : ""}`,
    onclick: () => panes.invoke("mgr:set-list-hidden", { key: cam.key, hidden: true }).then(refresh),
  }, "Hide from list"); // not just "Hide": Hide all and Hide cameras take windows off screen instead

  return el("li", { "data-key": cam.key }, toggle, state.settings.showPreviews ? thumb(cam) : null, name, channelSelect, find, hide);
}

// Rows the filter brings back are new nodes: they need watching for their previews (the poll used to
// do that on its next render, and an unchanged poll no longer renders).
function renderFiltered() {
  renderConsoles();
  observePreviews();
  reattachTip();
}
filterInput.addEventListener("input", renderFiltered);
filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && filterInput.value) { filterInput.value = ""; renderFiltered(); e.stopPropagation(); }
});

// Close an open "⋯" menu when clicking anywhere else, on Esc, or when the list loses focus: an open
// menu also holds off the status re-renders, and one left open used to freeze them.
function closeMenus(except = null) {
  for (const d of document.querySelectorAll("details.menu[open]")) if (!except || !d.contains(except)) { d.open = false; openMenuFor = null; }
}
document.addEventListener("click", (e) => closeMenus(e.target));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenuFor) closeMenus(); });
window.addEventListener("blur", () => closeMenus());

// ---------------------------------------------------------------------------------------------
// Layouts tab: Arrange thumbnails, saved layouts, Protect import

function templatePicture(t) {
  if (!t.cells) return el("div", { class: "tpl-pic auto" }, "Auto");
  const pic = el("div", { class: "tpl-pic" });
  for (const [c, r, cs = 1, rs = 1] of t.cells) {
    pic.append(el("i", {
      style: {
        left: `calc(${(c / t.cols) * 100}% + 1.5px)`,
        top: `calc(${(r / t.rows) * 100}% + 1.5px)`,
        width: `calc(${(cs / t.cols) * 100}% - 3px)`,
        height: `calc(${(rs / t.rows) * 100}% - 3px)`,
      },
    }));
  }
  return pic;
}

async function arrange(templateId) {
  const msg = document.getElementById("arrange-msg");
  try {
    const { arranged, left } = await panes.invoke("mgr:arrange", { templateId });
    msg.textContent = !arranged
      ? "There are no camera windows on screen to arrange."
      : `Arranged ${plural(arranged, "window")}.${left ? ` ${plural(left, "window")} didn't fit and stayed where ${left === 1 ? "it was" : "they were"}.` : ""}`;
  } catch (err) {
    msg.textContent = rpcError(err);
  }
  refresh();
}

function renderArrange() {
  const n = state.onScreenCount;
  const box = document.getElementById("arrange-templates");
  patchChildren(box, state.templates.map((t) => {
    const cells = t.cells?.length ?? null;
    const fits = cells === null || n <= cells;
    const tipText = cells === null
      ? "Pick the grid with the biggest tiles for the windows on screen, for this screen's size and shape."
      : `Tile up to ${plural(cells, "camera")}${t.cells.length > 1 && t.cells[0][2] > 1 ? ", the first one big" : ""}.${fits ? "" : ` You have ${n} on screen; the last ${n - cells} stay where they are.`}`;
    return el("button", { class: "tpl", disabled: !n, tip: tipText, "data-template": t.id, "data-key": t.id, onclick: () => arrange(t.id) },
      templatePicture(t),
      el("span", {}, t.label),
      el("small", {}, cells === null ? "best fit" : plural(cells, "camera")));
  }));
}

function renderGrid(g) {
  return el("li", { class: "grid-row", "data-key": g.id },
    el("b", { title: g.name }, g.name),
    el("small", {}, `grid window · ${plural(g.count, "camera")}${g.hidden ? " · hidden" : ""}`),
    // A grid hidden by Hide cameras is still "open"; it offered only Close, so it couldn't be brought
    // back on its own.
    el("button", {
      class: "small", "data-focus-key": `ga-${g.id}`,
      tip: g.hidden ? "Put this hidden grid window back where it was."
        : g.open ? "Close this grid window. It reopens where it was." : "Open this grid window: all its cameras in one window.",
      onclick: () => panes.invoke(g.open && !g.hidden ? "mgr:close-grid" : "mgr:open-grid", g.id).then(refresh),
    }, g.hidden ? "Show" : g.open ? "Close" : "Open"),
    el("button", { class: "small ghost", tip: "Change this grid's cameras or layout in the layout editor.", onclick: () => openEditor(g, "grid") }, "Edit"),
    el("button", {
      class: "small ghost",
      tip: "Delete this grid window. Its cameras' own windows aren't touched.",
      onclick: async () => {
        if (!confirm(`Delete the grid window "${g.name}"?`)) return;
        await panes.invoke("mgr:delete-grid", g.id);
        refresh();
      },
    }, "Delete"),
  );
}

function renderLayouts() {
  const grids = (state.grids ?? []).map(renderGrid);
  patchChildren(layoutList, (state.layouts.length || grids.length
    ? [...grids, ...state.layouts.map((l) => el("li", { "data-key": l.id },
      el("b", { title: l.name }, l.name),
      el("small", {}, plural(l.count, "camera")),
      el("button", {
        class: "small", "data-focus-key": `la-${l.id}`,
        tip: "Open this layout's cameras at their saved places and settings, and close the windows that aren't in it.",
        onclick: () => panes.invoke("mgr:apply-layout", l.id).then(refresh),
      }, "Apply"),
      l.editor
        ? el("button", { class: "small ghost", tip: "Change this layout's cameras, grid or screen in the layout editor.", onclick: () => openEditor(l) }, "Edit")
        : el("span"),
      el("button", {
        class: "small ghost",
        tip: "Delete this saved layout. Open camera windows aren't touched.",
        onclick: async () => {
          if (!confirm(`Delete the layout "${l.name}"? Camera windows aren't affected.`)) return;
          await panes.invoke("mgr:delete-layout", l.id);
          refresh();
        },
      }, "Delete"),
    ))]
    : [el("li", { class: "empty" }, "No layouts yet. Build one with New layout… (as separate windows or one grid window), save the arrangement on screen, or import one of Protect's liveviews.")]));

  // Protect liveviews, grouped by console. The value is "<consoleId>|<liveviewId>".
  const groups = state.consoles.filter((c) => c.liveviews?.length).map((c) => el("optgroup", { label: c.name },
    c.liveviews.map((lv) => el("option", { value: `${c.id}|${lv.id}` }, `${lv.name} (${plural(lv.count, "camera")})`))));
  if (document.activeElement !== importSelect) {
    importSelect.replaceChildren(el("option", { value: "", selected: true }, "Import a Protect liveview…"), ...groups);
  }
  importSelect.classList.toggle("hidden", !groups.length);
}

importSelect.addEventListener("change", async () => {
  const [consoleId, liveviewId] = importSelect.value.split("|");
  importSelect.value = "";
  if (!consoleId || !liveviewId) return;
  try {
    await panes.invoke("mgr:import-liveview", { consoleId, liveviewId });
  } catch (err) {
    alert(rpcError(err));
  }
  refresh();
});

document.getElementById("btn-save-layout").addEventListener("click", () => {
  layoutForm.name.value = "";
  layoutError.textContent = "";
  layoutDialog.showModal();
  layoutForm.name.focus();
});
document.getElementById("layout-cancel").addEventListener("click", () => layoutDialog.close());
layoutForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  layoutError.textContent = "";
  try {
    await panes.invoke("mgr:save-layout", layoutForm.name.value);
    layoutDialog.close();
    refresh();
  } catch (err) {
    layoutError.textContent = rpcError(err);
  }
});

// ---------------------------------------------------------------------------------------------
// Layout editor: drag cameras from the palette into a template's tiles on a chosen screen. The
// dialog keeps its own model (ed); only ids and choices go to main, which computes the bounds.

const editorDialog = document.getElementById("editor-dialog");
const editorForm = document.getElementById("editor-form");
const editorName = document.getElementById("editor-name");
const editorScreen = document.getElementById("editor-screen");
const editorTemplate = document.getElementById("editor-template");
const editorPreview = document.getElementById("editor-preview");
const editorCameras = document.getElementById("editor-cameras");
const editorFilter = document.getElementById("editor-filter");
const editorError = document.getElementById("editor-error");
const CAMERA_TYPE = "text/x-protect-panes-camera";
const CELL_TYPE = "text/x-protect-panes-cell";
const VIEW_LABELS = [["quad", "Quad (4 views)"], ["single", "Single view"], ["panorama", "Panorama"], ["off", "Fisheye (raw)"]];

let ed = null; // { id, as: "windows" | "grid", displayId, templateId, cells: [{ key, mode } | null] }

const editorAs = document.getElementById("editor-as");
const editorApply = document.getElementById("editor-apply");
const cameraByKey = () => new Map(state.consoles.flatMap((c) => c.cameras.map((cam) => [cam.key, { ...cam, consoleName: c.name }])));
const editorTemplates = () => state.templates.filter((t) => t.cells);

/** A saved layout, or with as = "grid" a saved grid window, or null for a new one. */
function openEditor(layout = null, as = "windows") {
  const screens = state.screens;
  const fallbackScreen = screens.find((s) => s.primary) ?? screens[0];
  const e = layout?.editor;
  ed = {
    id: layout?.id ?? null,
    as,
    displayId: screens.some((s) => s.id === e?.displayId) ? e.displayId : fallbackScreen?.id,
    templateId: e?.templateId ?? "2x2",
    cells: [],
  };
  const tpl = editorTemplates().find((t) => t.id === ed.templateId) ?? editorTemplates()[1];
  ed.templateId = tpl.id;
  ed.cells = Array.from({ length: tpl.cells.length }, (_, i) => e?.cells?.[i] ?? null);
  const kind = as === "grid" ? "grid window" : "layout";
  document.getElementById("editor-title").textContent = layout ? `Edit ${kind}` : "New layout";
  // A saved layout stays a layout and a saved grid stays a grid; only a new one picks.
  editorAs.value = as;
  editorAs.disabled = !!layout;
  showEditorAs();
  editorName.value = layout?.name ?? "";
  editorError.textContent = "";
  editorFilter.value = "";
  editorScreen.replaceChildren(...screens.map((s) => el("option", { value: String(s.id), selected: s.id === ed.displayId }, s.label)));
  editorTemplate.replaceChildren(...editorTemplates().map((t) => el("option", { value: t.id, selected: t.id === ed.templateId }, `${t.label} (${plural(t.cells.length, "camera")})`)));
  hideTip();
  editorDialog.showModal();
  renderEditor();
  editorName.focus();
}

function setTemplate(id) {
  const tpl = editorTemplates().find((t) => t.id === id);
  if (!tpl) return;
  // Keep the placed cameras in order; a smaller layout drops the ones past its last tile.
  const placed = ed.cells.filter(Boolean);
  ed.templateId = id;
  ed.cells = Array.from({ length: tpl.cells.length }, (_, i) => placed[i] ?? null);
  renderEditor();
  const dropped = placed.length - Math.min(placed.length, tpl.cells.length);
  editorError.textContent = dropped ? `${plural(dropped, "camera")} didn't fit in ${tpl.label} and came out of the layout.` : "";
}

function place(index, key, mode = null) {
  const from = ed.cells.findIndex((c) => c?.key === key);
  const was = from >= 0 ? ed.cells[from] : null;
  if (from >= 0) ed.cells[from] = null;
  ed.cells[index] = { key, mode: mode ?? was?.mode ?? "quad" };
  renderEditor();
}

function swap(a, b) {
  [ed.cells[a], ed.cells[b]] = [ed.cells[b], ed.cells[a]];
  renderEditor();
}

function dropTarget(node, index) {
  node.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].some((t) => t === CAMERA_TYPE || t === CELL_TYPE)) return;
    e.preventDefault();
    node.classList.add("over");
  });
  node.addEventListener("dragleave", () => node.classList.remove("over"));
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    node.classList.remove("over");
    const key = e.dataTransfer.getData(CAMERA_TYPE);
    const cell = e.dataTransfer.getData(CELL_TYPE);
    if (cell !== "" && Number(cell) !== index) swap(Number(cell), index);
    else if (key) place(index, key);
  });
}

function renderEditor() {
  const screen = state.screens.find((s) => s.id === ed.displayId) ?? state.screens[0];
  const tpl = editorTemplates().find((t) => t.id === ed.templateId);
  const cams = cameraByKey();
  editorPreview.style.aspectRatio = `${screen.workArea.width} / ${screen.workArea.height}`;
  editorPreview.replaceChildren(...tpl.cells.map(([c, r, cs = 1, rs = 1], i) => {
    const filled = ed.cells[i];
    const cam = filled ? cams.get(filled.key) : null;
    const node = el("div", {
      class: `cell${filled ? " filled" : ""}`,
      "data-cell": String(i),
      draggable: filled ? "true" : null,
      style: {
        left: `calc(${(c / tpl.cols) * 100}% + 2px)`,
        top: `calc(${(r / tpl.rows) * 100}% + 2px)`,
        width: `calc(${(cs / tpl.cols) * 100}% - 4px)`,
        height: `calc(${(rs / tpl.rows) * 100}% - 4px)`,
      },
    },
    el("span", { class: "n" }, String(i + 1)),
    filled
      ? [
        el("b", { title: cam?.name ?? filled.key }, cam?.name ?? "Camera not available"),
        el("small", {}, cam ? cam.consoleName : "removed from its console"),
        cam?.fisheye
          ? el("select", {
            "aria-label": `360° view for ${cam.name}`,
            tip: "How this 360° camera shows in its tile. Quad (four views) is the default.",
            onchange: (e) => { filled.mode = e.target.value; },
          }, VIEW_LABELS.map(([v, label]) => el("option", { value: v, selected: v === (filled.mode ?? "quad") }, label)))
          : null,
        el("button", { type: "button", class: "x", "aria-label": "Remove from this tile", tip: "Take this camera out of the tile.", onclick: () => { ed.cells[i] = null; renderEditor(); } }, "✕"),
      ]
      : el("span", { class: "empty" }, "Drop a camera here"));
    if (filled) node.addEventListener("dragstart", (e) => { e.dataTransfer.setData(CELL_TYPE, String(i)); e.dataTransfer.effectAllowed = "move"; });
    dropTarget(node, i);
    return node;
  }));

  const q = editorFilter.value.trim().toLowerCase();
  const placedKeys = new Set(ed.cells.filter(Boolean).map((c) => c.key));
  editorCameras.replaceChildren(...state.consoles.flatMap((c) => {
    const list = c.cameras.filter((cam) => !cam.listHidden && (!q || matches(cam, q)));
    if (!list.length) return [];
    return [
      el("li", { class: "group" }, c.name),
      ...list.map((cam) => {
        const li = el("li", {
          class: `cam${placedKeys.has(cam.key) ? " placed" : ""}`,
          draggable: "true",
          "data-key": cam.key,
          "data-preview-key": cam.key, // hover shows the camera's picture (the hint text is under the list)
          ondblclick: () => {
            const free = ed.cells.findIndex((x) => !x);
            if (free >= 0) place(free, cam.key);
            else editorError.textContent = "Every tile is taken. Pick a bigger layout or remove a camera first.";
          },
        }, el("span", { class: `dot ${cam.online ? "live" : "bad"}` }), cam.name, cam.fisheye ? el("small", {}, "360°") : null);
        li.addEventListener("dragstart", (e) => { e.dataTransfer.setData(CAMERA_TYPE, cam.key); e.dataTransfer.effectAllowed = "copyMove"; });
        return li;
      }),
    ];
  }));
  document.getElementById("editor-count").textContent = `${placedKeys.size} of ${plural(tpl.cells.length, "tile")} filled`;
}

function showEditorAs() {
  const grid = ed.as === "grid";
  editorApply.textContent = grid ? "Save and open" : "Save and apply";
  editorApply.dataset.tip = grid ? "Save it and open the grid window now." : "Save it and put the cameras on screen this way now.";
  document.getElementById("editor-save").dataset.tip = grid
    ? "Save it to your layouts without opening it. Open it later from the Layouts tab or the tray."
    : "Save it to your layouts without changing what's on screen.";
  editorScreen.dataset.tip = grid
    ? "The monitor the grid window first opens on, filling it. Move or resize it any time."
    : "The monitor this layout fills. Sizes come from that screen's real resolution and shape.";
}

editorAs.addEventListener("change", () => { ed.as = editorAs.value; showEditorAs(); });
editorScreen.addEventListener("change", () => { ed.displayId = Number(editorScreen.value); renderEditor(); });
editorTemplate.addEventListener("change", () => setTemplate(editorTemplate.value));
editorFilter.addEventListener("input", () => renderEditor());
document.getElementById("editor-clear").addEventListener("click", () => { ed.cells = ed.cells.map(() => null); editorError.textContent = ""; renderEditor(); });
document.getElementById("editor-fill").addEventListener("click", () => {
  const scr = state.screens.find((s) => s.id === ed.displayId);
  const keys = scr?.onScreen ?? [];
  ed.cells = ed.cells.map((_, i) => (keys[i] ? { key: keys[i], mode: scr.views?.[keys[i]] ?? "quad" } : null));
  const extra = keys.length - Math.min(keys.length, ed.cells.length);
  editorError.textContent = !keys.length ? "There are no camera windows on that screen."
    : extra ? `${plural(extra, "window")} didn't fit. Pick a bigger layout to include ${extra === 1 ? "it" : "them"}.` : "";
  renderEditor();
});
document.getElementById("editor-cancel").addEventListener("click", () => editorDialog.close());
editorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  editorError.textContent = "";
  try {
    await panes.invoke("mgr:save-editor-layout", {
      id: ed.id,
      as: ed.as,
      name: editorName.value,
      displayId: ed.displayId,
      templateId: ed.templateId,
      cells: ed.cells,
      apply: e.submitter?.value === "apply",
    });
    editorDialog.close();
    refresh();
  } catch (err) {
    editorError.textContent = rpcError(err);
  }
});
document.getElementById("btn-new-layout").addEventListener("click", () => openEditor(null));

// ---------------------------------------------------------------------------------------------
// Settings tab: updates

const updateSource = document.getElementById("update-source");
const updateStatus = document.getElementById("update-status");
const checkBtn = document.getElementById("btn-check-update");
const installBtn = document.getElementById("btn-install-update");
let updateError = "";

function renderUpdate() {
  const u = state.update ?? {};
  if (document.activeElement !== updateSource) updateSource.value = state.settings.updateSource ?? "";
  const busy = u.status === "checking" || u.status === "downloading";
  checkBtn.disabled = busy;
  checkBtn.textContent = u.status === "available" ? `Download ${u.version}` : "Check for updates";
  installBtn.classList.toggle("hidden", u.status !== "ready");
  installBtn.textContent = `Install ${u.version ?? ""} and restart`;
  updateStatus.textContent = updateError || (u.status && u.status !== "idle" ? u.message : `This is version ${u.current}.`);
  updateStatus.classList.toggle("bad", !!updateError || u.status === "error");
}

updateSource.addEventListener("change", async () => {
  updateError = "";
  try { await panes.invoke("mgr:set-update-source", updateSource.value); } catch (err) { updateError = rpcError(err); }
  refresh();
});
checkBtn.addEventListener("click", async () => {
  updateError = "";
  try {
    await panes.invoke("mgr:set-update-source", updateSource.value);
    const pending = panes.invoke("mgr:check-update");
    refresh(); // shows "checking" right away; the result arrives through mgr:changed
    await pending;
  } catch (err) { updateError = rpcError(err); }
  refresh();
});
installBtn.addEventListener("click", async () => {
  updateError = "";
  if (!confirm("Protect Panes will close, install the update and open again. That takes about a minute. Continue?")) return;
  try { await panes.invoke("mgr:install-update"); } catch (err) { updateError = rpcError(err); }
  refresh();
});

// ---------------------------------------------------------------------------------------------
// Add / edit console dialog

function openDialog(c) {
  editingId = c?.id ?? null;
  dialogTitle.textContent = c ? `Edit ${c.name}` : "Add console";
  form.name.value = c?.name ?? "";
  form.host.value = c?.host ?? "";
  form.username.value = c?.username ?? "";
  form.password.value = "";
  form.password.placeholder = c ? "Leave blank to keep the saved password (not if the address changes)" : "";
  form.password.required = !c;
  dialogError.textContent = "";
  checkHost();
  hideTip();
  dialog.showModal();
  (c ? form.password : form.name).focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  dialogError.textContent = "";
  const save = document.getElementById("dialog-save");
  save.disabled = true;
  try {
    await panes.invoke("mgr:save-console", {
      id: editingId,
      name: form.name.value,
      host: form.host.value,
      username: form.username.value,
      password: form.password.value,
    });
    form.password.value = "";
    dialog.close();
    refresh();
  } catch (err) {
    dialogError.textContent = rpcError(err);
  } finally {
    save.disabled = false;
  }
});
document.getElementById("dialog-cancel").addEventListener("click", () => dialog.close());
// However the dialog closes (Cancel, Save, Esc), a typed password doesn't stay in the field.
dialog.addEventListener("close", () => { form.password.value = ""; });

// The library rewrites the livestream address to the configured host, and a "host:port" isn't
// rewritten: the login works, then every camera stays at "Reconnecting…". Say so while typing.
const hostHint = document.getElementById("host-hint");
function checkHost() {
  const h = form.host.value.trim().replace(/^[a-z]+:\/\//i, "").split("/")[0];
  const port = /^\[[^\]]+\]:\d+$/.test(h) || /^[^:\[\]]+:\d+$/.test(h);
  hostHint.textContent = port ? "Leave out the port: with one, the console logs in but live video doesn't play. Use the bare IP address or hostname." : "";
}
form.host.addEventListener("input", checkHost);

// ---------------------------------------------------------------------------------------------
// Global controls

for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("change", () => panes.invoke("mgr:set-setting", { name: input.dataset.setting, value: input.checked }).then(refresh));
}
document.getElementById("btn-add").addEventListener("click", () => openDialog(null));
document.getElementById("btn-hide").addEventListener("click", () => {
  panes.invoke(state?.hiddenCount ? "mgr:show-cameras" : "mgr:hide-cameras", null).then(refresh);
});
document.getElementById("btn-front").addEventListener("click", () => panes.invoke("mgr:bring-to-front"));
document.getElementById("btn-arrange-auto").addEventListener("click", async () => {
  await panes.invoke("mgr:arrange", { templateId: "auto" }).catch(() => {});
  refresh();
});
document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Move every open camera window back onto the main screen?")) panes.invoke("mgr:reset-positions");
});
document.getElementById("btn-project").addEventListener("click", () => panes.invoke("mgr:open-project"));
document.getElementById("btn-logs").addEventListener("click", () => panes.invoke("mgr:open-log-folder"));
document.getElementById("btn-quit").addEventListener("click", () => panes.invoke("mgr:quit"));

// Don't re-render under an open dropdown, menu or dialog. An open dropdown, not a focused one: a
// quality select keeps the focus after it's used, which once stopped the status updates for hours.
const busy = () => dialog.open || layoutDialog.open || editorDialog.open || !!openMenuFor || !!document.querySelector("select:open");
panes.onChanged(() => { if (!busy()) refresh({ onlyIfChanged: true }); }); // else the next poll picks it up
// Camera online/offline status isn't pushed; poll lightly while the list is visible.
setInterval(() => {
  if (document.hidden || busy()) return;
  refresh({ onlyIfChanged: true });
}, 3_000);
refresh();
