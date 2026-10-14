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
  FB_FRONT, FB_OPEN, FB_ROUND, FB_TRACK, FB_REF, FB_GLIDE, FB_TIMING, FB_RANGE_LO, FB_RANGE_HI,
  META_TYPE_FORMANT, FormantPatch, encodeFormantBlock, CONSONANTS, consonantNeedsNoise,
  vowelCoordsOf, vowelF1, vowelF2, vowelFormants, vowelAtPitch, noteHz, timingScale,
  VOWEL_F1_MIN, VOWEL_F1_MAX, VOWEL_FRONT_EDGE, VOWEL_BACK_EDGE,
} from "../../core/engine/formant.js";
import { buildFormantRecord } from "../../core/engine/inst.js";

export {
  META_TYPE_FORMANT, CONSONANTS, vowelF1, vowelF2, vowelFormants, vowelAtPitch, noteHz,
  timingScale, vowelCoordsOf, VOWEL_F1_MIN, VOWEL_F1_MAX, VOWEL_FRONT_EDGE, VOWEL_BACK_EDGE,
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
    rangeLo: f.rangeLo, rangeHi: f.rangeHi,
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

/** A recipe from the machine (formantrecipe.js) as a slot. */
export function slotFromRecipe(cons, r) {
  if (!r || !r.cand) return { cons, ptr: 0, len: 0, offset: 0, rate: 0, tilt: 0, gain: 0 };
  return { cons, ptr: r.cand.ptr, len: r.cand.len, offset: r.offset, rate: r.rate, tilt: r.tilt, gain: r.gain };
}

/**
 * …the glottal source: a census entry and the rate that makes it sound middle
 * C at note $5000. The pointer goes to the block, the rest where an ordinary
 * sample's would.
 */
export function formantSourceBytes(e, c4Rate) {
  const w16 = (o, v) => [[o, v & 0xff], [o + 1, (v >>> 8) & 0xff]];
  const looped = (e.loopMode & 3) !== 0 && (e.loopMode & 3) !== 3;
  return [
    [B, e.ptr & 0xff], [B + 1, (e.ptr >>> 8) & 0xff], [B + 2, (e.ptr >>> 16) & 0xff],
    ...w16(4, e.len),
    ...w16(6, Math.max(1, Math.min(65535, Math.round(c4Rate)))),
    ...w16(8, 0),
    ...w16(10, looped ? e.loopStart : 0),
    ...w16(12, looped ? e.loopEnd : 0),
  ];
}

/** The loop-mode bits of byte 14 for a source, keeping the record's other bits. */
export function formantSourceFlagByte(inst, e) {
  return [[14, (inst.loopMode & ~0x07) | (e.loopMode & 0x07)]];
}

/**
 * A new type-1 record: the source (a census entry, or null for none yet), its
 * C4 rate, the pool range, and the vowel [a] with no consonants — a sung "ah"
 * until the editor says otherwise. Note Off is its New Note Action, so a new
 * note lets the old one finish its coda in the background.
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
    loopStart: looped ? source.loopStart : 0,
    loopEnd: looped ? source.loopEnd : 0,
    loopMode: source ? source.loopMode & 0x07 : 0,
  }, { nna: 0 });
}

// ── the chart's marks ──────────────────────────────────────────────────────
//
// IPA vowels where the chart puts them. The sixteen cardinal vowels sit at
// Catford's measurements (the same anchors the chart's edges run through);
// the central vowels sit midway across their row — central is "between front
// and back" — and schwa at the uniform tube's 500 / 1500 Hz. A rounded vowel
// and its unrounded partner that share a position share a dot, unrounded on
// the left, as the IPA chart draws them. Clicking a mark sets the roundness
// too, which is what the mark means.

const CARDINAL = [
  ["i", 240, 2400, 0], ["y", 235, 2100, 1], ["e", 390, 2300, 0], ["ø", 370, 1900, 1],
  ["ɛ", 610, 1900, 0], ["œ", 585, 1710, 1], ["a", 850, 1610, 0], ["ɶ", 820, 1530, 1],
  ["ɑ", 750, 940, 0], ["ɒ", 700, 760, 1], ["ʌ", 600, 1170, 0], ["ɔ", 500, 700, 1],
  ["ɤ", 460, 1310, 0], ["o", 360, 640, 1], ["ɯ", 300, 1390, 0], ["u", 250, 595, 1],
];

function markAt(ipa, front, open, round) {
  return { ipa, front: Math.round(front), open: Math.round(open), round: round ? 255 : 0 };
}

/** The marks, as {ipa, front, open, round} in chart bytes. */
export const VOWEL_MARKS = (() => {
  const out = [];
  for (const [ipa, f1, f2, r] of CARDINAL) {
    const [front, open] = vowelCoordsOf(f1, f2);
    out.push(markAt(ipa, front, open, r));
  }
  const rowOpen = (f1) => vowelCoordsOf(f1, 1000)[1];
  // Central: halfway across the row at each of the four heights.
  for (const [u, r, f1] of [["ɨ", "ʉ", 280], ["ɘ", "ɵ", 390], ["ɜ", "ɞ", 600]]) {
    const open = rowOpen(f1);
    out.push(markAt(u, 128, open, 0), markAt(r, 128, open, 1));
  }
  {
    const [front, open] = vowelCoordsOf(500, 1500);
    out.push(markAt("ə", front, open, 0));
  }
  // Near-close and near-open, between the rows they lie between.
  const nc = rowOpen(310), no = rowOpen(730);
  out.push(markAt("ɪ", 215, nc, 0), markAt("ʏ", 205, nc, 1), markAt("ʊ", 45, nc, 1));
  out.push(markAt("æ", 245, no, 0), markAt("ɐ", 128, no, 0));
  return Object.freeze(out);
})();

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

/** The syllable a record says, in IPA: onset, nearest vowel mark, coda. */
export function formantSyllable(inst) {
  const f = inst.formant;
  const c = (i) => CONSONANTS[f.slots[i].cons]?.ipa ?? "";
  return c(0) + c(1) + (nearestVowelMark(f.front, f.open, f.round)?.ipa ?? "") + c(2);
}

/** What the list badge says a formant instrument is. */
export function formantBadge() {
  return "FMNT";
}

export { FORMANT_BLOCK_LEN };
