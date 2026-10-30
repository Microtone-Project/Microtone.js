// The File view's Soundfonts tab — the soundfont library (sflibrary.js):
// soundfonts added here are converted in the background and kept in this
// browser, each with a note its owner can leave on it, and Instruments → New…
// offers them beside the bundled GeneralUser GS.
//
// One section per File view copy; all of them draw the same library. A change
// to the list redraws the table; a running conversion's progress only moves its
// own bar. A note being typed survives a redraw (a conversion finishing under
// it), focus, caret and all.

import {
  librarySoundfonts, libraryJobs, addSoundfontFiles, cancelJob, setSoundfontNote,
  removeSoundfont, downloadSoundfont, onLibraryChange, onJobProgress,
} from "../sflibrary.js";
import * as opfs from "../../storage/opfs.js";
import { pickFiles } from "../../storage/import-export.js";
import { showModal } from "../components/modal.js";
import { setIconLabel } from "../icons.js";
import { t } from "../i18n.js";

export class SoundfontSection {
  constructor() {
    this.el = document.createElement("section");
    this.el.className = "files-soundfonts";
    this._seq = 0;
    this._shown = false;
    onLibraryChange(() => { if (this._shown) this.render(); });
    onJobProgress((job) => this._progress(job));
  }

  /** Draw the tab (again). `shown` false stops redraws while another tab is up. */
  async render(shown = true) {
    this._shown = shown;
    if (!shown) return;
    const seq = ++this._seq;
    const ok = await opfs.available();
    const fonts = ok ? await librarySoundfonts() : [];
    if (seq !== this._seq) return; // a newer render is on its way

    const bar = document.createElement("div");
    bar.className = "files-bar";
    const add = button(t("sf.add"), () => this.add());
    add.title = t("sf.addTitle");
    add.disabled = !ok;
    bar.append(add);

    const blurb = el("p", "files-blurb", t("sf.blurb"));
    const parts = [bar, blurb];
    if (!ok) {
      parts.push(el("p", "files-warn", t("files.opfsWarn")));
    } else {
      const table = document.createElement("table");
      table.className = "files-table sf-table";
      const head = document.createElement("tr");
      for (const key of ["sf.colName", "sf.colNote", "files.colSize", "sf.colAdded"]) head.append(el("th", "", t(key)));
      head.append(el("th", "", ""));
      table.createTHead().append(head);
      const body = table.createTBody();
      const jobs = libraryJobs();
      for (const job of jobs) body.append(this._jobRow(job));
      for (const sf of fonts) body.append(this._fontRow(sf));
      if (jobs.length === 0 && fonts.length === 0) {
        const tr = document.createElement("tr");
        const td = el("td", "dim", t("sf.none"));
        td.colSpan = 5;
        tr.append(td);
        body.append(tr);
      }
      parts.push(table);
    }
    const cli = el("p", "files-disclaimer", t("sf.cliHint") + " ");
    const link = el("a", "", t("sf.cliLink"));
    link.href = new URL("../../../sf2taudify.py", import.meta.url).href;
    link.download = "sf2taudify.py";
    cli.append(link);
    parts.push(cli, el("p", "files-disclaimer", t("sf.disclaimer")));

    // Keep a note that is being typed: the table is rebuilt under it.
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
  }

  async add() {
    const files = await pickFiles(".sf2,.gz");
    if (files.length === 0) return;
    await addSoundfontFiles(files, {
      confirmReplace: (title) => showModal({ title: t("sf.replaceAsk", { name: title }), okLabel: t("sf.replace") }),
    });
  }

  _fontRow(sf) {
    const tr = document.createElement("tr");
    const name = el("td", "sf-name", sf.title);
    if (sf.source) name.title = t("sf.madeFrom", { name: sf.source });
    const noteTd = document.createElement("td");
    const note = document.createElement("input");
    note.type = "text";
    note.className = "sf-note";
    note.dataset.file = sf.file;
    note.value = sf.note;
    note.maxLength = 500;
    note.placeholder = t("sf.notePlaceholder");
    note.setAttribute("aria-label", t("sf.noteLabel", { name: sf.title }));
    // Saved when the field is left or Enter is pressed; Esc puts it back.
    note.addEventListener("change", () => setSoundfontNote(sf.file, note.value));
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter") note.blur();
      else if (e.key === "Escape") { note.value = sf.note; note.blur(); }
    });
    noteTd.append(note);
    const actions = document.createElement("td");
    const dl = iconButton("download", () => downloadSoundfont(sf.file));
    dl.title = t("sf.download");
    const del = iconButton("close", async () => {
      if (await showModal({ title: t("files.deleteAsk", { name: sf.title }), okLabel: t("common.delete") })) {
        await removeSoundfont(sf.file);
      }
    });
    del.title = t("common.delete");
    actions.append(dl, del);
    tr.append(name, noteTd, el("td", "", mib(sf.size)), el("td", "", new Date(sf.mtime).toLocaleString()), actions);
    return tr;
  }

  _jobRow(job) {
    const tr = document.createElement("tr");
    tr.className = "sf-job";
    tr.dataset.job = job.id;
    const state = document.createElement("td");
    state.colSpan = 3;
    const bar = document.createElement("progress");
    bar.max = 1;
    if (job.state === "converting") bar.value = job.progress; // indeterminate while it waits
    const label = el("span", "sf-job-state", jobLabel(job));
    state.append(bar, label);
    const actions = document.createElement("td");
    const cancel = iconButton("close", () => cancelJob(job.id));
    cancel.title = t("sf.stopJob", { name: job.title });
    actions.append(cancel);
    tr.append(el("td", "sf-name", job.title), state, actions);
    return tr;
  }

  /** A running job's bar and label, written only when they moved. */
  _progress(job) {
    const tr = this.el.querySelector(`tr.sf-job[data-job="${job.id}"]`);
    if (!tr) return;
    const bar = tr.querySelector("progress");
    if (bar.value !== job.progress) bar.value = job.progress;
    const label = tr.querySelector(".sf-job-state");
    const text = jobLabel(job);
    if (label.textContent !== text) label.textContent = text;
  }
}

function jobLabel(job) {
  return job.state === "converting"
    ? t("sf.converting", { pct: `${Math.round(job.progress * 100)}%` })
    : t("sf.queued");
}

const mib = (n) => `${(n / 1048576).toFixed(1)} M`;

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
