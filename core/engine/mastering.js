// Master-bus mastering chain (item 178) — its PARAMETERS and the curve the
// Mastering view draws. The chain itself is the engine's
// (core/engine/c/src/mastering.c; TAUD_ENGINE_SPEC.md §12.1, §12.3): it runs
// inside the output stage, after the voices sum and the pair narrows to
// binary32 and before the clamp and the dither — or, for a multichannel
// export, over the render target's bus (setBusMastering).
//
//     trim → high-pass → 4-band EQ → compressor → width → limiter → gain
//
// Every stage has its own on/off; the chain as a whole has one more. With
// nothing engaged the chain is not merely transparent, it is ABSENT —
// masteringEngaged() returns false and the engine keeps the untouched path, so
// a song that has never been near this tab renders bit for bit as it did
// before the tab existed. It makes no judgements: every stage is a textbook
// block with the parameter it says on the tin, in a FIXED order.
//
// Here: the record (defaults, ranges, normalisation to the binary32 the `sMst`
// section stores — TAUD_FILE_FORMAT.md §9.12), and the static stages' magnitude
// response, from the RBJ coefficients the engine computes. A rule restated
// here is a twin of the C one (te_mastering_default, te_mastering_engaged,
// te_bq_*); a change to one is a change to both.

import { SAMPLING_RATE } from "./constants.js";

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

// ── Biquad coefficients ─────────────────────────────────────────────────────
// RBJ cookbook sections normalised to a0 — the coefficients the engine's
// te_bq_* compute, for the curves the Mastering view and the Mixing tab draw
// (biquadDb). Nothing here filters a signal.

export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
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

  lowPass(freq, q, rate) {
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    this._set((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
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

  notch(freq, q, rate) {
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    this._set(1, -2 * cw, 1, 1 + alpha, -2 * cw, 1 - alpha);
  }
}

// ── The curve ───────────────────────────────────────────────────────────────

/**
 * The chain as the Mastering view draws it: its static stages (trim, the
 * high-pass, the EQ, the output gain) configured as the engine configures
 * them. The dynamics are deliberately absent: a compressor has no frequency
 * response, and drawing its make-up into the curve would be a lie about what
 * the line means.
 */
export class MasterCurve {
  constructor(params = null, rate = SAMPLING_RATE) {
    this.rate = rate;
    this.hp1 = new Biquad(); this.hp2 = new Biquad(); this.hpTwo = false;
    this.eq = [];
    for (let i = 0; i < EQ_BANDS; i++) this.eq.push(new Biquad());
    this.setParams(params ?? defaultMastering());
  }

  setParams(params) {
    const p = normaliseMastering(params);
    this.params = p;
    if (p.hpOn) {
      // A 24 dB/octave slope is a Butterworth quartic: two sections at
      // 1/(2 cos(π/8)) and 1/(2 cos(3π/8)).
      this.hpTwo = p.hpSlope === HP_SLOPE_24;
      if (this.hpTwo) {
        this.hp1.highPass(p.hpFreq, 0.5411961001461969, this.rate);
        this.hp2.highPass(p.hpFreq, 1.3065629648763766, this.rate);
      } else {
        this.hp1.highPass(p.hpFreq, Math.SQRT1_2, this.rate);
      }
    }
    if (p.eqOn) {
      for (let i = 0; i < EQ_BANDS; i++) {
        const b = p.eq[i];
        if (!b.on) continue;
        const s = this.eq[i];
        if (b.type === EQ_LOW_SHELF) s.lowShelf(b.freq, b.gainDb, b.q, this.rate);
        else if (b.type === EQ_HIGH_SHELF) s.highShelf(b.freq, b.gainDb, b.q, this.rate);
        else s.peaking(b.freq, b.gainDb, b.q, this.rate);
      }
    }
  }

  /** The static stages' magnitude response at `freq`, in dB. */
  responseDb(freq) {
    const p = this.params;
    if (!p.on) return 0;
    let db = p.trimDb + p.outGainDb;
    if (p.hpOn) {
      db += biquadDb(this.hp1, freq, this.rate);
      if (this.hpTwo) db += biquadDb(this.hp2, freq, this.rate);
    }
    if (p.eqOn) {
      for (let i = 0; i < EQ_BANDS; i++) if (p.eq[i].on) db += biquadDb(this.eq[i], freq, this.rate);
    }
    return db;
  }
}

/** |H(e^{jw})| of one configured section, in dB. */
export function biquadDb(s, freq, rate) {
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

/** A configured curve's response over `n` log-spaced points from `lo` to
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
