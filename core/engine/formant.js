// Metainstrument type 1 — the FORMANT INSTRUMENT (item 212; TAUD_FILE_FORMAT §7.8,
// TAUD_ENGINE_SPEC §5.5.3).
//
// An ordinary instrument record whose sample is a GLOTTAL SOURCE, played
// through a model of the vocal tract, and whose second pitch/filter slot holds
// what the tract says: a vowel, three consonant slots (an onset cluster CC and
// a coda C, so a note is one CCVC syllable), and how the whole follows pitch.
// Everything else in the record — envelopes, fadeout, NNA, vibrato, filter —
// means exactly what it means on any instrument.
//
// The tract is Klatt's cascade/parallel formant synthesiser (Klatt 1980, "Software
// for a cascade/parallel formant synthesizer", JASA 67(3)): a CASCADE of
// resonators for everything voiced or aspirated, a PARALLEL bank for frication.
// Where Klatt's source is an impulse train and a noise generator, ours are
// SAMPLES: the record's own sample is the voicing, and each consonant slot
// names a span of the pool (a "recipe" an editor chose for it) as its noise.
//
// The vowel lives on Lindsey's acoustic vowel chart (log F1 down, log F2
// right-to-left, as Praat's VowelEditor draws it), bounded by Catford's
// cardinal vowels; roundness carries what that chart cannot show, the third
// formant. Formants then follow the note: a singer pitched higher is a smaller
// singer (Hillenbrand et al. 1995: formants rise as about the 0.3 power of f0
// between speakers), and once f0 passes the first formant the singer tunes R1
// to it (Joliveau, Smith & Wolfe 2004; Henrich, Smith & Wolfe 2011).
//
// Everything is IEEE double arithmetic in a fixed order; the transcendentals
// are exp, cos, sin, log, sqrt and pow, the same ones filter.js already uses.

import { SAMPLING_RATE, SAMPLE_BIN_TOTAL, LINEAR_FREQ_C4_HZ, MIDDLE_C } from "./constants.js";
import { attenGainOf } from "./tables.js";
import { PCM_U8, fetchTrackerSample, startRampOut } from "./sampler.js";

// ── The record ──────────────────────────────────────────────────────────────

/** Byte 0's type nibble for this kind (§7.4). */
export const META_TYPE_FORMANT = 1;
/** Bytes 0…3: the type, a reserved byte, and the metainstrument sentinel. */
export const FORMANT_RECORD_HEADER = Object.freeze([0x10, 0x00, 0xff, 0xff]);
/** The tract block takes the second pitch/filter slot, as OPL's patch does. */
export const FORMANT_BLOCK_START = 197;
export const FORMANT_BLOCK_LEN = 54;

/** Offsets inside the block. */
export const FB_SOURCE = 0;     // U24 pool pointer of the glottal source
export const FB_FRONT = 3;      // U8 vowel: frontness (F2 across its row)
export const FB_OPEN = 4;       // U8 vowel: openness (F1)
export const FB_ROUND = 5;      // U8 vowel: roundness (F3)
export const FB_TRACK = 6;      // U8 size tracking: exponent = byte ÷ 256
export const FB_REF = 7;        // U16 reference note: where the chart's (adult male) formants hold
export const FB_GLIDE = 9;      // U8 vowel glide for S $Afgr, in 2 ms units
export const FB_TIMING = 10;    // U8 consonant timing: scale = 2^((byte − 128) ÷ 64)
export const FB_RANGE_LO = 11;  // U24 the pool range the instrument is made from (editor's)
export const FB_RANGE_HI = 14;  // U24 …its exclusive end
export const FB_SLOTS = 17;     // three consonant slots, 12 bytes each
export const FB_RESERVED = 53;
export const FORMANT_SLOTS = 3; // onset C1, onset C2, coda C
export const FORMANT_SLOT_BYTES = 12;

/** One consonant slot: which consonant, and the recipe it is sounded with. */
export class FormantSlot {
  constructor() {
    this.cons = 0;    // consonant id (CONSONANTS), 0 = none
    this.ptr = 0;     // noise sample: pool pointer…
    this.len = 0;     // …and length in bytes (the whole census sample)
    this.offset = 0;  // where in it the noise starts
    this.rate = 0;    // the rate it is read at, Hz — the recipe's speed
    this.tilt = 0;    // S8 spectral tilt: + brightens, − darkens
    this.gain = 0;    // decibel octet (§7.5), 0 = unity
  }
}

/** The decoded block. Updated IN PLACE on every write, so a sounding voice
 *  hears an edit at once (the same contract as OPL's patch). */
export class FormantPatch {
  constructor() {
    this.srcPtr = 0;
    this.front = 177;
    this.open = 255;
    this.round = 0;
    this.track = 64;
    this.refNote = 0x4000;
    this.glide = 20;
    this.timing = 128;
    this.rangeLo = 0;
    this.rangeHi = 0;
    this.slots = [new FormantSlot(), new FormantSlot(), new FormantSlot()];
  }
}

const fu16 = (b, o) => (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8);
const fu24 = (b, o) => (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8) | ((b[o + 2] & 0xff) << 16);

/** Read a 54-byte tract block at `raw[off…]` into `patch`. */
export function decodeFormantBlock(raw, off, patch = new FormantPatch()) {
  patch.srcPtr = fu24(raw, off + FB_SOURCE);
  patch.front = raw[off + FB_FRONT] & 0xff;
  patch.open = raw[off + FB_OPEN] & 0xff;
  patch.round = raw[off + FB_ROUND] & 0xff;
  patch.track = raw[off + FB_TRACK] & 0xff;
  patch.refNote = fu16(raw, off + FB_REF);
  patch.glide = raw[off + FB_GLIDE] & 0xff;
  patch.timing = raw[off + FB_TIMING] & 0xff;
  patch.rangeLo = fu24(raw, off + FB_RANGE_LO);
  patch.rangeHi = fu24(raw, off + FB_RANGE_HI);
  for (let i = 0; i < FORMANT_SLOTS; i++) {
    const o = off + FB_SLOTS + i * FORMANT_SLOT_BYTES;
    const s = patch.slots[i];
    s.cons = raw[o] & 0xff;
    s.ptr = fu24(raw, o + 1);
    s.len = fu16(raw, o + 4);
    s.offset = fu16(raw, o + 6);
    s.rate = fu16(raw, o + 8);
    const t = raw[o + 10] & 0xff;
    s.tilt = t >= 0x80 ? t - 0x100 : t;
    s.gain = raw[o + 11] & 0xff;
  }
  return patch;
}

/** Write `patch` as a 54-byte block into `out[off…]`; the reserved byte is 0. */
export function encodeFormantBlock(patch, out = new Uint8Array(FORMANT_BLOCK_LEN), off = 0) {
  const p24 = (o, v) => { out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; out[o + 2] = (v >>> 16) & 0xff; };
  const p16 = (o, v) => { out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; };
  p24(off + FB_SOURCE, patch.srcPtr);
  out[off + FB_FRONT] = patch.front & 0xff;
  out[off + FB_OPEN] = patch.open & 0xff;
  out[off + FB_ROUND] = patch.round & 0xff;
  out[off + FB_TRACK] = patch.track & 0xff;
  p16(off + FB_REF, patch.refNote);
  out[off + FB_GLIDE] = patch.glide & 0xff;
  out[off + FB_TIMING] = patch.timing & 0xff;
  p24(off + FB_RANGE_LO, patch.rangeLo);
  p24(off + FB_RANGE_HI, patch.rangeHi);
  for (let i = 0; i < FORMANT_SLOTS; i++) {
    const o = off + FB_SLOTS + i * FORMANT_SLOT_BYTES;
    const s = patch.slots[i];
    out[o] = s.cons & 0xff;
    p24(o + 1, s.ptr);
    p16(o + 4, s.len);
    p16(o + 6, s.offset);
    p16(o + 8, s.rate);
    out[o + 10] = s.tilt & 0xff;
    out[o + 11] = s.gain & 0xff;
  }
  out[off + FB_RESERVED] = 0;
  return out;
}

// ── The vowel chart ─────────────────────────────────────────────────────────
//
// Openness is F1 from 240 to 850 Hz on a log scale — Catford's [i] to his [a].
// Each row runs from the BACK edge to the FRONT edge in log F2, both edges
// piecewise linear in (log F1, log F2) through the cardinal vowels as Catford
// gives them for a man's speech (A Practical Introduction to Phonetics, 2nd ed.,
// p. 154): front i e ɛ a, back u o ɔ ɒ, the back edge carried on to the
// chart's floor along its ɔ–ɒ slope. So every byte pair is a vowel some singer
// can make, and the space is the rounded V Lindsey draws, not a rectangle.

export const VOWEL_F1_MIN = 240;
export const VOWEL_F1_MAX = 850;
/** [F1, F2] anchors of the front edge (i e ɛ a) and the back edge (u o ɔ ɒ, floor). */
export const VOWEL_FRONT_EDGE = Object.freeze([[240, 2400], [390, 2300], [610, 1900], [850, 1610]]);
export const VOWEL_BACK_EDGE = Object.freeze([[250, 595], [360, 640], [500, 700], [700, 760], [850, 800]]);

function edgeF2(edge, f1) {
  if (f1 <= edge[0][0]) return edge[0][1];
  for (let i = 1; i < edge.length; i++) {
    if (f1 <= edge[i][0]) {
      const [a1, a2] = edge[i - 1];
      const [b1, b2] = edge[i];
      const u = Math.log(f1 / a1) / Math.log(b1 / a1);
      return a2 * (b2 / a2) ** u;
    }
  }
  return edge[edge.length - 1][1];
}

/** F1 of an openness byte (0 = close, 255 = open). */
export function vowelF1(open) {
  return VOWEL_F1_MIN * (VOWEL_F1_MAX / VOWEL_F1_MIN) ** (open / 255);
}

/** F2 of a frontness byte at that F1 (0 = the back edge, 255 = the front edge). */
export function vowelF2(front, f1) {
  const bk = edgeF2(VOWEL_BACK_EDGE, f1);
  const fr = edgeF2(VOWEL_FRONT_EDGE, f1);
  return bk * (fr / bk) ** (front / 255);
}

/** The inverse pair, for editors: chart bytes (unrounded to integers) for an F1/F2. */
export function vowelCoordsOf(f1, f2) {
  const f1c = Math.min(Math.max(f1, VOWEL_F1_MIN), VOWEL_F1_MAX);
  const open = 255 * Math.log(f1c / VOWEL_F1_MIN) / Math.log(VOWEL_F1_MAX / VOWEL_F1_MIN);
  const bk = edgeF2(VOWEL_BACK_EDGE, f1c);
  const fr = edgeF2(VOWEL_FRONT_EDGE, f1c);
  const f2c = Math.min(Math.max(f2, bk), fr);
  const front = 255 * Math.log(f2c / bk) / Math.log(fr / bk);
  return [front, open];
}

/**
 * The vowel's five formants at the reference pitch, into F (Hz). F3 is where
 * roundness lives: unrounded it sits at max(2500, F2 + 700) — the American
 * English front vowels' F3 (Hillenbrand et al. 1995) — and rounded it closes
 * in on F2, max(2200, F2 + 250), as French [y] and Klatt's [u] have it; the
 * two are interpolated in log frequency. F4 and F5 are Praat's VowelEditor
 * defaults, held clear above F3.
 */
export function vowelFormants(front, open, round, F) {
  const f1 = vowelF1(open);
  const f2 = vowelF2(front, f1);
  const f3u = Math.max(2500, f2 + 700);
  const f3r = Math.max(2200, f2 + 250);
  const f3 = f3u * (f3r / f3u) ** (round / 255);
  const f4 = Math.max(3500, f3 + 400);
  const f5 = Math.max(4500, f4 + 500);
  F[0] = f1; F[1] = f2; F[2] = f3; F[3] = f4; F[4] = f5;
  return F;
}

/** A note word's frequency on the 12-TET grid C4 = 261.63 Hz. */
export function noteHz(note) {
  return LINEAR_FREQ_C4_HZ * 2 ** ((note - MIDDLE_C) / 4096);
}

/**
 * The vowel at a pitch: the chart point (front, open, round) sung at f0 (Hz),
 * into F (formants) and B (bandwidths), Hz. Returns the size scale.
 *
 *  1. SIZE. Every formant scales by (f0 ÷ ref)^k, k = track ÷ 256. Between
 *     speakers formants rise as about the 0.30 power of f0 (Hillenbrand et al.
 *     1995: women 0.28–0.31 over men, children 0.33–0.42); between a choir's
 *     parts somewhat less (the singer's formant, bass to soprano, Scientific
 *     Reports 2022: about 0.22–0.27). The record's default, 64, is ¼.
 *  2. R1:f0 TUNING. Once f0 passes F1, the singer tunes F1 to it (Joliveau,
 *     Smith & Wolfe 2004; Henrich, Smith & Wolfe 2011: sopranos, and altos in
 *     their upper range). The gesture is the jaw, so the point moves straight
 *     DOWN the chart — frontness kept — until its F1 is f0: F2 follows the
 *     row it lands on, rising for a back vowel (the incidental R2 rise those
 *     papers report) and falling for a front one, which is the [i]→[ɛ]
 *     modification a soprano's high [i] is heard to make. Past the chart's
 *     floor F1 alone goes on following f0.
 *  3. ORDER. Each formant is held at least 15% above the one below it, and
 *     none above 45% of the output rate.
 *
 * Bandwidths are then F ÷ 10 (Praat's VowelEditor Q of 10) with a 50 Hz
 * floor (Klatt's B1 for a close vowel).
 */
export function vowelAtPitch(front, open, round, f0, refHz, track, F, B) {
  const s = f0 > 0 && refHz > 0 ? (f0 / refHz) ** (track / 256) : 1.0;
  let o = open;
  if (f0 > vowelF1(open) * s) {
    const want = f0 / s;
    o = want >= VOWEL_F1_MAX ? 255
      : (255 * Math.log(want / VOWEL_F1_MIN)) / Math.log(VOWEL_F1_MAX / VOWEL_F1_MIN);
  }
  vowelFormants(front, o, round, F);
  for (let n = 0; n < 5; n++) F[n] *= s;
  if (f0 > F[0]) F[0] = f0;
  const ceil = 0.45 * SAMPLING_RATE;
  for (let n = 1; n < 5; n++) if (F[n] < F[n - 1] * 1.15) F[n] = F[n - 1] * 1.15;
  for (let n = 0; n < 5; n++) {
    if (F[n] > ceil) F[n] = ceil;
    B[n] = Math.max(F[n] / 10, 50);
  }
  return s;
}

// ── The consonants ──────────────────────────────────────────────────────────
//
// IDs are the FORMAT's: a record stores one per slot, so an id never moves
// and never changes meaning. Unknown ids sound as "no consonant".
//
// Per row: the tract the consonant is made with (F1–F3 and B1–B3 at an adult
// male's size; 0 = keep the vowel's), the frication spectrum as Klatt's
// parallel amplitudes A2…A6 and AB (dB, 0 = off), its noise level in dB
// against the vowel, and its timing in ms. Klatt 1980 Table III supplies every
// row it has (w j r l f v θ ð s z ʃ tʃ dʒ p b t d k g m n); VOTs are Lisker &
// Abramson 1964 (aspirated English p t k 58/70/80 ms); the rest are filled by
// place analogy.

export const MANNER_STOP = 1;
export const MANNER_AFFRICATE = 2;
export const MANNER_FRICATIVE = 3;
export const MANNER_ASPIRATE = 4;
export const MANNER_NASAL = 5;
export const MANNER_APPROX = 6;
export const MANNER_TAP = 7;
export const MANNER_TRILL = 8;
export const MANNER_GLOTTAL = 9;

export const PLACE_BILABIAL = 0;
export const PLACE_LABIODENTAL = 1;
export const PLACE_DENTAL = 2;
export const PLACE_ALVEOLAR = 3;
export const PLACE_POSTALVEOLAR = 4;
export const PLACE_RETROFLEX = 5;
export const PLACE_ALVEOLOPALATAL = 6;
export const PLACE_PALATAL = 7;
export const PLACE_VELAR = 8;
export const PLACE_UVULAR = 9;
export const PLACE_PHARYNGEAL = 10;
export const PLACE_GLOTTAL = 11;
export const PLACE_LABIOVELAR = 12;
export const PLACE_LABIOPALATAL = 13;

const MN_S = MANNER_STOP, MN_AF = MANNER_AFFRICATE, MN_FR = MANNER_FRICATIVE, MN_H = MANNER_ASPIRATE;
const MN_N = MANNER_NASAL, MN_AP = MANNER_APPROX, MN_TP = MANNER_TAP, MN_TR = MANNER_TRILL, MN_Q = MANNER_GLOTTAL;

// Shared frication spectra (A2 A3 A4 A5 A6 AB).
const K_LABIAL = [0, 0, 0, 0, 0, 63];
const K_T = [0, 30, 45, 57, 63, 0];
const K_D = [0, 47, 60, 62, 60, 0];
const K_RETRO_STOP = [0, 50, 55, 50, 45, 0];
const K_PALATAL_STOP = [0, 45, 55, 50, 40, 0];
const K_K = [0, 53, 43, 45, 45, 0];
const K_UVULAR = [55, 45, 35, 30, 30, 0];
const K_F = [0, 0, 0, 0, 0, 57];
const K_PHI = [0, 0, 0, 0, 0, 55];
const K_TH = [0, 0, 0, 0, 28, 48];
const K_S = [0, 0, 0, 0, 52, 0];
const K_SH = [0, 57, 48, 48, 46, 0];
const K_RETRO = [0, 57, 50, 40, 30, 0];
const K_ALVPAL = [0, 45, 57, 50, 45, 0];
const K_C = [0, 35, 55, 50, 40, 0];
const K_X = [57, 50, 40, 35, 30, 0];
const K_CHI = [58, 45, 35, 30, 25, 0];
const K_LATFR = [0, 0, 45, 50, 48, 40];
const K_TSH = [0, 44, 60, 53, 53, 0];
const K_WH = [0, 0, 0, 0, 0, 50];
const K_NONE = [0, 0, 0, 0, 0, 0];

/**
 * consRow(id, ipa, manner, voiced, place, F[3], B[3], bank[6], lvl dB, dur, burst,
 * vot, trans, av, fnz). `dur` is the manner's main part: a fricative's or an
 * affricate's frication, a nasal's murmur, an approximant's steady state, a
 * tap's closure. `av` is the voicing level during it (voiced obstruents,
 * nasals, approximants); `fnz` a nasal's zero.
 */
function consRow(id, ipa, manner, voiced, place, F, B, bank, lvl, dur, burst, vot, trans, av = 0, fnz = 0) {
  return Object.freeze({ id, ipa, manner, voiced, place, F, B, bank, lvl, dur, burst, vot, trans, av, fnz });
}

const ROWS = [
  // Plosives — dur is the closure a stop makes when something precedes it.
  consRow(1, "p", MN_S, false, PLACE_BILABIAL, [400, 1100, 2150], [300, 150, 220], K_LABIAL, -12, 0, 5, 12, 40),
  consRow(2, "b", MN_S, true, PLACE_BILABIAL, [200, 1100, 2150], [60, 110, 130], K_LABIAL, -14, 0, 5, 0, 40),
  consRow(3, "t", MN_S, false, PLACE_ALVEOLAR, [400, 1600, 2600], [300, 120, 250], K_T, -10, 0, 10, 18, 45),
  consRow(4, "d", MN_S, true, PLACE_ALVEOLAR, [200, 1600, 2600], [60, 100, 170], K_D, -12, 0, 8, 0, 45),
  consRow(5, "ʈ", MN_S, false, PLACE_RETROFLEX, [400, 1500, 1900], [300, 120, 250], K_RETRO_STOP, -10, 0, 10, 18, 45),
  consRow(6, "ɖ", MN_S, true, PLACE_RETROFLEX, [200, 1500, 1900], [60, 100, 170], K_RETRO_STOP, -12, 0, 8, 0, 45),
  consRow(7, "c", MN_S, false, PLACE_PALATAL, [300, 2100, 2900], [250, 160, 330], K_PALATAL_STOP, -10, 0, 15, 22, 50),
  consRow(8, "ɟ", MN_S, true, PLACE_PALATAL, [200, 2100, 2900], [60, 150, 280], K_PALATAL_STOP, -12, 0, 12, 0, 50),
  consRow(9, "k", MN_S, false, PLACE_VELAR, [300, 1990, 2850], [250, 160, 330], K_K, -10, 0, 20, 25, 50),
  consRow(10, "g", MN_S, true, PLACE_VELAR, [200, 1990, 2850], [60, 150, 280], K_K, -12, 0, 15, 0, 50),
  consRow(11, "q", MN_S, false, PLACE_UVULAR, [400, 1200, 2400], [250, 150, 300], K_UVULAR, -10, 0, 20, 25, 50),
  consRow(12, "ɢ", MN_S, true, PLACE_UVULAR, [250, 1200, 2400], [60, 120, 250], K_UVULAR, -12, 0, 15, 0, 50),
  consRow(13, "ʔ", MN_Q, false, PLACE_GLOTTAL, [0, 0, 0], [0, 0, 0], K_NONE, 0, 0, 0, 0, 0),
  consRow(14, "pʰ", MN_S, false, PLACE_BILABIAL, [400, 1100, 2150], [300, 150, 220], K_LABIAL, -12, 0, 5, 58, 40),
  consRow(15, "tʰ", MN_S, false, PLACE_ALVEOLAR, [400, 1600, 2600], [300, 120, 250], K_T, -10, 0, 10, 70, 45),
  consRow(16, "kʰ", MN_S, false, PLACE_VELAR, [300, 1990, 2850], [250, 160, 330], K_K, -10, 0, 20, 80, 50),
  // Nasals — Klatt's murmur: F1 480 cancelled by a zero at 450 Hz, leaving
  // the nasal pole at 270 Hz; place is the wide-bandwidth F2/F3.
  consRow(32, "m", MN_N, true, PLACE_BILABIAL, [480, 1270, 2130], [40, 200, 200], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(33, "ɱ", MN_N, true, PLACE_LABIODENTAL, [480, 1200, 2100], [40, 200, 200], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(34, "n", MN_N, true, PLACE_ALVEOLAR, [480, 1340, 2470], [40, 300, 300], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(35, "ɳ", MN_N, true, PLACE_RETROFLEX, [480, 1400, 1900], [40, 300, 300], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(36, "ɲ", MN_N, true, PLACE_PALATAL, [480, 2000, 2900], [40, 300, 300], K_NONE, 0, 60, 0, 0, 40, 0.5, 450),
  consRow(37, "ŋ", MN_N, true, PLACE_VELAR, [480, 1900, 2700], [40, 300, 300], K_NONE, 0, 60, 0, 0, 40, 0.5, 450),
  consRow(38, "ɴ", MN_N, true, PLACE_UVULAR, [480, 1200, 2400], [40, 300, 300], K_NONE, 0, 60, 0, 0, 40, 0.5, 450),
  // Trills — two closures of a 40 ms cycle.
  consRow(40, "ʙ", MN_TR, true, PLACE_BILABIAL, [300, 1100, 2150], [70, 110, 130], K_NONE, 0, 40, 0, 0, 50),
  consRow(41, "r", MN_TR, true, PLACE_ALVEOLAR, [300, 1500, 2500], [70, 100, 150], K_NONE, 0, 40, 0, 0, 50),
  consRow(42, "ʀ", MN_TR, true, PLACE_UVULAR, [400, 1200, 2300], [80, 120, 200], K_NONE, 0, 40, 0, 0, 50),
  // Taps.
  consRow(44, "ⱱ", MN_TP, true, PLACE_LABIODENTAL, [300, 1100, 2080], [60, 90, 120], K_NONE, 0, 20, 0, 0, 35),
  consRow(45, "ɾ", MN_TP, true, PLACE_ALVEOLAR, [300, 1600, 2600], [60, 100, 170], K_NONE, 0, 20, 0, 0, 35),
  consRow(46, "ɽ", MN_TP, true, PLACE_RETROFLEX, [300, 1500, 1900], [60, 100, 170], K_NONE, 0, 20, 0, 0, 35),
  // Fricatives — sibilants are the loud ones, f θ ɸ the weak ones.
  consRow(48, "ɸ", MN_FR, false, PLACE_BILABIAL, [340, 1000, 2100], [200, 120, 150], K_PHI, -24, 100, 0, 0, 40),
  consRow(49, "β", MN_FR, true, PLACE_BILABIAL, [220, 1000, 2100], [60, 90, 120], K_PHI, -28, 70, 0, 0, 40, 0.35),
  consRow(50, "f", MN_FR, false, PLACE_LABIODENTAL, [340, 1100, 2080], [200, 120, 150], K_F, -22, 100, 0, 0, 40),
  consRow(51, "v", MN_FR, true, PLACE_LABIODENTAL, [220, 1100, 2080], [60, 90, 120], K_F, -26, 70, 0, 0, 40, 0.35),
  consRow(52, "θ", MN_FR, false, PLACE_DENTAL, [320, 1290, 2540], [200, 90, 200], K_TH, -24, 100, 0, 0, 40),
  consRow(53, "ð", MN_FR, true, PLACE_DENTAL, [270, 1290, 2540], [60, 80, 170], K_TH, -28, 70, 0, 0, 40, 0.35),
  consRow(54, "s", MN_FR, false, PLACE_ALVEOLAR, [320, 1390, 2530], [200, 80, 200], K_S, -8, 120, 0, 0, 40),
  consRow(55, "z", MN_FR, true, PLACE_ALVEOLAR, [240, 1390, 2530], [70, 60, 180], K_S, -12, 90, 0, 0, 40, 0.35),
  consRow(56, "ʃ", MN_FR, false, PLACE_POSTALVEOLAR, [300, 1840, 2750], [200, 100, 300], K_SH, -6, 120, 0, 0, 40),
  consRow(57, "ʒ", MN_FR, true, PLACE_POSTALVEOLAR, [240, 1840, 2750], [60, 100, 300], K_SH, -10, 90, 0, 0, 40, 0.35),
  consRow(58, "ʂ", MN_FR, false, PLACE_RETROFLEX, [300, 1600, 2000], [200, 100, 250], K_RETRO, -7, 120, 0, 0, 40),
  consRow(59, "ʐ", MN_FR, true, PLACE_RETROFLEX, [240, 1600, 2000], [60, 100, 250], K_RETRO, -11, 90, 0, 0, 40, 0.35),
  consRow(60, "ç", MN_FR, false, PLACE_PALATAL, [300, 2100, 3000], [200, 150, 300], K_C, -12, 110, 0, 0, 45),
  consRow(61, "ʝ", MN_FR, true, PLACE_PALATAL, [240, 2100, 3000], [60, 150, 300], K_C, -16, 80, 0, 0, 45, 0.35),
  consRow(62, "x", MN_FR, false, PLACE_VELAR, [300, 1700, 2600], [200, 150, 300], K_X, -14, 110, 0, 0, 45),
  consRow(63, "ɣ", MN_FR, true, PLACE_VELAR, [240, 1700, 2600], [60, 150, 300], K_X, -18, 80, 0, 0, 45, 0.35),
  consRow(64, "χ", MN_FR, false, PLACE_UVULAR, [400, 1200, 2400], [200, 150, 300], K_CHI, -13, 110, 0, 0, 45),
  consRow(65, "ʁ", MN_FR, true, PLACE_UVULAR, [300, 1200, 2400], [80, 150, 300], K_CHI, -17, 80, 0, 0, 45, 0.35),
  consRow(66, "ħ", MN_H, false, PLACE_PHARYNGEAL, [700, 1100, 2500], [300, 150, 300], K_NONE, -16, 90, 0, 0, 30),
  consRow(67, "ʕ", MN_H, true, PLACE_PHARYNGEAL, [700, 1100, 2500], [100, 150, 300], K_NONE, -20, 70, 0, 0, 30, 0.4),
  consRow(68, "h", MN_H, false, PLACE_GLOTTAL, [0, 0, 0], [300, 0, 0], K_NONE, -16, 70, 0, 0, 15),
  consRow(69, "ɦ", MN_H, true, PLACE_GLOTTAL, [0, 0, 0], [300, 0, 0], K_NONE, -20, 60, 0, 0, 15, 0.4),
  consRow(70, "ɬ", MN_FR, false, PLACE_ALVEOLAR, [320, 1300, 2600], [200, 90, 200], K_LATFR, -12, 110, 0, 0, 45),
  consRow(71, "ɮ", MN_FR, true, PLACE_ALVEOLAR, [240, 1300, 2600], [60, 90, 200], K_LATFR, -16, 80, 0, 0, 45, 0.35),
  consRow(72, "ɕ", MN_FR, false, PLACE_ALVEOLOPALATAL, [300, 2000, 2900], [200, 120, 300], K_ALVPAL, -7, 120, 0, 0, 45),
  consRow(73, "ʑ", MN_FR, true, PLACE_ALVEOLOPALATAL, [240, 2000, 2900], [60, 120, 300], K_ALVPAL, -11, 90, 0, 0, 45, 0.35),
  consRow(74, "ʍ", MN_FR, false, PLACE_LABIOVELAR, [290, 610, 2150], [200, 80, 60], K_WH, -22, 90, 0, 0, 100),
  // Approximants — Klatt: about 10 dB under the vowel, slow transitions.
  consRow(80, "ʋ", MN_AP, true, PLACE_LABIODENTAL, [300, 1100, 2200], [60, 90, 150], K_NONE, 0, 50, 0, 0, 70, 0.4),
  consRow(81, "ɹ", MN_AP, true, PLACE_ALVEOLAR, [310, 1060, 1380], [70, 100, 120], K_NONE, 0, 50, 0, 0, 90, 0.4),
  consRow(82, "ɻ", MN_AP, true, PLACE_RETROFLEX, [310, 1100, 1500], [70, 100, 120], K_NONE, 0, 50, 0, 0, 90, 0.4),
  consRow(83, "j", MN_AP, true, PLACE_PALATAL, [260, 2070, 3020], [40, 250, 500], K_NONE, 0, 40, 0, 0, 100, 0.4),
  consRow(84, "ɰ", MN_AP, true, PLACE_VELAR, [300, 1200, 2400], [50, 90, 150], K_NONE, 0, 40, 0, 0, 100, 0.4),
  consRow(85, "w", MN_AP, true, PLACE_LABIOVELAR, [290, 610, 2150], [50, 80, 60], K_NONE, 0, 40, 0, 0, 100, 0.4),
  consRow(86, "ɥ", MN_AP, true, PLACE_LABIOPALATAL, [260, 1700, 2200], [40, 200, 300], K_NONE, 0, 40, 0, 0, 100, 0.4),
  consRow(88, "l", MN_AP, true, PLACE_ALVEOLAR, [310, 1050, 2880], [50, 100, 280], K_NONE, 0, 60, 0, 0, 60, 0.4),
  consRow(89, "ɭ", MN_AP, true, PLACE_RETROFLEX, [310, 1300, 1900], [50, 100, 200], K_NONE, 0, 60, 0, 0, 60, 0.4),
  consRow(90, "ʎ", MN_AP, true, PLACE_PALATAL, [300, 2000, 2800], [50, 150, 250], K_NONE, 0, 60, 0, 0, 70, 0.4),
  consRow(91, "ʟ", MN_AP, true, PLACE_VELAR, [310, 1100, 2700], [50, 100, 250], K_NONE, 0, 60, 0, 0, 70, 0.4),
  // Affricates — a stop's burst, then a short frication of their own.
  consRow(96, "t͡s", MN_AF, false, PLACE_ALVEOLAR, [320, 1500, 2550], [200, 90, 200], K_S, -8, 70, 8, 0, 40),
  consRow(97, "d͡z", MN_AF, true, PLACE_ALVEOLAR, [240, 1500, 2550], [70, 60, 180], K_S, -12, 60, 8, 0, 40),
  consRow(98, "t͡ʃ", MN_AF, false, PLACE_POSTALVEOLAR, [350, 1800, 2820], [200, 90, 300], K_TSH, -6, 70, 8, 0, 40),
  consRow(99, "d͡ʒ", MN_AF, true, PLACE_POSTALVEOLAR, [260, 1800, 2820], [60, 80, 270], K_TSH, -10, 60, 8, 0, 40),
  consRow(100, "t͡ɕ", MN_AF, false, PLACE_ALVEOLOPALATAL, [300, 2000, 2900], [200, 120, 300], K_ALVPAL, -7, 70, 10, 0, 45),
  consRow(101, "d͡ʑ", MN_AF, true, PLACE_ALVEOLOPALATAL, [240, 2000, 2900], [60, 120, 300], K_ALVPAL, -11, 60, 10, 0, 45),
  consRow(102, "ʈ͡ʂ", MN_AF, false, PLACE_RETROFLEX, [300, 1600, 2000], [200, 100, 250], K_RETRO, -7, 70, 10, 0, 45),
  consRow(103, "ɖ͡ʐ", MN_AF, true, PLACE_RETROFLEX, [240, 1600, 2000], [60, 100, 250], K_RETRO, -11, 60, 10, 0, 45),
  consRow(104, "p͡f", MN_AF, false, PLACE_LABIODENTAL, [340, 1100, 2080], [200, 120, 150], K_F, -16, 70, 5, 0, 40),
  consRow(105, "k͡x", MN_AF, false, PLACE_VELAR, [300, 1800, 2700], [250, 160, 330], K_X, -12, 70, 20, 0, 50),
];

/** id → row, for every id the format defines; undefined elsewhere. */
export const CONSONANTS = (() => {
  const t = new Array(256).fill(undefined);
  for (const r of ROWS) t[r.id] = r;
  return Object.freeze(t);
})();

/** Every defined consonant, in id order (for editors). */
export const CONSONANT_LIST = Object.freeze(ROWS.slice());

/** Does this consonant read its slot's noise sample at all? */
export function consonantNeedsNoise(r) {
  return r !== undefined && (r.manner === MANNER_STOP || r.manner === MANNER_AFFRICATE ||
    r.manner === MANNER_FRICATIVE || r.manner === MANNER_ASPIRATE);
}

/** A stop's or affricate's closure when something precedes it, and the trill cycle. */
const CLOSURE_MS = 50;
const ASPIRATION_DB = -6;  // a stop's aspiration, against its own burst level
const dbGain = (db) => 10 ** (db / 20);

// ── Segment tracks ──────────────────────────────────────────────────────────
//
// A consonant sounds as five piecewise-linear TRACKS over its own time in ms:
//   w   how far the tract is at the consonant's configuration (1) rather
//       than at the next sound's (0)
//   av  voicing: the source through the cascade, 1 = the vowel's level
//   ah  aspiration: the noise through the cascade
//   af  frication: the noise through the parallel bank
//   nz  nasality: 1 opens the nasal zero to the consonant's, 0 closes it
// An onset consonant ENDS at the values the next sound starts at, so the
// tracks run on into it without a step; a coda starts at the vowel's and ends
// in silence. A track is [t0, v0, t1, v1, …] with non-decreasing times; two
// points at one time are a step.

class FormantTrack {
  constructor() { this.p = []; }
  at(t, v) {
    const p = this.p;
    if (p.length >= 2 && t < p[p.length - 2]) t = p[p.length - 2];
    p.push(t, v);
    return this;
  }
  /** End at `t` on value `v`, unless the track already ends there on it. */
  close(t, v) {
    const p = this.p;
    if (p.length === 0) { p.push(0, v); }
    const lt = p[p.length - 2];
    if (t > lt) p.push(t, v);
    else if (p[p.length - 1] !== v) p.push(lt, v);
    return Float64Array.from(p);
  }
}

/** A track's value at t (ms): linear between points, held past either end. */
export function trackAt(tr, t) {
  if (t <= tr[0]) return tr[1];
  for (let i = 2; i < tr.length; i += 2) {
    if (t < tr[i]) {
      const t0 = tr[i - 2], t1 = tr[i];
      const v0 = tr[i - 1], v1 = tr[i + 1];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    }
  }
  return tr[tr.length - 1];
}

/** The values a vowel starts at, as an onset's next sound. */
const VOWEL_START = Object.freeze({ av: 1, ah: 0, af: 0, nz: 0 });

/**
 * An ONSET consonant's tracks. `first` = nothing precedes it (so a stop has no
 * audible closure); `nx` = the next sound's start values; `k` = the timing
 * scale. Returns {end, w, av, ah, af, nz}.
 */
export function onsetTracks(r, first, nx, k) {
  const w = new FormantTrack(), av = new FormantTrack(), ah = new FormantTrack(), af = new FormantTrack(), nz = new FormantTrack();
  const L = dbGain(r.lvl);
  const tr = r.trans * k, dur = r.dur * k;
  let end;
  switch (r.manner) {
    case MANNER_STOP: {
      const cl = first ? 0 : CLOSURE_MS * k;
      const tb = cl + r.burst * k;
      const tv = tb + r.vot * k;
      if (r.voiced) {
        av.at(0, cl > 0 ? 0.25 : 0.3).at(cl, cl > 0 ? 0.25 : 0.3).at(tb, 0.3).at(tb + 10 * k, nx.av);
      } else {
        av.at(0, 0).at(tv, 0).at(tv + 10 * k, nx.av);
      }
      af.at(0, 0).at(cl, 0).at(cl, L).at(tb, 0.3 * L).at(tb + 2 * k, 0);
      ah.at(0, 0);
      if (!r.voiced && r.vot > 0) {
        const La = L * dbGain(ASPIRATION_DB);
        ah.at(tb, 0).at(tb + 3 * k, La).at(tv, 0.7 * La).at(tv + 10 * k, nx.ah);
      }
      w.at(0, 1).at(tb, 1).at(tb + 1 * k, 0.5).at(tb + tr, 0);
      nz.at(0, 0);
      end = Math.max(tv + 10 * k, tb + tr);
      break;
    }
    case MANNER_AFFRICATE: {
      const cl = first ? 0 : CLOSURE_MS * k;
      const tb = cl + r.burst * k;
      const tf = tb + dur;
      af.at(0, 0).at(cl, 0).at(cl, L).at(tb, 0.8 * L).at(tf - 10 * k, L).at(tf + 10 * k, nx.af);
      if (r.voiced) av.at(0, 0.3).at(tf, 0.3).at(tf + 15 * k, nx.av);
      else av.at(0, 0).at(tf, 0).at(tf + 15 * k, nx.av);
      ah.at(0, 0);
      w.at(0, 1).at(tf, 1).at(tf + tr, 0);
      nz.at(0, 0);
      end = Math.max(tf + 15 * k, tf + tr);
      break;
    }
    case MANNER_FRICATIVE: {
      af.at(0, 0).at(10 * k, L).at(dur - 10 * k, L).at(dur + 10 * k, nx.af);
      if (r.voiced) av.at(0, r.av).at(dur, r.av).at(dur + 15 * k, nx.av);
      else av.at(0, 0).at(dur - 5 * k, 0).at(dur + 15 * k, nx.av);
      ah.at(0, 0);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      nz.at(0, 0);
      end = Math.max(dur + 15 * k, dur + tr);
      break;
    }
    case MANNER_ASPIRATE: {
      ah.at(0, 0).at(10 * k, L).at(dur - 10 * k, L).at(dur + 10 * k, nx.ah);
      if (r.voiced) av.at(0, r.av).at(dur, r.av).at(dur + 10 * k, nx.av);
      else av.at(0, 0).at(dur - 10 * k, 0).at(dur + 10 * k, nx.av);
      af.at(0, 0);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      nz.at(0, 0);
      end = Math.max(dur + 10 * k, dur + tr);
      break;
    }
    case MANNER_NASAL: {
      av.at(0, r.av).at(dur, r.av).at(dur + 10 * k, nx.av);
      nz.at(0, 1).at(dur, 1).at(dur + 10 * k, nx.nz);
      w.at(0, 1).at(dur, 1).at(dur + 5 * k, 0.5).at(dur + tr, 0);
      ah.at(0, 0); af.at(0, 0);
      end = Math.max(dur + 10 * k, dur + tr);
      break;
    }
    case MANNER_APPROX: {
      av.at(0, r.av).at(dur, r.av).at(dur + tr * 0.5, nx.av);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = dur + tr;
      break;
    }
    case MANNER_TAP: {
      av.at(0, 0.2).at(dur, 0.2).at(dur + 5 * k, nx.av);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = Math.max(dur + 5 * k, dur + tr);
      break;
    }
    case MANNER_TRILL: {
      const c = dur;                  // one cycle: closed 3/8, open 5/8
      const shut = c * 0.375;
      av.at(0, 0.12).at(shut, 0.12).at(shut + 3 * k, 0.7).at(c - 3 * k, 0.7)
        .at(c, 0.12).at(c + shut, 0.12).at(c + shut + 3 * k, nx.av);
      const tail = c + shut + 3 * k;
      w.at(0, 1).at(tail, 1).at(tail + tr, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = tail + tr;
      break;
    }
    default: { // MANNER_GLOTTAL: a hard onset, and after a consonant a held glottis
      const cl = first ? 0 : 30 * k;
      av.at(0, 0).at(cl, 0).at(cl + 3 * k, nx.av);
      w.at(0, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = cl + 3 * k;
      break;
    }
  }
  return {
    end,
    w: w.close(end, 0),
    av: av.close(end, nx.av),
    ah: ah.close(end, nx.ah),
    af: af.close(end, nx.af),
    nz: nz.close(end, nx.nz),
  };
}

/** A CODA consonant's tracks: from the vowel's values into silence. */
export function codaTracks(r, k) {
  const w = new FormantTrack(), av = new FormantTrack(), ah = new FormantTrack(), af = new FormantTrack(), nz = new FormantTrack();
  const L = dbGain(r.lvl);
  const tr = r.trans * k, dur = r.dur * k;
  let end;
  switch (r.manner) {
    case MANNER_STOP:
    case MANNER_AFFRICATE: {
      const tc = tr + CLOSURE_MS * k;        // the release
      const tb = tc + r.burst * k;
      w.at(0, 0).at(tr, 0.5).at(tr + 5 * k, 1);
      if (r.voiced) av.at(0, 1).at(tr, 1).at(tr + 8 * k, 0.25).at(tc, 0.2).at(tc + 5 * k, 0);
      else av.at(0, 1).at(tr, 1).at(tr + 8 * k, 0);
      if (r.manner === MANNER_STOP) {
        af.at(0, 0).at(tc, 0).at(tc, 0.7 * L).at(tb, 0.2 * L).at(tb + 2 * k, 0);
        ah.at(0, 0);
        if (!r.voiced && r.vot > 0) {
          const La = L * dbGain(ASPIRATION_DB);
          ah.at(tb, 0).at(tb + 2 * k, 0.5 * La).at(tb + 30 * k, 0);
        }
        end = tb + 35 * k;
      } else {
        af.at(0, 0).at(tc, 0).at(tc, L).at(tb + dur, 0.6 * L).at(tb + dur + 20 * k, 0);
        ah.at(0, 0);
        end = tb + dur + 20 * k;
      }
      nz.at(0, 0);
      break;
    }
    case MANNER_FRICATIVE: {
      const a = Math.max(tr - 15 * k, 0);
      w.at(0, 0).at(tr, 1);
      if (r.voiced) av.at(0, 1).at(tr, r.av).at(tr + dur, 0.7 * r.av).at(tr + dur + 30 * k, 0);
      else av.at(0, 1).at(a, 1).at(tr + 5 * k, 0);
      af.at(0, 0).at(a, 0).at(tr + 5 * k, L).at(tr + dur, 0.8 * L).at(tr + dur + 30 * k, 0);
      ah.at(0, 0); nz.at(0, 0);
      end = tr + dur + 30 * k;
      break;
    }
    case MANNER_ASPIRATE: {
      w.at(0, 0).at(15 * k, 1);
      if (r.voiced) av.at(0, 1).at(20 * k, r.av).at(dur, 0.5 * r.av).at(dur + 20 * k, 0);
      else av.at(0, 1).at(20 * k, 0);
      ah.at(0, 0).at(10 * k, L).at(dur, 0.5 * L).at(dur + 30 * k, 0);
      af.at(0, 0); nz.at(0, 0);
      end = dur + 30 * k;
      break;
    }
    case MANNER_NASAL: {
      w.at(0, 0).at(tr, 1);
      nz.at(0, 0).at(Math.max(tr - 5 * k, 0), 0).at(tr, 1);
      av.at(0, 1).at(tr, r.av).at(tr + dur, 0.8 * r.av).at(tr + dur + 40 * k, 0);
      ah.at(0, 0); af.at(0, 0);
      end = tr + dur + 40 * k;
      break;
    }
    case MANNER_APPROX: {
      w.at(0, 0).at(tr, 1);
      av.at(0, 1).at(tr, r.av).at(tr + dur, 0.8 * r.av).at(tr + dur + 40 * k, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = tr + dur + 40 * k;
      break;
    }
    case MANNER_TAP: {
      w.at(0, 0).at(tr, 1);
      av.at(0, 1).at(tr, 1).at(tr + 3 * k, 0.2).at(tr + dur, 0.2).at(tr + dur + 3 * k, 0.6)
        .at(tr + dur + 40 * k, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = tr + dur + 40 * k;
      break;
    }
    case MANNER_TRILL: {
      const c = dur, shut = c * 0.375;
      w.at(0, 0).at(tr, 1);
      av.at(0, 1).at(tr, 0.7).at(tr + 3 * k, 0.12).at(tr + shut, 0.12).at(tr + shut + 3 * k, 0.7)
        .at(tr + c - 3 * k, 0.7).at(tr + c, 0.12).at(tr + c + shut, 0.12)
        .at(tr + c + shut + 3 * k, 0.6).at(tr + c + shut + 35 * k, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = tr + c + shut + 35 * k;
      break;
    }
    default: { // MANNER_GLOTTAL: the glottis shuts on the vowel
      w.at(0, 0);
      av.at(0, 1).at(6 * k, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = 6 * k;
      break;
    }
  }
  return { end, w: w.close(end, 1), av: av.close(end, 0), ah: ah.close(end, 0), af: af.close(end, 0), nz: nz.close(end, 0) };
}

/** Timing byte → scale on every consonant time. */
export function timingScale(b) {
  return 2 ** ((b - 128) / 64);
}

// ── The sounding voice ──────────────────────────────────────────────────────

export const PHASE_ONSET = 0;
export const PHASE_VOWEL = 1;
export const PHASE_CODA = 2;
export const PHASE_DONE = 3;

/** The vowel normaliser is re-measured every this many control updates. */
const NORM_EVERY = 8;
/** Harmonics the normaliser measures, at most. */
const NORM_HARMONICS = 64;
/** The normaliser's clamp: −48 dB (a fundamental tuned onto F1 is +30 dB
 *  and more) to +24 dB. */
const NORM_MIN = 1 / 256;
const NORM_MAX = 16;
/** Klatt's fixed nasal pole, its bandwidth, and the parallel bank's upper formants. */
const FNP = 270, BNP = 100, BNZ = 100;
const PAR_F = [3300, 3750, 4900], PAR_B = [250, 200, 1000];

/** One consonant as it sounds: its row, its slot's recipe, its tracks. */
class FormantSegment {
  constructor(row, slot, tr) {
    this.row = row;
    this.slot = slot;
    this.end = tr.end;
    this.w = tr.w; this.av = tr.av; this.ah = tr.ah; this.af = tr.af; this.nz = tr.nz;
    this.next = null; // the onset consonant that follows, or null for the vowel
  }
}

/** Per-voice tract state — what the record's sample is played through. */
export class FormantState {
  constructor() {
    this.patch = null;
    this.phase = PHASE_DONE;
    this.onset = [];          // Segment[]
    this.seg = 0;
    this.coda = null;         // Segment, built at note-on
    this.t = 0.0;             // ms into the current segment
    this.codaVeto = false;    // a fade came first: the coda never sounds
    this.fresh = true;        // no control update yet since note-on
    this.upd = 48;            // samples per control update (≈ 1 ms)
    this.ctl = 0;             // samples until the next one
    this.normCount = 0;
    // The vowel, current and gliding (chart bytes, fractional while gliding).
    this.vFront = 0.0; this.vOpen = 0.0; this.vRound = 0.0;
    this.gFront = 0.0; this.gOpen = 0.0; this.gRound = 0.0; // per-ms glide steps
    this.tFront = 0.0; this.tOpen = 0.0; this.tRound = 0.0; // …and where it ends
    this.glideLeft = 0.0;
    // Amplitudes, ramped per sample across an update.
    this.av = 0.0; this.avStep = 0.0;
    this.ah = 0.0; this.ahStep = 0.0;
    this.af = 0.0; this.afStep = 0.0;
    this.nv = 1.0; this.nvStep = 0.0; this.nvGoal = 1.0;
    this.nb = 0.0;                         // parallel bank normaliser
    // Coefficients: cascade NP, NZ (as a resonator's A B C), R5…R1; bank R2…R6.
    this.casc = new Float64Array(21);
    this.bank = new Float64Array(15);
    this.bankGain = new Float64Array(6);   // ±g2 … +g6, gB
    // Filter state.
    this.cy = new Float64Array(14);        // y1,y2 per cascade stage (NZ: x1,x2)
    this.by = new Float64Array(10);
    // Noise reader.
    this.nOn = false;
    this.nBase = 0; this.nSpan = 0; this.nPos = 0.0; this.nStep = 0.0;
    this.nTilt = 0; this.nTiltC = 0.0; this.nGain = 1.0; this.nZ = 0.0;
    // Scratch.
    this.V = new Float64Array(5); this.VB = new Float64Array(5);
    this.F = new Float64Array(5); this.B = new Float64Array(5);
  }
}

/** A deep copy, for an NNA ghost (it keeps sounding the note it was). */
export function cloneFormantState(src, dst = new FormantState()) {
  dst.patch = src.patch;
  dst.phase = src.phase;
  dst.onset = src.onset;          // segments are immutable once built
  dst.seg = src.seg;
  dst.coda = src.coda;
  dst.t = src.t;
  dst.codaVeto = src.codaVeto;
  dst.fresh = src.fresh;
  dst.upd = src.upd; dst.ctl = src.ctl; dst.normCount = src.normCount;
  dst.vFront = src.vFront; dst.vOpen = src.vOpen; dst.vRound = src.vRound;
  dst.gFront = src.gFront; dst.gOpen = src.gOpen; dst.gRound = src.gRound;
  dst.tFront = src.tFront; dst.tOpen = src.tOpen; dst.tRound = src.tRound;
  dst.glideLeft = src.glideLeft;
  dst.av = src.av; dst.avStep = src.avStep;
  dst.ah = src.ah; dst.ahStep = src.ahStep;
  dst.af = src.af; dst.afStep = src.afStep;
  dst.nv = src.nv; dst.nvStep = src.nvStep; dst.nvGoal = src.nvGoal;
  dst.nb = src.nb;
  dst.casc.set(src.casc); dst.bank.set(src.bank); dst.bankGain.set(src.bankGain);
  dst.cy.set(src.cy); dst.by.set(src.by);
  dst.nOn = src.nOn; dst.nBase = src.nBase; dst.nSpan = src.nSpan; dst.nPos = src.nPos;
  dst.nStep = src.nStep; dst.nTilt = src.nTilt; dst.nTiltC = src.nTiltC; dst.nGain = src.nGain;
  dst.nZ = src.nZ;
  return dst;
}

/**
 * Note-on: build the syllable. The onset is slots 0 and 1 in that order,
 * whichever of them name a consonant; the coda is slot 2. Every filter starts
 * from rest — the tract of the note before is not this note's.
 */
export function formantNoteOn(st, patch) {
  st.patch = patch;
  const k = timingScale(patch.timing);
  const rows = [];
  for (let i = 0; i < 2; i++) {
    const r = CONSONANTS[patch.slots[i].cons];
    if (r !== undefined) rows.push([r, patch.slots[i]]);
  }
  // Built back to front: each consonant ends where the next one starts.
  const segs = new Array(rows.length);
  let nx = VOWEL_START;
  let next = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const [r, slot] = rows[i];
    const s = new FormantSegment(r, slot, onsetTracks(r, i === 0, nx, k));
    s.next = next;
    segs[i] = s;
    next = s;
    nx = { av: s.av[1], ah: s.ah[1], af: s.af[1], nz: s.nz[1] };
  }
  st.onset = segs;
  st.seg = 0;
  const cr = CONSONANTS[patch.slots[2].cons];
  st.coda = cr !== undefined ? new FormantSegment(cr, patch.slots[2], codaTracks(cr, k)) : null;
  st.phase = segs.length > 0 ? PHASE_ONSET : PHASE_VOWEL;
  st.t = 0.0;
  st.codaVeto = false;
  st.fresh = true;
  st.upd = Math.max(1, Math.round(SAMPLING_RATE / 1000));
  st.ctl = 0;
  st.normCount = 0;
  st.vFront = patch.front; st.vOpen = patch.open; st.vRound = patch.round;
  st.glideLeft = 0.0;
  st.av = 0.0; st.avStep = 0.0; st.ah = 0.0; st.ahStep = 0.0; st.af = 0.0; st.afStep = 0.0;
  st.nv = 1.0; st.nvStep = 0.0; st.nvGoal = 1.0;
  st.cy.fill(0); st.by.fill(0);
  st.nOn = false; st.nZ = 0.0;
  if (st.phase === PHASE_ONSET) startNoise(st, segs[0]);
}

/**
 * Q's retrigger (tick.js restartVoice): the note says its syllable again from
 * the onset, on the vowel it is singing now — an `S $Afgr` that moved it is
 * not taken back by a stutter.
 */
export function formantRestart(st) {
  if (st.patch === null) return;
  const f = st.vFront, o = st.vOpen, r = st.vRound;
  formantNoteOn(st, st.patch);
  st.vFront = f; st.vOpen = o; st.vRound = r;
}

/**
 * An instrument byte without a retrigger (§5.2): the sounding syllable takes
 * the new record's tract. Its vowel glides to the new default over the new
 * glide time, the pitch rules become the new record's, and a coda that has
 * not begun becomes the new record's coda; consonants already under way
 * finish as they started. Nothing restarts — the note is still sounding.
 */
export function formantRelatch(st, patch) {
  st.patch = patch;
  formantGlideTo(st, patch.open, patch.front, patch.round);
  if (st.phase === PHASE_ONSET || st.phase === PHASE_VOWEL) {
    const cr = CONSONANTS[patch.slots[2].cons];
    st.coda = cr !== undefined
      ? new FormantSegment(cr, patch.slots[2], codaTracks(cr, timingScale(patch.timing))) : null;
  }
}

/** A sampled note handed a formant instrument mid-note: the tract starts at
 *  the vowel, with the coda ready — the note's onset was its sample's. */
export function formantStartAtVowel(st, patch) {
  formantNoteOn(st, patch);
  st.onset = [];
  st.seg = 0;
  st.phase = PHASE_VOWEL;
  st.nOn = false;
}

function formantGlideTo(st, open, front, round) {
  const ms = (st.patch !== null ? st.patch.glide : 0) * 2;
  if (st.fresh || ms <= 0) {
    st.vOpen = open; st.vFront = front; st.vRound = round;
    st.glideLeft = 0.0;
    return;
  }
  st.gOpen = (open - st.vOpen) / ms;
  st.gFront = (front - st.vFront) / ms;
  st.gRound = (round - st.vRound) / ms;
  st.tOpen = open; st.tFront = front; st.tRound = round;
  st.glideLeft = ms;
}

/**
 * S $Afgr: the vowel moves to openness f, frontness g, roundness r (each
 * nibble × 17, so $F is the chart's edge). On the row that triggered the
 * note it is the note's vowel from the start; otherwise it glides there over
 * the record's glide time.
 */
export function formantSetVowel(st, f, g, r) {
  formantGlideTo(st, (f & 15) * 17, (g & 15) * 17, (r & 15) * 17);
}

function startNoise(st, seg) {
  const s = seg.slot;
  st.nOn = false;
  if (!consonantNeedsNoise(seg.row)) return;
  let span = s.len - s.offset;
  const base = s.ptr + s.offset;
  if (base + span > SAMPLE_BIN_TOTAL) span = SAMPLE_BIN_TOTAL - base;
  if (span < 2 || s.rate <= 0) return;
  st.nOn = true;
  st.nBase = base;
  st.nSpan = span;
  st.nPos = 0.0;
  st.nStep = s.rate / SAMPLING_RATE;
  st.nTilt = s.tilt;
  st.nTiltC = Math.abs(s.tilt) / 128;
  st.nGain = attenGainOf(s.gain);
  st.nZ = 0.0;
}

/** The slot's noise, read at its own rate, looped over [offset, end). */
function readNoise(eng, st) {
  const i = Math.trunc(st.nPos);
  const fr = st.nPos - i;
  const bin = eng.sampleBin;
  const a = PCM_U8[bin[st.nBase + i]];
  const b = PCM_U8[bin[st.nBase + (i + 1 < st.nSpan ? i + 1 : 0)]];
  let x = a + (b - a) * fr;
  st.nPos += st.nStep;
  while (st.nPos >= st.nSpan) st.nPos -= st.nSpan;
  if (st.nTilt > 0) {          // pre-emphasis: brighter
    const y = x - st.nTiltC * st.nZ;
    st.nZ = x;
    x = y;
  } else if (st.nTilt < 0) {   // one-pole low-pass: darker
    st.nZ = (1 - st.nTiltC) * x + st.nTiltC * st.nZ;
    x = st.nZ;
  }
  return x * st.nGain;
}

/** Klatt's resonator coefficients (A, B, C) for F, BW at the running rate. */
function setRes(a, i, f, bw) {
  const T = 1 / SAMPLING_RATE;
  const r = Math.exp(-Math.PI * bw * T);
  const c = -(r * r);
  const b = 2 * r * Math.cos(2 * Math.PI * f * T);
  a[i] = 1 - b - c;
  a[i + 1] = b;
  a[i + 2] = c;
}

/** …the same resonator scaled to unit gain AT f, for the parallel bank. */
function setPeakRes(a, i, f, bw) {
  setRes(a, i, f, bw);
  const b = a[i + 1], c = a[i + 2];
  const w = (2 * Math.PI * f) / SAMPLING_RATE;
  const re = 1 - b * Math.cos(w) - c * Math.cos(2 * w);
  const im = b * Math.sin(w) + c * Math.sin(2 * w);
  a[i] = Math.sqrt(re * re + im * im);
}

/** White-noise power gain of a resonator (A, B, C): Σ h[n]². */
function resPower(a, i) {
  const A = a[i], a1 = -a[i + 1], a2 = -a[i + 2];
  return (A * A * (1 + a2)) / ((1 - a2) * ((1 + a2) * (1 + a2) - a1 * a1));
}

const normCo = new Float64Array(15);

/**
 * The vowel normaliser: what makes a sawtooth come out of the cascade at the
 * RMS it went in with, at this f0 — so the tract shapes the sound and does not
 * set its level. P = Σ |H(k·f0)|² ÷ k² over the harmonics below 45% of the
 * rate (at most 64), against Σ 1 ÷ k²; clamped to −48…+24 dB.
 */
function vowelNorm(F, B, f0) {
  if (!(f0 > 0)) return 1.0;
  const R = SAMPLING_RATE;
  const K = Math.max(1, Math.min(NORM_HARMONICS, Math.floor((0.45 * R) / f0)));
  const co = normCo;
  for (let n = 0; n < 5; n++) setRes(co, n * 3, F[n], B[n]);
  const w0 = (2 * Math.PI * f0) / R;
  const c1 = Math.cos(w0), s1 = Math.sin(w0);
  let ck = c1, sk = s1;
  let p = 0.0, ref = 0.0;
  for (let k = 1; k <= K; k++) {
    const c2 = ck * ck - sk * sk, s2 = 2 * sk * ck;
    let h = 1.0;
    for (let n = 0; n < 5; n++) {
      const A = co[n * 3], b = co[n * 3 + 1], c = co[n * 3 + 2];
      const re = 1 - b * ck - c * c2;
      const im = b * sk + c * s2;
      h *= (A * A) / (re * re + im * im);
    }
    const wk = 1 / (k * k);
    p += h * wk;
    ref += wk;
    const nc = ck * c1 - sk * s1;
    sk = sk * c1 + ck * s1;
    ck = nc;
  }
  const g = p > 0 ? Math.sqrt(ref / p) : NORM_MAX;
  return Math.min(Math.max(g, NORM_MIN), NORM_MAX);
}

/** The fundamental the source is sounding at, Hz. */
function voiceF0(voice) {
  const rate = voice.activeSamplingRate;
  return rate > 0 ? (voice.currentPlaybackRate * SAMPLING_RATE * LINEAR_FREQ_C4_HZ) / rate : 0.0;
}

/** Values of a segment's amplitude tracks at t into a 4-slot scratch. */
const ampNow = new Float64Array(4);
const ampNext = new Float64Array(4);
function segAmps(seg, t, out) {
  out[0] = trackAt(seg.av, t);
  out[1] = trackAt(seg.ah, t);
  out[2] = trackAt(seg.af, t);
  return out;
}

/**
 * Configure the tract for this update: the consonant's own tract blended with
 * the next sound's by w. `cfg` = [F1 F2 F3 B1 B2 B3] of the consonant at this
 * voice's size, a zero meaning "the vowel's".
 */
function blendInto(row, w, s, F, B, NF, NB) {
  for (let n = 0; n < 3; n++) {
    const cf = row.F[n] > 0 ? row.F[n] * s : NF[n];
    const cb = row.B[n] > 0 ? row.B[n] * s : NB[n];
    F[n] = NF[n] + w * (cf - NF[n]);
    B[n] = NB[n] + w * (cb - NB[n]);
  }
  F[3] = NF[3]; F[4] = NF[4]; B[3] = NB[3]; B[4] = NB[4];
}

const nextF = new Float64Array(5), nextB = new Float64Array(5);

/** One control update (≈ 1 ms): the sequencer, the vowel, the coefficients. */
function formantControl(voice, st) {
  const upd = st.upd;
  const dt = (upd * 1000) / SAMPLING_RATE;
  st.ctl = upd;
  const patch = st.patch;

  // A fade before the coda has started takes the coda away for good.
  if (voice.noteFading && st.phase !== PHASE_CODA) st.codaVeto = true;
  // Sequencer: walk past finished onset consonants into the vowel.
  while (st.phase === PHASE_ONSET && st.t >= st.onset[st.seg].end) {
    st.t -= st.onset[st.seg].end;
    st.seg++;
    if (st.seg >= st.onset.length) { st.phase = PHASE_VOWEL; st.nOn = false; }
    else startNoise(st, st.onset[st.seg]);
  }
  if (st.phase === PHASE_VOWEL && voice.keyOff && !st.codaVeto && st.coda !== null) {
    st.phase = PHASE_CODA;
    st.t = 0.0;
    startNoise(st, st.coda);
  }
  if (st.phase === PHASE_CODA && st.t >= st.coda.end) {
    st.phase = PHASE_DONE;
    st.av = 0; st.avStep = 0; st.ah = 0; st.ahStep = 0; st.af = 0; st.afStep = 0;
    st.nOn = false;
    startRampOut(voice);
    return;
  }

  // The vowel: glide, then the pitch rules.
  if (st.glideLeft > 0) {
    if (st.glideLeft <= dt) {           // the last step lands exactly
      st.vOpen = st.tOpen; st.vFront = st.tFront; st.vRound = st.tRound;
      st.glideLeft = 0.0;
    } else {
      st.vOpen += st.gOpen * dt;
      st.vFront += st.gFront * dt;
      st.vRound += st.gRound * dt;
      st.glideLeft -= dt;
    }
  }
  const f0 = voiceF0(voice);
  const V = st.V, VB = st.VB;
  const s = vowelAtPitch(st.vFront, st.vOpen, st.vRound, f0, noteHz(patch.refNote), patch.track, V, VB);
  if (st.fresh || st.normCount <= 0) {
    st.nvGoal = vowelNorm(V, VB, f0);
    st.normCount = NORM_EVERY;
  }
  st.normCount--;
  const nvEnd = st.fresh ? st.nvGoal : st.nv + (st.nvGoal - st.nv) * 0.25;
  if (st.fresh) st.nv = nvEnd;

  // The tract this update.
  const F = st.F, B = st.B;
  let nzAmt = 0.0;
  let seg = null;
  if (st.phase === PHASE_ONSET) {
    seg = st.onset[st.seg];
    // The sound this consonant is heading for: the next consonant as it
    // starts, or the vowel.
    if (seg.next !== null) blendInto(seg.next.row, seg.next.w[1], s, nextF, nextB, V, VB);
    else { nextF.set(V); nextB.set(VB); }
    blendInto(seg.row, trackAt(seg.w, st.t), s, F, B, nextF, nextB);
    nzAmt = trackAt(seg.nz, st.t);
    segAmps(seg, st.t, ampNow);
    segAmps(seg, st.t + dt, ampNext);
  } else if (st.phase === PHASE_CODA) {
    seg = st.coda;
    blendInto(seg.row, trackAt(seg.w, st.t), s, F, B, V, VB);
    nzAmt = trackAt(seg.nz, st.t);
    segAmps(seg, st.t, ampNow);
    segAmps(seg, st.t + dt, ampNext);
  } else {
    F.set(V); B.set(VB);
    ampNow[0] = 1; ampNow[1] = 0; ampNow[2] = 0;
    ampNext[0] = 1; ampNext[1] = 0; ampNext[2] = 0;
  }
  const ceil = 0.45 * SAMPLING_RATE;
  const casc = st.casc;
  const fnp = Math.min(FNP * s, ceil);
  const fnz = seg !== null && seg.row.fnz > 0 ? Math.min(seg.row.fnz * s, ceil) : fnp;
  setRes(casc, 0, fnp, BNP * s);
  setRes(casc, 3, fnp + nzAmt * (fnz - fnp), BNZ * s);
  for (let n = 0; n < 5; n++) {
    setRes(casc, 6 + (4 - n) * 3, Math.min(F[n], ceil), Math.min(B[n], ceil));
  }
  // The parallel bank, while a consonant can be fricating.
  if (seg !== null && st.nOn) {
    const bank = st.bank, g = st.bankGain, a = seg.row.bank;
    setPeakRes(bank, 0, Math.min(F[1], ceil), Math.min(B[1], ceil));
    setPeakRes(bank, 3, Math.min(F[2], ceil), Math.min(B[2], ceil));
    for (let j = 0; j < 3; j++) {
      setPeakRes(bank, 6 + j * 3, Math.min(PAR_F[j] * s, ceil), Math.min(PAR_B[j] * s, ceil));
    }
    let pw = 0.0;
    for (let j = 0; j < 5; j++) {
      const gj = a[j] > 0 ? dbGain(a[j] - 60) : 0;
      g[j] = (j & 1) === 0 ? gj : -gj;
      pw += gj * gj * resPower(bank, j * 3);
    }
    g[5] = a[5] > 0 ? dbGain(a[5] - 60) : 0;
    pw += g[5] * g[5];
    st.nb = pw > 0 ? 1 / Math.sqrt(pw) : 0;
  }

  // Ramps across the update.
  const inv = 1 / upd;
  st.av = ampNow[0]; st.avStep = (ampNext[0] - ampNow[0]) * inv;
  st.ah = ampNow[1]; st.ahStep = (ampNext[1] - ampNow[1]) * inv;
  st.af = ampNow[2]; st.afStep = (ampNext[2] - ampNow[2]) * inv;
  st.nvStep = (nvEnd - st.nv) * inv;
  st.fresh = false;
  if (st.phase !== PHASE_VOWEL) st.t += dt;
}

/** One cascade stage: y = A·x + B·y1 + C·y2. */
function tractRes(co, i, cy, j, x) {
  const y = co[i] * x + co[i + 1] * cy[j] + co[i + 2] * cy[j + 1];
  cy[j + 1] = cy[j];
  cy[j] = y;
  return y;
}

/**
 * One output sample of a voice sounding a formant instrument: the source
 * fetched as any sample is, through the cascade with the aspiration, plus the
 * frication through the parallel bank. The mixer applies the filter, the voice
 * FX and every gain after this, exactly as for a sampled voice.
 */
export function renderFormantVoice(eng, voice, inst, interpMode) {
  const st = voice.formant;
  const g = fetchTrackerSample(eng, voice, inst, interpMode);
  if (st.phase === PHASE_DONE) return 0.0;
  if (st.ctl <= 0) {
    formantControl(voice, st);
    if (st.phase === PHASE_DONE) return 0.0;
  }
  st.ctl--;
  const n = st.nOn ? readNoise(eng, st) : 0.0;
  const casc = st.casc, cy = st.cy;
  let x = st.av * g + st.ah * n;
  x = tractRes(casc, 0, cy, 0, x);                    // nasal pole
  {                                              // nasal zero: the inverse
    const A = casc[3], b = casc[4], c = casc[5]; //   of its resonator
    const y = (x - b * cy[2] - c * cy[3]) / A;
    cy[3] = cy[2];
    cy[2] = x;
    x = y;
  }
  x = tractRes(casc, 6, cy, 4, x);                    // F5
  x = tractRes(casc, 9, cy, 6, x);                    // F4
  x = tractRes(casc, 12, cy, 8, x);                   // F3
  x = tractRes(casc, 15, cy, 10, x);                  // F2
  x = tractRes(casc, 18, cy, 12, x);                  // F1
  let out = st.nv * x;
  if (st.nOn) {
    const bank = st.bank, by = st.by, gb = st.bankGain;
    let f = gb[5] * n;
    for (let j = 0; j < 5; j++) {
      const i = j * 3;
      const y = bank[i] * n + bank[i + 1] * by[j * 2] + bank[i + 2] * by[j * 2 + 1];
      by[j * 2 + 1] = by[j * 2];
      by[j * 2] = y;
      f += gb[j] * y;
    }
    out += st.af * st.nb * f;
  }
  st.av += st.avStep;
  st.ah += st.ahStep;
  st.af += st.afStep;
  st.nv += st.nvStep;
  return out;
}
