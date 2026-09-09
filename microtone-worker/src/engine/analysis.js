// Master-bus analysis tap (item 98) — what the mastering strip looks at.
//
// The strip asks two different questions, and they want two different signals:
//
//   * "where is the energy in the room?" — the vectorscopes. That is a question
//     about the SOUND FIELD, not about any particular set of speakers, so the
//     scope tap is always first-order B-format (ACN/SN3D: W Y Z X). The three
//     Goniometer views are then literally axis pairs of that field — top = Y·X
//     (left-right against front-back), front = Y·Z, side = X·Z — and no view
//     needs a decode. A STEREO song has no front-back axis at all, so its tap
//     is taken from the finished mix instead: W = (L+R)/√2, Y = (L−R)/√2, which
//     is exactly the stereo→B-format encoding of a ±90° pair, and makes the top
//     view the classic mid/side goniometer. One display, every model.
//
//   * "will it clip, and how loud is it?" — the meters. That IS a question
//     about a target: 5.1's centre channel is only a thing if you are mastering
//     for 5.1. So the meters read a metering TARGET the user picks, rendered
//     through the very same renderers the exporter uses (speakers.js), which is
//     what makes the bars agree with the file that comes out.
//
// ── The ambisonic case ──
// There are no speakers to meter, so per-speaker levels are meaningless. What
// IS meaningful is the acoustic energy density of the encoded field,
//
//     E = (W² + X² + Y² + Z²) / 2
//
// which for SN3D order 1 reads p² for a plane wave from ANY direction and sums
// correctly over uncorrelated sources — a direction-invariant loudness that
// needs no decode and no listening position. Peak is per encoded CHANNEL (that
// is what clips in the exported file), oversampled 4× for the inter-sample
// peaks a later decode or resample would expose.
//
// Not a port: the Kotlin engine has no surround and no analysis tap, so this
// file — like spatial.js and binaural.js — IS the reference implementation.
//
// COST: everything here is opt-in. The tap is built only while the strip is on
// screen, and a stereo song never pays for a bus at all (its tap is two adds on
// the finished mix). See TrackerState.setAnalysis.

import { TRACKER_CHUNK } from "./constants.js";
import {
  SURROUND_STEREO, SURROUND_SPATIAL, SpatialBus, encodeSN3D,
} from "./spatial.js";
import { SPEAKER_LAYOUTS, SpeakerRenderer } from "./speakers.js";

/** Metering targets. The value is the wire form (CMD.SET_ANALYSIS.target). */
export const ANALYSIS_OFF = "off";
export const ANALYSIS_STEREO = "stereo";
export const ANALYSIS_AMBISONIC = "ambisonic";
/** …plus every key of SPEAKER_LAYOUTS ("quad", "5.1", "7.1"). */

/**
 * Scope ring: frames of B-format held for the vectorscopes. 4096 frames is
 * 85 ms at 48 kHz — five snapshot intervals, so a 60 fps strip never misses a
 * sample, and the cloud it draws is a WIDE window: many points, and only about
 * an eighth of them replaced per frame, which is what makes the shape settle
 * instead of flickering. The ring rides in the snapshot (64 KiB), so this is
 * also what the wire pays.
 */
export const SCOPE_FRAMES = 4096;
/**
 * SECOND-ORDER ACN/SN3D — W Y Z X, then the five order-2 harmonics, in the
 * ring's interleave order.
 *
 * The scopes and the radiation surface only ever read the first four, and for
 * them order 1 IS the field. The soundfield cloud needs the rest, because at
 * first order some genuinely different scenes are the SAME four numbers: two
 * sources in anti-phase cancel in W entirely, and a pair at ±15° then encodes
 * identically to a pair at ±90°. Nothing downstream can undo that. The order-2
 * quadrupole breaks the tie and recovers both bearings exactly (see cloud.js).
 *
 * COST: the ring is the snapshot's largest block, and this takes it from 64 KiB
 * to 144 KiB. It is still built only while the strip is on screen.
 */
export const SCOPE_CHANNELS = 9;
export const SCOPE_W = 0, SCOPE_Y = 1, SCOPE_Z = 2, SCOPE_X = 3;
/** First of the five order-2 harmonics (ACN 4..8). */
export const SCOPE_ORDER2 = 4;
/** The ambisonic order the ring carries. */
export const SCOPE_ORDER = 2;

/** Widest metered channel set (7.1). Bounds the snapshot's meter block. */
export const ANALYSIS_MAX_METERS = 8;

const SQRT1_2 = Math.SQRT1_2;

/** Which signals the meters read for a given target. */
export const METER_MIX = 0;       // the finished stereo mix (fold or binaural)
export const METER_FOA = 1;       // the encoded field's own channels
export const METER_SPEAKERS = 2;  // speaker feeds, exactly as the exporter writes them

/**
 * Channel labels for a target, in meter order — the UI draws these under the
 * bars, and they are the same names speakers.js gives the exporter.
 */
export function meterLabels(target) {
  if (target === ANALYSIS_STEREO) return ["L", "R"];
  // Meter order is W Y X Z, not the ring's ACN order: it puts the three
  // channels a planar song can actually excite first, so its meter strip is
  // three live bars instead of three live bars and a dead one.
  if (target === ANALYSIS_AMBISONIC) return ["W", "Y", "X", "Z"];
  const layout = SPEAKER_LAYOUTS[target];
  return layout ? layout.speakers.map((s) => s.label) : [];
}

/**
 * How a speaker layout's bars are ARRANGED on screen: left to right the way the
 * speakers stand around the listener, rather than in the file's channel order.
 * The LFE is not drawn at all — the exporter leaves it silent by design
 * (speakers.js), so a bar for it would only ever be a dead one.
 */
const METER_ARRANGEMENT = Object.freeze({
  quad: ["Ls", "L", "R", "Rs"],
  "5.1": ["Ls", "L", "C", "R", "Rs"],
  "7.1": ["Lrs", "Lss", "L", "C", "R", "Rss", "Rrs"],
});

/**
 * The meter strip as it is drawn: {label, channel} pairs, where `channel` is
 * the index the tap meters that signal on. Anything the arrangement leaves out
 * (the LFE) simply has no entry.
 */
export function meterDisplay(target) {
  const labels = meterLabels(target);
  const order = METER_ARRANGEMENT[target];
  if (!order) return labels.map((label, channel) => ({ label, channel }));
  const out = [];
  for (const label of order) {
    const channel = labels.indexOf(label);
    if (channel >= 0) out.push({ label, channel });
  }
  return out;
}

/**
 * The targets that make sense for a surround model. A stereo song has exactly
 * one (there is nowhere else for the sound to go); a planar song can be
 * mastered for any ring; a spatial one additionally for a full-sphere basis.
 * The UI hides everything not listed here — item 98's "nonsensical options are
 * hidden" rule, applied to the meters.
 */
export function availableTargets(model) {
  if (model === SURROUND_STEREO) return [ANALYSIS_STEREO];
  return [ANALYSIS_STEREO, "quad", "5.1", "7.1", ANALYSIS_AMBISONIC];
}

// ── 4× true-peak oversampler ────────────────────────────────────────────────
// A 32-tap windowed sinc split into 4 polyphase branches of 8 taps. Each branch
// is normalised to unity DC gain on its own, so a constant input reads back as
// itself and the oversampled peak can never sit BELOW the sample peak for a
// steady signal. No branch is the identity (the linear-phase delay 15.5 is not
// a multiple of 4), so the sample peak is tracked separately and folded in.

const TP_PHASES = 4;
const TP_TAPS = 8;

const TP_COEF = (() => {
  const n = TP_PHASES * TP_TAPS;
  const h = new Float64Array(n);
  const centre = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - centre) / TP_PHASES;
    const sinc = t === 0 ? 1.0 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
  }
  // Per-branch DC normalisation (see above).
  for (let p = 0; p < TP_PHASES; p++) {
    let s = 0.0;
    for (let k = 0; k < TP_TAPS; k++) s += h[k * TP_PHASES + p];
    if (s !== 0) for (let k = 0; k < TP_TAPS; k++) h[k * TP_PHASES + p] /= s;
  }
  return h;
})();

/**
 * Per-channel inter-sample peak detector. `channels` histories are kept side by
 * side; `push` returns nothing and `peak(c)` is read at drain time.
 */
export class TruePeakDetector {
  constructor(channels) {
    this.channels = channels;
    this.hist = new Float64Array(channels * TP_TAPS); // newest first
    this.peaks = new Float64Array(channels);
  }

  reset() {
    this.hist.fill(0.0);
    this.peaks.fill(0.0);
  }

  /** Feed one sample of channel `c` and fold its 4 interpolated points in. */
  push(c, v) {
    const base = c * TP_TAPS;
    const h = this.hist;
    for (let k = TP_TAPS - 1; k > 0; k--) h[base + k] = h[base + k - 1];
    h[base] = v;
    let hi = this.peaks[c];
    for (let p = 0; p < TP_PHASES; p++) {
      let acc = 0.0;
      for (let k = 0; k < TP_TAPS; k++) acc += h[base + k] * TP_COEF[k * TP_PHASES + p];
      const a = acc < 0 ? -acc : acc;
      if (a > hi) hi = a;
    }
    this.peaks[c] = hi;
  }

  clearPeaks() { this.peaks.fill(0.0); }
}

/**
 * The same oversampler, one channel at a time, reporting the instantaneous
 * inter-sample peak instead of accumulating one.
 *
 * The mastering limiter (mastering.js) uses this for its true-peak mode, which
 * is why it lives here beside the detector rather than being written out again
 * over there: a limiter and a meter that disagree about what "true peak" means
 * would make the ceiling a suggestion.
 */
export class TruePeakProbe {
  constructor() { this.hist = new Float64Array(TP_TAPS); }
  reset() { this.hist.fill(0.0); }
  /** Largest magnitude among `v` and the four points interpolated around it. */
  push(v) {
    const h = this.hist;
    for (let k = TP_TAPS - 1; k > 0; k--) h[k] = h[k - 1];
    h[0] = v;
    let hi = v < 0 ? -v : v;
    for (let p = 0; p < TP_PHASES; p++) {
      let acc = 0.0;
      for (let k = 0; k < TP_TAPS; k++) acc += h[k] * TP_COEF[k * TP_PHASES + p];
      const a = acc < 0 ? -acc : acc;
      if (a > hi) hi = a;
    }
    return hi;
  }
}

// ── The analysis render target ──────────────────────────────────────────────

/**
 * Channels 0..3 are always the B-format scope tap; a speaker target appends its
 * own feeds after them, so ONE bus serves both halves of the strip and every
 * voice's gains are computed once per direction change.
 *
 * It is a SpatialRenderer like any other — the mixer cannot tell it apart from
 * the exporter's — but it is never a monitor, so `monitorStereo` is only the
 * FOA virtual-stereo decode the correlation meter uses.
 */
export class AnalysisRenderer {
  constructor(speakerLayout = null) {
    this.speakers = speakerLayout === null ? null : new SpeakerRenderer(speakerLayout);
    this.numChannels = SCOPE_CHANNELS + (this.speakers === null ? 0 : this.speakers.numChannels);
    this.name = `analysis-${speakerLayout ?? "foa"}`;
    this._sh = new Float64Array(SCOPE_CHANNELS);
  }

  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, SCOPE_ORDER, this._sh);
    for (let c = 0; c < SCOPE_CHANNELS; c++) out[off + c] = sh[c];
    if (this.speakers !== null) this.speakers.channelGains(az, el, out, off + SCOPE_CHANNELS);
  }

  /** W ± Y — the coincident cardioid pair, i.e. the stereo the field would fold to. */
  monitorStereo(data, frames, n, out) {
    const w = data[n];
    const y = data[frames + n];
    out[0] = (w + y) * SQRT1_2;
    out[1] = (w - y) * SQRT1_2;
  }
}

// ── The tap ─────────────────────────────────────────────────────────────────

/**
 * Accumulates everything the strip needs over a chunk and hands it to the
 * snapshot: a ring of B-format frames (scopes), per-channel peak / true peak /
 * mean square / clip count (meters), the field energy integral (the ambisonic
 * RMS) and the three correlation sums.
 *
 * Meters and correlation are drained per snapshot (~16 ms) and integrated by
 * the UI, which is where the ballistics belong — the engine ships numbers, not
 * a look.
 */
export class AnalysisTap {
  /**
   * @param {string} target one of ANALYSIS_STEREO / ANALYSIS_AMBISONIC / a SPEAKER_LAYOUTS key
   * @param {number} model  the song's surround model (SURROUND_*)
   */
  constructor(target, model) {
    this.target = target;
    this.model = model;
    const stereoSong = model === SURROUND_STEREO;
    const layout = SPEAKER_LAYOUTS[target] ? target : null;

    // A stereo song's field is derived from the finished mix (two adds per
    // frame), so it needs no bus and no per-voice work whatsoever. Any other
    // model already runs an object bus for the monitor; this is the second one.
    this.bus = stereoSong ? null : new SpatialBus(new AnalysisRenderer(layout), TRACKER_CHUNK);

    if (stereoSong || target === ANALYSIS_STEREO) {
      this.meterSource = METER_MIX;
      this.meterCount = 2;
    } else if (layout !== null) {
      this.meterSource = METER_SPEAKERS;
      this.meterCount = SPEAKER_LAYOUTS[layout].speakers.length;
    } else {
      this.meterSource = METER_FOA;
      // A planar song can never excite Z; metering it would be a permanently
      // dead bar, so the ambisonic meter drops it (the exported AmbiX file
      // still carries the full basis — see #998.4).
      this.meterCount = model === SURROUND_SPATIAL ? 4 : 3;
    }

    this.ring = new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS);
    this.ringWrite = 0; // frame index into the ring (wraps; the UI reads backwards)

    this.peak = new Float64Array(ANALYSIS_MAX_METERS);
    this.sumsq = new Float64Array(ANALYSIS_MAX_METERS);
    this.clip = new Float64Array(ANALYSIS_MAX_METERS);
    this.tp = new TruePeakDetector(this.meterCount);
    this.frames = 0;
    this.fieldEnergy = 0.0;
    this.corrLL = 0.0;
    this.corrRR = 0.0;
    this.corrLR = 0.0;
    this._meters = new Float64Array(ANALYSIS_MAX_METERS);
  }

  /** Per-chunk: the bus is an accumulator like the monitor's. */
  begin() {
    if (this.bus !== null) this.bus.clear();
  }

  /**
   * Fold one rendered chunk in. `mixL`/`mixR` are the finished device pair
   * (post fold/binaural, post Amiga filter, post clamp) — which is exactly what
   * a stereo export writes, so the stereo meters read the delivered signal
   * rather than the pre-master bus.
   */
  finish(frames, mixL, mixR) {
    const bus = this.bus;
    const data = bus === null ? null : bus.data;
    const busFrames = bus === null ? 0 : bus.frames;
    const nc = this.meterCount;
    const src = this.meterSource;
    const ring = this.ring;
    const m = this._meters;

    for (let n = 0; n < frames; n++) {
      let w, y, z, x;
      if (data === null) {
        // Stereo song: the ±90° pair encoding, which is also the inverse of the
        // monitorStereo decode above.
        const l = mixL[n];
        const r = mixR[n];
        w = (l + r) * SQRT1_2;
        y = (l - r) * SQRT1_2;
        z = 0.0;
        x = 0.0;
      } else {
        w = data[n];
        y = data[busFrames + n];
        z = data[2 * busFrames + n];
        x = data[3 * busFrames + n];
      }

      const rw = this.ringWrite * SCOPE_CHANNELS;
      ring[rw] = w;
      ring[rw + 1] = y;
      ring[rw + 2] = z;
      ring[rw + 3] = x;
      // The order-2 harmonics ride along untouched; a stereo song has none (it
      // has no bus at all), and its ring simply carries zeros there.
      if (data === null) {
        for (let c = SCOPE_ORDER2; c < SCOPE_CHANNELS; c++) ring[rw + c] = 0;
      } else {
        for (let c = SCOPE_ORDER2; c < SCOPE_CHANNELS; c++) {
          ring[rw + c] = data[c * busFrames + n];
        }
      }
      this.ringWrite = (this.ringWrite + 1) % SCOPE_FRAMES;

      this.fieldEnergy += (w * w + x * x + y * y + z * z) * 0.5;

      // Correlation is always measured on a stereo pair: the mix itself when
      // there is one, otherwise the field's virtual stereo decode.
      let cl, cr;
      if (data === null) {
        cl = mixL[n];
        cr = mixR[n];
      } else {
        cl = (w + y) * SQRT1_2;
        cr = (w - y) * SQRT1_2;
      }
      this.corrLL += cl * cl;
      this.corrRR += cr * cr;
      this.corrLR += cl * cr;

      if (src === METER_MIX) {
        m[0] = mixL[n];
        m[1] = mixR[n];
      } else if (src === METER_FOA) {
        m[0] = w; m[1] = y; m[2] = x; m[3] = z; // meterLabels order, not ACN
      } else {
        for (let c = 0; c < nc; c++) m[c] = data[(SCOPE_CHANNELS + c) * busFrames + n];
      }
      for (let c = 0; c < nc; c++) {
        const v = m[c];
        const a = v < 0 ? -v : v;
        if (a > this.peak[c]) this.peak[c] = a;
        this.sumsq[c] += v * v;
        // The mix bus is hard-clamped to ±1, so a sample AT full scale is a
        // clipped one; an object/speaker bus is unclamped and only exceeding
        // full scale would clip the file it is written to.
        if (a >= 1.0) this.clip[c] += 1;
        this.tp.push(c, v);
      }
    }
    this.frames += frames;
  }

  /** Snapshot readout; resets the accumulators (peaks included — the UI holds
   *  the hold/decay, so a stale peak can never stick here). */
  drain(out) {
    out.frames = this.frames;
    out.fieldEnergy = this.fieldEnergy;
    out.corrLL = this.corrLL;
    out.corrRR = this.corrRR;
    out.corrLR = this.corrLR;
    out.ringWrite = this.ringWrite;
    out.meterCount = this.meterCount;
    for (let c = 0; c < this.meterCount; c++) {
      const tp = this.tp.peaks[c];
      out.peak[c] = this.peak[c];
      out.truePeak[c] = tp > this.peak[c] ? tp : this.peak[c];
      out.meanSquare[c] = this.frames > 0 ? this.sumsq[c] / this.frames : 0.0;
      out.clip[c] = this.clip[c];
    }
    this.frames = 0;
    this.fieldEnergy = 0.0;
    this.corrLL = this.corrRR = this.corrLR = 0.0;
    this.peak.fill(0.0);
    this.sumsq.fill(0.0);
    this.clip.fill(0.0);
    this.tp.clearPeaks();
    return out;
  }
}

/** A drain target, so the snapshot fill allocates nothing. */
export function makeAnalysisReadout() {
  return {
    frames: 0, fieldEnergy: 0, corrLL: 0, corrRR: 0, corrLR: 0, ringWrite: 0, meterCount: 0,
    peak: new Float64Array(ANALYSIS_MAX_METERS),
    truePeak: new Float64Array(ANALYSIS_MAX_METERS),
    meanSquare: new Float64Array(ANALYSIS_MAX_METERS),
    clip: new Float64Array(ANALYSIS_MAX_METERS),
  };
}
