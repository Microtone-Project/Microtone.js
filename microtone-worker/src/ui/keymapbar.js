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

import { t } from "./i18n.js";
import { themeColors, onThemeChange } from "./theme.js";
import { pitchTablePresets } from "./pitchtables.js";
import { paintKeymapBoard, boardExtent, BOARD_SIZES } from "./keymapboard.js";
import { DEFAULT_KEYMAP } from "./keymap.js";
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
  constructor(store, jam, el) {
    this.store = store;
    this.jam = jam;
    this.el = el;
    this.enabled = loadPref();
    this._heldSig = "";
    this._paintedFor = null;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "keymap-bar-canvas";
    this.label = document.createElement("div");
    this.label.className = "keymap-bar-label";
    el.append(this.label, this.canvas);

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
      `|${this.store.keymapOrtho}|${this.el.clientWidth}|${sig}`;
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
    const w = Math.max(this.el.clientWidth, 200);
    // Tall enough for the rows this layout uses, and no taller: a three-row
    // layout must not reserve the space a four-row one would want.
    const h = Math.min(extent.h * BOARD_SIZES.compact.maxScale, extent.h * (w / extent.w));
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._layout = paintKeymapBoard(ctx, {
      spec, preset: this.preset, octave: this.jam.octave, shift: this.jam.transpose,
      w, h, size: "compact", held, ground: true, ortho,
    });

    const C = themeColors();
    const shift = this.jam.transpose;
    this.label.textContent = t(shift ? "keymapbar.labelShift" : "keymapbar.label", {
      name: spec.name, octave: this.jam.octave, shift: shift > 0 ? `+${shift}` : String(shift),
    });
    this.label.style.color = C.dim;
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
