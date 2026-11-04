// chord_line (TML 2): a melody or bass line made from a chord progression.
//
// Every note is first drawn at random from the notes its chord allows — the
// raw material, keyed to the song's seed like every other choice — and the
// line is then the one that keeps as much of that material as a coherent line
// can: the cheapest path through a cost that rewards steps, punishes repeats
// and big leaps, wants a leap answered by a turn, lets a note outside the
// chord in only as a passing or neighbour note, keeps the line in the middle
// of its range and, given another line, away from parallel octaves and fifths.
//
// The path is found exactly (a Viterbi search over pairs of notes, since a
// leap's recovery and a passing note's resolution both need the note before
// the last), so the result is the global optimum of that cost — no annealing
// schedule to tune, and the same answer every time. `variety` scales the
// random material: 0 is the smoothest line there is, whatever the seed.
//
// Pure: pitches in, pitches out. The caller passes the noise and the step
// budget, so nothing here reads a clock, a stream or the host.

import { fail } from "./values.js";

/** The weights. Melody and bass differ in how they move, not in what they may
 *  play. Every number here is part of the output: change one and every
 *  chord_line in every song comes out differently. */
const W = {
  melody: {
    repeat: 2.5, step: 0, skip: 0.8, leap: 2, perDegree: 1.5,
    sameWayAfterLeap: 3, repeatAfterLeap: 1, skipBack: 0.5, twoSkips: 1,
    rootOnStrong: 0.5, otherOnStrong: 0,
  },
  bass: {
    repeat: 1.5, step: 0.3, skip: 0.8, leap: 1, perDegree: 0.35,
    sameWayAfterLeap: 1, repeatAfterLeap: 0.5, skipBack: 0, twoSkips: 0.5,
    rootOnStrong: 0, otherOnStrong: 4,
  },
};
const COMMON = {
  noise: 3,          // × variety: the random material's weight, per note
  passing: 1.5,      // a note outside its chord, on a weak note
  unresolved: Infinity,  // …that is not reached AND left by a step: never (a
                         // chord tone is always there instead)
  tessitura: 1.5,    // × (distance from the middle of the range / half the range)²
  overPeriod: 20,    // a leap wider than a period (and its tolerance)
  endOffRoot: 2,     // the last note not the last chord's root (unless `end` says)
  parallel: 8,       // parallel unisons/octaves/fifths with `against`
  hidden: 2,         // similar motion into one, the line leaping
  crossing: 10,      // on the wrong side of `against`
};
/** A "perfect" interval with `against`: within this many cents of a unison,
 *  a period or (in an octave tuning) a 3:2. */
const PERFECT_TOLERANCE = 25;
const FIFTH = 1200 * Math.log2(1.5);

/**
 * @param o.slots    [{classes: Set, root, strong, label}] one per note: the
 *                   chord's pitch classes and root class, and whether the note
 *                   is the first of its chord
 * @param o.scale    Set of pitch classes passing notes may use (the chords'
 *                   own classes are always in it)
 * @param o.lo, o.hi the range, inclusive (steps)
 * @param o.P        steps per period
 * @param o.cents    step → cents (any origin; only differences are used)
 * @param o.periodCents  the period in cents
 * @param o.role     "melody" | "bass"
 * @param o.start, o.end  a pitch the first / last note must be, or null
 * @param o.against  a list of pitches (or nulls) as long as the line, or null
 * @param o.noise    (i, pitch) → [0, 1), scaled by o.variety
 * @param o.variety  ≥ 0
 * @param o.charge   (n) → void: the whole search's n steps, charged before it
 *                   runs (to the program's budget)
 * @param o.name     a pitch's name, for errors
 * @returns pitches, one per slot
 */
export function chordLine(o) {
  const { slots, lo, hi, P, role, against } = o;
  const w = W[role];
  const N = slots.length;
  const pc = (s) => ((s % P) + P) % P;

  // the scale the line moves through: a "step" is one place along it
  const scale = new Set(o.scale);
  for (const sl of slots) for (const c of sl.classes) scale.add(c);
  if (o.start !== null) scale.add(pc(o.start));
  if (o.end !== null) scale.add(pc(o.end));
  const place = new Map();
  for (let s = lo; s <= hi; s++) if (scale.has(pc(s))) place.set(s, place.size);

  const mid = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
  const cand = [], unary = [], chordTone = [];
  for (let i = 0; i < N; i++) {
    const sl = slots[i];
    const fixed = i === 0 && o.start !== null ? o.start : i === N - 1 && o.end !== null ? o.end : null;
    const ps = [];
    if (fixed !== null) ps.push(fixed);
    else for (const s of place.keys()) if (sl.classes.has(pc(s)) || (!sl.strong && scale.has(pc(s)))) ps.push(s);
    if (!ps.length) throw fail(`no note of ${sl.label} lies within ${o.name(lo)}…${o.name(hi)}`);
    const us = [], ct = [];
    for (const s of ps) {
      const tone = sl.classes.has(pc(s));
      let u = o.variety * COMMON.noise * o.noise(i, s);
      if (sl.strong) u += pc(s) === sl.root ? w.rootOnStrong : w.otherOnStrong;
      else if (!tone) u += COMMON.passing;
      const d = (s - mid) / half;
      u += COMMON.tessitura * d * d;
      if (i === N - 1) {
        if (o.end === null && pc(s) !== sl.root) u += COMMON.endOffRoot;
        if (!tone && fixed === null) u += COMMON.unresolved;  // nothing after it to resolve to
      }
      if (against && against[i] !== null) {
        if (role === "bass" ? s >= against[i] : s <= against[i]) u += COMMON.crossing;
      }
      us.push(u); ct.push(tone);
    }
    cand.push(ps); unary.push(us); chordTone.push(ct);
  }

  const perfect = (a, b) => {
    const c = Math.abs(o.cents(a) - o.cents(b));
    const r = c % o.periodCents;
    if (Math.min(r, o.periodCents - r) <= PERFECT_TOLERANCE) return true;
    return Math.abs(o.periodCents - 1200) <= PERFECT_TOLERANCE && Math.abs(r - FIFTH) <= PERFECT_TOLERANCE;
  };
  /** Moving from slot i−1's note a to slot i's note b. */
  const pair = (i, a, b) => {
    const d = Math.abs(place.get(b) - place.get(a));
    let c = d === 0 ? w.repeat : d === 1 ? w.step : d === 2 ? w.skip : w.leap + w.perDegree * (d - 3);
    if (Math.abs(o.cents(b) - o.cents(a)) > o.periodCents + PERFECT_TOLERANCE) c += COMMON.overPeriod;
    if (against && against[i - 1] !== null && against[i] !== null) {
      const qa = against[i - 1], qb = against[i];
      if (perfect(b, qb) && a !== b && qa !== qb && Math.sign(b - a) === Math.sign(qb - qa)) {
        c += perfect(a, qa) ? COMMON.parallel : d >= 2 ? COMMON.hidden : 0;
      }
    }
    return c;
  };
  /** Three notes in a row: z (slot i−2), a (i−1), b (i); `aTone` = a is of its chord. */
  const triple = (z, a, b, aTone) => {
    const m1 = a - z, m2 = b - a;
    const d1 = Math.abs(place.get(a) - place.get(z)), d2 = Math.abs(place.get(b) - place.get(a));
    let c = 0;
    if (!aTone && (d1 !== 1 || d2 !== 1)) c += COMMON.unresolved;
    if (d1 >= 3) {
      if (m2 === 0) c += w.repeatAfterLeap;
      else if (Math.sign(m2) === Math.sign(m1)) c += w.sameWayAfterLeap;
      else if (d2 >= 2) c += w.skipBack;
    } else if (d1 >= 2 && d2 >= 2 && Math.sign(m1) === Math.sign(m2)) c += w.twoSkips;
    return c;
  };

  let work = 0;
  for (let i = 2; i < N; i++) work += cand[i - 2].length * cand[i - 1].length * cand[i].length;
  o.charge(work);

  if (N === 1) {
    let k = 0;
    for (let j = 1; j < cand[0].length; j++) if (unary[0][j] < unary[0][k]) k = j;
    return [cand[0][k]];
  }

  // V[a][b]: the cheapest line ending on (slot i−1 = cand[a], slot i = cand[b])
  let V = cand[0].map((pa, a) => cand[1].map((pb, b) => unary[0][a] + unary[1][b] + pair(1, pa, pb)));
  const back = [null, null];
  for (let i = 2; i < N; i++) {
    const A = cand[i - 1], B = cand[i], Z = cand[i - 2];
    const nV = [], bp = [];
    for (let a = 0; a < A.length; a++) {
      const row = new Array(B.length), brow = new Array(B.length);
      for (let b = 0; b < B.length; b++) {
        const base = unary[i][b] + pair(i, A[a], B[b]);
        let best = Infinity, arg = 0;
        for (let z = 0; z < Z.length; z++) {
          const c = V[z][a] + triple(Z[z], A[a], B[b], chordTone[i - 1][a]);
          if (c < best) { best = c; arg = z; }
        }
        row[b] = best + base; brow[b] = arg;
      }
      nV.push(row); bp.push(brow);
    }
    V = nV; back.push(bp);
  }
  // ties go to the lower pitches: candidates ascend and only a smaller cost wins
  let ba = 0, bb = 0;
  for (let a = 0; a < V.length; a++) for (let b = 0; b < V[a].length; b++) if (V[a][b] < V[ba][bb]) { ba = a; bb = b; }
  const ks = new Array(N);
  ks[N - 1] = bb; ks[N - 2] = ba;
  for (let i = N - 1; i >= 2; i--) ks[i - 2] = back[i][ks[i - 1]][ks[i]];
  return ks.map((k, i) => cand[i][k]);
}
