// The File view's Instruments tab — the instrument library (instlibrary.js):
// the packs Export… in the Instruments view saved, and any .tsii added here,
// each with the name and copyright it carries and a note its owner can leave
// on it. From here a pack goes into the open project (the same picker as
// Instruments → Import…), out as a download, or away.
//
// One section per File view copy; all of them draw the same library. A note
// being typed survives a redraw, focus, caret and all.

import {
  libraryPacks, addPackFiles, setPackNote, removePack, downloadPack, loadPack, fillPackStrings,
  onInstrumentLibraryChange, PACK_EXT,
} from "../instlibrary.js";
import * as opfs from "../../storage/opfs.js";
import { pickFiles } from "../../storage/import-export.js";
import { showModal, showAlert } from "../components/modal.js";
import { setIconLabel } from "../icons.js";
import { t } from "../i18n.js";

export class InstrumentPackSection {
  /**
   * @param store the app store (an open project is where Import puts a pack)
   * @param onImported (result) after a pack's instruments went into the
   *        project: { firstSlot, count }
   */
  constructor(store, { onImported = null } = {}) {
    this.store = store;
    this.onImported = onImported;
    this.el = document.createElement("section");
    this.el.className = "files-instruments";
    this._seq = 0;
    this._shown = false;
    onInstrumentLibraryChange(() => { if (this._shown) this.render(); });
    // Import needs a project: the buttons follow one opening or closing.
    store.on?.("doc", () => this._syncImport());
  }

  /** Draw the tab (again). `shown` false stops redraws while another tab is up. */
  async render(shown = true) {
    this._shown = shown;
    if (!shown) return;
    const seq = ++this._seq;
    const ok = await opfs.available();
    const packs = ok ? await libraryPacks() : [];
    if (seq !== this._seq) return; // a newer render is on its way

    const bar = document.createElement("div");
    bar.className = "files-bar";
    const where = opfs.location("instruments");
    const add = button(t("ipack.add"), () => this.add());
    add.title = where ? t("ipack.addTitleNative", { folder: where }) : t("ipack.addTitle");
    add.disabled = !ok;
    bar.append(add);
    if (where) {
      const show = button(t("files.showFolder"), () => opfs.reveal("instruments"));
      show.title = where;
      bar.append(show);
    }

    const parts = [bar, el("p", "files-blurb", where ? t("ipack.blurbNative", { folder: where }) : t("ipack.blurb"))];
    if (!ok) {
      parts.push(el("p", "files-warn", t("files.opfsWarn")));
    } else {
      const table = document.createElement("table");
      table.className = "files-table sf-table ipack-table";
      const head = document.createElement("tr");
      for (const key of ["ipack.colFile", "ipack.colPack", "sf.colNote", "files.colSize", "ipack.colSaved"]) {
        head.append(el("th", "", t(key)));
      }
      head.append(el("th", "", ""));
      table.createTHead().append(head);
      const body = table.createTBody();
      for (const p of packs) body.append(this._packRow(p));
      if (packs.length === 0) {
        const tr = document.createElement("tr");
        const td = el("td", "dim", t("ipack.none"));
        td.colSpan = 6;
        tr.append(td);
        body.append(tr);
      }
      parts.push(table);
    }
    parts.push(el("p", "files-disclaimer", where ? t("ipack.disclaimerNative", { folder: where }) : t("ipack.disclaimer")));

    const typing = this.el.contains(document.activeElement) && document.activeElement.classList.contains("sf-note")
      ? { file: document.activeElement.dataset.file, value: document.activeElement.value,
          a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd }
      : null;
    this.el.replaceChildren(...parts);
    if (typing) {
      const input = [...this.el.querySelectorAll(".sf-note")].find((i) => i.dataset.file === typing.file);
      if (input) {
        input.value = typing.value;
        input.focus();
        input.setSelectionRange(typing.a, typing.b);
      }
    }
    this._syncImport();
    // A pack dropped into the desktop's folder by hand: its name comes in
    // with the next redraw, once read.
    if (ok) fillPackStrings(packs).catch(() => {});
  }

  async add() {
    const files = await pickFiles(PACK_EXT, t("ipack.addDialog"));
    if (files.length === 0) return;
    const bad = [];
    await addPackFiles(files, {
      confirmReplace: (title) => showModal({ title: t("sf.replaceAsk", { name: title }), okLabel: t("sf.replace") }),
      failed: (name, err) => bad.push(t("ipack.notPack", { name, err: err.message ?? String(err) })),
    });
    if (bad.length) showAlert(bad.join("\n"));
  }

  async importPack(p) {
    if (!this.store.doc) return;
    let bytes;
    try {
      bytes = await loadPack(p.file);
    } catch (err) {
      showAlert(t("import.cantRead", { name: p.file, err: err.message }));
      return;
    }
    const { importFromBank } = await import("../popups/importinst.js");
    const res = await importFromBank(this.store, p.file, bytes);
    if (res) this.onImported?.(res);
  }

  /** Import is for a project: greyed while none is open. */
  _syncImport() {
    const none = !this.store.doc;
    for (const b of this.el.querySelectorAll(".ipack-import")) {
      if (b.disabled !== none) b.disabled = none;
      const title = none ? t("ipack.importNoProject") : t("ipack.import");
      if (b.title !== title) b.title = title;
    }
  }

  _packRow(p) {
    const tr = document.createElement("tr");
    const name = el("td", "sf-name", p.title);
    name.title = p.file;
    const packName = el("td", "ipack-pack", p.pack?.name ?? "");
    if (p.pack?.copyright) packName.title = p.pack.copyright;
    const noteTd = document.createElement("td");
    const note = document.createElement("input");
    note.type = "text";
    note.className = "sf-note";
    note.dataset.file = p.file;
    note.value = p.note;
    note.maxLength = 500;
    note.placeholder = t("sf.notePlaceholder");
    note.setAttribute("aria-label", t("sf.noteLabel", { name: p.title }));
    note.addEventListener("change", () => setPackNote(p.file, note.value));
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter") note.blur();
      else if (e.key === "Escape") { note.value = p.note; note.blur(); }
    });
    noteTd.append(note);
    const actions = document.createElement("td");
    actions.className = "ipack-actions";
    const imp = button(t("ipack.importShort"), () => this.importPack(p));
    imp.className = "ipack-import";
    const dl = iconButton("download", () => downloadPack(p.file));
    dl.title = t("ipack.download");
    const del = iconButton("close", async () => {
      if (await showModal({ title: t("files.deleteAsk", { name: p.title }), okLabel: t("common.delete") })) {
        await removePack(p.file);
      }
    });
    del.title = t("common.delete");
    actions.append(imp, dl, del);
    tr.append(name, packName, noteTd, el("td", "", size(p.size)), el("td", "", new Date(p.mtime).toLocaleString()),
      actions);
    return tr;
  }
}

function size(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} M`;
  return `${Math.max(1, Math.round(n / 1024))} K`;
}

function el(tag, cls, text = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(name, onClick) {
  const b = button("", onClick);
  setIconLabel(b, name);
  return b;
}
