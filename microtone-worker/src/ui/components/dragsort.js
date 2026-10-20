// A drag handle that reorders sibling rows in place — the metainstrument layer
// table, the FM operator rack and the algorithm's word list.
//
// Pointer events rather than HTML5 drag-and-drop: `dragstart` never fires from
// a touchscreen, and these tables are edited on tablets as much as on a mouse.
// The row itself moves under the pointer, so the list IS the preview, and the
// reorder is committed ONCE on release — one undo step however many rows the
// drag crossed, where the old ▲ ▼ buttons were one step per row. Every list
// this serves re-renders after that commit, so the DOM a drag leaves behind is
// thrown away rather than trusted.
//
// The pointer stream is read from the WINDOW, and the drag in flight is kept
// module-wide rather than per-grip. Both are the same lesson: moving the row is
// a DOM re-insertion, which drops the pointer capture the grip was holding
// (and the implicit capture a touch gets), so from the second move onwards the
// events go to whatever now sits under the cursor. Captured on the grip, a drag
// therefore moved exactly one row, never saw its own pointerup, and left itself
// armed for the next grab.
//
// The grip is a real focusable button and ↑ ↓ move the row while it has the
// focus, so nothing that was reachable with the arrow buttons is lost with the
// pointer put down.

import { setIconLabel } from "../icons.js";

const EDGE = 32;      // px from a scroller's edge where a drag starts scrolling it
const EDGE_STEP = 14; // px per frame it scrolls there

/** The drag in flight: at most one, whichever grip started it. */
let active = null;

/** The nearest ancestor that actually scrolls vertically (else none). */
function scrollerOf(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

/** The rows `row` sits among, in document order. */
function siblings(row, rowSel) {
  return [...(row.parentElement?.children ?? [])].filter((r) => r.matches(rowSel));
}

/** Put the dragged row where clientY `y` says it belongs. */
function place(y) {
  const { row, rowSel } = active;
  const before = siblings(row, rowSel).find((r) => {
    if (r === row) return false;
    const b = r.getBoundingClientRect();
    return y < b.top + b.height / 2;
  });
  // Re-inserting a node that is already in place is a DOM no-op that still
  // detaches it — which would blink the row and drop the focus — so only move
  // it when the insertion point actually differs.
  const at = before ?? null;
  if (row.nextElementSibling !== at) row.parentElement.insertBefore(row, at);
}

/** Scroll the list while the pointer sits near its edge, so a drag can reach
 *  rows that are off screen. A frame loop rather than a pointermove step: at
 *  the edge the pointer is usually still. */
function autoScroll() {
  if (!active) return;
  const { scroller, y } = active;
  if (scroller && y !== null) {
    const r = scroller.getBoundingClientRect();
    const by = y - r.top < EDGE ? -EDGE_STEP : r.bottom - y < EDGE ? EDGE_STEP : 0;
    if (by) {
      const was = scroller.scrollTop;
      scroller.scrollTop += by;
      if (scroller.scrollTop !== was) place(y);
    }
  }
  active.raf = requestAnimationFrame(autoScroll);
}

/** Finish: commit a real move, or put the row back where it started. */
function endDrag(commit) {
  if (!active) return;
  const { row, rowSel, from, home, onMove, raf } = active;
  cancelAnimationFrame(raf);
  listen(false);
  active = null;
  row.classList.remove("dragging");
  document.body.classList.remove("dragsorting");
  const to = siblings(row, rowSel).indexOf(row);
  if (commit && to >= 0 && to !== from) onMove(from, to, "drag");
  else row.parentElement?.insertBefore(row, home);
}

function onPointerMove(e) {
  if (!active || e.pointerId !== active.id) return;
  // A mouse released outside the window never sends its pointerup; the first
  // move back inside says so, and the row stays where it was last seen rather
  // than snapping back under the pointer.
  if (e.pointerType === "mouse" && e.buttons === 0) { endDrag(true); return; }
  active.y = e.clientY;
  place(e.clientY);
}

function onPointerUp(e) {
  if (active && e.pointerId === active.id) endDrag(true);
}

function onPointerCancel(e) {
  if (active && e.pointerId === active.id) endDrag(false);
}

function onKeyDown(e) {
  if (active && e.key === "Escape") { e.preventDefault(); endDrag(false); }
}

/** Listen on the window, in the capture phase, so nothing between the grip and
 *  the document can swallow the rest of the gesture. */
function listen(on) {
  const fn = on
    ? window.addEventListener.bind(window)
    : window.removeEventListener.bind(window);
  fn("pointermove", onPointerMove, true);
  fn("pointerup", onPointerUp, true);
  fn("pointercancel", onPointerCancel, true);
  fn("keydown", onKeyDown, true);
}

/**
 * A grip for the row at `index` of a list `count` long.
 *
 * `onMove(from, to, via)` commits the reorder and is called only when the
 * index really changed — `via` is "drag" or "key", which is how a view knows
 * whether to hand the focus back after its re-render. `rowSel` is what a row
 * of this list looks like (`tr` in a table, `.fm-word` in the flex list).
 */
export function dragGrip({ index, count, rowSel = "tr", title = "", onMove }) {
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "drag-grip";
  grip.title = title;
  grip.setAttribute("aria-label", title);
  grip.dataset.dragIndex = String(index);
  grip.disabled = count < 2;
  setIconLabel(grip, "grip", "");

  grip.addEventListener("pointerdown", (e) => {
    if (active || e.button !== 0 || grip.disabled) return;
    const row = grip.closest(rowSel);
    if (!row?.parentElement) return;
    e.preventDefault();
    active = {
      id: e.pointerId, row, rowSel, onMove, from: index, y: e.clientY,
      home: row.nextElementSibling, scroller: scrollerOf(row), raf: 0,
    };
    row.classList.add("dragging");
    document.body.classList.add("dragsorting");
    listen(true);
    active.raf = requestAnimationFrame(autoScroll);
  });

  // The keyboard half: ↑ ↓ on the focused grip are what the ▲ ▼ buttons were.
  grip.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dir || active || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const to = index + dir;
    if (to >= 0 && to < count) onMove(index, to, "key");
  });

  return grip;
}

/** Hand the focus back to the grip of row `index` after a re-render, so a run
 *  of keyboard moves keeps working on the row that just moved. */
export function focusGrip(root, index) {
  root?.querySelector(`.drag-grip[data-drag-index="${index}"]`)?.focus();
}
