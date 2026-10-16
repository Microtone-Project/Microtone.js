// Metainstrument type 9: two PSG oscillators in place of a sample.
//
// What is pinned here: (1) the record — an ordinary instrument whose header
// says "type 9" and whose second pitch/filter slot is the patch; (2) the
// waveforms, the noises' exact cycles included; (3) the voice — pitch, the two
// mix models and the mute rule, release, the auto-advance and the X flag;
// (4) S $Axxx — the run-time overlay, its persistence across notes and its
// reset on a new playback; (5) a PSG instrument as every high meta's source.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../core/engine/constants.js";
import {
  TaudInst, buildPsgRecord, buildMetaRecord, makeMetaLayer,
  META_TYPE_PSG, META_TYPE_FM, PSG_RECORD_HEADER, metaTierOf, META_TIER_LOW,
} from "../../core/engine/inst.js";
import * as P from "../../core/engine/psg.js";

const C4_HZ = 261.6255653005986;
const OP_S = 0x1c;

/** A held, full-level oscillator: instant attack, no decay, sustaining. */
const HELD = { ar: 15, dr: 0, sl: 0, rr: 8, mult: 1, tl: 0, eg: 1 };
const sq = (extra = {}) => ({ ...HELD, wave: 4, ...extra });

function psgInst(patch, fields = {}) {
  return buildPsgRecord(P.encodePsgPatch(patch), fields);
}

function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.vol !== undefined) pat[o + 3] = c.vol & 0x3f;
    if (c.fx !== undefined) { pat[o + 5] = c.fx[0]; pat[o + 6] = c.fx[1] & 0xff; pat[o + 7] = (c.fx[1] >>> 8) & 0xff; }
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

const ts0 = (eng) => eng.playheads[0].trackerState;
/** Frames in `n` ticks at 125 BPM. */
const ticks = (n) => Math.round((n * SAMPLING_RATE * 2.5) / 125);
const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
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
const render = (patch, rows, frames, fields) => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, psgInst(patch, fields));
  loadSong(eng, rows ?? [{ row: 0, note: 0x5000, inst: 1 }]);
  return renderLeft(eng, frames);
};

// ── the record ───────────────────────────────────────────────────────────

test("a type-9 record is an ordinary record with the oscillators where the sample was", () => {
  const rec = psgInst({ multiply: true, muteB: true, osc: [sq({ advance: 3 }), sq({ wave: 9 })] },
    { rate: 16726, nna: 2 });
  assert.deepEqual([...rec.subarray(0, 4)], [...PSG_RECORD_HEADER]);
  assert.equal(rec[0] >>> 4, META_TYPE_PSG);
  assert.equal(metaTierOf(META_TYPE_PSG), META_TIER_LOW);
  const inst = new TaudInst(1);
  inst.loadRecord(rec);
  assert.ok(inst.isPsg && inst.isLowMeta && !inst.isMeta && !inst.isOpl);
  assert.equal(inst.chipPatch, inst.psg);
  assert.equal(inst.samplingRate, 16726);
  assert.equal(inst.newNoteAction, 2);
  assert.ok(inst.psg.multiply && inst.psg.muteB && !inst.psg.muteA);
  assert.equal(inst.psg.osc[0].advance, 3);
  assert.equal(inst.psg.osc[1].wave, 9);
  for (let i = 0; i < 256; i++) assert.equal(inst.getByte(i), rec[i], `byte ${i} round-trips`);
});

test("the oscillator bytes are the layout the format gives them", () => {
  const b = P.encodePsgPatch({ osc: [{
    wave: 0xd, ar: 0xa, dr: 0x3, sl: 0x5, rr: 0x7, mult: 0x2, ksl: 2, tl: 0x21,
    ksr: 1, eg: 1, reset: true, invert: true, tremolo: 2, vibrato: 1, advance: 0x40,
  }] });
  // 199…204 of the record are 2…7 of the block.
  assert.deepEqual([...b.subarray(2, 8)], [0xda, 0x35, 0x72, 0xa1, 0x6f, 0x40]);
  const d = P.decodePsgPatch(b).osc[0];
  assert.deepEqual(
    [d.wave, d.ar, d.dr, d.rr, d.mult, d.ksl, d.tl, d.ksr, d.eg, d.reset, d.invert, d.tremolo, d.vibrato],
    [0xd, 0xa, 0x3, 0x7, 0x2, 2, 0x21, 1, 1, true, true, 2, 1]);
  // The reserved depth 3 reads as off.
  b[6] = 0xf0;
  const r = P.decodePsgPatch(b).osc[0];
  assert.equal(r.tremolo, 0);
  assert.equal(r.vibrato, 0);
});

test("an edit to the patch block re-decodes in place, keeping the run-time overlay", () => {
  const inst = new TaudInst(1);
  inst.loadRecord(psgInst({ osc: [sq(), sq()] }));
  const patch = inst.psg;
  P.psgWriteRegister(patch, 0x120);
  inst.setByte(199, 0x9f);
  assert.equal(inst.psg, patch, "the same object a voice holds");
  assert.equal(patch.osc[0].wave, 9);
  assert.equal(P.psgLevel(patch, 0), 0x20, "S $A120 survives an edit");
  inst.loadRecord(psgInst({ osc: [sq(), sq()] }));
  assert.equal(P.psgLevel(patch, 0), 0x20, "…and a reload of the record");
  inst.resetPsgRuntime();
  assert.equal(P.psgLevel(patch, 0), 0);
});

// ── the waveforms ────────────────────────────────────────────────────────

test("the pulses are high for (8 − n) eighths, as drawn", () => {
  for (let w = 1; w <= 7; w++) {
    const highs = [];
    for (let e = 0; e < 8; e++) highs.push(P.psgWaveValue(w, e * 2 ** 29 + 1) > 0 ? 1 : 0);
    assert.deepEqual(highs, Array.from({ length: 8 }, (_, e) => (e < 8 - w ? 1 : 0)), `wave ${w}`);
  }
  assert.equal(P.psgWaveValue(0, 12345), 1, "DC is +1");
  assert.equal(P.psgWaveValue(0xf, 12345), 0, "F is silence");
});

test("saw, triangle and the 4-bit pair span ±1", () => {
  const at = (w, x) => P.psgWaveValue(w, Math.floor(x * 2 ** 32));
  assert.equal(at(8, 0), 1);
  assert.ok(at(8, 0.999999) < -0.99, "the saw slopes down");
  assert.equal(at(9, 0), -1);
  assert.equal(at(9, 0.5), 1, "the triangle rises, then falls");
  const saw4 = new Set(), tri4 = new Set();
  for (let i = 0; i < 64; i++) { saw4.add(at(0xd, i / 64)); tri4.add(at(0xe, i / 64)); }
  assert.equal(saw4.size, 16, "sixteen levels");
  assert.equal(tri4.size, 16);
  assert.equal(Math.max(...saw4), 1); assert.equal(Math.min(...saw4), -1);
  assert.equal(at(0xe, 0), -1); assert.equal(at(0xe, 15.5 / 32), 1);
});

test("each noise repeats on exactly its own cycle", () => {
  for (const [w, cycle] of [[0xa, 32767], [0xb, 2047], [0xc, 127]]) {
    assert.equal(P.PSG_NOISE_CYCLES[w], cycle);
    const at = (n) => P.psgWaveValue(w, 0, n);
    for (let n = 0; n < 3 * cycle; n++) assert.equal(at(n), at(n + cycle), `wave ${w} at ${n}`);
    // …and on no shorter one: every proper divisor shifts the sequence.
    for (let d = 1; d < cycle; d++) {
      if (cycle % d !== 0) continue;
      let same = true;
      for (let n = 0; n < cycle && same; n++) same = at(n) === at(n + d);
      assert.equal(same, false, `wave ${w} does not repeat every ${d}`);
    }
    let ones = 0;
    for (let n = 0; n < cycle; n++) if (at(n) > 0) ones++;
    assert.equal(ones, (cycle + 1) / 2, "a maximal register's balance");
  }
});

// ── the voice ────────────────────────────────────────────────────────────

test("a PSG note sounds at its pitch, at the C2SPD's middle C, and the multiplier scales it", () => {
  const a = render({ muteB: true, osc: [sq(), sq()] }, null, 24000);
  assert.ok(Math.abs(zeroCrossHz(a, 4800, 24000) - C4_HZ) < 0.5, "C4 at 8363");
  const b = render({ muteB: true, osc: [sq({ mult: 2 }), sq()] }, null, 24000);
  assert.ok(Math.abs(zeroCrossHz(b, 4800, 24000) - 2 * C4_HZ) < 1, "×2 is an octave up");
  const c = render({ muteB: true, osc: [sq(), sq()] }, null, 24000, { rate: 16726 });
  assert.ok(Math.abs(zeroCrossHz(c, 4800, 24000) - 2 * C4_HZ) < 1, "an octave up at 16726");
});

test("the level is OPL's: 0.75 dB a step", () => {
  const level = (tl) => rms(render({ muteB: true, osc: [sq({ tl }), sq()] }, null, 12000), 4800);
  const db = 20 * Math.log10(level(8) / level(0));
  assert.ok(Math.abs(db + 6) < 0.15, `TL 8 is −6 dB, got ${db.toFixed(2)}`);
});

test("additive sums the pair, multiplicative rings it, and a muted one is passed by", () => {
  const A = sq(), B = { ...HELD, wave: 9, mult: 3 };
  const bAlone = render({ muteA: true, osc: [A, B] }, null, 9600);
  const aAlone = render({ muteB: true, osc: [A, B] }, null, 9600);
  const add = render({ osc: [A, B] }, null, 9600);
  const mul = render({ multiply: true, osc: [A, B] }, null, 9600);
  for (let i = 2400; i < 9600; i += 7) {
    assert.ok(Math.abs(add[i] - (aAlone[i] + bAlone[i])) < 1e-4, `A + B at ${i}`);
  }
  assert.ok(rms(mul, 2400) > 0.01 && rms(mul, 2400) < rms(add, 2400), "a product of the two");
  // Muting either oscillator makes the mixer a no-op in both models.
  for (const multiply of [false, true]) {
    assert.deepEqual(render({ multiply, muteA: true, osc: [A, B] }, null, 9600), bAlone);
    assert.deepEqual(render({ multiply, muteB: true, osc: [A, B] }, null, 9600), aAlone);
    assert.equal(rms(render({ multiply, muteA: true, muteB: true, osc: [A, B] }, null, 9600)), 0);
  }
});

test("the invert flag turns the waveform over", () => {
  const up = render({ muteB: true, osc: [{ ...HELD, wave: 0 }, sq()] }, null, 4800);
  const down = render({ muteB: true, osc: [{ ...HELD, wave: 0, invert: true }, sq()] }, null, 4800);
  assert.ok(up[3000] > 0.1, "DC is +1");
  assert.ok(Math.abs(up[3000] + down[3000]) < 1e-6, "…and −1 inverted");
});

test("a key-off releases both oscillators and the voice ends with them", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, psgInst({ osc: [sq(), sq()] }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 2, note: 0x0001 }]);
  const v = ts0(eng).voices[0];
  renderLeft(eng, 4000);
  assert.ok(v.active && v.psg !== null && v.psg.keyed);
  renderLeft(eng, 48000);
  assert.equal(v.psg.keyed, false);
  assert.equal(v.active, false, "release rate 8 is long gone after a second");
});

test("a retrigger the NNA cuts keys the SAME pair on, envelopes where they stand", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, psgInst({ osc: [sq({ ar: 4 }), sq({ ar: 4 })] }, { nna: 1 }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, note: 0x5400, inst: 1 }]);
  const v = ts0(eng).voices[0];
  renderLeft(eng, ticks(5.5));
  const st = v.psg;
  const before = st.env[0];
  assert.ok(before < 511 && before > 0, "mid-attack");
  renderLeft(eng, ticks(1));
  assert.equal(v.psg, st, "the same pair");
  assert.ok(v.psg.env[0] <= before, "the attack continued from where it stood");
  assert.equal(ts0(eng).backgroundVoices.length, 0, "no ghost");
});

test("auto-advance bounces a pulse 1 → 7 → 1, one step every N ticks", () => {
  /** The waveform after each of `steps` steps, from a record waveform `wave`. */
  const walk = (wave, steps, n = 1) => {
    const patch = P.decodePsgPatch(P.encodePsgPatch({ osc: [{ ...HELD, wave, advance: n }, sq()] }));
    const st = new P.PsgState();
    P.psgKeyOn(st, patch, false);
    const out = [];
    for (let t = 0; t < steps * n; t++) {
      P.psgTick(st);
      if ((t + 1) % n === 0) out.push(P.psgCurrentWave(st, 0));
    }
    return out;
  };
  assert.deepEqual(walk(1, 14), [2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 2, 3], "up, back down, up again");
  assert.deepEqual(walk(7, 8), [6, 5, 4, 3, 2, 1, 2, 3], "7 starts down");
  assert.deepEqual(walk(4, 6), [5, 6, 7, 6, 5, 4], "a middle width starts up");
  const two = walk(4, 24);
  assert.deepEqual(two.slice(12), two.slice(0, 12), "twelve steps a round");
  assert.deepEqual(walk(3, 3, 3), [4, 5, 6], "N ticks a step");
  // Every width but the ends appears twice a round, the ends once.
  const round = walk(1, 12);
  for (let w = 1; w <= 7; w++) assert.equal(round.filter((x) => x === w).length, w === 1 || w === 7 ? 1 : 2, `width ${w}`);
  // DC and every non-pulse waveform hold.
  for (const w of [0, 8, 9, 0xa, 0xd, 0xf]) assert.deepEqual(walk(w, 5), [w, w, w, w, w], `wave ${w} holds`);

  // …and the engine runs it in its tick pass: two ticks a step from 6.
  const eng = new TaudEngine();
  eng.uploadInstrument(1, psgInst({ muteB: true, osc: [sq({ wave: 6, advance: 2 }), sq()] }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  const seen = [];
  for (let t = 0; t < 12; t++) {
    renderLeft(eng, ticks(1));
    const w = P.psgCurrentWave(ts0(eng).voices[0].psg, 0);
    if (seen.at(-1) !== w) seen.push(w);
  }
  assert.deepEqual(seen.slice(0, 5), [6, 7, 6, 5, 4], "6, up to 7, back down");
});

test("internal status carries from note to note, unless the X flag resets it", () => {
  const run = (reset) => {
    const eng = new TaudEngine();
    eng.uploadInstrument(1, psgInst({ muteB: true, osc: [sq({ wave: 1, advance: 1, reset }), sq()] },
      { nna: 0 }));
    loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, note: 0x5000, inst: 1 }]);
    renderLeft(eng, ticks(5.5));          // inside the last tick before row 1
    const before = ts0(eng).voices[0].psg.adv[0];
    renderLeft(eng, ticks(0.6));          // just past row 1's trigger
    return [before, ts0(eng).voices[0].psg.adv[0]];
  };
  const [b0, a0] = run(false);
  assert.ok(b0 > 0, "it advanced during the first note");
  assert.ok(a0 >= b0, "kept across the trigger");
  const [b1, a1] = run(true);
  assert.ok(b1 > 0);
  assert.ok(a1 < b1, "reset by the trigger");
});

// ── S $Axxx ──────────────────────────────────────────────────────────────

test("S $Axxx decodes to the overlay's registers, and nothing else", () => {
  const p = new P.PsgPatch();
  assert.ok(P.psgWriteRegister(p, 0x005)); assert.equal(p.rtAdvance[0], 5);
  assert.ok(P.psgWriteRegister(p, 0x8ff)); assert.equal(p.rtAdvance[1], 0xff);
  assert.ok(P.psgWriteRegister(p, 0x13f)); assert.equal(p.rtLevel[0], 0x3f);
  assert.ok(P.psgWriteRegister(p, 0x920)); assert.equal(p.rtLevel[1], 0x20);
  for (const [r, a, b] of [[0xf01, true, false], [0xf02, false, true], [0xf03, true, true], [0xf00, false, false]]) {
    assert.ok(P.psgWriteRegister(p, r));
    assert.deepEqual([P.psgMuted(p, 0), P.psgMuted(p, 1)], [a, b], `$${r.toString(16)}`);
  }
  const gen = p.rtGen;
  for (const r of [0x140, 0x1ff, 0x200, 0x7ff, 0x940, 0xa00, 0xeff, 0xf04, 0xfff]) {
    assert.equal(P.psgWriteRegister(p, r), false, `$${r.toString(16)} is reserved`);
  }
  assert.equal(p.rtGen, gen, "a reserved write changes nothing");
});

test("S $Axxx writes the instrument, lasts across notes, and is gone on a new playback", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, psgInst({ muteB: true, osc: [sq(), sq()] }));
  loadSong(eng, [
    { row: 0, note: 0x5000, inst: 1 },
    { row: 1, fx: [OP_S, 0xa110] },              // A's level to $10: −12 dB
    { row: 2, note: 0x5000, inst: 1 },
    { row: 3, fx: [OP_S, 0xaf01] },              // A muted, B NOT: both bits are set
    { row: 4, fx: [OP_S, 0xaf03] },              // both muted
  ]);
  const a = renderLeft(eng, ticks(30));
  const loud = rms(a, ticks(2), ticks(6));
  const quiet = rms(a, ticks(14), ticks(18));     // row 2: a NEW note, the write kept
  assert.ok(Math.abs(20 * Math.log10(quiet / loud) + 12) < 0.3, "−12 dB on the next note too");
  const bOnly = rms(a, ticks(19), ticks(24));
  assert.ok(Math.abs(20 * Math.log10(bOnly / loud)) < 0.3,
    "S $AF01 lifts the record's mute of B, which sounds at its own full level");
  assert.ok(rms(a, ticks(25), ticks(30)) < 1e-6, "S $AF03 mutes both");
  const st = eng.getInstrumentPsgState(1);
  assert.deepEqual(st.rtLevel, [0x10, -1]);
  assert.equal(st.rtMute, 3);
  // A new playback starts from the record again — every path that clears
  // invert loop's mask: play from the start, a full reset, the sample-FX reset.
  const again = () => { P.psgWriteRegister(eng.instruments[1].psg, 0x120); };
  for (const replay of [() => eng.chaseTrackerRow(0, 0, 0), () => eng.resetParams(0),
    () => eng.resetSampleFxState(0)]) {
    replay();
    assert.deepEqual(eng.getInstrumentPsgState(1).rtLevel, [-1, -1]);
    assert.equal(eng.getInstrumentPsgState(1).rtMute, -1);
    again();
  }
  assert.equal(eng.getInstrumentPsgState(2), null, "null for anything not PSG");
});

test("the live state reports the waveform a sounding voice is playing", () => {
  const eng = new TaudEngine();
  eng.uploadInstrument(1, psgInst({ osc: [sq({ wave: 2, advance: 1 }), { ...HELD, wave: 9 }] }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  assert.equal(eng.getInstrumentPsgState(1).wave, null, "nothing sounding yet");
  renderLeft(eng, ticks(3));
  const w = eng.getInstrumentPsgState(1).wave;
  assert.notEqual(w[0], 2, "advanced");
  assert.equal(w[1], 9);
});

// ── as a source ──────────────────────────────────────────────────────────

test("a PSG instrument sounds as a layer, as a rack operator and as a formant source", async () => {
  const { buildFormantRecord } = await import("../../core/engine/inst.js");
  const F = await import("../../core/engine/formant.js");
  const tone = psgInst({ muteB: true, osc: [{ ...HELD, wave: 9 }, sq()] });
  const eng = new TaudEngine();
  eng.uploadInstrument(0x101, tone);
  eng.uploadInstrument(1, buildMetaRecord([
    makeMetaLayer(0x101, 159, 0, 0, 0xffff, 0, 63),
    makeMetaLayer(0x101, 159, 4096, 0, 0xffff, 0, 63),
  ]));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  assert.ok(rms(renderLeft(eng, 12000), 4800) > 0.01, "layered");
  assert.equal(ts0(eng).backgroundVoices.filter((v) => v.psg !== null).length, 1, "both layers");

  const eng2 = new TaudEngine();
  eng2.uploadInstrument(0x101, tone);
  eng2.uploadInstrument(2, buildMetaRecord([makeMetaLayer(0x101, 159, 0, 0, 0xffff, 0, 63)],
    { type: META_TYPE_FM }));
  loadSong(eng2, [{ row: 0, note: 0x5000, inst: 2 }]);
  const b = renderLeft(eng2, 12000);
  assert.ok(rms(b, 4800) > 0.01, "a rack reads the pair");
  assert.ok(Math.abs(zeroCrossHz(b, 4800, 12000) - C4_HZ) < 1, "at the note's pitch");

  // A formant instrument sung from it, its own sample a one-cycle saw it no
  // longer reads (metatiers.test.js's fixture).
  const SAW = { ptr: 0x1000, len: 128, rate: Math.round(128 * C4_HZ), loopStart: 0, loopEnd: 128, loopMode: 1 };
  const fp = new F.FormantPatch();
  fp.srcPtr = SAW.ptr;
  fp.front = 200; fp.open = 255; fp.round = 0; fp.refNote = 0x4000;
  const eng3 = new TaudEngine();
  eng3.uploadInstrument(0x101, tone);
  eng3.uploadInstrument(3, buildFormantRecord(F.encodeFormantBlock(fp), SAW, { sourceInst: 0x101 }));
  loadSong(eng3, [{ row: 0, note: 0x5000, inst: 3 }]);
  assert.ok(rms(renderLeft(eng3, 24000), 9600) > 0.001, "a formant instrument sings from it");
  assert.ok(ts0(eng3).voices[0].formant.src instanceof P.PsgState, "the pair is the source");
});
