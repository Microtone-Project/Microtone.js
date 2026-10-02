// Item 159 — the FM rack editor (doc/fmedit.js).
//
// The rack and its algorithm are one record and the algorithm addresses the
// rack BY POSITION, so the whole file is about one invariant: no edit may leave
// a program the engine would then refuse. The tests below are that invariant,
// split into the two ways it can break — a reorder that forgets to renumber,
// and a removal that leaves a word pointing at nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudInst, decodeFmProgram, makeMetaLayer } from "../../core/engine/inst.js";
import {
  fmOperators, fmProgramOf, fmRecordOf, fmValidate, fmBudget, fmFormula, fmTree, fmGraph,
  fmWord, fmWordClass, fmWordIndex, fmOperatorsNamed, fmCanAddOperator, fmCanAddWord,
  canRemoveOperator, removeOperator, moveOperator, patchOperator,
  insertWord, removeWord, moveWord, setWord,
  FM_CLASS_OSC, FM_CLASS_MOD, FM_CLASS_FB, FM_CLASS_OP,
  FM_BUDGET_BYTES, FmOp, META_TYPE_FM,
} from "../../src/doc/fmedit.js";

const op = (slot) => makeMetaLayer(slot, 159, 0, 0x0000, 0xffff, 0, 63);

/** A rack instrument in slot 5, built from an operator list and an algorithm. */
function rack(ops, program) {
  const inst = new TaudInst(5);
  inst.loadRecord(fmRecordOf(null, ops, program));
  return inst;
}

const OSC = (k) => fmWord(FM_CLASS_OSC, k);
const MOD = (k) => fmWord(FM_CLASS_MOD, k);
const FB = (k) => fmWord(FM_CLASS_FB, k);

test("a rack round-trips through the editor's own packer", () => {
  const ops = [op(0x101), op(0x102), op(0x103)];
  const prog = [OSC(2), MOD(1), MOD(0)];
  const inst = rack(ops, prog);
  assert.equal(inst.isFm, true);
  assert.equal(inst.metaType, META_TYPE_FM);
  assert.deepEqual(fmOperators(inst).map((o) => o.instIdx), [0x101, 0x102, 0x103]);
  assert.deepEqual(fmProgramOf(inst), prog);
});

test("the editor's validation agrees with the engine's, word for word", () => {
  // fmValidate and decodeFmProgram are two readings of the same rules, and a
  // disagreement means the editor is happily saving a silent instrument.
  const ops = [op(0x101), op(0x102)];
  const cases = [
    [OSC(0)], [OSC(1), MOD(0)], [OSC(0), OSC(1), FmOp.ADD],
    [MOD(0)], [OSC(0), FmOp.ADD], [OSC(5)], [], [OSC(0), OSC(1)],
    [FB(1), MOD(0)], [OSC(0), FmOp.DUP, FmOp.MUL], [0x0c00],
  ];
  for (const prog of cases) {
    const editor = fmValidate(prog, ops.length).ok;
    const engine = rack(ops, prog).fmProgram !== null;
    assert.equal(editor, engine, `disagreement on [${prog.map((w) => w.toString(16))}]`);
  }
});

test("the depth column ends on exactly one for a well-formed algorithm", () => {
  const v = fmValidate([OSC(1), MOD(0), OSC(1), FmOp.ADD], 2);
  assert.ok(v.ok);
  assert.deepEqual(v.depth, [0, 1, 1, 2, 1]);
});

test("…and points at the word that broke it when it is not", () => {
  const v = fmValidate([OSC(0), FmOp.ADD], 2);
  assert.equal(v.ok, false);
  assert.equal(v.error, "underflow");
  assert.equal(v.at, 1);
});

test("moving an operator renumbers the algorithm, so the patch is unchanged", () => {
  const ops = [op(0x101), op(0x102), op(0x103)];
  const prog = [OSC(2), MOD(1), MOD(0)];          // 2 → 1 → 0
  const before = fmFormula(prog, 3, (k) => ops[k].instIdx.toString(16));
  const moved = moveOperator(ops, prog, 2, -2);   // the tail becomes the principal
  assert.deepEqual(moved.ops.map((o) => o.instIdx), [0x103, 0x101, 0x102]);
  const after = fmFormula(moved.program, 3, (k) => moved.ops[k].instIdx.toString(16));
  assert.equal(after, before, "the wiring followed the rows");
  assert.ok(fmValidate(moved.program, 3).ok);
});

test("a reorder still verifies whichever way it goes", () => {
  const ops = [op(0x101), op(0x102), op(0x103), op(0x104)];
  const prog = [OSC(3), MOD(2), OSC(1), FmOp.ADD, MOD(0)];
  for (let i = 0; i < 4; i++) {
    for (const d of [-2, -1, 1, 2]) {
      const r = moveOperator(ops, prog, i, d);
      assert.ok(fmValidate(r.program, r.ops.length).ok, `move ${i} by ${d}`);
      assert.equal(r.ops.length, 4);
    }
  }
});

test("an operator the algorithm names cannot be removed", () => {
  const ops = [op(0x101), op(0x102), op(0x103)];
  const prog = [OSC(2), MOD(0)];                  // operator 1 is unwired
  assert.deepEqual(fmOperatorsNamed(prog, 3), [1, 0, 1]);
  assert.equal(canRemoveOperator(ops, prog, 1), true);
  assert.equal(canRemoveOperator(ops, prog, 2), false, "still named by a word");
  assert.equal(canRemoveOperator(ops, prog, 0), false, "the principal never goes");
});

test("removing an unwired operator slides the references past it", () => {
  const ops = [op(0x101), op(0x102), op(0x103)];
  const prog = [OSC(2), MOD(0)];
  const r = removeOperator(ops, prog, 1);
  assert.deepEqual(r.ops.map((o) => o.instIdx), [0x101, 0x103]);
  assert.deepEqual(r.program, [OSC(1), MOD(0)], "operator 2 became operator 1");
  assert.ok(fmValidate(r.program, r.ops.length).ok);
});

test("a feedback tap still counts as naming an operator", () => {
  // The engine will not SOUND an operator named only by a tap, but the editor
  // must not delete the row that tap points at either.
  const ops = [op(0x101), op(0x102)];
  const prog = [FB(1), MOD(0)];
  assert.equal(canRemoveOperator(ops, prog, 1), false);
});

test("the word list edits leave a program the engine can read", () => {
  const ops = [op(0x101), op(0x102)];
  let prog = [OSC(1), MOD(0)];
  prog = insertWord(prog, 1, OSC(1));
  prog = setWord(prog, 1, OSC(0));
  prog = moveWord(prog, 0, 1);
  prog = removeWord(prog, 0);
  assert.ok(Array.isArray(prog));
  const inst = rack(ops, prog);
  assert.equal(inst.fmProgram === null, !fmValidate(prog, 2).ok);
});

test("the budget is one number for both halves of the record", () => {
  const b = fmBudget(4, 6);
  assert.equal(b.used, 4 * 10 + 7 * 2, "operators, words, and the terminator");
  assert.equal(b.total, FM_BUDGET_BYTES);
  assert.equal(b.free, FM_BUDGET_BYTES - b.used);

  // A rack that has spent its bytes cannot take another operator even well
  // under the 16-operator cap — which is exactly what the meter is for.
  const ops = new Array(8).fill(op(0x101));
  const fat = new Array(85).fill(FmOp.NEG);
  assert.equal(fmCanAddOperator(ops, [OSC(0), ...fat]), false);
  assert.equal(fmCanAddWord(ops, [OSC(0), ...fat]), false);
  assert.equal(fmCanAddOperator(ops, [OSC(0)]), true);
});

test("patchOperator touches one row and nothing else", () => {
  const ops = [op(0x101), op(0x102)];
  const next = patchOperator(ops, 1, { mixOctet: 200, detune: -4096 });
  assert.equal(next[0].mixOctet, 159);
  assert.equal(next[1].mixOctet, 200);
  assert.equal(next[1].detune, -4096);
  assert.equal(ops[1].mixOctet, 159, "the input array is untouched");
});

// ── the readout ──────────────────────────────────────────────────────────

test("the formula reads the chain the way a person would say it", () => {
  assert.equal(fmFormula([OSC(2), MOD(1), MOD(0)], 3), "0[1[2]]");
  assert.equal(fmFormula([OSC(1), MOD(0), OSC(2), FmOp.ADD], 3), "0[1] + 2");
  assert.equal(fmFormula([OSC(0), OSC(1), FmOp.MUL], 2), "0 × 1");
  assert.equal(fmFormula([OSC(0), FmOp.NEG, MOD(1)], 2), "1[−0]");
  assert.equal(fmFormula([FB(0), MOD(0)], 1), "0[0′]", "self-feedback");
  assert.equal(fmFormula([OSC(1), FmOp.DUP, MOD(0), FmOp.ADD], 2), "1 + 0[1]",
    "DUP leaves the copy underneath, so the sum reads bottom-up");
});

test("…and says nothing at all when the algorithm does not verify", () => {
  assert.equal(fmFormula([OSC(0), FmOp.ADD], 2), null);
});

test("word classes decode back to what built them", () => {
  for (const [cls, mk] of [[FM_CLASS_OSC, OSC], [FM_CLASS_MOD, MOD], [FM_CLASS_FB, FB]]) {
    for (const k of [0, 1, 15, 1023]) {
      assert.equal(fmWordClass(mk(k)), cls);
      assert.equal(fmWordIndex(mk(k)), k);
    }
  }
  assert.equal(fmWordClass(FmOp.ADD), FM_CLASS_OP);
});

test("decodeFmProgram and the packer agree on where the program starts", () => {
  const ops = [op(0x101), op(0x102), op(0x103)];
  const prog = [OSC(2), MOD(1), MOD(0)];
  const rec = fmRecordOf(null, ops, prog);
  assert.deepEqual([...decodeFmProgram(rec, 4 + ops.length * 10, ops.length)], prog);
});

// ── the diagram ──────────────────────────────────────────────────────────
// fmGraph is what the FM tab draws (ui/fmgraph.js only paints it), so the
// invariants worth pinning are the ones a picture can get wrong silently: every
// operator the algorithm sounds appears exactly where the signal reaches it,
// and every wire lands on something.

/** "op@col,row" for each cell, sorted — a stable shape for the assertions. */
const shape = (g) => g.cells
  .map((c) => `${c.kind === "op" ? c.op : c.kind}@${c.col},${c.row}${c.selfFeedback ? "*" : ""}`)
  .sort();

test("a chain is one lane, deepest modulator furthest from the output", () => {
  const g = fmGraph([OSC(3), MOD(2), MOD(1), MOD(0)], 4);
  assert.equal(g.rows, 1);
  assert.equal(g.cols, 4);
  assert.deepEqual(shape(g), ["0@0,0", "1@1,0", "2@2,0", "3@3,0"]);
  // Four boxes in a line plus the wire into OUTPUT.
  assert.equal(g.edges.length, 4);
});

test("parallel carriers get a lane each and both reach the output", () => {
  const g = fmGraph([OSC(1), MOD(0), OSC(2), FmOp.ADD], 3);
  assert.equal(g.rows, 2);
  assert.deepEqual(shape(g), ["0@0,0", "1@1,0", "2@0,1"]);
  const toOut = g.edges.filter((e) => e.to.col === -1);
  assert.equal(toOut.length, 2, "a sum has no box: the wires meet AT the sink");
  assert.deepEqual(toOut.map((e) => e.from.row).sort(), [0, 1]);
});

test("an operator modulated by its own tap is ONE box with a loop", () => {
  const g = fmGraph([FB(0), MOD(0)], 1);
  assert.deepEqual(shape(g), ["0@0,0*"]);
  assert.equal(g.edges.length, 1, "only the wire into OUTPUT");
});

test("…but a tap on ANOTHER operator is a box of its own", () => {
  const g = fmGraph([FB(1), MOD(0)], 2);
  assert.equal(g.cells.length, 2);
  assert.equal(g.cells.find((c) => c.tap).op, 1);
});

test("ring modulation and inversion get a junction; a sum does not", () => {
  const mul = fmGraph([OSC(1), OSC(2), FmOp.MUL, MOD(0)], 3);
  assert.ok(mul.cells.some((c) => c.kind === "mul"));
  const neg = fmGraph([OSC(1), FmOp.NEG, MOD(0)], 2);
  assert.ok(neg.cells.some((c) => c.kind === "neg"));
  const add = fmGraph([OSC(0), OSC(1), FmOp.ADD], 2);
  assert.ok(add.cells.every((c) => c.kind === "op"));
});

test("every wire lands on a cell that is actually there", () => {
  const cases = [
    [[OSC(3), MOD(2), MOD(1), MOD(0)], 4],
    [[OSC(1), MOD(0), OSC(2), FmOp.ADD], 3],
    [[OSC(2), OSC(3), FmOp.ADD, MOD(1), MOD(0)], 4],
    [[OSC(1), OSC(2), FmOp.MUL, MOD(0)], 3],
    [[OSC(1), MOD(0), OSC(2), FmOp.ADD, OSC(3), FmOp.ADD], 4],
    [[FB(2), MOD(2), MOD(1), MOD(0)], 3],
  ];
  for (const [prog, n] of cases) {
    const g = fmGraph(prog, n);
    const at = new Set(g.cells.map((c) => `${c.col},${c.row}`));
    at.add(`-1,${g.outRow}`); // the sink
    for (const e of g.edges) {
      assert.ok(at.has(`${e.from.col},${e.from.row}`), `edge from nowhere in ${fmFormula(prog, n)}`);
      assert.ok(at.has(`${e.to.col},${e.to.row}`), `edge to nowhere in ${fmFormula(prog, n)}`);
    }
    for (const c of g.cells) {
      assert.ok(c.col >= 0 && c.col < g.cols && c.row >= 0 && c.row < g.rows,
        `cell off the grid in ${fmFormula(prog, n)}`);
    }
  }
});

test("a dup draws the shared operator once per place it is read", () => {
  // The engine evaluates it once; the picture names it twice, under one number.
  const g = fmGraph([OSC(2), FmOp.DUP, MOD(1), FmOp.SWAP, MOD(0), FmOp.ADD], 3);
  assert.equal(g.cells.filter((c) => c.op === 2).length, 2);
});

test("there is no diagram of an algorithm that does not verify", () => {
  assert.equal(fmTree([OSC(0), FmOp.ADD], 2), null);
  assert.equal(fmGraph([OSC(0), FmOp.ADD], 2), null);
});
