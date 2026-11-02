// Documentation viewer controller (docs.html) — item 30. A standalone page in
// the app's design language: a left TOC (document switcher + the current
// document's headings) and centred content (max-width 960px). The theme
// matches the main app — shared `microtone-theme` localStorage + data-theme,
// the same three-way cycle and the same default.
//
// The documents are listed in src/ui/doclist.js (DOCS): the User Manual, the
// Note Effects reference, the three Taud reference specifications (item 997 —
// the canonical texts, mirrored into the TSVM tree), the Microtone Touch
// sketch format (item 206), the Motif language and the Patch Notes (item 95).
// Each is fetched from assets/ and rendered live. Below them the TOC links out
// to the design system's docs page.
//
// The same script runs a PRE-RENDERED page (item 281): the website's build
// writes each document as a page of its own at docs/<id>/ (tools/docs-pages.js),
// its contents list and text already in place, marked by `data-doc` on
// #content. There the script only does what a page cannot do without it — the
// theme, the drawer, the icons — and the documents are ordinary links. The
// document list and the contents list's markup are src/ui/doclist.js, shared
// with that build.
//
// On a phone (docs.html's 720px media query) the TOC is a drawer: the ☰
// button in the top bar slides it over the page, and picking a heading, the
// scrim or Escape puts it away. Switching documents leaves it open, so the new
// document's headings are right there to pick from.

import { renderMarkdown, extractToc } from "./markdown.js";
import { DOCS, DEFAULT_DOC, docById, docTarget, docNavHtml, headingsHtml } from "./doclist.js";
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

async function loadDoc(doc) {
  const resp = await fetch(`assets/${doc.file}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// A link from one document to another (`TAUD_FILE_FORMAT.md#tuning`,
// `docs.html#motif`, `#effects`) switches documents in place, by hash.
function linkInViewer(url) {
  const to = docTarget(url);
  if (!to) return null;
  return { href: `#${to.id}${to.slug ? `/${to.slug}` : ""}`, newTab: false };
}

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

// The documents are links to their own hashes: picking one is a hash change,
// which the hashchange handler below turns into selectDoc().
const docList = (activeId) => docNavHtml(activeId, (id) => `#${id}`);

async function selectDoc(id, anchor) {
  const doc = docById(id) ?? DOCS[0];
  currentId = doc.id;
  contentEl.innerHTML = `<p class="docs-loading">Loading…</p>`;
  let md;
  try {
    md = await loadDoc(doc);
  } catch (err) {
    contentEl.innerHTML = `<p class="docs-error">Could not load this document (${err.message}).</p>`;
    tocEl.innerHTML = docList(doc.id);
    return;
  }
  if (currentId !== doc.id) return; // another document was picked meanwhile
  contentEl.innerHTML = renderMarkdown(md, { link: linkInViewer });
  contentEl.scrollTop = 0;
  // TOC = document switcher + this document's h2/h3 headings
  tocEl.innerHTML = docList(doc.id) + headingsHtml(extractToc(md));
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

function fromHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!h) return { id: DEFAULT_DOC, anchor: null };
  const [id, anchor] = h.split("/");
  // A bare heading slug (an in-content anchor link) stays within the current
  // document; at boot (no current doc yet) it deep-links into the manual.
  return docById(id)
    ? { id, anchor }
    : { id: currentId ?? DEFAULT_DOC, anchor: h };
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
if (contentEl.dataset.doc) {
  // Pre-rendered: the page is already this document. Its headings are plain
  // `#slug` links the browser follows; picking one puts the drawer away.
  for (const a of tocEl.querySelectorAll("a[data-slug]")) {
    a.addEventListener("click", () => setTocOpen(false));
  }
} else {
  const start = fromHash();
  selectDoc(start.id, start.anchor);
  window.addEventListener("hashchange", () => {
    const { id, anchor } = fromHash();
    if (id !== currentId) selectDoc(id, anchor);
    else if (anchor) scrollToSlug(anchor);
  });
}
