// Quality checks: everything a translation can get wrong that a program can
// see. Each finds issues on segments that HAVE a translation — an
// untranslated or stale segment is a status (project.js), not an issue.
//
//   placeholder   a {name} missing, added or misspelt               error
//   code          a key chord, F-key, (Key), $hex lost or changed    warning
//   number        a number in the source not in the translation      info
//   ellipsis      … on one side only (it promises a dialog)          warning
//   space         leading/trailing space or line breaks differ       warning
//   glossary      an accepted term's translation is not used         warning
//   inconsistent  the same English translated differently elsewhere  warning
//   convergent    different English translated the same way         info
//   identical     the translation is the English (not marked kept)   info
//   doublespace   two spaces in a row the source does not have       info
//
// An issue's `id` names the check, the segment and the translation it was
// found in, so dismissing one does not silence a later, different mistake.

import { placeholders, codes, numbers, words, lemma, PLACEHOLDER } from "./text.js";
import { findTerms, targetHasTerm } from "./glossary.js";

export const CHECKS = {
  placeholder: { severity: "error", title: "Placeholders" },
  code: { severity: "warning", title: "Keys and codes" },
  ellipsis: { severity: "warning", title: "Ellipsis" },
  space: { severity: "warning", title: "Spacing and line breaks" },
  glossary: { severity: "warning", title: "Glossary" },
  inconsistent: { severity: "warning", title: "Same English, different translations" },
  number: { severity: "info", title: "Numbers" },
  convergent: { severity: "info", title: "Different English, same translation" },
  identical: { severity: "info", title: "Same as English" },
  doublespace: { severity: "info", title: "Double spaces" },
};

/** FNV-1a, 32-bit, hex — short and stable, for issue ids. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const multisetDiff = (a, b) => {
  const left = [...a];
  const extra = [];
  for (const x of b) {
    const i = left.indexOf(x);
    if (i >= 0) left.splice(i, 1); else extra.push(x);
  }
  return { missing: left, extra };
};

const quote = (s) => `“${s}”`;
const ELLIPSIS = /(?:…|\.\.\.)\s*$/;
// Sources that differ only in case, punctuation or number are "the same
// English" for the convergence check (Save / Save… / save, song / songs).
const looseSource = (s) => words(s).map(lemma).join(" ");

/**
 * @param segments  [{id, corpus, key, source, target, keep, technical}]
 *   target "" or null = untranslated (skipped)
 * @param glossary  accepted entries [{key, source, targets, dnt}] (keys from termKey)
 * @returns issues [{id, check, severity, segment, message, related?}]
 */
export function runChecks(segments, glossary = []) {
  const issues = [];
  const add = (check, seg, message, extra = {}) => issues.push({
    id: `${check}:${seg.corpus}:${seg.key}:${hash(seg.target)}`,
    check, severity: CHECKS[check].severity, segment: seg, message, ...extra,
  });
  const byKey = new Map(glossary.map((e) => [e.key, e]));
  const live = segments.filter((s) => s.target && !s.technical && s.source);

  for (const seg of live) {
    const { source, target } = seg;
    const ph = multisetDiff(placeholders(source), placeholders(target));
    if (ph.missing.length || ph.extra.length) {
      add("placeholder", seg, [
        ph.missing.length ? `missing ${ph.missing.join(" ")}` : "",
        ph.extra.length ? `not in the English: ${ph.extra.join(" ")}` : "",
      ].filter(Boolean).join("; "));
    }
    const cd = multisetDiff(codes(source), codes(target));
    if (cd.missing.length) add("code", seg, `missing ${cd.missing.join(" ")}${cd.extra.length ? `; has ${cd.extra.join(" ")} instead` : ""}`);
    const nd = multisetDiff(numbers(source), numbers(target));
    if (nd.missing.length) add("number", seg, `${nd.missing.join(" ")} not in the translation`);
    const es = ELLIPSIS.test(source), et = ELLIPSIS.test(target);
    if (es !== et) add("ellipsis", seg, es ? "the English ends with …, the translation does not" : "the translation ends with …, the English does not");
    const lead = (s) => /^\s/.test(s), trail = (s) => /\s$/.test(s);
    const breaks = (s) => (s.match(/\n/g) ?? []).length;
    const sp = [];
    if (lead(source) !== lead(target)) sp.push(lead(source) ? "the English starts with a space" : "the translation starts with a space");
    if (trail(source) !== trail(target)) sp.push(trail(source) ? "the English ends with a space" : "the translation ends with a space");
    if (breaks(source) !== breaks(target)) sp.push(`${breaks(source)} line break(s) in the English, ${breaks(target)} in the translation`);
    if (sp.length) add("space", seg, sp.join("; "));
    if (/ {2}/.test(target) && !/ {2}/.test(source)) add("doublespace", seg, "two spaces in a row");
    if (target === source && /\p{L}{2}/u.test(source.replace(PLACEHOLDER, "")) && !seg.keep) add("identical", seg, "the translation is the English");
    for (const hit of findTerms(source, byKey)) {
      if (targetHasTerm(hit.entry, target)) continue;
      const want = hit.entry.dnt ? `kept as ${quote(hit.entry.source)}` : (hit.entry.targets ?? []).map(quote).join(" or ");
      add("glossary", seg, `${quote(source.slice(hit.start, hit.end))} should be ${want}`, { term: hit.entry });
    }
  }

  // Same English, different translations — across every corpus.
  const bySource = new Map();
  for (const seg of live) {
    const k = seg.source.trim();
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(seg);
  }
  for (const group of bySource.values()) {
    const variants = new Set(group.map((s) => s.target.trim()));
    if (variants.size < 2) continue;
    for (const seg of group) {
      const others = group.filter((o) => o.target.trim() !== seg.target.trim());
      add("inconsistent", seg, `also translated as ${[...new Set(others.map((o) => quote(o.target.trim())))].join(", ")}`, { related: others });
    }
  }

  // Different English, the same translation: often right (synonyms), worth
  // a look when the English draws a distinction the translation loses.
  const byTarget = new Map();
  for (const seg of live) {
    if (seg.target === seg.source) continue;
    const k = seg.target.trim();
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(seg);
  }
  for (const group of byTarget.values()) {
    const sources = new Set(group.map((s) => looseSource(s.source)));
    if (sources.size < 2) continue;
    for (const seg of group) {
      const others = group.filter((o) => looseSource(o.source) !== looseSource(seg.source));
      add("convergent", seg, `also the translation of ${[...new Set(others.map((o) => quote(o.source.trim())))].join(", ")}`, { related: others });
    }
  }
  return issues;
}
