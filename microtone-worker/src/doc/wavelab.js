// Sample Lab DSP core (items 83/84/999) — pure float-domain processing for the
// import-time sample editor. Everything here works on MONO Float32Array
// buffers (nominal ±1 range) plus a sample rate, returns NEW buffers, and
// touches no DOM — Node-tested. Length-CHANGING operations (crop/cut/resample)
// live here and ONLY here: they run at import time, before pool allocation
// (item 999 — a pool span's length is immutable once allocated). The in-place
// editor's u8 ops stay in sampledsp.js.

import { RESAMP_PHASES, resampHalfWidth, kaiserSincRows } from "../audio/resampler.js";

// Sample-rate ceiling for what lands in the pool. Deliberately BELOW the
// engine's own 48 kHz output rate (item 108): the pool is 8 MB and a record's
// sampleLength is a u16, so rate buys bandwidth at the cost of both budgets —
// and 32 kHz is also what the TSVM device plays the file back at, so a file
// written here stays honest there. Raise it if bandwidth is worth the bytes.
export const TARGET_RATE_MAX = 32000;
export const FRAME_BUDGET = 0xffff;   // record sampleLength is u16

// ── range helpers ──────────────────────────────────────────────────────────
// Every ranged op takes [a, b) in samples; out-of-order or out-of-range
// arguments clamp to the buffer, so (buf, 0, buf.length) means "all".

function clampRange(len, a, b) {
  a = Math.max(0, Math.min(len, Math.floor(a)));
  b = Math.max(0, Math.min(len, Math.floor(b)));
  return a <= b ? [a, b] : [b, a];
}

/** Keep only [a, b). */
export function crop(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  return buf.slice(a, b);
}

/** Remove [a, b), joining what surrounds it. */
export function cut(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = new Float32Array(buf.length - (b - a));
  out.set(buf.subarray(0, a), 0);
  out.set(buf.subarray(b), a);
  return out;
}

/** Insert `count - 1` extra copies of [a, b) right after itself — [0, b)
 *  unchanged, everything from `b` on shifts up by (count - 1) * (b - a).
 *  `count <= 1` is a plain copy (no-op). Mirrors `cut` (which removes and
 *  shifts DOWN): nothing is destroyed, so unlike crop/cut a caller never has
 *  to drop a position that fell inside the touched range — see samplelab.js's
 *  "extend" op, whose split/loop-marker shift is exactly this function's own
 *  arithmetic, `p => p < b ? p : p + extra`. */
export function repeatRange(buf, a, b, count) {
  [a, b] = clampRange(buf.length, a, b);
  const n = Math.max(1, Math.floor(count) || 1);
  const rangeLen = b - a;
  const extra = rangeLen * (n - 1);
  const out = new Float32Array(buf.length + extra);
  out.set(buf.subarray(0, b), 0);
  for (let i = 0; i < n - 1; i++) out.set(buf.subarray(a, b), b + i * rangeLen);
  out.set(buf.subarray(b), b + extra);
  return out;
}

/** Zero [a, b). */
export function silenceRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  out.fill(0, a, b);
  return out;
}

/** Linear fade from silence at `a` to unity at `b`. */
export function fadeInRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  const n = Math.max(1, b - a - 1);
  for (let i = a; i < b; i++) out[i] = buf[i] * ((i - a) / n);
  return out;
}

/** Linear fade from unity at `a` to silence at `b`. */
export function fadeOutRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  const n = Math.max(1, b - a - 1);
  for (let i = a; i < b; i++) out[i] = buf[i] * (1 - (i - a) / n);
  return out;
}

/** Multiply [a, b) by `factor` (linear, not dB — callers convert). */
export function gainRange(buf, a, b, factor) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  for (let i = a; i < b; i++) out[i] = buf[i] * factor;
  return out;
}

/** Scale [a, b) so its peak hits ±1 (whole-buffer peak stays the caller's
 *  business — this is per-selection like Audacity's Normalize-on-selection). */
export function normaliseRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  let peak = 0;
  for (let i = a; i < b; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  if (peak === 0) return buf.slice();
  return gainRange(buf, a, b, 1 / peak);
}

/**
 * Peak-normalise a MULTI-CHANNEL take over [a, b) with ONE shared factor, so a
 * stereo image survives the operation (per-channel normalisation would re-pan
 * everything toward the centre). One channel behaves exactly like
 * normaliseRange. Returns new buffers.
 */
export function normaliseRangeLinked(chans, a, b) {
  if (chans.length === 1) return [normaliseRange(chans[0], a, b)];
  let peak = 0;
  for (const buf of chans) {
    const [x, y] = clampRange(buf.length, a, b);
    for (let i = x; i < y; i++) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak === 0) return chans.map((c) => c.slice());
  return chans.map((c) => gainRange(c, a, b, 1 / peak));
}

/** Average of every channel — the mono fold used for downmixing a take and for
 *  analysis that needs one signal (transient detection). */
export function downmixChannels(chans) {
  if (chans.length === 1) return chans[0].slice();
  const n = chans[0].length;
  const out = new Float32Array(n);
  for (const c of chans) for (let i = 0; i < n; i++) out[i] += c[i];
  for (let i = 0; i < n; i++) out[i] /= chans.length;
  return out;
}

export function reverseRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  for (let i = a; i < b; i++) out[i] = buf[b - 1 - (i - a)];
  return out;
}

/** Polarity swap over [a, b). */
export function invertRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  for (let i = a; i < b; i++) out[i] = -buf[i];
  return out;
}

/** Subtract the mean of [a, b) from it (float twin of sampledsp removeDC). */
export function removeDCRange(buf, a, b) {
  [a, b] = clampRange(buf.length, a, b);
  const out = buf.slice();
  if (b <= a) return out;
  let sum = 0;
  for (let i = a; i < b; i++) sum += buf[i];
  const mean = sum / (b - a);
  for (let i = a; i < b; i++) out[i] = buf[i] - mean;
  return out;
}

// ── band-limited resampler ─────────────────────────────────────────────────
// Float twin of the canonical taud_common.resample_bandlimited (the converter/
// sf2taudify path). The kernel itself lives in src/audio/resampler.js — the
// same Kaiser-windowed sinc the player and the exporters run on — so the web
// import path, the converters and playback all shave samples with one knife.
// What stays here is the LENGTH contract: output = max(1, ⌊n·ratio⌋), which
// planFit's arithmetic has to agree with exactly.

const SINC_PHASES = RESAMP_PHASES;

/** Resample by `ratio` (< 1 = downsample). Output length = max(1, ⌊n·ratio⌋). */
export function resample(buf, ratio) {
  if (buf.length === 0 || ratio === 1.0) return buf.slice();
  const nIn = buf.length;
  const nOut = Math.max(1, Math.floor(nIn * ratio));
  const cutoff = 0.5 * Math.min(1.0, ratio);
  const halfWidth = resampHalfWidth(ratio);
  const table = kaiserSincRows(cutoff, halfWidth, SINC_PHASES);
  const out = new Float32Array(nOut);
  const invRatio = 1.0 / ratio;
  const last = nIn - 1;
  const nTaps = 2 * halfWidth;
  for (let i = 0; i < nOut; i++) {
    const src = i * invRatio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const row = table[(frac * SINC_PHASES) & (SINC_PHASES - 1)];
    const base = i0 - (halfWidth - 1);
    let acc = 0.0;
    for (let k = 0; k < nTaps; k++) {
      let idx = base + k;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      acc += buf[idx] * row[k];
    }
    out[i] = acc;
  }
  return out;
}

// ── budget fitting + u8 bridge ─────────────────────────────────────────────

/**
 * How a chunk of `frames` at `srcRate` lands in the taud format: resampled to
 * `targetRate` (default = source, capped `maxRate`) and, if still over
 * FRAME_BUDGET, squeezed to exactly the budget with the rate following so the
 * pitch is preserved. Pure arithmetic — the UI shows this before committing,
 * fitToBudget executes it. Returns {frames, rate, ratio, squeezed}.
 *
 * `maxRate` defaults to TARGET_RATE_MAX (the bandwidth-vs-bytes ceiling every
 * FRESH import/recording suggests) but a caller re-opening an ALREADY-pooled
 * sample whose own rate sits above that — e.g. a waveform-paint instrument
 * tuned via detune math that can legitimately declare a rate past 32 kHz
 * (item 195) — passes that sample's own rate instead, so editing and
 * re-committing it without touching the rate field can't silently retune it.
 */
export function planFit(frames, srcRate, targetRate = null, maxRate = TARGET_RATE_MAX) {
  const want = Math.max(1, Math.min(maxRate, Math.round(targetRate ?? srcRate)));
  let ratio = want / srcRate;
  let squeezed = false;
  if (Math.floor(frames * ratio) > FRAME_BUDGET) {
    ratio = FRAME_BUDGET / frames; // exact fit: ⌊frames·ratio⌋ = FRAME_BUDGET
    squeezed = true;
  }
  const outFrames = Math.max(1, Math.floor(frames * ratio));
  const rate = Math.max(1, Math.min(maxRate, Math.round(srcRate * ratio)));
  return { frames: outFrames, rate, ratio, squeezed };
}

/** Execute planFit on the buffer: {data, rate, squeezed}. */
export function fitToBudget(buf, srcRate, targetRate = null, maxRate = TARGET_RATE_MAX) {
  const fit = planFit(buf.length, srcRate, targetRate, maxRate);
  return { data: resample(buf, fit.ratio), rate: fit.rate, squeezed: fit.squeezed };
}

/** Float ±1 → u8 PCM centre 0x80 (the audiodecode quantiser). */
export function quantiseU8(buf) {
  let clipped = false;
  const pcm = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(128 + buf[i] * 127);
    if (v < 0 || v > 255) clipped = true;
    pcm[i] = Math.max(0, Math.min(255, v));
  }
  return { pcm, clipped };
}

/** u8 PCM centre 0x80 → float (seeds the Lab from a pooled sample). */
export function u8ToFloat(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] - 128) / 127;
  return out;
}

// ── parametric EQ (RBJ biquads, oversampled apply) ─────────────────────────
// Bands are {type: "highpass"|"lowshelf"|"peak"|"highshelf", freq, gainDb, q}.
// The destructive apply runs the cascade at `oversample`× the buffer rate
// (Kaiser up, filter, Kaiser down) so bell/shelf shapes near Nyquist keep
// their analogue prototype instead of cramping against the digital corner —
// that's the "oversampled EQ" of item 83. eqResponseDb evaluates the SAME
// coefficients the apply path uses, so the graph can never disagree with the
// audible result.

export function biquadCoeffs(type, rate, freq, gainDb = 0, q = 0.707) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(freq, rate / 2 * 0.999)) / rate;
  const cosw = Math.cos(w0), sinw = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === "peak") {
    const alpha = sinw / (2 * Math.max(0.05, q));
    b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A;
  } else if (type === "lowshelf" || type === "highshelf") {
    // Q-parameterised shelf: alpha = sin(w0)/(2Q). Q = 1/√2 ≈ 0.707 reproduces
    // the classic maximally-flat (S=1) shelf exactly; higher Q adds corner
    // resonance (an overshoot at the transition), lower Q a gentler slope.
    const alpha = sinw / (2 * Math.max(0.05, q));
    const twoRootAalpha = 2 * Math.sqrt(A) * alpha;
    const sgn = type === "lowshelf" ? 1 : -1;
    b0 = A * ((A + 1) - sgn * (A - 1) * cosw + twoRootAalpha);
    b1 = sgn * 2 * A * ((A - 1) - sgn * (A + 1) * cosw);
    b2 = A * ((A + 1) - sgn * (A - 1) * cosw - twoRootAalpha);
    a0 = (A + 1) + sgn * (A - 1) * cosw + twoRootAalpha;
    a1 = sgn * -2 * ((A - 1) + sgn * (A + 1) * cosw);
    a2 = (A + 1) + sgn * (A - 1) * cosw - twoRootAalpha;
  } else if (type === "highpass") {
    const alpha = sinw / (2 * Math.max(0.05, q));
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  } else {
    throw new Error(`unknown EQ band type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function coeffsFor(bands, filterRate) {
  return bands
    .filter((b) => b.enabled !== false &&
      (b.type === "highpass" || Math.abs(b.gainDb ?? 0) > 1e-6))
    .map((b) => biquadCoeffs(b.type, filterRate, b.freq, b.gainDb ?? 0, b.q ?? 0.707));
}

/** Combined cascade magnitude in dB at `freq` Hz, evaluated at the rate the
 *  apply path filters at (`rate * oversample`). */
export function eqResponseDb(bands, rate, freq, oversample = 2) {
  const fr = rate * oversample;
  let db = 0;
  for (const c of coeffsFor(bands, fr)) {
    const w = (2 * Math.PI * freq) / fr;
    const c1 = Math.cos(w), s1 = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = 1 * c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
    const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
    const mag = Math.sqrt((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
    db += 20 * Math.log10(Math.max(1e-15, mag));
  }
  return db;
}

/** Destructive EQ over [a, b) (whole buffer when omitted): oversample, run the
 *  cascade (direct form II transposed, doubles), come back down. Length is
 *  preserved exactly; a no-op band set returns a plain copy. */
export function eqApply(buf, rate, bands, { oversample = 2, a = 0, b = buf.length } = {}) {
  [a, b] = clampRange(buf.length, a, b);
  const seg = buf.slice(a, b);
  const coeffs = coeffsFor(bands, rate * oversample);
  if (coeffs.length === 0 || seg.length === 0) return buf.slice();
  const up = oversample > 1 ? resample(seg, oversample) : seg.slice();
  for (const c of coeffs) {
    let z1 = 0, z2 = 0;
    for (let i = 0; i < up.length; i++) {
      const x = up[i];
      const y = c.b0 * x + z1;
      z1 = c.b1 * x - c.a1 * y + z2;
      z2 = c.b2 * x - c.a2 * y;
      up[i] = y;
    }
  }
  let down = oversample > 1 ? resample(up, 1 / oversample) : up;
  // ⌊(⌊n·os⌋)/os⌋ can land one short of n — pad by repetition to preserve length
  if (down.length !== seg.length) {
    const fixed = new Float32Array(seg.length);
    fixed.set(down.subarray(0, Math.min(down.length, seg.length)));
    for (let i = down.length; i < seg.length; i++) fixed[i] = down[down.length - 1] ?? 0;
    down = fixed;
  }
  const out = buf.slice();
  out.set(down, a);
  return out;
}

// ── transient detection (item 84) ──────────────────────────────────────────
// Energy-onset detector for chopping a recording/loop into per-hit samples:
// 5 ms hops of first-difference RMS (the differentiator emphasises broadband
// attacks over sustained tones), an onset wherever the envelope jumps above
// `sensitivity` × the rolling pre-window average with a rising edge, refined
// back to the local envelope minimum so each split lands just before its hit.
// Deterministic; `minGapMs` merges flams. Returns interior split positions in
// samples, ascending (never 0 — chunk k spans [splits[k-1] ?? 0, splits[k] ?? n)).

export function detectTransients(buf, rate, { sensitivity = 1.8, minGapMs = 60 } = {}) {
  const hop = Math.max(32, Math.round(rate * 0.005));
  const nFrames = Math.floor(buf.length / hop);
  if (nFrames < 4) return [];

  // envelope: RMS of x[i]-x[i-1] per hop
  const env = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    let acc = 0;
    for (let i = start; i < start + hop; i++) {
      const d = buf[i] - (i > 0 ? buf[i - 1] : 0);
      acc += d * d;
    }
    env[f] = Math.sqrt(acc / hop);
  }
  let globalMean = 0;
  for (let f = 0; f < nFrames; f++) globalMean += env[f];
  globalMean /= nFrames;
  const floor = Math.max(1e-6, globalMean * 0.05); // ignore near-silence wobble

  const PRE = 8; // rolling pre-window (~40 ms) the onset must jump above
  const minGap = Math.max(1, Math.round((minGapMs / 1000) * rate));
  const splits = [];
  let lastPos = -minGap;
  for (let f = 2; f < nFrames; f++) {
    let pre = 0, cnt = 0;
    for (let k = Math.max(0, f - PRE); k < f; k++) { pre += env[k]; cnt++; }
    pre = Math.max(floor, pre / cnt);
    if (env[f] > sensitivity * pre && env[f] > env[f - 1]) {
      // refine: walk back down the attack ramp (frames that are quieter but
      // still part of the rise — STRICTLY rising and above a quarter of their
      // successor, so flat silence stops the walk immediately), capped at the
      // pre-window so a long crescendo can't drag the split away
      let m = f;
      const stop = Math.max(1, f - PRE);
      while (m > stop && env[m - 1] < env[m] && env[m - 1] > 0.25 * env[m]) m--;
      const pos = m * hop;
      if (pos - lastPos >= minGap && pos > 0) {
        splits.push(pos);
        lastPos = pos;
        f = Math.min(nFrames - 1, Math.floor((pos + minGap) / hop));
      }
    }
  }
  return splits;
}

/** Chunk list from split positions: [{a, b}] covering [0, len). */
export function chunksFromSplits(len, splits) {
  const edges = [0, ...splits.filter((p) => p > 0 && p < len).sort((x, y) => x - y), len];
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    if (edges[i + 1] > edges[i]) out.push({ a: edges[i], b: edges[i + 1] });
  }
  return out;
}
