// The two tiers of the Metainstrument family (inst.js, META_TIER_*).
//
// Types 0…7 are kinds assembled from sources — Layered, Formant, FM — and
// types 8…13 are kinds that generate a sound of their own where a sample
// would be — OPL, and PSG to come; 14 and 15 are reserved. Every kind of the
// first tier MUST take a kind of the second as a source: as a layer, as an FM
// operator, and as a formant instrument's glottal source. What is pinned
// here is each of those three paths, the record field the third one needs,
// and the references the editor has to follow because of it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../core/engine/constants.js";
import {
  TaudInst, buildOplRecord, buildMetaRecord, buildFormantRecord, makeMetaLayer,
  META_TYPE_FM, META_TYPE_LAYERED, META_TYPE_OPL,
  metaTierOf, META_TIER_NONE, META_TIER_HIGH, META_TIER_LOW, META_TIER_RESERVED,
} from "../../core/engine/inst.js";
import * as O from "../../core/engine/opl.js";
import * as F from "../../core/engine/formant.js";
import { SAMPLEBIN_SIZE, SAMPLEINST_SIZE } from "../../core/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { planRenumberInstrument, planDeleteInstrument, metainstrumentParents } from "../../src/doc/cleanup.js";
import { formantSourceInstBytes } from "../../src/doc/formantedit.js";

const C4_HZ = 261.6255653005986;

/** A plain sine: a silent modulator and a full-level carrier at ×1. */
const SINE = {
  kind: O.OPL_KIND_2OP,
  ops: [
    { mult: 1, tl: 63, ar: 15, dr: 0, sl: 0, rr: 15, eg: 1 },
    { mult: 1, tl: 0, ar: 15, dr: 0, sl: 0, rr: 8, eg: 1 },
  ],
};
/** A bright buzz — the modulator well up — the sort of patch a voice is sung on. */
const BUZZ = (carrierTl = 0) => ({
  kind: O.OPL_KIND_2OP,
  ops: [
    { mult: 1, tl: 12, ar: 15, dr: 0, sl: 0, rr: 15, eg: 1 },
    { mult: 1, tl: carrierTl, ar: 15, dr: 0, sl: 0, rr: 8, eg: 1 },
  ],
});
const oplInst = (patch, fields = {}) => buildOplRecord(O.encodeOplPatch(patch), fields);

/** A one-cycle sawtooth at 0x1000, middle C at note $5000. */
const SAW = { ptr: 0x1000, len: 128, rate: Math.round(128 * C4_HZ), loopStart: 0, loopEnd: 128, loopMode: 1 };
function fillSaw(bin) {
  for (let i = 0; i < SAW.len; i++) bin[SAW.ptr + i] = Math.round((255 * i) / (SAW.len - 1));
}
function formantInst(sourceInst = 0) {
  const p = new F.FormantPatch();
  p.srcPtr = SAW.ptr;
  p.front = 200; p.open = 255; p.round = 0; p.refNote = 0x4000;
  return buildFormantRecord(F.encodeFormantBlock(p), SAW, { sourceInst });
}

function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.vol !== undefined) pat[o + 3] = c.vol & 0x3f;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  return eng;
}

function renderLeft(eng, frames) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  const res = new Float32Array(frames);
  for (let at = 0; at < frames; at += TRACKER_CHUNK) {
    eng.renderChunk(0, out);
    res.set(ts.mixLeft.subarray(0, Math.min(TRACKER_CHUNK, frames - at)), at);
  }
  return res;
}

/** Instruments as {slot: record}, one note on lane 0; the left bus. */
function play(insts, cell, frames = 12000, setup = null) {
  const eng = new TaudEngine();
  fillSaw(eng.sampleBin);
  for (const [slot, rec] of Object.entries(insts)) eng.uploadInstrument(Number(slot), rec);
  if (setup) setup(eng);
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1, ...cell }]);
  return { eng, out: renderLeft(eng, frames) };
}

const ts0 = (eng) => eng.playheads[0].trackerState;
const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const db = (x) => 20 * Math.log10(x);
/** Hann-windowed power of `a` over [from, to) at `hz`. */
function power(a, from, to, hz) {
  const n = to - from;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const ph = (2 * Math.PI * hz * i) / SAMPLING_RATE;
    re += a[from + i] * w * Math.cos(ph);
    im -= a[from + i] * w * Math.sin(ph);
  }
  return (re * re + im * im) / (n * n);
}
const op = (slot, mix = 159, detune = 0) => makeMetaLayer(slot, mix, detune, 0, 0xffff, 0, 63);

// ── the tiers ────────────────────────────────────────────────────────────

test("the type nibble splits 0…7 / 8…13 / 14…15", () => {
  for (let t = 0; t < 16; t++) {
    const want = t <= 7 ? META_TIER_HIGH : t <= 13 ? META_TIER_LOW : META_TIER_RESERVED;
    assert.equal(metaTierOf(t), want, `type ${t}`);
  }
  assert.equal(metaTierOf(META_TYPE_OPL), META_TIER_LOW);
  assert.equal(metaTierOf(F.META_TYPE_FORMANT), META_TIER_HIGH);
  assert.equal(metaTierOf(META_TYPE_FM), META_TIER_HIGH);
});

test("each kind reports its tier, and what it names as sources", () => {
  const load = (rec) => { const i = new TaudInst(1); i.loadRecord(rec); return i; };
  const plain = new TaudInst(1);
  assert.equal(plain.metaTier, META_TIER_NONE);
  const opl = load(oplInst(SINE));
  assert.ok(opl.isLowMeta && !opl.isHighMeta);
  assert.deepEqual(opl.sourceSlots, []);
  const layered = load(buildMetaRecord([op(0x101), op(0x2a5)]));
  assert.ok(layered.isHighMeta);
  assert.deepEqual(layered.sourceSlots, [0x101, 0x2a5]);
  const rack = load(buildMetaRecord([op(3), op(0), op(4)], { type: META_TYPE_FM }));
  assert.ok(rack.isHighMeta);
  assert.deepEqual(rack.sourceSlots, [3, 4], "a muted operator names nothing");
  const formant = load(formantInst(0x2c4));
  assert.ok(formant.isHighMeta && !formant.isLowMeta);
  assert.deepEqual(formant.sourceSlots, [0x2c4]);
  assert.deepEqual(load(formantInst(0)).sourceSlots, [], "a sampled source names no instrument");
});

// ── FM: an OPL channel as an operator ────────────────────────────────────

test("a rack's OPL carrier keeps the note's volume out of the chip and applies it once", () => {
  const vols = [0x3f, 0x1f];
  const rack = vols.map((vol) => rms(play({
    0x101: oplInst(SINE),
    1: buildMetaRecord([op(0x101)], { type: META_TYPE_FM }),
  }, { vol }).out, 4800));
  const plain = vols.map((vol) => rms(play({ 1: oplInst(SINE) }, { vol }).out, 4800));
  assert.ok(Math.abs(db(rack[0] / plain[0])) < 0.1, `full volume: rack ${rack[0]} vs plain ${plain[0]}`);
  // The chip steps its attenuation in 1/256 octave; the rack scales linearly.
  // Either way the column is applied once, not twice.
  assert.ok(Math.abs(db(rack[1] / rack[0]) - db(plain[1] / plain[0])) < 0.1,
    `half volume: rack ${db(rack[1] / rack[0])} dB, plain ${db(plain[1] / plain[0])} dB`);
});

test("a rack phase-modulates an OPL carrier, and an OPL operator can modulate", () => {
  const carrier = (mix) => play({
    0x101: oplInst(SINE),
    0x102: oplInst(SINE),
    // Operator 1 into operator 0: the default chain.
    1: buildMetaRecord([op(0x101), op(0x102, mix)], { type: META_TYPE_FM }),
  }, {}).out;
  const alone = play({
    0x101: oplInst(SINE),
    1: buildMetaRecord([op(0x101)], { type: META_TYPE_FM }),
  }, {}).out;
  const silentMod = carrier(0);
  assert.deepEqual([...silentMod.subarray(0, 12000)], [...alone.subarray(0, 12000)],
    "a modulator at −∞ dB leaves the chip exactly as it runs free");
  const modulated = carrier(159);
  let diff = 0;
  for (let i = 4800; i < 12000; i++) diff += (modulated[i] - alone[i]) ** 2;
  assert.ok(Math.sqrt(diff / 7200) > 0.05, "a unity modulator moves the carrier's phase");
  // Still the note's harmonic series: FM at ×1 : ×1 adds harmonics, not a new
  // pitch — the power sits on k·f0 and not between.
  let on = 0, between = 0;
  for (let k = 1; k <= 8; k++) {
    on += power(modulated, 4800, 12000, k * C4_HZ);
    between += power(modulated, 4800, 12000, (k + 0.5) * C4_HZ);
  }
  assert.ok(on > 100 * between, `harmonic ${on} vs inharmonic ${between}`);
  assert.ok(power(modulated, 4800, 12000, 3 * C4_HZ) > 1000 * power(alone, 4800, 12000, 3 * C4_HZ),
    "the modulation puts power on the third harmonic, where the bare sine has none");
});

test("a high-tier kind is still no FM operator", () => {
  const { out } = play({
    0x101: formantInst(),
    1: buildMetaRecord([op(0x101)], { type: META_TYPE_FM }),
  }, {});
  assert.equal(rms(out, 0), 0, "a formant instrument is a sound made of a source, not one");
});

// ── Formant: an OPL channel as the glottal source ────────────────────────

test("a formant instrument sung from an OPL instrument sounds the chip through the tract", () => {
  const { eng, out } = play({ 0x101: oplInst(BUZZ(), { rate: 16726 }), 1: formantInst(0x101) }, {});
  const v = ts0(eng).voices[0];
  assert.ok(v.formant !== null && v.formant.src !== null, "the chip is the source");
  assert.equal(v.activeSamplingRate, 16726, "at the chip instrument's C2SPD — an octave up");
  assert.ok(rms(out, 4800) > 0.01, "it sings");
  // The sample is not read at all.
  assert.equal(v.samplePos, v.activeSamplePlayStart);
});

test("a chip source is calibrated by its level, as a sampled one is", () => {
  const level = (tl) => rms(play({ 0x101: oplInst(BUZZ(tl)), 1: formantInst(0x101) }, {}, 24000).out, 9600);
  const loud = level(0), quiet = level(12);  // the carrier 9 dB down on the chip
  assert.ok(Math.abs(db(quiet / loud)) < 1.5, `${db(quiet / loud).toFixed(2)} dB apart`);
});

test("a formant instrument naming anything but an OPL instrument sings its sample", () => {
  const plain = new Uint8Array(256);
  const own = play({ 1: formantInst(0) }, {}).out;
  for (const other of [plain, formantInst(0), buildMetaRecord([op(0x103)])]) {
    const { eng, out } = play({ 0x101: other, 0x103: oplInst(SINE), 1: formantInst(0x101) }, {});
    assert.equal(ts0(eng).voices[0].formant.src, null);
    assert.deepEqual([...out], [...own]);
  }
  const self = play({ 1: formantInst(1) }, {}).out;
  assert.deepEqual([...self], [...own], "naming itself is naming nothing");
});

test("the source instrument rides in the header and round-trips through the record", () => {
  const rec = formantInst(0x2c4);
  assert.equal(rec[0], 0x12, "type 1, bits 8…9 in the low bits");
  assert.equal(rec[1], 0xc4);
  assert.equal(rec[2], 0xff); assert.equal(rec[3], 0xff);
  const inst = new TaudInst(1);
  inst.loadRecord(rec);
  assert.equal(inst.formant.srcInst, 0x2c4);
  assert.equal(inst.getByte(0), 0x12);
  assert.equal(inst.getByte(1), 0xc4);
  for (const [o, b] of formantSourceInstBytes(0x105)) inst.setByte(o, b);
  assert.equal(inst.formant.srcInst, 0x105);
  assert.ok(inst.isFormant, "an edit of the field leaves the kind alone");
  for (const [o, b] of formantSourceInstBytes(0)) inst.setByte(o, b);
  assert.equal(inst.formant.srcInst, 0);
  assert.equal(inst.getByte(0), 0x10);
});

// ── a type with no reading sounds nothing ────────────────────────────────

test("a table of a type this engine does not know sounds nothing", () => {
  const known = buildMetaRecord([op(0x101)], { type: META_TYPE_LAYERED });
  assert.ok(rms(play({ 0x101: oplInst(SINE), 1: known }, {}).out, 4800) > 0.01);
  for (const type of [2, 9, 14]) {
    const rec = buildMetaRecord([op(0x101)], { type });
    assert.equal(rms(play({ 0x101: oplInst(SINE), 1: rec }, {}).out, 0), 0, `type ${type}`);
  }
});

// ── the editor follows the new reference ─────────────────────────────────

function docWith(insts) {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  fillSaw(image);
  for (const [slot, rec] of Object.entries(insts)) image.set(rec, SAMPLEBIN_SIZE + Number(slot) * 256);
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  return new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: image,
    songs: [{
      numVoices: 32, bpm: 125, tickRate: 6, tuningBaseNote: 0x4500,
      tuningFreq: 440, globalFlags: 0, globalVolume: 128, mixingVolume: 48,
      patterns: [emptyPat], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections: [], ixmp: [],
    meta: { projectName: "test", songMeta: {} },
  });
}

test("a formant's chip source is a component: hidden, kept, renumbered, unhooked on delete", () => {
  const doc = docWith({ 0x10: oplInst(SINE), 1: formantInst(0x10) });
  assert.ok(doc.instruments[1].isFormant);
  assert.ok(doc.metaChildSlots().has(0x10), "listed with its parent, not on its own");
  assert.deepEqual(metainstrumentParents(doc, 0x10), [{ slot: 1, layers: 1 }]);
  const moved = planRenumberInstrument(doc, 0x10, 0x20);
  assert.ok(!moved.error, moved.error);
  const rec = moved.image.subarray(SAMPLEBIN_SIZE + 256, SAMPLEBIN_SIZE + 512);
  assert.equal(F.formantSourceInstOf(rec[0], rec[1]), 0x20, "the reference follows the move");
  const gone = planDeleteInstrument(doc, 0x10);
  assert.ok(!gone.error, gone.error);
  const left = gone.image.subarray(SAMPLEBIN_SIZE + 256, SAMPLEBIN_SIZE + 512);
  assert.equal(F.formantSourceInstOf(left[0], left[1]), 0, "deleting the chip returns it to its sample");
  assert.equal(left[0] >>> 4, F.META_TYPE_FORMANT);
});

test("a deleted formant instrument takes its chip source with it when nothing else names it", () => {
  const doc = docWith({ 0x110: oplInst(SINE), 1: formantInst(0x110) });
  const gone = planDeleteInstrument(doc, 1);
  assert.ok(!gone.error, gone.error);
  const chip = gone.image.subarray(SAMPLEBIN_SIZE + 0x110 * 256, SAMPLEBIN_SIZE + 0x111 * 256);
  assert.ok(chip.every((b) => b === 0), "an orphaned $100+ source goes with it");
});

test("picking an OPL source copies it in as the formant instrument's own sub-instrument", async () => {
  const { planSetFormantSource } = await import("../../src/doc/bankmerge.js");
  const { importBankOp } = await import("../../src/doc/ops.js");
  const { UndoStack } = await import("../../src/doc/undo.js");
  const doc = docWith({ 2: oplInst(BUZZ()), 1: formantInst(0) });
  doc.undo = new UndoStack(doc);
  const before = Buffer.from(doc.toBytes());
  assert.ok(planSetFormantSource(doc, 1, 3).error, "an empty slot is no source");
  assert.ok(planSetFormantSource(doc, 2, 2).error, "only a formant instrument takes one");
  const plan = planSetFormantSource(doc, 1, 2);
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(importBankOp(plan));
  const child = doc.instruments[1].formant.srcInst;
  assert.ok(child >= 0x100, `a $100+ copy, not $${child.toString(16)}`);
  assert.ok(doc.instruments[child].isOpl);
  assert.deepEqual([...doc.instRecordBytes(child)], [...doc.instRecordBytes(2)], "a copy of the pick");
  assert.ok(doc.selectableInstrumentSlots().includes(2), "the pick stays where it was");
  assert.ok(!doc.selectableInstrumentSlots().includes(child), "the copy is the formant instrument's");
  doc.undo.apply(importBankOp(planSetFormantSource(doc, 1, 0)));
  assert.equal(doc.instruments[1].formant.srcInst, 0, "back to its sample");
  doc.undo.undo();
  doc.undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});
