// Envelope node-array surgery (item 181) — the arithmetic both envelope
// editors share, which used to be two copies carrying the same two bugs:
//
// - deleting the LAST node did nothing to the node COUNT. The last node is the
//   terminator, so merging its (zero) segment into the node before it left
//   that node's offset non-zero and the count where it was. What the click did
//   change was the tail's VALUE, to 0 — which on a volume envelope is
//   Schism's "envelope end at value 0" cut rule, i.e. an instant note cut.
// - a sustain point holding on the last node stayed put when a node was
//   appended after it, so the note started releasing through the new segment
//   while the key was still down.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_MAX_NODES, ENV_MAX_SEGMENT, envActiveCount, envAddNode, envRemoveNode,
  envFollowTailSustain, envClampWrap, envDragNode, minifloatNearest,
} from "../../src/doc/envedit.js";
import { minifloatFromDouble, minifloatToDouble, MINIFLOAT_LUT } from "../../core/engine/minifloat.js";

/** A 25-slot array from `[value, seconds]` pairs; the rest are zero nodes.
 *  The last pair given gets offset 0 — the terminator — unless it says
 *  otherwise, which is how a real record is shaped. */
function env(...pairs) {
  const a = Array.from({ length: ENV_MAX_NODES }, () => ({ value: 0, offset: 0 }));
  pairs.forEach(([value, sec], i) => {
    a[i] = { value, offset: sec === 0 ? 0 : minifloatFromDouble(sec) };
  });
  return a;
}

const secs = (node) => minifloatToDouble(node.offset);
/** LOOP/SUSTAIN word from enable + start + end. */
const word = (on, start, end) => ((on ? 0x20 : 0) | (start << 8) | end) & 0xffff;

test("the active count is the first zero-duration node, plus one", () => {
  assert.equal(envActiveCount(env([63, 0])), 1);
  assert.equal(envActiveCount(env([63, 0.5], [40, 0])), 2);
  assert.equal(envActiveCount(env([63, 0.5], [40, 0.5], [0, 0])), 3);
  // 25 non-zero offsets: the array is full and the count saturates.
  assert.equal(envActiveCount(Array.from({ length: ENV_MAX_NODES },
    () => ({ value: 32, offset: minifloatFromDouble(0.1) }))), ENV_MAX_NODES);
});

test("appending a node gives the old tail a span and moves the terminator", () => {
  const res = envAddNode(env([63, 0]), 0, 63);
  assert.equal(res.appended, true);
  assert.equal(res.selected, 1);
  assert.equal(envActiveCount(res.nodes), 2);
  assert.ok(secs(res.nodes[0]) > 0, "the old last node now has a segment");
  assert.equal(res.nodes[1].offset, 0, "the appended node is the terminator");
  assert.equal(res.nodes[1].value, 63, "and holds the value the envelope held");
});

test("an interior node splits the segment it lands in", () => {
  const e = env([0, 1.0], [60, 0.5], [30, 0]);
  const res = envAddNode(e, 0, 63);
  assert.equal(res.appended, false);
  assert.equal(res.selected, 1);
  assert.equal(envActiveCount(res.nodes), 4);
  assert.equal(res.nodes[1].value, 30, "midpoint of the two values it sits between");
  const rebuilt = secs(res.nodes[0]) + secs(res.nodes[1]);
  assert.ok(Math.abs(rebuilt - 1.0) < 0.05, `split segments still total ~1 s (${rebuilt})`);
  assert.equal(res.nodes[2].value, 60, "the nodes after it shifted up");
  assert.equal(res.nodes[3].value, 30);
  assert.equal(res.nodes[3].offset, 0, "and the terminator moved with them");
});

test("a full envelope refuses another node", () => {
  const full = Array.from({ length: ENV_MAX_NODES },
    () => ({ value: 32, offset: minifloatFromDouble(0.1) }));
  assert.equal(envAddNode(full, 4, 63), null);
});

test("removing the LAST node actually shortens the envelope", () => {
  // Two nodes: the bug case the report names. The old code returned an
  // envelope that still had two nodes, with the tail's value zeroed.
  const two = envRemoveNode(env([63, 0.5], [40, 0]), 1);
  assert.equal(two.active, 1);
  assert.equal(envActiveCount(two.nodes), 1);
  assert.equal(two.nodes[0].value, 63, "the surviving node keeps its value");
  assert.equal(two.nodes[0].offset, 0, "and becomes the terminator itself");
  assert.equal(two.selected, 0);

  // And at any other length.
  const four = envRemoveNode(env([63, 0.5], [40, 0.5], [20, 0.5], [10, 0]), 3);
  assert.equal(four.active, 3);
  assert.equal(envActiveCount(four.nodes), 3);
  assert.equal(four.nodes[2].value, 20);
  assert.equal(four.nodes[2].offset, 0);
});

test("removing an interior node merges its segment into the one before", () => {
  const res = envRemoveNode(env([0, 0.5], [63, 0.25], [30, 0.5], [10, 0]), 1);
  assert.equal(res.active, 3);
  assert.equal(res.nodes[0].value, 0);
  const merged = secs(res.nodes[0]);
  assert.ok(Math.abs(merged - 0.75) < 0.05, `0.5 + 0.25 merged into ${merged}`);
  assert.equal(res.nodes[1].value, 30, "the tail shifted down");
  assert.equal(res.nodes[2].value, 10);
  assert.equal(res.nodes[2].offset, 0);
  assert.equal(res.selected, 0);
});

test("removing from a FULL envelope does not duplicate the tail", () => {
  const full = Array.from({ length: ENV_MAX_NODES },
    (_, i) => ({ value: i, offset: minifloatFromDouble(0.1) }));
  const res = envRemoveNode(full, 5);
  assert.equal(res.active, ENV_MAX_NODES - 1);
  assert.equal(res.nodes[ENV_MAX_NODES - 1].offset, 0, "the vacated slot is cleared");
  assert.equal(res.nodes[ENV_MAX_NODES - 1].value, 0);
  assert.equal(envActiveCount(res.nodes), ENV_MAX_NODES - 1);
});

test("node 0 and a one-node envelope refuse removal", () => {
  assert.equal(envRemoveNode(env([63, 0.5], [40, 0]), 0), null, "node 0 is anchored at t=0");
  assert.equal(envRemoveNode(env([63, 0]), 0), null);
  assert.equal(envRemoveNode(env([63, 0.5], [40, 0]), 4), null, "beyond the tail");
});

test("an enabled sustain point on the tail follows the appended node", () => {
  // Single-point sustain holding the final level — the pad idiom.
  assert.equal(envFollowTailSustain(word(true, 2, 2), 2, 3), word(true, 3, 3));
  // A sustain RANGE ending on the tail grows to take the new node in.
  assert.equal(envFollowTailSustain(word(true, 1, 2), 2, 3), word(true, 1, 3));
  // One sitting elsewhere stays exactly where it was put.
  assert.equal(envFollowTailSustain(word(true, 0, 1), 2, 3), word(true, 0, 1));
  // A DISABLED sustain is not describing anything, so it is left alone.
  assert.equal(envFollowTailSustain(word(false, 2, 2), 2, 3), word(false, 2, 2));
  // Every other bit of the word survives (bit 5 is the enable).
  assert.equal(envFollowTailSustain(0xffff, 31, 24) & ~0x1f1f, 0xffff & ~0x1f1f);
});

test("arming switches a disabled sustain on and lets its points move", () => {
  // What a fresh envelope looks like when the same click claims presence: the
  // word is all zeroes — sustain off, start and end both 0 — and 0 IS the last
  // node of the one-node envelope being appended to.
  assert.equal(envFollowTailSustain(0x0000, 0, 1, true), word(true, 1, 1));
  // Interior add on a just-claimed envelope: arm with an oldLast nothing can
  // match, so the enable goes on and the indices stay put.
  assert.equal(envFollowTailSustain(word(false, 2, 4), -1, -1, true), word(true, 2, 4));
  // Arming is idempotent on an already-enabled sustain — same result as not
  // passing it at all.
  assert.equal(envFollowTailSustain(word(true, 2, 2), 2, 3, true), word(true, 3, 3));
  assert.equal(envFollowTailSustain(word(true, 2, 2), 2, 3, true),
    envFollowTailSustain(word(true, 2, 2), 2, 3));
  // And without arming, a disabled sustain is still left exactly alone.
  assert.equal(envFollowTailSustain(word(false, 0, 0), 0, 1, false), word(false, 0, 0));
});

test("wrap indices are pulled back inside a shortened envelope", () => {
  assert.equal(envClampWrap(word(true, 4, 6), 3), word(true, 2, 2));
  assert.equal(envClampWrap(word(true, 1, 2), 3), word(true, 1, 2), "already in range");
  assert.equal(envClampWrap(word(true, 5, 5), 1), word(true, 0, 0));
  // A disabled word is clamped too: the spinners show it clamped either way,
  // and the record should not disagree with the panel.
  assert.equal(envClampWrap(word(false, 9, 9), 2), word(false, 1, 1));
  assert.equal(envClampWrap(0x2000 | word(true, 7, 7), 4) & 0x2000, 0x2000,
    "the P bit is not a wrap index");
});

// ── dragging a node sideways (item 227) ─────────────────────────────────────

/** Cumulative node times of an envelope after a drag result is written in. */
function timesAfter(e, idx, res) {
  const nodes = e.map((n) => ({ ...n }));
  nodes[idx - 1].offset = res.prevOffset;
  if (res.offset !== undefined) nodes[idx].offset = res.offset;
  const times = [0];
  for (let i = 0; i < ENV_MAX_NODES - 1; i++) times.push(times[i] + secs(nodes[i]));
  return { nodes, times };
}

test("the drag quantiser takes the NEAREST code, and never the terminator", () => {
  for (let i = 0; i < 256; i++) assert.equal(minifloatNearest(MINIFLOAT_LUT[i]), i);
  // The shortest segment, 1/256 s, was out of a drag's reach: the engine's
  // fromFloat takes the even code of the two around a value, so everything
  // between 3.9 and 7.8 ms landed on 7.8, and anything shorter on code 0 —
  // which ends the envelope at that node.
  assert.equal(minifloatFromDouble(0.004), 2, "the quirk this works around");
  assert.equal(minifloatNearest(0.004, 1), 1);
  assert.equal(minifloatNearest(0.001, 1), 1, "an open segment stays open");
  assert.equal(minifloatNearest(-3, 1), 1);
  assert.equal(minifloatNearest(Number.NaN, 1), 1);
  assert.equal(minifloatNearest(99), 255);
  // Halfway between two codes goes down; past it, up.
  const mid = (MINIFLOAT_LUT[40] + MINIFLOAT_LUT[41]) / 2;
  assert.equal(minifloatNearest(mid), 40);
  assert.equal(minifloatNearest(mid + 1e-6), 41);
});

test("an interior node moves between its neighbours and the envelope keeps its length", () => {
  const e = env([63, 0.25], [40, 0.5], [20, 0.25], [0, 0]);
  const before = timesAfter(e, 1, { prevOffset: e[0].offset, offset: e[1].offset }).times;
  // Slack of half a step of the coarser grid (1/64 s for the half-second
  // segment): that is how often a pair keeping the sum exact comes round.
  for (let want = 0.01; want < 0.74; want += 0.0137) {
    const res = envDragNode(e, 1, want, { slack: 1 / 128 });
    const { times } = timesAfter(e, 1, res);
    assert.ok(Math.abs(times[1] - want) <= 1 / 128, `node 1 follows the pointer to ${want}`);
    assert.equal(times[2], before[2], `node 2 stays put (want ${want})`);
    assert.equal(times[3], before[3], "and so does the end");
  }
  // Pushed onto a neighbour, it stops one step short: neither segment may
  // close, since a zero offset would end the envelope there.
  const left = envDragNode(e, 1, -1);
  assert.equal(left.prevOffset, 1);
  const right = envDragNode(e, 1, 5);
  assert.equal(right.offset, 1);
  assert.equal(envActiveCount(timesAfter(e, 1, right).nodes), 4);
});

test("with no slack the node goes where it is put, and the next one barely moves", () => {
  // 0.1 s + 10 s: the long segment's grid is a quarter-second, so with the node
  // placed to its own resolution the node after may shift — by at most half
  // that step, and never cumulatively within one gesture (every step starts
  // from the envelope the gesture found).
  const e = env([63, 0.1], [40, 10], [0, 0]);
  const end = secs(e[0]) + secs(e[1]);
  for (let want = 0.01; want < 2; want += 0.037) {
    const { times } = timesAfter(e, 1, envDragNode(e, 1, want));
    assert.ok(Math.abs(times[2] - end) <= 0.125, `end at ${times[2]} for ${want}`);
    const own = Math.abs(minifloatToDouble(minifloatNearest(want, 1)) - want);
    assert.ok(Math.abs(times[1] - want) <= own + 1e-12, `node 1 at ${times[1]} for ${want}`);
  }
  // Back where it started: every code exactly as it was, at any slack.
  for (const slack of [0, 0.01, 0.3]) {
    assert.deepEqual(envDragNode(e, 1, secs(e[0]), { slack }),
      { prevOffset: e[0].offset, offset: e[1].offset });
  }
});

test("a 4 ms attack can be dragged to before a long segment", () => {
  // 8 ms → 4 ms with half a second after it: no pair at 4 ms keeps the sum
  // exact (the half-second grid is 1/128 s), and holding out for one snapped
  // the node back to 8 ms. A few pixels of slack at an ordinary zoom still
  // reaches it; the next node gives way by under 4 ms.
  const e = env([0, 0.008], [63, 0.492], [40, 0]);
  const res = envDragNode(e, 1, 0.004, { slack: 0.003 });
  assert.equal(res.prevOffset, 1);
  const { times } = timesAfter(e, 1, res);
  assert.ok(Math.abs(times[2] - (secs(e[0]) + secs(e[1]))) < 0.004);
});

test("the last node moves the end by exactly the distance dragged", () => {
  const e = env([63, 0.5], [40, 0.5], [0, 0]);
  const res = envDragNode(e, 2, 1.1);
  assert.deepEqual(Object.keys(res), ["prevOffset"], "its own offset stays the terminator");
  assert.ok(Math.abs(timesAfter(e, 2, res).times[2] - 1.1) < 0.008);
  // 8 ms → 4 ms by dragging: the shortest segment is reachable.
  const short = env([63, 0.5], [40, 0.008], [0, 0]);
  assert.equal(minifloatToDouble(envDragNode(short, 2, 0.5 + 0.004).prevOffset), 1 / 256);
  // A segment holds 15.75 s at most, and that is where a long drag stops.
  assert.equal(minifloatToDouble(envDragNode(e, 2, 999).prevOffset), ENV_MAX_SEGMENT);
});

test("a Shift-drag re-times the segment before the node and carries the rest", () => {
  const e = env([63, 0.25], [40, 0.5], [20, 0.25], [0, 0]);
  const res = envDragNode(e, 1, 0.5, { carry: true });
  assert.equal(res.offset, e[1].offset, "the segment after is untouched, but named");
  const { times } = timesAfter(e, 1, res);
  assert.equal(times[1], 0.5);
  assert.equal(times[2] - times[1], secs(e[1]), "everything after moved with it");
});

test("node 0 is anchored, and a node past the end is no node", () => {
  const e = env([63, 0.5], [40, 0]);
  assert.equal(envDragNode(e, 0, 0.3), null);
  assert.equal(envDragNode(e, 2, 0.3), null);
});
