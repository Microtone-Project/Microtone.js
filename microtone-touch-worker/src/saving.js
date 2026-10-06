// Saving a sketch: Save, Save as…, and what either may have to ask first.
//
// A sketch is kept in one of two places. ON THIS PHONE is library.js, which
// holds the sketch model itself. ONLINE is the same online projects the
// tracker's File tab lists (core/storage/online.js): a sketch goes up as a
// .mtsk (core/sketch/mtsk.js), a few hundred bytes without the instrument
// pack, into slots of its own, and Microtone lists it beside the projects
// and opens it as a new project.
//
// Where the sketch in hand was last saved or opened is its HOME, and Save
// goes back there — online, quoting the etag it was opened or last saved
// with, so a copy saved from somewhere else in the meantime is never
// silently replaced. Save as… picks a name and a place, and the home moves
// with it. The file a download carries is a .taud instead, self-contained so
// that it opens anywhere; taking it moves nothing.
//
// `ctx` is the page's side of it:
//   { sheet, body, bank, toast(text),
//     sketch(), home(), unsaved(),
//     snapshot(name?) → { sketch, digest } — a copy of the sketch in hand,
//       under `name`, and its digest (sketch.js sketchDigest),
//     saved(home, snapshot) — that copy is now kept at `home` }

import * as online from "../core/storage/online.js";
import * as library from "./library.js";
import { sketchToTaud, sketchToFile, sketchFileName } from "./sketch.js";
import { t, tHtml } from "./i18n.js";

/** The failures with a sentence of their own (lang/*.js err.<code>): the
 *  server's codes, library.js's, and "offline" for no answer at all. */
const EXPLAINED = new Set([
  "offline", "quota", "too-large", "exists", "conflict", "signed-out", "bad-name", "not-found", "unavailable",
]);
export const message = (code) => (EXPLAINED.has(code) ? t(`err.${code}`) : t("err.other", { code }));

/** An online sketch is named like a file, and its `.mtsk` is what puts it
 *  in a sketch slot; it is shown without it. */
export const onlineName = (name) => sketchFileName({ name }, online.SKETCH_EXT);
export const shownName = (file) =>
  (online.isSketchName(file) ? file.slice(0, -online.SKETCH_EXT.length) : file);

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Put `html` in the sheet, opening it if need be. → the sheet's body. */
export function showSheet(ctx, html) {
  ctx.body.innerHTML = html;
  if (!ctx.sheet.open) ctx.sheet.showModal();
  return ctx.body;
}
const act = (body, name) => body.querySelector(`[data-act="${name}"]`);

export function fail(ctx, title, text) {
  showSheet(ctx, `
    <h2>${esc(title)}</h2>
    <p class="err">${esc(text)}</p>
    <div class="row"><button class="tbtn" value="close">${tHtml("sheet.close")}</button></div>`);
}

/** Saved: the page learns where, the sheet goes, and whatever was waiting
 *  on the save goes ahead. */
function done(ctx, home, snap, text, opts) {
  ctx.saved(home, snap);
  if (ctx.sheet.open) ctx.sheet.close();
  ctx.toast(text);
  opts.after?.();
}

// ── Save ─────────────────────────────────────────────────────────────────────

/** Save: back to the sketch's home, or Save as… when it has none yet.
 *  `opts.after()` runs once it is saved. */
export async function save(ctx, opts = {}) {
  const home = ctx.home();
  if (!home) return openSaveAs(ctx, opts);
  const snap = ctx.snapshot();
  if (home.where === "local") return saveLocal(ctx, snap, home.id, opts);
  return saveOnline(ctx, snap, home, opts);
}

/** Keep `snap` on this phone: over the sketch `id`, or as a new one. */
async function saveLocal(ctx, snap, id, opts) {
  try {
    const kept = await library.write(snap.sketch, { id });
    done(ctx, { where: "local", id: kept.id }, snap, t("save.savedLocal", { name: kept.name }), opts);
  } catch (err) {
    if (err.code !== "exists") return fail(ctx, t("save.failed"), message(err.code));
    const home = ctx.home();
    // Save as… under the name it is already kept under: that is just Save.
    if (home?.where === "local" && home.id === err.existing.id) return saveLocal(ctx, snap, home.id, opts);
    offerReplace(ctx, snap, opts, "local", () => saveLocal(ctx, snap, err.existing.id, opts));
  }
}

/** Save over the online sketch the one in hand came from. */
async function saveOnline(ctx, snap, home, opts) {
  ctx.toast(t("save.saving"));
  try {
    const p = await online.save(home.id, sketchToFile(snap.sketch, ctx.bank), home.etag);
    done(ctx, { where: "online", id: p.id, etag: p.etag }, snap, t("save.savedOnline"), opts);
  } catch (err) {
    // Deleted since — or a project slot, where a prototype once sent a
    // .taud: save it afresh under its name.
    if (err.status === 404 || err.code === "not-found" || err.code === "not-taud") {
      return saveOnlineAs(ctx, snap, opts);
    }
    onlineFailed(ctx, err, snap, opts, () => saveOnline(ctx, snap, home, opts));
  }
}

/** Put `snap` online under its own name. */
async function saveOnlineAs(ctx, snap, opts) {
  const file = onlineName(snap.sketch.name);
  const bytes = sketchToFile(snap.sketch, ctx.bank);
  const home = ctx.home();
  const ok = (p) => done(ctx, { where: "online", id: p.id, etag: p.etag }, snap,
    t("save.savedOnlineAs", { name: shownName(p.name) }), opts);
  try {
    const { projects } = await online.list();
    const same = projects.find((p) => p.name === file);
    if (!same) return ok(await online.create(file, bytes));
    // the online sketch the one in hand came from, under the same name: an
    // ordinary save, quoting its etag
    if (home?.where === "online" && home.id === same.id) return ok(await online.save(same.id, bytes, home.etag));
    offerReplace(ctx, snap, opts, "online", async () => {
      try { ok(await online.save(same.id, bytes, null)); } catch (err) { onlineFailed(ctx, err, snap, opts, () => saveOnlineAs(ctx, snap, opts)); }
    });
  } catch (err) {
    onlineFailed(ctx, err, snap, opts, () => saveOnlineAs(ctx, snap, opts));
  }
}

async function onlineFailed(ctx, err, snap, opts, retry) {
  if (err.code === "conflict") return offerConflict(ctx, snap, opts);
  if (err.code === "signed-out") {
    return offerSignIn(ctx, await online.status(), { then: retry, why: message("signed-out") });
  }
  fail(ctx, t("save.failed"), message(err.code ?? "offline"));
}

/** `where` is the place the name is taken in: "local" or "online". */
function offerReplace(ctx, snap, opts, where, replace) {
  const name = snap.sketch.name;
  const body = showSheet(ctx, `
    <h2>${tHtml("replace.title")}</h2>
    <p>${tHtml(where === "local" ? "replace.bodyLocal" : "replace.bodyOnline", { name })}</p>
    <div class="row">
      <button type="button" class="tbtn" data-act="replace">${tHtml("replace.replace")}</button>
      <button type="button" class="tbtn primary" data-act="rename">${tHtml("replace.rename")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>`);
  act(body, "replace").onclick = (e) => { e.target.disabled = true; replace(); };
  act(body, "rename").onclick = () => openSaveAs(ctx, opts, { name });
}

function offerConflict(ctx, snap, opts) {
  const name = snap.sketch.name;
  const body = showSheet(ctx, `
    <h2>${tHtml("conflict.title")}</h2>
    <p>${tHtml("conflict.body", { name })}</p>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="new">${tHtml("conflict.saveNew")}</button>
      <button type="button" class="tbtn" data-act="replace">${tHtml("replace.replace")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>`);
  act(body, "new").onclick = () => openSaveAs(ctx, opts, { name: t("conflict.copyName", { name }) });
  act(body, "replace").onclick = async (e) => {
    e.target.disabled = true;
    const home = ctx.home();
    try {
      const p = await online.save(home.id, sketchToFile(snap.sketch, ctx.bank), null);
      done(ctx, { where: "online", id: p.id, etag: p.etag }, snap, t("save.savedOnline"), opts);
    } catch (err) {
      onlineFailed(ctx, err, snap, opts, () => save(ctx, opts));
    }
  };
}

// ── Save as… ─────────────────────────────────────────────────────────────────

/**
 * Save as…: a name, and where — on this phone or online — or the .taud as a
 * file to download or share. `name` starts the name field somewhere else
 * than the sketch's own name; `opts.after()` runs once it is saved.
 */
export function openSaveAs(ctx, opts = {}, { name = ctx.sketch().name } = {}) {
  const wasOnline = ctx.home()?.where === "online";
  const share = canShare();
  const body = showSheet(ctx, `
    <h2>${tHtml("saveAs.title")}</h2>
    <label>${tHtml("saveAs.name")}<input type="text" name="name" value="${esc(name)}" maxlength="${library.NAME_MAX}" autocomplete="off" enterkeyhint="done"></label>
    <div class="row">
      <button type="button" class="tbtn ${wasOnline ? "" : "primary"}" data-act="local">${tHtml("saveAs.local")}</button>
      <button type="button" class="tbtn ${wasOnline ? "primary" : ""}" data-act="online" disabled>${tHtml("saveAs.online")}</button>
    </div>
    <p data-online>${tHtml("saveAs.checking")}</p>
    <p>${tHtml("saveAs.fileNote")}</p>
    <div class="row">
      ${share ? `<button type="button" class="tbtn" data-act="share">${tHtml("saveAs.share")}</button>` : ""}
      <button type="button" class="tbtn" data-act="download">${tHtml("saveAs.download")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>
    <p class="err" data-err hidden></p>`);
  const input = body.querySelector('[name="name"]');
  const err = body.querySelector("[data-err]");
  const onlineBtn = act(body, "online");
  const named = () => {
    const n = library.cleanName(input.value);
    if (!n) {
      err.hidden = false;
      err.textContent = t("saveAs.needName");
      input.focus();
    }
    return n;
  };
  const busy = () => body.querySelectorAll("[data-act]").forEach((b) => { b.disabled = true; });

  act(body, "local").onclick = () => {
    const n = named();
    if (!n) return;
    busy();
    saveLocal(ctx, ctx.snapshot(n), null, opts);
  };
  onlineBtn.onclick = async () => {
    const n = named();
    if (!n) return;
    busy();
    const st = await online.status();
    const go = () => saveOnlineAs(ctx, ctx.snapshot(n), opts);
    if (st.signedIn) go();
    else offerSignIn(ctx, st, { then: go });
  };
  const file = () => {
    const snap = ctx.snapshot(named() || ctx.sketch().name);
    return new File([sketchToTaud(snap.sketch, ctx.bank)], sketchFileName(snap.sketch), { type: "application/octet-stream" });
  };
  act(body, "download").onclick = () => {
    const f = file();
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  if (share) act(body, "share").onclick = () => navigator.share({ files: [file()], title: ctx.sketch().name }).catch(() => {});
  // Enter in the name saves where the primary button says — never the form's
  // own submit, whose first submit button is Cancel.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const primary = body.querySelector(".row .primary");
    if (!primary.disabled) primary.click();
  });

  online.status().then((st) => {
    if (!body.contains(onlineBtn)) return; // the sheet has moved on
    const note = body.querySelector("[data-online]");
    if (!st.available) {
      onlineBtn.hidden = true;
      note.hidden = true;
      if (wasOnline) act(body, "local").classList.add("primary");
      return;
    }
    onlineBtn.disabled = false;
    note.textContent = !st.signedIn ? t("saveAs.onlineSignIn")
      : st.user?.name ? t("saveAs.onlineAs", { name: st.user.name })
      : t("saveAs.onlineAccount");
  });
}

function canShare() {
  try {
    return typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([new Uint8Array(1)], "x.taud")] });
  } catch {
    return false;
  }
}

// ── signing in, and the sketch in hand ───────────────────────────────────────

/**
 * Ask for a sign-in (`st` is online.status()), then call `then(status)` once
 * any tab of the page has signed in. `why` replaces the opening sentence.
 */
export function offerSignIn(ctx, st, { then, why = "" }) {
  if (!st.available) return fail(ctx, t("signIn.unavailableTitle"), t("signIn.unavailable"));
  const dev = st.signIn === "dev";
  const body = showSheet(ctx, `
    <h2>${tHtml("signIn.title")}</h2>
    <p>${why ? esc(why) : tHtml("signIn.why")}</p>
    ${dev ? `<input type="text" name="devName" placeholder="${tHtml("signIn.devName")}" autocomplete="off">` : ""}
    <div class="row">
      <button type="button" class="tbtn primary" data-act="signin">${tHtml("signIn.signIn")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>
    <p class="err" data-err hidden></p>`);
  const err = body.querySelector("[data-err]");
  const stop = online.onAuthChange(async (type) => {
    if (type !== "signed-in") return;
    stop();
    then(await online.status());
  });
  ctx.sheet.addEventListener("close", stop, { once: true });
  act(body, "signin").onclick = () => {
    const name = body.querySelector('[name="devName"]')?.value.trim() ?? "";
    if (dev && !name) { err.hidden = false; err.textContent = t("signIn.needDevName"); return; }
    if (!online.signIn(st.signIn, { name })) {
      err.hidden = false;
      err.textContent = t("signIn.blocked");
    }
  };
}

/** Before the sketch in hand is replaced: if it has unsaved changes, offer
 *  to save them first. `then()` replaces it. */
export function keepOrDiscard(ctx, then) {
  if (!ctx.unsaved()) return then();
  const body = showSheet(ctx, `
    <h2>${tHtml("unsaved.title")}</h2>
    <p>${tHtml(ctx.home() ? "unsaved.body" : "unsaved.bodyNowhere", { name: ctx.sketch().name })}</p>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="save">${tHtml("unsaved.save")}</button>
      <button type="button" class="tbtn" data-act="discard">${tHtml("unsaved.discard")}</button>
      <button class="tbtn" value="close">${tHtml("sheet.cancel")}</button>
    </div>`);
  act(body, "save").onclick = (e) => { e.target.disabled = true; save(ctx, { after: then }); };
  act(body, "discard").onclick = () => { ctx.sheet.close(); then(); };
}
