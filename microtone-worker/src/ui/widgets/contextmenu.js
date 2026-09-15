// Icon-cell context menu — the app's right-click menu shape: a palette of
// square cells, each an SVG glyph over its name, rather than a list of text
// rows. Callers pass the items; the widget owns placement and dismissal.
//
// Built on <dialog>.showModal() like widgets/modal.js, for three things that
// come free with it: Escape → `cancel`, focus containment, and app.js's global
// key handler skipping anything inside a dialog (so the piano/transport keys
// stay quiet while the menu is up). The backdrop is transparent — a click on it
// targets the dialog itself, which is the outside-click dismissal.

import { t } from "../i18n.js";

const MARGIN = 6; // keep the menu this far from the viewport edge

/**
 * Show a context menu at viewport coordinates (x, y).
 *
 * `groups` is an array of ROWS, each row an array of
 * [{id, label, icon, title?, disabled?}] — `icon` is inline SVG markup (see
 * icons.js), `title` the hover tooltip. Empty rows are skipped, so a caller can
 * pass a row it may or may not have anything for. Resolves with the chosen
 * item's id, or null when dismissed.
 *
 * The menu always has EXACTLY ONE highlighted cell, and both the arrows and the
 * pointer move that same one — never a ring for the keyboard and a hover for the
 * mouse at the same time. It is the focused cell, so Enter takes it.
 *
 * `opts.keyboard` only records that the menu was opened by the \ key rather
 * than by a pointer (item 190). It changes no behaviour: the arrows work either
 * way, because a menu you could only get out of with the mouse would be no
 * better than the right-click that opened it.
 */
export function showContextMenu(x, y, groups, opts = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "ctxmenu";
    const grid = document.createElement("div");
    grid.className = "ctx-grid";
    const rows = groups.filter((g) => g.length > 0);

    // ── the one highlight ──
    // Every way of moving it — the arrows, Home/End, Tab, the pointer, the
    // initial placement — comes through here, so the menu cannot end up with two
    // lit cells, nor with the lit one out of step with the one Enter would take.
    //
    // A CLASS, set outright, rather than the :focus pseudo-class. :focus is not
    // ours to decide: it stops matching while the window is elsewhere, and its
    // :focus-visible cousin starts matching programmatic focus only once the
    // browser has seen a keyboard interaction — which is exactly what left a
    // ring on every later menu once the \ key had been used, with the pointer
    // lighting a second cell somewhere else. Set here rather than on a focusin
    // listener for the same reason: a .focus() in a document that does not hold
    // the focus sets activeElement without ever firing the event.
    const highlight = (cell) => {
      if (!cell) return;
      for (const lit of grid.querySelectorAll(".ctx-cell.here")) lit.classList.remove("here");
      cell.classList.add("here");
      cell.focus(); // …and Enter/Space take the cell the highlight is on
    };

    const finish = (result) => {
      if (!dlg.isConnected) return;
      dlg.close();
      dlg.remove();
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("resize", onScroll);
      resolve(result);
    };
    const onScroll = () => finish(null);

    for (const items of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "ctx-row";
      for (const item of items) {
        const cell = document.createElement("button");
        cell.className = "ctx-cell";
        cell.type = "button";
        cell.dataset.id = item.id; // how tests (and any caller) find a cell
        cell.disabled = item.disabled === true;
        if (item.title) cell.title = item.title;
        const art = document.createElement("span");
        art.className = "ctx-icon";
        art.innerHTML = item.icon ?? "";
        const name = document.createElement("span");
        name.className = "ctx-name";
        name.textContent = item.label;
        cell.append(art, name);
        cell.addEventListener("click", () => finish(item.id));
        // The pointer moves the SAME highlight the arrows move, rather than
        // lighting a second cell of its own. pointerenter, not mouseover: it
        // fires for a finger and a pen too, and it does not bubble, so each
        // cell answers only for itself.
        cell.addEventListener("pointerenter", () => highlight(cell));
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    }
    if (rows.length === 0) {
      const none = document.createElement("div");
      none.className = "ctx-empty";
      none.textContent = t("ctx.empty");
      grid.appendChild(none);
    }
    dlg.appendChild(grid);
    document.body.appendChild(dlg);

    // A modal dialog's backdrop covers the viewport and delivers its events to
    // the dialog, so "did the pointer land outside the menu box" is a straight
    // rect test — and unlike `e.target === dlg` it doesn't treat the menu's own
    // padding as outside.
    dlg.addEventListener("pointerdown", (e) => {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right ||
          e.clientY < r.top || e.clientY > r.bottom) finish(null);
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep the piano/transport keys out of the menu
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Every cell of every row, in reading order. ←/→, Tab and Home/End walk
      // THAT; ↑/↓ walk the rows, which is the other thing the grid shape leads
      // you to press.
      const cells = [...grid.querySelectorAll(".ctx-cell:not(:disabled)")];
      if (cells.length === 0) return;
      const here = cells.findIndex((c) => c.classList.contains("here"));
      const go = (i) => { e.preventDefault(); highlight(cells[i]); };
      const step = (d) => go((here + d + cells.length) % cells.length);
      switch (e.key) {
        case "ArrowRight": return step(1);
        case "ArrowLeft": return step(-1);
        // Tab is the same walk. The dialog contains it either way, so claiming
        // it is only about keeping the highlight and the focus together — a Tab
        // that moved one without the other is how they come apart.
        case "Tab": return step(e.shiftKey ? -1 : 1);
        case "Home": return go(0);
        case "End": return go(cells.length - 1);
        case "ArrowUp": case "ArrowDown": return go(rowStep(cells, here, e.key === "ArrowDown" ? 1 : -1));
        default: return;
      }
    });
    window.addEventListener("wheel", onScroll, true);
    window.addEventListener("resize", onScroll);

    dlg.showModal();
    if (opts.keyboard) dlg.dataset.keyboard = "1"; // provenance, for the tests to read
    // Place it only once it has been laid out, so the flip is measured against
    // the real box: prefer down-right of the pointer, flip at the edges.
    const box = dlg.getBoundingClientRect();
    const maxX = window.innerWidth - box.width - MARGIN;
    const maxY = window.innerHeight - box.height - MARGIN;
    dlg.style.left = `${Math.max(MARGIN, Math.min(x, maxX))}px`;
    dlg.style.top = `${Math.max(MARGIN, Math.min(y, maxY))}px`;
    // Where the one highlight starts. Normally the first cell — the menu is
    // anchored by its top-left CORNER, so (x, y) is its padding and not a cell.
    // But near a viewport edge the box flips back over the pointer, and then
    // the cell it landed on is the one the pointer is already aiming at; no
    // pointerenter fires for a pointer that never moved, so it is read off the
    // point instead.
    const under = document.elementFromPoint(x, y)?.closest?.(".ctx-cell:not(:disabled)");
    highlight(dlg.contains(under) ? under : grid.querySelector(".ctx-cell:not(:disabled)"));
  });
}

/**
 * The cell one row up or down from `cells[here]`, staying as close as the rows
 * allow to the column it is in.
 *
 * Rows differ in length — the clipboard row is four cells wide and the column
 * tools can be one — so "the same column" has to mean the nearest one that
 * exists rather than an index that may not. Walking off either end wraps, the
 * way ←/→ do, so no key in the menu is ever a dead end.
 */
function rowStep(cells, here, dir) {
  if (here < 0) return dir > 0 ? 0 : cells.length - 1;
  const rows = [];
  for (const cell of cells) {
    const row = cell.parentElement;
    if (rows[rows.length - 1]?.row !== row) rows.push({ row, cells: [] });
    rows[rows.length - 1].cells.push(cell);
  }
  const ri = rows.findIndex((r) => r.cells.includes(cells[here]));
  const col = rows[ri].cells.indexOf(cells[here]);
  const next = rows[(ri + dir + rows.length) % rows.length];
  return cells.indexOf(next.cells[Math.min(col, next.cells.length - 1)]);
}
