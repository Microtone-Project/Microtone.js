// The translation workbench (microtone.cc/translation): a computer-assisted
// translation tool for Microtone's and Microtone Touch's language tables.
//
//   project.js   the segments, the unsaved changes, the files a save writes
//   langfile.js  reading and rewriting a table's text, comments kept
//   tm.js        the translation memory (fuzzy matches, concordance)
//   glossary.js  term extraction, alignment, term lookup
//   checks.js    what a translation can get wrong that a program can see
//   strings.js / glossaryview.js / issuesview.js   the three tabs
//   save.js      writing the files (tools/cat-server.py) or archiving them
//   guide.js     how to get started (Help; opens by itself on a new language)
//
// The theme follows the app's (shared `microtone-theme`, the same cycle and
// default, as docs.js does). The workbench's own words are English: it is a
// tool for people who read the English they translate.

import { applyIcons } from "../ui/icons.js";
import { warmthInSeason } from "../ui/warmth.js";
import { showModal, showNotice } from "../ui/components/modal.js";
import { actionRow } from "../ui/components/actions.js";
import { loadProject, browserStorage } from "./project.js";
import { LANGUAGES, LANG_CODE } from "./corpora.js";
import { createStrings } from "./strings.js";
import { createGlossaryView } from "./glossaryview.js";
import { createIssuesView } from "./issuesview.js";
import { canWrite, writeFiles, zipBlob, tarGzBlob, download } from "./save.js";
import { showGuide, isFresh, guided, markGuided } from "./guide.js";
import { h, fill, showText } from "./dom.js";

// ── theme (mirror src/ui/theme.js, standalone — as docs.js) ──
const THEMES = ["dark", "dim", "light"];
const DEFAULT_THEME = "dim";
const WARMTH = "warmth";
const roster = () => (warmthInSeason() ? [...THEMES, WARMTH] : THEMES);
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  if (!THEMES.includes(name)) return;
  try { localStorage.setItem("microtone-theme", name); } catch { /* private mode */ }
}
function initTheme() {
  const asked = new URLSearchParams(location.search).get("theme");
  if (warmthInSeason() || asked === WARMTH) { applyTheme(WARMTH); return; }
  if (THEMES.includes(asked)) { applyTheme(asked); return; }
  let saved = null;
  try { saved = localStorage.getItem("microtone-theme"); } catch { /* private mode */ }
  applyTheme(THEMES.includes(saved) ? saved : DEFAULT_THEME);
}
function cycleTheme() {
  const list = roster();
  const i = list.indexOf(document.documentElement.dataset.theme);
  applyTheme(list[(i + 1) % list.length]);
}

// ── the viewer's own settings ──
const UI_KEY = "microtone-cat:ui";
const LANGS_KEY = "microtone-cat:langs";
const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};
const writeJson = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode: this session only */ }
};

const ui = {
  lang: "ko", view: "segments", status: "todo", corpus: "all", search: "", selected: null,
  glossFilter: "proposed", glossSearch: "", issueCheck: "all", showDismissed: false,
  ...readJson(UI_KEY, {}),
  only: null, onlyLabel: "",
};
const saveUi = () => {
  const { only, onlyLabel, ...keep } = ui;
  writeJson(UI_KEY, keep);
};
const languages = () => ({ ...readJson(LANGS_KEY, {}), ...LANGUAGES });
// A language started here keeps the name it was given.
for (const [code, name] of Object.entries(readJson(LANGS_KEY, {}))) LANGUAGES[code] ??= name;

async function fetchText(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// ── the shared context the views talk through ──
const ctx = {
  project: null,
  ui,
  saveUi,
  _version: 0,
  _memo: new Map(),
  version() { return this._version; },
  memo(name, fn) {
    const hit = this._memo.get(name);
    if (hit && hit.v === this._version) return hit.value;
    const value = fn();
    this._memo.set(name, { v: this._version, value });
    return value;
  },
  changed({ soon = false } = {}) {
    this._version++;
    drawChrome();
    clearTimeout(this._timer);
    if (soon) {
      this._timer = setTimeout(() => { strings.refreshLight(); drawTabs(); renderOtherView(); }, 300);
    } else {
      strings.refresh();
      drawTabs();
      renderOtherView();
    }
  },
  showStrings(ids, label, { keepList = false } = {}) {
    showView("segments");
    if (keepList && ids.length === 1) {
      if (!strings.rows.some((s) => s.id === ids[0])) { ui.status = "all"; ui.search = ""; document.getElementById("search").value = ""; ui.only = null; strings.refresh(); }
      strings.select(ids[0]);
    } else {
      strings.showOnly(ids, label);
    }
  },
};

const strings = createStrings(ctx);
const glossaryView = createGlossaryView(ctx);
const issuesView = createIssuesView(ctx);

// ── chrome: tabs, progress, the Save button ──
const tabs = document.getElementById("tabs");
function showView(name) {
  ui.view = name;
  saveUi();
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("active", b.dataset.view === name);
  for (const v of ["segments", "glossary", "issues"]) document.getElementById(`view-${v}`).hidden = v !== name;
  if (name === "glossary") glossaryView.render();
  if (name === "issues") issuesView.render();
  if (name === "segments") strings.refresh();
}
tabs.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) showView(b.dataset.view);
});
function renderOtherView() {
  if (ui.view === "glossary") glossaryView.render();
  else if (ui.view === "issues") issuesView.render();
}

function tabLabel(view, label, n) {
  const b = tabs.querySelector(`button[data-view="${view}"]`);
  const text = n ? `${label} ${n}` : label;
  if (b.dataset.text === text) return;
  b.dataset.text = text;
  fill(b, label, n ? h("span", { className: "cat-count" }, String(n)) : null);
}
function drawTabs() {
  const p = ctx.project;
  const c = p.counts();
  tabLabel("segments", "Strings", c.untranslated + c.stale);
  tabLabel("glossary", "Glossary", p.acceptedTerms.length);
  tabLabel("issues", "Issues", p.issues().length);
}

const saveBtn = document.getElementById("saveBtn");
function drawChrome() {
  const p = ctx.project;
  const c = p.counts();
  const done = c.translated + c.stale;
  document.getElementById("progressFill").style.width = `${c.total ? (100 * c.translated) / c.total : 0}%`;
  showText(document.getElementById("progressText"),
    `${done}/${c.total} translated${c.stale ? ` · ${c.stale} stale` : ""}${c.untranslated ? ` · ${c.untranslated} to go` : ""}`);
  const n = p.unsaved();
  const label = n ? `Save… ${n}` : "Save…";
  if (saveBtn.dataset.text !== label) {
    saveBtn.dataset.text = label;
    saveBtn.replaceChildren("Save…");
    if (n) saveBtn.append(h("span", { className: "cat-count", title: "unsaved changes" }, String(n)));
    applyIcons(saveBtn.parentElement);
  }
  showText(document.getElementById("status"), strings.statusText());
}

// ── languages ──
const langSel = document.getElementById("langSel");
function drawLangs() {
  const langs = languages();
  fill(langSel,
    Object.entries(langs).map(([code, name]) => h("option", { value: code, selected: code === ui.lang }, `${name} (${code})`)),
    h("option", { value: "+new" }, "New language…"));
  langSel.value = ui.lang;
}
langSel.addEventListener("change", async () => {
  if (langSel.value !== "+new") { await open(langSel.value); return; }
  langSel.value = ui.lang;
  const v = await showModal({
    title: "Translate into a new language",
    body: "The workbench starts it from nothing; saving writes a new table for each app. The apps offer it once its code is registered in their LANGS.",
    fields: [
      { name: "code", label: "Code", placeholder: "ja, pt-BR …", hint: "As BCP 47 writes it: a language, and a region or script after a hyphen when it needs one." },
      { name: "name", label: "Its own name", placeholder: "日本語, Português …" },
    ],
    okLabel: "Start",
  });
  if (!v) return;
  const code = v.code.trim();
  if (!LANG_CODE.test(code) || code === "en") {
    await showNotice({ title: "That is not a language code", body: `“${code}” is not a BCP 47 language code (ko, ja, pt-BR), or it is English, which is the source.` });
    return;
  }
  const custom = readJson(LANGS_KEY, {});
  if (!languages()[code]) custom[code] = v.name.trim() || code;
  writeJson(LANGS_KEY, custom);
  LANGUAGES[code] ??= custom[code] ?? code;
  await open(code);
});

/** The target language's own face, as the app loads it (its table's `css.font`). */
function applyLangFont(p) {
  const css = p.segments.find((s) => s.key === "css.font" && s.corpus === "tracker")?.base ?? "";
  let style = document.getElementById("lang-font-css");
  if (!css) { style?.remove(); return; }
  if (!style) { style = h("style", { id: "lang-font-css" }); document.head.append(style); }
  showText(style, css);
}

async function open(lang) {
  showText(document.getElementById("status"), `Loading ${languages()[lang] ?? lang}…`);
  let project;
  try {
    project = await loadProject({ lang, fetchText, storage: browserStorage(lang) });
  } catch (err) {
    await showNotice({ title: "The language tables could not be loaded", body: err.message });
    return;
  }
  ui.lang = lang;
  ui.only = null;
  saveUi();
  ctx.project = project;
  ctx._version++;
  glossaryView.reset();
  drawLangs();
  applyLangFont(project);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && project.byId.has(fromHash)) { ui.selected = fromHash; ui.status = "all"; }
  if (!project.byId.has(ui.selected)) ui.selected = null;
  drawChrome();
  drawTabs();
  showView(ui.view);
  if (!ui.selected && strings.rows.length) strings.select(strings.rows[0].id, { focusEditor: false });
  else if (ui.selected) strings.select(ui.selected, { focusEditor: false });
  if (isFresh(project) && !guided(lang)) {
    markGuided(lang);
    await guide();
  }
}

// ── the getting-started guide ──
async function guide() {
  if (!ctx.project) return;
  if (!(await showGuide({ langName: ctx.project.langName }))) return;
  ui.glossFilter = "proposed";
  showView("glossary");
}
document.getElementById("helpBtn").addEventListener("click", guide);

// ── saving ──
function describe(file, p) {
  if (!file.corpus) return "the glossary, and what each translation was checked against";
  let changed = 0, added = 0, removed = 0;
  for (const s of p.segments) {
    if (s.corpus !== file.corpus) continue;
    const t = p.target(s);
    if (t === s.base) continue;
    if (!s.base) added++; else if (!t) removed++; else changed++;
  }
  const parts = [];
  if (file.created) parts.push("a new table");
  if (added) parts.push(`${added} new`);
  if (changed) parts.push(`${changed} changed`);
  if (removed) parts.push(`${removed} taken out (back to English)`);
  if (file.dropped?.length) parts.push(`${file.dropped.length} key(s) English no longer has dropped`);
  return parts.join(", ") || "layout only";
}

async function save() {
  const p = ctx.project;
  const files = p.files();
  if (!files.length) {
    const n = p.unsaved();
    if (n) p.discardLocal(); // every change already matches the files
    await showNotice({ title: "Nothing to save", body: "The files already say everything the workbench knows." });
    ctx.changed();
    return;
  }
  const writable = await canWrite();
  const zipName = `microtone-translation-${p.lang}.zip`;
  const tarName = `microtone-translation-${p.lang}.tar.gz`;
  const dlg = h("dialog", { className: "modal modal-text cat-dialog-wide" });
  const created = files.filter((f) => f.created);
  const statusLine = h("span", { className: "dim" });
  const { row, cancel, proceed, alternatives: [discard, tarGz] } = actionRow({
    cancel: true,
    extras: [statusLine],
    alternatives: [
      { label: "Discard changes…", title: "Forget every change made here since the last save" },
      writable ? null : { label: "Download .tar.gz", icon: "download" },
    ],
    proceed: writable ? "Write files" : { label: "Download .zip", icon: "download" },
  });
  fill(dlg,
    h("h3", {}, `Save the ${p.langName} translation`),
    h("p", { className: "dim" }, writable
      ? "These files in the repository are rewritten in place:"
      : "These files, at their places in the repository, go into one .zip or .tar.gz:"),
    h("ul", { className: "cat-files" }, files.map((f) => h("li", {}, h("code", {}, f.path), h("span", { className: "dim" }, ` — ${describe(f, p)}`)))),
    writable ? null : h("p", { className: "dim" }, "Unpack it at the root of the repository, over what is there:"),
    writable ? null : h("pre", { className: "cat-cmd" }, `unzip -o ${zipName}\ntar -xzf ${tarName}`),
    created.length ? h("p", { className: "dim" }, `A new language: to offer it, register “${p.lang}” in ${created.map((f) => p.corpora.find((c) => c.def.id === f.corpus).def.register).join(", and in ")}.`) : null,
    row);
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", close);
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  cancel.addEventListener("click", close);
  discard.addEventListener("click", async () => {
    close();
    const ok = await showModal({ title: `Discard ${p.unsaved()} unsaved change(s)?`, body: "Drafts, confirmations, dismissals and glossary edits made since the last save are forgotten. The files are not touched.", okLabel: "Discard" });
    if (ok) { p.discardLocal(); ctx.changed(); }
  });
  const handOver = (blob, name) => {
    download(blob, name);
    close();
    showText(document.getElementById("status"), `Downloaded ${name} — your changes stay here until the files say the same.`);
  };
  tarGz?.addEventListener("click", () => handOver(tarGzBlob(files), tarName));
  proceed.addEventListener("click", async () => {
    if (!writable) {
      handOver(zipBlob(files), zipName);
      return;
    }
    proceed.disabled = true;
    statusLine.textContent = "Writing…";
    try {
      await writeFiles(files);
      p.markSaved(files);
      close();
      ctx.changed();
      showText(document.getElementById("status"), `Saved ${files.length} file(s).`);
    } catch (err) {
      proceed.disabled = false;
      statusLine.textContent = `Not saved: ${err.message}`;
    }
  });
  dlg.showModal();
  proceed.focus();
}
saveBtn.addEventListener("click", save);

// ── keys ──
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); save(); return; }
  if (ui.view === "segments") strings.onKey(e);
});

document.getElementById("themeBtn").addEventListener("click", cycleTheme);
initTheme();
applyIcons(document);
drawLangs();
open(languages()[ui.lang] ? ui.lang : "ko");
