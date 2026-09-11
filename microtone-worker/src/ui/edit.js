// Pattern-cell edit interpreter — pure functions (Node-testable), glued to the
// canvas views by timeline.js. Column model per cell:
//   sub 0 = note, 1 = instrument (2 nibbles), 2 = volume, 3 = panning,
//   sub 4 = effect opcode (base-36), 5 = effect arg (4 nibbles),
//   sub 6 = SECOND effect opcode, 7 = its arg — format version 3 only, and only
//           while that column is exposed (§5.5; see the `fx2` flag below).
// The vol and pan columns are three positions wide: the SYMBOL cell (which
// operation the column carries) followed by the two argument digits — item 87.
// The jam map mirrors taut.js SC_JAM: physical-position piano on the A-row
// (KeyA..KeyK white, KeyW/E/T/Y/U black) — layout-independent via e.code.
//
// Every geometry table below is a FUNCTION of two document/view properties —
// `wide` (the v3 cell) and `fx2` (its second effect column exposed) — so one
// pair of booleans drives the painter, hit-testing, the cursor walk and the
// selection highlight alike. `fx2` is meaningless without `wide`: the 8-byte
// cell has no second effect to show.

import { MIDDLE_C } from "../engine/constants.js";
import { EffectOp } from "../engine/tables.js";
import { stepNoteInTable, isAbsolute, snapToAbsoluteDegree } from "./pitchtables.js";

export const SUB_NOTE = 0;
export const SUB_INST = 1;
export const SUB_VOL = 2;
export const SUB_PAN = 3;
export const SUB_FX_OP = 4;
export const SUB_FX_ARG = 5;
export const SUB_FX2_OP = 6;
export const SUB_FX2_ARG = 7;
export const NUM_SUBS = 8;
// vol/pan: [symbol][argument hi][argument lo]
export const SUB_NIBBLES = [1, 2, 3, 3, 1, 4];
// Format version 3's WIDE cell (file format §5.5) spends the extra room on the
// panning column: [symbol][elevation hi][elevation lo][azimuth ×3]. The volume
// column keeps its three positions — its value simply became a whole byte.
export const SUB_NIBBLES_WIDE = [1, 2, 3, 6, 1, 4];
// …and with the second effect exposed, one more opcode + 4-nibble argument.
export const SUB_NIBBLES_WIDE_FX2 = [1, 2, 3, 6, 1, 4, 1, 4];

/** Sub-column widths for the cell format + column set in play. */
export function subNibbles(wide, fx2 = false) {
  if (!wide) return SUB_NIBBLES;
  return fx2 ? SUB_NIBBLES_WIDE_FX2 : SUB_NIBBLES_WIDE;
}

// ── shared cell layout (Timeline + Pattern views) ──
// "♯C-4 01 v3F p20 A0F00": note glyphs 0-3, inst 5-6, vol 8-10, pan 12-14,
// fx 16-20 → 21 chars per cell. The wide cell inserts three more characters in
// the panning column: "♯C-4 01 vFF p40 180 A0F00" → 24, and exposing the second
// effect appends a sixth group after a separating space: "… A0F00 M8000" → 30.
export const CELL_CHARS = 21;
export const CELL_CHARS_WIDE = 24;
export const CELL_CHARS_WIDE_FX2 = 30;

/** Characters per cell for the format + column set in play. */
export function cellChars(wide, fx2 = false) {
  if (!wide) return CELL_CHARS;
  return fx2 ? CELL_CHARS_WIDE_FX2 : CELL_CHARS_WIDE;
}

/**
 * Lookahead-scroll (item 42): given a cursor position, the current scroll
 * offset, the number of visible cells and the max scroll, return the new scroll
 * so the cursor stays inside the central 64% of the viewport — the view scrolls
 * only when the cursor enters the 18% edge band, and just enough to return it to
 * that band's boundary. Within the band the scroll is unchanged (keeps any
 * fractional wheel offset). Used by every grid view's cursor-follow.
 */
export function lookahead(pos, scroll, vis, maxScroll) {
  const clamp = (v) => Math.min(Math.max(v, 0), Math.max(0, maxScroll));
  if (vis <= 0) return clamp(scroll);
  const edge = Math.max(1, Math.floor(vis * 0.18));
  const top = Math.floor(scroll);
  if (pos < top + edge) return clamp(pos - edge);
  if (pos > top + vis - 1 - edge) return clamp(pos - (vis - 1 - edge));
  return clamp(scroll); // cursor already inside the central 64%
}

/** Wheel-scroll step quantized to a multiple of `quantum`, carrying the remainder forward so no distance is lost. */
export function wheelStep(remainder, rawDelta, quantum = 4) {
  const total = remainder + rawDelta;
  const step = Math.trunc(total / quantum) * quantum;
  return { step, remainder: total - step };
}

/** Cursor sub-position walk order within one channel: [sub, nib] pairs. */
function buildPositions(nibbles) {
  const out = [];
  for (let sub = 0; sub < nibbles.length; sub++) {
    for (let nib = 0; nib < nibbles[sub]; nib++) out.push([sub, nib]);
  }
  return out;
}
export const SUB_POSITIONS = buildPositions(SUB_NIBBLES);
export const SUB_POSITIONS_WIDE = buildPositions(SUB_NIBBLES_WIDE);
export const SUB_POSITIONS_WIDE_FX2 = buildPositions(SUB_NIBBLES_WIDE_FX2);

/** Walk order for the format + column set in play. */
export function subPositions(wide, fx2 = false) {
  if (!wide) return SUB_POSITIONS;
  return fx2 ? SUB_POSITIONS_WIDE_FX2 : SUB_POSITIONS_WIDE;
}

/** The LAST sub-column of a cell — what a "whole cell" selection reaches to.
 *  A hidden second effect is outside the selection, and stays untouched by the
 *  block operations, which is the whole point of hiding it. */
export function lastSub(fx2 = false) { return fx2 ? SUB_FX2_ARG : SUB_FX_ARG; }

/**
 * Is the given sub-column of `cell` empty — i.e. rendered as dots? Wheel-edit
 * skips empty sub-columns, so a wheel tick over a dot only scrolls the view and
 * never conjures a value out of nothing. The dot conditions mirror the painters
 * (timeline.js / pattern.js) and the *ToStr helpers in notenames.js.
 *   note: a pitched note (>= 0x20) is wheel-steppable, and so is an interrupt
 *         marker ($0010..$001F), whose number is a value like any other (item
 *         181). 0, the key-off/cut/fade sentinels and the reserved words are
 *         "nothing to step": they are commands, not quantities, and nudging
 *         one into a pitch would be a silent, surprising edit.
 *   fx  : the opcode + arg share one visual column, empty only when both are 0.
 */
export function subIsEmpty(sub, cell) {
  switch (sub) {
    case SUB_NOTE: return cell.note < 0x0010; // below the Int markers: 0 and the command sentinels
    case SUB_INST: return cell.instrment === 0;
    case SUB_VOL: return cell.volumeEff === 3 && cell.volume === 0;
    case SUB_PAN:
      // A wide cell's panning column is the azimuth AND the elevation; either
      // one carrying something makes the column non-empty (§5.5).
      return cell.panEff === 3 && cell.pan === 0 &&
             (cell.azimuth ?? 0) === 0 && (cell.elevation ?? 0) === 0;
    case SUB_FX_OP:
    case SUB_FX_ARG: return cell.effect === 0 && cell.effectArg === 0;
    case SUB_FX2_OP:
    case SUB_FX2_ARG: return (cell.effect2 ?? 0) === 0 && (cell.effectArg2 ?? 0) === 0;
    default: return true;
  }
}

// The second effect's character group sits after the first one's, separated by
// the same single space every other group is: fx1 is 19…23 in a wide cell, so
// fx2 is 25…29.
const FX2_OP_CHAR = 25;

/** Character offset + width of a sub-position inside the cell. */
export function subCharPos(sub, nib, wide = false) {
  switch (sub) {
    case SUB_NOTE: return [0, 4];         // 4 glyph slots
    case SUB_INST: return [5 + nib, 1];
    case SUB_VOL: return [8 + nib, 1];    // char 8 is the symbol cell
    case SUB_PAN: return [12 + nib, 1];   // char 12 is the symbol cell
    case SUB_FX_OP: return [(wide ? 19 : 16), 1];
    case SUB_FX_ARG: return [(wide ? 20 : 17) + nib, 1];
    case SUB_FX2_OP: return [FX2_OP_CHAR, 1];
    case SUB_FX2_ARG: return [FX2_OP_CHAR + 1 + nib, 1];
    default: return [0, 1];
  }
}

// ── logical clipboard columns ──
// Coarser than the sub-cursor positions: note / inst / vol / pan / fx / fx2 (an
// effect's opcode + arg are ONE column). Block copy/paste records which of these
// a selection covers, so a partial-column paste overwrites only those bytes.
export const COL_NOTE = 0, COL_INST = 1, COL_VOL = 2, COL_PAN = 3, COL_FX = 4, COL_FX2 = 5;
export const ALL_COLS = [COL_NOTE, COL_INST, COL_VOL, COL_PAN, COL_FX, COL_FX2];
/** Raw cell byte offsets each logical column occupies. The 8-byte cell has no
 *  second effect, so COL_FX2 claims nothing there and is a harmless no-op. */
export const COL_BYTES = [[0, 1], [2], [3], [4], [5, 6, 7], []];
/**
 * The same thing for either format, as [offset, mask] pairs — the wide cell's
 * byte 8 carries BOTH column selectors (and the azimuth's ninth bit), so a
 * per-column copy has to work in bits there, not whole bytes.
 */
export function colByteMasks(wide) {
  if (!wide) return COL_BYTES.map((bs) => bs.map((b) => [b, 0xff]));
  return [
    [[0, 0xff], [1, 0xff]],                       // note
    [[2, 0xff]],                                  // instrument
    [[3, 0xff], [8, 0x70]],                       // volume value + its selector
    [[4, 0xff], [9, 0xff], [8, 0x8f]],            // azimuth low + elevation + A/selector
    [[5, 0xff], [6, 0xff], [7, 0xff]],            // effect 1
    [[10, 0xff], [11, 0xff], [12, 0xff]],         // effect 2 (§5.5)
  ];
}
/** Inclusive [startChar, endChar] span of each column within the cell (for the
 *  selection highlight); contiguous, covering all CELL_CHARS. The last entry is
 *  degenerate wherever the second effect has no characters of its own, so
 *  `range[colHi][1]` is safe to read whatever the layout. */
export const COL_CHAR_RANGE = [[0, 5], [5, 8], [8, 12], [12, 16], [16, 21], [21, 21]];
export const COL_CHAR_RANGE_WIDE = [[0, 5], [5, 8], [8, 12], [12, 19], [19, 24], [24, 24]];
export const COL_CHAR_RANGE_WIDE_FX2 =
  [[0, 5], [5, 8], [8, 12], [12, 19], [19, 24], [24, 30]];

/** Column spans for the format + column set in play. */
export function colCharRange(wide, fx2 = false) {
  if (!wide) return COL_CHAR_RANGE;
  return fx2 ? COL_CHAR_RANGE_WIDE_FX2 : COL_CHAR_RANGE_WIDE;
}

/** Logical column of a sub-cursor position (each effect's op and arg collapse
 *  onto that effect's column). */
export function subToCol(sub) {
  if (sub <= COL_PAN) return sub;
  return sub <= SUB_FX_ARG ? COL_FX : COL_FX2;
}

/** Logical column ids spanned by an inclusive sub-cursor range [subA..subB]. */
export function colsForSubs(subA, subB) {
  const lo = subToCol(Math.min(subA, subB)), hi = subToCol(Math.max(subA, subB));
  const cols = [];
  for (let c = lo; c <= hi; c++) cols.push(c);
  return cols;
}

/** Map a character offset within a cell to [sub, nib]. */
export function charToSub(charX, wide = false, fx2 = false) {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const fxOp = wide ? 19 : 16;
  const panWidth = wide ? 6 : 3;
  if (wide && fx2) {
    // The space between the two effect groups belongs to the first one, so a
    // click that lands just past effect 1's last digit stays on it.
    if (charX >= FX2_OP_CHAR + 1) {
      return [SUB_FX2_ARG, clamp(Math.floor(charX - FX2_OP_CHAR - 1), 0, 3)];
    }
    if (charX >= FX2_OP_CHAR) return [SUB_FX2_OP, 0];
  }
  if (charX >= fxOp + 1) return [SUB_FX_ARG, clamp(Math.floor(charX - fxOp - 1), 0, 3)];
  if (charX >= fxOp) return [SUB_FX_OP, 0];
  if (charX >= 12) return [SUB_PAN, clamp(Math.floor(charX - 12), 0, panWidth - 1)];
  if (charX >= 8) return [SUB_VOL, clamp(Math.floor(charX - 8), 0, 2)];
  if (charX >= 5) return [SUB_INST, clamp(Math.floor(charX - 5), 0, 1)];
  return [SUB_NOTE, 0];
}

// ── the volume / panning column (item 87) ──
// One byte: 2-bit selector + 6-bit value (engine applyVolColumn /
// applyPanColumn). The five operations a column can carry:
//   "set"       SEL_SET  — set the volume / panning outright (00..3F)
//   "up"/"down" SEL_UP / SEL_DOWN — per-tick slide (louder/quieter, R/L)
//   "fineUp"/"fineDown"  SEL_FINE — one-shot delta, magnitude in the low 5
//                        bits and DIRECTION in bit 5 (set = louder / rightward,
//                        AudioAdapter.kt:2980 + 3001)
//   "none"      the SEL_FINE-with-0 no-op sentinel ($C0) — an empty cell
// So a fine slide's argument is always the magnitude 00..1F, and the symbol
// carries its sign; the engine's 20..3F halves never surface in the UI.
const SEL_FINE = 3, FINE_DIR = 0x20, FINE_MAG = 0x1f;

/**
 * What one column can hold, per format (file format §5.5). The narrow cell's
 * six bits become a whole byte for volume and a NINE-bit azimuth for panning,
 * and FINE's direction flag rides the top bit of whichever field it is — so
 * every rule below is the same rule, read off this spec.
 */
export function colSpec(isPan, wide) {
  if (!wide) return { max: 0x3f, dir: FINE_DIR, mag: FINE_MAG, digits: 2 };
  if (!isPan) return { max: 0xff, dir: 0x80, mag: 0x7f, digits: 2 };
  return { max: 0x1ff, dir: 0x100, mag: 0xff, digits: 3 };
}

/** The operation a vol/pan byte encodes. */
export function volPanOp(value, sel, isPan = false, wide = false) {
  if (sel !== SEL_FINE) return ["set", "up", "down"][sel] ?? "set";
  if (value === 0) return "none";
  return (value & colSpec(isPan, wide).dir) !== 0 ? "fineUp" : "fineDown";
}

/** The argument as DISPLAYED and TYPED: a fine slide's magnitude, the plain
 *  value for everything else. */
export function volPanArg(value, sel, isPan = false, wide = false) {
  const sp = colSpec(isPan, wide);
  return sel === SEL_FINE ? (value & sp.mag) : (value & sp.max);
}

/** Signed one-shot delta a fine byte encodes (0 for any other selector). */
export function fineSigned(value, sel, isPan = false, wide = false) {
  if (sel !== SEL_FINE) return 0;
  const sp = colSpec(isPan, wide);
  const mag = value & sp.mag;
  return (value & sp.dir) !== 0 ? mag : -mag;
}

/** Byte value for a signed fine delta; 0 (the no-op sentinel) at zero. */
export function fineValue(signed, isPan = false, wide = false) {
  const sp = colSpec(isPan, wide);
  const mag = Math.min(Math.abs(signed), sp.mag);
  return mag === 0 ? 0 : (signed > 0 ? sp.dir | mag : mag);
}

/** setCellOp fields naming whichever column `isPan` selects. In a wide cell the
 *  panning column's value IS the azimuth — `pan` is the narrow cell's field. */
function vpFields(isPan, value, sel, wide = false) {
  if (!isPan) return { volume: value, volumeEff: sel };
  return wide ? { azimuth: value, panEff: sel } : { pan: value, panEff: sel };
}

/** …wrapped as an interpretBracketKey action. */
function vpFieldsFor(isPan, value, sel, wide = false) {
  return { fields: vpFields(isPan, value, sel, wide) };
}

/** Read a cell's vol or pan column as {value, sel, arg, op, empty}. */
export function volPanState(isPan, cell, wide = false) {
  const sp = colSpec(isPan, wide);
  const raw = isPan ? (wide ? cell.azimuth : cell.pan) : cell.volume;
  const value = raw & sp.max;
  const sel = (isPan ? cell.panEff : cell.volumeEff) & 3;
  return {
    value, sel, wide,
    arg: volPanArg(value, sel, isPan, wide),
    op: volPanOp(value, sel, isPan, wide),
    // "Empty" here is strictly the FINE-0 sentinel — what decides how the next
    // typed digit is READ. Whether the COLUMN looks blank on screen is a wider
    // question (a wide cell's elevation counts): that is subIsEmpty's job.
    empty: sel === SEL_FINE && value === 0,
  };
}

/**
 * Switch the column to operation `op`, keeping the argument the user can see:
 * an existing value is re-interpreted under the new operation rather than
 * cleared. A fine slide can't carry a zero argument (that byte IS the no-op
 * sentinel), so selecting one on a blank argument seeds a magnitude of 1.
 * Selecting "set" on an already-empty cell is a no-op — there is nothing to
 * re-interpret, and conjuring "set volume 00" out of an empty cell (from the
 * Delete key, no less) would silence the note.
 * Returns setCellOp fields, or null when nothing changes.
 */
export function volPanSelect(isPan, op, cell, wide = false) {
  const st = volPanState(isPan, cell, wide);
  const sp = colSpec(isPan, wide);
  let value, sel;
  switch (op) {
    case "set": if (st.empty) return null; value = st.arg; sel = 0; break;
    case "up": value = st.arg; sel = 1; break;
    case "down": value = st.arg; sel = 2; break;
    case "fineUp": value = sp.dir | Math.max(1, st.arg & sp.mag); sel = SEL_FINE; break;
    case "fineDown": value = Math.max(1, st.arg & sp.mag); sel = SEL_FINE; break;
    case "none": value = 0; sel = SEL_FINE; break;
    default: return null;
  }
  if (value === st.value && sel === st.sel) return null;
  return vpFields(isPan, value, sel, wide);
}

/**
 * Type hex digit `d` into argument nibble `nib` (1 = most significant) of the
 * vol/pan column. A fine slide's magnitude is one bit narrower than the field
 * it lives in, so its top digit is masked accordingly, and typing it down to
 * zero clears the cell exactly as the no-op sentinel would. An empty cell
 * promotes to SET.
 */
export function volPanDigit(isPan, cell, nib, d, wide = false) {
  const st = volPanState(isPan, cell, wide);
  const sp = colSpec(isPan, wide);
  const shift = (sp.digits - nib) * 4;       // nib 1 = the most significant digit
  const place = (base, digit) => (base & ~(0xf << shift)) | ((digit & 0xf) << shift);
  if (st.sel === SEL_FINE && !st.empty) {
    const mag = place(st.arg, d) & sp.mag;
    return vpFields(isPan, mag === 0 ? 0 : ((st.value & sp.dir) | mag), SEL_FINE, wide);
  }
  const sel = st.empty ? 0 : st.sel;
  return vpFields(isPan, place(st.arg, d) & sp.max, sel, wide);
}

/** Wheel/step the column by `dir`: the signed delta for a fine slide (it never
 *  steps through zero — that direction is the symbol cell's business), the
 *  plain value otherwise. Null when nothing moves. */
export function volPanStep(isPan, cell, dir, wide = false) {
  const st = volPanState(isPan, cell, wide);
  const sp = colSpec(isPan, wide);
  if (st.sel === SEL_FINE) {
    const signed = fineSigned(st.value, st.sel, isPan, wide) + dir;
    if (signed === 0 || Math.abs(signed) > sp.mag) return null;
    return vpFields(isPan, fineValue(signed, isPan, wide), SEL_FINE, wide);
  }
  const value = Math.min(Math.max(st.value + dir, 0), sp.max);
  return value === st.value ? null : vpFields(isPan, value, st.sel, wide);
}

// ── the wide cell's elevation field (§5.5) ───────────────────────────────
// Two digits of a SIGNED byte, sitting between the panning column's symbol and
// its azimuth. It is a position, not an operation, so it has no selector of its
// own: it is meaningful under SET and reserved under the slides.

/** Type hex digit `d` into elevation nibble `nib` (0 = high, 1 = low). A height
 *  typed into an untouched column promotes it to SET — otherwise the column
 *  would carry a position under the FINE-0 sentinel, which the engine ignores. */
export function elevationDigit(cell, nib, d) {
  const cur = cell.elevation & 0xff;
  const shift = nib === 0 ? 4 : 0;
  const raw = ((cur & ~(0xf << shift)) | ((d & 0xf) << shift)) & 0xff;
  const fields = { elevation: raw >= 0x80 ? raw - 0x100 : raw };
  if (cell.panEff === 3 && (cell.azimuth & 0x1ff) === 0) fields.panEff = 0;
  return fields;
}

/** Step the elevation by `dir`, clamped to the signed byte it lives in. */
export function elevationStep(cell, dir) {
  const v = Math.min(Math.max(cell.elevation + dir, -128), 127);
  return v === cell.elevation ? null : { elevation: v };
}

/**
 * Symbol-cell keys (item 87). Returns the chosen operation, or null.
 *   vol: '^'/'u' slide up · 'v'/'d' slide down · '+'/'=' fine up · '-' fine down
 *   pan: '>'/'r' slide right · '<'/'l' slide left · '+'/'=' fine right (up) ·
 *        '-' fine left (down)
 *   both: '.' / Delete / Backspace → plain set
 * Checked on e.key, so the printed key is the one that acts (Shift+6 = '^',
 * Shift+, = '<'), and BEFORE the Delete/Period codes — Shift+Period is '>'.
 */
export function volPanSymbolKey(isPan, code, key) {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === "+" || k === "=") return "fineUp";
  if (k === "-") return "fineDown";
  if (isPan) {
    if (k === ">" || k === "r") return "up";      // rightward = the positive selector
    if (k === "<" || k === "l") return "down";
  } else {
    if (k === "^" || k === "u") return "up";
    if (k === "v" || k === "d") return "down";
  }
  if (code === "Delete" || code === "Backspace" || code === "Period") return "set";
  return null;
}

// Physical piano rows (KeyboardEvent.code → semitone offset from C), item 133:
//
//   (q) w e (r) t y u (i) o p
//      a s d   f g h j | k l ;
//
// White: a s d f g h j k l ; → C D E F G A B +C +D +E; black: w e t y u o p.
// The three keys the piano has no room for — q, r and i, sitting where a black
// key would be if B–C and E–F had one — are the MICROTONAL keys: the half-sharp
// (demisharp) of the white key to their left, so a quarter-tone-bearing table
// is reachable from the keyboard instead of only by wheel-stepping a neighbour.
// Fractional offsets are fine: semiToNote/semiToNoteInTable both round into the
// 4096-per-octave note grid, so on a 12-TET song these sound (and display, with
// a cents marker) as true quarter-tones.
export const JAM_SEMIS = Object.freeze({
  KeyQ: -0.5,
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyR: 4.5, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyI: 11.5, KeyK: 12,
  KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
});

/** Whether the note column is showing raw hex words (the Raw toggle is on, or
 *  the notation preset is Raw — no degree table). When true the note column
 *  accepts raw hex entry instead of the piano jam / sentinels. */
export function rawNoteView(rawToggle, preset) {
  return !!rawToggle || !preset || preset.table.length === 0;
}

/** 12-EDO note word for semitone offset from C at `octave` (C4 = MIDDLE_C). */
export function semiToNote(octave, semi) {
  const val = MIDDLE_C + (octave - 4) * 4096 + Math.round((semi * 4096) / 12);
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/**
 * Notation-aware jam note: map a 12-EDO semitone (-0.5..16 across the two jam
 * rows) to a note word in the active pitch table by snapping the semitone's
 * fractional period position to the NEAREST table degree — the port of taut.js
 * semitoneToNote. So a non-12-TET song's keyboard plays that tuning's degrees
 * (CDEFGAB… mapped into its grid) instead of fixed 12-EDO. The Raw preset
 * (empty table) and 12-TET fall back to the exact 12-EDO note.
 */
export function semiToNoteInTable(octave, semi, preset) {
  if (!preset || preset.table.length === 0 || preset.index === 120) {
    return semiToNote(octave, semi);
  }
  // An absolute (`interval: 0`) table — e.g. ProTracker pitch — has no period
  // lattice, so the period-wrap loop below would spin forever (pos -= 0). Map
  // the jam key to its 12-EDO pitch and snap to the nearest expressible degree.
  if (isAbsolute(preset)) {
    return snapToAbsoluteDegree(semiToNote(octave, semi), preset);
  }
  const interval = preset.interval;
  const table = preset.table;
  let pos = Math.round((semi / 12) * interval);
  let carry = 0;
  while (pos >= interval) { pos -= interval; carry++; } // semitone 12 wraps to next period root
  while (pos < 0) { pos += interval; carry--; }         // q (semitone -0.5) borrows from the period below
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - pos);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  // The next period's root (one interval up) can be the true nearest degree.
  let off = table[bestIdx], periodAdj = carry;
  if (interval - pos < bestDist) { off = table[0]; periodAdj = carry + 1; }
  const val = MIDDLE_C + (octave - 4) * interval + periodAdj * interval + off;
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/** Next/previous selectable instrument slot from `cur`, stepping by `step`
 *  (+1 = up, -1 = down) through the ascending `slots` list. Off-list current
 *  values jump to the nearest slot in the step direction. Null if none. */
function stepInstSlot(cur, step, slots) {
  if (!slots || slots.length === 0) return null;
  cur &= 0xff;
  const i = slots.indexOf(cur);
  if (i < 0) {
    if (step > 0) return slots.find((s) => s > cur) ?? slots[slots.length - 1];
    for (let k = slots.length - 1; k >= 0; k--) if (slots[k] < cur) return slots[k];
    return slots[0];
  }
  return slots[Math.min(Math.max(i + step, 0), slots.length - 1)];
}

/**
 * One step of the note column, for the two controls that nudge a cell in place
 * — the mouse wheel and the bracket keys.
 *
 * Three kinds of note word behave differently, and only one of them is a pitch:
 * an interrupt marker (item 181) walks Int0…IntF and clamps at both ends, so a
 * stray step cannot tip it into the reserved space below or a pitch above; a
 * real note steps by one degree of the active pitch table; every other
 * sentinel holds still, since stepping "key-off" by a degree means nothing.
 * Both callers already refuse the third case (subIsEmpty gates the wheel, and
 * the bracket keys return early), so that branch is belt and braces — but it
 * is what keeps this function safe to call on any cell.
 */
export function stepNoteCell(note, preset, dir) {
  if (note >= 0x0010 && note <= 0x001f) {
    return Math.min(Math.max(note + dir, 0x0010), 0x001f);
  }
  if (note < 0x20) return note;
  return stepNoteInTable(note, preset, dir);
}

/**
 * Contextual bracket-key edit (items 47.2 + 47.6). `dir` is -1 for '[' / +1 for
 * ']'; `shift` selects the '{' / '}' variant. This handles ONLY the record-mode,
 * cursor-on-a-column edits; the not-record global bindings ([ ] octave, { }
 * instrument) live in app.js. Per-column behaviour (following the 47.6 table,
 * with the note column overridden by the 47.2 choice — octave / semitone):
 *   note: [ ] octave down/up      · Shift {} one semitone/step down/up
 *   inst: [ prev inst · ] next    · Shift same
 *   vol : [ vol- · ] vol+         · Shift {} FINE selector, value ∓1
 *   pan : [ pan- (L) · ] pan+ (R) · Shift {} FINE selector, ∓1 toward L/R
 *   fx  : no-op
 * ctx: { preset, instSlots } (instSlots = ascending selectable slots).
 * Returns { fields } for setCellOp, or null (unhandled / nothing to change).
 */
export function interpretBracketKey(dir, shift, sub, cell, ctx) {
  const clampV = (v) => (v < 0 ? 0 : v > 0x3f ? 0x3f : v);
  switch (sub) {
    case SUB_NOTE: {
      // Interrupt markers are the one sentinel with a VALUE in it (item 181):
      // `[`/`]` walk Int0…IntF, and Shift does the same, since the number has
      // no coarse and fine axis to tell apart.
      if (cell.note >= 0x0010 && cell.note <= 0x001f) {
        const note = stepNoteCell(cell.note, ctx.preset, dir);
        return note === cell.note ? null : { fields: { note } };
      }
      if (cell.note < 0x20) return null; // other sentinels / empty: no pitch to nudge
      const interval = ctx.preset?.interval || 0x1000;
      const note = shift
        ? stepNoteInTable(cell.note, ctx.preset, dir)                        // semitone/step
        : Math.min(Math.max(cell.note + dir * interval, 0x20), 0xffff);      // octave/period
      return note === cell.note ? null : { fields: { note } };
    }
    case SUB_INST: {
      // '[' = prev instrument (dn), ']' = next (up). '{'/'}' behave the same.
      const instrment = stepInstSlot(cell.instrment, dir > 0 ? +1 : -1, ctx.instSlots);
      return instrment == null || instrment === cell.instrment ? null : { fields: { instrment } };
    }
    case SUB_VOL:
    case SUB_PAN: {
      const isPan = sub === SUB_PAN;
      const st = volPanState(isPan, cell);
      if (shift) {
        // FINE selector, SIGNED delta ∓1 — the symbol carries the direction now
        // (item 87), so '{' walks +2 → +1 → −1 → −2 rather than wrapping round
        // the raw byte into a 31-unit slide the other way.
        // Stepping a ∓1 through zero lands on the no-op sentinel, i.e. clears.
        const value = fineValue(fineSigned(st.value, st.sel) + dir);
        return value === st.value && st.sel === 3
          ? null : vpFieldsFor(isPan, value, 3);
      }
      // '[' = quieter / toward L, ']' = louder / toward R.
      if (st.empty) return vpFieldsFor(isPan, 0x20, 0); // default set / centre
      const value = clampV(st.value + dir);
      return value === st.value ? null : vpFieldsFor(isPan, value, st.sel);
    }
    default: return null; // fx op/arg: no-op
  }
}

function hexDigit(key) {
  if (key.length !== 1) return -1;
  const c = key.toLowerCase().charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/** Keys that blank a cell column: Delete, '.', and (item 86) Backspace — one
 *  key for "erase" on the pattern grids, whichever one the hand reaches for. */
function isClearKey(code) {
  return code === "Delete" || code === "Backspace" || code === "Period";
}

function base36Digit(key) {
  if (key.length !== 1) return -1;
  const c = key.toLowerCase().charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 122) return c - 87;
  return -1;
}

/**
 * Interpret an edit-mode keydown against a cell column.
 * @param ev   {code, key, repeat} from the KeyboardEvent (repeat = autorepeat,
 *             which the piano keys ignore)
 * @param sub  cursor sub-column, nib nibble index within it
 * @param cell current TaudPlayData (read-only here)
 * @param ctx  {octave, currentInst, preset, wideCells} — preset = active pitch
 *             table; wideCells marks a format-v3 project
 * @returns null (unhandled) or an action:
 *   {fields, jamNote?, advanceRow?, advanceNib?} — fields go through setCellOp;
 *   advanceRow steps the cursor down (note entry / field completion),
 *   advanceNib moves within the field.
 */
export function interpretEditKey(ev, sub, nib, cell, ctx) {
  const { code, key } = ev;

  const wide = ctx.wideCells === true;

  if (sub === SUB_NOTE) {
    // Raw hex note entry — active whenever the note column shows raw hex words
    // (Raw toggle on, or a Raw notation preset). Hex digits shift into the
    // 16-bit note word (left-to-right), OVERRIDING the piano jam, the sentinels
    // and any other note-column key; non-hex keys are swallowed so nothing jams.
    if (ctx.rawHex) {
      if (isClearKey(code)) {
        return { fields: { note: 0, instrment: 0 }, advanceRow: true };
      }
      const d = hexDigit(key);
      if (d < 0) return { consumed: true }; // swallow (no jam / no sentinel), no edit
      return { fields: { note: ((cell.note << 4) | d) & 0xffff } };
    }
    if (code in JAM_SEMIS) {
      // Hardware autorepeat is not a new keypress: a held piano key is ONE
      // note, like a piano. Swallowed (no retrigger, no cell write, no row
      // advance) — the keyup still ends it.
      if (ev.repeat) return { consumed: true };
      const note = semiToNoteInTable(ctx.octave, JAM_SEMIS[code], ctx.preset);
      const fields = { note };
      // Current-instrument auto-adopt (taut behaviour): note entry stamps the
      // active instrument unless the cell already carries one.
      if (ctx.currentInst > 0) fields.instrment = ctx.currentInst;
      return { fields, jamNote: note, advanceRow: true };
    }
    switch (code) {
      // Sentinels: taut z/x/c/v (and ` for key-off), inserted not auditioned.
      // Digit 1/2/3 were removed (item 47.3): they clashed with hex input on the
      // note column; ` is kept because other trackers use it for key-off.
      case "Backquote": case "KeyZ": return { fields: { note: 0x0001 }, advanceRow: true }; // key-off
      case "KeyX": return { fields: { note: 0x0002 }, advanceRow: true };    // note cut
      case "KeyC": return { fields: { note: 0x0003 }, advanceRow: true };    // note fade
      case "KeyV": return { fields: { note: 0x0004 }, advanceRow: true };    // fast fade
      // Interrupt marker (item 181), next key along from the sentinel run:
      // `b` places Int0 and the bracket keys step it to IntF, the same pair
      // that nudges a pitch. The song fires it, the host answers it; nothing
      // about it is audible, so it does not advance the row like a note —
      // an interrupt usually shares its row with the note above it, and
      // stepping the number is the next thing the hand wants to do.
      case "KeyB": return { fields: { note: 0x0010 } };
      case "Delete": case "Backspace": case "Period":
        return { fields: { note: 0, instrment: 0 }, advanceRow: true };
    }
    return null;
  }

  if (sub === SUB_INST) {
    if (isClearKey(code)) {
      return { fields: { instrment: 0 }, advanceRow: true };
    }
    const d = hexDigit(key);
    if (d < 0) return null;
    const cur = cell.instrment & 0xff;
    const val = nib === 0 ? ((d << 4) | (cur & 0x0f)) : ((cur & 0xf0) | d);
    return nib === 0
      ? { fields: { instrment: val }, advanceNib: true }
      : { fields: { instrment: val }, advanceRow: true };
  }

  if (sub === SUB_VOL || sub === SUB_PAN) {
    const isPan = sub === SUB_PAN;
    // The wide cell's panning column is [symbol][elevation ×2][azimuth ×3]; the
    // narrow one (and the volume column in both) is [symbol][value ×2].
    const elevationNib = wide && isPan && nib >= 1 && nib <= 2;
    const lastNib = (wide && isPan ? 5 : 2);

    // nib 0 — the symbol cell: pick the operation, then step onto its argument.
    if (nib === 0) {
      const op = volPanSymbolKey(isPan, code, key);
      if (op === null) {
        // Hex digits fall through to the argument's first digit, so landing on
        // the symbol and typing a value just works. ('d' on the vol column is
        // the down-slide key above, and never a hex digit here.)
        const d = hexDigit(key);
        if (d < 0) return null;
        const fields = wide && isPan
          ? elevationDigit(cell, 0, d)
          : volPanDigit(isPan, cell, 1, d, wide);
        return { fields, advanceNib: true };
      }
      const fields = volPanSelect(isPan, op, cell, wide);
      // A no-change selection still consumes the key (never jams a note).
      return fields ? { fields, advanceNib: true } : { consumed: true };
    }

    // Clear anywhere in the argument: the FINE-0 no-op sentinel, plus the
    // elevation in a wide cell — the whole column goes back to saying nothing.
    if (isClearKey(code)) {
      const fields = isPan
        ? (wide ? { azimuth: 0, elevation: 0, panEff: 3 } : { pan: 0, panEff: 3 })
        : { volume: 0, volumeEff: 3 };
      return { fields, advanceRow: true };
    }
    const d = hexDigit(key);
    if (d < 0) return null;
    const fields = elevationNib
      ? elevationDigit(cell, nib - 1, d)
      : volPanDigit(isPan, cell, wide && isPan ? nib - 2 : nib, d, wide);
    return nib === lastNib ? { fields, advanceRow: true } : { fields, advanceNib: true };
  }

  // Both effect columns are the same column twice over — same base-36 opcode,
  // same 16-bit argument, same keys — so they differ only in which pair of
  // fields the action names (§5.5).
  if (sub === SUB_FX_OP || sub === SUB_FX2_OP) {
    const second = sub === SUB_FX2_OP;
    const opKey = second ? "effect2" : "effect";
    const argKey = second ? "effectArg2" : "effectArg";
    if (isClearKey(code)) {
      return { fields: { [opKey]: 0, [argKey]: 0 }, advanceRow: true };
    }
    // Argument extension (item 162): ':' is outside the base-36 opcode space
    // (the ASCII-symbol range, $A0..$FE — see tables.js EffectOp), so it
    // bypasses base36Digit entirely rather than trying to fit it in.
    if (key === ":") {
      return { fields: { [opKey]: EffectOp.OP_COLON }, advanceNib: true };
    }
    const d = base36Digit(key);
    if (d < 0) return null;
    return { fields: { [opKey]: d }, advanceNib: true }; // move into the arg nibbles
  }

  if (sub === SUB_FX_ARG || sub === SUB_FX2_ARG) {
    const second = sub === SUB_FX2_ARG;
    const argKey = second ? "effectArg2" : "effectArg";
    if (isClearKey(code)) {
      return { fields: { [argKey]: 0 }, advanceRow: true };
    }
    const d = hexDigit(key);
    if (d < 0) return null;
    const shift = (3 - nib) * 4;
    const cur = (second ? cell.effectArg2 : cell.effectArg) ?? 0;
    const val = (cur & ~(0xf << shift)) | (d << shift);
    return nib === 3
      ? { fields: { [argKey]: val & 0xffff }, advanceRow: true }
      : { fields: { [argKey]: val & 0xffff }, advanceNib: true };
  }

  return null;
}
