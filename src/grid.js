/*
 * Screen layouts for camera windows: Arrange, the layout editor and the Protect liveview import all
 * place windows with these. Pure functions, no Electron, so test/run.mjs can check the geometry.
 *
 * A template is a cols x rows grid and a list of cells [col, row, colSpan, rowSpan], biggest tile
 * first, then reading order. Cells are stretched to the target screen's work area (its real pixel
 * size and shape), and each camera is fitted inside its cell at its own video shape.
 */

const grid = (cols, rows) => {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([c, r, 1, 1]);
  return { cols, rows, cells };
};
const ring = (n, inner) => {
  // n x n grid with one big tile [c, r, span, span]; the small tiles fill the rest in reading order.
  const [bc, br, span] = inner;
  const cells = [[bc, br, span, span]];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (c >= bc && c < bc + span && r >= br && r < br + span) continue;
      cells.push([c, r, 1, 1]);
    }
  }
  return { cols: n, rows: n, cells };
};

export const TEMPLATES = [
  { id: "auto", label: "Auto (best fit)" },
  { id: "1", label: "1", ...grid(1, 1) },
  { id: "2x2", label: "2 × 2", ...grid(2, 2) },
  { id: "1+5", label: "1 + 5", ...ring(3, [0, 0, 2]) },
  { id: "1+7", label: "1 + 7", ...ring(4, [0, 0, 3]) },
  { id: "3x3", label: "3 × 3", ...grid(3, 3) },
  { id: "2+8", label: "2 + 8", cols: 4, rows: 4, cells: [[0, 0, 2, 2], [2, 0, 2, 2], ...grid(4, 2).cells.map(([c, r]) => [c, r + 2, 1, 1])] },
  { id: "1+12", label: "1 + 12", ...ring(4, [1, 1, 2]) },
  { id: "4x4", label: "4 × 4", ...grid(4, 4) },
  { id: "5x5", label: "5 × 5", ...grid(5, 5) },
];

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) ?? null;

/**
 * The even grid with the biggest tiles for n cameras of shape `aspect` on this work area. Wide,
 * ultrawide and portrait screens get different answers.
 */
export function autoGrid(n, area, aspect = 16 / 9) {
  let best = grid(1, Math.max(1, n));
  let bestW = 0;
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min(area.width / cols, (area.height / rows) * aspect);
    if (w > bestW + 0.5) { bestW = w; best = grid(cols, rows); }
  }
  return { ...best, cells: best.cells.slice(0, Math.max(1, n)) };
}

/** Pixel rectangles of a template's cells on a work area, `gap` px between tiles. */
export function cellRects(tpl, area, gap = 2) {
  const cw = area.width / tpl.cols;
  const ch = area.height / tpl.rows;
  return tpl.cells.map(([c, r, cs = 1, rs = 1]) => {
    const x = Math.round(area.x + c * cw + gap / 2);
    const y = Math.round(area.y + r * ch + gap / 2);
    return { x, y, width: Math.round(cs * cw - gap), height: Math.round(rs * ch - gap) };
  });
}

/** The largest rectangle of `aspect` (width/height) inside `rect`, centered. */
export function fitAspect(rect, aspect) {
  if (!(aspect > 0)) return { ...rect };
  let width = rect.width;
  let height = Math.round(width / aspect);
  if (height > rect.height) { height = rect.height; width = Math.round(height * aspect); }
  return { x: rect.x + Math.floor((rect.width - width) / 2), y: rect.y + Math.floor((rect.height - height) / 2), width, height };
}

/**
 * Stream quality for a tile: the lowest channel that still has about as many pixels as the tile
 * shows. Protect channel ids: 0 High (~1080p+), 1 Medium (~720p), 2 Low (~360p).
 */
export function channelForTile(widthPx) {
  if (widthPx <= 700) return 2;
  if (widthPx <= 1400) return 1;
  return 0;
}

/**
 * Sort rectangles into reading order: rows by top edge, left to right within a row. Top edges, not
 * centers: after a "1 + 5" the big top-left tile's center sits lower than the small tile beside
 * it, and re-arranging must still treat the big one as first.
 */
export function readingOrder(items, rectOf) {
  const withC = items.map((it) => {
    const b = rectOf(it);
    return { it, x: b.x, y: b.y, h: b.height };
  }).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const w of withC) {
    const row = rows.at(-1);
    if (row && Math.abs(w.y - row[0].y) < Math.min(w.h, row[0].h) / 2) row.push(w);
    else rows.push([w]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x).map((w) => w.it));
}
