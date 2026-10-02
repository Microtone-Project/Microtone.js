// The engine's output rate is settable (item 108): the web default is 48 kHz —
// the rate the browser's AudioContext runs at, so playback and the default WAV
// export need no resampling — while the TSVM device and the scenario tests
// stay on 32 kHz.
//
// What must hold at BOTH rates: the song plays at the same speed, the filters
// sit at the same frequencies in Hz, and the anti-click ramps last the same
// number of milliseconds. This file pins that, and pins that 32 kHz reproduces
// AudioAdapter.kt's precomputed constants exactly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import * as C from "../../core/engine/constants.js";
import * as T from "../../core/engine/tables.js";
import { BinauralRenderer } from "../../core/engine/binaural.js";
import { HRIR_LENGTH, HRIR_RATE } from "../../core/engine/hrir-sadie.js";

const AMIGA_A500_LP_FC = 4420.971; // the A500's RC corner, in Hz — rate-independent

/** Engine with a looping ramp sample in slot 1 (engine-scenarios' recipe),
 *  playing C4 on row 0 of a one-channel song at BPM 125, speed 6. */
function makePlayingEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);   // sampleLength
  w16(6, 32000);  // samplingRate @C4
  w16(12, 1000);  // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; // instGlobalVolume
  rec[196] = 255; // defaultNoteVolume
  eng.uploadInstrument(1, rec);

  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1; // row 0: C4 on inst 1
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

/** Play `seconds` of it at the current rate; report where the song got to. */
function positionAfter(seconds) {
  const eng = makePlayingEngine();
  const out = new Uint8Array(C.TRACKER_CHUNK * 2);
  const calls = Math.round((seconds * C.SAMPLING_RATE) / C.TRACKER_CHUNK);
  for (let i = 0; i < calls; i++) eng.renderChunk(0, out);
  const ts = eng.playheads[0].trackerState;
  return { row: ts.rowIndex, tick: ts.tickInRow };
}

/** |H(f)| of the one-pole y = a0·x + b1·y₋₁ at `f` Hz, sampled at `rate`. */
function onePoleMag(a0, b1, f, rate) {
  const w = (2 * Math.PI * f) / rate;
  const re = 1 - b1 * Math.cos(w);
  const im = b1 * Math.sin(w);
  return a0 / Math.sqrt(re * re + im * im);
}

test("the web default is the browser's own rate, so playback resamples nothing", () => {
  assert.equal(C.SAMPLING_RATE, 48000);
});

test("the anti-click ramps are times, not sample counts", () => {
  assert.equal(C.RAMP_OUT_SAMPLES / C.SAMPLING_RATE, 0.008);
  assert.equal(C.VOL_RAMP_SAMPLES / C.SAMPLING_RATE, 0.002);
  C.setSamplingRate(32000);
  // …and at Kotlin's rate they are Kotlin's numbers, to the sample.
  assert.equal(C.RAMP_OUT_SAMPLES, 256);
  assert.equal(C.VOL_RAMP_SAMPLES, 64);
  C.setSamplingRate(48000);
  assert.equal(C.RAMP_OUT_SAMPLES, 384);
  assert.equal(C.VOL_RAMP_SAMPLES, 96);
});

test("the Amiga low-pass keeps its corner at 4421 Hz, whatever the rate", () => {
  // Where the response actually falls to −3 dB. The impulse-invariant one-pole
  // warps a little at these fc/rate ratios, so this is not exactly the nominal
  // corner at either rate — what matters is that the two land together.
  const cornerAt = (rate) => {
    C.setSamplingRate(rate);
    let lo = 500, hi = 15000;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (onePoleMag(T.AMIGA_A500_A0, T.AMIGA_A500_B1, mid, rate) > Math.SQRT1_2) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const c32 = cornerAt(32000);
  const c48 = cornerAt(48000);
  assert.ok(Math.abs(c48 / c32 - 1) < 0.05, `corner ${c32} Hz vs ${c48} Hz`);
  for (const c of [c32, c48]) {
    assert.ok(Math.abs(c / AMIGA_A500_LP_FC - 1) < 0.1, `corner landed at ${c} Hz`);
  }
  // Recomputing beats rescaling: the warp shrinks with the rate, so the 48 kHz
  // filter sits CLOSER to the analogue 4421 Hz than Kotlin's 32 kHz one.
  assert.ok(Math.abs(c48 - AMIGA_A500_LP_FC) < Math.abs(c32 - AMIGA_A500_LP_FC));
  // Kotlin precomputes b1 at 32 kHz; ours must land on the same double.
  C.setSamplingRate(32000);
  assert.equal(T.AMIGA_A500_B1, Math.exp((-2 * Math.PI * AMIGA_A500_LP_FC) / 32000));
  C.setSamplingRate(48000);
});

test("the binaural HRIR set is rate-converted, not stretched", () => {
  // The measured set is 256 taps at 48 kHz — the engine's own rate, so the
  // common path uses it untouched. Any other rate resamples it, and the filter
  // has to keep its LENGTH IN SECONDS: reading 256 taps at 32 kHz would move
  // the whole head model 50 % further away from the listener.
  const seconds = HRIR_LENGTH / HRIR_RATE;
  for (const rate of [32000, 48000, 96000]) {
    const r = new BinauralRenderer(true, rate);
    assert.ok(Math.abs(r.taps / rate - seconds) < 4 / rate,
      `${rate} Hz: ${r.taps} taps is ${(1000 * r.taps) / rate} ms, wanted ${1000 * seconds} ms`);
  }
  assert.equal(new BinauralRenderer(true, HRIR_RATE).taps, HRIR_LENGTH);
});

test("a song plays at the same speed at either rate", () => {
  // One tick is rate·2.5/bpm samples, so 2 s of BPM 125 / speed 6 is 100 ticks
  // = 16 rows and 4 ticks, at 32 kHz and at 48 kHz alike.
  C.setSamplingRate(48000);
  const at48 = positionAfter(2);
  C.setSamplingRate(32000);
  const at32 = positionAfter(2);
  C.setSamplingRate(48000);
  assert.deepEqual(at48, at32, `48 kHz ${JSON.stringify(at48)} vs 32 kHz ${JSON.stringify(at32)}`);
  assert.equal(at48.row, 16);
});
