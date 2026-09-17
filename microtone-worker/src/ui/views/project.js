// Project view (F6) — song list with editable tempo/volume/flags scalars
// (eager-synced via ops), tuning display, project metadata. Reference:
// taut.js VIEW_PROJECT. Pitch-table retune is an M8 item.

import {
  setSongScalarOp, setTuningOp, retuneOp, remapPatternsOp, cleanupBankOp,
  changeInstrumentOp, bulkNotesOp, upgradeCellFormatOp, setProjectStringOp,
  importBankOp,
} from "../../doc/ops.js";
import { tuningRatioOf } from "../../engine/tables.js";
import {
  TUNING_REF_C4_HZ, TUNING_DEFAULT_BASE_NOTE, TUNING_DEFAULT_FREQ_HZ,
} from "../../engine/constants.js";
import {
  planCleanupPatterns, planMergeDuplicatePatterns, planRenumberPatterns, applyPatternOrder,
  encodeNameTable, planBankCleanup, planIxmpCleanup,
} from "../../doc/cleanup.js";
import { planPoolDefrag } from "../../doc/pooldefrag.js";
import {
  pitchTablePresets, presetForNotation, retuneAllPatterns, surveyTuning,
  transposeAllPatterns, transposeUnitKeys,
} from "../pitchtables.js";
import { defToPreset } from "../../doc/notation.js";
import { Song } from "../../doc/document.js";
import { showModal } from "../widgets/modal.js";
import {
  decodeProjectString, encodeProjectString, escapeNonAscii, unescapeName,
} from "../names.js";
import { t } from "../i18n.js";

/** Byte counts as a person reads them — the pool is measured in megabytes. */
function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

// Tuning references, transcribed from terranmon.txt:3316-3324 ("Known standard
// tunings") with the tracker default at the head — that is what every converted
// file declares, and it is NOT concert: it puts A4 at ~439.53 Hz.
const TUNING_PRESETS = [
  { key: "proj.tuneTracker", note: TUNING_DEFAULT_BASE_NOTE, freq: TUNING_DEFAULT_FREQ_HZ },
  { key: "proj.tuneIso440", note: 0x5c00, freq: 440 },
  { key: "proj.tuneFrench435", note: 0x5c00, freq: 435 },
  { key: "proj.tunePhil452", note: 0x5c00, freq: 452 },
  { key: "proj.tunePow2C256", note: 0x5000, freq: 256 },
  { key: "proj.tuneAak262", note: 0x5000, freq: 262 },
  { key: "proj.tuneHyangak311", note: 0x5000, freq: 311 },
];

// Base notes worth naming. The field is a full Uint16 note value (spec:
// 1..65533), so a file may declare something else — that value is shown as a
// hex entry rather than being silently rewritten.
const BASE_NOTE_CHOICES = [[0x5000, "C4"], [0x5c00, "A4"], [0xa000, "C9"]];

export class ProjectView {
  constructor(store, host, cb = {}) {
    this.store = store;
    this.host = host;
    this.cb = cb; // { editSong(index) } — the app's per-song metadata modal
    this.visible = false;
    // Undo-coalescing key for a burst of typing in a project-string field
    // (item 157): held while the field has focus, so "everything I typed in
    // this box" is one Ctrl+Z rather than one per character.
    this.typingGesture = null;
    this.root = document.createElement("div");
    this.root.className = "project-view";
    host.appendChild(this.root);
    store.on("doc", () => { if (this.visible) this.refresh(); });
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  op(key, value) {
    this.store.undo.apply(setSongScalarOp(this.store.songIndex, key, value));
    this.refresh();
  }

  /**
   * The surround model is an ordinary song scalar — except the first time a
   * project declares one, because that is also what upgrades the file to format
   * version 3 (the wide cell, §5.5). That upgrade cannot be undone in the FILE,
   * so it is explained first and lands in a COPY: the original stays on disk
   * exactly as it was, readable by anything that reads version 2.
   */
  async setSurroundModel(value) {
    const doc = this.store.doc;
    if (value === 0 || !doc || doc.wideCells) {
      this.op("surroundModel", value);
      return;
    }
    const base = (this.store.fileName ?? "untitled.taud").replace(/\.taud$/, "");
    const copyName = `${base}-surround.taud`;
    const ok = await showModal({
      title: t("proj.upgradeTitle"),
      body: t("proj.upgradeBody", { name: copyName }),
      okLabel: t("proj.upgradeOk"),
    });
    if (!ok) { this.refresh(); return; } // put the selector back
    // One op, so one Ctrl+Z takes the project back to where it was — the
    // widening and the flag are one action.
    this.store.undo.apply(upgradeCellFormatOp(this.store.songIndex, value));
    this.store.emit("format");
    await this.cb?.saveCopyAs?.(copyName);
    this.refresh();
  }

  /**
   * Tuning (item 77): the song's declared "note B sounds at F Hz", which the
   * engine now applies to every note instead of ignoring it.
   */
  setTuning(baseNote, freq) {
    this.store.undo.apply(setTuningOp(this.store.songIndex, baseNote, freq));
    this.refresh();
  }

  /** One line-edit for a project string section (§9.2). */
  stringRow(fourcc, label, placeholder = "") {
    const row = document.createElement("div");
    row.className = "inst-field";
    row.style.maxWidth = "440px";
    row.append(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.section = fourcc;
    input.value = decodeProjectString(fourcc, this.store.doc.projectString(fourcc));
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener("input", () => this.typeProjectString(fourcc, input.value));
    input.addEventListener("blur", () => this.endTypingBurst());
    row.appendChild(input);
    return row;
  }

  /** The project message (PMsg) — free prose, so a box rather than a line, and
   *  stored as plain UTF-8 (names.js). Empty on a project that has none: the
   *  section only appears once something is typed. */
  buildMessage() {
    const box = document.createElement("div");
    box.className = "proj-message";
    const head = document.createElement("h3");
    head.textContent = t("proj.projectMessageHead");
    const area = document.createElement("textarea");
    area.className = "proj-message-text";
    area.dataset.section = "PMsg";
    area.rows = 6;
    area.spellcheck = false;
    area.placeholder = t("proj.projectMessagePlaceholder");
    area.value = decodeProjectString("PMsg", this.store.doc.projectString("PMsg"));
    // Every keystroke, not `change` (item 157): `change` only fires on blur,
    // and the pane is routinely thrown away and rebuilt without one — switching
    // tabs, clicking into the other split pane — which lost the whole message.
    area.addEventListener("input", () => this.typeProjectString("PMsg", area.value));
    area.addEventListener("blur", () => this.endTypingBurst());
    const hint = document.createElement("p");
    hint.className = "dim";
    hint.style.margin = "0.1rem 0 0.4rem";
    hint.style.fontSize = "0.8rem";
    hint.textContent = t("proj.projectMessageHint");
    box.append(head, area, hint);
    return box;
  }

  buildTuning(song) {
    const box = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "inst-grid";

    const base = song.tuningBaseNote > 0 ? song.tuningBaseNote : TUNING_DEFAULT_BASE_NOTE;
    const freq = song.tuningFreq > 0 ? song.tuningFreq : TUNING_DEFAULT_FREQ_HZ;

    // The spec's own "Known standard tunings" list (terranmon.txt:3316-3324),
    // plus the tracker default that every converted file declares.
    const match = TUNING_PRESETS.findIndex(
      (p) => p.note === base && Math.abs(p.freq - freq) < 1e-3);
    const presetSel = sel(t("proj.tuningPreset"), match, [
      ...TUNING_PRESETS.map((p, i) => [i, t(p.key)]),
      [-1, t("proj.tuningCustom")],
    ], (i) => {
      if (i < 0) { this.refresh(); return; } // "Custom" is a readout, not a command
      this.setTuning(TUNING_PRESETS[i].note, TUNING_PRESETS[i].freq);
    });

    const baseSel = sel(t("proj.tuningBaseNote"), BASE_NOTE_CHOICES
      .some(([v]) => v === base) ? base : -1, [
      ...BASE_NOTE_CHOICES,
      ...(BASE_NOTE_CHOICES.some(([v]) => v === base)
        ? [] : [[-1, `$${base.toString(16).toUpperCase()}`]]),
    ], (v) => { if (v > 0) this.setTuning(v, freq); });

    // Frequency is a Float32 in the file, so a fractional reference (261.6256)
    // is legitimate — a plain number input, not the integer `num` helper.
    const freqWrap = document.createElement("label");
    freqWrap.className = "inst-field";
    freqWrap.textContent = t("proj.tuningFreq");
    const freqInput = document.createElement("input");
    freqInput.type = "number";
    freqInput.step = "any";
    freqInput.min = "1";
    freqInput.value = String(freq);
    freqInput.addEventListener("change", () => {
      const v = parseFloat(freqInput.value);
      if (!(v > 0)) { freqInput.value = String(freq); return; }
      this.setTuning(base, v);
    });
    freqWrap.appendChild(freqInput);

    grid.append(presetSel, baseSel, freqWrap);
    box.appendChild(grid);

    // What the declaration actually SOUNDS like. The tracker default is ~1.87
    // cents flat of concert, so this line is the difference between "cosmetic
    // option" and a number the user can trust.
    const ratio = tuningRatioOf(base, freq);
    const a4 = ratio * TUNING_REF_C4_HZ * 2 ** 0.75;
    const c = 1200 * Math.log2(ratio);
    const ann = document.createElement("p");
    ann.className = "dim";
    ann.style.margin = "0.1rem 0 0.4rem";
    ann.style.fontSize = "0.8rem";
    ann.textContent = t("proj.tuningAnnotation", {
      a4: a4.toFixed(2),
      cents: (c >= 0 ? "+" : "") + c.toFixed(2),
      rel: Math.abs(c) < 0.005
        ? t("proj.tuningAtConcert")
        : t(c < 0 ? "proj.tuningFlat" : "proj.tuningSharp"),
    });
    box.appendChild(ann);
    return box;
  }

  refresh() {
    const doc = this.store.doc;
    const keep = this.captureFieldFocus();
    this.root.innerHTML = "";
    if (!doc) return;
    const song = this.store.song;
    const sm = doc.meta.songMeta[this.store.songIndex];

    const head = document.createElement("h3");
    head.className = "proj-title";
    head.textContent = unescapeName(doc.meta.projectName ?? "") || t("proj.untitledProject");
    this.root.appendChild(head);

    const info = document.createElement("p");
    info.className = "dim";
    let infoTxt = t("proj.infoMain", {
      n: doc.songs.length,
      songs: doc.songs.length === 1 ? t("proj.song") : t("proj.songs"),
      ch: doc.channelCount, ver: doc.fmtVer ?? 2, sig: doc.signature.trim(),
    });
    if (sm) {
      infoTxt += t("proj.infoSong", { name: unescapeName(sm.name) });
      if (sm.composer) infoTxt += t("proj.infoBy", { composer: unescapeName(sm.composer) });
    }
    info.textContent = infoTxt;
    this.root.appendChild(info);

    // Editable PROJECT strings (§9.2). Song renaming lives on the File tab's
    // song list. TSVM's string reader is ASCII-only, so any non-ASCII character
    // of a NAME is stored as a \uHHHH escape; the inputs show the decoded text
    // and re-escape on save (the message is plain UTF-8 — see names.js).
    const nameRow = this.stringRow("PNam", t("proj.projectName"), t("proj.untitledProject"));
    const authorRow = this.stringRow("PCom", t("proj.projectAuthor"));
    const copyrightRow = this.stringRow("PCpr", t("proj.projectCopyright"));

    // Notation (display-only): changes how notes are drawn WITHOUT moving them.
    const preset = presetForNotation(sm?.notation ?? 120, doc);
    const notationRow = document.createElement("div");
    notationRow.className = "inst-field";
    notationRow.style.maxWidth = "440px";
    notationRow.append(document.createTextNode(t("proj.notationDisplayOnly")));
    const notSel = document.createElement("select");
    for (const p of Object.values(pitchTablePresets)) {
      const o = document.createElement("option");
      o.value = p.index;
      o.textContent = p.name;
      notSel.appendChild(o);
    }
    // Custom notations from the project's "nota" section (item 61).
    const customs = doc.customNotations();
    if (customs.length > 0) {
      const grp = document.createElement("optgroup");
      grp.label = t("nota.customGroup");
      for (const d of customs) {
        const p = defToPreset(d);
        const o = document.createElement("option");
        o.value = p.index;
        o.textContent = p.name;
        grp.appendChild(o);
      }
      notSel.appendChild(grp);
    }
    notSel.value = preset.index;
    notSel.addEventListener("change", () => this.changeNotation(parseInt(notSel.value, 10)));
    notationRow.appendChild(notSel);
    const makerBtn = document.createElement("button");
    makerBtn.textContent = t("nota.openMaker");
    makerBtn.title = t("nota.openMakerTitle");
    makerBtn.style.marginLeft = "0.4rem";
    makerBtn.addEventListener("click", async () => {
      const { showNotationMaker } = await import("../popups/notationmaker.js");
      await showNotationMaker(this.store);
      this.refresh();
    });
    notationRow.appendChild(makerBtn);

    const beats = this.store.beats();
    const grid = document.createElement("div");
    grid.className = "inst-grid";
    grid.append(
      nameRow,
      authorRow,
      copyrightRow,
      num(t("proj.bpm"), song.bpm, 25, 535, (v) => this.op("bpm", v)),
      num(t("proj.speedTicks"), song.tickRate, 1, 127, (v) => this.op("tickRate", v)),
      // Row highlighting (item 136.1) — the grids' beat/bar banding. Display
      // only: nothing about playback reads these, which is why they are plain
      // sMet writes rather than song scalars with an op behind them.
      num(t("rows.beatPri"), beats.pri, 1, 255, (v) => this.setBeats(v, beats.sec)),
      num(t("rows.beatSec"), beats.sec, 1, 255, (v) => this.setBeats(beats.pri, v)),
      num(t("proj.globalVolume"), song.globalVolume, 0, 255, (v) => this.op("globalVolume", v)),
      num(t("proj.mixingVolume"), song.mixingVolume, 0, 255, (v) => this.op("mixingVolume", v)),
      sel(t("proj.toneSlideMode"), song.globalFlags & 3, [
        [0, t("proj.toneLinear")], [1, t("proj.toneAmiga")], [2, t("proj.toneLinearHz")],
      ], (v) => this.op("globalFlags", (song.globalFlags & ~3) | v)),
      sel(t("proj.interpolation"), (song.globalFlags >> 2) & 7, [
        [0, t("proj.interpFastSinc")], [1, t("proj.interpNone")], [2, t("proj.interpAmiga500")],
        [3, t("proj.interpAmiga1200")], [4, t("proj.interpSnes")], [5, t("proj.interpNes")],
      ], (v) => this.op("globalFlags", (song.globalFlags & ~0x1c) | (v << 2))),
      // Surround model (#998) — the song's own `ss` flag, not a playback option:
      // it decides what the pan commands MEAN, so switching it moves sources.
      sel(t("proj.surroundModel"), song.surroundModel ?? 0, [
        [0, t("proj.surroundStereo")], [1, t("proj.surroundPlanar")], [2, t("proj.surroundSpatial")],
      ], (v) => this.setSurroundModel(v)),
      notationRow,
    );
    this.root.appendChild(grid);

    const surroundHint = document.createElement("p");
    surroundHint.className = "dim";
    surroundHint.style.margin = "0.1rem 0 0.4rem";
    surroundHint.style.fontSize = "0.8rem";
    surroundHint.textContent = doc.wideCells
      ? `${t("proj.surroundHint")} ${t("proj.surroundHintV3")}`
      : t("proj.surroundHint");
    if ((song.surroundModel ?? 0) === 0 && !doc.wideCells) surroundHint.hidden = true;
    this.root.appendChild(surroundHint);

    this.root.appendChild(this.buildMessage());

    this.root.appendChild(this.buildTuning(song));

    const tuning = document.createElement("p");
    tuning.className = "dim";
    // (The beat/bar divisions used to be read out here; they are two editable
    // fields in the grid above now — item 136.1.)
    const tuningTxt =
      t("proj.tuningPatterns", { pat: song.patterns.length, cues: song.lastUsedCue() + 1 });
    tuning.textContent = tuningTxt.replace(/^ · /, "");
    this.root.appendChild(tuning);

    const retuneP = document.createElement("p");
    retuneP.className = "dim";
    retuneP.append(document.createTextNode(t("proj.remapNotes")));
    const retuneBtn = document.createElement("button");
    retuneBtn.textContent = t("toolbox.retune");
    retuneBtn.addEventListener("click", () => this.openRetune(preset));
    retuneP.appendChild(retuneBtn);
    this.root.appendChild(retuneP);

    const songsTableHead = document.createElement("h3");
    songsTableHead.className = "files-songs-head";
    songsTableHead.textContent = t("files.songsHead");
    this.root.appendChild(songsTableHead);

    const songsTable = document.createElement("table");
    songsTable.className = "files-table";
    songsTable.innerHTML = `<thead><tr><th>${t("files.colSong")}</th><th>${t("files.colName")}</th>` +
      `<th>${t("files.colComposer")}</th><th>${t("files.colCopyright")}</th>` +
      `<th>${t("files.colVoices")}</th><th>${t("files.colPatterns")}</th><th>${t("proj.colBpm")}</th>` +
      `<th>${t("proj.colSpeed")}</th><th>${t("proj.colOperation")}</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    doc.songs.forEach((s, i) => {
      const m = doc.meta.songMeta[i];
      const tr = document.createElement("tr");
      if (i === this.store.songIndex) tr.className = "files-current";
      // Name, composer and copyright are this SONG's (sMet); the project's own
      // three strings live in the fields at the top of the tab.
      tr.innerHTML =
        `<td>${i}</td><td>${esc(unescapeName(m?.name || "") || t("instList.unnamed"))}</td>` +
        `<td class="dim">${esc(unescapeName(m?.composer || ""))}</td>` +
        `<td class="dim">${esc(unescapeName(m?.copyright || ""))}</td><td>${s.numVoices}</td>` +
        `<td>${s.patterns.length}</td><td>${s.bpm}</td><td>${s.tickRate}</td>`;
      const td = document.createElement("td");
      const rn = mkBtn(t("common.edit"), async () => {
        await this.cb.editSong?.(i);
        this.refresh();
      });
      rn.title = t("song.editBtnTitle");
      const rm = mkBtn(t("common.delete"), () => this.removeSong(i));
      rm.title = t("song.deleteBtnTitle");
      rm.disabled = doc.songs.length <= 1; // can't delete the last song
      td.appendChild(rn);
      td.appendChild(rm);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    songsTable.appendChild(tbody);
    this.root.appendChild(songsTable);

    const songBar = document.createElement("div");
    songBar.className = "toolbox";
    songBar.style.borderBottom = "none";
    songBar.style.padding = "0.4rem 0";
    const addBtn = document.createElement("button");
    addBtn.textContent = t("proj.addSong");
    addBtn.addEventListener("click", () => this.addSong());
    songBar.append(addBtn);
    this.root.appendChild(songBar);

    // ── Housekeeping (item 60): compact the project ──
    const houseHead = document.createElement("h3");
    houseHead.textContent = t("clean.title");
    this.root.appendChild(houseHead);
    const houseBar = document.createElement("div");
    houseBar.className = "toolbox";
    houseBar.style.borderBottom = "none";
    houseBar.style.padding = "0.4rem 0";
    houseBar.style.flexWrap = "wrap";
    const hbtn = (label, title, fn) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    houseBar.append(
      hbtn(t("clean.patterns"), t("clean.patternsTitle"), () => this.cleanupPatterns()),
      hbtn(t("clean.renumber"), t("clean.renumberTitle"), () => this.renumberPatterns()),
      hbtn(t("clean.bank"), t("clean.bankTitle"), () => this.cleanupBank()),
      hbtn(t("clean.ixmp"), t("clean.ixmpTitle"), () => this.cleanupIxmp()),
      hbtn(t("clean.defrag"), t("clean.defragTitle"), () => this.defragPool()),
    );
    this.root.appendChild(houseBar);

    // ── Global Operations: whole-document note edits ──
    const globHead = document.createElement("h3");
    globHead.textContent = t("glob.title");
    this.root.appendChild(globHead);
    const globBar = document.createElement("div");
    globBar.className = "toolbox";
    globBar.style.borderBottom = "none";
    globBar.style.padding = "0.4rem 0";
    globBar.style.flexWrap = "wrap";
    globBar.append(
      hbtn(t("glob.transpose"), t("glob.transposeTitle"), () => this.transposeGlobal()),
      hbtn(t("glob.changeInst"), t("glob.changeInstTitle"), () => this.changeInstrumentGlobal()),
    );
    this.root.appendChild(globBar);
    // 85.00: every global operation stops at the current song's edge.
    const globNote = document.createElement("p");
    globNote.className = "dim";
    globNote.textContent = t("glob.songScopeNote", { song: this.store.songIndex });
    this.root.appendChild(globNote);

    this.restoreFieldFocus(keep);
  }

  /** Percussion slots (their pitch selects the drum, so note edits skip them) —
   *  the same map the Patterns-tab bulk note ops build. */
  _percSlots() {
    const doc = this.store.doc;
    const percSlots = new Uint8Array(1024);
    for (const s of doc.usedInstrumentSlots()) {
      if (doc.instruments[s].isPercussion) percSlots[s] = 1;
    }
    return percSlots;
  }

  /** Transpose EVERY pattern of the current song — the Patterns-tab Transpose
   *  (same notation-aware units, same percussion/sentinel skips, same raw
   *  4096-TET-unit checkbox) applied song-wide in one undo step. Other songs
   *  in the project are never touched. */
  async transposeGlobal() {
    const store = this.store;
    if (!store.doc || !store.song) return;
    const notationPreset = store.pitchPreset;
    const units = transposeUnitKeys(notationPreset);
    const result = await showModal({
      title: t("glob.transposeTitle"),
      body: t("glob.transposeBody", { song: store.songIndex }),
      fields: [
        { name: "fine", label: t(units.fine), type: "number", value: 0, min: -4096, max: 4096 },
        { name: "coarse", label: t(units.coarse), type: "number", value: 0, min: -10, max: 10 },
        { name: "raw", label: t("pat.unitRaw4096"), type: "checkbox", value: false },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const fine = parseInt(result.fine || "0", 10) | 0;
    const coarse = parseInt(result.coarse || "0", 10) | 0;
    if (fine === 0 && coarse === 0) return;
    const preset = result.raw ? pitchTablePresets[0] : notationPreset;
    const percSlots = this._percSlots();
    store.undo.apply(bulkNotesOp(store.songIndex,
      (song) => transposeAllPatterns(song, preset, percSlots, fine, coarse)));
    store.emit("doc"); // notes moved across many patterns — full redraw
    this.refresh();
  }

  /** Change every note's instrument $a → $b across all patterns of the CURRENT
   *  song — the Patterns-tab Change instrument made song-wide (the way to
   *  reassign or fix "dangling" notes a delete left behind). Leave From blank for
   *  "every non-empty instrument → To". One undo step. */
  async changeInstrumentGlobal() {
    const store = this.store;
    const result = await showModal({
      title: t("glob.changeInstTitle"),
      body: t("glob.changeInstBody"),
      fields: [
        { name: "from", label: t("pat.instFrom"), type: "text", value: "", placeholder: t("pat.instAll") },
        { name: "to", label: t("pat.instTo"), type: "text", value: "" },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const fromStr = String(result.from ?? "").replace(/^\$/, "").trim();
    const toStr = String(result.to ?? "").replace(/^\$/, "").trim();
    const from = fromStr === "" ? null : (parseInt(fromStr, 16) & 0xff);
    const to = parseInt(toStr || "0", 16) & 0xff;
    if (from !== null && !Number.isFinite(parseInt(fromStr, 16))) { alert(t("del.badNumber")); return; }
    if (toStr !== "" && !Number.isFinite(parseInt(toStr, 16))) { alert(t("del.badNumber")); return; }
    // Scoped to the current song (85.00) — a global operation must not reach
    // into the project's other songs.
    store.undo.apply(changeInstrumentOp(from, to, [store.songIndex]));
    store.emit("doc"); // notes moved across many patterns — full redraw
    this.refresh();
  }

  /** Remove patterns no cue references, merge byte-identical duplicates onto their
   *  lowest copy, then renumber survivors and rewrite cues + pNam. */
  cleanupPatterns() {
    const store = this.store, song = store.song;
    const referenced = planCleanupPatterns(song);
    const { order, canon } = planMergeDuplicatePatterns(song, referenced);
    const materialised = (i) => !!song.patterns[i];
    const total = song.patterns.filter(Boolean).length;
    const removed = total - referenced.filter(materialised).length; // dropped: unreferenced
    const merged = referenced.filter(materialised).length - order.filter(materialised).length;
    if (removed <= 0 && merged <= 0 && this._isIdentityOrder(order, song)) { alert(t("clean.nothing")); return; }
    if (!confirm(t("clean.patternsConfirm", { removed: Math.max(removed, 0), merged: Math.max(merged, 0) }))) return;
    this._applyRemap(order, canon);
  }

  /** Compact + reorder ALL materialised patterns into play order (drops gaps). */
  renumberPatterns() {
    const store = this.store, song = store.song;
    const order = planRenumberPatterns(song);
    if (this._isIdentityOrder(order, song)) { alert(t("clean.nothing")); return; }
    this._applyRemap(order);
  }

  _isIdentityOrder(order, song) {
    return order.length === song.patterns.length && order.every((v, i) => v === i);
  }

  _applyRemap(order, canon = null) {
    const store = this.store;
    const plan = applyPatternOrder(store.song, order, store.doc._nameTable("pNam"), canon);
    store.undo.apply(remapPatternsOp(store.songIndex, plan.patterns, plan.cues, encodeNameTable(plan.pNam)));
    store.emit("edit", [{ kind: "resync", song: store.songIndex }]);
    this.refresh();
  }

  /** Remove unused instruments, prune the survivors' unreachable patches, and
   *  free every sample byte that leaves behind (items 60 + 147) — one undo step. */
  cleanupBank() {
    const store = this.store;
    const plan = planBankCleanup(store.doc);
    if (plan.removedInstruments === 0 && plan.removedPatches === 0 && plan.freedSampleBytes === 0) {
      alert(t("clean.nothing")); return;
    }
    if (!confirm(t("clean.bankConfirm", {
      insts: plan.removedInstruments, patches: plan.removedPatches, bytes: plan.freedSampleBytes,
    }))) return;
    store.undo.apply(cleanupBankOp(plan));
    store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
  }

  /** Remove instrument patches that can never be triggered (item 74): orphan
   *  blobs, degenerate rectangles, patches shadowed by higher-priority ones, and
   *  (for a slot with no ambiguous trigger row) patches no pattern cell actually
   *  plays — see cleanup.reachablePatchesByUsage. */
  cleanupIxmp() {
    const store = this.store;
    const plan = planIxmpCleanup(store.doc);
    if (plan.noop) { alert(t("clean.nothing")); return; }
    if (!confirm(t("clean.ixmpConfirm", {
      patches: plan.removedPatches, insts: plan.report.length, blobs: plan.removedBlobs,
      bytes: plan.freedSampleBytes,
    }))) return;
    store.undo.apply(cleanupBankOp(plan));
    store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
  }

  /**
   * Slide the sample pool down against 0 (item 178), closing every gap the
   * project's edits have left in it.
   *
   * Housekeeping's other three buttons FREE memory; this one is the only one
   * that moves any, and what it buys is a single free run at the top instead of
   * the same bytes scattered in pieces too small to import into. It changes
   * nothing about the music, so the confirm quotes the one number that decides
   * whether it was worth pressing: how big the free run becomes.
   */
  defragPool() {
    const store = this.store;
    const plan = planPoolDefrag(store.doc);
    if (plan.error) { alert(plan.error); return; }
    if (plan.noop) { alert(t("clean.defragPacked")); return; }
    const r = plan.report;
    if (!confirm(t("clean.defragConfirm", {
      moved: fmtSize(r.movedBytes), freed: fmtSize(r.freedBytes),
      was: fmtSize(r.wasLargestRun), now: fmtSize(r.largestRun),
      insts: r.instruments, regions: r.regions,
    }))) return;
    store.undo.apply(importBankOp(plan));
    store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
  }

  /**
   * Write one of the four project strings (§9.2 — PNam / PCom / PCpr / PMsg).
   * Emptying a field REMOVES its section rather than storing a lone NUL, so a
   * project that says nothing carries nothing.
   *
   * `live` is the keystroke path (item 157): the document is written on every
   * keystroke, so nothing a rebuild does can lose what has been typed and the
   * file reads as unsaved the moment it changes — but the view is NOT rebuilt
   * under the caret, and the whole burst collapses into ONE undo step through
   * the gesture id the field holds while it has focus.
   */
  changeProjectString(fourcc, raw, live = false) {
    const store = this.store;
    const current = decodeProjectString(fourcc, store.doc.projectString(fourcc));
    const text = fourcc === "PMsg" ? String(raw).replace(/\r\n?/g, "\n") : String(raw);
    if (current === text) return;
    store.undo.apply(setProjectStringOp(
      fourcc, text === "" ? null : encodeProjectString(fourcc, text),
      live ? this.typingGesture : null));
    if (fourcc === "PNam") store.emit("status"); // topbar file line shows the name
    if (!live) this.refresh();
  }

  /** One keystroke in a project-string field. */
  typeProjectString(fourcc, value) {
    if (this.typingGesture === null) this.typingGesture = `pstr:${Date.now()}`;
    this.changeProjectString(fourcc, value, true);
  }

  /** …and the end of that burst: the next one is its own undo step. */
  endTypingBurst() { this.typingGesture = null; }

  /**
   * Keep the caret where it was across a rebuild. `refresh()` throws the whole
   * pane away and builds it again, and it runs on things that have nothing to
   * do with the field being typed into — a "doc" event, the other split pane
   * taking focus (which re-shows this view). Before item 157 that silently
   * dropped the message being written; now the text is already in the document
   * and only the caret has to be put back.
   */
  captureFieldFocus() {
    const el = document.activeElement;
    if (!el || !this.root.contains(el) || !el.dataset?.section) return null;
    return {
      section: el.dataset.section,
      start: el.selectionStart, end: el.selectionEnd, scrollTop: el.scrollTop,
    };
  }

  restoreFieldFocus(keep) {
    if (!keep) return;
    const el = this.root.querySelector(`[data-section="${keep.section}"]`);
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
    el.scrollTop = keep.scrollTop;
  }

  /** Write song `index`'s own sMet strings — name, composer, copyright — from
   *  whichever of the three the caller passes (the others stay put). Non-ASCII
   *  characters are encoded as \uHHHH ASCII escapes so the sMet stays
   *  TSVM-readable (its string parser is not Unicode; the escape is kept
   *  verbatim). These are the SONG's; the project's own three are §9.2 sections
   *  and go through changeProjectString. */
  changeSongMeta(fields, index = this.store.songIndex) {
    const store = this.store;
    const sm = store.doc.meta.songMeta[index] ??
      (store.doc.meta.songMeta[index] =
        { notation: 120, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" });
    let changed = false;
    for (const key of ["name", "composer", "copyright"]) {
      if (fields[key] === undefined) continue;
      const escaped = escapeNonAscii(fields[key]);
      if (sm[key] === escaped) continue;
      sm[key] = escaped;
      changed = true;
    }
    if (!changed) return;
    store.doc.smetEdited = true;
    store.doc.dirty = true;
    this.refresh();
  }

  /** Rename song `index` (default: current) — the name-only shorthand. */
  changeName(raw, index = this.store.songIndex) {
    this.changeSongMeta({ name: raw }, index);
  }

  /** Row highlighting (item 136.1): rows per beat / per bar. Same two numbers
   *  the Timeline trough's own menu edits — the store owns the write so the two
   *  routes cannot drift. */
  setBeats(pri, sec) {
    if (this.store.setBeats(pri, sec)) this.refresh();
  }

  /** Change the song's display notation only — does NOT move any notes. */
  changeNotation(newIndex) {
    const store = this.store;
    const sm = store.doc.meta.songMeta[store.songIndex] ??
      (store.doc.meta.songMeta[store.songIndex] =
        { notation: 120, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" });
    sm.notation = newIndex;
    store.doc.smetEdited = true;
    store.doc.dirty = true;
    store.pitchPreset = presetForNotation(newIndex, store.doc);
    store.emit("doc"); // redraw glyphs with the new table
    this.refresh();
  }

  /** Append a fresh empty song (one private pattern per lane, cue 0). */
  addSong() {
    const store = this.store;
    const doc = store.doc;
    const chans = doc.channelCount;
    const emptyPat = new Uint8Array(512);
    for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
    const cue0 = new Uint16Array(64).fill(0x7fff);
    const patterns = [];
    for (let ch = 0; ch < chans; ch++) { cue0[ch] = ch; patterns.push(Uint8Array.from(emptyPat)); }
    const t = store.song;
    doc.songs.push(new Song({
      numVoices: chans,
      bpm: t?.bpm ?? 125, tickRate: t?.tickRate ?? 6,
      tuningBaseNote: t?.tuningBaseNote ?? 0xa000, tuningFreq: t?.tuningFreq ?? 8363.0,
      globalFlags: t?.globalFlags ?? 0, globalVolume: t?.globalVolume ?? 0x80,
      mixingVolume: t?.mixingVolume ?? 0x80, patterns, cues: [cue0],
    }));
    const idx = doc.songs.length - 1;
    doc.meta.songMeta[idx] = {
      notation: doc.meta.songMeta[store.songIndex]?.notation ?? 120,
      beatPri: 4, beatSec: 16, name: `song ${idx}`, composer: "", copyright: "",
    };
    doc.smetEdited = true;
    doc.dirty = true;
    store.emit("songs", { select: idx });
  }

  /** Remove song `index` (default: current), guarded against emptying the
   *  project. The re-selection keeps the currently-viewed song when a DIFFERENT
   *  one is deleted. */
  removeSong(index = this.store.songIndex) {
    const store = this.store;
    const doc = store.doc;
    if (doc.songs.length <= 1) return;
    const idx = index;
    const nm = unescapeName(doc.meta.songMeta[idx]?.name ?? "");
    if (!confirm(t("confirm.removeSong", { idx, name: nm ? ` "${nm}"` : "" }))) return;
    const cur = store.songIndex;
    doc.songs.splice(idx, 1);
    // songMeta is keyed by song index — shift entries above `idx` down by one.
    const newMeta = {};
    for (const k of Object.keys(doc.meta.songMeta).map(Number)) {
      if (k === idx) continue;
      newMeta[k > idx ? k - 1 : k] = doc.meta.songMeta[k];
    }
    doc.meta.songMeta = newMeta;
    doc.smetEdited = true;
    doc.dirty = true;
    // Keep the viewer on the same song where possible.
    const select = idx === cur ? Math.min(idx, doc.songs.length - 1)
      : idx < cur ? cur - 1 : cur;
    store.emit("songs", { select });
  }

  /** Retune dialog: snap every note onto a new pitch table (nearest-pitch).
   *  Updates the song's sMet notation so display + future retunes follow.
   *  Callable without an argument (toolbox button). */
  async openRetune(currentPreset = presetForNotation(
    this.store.doc?.meta.songMeta[this.store.songIndex]?.notation ?? 120, this.store.doc)) {
    const store = this.store;
    const presetPool = [
      ...Object.values(pitchTablePresets),
      ...store.doc.customNotations().map(defToPreset),
    ].filter((p) => p.table.length > 0);
    const result = await showModal({
      title: t("retune.title"),
      body: t("retune.body", { name: currentPreset.name }),
      fields: [
        {
          name: "preset", label: t("retune.preset"), type: "select",
          value: String(currentPreset.index),
          options: presetPool.map((p) => ({ value: String(p.index), label: p.name })),
        },
        {
          name: "method", label: t("retune.method"), type: "select", value: "pitch",
          options: [
            { value: "pitch", label: t("retune.methodPitch") },
            { value: "delta", label: t("retune.methodDelta") },
            { value: "cadence", label: t("retune.methodCadence") },
            { value: "harmonic", label: t("retune.methodHarmonic") },
          ],
        },
      ],
      okLabel: t("retune.ok"),
    });
    if (!result) return;
    const newPreset = presetPool.find((p) => p.index === parseInt(result.preset, 10));
    if (!newPreset) return;
    const method = result.method || "pitch";

    // Percussion slots: inst byte14 bit4 / meta byte0 bit1 (isPercussion getter).
    const percSlots = new Uint8Array(1024);
    for (const s of store.doc.usedInstrumentSlots()) {
      if (store.doc.instruments[s].isPercussion) percSlots[s] = 1;
    }

    // Item 73 — an out-of-tune song (a .mod's period table lands notes a few
    // cents off every degree) needs a snap-to-grid pass before it can retune
    // sensibly. A same-table nearest-pitch retune IS that pass, so it only
    // no-ops when the notes really are all on the grid; anything else warns
    // first and points at the cleanup, rather than silently misplacing notes.
    const survey = surveyTuning(store.song, currentPreset, percSlots);
    const isCleanup = newPreset.index === currentPreset.index && method === "pitch";
    if (isCleanup) {
      if (survey.wouldChange === 0) {
        await showModal({
          title: t("retune.title"),
          body: t("retune.nothingToDo", { name: currentPreset.name }),
          okLabel: t("common.ok"),
        });
        return;
      }
    } else if (survey.offGrid > 0) {
      const go = await showModal({
        title: t("retune.outOfTuneTitle"),
        body: t("retune.outOfTuneBody", {
          off: survey.offGrid, total: survey.total, name: currentPreset.name,
        }),
        okLabel: t("retune.retuneAnyway"),
      });
      if (!go) return;
    }

    store.undo.apply(retuneOp(store.songIndex, newPreset, percSlots,
      (song, np, ps) => retuneAllPatterns(song, np, currentPreset, ps, method)));
    // Record the new tuning in the song metadata (drives display + next retune).
    if (!store.doc.meta.songMeta[store.songIndex]) {
      store.doc.meta.songMeta[store.songIndex] =
        { notation: newPreset.index, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" };
    } else {
      store.doc.meta.songMeta[store.songIndex].notation = newPreset.index;
    }
    store.doc.smetEdited = true;
    store.pitchPreset = newPreset;
    store.emit("doc"); // full redraw — many patterns changed
    this.refresh();
  }

  frame() {}
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function num(label, value, min, max, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "inst-field";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  input.min = min;
  input.max = max;
  input.addEventListener("change", () => {
    const v = Math.min(Math.max(parseInt(input.value || "0", 10), min), max);
    input.value = v;
    onChange(v);
  });
  wrap.appendChild(input);
  return wrap;
}

function sel(label, value, options, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "inst-field";
  wrap.textContent = label;
  const s = document.createElement("select");
  options.forEach(([v, text]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    s.appendChild(o);
  });
  s.value = value;
  s.addEventListener("change", () => onChange(parseInt(s.value, 10)));
  wrap.appendChild(s);
  return wrap;
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
