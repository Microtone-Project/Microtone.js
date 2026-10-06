// The keyboard — a canvas of hexagonal keys, played with as many fingers as
// the screen will report.
//
// Each finger is tracked by its pointer id from the moment it lands until it
// lifts. Sliding onto another key is a glissando: the app hears `slide` and
// re-triggers that finger's voice at the new pitch, so a run up the board is
// one gesture. On a drum lane the same canvas shows eight pads instead.
//
// With fat fingers on (the harmonic table's own mode; see lattice.js), one
// finger can hold two or three keys at once. The app is told of each as a
// finger of its own — ids are the keyboard's, not the pointer's — so a held
// triad takes three voices and spreads over lanes like a three-finger chord.
// Sliding into another zone keeps every key the two zones share sounding,
// moves the rest, and lets go of or adds whatever is left over.
//
// Painting is change-driven: the canvas is redrawn when its size, its
// configuration, the theme or the set of held keys changes — never on a timer.

import { layoutSteps, keyDegree, pixelToHex, visibleKeys, fatZone, fatPoints, hexCentre } from "./lattice.js";
import { noteForDegree, resolveNoteSymbol } from "../core/tuning/pitchtables.js";
import { noteClass, noteShade } from "./notes.js";
import { DRUMS } from "../core/sketch/pack.js";
import { t } from "./i18n.js";

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
    this.cfg = {
      preset: null, layout: "wicki", octave: 3, size: 30, drums: false, laneColour: "",
      across: false, fat: false,
    };
    this.held = new Map(); // pointer id → { touch: {keys, zone}, fingers: [{ id, key }] }
    this.nextFinger = 1;
    this.lit = new Set();  // note words sounding from elsewhere, drawn as ghosts
    this.width = 0;
    this.height = 0;
    this.colours = {};
    this._readColours();

    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);

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
    for (const [pointer, hold] of [...this.held]) {
      this.held.delete(pointer);
      for (const f of hold.fingers) this.handlers.up(f.id);
    }
    this.paint();
  }

  // ── geometry ──

  /** Key (0, 0) — the origin note — sits whole in the bottom-left corner. */
  _origin() {
    const size = this.cfg.size;
    return { x: size * 1.05, y: this.height - size * 1.05 };
  }

  /**
   * What a finger at (x, y) holds: `{ keys, zone }`, or null off the playable
   * board. `was` is what it held until now, returned as it is while a fat
   * finger has not left its zone; `zone` is null but for fat fingers.
   */
  _touchAt(x, y, was = null) {
    if (this.cfg.drums) {
      const col = Math.floor((x / this.width) * PAD_COLS);
      const row = Math.floor((y / this.height) * PAD_ROWS);
      if (col < 0 || col >= PAD_COLS || row < 0 || row >= PAD_ROWS) return null;
      const drum = (PAD_ROWS - 1 - row) * PAD_COLS + col; // kick bottom-left
      return { keys: [{ note: DRUM_NOTE, drum }], zone: null };
    }
    const o = this._origin();
    const { size } = this.cfg;
    const { tilt } = this._steps();
    if (this.cfg.fat) {
      const zone = fatZone(x - o.x, y - o.y, size, tilt, was?.zone);
      if (zone === was?.zone) return was;
      const keys = zone.keys.map(({ q, r }) => this._key(q, r)).filter((k) => !k.off);
      return keys.length ? { keys, zone } : null;
    }
    const { q, r } = pixelToHex(x - o.x, y - o.y, size, tilt);
    const key = this._key(q, r);
    return key.off ? null : { keys: [key], zone: null };
  }

  /** The layout's steps on this tuning — its tilt included (lattice.js
   *  caches them, so this is a lookup). */
  _steps() {
    const p = this.cfg.preset;
    return layoutSteps(this.cfg.layout, p.table.length, p.interval, this.cfg.across);
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
    const touch = this._touchAt(x, y);
    if (!touch) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const hold = { touch, fingers: [] };
    this.held.set(e.pointerId, hold);
    for (const key of touch.keys) this._press(hold, key);
    this.paint();
  }

  _press(hold, key) {
    const id = this.nextFinger++;
    hold.fingers.push({ id, key });
    this.handlers.down(id, key);
  }

  _move(e) {
    const hold = this.held.get(e.pointerId);
    if (!hold) return;
    const { x, y } = this._point(e);
    const touch = this._touchAt(x, y, hold.touch);
    if (!touch || touch === hold.touch) return;
    // A fat finger's zone is drawn lit, so a new one repaints even when it
    // holds the same keys (a corner whose third key is off the board).
    let changed = touch.zone !== hold.touch.zone;
    hold.touch = touch;
    // Keys both holds share keep sounding; the rest move, low to low…
    const fresh = [...touch.keys];
    const moved = [];
    for (const f of hold.fingers) {
      const i = fresh.findIndex((k) => sameKey(k, f.key));
      if (i < 0) moved.push(f);
      else f.key = fresh.splice(i, 1)[0];
    }
    moved.sort((f, g) => f.key.note - g.key.note);
    fresh.sort((k, l) => k.note - l.note);
    moved.forEach((f, i) => {
      changed = true;
      if (i < fresh.length) {
        f.key = fresh[i];
        this.handlers.slide(f.id, f.key);
      } else { // …and what is left over lets go, or comes in
        hold.fingers.splice(hold.fingers.indexOf(f), 1);
        this.handlers.up(f.id);
      }
    });
    for (const key of fresh.slice(moved.length)) {
      changed = true;
      this._press(hold, key);
    }
    if (changed) this.paint();
  }

  _up(e) {
    const hold = this.held.get(e.pointerId);
    if (!hold) return;
    this.held.delete(e.pointerId);
    for (const f of hold.fingers) this.handlers.up(f.id);
    this.paint();
  }

  /** Every key held, by any finger. */
  _heldKeys() {
    return [...this.held.values()].flatMap((h) => h.fingers.map((f) => f.key));
  }

  // ── painting ──

  /** The theme changed (theme.js): the colours are cached, so read them again. */
  retheme() {
    this._readColours();
    this.paint();
  }

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
    const heldNotes = new Set(this._heldKeys().map((k) => k.note));
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
    if (this.cfg.fat) this._paintFatPoints(o, tilt);
  }

  /** A dot on every corner and edge that has a touch point — the ones a
   *  finger is holding in the held keys' colour. */
  _paintFatPoints(o, tilt) {
    const { ctx, colours: c } = this;
    const size = this.cfg.size;
    const held = [...this.held.values()]
      .filter((h) => h.touch.zone?.keys.length > 1)
      .map((h) => h.touch.zone);
    const corner = Math.max(2, size * 0.1), edge = Math.max(1.5, size * 0.07);
    const offs = new Map(); // "q,r" → inert: each key is asked once, not five times
    const off = ({ q, r }) => {
      const id = `${q},${r}`;
      if (!offs.has(id)) offs.set(id, this._key(q, r).off);
      return offs.get(id);
    };
    for (const { q, r } of visibleKeys(this.width, this.height, size, o, tilt)) {
      for (const p of fatPoints(q, r)) {
        if (p.keys.some(off)) continue;
        const at = hexCentre(p.q, p.r, size, tilt);
        const lit = held.some((z) => Math.abs(z.x - at.x) < 0.5 && Math.abs(z.y - at.y) < 0.5);
        ctx.beginPath();
        ctx.arc(o.x + at.x, o.y + at.y, p.keys.length === 3 ? corner : edge, 0, 2 * Math.PI);
        ctx.fillStyle = lit ? c["--key-down"] : c["--dim"];
        ctx.fill();
      }
    }
  }

  _paintPads() {
    const { ctx, colours: c } = this;
    const held = new Set(this._heldKeys().map((k) => k.drum));
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
      ctx.fillText(t(`drum.${DRUMS[i].id}`), x + pw / 2, y + ph / 2);
    }
  }
}

const sameKey = (k, l) => k.note === l.note && k.drum === l.drum;

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
