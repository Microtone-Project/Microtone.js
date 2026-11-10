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
// its modes, in a choice of EQUAVE — the interval the scale repeats at:
// the octave, the tritave (Bohlen–Pierce's, and the Xenharmonic Wiki's
// "⟨3/1⟩" MOS pages), the fifth, or a tuning's own odd period. In the song's
// tuning an equave is the nearest whole number of its degrees — the same
// "patent" reading the diatonic gives its fifths — so 12-TET's tritave is 19
// degrees (2 ¢ flat) and Bohlen–Pierce's exactly 13; in any tuning the L:s
// ratio makes an equal division of it (6L 3s⟨3/1⟩ at 2:1 is 15-EDT).
//
// Two ARRANGEMENTS of the scale on the board. "piano" (the default) is the
// keyboard a pianist expects, generalised: the scale on a white row, and on the
// row above it one black key in every LARGE step, nothing over the small ones —
// for the major scale in 12-TET that is Double-Deck Piano 12 key for key. Every
// scale offered has exactly two step sizes L > s, and the black key splits L
// into the chroma c = L − s and s (the step of the scale's child MOS), so it
// sits a chroma above the white key below it (a sharp) or a chroma below the
// one above (a flat); the two differ wherever c ≠ s (31-TET: C♯ +2, D♭ +3).
// "inkey" is the Launchpad's in-key mode: every key a note of the scale.
//
// Pure and Node-testable — no DOM, no storage.

import { isAbsolute } from "../../core/tuning/pitchtables.js";
import { edoSteps } from "../../core/tuning/intervals.js";
import { ROW_CODES, ROW_INDEX, ROW_ORDER, normaliseKeymap } from "./keymap.js";

const OCTAVE = 0x1000;

export const MAKER_MODES = Object.freeze(["tuning", "any"]);
export const ARRANGEMENTS = Object.freeze(["piano", "inkey"]);
/** Where a black key sits in its large step: a chroma above the white key
 *  below it, or a chroma below the one above. */
export const BLACK_KEYS = Object.freeze(["sharp", "flat"]);
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
/** The equaves a MOS can repeat at, as their ratios. "period" (not listed) is
 *  a tuning's own period where it is none of these (an imported notation). */
export const EQUAVES = Object.freeze(["octave", "tritave", "fifth"]);
const EQUAVE_RATIO = Object.freeze({ octave: 2, tritave: 3, fifth: 3 / 2 });
const cents = (ratio) => 1200 * Math.log2(ratio);
/** How near a tuning's period must be to an equave to BE it. */
const SAME_CENTS = 0.5;

/** The step-size ratios offered in "any" mode, softest first. Coprime, since
 *  in semitones only the RATIO of L to s matters (6:2 is 3:1 twice over). */
export const ANY_MOS_SIZES = Object.freeze([
  [5, 4], [4, 3], [3, 2], [5, 3], [2, 1], [5, 2], [3, 1], [4, 1], [5, 1],
].map(Object.freeze));

/**
 * What a scale is counted in.
 *   unit    the keymap unit the layout is written in ("deg" or "semi")
 *   n       steps per period of the frame (the tuning's degrees, or 12)
 *   cents   how wide that period is
 *   octave  is the period an octave — the diatonic scales need one
 *   usable  false when the frame cannot hold a scale at all (a Raw song)
 *
 * An absolute table (ProTracker's) is a finite list of every note rather than
 * a period of degrees, but it steps a semitone per entry, so it is counted as
 * 12-EDO semitones and snaps back onto itself.
 */
export function makerFrame(mode, preset) {
  if (mode === "any") return { mode, unit: "semi", n: 12, cents: 1200, octave: true, usable: true };
  const n = preset?.table?.length ?? 0;
  if (n === 0) return { mode, unit: "deg", n: 0, cents: 0, octave: false, usable: false };
  if (isAbsolute(preset)) return { mode, unit: "semi", n: 12, cents: 1200, octave: true, usable: true };
  return {
    mode, unit: "deg", n, cents: (preset.interval * 1200) / OCTAVE,
    octave: preset.interval === OCTAVE, usable: true,
  };
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

/** Every MOS pattern offered: a large and b small steps, four to twelve
 *  notes, ordered by size, then by how many steps are large. `periods` is
 *  gcd(a, b): a pattern whose counts share a factor is a MULTI-PERIOD MOS — still
 *  a scale of the whole octave (the equave), its step pattern repeating every
 *  1/periods of it: 4L 2s and 6L 2s every half octave, 3L 3s (12-TET's
 *  augmented scale at 3:1) every third, 4L 4s (the octatonic at 2:1) every
 *  quarter. Not the smaller scale "twice": 4L 2s is not 2L 1s. */
export function mosPatterns() {
  const out = [];
  for (let size = 4; size <= MOS_MAX_NOTES; size++) {
    for (let a = size - 1; a >= 1; a--) {
      const b = size - a;
      out.push({ a, b, size, periods: gcd(a, b) });
    }
  }
  return out;
}

/**
 * The pattern's modes, BRIGHTEST first, as words of "L" and "s".
 *
 * The brightest mode is the upper Christoffel word of ONE PERIOD — step i is
 * large exactly when ⌈(i+1)·a'/N'⌉ steps past ⌈i·a'/N'⌉, a' = a/periods and
 * N' = (a+b)/periods — repeated once per period: LLLsLLs (Lydian) for 5L 2s,
 * LLLsLLLs for 6L 2s. The others are its rotations, so a multi-period MOS has
 * only N' modes (rotating by a whole period gives the same word back);
 * brighter means every note sits at least as high, which for a MOS is the same
 * order as the sum of how many large steps lie below each note.
 */
export function mosModes(a, b) {
  const d = gcd(a, b), pa = a / d, pn = (a + b) / d;
  let period = "";
  for (let i = 0; i < pn; i++) {
    period += Math.ceil(((i + 1) * pa) / pn) - Math.ceil((i * pa) / pn) === 1 ? "L" : "s";
  }
  const word = period.repeat(d), N = a + b;
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

// ── equaves ──

/** The equave a tuning repeats at by itself: the one its period is, else
 *  its own "period". Any tuning: the octave. */
export function naturalEquave(frame) {
  if (frame.mode === "any" || !frame.usable) return "octave";
  return EQUAVES.find((e) => Math.abs(cents(EQUAVE_RATIO[e]) - frame.cents) < SAME_CENTS) ?? "period";
}

/** The equaves on offer in `frame`: the three, and the tuning's own period
 *  when it is none of them. */
export function equaveChoices(frame) {
  return naturalEquave(frame) === "period" ? [...EQUAVES, "period"] : [...EQUAVES];
}

/** `equave` if `frame` offers it, else the frame's own. */
export function equaveOf(equave, frame) {
  return equaveChoices(frame).includes(equave) ? equave : naturalEquave(frame);
}

/** The equave's true width in cents. */
export function equaveCents(equave, frame) {
  return equave === "period" ? frame.cents : cents(EQUAVE_RATIO[equave]);
}

/**
 * The equave in `frame`'s steps — the nearest whole number of the tuning's
 * degrees (exact for its own period), and how far that is off, in cents —
 * or null in "any" mode, where a MOS's ratio makes the steps.
 */
export function equaveSteps(equave, frame) {
  if (frame.mode === "any" || !frame.usable) return null;
  if (equave === "period") return { n: frame.n, error: 0 };
  const step = frame.cents / frame.n, want = equaveCents(equave, frame);
  const n = Math.round(want / step);
  return { n, error: n * step - want };
}

/**
 * The step sizes the pattern can take in `frame`, repeating at `equave`
 * (the frame's own when absent), as [L, s] pairs with L > s ≥ 1. In a tuning
 * they are exactly the pairs that fill the equave's degrees, a·L + b·s = n —
 * 5L 2s in 31-TET is 5 and 3 and nothing else — so an empty list is a pattern
 * the tuning cannot play there. In "any" mode they are ratios
 * (ANY_MOS_SIZES), each of which makes an equal division of its own.
 */
export function mosSizes(a, b, frame, equave = naturalEquave(frame)) {
  if (frame.mode === "any") return ANY_MOS_SIZES.map((p) => [...p]);
  if (!frame.usable) return [];
  const n = equaveSteps(equaveOf(equave, frame), frame).n;
  const out = [];
  for (let s = 1; b * s < n; s++) {
    const rest = n - b * s;
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
  return mosPatterns().some((p) => equaveChoices(frame).some((e) => mosSizes(p.a, p.b, frame, e).length > 0));
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
 *   settings.mos      { a, b, L, s, mode, equave } — mode indexes
 *                     mosModes(a, b); equave an EQUAVES entry or "period",
 *                     the frame's own when absent
 *
 * `equave` says what the steps fill: the octave for the diatonic kinds.
 */
export function scaleOf(settings, frame) {
  if (!frame.usable) return null;
  let steps = null, word = null, equave = "octave";
  if (settings.kind === "penta") steps = diatonicPattern("penta", settings.penta, frame);
  else if (settings.kind === "hepta") steps = diatonicPattern("hepta", settings.hepta, frame);
  else if (settings.kind === "mos") {
    const m = settings.mos ?? {};
    equave = equaveOf(m.equave, frame);
    const sizes = mosSizes(m.a, m.b, frame, equave);
    if (!sizes.some(([L, s]) => L === m.L && s === m.s)) return null;
    const modes = mosModes(m.a, m.b);
    word = modes[Math.min(Math.max(m.mode | 0, 0), modes.length - 1)];
    steps = [...word].map((c) => (c === "L" ? m.L : m.s));
  }
  if (!steps) return null;
  const period = steps.reduce((x, y) => x + y, 0);
  // Degrees are degrees (and an absolute table's semitones are its degrees);
  // in any tuning, semitones divide the equave among the scale's own equal
  // division, which for the diatonic family is 12 and so whole numbers.
  const unitPerStep = frame.mode === "any" ? equaveCents(equave, frame) / 100 / period : 1;
  return { steps, period, unitPerStep, word, equave };
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

/**
 * The scale's two step sizes and its chroma, in the scale's own steps (degrees
 * of the tuning, or of the equal tuning a MOS defines) — or null where every
 * step is the same size (5-TET's pentatonic) and there is nothing for a black
 * key to split.
 */
export function scaleChroma(scale) {
  const L = Math.max(...scale.steps), s = Math.min(...scale.steps);
  return L > s ? { L, s, c: L - s } : null;
}

/** Can the scale be laid out as a piano — does it have large steps to put
 *  black keys in? */
export const pianoAvailable = (scale) => scale !== null && scaleChroma(scale) !== null;

/** Semitone values are fractions of twelve over a scale's own tuning; six
 *  places keeps a .taudkey readable and lands every key on its note. */
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The layout, in one of the two ARRANGEMENTS.
 *
 * "inkey": every key of every row in `settings.rows` plays a note of the
 * scale. Along a row each key is the next note up; a row starts `rowStep`
 * scale notes above the one below it (one period, by default, so every row
 * begins on the tonic); the A row starts on the tonic in the keyboard's own
 * octave, the bottom row below it, the rows above it higher.
 *
 * "piano": the rows pair up into DECKS from the lowest one in use — that row
 * white, the physical row above it black, the next white, and so on (all four
 * rows: Z/A and Q/numbers, the Double-Deck pianos' shape; A, Q and the numbers:
 * A/Q and a white number row). The lowest white row starts on the tonic, each
 * white row runs up the scale, and a deck starts `rowStep` scale notes above
 * the one below. A key of a black row sits between the two white keys under
 * it — the same column and the one before it, which is where it physically is
 * on a staggered keyboard (S between Z and X) — and plays the black key of
 * that step if the step is large, nothing if it is small. A row that is not in
 * `settings.rows` is not written, but still counts for which row is which.
 *
 *   settings.tonic        where the scale starts, in the frame's unit: a degree
 *                         of the tuning, or a semitone above C
 *   settings.rowStep      scale notes from one row (deck) to the next; null
 *                         for a period
 *   settings.rows         the physical rows to fill (ROW_ORDER names)
 *   settings.arrangement  ARRANGEMENTS entry, "piano" when absent; a scale with
 *                         one step size is laid out "inkey" whatever it says
 *   settings.blackKeys    BLACK_KEYS entry, "sharp" when absent
 *   settings.name         the layout's name
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
  const stepAt = (j) => scale.steps[((j % k) + k) % k];
  const rowStep = rowStepOf(settings, k);
  const tonic = Number.isFinite(settings.tonic) ? settings.tonic : 0;
  const rows = ROW_ORDER.filter((r) => (settings.rows ?? ["N", "Q", "A"]).includes(r));
  const value = (steps) => round6(tonic + steps * scale.unitPerStep);
  const overrides = {};
  const chroma = scaleChroma(scale);
  const piano = arrangementOf(settings, scale) === "piano";
  if (piano) {
    const split = settings.blackKeys === "flat" ? chroma.s : chroma.c;
    const lowest = ROW_INDEX[rows[0]];
    for (const row of rows) {
      const h = ROW_INDEX[row] - lowest;
      const start = (h >> 1) * rowStep;
      ROW_CODES[row].forEach((code, col) => {
        const j = start + col;
        if (!(h & 1)) overrides[code] = value(at(j));
        else overrides[code] = stepAt(j - 1) === chroma.L ? value(at(j - 1) + split) : null;
      });
    }
  } else {
    for (const row of rows) {
      ROW_CODES[row].forEach((code, col) => {
        overrides[code] = value(at(ROW_INDEX[row] * rowStep + col));
      });
    }
  }
  return normaliseKeymap({
    name: settings.name ?? "Scale",
    unit: frame.unit,
    rows,
    origin: { code: piano ? ROW_CODES[rows[0]][0] : "KeyA", value: tonic },
    x: 0, y: 0, upper: 0,
    notation: null,
    overrides,
  });
}

/** The arrangement the layout really gets: the setting, unless the scale has
 *  no large steps to hang black keys in. */
export function arrangementOf(settings, scale) {
  if (!pianoAvailable(scale)) return "inkey";
  return settings.arrangement === "inkey" ? "inkey" : "piano";
}

/** Scale notes from one row to the next: the setting, or a whole period. */
export function rowStepOf(settings, notesPerPeriod) {
  const v = settings.rowStep;
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : notesPerPeriod;
}
