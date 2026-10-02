// Automatic loop-region resolver (item 176) — given a pooled sample's bytes and
// the loop MODE the instrument is set to, find the region that plays with the
// least audible seam, as long as the material allows one. Pure: it returns
// NUMBERS (loop start/end plus the quality it measured) and never touches
// audio, so the caller writes them through setInstBytesOp like any other marker
// edit and the whole search is one undo step. Node-tested; no DOM, no engine.
//
// WHAT THE CLICK IS, per mode — read off the engine's own loop arithmetic in
// core/engine/sampler.js `advanceSamplePos`, not from tracker folklore:
//
//   FORWARD (mode 1) wraps with `samplePos -= loopLen`, so the wrap maps e → s
//   exactly: the ear has just heard x[e-1] and expects x[e], x[e+1]…, and gets
//   x[s], x[s+1]… The click is the mismatch between the two forward windows —
//   a PAIR cost over (start, length), and the reason this half of the problem
//   needs a search at all. Restricting lengths to whole pitch periods is what
//   makes that search finish in milliseconds instead of minutes.
//
//   PING-PONG (mode 2) clamps to loopEnd and flips, and clamps to loopStart and
//   flips: both ends are a true REFLECTION. The value is therefore continuous
//   by construction and the discontinuity is in the first derivative — a corner
//   — whose size depends on ONE endpoint alone. So ping-pong's two ends are
//   independent, the whole scan is O(n), and "maximise the region" collapses to
//   "the earliest and the latest point inside the click budget". It also means
//   the right place for a ping-pong end is a PEAK or a TROUGH (where the wave
//   is locally even about the point), never the zero crossing a forward loop
//   wants — the two modes pull in opposite directions, which is precisely why
//   the mode has to be an input to the search.
//
// The cost is always a residual RATIO — seam RMS over the local signal RMS —
// not an absolute one. A click is heard against the sound carrying it, and the
// same 4-LSB step is inaudible under a loud sustain and obvious under a decayed
// tail. -20 dB (0.1) is roughly where it stops being a tick and becomes texture.
//
// WHAT IT CANNOT DO: on material that evolves (any real single note — decay,
// vibrato, a filter opening) a LONG loop has no click-free seam at all, whatever
// search runs. Length and cleanliness genuinely trade against each other, so
// the resolver reports the whole trade-off (`front`, `widest`) and the caller
// picks a policy on it. Buying a long loop that the material will not give
// needs the audio CROSSFADED, which is the Sample Lab's job — this module only
// ever moves markers.

/** Search policies, loosest budget last. The budget is the seam residual ratio
 *  the result must stay under; a looser budget can only ever return a region at
 *  least as long, so the three read as one "how much tick will you take" dial. */
export const LOOP_POLICIES = ["clean", "balanced", "longest"];
export const LOOP_BUDGET = { clean: 0.03, balanced: 0.10, longest: 0.30 };

const HOP = 256;          // envelope hop for the attack/tail bounds
const DECIM = 4;          // coarse-pass decimation for the forward search
const MAX_LENGTHS = 384;  // candidate loop lengths per search
const REFINE = 8;         // full-rate refinement radius, in samples

/** dB view of a residual ratio, for readouts. */
export function residualDb(rel) {
  return rel > 0 ? 20 * Math.log10(rel) : -Infinity;
}

// ── signal preparation ─────────────────────────────────────────────────────

/** U8 pool bytes (centre 0x80) → DC-removed Float64Array in LSB units. */
export function toSignal(bytes, a = 0, b = bytes.length) {
  const n = Math.max(0, b - a);
  const x = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { x[i] = bytes[a + i] - 128; mean += x[i]; }
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) x[i] -= mean;
  return x;
}

/** Box-decimated copy, for the coarse pass. Decimation also blurs the phase
 *  detail the coarse ranking must NOT depend on — the refine pass owns that. */
function decimate(x, d) {
  const n = Math.floor(x.length / d);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < d; k++) acc += x[i * d + k];
    out[i] = acc / d;
  }
  return out;
}

/** Per-hop RMS envelope. */
function envelope(x, hop = HOP) {
  const n = Math.floor(x.length / hop);
  const e = new Float64Array(Math.max(1, n));
  for (let f = 0; f < n; f++) {
    let acc = 0;
    for (let i = f * hop; i < f * hop + hop; i++) acc += x[i] * x[i];
    e[f] = Math.sqrt(acc / hop);
  }
  return e;
}

/**
 * The stretch of the sample a loop may sit in: after the attack (a loop that
 * includes the attack re-strikes the note on every wrap, which is not a click
 * but is never what was wanted) and before the sample has decayed into its own
 * quantisation noise (where every seam measures clean because there is nothing
 * left to be discontinuous). Falls back to the whole span whenever those two
 * rules leave too little to search — a one-cycle wavetable has no attack and no
 * decay, and must not be excluded by heuristics written for a struck note.
 */
export function usableRange(x, playStart = 0, minSpan = 64) {
  const n = x.length;
  const env = envelope(x, HOP);
  let peakF = 0;
  for (let f = 0; f < env.length; f++) if (env[f] > env[peakF]) peakF = f;
  const peak = env[peakF];
  // The attack ends at the first hop that has REACHED full level and stopped
  // climbing — not at the loudest hop. On a struck note the two are the same
  // thing; on a sample that holds one level throughout (a wavetable, a synth
  // pad) the loudest hop is decided by a rounding error somewhere in the
  // middle, and skipping to it would throw away half the sample for nothing.
  let attackF = 0;
  while (attackF < env.length - 1 && env[attackF] < 0.95 * peak) attackF++;
  while (attackF < env.length - 1 && env[attackF + 1] > env[attackF]) attackF++;
  let lo = Math.max(playStart, Math.min(n - 1, (attackF + 1) * HOP));
  let hiF = env.length - 1;
  while (hiF > attackF && env[hiF] < 0.10 * peak) hiF--;
  // A loop that ends AT the end of the sample is the commonest shape there is,
  // so the last, partial hop has to be inside the range — rounding down to a
  // hop boundary here forbids exactly the loop most samples were cut for.
  let hi = hiF >= env.length - 1 ? n : Math.min(n, (hiF + 1) * HOP);
  if (hi - lo < minSpan * 2) { lo = Math.max(0, playStart); hi = n; }
  return { lo, hi, peakRms: peak };
}

// ── pitch period ───────────────────────────────────────────────────────────

/**
 * Fractional pitch period over [a, b), by normalised autocorrelation: coarse on
 * a decimated copy, refined at full rate, then parabolic on the peak. FRACTIONAL
 * matters more than it looks — an integer period drifts a sample per cycle, so
 * by the hundredth multiple the candidate length misses the true optimum by
 * tens of samples and every long loop in the front scores as garbage.
 * Returns { period, r }; r is the correlation at the peak — below ~0.3 the
 * material has no usable pitch and the caller must not build a length grid on it.
 */
export function estimatePeriod(x, a, b, { pmin = 8, pmax = 4000, window = 12288 } = {}) {
  const span = Math.min(b - a, window);
  if (span < pmin * 4) return { period: 0, r: 0 };
  const lim = Math.min(pmax, Math.floor(span / 3));
  if (lim <= pmin) return { period: 0, r: 0 };

  const xd = decimate(x.subarray(a, a + span), DECIM);
  const dmin = Math.max(2, Math.floor(pmin / DECIM));
  const dmax = Math.floor(lim / DECIM);
  const rd = new Float64Array(dmax + 1);
  let bestR = -2;
  for (let p = dmin; p <= dmax; p++) {
    let num = 0, e0 = 0, e1 = 0;
    for (let i = 0; i + p < xd.length; i++) {
      num += xd[i] * xd[i + p]; e0 += xd[i] * xd[i]; e1 += xd[i + p] * xd[i + p];
    }
    rd[p] = num / (Math.sqrt(e0 * e1) + 1e-12);
    if (rd[p] > bestR) bestR = rd[p];
  }
  // THE OCTAVE TRAP: a periodic wave correlates just as well with itself two or
  // three periods away, and floating-point noise decides which of those ties
  // wins an argmax — a pure sine came back as 3× its period. Take the SMALLEST
  // lag that is a local peak and within a hair of the best instead, which is
  // what the period actually is. It matters beyond the readout: the candidate
  // length grid, the minimum loop length and the seam window are all built on it.
  const thresh = Math.max(bestR - 0.02, bestR * 0.92);
  let bestD = dmin;
  for (let p = dmin; p <= dmax; p++) {
    const up = p === dmin || rd[p] >= rd[p - 1];
    const down = p === dmax || rd[p] >= rd[p + 1];
    if (rd[p] >= thresh && up && down) { bestD = p; break; }
  }

  // Full-rate pass over the coarse winner AND its halves and thirds. The
  // subharmonics have to be re-examined here rather than trusted from the
  // coarse pass: a true period of 162.02 is 40.5 decimated samples, which no
  // integer lag can hold, so its correlation collapses while 324 (81.0, exact)
  // survives — decimation systematically favours the octave below.
  const nccAt = (p) => {
    let num = 0, e0 = 0, e1 = 0;
    for (let i = a; i + p < a + span; i++) {
      num += x[i] * x[i + p]; e0 += x[i] * x[i]; e1 += x[i + p] * x[i + p];
    }
    return num / (Math.sqrt(e0 * e1) + 1e-12);
  };
  const rr = new Map();
  for (const div of [1, 2, 3]) {
    const c = Math.round((bestD * DECIM) / div);
    for (let p = c - DECIM - 1; p <= c + DECIM + 1; p++) {
      if (p >= pmin && p <= lim && !rr.has(p)) rr.set(p, nccAt(p));
    }
  }
  const lags = [...rr.keys()].sort((u, v) => u - v);
  let peak = -2;
  for (const p of lags) peak = Math.max(peak, rr.get(p));
  const keep = Math.max(peak - 0.02, peak * 0.92);
  let best = lags[0];
  for (const p of lags) {
    const up = !rr.has(p - 1) || rr.get(p) >= rr.get(p - 1);
    const down = !rr.has(p + 1) || rr.get(p) >= rr.get(p + 1);
    if (rr.get(p) >= keep && up && down) { best = p; break; }
  }
  let period = best;
  if (rr.has(best - 1) && rr.has(best + 1)) {
    const y0 = rr.get(best - 1), y1 = rr.get(best), y2 = rr.get(best + 1);
    const den = y0 - 2 * y1 + y2;
    if (den !== 0) period = best + 0.5 * (y0 - y2) / den;
  }
  return { period, r: rr.get(best) };
}

// ── seam costs ─────────────────────────────────────────────────────────────

/**
 * Forward seam residual ratio for one (s, e) pair over an L-sample window: what
 * the wrap delivers (x[s+k]) against what the ear expected (x[e+k]), over the
 * level of the material carrying it. Exported for tests and readouts.
 */
export function seamResidual(x, s, e, L) {
  const n = x.length, h = Math.max(1, L >> 1);
  let ssd = 0, lvl = 0, cnt = 0;
  // The window STRADDLES the join. Strictly only the forward half is what the
  // wrap delivers wrongly, but half the loops ever written end at the last byte
  // of the sample, where there is no forward material to compare against at
  // all: the backward half — "the run-up to s is the run-up to e" — says the
  // same thing about a stationary tone and is available exactly when the other
  // is not. Taps that fall outside the sample are dropped, not zero-filled;
  // zeros would invent a discontinuity that is not in the audio.
  for (let k = -h; k < h; k++) {
    const i = s + k, j = e + k;
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const d = x[i] - x[j];
    ssd += d * d;
    lvl += 0.5 * (x[i] * x[i] + x[j] * x[j]);
    cnt++;
  }
  if (cnt < h || lvl <= 0) return Infinity;   // too little overlap to judge
  return Math.sqrt(ssd / lvl);
}

/**
 * Ping-pong corner residual at ONE point: the odd-symmetric energy about p,
 * which is exactly what the reflection injects and nothing else. The window is
 * SHORT on purpose (a fraction of a millisecond) — past the corner itself the
 * mirrored material is a timbre change, not a click, and scoring it would rule
 * out every asymmetric waveform for a fault nobody hears.
 */
export function cornerResidual(x, p, L) {
  const n = x.length;
  let ssd = 0, lvl = 0, cnt = 0;
  for (let k = 1; k <= L; k++) {
    const i = p - k, j = p + k;
    if (i < 0 || j >= n) break;
    const d = x[j] - x[i];
    ssd += d * d;
    lvl += 0.5 * (x[i] * x[i] + x[j] * x[j]);
    cnt++;
  }
  if (!cnt || lvl <= 0) return Infinity;
  return Math.sqrt(ssd / lvl);
}

/**
 * Best start for one loop LENGTH, over [sLo, sHi]: the same residual as
 * seamResidual, but the three sums slide, so every extra start costs four
 * multiplies instead of a whole window. This is what lets the coarse pass try
 * a few hundred lengths against tens of thousands of starts.
 * `floor2` is the energy-per-sample below which a window is treated as silence
 * — without it the decayed tail wins every comparison by having nothing in it.
 */
function scanLag(x, sLo, sHi, d, L, floor2, sums) {
  const n = x.length, h = Math.max(1, L >> 1);
  const m = n - d;                       // last i whose partner i+d exists is m-1
  sLo = Math.max(0, sLo);
  sHi = Math.min(sHi, m);                // e = s + d may reach n: the wrap never reads x[n]
  if (sHi < sLo || d <= 0 || m <= 1) return null;

  // Prefix of the squared difference at this lag, so a window of any width and
  // any clamping costs two lookups. Built over the STRETCH THIS CALL LOOKS AT
  // and no further: the refinement asks about seventeen starts at a time, and a
  // prefix over the whole sample for each of them is the difference between
  // milliseconds and most of a second.
  const { g, p } = sums;
  const iLo = Math.max(0, sLo - h), iHi = Math.min(m, sHi + h);
  g[0] = 0;
  for (let i = iLo; i < iHi; i++) {
    const df = x[i] - x[i + d];
    g[i - iLo + 1] = g[i - iLo] + df * df;
  }

  let best = -1, bestRel = Infinity;
  for (let s = sLo; s <= sHi; s++) {
    const a = Math.max(iLo, s - h), b = Math.min(iHi, s + h);
    const taps = b - a;
    if (taps < h) continue;              // too near an edge to judge the seam
    const lvl = 0.5 * ((p[b] - p[a]) + (p[b + d] - p[a + d]));
    if (lvl < floor2 * taps) continue;   // silence matches silence; not a loop
    const rel = Math.sqrt((g[b - iLo] - g[a - iLo]) / lvl);
    if (rel < bestRel) { bestRel = rel; best = s; }
  }
  return best < 0 ? null : { s: best, rel: bestRel };
}

/** Prefix of x², shared by every lag scan over the same signal. */
function makeSums(x) {
  const p = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i] * x[i];
  return { p, g: new Float64Array(x.length + 1) };
}

/** Candidate loop lengths: whole pitch periods where the sample HAS a pitch,
 *  a geometric ladder where it does not (an unpitched wash has no preferred
 *  length, so sample it evenly in ratio — the ear hears loop length in octaves).
 *  Strided to a fixed cap so a 4 kHz squeak does not enumerate 7000 candidates. */
function candidateLengths(period, r, minLen, maxLen) {
  const out = [];
  if (maxLen < minLen) return out;
  const pitched = period >= 8 && r >= 0.3;
  if (pitched) {
    const k0 = Math.max(1, Math.ceil(minLen / period));
    const k1 = Math.floor(maxLen / period);
    const stride = Math.max(1, Math.ceil((k1 - k0 + 1) / MAX_LENGTHS));
    for (let k = k0; k <= k1; k += stride) out.push(Math.round(k * period));
    const last = Math.round(k1 * period);
    if (k1 >= k0 && out[out.length - 1] !== last) out.push(last);
  }
  // The ladder rides along unless the pitch is unambiguous. A middling
  // correlation (a pad, a choir, anything with two things going on) still
  // produces a period, and a grid built on it samples lengths that mean nothing
  // — equal RATIOS at least cover the range evenly, and the seam cost, not the
  // grid, decides which candidate wins.
  if (!pitched || r < 0.9) {
    const steps = 96;
    const ratio = maxLen / Math.max(1, minLen);
    for (let i = 0; i <= steps; i++) out.push(Math.round(minLen * Math.pow(ratio, i / steps)));
  }
  const seen = new Set();
  return out
    .filter((d) => d >= minLen && d <= maxLen && !seen.has(d) && seen.add(d))
    .sort((u, v) => u - v);
}

/**
 * The forward-mode trade-off curve: for each candidate length, the best start
 * and what its seam costs — then thinned to the PARETO FRONT, longest first,
 * each entry strictly cleaner than every longer one. This is the honest output
 * of the search: on evolving material there is no single answer, only a curve,
 * and the policy picks a point on it.
 */
export function forwardFront(x, lo, hi, { period, r, minLen, window, floor2 }) {
  // The seam window no longer has to FIT after the loop end (it straddles the
  // join and clamps), so a candidate may run right up to the usable end.
  const lengths = candidateLengths(period, r, minLen, hi - lo);
  if (!lengths.length) return [];
  const xd = decimate(x, DECIM);
  const loD = Math.floor(lo / DECIM), hiD = Math.floor(hi / DECIM);
  const winD = Math.max(4, Math.round(window / DECIM));
  // Box-decimation drops whatever the top two octaves carried, so a decimated
  // window sits below its full-rate level: hold the silence floor down to match
  // or the coarse pass rejects quiet-but-real material before the refine sees it.
  const floorD = floor2 * 0.25;
  const sumsD = makeSums(xd), sums = makeSums(x);

  const scored = [];
  for (const d of lengths) {
    const dD = Math.max(1, Math.round(d / DECIM));
    const coarse = scanLag(xd, loD, hiD - dD, dD, winD, floorD, sumsD);
    if (!coarse) continue;
    // Full-rate refinement around the coarse pick: the decimation quantised BOTH
    // the start and the length, and a loop that is four samples out of phase is
    // a loop that clicks.
    let best = null;
    const s0 = coarse.s * DECIM;
    for (let dd = d - REFINE; dd <= d + REFINE; dd++) {
      if (dd < minLen) continue;
      const q = scanLag(x, Math.max(lo, s0 - REFINE), Math.min(hi - dd, s0 + REFINE),
        dd, window, floor2, sums);
      if (q && (!best || q.rel < best.rel)) best = { s: q.s, e: q.s + dd, len: dd, rel: q.rel };
    }
    if (best && best.e <= hi) scored.push(best);
  }
  scored.sort((a, b) => b.len - a.len);
  const front = [];
  let bestSoFar = Infinity;
  for (const q of scored) if (q.rel < bestSoFar) { front.push(q); bestSoFar = q.rel; }
  return front;
}

// ── the resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a loop region for `bytes` (a pool span, U8 centred on 0x80).
 *
 *   mode      1 = forward, 2 = ping-pong (the record's loopMode bits 0-1).
 *             Modes 0 and 3 do not loop and are rejected.
 *   policy    one of LOOP_POLICIES — the click budget, nothing else.
 *   playStart the loop may not start before it.
 *
 * Returns null when there is nothing to search (too short, silent, wrong mode),
 * otherwise { loopStart, loopEnd, rel, db, ... }. `metBudget: false` means the
 * search returned its CLEANEST answer because nothing met the budget — the
 * caller should say so rather than pretend the number is good.
 */
export function resolveLoopRegion(bytes, {
  mode = 1, policy = "balanced", playStart = 0, rate = 32000, minLenMs = 5,
} = {}) {
  const n = bytes ? bytes.length : 0;
  if (n < 128 || (mode !== 1 && mode !== 2)) return null;
  const budget = LOOP_BUDGET[policy] ?? LOOP_BUDGET.balanced;

  const x = toSignal(bytes);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1) return null;                       // silence, or a DC block

  const start = Math.max(0, Math.min(n - 1, playStart | 0));
  const { lo, hi, peakRms } = usableRange(x, start, Math.max(64, Math.round(rate * minLenMs / 1000)));
  // Below a twentieth of the loudest hop there is not enough signal to judge a
  // seam by — a window there is noise, and noise matches noise.
  const floor2 = Math.pow(Math.max(peakRms * 0.05, 0.5), 2);
  const { period, r } = estimatePeriod(x, lo, hi);
  const minLen = Math.max(32, Math.round(rate * minLenMs / 1000),
    period >= 8 && r >= 0.3 ? Math.round(period * 2) : 0);
  if (hi - lo < minLen + 32) return null;

  const base = { mode, policy, budget, period, confidence: r, usable: { lo, hi } };

  if (mode === 2) {
    // Two independent endpoint costs — so the longest region inside the budget
    // is simply the earliest and the latest point that meet it. No pairing, no
    // length grid, one O(n) scan.
    const L = Math.max(8, Math.min(64, Math.round(rate * 0.00075)));
    const cost = new Float64Array(hi - lo);
    for (let p = lo; p < hi; p++) {
      let lvl = 0;
      for (let k = 1; k <= L; k++) {
        const i = p - k, j = p + k;
        if (i < 0 || j >= n) break;
        lvl += 0.5 * (x[i] * x[i] + x[j] * x[j]);
      }
      cost[p - lo] = lvl >= floor2 * L ? cornerResidual(x, p, L) : Infinity;
    }
    const pickMin = (a, b) => {
      let bp = -1, bc = Infinity;
      for (let p = Math.max(lo, a); p < Math.min(hi, b); p++) {
        if (cost[p - lo] < bc) { bc = cost[p - lo]; bp = p; }
      }
      return bp < 0 ? null : { p: bp, rel: bc };
    };
    // Slack: how much of the region we will give back to land on a better
    // turning point. Without it "widest inside the budget" takes the first
    // point that scrapes past the budget and throws away 25 dB of corner for
    // 3% of length — a trade no one makes by hand.
    const slack = Math.max(period >= 8 ? Math.round(period) : 0,
      Math.round((hi - lo) * 0.02), 8);

    let s = -1, e = -1;
    for (let p = lo; p <= hi - minLen; p++) if (cost[p - lo] <= budget) { s = p; break; }
    if (s >= 0) for (let p = hi - 1; p >= s + minLen; p--) if (cost[p - lo] <= budget) { e = p; break; }
    const met = s >= 0 && e >= 0;
    if (met) {
      const S = pickMin(lo, s + slack + 1);
      const E = pickMin(e - slack, hi);
      if (S && E && E.p - S.p >= minLen) { s = S.p; e = E.p; }
    } else {
      // Nothing meets the budget. Return the cleanest PAIR the sample holds,
      // not the cleanest point in some arbitrary end window: minimise the worse
      // of the two corners subject to the length floor, which one prefix-minimum
      // sweep answers exactly.
      const bestUpTo = new Int32Array(hi - lo);
      let run = -1;
      for (let p = lo; p < hi; p++) {
        if (run < 0 || cost[p - lo] < cost[run - lo]) run = p;
        bestUpTo[p - lo] = run;
      }
      let bs = -1, be = -1, bScore = Infinity;
      for (let p = lo + minLen; p < hi; p++) {
        const cand = bestUpTo[p - minLen - lo];
        if (cand < 0) continue;
        const score = Math.max(cost[cand - lo], cost[p - lo]);
        if (score < bScore || (score === bScore && p - cand > be - bs)) {
          bScore = score; bs = cand; be = p;
        }
      }
      if (bs < 0 || !Number.isFinite(bScore)) return null;
      s = bs; e = be;
    }
    // The widest region the search would consider at all — the best turning
    // point in each end window — so the caller can say what a looser policy (or
    // a crossfade) would buy.
    const widestS = pickMin(lo, lo + slack + 1);
    const widestE = pickMin(hi - slack - 1, hi);
    const relS = cost[s - lo], relE = cost[e - lo];
    return {
      ...base,
      loopStart: s, loopEnd: e,
      relStart: relS, relEnd: relE,
      rel: Math.max(relS, relE),
      db: residualDb(Math.max(relS, relE)),
      cycles: period >= 8 ? (e - s) / period : 0,
      metBudget: met,
      widest: widestS && widestE && widestE.p - widestS.p > e - s
        ? { loopStart: widestS.p, loopEnd: widestE.p, rel: Math.max(widestS.rel, widestE.rel) }
        : null,
      front: [],
    };
  }

  // Forward: the pair search, collapsed onto whole pitch periods.
  const window = Math.min(256, Math.max(32, period >= 8 ? Math.round(period * 2) : 128));
  const front = forwardFront(x, lo, hi, { period, r, minLen, window, floor2 });
  if (!front.length) return null;
  // The front is longest-first and strictly improving, so the longest entry
  // inside the budget is the first that meets it — and every entry after it is
  // cleaner. Give back up to 5% of that length to take the best of them: the
  // difference between "as long as the budget allows" and "as long as the
  // budget allows, minus a few periods that were costing 15 dB".
  const met = front.find((q) => q.rel <= budget);
  let pick = met ?? front.reduce((a, b) => (b.rel < a.rel ? b : a));
  if (met) {
    for (const q of front) if (q.len >= met.len * 0.95 && q.rel < pick.rel) pick = q;
  }
  const widest = front[0];
  return {
    ...base,
    loopStart: pick.s, loopEnd: pick.e,
    rel: pick.rel, db: residualDb(pick.rel),
    cycles: period >= 8 ? (pick.e - pick.s) / period : 0,
    metBudget: !!met,
    widest: widest.len > pick.len
      ? { loopStart: widest.s, loopEnd: widest.e, rel: widest.rel }
      : null,
    front,
  };
}
