// OPL instruments — Metainstrument type 8 (item 209). The chip in place of a sample.
//
// A type-8 instrument is an ORDINARY instrument record — envelopes, fadeout,
// New Note Action, Duplicate Check, default volume and pan, auto-vibrato, the
// one pitch/filter envelope it keeps — whose sample is replaced by a patch for
// a YM3812 / YMF262 channel: two operators, four, or one of the five rhythm-
// mode drums (TAUD_FILE_FORMAT.md §7.8).
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
// The chip itself — the operators, envelopes, the rhythm section and the
// shared chip clock — is the engine's (core/engine/c/src/opl.c), pinned bit
// for bit against that core by test/node/opl.test.js. What is here is the
// patch block as a file holds it and the page edits it: its layout, codec and
// the output mask the operator graph draws.

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

// ── The record ────────────────────────────────────────────────────────────
// The patch occupies what an ordinary record spends on its SECOND pitch/
// filter envelope slot, bytes 197…250 (§7.8). Offsets below are relative to
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

/** Sustain level in envelope steps: 3 dB a step, and 15 is −93 dB. */
export const OPL_SUSTAIN_LEVEL = Int32Array.from([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 496]);

// ── LFOs ──────────────────────────────────────────────────────────────────
// Both are free-running triangles shared by every operator that opts in, and
// both are pure functions of the chip clock, so they are tabled over one period
// rather than evaluated per sample. The values are computed with exactly the
// reference core's expression order, which keeps them bit-identical to it.

// ── Waveforms ─────────────────────────────────────────────────────────────
// A 10-bit phase to a log-domain attenuation, with the sign left in
// `waveSign`. Shapes 0…3 are the YM3812's, 4…7 the YMF262's four additions —
// every one the same quarter sine read differently, and 7 the logarithmic saw
// whose slope is the chip's whole 96 dB across each half cycle.

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
    this.dPartnerDetune = 0; // the pitch extension of partnerDetune (file format §9.18)
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
    op.sl = OPL_SUSTAIN_LEVEL[(r80 >> 4) & 0x0f]; op.rr = r80 & 0x0f;
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
 * additive. Four operators: operator 4 always, operator 1 when CNT A is set,
 * and the other pair's last operator when CNT B is — operator 2 when CNT A is
 * clear, operator 3 when it is set (the YMF262 data sheet's four connection
 * figures, catalogue 4MF262A6, p. 13). A rhythm drum:
 * its one operator, or the bass drum's carrier (and modulator when additive).
 */
export function oplOutputMask(kind, cntA, cntB) {
  switch (kind) {
    case OPL_KIND_2OP: case OPL_KIND_BD: return cntA ? 0b11 : 0b10;
    case OPL_KIND_4OP:
      return 0b1000 | (cntA ? 0b0001 : 0) | (cntB ? (cntA ? 0b0100 : 0b0010) : 0);
    case OPL_KIND_SD: case OPL_KIND_TOM: case OPL_KIND_TC: case OPL_KIND_HH: return 0b1;
    default: return 0;
  }
}

// ── Frequency ─────────────────────────────────────────────────────────────

// ── The voice ─────────────────────────────────────────────────────────────

