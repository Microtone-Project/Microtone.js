// Binaural monitoring (#998.3, rebuilt for item 128) — the render target that
// makes a surround song AUDIBLE on headphones while you compose it.
//
// Why this exists: playback normally installs StereoRenderer, which folds the
// rear semicircle onto the front and collapses elevation toward the centre. It
// is the right stereo DOWNMIX, but it is a projection: behind sounds exactly
// like in front, and height is inaudible. Authoring a position you cannot hear
// is a non-starter, so this file adds a second monitor path.
//
// ── How it works ──
// The bus channels ARE an ambisonic scene: `channelGains` is the SN3D/ACN
// encode (the same basis as the AmbiX export, spatial.js `encodeSN3D`), so a
// voice is amplitude-encoded into spherical harmonics exactly as it is for a
// B-format render. `monitorStereo` then decodes that scene to two ears with the
// GoogleVR/SADIE spherical-harmonic HRIR set — one 256-tap convolution per
// ambisonic channel, summed. Because the set is measured, the interaural delay,
// the head shadow and the pinna's spectral cues arrive with it; there is no
// head model here to tune, and no per-source filtering at all. The mixer calls
// `monitorStereo` once per frame IN ORDER, which is what lets this renderer be
// stateful (the convolution history) while every other renderer stays a pure
// function.
//
// The right ear costs nothing extra: a listener mirrored left↔right is the same
// listener, and mirroring flips the sign of every harmonic with m < 0 and
// leaves the rest alone. So one convolution per channel serves both ears —
// L = Σ_{m≥0} + Σ_{m<0}, R = Σ_{m≥0} − Σ_{m<0}. This is the trick Omnitone's
// HOAConvolver builds out of Web Audio nodes; here it is the two accumulators
// in the frame loop.
//
// See hrir-sadie.js for the data, its provenance and its licence. What replaced
// what: this used to be a parametric head (Woodworth ITD, Brown & Duda shadow,
// a tuned pinna notch) driven from a ring of virtual speakers. Measured beats
// parametric — front/back and height are now cues a real head measured rather
// than curves fitted by ear — and the ambisonic basis is both cheaper per
// source (no per-speaker filter bank) and honest about what the bus carries.
//
// Not a port: the Kotlin engine has no surround at all, so this file — like
// spatial.js — IS the reference implementation.

import { SAMPLING_RATE } from "./constants.js";
import { AMBISONIC_ORDER_MAX, encodeSN3D } from "./spatial.js";
import {
  HRIR_ORDER, HRIR_CHANNELS, HRIR_LENGTH, HRIR_RATE, decodeShHrir,
} from "./hrir-sadie.js";

/** Monitor modes (playhead state). Fold = StereoRenderer, the default. */
export const MONITOR_FOLD = 0;
export const MONITOR_BINAURAL = 1;

/** The order the HRIR set decodes, capped by the basis spatial.js implements. */
const BIN_ORDER = Math.min(HRIR_ORDER, AMBISONIC_ORDER_MAX);
const BIN_SH_COUNT = (BIN_ORDER + 1) * (BIN_ORDER + 1);

/** Azimuth of the front axis — the direction the level contract is fixed at. */
const BIN_FRONT_AZIMUTH = 128;

/** Rate conversion of the HRIR set: Kaiser-windowed sinc, resampler.js's β. */
const BIN_RESAMP_HALF = 24;
const BIN_RESAMP_BETA = 8.0;

/**
 * ACN channels a source ON THE HORIZON can excite. Y_lm vanishes on the horizon
 * whenever l − |m| is odd, so for a planar song — where nothing ever leaves the
 * horizon — dropping those is EXACT, not an approximation, and it buys back six
 * of the sixteen convolutions. A spatial song keeps the whole set.
 */
export function binauralChannelList(sphere) {
  const list = [];
  for (let l = 0; l <= BIN_ORDER; l++) {
    for (let m = -l; m <= l; m++) {
      if (sphere || (l - Math.abs(m)) % 2 === 0) list.push(l * l + l + m);
    }
  }
  return Int32Array.from(list);
}

/** +1 where mirroring the listener leaves the harmonic alone (m ≥ 0), −1 where
 *  it flips the sign (m < 0) — the right ear, in one array. */
function binauralMirrorSigns(acn) {
  const out = new Int8Array(acn.length);
  for (let i = 0; i < acn.length; i++) {
    const k = acn[i];
    const l = Math.floor(Math.sqrt(k));
    out[i] = k - (l * l + l) >= 0 ? 1 : -1; // k − (l²+l) IS m
  }
  return out;
}

function binBesselI0(x) {
  let sum = 1.0;
  let term = 1.0;
  const half = x * 0.5;
  for (let k = 1; k < 24; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Rate-convert the whole set (item 108: the engine runs at 48 kHz, which is the
 * rate the HRIRs were measured at, but a test or a future device may not).
 * These are IMPULSE RESPONSES, not signals, so the taps are scaled by 1/ratio:
 * what has to survive is the filter's response Σh·e^{−jωn}, not the sequence's
 * amplitude. Length is rounded up to a multiple of four for the convolver's
 * unrolled inner loop.
 */
function binauralResample(src, srcLen, channels, rate) {
  const ratio = rate / HRIR_RATE;
  const cutoff = ratio < 1.0 ? ratio : 1.0;      // of the SOURCE Nyquist
  const half = Math.ceil(BIN_RESAMP_HALF / cutoff);
  const dstLen = (Math.ceil(srcLen * ratio) + 3) & ~3;
  const out = new Float64Array(channels * dstLen);
  const norm = binBesselI0(BIN_RESAMP_BETA);
  const scale = 1.0 / ratio;
  for (let n = 0; n < dstLen; n++) {
    const t = n / ratio;
    const lo = Math.max(0, Math.ceil(t - half));
    const hi = Math.min(srcLen - 1, Math.floor(t + half));
    for (let i = lo; i <= hi; i++) {
      const d = t - i;
      const u = cutoff * d;
      const sinc = Math.abs(u) < 1e-9 ? 1.0 : Math.sin(Math.PI * u) / (Math.PI * u);
      const x = d / half;
      const w = binBesselI0(BIN_RESAMP_BETA * Math.sqrt(1.0 - x * x)) / norm;
      const g = cutoff * sinc * w * scale;
      for (let c = 0; c < channels; c++) out[c * dstLen + n] += src[c * srcLen + i] * g;
    }
  }
  return out;
}

/**
 * Level contract: a source dead ahead must leave the head carrying the same
 * total power the stereo pan law gives it (cos² + sin² = 1, i.e. 0.707 per ear,
 * exactly what the fold delivers). One scalar does it, folded into the table.
 * Every other direction is then free to differ, and does — a real head is
 * quieter behind and below, and that level cue is part of what makes the
 * direction audible rather than an artefact to flatten out.
 */
function binauralCalibration(hrir, len) {
  const sh = new Float64Array(BIN_SH_COUNT);
  encodeSN3D(BIN_FRONT_AZIMUTH, 0.0, BIN_ORDER, sh);
  const all = Int32Array.from({ length: BIN_SH_COUNT }, (_, k) => k);
  const mirror = binauralMirrorSigns(all);
  let energy = 0.0;
  for (let n = 0; n < len; n++) {
    let p = 0.0;
    let q = 0.0;
    for (let k = 0; k < BIN_SH_COUNT; k++) {
      const v = sh[k] * hrir[k * len + n];
      if (mirror[k] > 0) p += v; else q += v;
    }
    energy += (p + q) * (p + q) + (p - q) * (p - q);
  }
  return 1.0 / Math.sqrt(energy);
}

/** The decoded, rate-converted, calibrated set — one build per rate, ever. */
const binauralTables = new Map();

export function binauralHrirTable(rate = SAMPLING_RATE) {
  let t = binauralTables.get(rate);
  if (t !== undefined) return t;
  const raw = decodeShHrir();
  const hrir = rate === HRIR_RATE
    ? raw
    : binauralResample(raw, HRIR_LENGTH, HRIR_CHANNELS, rate);
  const taps = hrir.length / HRIR_CHANNELS;
  const gain = binauralCalibration(hrir, taps);
  for (let i = 0; i < hrir.length; i++) hrir[i] *= gain;
  t = { hrir, taps };
  binauralTables.set(rate, t);
  return t;
}

/**
 * Headphone render target: the bus carries an ambisonic scene, and the monitor
 * pair is that scene decoded through the SADIE HRIRs. `numChannels` is the
 * harmonic count — 16 for a spatial song, 10 for a planar one — so the decode
 * costs that many taps-long convolutions per frame, and the encode costs the
 * same handful of multiplies per voice the AmbiX export costs.
 */
export class BinauralRenderer {
  constructor(sphere = true, sampleRate = SAMPLING_RATE) {
    this.sphere = sphere;
    this.acn = binauralChannelList(sphere);
    this.numChannels = this.acn.length;
    this.name = `binaural-${sphere ? "3d" : "2d"}`;
    this.sampleRate = sampleRate;
    this.order = BIN_ORDER;

    const table = binauralHrirTable(sampleRate);
    this.taps = table.taps;
    // The set's channels, gathered into bus order so the frame loop walks both
    // the history and the taps straight forward.
    this.hrir = new Float64Array(this.numChannels * this.taps);
    for (let c = 0; c < this.numChannels; c++) {
      this.hrir.set(table.hrir.subarray(this.acn[c] * this.taps, (this.acn[c] + 1) * this.taps),
        c * this.taps);
    }
    this.mirror = binauralMirrorSigns(this.acn);

    // Convolution history: every sample is written twice, `taps` apart, so a
    // backwards run of `taps` taps is always one contiguous stretch — no
    // index masking in the innermost loop.
    this.hist = new Float64Array(this.numChannels * this.taps * 2);
    this.histPos = 0;
    this._sh = new Float64Array(BIN_SH_COUNT);
  }

  /** Drop the convolution history (a new song, or a monitor switch). */
  reset() {
    this.hist.fill(0.0);
    this.histPos = 0;
  }

  /** Ambisonic encode — the bus channel gains for a source at (az, el). */
  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, BIN_ORDER, this._sh);
    const acn = this.acn;
    for (let c = 0; c < acn.length; c++) out[off + c] = sh[acn[c]];
  }

  /**
   * Decode one frame to two ears (the mixer calls this in frame order, which is
   * what makes the history below legal): one FIR per ambisonic channel, summed
   * into the symmetric and antisymmetric halves, then L = P + N, R = P − N.
   */
  monitorStereo(data, frames, n, out) {
    const nc = this.numChannels;
    const taps = this.taps;
    const hrir = this.hrir;
    const hist = this.hist;
    const mirror = this.mirror;
    const pos = this.histPos;
    let p = 0.0;
    let q = 0.0;

    for (let c = 0; c < nc; c++) {
      const base = c * taps * 2;
      const x = data[c * frames + n];
      hist[base + pos] = x;
      hist[base + pos + taps] = x;

      // Four accumulators: the tap loop is one long dependent chain of adds
      // otherwise, and breaking it is worth ~35 % of the whole decode.
      const hb = c * taps;
      const head = base + pos + taps;
      let a0 = 0.0;
      let a1 = 0.0;
      let a2 = 0.0;
      let a3 = 0.0;
      for (let i = 0; i < taps; i += 4) {
        a0 += hrir[hb + i] * hist[head - i];
        a1 += hrir[hb + i + 1] * hist[head - i - 1];
        a2 += hrir[hb + i + 2] * hist[head - i - 2];
        a3 += hrir[hb + i + 3] * hist[head - i - 3];
      }
      const acc = (a0 + a1) + (a2 + a3);
      if (mirror[c] > 0) p += acc; else q += acc;
    }

    this.histPos = pos + 1 === taps ? 0 : pos + 1;
    out[0] = p + q;
    out[1] = p - q;
  }
}
