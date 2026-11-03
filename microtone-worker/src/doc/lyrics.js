// A lyric instrument's lyrics, as written → its `ILyr` entry (item 280).
//
// The lyrics are text: syllables in IPA (or X-SAMPA), one a note, separated by
// a space, a full stop or a hyphen — "de.zi.de.zi gim.mi". Each is read as a
// formant instrument's syllable is (motif/syllable.js), leniently: a syllable
// with no vowel holds its consonant in the vowel's place without the syllabic
// mark ("n" is [n̩]). What the record holds is shared: the source, the pool
// range, the size tracking, the reference note, the vowel glide and the BASE
// consonant length (its timing byte). What the entry holds is what differs:
// each syllable's vowel, consonants, marks and timing, and the noise each
// consonant reads — chosen, as everything else about a lyric instrument is,
// rather than asked for:
//
//   timing     every consonant at the base length (the record's), or scaled
//              from it by the lyrics' own per-consonant overrides; then each
//              onset (its consonants, secondary articulation and glide) is
//              drawn towards the lyrics' MEDIAN onset by the CONVERGENCE, 0…100
//              percent of the way — shortened or lengthened, so at 100 every
//              vowel lands the same time after its note; then a syllable the
//              writer set a length for is that length, untouched by the
//              convergence and left out of the median (a run of English words
//              in a Korean song keeps its own)
//   recipes    the best noise the record's pool range has for each consonant
//              that reads one (formantrecipe.js FormantMachine), or the
//              engine's noise generator where the range has nothing better
//
// Pure: the document is read, never written (the view applies the result with
// setLyricsOp).

import {
  CONSONANTS, FormantState, formantNoteOn, lyricSyllable, consonantNeedsNoise, SEMIVOWELS,
} from "../../core/engine/formant.js";
import { LYRIC_MAX_SYLLABLES, LYRIC_MAX_RECIPES, LYRIC_CONVERGE_MAX } from "../../core/format/lyric-section.js";
import { readIpaSyllable, xsampaToIpa } from "../motif/syllable.js";
import { isNoPoolRange } from "./formantedit.js";
import { poolSpan } from "./formantrecipe.js";

/** What separates syllables: white space, a full stop (IPA's and X-SAMPA's
 *  syllable break), a hyphen, a comma or a bar — and the stress marks, which
 *  begin a syllable (IPA ˈ ˌ; X-SAMPA " %). */
const SEPARATORS_IPA = /[\s.\-,|‖ˈˌ]+/u;
const SEPARATORS_XSAMPA = /[\s.\-,|"%]+/u;

/**
 * The lyrics as tokens: [{text, at}] with `at` the token's offset in `text`
 * (for the editor to point at a bad one).
 */
export function lyricTokens(text, xsampa = false) {
  const sep = xsampa ? SEPARATORS_XSAMPA : SEPARATORS_IPA;
  const out = [];
  const re = new RegExp(sep.source, "gu");
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), at });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), at });
  return out;
}

/**
 * Read the lyrics: {syllables: [{ipa, syl}], errors: [{index, at, text, message}]}
 * — `syl` as readIpaSyllable gives it, `ipa` the syllable in IPA (an X-SAMPA
 * one converted).
 */
export function readLyrics(text, xsampa = false) {
  const syllables = [];
  const errors = [];
  lyricTokens(text, xsampa).forEach((tok, index) => {
    try {
      const ipa = xsampa ? xsampaToIpa(tok.text, `[${tok.text}]`) : tok.text;
      const syl = readIpaSyllable(ipa, `[${ipa}]`, { lenient: true });
      syllables.push({ ipa, syl });
    } catch (err) {
      if (!err || err.name !== "MotifError") throw err;
      errors.push({ index, at: tok.at, text: tok.text, message: err.message });
    }
  });
  return { syllables, errors };
}

/** The timing byte nearest a scale (2^((b − 128) ÷ 64)), clamped to a byte. */
export function timingByteOf(scale) {
  return Math.max(0, Math.min(255, Math.round(128 + 64 * Math.log2(scale))));
}

/** A read syllable → the entry's syllable record, timed by `timingOf(cons)`
 *  (the glide by its approximant's). A syllable with no vowel keeps the
 *  record's tongue, which is where a consonant whose tract is "the vowel's"
 *  takes its colour from. */
function syllableRecord(syl, rec, timingOf) {
  const cons = [syl.onset[0] ?? 0, syl.onset[1] ?? 0, syl.coda];
  const v = syl.vowel ?? { front: rec.front, open: rec.open, round: rec.round };
  const glideRow = syl.glide ? SEMIVOWELS[syl.glide].row : 0;
  return {
    front: v.front, open: v.open, round: v.round,
    vowel: syl.vowel !== null, nasal: syl.vowel !== null && syl.nasal,
    gr: (syl.glide & 7) | ((syl.secondary & 3) << 3) | ((syl.release & 3) << 5) | (syl.rhotic ? 0x80 : 0),
    cons,
    timing: [timingOf(cons[0]), timingOf(cons[1]), timingOf(cons[2]), timingOf(glideRow)],
  };
}

/**
 * How long a syllable takes to reach its vowel, in ms: its onset consonants
 * (their secondary articulation with them) and then its glide — what the
 * engine says before the vowel sounds. A syllable with no vowel reaches its
 * held consonant at the end of the onset.
 */
export function onsetMs(rec, s) {
  const st = new FormantState();
  formantNoteOn(st, lyricSyllable(rec, s, new Map()));
  let ms = 0;
  for (const seg of st.onset) ms += seg.end;
  if (st.sv !== null) ms += st.svEnd;
  return ms;
}

/** The timing slots a syllable uses before its vowel: onset 1, onset 2 (when
 *  it has them) and the glide (byte 3, when it has one). */
function onsetSlots(s) {
  const k = [];
  if (s.cons[0] !== 0) k.push(0);
  if (s.cons[1] !== 0) k.push(1);
  if ((s.gr & 7) !== 0) k.push(3);
  return k;
}

/** The median of the onsets that are not 0 ms, or 0 when none is. */
export function medianOnset(lens) {
  const has = lens.filter((x) => x > 0).sort((a, b) => a - b);
  if (has.length === 0) return 0;
  const mid = has.length >> 1;
  return has.length % 2 ? has[mid] : (has[mid - 1] + has[mid]) / 2;
}

/**
 * Bring syllable `s`'s onset as near `target` ms as one byte step can: the
 * same number of steps added to or taken off each of its onset timing bytes
 * (never the coda's). Longer bytes are longer onsets, so the step is found by
 * bisection; the nearer of the two steps either side of the target is kept.
 */
function retimeOnset(rec, s, target) {
  const slots = onsetSlots(s);
  if (slots.length === 0) return;
  const base = s.timing.slice();
  const at = (d) => {
    const t = base.slice();
    for (const k of slots) t[k] = Math.max(0, Math.min(255, base[k] + d));
    return t;
  };
  const len = (d) => onsetMs(rec, { ...s, timing: at(d) });
  // Find the smallest step whose onset reaches the target: len(lo) < target <= len(hi).
  let lo = -256, hi = 256;
  if (len(hi) < target) { s.timing = at(hi); return; }
  if (len(lo + 1) >= target) { s.timing = at(lo + 1); return; }
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (len(m) >= target) hi = m; else lo = m;
  }
  s.timing = at(Math.abs(len(lo) - target) < Math.abs(len(hi) - target) ? lo : hi);
}

/**
 * Convergence: draw every onset towards the median onset (of the syllables
 * that have one, overridden ones left out) by `converge` percent of the way —
 * shortening the long and lengthening the short; 100 is a constant consonant
 * length. A syllable in `skip` (an index set) is neither counted nor moved.
 * Returns the median, in ms (0 when no syllable counts).
 */
export function convergeOnsets(rec, syllables, converge, skip = new Set()) {
  const lens = syllables.map((s) => onsetMs(rec, s));
  const median = medianOnset(lens.filter((_, i) => !skip.has(i)));
  const p = Math.max(0, Math.min(LYRIC_CONVERGE_MAX, converge)) / LYRIC_CONVERGE_MAX;
  if (median === 0 || p === 0) return median;
  syllables.forEach((s, i) => {
    if (skip.has(i) || lens[i] === 0) return;
    const target = lens[i] + p * (median - lens[i]);
    if (Math.abs(target - lens[i]) < 1e-9) return;
    retimeOnset(rec, s, target);
  });
  return median;
}

/** A syllable override: every timing byte the syllable uses (onset, glide and
 *  coda) moved by the override's distance from the base (128), so the
 *  syllable's consonants scale together by its own factor. */
function overrideSyllable(s, timing) {
  const d = timing - 128;
  const slots = onsetSlots(s);
  if (s.cons[2] !== 0) slots.push(2);
  for (const k of slots) s.timing[k] = Math.max(0, Math.min(255, s.timing[k] + d));
}

/**
 * The syllable overrides kept through an edit of the lyrics from `oldText` to
 * `newText` (each read in its notation): an override stays on its syllable
 * where the syllables before it are unchanged, moves with it where the ones
 * after it are, and where a stretch was retyped with as many syllables as it
 * had, stays at its place in it; an override on a syllable that went is dropped.
 */
export function remapSyllableOverrides(oldText, oldX, newText, newX, sylOverrides) {
  if (!sylOverrides || sylOverrides.length === 0) return [];
  const a = lyricTokens(oldText, oldX).map((t) => t.text);
  const b = lyricTokens(newText, newX).map((t) => t.text);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const sameMiddle = a.length === b.length;
  const out = [];
  for (const v of sylOverrides) {
    let i = v.index;
    if (i < pre) { /* unchanged */ } else if (i >= a.length - suf) i += b.length - a.length;
    else if (!sameMiddle) continue;
    if (i >= 0 && i < b.length) out.push({ index: i, timing: v.timing });
  }
  return out;
}

/** The [lo, hi) range a lyric instrument's recipes are chosen from, or null
 *  for a record made from nothing in the pool (every consonant on the
 *  generator). A record with no range is made from the whole pool. */
export function lyricRange(doc, f) {
  if (isNoPoolRange(f.rangeLo, f.rangeHi)) return null;
  if (f.rangeHi <= f.rangeLo) return poolSpan(doc);
  return [f.rangeLo, f.rangeHi];
}

/**
 * The lyrics → an `ILyr` entry for the formant instrument whose decoded patch
 * is `rec` (a FormantPatch: the record as it stands): {entry, errors, median,
 * natural}. `editor` is {text, xsampa, converge (0…100), overrides: [{cons,
 * timing}], sylOverrides: [{index, timing}]}; `natural` is each syllable's
 * onset in ms before the convergence and its own override. `machine`
 * a FormantMachine over the record's range, or null (every consonant on the
 * noise generator). With an error — a syllable that cannot be read, or none
 * at all — `entry` is null and nothing should be applied.
 */
export function deriveLyrics(rec, editor, machine = null) {
  const { syllables: read, errors } = readLyrics(editor.text ?? "", !!editor.xsampa);
  if (errors.length > 0 || read.length === 0) {
    return { entry: null, errors, median: 0, natural: [], count: read.length };
  }
  if (read.length > LYRIC_MAX_SYLLABLES) {
    return {
      entry: null, median: 0, natural: [], count: read.length,
      errors: [{ index: LYRIC_MAX_SYLLABLES, at: 0, text: "", message: `at most ${LYRIC_MAX_SYLLABLES} syllables` }],
    };
  }
  const over = new Map((editor.overrides ?? []).map((v) => [v.cons, v.timing]));
  // Each byte is a scale on top of the record's base length: 128 is the base.
  const timingOf = (cons) => (cons !== 0 && over.has(cons) ? over.get(cons) : 128);
  const syllables = read.map(({ syl }) => syllableRecord(syl, rec, timingOf));
  const natural = syllables.map((s) => onsetMs(rec, s));
  const sylOver = new Map();
  for (const v of editor.sylOverrides ?? []) {
    if (v.index >= 0 && v.index < syllables.length) sylOver.set(v.index, v.timing);
  }
  const converge = Math.max(0, Math.min(LYRIC_CONVERGE_MAX, editor.converge | 0));
  const median = convergeOnsets(rec, syllables, converge, new Set(sylOver.keys()));
  for (const [i, timing] of sylOver) overrideSyllable(syllables[i], timing);

  // The noise each consonant reads: the best the range has. A recipe that is
  // the bare generator is left out — no recipe means exactly that.
  const recipes = [];
  if (machine !== null) {
    const ids = new Set();
    for (const s of syllables) for (const c of s.cons) if (c !== 0) ids.add(c);
    for (const cons of [...ids].sort((a, b) => a - b)) {
      if (!consonantNeedsNoise(CONSONANTS[cons])) continue;
      const best = machine.recipes(cons, rec.timing)[0];
      if (!best) continue;
      if (best.cand === null && (best.tilt | 0) === 0 && (best.gain | 0) === 0) continue;
      if (recipes.length >= LYRIC_MAX_RECIPES) break;
      recipes.push(best.cand === null
        ? { cons, ptr: 0, len: 0, offset: 0, rate: 0, tilt: best.tilt | 0, gain: best.gain | 0 }
        : { cons, ptr: best.cand.ptr, len: best.cand.len, offset: best.offset, rate: best.rate, tilt: best.tilt, gain: best.gain });
    }
  }
  const entry = {
    instId: 0,
    syllables,
    recipes,
    editor: {
      text: editor.text ?? "", xsampa: !!editor.xsampa, converge,
      overrides: [...over].sort((a, b) => a[0] - b[0]).map(([cons, timing]) => ({ cons, timing })),
      sylOverrides: [...sylOver].sort((a, b) => a[0] - b[0]).map(([index, timing]) => ({ index, timing })),
    },
  };
  return { entry, errors: [], median, natural, count: syllables.length };
}

/**
 * Pattern entry (item 280): does a note typed at `row` of lane pattern `rows`
 * CONTINUE lyric instrument `inst`'s lyrics, so that it should be written
 * without the instrument number (which would start them over)? Looking up the
 * lane: the nearest instrument number says — this instrument's continues,
 * another's does not; with none above, a note above (sung by whatever the
 * lane was playing, most likely these lyrics) continues; an empty lane above
 * starts them.
 */
export function lyricContinues(rows, row, inst) {
  let noteAbove = false;
  for (let r = row - 1; r >= 0; r--) {
    const c = rows[r];
    if (!c) continue;
    if (c.instrment !== 0) return c.instrment === inst;
    if (c.note >= 0x20) noteAbove = true;
  }
  return noteAbove;
}
