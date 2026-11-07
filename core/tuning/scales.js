// Scale vocabulary for harmonic (scalar) transposition — tuning-agnostic.
//
// A scale here is a PITCH SET, not a mode: C Ionian and D Dorian are the same
// seven pitch classes, and moving a note "k positions along the set" gives the
// same answer whichever of them you call it. So the vocabulary never names a
// mode; it lists sets, each in every transposition the tuning offers.
//
// Everything is counted in the tuning's own DEGREE SPACE: the notation table's
// entries, numbered 0..n-1 within one period, with an absolute degree
// `period·n + index` that runs on through the periods. That is the one
// representation that is the same kind of thing in 12-TET, 31-TET, a
// Pythagorean table, Shi'er lü and Bohlen–Pierce (whose period is the
// tritave), so nothing below special-cases a tuning by name.
//
// The vocabulary itself comes from four sources, deduplicated by pitch set
// (the most plausible label wins):
//   1. the diatonic family, built from the tuning's own chain of fifths
//      (intervals.js edoSteps) — major/natural minor, harmonic minor, harmonic
//      major and the directional melodic minor. Meantone, Pythagorean and
//      superpythagorean diatonics all come out of the same five lines;
//   2. moment-of-symmetry scales: every chain of a just-ish generator (3/2,
//      5/4, 6/5, 7/4, 10/9 porcupine, 11/9 neutral, …) that closes into exactly
//      two step sizes, including half-, third- and quarter-period ones
//      (octatonic, augmented, pajara-like decatonics);
//   3. scales defined in CENTS — the maqamat (Rast, Bayati, Saba, Sikah,
//      Hijaz), slendro and pelog — admitted only where the tuning can actually
//      play them within a tolerance, so 12-TET never pretends to have Rast and
//      24-TET or 17-TET do;
//   4. the full chromatic set, the fallback that always exists: a scalar shift
//      along it IS a chromatic transposition.
//
// Pure — no DOM, no state.

import {
  ANCHOR_NOTE, isAbsolute, pitchTablePresets, snapToAbsoluteDegree,
} from "./pitchtables.js";
import { edoSteps } from "./intervals.js";

const OCTAVE = 0x1000;
const unitsToCents = (u) => (u * 1200) / OCTAVE;
const ratioCents = (r) => 1200 * Math.log2(r);

/** How close (4096-TET units, ≈7 cents) two pitches of a Raw song must sit to
 *  count as the same pitch class when the set is inferred by clustering. */
export const RAW_CLUSTER_TOL = 0x18;

/** How far (cents) a cents-defined scale may land from the tuning's nearest
 *  degree and still count as playable in it. */
export const CENTS_SCALE_TOL = 25;

// ── degree space ─────────────────────────────────────────────────────────────

/**
 * The degree space a transposition counts in, for `preset`:
 *   n         degrees per period;
 *   interval  the period in 4096-TET units (0x1000 octave, 0x195C tritave);
 *   offsets   ascending unit offsets of the degrees within one period;
 *   kind      "table" (an ordinary notation), "absolute" (an `interval: 0`
 *             table such as ProTracker pitch, counted as 12-TET and snapped
 *             back at the end) or "raw" (no notation: the pitch classes are
 *             inferred by clustering `sampleNotes`).
 * Methods: locate(note) → {deg, residual} (absolute degree, and how far off
 * the grid the note sits — kept, so a detuned note stays exactly as detuned);
 * pitch(deg) → note word; finish(note) → note word, clamped and, for an
 * absolute table, snapped onto it.
 */
export function degreeSpace(preset, sampleNotes = []) {
  const clamp = (v) => Math.min(Math.max(Math.round(v), 0x20), 0xffff);
  if (preset && isAbsolute(preset)) {
    const inner = degreeSpace(pitchTablePresets[120]);
    return {
      ...inner, kind: "absolute",
      finish: (note) => snapToAbsoluteDegree(clamp(note), preset),
    };
  }
  let offsets, interval, kind;
  if (!preset || preset.table.length === 0) {
    kind = "raw";
    interval = OCTAVE;
    offsets = clusterPitchClasses(sampleNotes, interval);
  } else {
    kind = "table";
    interval = preset.interval;
    offsets = [...preset.table].sort((a, b) => a - b);
  }
  const n = offsets.length;
  const pitch = (deg) => {
    const period = Math.floor(deg / n);
    return ANCHOR_NOTE + period * interval + offsets[deg - period * n];
  };
  const locate = (note) => {
    const rel = note - ANCHOR_NOTE;
    let period = Math.floor(rel / interval);
    const inP = rel - period * interval;
    let index = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(offsets[i] - inP);
      if (d < bestD) { bestD = d; index = i; }
    }
    // the next period's first degree can be nearer than this period's top one
    if (offsets[0] + interval - inP < bestD) { index = 0; period += 1; }
    const deg = period * n + index;
    return { deg, residual: note - pitch(deg) };
  };
  return {
    kind, n, interval, offsets, pitch, locate,
    periodCents: unitsToCents(interval),
    finish: (note) => clamp(note),
  };
}

/** Cluster the pitch classes of `notes` (mod `interval`) with RAW_CLUSTER_TOL,
 *  circularly; returns the ascending cluster centres. */
export function clusterPitchClasses(notes, interval = OCTAVE, tol = RAW_CLUSTER_TOL) {
  const pcs = [];
  for (const note of notes) {
    pcs.push((((note - ANCHOR_NOTE) % interval) + interval) % interval);
  }
  if (!pcs.length) return [];
  pcs.sort((a, b) => a - b);
  // Start at the widest gap so a cluster straddling the period seam stays whole.
  let start = 0, widest = -1;
  for (let i = 0; i < pcs.length; i++) {
    const next = i + 1 < pcs.length ? pcs[i + 1] : pcs[0] + interval;
    if (next - pcs[i] > widest) { widest = next - pcs[i]; start = (i + 1) % pcs.length; }
  }
  const seq = [];
  for (let i = 0; i < pcs.length; i++) {
    const j = (start + i) % pcs.length;
    seq.push(j < start ? pcs[j] + interval : pcs[j]);
  }
  const centres = [];
  let sum = seq[0], count = 1, last = seq[0];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] - last <= tol) { sum += seq[i]; count++; }
    else { centres.push(sum / count); sum = seq[i]; count = 1; }
    last = seq[i];
  }
  centres.push(sum / count);
  return centres.map((c) => Math.round(((c % interval) + interval) % interval)).sort((a, b) => a - b);
}

// ── scale shapes ─────────────────────────────────────────────────────────────

/** Degree indices of a step pattern, or null if a step is not positive or the
 *  steps do not fill the period exactly. */
function fromSteps(steps, n) {
  let acc = 0;
  const out = [];
  for (const s of steps) {
    if (!(s > 0)) return null;
    out.push(acc);
    acc += s;
  }
  return acc === n ? out : null;
}

/** The diatonic family on the tuning's own chain of fifths. Octave tunings only:
 *  a non-octave period has no chain of fifths to build it from. */
function diatonicShapes(space) {
  if (space.interval !== OCTAVE || space.n < 7) return [];
  const { tone: T, limma: L, apotome: A } = edoSteps(space.n);
  const n = space.n;
  const out = [];
  const add = (family, steps, prior, descSteps = null) => {
    const asc = fromSteps(steps, n);
    if (!asc) return;
    const desc = descSteps ? fromSteps(descSteps, n) : null;
    if (descSteps && !desc) return;
    out.push({ family, asc, desc, prior });
  };
  add("diatonic", [T, T, L, T, T, T, L], 0);
  add("harmonicMinor", [T, L, T, T, L, T + A, L], -2);
  add("harmonicMajor", [T, T, L, T, L, T + A, L], -3);
  add("melodicMinor", [T, L, T, T, T, T, L], -2.5, [T, L, T, T, L, T, T]);
  return out;
}

/** Generator ratios a MOS chain may be built from. Reduced into the period, so
 *  3/2 and 4/3 are one chain; the tritave entries matter for Bohlen–Pierce. */
const GENERATOR_RATIOS = [3 / 2, 5 / 4, 6 / 5, 7 / 4, 7 / 6, 8 / 7, 9 / 7, 10 / 9, 11 / 9,
  5 / 3, 7 / 5, 7 / 3, 9 / 5];

/** Moment-of-symmetry scales, cardinality 5..12, over periods of 1..4 parts. */
function mosShapes(space) {
  const { n } = space;
  if (n < 6) return [];
  const step = space.periodCents / n;
  const octave = space.interval === OCTAVE;
  // A long chain in a small tuning only "closes" because the tuning merges its
  // step sizes (an 8-note chain of fifths in 12-TET) — near-chromatic noise, not
  // a scale. Cap the cardinality by the tuning's size; non-octave tunings centre
  // on nine notes, the size of Bohlen–Pierce's Lambda.
  const centre = octave ? 7 : 9;
  const cap = (m) => Math.min(12, Math.max(m > 1 ? 8 : centre, Math.floor(0.6 * n)), octave ? 12 : n - 2);
  const out = [];
  const seen = new Set();
  for (let m = 1; m <= 4; m++) {
    if (n % m !== 0) continue;
    const P = n / m;
    if (P < 2) continue;
    const pCents = space.periodCents / m;
    for (const r of GENERATOR_RATIOS) {
      const c = ((ratioCents(r) % pCents) + pCents) % pCents;
      const g = Math.round(c / step) % P;
      if (g <= 0) continue;
      for (let j = 2; j < P; j++) {
        const K = j * m;
        if (K < 5 || K > cap(m) || K >= n) continue;
        const set = new Set();
        for (let q = 0; q < j; q++) set.add((q * g) % P);
        if (set.size !== j) break;
        const base = [...set].sort((a, b) => a - b);
        const sizes = new Set();
        for (let i = 0; i < j; i++) sizes.add((i + 1 < j ? base[i + 1] : base[0] + P) - base[i]);
        if (sizes.size > 2) continue;
        const asc = [];
        for (let q = 0; q < m; q++) for (const b of base) asc.push(b + q * P);
        const key = asc.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        const prior = m > 1 ? -5 : (K === centre ? -1.5 : -2 - 0.25 * Math.abs(K - centre));
        out.push({ family: `mos${K}`, asc, desc: null, prior });
      }
    }
  }
  return out;
}

/** Scales defined in cents from their tonic. `desc` is the descending form
 *  where the tradition plays a different one. */
const CENTS_SCALES = [
  { family: "rast", asc: [0, 200, 350, 500, 700, 900, 1050], desc: [0, 200, 350, 500, 700, 900, 1000], prior: -1.5 },
  { family: "bayati", asc: [0, 150, 300, 500, 700, 800, 1000], prior: -1.5 },
  { family: "saba", asc: [0, 150, 300, 400, 600, 800, 1000], prior: -2.5 },
  { family: "sikah", asc: [0, 150, 350, 550, 700, 850, 1050], prior: -2.5 },
  { family: "hijaz", asc: [0, 100, 400, 500, 700, 800, 1000], prior: -2 },
  { family: "slendro", asc: [0, 240, 480, 720, 960], prior: -2 },
  { family: "pelog", asc: [0, 120, 270, 540, 670, 785, 950], prior: -2 },
  { family: "pelogBem", asc: [0, 120, 270, 670, 785], prior: -2.5 },
  { family: "pelogBarang", asc: [0, 150, 550, 665, 830], prior: -2.5 },
];

/** Map a cents list onto the nearest degrees, or null when any lands farther
 *  than CENTS_SCALE_TOL away or two land on the same degree. */
function centsToDegrees(list, space) {
  const cents = space.offsets.map(unitsToCents);
  const out = [];
  for (const c of list) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < cents.length; i++) {
      const d = Math.abs(cents[i] - c);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > CENTS_SCALE_TOL) return null;
    if (out.length && best <= out[out.length - 1]) return null;
    out.push(best);
  }
  return out;
}

function centsShapes(space) {
  if (space.interval !== OCTAVE || space.n < 5) return [];
  const out = [];
  for (const s of CENTS_SCALES) {
    const asc = centsToDegrees(s.asc, space);
    if (!asc) continue;
    const desc = s.desc ? centsToDegrees(s.desc, space) : null;
    if (s.desc && !desc) continue;
    out.push({ family: s.family, asc, desc, prior: s.prior });
  }
  return out;
}

/** Prior of the full chromatic set — chosen only when nothing smaller fits. */
export const CHROMATIC_PRIOR = -6;

/**
 * Every scale of the vocabulary, in every transposition, deduplicated:
 * `[{key, family, root, asc, desc, union, prior}]` — `asc`/`desc` ascending
 * degree indices in 0..n-1 (aligned position by position; `desc` null when
 * the scale is the same both ways), `union` their merged set (what the scale
 * can be heard to contain), `root` the transposition (degree index of the
 * shape's first note).
 */
export function scaleVocabulary(space) {
  const { n } = space;
  if (n === 0) return [];
  const chromatic = { family: "chromatic", asc: Array.from({ length: n }, (_, i) => i), desc: null, prior: CHROMATIC_PRIOR };
  if (space.kind === "raw") {
    // A free tuning has no theory to draw on: the inferred set is the scale.
    return [finishScale({ ...chromatic, family: "observed", prior: 0 }, 0, n)];
  }
  const shapes = [...diatonicShapes(space), ...mosShapes(space), ...centsShapes(space)];
  const byKey = new Map();
  const put = (s) => {
    const prev = byKey.get(s.key);
    if (!prev || s.prior > prev.prior) byKey.set(s.key, s);
  };
  for (const shape of shapes) {
    for (let r = 0; r < n; r++) {
      // Keep asc/desc aligned by POSITION after rotation: each descending
      // degree moves with its ascending partner, so it may land just outside
      // 0..n-1 (melodic minor's lowered 7th under a tonic that wrapped to 0
      // becomes -2) — a period offset the mapping reads by floor division.
      let asc, desc = null;
      if (shape.desc) {
        const pairs = shape.asc.map((a, i) => {
          const a2 = (a + r) % n;
          return [a2, shape.desc[i] + (a2 - a)];
        });
        pairs.sort((x, y) => x[0] - y[0]);
        asc = pairs.map((p) => p[0]);
        desc = pairs.map((p) => p[1]);
      } else {
        asc = shape.asc.map((d) => (d + r) % n).sort((a, b) => a - b);
      }
      put(finishScale({ family: shape.family, asc, desc, prior: shape.prior }, r, n));
    }
  }
  put(finishScale(chromatic, 0, n));
  return [...byKey.values()];
}

function finishScale(s, root, n) {
  const mod = (d) => ((d % n) + n) % n;
  const union = s.desc ? [...new Set([...s.asc, ...s.desc.map(mod)])].sort((a, b) => a - b) : s.asc;
  const key = s.asc.join(",") + (s.desc ? "|" + s.desc.join(",") : "");
  return { key, family: s.family, root, asc: s.asc, desc: s.desc, union, prior: s.prior };
}
