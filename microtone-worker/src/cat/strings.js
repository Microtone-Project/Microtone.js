// The Strings view: every segment in a list (filtered, searchable, virtual —
// only the rows in sight exist), and the editor for the one selected: its
// English and context, the translation, what the checks say about it, the
// memory's nearest matches, its glossary terms and a concordance search.

import { h, fill, showText, sourceView, diffView, hitView, segButtons } from "./dom.js";
import { wordDiff } from "./text.js";
import { findTerms, targetHasTerm } from "./glossary.js";
import { concordance } from "./tm.js";
import { CHECKS } from "./checks.js";
import { actionButton } from "../ui/components/actions.js";
import { showModal, showNotice } from "../ui/components/modal.js";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "todo", label: "To do", title: "Untranslated, or the English changed since" },
  { value: "untranslated", label: "Untranslated" },
  { value: "stale", label: "Stale", title: "The English changed since this was translated" },
  { value: "edited", label: "Edited", title: "Changed here and not saved yet" },
  { value: "issues", label: "Issues", title: "Something the checks found" },
];

export function createStrings(ctx) {
  const listEl = document.getElementById("list");
  const editorEl = document.getElementById("editor");
  const footEl = document.getElementById("listFoot");
  const searchEl = document.getElementById("search");
  const statusSeg = document.getElementById("statusSeg");
  const corpusSeg = document.getElementById("corpusSeg");
  const spacer = h("div", { className: "cat-list-spacer" });
  listEl.append(spacer);

  let rows = []; // the filtered segments, in list order
  let rowH = 0;
  let editorFor = null; // the segment the editor was built for
  let textarea = null;

  const P = () => ctx.project;
  const ui = ctx.ui;

  // ── filtering ──

  function matches(seg, filter) {
    const p = P();
    switch (filter) {
      case "todo": return p.status(seg) !== "translated";
      case "untranslated": return p.status(seg) === "untranslated";
      case "stale": return p.status(seg) === "stale";
      case "edited": return p.edited(seg) || !!p.local.reviewed[seg.corpus]?.[seg.key];
      case "issues": return p.issuesBySegment().has(seg.id);
      default: return true;
    }
  }

  function inScope(seg) {
    if (seg.technical && ui.status !== "all") return false;
    if (ui.corpus !== "all" && seg.corpus !== ui.corpus) return false;
    if (ui.only && !ui.only.has(seg.id)) return false;
    const q = ui.search.trim().toLowerCase();
    if (q) {
      const t = P().target(seg).toLowerCase();
      if (!seg.source.toLowerCase().includes(q) && !t.includes(q) && !seg.key.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function recompute() {
    const scoped = P().segments.filter(inScope);
    rows = scoped.filter((s) => matches(s, ui.status));
    const counts = Object.fromEntries(STATUS_FILTERS.map((f) => [f.value, scoped.filter((s) => (f.value === "all" || !s.technical) && matches(s, f.value)).length]));
    segButtons(statusSeg, STATUS_FILTERS.map((f) => ({ ...f, count: counts[f.value] })), ui.status, (v) => { ui.status = v; ctx.saveUi(); refresh(); });
    const corpora = P().corpora;
    corpusSeg.hidden = corpora.length < 2;
    segButtons(corpusSeg, [{ value: "all", label: "Both apps" }, ...corpora.map((c) => ({ value: c.def.id, label: c.def.name }))],
      ui.corpus, (v) => { ui.corpus = v; ctx.saveUi(); refresh(); });
    spacer.style.height = `${rows.length * rowHeight()}px`;
    const onlyNote = ui.only ? ` — ${ui.onlyLabel} (` : "";
    fill(footEl,
      `${rows.length} of ${P().segments.length} strings`,
      ui.only ? [onlyNote, h("button", { className: "cat-link", onclick: () => { ui.only = null; refresh(); } }, "show all"), ")"] : null);
  }

  function rowHeight() {
    if (rowH) return rowH;
    const probe = rowEl(P().segments[0], 0);
    probe.style.visibility = "hidden";
    spacer.append(probe);
    rowH = Math.ceil(probe.getBoundingClientRect().height) || 44;
    probe.remove();
    return rowH;
  }

  // ── the list ──

  function rowEl(seg, i) {
    const p = P();
    const status = p.status(seg);
    const target = p.target(seg);
    const issues = p.issuesBySegment().get(seg.id);
    const lamp = h("span", { className: `cat-lamp ${status}${p.edited(seg) ? " edited" : ""}`, title: status + (p.edited(seg) ? ", edited" : "") });
    const corpusTag = P().corpora.length > 1 && ui.corpus === "all" ? `${p.corpusOf(seg).def.name} · ` : "";
    const key = h("div", { className: "cat-key" }, corpusTag + seg.key,
      issues ? h("span", { className: "cat-flag", title: issues.map((x) => x.message).join("\n") }, `! ${issues.length}`) : null);
    const el = h("div", { className: `cat-row${seg.id === ui.selected ? " sel" : ""}`, role: "option", dataset: { id: seg.id } },
      h("div", { className: "cat-lampcell" }, lamp),
      key,
      h("div", { className: "cat-src", title: seg.source }, oneLine(seg.source)),
      h("div", { className: `cat-tgt${target ? "" : " empty"}`, lang: p.lang, title: target }, target ? oneLine(target) : "untranslated"));
    el.style.top = `${i * (rowH || 0)}px`;
    return el;
  }

  const oneLine = (s) => s.replace(/\n/g, " ⏎ ");

  let drawn = "";
  function drawList(force = false) {
    if (!ctx.project) return;
    const H = rowHeight();
    const top = listEl.scrollTop, height = listEl.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / H) - 8);
    const last = Math.min(rows.length, Math.ceil((top + height) / H) + 8);
    const key = `${first}:${last}:${rows.length}:${ui.selected}:${ctx.version()}`;
    if (!force && key === drawn) return;
    drawn = key;
    const els = [];
    for (let i = first; i < last; i++) els.push(rowEl(rows[i], i));
    spacer.replaceChildren(...els);
  }

  let scrollQueued = false;
  listEl.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; drawList(); });
  });
  new ResizeObserver(() => drawList(true)).observe(listEl);
  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".cat-row");
    if (row) select(row.dataset.id, { focusEditor: false });
  });
  listEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1, { focusEditor: false }); }
    else if (e.key === "Enter") { e.preventDefault(); textarea?.focus(); }
  });

  function scrollIntoView(id) {
    const i = rows.findIndex((s) => s.id === id);
    if (i < 0) return;
    const H = rowHeight();
    const top = i * H;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (top + H > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = top + H - listEl.clientHeight;
  }

  // ── selection ──

  function select(id, { focusEditor = true, scroll = true } = {}) {
    if (!P().byId.has(id)) return;
    ui.selected = id;
    ctx.saveUi();
    history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    if (scroll) scrollIntoView(id);
    drawList(true);
    buildEditor(P().byId.get(id));
    showText(document.getElementById("status"), statusText());
    if (focusEditor) textarea?.focus();
  }

  function move(delta, opts = {}) {
    if (!rows.length) return;
    const i = rows.findIndex((s) => s.id === ui.selected);
    const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta));
    select(rows[j].id, opts);
  }

  /** After a confirm: the next row, even when the confirmed one leaves the filter. */
  function advance() {
    const i = rows.findIndex((s) => s.id === ui.selected);
    const next = rows[i + 1]?.id ?? null;
    recompute();
    const still = rows.findIndex((s) => s.id === ui.selected);
    if (still >= 0) { if (rows[still + 1]) select(rows[still + 1].id); else select(rows[still].id); }
    else if (next && rows.some((s) => s.id === next)) select(next);
    else if (rows.length) select(rows[Math.min(Math.max(i, 0), rows.length - 1)].id);
    else { drawList(true); buildEditor(null); }
  }

  // ── the editor ──

  function buildEditor(seg) {
    editorFor = seg;
    textarea = null;
    if (!seg) { fill(editorEl); return; }
    const p = P();
    const corpus = p.corpusOf(seg);
    const status = p.status(seg);
    const terms = new Map(p.acceptedTerms.map((e) => [e.key, e]));
    const ctxNotes = seg.context ?? { section: "", notes: [] };

    textarea = h("textarea", { className: "cat-target", lang: p.lang, spellcheck: "true", rows: "3", "aria-label": `Translation into ${p.langName}` });
    textarea.value = p.target(seg);
    const autosize = () => { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 420)}px`; };
    textarea.addEventListener("input", () => {
      p.setTarget(seg, textarea.value);
      ctx.changed({ soon: true });
      autosize();
    });

    const insertAtCaret = (text) => {
      const { selectionStart: a, selectionEnd: b, value } = textarea;
      textarea.value = value.slice(0, a) + text + value.slice(b);
      textarea.selectionStart = textarea.selectionEnd = a + text.length;
      textarea.dispatchEvent(new Event("input"));
      textarea.focus();
    };
    const replaceWith = (text) => {
      textarea.value = text;
      textarea.dispatchEvent(new Event("input"));
      textarea.focus();
    };

    const confirmBtn = actionButton({ label: "Confirm", title: "This translation fits the English as it is now — go to the next (Ctrl+Enter)" }, "proceed");
    confirmBtn.addEventListener("click", () => confirm());
    const copyBtn = h("button", { type: "button", title: "Put the English in the translation (Ctrl+Shift+S)", onclick: () => replaceWith(seg.source) }, "Copy English");
    const revertBtn = h("button", { type: "button", title: "Back to what the file says", hidden: !p.edited(seg), onclick: () => { p.revert(seg); ctx.changed(); buildEditor(seg); textarea.focus(); } }, "Undo my edit");
    const keepBox = h("input", { type: "checkbox", checked: p.keep(seg), onchange: () => { p.setKeep(seg, keepBox.checked); ctx.changed(); } });
    const keepLabel = h("label", { title: "The translation is rightly the same as the English (an abbreviation, a unit, a name) — the checks stop asking" }, keepBox, "Same as English on purpose");
    keepLabel.hidden = !(p.target(seg) === seg.source || p.keep(seg));

    const stale = status === "stale"
      ? h("div", { className: "cat-stale" },
        h("div", { className: "cat-stale-head" }, "The English changed since this was translated:"),
        diffView(wordDiff(p.reviewedSource(seg), seg.source).ops))
      : null;

    const issuesBox = h("div", { className: "cat-issues-box" });
    const matchesBox = h("div", { className: "cat-matches" });
    const termsBox = h("div", { className: "cat-terms" });

    const concInput = h("input", { type: "search", placeholder: "Find a word in every string…", spellcheck: "false" });
    const concList = h("div", { className: "cat-conc-list" });
    concInput.addEventListener("input", () => drawConcordance(concInput.value, concList));

    fill(editorEl,
      h("div", { className: "cat-ed-head" },
        h("span", { className: "cat-ed-key" }, seg.key),
        h("span", { className: "cat-ed-corpus" }, corpus.def.name),
        h("span", { className: `cat-ed-status ${status}` }, status === "untranslated" ? "untranslated" : status === "stale" ? "English changed" : "translated"),
        seg.technical ? h("span", { className: "cat-ed-status" }, "not prose — no checks") : null),
      (ctxNotes.section || ctxNotes.notes.length)
        ? h("div", { className: "cat-context" },
          ctxNotes.section ? h("span", { className: "cat-section" }, `§ ${ctxNotes.section}`) : null,
          ctxNotes.notes.map((n) => h("p", {}, n)))
        : null,
      h("div", { className: "cat-label" }, "English", h("span", { className: "grow" })),
      h("div", { className: "cat-source", lang: "en" }, sourceView(seg.source, terms, (entry) => insertAtCaret(entry.dnt ? entry.source : entry.targets[0] ?? ""))),
      stale,
      h("div", { className: "cat-label" }, p.langName),
      textarea,
      h("div", { className: "cat-actions" }, copyBtn, revertBtn, keepLabel, h("span", { className: "grow" }), confirmBtn),
      issuesBox,
      h("div", { className: "cat-label" }, "Glossary"),
      termsBox,
      h("div", { className: "cat-label" }, "Translation memory"),
      matchesBox,
      h("div", { className: "cat-label" }, "Concordance"),
      h("div", { className: "cat-conc" }, concInput, concList));

    autosize();
    editorEl._derived = { issuesBox, matchesBox, termsBox, keepLabel, revertBtn, replaceWith, insertAtCaret };
    drawDerived(seg, editorEl._derived);
  }

  // The editor's parts that depend on the translation being typed, redrawn
  // once typing pauses.
  function drawDerived(seg, parts) {
    const p = P();
    const target = p.target(seg);
    parts.keepLabel.hidden = !(target === seg.source || p.keep(seg));
    parts.revertBtn.hidden = !p.edited(seg);

    const segIssues = p.allIssues().filter((i) => i.segment.id === seg.id);
    fill(parts.issuesBox, segIssues.length ? [
      h("div", { className: "cat-label" }, "Checks"),
      segIssues.map((i) => h("div", { className: `cat-issue${i.dismissed ? " dismissed" : ""}` },
        h("span", { className: `cat-sev ${i.severity}` }, i.severity),
        h("span", { className: "cat-msg" }, `${CHECKS[i.check].title}: ${i.message}`,
          i.related ? relatedLinks(i.related) : null),
        h("button", { type: "button", title: i.dismissed ? "Check this again" : "It is right as it is — stop flagging it", onclick: () => { p.setDismissed(i, !i.dismissed); ctx.changed(); } }, i.dismissed ? "Restore" : "Dismiss"))),
    ] : null);

    // Terms
    const terms = new Map(p.acceptedTerms.map((e) => [e.key, e]));
    const seen = new Set();
    const hits = findTerms(seg.source, terms).filter((t) => !seen.has(t.entry.key) && seen.add(t.entry.key));
    fill(parts.termsBox, hits.length ? hits.map((t) => {
      const want = t.entry.dnt ? t.entry.source : t.entry.targets[0] ?? "";
      const ok = !target || targetHasTerm(t.entry, target);
      return h("button", { type: "button", className: `cat-chip${ok ? "" : " missing"}`, title: `${ok ? "" : "Not used in the translation. "}Click to insert${t.entry.note ? ` — ${t.entry.note}` : ""}`, onclick: () => parts.insertAtCaret(want) },
        h("span", { className: "cat-chip-en" }, t.entry.source), "→", h("span", { lang: p.lang }, t.entry.dnt ? `${t.entry.source} (kept)` : t.entry.targets.join(" / ")));
    }) : h("span", { className: "cat-none" }, p.acceptedTerms.length ? "No glossary terms in this string." : "The glossary is empty — build it on the Glossary tab."));

    // Matches
    if (seg.technical) { fill(parts.matchesBox, h("span", { className: "cat-none" }, "Not prose: nothing to match.")); return; }
    const found = p.tm().match(seg.source, { exclude: seg.id });
    fill(parts.matchesBox, found.length ? found.map((m, n) => {
      const pct = Math.round(m.score * 100);
      const corpus = p.corpora.find((c) => c.def.id === m.unit.corpus);
      return h("div", { className: "cat-match", title: "Click to use this translation", onclick: () => parts.replaceWith(m.unit.target) },
        h("span", { className: `cat-score${m.score < 1 ? " fuzzy" : ""}` }, `${pct}%`, n < 9 ? h("kbd", {}, `Ctrl+${n + 1}`) : null),
        h("div", { className: "cat-m-src" }, diffView(m.ops)),
        h("div", { className: "cat-m-tgt", lang: p.lang }, m.unit.target),
        h("div", { className: "cat-m-key" }, `${corpus?.def.name ?? m.unit.corpus} · ${m.unit.key}`));
    }) : h("span", { className: "cat-none" }, "Nothing similar has been translated."));
    parts.matches = found;
  }

  function relatedLinks(related) {
    return h("span", { className: "dim" }, " — ", related.slice(0, 6).flatMap((s, i) => [
      i ? ", " : "", h("button", { type: "button", className: "cat-link", onclick: () => select(s.id) }, s.key)]),
    related.length > 6 ? ` and ${related.length - 6} more` : "");
  }

  function drawConcordance(needle, out) {
    const p = P();
    const units = p.segments.filter((s) => !s.technical).map((s) => ({ id: s.id, key: s.key, source: s.source, target: p.target(s) }));
    const found = concordance(units, needle, { limit: 100 });
    fill(out, needle.trim() ? (found.length ? found.map((u) => h("div", { className: "cat-conc-row", title: u.key, onclick: () => select(u.id) },
      h("div", {}, hitView(u.source, needle)),
      h("div", { lang: p.lang }, u.target ? hitView(u.target, needle) : h("span", { className: "dim" }, "untranslated")))) : h("span", { className: "cat-none" }, "Nowhere.")) : null);
  }

  function confirm() {
    if (!editorFor || !textarea) return;
    const p = P();
    const seg = editorFor;
    if (textarea.value !== p.target(seg)) p.setTarget(seg, textarea.value);
    if (!textarea.value) { ctx.changed(); advance(); return; } // nothing to confirm: just move on
    p.confirm(seg);
    ctx.changed();
    advance();
  }

  // ── refreshing ──

  /** Everything again: filters, list, editor (keeps the caret if it is the same string). */
  function refresh() {
    recompute();
    drawList(true);
    const seg = ui.selected ? P().byId.get(ui.selected) : null;
    if (seg && seg === editorFor && textarea) {
      // Same string: leave the textarea alone (the caret, an IME), redraw the rest.
      if (document.activeElement !== textarea && textarea.value !== P().target(seg)) textarea.value = P().target(seg);
      drawDerived(seg, editorEl._derived);
    } else {
      buildEditor(seg);
    }
  }

  /** While typing: only the rows in sight, and the editor's derived parts. */
  function refreshLight() {
    drawList(true);
    if (editorFor && editorEl._derived) drawDerived(editorFor, editorEl._derived);
  }

  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Enter") { e.preventDefault(); confirm(); return true; }
    if ((e.altKey && !mod) && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1); return true; }
    if (mod && e.shiftKey && (e.key === "S" || e.key === "s")) { e.preventDefault(); if (editorFor) editorEl._derived?.replaceWith(editorFor.source); return true; }
    if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const m = editorEl._derived?.matches?.[Number(e.key) - 1];
      if (m) { e.preventDefault(); editorEl._derived.replaceWith(m.unit.target); return true; }
    }
    if (mod && (e.key === "f" || e.key === "F") && !e.shiftKey) { e.preventDefault(); searchEl.focus(); searchEl.select(); return true; }
    return false;
  }

  // Pre-translation: an untranslated string whose English (exactly, case
  // and all) is translated elsewhere, one way only, gets that translation as
  // a draft. More than one way is a choice for the translator, not for this.
  document.getElementById("fillBtn").addEventListener("click", async () => {
    const p = P();
    const plan = [];
    for (const seg of p.segments) {
      if (seg.technical || p.target(seg)) continue;
      const targets = new Set(p.tm().exactly(seg.source).filter((u) => u.source === seg.source).map((u) => u.target));
      if (targets.size === 1) plan.push([seg, [...targets][0]]);
    }
    if (!plan.length) {
      await showNotice({ title: "Nothing to fill", body: "No untranslated string has English that is translated, one way only, somewhere else." });
      return;
    }
    const ok = await showModal({
      title: `Fill ${plan.length} string(s) from memory?`,
      body: "Each gets the translation its English has elsewhere, as an unsaved draft — they are listed under Edited to look over before saving.",
      okLabel: "Fill",
    });
    if (!ok) return;
    for (const [seg, t] of plan) p.setTarget(seg, t);
    ui.status = "edited";
    ctx.saveUi();
    ctx.changed();
  });

  let searchTimer = 0;
  searchEl.value = ui.search;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.search = searchEl.value; ctx.saveUi(); listEl.scrollTop = 0; refresh(); }, 150);
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); if (rows.length) select(rows.find((s) => s.id === ui.selected) ? ui.selected : rows[0].id, { focusEditor: false }); listEl.focus(); }
  });

  return {
    refresh,
    refreshLight,
    select,
    onKey,
    /** Show only these segments (from the glossary or the issues view). */
    showOnly(ids, label) {
      ui.only = new Set(ids);
      ui.onlyLabel = label;
      ui.status = "all";
      listEl.scrollTop = 0;
      refresh();
      if (ids.length) select(ids[0]);
    },
    get rows() { return rows; },
    statusText,
  };

  function statusText() {
    const seg = editorFor;
    return seg ? `${P().corpusOf(seg).def.name} · ${seg.key}` : "";
  }
}
