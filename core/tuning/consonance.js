// Dissonance metrics that do not assume twelve notes.
//
// A 12-TET interval table ("a minor second is bad, a fifth is good") means
// nothing in 17-EDO or Bohlen–Pierce, so a harmoniser that has to work in any
// tuning needs a measure computed from the interval itself. Two are offered:
//
//   entropy   Harmonic entropy (Erlich): how uncertain the ear is about which
//             simple ratio an interval approximates. Timbre-independent, so it
//             is the default — a song's samples are unknown to the maths.
//             Checked against the Xenharmonic Wiki's "Harmonic entropy"
//             (tsvm reference_materials/xenharmonics/): see buildHarmonicEntropy.
//   sethares  Sensory roughness (Plomp–Levelt as parametrised by Sethares)
//             between two harmonic spectra at the notes' real frequencies.
//             Register-dependent, which is its point: a third low in the bass
//             is rougher than the same third two octaves up. Checked against
//             Sethares' own `dissmeasure` (tsvm reference_materials/sethares/).
//
// The roughness model is also exported in pieces — two partials, a spectrum
// against itself, two spectra — for anything that has a spectrum of its own to
// measure: timbre.js designs instruments with it.
//
// Both return a value normalised to 0..1 (0 = most consonant). A caller may
// also pass any `(noteA, noteB) => 0..1` function wherever a metric is taken.
//
// Pure — no DOM, no state beyond lazily-built lookup tables.

import { ANCHOR_NOTE } from "./pitchtables.js";

const UNITS_PER_OCTAVE = 0x1000;
const C4_HZ = 261.6255653005986;
const MAX_CENTS = 2400; // intervals are octave-reduced into two octaves

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

let heTable = null;

/** Harmonic entropy over 0..MAX_CENTS at 1-cent resolution, normalised 0..1.
 *  Shannon entropy of the "simple weighted" probabilities (Xenharmonic Wiki,
 *  "Harmonic entropy", §Simple Weighted Probabilities): a Gaussian spreading
 *  function over reduced ratios n/d in [1, 4] of Tenney height n·d ≤ 600, each
 *  weighted by 1/(n·d)^w.
 *
 *  The article's usual settings are s ≈ 17 cents, n·d ≤ 10000 and w = ½
 *  (1/√(nd)). Those give the same ORDER of intervals, but the raw entropies of
 *  every interval but the unison, fifth and octave crowd within a few per cent
 *  of each other (a major second and a major third 1.2 % apart), which is no
 *  use for choosing between notes. So this is a sharper member of the same
 *  family: s = 15, n·d ≤ 600, and w = 1 — the article's own free "weighting
 *  exponent" (§Interpretation as a new free parameter; with w = 1 it is, for
 *  unnormalised HE, the collision entropy a = 2 at the usual √(nd) weights,
 *  with s adjusted). Order: m2 > M7 ≈ m9 > tritone > m3 > M3 > P4 > P5. */
function buildHarmonicEntropy() {
  const ratios = [];
  for (let d = 1; d <= 600; d++) {
    for (let n = d; n <= 4 * d && n * d <= 600; n++) {
      if (gcd(n, d) !== 1) continue;
      ratios.push({ c: 1200 * Math.log2(n / d), w: 1 / (n * d) });
    }
  }
  const sigma = 15;
  const raw = new Float64Array(MAX_CENTS + 1);
  for (let c = 0; c <= MAX_CENTS; c++) {
    let sum = 0;
    const ps = [];
    for (const r of ratios) {
      const dc = c - r.c;
      if (Math.abs(dc) > 4 * sigma) continue;
      const p = r.w * Math.exp(-(dc * dc) / (2 * sigma * sigma));
      ps.push(p);
      sum += p;
    }
    let h = 0;
    for (const p of ps) {
      const q = p / sum;
      if (q > 0) h -= q * Math.log(q);
    }
    raw[c] = h;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const out = new Float32Array(MAX_CENTS + 1);
  for (let c = 0; c <= MAX_CENTS; c++) out[c] = (raw[c] - lo) / (hi - lo);
  return out;
}

/** Octave-reduce a span of cents into 0..MAX_CENTS, keeping compound
 *  intervals (a ninth stays a ninth) up to two octaves. */
function reduceCents(cents) {
  let c = Math.abs(cents);
  while (c > MAX_CENTS) c -= 1200;
  return c;
}

/** Normalised harmonic entropy of an interval given in cents (0..1). */
export function harmonicEntropy(cents) {
  heTable ??= buildHarmonicEntropy();
  return heTable[Math.round(reduceCents(cents))];
}

/** Frequency of a note word, C4 = 261.63 Hz. */
export function noteHz(note) {
  return C4_HZ * 2 ** ((note - ANCHOR_NOTE) / UNITS_PER_OCTAVE);
}

/**
 * Plomp–Levelt roughness of two pure tones, as Sethares' `dissmeasure` has it:
 *
 *   s = d* / (s1·fmin + s2),  D = min(a1, a2) · (e^(−b1·s·Δf) − e^(−b2·s·Δf))
 *
 * with d* = 0.24, s1 = 0.0207, s2 = 18.96, b1 = 3.51, b2 = 5.75. The two
 * amplitudes combine by their MINIMUM (the published code's `min(...)`), not
 * their product. Sethares also scales every term by C1 = 5 (C2 = −5); that
 * changes no ordering or ratio and is left out.
 */
export function pairRoughness(f1, a1, f2, a2) {
  const fmin = f1 < f2 ? f1 : f2;
  const s = 0.24 / (0.0207 * fmin + 18.96);
  const df = Math.abs(f2 - f1);
  return (a1 < a2 ? a1 : a2) * (Math.exp(-3.51 * s * df) - Math.exp(-5.75 * s * df));
}

/** The roughness BETWEEN two spectra, each [[freq, amp], …]: every partial of
 *  one against every partial of the other. */
export function crossRoughness(a, b) {
  let d = 0;
  for (const [f1, a1] of a) for (const [f2, a2] of b) d += pairRoughness(f1, a1, f2, a2);
  return d;
}

/** A spectrum's own roughness: every pair of its partials. */
export function intrinsicRoughness(spec) {
  let d = 0;
  for (let i = 0; i < spec.length; i++) {
    for (let j = i + 1; j < spec.length; j++) d += pairRoughness(spec[i][0], spec[i][1], spec[j][0], spec[j][1]);
  }
  return d;
}

/** The roughness of tones sounded together, each a spectrum: their own and
 *  every pair's between them. */
export function chordRoughness(tones) {
  let d = 0;
  for (let i = 0; i < tones.length; i++) {
    d += intrinsicRoughness(tones[i]);
    for (let j = i + 1; j < tones.length; j++) d += crossRoughness(tones[i], tones[j]);
  }
  return d;
}

/** Roughness between two harmonic tones of `partials` partials (amplitude
 *  0.88^k), raw (unnormalised). */
function spectralRoughness(fa, fb, partials) {
  let d = 0;
  for (let i = 1; i <= partials; i++) {
    for (let j = 1; j <= partials; j++) {
      d += pairRoughness(fa * i, 0.88 ** (i - 1), fb * j, 0.88 ** (j - 1));
    }
  }
  return d;
}

/**
 * Sensory roughness of two notes (note words), normalised 0..1 against the
 * roughest interval within an octave above the LOWER note — so the scale
 * follows the register the notes are actually in.
 */
export function setharesDissonance(noteA, noteB, partials = 6) {
  const lo = Math.min(noteA, noteB), hi = Math.max(noteA, noteB);
  const flo = noteHz(lo);
  const d = spectralRoughness(flo, noteHz(hi), partials);
  // the normaliser depends only on the register: cache per quarter-tone band
  const band = Math.round((lo - ANCHOR_NOTE) / (UNITS_PER_OCTAVE / 24));
  let max = roughMax.get(band);
  if (max === undefined) {
    const f = C4_HZ * 2 ** (band / 24);
    max = 0;
    for (let c = 5; c <= 1200; c += 5) {
      max = Math.max(max, spectralRoughness(f, f * 2 ** (c / 1200), partials));
    }
    roughMax.set(band, max);
  }
  return Math.min(1, max > 0 ? d / max : 0);
}
const roughMax = new Map();

/**
 * Resolve a metric: "entropy" (default), "sethares", or a function
 * `(noteA, noteB) => 0..1` passed through as-is.
 */
export function dissonanceMetric(metric = "entropy") {
  if (typeof metric === "function") return metric;
  if (metric === "sethares") return (a, b) => setharesDissonance(a, b);
  return (a, b) => harmonicEntropy(((b - a) * 1200) / UNITS_PER_OCTAVE);
}
