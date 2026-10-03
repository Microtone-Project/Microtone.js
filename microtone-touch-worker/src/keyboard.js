// The keyboard — a canvas of hexagonal keys, played with as many fingers as
// the screen will report.
//
// Each finger is tracked by its pointer id from the moment it lands until it
// lifts. Sliding onto another key is a glissando: the app hears `slide` and
// re-triggers that finger's voice at the new pitch, so a run up the board is
// one gesture. On a drum lane the same canvas shows eight pads instead.
//
// Painting is change-driven: the canvas is redrawn when its size, its
// configuration, the theme or the set of held keys changes — never on a timer.

import { layoutSteps, keyDegree, pixelToHex, visibleKeys } from "./lattice.js";
import { noteForDegree, resolveNoteSymbol } from "../core/tuning/pitchtables.js";
import { noteClass, noteShade } from "./notes.js";
import { DRUMS } from "../core/sketch/pack.js";

// Keys outside C0…B9 are drawn but inert: the notation has no name for them,
// and further out the note words clamp, so a row would all sound one pitch.
const LOWEST = 0x1000;
const HIGHEST = 0xb000;

const PAD_COLS = 4;

/**
 * The note of the board's origin key for keyboard octave `octave`: the
 * tuning's degree 0 in the period nearest that octave's C. On an octave
 * tuning that is C<octave> itself; Bohlen–Pierce repeats at the tritave, so
 * there the origin is the tritave root closest to it.
 */
export function originPeriod(preset, octave) {
  return Math.round(((octave - 4) * 0x1000) / preset.interval);
}
const PAD_ROWS = 2;
const DRUM_NOTE = 0x5000; // a hit plays its sample at its own rate (C4)

const TOKENS = [
  "--bg", "--panel", "--key-natural", "--key-natural-ink", "--key-near", "--key-near-ink",
  "--key-accidental", "--key-accidental-ink", "--key-edge", "--key-tonic", "--key-down",
  "--key-down-ink", "--key-ghost", "--dim",
];

export class Keyboard {
  /**
   * `handlers.down(id, key)`, `handlers.slide(id, key)` and `handlers.up(id)`;
   * a key is `{ note, degree }` or, on the pads, `{ note, drum }`.
   */
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.handlers = handlers;
    this.cfg = { preset: null, layout: "wicki", octave: 3, size: 30, drums: false, laneColour: "" };
    this.held = new Map(); // pointer id → key
    this.lit = new Set();  // note words sounding from elsewhere, drawn as ghosts
    this.width = 0;
    this.height = 0;
    this.colours = {};
    this._readColours();

    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this._readColours();
      this.paint();
    });

    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      canvas.addEventListener(type, (e) => this._up(e));
    }
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  configure(patch) {
    Object.assign(this.cfg, patch);
    this.paint();
  }

  /** Every held finger lets go (a lane switch, the page losing focus). */
  releaseAll() {
    for (const id of [...this.held.keys()]) {
      this.held.delete(id);
      this.handlers.up(id);
    }
    this.paint();
  }

  // ── geometry ──

  /** Key (0, 0) — the origin note — sits whole in the bottom-left corner. */
  _origin() {
    const size = this.cfg.size;
    return { x: size * 1.05, y: this.height - size * 1.05 };
  }

  _keyAt(x, y) {
    if (this.cfg.drums) {
      const col = Math.floor((x / this.width) * PAD_COLS);
      const row = Math.floor((y / this.height) * PAD_ROWS);
      if (col < 0 || col >= PAD_COLS || row < 0 || row >= PAD_ROWS) return null;
      const drum = (PAD_ROWS - 1 - row) * PAD_COLS + col; // kick bottom-left
      return { note: DRUM_NOTE, drum };
    }
    const o = this._origin();
    const { q, r } = pixelToHex(x - o.x, y - o.y, this.cfg.size, this._steps().tilt);
    const key = this._key(q, r);
    return key.off ? null : key;
  }

  /** The layout's steps on this tuning — its tilt included (lattice.js
   *  caches them, so this is a lookup). */
  _steps() {
    const p = this.cfg.preset;
    return layoutSteps(this.cfg.layout, p.table.length, p.interval);
  }

  _key(q, r) {
    const p = this.cfg.preset;
    const degree = keyDegree(q, r, this._steps());
    const note = noteForDegree(4 + originPeriod(p, this.cfg.octave), degree, p);
    return { q, r, degree, note, off: note < LOWEST || note >= HIGHEST };
  }

  _point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── pointers ──

  _down(e) {
    if (!this.cfg.preset) return;
    e.preventDefault();
    const { x, y } = this._point(e);
    const key = this._keyAt(x, y);
    if (!key) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.held.set(e.pointerId, key);
    this.handlers.down(e.pointerId, key);
    this.paint();
  }

  _move(e) {
    const was = this.held.get(e.pointerId);
    if (!was) return;
    const { x, y } = this._point(e);
    const key = this._keyAt(x, y);
    if (!key || (key.note === was.note && key.drum === was.drum)) return;
    this.held.set(e.pointerId, key);
    this.handlers.slide(e.pointerId, key);
    this.paint();
  }

  _up(e) {
    if (!this.held.has(e.pointerId)) return;
    this.held.delete(e.pointerId);
    this.handlers.up(e.pointerId);
    this.paint();
  }

  // ── painting ──

  _readColours() {
    const cs = getComputedStyle(document.documentElement);
    for (const t of TOKENS) this.colours[t] = cs.getPropertyValue(t).trim();
  }

  _resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = box.width;
    this.height = box.height;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paint();
  }

  paint() {
    const { ctx, width, height, colours: c } = this;
    if (!width || !height || !this.cfg.preset) return;
    ctx.fillStyle = c["--bg"];
    ctx.fillRect(0, 0, width, height);
    if (this.cfg.drums) this._paintPads();
    else this._paintKeys();
  }

  _paintKeys() {
    const { ctx, colours: c } = this;
    const size = this.cfg.size;
    const heldNotes = new Set([...this.held.values()].map((k) => k.note));
    const o = this._origin();
    const font = Math.max(10, Math.round(size * 0.42));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tilt = this._steps().tilt;
    for (const { q, r, x, y } of visibleKeys(this.width, this.height, size, o, tilt)) {
      const key = this._key(q, r);
      if (key.off) {
        hexPath(ctx, x, y, size * 0.93, tilt);
        ctx.fillStyle = c["--panel"];
        ctx.fill();
        continue;
      }
      const shade = noteShade(key.note, this.cfg.preset);
      const down = heldNotes.has(key.note);
      const fill = down ? c["--key-down"] : c[`--key-${shade}`];
      const ink = down ? c["--key-down-ink"] : c[`--key-${shade}-ink`];
      hexPath(ctx, x, y, size * 0.93, tilt);
      ctx.fillStyle = fill;
      ctx.fill();
      const n = this.cfg.preset.table.length;
      const isTonic = ((key.degree % n) + n) % n === 0;
      ctx.lineWidth = isTonic ? 3 : 1;
      ctx.strokeStyle = isTonic ? c["--key-tonic"] : c["--key-edge"];
      ctx.stroke();
      if (!down && this.lit.has(key.note)) {
        hexPath(ctx, x, y, size * 0.6, tilt);
        ctx.lineWidth = 2;
        ctx.strokeStyle = c["--key-ghost"];
        ctx.stroke();
      }
      ctx.fillStyle = ink;
      ctx.font = `600 ${font}px system-ui, sans-serif`;
      const label = noteClass(key.note, this.cfg.preset);
      ctx.fillText(label, x, isTonic ? y - font * 0.3 : y);
      if (isTonic) {
        ctx.font = `${Math.round(font * 0.75)}px system-ui, sans-serif`;
        ctx.fillText(String(resolveNoteSymbol(key.note, this.cfg.preset)?.octave ?? ""), x, y + font * 0.6);
      }
    }
  }

  _paintPads() {
    const { ctx, colours: c } = this;
    const held = new Set([...this.held.values()].map((k) => k.drum));
    const w = this.width / PAD_COLS;
    const h = this.height / PAD_ROWS;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < DRUMS.length; i++) {
      const col = i % PAD_COLS;
      const row = PAD_ROWS - 1 - Math.floor(i / PAD_COLS);
      const x = col * w + 5, y = row * h + 5, pw = w - 10, ph = h - 10;
      ctx.beginPath();
      ctx.roundRect(x, y, pw, ph, 12);
      ctx.fillStyle = held.has(i) ? c["--key-down"] : c["--key-accidental"];
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c["--key-edge"];
      ctx.stroke();
      ctx.fillStyle = held.has(i) ? c["--key-down-ink"] : c["--key-accidental-ink"];
      ctx.font = `600 ${Math.round(Math.min(pw, ph) * 0.16)}px system-ui, sans-serif`;
      ctx.fillText(DRUMS[i].name, x + pw / 2, y + ph / 2);
    }
  }
}

function hexPath(ctx, x, y, r, tilt) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    // A pointy-topped hexagon turned with the board (screen y runs down).
    const a = (Math.PI / 180) * (60 * i - 30) - tilt;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
