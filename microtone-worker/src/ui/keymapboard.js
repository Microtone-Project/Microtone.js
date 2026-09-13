// Drawing a keymap as a hex board — shared by the Keymap tab (views/keymap.js)
// and the strip that docks under the grids (keymapbar.js), so the layout you
// build is pixel-for-pixel the layout you glance at while typing notes.
//
// Two sizes of the same picture. FULL is the editor's: big caps, the cents
// offset under each note, room to aim a mouse at one. COMPACT is the docked
// strip's: the same lattice and the same colours at a third of the height,
// because it lives under a tracker grid whose rows are the thing you are
// actually looking at.
//
// The colour is the point of both. A cap is tinted by its DEGREE within the
// period, so the repeating bands are the isomorphism made visible — and a
// layout that cannot reach some degree shows it as a colour that never appears.

import { themeColors, isDarkTheme } from "./theme.js";
import { canvasFont } from "./fonts.js";
import { paintNoteCell } from "./glyphs.js";
import { nearestDegreeIndex } from "./pitchtables.js";
import { noteCentsOff } from "./notenames.js";
import { ROW_CODES, ROW_ORDER, resolveKeymap, keymapNote } from "./keymap.js";

/** Cap geometry per size, in device-independent px before the fit-to-box scale.
 *  `step` is the vertical pitch: less than `h`, so the hexes interlock the way
 *  they do on a real hex board, but not so much that a cap's cents marker lands
 *  under the row drawn after it. */
export const BOARD_SIZES = {
  full: { w: 62, h: 56, step: 52, pad: 18, legend: 10, glyph: 15, cents: 9, maxScale: 2.2 },
  compact: { w: 40, h: 34, step: 31, pad: 4, legend: 7, glyph: 10, cents: 0, maxScale: 1.25 },
};

// How far each row is pushed right, in cap widths. A typewriter keyboard
// staggers by about a quarter of a key per row; the lattice does not care, but
// a board that looks like the keyboard under your hands is far easier to read
// off — which is also why the stagger can be switched OFF. Ortholinear boards
// (Planck, Preonic, and most split ergonomic keyboards) put their keys in true
// columns, and on one of those the staggered picture is the misleading one.
const ROW_STAGGER = { N: 0, Q: 0.35, A: 0.6, Z: 0.95 };
const ROW_ORTHO = { N: 0, Q: 0, A: 0, Z: 0 };

/** A flat-topped hexagon, which is how the Lumatone's own sheets draw a cap. */
export function hexPath(ctx, cx, cy, rx, ry) {
  const k = rx * 0.5;
  ctx.moveTo(cx - k, cy - ry);
  ctx.lineTo(cx + k, cy - ry);
  ctx.lineTo(cx + rx, cy);
  ctx.lineTo(cx + k, cy + ry);
  ctx.lineTo(cx - k, cy + ry);
  ctx.lineTo(cx - rx, cy);
  ctx.closePath();
}

/** A keycap: the rounded rectangle an ortholinear board actually has. Slightly
 *  inset, so neighbouring caps read as separate keys the way the interlocking
 *  hexagons do without a gap. */
export function capPath(ctx, cx, cy, rx, ry) {
  const r = Math.min(rx, ry) * 0.28;
  ctx.roundRect(cx - rx * 0.92, cy - ry * 0.88, rx * 1.84, ry * 1.76, r);
}

/** The un-scaled size of `spec`'s board at `size`, for a caller that has to
 *  decide how tall to make its canvas before it draws. */
export function boardExtent(spec, size = "full", ortho = false) {
  const S = BOARD_SIZES[size];
  const rows = ROW_ORDER.filter((r) => spec.rows.includes(r));
  // Hexagons interlock, so their rows sit closer together than a cap is tall;
  // rectangles do not, and stacking them at the hex pitch would overlap them.
  const step = ortho ? S.h : S.step;
  // …and with no stagger the board is exactly ten caps wide, not eleven.
  const wide = ortho ? S.w * 10 : S.w * 11;
  return {
    w: S.pad * 2 + wide,
    h: S.pad * 2 + step * (rows.length - 1) + S.h,
    rows: rows.length,
  };
}

/**
 * Paint `spec` into `ctx`, fitted and centred inside a `w`×`h` box.
 *
 * Returns `Map<code, {x, y}>` of cap centres in BOX coordinates, which is what
 * the editor hit-tests clicks and wheels against; a caller that only displays
 * can ignore it.
 *
 * @param opts.held      Set of codes sounding right now (painted in the accent)
 * @param opts.selected  the code under edit, if any (painted with a caret ring)
 * @param opts.legend    (code) => the key's printed letter
 * @param opts.size      "full" | "compact"
 * @param opts.ground    fill the box first (the tab does; the strip has CSS)
 */
export function paintKeymapBoard(ctx, opts) {
  const {
    spec, preset, octave, w, h, size = "full", ortho = false,
    held = EMPTY_SET, selected = null, legend = defaultLegend, ground = true,
  } = opts;
  const stagger = ortho ? ROW_ORTHO : ROW_STAGGER;
  const S = BOARD_SIZES[size];
  const C = themeColors();
  const dark = isDarkTheme();

  if (ground) {
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
  }

  const rows = ROW_ORDER.filter((r) => spec.rows.includes(r)).reverse(); // top row first
  const extent = boardExtent(spec, size, ortho);
  const scale = Math.min(w / extent.w, h / extent.h, S.maxScale);
  const dx = (w - extent.w * scale) / 2;
  const dy = (h - extent.h * scale) / 2;

  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(scale, scale);

  const layout = new Map();
  const resolved = resolveKeymap(spec);
  // What the generator ALONE would give, so a cap is marked only where it
  // really departs from the lattice. The Piano layout is nothing but overrides
  // — it is not a lattice at all — so marking every one of its keys would be
  // true and useless; an inert generator marks nothing.
  const inert = spec.x === 0 && spec.y === 0;
  const plain = inert ? null : resolveKeymap({ ...spec, overrides: {} });
  const total = preset?.table?.length ?? 0;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  rows.forEach((row, ri) => {
    ROW_CODES[row].forEach((code, col) => {
      const cx = S.pad + (col + stagger[row]) * S.w + S.w / 2;
      const cy = S.pad + ri * (ortho ? S.h : S.step) + S.h / 2;
      layout.set(code, { x: cx * scale + dx, y: cy * scale + dy });
      const note = resolved.has(code) ? keymapNote(spec, code, octave, preset, resolved) : null;
      paintCap(ctx, {
        code, cx, cy, note, preset, total, S, C, dark,
        held: held.has(code), selected: selected === code, ortho,
        overridden: plain !== null && resolved.get(code) !== plain.get(code), legend,
      });
    });
  });

  ctx.restore();
  return layout;
}

const EMPTY_SET = new Set();

/** What a key is printed with on a US keyboard — the fallback for hosts with no
 *  navigator.keyboard.getLayoutMap(), and what the strip uses outright. */
export const SYMBOL_LEGEND = {
  Semicolon: ";", Comma: ",", Period: ".", Slash: "/", Quote: "'",
};

export const defaultLegend = (code) =>
  code.startsWith("Key") || code.startsWith("Digit")
    ? code.slice(-1)
    : SYMBOL_LEGEND[code] ?? code;

function paintCap(ctx, o) {
  const { cx, cy, note, preset, total, S, C, dark } = o;
  const degree = note === null ? -1 : nearestDegreeIndex(note, preset).index;
  const hue = total > 0 && degree >= 0 ? Math.round((degree / total) * 360) : 0;

  ctx.beginPath();
  if (o.ortho) capPath(ctx, cx, cy, S.w * 0.5, S.h * 0.5);
  else hexPath(ctx, cx, cy, S.w * 0.5, S.h * 0.54);
  if (note === null) ctx.fillStyle = dark ? "#1b1b1b" : "#e9e9e9";
  else if (o.held) ctx.fillStyle = C.accent;
  else ctx.fillStyle = `hsl(${hue} 55% ${dark ? 21 : 87}%)`;
  ctx.fill();
  ctx.lineWidth = o.selected ? 3 : 1;
  ctx.strokeStyle = o.selected ? C.caret
    : note === null ? C.border : `hsl(${hue} 50% ${dark ? 42 : 58}%)`;
  ctx.stroke();

  // An overridden cap is ringed — the layout is no longer purely the generator
  // there, and that has to be visible or the readout's numbers lie.
  if (o.overridden) {
    ctx.beginPath();
    ctx.arc(cx + S.w * 0.32, cy - S.h * 0.3, S.w * 0.056, 0, Math.PI * 2);
    ctx.fillStyle = C.accent2;
    ctx.fill();
  }

  ctx.fillStyle = C.dim;
  ctx.font = canvasFont(S.legend);
  ctx.fillText(o.legend(o.code), cx - S.w * 0.3, cy - S.h * 0.28);

  if (note === null) return;
  const charW = S.glyph * 0.53, rowH = S.glyph + 1;
  ctx.font = canvasFont(S.glyph);
  ctx.textAlign = "left";
  paintNoteCell(ctx, note, preset, cx - charW * 2, cy - rowH / 2 + 2, charW, rowH,
    { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent });
  ctx.textAlign = "center";

  // The compact board has no room for a cents line, and the colour plus the
  // glyph's own accidental already say where the note sits.
  if (S.cents === 0) return;
  const cents = noteCentsOff(note);
  if (cents !== 0) {
    ctx.font = canvasFont(S.cents);
    ctx.fillStyle = C.dim;
    ctx.fillText(`${cents > 0 ? "+" : ""}${cents}¢`, cx, cy + S.h * 0.25);
  }
}
