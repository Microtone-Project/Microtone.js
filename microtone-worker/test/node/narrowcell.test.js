// Narrow Timeline cells (item 254, src/ui/narrowcell.js): which column a slot
// shows, and where a cursor that wants one column is seated on a row showing
// another. The Timeline's painting, hit-testing and cursor walk all read these.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CELLS_TWO, CELLS_ONE, EL_NOTE, EL_FX, EL_FX2, EL_VOL, EL_PAN,
  narrowCellChars, cellPresence, narrowShown, narrowOrigins, narrowWalk, narrowResolve,
  narrowCharPos, narrowCharToSub,
} from "../../src/ui/narrowcell.js";
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
  assert.deepEqual(shown(CELLS_TWO, c), [EL_NOTE, EL_VOL], "…until there is a note or an instrument");
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
});

test("a cell is seven characters a slot, slot B after a space", () => {
  assert.equal(narrowCellChars(CELLS_ONE, false), 7);
  assert.equal(narrowCellChars(CELLS_TWO, false), 11);
  assert.equal(narrowCellChars(CELLS_TWO, true), 14, "a wide panning column is six");
  assert.deepEqual(narrowOrigins([EL_FX, EL_PAN]), { [EL_FX]: 0, [EL_PAN]: 8 });
  assert.deepEqual(narrowWalk([EL_NOTE, EL_PAN], true).map(([s, n, c]) => `${s}.${n}@${c}`),
    [`${SUB_NOTE}.0@0`, `${SUB_INST}.0@5`, `${SUB_INST}.1@6`,
      ...[0, 1, 2, 3, 4, 5].map((n) => `${SUB_PAN}.${n}@${8 + n}`)]);
});

test("the cursor is seated on the same position in whatever its slot shows", () => {
  assert.deepEqual(narrowResolve([EL_NOTE, EL_VOL], false, SUB_NOTE, 0), [SUB_NOTE, 0]);
  assert.deepEqual(narrowResolve([EL_FX, EL_VOL], false, SUB_NOTE, 0), [SUB_FX_OP, 0],
    "a note wanted on an effect row edits the effect");
  assert.deepEqual(narrowResolve([EL_FX, EL_VOL], false, SUB_INST, 1), [SUB_FX_ARG, 1]);
  assert.deepEqual(narrowResolve([EL_NOTE, EL_VOL], false, SUB_FX_ARG, 3), [SUB_INST, 1],
    "past the end of a shorter column: its last position");
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
  assert.deepEqual(narrowCharToSub(3.5, row, false), [SUB_FX_ARG, 2]);
  assert.deepEqual(narrowCharToSub(7.4, row, false), [SUB_FX_ARG, 3], "the space is slot A's");
  assert.deepEqual(narrowCharToSub(9.1, row, false), [SUB_VOL, 1]);
  assert.deepEqual(narrowCharToSub(40, row, false), [SUB_VOL, 2]);
  assert.equal(narrowCharPos(row, false, SUB_VOL, 1), 9);
  assert.equal(narrowCharPos([EL_NOTE], false, SUB_INST, 1), 6);
  assert.equal(narrowCharPos([EL_NOTE], false, SUB_FX2_OP, 0), 0, "not shown: the slot's start");
});
