// Loudness and delivery metering (item 178) — the numbers the Mastering view
// draws, and the numbers its measure-and-set buttons act on.
//
// The split here follows the same rule the master-strip tap (analysis.js)
// follows: the ENGINE ships sums, the caller owns the windows and the look. So
// this file holds two kinds of thing —
//
//   * the per-sample filters a loudness measurement needs (K-weighting, the
//     phase-scrambling all-pass cascade), which run on the audio thread inside
//     the metering tap; and
//   * the integrators and gates that turn a stream of per-interval sums into
//     LUFS, LRA, crest and a bit histogram, which run wherever the caller is —
//     the UI for the live meters, the offline analyser for the time plots.
//
// Nothing in here is a judgement. A number is reported, its units are named,
// and what it means for the music is the composer's business.
//
// ── References ──
// Loudness is ITU-R BS.1770-4 / EBU R 128: K-weighted mean square, −0.691 dB
// offset, 400 ms momentary and 3 s short-term windows, and the two-stage gate
// (absolute −70 LUFS, then relative at −10 LU) for the integrated figure. LRA
// is EBU Tech 3342: 3 s windows, a −20 LU relative gate, and the span from the
// 10th to the 95th percentile.
//
// The all-pass cascade is NOT from a standard. It is this project's own, and it
// is spelled out in TAUD_ENGINE_SPEC.md so a second implementation can produce
// the same figure; see PHASE_SCRAMBLE_HZ for what it is for.

import { TruePeakDetector } from "./analysis.js";

// ── K-weighting (BS.1770) ───────────────────────────────────────────────────
// Two sections: a high-frequency shelf standing in for the head's acoustics,
// then the RLB high-pass. The standard tabulates coefficients at 48 kHz only,
// so they are DERIVED here from the analogue prototype and the bilinear
// transform — that way 32 kHz (the engine's other rate) is measured properly
// rather than with 48 kHz numbers used out of place.

/** Shelf prototype: corner, gain and Q of BS.1770's stage 1. */
const KW_SHELF_F0 = 1681.974450955533;
const KW_SHELF_G = 3.999843853973347;
const KW_SHELF_Q = 0.7071752369554196;
/** …and the exponent relating the shelf's mid gain to its high gain. */
const KW_SHELF_VB_EXP = 0.4996667741545416;
/** RLB high-pass prototype: corner and Q of BS.1770's stage 2. */
const KW_HP_F0 = 38.13547087602444;
const KW_HP_Q = 0.5003270373238773;

/** The −0.691 dB offset BS.1770 applies so a reference signal reads its own level. */
export const LUFS_OFFSET_DB = -0.691;
/** Absolute gate, in LUFS: blocks quieter than this never count. */
export const GATE_ABSOLUTE_LUFS = -70;
/** Relative gate for the integrated figure, in LU below the ungated mean. */
export const GATE_RELATIVE_LU = -10;
/** …and the wider one LRA uses. */
export const LRA_RELATIVE_LU = -20;

/**
 * BS.1770 stage 1 + stage 2 coefficients for `rate`, as two
 * {b0,b1,b2,a1,a2} records normalised to a0.
 */
export function kWeightingCoefficients(rate) {
  // Stage 1 — high-frequency shelf.
  const k1 = Math.tan((Math.PI * KW_SHELF_F0) / rate);
  const vh = 10 ** (KW_SHELF_G / 20);
  const vb = vh ** KW_SHELF_VB_EXP;
  const d1 = 1 + k1 / KW_SHELF_Q + k1 * k1;
  const shelf = {
    b0: (vh + (vb * k1) / KW_SHELF_Q + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - vh)) / d1,
    b2: (vh - (vb * k1) / KW_SHELF_Q + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / KW_SHELF_Q + k1 * k1) / d1,
  };
  // Stage 2 — RLB high-pass. Its numerator is the ideal (1, −2, 1).
  const k2 = Math.tan((Math.PI * KW_HP_F0) / rate);
  const d2 = 1 + k2 / KW_HP_Q + k2 * k2;
  const hp = {
    b0: 1, b1: -2, b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / KW_HP_Q + k2 * k2) / d2,
  };
  return [shelf, hp];
}

/** One channel's K-weighting filter pair, Direct Form I. */
export class KWeighting {
  constructor(rate) {
    const [shelf, hp] = kWeightingCoefficients(rate);
    this.s = shelf;
    this.h = hp;
    this.reset();
  }

  reset() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;   // stage 1
    this.u1 = 0; this.u2 = 0; this.v1 = 0; this.v2 = 0;   // stage 2
  }

  /** Feed one sample, get the K-weighted sample back. */
  run(x) {
    const s = this.s;
    const y = s.b0 * x + s.b1 * this.x1 + s.b2 * this.x2 - s.a1 * this.y1 - s.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    const h = this.h;
    const v = h.b0 * y + h.b1 * this.u1 + h.b2 * this.u2 - h.a1 * this.v1 - h.a2 * this.v2;
    this.u2 = this.u1; this.u1 = y;
    this.v2 = this.v1; this.v1 = v;
    return v;
  }
}

/** LUFS from a K-weighted mean square summed over the channels of a pair. */
export function lufsFromMeanSquare(sumOfChannelMeanSquares) {
  if (!(sumOfChannelMeanSquares > 0)) return -Infinity;
  return LUFS_OFFSET_DB + 10 * Math.log10(sumOfChannelMeanSquares);
}

// ── Phase-scrambling all-pass cascade ───────────────────────────────────────
//
// WHY: a clipped or hard-limited mix has flat tops, and a flat top has a LOW
// crest factor — the peak has been carved off while the energy stayed. Run the
// same signal through a cascade of all-pass sections and the magnitude spectrum
// is untouched while the phases are scattered; the flat tops become peaks again
// and the crest factor jumps back up. The GAP between the two crest figures is
// therefore a direct reading of how much peak the processing has eaten, which
// is the measurement MasVis made famous.
//
// The cascade below is this project's own definition, not MasVis's: eight
// second-order all-pass sections at octave spacing from 31.25 Hz to 4 kHz, all
// at Q = 0.5. Octave spacing puts a phase rotation in every part of the band a
// mix has energy in, and Q = 0.5 makes each rotation broad rather than local.

export const PHASE_SCRAMBLE_HZ = Object.freeze([31.25, 62.5, 125, 250, 500, 1000, 2000, 4000]);
export const PHASE_SCRAMBLE_Q = 0.5;

/** The cascade, one channel, Direct Form I. */
export class PhaseScrambler {
  constructor(rate) {
    const n = PHASE_SCRAMBLE_HZ.length;
    this.n = n;
    this.b0 = new Float64Array(n);
    this.b1 = new Float64Array(n);
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * Math.min(PHASE_SCRAMBLE_HZ[i], rate * 0.49)) / rate;
      const alpha = Math.sin(w) / (2 * PHASE_SCRAMBLE_Q);
      const a0 = 1 + alpha;
      // All-pass: b = (1−α, −2cos w, 1+α), a = (1+α, −2cos w, 1−α). Normalised,
      // b2 is 1 and a1 mirrors b1, so only three numbers need storing.
      this.b0[i] = (1 - alpha) / a0;
      this.b1[i] = (-2 * Math.cos(w)) / a0;
      this.a1[i] = (-2 * Math.cos(w)) / a0;
      this.a2[i] = (1 - alpha) / a0;
    }
    this.x1 = new Float64Array(n); this.x2 = new Float64Array(n);
    this.y1 = new Float64Array(n); this.y2 = new Float64Array(n);
    this.reset();
  }

  reset() { this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0); }

  run(x) {
    let v = x;
    for (let i = 0; i < this.n; i++) {
      const y = this.b0[i] * v + this.b1[i] * this.x1[i] + this.x2[i] -
        this.a1[i] * this.y1[i] - this.a2[i] * this.y2[i];
      this.x2[i] = this.x1[i]; this.x1[i] = v;
      this.y2[i] = this.y1[i]; this.y1[i] = y;
      v = y;
    }
    return v;
  }
}

// ── dB helpers ──────────────────────────────────────────────────────────────

/** Amplitude → dBFS, with a floor rather than −Infinity so a bar can draw it. */
export function dbfs(x, floor = -144) {
  const a = x < 0 ? -x : x;
  return a > 0 ? Math.max(20 * Math.log10(a), floor) : floor;
}

/** Crest factor of a block, in dB: peak over RMS. Zero for silence. */
export function crestDb(peak, meanSquare) {
  if (!(meanSquare > 0) || !(peak > 0)) return 0;
  return 20 * Math.log10(peak / Math.sqrt(meanSquare));
}

// ── Integration ─────────────────────────────────────────────────────────────

/** Length of one accumulation frame, in seconds. Every window this file
 *  reports is a whole number of these: 400 ms momentary is four, 3 s short-term
 *  is thirty, and the gated figures hop by one. */
export const FRAME_SEC = 0.1;

/**
 * Turns a stream of per-interval sums into every loudness figure the view
 * shows. Feed it whatever intervals you have — a 16 ms snapshot, a 128-frame
 * render chunk — and it packs them into 100 ms frames itself, so the reading
 * does not depend on how the audio arrived.
 *
 * `capFrames` bounds the frame history a live meter accumulates (the integrated
 * figure needs all of it). The default is a bit over five hours, which is long
 * enough that no session reaches it and short enough that nothing leaks.
 */
export class LoudnessIntegrator {
  constructor(rate, { capFrames = 200000 } = {}) {
    this.rate = rate;
    this.frameSamples = Math.max(1, Math.round(FRAME_SEC * rate));
    this.capFrames = capFrames;
    /** Per-frame K-weighted mean square, channel-summed (the BS.1770 `z`). */
    this.frames = [];
    /** …and the same frames' plain (unweighted) mean square and peak, which is
     *  what the crest and PLR readings are built from. */
    this.framePeak = [];
    this.frameMs = [];
    this.reset();
  }

  reset() {
    this.frames.length = 0;
    this.framePeak.length = 0;
    this.frameMs.length = 0;
    this._accZ = 0;
    this._accMs = 0;
    this._accPeak = 0;
    this._accN = 0;
    this.truePeak = 0;
    this.samplePeak = 0;
  }

  /**
   * Add one interval.
   * @param sumZ  Σ over the interval of (K-weighted L² + K-weighted R²)
   * @param sumSq Σ over the interval of (L² + R²) — unweighted
   * @param peak  largest |sample| in the interval, either channel
   * @param truePeak  largest 4×-oversampled magnitude, or 0 if not measured
   * @param n     samples in the interval
   */
  push(sumZ, sumSq, peak, truePeak, n) {
    if (!(n > 0)) return;
    if (peak > this.samplePeak) this.samplePeak = peak;
    if (truePeak > this.truePeak) this.truePeak = truePeak;
    this._accZ += sumZ;
    this._accMs += sumSq;
    if (peak > this._accPeak) this._accPeak = peak;
    this._accN += n;
    while (this._accN >= this.frameSamples) {
      // The interval that completes a frame usually overruns it. Splitting the
      // sums proportionally is the honest reading — they are sums of squares,
      // so a share of the samples is a share of the energy.
      const share = this.frameSamples / this._accN;
      const z = this._accZ * share;
      const ms = this._accMs * share;
      this._pushFrame(z / this.frameSamples, ms / this.frameSamples, this._accPeak);
      this._accZ -= z;
      this._accMs -= ms;
      this._accN -= this.frameSamples;
      // The peak is not divisible; it belongs to both frames it straddles.
    }
    if (this._accN === 0) this._accPeak = 0;
  }

  _pushFrame(z, ms, peak) {
    if (this.frames.length >= this.capFrames) {
      this.frames.shift(); this.frameMs.shift(); this.framePeak.shift();
    }
    this.frames.push(z);
    this.frameMs.push(ms);
    this.framePeak.push(peak);
  }

  /** Mean of the last `sec` seconds of frames as LUFS; −Infinity when there is
   *  not a whole window yet, so a meter can say "—" rather than a wrong number. */
  window(sec) {
    const need = Math.round(sec / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return -Infinity;
    let s = 0;
    for (let i = n - need; i < n; i++) s += this.frames[i];
    return lufsFromMeanSquare(s / need);
  }

  /** 400 ms window (BS.1770 momentary). */
  get momentary() { return this.window(0.4); }
  /** 3 s window (BS.1770 short-term). */
  get shortTerm() { return this.window(3); }

  /** Every 400 ms block on a 100 ms hop, as LUFS. */
  blocks(sec = 0.4) {
    const need = Math.round(sec / FRAME_SEC);
    const out = [];
    if (this.frames.length < need) return out;
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    out.push(lufsFromMeanSquare(s / need));
    for (let i = need; i < this.frames.length; i++) {
      s += this.frames[i] - this.frames[i - need];
      out.push(lufsFromMeanSquare(s / need));
    }
    return out;
  }

  /**
   * Gated integrated loudness (BS.1770 / R 128). Two passes: drop everything
   * below −70 LUFS, take the mean of what is left, then drop everything more
   * than 10 LU below THAT and take the mean again.
   */
  get integrated() {
    const need = Math.round(0.4 / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return -Infinity;
    const zs = [];
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    zs.push(s / need);
    for (let i = need; i < n; i++) { s += this.frames[i] - this.frames[i - need]; zs.push(s / need); }
    return gatedMean(zs, GATE_RELATIVE_LU);
  }

  /** Loudness range (EBU Tech 3342), in LU. */
  get range() {
    const need = Math.round(3 / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return 0;
    const zs = [];
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    zs.push(s / need);
    for (let i = need; i < n; i++) { s += this.frames[i] - this.frames[i - need]; zs.push(s / need); }
    return loudnessRange(zs);
  }

  /** Peak-to-loudness ratio, in LU: how much headroom the peaks keep over the
   *  integrated level. Falls as a master is squashed, which is exactly what
   *  makes it worth watching. */
  get plr() {
    const i = this.integrated;
    if (!Number.isFinite(i)) return NaN;
    const p = this.truePeak > 0 ? this.truePeak : this.samplePeak;
    if (!(p > 0)) return NaN;
    return 20 * Math.log10(p) - i;
  }
}

/** The two-pass gate, over an array of block mean squares. */
export function gatedMean(zs, relativeLu) {
  const absolute = 10 ** ((GATE_ABSOLUTE_LUFS - LUFS_OFFSET_DB) / 10);
  let sum = 0, count = 0;
  for (const z of zs) if (z > absolute) { sum += z; count++; }
  if (count === 0) return -Infinity;
  const relative = (sum / count) * 10 ** (relativeLu / 10);
  const gate = Math.max(absolute, relative);
  sum = 0; count = 0;
  for (const z of zs) if (z > gate) { sum += z; count++; }
  if (count === 0) return -Infinity;
  return lufsFromMeanSquare(sum / count);
}

/** EBU Tech 3342 loudness range from an array of 3 s block mean squares. */
export function loudnessRange(zs) {
  const absolute = 10 ** ((GATE_ABSOLUTE_LUFS - LUFS_OFFSET_DB) / 10);
  let sum = 0, count = 0;
  for (const z of zs) if (z > absolute) { sum += z; count++; }
  if (count === 0) return 0;
  const gate = Math.max(absolute, (sum / count) * 10 ** (LRA_RELATIVE_LU / 10));
  const kept = [];
  for (const z of zs) if (z > gate) kept.push(lufsFromMeanSquare(z));
  if (kept.length < 2) return 0;
  kept.sort((a, b) => a - b);
  return percentile(kept, 0.95) - percentile(kept, 0.10);
}

/** Linear-interpolated percentile of a SORTED array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return -Infinity;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ── Bit usage ───────────────────────────────────────────────────────────────

/**
 * How much of the delivered code space a render actually touches.
 *
 * "How many codes did this song use?" is a real question about the FILE rather
 * than a curiosity: a mix that peaks at −12 dBFS throws away two of its bits
 * before any dither gets a say, and the histogram shows it as a narrow spike
 * instead of a spread. At 16 bits `used` against `span` is a second reading —
 * a dense span is a signal that has really been processed at that depth, and a
 * gappy one is a coarser source blown up to fit.
 *
 * @param hist  a census of length 2^depth, indexed by the delivered code
 * @param depth bits per sample the census was taken at
 * @returns {{used, span, effectiveBits, entropyBits, total, peakCode, minCode, maxCode}}
 *   `used` counts codes that occur at all, `span` is max−min+1 (the range the
 *   signal swings over), `effectiveBits` is log2 of that span, and
 *   `entropyBits` is the Shannon entropy of the code distribution — the honest
 *   "how many bits is this actually carrying" figure, always ≤ effectiveBits.
 */
export function bitUsage(hist, depth = 8) {
  const codes = 1 << depth;
  const mid = codes >> 1;
  let total = 0, used = 0, minCode = -1, maxCode = -1, peakCode = 0, peakCount = -1;
  for (let i = 0; i < codes; i++) {
    const c = hist[i];
    if (c > 0) {
      used++;
      if (minCode < 0) minCode = i;
      maxCode = i;
      total += c;
      if (c > peakCount) { peakCount = c; peakCode = i; }
    }
  }
  if (total === 0) {
    return { used: 0, span: 0, effectiveBits: 0, entropyBits: 0, total: 0,
             peakCode: mid, minCode: mid, maxCode: mid };
  }
  let h = 0;
  for (let i = 0; i < codes; i++) {
    const c = hist[i];
    if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  }
  const span = maxCode - minCode + 1;
  return {
    used, span, total, peakCode, minCode, maxCode,
    effectiveBits: Math.log2(span),
    entropyBits: h,
  };
}

/** Display depths the bit-usage census can be taken at. 16 is what a stereo
 *  WAV export writes (straight off the float bus); 8 is what the Taud device
 *  itself delivers, dither and all. */
export const BIT_DEPTHS = Object.freeze([16, 8]);
export const DEFAULT_BIT_DEPTH = 16;
/** Buckets the census is downsampled to for the wire and the picture. At 8 bits
 *  a bucket IS a code; at 16 it is the code's top eight bits, which is the same
 *  shape drawn at the same width. */
export const HIST_BUCKETS = 256;

// ── The metering tap ────────────────────────────────────────────────────────

/** Tap stages. The view shows one at a time; the tap always measures both, so
 *  the toggle is instant and the two figures describe the SAME moment. */
export const TAP_PRE = 0;
export const TAP_POST = 1;
export const TAP_STAGES = 2;

/**
 * Frames of mono audio the tap keeps per stage, for whoever wants a SPECTRUM
 * rather than a level.
 *
 * 2048 is one analysis window at the sizes fft.js uses — 43 ms at 48 kHz, 23 Hz
 * a bin — which is all a live spectrometer needs, and it is what the offline
 * analyser reads its samples out of a chunk at a time. Mono (the L+R sum): a
 * spectrum display asks where the energy is, not which side it came from, and
 * one ring is half the wire and half the transform.
 */
export const SPEC_FRAMES = 2048;

/**
 * Everything the Mastering view's live readouts need, measured on the device
 * stereo pair on both sides of the chain.
 *
 * It is deliberately NOT the master strip's tap (analysis.js). That one answers
 * "where is the energy in the room?" and follows the song's surround model;
 * this one answers "what is going into the file, and what did the chain do to
 * it?", which is a question about two specific points in the signal path and
 * about the pair that gets dithered. Running both at once costs a few biquads
 * and buys an A/B that needs no re-render.
 *
 * Per stage, per channel: sample peak, true peak (4× oversampled), mean square
 * and a clip count. Per stage: the K-weighted energy the loudness figures are
 * built from. Post only: the histogram of the delivered 8-bit codes, because
 * "bit usage" is a question about the file and the pre-chain signal is not one.
 *
 * COST: opt-in, like every other tap here. It exists only while the Mastering
 * view is on screen.
 */
export class MasterMeterTap {
  /**
   * @param rate      engine sampling rate
   * @param scramble  also measure the phase-scrambled peak and energy, for the
   *                  crest-gap reading. OFF for the live meters: eight biquads
   *                  per channel per stage is real work for a figure whose
   *                  whole point is a comparison over a WHOLE song, which is
   *                  the offline analyser's job.
   */
  constructor(rate, { scramble = false, bitDepth = DEFAULT_BIT_DEPTH } = {}) {
    this.rate = rate;
    this.scramble = scramble;
    /** Which delivered format the bit-usage census describes. See binOutput. */
    this.bitDepth = bitDepth === 8 ? 8 : 16;
    this.kw = [];
    this.tp = [];
    this.ap = [];
    for (let s = 0; s < TAP_STAGES; s++) {
      this.kw.push([new KWeighting(rate), new KWeighting(rate)]);
      this.tp.push(new TruePeakDetector(2));
      this.ap.push(scramble ? [new PhaseScrambler(rate), new PhaseScrambler(rate)] : null);
    }
    /** Phase-scrambled peak and Σ x², per stage (channel-summed). */
    this.apPeak = new Float64Array(TAP_STAGES);
    this.apSumSq = new Float64Array(TAP_STAGES);
    this.sumZ = new Float64Array(TAP_STAGES);        // channel-summed K-weighted
    this.sumSq = new Float64Array(TAP_STAGES * 2);   // [stage][channel]
    this.peak = new Float64Array(TAP_STAGES * 2);
    this.clip = new Float64Array(TAP_STAGES * 2);
    // A census of the delivered CODE, at the chosen depth: 256 entries for the
    // device's 8-bit output, 65536 for a 16-bit WAV. Never shipped whole — the
    // drain downsamples it to HIST_BUCKETS for the picture and computes the
    // figures from the full-resolution original.
    this.hist = new Float64Array(1 << this.bitDepth);
    this.buckets = new Float64Array(HIST_BUCKETS);
    /** Per-stage mono ring + its shared write cursor (both stages advance
     *  together, since they see the same block). Read backwards from
     *  `specWrite`, exactly like the strip's scope ring. */
    this.spec = [];
    for (let s = 0; s < TAP_STAGES; s++) this.spec.push(new Float32Array(SPEC_FRAMES));
    this.specWrite = 0;
    this.frames = 0;
    this.compGrDb = 0;
    this.limGrDb = 0;
  }

  /** Clear the filters AND the accumulators — what a transport reset owes a
   *  meter whose integration is supposed to describe one playback. */
  resetAll() {
    for (const pair of this.kw) for (const k of pair) k.reset();
    for (const d of this.tp) d.reset();
    for (const pair of this.ap) if (pair) for (const a of pair) a.reset();
    this.sumZ.fill(0); this.sumSq.fill(0); this.peak.fill(0); this.clip.fill(0);
    this.apPeak.fill(0); this.apSumSq.fill(0);
    this.hist.fill(0);
    for (const r of this.spec) r.fill(0);
    this.specWrite = 0;
    this.frames = 0;
    this.compGrDb = 0;
    this.limGrDb = 0;
  }

  /**
   * Fold one rendered block in at `stage`. Called twice per chunk with the SAME
   * buffer — once before the chain runs over it and once after — so no copy of
   * the pre-chain mix is ever made.
   */
  push(stage, left, right, frames) {
    const kw = this.kw[stage];
    const tp = this.tp[stage];
    const so = stage * 2;
    let z = this.sumZ[stage];
    let sqL = this.sumSq[so], sqR = this.sumSq[so + 1];
    let pkL = this.peak[so], pkR = this.peak[so + 1];
    let clL = this.clip[so], clR = this.clip[so + 1];
    for (let n = 0; n < frames; n++) {
      const l = left[n];
      const r = right[n];
      const zl = kw[0].run(l);
      const zr = kw[1].run(r);
      z += zl * zl + zr * zr;
      sqL += l * l; sqR += r * r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      // At and above full scale the delivered sample is a clipped one: the mix
      // bus is hard-clamped, so the pre-chain signal reaching ±1 is exactly the
      // material the chain is there to catch.
      if (al >= 1) clL += 1;
      if (ar >= 1) clR += 1;
      tp.push(0, l);
      tp.push(1, r);
    }
    if (this.scramble) {
      const ap = this.ap[stage];
      let apk = this.apPeak[stage];
      let asq = this.apSumSq[stage];
      for (let n = 0; n < frames; n++) {
        const sl = ap[0].run(left[n]);
        const sr = ap[1].run(right[n]);
        const a = Math.abs(sl) > Math.abs(sr) ? Math.abs(sl) : Math.abs(sr);
        if (a > apk) apk = a;
        asq += sl * sl + sr * sr;
      }
      this.apPeak[stage] = apk;
      this.apSumSq[stage] = asq;
    }
    // The mono ring. The write cursor belongs to the POST pass, which is the
    // second of the two and therefore the one that has seen a whole block —
    // PRE writes at the same positions on the way past.
    const ring = this.spec[stage];
    let w = this.specWrite;
    for (let n = 0; n < frames; n++) {
      ring[w] = (left[n] + right[n]) * 0.5;
      w = w + 1 === SPEC_FRAMES ? 0 : w + 1;
    }
    if (stage === TAP_POST) this.specWrite = w;

    this.sumZ[stage] = z;
    this.sumSq[so] = sqL; this.sumSq[so + 1] = sqR;
    this.peak[so] = pkL; this.peak[so + 1] = pkR;
    this.clip[so] = clL; this.clip[so + 1] = clR;
    if (stage === TAP_POST) this.frames += frames;
  }

  /**
   * Bin one block of delivered output. Both channels go into ONE census — the
   * question is what codes the file uses, not which side used them.
   *
   * The two depths come from two different places, deliberately:
   *
   *   * 8 bits is the DEVICE's output, so it is binned from the dithered,
   *     noise-shaped U8 buffer the engine actually produced. Re-quantising the
   *     float would miss the dither, which at eight bits is most of the point.
   *   * 16 bits is what a stereo WAV export writes, and that path takes the
   *     PRE-DITHER float bus straight to `round(clamp(x) × 32767)` — so the
   *     census repeats exactly that. (An export resampled to another rate
   *     re-quantises after the resampler; at the default 48 kHz, which is the
   *     engine's own rate, the codes are identical.)
   */
  binOutput(u8, left, right, frames) {
    const h = this.hist;
    if (this.bitDepth === 8) {
      for (let i = 0; i < frames * 2; i++) h[u8[i]] += 1;
      return;
    }
    for (let n = 0; n < frames; n++) {
      const l = left[n], r = right[n];
      h[(Math.round((l < -1 ? -1 : l > 1 ? 1 : l) * 32767) + 32768) & 0xffff] += 1;
      h[(Math.round((r < -1 ? -1 : r > 1 ? 1 : r) * 32767) + 32768) & 0xffff] += 1;
    }
  }

  /** Snapshot readout; resets the per-interval accumulators. The histogram is
   *  cumulative and is NOT reset here — it describes the playback so far, and
   *  the host clears it when playback restarts. */
  drain(out) {
    out.frames = this.frames;
    for (let s = 0; s < TAP_STAGES; s++) {
      out.sumZ[s] = this.sumZ[s];
      for (let c = 0; c < 2; c++) {
        const i = s * 2 + c;
        const tp = this.tp[s].peaks[c];
        out.peak[i] = this.peak[i];
        out.truePeak[i] = tp > this.peak[i] ? tp : this.peak[i];
        out.meanSquare[i] = this.frames > 0 ? this.sumSq[i] / this.frames : 0;
        out.clip[i] = this.clip[i];
      }
    }
    for (let s = 0; s < TAP_STAGES; s++) {
      out.apPeak[s] = this.apPeak[s];
      out.apSumSq[s] = this.apSumSq[s];
    }
    out.compGrDb = this.compGrDb;
    out.limGrDb = this.limGrDb;
    out.hist = this.hist;
    out.bitDepth = this.bitDepth;
    // The figures come from the FULL census — an exact `used` and `span` at 16
    // bits cannot be recovered from 256 buckets — and only the buckets go on
    // the wire. One walk does both.
    out.bits = bitUsage(this.hist, this.bitDepth);
    const shift = this.bitDepth - 8;
    this.buckets.fill(0);
    if (shift === 0) this.buckets.set(this.hist);
    else for (let i = 0; i < this.hist.length; i++) this.buckets[i >> shift] += this.hist[i];
    out.buckets = this.buckets;
    out.spec = this.spec;
    out.specWrite = this.specWrite;
    this.sumZ.fill(0); this.sumSq.fill(0); this.peak.fill(0); this.clip.fill(0);
    this.apPeak.fill(0); this.apSumSq.fill(0);
    for (const d of this.tp) d.clearPeaks();
    this.frames = 0;
    this.compGrDb = 0;
    this.limGrDb = 0;
    return out;
  }
}

/** A drain target, so the snapshot fill allocates nothing. */
export function makeMasterMeterReadout() {
  return {
    frames: 0, compGrDb: 0, limGrDb: 0, hist: null, histTotal: 0,
    buckets: null, bits: null, bitDepth: DEFAULT_BIT_DEPTH,
    spec: null, specWrite: 0,
    sumZ: new Float64Array(TAP_STAGES),
    apPeak: new Float64Array(TAP_STAGES),
    apSumSq: new Float64Array(TAP_STAGES),
    peak: new Float64Array(TAP_STAGES * 2),
    truePeak: new Float64Array(TAP_STAGES * 2),
    meanSquare: new Float64Array(TAP_STAGES * 2),
    clip: new Float64Array(TAP_STAGES * 2),
  };
}
