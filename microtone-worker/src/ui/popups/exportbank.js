// Export-instruments popup (item 229): the project's instruments as a .tsii
// bank. Every top-level instrument starts ticked — untick the ones to leave
// out; a metainstrument takes what it is built from whatever the ticks say
// (bankExportClosure). Slot numbers are kept, so the bank still lines up with
// this project's patterns and with any .tpif written against it. Pool regions
// ride along unless their box is cleared.
//
// The bank goes into the instrument library (instlibrary.js, the File view's
// Instruments tab: item 362), which downloads it from there; only where there
// is no storage (a private window) is it downloaded at once. It may carry a
// name, copyright and message of its OWN — the pack's, not the project's
// (TAUD_FILE_FORMAT.md §8) — which start empty.

import { planBankExport, bankExportSize } from "../../doc/cleanup.js";
import { regionBytes } from "../../doc/sampleregions.js";
import { Document } from "../../doc/document.js";
import { ZSTD_LEVEL_SAVE } from "../../../core/format/zstd.js";
import { unescapeName } from "../../../core/format/names.js";
import { download } from "../../storage/import-export.js";
import * as opfs from "../../storage/opfs.js";
import { packFile, packTitle, packExists, packSections, savePack, showInstrumentLibrary } from "../instlibrary.js";
import { showModal, showAlert } from "../components/modal.js";
import { showBanner } from "../components/banner.js";
import { withSaveProgress } from "../saveprogress.js";
import { actionRow } from "../components/actions.js";
import { t } from "../i18n.js";

const hex3 = (n) => "$" + n.toString(16).toUpperCase().padStart(3, "0");

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The file name an export of the project `fileName` gets. */
export function bankFileName(fileName) {
  const base = (fileName ?? "untitled.taud").replace(/\.[^.]+$/, "") || "untitled";
  return base + ".tsii";
}

/**
 * Selection dialog → .tsii in the instrument library (or a download where
 * there is no storage). `badgeOf(inst)` is the list's kind badge (the
 * Instruments view's own). Resolves true once the bank is on its way, false
 * when cancelled.
 */
export async function showExportBank(store, { badgeOf = () => "" } = {}) {
  const doc = store.doc;
  if (!doc?.sampleInstImage) return false;
  const slots = doc.selectableInstrumentSlots();
  const regions = doc.sampleRegions();
  const toLibrary = await opfs.available();

  return new Promise((resolve) => {
    const dlg = el("dialog", "modal import-modal");
    const h = el("h3", "", t("bankExport.title"));
    const hint = el("p", "dim", t("bankExport.hint"));

    const bar = el("div", "import-bar");
    const allBtn = el("button", "", t("common.all"));
    const noneBtn = el("button", "", t("common.none"));
    const tally = el("span", "import-tally");
    bar.append(allBtn, noneBtn, tally);

    const list = el("div", "import-list");
    const boxes = [];
    for (const slot of slots) {
      const row = el("label", "import-row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true;
      box.dataset.slot = slot;
      row.append(box, el("span", "idx", hex3(slot)),
        el("span", "name", unescapeName(doc.instrumentName(slot)) || t("inst.unnamed")),
        el("span", "badge-sm", badgeOf(doc.instruments[slot])));
      list.appendChild(row);
      boxes.push(box);
    }

    let regionBox = null;
    const opts = [];
    if (regions.length > 0) {
      const opt = el("label", "import-opt");
      regionBox = document.createElement("input");
      regionBox.type = "checkbox";
      regionBox.checked = true;
      const bytes = regions.reduce((n, r) => n + regionBytes(r), 0);
      opt.append(regionBox, el("span", "", t("bankExport.regions", { n: regions.length, size: fmtBytes(bytes) })));
      opt.title = t("bankExport.regionsTitle");
      opts.push(opt);
    }

    // The pack: its file in the library, and the strings it carries.
    const form = el("div", "modal-form bank-pack");
    const field = (labelKey, input, titleKey) => {
      const label = el("label", "modal-field");
      label.append(el("span", "modal-label", t(labelKey)), input);
      if (titleKey) label.title = t(titleKey);
      form.append(label);
      return input;
    };
    const text = (value, placeholder, max) => {
      const i = document.createElement("input");
      i.type = "text";
      i.value = value;
      i.maxLength = max;
      if (placeholder) i.placeholder = placeholder;
      return i;
    };
    const fileInput = field("bankExport.file", text(packTitle(bankFileName(store.fileName)), "", 120),
      toLibrary ? "bankExport.fileTitle" : null);
    const nameInput = field("bankExport.packName", text("", t("bankExport.optional"), 200), "bankExport.packNameTitle");
    const cprInput = field("bankExport.packCopyright", text("", t("bankExport.optional"), 200));
    const msg = document.createElement("textarea");
    msg.rows = 3;
    msg.maxLength = 4000;
    msg.placeholder = t("bankExport.optional");
    const msgInput = field("bankExport.packMessage", msg);
    const errEl = el("p", "import-error");
    errEl.hidden = true;

    const { row: btnRow, proceed: okBtn, cancel: cancelBtn } = actionRow({
      cancel: true,
      proceed: toLibrary
        ? { label: t("bankExport.save") }
        : { label: t("bankExport.export"), icon: "download", iconAfter: true },
    });

    dlg.append(h, hint, bar, list, ...opts, form, errEl, btnRow);
    document.body.appendChild(dlg);

    const picked = () => boxes.filter((b) => b.checked).map((b) => Number(b.dataset.slot));
    const updateTally = () => {
      const chosen = picked();
      const size = bankExportSize(doc, chosen);
      tally.textContent = t("bankExport.tally", {
        n: chosen.length, of: slots.length, size: fmtBytes(size.sampleBytes),
      });
      okBtn.disabled = chosen.length === 0;
    };
    list.addEventListener("change", updateTally);
    allBtn.addEventListener("click", () => { boxes.forEach((b) => { b.checked = true; }); updateTally(); });
    noneBtn.addEventListener("click", () => { boxes.forEach((b) => { b.checked = false; }); updateTally(); });
    updateTally();

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener("cancel", () => finish(false));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const file = packFile(fileInput.value.trim() || packTitle(bankFileName(store.fileName)));
      if (!opfs.validName(file)) {
        errEl.textContent = t("bankExport.badName");
        errEl.hidden = false;
        fileInput.focus();
        return;
      }
      if (toLibrary && await packExists(file)
          && !(await showModal({ title: t("sf.replaceAsk", { name: packTitle(file) }), okLabel: t("sf.replace") }))) {
        return;
      }
      const pack = { name: nameInput.value, copyright: cprInput.value, message: msgInput.value };
      // Planned now, from the document as it stands; the dialog goes before
      // the compression so the status bar's progress is what is seen.
      const plan = planBankExport(doc, picked(), { regions: regionBox?.checked ?? true, pack: packSections(pack) });
      finish(true);
      const bytes = await withSaveProgress(store, (progress) =>
        new Document(plan).toSaveBytes(ZSTD_LEVEL_SAVE, progress));
      if (!toLibrary) {
        download(bytes, file);
        return;
      }
      try {
        await savePack(file, bytes, pack);
      } catch (err) {
        console.error("Instrument pack:", err);
        showAlert(t("bankExport.saveFailed", { name: packTitle(file), err: err.message ?? String(err) }));
        download(bytes, file);
        return;
      }
      showBanner({
        text: t("bankExport.saved", { name: packTitle(file) }),
        actions: [
          { label: t("sf.show"), onClick: () => showInstrumentLibrary(), primary: true },
          { label: t("sf.dismiss") },
        ],
      });
    });
    dlg.showModal();
  });
}
