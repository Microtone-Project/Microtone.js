// Instruments in bulk: the Instruments list's select mode renumbers and
// deletes several instruments in one step (planRenumberInstruments,
// planDeleteInstruments, classifySetChildren). Duplicating several is
// planDuplicateInstruments, which always took a list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  instrumentCellRefs, planRenumberInstrument, planRenumberInstruments,
  planDeleteInstrument, planDeleteInstruments, classifyMetaChildren, classifySetChildren,
} from "../../src/doc/cleanup.js";
import { renumberInstrumentOp, deleteInstrumentOp, importBankOp, setMetaBytesOp } from "../../src/doc/ops.js";
import { planCreateMeta } from "../../src/doc/bankmerge.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/** A run of `n` used, consecutive, note-addressable slots whose next slot is free. */
function runWithRoomAbove(doc, n) {
  const used = new Set(doc.usedInstrumentSlots());
  for (let s = 1; s + n <= 0xff; s++) {
    let ok = !used.has(s + n);
    for (let i = 0; i < n && ok; i++) ok = used.has(s + i) && !doc.metaChildSlots().has(s + i);
    if (ok) return Array.from({ length: n }, (_, i) => s + i);
  }
  return null;
}

// ── renumber ──

test("planRenumberInstruments shifts an overlapping run: records, names, Ixmp and notes follow", () => {
  const doc = loadWhen();
  const run = runWithRoomAbove(doc, 3);
  assert.ok(run, "WHEN has three consecutive instruments with a free slot above");
  const baseline = doc.toBytes();
  const records = run.map((s) => Uint8Array.from(doc.instRecordBytes(s)));
  const names = run.map((s) => doc.instrumentName(s));
  const refs = run.map((s) => instrumentCellRefs(doc, s).length);
  const patches = run.map((s) => doc.ixmp.filter((e) => (e.instId & 0x3ff) === s).length);

  const plan = planRenumberInstruments(doc, run.map((s) => [s, s + 1]), { remapPatterns: true });
  assert.ok(!plan.error, plan.error);
  const undo = new UndoStack(doc);
  undo.apply(renumberInstrumentOp(plan));

  run.forEach((s, i) => {
    assert.ok(same(doc.instRecordBytes(s + 1), records[i]), `$${(s + 1).toString(16)} holds the old $${s.toString(16)}`);
    assert.equal(doc.instrumentName(s + 1), names[i]);
    assert.equal(doc.ixmp.filter((e) => (e.instId & 0x3ff) === s + 1).length, patches[i]);
    // Each note moved ONCE: $s's notes are at $s+1, not carried on to $s+2.
    assert.equal(instrumentCellRefs(doc, s + 1).length, refs[i]);
  });
  assert.ok(!doc.usedInstrumentSlots().includes(run[0]), "the bottom of the run is vacated");
  assert.equal(instrumentCellRefs(doc, run[0]).length, 0);

  undo.undo();
  assert.ok(same(doc.toBytes(), baseline), "undo byte-exact");
});

test("planRenumberInstruments can swap two instruments", () => {
  const doc = loadWhen();
  const [a, b] = doc.selectableInstrumentSlots().filter((s) => s <= 0xff);
  const ra = Uint8Array.from(doc.instRecordBytes(a));
  const rb = Uint8Array.from(doc.instRecordBytes(b));
  const plan = planRenumberInstruments(doc, [[a, b], [b, a]]);
  assert.ok(!plan.error, plan.error);
  new UndoStack(doc).apply(renumberInstrumentOp(plan));
  assert.ok(same(doc.instRecordBytes(a), rb));
  assert.ok(same(doc.instRecordBytes(b), ra));
});

test("planRenumberInstruments refuses a target that stays taken, out-of-range numbers and collisions", () => {
  const doc = loadWhen();
  const used = doc.usedInstrumentSlots();
  const [a, b] = doc.selectableInstrumentSlots().filter((s) => s <= 0xff);
  assert.match(planRenumberInstruments(doc, [[a, b]]).error ?? "", /already taken/);
  assert.match(planRenumberInstruments(doc, [[a, 0]]).error ?? "", /\$01–\$FF/);
  assert.match(planRenumberInstruments(doc, [[a, 0x100]]).error ?? "", /\$01–\$FF/);
  const free = [...Array(255).keys()].map((i) => i + 1).find((s) => !used.includes(s));
  assert.match(planRenumberInstruments(doc, [[a, free], [b, free]]).error ?? "", /both become/);
  assert.match(planRenumberInstruments(doc, [[a, a], [b, b]]).error ?? "", /already have/);
  assert.match(planRenumberInstruments(doc, [[free, 0xfe]]).error ?? "", /empty/);
});

test("one move through planRenumberInstruments is planRenumberInstrument", () => {
  for (const remapPatterns of [false, true]) {
    const d1 = loadWhen(), d2 = loadWhen();
    const from = d1.selectableInstrumentSlots()[0];
    new UndoStack(d1).apply(renumberInstrumentOp(planRenumberInstrument(d1, from, 0xfe, { remapPatterns })));
    new UndoStack(d2).apply(renumberInstrumentOp(planRenumberInstruments(d2, [[from, 0xfe]], { remapPatterns })));
    assert.ok(same(d1.toBytes(), d2.toBytes()), `remapPatterns=${remapPatterns}`);
  }
});

// ── delete ──

test("planDeleteInstruments deletes several in one step; reassign gathers all their notes; undo byte-exact", () => {
  const doc = loadWhen();
  const baseline = doc.toBytes();
  const played = doc.selectableInstrumentSlots()
    .filter((s) => s <= 0xff && !doc.instruments[s].isMeta && instrumentCellRefs(doc, s).length > 0);
  const [a, b, keep] = played;
  assert.ok(keep !== undefined, "WHEN plays at least three instruments");
  const refs = instrumentCellRefs(doc, a).length + instrumentCellRefs(doc, b).length;
  const keepRefs = instrumentCellRefs(doc, keep).length;

  assert.match(planDeleteInstruments(doc, [a, b], { reassignTo: b }).error ?? "", /being deleted/);
  const plan = planDeleteInstruments(doc, [a, b], { reassignTo: keep });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.cells.length, refs);
  assert.deepEqual(plan.slots, [a, b]);
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));
  for (const s of [a, b]) {
    assert.ok(doc.instRecordBytes(s).every((x) => x === 0), `$${s.toString(16)} gone`);
    assert.equal(doc.instrumentName(s), "");
    assert.equal(instrumentCellRefs(doc, s).length, 0);
  }
  assert.equal(instrumentCellRefs(doc, keep).length, keepRefs + refs);

  undo.undo();
  assert.ok(same(doc.toBytes(), baseline), "undo byte-exact");
});

test("one slot through planDeleteInstruments is planDeleteInstrument", () => {
  const probe = loadWhen();
  const slot = probe.selectableInstrumentSlots().find((s) => instrumentCellRefs(probe, s).length > 0);
  const to = probe.selectableInstrumentSlots().find((s) => s !== slot);
  for (const opts of [{}, { reassignTo: to, freeSamples: true }]) {
    const a = loadWhen(), b = loadWhen();
    new UndoStack(a).apply(deleteInstrumentOp(planDeleteInstrument(a, slot, opts)));
    new UndoStack(b).apply(deleteInstrumentOp(planDeleteInstruments(b, [slot], opts)));
    assert.ok(same(a.toBytes(), b.toBytes()), JSON.stringify(opts));
  }
});

test("a $100+ child shared only by deleted metas is an orphan of the SET", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  undo.apply(importBankOp(planCreateMeta(doc, picks, "A")));
  const metaA = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const kidsA = doc.instruments[metaA].metaLayers.map((l) => l.instIdx & 0x3ff);
  undo.apply(importBankOp(planCreateMeta(doc, picks, "B")));
  const metaB = doc.selectableInstrumentSlots().find((s) => s !== metaA && doc.instruments[s].isMeta);
  // B's first layer now plays A's first child: shared between the two.
  const l = doc.instruments[metaB].metaLayers[0];
  undo.apply(setMetaBytesOp(metaB, [
    [l.rawOffset, kidsA[0] & 0xff],
    [l.rawOffset + 8, (l.volStart & 0x3f) | (((kidsA[0] >>> 8) & 0x3) << 6)],
  ]));

  assert.ok(!classifyMetaChildren(doc, metaA).autoChildren.includes(kidsA[0]), "alone, A keeps the shared child");
  const both = classifySetChildren(doc, [metaA, metaB]);
  assert.ok(both.autoChildren.includes(kidsA[0]), "with B going too, nothing else uses it");
  assert.equal(new Set(both.autoChildren).size, both.autoChildren.length, "each child listed once");

  const plan = planDeleteInstruments(doc, [metaA, metaB]);
  undo.apply(deleteInstrumentOp(plan));
  for (const k of both.autoChildren) assert.ok(!doc.usedInstrumentSlots().includes(k), `$${k.toString(16)} removed`);
});
