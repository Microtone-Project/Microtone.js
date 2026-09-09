// File view (F7) — OPFS project browser + import/export. DOM-based (lists and
// buttons, no canvas). The Files tab replaces taut's filenav-driven File tab.
// Reachable WITHOUT a loaded document (browse OPFS / import something); the
// doc-scoped buttons and the song list only appear once a project is loaded.

import * as opfs from "../../storage/opfs.js";
import { pickFile, download, downloadBlob } from "../../storage/import-export.js";
import { converterFor, CONVERT_ACCEPT } from "../../convert/convert.js";
import { showModal } from "../widgets/modal.js";
import { renderToWavAsync } from "../../audio/offline-render.js";
import {
  renderStemsAsync, labelStems, encodeWav24Mono, stemFileName, sanitiseName, StemZip,
} from "../../audio/stem-export.js";
import { showProgress } from "../popups/progress.js";
import { unescapeName } from "../names.js";
import { showDemoPicker } from "../demos.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

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
  }

  async refresh() {
    const ok = await opfs.available();
    const { doc } = this.cb.currentDoc();
    this.root.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "files-bar";
    const saveBtn = mkBtn(t("files.save"), () => this.save());
    const saveAsBtn = mkBtn(t("files.saveAs"), () => this.saveAs());
    const importBtn = mkBtn(t("files.import"), () => this.import());
    const importMidiBtn = mkBtn(t("files.importMidi"), async () => {
      await this.cb.importMidi();
      this.refresh();
    });
    // Demos are reachable from the welcome screen too, but that screen is gone
    // the moment anything is loaded — this is the way back to them (item 163).
    const demoBtn = mkBtn(t("files.demos"), () => this.demos());
    const exportBtn = mkBtn("", () => this.export());
    setIconLabel(exportBtn, "download", t("files.export"), { after: true });
    const wavBtn = mkBtn(t("files.exportWav"), () => this.exportWav());
    const stemsBtn = mkBtn(t("files.exportStems"), () => this.exportStems());
    // doc-scoped actions grey out until something is loaded
    for (const b of [saveBtn, saveAsBtn, exportBtn, wavBtn, stemsBtn]) b.disabled = !doc;
    bar.append(saveBtn, saveAsBtn, importBtn, importMidiBtn, demoBtn, exportBtn, wavBtn, stemsBtn);
    this.root.appendChild(bar);

    if (!ok) {
      const warn = document.createElement("p");
      warn.className = "files-warn";
      warn.textContent = t("files.opfsWarn");
      this.root.appendChild(warn);
    } else {
      const entries = await opfs.list();
      const table = document.createElement("table");
      table.className = "files-table";
      table.innerHTML =
        `<thead><tr><th>${t("files.colProject")}</th><th>${t("files.colSize")}</th>` +
        `<th>${t("files.colModified")}</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      if (entries.length === 0) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="4" class="dim">${escapeHtml(t("files.none"))}</td>`;
        tbody.appendChild(tr);
      }
      for (const e of entries) {
        const tr = document.createElement("tr");
        const current = e.name === this.store.fileName;
        tr.innerHTML =
          `<td class="${current ? "files-current" : ""}">${escapeHtml(e.name)}</td>` +
          `<td>${(e.size / 1024).toFixed(1)} K</td>` +
          `<td>${new Date(e.mtime).toLocaleString()}</td>`;
        const td = document.createElement("td");
        const renameBtn = iconBtn("rename", () => this.rename(e.name));
        renameBtn.title = t("common.rename");
        td.append(
          mkBtn(t("files.open"), async () => {
            await this.cb.openBytes(e.name, await opfs.read(e.name));
            this.refresh();
          }),
          renameBtn,
          iconBtn("download", async () => download(await opfs.read(e.name), e.name)),
          iconBtn("close", async () => {
            const yes = await showModal({ title: t("files.deleteAsk", { name: e.name }), okLabel: t("common.delete") });
            if (yes) { await opfs.remove(e.name); this.refresh(); }
          }),
        );
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      this.root.appendChild(table);
    }
  }

  async save() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    if (!fileName) return this.saveAs();
    await opfs.write(fileName, doc.toBytes());
    doc.dirty = false;
    this.store.emit("saved", fileName);
    this.refresh();
  }

  async saveAs() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const result = await showModal({
      title: t("files.saveAsTitle"),
      fields: [{ name: "name", label: t("files.name"), value: fileName ?? "untitled.taud" }],
      okLabel: t("common.save"),
    });
    if (!result || !result.name) return;
    const name = result.name.endsWith(".taud") ? result.name : result.name + ".taud";
    await opfs.write(name, doc.toBytes());
    doc.dirty = false;
    this.store.fileName = name;
    this.store.emit("saved", name);
    this.refresh();
  }

  /** Rename an OPFS project file (item 80). If it is the currently-open file,
   *  the status-bar filename follows so a later Save targets the new name. */
  async rename(oldName) {
    const result = await showModal({
      title: t("files.renameTitle", { name: oldName }),
      fields: [{ name: "name", label: t("files.name"), value: oldName }],
      okLabel: t("common.rename"),
    });
    if (!result) return;
    let name = (result.name || "").trim();
    if (!name.endsWith(".taud")) name += ".taud";
    if (!name || name === oldName) return;
    if ((await opfs.list()).some((f) => f.name === name)) {
      await showModal({ title: t("files.renameExists", { name }), okLabel: t("common.ok") });
      return;
    }
    await opfs.rename(oldName, name);
    if (this.store.fileName === oldName) {
      this.store.fileName = name;
      this.store.emit("status"); // status-bar filename follows the rename
    }
    this.refresh();
  }

  async import() {
    // no .mid here — MIDI import (with its soundfont choice) is its own button
    const file = await pickFile(".taud,.tsii,.tpif," +
      CONVERT_ACCEPT.split(",").filter((e) => !e.startsWith(".mid")).join(","));
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Foreign formats are converted by openBytes → the user saves the RESULT;
    // only native containers land in OPFS verbatim.
    if (!converterFor(file.name) && await opfs.available()) await opfs.write(file.name, bytes);
    await this.cb.openBytes(file.name, bytes);
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

  export() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    download(doc.toBytes(), fileName ?? "untitled.taud");
  }

  /**
   * Offline-render the current song through the engine to an audio file
   * (#998.4). Stereo stays the 16-bit fold it always was; the surround and
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
    const { masteringEngaged } = await import("../../engine/mastering.js");
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
          outRate: choice.outRate, monitor: choice.monitor,
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
   * per-voice gives one track per channel. Tracks are PRE-PAN: every volume is
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
      await showModal({ title: t("files.stemsNeedPrefix"), okLabel: t("common.ok") });
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

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
