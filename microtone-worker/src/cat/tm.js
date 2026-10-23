// Translation memory: every translated segment of every corpus in the target
// language, searched for the sources most like the one being translated.
// The fuzzy score is wordDiff's (text.js): shared characters over all of
// them, word by word, case and digits ignored — the "87 %" of a CAT tool.

import { words, lemma, STOPWORDS, wordDiff } from "./text.js";

const indexTerms = (s) => {
  const out = new Set();
  for (const w of words(s)) {
    const l = lemma(w);
    if (!STOPWORDS.has(l)) out.add(l);
  }
  return out;
};

export class TranslationMemory {
  /** @param {{id:string, source:string, target:string}[]} units */
  constructor(units) {
    this.units = units;
    this.terms = units.map((u) => indexTerms(u.source));
    this.index = new Map();
    this.units.forEach((u, i) => {
      for (const t of this.terms[i]) {
        if (!this.index.has(t)) this.index.set(t, []);
        this.index.get(t).push(i);
      }
    });
    this.exact = new Map();
    this.units.forEach((u, i) => {
      const k = u.source.trim().toLowerCase();
      if (!this.exact.has(k)) this.exact.set(k, []);
      this.exact.get(k).push(i);
    });
  }

  /**
   * The units whose source is most like `source`, best first.
   * @returns {{unit, score:number, ops}[]}  ops: the diff FROM the unit's
   *   source TO `source` (what changed since that one was translated).
   */
  match(source, { exclude = null, limit = 6, min = 0.5, pool = 60 } = {}) {
    const q = indexTerms(source);
    const hits = new Map();
    for (const t of q) {
      // A term in a third of a large memory says nothing about likeness.
      const list = this.index.get(t);
      if (!list || list.length > Math.max(50, this.units.length / 3)) continue;
      for (const i of list) hits.set(i, (hits.get(i) ?? 0) + 1);
    }
    for (const i of this.exact.get(source.trim().toLowerCase()) ?? []) hits.set(i, Infinity);
    const ranked = [...hits]
      .filter(([i]) => this.units[i].id !== exclude)
      .map(([i, shared]) => [i, shared === Infinity ? 2 : (2 * shared) / (q.size + this.terms[i].size)])
      .sort((x, y) => y[1] - x[1])
      .slice(0, pool);
    const lenQ = source.length;
    const out = [];
    for (const [i] of ranked) {
      const u = this.units[i];
      const ratio = Math.min(lenQ, u.source.length) / Math.max(lenQ, u.source.length, 1);
      if (ratio < min * 0.8) continue;
      const { score, ops } = wordDiff(u.source, source);
      if (score >= min) out.push({ unit: u, score, ops });
    }
    out.sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id));
    // One row per distinct translation of a source: the same pair carried by
    // two keys is one suggestion.
    const seen = new Set();
    return out.filter((r) => {
      const k = r.unit.source + "\u0000" + r.unit.target;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, limit);
  }

  /** Every unit with exactly this source (case and outer space aside). */
  exactly(source) {
    return (this.exact.get(source.trim().toLowerCase()) ?? []).map((i) => this.units[i]);
  }
}

/**
 * Concordance: every unit whose source or target contains `needle`
 * (case-insensitive), sources first.
 */
export function concordance(units, needle, { limit = 200 } = {}) {
  const n = needle.trim().toLowerCase();
  if (!n) return [];
  const inSource = [], inTarget = [];
  for (const u of units) {
    if (u.source.toLowerCase().includes(n)) inSource.push(u);
    else if (u.target && u.target.toLowerCase().includes(n)) inTarget.push(u);
    if (inSource.length >= limit) break;
  }
  return [...inSource, ...inTarget].slice(0, limit);
}
