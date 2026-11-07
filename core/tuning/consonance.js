// Dissonance metrics that do not assume twelve notes.
//
// A 12-TET interval table ("a minor second is bad, a fifth is good") means
// nothing in 17-EDO or Bohlen–Pierce, so a harmoniser that has to work in any
// tuning needs a measure computed from the interval itself. Two are offered:
//
//   entropy   Harmonic entropy (Erlich): how uncertain the ear is about which
//             simple ratio an interval approximates. Timbre-independent, so it
//             is the default — a song's samples are unknown to the maths.
//   sethares  Sensory roughness (Plomp–Levelt as parametrised by Sethares)
//             between two harmonic spectra at the notes' real frequencies.
//             Register-dependent, which is its point: a third low in the bass
//             is rougher than the same third two octaves up.
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
 *  Ratio set: reduced n/d with n·d ≤ 600 in [1, 4]; Gaussian spread 15 cents;
 *  each ratio weighted by 1/(n·d). A denser set (Erlich's n·d ≤ 10000) flattens
 *  the curve until a third and a second are within a few per cent of each
 *  other, which is no use for CHOOSING between notes; this bound keeps the
 *  order the ear agrees with: m2 > M7 ≈ m9 > tritone > m3 > M3 > P4 > P5. */
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

/** Plomp–Levelt roughness of two pure tones (Sethares' parametrisation). */
function plompLevelt(f1, f2, a1, a2) {
  const fmin = Math.min(f1, f2);
  const s = 0.24 / (0.0207 * fmin + 18.96);
  const df = Math.abs(f2 - f1);
  return a1 * a2 * (Math.exp(-3.51 * s * df) - Math.exp(-5.75 * s * df));
}

/** Roughness between two harmonic tones of `partials` partials (amplitude
 *  0.88^k), raw (unnormalised). */
function spectralRoughness(fa, fb, partials) {
  let d = 0;
  for (let i = 1; i <= partials; i++) {
    for (let j = 1; j <= partials; j++) {
      d += plompLevelt(fa * i, fb * j, 0.88 ** (i - 1), 0.88 ** (j - 1));
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
