// Item 28: editable Metainstrument mix + detune. The layer table parses a raw
// byte offset per layer (rawOffset), and setMetaBytesOp writes metaRaw + re-
// derives metaLayers (setByte can't — a meta ignores the decoded fields).

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TaudInst, META_MAX_LAYERS, META_TYPE_FM, buildMetaRecord, makeMetaLayer,
} from "../../core/engine/inst.js";
import { setMetaBytesOp, setMetaRecordOp, importBankOp } from "../../src/doc/ops.js";
import {
  metaLayers, metaRecordOf, metaFlags, metaRecordWithFlags, defaultLayer, linkCount,
  duplicateLayer, removeLayer, moveLayer, patchLayer, appendLayers, repointLayer,
  stackLayer,
} from "../../src/doc/metaedit.js";
import {
  planCreateMeta, planAddMetaLayers, planUnlinkMetaLayer,
} from "../../src/doc/bankmerge.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

/** Two ordinary (non-meta) instruments to layer. */
const twoPicks = (doc) =>
  doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);

const metaOf = (doc) => doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);

/** Build a 256-byte Metainstrument record with `layers` = [{inst, mix, detune}]. */
function metaRecord(layers) {
  const b = new Uint8Array(256);
  b[0] = 0x00;            // flags (strict bit clear)
  b[1] = layers.length;   // layer count (byte 1 of the 0xFFFF sentinel word)
  b[2] = 0xff; b[3] = 0xff; // samplePtr high 16 bits = 0xFFFF → Metainstrument
  let o = 4;
  for (const l of layers) {
    b[o] = l.inst & 0xff;
    b[o + 1] = l.mix & 0xff;
    const d = l.detune & 0xffff;
    b[o + 2] = d & 0xff; b[o + 3] = (d >>> 8) & 0xff;
    b[o + 8] = ((l.inst >>> 8) & 3) << 6; // inst high bits, vStart 0
    o += 10;
  }
  return b;
}

test("meta parse: rawOffset + signed detune, layers in order", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x10, mix: 159, detune: 0 },
    { inst: 0x20, mix: 100, detune: -341 },
  ]));
  assert.ok(inst.isMeta);
  assert.equal(inst.metaLayers.length, 2);
  assert.equal(inst.metaLayers[0].rawOffset, 4);
  assert.equal(inst.metaLayers[1].rawOffset, 14);
  assert.equal(inst.metaLayers[0].mixOctet, 159);
  assert.equal(inst.metaLayers[1].detune, -341, "signed detune decoded");
});

test("meta parse: skipped invalid layer keeps rawOffset aligned to the real slot", () => {
  const inst = new TaudInst(0);
  // middle layer has inst 0 (invalid) → dropped from metaLayers but still
  // occupies its 10 raw bytes, so the third layer's rawOffset must be 24.
  inst.loadRecord(metaRecord([
    { inst: 0x10, mix: 159, detune: 0 },
    { inst: 0x00, mix: 0, detune: 0 },   // invalid → skipped
    { inst: 0x30, mix: 120, detune: 5 },
  ]));
  assert.equal(inst.metaLayers.length, 2);
  assert.equal(inst.metaLayers[0].rawOffset, 4);
  assert.equal(inst.metaLayers[1].rawOffset, 24, "third raw slot, not the second");
});

test("setMetaBytesOp: edit mix + detune, invertible, targets metaRaw", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x10, mix: 159, detune: 0 },
    { inst: 0x20, mix: 100, detune: 0 },
  ]));
  const doc = { instruments: [inst], markInstUsed() {}, dirty: false };
  const l1 = inst.metaLayers[1];

  // mix: byte rawOffset+1
  const invMix = setMetaBytesOp(0, [[l1.rawOffset + 1, 200]]).apply(doc);
  assert.equal(doc.instruments[0].metaLayers[1].mixOctet, 200);
  assert.equal(doc.instruments[0].metaRaw[l1.rawOffset + 1], 200, "written to metaRaw");
  assert.ok(doc.dirty);

  // detune: bytes rawOffset+2/+3 (signed −341 → 0xFEAB)
  const v = -341 & 0xffff;
  setMetaBytesOp(0, [[l1.rawOffset + 2, v & 0xff], [l1.rawOffset + 3, (v >>> 8) & 0xff]]).apply(doc);
  assert.equal(doc.instruments[0].metaLayers[1].detune, -341);

  // the first mix op's inverse restores 100 (and the mixLayer stays layer 1)
  invMix.apply(doc);
  assert.equal(doc.instruments[0].metaLayers[1].mixOctet, 100, "inverse restores mix");
  // (detune stayed at −341: the inverse only touched the mix byte)
  assert.equal(doc.instruments[0].metaLayers[1].detune, -341);
});

// ── item 113: layer-table structure editing ──

test("metaedit: duplicate is LINKED and lands next to its source", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x100, mix: 159, detune: 0 },
    { inst: 0x101, mix: 120, detune: 7 },
  ]));
  const layers = metaLayers(inst);
  assert.ok(layers.every((l) => l.rawOffset === undefined), "rawOffset is dropped");

  const dup = duplicateLayer(layers, 0, 1365);
  assert.equal(dup.length, 3);
  assert.equal(dup[1].instIdx, 0x100, "the copy shares the source's sub-instrument");
  assert.equal(dup[1].detune, 1365, "…at the requested offset");
  assert.equal(dup[1].mixOctet, 159, "…and inherits everything else");
  assert.equal(dup[2].instIdx, 0x101, "the rest shifts down");
  assert.equal(linkCount(dup, 0), 2);
  assert.equal(linkCount(dup, 2), 1);
});

test("metaedit: the last layer can't be removed; reorder + patch behave", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x100, mix: 159, detune: 0 },
    { inst: 0x101, mix: 120, detune: 0 },
  ]));
  const layers = metaLayers(inst);

  const one = removeLayer(layers, 0);
  assert.equal(one.length, 1);
  assert.equal(removeLayer(one, 0).length, 1, "a 0-layer record is never produced");

  const moved = moveLayer(layers, 1, -1);
  assert.deepEqual(moved.map((l) => l.instIdx), [0x101, 0x100], "record order is priority");
  assert.equal(moveLayer(layers, 0, -1), layers, "out-of-range move is a no-op");

  const tuned = patchLayer(layers, 1, { detune: -341, volStart: 32 });
  assert.equal(tuned[1].detune, -341);
  assert.equal(tuned[1].volStart, 32);
  assert.equal(tuned[0].detune, 0, "siblings untouched");
});

test("metaedit: a reorder crosses any number of rows in one step", () => {
  // The drag handle commits ONE move for the whole gesture, so the deltas the
  // ▲ ▼ buttons could never produce (a row dropped three places away) are the
  // ordinary case now.
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x100, mix: 159, detune: 0 },
    { inst: 0x101, mix: 159, detune: 0 },
    { inst: 0x102, mix: 159, detune: 0 },
    { inst: 0x103, mix: 159, detune: 0 },
  ]));
  const layers = metaLayers(inst);
  const ids = (ls) => ls.map((l) => l.instIdx);

  assert.deepEqual(ids(moveLayer(layers, 3, -3)), [0x103, 0x100, 0x101, 0x102], "tail to the front");
  assert.deepEqual(ids(moveLayer(layers, 0, +3)), [0x101, 0x102, 0x103, 0x100], "front to the tail");
  assert.deepEqual(ids(moveLayer(layers, 1, +2)), [0x100, 0x102, 0x103, 0x101], "past two rows");
  assert.deepEqual(ids(moveLayer(layers, 2, 0)), ids(layers), "a drop where it started changes nothing");
  assert.equal(moveLayer(layers, 1, +3), layers, "off the end is a no-op");
  assert.deepEqual(ids(layers), [0x100, 0x101, 0x102, 0x103], "the source array is never touched");
});

test("metaedit: the layer table caps at META_MAX_LAYERS", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([{ inst: 0x100, mix: 159, detune: 0 }]));
  let layers = metaLayers(inst);
  for (let i = 0; i < META_MAX_LAYERS + 5; i++) layers = duplicateLayer(layers, 0);
  assert.equal(layers.length, META_MAX_LAYERS, "duplicate stops at the cap");
  assert.equal(appendLayers(layers, [defaultLayer(0x200)]).length, META_MAX_LAYERS);

  // …and the packed record round-trips exactly that many.
  const round = new TaudInst(0);
  round.loadRecord(metaRecordOf(inst, layers));
  assert.equal(round.metaLayers.length, META_MAX_LAYERS);
});

test("planCreateMeta: repeated picks make ONE child copy carrying N layers", () => {
  const doc = loadWhen();
  const [a] = twoPicks(doc);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, [a, a, a], "Chorded")));

  const meta = metaOf(doc);
  const layers = doc.instruments[meta].metaLayers;
  assert.equal(layers.length, 3, "three layers");
  const kids = new Set(layers.map((l) => l.instIdx & 0x3ff));
  assert.equal(kids.size, 1, "…over a single sub-instrument copy");
  assert.ok([...kids].every((k) => k >= 0x100), "the copy lives at $100+");
  assert.ok(doc.usedInstrumentSlots().includes(a), "the original stays selectable");

  // The {slot, count} form is the same thing.
  const doc2 = loadWhen();
  new UndoStack(doc2).apply(importBankOp(planCreateMeta(doc2, [{ slot: a, count: 3 }], "Chorded")));
  assert.equal(doc2.instruments[metaOf(doc2)].metaLayers.length, 3);
});

test("planCreateMeta: the layer cap counts duplicates", () => {
  const doc = loadWhen();
  const [a] = twoPicks(doc);
  const plan = planCreateMeta(doc, [{ slot: a, count: META_MAX_LAYERS + 1 }], "Too big");
  assert.match(plan.error ?? "", /at most/);
});

test("setMetaRecordOp: duplicate a layer, undo byte-exact, survives a save/reload", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, twoPicks(doc), "Stack")));
  const meta = metaOf(doc);
  const baseline = doc.toBytes();

  const inst = doc.instruments[meta];
  const grown = duplicateLayer(metaLayers(inst), 0, 1365);
  undo.apply(setMetaRecordOp(meta, metaRecordOf(inst, grown)));
  assert.equal(doc.instruments[meta].metaLayers.length, 3);
  assert.equal(doc.instruments[meta].metaLayers[1].detune, 1365);

  const reloaded = new Document(parseTaud(doc.toBytes()));
  const rl = reloaded.instruments[meta].metaLayers;
  assert.equal(rl.length, 3, "the third layer survives the round trip");
  assert.equal(rl[1].detune, 1365);
  assert.equal(rl[1].instIdx, rl[0].instIdx, "still linked to the same child");

  undo.undo();
  assert.deepEqual(doc.toBytes(), baseline, "undo is byte-exact");
});

test("setMetaRecordOp: flags (strict / percussion) survive a rebuild", () => {
  const inst = new TaudInst(0);
  const rec = metaRecord([{ inst: 0x100, mix: 159, detune: 0 }]);
  rec[0] = 0x03; // strict + percussion
  inst.loadRecord(rec);
  assert.equal(inst.metaStrict, true);

  const rebuilt = new TaudInst(0);
  rebuilt.loadRecord(metaRecordOf(inst, duplicateLayer(metaLayers(inst), 0)));
  assert.equal(rebuilt.metaStrict, true, "strict bit kept");
  assert.equal(rebuilt.metaRaw[0] & 0x02, 0x02, "percussion bit kept");
});

test("planAddMetaLayers: appends after the existing table, foreground unchanged", () => {
  const doc = loadWhen();
  const [a, b] = twoPicks(doc);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, [a], "Stack")));
  const meta = metaOf(doc);
  const before = doc.instruments[meta].metaLayers[0].instIdx;

  undo.apply(importBankOp(planAddMetaLayers(doc, meta, [{ slot: b, count: 2 }])));
  const layers = doc.instruments[meta].metaLayers;
  assert.equal(layers.length, 3);
  assert.equal(layers[0].instIdx, before, "layer 0 (the foreground) is untouched");
  assert.equal(layers[1].instIdx, layers[2].instIdx, "the two new layers are linked");
  assert.notEqual(layers[1].instIdx, before);
  assert.equal(doc.instrumentName(layers[1].instIdx & 0x3ff), doc.instrumentName(b),
    "the copy inherits its source's name");

  const plan = planAddMetaLayers(doc, meta, [{ slot: a, count: META_MAX_LAYERS }]);
  assert.match(plan.error ?? "", /at most/, "the cap counts what is already there");
});

test("planUnlinkMetaLayer: one layer gets its own copy, its siblings keep theirs", () => {
  const doc = loadWhen();
  const [a] = twoPicks(doc);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, [{ slot: a, count: 3 }], "Chorded")));
  const meta = metaOf(doc);
  const shared = doc.instruments[meta].metaLayers[0].instIdx;
  const baseline = doc.toBytes();

  undo.apply(importBankOp(planUnlinkMetaLayer(doc, meta, 1)));
  const layers = doc.instruments[meta].metaLayers;
  assert.equal(layers.length, 3, "the table keeps its shape");
  assert.equal(layers[0].instIdx, shared);
  assert.equal(layers[2].instIdx, shared, "the other two stay linked");
  assert.notEqual(layers[1].instIdx, shared, "layer 1 moved to its own slot");
  assert.ok((layers[1].instIdx & 0x3ff) >= 0x100, "…at $100+");
  assert.deepEqual(doc.instRecordBytes(layers[1].instIdx & 0x3ff), doc.instRecordBytes(shared),
    "the clone starts out identical");
  assert.match(planUnlinkMetaLayer(doc, meta, 1).error ?? "", /already/,
    "a layer that owns its child outright has nothing to unlink");

  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.instruments[meta].metaLayers[1].instIdx, layers[1].instIdx);

  undo.undo();
  assert.deepEqual(doc.toBytes(), baseline, "undo is byte-exact");
});

test("repointLayer: onlyThis vs every layer on the same child", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x100, mix: 159, detune: 0 },
    { inst: 0x100, mix: 159, detune: 5 },
    { inst: 0x101, mix: 159, detune: 0 },
  ]));
  const layers = metaLayers(inst);
  assert.deepEqual(repointLayer(layers, 0, 0x200).map((l) => l.instIdx), [0x200, 0x100, 0x101]);
  assert.deepEqual(repointLayer(layers, 0, 0x200, false).map((l) => l.instIdx),
    [0x200, 0x200, 0x101]);
});

// ── item 113: the chord stack's pure half (popups/metachord.js) ──

test("chordOffsets: normalises around the voice nearest unison", async () => {
  const { chordOffsets } = await import("../../src/ui/popups/metachord.js");
  const { presetForNotation } = await import("../../core/tuning/pitchtables.js");
  const p12 = presetForNotation(120); // 12-TET

  // Just intonation, like the chord maker: 5/4 and 3/2 off the root, which is
  // the layer you already have and so is NOT in the list.
  const major = chordOffsets("major", p12);
  assert.equal(major.length, 2, "a triad adds two voices to the existing layer");
  assert.ok(Math.abs(major[0] - Math.round(4096 * Math.log2(5 / 4))) <= 1);
  assert.ok(Math.abs(major[1] - Math.round(4096 * Math.log2(3 / 2))) <= 1);

  // "Octaves" is the case that proves the rule: its first voice is an octave
  // DOWN, so a naive "first voice is the root" would transpose the whole stack.
  const oct = chordOffsets("octaves", p12);
  assert.deepEqual(oct.sort((a, b) => a - b), [-4096, 4096],
    "one octave either side of the layer, which stays put");

  // The chorus preset is a pair of a few cents either way.
  const det = chordOffsets("detune", p12).sort((a, b) => a - b);
  assert.equal(det.length, 2);
  assert.ok(det[0] < 0 && det[1] > 0 && Math.abs(det[1]) < 60, "a few cents, not an interval");
});

test("chordOffsets: an inversion moves which voice the layer plays", async () => {
  const { chordOffsets } = await import("../../src/ui/popups/metachord.js");
  const { presetForNotation } = await import("../../core/tuning/pitchtables.js");
  const p12 = presetForNotation(120);
  const third = Math.round(4096 * Math.log2(5 / 4));   // 386¢
  const fifth = Math.round(4096 * Math.log2(3 / 2));   // 702¢

  // 1st inversion: the reference (nearest unison) is the THIRD, so the layer
  // you have becomes the third and the stack sits above it — a minor third to
  // the fifth, a major sixth to the root an octave up.
  const inv1 = chordOffsets("major", p12, 1).sort((a, b) => a - b);
  assert.equal(inv1.length, 2);
  assert.ok(Math.abs(inv1[0] - (fifth - third)) <= 1, `${inv1[0]} = 5th over the 3rd`);
  assert.ok(Math.abs(inv1[1] - (4096 - third)) <= 1, `${inv1[1]} = the root above`);

  // 2nd inversion is built on the fifth, and every voice is still above it
  const inv2 = chordOffsets("major", p12, 2).sort((a, b) => a - b);
  assert.ok(inv2.every((o) => o > 0), "the layer is the bass of a 2nd inversion");
  assert.ok(Math.abs(inv2[0] - (4096 - fifth)) <= 1);
  assert.ok(Math.abs(inv2[1] - (4096 + third - fifth)) <= 1);

  // out of range is the same as the last real inversion, never a throw
  assert.deepEqual(chordOffsets("major", p12, 9), chordOffsets("major", p12, 2));
  assert.deepEqual(chordOffsets("major", p12), chordOffsets("major", p12, 0));
});

test("stackLayer: linked copies at the given detunes, capped", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x100, mix: 140, detune: 20 },
    { inst: 0x101, mix: 159, detune: 0 },
  ]));
  const layers = metaLayers(inst);
  const out = stackLayer(layers, 0, [1319, 2396]);
  assert.deepEqual(out.map((l) => l.instIdx), [0x100, 0x100, 0x100, 0x101], "inserted after the source");
  assert.deepEqual(out.map((l) => l.detune), [20, 1319, 2396, 0]);
  assert.ok(out.slice(0, 3).every((l) => l.mixOctet === 140), "copies inherit the source's mix");

  const flood = stackLayer(layers, 0, new Array(50).fill(100));
  assert.equal(flood.length, META_MAX_LAYERS, "the cap still holds");
});

// ── the record's own flags (strict layering, percussion) ───────────────────
// A full-range operator at unity, for the rack case.
const op = (slot) => makeMetaLayer(slot, 159, 0, 0x0000, 0xffff, 0, 63);

// Byte 0 is `0b tttt_00Ps`. Both bits are edited on their own, without the
// layer table or a rack's algorithm being able to notice.

test("metaRecordWithFlags sets and clears each bit, keeping the other", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 100, -341, 0x1000, 0x8000, 3, 60),
  ]));
  assert.deepEqual(metaFlags(inst), { strict: false, percussion: false, type: 0 });

  const perc = new TaudInst(0);
  perc.loadRecord(metaRecordWithFlags(inst, { percussion: true }));
  assert.deepEqual(metaFlags(perc), { strict: false, percussion: true, type: 0 });
  assert.equal(perc.isPercussion, true, "the getter every retuner asks reads it");

  const both = new TaudInst(0);
  both.loadRecord(metaRecordWithFlags(perc, { strict: true }));
  assert.deepEqual(metaFlags(both), { strict: true, percussion: true, type: 0 });
  assert.equal(both.metaStrict, true);

  const off = new TaudInst(0);
  off.loadRecord(metaRecordWithFlags(both, { percussion: false }));
  assert.deepEqual(metaFlags(off), { strict: true, percussion: false, type: 0 });
  assert.equal(off.isPercussion, false);
});

test("…and the layer table is byte-identical across a flag edit", () => {
  const layers = [
    makeMetaLayer(0x101, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(0x3ff, 0, -12345, 0x1234, 0x5678, 3, 60),
  ];
  const inst = new TaudInst(0);
  inst.loadRecord(buildMetaRecord(layers));
  const before = buildMetaRecord(layers);
  const after = metaRecordWithFlags(inst, { percussion: true, strict: true });
  assert.equal(after[0], 0x03, "only byte 0 carries the flags");
  assert.deepEqual(Array.from(after.slice(1)), Array.from(before.slice(1)),
    "every other byte of the record is the one it was");
});

test("a rack keeps its type and its algorithm when a flag is flipped", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(buildMetaRecord(
    [op(1), op(2)], { type: META_TYPE_FM, program: [0x0001, 0x0400] })); // op1 modulates op0
  assert.equal(inst.isFm, true);
  const program = inst.fmProgram.slice();

  const next = new TaudInst(0);
  next.loadRecord(metaRecordWithFlags(inst, { percussion: true }));
  assert.equal(next.isFm, true, "still a rack — the type nibble is not a flag");
  assert.equal(metaFlags(next).percussion, true);
  assert.deepEqual(next.fmProgram, program, "the algorithm rides along untouched");
  assert.equal(next.metaLayers.length, 2);
});
