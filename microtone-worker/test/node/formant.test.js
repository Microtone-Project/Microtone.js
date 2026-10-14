// Item 212 — Metainstrument type 1: the formant instrument.
//
// What is pinned here: (1) the record — an ordinary instrument whose header
// says "type 1", whose sample is the glottal source with its pointer in the
// tract block, and whose second pitch/filter slot is that block; (2) the
// vowel and the pitch rules — tongue and lips on Catford's cardinal vowels,
// R1 tuned onto f0 by opening the jaw; (3) the sound — formants where the
// vowel puts them, one level whatever the source's level, the vowel or the
// pitch, consonants before the vowel and the coda only on a key-off, the
// noise generator, a sounding note following edits to its vowel; (4) the
// recipe machine's ranking; (5) the pool tools, which have to know every
// pointer a type-1 record holds.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../core/engine/constants.js";
import { TaudInst, buildFormantRecord } from "../../core/engine/inst.js";
import * as F from "../../core/engine/formant.js";
import { META_TYPE_FORMANT, FORMANT_RECORD_HEADER } from "../../core/engine/formant.js";
import { SAMPLEINST_SIZE, SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp, cleanupBankOp, setInstBytesOp } from "../../src/doc/ops.js";
import { planCreateOpl, planImport } from "../../src/doc/bankmerge.js";
import { planPoolDefrag } from "../../src/doc/pooldefrag.js";
import { planDeleteSample } from "../../src/doc/cleanup.js";
import {
  defaultFormantRecord, formantRecordSpans, formantSlotBytes, formantVowelBytes, slotFromRecipe,
  VOWEL_MARKS, nearestVowelMark, vowelEffectArg, formantSyllable, isFormantRecord,
} from "../../src/doc/formantedit.js";
import { FormantMachine, rangeCandidates, spanOf, poolSpan, gainOctet } from "../../src/doc/formantrecipe.js";
import { buildRegionPayload } from "../../src/doc/sampleregions.js";
import { META_MIX_GAIN } from "../../core/engine/tables.js";

const C4_HZ = 261.6255653005986;
const id = (ipa) => F.CONSONANT_LIST.find((r) => r.ipa === ipa).id;

// ── material ─────────────────────────────────────────────────────────────

/** A one-cycle sawtooth (the textbook glottal source), a white noise, and a
 *  pitched square, written into a pool. */
const SAW = { ptr: 0x1000, len: 128, rate: Math.round(128 * C4_HZ), loopStart: 0, loopEnd: 128, loopMode: 1 };
const NOISE = { ptr: 0x2000, len: 22050, rate: 22050, loopStart: 0, loopEnd: 0, loopMode: 0 };
const SQUARE = { ptr: 0x8000, len: 8000, rate: 16000, loopStart: 0, loopEnd: 0, loopMode: 0 };
/** The saw at a quarter of full scale, and a parabola — every harmonic, power
 *  falling as 1 ÷ k⁴, −12 dB per octave — both one cycle like the saw. */
const QUIET_SAW = { ...SAW, ptr: 0x1800 };
/** One cycle whose SECOND harmonic carries it, as a recorded [u] at its pitch
 *  does: 0.4·h1 + h2 + 0.3·h3. */
const H2SRC = { ...SAW, ptr: 0x1a00 };
/** The saw at half scale riding on a DC offset of +0.31. */
const OFFSET_SAW = { ...SAW, ptr: 0x1900 };
const PARABOLA = { ...SAW, ptr: 0x1c00 };
/** The noise at half its level. */
const HALF_NOISE = { ...NOISE, ptr: 0x10000 };
/** A sung-and-decayed sample: 6400 bytes of a full-scale saw (period 128,
 *  middle C at SAW.rate), then a tail at 1/16 of it, looped in the tail —
 *  as an ordinary instrument loops a plucked or sung sample to sustain it. */
const TAILED = { ptr: 0x40000, len: 8192, rate: SAW.rate, loopStart: 7680, loopEnd: 7808, loopMode: 1 };
function fillPool(bin) {
  for (let i = 0; i < SAW.len; i++) bin[SAW.ptr + i] = Math.round((255 * i) / (SAW.len - 1));
  for (let i = 0; i < SAW.len; i++) bin[QUIET_SAW.ptr + i] = Math.round(127.5 + (31.75 * (2 * i - SAW.len + 1)) / (SAW.len - 1));
  for (let i = 0; i < SAW.len; i++) bin[OFFSET_SAW.ptr + i] = Math.round(167.5 + (63.5 * (2 * i - SAW.len + 1)) / (SAW.len - 1));
  {
    const h = (t) => 0.4 * Math.sin(2 * Math.PI * t) + Math.sin(4 * Math.PI * t) + 0.3 * Math.sin(6 * Math.PI * t);
    let m = 0;
    for (let i = 0; i < SAW.len; i++) m = Math.max(m, Math.abs(h(i / SAW.len)));
    for (let i = 0; i < SAW.len; i++) bin[H2SRC.ptr + i] = Math.round(127.5 + (127 * h(i / SAW.len)) / m);
  }
  for (let i = 0; i < SAW.len; i++) {
    const x = (2 * i) / SAW.len - 1;
    bin[PARABOLA.ptr + i] = Math.round(127.5 + 127 * (3 * x * x - 1) / 2);
  }
  let x = 0x12345678;
  for (let i = 0; i < NOISE.len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    bin[NOISE.ptr + i] = 16 + ((x >>> 8) % 224);
    bin[HALF_NOISE.ptr + i] = 72 + ((x >>> 8) % 224) / 2;
  }
  for (let i = 0; i < TAILED.len; i++) {
    const a = i < 6400 ? 1 : 1 / 16;
    bin[TAILED.ptr + i] = Math.round(127.5 + 127 * a * (2 * ((i % 128) / 127) - 1));
  }
  for (let i = 0; i < SQUARE.len; i++) bin[SQUARE.ptr + i] = Math.floor((i * 440 * 2) / 16000) % 2 ? 200 : 56;
}

function patchBytes({ front = 200, open = 255, round = 0, slots = [0, 0, 0], track = 64, timing = 128, glide = 20,
  src = SAW, generator = false, gain = 0, range = [0, 0], semivowel = 0, rhotic = false } = {}) {
  const p = new F.FormantPatch();
  [p.rangeLo, p.rangeHi] = range;
  p.semivowel = semivowel; p.rhotic = rhotic;
  p.srcPtr = src.ptr; p.front = front; p.open = open; p.round = round;
  p.track = track; p.timing = timing; p.glide = glide; p.refNote = 0x4000;
  slots.forEach((c, i) => {
    const s = p.slots[i];
    s.cons = c;
    if (c && !generator && F.consonantNeedsNoise(F.CONSONANTS[c])) {
      s.ptr = NOISE.ptr; s.len = NOISE.len; s.offset = 0; s.rate = NOISE.rate; s.gain = gain;
    }
  });
  return F.encodeFormantBlock(p);
}
const formantRecord = (opts = {}, fields = {}) => buildFormantRecord(patchBytes(opts), opts.src ?? SAW, fields);

/** An ordinary record for the same saw, for level comparisons. */
function plainRecord(src) {
  const r = new Uint8Array(256);
  r[0] = src.ptr & 0xff; r[1] = (src.ptr >>> 8) & 0xff; r[2] = (src.ptr >>> 16) & 0xff;
  r[4] = src.len & 0xff; r[5] = src.len >>> 8; r[6] = src.rate & 0xff; r[7] = src.rate >>> 8;
  r[12] = src.loopEnd & 0xff; r[13] = src.loopEnd >>> 8; r[14] = src.loopMode;
  for (let i = 0; i < 25; i++) { r[21 + 2 * i] = 0x3f; r[71 + 2 * i] = 0x80; r[121 + 2 * i] = 0x80; r[201 + 2 * i] = 0x80; }
  r[171] = 255; r[177] = 0x80; r[179] = 0x50; r[182] = 0xff; r[196] = 255;
  return r;
}

/** Render `cells` on lane 0 with `rec` as instrument 1; the left mix bus.
 *  `at(ms, eng)` hooks run before the chunk that holds that millisecond. */
function render(rec, cells, frames, { tick = 6, at: hooks = [], more = [], bin = null } = {}) {
  const eng = new TaudEngine();
  if (bin) eng.sampleBin.set(bin.subarray(0, eng.sampleBin.length)); else fillPool(eng.sampleBin);
  eng.uploadInstrument(1, rec);
  more.forEach((r, i) => eng.uploadInstrument(2 + i, r));
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of cells) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.fx !== undefined) { pat[o + 5] = c.fx; pat[o + 6] = c.arg & 0xff; pat[o + 7] = (c.arg >>> 8) & 0xff; }
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, tick); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  const res = new Float32Array(frames);
  const due = hooks.map(([t, fn]) => [ms(t), fn]);
  for (let at = 0; at < frames; at += TRACKER_CHUNK) {
    for (const h of due) if (h[1] && at >= h[0]) { h[1](eng); h[1] = null; }
    eng.renderChunk(0, out);
    res.set(ts.mixLeft.subarray(0, Math.min(TRACKER_CHUNK, frames - at)), at);
  }
  return { res, eng, ts };
}
const ms = (t) => Math.round((t * SAMPLING_RATE) / 1000);
const rms = (a, t0, t1) => {
  let s = 0;
  for (let i = ms(t0); i < ms(t1); i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, ms(t1) - ms(t0)));
};
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const noteF0 = (note) => C4_HZ * 2 ** ((note - 0x5000) / 4096);

/** How LOUD a steady tone at f0 is: the power of each harmonic (Hann-windowed
 *  DFT, up to 64 of them and below 45% of the rate, as the normaliser counts
 *  them) weighted by the engine's equal-loudness weighting, in dB. */
function loudDb(a, t0, t1, f0) {
  const i0 = ms(t0), N = ms(t1) - i0;
  let p = 0;
  for (let k = 1; k <= 64 && k * f0 < 0.45 * SAMPLING_RATE; k++) {
    const w = (2 * Math.PI * k * f0) / SAMPLING_RATE, c1 = Math.cos(w), s1 = Math.sin(w);
    let re = 0, im = 0, c = 1, sn = 0;
    for (let i = 0; i < N; i++) {
      const v = a[i0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      re += v * c; im -= v * sn;
      const nc = c * c1 - sn * s1; sn = sn * c1 + c * s1; c = nc;
    }
    p += (re * re + im * im) * F.equalLoudness(k * f0);
  }
  return 10 * Math.log10(p / (N * N));
}
const S_FX = 0x1c; // effect opcode S

/** The strongest harmonics of f0 in a window, by a direct DFT at each one. */
function harmonicPeaks(a, t0, f0, n = 3) {
  const N = 4096, i0 = ms(t0);
  const amp = [];
  for (let k = 1; k * f0 < 5000; k++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * k * f0) / SAMPLING_RATE;
    for (let i = 0; i < N; i++) {
      const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      re += a[i0 + i] * h * Math.cos(w * i);
      im -= a[i0 + i] * h * Math.sin(w * i);
    }
    amp.push([k * f0, Math.hypot(re, im)]);
  }
  const peaks = [];
  for (let i = 1; i < amp.length - 1; i++) {
    if (amp[i][1] > amp[i - 1][1] && amp[i][1] >= amp[i + 1][1]) peaks.push(amp[i]);
  }
  return peaks.sort((p, q) => q[1] - p[1]).slice(0, n).map((p) => p[0]).sort((p, q) => p - q);
}

// ── the record ───────────────────────────────────────────────────────────

test("a type-1 record is an ordinary record with the source's pointer in the tract block", () => {
  const rec = formantRecord({ slots: [id("s"), 0, id("n")] }, { pan: 0x40, nna: 3, fadeout: 0x40 });
  assert.deepEqual([...rec.subarray(0, 4)], [...FORMANT_RECORD_HEADER]);
  assert.equal(rec[0] >>> 4, META_TYPE_FORMANT);
  assert.ok(isFormantRecord(rec));
  const inst = new TaudInst(3);
  inst.loadRecord(rec);
  assert.ok(inst.isFormant);
  assert.equal(inst.isMeta, false, "no layer table: the trigger treats it as ordinary");
  assert.equal(inst.isOpl, false);
  assert.equal(inst.samplePtr, SAW.ptr, "the source's pointer, read from the block");
  assert.equal(inst.sampleLength, SAW.len);
  assert.equal(inst.samplingRate, SAW.rate);
  assert.equal(inst.sampleLoopEnd, SAW.loopEnd);
  assert.equal(inst.defaultPan, 0x40);
  assert.equal(inst.newNoteAction, 3);
  assert.equal(inst.pf2EnvLoop, 0, "the second pitch/filter slot is the tract");
  assert.equal(inst.formant.slots[0].cons, id("s"));
  assert.equal(inst.formant.slots[2].cons, id("n"));
  for (let o = 0; o < 256; o++) assert.equal(inst.getByte(o), rec[o], `byte ${o} round-trips`);
});

test("the source pointer is samplePtr: moving one moves the other", () => {
  const inst = new TaudInst(3);
  inst.loadRecord(formantRecord());
  inst.samplePtr = 0x123456;
  assert.equal(inst.getByte(F.FORMANT_BLOCK_START), 0x56);
  assert.equal(inst.getByte(F.FORMANT_BLOCK_START + 2), 0x12);
  assert.deepEqual([0, 1, 2, 3].map((o) => inst.getByte(o)), [...FORMANT_RECORD_HEADER], "the header stays");
  inst.setByte(F.FORMANT_BLOCK_START + 1, 0x99);
  assert.equal(inst.samplePtr, 0x129956);
  inst.setByte(0, 0x00);
  assert.equal(inst.getByte(0), 0x10, "the header is the record's kind, not a field");
  const patch = inst.formant;
  inst.setByte(F.FORMANT_BLOCK_START + F.FB_OPEN, 7);
  assert.equal(inst.formant, patch, "the same object a sounding voice holds");
  assert.equal(patch.open, 7);
  inst.loadRecord(new Uint8Array(256));
  assert.equal(inst.isFormant, false, "an ordinary record written over it is ordinary again");
});

test("a formant instrument has no keyboard map: an Ixmp list is ignored", () => {
  const inst = new TaudInst(3);
  inst.loadRecord(formantRecord());
  inst.extraPatches = [{ pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63 }];
  assert.equal(inst.resolvePatch(0x5000, 63), null);
});

test("the block encodes and decodes field for field", () => {
  const p = new F.FormantPatch();
  Object.assign(p, { srcPtr: 0x7abcde, front: 12, open: 34, round: 56, track: 78, refNote: 0x4567,
    glide: 90, timing: 111, rangeLo: 0x10000, rangeHi: 0x800000 });
  Object.assign(p.slots[1], { cons: 54, ptr: 0x654321, len: 40000, offset: 1234, rate: 44100, tilt: -96, gain: 170 });
  const raw = F.encodeFormantBlock(p);
  assert.equal(raw.length, F.FORMANT_BLOCK_LEN);
  assert.equal(raw[F.FB_GR], 0, "no glide, not r-coloured");
  const q = F.decodeFormantBlock(raw, 0);
  assert.deepEqual({ ...q, slots: null }, { ...p, slots: null });
  assert.deepEqual(q.slots[1], p.slots[1]);
  Object.assign(p, { semivowel: 4, rhotic: true });
  const gr = F.encodeFormantBlock(p);
  assert.equal(gr[F.FB_GR], 0x84, "G in bits 0–2, R in bit 7");
  const q2 = F.decodeFormantBlock(gr, 0);
  assert.deepEqual([q2.semivowel, q2.rhotic], [4, true]);
  gr[F.FB_GR] = 0x07;
  assert.equal(F.decodeFormantBlock(gr, 0).semivowel, 0, "a reserved glide code is none");
});

// ── the chart and the pitch rules ────────────────────────────────────────

test("the tongue and the lips run through Catford's sixteen cardinal vowels", () => {
  const out = new Float64Array(2);
  const corner = [[255, 0], [255, 255], [0, 0], [0, 255]];   // front spread, front round, back spread, back round
  F.CARDINAL_VOWELS.forEach((row, h) => row.forEach(([f1, f2], c) => {
    F.vowelF1F2(corner[c][0], h * 85, corner[c][1], out);
    assert.ok(Math.abs(out[0] - f1) < 1e-9 && Math.abs(out[1] - f2) < 1e-9, `height ${h}, column ${c}`);
  }));
  // The inverse finds the tongue for a sound, with the lips as given.
  for (const round of [0, 128, 255]) {
    for (const [front, open] of [[255, 0], [40, 200], [128, 128], [200, 30]]) {
      F.vowelF1F2(front, open, round, out);
      const [x, h] = F.vowelCoordsOf(out[0], out[1], round);
      assert.ok(Math.abs(x - front) < 0.5 && Math.abs(h - open) < 0.5, `(${front}, ${open}) at round ${round}: ${x}, ${h}`);
    }
  }
  const m = (ipa) => VOWEL_MARKS.find((x) => x.ipa === ipa);
  assert.deepEqual([m("i").front, m("i").open, m("i").round], [255, 0, 0]);
  assert.deepEqual([m("y").front, m("y").open, m("y").round], [255, 0, 255], "[y] is [i]'s tongue with the lips rounded");
  assert.deepEqual([m("u").front, m("u").open, m("u").round], [0, 0, 255]);
  assert.equal(nearestVowelMark(255, 0, 255).ipa, "y", "roundness decides between [i] and [y]");
  const schwa = m("ə");
  assert.equal(nearestVowelMark(schwa.front, schwa.open, 0).ipa, "ə");
  F.vowelF1F2(schwa.front, schwa.open, 0, out);
  assert.ok(Math.abs(out[0] - 500) < 25 && Math.abs(out[1] - 1500) < 150, "schwa near the uniform tube's 500/1500 Hz");
  assert.equal(nearestVowelMark(200, 255, 0).ipa, "a", "a new instrument's vowel");
  assert.equal(vowelEffectArg(255, 0, 0), 0xa0f0, "S $Afgr for [i]: open 0, front F, round 0");
});

test("rounding the lips lowers every formant, as Catford's pairs say", () => {
  const V = new Float64Array(5), W = new Float64Array(5);
  F.vowelFormants(255, 0, 0, V);
  assert.deepEqual([...V].map(Math.round), [240, 2400, 3100, 3500, 4500]);
  F.vowelFormants(255, 0, 255, V);
  assert.deepEqual([...V].slice(0, 3).map(Math.round), [235, 2100, 2350], "[y]: F2 down 12%, F3 F2 + 250");
  F.vowelFormants(0, 0, 255, V);
  assert.deepEqual([...V].slice(0, 3).map(Math.round), [250, 595, 2200], "[u]: Klatt's F3 of 2200");
  F.vowelFormants(0, 0, 0, V);
  assert.equal(Math.round(V[1]), 1390, "[ɯ]: the same tongue, spread, F2 more than twice [u]'s");
  // Every step of the slider moves the sound, at every tongue position.
  for (const [front, open] of [[255, 0], [0, 0], [128, 128], [0, 255], [255, 255]]) {
    for (let r = 0; r < 255; r += 15) {
      F.vowelFormants(front, open, r, V);
      F.vowelFormants(front, open, r + 15, W);
      assert.ok(W[1] < V[1], `F2 falls with rounding at (${front}, ${open}), ${r}`);
      assert.ok(W[0] <= V[0] + 1e-9, `…and F1 never rises`);
    }
  }
});

test("a higher note is a smaller tract, and past F1 the jaw opens", () => {
  const V = new Float64Array(5), B = new Float64Array(5);
  const ref = F.noteHz(0x4000);
  assert.equal(F.vowelAtPitch(255, 255, 0, ref, ref, 64, V, B), 1, "at the reference note, the chart");
  assert.equal(Math.round(V[0]), 850);
  const s = F.vowelAtPitch(255, 255, 0, ref * 16, ref, 64, V, B);
  assert.ok(Math.abs(s - 2) < 1e-12, "four octaves up at k = ¼: twice the size");
  // [u] at C5: F1 is tuned onto f0 and F2 rises with the jaw.
  const s5 = F.vowelAtPitch(0, 0, 255, 523.25, ref, 64, V, B);
  assert.ok(Math.abs(V[0] - 523.25) < 1e-9);
  assert.ok(V[1] > 595 * s5 * 1.05, "a back vowel's F2 rises past its size alone");
  // [i] at C6: F1 on f0, F2 FALLS — the soprano's [i] heard as [ɛ].
  F.vowelAtPitch(255, 0, 0, 1046.5, ref, 64, V, B);
  assert.ok(Math.abs(V[0] - 1046.5) < 1e-9);
  assert.ok(V[1] < 2400 * (1046.5 / ref) ** 0.25, "a front vowel's F2 falls");
  for (let n = 1; n < 5; n++) assert.ok(V[n] >= V[n - 1] * 1.15 - 1e-9, "the formants stay in order");
  for (let n = 0; n < 5; n++) assert.ok(B[n] >= 50 && Math.abs(B[n] - Math.max(V[n] / 10, 50)) < 1e-9);
  F.vowelAtPitch(255, 255, 0, ref * 4, ref, 0, V, B);
  assert.equal(Math.round(V[1]), 1610, "track 0: one size at every pitch below F1");
});

// ── the sound ────────────────────────────────────────────────────────────

/** Each of F1…F3 within one harmonic of the strongest peaks of the sound —
 *  F1 and F2 only for a rounded vowel, whose F3 the lips leave too weak to
 *  stand out from F4. */
function assertFormants(a, t0, f0, front, open, round) {
  const n = round > 127 ? 2 : 3;
  const want = F.vowelFormants(front, open, round, new Float64Array(5)).slice(0, n);
  const got = harmonicPeaks(a, t0, f0, n);
  want.forEach((f, i) => assert.ok(Math.abs(got[i] - f) < f0, `F${i + 1} ${f.toFixed(0)} Hz, peak at ${got[i].toFixed(0)}`));
}

test("a sung vowel's formants are where the chart puts them, the lips' included", () => {
  for (const [front, open, round] of [[200, 255, 0], [255, 0, 0], [80, 120, 0], [0, 85, 255], [255, 85, 255]]) {
    const { res } = render(formantRecord({ front, open, round }), [{ row: 0, note: 0x4000, inst: 1 }], ms(800));
    assertFormants(res, 300, 130.8128, front, open, round);
  }
});

test("the equal-loudness weighting is ISO 226:2003's 60-phon contour, inverted", () => {
  const rel = (f) => 10 * Math.log10(F.equalLoudness(f) / F.equalLoudness(1000));
  // The contour's SPL at 1 kHz is the loudness level itself; 250 Hz needs
  // 7.5 dB more and 100 Hz 18.6 dB more to sound as loud; 3.15 kHz, where
  // hearing is keenest, 3.6 dB less.
  assert.equal(F.LOUDNESS_PHON, 60);
  for (const [f, want] of [[250, -7.52], [100, -18.64], [3150, 3.59], [500, -2.04]]) {
    assert.ok(Math.abs(rel(f) - want) < 0.01, `${f} Hz: ${rel(f).toFixed(3)} dB`);
  }
  assert.equal(rel(16000), rel(12500), "held past the table's last frequency");
  assert.equal(rel(10), rel(20), "…and below its first");
  assert.ok(Math.abs(rel(354) - (rel(315) + rel(400)) / 2) < 0.05, "linear in dB over log frequency");
});

test("one loudness: whatever the source's level and spectrum, the vowel and the pitch, a formant instrument sings as loud as its source", () => {
  // Two corrections: the SOURCE is brought to a full-scale sawtooth's RMS,
  // and the TRACT keeps its equal-loudness-weighted power — so an [i], whose
  // power lies under 300 Hz, comes out as loud as an [a], not at its RMS.
  const level = (rec, note) => loudDb(render(rec, [{ row: 0, note, inst: 1 }], ms(450)).res, 100, 450, noteF0(note));
  for (const note of [0x3000, 0x4000, 0x5000, 0x6000, 0x7000]) {
    const plain = level(plainRecord(SAW), note);
    for (const [front, open, round] of [[200, 255, 0], [255, 0, 0], [0, 0, 255], [255, 0, 255], [128, 128, 0]]) {
      const at = `note $${note.toString(16)}, (${front}, ${open}, ${round})`;
      const got = level(formantRecord({ front, open, round }), note);
      assert.ok(Math.abs(got - plain) < 0.6, `${at}: ${got.toFixed(2)} vs ${plain.toFixed(2)} dB`);
      const quiet = level(formantRecord({ front, open, round, src: QUIET_SAW }), note);
      assert.ok(Math.abs(quiet - plain) < 0.6, `${at}, a source 12 dB down: ${quiet.toFixed(2)} dB`);
      // A darker source — −12 dB/octave, which a sawtooth model of the
      // source put several dB off — measured by the engine.
      // A darker source: as loud as itself played plainly, once calibrated.
      const d = render(formantRecord({ front, open, round, src: PARABOLA }), [{ row: 0, note, inst: 1 }], ms(450));
      const dark = loudDb(d.res, 100, 450, noteF0(note));
      const darkPlain = level(plainRecord(PARABOLA), note) + db(d.ts.voices[0].formant.sg);
      assert.ok(Math.abs(dark - darkPlain) < 0.6, `${at}, a −12 dB/octave source: ${dark.toFixed(2)} vs ${darkPlain.toFixed(2)} dB`);
    }
  }
  // …and so not at one RMS: at C3 the [i] is the louder by RMS.
  const r = (front, open) => db(rms(render(formantRecord({ front, open }), [{ row: 0, note: 0x4000, inst: 1 }], ms(450)).res, 100, 450));
  assert.ok(r(255, 0) - r(200, 255) > 1.5, `[i] ${r(255, 0).toFixed(2)} vs [a] ${r(200, 255).toFixed(2)} dB RMS`);
});

test("a note starts at its own level — no burst while the normaliser settles — and a source's DC offset is taken out", () => {
  // The first control update runs before the mixer snaps the voice to the
  // note's rate; it must read the note's pitch, not the voice's last one.
  for (const note of [0x3000, 0x4000, 0x6000]) {
    for (const [front, open, round] of [[255, 0, 0], [0, 0, 255], [255, 85, 0], [0, 85, 255]]) {
      const { res } = render(formantRecord({ front, open, round }), [{ row: 0, note, inst: 1 }], ms(500));
      let onset = 0, steady = 0;
      for (let i = 0; i < ms(40); i++) onset = Math.max(onset, Math.abs(res[i]));
      for (let i = ms(200); i < ms(500); i++) steady = Math.max(steady, Math.abs(res[i]));
      assert.ok(onset < steady * 1.5, `$${note.toString(16)} (${front}, ${open}, ${round}): onset peak ${onset.toFixed(3)} vs ${steady.toFixed(3)}`);
      assert.equal(res.length, ms(500));
    }
  }
  const sum = (a) => { let m = 0; for (let i = ms(100); i < ms(450); i++) m += a[i]; return m / (ms(450) - ms(100)); };
  const off = render(formantRecord({ src: OFFSET_SAW }), [{ row: 0, note: 0x4000, inst: 1 }], ms(450)).res;
  const plain = render(formantRecord(), [{ row: 0, note: 0x4000, inst: 1 }], ms(450)).res;
  assert.ok(Math.abs(sum(off)) < 0.002, `mean ${sum(off).toFixed(4)}`);
  assert.ok(Math.abs(db(rms(off, 100, 450)) - db(rms(plain, 100, 450))) < 0.3, "the offset saw sings as the centred one does");
});

test("an onset fricative hisses before the vowel, and a fricative coda only after a key-off", () => {
  const rec = formantRecord({ slots: [id("s"), 0, id("s")] });
  const { res } = render(rec, [{ row: 0, note: 0x4000, inst: 1 }, { row: 4, note: 0x0001 }], ms(900));
  const vowel = rms(res, 300, 450);
  const hiss = rms(res, 40, 100);
  assert.ok(db(hiss) - db(vowel) < -3 && db(hiss) - db(vowel) > -12, `/s/ at ${(db(hiss) - db(vowel)).toFixed(1)} dB`);
  const coda = rms(res, 530, 600);
  assert.ok(db(coda) - db(vowel) < -3 && db(coda) > -60, "the coda sounds after the key-off");
  assert.ok(rms(res, 760, 900) === 0, "and then nothing: the coda ends the note");
});

test("a note cut, a note fade and a fast fade end the vowel without the coda", () => {
  // A key-off releases the instrument as it releases any — its fadeout runs
  // beside the coda — so the coda is heard whole on the default fadeout of 0;
  // the fades need one of their own to fade at all.
  const rec = formantRecord({ slots: [0, 0, id("t")] });
  const faded = formantRecord({ slots: [0, 0, id("t")] }, { fadeout: 0x20 });
  const tail = (sentinel, r = rec) => render(r, [{ row: 0, note: 0x4000, inst: 1 }, { row: 4, note: sentinel }], ms(900)).res;
  const keyOff = tail(0x0001);
  // A /t/ coda closes (silence), then bursts: energy after a gap.
  assert.ok(rms(keyOff, 545, 560) < rms(keyOff, 400, 470) * 0.05, "key-off: the closure");
  assert.ok(rms(keyOff, 568, 600) > rms(keyOff, 545, 560) * 4, "…then the release");
  const cut = tail(0x0002);
  assert.ok(rms(cut, 500, 900) === 0, "cut: silence");
  for (const sentinel of [0x0003, 0x0004]) {
    const r = tail(sentinel, faded);
    // A fade keeps the vowel's spectrum — no closure gap appears in it.
    assert.ok(rms(r, 545, 560) > rms(r, 470, 480) * 0.5, `fade $${sentinel}: no closure`);
  }
});

test("a slot with no sample sounds the noise generator: white, at the source's level, the same every time", () => {
  const gen = formantRecord({ slots: [id("s"), 0, id("s")], generator: true });
  const recipe = new FormantMachine(pool(), CANDS).recipes(id("s")).find((x) => x.cand?.name === "noise");
  const smp = formantRecord({ slots: [id("s"), 0, id("s")], gain: recipe.gain });
  const cells = [{ row: 0, note: 0x4000, inst: 1 }, { row: 4, note: 0x0001 }];
  const a = render(gen, cells, ms(900)).res;
  const b = render(smp, cells, ms(900)).res;
  const vowel = rms(a, 300, 450);
  const hiss = rms(a, 40, 100);
  assert.ok(db(hiss) - db(vowel) < -3 && db(hiss) - db(vowel) > -12, `/s/ at ${(db(hiss) - db(vowel)).toFixed(1)} dB`);
  // The test's noise sample is white too, at its own rate: at the gain the
  // machine gives it, the two hiss alike.
  assert.ok(Math.abs(db(hiss) - db(rms(b, 40, 100))) < 1.5,
    `generator ${db(hiss).toFixed(1)} vs sample ${db(rms(b, 40, 100)).toFixed(1)} dB`);
  assert.ok(rms(a, 530, 600) > 0, "the coda hisses too");
  // The generator restarts at each consonant: both /s/ hiss the same noise
  // (the first note is cut and silent well before the second). The second
  // may start a sample off the row's first, so the match is sought within a
  // few samples of it: the two correlate as one.
  const c = render(gen, [{ row: 0, note: 0x4000, inst: 1 }, { row: 4, note: 0x0002 },
    { row: 8, note: 0x4000, inst: 1 }], ms(1000)).res;
  const onset2 = ms(8 * 6 * 20);
  let best = -1;
  for (let lag = -3; lag <= 3; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = ms(10); i < ms(35); i++) {
      const y = c[onset2 + lag + i];
      xy += c[i] * y; xx += c[i] * c[i]; yy += y * y;
    }
    best = Math.max(best, xy / Math.sqrt(xx * yy));
  }
  assert.ok(best > 0.999, `correlation ${best.toFixed(5)}`);
});

test("a key-off during the onset waits for it, then speaks the coda", () => {
  const rec = formantRecord({ slots: [id("s"), 0, id("n")] });
  const { res } = render(rec, [{ row: 0, note: 0x4000, inst: 1 }, { row: 1, note: 0x0001 }], ms(700));
  assert.ok(rms(res, 150, 160) > rms(res, 40, 100), "the vowel arrives after the /s/");
  assert.ok(rms(res, 500, 700) === 0, "and the nasal coda ends the note");
});

test("a new note lets the old one finish its coda in the background (New Note Action: note off)", () => {
  const rec = formantRecord({ slots: [0, 0, id("s")] }, { nna: 0 });
  const { res, ts } = render(rec, [{ row: 0, note: 0x4000, inst: 1 }, { row: 4, note: 0x4800, inst: 1 }], ms(700));
  const hiss = rms(res, 500, 560);
  assert.ok(hiss > 0);
  assert.ok(ts.backgroundVoices.every((v) => !v.active || v.formant !== null));
});

test("S $Afgr on the trigger row is the note's vowel from its start; later it glides", () => {
  const { res } = render(formantRecord(), [{ row: 0, note: 0x4000, inst: 1, fx: S_FX, arg: 0xa0f0 }], ms(400));
  assertFormants(res, 20, 130.8128, 255, 0, 0);
  const later = render(formantRecord({ glide: 50 }), [{ row: 0, note: 0x4000, inst: 1 }, { row: 2, fx: S_FX, arg: 0xa0f0 }], ms(900));
  const v = later.ts.voices[0].formant;
  assert.equal(v.vOpen, 0);
  assert.equal(v.vFront, 255);
});

test("a sounding note sings the record's vowel as it is edited, until S $Afgr gives it one of its own", () => {
  const set = (front, open, round) => (eng) => {
    const inst = eng.instruments[1];
    inst.setByte(F.FORMANT_BLOCK_START + F.FB_FRONT, front);
    inst.setByte(F.FORMANT_BLOCK_START + F.FB_OPEN, open);
    inst.setByte(F.FORMANT_BLOCK_START + F.FB_ROUND, round);
  };
  // [a], then edited to [i] and to [y] while the note sounds.
  const { res, ts } = render(formantRecord(), [{ row: 0, note: 0x4000, inst: 1 }], ms(1300),
    { at: [[400, set(255, 0, 0)], [800, set(255, 0, 255)]] });
  assertFormants(res, 100, 130.8128, 200, 255, 0);
  assertFormants(res, 500, 130.8128, 255, 0, 0);
  assertFormants(res, 900, 130.8128, 255, 0, 255);
  assert.equal(ts.voices[0].formant.ownVowel, false);
  // After S $Afgr the note keeps its own vowel through an edit.
  const own = render(formantRecord({ glide: 0 }), [{ row: 0, note: 0x4000, inst: 1 }, { row: 1, fx: S_FX, arg: 0xa0f0 }],
    ms(1000), { at: [[500, set(0, 0, 255)]] });
  assertFormants(own.res, 700, 130.8128, 255, 0, 0);
  assert.equal(own.ts.voices[0].formant.ownVowel, true);
});

test("an instrument change mid-note glides to the new record's vowel, then follows its edits", () => {
  const toI = formantRecord({ front: 255, open: 0, round: 0, glide: 25 });   // a 50 ms glide
  const { res, ts } = render(formantRecord(), [{ row: 0, note: 0x4000, inst: 1 }, { row: 3, inst: 2 }], ms(1300),
    { more: [toI], at: [[900, (eng) => eng.instruments[2].setByte(F.FORMANT_BLOCK_START + F.FB_ROUND, 255)]] });
  assertFormants(res, 100, 130.8128, 200, 255, 0);
  assertFormants(res, 500, 130.8128, 255, 0, 0);
  assertFormants(res, 1000, 130.8128, 255, 0, 255);
  const st = ts.voices[0].formant;
  assert.equal(st.ownVowel, false, "the glide over, the note follows the record again");
  assert.equal(st.vRound, 255);
});

test("Duplicate Check Sample: the next syllable from any formant instrument on the same pool range ends the old vowel", () => {
  const active = (ts) => ts.backgroundVoices.filter((v) => v.active && v.formant !== null).length;
  const word = (dct, rangeB = [0, 0]) => {
    const A = formantRecord({ front: 255, open: 0 }, { dct });                         // [i], no coda
    const B = formantRecord({ slots: [id("s"), 0, 0], range: rangeB }, { dct });       // [sa], another instrument
    return render(A, [{ row: 0, note: 0x4000, inst: 1 }, { row: 4, note: 0x4400, inst: 2 }], ms(900), { more: [B] });
  };
  // Without the check, Note Off leaves a syllable with no coda singing its
  // vowel under the next one — which is what the default is for.
  assert.ok(active(word(0).ts) > 0, "DCT off: the [i] sings on");
  assert.equal(active(word(2).ts), 0, "DCT Sample: the [i] is gone");
  assert.ok(active(word(2, [0x1000, 0x2000]).ts) > 0, "…but not for an instrument made from another range");
  // A coda being spoken is not the vowel: it is left to finish.
  const timing = 192;                    // twice as slow: [n]'s coda takes 270 ms
  const A = formantRecord({ slots: [0, 0, id("n")], timing }, { dct: 2 });
  const B = formantRecord({ slots: [id("s"), 0, 0] }, { dct: 2 });
  const seen = {};
  render(A, [{ row: 0, note: 0x4000, inst: 1 }, { row: 3, note: 0x0001 }, { row: 4, note: 0x4400, inst: 2 }], ms(900), {
    more: [B],
    at: [[520, (eng) => { seen.mid = active(eng.playheads[0].trackerState); }],
         [800, (eng) => { seen.end = active(eng.playheads[0].trackerState); }]],
  });
  assert.equal(seen.mid, 1, "the [n] coda, started at 360 ms, still speaks after the next syllable at 480 ms");
  assert.equal(seen.end, 0, "…and ends the note itself");
});

test("a note that starts ahead of a quiet loop is held to the level by the louder stretch it plays", () => {
  // The record plays from byte 0: 6400 bytes of full-scale body, then the
  // quiet loop. Gain and harmonics come from the loudest stretch played —
  // here the body — so the body sings at the level, not 24 dB over it.
  const fromStart = buildFormantRecord(patchBytes({ src: TAILED, front: 255, open: 0 }), { ...TAILED, playStart: 0 });
  const fromLoop = buildFormantRecord(patchBytes({ src: TAILED, front: 255, open: 0 }), { ...TAILED, playStart: TAILED.loopStart });
  const saw = db(rms(render(formantRecord({ front: 255, open: 0 }), [{ row: 0, note: 0x5000, inst: 1 }], ms(400)).res, 100, 400));
  const { res, ts } = render(fromStart, [{ row: 0, note: 0x5000, inst: 1 }], ms(400));
  // At C4 the 6400-byte body lasts 6400 ÷ 33488 Hz = 191 ms.
  assert.ok(Math.abs(db(rms(res, 40, 180)) - saw) < 1, `body ${db(rms(res, 40, 180)).toFixed(2)} vs ${saw.toFixed(2)} dB`);
  assert.ok(ts.voices[0].formant.sg < 1.1, `source gain ${ts.voices[0].formant.sg.toFixed(2)}, set by the body`);
  // From its loop, the same source is the quiet loop lifted to the level.
  const loop = render(fromLoop, [{ row: 0, note: 0x5000, inst: 1 }], ms(400));
  assert.ok(loop.ts.voices[0].formant.sg > 12, "the quiet loop alone is lifted ~24 dB");
  assert.ok(Math.abs(db(rms(loop.res, 100, 400)) - saw) < 1.5, `${db(rms(loop.res, 100, 400)).toFixed(2)} dB`);
});

test("R: an r-coloured vowel takes [ɝ]'s F3 — [ə] r-coloured is Hillenbrand's [ɝ] — and a front vowel is drawn back", () => {
  const V = new Float64Array(5);
  F.vowelFormants(128, 128, 0, V, true);
  assert.deepEqual([...V].slice(1, 4).map(Math.round), [1379, 1711, 3335], "[ɚ]: Hillenbrand's [ɝ] F2 F3 F4");
  const plain = F.vowelFormants(128, 128, 0, new Float64Array(5));
  assert.equal(V[0], plain[0], "F1 is the vowel's own");
  F.vowelFormants(255, 0, 0, V, true);
  assert.equal(Math.round(V[2]), 1711);
  assert.ok(V[1] <= (1711 * 1379) / 1711 + 1e-9, "[i] r-coloured: F2 under F3 in [ɝ]'s proportion");
  F.vowelFormants(0, 0, 255, V, true);
  assert.equal(Math.round(V[1]), 595, "[u]'s F2 is already under it");
  // In the tract: F3 at [ɝ]'s for the size, and an edit to the record is
  // heard on a sounding note.
  const set = (on) => (eng) => {
    const inst = eng.instruments[1];
    inst.setByte(F.FORMANT_BLOCK_START + F.FB_GR, on ? 0x80 : 0);
  };
  const seen = {};
  render(formantRecord({ front: 128, open: 128 }), [{ row: 0, note: 0x4000, inst: 1 }], ms(700), {
    at: [[200, (eng) => { seen.before = eng.playheads[0].trackerState.voices[0].formant.F[2]; set(true)(eng); }],
         [400, (eng) => { seen.after = eng.playheads[0].trackerState.voices[0].formant.F[2]; }]],
  });
  assert.equal(Math.round(seen.before), 2500);
  assert.equal(Math.round(seen.after), 1711);
});

test("G: a glide starts on its semivowel's vowel and moves into the syllable's — after the onset, in its voicing", () => {
  const C2 = (st) => [Math.round(st.F[0]), Math.round(st.F[1])];
  const trace = (rec) => {
    const at = {};
    const hook = (t) => [t, (eng) => { at[t] = { F: Float64Array.from(eng.playheads[0].trackerState.voices[0].formant.F),
      av: eng.playheads[0].trackerState.voices[0].formant.av, ph: eng.playheads[0].trackerState.voices[0].formant.phase }; }];
    render(rec, [{ row: 0, note: 0x4000, inst: 1 }], ms(500), { at: [hook(15), hook(250), hook(70)] });
    return at;
  };
  const a = F.vowelFormants(200, 255, 0, new Float64Array(5));
  for (const sv of F.SEMIVOWELS.slice(1)) {
    const g = trace(formantRecord({ semivowel: sv.code }));
    const v = F.vowelFormants(sv.front, sv.open, sv.round, new Float64Array(5));
    assert.deepEqual(C2({ F: g[15].F }), [Math.round(v[0]), Math.round(v[1])], `[${sv.ipa}] starts on [${sv.vowel}]`);
    assert.ok(Math.abs(g[15].av - 0.4) < 1e-9, `[${sv.ipa}] in the approximant's voicing`);
    assert.deepEqual(C2({ F: g[250].F }), [Math.round(a[0]), Math.round(a[1])], `…and reaches [a]`);
  }
  // With an onset consonant the glide waits for it: [k] first, then [w].
  const kw = trace(formantRecord({ semivowel: 4, slots: [id("k"), 0, 0] }));
  assert.equal(kw[15].ph, F.PHASE_ONSET, "the [k] is still being said at 15 ms");
  assert.ok(kw[70].F[1] < 900, `then the [w]: F2 ${Math.round(kw[70].F[1])} Hz`);
  // The editor spells it.
  const inst = new TaudInst(1);
  inst.loadRecord(formantRecord({ semivowel: 4, rhotic: true, slots: [id("k"), 0, id("n")] }));
  assert.equal(formantSyllable(inst), "kwa\u02DEn");
  inst.loadRecord(formantRecord({ front: 128, open: 128, semivowel: 1, rhotic: true }));
  assert.equal(formantSyllable(inst), "jɚ");
});

test("a consonant's tract is normalised as it stands: a nasal coda after a tuned [i] does not ring over the vowel", () => {
  // At C4 the [i]'s F1 is tuned onto the fundamental; its [ɴ] coda sweeps F1
  // up across the second harmonic and opens the nasal pole — a tract far
  // louder than the vowel's, which the vowel's correction alone let through.
  for (const [coda, src] of [["ɴ", H2SRC], ["n", H2SRC], ["m", SAW], ["l", SAW]]) {
    const rec = formantRecord({ front: 255, open: 0, slots: [0, 0, id(coda)], src });
    const { res } = render(rec, [{ row: 0, note: 0x5000, inst: 1 }, { row: 4, note: 0x0001 }], ms(800));
    let vp = 0, cp = 0;
    for (let i = ms(200); i < ms(470); i++) vp = Math.max(vp, Math.abs(res[i]));
    for (let i = ms(480); i < ms(700); i++) cp = Math.max(cp, Math.abs(res[i]));
    assert.ok(cp < vp * 1.3, `[${coda}] coda peak ${cp.toFixed(3)} vs vowel ${vp.toFixed(3)}`);
    assert.ok(rms(res, 480, 700) < rms(res, 200, 470), `[${coda}] coda quieter than the vowel`);
  }
  // …and a nasal onset enters its vowel without a burst.
  const { res } = render(formantRecord({ front: 255, open: 0, slots: [id("m"), 0, 0] }), [{ row: 0, note: 0x5000, inst: 1 }], ms(600));
  let op = 0, vp = 0;
  for (let i = 0; i < ms(200); i++) op = Math.max(op, Math.abs(res[i]));
  for (let i = ms(300); i < ms(600); i++) vp = Math.max(vp, Math.abs(res[i]));
  assert.ok(op < vp * 1.3, `[m] onset peak ${op.toFixed(3)} vs vowel ${vp.toFixed(3)}`);
});

test("S $Afgr does nothing on an ordinary instrument", () => {
  const a = render(plainRecord(SAW), [{ row: 0, note: 0x4000, inst: 1 }], ms(300)).res;
  const b = render(plainRecord(SAW), [{ row: 0, note: 0x4000, inst: 1, fx: S_FX, arg: 0xa0f0 }], ms(300)).res;
  assert.deepEqual([...a], [...b]);
});

test("Q retriggers the syllable, onset and all", () => {
  const rec = formantRecord({ slots: [id("s"), 0, 0] });
  const Q = 0x1a; // effect opcode Q
  const { res } = render(rec, [{ row: 0, note: 0x4000, inst: 1 }, { row: 3, fx: Q, arg: 0x0300 }], ms(1000), { tick: 12 });
  // Q $0300 retriggers on ticks 3, 6 and 9 of the row (every 60 ms from 780
  // ms): each restarts the /s/, so the row goes back to its quieter hiss.
  const row3 = 3 * 12 * 20;
  assert.ok(rms(res, row3 + 75, row3 + 110) < rms(res, row3 - 60, row3 - 5) * 0.8);
});

test("rendering is deterministic", () => {
  const rec = formantRecord({ slots: [id("k"), id("w"), id("t͡ʃ")] });
  const cells = [{ row: 0, note: 0x4400, inst: 1 }, { row: 3, note: 0x0001 }];
  const a = render(rec, cells, ms(700)).res, b = render(rec, cells, ms(700)).res;
  assert.deepEqual([...a], [...b]);
});

test("every consonant in the table onsets and codas without a step in its tracks", () => {
  for (const r of F.CONSONANT_LIST) {
    for (const first of [true, false]) {
      const t = F.onsetTracks(r, first, { av: 1, ah: 0, af: 0, nz: 0 }, 1);
      for (const k of ["w", "av", "ah", "af", "nz"]) {
        const tr = t[k];
        for (let i = 2; i < tr.length; i += 2) assert.ok(tr[i] >= tr[i - 2], `${r.ipa} ${k} times run forward`);
        assert.equal(tr[tr.length - 1], k === "w" ? 0 : k === "av" ? 1 : 0, `${r.ipa} ${k} ends on the vowel`);
      }
      assert.ok(t.end > 0 || r.manner === F.MANNER_GLOTTAL);
    }
    const c = F.codaTracks(r, 1);
    for (const k of ["av", "ah", "af"]) assert.equal(c[k][c[k].length - 1], 0, `${r.ipa} coda ${k} ends silent`);
    assert.equal(c.av[1], 1, `${r.ipa} coda starts at the vowel`);
  }
  assert.equal(F.CONSONANT_LIST.length, new Set(F.CONSONANT_LIST.map((r) => r.id)).size, "ids are unique");
  assert.ok(F.CONSONANT_LIST.every((r) => r.id > 0 && r.id < 112));
});

// ── the recipe machine ───────────────────────────────────────────────────

function pool() {
  const bin = new Uint8Array(SAMPLEBIN_SIZE).fill(128);
  fillPool(bin);
  return bin;
}
const CANDS = [
  { ...SAW, index: 0, name: "saw" },
  { ...NOISE, index: 1, name: "noise" },
  { ...SQUARE, index: 2, name: "square" },
];

test("the machine ranks a sawtooth first as a source, and tunes it to middle C", () => {
  const m = new FormantMachine(pool(), CANDS);
  const s = m.sources();
  assert.equal(s[0].cand.name, "saw");
  assert.ok(Math.abs(s[0].hz - C4_HZ) < 1, `${s[0].hz} Hz`);
  assert.ok(Math.abs(s[0].c4Rate / SAW.rate - 1) < 1e-3, `${s[0].c4Rate}`);
  assert.ok(s[0].badness < 0.5);
});

test("the machine offers the noise generator first, makes /s/ from noise rather than a pitched sample, and brings it to the generator's level", () => {
  const m = new FormantMachine(pool(), CANDS);
  const r = m.recipes(id("s"));
  assert.equal(r[0].generator, true, "the generator, white, is the flattest noise there is");
  assert.equal(r[0].badness, 0);
  assert.deepEqual(slotFromRecipe(id("s"), r[0]), { cons: id("s"), ptr: 0, len: 0, offset: 0, rate: 0, tilt: 0, gain: 0 });
  const samples = r.filter((x) => x.cand);
  assert.equal(samples[0].cand.name, "noise");
  assert.ok(samples[0].badness < 0.5, `noise: ${samples[0].badness}`);
  // The gain is what brings the sample's level to the generator's (heard
  // through the engine in the generator's test above): the same noise 6 dB
  // down is given 6 dB more.
  const half = new FormantMachine(pool(), [{ ...HALF_NOISE, index: 0, name: "half" }]).recipes(id("s"))
    .find((x) => x.cand && x.offset === samples[0].offset && x.rate === samples[0].rate && x.tilt === samples[0].tilt);
  const lift = db(META_MIX_GAIN[half.gain]) - db(META_MIX_GAIN[samples[0].gain]);
  assert.ok(Math.abs(lift - 6.02) < 0.6, `${lift.toFixed(2)} dB`);
  const sq = samples.find((x) => x.cand.name === "square");
  assert.ok(!sq || sq.badness > samples[0].badness + 1, "the square is a poor /s/");
  for (let i = 1; i < r.length; i++) assert.ok(r[i].badness >= r[i - 1].badness, "best first");
  // A stop wants a click, which the generator has not: a little badness.
  assert.ok(m.recipes(id("t")).find((x) => x.generator).badness > 0);
  assert.equal(m.recipes(id("m"))[0].cand, null, "a nasal needs no noise");
  assert.equal(m.recipes(id("m"))[0].generator, false);
  assert.equal(m.recipes(id("m"))[0].badness, 0);
  const best = m.bestPerConsonant();
  assert.equal(best.get(id("l")), 0);
  assert.ok(F.CONSONANT_LIST.every((c) => best.get(c.id) < 0.5), "with the generator, every consonant can be made");
  const none = new FormantMachine(pool(), []).bestPerConsonant();
  assert.ok(F.CONSONANT_LIST.every((c) => Number.isFinite(none.get(c.id))), "…even from an empty range");
  assert.equal(gainOctet(1), 159, "unity is octet 159");
});

// ── the editor's view of the record ─────────────────────────────────────

function project(samples = [SAW, NOISE, SQUARE]) {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  fillPool(image);
  const put = (slot, rec) => image.set(rec, SAMPLEBIN_SIZE + slot * 256);
  samples.forEach((smp, i) => put(i + 1, plainRecord(smp)));
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  const doc = new Document({
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
  doc.undo = new UndoStack(doc);
  return doc;
}

function withFormant() {
  const doc = project();
  const census = doc.sampleList();
  const [lo, hi] = spanOf(census);
  const m = new FormantMachine(doc.sampleBin, rangeCandidates(doc, lo, hi));
  const src = m.sources()[0];
  const plan = planCreateOpl(doc, defaultFormantRecord(src.cand, src.c4Rate, lo, hi), "Formant");
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(importBankOp(plan));
  const slot = plan.metaSlot;
  const s = m.recipes(id("s")).find((r) => r.cand);   // a sample's, so the record holds a noise pointer
  doc.undo.apply(setInstBytesOp(slot, formantSlotBytes(0, slotFromRecipe(id("s"), s))));
  return { doc, slot, m, src };
}

test("a new formant instrument sings [a] on the best source, in a range covering the pool", () => {
  const { doc, slot } = withFormant();
  const inst = doc.instruments[slot];
  assert.ok(inst.isFormant);
  assert.equal(inst.samplePtr, SAW.ptr);
  assert.equal(inst.formant.rangeLo, SAW.ptr);
  assert.equal(inst.formant.rangeHi, NOISE.ptr + NOISE.len > SQUARE.ptr + SQUARE.len ? NOISE.ptr + NOISE.len : SQUARE.ptr + SQUARE.len);
  assert.equal(nearestVowelMark(inst.formant.front, inst.formant.open, inst.formant.round).ipa, "a");
  assert.equal(formantSyllable(inst), "sa");
  assert.equal(inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8), 0, "no fadeout");
  assert.equal(inst.newNoteAction, 0, "New Note Action: Note Off");
  assert.equal(inst.duplicateCheckType, 2, "Duplicate Check: Sample…");
  assert.equal(inst.duplicateCheckAction, 0, "…→ Note Cut");
  assert.equal(inst.formant.slots[0].ptr, NOISE.ptr);
});

test("the census counts a consonant's noise as the formant instrument's sample", () => {
  const { doc, slot } = withFormant();
  const e = doc.sampleList().find((x) => x.ptr === NOISE.ptr && x.len === NOISE.len);
  assert.ok(e.users.includes(slot) && e.users.includes(2));
  doc.undo.apply(setInstBytesOp(slot, formantVowelBytes(255, 0, 0)));
  assert.equal(doc.instruments[slot].formant.front, 255);
});

test("defragmenting the pool moves a formant instrument's pointers and leaves its header alone", () => {
  const { doc, slot } = withFormant();
  // Free the saw's neighbour so the pool has a hole below the noise.
  doc.undo.apply(cleanupBankOp(planDeleteSample(doc, doc.sampleList().find((e) => e.ptr === SQUARE.ptr))));
  const before = doc.instRecordBytes(slot);
  const plan = planPoolDefrag(doc);
  assert.ok(!plan.error, plan.error);
  if (!plan.noop) doc.undo.apply(importBankOp(plan));
  const after = doc.instRecordBytes(slot);
  assert.deepEqual([...after.subarray(0, 4)], [...FORMANT_RECORD_HEADER]);
  const spans = formantRecordSpans(after);
  for (const sp of spans) {
    const e = doc.sampleList().find((x) => x.ptr === sp.ptr && x.len === sp.len);
    assert.ok(e, `span ${sp.role} still names a census sample`);
  }
  assert.equal(formantRecordSpans(before).length, spans.length);
  const inst = doc.instruments[slot];
  const noise = doc.sampleBin.subarray(inst.formant.slots[0].ptr, inst.formant.slots[0].ptr + 64);
  const want = new Uint8Array(SAMPLEBIN_SIZE); fillPool(want);
  assert.deepEqual([...noise], [...want.subarray(NOISE.ptr, NOISE.ptr + 64)], "the bytes moved with the pointer");
});

test("deleting a sample a consonant sounds clears the consonant's noise, not the record's header", () => {
  const { doc, slot } = withFormant();
  const noise = doc.sampleList().find((e) => e.ptr === NOISE.ptr);
  doc.undo.apply(cleanupBankOp(planDeleteSample(doc, noise)));
  const inst = doc.instruments[slot];
  assert.ok(inst.isFormant, "still a formant instrument");
  assert.equal(inst.formant.slots[0].cons, id("s"), "the consonant stays");
  assert.equal(inst.formant.slots[0].len, 0, "its noise is gone");
  assert.equal(inst.samplePtr, SAW.ptr, "the source is untouched");
});

test("importing a formant instrument into another project brings its noise with it", () => {
  const { doc, slot } = withFormant();
  const dest = project();
  // Make the destination's pool different, so nothing dedupes by accident.
  dest.sampleBin.fill(7, NOISE.ptr, NOISE.ptr + NOISE.len);
  const plan = planImport(dest, doc, [slot]);
  assert.ok(!plan.error, plan.error);
  dest.undo.apply(importBankOp(plan));
  const to = plan.slotMap.get(slot);
  const inst = dest.instruments[to];
  assert.ok(inst.isFormant);
  const s = inst.formant.slots[0];
  const want = new Uint8Array(SAMPLEBIN_SIZE); fillPool(want);
  assert.deepEqual([...dest.sampleBin.subarray(s.ptr, s.ptr + 256)], [...want.subarray(NOISE.ptr, NOISE.ptr + 256)]);
  assert.deepEqual([...dest.sampleBin.subarray(inst.samplePtr, inst.samplePtr + SAW.len)],
    [...want.subarray(SAW.ptr, SAW.ptr + SAW.len)], "and its source, deduped onto the destination's own saw");
});

test("a recording loaded into the pool is material: the machine cuts windows out of it", () => {
  // One ordinary instrument (the square) and a 10-second recording no
  // instrument claims — hiss, a quiet gap, a buzzy 150 Hz tone — as region R00.
  const doc = project([SQUARE]);
  const reg = { ptr: 0x40000, len: 220500, rate: 22050, chan: 1, name: "take 1" };
  let x = 0x2468ace1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x / 4294967296) * 2 - 1; };
  for (let i = 0; i < reg.len; i++) {
    const sec = (i % 110250) / 22050;
    let v = 0.01 * rnd();
    if (sec < 1) v = 0.6 * rnd();
    else if (sec >= 2 && sec < 4) v = 0.7 * (2 * (((sec - 2) * 150) % 1) - 1);
    doc.sampleBin[reg.ptr + i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * v)));
  }
  doc.projSections.push({ fourcc: "SRgn", payload: buildRegionPayload([reg]) });
  const [lo, hi] = poolSpan(doc);
  assert.equal(hi, reg.ptr + reg.len, "all samples includes the recording");
  const material = rangeCandidates(doc, lo, hi);
  assert.ok(material.some((c) => c.region && c.ri === 0));
  assert.ok(!rangeCandidates(doc, ...spanOf(doc.sampleList())).some((c) => c.region),
    "a range that leaves the recording out does not see it");
  const m = new FormantMachine(doc.sampleBin, material);
  const windows = m.cands.filter((c) => c.kind);
  assert.ok(windows.every((w) => w.len <= 65535 && w.ptr >= reg.ptr && w.ptr + w.len <= reg.ptr + reg.len));
  assert.ok(windows.some((w) => w.kind === "noise") && windows.some((w) => w.kind === "tone"));
  const src = m.sources()[0];
  assert.match(src.cand.label, /^R00 @/, "the best source is a window of the recording");
  assert.equal(src.cand.loopMode, 1, "…looped by the loop finder");
  assert.ok(src.cand.loopEnd > src.cand.loopStart);
  assert.ok(Math.abs(src.hz - 150) < 1, `${src.hz} Hz`);
  const s = m.recipes(id("s")).find((r) => r.cand);
  assert.match(s.cand.label, /^R00 @/, "and its hiss the best sampled /s/");
  assert.ok(s.badness < 0.5);
  // Taking them makes the windows samples of the census, this instrument's.
  const plan = planCreateOpl(doc, defaultFormantRecord(src.cand, src.c4Rate, lo, hi), "Formant");
  doc.undo.apply(importBankOp(plan));
  doc.undo.apply(setInstBytesOp(plan.metaSlot, formantSlotBytes(0, slotFromRecipe(id("s"), s))));
  const census = doc.sampleList();
  for (const w of [src.cand, s.cand]) {
    const e = census.find((c) => c.ptr === w.ptr && c.len === w.len);
    assert.ok(e && e.users.includes(plan.metaSlot), `${w.label} is in the census`);
  }
  assert.equal(doc.instruments[plan.metaSlot].sampleLoopEnd, src.cand.loopEnd);
  // A range over part of the recording uses that part: seconds 2…4, the tone.
  const part = rangeCandidates(doc, reg.ptr + 2 * 22050, reg.ptr + 4 * 22050).find((c) => c.region);
  assert.deepEqual([part.ptr, part.len, part.base], [reg.ptr + 2 * 22050, 2 * 22050, reg.ptr]);
  const pm = new FormantMachine(doc.sampleBin, [part]);
  assert.ok(pm.cands.length > 0 && pm.cands.every((c) => c.ptr >= part.ptr && c.ptr + c.len <= part.ptr + part.len));
  assert.ok(pm.cands.every((c) => Number(c.label.slice(5, -2)) >= 2), "labelled in the recording's own seconds");
  // …and a new machine over the same range names them by where they came from.
  const again = new FormantMachine(doc.sampleBin, rangeCandidates(doc, lo, hi));
  assert.match(again.cands.find((c) => c.ptr === s.cand.ptr && c.len === s.cand.len).label, /^R00 @/);
});

test("the source is chosen for the vowel: a recording of sung vowels gives each its own", () => {
  // A 150 Hz sawtooth sung through [i], then [a], then [u], two seconds each,
  // loaded as a recording. Choosing the source for a vowel picks a loop in the
  // stretch that sings it — and the pitch is found at 150 Hz, not the octave
  // below a strongly resonant [a] used to pass for.
  const doc = project([SQUARE]);
  const rate = 22050;
  const reg = { ptr: 0x40000, len: rate * 6, rate, chan: 1, name: "aiu" };
  const mark = (ipa) => VOWEL_MARKS.find((v) => v.ipa === ipa);
  const sung = new Float64Array(reg.len);
  let ph = 0;
  ["i", "a", "u"].forEach((ipa, k) => {
    const m = mark(ipa);
    const V = new Float64Array(5), B = new Float64Array(5);
    F.vowelAtPitch(m.front, m.open, m.round, 150, 150, 0, V, B);
    const rs = [4, 3, 2, 1, 0].map((n) => {
      const r = Math.exp((-Math.PI * B[n]) / rate), c = -r * r, b = 2 * r * Math.cos((2 * Math.PI * V[n]) / rate);
      return { A: 1 - b - c, b, c, y1: 0, y2: 0 };
    });
    for (let i = k * rate * 2; i < (k + 1) * rate * 2; i++) {
      ph = (ph + 150 / rate) % 1;
      let x = 2 * ph - 1;
      for (const q of rs) { const y = q.A * x + q.b * q.y1 + q.c * q.y2; q.y2 = q.y1; q.y1 = y; x = y; }
      sung[i] = x;
    }
  });
  let peak = 0;
  for (const v of sung) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < reg.len; i++) doc.sampleBin[reg.ptr + i] = Math.round(127.5 + (120 * sung[i]) / peak);
  doc.projSections.push({ fourcc: "SRgn", payload: buildRegionPayload([reg]) });
  const m = new FormantMachine(doc.sampleBin, rangeCandidates(doc, ...poolSpan(doc)));
  const secOf = (c) => (c.ptr + (c.loopStart + c.loopEnd) / 2 - reg.ptr) / rate;
  for (const [ipa, from, to] of [["i", 0, 2], ["a", 2, 4], ["u", 4, 6]]) {
    const v = mark(ipa);
    const best = m.bestSource({ front: v.front, open: v.open, round: v.round, track: 64, refNote: 0x4000 });
    const at = secOf(best.cand);
    assert.ok(at >= from && at < to, `[${ipa}]: the loop sits at ${at.toFixed(2)} s`);
    assert.ok(Math.abs(best.hz - 150) < 1, `[${ipa}]: ${best.hz} Hz`);
    assert.ok(Math.abs(best.c4Rate - Math.round((rate / 150) * 261.6255653005986)) <= 2);
  }
  // Each vowel on its own loop — loops of different levels and very
  // different spectra (a recorded [i] is nothing like a sawtooth) — sings at
  // the one level, at every pitch. A looped source plays from its loop.
  // Each source is calibrated by its RMS; the tract then keeps its loudness —
  // so each note is as loud as its own loop played plainly at that RMS.
  for (const note of [0x4000, 0x5000, 0x6000]) {
    for (const ipa of ["i", "a", "u"]) {
      const v = mark(ipa);
      const best = m.bestSource({ front: v.front, open: v.open, round: v.round, track: 64, refNote: 0x4000 });
      const rec = defaultFormantRecord(best.cand, best.c4Rate, ...poolSpan(doc));
      for (const [o, b] of formantVowelBytes(v.front, v.open, v.round)) rec[o] = b;
      const inst = new TaudInst(1);
      inst.loadRecord(rec);
      assert.equal(inst.samplePlayStart, best.cand.loopStart, "the source plays from its loop");
      const r = render(rec, [{ row: 0, note, inst: 1 }], ms(450), { bin: doc.sampleBin });
      const got = loudDb(r.res, 100, 450, noteF0(note));
      // The loop itself, played plainly and brought by the same source gain:
      // the tract neither adds nor takes loudness.
      const L = best.cand.loopEnd - best.cand.loopStart;
      const plainRec = plainRecord({ ptr: best.cand.ptr + best.cand.loopStart, len: L, rate: best.c4Rate, loopEnd: L, loopMode: 1 });
      const p = render(plainRec, [{ row: 0, note, inst: 1 }], ms(450), { bin: doc.sampleBin }).res;
      const plain = loudDb(p, 100, 450, noteF0(note)) + db(r.ts.voices[0].formant.sg);
      assert.ok(Math.abs(got - plain) < 0.6, `[${ipa}] at $${note.toString(16)}: ${got.toFixed(2)} vs ${plain.toFixed(2)} dB`);
    }
  }
});

test("a sample looped in its quiet tail is offered looped in its body, and a quiet loop costs", () => {
  const m = new FormantMachine(pool(), [{ ...TAILED, index: 0, name: "tailed" }]);
  const all = m.sources();
  const tail = all.find((s) => !s.cand.relooped), body = all.find((s) => s.cand.relooped);
  assert.ok(body, "a re-looped candidate exists");
  assert.ok(body.cand.loopEnd <= 6400 + 1024 && body.cand.loopEnd - body.cand.loopStart >= 16, `loop ${body.cand.loopStart}–${body.cand.loopEnd}, in the body`);
  assert.ok(tail.badness - body.badness > 1, `tail ${tail.badness.toFixed(2)} vs body ${body.badness.toFixed(2)}`);
  assert.equal(all[0], body, "and the body is chosen");
  // Written as a record, it plays from its loop.
  const rec = defaultFormantRecord(body.cand, body.c4Rate, 0, 0);
  assert.equal(rec[8] | (rec[9] << 8), body.cand.loopStart);
});

test("a periodic sample that does not loop is given a loop as a source; noise is not", () => {
  const hum = { ptr: 0x30000, len: 22050, rate: 22050, loopStart: 0, loopEnd: 0, loopMode: 0, index: 0, name: "hum" };
  const bin = pool();
  for (let i = 0; i < hum.len; i++) bin[hum.ptr + i] = Math.round(127.5 + 100 * (2 * (((i * 110) / 22050) % 1) - 1));
  const s = new FormantMachine(bin, [hum]).bestSource();
  assert.equal(s.cand.loopMode & 3, 1);
  assert.ok(s.cand.autoLoop && s.cand.loopEnd - s.cand.loopStart >= 16);
  assert.equal(hum.loopMode, 0, "the census entry itself is left alone");
  const n = new FormantMachine(pool(), [{ ...NOISE, index: 1, name: "noise" }]).bestSource();
  assert.equal(n.cand.loopMode & 3, 0, "a noise is not looped into a fake tone");
});
