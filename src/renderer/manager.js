"use strict";

const consolesEl = document.getElementById("consoles");
const dialog = document.getElementById("console-dialog");
const form = document.getElementById("console-form");
const dialogError = document.getElementById("dialog-error");
const dialogTitle = document.getElementById("dialog-title");

let state = null;
let editingId = null;
let refreshing = false;

const STATE_DOT = {
  connected: "live",
  connecting: "warn",
  reconnecting: "warn",
  idle: "warn",
  error: "bad",
  authfailed: "bad",
};
const STATE_LABEL = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  idle: "Idle",
  error: "Can't reach console",
  authfailed: "Login failed",
};

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

function render() {
  document.getElementById("mock-badge").classList.toggle("hidden", !state.mock);
  const hideBtn = document.getElementById("btn-hide");
  hideBtn.textContent = state.hiddenCount ? "Show cameras" : "Hide cameras";
  hideBtn.title = state.hiddenCount ? "Put the hidden camera windows back where they were" : "Take the camera windows off the screen; Show cameras puts them back";
  hideBtn.disabled = !state.hiddenCount && !state.shownCount;
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = !!state.settings[input.dataset.setting];
  }

  // Preserve focus/scroll across re-renders.
  const focusedKey = document.activeElement?.dataset?.focusKey;
  const scroll = document.querySelector("main").scrollTop;

  consolesEl.replaceChildren(...(state.consoles.length ? state.consoles.map(renderConsole) : [renderEmpty()]));

  if (focusedKey) document.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus();
  document.querySelector("main").scrollTop = scroll;
}

function renderEmpty() {
  return el("div", { class: "panel empty-state" },
    el("h2", {}, "No consoles yet"),
    el("p", {}, "Add each UniFi OS console you want to show cameras from, for example the building NVR and the garage NVR."),
    el("button", { class: "primary", onclick: () => openDialog(null) }, "Add console"),
  );
}

function renderConsole(c) {
  const dotClass = STATE_DOT[c.state] ?? "warn";
  const subtitle = [c.host, c.controllerName && c.controllerName !== c.name ? c.controllerName : null].filter(Boolean).join(" · ");
  const head = el("div", { class: "console-head" },
    el("span", { class: `dot ${dotClass}`, title: STATE_LABEL[c.state] ?? c.state }),
    el("div", { class: "title" }, el("b", {}, c.name), el("span", {}, subtitle)),
    el("div", { class: "buttons" },
      el("button", {
        class: "small", disabled: c.state !== "connected",
        title: "Open a window for every camera on this console",
        onclick: () => panes.invoke("mgr:open-all", c.id).then(refresh),
      }, "Show all"),
      c.hiddenCount
        ? el("button", {
          class: "small",
          title: "Put this console's hidden windows back where they were",
          onclick: () => panes.invoke("mgr:show-cameras", c.id).then(refresh),
        }, "Restore")
        : el("button", {
          class: "small", disabled: !c.shownCount,
          title: "Take this console's camera windows off the screen; Restore puts them back",
          onclick: () => panes.invoke("mgr:hide-cameras", c.id).then(refresh),
        }, "Hide all"),
      el("select", {
        class: "small", "aria-label": `Quality for every camera on ${c.name}`, "data-focus-key": `qa-${c.id}`,
        disabled: c.state !== "connected",
        title: "Set every camera on this console, open or not, to one quality",
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
      el("option", { value: "", selected: true }, "Quality for all…"),
      ...["High", "Medium", "Low"].map((n, id) => el("option", { value: String(id) }, n))),
      el("button", { class: "small", onclick: () => openDialog(c) }, "Edit"),
      el("button", { class: "small", onclick: () => panes.invoke("mgr:reconnect", c.id).then(refresh) }, "Reconnect"),
      el("button", {
        class: "small danger",
        onclick: async () => {
          if (!confirm(`Remove ${c.name}? Its camera windows will close.`)) return;
          await panes.invoke("mgr:remove-console", c.id);
          refresh();
        },
      }, "Remove"),
    ),
  );

  const msg = c.message || (c.state !== "connected" ? STATE_LABEL[c.state] : "");
  const bad = c.state === "error" || c.state === "authfailed";

  const list = el("ul", { class: "cams" },
    c.cameras.length
      ? c.cameras.map((cam) => renderCamera(c, cam))
      : el("li", { class: "empty" }, c.state === "connected" ? "No cameras on this console." : "Cameras appear here once connected."),
  );

  return el("article", { class: "panel" }, head, msg ? el("p", { class: `console-msg${bad ? " bad" : ""}` }, msg) : null, list);
}

function renderCamera(c, cam) {
  const toggleId = `t-${cam.key}`;
  const toggle = el("label", { class: "switch", title: cam.open ? "Hide this camera" : "Show this camera" },
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
      onchange: (e) => panes.invoke("mgr:set-channel", { key: cam.key, channel: Number(e.target.value) }).then(refresh),
    }, cam.channels.map((ch) => el("option", { value: String(ch.id), selected: ch.id === (cam.channel ?? 1) }, ch.label)))
    : el("span");

  const find = el("button", {
    class: "small ghost",
    disabled: !cam.open,
    title: cam.hidden ? "Bring this camera's window back" : "Flash this camera's window",
    onclick: () => panes.invoke("mgr:find-camera", cam.key),
  }, "Find");

  return el("li", {}, toggle, name, channelSelect, find);
}

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
    dialogError.textContent = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
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
document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Move every open camera window back onto the main screen?")) panes.invoke("mgr:reset-positions");
});
document.getElementById("btn-quit").addEventListener("click", () => panes.invoke("mgr:quit"));

panes.onChanged(() => refresh());
// Camera online/offline status isn't pushed; poll lightly while the list is visible.
setInterval(() => {
  // Don't re-render under an open dropdown or dialog.
  if (document.hidden || dialog.open || document.activeElement?.tagName === "SELECT") return;
  refresh();
}, 3_000);
refresh();
