// Timbres that make a tuning consonant — the Timbre designer's maths.
//
// Give it an equal tuning (N equal steps to a period: 8-EDO, 31-EDO, or
// Bohlen–Pierce's 13 steps to a 3:1) and it designs an ADDITIVE spectrum —
// sine partials — whose roughness curve has its valleys ON the tuning's
// steps, at the register the instrument plays in. It also measures any
// spectrum against a tuning, ranks the chords a spectrum makes smooth, and
// gives each partial a decay. Pure: no DOM, no state.
//
// THE IDEA (Sethares' "related spectrum"). Two tones whose partials all lie on
// the tuning's grid relative to their own fundamentals, sounded a step of the
// grid apart, have partials that COINCIDE wherever they come near each other —
// and coincident partials do not beat. So the roughness curve dips on the
// grid. The plain way to make such a tone is to move each harmonic h of an
// ordinary spectrum to the nearest step, round(N · log_period h). That is
// usually most of the gain; designTimbre() starts there and searches nearby:
// in a coarse tuning two moved harmonics can land one step apart and grind
// (in 8-EDO the 6th and 7th fall on neighbouring steps, 150 cents apart), and
// some steps get no valley at all.
//
// THE MODEL is consonance.js's roughness (Plomp–Levelt as Sethares has it).
//
// A grid is { n, periodCents }: n equal steps to a period of periodCents
// (1200 for an octave). gridOf() reads one from a pitch-table preset.
//
// Everything is deterministic: the search's randomness is a seeded Mulberry32.
//
// The first version of this was written for an experiment, "Eightfold Baffling
// Incongruity Theorem" (OoT_musical_experiments/eight-bit/), and is kept there
// as a thin adapter over this module.

import { pairRoughness, crossRoughness, intrinsicRoughness, chordRoughness } from "./consonance.js";

export { pairRoughness, crossRoughness, intrinsicRoughness, chordRoughness };

/** 4096-TET units to the octave: the note word's and the detune field's scale. */
const UNITS_PER_OCTAVE = 0x1000;

// ── grids ───────────────────────────────────────────────────────────────────

/**
 * The equal grid a pitch-table preset is, or null: a preset whose degrees
 * stand equally apart (within a unit of the 4096-TET grid each) and repeat at
 * a period. ProTracker's absolute table, a just scale or a well temperament
 * are not grids — a partial a fixed number of degrees above one note would be
 * a different interval above another.
 */
export function gridOf(preset) {
  const table = preset?.table;
  const period = preset?.interval;
  if (!table || !period || table.length < 1) return null;
  const n = table.length;
  for (let k = 0; k < n; k++) {
    if (Math.abs(table[k] - table[0] - (k * period) / n) > 1.01) return null;
  }
  return { n, periodCents: (period * 1200) / UNITS_PER_OCTAVE };
}

/** The ratio `step` steps of `grid` make. */
export const stepRatio = (grid, step) => 2 ** ((step * grid.periodCents) / (grid.n * 1200));

/** The step of `grid` nearest a ratio (fractional; round it for a step). */
export const ratioStep = (grid, ratio) => (grid.n * 1200 * Math.log2(ratio)) / grid.periodCents;

/** Cents of one step. */
export const stepCents = (grid) => grid.periodCents / grid.n;

// ── spectra ─────────────────────────────────────────────────────────────────

/**
 * A partial is { ratio, amp } — its frequency over the fundamental's, and its
 * amplitude — with, for a designed one, `h` (the harmonic it stands for) and
 * `step` (its place on the grid). spectrumAt() sounds a list of them on `f0`.
 */
export function spectrumAt(partials, f0) {
  return partials.map((p) => [f0 * p.ratio, p.amp]);
}

/** The amplitude of harmonic h for a spectral `shape`: a number ρ gives
 *  ρ^(h−1); "bright" 1/h (a saw's); "soft" 1/h^1.5; "mellow" 1/h²; a function
 *  is called. */
export function harmonicAmp(h, shape) {
  if (typeof shape === "function") return shape(h);
  if (typeof shape === "number") return shape ** (h - 1);
  if (shape === "bright" || shape === "saw") return 1 / h;
  if (shape === "soft") return h ** -1.5;
  if (shape === "mellow" || shape === "dull") return h ** -2;
  throw new Error(`unknown spectral shape ${shape}`);
}

/** Amplitudes scaled to sum to 1, so tones compare at one loudness. */
export function normalise(partials) {
  const sum = partials.reduce((a, p) => a + p.amp, 0);
  return sum > 0 ? partials.map((p) => ({ ...p, amp: p.amp / sum })) : partials;
}

/** The first `count` harmonics `forbid` allows, untuned: the plain spectrum. */
export function harmonicPartials(count, shape = "bright", forbid = []) {
  const out = [];
  for (let h = 1; out.length < count && h < 8 * count + 8; h++) {
    if (h !== 1 && forbid.includes(h)) continue;
    out.push({ h, ratio: h, amp: harmonicAmp(h, shape) });
  }
  return normalise(out);
}

// ── curves ──────────────────────────────────────────────────────────────────

/**
 * The dyad roughness curve: the tone against itself transposed by every `res`
 * cents from `from` to `to`, at fundamental `f0`. Returns { cents, d }.
 */
export function dyadCurve(partials, { f0 = 261.63, from = 0, to = 1200, res = 1 } = {}) {
  const a = spectrumAt(partials, f0);
  const own = 2 * intrinsicRoughness(a);
  const cents = [], d = [];
  for (let c = from; c <= to + 1e-9; c += res) {
    const r = 2 ** (c / 1200);
    cents.push(c);
    d.push(own + crossRoughness(a, a.map(([f, amp]) => [f * r, amp])));
  }
  return { cents, d };
}

/** The curve's local minima, as [{ cents, d }]. */
export function curveMinima(curve) {
  const out = [];
  const { cents, d } = curve;
  for (let i = 1; i < d.length - 1; i++) if (d[i] < d[i - 1] && d[i] <= d[i + 1]) out.push({ cents: cents[i], d: d[i] });
  return out;
}

/**
 * How well a spectrum serves a grid, step by step (1…n by default): the
 * roughness ON the step (`at`), the lowest within half a step off the grid but
 * further than an eighth of one (`near`), `margin` = near − at — positive when
 * the step is a valley floor — and the nearest local minimum (`minAt`, cents).
 */
export function gridReport(partials, grid, { f0 = 261.63, steps = null } = {}) {
  const sc = stepCents(grid);
  const ks = steps ?? Array.from({ length: grid.n }, (_, i) => i + 1);
  const res = Math.max(0.25, Math.min(1, sc / 24));
  const curve = dyadCurve(partials, { f0, from: 0, to: Math.max(...ks) * sc + sc / 2, res });
  const at = (c) => curve.d[Math.max(0, Math.min(curve.d.length - 1, Math.round(c / res)))];
  const minima = curveMinima(curve);
  return ks.map((k) => {
    const c = k * sc;
    let near = Infinity;
    for (let i = 0; i < curve.cents.length; i++) {
      const dc = Math.abs(curve.cents[i] - c);
      if (dc > sc / 8 && dc <= sc / 2) near = Math.min(near, curve.d[i]);
    }
    let minAt = null;
    for (const m of minima) if (minAt === null || Math.abs(m.cents - c) < Math.abs(minAt - c)) minAt = m.cents;
    return { step: k, cents: c, at: at(c), near, margin: near - at(c), minAt };
  });
}

// ── what to make consonant ──────────────────────────────────────────────────

/**
 * The steps a design makes consonant, as [[step, weight]]: the steps nearest
 * the simple ratios within the period (n·d ≤ 40), each weighted 2/√(n·d) by
 * its simplest ratio — so a fifth counts for more than a minor sixth, and the
 * period most. In a grid of a dozen steps or fewer, every other step is asked
 * too, lightly (0.3): a coarse tuning plays all its steps as intervals. Asking
 * a minor second to be as smooth as a fifth would bend a 12-TET timbre out of
 * shape for nothing; in 31-EDO there is no use asking it of a 39-cent step.
 */
export function defaultTargets(grid) {
  const period = 2 ** (grid.periodCents / 1200);
  const best = new Map();
  for (let d = 1; d <= 40; d++) {
    for (let n = d + 1; n * d <= 40; n++) {
      const r = n / d;
      if (r > period * 1.0001) break;
      const k = Math.round(ratioStep(grid, r));
      if (k < 1 || k > grid.n) continue;
      best.set(k, Math.max(best.get(k) ?? 0, 2 / Math.sqrt(n * d)));
    }
  }
  best.set(grid.n, Math.max(best.get(grid.n) ?? 0, 2 / Math.sqrt(2)));
  if (grid.n <= 12) for (let k = 1; k <= grid.n; k++) if (!best.has(k)) best.set(k, 0.3);
  return [...best].sort((a, b) => a[0] - b[0]);
}

/**
 * What designTimbre() minimises, cheap enough to call thousands of times: for
 * each target step (weight w) the roughness on the step, less a reward for the
 * step being a valley floor (capped), plus a heavy penalty when it is not one;
 * plus the tone's own roughness. Probed at k·s and k·s ± {¼, ½}·s only.
 */
export function objective(partials, grid, { f0, targets, valley = 1, notMin = 8, ownWeight = 1 }) {
  const sc = stepCents(grid);
  const a = spectrumAt(partials, f0);
  const dAt = (c) => {
    const r = 2 ** (c / 1200);
    return crossRoughness(a, a.map(([f, amp]) => [f * r, amp]));
  };
  let score = ownWeight * intrinsicRoughness(a);
  for (const [k, w] of targets) {
    const c = k * sc;
    const on = dAt(c);
    const off = Math.min(dAt(c - sc / 4), dAt(c + sc / 4), dAt(c - sc / 2), dAt(c + sc / 2));
    const margin = off - on;
    score += w * (on - valley * Math.min(margin, 0.3) + (margin < 0 ? notMin * -margin : 0));
  }
  return score;
}

/** Mulberry32, the seeded stream the search draws from. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the design ──────────────────────────────────────────────────────────────

/**
 * Design a spectrum for a grid. The tone keeps the SHAPE of a harmonic
 * spectrum — partial j stands for a harmonic h_j and has its amplitude — but
 * every partial sits on the grid, at most `freedom` steps from its harmonic's
 * nearest step. The search chooses WHERE each goes and, with `choose`, also
 * WHICH harmonics, minimising objective() at the register `f0`. Amplitudes are
 * normalised to sum to 1 throughout, so a tone cannot win by being quieter.
 *
 *   grid       { n, periodCents }
 *   partials   P, how many
 *   shape      amplitude per harmonic (harmonicAmp)
 *   harmonics  H, the highest harmonic a partial may stand for (default 4·P)
 *   freedom    steps a partial may stray from its harmonic's (default 1; 0 is
 *              the plain tempered harmonic series, and searches nothing)
 *   choose     false: the harmonics are the first P that `forbid` allows (the
 *              instrument's recipe), only their places searched; true: the
 *              search may trade one harmonic for another
 *   require    harmonics that must stay when choosing (default [2])
 *   forbid     harmonics that must not be used (odd-only forbids the evens)
 *   f0         the fundamental it is designed at (Hz)
 *   targets    [[step, weight]] or { step: weight } (default defaultTargets)
 *   stray      what a partial pays for each step it moves from its harmonic's
 *              own step, as a share of the starting score times its amplitude
 *              (default 0): at 1 a move must earn its partial's share, so a
 *              tuning whose tempered harmonics are already good (12-TET) keeps
 *              them, and only a real gain bends a timbre out of shape
 *   restarts, iterations, seed — the search
 *
 * Returns { partials: [{ h, step, ratio, amp }] (ascending), score, start }:
 * `start` is the plain tempered series and its score.
 */
export function designTimbre(opts) {
  const {
    grid, partials: P, shape = "bright", f0 = 261.63, freedom = 1, choose = false,
    require = [2], forbid = [], restarts = 6, iterations = 1500, seed = 1,
    valley = 1, notMin = 8, ownWeight = 1, stray = 0,
  } = opts;
  const H = opts.harmonics ?? 4 * P;
  const targets = Array.isArray(opts.targets) ? opts.targets
    : opts.targets ? Object.entries(opts.targets).map(([k, w]) => [Number(k), w])
    : defaultTargets(grid);
  const params = { f0, targets, valley, notMin, ownWeight };
  const home = (h) => Math.round(ratioStep(grid, h));
  const fixedH = choose ? [1, ...require.filter((h) => h !== 1)] : [1];
  const poolH = [];
  for (let h = 2; h <= H; h++) if (!fixedH.includes(h) && !forbid.includes(h)) poolH.push(h);
  if (fixedH.length > P) throw new Error(`${P} partials cannot hold the ${fixedH.length} required`);
  const toPartials = (st) => normalise([...st].sort((a, b) => a.step - b.step)
    .map((x) => ({ h: x.h, step: x.step, ratio: stepRatio(grid, x.step), amp: harmonicAmp(x.h, shape) })));
  let strayUnit = 0; // set from the starting score below
  const score = (st) => {
    const ps = toPartials(st);
    let s = objective(ps, grid, params);
    if (strayUnit > 0) for (const p of ps) s += strayUnit * p.amp * Math.abs(p.step - home(p.h));
    return s;
  };
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const stepsFor = (h, st, self = null) => {
    if (h === 1) return [0];
    const out = [];
    for (let d = -freedom; d <= freedom; d++) {
      const s = home(h) + d;
      if (s > 0 && !st.some((x) => x !== self && x.step === s)) out.push(s);
    }
    return out;
  };
  const place = (h, st) => {
    const ok = stepsFor(h, st);
    if (!ok.length) return null;
    return { h, step: ok.includes(home(h)) ? home(h) : pick(ok) };
  };
  const build = (order) => {
    const st = [];
    for (const h of [...fixedH, ...order]) {
      if (st.length >= P) break;
      const x = place(h, st);
      if (x) st.push(x);
    }
    return st.length === P ? st : null;
  };
  const shuffled = () => {
    const xs = [...poolH];
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    return xs;
  };
  const start = build(poolH);
  if (!start) throw new Error(`cannot place ${P} partials on distinct steps from harmonics up to ${H}`);
  const startScore = score(start);
  strayUnit = stray * startScore;
  let best = { st: start, score: startScore };
  const searching = freedom > 0 || choose;
  for (let r = 0; searching && r < restarts; r++) {
    let cur = r === 0 || !choose ? start.map((x) => ({ ...x })) : build(shuffled());
    if (!cur) continue;
    let cs = score(cur);
    for (let it = 0; it < iterations; it++) {
      const free = cur.filter((x) => x.h !== 1);
      if (!free.length) break;
      const x = pick(free);
      let next;
      if (!choose || rnd() < 0.5) {
        const ok = stepsFor(x.h, cur, x).filter((s) => s !== x.step);
        if (!ok.length) continue;
        next = cur.map((y) => (y === x ? { h: y.h, step: pick(ok) } : { ...y }));
      } else {
        if (fixedH.includes(x.h)) continue;
        const unused = poolH.filter((h) => !cur.some((y) => y.h === h));
        if (!unused.length) continue;
        const rest = cur.filter((y) => y !== x).map((y) => ({ ...y }));
        const y = place(pick(unused), rest);
        if (!y) continue;
        next = [...rest, y];
      }
      const ns = score(next);
      if (ns <= cs) { cur = next; cs = ns; }
    }
    if (cs < best.score) best = { st: cur, score: cs };
  }
  return { grid, f0, shape, partials: toPartials(best.st), score: best.score,
    start: { partials: toPartials(start), score: startScore } };
}

/** Every chord of `size` notes (the root, step 0, and size−1 others) within
 *  `span` steps (a period by default), ranked by the roughness BETWEEN its
 *  tones per pair (so triads and tetrads compare), smoothest first. */
export function rankChords(partials, grid, { f0 = 261.63, size = 3, span = null } = {}) {
  const top = span ?? grid.n;
  const out = [];
  const rec = (start, chord) => {
    if (chord.length === size) {
      const tones = chord.map((s) => spectrumAt(partials, f0 * stepRatio(grid, s)));
      const own = tones.reduce((acc, t) => acc + intrinsicRoughness(t), 0);
      const total = chordRoughness(tones);
      out.push({ chord: [...chord], d: (total - own) / ((size * (size - 1)) / 2), total });
      return;
    }
    for (let s = start; s <= top; s++) rec(s + 1, [...chord, s]);
  };
  rec(1, [0]);
  return out.sort((x, y) => x.d - y.d);
}

// ── envelopes ───────────────────────────────────────────────────────────────

/**
 * An exponential decay e^(−rate·t) as envelope points [seconds, 0…63], one
 * every halving. With `hold` (0…1) it settles at that fraction and stays (the
 * last point is held); without, it ends at 0 at the first halving that rounds
 * to nothing. At most 25 points, 15.75 s apart (an instrument envelope's).
 */
export function decayPoints(rate, hold = 0) {
  const half = Math.LN2 / rate;
  const pts = [[0, 63]];
  let t = 0, v = 63;
  const floorV = 63 * hold;
  for (;;) {
    const nv = v / 2;
    if (hold > 0 && nv <= floorV) {
      pts.push([round3(Math.log(1 / hold) / rate), Math.round(floorV)]);
      break;
    }
    t += half; v = nv;
    pts.push([round3(t), Math.round(v)]);
    if (Math.round(v) === 0 || pts.length >= 25) break;
  }
  return pts.filter((p, k) => k === 0 || p[0] - pts[k - 1][0] <= 15.75);
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * How much faster a partial at `ratio` decays than the note does, for a struck
 * tone whose note decays with time constant `tau` (s) and whose partials decay
 * with tau·ratio^(−damping): the EXTRA rate, 1/s, ≥ 0. A rack applies the
 * note's envelope (its principal's) to the whole patch, so a partial's own
 * envelope carries only this extra. `quant` rounds the rate to a grid (a third
 * of an octave by default), so partials of near ratios share an envelope.
 */
export function extraDecayRate(ratio, tau, damping, quant = 2 ** (1 / 3)) {
  const rate = 1 / (tau * ratio ** -damping) - 1 / tau;
  if (!(rate > 1e-6)) return 0;
  return quant ? quant ** Math.round(Math.log(rate) / Math.log(quant)) : rate;
}

/** Decibels for an amplitude. */
export const ampDb = (a) => 20 * Math.log10(a);
