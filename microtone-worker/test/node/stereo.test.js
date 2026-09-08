// Stereo samples (item 90) — the Ixmp 's' block codec and the engine's
// two-channel playback path.
//
// The load-bearing claim is the FIRST test: a stereo patch whose two channels
// hold identical data must mix bit-for-bit like the mono sample it came from,
// because each channel goes through the same equal-energy pan law that a mono
// voice already does (mono is L == R). Everything else in the stereo path is
// judged against that baseline.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK } from "../../src/engine/constants.js";
import { Voice } from "../../src/engine/voice.js";
import { ghostVoice } from "../../src/engine/trigger.js";
import {
  makeInstPatch, writePatchesBlob, parsePatchesBlob, envPoint,
  patchIsStereo, patchChannelPtrs, CHAN_MODE_DISCRETE, CHAN_MODE_MATRIX,
} from "../../src/engine/inst.js";
import { ixmpPatchLen, ixmpChanCount, SAMPLEBIN_SIZE } from "../../src/format/taud-const.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document, sampleSpans, isStereoSample } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import {
  importBankOp, multiSampleBytesOp, compositeOp, setInstFieldOp,
  syncBaseStereoPatchOp, rebindBaseStereoPatchOp,
} from "../../src/doc/ops.js";
import { baseStereoPatchIndex } from "../../src/engine/inst.js";
import { planMultiSampleImport, planImport } from "../../src/doc/bankmerge.js";
import { planBankCleanup } from "../../src/doc/cleanup.js";
import { applyChannels, normalise, reverse } from "../../src/doc/sampledsp.js";
import { normaliseRangeLinked, normaliseRange, downmixChannels } from "../../src/doc/wavelab.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

const LEN = 800;
const PTR_L = 0x1000;
const PTR_R = 0x1000 + LEN;

/** Deterministic pseudo-wave in u8 sample space (centre 0x80). */
function wave(i, gain) {
  const v = Math.sin(i * 0.11) * 0.6 + Math.sin(i * 0.037) * 0.3;
  return Math.max(0, Math.min(255, Math.round(128 + v * 110 * gain)));
}

/**
 * Engine with instrument 1 playing a looping sample. `right` (null = mono)
 * gives the second channel's gain; `mode` is the 's' block channel mode.
 */
function makeEngine({ right = null, mode = CHAN_MODE_DISCRETE, pan = 0x80 } = {}) {
  const eng = new TaudEngine();
  for (let i = 0; i < LEN; i++) {
    eng.sampleBin[PTR_L + i] = wave(i, 1);
    eng.sampleBin[PTR_R + i] = wave(i, right ?? 1);
  }
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  const w32 = (o, v) => { w16(o, v & 0xffff); w16(o + 2, (v >>> 16) & 0xffff); };
  w32(0, PTR_L);
  w16(4, LEN);
  w16(6, 32000);      // samplingRate @C4
  w16(12, LEN);       // loopEnd
  rec[14] = 1;        // forward loop
  rec[21] = 0x3f;     // vol env node 0 = full (a zeroed env cuts the voice)
  rec[171] = 255;     // instGlobalVolume
  rec[177] = pan;     // default pan
  rec[196] = 255;     // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  if (right !== null) {
    eng.uploadInstrumentPatches(1, writePatchesBlob([makeInstPatch({
      pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      samplePtr: PTR_L, sampleLength: LEN, playStart: 0,
      loopStart: 0, loopEnd: LEN, samplingRate: 32000, loopMode: 1,
      hasChanBlock: true, chanCount: 2, chanMode: mode, chanPtrs: [PTR_R],
    })]));
  }
  eng.setMasterVolume(0, 255);
  return eng;
}

/** Jam C4 on voice 0 and render one chunk; returns the float mix bus. */
function renderJam(eng, { pan = null } = {}) {
  eng.jamNote(0, 0, 0x5000, 1);
  if (pan !== null) eng.playheads[0].trackerState.voices[0].channelPan = pan;
  eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
  const ts = eng.playheads[0].trackerState;
  return { L: Float32Array.from(ts.mixLeft), R: Float32Array.from(ts.mixRight) };
}

function peak(a) {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

// ── codec ──────────────────────────────────────────────────────────────────

test("'s' block round-trips through writePatchesBlob/parsePatchesBlob", () => {
  const patches = [
    makeInstPatch({
      pitchStart: 0x1000, pitchEnd: 0x9000, volumeStart: 0, volumeEnd: 63,
      samplePtr: 0x123456, sampleLength: 1234, samplingRate: 22050, loopMode: 3,
      hasChanBlock: true, chanCount: 2, chanMode: CHAN_MODE_MATRIX,
      chanFlags: 0xabcdef, chanPtrs: [0x654321],
    }),
    // 's' alongside every other optional block — proves the on-wire order.
    makeInstPatch({
      pitchStart: 0, pitchEnd: 0xffff, samplePtr: 4, sampleLength: 8,
      hasExtra: true, fadeoutStep: 0x123, extraCutoff: 0x1234, extraResonance: 0x99,
      extraInitialAttenOctet: 159, filterSfMode: true,
      volEnv: Array.from({ length: 25 }, (_, i) => envPoint(i, i * 2)),
      volEnvLoop: 0x0102, volEnvSustain: 0x0304,
      panEnv: Array.from({ length: 25 }, () => envPoint(0x80, 3)),
      filterEnv: Array.from({ length: 25 }, () => envPoint(0x40, 4)),
      pitchEnv: Array.from({ length: 25 }, () => envPoint(0x20, 5)),
      hasChanBlock: true, chanCount: 4, chanMode: 0,
      chanPtrs: [0x111111, 0x222222, 0x333333],
    }),
    makeInstPatch({ pitchStart: 1, pitchEnd: 2, samplePtr: 9, sampleLength: 9 }), // legacy
  ];
  const blob = writePatchesBlob(patches);
  const back = parsePatchesBlob(blob);
  assert.equal(back.length, 3);
  assert.deepEqual(writePatchesBlob(back), blob, "second round trip must be byte-exact");

  assert.equal(back[0].hasChanBlock, true);
  assert.equal(back[0].chanCount, 2);
  assert.equal(back[0].chanMode, CHAN_MODE_MATRIX);
  assert.equal(back[0].chanFlags, 0xabcdef);
  assert.deepEqual(back[0].chanPtrs, [0x654321]);
  assert.equal(back[1].chanCount, 4);
  assert.deepEqual(back[1].chanPtrs, [0x111111, 0x222222, 0x333333]);
  assert.equal(back[1].fadeoutStep, 0x123, "'s' must not disturb the earlier blocks");
  assert.equal(back[2].hasChanBlock, false);
  assert.deepEqual(back[2].chanPtrs, []);

  // Only the stereo one is playable today; a quad patch is TODO #998.
  assert.equal(patchIsStereo(back[0]), true);
  assert.equal(patchIsStereo(back[1]), false);
  assert.equal(patchIsStereo(back[2]), false);
  assert.deepEqual(patchChannelPtrs(back[0]), [0x123456, 0x654321]);
  assert.deepEqual(patchChannelPtrs(back[2]), [9]);
});

test("ixmpPatchLen walks a blob whose records carry 's' blocks", () => {
  const patches = [
    makeInstPatch({ samplePtr: 1, sampleLength: 1, hasChanBlock: true, chanCount: 2, chanPtrs: [2] }),
    makeInstPatch({ samplePtr: 3, sampleLength: 1 }),
    makeInstPatch({ samplePtr: 4, sampleLength: 1, hasChanBlock: true, chanCount: 3, chanPtrs: [5, 6] }),
  ];
  const blob = writePatchesBlob(patches);
  let o = 0;
  const lens = [];
  const counts = [];
  for (let i = 0; i < 3; i++) {
    counts.push(ixmpChanCount(blob, o));
    lens.push(ixmpPatchLen(blob, o));
    o += lens[i];
  }
  assert.deepEqual(lens, [31 + 4 + 4, 31, 31 + 4 + 8]);
  assert.deepEqual(counts, [2, 1, 3]);
  assert.equal(o, blob.length, "the walk must consume the blob exactly");
});

// ── engine ─────────────────────────────────────────────────────────────────

test("stereo with identical channels is bit-identical to the mono sample", () => {
  const mono = renderJam(makeEngine({ right: null }));
  const stereo = renderJam(makeEngine({ right: 1 }));
  assert.deepEqual(stereo.L, mono.L);
  assert.deepEqual(stereo.R, mono.R);
  assert.ok(peak(mono.L) > 0.05, "the baseline must actually be sounding");
});

// NOTE on "silence": u8 sample space has no exact zero — the engine maps a
// byte through (b − 127.5)/127.5, so a flat 0x80 channel is +0.0039 of DC.
// Channel-isolation assertions therefore compare against the sounding side
// rather than against zero.

test("a silent right channel leaves only the left side sounding", () => {
  const { L, R } = renderJam(makeEngine({ right: 0 }));
  assert.ok(peak(L) > 0.05, "left channel must sound");
  assert.ok(peak(R) < peak(L) * 0.02, `right channel should be quiet, peak ${peak(R)}`);
});

test("pan is a balance: hard left keeps L at unity and drops R", () => {
  const centre = renderJam(makeEngine({ right: 0.5 }), { pan: 0x80 });
  const hardL = renderJam(makeEngine({ right: 0.5 }), { pan: 0x00 });
  const hardR = renderJam(makeEngine({ right: 0.5 }), { pan: 0xff });
  // cos(0)=1 vs cos(π/4)=0.707 → hard left is the centre left times √2.
  assert.ok(Math.abs(peak(hardL.L) / peak(centre.L) - Math.SQRT2) < 0.02);
  assert.ok(peak(hardL.R) < peak(centre.R) * 0.02, "hard left must drop the right output");
  assert.ok(peak(hardR.L) < peak(centre.L) * 0.02, "hard right must drop the left output");
  // The right CHANNEL of the sample is half-gain, so it stays quieter.
  assert.ok(peak(centre.R) < peak(centre.L) * 0.75);
});

test("matrix mode decodes M/S: S = −M cancels one side and doubles the other", () => {
  const discrete = renderJam(makeEngine({ right: 1, mode: CHAN_MODE_DISCRETE }));
  const ms = renderJam(makeEngine({ right: -1, mode: CHAN_MODE_MATRIX }));
  // L = M + S = w − w ≈ 0; R = M − S = 2w.
  assert.ok(peak(ms.L) < peak(ms.R) * 0.02, `M+S should cancel, got ${peak(ms.L)}`);
  assert.ok(Math.abs(peak(ms.R) / peak(discrete.R) - 2) < 0.02,
    "M−S should be twice the plain channel");
  // The same bytes read as discrete L,R are just two equal channels.
  assert.ok(Math.abs(peak(discrete.L) - peak(discrete.R)) < 1e-6);
});

test("ghostVoice carries the stereo view and channel-2 DSP state", () => {
  const src = new Voice();
  src.active = true;
  src.activeChanCount = 2;
  src.activeChanMode = CHAN_MODE_MATRIX;
  src.activeChanPtr2 = PTR_R;
  src.right.filterY1 = 0.25;
  src.right.filterX2 = -0.5;
  src.right.bitcrusherHeld = 0.75;
  src.right.bitcrusherCounter = 3;
  src.right.nesDpcmCounter = 71;
  const g = ghostVoice(src, 4);
  assert.equal(g.activeChanCount, 2);
  assert.equal(g.activeChanMode, CHAN_MODE_MATRIX);
  assert.equal(g.activeChanPtr2, PTR_R);
  assert.equal(g.right.filterY1, 0.25);
  assert.equal(g.right.filterX2, -0.5);
  assert.equal(g.right.bitcrusherHeld, 0.75);
  assert.equal(g.right.bitcrusherCounter, 3);
  assert.equal(g.right.nesDpcmCounter, 71);
  assert.notEqual(g.right, src.right, "the ghost must own its channel-2 state");
});

test("a fresh trigger resets channel 2's history with channel 1's", () => {
  const eng = makeEngine({ right: 0.5 });
  eng.jamNote(0, 0, 0x5000, 1);
  eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
  const v = eng.playheads[0].trackerState.voices[0];
  v.right.filterY1 = 0.9;
  v.right.bitcrusherHeld = 0.9;
  eng.jamNote(0, 0, 0x5000, 1);
  assert.equal(v.right.filterY1, 0.0);
  assert.equal(v.right.bitcrusherHeld, 0.0);
  assert.equal(v.right.nesDpcmCounter, 63);
});

test("jamSample auditions a pooled stereo pair", () => {
  const eng = makeEngine({ right: 0 });
  eng.jamSample(0, 0, 0x5000, {
    ptr: PTR_L, len: LEN, rate: 32000, loopStart: 0, loopEnd: LEN, loopMode: 1,
    chanPtr2: PTR_R,
  });
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.activeChanCount, 2);
  assert.equal(v.activeChanPtr2, PTR_R);
  eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
  const ts = eng.playheads[0].trackerState;
  const L = peak(Float32Array.from(ts.mixLeft));
  const R = peak(Float32Array.from(ts.mixRight));
  assert.ok(L > 0.05);
  assert.ok(R < L * 0.02, "the right channel's data is silent");
});

// ── document layer ─────────────────────────────────────────────────────────

test("importing a stereo take: two spans, one census entry, one 's' patch", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const undo = new UndoStack(doc);
  const before = doc.sampleList().length;
  const n = 300;
  const pcm = Uint8Array.from({ length: n }, (_, i) => 128 + Math.round(60 * Math.sin(i / 9)));
  const pcmR = Uint8Array.from({ length: n }, (_, i) => 128 + Math.round(40 * Math.sin(i / 5)));
  const plan = planMultiSampleImport(doc, [{
    nameBytes: new TextEncoder().encode("stereo take"), pcm, pcmR, rate: 32000, loop: true,
  }]);
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.samples.length, 2, "both channels take pool space");
  assert.equal(plan.newSampleBytes, 2 * n);
  undo.apply(importBankOp(plan));

  const slot = plan.insts[0].destSlot;
  const patches = doc.instruments[slot].extraPatches;
  assert.equal(patches.length, 1);
  assert.equal(patchIsStereo(patches[0]), true);
  assert.equal(patches[0].samplePtr, doc.instruments[slot].samplePtr,
    "the base record still points at the left channel");
  const [lPtr, rPtr] = patchChannelPtrs(patches[0]);
  assert.notEqual(lPtr, rPtr);
  assert.deepEqual([...doc.sampleBin.subarray(rPtr, rPtr + n)], [...pcmR]);

  // ONE census entry — a stereo sample is one sample, one name, one row.
  const list = doc.sampleList();
  assert.equal(list.length, before + 1);
  const entry = list.find((e) => e.ptr === lPtr);
  assert.equal(isStereoSample(entry), true);
  assert.deepEqual(entry.chanPtrs, [rPtr]);
  assert.deepEqual(sampleSpans(entry).map((s) => s.ptr), [lPtr, rPtr]);

  // Round-trips through the file and back with both channels intact.
  const reloaded = new Document(parseTaud(doc.toBytes()));
  const rePatch = reloaded.instruments[slot].extraPatches[0];
  assert.equal(patchIsStereo(rePatch), true);
  assert.deepEqual(patchChannelPtrs(rePatch), [lPtr, rPtr]);
  assert.deepEqual([...reloaded.sampleBin.subarray(rPtr, rPtr + n)], [...pcmR]);

  undo.undo();
  assert.equal(doc.sampleList().length, before, "undo removes the whole pair");
});

test("cleanup keeps a used stereo sample's right channel and frees an unused one", () => {
  const mkDoc = () => {
    const d = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
    const n = 256;
    const pcm = Uint8Array.from({ length: n }, (_, i) => 128 + (i % 7) - 3);
    const pcmR = Uint8Array.from({ length: n }, (_, i) => 128 + (i % 11) - 5);
    const plan = planMultiSampleImport(d, [{
      nameBytes: new TextEncoder().encode("st"), pcm, pcmR, rate: 32000, loop: true,
    }]);
    assert.equal(plan.error, undefined, plan.error);
    new UndoStack(d).apply(importBankOp(plan));
    const slot = plan.insts[0].destSlot;
    const [lPtr, rPtr] = patchChannelPtrs(d.instruments[slot].extraPatches[0]);
    return { doc: d, slot, lPtr, rPtr, n };
  };

  // (a) referenced by a pattern cell → both channels survive the pool sweep.
  {
    const { doc, slot, rPtr, n } = mkDoc();
    doc.songs[0].patterns[0][0].instrment = slot;
    const plan = planBankCleanup(doc);
    const pool = plan.image.subarray(0, SAMPLEBIN_SIZE);
    assert.ok([...pool.subarray(rPtr, rPtr + n)].some((b) => b !== 0),
      "the right channel must not be swept away");
  }
  // (b) unreferenced → both channels are freed together.
  {
    const { doc, lPtr, rPtr, n } = mkDoc();
    const plan = planBankCleanup(doc);
    const pool = plan.image.subarray(0, SAMPLEBIN_SIZE);
    assert.ok([...pool.subarray(lPtr, lPtr + n)].every((b) => b === 0));
    assert.ok([...pool.subarray(rPtr, rPtr + n)].every((b) => b === 0));
  }
});

test("bank merge carries a stereo instrument, remapping BOTH channel pointers", () => {
  const src = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const n = 512;
  const pcm = Uint8Array.from({ length: n }, (_, i) => 128 + Math.round(50 * Math.sin(i / 13)));
  const pcmR = Uint8Array.from({ length: n }, (_, i) => 128 + Math.round(50 * Math.cos(i / 17)));
  const srcPlan = planMultiSampleImport(src, [{
    nameBytes: new TextEncoder().encode("pair"), pcm, pcmR, rate: 22050, loop: false,
  }]);
  assert.equal(srcPlan.error, undefined, srcPlan.error);
  new UndoStack(src).apply(importBankOp(srcPlan));
  const srcSlot = srcPlan.insts[0].destSlot;

  const dest = new Document(parseTaud(readFileSync(corpusDir + "slumberjack.taud")));
  const plan = planImport(dest, src, [srcSlot]);
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.newSampleBytes, 2 * n, "both channels are copied");
  new UndoStack(dest).apply(importBankOp(plan));

  const destSlot = plan.slotMap.get(srcSlot);
  const p = dest.instruments[destSlot].extraPatches[0];
  assert.equal(patchIsStereo(p), true);
  const [lPtr, rPtr] = patchChannelPtrs(p);
  assert.equal(lPtr, dest.instruments[destSlot].samplePtr);
  assert.deepEqual([...dest.sampleBin.subarray(lPtr, lPtr + n)], [...pcm]);
  assert.deepEqual([...dest.sampleBin.subarray(rPtr, rPtr + n)], [...pcmR],
    "the right channel points at ITS OWN remapped span");
});

test("linked normalise keeps the stereo balance; other ops are per channel", () => {
  const l = Uint8Array.from([128, 192, 64, 128]);   // peak dev 64
  const r = Uint8Array.from([128, 160, 96, 128]);   // peak dev 32
  const [nl, nr] = applyChannels(normalise, [l, r]);
  assert.equal(Math.max(...nl.map((v) => Math.abs(v - 128))), 127, "loudest channel hits full scale");
  assert.equal(Math.max(...nr.map((v) => Math.abs(v - 128))), 64, "quieter channel keeps its ratio");
  const [rl, rr] = applyChannels(reverse, [l, r]);
  assert.deepEqual([...rl], [...l].reverse());
  assert.deepEqual([...rr], [...r].reverse());
});

test("multiSampleBytesOp writes both spans in one undoable step", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const undo = new UndoStack(doc);
  const a = 0x100, b = 0x200;
  const before = [Uint8Array.from(doc.sampleBin.subarray(a, a + 4)),
                  Uint8Array.from(doc.sampleBin.subarray(b, b + 4))];
  undo.apply(multiSampleBytesOp([
    { ptr: a, bytes: Uint8Array.from([1, 2, 3, 4]) },
    { ptr: b, bytes: Uint8Array.from([5, 6, 7, 8]) },
  ]));
  assert.deepEqual([...doc.sampleBin.subarray(a, a + 4)], [1, 2, 3, 4]);
  assert.deepEqual([...doc.sampleBin.subarray(b, b + 4)], [5, 6, 7, 8]);
  undo.undo();
  assert.deepEqual([...doc.sampleBin.subarray(a, a + 4)], [...before[0]]);
  assert.deepEqual([...doc.sampleBin.subarray(b, b + 4)], [...before[1]]);
});

// ── Sample Lab channel maths ───────────────────────────────────────────────

test("linked normalise over a range shares one factor across channels", () => {
  const l = Float32Array.from([0, 0.5, -0.5, 0.25]);
  const r = Float32Array.from([0, 0.25, -0.25, 0.1]);
  const [nl, nr] = normaliseRangeLinked([l, r], 0, 4);
  assert.ok(Math.abs(Math.max(...nl.map(Math.abs)) - 1) < 1e-6, "loudest channel hits full scale");
  assert.ok(Math.abs(Math.max(...nr.map(Math.abs)) - 0.5) < 1e-6, "the other keeps its ratio");
  // A single channel behaves exactly like the plain normaliseRange.
  const [only] = normaliseRangeLinked([l], 0, 4);
  assert.deepEqual([...only], [...normaliseRange(l, 0, 4)]);
});

test("downmixChannels averages, and is identity for one channel", () => {
  const l = Float32Array.from([1, 0, -1, 0.5]);
  const r = Float32Array.from([0, 0, 1, 0.5]);
  assert.deepEqual([...downmixChannels([l, r])], [0.5, 0, 0, 0.5]);
  const one = downmixChannels([l]);
  assert.deepEqual([...one], [...l]);
  assert.notEqual(one, l, "returns a copy");
});

// ── item 180: the base stereo patch (a full-range Ixmp patch that exists
// only to add channels to an instrument's OWN base sample, since the base
// record has no room for the 's' block) must track the base record's own
// sample-geometry edits, and stay out of the zone-editing UI ────────────────

/** Import one stereo (or mono, when `pcmR` is omitted) take via
 *  planMultiSampleImport/importBankOp — the same shape the "importing a
 *  stereo take" test above builds by hand — and return {doc, undo, slot}. */
function importTake(pcm, pcmR) {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const undo = new UndoStack(doc);
  const plan = planMultiSampleImport(doc, [{
    nameBytes: new TextEncoder().encode("take"), pcm, pcmR, rate: 32000, loop: true,
  }]);
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(importBankOp(plan));
  return { doc, undo, slot: plan.insts[0].destSlot };
}

const N = 300;
const pcmL = Uint8Array.from({ length: N }, (_, i) => 128 + Math.round(60 * Math.sin(i / 9)));
const pcmR = Uint8Array.from({ length: N }, (_, i) => 128 + Math.round(40 * Math.sin(i / 5)));

test("baseStereoPatchIndex finds the importer's shadow patch, and only that", () => {
  const { doc, slot } = importTake(pcmL, pcmR);
  const inst = doc.instruments[slot];
  assert.equal(inst.extraPatches.length, 1);
  assert.equal(baseStereoPatchIndex(inst), 0);

  // A mono import gets no patch at all.
  const { doc: monoDoc, slot: monoSlot } = importTake(pcmL, null);
  assert.equal(monoDoc.instruments[monoSlot].extraPatches, null);
  assert.equal(baseStereoPatchIndex(monoDoc.instruments[monoSlot]), -1);

  // A genuine zone that happens to reuse the base sample, but carries no 's'
  // block, is not the shadow patch — only hasChanBlock makes it one.
  const plain = makeInstPatch({
    pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    samplePtr: inst.samplePtr, sampleLength: inst.sampleLength,
  });
  const withPlainZone = { ...inst, extraPatches: [plain] };
  assert.equal(baseStereoPatchIndex(withPlainZone), -1);
});

test("syncBaseStereoPatchOp mirrors a base sample-geometry edit into the shadow patch", () => {
  const { doc, undo, slot } = importTake(pcmL, pcmR);
  const before = doc.instruments[slot].extraPatches[0];
  const beforeChanPtrs = [...before.chanPtrs];
  const beforeDefaultPan = before.defaultPan;
  const origLoopStart = doc.instruments[slot].sampleLoopStart;
  const origDetune = doc.instruments[slot].sampleDetune;

  const sync = syncBaseStereoPatchOp(doc, slot, { sampleLoopStart: 12, sampleDetune: 99 });
  assert.notEqual(sync, null);
  undo.apply(compositeOp([
    setInstFieldOp(slot, "sampleLoopStart", 12),
    setInstFieldOp(slot, "sampleDetune", 99),
    sync,
  ]));

  const patch = doc.instruments[slot].extraPatches[0];
  assert.equal(patch.loopStart, 12, "the mirrored field followed the base edit");
  assert.equal(patch.sampleDetune, 99);
  // Everything else on the patch — including the 's' block — is untouched.
  assert.deepEqual(patch.chanPtrs, beforeChanPtrs);
  assert.equal(patch.defaultPan, beforeDefaultPan);
  assert.equal(patch.loopEnd, before.loopEnd);

  // Round-trips through the file and back with the synced value intact.
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.instruments[slot].extraPatches[0].loopStart, 12);
  assert.equal(reloaded.instruments[slot].sampleLoopStart, 12);

  // Undo restores both the base record and the patch together (one step).
  undo.undo();
  assert.equal(doc.instruments[slot].sampleLoopStart, origLoopStart);
  assert.equal(doc.instruments[slot].sampleDetune, origDetune);
  const afterUndo = doc.instruments[slot].extraPatches[0];
  assert.equal(afterUndo.loopStart, before.loopStart);
  assert.equal(afterUndo.sampleDetune, before.sampleDetune);
});

test("syncBaseStereoPatchOp is a no-op without a shadow patch or a mirrored field", () => {
  const { doc: monoDoc, slot: monoSlot } = importTake(pcmL, null);
  assert.equal(syncBaseStereoPatchOp(monoDoc, monoSlot, { sampleLoopStart: 5 }), null);

  const { doc, slot } = importTake(pcmL, pcmR);
  // instrumentFlag is a base-record field, but not one a patch duplicates.
  assert.equal(syncBaseStereoPatchOp(doc, slot, { instrumentFlag: 5 }), null);
});

test("rebindBaseStereoPatchOp re-points the shadow patch at a NEW stereo sample", () => {
  const { doc, undo, slot } = importTake(pcmL, pcmR);
  const oldPatch = doc.instruments[slot].extraPatches[0];

  // A second, different stereo take lands new pool spans in the same doc.
  const pcm2 = Uint8Array.from({ length: N }, (_, i) => 128 + Math.round(50 * Math.cos(i / 7)));
  const pcm2R = Uint8Array.from({ length: N }, (_, i) => 128 + Math.round(30 * Math.cos(i / 4)));
  const plan2 = planMultiSampleImport(doc, [{
    nameBytes: new TextEncoder().encode("other take"), pcm: pcm2, pcmR: pcm2R, rate: 22050, loop: false,
  }]);
  undo.apply(importBankOp(plan2));
  const newInst = doc.instruments[plan2.insts[0].destSlot];
  const entry = doc.sampleList().find((e) => e.ptr === newInst.samplePtr);
  assert.equal(isStereoSample(entry), true);

  const rebind = rebindBaseStereoPatchOp(doc, slot, {
    samplePtr: entry.ptr, sampleLength: entry.len, playStart: 0,
    loopStart: entry.loopStart, loopEnd: entry.loopEnd, samplingRate: entry.rate,
    sampleDetune: 0, loopMode: entry.loopMode,
  }, entry.chanPtrs, entry.chanMode);
  assert.notEqual(rebind, null);
  undo.apply(compositeOp([
    setInstFieldOp(slot, "samplePtr", entry.ptr),
    setInstFieldOp(slot, "sampleLength", entry.len),
    rebind,
  ]));

  const patches = doc.instruments[slot].extraPatches;
  assert.equal(patches.length, 1, "updated in place, not appended");
  assert.equal(patches[0].samplePtr, entry.ptr);
  assert.deepEqual(patches[0].chanPtrs, entry.chanPtrs);
  assert.notEqual(patches[0].samplePtr, oldPatch.samplePtr,
    "no longer points at the sample it was switched away from");

  const reloaded = new Document(parseTaud(doc.toBytes()));
  const rePatch = reloaded.instruments[slot].extraPatches[0];
  assert.equal(rePatch.samplePtr, entry.ptr);
  assert.deepEqual(rePatch.chanPtrs, entry.chanPtrs);
});

test("rebindBaseStereoPatchOp drops the shadow patch when re-binding to a mono sample", () => {
  // `fields` is unused on this path (an empty chanPtrs means "adopted a mono
  // sample" — there is nothing left for a patch to add).
  const { doc, undo, slot } = importTake(pcmL, pcmR);
  const drop = rebindBaseStereoPatchOp(doc, slot, {}, []);
  assert.notEqual(drop, null);
  undo.apply(drop);
  assert.equal(doc.instruments[slot].extraPatches, null);

  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.instruments[slot].extraPatches, null);
});

test("rebindBaseStereoPatchOp is a no-op adopting mono with no existing shadow patch", () => {
  const { doc, slot } = importTake(pcmL, null);
  assert.equal(rebindBaseStereoPatchOp(doc, slot, {}, []), null);
});
