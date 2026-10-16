// Item 209 — Metainstrument type 8: an OPL channel in place of a sample.
//
// What is pinned here: (1) the record — an ordinary instrument whose header
// says "type 8" and whose second pitch/filter envelope slot is the patch; (2)
// the chip — every chip sample of a voice is the IMS Archive core's, bit for
// bit, for two- and four-operator patches and all five rhythm drums (checked
// against that core itself when its repository is beside this one); (3) the
// voice — pitch, the note volume as attenuation, release, and the two ways a
// new note can meet a sounding one: a carried retrigger and an NNA ghost.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../core/engine/constants.js";
import {
  TaudInst, buildOplRecord, META_TYPE_OPL, OPL_RECORD_HEADER,
} from "../../core/engine/inst.js";
import * as O from "../../core/engine/opl.js";

const C4_HZ = 261.6255653005986;

/** A plain sine: a silent modulator and a full-level carrier at ×1. */
const SINE = {
  kind: O.OPL_KIND_2OP,
  ops: [
    { mult: 1, tl: 63, ar: 15, dr: 0, sl: 0, rr: 15, eg: 1 },
    { mult: 1, tl: 0, ar: 15, dr: 0, sl: 0, rr: 8, eg: 1 },
  ],
};

function oplInst(patch, fields = {}) {
  return buildOplRecord(O.encodeOplPatch(patch), fields);
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

/** The left channel of `frames` rendered frames, as floats (pre-dither bus). */
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

const ts0 = (eng) => eng.playheads[0].trackerState;
const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
/** Frequency from upward zero crossings, interpolated. */
function zeroCrossHz(a, from, to) {
  let first = -1, last = -1, n = 0;
  for (let i = from + 1; i < to; i++) {
    if (a[i - 1] < 0 && a[i] >= 0) {
      const t = i - 1 + (-a[i - 1]) / (a[i] - a[i - 1]);
      if (first < 0) first = t; else n++;
      last = t;
    }
  }
  return n > 0 ? (n * SAMPLING_RATE) / (last - first) : 0;
}

// ── tables ───────────────────────────────────────────────────────────────

test("the chip's two ROM tables are their closed forms", () => {
  for (let i = 0; i < 256; i++) {
    assert.equal(O.OPL_LOG_SIN[i], Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256));
    assert.equal(O.OPL_EXP[i], Math.round((2 ** (i / 256) - 1) * 1024));
  }
  assert.equal(O.oplExpand(0), 4084, "full scale is ±4084");
  assert.equal(O.oplExpand(0x1800), 0, "past −96 dB the chip gives up");
});

test("block and F-number follow the register's own ceiling, or Note's", () => {
  // The AdLib driver's middle C: F-number 0x2B2 at block 3.
  const hz = (0x2b2 * O.OPL_RATE) / (1 << 17);
  assert.equal(O.oplBlockFnum(hz, false), (3 << 10) | 0x2b2);
  // Note's middle C sits a block higher, at F-number 343.
  const sopHz = (343 * O.OPL_RATE) / (1 << 16);
  assert.equal(O.oplBlockFnum(sopHz, true), (4 << 10) | 343);
  assert.equal(O.oplBlockFnum(sopHz, false), (3 << 10) | 686);
  assert.equal(O.oplBlockFnum(1e6, false), (7 << 10) | 1023, "clamped at the top");
});

// ── the record ───────────────────────────────────────────────────────────

test("a type-8 record is an ordinary record with the chip where the sample was", () => {
  const rec = oplInst(SINE, { rate: 16726, pan: 0x40, nna: 2, fadeout: 0x123 });
  assert.deepEqual([...rec.subarray(0, 4)], [...OPL_RECORD_HEADER]);
  assert.equal(rec[0] >>> 4, META_TYPE_OPL);
  const inst = new TaudInst(3);
  inst.loadRecord(rec);
  assert.ok(inst.isOpl);
  assert.equal(inst.isMeta, false, "no layer table: the trigger treats it as ordinary");
  assert.equal(inst.samplingRate, 16726);
  assert.equal(inst.defaultPan, 0x40);
  assert.equal(inst.newNoteAction, 2);
  assert.equal(inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8), 0x123);
  assert.equal(inst.pf2EnvLoop, 0, "the second pitch/filter slot is gone");
  assert.equal(inst.opl.kind, O.OPL_KIND_2OP);
  assert.equal(inst.opl.ops[1].tl, 0);
  for (let o = 0; o < 256; o++) assert.equal(inst.getByte(o), rec[o], `byte ${o} round-trips`);
});

test("an edit to the patch block re-decodes in place", () => {
  const inst = new TaudInst(3);
  inst.loadRecord(oplInst(SINE));
  const patch = inst.opl;
  const gen = patch.gen;
  inst.setByte(O.OPL_BLOCK_START + O.OPL_B_OPS + O.OPL_OP_BYTES + 1, 0x10); // carrier TL 16
  assert.equal(inst.opl, patch, "the same object a sounding voice holds");
  assert.ok(patch.gen > gen);
  assert.equal(patch.ops[1].tl, 16);
  inst.setByte(0, 0x00);
  assert.equal(inst.getByte(0), 0x80, "the header is the record's kind, not a field");
  // …and an ordinary record written over it is ordinary again.
  inst.loadRecord(new Uint8Array(256));
  assert.equal(inst.isOpl, false);
});

test("key-scale level is halved in envelope units, as the chip does it", () => {
  // Middle C at block 3, F-number 690: the ROM gives 19 × 0.75 dB = 14.25 dB at
  // KSL 3. KSL 1 is half of it, 7.125 dB — 38 envelope steps — where halving
  // the 0.75 dB count first would give 9 × 0.75 = 6.75.
  const level = (ksl) => {
    const st = new O.OplState();
    const patch = O.decodeOplPatch(O.encodeOplPatch({ ops: [{ mult: 1, ksl, tl: 0 }, { mult: 1 }] }));
    O.oplKeyOn(st, patch, false);
    const hz = (690 * O.OPL_RATE) / (1 << 17);
    O.renderOplVoice({ opl: st, keyOff: false, active: true, currentMixVolume: 1,
      currentPlaybackRate: hz / (SAMPLING_RATE * (C4_HZ / O.OPL_C4_RATE)) }, 0);
    return st.kslAtt[0];
  };
  assert.deepEqual([0, 1, 2, 3].map(level), [0, 38, 19, 76]);
});

test("which operators take the note volume", () => {
  assert.equal(O.oplOutputMask(O.OPL_KIND_2OP, 0, 0), 0b10, "FM: the carrier");
  assert.equal(O.oplOutputMask(O.OPL_KIND_2OP, 1, 0), 0b11, "additive: both");
  assert.equal(O.oplOutputMask(O.OPL_KIND_4OP, 0, 0), 0b1000);
  assert.equal(O.oplOutputMask(O.OPL_KIND_4OP, 1, 1), 0b1101);
  assert.equal(O.oplOutputMask(O.OPL_KIND_HH, 0, 0), 0b1);
});

// ── the voice ────────────────────────────────────────────────────────────

test("an OPL note sounds at its pitch, at the C2SPD's middle C", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, oplInst(SINE));
  eng.uploadInstrument(2, oplInst(SINE, { rate: 16726 }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  const a = renderLeft(eng, 24000);
  assert.ok(Math.abs(zeroCrossHz(a, 4800, 24000) - C4_HZ) < 0.3, "C4 at 8363");
  const eng2 = new TaudEngine();
  eng2.uploadInstrument(2, oplInst(SINE, { rate: 16726 }));
  loadSong(eng2, [{ row: 0, note: 0x5000, inst: 2 }]);
  const b = renderLeft(eng2, 24000);
  assert.ok(Math.abs(zeroCrossHz(b, 4800, 24000) - 2 * C4_HZ) < 0.6, "an octave up at 16726");
});

test("the note volume reaches the carrier as attenuation", () => {
  const level = (vol) => {
    const eng = new TaudEngine();
    eng.uploadInstrument(1, oplInst(SINE));
    loadSong(eng, [{ row: 0, note: 0x5000, inst: 1, vol }]);
    return rms(renderLeft(eng, 12000), 4800, 12000);
  };
  const full = level(63), half = level(32);
  assert.ok(full > 0.01, "it sounds");
  const db = 20 * Math.log10(half / full);
  assert.ok(Math.abs(db - 20 * Math.log10(32 / 63)) < 0.1, `−5.9 dB, got ${db.toFixed(2)}`);
});

test("a key-off releases the operators and the voice ends with them", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, oplInst(SINE));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 2, note: 0x0001 }]);
  const v = ts0(eng).voices[0];
  renderLeft(eng, 4000);
  assert.ok(v.active && v.opl !== null && v.opl.keyed);
  renderLeft(eng, 48000);
  assert.equal(v.opl.keyed, false, "keyed off");
  assert.equal(v.active, false, "release rate 8 is long gone after a second");
});

test("a retrigger the NNA cuts keys the SAME channel on, envelopes where they stand", () => {
  // A slow attack, so the second note's carrier is mid-ramp when it arrives.
  const slow = { kind: O.OPL_KIND_2OP, ops: [SINE.ops[0], { ...SINE.ops[1], ar: 4 }] };
  const eng = new TaudEngine();
  eng.uploadInstrument(1, oplInst(slow, { nna: 1 }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, note: 0x5400, inst: 1 }]);
  const v = ts0(eng).voices[0];
  const ticks = (n) => renderLeft(eng, Math.round(n * SAMPLING_RATE * 2.5 / 125));
  ticks(5.5);
  const state = v.opl;
  const envBefore = state.env[1];
  assert.ok(envBefore < 511 && envBefore > 0, "mid-attack");
  ticks(1);
  assert.equal(v.opl, state, "the same channel");
  assert.ok(v.opl.env[1] <= envBefore, "the attack continued from where it stood");
  assert.equal(ts0(eng).backgroundVoices.length, 0, "no ghost, no crossfade");
});

test("any other New Note Action ghosts the channel, and both keep sounding", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, oplInst(SINE, { nna: 2 }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, note: 0x5400, inst: 1 }]);
  renderLeft(eng, Math.round(7 * SAMPLING_RATE * 2.5 / 125));
  const ts = ts0(eng);
  const ghosts = ts.backgroundVoices.filter((g) => g.active && g.opl !== null);
  assert.equal(ghosts.length, 1);
  assert.notEqual(ghosts[0].opl, ts.voices[0].opl, "the ghost has its own copy");
  assert.equal(ghosts[0].opl.k, ts.voices[0].opl.k, "…on the same chip clock");
});

test("an OPL instrument sounds as a layer and as a rack operator", async () => {
  const { buildMetaRecord, makeMetaLayer, META_TYPE_FM } = await import("../../core/engine/inst.js");
  const eng = new TaudEngine();
  eng.uploadInstrument(0x101, oplInst(SINE));
  eng.uploadInstrument(1, buildMetaRecord([
    makeMetaLayer(0x101, 159, 0, 0, 0xffff, 0, 63),
    makeMetaLayer(0x101, 159, 4096, 0, 0xffff, 0, 63),
  ]));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  const a = renderLeft(eng, 12000);
  assert.ok(rms(a, 4800) > 0.01, "a layered OPL patch sounds");
  assert.equal(ts0(eng).backgroundVoices.filter((v) => v.opl !== null).length, 1, "both layers");
  // A rack's operator may be a channel too (the rack reads it as the chip
  // reads a carrier): alone, the rack is the bare patch at the note's pitch.
  const eng2 = new TaudEngine();
  eng2.uploadInstrument(0x101, oplInst(SINE));
  eng2.uploadInstrument(2, buildMetaRecord([makeMetaLayer(0x101, 159, 0, 0, 0xffff, 0, 63)],
    { type: META_TYPE_FM }));
  loadSong(eng2, [{ row: 0, note: 0x5000, inst: 2 }]);
  const b = renderLeft(eng2, 12000);
  assert.ok(rms(b, 4800) > 0.01, "a rack reads a channel");
  assert.ok(Math.abs(zeroCrossHz(b, 4800, 12000) - C4_HZ) < 1, "at the note's pitch");
});

test("a muted lane's channel is frozen rather than caught up", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, oplInst(SINE));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  renderLeft(eng, 4096);
  const v = ts0(eng).voices[0];
  const k = v.opl.k;
  v.fader = 255;
  renderLeft(eng, 48000);
  assert.equal(v.opl.k, k, "nothing rendered while muted");
  v.fader = 0;
  renderLeft(eng, 128);
  assert.ok(v.opl.k > k + 48000, "back on the playhead's clock");
});

// ── against the reference core ───────────────────────────────────────────
// The IMS Archive's chip (iyagimusic-js, MIT) is the model this one carries
// over; where its repository sits beside this one, every chip sample of a
// random patch must match it to the bit — every KSL setting and every F-number
// from 512 up (below that this engine picks the block itself, a step lower
// than the patch wrote it). The two once differed on the key-scale-rate split
// on NOTE SEL and on the rounding of KSL 1 and 2; the IMS Archive core has
// since taken the hardware's reading of both (2026-10-14).

const REF = new URL("../../../../iyagimusic-js/repo/src/opl/chip.js", import.meta.url);
const haveRef = existsSync(REF);

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 8; };
}
function randomOp(rnd) {
  return { am: rnd() & 1, vib: rnd() & 1, eg: rnd() & 1, ksr: rnd() & 1, mult: rnd() & 15,
    ksl: rnd() & 3, tl: rnd() % 40, ar: 8 + (rnd() & 7), dr: rnd() & 15, sl: rnd() & 15,
    rr: 3 + (rnd() % 13), ws: rnd() & 3 };
}
function writeOp(chip, off, o) {
  chip.write(0x20 + off, (o.am << 7) | (o.vib << 6) | (o.eg << 5) | (o.ksr << 4) | o.mult);
  chip.write(0x40 + off, (o.ksl << 6) | o.tl);
  chip.write(0x60 + off, (o.ar << 4) | o.dr);
  chip.write(0x80 + off, (o.sl << 4) | o.rr);
  chip.write(0xe0 + off, o.ws);
}
/** Run our channel for `n` chip samples from a cold key-on, keying off at `off`. */
function ours(patch, fnum, block, n, off, noise = 1) {
  const st = new O.OplState();
  O.oplKeyOn(st, O.decodeOplPatch(O.encodeOplPatch(patch)), false);
  const hz = (fnum * O.OPL_RATE) / (1 << (20 - block));
  const voice = { opl: st, keyOff: false, active: true, currentMixVolume: 1,
    currentPlaybackRate: hz / (SAMPLING_RATE * (C4_HZ / O.OPL_C4_RATE)) };
  O.renderOplVoice(voice, 0);            // retune, anchor
  O.oplKeyOn(st, st.patch, false);       // …and start over at chip sample 0
  st.noise = noise;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (k === off) O.oplKeyOff(st);
    out[k] = Math.fround(O.oplChipStep(st, k) / 16384);
  }
  return out;
}
const firstMismatch = (a, b) => a.findIndex((x, i) => x !== b[i]);

test("two- and four-operator channels match the reference core bit for bit",
  { skip: !haveRef && "iyagimusic-js is not beside this repository" }, async () => {
    const { OPL2, OPL3 } = await import(REF.href);
    const rnd = lcg(12345);
    for (let trial = 0; trial < 40; trial++) {
      const four = trial >= 28;
      const n = four ? 4 : 2;
      const ops = Array.from({ length: n }, () => randomOp(rnd));
      const fb = rnd() & 7, cntA = rnd() & 1, cntB = rnd() & 1;
      const deepT = rnd() & 1, deepV = rnd() & 1;
      const block = 1 + (rnd() % 6), fnum = 512 + (rnd() % 512);
      const chip = four ? new OPL3() : new OPL2();
      chip.write(0x01, 0x20);
      if (four) { chip.write(0x105, 1); chip.write(0x104, 1); }
      chip.write(0xbd, (deepT << 7) | (deepV << 6));
      [0, 3, 8, 11].slice(0, n).forEach((off, i) => writeOp(chip, off, ops[i]));
      chip.write(0xc0, (fb << 1) | cntA | (four ? 0x30 : 0));
      if (four) chip.write(0xc3, cntB | 0x30);
      const keyed = (on) => {
        chip.write(0xa0, fnum & 0xff); chip.write(0xb0, (on ? 0x20 : 0) | (block << 2) | (fnum >> 8));
        if (four) { chip.write(0xa3, fnum & 0xff); chip.write(0xb3, (on ? 0x20 : 0) | (block << 2) | (fnum >> 8)); }
      };
      const N = 24000, OFF = 16000;
      const ref = new Float32Array(N), refR = new Float32Array(N);
      keyed(true);
      chip.generateStereo(ref, refR, 0, OFF);
      keyed(false);
      chip.generateStereo(ref, refR, OFF, N - OFF);
      const got = ours({ kind: four ? O.OPL_KIND_4OP : O.OPL_KIND_2OP, deepTremolo: !!deepT,
        deepVibrato: !!deepV, feedback: fb, cntA, cntB, ops }, fnum, block, N, OFF);
      assert.equal(firstMismatch(got, ref), -1, `trial ${trial}`);
    }
  });

test("the five rhythm drums match the reference core bit for bit",
  { skip: !haveRef && "iyagimusic-js is not beside this repository" }, async () => {
    const { OPL2 } = await import(REF.href);
    const rnd = lcg(999);
    const KINDS = [[O.OPL_KIND_BD, 0x10], [O.OPL_KIND_SD, 0x08], [O.OPL_KIND_TOM, 0x04],
      [O.OPL_KIND_TC, 0x02], [O.OPL_KIND_HH, 0x01]];
    for (let trial = 0; trial < 25; trial++) {
      const [kind, bit] = KINDS[trial % 5];
      const chip = new OPL2();
      chip.write(0x01, 0x20);
      const op = {};
      for (const k of ["bd1", "bd2", "hh", "sd", "tom", "tc"]) op[k] = { ...randomOp(rnd), ksr: 0 };
      writeOp(chip, 0x10, op.bd1); writeOp(chip, 0x13, op.bd2); writeOp(chip, 0x11, op.hh);
      writeOp(chip, 0x14, op.sd); writeOp(chip, 0x12, op.tom); writeOp(chip, 0x15, op.tc);
      const fb = rnd() & 7, cnt = rnd() & 1;
      chip.write(0xc6, (fb << 1) | cnt);
      const b6 = 2 + (rnd() % 4), f6 = 600 + (rnd() % 400);
      const f7 = 520 + (rnd() % 480), f8 = 520 + (rnd() % 480);
      chip.write(0xa6, f6 & 255); chip.write(0xb6, (b6 << 2) | (f6 >> 8));
      chip.write(0xa7, f7 & 255); chip.write(0xb7, (3 << 2) | (f7 >> 8));
      chip.write(0xa8, f8 & 255); chip.write(0xb8, (3 << 2) | (f8 >> 8));
      chip.write(0xbd, 0x20);
      chip.write(0xbd, 0x20 | bit);
      const N = 16000, OFF = 12000;
      const ref = new Float32Array(N);
      chip.generate(ref, 0, OFF);
      chip.write(0xbd, 0x20);
      chip.generate(ref, OFF, N - OFF);
      // The drum's own channel is the note; the partner's is the record's.
      const det = (to, from) => Math.round(4096 * Math.log2(to / from));
      const spec = {
        [O.OPL_KIND_BD]: [f6, b6, { ops: [op.bd1, op.bd2], feedback: fb, cntA: cnt }],
        [O.OPL_KIND_SD]: [f7, 3, { ops: [op.sd], partnerMult: op.hh.mult }],
        [O.OPL_KIND_TOM]: [f8, 3, { ops: [op.tom] }],
        [O.OPL_KIND_TC]: [f8, 3, { ops: [op.tc], partnerMult: op.hh.mult, partnerDetune: det(f7, f8) }],
        [O.OPL_KIND_HH]: [f7, 3, { ops: [op.hh], partnerMult: op.tc.mult, partnerDetune: det(f8, f7) }],
      }[kind];
      const got = ours({ kind, ...spec[2] }, spec[0], spec[1], N, OFF);
      assert.equal(firstMismatch(got, ref), -1, `trial ${trial} kind ${kind}`);
    }
  });
