const { contextBridge, ipcRenderer } = require("electron");

const IN = new Set(["cam:init", "cam:media", "cam:status", "cam:meta", "cam:highlight", "cam:command"]);
const OUT = new Set(["cam:ready", "cam:aspect", "cam:reset", "cam:unsupported", "cam:enlarge", "cam:context-menu", "cam:toggle-top", "cam:close", "cam:dewarp", "cam:picture"]);

contextBridge.exposeInMainWorld("panes", {
  on(channel, cb) {
    if (!IN.has(channel)) throw new Error(`blocked channel ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => cb(payload));
  },
  send(channel, payload) {
    if (OUT.has(channel)) ipcRenderer.send(channel, payload);
  },
});
