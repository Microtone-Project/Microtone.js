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
// What is here is what the page computes with: the record and its tract block
// (codec), the consonant and vowel tables, the vowel geometry, and the
// syllable's plan — formantNoteOn lays out the onset, nucleus and coda a note
// will say, which the Lyrics tab measures. The synthesis itself (the
// resonators, the noise, the source measurement, the per-sample control) is
// the engine's: core/engine/c/src/formant.c.

import { SAMPLING_RATE, SAMPLE_BIN_TOTAL, LINEAR_FREQ_C4_HZ, MIDDLE_C } from "./constants.js";
import { attenGainOf } from "./tables.js";

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
    this.dRefNote = 0;     // the pitch extension of refNote (file format §9.18)
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
    // A LYRIC SYLLABLE (item 280, lyricSyllable below) times each of its
    // consonants and its glide by a byte of its own: [onset 1, onset 2, coda,
    // glide], each a scale read as `timing` is and applied ON TOP of it — 128
    // is the record's own pace. Null on a record, whose one byte times them all.
    this.slotTiming = null;
    // …and the record it is a syllable of (that record's patch), for whoever
    // asks which instrument a note is singing; null on a record.
    this.lyricOf = null;
  }
}

/** The timing scale of slot `i` (0, 1 the onset, 2 the coda, 3 the glide):
 *  the record's, times a lyric syllable's own for the slot. */
function slotScale(patch, i) {
  const k = timingScale(patch.timing);
  return patch.slotTiming !== null ? k * timingScale(patch.slotTiming[i]) : k;
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
  decodeGr(patch, raw[off + FB_GR] & 0xff);
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

/** The glide, the articulations and R (the block's +53, a lyric syllable's
 *  +4) into `patch`; a glide code 5…7 is RESERVED and sounds as none. */
function decodeGr(patch, gr) {
  patch.semivowel = (gr & 7) <= 4 ? gr & 7 : 0;
  patch.secondary = (gr >>> 3) & 3;
  patch.codaArt = (gr >>> 5) & 3;
  patch.rhotic = (gr & 0x80) !== 0;
}

/**
 * A LYRIC SYLLABLE (item 280; TAUD_ENGINE_SPEC §5.5.3, "Lyric instruments"):
 * the record's patch `rec` with syllable `syl` of its `ILyr` entry in place —
 * the vowel, whether there is one and whether it is nasalised, the glide, the
 * articulations, R, the three consonants with the noise each reads (`recipes`,
 * a Map consonant id → recipe; a consonant with none sounds the generator)
 * and the four timing bytes. Everything else is the record's: the source, the
 * size tracking, the reference note, the vowel glide, the pool range. Written
 * into `out` IN PLACE, so that a note singing it follows an edit of the record
 * as a note singing the record does.
 */
export function lyricSyllable(rec, syl, recipes, out = new FormantPatch()) {
  out.srcPtr = rec.srcPtr;
  out.srcInst = rec.srcInst;
  out.front = syl.front & 0xff;
  out.open = syl.open & 0xff;
  out.round = syl.round & 0xff;
  out.track = rec.track;
  out.refNote = syl.vowel ? (rec.refNote !== 0 ? rec.refNote : FORMANT_DEFAULT_REF) : 0;
  out.dRefNote = syl.vowel ? (rec.dRefNote || 0) : 0;
  out.nasal = !!syl.nasal;
  out.glide = rec.glide;
  out.timing = rec.timing;
  out.rangeLo = rec.rangeLo;
  out.rangeHi = rec.rangeHi;
  decodeGr(out, syl.gr & 0xff);
  for (let i = 0; i < FORMANT_SLOTS; i++) {
    const s = out.slots[i];
    const cons = syl.cons[i] & 0xff;
    const r = cons !== 0 ? recipes.get(cons) ?? null : null;
    s.cons = cons;
    s.ptr = r !== null ? r.ptr & 0xffffff : 0;
    s.len = r !== null ? r.len & 0xffff : 0;
    s.offset = r !== null ? r.offset & 0xffff : 0;
    s.rate = r !== null ? r.rate & 0xffff : 0;
    s.tilt = r !== null ? r.tilt : 0;
    s.gain = r !== null ? r.gain & 0xff : 0;
  }
  if (out.slotTiming === null) out.slotTiming = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out.slotTiming[i] = syl.timing[i] & 0xff;
  out.lyricOf = rec;
  return out;
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
  { dorsal = false, bankBack = null, breath = false } = {}) {
  return Object.freeze({ id, ipa, manner, voiced, place, F, B, bank, lvl, dur, burst, vot, trans, av, fnz, dorsal, bankBack, breath });
}
const FMT_VELAR_STOP = Object.freeze({ dorsal: true, bankBack: K_K_BACK });
const FMT_VELAR = Object.freeze({ dorsal: true });
/** `breath`: the row's frication is BREATH — its noise goes through the
 *  cascade, as an aspirate's does, not through the parallel bank ([ʔ͡h]). */
const FMT_BREATH = Object.freeze({ breath: true });

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
  // ʈʰ: Mikuteit & Reetz (2007, East Bengali) measure a retroflex aspirate's
  // lag at 48 ms against the dental's 57; [tʰ]'s 70 scaled by that is 60.
  consRow(17, "ʈʰ", MN_S, false, PLACE_RETROFLEX, [400, 1500, 1900], [300, 120, 250], K_RETRO_STOP, -10, 0, 10, 60, 45),
  // The breathy-voiced (murmured) stops: a voiced stop whose `vot` is its
  // release's noisy lag before clear voicing — Mikuteit & Reetz's after-closure
  // time, 31 / 35 / 36 / 44 ms by place — and then BREATHY_SA of breathy voice.
  consRow(18, "bʱ", MN_S, true, PLACE_BILABIAL, [200, 1100, 2150], [60, 110, 130], K_LABIAL, -14, 0, 5, 31, 40),
  consRow(19, "dʱ", MN_S, true, PLACE_ALVEOLAR, [200, 1600, 2600], [60, 100, 170], K_D, -12, 0, 8, 35, 45),
  consRow(20, "ɖʱ", MN_S, true, PLACE_RETROFLEX, [200, 1500, 1900], [60, 100, 170], K_RETRO_STOP, -12, 0, 8, 36, 45),
  consRow(21, "ɡʱ", MN_S, true, PLACE_VELAR, [200, 1990, 2850], [60, 150, 280], K_K_FRONT, -12, 0, 15, 44, 50, 0, 0, FMT_VELAR_STOP),
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
  // An aspirated fricative: `vot` is the breath after its frication — Korean
  // ㅅ's 53 ms (Chang 2008), its frication ¾ of the tense [s*]'s, 120 → 90.
  consRow(75, "sʰ", MN_FR, false, PLACE_ALVEOLAR, [320, 1390, 2530], [200, 80, 200], K_S, -8, 90, 0, 53, 40),
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
  // These pair a stop's burst with a fricative's tract and spectrum; a weak
  // fricative's level is 6 dB up, as [p͡f]'s is.
  consRow(106, "c͡ç", MN_AF, false, PLACE_PALATAL, [300, 2100, 3000], [200, 150, 300], K_C, -12, 70, 15, 0, 45),
  consRow(107, "ɟ͡ʝ", MN_AF, true, PLACE_PALATAL, [240, 2100, 3000], [60, 150, 300], K_C, -16, 60, 12, 0, 45),
  consRow(108, "t͡θ", MN_AF, false, PLACE_DENTAL, [320, 1290, 2540], [200, 90, 200], K_TH, -18, 70, 8, 0, 40),
  consRow(109, "d͡ð", MN_AF, true, PLACE_DENTAL, [270, 1290, 2540], [60, 80, 170], K_TH, -22, 60, 8, 0, 40),
  consRow(110, "ɡ͡ɣ", MN_AF, true, PLACE_VELAR, [240, 1800, 2700], [60, 150, 300], K_X, -16, 60, 15, 0, 50, 0, 0, FMT_VELAR),
  // The glottal affricate: a glottal stop released into [h] — no oral burst,
  // its breath [h]'s own, through the cascade at the vowel's formants.
  consRow(111, "ʔ͡h", MN_AF, false, PLACE_GLOTTAL, [0, 0, 0], [300, 0, 0], K_NONE, -16, 50, 0, 0, 15, 0, 0, FMT_BREATH),
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
/** A breathy-voiced stop's release: after its noisy lag (the row's `vot`) the
 *  voice comes in BREATHY — the breath laid over it — for this long
 *  (Mikuteit & Reetz 2007: 47 ms, twice a voiceless aspirate's), rising from
 *  MURMUR_AV. Through the lag the breath carries the sound and the voice is
 *  26 dB under the vowel's, the two together about 20 dB under it (Schiefer
 *  & Kotten 1983 measured the breathy part 10–30 dB below the vowel's
 *  steady part). */
export const BREATHY_SA = 47;
const MURMUR_AV = 0.05;
/** Is the row a breathy-voiced stop ([bʱ]): voiced, with a release lag? */
const isBreathy = (r) => r.manner === MANNER_STOP && r.voiced && r.vot > 0;
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

/** Tracks with their two noise paths exchanged: frication built as a row's
 *  `af` sounds through the cascade as `ah`, and the other way about. */
const breathed = (t) => ({ ...t, ah: t.af, af: t.ah });

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
function onsetTracksOf(r, first, nx, k, art = ART_NONE) {
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
      if (isBreathy(r)) {
        // The closure voiced; the release a noisy lag over a weak voice — its
        // breath at the burst's own level, a breathy release's airflow being
        // a voiceless aspirate's and more — then the voice rising through it.
        const ts = tv + BREATHY_SA * k;
        av.at(0, cl > 0 ? 0.25 : 0.3).at(cl, cl > 0 ? 0.25 : 0.3).at(tb, 0.3).at(tb + 3 * k, MURMUR_AV)
          .at(tv, MURMUR_AV).at(ts, nx.av);
        ah.at(tb, 0).at(tb + 3 * k, L).at(tv, 0.7 * L).at(ts, nx.ah);
        end = Math.max(ts, tb + tr);
        break;
      }
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
      if (!glot && !r.voiced && r.vot > 0) {
        // Aspirated: the frication gives way to breath, and the voice waits
        // for the breath to end.
        const tv = dur + r.vot * k;
        const La = L * dbGain(ASPIRATION_DB);
        ah.at(0, 0).at(dur - 10 * k, 0).at(dur, La).at(tv, 0.7 * La).at(tv + 10 * k, nx.ah);
        av.at(0, 0).at(tv - 5 * k, 0).at(tv + 15 * k, nx.av);
        w.at(0, 1).at(dur, 1).at(dur + tr, 0);
        nz.at(0, 0).at(tv, 0);
        end = Math.max(tv + 15 * k, dur + tr);
        break;
      }
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

/** The onset tracks — a BREATH row's ([ʔ͡h]) frication is its aspiration. */
export function onsetTracks(r, first, nx, k, art = ART_NONE) {
  if (!r.breath) return onsetTracksOf(r, first, nx, k, art);
  return breathed(onsetTracksOf(r, first, { av: nx.av, ah: nx.af, af: nx.ah, nz: nx.nz }, k, art));
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
function nucleusTracksOf(r, first, k, art = ART_NONE) {
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
      } else if (isBreathy(r)) {
        const a = cl > 0 ? 0.25 : 0.3;
        const tv = tb + r.vot * k, ts = tv + BREATHY_SA * k;
        av.at(0, a).at(cl, a).at(tb, 0.3).at(tb + 3 * k, MURMUR_AV).at(tv, MURMUR_AV).at(ts, 1);
        ah.at(tb, 0).at(tb + 3 * k, L).at(tv, 0.7 * L).at(ts, 0);
        end = ts;
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

/** The nucleus tracks — a BREATH row's ([ʔ͡h]) frication is its aspiration. */
export function nucleusTracks(r, first, k, art = ART_NONE) {
  if (!r.breath) return nucleusTracksOf(r, first, k, art);
  return breathed(nucleusTracksOf(r, first, k, art));
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
function codaTracksOf(r, k, v0 = 1, z0 = 0, art = CODA_RELEASED) {
  const w = new FormantTrack(), av = new FormantTrack(), ah = new FormantTrack(), af = new FormantTrack(), nz = new FormantTrack();
  const L = dbGain(r.lvl);
  const tr = r.trans * k, dur = r.dur * k;
  const glot = art === CODA_GLOTTAL;
  const gs = GLOT_STOP * k;
  // Where the coda HOLDS while the key does, after S $9010 (item 292): the end
  // of the consonant's steady part — a stop in its closure, before the burst —
  // and, for a trill, the cycle it repeats there (`loop`).
  let end, hold, loop = 0;
  switch (r.manner) {
    case MANNER_STOP:
    case MANNER_AFFRICATE: {
      const tc = tr + CLOSURE_MS * k;        // the release
      const tb = tc + r.burst * k;
      // A ms before the release: AT tc the burst's frication has already
      // stepped on (the later of two points at one time holds).
      hold = tc - k;
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
        if (!glot && r.vot > 0) {
          const La = L * dbGain(ASPIRATION_DB);
          ah.at(tb, 0).at(tb + 2 * k, 0.5 * La).at(tb + 30 * k, 0);
          // A breathy stop's release is murmured: a weak voice under its breath.
          if (r.voiced) av.at(tb, 0).at(tb + 2 * k, MURMUR_AV).at(tb + 30 * k, 0);
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
      hold = tr + dur;
      w.at(0, 0).at(tr, 1);
      if (glot) av.at(0, v0).at(a, v0).at(a + gs, 0);
      else if (r.voiced) av.at(0, v0).at(tr, r.av).at(tr + dur, 0.7 * r.av).at(tr + dur + 30 * k, 0);
      else av.at(0, v0).at(a, v0).at(tr + 5 * k, 0);
      af.at(0, 0).at(a, 0).at(tr + 5 * k, L).at(tr + dur, 0.8 * L).at(tr + dur + 30 * k, 0);
      ah.at(0, 0); nz.at(0, z0).at(tr, 0);
      end = tr + dur + 30 * k;
      if (!glot && !r.voiced && r.vot > 0) {   // aspirated: its breath after it
        const La = L * dbGain(ASPIRATION_DB);
        ah.at(tr + dur, 0).at(tr + dur + 10 * k, 0.5 * La).at(tr + dur + (r.vot + 30) * k, 0);
        end = tr + dur + (r.vot + 30) * k;
      }
      break;
    }
    case MANNER_ASPIRATE: {
      hold = dur;
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
      hold = tr + dur;
      w.at(0, 0).at(tr, 1);
      nz.at(0, z0).at(Math.max(tr - 5 * k, 0), z0).at(tr, 1);
      av.at(0, v0).at(tr, r.av).at(tr + dur, 0.8 * r.av);
      end = tr + dur + (glot ? gs : 40 * k);
      av.at(end, 0);
      ah.at(0, 0); af.at(0, 0);
      break;
    }
    case MANNER_APPROX: {
      hold = tr + dur;
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
        hold = tr + dur;
      } else {
        av.at(tr + dur + 3 * k, 0.6);
        end = tr + dur + 40 * k;
        hold = tr + dur + 3 * k;
      }
      av.at(end, 0);
      ah.at(0, 0); af.at(0, 0); nz.at(0, z0).at(tr, 0);
      break;
    }
    case MANNER_TRILL: {
      const c = dur, shut = c * 0.375;
      // [tr + shut, tr + c + shut) is one whole cycle, closure to closure.
      hold = tr + c + shut;
      loop = c;
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
      hold = end;
      break;
    }
  }
  return {
    end, hold: Math.min(hold, end), loop: hold < end ? loop : 0,
    w: w.close(end, 1), av: av.close(end, 0), ah: ah.close(end, 0), af: af.close(end, 0), nz: nz.close(end, 0),
  };
}

/** The coda tracks — a BREATH row's ([ʔ͡h]) frication is its aspiration. */
export function codaTracks(r, k, v0 = 1, z0 = 0, art = CODA_RELEASED) {
  if (!r.breath) return codaTracksOf(r, k, v0, z0, art);
  return breathed(codaTracksOf(r, k, v0, z0, art));
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
    end: t.end + rel, hold: t.hold + rel, loop: t.loop,
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

/** Harmonics the normaliser measures, at most. */
const NORM_HARMONICS = 64;
/** The level a formant instrument sings at: a full-scale sawtooth's RMS, 1 ÷ √3 —
 *  and so a full-scale white noise's too. The source is brought to it. */
export const FORMANT_LEVEL = 0.5773502691896258;
/** Where the noise generator starts, at every consonant. */
const NOISE_SEED = 0x9e3779b9;

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

/** One consonant as it sounds: its row, its slot's recipe, its tracks. */
class FormantSegment {
  constructor(row, slot, tr, art = ART_NONE) {
    this.row = row;
    this.slot = slot;
    this.end = tr.end;
    this.w = tr.w; this.av = tr.av; this.ah = tr.ah; this.af = tr.af; this.nz = tr.nz;
    this.next = null; // the onset consonant that follows, or null for the vowel
    this.art = art;   // its articulation as blendInto reads it: ART_NONE, _PALATAL or _DARK
    this.loop = tr.loop ?? 0;  // a held nucleus's repeat, ms (a trill's cycle); a coda's, while held
    this.hold = tr.hold ?? tr.end;  // a coda: where S $9010 holds it while the key is held
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

/**
 * How far the vowel is nasalised, or r-coloured: 0 not at all, 1 fully, and
 * between while `S $90kx` (item 292), or an instrument change, glides it.
 * Until the note is given one of its own (`own`) it is the record's bit, read
 * afresh every update, as the vowel is; `rejoin` is an instrument change's
 * glide, after which the note follows the new record again.
 */
class FormantAmount {
  constructor() {
    this.own = false;
    this.v = 0.0;      // where it stands
    this.to = 0.0;     // where a glide is heading…
    this.step = 0.0;   // …per ms…
    this.left = 0.0;   // …and how long it has to go, ms
    this.rejoin = false;
  }
  copy(src) {
    this.own = src.own; this.v = src.v; this.to = src.to; this.step = src.step;
    this.left = src.left; this.rejoin = src.rejoin;
    return this;
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
    // S $9xxx (item 292): the vowel's nasalisation and r-colouring as the
    // note has them, the glide time it was given (−1: the record's), and a
    // coda called for while the key is still held.
    this.nasAmt = new FormantAmount();
    this.rhoAmt = new FormantAmount();
    this.glideOv = -1;
    this.codaCall = false;
    this.codaZ0 = 0.0;        // the vowel nasality the coda was built from
    this.atVowel = false;     // started at the vowel (formantStartAtVowel)
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
    this.VR = new Float64Array(5); this.VRB = new Float64Array(5);
  }
}

/**
 * Note-on: build the syllable. The onset is slots 0 and 1 in that order,
 * whichever of them name a consonant; the coda is slot 2. Every filter starts
 * from rest — the tract of the note before is not this note's.
 *
 * `keep` says the syllable again for the SAME note (Q's retrigger, or an
 * `S $90kx` on the trigger row that changed the nasality the onset heads
 * for): what `S $9xxx` gave the note stays its own, its glides stopping where
 * they stand, as formantRestart keeps the vowel.
 */
export function formantNoteOn(st, patch, keep = false) {
  st.patch = patch;
  if (!keep) {
    amtReset(st.nasAmt, patch.nasal);
    amtReset(st.rhoAmt, patch.rhotic);
    st.glideOv = -1;
    st.codaCall = false;
  } else {
    st.nasAmt.left = 0.0; st.nasAmt.rejoin = false;
    st.rhoAmt.left = 0.0; st.rhoAmt.rejoin = false;
  }
  st.atVowel = false;
  const vowel = formantHasVowel(patch);
  const rows = [];
  for (let i = 0; i < 2; i++) {
    const r = CONSONANTS[patch.slots[i].cons];
    if (r !== undefined) rows.push([r, patch.slots[i], slotScale(patch, i)]);
  }
  // With no vowel, the last onset consonant is the nucleus — or, with no
  // onset, the coda's consonant, which then leaves no coda after it.
  let coda = true;
  if (!vowel && rows.length === 0) {
    const r = CONSONANTS[patch.slots[2].cons];
    if (r !== undefined) { rows.push([r, patch.slots[2], slotScale(patch, 2)]); coda = false; }
  }
  // The glide, if any: on its semivowel for the approximant's steady time,
  // then into the vowel over its transition, its voicing rising to the
  // vowel's over the first half of that. A syllable with no vowel has none.
  const sv = vowel ? SEMIVOWELS[patch.semivowel] ?? null : null;
  st.sv = sv; st.svT = 0.0;
  if (sv !== null) {
    const r = CONSONANTS[sv.row];
    const k = slotScale(patch, 3);
    const dur = r.dur * k, tr = r.trans * k;
    st.svEnd = dur + tr;
    st.svW = new FormantTrack().at(0, 1).at(dur, 1).at(dur + tr, 0).close(st.svEnd, 0);
    st.svAv = new FormantTrack().at(0, r.av).at(dur, r.av).at(dur + tr * 0.5, 1).close(st.svEnd, 1);
  }
  // Built back to front: each consonant ends where the next one starts — the
  // last on the glide, when there is one, and a nasalised vowel's velum
  // already lowered. The last consonant carries the secondary articulation;
  // without a vowel it is the nucleus, and holds.
  const nasal = vowel && nasalOf(st, patch);
  const segs = new Array(rows.length);
  let nx = sv !== null ? { av: st.svAv[1], ah: 0, af: 0, nz: nasal ? 1 : 0 }
    : nasal ? NASAL_VOWEL_START : VOWEL_START;
  let next = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const [r, slot, k] = rows[i];
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
  st.coda = coda ? buildCoda(st, patch, slotScale(patch, 2), nasal ? st.nasAmt.v : 0) : null;
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
 * letting its hiss go first. Null with no coda consonant. `vz` is how
 * nasalised the vowel is as the coda leaves it (0…1), when it has one.
 */
function buildCoda(st, patch, k, vz) {
  const cr = CONSONANTS[patch.slots[2].cons];
  if (cr === undefined) return null;
  const art = patch.codaArt;
  const tract = art === CODA_DARK ? ART_DARK : ART_NONE;
  const nuc = st.nucleus;
  if (nuc === null) {
    const z0 = formantHasVowel(patch) ? vz : 0;
    st.codaZ0 = z0;
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

/** A note's amount as its trigger starts it: its record's bit. */
function amtReset(a, on) {
  a.own = false; a.v = on ? 1 : 0; a.to = a.v; a.step = 0.0; a.left = 0.0; a.rejoin = false;
}

/** Is the vowel the onset heads for nasalised, at all? The note's own
 *  nasality when it has one, else its record's bit. */
function nasalOf(st, patch) {
  return st.nasAmt.own ? st.nasAmt.v > 0 : patch.nasal;
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

