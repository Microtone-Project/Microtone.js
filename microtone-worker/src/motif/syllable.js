// A formant instrument's syllable written as text (item 231): IPA, or X-SAMPA
// turned into IPA first, read into the fields of a type-1 record's tract block
// (TAUD_FILE_FORMAT.md §7.6) — CCGVRC: up to two onset consonants, the last
// with a secondary articulation; a glide; the vowel, nasalised or r-coloured;
// a coda with its release. A syllable with no vowel marks the consonant held
// in its place syllabic ([n̩], [ŋ̍]).
//
// The inverse of formantedit.js formantSyllable: every syllable that function
// spells reads back to the fields it was spelt from (the vowel as its nearest
// mark). The consonants are the engine's own table (formant.js CONSONANTS),
// the vowels the Formant tab's chart marks; the X-SAMPA chart is Wells'
// (tsvm reference_materials/xsampa/).
//
// Pure: a string in, fields out, or a MotifError saying what is wrong.

import {
  CONSONANT_LIST, SEMIVOWELS, ART_NONE, ART_PALATAL, ART_DARK, ART_GLOTTAL,
  CODA_RELEASED, CODA_UNRELEASED, CODA_DARK, CODA_GLOTTAL,
} from "../../core/engine/formant.js";
import { VOWEL_MARKS } from "../doc/formantedit.js";
import { fail } from "./values.js";

const TIE = "͡";
const ASPIRATED = "ʰ";      // ʰ
const BREATHY = "ʱ";        // ʱ
const PALATAL = "ʲ";        // ʲ
const VELAR = "ˠ";          // ˠ
const PHARYNGEAL = "ˤ";     // ˤ
const GLOTTAL = "ˀ";        // ˀ
const UNRELEASED = "̚";     // ◌̚
const SYLLABIC = "̩";       // ◌̩
const SYLLABIC_ABOVE = "̍"; // ◌̍
const NASAL = "̃";          // ◌̃
const RHOTIC = "˞";         // ◌˞

/** IPA spellings the engine's table writes another way. */
const ALIASES = [
  ["g", "ɡ"], ["͜", TIE],                                    // ASCII g; the tie below
  ["ʦ", `t${TIE}s`], ["ʣ", `d${TIE}z`], ["ʧ", `t${TIE}ʃ`], ["ʤ", `d${TIE}ʒ`], ["ʨ", `t${TIE}ɕ`], ["ʥ", `d${TIE}ʑ`],
  ["ɫ", `l${VELAR}`],                                              // the dark l is a velarised [l]
  ["͈", GLOTTAL],                                              // ◌͈ (Korean's tense ㄲ ㄸ ㅃ) is glottalised
  ["ã", `a${NASAL}`], ["ẽ", `e${NASAL}`], ["ĩ", `i${NASAL}`], ["õ", `o${NASAL}`], ["ũ", `u${NASAL}`], ["ỹ", `y${NASAL}`],
  ["ɚ", `ə${RHOTIC}`], ["ɝ", `ɜ${RHOTIC}`],
];
/** A voiced stop aspirated is breathy: [dʰ] (as Indology writes it) and [d̤] are [dʱ]. */
for (const c of ["b", "d", "ɖ", "ɡ"]) ALIASES.push([c + ASPIRATED, c + BREATHY], [c + "̤", c + BREATHY]);

/** Every consonant by its IPA, longest first so [t͡s] wins over [t] and [kʰ] over [k]. */
const CONSONANT_IPA = CONSONANT_LIST.map((r) => [r.ipa, r.id]).sort((a, b) => b[0].length - a[0].length);
const VOWELS = new Map(VOWEL_MARKS.map((m) => [m.ipa, m]));
const SEMIVOWEL_OF = new Map(SEMIVOWELS.filter(Boolean).map((s) => [s.row, s.code]));
const CONSONANT_ID = new Map(CONSONANT_LIST.map((r) => [r.ipa, r.id]));
const CONSONANT_MARKS = new Set([PALATAL, VELAR, PHARYNGEAL, GLOTTAL, UNRELEASED, SYLLABIC, SYLLABIC_ABOVE]);
const VOWEL_MARK_SET = new Set([NASAL, RHOTIC]);

function normalise(text) {
  let s = text.trim();
  if (/^\[.*\]$|^\/.*\/$/.test(s)) s = s.slice(1, -1).trim();
  for (const [a, b] of ALIASES) s = s.split(a).join(b);
  return s;
}

/** The text → segments: {c: id, ipa, marks} and {v: mark, marks}. */
function segments(text, what) {
  const s = normalise(text);
  const out = [];
  let i = 0;
  outer: while (i < s.length) {
    const ch = s[i];
    if (CONSONANT_MARKS.has(ch) || VOWEL_MARK_SET.has(ch)) {
      const seg = out[out.length - 1];
      if (!seg) throw fail(`${what}: "${ch}" marks the sound before it, and there is none`);
      seg.marks.push(ch);
      i++;
      continue;
    }
    for (const [ipa, id] of CONSONANT_IPA) {
      if (s.startsWith(ipa, i)) {
        out.push({ c: id, ipa, marks: [] });
        i += ipa.length;
        continue outer;
      }
    }
    if (VOWELS.has(ch)) {
      out.push({ v: VOWELS.get(ch), ipa: ch, marks: [] });
      i++;
      continue;
    }
    if (ch === ASPIRATED || ch === BREATHY) {
      const prev = out[out.length - 1];
      throw fail(`${what}: there is no [${prev ? prev.ipa : ""}${ch}] — the aspirated consonants are ${aspirated()}`);
    }
    if (ch === "ː" || ch === "ˑ") throw fail(`${what}: a note is as long as it is held, so "${ch}" (long) has no meaning here`);
    if (ch === "ˈ" || ch === "ˌ" || ch === ".") throw fail(`${what}: a note says one syllable, so "${ch}" has no meaning here`);
    if (/\s/.test(ch)) throw fail(`${what}: a note says one syllable; write it without spaces`);
    throw fail(`${what}: "${ch}" is not a sound a formant instrument can say${ch === TIE ? " (a tie bar joins the two letters of an affricate the instrument has, such as t͡s)" : ""}`);
  }
  return out;
}

const aspirated = () => CONSONANT_LIST.filter((r) => r.ipa.endsWith(ASPIRATED) || r.ipa.endsWith(BREATHY)).map((r) => `[${r.ipa}]`).join(" ");

const SECONDARY = { [PALATAL]: ART_PALATAL, [VELAR]: ART_DARK, [PHARYNGEAL]: ART_DARK, [GLOTTAL]: ART_GLOTTAL };
const RELEASE = { [UNRELEASED]: CODA_UNRELEASED, [VELAR]: CODA_DARK, [PHARYNGEAL]: CODA_DARK, [GLOTTAL]: CODA_GLOTTAL };

/**
 * An IPA syllable → {onset: [id, id?], secondary, glide (SEMIVOWELS code),
 * vowel: {front, open, round} | null, nasal, rhotic, coda: id | 0, release}.
 */
export function readIpaSyllable(text, what = "the syllable") {
  const segs = segments(text, what);
  if (!segs.length) throw fail(`${what} is empty`);
  const vowels = segs.filter((g) => g.v);
  if (vowels.length > 1) {
    throw fail(`${what}: a syllable has one vowel, not ${vowels.length} ([${vowels.map((v) => v.ipa).join("], [")}]) — move a held vowel to another with S $Afgr`);
  }
  const syllabic = segs.filter((g) => g.c && (g.marks.includes(SYLLABIC) || g.marks.includes(SYLLABIC_ABOVE)));
  if (vowels.length && syllabic.length) throw fail(`${what}: a syllable with a vowel has no syllabic consonant`);
  if (syllabic.length > 1) throw fail(`${what}: one consonant can be the syllable's peak, not ${syllabic.length}`);
  const peak = vowels[0] ?? syllabic[0];
  if (!peak) throw fail(`${what} has no vowel: give it one, or mark the consonant held in its place syllabic ([n̩], [ŋ̍])`);
  const at = segs.indexOf(peak);
  const before = vowels.length ? segs.slice(0, at) : segs.slice(0, at + 1);
  const after = segs.slice(at + 1);
  for (const g of after) if (g.v) throw fail(`${what}: a syllable has one vowel`);

  // the glide: a semivowel straight before the vowel, with no mark of its own
  let glide = 0;
  if (vowels.length && before.length) {
    const last = before[before.length - 1];
    if (SEMIVOWEL_OF.has(last.c) && last.marks.length === 0) {
      glide = SEMIVOWEL_OF.get(last.c);
      before.pop();
    }
  }
  if (before.length > 2) {
    throw fail(`${what}: a syllable starts with at most two consonants (and a glide), not ${before.length} ([${before.map((g) => g.ipa).join("], [")}])`);
  }
  let secondary = ART_NONE;
  before.forEach((g, k) => {
    for (const m of g.marks) {
      if (m === SYLLABIC || m === SYLLABIC_ABOVE) continue;
      if (m === UNRELEASED) throw fail(`${what}: [${g.ipa}${m}] — only the coda is unreleased`);
      if (k !== before.length - 1) throw fail(`${what}: a secondary articulation (${m}) goes on the onset's last consonant, not on [${g.ipa}]`);
      if (secondary !== ART_NONE) throw fail(`${what}: [${g.ipa}] has two secondary articulations`);
      secondary = SECONDARY[m];
    }
  });
  if (after.length > 1) {
    throw fail(`${what}: a syllable ends with one consonant (the coda, said on a key-off), not ${after.length} ([${after.map((g) => g.ipa).join("], [")}])`);
  }
  let coda = 0, release = CODA_RELEASED;
  if (after.length) {
    const g = after[0];
    coda = g.c;
    for (const m of g.marks) {
      if (!(m in RELEASE)) throw fail(`${what}: the coda [${g.ipa}] cannot be marked "${m}"`);
      if (release !== CODA_RELEASED) throw fail(`${what}: the coda [${g.ipa}] has two releases`);
      release = RELEASE[m];
    }
  }
  let vowel = null, nasal = false, rhotic = false;
  if (vowels.length) {
    const v = peak.v;
    vowel = { front: v.front, open: v.open, round: v.round };
    for (const m of peak.marks) {
      if (m === NASAL) nasal = true;
      else if (m === RHOTIC) rhotic = true;
      else throw fail(`${what}: the vowel [${peak.ipa}] cannot be marked "${m}"`);
    }
  }
  return { onset: before.map((g) => g.c), secondary, glide, vowel, nasal, rhotic, coda, release };
}

/** One consonant, by its IPA (as the syllable reads it): its id. */
export function consonantId(text, what = "the consonant") {
  const s = normalise(text);
  if (CONSONANT_ID.has(s)) return CONSONANT_ID.get(s);
  throw fail(`${what}: [${text}] is not a consonant a formant instrument has`);
}

/** One vowel, by its chart mark: {front, open, round}, and whether it is
 *  nasalised or r-coloured ([ɚ], [ɑ̃]). */
export function vowelOf(text, what = "the vowel") {
  const segs = segments(text, what);
  if (segs.length !== 1 || !segs[0].v) throw fail(`${what}: [${text}] is not one vowel`);
  const { v, marks } = segs[0];
  return { front: v.front, open: v.open, round: v.round, nasal: marks.includes(NASAL), rhotic: marks.includes(RHOTIC) };
}

// ── X-SAMPA ──

/** X-SAMPA → IPA, longest first. */
const XSAMPA = [
  ["r\\`", "ɻ"],
  ["J\\", "ɟ"], ["G\\", "ɢ"], ["N\\", "ɴ"], ["B\\", "ʙ"], ["R\\", "ʀ"], ["p\\", "ɸ"], ["j\\", "ʝ"],
  ["X\\", "ħ"], ["?\\", "ʕ"], ["h\\", "ɦ"], ["K\\", "ɮ"], ["s\\", "ɕ"], ["z\\", "ʑ"], ["v\\", "ʋ"],
  ["r\\", "ɹ"], ["M\\", "ɰ"], ["L\\", "ʟ"], ["@\\", "ɘ"], ["3\\", "ɞ"],
  ["t`", "ʈ"], ["d`", "ɖ"], ["n`", "ɳ"], ["r`", "ɽ"], ["s`", "ʂ"], ["z`", "ʐ"], ["l`", "ɭ"], ["@`", "ɚ"],
  ..."abcdefhijklmnopqrstuvwxyz".split("").map((c) => [c, c]), ["g", "ɡ"],
  ["A", "ɑ"], ["B", "β"], ["C", "ç"], ["D", "ð"], ["E", "ɛ"], ["F", "ɱ"], ["G", "ɣ"], ["H", "ɥ"], ["I", "ɪ"],
  ["J", "ɲ"], ["K", "ɬ"], ["L", "ʎ"], ["M", "ɯ"], ["N", "ŋ"], ["O", "ɔ"], ["P", "ʋ"], ["Q", "ɒ"], ["R", "ʁ"],
  ["S", "ʃ"], ["T", "θ"], ["U", "ʊ"], ["V", "ʌ"], ["W", "ʍ"], ["X", "χ"], ["Y", "ʏ"], ["Z", "ʒ"],
  ["@", "ə"], ["{", "æ"], ["}", "ʉ"], ["1", "ɨ"], ["2", "ø"], ["3", "ɜ"], ["4", "ɾ"], ["5", "ɫ"], ["6", "ɐ"],
  ["7", "ɤ"], ["8", "ɵ"], ["9", "œ"], ["&", "ɶ"], ["?", "ʔ"],
  // read only to be refused with the IPA's own reasons
  [":\\", "ˑ"], [":", "ː"], ['"', "ˈ"], ["%", "ˌ"], [".", "."],
].sort((a, b) => b[0].length - a[0].length);
/** The diacritics after "_" (and the ones whose "_" is optional). `_?` is not
 *  X-SAMPA's, which has no glottalised mark: Motif reads it as ˀ. */
const XSAMPA_DIACRITICS = [
  ["_?\\", PHARYNGEAL], ["_?", GLOTTAL], ["_h", ASPIRATED], ["_t", "̤"], ["_j", PALATAL], ["'", PALATAL],
  ["_G", VELAR], ["_e", VELAR], ["_}", UNRELEASED], ["_~", NASAL], ["~", NASAL], ["_=", SYLLABIC], ["=", SYLLABIC],
];
const XSAMPA_VOWELS = new Set(VOWEL_MARKS.map((m) => m.ipa).concat(["ɚ"]));

/** An X-SAMPA syllable as IPA. "_" before a symbol that is no diacritic is
 *  the tie bar (`t_S` [t͡ʃ]); "`" after a vowel r-colours it. */
export function xsampaToIpa(text, what = "the syllable") {
  let s = text.trim();
  if (/^\[.*\]$|^\/.*\/$/.test(s)) s = s.slice(1, -1).trim();
  let out = "";
  let i = 0;
  const symbolAt = (j) => XSAMPA.find(([x]) => s.startsWith(x, j));
  while (i < s.length) {
    // the glottal stop's breath is the affricate [ʔ͡h]: there is no [ʔʰ]
    if (s.startsWith("?_h", i) && !s.startsWith("?\\", i)) { out += `ʔ${TIE}h`; i += 3; continue; }
    const d = XSAMPA_DIACRITICS.find(([x]) => s.startsWith(x, i));
    if (d) { out += d[1]; i += d[0].length; continue; }
    if (s[i] === "_") {
      if (symbolAt(i + 1)) { out += TIE; i++; continue; }
      throw fail(`${what}: "${s.slice(i, i + 2)}" is not an X-SAMPA diacritic a formant instrument has`);
    }
    if (s[i] === "`") {
      const prev = [...out].pop();
      if (prev && XSAMPA_VOWELS.has(prev)) { out += RHOTIC; i++; continue; }
      throw fail(`${what}: "\`" makes a consonant retroflex only where X-SAMPA has one (t\` d\` n\` r\` s\` z\` l\` r\\\`)`);
    }
    const sym = symbolAt(i);
    if (!sym) throw fail(`${what}: "${s[i]}" is not an X-SAMPA symbol a formant instrument can say`);
    out += sym[1];
    i += sym[0].length;
  }
  return out;
}
