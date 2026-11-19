// Jiva (item 348): a lyric instrument that sings gibberish. Its notation is
// ERI — three marks a syllable of the lyrics may carry, each asking for a
// part of the syllable to be DRAWN rather than written:
//
//   *      a whole syllable: a drawn onset, vowel and coda
//   (      before the syllable: a drawn onset (its consonants and glide)
//   )      after the syllable: a drawn coda
//
// Between the brackets is the syllable's own part, in the lyrics' notation; with
// nothing between them the vowel is drawn too. So `(` is an open syllable on a
// drawn vowel, `)` a drawn vowel and coda, `(a` a drawn onset before [a],
// `(a)` and `a)` the same around it, `(ak` [a] and [k] after a drawn onset,
// `ka)` a drawn coda after [ka]. A bracket stands where the part it draws
// would be, so the part between must not have that part of its own.
//
// Everything else about a lyric instrument stays as it was: the marks are
// expanded here, as the lyrics are read (lyrics.js readLyrics), into the
// syllables the ILyr entry holds — the engine only ever sees plain syllables.
// A draw is keyed by the lyrics' SEED, the syllable's place and the part
// (motif/stdlib.js keyedRandom, TML's own keyed hash): the same lyrics and
// seed sing the same syllables everywhere, editing one syllable redraws only
// that one (while the others keep their places), and writing a vowel into a
// `(` keeps its drawn onset. The seed is kept
// in the entry's editor part (0, the default, is written as nothing).
//
// Pure: text in, IPA out, or a MotifError saying what is wrong.

import { keyedRandom } from "../motif/stdlib.js";
import { fail } from "../motif/values.js";
import { readIpaSyllable, xsampaToIpa } from "../motif/syllable.js";

/** The marks. */
export const ERI_WHOLE = "*";
export const ERI_ONSET = "(";
export const ERI_CODA = ")";
const MARKS = /[*()]/u;

/**
 * What can be drawn, each with its weight: a soft, open sound, between Greek
 * and nowhere in particular. Every onset is said before the vowel as written
 * here (a semivowel alone becomes the syllable's glide); every coda is one
 * consonant. Changing a table changes what every saved lyric with a mark
 * sings — it is part of the notation.
 */
export const ERI_ONSETS = [
  ["t", 6], ["k", 6], ["p", 4], ["d", 5], ["b", 3], ["ɡ", 3],
  ["m", 6], ["n", 6], ["l", 6], ["ɾ", 5], ["r", 2],
  ["s", 6], ["z", 2], ["v", 5], ["f", 3], ["θ", 2], ["ð", 2], ["x", 2], ["ɣ", 1],
  ["ʃ", 2], ["ʒ", 1], ["d͡ʒ", 2], ["t͡ʃ", 2], ["ɸ", 1], ["β", 1], ["h", 2],
  ["j", 3], ["w", 2],
  // a few clusters, about one onset in seven
  ["pɾ", 1], ["tɾ", 1], ["kɾ", 1], ["dɾ", 1], ["ɡɾ", 1], ["fɾ", 1], ["θɾ", 1],
  ["pl", 1], ["kl", 1], ["ɡl", 1], ["fl", 1], ["st", 1], ["sp", 1], ["sk", 1], ["sm", 1],
];
export const ERI_VOWELS = [
  ["a", 8], ["e", 4], ["i", 6], ["o", 5], ["u", 3], ["ɛ", 3], ["ɔ", 3], ["ɪ", 2], ["ʊ", 2],
];
export const ERI_CODAS = [
  ["n", 6], ["s", 6], ["m", 3], ["l", 3], ["ɾ", 3], ["r", 1], ["k", 2], ["t", 2], ["ŋ", 2],
];

/** What a new lyric instrument sings until it is given words: three lines,
 *  the middle one written out, the others drawn. */
export const JIVA_LYRICS = [
  "a.(.(.*.( | *.(.).(",
  "d͡ʒɪ.va.ɛ.ɾɪ.ɸʊ",
  "*.*.( | (.(.(.* | *.(",
].join("\n");

/** The largest seed (a U32). */
export const JIVA_SEED_MAX = 0xffffffff;

/** Does `text` use Eri at all? */
export function hasEri(text) {
  return MARKS.test(text ?? "");
}

/**
 * One syllable as written → null (no mark: an ordinary syllable) or
 * {onset, coda, middle}: what is drawn, and the syllable's own part as typed.
 */
export function eriOf(token) {
  if (!MARKS.test(token)) return null;
  if (token === ERI_WHOLE) return { onset: true, coda: true, middle: "" };
  let s = token;
  const onset = s.startsWith(ERI_ONSET);
  if (onset) s = s.slice(1);
  const coda = s.endsWith(ERI_CODA);
  if (coda) s = s.slice(0, -1);
  const stray = MARKS.exec(s);
  if (stray) {
    const m = stray[0];
    throw fail(m === ERI_WHOLE
      ? `"*" is a whole syllable drawn: it stands alone, between breaks`
      : m === ERI_ONSET
        ? `"(" draws the consonants before the vowel, so it opens the syllable`
        : `")" draws the consonant after the vowel, so it closes the syllable`);
  }
  return { onset, coda, middle: s };
}

/** One weighted pick, from a draw in [0, 1). */
function pick(table, u) {
  let total = 0;
  for (const [, w] of table) total += w;
  let x = u * total;
  for (const [ipa, w] of table) {
    if (x < w) return ipa;
    x -= w;
  }
  return table[table.length - 1][0];
}

/** A drawn part of syllable `index`: keyed by the seed, the place and the part. */
function draw(table, seed, index, part) {
  return pick(table, keyedRandom(seed >>> 0, [index, part]));
}

/**
 * Syllable `index` of the lyrics, as written, → its IPA with every mark
 * drawn; null when it has no mark. `xsampa`: the syllable's own part is
 * written in X-SAMPA.
 */
export function expandEri(token, index, seed = 0, xsampa = false) {
  const e = eriOf(token);
  if (e === null) return null;
  let middle;
  if (e.middle === "") {
    middle = draw(ERI_VOWELS, seed, index, "vowel");
  } else {
    middle = xsampa ? xsampaToIpa(e.middle, `[${e.middle}]`) : e.middle;
    const syl = readIpaSyllable(middle, `[${middle}]`);
    if (syl.vowel === null) {
      throw fail(`[${middle}]: the brackets go around a vowel (or around nothing, for a drawn one)`);
    }
    if (e.onset && (syl.onset.length > 0 || syl.glide !== 0)) {
      throw fail(`[${middle}] has its own consonants before the vowel, and "(" draws them: leave out one or the other`);
    }
    if (e.coda && syl.coda !== 0) {
      throw fail(`[${middle}] has its own consonant after the vowel, and ")" draws it: leave out one or the other`);
    }
  }
  return (e.onset ? draw(ERI_ONSETS, seed, index, "onset") : "")
    + middle
    + (e.coda ? draw(ERI_CODAS, seed, index, "coda") : "");
}

/** A fresh seed for "Draw again": any but the one in use, never 0 (0 is the
 *  lyrics' own, written as nothing). */
export function nextSeed(current, random = Math.random) {
  for (;;) {
    const s = Math.floor(random() * JIVA_SEED_MAX) + 1;
    if (s !== current) return s >>> 0;
  }
}
