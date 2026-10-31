// File view (F7) — OPFS project browser + import/export. DOM-based (lists and
// buttons, no canvas). The Files tab replaces taut's filenav-driven File tab.
// Reachable WITHOUT a loaded document (browse OPFS / import something); the
// doc-scoped buttons and the song list only appear once a project is loaded.
// Under the browser's own list sits the online projects section
// (filesonline.js), on hosts that have one. A second subtab holds the
// soundfont library (filessoundfonts.js); which one is up is the viewer's,
// remembered per browser.
//
// The local list has FOLDERS (real OPFS directories, opfs.js): the view shows
// one folder at a time — its folders first, then its projects — under a
// breadcrumb, and remembers which one per browser. Select turns on a tick
// column (hidden otherwise), and projects ticked there move together, between
// folders or online (the online list moves its own the other way, into the
// folder shown here). A move always writes the new
// copy before it deletes the old one.

import * as opfs from "../../storage/opfs.js";
import { onAuthChange } from "../../../core/storage/online.js";
import { OnlineSection, nameList } from "./filesonline.js";
import { SoundfontSection } from "./filessoundfonts.js";
import { pickFile, download, downloadBlob } from "../../storage/import-export.js";
import { converterFor, CONVERT_ACCEPT } from "../../convert/convert.js";
import { isImac } from "../../convert/imac.js";
import { isSketch } from "../../../core/sketch/mtsk.js";
import { showModal, showNotice } from "../components/modal.js";
import { renderToWavAsync } from "../../../core/audio/offline-render.js";
import {
  renderStemsAsync, labelStems, encodeWav24Mono, stemFileName, sanitiseName, StemZip,
} from "../../audio/stem-export.js";
import { showProgress } from "../popups/progress.js";
import { unescapeName } from "../../../core/format/names.js";
import { ZSTD_LEVEL_SAVE } from "../../../core/format/zstd.js";
import { withSaveProgress } from "../saveprogress.js";
import { showDemoPicker } from "../demos.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

const TAB_KEY = "microtone-files-tab";
const FOLDER_KEY = "microtone-files-folder";
const TABS = ["projects", "soundfonts"];

function storedTab() {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.includes(v) ? v : "projects"; } catch { return "projects"; }
}

function storedFolder() {
  try { return localStorage.getItem(FOLDER_KEY) ?? ""; } catch { return ""; }
}

export class FilesView {
  /**
   * @param host container element
   * @param callbacks { openBytes(name, bytes), currentDoc() → {doc, fileName},
   *                    songIndex(), importMidi(), editSong(index), openDemo(entry) }
   */
  constructor(store, host, callbacks) {
    this.store = store;
    this.host = host;
    this.cb = callbacks;
    this.root = document.createElement("div");
    this.root.className = "files-view";
    host.appendChild(this.root);
    this.online = new OnlineSection(store, {
      openBytes: callbacks.openBytes,
      currentDoc: callbacks.currentDoc,
      refresh: () => this.refresh(),
      localFolder: () => this.folder,
    });
    // The local folder on show ("" the top), and the projects ticked in it
    // (paths). A tick does not follow you into another folder.
    this.folder = storedFolder();
    this.selected = new Set();
    // Whether the tick column is out (Select … Done); leaving clears the ticks.
    this.selecting = false;
    // The selection's controls on screen (see _syncSelection); a page built
    // by a refresh that gave way never becomes this.
    this.selUi = null;
    // ONE section element for the life of the view, re-attached under each
    // fresh local list: it keeps showing the last answer while the server is
    // asked again, instead of blinking out on every save.
    this.onlineHost = document.createElement("section");
    this.onlineHost.className = "files-online";
    this.onlineHost.hidden = true;
    this._renderSeq = 0;
    this.tab = storedTab();
    this.soundfonts = new SoundfontSection();
    // A sign-in window finishing, or a sign-out in any tab.
    onAuthChange(() => this.refresh());
  }

  /** Bring up a subtab ("projects" | "soundfonts"). */
  setTab(tab) {
    if (!TABS.includes(tab)) return;
    this.tab = tab;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* a convenience only */ }
    this.refresh();
  }

  /** Show a local folder ("" the top). */
  openFolder(folder) {
    if (folder !== this.folder) this.selected.clear();
    this.folder = folder;
    try { localStorage.setItem(FOLDER_KEY, folder); } catch { /* a convenience only */ }
    this.refresh();
  }

  _tabBar() {
    const bar = document.createElement("div");
    bar.className = "subtabs files-tabs";
    bar.setAttribute("role", "tablist");
    for (const [tab, key] of [["projects", "files.tabProjects"], ["soundfonts", "files.tabSoundfonts"]]) {
      const b = mkBtn(t(key), () => this.setTab(tab));
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(tab === this.tab));
      if (tab === this.tab) b.className = "active";
      bar.append(b);
    }
    return bar;
  }

  async refresh() {
    if (this.tab === "soundfonts") {
      ++this._renderSeq; // a projects refresh still on its way gives way
      this.root.replaceChildren(this._tabBar(), this.soundfonts.el);
      await this.soundfonts.render();
      return;
    }
    this.soundfonts.render(false);
    // Refreshes overlap — a sign-out both tells every tab (this one included)
    // and asks for one directly — and each waits on the disk listing half-way.
    // So the page is built off-screen and put up in ONE step, by the newest
    // refresh only: an older one that finishes late simply gives way, instead
    // of adding its table under the newer one's.
    const seq = ++this._renderSeq;
    const newest = () => seq === this._renderSeq;
    const ok = await opfs.available();
    const { doc } = this.cb.currentDoc();
    const page = [];
    const ui = { boxes: new Map() };

    const bar = document.createElement("div");
    bar.className = "files-bar";
    const saveBtn = mkBtn(t("files.save"), () => this.save());
    const saveAsBtn = mkBtn(t("files.saveAs"), () => this.saveAs());
    const importBtn = mkBtn(t("files.import"), () => this.import());
    const importMidiBtn = mkBtn(t("files.importMidi"), async () => {
      await this.cb.importMidi(this.folder);
      this.refresh();
    });
    // Demos are reachable from the welcome screen too, but that screen is gone
    // the moment anything is loaded — this is the way back to them (item 163).
    const demoBtn = mkBtn(t("files.demos"), () => this.demos());
    const exportBtn = mkBtn("", () => this.export());
    setIconLabel(exportBtn, "download", t("files.export"), { after: true });
    const wavBtn = mkBtn(t("files.exportWav"), () => this.exportWav());
    const stemsBtn = mkBtn(t("files.exportStems"), () => this.exportStems());
    const modBtn = mkBtn(t("files.exportMod"), () => this.exportMod());
    modBtn.title = t("files.exportModTitle");
    // …and the one action that is about the DISK rather than the document
    // (item 198.2): every project in this browser, in one archive. Enabled
    // below, once the listing says there is something to put in it.
    const allBtn = mkBtn("", () => this.downloadAll());
    setIconLabel(allBtn, "download", t("files.downloadAll"), { after: true });
    allBtn.title = t("files.downloadAllTitle");
    allBtn.disabled = true;
    // doc-scoped actions grey out until something is loaded
    for (const b of [saveBtn, saveAsBtn, exportBtn, wavBtn, stemsBtn, modBtn]) b.disabled = !doc;
    bar.append(saveBtn, saveAsBtn, importBtn, importMidiBtn, demoBtn, exportBtn, wavBtn, stemsBtn, modBtn, allBtn);
    page.push(bar);

    if (!ok) {
      const warn = document.createElement("p");
      warn.className = "files-warn";
      warn.textContent = t("files.opfsWarn");
      page.push(warn);
    } else {
      const tree = await opfs.tree();
      allBtn.disabled = tree.files.length === 0;
      // A remembered folder that is gone now (deleted in another tab, say).
      if (this.folder && !tree.folders.includes(this.folder)) {
        this.folder = "";
        this.selected.clear();
      }
      // The bar and the tick column show only in selection mode — a class on
      // this wrapper, so going in and out redraws nothing.
      ui.wrap = document.createElement("div");
      ui.wrap.className = "files-selwrap";
      ui.wrap.append(this._selectionBar(tree, ui), this._localTable(tree, ui));
      page.push(this._crumbs(ui), ui.wrap);
      const disclaimer = document.createElement("p");
      disclaimer.className = "files-disclaimer";
      disclaimer.textContent = t("files.disclaimer");
      page.push(disclaimer);
    }

    if (!newest()) return;
    this.root.replaceChildren(this._tabBar(), ...page, this.onlineHost);
    this.selUi = ok ? ui : null;
    this._syncSelection();

    // Last, and on its own clock: the local list is already on screen while
    // the server answers, and the same rule keeps a slow answer from painting
    // over what a newer refresh put there.
    await this.online.render(this.onlineHost, newest)
      .catch((err) => console.error("Online projects:", err));
    if (newest()) this._syncSelection(); // Move online needs someone signed in
  }

  // ── the local list ──

  /** "Projects › A › B", each step a way back up; New folder… on the right. */
  _crumbs(ui) {
    const bar = document.createElement("div");
    bar.className = "files-crumbs";
    const trail = document.createElement("nav");
    trail.className = "files-crumbs-trail";
    trail.setAttribute("aria-label", t("files.folderTrail"));
    const parts = this.folder ? this.folder.split("/") : [];
    const steps = [["", t("files.folderTop")], ...parts.map((p, i) => [parts.slice(0, i + 1).join("/"), p])];
    steps.forEach(([path, label], i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "files-crumbs-sep";
        sep.textContent = "›";
        sep.setAttribute("aria-hidden", "true");
        trail.append(sep);
      }
      const b = mkBtn(label, () => this.openFolder(path));
      b.className = "files-name";
      if (i === steps.length - 1) {
        b.classList.add("files-current");
        b.setAttribute("aria-current", "location");
      }
      trail.append(b);
    });
    const newFolder = mkBtn("", () => this.newFolder());
    setIconLabel(newFolder, "folderPlus", t("files.newFolder"));
    ui.selectBtn = mkBtn(t("files.select"), () => this._setSelecting(!this.selecting));
    ui.selectBtn.title = t("files.selectTitle");
    bar.append(trail, ui.selectBtn, newFolder);
    return bar;
  }

  /** What to do with the ticked projects; there whether or not any are, so
   *  ticking one does not shift the table down. */
  _selectionBar(tree, ui) {
    const here = new Set(this._projectsHere(tree).map((e) => e.name));
    for (const path of this.selected) if (!here.has(path)) this.selected.delete(path);
    ui.paths = [...here];
    // Somewhere else to move to: another folder, or the top from inside one.
    ui.elsewhere = tree.folders.length > 0 || this.folder !== "";
    const bar = document.createElement("div");
    bar.className = "files-bar files-selbar";
    ui.count = document.createElement("span");
    ui.count.className = "files-selcount";
    ui.count.setAttribute("aria-live", "polite");
    ui.move = mkBtn(t("files.moveTo"), () => this.moveSelected());
    ui.move.title = t("files.moveToTitle");
    ui.moveOnline = mkBtn(t("files.moveOnline"), () => this.moveSelectedOnline());
    ui.moveOnline.title = t("files.moveOnlineTitle");
    ui.del = mkBtn("", () => this.deleteSelected());
    setIconLabel(ui.del, "close", t("common.delete"));
    ui.del.title = t("files.deleteSelectedTitle");
    bar.append(ui.count, ui.move, ui.moveOnline, ui.del);
    return bar;
  }

  /**
   * Bring the selection's controls into line with `this.selected`, in place:
   * a tick changes nothing on disk, so it does not redraw the view (which
   * would ask the server for the online list again). Move online asks the
   * online list for room, so it is offered only while someone is signed in
   * there.
   */
  _syncSelection() {
    const ui = this.selUi;
    if (!ui) return;
    ui.wrap.classList.toggle("files-selecting", this.selecting);
    ui.selectBtn.textContent = this.selecting ? t("files.selectDone") : t("files.select");
    ui.selectBtn.setAttribute("aria-pressed", String(this.selecting));
    // Nothing here to tick: no way in (but always the way out).
    ui.selectBtn.hidden = !this.selecting && ui.paths.length === 0;
    const n = this.selected.size;
    ui.count.textContent = n ? t("files.selected", { n }) : t("files.selectHint");
    ui.move.disabled = n === 0 || !ui.elsewhere;
    ui.moveOnline.hidden = !this.online.signedIn;
    ui.moveOnline.disabled = n === 0;
    ui.del.disabled = n === 0;
    for (const [path, box] of ui.boxes) box.checked = this.selected.has(path);
    if (ui.all) {
      const ticked = ui.paths.filter((p) => this.selected.has(p)).length;
      ui.all.checked = ticked > 0 && ticked === ui.paths.length;
      ui.all.indeterminate = ticked > 0 && ticked < ui.paths.length;
    }
  }

  /** Selection mode on or off; off forgets the ticks. */
  _setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    this._syncSelection();
  }

  /** The projects (not folders) in the folder on show. */
  _projectsHere(tree) {
    return tree.files.filter((e) => opfs.splitPath(e.name).folder === this.folder);
  }

  _localTable(tree, ui) {
    const table = document.createElement("table");
    table.className = "files-table files-local";
    const projects = this._projectsHere(tree);
    const folders = tree.folders.filter((f) => opfs.splitPath(f).folder === this.folder);

    const head = document.createElement("thead");
    const hr = document.createElement("tr");
    const allTh = document.createElement("th");
    allTh.className = "files-check";
    if (projects.length > 0) {
      const all = ui.all = checkbox(t("files.selectAll"));
      all.addEventListener("change", () => {
        for (const e of projects) all.checked ? this.selected.add(e.name) : this.selected.delete(e.name);
        this._syncSelection();
      });
      allTh.append(all);
    }
    hr.append(allTh);
    for (const key of ["files.colProject", "files.colSize", "files.colModified", null]) {
      const th = document.createElement("th");
      if (key) th.textContent = t(key);
      hr.append(th);
    }
    head.append(hr);
    table.append(head);

    const tbody = document.createElement("tbody");
    if (this.folder) {
      // The way up, as the first row: where a list of folders is read from.
      const parent = opfs.splitPath(this.folder).folder;
      const tr = document.createElement("tr");
      tr.className = "files-folder files-up";
      const nameTd = document.createElement("td");
      const up = mkBtn("", () => this.openFolder(parent));
      setIconLabel(up, "folderUp", "..");
      up.className = "files-name";
      up.title = t("files.folderUp", { name: parent ? opfs.splitPath(parent).name : t("files.folderTop") });
      nameTd.append(up);
      tr.append(checkCell(), nameTd, document.createElement("td"),
        document.createElement("td"), document.createElement("td"));
      tbody.append(tr);
    }
    if (projects.length === 0 && folders.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "dim";
      td.textContent = this.folder ? t("files.folderEmpty") : t("files.none");
      tr.append(td);
      tbody.append(tr);
    }
    // Folders first, always.
    for (const path of folders) tbody.append(this._folderRow(path, tree));
    // An open ONLINE project is not the local file that shares its name.
    const openHere = this.store.onlineProject ? null : this.store.localPath;
    for (const e of projects) tbody.append(this._projectRow(e, e.name === openHere, ui));
    table.append(tbody);
    return table;
  }

  _folderRow(path, tree) {
    const name = opfs.splitPath(path).name;
    const inside = tree.files.filter((e) => e.name.startsWith(path + "/"));
    const tr = document.createElement("tr");
    tr.className = "files-folder";
    const nameTd = document.createElement("td");
    const nameBtn = mkBtn("", () => this.openFolder(path));
    setIconLabel(nameBtn, "folder", name);
    nameBtn.className = "files-name";
    nameBtn.title = t("files.folderOpen", { name });
    nameTd.append(nameBtn);
    const sizeTd = document.createElement("td");
    sizeTd.className = "dim";
    sizeTd.textContent = t("files.folderCount", { n: inside.length });
    const timeTd = document.createElement("td");
    // A folder's date is its newest project's: OPFS keeps none for directories.
    const newestTime = Math.max(0, ...inside.map((e) => e.mtime));
    if (newestTime > 0) timeTd.textContent = new Date(newestTime).toLocaleString();
    const td = document.createElement("td");
    const renameBtn = iconBtn("rename", () => this.renameFolder(path));
    renameBtn.title = t("common.rename");
    const deleteBtn = iconBtn("close", () => this.deleteFolder(path, inside.length));
    deleteBtn.title = t("common.delete");
    td.append(mkBtn(t("files.open"), () => this.openFolder(path)), renameBtn, deleteBtn);
    tr.append(checkCell(), nameTd, sizeTd, timeTd, td); // a folder is not ticked
    return tr;
  }

  _projectRow(e, current, ui) {
    const name = opfs.splitPath(e.name).name;
    const tr = document.createElement("tr");
    const open = async () => {
      await this.cb.openBytes(name, await opfs.read(e.name), { folder: this.folder });
      this.refresh();
    };
    const checkTd = document.createElement("td");
    checkTd.className = "files-check";
    const box = checkbox(t("files.selectOne", { name }));
    ui.boxes.set(e.name, box);
    box.addEventListener("change", () => {
      box.checked ? this.selected.add(e.name) : this.selected.delete(e.name);
      this._syncSelection();
    });
    checkTd.append(box);
    // The name IS the Open control (item 198.1) — a list of files invites a
    // click on the file, and the row's Open button had been the only thing
    // that answered one. A <button> rather than a styled <td>, so it keeps
    // the keyboard and the screen reader the button already gave.
    const nameTd = document.createElement("td");
    const nameBtn = mkBtn("", open);
    setIconLabel(nameBtn, "file", name);
    nameBtn.className = "files-name" + (current ? " files-current" : "");
    nameBtn.title = t("files.openTitle", { name });
    nameTd.appendChild(nameBtn);
    const sizeTd = document.createElement("td");
    sizeTd.textContent = `${(e.size / 1024).toFixed(1)} K`;
    const timeTd = document.createElement("td");
    timeTd.textContent = new Date(e.mtime).toLocaleString();
    const td = document.createElement("td");
    const renameBtn = iconBtn("rename", () => this.rename(e.name));
    renameBtn.title = t("common.rename");
    td.append(
      mkBtn(t("files.open"), open),
      renameBtn,
      iconBtn("download", async () => download(await opfs.read(e.name), name)),
      iconBtn("close", async () => {
        const yes = await showModal({ title: t("files.deleteAsk", { name }), okLabel: t("common.delete") });
        if (yes) {
          await opfs.remove(e.name);
          this.selected.delete(e.name);
          this.refresh();
        }
      }),
    );
    tr.append(checkTd, nameTd, sizeTd, timeTd, td);
    return tr;
  }

  // ── folders ──

  /** Ask for a name that can be a new entry of `folder`; null when declined.
   *  A name that cannot be used, or is taken, is said and asked again. */
  async askName({ title, value = "", okLabel, folder, ext = "", keep = null }) {
    for (;;) {
      const result = await showModal({ title, fields: [{ name: "name", label: t("files.name"), value }], okLabel });
      if (!result) return null;
      let name = (result.name ?? "").trim();
      if (!name) return null;
      if (ext && !name.endsWith(ext)) name += ext;
      if (name === keep) return null;
      value = name;
      if (!opfs.validName(name)) {
        await showNotice({ title: t("files.badName", { name }), okLabel: t("common.ok") });
        continue;
      }
      if (await opfs.exists(opfs.joinPath(folder, name))) {
        await showNotice({ title: t("files.renameExists", { name }), okLabel: t("common.ok") });
        continue;
      }
      return name;
    }
  }

  async newFolder() {
    const name = await this.askName({
      title: t("files.newFolderTitle"), okLabel: t("common.create"), folder: this.folder,
    });
    if (!name) return;
    await opfs.makeFolder(opfs.joinPath(this.folder, name));
    this.refresh();
  }

  async renameFolder(path) {
    const { folder, name: old } = opfs.splitPath(path);
    const name = await this.askName({
      title: t("files.renameTitle", { name: old }), value: old, okLabel: t("common.rename"), folder, keep: old,
    });
    if (!name) return;
    const to = opfs.joinPath(folder, name);
    const ok = await withBusy(t("files.movingFolder", { name: old }), async () => {
      await opfs.renameFolder(path, to);
      return true;
    });
    if (!ok) return this.refresh();
    const within = (f) => f === path || f.startsWith(path + "/");
    // The open project goes with its folder.
    if (!this.store.onlineProject && within(this.store.folder)) {
      this.store.folder = to + this.store.folder.slice(path.length);
      this.store.emit("status");
    }
    // …and so does the view, when it was showing it (or a folder inside it).
    if (within(this.folder)) this.openFolder(to + this.folder.slice(path.length));
    else this.refresh();
  }

  async deleteFolder(path, count) {
    const name = opfs.splitPath(path).name;
    const yes = await showModal({
      title: count ? t("files.deleteFolderAsk", { name, n: count }) : t("files.deleteEmptyFolderAsk", { name }),
      okLabel: t("common.delete"),
    });
    if (!yes) return;
    await opfs.removeFolder(path);
    this.refresh();
  }

  /** Move the ticked projects into another folder. One with a name already
   *  taken there stays where it is, and is named afterwards. */
  async moveSelected() {
    const paths = [...this.selected];
    if (paths.length === 0) return;
    const { folders } = await opfs.tree();
    const options = ["", ...folders].filter((f) => f !== this.folder)
      .map((f) => ({ value: f, label: f ? f.split("/").join(" › ") : t("files.folderTop") }));
    if (options.length === 0) return;
    const result = await showModal({
      title: t("files.moveToAsk", { n: paths.length }),
      fields: [{ name: "to", label: t("files.moveToField"), type: "select", value: options[0].value, options }],
      okLabel: t("files.move"),
    });
    if (!result) return;
    const to = result.to ?? "";
    const skipped = [];
    await withBusy(t("files.moving", { n: paths.length }), async (progress) => {
      for (const [i, path] of paths.entries()) {
        progress.set(i / paths.length);
        const name = opfs.splitPath(path).name;
        const dest = opfs.joinPath(to, name);
        if (await opfs.exists(dest)) { skipped.push(t("files.skipExists", { name })); continue; }
        await opfs.rename(path, dest);
        this.selected.delete(path);
        if (!this.store.onlineProject && this.store.localPath === path) {
          this.store.folder = to; // the open project follows its file
          this.store.emit("status");
        }
      }
    });
    this.refresh();
    if (skipped.length) await this.online.reportSkipped(skipped);
  }

  /** Delete the ticked projects, after one question that names them. */
  async deleteSelected() {
    const paths = [...this.selected];
    if (paths.length === 0) return;
    const yes = await showModal({
      title: t("files.deleteManyAsk", { n: paths.length }),
      body: nameList(paths.map((p) => opfs.splitPath(p).name)),
      okLabel: t("common.delete"),
    });
    if (!yes) return;
    await withBusy(t("files.deleting", { n: paths.length }), async (progress) => {
      for (const [i, path] of paths.entries()) {
        progress.set(i / paths.length);
        await opfs.remove(path);
        this.selected.delete(path);
      }
    });
    this.refresh();
  }

  /** Move the ticked projects online: each is uploaded, and deleted here once
   *  the server has it. */
  async moveSelectedOnline() {
    const paths = [...this.selected];
    if (paths.length === 0) return;
    const moved = await this.online.adoptLocal(paths);
    for (const path of moved) this.selected.delete(path);
    this.refresh();
  }


  async save() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    // A project opened from (or saved to) the online section goes back there.
    if (this.store.onlineProject) return this.online.saveOver();
    if (!fileName) return this.saveAs();
    const path = this.store.localPath;
    // The bytes take a moment to compress; an edit made meanwhile is not in
    // them, and must not be marked saved when they land.
    await withSaveProgress(this.store, async (progress) => {
      const serial = doc.editSerial;
      await opfs.write(path, await doc.toSaveBytes(ZSTD_LEVEL_SAVE, progress));
      if (doc.editSerial === serial) doc.dirty = false;
    });
    this.store.emit("saved", path);
    this.refresh();
  }

  /** Save the open project under a new name, into the folder on show. */
  async saveAs() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const folder = this.folder;
    let value = fileName ?? "untitled.taud";
    let name;
    for (;;) {
      const result = await showModal({
        title: t("files.saveAsTitle"),
        body: folder ? t("files.saveAsIn", { folder: folder.split("/").join(" › ") }) : null,
        fields: [{ name: "name", label: t("files.name"), value }],
        okLabel: t("common.save"),
      });
      if (!result || !result.name?.trim()) return;
      name = result.name.trim();
      if (!name.endsWith(".taud")) name += ".taud";
      if (opfs.validName(name)) break;
      value = name;
      await showNotice({ title: t("files.badName", { name }), okLabel: t("common.ok") });
    }
    const path = opfs.joinPath(folder, name);
    await withSaveProgress(this.store, async (progress) => {
      const serial = doc.editSerial;
      await opfs.write(path, await doc.toSaveBytes(ZSTD_LEVEL_SAVE, progress));
      if (doc.editSerial === serial) doc.dirty = false;
    });
    this.store.fileName = name;
    this.store.folder = folder;
    this.store.online = null; // a local copy: the document lives in this browser now
    this.store.emit("saved", path);
    this.refresh();
  }

  /** Rename an OPFS project file (item 80). If it is the currently-open file,
   *  the status-bar filename follows so a later Save targets the new name. */
  async rename(path) {
    const { folder, name: oldName } = opfs.splitPath(path);
    const name = await this.askName({
      title: t("files.renameTitle", { name: oldName }), value: oldName, okLabel: t("common.rename"),
      folder, ext: ".taud", keep: oldName,
    });
    if (!name) return;
    const to = opfs.joinPath(folder, name);
    await opfs.rename(path, to);
    if (this.selected.delete(path)) this.selected.add(to);
    if (this.store.localPath === path && !this.store.onlineProject) {
      this.store.fileName = name;
      this.store.emit("status"); // status-bar filename follows the rename
    }
    this.refresh();
  }

  async import() {
    // no .mid here — MIDI import (with its soundfont choice) is its own button
    const file = await pickFile(".taud,.tsii,.tpif,.mtsk,.tml," +
      CONVERT_ACCEPT.split(",").filter((e) => !e.startsWith(".mid")).join(","));
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Foreign formats are converted by openBytes → the user saves the RESULT;
    // only native containers land in OPFS verbatim. An IMAC is foreign too —
    // the song chosen from inside it is what gets converted — and so is a
    // Touch sketch, which opens as the project it stands for.
    // A Motif program builds a project; the project is what gets saved.
    // Either way it lands in the folder on show, which is where a Save puts it.
    if (!converterFor(file.name) && !isImac(bytes) && !isSketch(bytes) && !/\.tml$/i.test(file.name) &&
        await opfs.available()) {
      await opfs.write(opfs.joinPath(this.folder, file.name), bytes);
    }
    await this.cb.openBytes(file.name, bytes, { folder: this.folder });
    this.refresh();
  }

  /** Pick one of the bundled demo songs and load it (item 163). Nothing lands
   *  in OPFS — a demo is read from assets/ every time, and only a Save the user
   *  asks for makes a local copy of it. */
  async demos() {
    const entry = await showDemoPicker();
    if (!entry) return;
    await this.cb.openDemo?.(entry);
    this.refresh();
  }

  async export() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const bytes = await withSaveProgress(this.store, (progress) => doc.toSaveBytes(ZSTD_LEVEL_SAVE, progress));
    download(bytes, fileName ?? "untitled.taud");
  }

  /**
   * Every project in OPFS, zipped (item 198.2) — the backup the browser's own
   * storage does not give you. Folders go in as the archive's folders. Bytes go in VERBATIM: a .taud is already a
   * compressed container, so the archive is stored rather than deflated and
   * costs a copy rather than a re-encode.
   *
   * Read one file at a time with a yield between, so a disk holding a hundred
   * projects still paints its progress bar; the unsaved document in memory is
   * NOT included — Save first, or use Export for that one.
   */
  async downloadAll() {
    const entries = await opfs.list();
    if (entries.length === 0) return;
    const progress = showProgress(t("files.zipAll", { n: entries.length }), { cancellable: true });
    const zip = new StemZip();
    let chunks;
    try {
      for (let i = 0; i < entries.length; i++) {
        if (progress.signal.aborted) { progress.done(); return; }
        zip.addFile(entries[i].name, await opfs.read(entries[i].name));
        progress.set((i + 1) / entries.length);
        await new Promise((r) => setTimeout(r, 0)); // let the bar paint
      }
      chunks = zip.finish();
    } catch (err) {
      progress.fail(err.message ?? String(err));
      console.error("Project archive failed:", err);
      return;
    }
    progress.done();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob(chunks, { type: "application/zip" }),
      `microtone-projects-${stamp}.zip`);
  }

  /**
   * Offline-render the current song through the engine to an audio file
   * (#998.4). Stereo stays the fold it always was, clean (16-bit) or gritty
   * (the device's 8-bit); the surround and
   * ambisonic targets re-render the same song with a different SpatialRenderer
   * installed and carry ADM metadata so the channels mean something.
   */
  async exportWav() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const songIndex = this.cb.songIndex?.() ?? 0;
    const song = doc.songs[songIndex];
    const surroundModel = song?.surroundModel ?? 0;
    const { showExportAudio } = await import("../popups/exportaudio.js");
    const { masteringEngaged } = await import("../../../core/engine/mastering.js");
    const choice = await showExportAudio({
      surroundModel,
      // A multichannel target is written from the object bus, upstream of the
      // mastering chain — worth saying, but only to someone who has one.
      mastered: masteringEngaged(doc.mastering(songIndex)),
      defaults: {
        format: this._lastExport?.format ?? (surroundModel === 2 ? "ambix3" : surroundModel === 1 ? "5.1" : "stereo"),
        outRate: this._lastExport?.outRate ?? 48000,
        cap: this._lastExport?.cap ?? 300,
        monitor: this._lastExport?.monitor,
        quality: this._lastExport?.quality,
      },
    });
    if (!choice) return;
    this._lastExport = choice; // the next export starts where this one left off
    const base = (fileName ?? "untitled.taud").replace(/\.taud$/, "");
    // The song's own name reaches the ADM metadata; the file name is the fallback.
    const title = unescapeName(doc.meta?.songMeta?.[songIndex]?.name ?? "") || base;
    const progress = showProgress(t("files.wavRendering"), { cancellable: true });
    const t0 = performance.now();

    if (choice.format === "stereo") {
      let wav;
      try {
        wav = await renderToWavAsync(doc.toRenderable(songIndex), songIndex, choice.cap, {
          outRate: choice.outRate, monitor: choice.monitor, quality: choice.quality,
          onProgress: (f) => progress.set(f), signal: progress.signal,
        });
      } catch (err) {
        progress.fail(err.message ?? String(err));
        console.error("WAV render failed:", err);
        return;
      }
      if (wav.aborted) { progress.done(); return; } // user cancelled
      progress.done();
      console.info(`WAV render: ${wav.seconds.toFixed(1)}s in ${(performance.now() - t0).toFixed(0)}ms (halted=${wav.halted})`);
      download(wav.bytes, `${base}.wav`);
      return;
    }

    const { renderMultichannelAsync, exportFileSuffix } = await import("../../audio/surround-export.js");
    let render;
    try {
      render = await renderMultichannelAsync(doc.toRenderable(songIndex), songIndex, choice.cap, {
        format: choice.format, outRate: choice.outRate, title,
        onProgress: (f) => progress.set(f), signal: progress.signal,
      });
    } catch (err) {
      progress.fail(err.message ?? String(err));
      console.error("Surround render failed:", err);
      return;
    }
    if (render.aborted) { progress.done(); return; }
    progress.done();
    const bytes = render.blocks.reduce((n, b) => n + b.length, 0);
    console.info(`${choice.format} render: ${render.seconds.toFixed(1)}s, ${render.channels} ch, ` +
      `${(bytes / 1048576).toFixed(1)} MiB in ${(performance.now() - t0).toFixed(0)}ms (halted=${render.halted})`);
    downloadBlob(new Blob(render.blocks, { type: "audio/wav" }),
      `${base}${exportFileSuffix(choice.format)}`);
  }

  /**
   * Offline-render the current song into one 24-bit 48 kHz mono WAV per track
   * (item 93), zipped. Per-instrument splits a percussion kit into its pieces;
   * per-lane gives one track per lane. Tracks are PRE-PAN: every volume is
   * baked in, the pan law is not — you re-pan them in the DAW.
   */
  async exportStems() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const base = sanitiseName((fileName ?? "untitled.taud").replace(/\.taud$/, ""), "song");

    let prefix = "";
    let mode = "instrument";
    let cap = 300;
    for (;;) {
      const result = await showModal({
        title: t("files.stemsTitle"),
        body: t("files.stemsBody"),
        fields: [
          { name: "prefix", label: t("files.stemsPrefix"), value: prefix || base },
          {
            name: "mode", label: t("files.stemsMode"), type: "select", value: mode,
            options: [
              { value: "instrument", label: t("files.stemsPerInst") },
              { value: "voice", label: t("files.stemsPerVoice") },
            ],
          },
          { name: "cap", label: t("files.wavCap"), type: "number", value: cap, min: 1, max: 3600 },
        ],
        okLabel: t("files.render"),
      });
      if (!result) return;
      prefix = sanitiseName(result.prefix ?? "", "");
      mode = result.mode === "voice" ? "voice" : "instrument";
      cap = Math.min(Math.max(parseInt(result.cap || "300", 10), 1), 3600);
      if (prefix) break;
      // The prefix is the one mandatory option — ask again rather than guess.
      await showNotice({ title: t("files.stemsNeedPrefix"), okLabel: t("common.ok") });
    }

    const songIndex = this.cb.songIndex?.() ?? 0;
    const progress = showProgress(t("files.stemsRendering"), { cancellable: true });
    const t0 = performance.now();
    let render;
    try {
      render = await renderStemsAsync(doc.toRenderable(songIndex), songIndex, cap, {
        mode,
        // The render is the long pole; leave the last 15% for encode + zip.
        onProgress: (f) => progress.set(f * 0.85),
        signal: progress.signal,
      });
    } catch (err) {
      progress.fail(err.message ?? String(err));
      console.error("Stem render failed:", err);
      return;
    }
    if (render.aborted) { progress.done(); return; }
    if (render.stems.length === 0) {
      progress.fail(t("files.stemsEmpty", { n: render.seconds.toFixed(0) }));
      return;
    }

    labelStems(render.stems, doc, mode);
    const zip = new StemZip();
    let chunks;
    try {
      for (let i = 0; i < render.stems.length; i++) {
        const stem = render.stems[i];
        zip.addFile(stemFileName(prefix, i + 1, stem.label), encodeWav24Mono(stem.buf));
        stem.buf = null; // free each track as it lands in the archive
        progress.set(0.85 + (0.15 * (i + 1)) / render.stems.length);
        await new Promise((r) => setTimeout(r, 0)); // let the bar paint
      }
      chunks = zip.finish();
    } catch (err) {
      progress.fail(err.message ?? String(err));
      console.error("Stem packing failed:", err);
      return;
    }
    progress.done();
    const bytes = chunks.reduce((a, c) => a + c.length, 0);
    console.info(`Stems: ${render.stems.length} tracks, ${render.seconds.toFixed(1)}s, ` +
      `${(bytes / 1048576).toFixed(1)} MiB in ${(performance.now() - t0).toFixed(0)}ms`);
    downloadBlob(new Blob(chunks, { type: "application/zip" }), `${prefix}-stems.zip`);
  }

  /**
   * Every song as a four-channel ProTracker module (item 219), one .mod each —
   * zipped when there is more than one. What the export found is shown first:
   * a song that fails a prerequisite stops it, anything a module will not keep
   * is said before it is saved, and a clean export saves straight away.
   */
  async exportMod() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const { exportModSongs, modFileName } = await import("../../convert/modexport.js");
    const results = exportModSongs(doc);
    if (results.some((r) => r.bytes === null || r.warnings.length > 0)) {
      const { showModExport } = await import("../popups/exportmod.js");
      if (!(await showModExport(results))) return;
    }
    // A project opened from a module may still carry its name.
    const base = sanitiseName((fileName ?? "untitled.taud").replace(/\.(taud|mod)$/i, ""), "song");
    if (results.length === 1) {
      download(results[0].bytes, modFileName(base, 0, 1));
      return;
    }
    const zip = new StemZip();
    for (const r of results) zip.addFile(modFileName(base, r.songIndex, results.length), r.bytes);
    downloadBlob(new Blob(zip.finish(), { type: "application/zip" }), `${base}-mod.zip`);
  }
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** The same, labelled with a vector icon instead of a symbol (item 107). */
function iconBtn(name, onClick) {
  const b = mkBtn("", onClick);
  setIconLabel(b, name);
  return b;
}

/** The tick column's cell, empty: it hides with the column outside
 *  selection mode, as every cell of that column must. */
function checkCell() {
  const td = document.createElement("td");
  td.className = "files-check";
  return td;
}

/** A row's tick box, named for the screen reader by `label`. */
function checkbox(label) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.setAttribute("aria-label", label);
  return box;
}

/** Run a job of several disk steps behind a progress popup (held back, so a
 *  quick one never shows it). → the job's result, or undefined when it threw,
 *  the popup then saying why. */
async function withBusy(title, job) {
  const progress = showProgress(title, { holdBack: true });
  try {
    const out = await job(progress);
    progress.done();
    return out;
  } catch (err) {
    progress.fail(err.message ?? String(err));
    console.error(`Files: ${title}`, err);
    return undefined;
  }
}
