/*
 * Window bounds that survive being saved and restored.
 *
 * At fractional display scaling (150 % on the owner's PC) Electron rounds a window's edges outward
 * when it converts physical pixels back to DIPs, so getBounds() can read up to 1 DIP wider and taller
 * than the bounds just set, and a window created with constructor bounds reads 2-4 DIP bigger.
 * Saving what getBounds() read made windows grow on every launch: 480 -> 482 -> 485 -> 489 wide,
 * measured over three launches with the aspect lock off.
 *
 * placeWindow() sets bounds and remembers what they read back as. windowBounds() answers with the
 * bounds that were asked for until the window really moves or resizes, so a restore is a fixed point.
 */

const placed = new WeakMap(); // BrowserWindow -> { asked, got }

const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function placeWindow(win, bounds) {
  win.setBounds(bounds);
  const got = win.getBounds();
  placed.set(win, { asked: { ...got, ...bounds }, got });
}

/** The bounds to save (and to compute from): the placed bounds, unless the window has moved since. */
export function windowBounds(win) {
  const now = win.getBounds();
  const p = placed.get(win);
  return p && same(now, p.got) ? { ...p.asked } : now;
}
