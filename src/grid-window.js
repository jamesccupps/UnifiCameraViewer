import { BrowserWindow, WebContentsView } from "electron";
import { cellRects, templateById } from "./grid.js";
import { debounce } from "./util.js";
import { placeWindow, windowBounds } from "./window-bounds.js";

/*
 * Grid windows: one framed window holding several cameras in a layout's tiles, like a Protect
 * liveview. Each tile is a WebContentsView running the ordinary camera page in tile mode, so a tile
 * keeps everything a camera window has (360° dewarp and PTZ, clock, picture, right-click menu) and
 * its own stream. This class owns the window and the tile geometry; main.js owns the players
 * (stream, menus, meta) through `deps`.
 *
 * The saved record, store.data.grids[]:
 *   { id, name, templateId, bounds, open, hidden?, onTop?,
 *     tiles: [{ key, channel?, range?, picture?, hideName?, clock?, dewarp? } | null] }
 * A tile's channel left out means "match the tile's size" (or Medium with that setting off).
 */
export class GridWindow {
  win = null;
  #deps;
  #tiles = []; // index -> { view, player } | null

  /**
   * @param {object} grid - the saved record (mutated in place by main.js)
   * @param {object} deps - { settings(), save(), fitBounds(b), defaultBounds(), icon, gridPage, gridPreload,
   *   cameraPage, cameraPreload, makePlayer({ gw, index, tile, wc }), dropPlayer(player),
   *   tilesResized(gw, rects), closed(gw) }
   */
  constructor(grid, deps) {
    this.grid = grid;
    this.#deps = deps;
  }

  get id() { return this.grid.id; }
  get isOpen() { return !!this.win && !this.win.isDestroyed(); }
  get players() { return this.#tiles.filter(Boolean).map((t) => t.player); }
  // Only templates with fixed cells: "auto" (Arrange's) or an unknown id from a hand-edited config
  // would otherwise crash at startup.
  get template() {
    const t = templateById(this.grid.templateId);
    return t?.cells ? t : templateById("2x2");
  }

  open() {
    if (this.isOpen) return;
    const d = this.#deps;
    const s = d.settings();
    const bounds = d.fitBounds(this.grid.bounds) ?? d.defaultBounds();
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      title: this.grid.name,
      backgroundColor: "#000000",
      icon: d.icon,
      autoHideMenuBar: true,
      minWidth: 320,
      minHeight: 180,
      alwaysOnTop: !!this.grid.onTop,
      skipTaskbar: !!s.hideFromTaskbar,
      movable: !s.lockLayout,
      resizable: !s.lockLayout,
      webPreferences: { preload: d.gridPreload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    placeWindow(win, bounds); // constructor bounds alone come out a few DIP off (window-bounds.js)
    this.win = win;
    win.loadFile(d.gridPage);
    win.on("page-title-updated", (e) => e.preventDefault()); // the window is called what the grid is
    // Like camera windows: never take the focus from whatever the operator is using.
    win.once("ready-to-show", () => { if (!this.grid.hidden) win.showInactive(); });
    win.webContents.on("did-finish-load", () => this.#layout());
    const saveBounds = debounce(() => {
      if (!this.isOpen || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
      this.grid.bounds = windowBounds(win);
      d.save();
    }, 250);
    win.on("move", saveBounds);
    win.on("resize", () => { this.#layout(); saveBounds(); });
    // Maximize and full screen change the content size; not every platform sends "resize" for them.
    for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) win.on(ev, () => this.#layout());
    win.on("minimize", () => { for (const p of this.players) p.stream.pause(); });
    win.on("restore", () => {
      this.#layout();
      if (!this.grid.hidden) for (const p of this.players) p.stream.resume();
    });
    win.on("closed", () => {
      for (const t of this.#tiles) if (t) this.#drop(t, false);
      this.#tiles = [];
      this.win = null;
      d.closed(this);
    });
    this.sync();
  }

  close() {
    if (this.isOpen) this.win.close();
  }

  /** Match the tile views to the record: keeps tiles that are still there, adds and drops the rest. */
  sync() {
    if (!this.isOpen) return;
    const n = this.template.cells.length;
    const keep = new Map(this.#tiles.filter(Boolean).map((t) => [t.player.tile, t]));
    const next = this.grid.tiles.slice(0, n).map((tile, index) => {
      if (!tile) return null;
      const t = keep.get(tile);
      if (!t) return this.#make(tile, index);
      keep.delete(tile);
      t.player.index = index;
      return t;
    });
    for (const t of keep.values()) this.#drop(t, true);
    this.#tiles = next;
    this.win.setTitle(this.grid.name);
    this.#layout();
  }

  hide() {
    for (const p of this.players) p.stream.pause();
    if (this.isOpen) this.win.hide();
  }

  show() {
    if (!this.isOpen) return;
    this.win.showInactive();
    this.win.moveTop();
    if (!this.win.isMinimized()) for (const p of this.players) p.stream.resume();
  }

  tileBounds(index) {
    return this.#tiles[index]?.view.getBounds() ?? null;
  }

  #make(tile, index) {
    const d = this.#deps;
    const view = new WebContentsView({
      webPreferences: { preload: d.cameraPreload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    view.setBackgroundColor("#000000");
    this.win.contentView.addChildView(view);
    view.webContents.loadFile(d.cameraPage, { query: { tile: "1" } });
    const player = d.makePlayer({ gw: this, index, tile, wc: view.webContents });
    if (this.grid.hidden || this.win.isMinimized()) player.stream.pause();
    return { view, player };
  }

  #drop({ view, player }, detach) {
    this.#deps.dropPlayer(player);
    if (detach && this.isOpen) this.win.contentView.removeChildView(view);
    // A WebContentsView's page isn't closed with its window; without this its renderer lingers.
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  #layout() {
    if (!this.isOpen) return;
    const [width, height] = this.win.getContentSize();
    const rects = cellRects(this.template, { x: 0, y: 0, width, height }, 2);
    this.#tiles.forEach((t, i) => { if (t) t.view.setBounds(rects[i]); });
    const page = this.win.webContents;
    if (!page.isDestroyed()) page.send("grid:layout", { rects, filled: rects.map((_, i) => !!this.#tiles[i]) });
    this.#deps.tilesResized(this, rects);
  }
}
