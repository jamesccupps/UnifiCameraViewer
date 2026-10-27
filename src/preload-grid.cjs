const { contextBridge, ipcRenderer } = require("electron");

// The grid window's own page sits under the tile views: it only draws the empty tiles and asks for
// the grid's right-click menu.
contextBridge.exposeInMainWorld("panes", {
  onLayout(cb) {
    ipcRenderer.on("grid:layout", (_event, layout) => cb(layout));
  },
  contextMenu(tile) {
    ipcRenderer.send("grid:context-menu", Number.isInteger(tile) ? tile : null);
  },
});
