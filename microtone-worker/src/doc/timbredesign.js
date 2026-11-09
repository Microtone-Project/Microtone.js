// The Timbre designer's settings → a sound (item 307).
//
// A simple additive sound designer that happens to know the song's tuning:
// pick how many partials, how bright, how it is struck or held, and where it
// should sound best, and it writes an Easy Mode FM rack — every partial a sine
// operator summed into the output, each with its own decay. When the song's
// notation is an equal grid (8-EDO, 31-EDO, Bohlen–Pierce…), the partials can
// be put ON that grid, so the instrument's own overtones agree with the
// tuning's steps and its chords stop beating (core/tuning/timbre.js has the
// maths and the reasons).
//
// Pure: settings in, a design and a rack spec out. bankmerge.js planTimbreFm
// turns the spec into instruments; src/ui/popups/timbredesigner.js is the
// dialog.

import {
  designTimbre, harmonicPartials, harmonicAmp, normalise, decayPoints, extraDecayRate,
  stepRatio, gridReport, rankChords, ampDb, defaultTargets,
} from "../../core/tuning/timbre.js";

/** Spectra: how bright, and — for the bell — free to choose its partials. */
export const TIMBRE_SPECTRA = Object.freeze(["bright", "soft", "mellow", "hollow", "bell"]);
/** Where the partials go: the harmonic series as it is, its harmonics moved
 *  to the nearest step of the grid, or moved where the search finds the
 *  tuning's chords smoothest. */
export const TIMBRE_PLACEMENTS = Object.freeze(["harmonic", "grid", "smoothest"]);
/** The note's shape. */
export const TIMBRE_SHAPES = Object.freeze(["held", "struck", "plucked"]);
/** A true FM modulator on the fundamental for the attack. */
export const TIMBRE_BITES = Object.freeze(["none", "light", "strong"]);

export const TIMBRE_MIN_PARTIALS = 2;
/** 16 rack entries: the principal, the partials and room for the bite. */
export const TIMBRE_MAX_PARTIALS = 14;

/** C4's frequency and note word (4096-TET units, an octave = $1000). */
const C4_HZ = 261.6255653005986;
const C4_WORD = 0x5000;

/** Ticks a second the release is converted at: 125 BPM (fadeout runs per
 *  tick, so a release set here is longer at slower tempos). */
export const TIMBRE_RELEASE_TICKS_PER_SEC = 50;

export function defaultTimbreSettings() {
  return {
    partials: 6,
    spectrum: "bright",
    placement: "smoothest",
    register: C4_WORD,
    shape: "struck",
    attack: 0.01,      // s (held)
    decay: 1.5,        // s: the note's time constant (struck), its fall (plucked)
    sustain: 0.4,      // 0…1 (plucked)
    release: 0.3,      // s
    brightness: 1,     // how much faster high partials die (0 = all alike)
    bite: "none",
  };
}

/** The frequency of a note word. */
export const wordHz = (word) => C4_HZ * 2 ** ((word - C4_WORD) / 0x1000);

/** How a spectrum is made. */
function recipe(spectrum) {
  switch (spectrum) {
    case "soft": return { shape: "soft" };
    case "mellow": return { shape: "mellow" };
    case "hollow": return { shape: "soft", forbid: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32] };
    case "bell": return { shape: 0.62, choose: true, harmonics: 14, require: [], wider: true };
    default: return { shape: "bright" };
  }
}

/**
 * The design for `settings` on `grid` (null: the notation is not an equal
 * grid, and the partials stay harmonic). Returns
 *   { partials: [{ h, ratio, amp, step? }], plain, placement, grid, f0,
 *     report?, chord?, score?, startScore? }
 * — `plain` the same recipe on the untouched harmonic series, for comparison;
 * `placement` the one actually used (harmonic when there is no grid).
 */
export function designFromSettings(settings, grid, { restarts = 4, iterations = 800 } = {}) {
  const P = Math.max(TIMBRE_MIN_PARTIALS, Math.min(TIMBRE_MAX_PARTIALS, Math.round(settings.partials)));
  const r = recipe(settings.spectrum);
  const f0 = wordHz(settings.register);
  const plain = harmonicPartials(P, r.shape, r.forbid ?? []);
  const placement = grid ? settings.placement : "harmonic";
  if (placement === "harmonic") return { partials: plain, plain, placement, grid, f0 };
  const freedom = placement === "grid" ? 0 : r.wider ? 2 : 1;
  const d = designTimbre({
    grid, partials: P, shape: r.shape, f0, freedom,
    choose: placement === "smoothest" && !!r.choose,
    harmonics: r.harmonics, require: r.require, forbid: r.forbid ?? [],
    restarts, iterations, seed: 1, stray: 0.5,
  });
  return {
    partials: d.partials, plain, placement, grid, f0,
    score: d.score, startScore: d.start.score,
  };
}

/**
 * How the design serves the grid, or null without one: `report` the grid
 * report step by step (gridReport), `valleys` how many steps are valley
 * floors, `chord` the smoothest triad that doubles no period (steps above the
 * root; null in a grid finer than 24 steps, where it would take too long to
 * find and mean little). Cached on the design.
 */
export function designReport(design) {
  if (!design.grid) return null;
  if (design._report) return design._report;
  // The steps it aims at: every step of a coarse grid, the ones nearest the
  // simple ratios in a fine one (defaultTargets).
  const steps = defaultTargets(design.grid).map(([k]) => k);
  const report = gridReport(design.partials, design.grid, { f0: design.f0, steps });
  const chords = design.grid.n <= 24 ? rankChords(design.partials, design.grid, { f0: design.f0, size: 3 }) : [];
  const chord = chords.find((c) => !c.chord.includes(design.grid.n))?.chord ?? null;
  const out = { report, valleys: report.filter((x) => x.margin > 0).length, steps: report.length, chord };
  Object.defineProperty(design, "_report", { value: out, enumerable: false });
  return out;
}

/** The bite's level (dB, a modulation index) and decay (s). */
const BITE = { light: { level: -12, decay: 0.03 }, strong: { level: -5, decay: 0.04 } };

/** Fadeout units (per tick, out of 1024) for a release of `sec` seconds. */
export function releaseFadeout(sec) {
  return Math.max(1, Math.min(4095, Math.round(1024 / (Math.max(0.01, sec) * TIMBRE_RELEASE_TICKS_PER_SEC))));
}

/**
 * The rack a design becomes, as planTimbreFm takes it:
 *   { ops: [{ ratio, gain, env, name }],   the partials, fundamental first
 *     bite: { ratio, gain, env } | null,   modulating the fundamental
 *     principal: { env, fadeout } }
 * Gains are linear (the amplitudes, which sum to 1); an envelope is
 * { points: [[seconds, 0…63], …], sustain: index | null } or null for none.
 * The principal's envelope is the note's, applied to the whole patch; a
 * partial's own envelope carries only how much FASTER it decays than that.
 */
export function timbreSpec(design, settings) {
  const s = settings;
  const tau = Math.max(0.02, s.decay);
  const sus = Math.max(0, Math.min(1, s.sustain));
  const att = Math.max(0, s.attack);
  const rel = Math.max(0.01, s.release);
  let principal;
  if (s.shape === "held") {
    principal = { points: [[0, 0], [att, 63], [att + rel, 0]], sustain: 1 };
  } else if (s.shape === "plucked") {
    const restV = Math.round(63 * sus);
    principal = {
      points: [[0, 63], [round3(tau * 0.35), Math.round(63 * 0.7 + restV * 0.3)], [round3(tau), restV], [round3(tau + rel), 0]],
      sustain: 2,
    };
  } else {
    principal = { points: decayPoints(1 / tau), sustain: null };
  }
  const ops = design.partials.map((p, i) => {
    let env = null;
    if (i > 0 && s.shape !== "held" && s.brightness > 0) {
      const rate = extraDecayRate(p.ratio, tau, s.brightness);
      if (rate > 0) env = { points: decayPoints(rate, s.shape === "plucked" ? Math.max(0.05, sus) : 0), sustain: null };
    }
    return { ratio: p.ratio, gain: p.amp, env, name: `Partial ${p.h}` };
  });
  const b = BITE[s.bite];
  const bite = b ? { ratio: 1, gain: 10 ** (b.level / 20), env: { points: decayPoints(1 / b.decay), sustain: null } } : null;
  return { ops, bite, principal: { env: principal, fadeout: releaseFadeout(rel) } };
}

/** Background voices a note of the design takes: every operator but the
 *  principal (the engine has 64 for every sounding note and ghost). */
export function timbreVoices(settings) {
  const P = Math.max(TIMBRE_MIN_PARTIALS, Math.min(TIMBRE_MAX_PARTIALS, Math.round(settings.partials)));
  return P + (settings.bite !== "none" ? 1 : 0);
}

/** Each partial for the dialog's table: harmonic, step (or null), cents away
 *  from the harmonic, level in dB. */
export function partialRows(design) {
  return design.partials.map((p) => ({
    h: p.h,
    step: p.step ?? null,
    cents: p.step === undefined ? 0 : 1200 * Math.log2(p.ratio / p.h),
    db: ampDb(p.amp),
  }));
}

const round3 = (x) => Math.round(x * 1000) / 1000;

export { stepRatio, harmonicAmp, normalise };
