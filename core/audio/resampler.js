// Kaiser-windowed-sinc resampling — the ONE interpolator every rate conversion
// in the app goes through:
//
//   * the AudioWorklet's engine→context read cursor (both the local render ring
//     and the Tier 2 SAB ring) — core/worklet/taud-processor.js
//   * the offline stereo WAV + mono stem exports — core/audio/offline-render.js
//   * the streaming multichannel export — src/audio/surround-export.js
//   * the sample Lab / import knife — src/doc/wavelab.js, which is ALSO the
//     float twin of the Python converters' taud_common.resample_bandlimited
//
// β=8 (~-70 dB stop-band), 512 phases, 8..24 half-taps, cutoff following the
// ratio so a DOWN-conversion anti-aliases on the way down, each phase row
// DC-normalised so a constant passes through unchanged. Those are the Python
// original's numbers, so the app and the converters shave a sample identically.
//
// Imported by the AudioWorklet, so this file must stay bundle-safe (plain
// export forms, unique top-level names) — it is in tools/make-worklet-bundle.js.

export const RESAMP_BETA = 8.0;
export const RESAMP_PHASES = 512; // power of two: the phase index is a mask away

function resampBesselI0(x) {
  let s = 1.0, t = 1.0, k = 1;
  for (;;) {
    t *= (x * x) / (4.0 * k * k);
    s += t;
    if (t < 1e-12 * s) return s;
    k++;
  }
}

const resampRowCache = new Map();
const resampKernelCache = new Map();

/**
 * Half-taps for a conversion by `ratio` (dst/src): 12 either side, widened as a
 * downsample narrows the transition band, capped at 24 so the cost stays bounded.
 */
export function resampHalfWidth(ratio) {
  return Math.max(8, Math.min(24, Math.round(12.0 / Math.min(1.0, ratio))));
}

/**
 * Kernel rows of 2·halfWidth taps, row p being the kernel for fractional offset
 * p/phases. There are phases+1 of them: the last (frac = 1.0) is the endpoint
 * the read loops interpolate TOWARDS — see kaiserKernel. Cached, since the
 * tables are pure functions of their arguments and a handful of them cover
 * every rate pair the app ever sees.
 */
export function kaiserSincRows(cutoff, halfWidth, phases = RESAMP_PHASES) {
  const key = `${Math.round(cutoff * 1e6)}:${halfWidth}:${phases}`;
  const cached = resampRowCache.get(key);
  if (cached) return cached;
  const nTaps = 2 * halfWidth;
  const invI0 = 1.0 / resampBesselI0(RESAMP_BETA);
  const rows = [];
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    const row = new Float64Array(nTaps);
    let s = 0.0;
    for (let k = 0; k < nTaps; k++) {
      const x = (k - (halfWidth - 1)) - frac;
      const a = 2.0 * cutoff * x;
      const sinc = a === 0.0 ? 1.0 : Math.sin(Math.PI * a) / (Math.PI * a);
      const r = x / halfWidth;
      const win = resampBesselI0(RESAMP_BETA * Math.sqrt(Math.max(0.0, 1.0 - r * r))) * invI0;
      row[k] = sinc * win;
      s += row[k];
    }
    const inv = s !== 0 ? 1.0 / s : 1.0;
    for (let k = 0; k < nTaps; k++) row[k] *= inv;
    rows.push(row);
  }
  resampRowCache.set(key, rows);
  return rows;
}

/**
 * Everything a read loop needs to convert srcRate → dstRate. The tap window for
 * output position `pos` is [⌊pos⌋−history, ⌊pos⌋+lead]: `lead` FUTURE frames
 * must already be buffered, which is why the streaming callers keep a look-ahead
 * the linear cursor never needed.
 *
 * `rows` is paired with `deltas` (row p+1 − row p) so a read loop can BLEND the
 * two rows bracketing the true phase: `w = rows[p][t] + deltas[p][t]·g`. Picking
 * the nearest row instead quantises the read position to 1/2·phases of a sample,
 * and that timing jitter is a ~−52 dB noise floor at 10 kHz — audible hiss riding
 * the music, and far worse than the −70 dB stop-band the window buys. One extra
 * multiply-add per tap buys it back.
 */
export function kaiserKernel(srcRate, dstRate) {
  const cached = resampKernelCache.get(`${srcRate}:${dstRate}`);
  if (cached) return cached;
  const ratio = dstRate / srcRate;
  const halfWidth = resampHalfWidth(ratio);
  const nTaps = 2 * halfWidth;
  const rows = kaiserSincRows(0.5 * Math.min(1.0, ratio), halfWidth, RESAMP_PHASES);
  const deltas = [];
  for (let p = 0; p < RESAMP_PHASES; p++) {
    const d = new Float64Array(nTaps);
    for (let t = 0; t < nTaps; t++) d[t] = rows[p + 1][t] - rows[p][t];
    deltas.push(d);
  }
  const kernel = {
    rows,
    deltas,
    phases: RESAMP_PHASES,
    halfWidth,
    nTaps,
    history: halfWidth - 1,
    lead: halfWidth,
    step: srcRate / dstRate,
  };
  resampKernelCache.set(`${srcRate}:${dstRate}`, kernel);
  return kernel;
}

/**
 * Resample an interleaved Float32 buffer srcRate → dstRate in one go. Edge taps
 * clamp to the first/last frame (same as wavelab's whole-buffer resample).
 * Equal rates return the input untouched.
 */
export function resampleInterleaved(f32, channels, srcRate, dstRate) {
  if (srcRate === dstRate) return f32;
  const srcFrames = f32.length / channels;
  const dstFrames = Math.floor((srcFrames * dstRate) / srcRate);
  const out = new Float32Array(dstFrames * channels);
  const { rows, deltas, phases, history, nTaps, step } = kaiserKernel(srcRate, dstRate);
  const acc = new Float64Array(channels);
  const last = srcFrames - 1;
  for (let n = 0; n < dstFrames; n++) {
    const pos = n * step;
    const i0 = Math.floor(pos);
    const fp = (pos - i0) * phases;
    const p = fp | 0;
    const g = fp - p;
    const row = rows[p], dRow = deltas[p];
    const base = i0 - history;
    acc.fill(0.0);
    for (let t = 0; t < nTaps; t++) {
      let idx = base + t;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      const o = idx * channels;
      const w = row[t] + dRow[t] * g;
      for (let c = 0; c < channels; c++) acc[c] += f32[o + c] * w;
    }
    const oo = n * channels;
    for (let c = 0; c < channels; c++) out[oo + c] = acc[c];
  }
  return out;
}

/**
 * Chunk-at-a-time resampler for the multichannel export, which encodes as it
 * renders. It carries the kernel's history AND its look-ahead across the block
 * boundary — a sinc needs `lead` frames that have not been rendered yet, so
 * output lags the input by that much and `flush()` drains the tail.
 */
export class StreamResampler {
  constructor(channels, srcRate, dstRate) {
    this.channels = channels;
    this.step = srcRate / dstRate;
    this.k = srcRate === dstRate ? null : kaiserKernel(srcRate, dstRate);
    // Source position of the next output frame, relative to the current block's
    // first frame. Goes NEGATIVE (into the history) by up to the look-ahead.
    this.phase = 0.0;
    this.histFrames = this.k ? this.k.nTaps + 2 : 0;
    this.hist = new Float32Array(this.histFrames * channels);
    this.acc = new Float64Array(channels);
  }

  /** Upper bound on the output frames one `frames`-long block can produce. */
  maxOut(frames) { return Math.ceil(frames / this.step) + 2; }

  /** @returns the number of frames written into `out`. */
  process(input, frames, out) {
    const ch = this.channels;
    if (this.k === null) { // equal rates: a copy, not a filter
      out.set(input.subarray(0, frames * ch));
      return frames;
    }
    const { rows, deltas, phases, history, lead, nTaps } = this.k;
    const hist = this.hist, histFrames = this.histFrames, acc = this.acc;
    // The newest tap of output frame ⌊phase⌋ is ⌊phase⌋+lead, so stop as soon
    // as that would read past the end of this block.
    const limit = frames - 1 - lead;
    let phase = this.phase;
    let n = 0;
    while (Math.floor(phase) <= limit) {
      const i0 = Math.floor(phase);
      const fp = (phase - i0) * phases;
      const p = fp | 0;
      const g = fp - p;
      const row = rows[p], dRow = deltas[p];
      const base = i0 - history;
      acc.fill(0.0);
      for (let t = 0; t < nTaps; t++) {
        const idx = base + t;
        const w = row[t] + dRow[t] * g;
        if (idx >= 0) {
          const o = idx * ch;
          for (let c = 0; c < ch; c++) acc[c] += input[o + c] * w;
        } else {
          const o = Math.max(idx + histFrames, 0) * ch;
          for (let c = 0; c < ch; c++) acc[c] += hist[o + c] * w;
        }
      }
      const oo = n * ch;
      for (let c = 0; c < ch; c++) out[oo + c] = acc[c];
      n++;
      phase += this.step;
    }
    this.phase = phase - frames;
    // Carry the tail of this block as the next block's history (short blocks
    // push the older history along instead of replacing it).
    const carry = Math.min(histFrames, frames);
    if (carry < histFrames) hist.copyWithin(0, carry * ch);
    hist.set(input.subarray((frames - carry) * ch, frames * ch), (histFrames - carry) * ch);
    return n;
  }

  /** Emit the frames still held back by the look-ahead. Zero-padded: a render
   *  ends in silence, and a click at the very last sample is worse than a
   *  half-millisecond of decay. Call once, after the last process(). */
  flush(out) {
    if (this.k === null) return 0;
    const pad = this.k.lead + 1;
    return this.process(new Float32Array(pad * this.channels), pad, out);
  }
}
