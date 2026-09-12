// Find & Change (item 132) — the predicate/action core over pattern cells:
// which columns can be tested in which format, what each operator means, and
// the write rules that keep a bulk edit from conjuring commands into blank
// cells (or dropping a note into the sentinel space).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FIELDS, VP_OPS, TERM_OPS, ACTION_OPS, NOTE_MIN,
  fieldById, fieldsFor, fieldRange, fieldDigits, termOpsFor, actionOpsFor,
  readField, fieldHasContent, cellHasContent,
  evalTerm, evalCondition, evalPredicate,
  writeField, applyAction, applyActions, runPatternQuery, cellsFromPattern,
  parseNoteName, parseFieldValue, parseMultiplier, formatFieldValue,
  defaultQuery, compileQuery, conditionCounts, operandIsMultiplier,
  queryScopes, soleColumnFor,
} from "../../src/doc/patternquery.js";
import { emptyCellBytes, cellSize } from "../../src/doc/clipboard.js";
import { emptyPatternBytes } from "../../src/doc/patterntools.js";
import { MIDDLE_C } from "../../src/engine/constants.js";

// ── fixtures ───────────────────────────────────────────────────────────────

/** A narrow cell: note C-4, instrument 01, volume SET $30, pan SET $10,
 *  effect G (0x10) with argument $0123. */
function narrowCell({ note = MIDDLE_C, inst = 0x01, vol = 0x30, volSel = 0,
                      pan = 0x10, panSel = 0, fx = 0x10, arg = 0x0123 } = {}) {
  const b = emptyCellBytes(false);
  b[0] = note & 0xff; b[1] = (note >>> 8) & 0xff;
  b[2] = inst;
  b[3] = (volSel << 6) | (vol & 0x3f);
  b[4] = (panSel << 6) | (pan & 0x3f);
  b[5] = fx; b[6] = arg & 0xff; b[7] = (arg >>> 8) & 0xff;
  return b;
}

/** …and its wide equivalent (§5.5): whole-byte volume, 9-bit azimuth, signed
 *  elevation, second effect. */
function wideCell({ note = MIDDLE_C, inst = 0x01, vol = 0xC0, volSel = 0,
                    az = 0x180, panSel = 0, elev = 0, fx = 0x10, arg = 0x0123,
                    fx2 = 0, arg2 = 0 } = {}) {
  const b = emptyCellBytes(true);
  b[0] = note & 0xff; b[1] = (note >>> 8) & 0xff;
  b[2] = inst;
  b[3] = vol & 0xff;
  b[4] = az & 0xff;
  b[5] = fx; b[6] = arg & 0xff; b[7] = (arg >>> 8) & 0xff;
  b[8] = (((az >>> 8) & 1) << 7) | ((volSel & 7) << 4) | (panSel & 0xf);
  b[9] = elev & 0xff;
  b[10] = fx2; b[11] = arg2 & 0xff; b[12] = (arg2 >>> 8) & 0xff;
  return b;
}

const term = (field, op, a, b) => ({ field, op, a, b });

// ── the field table ────────────────────────────────────────────────────────

test("fields follow the format: the wide cell's three extra columns", () => {
  const narrow = fieldsFor(false).map((f) => f.id);
  const wide = fieldsFor(true).map((f) => f.id);
  for (const id of ["elev", "fx2", "fx2arg"]) {
    assert.ok(!narrow.includes(id), `${id} is not a version-2 column`);
    assert.ok(wide.includes(id), `${id} is a version-3 column`);
  }
  // Everything else is in both.
  for (const id of ["note", "inst", "vol", "volop", "pan", "panop", "fx1", "fx1arg"]) {
    assert.ok(narrow.includes(id) && wide.includes(id), id);
  }
  // Row number and "the whole cell" can be tested but never written.
  const writable = fieldsFor(true, true).map((f) => f.id);
  assert.ok(!writable.includes("row") && !writable.includes("cell"));
  assert.ok(FIELDS.every((f) => fieldById(f.id) === f));
});

test("column ranges and digit counts follow the cell width (§5.5)", () => {
  assert.deepEqual(fieldRange("vol", false), { min: 0, max: 0x3f });
  assert.deepEqual(fieldRange("vol", true), { min: 0, max: 0xff });
  assert.deepEqual(fieldRange("pan", false), { min: 0, max: 0x3f });
  assert.deepEqual(fieldRange("pan", true), { min: 0, max: 0x1ff });
  assert.deepEqual(fieldRange("elev", true), { min: -128, max: 127 });
  assert.equal(fieldDigits("pan", true), 3, "a 9-bit angle needs three digits");
  assert.equal(fieldDigits("pan", false), 2);
  assert.equal(fieldDigits("note", false), 4);
});

test("operators follow the field KIND: only numbers can be ordered", () => {
  const ids = (list) => list.map((o) => o.id);
  assert.ok(ids(termOpsFor("num")).includes("ge"));
  assert.ok(ids(termOpsFor("note")).includes("in"));
  assert.deepEqual(ids(termOpsFor("fxop")), ["eq", "ne", "has", "blank"]);
  assert.deepEqual(ids(termOpsFor("vpop")), ["eq", "ne", "has", "blank"]);
  assert.deepEqual(ids(termOpsFor("cell")), ["has", "blank"]);
  assert.deepEqual(ids(actionOpsFor("num")), ["set", "add", "muladd", "clear"]);
  assert.deepEqual(ids(actionOpsFor("fxop")), ["set", "clear"]);
  assert.deepEqual(ids(actionOpsFor("vpop")), ["set", "clear"]);
  assert.ok(TERM_OPS.every((o) => typeof o.args === "number"));
  assert.ok(operandIsMultiplier("muladd", 0) && !operandIsMultiplier("muladd", 1));
  assert.ok(!operandIsMultiplier("add", 0));
  assert.equal(ACTION_OPS.find((o) => o.id === "muladd").args, 2);
});

// ── reading ────────────────────────────────────────────────────────────────

test("readField: every column of a narrow cell", () => {
  const b = narrowCell();
  assert.equal(readField(b, false, "note"), MIDDLE_C);
  assert.equal(readField(b, false, "inst"), 0x01);
  assert.equal(readField(b, false, "vol"), 0x30);
  assert.equal(readField(b, false, "volop"), VP_OPS.indexOf("set"));
  assert.equal(readField(b, false, "pan"), 0x10);
  assert.equal(readField(b, false, "fx1"), 0x10);
  assert.equal(readField(b, false, "fx1arg"), 0x0123);
  assert.equal(readField(b, false, "row", { row: 12 }), 12);
  assert.equal(readField(b, false, "cell"), 1);
  // The version-3 columns simply are not there.
  assert.equal(readField(b, false, "elev"), null);
  assert.equal(readField(b, false, "fx2"), null);
});

test("readField: the wide cell's whole-byte volume, 9-bit angle and elevation", () => {
  const b = wideCell({ vol: 0xC0, az: 0x180, elev: -20, fx2: 0x1c, arg2: 0x8000 });
  assert.equal(readField(b, true, "vol"), 0xC0);
  assert.equal(readField(b, true, "pan"), 0x180, "the ninth bit rides byte 8");
  assert.equal(readField(b, true, "elev"), -20, "elevation is signed");
  assert.equal(readField(b, true, "fx2"), 0x1c);
  assert.equal(readField(b, true, "fx2arg"), 0x8000);
});

test("volop/panop read the five operations edit.js names", () => {
  const code = (b, wide, id) => VP_OPS[readField(b, wide, id)];
  assert.equal(code(narrowCell({ volSel: 0 }), false, "volop"), "set");
  assert.equal(code(narrowCell({ volSel: 1 }), false, "volop"), "up");
  assert.equal(code(narrowCell({ volSel: 2 }), false, "volop"), "down");
  // FINE carries its direction in bit 5 of the narrow column's value.
  assert.equal(code(narrowCell({ volSel: 3, vol: 0x25 }), false, "volop"), "fineUp");
  assert.equal(code(narrowCell({ volSel: 3, vol: 0x05 }), false, "volop"), "fineDown");
  assert.equal(code(emptyCellBytes(false), false, "volop"), "none");
  assert.equal(code(emptyCellBytes(false), false, "panop"), "none");
  // …and in the top bit of whichever field it is, in the wide cell.
  assert.equal(code(wideCell({ volSel: 3, vol: 0x85 }), true, "volop"), "fineUp");
  assert.equal(code(wideCell({ volSel: 3, vol: 0x05 }), true, "volop"), "fineDown");
  assert.equal(code(wideCell({ panSel: 3, az: 0x105 }), true, "panop"), "fineUp");
  assert.equal(code(wideCell({ panSel: 3, az: 0x005 }), true, "panop"), "fineDown");
});

test("has/blank: the engine's own reading of an empty column", () => {
  const empty = emptyCellBytes(false);
  for (const id of ["note", "inst", "vol", "pan", "fx1", "fx1arg", "cell"]) {
    assert.equal(fieldHasContent(empty, false, id), false, `${id} is blank`);
  }
  assert.equal(cellHasContent(empty, false), false);
  assert.equal(cellHasContent(narrowCell(), false), true);
  // An effect ARGUMENT belongs to its opcode: no command, nothing to speak of.
  const argOnly = narrowCell({ fx: 0, arg: 0x1234 });
  assert.equal(fieldHasContent(argOnly, false, "fx1arg"), false);
  assert.equal(fieldHasContent(narrowCell({ fx: 0x11 }), false, "fx1arg"), true);
  // The wide panning column speaks if EITHER half does (row.js panIsSet).
  const elevOnly = wideCell({ panSel: 3, az: 0, elev: 30, note: 0, inst: 0, fx: 0, arg: 0 });
  assert.equal(fieldHasContent(elevOnly, true, "pan"), true);
  assert.equal(fieldHasContent(elevOnly, true, "elev"), true);
  assert.equal(cellHasContent(elevOnly, true), true);
  // …and a version-2 project's second effect is absent, not zero.
  assert.equal(fieldHasContent(narrowCell(), false, "fx2"), false);
});

// ── predicates ─────────────────────────────────────────────────────────────

test("term operators: comparisons, ranges, and the modulo tracker asks for", () => {
  const b = narrowCell({ vol: 0x30, note: 0x4800 });
  assert.ok(evalTerm(b, false, term("vol", "ge", 0x30)));
  assert.ok(!evalTerm(b, false, term("vol", "gt", 0x30)));
  assert.ok(evalTerm(b, false, term("vol", "le", 0x30)));
  assert.ok(evalTerm(b, false, term("vol", "ne", 0x2f)));
  assert.ok(evalTerm(b, false, term("note", "in", 0x4000, 0x4fff)));
  assert.ok(!evalTerm(b, false, term("note", "in", 0x5000, 0x5fff)));
  assert.ok(evalTerm(b, false, term("note", "in", 0x4fff, 0x4000)), "a reversed range still spans");
  assert.ok(evalTerm(b, false, term("note", "notin", 0x5000, 0x5fff)));
  // rows 0, 4, 8 … out of a 64-row pattern
  assert.ok(evalTerm(b, false, term("row", "mod", 4, 0), { row: 8 }));
  assert.ok(!evalTerm(b, false, term("row", "mod", 4, 0), { row: 9 }));
  assert.ok(evalTerm(b, false, term("row", "mod", 4, 1), { row: 9 }));
  assert.ok(!evalTerm(b, false, term("row", "mod", 0, 0), { row: 0 }), "modulo 0 is not a test");
  // has/blank need no operand at all
  assert.ok(evalTerm(b, false, term("fx1", "has")));
  assert.ok(evalTerm(emptyCellBytes(false), false, term("cell", "blank")));
  assert.ok(!evalTerm(b, false, term("nonesuch", "eq", 0)), "an unknown column matches nothing");
  // a version-3 column tested in a version-2 project
  assert.ok(evalTerm(b, false, term("fx2", "blank")));
  assert.ok(!evalTerm(b, false, term("fx2", "eq", 0)));
});

test("terms AND inside a condition, conditions OR into a predicate", () => {
  const loud = narrowCell({ vol: 0x3f, note: 0x4800 });
  const quiet = narrowCell({ vol: 0x08, note: 0x4800 });
  const high = narrowCell({ vol: 0x08, note: 0x6000 });
  const cond = [term("vol", "ge", 0x30), term("note", "in", 0x4000, 0x4fff)];
  assert.ok(evalCondition(loud, false, cond));
  assert.ok(!evalCondition(quiet, false, cond), "both terms must hold");
  const pred = [cond, [term("note", "ge", 0x6000)]];
  assert.ok(evalPredicate(loud, false, pred));
  assert.ok(evalPredicate(high, false, pred), "the second condition carries it");
  assert.ok(!evalPredicate(quiet, false, pred));
  // The two empty cases, which are not the same case.
  assert.ok(evalPredicate(quiet, false, []), "no conditions = every cell");
  assert.ok(!evalCondition(quiet, false, []), "an unfilled condition selects nothing");
});

// ── actions ────────────────────────────────────────────────────────────────

test("SET writes; a blank vol/pan column promotes to the SET selector", () => {
  const b = emptyCellBytes(false);
  assert.ok(applyAction(b, false, { field: "vol", op: "set", a: 0x30 }));
  assert.equal(readField(b, false, "vol"), 0x30);
  assert.equal(VP_OPS[readField(b, false, "volop")], "set",
    "$30 into a blank column must not read as a fine slide of 16");
  const w = emptyCellBytes(true);
  applyAction(w, true, { field: "pan", op: "set", a: 0x180 });
  assert.equal(readField(w, true, "pan"), 0x180);
  assert.equal(VP_OPS[readField(w, true, "panop")], "set");
});

test("arithmetic amplifies what is there and leaves blank columns blank", () => {
  const b = narrowCell({ vol: 0x20 });
  assert.ok(applyAction(b, false, { field: "vol", op: "muladd", a: 1.5, b: 0 }));
  assert.equal(readField(b, false, "vol"), 0x30);
  applyAction(b, false, { field: "vol", op: "add", a: -0x10 });
  assert.equal(readField(b, false, "vol"), 0x20);
  // …and it clamps to the column's own range rather than wrapping.
  applyAction(b, false, { field: "vol", op: "muladd", a: 8, b: 0 });
  assert.equal(readField(b, false, "vol"), 0x3f);

  const blank = emptyCellBytes(false);
  assert.equal(applyAction(blank, false, { field: "vol", op: "add", a: 0x10 }), false);
  assert.deepEqual([...blank], [...emptyCellBytes(false)], "an empty cell stays empty");
  // The same rule on the instrument column: no stamping 01 across the block.
  const noInst = narrowCell({ inst: 0 });
  assert.equal(applyAction(noInst, false, { field: "inst", op: "add", a: 1 }), false);
  // …and on an argument whose command is not there.
  const noFx = narrowCell({ fx: 0, arg: 0 });
  assert.equal(applyAction(noFx, false, { field: "fx1arg", op: "add", a: 1 }), false);
});

test("note arithmetic skips the sentinels and cannot fall into them", () => {
  const semitone = Math.round(4096 / 12);
  const note = narrowCell({ note: MIDDLE_C });
  applyAction(note, false, { field: "note", op: "add", a: semitone });
  assert.equal(readField(note, false, "note"), MIDDLE_C + semitone);
  for (const sentinel of [0x0000, 0x0001, 0x0002, 0x0004, 0x0010, 0x001f]) {
    const b = narrowCell({ note: sentinel });
    assert.equal(applyAction(b, false, { field: "note", op: "add", a: semitone }), false,
      `note $${sentinel.toString(16)} is not a pitch to move`);
    assert.equal(readField(b, false, "note"), sentinel);
  }
  // A downward transpose stops at the first playable word, not at zero.
  const low = narrowCell({ note: 0x0100 });
  applyAction(low, false, { field: "note", op: "add", a: -0x4000 });
  assert.equal(readField(low, false, "note"), NOTE_MIN);
  // SET still writes a sentinel — that is how a key-off is stamped over a block.
  const stamp = narrowCell({ note: MIDDLE_C });
  applyAction(stamp, false, { field: "note", op: "set", a: 0x0001 });
  assert.equal(readField(stamp, false, "note"), 0x0001);
});

test("panning: the narrow arc clamps, the wide angle wraps", () => {
  const n = narrowCell({ pan: 0x20 });
  applyAction(n, false, { field: "pan", op: "add", a: 0x40 });
  assert.equal(readField(n, false, "pan"), 0x3f, "there is nothing past hard right");
  const w = wideCell({ az: 0x010 });
  applyAction(w, true, { field: "pan", op: "add", a: -0x20 });
  assert.equal(readField(w, true, "pan"), 512 - 0x10, "past hard left carries round behind");
  const w2 = wideCell({ az: 0x1f0 });
  applyAction(w2, true, { field: "pan", op: "add", a: 0x20 });
  assert.equal(readField(w2, true, "pan"), 0x10);
});

test("changing a column's OPERATION leaves a blank column blank", () => {
  const blank = emptyCellBytes(false);
  for (const op of ["set", "up", "down", "fineUp", "fineDown"]) {
    assert.equal(applyAction(blank, false, { field: "volop", op: "set", a: VP_OPS.indexOf(op) }),
      false, `${op} has no value to work on`);
  }
  assert.deepEqual([...blank], [...emptyCellBytes(false)]);
  // On a column that HAS a value it switches, keeping the argument visible.
  const b = narrowCell({ vol: 0x30, volSel: 0 });
  assert.ok(applyAction(b, false, { field: "volop", op: "set", a: VP_OPS.indexOf("up") }));
  assert.equal(VP_OPS[readField(b, false, "volop")], "up");
  assert.equal(readField(b, false, "vol"), 0x30);
  // A fine slide cannot carry a zero magnitude — that byte IS the sentinel.
  const zero = narrowCell({ vol: 0x00, volSel: 0 });
  applyAction(zero, false, { field: "volop", op: "set", a: VP_OPS.indexOf("fineDown") });
  assert.equal(VP_OPS[readField(zero, false, "volop")], "fineDown");
  assert.equal(readField(zero, false, "vol") & 0x1f, 1);
});

test("CLEAR blanks a column the way the format spells empty", () => {
  const b = narrowCell();
  applyAction(b, false, { field: "vol", op: "clear" });
  assert.equal(fieldHasContent(b, false, "vol"), false);
  assert.deepEqual([b[3]], [0xc0], "the converter's blank-column sentinel");
  applyAction(b, false, { field: "pan", op: "clear" });
  assert.equal(b[4], 0xc0);
  // Clearing an effect takes its argument with it — an argument with no
  // opcode in front of it is junk the grid would still paint.
  applyAction(b, false, { field: "fx1", op: "clear" });
  assert.deepEqual([b[5], b[6], b[7]], [0, 0, 0]);
  applyAction(b, false, { field: "note", op: "clear" });
  applyAction(b, false, { field: "inst", op: "clear" });
  assert.equal(cellHasContent(b, false), false);
  assert.deepEqual([...b], [...emptyCellBytes(false)], "…and the cell is the blank image again");

  // The wide panning column is one column on screen: clearing it takes the
  // elevation too, or the cell still says something about placement.
  const w = wideCell({ az: 0x100, elev: 40 });
  applyAction(w, true, { field: "pan", op: "clear" });
  assert.equal(fieldHasContent(w, true, "pan"), false);
  assert.equal(readField(w, true, "elev"), 0);
});

test("a version-3 column cannot be written in a version-2 project", () => {
  const b = narrowCell();
  const before = Uint8Array.from(b);
  for (const field of ["elev", "fx2", "fx2arg"]) {
    assert.equal(applyAction(b, false, { field, op: "set", a: 1 }), false, field);
  }
  assert.deepEqual([...b], [...before]);
  assert.equal(writeField(b, false, "row", 3), false, "a row number is not a column");
});

test("actions run in order, each seeing the last one's work", () => {
  const b = narrowCell({ vol: 0x10 });
  applyActions(b, false, [
    { field: "vol", op: "muladd", a: 2, b: 0 },
    { field: "vol", op: "add", a: 1 },
  ]);
  assert.equal(readField(b, false, "vol"), 0x21);
});

// ── the driver ─────────────────────────────────────────────────────────────

test("runPatternQuery: tallies, writes only what changed, never mutates source", () => {
  const wide = false;
  const cells = [
    { pat: 3, row: 0, bytes: narrowCell({ vol: 0x3f }) },
    { pat: 3, row: 1, bytes: narrowCell({ vol: 0x10 }) },
    { pat: 3, row: 2, bytes: emptyCellBytes(false) },
    { pat: 4, row: 0, bytes: narrowCell({ vol: 0x30 }) },
  ];
  const before = cells.map((c) => Uint8Array.from(c.bytes));
  const res = runPatternQuery(cells, {
    predicate: [[term("vol", "ge", 0x30)]],
    actions: [{ field: "vol", op: "muladd", a: 0.5, b: 0 }],
  }, wide);
  assert.equal(res.total, 4);
  assert.equal(res.matched, 2, "$3F and $30, not $10 and not the blank cell");
  assert.equal(res.writes.length, 2);
  assert.deepEqual(res.writes.map((w) => [w.pat, w.row]), [[3, 0], [4, 0]]);
  assert.equal(readField(res.writes[0].bytes, wide, "vol"), 0x20);
  assert.equal(readField(res.writes[1].bytes, wide, "vol"), 0x18);
  cells.forEach((c, i) => assert.deepEqual([...c.bytes], [...before[i]], "source untouched"));

  // A match that changes nothing is counted but not written — no undo step
  // full of identical bytes.
  const noop = runPatternQuery(cells, {
    predicate: [],
    actions: [{ field: "inst", op: "set", a: 0x01 }],
  }, wide);
  assert.equal(noop.matched, 4);
  assert.equal(noop.writes.length, 1, "only the blank cell had no instrument 01");
});

test("runPatternQuery: each condition also counts its OWN events", () => {
  const cells = [
    { pat: 0, row: 0, bytes: narrowCell({ vol: 0x3f, fx: 0x11 }) }, // loud AND vibrato
    { pat: 0, row: 1, bytes: narrowCell({ vol: 0x3f, fx: 0 }) },    // loud only
    { pat: 0, row: 2, bytes: narrowCell({ vol: 0x08, fx: 0x11 }) }, // vibrato only
    { pat: 0, row: 3, bytes: narrowCell({ vol: 0x08, fx: 0 }) },    // neither
  ];
  const res = runPatternQuery(cells, {
    predicate: [[term("vol", "ge", 0x30)], [term("fx1", "eq", 0x11)]],
    actions: [],
  }, false);
  assert.equal(res.matched, 3, "the OR selects three of the four");
  // Two each — the cell both conditions match is counted on BOTH, because the
  // question is what a condition selects, not what it contributed.
  assert.deepEqual(res.perCondition, [2, 2]);
  assert.equal(res.perCondition.reduce((a, b) => a + b, 0), 4,
    "…so the parts can add up to more than the whole");
  // No conditions: every cell matches and there is nothing to tally.
  assert.deepEqual(runPatternQuery(cells, { predicate: [] }, false).perCondition, []);
});

test("conditionCounts: the tally lands back on the card it came from", () => {
  const cells = [
    { pat: 0, row: 0, bytes: narrowCell({ vol: 0x3f }) },
    { pat: 0, row: 1, bytes: narrowCell({ vol: 0x08 }) },
  ];
  // The MIDDLE condition is unfinished, so compiling renumbers what follows it.
  const raw = {
    predicate: [
      [{ field: "vol", op: "ge", a: "30" }],
      [{ field: "vol", op: "ge", a: "" }],
      [{ field: "vol", op: "le", a: "10" }],
    ],
    actions: [],
  };
  const compiled = compileQuery(raw);
  assert.deepEqual(compiled.condOf, [0, 2], "…which is what condOf records");
  const res = runPatternQuery(cells, compiled, false);
  assert.deepEqual(conditionCounts(raw, compiled, res), [1, null, 1],
    "an unfinished condition reads as nothing rather than as zero");
});

test("cellsFromPattern: a whole image, or a row span of it", () => {
  const img = emptyPatternBytes(false);
  const all = cellsFromPattern(img, 7, false);
  assert.equal(all.length, 64);
  assert.equal(all[0].pat, 7);
  assert.equal(all[63].row, 63);
  assert.equal(all[5].bytes.length, cellSize(false));
  const span = cellsFromPattern(img, 7, false, [8, 15]);
  assert.equal(span.length, 8);
  assert.deepEqual([span[0].row, span[7].row], [8, 15]);
  // Wide images use the 16-byte stride.
  const wideSpan = cellsFromPattern(emptyPatternBytes(true), 0, true, [1, 1]);
  assert.equal(wideSpan[0].bytes.length, cellSize(true));
  assert.equal(wideSpan[0].bytes[8], 0x33, "…and land on the right cell");
});

// ── typing values in ───────────────────────────────────────────────────────

test("note names parse the way the grid spells them", () => {
  assert.equal(parseNoteName("C-4"), MIDDLE_C);
  assert.equal(parseNoteName("c4"), MIDDLE_C);
  assert.equal(parseNoteName("C-5"), MIDDLE_C + 4096);
  assert.equal(parseNoteName("C-3"), MIDDLE_C - 4096);
  assert.equal(parseNoteName("A-4"), MIDDLE_C + Math.round((9 * 4096) / 12));
  assert.equal(parseNoteName("C#4"), MIDDLE_C + Math.round(4096 / 12));
  assert.equal(parseNoteName("Db4"), MIDDLE_C + Math.round((1 * 4096) / 12));
  assert.equal(parseNoteName("Bb4"), MIDDLE_C + Math.round((10 * 4096) / 12));
  assert.equal(parseNoteName("H-4"), null);
  assert.equal(parseNoteName("$5000"), null);
  assert.equal(parseNoteName("C-99"), null, "off the top of the word");
});

test("column values are typed in the column's own base", () => {
  // Tracker columns are hex, like the grid and the change-instrument dialog.
  assert.equal(parseFieldValue("vol", "30"), 0x30);
  assert.equal(parseFieldValue("vol", "$30"), 0x30);
  assert.equal(parseFieldValue("vol", "0x30"), 0x30);
  assert.equal(parseFieldValue("vol", "#48"), 48, "# is the decimal escape");
  assert.equal(parseFieldValue("fx1arg", "F034"), 0xf034);
  assert.equal(parseFieldValue("inst", "0a"), 0x0a);
  // …but the two counting columns are decimal, and elevation is signed.
  assert.equal(parseFieldValue("row", "12"), 12);
  assert.equal(parseFieldValue("elev", "-20"), -20);
  assert.equal(parseFieldValue("elev", "1f"), null, "a decimal field takes digits only");
  // Notes take a name or a word; effects take their base-36 letter.
  assert.equal(parseFieldValue("note", "C-4"), MIDDLE_C);
  assert.equal(parseFieldValue("note", "5000"), MIDDLE_C);
  assert.equal(parseFieldValue("fx1", "S"), 0x1c);
  assert.equal(parseFieldValue("fx1", "G"), 0x10);
  assert.equal(parseFieldValue("fx1", "1"), 0x01);
  assert.equal(parseFieldValue("vol", ""), null);
  assert.equal(parseFieldValue("vol", "zz"), null);
  assert.equal(parseFieldValue("nonesuch", "1"), null);
  assert.equal(parseMultiplier("1.25"), 1.25);
  assert.equal(parseMultiplier("-2"), -2);
  assert.equal(parseMultiplier("x"), null);
});

test("formatFieldValue speaks each column's own dialect", () => {
  assert.equal(formatFieldValue("vol", 0x30, false), "$30");
  assert.equal(formatFieldValue("pan", 0x180, true), "$180");
  assert.equal(formatFieldValue("note", MIDDLE_C, false), "$5000");
  assert.equal(formatFieldValue("row", 12, false), "12");
  assert.equal(formatFieldValue("elev", -20, true), "-20");
  assert.equal(formatFieldValue("fx1", 0x1c, false), "S");
  assert.equal(formatFieldValue("fx1", 0, false), "—");
  assert.equal(formatFieldValue("volop", VP_OPS.indexOf("fineUp"), false), "fineUp");
});

test("compileQuery drops the half-typed rows so the readout can run live", () => {
  const raw = {
    predicate: [
      [{ field: "vol", op: "ge", a: "30" }, { field: "note", op: "in", a: "4000", b: "" }],
      [{ field: "fx1", op: "eq", a: "S" }],
      [{ field: "vol", op: "ge", a: "" }],
    ],
    actions: [
      { field: "vol", op: "muladd", a: "1.5", b: "0" },
      { field: "vol", op: "set", a: "" },
      { field: "row", op: "set", a: "1" },
      { field: "note", op: "nonesuch", a: "1" },
    ],
  };
  const q = compileQuery(raw);
  // The unfinished "note in 4000‥" term goes; its condition survives on the
  // term that IS finished. The condition with nothing usable goes entirely.
  assert.deepEqual(q.predicate, [
    [{ field: "vol", op: "ge", a: 0x30 }],
    [{ field: "fx1", op: "eq", a: 0x1c }],
  ]);
  assert.deepEqual(q.actions, [{ field: "vol", op: "muladd", a: 1.5, b: 0 }]);
  // The multiplier is decimal even in a hex column.
  assert.equal(compileQuery({ actions: [{ field: "vol", op: "muladd", a: "2", b: "10" }] })
    .actions[0].b, 0x10);
  // A default query is runnable and selects everything until it is filled in.
  const fresh = compileQuery(defaultQuery());
  assert.deepEqual(fresh.predicate, []);
  assert.deepEqual(fresh.actions, []);
  assert.equal(runPatternQuery([{ pat: 0, row: 0, bytes: narrowCell() }], fresh, false).matched, 1);
});

// ── the scopes the dialog offers (the "Apply to" list) ─────────────────────

/** A song stub in the two shapes queryScopes reads: cue words per channel and
 *  a sparse pattern list (a hole = an index nothing has been written to). */
function scopeSong(cueRows, patternIndices) {
  const patterns = [];
  for (const p of patternIndices) patterns[p] = new Array(64).fill(null);
  return {
    patterns,
    cues: cueRows.map((row) => {
      const w = new Uint16Array(64).fill(CUE_EMPTY_WORD);
      row.forEach((p, ch) => { w[ch] = p; });
      return w;
    }),
  };
}
const CUE_EMPTY_WORD = 0x7fff;
const cellsOf = (pat, r0, r1) => {
  const out = [];
  for (let r = r0; r <= r1; r++) out.push({ pat, row: r });
  return out;
};

test("queryScopes: the caller's cells, then pattern, column and song", () => {
  // voice 0 plays patterns 1 and 2; voice 1 plays 3 (and 9, unwritten).
  const song = scopeSong([[1, 3], [2, 9], [1, 3]], [1, 2, 3, 5]);
  const scopes = queryScopes(song, 2, cellsOf(1, 4, 8));
  assert.deepEqual(scopes.map((s) => s.id), ["here", "pattern", "column", "song"]);
  assert.equal(scopes[0].pat, undefined); // a row range is not a whole pattern
  assert.equal(scopes[1].pat, 1);
  // Pattern 1 is played by voice 0 alone, so the column is derivable from it.
  assert.equal(scopes[2].ch, 0);
  assert.deepEqual(scopes[2].patterns, [1, 2]);
  // Pattern 5 is materialised but unplaced; 9 is placed but unwritten.
  assert.deepEqual(scopes[3].patterns, [1, 2, 3, 5]);
});

test("queryScopes: cells that ARE one whole pattern name the first option", () => {
  const song = scopeSong([[1, 3]], [1, 3]);
  const scopes = queryScopes(song, 2, cellsOf(1, 0, 63));
  // No separate "pattern" scope — the same 64 rows are not offered twice.
  assert.deepEqual(scopes.map((s) => s.id), ["here", "column", "song"]);
  assert.equal(scopes[0].pat, 1);
});

test("queryScopes: a block across patterns has no pattern scope, and takes the caller's column", () => {
  const song = scopeSong([[1, 3], [2, 4]], [1, 2, 3, 4]);
  const across = [{ pat: 1, row: 0 }, { pat: 2, row: 0 }];
  assert.deepEqual(queryScopes(song, 2, across).map((s) => s.id), ["here", "song"]);
  // …unless the caller says which column the block was drawn in.
  const told = queryScopes(song, 2, across, 1);
  assert.deepEqual(told.map((s) => s.id), ["here", "column", "song"]);
  assert.deepEqual(told[1].patterns, [3, 4]);
});

test("queryScopes: a pattern several voices play names no column", () => {
  const song = scopeSong([[7, 7]], [7]);
  assert.deepEqual(queryScopes(song, 2, cellsOf(7, 0, 3)).map((s) => s.id),
    ["here", "pattern", "song"]);
  assert.equal(soleColumnFor(song, 2, 7), null);
  assert.equal(soleColumnFor(song, 2, 8), null); // nothing plays it
  assert.equal(soleColumnFor(song, 2, null), null);
});

test("queryScopes: nothing materialised, nothing wider to offer", () => {
  const song = scopeSong([[0x7fff, 0x7fff]], []);
  assert.deepEqual(queryScopes(song, 2, [{ pat: 4, row: 0 }]).map((s) => s.id),
    ["here", "pattern"]);
  // An empty column is not offered either: the voice plays only unwritten
  // numbers, so "every pattern it plays" is nothing at all.
  const sparse = scopeSong([[6, 0x7fff]], [8]);
  assert.deepEqual(queryScopes(sparse, 2, [{ pat: 6, row: 0 }], 0).map((s) => s.id),
    ["here", "pattern", "song"]);
});
