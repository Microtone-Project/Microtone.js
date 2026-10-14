// The formant instrument's recipe machine (item 212) — what an editor proposes for
// a type-1 instrument out of the samples in its pool range.
//
// The engine (core/engine/formant.js) knows how each consonant SOUNDS: its
// tract, its timing, the shape of its frication. What it needs from the pool
// is raw material — a glottal source for the voicing, and for every consonant
// that hisses, pops or breathes, a span of noise. A recipe is that span made
// fit for the job: which sample, from where, played how fast, tilted how, at
// what gain. This module looks at every sample in the range and says, for each
// consonant, how well each one could serve — the BADNESS, 0 being ideal — so
// the editor can list them best first.
//
// What makes noise good for a consonant is judged in the band the consonant
// actually uses (its frication spectrum, or the tract it aspirates through):
//
//   spectrum   how far from flat the noise is there, in dB, once played at the
//              recipe's speed and tilt — and missing energy counts, so a
//              sample with nothing above 4 kHz is no /s/ however fast it plays
//   tonality   noise must be noise: a pitched sample hisses with a whistle
//   length     how long the noise lasts before the engine has to loop it; a
//              short loop buzzes at its own repetition rate
//   speed      every octave of pitch-shift is a little less like the sample
//   attack     a stop wants something like a click at its offset
//   level      an 8-bit sample recorded very quietly is mostly quantisation
//
// Sources are judged the other way round: a good glottal source is periodic,
// loops, and is rich in harmonics with the −6 dB/octave tilt the tract's
// cascade assumes (a sawtooth's).
//
// Pure computation: reads pool bytes, returns numbers. No DOM, no document
// mutation (the ops are formantedit.js's).

import { Fft } from "../../core/engine/fft.js";
import { META_MIX_GAIN } from "../../core/engine/tables.js";
import {
  CONSONANTS, CONSONANT_LIST, consonantNeedsNoise, timingScale,
  MANNER_STOP, MANNER_AFFRICATE, MANNER_ASPIRATE,
} from "../../core/engine/formant.js";
import { estimatePeriod, resolveLoopRegion } from "./looptune.js";
import { regionBytes } from "./sampleregions.js";

const C4_HZ = 261.6255653005986;
/** The rate the engine is assumed to run at while judging (the browser's). */
export const MACHINE_RATE = 48000;
const FFT_N = 1024;
const HOP = 512;
/** The analysis grid: 1/12 octave from 50 Hz, ten octaves. A speed step of
 *  half an octave is then exactly six grid points. */
const GRID_LO = 50;
const GRID_PER_OCT = 12;
const GRID_N = 120;
const gridHz = (i) => GRID_LO * 2 ** (i / GRID_PER_OCT);
/** Speeds tried: 2^(k/2), k = −4…4. Tilts tried, in the slot's units. */
const SPEED_STEPS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const TILTS = [-96, -64, -32, 0, 32, 64, 96];

const PCM = (b) => (b - 127.5) / 127.5;

/** The shortest part of a recording worth searching (a tenth of a second at 40 kHz). */
const MIN_REGION_PART = 4096;

/**
 * The range's material: the census entries lying wholly inside [lo, hi) — a
 * sample is a unit — and whatever PART of each pool REGION the range covers
 * (TAUD_FILE_FORMAT §9.9: a long recording loaded into memory, which no
 * instrument claims as a whole), first channel only. A region part comes back
 * as {region: true, ptr, len, rate, name, ri, base}, `base` being where the
 * whole recording starts; the machine cuts windows out of it, since an
 * instrument's span is at most 65535 bytes.
 */
export function rangeCandidates(doc, lo, hi) {
  const census = doc.sampleList().filter((e) => e.len > 0 && e.ptr >= lo && e.ptr + e.len <= hi);
  const regions = [];
  doc.sampleRegions().forEach((r, ri) => {
    const a = Math.max(r.ptr, lo), b = Math.min(r.ptr + r.len, hi);
    if (b - a >= MIN_REGION_PART) {
      regions.push({ region: true, ptr: a, len: b - a, rate: r.rate, name: r.name ?? "", ri, base: r.ptr });
    }
  });
  return [...census, ...regions];
}

/** The bounding pool span of a set of census entries: a default range. */
export function spanOf(entries) {
  if (entries.length === 0) return [0, 0];
  let lo = Infinity, hi = 0;
  for (const e of entries) { lo = Math.min(lo, e.ptr); hi = Math.max(hi, e.ptr + e.len); }
  return [lo, hi];
}

/** Every sample AND every region in the pool, as one span: "all samples". */
export function poolSpan(doc) {
  const parts = [...doc.sampleList(), ...doc.sampleRegions().map((r) => ({ ptr: r.ptr, len: regionBytes(r) }))];
  return spanOf(parts.filter((e) => e.len > 0));
}

const pad2 = (n) => String(n).padStart(2, "0");


/** Nearest decibel octet (TAUD_FILE_FORMAT §7.5) to a linear gain. */
export function gainOctet(lin) {
  let best = 159, bd = Infinity;
  for (let o = 1; o < 256; o++) {
    const d = Math.abs(Math.log(META_MIX_GAIN[o]) - Math.log(Math.max(lin, 1e-9)));
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/** One sample's float data, read from the pool. */
function readSamples(bin, ptr, len) {
  const x = new Float64Array(len);
  for (let i = 0; i < len; i++) x[i] = PCM(bin[ptr + i] ?? 128);
  return x;
}

const rmsOf = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

/**
 * Averaged power spectrum over [a, b), Hann frames of FFT_N hopping HOP,
 * zero-padded when shorter. Returns {pow (FFT_N/2 bins), flat (spectral
 * flatness over 300 Hz…8 kHz at the native rate)}.
 */
function averageSpectrum(fft, x, a, b, rate) {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const pow = new Float64Array(FFT_N / 2);
  let frames = 0;
  for (let s = a; frames === 0 || s + FFT_N <= b; s += HOP) {
    for (let i = 0; i < FFT_N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
      re[i] = (s + i < b ? x[s + i] : 0) * w;
      im[i] = 0;
    }
    fft.run(re, im);
    for (let k = 0; k < FFT_N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
    if (frames >= 24) break;   // ~0.5 s at 22 kHz: enough to average
  }
  for (let k = 0; k < FFT_N / 2; k++) pow[k] /= frames;
  // Tonality, not slope: each bin against the mean of its ±8 neighbours, so a
  // sloping noise reads as flat and a line reads as a peak. White noise
  // averaged over F frames has an expected flatness of e^(ψ(F) − ln F), so the
  // measure is divided by that, and a short sample is not called tonal for
  // having been seen only once.
  const k0 = Math.max(9, Math.floor((300 * FFT_N) / rate));
  const k1 = Math.min(FFT_N / 2 - 9, Math.floor((8000 * FFT_N) / rate));
  let lsum = 0, sum = 0, n = 0;
  for (let k = k0; k <= k1; k++) {
    let m = 0;
    for (let j = k - 8; j <= k + 8; j++) m += pow[j];
    m /= 17;
    const r = (pow[k] + 1e-30) / (m + 1e-30);
    lsum += Math.log(r); sum += r; n++;
  }
  let psi = -0.5772156649015329;
  for (let i = 1; i < frames; i++) psi += 1 / i;
  const expect = Math.exp(psi - Math.log(frames));
  const flat = n > 0 && sum > 0 ? Math.min(1, Math.exp(lsum / n) / (sum / n) / expect) : 0;
  return { pow, flat };
}

/** Bin powers onto the log grid (native frequencies); 0 above Nyquist. */
function toGrid(pow, rate) {
  const g = new Float64Array(GRID_N);
  const binHz = rate / FFT_N;
  for (let i = 0; i < GRID_N; i++) {
    const lo = gridHz(i - 0.5), hi = gridHz(i + 0.5);
    if (lo >= rate / 2) { g[i] = 0; continue; }
    let s = 0, n = 0;
    for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.min(FFT_N / 2 - 1, Math.ceil(hi / binHz)); k++) {
      s += pow[k]; n++;
    }
    // A band narrower than a bin reads the bin it falls in.
    if (n === 0) {
      const k = Math.min(FFT_N / 2 - 1, Math.max(1, Math.round(gridHz(i) / binHz)));
      s = pow[k]; n = 1;
    }
    g[i] = s / n;
  }
  return g;
}

/** |H|² of the engine's tilt for slot value t, at frequency f (Hz). */
function tiltPower(t, f) {
  if (t === 0) return 1;
  const c = Math.abs(t) / 128;
  const w = (2 * Math.PI * f) / MACHINE_RATE;
  const d = 1 + c * c - 2 * c * Math.cos(w);
  return t > 0 ? d : ((1 - c) * (1 - c)) / d;
}

/** Klatt resonator |H|² at f, normalised to 1 at its peak (the parallel bank's). */
function peakResPower(F, B, f) {
  const T = 1 / MACHINE_RATE;
  const r = Math.exp(-Math.PI * B * T);
  const c = -(r * r);
  const b = 2 * r * Math.cos(2 * Math.PI * F * T);
  const den = (w) => {
    const re = 1 - b * Math.cos(w) - c * Math.cos(2 * w);
    const im = b * Math.sin(w) + c * Math.sin(2 * w);
    return re * re + im * im;
  };
  return den((2 * Math.PI * F) / MACHINE_RATE) / den((2 * Math.PI * f) / MACHINE_RATE);
}

/**
 * The band a consonant listens to its noise in, on the grid, peak 1: its
 * frication spectrum (Klatt's parallel amplitudes, at an adult male's size),
 * or for the aspirates the 300 Hz – 4 kHz the tract carries.
 */
function consonantWeight(row) {
  const w = new Float64Array(GRID_N);
  // Above 12 kHz nothing about a consonant is heard that matters to which
  // consonant it is; a sample with nothing there is not a worse /f/ for it.
  const top = Math.min(12000, 0.45 * MACHINE_RATE);
  if (row.manner === MANNER_ASPIRATE || row.bank.every((a) => a === 0)) {
    for (let i = 0; i < GRID_N; i++) {
      const f = gridHz(i);
      w[i] = f >= 300 && f <= 4000 ? 1 : 0;
    }
    return w;
  }
  const F = [row.F[1], row.F[2], 3300, 3750, 4900];
  const B = [row.B[1] || 100, row.B[2] || 200, 250, 200, 1000];
  let peak = 0;
  for (let i = 0; i < GRID_N; i++) {
    const f = gridHz(i);
    if (f > top) break;
    let p = 0;
    for (let j = 0; j < 5; j++) {
      if (row.bank[j] > 0) p += 10 ** ((row.bank[j] - 60) / 10) * peakResPower(F[j], B[j], f);
    }
    if (row.bank[5] > 0) p += 10 ** ((row.bank[5] - 60) / 10);
    w[i] = p;
    peak = Math.max(peak, p);
  }
  // Weight by where the energy is; 20 dB under the peak, the bank has
  // filtered the noise away and what it was like there does not matter.
  for (let i = 0; i < GRID_N; i++) {
    const v = peak > 0 ? w[i] / peak : 0;
    w[i] = v >= 0.01 ? v : 0;
  }
  return w;
}

/** How long a consonant reads its noise for, in ms at the given timing. */
function noiseMs(row, timing) {
  const k = timingScale(timing);
  switch (row.manner) {
    case MANNER_STOP: return (row.burst + row.vot + 10) * k;
    case MANNER_AFFRICATE: return (row.burst + row.dur + 10) * k;
    default: return (row.dur + 20) * k;
  }
}

// ── windows into a long recording ───────────────────────────────────────────
//
// An instrument's span is a U16, so a recording of seconds or minutes can only
// be used a window at a time. The machine looks through a region in 2048-byte
// frames and cuts out the windows worth trying:
//
//   noise   the noisiest loud stretches — a breath, a hiss, a cymbal's wash;
//           half a second each, plenty for any consonant
//   burst   the sharpest onsets — a click, a pluck, a consonant in speech —
//           starting just before the attack, a quarter of a second each
//   tone    the most periodic loud stretches, a second each, with a loop the
//           app's own loop finder cuts in them: candidate glottal sources
//
// Each kind keeps a handful, spread through the recording. A window becomes a
// census sample of its own once a record points at it, as any window cut out
// of a recording does (TAUD_FILE_FORMAT §9.9).

const WINDOW_MAX = 65535;
const SCAN_FRAME = 2048;

function regionWindows(fft, bin, r) {
  const rate = Math.max(1000, r.rate || 8363);
  const n = Math.min(r.len, bin.length - r.ptr);
  const frames = [];
  for (let s = 0; s + SCAN_FRAME <= n; s += SCAN_FRAME) {
    const x = readSamples(bin, r.ptr + s, SCAN_FRAME);
    const rms = rmsOf(x);
    frames.push({ s, rms, flat: rms > 0.01 ? averageSpectrum(fft, x, 0, SCAN_FRAME, rate).flat : 0 });
  }
  const out = [];
  const lenFor = (s, secs) => Math.min(WINDOW_MAX, n - s, Math.round(rate * secs));
  const window = (s, kind, len) => ({
    ptr: r.ptr + s, len, rate: r.rate || 8363, loopStart: 0, loopEnd: 0, loopMode: 0,
    name: "", index: -1, kind, label: `R${pad2(r.ri)} @${((r.ptr - r.base + s) / rate).toFixed(2)} s`,
  });
  const pick = (scored, count, spacing, make) => {
    scored.sort((a, b) => b.score - a.score || a.s - b.s);
    const taken = [];
    for (const c of scored) {
      if (taken.length >= count) break;
      if (taken.some((t) => Math.abs(t - c.s) < spacing)) continue;
      const w = make(c);
      if (w) { taken.push(c.s); out.push(w); }
    }
  };
  // Noise: loud and flat.
  pick(frames.filter((f) => f.rms >= 0.02).map((f) => ({ s: f.s, score: f.flat * f.rms })),
    8, rate * 0.5, (c) => window(c.s, "noise", lenFor(c.s, 0.5)));
  // Bursts: a frame four times louder than the one before; the window starts
  // 16 bytes before the first sample to reach 30% of what follows.
  const bursts = [];
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i], p = frames[i - 1];
    if (f.rms >= 0.05 && f.rms > 4 * Math.max(p.rms, 1e-3)) bursts.push({ s: f.s, score: f.rms / Math.max(p.rms, 1e-3) });
  }
  pick(bursts, 4, rate * 0.3, (c) => {
    const a = Math.max(0, c.s - SCAN_FRAME);
    const x = readSamples(bin, r.ptr + a, Math.min(2 * SCAN_FRAME, n - a));
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    let at = 0;
    while (at < x.length && Math.abs(x[at]) < 0.3 * peak) at++;
    const s = Math.max(0, a + at - 16);
    return window(s, "burst", lenFor(s, 0.25));
  });
  // Tones: loud, peaky and periodic — then looped.
  const tones = [];
  for (const f of frames) {
    if (f.rms < 0.05 || f.flat > 0.5 || f.s + 2 * SCAN_FRAME > n) continue;
    const x = readSamples(bin, r.ptr + f.s, 2 * SCAN_FRAME);
    const { period, r: corr } = estimatePeriod(x, 0, x.length, { pmin: 8, pmax: 1600 });
    if (period > 0 && corr >= 0.7) tones.push({ s: f.s, score: corr * f.rms });
  }
  pick(tones, 4, rate * 1.0, (c) => {
    const len = lenFor(c.s, 1.0);
    const loop = resolveLoopRegion(bin.subarray(r.ptr + c.s, r.ptr + c.s + len), { mode: 1, policy: "clean", rate });
    if (!loop || loop.loopEnd - loop.loopStart < 8) return null;
    return { ...window(c.s, "tone", len), loopStart: loop.loopStart, loopEnd: loop.loopEnd, loopMode: 1 };
  });
  return out;
}

/**
 * The machine. `bin` is the pool (8 MiB Uint8Array), `candidates` census
 * entries ({ptr, len, rate, loopStart, loopEnd, loopMode, index, name}).
 * Analyses are made once per candidate and kept.
 */
export class FormantMachine {
  constructor(bin, candidates) {
    this.bin = bin;
    this.fft = new Fft(FFT_N);
    this._an = new Map();
    this._w = new Map();
    this._memo = new Map();   // recipes and charts, by consonant, source and timing
    const census = candidates.filter((c) => !c.region);
    const regions = candidates.filter((c) => c.region);
    // A census entry inside a region with no name of its own is most likely a
    // window an earlier recipe took from it: say where it came from.
    for (const e of census) {
      const r = regions.find((g) => e.ptr >= g.ptr && e.ptr + e.len <= g.ptr + g.len);
      if (r && !e.name) e.label = `R${pad2(r.ri)} @${((e.ptr - r.base) / Math.max(1, r.rate || 8363)).toFixed(2)} s`;
    }
    const seen = new Set(census.map((e) => `${e.ptr}:${e.len}`));
    const windows = [];
    for (const r of regions) {
      for (const w of regionWindows(this.fft, bin, r)) {
        const key = `${w.ptr}:${w.len}`;
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push(w);
      }
    }
    /** Every candidate, census entries first. */
    this.cands = [...census, ...windows];
    /** How many things the range holds: samples, plus whole regions. */
    this.materialCount = census.length + regions.length;
    this._sourceCands = [...census, ...windows.filter((w) => w.kind === "tone")];
    this._noiseCands = [...census, ...windows.filter((w) => w.kind !== "tone")];
  }

  /** Per-candidate analysis: data, level, the offsets worth trying, spectra. */
  analysis(e) {
    const key = `${e.ptr}:${e.len}`;
    let a = this._an.get(key);
    if (a) return a;
    const rate = Math.max(1000, e.rate || 8363);
    const x = readSamples(this.bin, e.ptr, e.len);
    const rms = rmsOf(x);
    // Offsets: the start (where a percussive sample's click is), and the
    // noisiest steady stretch (where a recorded hiss is cleanest).
    const offsets = [0];
    if (e.len > FFT_N * 2) {
      let best = 0, bestScore = -1;
      for (let s = 0; s + FFT_N <= e.len; s += FFT_N) {
        const sp = averageSpectrum(this.fft, x, s, Math.min(e.len, s + FFT_N), rate);
        const score = sp.flat * rmsOf(x, s, s + FFT_N);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (best > 0) offsets.push(best);
    }
    const at = offsets.map((off) => {
      const end = Math.min(e.len, off + Math.max(FFT_N, Math.round(rate * 0.25)));
      const sp = averageSpectrum(this.fft, x, off, end, rate);
      const grid = toGrid(sp.pow, rate);
      // Attack: the first 5 ms against the 20 ms after it.
      const n5 = Math.max(1, Math.round(rate * 0.005));
      const r1 = rmsOf(x, off, Math.min(e.len, off + n5));
      const r2 = rmsOf(x, Math.min(e.len, off + n5), Math.min(e.len, off + 5 * n5));
      // Parseval: the mean bin power is the signal's power times a constant
      // of the analysis, whatever its spectrum — so a band's mean power over
      // that constant is the RMS² white noise of the same density would have.
      const r = rmsOf(x, off, end);
      let mp = 0;
      for (let k = 0; k < FFT_N / 2; k++) mp += sp.pow[k];
      mp /= FFT_N / 2;
      const psdScale = r > 0 && mp > 0 ? (r * r) / mp : 0;
      return { offset: off, grid, flat: sp.flat, attack: r2 > 0 ? r1 / r2 : 1, rms: r, psdScale };
    });
    a = { e, rate, x, rms, at };
    this._an.set(key, a);
    return a;
  }

  _weight(row) {
    let w = this._w.get(row.id);
    if (!w) { w = consonantWeight(row); this._w.set(row.id, w); }
    return w;
  }

  /**
   * How a candidate serves as the glottal source: {cand, badness, c4Rate,
   * hz, loops}. c4Rate is the record rate that makes it sound middle C at
   * note $5000, from its own period.
   */
  judgeSource(e) {
    const a = this.analysis(e);
    const looped = (e.loopMode & 3) === 1 || (e.loopMode & 3) === 2;
    const s0 = looped ? e.loopStart : 0;
    const s1 = looped ? Math.max(e.loopEnd, s0 + 1) : e.len;
    const seg = a.x;
    // For a short single-cycle loop, tile it so the autocorrelation has
    // several periods to see.
    let sig = seg, lo = s0, hi = s1;
    if (looped && s1 - s0 < 2048) {
      const L = s1 - s0;
      sig = new Float64Array(Math.max(4096, L * 4));
      for (let i = 0; i < sig.length; i++) sig[i] = seg[s0 + (i % L)];
      lo = 0; hi = sig.length;
    }
    const { period, r } = estimatePeriod(sig, lo, hi, { pmin: 4, pmax: 4000 });
    const hz = period > 0 ? a.rate / period : 0;
    let bad = 0;
    bad += (1 - Math.max(0, Math.min(1, r))) * 4;          // aperiodic
    if (!looped) bad += e.len / a.rate < 2 ? 2 : 0.5;       // ends while sung
    if (hz < 25 || hz > 2000) bad += 1;
    // Harmonic tilt: the slope of the spectrum from 150 Hz to 5 kHz, dB/oct.
    const g = a.at[0].grid;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let i = 0; i < GRID_N; i++) {
      const f = gridHz(i);
      if (f < 150 || f > 5000 || f >= a.rate / 2 || g[i] <= 0) continue;
      const xo = Math.log2(f), y = 10 * Math.log10(g[i]);
      sx += xo; sy += y; sxx += xo * xo; sxy += xo * y; n++;
    }
    const slope = n > 2 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
    bad += Math.min(3, Math.abs(slope + 6) / 6);
    if (a.rms < 0.02) bad += 1;
    const c4Rate = period > 0 ? Math.min(65535, Math.max(1, Math.round(period * C4_HZ))) : (e.rate || 8363);
    return { cand: e, badness: bad, c4Rate, hz, loops: looped };
  }

  /** Every candidate as a source, best first. */
  sources() {
    return this._sourceCands.map((e) => this.judgeSource(e)).sort((p, q) => p.badness - q.badness);
  }

  /**
   * Every recipe for consonant `consId`, best first: {cand, offset, rate,
   * tilt, gain, badness, parts}. `source` (a census entry or null) sets the
   * level the noise is matched to; `timing` is the record's timing byte. A
   * consonant that reads no noise has one recipe, the voice alone.
   */
  recipes(consId, source = null, timing = 128) {
    const key = `r${consId}:${source ? `${source.ptr}:${source.len}` : "-"}:${timing}`;
    let memo = this._memo.get(key);
    if (!memo) { memo = this._recipes(consId, source, timing); this._memo.set(key, memo); }
    return memo;
  }

  _recipes(consId, source, timing) {
    const row = CONSONANTS[consId];
    if (row === undefined) return [];
    if (!consonantNeedsNoise(row)) {
      return [{ cand: null, offset: 0, rate: 0, tilt: 0, gain: 0, badness: 0, parts: {} }];
    }
    const W = this._weight(row);
    const Q = new Float64Array(GRID_N);
    const srcRms = source !== null ? Math.max(1e-4, this.analysis(source).rms) : 0.577;
    const needMs = noiseMs(row, timing);
    const wantsAttack = row.manner === MANNER_STOP || row.manner === MANNER_AFFRICATE;
    const out = [];
    for (const e of this._noiseCands) {
      const a = this.analysis(e);
      for (const at of a.at) {
        let best = null;
        for (const k of SPEED_STEPS) {
          const rate = Math.round(a.rate * 2 ** (k / 2));
          if (rate < 1000 || rate > 65535) continue;
          const shift = (k * GRID_PER_OCT) / 2;   // whole grid points
          for (const t of TILTS) {
            // The noise as heard through the band: its flatness there, as a
            // power-weighted spectral flatness — 0 dB for white noise, deep
            // negative where a hum or a whistle carries the power, or where a
            // band has nothing to give (a deficit counts down to −40 dB under
            // the band's mean, no further).
            let wsum = 0, am = 0;
            for (let i = 0; i < GRID_N; i++) {
              if (W[i] === 0) continue;
              const j = i - shift;
              const p = j >= 0 && j < GRID_N ? at.grid[j] : 0;
              const q = p * tiltPower(t, gridHz(i));
              Q[i] = q;
              am += W[i] * q;
              wsum += W[i];
            }
            if (wsum <= 0 || am <= 0) continue;
            am /= wsum;
            const floor = am * 1e-4;
            let gl = 0;
            for (let i = 0; i < GRID_N; i++) {
              if (W[i] === 0) continue;
              gl += W[i] * Math.log(Math.max(Q[i], floor));
            }
            const sfmDb = -10 * Math.log10(Math.exp(gl / wsum) / am);
            const spectrum = sfmDb / 3;
            if (best === null || spectrum < best.spectrum) best = { rate, tilt: t, spectrum, k };
          }
        }
        if (best === null) continue;
        const tonality = Math.max(0, 0.85 - at.flat) * 4;
        const haveMs = ((e.len - at.offset) / best.rate) * 1000;
        const length = haveMs >= needMs ? 0
          : haveMs < 40 ? ((40 - haveMs) / 40) * 2 + 0.3 : 0.3;
        const speed = Math.abs(best.k) * 0.15;
        const attack = wantsAttack ? Math.max(0, 1.2 - at.attack) * 0.5 : 0;
        // The noise's level IN THE BAND, as white noise of that density would
        // be measured: what the gain has to bring up to the voice's, and what
        // the 8-bit floor (about −50 dB) would be heard through if it is low.
        let pw = 0, wsum = 0;
        for (let i = 0; i < GRID_N; i++) {
          if (W[i] === 0) continue;
          const j = i - (best.k * GRID_PER_OCT) / 2;
          const p = j >= 0 && j < GRID_N ? at.grid[j] : 0;
          pw += W[i] * p * tiltPower(best.tilt, gridHz(i));
          wsum += W[i];
        }
        const bandRms = Math.sqrt(Math.max(0, (pw / Math.max(wsum, 1e-30)) * at.psdScale));
        const bandDb = 20 * Math.log10(Math.max(bandRms, 1e-6));
        const level = bandDb < -36 ? Math.min(3, (-36 - bandDb) / 6) : 0;
        const badness = best.spectrum + tonality + length + speed + attack + level;
        out.push({
          cand: e, offset: at.offset, rate: best.rate, tilt: best.tilt,
          gain: gainOctet(srcRms / Math.max(bandRms, 1e-4)), badness,
          parts: { spectrum: best.spectrum, tonality, length, speed, attack, level },
        });
      }
    }
    return out.sort((p, q) => p.badness - q.badness);
  }

  /** Each consonant's best badness (0 for one that needs no noise; Infinity
   *  for one no candidate can make at all). For colouring a chart. */
  bestPerConsonant(source = null, timing = 128) {
    const key = `b${source ? `${source.ptr}:${source.len}` : "-"}:${timing}`;
    if (this._memo.has(key)) return this._memo.get(key);
    const m = new Map();
    this._memo.set(key, m);
    for (const row of CONSONANT_LIST) {
      const r = this.recipes(row.id, source, timing);
      m.set(row.id, r.length > 0 ? r[0].badness : Infinity);
    }
    return m;
  }
}

