// Loudness and delivery metering (item 178) — the numbers the Mastering view
// draws, and the numbers its measure-and-set buttons act on.
//
// The split follows the master strip's rule: the ENGINE ships sums, the caller
// owns the windows and the look. The tap — the per-sample filters a loudness
// measurement needs (K-weighting, the phase-scrambling all-pass cascade), the
// peaks, the code census — is the engine's (core/engine/c/src/meters.c, which
// says how each is defined). Here are the integrators and gates that turn its
// stream of per-interval sums into LUFS, LRA and crest, which run wherever the
// caller is — the UI for the live meters, the offline analyser for the time
// plots — and the tap's shape as the page reads it.
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
// The all-pass cascade is NOT from a standard: it is this project's own, and
// meters.c spells it out — section frequencies and Q — so that a second
// implementation can produce the same figure. It is metering, not playback, so
// it is defined there rather than in TAUD_ENGINE_SPEC.md: no two renders of a
// song differ because of it.

/** The −0.691 dB offset BS.1770 applies so a reference signal reads its own level. */
export const LUFS_OFFSET_DB = -0.691;
/** Absolute gate, in LUFS: blocks quieter than this never count. */
export const GATE_ABSOLUTE_LUFS = -70;
/** Relative gate for the integrated figure, in LU below the ungated mean. */
export const GATE_RELATIVE_LU = -10;
/** …and the wider one LRA uses. */
export const LRA_RELATIVE_LU = -20;

/** LUFS from a K-weighted mean square summed over the channels of a pair. */
export function lufsFromMeanSquare(sumOfChannelMeanSquares) {
  if (!(sumOfChannelMeanSquares > 0)) return -Infinity;
  return LUFS_OFFSET_DB + 10 * Math.log10(sumOfChannelMeanSquares);
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
  get range() { return this.rangeBounds.range; }

  /**
   * …and WHERE it sits: the 10th and 95th percentile themselves, in LUFS, so a
   * meter can draw the range on its own axis instead of only printing its
   * width. `range` is `high - low`, and both are -Infinity when there is not
   * enough gated material to have a range at all.
   */
  get rangeBounds() {
    const need = Math.round(3 / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return EMPTY_RANGE;
    const zs = [];
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    zs.push(s / need);
    for (let i = need; i < n; i++) { s += this.frames[i] - this.frames[i - need]; zs.push(s / need); }
    return loudnessRangeBounds(zs);
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

/** What `loudnessRangeBounds` answers when there is no range to speak of. */
const EMPTY_RANGE = Object.freeze({ low: -Infinity, high: -Infinity, range: 0 });

/**
 * EBU Tech 3342 loudness range from an array of 3 s block mean squares, as the
 * two percentiles it is the distance BETWEEN: `{low, high, range}` in LUFS and
 * LU. The standard only ever names the distance, but a meter that draws the
 * range needs to know where to put it.
 */
export function loudnessRangeBounds(zs) {
  const absolute = 10 ** ((GATE_ABSOLUTE_LUFS - LUFS_OFFSET_DB) / 10);
  let sum = 0, count = 0;
  for (const z of zs) if (z > absolute) { sum += z; count++; }
  if (count === 0) return EMPTY_RANGE;
  const gate = Math.max(absolute, (sum / count) * 10 ** (LRA_RELATIVE_LU / 10));
  const kept = [];
  for (const z of zs) if (z > gate) kept.push(lufsFromMeanSquare(z));
  if (kept.length < 2) return EMPTY_RANGE;
  kept.sort((a, b) => a - b);
  const low = percentile(kept, 0.10);
  const high = percentile(kept, 0.95);
  return { low, high, range: high - low };
}

/** …and the figure on its own, in LU. */
export function loudnessRange(zs) {
  return loudnessRangeBounds(zs).range;
}

/** Linear-interpolated percentile of a SORTED array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return -Infinity;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ── Bit usage ───────────────────────────────────────────────────────────────
// "How many codes did this song use?" is a question about the FILE: a mix that
// peaks at −12 dBFS throws away two of its bits before any dither gets a say.
// The engine keeps the census (meters.c) and reports its figures — the codes
// that occur, the span they swing over, its log2 (the effective bits) and the
// Shannon entropy of the distribution (the honest "how many bits is this
// carrying", never above the effective bits).

/** Display depths the bit-usage census can be taken at. 16 is what a stereo
 *  WAV export writes (straight off the float bus); 8 is what the Taud device
 *  itself delivers, dither and all. */
export const BIT_DEPTHS = Object.freeze([16, 8]);
export const DEFAULT_BIT_DEPTH = 16;
/** Buckets the census is downsampled to for the wire and the picture. At 8 bits
 *  a bucket IS a code; at 16 it is the code's top eight bits, which is the same
 *  shape drawn at the same width. */
export const HIST_BUCKETS = 256;
/**
 * The three spans the census can be taken over (item 188).
 *
 * The integrated one answers "what does this FILE use". It is cumulative and
 * therefore only ever grows, which makes it useless for finding WHERE the
 * headroom goes: thirty seconds into a take every figure it reports is about
 * the loudest thing that has happened so far, and `used` can only climb.
 *
 * The two rolling ones answer "what is this PASSAGE using", which is the
 * question you can act on. They are deliberately the SAME windows the loudness
 * readings use — 3 s short-term and 400 ms momentary — so a bit-usage figure
 * and a loudness figure on this screen describe the same stretch of music: 3 s
 * is a passage, 400 ms is a hit.
 */
export const HIST_SPAN_ALL = 0;
export const HIST_SPAN_LONG = 1;
export const HIST_SPAN_SHORT = 2;
/** Seconds each span looks back, indexed by HIST_SPAN_*. The cumulative entry
 *  is 0, which is not a window at all — hence the null in `histWin`. */
export const HIST_SPAN_SEC = Object.freeze([0, 3, 0.4]);

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

/** What a reading of the Mastering view's tap is read into
 *  (AudioSystem.readMasterMeter, the engine's WasmMasterMeter.drain). */
export function makeMasterMeterReadout() {
  return {
    frames: 0, compGrDb: 0, limGrDb: 0, histTotal: 0,
    buckets: null, bits: null, bitDepth: DEFAULT_BIT_DEPTH, histSpan: HIST_SPAN_ALL,
    spec: null, pair: null, specWrite: 0,
    sumZ: new Float64Array(TAP_STAGES),
    apPeak: new Float64Array(TAP_STAGES),
    apSumSq: new Float64Array(TAP_STAGES),
    peak: new Float64Array(TAP_STAGES * 2),
    truePeak: new Float64Array(TAP_STAGES * 2),
    meanSquare: new Float64Array(TAP_STAGES * 2),
    clip: new Float64Array(TAP_STAGES * 2),
  };
}
