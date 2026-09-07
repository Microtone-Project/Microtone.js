// Welcome screen (item 104) — what the Timeline tab shows before a project is
// loaded, in place of the one-line "drop a file here" empty state.
//
// Five panels:
//   Start           new project / open / import MIDI, plus the drop hint and
//                   the documentation links.
//   Recent projects the OPFS listing, most recently touched first. "Touched"
//                   is max(file mtime, last opened) — opening a project does
//                   not rewrite it, so the mtime alone would keep a file you
//                   worked on all afternoon below one you saved last week.
//   Demo songs      the bundled projects (item 163), listed from
//                   assets/demo_projects/demos.json. The one panel here that
//                   has something to show on a first run, which is why it sits
//                   above the fold rather than inside the File tab alone.
//   What's new      the newest dated section of assets/PATCH_NOTES.md, read
//                   live so it can never drift from the changelog: its own
//                   HEADLINE (the paragraph a group opens with) and then the
//                   first few of that group's bullets as the detail under it
//                   — or, when the batch touched several unrelated things and
//                   the section carries several headlines, just those
//                   headlines, since the four-item budget cannot also show
//                   any one group's detail without misrepresenting the rest.
//   Support         the banner that retired the topbar's Donate/Sponsor
//                   buttons (item 104.3; the About popup keeps its own links).
//
// Everything here is DOM — the canvas grids stay hidden while it is up.

import * as opfs from "../../storage/opfs.js";
import { renderMarkdown, firstSection, sectionHeadlines, topLevelBullets } from "../markdown.js";
import { fillDemos } from "../demos.js";
import { t, currentLang, onLangChange } from "../i18n.js";
import { setIconLabel } from "../icons.js";

const RECENT_MAX = 6;     // rows in the Recent panel
const NEWS_BULLETS = 4;   // headline items in the What's new panel
const MRU_MAX = 24;       // remembered open times (names, not content)
const MRU_KEY = "microtone-recent";
// Module-relative, so the panel finds the changelog wherever the app is served
// from (src/ui/views/ → the deploy root).
const NEWS_URL = new URL("../../../assets/PATCH_NOTES.md", import.meta.url);

export class WelcomeView {
  /**
   * @param host container element (#welcomeHost)
   * @param callbacks { newProject(), open(), importMidi(), openRecent(name),
   *                    browseFiles(), help(), openDemo(entry) }
   */
  constructor(store, host, callbacks = {}) {
    this.store = store;
    this.host = host;
    this.cb = callbacks;
    this.visible = false;
    this._newsMd = null; // in-flight/settled fetch of PATCH_NOTES.md
    this._token = 0;     // guards the async panels against a re-entrant refresh
    this.root = document.createElement("div");
    this.root.className = "welcome-view";
    host.appendChild(this.root);
    // A save rewrites the file the Recent list is sorting on, so the list is
    // stale the moment one lands — and it is also the strongest "recent" signal
    // there is.
    store.on("saved", (name) => {
      this.noteOpened(name);
      if (this.visible) this.refresh();
    });
    onLangChange(() => { if (this.visible) this.refresh(); });
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  /** Record that `name` was opened now — the Recent panel's other sort key. */
  noteOpened(name) {
    if (!name) return;
    const mru = readMru();
    mru[name] = Date.now();
    const kept = Object.entries(mru).sort((a, b) => b[1] - a[1]).slice(0, MRU_MAX);
    writeMru(Object.fromEntries(kept));
  }

  refresh() {
    const token = ++this._token;
    const grid = document.createElement("div");
    grid.className = "wc-grid";
    grid.append(this.startPanel(), this.recentPanel(), this.demoPanel(),
                this.newsPanel(), this.banner());
    const inner = document.createElement("div");
    inner.className = "wc-inner";
    inner.append(this.hero(), grid);
    this.root.replaceChildren(inner);
    this.fillRecent(token);
    this.fillDemos(token);
    this.fillNews(token);
  }

  // ── hero ──

  hero() {
    const el = document.createElement("header");
    el.className = "wc-hero";
    const brand = document.createElement("div");
    brand.className = "wc-brand";
    brand.innerHTML = '<span class="brand brand-red">Micro</span>' +
                      '<span class="brand brand-white">tone</span>' +
                      '<span class="brand brand-tm"></span>';
    const tag = document.createElement("p");
    tag.className = "wc-tagline";
    tag.textContent = t("welcome.tagline");
    el.append(brand, tag);
    return el;
  }

  // ── Start ──

  startPanel() {
    const p = panel("wc-start", t("welcome.start"));
    p.append(
      action("filePlus", t("welcome.new"), () => this.cb.newProject?.(), true),
      action("folder", t("welcome.open"), () => this.cb.open?.()),
      action("music", t("welcome.importMidi"), () => this.cb.importMidi?.()),
    );
    const drop = document.createElement("p");
    drop.className = "wc-drop";
    drop.textContent = t("welcome.drop");
    p.appendChild(drop);

    const links = document.createElement("p");
    links.className = "wc-links";
    const docs = document.createElement("a");
    docs.href = "docs.html";
    docs.target = "_blank";
    docs.rel = "noopener";
    setIconLabel(docs, "book", t("welcome.docs"));
    const keys = linkButton(t("welcome.shortcuts"), () => this.cb.help?.());
    const gh = document.createElement("a");
    gh.href = "https://github.com/curioustorvald/Microtone.js";
    gh.target = "_blank";
    gh.rel = "noopener";
    gh.textContent = "GitHub";
    links.append(docs, dot(), keys, dot(), gh);
    p.appendChild(links);
    return p;
  }

  // ── Recent projects ──

  recentPanel() {
    const p = panel("wc-recent", t("welcome.recent"));
    this.recentBody = document.createElement("div");
    this.recentBody.className = "wc-recent-body";
    this.recentBody.appendChild(note(t("welcome.loading")));
    p.appendChild(this.recentBody);
    const all = linkButton(t("welcome.allProjects"), () => this.cb.browseFiles?.());
    all.classList.add("wc-more");
    p.appendChild(all);
    return p;
  }

  async fillRecent(token) {
    const ok = await opfs.available();
    let rows = [];
    if (ok) {
      const mru = readMru();
      rows = (await opfs.list())
        .map((e) => ({ ...e, when: Math.max(e.mtime, mru[e.name] ?? 0) }))
        .sort((a, b) => b.when - a.when)
        .slice(0, RECENT_MAX);
    }
    if (token !== this._token) return; // a newer refresh owns the panel now
    const body = this.recentBody;
    body.replaceChildren();
    if (!ok) { body.appendChild(note(t("welcome.recentUnavailable"), "wc-warn")); return; }
    if (rows.length === 0) { body.appendChild(note(t("welcome.recentNone"))); return; }
    for (const e of rows) {
      const b = document.createElement("button");
      b.className = "wc-file";
      b.title = e.name;
      const name = document.createElement("span");
      name.className = "wc-file-name";
      name.textContent = e.name.replace(/\.taud$/, "");
      const when = document.createElement("span");
      when.className = "wc-file-meta";
      when.textContent = relTime(e.when);
      const size = document.createElement("span");
      size.className = "wc-file-meta wc-file-size";
      size.textContent = `${(e.size / 1024).toFixed(0)} K`;
      b.append(name, when, size);
      b.addEventListener("click", () => this.cb.openRecent?.(e.name));
      body.appendChild(b);
    }
  }

  // ── Demo songs ──

  demoPanel() {
    const p = panel("wc-demos", t("welcome.demos"));
    this.demoBody = document.createElement("div");
    this.demoBody.className = "wc-demo-body";
    this.demoBody.appendChild(note(t("welcome.loading")));
    p.appendChild(this.demoBody);
    return p;
  }

  /** The manifest fetch is shared with the File tab's picker — see demos.js. */
  fillDemos(token) {
    return fillDemos(this.demoBody, (entry) => this.cb.openDemo?.(entry),
      () => token === this._token);
  }

  // ── What's new ──

  newsPanel() {
    const p = panel("wc-news", t("welcome.news"));
    this.newsDate = document.createElement("span");
    this.newsDate.className = "wc-date";
    p.querySelector("h2").appendChild(this.newsDate);
    this.newsBody = document.createElement("div");
    this.newsBody.className = "wc-news-body";
    this.newsBody.appendChild(note(t("welcome.loading")));
    p.appendChild(this.newsBody);
    const all = document.createElement("a");
    all.className = "wc-more";
    all.href = "docs.html#patchnotes";
    all.target = "_blank";
    all.rel = "noopener";
    all.textContent = t("welcome.newsAll");
    p.appendChild(all);
    return p;
  }

  async fillNews(token) {
    let md = null;
    try {
      md = await this.newsMd();
    } catch (err) {
      console.warn(`WELCOME: patch notes unavailable (${err.message})`);
    }
    if (token !== this._token) return;
    const section = md ? firstSection(md) : null;
    if (!section) {
      this.newsBody.replaceChildren(note(t("welcome.newsFail"), "wc-warn"));
      return;
    }
    this.newsDate.textContent = section.title;
    // The section's own headline(s) — one per bullet-list group it carries.
    // A batch that touches several unrelated things gets several groups
    // (CLAUDE.md's patch-notes rules), newest first; sections written before
    // 2026-09-03 are bare bullet lists and yield none at all, and the panel
    // is then exactly what it always was.
    const heads = sectionHeadlines(section.body);
    let lead = "";
    let bullets;
    if (heads.length >= 2) {
      // Several changes, one four-item budget: descending into any ONE
      // group's bullets would misrepresent the batch as a single change, so
      // the panel shows the headlines themselves instead of any detail.
      bullets = heads.slice(0, NEWS_BULLETS);
    } else {
      // One bullet gives way to the headline, so the panel keeps its height.
      lead = heads[0] ?? "";
      bullets = topLevelBullets(section.body).slice(0, lead ? NEWS_BULLETS - 1 : NEWS_BULLETS);
    }
    // Local asset, rendered by our own Markdown pass — never user content.
    this.newsBody.innerHTML = renderMarkdown(
      [...(lead ? [lead, ""] : []), ...bullets.map((b) => `- ${b}`)].join("\n"));
    const leadEl = lead ? this.newsBody.querySelector("p") : null;
    if (leadEl) leadEl.className = "wc-lead";
    const list = this.newsBody.querySelector("ul");
    if (!list) return;
    list.classList.add("wc-news-list");
    // Each item is clamped to a couple of lines (patch-notes entries run long,
    // and this panel is a teaser). The clamp needs `display: -webkit-box`,
    // which would take the marker off the <li> — so it goes on a wrapper and
    // the item stays a list item.
    for (const li of list.children) {
      const clamp = document.createElement("span");
      clamp.className = "wc-clamp";
      clamp.append(...li.childNodes);
      li.appendChild(clamp);
    }
  }

  /** PATCH_NOTES.md, fetched once per session (a failed fetch may retry). */
  newsMd() {
    if (!this._newsMd) {
      this._newsMd = fetch(NEWS_URL)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .catch((err) => { this._newsMd = null; throw err; });
    }
    return this._newsMd;
  }

  // ── Support banner ──

  banner() {
    const el = document.createElement("aside");
    el.className = "wc-banner";
    const head = document.createElement("b");
    head.textContent = t("welcome.supportHead");
    const body = document.createElement("p");
    body.append(head, document.createTextNode(` ${t("welcome.support")}`));
    el.append(body,
      supportLink("https://ko-fi.com/curioustorvald", "donate", "coffee",
        t("welcome.kofi"), t("topbar.donateTitle")),
      supportLink("https://github.com/sponsors/curioustorvald", "sponsor", "heart",
        t("welcome.sponsor"), t("topbar.sponsorTitle")));
    return el;
  }
}

// ── DOM helpers ──

function panel(cls, title) {
  const s = document.createElement("section");
  s.className = `wc-panel ${cls}`;
  const h = document.createElement("h2");
  h.textContent = title;
  s.appendChild(h);
  return s;
}

/** A Start row: icon, label, and the accent treatment for the primary one. */
function action(iconName, label, onClick, primary = false) {
  const b = document.createElement("button");
  b.className = primary ? "wc-action wc-primary" : "wc-action";
  setIconLabel(b, iconName, label);
  b.addEventListener("click", onClick);
  return b;
}

/** A button that reads as a link (the panels' secondary navigation). */
function linkButton(label, onClick) {
  const b = document.createElement("button");
  b.className = "wc-linkbtn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function supportLink(href, kind, iconName, label, title) {
  const a = document.createElement("a");
  a.className = `support-btn ${kind}`;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = title;
  setIconLabel(a, iconName, label);
  return a;
}

function note(text, cls = "") {
  const p = document.createElement("p");
  p.className = cls ? `wc-note ${cls}` : "wc-note";
  p.textContent = text;
  return p;
}

function dot() {
  const s = document.createElement("span");
  s.className = "wc-sep";
  s.textContent = "·";
  return s;
}

// ── most-recently-opened bookkeeping (names + timestamps only) ──

function readMru() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MRU_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // absent, private mode, or written by an older/other build
  }
}

function writeMru(mru) {
  try { localStorage.setItem(MRU_KEY, JSON.stringify(mru)); } catch { /* private mode */ }
}

/** "3 days ago" in the active language. */
function relTime(ms) {
  const secs = (ms - Date.now()) / 1000;
  const abs = Math.abs(secs);
  const [value, unit] =
    abs < 60 ? [secs, "second"] :
    abs < 3600 ? [secs / 60, "minute"] :
    abs < 86400 ? [secs / 3600, "hour"] :
    abs < 2592000 ? [secs / 86400, "day"] :
    abs < 31536000 ? [secs / 2592000, "month"] : [secs / 31536000, "year"];
  try {
    return new Intl.RelativeTimeFormat(currentLang(), { numeric: "auto" })
      .format(Math.round(value), unit);
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}
