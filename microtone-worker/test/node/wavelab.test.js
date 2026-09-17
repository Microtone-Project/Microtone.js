// Sample Lab DSP core (items 83/84/999) — float range ops, the Kaiser-sinc
// resampler (float twin of taud_common.resample_bandlimited), budget fitting,
// oversampled parametric EQ, and transient detection for the chopper.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crop, cut, repeatRange, silenceRange, fadeInRange, fadeOutRange, gainRange, normaliseRange,
  reverseRange, invertRange, removeDCRange,
  resample, planFit, fitToBudget, quantiseU8, u8ToFloat,
  biquadCoeffs, eqResponseDb, eqApply,
  detectTransients, chunksFromSplits,
  TARGET_RATE_MAX, FRAME_BUDGET,
} from "../../src/doc/wavelab.js";

const sine = (n, freq, rate, amp = 0.8) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};
const rms = (buf, a = 0, b = buf.length) => {
  let acc = 0;
  for (let i = a; i < b; i++) acc += buf[i] * buf[i];
  return Math.sqrt(acc / Math.max(1, b - a));
};
const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i / n);

// ── range ops ──────────────────────────────────────────────────────────────

test("crop/cut keep and remove the range; args clamp and swap", () => {
  const buf = ramp(10);
  assert.deepEqual([...crop(buf, 2, 5)], [...buf.slice(2, 5)]);
  assert.deepEqual([...crop(buf, 5, 2)], [...buf.slice(2, 5)], "swapped args");
  assert.deepEqual([...crop(buf, -3, 99)], [...buf], "clamped to the buffer");
  const c = cut(buf, 2, 5);
  assert.equal(c.length, 7);
  assert.deepEqual([...c], [...buf.slice(0, 2), ...buf.slice(5)]);
  assert.equal(cut(buf, 0, 10).length, 0, "cut all");
});

test("repeatRange inserts count-1 extra copies right after itself, shifting the tail; args clamp/swap, count<=1 is a no-op", () => {
  const buf = ramp(10);
  const d = repeatRange(buf, 2, 5, 2);
  assert.equal(d.length, 13, "grew by (b - a) * (count - 1)");
  assert.deepEqual([...d], [...buf.slice(0, 5), ...buf.slice(2, 5), ...buf.slice(5)],
    "[0,b) unchanged, then one [a,b) copy, then the shifted tail");
  assert.deepEqual([...repeatRange(buf, 5, 2, 2)], [...d], "swapped args");
  const d3 = repeatRange(buf, 2, 5, 3);
  assert.equal(d3.length, 16, "grew by (b - a) * (count - 1) = 6");
  assert.deepEqual([...d3], [...buf.slice(0, 5), ...buf.slice(2, 5), ...buf.slice(2, 5), ...buf.slice(5)],
    "count 3 ⇒ TWO extra copies");
  assert.deepEqual([...repeatRange(buf, 2, 5, 1)], [...buf], "count 1 is a no-op");
  assert.deepEqual([...repeatRange(buf, 2, 5, 0)], [...buf], "count < 1 clamps to 1 (no-op)");
  const whole = repeatRange(buf, 0, 10, 2);
  assert.deepEqual([...whole], [...buf, ...buf], "no selection ⇒ [0, len) ⇒ doubles the whole buffer");
  assert.deepEqual([...repeatRange(buf, -3, 99, 2)], [...whole], "clamped to the buffer");
});

test("silence/fades/gain/normalise act only inside the range", () => {
  const buf = new Float32Array(8).fill(0.5);
  const s = silenceRange(buf, 2, 4);
  assert.deepEqual([...s], [0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0.5]);

  const fi = fadeInRange(buf, 0, 8);
  assert.equal(fi[0], 0, "fade-in starts silent");
  assert.ok(Math.abs(fi[7] - 0.5) < 1e-6, "fade-in ends at unity");
  const fo = fadeOutRange(buf, 0, 8);
  assert.ok(Math.abs(fo[0] - 0.5) < 1e-6);
  assert.equal(fo[7], 0, "fade-out ends silent");
  assert.equal(fadeInRange(buf, 2, 5)[0], 0.5, "outside the range untouched");

  const g = gainRange(buf, 0, 4, 0.5);
  assert.ok(Math.abs(g[0] - 0.25) < 1e-6 && Math.abs(g[4] - 0.5) < 1e-6);

  const n = normaliseRange(Float32Array.from([0.1, -0.25, 0.2, 0.9]), 0, 3);
  assert.ok(Math.abs(n[1] + 1.0) < 1e-6, "range peak → ±1");
  assert.ok(Math.abs(n[3] - 0.9) < 1e-6, "outside untouched");
  const z = normaliseRange(new Float32Array(4), 0, 4);
  assert.deepEqual([...z], [0, 0, 0, 0], "all-zero range is a no-op, not NaN");
});

test("reverse/invert/removeDC over ranges", () => {
  const buf = ramp(6);
  const r = reverseRange(buf, 1, 5);
  assert.deepEqual([...r], [buf[0], buf[4], buf[3], buf[2], buf[1], buf[5]]);
  assert.deepEqual([...reverseRange(r, 1, 5)], [...buf], "involution");
  const inv = invertRange(buf, 0, 6);
  for (let i = 0; i < 6; i++) assert.equal(inv[i], -buf[i]);
  const dc = removeDCRange(new Float32Array(8).fill(0.25), 0, 8);
  assert.ok(Math.abs(rms(dc)) < 1e-7, "mean removed");
});

// ── resampler ──────────────────────────────────────────────────────────────

test("resample: identity ratio copies, length = ⌊n·ratio⌋, DC passes", () => {
  const buf = sine(1000, 440, 32000);
  const same = resample(buf, 1.0);
  assert.notEqual(same, buf, "new buffer");
  assert.deepEqual([...same], [...buf]);
  assert.equal(resample(buf, 2 / 3).length, Math.floor(1000 * 2 / 3));
  const dc = resample(new Float32Array(500).fill(0.5), 2 / 3);
  for (let i = 0; i < dc.length; i++) {
    assert.ok(Math.abs(dc[i] - 0.5) < 1e-3, `DC preserved at ${i}: ${dc[i]}`);
  }
});

test("resample 48k→32k: passband tone survives, above-Nyquist tone dies", () => {
  const n = 9600; // 0.2 s @ 48k
  const pass = resample(sine(n, 1000, 48000), 32000 / 48000);
  const passRms = rms(pass, 400, pass.length - 400);
  assert.ok(Math.abs(passRms / (0.8 / Math.SQRT2) - 1) < 0.05,
    `1 kHz RMS preserved within 5% (got ${passRms})`);
  // zero crossings: 1 kHz over 0.2 s ≈ 400 crossings at either rate
  let zc = 0;
  for (let i = 1; i < pass.length; i++) if ((pass[i] >= 0) !== (pass[i - 1] >= 0)) zc++;
  assert.ok(Math.abs(zc - 400) <= 4, `tone frequency preserved (zc=${zc})`);

  const alias = resample(sine(n, 20000, 48000), 32000 / 48000);
  const aliasRms = rms(alias, 400, alias.length - 400);
  assert.ok(aliasRms < 0.02, `20 kHz (above the 16 kHz target Nyquist) attenuated (got ${aliasRms})`);
});

// ── budget fitting ─────────────────────────────────────────────────────────

test("planFit: under budget keeps the rate cap, over budget squeezes to 65535", () => {
  const easy = planFit(32000, 48000);
  assert.equal(easy.rate, TARGET_RATE_MAX, "48k source capped to 32k");
  assert.equal(easy.frames, Math.floor(32000 * (32000 / 48000)));
  assert.equal(easy.squeezed, false);

  const tight = planFit(48000 * 10, 48000); // 10 s — way over budget at 32k
  assert.equal(tight.squeezed, true);
  assert.ok(tight.frames <= FRAME_BUDGET && tight.frames >= FRAME_BUDGET - 1,
    `fills the budget (got ${tight.frames})`);
  assert.ok(tight.rate < TARGET_RATE_MAX, "rate follows the squeeze");

  const custom = planFit(1000, 32000, 16000);
  assert.equal(custom.rate, 16000, "explicit target rate honoured");
  assert.equal(custom.frames, 500);
  assert.equal(planFit(100, 22050, 99999).rate, TARGET_RATE_MAX, "target rate capped to the default ceiling");
  assert.equal(planFit(100, 22050, 99999, 40000).rate, 40000,
    "a caller-supplied maxRate (item 109: re-editing an already->32k-rate pooled sample) overrides the default ceiling");
});

test("fitToBudget output length matches planFit exactly", () => {
  const buf = sine(48000 * 3, 220, 48000);
  const fit = planFit(buf.length, 48000);
  const out = fitToBudget(buf, 48000);
  assert.equal(out.data.length, fit.frames);
  assert.equal(out.rate, fit.rate);
  const long = fitToBudget(sine(48000 * 10, 220, 48000), 48000);
  assert.ok(long.data.length <= FRAME_BUDGET);
  assert.equal(long.squeezed, true);
});

test("quantiseU8/u8ToFloat: centre 0x80, clip flag, round trip", () => {
  const q = quantiseU8(Float32Array.from([0, 1, -1, 0.5, 2]));
  assert.deepEqual([...q.pcm], [128, 255, 1, 192, 255]);
  assert.equal(q.clipped, true, "2.0 clips");
  assert.equal(quantiseU8(Float32Array.from([0.9])).clipped, false);
  const f = u8ToFloat(Uint8Array.from([128, 255, 1]));
  assert.equal(f[0], 0);
  assert.ok(Math.abs(f[1] - 1) < 1e-6);
});

// ── parametric EQ ──────────────────────────────────────────────────────────

test("eqApply: peak band boosts its tone, leaves a distant tone alone; length exact", () => {
  const rate = 32000, n = 16385; // odd length exercises the oversample round trip
  const bands = [{ type: "peak", freq: 1000, gainDb: 12, q: 1.0 }];
  const inTone = sine(n, 1000, rate, 0.1);
  const boosted = eqApply(inTone, rate, bands);
  assert.equal(boosted.length, n, "length preserved through 2× oversample");
  const gainDb = 20 * Math.log10(rms(boosted, 4000, 12000) / rms(inTone, 4000, 12000));
  assert.ok(Math.abs(gainDb - 12) < 0.7, `+12 dB at centre (got ${gainDb.toFixed(2)})`);

  const farTone = sine(n, 8000, rate, 0.1);
  const far = eqApply(farTone, rate, bands);
  const farDb = 20 * Math.log10(rms(far, 4000, 12000) / rms(farTone, 4000, 12000));
  assert.ok(Math.abs(farDb) < 1.0, `8 kHz nearly untouched (got ${farDb.toFixed(2)})`);
});

test("eqResponseDb agrees with the measured gain of the applied filter", () => {
  const rate = 32000, n = 16384;
  const bands = [
    { type: "lowshelf", freq: 250, gainDb: -6 },
    { type: "peak", freq: 2000, gainDb: 6, q: 1.2 },
    { type: "highshelf", freq: 9000, gainDb: 4 },
  ];
  for (const freq of [100, 2000, 12000]) {
    const tone = sine(n, freq, rate, 0.05);
    const out = eqApply(tone, rate, bands);
    const measured = 20 * Math.log10(rms(out, 4000, 12000) / rms(tone, 4000, 12000));
    const predicted = eqResponseDb(bands, rate, freq);
    assert.ok(Math.abs(measured - predicted) < 0.8,
      `${freq} Hz: graph ${predicted.toFixed(2)} dB vs applied ${measured.toFixed(2)} dB`);
  }
});

test("eq: highpass kills rumble; disabled/zero-gain bands are a plain copy", () => {
  const rate = 32000, n = 16384;
  const rumble = sine(n, 40, rate, 0.5);
  const hp = eqApply(rumble, rate, [{ type: "highpass", freq: 300, q: 0.707 }]);
  assert.ok(rms(hp, 4000, 12000) < rms(rumble, 4000, 12000) * 0.05, "40 Hz under a 300 Hz HP");

  const buf = sine(1000, 500, rate);
  const noop = eqApply(buf, rate, [
    { type: "peak", freq: 1000, gainDb: 0 },
    { type: "peak", freq: 2000, gainDb: 12, enabled: false },
  ]);
  assert.deepEqual([...noop], [...buf], "nothing enabled → exact copy");
});

test("shelf Q is adjustable: 0.707 is maximally flat, higher Q resonates at the corner", () => {
  const rate = 32000;
  const flat = [{ type: "highshelf", freq: 4000, gainDb: 12, q: 0.707 }];
  const reso = [{ type: "highshelf", freq: 4000, gainDb: 12, q: 4.0 }];
  // Q changes the response around the corner (at the exact corner both give
  // the √A midpoint; the resonance shows on the flanks) — proves it's wired.
  const maxDiff = Math.max(...[2000, 2800, 5600, 8000].map(
    (f) => Math.abs(eqResponseDb(reso, rate, f) - eqResponseDb(flat, rate, f))));
  assert.ok(maxDiff > 1, `shelf Q shifts the flank response by >1 dB (got ${maxDiff.toFixed(2)})`);
  // …while both settle to the +12 dB plateau deep in the passband.
  assert.ok(Math.abs(eqResponseDb(reso, rate, 15000) - 12) < 1.5, "resonant shelf still plateaus at +12 dB");
  assert.ok(Math.abs(eqResponseDb(flat, rate, 15000) - 12) < 1.5, "flat shelf plateaus at +12 dB");
  // the applied render agrees with the graph for the resonant shelf near the corner
  const tone = sine(16384, 4000, rate, 0.05);
  const out = eqApply(tone, rate, reso);
  const measured = 20 * Math.log10(rms(out, 4000, 12000) / rms(tone, 4000, 12000));
  assert.ok(Math.abs(measured - eqResponseDb(reso, rate, 4000)) < 0.9,
    `graph vs applied at the resonant corner (graph ${eqResponseDb(reso, rate, 4000).toFixed(2)} vs applied ${measured.toFixed(2)})`);
});

test("biquadCoeffs rejects unknown band types", () => {
  assert.throws(() => biquadCoeffs("bandsaw", 32000, 1000));
});

// ── transient detection (item 84) ──────────────────────────────────────────

// Deterministic percussion-ish take: decaying square-wave bursts over silence.
function clickTrain(rate, seconds, hitsAtSec) {
  const buf = new Float32Array(Math.round(rate * seconds));
  for (const at of hitsAtSec) {
    const start = Math.round(at * rate);
    const dur = Math.round(rate * 0.05);
    for (let i = 0; i < dur && start + i < buf.length; i++) {
      const decay = Math.exp(-i / (rate * 0.012));
      buf[start + i] = (Math.floor(i / 16) % 2 === 0 ? 0.9 : -0.9) * decay;
    }
  }
  return buf;
}

test("detectTransients finds each hit near its onset; silence yields none", () => {
  const rate = 32000;
  const hits = [0.25, 0.75, 1.3, 1.7];
  const splits = detectTransients(clickTrain(rate, 2.0, hits), rate);
  assert.equal(splits.length, hits.length, `one split per hit (got ${splits.length})`);
  hits.forEach((h, i) => {
    assert.ok(Math.abs(splits[i] - h * rate) < rate * 0.02,
      `hit ${i} within 20 ms (got ${(splits[i] / rate).toFixed(3)}s for ${h}s)`);
  });
  assert.deepEqual(detectTransients(new Float32Array(rate), rate), [], "silence");
});

test("detectTransients: minGap merges flams", () => {
  const rate = 32000;
  const splits = detectTransients(clickTrain(rate, 1.0, [0.3, 0.33]), rate, { minGapMs: 60 });
  assert.equal(splits.length, 1, "30 ms apart under a 60 ms gap → one onset");
});

test("chunksFromSplits covers [0, len) and drops out-of-range/duplicate splits", () => {
  assert.deepEqual(chunksFromSplits(100, [30, 70]),
    [{ a: 0, b: 30 }, { a: 30, b: 70 }, { a: 70, b: 100 }]);
  assert.deepEqual(chunksFromSplits(100, []), [{ a: 0, b: 100 }]);
  assert.deepEqual(chunksFromSplits(100, [0, 100, 130, 50, 50]),
    [{ a: 0, b: 50 }, { a: 50, b: 100 }]);
});
