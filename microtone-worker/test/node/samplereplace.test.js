// In-place sample replace (item 109) — planReplaceSample + importBankOp. The
// Sample Lab's second commit: instead of minting new instruments, the edited
// audio takes over the pooled sample every existing instrument already plays.
//
// What has to hold: pool bytes land where the plan says (reusing the old span
// when they fit, freeing what shrinks away), EVERY reference follows — base
// records AND Ixmp patches, including a stereo pair's second channel — play and
// loop markers are carried through the Lab's edit by `mapPos`, the sample keeps
// (or takes) its SNam name, and one undo puts all of it back byte-exactly,
// including after a save/reload round trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { Document, sampleSpans, isStereoSample } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp } from "../../src/doc/ops.js";
import { planReplaceSample, planMultiSampleImport } from "../../src/doc/bankmerge.js";
import { patchIsStereo, patchChannelPtrs } from "../../core/engine/inst.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
const enc = new TextEncoder();

/** A pooled sample whose census entry is played by a real base record. */
function pickBaseSample(doc) {
  return doc.sampleList().find((e) => e.users.some((u) => {
    const inst = doc.instruments[u];
    return !inst.isMeta && inst.samplePtr === e.ptr && inst.sampleLength === e.len;
  }));
}

const ramp = (n, phase = 0) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + phase * 13) % 251 + 1);

/** WHEN + one imported stereo sample, so the doc HAS an Ixmp section. */
function stereoDoc(n = 400) {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const plan = planMultiSampleImport(doc, [{
    nameBytes: enc.encode("pair"), pcm: ramp(n, 0), pcmR: ramp(n, 1), rate: 22050, loop: true,
  }]);
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(importBankOp(plan));
  const slot = plan.insts[0].destSlot;
  const entry = doc.sampleList().find((e) => e.ptr === doc.instruments[slot].samplePtr);
  return { doc, undo, slot, entry };
}

test("same length: pool bytes swap, nothing else moves, undo restores", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const s = pickBaseSample(doc);
  const before = Uint8Array.from(doc.sampleBin.subarray(s.ptr, s.ptr + s.len));
  const users = s.users.filter((u) => !doc.instruments[u].isMeta);
  const loopsBefore = users.map((u) => doc.instruments[u].sampleLoopEnd);
  const censusBefore = doc.sampleList().length;

  const pcm = ramp(s.len);
  const plan = planReplaceSample(doc, s, { pcm, rate: s.rate });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.ptr, s.ptr, "an equal-length replace stays where it was");
  assert.equal(plan.moved, false);
  assert.equal(plan.samples.length, 1, "one write, no freed gap");
  undo.apply(importBankOp(plan));

  assert.deepEqual([...doc.sampleBin.subarray(s.ptr, s.ptr + s.len)], [...pcm]);
  assert.equal(doc.sampleList().length, censusBefore, "the census is unchanged");
  users.forEach((u, i) => {
    assert.equal(doc.instruments[u].samplePtr, s.ptr);
    assert.equal(doc.instruments[u].sampleLength, s.len);
    assert.equal(doc.instruments[u].sampleLoopEnd, loopsBefore[i], "markers untouched");
  });

  undo.undo();
  assert.deepEqual([...doc.sampleBin.subarray(s.ptr, s.ptr + s.len)], [...before]);
});

test("shorter: the span is reused, the tail is freed, markers follow mapPos", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const s = pickBaseSample(doc);
  const slot = s.users.find((u) => !doc.instruments[u].isMeta &&
    doc.instruments[u].samplePtr === s.ptr && doc.instruments[u].sampleLength === s.len);
  // Give the slot a loop worth remapping, then crop the first quarter away.
  const cut = Math.floor(s.len / 4);
  doc.instruments[slot].sampleLoopStart = Math.floor(s.len / 2);
  doc.instruments[slot].sampleLoopEnd = s.len;
  doc.instruments[slot].loopMode = 1;
  doc.markInstUsed(slot);

  const newLen = s.len - cut;
  const pcm = ramp(newLen);
  const plan = planReplaceSample(doc, s, {
    pcm, rate: s.rate, mapPos: (p) => Math.max(0, Math.min(newLen, p - cut)),
  });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.ptr, s.ptr, "a shrink reuses the head of the old span");
  assert.equal(plan.len, newLen);
  undo.apply(importBankOp(plan));

  const inst = doc.instruments[slot];
  assert.equal(inst.sampleLength, newLen, "the record's length follows");
  assert.equal(inst.sampleLoopStart, Math.floor(s.len / 2) - cut, "loop start shifted by the crop");
  assert.equal(inst.sampleLoopEnd, newLen, "loop end lands on the new end");
  assert.deepEqual([...doc.sampleBin.subarray(s.ptr, s.ptr + newLen)], [...pcm]);
  assert.ok(doc.sampleBin.subarray(s.ptr + newLen, s.ptr + s.len).every((b) => b === 0),
    "the bytes the crop freed are zeroed");
  const list = doc.sampleList();
  assert.ok(list.some((e) => e.ptr === s.ptr && e.len === newLen), "census sees the new length");

  undo.undo();
  assert.equal(doc.instruments[slot].sampleLength, s.len);
  assert.equal(doc.instruments[slot].sampleLoopStart, Math.floor(s.len / 2));
});

test("longer + new rate: every reference is rewritten, freed bytes are zeroed", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const s = pickBaseSample(doc);
  const users = s.users.filter((u) => !doc.instruments[u].isMeta);
  const oldPtr = s.ptr, oldLen = s.len;
  const newLen = oldLen * 2 + 97;
  const pcm = ramp(newLen);

  const plan = planReplaceSample(doc, s, { pcm, rate: 8000 });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.len, newLen);
  undo.apply(importBankOp(plan));

  for (const u of users) {
    assert.equal(doc.instruments[u].samplePtr, plan.ptr, "the record points at the new span");
    assert.equal(doc.instruments[u].sampleLength, newLen);
    assert.equal(doc.instruments[u].samplingRate, 8000, "the new rate reaches every user");
  }
  assert.deepEqual([...doc.sampleBin.subarray(plan.ptr, plan.ptr + newLen)], [...pcm]);
  if (plan.moved) {
    assert.ok(doc.sampleBin.subarray(oldPtr, oldPtr + oldLen).every((b) => b === 0),
      "the whole old span is freed when the sample moves");
  }
  const list = doc.sampleList();
  assert.ok(list.some((e) => e.ptr === plan.ptr && e.len === newLen));
  assert.ok(!list.some((e) => e.ptr === oldPtr && e.len === oldLen), "the old identity is gone");

  undo.undo();
  assert.ok(doc.sampleList().some((e) => e.ptr === oldPtr && e.len === oldLen),
    "undo brings the old sample back");
  for (const u of users) assert.equal(doc.instruments[u].samplePtr, oldPtr);
});

test("stereo pair: both channels follow, and a fold to mono drops the 's' block", () => {
  const { doc, undo, slot, entry } = stereoDoc(400);
  assert.equal(isStereoSample(entry), true);
  const [lPtr, rPtr] = sampleSpans(entry).map((sp) => sp.ptr);

  // 1. stereo → stereo, shorter: both spans shrink, the patch keeps its pair
  const shortLen = 250;
  let plan = planReplaceSample(doc, entry, {
    pcm: ramp(shortLen, 2), pcmR: ramp(shortLen, 3), rate: 32000,
  });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.chanPtrs.length, 1);
  undo.apply(importBankOp(plan));
  let patch = doc.instruments[slot].extraPatches[0];
  assert.equal(patchIsStereo(patch), true);
  assert.equal(patch.sampleLength, shortLen);
  assert.equal(patch.samplingRate, 32000);
  assert.deepEqual(patchChannelPtrs(patch), [plan.ptr, plan.chanPtrs[0]]);
  assert.deepEqual([...doc.sampleBin.subarray(plan.chanPtrs[0], plan.chanPtrs[0] + shortLen)],
    [...ramp(shortLen, 3)]);
  assert.equal(doc.instruments[slot].sampleLength, shortLen, "the base record follows too");

  // 2. stereo → mono: the second channel's bytes go back to the pool
  const monoEntry = doc.sampleList().find((e) => e.ptr === plan.ptr);
  const rSpan = sampleSpans(monoEntry)[1].ptr;
  const plan2 = planReplaceSample(doc, monoEntry, { pcm: ramp(shortLen, 4), rate: 32000 });
  assert.equal(plan2.error, undefined, plan2.error);
  assert.equal(plan2.droppedChannel, true);
  undo.apply(importBankOp(plan2));
  patch = doc.instruments[slot].extraPatches[0];
  assert.equal(patchIsStereo(patch), false, "the 's' block is gone");
  assert.equal(isStereoSample(doc.sampleList().find((e) => e.ptr === plan2.ptr)), false);
  assert.ok(doc.sampleBin.subarray(rSpan, rSpan + shortLen).every((b) => b === 0),
    "the right channel's pool bytes are freed");

  // 3. and the refusal in the other direction
  const bad = planReplaceSample(doc, doc.sampleList().find((e) => e.ptr === plan2.ptr), {
    pcm: ramp(shortLen, 5), pcmR: ramp(shortLen, 6), rate: 32000,
  });
  assert.match(bad.error ?? "", /mono sample can't be replaced by a stereo one/);

  undo.undo();
  assert.equal(patchIsStereo(doc.instruments[slot].extraPatches[0]), true, "undo restores the pair");
  assert.deepEqual([...doc.sampleBin.subarray(rSpan, rSpan + shortLen)], [...ramp(shortLen, 3)]);
});

test("the replaced sample survives a save/reload with its Ixmp section", () => {
  const { doc, undo, slot, entry } = stereoDoc(320);
  const newLen = 512;
  const plan = planReplaceSample(doc, entry, {
    pcm: ramp(newLen, 7), pcmR: ramp(newLen, 8), rate: 16000,
    nameBytes: enc.encode("replaced pair"),
  });
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(importBankOp(plan));

  const reloaded = new Document(parseTaud(doc.toBytes()));
  const rePatch = reloaded.instruments[slot].extraPatches[0];
  assert.equal(patchIsStereo(rePatch), true, "the Ixmp SECTION carried the rewritten patch");
  assert.deepEqual(patchChannelPtrs(rePatch), [plan.ptr, plan.chanPtrs[0]]);
  assert.equal(rePatch.sampleLength, newLen);
  assert.equal(rePatch.samplingRate, 16000);
  const reEntry = reloaded.sampleList().find((e) => e.ptr === plan.ptr);
  assert.equal(reEntry.len, newLen);
  assert.equal(reloaded.sampleName(reEntry.index), "replaced pair", "the rename went with it");
  assert.deepEqual([...reloaded.sampleBin.subarray(plan.ptr, plan.ptr + newLen)], [...ramp(newLen, 7)]);

  // undo → save → reload puts the original pair back on disk too
  undo.undo();
  const back = new Document(parseTaud(doc.toBytes()));
  const backPatch = back.instruments[slot].extraPatches[0];
  assert.equal(backPatch.sampleLength, 320);
  assert.equal(back.sampleName(back.sampleList().find((e) => e.ptr === backPatch.samplePtr).index),
    "pair");
});

test("a rename alone rewrites SNam and keeps the audio", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const s = pickBaseSample(doc);
  const pcm = Uint8Array.from(doc.sampleBin.subarray(s.ptr, s.ptr + s.len));
  const plan = planReplaceSample(doc, s, { pcm, rate: s.rate, nameBytes: enc.encode("renamed") });
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(importBankOp(plan));
  assert.equal(doc.sampleName(s.index), "renamed");
  assert.deepEqual([...doc.sampleBin.subarray(s.ptr, s.ptr + s.len)], [...pcm]);
  undo.undo();
  assert.equal(doc.sampleName(s.index), s.name);
});

test("a length change is refused when another sample shares the bytes", () => {
  const doc = loadWhen();
  const s = pickBaseSample(doc);
  // Point a spare instrument at the tail half of `s` — an overlapping census
  // entry, which a move or a shrink would corrupt.
  const spare = [...Array(256).keys()].find((i) => i > 0 && !doc.usedInstrumentSlots().includes(i));
  const inst = doc.instruments[spare];
  inst.samplePtr = s.ptr + (s.len >> 1);
  inst.sampleLength = s.len >> 2;
  inst.samplingRate = s.rate;
  doc.markInstUsed(spare);

  const overlapping = doc.sampleList().find((e) => e.ptr === s.ptr && e.len === s.len);
  assert.match(
    planReplaceSample(doc, overlapping, { pcm: ramp(s.len - 10), rate: s.rate }).error ?? "",
    /shares these pool bytes/);
  // …but an equal-length edit is still fine — it is a plain byte overwrite.
  assert.equal(
    planReplaceSample(doc, overlapping, { pcm: ramp(s.len), rate: s.rate }).error, undefined);
});

test("input validation", () => {
  const doc = loadWhen();
  const s = pickBaseSample(doc);
  assert.match(planReplaceSample(doc, s, { pcm: new Uint8Array(0), rate: 8000 }).error, /empty/);
  assert.match(planReplaceSample(doc, s, { pcm: ramp(70000), rate: 8000 }).error, /too long/);
  assert.match(
    planReplaceSample(doc, s, { pcm: ramp(100), pcmR: ramp(90), rate: 8000 }).error,
    /same length/);
});
