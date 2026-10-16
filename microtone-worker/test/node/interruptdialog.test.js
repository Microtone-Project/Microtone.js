// The interrupt marker dialog (src/ui/popups/interrupt.js) — the note column's
// IntN writer with its optional `: MMMM` argument. Only the pure helpers are
// tested here; the dialog itself is DOM.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  interruptNumberOf, interruptArgFromCell, parseInterruptArg, interruptFields,
} from "../../src/ui/popups/interrupt.js";
import { EffectOp } from "../../core/engine/tables.js";

const COLON = EffectOp.OP_COLON;
const J = EffectOp.OP_J;

test("interruptNumberOf: Int0..IntF only", () => {
  assert.equal(interruptNumberOf(0x0010), 0);
  assert.equal(interruptNumberOf(0x001f), 15);
  assert.equal(interruptNumberOf(0x000f), -1);
  assert.equal(interruptNumberOf(0x0020), -1);
  assert.equal(interruptNumberOf(0), -1);
});

test("parseInterruptArg: blank is no argument, hex up to four digits, junk is NaN", () => {
  assert.equal(parseInterruptArg(""), null);
  assert.equal(parseInterruptArg("   "), null);
  assert.equal(parseInterruptArg("1"), 1);
  assert.equal(parseInterruptArg("ffff"), 0xffff);
  assert.equal(parseInterruptArg("$00A0"), 0xa0);
  assert.equal(parseInterruptArg("0x12"), 0x12);
  assert.ok(Number.isNaN(parseInterruptArg("10000")));
  assert.ok(Number.isNaN(parseInterruptArg("xyz")));
  assert.ok(Number.isNaN(parseInterruptArg("$")));
});

test("no argument: only the note is written", () => {
  const cell = { note: 0x4000, effect: J, effectArg: 0x1234 };
  assert.deepEqual(interruptFields(cell, 3, null, false), { note: 0x0013 });
});

test("an argument goes into the first effect slot of an empty cell", () => {
  assert.deepEqual(interruptFields({ note: 0, effect: 0, effectArg: 0 }, 0xa, 0xbeef, false),
    { note: 0x001a, effect: COLON, effectArg: 0xbeef });
});

test("an existing `:` is reused, the left one first", () => {
  const wideCell = { effect: J, effectArg: 1, effect2: COLON, effectArg2: 5 };
  assert.deepEqual(interruptFields(wideCell, 0, 7, true),
    { note: 0x0010, effect2: COLON, effectArg2: 7 });
  const both = { effect: COLON, effectArg: 1, effect2: COLON, effectArg2: 5 };
  assert.deepEqual(interruptFields(both, 0, 7, true),
    { note: 0x0010, effect: COLON, effectArg: 7 });
});

test("a wide cell's free second slot is used before overwriting the first", () => {
  const cell = { effect: J, effectArg: 1, effect2: 0, effectArg2: 0 };
  assert.deepEqual(interruptFields(cell, 1, 2, true),
    { note: 0x0011, effect2: COLON, effectArg2: 2 });
  // A narrow cell has no second slot, so the first one is taken over.
  assert.deepEqual(interruptFields(cell, 1, 2, false),
    { note: 0x0011, effect: COLON, effectArg: 2 });
});

test("interruptArgFromCell reads what the player would: the left `:` wins", () => {
  assert.equal(interruptArgFromCell({ effect: COLON, effectArg: 9, effect2: COLON, effectArg2: 4 }, true), 9);
  assert.equal(interruptArgFromCell({ effect: 0, effect2: COLON, effectArg2: 4 }, true), 4);
  assert.equal(interruptArgFromCell({ effect: 0, effect2: COLON, effectArg2: 4 }, false), -1);
  assert.equal(interruptArgFromCell(null, true), -1);
});
