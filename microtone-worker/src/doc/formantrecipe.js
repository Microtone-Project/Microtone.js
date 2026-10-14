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
// Every recipe's gain brings its noise to the level the engine's own noise
// generator sounds at (FORMANT_LEVEL, white), and the generator itself is
// always one of the recipes: white noise is what the bank was designed to
// shape, so it is nearly always the best, and listed first. A sample earns its
// place by what it has that white noise has not — a click for a stop, a
// recorded hiss's own colour.
//
// Sources are judged the other way round: a good glottal source is periodic,
// loops, and is rich in harmonics with the −6 dB/octave tilt of a sawtooth.
// Its level is not judged: the engine measures every source and sings them
// all at one level.
//
// Pure computation: reads pool bytes, returns numbers. No DOM, no document
// mutation (the ops are formantedit.js's).

import { Fft } from "../../core/engine/fft.js";
import { META_MIX_GAIN } from "../../core/engine/tables.js";
import {
  CONSONANTS, CONSONANT_LIST, consonantNeedsNoise, timingScale, vowelAtPitch, noteHz,
  MANNER_STOP, MANNER_AFFRICATE, MANNER_ASPIRATE, FORMANT_LEVEL,
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

// ── a source against a vowel ────────────────────────────────────────────────

/** The band a vowel is told apart in. */
const VOWEL_LO = 200, VOWEL_HI = 4000;

/**
 * A period that is really a multiple of the true one comes back from the
 * coarse search when the true lag falls between two decimated lags and its
 * double does not (looptune.estimatePeriod re-examines halves and thirds of
 * its answer, not quarters). A sung vowel, with one harmonic far stronger
 * than the rest, does exactly that. So the divisors 2…4 are tried at full
 * rate, and the shortest one correlating as well — within 2% — wins.
 */
function truePeriod(x, est) {
  if (!(est.period > 0)) return est;
  const ncc = (p) => {
    const n = x.length - Math.ceil(p) - 1;
    if (n < 64) return -1;
    let num = 0, e0 = 0, e1 = 0;
    for (let i = 0; i < n; i++) {
      const j = i + p, j0 = Math.floor(j), fr = j - j0;
      const y = x[j0] + (x[j0 + 1] - x[j0]) * fr;
      num += x[i] * y; e0 += x[i] * x[i]; e1 += y * y;
    }
    return num / (Math.sqrt(e0 * e1) + 1e-12);
  };
  const base = ncc(est.period);
  let best = { period: est.period, r: est.r };
  for (const k of [2, 3, 4]) {
    const p = est.period / k;
    if (p < 4) break;
    const r = ncc(p);
    if (r >= base - 0.02 && p < best.period) best = { period: p, r: Math.max(est.r, r) };
  }
  return best;
}

/**
 * A grid spectrum's envelope in dB over the vowel band, below the rate's
 * Nyquist: the loudest band within a third of an octave each side (so the
 * gaps between a low voice's harmonics do not count as dips), averaged over
 * a sixth of an octave. NaN outside the band.
 */
function harmonicEnvelope(g, rate) {
  const db = new Float64Array(GRID_N);
  for (let i = 0; i < GRID_N; i++) db[i] = g[i] > 0 ? 10 * Math.log10(g[i]) : -300;
  const mx = new Float64Array(GRID_N);
  for (let i = 0; i < GRID_N; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - 4); j <= Math.min(GRID_N - 1, i + 4); j++) m = Math.max(m, db[j]);
    mx[i] = m;
  }
  const out = new Float64Array(GRID_N);
  for (let i = 0; i < GRID_N; i++) {
    const f = gridHz(i);
    if (f < VOWEL_LO || f > VOWEL_HI || f >= 0.45 * rate) { out[i] = NaN; continue; }
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(GRID_N - 1, i + 2); j++) { sum += mx[j]; n++; }
    out[i] = sum / n;
  }
  return out;
}

/** A grid envelope moved by `shift` grid points (a pitch change), interpolated;
 *  what falls outside the vowel band, or off the envelope, is NaN. */
function shiftGrid(env, shift) {
  const out = new Float64Array(GRID_N).fill(NaN);
  for (let i = 0; i < GRID_N; i++) {
    const f = gridHz(i);
    if (f < VOWEL_LO || f > VOWEL_HI) continue;
    const j = i - shift;
    const j0 = Math.floor(j), fr = j - j0;
    const a = env[j0], b = env[j0 + 1];
    if (Number.isFinite(a) && Number.isFinite(b)) out[i] = a + (b - a) * fr;
  }
  return out;
}

/** The vowel's tract response in dB on the grid at its reference note —
 *  Klatt's unity-DC cascade at the formants the engine sings. */
function vowelEnvelope(v) {
  const ref = noteHz(v.refNote ?? 0x4000);
  const F = new Float64Array(5), B = new Float64Array(5);
  vowelAtPitch(v.front, v.open, v.round, ref, ref, v.track ?? 64, F, B);
  const out = new Float64Array(GRID_N).fill(NaN);
  const T = 1 / MACHINE_RATE;
  for (let i = 0; i < GRID_N; i++) {
    const f = gridHz(i);
    if (f < VOWEL_LO || f > VOWEL_HI) continue;
    const w = 2 * Math.PI * f * T;
    let h = 0;
    for (let n = 0; n < 5; n++) {
      const r = Math.exp(-Math.PI * B[n] * T);
      const c = -(r * r), b = 2 * r * Math.cos(2 * Math.PI * F[n] * T), A = 1 - b - c;
      const re = 1 - b * Math.cos(w) - c * Math.cos(2 * w);
      const im = b * Math.sin(w) + c * Math.sin(2 * w);
      h += 10 * Math.log10((A * A) / (re * re + im * im));
    }
    out[i] = h;
  }
  return out;
}

/**
 * Fit a source's envelope E (dB) as c + t·octaves + β·V, V the vowel's, β
 * held to 0…1 — a source shaped like the vowel only deepens it, and one
 * shaped against it is no use. Returns {bad, tilt, beta}: what the fit leaves
 * over (a second vowel sung on top of the first) as an RMS in 6 dB units, and
 * the tilt t in dB per octave once the vowel has explained what it can. Null
 * when the two share fewer than 6 points.
 */
function vowelFit(E, V) {
  const idx = [];
  for (let i = 0; i < GRID_N; i++) if (Number.isFinite(E[i]) && Number.isFinite(V[i])) idx.push(i);
  if (idx.length < 6) return null;
  const x = (i) => i / GRID_PER_OCT;
  // Least squares for (c, t) on y = E − βV, given β.
  const line = (beta) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const i of idx) { const y = E[i] - beta * V[i]; sx += x(i); sy += y; sxx += x(i) * x(i); sxy += x(i) * y; }
    const n = idx.length;
    const t = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { t, c: (sy - t * sx) / n };
  };
  // β minimising the residual is linear in the line's own residuals: regress
  // E's residual from its line on V's residual from its line.
  const resid = (arr) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const i of idx) { sx += x(i); sy += arr[i]; sxx += x(i) * x(i); sxy += x(i) * arr[i]; }
    const n = idx.length;
    const t = (n * sxy - sx * sy) / (n * sxx - sx * sx), c = (sy - t * sx) / n;
    return idx.map((i) => arr[i] - (c + t * x(i)));
  };
  const re = resid(E), rv = resid(V);
  let ev = 0, vv = 0;
  for (let k = 0; k < idx.length; k++) { ev += re[k] * rv[k]; vv += rv[k] * rv[k]; }
  const beta = vv > 0 ? Math.min(1, Math.max(0, ev / vv)) : 0;
  const { t, c } = line(beta);
  let rr = 0;
  for (const i of idx) { const r = E[i] - beta * V[i] - (c + t * x(i)); rr += r * r; }
  return { bad: Math.sqrt(rr / idx.length) / 6, tilt: t, beta };
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
//   tone    the most periodic loud stretches, half a second each, with a loop
//           the app's own loop finder cuts in them: candidate glottal sources
//           (eight, so a recording of several sung vowels offers each)
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
  pick(tones, 8, rate * 0.5, (c) => {
    const len = lenFor(c.s, 0.5);
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
    this._memo = new Map();   // recipes and charts, by consonant and timing
    this._srcMemo = new Map(); // a candidate's worth as a source, before the vowel
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
    this._sourceCands = [
      ...census,
      ...census.map((e) => this._reloop(e)).filter((e) => e !== null),
      ...windows.filter((w) => w.kind === "tone"),
    ];
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
   * A looped sample whose loop sits well under its loudest stretch — the
   * decayed tail of a plucked or sung sample, looped to sustain it — offered
   * again with a loop the app's loop finder cuts IN that stretch, or null. A
   * formant record's loop points are its own, so the sample need not change:
   * the source is simply the sample's body rather than its tail. "Well
   * under" is 9 dB; the stretch is the loudest 1024-byte window grown either
   * way while its neighbours stay within 6 dB of it, at most 8192 bytes.
   */
  _reloop(e) {
    if ((e.loopMode & 3) !== 1 && (e.loopMode & 3) !== 2) return null;
    if (!(e.loopEnd > e.loopStart) || e.len < 2048) return null;
    const x = this.analysis(e).x;
    const W = 1024, H = W >> 1;
    const lv = [];
    for (let o = 0; o + W <= x.length; o += H) lv.push(rmsOf(x, o, o + W));
    if (lv.length === 0) return null;
    let k = 0;
    for (let i = 1; i < lv.length; i++) if (lv[i] > lv[k]) k = i;
    const loopRms = rmsOf(x, e.loopStart, Math.min(e.loopEnd, x.length));
    if (!(lv[k] > loopRms * 10 ** (9 / 20))) return null;
    let a = k, b = k;
    const near = (i) => lv[i] >= lv[k] * 0.5;
    while (a > 0 && near(a - 1) && (b - a + 2) * H + H <= 8192) a--;
    while (b < lv.length - 1 && near(b + 1) && (b - a + 2) * H + H <= 8192) b++;
    const from = a * H, to = Math.min(x.length, b * H + W);
    const loop = resolveLoopRegion(this.bin.subarray(e.ptr + from, e.ptr + to),
      { mode: 1, policy: "clean", rate: Math.max(1000, e.rate || 8363) });
    if (!loop || loop.loopEnd - loop.loopStart < 16) return null;
    return { ...e, loopStart: from + loop.loopStart, loopEnd: from + loop.loopEnd,
      loopMode: (e.loopMode & ~3) | 1, autoLoop: true, relooped: true };
  }

  /**
   * How a candidate serves as the glottal source, before any vowel is asked
   * about: {cand, base, c4Rate, hz, loops, env}. A sample that does not loop
   * is given a loop by the app's own loop finder — the source has to sustain
   * — and `cand` is then a copy carrying those loop points. `env` is the
   * loop's spectral envelope in dB on the analysis grid, its tilt removed,
   * NaN where there is nothing to read; a sawtooth's is flat.
   */
  _sourceBase(e) {
    const key = `${e.ptr}:${e.len}:${e.loopStart}:${e.loopEnd}:${e.loopMode}`;
    let s = this._srcMemo.get(key);
    if (s) return s;
    const a = this.analysis(e);
    let cand = e;
    let looped = (e.loopMode & 3) === 1 || (e.loopMode & 3) === 2;
    // Only a sample that is periodic as it stands is given a loop: a loop cut
    // in noise is periodic at its own length and would pass for a tone.
    if (!looped && e.len >= 256 &&
        estimatePeriod(a.x, 0, a.x.length, { pmin: 4, pmax: 4000 }).r >= 0.6) {
      const loop = resolveLoopRegion(this.bin.subarray(e.ptr, e.ptr + e.len),
        { mode: 1, policy: "clean", rate: a.rate });
      if (loop && loop.loopEnd - loop.loopStart >= 16) {
        cand = { ...e, loopStart: loop.loopStart, loopEnd: loop.loopEnd,
          loopMode: (e.loopMode & ~3) | 1, autoLoop: true };
        looped = true;
      }
    }
    const s0 = looped ? cand.loopStart : 0;
    const s1 = looped ? Math.max(cand.loopEnd, s0 + 1) : e.len;
    const seg = a.x;
    // The loop tiled to 8192 samples: what the source sounds like once it is
    // sustaining, with enough periods for the autocorrelation and the FFT.
    const L = s1 - s0;
    const sig = new Float64Array(Math.max(8192, Math.min(L, 16384)));
    for (let i = 0; i < sig.length; i++) sig[i] = seg[s0 + (i % L)];
    const est = estimatePeriod(sig, 0, sig.length, { pmin: 4, pmax: 4000 });
    const { period, r } = truePeriod(sig, est);
    const hz = period > 0 ? a.rate / period : 0;
    let bad = 0;
    bad += (1 - Math.max(0, Math.min(1, r))) * 4;          // aperiodic
    if (!looped) bad += e.len / a.rate < 2 ? 2 : 0.5;       // ends while sung
    if (hz < 25 || hz > 2000) bad += 1;
    // The loop's spectrum. For a periodic source the harmonics are read one by
    // one — band averages would mistake the gaps between sparse harmonics (a
    // single-cycle loop's) for a slope.
    const spec = averageSpectrum(this.fft, sig, 0, sig.length, a.rate).pow;
    const g = toGrid(spec, a.rate);
    const binHz = a.rate / FFT_N;
    const level = (f) => {
      const c = Math.round(f / binHz);
      let m = 0;
      for (let k = Math.max(1, c - 1); k <= Math.min(FFT_N / 2 - 1, c + 1); k++) m = Math.max(m, spec[k]);
      return m;
    };
    const top = Math.min(5000, 0.45 * a.rate);
    // Its tilt from 150 Hz to 5 kHz, dB/octave: the harmonics' levels, or the
    // band levels for something with no pitch.
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    const addPoint = (f, p) => {
      if (p <= 0) return;
      const xo = Math.log2(f), y = 10 * Math.log10(p);
      sx += xo; sy += y; sxx += xo * xo; sxy += xo * y; n++;
    };
    if (hz > 0) {
      for (let k = 1; k * hz <= top; k++) if (k * hz >= 150) addPoint(k * hz, level(k * hz));
    } else {
      for (let i = 0; i < GRID_N; i++) {
        const f = gridHz(i);
        if (f >= 150 && f <= top) addPoint(f, g[i]);
      }
    }
    const slope = n > 2 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
    // Harmonics it lacks: a square wave, all odd harmonics, sounds hollow
    // through any tract. A harmonic counts as missing 20 dB under its two
    // neighbours' mean; the penalty is twice the share that is missing.
    if (hz > 0) {
      let missing = 0, counted = 0;
      for (let k = 2; k <= 24 && (k + 1) * hz < top; k++) {
        const around = (level((k - 1) * hz) + level((k + 1) * hz)) / 2;
        if (around <= 0) continue;
        counted++;
        if (level(k * hz) < around * 0.01) missing++;
      }
      if (counted > 0) bad += (missing / counted) * 2;
    }
    // Quiet costs bits: an 8-bit loop at −30 dBFS has a handful of byte
    // values left, and the engine lifts it — noise and all — to the
    // instrument's level. Half a point for every 6 dB under −20 dBFS.
    const levelDb = 20 * Math.log10(Math.max(rmsOf(sig), 1e-6));
    if (levelDb < -20) bad += ((-20 - levelDb) / 6) * 0.5;
    const c4Rate = period > 0 ? Math.min(65535, Math.max(1, Math.round(period * C4_HZ))) : (e.rate || 8363);
    s = { cand, base: bad, slope, c4Rate, hz, loops: looped, env: harmonicEnvelope(g, a.rate) };
    this._srcMemo.set(key, s);
    return s;
  }

  /**
   * How a candidate serves as the source, for `vowel` ({front, open, round,
   * track, refNote}) or for no vowel in particular: {cand, badness, c4Rate,
   * hz, loops, vowelBad}. The tract shapes whatever the source already is, so
   * a source with formants of its own — a recording of somebody singing —
   * adds them to the vowel's. Heard at the reference note (where the chart's
   * formants hold), the source's envelope is compared with the vowel's: what
   * the vowel's own shape explains costs nothing (a recorded [i] is a fine
   * source for [i], and a sawtooth, being flat, for anything); what is left
   * over is a second vowel sung on top of the first, and is the badness.
   */
  judgeSource(e, vowel = null) {
    const s = this._sourceBase(e);
    // With no vowel, a source should tilt as a sawtooth does, −6 dB/octave.
    // With one, the tilt is what is left once the vowel's own shape has
    // explained what it can — a recorded [u] is dark because [u] is, and that
    // is no fault in a source for [u].
    let vowelBad = 0, tilt = s.slope;
    if (vowel && s.hz > 0) {
      const shift = Math.log2(noteHz(vowel.refNote ?? 0x4000) / s.hz) * GRID_PER_OCT;
      const fit = vowelFit(shiftGrid(s.env, shift), vowelEnvelope(vowel));
      if (fit !== null) { vowelBad = fit.bad; tilt = fit.tilt; }
    }
    const tiltBad = Math.min(3, Math.abs(tilt + 6) / 6);
    return { cand: s.cand, badness: s.base + tiltBad + vowelBad, c4Rate: s.c4Rate, hz: s.hz, loops: s.loops, vowelBad };
  }

  /** Every candidate as a source, best first — for `vowel`, when given. */
  sources(vowel = null) {
    return this._sourceCands.map((e) => this.judgeSource(e, vowel)).sort((p, q) => p.badness - q.badness);
  }

  /** The source the machine would choose for `vowel`, or null. */
  bestSource(vowel = null) {
    return this.sources(vowel)[0] ?? null;
  }

  /**
   * Every recipe for consonant `consId`, best first: {cand, generator,
   * offset, rate, tilt, gain, badness, parts}. `timing` is the record's
   * timing byte. A consonant that reads no noise has one recipe, the voice
   * alone (cand null); one that does has the engine's noise generator among
   * them (cand null, generator true), and every sample recipe's gain brings
   * its noise to the generator's level.
   */
  recipes(consId, timing = 128) {
    const key = `r${consId}:${timing}`;
    let memo = this._memo.get(key);
    if (!memo) { memo = this._recipes(consId, timing); this._memo.set(key, memo); }
    return memo;
  }

  _recipes(consId, timing) {
    const row = CONSONANTS[consId];
    if (row === undefined) return [];
    if (!consonantNeedsNoise(row)) {
      return [{ cand: null, generator: false, offset: 0, rate: 0, tilt: 0, gain: 0, badness: 0, parts: {} }];
    }
    const W = this._weight(row);
    const Q = new Float64Array(GRID_N);
    const needMs = noiseMs(row, timing);
    const wantsAttack = row.manner === MANNER_STOP || row.manner === MANNER_AFFRICATE;
    // The generator: white, so flat in any band, as long as it is needed, at
    // its own speed, at the level — everything a recipe is judged on, but a
    // click: its first 5 ms are as loud as the 20 ms after them.
    const genAttack = wantsAttack ? (1.2 - 1) * 0.5 : 0;
    const out = [{
      cand: null, generator: true, offset: 0, rate: 0, tilt: 0, gain: 0, badness: genAttack,
      parts: { spectrum: 0, tonality: 0, length: 0, speed: 0, attack: genAttack, level: 0 },
    }];
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
        // be measured at the sample's own rate: what the gain has to bring to
        // the generator's density — FORMANT_LEVEL spread over the output's
        // band, where the sample's, played at `rate`, spreads over rate ÷ 2 —
        // and what the 8-bit floor (about −50 dB) would be heard through if it
        // is low.
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
          cand: e, generator: false, offset: at.offset, rate: best.rate, tilt: best.tilt,
          gain: gainOctet((FORMANT_LEVEL / Math.max(bandRms, 1e-4)) * Math.sqrt(best.rate / MACHINE_RATE)), badness,
          parts: { spectrum: best.spectrum, tonality, length, speed, attack, level },
        });
      }
    }
    return out.sort((p, q) => p.badness - q.badness);
  }

  /** Each consonant's best badness (0 for one that needs no noise; the
   *  generator makes every other one). For colouring a chart. */
  bestPerConsonant(timing = 128) {
    const key = `b${timing}`;
    if (this._memo.has(key)) return this._memo.get(key);
    const m = new Map();
    this._memo.set(key, m);
    for (const row of CONSONANT_LIST) {
      const r = this.recipes(row.id, timing);
      m.set(row.id, r.length > 0 ? r[0].badness : Infinity);
    }
    return m;
  }
}

