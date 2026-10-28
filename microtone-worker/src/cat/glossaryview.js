// The Glossary view: build proposals from the strings, accept or reject them,
// and see where each accepted term is (and is not) translated the agreed way.

import { h, fill, segButtons, showText } from "./dom.js";
import { extractTerms, alignTerms, findTerms, targetHasTerm, termKey } from "./glossary.js";
import { normaliseEntry } from "./project.js";
import { showModal } from "../ui/components/modal.js";

const PAGE = 150;
const splitTargets = (s) => s.split(/\s*[\/,;]\s*/).map((x) => x.trim()).filter(Boolean);

export function createGlossaryView(ctx) {
  const root = document.getElementById("view-glossary");
  const ui = ctx.ui;
  let proposals = null; // alignTerms output, with segIds; built on demand
  let builtAt = -1;
  let shown = PAGE;
  const P = () => ctx.project;

  // The toolbar is built once; a render refills only the pushbuttons and the
  // note. (Rebuilding it replaced the search field under the caret.)
  const segEl = h("div", { className: "mst-seg" });
  const noteEl = h("span", { className: "cat-note" });
  const search = h("input", { type: "search", placeholder: "Find a term", value: ui.glossSearch ?? "", spellcheck: "false" });
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.glossSearch = search.value; shown = PAGE; ctx.saveUi(); render(); }, 150);
  });
  const toolbar = h("div", { className: "cat-toolbar" },
    segEl, search,
    h("button", { type: "button", title: "Find the terms again in the strings as they are now", onclick: () => { build(); render(); } }, "Rebuild proposals"),
    h("button", { type: "button", onclick: () => addTerm() }, "Add term…"),
    noteEl);
  const wrap = h("div", { className: "cat-tablewrap" });
  root.append(toolbar, wrap);

  function build() {
    const p = P();
    const segs = p.segments.filter((s) => !s.technical);
    const pairs = segs.map((s) => ({ source: s.source, target: p.target(s) }));
    const terms = alignTerms(extractTerms(pairs.map((x) => x.source)), pairs);
    proposals = terms.map((t) => ({ ...t, segIds: t.segs.map((i) => segs[i].id) }));
    builtAt = ctx.version();
  }

  /** Where each glossary entry occurs: key → { ids, missing } over every string. */
  function usage() {
    return ctx.memo("glossaryUsage", () => {
      const p = P();
      const byKey = new Map(p.acceptedTerms.map((e) => [e.key, e]));
      const out = new Map();
      for (const seg of p.segments) {
        if (seg.technical) continue;
        const target = p.target(seg);
        for (const hit of findTerms(seg.source, byKey)) {
          let u = out.get(hit.entry.key);
          if (!u) out.set(hit.entry.key, (u = { ids: [], missing: [] }));
          if (u.ids.at(-1) === seg.id) continue;
          u.ids.push(seg.id);
          if (target && !targetHasTerm(hit.entry, target)) u.missing.push(seg.id);
        }
      }
      return out;
    });
  }

  function setEntries(entries) {
    P().setGlossary(entries);
    ctx.changed();
  }
  const upsert = (entry) => {
    const e = normaliseEntry(entry);
    setEntries([...P().glossary.filter((x) => x.key !== e.key), e]);
  };
  const remove = (key) => setEntries(P().glossary.filter((x) => x.key !== key));

  async function addTerm(prefill = {}) {
    const v = await showModal({
      title: "Add a term",
      fields: [
        { name: "source", label: "English", value: prefill.source ?? "", select: true },
        { name: "targets", label: P().langName, value: prefill.targets ?? "", hint: "Several translations: separate them with /" },
        { name: "dnt", label: "Kept in English (a name, a unit)", type: "checkbox", value: false },
        { name: "note", label: "Note", value: "" },
      ],
      okLabel: "Add",
    });
    if (!v || !termKey(v.source)) return;
    upsert({ source: v.source.trim(), targets: splitTargets(v.targets), dnt: v.dnt, note: v.note.trim(), status: "accepted" });
  }

  function render() {
    const p = P();
    if (!proposals) build();
    const known = new Map(p.glossary.map((e) => [e.key, e]));
    const pending = proposals.filter((t) => !known.has(t.key));
    const accepted = p.glossary.filter((e) => e.status === "accepted");
    const rejected = p.glossary.filter((e) => e.status === "rejected");
    const q = (ui.glossSearch ?? "").trim().toLowerCase();
    const hit = (s) => !q || s.toLowerCase().includes(q);

    segButtons(segEl, [
      { value: "proposed", label: "Proposed", count: pending.length, title: "Terms found in the English that the glossary does not have yet" },
      { value: "accepted", label: "Accepted", count: accepted.length },
      { value: "rejected", label: "Rejected", count: rejected.length, title: "Not terms: never proposed again" },
    ], ui.glossFilter, (v) => { ui.glossFilter = v; shown = PAGE; ctx.saveUi(); render(); });
    const stale = builtAt !== ctx.version();
    showText(noteEl, ui.glossFilter === "proposed"
      ? `Ranked by how term-like each is (C-value), with the ${p.langName} that keeps it company in the translated strings.${stale ? " The strings have changed since: rebuild for fresh proposals." : ""}`
      : ui.glossFilter === "accepted" ? "Every string whose English has the term is checked for its translation." : "");

    if (ui.glossFilter === "proposed") renderProposals(pending.filter((t) => hit(t.surface)));
    else if (ui.glossFilter === "accepted") renderAccepted(accepted.filter((e) => hit(e.source) || e.targets.some(hit)));
    else renderRejected(rejected.filter((e) => hit(e.source)));
  }

  function more(total) {
    return total > shown ? h("div", { className: "cat-more" }, h("button", { type: "button", onclick: () => { shown += PAGE * 2; render(); } }, `Show more (${total - shown} left)`)) : null;
  }

  function renderProposals(list) {
    const p = P();
    if (!list.length) { fill(wrap, h("div", { className: "cat-empty" }, "Nothing left to decide.")); return; }
    const rows = list.slice(0, shown).map((t) => {
      const own = h("input", { type: "text", className: "cat-input", lang: p.lang, placeholder: t.proposals[0]?.target ?? "translation", spellcheck: "false" });
      const accept = (target) => upsert({ source: t.surface, targets: target ? splitTargets(target) : [], dnt: t.proposals[0]?.dnt && !target, status: "accepted" });
      own.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); accept(own.value || t.proposals[0]?.target); } });
      return h("tr", {},
        h("td", {}, h("span", { className: "cat-term-en" }, t.surface)),
        h("td", { className: "num" }, h("button", { type: "button", className: "cat-link", title: "Show these strings", onclick: () => ctx.showStrings(t.segIds, `“${t.surface}”`) }, String(t.df))),
        h("td", {}, h("div", { className: "cat-proposals" },
          t.proposals.length ? t.proposals.map((pr) => h("button", { type: "button", lang: p.lang, title: `Accept: in ${pr.together} of the ${t.translated} translated strings with “${t.surface}”`, onclick: () => accept(pr.dnt ? "" : pr.target) },
            pr.dnt ? `${t.surface} (kept)` : pr.target, h("span", { className: "cat-dice" }, `${Math.round(pr.dice * 100)}%`)))
            : h("span", { className: "dim" }, t.translated ? "no consistent translation" : "not translated anywhere yet"))),
        h("td", {}, own),
        h("td", { className: "cat-acts" },
          h("button", { type: "button", title: "Accept the translation typed, or else the first proposal", onclick: () => accept(own.value || (t.proposals[0]?.dnt ? "" : t.proposals[0]?.target)) }, "Accept"),
          h("button", { type: "button", title: "Not a term: never propose it again", onclick: () => upsert({ source: t.surface, status: "rejected" }) }, "Reject")));
    });
    fill(wrap, h("table", { className: "cat-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "English"), h("th", {}, "Strings"), h("th", {}, `Proposed ${p.langName}`), h("th", {}, "Or type it"), h("th", {}))),
      h("tbody", {}, rows)), more(list.length));
  }

  function renderAccepted(list) {
    const p = P();
    if (!list.length) { fill(wrap, h("div", { className: "cat-empty" }, "No accepted terms yet: accept some proposals, or add a term.")); return; }
    const use = usage();
    list = [...list].sort((a, b) => (use.get(b.key)?.missing.length ?? 0) - (use.get(a.key)?.missing.length ?? 0) || a.source.localeCompare(b.source));
    const rows = list.slice(0, shown).map((e) => {
      const u = use.get(e.key) ?? { ids: [], missing: [] };
      const targets = h("input", { type: "text", className: "cat-input", lang: p.lang, value: e.targets.join(" / "), disabled: e.dnt, spellcheck: "false", title: "Several translations: separate them with /" });
      targets.addEventListener("change", () => upsert({ ...e, targets: splitTargets(targets.value) }));
      const note = h("input", { type: "text", className: "cat-input", value: e.note, placeholder: "note", spellcheck: "false" });
      note.addEventListener("change", () => upsert({ ...e, note: note.value.trim() }));
      const dnt = h("input", { type: "checkbox", checked: e.dnt, title: "Kept in English (a name, a unit)", onchange: () => upsert({ ...e, dnt: dnt.checked }) });
      const used = u.ids.length - u.missing.length;
      return h("tr", {},
        h("td", {}, h("span", { className: "cat-term-en" }, e.source)),
        h("td", {}, targets),
        h("td", { className: "num" }, dnt),
        h("td", {}, note),
        h("td", { className: "num" }, u.missing.length
          ? h("button", { type: "button", className: "cat-link cat-usage partial", title: "Show the strings that do not use it", onclick: () => ctx.showStrings(u.missing, `“${e.source}” not as agreed`) }, `${used}/${u.ids.length}`)
          : h("span", { className: "cat-usage full", title: "Every translated string with the term uses it" }, `${used}/${u.ids.length}`)),
        h("td", { className: "cat-acts" },
          h("button", { type: "button", onclick: () => upsert({ ...e, status: "rejected" }) }, "Reject"),
          h("button", { type: "button", title: "Take it out of the glossary (it may be proposed again)", onclick: () => remove(e.key) }, "Remove")));
    });
    fill(wrap, h("table", { className: "cat-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "English"), h("th", {}, p.langName), h("th", { title: "Kept in English" }, "Keep"), h("th", {}, "Note"), h("th", { title: "Translated strings with the term that use its translation" }, "Used"), h("th", {}))),
      h("tbody", {}, rows)), more(list.length));
  }

  function renderRejected(list) {
    if (!list.length) { fill(wrap, h("div", { className: "cat-empty" }, "Nothing rejected.")); return; }
    const rows = list.slice(0, shown).map((e) => h("tr", {},
      h("td", {}, h("span", { className: "cat-term-en" }, e.source)),
      h("td", { className: "cat-acts" },
        h("button", { type: "button", onclick: () => upsert({ ...e, status: "accepted" }) }, "Accept"),
        h("button", { type: "button", title: "Propose it again", onclick: () => remove(e.key) }, "Restore"))));
    fill(wrap, h("table", { className: "cat-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "English"), h("th", {}))), h("tbody", {}, rows)), more(list.length));
  }

  return {
    render,
    reset() { proposals = null; shown = PAGE; },
    addTerm,
  };
}
