// An FM rack runs at its own rate (engine spec §5.5.1, "The rack's own rate"):
// the smallest whole multiple of the engine's that reaches 192 kHz, brought
// down through a low-pass. What that is FOR is aliasing — a modulated carrier
// has partials far above the engine's Nyquist frequency, and at the engine's
// own rate every one of them folds back as a tone that belongs to no harmonic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import {
  buildMetaRecord, makeMetaLayer, META_TYPE_FM, FM_WORD_OSC, FM_WORD_MOD, FmOp,
} from "../../core/engine/inst.js";
import { META_MIX_GAIN } from "../../core/engine/tables.js";
import { engineParts } from "../fixtures/engine-parts.js";

const RATE = 48000;
/** The most sub-steps a rack takes (engine spec §5.5.1 "The rack's own rate"). */
const FM_OVERSAMPLE_MAX = 8;
/** The sub-steps a rack takes at the engine's rate: the engine's own figure. */
const oversampleOf = (eng) => eng.playheads[0].trackerState.fmOversample;
setSamplingRate(RATE);

/** A sixteen-sample sine that sounds `hz` at C-4 — short, so the rate field
 *  can name a fundamental of a few kilohertz. */
const CYCLE = 16;
function oscillator(eng, hz, { cutoffCents = -1 } = {}) {
  const bin = eng.sampleBin;
  for (let i = 0; i < CYCLE; i++) bin[i] = Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * (i + 0.5)) / CYCLE) - 0.5);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, CYCLE); w16(6, hz * CYCLE); w16(12, CYCLE);
  rec[14] = 1;          // forward loop
  rec[21] = 0x3f;       // volume envelope node 0: full
  rec[171] = 255;       // instrument global volume
  rec[182] = 0xff;      // filter off…
  if (cutoffCents >= 0) { // …or a SoundFont-mode low-pass at an absolute cutoff
    rec[173] = 0x10;
    rec[182] = (cutoffCents >> 8) & 0xff; rec[252] = cutoffCents & 0xff;
    rec[183] = 0; rec[253] = 0;
  }
  rec[196] = 255;       // default note volume
  return rec;
}

const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];
const operators = (eng) => eng.playheads[0].trackerState.backgroundVoices.filter((v) => v.active);

/** `frames` of the mix bus after `skip`, with a rack sounding C-4. */
function renderRack(eng, slot, skip, frames) {
  eng.setMasterVolume(0, 255);
  eng.jamNote(0, 0, 0x5000, slot);
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  const got = new Float64Array(frames);
  let n = -skip;
  while (n < frames) {
    eng.renderChunk(0, out);
    const mix = ts.mixLeft;
    for (let i = 0; i < TRACKER_CHUNK; i++, n++) if (n >= 0 && n < frames) got[n] = mix[i];
  }
  return got;
}

/** Power at DFT bin `b` of `x` (its length a whole number of the periods under test). */
function binPower(x, b) {
  let re = 0, im = 0;
  const w = (2 * Math.PI * b) / x.length;
  for (let n = 0; n < x.length; n++) { re += x[n] * Math.cos(w * n); im += x[n] * Math.sin(w * n); }
  return re * re + im * im;
}

test("the factor is the smallest that reaches 192 kHz", () => {
  const factorAt = (rate) => oversampleOf(new TaudEngine(rate));
  assert.equal(factorAt(48000), 4);
  assert.equal(factorAt(32000), 6);
  assert.equal(factorAt(44100), 5, "220.5 kHz: four times would stop short");
  assert.equal(factorAt(96000), 2);
  assert.equal(factorAt(192000), 1, "at 192 kHz a rack runs as it always did");
  assert.equal(factorAt(384000), 1);
  assert.equal(factorAt(22050), FM_OVERSAMPLE_MAX, "capped");
});

test("a hard-driven rack's aliases are far below what the engine's own rate would fold back", () => {
  // Carrier and modulator at 3125 Hz, the modulator at +12 dB: an index of
  // some four cycles, so the patch's partials run on to 80 kHz and beyond.
  // 3125 Hz is 25 periods in 384 frames, so in a window of 3840 the true
  // partials sit on the multiples of bin 250 and nothing else does — every
  // other bin holds what folded.
  const F0 = 3125, FRAMES = 3840, PERIOD_BIN = 250;
  const octet = META_MIX_GAIN.findIndex((g) => Math.abs(20 * Math.log10(g) - 12) < 0.2);
  assert.ok(octet > 0, "premise: an octet near +12 dB");

  const eng = new TaudEngine();
  eng.uploadInstrument(1, oscillator(eng, F0));
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0, 0xffff, 0, 63),
    makeMetaLayer(1, octet, 0, 0, 0xffff, 0, 63),
  ], { type: META_TYPE_FM, program: Uint16Array.from([FM_WORD_OSC | 1, FM_WORD_MOD | 0, FmOp.END]) }));
  const y = renderRack(eng, 3, RATE / 4, FRAMES);
  assert.ok(Math.abs(voice0(eng).playbackRate - (F0 * CYCLE) / RATE) < 1e-12, "premise: the carrier is on 3125 Hz");

  // The same patch as arithmetic, at the engine's own rate: what a rack was.
  const index = META_MIX_GAIN[octet];
  const naive = new Float64Array(FRAMES);
  for (let n = 0; n < FRAMES; n++) {
    const ph = (F0 * n) / RATE;
    naive[n] = Math.sin(2 * Math.PI * (ph + index * Math.sin(2 * Math.PI * ph)));
  }

  const split = (x) => {
    let harmonic = 0, folded = 0;
    for (let b = 10; b < FRAMES / 2; b += 10) { // every bin a partial OR an alias of this patch can land on
      const p = binPower(x, b);
      if (b % PERIOD_BIN === 0) harmonic += p; else folded += p;
    }
    return 10 * Math.log10(folded / harmonic);
  };
  const was = split(naive), is = split(y);
  assert.ok(was > -6, `premise: at 48 kHz this patch folds badly (${was.toFixed(1)} dB re its partials)`);
  assert.ok(is < was - 20, `aliases ${is.toFixed(1)} dB re the partials; the engine's own rate gives ${was.toFixed(1)} dB`);
});

test("the low-pass passes the audible band and leaves a plain carrier's level alone", () => {
  // No modulation at all: the rack is its carrier, through the decimator.
  const level = (hz) => {
    const eng = new TaudEngine();
    eng.uploadInstrument(1, oscillator(eng, hz));
    eng.uploadInstrument(3, buildMetaRecord([makeMetaLayer(1, 159, 0, 0, 0xffff, 0, 63)],
      { type: META_TYPE_FM, program: Uint16Array.from([FM_WORD_OSC | 0, FmOp.END]) }));
    const y = renderRack(eng, 3, RATE / 4, 4800);
    return Math.sqrt(y.reduce((s, v) => s + v * v, 0) / y.length);
  };
  const ref = level(500);
  for (const hz of [1000, 4000, 12000]) {
    assert.ok(Math.abs(20 * Math.log10(level(hz) / ref)) < 0.25, `${hz} Hz is not at the level of 500 Hz`);
  }
  assert.ok(20 * Math.log10(level(16000) / ref) > -1.0, "16 kHz is still within a decibel");
});

test("an operator's own filter runs at the rack's rate and keeps its cutoff where it was written", () => {
  const CUTOFF = 9000; // absolute cents: about 1.5 kHz
  const eng = new TaudEngine();
  eng.uploadInstrument(1, oscillator(eng, 440));
  eng.uploadInstrument(2, oscillator(eng, 440, { cutoffCents: CUTOFF }));
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0, 0xffff, 0, 63),
  ], { type: META_TYPE_FM, program: Uint16Array.from([FM_WORD_OSC | 1, FM_WORD_MOD | 0, FmOp.END]) }));
  eng.jamNote(0, 0, 0x5000, 3);
  // A jammed note waits for the next tick to have its coefficients made.
  for (let i = 0; i < 10; i++) eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
  const op = operators(eng).find((v) => v.instrumentId === 2);
  assert.equal(op.filterOversample, oversampleOf(eng), "the modulator is filtered once a sub-step");
  assert.equal(voice0(eng).filterOversample, 0, "operator 0's filter is the mixer's, at the engine's rate");
  assert.equal(op.filterActive, true);

  // The coefficients a voice of an engine running at 192 kHz makes for the
  // same cutoff: the operator's, to the bit.
  setSamplingRate(RATE * oversampleOf(eng));
  try {
    const P = engineParts();
    const v = P.voice();
    v.filterSfMode = true;
    v.currentCutoff = op.currentCutoff;
    v.currentResonance = op.currentResonance;
    P.refreshVoiceFilter(v);
    for (const f of ["filterBqB02", "filterBqB1", "filterBqA1", "filterBqA2"]) assert.equal(op[f], v[f], f);
  } finally {
    setSamplingRate(RATE);
  }
});
