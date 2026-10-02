// Lookup tables + pitch math — port of AudioAdapter.kt companion object tables
// (149-340), MOD_SIN_TABLE / FINETUNE_OFFSET (1406-1422), META_MIX_GAIN (1480),
// EffectOp (1438), lfoSample (1426), pitch conversions (1632-1690).

import {
  SAMPLING_RATE, MIDDLE_C, AMIGA_BASE_PERIOD, LINEAR_FREQ_C4_HZ,
  TUNING_REF_C4_HZ, TUNING_DEFAULT_BASE_NOTE, TUNING_DEFAULT_FREQ_HZ,
  SINC_WIDTH, SINC_PRECISION, onSamplingRateChange,
} from "./constants.js";
import { random } from "./rng.js";

// ── Fast Sinc: 6-tap windowed sinc, 1024 sub-sample positions (251-273) ──
export const SINC_TABLE = (() => {
  const n = SINC_PRECISION * SINC_WIDTH;
  const out = new Float64Array(n);
  const winFreq = Math.PI / SINC_WIDTH / SINC_PRECISION;
  out[0] = 1.0;
  for (let i = 1; i < n; i++) {
    const t = (i * Math.PI) / SINC_PRECISION;
    const win = 0.5 + 0.5 * Math.cos(winFreq * i);
    out[i] = (Math.sin(t) / t) * win;
  }
  return out;
})();

/** Windowed-sinc kernel value for fractional offset frac ∈ [0,1) and signed tap. */
export function sincTap(frac, tap) {
  const x = (tap - frac) * SINC_PRECISION;
  const ax = Math.abs(x);
  const idx = Math.trunc(ax);
  if (idx >= SINC_PRECISION * SINC_WIDTH - 1) return 0.0;
  const f = ax - idx;
  return SINC_TABLE[idx] * (1.0 - f) + SINC_TABLE[idx + 1] * f;
}

// ── SNES BRR 4-tap gaussian table (512 entries; AudioAdapter.kt:283-316) ──
// The quad {gauss[i], gauss[0xff-i], gauss[0x100+i], gauss[0x1ff-i]} is meant to
// sum to 0x800 but the ROM is slightly bugged and lands on 0x7ff..0x801 (0x7ff at
// 42 phases, 0x800 at 168, 0x801 at 46). The 0x801 phases are the ones that can
// overrun int16 on rail-level input, and the DSP lets that partial sum WRAP —
// the famous "SNES gauss overflow chirp". See sampler.js INTERP_SNES.
export const SNES_GAUSS = Int32Array.from([
  0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
  0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
  0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
  0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00a, 0x00a, 0x00a,
  0x00b, 0x00b, 0x00b, 0x00c, 0x00c, 0x00d, 0x00d, 0x00e, 0x00e, 0x00f, 0x00f, 0x00f, 0x010, 0x010, 0x011, 0x011,
  0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01a, 0x01b, 0x01b,
  0x01c, 0x01d, 0x01d, 0x01e, 0x01f, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
  0x029, 0x02a, 0x02b, 0x02c, 0x02d, 0x02e, 0x02f, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
  0x03a, 0x03b, 0x03c, 0x03d, 0x03e, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04a, 0x04c, 0x04d,
  0x04e, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05a, 0x05c, 0x05e, 0x05f, 0x061, 0x063, 0x064, 0x066,
  0x068, 0x06a, 0x06b, 0x06d, 0x06f, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07a, 0x07c, 0x07e, 0x080, 0x082, 0x084,
  0x086, 0x089, 0x08b, 0x08d, 0x08f, 0x091, 0x093, 0x096, 0x098, 0x09a, 0x09c, 0x09f, 0x0a1, 0x0a3, 0x0a6, 0x0a8,
  0x0ab, 0x0ad, 0x0af, 0x0b2, 0x0b4, 0x0b7, 0x0ba, 0x0bc, 0x0bf, 0x0c1, 0x0c4, 0x0c7, 0x0c9, 0x0cc, 0x0cf, 0x0d2,
  0x0d4, 0x0d7, 0x0da, 0x0dd, 0x0e0, 0x0e3, 0x0e6, 0x0e9, 0x0ec, 0x0ef, 0x0f2, 0x0f5, 0x0f8, 0x0fb, 0x0fe, 0x101,
  0x104, 0x107, 0x10b, 0x10e, 0x111, 0x114, 0x118, 0x11b, 0x11e, 0x122, 0x125, 0x129, 0x12c, 0x130, 0x133, 0x137,
  0x13a, 0x13e, 0x141, 0x145, 0x148, 0x14c, 0x150, 0x153, 0x157, 0x15b, 0x15f, 0x162, 0x166, 0x16a, 0x16e, 0x172,
  0x176, 0x17a, 0x17d, 0x181, 0x185, 0x189, 0x18d, 0x191, 0x195, 0x19a, 0x19e, 0x1a2, 0x1a6, 0x1aa, 0x1ae, 0x1b2,
  0x1b7, 0x1bb, 0x1bf, 0x1c3, 0x1c8, 0x1cc, 0x1d0, 0x1d5, 0x1d9, 0x1dd, 0x1e2, 0x1e6, 0x1eb, 0x1ef, 0x1f3, 0x1f8,
  0x1fc, 0x201, 0x205, 0x20a, 0x20f, 0x213, 0x218, 0x21c, 0x221, 0x226, 0x22a, 0x22f, 0x233, 0x238, 0x23d, 0x241,
  0x246, 0x24b, 0x250, 0x254, 0x259, 0x25e, 0x263, 0x267, 0x26c, 0x271, 0x276, 0x27b, 0x280, 0x284, 0x289, 0x28e,
  0x293, 0x298, 0x29d, 0x2a2, 0x2a6, 0x2ab, 0x2b0, 0x2b5, 0x2ba, 0x2bf, 0x2c4, 0x2c9, 0x2ce, 0x2d3, 0x2d8, 0x2dc,
  0x2e1, 0x2e6, 0x2eb, 0x2f0, 0x2f5, 0x2fa, 0x2ff, 0x304, 0x309, 0x30e, 0x313, 0x318, 0x31d, 0x322, 0x326, 0x32b,
  0x330, 0x335, 0x33a, 0x33f, 0x344, 0x349, 0x34e, 0x353, 0x357, 0x35c, 0x361, 0x366, 0x36b, 0x370, 0x374, 0x379,
  0x37e, 0x383, 0x388, 0x38c, 0x391, 0x396, 0x39b, 0x39f, 0x3a4, 0x3a9, 0x3ad, 0x3b2, 0x3b7, 0x3bb, 0x3c0, 0x3c5,
  0x3c9, 0x3ce, 0x3d2, 0x3d7, 0x3dc, 0x3e0, 0x3e5, 0x3e9, 0x3ed, 0x3f2, 0x3f6, 0x3fb, 0x3ff, 0x403, 0x408, 0x40c,
  0x410, 0x415, 0x419, 0x41d, 0x421, 0x425, 0x42a, 0x42e, 0x432, 0x436, 0x43a, 0x43e, 0x442, 0x446, 0x44a, 0x44e,
  0x452, 0x455, 0x459, 0x45d, 0x461, 0x465, 0x468, 0x46c, 0x470, 0x473, 0x477, 0x47a, 0x47e, 0x481, 0x485, 0x488,
  0x48c, 0x48f, 0x492, 0x496, 0x499, 0x49c, 0x49f, 0x4a2, 0x4a6, 0x4a9, 0x4ac, 0x4af, 0x4b2, 0x4b5, 0x4b7, 0x4ba,
  0x4bd, 0x4c0, 0x4c3, 0x4c5, 0x4c8, 0x4cb, 0x4cd, 0x4d0, 0x4d2, 0x4d5, 0x4d7, 0x4d9, 0x4dc, 0x4de, 0x4e0, 0x4e3,
  0x4e5, 0x4e7, 0x4e9, 0x4eb, 0x4ed, 0x4ef, 0x4f1, 0x4f3, 0x4f5, 0x4f6, 0x4f8, 0x4fa, 0x4fb, 0x4fd, 0x4ff, 0x500,
  0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50a, 0x50b, 0x50c, 0x50d, 0x50e, 0x50f, 0x510, 0x511, 0x511, 0x512,
  0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519,
]);

// ── Amiga filter coefficients (AudioAdapter.kt:318-339) ──
// Kotlin precomputes these at its fixed 32 kHz; the web engine's rate is
// settable (item 108), so they are recomputed whenever it moves — the cutoffs
// below are the physical RC/Sallen-Key corner frequencies of the real hardware
// and must land on the same Hz at any output rate.
const AMIGA_A500_LP_FC = 4420.971;
const AMIGA_LED_FC = 3090.533;
const AMIGA_LED_Q = 0.660225;

export let AMIGA_A500_B1, AMIGA_A500_A0;
export let AMIGA_LED_A1, AMIGA_LED_A2, AMIGA_LED_B1, AMIGA_LED_B2;

function rebuildAmigaCoeffs(rate) {
  AMIGA_A500_B1 = Math.exp((-2.0 * Math.PI * AMIGA_A500_LP_FC) / rate);
  AMIGA_A500_A0 = 1.0 - AMIGA_A500_B1;

  const aBase = 1.0 / Math.tan((Math.PI * AMIGA_LED_FC) / rate);
  const bBase = 1.0 / AMIGA_LED_Q;
  AMIGA_LED_A1 = 1.0 / (1.0 + bBase * aBase + aBase * aBase);
  AMIGA_LED_A2 = 2.0 * AMIGA_LED_A1;
  AMIGA_LED_B1 = 2.0 * (1.0 - aBase * aBase) * AMIGA_LED_A1;
  AMIGA_LED_B2 = (1.0 - bBase * aBase + aBase * aBase) * AMIGA_LED_A1;
}
rebuildAmigaCoeffs(SAMPLING_RATE);
onSamplingRateChange(rebuildAmigaCoeffs);

// ── 64-entry signed sine table (OpenMPT-style; 1407) ──
export const MOD_SIN_TABLE = Int32Array.from([
  0x00, 0x0c, 0x19, 0x25, 0x31, 0x3c, 0x47, 0x51,
  0x5a, 0x62, 0x6a, 0x70, 0x75, 0x7a, 0x7d, 0x7e,
  0x7f, 0x7e, 0x7d, 0x7a, 0x75, 0x70, 0x6a, 0x62,
  0x5a, 0x51, 0x47, 0x3c, 0x31, 0x25, 0x19, 0x0c,
  0x00, -0x0c, -0x19, -0x25, -0x31, -0x3c, -0x47, -0x51,
  -0x5a, -0x62, -0x6a, -0x70, -0x75, -0x7a, -0x7d, -0x7e,
  -0x7f, -0x7e, -0x7d, -0x7a, -0x75, -0x70, -0x6a, -0x62,
  -0x5a, -0x51, -0x47, -0x3c, -0x31, -0x25, -0x19, -0x0c,
]);

// ── ST3-style fine-tune offsets in 4096-TET units (S $2x00; 1419) ──
export const FINETUNE_OFFSET = Int32Array.from([
  -0x0154, -0x0132, -0x0111, -0x00e4, -0x00b8, -0x008b, -0x005d, -0x003b,
  0x0000, 0x0023, 0x0046, 0x0074, 0x0098, 0x00c8, 0x00f9, 0x0110,
]);

// ── The command LFOs' phase (H, U, R, Y) ────────────────────────────────
// 64 table entries × 17 steps each. The 17 is not arbitrary and the total is
// deliberately not a power of two: every 4-bit tracker field converts into
// Taud by NIBBLE-REPEAT, which multiplies by 17, so a phase whose step count
// carries that same factor makes a converted speed byte reproduce the source
// tracker's oscillator EXACTLY rather than approximately.
//
// A tracker advances an 8-bit phase by `speed × 4` and indexes `(pos >> 2) &
// 63`, giving index `x·t mod 64` at tick t. Here a converted byte `17x`
// advances by `17x` through 1088 and indexes `pos / 17`, giving
// `(17·x·t mod 1088) / 17` = `x·t mod 64` — the same index, every tick,
// forever. A power-of-two 1024 would have been 17/16 = 6.25% fast instead.
//
// Both are once per voice per TICK, never per sample, so the division and the
// modulo cost nothing worth a power-of-two compromise.
export const LFO_PHASE_STEPS = 1088;
const LFO_STEPS_PER_ENTRY = 17;

/** Advance a command LFO's phase by its speed byte. */
export function advanceLfoPhase(pos, speed) {
  return (pos + speed) % LFO_PHASE_STEPS;
}

// ── Auto-vibrato's phase (the instrument record's own LFO) ───────────────
// 1024 steps advanced by the speed byte, indexed ⌊phase ÷ 16⌋. The source
// trackers run a 256-step phase advanced by their 0…64 speed field and index
// `(phase >> 2) & 63`, so a full cycle is `256 ÷ speed` ticks; a record byte
// is that field × 4 (IT `Vis` 0…64 → 0…255), and 4× the phase length keeps
// `(4·speed·t mod 1024) >> 4` = `(speed·t mod 256) >> 2` — the same table
// entry on the same tick, exactly.
//
// A 256-step phase advanced by `speed × 2` (what this was) could not carry
// the widened byte at all: every multiple of 64 stepped only between table
// entries 0 and 32, which are both zero, so the most ordinary IT speeds
// (`Vis` 16 and 32 → bytes 64 and 128) played no vibrato whatsoever.
export const AUTOVIB_PHASE_STEPS = 1024;

// Auto-vibrato depth calibration. IT plays `Vid` 64 — its maximum — as ±1
// semitone (openmpt123 measures ±99.6 cents; `Vid` 32 → ±51.6, `Vid` 15 →
// ±25.6, i.e. linear), and a record byte is `Vid × 4`, so byte 255 has to
// reach 4096÷12 = 341 units of 4096-TET. `(lfo × depth × 43) >> 12` lands on
// 340 with the ±127 LFO. The old `>> 10` reached 31 — a tenth of IT's
// deepest wobble at the record's own maximum.
export const AUTOVIB_DEPTH_MUL = 43;
export const AUTOVIB_DEPTH_SHIFT = 12;

/** Sample a command LFO's 1088-step phase (H, U, R, Y). */
export function lfoSampleWide(pos, wave) {
  // `idx << 2` re-enters lfoSample at the position its own `>> 2` undoes, so
  // the two phase scales share one waveform switch (and one random draw).
  return lfoSample(Math.trunc(pos / LFO_STEPS_PER_ENTRY) << 2, wave);
}

/** LFO sample; `pos` indexes `(pos >> 2) & 63` (see the two callers' scales). */

export function lfoSample(pos, wave) {
  const idx = (pos >>> 2) & 0x3f;
  switch (wave & 3) {
    case 0: return MOD_SIN_TABLE[idx];                       // sine
    case 1: return 0x7f - (idx << 2);                        // ramp down
    case 2: return idx < 32 ? 0x7f : -0x7f;                  // square
    default: return (Math.trunc(random() * 256) & 0xff) - 0x80; // random
  }
}

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

/** Which opcodes read `:`'s argument when paired with it (effects.js's `ext`
 *  parameter) — J, O and the sample-mod pair. Shared with the UI so the
 *  pattern grid's "this pairing needs a second look" highlight (see
 *  glyphs.js paintFxCell) agrees with what the engine actually does. */
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
