// The tables and pitch arithmetic the page computes with — FINETUNE_OFFSET,
// the effect opcodes, META_MIX_GAIN, the pitch conversions and slides (port of
// AudioAdapter.kt 1406-1513, 1632-1690). The engine's own, and the tables only
// it reads (the sinc kernel, SNES_GAUSS, MOD_SIN_TABLE, the Amiga filters, the
// FM decimator), are C: core/engine/c/src/tables.c.

import {
  MIDDLE_C, AMIGA_BASE_PERIOD, LINEAR_FREQ_C4_HZ,
  TUNING_REF_C4_HZ, TUNING_DEFAULT_BASE_NOTE, TUNING_DEFAULT_FREQ_HZ,
} from "./constants.js";

// ── ST3-style fine-tune offsets in 4096-TET units (S $2x00; 1419) ──
export const FINETUNE_OFFSET = Int32Array.from([
  -0x0154, -0x0132, -0x0111, -0x00e4, -0x00b8, -0x008b, -0x005d, -0x003b,
  0x0000, 0x0023, 0x0046, 0x0074, 0x0098, 0x00c8, 0x00f9, 0x0110,
]);

// ── Effect opcode constants (base-36 digit values; 1438-1472) ──
export const EffectOp = Object.freeze({
  OP_NONE: 0x00,
  OP_1: 0x01, OP_2: 0x02, OP_3: 0x03, OP_4: 0x04,
  OP_5: 0x05, OP_6: 0x06, OP_7: 0x07, OP_8: 0x08, OP_9: 0x09,
  OP_A: 0x0a, OP_B: 0x0b, OP_C: 0x0c, OP_D: 0x0d, OP_E: 0x0e, OP_F: 0x0f,
  OP_G: 0x10, OP_H: 0x11, OP_I: 0x12, OP_J: 0x13, OP_K: 0x14, OP_L: 0x15,
  OP_M: 0x16, OP_N: 0x17, OP_O: 0x18, OP_P: 0x19, OP_Q: 0x1a, OP_R: 0x1b,
  OP_S: 0x1c, OP_T: 0x1d, OP_U: 0x1e, OP_V: 0x1f, OP_W: 0x20, OP_X: 0x21,
  OP_Y: 0x22, OP_Z: 0x23,
  // ── ASCII-symbol space (item 162): the base-36 range above is full, so a
  //    symbol effect's on-disk opcode is its ASCII code + $80 ($A0..$FE);
  //    the in-memory value is that same byte, no translation table needed.
  OP_COLON: 0xba, // ':' — argument extension, Format 3 only (TAUD_NOTE_EFFECTS.md)
});

/** Which opcodes read `:`'s argument when paired with it (effects.c's `ext`
 *  parameter) — J, O and the sample-mod pair. Shared with the UI so the
 *  pattern grid's "this pairing needs a second look" highlight (see
 *  cellpaint.js paintFxCell) agrees with what the engine actually does. */
export const EXT_CAPABLE_OPS = Object.freeze(new Set([
  EffectOp.OP_J, EffectOp.OP_O, EffectOp.OP_2, EffectOp.OP_3,
]));

// ── Metainstrument mix-gain: "Perceptually Significant Octet to Decibel Table"
//    as linear amplitude (1480-1513). Octet 0 = silence, 159 = unity, 255 = +24 dB.
export const META_MIX_GAIN = Float64Array.from([
  0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
  0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
  0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
  0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
  0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
  0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
  0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
  0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
  0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
  0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
  0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
  0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
  0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
  0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
  0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
  0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
  0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
  0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
  0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
  0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
  1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
  1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
  1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
  1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
  1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
  1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
  2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
  2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
  3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
  4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
  6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
  10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932,
]);

/** initialAttenuation octet → linear amplitude multiplier (0 = unity sentinel). */
export function attenGainOf(octet) {
  return octet <= 0 ? 1.0 : META_MIX_GAIN[octet & 0xff];
}

// ── Pitch conversions (1632-1690) ──

export function noteValToAmigaPeriod(noteVal) {
  return AMIGA_BASE_PERIOD * 2 ** (-(noteVal - MIDDLE_C) / 4096.0);
}

export function amigaPeriodToNoteVal(period) {
  return Math.round(MIDDLE_C + 4096.0 * Math.log2(AMIGA_BASE_PERIOD / period));
}

export function noteValToFreqHz(noteVal) {
  return LINEAR_FREQ_C4_HZ * 2 ** ((noteVal - MIDDLE_C) / 4096.0);
}

export function freqHzToNoteVal(freq) {
  return Math.round(MIDDLE_C + 4096.0 * Math.log2(freq / LINEAR_FREQ_C4_HZ));
}

/**
 * Song tuning pair → playback-rate multiplier (item 77).
 *
 * Step 1 of terranmon.txt §"Note Tuning" folds the declared "note `baseNote`
 * sounds at `freq` Hz" down to a C4 frequency (the spec's own worked example:
 * A4/440 → C4/261.6255653). The engine's zero point is concert C4, so the
 * multiplier is just how far the song's C4 sits from it. Every note the
 * playhead sounds is scaled by this, so the song retunes as a whole.
 *
 * Deliberately a pure ratio with NO log/exp round trip. `2 **` with a rational
 * exponent is the one transcendental the engine already trusts to agree with
 * the JVM bit-for-bit (computePlaybackRate leans on it), whereas Math.log2 has
 * no such guarantee — routing the tuning through a log would put the whole
 * bit-exact gate at the mercy of a last-ulp difference between platforms.
 *
 * A concert declaration returns EXACTLY 1.0: 440 is f32-representable and
 * `440 / 2**0.75 === TUNING_REF_C4_HZ` bit-for-bit, and `x * 1.0 === x`, so
 * A4@440 songs render without a single bit disturbed. The tracker default
 * (C9 @ 8363) returns 0.99892… — ~1.87 cents flat, which is what an Amiga
 * actually does and what the spec means by "tracker default tuning at A4 is
 * 439.548 Hz".
 */
export function tuningRatioOf(baseNote, freq) {
  // Spec: either field reading zero means "assume the tracker default".
  const b = baseNote > 0 ? baseNote : TUNING_DEFAULT_BASE_NOTE;
  const f = freq > 0 ? freq : TUNING_DEFAULT_FREQ_HZ; // also catches NaN
  return (f / 2 ** ((b - MIDDLE_C) / 4096.0)) / TUNING_REF_C4_HZ;
}

/** One tick of Amiga-mode pitch slide; persists period state on the voice. */
export function amigaSlideTick(voice, slideArg) {
  if (voice.amigaPeriod < 0.0) voice.amigaPeriod = noteValToAmigaPeriod(voice.noteVal);
  voice.amigaPeriod = Math.max(voice.amigaPeriod - slideArg, 1.0);
  return amigaPeriodToNoteVal(voice.amigaPeriod);
}

/** One-shot Amiga slide (fine EFx/FFx) — no persistent state mutation. */
export function amigaSlideOnce(noteVal, slideArg) {
  const period = noteValToAmigaPeriod(noteVal);
  const newPeriod = Math.max(period - slideArg, 1.0);
  return amigaPeriodToNoteVal(newPeriod);
}

/** Per-tick linear-freq slide (toneMode 2, Hz/tick). */
export function linearFreqSlideTick(voice, slideArg) {
  if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal);
  voice.linearFreq = Math.max(voice.linearFreq + slideArg, 1.0);
  return freqHzToNoteVal(voice.linearFreq);
}

/** One-shot linear-freq slide for fine E/F. */
export function linearFreqSlideOnce(noteVal, slideArg) {
  const freq = noteValToFreqHz(noteVal);
  const newFreq = Math.max(freq + slideArg, 1.0);
  return freqHzToNoteVal(newFreq);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
