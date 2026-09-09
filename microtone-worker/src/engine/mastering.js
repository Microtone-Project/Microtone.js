// Master-bus mastering chain (item 178) — the last thing that touches the mix
// before it narrows to 8 bits.
//
// It sits inside the output stage: the voices sum in binary64, the Amiga chain
// runs, the pair narrows to binary32 — and THEN this runs, before the clamp and
// the dither. That position is the whole point. A limiter downstream of the
// clamp would have nothing left to do, and a chain upstream of the Amiga filter
// would be mastering a signal the device never delivers.
//
// ── What it is not ──
// It makes no judgements. Every stage is a textbook block with the parameter it
// says on the tin, in a FIXED order, and nothing here looks at the music and
// decides anything. That is a design constraint, not a shortcoming: the meters
// (loudness.js) tell you what the song is doing, and you decide.
//
//     trim → high-pass → 4-band EQ → compressor → width → limiter → gain
//
// Every stage has its own on/off; the chain as a whole has one more. With
// nothing engaged the chain is not merely transparent, it is ABSENT —
// masteringEngaged() returns false and the mixer keeps the untouched legacy
// path, so a song that has never been near this tab still renders bit-for-bit
// as it did before the tab existed.
//
// Not a port: the Kotlin engine has no mastering stage, so this file — like
// spatial.js, binaural.js and analysis.js — IS the reference implementation.
// See TAUD_ENGINE_SPEC.md §12.1 for the normative description and
// TAUD_FILE_FORMAT.md §9.12 for the `sMst` section that carries the parameters.
//
// DETERMINISM: coefficients are computed in binary64 from binary32 parameters
// (the section stores f32), and the per-sample maths is binary64 like the rest
// of the mix bus. The narrowing to binary32 still happens exactly once, after
// this, where it always did.

import { SAMPLING_RATE } from "./constants.js";
// The limiter's true-peak mode reads the same 4× polyphase oversampler the
// master-strip meters do (analysis.js) — one kernel, so the ceiling the limiter
// holds and the number the meter reports are the same measurement.
import { TruePeakProbe } from "./analysis.js";

// ── Parameter model ─────────────────────────────────────────────────────────

/** EQ band shapes. The value is the wire form (`sMst` band type byte). */
export const EQ_LOW_SHELF = 0;
export const EQ_PEAKING = 1;
export const EQ_HIGH_SHELF = 2;
/** Bands in the EQ. Fixed: four is enough to be useful and few enough to read. */
export const EQ_BANDS = 4;

/** Compressor detector. Peak is what a limiter-ish setting wants; RMS is what a
 *  levelling setting wants. Both are LINKED across the pair — a detector per
 *  channel moves the stereo image whenever one side is louder, which is a thing
 *  no one has ever asked a mastering compressor to do. */
export const COMP_PEAK = 0;
export const COMP_RMS = 1;

/** High-pass slopes, in dB/octave. 12 is one Butterworth section, 24 is two. */
export const HP_SLOPE_12 = 0;
export const HP_SLOPE_24 = 1;

/**
 * Look-ahead, in milliseconds, of the limiter's gain computer — and therefore
 * the chain's latency whenever the limiter is on (twice this: see LimiterStage
 * for why the delay is two windows and not one). Fixed rather than exposed:
 * it is the one number in here whose value is a trade against latency rather
 * than against sound, and 1 ms of it is enough to turn every attack into a
 * ramp at every tempo.
 */
export const LIMITER_LOOKAHEAD_MS = 1.0;

/** Parameter ranges, as the UI and the codec both clamp them. */
export const RANGE = Object.freeze({
  trimDb: [-24, 24],
  hpFreq: [10, 500],
  eqFreq: [20, 20000],
  eqGainDb: [-18, 18],
  eqQ: [0.1, 12],
  compThreshDb: [-60, 0],
  compRatio: [1, 20],
  compAttackMs: [0.1, 300],
  compReleaseMs: [5, 3000],
  compKneeDb: [0, 24],
  compMakeupDb: [-12, 24],
  width: [0, 2],
  limCeilingDb: [-24, 0],
  limReleaseMs: [1, 1000],
  outGainDb: [-24, 24],
});

/**
 * Clamp to a control's range AND narrow to binary32.
 *
 * The narrowing is not incidental: `sMst` stores every parameter as an IEEE
 * binary32, so a value the editor holds in binary64 would come back from a save
 * as something very slightly different and the chain would drift a hair on
 * every round trip. Rounding here makes the document hold exactly what the file
 * will hold, which is also what lets a saved song be compared byte-for-byte
 * with the one still on screen.
 */
const clampRange = (v, key, fallback) => {
  const [lo, hi] = RANGE[key];
  // A field the caller left out (or a NaN a corrupt file produced) falls back
  // to the stage's own resting value, NOT to the bottom of its range: a partial
  // record is "these are the parts I care about", and reading the rest as
  // −24 dB of trim would silently rebuild the chain around it.
  if (!Number.isFinite(v)) return Math.fround(fallback);
  return Math.fround(v < lo ? lo : v > hi ? hi : v);
};

/**
 * The neutral chain. Every stage off, every control at the value it would rest
 * at — so turning a stage on changes nothing until you move something, which is
 * what makes A/B against the untouched mix mean anything.
 */
export function defaultMastering() {
  // Narrowed to binary32 like everything else that reaches the chain (see
  // clampRange): the default record has to be a FIXED POINT of
  // normaliseMastering, or "is this chain untouched?" — which decides whether
  // the file carries an `sMst` section at all — is false for a project nobody
  // has been near.
  return f32Record({
    on: false,
    trimDb: 0,
    hpOn: false, hpFreq: 20, hpSlope: HP_SLOPE_12,
    eqOn: false,
    // The four bands start ENGAGED. At 0 dB an RBJ section is the identity
    // (A = 1 makes its numerator and denominator the same three numbers), so a
    // live band that nobody has moved changes nothing — and switching the
    // equaliser on then dragging a gain slider does what it looks like it
    // should, instead of doing nothing until you find the band's own switch.
    // The unit switch above is still off, so an untouched chain is still
    // entirely absent.
    eq: [
      { on: true, type: EQ_LOW_SHELF, freq: 100, gainDb: 0, q: 0.707 },
      { on: true, type: EQ_PEAKING, freq: 400, gainDb: 0, q: 1.0 },
      { on: true, type: EQ_PEAKING, freq: 2500, gainDb: 0, q: 1.0 },
      { on: true, type: EQ_HIGH_SHELF, freq: 8000, gainDb: 0, q: 0.707 },
    ],
    compOn: false, compDetector: COMP_PEAK,
    compThreshDb: -18, compRatio: 2, compAttackMs: 20, compReleaseMs: 200,
    compKneeDb: 6, compMakeupDb: 0,
    widthOn: false, width: 1,
    limOn: false, limTruePeak: false, limCeilingDb: -1, limReleaseMs: 100,
    outGainDb: 0,
  });
}

/** Narrow every number in a parameter record (its EQ bands included) to f32. */
function f32Record(p) {
  for (const k of Object.keys(p)) {
    if (typeof p[k] === "number") p[k] = Math.fround(p[k]);
  }
  for (const b of p.eq) {
    for (const k of Object.keys(b)) {
      if (typeof b[k] === "number") b[k] = Math.fround(b[k]);
    }
  }
  return p;
}

/** Fill in what a partial record leaves out and clamp what it declares, so
 *  anything downstream (the DSP, the codec, the UI) reads a complete object. */
export function normaliseMastering(p) {
  const d = defaultMastering();
  if (!p || typeof p !== "object") return d;
  const eq = [];
  for (let i = 0; i < EQ_BANDS; i++) {
    const b = p.eq?.[i] ?? d.eq[i];
    const type = b.type === EQ_LOW_SHELF || b.type === EQ_HIGH_SHELF ? b.type : EQ_PEAKING;
    eq.push({
      on: !!b.on,
      // Only the outer bands may be shelves; a shelf in the middle of the
      // stack is legal maths and an unreadable control surface.
      type: i === 0 || i === EQ_BANDS - 1 ? type : EQ_PEAKING,
      freq: clampRange(+b.freq, "eqFreq", d.eq[i].freq),
      gainDb: clampRange(+b.gainDb, "eqGainDb", d.eq[i].gainDb),
      q: clampRange(+b.q, "eqQ", d.eq[i].q),
    });
  }
  return {
    on: !!p.on,
    trimDb: clampRange(+p.trimDb, "trimDb", d.trimDb),
    hpOn: !!p.hpOn,
    hpFreq: clampRange(+p.hpFreq, "hpFreq", d.hpFreq),
    hpSlope: p.hpSlope === HP_SLOPE_24 ? HP_SLOPE_24 : HP_SLOPE_12,
    eqOn: !!p.eqOn,
    eq,
    compOn: !!p.compOn,
    compDetector: p.compDetector === COMP_RMS ? COMP_RMS : COMP_PEAK,
    compThreshDb: clampRange(+p.compThreshDb, "compThreshDb", d.compThreshDb),
    compRatio: clampRange(+p.compRatio, "compRatio", d.compRatio),
    compAttackMs: clampRange(+p.compAttackMs, "compAttackMs", d.compAttackMs),
    compReleaseMs: clampRange(+p.compReleaseMs, "compReleaseMs", d.compReleaseMs),
    compKneeDb: clampRange(+p.compKneeDb, "compKneeDb", d.compKneeDb),
    compMakeupDb: clampRange(+p.compMakeupDb, "compMakeupDb", d.compMakeupDb),
    widthOn: !!p.widthOn,
    width: clampRange(+p.width, "width", d.width),
    limOn: !!p.limOn,
    limTruePeak: !!p.limTruePeak,
    limCeilingDb: clampRange(+p.limCeilingDb, "limCeilingDb", d.limCeilingDb),
    limReleaseMs: clampRange(+p.limReleaseMs, "limReleaseMs", d.limReleaseMs),
    outGainDb: clampRange(+p.outGainDb, "outGainDb", d.outGainDb),
  };
}

/**
 * Would this chain change ANY sample? Off, or on with nothing engaged and both
 * gains at unity, is not "transparent" — it is skipped outright, which is what
 * keeps the legacy render path bit-exact for every song that does not use the
 * feature. A stage counts as engaged when its switch is on, whatever its
 * settings say: an EQ band flat at 0 dB still costs a biquad, and pretending
 * otherwise would make the chain's latency depend on a gain value.
 */
export function masteringEngaged(p) {
  if (!p || !p.on) return false;
  return p.trimDb !== 0 || p.outGainDb !== 0 ||
    p.hpOn || p.eqOn || p.compOn || p.limOn || (p.widthOn && p.width !== 1);
}

/** Deep copy — params travel over postMessage and into undo records. */
export function cloneMastering(p) {
  const n = normaliseMastering(p);
  n.eq = n.eq.map((b) => ({ ...b }));
  return n;
}

/** Structural equality, for "did this edit change anything?" checks. */
export function masteringEqual(a, b) {
  const x = normaliseMastering(a), y = normaliseMastering(b);
  for (const k of Object.keys(x)) {
    if (k === "eq") continue;
    if (x[k] !== y[k]) return false;
  }
  for (let i = 0; i < EQ_BANDS; i++) {
    for (const k of ["on", "type", "freq", "gainDb", "q"]) {
      if (x.eq[i][k] !== y.eq[i][k]) return false;
    }
  }
  return true;
}

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

// ── Biquad ──────────────────────────────────────────────────────────────────
// RBJ cookbook sections, Direct Form I, normalised to a0. Coefficients live in
// the section; the delay line is per channel, so one section serves the pair.

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = new Float64Array(2); this.x2 = new Float64Array(2);
    this.y1 = new Float64Array(2); this.y2 = new Float64Array(2);
  }

  reset() {
    this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0);
  }

  /** One sample of channel `c`. */
  run(c, x) {
    const y = this.b0 * x + this.b1 * this.x1[c] + this.b2 * this.x2[c] -
      this.a1 * this.y1[c] - this.a2 * this.y2[c];
    this.x2[c] = this.x1[c]; this.x1[c] = x;
    this.y2[c] = this.y1[c]; this.y1[c] = y;
    return y;
  }

  _set(b0, b1, b2, a0, a1, a2) {
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
  }

  highPass(freq, q, rate) {
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    this._set((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
  }

  peaking(freq, gainDb, q, rate) {
    const A = 10 ** (gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    this._set(1 + alpha * A, -2 * cw, 1 - alpha * A,
              1 + alpha / A, -2 * cw, 1 - alpha / A);
  }

  lowShelf(freq, gainDb, q, rate) {
    const A = 10 ** (gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const tsa = 2 * Math.sqrt(A) * alpha;
    this._set(A * ((A + 1) - (A - 1) * cw + tsa),
              2 * A * ((A - 1) - (A + 1) * cw),
              A * ((A + 1) - (A - 1) * cw - tsa),
              (A + 1) + (A - 1) * cw + tsa,
              -2 * ((A - 1) + (A + 1) * cw),
              (A + 1) + (A - 1) * cw - tsa);
  }

  highShelf(freq, gainDb, q, rate) {
    const A = 10 ** (gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const tsa = 2 * Math.sqrt(A) * alpha;
    this._set(A * ((A + 1) + (A - 1) * cw + tsa),
              -2 * A * ((A - 1) + (A + 1) * cw),
              A * ((A + 1) + (A - 1) * cw - tsa),
              (A + 1) - (A - 1) * cw + tsa,
              2 * ((A - 1) - (A + 1) * cw),
              (A + 1) - (A - 1) * cw - tsa);
  }
}

// ── Sliding-window minimum ──────────────────────────────────────────────────
// A monotonic deque over a fixed window, O(1) amortised. The limiter's whole
// no-overshoot guarantee rests on this: see LimiterStage.

class SlidingMin {
  /** Rebase point for the sample counter: an Int32 index would wrap after
   *  about twelve hours of continuous playback, and a worklet does run for
   *  days. Every stored index is shifted down when the counter reaches this. */
  static REBASE = 0x20000000;

  constructor(width) {
    this.width = width;
    // The deque can hold `width` candidates at once, and head === tail means
    // empty — so the ring needs one spare slot to tell "full" from "empty".
    this.cap = width + 1;
    this.val = new Float64Array(this.cap);  // ring of candidate values
    this.at = new Int32Array(this.cap);     // …and the index each arrived at
    this.head = 0; this.tail = 0;           // [head, tail), tail = newest end
    this.n = 0;                             // samples pushed so far
    this.reset();
  }

  reset(fill = 1.0) {
    // Prime with one candidate dated far enough back that it retires as soon
    // as the window has rolled past it — so the very first outputs read `fill`
    // (silence needs no gain reduction) instead of an empty deque's nothing.
    this.n = 0;
    this.val[0] = fill; this.at[0] = 0;
    this.head = 0; this.tail = 1;
  }

  /** Push `v`, return the minimum over the last `width` samples. */
  push(v) {
    const i = this.n++;
    const cap = this.cap;
    // Drop candidates this sample dominates: anything ≥ v can never be the
    // minimum again while v is in the window.
    while (this.tail !== this.head) {
      const prev = (this.tail - 1 + cap) % cap;
      if (this.val[prev] >= v) this.tail = prev; else break;
    }
    this.val[this.tail] = v; this.at[this.tail] = i;
    this.tail = (this.tail + 1) % cap;
    // …and retire the front once it has fallen out of the window.
    while (this.at[this.head] <= i - this.width) this.head = (this.head + 1) % cap;
    if (this.n >= SlidingMin.REBASE) {
      for (let k = this.head; k !== this.tail; k = (k + 1) % cap) {
        this.at[k] -= SlidingMin.REBASE;
      }
      this.n -= SlidingMin.REBASE;
    }
    return this.val[this.head];
  }
}

// ── The stages ──────────────────────────────────────────────────────────────

/** Two Butterworth sections' worth of high-pass; the 12 dB/oct slope uses one. */
class HighPassStage {
  constructor() { this.s1 = new Biquad(); this.s2 = new Biquad(); this.two = false; }
  configure(p, rate) {
    this.two = p.hpSlope === HP_SLOPE_24;
    if (this.two) {
      // Cascaded Butterworth 4th order: the two section Qs of a normalised
      // Butterworth quartic, 1/(2 cos(π/8)) and 1/(2 cos(3π/8)).
      this.s1.highPass(p.hpFreq, 0.5411961001461969, rate);
      this.s2.highPass(p.hpFreq, 1.3065629648763766, rate);
    } else {
      this.s1.highPass(p.hpFreq, Math.SQRT1_2, rate);
    }
  }
  reset() { this.s1.reset(); this.s2.reset(); }
  run(c, x) {
    const y = this.s1.run(c, x);
    return this.two ? this.s2.run(c, y) : y;
  }
}

/** Four cascaded RBJ sections; a band that is off is simply not in the list. */
class EqStage {
  constructor() {
    this.sections = [];
    for (let i = 0; i < EQ_BANDS; i++) this.sections.push(new Biquad());
    this.live = [];
  }
  configure(p, rate) {
    this.live = [];
    for (let i = 0; i < EQ_BANDS; i++) {
      const b = p.eq[i];
      if (!b.on) continue;
      const s = this.sections[i];
      if (b.type === EQ_LOW_SHELF) s.lowShelf(b.freq, b.gainDb, b.q, rate);
      else if (b.type === EQ_HIGH_SHELF) s.highShelf(b.freq, b.gainDb, b.q, rate);
      else s.peaking(b.freq, b.gainDb, b.q, rate);
      this.live.push(s);
    }
  }
  reset() { for (const s of this.sections) s.reset(); }
  run(c, x) {
    let y = x;
    for (let i = 0; i < this.live.length; i++) y = this.live[i].run(c, y);
    return y;
  }
}

/**
 * Feed-forward compressor with a quadratic soft knee, computed in dB and
 * smoothed in dB — the arrangement that gives a ratio the meaning the label
 * claims at every level, instead of one that drifts with the detector.
 *
 * The detector is LINKED (one envelope drives both channels), which is the only
 * arrangement that leaves the stereo image where the mixer put it.
 */
class CompressorStage {
  constructor() {
    this.grDb = 0;        // current gain reduction, dB (negative)
    this.rms = 0;         // RMS detector's mean-square state
    this.rmsCoef = 0;
    this.attackCoef = 0; this.releaseCoef = 0;
    this.thresh = 0; this.ratio = 1; this.knee = 0; this.makeup = 1;
    this.peakMode = true;
  }
  configure(p, rate) {
    this.peakMode = p.compDetector !== COMP_RMS;
    this.thresh = p.compThreshDb;
    this.ratio = p.compRatio;
    this.knee = p.compKneeDb;
    this.makeup = dbToGain(p.compMakeupDb);
    this.attackCoef = onePole(p.compAttackMs, rate);
    this.releaseCoef = onePole(p.compReleaseMs, rate);
    // A 10 ms window is the usual "programme level" compromise: long enough to
    // ignore a single cycle of a bass note, short enough to follow a phrase.
    this.rmsCoef = onePole(10, rate);
  }
  reset() { this.grDb = 0; this.rms = 0; }

  /** Update the envelope from the frame's linked detector and return the
   *  linear gain to apply (makeup folded in). */
  step(l, r) {
    let level;
    if (this.peakMode) {
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      level = al > ar ? al : ar;
    } else {
      const ms = (l * l + r * r) * 0.5;
      this.rms += (ms - this.rms) * this.rmsCoef;
      level = Math.sqrt(this.rms);
    }
    // −120 dBFS floor: below it the gain computer has nothing to say and the
    // logarithm has nowhere to go.
    const levelDb = level > 1e-6 ? 20 * Math.log10(level) : -120;
    const over = levelDb - this.thresh;
    const half = this.knee * 0.5;
    let targetDb;
    if (this.knee > 0 && over > -half && over < half) {
      const t = over + half;
      targetDb = -((1 - 1 / this.ratio) * t * t) / (2 * this.knee);
    } else if (over > 0) {
      targetDb = -over * (1 - 1 / this.ratio);
    } else {
      targetDb = 0;
    }
    // More reduction is an ATTACK, less is a RELEASE.
    const coef = targetDb < this.grDb ? this.attackCoef : this.releaseCoef;
    this.grDb += (targetDb - this.grDb) * coef;
    return dbToGain(this.grDb) * this.makeup;
  }
}

/**
 * Look-ahead brickwall limiter.
 *
 * The construction is the one that CANNOT overshoot, which matters more here
 * than anywhere else in the chain: this is the stage whose only job is a
 * promise about the ceiling.
 *
 *   1. `g[n]` — the gain sample n would need to sit at the ceiling.
 *   2. A sliding MINIMUM of g over 2D+1 samples.
 *   3. A rise-rate limit (the release), which can only push the gain lower.
 *   4. A moving AVERAGE over D+1 samples, which turns every step into a ramp.
 *   5. The audio, delayed by 2D.
 *
 * Steps 2 and 4 are what buy the guarantee. Every value the average at time n
 * covers is a minimum over a window that still contains sample n−2D, so every
 * term is ≤ g[n−2D] and so is their mean — and the rise limit only ever lowers
 * it further. A moving average alone (the common shortcut) does not have that
 * property and lets transients through by a decibel or so.
 *
 * The cost is 2D of latency, which is why D is one millisecond and not ten.
 */
class LimiterStage {
  constructor() {
    this.d = 0;
    this.delayL = null; this.delayR = null; this.dpos = 0;
    this.min = null;
    this.avg = null; this.avgSum = 0; this.apos = 0;
    this.env = 1;
    this.releaseCoef = 0;
    this.ceiling = 1;
    this.truePeak = false;
    this.probeL = new TruePeakProbe();
    this.probeR = new TruePeakProbe();
    this.grDb = 0; // most recent reduction, dB (negative), for the meter
  }

  configure(p, rate) {
    const d = Math.max(1, Math.round((LIMITER_LOOKAHEAD_MS / 1000) * rate));
    const geometryChanged = d !== this.d;
    if (geometryChanged) {
      this.d = d;
      this.delayL = new Float64Array(2 * d);
      this.delayR = new Float64Array(2 * d);
      this.min = new SlidingMin(2 * d + 1);
      this.avg = new Float64Array(d + 1);
    }
    this.ceiling = dbToGain(p.limCeilingDb);
    this.truePeak = !!p.limTruePeak;
    this.releaseCoef = onePole(p.limReleaseMs, rate);
    // New buffers hold nothing; existing ones hold audio that is still on its
    // way out, and dropping it mid-drag is a click for every knob turn.
    if (geometryChanged) this.reset();
  }

  /** Total latency in samples — what the rest of the chain has to declare. */
  get latency() { return this.d === 0 ? 0 : 2 * this.d; }

  reset() {
    if (this.d === 0) return;
    this.delayL.fill(0); this.delayR.fill(0); this.dpos = 0;
    this.min.reset(1.0);
    this.avg.fill(1.0); this.avgSum = this.avg.length; this.apos = 0;
    this.env = 1;
    this.probeL.reset(); this.probeR.reset();
    this.grDb = 0;
  }

  /** Feed one frame, get the delayed and limited frame back in `out`. */
  step(l, r, out) {
    const pl = this.truePeak ? this.probeL.push(l) : (l < 0 ? -l : l);
    const pr = this.truePeak ? this.probeR.push(r) : (r < 0 ? -r : r);
    const peak = pl > pr ? pl : pr;
    const need = peak > this.ceiling ? this.ceiling / peak : 1;

    const m = this.min.push(need);
    // Rise limit = release. A fall is instantaneous; the sliding minimum has
    // already moved it D samples early, and step 4 turns that into a ramp.
    this.env = m < this.env ? m : this.env + (m - this.env) * this.releaseCoef;

    const w = this.avg.length;
    this.avgSum += this.env - this.avg[this.apos];
    this.avg[this.apos] = this.env;
    this.apos = this.apos + 1 === w ? 0 : this.apos + 1;
    const gain = this.avgSum / w;

    const dl = this.delayL[this.dpos];
    const dr = this.delayR[this.dpos];
    this.delayL[this.dpos] = l;
    this.delayR[this.dpos] = r;
    this.dpos = this.dpos + 1 === this.delayL.length ? 0 : this.dpos + 1;

    if (gain < 1) {
      const db = 20 * Math.log10(gain);
      if (db < this.grDb) this.grDb = db;
    }
    out[0] = dl * gain;
    out[1] = dr * gain;
  }
}

/** One-pole smoothing coefficient for a time constant in milliseconds. */
function onePole(ms, rate) {
  const n = (ms / 1000) * rate;
  return n <= 0 ? 1 : 1 - Math.exp(-1 / n);
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * The whole thing, stateful, one instance per playhead. `process` runs over a
 * block of the mix bus in place; the block size is irrelevant to the result
 * (everything is per-sample state), which is what keeps a render at one chunk
 * size identical to a render at another.
 */
export class MasterChain {
  constructor(params = null, rate = SAMPLING_RATE) {
    this.rate = rate;
    this.hp = new HighPassStage();
    this.eq = new EqStage();
    this.comp = new CompressorStage();
    this.lim = new LimiterStage();
    this.params = defaultMastering();
    this._pair = [0, 0];
    /** Peak gain reduction over the block just processed, dB (≤ 0). Drained by
     *  the metering tap; the UI owns the ballistics, as everywhere else. */
    this.compGrDb = 0;
    this.limGrDb = 0;
    // Always, even for a null argument: `engaged` and the two gain scalars are
    // set here and nowhere else, so a chain that skipped it would read them as
    // undefined on its first block.
    this.setParams(params ?? this.params);
  }

  /** Install a parameter set. Coefficients are recomputed; the DELAY LINES are
   *  not cleared, so dragging a knob while the song plays does not click. */
  setParams(params) {
    const p = normaliseMastering(params);
    this.params = p;
    this.trimGain = dbToGain(p.trimDb);
    this.outGain = dbToGain(p.outGainDb);
    this.width = p.width;
    if (p.hpOn) this.hp.configure(p, this.rate);
    if (p.eqOn) this.eq.configure(p, this.rate);
    if (p.compOn) this.comp.configure(p, this.rate);
    if (p.limOn) this.lim.configure(p, this.rate);
    this.engaged = masteringEngaged(p);
  }

  /** Latency this chain adds, in samples (the limiter's look-ahead, or zero). */
  get latency() { return this.params.limOn ? this.lim.latency : 0; }

  /** Clear every delay line and envelope. A transport reset owes the chain
   *  this: a compressor still holding 6 dB of reduction from before a seek, or
   *  a look-ahead buffer still holding two milliseconds of the previous
   *  playback, is exactly the class of lingering state §15 of the engine spec
   *  is about. */
  reset() {
    this.hp.reset();
    this.eq.reset();
    this.comp.reset();
    this.lim.reset();
    this.compGrDb = 0;
    this.limGrDb = 0;
  }

  /**
   * Process `frames` of the mix bus in place. `left`/`right` are the binary32
   * mix buffers; the maths runs in binary64 and the result is stored back,
   * narrowing once, exactly as an unmastered mix narrows once.
   */
  process(left, right, frames) {
    const p = this.params;
    if (!this.engaged) return;
    const trim = this.trimGain;
    const out = this.outGain;
    const doHp = p.hpOn, doEq = p.eqOn, doComp = p.compOn;
    const doWidth = p.widthOn && this.width !== 1;
    const doLim = p.limOn;
    const w = this.width;
    const pair = this._pair;
    let compGr = 0;
    this.lim.grDb = 0;

    for (let n = 0; n < frames; n++) {
      let l = left[n] * trim;
      let r = right[n] * trim;
      if (doHp) { l = this.hp.run(0, l); r = this.hp.run(1, r); }
      if (doEq) { l = this.eq.run(0, l); r = this.eq.run(1, r); }
      if (doComp) {
        const g = this.comp.step(l, r);
        l *= g; r *= g;
        if (this.comp.grDb < compGr) compGr = this.comp.grDb;
      }
      if (doWidth) {
        const m = (l + r) * 0.5;
        const s = (l - r) * 0.5 * w;
        l = m + s; r = m - s;
      }
      if (doLim) {
        this.lim.step(l, r, pair);
        l = pair[0]; r = pair[1];
      }
      left[n] = l * out;
      right[n] = r * out;
    }
    this.compGrDb = compGr;
    this.limGrDb = this.lim.grDb;
  }

  /**
   * The chain's magnitude response at `freq`, in dB — the static stages only
   * (trim, high-pass, EQ, output gain), which is exactly what an EQ curve is
   * supposed to draw. The dynamics stages are deliberately absent: a
   * compressor has no frequency response, and drawing its makeup into the
   * curve would be a lie about what the line means.
   */
  responseDb(freq) {
    const p = this.params;
    if (!p.on) return 0;
    let db = p.trimDb + p.outGainDb;
    if (p.hpOn) {
      db += biquadDb(this.hp.s1, freq, this.rate);
      if (this.hp.two) db += biquadDb(this.hp.s2, freq, this.rate);
    }
    if (p.eqOn) {
      for (let i = 0; i < EQ_BANDS; i++) {
        if (p.eq[i].on) db += biquadDb(this.eq.sections[i], freq, this.rate);
      }
    }
    return db;
  }
}

/** |H(e^{jw})| of one configured section, in dB. */
function biquadDb(s, freq, rate) {
  const w = (2 * Math.PI * freq) / rate;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = s.b0 + s.b1 * cw + s.b2 * c2;
  const ni = -(s.b1 * sw + s.b2 * s2);
  const dr = 1 + s.a1 * cw + s.a2 * c2;
  const di = -(s.a1 * sw + s.a2 * s2);
  const num = nr * nr + ni * ni;
  const den = dr * dr + di * di;
  if (den === 0 || num === 0) return -120;
  return 10 * Math.log10(num / den);
}

/** A configured chain's response curve over `n` log-spaced points from `lo` to
 *  `hi` Hz — what the EQ display plots. Returns {freq, db} Float64Arrays. */
export function responseCurve(chain, lo = 20, hi = 20000, n = 256) {
  const freq = new Float64Array(n);
  const db = new Float64Array(n);
  const k = Math.log(hi / lo) / (n - 1);
  for (let i = 0; i < n; i++) {
    freq[i] = lo * Math.exp(k * i);
    db[i] = chain.responseDb(freq[i]);
  }
  return { freq, db };
}
