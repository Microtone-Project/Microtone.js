// Narrow Timeline cells (item 254) — pure layout, no DOM.
//
// The full cell is 21 to 30 characters, so a screen holds a handful of lanes;
// a song on 32 or 64 of them cannot be WATCHED whole. The narrow modes trade
// columns for lanes: each cell is cut down to one or two SLOTS, and a slot
// shows the first of its columns that has anything in it.
//
//   mode 0  the full cell
//   mode 1  slot A {note, effect, effect 2} + instrument · slot B {volume, panning}
//   mode 2  slot A only
//
// Priority runs left to right within the braces: a row with a note shows the
// note even when it also carries an effect, and a row with neither shows
// whichever effect it has. A slot with nothing in it shows its FIRST column
// empty, which is also where typing into it goes.
//
// The cells are for monitoring, but editing stays on: an edit goes to the
// column the slot is SHOWING. So which column the cursor stands on depends on
// the row it is on. The cursor keeps the column it was put on (`want`) and is
// seated, row by row, on the one that row shows (`narrowResolve`) — moving
// down through a note, an effect and a note again comes back to the note,
// rather than wandering off into the effect for good.
//
// Slot A is the full cell's note group, character for character (item 330):
// a FIELD of 4¾ characters — the wide cell's ¾-character pitch prefix and the
// four note cells — then a space and the instrument, which is shown on every
// row whatever the field holds. A note fills the field as it does in the full
// cell (with raw notes on, `56AAB`: the octave digit in the prefix in Motif
// Transport). An effect shares the same five places: its command letter in the
// prefix, in Motif Transport too, and its four digits in the note cells — so a
// raw pitch and an effect read as one column of five. Slot B starts after a
// space, 3 characters, or as wide as a wide cell's panning column is for the
// song's surround model (3, 4 or 6).
//
// Every `wide` below is that panning width: false (the 8-byte cell, 3), a
// number of characters, or true for the widest (6).

import {
  SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG, SUB_FX2_OP, SUB_FX2_ARG,
  NOTE_PREFIX_CHARS, subIsEmpty,
} from "./edit.js";

export const CELLS_FULL = 0;
export const CELLS_TWO = 1;
export const CELLS_ONE = 2;
/** How many modes the toolbox button cycles through. */
export const CELL_MODES = 3;

/** The columns a slot can show — one element per logical column. Slot A's
 *  field shows one of the first three; EL_INST is slot A's instrument, which
 *  every row shows, so it is never chosen — only placed (`narrowOrigins`). */
export const EL_NOTE = 0, EL_FX = 1, EL_FX2 = 2, EL_VOL = 3, EL_PAN = 4, EL_INST = 5;

/** Slot A's field: the pitch prefix and four cells, a note's or an effect's. */
const FIELD_CHARS = NOTE_PREFIX_CHARS + 4;
const INST_CHAR = FIELD_CHARS + 1;
/** Slot A's width: the field, a space, the instrument — the full wide cell's
 *  note group, which the pitch plot spans in either cell. */
export const SLOT_A_CHARS = INST_CHAR + 2;
const SLOT_B_CHAR = SLOT_A_CHARS + 1;

/** Characters per cell in a narrow mode (mode 0 keeps edit.js cellChars). */
export function narrowCellChars(mode, wide) {
  return mode === CELLS_TWO ? SLOT_B_CHAR + panChars(wide) : SLOT_A_CHARS;
}

/** The panning column's characters for a `wide` argument (see above). */
function panChars(wide) {
  return typeof wide === "number" ? wide : wide ? 6 : 3;
}

/**
 * Which columns of a row have anything to show. `ghost` says what a ghost
 * fills there (the grids paint ghosts in the same places as writing, so they
 * count as shown): `{note, fx, vol, pan}` booleans, any of them absent.
 * `fx2` is whether the lane shows its second effect at all — a hidden one is
 * no more in the narrow cell than in the full one. The instrument does not
 * count: it is shown on every row, beside whatever the field shows.
 */
export function cellPresence(cell, ghost = null, fx2 = false) {
  return {
    note: cell.note !== 0 || !!ghost?.note,
    fx: !subIsEmpty(SUB_FX_OP, cell) || !!ghost?.fx,
    fx2: fx2 && !subIsEmpty(SUB_FX2_OP, cell),
    vol: !subIsEmpty(SUB_VOL, cell) || !!ghost?.vol,
    pan: !subIsEmpty(SUB_PAN, cell) || !!ghost?.pan,
  };
}

/** The elements a row's slots show: `[a]` in mode 2, `[a, b]` in mode 1. */
export function narrowShown(mode, present) {
  const a = present.note ? EL_NOTE : present.fx ? EL_FX : present.fx2 ? EL_FX2 : EL_NOTE;
  if (mode !== CELLS_TWO) return [a];
  return [a, present.vol ? EL_VOL : present.pan ? EL_PAN : EL_VOL];
}

/** An element's cursor walk, as [sub, nib, char] in the cell — the slot it is
 *  drawn in decides `char`. An effect's command letter is the field's prefix,
 *  its digits the four cells after it. */
function elementWalk(el, slotChar, wide) {
  const arg = slotChar + NOTE_PREFIX_CHARS;
  switch (el) {
    case EL_NOTE: return [[SUB_NOTE, 0, slotChar]];
    case EL_FX: return [[SUB_FX_OP, 0, slotChar], ...[0, 1, 2, 3].map((n) => [SUB_FX_ARG, n, arg + n])];
    case EL_FX2: return [[SUB_FX2_OP, 0, slotChar], ...[0, 1, 2, 3].map((n) => [SUB_FX2_ARG, n, arg + n])];
    case EL_INST: return [[SUB_INST, 0, slotChar], [SUB_INST, 1, slotChar + 1]];
    case EL_VOL: return [0, 1, 2].map((n) => [SUB_VOL, n, slotChar + n]);
    case EL_PAN: return Array.from({ length: panChars(wide) }, (_, n) => [SUB_PAN, n, slotChar + n]);
    default: return [];
  }
}

/** Slot A's walk for a field showing `el`: the field, then the instrument. */
function slotAWalk(el, wide) {
  return [...elementWalk(el, 0, wide), ...elementWalk(EL_INST, INST_CHAR, wide)];
}

/** The element a sub-column belongs to. */
function elementOf(sub) {
  switch (sub) {
    case SUB_NOTE: return EL_NOTE;
    case SUB_INST: return EL_INST;
    case SUB_VOL: return EL_VOL;
    case SUB_PAN: return EL_PAN;
    case SUB_FX2_OP: case SUB_FX2_ARG: return EL_FX2;
    default: return EL_FX;
  }
}

/** The character each shown element starts at: `{[el]: char}`, the
 *  instrument (EL_INST) always among them. A painter draws exactly the
 *  elements this names, there. */
export function narrowOrigins(shown) {
  const out = {};
  out[shown[0]] = 0;
  out[EL_INST] = INST_CHAR;
  if (shown.length > 1) out[shown[1]] = SLOT_B_CHAR;
  return out;
}

/** The row's whole cursor walk, slot A then slot B: [[sub, nib, char], …]. */
export function narrowWalk(shown, wide) {
  const walk = slotAWalk(shown[0], wide);
  if (shown.length > 1) walk.push(...elementWalk(shown[1], SLOT_B_CHAR, wide));
  return walk;
}

/**
 * Seat a cursor that wants column `sub`/`nib` on a row showing `shown`:
 * `[sub, nib]` of the position it lands on. The instrument is on every row,
 * so it is where it was. Otherwise the wanted column decides the place — slot
 * A's field for the note and the effects, slot B for the volume and the
 * panning (in mode 2 there is no slot B, and those go to slot A as a whole) —
 * and inside it, the same POSITION in whatever the row shows there, or its
 * last: the command letter of an effect wanted on a row showing a note is the
 * note, and so is any of its digits.
 */
export function narrowResolve(shown, wide, sub, nib) {
  const wantEl = elementOf(sub);
  if (wantEl === EL_INST) return [SUB_INST, nib];
  const own = elementWalk(wantEl, 0, wide);
  let idx = own.findIndex(([s, n]) => s === sub && n === nib);
  if (idx < 0) idx = 0;
  const inB = wantEl === EL_VOL || wantEl === EL_PAN;
  const walk = !inB ? elementWalk(shown[0], 0, wide)
    : shown.length > 1 ? elementWalk(shown[1], 0, wide)
      : slotAWalk(shown[0], wide);
  const [s, n] = walk[Math.min(idx, walk.length - 1)];
  return [s, n];
}

/** The character a seated position is drawn at, or 0 if the row does not
 *  show it. */
export function narrowCharPos(shown, wide, sub, nib) {
  const hit = narrowWalk(shown, wide).find(([s, n]) => s === sub && n === nib);
  return hit ? hit[2] : 0;
}

/** The caret over a seated position: `[char, width]`. The note's covers its
 *  whole field, prefix and four cells, as in the full cell; an effect's
 *  command letter, the prefix it sits in; anything else, one character. */
export function narrowCaret(shown, wide, sub, nib) {
  const w = sub === SUB_NOTE ? FIELD_CHARS
    : sub === SUB_FX_OP || sub === SUB_FX2_OP ? NOTE_PREFIX_CHARS : 1;
  return [narrowCharPos(shown, wide, sub, nib), w];
}

/** Character offset within the cell → [sub, nib] of what the row shows there:
 *  the last position starting at or before it. The space between the slots
 *  belongs to slot A, as the space after a column does in the full cell. */
export function narrowCharToSub(charX, shown, wide) {
  const walk = narrowWalk(shown, wide);
  let pick = walk[0];
  for (const p of walk) {
    if (p[2] <= charX) pick = p;
    else break;
  }
  return [pick[0], pick[1]];
}
