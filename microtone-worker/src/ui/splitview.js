// Two-pane split of the view area (item 148).
//
// The editor shows one pane or two, and each pane carries its own copy of the
// eight tabs plus one button: "split this in two" while there is a single
// pane, "close this pane" once there are two. Which WAY it splits is not a
// setting — it follows the shape of the area being split, so the same button
// gives you columns on a desktop and rows on a tablet held upright.
//
// The pane records are the only thing that knows a view is on screen; the
// shell (app.js) asks for `views` and moves the view hosts into `stage(i)`.
// Pane 0 is permanent — closing EITHER pane leaves its survivor in pane 0 —
// which is what keeps `#tabs` and `#viewStage` meaning "the editor" for the
// rest of the app and for the smoke tests.

import { setIconLabel } from "./icons.js";
import { applyDom, t } from "./i18n.js";

/** Tab order, which is also the F1..F8 order in app.js. */
export const VIEWS = [
  "timeline", "cues", "pattern", "samples", "instruments", "mastering", "project", "files",
];

/** At or above this width/height ratio the panes sit side by side; below it
 *  they stack. Slightly over 1 rather than exactly 1: a canvas that is only
 *  just wider than it is tall still has more width to spare than height, and
 *  rows are the axis a tracker grid is always short of. */
const LANDSCAPE_ASPECT = 1.05;
/** .pane-divider's flex-basis — the ratio has to pay for it. */
const DIVIDER = 8;
/** Neither pane can be dragged below this share of the area. */
const MIN_RATIO = 0.15;

export class SplitView {
  /**
   * @param host  #splitHost, already holding pane 0 (index.html)
   * @param onChange  fired after any change to which pane shows what, or to
   *                  which pane has the keyboard
   * @param enabled  (view) => is this view reachable at all right now (no
   *                 document ⇒ everything but the Timeline and the File tab is
   *                 a dead end, item 104.1)
   * @param onAdopt  (from, to, view) => move that view's instance between
   *                 panes; see close()
   */
  constructor(host, { onChange = () => {}, enabled = () => true, onAdopt = null } = {}) {
    this.host = host;
    this.onChange = onChange;
    this.enabled = enabled;
    this.onAdopt = onAdopt;
    this.ratio = 0.5;      // pane 0's share of the split axis
    this.focus = 0;        // which pane the keyboard is talking to
    this.stacked = false;  // ← _applyDirection, from the aspect ratio

    const first = host.querySelector(".pane");
    this.panes = [this._adopt(first, 0, "timeline")];

    // The seam and the second pane are built here rather than in index.html so
    // that the tab strip is written out exactly once.
    this.divider = document.createElement("div");
    this.divider.className = "pane-divider";
    this.divider.hidden = true;
    host.appendChild(this.divider);

    const second = document.createElement("section");
    second.className = "pane";
    second.dataset.pane = "1";
    second.hidden = true;
    const head = first.querySelector(".pane-head").cloneNode(true);
    head.querySelector(".tabs").id = "tabs2";
    const stage = document.createElement("div");
    stage.className = "view-stage";
    const canvases = document.createElement("div");
    canvases.className = "view-canvases";
    canvases.id = "viewStage2";
    stage.append(canvases); // the instrument lookup (item 168) is a singleton;
    // app.js prepends it in here as a flex sibling of `canvases` when it lands
    // in this pane.
    second.append(head, stage);
    host.appendChild(second);
    applyDom(head); // the clone's data-i18n labels (it is in the document now)
    this.panes.push(this._adopt(second, 1, null));

    this._drag = null;
    this.divider.addEventListener("pointerdown", (e) => this._dragStart(e));
    this.divider.addEventListener("pointermove", (e) => this._dragMove(e));
    for (const ev of ["pointerup", "pointercancel"]) {
      this.divider.addEventListener(ev, () => this._dragEnd());
    }
    // Double-click the seam to even the panes up again.
    this.divider.addEventListener("dblclick", () => { this.ratio = 0.5; this._layout(); });

    new ResizeObserver(() => this._applyDirection()).observe(host);
    this._applyDirection();
    this.refresh();
  }

  /** Wire one pane's element up and return its record. */
  _adopt(el, i, view) {
    const pane = {
      el,
      head: el.querySelector(".pane-head"),
      tabs: el.querySelector(".tabs"),
      btn: el.querySelector(".pane-btn"),
      stage: el.querySelector(".view-canvases"),
      view,
    };
    pane.tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (btn && !btn.disabled) this.setView(i, btn.dataset.view);
    });
    pane.btn.addEventListener("click", () => (this.isSplit ? this.close(i) : this.split()));
    // Clicking anywhere in a pane hands it the keyboard. Capture, so a view
    // that stops the event on the way up still moves the focus.
    el.addEventListener("pointerdown", () => this.setFocus(i), true);
    return pane;
  }

  // ── what is on screen ──
  get isSplit() { return this.panes[1].view !== null; }
  /** Every open pane's view, in pane order. The two CAN be the same view
   *  (item 148.1) — each pane holds its own copy of it. */
  get views() { return this.panes.filter((p) => p.view !== null).map((p) => p.view); }
  /** The view the keyboard belongs to. */
  get view() { return this.panes[this.focus].view; }
  /** What pane `i` is showing (null when it is closed). */
  paneView(i) { return this.panes[i].view; }
  /** The FIRST pane showing `name`, or -1. */
  paneOf(name) { return this.panes.findIndex((p) => p.view === name); }
  /** Pane `i`'s stage element — where the shell builds that pane's views. */
  stage(i) { return this.panes[i].stage; }
  /** Pane `i`'s OUTER .view-stage — stage(i)'s flex row, the same one the
   *  instrument lookup (item 168) docks into as a sibling of stage(i). */
  dockHost(i) { return this.panes[i].stage.parentElement; }

  setFocus(i) {
    if (this.focus === i || this.panes[i].view === null) return;
    this.focus = i;
    this.refresh();
    this.onChange();
  }

  /** Put `name` in pane `i` (a tab click). The other pane is left alone even
   *  when it is showing the same view — two Timelines scrolled to different
   *  bars is a thing you are allowed to want (item 148.1). */
  setView(i, name) {
    this.panes[i].view = name;
    this.focus = i;
    this.refresh();
    this.onChange();
  }

  /** "Go to this view" (F-keys, and the shell's own showView calls): if a pane
   *  already has it, that pane gets the keyboard; otherwise the focused pane
   *  switches to it. Nothing ever moves between panes behind your back, and
   *  nothing opens a second copy of what you can already see. */
  reveal(name) {
    const i = this.paneOf(name);
    if (i >= 0) this.focus = i;
    else this.panes[this.focus].view = name;
    this.refresh();
    this.onChange();
  }

  /** One pane becomes two. The new one opens on something you are not already
   *  looking at — Timeline+Patterns for the usual case. */
  split() {
    if (this.isSplit) return;
    const cur = this.panes[0].view;
    this.panes[1].view = ["pattern", "timeline", "cues", "files"]
      .find((v) => v !== cur && this.enabled(v)) ?? cur;
    this.ratio = 0.5;
    this.focus = 1;
    this.refresh();
    this.onChange();
  }

  /** Close pane `i`; the other pane's view survives, in pane 0. Closing pane 0
   *  therefore moves the survivor across, and `onAdopt` is how the shell hands
   *  over the actual VIEW — otherwise pane 0 would show its own idle copy of
   *  the same tab instead of the one you were just looking at. */
  close(i) {
    if (!this.isSplit) return;
    const keep = this.panes[1 - i].view;
    if (i === 0) this.onAdopt?.(1, 0, keep);
    this.panes[0].view = keep;
    this.panes[1].view = null;
    this.focus = 0;
    this.refresh();
    this.onChange();
  }

  /** Repaint the chrome: tab states, the split/close button, pane visibility
   *  and the flex bases. Safe to call as often as you like. */
  refresh() {
    const split = this.isSplit;
    this.host.classList.toggle("is-split", split);
    this.panes[1].el.hidden = !split;
    this.divider.hidden = !split;
    for (const [i, pane] of this.panes.entries()) {
      pane.el.classList.toggle("focused", i === this.focus);
      for (const btn of pane.tabs.children) {
        btn.classList.toggle("active", btn.dataset.view === pane.view);
        btn.disabled = !this.enabled(btn.dataset.view);
      }
      setIconLabel(pane.btn, split ? "close" : "split");
      pane.btn.title = t(split ? "pane.closeTitle" : "pane.splitTitle");
    }
    this._layout();
  }

  _layout() {
    if (!this.isSplit) {
      this.panes[0].el.style.flex = "1 1 0";
      return;
    }
    // The seam is real estate too: each pane gives up half of it.
    this.panes[0].el.style.flex = `0 0 calc(${(this.ratio * 100).toFixed(3)}% - ${DIVIDER / 2}px)`;
    this.panes[1].el.style.flex = "1 1 0";
  }

  /** Side by side or stacked, from the shape of the area being split. Measured
   *  on the host, whose box does NOT depend on the direction — so this can
   *  never oscillate. */
  _applyDirection() {
    const r = this.host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return; // laid out but not on screen
    const stacked = r.width / r.height < LANDSCAPE_ASPECT;
    if (stacked === this.stacked) return;
    this.stacked = stacked;
    this.host.classList.toggle("stacked", stacked);
  }

  // ── the resize grip ──
  _dragStart(e) {
    this._drag = e.pointerId;
    try { this.divider.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    e.preventDefault();
  }

  _dragMove(e) {
    if (this._drag === null) return;
    const r = this.host.getBoundingClientRect();
    const span = this.stacked ? r.height : r.width;
    if (span <= 0) return;
    const at = this.stacked ? e.clientY - r.top : e.clientX - r.left;
    this.ratio = Math.min(Math.max(at / span, MIN_RATIO), 1 - MIN_RATIO);
    this._layout();
  }

  _dragEnd() {
    if (this._drag === null) return;
    try { this.divider.releasePointerCapture(this._drag); } catch { /* already gone */ }
    this._drag = null;
  }
}
