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
// The tap itself — the accumulators, the B-format ring, the true-peak
// oversampler, the per-target channel choice above — is the engine's
// (core/engine/c/src/meters.c), and drains into the snapshot. Here: the
// targets, the ring's shape and the meter strip's labels and arrangement,
// which the page draws with.
//
// COST: everything is opt-in. The tap is built only while the strip is on
// screen, and a stereo song never pays for a bus at all (its tap is two adds on
// the finished mix).

import { SURROUND_STEREO } from "./spatial.js";
import { SPEAKER_LAYOUTS } from "./speakers.js";

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

/** What a reading of the strip's tap is read into (AudioSystem.readAnalysis,
 *  the engine's WasmAnalysisTap.drain): the interval's figures, per meter. */
export function makeAnalysisReadout() {
  return {
    frames: 0, fieldEnergy: 0, corrLL: 0, corrRR: 0, corrLR: 0, ringWrite: 0, meterCount: 0,
    peak: new Float64Array(ANALYSIS_MAX_METERS),
    truePeak: new Float64Array(ANALYSIS_MAX_METERS),
    meanSquare: new Float64Array(ANALYSIS_MAX_METERS),
    clip: new Float64Array(ANALYSIS_MAX_METERS),
  };
}
