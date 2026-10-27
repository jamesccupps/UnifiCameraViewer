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

const STATE_DOT = { connected: "live", connecting: "warn", reconnecting: "warn", idle: "warn", error: "bad", authfailed: "bad" };
const STATE_LABEL = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  idle: "Idle",
  error: "Can't reach console",
  authfailed: "Login failed",
};

const rpcError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await panes.invoke("mgr:state");
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
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------------------------------------------------------------------------------------------
// Hover tips: one floating box for every element with data-tip. Shows after a short pause, flips
// above the element near the bottom edge, and re-attaches after the 3 s re-render.

const tip = document.getElementById("tip");
let tipFor = null;
let tipTimer = null;
let pointer = { x: -1, y: -1 };

function placeTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  tip.textContent = text;
  tip.hidden = false;
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
  tip.hidden = true;
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
  const wasShown = !tip.hidden;
  const t = tipTarget(document.elementFromPoint(pointer.x, pointer.y));
  hideTip();
  if (t) {
    tipFor = t;
    if (wasShown) placeTip(t);
    else tipTimer = setTimeout(() => { if (tipFor === t && t.isConnected) placeTip(t); }, 400);
  }
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

  if (focusedKey) document.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus();
  document.querySelector("main").scrollTop = scroll;
  reattachTip();
}

// ---------------------------------------------------------------------------------------------
// Cameras tab

function renderConsoles() {
  const q = filterInput.value.trim().toLowerCase();
  const all = state.consoles.flatMap((c) => c.cameras);
  const open = all.filter((cam) => cam.open).length;
  const matching = q ? all.filter((cam) => matches(cam, q)).length : all.length;
  document.getElementById("cam-count").textContent = q
    ? `${matching} of ${plural(all.length, "camera")}`
    : `${plural(all.length, "camera")} · ${open} open`;
  document.getElementById("btn-arrange-auto").disabled = !state.onScreenCount;
  consolesEl.replaceChildren(...(state.consoles.length ? state.consoles.map((c) => renderConsole(c, q)) : [renderEmpty()]));
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
  const head = el("div", { class: "console-head" },
    el("span", { class: `dot ${dotClass}`, tip: STATE_LABEL[c.state] ?? c.state }),
    el("div", { class: "title" }, el("b", {}, c.name), el("span", {}, subtitle)),
    el("div", { class: "buttons" },
      el("button", {
        class: "small", disabled: !connected,
        tip: `Open a window for every camera on ${c.name}.`,
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
  const bad = c.state === "error" || c.state === "authfailed";
  const cams = q ? c.cameras.filter((cam) => matches(cam, q)) : c.cameras;
  let empty = null;
  if (!c.cameras.length) empty = connected ? "No cameras on this console." : "Cameras appear here once connected.";
  else if (!cams.length) empty = "No matching cameras.";

  const list = el("ul", { class: "cams" }, empty ? el("li", { class: "empty" }, empty) : cams.map((cam) => renderCamera(cam)));
  return el("article", { class: "panel" }, head, msg ? el("p", { class: `console-msg${bad ? " bad" : ""}` }, msg) : null, list);
}

function renderCamera(cam) {
  const toggleId = `t-${cam.key}`;
  const toggle = el("label", { class: "switch", tip: cam.open ? "Close this camera's window. It remembers its place." : "Open a window for this camera." },
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
  else if (cam.hidden) statusText = "hidden";
  else if (cam.open && cam.status?.state && cam.status.state !== "live") statusText = cam.status.text;

  const name = el("div", { class: "cam-name" },
    el("span", { class: `dot ${dot}` }),
    el("b", { title: cam.name }, cam.name),
    el("small", {}, [cam.model, cam.fisheye ? "360°" : null, statusText].filter(Boolean).join(" · ")),
  );

  const channelSelect = cam.channels.length
    ? el("select", {
      "aria-label": `Quality for ${cam.name}`,
      "data-focus-key": `q-${cam.key}`,
      tip: "Stream quality. Medium suits most windows; High (up to 4K) costs the most graphics power.",
      onchange: (e) => panes.invoke("mgr:set-channel", { key: cam.key, channel: Number(e.target.value) }).then(refresh),
    }, cam.channels.map((ch) => el("option", { value: String(ch.id), selected: ch.id === (cam.channel ?? 1) }, ch.label)))
    : el("span");

  const find = el("button", {
    class: "small ghost",
    disabled: !cam.open,
    tip: cam.hidden ? "Bring this camera's hidden window back." : "Flash this camera's window so you can spot it.",
    onclick: () => panes.invoke("mgr:find-camera", cam.key),
  }, "Find");

  return el("li", {}, toggle, name, channelSelect, find);
}

filterInput.addEventListener("input", () => renderConsoles());
filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && filterInput.value) { filterInput.value = ""; renderConsoles(); e.stopPropagation(); }
});

// Close an open "⋯" menu when clicking anywhere else.
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.menu[open]")) if (!d.contains(e.target)) { d.open = false; openMenuFor = null; }
});

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
  box.replaceChildren(...state.templates.map((t) => {
    const cells = t.cells?.length ?? null;
    const fits = cells === null || n <= cells;
    const tipText = cells === null
      ? "Pick the grid with the biggest tiles for the windows on screen, for this screen's size and shape."
      : `Tile up to ${plural(cells, "camera")}${t.cells.length > 1 && t.cells[0][2] > 1 ? ", the first one big" : ""}.${fits ? "" : ` You have ${n} on screen; the last ${n - cells} stay where they are.`}`;
    return el("button", { class: "tpl", disabled: !n, tip: tipText, "data-template": t.id, onclick: () => arrange(t.id) },
      templatePicture(t),
      el("span", {}, t.label),
      el("small", {}, cells === null ? "best fit" : plural(cells, "camera")));
  }));
}

function renderLayouts() {
  layoutList.replaceChildren(...(state.layouts.length
    ? state.layouts.map((l) => el("li", {},
      el("b", { title: l.name }, l.name),
      el("small", {}, plural(l.count, "camera")),
      el("button", {
        class: "small", "data-focus-key": `la-${l.id}`,
        tip: "Open this layout's cameras at their saved places and settings, and close the windows that aren't in it.",
        onclick: () => panes.invoke("mgr:apply-layout", l.id).then(refresh),
      }, "Apply"),
      el("button", {
        class: "small ghost",
        tip: "Delete this saved layout. Open camera windows aren't touched.",
        onclick: async () => {
          if (!confirm(`Delete the layout "${l.name}"? Camera windows aren't affected.`)) return;
          await panes.invoke("mgr:delete-layout", l.id);
          refresh();
        },
      }, "Delete"),
    ))
    : [el("li", { class: "empty" }, "No layouts yet. Arrange the camera windows, then save the arrangement, or import one of Protect's liveviews.")]));

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
  form.password.placeholder = c ? "Leave blank to keep the saved password" : "";
  form.password.required = !c;
  dialogError.textContent = "";
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
document.getElementById("dialog-cancel").addEventListener("click", () => { form.password.value = ""; dialog.close(); });

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

panes.onChanged(() => refresh());
// Camera online/offline status isn't pushed; poll lightly while the list is visible.
setInterval(() => {
  // Don't re-render under an open dropdown, menu or dialog.
  if (document.hidden || dialog.open || layoutDialog.open || openMenuFor || document.activeElement?.tagName === "SELECT") return;
  refresh();
}, 3_000);
refresh();
