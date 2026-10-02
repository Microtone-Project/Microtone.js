// Pool defragmentation (item 178) — planPoolDefrag through importBankOp.
//
// The whole feature is one promise: the pool is packed and NOTHING ELSE
// changes. So most of what is pinned here is what must NOT move — the audio a
// song renders, the census's order and therefore its names, the bytes behind
// every claim, an untouched instrument's record — with the compaction
// arithmetic itself checked on the extents where sharing and stereo make it
// interesting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  planPoolDefrag, compactExtents, pointerMapper, retargetPatchBlob, POOL_SIZE,
} from "../../src/doc/pooldefrag.js";
import { planDeleteSample } from "../../src/doc/cleanup.js";
import { planImportRegion } from "../../src/doc/bankmerge.js";
import { importBankOp, cleanupBankOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document, sampleSpans } from "../../src/doc/document.js";
import { parsePatchesBlob } from "../../core/engine/inst.js";
import { UndoStack } from "../../src/doc/undo.js";
import { poolMap } from "../../src/doc/poolmap.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { setSamplingRate } from "../../core/engine/constants.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";

setSamplingRate(32000);

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (f) => new Document(parseTaud(readFileSync(corpusDir + f)));
const enc = (s) => new TextEncoder().encode(s);
const bytesOf = (doc, ptr, len) => Uint8Array.from(doc.sampleBin.subarray(ptr, ptr + len));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A corpus project with holes in it: delete two samples out of the MIDDLE of
 * the pool, which is exactly how a real project gets fragmented (the corpus is
 * packed end to end — every one of them comes straight out of a converter).
 */
function fragmented(file = "flourish.taud", cuts = [0.35, 0.6]) {
  const doc = load(file);
  const undo = new UndoStack(doc);
  for (const at of cuts) {
    const list = doc.sampleList();
    const victim = list[Math.floor(list.length * at)];
    const plan = planDeleteSample(doc, victim);
    assert.equal(plan.error, undefined, plan.error);
    undo.apply(cleanupBankOp(plan));
  }
  const map = poolMap(doc, { scanBytes: false });
  assert.ok(map.stats.holeCount >= 1, "premise: the project is now fragmented");
  return { doc, undo };
}

const render = (doc, seconds = 3) => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc.toRenderable(0), 0);
  return renderSong(eng, seconds).u8;
};

// ── the arithmetic ─────────────────────────────────────────────────────────

test("compactExtents merges what overlaps and packs the rest from 0", () => {
  const ext = compactExtents([
    { ptr: 100, len: 50 },   // ↓ these two share bytes: one extent
    { ptr: 120, len: 60 },
    { ptr: 400, len: 10 },
    { ptr: 1000, len: 5 },
  ]);
  assert.deepEqual(ext, [
    { ptr: 100, len: 80, to: 0 },
    { ptr: 400, len: 10, to: 80 },
    { ptr: 1000, len: 5, to: 90 },
  ]);
});

test("pointerMapper translates INSIDE an extent and leaves strangers alone", () => {
  const map = pointerMapper(compactExtents([{ ptr: 100, len: 80 }, { ptr: 400, len: 10 }]));
  assert.equal(map(100), 0, "the extent's own start");
  assert.equal(map(120), 20, "a claim that starts mid-extent keeps its offset");
  assert.equal(map(400), 80);
  assert.equal(map(300), 300, "a pointer in a hole is not ours to move");
  assert.equal(map(0x7f0000), 0x7f0000, "…nor is a junk record's");
});

test("an already-packed pool is a no-op", () => {
  const plan = planPoolDefrag(load("WHEN.taud"));
  assert.equal(plan.noop, true);
  assert.equal(plan.report.movedBytes, 0);
});

// ── the edit ───────────────────────────────────────────────────────────────

test("defrag packs the pool and frees the holes into the tail run", () => {
  const { doc, undo } = fragmented();
  const before = poolMap(doc, { scanBytes: false });
  const plan = planPoolDefrag(doc);
  assert.equal(plan.error, undefined, plan.error);
  assert.ok(plan.report.movedBytes > 0);
  undo.apply(importBankOp(plan));

  const after = poolMap(doc, { scanBytes: true });
  assert.equal(after.stats.holeCount, 0, "no gaps below the high-water mark");
  assert.equal(after.stats.usedBytes, before.stats.usedBytes, "the same bytes are still claimed");
  assert.equal(after.highWater, before.stats.usedBytes, "…and they start at 0");
  assert.equal(after.stats.tailStale, 0, "what the compaction vacated is wiped");
  assert.equal(after.stats.freeBytes, POOL_SIZE - before.stats.usedBytes);
});

test("the song renders bit-identically after a defrag", () => {
  const { doc, undo } = fragmented();
  const beforeAudio = render(doc);
  undo.apply(importBankOp(planPoolDefrag(doc)));
  const afterAudio = render(doc);
  assert.equal(afterAudio.length, beforeAudio.length);
  assert.ok(same(afterAudio, beforeAudio), "a defrag is inaudible, or it is a bug");
});

test("every claim keeps its bytes, its length and its place in the census", () => {
  const { doc, undo } = fragmented();
  const before = doc.sampleList().map((e) => ({
    name: e.name, len: e.len, rate: e.rate, loopStart: e.loopStart, loopEnd: e.loopEnd,
    users: [...e.users], pcm: bytesOf(doc, e.ptr, e.len),
    chans: sampleSpans(e).map((sp) => bytesOf(doc, sp.ptr, sp.len)),
  }));
  undo.apply(importBankOp(planPoolDefrag(doc)));

  const after = doc.sampleList();
  assert.equal(after.length, before.length, "no sample gained or lost");
  after.forEach((e, i) => {
    const was = before[i];
    assert.equal(e.name, was.name, `row ${i} keeps its name (SNam is positional)`);
    assert.equal(e.len, was.len);
    assert.equal(e.rate, was.rate);
    assert.equal(e.loopStart, was.loopStart);
    assert.equal(e.loopEnd, was.loopEnd);
    assert.deepEqual([...e.users], was.users, `row ${i} keeps its instruments`);
    assert.ok(same(bytesOf(doc, e.ptr, e.len), was.pcm), `row ${i} keeps its audio`);
    sampleSpans(e).forEach((sp, c) => {
      assert.ok(same(bytesOf(doc, sp.ptr, sp.len), was.chans[c]),
        `row ${i} channel ${c} keeps its audio`);
    });
  });
});

test("only the records that had to move are rewritten", () => {
  const { doc, undo } = fragmented();
  const recordsBefore = new Map(
    doc.usedInstrumentSlots().map((s) => [s, doc.instRecordBytes(s)]));
  const plan = planPoolDefrag(doc);
  const touched = new Set(plan.insts.map((it) => it.destSlot));
  undo.apply(importBankOp(plan));
  for (const [slot, was] of recordsBefore) {
    if (touched.has(slot)) continue;
    assert.ok(same(doc.instRecordBytes(slot), was),
      `slot $${slot.toString(16)} was left alone`);
  }
  assert.ok(touched.size > 0, "premise: something did move");
});

test("a metainstrument's record is never read as a pointer", () => {
  const { doc, undo } = fragmented("Insaniq2.taud", [0.4]);
  const metas = doc.usedInstrumentSlots().filter((s) => doc.instruments[s].isMeta);
  const before = metas.map((s) => doc.instRecordBytes(s));
  undo.apply(importBankOp(planPoolDefrag(doc)));
  metas.forEach((s, i) => {
    assert.ok(doc.instruments[s].isMeta, `slot $${s.toString(16)} is still a meta`);
    assert.ok(same(doc.instRecordBytes(s), before[i]), "…and its record is untouched");
  });
});

test("Ixmp survives a save/reload: the SECTION is rebuilt, not just doc.ixmp", () => {
  const { doc, undo } = fragmented();
  assert.ok(doc.ixmp.length > 0, "premise: this project has patches");
  undo.apply(importBankOp(planPoolDefrag(doc)));
  const zones = doc.usedInstrumentSlots().map(
    (s) => (doc.instruments[s].extraPatches ?? []).map((p) => `${p.samplePtr}:${p.sampleLength}`));

  const reloaded = new Document(parseTaud(doc.toBytes()));
  const zonesBack = reloaded.usedInstrumentSlots().map(
    (s) => (reloaded.instruments[s].extraPatches ?? []).map((p) => `${p.samplePtr}:${p.sampleLength}`));
  assert.deepEqual(zonesBack, zones);
  assert.equal(poolMap(reloaded, { scanBytes: false }).stats.holeCount, 0);
});

test("undo puts every byte, pointer and section back", () => {
  const { doc, undo } = fragmented();
  const pool = Uint8Array.from(doc.sampleBin);
  const records = doc.usedInstrumentSlots().map((s) => doc.instRecordBytes(s));
  const ixmp = doc.ixmp.map((e) => `${e.instId}:${e.count}:${e.blob.length}`);
  const file = doc.toBytes();

  undo.apply(importBankOp(planPoolDefrag(doc)));
  undo.undo();

  assert.ok(same(doc.sampleBin, pool), "the pool is back byte for byte");
  doc.usedInstrumentSlots().forEach((s, i) => {
    assert.ok(same(doc.instRecordBytes(s), records[i]), `slot $${s.toString(16)} is back`);
  });
  assert.deepEqual(doc.ixmp.map((e) => `${e.instId}:${e.count}:${e.blob.length}`), ixmp);
  assert.ok(same(doc.toBytes(), file), "and the file it writes is the file it wrote");
});

// ── regions ────────────────────────────────────────────────────────────────

test("a pool region moves with everything else, and its SRgn follows", () => {
  const { doc, undo } = fragmented();
  const pcm = new Uint8Array(120000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 7) & 0xff;
  const loadPlan = planImportRegion(doc, { channels: [pcm], rate: 22050, nameBytes: enc("take 1") });
  assert.equal(loadPlan.error, undefined, loadPlan.error);
  undo.apply(importBankOp(loadPlan));
  const was = doc.sampleRegions()[0];

  const plan = planPoolDefrag(doc);
  assert.equal(plan.report.regions, 1, "the region is one of the things that moved");
  undo.apply(importBankOp(plan));

  const now = doc.sampleRegions()[0];
  assert.equal(now.len, was.len);
  assert.equal(now.rate, was.rate);
  assert.equal(now.name, was.name);
  assert.ok(now.ptr < was.ptr, "it moved down with the rest");
  assert.ok(same(bytesOf(doc, now.ptr, now.len), pcm), "…carrying its recording");
  assert.equal(poolMap(doc, { scanBytes: false }).stats.holeCount, 0);
});

test("a defrag with a region in it is still inaudible", () => {
  const { doc, undo } = fragmented();
  const pcm = new Uint8Array(90000).fill(200);
  undo.apply(importBankOp(planImportRegion(doc, {
    channels: [pcm, pcm], rate: 32000, nameBytes: enc("stereo take"),
  })));
  const before = render(doc);
  undo.apply(importBankOp(planPoolDefrag(doc)));
  assert.ok(same(render(doc), before));
  const r = doc.sampleRegions()[0];
  assert.equal(r.chan, 2);
  assert.ok(same(bytesOf(doc, r.ptr + r.len, r.len), pcm),
    "the second channel is still where regionSpans says it is");
});

// ── the blob rewriter, on its own ──────────────────────────────────────────

test("retargetPatchBlob walks a real bank and moves only the pointers", () => {
  const doc = load("flourish.taud");
  const entry = doc.ixmp.find((e) => e.count > 1);
  assert.ok(entry, "premise: a multi-patch instrument");
  const before = doc.instruments[entry.instId & 0x3ff].extraPatches;
  const { blob, moved } = retargetPatchBlob(entry.blob, (p) => p + 0x1000);
  assert.equal(blob.length, entry.blob.length, "the record layout is untouched");
  assert.equal(moved, before.filter((p) => p.sampleLength > 0).length);

  // Re-parse: every field but the pointer is the one it was.
  const reparsed = parsePatchesBlob(blob);
  reparsed.forEach((p, i) => {
    const was = before[i];
    assert.equal(p.samplePtr, was.sampleLength > 0 ? was.samplePtr + 0x1000 : was.samplePtr);
    assert.equal(p.sampleLength, was.sampleLength);
    assert.equal(p.loopStart, was.loopStart);
    assert.equal(p.loopEnd, was.loopEnd);
    assert.equal(p.samplingRate, was.samplingRate);
    assert.equal(p.pitchStart, was.pitchStart);
    assert.equal(p.volumeEnd, was.volumeEnd);
  });
});
