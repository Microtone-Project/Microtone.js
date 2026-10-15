// Formant instrument editing (item 212) — the tract block of a type-1 instrument as
// fields, the record bytes that carry them (TAUD_FILE_FORMAT §7.8), and the
// pool spans such a record claims.
//
// A type-1 record is an ordinary instrument record whose sample is the glottal
// source, so most of it is edited the ordinary way. The tract lives in bytes
// 197…250 and is edited as bytes, through setInstBytesOp, which TaudInst.setByte
// decodes in place — a voice sounding the instrument hears the edit at once.
//
// What makes this kind different for the rest of the editor is that it points
// into the pool in MORE than one place: the source (bytes 4…14 for its
// geometry, the block's first three bytes for its pointer — bytes 0…3 being the
// header) and one noise sample per consonant slot. Everything that moves, frees
// or copies pool bytes has to know all of them; formantRecordSpans and
// retargetFormantRecord are what it asks.

import {
  FORMANT_BLOCK_START, FORMANT_BLOCK_LEN, FORMANT_SLOTS, FORMANT_SLOT_BYTES, FB_SLOTS,
  FB_FRONT, FB_OPEN, FB_ROUND, FB_TRACK, FB_REF, FB_GLIDE, FB_TIMING, FB_RANGE_LO, FB_RANGE_HI, FB_GR,
  SEMIVOWELS,
  META_TYPE_FORMANT, FormantPatch, encodeFormantBlock, CONSONANTS, consonantNeedsNoise,
  vowelCoordsOf, vowelF1F2, vowelFormants, vowelAtPitch, noteHz, timingScale,
} from "../../core/engine/formant.js";
import { buildFormantRecord, DCT_LANE } from "../../core/engine/inst.js";

export {
  META_TYPE_FORMANT, CONSONANTS, vowelF1F2, vowelFormants, vowelAtPitch, noteHz,
  timingScale, vowelCoordsOf,
};

const B = FORMANT_BLOCK_START;
const u16 = (r, o) => r[o] | (r[o + 1] << 8);
const u24 = (r, o) => r[o] | (r[o + 1] << 8) | (r[o + 2] << 16);
const slotAt = (i) => B + FB_SLOTS + i * FORMANT_SLOT_BYTES;

/** Is this raw 256-byte record a type-1 formant instrument? */
export function isFormantRecord(rec) {
  return rec[2] === 0xff && rec[3] === 0xff && (rec[0] >>> 4) === META_TYPE_FORMANT;
}

/**
 * Every pool span a raw type-1 record claims: [{ptr, len, at, role}] where `at`
 * is the record offset of the span's U24 pointer and `role` is "source" or the
 * slot index. Spans of length 0 claim nothing and are left out.
 */
export function formantRecordSpans(rec) {
  const out = [];
  const sl = u16(rec, 4);
  if (sl > 0) out.push({ ptr: u24(rec, B), len: sl, at: B, role: "source" });
  for (let i = 0; i < FORMANT_SLOTS; i++) {
    const o = slotAt(i);
    const len = u16(rec, o + 4);
    if (len > 0) out.push({ ptr: u24(rec, o + 1), len, at: o + 1, role: i });
  }
  return out;
}

/** The same spans read off a decoded TaudInst (the source as its sample). */
export function formantInstSpans(inst) {
  if (!inst?.isFormant) return [];
  const out = [];
  if (inst.sampleLength > 0) {
    out.push({ ptr: inst.samplePtr, len: inst.sampleLength, role: "source",
      rate: inst.samplingRate, loopStart: inst.sampleLoopStart, loopEnd: inst.sampleLoopEnd,
      loopMode: inst.loopMode });
  }
  inst.formant.slots.forEach((s, i) => {
    if (s.len > 0) out.push({ ptr: s.ptr, len: s.len, role: i, rate: s.rate, loopStart: 0, loopEnd: 0, loopMode: 0 });
  });
  return out;
}

/**
 * Point every span of a raw type-1 record through `fn(ptr, len)`, which returns
 * the new pointer (or undefined to leave it). Returns how many moved.
 */
export function retargetFormantRecord(rec, fn) {
  let moved = 0;
  for (const sp of formantRecordSpans(rec)) {
    const to = fn(sp.ptr, sp.len);
    if (to === undefined || to === sp.ptr) continue;
    rec[sp.at] = to & 0xff;
    rec[sp.at + 1] = (to >>> 8) & 0xff;
    rec[sp.at + 2] = (to >>> 16) & 0xff;
    moved++;
  }
  return moved;
}

// ── fields ─────────────────────────────────────────────────────────────────

/** The block as the editor reads it. */
export function formantFields(inst) {
  const f = inst.formant;
  return {
    front: f.front, open: f.open, round: f.round,
    track: f.track, refNote: f.refNote, glide: f.glide, timing: f.timing,
    rangeLo: f.rangeLo, rangeHi: f.rangeHi, semivowel: f.semivowel, rhotic: f.rhotic,
    slots: f.slots.map((s) => ({ ...s })),
  };
}

const BYTE_FIELDS = {
  front: FB_FRONT, open: FB_OPEN, round: FB_ROUND, track: FB_TRACK, glide: FB_GLIDE, timing: FB_TIMING,
};

/** [[recordOffset, byte]] pairs that set one of the block's byte fields. */
export function formantFieldBytes(key, value) {
  if (key in BYTE_FIELDS) return [[B + BYTE_FIELDS[key], Math.max(0, Math.min(255, Math.round(value)))]];
  if (key === "refNote") {
    const v = Math.max(0x20, Math.min(0xffff, Math.round(value)));
    return [[B + FB_REF, v & 0xff], [B + FB_REF + 1, (v >>> 8) & 0xff]];
  }
  throw new Error(`formantFieldBytes: no field ${key}`);
}

/** …the vowel, all three coordinates in one edit (the 2D slider's drag). */
export function formantVowelBytes(front, open, round) {
  return [...formantFieldBytes("front", front), ...formantFieldBytes("open", open),
    ...formantFieldBytes("round", round)];
}

/** …the glide (G: 0 none, 1…4 SEMIVOWELS) and the r-colouring (R), one byte. */
export function formantGrBytes(semivowel, rhotic) {
  return [[B + FB_GR, ((semivowel | 0) & 7) | (rhotic ? 0x80 : 0)]];
}

/** …the pool range, [lo, hi). */
export function formantRangeBytes(lo, hi) {
  const p = (o, v) => [[o, v & 0xff], [o + 1, (v >>> 8) & 0xff], [o + 2, (v >>> 16) & 0xff]];
  return [...p(B + FB_RANGE_LO, lo), ...p(B + FB_RANGE_HI, hi)];
}

/**
 * …one consonant slot: {cons, ptr, len, offset, rate, tilt, gain}. A consonant
 * that reads no noise is written with no sample, so it claims no pool bytes.
 */
export function formantSlotBytes(i, s) {
  const o = slotAt(i);
  const noise = consonantNeedsNoise(CONSONANTS[s.cons]);
  const ptr = noise ? s.ptr ?? 0 : 0;
  const len = noise ? s.len ?? 0 : 0;
  const offset = noise ? s.offset ?? 0 : 0;
  const rate = noise ? s.rate ?? 0 : 0;
  const tilt = noise ? s.tilt ?? 0 : 0;
  const gain = noise ? s.gain ?? 0 : 0;
  return [
    [o, s.cons & 0xff],
    [o + 1, ptr & 0xff], [o + 2, (ptr >>> 8) & 0xff], [o + 3, (ptr >>> 16) & 0xff],
    [o + 4, len & 0xff], [o + 5, (len >>> 8) & 0xff],
    [o + 6, offset & 0xff], [o + 7, (offset >>> 8) & 0xff],
    [o + 8, rate & 0xff], [o + 9, (rate >>> 8) & 0xff],
    [o + 10, tilt & 0xff], [o + 11, gain & 0xff],
  ];
}

/** A recipe from the machine (formantrecipe.js) as a slot. The generator's
 *  and the voice-only recipe are both a slot with no sample. */
export function slotFromRecipe(cons, r) {
  if (!r || !r.cand) return { cons, ptr: 0, len: 0, offset: 0, rate: 0, tilt: r?.tilt ?? 0, gain: r?.gain ?? 0 };
  return { cons, ptr: r.cand.ptr, len: r.cand.len, offset: r.offset, rate: r.rate, tilt: r.tilt, gain: r.gain };
}

/** Is slot `s` (fields) what recipe `r` would write? */
export function slotIsRecipe(s, r) {
  if (r.cand === null) return s.len === 0 && s.tilt === r.tilt && s.gain === r.gain;
  return s.ptr === r.cand.ptr && s.len === r.cand.len && s.offset === r.offset &&
    s.rate === r.rate && s.tilt === r.tilt && s.gain === r.gain;
}

/**
 * …the glottal source: a census entry and the rate that makes it sound middle
 * C at note $5000. The pointer goes to the block, the rest where an ordinary
 * sample's would. A looped source PLAYS FROM its loop: the loop is what was
 * chosen and measured, and what lies before it — in a window of a recording,
 * whatever was said before — is neither.
 */
export function formantSourceBytes(e, c4Rate) {
  const w16 = (o, v) => [[o, v & 0xff], [o + 1, (v >>> 8) & 0xff]];
  const looped = (e.loopMode & 3) !== 0 && (e.loopMode & 3) !== 3;
  return [
    [B, e.ptr & 0xff], [B + 1, (e.ptr >>> 8) & 0xff], [B + 2, (e.ptr >>> 16) & 0xff],
    ...w16(4, e.len),
    ...w16(6, Math.max(1, Math.min(65535, Math.round(c4Rate)))),
    ...w16(8, looped ? e.loopStart : 0),
    ...w16(10, looped ? e.loopStart : 0),
    ...w16(12, looped ? e.loopEnd : 0),
  ];
}

/** The loop-mode bits of byte 14 for a source, keeping the record's other bits. */
export function formantSourceFlagByte(inst, e) {
  return [[14, (inst.loopMode & ~0x07) | (e.loopMode & 0x07)]];
}

/** A new formant instrument's fadeout (defaultFormantRecord). */
export const FORMANT_DEFAULT_FADEOUT = 32;

/**
 * A new type-1 record: the source (a census entry, or null for none yet), its
 * C4 rate, the pool range, and the vowel [a] with no consonants — a sung "ah"
 * until the editor says otherwise. Note Off is its New Note Action, and its
 * Duplicate Check is Lane → Note Off (item 216): ANY note arriving on the
 * lane, whatever instrument plays it, keys off every syllable of this one
 * still singing its vowel there, so each speaks its coda in the background
 * while the next begins. A syllable with no coda goes on singing its vowel
 * through its release, so the fadeout is what ends it: 32 = 32 ticks, about
 * 0.64 s at 125 BPM — slow enough that a coda is heard out, at the cost of
 * one ending a little quieter than it began.
 */
export function defaultFormantRecord(source, c4Rate, rangeLo, rangeHi) {
  const p = new FormantPatch();
  p.srcPtr = source ? source.ptr : 0;
  p.rangeLo = rangeLo;
  p.rangeHi = rangeHi;
  const looped = source && (source.loopMode & 3) !== 0 && (source.loopMode & 3) !== 3;
  return buildFormantRecord(encodeFormantBlock(p), {
    ptr: source ? source.ptr : 0,
    len: source ? source.len : 0,
    rate: source ? Math.max(1, Math.min(65535, Math.round(c4Rate))) : 0,
    playStart: looped ? source.loopStart : 0,
    loopStart: looped ? source.loopStart : 0,
    loopEnd: looped ? source.loopEnd : 0,
    loopMode: source ? source.loopMode & 0x07 : 0,
  }, { nna: 0, dct: DCT_LANE, dca: 1, fadeout: FORMANT_DEFAULT_FADEOUT });
}

// ── the chart's marks ──────────────────────────────────────────────────────
//
// IPA vowels where the IPA chart puts them — as TONGUE positions with the
// lips spread or rounded, the bytes a mark sets. The sixteen cardinal vowels
// are the corners and edges of the engine's table: front 255, back 0, at
// openness 0, 85, 170 and 255. The central vowels sit midway across their row
// (central is "between front and back"), schwa at the chart's centre, and the
// near-close and near-open vowels between the rows they lie between. Where a
// mark is DRAWN is where it sounds (formant.js vowelF1F2), so the two members
// of a pair part on the chart exactly as far as rounding moves the sound.

/** [ipa, front, open, rounded]. */
const MARKS = [
  ["i", 255, 0, 0], ["y", 255, 0, 1], ["ɨ", 128, 0, 0], ["ʉ", 128, 0, 1], ["ɯ", 0, 0, 0], ["u", 0, 0, 1],
  ["ɪ", 215, 42, 0], ["ʏ", 205, 42, 1], ["ʊ", 45, 42, 1],
  ["e", 255, 85, 0], ["ø", 255, 85, 1], ["ɘ", 128, 85, 0], ["ɵ", 128, 85, 1], ["ɤ", 0, 85, 0], ["o", 0, 85, 1],
  ["ə", 128, 128, 0],
  ["ɛ", 255, 170, 0], ["œ", 255, 170, 1], ["ɜ", 128, 170, 0], ["ɞ", 128, 170, 1], ["ʌ", 0, 170, 0], ["ɔ", 0, 170, 1],
  ["æ", 255, 212, 0], ["ɐ", 128, 212, 0],
  ["a", 255, 255, 0], ["ɶ", 255, 255, 1], ["ɑ", 0, 255, 0], ["ɒ", 0, 255, 1],
];

/** The marks, as {ipa, front, open, round} in chart bytes. */
export const VOWEL_MARKS = Object.freeze(MARKS.map(([ipa, front, open, r]) =>
  Object.freeze({ ipa, front, open, round: r ? 255 : 0 })));

/** The mark nearest a chart point, roundness counted as a third axis. */
export function nearestVowelMark(front, open, round) {
  let best = null, bd = Infinity;
  for (const m of VOWEL_MARKS) {
    const d = (m.front - front) ** 2 + (m.open - open) ** 2 + ((m.round - round) * 0.5) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

/** `S $Afgr` for a chart point: the nearest nibbles to openness, frontness, roundness. */
export function vowelEffectArg(front, open, round) {
  const n = (v) => Math.max(0, Math.min(15, Math.round(v / 17)));
  return 0xa000 | (n(open) << 8) | (n(front) << 4) | n(round);
}

/** A vowel symbol r-coloured: [ə] and [ɜ] have letters of their own, any
 *  other takes the rhotic hook. */
export function rhoticIpa(ipa) {
  return ipa === "ə" ? "ɚ" : ipa === "ɜ" ? "ɝ" : ipa + "\u02DE";
}

/** The syllable a record says, in IPA — CCGVRC: the onset, the glide, the
 *  nearest vowel mark (r-coloured when R), the coda. */
export function formantSyllable(inst) {
  const f = inst.formant;
  const c = (i) => CONSONANTS[f.slots[i].cons]?.ipa ?? "";
  const v = nearestVowelMark(f.front, f.open, f.round)?.ipa ?? "";
  return c(0) + c(1) + (SEMIVOWELS[f.semivowel]?.ipa ?? "") + (v && f.rhotic ? rhoticIpa(v) : v) + c(2);
}

/** What the list badge says a formant instrument is. */
export function formantBadge() {
  return "FMNT";
}

export { FORMANT_BLOCK_LEN };
