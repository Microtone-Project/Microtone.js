// Item 212 — Metainstrument type 1: the formant instrument.
//
// What is pinned here: (1) the record — an ordinary instrument whose header
// says "type 1", whose sample is the glottal source with its pointer in the
// tract block, and whose second pitch/filter slot is that block; (2) the
// chart and the pitch rules — Catford's cardinal vowels where the chart puts
// them, R1 tuned onto f0 by opening the jaw; (3) the sound — formants where the
// chart says, the level of the source at every pitch, consonants before the
// vowel and the coda only on a key-off; (4) the recipe machine's ranking; (5)
// the pool tools, which have to know every pointer a type-1 record holds.

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

const C4_HZ = 261.6255653005986;
const id = (ipa) => F.CONSONANT_LIST.find((r) => r.ipa === ipa).id;

// ── material ─────────────────────────────────────────────────────────────

/** A one-cycle sawtooth (the textbook glottal source), a white noise, and a
 *  pitched square, written into a pool. */
const SAW = { ptr: 0x1000, len: 128, rate: Math.round(128 * C4_HZ), loopStart: 0, loopEnd: 128, loopMode: 1 };
const NOISE = { ptr: 0x2000, len: 22050, rate: 22050, loopStart: 0, loopEnd: 0, loopMode: 0 };
const SQUARE = { ptr: 0x8000, len: 8000, rate: 16000, loopStart: 0, loopEnd: 0, loopMode: 0 };
function fillPool(bin) {
  for (let i = 0; i < SAW.len; i++) bin[SAW.ptr + i] = Math.round((255 * i) / (SAW.len - 1));
  let x = 0x12345678;
  for (let i = 0; i < NOISE.len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    bin[NOISE.ptr + i] = 16 + ((x >>> 8) % 224);
  }
  for (let i = 0; i < SQUARE.len; i++) bin[SQUARE.ptr + i] = Math.floor((i * 440 * 2) / 16000) % 2 ? 200 : 56;
}

function patchBytes({ front = 177, open = 255, round = 0, slots = [0, 0, 0], track = 64, timing = 128, glide = 20 } = {}) {
  const p = new F.FormantPatch();
  p.srcPtr = SAW.ptr; p.front = front; p.open = open; p.round = round;
  p.track = track; p.timing = timing; p.glide = glide; p.refNote = 0x4000;
  slots.forEach((c, i) => {
    const s = p.slots[i];
    s.cons = c;
    if (c && F.consonantNeedsNoise(F.CONSONANTS[c])) {
      s.ptr = NOISE.ptr; s.len = NOISE.len; s.offset = 0; s.rate = NOISE.rate;
    }
  });
  return F.encodeFormantBlock(p);
}
const formantRecord = (opts = {}, fields = {}) => buildFormantRecord(patchBytes(opts), SAW, fields);

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

/** Render `cells` on lane 0 with `rec` as instrument 1; the left mix bus. */
function render(rec, cells, frames, { tick = 6 } = {}) {
  const eng = new TaudEngine();
  fillPool(eng.sampleBin);
  eng.uploadInstrument(1, rec);
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
  for (let at = 0; at < frames; at += TRACKER_CHUNK) {
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
  assert.equal(raw[F.FB_RESERVED], 0);
  const q = F.decodeFormantBlock(raw, 0);
  assert.deepEqual({ ...q, slots: null }, { ...p, slots: null });
  assert.deepEqual(q.slots[1], p.slots[1]);
});

// ── the chart and the pitch rules ────────────────────────────────────────

test("the chart runs through Catford's cardinal vowels", () => {
  assert.equal(F.vowelF1(0), 240);
  assert.ok(Math.abs(F.vowelF1(255) - 850) < 1e-9);
  assert.ok(Math.abs(F.vowelF2(255, 240) - 2400) < 1e-9, "[i]");
  assert.ok(Math.abs(F.vowelF2(255, 850) - 1610) < 1e-9, "[a]");
  assert.ok(Math.abs(F.vowelF2(0, 500) - 700) < 1e-9, "[ɔ]");
  assert.ok(Math.abs(F.vowelF2(255, 390) - 2300) < 1e-9, "[e]");
  for (const [f1, f2] of [[300, 1000], [610, 1900], [700, 900], [250, 595]]) {
    const [front, open] = F.vowelCoordsOf(f1, f2);
    assert.ok(Math.abs(F.vowelF1(open) - f1) < 1e-6);
    assert.ok(Math.abs(F.vowelF2(front, F.vowelF1(open)) - f2) < 1e-6);
  }
  const m = (ipa) => VOWEL_MARKS.find((x) => x.ipa === ipa);
  assert.deepEqual([m("i").front, m("i").open, m("i").round], [255, 0, 0]);
  assert.deepEqual([m("u").front, m("u").open, m("u").round], [0, 8, 255]);
  assert.equal(nearestVowelMark(255, 0, 255).ipa, "y", "roundness decides between [i] and [y]");
  const schwa = m("ə");
  assert.equal(nearestVowelMark(schwa.front, schwa.open, 0).ipa, "ə", "the uniform tube, 500/1500 Hz");
  assert.equal(vowelEffectArg(255, 0, 0), 0xa0f0, "S $Afgr for [i]: open 0, front F, round 0");
});

test("roundness is F3: it closes in on F2", () => {
  const V = new Float64Array(5);
  F.vowelFormants(255, 0, 0, V);
  assert.deepEqual([...V].map(Math.round), [240, 2400, 3100, 3500, 4500]);
  F.vowelFormants(255, 0, 255, V);
  assert.equal(Math.round(V[2]), 2650, "[y]: F2 + 250");
  F.vowelFormants(0, 8, 255, V);
  assert.equal(Math.round(V[2]), 2200, "[u]: Klatt's 2200");
});

test("a higher note is a smaller tract, and past F1 the jaw opens", () => {
  const V = new Float64Array(5), B = new Float64Array(5);
  const ref = F.noteHz(0x4000);
  assert.equal(F.vowelAtPitch(177, 255, 0, ref, ref, 64, V, B), 1, "at the reference note, the chart");
  assert.equal(Math.round(V[0]), 850);
  const s = F.vowelAtPitch(177, 255, 0, ref * 16, ref, 64, V, B);
  assert.ok(Math.abs(s - 2) < 1e-12, "four octaves up at k = ¼: twice the size");
  // [u] at C5: F1 is tuned onto f0 and F2 rises with the jaw.
  const s5 = F.vowelAtPitch(0, 8, 255, 523.25, ref, 64, V, B);
  assert.ok(Math.abs(V[0] - 523.25) < 1e-9);
  assert.ok(V[1] > 595 * s5 * 1.05, "a back vowel's F2 rises past its size alone");
  // [i] at C6: F1 on f0, F2 FALLS — the soprano's [i] heard as [ɛ].
  F.vowelAtPitch(255, 0, 0, 1046.5, ref, 64, V, B);
  assert.ok(Math.abs(V[0] - 1046.5) < 1e-9);
  assert.ok(V[1] < 2400 * (1046.5 / ref) ** 0.25, "a front vowel's F2 falls");
  for (let n = 1; n < 5; n++) assert.ok(V[n] >= V[n - 1] * 1.15 - 1e-9, "the formants stay in order");
  for (let n = 0; n < 5; n++) assert.ok(B[n] >= 50 && Math.abs(B[n] - Math.max(V[n] / 10, 50)) < 1e-9);
  F.vowelAtPitch(177, 255, 0, ref * 4, ref, 0, V, B);
  assert.equal(Math.round(V[1]), 1300, "track 0: one size at every pitch below F1");
});

// ── the sound ────────────────────────────────────────────────────────────

/** Each of F1…F3 within one harmonic of the strongest peaks of the sound. */
function assertFormants(a, t0, f0, front, open, round) {
  const want = F.vowelFormants(front, open, round, new Float64Array(5)).slice(0, 3);
  const got = harmonicPeaks(a, t0, f0);
  want.forEach((f, i) => assert.ok(Math.abs(got[i] - f) < f0, `F${i + 1} ${f.toFixed(0)} Hz, peak at ${got[i].toFixed(0)}`));
}

test("a sung vowel's formants are where the chart puts them", () => {
  for (const [front, open, round] of [[177, 255, 0], [255, 0, 0], [80, 120, 0]]) {
    const { res } = render(formantRecord({ front, open, round }), [{ row: 0, note: 0x4000, inst: 1 }], ms(800));
    assertFormants(res, 300, 130.8128, front, open, round);
  }
});

test("the tract sets the timbre, not the level: a sawtooth comes out at its own level at every pitch", () => {
  const level = (rec, note) => db(rms(render(rec, [{ row: 0, note, inst: 1 }], ms(450)).res, 100, 450));
  for (const note of [0x3000, 0x4000, 0x5000, 0x6000, 0x7000]) {
    const plain = level(plainRecord(SAW), note);
    for (const [front, open, round] of [[177, 255, 0], [255, 0, 0], [0, 6, 255]]) {
      const got = level(formantRecord({ front, open, round }), note);
      assert.ok(Math.abs(got - plain) < 0.6, `note $${note.toString(16)}: ${got.toFixed(2)} vs ${plain.toFixed(2)} dB`);
    }
  }
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

test("the machine makes /s/ from noise, not from a pitched sample, and matches its level", () => {
  const m = new FormantMachine(pool(), CANDS);
  const r = m.recipes(id("s"), CANDS[0]);
  assert.equal(r[0].cand.name, "noise");
  assert.ok(r[0].badness < 0.5, `noise: ${r[0].badness}`);
  const sq = r.find((x) => x.cand.name === "square");
  assert.ok(!sq || sq.badness > r[0].badness + 1, "the square is a poor /s/");
  for (let i = 1; i < r.length; i++) assert.ok(r[i].badness >= r[i - 1].badness, "best first");
  assert.equal(m.recipes(id("m"), CANDS[0])[0].cand, null, "a nasal needs no noise");
  assert.equal(m.recipes(id("m"), CANDS[0])[0].badness, 0);
  const best = m.bestPerConsonant(CANDS[0]);
  assert.equal(best.get(id("l")), 0);
  assert.ok(best.get(id("ʃ")) < 1);
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
  const s = m.recipes(id("s"), src.cand)[0];
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
  assert.equal(nearestVowelMark(inst.formant.front, inst.formant.open, inst.formant.round).ipa, "ɐ");
  assert.equal(formantSyllable(inst), "sɐ");
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
  const s = m.recipes(id("s"), src.cand)[0];
  assert.match(s.cand.label, /^R00 @/, "and its hiss the best /s/");
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
