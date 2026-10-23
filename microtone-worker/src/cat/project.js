// One target language across every corpus: the segments, what the
// translator has changed and not yet saved, and the files a save writes.
//
// Three layers, read in this order:
//
//   the files    each corpus's en.js and <lang>.js as served, and the
//                workbench's record translation/data/<lang>.json: the
//                glossary, and per corpus `reviewed` (the English each
//                translation was last checked against — a translation whose
//                English has since changed is STALE), `keep` (keys whose
//                translation is rightly the English) and `dismissed` (issue
//                ids the translator has looked at and let stand)
//   local        everything changed since, kept in the browser
//                (localStorage) until it is saved: drafts, confirmations,
//                keep/dismiss marks, the glossary
//   derived      statuses, the translation memory, the issues
//
// Saving writes the files back (save.js) and the local layer empties. A
// local change that the files now agree with — the save went in another way,
// or the same edit was made by hand — is dropped when the project loads.

import { parseLangFile, writeLangFile, newLangFile } from "./langfile.js";
import { CORPORA, LANGUAGES, dataUrl, dataRepoPath, isTechnical } from "./corpora.js";
import { TranslationMemory } from "./tm.js";
import { runChecks } from "./checks.js";
import { termKey } from "./glossary.js";

const emptyLocal = () => ({ drafts: {}, reviewed: {}, keep: {}, dismissed: {}, glossary: null });

export function emptyData(lang) {
  return { format: 1, lang, glossary: [], corpora: {} };
}

/** The data file's text: stable order, one glossary entry and one reviewed key per line. */
export function stringifyData(data) {
  const j = JSON.stringify;
  const out = ["{", `  "format": ${data.format},`, `  "lang": ${j(data.lang)},`];
  const gl = [...data.glossary].sort((a, b) => a.source.localeCompare(b.source, "en") || a.source.localeCompare(b.source));
  out.push(`  "glossary": [${gl.length ? "" : "],"}`);
  gl.forEach((e, i) => {
    const o = { source: e.source, targets: e.targets ?? [], status: e.status };
    if (e.dnt) o.dnt = true;
    if (e.note) o.note = e.note;
    out.push(`    ${j(o)}${i < gl.length - 1 ? "," : ""}`);
  });
  if (gl.length) out.push("  ],");
  const ids = Object.keys(data.corpora);
  out.push(`  "corpora": {${ids.length ? "" : "}"}`);
  ids.forEach((id, ci) => {
    const c = data.corpora[id];
    out.push(`    ${j(id)}: {`);
    out.push(`      "keep": ${j(c.keep ?? [])},`);
    out.push(`      "dismissed": [${(c.dismissed ?? []).map(j).join(", ")}],`);
    const rv = Object.entries(c.reviewed ?? {});
    out.push(`      "reviewed": {${rv.length ? "" : "}"}`);
    rv.forEach(([k, v], i) => out.push(`        ${j(k)}: ${j(v)}${i < rv.length - 1 ? "," : ""}`));
    if (rv.length) out.push("      }");
    out.push(`    }${ci < ids.length - 1 ? "," : ""}`);
  });
  if (ids.length) out.push("  }");
  out.push("}", "");
  return out.join("\n");
}

export function parseData(text, lang) {
  if (!text) return emptyData(lang);
  const d = JSON.parse(text);
  if (d.format !== 1) throw new Error(`data/${lang}.json: unknown format ${d.format}`);
  return {
    format: 1,
    lang: d.lang ?? lang,
    glossary: (d.glossary ?? []).map(normaliseEntry),
    corpora: d.corpora ?? {},
  };
}

export function normaliseEntry(e) {
  return {
    key: termKey(e.source),
    source: e.source,
    targets: (e.targets ?? []).filter(Boolean),
    status: e.status === "rejected" ? "rejected" : "accepted",
    dnt: !!e.dnt,
    note: e.note ?? "",
  };
}

/**
 * Fetch everything a language needs. `fetchText(url)` resolves the text, or
 * null where there is no such file (a 404).
 */
export async function loadProject({ lang, fetchText, storage = null }) {
  const corpora = [];
  for (const def of CORPORA) {
    let base = null, englishText = null;
    for (const url of def.urls) {
      englishText = await fetchText(url + "en.js");
      if (englishText !== null) { base = url; break; }
    }
    if (base === null) continue; // not served here: the corpus is skipped
    corpora.push({ def, base, englishText, targetText: await fetchText(base + lang + ".js") });
  }
  if (!corpora.length) throw new Error("no language tables found beside this page");
  const dataText = await fetchText(dataUrl(lang));
  return new Project({ lang, corpora, dataText, storage });
}

export class Project {
  constructor({ lang, corpora, dataText = null, storage = null }) {
    this.lang = lang;
    this.langName = LANGUAGES[lang] ?? lang;
    this.storage = storage;
    this.dataText = dataText;
    this.data = parseData(dataText, lang);
    this.corpora = corpora.map((c) => ({
      ...c,
      en: parseLangFile(c.englishText),
      target: c.targetText === null ? null : parseLangFile(c.targetText),
    }));
    this.local = { ...emptyLocal(), ...(storage?.load() ?? {}) };
    this.segments = [];
    this.byId = new Map();
    for (const c of this.corpora) {
      const id = c.def.id;
      for (const key of c.en.order) {
        const seg = {
          id: `${id}/${key}`,
          corpus: id,
          key,
          source: c.en.entries.get(key).value,
          base: c.target?.entries.get(key)?.value ?? "",
          context: c.en.context.get(key),
          technical: isTechnical(key),
        };
        this.segments.push(seg);
        this.byId.set(seg.id, seg);
      }
    }
    this._tidyLocal();
    this._version = 0;
    this._cache = new Map();
  }

  // ── reading ──

  corpusOf(seg) { return this.corpora.find((c) => c.def.id === seg.corpus); }
  record(corpus) { return this.data.corpora[corpus] ?? { keep: [], dismissed: [], reviewed: {} }; }

  target(seg) {
    const d = this.local.drafts[seg.corpus]?.[seg.key];
    return d !== undefined ? d : seg.base;
  }
  edited(seg) { return this.target(seg) !== seg.base; }
  /** The English this translation was last checked against. */
  reviewedSource(seg) {
    return this.local.reviewed[seg.corpus]?.[seg.key] ?? this.record(seg.corpus).reviewed?.[seg.key] ?? seg.source;
  }
  stale(seg) { return !!this.target(seg) && this.reviewedSource(seg) !== seg.source; }
  keep(seg) {
    const l = this.local.keep[seg.corpus]?.[seg.key];
    return l !== undefined ? l : (this.record(seg.corpus).keep ?? []).includes(seg.key);
  }
  isDismissed(issueId) {
    const corpus = issueId.split(":")[1];
    const l = this.local.dismissed[corpus]?.[issueId];
    return l !== undefined ? l : (this.record(corpus).dismissed ?? []).includes(issueId);
  }
  /** untranslated | stale | translated */
  status(seg) {
    if (!this.target(seg)) return "untranslated";
    if (this.stale(seg)) return "stale";
    return "translated";
  }

  get glossary() { return this.local.glossary ?? this.data.glossary; }
  get acceptedTerms() { return this.glossary.filter((e) => e.status === "accepted"); }

  /** The translation memory over every translated segment (cached per change). */
  tm() {
    return this._memo("tm", () => new TranslationMemory(this.segments
      .filter((s) => !s.technical && this.target(s) && (this.target(s) !== s.source || this.keep(s)))
      .map((s) => ({ id: s.id, corpus: s.corpus, key: s.key, source: s.source, target: this.target(s) }))));
  }

  /** Every issue, dismissed ones included (each carries `dismissed`). */
  allIssues() {
    return this._memo("issues", () => runChecks(
      this.segments.map((s) => ({ ...s, target: this.target(s), keep: this.keep(s), seg: s })),
      this.acceptedTerms,
    ).map((i) => ({ ...i, segment: i.segment.seg, dismissed: this.isDismissed(i.id) })));
  }
  issues() { return this.allIssues().filter((i) => !i.dismissed); }
  issuesBySegment() {
    return this._memo("issuesBySeg", () => {
      const m = new Map();
      for (const i of this.issues()) {
        if (!m.has(i.segment.id)) m.set(i.segment.id, []);
        m.get(i.segment.id).push(i);
      }
      return m;
    });
  }

  counts() {
    return this._memo("counts", () => {
      const c = { total: 0, untranslated: 0, stale: 0, translated: 0, edited: 0 };
      for (const s of this.segments) {
        if (s.technical) continue;
        c.total++;
        c[this.status(s)]++;
        if (this.edited(s)) c.edited++;
      }
      return c;
    });
  }

  /** How many things a save would write that the files do not have yet. */
  unsaved() {
    const l = this.local;
    const n = (o) => Object.values(o).reduce((a, m) => a + Object.keys(m).length, 0);
    return n(l.drafts) + n(l.reviewed) + n(l.keep) + n(l.dismissed) + (l.glossary ? 1 : 0);
  }

  // ── changing ──

  setTarget(seg, value) {
    this._local("drafts", seg, value === seg.base ? undefined : value);
  }
  revert(seg) { this.setTarget(seg, seg.base); }
  /** The translation has been checked against the English as it is now. */
  confirm(seg) {
    const committed = this.record(seg.corpus).reviewed?.[seg.key] ?? seg.source;
    this._local("reviewed", seg, committed === seg.source ? undefined : seg.source);
  }
  setKeep(seg, on) {
    const committed = (this.record(seg.corpus).keep ?? []).includes(seg.key);
    this._local("keep", seg, on === committed ? undefined : on);
  }
  setDismissed(issue, on) {
    const corpus = issue.segment.corpus;
    const committed = (this.record(corpus).dismissed ?? []).includes(issue.id);
    const map = (this.local.dismissed[corpus] ??= {});
    if (on === committed) delete map[issue.id]; else map[issue.id] = on;
    if (!Object.keys(map).length) delete this.local.dismissed[corpus];
    this._changed();
  }
  setGlossary(entries) {
    const same = stringifyData({ ...emptyData(this.lang), glossary: entries })
      === stringifyData({ ...emptyData(this.lang), glossary: this.data.glossary });
    this.local.glossary = same ? null : entries.map(normaliseEntry);
    this._changed();
  }

  /** Forget every unsaved change. */
  discardLocal() {
    this.local = emptyLocal();
    this._changed();
  }

  _local(kind, seg, value) {
    const map = (this.local[kind][seg.corpus] ??= {});
    if (value === undefined) delete map[seg.key]; else map[seg.key] = value;
    if (!Object.keys(map).length) delete this.local[kind][seg.corpus];
    this._changed();
  }

  _changed() {
    this._version++;
    this._cache.clear();
    this.storage?.save(this.local);
  }

  _memo(name, fn) {
    if (!this._cache.has(name)) this._cache.set(name, fn());
    return this._cache.get(name);
  }

  // Drop local changes the files already agree with, and any for keys or
  // corpora that no longer exist.
  _tidyLocal() {
    const l = this.local;
    for (const kind of ["drafts", "reviewed", "keep"]) {
      for (const [corpus, map] of Object.entries(l[kind])) {
        for (const [key, v] of Object.entries(map)) {
          const seg = this.byId.get(`${corpus}/${key}`);
          const rec = this.record(corpus);
          const redundant = !seg
            || (kind === "drafts" && v === seg.base)
            || (kind === "reviewed" && v === (rec.reviewed?.[key] ?? seg.source))
            || (kind === "keep" && v === (rec.keep ?? []).includes(key));
          if (redundant) delete map[key];
        }
        if (!Object.keys(map).length) delete l[kind][corpus];
      }
    }
    for (const [corpus, map] of Object.entries(l.dismissed)) {
      for (const [id, v] of Object.entries(map)) {
        if (v === (this.record(corpus).dismissed ?? []).includes(id)) delete map[id];
      }
      if (!Object.keys(map).length) delete l.dismissed[corpus];
    }
    if (l.glossary) {
      l.glossary = l.glossary.map(normaliseEntry);
      if (stringifyData({ ...emptyData(this.lang), glossary: l.glossary })
        === stringifyData({ ...emptyData(this.lang), glossary: this.data.glossary })) l.glossary = null;
    }
    this.storage?.save(l);
  }

  // ── saving ──

  /** The record as a save would write it. */
  mergedData() {
    const live = new Set(this.allIssues().map((i) => i.id));
    const out = { format: 1, lang: this.lang, glossary: this.glossary, corpora: {} };
    for (const c of this.corpora) {
      const id = c.def.id;
      const segs = this.segments.filter((s) => s.corpus === id);
      const reviewed = {};
      for (const s of segs) if (!s.technical && this.target(s)) reviewed[s.key] = this.reviewedSource(s);
      const dismissed = new Set((this.record(id).dismissed ?? []).filter((x) => live.has(x)));
      for (const [x, on] of Object.entries(this.local.dismissed[id] ?? {})) { if (on && live.has(x)) dismissed.add(x); else dismissed.delete(x); }
      out.corpora[id] = {
        keep: segs.filter((s) => this.keep(s)).map((s) => s.key),
        dismissed: [...dismissed].sort(),
        reviewed,
      };
    }
    return out;
  }

  /**
   * The files a save writes — only those whose text would change.
   * @returns {{path:string, text:string, corpus?:string, created?:boolean, dropped?:string[]}[]}
   */
  files() {
    const out = [];
    for (const c of this.corpora) {
      const id = c.def.id;
      // An empty translation is no translation (the key leaves the file and
      // falls back to English) — unless the file itself says "" there.
      const values = {};
      for (const s of this.segments) {
        if (s.corpus !== id) continue;
        const t = this.target(s);
        values[s.key] = t !== "" ? t : (c.target?.entries.has(s.key) && s.base === "" ? "" : null);
      }
      const path = c.def.repo + this.lang + ".js";
      if (c.targetText !== null) {
        const text = writeLangFile({ text: c.targetText, values, order: c.en.order });
        const dropped = [...c.target.entries.keys()].filter((k) => !c.en.entries.has(k));
        if (text !== c.targetText) out.push({ path, text, corpus: id, dropped });
      } else if (Object.values(values).some(Boolean)) {
        out.push({ path, text: newLangFile({ code: this.lang, name: this.langName, englishText: c.englishText, values }), corpus: id, created: true });
      }
    }
    const data = stringifyData(this.mergedData());
    if (data !== this.dataText) out.push({ path: dataRepoPath(this.lang), text: data });
    return out;
  }

  /** The files went in: they are now what the project was loaded from. */
  markSaved(files) {
    for (const f of files) {
      const c = this.corpora.find((x) => x.def.id === f.corpus);
      if (c) {
        c.targetText = f.text;
        c.target = parseLangFile(f.text);
        for (const s of this.segments) if (s.corpus === c.def.id) s.base = c.target.entries.get(s.key)?.value ?? "";
      } else {
        this.dataText = f.text;
        this.data = parseData(f.text, this.lang);
      }
    }
    this.local = emptyLocal();
    this._changed();
  }
}

/** localStorage-backed persistence for the local layer, one key per language. */
export function browserStorage(lang) {
  const key = `microtone-cat:${lang}`;
  return {
    load() {
      try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
    },
    save(local) {
      try { localStorage.setItem(key, JSON.stringify(local)); } catch { /* private mode / full: the session still works */ }
    },
  };
}
