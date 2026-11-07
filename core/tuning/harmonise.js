// Harmonic (scalar) transposition — the "intelligent harmoniser".
//
// The user says how far ONE note — the base note, the first in the passage that
// is not a scoop into another — should move ("up 4 semitones", "up 5 steps of
// 31-TET"), and the machine works out what that means for every other note: a
// third above C is E, but a third above D in C major is F, not F♯. Four
// stages, all in the tuning's own degree space (scales.js), so 12-TET, 31-TET,
// a Pythagorean table and Bohlen–Pierce are handled by the same lines:
//
//  1. Infer the scale over time — from the MUSIC, not from the request. The
//     passage and everything sounding with it are split into windows on the
//     song's grid; each window scores every candidate scale by how well it
//     explains what is heard there (weighted by duration and metric position,
//     rising and falling notes kept apart so directional scales are judged by
//     direction), normalised so that doubling a part on twenty lanes does not
//     multiply its say. A Viterbi pass joins the windows: changing scale costs
//     something, so one passing note stays a chromatic note while a bar of E7
//     does pull the reading to A harmonic minor — chord–scale theory falling
//     out of the arithmetic. Parts that ignore the key do not get a vote: a
//     part stuck on one pitch class is set aside, and after a first pass each
//     part is weighted by how well it fits the reading. The result is reported
//     as KEYS (stretches longer than a bar) and passing DETOURS.
//  2. Find the degree shift k from the base note, in the scale its window was
//     read in. The request only breaks ties in that window (C D E G A asked to
//     go D → F♯ is G major); it never chooses a key the music does not support.
//     A request that is no step of the passage's own scale ("a semitone up"
//     over C major) is chromatic by intent, and is carried out as such. A window
//     in a scale of another size scales k by cardinality: a third stays a third.
//  3. Map every note k steps along its window's scale. Notes outside the scale
//     (passing tones, blue notes) follow a policy: keep their offset from the
//     nearest scale degree, move by the same real interval as that degree,
//     snap onto the scale, or move chromatically. Directional scales (melodic
//     minor, Rast) read a note in the form its melodic direction calls for.
//     An ornament (a scoop or bend into the next note, marked `bendTo`) keeps
//     its exact distance from the note it bends into.
//  4. Optionally avoid clashes. Each note gets a few candidates (the scalar
//     result, the chromatic one, the scale neighbours of the scalar one) and a
//     Viterbi pass per lane minimises: deviation from the scalar result,
//     dissonance against the pitch classes sounding at the same time (harmonic
//     entropy by default — consonance.js — weighted by beat strength), changes
//     of kind mid-phrase, and deviation from the parallel contour. The requested
//     interval is thus a strong prior rather than a hard rule — except for the
//     base note itself, which always lands exactly where the user asked.
//
// Pure — no DOM.

import { degreeSpace, scaleVocabulary, RAW_CLUSTER_TOL } from "./scales.js";
import { dissonanceMetric } from "./consonance.js";

export const CHROMATIC_POLICIES = Object.freeze(["offset", "neighbour", "snap", "chromatic"]);

export const HARMONISE_DEFAULTS = Object.freeze({
  /** Rows per inference window — the time grain modulations are found at.
   *  null = two beats. */
  window: null,
  /** Rows per beat, for weighting by duration and metric position. */
  rowsPerBeat: 4,
  /** Rows per bar: a stretch in one scale shorter than this is reported as a
   *  passing chord-scale detour rather than a key. null = four beats. */
  barRows: null,
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
  /** Fill report.debug with each window's path scale and best candidates. */
  debug: false,
});

// stage-1 weights. Emissions are NORMALISED per window (EMIT_SCALE times the
// mean log-likelihood per beat of evidence), so twenty doubled pad lanes do not
// out-shout the switching costs and a stray part's pull is proportional to its
// SHARE of what is heard rather than to how many lanes there are.
const EMIT_SCALE = 6;
// The weight (in beats) a window must exceed before it is normalised. Below it,
// evidence counts as heard — a passing note in a bare melody is one note, not
// half of everything — and above it, extra doubling stops adding weight.
const EMIT_REF_WEIGHT = 6;
// Entering a different scale costs enough that ONE passing note cannot open an
// excursion (a D♯ in G major is a chromatic note, not E harmonic minor), while
// a bar of E7 — several G♯s, on beats — still can.
const SWITCH_COST = 3.0;     // entering a different scale…
const SWITCH_PER_NOTE = 0.5; // …plus this per pitch class the two disagree on
// Each window spent in a scale less plausible than the diatonic family pays a
// little rent (this share of its prior). Without it, windows that cannot tell
// an excursion from the home key (no D or D♯ heard, after a B chord in G major)
// leave the choice of where to come home arbitrary; with it, home wins the tie.
const EXCURSION_RENT = 0.02; // small: it settles ties, it must not add up to a verdict
// Whole-song evidence only chooses which scales are CANDIDATES; it never scores
// a window. Applied per window it adds up into a pull toward the song's
// predominant key, which in a song that modulates is a pull AWAY from every other
// section's key — and even applied once, at the start of the path, it tips the
// opening window's tie toward the wrong section. Ties are settled by the windows
// that do discriminate, carried along the path by the switching costs.
// The requested interval is evidence about the key, not a definition of it: in
// the base note's window, scales that hold both the base note and its target get
// this bonus — enough to settle a genuine tie (C D E G A asked to go D → F♯ is
// G major) but never enough to override what the music says.
const BASE_FIT = 2.0;
const SUSTAIN_WEIGHT = 0.7;  // a note held into a window, relative to its onset
// How long after its onset a note still counts as key evidence, in beats (one
// 4/4 bar). A
// tracker note "rings" until the lane's next event, which on a sparse lane can be
// a whole pattern; its sound has long decayed by then, and letting it vote for
// that long hands one passing note a bar's worth of say. (The full length still
// counts for what it clashes with.)
const EVIDENCE_RING_BEATS = 4;
// Source reliability: after a first pass, each source (instrument) is scored by
// how much of its weight falls inside the inferred scales. A part that ignores
// the key — a pitched hi-hat sample stuck on C♯, a chromatic riser — keeps a
// small voice; a part that follows the key keeps all of it.
const RELIABLE_FIT = 0.85;
const UNRELIABLE_FIT = 0.4;
const RELIABILITY_MIN_WEIGHT = 2; // beats of evidence before a source is judged
// A part that sounds ONE pitch class, over and over, says nothing about the key:
// a hi-hat sample tuned to C♯ that plays straight through a modulation, a drone.
// Left in, it drags the reading toward whatever scale happens to contain it (and
// then looks reliable BECAUSE it is contained). So it is taken out of both the
// key evidence and the clash judgement.
const MONOTONE_MIN_NOTES = 8;
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
 *   moving  the notes to transpose: [{id, pitch, lane, src?, bendTo?,
 *           occ: [{t, dur, beat, w?}]}]
 *           — `occ` lists every time the note sounds (a pattern placed twice
 *           sounds twice; it can still only be written one way), `t` and
 *           `dur` in rows, `beat` a metric weight (1 weak … 1.5 downbeat);
 *   fixed   notes that stay where they are: [{pitch, t, dur, beat, w?, src?}]
 *           — the accompaniment, used as evidence and as what clashes are
 *           judged against;
 *   `src` names the part a note comes from (the walker passes the instrument),
 *   so a part that ignores the key can be down-weighted as a whole; `w` scales
 *   a note's evidence (an ornament counts for little); `bendTo` is the id of
 *   the note an ornament bends into, whose transposition it then follows;
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
    baseId: null, k: 0, baseScale: null, segments: [], keys: [], detours: 0,
    fallback: null, adjusted: 0, outside: 0,
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
  // An ornament (the start of a bend into the next note, `bendTo`) is not what
  // the user means by "the first note": the note it bends into is.
  const first = (m) => m.occ.reduce((a, b) => (b.t < a.t ? b : a));
  const byId = new Map(moving.map((m) => [m.id, m]));
  const isOrnament = (m) => m.bendTo != null && byId.has(m.bendTo);
  const sorted = [...moving].sort((a, b) => first(a).t - first(b).t || a.pitch - b.pitch);
  const base = sorted.find((m) => !isOrnament(m)) ?? sorted[0];
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
  const eps = o.epsilon, minRef = Math.min(7, n);
  // Log-probabilities per pitch class AND per melodic direction — evidence is
  // banded: index pc (direction unknown), n + pc (heard rising), 2n + pc
  // (falling). A directional scale is heard in its ascending form on the way up
  // and its descending form on the way down: a G♯ rising is melodic minor's own
  // note, a G♯ falling contradicts it. Where the direction is unknown each form
  // is half the story, so a degree only one form has counts half — rather than
  // the nine-note union passing for a seven-note scale and soaking up every
  // stray accidental. A scale with one form reads the same in all three bands.
  const logP = vocab.map((s, si) => {
    const lp = new Float64Array(3 * n);
    const card = Math.max(s.asc.length, minRef);
    const outs = n - s.union.length;
    const lout = outs > 0 ? Math.log(eps / outs) : Math.log(eps / n);
    const inAsc = new Uint8Array(n), inDesc = new Uint8Array(n);
    for (const d of s.asc) inAsc[mod(d, n)] = 1;
    for (const d of (s.desc ?? s.asc)) inDesc[mod(d, n)] = 1;
    const mass = outs > 0 ? 1 - eps : 1;
    const at = (share) => (share > 0 ? Math.log((mass * share) / card) : lout);
    for (let pc = 0; pc < n; pc++) {
      lp[pc] = at((inAsc[pc] + inDesc[pc]) / 2);
      lp[n + pc] = at(inAsc[pc]);
      lp[2 * n + pc] = at(inDesc[pc]);
    }
    return lp;
  });
  const BANDS = 3 * n;
  const band = (pc, dir) => pc + n * (dir > 0 ? 1 : dir < 0 ? 2 : 0);
  const logLik = (si, h) => {
    const lp = logP[si];
    let ll = 0;
    for (let i = 0; i < BANDS; i++) if (h[i] > 0) ll += h[i] * lp[i];
    return ll;
  };
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

  // ── fixed-pitch parts (see MONOTONE_MIN_NOTES) ──
  const deaf = new Set();
  {
    const notes = new Map(), pcs = new Map();
    const see = (src, pitch, count) => {
      if (src == null) return;
      notes.set(src, (notes.get(src) ?? 0) + count);
      if (!pcs.has(src)) pcs.set(src, new Set());
      pcs.get(src).add(mod(space.locate(pitch).deg, n));
    };
    for (const m of moving) see(m.src, m.pitch, m.occ.length);
    for (const f of fixed) see(f.src, f.pitch, 1);
    for (const g of input.global ?? []) see(g.src, g.pitch, 1);
    for (const [src, count] of notes) {
      if (count >= MONOTONE_MIN_NOTES && pcs.get(src).size === 1) deaf.add(src);
    }
  }
  const heardFixed = deaf.size ? fixed.filter((f) => !deaf.has(f.src)) : fixed;
  report.fixedPitchParts = [...deaf];

  // ── stage 1: evidence ──
  // Each heard note becomes entries {w (window), pc, wt, src}; the histograms
  // are rebuilt from them with each source's reliability as a multiplier.
  const rpb = Math.max(1, o.rowsPerBeat | 0);
  const W = Math.max(1, (o.window ?? 2 * rpb) | 0);
  let t0 = Infinity, t1 = -Infinity;
  for (const m of moving) {
    for (const oc of m.occ) { t0 = Math.min(t0, oc.t); t1 = Math.max(t1, oc.t + Math.max(1, oc.dur)); }
  }
  // Windows sit on the song's own grid (row multiples of W), not wherever the
  // selection happens to start: the same bar must be read the same way whichever
  // lanes are selected.
  t0 = Math.floor(t0 / W) * W;
  const nW = Math.max(1, Math.ceil((t1 - t0) / W));
  const winOf = (t) => Math.min(nW - 1, Math.max(0, Math.floor((t - t0) / W)));
  const pcOf = (pitch) => mod(space.locate(pitch).deg, n);
  const heard = [], global = [];
  const addEvidence = (pitch, t, dur, beat, wt, src, dir = 0) => {
    const end = t + Math.max(1, Math.min(dur, EVIDENCE_RING_BEATS * rpb));
    if (end <= t0 || t >= t1) return;
    const pc = pcOf(pitch);
    for (let w = winOf(Math.max(t, t0)); w <= winOf(Math.min(end, t1) - 1); w++) {
      const ws = t0 + w * W, we = ws + W;
      const overlap = Math.min(end, we) - Math.max(t, ws);
      if (overlap <= 0) continue;
      const onset = t >= ws && t < we;
      heard.push({ w, pc, b: band(pc, dir), src, wt: (wt ?? 1) * (overlap / rpb) * (onset ? (beat ?? 1) : SUSTAIN_WEIGHT) });
    }
  };
  const addGlobal = (pitch, dur, beat, wt, src, dir = 0) => {
    const pc = pcOf(pitch);
    global.push({ pc, b: band(pc, dir), src, wt: (wt ?? 1) * (Math.min(Math.max(1, dur), 4 * rpb) / rpb) * (beat ?? 1) });
  };
  for (const m of moving) {
    if (deaf.has(m.src)) continue;
    for (const oc of m.occ) {
      const dir = m.dir ?? dirOf.get(m.id) ?? 0;
      addEvidence(m.pitch, oc.t, oc.dur, oc.beat, oc.w, m.src, dir);
      if (!input.global) addGlobal(m.pitch, oc.dur, oc.beat, oc.w, m.src, dir);
    }
  }
  for (const f of heardFixed) {
    addEvidence(f.pitch, f.t, f.dur, f.beat, f.w, f.src, f.dir);
    if (!input.global) addGlobal(f.pitch, f.dur, f.beat, f.w, f.src, f.dir);
  }
  if (input.global) {
    for (const g of input.global) if (!deaf.has(g.src)) addGlobal(g.pitch, g.dur, g.beat, g.w, g.src, g.dir);
  }

  const reliability = new Map(); // src → multiplier; absent = 1
  const relOf = (src) => (src == null ? 1 : reliability.get(src) ?? 1);
  let hist, winWeight, globalHist, globalWeight;
  const buildHistograms = () => {
    hist = Array.from({ length: nW }, () => new Float64Array(BANDS));
    winWeight = new Float64Array(nW);
    for (const e of heard) {
      const v = e.wt * relOf(e.src);
      hist[e.w][e.b] += v;
      winWeight[e.w] += v;
    }
    globalHist = new Float64Array(BANDS);
    globalWeight = 0;
    for (const e of global) {
      const v = e.wt * relOf(e.src);
      globalHist[e.b] += v;
      globalWeight += v;
    }
  };

  // ── stage 1: state pruning ──
  // The candidates are the whole song's best readings, the best readings that
  // hold the request, AND the best few of every window: a song whose second
  // half is longer than its first must not lose the first half's key just
  // because it never wins on the song-wide count.
  buildHistograms();
  const globalScore = vocab.map((s, si) => logLik(si, globalHist) + s.prior);
  const rank = (ids, score, k) => ids.sort((a, b) => score[b] - score[a]).slice(0, k);
  const all = vocab.map((_, i) => i);
  const votes = new Map();
  {
    const per = Math.max(2, Math.ceil(o.maxStates / 8));
    const score = new Float64Array(vocab.length);
    for (let w = 0; w < nW; w++) {
      if (winWeight[w] <= 0) continue;
      const pcs = [];
      const byPc = new Float64Array(n);
      for (let i = 0; i < BANDS; i++) if (hist[w][i] > 0) { pcs.push(i); byPc[i % n] += hist[w][i]; }
      // A window's best readings contain what it hears most; scoring only those
      // keeps a 96-TET vocabulary of thousands of scales cheap.
      let top = 0;
      for (let pc = 1; pc < n; pc++) if (byPc[pc] > byPc[top]) top = pc;
      score.fill(-Infinity);
      for (let si = 0; si < vocab.length; si++) {
        if (!member[si][top]) continue;
        const lp = logP[si];
        let ll = 0;
        for (const pc of pcs) ll += hist[w][pc] * lp[pc];
        score[si] = (EMIT_SCALE * ll) / Math.max(winWeight[w], EMIT_REF_WEIGHT) + vocab[si].prior;
      }
      for (const si of rank([...all], score, per)) votes.set(si, (votes.get(si) ?? 0) + 1);
    }
  }
  const local = [...votes.keys()].sort((a, b) => votes.get(b) - votes.get(a)).slice(0, 3 * o.maxStates);
  const states = [...new Set([
    ...rank([...all], globalScore, o.maxStates),
    ...rank(all.filter((i) => baseK[i] !== null), globalScore, o.maxStates),
    ...local,
  ])];
  const M = states.length;
  const baseWin = winOf(first(base).t);

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
  const viterbi = () => {
    const emit = (w, a) => {
      let e = (EMIT_SCALE * logLik(states[a], hist[w])) / Math.max(winWeight[w], EMIT_REF_WEIGHT)
        + EXCURSION_RENT * vocab[states[a]].prior;
      if (w === baseWin && baseK[states[a]] !== null) e += BASE_FIT;
      return e;
    };
    let score = new Float64Array(M);
    const back = Array.from({ length: nW }, () => new Int32Array(M));
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
    const out = new Int32Array(nW);
    out[nW - 1] = last;
    for (let w = nW - 1; w > 0; w--) out[w - 1] = back[w][out[w]];
    return out;
  };
  let path = viterbi();
  const debugWindows = () => {
    if (!o.debug) return;
    report.debug = [];
    for (let w = 0; w < nW; w++) {
      const row = states.map((si, a) => ({
        scale: `${vocab[si].family}@${vocab[si].root}`,
        emit: +((EMIT_SCALE * logLik(si, hist[w])) / Math.max(winWeight[w], EMIT_REF_WEIGHT)).toFixed(2),
        chosen: path[w] === a,
      })).sort((x, y) => y.emit - x.emit).slice(0, 4);
      report.debug.push({ t: t0 + w * W, weight: +winWeight[w].toFixed(2), path: `${vocab[states[path[w]]].family}@${vocab[states[path[w]]].root}`, top: row });
    }
  };

  // ── stage 1: reliability, then the final pass ──
  {
    const inW = new Map(), totW = new Map();
    for (const e of heard) {
      if (e.src == null) continue;
      totW.set(e.src, (totW.get(e.src) ?? 0) + e.wt);
      if (member[states[path[e.w]]][e.pc]) inW.set(e.src, (inW.get(e.src) ?? 0) + e.wt);
    }
    if (totW.size > 1) {
      for (const [src, tot] of totW) {
        if (tot < RELIABILITY_MIN_WEIGHT) continue;
        const fit = (inW.get(src) ?? 0) / tot;
        if (fit >= RELIABLE_FIT) continue;
        const x = Math.max(0, (fit - UNRELIABLE_FIT) / (RELIABLE_FIT - UNRELIABLE_FIT));
        reliability.set(src, Math.max(0.05, x * x));
      }
      if (reliability.size) {
        buildHistograms();
        path = viterbi();
      }
    }
  }
  report.unreliable = [...reliability.keys()];
  debugWindows();
  const scaleAt = (w) => vocab[states[path[w]]];

  // ── stage 2: k ──
  const baseScale = scaleAt(baseWin);
  const k0 = baseK[states[path[baseWin]]];
  report.k = k0 ?? 0;
  report.baseScale = describe(baseScale);
  for (let w = 0; w < nW; w++) {
    const s = scaleAt(w);
    const seg = report.segments[report.segments.length - 1];
    if (seg && seg.key === s.key) seg.t1 = t0 + (w + 1) * W;
    else report.segments.push({ key: s.key, ...describe(s), t0: t0 + w * W, t1: t0 + (w + 1) * W });
  }
  for (const seg of report.segments) delete seg.key;
  // Keys vs detours: what the passage is IN, and the brief chord-scale moments
  // (a secondary dominant's leading note) it passes through on the way.
  {
    const bar = Math.max(1, (o.barRows ?? 4 * rpb) | 0);
    const same = (a, b) => a.family === b.family && a.root === b.root;
    for (const seg of report.segments) {
      if (seg.t1 - seg.t0 <= bar) { report.detours++; continue; } // a bar's tonicisation is a detour
      const prev = report.keys[report.keys.length - 1];
      if (prev && same(prev, seg)) prev.t1 = seg.t1;
      else report.keys.push({ ...seg });
    }
    if (!report.keys.length) {
      report.keys.push({ ...report.segments.reduce((a, b) => (b.t1 - b.t0 > a.t1 - a.t0 ? b : a)) });
      report.detours = report.segments.length - 1;
    }
  }
  if (baseScale.family === "chromatic") return plain("chromatic");
  // The key is the music's; if it cannot hold the request ("a semitone up" over
  // C major), the request is chromatic by intent and is carried out as such.
  if (k0 === null) return plain("outOfKey");
  const kFor = (s) => (s === baseScale ? k0 : Math.round((k0 * s.asc.length) / baseScale.asc.length));

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

  // An ornament keeps its exact distance from the note it bends into: a
  // semitone scoop up to the root stays a semitone scoop up to the new root,
  // whatever scale degree the scoop's own pitch happens to land on. Chains (a
  // glide through several targets) resolve from their last note backwards.
  const resolveBends = () => {
    const done = new Set();
    const resolve = (m, depth = 0) => {
      if (!isOrnament(m) || done.has(m.id) || m === base || depth > moving.length) return;
      const anchor = byId.get(m.bendTo);
      resolve(anchor, depth + 1);
      const it = info.get(m.id), at = info.get(anchor.id);
      const anchorNow = space.locate(at.primary - coarseUnits).deg;
      it.primary = space.pitch(anchorNow + (it.loc.deg - at.loc.deg)) + it.loc.residual + coarseUnits;
      done.add(m.id);
    };
    for (const m of moving) resolve(m);
  };
  resolveBends();

  // ── stage 4: clash avoidance ──
  if (o.avoidClashes && heardFixed.length) {
    const diss = dissonanceMetric(o.metric);
    const index = timeIndex(heardFixed);
    const SEMI = space.interval / (space.interval === 0x1000 ? 12 : 13);
    for (const lane of byLane.values()) {
      const cands = lane.map((m) => {
        const it = info.get(m.id);
        // The base note is the user's; an ornament follows its anchor afterwards.
        if (m === base || isOrnament(m)) return [{ pitch: it.primary, kind: 0, cost: 0 }];
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
            const end = oc.t + Math.max(1, oc.dur);
            // What is sounding, one entry per PITCH CLASS — a chord doubled on
            // twenty pad lanes is still one chord, and must not clash twenty
            // times. Each class is judged at its lowest voice (the bass is where
            // a minor ninth hurts) and its longest overlap. Ornaments (scoops
            // into another note) are too brief to clash with.
            const byPc = new Map();
            for (const f of index.overlapping(oc.t, end)) {
              if ((f.w ?? 1) < 1) continue;
              const ov = Math.min(end, f.t + Math.max(1, f.dur)) - Math.max(oc.t, f.t);
              const fpc = pcOf(f.pitch);
              const had = byPc.get(fpc);
              if (!had) byPc.set(fpc, { pitch: f.pitch, ov });
              else { had.pitch = Math.min(had.pitch, f.pitch); had.ov = Math.max(had.ov, ov); }
            }
            // Doubling a pitch class that is already sounding — a chord tone —
            // is never a clash, whatever the interval to the bass says.
            if (byPc.has(pcOf(c.pitch - coarseUnits))) continue;
            for (const { pitch: fp, ov } of byPc.values()) {
              const d = diss(c.pitch, fp);
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

  resolveBends();
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
