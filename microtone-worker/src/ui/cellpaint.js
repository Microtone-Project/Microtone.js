// Tracker-cell painter: the note, volume, panning and effect cells of the
// Timeline, the Patterns view, the chord and notation makers and the keymap.
// Every mark is a character of the Motif Grid font (--cv-font; built by
// design-system/fonts): the letters and digits, and the accidentals, Kite
// ticks, slide marks, sentinels and the twelve lü drawn to sit with them. The
// caller sets ctx.font through fonts.js canvasFont() and textBaseline
// "middle"; this module only chooses characters and the cells they go in.
//
// The 4-cell note cell:
//
//   [letter][ accidental, 2 cells ][octave]   normal presets
//   [tick][letter][accidental][octave]        Kite notation (one-cell accidental)
//   [ lü, 2 cells ][octave][ ]                Shi'er lü
//   [ sentinel, all 4 cells    ]              key-off / cut / fade / fast fade
//   [ IntH ] / [ hex4 ]                       interrupts / raw mode & no-preset

import { resolveNoteSymbol } from "../../core/tuning/pitchtables.js";
import { hex2, hex4, fxArgFields, fxOpChar } from "./notenames.js";
import { volPanOp, volPanArg } from "./edit.js";
import { MOTIF, MUSIC, motifCells } from "../../core/fonts/motifglyphs.js";

export const NOTE_CELL_CHARS = 4;

const SENTINEL = [null, MOTIF.KEY_OFF, MOTIF.NOTE_CUT, MOTIF.FADE, MOTIF.FAST_FADE];

// pitchtables.js's accidental codes. A two-cell slot takes the two-cell
// glyph (Motif Grid has one for the triple and quadruple sharps too, which
// Unicode lacks, and for the tracker's natural dash).
const ACC_WIDE = {
  "#": MOTIF.SHARP2, b: MOTIF.FLAT2, x: MOTIF.DOUBLE_SHARP2, B: MOTIF.DOUBLE_FLAT2,
  T: MOTIF.TRIPLE_FLAT2, t: MOTIF.HALF_SHARP2, p: MOTIF.REVERSED_FLAT2,
  3: MOTIF.TRIPLE_SHARP2, 4: MOTIF.QUADRUPLE_SHARP2, "-": MOTIF.NATURAL2,
};
const ACC_ONE = {
  "#": MUSIC.SHARP, b: MUSIC.FLAT, x: MUSIC.DOUBLE_SHARP, B: MUSIC.DOUBLE_FLAT,
  T: MUSIC.TRIPLE_FLAT, t: MUSIC.HALF_SHARP, p: MUSIC.REVERSED_FLAT, "-": "-",
};
const TICK = {
  u: MOTIF.KITE_UP, d: MOTIF.KITE_DOWN, U: MOTIF.KITE_UP2, D: MOTIF.KITE_DOWN2, ".": MOTIF.KITE_DOT,
};

// The font's own cell at each ctx.font (0.6 em), so a glyph can be centred
// in a caller's cell when that is a pixel or so wider (CHAR_W 7.9 against
// 7.8 at 13 px; the chord maker's 9).
const fontCell = new Map();

function cellOf(ctx) {
  let w = fontCell.get(ctx.font);
  if (w === undefined) {
    w = ctx.measureText("0").width;
    fontCell.set(ctx.font, w);
  }
  return w;
}

/** Draw `s` (which is `cells` cells wide) centred in `cells` caller cells at x. */
function put(ctx, s, x, midY, charW, cells = 1) {
  ctx.fillText(s, x + (cells * (charW - cellOf(ctx))) / 2, midY);
}

/**
 * Flat single-ink palette — every glyph part in one colour. Used for the
 * pattern-ditto ghost cells, which must read as "not really here". Covers the
 * note cell and the effect cell, so one object serves both painters.
 */
export function monoPalette(colour) {
  return {
    note: colour, sentinel: colour, dim: colour, offGrid: colour,
    op: colour, a1: colour, a2: colour, a3: colour, ext: colour,
  };
}

/**
 * The note cell as Motif Grid text — the one spelling both the canvas grids
 * and the DOM readouts use (components/noteglyph.js). `ink` names the palette entry it
 * is drawn in: "note", "offGrid" (taut's yellow for a pitch off the
 * preset's grid), "sentinel" or "dim"; `faint` is the empty cell's 40%.
 * rawMode forces hex4 for playable notes (the taut rawNoteView toggle).
 */
export function noteCellText(note, preset, rawMode = false) {
  if (note === 0x0000) return { text: "····", ink: "dim", faint: true };
  if (note >= 0x0001 && note <= 0x0004) return { text: SENTINEL[note], ink: "sentinel" };
  if (note >= 0x0005 && note <= 0x000f) return { text: "rsvd", ink: "dim" };
  // taut notation: IntH, H = hex 0..F
  if (note >= 0x0010 && note <= 0x001f) {
    return { text: "Int" + (note - 0x0010).toString(16).toUpperCase(), ink: "sentinel" };
  }
  const symb = rawMode ? null : resolveNoteSymbol(note, preset);
  if (symb === null) return { text: hex4(note), ink: rawMode ? "note" : "dim" };
  const ink = symb.offGrid ? "offGrid" : "note";
  if (symb.cjk) return { text: symb.cjk + symb.octave, ink, glyphs: true };
  const text = symb.tick !== " "
    ? (TICK[symb.tick] ?? " ") + symb.letter + (ACC_ONE[symb.acc] ?? symb.acc) + symb.octave
    : symb.letter + (ACC_WIDE[symb.acc] ?? MOTIF.NATURAL2) + symb.octave;
  return { text, ink, glyphs: true };
}

/**
 * Paint the 4-char note cell at (x, y).
 * palette: {note, sentinel, dim, offGrid} — off-grid ("out of tune") notes
 * paint in palette.offGrid (taut's yellow).
 */
export function paintNoteCell(ctx, note, preset, x, y, charW, rowH, palette, rawMode = false) {
  const midY = y + rowH / 2;
  const { text, ink, faint, glyphs } = noteCellText(note, preset, rawMode);
  ctx.fillStyle = palette[ink];
  if (faint) ctx.globalAlpha = 0.4;
  if (glyphs || (ink === "sentinel" && text.length === 1)) {
    // Glyph by glyph, each centred in its own cells, so a caller's cell a
    // pixel wider than the font's keeps every glyph in its slot.
    let cx = x;
    for (const ch of text) {
      const n = motifCells(ch);
      put(ctx, ch, cx, midY, charW, n);
      cx += n * charW;
    }
  } else {
    ctx.fillText(text, x, midY);
  }
  if (faint) ctx.globalAlpha = 1;
}

/**
 * Paint a volume or panning column (item 87) at (x, y): the SYMBOL cell then
 * two argument digits, 3 chars in all.
 *   set          blank symbol — nothing is happening to the value, the digits
 *                simply are the volume / panning
 *   slide        a tick: up/down for volume, left/right for panning
 *   fine slide   '+' / '−' — a one-shot delta, sign in the symbol and
 *                magnitude (00..1F) in the digits
 *   no-op ($C0)  "···", dimmed like every other empty column
 * palette: {ink, dim} — ink covers symbol + digits (the callers colour the
 * volume, panning and ditto-ghost variants differently).
 */
export function paintVolPanCell(ctx, value, sel, isPan, x, y, charW, rowH, palette) {
  const wide = palette.wide === true;
  const digits = wide && isPan ? 3 : 2;
  const op = volPanOp(value, sel, isPan, wide);
  const midY = y + rowH / 2;
  if (op === "none" && !(wide && isPan && palette.elevation)) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    // A wide panning column is symbol + elevation + azimuth: six dots, not three.
    ctx.fillText(wide && isPan ? "······" : "···", x, midY);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = palette.ink;
  switch (op) {
    case "up": put(ctx, isPan ? MOTIF.PAN_RIGHT : MOTIF.VOL_UP, x, midY, charW); break;
    case "down": put(ctx, isPan ? MOTIF.PAN_LEFT : MOTIF.VOL_DOWN, x, midY, charW); break;
    case "fineUp": ctx.fillText("+", x, midY); break;
    case "fineDown": ctx.fillText("−", x, midY); break;
    default: break; // "set" — a deliberate blank
  }
  // The wide panning column carries the ELEVATION between the symbol and the
  // azimuth, in its own ink: the two numbers are different quantities and must
  // not read as one six-digit field.
  let argX = x + charW;
  if (wide && isPan) {
    const el = palette.elevation | 0;
    const txt = elevationCellText(el, op, palette.spatial === true);
    const stated = txt !== "··";
    ctx.fillStyle = stated ? (palette.elevationInk ?? palette.ink) : palette.dim;
    if (!stated) ctx.globalAlpha = 0.4;
    ctx.fillText(txt, argX, midY);
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.ink;
    argX += 2 * charW;
  }
  const arg = volPanArg(value, sel, isPan, wide);
  ctx.fillText(digits === 3 ? hex3(arg) : hex2(arg), argX, midY);
}

/**
 * Paint the 5-char effect cell (opcode + 4 hex nibbles) at (x, y), colouring
 * each of the command's ARGUMENT FIELDS separately — item 120.
 *
 * A Taud argument is rarely one number: `H $2277` is a speed and a depth,
 * `D $4000` is one slide nibble over a reserved byte, `S $8040` is a
 * two-character command carrying a pan. The field map (notenames.fxArgFields)
 * says which nibble belongs to what; this paints field 1/2/3 in three shades of
 * amber, the S / Z multiplexer nibble in the opcode's own ink so the command
 * reads as one token, and reserved nibbles dim because the engine ignores them.
 *
 * palette: {op, a1, a2, a3, dim, ext} — monoPalette() collapses all six for
 * the pattern-ditto ghosts. `paired` (item 162, widened by item 181; the
 * caller decides via notenames.fxColonWarns, which returns one flag per SLOT):
 * true only for the `:` arrangements worth a second look — `:` sitting on the
 * FIRST effect slot (functionally fine, but not where a reader expects it),
 * `:` paired with a command that does not read it at all (a silent no-op), or
 * the SECOND `:` on an interrupt row, whose argument the first one has already
 * won. A `:` correctly on the second slot, paired with something that reads
 * it, is the unremarkable common case and paints through the ordinary
 * per-field colours below like any other row. When `paired` IS true, the whole
 * 5-character cell paints in `palette.ext` instead — the argument-field ramp
 * doesn't describe this cell meaningfully once it's flagged.
 *
 * `pairedOp` (item 162): the OTHER effect slot on this row — passed through
 * to notenames.fxArgFields so an UNflagged (`paired` false) correctly-paired
 * `:`/J/O/2/3 cell colours by what the COMBINED argument means rather than
 * each cell's own isolated layout (see fxArgFields' own doc for exactly
 * which pairings this changes). Ignored when `paired` is true, and harmless
 * to pass for an ordinary unpaired row — fxLayout only branches on it for
 * the specific opcode combinations that define one.
 */
export function paintFxCell(ctx, effect, arg, x, y, charW, rowH, palette, paired = false, pairedOp = 0) {
  const midY = y + rowH / 2;
  if (effect === 0 && arg === 0) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    ctx.fillText("·····", x, midY);
    ctx.globalAlpha = 1;
    return;
  }
  if (paired) {
    ctx.fillStyle = palette.ext;
    ctx.fillText(fxOpChar(effect) + hex4(arg), x, midY);
    return;
  }
  ctx.fillStyle = palette.op;
  ctx.fillText(fxOpChar(effect), x, midY);
  const fields = fxArgFields(effect, arg, pairedOp);
  const inks = [palette.a1, palette.a2, palette.a3];
  const digits = hex4(arg);
  for (let i = 0; i < 4; i++) {
    const f = fields[i];
    ctx.fillStyle = f === 0 ? palette.op : f < 0 ? palette.dim : inks[f - 1];
    if (f < 0) ctx.globalAlpha = 0.55; // reserved: present, but not a value
    ctx.fillText(digits[i], x + (i + 1) * charW, midY);
    ctx.globalAlpha = 1;
  }
}

/**
 * What the wide panning column's elevation digits read as.
 *
 * On the sphere, ear level is a POSITION — as much a decision as any other
 * height — so a spatial song states it: a placing column shows `00` rather than
 * hiding it under the dots that mean "this field says nothing". A planar song
 * has no height to state, and under a SLIDE selector the field is reserved, so
 * both keep the dots.
 */
export function elevationCellText(el, op, spatial) {
  if (el !== 0) return hex2(el & 0xff);
  return spatial && op === "set" ? "00" : "··";
}

/** Three-digit hex, for the wide panning column's 9-bit azimuth. */
function hex3(v) {
  return (v & 0x1ff).toString(16).toUpperCase().padStart(3, "0");
}
