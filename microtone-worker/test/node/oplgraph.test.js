// The OPL tab's connection diagram (doc/oplgraph.js): every connection drawn
// as the FM Rack draws an algorithm, held to the ENGINE's idea of which
// operators reach the output — oplOutputMask, the same table that decides what
// note volume scales — so the picture cannot drift from the sound.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  oplOutputMask, OPL_KIND_OPERATORS,
  OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM, OPL_KIND_TC, OPL_KIND_HH,
} from "../../core/engine/opl.js";
import { oplGraph, oplGraphCanvas, graphOutputs } from "../../src/doc/oplgraph.js";
import { fmTreeGraph } from "../../src/doc/fmlayout.js";

const maskOps = (mask) => [0, 1, 2, 3].filter((i) => (mask >> i) & 1);

/** "op@col,row" per cell, sorted; a * marks the feedback curl. */
const shape = (g) => g.cells
  .map((c) => `${c.op}@${c.col},${c.row}${c.selfFeedback ? "*" : ""}`)
  .sort();

test("every kind and connection outputs what the engine outputs", () => {
  const kinds = [OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM,
    OPL_KIND_TC, OPL_KIND_HH];
  for (const kind of kinds) {
    for (const cntA of [0, 1]) {
      for (const cntB of [0, 1]) {
        const g = oplGraph(OPL_KIND_OPERATORS[kind], cntA, cntB, 3);
        assert.deepEqual(graphOutputs(g), maskOps(oplOutputMask(kind, cntA, cntB)),
          `kind ${kind}, CNT ${cntA},${cntB}`);
      }
    }
  }
});

test("the four four-operator connections are the data sheet's four figures", () => {
  // 1 → 2 → 3 → 4: one lane, operator 1 furthest from OUT.
  assert.deepEqual(shape(oplGraph(4, 0, 0)), ["0@3,0*", "1@2,0", "2@1,0", "3@0,0"]);
  // 1 → 2, and 3 → 4: two pairs, a lane each.
  assert.deepEqual(shape(oplGraph(4, 0, 1)), ["0@1,0*", "1@0,0", "2@1,1", "3@0,1"]);
  // 1, and 2 → 3 → 4.
  assert.deepEqual(shape(oplGraph(4, 1, 0)), ["0@0,0*", "1@2,1", "2@1,1", "3@0,1"]);
  // 1, and 2 → 3, and 4: three lanes into OUT.
  const g = oplGraph(4, 1, 1);
  assert.deepEqual(shape(g), ["0@0,0*", "1@1,1", "2@0,1", "3@0,2"]);
  assert.equal(g.rows, 3);
  // Every wire between operators runs one column towards OUT, on its own lane.
  for (const conn of [0, 1, 2, 3]) {
    for (const e of oplGraph(4, conn >> 1, conn & 1).edges) {
      if (e.to.col !== -1) assert.equal(e.from.col, e.to.col + 1, `connection ${conn}`);
    }
  }
});

test("operator 1, and only operator 1, carries the feedback — at its depth", () => {
  for (const ops of [2, 4]) {
    for (const conn of [0, 1, 2, 3]) {
      const g = oplGraph(ops, conn >> 1, conn & 1, 5);
      const loops = g.cells.filter((c) => c.selfFeedback);
      assert.deepEqual(loops.map((c) => [c.op, c.feedback]), [[0, 5]], `${ops} ops, ${conn}`);
      // The curl is drawn over the top lane, where the painter leaves it room.
      assert.equal(loops[0].row, 0);
    }
  }
  // Depth 0 is still a curl (the path exists on the chip); the painter dims it.
  assert.equal(oplGraph(2, 0, 0, 0).cells.find((c) => c.selfFeedback).feedback, 0);
  // A lone drum operator has none.
  assert.deepEqual(shape(oplGraph(1)), ["0@0,0"]);
});

test("one canvas holds every connection of a count, so switching resizes nothing", () => {
  assert.deepEqual(oplGraphCanvas(4), { cols: 4, rows: 3 });
  assert.deepEqual(oplGraphCanvas(2), { cols: 2, rows: 2 });
  assert.deepEqual(oplGraphCanvas(1), { cols: 1, rows: 1 });
  for (const ops of [1, 2, 4]) {
    const { cols, rows } = oplGraphCanvas(ops);
    for (const c of [0, 1, 2, 3]) {
      const g = oplGraph(ops, c >> 1, c & 1);
      assert.ok(g.cols <= cols && g.rows <= rows, `${ops} ops, connection ${c}`);
    }
  }
});

test("the FM Rack's loops carry no depth: its layout is unchanged", () => {
  const g = fmTreeGraph({ kind: "op", op: 0, mod: { kind: "tap", op: 0 } });
  assert.equal(g.cells[0].selfFeedback, true);
  assert.equal("feedback" in g.cells[0], false);
});
