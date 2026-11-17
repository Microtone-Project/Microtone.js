// The split view's layout rule (items 148, 335; src/ui/splitview.js
// closeLayout): up to four panes in two halves, {0, 2} and {1, 3}, and where
// every survivor goes when one closes. The DOM half is test/browser/split-smoke.html.

import { test } from "node:test";
import assert from "node:assert/strict";

import { closeLayout } from "../../src/ui/splitview.js";

/** The open set after a close, and which old pane each new one holds. */
function after(open, closing) {
  const moves = closeLayout(open, closing);
  return { open: moves.map(([, to]) => to).sort(), from: Object.fromEntries(moves.map(([f, t]) => [t, f])) };
}

const LEGAL = ["0", "0,1", "0,1,2", "0,1,3", "0,1,2,3"];

test("closing any pane of any layout leaves a legal layout", () => {
  for (const open of LEGAL.map((s) => s.split(",").map(Number))) {
    if (open.length < 2) continue;
    for (const closing of open) {
      const r = after(open, closing);
      assert.ok(LEGAL.includes(r.open.join()), `${open} − ${closing} → ${r.open}`);
      assert.equal(r.open.length, open.length - 1);
      // every survivor is somewhere, once
      assert.deepEqual(Object.values(r.from).sort(), open.filter((i) => i !== closing).sort());
    }
  }
});

test("survivors keep their place where they can, and close up where they cannot", () => {
  // two panes: the survivor is pane 0
  assert.deepEqual(after([0, 1], 1).from, { 0: 0 });
  assert.deepEqual(after([0, 1], 0).from, { 0: 1 });
  // a half's second pane closing changes nothing else
  assert.deepEqual(after([0, 1, 2, 3], 3).from, { 0: 0, 1: 1, 2: 2 });
  assert.deepEqual(after([0, 1, 2, 3], 2).from, { 0: 0, 1: 1, 3: 3 });
  // a half's first pane: its second takes its place
  assert.deepEqual(after([0, 1, 2, 3], 0).from, { 0: 2, 1: 1, 3: 3 });
  assert.deepEqual(after([0, 1, 2, 3], 1).from, { 0: 0, 1: 3, 2: 2 });
  // a half emptied: the other half's two panes become the two halves
  assert.deepEqual(after([0, 1, 2], 1).from, { 0: 0, 1: 2 });
  assert.deepEqual(after([0, 1, 3], 0).from, { 0: 1, 1: 3 });
  assert.deepEqual(after([0, 1, 3], 1).from, { 0: 0, 1: 3 });
});

test("moves come in an order that never overwrites a pane before it has moved out", () => {
  for (const open of [[0, 1], [0, 1, 2], [0, 1, 3], [0, 1, 2, 3]]) {
    for (const closing of open) {
      const moves = closeLayout(open, closing);
      const written = new Set();
      for (const [from, to] of moves) {
        assert.ok(from === to || !written.has(from), `${open} − ${closing}: ${from} read after being written`);
        written.add(to);
      }
    }
  }
});
