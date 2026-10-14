// OPL instruments — Metainstrument type 8 (item 209). The chip in place of a sample.
//
// A type-8 instrument is an ORDINARY instrument record — envelopes, fadeout,
// New Note Action, Duplicate Check, default volume and pan, auto-vibrato, the
// one pitch/filter envelope it keeps — whose sample is replaced by a patch for
// a YM3812 / YMF262 channel: two operators, four, or one of the five rhythm-
// mode drums (TAUD_FILE_FORMAT.md §7.7). This module is that channel, one per
// sounding voice.
//
// The operator model is the IMS Archive's clean-room OPL core (iyagimusic-js
// src/opl/, written from Yamaha's YM3812 Application Manual and the published
// die description — see its docs/OPL2_NOTES.en.md), carried over number for
// number so a song converted from an .ims or a .sop sounds the way the IMS
// Archive's own player plays it, bit for bit. Two readings follow the silicon
// where the reference's source, the manual, says otherwise — and where the
// reference itself did until 2026-10-14, when it took the same two:
//
//  - the key-scale-RATE split (register 0x08's NOTE SEL). The manual's figure
//    says NTS 0 splits on the F-number's SECOND bit; the chip splits on its
//    MSB, which is what every hardware-verified emulator does (Nuked OPL3's
//    `ksv`, MAME's "opposite to what is stated in the Manuals (verified on
//    real YM3812)"). Only an operator with KSR set can tell the two apart.
//  - the key-scale LEVEL of settings 1 and 2. The chip computes the level in
//    0.1875 dB envelope units and then halves or quarters it (Nuked OPL3's
//    `eg_ksl >> kslshift`, OpenMPT's Opal alike); halving it in 0.75 dB units
//    first, as the reference once did, drops up to 0.56 dB.
//
// What it does NOT share with that core is the clock arrangement. The chip
// there is one object holding eighteen channels; here every voice is its own
// channel, so the three things a real chip shares between its channels —
// the envelope counter, the tremolo/vibrato LFO, and the sample grid itself —
// come from ONE chip clock per playhead (`ts.oplFrame`). Every voice reads the
// same counter at the same output frame, so a chord's tremolo moves together
// and its envelopes step on the same samples, exactly as on one chip. Each
// voice runs the chip's own math at the chip's own 49716 Hz and is read back
// at the engine's rate by linear interpolation between its last two chip
// samples — the IMS Archive player's resampler, applied per voice. On a shared
// chip grid, interpolating each voice and summing equals summing and then
// interpolating, so the mix is the same as one chip resampled once.
//
// Everything here is plain computation over integers and IEEE doubles. The
// two transcendental tables are integer constants, not computed: the engine's
// conformance bar is bit-for-bit across implementations (spec §13), and
// `round(log2(sin x))` evaluated on another platform is not something to bet a
// digest on. `2 ** rational` is the one transcendental the spec allows
// (§3.3), and it is the only one used.

import { SAMPLING_RATE, LINEAR_FREQ_C4_HZ } from "./constants.js";

// ── The chip's clock ──────────────────────────────────────────────────────

/** Crystal on an AdLib / Sound Blaster card. */
export const OPL_CLOCK_HZ = 3579545;
/** One output sample is 72 master clocks: 49716.05 Hz. */
export const OPL_CLOCKS_PER_SAMPLE = 72;
export const OPL_RATE = OPL_CLOCK_HZ / OPL_CLOCKS_PER_SAMPLE;

/**
 * The OPL instrument's "sampling rate" is the C2SPD of an S3M AdLib instrument and
 * the C5Speed of an OpenMPT OPL sample: the rate at which the note sounds
 * middle C. 8363 is the tracker convention, and at it an OPL instrument at note
 * $5000 sounds concert C4, 261.63 Hz — OpenMPT's own mapping (Sndmix.cpp:
 * "a sample rate of 8363 Hz is mapped to middle-C"). A record whose field is 0
 * plays at 8363.
 */
export const OPL_C4_RATE = 8363;
const HZ_PER_SPS = LINEAR_FREQ_C4_HZ / OPL_C4_RATE;

// ── The record ────────────────────────────────────────────────────────────
// The patch occupies what an ordinary record spends on its SECOND pitch/
// filter envelope slot, bytes 197…250 (§7.7). Offsets below are relative to
// OPL_BLOCK_START.

export const OPL_BLOCK_START = 197;
export const OPL_BLOCK_LEN = 54;
/** kind (bits 0-2) and the chip-wide switches the patch was voiced against. */
export const OPL_B_KIND = 0;
/** Register 0xC0 of the first channel: feedback bits 1-3, connection bit 0. */
export const OPL_B_C0A = 1;
/** …and of the second, for a four-operator patch. */
export const OPL_B_C0B = 2;
/** A rhythm drum's partner operator's multiplier (bits 0-3). */
export const OPL_B_PARTNER_MULT = 3;
/** A rhythm drum's partner channel pitch, S16 4096-TET from its own. */
export const OPL_B_PARTNER_DETUNE = 4;
/** Four operators × five register images: 0x20, 0x40, 0x60, 0x80, 0xE0. */
export const OPL_B_OPS = 6;
export const OPL_OP_BYTES = 5;

export const OPL_KIND_2OP = 0;
export const OPL_KIND_4OP = 1;
export const OPL_KIND_BD = 2;
export const OPL_KIND_SD = 3;
export const OPL_KIND_TOM = 4;
export const OPL_KIND_TC = 5;
export const OPL_KIND_HH = 6;
export const OPL_KIND_MASK = 0x07;
/** Register 0xBD bit 7: tremolo 4.8 dB rather than 1 dB. */
export const OPL_FLAG_DEEP_TREMOLO = 0x08;
/** Register 0xBD bit 6: vibrato 14 cents rather than 7. */
export const OPL_FLAG_DEEP_VIBRATO = 0x10;
/** Register 0x08 bit 6, NOTE SEL: which F-number bit the key-scale rate reads. */
export const OPL_FLAG_NTS = 0x20;
/** Note's F-number range (SOP): a block holds 343…685 rather than 512…1023. */
export const OPL_FLAG_LOW_FNUM = 0x40;

/** How many operators each kind plays: the patch's operators 1…n. */
export const OPL_KIND_OPERATORS = Object.freeze([2, 4, 2, 1, 1, 1, 1, 0]);

// ── Tables ────────────────────────────────────────────────────────────────
// LOG_SIN[i] = round(−log2(sin((i + ½)·π/512)) · 256) and
// EXP[i] = round((2^(i/256) − 1) · 1024): the chip's quarter-sine in the log
// domain and the antilog that undoes it, in 1/256 of a power of two. Stated
// as constants (see the head of this file); test/node/opl.test.js recomputes
// both from the formulas, and every entry sits at least 0.0003 from a rounding
// edge, so the formula and the table cannot disagree anywhere it matters.

const LOG_SIN = Uint16Array.from([
  2137, 1731, 1543, 1419, 1326, 1252, 1190, 1137, 1091, 1050, 1013, 979, 949, 920, 894, 869,
  846, 825, 804, 785, 767, 749, 732, 717, 701, 687, 672, 659, 646, 633, 621, 609,
  598, 587, 576, 566, 556, 546, 536, 527, 518, 509, 501, 492, 484, 476, 468, 461,
  453, 446, 439, 432, 425, 418, 411, 405, 399, 392, 386, 380, 375, 369, 363, 358,
  352, 347, 341, 336, 331, 326, 321, 316, 311, 307, 302, 297, 293, 289, 284, 280,
  276, 271, 267, 263, 259, 255, 251, 248, 244, 240, 236, 233, 229, 226, 222, 219,
  215, 212, 209, 205, 202, 199, 196, 193, 190, 187, 184, 181, 178, 175, 172, 169,
  167, 164, 161, 159, 156, 153, 151, 148, 146, 143, 141, 138, 136, 134, 131, 129,
  127, 125, 122, 120, 118, 116, 114, 112, 110, 108, 106, 104, 102, 100, 98, 96,
  94, 92, 91, 89, 87, 85, 83, 82, 80, 78, 77, 75, 74, 72, 70, 69,
  67, 66, 64, 63, 62, 60, 59, 57, 56, 55, 53, 52, 51, 49, 48, 47,
  46, 45, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30,
  29, 28, 27, 26, 25, 24, 23, 23, 22, 21, 20, 20, 19, 18, 17, 17,
  16, 15, 15, 14, 13, 13, 12, 12, 11, 10, 10, 9, 9, 8, 8, 7,
  7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2,
  2, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const EXP = Uint16Array.from([
  0, 3, 6, 8, 11, 14, 17, 20, 22, 25, 28, 31, 34, 37, 40, 42,
  45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90,
  93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 130, 133, 136, 139,
  142, 145, 148, 152, 155, 158, 161, 164, 168, 171, 174, 177, 181, 184, 187, 190,
  194, 197, 200, 204, 207, 210, 214, 217, 220, 224, 227, 231, 234, 237, 241, 244,
  248, 251, 255, 258, 262, 265, 268, 272, 276, 279, 283, 286, 290, 293, 297, 300,
  304, 308, 311, 315, 318, 322, 326, 329, 333, 337, 340, 344, 348, 352, 355, 359,
  363, 367, 370, 374, 378, 382, 385, 389, 393, 397, 401, 405, 409, 412, 416, 420,
  424, 428, 432, 436, 440, 444, 448, 452, 456, 460, 464, 468, 472, 476, 480, 484,
  488, 492, 496, 501, 505, 509, 513, 517, 521, 526, 530, 534, 538, 542, 547, 551,
  555, 560, 564, 568, 572, 577, 581, 585, 590, 594, 599, 603, 607, 612, 616, 621,
  625, 630, 634, 639, 643, 648, 652, 657, 661, 666, 670, 675, 680, 684, 689, 693,
  698, 703, 708, 712, 717, 722, 726, 731, 736, 741, 745, 750, 755, 760, 765, 770,
  774, 779, 784, 789, 794, 799, 804, 809, 814, 819, 824, 829, 834, 839, 844, 849,
  854, 859, 864, 869, 874, 880, 885, 890, 895, 900, 906, 911, 916, 921, 927, 932,
  937, 942, 948, 953, 959, 964, 969, 975, 980, 986, 991, 996, 1002, 1007, 1013, 1018,
]);

export const OPL_LOG_SIN = LOG_SIN;
export const OPL_EXP = EXP;

/**
 * Total attenuation (1/256-log2 units) to a signed-magnitude amplitude, as the
 * chip does it: the table plus its implicit leading bit spans 1024…2047, one
 * more bit below the sign makes full scale ±4084, and past −96 dB the chip
 * gives up. `att` may carry a fraction (the tremolo is not stepped here); the
 * bit operations truncate it exactly as the reference core does.
 */
export function oplExpand(att) {
  if (att >= 0x1800) return 0;
  return ((EXP[255 - (att & 0xff)] + 1024) << 1) >> (att >> 8);
}

/** A rhythm voice reaches the chip's accumulator twice (OPL2_NOTES "Fixed
 *  after measuring"), so the five drums sit 6 dB above a melodic operator. */
export const OPL_RHYTHM_MIX = 2;
/** Operator output to the engine's ±1: a full-scale operator is one full-scale
 *  sample, which is where opl2taud's racks always put it too. */
const OUTPUT_SCALE = 1 / 4096;

/** Envelope phases. */
export const EG_OFF = 0;
export const EG_ATTACK = 1;
export const EG_DECAY = 2;
export const EG_SUSTAIN = 3;
export const EG_RELEASE = 4;
export const OPL_ENV_MAX = 511;
const ENV_TO_LOG = 8;
const TL_TO_LOG = 32;
const SILENCE = 0x1000;

/** Key-scale level ROM, 0.75 dB units by the F-number's top four bits. */
const KSL_ROM = Int32Array.from([0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54, 55, 56]);
/** How far each KSL setting shifts that down: 1 is 3.0 dB/oct and 2 is 1.5. */
const KSL_SHIFT = Int32Array.from([-1, 1, 2, 0]);
/** MULT, doubled so ×0.5 stays an integer. */
export const OPL_MULTIPLE_X2 = Int32Array.from([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
/** Sustain level in envelope steps: 3 dB a step, and 15 is −93 dB. */
const SUSTAIN_LEVEL = Int32Array.from([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 496]);
/** Envelope rate duty patterns (RL = 0…3 takes 4, 5, 6 or 7 steps of 8). */
const EG_DUTY = [
  Int32Array.from([1, 0, 1, 0, 1, 0, 1, 0]),
  Int32Array.from([1, 0, 1, 0, 1, 0, 1, 1]),
  Int32Array.from([1, 0, 1, 1, 1, 0, 1, 1]),
  Int32Array.from([1, 0, 1, 1, 1, 1, 1, 1]),
];

// ── LFOs ──────────────────────────────────────────────────────────────────
// Both are free-running triangles shared by every operator that opts in, and
// both are pure functions of the chip clock, so they are tabled over one period
// rather than evaluated per sample. The values are computed with exactly the
// reference core's expression order, which keeps them bit-identical to it.

const VIBRATO_PERIOD = 8192;     // ≈ 6.07 Hz
const TREMOLO_PERIOD = 13440;    // ≈ 3.70 Hz
const VIBRATO_CENTS = [7, 14];
const TREMOLO_STEPS = [Math.round(1.0 / 0.1875), Math.round(4.8 / 0.1875)];

function triangle(p, period) {
  const half = period >> 1;
  return p < half ? p / half : 2 - p / half;
}

/** [depth] → per-sample attenuation to add, in 1/256-log2 units. */
const TREMOLO_TABLE = [0, 1].map((d) => {
  const t = new Float64Array(TREMOLO_PERIOD);
  for (let p = 0; p < TREMOLO_PERIOD; p++) t[p] = TREMOLO_STEPS[d] * ENV_TO_LOG * triangle(p, TREMOLO_PERIOD);
  return t;
});
/** [depth] → per-sample phase-increment multiplier. */
const VIBRATO_TABLE = [0, 1].map((d) => {
  const t = new Float64Array(VIBRATO_PERIOD);
  for (let p = 0; p < VIBRATO_PERIOD; p++) {
    const cents = VIBRATO_CENTS[d] * (2 * triangle(p, VIBRATO_PERIOD) - 1);
    t[p] = cents === 0 ? 1 : 2 ** (cents / 1200);
  }
  return t;
});

// ── Waveforms ─────────────────────────────────────────────────────────────
// A 10-bit phase to a log-domain attenuation, with the sign left in
// `waveSign`. Shapes 0…3 are the YM3812's, 4…7 the YMF262's four additions —
// every one the same quarter sine read differently, and 7 the logarithmic saw
// whose slope is the chip's whole 96 dB across each half cycle.

let waveSign = 1;

function waveform(shape, phase) {
  const quarter = phase & 0xff;
  const mirrored = (phase & 0x100) !== 0 ? 255 - quarter : quarter;
  const negative = (phase & 0x200) !== 0;
  switch (shape) {
    case 0:
      waveSign = negative ? -1 : 1;
      return LOG_SIN[mirrored];
    case 1:
      waveSign = 1;
      return negative ? SILENCE : LOG_SIN[mirrored];
    case 2:
      waveSign = 1;
      return LOG_SIN[mirrored];
    case 3:
      waveSign = 1;
      return (phase & 0x100) !== 0 ? SILENCE : LOG_SIN[quarter];
    case 4: {
      waveSign = 1;
      if (negative) return SILENCE;
      const p = (phase << 1) & 0x3ff;
      const q = p & 0xff;
      waveSign = (p & 0x200) !== 0 ? -1 : 1;
      return LOG_SIN[(p & 0x100) !== 0 ? 255 - q : q];
    }
    case 5: {
      waveSign = 1;
      if (negative) return SILENCE;
      const p = (phase << 1) & 0x1ff;
      const q = p & 0xff;
      return LOG_SIN[(p & 0x100) !== 0 ? 255 - q : q];
    }
    case 6:
      waveSign = negative ? -1 : 1;
      return 0;
    default: {
      waveSign = negative ? -1 : 1;
      const ramp = phase & 0x1ff;
      return (negative ? 0x1ff - ramp : ramp) << 3;
    }
  }
}

// ── The patch ─────────────────────────────────────────────────────────────

/** One operator's five registers, unpacked. */
export class OplOperator {
  constructor() {
    this.am = 0; this.vib = 0; this.eg = 0; this.ksr = 0; this.mult = 0;
    this.ksl = 0; this.tl = 0;
    this.ar = 0; this.dr = 0;
    this.sl = 0; this.rr = 0;
    this.ws = 0;
  }
}

/**
 * A decoded type-8 patch. Decoded IN PLACE by decodeOplPatch, so a voice
 * sounding the instrument hears an edit the moment it lands — the chip's own
 * behaviour when a driver rewrites a sounding channel's registers. `gen`
 * counts the decodes, which is how a voice knows its frequency-derived
 * per-operator values (KSL, KSR, increment) are stale.
 */
export class OplPatch {
  constructor() {
    this.gen = 0;
    this.kind = OPL_KIND_2OP;
    this.deepTremolo = false;
    this.deepVibrato = false;
    this.nts = false;
    this.lowFnum = false;
    this.feedback = 0;        // channel A's — the only feedback the chip applies
    this.cntA = 0;            // 1 = additive
    this.cntB = 0;
    this.partnerMult = 0;
    this.partnerDetune = 0;
    this.ops = [new OplOperator(), new OplOperator(), new OplOperator(), new OplOperator()];
    /** Bit n set = operator n reaches the output (and takes the note volume). */
    this.outputs = 0;
  }
}

/** Unpack the 54-byte block (`bytes[at…]`) into `into`. */
export function decodeOplPatch(bytes, at = 0, into = new OplPatch()) {
  const kindByte = bytes[at + OPL_B_KIND] & 0xff;
  into.kind = kindByte & OPL_KIND_MASK;
  into.deepTremolo = (kindByte & OPL_FLAG_DEEP_TREMOLO) !== 0;
  into.deepVibrato = (kindByte & OPL_FLAG_DEEP_VIBRATO) !== 0;
  into.nts = (kindByte & OPL_FLAG_NTS) !== 0;
  into.lowFnum = (kindByte & OPL_FLAG_LOW_FNUM) !== 0;
  const c0a = bytes[at + OPL_B_C0A] & 0xff;
  const c0b = bytes[at + OPL_B_C0B] & 0xff;
  into.feedback = (c0a >> 1) & 7;
  into.cntA = c0a & 1;
  into.cntB = c0b & 1;
  into.partnerMult = bytes[at + OPL_B_PARTNER_MULT] & 0x0f;
  const pd = (bytes[at + OPL_B_PARTNER_DETUNE] & 0xff) | ((bytes[at + OPL_B_PARTNER_DETUNE + 1] & 0xff) << 8);
  into.partnerDetune = pd >= 0x8000 ? pd - 0x10000 : pd;
  for (let i = 0; i < 4; i++) {
    const o = at + OPL_B_OPS + i * OPL_OP_BYTES;
    const op = into.ops[i];
    const r20 = bytes[o] & 0xff, r40 = bytes[o + 1] & 0xff;
    const r60 = bytes[o + 2] & 0xff, r80 = bytes[o + 3] & 0xff, rE0 = bytes[o + 4] & 0xff;
    op.am = (r20 >> 7) & 1; op.vib = (r20 >> 6) & 1; op.eg = (r20 >> 5) & 1;
    op.ksr = (r20 >> 4) & 1; op.mult = r20 & 0x0f;
    op.ksl = (r40 >> 6) & 3; op.tl = r40 & 0x3f;
    op.ar = (r60 >> 4) & 0x0f; op.dr = r60 & 0x0f;
    op.sl = SUSTAIN_LEVEL[(r80 >> 4) & 0x0f]; op.rr = r80 & 0x0f;
    op.ws = rE0 & 7;
  }
  into.outputs = oplOutputMask(into.kind, into.cntA, into.cntB);
  into.gen++;
  return into;
}

/**
 * Pack a patch description into the 54-byte block — decodeOplPatch's inverse.
 * `ops` are register-shaped operators {am, vib, eg, ksr, mult, ksl, tl, ar,
 * dr, sl (the 4-bit FIELD, not the level), rr, ws}; missing ones are zero.
 */
export function encodeOplPatch({
  kind = OPL_KIND_2OP, deepTremolo = false, deepVibrato = false, nts = false,
  lowFnum = false, feedback = 0, cntA = 0, cntB = 0,
  partnerMult = 0, partnerDetune = 0, ops = [],
} = {}) {
  const b = new Uint8Array(OPL_BLOCK_LEN);
  b[OPL_B_KIND] = (kind & OPL_KIND_MASK) | (deepTremolo ? OPL_FLAG_DEEP_TREMOLO : 0) |
    (deepVibrato ? OPL_FLAG_DEEP_VIBRATO : 0) | (nts ? OPL_FLAG_NTS : 0) |
    (lowFnum ? OPL_FLAG_LOW_FNUM : 0);
  b[OPL_B_C0A] = ((feedback & 7) << 1) | (cntA & 1);
  b[OPL_B_C0B] = cntB & 1;
  b[OPL_B_PARTNER_MULT] = partnerMult & 0x0f;
  const pd = partnerDetune & 0xffff;
  b[OPL_B_PARTNER_DETUNE] = pd & 0xff;
  b[OPL_B_PARTNER_DETUNE + 1] = (pd >>> 8) & 0xff;
  for (let i = 0; i < 4; i++) {
    const op = ops[i];
    if (!op) continue;
    const o = OPL_B_OPS + i * OPL_OP_BYTES;
    b[o] = ((op.am & 1) << 7) | ((op.vib & 1) << 6) | ((op.eg & 1) << 5) |
      ((op.ksr & 1) << 4) | (op.mult & 0x0f);
    b[o + 1] = ((op.ksl & 3) << 6) | (op.tl & 0x3f);
    b[o + 2] = ((op.ar & 0x0f) << 4) | (op.dr & 0x0f);
    b[o + 3] = ((op.sl & 0x0f) << 4) | (op.rr & 0x0f);
    b[o + 4] = op.ws & 7;
  }
  return b;
}

/**
 * Which operators reach the output — the ones a driver scales by channel
 * volume (ENGINE_SPEC §4, §10 of the IMS library), and the ones the note
 * volume reaches here. A melodic pair: the carrier, and the modulator too when
 * additive. Four operators: the reading of each half's CNT bit as "this half's
 * first operator goes straight out", plus operator 4 always. A rhythm drum:
 * its one operator, or the bass drum's carrier (and modulator when additive).
 */
export function oplOutputMask(kind, cntA, cntB) {
  switch (kind) {
    case OPL_KIND_2OP: case OPL_KIND_BD: return cntA ? 0b11 : 0b10;
    case OPL_KIND_4OP: return 0b1000 | (cntA ? 0b0001 : 0) | (cntB ? 0b0100 : 0);
    case OPL_KIND_SD: case OPL_KIND_TOM: case OPL_KIND_TC: case OPL_KIND_HH: return 0b1;
    default: return 0;
  }
}

// ── Frequency ─────────────────────────────────────────────────────────────

/**
 * The block and F-number a driver would write for `hz`: the lowest block whose
 * F-number fits under the ceiling, rounded to the nearest. The ordinary
 * ceiling is the register's own 1024, which is both the AdLib driver's table
 * (its 0xFE entries are exactly this rule) and OpenMPT's (OPL::Frequency);
 * Note's driver starts every block at C instead, at F-number 343, so its
 * ceiling is 686. Returns `block << 10 | fnum`, the 0xB0/0xA0 pair's layout.
 */
export function oplBlockFnum(hz, lowFnum) {
  const x = (hz * 1048576) / OPL_RATE;
  const ceiling = lowFnum ? 686 : 1024;
  for (let b = 0; b < 8; b++) {
    const f = Math.round(x / (1 << b));
    if (f < ceiling) return (b << 10) | f;
  }
  return (7 << 10) | 1023;
}

// ── The voice ─────────────────────────────────────────────────────────────

/**
 * One sounding OPL channel, hung off a Voice as `voice.opl`. Allocated per
 * note — or carried across a retrigger, which is the chip's own behaviour: a
 * key-on restarts the attack from wherever the envelope stands.
 */
export class OplState {
  constructor() {
    this.patch = null;
    this.gen = -1;               // the patch decode the derived values below belong to
    this.rate = -1;              // the playback rate they were computed for
    this.phase = new Uint32Array(4);
    this.inc = new Int32Array(4);
    this.env = new Int32Array(4).fill(OPL_ENV_MAX);
    this.state = new Uint8Array(4);
    this.out = new Int32Array(4);
    this.prev = new Int32Array(4);
    this.kslAtt = new Int32Array(4);
    this.ksrOffset = new Int32Array(4);
    // The rhythm drums' two dictated accumulators: the hi-hat operator's
    // (channel 7's modulator) and the top cymbal's (channel 8's carrier).
    this.hhPhase = 0;
    this.tcPhase = 0;
    this.hhInc = 0;
    this.tcInc = 0;
    this.noise = 1;
    this.keyed = false;
    // The chip clock: the last chip sample computed, and the voice's output
    // at it and at the one before — the two the resampler reads between.
    this.k = -1;
    this.cur = 0;
    this.last = 0;
    // The note volume as an attenuation, cached on the volume it came from.
    this.vol = -1;
    this.volAtt = 0;
  }
}

/** A copy for an NNA ghost: the whole channel, mid-note, clock and all. */
export function cloneOplState(src) {
  const s = new OplState();
  s.patch = src.patch;
  s.gen = src.gen;
  s.rate = src.rate;
  s.phase.set(src.phase);
  s.inc.set(src.inc);
  s.env.set(src.env);
  s.state.set(src.state);
  s.out.set(src.out);
  s.prev.set(src.prev);
  s.kslAtt.set(src.kslAtt);
  s.ksrOffset.set(src.ksrOffset);
  s.hhPhase = src.hhPhase; s.tcPhase = src.tcPhase;
  s.hhInc = src.hhInc; s.tcInc = src.tcInc;
  s.noise = src.noise;
  s.keyed = src.keyed;
  s.k = src.k; s.cur = src.cur; s.last = src.last;
  s.vol = src.vol; s.volAtt = src.volAtt;
  return s;
}

/**
 * The chip-sample index output frame `frame` falls on, and how far past it:
 * frame·OPL_RATE/SAMPLING_RATE, kept in integers (num/den exactly) so the grid
 * every voice reads is the same grid. Writes the fraction to `fracBox[0]`.
 */
const fracBox = new Float64Array(1);
function chipIndex(frame) {
  const num = frame * OPL_CLOCK_HZ;
  const den = OPL_CLOCKS_PER_SAMPLE * SAMPLING_RATE;
  let k = Math.floor(num / den);
  let rem = num - k * den;
  if (rem < 0) { k--; rem += den; }
  else if (rem >= den) { k++; rem -= den; }
  fracBox[0] = rem / den;
  return k;
}

/** A deterministic, non-zero start for a drum's noise register: any non-zero
 *  23-bit state is a point on the LFSR's one cycle, so this is the chip's
 *  free-running noise met at an arbitrary moment, as a real key-on meets it. */
function noiseSeed(k) {
  const s = (Math.imul(k | 0, 0x9e3779b1) >>> 9) & 0x7fffff;
  return s === 0 ? 1 : s;
}

/**
 * Key the channel on, as a note trigger does. `carry` keeps the envelopes
 * where they stand (the chip restarting an attack from the current level —
 * a retrigger on the same channel); without it every operator starts from
 * silence, as a channel nothing has sounded on does, and the channel is
 * anchored to the chip clock at the first frame it renders. The phase
 * restarts at 0 either way: a key-on resets the phase generator on the chip.
 */
export function oplKeyOn(st, patch, carry) {
  st.patch = patch;
  st.gen = -1;
  st.rate = -1;
  if (!carry) {
    st.env.fill(OPL_ENV_MAX);
    st.out.fill(0);
    st.prev.fill(0);
    st.cur = 0;
    st.last = 0;
    st.k = NaN;
  }
  for (let i = 0; i < 4; i++) {
    st.state[i] = EG_ATTACK;
    st.phase[i] = 0;
  }
  // A drum's own accumulator restarts with its key-on; its partner's runs free
  // on the chip and is met here at zero.
  st.hhPhase = 0;
  st.tcPhase = 0;
  st.keyed = true;
}

/** Key off: every operator goes to its release, wherever it stands. */
export function oplKeyOff(st) {
  for (let i = 0; i < 4; i++) if (st.state[i] !== EG_OFF) st.state[i] = EG_RELEASE;
  st.keyed = false;
}

/** Re-attack every operator from where it stands without restarting the phase
 *  — an instrument byte on a tone-portamento row (spec §5.5.2). */
export function oplReattack(st) {
  for (let i = 0; i < 4; i++) st.state[i] = EG_ATTACK;
  st.keyed = true;
}

/** Recompute the frequency-derived values for the voice's current pitch. */
function retune(st, rate) {
  const patch = st.patch;
  const hz = rate * SAMPLING_RATE * HZ_PER_SPS;
  const bf = oplBlockFnum(hz, patch.lowFnum);
  const block = bf >> 10, fnum = bf & 1023;
  const ksv = (block << 1) | ((fnum >> (patch.nts ? 8 : 9)) & 1);
  let kslBase = KSL_ROM[(fnum >> 6) & 15] - 8 * (7 - block);
  if (kslBase < 0) kslBase = 0;
  for (let i = 0; i < 4; i++) {
    const op = patch.ops[i];
    st.inc[i] = ((fnum * OPL_MULTIPLE_X2[op.mult]) << block) >> 1;
    st.ksrOffset[i] = op.ksr ? ksv : ksv >> 2;
    // In envelope units (0.1875 dB), shifted after scaling, as the chip does.
    const shift = KSL_SHIFT[op.ksl];
    st.kslAtt[i] = shift < 0 ? 0 : (kslBase << 2) >> shift;
  }
  const kind = patch.kind;
  if (kind === OPL_KIND_SD || kind === OPL_KIND_HH || kind === OPL_KIND_TC) {
    // The two accumulators the noise drums are built from. The voice's own
    // note is its own channel's pitch — channel 7 for the snare and hi-hat,
    // channel 8 for the cymbal — and the partner's channel sits at the
    // record's detune from it.
    const pbf = oplBlockFnum(hz * 2 ** (patch.partnerDetune / 4096), patch.lowFnum);
    const pInc = (((pbf & 1023) * OPL_MULTIPLE_X2[patch.partnerMult]) << (pbf >> 10)) >> 1;
    const own = st.inc[0];
    if (kind === OPL_KIND_SD) {
      // The snare reads only the hi-hat operator's accumulator, which shares
      // its channel: same pitch, the hi-hat's multiplier.
      st.hhInc = ((fnum * OPL_MULTIPLE_X2[patch.partnerMult]) << block) >> 1;
      st.tcInc = 0;
    } else if (kind === OPL_KIND_HH) {
      st.hhInc = own;
      st.tcInc = pInc;
    } else {
      st.tcInc = own;
      st.hhInc = pInc;
    }
  }
  st.rate = rate;
  st.gen = patch.gen;
}

/** One envelope tick for operator `i` at chip sample `eg` (the reference
 *  core's #advanceEnvelope, Table 3-6 of the application manual). */
function oplAdvanceEnvelope(st, i, op, eg) {
  const state = st.state[i];
  if (state === EG_OFF) return;
  const rateParam = state === EG_ATTACK ? op.ar
    : state === EG_DECAY ? op.dr
    : state === EG_SUSTAIN ? (op.eg ? 0 : op.rr)
    : op.rr;
  // A rate of zero is not "slow", it is "never" (§3-1-5).
  if (rateParam === 0) return;
  let rate = rateParam * 4 + st.ksrOffset[i];
  if (rate > 60) rate = 60;                    // RM 15 ignores RL
  const shift = 12 - (rate >> 2);
  let steps;
  if (shift >= 0) {
    if ((eg & ((1 << shift) - 1)) !== 0) return;
    steps = EG_DUTY[rate & 3][(eg >> shift) & 7];
  } else {
    steps = EG_DUTY[rate & 3][eg & 7] << -shift;
  }
  for (let n = 0; n < steps; n++) {
    let env = st.env[i];
    switch (st.state[i]) {
      case EG_ATTACK:
        env -= (env >> 3) + 1;
        if (env <= 0) { env = 0; st.state[i] = EG_DECAY; }
        break;
      case EG_DECAY:
        env += 1;
        if (env >= op.sl) { env = op.sl; st.state[i] = EG_SUSTAIN; }
        break;
      default: // SUSTAIN (diminishing) and RELEASE both run at the release rate
        env += 1;
        if (env >= OPL_ENV_MAX) { env = OPL_ENV_MAX; st.state[i] = EG_OFF; }
        break;
    }
    st.env[i] = env < 0 ? 0 : env > OPL_ENV_MAX ? OPL_ENV_MAX : env;
    if (st.state[i] !== state) break;
  }
}

/** Read operator `i` for one chip sample, advancing its phase. `mod` is a
 *  phase offset in 1/1024 of a cycle; `extra` the attenuation on top of its
 *  own (tremolo, and the note volume on an output operator). */
function operate(st, i, op, mod, extra, vibrato) {
  const att = (st.env[i] + st.kslAtt[i]) * ENV_TO_LOG + op.tl * TL_TO_LOG + extra;
  let inc = st.inc[i];
  if (op.vib && vibrato !== 1) inc = Math.round(inc * vibrato);
  st.phase[i] = st.phase[i] + inc;
  st.prev[i] = st.out[i];
  if (st.state[i] === EG_OFF) { st.out[i] = 0; return 0; }
  const logv = waveform(op.ws, ((st.phase[i] >>> 10) + mod) & 0x3ff);
  if (logv === SILENCE) { st.out[i] = 0; return 0; }
  const v = oplExpand(logv + att) * waveSign;
  st.out[i] = v;
  return v;
}

/** A rhythm operator whose phase is dictated rather than accumulated. */
function rhythmOperator(st, i, op, phase, extra) {
  st.prev[i] = st.out[i];
  if (st.state[i] === EG_OFF) { st.out[i] = 0; return 0; }
  const logv = waveform(op.ws, phase);
  if (logv === SILENCE) { st.out[i] = 0; return 0; }
  const att = (st.env[i] + st.kslAtt[i]) * ENV_TO_LOG + op.tl * TL_TO_LOG + extra;
  const v = oplExpand(att + logv) * waveSign;
  st.out[i] = v;
  return v;
}

/** Feedback into operator 1: the average of its last two outputs, feedback 7
 *  being the documented 4π. */
function feedbackOf(st, fb) {
  if (fb === 0) return 0;
  return ((st.out[0] + st.prev[0]) / 2 / (1 << (8 - fb))) | 0;
}

/**
 * The chip's next sample for this channel, at chip clock `k`. Mirrors the
 * reference core's #twoOp / #fourOp / #generateRhythm for one channel, the
 * per-sample LFO values included; the integer it returns is the channel's
 * contribution to the chip's accumulator (a drum's already doubled).
 */
export function oplChipStep(st, k) {
  const patch = st.patch;
  const ops = patch.ops;
  const trem = (patch.deepTremolo ? TREMOLO_TABLE[1] : TREMOLO_TABLE[0])[k % TREMOLO_PERIOD];
  const vibrato = (patch.deepVibrato ? VIBRATO_TABLE[1] : VIBRATO_TABLE[0])[k % VIBRATO_PERIOD];
  const outputs = patch.outputs;
  const va = st.volAtt;
  const x0 = (ops[0].am ? trem : 0) + ((outputs & 1) !== 0 ? va : 0);
  switch (patch.kind) {
    case OPL_KIND_2OP: case OPL_KIND_BD: {
      oplAdvanceEnvelope(st, 0, ops[0], k);
      oplAdvanceEnvelope(st, 1, ops[1], k);
      const x1 = (ops[1].am ? trem : 0) + va;
      const m = operate(st, 0, ops[0], feedbackOf(st, patch.feedback), x0, vibrato);
      const v = patch.cntA
        ? m + operate(st, 1, ops[1], 0, x1, vibrato)
        : operate(st, 1, ops[1], m, x1, vibrato);
      return patch.kind === OPL_KIND_BD ? OPL_RHYTHM_MIX * v : v;
    }
    case OPL_KIND_4OP: {
      for (let i = 0; i < 4; i++) oplAdvanceEnvelope(st, i, ops[i], k);
      const x1 = ops[1].am ? trem : 0;
      const x2 = (ops[2].am ? trem : 0) + ((outputs & 4) !== 0 ? va : 0);
      const x3 = (ops[3].am ? trem : 0) + va;
      const o1 = operate(st, 0, ops[0], feedbackOf(st, patch.feedback), x0, vibrato);
      if (!patch.cntA) {
        const o2 = operate(st, 1, ops[1], o1, x1, vibrato);
        const o3 = operate(st, 2, ops[2], o2, x2, vibrato);
        return patch.cntB
          ? o3 + operate(st, 3, ops[3], 0, x3, vibrato)
          : operate(st, 3, ops[3], o3, x3, vibrato);
      }
      const o2 = operate(st, 1, ops[1], 0, x1, vibrato);
      const o3 = operate(st, 2, ops[2], o2, x2, vibrato);
      return patch.cntB
        ? o1 + o3 + operate(st, 3, ops[3], 0, x3, vibrato)
        : o1 + operate(st, 3, ops[3], o3, x3, vibrato);
    }
    case OPL_KIND_TOM:
      oplAdvanceEnvelope(st, 0, ops[0], k);
      return OPL_RHYTHM_MIX * operate(st, 0, ops[0], 0, x0, vibrato);
    case OPL_KIND_SD: case OPL_KIND_TC: case OPL_KIND_HH: {
      oplAdvanceEnvelope(st, 0, ops[0], k);
      // Every accumulator advances before any of the three is sampled, and
      // without vibrato, as the reference core has it.
      st.hhPhase = (st.hhPhase + st.hhInc) >>> 0;
      st.tcPhase = (st.tcPhase + st.tcInc) >>> 0;
      const hp = (st.hhPhase >>> 10) & 0x3ff;
      const tp = (st.tcPhase >>> 10) & 0x3ff;
      const noise = st.noise & 1;
      st.noise = ((st.noise >>> 1) | (((st.noise ^ (st.noise >>> 14)) & 1) << 22)) >>> 0;
      let phase;
      if (patch.kind === OPL_KIND_SD) {
        phase = (((hp >> 8) & 1) ? 0x200 : 0x100) ^ (noise << 8);
      } else {
        const xor = (((hp >> 2) ^ (hp >> 7)) | (hp >> 3) | ((tp >> 5) ^ (tp >> 3))) & 1;
        phase = patch.kind === OPL_KIND_HH
          ? (xor << 9) | (xor ^ noise ? 0x0d0 : 0x034)
          : (xor << 9) | 0x100;
      }
      return OPL_RHYTHM_MIX * rhythmOperator(st, 0, ops[0], phase, x0);
    }
    default:
      return 0;
  }
}

/**
 * Whether the channel can still make a sound: some output operator is not
 * yet OFF. An operator parked at full attenuation with nothing able to move it
 * — an attack rate of 0, or a decay or release that has nowhere left to go —
 * counts as finished too, so a patch that can never sound does not hold a
 * voice for ever.
 */
function channelAlive(st) {
  const patch = st.patch;
  const outputs = patch.outputs;
  for (let i = 0; i < 4; i++) {
    if ((outputs & (1 << i)) === 0) continue;
    const s = st.state[i];
    if (s === EG_OFF) continue;
    if (st.env[i] >= OPL_ENV_MAX && (s !== EG_ATTACK || patch.ops[i].ar === 0)) continue;
    return true;
  }
  return false;
}

/** The note volume as an attenuation: the nearest step of 1/256 octave, found
 *  with `2 ** rational` comparisons and no logarithm (spec §3.3). */
function volumeAttenuation(vol) {
  if (vol >= 1) return 0;
  if (!(vol > 0)) return 0x1800;
  // Smallest i whose upper midpoint 2^(−(2i+1)/512) the volume reaches.
  let lo = 0, hi = 0x1800;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vol >= 2 ** (-(2 * mid + 1) / 512)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The voice's output at output frame `frame` (the playhead's chip clock plus
 * the frame within the chunk), on the engine's ±1 scale. Runs the chip up to
 * the frame's chip sample and interpolates; follows the voice's key-off and
 * its note volume; and deactivates the voice once nothing can sound.
 */
export function renderOplVoice(voice, frame) {
  const st = voice.opl;
  const patch = st.patch;
  if (patch === null) return 0;
  if (voice.keyOff && st.keyed) oplKeyOff(st);
  const rate = voice.currentPlaybackRate;
  if (rate !== st.rate || patch.gen !== st.gen) retune(st, rate);
  const vol = voice.currentMixVolume;
  if (vol !== st.vol) { st.vol = vol; st.volAtt = volumeAttenuation(vol); }
  const k = chipIndex(frame);
  const frac = fracBox[0];
  if (Number.isNaN(st.k)) {
    // A fresh channel joins the chip clock here, and meets the free-running
    // noise register wherever a key-on would.
    st.k = k - 1;
    st.noise = noiseSeed(k);
  } else if (k - st.k > 8) {
    // A voice nobody rendered for a while (a muted lane) is frozen, as a
    // muted sample voice is, rather than made to catch up the gap at once.
    st.k = k - 1;
  }
  while (st.k < k) {
    st.k++;
    st.last = st.cur;
    st.cur = oplChipStep(st, st.k);
  }
  if (!channelAlive(st)) voice.active = false;
  return (st.last + (st.cur - st.last) * frac) * OUTPUT_SCALE;
}
