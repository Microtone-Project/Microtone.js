// Documentation viewer controller (docs.html) — item 30. A standalone page in
// the app's design language: a left TOC (document switcher + the current
// document's headings) and centred content (max-width 960px). The theme
// matches the main app — shared `microtone-theme` localStorage + data-theme,
// the same three-way cycle and the same default.
//
// Seven documents, all fetched from assets/ and rendered live: the User Manual
// (USER_MANUAL.md), the Note Effects reference (TAUD_NOTE_EFFECTS.md), the
// three Taud reference specifications (item 997 — TAUD_ENGINE_SPEC.md,
// TAUD_FILE_FORMAT.md, TAUD_CONVERSION_NOTES.md; these are the canonical texts,
// mirrored into the TSVM tree which points at them instead of carrying its own
// copy), the Microtone Touch sketch format (MICROTONE_SKETCH_FORMAT.md — item
// 206; Microtone's own, not mirrored) and the Patch Notes (PATCH_NOTES.md —
// item 95; kept up to date as TODO items land, see CLAUDE.md "Patch notes").
//
// On a phone (docs.html's 720px media query) the TOC is a drawer: the ☰
// button in the top bar slides it over the page, and picking a heading, the
// scrim or Escape puts it away. Switching documents leaves it open, so the new
// document's headings are right there to pick from.

import { renderMarkdown, extractToc } from "./markdown.js";
import { applyIcons } from "./icons.js";
import { warmthInSeason } from "./warmth.js";

// ── theme (mirror src/ui/theme.js, standalone) ──
// The date rule for the Warmth edition is NOT mirrored — it is imported, so the
// app and the docs cannot disagree about what day it is. The rest follows
// theme.js: THEMES is the saved-value whitelist, the roster is what the button
// cycles, and `warmth` is never written down.
const THEMES = ["dark", "dim", "light"]; // cycle order, as in theme.js
const DEFAULT_THEME = "dim";
const WARMTH = "warmth";
const roster = () => (warmthInSeason() ? [...THEMES, WARMTH] : THEMES);
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  if (!THEMES.includes(name)) return;
  try { localStorage.setItem("microtone-theme", name); } catch { /* private mode */ }
}
function initTheme() {
  // ?theme= exists here for the same reason it does in the app: it is the only
  // way to see the Warmth edition out of season, and a demo that yellows the
  // app but not its manual is half a demo.
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

const fetchDoc = (path) => async () => {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
};

const DOCS = [
  { id: "manual", title: "User Manual", load: fetchDoc("assets/USER_MANUAL.md") },
  { id: "effects", title: "Note Effects", load: fetchDoc("assets/TAUD_NOTE_EFFECTS.md") },
  { id: "engine", title: "Engine Spec", load: fetchDoc("assets/TAUD_ENGINE_SPEC.md") },
  { id: "format", title: "File Format", load: fetchDoc("assets/TAUD_FILE_FORMAT.md") },
  { id: "conversion", title: "Conversion Notes", load: fetchDoc("assets/TAUD_CONVERSION_NOTES.md") },
  { id: "sketch", title: "Sketch Format", load: fetchDoc("assets/MICROTONE_SKETCH_FORMAT.md") },
  { id: "patchnotes", title: "Patch Notes", load: fetchDoc("assets/PATCH_NOTES.md") },
];

const tocEl = document.getElementById("toc");
const contentEl = document.getElementById("content");
const tocBtn = document.getElementById("tocBtn");
let currentId = null;

// The drawer's state is just this class; the stylesheet decides whether it
// means anything at the current width.
const tocOpen = () => document.body.classList.contains("toc-open");
function setTocOpen(open) {
  document.body.classList.toggle("toc-open", open);
  tocBtn.setAttribute("aria-expanded", String(open));
}

function docList(activeId) {
  const items = DOCS.map((d) =>
    `<button class="toc-doc${d.id === activeId ? " active" : ""}" data-doc="${d.id}">${d.title}</button>`).join("");
  return `<div class="toc-section">${items}</div>`;
}

async function selectDoc(id, anchor) {
  const doc = DOCS.find((d) => d.id === id) ?? DOCS[0];
  currentId = doc.id;
  contentEl.innerHTML = `<p class="docs-loading">Loading…</p>`;
  let md;
  try {
    md = await doc.load();
  } catch (err) {
    contentEl.innerHTML = `<p class="docs-error">Could not load this document (${err.message}).</p>`;
    tocEl.innerHTML = docList(doc.id);
    wireDocButtons();
    return;
  }
  contentEl.innerHTML = renderMarkdown(md);
  contentEl.scrollTop = 0;
  // TOC = document switcher + this document's h2/h3 headings
  const toc = extractToc(md);
  const links = toc.map((e) =>
    `<a class="toc-h${e.level}" href="#${e.slug}" data-slug="${e.slug}">${escapeText(e.text)}</a>`).join("");
  tocEl.innerHTML = docList(doc.id) +
    (links ? `<div class="toc-section toc-headings">${links}</div>` : "");
  wireDocButtons();
  for (const a of tocEl.querySelectorAll("a[data-slug]")) {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      setTocOpen(false);
      scrollToSlug(a.dataset.slug);
      history.replaceState(null, "", `#${doc.id}/${a.dataset.slug}`);
    });
  }
  document.title = `Microtone — ${doc.title}`;
  if (anchor) scrollToSlug(anchor);
}

function scrollToSlug(s) {
  const el = document.getElementById(s);
  if (el) el.scrollIntoView({ block: "start" });
}

function wireDocButtons() {
  for (const b of tocEl.querySelectorAll(".toc-doc")) {
    b.addEventListener("click", () => {
      if (b.dataset.doc !== currentId) {
        history.replaceState(null, "", `#${b.dataset.doc}`);
        selectDoc(b.dataset.doc);
      }
    });
  }
}

function escapeText(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function fromHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!h) return { id: "manual", anchor: null };
  const [id, anchor] = h.split("/");
  // A bare heading slug (an in-content anchor link) stays within the current
  // document; at boot (no current doc yet) it deep-links into the manual.
  return DOCS.some((d) => d.id === id)
    ? { id, anchor }
    : { id: currentId ?? "manual", anchor: h };
}

// ── boot ──
initTheme();
applyIcons(document); // the theme button's ◐ is a vector now (item 107)
document.getElementById("themeBtn").addEventListener("click", cycleTheme);
tocBtn.addEventListener("click", () => setTocOpen(!tocOpen()));
document.getElementById("tocScrim").addEventListener("click", () => setTocOpen(false));
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || !tocOpen()) return;
  setTocOpen(false);
  tocBtn.focus();
});
const start = fromHash();
selectDoc(start.id, start.anchor);
window.addEventListener("hashchange", () => {
  const { id, anchor } = fromHash();
  if (id !== currentId) selectDoc(id, anchor);
  else if (anchor) scrollToSlug(anchor);
});
