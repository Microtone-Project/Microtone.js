// Harmonic (scalar) transposition — the "intelligent harmoniser".
//
// The user says how far ONE note — the base note, the first in the passage —
// should move ("up 4 semitones", "up 5 steps of 31-TET"), and the machine
// works out what that means for every other note: a third above C is E, but a
// third above D in C major is F, not F♯. Four stages, all in the tuning's own
// degree space (scales.js), so 12-TET, 31-TET, a Pythagorean table and
// Bohlen–Pierce are handled by the same lines:
//
//  1. Infer the local pitch set. The passage and everything sounding with it
//     are split into windows; each window scores every scale of the
//     vocabulary by how well it explains the notes heard there (weighted by
//     duration and metric position), with the whole song's notes as a gentle
//     prior and the scale's own plausibility (diatonic before harmonic minor
//     before chromatic) on top. A Viterbi pass over the windows lets the key
//     MODULATE — and because the accompaniment is evidence too, a V7 in A
//     minor pulls that window to harmonic minor, which is chord–scale theory
//     falling out of the arithmetic rather than being written in.
//  2. Find the degree shift k. Only scales containing BOTH the base note and
//     its requested target are allowed in the base note's window — the user's
//     interval is the strongest evidence there is. k is then the number of
//     scale steps between them; a window in a scale of another size scales k
//     by cardinality, so "a third" stays a third.
//  3. Map every note k steps along its window's scale. Notes outside the scale
//     (passing tones, blue notes) follow a policy: keep their offset from the
//     nearest scale degree, move by the same real interval as that degree,
//     snap onto the scale, or move chromatically. Directional scales (melodic
//     minor, Rast) read a note in the form its melodic direction calls for.
//  4. Optionally avoid clashes. Each note gets a few candidates (the scalar
//     result, the chromatic one, the scale neighbours of the scalar one) and a
//     Viterbi pass per lane minimises: deviation from the scalar result,
//     dissonance against notes sounding at the same time (harmonic entropy by
//     default — consonance.js — weighted by beat strength), changes of kind
//     mid-phrase, and deviation from the parallel contour. The requested
//     interval is thus a strong prior rather than a hard rule — except for the
//     base note itself, which always lands exactly where the user asked.
//
// A request no scale can satisfy (one semitone in 12-TET) leaves only the
// chromatic set, and the result IS a chromatic transposition. Pure — no DOM.

import { degreeSpace, scaleVocabulary, RAW_CLUSTER_TOL } from "./scales.js";
import { dissonanceMetric } from "./consonance.js";

export const CHROMATIC_POLICIES = Object.freeze(["offset", "neighbour", "snap", "chromatic"]);

export const HARMONISE_DEFAULTS = Object.freeze({
  /** Rows per inference window — the time grain modulations are found at. */
  window: 8,
  /** Rows per beat, for weighting by duration and metric position. */
  rowsPerBeat: 4,
  /** What happens to notes outside the inferred scale (CHROMATIC_POLICIES). */
  policy: "offset",
  /** Run stage 4 against the notes that are NOT being moved. */
  avoidClashes: true,
  /** "entropy", "sethares", or `(noteA, noteB) => 0..1`. */
  metric: "entropy",
  /** Scale hypotheses carried through the modulation pass. */
  maxStates: 32,
  /** Probability mass a scale leaves for notes outside it. */
  epsilon: 0.02,
  /** Force one scale for the whole passage: {family, root} from the vocabulary. */
  scale: null,
});

// stage-1 weights
const SWITCH_COST = 1.0;     // entering a different scale…
const SWITCH_PER_NOTE = 0.5; // …plus this per pitch class the two disagree on
const GLOBAL_PRIOR = 1.5;    // beats of whole-song evidence each window carries
const BASE_GLOBAL = 6;       // …and the base note's window, which decides k on little
                             // local evidence, so it leans on the wider context
const SUSTAIN_WEIGHT = 0.7;  // a note held into a window, relative to its onset
// The scale that defines k may differ from the passage's own best reading by at
// most this many pitch classes (one altered degree — natural vs harmonic minor).
// A request only a foreign key can express ("a semitone up" over C major) is
// chromatic by intent, and is carried out as such.
const MAX_KEY_DISTANCE = 2;
// stage-4 weights
const COST_CHROMATIC = 1.5;
const COST_OUT_OF_SCALE = 1.0;
const COST_NEIGHBOUR = 2.0;
const COST_KIND_CHANGE = 0.75;
const COST_LEAP = 0.35;      // per semitone of departure from the parallel contour
const DISSONANCE_WEIGHT = 4.0;
const DISSONANCE_FLOOR = 0.3; // below this an interval is consonant enough to ignore

const mod = (a, n) => ((a % n) + n) % n;

/**
 * Transpose notes harmonically.
 *
 * @param preset  the song's pitch-table preset (pitchtables.js)
 * @param input   { moving, fixed, global? }
 *   moving  the notes to transpose: [{id, pitch, lane, occ: [{t, dur, beat}]}]
 *           — `occ` lists every time the note sounds (a pattern placed twice
 *           sounds twice; it can still only be written one way), `t` and
 *           `dur` in rows, `beat` a metric weight (1 weak … 1.5 downbeat);
 *   fixed   notes that stay where they are: [{pitch, t, dur, beat}] — the
 *           accompaniment, used as evidence and as what clashes are judged
 *           against;
 *   global  optional extra evidence for the whole-song prior (same shape as
 *           fixed); defaults to moving + fixed.
 * @param opts    { fine, coarse } — the base note's shift in the fine unit of
 *           the notation (semitones / steps / raw units) and whole periods —
 *           plus any HARMONISE_DEFAULTS override.
 * @returns { pitches: Map(id → note word), report }
 */
export function harmoniseTranspose(preset, input, opts = {}) {
  const o = { ...HARMONISE_DEFAULTS, ...opts };
  const fine = o.fine | 0, coarse = o.coarse | 0;
  const moving = input.moving.filter((m) => m.occ && m.occ.length);
  const fixed = input.fixed ?? [];
  const pitches = new Map();
  const report = {
    baseId: null, k: 0, baseScale: null, segments: [], fallback: null,
    adjusted: 0, outside: 0,
  };
  if (!moving.length) return { pitches, report };

  const sample = [...moving.map((m) => m.pitch), ...fixed.map((f) => f.pitch)];
  const space = degreeSpace(preset, sample);
  const { n } = space;
  const coarseUnits = coarse * space.interval;

  /** The plain chromatic shift, as the ordinary transpose computes it. */
  const chromatic = (note) => {
    if (space.kind === "raw" || n === 0) return note + fine + coarseUnits;
    const { deg, residual } = space.locate(note);
    return space.pitch(deg + fine) + residual + coarseUnits;
  };
  const plain = (fallback) => {
    for (const m of moving) pitches.set(m.id, space.finish(chromatic(m.pitch)));
    report.fallback = fallback;
    return { pitches, report };
  };

  // ── base note and its target ──
  const first = (m) => m.occ.reduce((a, b) => (b.t < a.t ? b : a));
  const sorted = [...moving].sort((a, b) => first(a).t - first(b).t || a.pitch - b.pitch);
  const base = sorted[0];
  report.baseId = base.id;
  if (fine === 0) return plain(null); // octaves only: nothing to infer
  if (n === 0) return plain("noPitchSet");
  const target = chromatic(base.pitch) - coarseUnits;
  const bLoc = space.locate(base.pitch), tLoc = space.locate(target);
  if (space.kind === "raw" && Math.abs(tLoc.residual - bLoc.residual) > RAW_CLUSTER_TOL) {
    // A free tuning's target pitch was never heard: there is no set to move along.
    return plain("notInSet");
  }

  // ── melodic direction per note (for directional scales) ──
  const dirOf = new Map();
  const byLane = new Map();
  for (const m of moving) {
    if (!byLane.has(m.lane)) byLane.set(m.lane, []);
    byLane.get(m.lane).push(m);
  }
  for (const lane of byLane.values()) {
    lane.sort((a, b) => first(a).t - first(b).t);
    for (let i = 0; i < lane.length; i++) {
      const next = lane[i + 1], prev = lane[i - 1];
      let d = next ? Math.sign(next.pitch - lane[i].pitch) : 0;
      if (d === 0 && prev) d = Math.sign(lane[i].pitch - prev.pitch);
      dirOf.set(lane[i].id, d < 0 ? -1 : 1);
    }
  }

  // ── vocabulary, membership, positions ──
  let vocab = scaleVocabulary(space);
  if (o.scale) {
    const want = vocab.find((s) => s.family === o.scale.family && s.root === o.scale.root);
    if (want) vocab = [want];
  }
  const member = vocab.map((s) => {
    const u = new Uint8Array(n);
    for (const d of s.union) u[d] = 1;
    return u;
  });
  const listFor = (s, dir) => (dir < 0 && s.desc ? s.desc : s.asc);
  /** Absolute scale position of absolute degree `deg`, or null. */
  const positionOf = (s, deg, dir) => {
    const L = listFor(s, dir);
    for (let j = 0; j < L.length; j++) {
      const diff = deg - L[j];
      if (mod(diff, n) === 0) return (diff / n) * L.length + j;
    }
    return null;
  };
  const degreeAt = (s, pos, dir) => {
    const L = listFor(s, dir);
    const q = Math.floor(pos / L.length);
    return q * n + L[pos - q * L.length];
  };
  const baseDir = dirOf.get(base.id) ?? 1;
  const baseK = vocab.map((s) => {
    const pb = positionOf(s, bLoc.deg, baseDir), pt = positionOf(s, tLoc.deg, baseDir);
    return pb === null || pt === null ? null : pt - pb;
  });
  if (!baseK.some((k) => k !== null)) return plain("notInSet");

  // ── stage 1: evidence per window ──
  const W = Math.max(1, o.window | 0), rpb = Math.max(1, o.rowsPerBeat);
  let t0 = Infinity, t1 = -Infinity;
  for (const m of moving) {
    for (const oc of m.occ) { t0 = Math.min(t0, oc.t); t1 = Math.max(t1, oc.t + Math.max(1, oc.dur)); }
  }
  const nW = Math.max(1, Math.ceil((t1 - t0) / W));
  const winOf = (t) => Math.min(nW - 1, Math.max(0, Math.floor((t - t0) / W)));
  const hist = Array.from({ length: nW }, () => new Float64Array(n));
  const pcOf = (pitch) => mod(space.locate(pitch).deg, n);
  const addEvidence = (pitch, t, dur, beat) => {
    const end = t + Math.max(1, dur);
    if (end <= t0 || t >= t1) return;
    const pc = pcOf(pitch);
    for (let w = winOf(Math.max(t, t0)); w <= winOf(Math.min(end, t1) - 1); w++) {
      const ws = t0 + w * W, we = ws + W;
      const overlap = Math.min(end, we) - Math.max(t, ws);
      if (overlap <= 0) continue;
      const onset = t >= ws && t < we;
      hist[w][pc] += (overlap / rpb) * (onset ? (beat ?? 1) : SUSTAIN_WEIGHT);
    }
  };
  for (const m of moving) for (const oc of m.occ) addEvidence(m.pitch, oc.t, oc.dur, oc.beat);
  for (const f of fixed) addEvidence(f.pitch, f.t, f.dur, f.beat);

  const globalHist = new Float64Array(n);
  let globalWeight = 0;
  const addGlobal = (pitch, dur, beat) => {
    const w = (Math.min(Math.max(1, dur), 4 * rpb) / rpb) * (beat ?? 1);
    globalHist[pcOf(pitch)] += w;
    globalWeight += w;
  };
  if (input.global) for (const g of input.global) addGlobal(g.pitch, g.dur, g.beat);
  else {
    for (const m of moving) for (const oc of m.occ) addGlobal(m.pitch, oc.dur, oc.beat);
    for (const f of fixed) addGlobal(f.pitch, f.dur, f.beat);
  }

  const eps = o.epsilon, minRef = Math.min(7, n);
  const logLik = (si, h) => {
    const K = vocab[si].union.length;
    const lin = Math.log((1 - eps) / Math.max(K, minRef));
    const lout = K >= n ? lin : Math.log(eps / (n - K));
    const u = member[si];
    let ll = 0;
    for (let pc = 0; pc < n; pc++) if (h[pc] > 0) ll += h[pc] * (u[pc] ? lin : lout);
    return ll;
  };

  // ── stage 1: state pruning ──
  const globalScore = vocab.map((s, si) => logLik(si, globalHist) + s.prior);
  const rank = (ids) => ids.sort((a, b) => globalScore[b] - globalScore[a]).slice(0, o.maxStates);
  const all = vocab.map((_, i) => i);
  const states = [...new Set([
    ...rank([...all]),
    ...rank(all.filter((i) => baseK[i] !== null)),
  ])];
  const M = states.length;
  const baseWin = winOf(first(base).t);
  const globalNorm = globalWeight > 0 ? GLOBAL_PRIOR / globalWeight : 0;
  const globalLL = states.map((si) => logLik(si, globalHist) * globalNorm);

  // ── stage 1: Viterbi over windows ──
  const switchCost = new Float64Array(M * M);
  for (let a = 0; a < M; a++) {
    for (let b = 0; b < M; b++) {
      if (a === b) continue;
      const ua = member[states[a]], ub = member[states[b]];
      let diff = 0;
      for (let pc = 0; pc < n; pc++) if (ua[pc] !== ub[pc]) diff++;
      switchCost[a * M + b] = SWITCH_COST + SWITCH_PER_NOTE * diff - vocab[states[b]].prior;
    }
  }
  let score = new Float64Array(M);
  const back = Array.from({ length: nW }, () => new Int32Array(M));
  const emit = (w, a) => {
    if (w === baseWin) {
      if (baseK[states[a]] === null) return -Infinity;
      return logLik(states[a], hist[w]) + (globalLL[a] * BASE_GLOBAL) / GLOBAL_PRIOR;
    }
    return logLik(states[a], hist[w]) + globalLL[a];
  };
  for (let a = 0; a < M; a++) score[a] = vocab[states[a]].prior + emit(0, a);
  for (let w = 1; w < nW; w++) {
    const next = new Float64Array(M);
    for (let b = 0; b < M; b++) {
      let best = -Infinity, arg = b;
      for (let a = 0; a < M; a++) {
        const v = score[a] - switchCost[a * M + b];
        if (v > best) { best = v; arg = a; }
      }
      next[b] = best + emit(w, b);
      back[w][b] = arg;
    }
    score = next;
  }
  let last = 0;
  for (let a = 1; a < M; a++) if (score[a] > score[last]) last = a;
  const path = new Int32Array(nW);
  path[nW - 1] = last;
  for (let w = nW - 1; w > 0; w--) path[w - 1] = back[w][path[w]];
  const scaleAt = (w) => vocab[states[path[w]]];

  // ── stage 2: k ──
  const baseScale = scaleAt(baseWin);
  const k0 = baseK[states[path[baseWin]]];
  report.k = k0;
  report.baseScale = describe(baseScale);
  if (baseScale.family === "chromatic") return plain("chromatic");
  // How the base window reads WITHOUT the constraint — the passage's own key.
  let free = 0, freeBest = -Infinity;
  for (let a = 0; a < M; a++) {
    const v = vocab[states[a]].prior + logLik(states[a], hist[baseWin]) + (globalLL[a] * BASE_GLOBAL) / GLOBAL_PRIOR;
    if (v > freeBest) { freeBest = v; free = a; }
  }
  {
    const ua = member[states[free]], ub = member[states[path[baseWin]]];
    let diff = 0;
    for (let pc = 0; pc < n; pc++) if (ua[pc] !== ub[pc]) diff++;
    if (diff > MAX_KEY_DISTANCE && vocab[states[free]].family !== "chromatic") return plain("outOfKey");
  }
  const kFor = (s) => (s === baseScale ? k0 : Math.round((k0 * s.asc.length) / baseScale.asc.length));
  for (let w = 0; w < nW; w++) {
    const s = scaleAt(w);
    const seg = report.segments[report.segments.length - 1];
    if (seg && seg.key === s.key) seg.t1 = t0 + (w + 1) * W;
    else report.segments.push({ key: s.key, ...describe(s), t0: t0 + w * W, t1: t0 + (w + 1) * W });
  }
  for (const seg of report.segments) delete seg.key;

  // ── stage 3: the scalar map ──
  const info = new Map(); // id → {scale, k, dir, loc, primary, inScale}
  for (const m of moving) {
    const s = scaleAt(winOf(first(m).t));
    const k = kFor(s), dir = dirOf.get(m.id) ?? 1;
    const loc = space.locate(m.pitch);
    const pos = positionOf(s, loc.deg, dir);
    let primary, inScale = pos !== null;
    if (inScale) {
      primary = space.pitch(degreeAt(s, pos + k, dir)) + loc.residual + coarseUnits;
    } else {
      report.outside++;
      // nearest scale degree, below first on a tie
      let mDeg = null;
      for (let d = 1; d <= n && mDeg === null; d++) {
        if (positionOf(s, loc.deg - d, dir) !== null) mDeg = loc.deg - d;
        else if (positionOf(s, loc.deg + d, dir) !== null) mDeg = loc.deg + d;
      }
      const mapped = degreeAt(s, positionOf(s, mDeg, dir) + k, dir);
      switch (o.policy) {
        case "neighbour":
          primary = m.pitch + (space.pitch(mapped) - space.pitch(mDeg)) + coarseUnits; break;
        case "snap":
          primary = space.pitch(mapped) + loc.residual + coarseUnits; break;
        case "chromatic":
          primary = chromatic(m.pitch); break;
        default: // "offset": keep the distance from the scale degree, in degrees
          primary = space.pitch(mapped + (loc.deg - mDeg)) + loc.residual + coarseUnits;
      }
    }
    if (m === base) primary = target + coarseUnits; // the user's own request, exactly
    info.set(m.id, { s, k, dir, loc, primary, inScale });
  }

  // ── stage 4: clash avoidance ──
  if (o.avoidClashes && fixed.length) {
    const diss = dissonanceMetric(o.metric);
    const index = timeIndex(fixed);
    const SEMI = space.interval / (space.interval === 0x1000 ? 12 : 13);
    for (const lane of byLane.values()) {
      const cands = lane.map((m) => {
        const it = info.get(m.id);
        if (m === base) return [{ pitch: it.primary, kind: 0, cost: 0 }];
        const list = [{ pitch: it.primary, kind: 0, cost: 0 }];
        const chrom = chromatic(m.pitch);
        const chromIn = positionOf(it.s, space.locate(chrom - coarseUnits).deg, it.dir) !== null;
        list.push({ pitch: chrom, kind: 1, cost: COST_CHROMATIC + (chromIn ? 0 : COST_OUT_OF_SCALE) });
        // the scale neighbours of the scalar result
        const pDeg = space.locate(it.primary - coarseUnits).deg;
        for (const dir of [-1, 1]) {
          for (let d = 1; d <= n; d++) {
            if (positionOf(it.s, pDeg + dir * d, it.dir) !== null) {
              list.push({ pitch: space.pitch(pDeg + dir * d) + it.loc.residual + coarseUnits, kind: 2, cost: COST_NEIGHBOUR });
              break;
            }
          }
        }
        const seen = new Map();
        for (const c of list) {
          const key = Math.round(c.pitch);
          if (!seen.has(key) || seen.get(key).cost > c.cost) seen.set(key, c);
        }
        const uniq = [...seen.values()];
        for (const c of uniq) {
          for (const oc of m.occ) {
            const sounding = index.overlapping(oc.t, oc.t + Math.max(1, oc.dur));
            // Doubling a pitch class that is already sounding — a chord tone —
            // is never a clash, whatever the interval to the bass says.
            const pc = pcOf(c.pitch - coarseUnits);
            if (sounding.some((f) => pcOf(f.pitch) === pc)) continue;
            for (const f of sounding) {
              const ov = Math.min(oc.t + Math.max(1, oc.dur), f.t + Math.max(1, f.dur)) - Math.max(oc.t, f.t);
              const d = diss(c.pitch, f.pitch);
              if (d > DISSONANCE_FLOOR) {
                c.cost += DISSONANCE_WEIGHT * (oc.beat ?? 1) * (Math.min(ov, rpb) / rpb) * (d - DISSONANCE_FLOOR);
              }
            }
          }
        }
        return uniq;
      });
      // Viterbi along the lane
      let prev = cands[0].map((c) => ({ total: c.cost, from: -1 }));
      const trail = [prev];
      for (let i = 1; i < lane.length; i++) {
        const a = lane[i - 1], b = lane[i];
        const linked = first(b).t - (first(a).t + Math.max(1, first(a).dur)) <= 2 * W;
        const pa = info.get(a.id).primary, pb = info.get(b.id).primary;
        const cur = cands[i].map((cb) => {
          let best = Infinity, from = 0;
          cands[i - 1].forEach((ca, j) => {
            let tc = 0;
            if (linked) {
              if (ca.kind !== cb.kind) tc += COST_KIND_CHANGE;
              tc += COST_LEAP * Math.abs((cb.pitch - ca.pitch) - (pb - pa)) / SEMI;
            }
            const v = prev[j].total + tc;
            if (v < best) { best = v; from = j; }
          });
          return { total: best + cb.cost, from };
        });
        trail.push(cur);
        prev = cur;
      }
      let at = 0;
      prev.forEach((p, j) => { if (p.total < prev[at].total) at = j; });
      for (let i = lane.length - 1; i >= 0; i--) {
        const c = cands[i][at];
        const it = info.get(lane[i].id);
        if (Math.round(c.pitch) !== Math.round(it.primary)) report.adjusted++;
        it.primary = c.pitch;
        at = trail[i][at].from;
      }
    }
  }

  for (const m of moving) pitches.set(m.id, space.finish(info.get(m.id).primary));
  return { pitches, report };
}

/** A scale as the report names it: family, root degree index, size. */
function describe(s) {
  return { family: s.family, root: s.root, size: s.asc.length };
}

/** Bucketed interval index over notes with {t, dur}. */
function timeIndex(notes, B = 16) {
  const buckets = new Map();
  notes.forEach((f, i) => {
    const end = f.t + Math.max(1, f.dur);
    for (let b = Math.floor(f.t / B); b <= Math.floor((end - 1) / B); b++) {
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(i);
    }
  });
  const stamp = new Int32Array(notes.length).fill(-1);
  let query = 0;
  return {
    overlapping(t, end) {
      query++;
      const out = [];
      for (let b = Math.floor(t / B); b <= Math.floor((end - 1) / B); b++) {
        for (const i of buckets.get(b) ?? []) {
          if (stamp[i] === query) continue;
          stamp[i] = query;
          const f = notes[i];
          if (f.t < end && f.t + Math.max(1, f.dur) > t) out.push(f);
        }
      }
      return out;
    },
  };
}
