// Duplicate / delete a pooled sample (item 151) — planDuplicateSample through
// importBankOp, planDeleteSample through cleanupBankOp. The census is derived
// from instruments, so both are really instrument-and-pool edits: a duplicate
// mints a slot to hold the copy, a delete leaves every base record bound to the
// sample DANGLING (slot kept, sample gone) and drops the patches bound to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { planDuplicateSample } from "../../src/doc/bankmerge.js";
import { planDeleteSample } from "../../src/doc/cleanup.js";
import { importBankOp, cleanupBankOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document, sampleSpans } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (f) => new Document(parseTaud(readFileSync(corpusDir + f)));
const enc = new TextEncoder();
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const key = (e) => e.ptr + ":" + e.len;

test("planDuplicateSample: fresh bytes, fresh slot, loop/rate carried over", () => {
  const doc = load("WHEN.taud");
  const src = doc.sampleList().find((e) => (e.loopMode & 3) !== 0) ?? doc.sampleList()[0];
  const before = doc.sampleList().length;
  const plan = planDuplicateSample(doc, src, enc.encode("copy"));
  assert.ok(!plan.error, plan.error);
  new UndoStack(doc).apply(importBankOp(plan));

  const census = doc.sampleList();
  assert.equal(census.length, before + 1, "the copy is its own census entry");
  const copy = census.find((e) => e.ptr === plan.duplicate.ptr);
  assert.notEqual(copy.ptr, src.ptr, "NOT deduped onto the original — that is the point");
  assert.equal(copy.name, "copy");
  assert.equal(copy.len, src.len);
  assert.equal(copy.rate, src.rate);
  assert.equal(copy.loopMode, src.loopMode);
  assert.equal(copy.loopStart, src.loopStart);
  assert.equal(copy.loopEnd, src.loopEnd);
  assert.deepEqual(copy.users, [plan.duplicate.slot], "played by the new instrument only");
  assert.ok(same(doc.sampleBin.subarray(src.ptr, src.ptr + src.len),
                 doc.sampleBin.subarray(copy.ptr, copy.ptr + copy.len)), "byte-for-byte copy");
});

test("planDuplicateSample: every OTHER sample keeps its name across the census shift", () => {
  const doc = load("Onestop.taud");
  const oldNames = new Map(doc.sampleList().map((e) => [key(e), e.name]));
  const src = doc.sampleList()[3];
  const plan = planDuplicateSample(doc, src, enc.encode("DUP"));
  assert.ok(!plan.error, plan.error);
  new UndoStack(doc).apply(importBankOp(plan));
  for (const e of doc.sampleList()) {
    if (e.ptr === plan.duplicate.ptr) { assert.equal(e.name, "DUP"); continue; }
    assert.equal(e.name, oldNames.get(key(e)), `sample ${e.index} kept its name`);
  }
});

test("duplicate then undo is byte-exact", () => {
  const doc = load("WHEN.taud");
  const undo = new UndoStack(doc);
  const before = doc.toBytes();
  undo.apply(importBankOp(planDuplicateSample(doc, doc.sampleList()[0], enc.encode("x"))));
  undo.undo();
  assert.ok(same(doc.toBytes(), before));
});

test("planDeleteSample: the sample leaves the census, its base users dangle", () => {
  const doc = load("WHEN.taud");
  const target = doc.sampleList()[1];
  const users = target.users.slice();
  const plan = planDeleteSample(doc, target);
  assert.ok(!plan.error, plan.error);
  assert.deepEqual(plan.clearedInsts, users, "every base user is reported as dangling");
  new UndoStack(doc).apply(cleanupBankOp(plan));

  assert.ok(!doc.sampleList().some((e) => key(e) === key(target)), "gone from the census");
  for (const u of users) {
    const inst = doc.instruments[u];
    assert.equal(inst.sampleLength, 0, `$${u.toString(16)} lost its sample`);
    assert.equal(inst.samplePtr, 0);
    assert.ok(doc.usedInstrumentSlots().includes(u), "the slot itself survives (dangling, not deleted)");
  }
});

test("planDeleteSample: pool bytes are freed and the delete survives a reload", () => {
  const doc = load("WHEN.taud");
  const target = doc.sampleList()[1];
  const plan = planDeleteSample(doc, target);
  assert.equal(plan.freedSampleBytes > 0, true);
  new UndoStack(doc).apply(cleanupBankOp(plan));
  assert.ok(doc.sampleBin.subarray(target.ptr, target.ptr + target.len).every((b) => b === 0),
    "the span is zeroed");
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.ok(!reloaded.sampleList().some((e) => key(e) === key(target)), "still gone after a save/reload");
});

test("planDeleteSample: patches bound to the sample are dropped, the blob with them", () => {
  const doc = load("Onestop.taud");
  const census = doc.sampleList();
  const target = census.find((e) =>
    e.users.some((u) => (doc.instruments[u].extraPatches ?? []).some(
      (p) => p.samplePtr === e.ptr && p.sampleLength === e.len)));
  assert.ok(target, "the corpus has a patch-bound sample");
  const plan = planDeleteSample(doc, target);
  assert.ok(plan.removedPatches > 0);
  assert.deepEqual(plan.patchedInsts.map((r) => r.slot).sort((a, b) => a - b),
    target.users.slice().sort((a, b) => a - b));
  new UndoStack(doc).apply(cleanupBankOp(plan));
  for (const u of target.users) {
    for (const p of doc.instruments[u].extraPatches ?? []) {
      assert.ok(!(p.samplePtr === target.ptr && p.sampleLength === target.len),
        "no surviving patch still points at the deleted sample");
    }
  }
  // Reload: the Ixmp SECTION has to be rebuilt, or the patches come back.
  const reloaded = new Document(parseTaud(doc.toBytes()));
  for (const u of target.users) {
    for (const p of reloaded.instruments[u].extraPatches ?? []) {
      assert.ok(!(p.samplePtr === target.ptr && p.sampleLength === target.len));
    }
  }
});

test("planDeleteSample: names realign and every other sample survives", () => {
  const doc = load("Onestop.taud");
  const census = doc.sampleList();
  const oldNames = new Map(census.map((e) => [key(e), e.name]));
  const target = census[5];
  new UndoStack(doc).apply(cleanupBankOp(planDeleteSample(doc, target)));
  const after = doc.sampleList();
  assert.equal(after.length, census.length - 1);
  for (const e of after) assert.equal(e.name, oldNames.get(key(e)), `sample kept its name`);
});

test("planDeleteSample never zeroes a byte a surviving sample still covers", () => {
  const doc = load("Onestop.taud");
  const census = doc.sampleList();
  const target = census[2];
  const survivors = census.filter((e) => key(e) !== key(target)).flatMap(sampleSpans);
  const copies = survivors.map((sp) => Uint8Array.from(doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len)));
  new UndoStack(doc).apply(cleanupBankOp(planDeleteSample(doc, target)));
  survivors.forEach((sp, i) => {
    assert.ok(same(doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len), copies[i]),
      `surviving span at ${sp.ptr} is untouched`);
  });
});

test("delete then undo is byte-exact", () => {
  const doc = load("Onestop.taud");
  const undo = new UndoStack(doc);
  const before = doc.toBytes();
  undo.apply(cleanupBankOp(planDeleteSample(doc, doc.sampleList()[4])));
  undo.undo();
  assert.ok(same(doc.toBytes(), before));
});

test("planDeleteSample refuses a sample nothing points at", () => {
  const doc = load("WHEN.taud");
  const ghost = { ptr: 0x700000, len: 64, users: [], loopMode: 0, rate: 8363 };
  assert.ok(planDeleteSample(doc, ghost).error);
  assert.ok(planDeleteSample(doc, { ...ghost, len: 0 }).error);
});
