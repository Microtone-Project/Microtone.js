// The keymap strip — the active layout drawn under the Timeline and Patterns
// grids, so you can see what the letter keys play while you are typing notes
// into a song rather than only on the Keymap tab.
//
// It docks at the BOTTOM of whichever pane holds a grid, spanning its width:
// the instrument lookup takes width down the left (item 168) and the master
// strip takes it down the right, but a keyboard is wide and short and belongs
// under the thing it is typing into. Like both of those it is ONE element that
// moves between panes as a whole node, and `hidden` is all a pane it leaves
// needs to hand the space back.
//
// Toggleable, off by default, remembered across sessions — a tracker grid wants
// its rows, and this is a reference you put up while you are learning a layout
// rather than something to leave on for ever.
//
// Keys light up as they sound. It reads the jam keyboard's own held-key map
// once a frame instead of listening for events, so a note lights the strip
// whatever played it — the letter keys, a click on the Keymap tab's board, or
// a pointer on the grid.
//
// Either end of the board carries a +/− pair stacked one above the other:
// transposition on the left, octave on the right. They do what Shift+Alt+←/→
// and Alt+↑/↓ do, for a tablet that has neither — and they sit in the strip's
// own margins, beside a board that is centred and capped in width anyway, so
// they cost the grid no rows.

import { t } from "./i18n.js";
import { themeColors, onThemeChange } from "./theme.js";
import { pitchTablePresets } from "./pitchtables.js";
import { paintKeymapBoard, boardExtent, BOARD_SIZES } from "./keymapboard.js";
import { DEFAULT_KEYMAP } from "./keymap.js";
import { TRANSPOSE_MAX, OCTAVE_MIN, OCTAVE_MAX } from "./jam.js";
import { uiDpr, toLayout } from "./zoom.js";

const PREF_KEY = "microtone-keymapbar";

function loadPref() {
  try { return localStorage.getItem(PREF_KEY) === "1"; } catch { return false; }
}
function savePref(v) {
  try { localStorage.setItem(PREF_KEY, v ? "1" : "0"); } catch { /* private mode */ }
}

/** The views it docks under. Everywhere else the letter keys are not notes. */
const GRID_VIEWS = ["timeline", "pattern"];

export class KeymapBar {
  /** `onShift` runs after a button moves the octave or the transposition —
   *  the top bar's "Oct 4+3" readout is the app's to refresh. */
  constructor(store, jam, el, onShift = null) {
    this.store = store;
    this.jam = jam;
    this.el = el;
    this.onShift = onShift;
    this.enabled = loadPref();
    this._heldSig = "";
    this._paintedFor = null;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "keymap-bar-canvas";
    this.label = document.createElement("div");
    this.label.className = "keymap-bar-label";
    // The board gets a box of its own, so it is sized from the width the
    // buttons leave it rather than from the whole strip's.
    this.board = document.createElement("div");
    this.board.className = "keymap-bar-board";
    this.board.append(this.label, this.canvas);

    this.btn = {
      trUp: this._button("tr", 1, "+", "keymapbar.trUpTitle"),
      trDown: this._button("tr", -1, "\u2212", "keymapbar.trDownTitle"),
      octUp: this._button("oct", 1, "+", "keymapbar.octUpTitle"),
      octDown: this._button("oct", -1, "\u2212", "keymapbar.octDownTitle"),
    };
    el.append(
      this._side("keymapbar.transpose", this.btn.trUp, this.btn.trDown),
      this.board,
      this._side("keymapbar.oct", this.btn.octUp, this.btn.octDown));

    // Clicking a key auditions it, so the strip is playable as well as legible.
    this.canvas.addEventListener("pointerdown", (e) => this._onPointer(e));

    store.on("view", () => this.applyVisibility());
    store.on("keymap", () => this.invalidate());
    store.on("doc", () => this.invalidate());
    store.on("octave", () => this.invalidate());
    onThemeChange(() => this.invalidate());
    // The strip is sized from its own width, which the repaint key cannot see —
    // a window resize or a pane drag would otherwise leave the old canvas
    // stretched across the new width.
    new ResizeObserver(() => this.invalidate()).observe(el);
    this._layout = new Map();
  }

  get visible() { return this.enabled; }

  /** One +/− button. The pair's name is the column's caption, not the button's. */
  _button(kind, dir, sign, titleKey) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "keymap-bar-btn";
    b.textContent = sign;
    b.dataset.i18nTitle = titleKey;
    b.title = t(titleKey);
    b.addEventListener("click", () => this.shift(kind, dir));
    return b;
  }

  /** A column at one end of the board: + on top, the caption, − below. */
  _side(captionKey, up, down) {
    const cap = document.createElement("span");
    cap.className = "keymap-bar-cap";
    cap.dataset.i18n = captionKey;
    cap.textContent = t(captionKey);
    const col = document.createElement("div");
    col.className = "keymap-bar-side";
    col.append(up, cap, down);
    return col;
  }

  /** Move the octave (`kind` "oct") or the transposition ("tr") by `dir`, the
   *  same way the Alt-arrow chords do. */
  shift(kind, dir) {
    if (kind === "oct") this.jam.octaveDelta(dir);
    else this.jam.transposeDelta(dir);
    this.store.emit("octave");
    this.onShift?.();
  }

  /** A button that would push past its end of the range is greyed rather than
   *  left to do nothing when pressed. */
  _syncButtons() {
    const { octave, transpose } = this.jam;
    this.btn.octDown.disabled = octave <= OCTAVE_MIN;
    this.btn.octUp.disabled = octave >= OCTAVE_MAX;
    this.btn.trDown.disabled = transpose <= -TRANSPOSE_MAX;
    this.btn.trUp.disabled = transpose >= TRANSPOSE_MAX;
  }

  toggle() {
    this.enabled = !this.enabled;
    savePref(this.enabled);
    this.applyVisibility();
    return this.enabled;
  }

  /** On screen only while a grid is, and only when switched on. */
  applyVisibility() {
    const on = this.enabled && GRID_VIEWS.some((v) => this.store.viewOpen(v));
    this.el.hidden = !on;
    if (on) this.invalidate();
  }

  /** Force a repaint on the next frame (layout, theme, tuning or octave). */
  invalidate() { this._paintedFor = null; }

  get spec() { return this.store.keymap ?? DEFAULT_KEYMAP; }
  get preset() { return this.store.pitchPreset ?? pitchTablePresets[120]; }

  /**
   * Once a frame: repaint when something it draws has changed. Held keys come
   * from the jam keyboard's own map rather than from events, so anything that
   * sounds a note lights the strip.
   */
  frame() {
    if (this.el.hidden) return;
    const held = new Set(this.jam.held.keys());
    const sig = [...held].sort().join(",");
    const key = `${this.spec.name}|${this.spec.rows}|${this.jam.octave}|${this.jam.transpose}|${this.preset?.index}` +
      `|${this.store.keymapOrtho}|${this.board.clientWidth}|${sig}`;
    if (key === this._paintedFor) return;
    this._paintedFor = key;
    this._heldSig = sig;
    this.paint(held);
  }

  paint(held = new Set(this.jam.held.keys())) {
    const spec = this.spec;
    const ortho = this.store.keymapOrtho === true;
    const extent = boardExtent(spec, "compact", ortho);
    const dpr = uiDpr();
    const C = themeColors();
    const w = Math.max(this.board.clientWidth, 100);
    // Tall enough for the rows this layout uses, and no taller: a three-row
    // layout must not reserve the space a four-row one would want.
    const bh = Math.min(extent.h * BOARD_SIZES.compact.maxScale, extent.h * (w / extent.w));

    const shift = this.jam.transpose;
    this.label.textContent = t(shift ? "keymapbar.labelShift" : "keymapbar.label", {
      name: spec.name, octave: this.jam.octave, shift: shift > 0 ? `+${shift}` : String(shift),
    });
    this.label.style.color = C.dim;
    // The label rides in the margin left of the board while that margin can
    // hold it. Once the strip is narrow enough for the board to fill it — the
    // side buttons bring that on at tablet widths — it gets a line of its own
    // above the caps rather than printing over them.
    const margin = (w - extent.w * (bh / extent.h)) / 2;
    const top = margin < this.label.offsetLeft + this.label.offsetWidth + 4
      ? this.label.offsetTop + this.label.offsetHeight : 0;
    const h = bh + top;

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    ctx.translate(0, top);

    const caps = paintKeymapBoard(ctx, {
      spec, preset: this.preset, octave: this.jam.octave, shift,
      w, h: bh, size: "compact", held, ground: false, ortho,
    });
    this._layout = new Map([...caps].map(([code, p]) => [code, { x: p.x, y: p.y + top }]));
    this._syncButtons();
  }

  _onPointer(e) {
    const code = this._capAt(toLayout(e.offsetX), toLayout(e.offsetY));
    if (!code) return;
    if (this.jam.down(code, false)) {
      const release = () => { this.jam.up(code); window.removeEventListener("pointerup", release); };
      window.addEventListener("pointerup", release);
    }
  }

  _capAt(x, y) {
    const a = this._layout.get("KeyA"), b = this._layout.get("KeyS");
    const pitch = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 30;
    let best = null, bestD = (pitch * 0.6) ** 2;
    for (const [code, pt] of this._layout) {
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) { bestD = d; best = code; }
    }
    return best;
  }
}
