const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED = new Set([
  "mgr:state", "mgr:save-console", "mgr:remove-console", "mgr:reconnect", "mgr:trust-cert",
  "mgr:open-camera", "mgr:close-camera", "mgr:find-camera", "mgr:set-channel",
  "mgr:set-setting", "mgr:bring-to-front", "mgr:reset-positions", "mgr:open-all", "mgr:quit",
  "mgr:hide-cameras", "mgr:show-cameras", "mgr:apply-all",
  "mgr:save-layout", "mgr:apply-layout", "mgr:delete-layout", "mgr:liveview-draft",
  "mgr:set-update-source", "mgr:check-update", "mgr:install-update",
  "mgr:close-all", "mgr:arrange", "mgr:open-log-folder", "mgr:export-settings", "mgr:import-settings", "mgr:open-project", "mgr:save-editor-layout",
  "mgr:set-list-hidden", "mgr:preview", "mgr:open-grid", "mgr:close-grid", "mgr:delete-grid", "mgr:raise",
]);

contextBridge.exposeInMainWorld("panes", {
  invoke(channel, arg) {
    if (!ALLOWED.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, arg);
  },
  onChanged(cb) {
    ipcRenderer.on("mgr:changed", () => cb());
  },
});
