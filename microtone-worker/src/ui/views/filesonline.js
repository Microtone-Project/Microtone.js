// File view — the online projects section, under the browser's own list.
//
// A few working projects kept with the person's SceneID account (the storage
// half is core/storage/online.js). Deliberately NOT presented as storage: the
// heading says "online projects", the count says how many of the few slots
// are taken, and the note under the table says what they are for.
//
// A project opened from here, or saved here, BELONGS here: store.online
// remembers it, and the ordinary Save (button or Ctrl+S) goes back to it —
// with the ETag it was opened with, so a copy saved from another browser in
// the meantime is never silently replaced. Save As still makes a local copy,
// and the document then belongs to the browser again.

import * as online from "../../../core/storage/online.js";
import { download } from "../../storage/import-export.js";
import { showModal } from "../widgets/modal.js";
import { showProgress } from "../popups/progress.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

const MB = 1024 * 1024;

/** SceneID's own "Sign in with SceneID" artwork, cropped from the kit they
 *  hand out to sites that use it (see the comment inside the file). */
const SCENEID_SIGN_IN = new URL("../../../assets/sceneid/sign-in.svg", import.meta.url).href;

/** Error codes with a sentence of their own; anything else gets the generic
 *  one, code included, so a report can say what happened. */
const EXPLAINED = new Set([
  "offline", "signed-out", "quota", "exists", "too-large", "not-taud", "not-found", "bad-name",
]);

export class OnlineSection {
  /**
   * @param callbacks { openBytes(name, bytes), currentDoc() → {doc, fileName},
   *                    refresh() — redraw the whole File view }
   */
  constructor(store, callbacks) {
    this.store = store;
    this.cb = callbacks;
    // What the server said last time; the size check before an upload and
    // the messages quote it.
    this.limit = 8;
    this.sizeLimit = 10 * MB;
    // Whether the last answer offered online projects at all; null until the
    // first one comes. Only an unknown answer earns the placeholder.
    this.available = null;
    // The section element render() fills, and how many requests it is
    // waiting on (see waiting()).
    this.host = null;
    this.waits = 0;
  }

  /**
   * Fill `host`, replacing what it showed only once the new answer is
   * complete. It stays hidden wherever there are no online projects to offer
   * — no API on this host, or no way to sign in yet — so the File tab looks
   * exactly as it always did. `stillCurrent()` is false once a newer refresh
   * has started, and then this one gives way.
   *
   * The very first ask has no last answer to keep showing, so a placeholder
   * stands in for it. The stylesheet holds that back for a moment: a host
   * with no API answers at once, and never shows it.
   */
  async render(host, stillCurrent) {
    this.host = host;
    if (host.hidden && this.available === null) {
      host.replaceChildren(...placeholder());
      host.classList.add("files-online-pending");
      host.hidden = false;
    }
    const answer = await this.waiting(this.ask(stillCurrent));
    if (!answer) return;
    const { st, listing, failure } = answer;
    this.available = st.available;
    host.classList.remove("files-online-pending");
    if (!st.available) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }

    const head = heading(listing
      ? t("files.online.count", { n: listing.projects.length, limit: this.limit })
      : null);
    const parts = [head];

    if (!st.signedIn) {
      const blurb = document.createElement("p");
      blurb.className = "files-online-blurb";
      blurb.textContent = t("files.online.blurb");
      const bar = document.createElement("div");
      bar.className = "files-bar";
      bar.append(st.signIn === "sceneid"
        ? sceneIdButton(() => this.signIn(st.signIn))
        : mkBtn(t("files.online.signInDev"), () => this.signIn(st.signIn)));
      parts.push(blurb, bar);
    } else {
      const { doc } = this.cb.currentDoc();
      const bar = document.createElement("div");
      bar.className = "files-bar files-online-bar";
      const saveBtn = mkBtn(t("files.online.saveOnline"), () => this.saveNew());
      // A full desk can still save over one of its own projects, just not add one.
      saveBtn.disabled = !doc || !listing || listing.projects.length >= this.limit;
      const who = document.createElement("span");
      who.className = "files-online-who";
      who.textContent = t("files.online.signedInAs", { name: st.user?.name ?? "" });
      bar.append(saveBtn, who, mkBtn(t("files.online.signOut"), () => this.signOut()));
      parts.push(bar);
      if (failure) {
        const warn = document.createElement("p");
        warn.className = "files-warn";
        warn.textContent = this.message(failure);
        parts.push(warn);
      } else {
        parts.push(this.table(listing.projects));
      }
    }

    const note = document.createElement("p");
    note.className = "files-disclaimer";
    note.textContent = t("files.online.policy", { limit: this.limit, mb: Math.round(this.sizeLimit / MB) });
    parts.push(note);
    host.replaceChildren(...parts);
    host.hidden = false;
  }

  /** The status, then — when signed in — the listing; null once a newer
   *  refresh has started. */
  async ask(stillCurrent) {
    const st = await online.status();
    if (!stillCurrent()) return null;
    let listing = null;
    let failure = null;
    if (st.signedIn) {
      try {
        listing = await online.list();
        this.limit = listing.limit;
        this.sizeLimit = listing.sizeLimit;
      } catch (err) {
        failure = err;
      }
      if (!stillCurrent()) return null;
    }
    return { st, listing, failure };
  }

  /** Await `promise` with the section marked busy, which puts a spinner by
   *  its heading — after a moment, so a quick answer does not blink one. */
  async waiting(promise) {
    const host = this.host;
    if (this.waits++ === 0) {
      host?.classList.add("files-online-busy");
      host?.setAttribute("aria-busy", "true");
    }
    try {
      return await promise;
    } finally {
      if (--this.waits === 0) {
        host?.classList.remove("files-online-busy");
        host?.removeAttribute("aria-busy");
      }
    }
  }

  table(projects) {
    const table = document.createElement("table");
    table.className = "files-table";
    table.innerHTML =
      `<thead><tr><th>${t("files.colProject")}</th><th>${t("files.colSize")}</th>` +
      `<th>${t("files.colModified")}</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    if (projects.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "dim";
      td.textContent = t("files.online.none");
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    const currentId = this.store.onlineProject?.id;
    const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
    for (const p of sorted) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      const nameBtn = mkBtn(p.name, () => this.open(p));
      nameBtn.className = "files-name" + (p.id === currentId ? " files-current" : "");
      nameBtn.title = t("files.openTitle", { name: p.name });
      nameTd.appendChild(nameBtn);
      const sizeTd = document.createElement("td");
      sizeTd.textContent = `${(p.size / 1024).toFixed(1)} K`;
      const timeTd = document.createElement("td");
      timeTd.textContent = new Date(p.modified).toLocaleString();
      const actions = document.createElement("td");
      const renameBtn = iconBtn("rename", () => this.rename(p));
      renameBtn.title = t("common.rename");
      const downloadBtn = iconBtn("download", () => this.download(p));
      downloadBtn.title = t("files.online.downloadTitle", { name: p.name });
      const deleteBtn = iconBtn("close", () => this.remove(p));
      deleteBtn.title = t("common.delete");
      actions.append(mkBtn(t("files.open"), () => this.open(p)), renameBtn, downloadBtn, deleteBtn);
      tr.append(nameTd, sizeTd, timeTd, actions);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  // ── the actions ──

  async signIn(mode) {
    let name = "";
    if (mode === "dev") {
      const result = await showModal({
        title: t("files.online.signInDev"),
        fields: [{ name: "name", label: t("files.online.devName"), value: "tester" }],
        okLabel: t("common.ok"),
      });
      if (!result) return;
      name = result.name;
    }
    // The window reports back by broadcast (online.onAuthChange), which
    // refreshes this view; nothing to wait for here.
    if (!online.signIn(mode, { name })) {
      await showModal({ title: t("files.online.popupBlocked"), okLabel: t("common.ok") });
    }
  }

  async signOut() {
    try {
      await this.waiting(online.signOut());
    } catch (err) {
      await this.report(err);
    }
    this.cb.refresh();
  }

  async open(p) {
    const got = await this.fetchProject(p, "files.online.opening");
    if (!got) {
      this.cb.refresh();
      return;
    }
    const before = this.store.doc;
    await this.cb.openBytes(p.name, got.bytes);
    // Unchanged means the load was declined at the unsaved-work prompt.
    if (this.store.doc !== before) {
      this.store.online = { doc: this.store.doc, id: p.id, etag: got.etag };
      this.store.emit("status");
    }
    this.cb.refresh();
  }

  /** Save the open document over the online project it belongs to — what
   *  Save and Ctrl+S do for one. */
  async saveOver() {
    const origin = this.store.onlineProject;
    const { doc, fileName } = this.cb.currentDoc();
    if (!origin || !doc) return;
    const name = fileName ?? "untitled.taud";
    let outcome = await this.upload(doc, (bytes) => online.save(origin.id, bytes, origin.etag), name);
    if (outcome === "conflict") {
      const yes = await showModal({
        title: t("files.online.conflictTitle", { name }),
        body: t("files.online.conflictBody"),
        okLabel: t("files.online.replace"),
      });
      if (!yes) return;
      outcome = await this.upload(doc, (bytes) => online.save(origin.id, bytes, null), name);
    }
    if (outcome === "not-found") {
      // Deleted from somewhere else while it was open here: offer it a slot again.
      const yes = await showModal({
        title: t("files.online.goneTitle", { name }),
        body: t("files.online.goneBody"),
        okLabel: t("files.online.saveOnline"),
      });
      if (yes) await this.createAs(doc, name);
    }
  }

  /** "Save online…": the open document as a new online project, which it
   *  then belongs to. */
  async saveNew() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const result = await showModal({
      title: t("files.online.saveOnlineTitle"),
      fields: [{ name: "name", label: t("files.name"), value: fileName ?? "untitled.taud" }],
      okLabel: t("common.save"),
    });
    const name = taudName(result?.name);
    if (name) await this.createAs(doc, name);
  }

  async createAs(doc, name) {
    if (await this.upload(doc, (bytes) => online.create(name, bytes), name) !== "exists") return;
    const yes = await showModal({ title: t("files.online.replaceAsk", { name }), okLabel: t("files.online.replace") });
    if (!yes) return;
    let existing;
    try {
      existing = (await this.waiting(online.list())).projects.find((p) => p.name === name);
    } catch (err) {
      await this.report(err, name, { saving: true });
      return;
    }
    // Not listed: deleted in the meantime, or an upload of the same name
    // still in flight from another tab. One more plain try settles which.
    const outcome = existing
      ? await this.upload(doc, (bytes) => online.save(existing.id, bytes, null), name)
      : await this.upload(doc, (bytes) => online.create(name, bytes), name);
    if (outcome === "exists" || outcome === "not-found") {
      await this.report(new online.OnlineError(outcome), name, { saving: true });
    }
  }

  /**
   * Serialise `doc`, hand the bytes to `send`, and on success make the online
   * project the document's home. Returns "ok", or the error code of a
   * conflict / taken name / vanished project, which the caller has a question
   * to ask about; every other failure has already been reported.
   */
  async upload(doc, send, name) {
    const bytes = doc.toBytes();
    if (bytes.length > this.sizeLimit) {
      await this.report(new online.OnlineError("too-large"), name, { saving: true });
      return "too-large";
    }
    // An upload can take a while; an edit made during it is not in these
    // bytes, and must not be marked saved when they land.
    let editedMeanwhile = false;
    const off = this.store.on("edit", () => { editedMeanwhile = true; });
    let project;
    try {
      project = await this.waiting(send(bytes));
    } catch (err) {
      if (err instanceof online.OnlineError && ["conflict", "exists", "not-found"].includes(err.code)) {
        return err.code;
      }
      await this.report(err, name, { saving: true });
      return err.code ?? "error";
    } finally {
      off();
    }
    if (!editedMeanwhile) doc.dirty = false;
    this.store.online = { doc, id: project.id, etag: project.etag };
    this.store.fileName = project.name;
    this.store.emit("saved", project.name);
    this.cb.refresh();
    return "ok";
  }

  async rename(p) {
    const result = await showModal({
      title: t("files.renameTitle", { name: p.name }),
      fields: [{ name: "name", label: t("files.name"), value: p.name }],
      okLabel: t("common.rename"),
    });
    const name = taudName(result?.name);
    if (!name || name === p.name) return;
    let renamed;
    try {
      renamed = await this.waiting(online.rename(p.id, name));
    } catch (err) {
      await this.report(err, name);
      return;
    }
    if (this.store.onlineProject?.id === p.id) {
      this.store.fileName = renamed.name;
      this.store.emit("status"); // the status bar follows, as it does for a local rename
    }
    this.cb.refresh();
  }

  async download(p) {
    const got = await this.fetchProject(p, "files.online.downloading");
    if (got) download(got.bytes, p.name);
  }

  /** An online project's bytes and ETag, with a progress bar while they
   *  arrive — up to 10 MB, where a silent pause would read as a hang. Null
   *  if they could not be had, the popup then saying why. (The popup is the
   *  busy sign here, so the heading's spinner stays out of it.) */
  async fetchProject(p, titleKey) {
    const progress = showProgress(t(titleKey, { name: p.name }), { holdBack: true });
    try {
      const got = await online.read(p.id, { size: p.size, onProgress: (f) => progress.set(f) });
      progress.done();
      return got;
    } catch (err) {
      progress.fail(this.message(err, p.name));
      return null;
    }
  }

  async remove(p) {
    const yes = await showModal({ title: t("files.online.deleteAsk", { name: p.name }), okLabel: t("common.delete") });
    if (!yes) return;
    try {
      await this.waiting(online.remove(p.id));
    } catch (err) {
      if (err.code !== "not-found") {
        await this.report(err, p.name);
        return;
      }
    }
    if (this.store.onlineProject?.id === p.id) {
      // Still open here, but with no home now: it is unsaved work, and the
      // next Save keeps it in this browser under the same name.
      this.store.online = null;
      this.store.doc.dirty = true;
      this.store.emit("status");
    }
    this.cb.refresh();
  }

  // ── failures ──

  message(err, name = "") {
    const code = err instanceof online.OnlineError ? err.code : "server-error";
    if (!(err instanceof online.OnlineError)) console.error("Online projects:", err);
    return EXPLAINED.has(code)
      ? t(`files.online.err.${code}`, { name, limit: this.limit, mb: Math.round(this.sizeLimit / MB) })
      : t("files.online.err.generic", { code });
  }

  /** Tell the person. A failed SAVE also says where the work can go instead:
   *  the document is still open and still unsaved, so nothing is lost yet. */
  async report(err, name = "", { saving = false } = {}) {
    await showModal({
      title: this.message(err, name),
      body: saving ? t("files.online.keepLocal") : null,
      okLabel: t("common.ok"),
    });
  }
}

/** A typed name as a project name: trimmed, `.taud` added as the local Save
 *  As adds it. Empty → null. */
function taudName(raw) {
  const name = (raw ?? "").trim();
  if (!name) return null;
  return name.endsWith(".taud") ? name : name + ".taud";
}

/** The section's heading, with a `note` after it (the slots in use, say),
 *  and last the spinner a busy section shows. */
function heading(note) {
  const head = document.createElement("h3");
  head.className = "files-online-head";
  head.append(t("files.online.head"));
  if (note) {
    const span = document.createElement("span");
    span.className = "files-online-count";
    span.textContent = note;
    head.append(" ", span);
  }
  const spinner = document.createElement("span");
  spinner.className = "spinner files-online-spinner";
  spinner.setAttribute("aria-hidden", "true");
  head.append(spinner);
  return head;
}

/** Name-column widths (em) of the placeholder's rows, so they read as names. */
const SKELETON_NAMES = [11, 7.5, 13];

/**
 * What stands in for the section while its first answer is on the way: the
 * heading, saying so, and the shape of a button and a project table drawn in
 * shimmering bars.
 */
function placeholder() {
  const head = heading(t("files.online.loading"));
  const bar = document.createElement("div");
  bar.className = "files-bar";
  bar.appendChild(skeleton("files-skel-btn"));
  const table = document.createElement("table");
  table.className = "files-table files-skel-table";
  table.setAttribute("aria-hidden", "true");
  table.innerHTML =
    `<thead><tr><th>${t("files.colProject")}</th><th>${t("files.colSize")}</th>` +
    `<th>${t("files.colModified")}</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const nameWidth of SKELETON_NAMES) {
    const tr = document.createElement("tr");
    for (const width of [nameWidth, 3, 10, 8]) {
      const td = document.createElement("td");
      const bone = skeleton();
      bone.style.width = `${width}em`;
      td.appendChild(bone);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return [head, bar, table];
}

function skeleton(extra = "") {
  const bone = document.createElement("span");
  bone.className = ("files-skel " + extra).trim();
  bone.setAttribute("aria-hidden", "true");
  return bone;
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The sign-in button, faced with SceneID's artwork — the mark someone who has
 * signed in with SceneID elsewhere will recognise. SceneID only draws it in
 * English, so the label in the app's own language is its accessible name and
 * its tooltip.
 */
function sceneIdButton(onClick) {
  const b = document.createElement("button");
  b.className = "files-sceneid";
  b.title = t("files.online.signIn");
  const img = document.createElement("img");
  img.src = SCENEID_SIGN_IN;
  img.alt = t("files.online.signIn");
  img.width = 200;
  img.height = 32;
  b.appendChild(img);
  b.addEventListener("click", onClick);
  return b;
}

function iconBtn(name, onClick) {
  const b = mkBtn("", onClick);
  setIconLabel(b, name);
  return b;
}
