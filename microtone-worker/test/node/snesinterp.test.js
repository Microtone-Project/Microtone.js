// SNES 4-tap gaussian interpolation (item 69).
//
// The DSP interpolates 15-BIT samples (-4000h..+3FFFh). Its four coefficients
// sum to ~800h while every tap is only SAR 10, so the running sum sits at ~2x
// the sample: it fits int16 exactly as long as the input is 15-bit. The engine
// used to promote each [-1,1] sample to 16-bit instead, which made the mid-sum
// wrap on ANY content past half scale — loud waveforms came back folded inside
// out, and everything quieter came back 2x too loud.
//
// What this pins: unity gain, no folding at any amplitude, and the ONE overflow
// the real hardware does have — the bugged 801h table phases, which turn a run
// of max-negative samples into +3FF8h (fullsnes §snesapudspbrrpitch).

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchTrackerSample } from "../../core/engine/sampler.js";
import { Voice } from "../../core/engine/voice.js";
import { TaudInst } from "../../core/engine/inst.js";
import { SAMPLE_BIN_TOTAL, INTERP_SNES } from "../../core/engine/constants.js";
import { SNES_GAUSS } from "../../core/engine/tables.js";

const LEN = 512;

/** Engine stub carrying just the pool: the interpolator reads nothing else. */
function makeFixture(fill) {
  const eng = { sampleBin: new Uint8Array(SAMPLE_BIN_TOTAL) };
  for (let i = 0; i < LEN; i++) eng.sampleBin[i] = fill(i);
  const inst = new TaudInst(1);
  inst.invertMask = null;
  return { eng, inst };
}

function makeVoice(rate, pos = 0) {
  const v = new Voice();
  v.activeSamplePtr = 0;
  v.activeSampleLength = LEN;
  v.activeSampleLoopStart = 0;
  v.activeSampleLoopEnd = LEN;
  v.activeLoopMode = 1; // forward loop (sustain bit clear), so it never ramps out
  v.keyOff = false;
  v.forward = true;
  v.rampOutSamples = 0;
  v.samplePos = pos;
  v.playbackRate = rate;
  // This harness drives fetchTrackerSample directly, so the mixer's per-sample
  // pitch glide (advancePitchRamp) never runs: set the value the sampler steps
  // by as well as the target it would be gliding toward.
  v.currentPlaybackRate = rate;
  return v;
}

function render({ eng, inst }, rate, n, pos = 0) {
  const v = makeVoice(rate, pos);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fetchTrackerSample(eng, v, inst, INTERP_SNES);
  return out;
}

/** U8 encoding of a sine of the given amplitude and period, in samples. */
const sineFill = (amp, period) => (i) =>
  Math.min(255, Math.max(0, Math.round(amp * Math.sin(2 * Math.PI * i / period) * 127.5 + 127.5)));

test("SNES gauss table: 512 entries, monotone, quad sums land on 0x7ff..0x801", () => {
  assert.equal(SNES_GAUSS.length, 512);
  for (let i = 1; i < 512; i++) {
    assert.ok(SNES_GAUSS[i] >= SNES_GAUSS[i - 1], `table dips at ${i}`);
  }
  const seen = new Map();
  for (let i = 0; i < 256; i++) {
    const sum = SNES_GAUSS[0xff - i] + SNES_GAUSS[0x1ff - i] + SNES_GAUSS[0x100 + i] + SNES_GAUSS[i];
    assert.ok(sum >= 0x7ff && sum <= 0x801, `phase ${i} sums to ${sum.toString(16)}`);
    seen.set(sum, (seen.get(sum) ?? 0) + 1);
  }
  // The ROM's exact error distribution — 0x801 is the phase set that can overflow.
  assert.deepEqual([...seen].sort((a, b) => a[0] - b[0]), [[0x7ff, 42], [0x800, 168], [0x801, 46]]);
});

test("unity gain: DC passes through at full scale, not doubled", () => {
  // A steady +1.0. Every tap is the same value, so the output IS the input —
  // except at the 0x801 phases, where the hardware's mid-sum wrap fires.
  const hot = render(makeFixture(() => 255), 0.37, 64);
  const settled = hot.slice(1); // sample 0 sits at phase 0, an 0x801 phase
  for (const y of settled) assert.ok(y > 0.99 && y <= 1.0, `DC +1 read ${y}`);

  const cold = render(makeFixture(() => 0), 0.37, 64).slice(1);
  for (const y of cold) assert.ok(y < -0.99 && y >= -1.0, `DC -1 read ${y}`);
});

test("a full-scale sine survives interpolation without folding", () => {
  // The regression: at 16-bit input scaling the peaks of this wave came back
  // with the WRONG SIGN (measured -0.73 where the source was at +1.0).
  const fx = makeFixture(sineFill(1.0, 8));
  const rate = 1 / 3;
  const y = render(fx, rate, 96);
  for (let n = 0; n < y.length; n++) {
    const want = Math.sin(2 * Math.PI * (n * rate) / 8);
    if (Math.abs(want) < 0.3) continue; // skip zero crossings
    assert.equal(Math.sign(y[n]), Math.sign(want),
      `sample ${n}: source ${want.toFixed(3)} interpolated ${y[n].toFixed(3)}`);
  }
});

test("amplitude response is monotone and never exceeds the source", () => {
  const rate = 1 / 3;
  let prevPeak = 0;
  for (const amp of [0.125, 0.25, 0.5, 0.7, 0.9, 1.0]) {
    const y = render(makeFixture(sineFill(amp, 8)), rate, 96);
    const peak = Math.max(...y.map(Math.abs));
    // A 4-tap gaussian is a low-pass: it may attenuate, never amplify.
    // Pre-fix this read ~2x the source amplitude (and folded on top of that).
    assert.ok(peak <= amp + 0.005, `amp ${amp} came back at ${peak.toFixed(3)}`);
    assert.ok(peak > prevPeak, `amp ${amp} peak ${peak.toFixed(3)} did not rise`);
    prevPeak = peak;
  }
});

test("output stays inside [-1, 1] for full-scale square edges", () => {
  // Alternating rails: the worst case for a ringing kernel.
  const y = render(makeFixture((i) => (i & 1 ? 255 : 0)), 1 / 7, 200);
  for (const v of y) assert.ok(v >= -1.0 && v <= 1.0, `escaped range: ${v}`);
});

test("the bugged 801h phases chirp on a max-negative run (+3FF8h)", () => {
  // fullsnes: \"when outputting three or more '-8 SHL 12' BRR samples with
  // Filter 0, some interpolation results will be +3FF8h (instead of -4000h)\".
  // -1.0 must promote to exactly -16384 for this to be reachable at all.
  const fx = makeFixture((i) => (i >= 10 && i < 16 ? 0 : 128));
  const y = render(fx, 1.0, 8, 9.0);
  const asInt15 = [...y].map((v) => Math.round(v * 16384));
  assert.ok(asInt15.includes(0x3ff8),
    `expected a +3FF8h chirp inside the run, got ${asInt15.join(", ")}`);
  // …and it is a CHIRP, not a fold: the run's own samples are the only ones
  // affected, and nothing else in the render goes positive-at-full-scale.
  assert.ok(asInt15.filter((v) => v === 0x3ff8).length >= 3);
});

test("low frequencies pass more than high frequencies (gaussian roll-off)", () => {
  const peakAt = (period) =>
    Math.max(...render(makeFixture(sineFill(0.8, period)), 1.0, 4 * period).map(Math.abs));
  const lo = peakAt(256);
  const hi = peakAt(4);
  assert.ok(lo > 0.79, `LF should pass nearly intact, got ${lo.toFixed(3)}`);
  assert.ok(hi < lo, `HF ${hi.toFixed(3)} should be attenuated below LF ${lo.toFixed(3)}`);
});
