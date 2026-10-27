"use strict";

// The page under a grid window's tile views: draws the empty tiles (a camera tile is a view on top)
// and opens the grid's menu on right-click.

const tilesEl = document.getElementById("tiles");
let rects = [];

panes.onLayout((layout) => {
  rects = layout.rects;
  tilesEl.replaceChildren(...layout.rects.flatMap((r, i) => {
    if (layout.filled[i]) return [];
    const node = document.createElement("div");
    node.className = "empty";
    node.textContent = "Empty tile. Right-click to edit the grid.";
    Object.assign(node.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    return [node];
  }));
});

window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const i = rects.findIndex((r) => e.clientX >= r.x && e.clientX < r.x + r.width && e.clientY >= r.y && e.clientY < r.y + r.height);
  panes.contextMenu(i >= 0 ? i : null);
});
