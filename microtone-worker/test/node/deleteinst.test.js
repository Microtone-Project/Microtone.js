// Delete instrument + global change-instrument (this feature). Pure planners
// (planDeleteInstrument, metainstrumentParents, uniqueSampleSpans) + the
// invertible ops (deleteInstrumentOp, changeInstrumentOp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  instrumentCellRefs, planDeleteInstrument,
  metainstrumentParents, uniqueSampleSpans,
  classifyMetaChildren,
} from "../../src/doc/cleanup.js";
import { deleteInstrumentOp, changeInstrumentOp, importBankOp, setMetaBytesOp } from "../../src/doc/ops.js";
import { planCreateMeta } from "../../src/doc/bankmerge.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (f) => new Document(parseTaud(readFileSync(corpusDir + f)));
const loadWhen = () => load("WHEN.taud");

// ── change instrument globally ──

test("changeInstrumentOp: from → to across all patterns; undo/redo byte-exact", () => {
  const doc = loadWhen();
  const baseline = doc.toBytes();
  const from = doc.selectableInstrumentSlots().find((s) => instrumentCellRefs(doc, s).length > 0);
  const to = 0xfe; // free note-addressable slot
  const refs = instrumentCellRefs(doc, from).length;
  assert.ok(refs > 0);

  const undo = new UndoStack(doc);
  undo.apply(changeInstrumentOp(from, to));
  assert.equal(instrumentCellRefs(doc, from).length, 0, "no note still names the old number");
  assert.equal(instrumentCellRefs(doc, to).length, refs, "all its notes moved to the new number");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
  undo.redo();
  assert.equal(instrumentCellRefs(doc, to).length, refs, "redo re-applies");
});

test("changeInstrumentOp: null From remaps every non-empty instrument to To", () => {
  const doc = loadWhen();
  const to = 0x7f;
  // Count cells that carry any instrument.
  let nonEmpty = 0;
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const c of p) if ((c.instrment & 0xff) !== 0) nonEmpty++;
  }
  assert.ok(nonEmpty > 0);
  const undo = new UndoStack(doc);
  undo.apply(changeInstrumentOp(null, to));
  assert.equal(instrumentCellRefs(doc, to).length, nonEmpty, "every note now names To");
  // No OTHER instrument is referenced any more.
  for (let s = 1; s <= 0xff; s++) {
    if (s === to) continue;
    assert.equal(instrumentCellRefs(doc, s).length, 0, `slot $${s.toString(16)} freed`);
  }
});

test("changeInstrumentOp: dirty tags cover exactly the touched patterns", () => {
  const doc = loadWhen();
  const from = doc.selectableInstrumentSlots().find((s) => instrumentCellRefs(doc, s).length > 0);
  const refs = instrumentCellRefs(doc, from);
  const touchedPats = new Set(refs.filter((r) => r.song === 0).map((r) => r.pat));
  const op = changeInstrumentOp(from, 0xfe, [0]);
  op.apply(doc);
  const tags = op.dirty();
  const tagPats = new Set(tags.filter((x) => x.kind === "pattern").map((x) => x.pat));
  assert.deepEqual([...tagPats].sort((a, b) => a - b), [...touchedPats].sort((a, b) => a - b));
});

// ── delete: unreferenced instrument (case 3) ──

test("planDeleteInstrument: unreferenced slot deletes cleanly; undo byte-exact", () => {
  const doc = loadWhen();
  const baseline = doc.toBytes();
  // A used slot no pattern cell references and no meta layers (an unused inst).
  const used = new Set(doc.usedInstrumentSlots());
  const referenced = new Set();
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const c of p) if (c.instrment) referenced.add(c.instrment & 0xff);
  }
  const slot = [...used].find((s) =>
    !referenced.has(s) && metainstrumentParents(doc, s).length === 0 && !doc.metaChildSlots().has(s));
  assert.ok(slot !== undefined, "WHEN has an unreferenced instrument");

  const plan = planDeleteInstrument(doc, slot, {});
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.cells.length, 0);
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));

  assert.ok(doc.instRecordBytes(slot).every((b) => b === 0), "record zeroed");
  assert.equal(doc.instrumentName(slot), "");
  assert.ok(!doc.usedInstrumentSlots().includes(slot), "slot no longer used");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
});

test("planDeleteInstrument: empty slot is refused", () => {
  const doc = loadWhen();
  const free = [...Array(255).keys()].map((i) => i + 1)
    .find((s) => !doc.usedInstrumentSlots().includes(s));
  assert.match(planDeleteInstrument(doc, free, {}).error ?? "", /empty/);
});

// ── delete: referenced instrument (case 1) ──

test("planDeleteInstrument: referenced, no reassign → notes dangle at the empty slot", () => {
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots().find((s) => instrumentCellRefs(doc, s).length > 0);
  const refs = instrumentCellRefs(doc, slot).length;
  const plan = planDeleteInstrument(doc, slot, {});
  assert.equal(plan.danglingRefs, refs);
  assert.equal(plan.cells.length, 0);
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));
  assert.ok(doc.instRecordBytes(slot).every((b) => b === 0), "record gone");
  // The notes still name the (now empty) slot — a dangling instrument.
  assert.equal(instrumentCellRefs(doc, slot).length, refs, "notes left dangling");
});

test("planDeleteInstrument: referenced, reassignTo moves the notes then deletes", () => {
  const doc = loadWhen();
  const baseline = doc.toBytes();
  const slot = doc.selectableInstrumentSlots().find((s) => instrumentCellRefs(doc, s).length > 0);
  const to = doc.selectableInstrumentSlots().find((s) => s !== slot); // an existing instrument
  const refs = instrumentCellRefs(doc, slot).length;
  const toRefsBefore = instrumentCellRefs(doc, to).length;

  const plan = planDeleteInstrument(doc, slot, { reassignTo: to });
  assert.equal(plan.cells.length, refs);
  assert.equal(plan.danglingRefs, 0);
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));

  assert.ok(doc.instRecordBytes(slot).every((b) => b === 0), "record gone");
  assert.equal(instrumentCellRefs(doc, slot).length, 0, "no note dangles");
  assert.equal(instrumentCellRefs(doc, to).length, toRefsBefore + refs, "notes merged onto the target");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact (record + cells)");
});

// ── delete: sample freeing ──

test("uniqueSampleSpans + freeSamples: unique bytes freed, shared bytes kept", () => {
  const doc = loadWhen();
  // A slot that uniquely owns at least one sample span.
  const slot = doc.selectableInstrumentSlots().find((s) => uniqueSampleSpans(doc, s).length > 0);
  assert.ok(slot !== undefined, "WHEN has an instrument with a private sample");
  const spans = uniqueSampleSpans(doc, slot);
  const probe = spans[0];
  // The sample has non-zero content before deletion.
  const hadContent = [...doc.sampleBin.subarray(probe.ptr, probe.ptr + probe.len)].some((b) => b !== 0);
  assert.ok(hadContent, "the sample carries data");

  const withFree = planDeleteInstrument(doc, slot, { freeSamples: true });
  const withoutFree = planDeleteInstrument(doc, slot, { freeSamples: false });
  assert.ok(withFree.freedSampleBytes > 0, "reports freed bytes");
  assert.equal(withoutFree.freedSampleBytes, 0);

  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(withFree));
  const cleared = [...doc.sampleBin.subarray(probe.ptr, probe.ptr + probe.len)].every((b) => b === 0);
  assert.ok(cleared, "the private sample bytes are freed");
});

test("planDeleteInstrument realigns SNam: a later sample keeps its own name, not the deleted one's slot", () => {
  // Regression: deleting an instrument dropped its sample out of the live
  // census (usedInstrumentSlots() no longer includes it) but never rebuilt
  // SNam, so every later sample's name silently shifted onto the wrong entry.
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots().find((s) => uniqueSampleSpans(doc, s).length > 0);
  assert.ok(slot !== undefined, "WHEN has an instrument with a private sample");

  const before = doc.sampleList();
  const deletedPtr = uniqueSampleSpans(doc, slot)[0].ptr;
  const deletedIndex = before.findIndex((e) => e.ptr === deletedPtr);
  assert.ok(deletedIndex >= 0 && deletedIndex < before.length - 1,
    "pick a fixture where a named sample follows the deleted one");
  const nextEntry = before[deletedIndex + 1];

  const plan = planDeleteInstrument(doc, slot, { freeSamples: true });
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));

  const survivor = doc.sampleList().find((e) => e.ptr === nextEntry.ptr && e.len === nextEntry.len);
  assert.ok(survivor, "the following sample's span still exists");
  assert.equal(survivor.name, nextEntry.name, "its name didn't shift onto the deleted slot's old position");

  undo.undo();
  assert.deepEqual(doc.sampleList().map((e) => e.name), before.map((e) => e.name), "undo restores SNam");
});

// ── delete: sub-instrument rewires its parent metainstruments (case 2) ──

test("planDeleteInstrument: deleting a meta layer child rewires the parents", () => {
  const doc = load("M_E1M1.taud");
  const baseline = doc.toBytes();
  const metaSlot = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  assert.ok(metaSlot !== undefined, "M_E1M1 has a metainstrument");
  const layersBefore = doc.instruments[metaSlot].metaLayers.length;
  assert.ok(layersBefore >= 2, "pick a meta with room to lose a layer and stay a meta");
  const child = doc.instruments[metaSlot].metaLayers[0].instIdx & 0x3ff;
  const parents = metainstrumentParents(doc, child).map((p) => p.slot);
  assert.ok(parents.includes(metaSlot), "the meta is reported as a parent of its child");

  const plan = planDeleteInstrument(doc, child, {});
  assert.ok(plan.rewiredMetas.includes(metaSlot), "the meta is rewired, not emptied");
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));

  const after = doc.instruments[metaSlot];
  assert.equal(after.isMeta, true, "still a metainstrument");
  assert.ok(!after.metaLayers.some((l) => (l.instIdx & 0x3ff) === child), "the layer is gone");
  assert.equal(after.metaLayers.length, layersBefore - 1, "exactly one layer removed");
  assert.ok(doc.instRecordBytes(child).every((b) => b === 0), "the child record is cleared");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
});

test("planDeleteInstrument: deleting a meta's SOLE layer removes the now-empty meta", () => {
  const doc = loadWhen();
  const pick = doc.selectableInstrumentSlots().find((s) => !doc.instruments[s].isMeta);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, [pick], "Solo")));
  const metaSlot = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const child = doc.instruments[metaSlot].metaLayers[0].instIdx & 0x3ff;
  assert.equal(doc.instruments[metaSlot].metaLayers.length, 1, "single-layer meta");

  const baseline = doc.toBytes();
  const plan = planDeleteInstrument(doc, child, {});
  assert.ok(plan.emptiedMetas.includes(metaSlot), "the meta is emptied, not rewired");
  assert.ok(!plan.rewiredMetas.includes(metaSlot));
  undo.apply(deleteInstrumentOp(plan));

  assert.ok(doc.instRecordBytes(child).every((b) => b === 0), "the child is deleted");
  assert.ok(doc.instRecordBytes(metaSlot).every((b) => b === 0), "the emptied meta is removed too");
  assert.equal(doc.instrumentName(metaSlot), "");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
});

// ── deleting a metainstrument cascades to its orphaned sub-instruments ──

/** Point layer `li` of meta `mSlot` at instrument `target` (repacking the raw
 *  index bytes: low 8 bits at rawOffset, bits 8..9 in the vol-start byte's top). */
function retargetLayer(doc, mSlot, li, target) {
  const l = doc.instruments[mSlot].metaLayers[li];
  return setMetaBytesOp(mSlot, [
    [l.rawOffset, target & 0xff],
    [l.rawOffset + 8, (l.volStart & 0x3f) | (((target >>> 8) & 0x3) << 6)],
  ]);
}

test("classifyMetaChildren: item-72 copies are all $100+ orphans (auto-delete)", () => {
  const doc = loadWhen();
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, picks, "Stack")));
  const meta = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const kids = doc.instruments[meta].metaLayers.map((l) => l.instIdx & 0x3ff);
  assert.ok(kids.every((k) => k >= 0x100), "layer copies live at $100+");
  const cls = classifyMetaChildren(doc, meta);
  assert.deepEqual([...cls.autoChildren].sort((a, b) => a - b), [...kids].sort((a, b) => a - b));
  assert.equal(cls.lowChildren.length, 0);
});

test("deleting a metainstrument auto-deletes its $100+ orphan children; undo byte-exact", () => {
  const doc = loadWhen();
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, picks, "Stack")));
  const meta = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const kids = doc.instruments[meta].metaLayers.map((l) => l.instIdx & 0x3ff);
  const baseline = doc.toBytes();

  const plan = planDeleteInstrument(doc, meta, {});
  assert.deepEqual([...plan.autoChildren].sort((a, b) => a - b), [...kids].sort((a, b) => a - b));
  undo.apply(deleteInstrumentOp(plan));

  assert.ok(doc.instRecordBytes(meta).every((b) => b === 0), "the meta is gone");
  for (const k of kids) {
    assert.ok(doc.instRecordBytes(k).every((b) => b === 0), `orphan child $${k.toString(16)} removed`);
    assert.ok(!doc.usedInstrumentSlots().includes(k));
  }
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
});

test("a $100+ child shared with another meta is KEPT when one parent is deleted", () => {
  const doc = loadWhen();
  const picksA = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, picksA, "A")));
  const metaA = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const [kidShared, kidOrphan] = doc.instruments[metaA].metaLayers.map((l) => l.instIdx & 0x3ff);

  // A second meta whose first layer is retargeted onto A's first child.
  const picksB = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  undo.apply(importBankOp(planCreateMeta(doc, picksB, "B")));
  const metaB = doc.selectableInstrumentSlots().find((s) => s !== metaA && doc.instruments[s].isMeta);
  undo.apply(retargetLayer(doc, metaB, 0, kidShared));
  assert.ok(doc.instruments[metaB].metaLayers.some((l) => (l.instIdx & 0x3ff) === kidShared), "B now shares the child");

  const cls = classifyMetaChildren(doc, metaA);
  assert.deepEqual(cls.autoChildren, [kidOrphan], "only the unshared child auto-deletes");
  assert.ok(!cls.autoChildren.includes(kidShared), "the shared child is kept");

  const plan = planDeleteInstrument(doc, metaA, {});
  undo.apply(deleteInstrumentOp(plan));
  assert.ok(doc.instRecordBytes(kidShared).some((b) => b !== 0), "shared child survives");
  assert.ok(doc.instruments[metaB].metaLayers.some((l) => (l.instIdx & 0x3ff) === kidShared), "B still plays it");
  assert.ok(doc.instRecordBytes(kidOrphan).every((b) => b === 0), "orphan child removed");
});

test("a note-addressable ($01–$FF) child is offered, not auto-deleted", () => {
  const doc = loadWhen();
  const lowInst = doc.selectableInstrumentSlots()
    .find((s) => !doc.instruments[s].isMeta && s <= 0xff && instrumentCellRefs(doc, s).length > 0);
  const lowRefs = instrumentCellRefs(doc, lowInst).length;
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, picks, "Stack")));
  const meta = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const orphanKid = doc.instruments[meta].metaLayers[1].instIdx & 0x3ff; // still $100+
  undo.apply(retargetLayer(doc, meta, 0, lowInst)); // layer 0 now plays a low note-addressable inst

  const cls = classifyMetaChildren(doc, meta);
  assert.deepEqual(cls.lowChildren, [{ slot: lowInst, patternRefs: lowRefs }], "low child offered with its note count");
  assert.deepEqual(cls.autoChildren, [orphanKid], "the $100+ child still auto-deletes");

  // Default (deleteLowChildren=false): the low instrument survives untouched.
  const keepPlan = planDeleteInstrument(doc, meta, {});
  assert.deepEqual(keepPlan.deletedLowChildren, []);
  const u2 = new UndoStack(doc);
  u2.apply(deleteInstrumentOp(keepPlan));
  assert.ok(doc.instRecordBytes(lowInst).some((b) => b !== 0), "low child kept");
  assert.equal(instrumentCellRefs(doc, lowInst).length, lowRefs, "its notes are intact");
  u2.undo();

  // Opt-in: deleteLowChildren removes it too; its notes dangle at the empty slot.
  const dropPlan = planDeleteInstrument(doc, meta, { deleteLowChildren: true });
  assert.deepEqual(dropPlan.deletedLowChildren, [lowInst]);
  u2.apply(deleteInstrumentOp(dropPlan));
  assert.ok(doc.instRecordBytes(lowInst).every((b) => b === 0), "low child deleted");
  assert.equal(instrumentCellRefs(doc, lowInst).length, lowRefs, "its notes dangle (still name the empty slot)");
});

test("deleteInstrumentOp survives a save/reload (Ixmp section + INam rebuilt)", () => {
  const doc = load("M_E1M1.taud");
  const slot = doc.selectableInstrumentSlots().find((s) => instrumentCellRefs(doc, s).length > 0);
  const plan = planDeleteInstrument(doc, slot, {});
  const undo = new UndoStack(doc);
  undo.apply(deleteInstrumentOp(plan));
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.ok(reloaded.instRecordBytes(slot).every((b) => b === 0), "record stays deleted after reload");
  assert.equal(reloaded.instrumentName(slot), "", "name stays blank after reload");
});
