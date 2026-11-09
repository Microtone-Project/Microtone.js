// The Keymap Maker — a layout built from a SCALE rather than from a lattice.
//
// A generalised keyboard puts every note of the tuning under the hands, which
// is what a player of the tuning wants and more than a beginner can use: on
// 31-TET forty keys of a lattice are thirty-one pitch classes, most of them
// "wrong" for a tune in C major. A scale keyboard is the other answer, the one
// a Launchpad's in-key mode gives: every key plays a note OF THE SCALE, a row
// runs up the scale key by key, and the notes outside it are simply not on the
// board. It is not a lattice — the scale's steps are of two sizes — so the
// layout comes out as one override per key with the generator switched off,
// the same shape "Set every key…" writes.
//
// Two frames to count the scale in, and they are the two units a keymap has:
//
//   "tuning"  the open song's tuning system, in its own DEGREES. Exact, and only
//             what that tuning really has: 13-TET has no diatonic scale (its
//             patent fifth gives a limma of −1), so there it is not offered —
//             greyed, not hidden, so the reason it is missing can be read.
//   "any"     12-EDO SEMITONES, the unit the Double-Deck pianos are written in,
//             so the layout works in every tuning by playing the note nearest
//             each key. A MOS scale's L and s define an equal tuning of their
//             own (5L 2s at 3:1 is 17-TET), and its keys are written as
//             fractions of a semitone that land on that tuning exactly.
//
// Scales come in three kinds. The DIATONIC ones are built on the tuning's own
// chain of fifths (intervals.js edoSteps — the derivation the generalised
// built-ins and the harmonic transpose already use), so "D Dorian" in 31-TET
// is meantone Dorian and in 17-TET superpythagorean Dorian. MOS scales take any
// pattern of a large and b small steps, the sizes the user picks, and any of
// its modes, brightest first.
//
// Pure and Node-testable — no DOM, no storage.

import { isAbsolute } from "../../core/tuning/pitchtables.js";
import { edoSteps } from "../../core/tuning/intervals.js";
import { ROW_CODES, ROW_INDEX, ROW_ORDER, normaliseKeymap } from "./keymap.js";

const OCTAVE = 0x1000;

export const MAKER_MODES = Object.freeze(["tuning", "any"]);
export const SCALE_KINDS = Object.freeze(["penta", "hepta", "mos"]);
export const PENTA_MODES = Object.freeze(["major", "minor"]);
/** The seven rotations of the major scale, in the order of the degree each
 *  starts on — index = how far the major scale's steps are rotated. */
export const HEPTA_MODES = Object.freeze([
  "ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "locrian",
]);
/** The largest scale a MOS pattern may have: a row is ten keys, and past
 *  twelve notes a row would not even reach the octave. */
export const MOS_MAX_NOTES = 12;
/** The step-size ratios offered in "any" mode, softest first. Coprime, since
 *  in semitones only the RATIO of L to s matters (6:2 is 3:1 twice over). */
export const ANY_MOS_SIZES = Object.freeze([
  [5, 4], [4, 3], [3, 2], [5, 3], [2, 1], [5, 2], [3, 1], [4, 1], [5, 1],
].map(Object.freeze));

/**
 * What a scale is counted in.
 *   unit    the keymap unit the layout is written in ("deg" or "semi")
 *   n       steps per period of the frame (the tuning's degrees, or 12)
 *   octave  is the period an octave — the diatonic scales need one
 *   usable  false when the frame cannot hold a scale at all (a Raw song)
 *
 * An absolute table (ProTracker's) is a finite list of every note rather than
 * a period of degrees, but it steps a semitone per entry, so it is counted as
 * 12-EDO semitones and snaps back onto itself.
 */
export function makerFrame(mode, preset) {
  if (mode === "any") return { mode, unit: "semi", n: 12, octave: true, usable: true };
  const n = preset?.table?.length ?? 0;
  if (n === 0) return { mode, unit: "deg", n: 0, octave: false, usable: false };
  if (isAbsolute(preset)) return { mode, unit: "semi", n: 12, octave: true, usable: true };
  return { mode, unit: "deg", n, octave: preset.interval === OCTAVE, usable: true };
}

/** The tuning's whole tone and diatonic semitone, or null where there is no
 *  chain of fifths to build them from (a non-octave period). */
function diatonicSteps(frame) {
  if (!frame.usable || !frame.octave || frame.n < 2) return null;
  const { tone, limma } = edoSteps(frame.n);
  return { T: tone, s: limma };
}

const rotate = (steps, k) => steps.map((_, i) => steps[(i + k) % steps.length]);

/** The pentatonic and heptatonic step patterns, or null where the tuning has
 *  none: a heptatonic scale needs both steps to be steps (s ≥ 1); a pentatonic
 *  one only needs the tone, its third being T + s (so 5-TET's equal pentatonic
 *  counts, and 13-TET's, whose third would be smaller than its tone, does not). */
function diatonicPattern(kind, mode, frame) {
  const d = diatonicSteps(frame);
  if (!d || d.T < 1) return null;
  if (kind === "penta") {
    if (d.s < 0) return null;
    const major = [d.T, d.T, d.T + d.s, d.T, d.T + d.s];
    return mode === "minor" ? rotate(major, 4) : major;
  }
  if (d.s < 1) return null;
  const k = Math.max(0, HEPTA_MODES.indexOf(mode));
  return rotate([d.T, d.T, d.s, d.T, d.T, d.T, d.s], k);
}

// ── MOS ──

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Every MOS pattern offered: a large and b small steps, coprime (a pattern
 *  that is not is the same scale repeated within the octave), four to twelve
 *  notes. Ordered by size, then by how many steps are large. */
export function mosPatterns() {
  const out = [];
  for (let size = 4; size <= MOS_MAX_NOTES; size++) {
    for (let a = size - 1; a >= 1; a--) {
      const b = size - a;
      if (gcd(a, b) === 1) out.push({ a, b, size });
    }
  }
  return out;
}

/**
 * The pattern's modes, BRIGHTEST first, as words of "L" and "s".
 *
 * The brightest mode is the upper Christoffel word — step i is large exactly
 * when ⌈(i+1)·a/N⌉ steps past ⌈i·a/N⌉ — which for 5L 2s is LLLsLLs, Lydian. The
 * others are its rotations; brighter means every note sits at least as high,
 * which for a MOS is the same order as the sum of how many large steps lie
 * below each note.
 */
export function mosModes(a, b) {
  const N = a + b;
  let word = "";
  for (let i = 0; i < N; i++) {
    word += Math.ceil(((i + 1) * a) / N) - Math.ceil((i * a) / N) === 1 ? "L" : "s";
  }
  const brightness = (w) => {
    let sum = 0, run = 0;
    for (const c of w) { if (c === "L") run++; sum += run; }
    return sum;
  };
  const seen = new Set();
  const modes = [];
  for (let k = 0; k < N; k++) {
    const w = word.slice(k) + word.slice(0, k);
    if (seen.has(w)) continue;
    seen.add(w);
    modes.push(w);
  }
  return modes.sort((x, y) => brightness(y) - brightness(x));
}

/**
 * The step sizes the pattern can take in `frame`, as [L, s] pairs with
 * L > s ≥ 1. In a tuning they are exactly the pairs that fill its period,
 * a·L + b·s = n — 5L 2s in 31-TET is 5 and 3 and nothing else — so an empty
 * list is a pattern the tuning cannot play. In "any" mode they are ratios
 * (ANY_MOS_SIZES), each of which makes a tuning of its own.
 */
export function mosSizes(a, b, frame) {
  if (frame.mode === "any") return ANY_MOS_SIZES.map((p) => [...p]);
  if (!frame.usable) return [];
  const out = [];
  for (let s = 1; b * s < frame.n; s++) {
    const rest = frame.n - b * s;
    if (rest % a !== 0) continue;
    const L = rest / a;
    if (L > s) out.push([L, s]);
  }
  return out;
}

/** The pair to start on when the user has not picked one: the one nearest the
 *  "basic" 2:1, which is the diatonic's own proportion in 12-TET. */
export function defaultMosSize(sizes) {
  let best = null, bestD = Infinity;
  for (const p of sizes) {
    const d = Math.abs(Math.log2(p[0] / p[1]) - 1);
    if (d < bestD - 1e-9) { bestD = d; best = p; }
  }
  return best;
}

// ── what is possible ──

/** Can `frame` play this kind of scale at all? (MOS: is there any pattern.) */
export function kindAvailable(kind, frame) {
  if (!frame.usable) return false;
  if (kind === "penta") return diatonicPattern("penta", "major", frame) !== null;
  if (kind === "hepta") return diatonicPattern("hepta", "ionian", frame) !== null;
  return mosPatterns().some((p) => mosSizes(p.a, p.b, frame).length > 0);
}

// ── the scale ──

/**
 * The scale `settings` describe, in `frame`: its steps, the period they fill,
 * and what one step is worth in the layout's unit — or null when the frame
 * cannot play it.
 *
 *   settings.kind     "penta" | "hepta" | "mos"
 *   settings.penta    PENTA_MODES entry
 *   settings.hepta    HEPTA_MODES entry
 *   settings.mos      { a, b, L, s, mode } — mode indexes mosModes(a, b)
 */
export function scaleOf(settings, frame) {
  if (!frame.usable) return null;
  let steps = null, word = null;
  if (settings.kind === "penta") steps = diatonicPattern("penta", settings.penta, frame);
  else if (settings.kind === "hepta") steps = diatonicPattern("hepta", settings.hepta, frame);
  else if (settings.kind === "mos") {
    const m = settings.mos ?? {};
    const sizes = mosSizes(m.a, m.b, frame);
    if (!sizes.some(([L, s]) => L === m.L && s === m.s)) return null;
    const modes = mosModes(m.a, m.b);
    word = modes[Math.min(Math.max(m.mode | 0, 0), modes.length - 1)];
    steps = [...word].map((c) => (c === "L" ? m.L : m.s));
  }
  if (!steps) return null;
  const period = steps.reduce((x, y) => x + y, 0);
  // Degrees are degrees; semitones divide the octave among the scale's own
  // equal tuning, which for the diatonic family is 12 and so whole numbers.
  const unitPerStep = frame.unit === "semi" ? 12 / period : 1;
  return { steps, period, unitPerStep, word };
}

/** The scale's notes within one period, as offsets in the layout's unit from
 *  its tonic — what the dialog lists, and what the keys are made of. */
export function scaleOffsets(scale) {
  const out = [];
  let acc = 0;
  for (const st of scale.steps) {
    out.push(round6(acc * scale.unitPerStep));
    acc += st;
  }
  return out;
}

/** Semitone values are fractions of twelve over a scale's own tuning; six
 *  places keeps a .taudkey readable and lands every key on its note. */
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The layout: every key of every row in `settings.rows` plays a note of the
 * scale. Along a row each key is the next note up; a row starts `rowStep`
 * scale notes above the one below it (one period, by default, so every row
 * begins on the tonic); the A row starts on the tonic in the keyboard's own
 * octave, the bottom row below it, the rows above it higher.
 *
 *   settings.tonic    where the scale starts, in the frame's unit: a degree of
 *                     the tuning, or a semitone above C
 *   settings.rowStep  scale notes from one row to the next; null for a period
 *   settings.rows     the physical rows to fill (ROW_ORDER names)
 *   settings.name     the layout's name
 *
 * Returns a normalised keymap spec, or null when the scale is not playable in
 * `frame`.
 */
export function makeScaleKeymap(settings, frame) {
  const scale = scaleOf(settings, frame);
  if (!scale) return null;
  const k = scale.steps.length;
  const cum = [0];
  for (const st of scale.steps) cum.push(cum[cum.length - 1] + st);
  const at = (j) => {
    const p = Math.floor(j / k);
    return p * scale.period + cum[j - p * k];
  };
  const rowStep = rowStepOf(settings, k);
  const tonic = Number.isFinite(settings.tonic) ? settings.tonic : 0;
  const rows = ROW_ORDER.filter((r) => (settings.rows ?? ["N", "Q", "A"]).includes(r));
  const overrides = {};
  for (const row of rows) {
    ROW_CODES[row].forEach((code, col) => {
      overrides[code] = round6(tonic + at(ROW_INDEX[row] * rowStep + col) * scale.unitPerStep);
    });
  }
  return normaliseKeymap({
    name: settings.name ?? "Scale",
    unit: frame.unit,
    rows,
    origin: { code: "KeyA", value: tonic },
    x: 0, y: 0, upper: 0,
    notation: null,
    overrides,
  });
}

/** Scale notes from one row to the next: the setting, or a whole period. */
export function rowStepOf(settings, notesPerPeriod) {
  const v = settings.rowStep;
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : notesPerPeriod;
}
