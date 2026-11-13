// Narrow Timeline cells (item 254, src/ui/narrowcell.js): which column a slot
// shows, and where a cursor that wants one column is seated on a row showing
// another. The Timeline's painting, hit-testing and cursor walk all read these.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CELLS_TWO, CELLS_ONE, EL_NOTE, EL_FX, EL_FX2, EL_VOL, EL_PAN, EL_INST, SLOT_A_CHARS,
  narrowCellChars, cellPresence, narrowShown, narrowOrigins, narrowWalk, narrowResolve,
  narrowCharPos, narrowCaret, narrowCharToSub,
} from "../../src/ui/narrowcell.js";
import { cellGeom } from "../../src/ui/edit.js";
import {
  SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG, SUB_FX2_OP, SUB_FX2_ARG,
} from "../../src/ui/edit.js";
import { TaudPlayData } from "../../core/engine/state.js";

/** A blank cell (vol/pan carry the SEL_FINE-0 no-op, the blank convention). */
function blank() {
  const c = new TaudPlayData();
  c.volumeEff = 3; c.volume = 0;
  c.panEff = 3; c.pan = 0;
  return c;
}

const shown = (mode, cell, ghost = null, fx2 = false) =>
  narrowShown(mode, cellPresence(cell, ghost, fx2));

test("a slot shows the leftmost column that has anything in it", () => {
  const c = blank();
  assert.deepEqual(shown(CELLS_TWO, c), [EL_NOTE, EL_VOL], "empty: the first of each");
  c.effect = 10; c.effectArg = 0x0f00;
  assert.deepEqual(shown(CELLS_TWO, c), [EL_FX, EL_VOL], "an effect alone takes slot A");
  c.instrment = 3;
  assert.deepEqual(shown(CELLS_TWO, c), [EL_FX, EL_VOL],
    "an instrument does not take it: it is shown beside the effect");
  c.note = 0x5000;
  assert.deepEqual(shown(CELLS_TWO, c), [EL_NOTE, EL_VOL], "…until there is a note");
  c.panEff = 0; c.pan = 0x20;
  assert.deepEqual(shown(CELLS_TWO, c), [EL_NOTE, EL_PAN], "a panning alone takes slot B");
  c.volumeEff = 0; c.volume = 0x30;
  assert.deepEqual(shown(CELLS_TWO, c), [EL_NOTE, EL_VOL], "…until there is a volume");
  assert.deepEqual(shown(CELLS_ONE, c), [EL_NOTE], "one slot: slot A alone");
});

test("the second effect shows only on a lane showing it, and only after the first", () => {
  const c = blank();
  c.effect2 = 12; c.effectArg2 = 0x8000;
  assert.deepEqual(shown(CELLS_ONE, c, null, false), [EL_NOTE], "a hidden second effect stays hidden");
  assert.deepEqual(shown(CELLS_ONE, c, null, true), [EL_FX2]);
  c.effect = 10;
  assert.deepEqual(shown(CELLS_ONE, c, null, true), [EL_FX]);
});

test("a ghost is shown, so it counts as something in its column", () => {
  const c = blank();
  c.effect = 6; c.effectArg = 0x0100;
  assert.deepEqual(shown(CELLS_TWO, c, { note: true, vol: false }), [EL_NOTE, EL_VOL]);
  assert.deepEqual(shown(CELLS_TWO, c, { pan: true }), [EL_FX, EL_PAN]);
  assert.deepEqual(shown(CELLS_TWO, c, { inst: true }), [EL_FX, EL_VOL], "an instrument ghost is no note");
});

test("slot A is the full cell's note group, slot B after a space", () => {
  const g = cellGeom(true);
  assert.equal(SLOT_A_CHARS, g.inst + 2, "the wide cell's prefix, four note cells, a space, the instrument");
  assert.equal(narrowCellChars(CELLS_ONE, false), 7.75);
  assert.equal(narrowCellChars(CELLS_TWO, false), 11.75);
  assert.equal(narrowCellChars(CELLS_TWO, true), 14.75, "a wide panning column is six");
  assert.deepEqual(narrowOrigins([EL_FX, EL_PAN]), { [EL_FX]: 0, [EL_INST]: 5.75, [EL_PAN]: 8.75 });
  assert.deepEqual(narrowOrigins([EL_NOTE]), { [EL_NOTE]: 0, [EL_INST]: 5.75 }, "the instrument on every row");
  assert.deepEqual(narrowWalk([EL_NOTE, EL_PAN], true).map(([s, n, c]) => `${s}.${n}@${c}`),
    [`${SUB_NOTE}.0@0`, `${SUB_INST}.0@5.75`, `${SUB_INST}.1@6.75`,
      ...[0, 1, 2, 3, 4, 5].map((n) => `${SUB_PAN}.${n}@${8.75 + n}`)]);
});

test("an effect takes the note's five places: its letter in the prefix, its digits in the note cells", () => {
  assert.deepEqual(narrowWalk([EL_FX], false).map(([s, n, c]) => `${s}.${n}@${c}`),
    [`${SUB_FX_OP}.0@0`, ...[0, 1, 2, 3].map((n) => `${SUB_FX_ARG}.${n}@${0.75 + n}`),
      `${SUB_INST}.0@5.75`, `${SUB_INST}.1@6.75`]);
  assert.deepEqual(narrowWalk([EL_FX2], false).map(([s, , c]) => `${s}@${c}`).slice(0, 2),
    [`${SUB_FX2_OP}@0`, `${SUB_FX2_ARG}@0.75`]);
  assert.deepEqual(narrowCaret([EL_NOTE], false, SUB_NOTE, 0), [0, 4.75], "the note's caret: the whole field");
  assert.deepEqual(narrowCaret([EL_FX], false, SUB_FX_OP, 0), [0, 0.75], "the letter's: the prefix");
  assert.deepEqual(narrowCaret([EL_FX], false, SUB_FX_ARG, 2), [2.75, 1]);
  assert.deepEqual(narrowCaret([EL_FX, EL_VOL], false, SUB_INST, 1), [6.75, 1]);
});

test("the cursor is seated on the same position in whatever its slot shows", () => {
  assert.deepEqual(narrowResolve([EL_NOTE, EL_VOL], false, SUB_NOTE, 0), [SUB_NOTE, 0]);
  assert.deepEqual(narrowResolve([EL_FX, EL_VOL], false, SUB_NOTE, 0), [SUB_FX_OP, 0],
    "a note wanted on an effect row edits the effect");
  assert.deepEqual(narrowResolve([EL_FX, EL_VOL], false, SUB_INST, 1), [SUB_INST, 1],
    "the instrument is on every row, so it stays put");
  assert.deepEqual(narrowResolve([EL_NOTE, EL_VOL], false, SUB_FX_ARG, 3), [SUB_NOTE, 0],
    "an effect digit wanted on a note row: the note, the field's only position");
  assert.deepEqual(narrowResolve([EL_FX, EL_VOL], false, SUB_FX_ARG, 3), [SUB_FX_ARG, 3]);
  assert.deepEqual(narrowResolve([EL_FX2, EL_VOL], false, SUB_FX_ARG, 2), [SUB_FX2_ARG, 2]);
  assert.deepEqual(narrowResolve([EL_NOTE, EL_VOL], true, SUB_PAN, 5), [SUB_VOL, 2],
    "slot B: a panning position on a volume row");
  assert.deepEqual(narrowResolve([EL_NOTE, EL_PAN], true, SUB_VOL, 1), [SUB_PAN, 1]);
  assert.deepEqual(narrowResolve([EL_NOTE], false, SUB_VOL, 1), [SUB_INST, 0],
    "one slot: a volume wanted goes to slot A, the only one there is");
});

test("characters map to the positions the row shows, and back", () => {
  const row = [EL_FX, EL_VOL];
  assert.deepEqual(narrowCharToSub(0.2, row, false), [SUB_FX_OP, 0]);
  assert.deepEqual(narrowCharToSub(0.8, row, false), [SUB_FX_ARG, 0], "past the prefix: the digits");
  assert.deepEqual(narrowCharToSub(3.5, row, false), [SUB_FX_ARG, 2]);
  assert.deepEqual(narrowCharToSub(5.2, row, false), [SUB_FX_ARG, 3], "the space after the field is the field's");
  assert.deepEqual(narrowCharToSub(6, row, false), [SUB_INST, 0]);
  assert.deepEqual(narrowCharToSub(8.5, row, false), [SUB_INST, 1], "the space between the slots is slot A's");
  assert.deepEqual(narrowCharToSub(9.9, row, false), [SUB_VOL, 1]);
  assert.deepEqual(narrowCharToSub(40, row, false), [SUB_VOL, 2]);
  assert.deepEqual(narrowCharToSub(3, [EL_NOTE], false), [SUB_NOTE, 0], "the note: its whole field");
  assert.equal(narrowCharPos(row, false, SUB_VOL, 1), 9.75);
  assert.equal(narrowCharPos([EL_NOTE], false, SUB_INST, 1), 6.75);
  assert.equal(narrowCharPos([EL_NOTE], false, SUB_FX2_OP, 0), 0, "not shown: the slot's start");
});

test("the five rows the change was specified by (`G` under a note, a panning, an instrument, both levels, nothing)", () => {
  // Full cell → two slots → one slot, as written down for the change:
  //   F-4 02  20 ... G1234 → F-4 02 20  → F-4 02
  //   .... .. ...  30 G0000 → G0000 .. 30 → G0000 ..
  //   .... 01  40 ... G0000 → G0000 01 40 → G0000 01
  //   .... ..  50  60 G0000 → G0000 .. 50 → G0000 ..
  //   .... .. ... ... G0000 → G0000 .. .. → G0000 ..
  const row = ({ note = 0, inst = 0, vol = null, pan = null, arg = 0 }) => {
    const c = blank();
    c.note = note; c.instrment = inst;
    if (vol !== null) { c.volumeEff = 0; c.volume = vol; }
    if (pan !== null) { c.panEff = 0; c.pan = pan; }
    c.effect = 0x10; c.effectArg = arg; // G
    return c;
  };
  const rows = [
    row({ note: 0x5500, inst: 2, vol: 0x20, arg: 0x1234 }),
    row({ pan: 0x30 }),
    row({ inst: 1, vol: 0x40 }),
    row({ vol: 0x50, pan: 0x60 }),
    row({}),
  ];
  assert.deepEqual(rows.map((c) => shown(CELLS_TWO, c)),
    [[EL_NOTE, EL_VOL], [EL_FX, EL_PAN], [EL_FX, EL_VOL], [EL_FX, EL_VOL], [EL_FX, EL_VOL]]);
  assert.deepEqual(rows.map((c) => shown(CELLS_ONE, c)), [[EL_NOTE], [EL_FX], [EL_FX], [EL_FX], [EL_FX]]);
  for (const c of rows) {
    assert.equal(narrowOrigins(shown(CELLS_ONE, c))[EL_INST], 5.75, "the instrument, on every row");
  }
});
