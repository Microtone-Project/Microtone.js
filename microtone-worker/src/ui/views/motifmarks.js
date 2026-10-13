// The Motif editor's marks: everything drawn BEHIND the program's text — the
// selection, and the other places the name at the caret is used. The text the
// person sees is the highlighted <pre>; the textarea over it is transparent,
// selection and all, so these are what make a selection visible at all.
//
// Geometry comes from the <pre> itself: a DOM Range over its text gives the
// boxes the browser laid the characters out in, tabs and fallback glyphs
// included, which arithmetic on a character width would not. The layer shares
// the <pre>'s scroll transform, so a mark is placed once in the <pre>'s own
// coordinates and scrolls with the text.

import { toLayout } from "../zoom.js";

export class CodeMarks {
  /**
   * @param pre    the highlighted <pre>
   * @param layer  an element under it, positioned and transformed as it is
   * @param order  the kinds of mark, bottom first (each gets a layer of its own,
   *               so a selection stays over a highlight whichever moved last)
   */
  constructor(pre, layer, order = []) {
    this.pre = pre;
    this.layer = layer;
    this.nodes = [];   // the <pre>'s text nodes, in order
    this.starts = [];  // …and the source offset each begins at
    this.subs = new Map();
    for (const kind of order) this.sub(kind);
  }

  sub(kind) {
    let el = this.subs.get(kind);
    if (!el) {
      el = document.createElement("div");
      el.className = `motif-marks-${kind}`;
      this.layer.append(el);
      this.subs.set(kind, el);
    }
    return el;
  }

  /** After the <pre> is repainted: where each of its text nodes starts. */
  index() {
    this.nodes = [];
    this.starts = [];
    const walk = document.createTreeWalker(this.pre, NodeFilter.SHOW_TEXT);
    let at = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      this.nodes.push(n);
      this.starts.push(at);
      at += n.data.length;
    }
  }

  /** Source offset → [text node, offset in it]. */
  point(offset) {
    let lo = 0, hi = this.nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    const n = this.nodes[lo];
    return n ? [n, Math.min(n.data.length, offset - this.starts[lo])] : null;
  }

  /** [text node, offset in it] → source offset (null when not in the <pre>). */
  offsetOf(node, off) {
    const k = this.nodes.indexOf(node);
    return k < 0 ? null : this.starts[k] + off;
  }

  /** The boxes [start, end) is laid out in, one per line, in the <pre>'s
   *  own layout pixels. */
  rects(start, end) {
    if (end <= start || !this.nodes.length) return [];
    const a = this.point(start), b = this.point(end);
    if (!a || !b) return [];
    const range = document.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1]);
    const origin = this.pre.getBoundingClientRect();
    const lines = new Map(); // a line's top → its merged box
    for (const r of range.getClientRects()) {
      if (r.width <= 0 && r.height <= 0) continue;
      const top = Math.round(toLayout(r.top - origin.top));
      const box = lines.get(top);
      const left = toLayout(r.left - origin.left), right = toLayout(r.right - origin.left);
      if (box) { box.left = Math.min(box.left, left); box.right = Math.max(box.right, right); }
      else lines.set(top, { top, left, right, height: toLayout(r.height) });
    }
    return [...lines.values()];
  }

  /** Draw marks of one kind (a class on each box), replacing the last ones. */
  set(kind, ranges) {
    const els = [];
    for (const { start, end } of ranges) {
      for (const r of this.rects(start, end)) {
        const e = document.createElement("div");
        e.className = `motif-mark motif-mark-${kind}`;
        e.style.left = `${r.left}px`;
        e.style.top = `${r.top}px`;
        e.style.width = `${Math.max(1, r.right - r.left)}px`;
        e.style.height = `${r.height}px`;
        els.push(e);
      }
    }
    this.sub(kind).replaceChildren(...els);
  }

  clear(kind) { this.set(kind, []); }
}
