// New-instrument-from-sample import — planSampleImport (bankmerge.js) through
// the invertible importBankOp, plus the \uHHHH display-name helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  planSampleImport, planMultiSampleImport, buildFreshInstRecord, planExistingSampleAsInstrument,
} from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { escapeNonAscii, unescapeName } from "../../core/format/names.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

const enc = new TextEncoder();
const mkPcm = (n) => {
  const pcm = new Uint8Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 128 + Math.round(100 * Math.sin((i / n) * 20 * Math.PI));
  return pcm;
};

test("buildFreshInstRecord: sane defaults + non-zero vol-env terminator", () => {
  const rec = buildFreshInstRecord({ samplePtr: 0x1234, sampleLength: 100, samplingRate: 32000 });
  assert.equal(rec[0] | (rec[1] << 8) | (rec[2] << 16), 0x1234);
  assert.equal(rec[4] | (rec[5] << 8), 100);
  assert.equal(rec[6] | (rec[7] << 8), 32000);
  assert.equal(rec[14], 0, "loop off, no percussion");
  // the M8 gotcha: a value-0 env terminator triggers the Schism cut rule
  assert.equal(rec[21], 0x3f, "vol-env terminator value 0x3F");
  assert.equal(rec[171], 0xff, "inst global volume");
  assert.equal(rec[177], 0x80, "default pan centre");
  assert.equal(rec[182], 0xff, "filter cutoff off");
});

test("planSampleImport loop:true makes a looping instrument (item 53 paint)", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const pcm = mkPcm(128);
  const plan = planSampleImport(doc, { nameBytes: enc.encode("Painted wave"), pcm, rate: 32000, loop: true });
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const inst = doc.instruments[plan.insts[0].destSlot];
  assert.equal(inst.sampleLength, 128);
  assert.equal(inst.loopMode, 1, "forward loop enabled");
  assert.equal(inst.sampleLoopStart, 0);
  assert.equal(inst.sampleLoopEnd, 128, "loops over the whole sample");
});

test("planSampleImport errors when $01–$FF is exhausted (item 50)", () => {
  const doc = loadWhen();
  // Fill every note-addressable slot.
  for (let s = 1; s <= 255; s++) doc.markInstUsed(s);
  const plan = planSampleImport(doc, { nameBytes: new Uint8Array(0), pcm: mkPcm(64), rate: 32000 });
  assert.match(plan.error ?? "", /note-addressable/, "reports no free slot instead of silently failing");
  assert.equal(plan.insts, undefined);
});

test("planSampleImport + importBankOp: census/record/names land; undo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const usedBefore = new Set(doc.usedInstrumentSlots());
  const censusBefore = doc.sampleList().length;

  const pcm = mkPcm(500);
  const name = escapeNonAscii("Kalimba 카림바");
  const plan = planSampleImport(doc, { nameBytes: enc.encode(name), pcm, rate: 32000 });
  assert.ok(!plan.error, plan.error);
  const slot = plan.insts[0].destSlot;
  assert.ok(slot >= 1 && slot <= 255 && !usedBefore.has(slot), "lowest free note-addressable slot");
  assert.equal(plan.newSampleBytes, 500);

  const dirty = undo.apply(importBankOp(plan));
  assert.deepEqual(dirty, [{ kind: "bank" }]);

  const inst = doc.instruments[slot];
  assert.equal(inst.sampleLength, 500);
  assert.equal(inst.samplingRate, 32000);
  assert.deepEqual(
    [...doc.sampleBin.subarray(inst.samplePtr, inst.samplePtr + 500)], [...pcm],
    "pool bytes are the PCM");

  const census = doc.sampleList();
  assert.equal(census.length, censusBefore + 1);
  const entry = census.find((e) => e.ptr === inst.samplePtr && e.len === 500);
  assert.ok(entry, "census sees the new sample");
  assert.deepEqual(entry.users, [slot]);
  assert.equal(doc.instrumentName(slot), name, "INam spliced");
  assert.equal(doc.sampleName(entry.index), name, "SNam by census order");
  assert.equal(unescapeName(doc.instrumentName(slot)), "Kalimba 카림바", "display decodes");

  // round-trips through the container
  const re = new Document(parseTaud(doc.toBytes()));
  assert.equal(re.instruments[slot].sampleLength, 500);
  assert.equal(re.instrumentName(slot), name);

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("planSampleImport: content dedupe reuses the pool span and keeps its name", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const s0 = doc.sampleList()[0];
  const existing = Uint8Array.from(doc.sampleBin.subarray(s0.ptr, s0.ptr + s0.len));

  const plan = planSampleImport(doc, { nameBytes: enc.encode("dupe"), pcm: existing, rate: 12345 });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.samples.length, 0, "no new pool write");
  assert.equal(plan.dedupedSamples, 1);

  undo.apply(importBankOp(plan));
  const slot = plan.insts[0].destSlot;
  assert.equal(doc.instruments[slot].samplePtr, s0.ptr, "record points at the existing span");
  const entry = doc.sampleList().find((e) => e.ptr === s0.ptr && e.len === s0.len);
  assert.ok(entry.users.includes(slot));
  assert.equal(doc.sampleName(entry.index), s0.name, "existing sample keeps its name");
});

test("planExistingSampleAsInstrument: new inst inherits an existing pool sample (item 40)", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const usedBefore = new Set(doc.usedInstrumentSlots());
  const s0 = doc.sampleList()[0];
  const censusBefore = doc.sampleList().length;
  const poolBefore = Buffer.from(doc.sampleBin);

  const name = escapeNonAscii("copy of " + unescapeName(s0.name));
  const plan = planExistingSampleAsInstrument(doc, s0, enc.encode(name));
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.samples.length, 0, "no new pool bytes");
  assert.equal(plan.writeSnam, false, "census unchanged → SNam untouched");
  const slot = plan.insts[0].destSlot;
  assert.ok(slot >= 1 && slot <= 255 && !usedBefore.has(slot), "lowest free note-addressable slot");

  undo.apply(importBankOp(plan));

  const inst = doc.instruments[slot];
  assert.equal(inst.samplePtr, s0.ptr, "points at the existing span");
  assert.equal(inst.sampleLength, s0.len);
  assert.equal(inst.samplingRate, s0.rate, "inherits the rate");
  assert.equal(inst.sampleLoopStart, s0.loopStart & 0xffff, "inherits loop start");
  assert.equal(inst.sampleLoopEnd, s0.loopEnd & 0xffff, "inherits loop end");
  assert.equal(inst.loopMode, s0.loopMode & 0x17, "inherits loop mode");
  assert.ok(Buffer.from(doc.sampleBin).equals(poolBefore), "pool bytes unchanged");

  const census = doc.sampleList();
  assert.equal(census.length, censusBefore, "no new census entry (same pooled sample)");
  const entry = census.find((e) => e.ptr === s0.ptr && e.len === s0.len);
  assert.ok(entry.users.includes(slot), "new inst joins the sample's users");
  assert.equal(doc.instrumentName(slot), name, "INam spliced");
  assert.equal(doc.sampleName(entry.index), s0.name, "sample keeps its own name");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("planExistingSampleAsInstrument: rejects empty sample / no image", () => {
  const doc = loadWhen();
  assert.ok(planExistingSampleAsInstrument(doc, { ptr: 0, len: 0, rate: 1 }).error);
  assert.ok(planExistingSampleAsInstrument(doc, null).error);
});

test("planSampleImport: rejects empty / oversized PCM", () => {
  const doc = loadWhen();
  assert.ok(planSampleImport(doc, { pcm: new Uint8Array(0), rate: 32000 }).error);
  assert.ok(planSampleImport(doc, { pcm: new Uint8Array(0x10000), rate: 32000 }).error);
});

test("planMultiSampleImport: N chunks land as N instruments in one undoable op (item 84)", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const usedBefore = new Set(doc.usedInstrumentSlots());
  const censusBefore = doc.sampleList().length;

  const chunks = [mkPcm(300), mkPcm(400), mkPcm(500)];
  const items = chunks.map((pcm, i) => ({
    nameBytes: enc.encode(`take ${i + 1}`), pcm, rate: 32000 - i,
  }));
  const plan = planMultiSampleImport(doc, items);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.insts.length, 3);
  assert.equal(plan.newSampleBytes, 1200);
  const slots = plan.insts.map((it) => it.destSlot);
  assert.deepEqual([...slots].sort((a, b) => a - b), slots, "slots ascend in item order");
  assert.ok(slots.every((s) => s >= 1 && s <= 255 && !usedBefore.has(s)));
  assert.equal(new Set(slots).size, 3, "distinct slots");

  undo.apply(importBankOp(plan));
  const census = doc.sampleList();
  assert.equal(census.length, censusBefore + 3);
  chunks.forEach((pcm, i) => {
    const inst = doc.instruments[slots[i]];
    assert.equal(inst.sampleLength, pcm.length);
    assert.equal(inst.samplingRate, 32000 - i);
    assert.deepEqual(
      [...doc.sampleBin.subarray(inst.samplePtr, inst.samplePtr + pcm.length)], [...pcm]);
    assert.equal(doc.instrumentName(slots[i]), `take ${i + 1}`, "INam per chunk");
    const entry = census.find((e) => e.ptr === inst.samplePtr && e.len === pcm.length);
    assert.equal(doc.sampleName(entry.index), `take ${i + 1}`, "SNam per chunk");
  });

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "ONE undo step, byte-exact");
});

test("planMultiSampleImport: batch-internal dupes share a span; first name wins", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const pcm = mkPcm(256);
  const plan = planMultiSampleImport(doc, [
    { nameBytes: enc.encode("first"), pcm, rate: 32000 },
    { nameBytes: enc.encode("second"), pcm: Uint8Array.from(pcm), rate: 16000 },
  ]);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.samples.length, 1, "one pool write for identical content");
  assert.equal(plan.dedupedSamples, 1);
  assert.equal(plan.newSampleBytes, 256);

  undo.apply(importBankOp(plan));
  const [a, b] = plan.insts.map((it) => doc.instruments[it.destSlot]);
  assert.equal(a.samplePtr, b.samplePtr, "both instruments point at the shared span");
  assert.equal(b.samplingRate, 16000, "each keeps its own rate");
  const entry = doc.sampleList().find((e) => e.ptr === a.samplePtr && e.len === 256);
  assert.equal(doc.sampleName(entry.index), "first", "first item's sample name wins");
});

test("planMultiSampleImport: errors when the batch outgrows $01–$FF or the pool", () => {
  const doc = loadWhen();
  for (let s = 1; s <= 254; s++) doc.markInstUsed(s); // leave exactly one slot
  const two = planMultiSampleImport(doc, [
    { pcm: mkPcm(16), rate: 32000 }, { pcm: mkPcm(17), rate: 32000 },
  ]);
  assert.match(two.error ?? "", /note-addressable/);
  const one = planMultiSampleImport(doc, [{ pcm: mkPcm(16), rate: 32000 }]);
  assert.ok(!one.error, "a single item still fits the last slot");
  assert.ok(planMultiSampleImport(doc, []).error, "empty batch refused");
});

test("escapeNonAscii/unescapeName: inverse pair, idempotent escape", () => {
  const raw = "Über 곡 – ✓";
  const escaped = escapeNonAscii(raw);
  assert.ok(!/[^\x00-\x7f]/.test(escaped), "escaped output is pure ASCII");
  assert.equal(escapeNonAscii(escaped), escaped, "idempotent");
  assert.equal(unescapeName(escaped), raw, "round-trips");
  assert.equal(unescapeName("plain ascii"), "plain ascii");
  assert.equal(unescapeName("\\u0152uvre"), "Œuvre", "uppercase hex");
  assert.equal(unescapeName("\\u015fx"), "şx", "lowercase hex");
});
