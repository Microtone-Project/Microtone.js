// The split view area: one pane, two, three or four (items 148, 335).
//
// The editor shows up to four panes, and each carries its own copy of the
// tabs plus its buttons. A single pane can be split in two — the PRIMARY
// split — and then each half can be split in two once more — the SECONDARY
// split, always across the primary one. So two panes are a pair, three are a
// pair with one half divided, and four are a two-by-two grid.
//
// Which WAY the primary split goes is not a setting: it follows the shape of
// the area being split, so the same button gives you columns on a desktop
// and rows on a tablet held upright. The secondary splits go the other way.
//
// The layout as data: the two halves are GROUPS, and pane i lives in group
// `i & 1`, first in it when i < 2 — so the halves are {0, 2} and {1, 3}:
//
//     side by side           stacked
//     ┌─────┬─────┐          ┌─────┬─────┐
//     │  0  │  1  │          │  0  │  2  │
//     ├─────┼─────┤          ├─────┼─────┤
//     │  2  │  3  │          │  1  │  3  │
//     └─────┴─────┘          └─────┴─────┘
//
// The panes open are always one of {0}, {0,1}, {0,1,2}, {0,1,3}, {0,1,2,3}:
// a half is never split while there is no other half, and closing a pane
// moves its neighbours along until that is true again (close()).
//
// The pane records are the only thing that knows a view is on screen; the
// shell (app.js) asks for `views` and builds each pane's views in `stage(i)`.
// Pane 0 is permanent — whatever is closed, a survivor ends up in pane 0 —
// which is what keeps `#tabs` and `#viewStage` meaning "the editor" for the
// rest of the app and for the smoke tests.

import { setIconLabel } from "./icons.js";
import { applyDom, t } from "./i18n.js";

/** Tab order, which is also the F1..F8 order in app.js. */
export const VIEWS = [
  "timeline", "cues", "pattern", "samples", "instruments", "mastering", "project", "files",
  "keymap", "motif", "settings",
];

/** How many panes the view area can hold. */
export const MAX_PANES = 4;

/** At or above this width/height ratio the panes sit side by side; below it
 *  they stack. Slightly over 1 rather than exactly 1: a canvas that is only
 *  just wider than it is tall still has more width to spare than height, and
 *  rows are the axis a tracker grid is always short of. */
const LANDSCAPE_ASPECT = 1.05;
/** .pane-divider's flex-basis — the ratio has to pay for it. */
const DIVIDER = 8;
/** Neither side of a seam can be dragged below this share of its area. */
const MIN_RATIO = 0.15;
/** What a new pane opens on: the first of these not already on screen. */
const NEW_PANE_VIEWS = ["pattern", "timeline", "cues", "files", "instruments", "samples"];

/** The group (half) pane `i` belongs to, and the other pane of that half. */
const groupOf = (i) => i & 1;
const partnerOf = (i) => i ^ 2;

/**
 * The pure part of closing a pane: given which panes are open and which one
 * closes, where every survivor goes. Returns `[from, to]` pairs for each
 * survivor, in ascending `to` — the order the views can be moved in, since a
 * pane is only ever moved INTO after whatever it held has moved out. Survivors
 * that stay put are included as `[i, i]`.
 *
 *   - a half left empty takes the other half's panes: its first becomes the
 *     new first half, and its second (if any) the new second half;
 *   - a half split while the other half is gone becomes the two halves.
 */
export function closeLayout(open, closing) {
  const g = [[0, 2].filter((i) => open.includes(i) && i !== closing),
    [1, 3].filter((i) => open.includes(i) && i !== closing)];
  let [a, b] = g;
  if (a.length === 0) { a = b.slice(0, 1); b = b.slice(1); }
  if (b.length === 0 && a.length === 2) { b = a.slice(1); a = a.slice(0, 1); }
  const moves = [];
  if (a[0] !== undefined) moves.push([a[0], 0]);
  if (b[0] !== undefined) moves.push([b[0], 1]);
  if (a[1] !== undefined) moves.push([a[1], 2]);
  if (b[1] !== undefined) moves.push([b[1], 3]);
  return moves;
}

export class SplitView {
  /**
   * @param host  #splitHost, already holding pane 0 (index.html)
   * @param onChange  fired after any change to which pane shows what, or to
   *                  which pane has the keyboard — with `{ focusOnly: true }`
   *                  when only the keyboard moved, so the shell can leave the
   *                  views as they are (re-showing one that rebuilds its DOM
   *                  on show would take away the field the press focused)
   * @param enabled  (view) => is this view reachable at all right now (no
   *                 document ⇒ everything but the Timeline and the File tab is
   *                 a dead end, item 104.1)
   * @param onAdopt  (from, to, view) => move that view's instance between
   *                 panes; see close()
   * @param onFocus  fired AT ONCE when a press hands a pane the keyboard,
   *                 ahead of the onChange that follows the release; see
   *                 _pressFocus()
   */
  constructor(host, { onChange = () => {}, enabled = () => true, onAdopt = null, onFocus = () => {} } = {}) {
    this.host = host;
    this.onChange = onChange;
    this.onFocus = onFocus;
    this.enabled = enabled;
    this.onAdopt = onAdopt;
    this.ratio = 0.5;          // the first half's share of the primary axis
    this.subRatio = [0.5, 0.5]; // each half's first pane's share of its own
    this.focus = 0;            // which pane the keyboard is talking to
    this.stacked = false;      // ← _applyDirection, from the aspect ratio

    const first = host.querySelector(".pane");
    // The two halves: each a flex box of its panes and the seam between them.
    this.groups = [0, 1].map((g) => {
      const el = document.createElement("div");
      el.className = "pane-group";
      el.dataset.group = String(g);
      return el;
    });
    // The primary seam, between the halves.
    this.divider = this._makeDivider(() => this.ratio = 0.5);
    // …and one inside each half.
    this.subDividers = [0, 1].map((g) => this._makeDivider(() => this.subRatio[g] = 0.5));
    // Side by side until _applyDirection says otherwise, so the halves stack.
    for (const d of this.subDividers) d.classList.add("rows");

    host.prepend(this.groups[0]);
    this.groups[0].append(first);
    host.append(this.divider, this.groups[1]);

    // Panes 1…3 are built here rather than in index.html so that the tab
    // strip is written out exactly once. Their ids count from 2 (#tabs2,
    // #viewStage2 …), as pane 1's always have.
    this.panes = [this._adopt(first, 0, "timeline")];
    for (let i = 1; i < MAX_PANES; i++) {
      const el = document.createElement("section");
      el.className = "pane";
      el.dataset.pane = String(i);
      el.hidden = true;
      const head = first.querySelector(".pane-head").cloneNode(true);
      head.querySelector(".tabs").id = `tabs${i + 1}`;
      const stage = document.createElement("div");
      stage.className = "view-stage";
      const canvases = document.createElement("div");
      canvases.className = "view-canvases";
      canvases.id = `viewStage${i + 1}`;
      stage.append(canvases); // the instrument lookup (item 168) is a singleton;
      // app.js prepends it in here as a flex sibling of `canvases` when it lands
      // in this pane.
      el.append(head, stage);
      this.panes.push(this._adopt(el, i, null));
    }
    // Each half: its first pane, its seam, its second pane.
    this.groups[0].append(this.subDividers[0], this.panes[2].el);
    this.groups[1].append(this.panes[1].el, this.subDividers[1], this.panes[3].el);
    for (const p of this.panes.slice(1)) applyDom(p.head); // the clones' data-i18n labels

    new ResizeObserver(() => this._applyDirection()).observe(host);
    this._applyDirection();
    this.refresh();
  }

  /** A seam with its drag grip; `reset` evens its two sides up again (a
   *  double-click on it). */
  _makeDivider(reset) {
    const el = document.createElement("div");
    el.className = "pane-divider";
    el.hidden = true;
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      drag = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (drag === null) return;
      this._dragTo(el, e);
    });
    const end = () => {
      if (drag === null) return;
      try { el.releasePointerCapture(drag); } catch { /* already gone */ }
      drag = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", () => { reset(); this._layout(); });
    return el;
  }

  /** Wire one pane's element up and return its record. */
  _adopt(el, i, view) {
    const pane = {
      el,
      head: el.querySelector(".pane-head"),
      tabs: el.querySelector(".tabs"),
      btn: el.querySelector(".pane-btn:not(.pane-sub-btn)"),
      subBtn: el.querySelector(".pane-sub-btn"),
      stage: el.querySelector(".view-canvases"),
      view,
      // Follow is the pane's own (item 381): two Timelines, one scrolling
      // with the playhead and one held. The top bar's lamp shows the focused
      // pane's; a new pane starts on.
      follow: true,
    };
    pane.tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (btn && !btn.disabled) this.setView(i, btn.dataset.view);
    });
    pane.btn.addEventListener("click", () => (this.isSplit ? this.close(i) : this.split(i)));
    pane.subBtn.addEventListener("click", () => this.split(i));
    // Clicking anywhere in a pane hands it the keyboard. Capture, so a view
    // that stops the event on the way up still moves the focus.
    el.addEventListener("pointerdown", () => this._pressFocus(i), true);
    return pane;
  }

  // ── what is on screen ──
  get isSplit() { return this.panes[1].view !== null; }
  /** How many panes are open. */
  get count() { return this.panes.filter((p) => p.view !== null).length; }
  /** Every open pane's view, in pane order. Two panes CAN show the same view
   *  (item 148.1) — each holds its own copy of it. */
  get views() { return this.panes.filter((p) => p.view !== null).map((p) => p.view); }
  /** The view the keyboard belongs to. */
  get view() { return this.panes[this.focus].view; }
  /** What pane `i` is showing (null when it is closed). */
  paneView(i) { return this.panes[i].view; }
  /** Whether pane `i` scrolls with the playhead (item 381). */
  paneFollows(i) { return this.panes[i].follow; }
  /** …and the focused pane's, which the top bar's Follow lamp shows and sets. */
  get follow() { return this.panes[this.focus].follow; }
  set follow(on) { this.panes[this.focus].follow = !!on; }
  /** The FIRST pane showing `name`, or -1. */
  paneOf(name) { return this.panes.findIndex((p) => p.view === name); }
  /** Pane `i`'s stage element — where the shell builds that pane's views. */
  stage(i) { return this.panes[i].stage; }
  /** Pane `i`'s OUTER .view-stage — stage(i)'s flex row, the same one the
   *  instrument lookup (item 168) docks into as a sibling of stage(i). */
  dockHost(i) { return this.panes[i].stage.parentElement; }
  /** Pane `i`'s whole .pane section — the flex COLUMN over the tab strip and
   *  the view stage. The keymap strip docks here, below both, so it spans the
   *  grid's full width rather than taking width off its side. */
  paneRoot(i) { return this.panes[i].stage.parentElement.parentElement; }
  /** The open panes in walking order: one half, then the other. */
  get order() { return [0, 2, 1, 3].filter((i) => this.panes[i].view !== null); }

  /** Can pane `i` be split in two? A lone pane always can (the primary
   *  split); once there are two halves, a pane can if its half holds only it
   *  (the secondary split). */
  canSplit(i) {
    if (this.panes[i].view === null) return false;
    if (!this.isSplit) return i === 0;
    return this.panes[partnerOf(i)].view === null;
  }

  setFocus(i) {
    if (this.focus === i || this.panes[i].view === null) return;
    this.focus = i;
    this.refresh();
    this.onChange({ focusOnly: true });
  }

  /** Shift+F8: the keyboard to the next open pane (`dir` -1 for the one
   *  before), walking one half and then the other. */
  focusNext(dir = 1) {
    const order = this.order;
    if (order.length < 2) return;
    const at = order.indexOf(this.focus);
    this.setFocus(order[(at + dir + order.length) % order.length]);
  }

  /** A press in pane `i` hands it the keyboard — but the press is usually
   *  ALSO a click on something in that pane. onChange re-shows the pane's
   *  view (several rebuild their DOM on show) and re-docks the instrument
   *  lookup and the keymap strip into it, which run now would replace or
   *  shift the very element under the pointer, so the release would land
   *  elsewhere and the click would never fire. So the chrome and onFocus
   *  follow at once (the click may ask which view has the keyboard), and
   *  onChange waits until the press is over and its click delivered. */
  _pressFocus(i) {
    if (this.focus === i || this.panes[i].view === null) return;
    this.focus = i;
    this.refresh();
    this.onFocus();
    const done = () => {
      removeEventListener("pointerup", done, true);
      removeEventListener("pointercancel", done, true);
      setTimeout(() => this.onChange({ focusOnly: true }), 0); // the click comes right after the pointerup
    };
    addEventListener("pointerup", done, true);
    addEventListener("pointercancel", done, true);
  }

  /** Put `name` in pane `i` (a tab click). The other panes are left alone
   *  even when one is showing the same view — two Timelines scrolled to
   *  different bars is a thing you are allowed to want (item 148.1). */
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

  /** Split pane `i` in two (the focused one by default): a lone pane into the
   *  two halves, a pane alone in its half into two across it. The new pane
   *  opens on something you are not already looking at — Timeline+Patterns
   *  for the usual case — and takes the keyboard. */
  split(i = this.focus) {
    if (!this.canSplit(i)) return;
    const j = this.isSplit ? i + 2 : 1;
    const open = this.views;
    const cur = this.panes[i].view;
    this.panes[j].view = NEW_PANE_VIEWS.find((v) => !open.includes(v) && this.enabled(v)) ??
      NEW_PANE_VIEWS.find((v) => v !== cur && this.enabled(v)) ?? cur;
    this.panes[j].follow = true;
    if (j === 1) this.ratio = 0.5;
    else this.subRatio[groupOf(j)] = 0.5;
    this.focus = j;
    this.refresh();
    this.onChange();
  }

  /** Close pane `i`; the others close up behind it (closeLayout). A view that
   *  moves pane goes WITH its copy — `onAdopt` is how the shell hands the
   *  actual view over, so a Timeline that moves into pane 0 is the one you
   *  were looking at, scrolled where you left it, not pane 0's idle copy. */
  close(i) {
    if (!this.isSplit || this.panes[i].view === null) return;
    const open = [0, 1, 2, 3].filter((k) => this.panes[k].view !== null);
    const moves = closeLayout(open, i);
    // Where the keyboard goes: with the pane it was in, or — when that is the
    // pane closing — to its neighbour in the same half, else to pane 0.
    const sibling = this.panes[partnerOf(i)].view !== null ? partnerOf(i) : -1;
    const follow = this.focus === i ? sibling : this.focus;
    const views = this.panes.map((p) => p.view);
    const follows = this.panes.map((p) => p.follow); // Follow goes with its pane
    const reshaped = moves.some(([from, to]) => groupOf(from) !== groupOf(to));
    for (const p of this.panes) p.view = null;
    let focus = 0;
    for (const [from, to] of moves) {
      if (from !== to) this.onAdopt?.(from, to, views[from]);
      this.panes[to].view = views[from];
      this.panes[to].follow = follows[from];
      if (from === follow) focus = to;
    }
    // A half that took the other half's place, or became one, is a new seam.
    if (reshaped) { this.ratio = 0.5; this.subRatio = [0.5, 0.5]; }
    this.focus = focus;
    this.refresh();
    this.onChange();
  }

  /** Repaint the chrome: tab states, the split/close buttons, pane visibility
   *  and the flex bases. Safe to call as often as you like. */
  refresh() {
    const split = this.isSplit;
    this.host.classList.toggle("is-split", split);
    this.host.classList.toggle("is-quad", this.count > 2);
    this.groups[1].hidden = !split;
    this.divider.hidden = !split;
    for (const [i, pane] of this.panes.entries()) {
      pane.el.hidden = pane.view === null;
      pane.el.classList.toggle("focused", i === this.focus);
      for (const btn of pane.tabs.children) {
        btn.classList.toggle("active", btn.dataset.view === pane.view);
        btn.disabled = !this.enabled(btn.dataset.view);
      }
      // Only when it changes: refresh() runs on the pointerdown that moves the
      // focus (_pressFocus), and replacing the svg under the pointer means
      // WebKitGTK (Tauri on Linux) never delivers the click — so the close
      // button on the unfocused pane took two presses. Chromium retargets the
      // click to the button and hid this.
      this._icon(pane.btn, split ? "close" : this._splitIcon(false));
      pane.btn.title = t(split ? "pane.closeTitle" : "pane.splitTitle");
      // The second split, across the first: only while this pane has its
      // half to itself.
      const sub = split && this.canSplit(i);
      pane.subBtn.hidden = !sub;
      if (sub) {
        this._icon(pane.subBtn, this._splitIcon(true));
        pane.subBtn.title = t("pane.splitHalfTitle");
      }
    }
    for (const g of [0, 1]) {
      this.subDividers[g].hidden = this.panes[g + 2].view === null;
    }
    this._dropStrayFocus();
    this._layout();
  }

  /** The split icon whose seam runs the way the split would put it: a seam
   *  down the frame for panes side by side, across it for panes stacked. */
  _splitIcon(secondary) {
    return this.stacked !== secondary ? "splitRows" : "split";
  }

  _icon(btn, name) {
    if (btn.dataset.paneIcon === name) return;
    btn.dataset.paneIcon = name;
    setIconLabel(btn, name);
  }

  /** The keyboard is the focused pane's, so DOM focus may not stay behind in
   *  another one: a button, select or checkbox left focused there would take
   *  Enter and Space (and the arrows) from the pane you are working in — the
   *  split button you just pressed in pane 0 closed it again on the next
   *  Space, once the new pane had the keyboard (item 337). */
  _dropStrayFocus() {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    const at = this.panes.findIndex((p) => p.el.contains(el));
    if (at >= 0 && at !== this.focus) el.blur();
  }

  _layout() {
    // The seam is real estate too: each side gives up half of it.
    const basis = (ratio) => `0 0 calc(${(ratio * 100).toFixed(3)}% - ${DIVIDER / 2}px)`;
    this.groups[0].style.flex = this.isSplit ? basis(this.ratio) : "1 1 0";
    this.groups[1].style.flex = "1 1 0";
    for (const g of [0, 1]) {
      const subSplit = this.panes[g + 2].view !== null;
      this.panes[g].el.style.flex = subSplit ? basis(this.subRatio[g]) : "1 1 0";
      this.panes[g + 2].el.style.flex = "1 1 0";
    }
  }

  /** Side by side or stacked, from the shape of the area being split. Measured
   *  on the host, whose box does NOT depend on the direction — so this can
   *  never oscillate. The halves split the other way. */
  _applyDirection() {
    const r = this.host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return; // laid out but not on screen
    const stacked = r.width / r.height < LANDSCAPE_ASPECT;
    if (stacked === this.stacked) return;
    this.stacked = stacked;
    this.host.classList.toggle("stacked", stacked);
    this.divider.classList.toggle("rows", stacked);
    for (const d of this.subDividers) d.classList.toggle("rows", !stacked);
    this.refresh(); // the split icons follow the direction
  }

  // ── the resize grips ──
  /** A drag on seam `el`: the share of its area on the near side of the
   *  pointer. Measured against the box the seam divides, so the UI zoom
   *  cancels (see zoom.js). */
  _dragTo(el, e) {
    const primary = el === this.divider;
    const g = primary ? -1 : this.subDividers.indexOf(el);
    const box = primary ? this.host : this.groups[g];
    const r = box.getBoundingClientRect();
    const rows = el.classList.contains("rows");
    const span = rows ? r.height : r.width;
    if (span <= 0) return;
    const at = rows ? e.clientY - r.top : e.clientX - r.left;
    const ratio = Math.min(Math.max(at / span, MIN_RATIO), 1 - MIN_RATIO);
    if (primary) this.ratio = ratio;
    else this.subRatio[g] = ratio;
    this._layout();
  }
}
