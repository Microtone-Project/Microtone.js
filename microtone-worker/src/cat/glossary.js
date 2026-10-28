// The glossary: which English terms the strings are made of, what each is in
// the target language, and where a translation strays from it.
//
// Building one from nothing is two steps, both statistical and both run over
// the strings themselves:
//
//   1. extractTerms — term candidates from the English: word n-grams (1–4)
//      that neither start nor end with a function word, ranked by C-value
//      (Frantzi, Ananiadou & Mima 2000: frequency, discounted where the
//      candidate mostly occurs inside a longer one), counted per segment.
//   2. alignTerms — for each candidate, the target-language string that keeps
//      company with it: among the translated segments, every substring that
//      starts a word (any character in a script written without spaces) is a
//      candidate, scored by the Dice coefficient of the two sets of segments.
//      A substring starting a word copes with Korean's particles (레인 in
//      레인을, 레인의) and with inflected stems alike; a longer candidate that
//      contains a better one is an inflection, a shorter one inside it a
//      fragment, and neither is offered beside it.
//
// The translator then accepts, edits or rejects each proposal; accepted
// entries are what the checks hold every segment to.

import { words, lemma, STOPWORDS, PLACEHOLDER, isDenseScript } from "./text.js";

const KEYS = new Set("ctrl shift alt cmd meta option super enter esc escape tab space backspace delete insert home end pgup pgdn".split(" "));

/** The comparison key of a term: its words' lemmas. */
export const termKey = (s) => words(s).map(lemma).join(" ");

// Chunks of a source a term cannot cross: punctuation other than inside a
// word, and placeholders.
const chunks = (s) => s.split(/\{[^}]*\}|[^\p{L}\p{N}\p{M}\s'’\-]+|\s[\-–—]\s/u);

/**
 * @param {string[]} sources  English strings (one per segment)
 * @returns {{key:string, surface:string, df:number, segs:number[], cvalue:number}[]}
 *   best first
 */
export function extractTerms(sources, { maxLen = 4, minDf = 3, limit = 800 } = {}) {
  const cand = new Map(); // key → { segs:Set, surfaces:Map, n }
  sources.forEach((src, seg) => {
    for (const chunk of chunks(src)) {
      const ws = words(chunk);
      const ls = ws.map(lemma);
      for (let i = 0; i < ws.length; i++) {
        for (let n = 1; n <= maxLen && i + n <= ws.length; n++) {
          const first = ls[i], last = ls[i + n - 1];
          if (STOPWORDS.has(first) || STOPWORDS.has(last)) continue;
          const span = ls.slice(i, i + n);
          // A two-letter word is a term only when it is written as one (Hz, dB, DC).
          if (span.some((l, k) => /^\d/.test(l) || KEYS.has(l) || (l.length < 3 && !/[A-Z]/.test(ws[i + k])))) continue;
          const key = span.join(" ");
          let c = cand.get(key);
          if (!c) cand.set(key, (c = { segs: new Set(), surfaces: new Map(), n }));
          c.segs.add(seg);
          const surface = ws.slice(i, i + n).join(" ");
          c.surfaces.set(surface, (c.surfaces.get(surface) ?? 0) + 1);
        }
      }
    }
  });
  for (const [k, c] of cand) if (c.segs.size < minDf) cand.delete(k);

  // C-value: a nested candidate is discounted by the mean frequency of the
  // longer candidates it occurs in.
  const nestedIn = new Map(); // key → frequencies of the longer ones containing it
  for (const [k, c] of cand) {
    if (c.n < 2) continue;
    const ls = k.split(" ");
    for (let n = 1; n < ls.length; n++) {
      for (let i = 0; i + n <= ls.length; i++) {
        const sub = ls.slice(i, i + n).join(" ");
        if (!cand.has(sub)) continue;
        if (!nestedIn.has(sub)) nestedIn.set(sub, []);
        nestedIn.get(sub).push(c.segs.size);
      }
    }
  }
  const out = [];
  for (const [key, c] of cand) {
    const f = c.segs.size;
    const nested = nestedIn.get(key);
    const discount = nested ? nested.reduce((a, b) => a + b, 0) / nested.length : 0;
    const cvalue = Math.log2(c.n + 1) * (f - discount);
    if (cvalue <= 0.5) continue;
    out.push({ key, surface: displaySurface(key, c.surfaces), df: f, segs: [...c.segs], cvalue });
  }
  out.sort((a, b) => b.cvalue - a.cvalue || b.df - a.df || a.key.localeCompare(b.key));
  return out.slice(0, limit);
}

// The dictionary form where the strings use it (lane, not lanes), and lower
// case unless the term is never written that way (MIDI, Motif).
function displaySurface(key, surfaces) {
  const lower = new Map();
  let anyLower = false;
  for (const [s, n] of surfaces) {
    if (s === s.toLowerCase()) anyLower = true;
    const l = s.toLowerCase();
    lower.set(l, (lower.get(l) ?? 0) + n);
  }
  const best = (m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  if (anyLower) return lower.has(key) ? key : best(lower);
  const exact = [...surfaces.keys()].find((s) => s.toLowerCase() === key);
  return exact ?? best(surfaces);
}

/** Every substring of a target that could be a term's translation (see the header). */
export function targetCandidates(text, { maxChars = 14, maxWords = 3 } = {}) {
  const out = new Set();
  // A placeholder's name is not a word of the translation.
  const chars = [...text.replace(PLACEHOLDER, "|")];
  const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}\p{M}'’\-]/u.test(ch);
  for (let s = 0; s < chars.length; s++) {
    const ch = chars[s];
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    const wordStart = !isWordChar(chars[s - 1]);
    if (!wordStart && !isDenseScript(ch)) continue;
    let spaces = 0, wordLen = 0;
    for (let e = s + 1; e <= chars.length && e - s <= maxChars; e++) {
      const c = chars[e - 1];
      if (/\s/.test(c)) { if (++spaces >= maxWords) break; wordLen = 0; continue; }
      if (!isWordChar(c)) break;
      wordLen++;
      const atWordEnd = !isWordChar(chars[e]);
      // Latin-like words end a candidate at their end, or once a stem (4+)
      // is in hand; syllabic and dense scripts at any character.
      const dense = /[\p{Script=Hangul}]/u.test(c) || isDenseScript(c);
      if (atWordEnd || dense || wordLen >= 4) out.add(chars.slice(s, e).join("").toLowerCase());
    }
  }
  return out;
}

/**
 * Propose translations for extracted terms.
 * @param terms  extractTerms' output (segs index `pairs`)
 * @param pairs  [{source, target}] — target empty where untranslated
 * @returns terms, each with `proposals: [{target, dice, together, dnt}]` (best
 *   first, at most `keep`) and `translated` (how many of its segments are)
 */
export function alignTerms(terms, pairs, { keep = 3, minTogether = 2 } = {}) {
  const segCands = pairs.map((p) => (p.target && p.target !== p.source ? targetCandidates(p.target) : null));
  const df = new Map();
  for (const set of segCands) if (set) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  return terms.map((term) => {
    const segs = term.segs.filter((i) => segCands[i]);
    const together = new Map();
    for (const i of segs) for (const t of segCands[i]) together.set(t, (together.get(t) ?? 0) + 1);
    const scored = [];
    const termWords = term.key.split(" ").length;
    for (const [t, c] of together) {
      // Two or three segments in common is chance unless they are most of
      // the term's; and a translation is at most one word longer than the term.
      if (c < minTogether || c < segs.length * 0.2) continue;
      if (c < 3 && c < Math.ceil(segs.length * 0.6)) continue;
      if (t.split(" ").length > termWords + 1) continue;
      scored.push({ target: t, together: c, dice: (2 * c) / (segs.length + df.get(t)) });
    }
    // Ties go to the longer: 패 and 패턴 keep the same company, 패턴 is the word.
    scored.sort((a, b) => b.dice - a.dice || [...b.target].length - [...a.target].length || a.target.localeCompare(b.target));
    const picked = [];
    for (const s of scored) {
      // An also-ran far behind the best is noise (이, 그 — a particle or a
      // determiner that starts a word everywhere).
      if (picked.length && (s.dice < 0.3 || s.dice < picked[0].dice / 2)) break;
      if (picked.some((p) => p.target.includes(s.target) || s.target.includes(p.target))) continue;
      picked.push(s);
      if (picked.length >= keep) break;
    }
    const surface = term.surface.toLowerCase();
    for (const p of picked) p.dnt = p.target === surface;
    return { ...term, translated: segs.length, proposals: picked };
  });
}

/**
 * The text with every `{…}` span (a placeholder, or anything else in braces)
 * blanked out to as many `|`: its insides are not words of the sentence, and
 * `|` keeps the offsets and stops a term from spanning across it.
 */
export const maskBraces = (s) => s.replace(/\{[^{}]*\}/g, (m) => "|".repeat(m.length));

/** The comparison form of a target term or text: case-folded, spaces collapsed. */
const foldTarget = (s) => s.toLowerCase().replace(/\s+/g, " ");

/** True when `target` carries one of the entry's translations. */
export function targetHasTerm(entry, target) {
  const t = foldTarget(maskBraces(target));
  const wanted = entry.dnt ? [entry.source, ...(entry.targets ?? [])] : entry.targets ?? [];
  return wanted.some((w) => w && t.includes(foldTarget(w)));
}

/**
 * The glossary entries a source contains, as character spans (longest match
 * first, no overlaps) — for highlighting and for the checks. Nothing inside
 * braces counts: `{name}` is a placeholder, not the word "name".
 * @param byKey  Map termKey → entry (accepted entries only, normally)
 */
export function findTerms(source, byKey, maxLen = 4) {
  const spans = [];
  const re = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}]|['’\-](?=[\p{L}\p{N}]))*/gu;
  const ws = [...maskBraces(source).matchAll(re)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  const ls = ws.map((w) => lemma(w.text));
  for (let i = 0; i < ws.length;) {
    let hit = null;
    for (let n = Math.min(maxLen, ws.length - i); n >= 1; n--) {
      // A term never spans punctuation: what lies between its words is space.
      let joined = true;
      for (let k = i; k < i + n - 1; k++) if (!/^\s+$|^[\-]$/.test(source.slice(ws[k].end, ws[k + 1].start))) joined = false;
      if (!joined) continue;
      const entry = byKey.get(ls.slice(i, i + n).join(" "));
      if (entry) { hit = { start: ws[i].start, end: ws[i + n - 1].end, entry }; i += n; break; }
    }
    if (hit) spans.push(hit); else i++;
  }
  return spans;
}
