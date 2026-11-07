// SoundFont-mode filter glide (TAUD_ENGINE_SPEC.md §9): FluidSynth's rule, from
// reference_materials/fluidsynth/src/rvoice/fluid_iir_filter_impl.cpp
// (fluid_iir_filter_calc, fluid_iir_filter_apply_local) and fluid_iir_filter.c
// (fluid_iir_filter_set_q). A cutoff move of more than a cent glides in cents
// over 64 × clip(Q, 1, 5) of FluidSynth's samples, a smaller one lands at once,
// a Q move glides over 64; the coefficients are recomputed after every sample;
// a note's first refresh lands at once. The IT mode is NOT glided (Schism and
// OpenMPT set their coefficients once a tick) and these tests pin that too.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setSamplingRate, SF_FILTER_GLIDE_SAMPLES } from "../../core/engine/constants.js";
import { Voice } from "../../core/engine/voice.js";
import { refreshVoiceFilter, advanceFilterGlide } from "../../core/engine/filter.js";

setSamplingRate(48000);

const coeffs = (v) => [v.filterBqB02, v.filterBqB1, v.filterBqA1, v.filterBqA2];

/** A voice in SoundFont mode, its filter refreshed at (cents, cB). */
function sfVoice(cut, res = 0) {
  const v = new Voice();
  v.filterSfMode = true;
  v.currentCutoff = cut;
  v.currentResonance = res;
  refreshVoiceFilter(v);
  return v;
}

/** The coefficients a filter set straight to (cut, res) has. */
const outright = (cut, res = 0) => coeffs(sfVoice(cut, res));

function retarget(v, cut, res = v.currentResonance) {
  v.currentCutoff = cut;
  v.currentResonance = res;
  refreshVoiceFilter(v);
}

test("the glide is FluidSynth's 64 samples at 44.1 kHz, carried as a time", () => {
  assert.equal(SF_FILTER_GLIDE_SAMPLES, Math.round((64 / 44100) * 48000));
  setSamplingRate(44100);
  try {
    assert.equal(SF_FILTER_GLIDE_SAMPLES, 64, "FluidSynth's own 64 at its own rate");
  } finally {
    setSamplingRate(48000);
  }
});

test("a note's first refresh lands at once, on the exact coefficients", () => {
  const v = sfVoice(6000, 100);
  assert.equal(v.sfCentsLeft, 0);
  assert.equal(v.sfQLeft, 0);
  assert.deepEqual(coeffs(v), outright(6000, 100));
});

test("a cutoff move of more than a cent glides over 64 × clip(Q, 1, 5) samples", () => {
  for (const res of [0, 60, 200, 400]) {
    const v = sfVoice(5000, res);
    const before = coeffs(v);
    retarget(v, 9000, res);
    // Nothing moves until the first sample steps it.
    assert.deepEqual(coeffs(v), before, "the coefficients stand until a sample steps them");
    const q = v.sfQ;
    const n = Math.round(SF_FILTER_GLIDE_SAMPLES * Math.min(Math.max(q, 1), 5));
    assert.equal(v.sfCentsLeft, n, `Q ${q.toFixed(3)}: ${n} samples`);
    let last = v.sfCents;
    for (let i = 1; i < n; i++) {
      advanceFilterGlide(v);
      assert.ok(v.sfCents > last, "the cutoff rises every sample");
      last = v.sfCents;
    }
    advanceFilterGlide(v);
    assert.equal(v.sfCentsLeft, 0);
    assert.deepEqual(coeffs(v), outright(9000, res), "and lands exactly on the target's coefficients");
    advanceFilterGlide(v); // a finished glide is left alone
    assert.deepEqual(coeffs(v), outright(9000, res));
  }
});

test("each step is an even share of the move in cents", () => {
  const v = sfVoice(4000);
  retarget(v, 4600);
  const n = v.sfCentsLeft;
  const c0 = v.sfCents;
  advanceFilterGlide(v);
  assert.ok(Math.abs(v.sfCents - c0 - 600 / n) < 1e-9);
  // …and the coefficients at that step are the RBJ low-pass at that cutoff.
  const hz = 8.176 * 2 ** (v.sfCents / 1200); // the cutoff's own cents, as Hz
  const w = (2 * Math.PI * hz) / 48000;
  const q = v.sfQ;
  const alpha = Math.sin(w) / (2 * q);
  const a0inv = 1 / (1 + alpha);
  assert.ok(Math.abs(v.filterBqA1 - -2 * Math.cos(w) * a0inv) < 1e-15);
});

test("a move of a cent or less lands at once", () => {
  const v = sfVoice(7000);
  retarget(v, 7001);
  assert.equal(v.sfCentsLeft, 0);
  assert.deepEqual(coeffs(v), outright(7001));
});

test("a Q move glides linearly over the base length, and lands exactly", () => {
  const v = sfVoice(7000, 0);
  const q0 = v.sfQ;
  retarget(v, 7000, 300);
  assert.equal(v.sfQLeft, SF_FILTER_GLIDE_SAMPLES);
  assert.equal(v.sfCentsLeft, 0, "the cutoff did not move");
  const q1 = v.sfQAim;
  advanceFilterGlide(v);
  assert.ok(Math.abs(v.sfQ - (q0 + (q1 - q0) / SF_FILTER_GLIDE_SAMPLES)) < 1e-12);
  for (let i = 1; i < SF_FILTER_GLIDE_SAMPLES; i++) advanceFilterGlide(v);
  assert.equal(v.sfQ, q1);
  assert.deepEqual(coeffs(v), outright(7000, 300));
});

test("a retarget mid-glide carries on from where the filter stands", () => {
  const v = sfVoice(5000);
  retarget(v, 9000);
  for (let i = 0; i < 10; i++) advanceFilterGlide(v);
  const at = v.sfCents;
  retarget(v, 3000);
  assert.ok(v.sfCentsIncr < 0, "turned round");
  assert.ok(Math.abs(v.sfCentsIncr * v.sfCentsLeft - (3000 - at)) < 1e-6, "from where it stood to the new target");
  while (v.sfCentsLeft > 0) advanceFilterGlide(v);
  assert.deepEqual(coeffs(v), outright(3000));
});

test("switching the filter off and on, or to IT mode and back, lands at once", () => {
  const v = sfVoice(5000);
  retarget(v, 0xffff);
  assert.equal(v.filterActive, false);
  retarget(v, 8000);
  assert.equal(v.sfCentsLeft, 0, "back on: no glide from where it was");
  assert.deepEqual(coeffs(v), outright(8000));
  v.filterSfMode = false;
  retarget(v, 200, 100);
  assert.equal(v.filterIsBiquad, false);
  const it = [v.filterA0, v.filterB0, v.filterB1];
  advanceFilterGlide(v);
  assert.deepEqual([v.filterA0, v.filterB0, v.filterB1], it, "an IT filter is never glided");
  v.filterSfMode = true;
  retarget(v, 6000, 0);
  assert.equal(v.sfCentsLeft, 0);
  assert.deepEqual(coeffs(v), outright(6000));
});
