// Import-instruments popup — pick a .taud/.tsii/.sf2/.bnk source and merge
// chosen instruments (samples + Ixmp patches + meta layers) into the current
// project via bankmerge.planImport + the invertible importBankOp. An .sf2 or
// .bnk source gets a preset/patch picker instead: the chosen entries are
// built into a .tsii bank by the canonical midi2taud/opl2taud machinery
// (src/convert/sf2bank.py, src/convert/bnkbank.py, under Pyodide) at the
// destination song's BPM, then merged through the same pipeline. A .bnk patch
// becomes an ordinary two-operator FM rack — there is no song here to say
// which of them, if any, were rhythm-mode drums.

import { parseTaud } from "../../../core/format/taud-parse.js";
import { SAMPLEBIN_SIZE } from "../../../core/format/taud-const.js";
import { sampleSpans } from "../../doc/document.js";
import { Document } from "../../doc/document.js";
import { bankInventory, planImport } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { pickFile } from "../../storage/import-export.js";
import { listSf2Presets, buildSf2Bank, listBnkPresets, buildBnkBank } from "../../convert/convert.js";
import { t } from "../i18n.js";

const hex3 = (n) => "$" + n.toString(16).toUpperCase().padStart(3, "0");

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

/**
 * File pick → selection dialog → apply. Resolves with {firstSlot, count}
 * after a successful import, null when cancelled/failed.
 */
export async function showImportInstruments(store) {
  if (!store.doc) return null;
  const file = await pickFile(".taud,.tsii,.sf2,.bnk");
  if (!file) return null;
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".sf2")) {
    return importFromSf2(store, file.name, fileBytes);
  }
  if (lower.endsWith(".bnk")) {
    return importFromBnk(store, file.name, fileBytes);
  }

  let src;
  try {
    const parsed = parseTaud(fileBytes);
    if (parsed.kind === "tpif") throw new Error("a .tpif carries patterns only — no instruments");
    src = new Document(parsed);
  } catch (err) {
    alert(t("import.cantRead", { name: file.name, err: err.message }));
    return null;
  }
  const inventory = bankInventory(src);
  if (inventory.length === 0) {
    alert(t("import.noInstruments", { name: file.name }));
    return null;
  }

  const destUsed = new Set(store.doc.usedInstrumentSlots());
  let freeLow = 0;
  for (let s = 1; s <= 255; s++) if (!destUsed.has(s)) freeLow++;
  // A stereo sample occupies one span per channel (item 90).
  const poolUsed = store.doc.sampleList()
    .reduce((n, e) => n + e.len * sampleSpans(e).length, 0);

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";
    const h = document.createElement("h3");
    h.textContent = `Import instruments from ${file.name}`;
    const hint = document.createElement("p");
    hint.className = "dim";
    hint.textContent =
      "Selecting a Metainstrument imports its layer instruments too. " +
      "Samples are deduped against the project's pool.";
    const bar = document.createElement("div");
    bar.className = "import-bar";
    const allBtn = document.createElement("button");
    allBtn.textContent = "All";
    const noneBtn = document.createElement("button");
    noneBtn.textContent = "None";
    const tally = document.createElement("span");
    tally.className = "import-tally";
    bar.append(allBtn, noneBtn, tally);

    const list = document.createElement("div");
    list.className = "import-list";
    const boxes = [];
    for (const e of inventory) {
      const row = document.createElement("label");
      row.className = "import-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      // layer children of metas start unchecked — picking the meta pulls them
      box.checked = e.layerOf.length === 0;
      box.dataset.slot = e.slot;
      const badge = e.isFm ? `FM·${e.layerCount}`
        : e.isMeta ? "META" : e.patchCount > 0 ? `IXMP·${e.patchCount}` : "";
      const note = e.layerOf.length > 0 ? `layer of ${e.layerOf.map(hex3).join(" ")}` :
        e.sampleBytes > 0 ? fmtBytes(e.sampleBytes) : "";
      row.append(box, el("span", "idx", hex3(e.slot)),
        el("span", "name", e.name || "(unnamed)"),
        el("span", "badge-sm", badge),
        el("span", "note", note));
      list.appendChild(row);
      boxes.push(box);
    }

    const info = document.createElement("p");
    info.className = "dim";
    info.textContent =
      `Project: ${fmtBytes(poolUsed)} of ${fmtBytes(SAMPLEBIN_SIZE)} pool used · ` +
      `${freeLow} free note-addressable slots ($01–$FF)`;
    const errEl = document.createElement("p");
    errEl.className = "import-error";
    errEl.hidden = true;

    const btnRow = document.createElement("div");
    btnRow.className = "modal-buttons";
    const okBtn = document.createElement("button");
    okBtn.textContent = "Import";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = t("common.cancel");
    btnRow.append(okBtn, cancelBtn);

    dlg.append(h, hint, bar, list, info, errEl, btnRow);
    document.body.appendChild(dlg);

    const picked = () => boxes.filter((b) => b.checked).map((b) => Number(b.dataset.slot));
    const updateTally = () => {
      const slots = new Set(picked());
      let bytes = 0;
      for (const e of inventory) if (slots.has(e.slot)) bytes += e.sampleBytes;
      tally.textContent = `${slots.size} selected · ≤ ${fmtBytes(bytes)} samples`;
      okBtn.disabled = slots.size === 0;
    };
    list.addEventListener("change", updateTally);
    allBtn.addEventListener("click", () => { boxes.forEach((b) => { b.checked = true; }); updateTally(); });
    noneBtn.addEventListener("click", () => { boxes.forEach((b) => { b.checked = false; }); updateTally(); });
    updateTally();

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const plan = planImport(store.doc, src, picked());
      if (plan.error) {
        errEl.textContent = plan.error;
        errEl.hidden = false;
        return;
      }
      store.undo.apply(importBankOp(plan));
      const destSlots = plan.insts.filter((it) => it.topLevel).map((it) => it.destSlot);
      finish({ firstSlot: Math.min(...destSlots), count: plan.insts.length });
    });
    dlg.showModal();
  });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

/**
 * SF2 source: preset picker (name filter, All/None over visible rows, drums
 * annotated) → build a .tsii from the selection at the destination song's BPM
 * → merge every top-level slot of that bank. Resolves like the main popup.
 * Exported for the Instruments-view Add… shortcut (bundled soundfont).
 */
export function importFromSf2(store, fileName, sf2Bytes) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";
    const h = document.createElement("h3");
    h.textContent = `Import instruments from ${fileName}`;

    const bar = document.createElement("div");
    bar.className = "import-bar";
    const filter = document.createElement("input");
    filter.type = "search";
    filter.placeholder = "filter presets…";
    filter.className = "import-filter";
    const allBtn = el("button", "", "All");
    const noneBtn = el("button", "", "None");
    const tally = el("span", "import-tally", "");
    bar.append(filter, allBtn, noneBtn, tally);

    const list = document.createElement("div");
    list.className = "import-list";
    list.append(el("div", "import-row dim", "reading presets…"));

    const statusEl = el("p", "dim", "");
    // Item 90.1: SF2 instruments built from stereo sample pairs can come in as
    // genuine stereo (two pool spans + an Ixmp stereo patch) or be mixed down
    // to mono as they always were. Mono is the default because stereo doubles
    // the pool cost of every such instrument.
    const stereoLab = document.createElement("label");
    stereoLab.className = "import-opt";
    const stereoBox = document.createElement("input");
    stereoBox.type = "checkbox";
    stereoLab.title = t("import.sf2StereoTitle");
    stereoLab.append(stereoBox, document.createTextNode(" " + t("import.sf2Stereo")));
    const errEl = el("p", "import-error", "");
    errEl.hidden = true;
    const btnRow = document.createElement("div");
    btnRow.className = "modal-buttons";
    const okBtn = el("button", "", "Import");
    okBtn.disabled = true;
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);

    dlg.append(h, bar, list, stereoLab, statusEl, errEl, btnRow);
    document.body.appendChild(dlg);
    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();

    const rows = []; // {box, row, preset}
    const picked = () => rows.filter((r) => r.box.checked).map((r) => [r.preset.bank, r.preset.program]);
    const updateTally = () => {
      const n = picked().length;
      tally.textContent = `${n} selected`;
      okBtn.disabled = n === 0;
    };
    const applyFilter = () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) {
        r.row.hidden = q !== "" && !r.preset.name.toLowerCase().includes(q);
      }
    };
    filter.addEventListener("input", applyFilter);
    allBtn.addEventListener("click", () => {
      for (const r of rows) if (!r.row.hidden) r.box.checked = true;
      updateTally();
    });
    noneBtn.addEventListener("click", () => {
      for (const r of rows) r.box.checked = false;
      updateTally();
    });
    list.addEventListener("change", updateTally);

    const status = (line) => { statusEl.textContent = line; };
    listSf2Presets(sf2Bytes, { onStatus: status }).then((presets) => {
      list.innerHTML = "";
      for (const p of presets) {
        const row = document.createElement("label");
        row.className = "import-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        row.append(box,
          el("span", "idx", `${p.bank}:${String(p.program).padStart(3, "0")}`),
          el("span", "name", p.name),
          el("span", "note", p.bank === 128 ? "drum kit" : ""));
        list.appendChild(row);
        rows.push({ box, row, preset: p });
      }
      status(`${presets.length} presets — bank built at ${store.doc.songs[store.songIndex ?? 0]?.bpm ?? 125} BPM (the song's tempo)`);
      updateTally();
      filter.focus();
    }).catch((err) => {
      errEl.textContent = `Can't read ${fileName}: ${err.message}`;
      errEl.hidden = false;
    });

    okBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const selection = picked();
      if (selection.length === 0) return;
      okBtn.disabled = true;
      errEl.hidden = true;
      try {
        const bpm = store.doc.songs[store.songIndex ?? 0]?.bpm ?? 125;
        const tsii = await buildSf2Bank(sf2Bytes, selection,
          { bpm, stereo: stereoBox.checked, onStatus: status });
        const src = new Document(parseTaud(tsii));
        const topLevel = src.usedInstrumentSlots().filter((s) => s <= 255);
        const plan = planImport(store.doc, src, topLevel);
        if (plan.error) {
          errEl.textContent = plan.error;
          errEl.hidden = false;
          okBtn.disabled = false;
          return;
        }
        store.undo.apply(importBankOp(plan));
        const destSlots = plan.insts.filter((it) => it.topLevel).map((it) => it.destSlot);
        finish({ firstSlot: Math.min(...destSlots), count: plan.insts.length });
      } catch (err) {
        errEl.textContent = `bank build failed: ${err.message}`;
        errEl.hidden = false;
        okBtn.disabled = false;
      }
    });
  });
}

/**
 * AdLib .BNK source: patch picker (name filter, All/None over visible rows)
 * → build a .tsii from the selection at the destination song's BPM via
 * opl2taud (each patch becomes an ordinary two-operator FM rack) → merge
 * every top-level slot of that bank. Resolves like the main popup.
 */
export function importFromBnk(store, fileName, bnkBytes) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";
    const h = document.createElement("h3");
    h.textContent = `Import instruments from ${fileName}`;

    const bar = document.createElement("div");
    bar.className = "import-bar";
    const filter = document.createElement("input");
    filter.type = "search";
    filter.placeholder = "filter patches…";
    filter.className = "import-filter";
    const allBtn = el("button", "", "All");
    const noneBtn = el("button", "", "None");
    const tally = el("span", "import-tally", "");
    bar.append(filter, allBtn, noneBtn, tally);

    const list = document.createElement("div");
    list.className = "import-list";
    list.append(el("div", "import-row dim", "reading patches…"));

    const statusEl = el("p", "dim", "");
    const errEl = el("p", "import-error", "");
    errEl.hidden = true;
    const btnRow = document.createElement("div");
    btnRow.className = "modal-buttons";
    const okBtn = el("button", "", "Import");
    okBtn.disabled = true;
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);

    dlg.append(h, bar, list, statusEl, errEl, btnRow);
    document.body.appendChild(dlg);
    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();

    const rows = []; // {box, row, patch}
    const picked = () => rows.filter((r) => r.box.checked).map((r) => r.patch.index);
    const updateTally = () => {
      const n = picked().length;
      tally.textContent = `${n} selected`;
      okBtn.disabled = n === 0;
    };
    const applyFilter = () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) {
        r.row.hidden = q !== "" && !r.patch.name.toLowerCase().includes(q);
      }
    };
    filter.addEventListener("input", applyFilter);
    allBtn.addEventListener("click", () => {
      for (const r of rows) if (!r.row.hidden) r.box.checked = true;
      updateTally();
    });
    noneBtn.addEventListener("click", () => {
      for (const r of rows) r.box.checked = false;
      updateTally();
    });
    list.addEventListener("change", updateTally);

    const status = (line) => { statusEl.textContent = line; };
    listBnkPresets(bnkBytes, { onStatus: status }).then((patches) => {
      list.innerHTML = "";
      for (const p of patches) {
        const row = document.createElement("label");
        row.className = "import-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        row.append(box, el("span", "idx", String(p.index)), el("span", "name", p.name || "(unnamed)"));
        list.appendChild(row);
        rows.push({ box, row, patch: p });
      }
      status(`${patches.length} patches — bank built at ${store.doc.songs[store.songIndex ?? 0]?.bpm ?? 125} BPM (the song's tempo)`);
      updateTally();
      filter.focus();
    }).catch((err) => {
      errEl.textContent = `Can't read ${fileName}: ${err.message}`;
      errEl.hidden = false;
    });

    okBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const selection = picked();
      if (selection.length === 0) return;
      okBtn.disabled = true;
      errEl.hidden = true;
      try {
        const bpm = store.doc.songs[store.songIndex ?? 0]?.bpm ?? 125;
        const tsii = await buildBnkBank(bnkBytes, selection, { bpm, onStatus: status });
        const src = new Document(parseTaud(tsii));
        const topLevel = src.usedInstrumentSlots().filter((s) => s <= 255);
        const plan = planImport(store.doc, src, topLevel);
        if (plan.error) {
          errEl.textContent = plan.error;
          errEl.hidden = false;
          okBtn.disabled = false;
          return;
        }
        store.undo.apply(importBankOp(plan));
        const destSlots = plan.insts.filter((it) => it.topLevel).map((it) => it.destSlot);
        finish({ firstSlot: Math.min(...destSlots), count: plan.insts.length });
      } catch (err) {
        errEl.textContent = `bank build failed: ${err.message}`;
        errEl.hidden = false;
        okBtn.disabled = false;
      }
    });
  });
}
