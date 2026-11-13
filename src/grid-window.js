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
 *     tiles: [{ key, channel?, range?, picture?, hideName?, clock?, dewarp?, cycle? } | null] }
 * A tile's channel left out means "match the tile's size" (or Medium with that setting off).
 *
 * A tile with cycle: { seconds, then: [{ key, ...the same settings }] } (from a Protect liveview
 * slot) shows its own camera, then each of `then` in turn. Each camera keeps its own settings, so a
 * player's `tile` is whichever of those records it shows. A switch replaces the tile's page rather
 * than reloading it: a message the old page sent late can't be taken for the new camera's.
 *
 * Make-before-break: a cycle's next camera, and a tile's camera at another quality (Enlarge, a
 * resize, its Quality menu), get a new page that loads under the one on screen. The old page keeps
 * playing until the new one shows its first frame, then the new one takes its place. Before, each
 * of these tore the stream down first, and the tile was black with "Connecting…" for a second or
 * two. Two streams run for that long instead.
 */
export const MAX_CYCLE = 16;
// A new page that hasn't shown a frame by then takes over anyway: a camera that never sends video
// shows its own status, not the camera before it.
export const SWAP_MAX_MS = 10_000;
export const cycleSeconds = (s) => Math.min(3600, Math.max(3, Math.round(Number(s) || 10)));
/** The cameras a tile shows: its own record, then its cycle's. */
export const tileMembers = (t) => (t ? [t, ...(t.cycle?.then ?? [])] : []);
// The page on screen while a new one loads under it: one pixel narrower. A view another one covers
// completely gets no frames at all (measured: its first frame came only once it was uncovered), so
// the new page would never show one. That column shows the new page: black until its video starts.
const uncover = (r) => ({ ...r, width: Math.max(1, r.width - 1) });

export class GridWindow {
  win = null;
  #deps;
  // index -> { view, player, tile (the saved record), step, timer, seconds, next } | null, where
  // next is the page on its way in: { view, player, step, timer } | null
  #tiles = [];
  // A tile enlarged to fill the window (double-click, or "Enlarge this tile"); the others are hidden
  // with their streams paused until it goes back. Not saved: a grid always reopens as a grid.
  #enlarged = null;

  /**
   * @param {object} grid - the saved record (mutated in place by main.js)
   * @param {object} deps - { settings(), save(), fitBounds(b), boundsFrozen(), defaultBounds(), icon, gridPage, gridPreload,
   *   cameraPage, cameraPreload, makePlayer({ gw, index, tile, wc, like, autoChannel }), dropPlayer(player),
   *   refreshMeta(player), log, tilesResized(gw, rects), closed(gw) }
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

  /** `raise` (after an update) also puts the window above other apps' windows, without the focus. */
  open({ raise = false } = {}) {
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
    win.once("ready-to-show", () => {
      if (this.grid.hidden) return;
      win.showInactive();
      if (raise) win.moveTop();
    });
    win.webContents.on("did-finish-load", () => this.#layout());
    const saveBounds = debounce(() => {
      if (!this.isOpen || win.isMinimized() || win.isMaximized() || win.isFullScreen() || d.boundsFrozen?.()) return;
      this.grid.bounds = windowBounds(win);
      d.save();
    }, 250);
    win.on("move", saveBounds);
    win.on("resize", () => { this.#layout(); saveBounds(); });
    // Maximize and full screen change the content size; not every platform sends "resize" for them.
    for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) win.on(ev, () => this.#layout());
    // Windows maximizes a locked window anyway (Win+↑, a title-bar double-click): see undoLockedMaximize() in main.js.
    win.on("maximize", () => { if (d.settings().lockLayout) win.unmaximize(); });
    win.on("minimize", () => {
      this.#settle();
      for (const p of this.players) p.stream.pause();
    });
    win.on("restore", () => {
      this.#layout();
      if (!this.grid.hidden) this.#resumeShown();
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
    const keep = new Map(this.#tiles.filter(Boolean).map((t) => [t.tile, t]));
    const next = this.grid.tiles.slice(0, n).map((tile, index) => {
      if (!tile) return null;
      const t = keep.get(tile);
      if (!t) return this.#make(tile, index);
      keep.delete(tile);
      // Edit grid… took the camera it was showing out of its cycle: start over from its own.
      if (!tileMembers(tile).includes(t.player.tile)) {
        this.#drop(t, true);
        return this.#make(tile, index);
      }
      if (t.next && !tileMembers(tile).includes(t.next.player.tile)) this.#discardNext(t);
      t.player.index = index;
      t.step = tileMembers(tile).indexOf(t.player.tile);
      if (t.next) {
        t.next.player.index = index;
        t.next.step = tileMembers(tile).indexOf(t.next.player.tile);
      }
      this.#arm(t);
      return t;
    });
    for (const t of keep.values()) this.#drop(t, true);
    this.#tiles = next;
    if (this.#enlarged !== null && !this.#tiles[this.#enlarged]) this.#enlarged = null; // its tile went
    this.win.setTitle(this.grid.name);
    this.#layout();
    if (!this.grid.hidden && !this.win.isMinimized()) this.#resumeShown();
  }

  hide() {
    this.#settle();
    for (const p of this.players) p.stream.pause();
    if (this.isOpen) this.win.hide();
  }

  show() {
    if (!this.isOpen) return;
    this.win.showInactive();
    this.win.moveTop();
    if (!this.win.isMinimized()) this.#resumeShown();
  }

  get enlarged() { return this.#enlarged; }

  /** Fill the window with one tile, or (null, or the same tile again) go back to the grid. */
  enlarge(index) {
    const next = index === null || index === this.#enlarged || !this.#tiles[index] ? null : index;
    if (next === this.#enlarged) return;
    this.#enlarged = next;
    this.#settle((i) => !this.#tileShown(i));
    this.#layout();
    if (this.grid.hidden || !this.isOpen || this.win.isMinimized()) return;
    for (const [i, t] of this.#tiles.entries()) if (t && !this.#tileShown(i)) t.player.stream.pause();
    this.#resumeShown();
  }

  tileBounds(index) {
    return this.#tiles[index]?.view.getBounds() ?? null;
  }

  tileShown(index) {
    return !!this.#tiles[index] && this.#tileShown(index);
  }

  #tileShown(index) {
    return this.#enlarged === null || this.#enlarged === index;
  }

  #resumeShown() {
    for (const [i, t] of this.#tiles.entries()) if (t && this.#tileShown(i)) t.player.stream.resume();
  }

  /** On screen: the window open, not hidden or minimized, and the tile not behind an enlarged one. */
  #visible(index) {
    return this.isOpen && !this.grid.hidden && !this.win.isMinimized() && this.#tileShown(index);
  }

  /** The page on its way into a tile, if any. It isn't in `players` until it takes over. */
  upcoming(index) {
    return this.#tiles[index]?.next?.player ?? null;
  }

  /**
   * Restart a tile's stream at another quality: `autoChannel` from its size, or (left out) a
   * channel already set on its record. A tile that's playing gets a new page that takes over at its
   * first frame; otherwise the stream restarts as before (a paused one picks it up on resume).
   */
  restream(index, autoChannel) {
    const t = this.#tiles[index];
    if (!t) return;
    const latest = t.next ?? t;
    const auto = autoChannel === undefined ? latest.player.autoChannel : autoChannel;
    if (this.#visible(index) && t.player.stream.channel !== null) {
      this.#replace(t, latest.player.tile, latest.step, auto);
      return;
    }
    if (t.next) this.#swap(t);
    t.player.autoChannel = auto;
    t.player.stream.restart();
    this.#deps.refreshMeta(t.player);
  }

  /** A page on its way in can take over: it showed its first frame, or its stream gave up (offline, an error). */
  ready(player, why) {
    const t = this.#tiles.find((x) => x?.next?.player === player);
    if (t) this.#swap(t, why);
  }

  /** Load `member` into a new page under the tile's. One still loading gives way to it. */
  #replace(t, member, step, autoChannel) {
    if (t.next) this.#discardNext(t);
    const rect = t.view.getBounds();
    const { view, player } = this.#page(member, this.#tiles.indexOf(t), t.player, { below: t.view, autoChannel });
    view.setBounds(rect);
    t.view.setBounds(uncover(rect));
    t.next = { view, player, step, since: Date.now(), timer: setTimeout(() => this.#swap(t, "timeout"), SWAP_MAX_MS) };
  }

  #swap(t, why = "settled") {
    const next = t.next;
    if (!next) return;
    t.next = null;
    clearTimeout(next.timer);
    const line = `"${this.grid.name}" tile ${next.player.index}: ${next.player.cameraId} took over after ${Date.now() - next.since} ms (${why})`;
    if (why === "timeout") this.#deps.log?.info(`${line}: no frame yet, so it shows its own status`);
    else this.#deps.log?.debug(line);
    const old = { view: t.view, player: t.player };
    Object.assign(t, { view: next.view, player: next.player, step: next.step });
    this.#drop(old, true);
    this.#deps.refreshMeta(t.player); // a menu change made while it loaded went to the old page
  }

  #discardNext(t) {
    const { view, player, timer } = t.next;
    t.next = null;
    clearTimeout(timer);
    t.view.setBounds(view.getBounds()); // the old page's full rect back
    this.#drop({ view, player }, true);
  }

  /** Pages on their way in take over now, in the tiles `which` picks (all by default): before a pause. */
  #settle(which = () => true) {
    for (const [i, t] of this.#tiles.entries()) if (t?.next && which(i)) this.#swap(t);
  }

  #make(tile, index) {
    const t = { tile, step: 0, timer: null, seconds: null, ...this.#page(tile, index) };
    this.#arm(t);
    return t;
  }

  /**
   * A tile page and its player for one of the tile's cameras. `like` is the player it takes over
   * from, `below` the view it goes under until then (make-before-break).
   */
  #page(member, index, like = null, { below = null, autoChannel } = {}) {
    const d = this.#deps;
    const view = new WebContentsView({
      webPreferences: { preload: d.cameraPreload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    view.setBackgroundColor("#000000");
    const at = below ? this.win.contentView.children.indexOf(below) : -1;
    if (at >= 0) this.win.contentView.addChildView(view, at);
    else this.win.contentView.addChildView(view);
    view.webContents.loadFile(d.cameraPage, { query: { tile: "1" } });
    const player = d.makePlayer({ gw: this, index, tile: member, wc: view.webContents, like, autoChannel });
    if (this.grid.hidden || this.win.isMinimized() || !this.#tileShown(index)) player.stream.pause();
    return { view, player };
  }

  /** Start, change or stop a tile's cycle timer to match its record. */
  #arm(t) {
    const seconds = tileMembers(t.tile).length > 1 ? cycleSeconds(t.tile.cycle.seconds) : null;
    if (seconds === t.seconds) return;
    clearInterval(t.timer);
    t.seconds = seconds;
    t.timer = seconds ? setInterval(() => this.#advance(t), seconds * 1000) : null;
  }

  /**
   * A cycling tile's next camera. One nobody can see (hidden, minimized, behind an enlarged tile)
   * waits, and so does one whose last switch is still loading.
   */
  #advance(t) {
    const index = this.#tiles.indexOf(t);
    if (index < 0 || t.next || !this.#visible(index)) return;
    const members = tileMembers(t.tile);
    const step = (t.step + 1) % members.length;
    this.#replace(t, members[step], step, t.player.autoChannel);
  }

  #drop({ view, player, timer, next }, detach) {
    clearInterval(timer);
    if (next) {
      clearTimeout(next.timer);
      this.#drop({ view: next.view, player: next.player }, detach);
    }
    this.#deps.dropPlayer(player);
    if (detach && this.isOpen) this.win.contentView.removeChildView(view);
    // A WebContentsView's page isn't closed with its window; without this its renderer lingers.
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  #layout() {
    if (!this.isOpen) return;
    const [width, height] = this.win.getContentSize();
    const full = { x: 0, y: 0, width, height };
    // Enlarged: that tile gets the whole window and the rest are zero-size (and hidden), so the page
    // draws no empty-tile placeholders and nothing else takes a right-click.
    const rects = this.#enlarged === null
      ? cellRects(this.template, full, 2)
      : this.template.cells.map((_, i) => (i === this.#enlarged ? full : { x: 0, y: 0, width: 0, height: 0 }));
    this.#tiles.forEach((t, i) => {
      if (!t) return;
      t.view.setBounds(t.next ? uncover(rects[i]) : rects[i]);
      t.view.setVisible(this.#tileShown(i));
      t.next?.view.setBounds(rects[i]);
      t.next?.view.setVisible(this.#tileShown(i));
    });
    const page = this.win.webContents;
    if (!page.isDestroyed()) page.send("grid:layout", { rects, filled: rects.map((_, i) => !!this.#tiles[i] || this.#enlarged !== null) });
    this.#deps.tilesResized(this, rects);
  }
}
