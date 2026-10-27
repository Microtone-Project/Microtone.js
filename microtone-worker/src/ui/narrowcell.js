// Narrow Timeline cells (item 254) — pure layout, no DOM.
//
// The full cell is 21 to 30 characters, so a screen holds a handful of lanes;
// a song on 32 or 64 of them cannot be WATCHED whole. The narrow modes trade
// columns for lanes: each cell is cut down to one or two SLOTS, and a slot
// shows the first of its columns that has anything in it.
//
//   mode 0  the full cell
//   mode 1  slot A {note+inst, effect, effect 2} · slot B {volume, panning}
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
// A slot is 7 characters, the width of "♯C-4 01" — an effect ("A0F00") fits
// inside it — and slot B starts after a space, 3 characters (6 in a wide cell,
// whose panning column carries the elevation too).

import {
  SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG, SUB_FX2_OP, SUB_FX2_ARG,
  subIsEmpty,
} from "./edit.js";

export const CELLS_FULL = 0;
export const CELLS_TWO = 1;
export const CELLS_ONE = 2;
/** How many modes the toolbox button cycles through. */
export const CELL_MODES = 3;

/** The columns a slot can show — one element per logical column, except that
 *  the note and the instrument travel together, as the pitch plot does. */
export const EL_NOTE = 0, EL_FX = 1, EL_FX2 = 2, EL_VOL = 3, EL_PAN = 4;

const SLOT_A_CHARS = 7;
const SLOT_B_CHAR = SLOT_A_CHARS + 1;

/** Characters per cell in a narrow mode (mode 0 keeps edit.js cellChars). */
export function narrowCellChars(mode, wide) {
  return mode === CELLS_TWO ? SLOT_B_CHAR + (wide ? 6 : 3) : SLOT_A_CHARS;
}

/**
 * Which columns of a row have anything to show. `ghost` says what a ghost
 * fills there (the grids paint ghosts in the same places as writing, so they
 * count as shown): `{note, inst, fx, vol, pan}` booleans, any of them absent.
 * `fx2` is whether the lane shows its second effect at all — a hidden one is
 * no more in the narrow cell than in the full one.
 */
export function cellPresence(cell, ghost = null, fx2 = false) {
  return {
    note: cell.note !== 0 || cell.instrment !== 0 || !!ghost?.note || !!ghost?.inst,
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
 *  drawn in decides `char`. */
function elementWalk(el, slotChar, wide) {
  switch (el) {
    case EL_NOTE: return [[SUB_NOTE, 0, slotChar], [SUB_INST, 0, slotChar + 5], [SUB_INST, 1, slotChar + 6]];
    case EL_FX: return [[SUB_FX_OP, 0, slotChar], ...[0, 1, 2, 3].map((n) => [SUB_FX_ARG, n, slotChar + 1 + n])];
    case EL_FX2: return [[SUB_FX2_OP, 0, slotChar], ...[0, 1, 2, 3].map((n) => [SUB_FX2_ARG, n, slotChar + 1 + n])];
    case EL_VOL: return [0, 1, 2].map((n) => [SUB_VOL, n, slotChar + n]);
    case EL_PAN: return Array.from({ length: wide ? 6 : 3 }, (_, n) => [SUB_PAN, n, slotChar + n]);
    default: return [];
  }
}

/** The element a sub-column belongs to. */
function elementOf(sub) {
  switch (sub) {
    case SUB_NOTE: case SUB_INST: return EL_NOTE;
    case SUB_VOL: return EL_VOL;
    case SUB_PAN: return EL_PAN;
    case SUB_FX2_OP: case SUB_FX2_ARG: return EL_FX2;
    default: return EL_FX;
  }
}

/** The character each shown element starts at: `{[el]: char}`. A painter
 *  draws exactly the elements this names, there. */
export function narrowOrigins(shown) {
  const out = {};
  out[shown[0]] = 0;
  if (shown.length > 1) out[shown[1]] = SLOT_B_CHAR;
  return out;
}

/** The row's whole cursor walk, slot A then slot B: [[sub, nib, char], …]. */
export function narrowWalk(shown, wide) {
  const walk = elementWalk(shown[0], 0, wide);
  if (shown.length > 1) walk.push(...elementWalk(shown[1], SLOT_B_CHAR, wide));
  return walk;
}

/**
 * Seat a cursor that wants column `sub`/`nib` on a row showing `shown`:
 * `[sub, nib]` of the position it lands on. The wanted column's slot decides
 * which slot (volume and panning are slot B's, everything else slot A's, and
 * in mode 2 there is only A); inside it, the same POSITION in whatever the
 * slot shows — the second nibble of an instrument wanted on a row showing an
 * effect is the effect's first argument digit.
 */
export function narrowResolve(shown, wide, sub, nib) {
  const wantEl = elementOf(sub);
  const slot = shown.length > 1 && (wantEl === EL_VOL || wantEl === EL_PAN) ? 1 : 0;
  const el = shown[slot];
  const own = elementWalk(wantEl, 0, wide);
  let idx = own.findIndex(([s, n]) => s === sub && n === nib);
  if (idx < 0) idx = 0;
  const walk = elementWalk(el, 0, wide);
  const [s, n] = walk[Math.min(idx, walk.length - 1)];
  return [s, n];
}

/** The character a seated position is drawn at, or 0 if the row does not
 *  show it. */
export function narrowCharPos(shown, wide, sub, nib) {
  const hit = narrowWalk(shown, wide).find(([s, n]) => s === sub && n === nib);
  return hit ? hit[2] : 0;
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
