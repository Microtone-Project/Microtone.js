// Files: the sketches kept on this phone and online.
//
// The Files PANEL takes the whole screen in place of the sketch, the two
// lists side by side: one per screen segment on a foldable (touch.css), two
// columns wherever there is room for them, and a tab each on a phone held
// upright. From there a sketch opens, is renamed, copied to the other place
// or deleted, and a new one is started. The Load… SHEET is the same two
// lists cut down to a tap that opens.
//
// Opening anything replaces the sketch in hand, so it asks first when that
// one has unsaved changes (saving.js keepOrDiscard). An online sketch opens
// under its FILE name — the one in the list, which Microtone may have
// renamed — not under the name written inside it.
//
// `ctx` is saving.js's, plus:
//   open(sketch, home) — replace the sketch in hand with a kept one
//   newSketch() — replace it with a new one (asking first, if need be)
//   renamed(name, home) — the sketch in hand's own file was renamed
//   homeGone() — …or deleted: the sketch in hand is kept nowhere now
//   covered(on) — the panel covers the page (on) or has gone (off)

import * as online from "../core/storage/online.js";
import { SketchFormatError } from "../core/sketch/mtsk.js";
import * as library from "./library.js";
import { normaliseSketch, sketchFromFile, sketchToFile } from "./sketch.js";
import {
  keepOrDiscard, offerSignIn, fail, message, onlineName, shownName, esc, showSheet,
} from "./saving.js";
import { t, tHtml, html, plural, currentLang } from "./i18n.js";

/** Dates and sizes are written the way the language showing writes them. */
let formats = null;
function format() {
  if (formats?.lang !== currentLang()) {
    formats = {
      lang: currentLang(),
      date: new Intl.DateTimeFormat(currentLang(), { dateStyle: "medium", timeStyle: "short" }),
      kb: new Intl.NumberFormat(currentLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    };
  }
  return formats;
}
const when = (ms) => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : format().date.format(d);
};
const size = (n) => (n < 1024 ? t("files.bytes", { n }) : t("files.kb", { n: format().kb.format(n / 1024) }));
const place = (where) => t(where === "local" ? "files.local" : "files.online");

const isHome = (home, entry) => !!home && home.where === entry.where && home.id === entry.id;

// ── the two lists ────────────────────────────────────────────────────────────

/** → [{ where, id, name, modified, detail }], the newest first. */
async function localEntries() {
  return (await library.list()).map((m) => ({
    where: "local", id: m.id, name: m.name, modified: m.modified, sections: m.sections,
  }));
}

/** → { st, entries, limit }; `entries` is null when there is no list to
 *  show (no online sketches here, or not signed in). Throws OnlineError
 *  when the listing fails. */
async function onlineEntries() {
  const st = await online.status();
  if (!st.signedIn) return { st, entries: null, limit: 0 };
  const { projects, sketchLimit } = await online.list();
  const entries = projects.filter((p) => online.isSketchName(p.name)).map((p) => ({
    where: "online", id: p.id, name: shownName(p.name), modified: p.modified, size: p.size,
  })).sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return { st, entries, limit: sketchLimit };
}

/** What a row says of a sketch besides its name: how many sections it has
 *  (on this phone) or its size (online). Worked out when it is shown, so it
 *  is in the language showing. */
const detail = (e) => (e.where === "local" ? plural("files.sections", e.sections) : size(e.size));

function rowsHtml(entries, ctx, { more }) {
  const home = ctx.home();
  return entries.map((e, i) => {
    const open = isHome(home, e);
    const meta = esc([when(e.modified), detail(e)].filter(Boolean).join(" · "));
    return `
      <li class="file-row"${open ? ' aria-current="true"' : ""}>
        <button type="button" class="file-open" data-open="${i}">
          <span class="file-name">${esc(e.name)}</span>
          <span class="file-meta">${meta}${open ? ` · <b>${tHtml(ctx.unsaved() ? "files.openUnsaved" : "files.open")}</b>` : ""}</span>
        </button>${more ? `
        <button type="button" class="tbtn file-more" data-more="${i}" aria-label="${tHtml("files.more", { name: e.name })}"><span class="ico ico-more"></span></button>` : ""}
      </li>`;
  }).join("");
}

// ── opening, and what else can be done to a kept sketch ──────────────────────

/** Open a kept sketch in place of the one in hand. */
export function openEntry(ctx, entry) {
  keepOrDiscard(ctx, async () => {
    try {
      if (entry.where === "local") {
        const rec = await library.read(entry.id);
        if (!rec) throw new library.LibraryError("not-found");
        ctx.open({ ...normaliseSketch(rec.sketch), name: rec.name }, { where: "local", id: rec.id });
      } else {
        ctx.toast(t("files.opening", { name: entry.name }));
        const { bytes, etag } = await online.read(entry.id, { size: entry.size });
        const sketch = sketchFromFile(bytes, ctx.bank);
        ctx.open({ ...sketch, name: library.cleanName(entry.name) || sketch.name }, { where: "online", id: entry.id, etag });
      }
    } catch (err) {
      fail(ctx, t("files.notOpened"), err instanceof SketchFormatError
        ? t("files.notSketch")
        : message(err.code ?? "offline"));
    }
  });
}

/** The sheet behind a row's ⋯. `changed()` re-lists. */
function entrySheet(ctx, entry, changed) {
  const open = isHome(ctx.home(), entry);
  const body = showSheet(ctx, `
    <h2>${esc(entry.name)}</h2>
    <p>${esc([place(entry.where), when(entry.modified), detail(entry), open ? t("files.openNow") : ""].filter(Boolean).join(" · "))}</p>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="open">${tHtml("files.openBtn")}</button>
      <button type="button" class="tbtn" data-act="rename">${tHtml("files.rename")}</button>
      <button type="button" class="tbtn" data-act="copy">${tHtml(entry.where === "local" ? "files.copyOnline" : "files.copyLocal")}</button>
      <button type="button" class="tbtn" data-act="delete">${tHtml("files.delete")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.close")}</button>
    </div>`);
  const on = (name, fn) => { body.querySelector(`[data-act="${name}"]`).onclick = fn; };
  on("open", () => openEntry(ctx, entry));
  on("rename", () => renameSheet(ctx, entry, changed));
  on("copy", () => copy(ctx, entry, changed));
  on("delete", () => deleteSheet(ctx, entry, changed));
}

function renameSheet(ctx, entry, changed) {
  const body = showSheet(ctx, `
    <h2>${tHtml("rename.title")}</h2>
    <label>${tHtml("saveAs.name")}<input type="text" name="name" value="${esc(entry.name)}" maxlength="${library.NAME_MAX}" autocomplete="off" enterkeyhint="done"></label>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="rename">${tHtml("rename.rename")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>
    <p class="err" data-err hidden></p>`);
  const input = body.querySelector('[name="name"]');
  const err = body.querySelector("[data-err]");
  const button = body.querySelector('[data-act="rename"]');
  const say = (text) => { err.hidden = false; err.textContent = text; button.disabled = false; };
  button.onclick = async () => {
    const name = library.cleanName(input.value);
    if (!name) return say(t("saveAs.needName"));
    if (name === entry.name) return ctx.sheet.close();
    button.disabled = true;
    try {
      let home = null;
      if (entry.where === "local") {
        await library.rename(entry.id, name);
        home = { where: "local", id: entry.id };
      } else {
        const p = await online.rename(entry.id, onlineName(name));
        home = { where: "online", id: p.id, etag: p.etag ?? ctx.home()?.etag ?? null };
      }
      if (isHome(ctx.home(), entry)) ctx.renamed(name, home);
      ctx.sheet.close();
      changed();
    } catch (e) {
      if (e.code === "exists") {
        return say(t(entry.where === "local" ? "rename.takenLocal" : "rename.takenOnline", { name }));
      }
      say(message(e.code ?? "offline"));
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (!button.disabled) button.click(); }
  });
  input.focus();
  input.select();
}

/** Copy a kept sketch to the other place, under the same name. */
async function copy(ctx, entry, changed) {
  const body = showSheet(ctx, `<h2>${esc(entry.name)}</h2><p>${tHtml("copy.copying")}</p>`);
  try {
    if (entry.where === "local") {
      const st = await online.status();
      if (!st.signedIn) return offerSignIn(ctx, st, { then: () => copy(ctx, entry, changed) });
      const rec = await library.read(entry.id);
      if (!rec) throw new library.LibraryError("not-found");
      const file = onlineName(rec.name);
      const { projects } = await online.list();
      if (projects.some((p) => p.name === file)) {
        return fail(ctx, t("copy.failed"), t("copy.takenOnline", { name: rec.name }));
      }
      await online.create(file, sketchToFile({ ...normaliseSketch(rec.sketch), name: rec.name }, ctx.bank));
      ctx.toast(t("copy.copiedOnline", { name: rec.name }));
    } else {
      const { bytes } = await online.read(entry.id, { size: entry.size });
      const sketch = sketchFromFile(bytes, ctx.bank);
      const name = library.cleanName(entry.name) || sketch.name;
      await library.write({ ...sketch, name });
      ctx.toast(t("copy.copiedLocal", { name }));
    }
    if (body.isConnected && ctx.sheet.open) ctx.sheet.close();
    changed();
  } catch (err) {
    if (err.code === "exists") return fail(ctx, t("copy.failed"), t("copy.takenLocal", { name: entry.name }));
    fail(ctx, t("copy.failed"), err instanceof SketchFormatError
      ? t("files.notSketch")
      : message(err.code ?? "offline"));
  }
}

function deleteSheet(ctx, entry, changed) {
  const open = isHome(ctx.home(), entry);
  const body = showSheet(ctx, `
    <h2>${tHtml("delete.title", { name: entry.name })}</h2>
    <p>${tHtml(entry.where === "local" ? "delete.bodyLocal" : "delete.bodyOnline")}${open ? ` ${tHtml("delete.stillOpen")}` : ""}</p>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="delete">${tHtml("delete.delete")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>
    <p class="err" data-err hidden></p>`);
  body.querySelector('[data-act="delete"]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      if (entry.where === "local") await library.remove(entry.id);
      else await online.remove(entry.id);
      if (isHome(ctx.home(), entry)) ctx.homeGone();
      ctx.sheet.close();
      changed();
    } catch (err) {
      const msg = body.querySelector("[data-err]");
      msg.hidden = false;
      msg.textContent = message(err.code ?? "offline");
      e.target.disabled = false;
    }
  };
}

// ── the Load… sheet ──────────────────────────────────────────────────────────

let loadGen = 0;

export async function openLoad(ctx) {
  const gen = ++loadGen;
  showSheet(ctx, `<h2>${tHtml("load.title")}</h2><p>${tHtml("load.looking")}</p>`);
  const [local, remote] = await Promise.allSettled([localEntries(), onlineEntries()]);
  if (gen !== loadGen || !ctx.sheet.open) return; // closed, or something else since
  const lists = {};
  let out = `<h2>${tHtml("load.title")}</h2><h3>${tHtml("files.local")}</h3>`;
  if (local.status === "rejected") out += `<p class="err">${esc(message(local.reason?.code ?? "unavailable"))}</p>`;
  else if (!local.value.length) out += `<p>${tHtml("load.noneLocal")}</p>`;
  else {
    lists.local = local.value;
    out += `<ul class="files-list" data-list="local">${rowsHtml(local.value, ctx, { more: false })}</ul>`;
  }
  const r = remote.status === "fulfilled" ? remote.value : null;
  if (r && !r.st.available) {
    // no online sketches here at all: say nothing about them
  } else {
    out += `<h3>${tHtml("files.online")}</h3>`;
    if (!r) out += `<p class="err">${esc(message(remote.reason?.code ?? "offline"))}</p>`;
    else if (!r.entries) out += `<p>${tHtml("load.signIn")}</p><div class="row"><button type="button" class="tbtn" data-act="signin">${tHtml("signIn.signIn")}</button></div>`;
    else if (!r.entries.length) out += `<p>${tHtml("load.noneOnline")}</p>`;
    else {
      lists.online = r.entries;
      out += `<ul class="files-list" data-list="online">${rowsHtml(r.entries, ctx, { more: false })}</ul>`;
    }
  }
  out += `<div class="row"><button class="tbtn" value="close">${tHtml("sheet.cancel")}</button></div>`;
  const body = showSheet(ctx, out);
  body.querySelectorAll("[data-list]").forEach((ul) => {
    ul.onclick = (e) => {
      const b = e.target.closest("[data-open]");
      if (b) openEntry(ctx, lists[ul.dataset.list][Number(b.dataset.open)]);
    };
  });
  const signin = body.querySelector('[data-act="signin"]');
  if (signin) signin.onclick = () => offerSignIn(ctx, r.st, { then: () => openLoad(ctx) });
}

// ── the Files panel ──────────────────────────────────────────────────────────

export class FilesPanel {
  /** `root` is the panel (#files in index.html). */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.cols = { local: root.querySelector("#filesLocal"), online: root.querySelector("#filesOnline") };
    this.entries = { local: [], online: [] };
    this.gen = { local: 0, online: 0 };
    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => this.tab(b.dataset.tab)));
    root.querySelector("#filesBack").addEventListener("click", () => this.close());
    root.querySelector("#filesNew").addEventListener("click", () => ctx.newSketch());
    for (const where of ["local", "online"]) {
      this.cols[where].addEventListener("click", (e) => this.click(where, e));
    }
    online.onAuthChange(() => { if (this.isOpen) this.refreshOnline(); });
    // The phone's Back closes the panel rather than leaving the page.
    addEventListener("popstate", () => { if (this.isOpen && !history.state?.touchFiles) this.hide(); });
  }

  get isOpen() { return !this.root.hidden; }

  open() {
    if (!this.isOpen) {
      this.root.hidden = false;
      this.ctx.covered(true);
      history.pushState({ touchFiles: true }, "");
      this.tab(this.root.dataset.tab || "local");
      this.root.querySelector("#filesBack").focus();
    }
    this.refresh();
  }

  close() {
    if (!this.isOpen) return;
    if (history.state?.touchFiles) history.back(); // popstate hides it
    else this.hide();
  }

  hide() {
    this.root.hidden = true;
    this.ctx.covered(false);
  }

  /** Which list a phone held upright shows; with room for both, both show. */
  tab(where) {
    this.root.dataset.tab = where;
    this.root.querySelectorAll("[data-tab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.tab === where));
    });
  }

  refresh() {
    this.refreshLocal();
    this.refreshOnline();
  }

  column(where, { count = "", aside = "", body }) {
    this.cols[where].innerHTML = `
      <header class="files-colhead">
        <h2>${esc(place(where))}</h2><span class="files-count">${esc(count)}</span>
        <span class="spacer"></span>${aside}
      </header>${body}`;
  }

  async refreshLocal() {
    const gen = ++this.gen.local;
    let entries;
    try {
      entries = await localEntries();
    } catch (err) {
      if (gen === this.gen.local) this.column("local", { body: `<p class="files-note err">${esc(message(err.code ?? "unavailable"))}</p>` });
      return;
    }
    if (gen !== this.gen.local) return;
    this.entries.local = entries;
    this.column("local", {
      count: String(entries.length || ""),
      body: entries.length
        ? `<ul class="files-list">${rowsHtml(entries, this.ctx, { more: true })}</ul>`
        : `<p class="files-note">${tHtml("files.noneLocal")}</p>`,
    });
  }

  async refreshOnline() {
    const gen = ++this.gen.online;
    if (!this.entries.online.length) this.column("online", { body: `<p class="files-note">${tHtml("load.looking")}</p>` });
    let r;
    try {
      r = await onlineEntries();
    } catch (err) {
      if (gen !== this.gen.online) return;
      this.entries.online = [];
      this.column("online", {
        body: `<p class="files-note err">${esc(message(err.code ?? "offline"))}</p>
          <div class="files-note"><button type="button" class="tbtn" data-act="retry">${tHtml("files.retry")}</button></div>`,
      });
      return;
    }
    if (gen !== this.gen.online) return;
    this.entries.online = r.entries ?? [];
    this.st = r.st;
    if (!r.st.available) {
      return this.column("online", {
        body: `<p class="files-note">${tHtml("files.unavailable")}</p>`,
      });
    }
    if (!r.entries) {
      return this.column("online", {
        body: `<p class="files-note">${tHtml("files.signInNote")}</p>
          <div class="files-note"><button type="button" class="tbtn primary" data-act="signin">${tHtml("signIn.signIn")}</button></div>`,
      });
    }
    this.column("online", {
      count: t("files.count", { n: r.entries.length, limit: r.limit }),
      aside: `<button type="button" class="tbtn" data-act="signout">${tHtml("files.signOut")}</button>`,
      body: `<p class="files-note files-who">${tHtml("files.signedInAs", { name: html(`<b>${esc(r.st.user?.name ?? t("files.you"))}</b>`) })}</p>${r.entries.length
        ? `<ul class="files-list">${rowsHtml(r.entries, this.ctx, { more: true })}</ul>`
        : `<p class="files-note">${tHtml("files.noneOnline")}</p>`}`,
    });
  }

  click(where, e) {
    const changed = () => this.refresh();
    const open = e.target.closest("[data-open]");
    if (open) return openEntry(this.ctx, this.entries[where][Number(open.dataset.open)]);
    const more = e.target.closest("[data-more]");
    if (more) return entrySheet(this.ctx, this.entries[where][Number(more.dataset.more)], changed);
    const a = e.target.closest("[data-act]")?.dataset.act;
    if (a === "retry") this.refreshOnline();
    else if (a === "signin") offerSignIn(this.ctx, this.st, { then: () => { this.ctx.sheet.close(); this.refreshOnline(); } });
    else if (a === "signout") online.signOut().catch(() => {}).finally(() => this.refreshOnline());
  }
}
