// Metainstrument type 1 — the FORMANT INSTRUMENT (item 212; TAUD_FILE_FORMAT §7.6,
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
import { OplState, oplKeyOn, oplRender, OPL_C4_RATE } from "./opl.js";
import {
  isPsgPatch, newChipState, chipStateFits, chipKeyOn, chipRender, chipAlive,
  cloneChipState, chipSoundKey,
} from "./chip.js";

// ── The record ──────────────────────────────────────────────────────────────

/** Byte 0's type nibble for this kind (§7.4). */
export const META_TYPE_FORMANT = 1;
/** Bytes 0…3: the type, the source instrument (none), and the metainstrument
 *  sentinel. */
export const FORMANT_RECORD_HEADER = Object.freeze([0x10, 0x00, 0xff, 0xff]);

/**
 * The SOURCE INSTRUMENT a type-1 record names in its header (§7.6): bits 0…7
 * in byte 1, bits 8…9 in byte 0's two low bits. 0 is none — the record's own
 * sample is the glottal source, as it always was. Anything else names an
 * instrument whose voice is the source instead, which has to be one of the
 * chip kinds (OPL, PSG); a record naming anything else sings with its sample.
 */
export function formantSourceInstOf(b0, b1) {
  return ((b0 & 0x03) << 8) | (b1 & 0xff);
}

/**
 * The instrument a formant instrument `inst` is sung from, out of
 * `instruments`, or null when it sings with its own sample: the header names
 * none, or names itself, or names an instrument that is not a chip one. An
 * OPL or PSG instrument is a sound generator in its own right, so its voice
 * can be the glottal source where a sample would be; anything built out of
 * sources cannot.
 */
export function formantChipSource(instruments, inst) {
  const i = inst.formant.srcInst;
  if (i < 1 || i > 1023 || i === inst.index) return null;
  const src = instruments[i];
  return src !== undefined && src !== null && src.chipPatch !== null ? src : null;
}

/** The rate a chip source plays the part of the sample's rate at C4 with:
 *  its own C2SPD, 0 reading as the tracker convention, as on the chip
 *  instrument itself (§7.8). */
export function formantChipRate(src) {
  return src.samplingRate === 0 ? OPL_C4_RATE : src.samplingRate;
}
/** The tract block takes the second pitch/filter slot, as OPL's patch does. */
export const FORMANT_BLOCK_START = 197;
export const FORMANT_BLOCK_LEN = 54;

/** Offsets inside the block. */
export const FB_SOURCE = 0;     // U24 pool pointer of the glottal source
export const FB_FRONT = 3;      // U8 vowel: frontness of the tongue
export const FB_OPEN = 4;       // U8 vowel: openness (height) of the tongue
export const FB_ROUND = 5;      // U8 vowel: rounding of the lips
export const FB_TRACK = 6;      // U8 size tracking: exponent = byte ÷ 256
export const FB_REF = 7;        // U16 reference note (bits 0–14; 0 = no vowel) and nasalisation (bit 15)
export const FB_GLIDE = 9;      // U8 vowel glide for S $Afgr, in 2 ms units
export const FB_TIMING = 10;    // U8 consonant timing: scale = 2^((byte − 128) ÷ 64)
export const FB_RANGE_LO = 11;  // U24 the pool range the instrument is made from (editor's)
export const FB_RANGE_HI = 14;  // U24 …its exclusive end
export const FB_SLOTS = 17;     // three consonant slots, 12 bytes each
export const FB_GR = 53;        // U8 the glide (bits 0–2), the onset's secondary articulation
                                //   (bits 3–4), the coda's release (bits 5–6) and rhoticity (bit 7)
export const FORMANT_SLOTS = 3; // onset C1, onset C2, coda C
export const FORMANT_SLOT_BYTES = 12;

/** The reference note a record with NO vowel (reference bits 0…14 all 0)
 *  sizes its consonants by: C3, a man's speaking pitch, the default. */
export const FORMANT_DEFAULT_REF = 0x4000;

/** The onset's secondary articulation (FB_GR bits 3–4), and the coda's own
 *  articulation (bits 5–6), which shares the two in the middle. */
export const ART_NONE = 0;
export const ART_PALATAL = 1;    // ʲ — the tongue body raised as for [i]
export const ART_DARK = 2;       // ˠ / ˤ — the back of the tongue drawn back
export const ART_GLOTTAL = 3;    // ˀ — a glottal closure with the consonant
export const CODA_RELEASED = 0;
export const CODA_UNRELEASED = 1; // ̚ — a stop's closure is never released
export const CODA_DARK = 2;
export const CODA_GLOTTAL = 3;

/** One consonant slot: which consonant, and the recipe it is sounded with. A
 *  slot with no sample (length 0) sounds the engine's own noise generator. */
export class FormantSlot {
  constructor() {
    this.cons = 0;    // consonant id (CONSONANTS), 0 = none
    this.ptr = 0;     // noise sample: pool pointer…
    this.len = 0;     // …and length in bytes (the whole census sample); 0 = the generator
    this.offset = 0;  // where in it the noise starts
    this.rate = 0;    // the rate it is read at, Hz — the recipe's speed
    this.tilt = 0;    // S8 spectral tilt: + brightens, − darkens
    this.gain = 0;    // decibel octet (§7.10), 0 = unity
  }
}

/** The decoded block. Updated IN PLACE on every write, so a sounding voice
 *  hears an edit at once (the same contract as OPL's patch). */
export class FormantPatch {
  constructor() {
    this.srcPtr = 0;
    this.srcInst = 0;      // the header's source instrument (formantSourceInstOf), 0 = the sample
    this.front = 200;
    this.open = 255;
    this.round = 0;
    this.track = 64;
    this.refNote = 0x4000; // bits 0…14 of the word; 0 = the syllable has NO vowel (formantHasVowel)
    this.nasal = false;    // bit 15: the vowel nasalised
    this.glide = 20;
    this.timing = 128;
    this.semivowel = 0;    // G: 0 none, 1 [j], 2 [ɥ], 3 [ɰ], 4 [w] (SEMIVOWELS)
    this.rhotic = false;   // R: the vowel r-coloured
    this.secondary = 0;    // the onset's last consonant: ART_NONE / _PALATAL / _DARK / _GLOTTAL
    this.codaArt = 0;      // the coda: CODA_RELEASED / _UNRELEASED / _DARK / _GLOTTAL
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
  const ref = fu16(raw, off + FB_REF);
  patch.refNote = ref & 0x7fff;
  patch.nasal = (ref & 0x8000) !== 0;
  patch.glide = raw[off + FB_GLIDE] & 0xff;
  patch.timing = raw[off + FB_TIMING] & 0xff;
  patch.rangeLo = fu24(raw, off + FB_RANGE_LO);
  patch.rangeHi = fu24(raw, off + FB_RANGE_HI);
  const gr = raw[off + FB_GR] & 0xff;
  patch.semivowel = (gr & 7) <= 4 ? gr & 7 : 0;
  patch.secondary = (gr >>> 3) & 3;
  patch.codaArt = (gr >>> 5) & 3;
  patch.rhotic = (gr & 0x80) !== 0;
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

/** Write `patch` as a 54-byte block into `out[off…]`. */
export function encodeFormantBlock(patch, out = new Uint8Array(FORMANT_BLOCK_LEN), off = 0) {
  const p24 = (o, v) => { out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; out[o + 2] = (v >>> 16) & 0xff; };
  const p16 = (o, v) => { out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; };
  p24(off + FB_SOURCE, patch.srcPtr);
  out[off + FB_FRONT] = patch.front & 0xff;
  out[off + FB_OPEN] = patch.open & 0xff;
  out[off + FB_ROUND] = patch.round & 0xff;
  out[off + FB_TRACK] = patch.track & 0xff;
  p16(off + FB_REF, (patch.refNote & 0x7fff) | (patch.nasal ? 0x8000 : 0));
  out[off + FB_GLIDE] = patch.glide & 0xff;
  out[off + FB_TIMING] = patch.timing & 0xff;
  p24(off + FB_RANGE_LO, patch.rangeLo);
  p24(off + FB_RANGE_HI, patch.rangeHi);
  out[off + FB_GR] = (patch.semivowel & 7) | ((patch.secondary & 3) << 3) | ((patch.codaArt & 3) << 5) |
    (patch.rhotic ? 0x80 : 0);
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
  return out;
}

/** Does the record's syllable have a vowel? Without one (reference note 0) it
 *  is a SYLLABIC CONSONANT: its last onset consonant is held as the nucleus. */
export function formantHasVowel(patch) {
  return patch.refNote !== 0;
}

/** The reference note the record's formants are sized by. */
export function formantRefNote(patch) {
  return patch.refNote !== 0 ? patch.refNote : FORMANT_DEFAULT_REF;
}

// ── The vowel ───────────────────────────────────────────────────────────────
//
// A vowel is where the TONGUE is — how open (height) and how front — and what
// the LIPS do — how rounded — the three things the IPA chart describes a vowel
// by. The sound is read off Catford's measurements of the sixteen cardinal
// vowels for a man's speech (A Practical Introduction to Phonetics, 2nd ed.,
// p. 154), which give each tongue position twice, spread and rounded:
//
//   height        front spread  front round   back spread   back round
//   close         i  240 2400   y  235 2100   ɯ  300 1390   u  250  595
//   close-mid     e  390 2300   ø  370 1900   ɤ  460 1310   o  360  640
//   open-mid      ɛ  610 1900   œ  585 1710   ʌ  600 1170   ɔ  500  700
//   open          a  850 1610   ɶ  820 1530   ɑ  750  940   ɒ  700  760
//
// The four heights sit at openness 0, 85, 170 and 255. F1 and F2 are
// interpolated in log frequency: linearly through the heights, and bilinearly
// across frontness and roundness between the four columns — so every cardinal
// vowel is exactly where Catford measured it, and rounding a vowel moves all
// of its formants down by what his pairs say rounding does: a little for [i]
// → [y] (F2 −12%), a great deal for [ɯ] → [u] (F2 −57%). The sound is shown on
// Lindsey's acoustic chart (log F1 down, log F2 right to left), where the
// lips visibly move it.

/** Catford's cardinal vowels: [height][spread front, round front, spread back,
 *  round back] as [F1, F2] Hz. */
export const CARDINAL_VOWELS = Object.freeze([
  [[240, 2400], [235, 2100], [300, 1390], [250, 595]],
  [[390, 2300], [370, 1900], [460, 1310], [360, 640]],
  [[610, 1900], [585, 1710], [600, 1170], [500, 700]],
  [[850, 1610], [820, 1530], [750, 940], [700, 760]],
]);
const LOG_CARD = CARDINAL_VOWELS.map((row) => row.map(([f1, f2]) => [Math.log(f1), Math.log(f2)]));

/** F1 and F2 (Hz) of the tongue at (front, open) with the lips at `round`,
 *  all three bytes 0…255 (fractions allowed), into out[0], out[1]. */
export function vowelF1F2(front, open, round, out = new Float64Array(2)) {
  const x = Math.min(Math.max(front / 255, 0), 1);
  const r = Math.min(Math.max(round / 255, 0), 1);
  const h = Math.min(Math.max(open / 255, 0), 1) * 3;
  const i = Math.min(2, Math.floor(h));
  const u = h - i;
  // Corner weights: front spread, front round, back spread, back round.
  const w0 = x * (1 - r), w1 = x * r, w2 = (1 - x) * (1 - r), w3 = (1 - x) * r;
  for (let n = 0; n < 2; n++) {
    const lo = LOG_CARD[i], hi = LOG_CARD[i + 1];
    const at = (c) => lo[c][n] + (hi[c][n] - lo[c][n]) * u;
    out[n] = Math.exp(w0 * at(0) + w1 * at(1) + w2 * at(2) + w3 * at(3));
  }
  return out;
}

const f1f2 = new Float64Array(2);
/** F1 alone, for the jaw rule below. */
function vowelF1At(front, open, round) {
  return vowelF1F2(front, open, round, f1f2)[0];
}

/**
 * The inverse, for editors: the (front, open) — fractional bytes — that sound
 * nearest to F1/F2 with the lips at `round`, as [front, open]. A point the
 * lips cannot reach lands on the nearest one they can.
 */
export function vowelCoordsOf(f1, f2, round = 0) {
  const t1 = Math.log(f1), t2 = Math.log(f2);
  const err = (x, h) => {
    vowelF1F2(x, h, round, f1f2);
    const d1 = Math.log(f1f2[0]) - t1, d2 = Math.log(f1f2[1]) - t2;
    return d1 * d1 + d2 * d2;
  };
  let bx = 0, bh = 0, be = Infinity;
  for (let x = 0; x <= 255; x += 15) {
    for (let h = 0; h <= 255; h += 15) {
      const e = err(x, h);
      if (e < be) { be = e; bx = x; bh = h; }
    }
  }
  // Refine: a shrinking pattern search inside the square.
  for (let step = 8; step >= 1 / 16; step /= 2) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [dx, dh] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const x = Math.min(255, Math.max(0, bx + dx)), h = Math.min(255, Math.max(0, bh + dh));
        const e = err(x, h);
        if (e < be - 1e-15) { be = e; bx = x; bh = h; moved = true; }
      }
    }
  }
  return [bx, bh];
}

/** R-colouring, from Hillenbrand et al. 1995's [ɝ] ("heard") for men, mean of
 *  45: F1 475, F2 1379, F3 1711, F4 3335 Hz. Its F3 is the target, its F3 ÷ F2
 *  the closest F2 may come under it, its F4 the ceiling for F4. */
export const RHOTIC_F3 = 1711;
const RHOTIC_F2 = 1379;
const RHOTIC_F4 = 3335;

/**
 * The vowel's five formants at the reference pitch, into F (Hz). F1 and F2
 * from the cardinal vowels above. F3 rides above F2 — max(2500, F2 + 700)
 * spread, as the American English front vowels have it (Hillenbrand et al.
 * 1995), closing in on F2 rounded, max(2200, F2 + 250), as French [y] and
 * Klatt's [u] have it — interpolated in log frequency by roundness. F4 and F5
 * are Praat's VowelEditor defaults, held clear above F3.
 *
 * R-coloured (`rhotic`), F3 falls to [ɝ]'s, F2 is held under it in [ɝ]'s
 * proportion — a front vowel r-coloured is pulled back — and F4 under [ɝ]'s:
 * [ə] r-coloured is Hillenbrand's [ɝ]. F1 is the vowel's own.
 */
export function vowelFormants(front, open, round, F, rhotic = false) {
  vowelF1F2(front, open, round, f1f2);
  const f1 = f1f2[0];
  let f2 = f1f2[1];
  const f3u = Math.max(2500, f2 + 700);
  const f3r = Math.max(2200, f2 + 250);
  let f3 = f3u * (f3r / f3u) ** (Math.min(Math.max(round, 0), 255) / 255);
  if (rhotic) {
    f3 = Math.min(f3, RHOTIC_F3);
    f2 = Math.min(f2, (f3 * RHOTIC_F2) / RHOTIC_F3);
  }
  let f4 = Math.max(3500, f3 + 400);
  if (rhotic) f4 = Math.min(f4, RHOTIC_F4);
  const f5 = Math.max(4500, f4 + 500);
  F[0] = f1; F[1] = f2; F[2] = f3; F[3] = f4; F[4] = f5;
  return F;
}

/** A note word's frequency on the 12-TET grid C4 = 261.63 Hz. */
export function noteHz(note) {
  return LINEAR_FREQ_C4_HZ * 2 ** ((note - MIDDLE_C) / 4096);
}

/**
 * The vowel at a pitch: the vowel (front, open, round) sung at f0 (Hz), into
 * F (formants) and B (bandwidths), Hz. Returns the size scale.
 *
 *  1. SIZE. Every formant scales by (f0 ÷ ref)^k, k = track ÷ 256. Between
 *     speakers formants rise as about the 0.30 power of f0 (Hillenbrand et al.
 *     1995: women 0.28–0.31 over men, children 0.33–0.42); between a choir's
 *     parts somewhat less (the singer's formant, bass to soprano, Scientific
 *     Reports 2022: about 0.22–0.27). The record's default, 64, is ¼.
 *  2. R1:f0 TUNING. Once f0 passes F1, the singer tunes F1 to it (Joliveau,
 *     Smith & Wolfe 2004; Henrich, Smith & Wolfe 2011: sopranos, and altos in
 *     their upper range). The gesture is the jaw, so the vowel OPENS —
 *     frontness and lips kept — until its F1 is f0: the openness is found by
 *     bisection (24 halvings over [open, 255], F1 rising with openness). F2
 *     follows: it rises for a back vowel (the incidental R2 rise those papers
 *     report) and falls for a front one, which is the [i]→[ɛ] modification a
 *     soprano's high [i] is heard to make. Fully open, F1 alone goes on
 *     following f0.
 *  3. ORDER. Each formant is held at least 15% above the one below it, and
 *     none above 45% of the output rate.
 *
 * `rhotic` r-colours the vowel (vowelFormants) before any of it.
 *
 * Bandwidths are then F ÷ 10 (Praat's VowelEditor Q of 10) with a 50 Hz
 * floor (Klatt's B1 for a close vowel).
 */
export function vowelAtPitch(front, open, round, f0, refHz, track, F, B, rhotic = false) {
  const s = f0 > 0 && refHz > 0 ? (f0 / refHz) ** (track / 256) : 1.0;
  let o = open;
  const tuned = f0 > vowelF1At(front, open, round) * s;
  if (tuned) {
    const want = f0 / s;
    if (vowelF1At(front, 255, round) <= want) {
      o = 255;
    } else {
      let a = open, b = 255;
      for (let i = 0; i < 24; i++) {
        const m = (a + b) / 2;
        if (vowelF1At(front, m, round) < want) a = m; else b = m;
      }
      o = (a + b) / 2;
    }
  }
  vowelFormants(front, o, round, F, rhotic);
  for (let n = 0; n < 5; n++) F[n] *= s;
  if (tuned) F[0] = f0;   // exactly, whatever the bisection's last bit (and fully open, past it)
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
//
// Klatt's table is "appropriate only for consonants before front vowels", and
// a VELAR is where that matters: the tongue's back meets the palate wherever
// the vowel puts it, so a velar's F2 and F3 are the vowel's, drawn together
// (the "velar pinch"), not a place of their own — locus equations put a
// velar's F2 at voicing onset within a few hundred Hz of the vowel's, slope
// ≈ 0.9–1.0 (Sussman et al. 1991; Iskarous et al. 2010), where an alveolar's
// is pulled to ≈ 1.8 kHz (slope ≈ 0.4–0.5). Rows marked `dorsal` take their
// F2/F3 from the sound they meet (blendInto). And a velar's burst excites the
// resonance of the cavity in front of the closure, which is F2 before a
// non-front vowel — "A2 should be set to about 60 dB" (Klatt 1980 §V.B):
// `bankBack` — and F3 before a front one, where the table gives A3 53. That
// 53 was set on a synthesiser running at 10 kHz, whose output stopped at
// 5 kHz; here the upper resonators' skirts run on to 6 kHz and more and
// outweigh it, and the burst comes out spread over 3–5 kHz like a [t]'s. So
// the front cavity is given Klatt's 60 dB front or back: k ɡ kʰ bursts are
// compact, at 1.0–1.3 kHz before [u] [o] [ɑ] and 2.3–3 kHz before [a] [e] [i].

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
const K_K_FRONT = [0, 60, 43, 45, 45, 0];
const K_K_BACK = [60, 53, 43, 45, 45, 0];
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
 * nasals, approximants); `fnz` a nasal's zero. `dorsal`: the place follows
 * the vowel (a velar); `bankBack`: the bank before a back vowel, or null.
 */
function consRow(id, ipa, manner, voiced, place, F, B, bank, lvl, dur, burst, vot, trans, av = 0, fnz = 0,
  { dorsal = false, bankBack = null } = {}) {
  return Object.freeze({ id, ipa, manner, voiced, place, F, B, bank, lvl, dur, burst, vot, trans, av, fnz, dorsal, bankBack });
}
const FMT_VELAR_STOP = Object.freeze({ dorsal: true, bankBack: K_K_BACK });
const FMT_VELAR = Object.freeze({ dorsal: true });

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
  consRow(9, "k", MN_S, false, PLACE_VELAR, [300, 1990, 2850], [250, 160, 330], K_K_FRONT, -10, 0, 20, 25, 50, 0, 0, FMT_VELAR_STOP),
  consRow(10, "ɡ", MN_S, true, PLACE_VELAR, [200, 1990, 2850], [60, 150, 280], K_K_FRONT, -12, 0, 15, 0, 50, 0, 0, FMT_VELAR_STOP),
  consRow(11, "q", MN_S, false, PLACE_UVULAR, [400, 1200, 2400], [250, 150, 300], K_UVULAR, -10, 0, 20, 25, 50),
  consRow(12, "ɢ", MN_S, true, PLACE_UVULAR, [250, 1200, 2400], [60, 120, 250], K_UVULAR, -12, 0, 15, 0, 50),
  consRow(13, "ʔ", MN_Q, false, PLACE_GLOTTAL, [0, 0, 0], [0, 0, 0], K_NONE, 0, 0, 0, 0, 0),
  consRow(14, "pʰ", MN_S, false, PLACE_BILABIAL, [400, 1100, 2150], [300, 150, 220], K_LABIAL, -12, 0, 5, 58, 40),
  consRow(15, "tʰ", MN_S, false, PLACE_ALVEOLAR, [400, 1600, 2600], [300, 120, 250], K_T, -10, 0, 10, 70, 45),
  consRow(16, "kʰ", MN_S, false, PLACE_VELAR, [300, 1990, 2850], [250, 160, 330], K_K_FRONT, -10, 0, 20, 80, 50, 0, 0, FMT_VELAR_STOP),
  // Nasals — Klatt's murmur: F1 480 cancelled by a zero at 450 Hz, leaving
  // the nasal pole at 270 Hz; place is the wide-bandwidth F2/F3.
  consRow(32, "m", MN_N, true, PLACE_BILABIAL, [480, 1270, 2130], [40, 200, 200], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(33, "ɱ", MN_N, true, PLACE_LABIODENTAL, [480, 1200, 2100], [40, 200, 200], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(34, "n", MN_N, true, PLACE_ALVEOLAR, [480, 1340, 2470], [40, 300, 300], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(35, "ɳ", MN_N, true, PLACE_RETROFLEX, [480, 1400, 1900], [40, 300, 300], K_NONE, 0, 60, 0, 0, 35, 0.5, 450),
  consRow(36, "ɲ", MN_N, true, PLACE_PALATAL, [480, 2000, 2900], [40, 300, 300], K_NONE, 0, 60, 0, 0, 40, 0.5, 450),
  consRow(37, "ŋ", MN_N, true, PLACE_VELAR, [480, 1900, 2700], [40, 300, 300], K_NONE, 0, 60, 0, 0, 40, 0.5, 450, FMT_VELAR),
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
  consRow(62, "x", MN_FR, false, PLACE_VELAR, [300, 1700, 2600], [200, 150, 300], K_X, -14, 110, 0, 0, 45, 0, 0, FMT_VELAR),
  consRow(63, "ɣ", MN_FR, true, PLACE_VELAR, [240, 1700, 2600], [60, 150, 300], K_X, -18, 80, 0, 0, 45, 0.35, 0, FMT_VELAR),
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
  consRow(105, "k͡x", MN_AF, false, PLACE_VELAR, [300, 1800, 2700], [250, 160, 330], K_X, -12, 70, 20, 0, 50, 0, 0, FMT_VELAR),
];

/** id → row, for every id the format defines; undefined elsewhere. */
export const CONSONANTS = (() => {
  const t = new Array(256).fill(undefined);
  for (const r of ROWS) t[r.id] = r;
  return Object.freeze(t);
})();

/** Every defined consonant, in id order (for editors). */
export const CONSONANT_LIST = Object.freeze(ROWS.slice());

/**
 * The glides — CCGVRC's G: a semivowel is its vowel said without being the
 * syllable's peak, so each starts ON its syllabic counterpart's chart point
 * and glides into the vowel. Timing and voicing are the approximant's own row
 * (`row`: its steady `dur`, its transition `trans`, its voicing `av`). By the
 * record's code (FB_GR bits 0–2); 0 is none.
 */
export const SEMIVOWELS = Object.freeze([
  null,
  Object.freeze({ code: 1, ipa: "j", vowel: "i", front: 255, open: 0, round: 0, row: 83 }),
  Object.freeze({ code: 2, ipa: "ɥ", vowel: "y", front: 255, open: 0, round: 255, row: 86 }),
  Object.freeze({ code: 3, ipa: "ɰ", vowel: "ɯ", front: 0, open: 0, round: 0, row: 84 }),
  Object.freeze({ code: 4, ipa: "w", vowel: "u", front: 0, open: 0, round: 255, row: 85 }),
]);

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

/** The values a vowel starts at, as an onset's next sound — oral, and nasalised
 *  (the velum already lowered as the vowel begins). */
const VOWEL_START = Object.freeze({ av: 1, ah: 0, af: 0, nz: 0 });
const NASAL_VOWEL_START = Object.freeze({ av: 1, ah: 0, af: 0, nz: 1 });

/** A GLOTTALISED consonant (ˀ): the glottis stays shut this long past the
 *  consonant's own release — or, before a sonorant, at its start — and the
 *  voicing then comes in this fast; a stop's voicing lags its burst by no
 *  more than GLOT_LAG. In a coda, its voicing stops in GLOT_STOP. */
const GLOT_CATCH = 10;
const GLOT_RISE = 2;
const GLOT_LAG = 10;
const GLOT_STOP = 3;
/** What a hissing nucleus takes to let its hiss go before the coda. */
const NUCLEUS_RELEASE = 10;

/** A closed track `tr` with a glottal catch at its START: 0 until t0, back on
 *  the track's own value by t1 — a sonorant said after a glottal stop. */
function catchTrack(tr, t0, t1) {
  const out = [0, 0, t0, 0, t1, trackAt(tr, t1)];
  for (let i = 0; i < tr.length; i += 2) if (tr[i] > t1) out.push(tr[i], tr[i + 1]);
  return Float64Array.from(out);
}

/**
 * An ONSET consonant's tracks. `first` = nothing precedes it (so a stop has no
 * audible closure); `nx` = the next sound's start values; `k` = the timing
 * scale; `art` = its secondary articulation, of which only the glottal one
 * changes a track (ART_GLOTTAL: no breath, and the voicing held off by a
 * glottal catch). Returns {end, w, av, ah, af, nz}.
 *
 * Every oral consonant's nasality holds 0 until its own part is over, so a
 * nasalised vowel after it (nx.nz = 1) lowers the velum through the
 * transition alone.
 */
export function onsetTracks(r, first, nx, k, art = ART_NONE) {
  const w = new FormantTrack(), av = new FormantTrack(), ah = new FormantTrack(), af = new FormantTrack(), nz = new FormantTrack();
  const L = dbGain(r.lvl);
  const tr = r.trans * k, dur = r.dur * k;
  const glot = art === ART_GLOTTAL;
  const catchAt = (t) => av.at(0, 0).at(t + GLOT_CATCH * k, 0).at(t + (GLOT_CATCH + GLOT_RISE) * k, nx.av);
  let end, sonorant = false;
  switch (r.manner) {
    case MANNER_STOP: {
      const cl = first ? 0 : CLOSURE_MS * k;
      const tb = cl + r.burst * k;
      af.at(0, 0).at(cl, 0).at(cl, L).at(tb, 0.3 * L).at(tb + 2 * k, 0);
      ah.at(0, 0);
      w.at(0, 1).at(tb, 1).at(tb + 1 * k, 0.5).at(tb + tr, 0);
      nz.at(0, 0).at(tb, 0);
      if (glot) {
        // The glottis shut through the closure — no voice bar, no breath —
        // and the voicing in at once, a short lag after the burst.
        const tv = tb + Math.min(r.vot, GLOT_LAG) * k;
        av.at(0, 0).at(tv, 0).at(tv + GLOT_RISE * k, nx.av);
        end = Math.max(tv + GLOT_RISE * k, tb + tr);
        break;
      }
      const tv = tb + r.vot * k;
      if (r.voiced) {
        av.at(0, cl > 0 ? 0.25 : 0.3).at(cl, cl > 0 ? 0.25 : 0.3).at(tb, 0.3).at(tb + 10 * k, nx.av);
      } else {
        av.at(0, 0).at(tv, 0).at(tv + 10 * k, nx.av);
      }
      if (!r.voiced && r.vot > 0) {
        const La = L * dbGain(ASPIRATION_DB);
        ah.at(tb, 0).at(tb + 3 * k, La).at(tv, 0.7 * La).at(tv + 10 * k, nx.ah);
      }
      end = Math.max(tv + 10 * k, tb + tr);
      break;
    }
    case MANNER_AFFRICATE: {
      const cl = first ? 0 : CLOSURE_MS * k;
      const tb = cl + r.burst * k;
      const tf = tb + dur;
      af.at(0, 0).at(cl, 0).at(cl, L).at(tb, 0.8 * L).at(tf - 10 * k, L).at(tf + 10 * k, nx.af);
      if (glot) catchAt(tf);
      else if (r.voiced) av.at(0, 0.3).at(tf, 0.3).at(tf + 15 * k, nx.av);
      else av.at(0, 0).at(tf, 0).at(tf + 15 * k, nx.av);
      ah.at(0, 0);
      w.at(0, 1).at(tf, 1).at(tf + tr, 0);
      nz.at(0, 0).at(tf, 0);
      end = Math.max(tf + 15 * k, tf + tr);
      if (glot) end = Math.max(end, tf + (GLOT_CATCH + GLOT_RISE) * k);
      break;
    }
    case MANNER_FRICATIVE: {
      af.at(0, 0).at(10 * k, L).at(dur - 10 * k, L).at(dur + 10 * k, nx.af);
      if (glot) catchAt(dur);
      else if (r.voiced) av.at(0, r.av).at(dur, r.av).at(dur + 15 * k, nx.av);
      else av.at(0, 0).at(dur - 5 * k, 0).at(dur + 15 * k, nx.av);
      ah.at(0, 0);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      nz.at(0, 0).at(dur, 0);
      end = Math.max(dur + 15 * k, dur + tr);
      if (glot) end = Math.max(end, dur + (GLOT_CATCH + GLOT_RISE) * k);
      break;
    }
    case MANNER_ASPIRATE: {
      ah.at(0, 0).at(10 * k, L).at(dur - 10 * k, L).at(dur + 10 * k, nx.ah);
      if (glot) catchAt(dur);
      else if (r.voiced) av.at(0, r.av).at(dur, r.av).at(dur + 10 * k, nx.av);
      else av.at(0, 0).at(dur - 10 * k, 0).at(dur + 10 * k, nx.av);
      af.at(0, 0);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      nz.at(0, 0).at(dur, 0);
      end = Math.max(dur + 10 * k, dur + tr);
      if (glot) end = Math.max(end, dur + (GLOT_CATCH + GLOT_RISE) * k);
      break;
    }
    case MANNER_NASAL: {
      av.at(0, r.av).at(dur, r.av).at(dur + 10 * k, nx.av);
      nz.at(0, 1).at(dur, 1).at(dur + 10 * k, nx.nz);
      w.at(0, 1).at(dur, 1).at(dur + 5 * k, 0.5).at(dur + tr, 0);
      ah.at(0, 0); af.at(0, 0);
      end = Math.max(dur + 10 * k, dur + tr);
      sonorant = true;
      break;
    }
    case MANNER_APPROX: {
      av.at(0, r.av).at(dur, r.av).at(dur + tr * 0.5, nx.av);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0).at(dur, 0);
      end = dur + tr;
      sonorant = true;
      break;
    }
    case MANNER_TAP: {
      av.at(0, 0.2).at(dur, 0.2).at(dur + 5 * k, nx.av);
      w.at(0, 1).at(dur, 1).at(dur + tr, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0).at(dur, 0);
      end = Math.max(dur + 5 * k, dur + tr);
      sonorant = true;
      break;
    }
    case MANNER_TRILL: {
      const c = dur;                  // one cycle: closed 3/8, open 5/8
      const shut = c * 0.375;
      av.at(0, 0.12).at(shut, 0.12).at(shut + 3 * k, 0.7).at(c - 3 * k, 0.7)
        .at(c, 0.12).at(c + shut, 0.12).at(c + shut + 3 * k, nx.av);
      const tail = c + shut + 3 * k;
      w.at(0, 1).at(tail, 1).at(tail + tr, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0).at(tail, 0);
      end = tail + tr;
      sonorant = true;
      break;
    }
    default: { // MANNER_GLOTTAL: a hard onset, and after a consonant a held glottis
      const cl = first ? 0 : 30 * k;
      av.at(0, 0).at(cl, 0).at(cl + 3 * k, nx.av);
      w.at(0, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0).at(cl, 0);
      end = cl + 3 * k;
      break;
    }
  }
  let avT = av.close(end, nx.av);
  // A glottalised sonorant is said after a glottal stop: the catch comes first.
  if (glot && sonorant) avT = catchTrack(avT, GLOT_CATCH * k, (GLOT_CATCH + GLOT_RISE) * k);
  return {
    end,
    w: w.close(end, 0),
    av: avT,
    ah: ah.close(end, nx.ah),
    af: af.close(end, nx.af),
    nz: nz.close(end, nx.nz),
  };
}

/**
 * A NUCLEUS's tracks: the consonant a syllable with no vowel is held on — a
 * syllabic consonant. It starts as an onset consonant does (`first`, `k` and
 * `art` as there) and then HOLDS what it can sustain: a fricative or an
 * affricate its frication, an aspirate its breath, a voiceless stop its
 * aspiration, a voiced stop and every sonorant its voicing — at the vowel's
 * level, being the syllable's peak — a trill its trilling, cycle on cycle.
 * Past `end` every track holds its last value, but a trill's time wraps back
 * by `loop` ms, so its second cycle repeats. Returns {end, loop, w, av, ah,
 * af, nz}.
 */
export function nucleusTracks(r, first, k, art = ART_NONE) {
  const w = new FormantTrack(), av = new FormantTrack(), ah = new FormantTrack(), af = new FormantTrack(), nz = new FormantTrack();
  const L = dbGain(r.lvl);
  const dur = r.dur * k;
  const glot = art === ART_GLOTTAL;
  let end, loop = 0, sonorant = false;
  w.at(0, 1);
  switch (r.manner) {
    case MANNER_STOP: {
      const cl = first ? 0 : CLOSURE_MS * k;
      const tb = cl + r.burst * k;
      af.at(0, 0).at(cl, 0).at(cl, L).at(tb, 0.3 * L).at(tb + 2 * k, 0);
      ah.at(0, 0);
      if (glot) {
        const tv = tb + GLOT_LAG * k;
        av.at(0, 0).at(tv, 0).at(tv + GLOT_RISE * k, r.voiced ? 1 : 0);
        end = tv + GLOT_RISE * k;
      } else if (r.voiced) {
        const a = cl > 0 ? 0.25 : 0.3;
        av.at(0, a).at(cl, a).at(tb, 0.3).at(tb + 10 * k, 1);
        end = tb + 10 * k;
      } else {
        av.at(0, 0);
        if (r.vot > 0) {
          const La = L * dbGain(ASPIRATION_DB);
          ah.at(tb, 0).at(tb + 3 * k, La).at(tb + 10 * k, 0.7 * La);
        }
        end = tb + 10 * k;
      }
      nz.at(0, 0);
      break;
    }
    case MANNER_AFFRICATE: {
      const cl = first ? 0 : CLOSURE_MS * k;
      const tb = cl + r.burst * k;
      af.at(0, 0).at(cl, 0).at(cl, L).at(tb, 0.8 * L).at(tb + 10 * k, L);
      av.at(0, r.voiced && !glot ? 0.3 : 0);
      ah.at(0, 0); nz.at(0, 0);
      end = tb + 10 * k;
      break;
    }
    case MANNER_FRICATIVE: {
      af.at(0, 0).at(10 * k, L);
      av.at(0, r.voiced && !glot ? r.av : 0);
      ah.at(0, 0); nz.at(0, 0);
      end = 10 * k;
      break;
    }
    case MANNER_ASPIRATE: {
      ah.at(0, 0).at(10 * k, L);
      av.at(0, r.voiced && !glot ? r.av : 0);
      af.at(0, 0); nz.at(0, 0);
      end = 10 * k;
      break;
    }
    case MANNER_NASAL: {
      av.at(0, 1);
      nz.at(0, 1);
      ah.at(0, 0); af.at(0, 0);
      end = 0;
      sonorant = true;
      break;
    }
    case MANNER_APPROX: {
      av.at(0, 1);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = 0;
      sonorant = true;
      break;
    }
    case MANNER_TAP: {    // the tap, then the voicing held where it let go
      av.at(0, 0.2).at(dur, 0.2).at(dur + 5 * k, 1);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = dur + 5 * k;
      sonorant = true;
      break;
    }
    case MANNER_TRILL: {  // two cycles; the second repeats
      const c = dur, shut = c * 0.375;
      for (let n = 0; n < 2; n++) {
        const o = n * c;
        av.at(o, 0.12).at(o + shut, 0.12).at(o + shut + 3 * k, 0.7).at(o + c - 3 * k, 0.7);
      }
      av.at(2 * c, 0.12);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = 2 * c;
      loop = c;
      sonorant = true;
      break;
    }
    default: {            // MANNER_GLOTTAL: the glottis shut, and nothing to hold
      av.at(0, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, 0);
      end = 0;
      break;
    }
  }
  const held = (t) => t.close(end, t.p[t.p.length - 1]);
  let avT = held(av);
  if (glot && sonorant) avT = catchTrack(avT, GLOT_CATCH * k, (GLOT_CATCH + GLOT_RISE) * k);
  return { end, loop, w: held(w), av: avT, ah: held(ah), af: held(af), nz: held(nz) };
}

/**
 * A CODA consonant's tracks: from the sound before it into silence. That sound
 * is the vowel — voicing 1, nasality 0, or 1 for a nasalised vowel — or, in a
 * syllable with no vowel, the nucleus as it holds: `v0` and `z0` are its
 * voicing and nasality. `art` is the coda's own articulation: UNRELEASED
 * takes a stop's or an affricate's release away (no burst, no breath, the
 * closure the end of it); GLOTTAL ends the voicing in a glottal stop where it
 * would otherwise fade, and breathes no aspiration; DARK changes no track.
 */
export function codaTracks(r, k, v0 = 1, z0 = 0, art = CODA_RELEASED) {
  const w = new FormantTrack(), av = new FormantTrack(), ah = new FormantTrack(), af = new FormantTrack(), nz = new FormantTrack();
  const L = dbGain(r.lvl);
  const tr = r.trans * k, dur = r.dur * k;
  const glot = art === CODA_GLOTTAL;
  const gs = GLOT_STOP * k;
  let end;
  switch (r.manner) {
    case MANNER_STOP:
    case MANNER_AFFRICATE: {
      const tc = tr + CLOSURE_MS * k;        // the release
      const tb = tc + r.burst * k;
      w.at(0, 0).at(tr, 0.5).at(tr + 5 * k, 1);
      if (glot) av.at(0, v0).at(tr, v0).at(tr + gs, 0);
      else if (r.voiced) av.at(0, v0).at(tr, v0).at(tr + 8 * k, 0.25).at(tc, 0.2).at(tc + 5 * k, 0);
      else av.at(0, v0).at(tr, v0).at(tr + 8 * k, 0);
      if (art === CODA_UNRELEASED) {
        af.at(0, 0);
        ah.at(0, 0);
        end = r.voiced ? tc + 5 * k : tr + 8 * k;
      } else if (r.manner === MANNER_STOP) {
        af.at(0, 0).at(tc, 0).at(tc, 0.7 * L).at(tb, 0.2 * L).at(tb + 2 * k, 0);
        ah.at(0, 0);
        if (!glot && !r.voiced && r.vot > 0) {
          const La = L * dbGain(ASPIRATION_DB);
          ah.at(tb, 0).at(tb + 2 * k, 0.5 * La).at(tb + 30 * k, 0);
        }
        end = tb + 35 * k;
      } else {
        af.at(0, 0).at(tc, 0).at(tc, L).at(tb + dur, 0.6 * L).at(tb + dur + 20 * k, 0);
        ah.at(0, 0);
        end = tb + dur + 20 * k;
      }
      nz.at(0, z0).at(tr + 5 * k, 0);
      break;
    }
    case MANNER_FRICATIVE: {
      const a = Math.max(tr - 15 * k, 0);
      w.at(0, 0).at(tr, 1);
      if (glot) av.at(0, v0).at(a, v0).at(a + gs, 0);
      else if (r.voiced) av.at(0, v0).at(tr, r.av).at(tr + dur, 0.7 * r.av).at(tr + dur + 30 * k, 0);
      else av.at(0, v0).at(a, v0).at(tr + 5 * k, 0);
      af.at(0, 0).at(a, 0).at(tr + 5 * k, L).at(tr + dur, 0.8 * L).at(tr + dur + 30 * k, 0);
      ah.at(0, 0); nz.at(0, z0).at(tr, 0);
      end = tr + dur + 30 * k;
      break;
    }
    case MANNER_ASPIRATE: {
      w.at(0, 0).at(15 * k, 1);
      if (glot) av.at(0, v0).at(gs, 0);
      else if (r.voiced) av.at(0, v0).at(20 * k, r.av).at(dur, 0.5 * r.av).at(dur + 20 * k, 0);
      else av.at(0, v0).at(20 * k, 0);
      ah.at(0, 0).at(10 * k, L).at(dur, 0.5 * L).at(dur + 30 * k, 0);
      af.at(0, 0); nz.at(0, z0).at(15 * k, 0);
      end = dur + 30 * k;
      break;
    }
    case MANNER_NASAL: {
      w.at(0, 0).at(tr, 1);
      nz.at(0, z0).at(Math.max(tr - 5 * k, 0), z0).at(tr, 1);
      av.at(0, v0).at(tr, r.av).at(tr + dur, 0.8 * r.av);
      end = tr + dur + (glot ? gs : 40 * k);
      av.at(end, 0);
      ah.at(0, 0); af.at(0, 0);
      break;
    }
    case MANNER_APPROX: {
      w.at(0, 0).at(tr, 1);
      av.at(0, v0).at(tr, r.av).at(tr + dur, 0.8 * r.av);
      end = tr + dur + (glot ? gs : 40 * k);
      av.at(end, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, z0).at(tr, 0);
      break;
    }
    case MANNER_TAP: {
      w.at(0, 0).at(tr, 1);
      av.at(0, v0).at(tr, v0).at(tr + 3 * k, 0.2).at(tr + dur, 0.2);
      if (glot) {
        end = tr + dur + gs;
      } else {
        av.at(tr + dur + 3 * k, 0.6);
        end = tr + dur + 40 * k;
      }
      av.at(end, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, z0).at(tr, 0);
      break;
    }
    case MANNER_TRILL: {
      const c = dur, shut = c * 0.375;
      w.at(0, 0).at(tr, 1);
      av.at(0, v0).at(tr, 0.7).at(tr + 3 * k, 0.12).at(tr + shut, 0.12).at(tr + shut + 3 * k, 0.7)
        .at(tr + c - 3 * k, 0.7).at(tr + c, 0.12).at(tr + c + shut, 0.12);
      if (glot) {
        end = tr + c + shut + gs;
      } else {
        av.at(tr + c + shut + 3 * k, 0.6);
        end = tr + c + shut + 35 * k;
      }
      av.at(end, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, z0).at(tr, 0);
      break;
    }
    default: { // MANNER_GLOTTAL: the glottis shuts on the vowel
      w.at(0, 0);
      av.at(0, v0).at(6 * k, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, z0).at(6 * k, 0);
      end = 6 * k;
      break;
    }
  }
  return { end, w: w.close(end, 1), av: av.close(end, 0), ah: ah.close(end, 0), af: af.close(end, 0), nz: nz.close(end, 0) };
}

/** A coda after a nucleus that hisses (frication `a0` or breath `h0`): the
 *  hiss lets go over `rel` ms first, voicing `v0` and nasality `z0` held, and
 *  the coda's own tracks `t` follow it. */
function afterRelease(t, rel, v0, a0, h0, z0) {
  const sh = (tr, head) => {
    const o = head.slice();
    for (let i = 0; i < tr.length; i += 2) o.push(tr[i] + rel, tr[i + 1]);
    return Float64Array.from(o);
  };
  return {
    end: t.end + rel,
    w: sh(t.w, [0, 0]), av: sh(t.av, [0, v0]), ah: sh(t.ah, [0, h0]), af: sh(t.af, [0, a0]), nz: sh(t.nz, [0, z0]),
  };
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
/** The level a formant instrument sings at: a full-scale sawtooth's RMS, 1 ÷ √3 —
 *  and so a full-scale white noise's too. The source is brought to it. */
export const FORMANT_LEVEL = 0.5773502691896258;
/** The source gain's clamp, ±24 dB. */
const SOURCE_GAIN_MAX = 16;
/** Where the noise generator starts, at every consonant. */
const NOISE_SEED = 0x9e3779b9;
/** How much of the source the source gain is measured over, at most (bytes). */
const SOURCE_MEASURE_MAX = 16384;
/** …and its harmonics, at most (bytes). */
const SOURCE_DFT_MAX = 4096;
/** Klatt's fixed nasal pole, its bandwidth, and the parallel bank's upper formants. */
const FNP = 270, BNP = 100, BNZ = 100;

// ── Equal loudness ──────────────────────────────────────────────────────────
//
// The level is settled in two parts. The SOURCE is calibrated by its plain
// RMS (sourceGain). The TRACT's strength is judged by ear: the vowel
// normaliser keeps the source's loudness, not its RMS — every harmonic's
// power weighted by the inverse of an equal-loudness contour — so an [i],
// whose power lies under 300 Hz where hearing is dull, is not heard quieter
// than an [a] whose power lies near 1 kHz.
//
// The contour is ISO 226:2003's, at LOUDNESS_PHON, from the standard's
// parameters at its 29 frequencies (as the IoSR Matlab Toolbox's iso226.m
// tabulates them):
//
//   Af = 4.47e−3 × (10^(0.025 Ln) − 1.15) + (0.4 × 10^((Tf + Lu) ÷ 10 − 9))^αf
//   Lp = (10 ÷ αf) × log10(Af) − Lu + 94          the SPL heard as Ln phon
//
// The weighting is −Lp in dB, linear in dB over log2 f between the 29
// frequencies and held at the end values outside 20 Hz…12.5 kHz.

const ISO226_F = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const ISO226_AF = [0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330, 0.315,
  0.301, 0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242, 0.242,
  0.245, 0.254, 0.271, 0.301];
const ISO226_LU = [-31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5, -3.1, -2.0,
  -1.1, -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1];
const ISO226_TF = [78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6,
  6.2, 4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3];
/** The loudness level the tract is judged at: a moderate listening level. */
export const LOUDNESS_PHON = 60;
const ELW_LOGF = ISO226_F.map((f) => Math.log2(f));
const ELW_DB = ISO226_F.map((_, i) => {
  const af = ISO226_AF[i], lu = ISO226_LU[i], tf = ISO226_TF[i];
  const A = 4.47e-3 * (10 ** (0.025 * LOUDNESS_PHON) - 1.15) + (0.4 * 10 ** ((tf + lu) / 10 - 9)) ** af;
  return -((10 / af) * Math.log10(A) - lu + 94);
});
const ELW_LAST = ISO226_F.length - 1;

/** The equal-loudness weighting in dB at f Hz (0 at no particular frequency:
 *  only its shape matters), searching up from table index j; returns the dB
 *  and leaves the index found in elwAt.j, so rising frequencies walk it. */
const elwAt = { j: 0 };
function elwDb(f, j) {
  const lf = Math.log2(f);
  if (!(lf > ELW_LOGF[0])) { elwAt.j = 0; return ELW_DB[0]; }
  if (lf >= ELW_LOGF[ELW_LAST]) { elwAt.j = ELW_LAST; return ELW_DB[ELW_LAST]; }
  while (lf > ELW_LOGF[j + 1]) j++;
  elwAt.j = j;
  const u = (lf - ELW_LOGF[j]) / (ELW_LOGF[j + 1] - ELW_LOGF[j]);
  return ELW_DB[j] + u * (ELW_DB[j + 1] - ELW_DB[j]);
}

/** The equal-loudness power weight at f Hz (for editors and tests). */
export function equalLoudness(f) {
  return 10 ** (elwDb(f, 0) / 10);
}

/** The grid the parallel bank's loudness is summed over: sixth-octave steps
 *  from 50 Hz to 45% of the rate, each point weighted by the equal-loudness
 *  weight times the band it stands for (white noise has equal power per Hz). */
const BANK_GRID = (() => {
  const f = [];
  for (let i = 0; 50 * 2 ** (i / 6) <= 0.45 * SAMPLING_RATE; i++) f.push(50 * 2 ** (i / 6));
  const band = 2 ** (1 / 12) - 2 ** (-1 / 12);
  const w = f.map((x) => 10 ** (elwDb(x, 0) / 10) * x * band);
  const om = f.map((x) => (2 * Math.PI * x) / SAMPLING_RATE);
  return {
    n: f.length, w,
    c1: om.map(Math.cos), s1: om.map(Math.sin),
    c2: om.map((o) => Math.cos(2 * o)), s2: om.map((o) => Math.sin(2 * o)),
    ref: w.reduce((a, b) => a + b, 0),
  };
})();
const PAR_F = [3300, 3750, 4900], PAR_B = [250, 200, 1000];

/** One consonant as it sounds: its row, its slot's recipe, its tracks. */
class FormantSegment {
  constructor(row, slot, tr, art = ART_NONE) {
    this.row = row;
    this.slot = slot;
    this.end = tr.end;
    this.w = tr.w; this.av = tr.av; this.ah = tr.ah; this.af = tr.af; this.nz = tr.nz;
    this.next = null; // the onset consonant that follows, or null for the vowel
    this.art = art;   // its articulation as blendInto reads it: ART_NONE, _PALATAL or _DARK
    this.loop = tr.loop ?? 0;  // a held nucleus's repeat, ms (a trill's cycle)
    // A coda after a hissing nucleus: its own noise starts this far in, the
    // nucleus's going on until then through the nucleus's bank (`prevRow`).
    this.noiseAt = 0;
    this.prevRow = null;
    this.prevArt = ART_NONE;
  }
}

/** The articulation blendInto gives a segment: a secondary articulation's
 *  tongue (palatal or dark) — the glottal one changes the tracks, not the
 *  tract. */
const tractArt = (a) => (a === ART_PALATAL || a === ART_DARK ? a : ART_NONE);

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
    this.codaNoise = false;   // the coda's own noise has started
    // A syllable with no vowel: its last onset consonant, held as the
    // nucleus (null when there is a vowel), and whether it has come to hold.
    this.nucleus = null;
    this.held = false;
    this.fresh = true;        // no control update yet since note-on
    this.upd = 48;            // samples per control update (≈ 1 ms)
    this.ctl = 0;             // samples until the next one
    this.normCount = 0;
    // The vowel, current and gliding (chart bytes, fractional while gliding).
    // Until the note is given a vowel of its own (S $Afgr, an instrument
    // change), it sings the RECORD's, read afresh every update — so an edit
    // is heard on a note already sounding.
    this.ownVowel = false;
    // The glide (G), when the syllable has one: its semivowel, its two tracks
    // (w: 1 at the semivowel, 0 at the vowel; av), its clock and its end.
    this.sv = null; this.svW = null; this.svAv = null; this.svT = 0.0; this.svEnd = 0.0;
    this.VG = new Float64Array(5); this.VGB = new Float64Array(5);
    this.rejoin = false;      // a re-latch glide: follow the record again after it
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
    this.sg = 1.0;                         // source gain: the source to FORMANT_LEVEL
    this.sm = 0.0;                         // …and its mean, taken out first
    this.sgDue = true;                     // …measured at the next sample, with:
    this.hw = new Float64Array(NORM_HARMONICS + 1);  // the source's harmonic powers, [1…hwK]
    this.hwK = 0;
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
    this.nGen = false;                     // the generator rather than a sample
    this.nSeed = NOISE_SEED;
    // The glottal source when it is a chip channel (formantChipSource), keyed
    // with the note; null when the source is the record's sample.
    this.src = null;
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
  dst.codaNoise = src.codaNoise;
  dst.nucleus = src.nucleus;
  dst.held = src.held;
  dst.fresh = src.fresh;
  dst.upd = src.upd; dst.ctl = src.ctl; dst.normCount = src.normCount;
  dst.ownVowel = src.ownVowel; dst.rejoin = src.rejoin;
  dst.sv = src.sv; dst.svW = src.svW; dst.svAv = src.svAv; dst.svT = src.svT; dst.svEnd = src.svEnd;
  dst.vFront = src.vFront; dst.vOpen = src.vOpen; dst.vRound = src.vRound;
  dst.gFront = src.gFront; dst.gOpen = src.gOpen; dst.gRound = src.gRound;
  dst.tFront = src.tFront; dst.tOpen = src.tOpen; dst.tRound = src.tRound;
  dst.glideLeft = src.glideLeft;
  dst.av = src.av; dst.avStep = src.avStep;
  dst.ah = src.ah; dst.ahStep = src.ahStep;
  dst.af = src.af; dst.afStep = src.afStep;
  dst.nv = src.nv; dst.nvStep = src.nvStep; dst.nvGoal = src.nvGoal;
  dst.nb = src.nb;
  dst.sg = src.sg; dst.sm = src.sm; dst.sgDue = src.sgDue;
  dst.hw.set(src.hw); dst.hwK = src.hwK;
  dst.casc.set(src.casc); dst.bank.set(src.bank); dst.bankGain.set(src.bankGain);
  dst.cy.set(src.cy); dst.by.set(src.by);
  dst.nOn = src.nOn; dst.nBase = src.nBase; dst.nSpan = src.nSpan; dst.nPos = src.nPos;
  dst.nStep = src.nStep; dst.nTilt = src.nTilt; dst.nTiltC = src.nTiltC; dst.nGain = src.nGain;
  dst.nZ = src.nZ;
  dst.nGen = src.nGen; dst.nSeed = src.nSeed;
  dst.src = src.src !== null ? cloneChipState(src.src) : null;
  return dst;
}

/**
 * Key the note's glottal source: a chip channel playing `chip` (an OplPatch or
 * a PsgPatch),
 * from silence as any fresh note's channel starts — or no channel, the
 * record's sample being the source, when `chip` is null.
 */
export function formantKeySource(st, chip) {
  if (chip === null) { st.src = null; return; }
  if (!chipStateFits(st.src, chip)) st.src = newChipState(chip);
  chipKeyOn(st.src, chip, false);
  st.sgDue = true;
}

/**
 * An instrument byte without a retrigger hands the note a new record's source
 * (§5.2): a channel already sounding takes the new patch where it stands, as
 * an OPL note does; a sampled source handed a chip gets a fresh channel; a
 * chip handed a sample gives it up.
 */
export function formantRelatchSource(st, chip) {
  if (chip === null) { st.src = null; return; }
  if (!chipStateFits(st.src, chip)) { formantKeySource(st, chip); return; }
  st.src.patch = chip;
  st.src.gen = -1;
  st.sgDue = true;
}

/**
 * Note-on: build the syllable. The onset is slots 0 and 1 in that order,
 * whichever of them name a consonant; the coda is slot 2. Every filter starts
 * from rest — the tract of the note before is not this note's.
 */
export function formantNoteOn(st, patch) {
  st.patch = patch;
  const k = timingScale(patch.timing);
  const vowel = formantHasVowel(patch);
  const rows = [];
  for (let i = 0; i < 2; i++) {
    const r = CONSONANTS[patch.slots[i].cons];
    if (r !== undefined) rows.push([r, patch.slots[i]]);
  }
  // With no vowel, the last onset consonant is the nucleus — or, with no
  // onset, the coda's consonant, which then leaves no coda after it.
  let coda = true;
  if (!vowel && rows.length === 0) {
    const r = CONSONANTS[patch.slots[2].cons];
    if (r !== undefined) { rows.push([r, patch.slots[2]]); coda = false; }
  }
  // The glide, if any: on its semivowel for the approximant's steady time,
  // then into the vowel over its transition, its voicing rising to the
  // vowel's over the first half of that. A syllable with no vowel has none.
  const sv = vowel ? SEMIVOWELS[patch.semivowel] ?? null : null;
  st.sv = sv; st.svT = 0.0;
  if (sv !== null) {
    const r = CONSONANTS[sv.row];
    const dur = r.dur * k, tr = r.trans * k;
    st.svEnd = dur + tr;
    st.svW = new FormantTrack().at(0, 1).at(dur, 1).at(dur + tr, 0).close(st.svEnd, 0);
    st.svAv = new FormantTrack().at(0, r.av).at(dur, r.av).at(dur + tr * 0.5, 1).close(st.svEnd, 1);
  }
  // Built back to front: each consonant ends where the next one starts — the
  // last on the glide, when there is one, and a nasalised vowel's velum
  // already lowered. The last consonant carries the secondary articulation;
  // without a vowel it is the nucleus, and holds.
  const nasal = vowel && patch.nasal;
  const segs = new Array(rows.length);
  let nx = sv !== null ? { av: st.svAv[1], ah: 0, af: 0, nz: nasal ? 1 : 0 }
    : nasal ? NASAL_VOWEL_START : VOWEL_START;
  let next = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const [r, slot] = rows[i];
    const art = i === rows.length - 1 ? patch.secondary : ART_NONE;
    const tracks = !vowel && i === rows.length - 1
      ? nucleusTracks(r, i === 0, k, art) : onsetTracks(r, i === 0, nx, k, art);
    const s = new FormantSegment(r, slot, tracks, tractArt(art));
    s.next = next;
    segs[i] = s;
    next = s;
    nx = { av: s.av[1], ah: s.ah[1], af: s.af[1], nz: s.nz[1] };
  }
  st.onset = segs;
  st.seg = 0;
  st.nucleus = !vowel && segs.length > 0 ? segs[segs.length - 1] : null;
  st.held = false;
  st.coda = coda ? buildCoda(st, patch, k) : null;
  st.phase = segs.length > 0 ? PHASE_ONSET : PHASE_VOWEL;
  st.t = 0.0;
  st.codaVeto = false;
  st.codaNoise = false;
  st.fresh = true;
  st.upd = Math.max(1, Math.round(SAMPLING_RATE / 1000));
  st.ctl = 0;
  st.normCount = 0;
  st.ownVowel = false; st.rejoin = false;
  st.vFront = patch.front; st.vOpen = patch.open; st.vRound = patch.round;
  st.glideLeft = 0.0;
  st.sgDue = true;
  st.av = 0.0; st.avStep = 0.0; st.ah = 0.0; st.ahStep = 0.0; st.af = 0.0; st.afStep = 0.0;
  st.nv = 1.0; st.nvStep = 0.0; st.nvGoal = 1.0;
  st.cy.fill(0); st.by.fill(0);
  st.nOn = false; st.nZ = 0.0;
  // No vowel and no consonant: nothing to say. The syllable is over at once.
  if (!vowel && segs.length === 0) { st.phase = PHASE_CODA; st.coda = SILENT_CODA; st.codaNoise = true; }
  if (st.phase === PHASE_ONSET) startNoise(st, segs[0]);
}

/**
 * The coda a record gives a note: slot 2's consonant, from the vowel — or, in
 * a syllable with no vowel, from its nucleus as it holds, a hissing nucleus
 * letting its hiss go first. Null with no coda consonant.
 */
function buildCoda(st, patch, k) {
  const cr = CONSONANTS[patch.slots[2].cons];
  if (cr === undefined) return null;
  const art = patch.codaArt;
  const tract = art === CODA_DARK ? ART_DARK : ART_NONE;
  const nuc = st.nucleus;
  if (nuc === null) {
    const z0 = patch.nasal && formantHasVowel(patch) ? 1 : 0;
    return new FormantSegment(cr, patch.slots[2], codaTracks(cr, k, 1, z0, art), tract);
  }
  const last = (tr) => tr[tr.length - 1];
  const v0 = last(nuc.av), z0 = last(nuc.nz), a0 = last(nuc.af), h0 = last(nuc.ah);
  const hiss = a0 > 0 || h0 > 0;
  let tracks = codaTracks(cr, k, v0, z0, art);
  if (hiss) tracks = afterRelease(tracks, NUCLEUS_RELEASE * k, v0, a0, h0, z0);
  const seg = new FormantSegment(cr, patch.slots[2], tracks, tract);
  if (hiss) { seg.noiseAt = NUCLEUS_RELEASE * k; seg.prevRow = nuc.row; seg.prevArt = nuc.art; }
  return seg;
}

/** The coda of a syllable with nothing to say: over before it starts. */
const SILENT_CODA = new FormantSegment(null, null, {
  end: 0, w: Float64Array.of(0, 1), av: Float64Array.of(0, 0), ah: Float64Array.of(0, 0),
  af: Float64Array.of(0, 0), nz: Float64Array.of(0, 0),
});

/**
 * Q's retrigger (tick.js restartVoice): the note says its syllable again from
 * the onset, on the vowel it is singing now — an `S $Afgr` that moved it is
 * not taken back by a stutter.
 */
export function formantRestart(st) {
  if (st.patch === null) return;
  const f = st.vFront, o = st.vOpen, r = st.vRound, own = st.ownVowel;
  const sg = st.sg, sm = st.sm, due = st.sgDue;
  formantNoteOn(st, st.patch);
  st.vFront = f; st.vOpen = o; st.vRound = r; st.ownVowel = own;
  st.sg = sg; st.sm = sm; st.sgDue = due;   // the same sample: the same measurements
  // A chip source is re-keyed as Q re-keys an OPL note: the attack from where
  // each envelope stands, the phase from zero (§5.5.2).
  if (st.src !== null && st.src.patch !== null) chipKeyOn(st.src, st.src.patch, true);
}

/**
 * An instrument byte without a retrigger (§5.2): the sounding syllable takes
 * the new record's tract. Its vowel glides to the new default over the new
 * glide time and then follows that record's vowel as any note of it does,
 * the pitch rules become the new record's, and a coda that has
 * not begun becomes the new record's coda; consonants already under way
 * finish as they started. Nothing restarts — the note is still sounding, and
 * keeps the nucleus it has: a vowel, or a syllabic consonant.
 */
export function formantRelatch(st, patch) {
  st.patch = patch;
  st.sgDue = true;
  formantGlideTo(st, patch.open, patch.front, patch.round);
  // Once there, the note sings the new record's vowel as it is edited.
  if (st.glideLeft > 0) { st.ownVowel = true; st.rejoin = true; }
  else { st.ownVowel = false; st.rejoin = false; }
  if (st.phase === PHASE_ONSET || st.phase === PHASE_VOWEL) {
    st.coda = buildCoda(st, patch, timingScale(patch.timing));
  }
}

/** A sampled note handed a formant instrument mid-note: the tract starts at
 *  the vowel — or a syllable with no vowel at its nucleus, holding — with the
 *  coda ready: the note's onset was its sample's. */
export function formantStartAtVowel(st, patch) {
  formantNoteOn(st, patch);
  st.sv = null;   // the glide, like the onset, is long past
  if (st.phase === PHASE_CODA) return;   // nothing to say
  if (st.nucleus !== null) {
    st.onset = [st.nucleus];
    st.seg = 0;
    st.phase = PHASE_ONSET;
    st.t = st.nucleus.end;
    st.held = true;
    startNoise(st, st.nucleus);
    return;
  }
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
  st.ownVowel = true;
  st.rejoin = false;
  formantGlideTo(st, (f & 15) * 17, (g & 15) * 17, (r & 15) * 17);
}

/**
 * A consonant starts its noise: the slot's sample, or — a slot with no
 * sample to read (fewer than two bytes from its offset, or rate 0) — the
 * engine's generator, restarted from the same seed every time, so a
 * syllable's noise is the same every time it is said.
 */
function startNoise(st, seg) {
  const s = seg.slot;
  st.nOn = false;
  if (!consonantNeedsNoise(seg.row)) return;
  let span = s.len - s.offset;
  const base = s.ptr + s.offset;
  if (base + span > SAMPLE_BIN_TOTAL) span = SAMPLE_BIN_TOTAL - base;
  st.nGen = span < 2 || s.rate <= 0;
  st.nOn = true;
  st.nBase = base;
  st.nSpan = span;
  st.nPos = 0.0;
  st.nStep = s.rate / SAMPLING_RATE;
  st.nSeed = NOISE_SEED;
  st.nTilt = s.tilt;
  st.nTiltC = Math.abs(s.tilt) / 128;
  st.nGain = attenGainOf(s.gain);
  st.nZ = 0.0;
}

/**
 * The slot's noise: its sample read at its own rate, looped over
 * [offset, end) — or the generator, a 32-bit xorshift (13, 17, 5) whose
 * every output sample is a value uniform on [−1, 1): white, at FORMANT_LEVEL.
 */
function readNoise(eng, st) {
  let x;
  if (st.nGen) {
    let r = st.nSeed;
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
    st.nSeed = r >>> 0;
    x = (st.nSeed / 4294967296) * 2 - 1;
  } else {
    const i = Math.trunc(st.nPos);
    const fr = st.nPos - i;
    const bin = eng.sampleBin;
    const a = PCM_U8[bin[st.nBase + i]];
    const b = PCM_U8[bin[st.nBase + (i + 1 < st.nSpan ? i + 1 : 0)]];
    x = a + (b - a) * fr;
    st.nPos += st.nStep;
    while (st.nPos >= st.nSpan) st.nPos -= st.nSpan;
  }
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

/**
 * The parallel bank's normaliser: what makes white noise leave the bank as
 * LOUD as it entered — the bank's five resonators (coefficients in `bank`)
 * summed with their signed gains g[0…4] and the bypass g[5], its response
 * G(f) taken whole (the alternating signs cancel or reinforce between
 * formants), and |G|² weighted by equal loudness over BANK_GRID:
 * sqrt(Σ w ÷ Σ w·|G|²). 0 when the bank passes nothing.
 */
function bankNorm(bank, g) {
  const G = BANK_GRID;
  let p = 0.0;
  for (let i = 0; i < G.n; i++) {
    let re = g[5], im = 0.0;
    for (let j = 0; j < 5; j++) {
      if (g[j] === 0) continue;
      const A = bank[j * 3], b = bank[j * 3 + 1], c = bank[j * 3 + 2];
      const dr = 1 - b * G.c1[i] - c * G.c2[i];
      const di = b * G.s1[i] + c * G.s2[i];
      const k = (g[j] * A) / (dr * dr + di * di);
      re += k * dr;
      im -= k * di;
    }
    p += G.w[i] * (re * re + im * im);
  }
  return p > 0 ? Math.sqrt(G.ref / p) : 0.0;
}


/**
 * The tract normaliser: what makes the source come out of the cascade as LOUD
 * as it went in, at this f0 — so the tract shapes the sound and does not set
 * its loudness. `co` is the cascade as configured (formantControl's `casc`:
 * the nasal pole, the nasal zero — the resonator it inverts — then F5…F1),
 * so a consonant's tract is measured as it stands. The source is its
 * harmonics as measured (sourceHarmonics, w[1…K]), each weighted by the
 * equal-loudness weight L at its frequency: P = Σ |H(k·f0)|²·w(k)·L(k·f0)
 * against Σ w(k)·L(k·f0), over the harmonics below 45% of the rate.
 * Clamped to −48…+24 dB.
 */
function cascadeNorm(co, f0, w, wK) {
  if (!(f0 > 0)) return 1.0;
  const R = SAMPLING_RATE;
  const K = Math.max(1, Math.min(wK, Math.floor((0.45 * R) / f0)));
  const w0 = (2 * Math.PI * f0) / R;
  const c1 = Math.cos(w0), s1 = Math.sin(w0);
  let ck = c1, sk = s1;
  let p = 0.0, ref = 0.0, j = 0;
  for (let k = 1; k <= K; k++) {
    const c2 = ck * ck - sk * sk, s2 = 2 * sk * ck;
    let h = 1.0;
    for (let n = 0; n < 7; n++) {
      const A = co[n * 3], b = co[n * 3 + 1], c = co[n * 3 + 2];
      const re = 1 - b * ck - c * c2;
      const im = b * sk + c * s2;
      const g = (A * A) / (re * re + im * im);
      h *= n === 1 ? 1 / g : g;   // section 1, the nasal zero, inverts its resonator
    }
    const lw = w[k] * 10 ** (elwDb(k * f0, j) / 10);
    j = elwAt.j;
    p += h * lw;
    ref += lw;
    const nc = ck * c1 - sk * s1;
    sk = sk * c1 + ck * s1;
    ck = nc;
  }
  const g = p > 0 ? Math.sqrt(ref / p) : NORM_MAX;
  return Math.min(Math.max(g, NORM_MIN), NORM_MAX);
}

/**
 * What a note measures of its source, once — at its first rendered sample,
 * and again after an instrument change: the gain that brings it to
 * FORMANT_LEVEL, and its harmonics. Both over ONE stretch — the loudest the
 * note plays, so a quiet stretch cannot set a gain a louder one then plays
 * through:
 *
 *   the loop, for a looped source — the stretch it sustains on;
 *   …unless the note starts AHEAD of its loop (an attack, or whatever came
 *     before the loop in a recording) and the loudest window of that is
 *     louder — then that window;
 *   for a one-shot source, its loudest window from play start.
 *
 * Windows are SOURCE_WINDOW bytes every half window, at most the first
 * SOURCE_MEASURE_MAX bytes of a stretch.
 */
function measureSource(eng, voice, st) {
  if (st.src !== null) { measureChipSource(voice, st); return; }
  const bin = eng.sampleBin;
  const mode = voice.activeLoopMode & 3;
  const looped = (mode === 1 || mode === 2) && voice.activeSampleLoopEnd > voice.activeSampleLoopStart;
  const base = voice.activeSamplePtr;
  const cut = (x) => Math.max(0, Math.min(x, voice.activeSampleLength, SAMPLE_BIN_TOTAL - base));
  const p0 = voice.activeSamplePlayStart;
  let at, n, whole = false;
  if (looped) {
    const a = voice.activeSampleLoopStart;
    at = base + a;
    n = cut(voice.activeSampleLoopEnd) - a;
    whole = n === voice.activeSampleLoopEnd - a;
    const preN = Math.min(cut(a) - p0, SOURCE_MEASURE_MAX);
    if (preN >= 2 && n >= 2) {
      const loopAc = acOf(bin, at, Math.min(n, SOURCE_MEASURE_MAX))[1];
      const w = loudestWindow(bin, base + p0, preN);
      if (w.ac > loopAc) { at = w.at; n = w.n; whole = false; }
    }
  } else {
    const w = loudestWindow(bin, base + p0, Math.min(cut(voice.activeSampleLength) - p0, SOURCE_MEASURE_MAX));
    at = w.at; n = w.n;
  }
  sourceGain(bin, at, Math.min(n, SOURCE_MEASURE_MAX), st);
  sourceHarmonics(bin, at, n, whole, voice.activeSamplingRate / LINEAR_FREQ_C4_HZ, st);
}

/** Mean and AC power (variance) of n bytes from p, into acOut[0], acOut[1]. */
const acOut = new Float64Array(2);
function acOf(bin, p, n) {
  let sum = 0.0, sq = 0.0;
  for (let i = 0; i < n; i++) {
    const v = PCM_U8[bin[p + i]];
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  acOut[0] = mean;
  acOut[1] = sq / n - mean * mean;
  return acOut;
}

/** The loudest window of n bytes from p: windows of SOURCE_WINDOW bytes
 *  every half window, the last one ending at the end (fewer bytes than a
 *  window are one window); the first of equals wins. {at, n, ac}. */
const SOURCE_WINDOW = 1024;
const loudOut = { at: 0, n: 0, ac: 0.0 };
function loudestWindow(bin, p, n) {
  loudOut.at = p; loudOut.n = Math.max(n, 0); loudOut.ac = 0.0;
  if (n < 2) return loudOut;
  if (n <= SOURCE_WINDOW) { loudOut.ac = acOf(bin, p, n)[1]; return loudOut; }
  loudOut.n = SOURCE_WINDOW;
  loudOut.ac = -1.0;
  for (let o = 0; ; o += SOURCE_WINDOW >> 1) {
    const q = Math.min(o, n - SOURCE_WINDOW);
    const ac = acOf(bin, p + q, SOURCE_WINDOW)[1];
    if (ac > loudOut.ac) { loudOut.ac = ac; loudOut.at = p + q; }
    if (q === n - SOURCE_WINDOW) break;
  }
  return loudOut;
}

/**
 * The source's calibration over n bytes from p, into st: its mean (sm), which
 * the tract takes out — a DC offset would pass the cascade's unity-DC
 * resonators whole and step in at every note-on — and the gain (sg) that
 * brings what is left to FORMANT_LEVEL by its plain RMS, clamped to ±24 dB.
 * Fewer than two bytes: mean 0, gain 1; silence: gain 1.
 */
function sourceGain(bin, p, n, st) {
  st.sm = 0.0;
  st.sg = 1.0;
  if (n < 2) return;
  const [mean, ac] = acOf(bin, p, n);
  st.sm = mean;
  if (!(ac > 1e-12)) return;
  st.sg = Math.min(Math.max(FORMANT_LEVEL / Math.sqrt(ac), 1 / SOURCE_GAIN_MAX), SOURCE_GAIN_MAX);
}

/** Measurements already made, by what they were made of: a pure memo (the
 *  same bytes measure the same), so a chord pays for one, not one a note. */
const sourceMemo = new Map();
const SOURCE_MEMO_MAX = 32;
const srcDft = new Float64Array(SOURCE_DFT_MAX);

/**
 * The source's harmonic powers into st.hw[1…K], K = min(64, ⌊P ÷ 2⌋) — every
 * harmonic its own rate can hold — P being its period in bytes (the rate at
 * C4 ÷ 261.63 Hz, since that rate sounds middle C). A sample's harmonics stay
 * the same harmonics at any speed it is played, which is what makes this
 * worth measuring once: a recorded [i] is not a sawtooth, and a loop at
 * 700 Hz has a few dozen harmonics where a sawtooth model assumes 64.
 *
 * Over N = min(span, SOURCE_DFT_MAX) bytes from p, mean removed. A whole loop
 * that fits is read EXACTLY: it repeats every N bytes, m = max(1, round(N ÷ P))
 * periods of it, so harmonic k is the DFT's bin k·m. Anything else is
 * Hann-windowed and read at k ÷ P cycles a byte. Power = re² + im². With no
 * period to read (P < 2, or nothing measured) the source is taken to be a
 * sawtooth: 1 ÷ k² for k ≤ 64.
 */
function sourceHarmonics(bin, p, span, whole, P, st) {
  const w = st.hw;
  const K = P >= 2 ? Math.min(NORM_HARMONICS, Math.floor(P / 2)) : 0;
  const N = Math.min(span, SOURCE_DFT_MAX);
  if (K < 1 || N < 2) { sawHarmonics(st); return; }
  const exact = whole && span <= SOURCE_DFT_MAX;
  const m = exact ? Math.max(1, Math.round(N / P)) : 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < N; i++) h = Math.imul(h ^ bin[p + i], 16777619);
  const key = `${p}:${N}:${m}:${P}:${h >>> 0}`;
  const hit = sourceMemo.get(key);
  if (hit !== undefined) {
    w.set(hit.w); st.hwK = hit.K;
    return;
  }
  let mean = 0.0;
  for (let i = 0; i < N; i++) mean += PCM_U8[bin[p + i]];
  mean /= N;
  const x = srcDft;
  for (let i = 0; i < N; i++) {
    const v = PCM_U8[bin[p + i]] - mean;
    x[i] = exact ? v : v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  }
  let sum = 0.0;
  for (let k = 1; k <= K; k++) {
    const om = exact ? (2 * Math.PI * k * m) / N : (2 * Math.PI * k) / P;
    const c1 = Math.cos(om), s1 = Math.sin(om);
    let c = 1.0, s = 0.0, re = 0.0, im = 0.0;
    for (let i = 0; i < N; i++) {
      re += x[i] * c;
      im -= x[i] * s;
      const nc = c * c1 - s * s1;
      s = s * c1 + c * s1;
      c = nc;
    }
    w[k] = re * re + im * im;
    sum += w[k];
  }
  if (!(sum > 0)) { sawHarmonics(st); return; }
  st.hwK = K;
  if (sourceMemo.size >= SOURCE_MEMO_MAX) sourceMemo.clear();
  sourceMemo.set(key, { w: w.slice(0, K + 1), K });
}

/** Output frames of a chip source a note is measured over (≈ 85 ms): past the
 *  attack of all but the slowest patch, and one loudest window's worth of
 *  room to find it in four times over. */
const CHIP_MEASURE = 4096;
const chipBuf = new Float64Array(CHIP_MEASURE);
const chipScratch = new OplState();
/** Measurements of chip sources already made, per patch, by its decode and
 *  the rate played: a pure memo, as sourceMemo is. */
const chipMemo = new WeakMap();
const chipAc = new Float64Array(2);

/**
 * measureSource for a source that is an OPL channel. The chip has no bytes to
 * read, so the note's own channel is run apart — from key-on, at the note's
 * rate, at unity volume, on a channel of its own so the note's is untouched —
 * for CHIP_MEASURE output frames, and that is measured the way a one-shot
 * sample is: the gain from the loudest window, its mean taken out first, and
 * its harmonics from the same window, Hann-windowed and read at k ÷ P cycles a
 * frame, P being the period in output frames at the note's pitch. A chip's
 * spectrum moves with its pitch (key scaling, the block an F-number falls in),
 * so unlike a sample's it is measured at the pitch it is sung at.
 */
function measureChipSource(voice, st) {
  const patch = st.src.patch;
  const pr = voice.snapPlaybackRate ? voice.playbackRate : voice.currentPlaybackRate;
  const key = `${chipSoundKey(patch)}:${pr}`;
  let memo = chipMemo.get(patch);
  if (memo === undefined) { memo = new Map(); chipMemo.set(patch, memo); }
  const hit = memo.get(key);
  if (hit !== undefined) {
    st.sm = hit.sm; st.sg = hit.sg; st.hw.set(hit.w); st.hwK = hit.K;
    return;
  }
  const x = chipBuf;
  if (isPsgPatch(patch)) {
    // A PSG pair keeps its internal status across key-ons, so it is measured
    // on a channel of its own every time: from rest, as a fresh lane meets it.
    const psg = newChipState(patch);
    chipKeyOn(psg, patch, false);
    for (let i = 0; i < CHIP_MEASURE; i++) x[i] = chipRender(psg, i, pr, false);
  } else {
    oplKeyOn(chipScratch, patch, false);
    for (let i = 0; i < CHIP_MEASURE; i++) x[i] = oplRender(chipScratch, i, pr, 1.0, false);
  }
  // The loudest window, every half window; the first of equals wins.
  const acF = (p, n) => {
    let sum = 0.0, sq = 0.0;
    for (let i = 0; i < n; i++) { const v = x[p + i]; sum += v; sq += v * v; }
    const mean = sum / n;
    chipAc[0] = mean;
    chipAc[1] = sq / n - mean * mean;
    return chipAc;
  };
  let at = 0, best = -1.0;
  for (let o = 0; o + SOURCE_WINDOW <= CHIP_MEASURE; o += SOURCE_WINDOW >> 1) {
    const ac = acF(o, SOURCE_WINDOW)[1];
    if (ac > best) { best = ac; at = o; }
  }
  const [mean, ac] = acF(at, SOURCE_WINDOW);
  st.sm = mean;
  st.sg = ac > 1e-12
    ? Math.min(Math.max(FORMANT_LEVEL / Math.sqrt(ac), 1 / SOURCE_GAIN_MAX), SOURCE_GAIN_MAX)
    : 1.0;
  // The period in output frames: the chip sounds pr × rate × 261.63 ÷ 8363 Hz.
  const P = pr > 0 ? OPL_C4_RATE / (pr * LINEAR_FREQ_C4_HZ) : 0;
  const K = P >= 2 ? Math.min(NORM_HARMONICS, Math.floor(P / 2)) : 0;
  const w = st.hw;
  let sum = 0.0;
  if (K >= 1) {
    const N = SOURCE_WINDOW;
    const y = srcDft;
    for (let i = 0; i < N; i++) {
      y[i] = (x[at + i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    }
    for (let k = 1; k <= K; k++) {
      const om = (2 * Math.PI * k) / P;
      const c1 = Math.cos(om), s1 = Math.sin(om);
      let c = 1.0, s = 0.0, re = 0.0, im = 0.0;
      for (let i = 0; i < N; i++) {
        re += y[i] * c;
        im -= y[i] * s;
        const nc = c * c1 - s * s1;
        s = s * c1 + c * s1;
        c = nc;
      }
      w[k] = re * re + im * im;
      sum += w[k];
    }
  }
  if (sum > 0) st.hwK = K;
  else sawHarmonics(st);
  if (memo.size >= SOURCE_MEMO_MAX) memo.clear();
  memo.set(key, { sm: st.sm, sg: st.sg, w: st.hw.slice(0, st.hwK + 1), K: st.hwK });
}

/** A sawtooth's harmonics, 1 ÷ k² for k ≤ 64: what a source with no period
 *  to measure is taken to be. */
function sawHarmonics(st) {
  for (let k = 1; k <= NORM_HARMONICS; k++) st.hw[k] = 1 / (k * k);
  st.hwK = NORM_HARMONICS;
}

/**
 * The fundamental the source is sounding at, Hz. On a note's first sample
 * the mixer has not yet snapped the voice's rate to the note's (it does so
 * after rendering the sample): the note's own rate is the one meant then.
 */
function voiceF0(voice) {
  const rate = voice.activeSamplingRate;
  const pr = voice.snapPlaybackRate ? voice.playbackRate : voice.currentPlaybackRate;
  // A chip source sounds what the chip makes of the rate (opl.js retune), and
  // the chip reads every rate against the tracker convention's 8363.
  if (voice.formant !== null && voice.formant.src !== null) {
    return (pr * SAMPLING_RATE * LINEAR_FREQ_C4_HZ) / OPL_C4_RATE;
  }
  return rate > 0 ? (pr * SAMPLING_RATE * LINEAR_FREQ_C4_HZ) / rate : 0.0;
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

/** The tongue a secondary articulation holds behind a consonant (front, open,
 *  round): ART_PALATAL [i]'s; ART_DARK the back of the tongue drawn back —
 *  velarised or pharyngealised — midway between [ʌ] and [ɑ], where F2 falls to
 *  about 1.05 kHz: a dark [ɫ]'s, and about where Arabic's emphatic consonants
 *  leave a vowel ([a]'s F2 1514 Hz after a plain consonant, 1122 after an
 *  emphatic one, pooled over the speakers of "Arabic emphatic consonants as
 *  produced by English speakers", Heliyon, February 2023). Its F2 and F3 at a
 *  man's size. */
const ART_TONGUE = [null, [255, 0, 0], [0, 212, 0]];
const ART_F = ART_TONGUE.map((t) => (t === null ? null : vowelFormants(t[0], t[1], t[2], new Float64Array(5))));
/** A velar's F2 and F3 meet as close as the order rule lets two formants
 *  come: F3 ÷ F2 = 1.15, about the geometric mean of the two it meets. */
const PINCH = Math.sqrt(1.15);
/** A nasalised vowel's F1 rises this much at a man's size (Klatt 1980 §V.B). */
const NASAL_F1 = 100;

/**
 * Configure the tract for this update: the consonant's own tract blended with
 * the next sound's by w. `cfg` = [F1 F2 F3 B1 B2 B3] of the consonant at this
 * voice's size, a zero meaning "the vowel's". A secondary articulation `art`
 * (palatal, dark) puts its tongue's F2 and F3 in the consonant's; otherwise a
 * velar (`row.dorsal`) takes them from the sound it meets, drawn together
 * about their geometric mean — the tongue's back meets the palate where that
 * sound puts it.
 */
function blendInto(row, w, s, F, B, NF, NB, art = ART_NONE) {
  let c2 = 0, c3 = 0;
  if (art !== ART_NONE) {
    const T = ART_F[art];
    c2 = T[1] * s; c3 = T[2] * s;
  } else if (row.dorsal) {
    const p = Math.sqrt(NF[1] * NF[2]);
    c2 = p / PINCH; c3 = p * PINCH;
  }
  for (let n = 0; n < 3; n++) {
    const cf = n === 1 && c2 > 0 ? c2 : n === 2 && c3 > 0 ? c3 : row.F[n] > 0 ? row.F[n] * s : NF[n];
    const cb = row.B[n] > 0 ? row.B[n] * s : NB[n];
    F[n] = NF[n] + w * (cf - NF[n]);
    B[n] = NB[n] + w * (cb - NB[n]);
  }
  F[3] = NF[3]; F[4] = NF[4]; B[3] = NB[3]; B[4] = NB[4];
}

/** How front the vowel a consonant meets is, 0 (back) … 1 (front): the
 *  vowel's tongue, or the glide's while it sounds. */
function metFront(st) {
  let x = st.vFront;
  if (st.sv !== null) x += trackAt(st.svW, st.svT) * (st.sv.front - x);
  return Math.min(Math.max(x / 255, 0), 1);
}

/** Where a consonant's nasal zero opens to, in a syllable with nasality
 *  beyond its nasal consonants: its own zero, drawn toward the zero of the
 *  sound it meets (`met`) as its tract is — or, with none of its own, that
 *  sound's. `fnp` is the pole: a sound with no zero has it there. */
function segZero(row, w, s, met, fnp, ceil) {
  if (!(row.fnz > 0)) return met;
  const own = Math.min(row.fnz * s, ceil);
  return met === fnp ? own : met + w * (own - met);
}

/** …the zero of the sound an onset consonant heads for: the first nasal of
 *  the consonants after it, or the vowel's (`vz`). */
function onsetMetZero(seg, s, vz, ceil) {
  for (let n = seg.next; n !== null; n = n.next) if (n.row.fnz > 0) return Math.min(n.row.fnz * s, ceil);
  return vz;
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
  // Sequencer: walk past finished onset consonants into the vowel. A nucleus
  // never finishes: it holds, a trill's time wrapping back by its cycle.
  while (st.phase === PHASE_ONSET && st.t >= st.onset[st.seg].end) {
    const cur = st.onset[st.seg];
    if (cur === st.nucleus) {
      st.held = true;
      if (cur.loop > 0) while (st.t >= cur.end) st.t -= cur.loop;
      break;
    }
    st.t -= cur.end;
    st.seg++;
    if (st.seg >= st.onset.length) { st.phase = PHASE_VOWEL; st.nOn = false; }
    else startNoise(st, st.onset[st.seg]);
  }
  const holding = st.phase === PHASE_ONSET && st.held;
  if ((st.phase === PHASE_VOWEL || holding) && voice.keyOff && !st.codaVeto && st.coda !== null) {
    st.phase = PHASE_CODA;
    st.t = 0.0;
    // After a hissing nucleus the coda's own noise waits for the hiss to go.
    st.codaNoise = st.coda.noiseAt <= 0;
    if (st.codaNoise) startNoise(st, st.coda);
  }
  if (st.phase === PHASE_CODA && st.t >= st.coda.end) {
    st.phase = PHASE_DONE;
    st.av = 0; st.avStep = 0; st.ah = 0; st.ahStep = 0; st.af = 0; st.afStep = 0;
    st.nOn = false;
    startRampOut(voice);
    return;
  }
  if (st.phase === PHASE_CODA && !st.codaNoise && st.t >= st.coda.noiseAt) {
    st.codaNoise = true;
    startNoise(st, st.coda);
  }

  // The vowel: the record's as it stands, or a glide, then the pitch rules.
  if (st.glideLeft > 0) {
    if (st.glideLeft <= dt) {           // the last step lands exactly
      st.vOpen = st.tOpen; st.vFront = st.tFront; st.vRound = st.tRound;
      st.glideLeft = 0.0;
      if (st.rejoin) { st.ownVowel = false; st.rejoin = false; }
    } else {
      st.vOpen += st.gOpen * dt;
      st.vFront += st.gFront * dt;
      st.vRound += st.gRound * dt;
      st.glideLeft -= dt;
    }
  } else if (!st.ownVowel) {
    st.vOpen = patch.open; st.vFront = patch.front; st.vRound = patch.round;
  }
  // A syllable with no vowel still has the tongue's rest — the vowel bytes —
  // for what its consonants take from "the vowel's": F4, F5, [h]'s formants.
  const sung = st.nucleus === null;
  const f0 = voiceF0(voice);
  const V = st.V, VB = st.VB;
  const ref = noteHz(formantRefNote(patch));
  const s = vowelAtPitch(st.vFront, st.vOpen, st.vRound, f0, ref, patch.track, V, VB, sung && patch.rhotic);
  // The glide: from the semivowel to the vowel, in log frequency. Held on the
  // semivowel through the onset, so the consonants head for it.
  if (st.sv !== null) {
    const gw = trackAt(st.svW, st.svT);
    if (gw > 0) {
      const sv = st.sv, VG = st.VG, VGB = st.VGB;
      vowelAtPitch(sv.front, sv.open, sv.round, f0, ref, patch.track, VG, VGB);
      for (let n = 0; n < 5; n++) {
        V[n] *= (VG[n] / V[n]) ** gw;
        VB[n] *= (VGB[n] / VB[n]) ** gw;
      }
    }
  }
  const ceil = 0.45 * SAMPLING_RATE;
  const fnp = Math.min(FNP * s, ceil);
  // Nasalised, as Klatt makes it: F1 a hundred hertz higher (at a man's
  // size), the order kept, and the nasal zero opened midway between that F1
  // and the nasal pole — a pole-zero pair beside F1 that takes its strength.
  const nasalV = sung && patch.nasal;
  let vz = fnp;
  if (nasalV) {
    V[0] = Math.min(V[0] + NASAL_F1 * s, ceil);
    VB[0] = Math.max(V[0] / 10, 50);
    for (let n = 1; n < 5; n++) if (V[n] < V[n - 1] * 1.15) V[n] = Math.min(V[n - 1] * 1.15, ceil);
    vz = (V[0] + fnp) / 2;
  }
  const nasality = nasalV || (st.nucleus !== null && st.nucleus.row.fnz > 0);

  // The tract this update.
  const F = st.F, B = st.B;
  let nzAmt = 0.0;
  let seg = null;
  let zf = fnp;
  if (st.phase === PHASE_ONSET) {
    seg = st.onset[st.seg];
    // The sound this consonant is heading for: the next consonant as it
    // starts, or the vowel.
    if (seg.next !== null) blendInto(seg.next.row, seg.next.w[1], s, nextF, nextB, V, VB, seg.next.art);
    else { nextF.set(V); nextB.set(VB); }
    const w = trackAt(seg.w, st.t);
    blendInto(seg.row, w, s, F, B, nextF, nextB, seg.art);
    nzAmt = trackAt(seg.nz, st.t);
    if (nasality) zf = segZero(seg.row, w, s, onsetMetZero(seg, s, vz, ceil), fnp, ceil);
    segAmps(seg, st.t, ampNow);
    segAmps(seg, st.t + dt, ampNext);
  } else if (st.phase === PHASE_CODA) {
    seg = st.coda;
    const w = trackAt(seg.w, st.t);
    // From the vowel — or, with none, from the nucleus as it held.
    const nuc = st.nucleus;
    if (nuc !== null) {
      blendInto(nuc.row, 1, s, nextF, nextB, V, VB, nuc.art);
      blendInto(seg.row, w, s, F, B, nextF, nextB, seg.art);
    } else {
      blendInto(seg.row, w, s, F, B, V, VB, seg.art);
    }
    nzAmt = trackAt(seg.nz, st.t);
    if (nasality) {
      const met = nuc !== null ? (nuc.row.fnz > 0 ? Math.min(nuc.row.fnz * s, ceil) : fnp) : vz;
      zf = segZero(seg.row, w, s, met, fnp, ceil);
    }
    segAmps(seg, st.t, ampNow);
    segAmps(seg, st.t + dt, ampNext);
  } else {
    F.set(V); B.set(VB);
    const gl = st.sv !== null;
    ampNow[0] = gl ? trackAt(st.svAv, st.svT) : 1; ampNow[1] = 0; ampNow[2] = 0;
    ampNext[0] = gl ? trackAt(st.svAv, st.svT + dt) : 1; ampNext[1] = 0; ampNext[2] = 0;
    if (nasalV) { nzAmt = 1; zf = vz; }
  }
  const casc = st.casc;
  // Without nasality the zero opens only to a nasal consonant's own.
  const fnz = nasality ? zf : seg !== null && seg.row.fnz > 0 ? Math.min(seg.row.fnz * s, ceil) : fnp;
  setRes(casc, 0, fnp, BNP * s);
  setRes(casc, 3, fnp + nzAmt * (fnz - fnp), BNZ * s);
  for (let n = 0; n < 5; n++) {
    setRes(casc, 6 + (4 - n) * 3, Math.min(F[n], ceil), Math.min(B[n], ceil));
  }
  // The parallel bank, while a consonant can be fricating — in a coda after
  // a hissing nucleus, the nucleus's bank until the coda's own noise starts.
  if (seg !== null && st.nOn) {
    const prev = st.phase === PHASE_CODA && !st.codaNoise;
    const row = prev ? seg.prevRow : seg.row;
    const art = prev ? seg.prevArt : seg.art;
    const bank = st.bank, g = st.bankGain, a = row.bank, ab = row.bankBack;
    setPeakRes(bank, 0, Math.min(F[1], ceil), Math.min(B[1], ceil));
    setPeakRes(bank, 3, Math.min(F[2], ceil), Math.min(B[2], ceil));
    for (let j = 0; j < 3; j++) {
      setPeakRes(bank, 6 + j * 3, Math.min(PAR_F[j] * s, ceil), Math.min(PAR_B[j] * s, ceil));
    }
    // A velar's bank follows the vowel it meets from front (the row's) to
    // back (`bankBack`), its own tongue's when it has a secondary one.
    const back = ab === null ? 0 : art === ART_PALATAL ? 0 : art === ART_DARK ? 1 : 1 - metFront(st);
    for (let j = 0; j < 6; j++) {
      let gj = a[j] > 0 ? dbGain(a[j] - 60) : 0;
      if (ab !== null) gj += back * ((ab[j] > 0 ? dbGain(ab[j] - 60) : 0) - gj);
      g[j] = j === 5 || (j & 1) === 0 ? gj : -gj;
    }
    st.nb = bankNorm(bank, g);
  }

  // The normaliser, for the cascade as it is configured this update — in a
  // consonant at every update, since a consonant's tract moves (a coda's F1
  // sweeping over a harmonic, a nasal's pole left uncancelled) and its level
  // is meant to be its voicing track's alone, not whatever its tract makes of
  // the vowel's correction; in the vowel, and a nucleus holding, every
  // NORM_EVERY updates.
  const steady = st.phase === PHASE_VOWEL || (st.phase === PHASE_ONSET && st.held);
  if (st.fresh || st.normCount <= 0 || !steady) {
    st.nvGoal = cascadeNorm(casc, f0, st.hw, st.hwK);
    st.normCount = NORM_EVERY;
  }
  st.normCount--;
  // Eased in a quarter of the way an update — except in a consonant when the
  // goal FALLS: a resonance building up is met at once, while one ringing out
  // (a goal rising) still holds the energy it stored and is let go gently.
  const nvEnd = st.fresh || (!steady && st.nvGoal < st.nv)
    ? st.nvGoal : st.nv + (st.nvGoal - st.nv) * 0.25;
  if (st.fresh) st.nv = nvEnd;

  // Ramps across the update.
  const inv = 1 / upd;
  st.av = ampNow[0]; st.avStep = (ampNext[0] - ampNow[0]) * inv;
  st.ah = ampNow[1]; st.ahStep = (ampNext[1] - ampNow[1]) * inv;
  st.af = ampNow[2]; st.afStep = (ampNext[2] - ampNow[2]) * inv;
  st.nvStep = (nvEnd - st.nv) * inv;
  st.fresh = false;
  if (st.phase !== PHASE_VOWEL) st.t += dt;
  // The glide's clock runs from the end of the onset; past its end it is done.
  if (st.sv !== null && st.phase !== PHASE_ONSET) {
    st.svT += dt;
    if (st.svT >= st.svEnd) st.sv = null;
  }
}

/** One cascade stage: y = A·x + B·y1 + C·y2. */
function tractRes(co, i, cy, j, x) {
  const y = co[i] * x + co[i + 1] * cy[j] + co[i + 2] * cy[j + 1];
  cy[j + 1] = cy[j];
  cy[j] = y;
  return y;
}

/**
 * A chip source's next sample: the note's OPL channel at output frame `frame`,
 * at the voice's rate and at unity volume (the note's volume is the mixer's to
 * apply to the tract's output), keyed off with the voice. A channel that has
 * rung out while the vowel — or a voiced nucleus, holding — is still singing
 * has nothing left to sing with, and the note ramps out, as a sampled note
 * does at its sample's end; in a consonant the tract's own clock decides.
 */
function chipSource(voice, st, frame) {
  const s = chipRender(st.src, frame, voice.currentPlaybackRate, voice.keyOff);
  const sustaining = st.phase === PHASE_VOWEL || (st.phase === PHASE_ONSET && st.held && st.av > 0);
  if (sustaining && !chipAlive(st.src)) startRampOut(voice);
  return s;
}

/**
 * One output sample of a voice sounding a formant instrument: the source
 * fetched as any sample is — or run, when it is an OPL channel — and brought to
 * FORMANT_LEVEL, through the cascade with the aspiration, plus the frication
 * through the parallel bank. The mixer applies the filter, the voice FX and
 * every gain after this, exactly as for a sampled voice. `frame` is the
 * playhead's chip clock at this sample.
 */
export function renderFormantVoice(eng, voice, inst, interpMode, frame) {
  const st = voice.formant;
  if (st.sgDue) { measureSource(eng, voice, st); st.sgDue = false; }
  const g = st.src !== null ? chipSource(voice, st, frame) : fetchTrackerSample(eng, voice, inst, interpMode);
  if (st.phase === PHASE_DONE) return 0.0;
  if (st.ctl <= 0) {
    formantControl(voice, st);
    if (st.phase === PHASE_DONE) return 0.0;
  }
  st.ctl--;
  const n = st.nOn ? readNoise(eng, st) : 0.0;
  const casc = st.casc, cy = st.cy;
  let x = st.av * st.sg * (g - st.sm) + st.ah * n;
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
