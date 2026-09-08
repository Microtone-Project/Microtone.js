// Samples view (F4) — deduped sample census (base instruments + Ixmp patches),
// waveform canvas with loop markers and LIVE per-voice play-position blobs
// (snapshot voices whose samplePtr matches). Reference: taut_views.mjs samples
// tab. The toolbar's editors: "Edit…" opens the Sample Lab (item 109 — one
// editor, which both replaces the sample in place and imports as new),
// "Paint…" redraws its waveform by hand, "Chord…" is the Lab with the chord
// maker on top. "Duplicate" and "Delete" (item 151) are the pool-level pair:
// one copies the bytes into a new sample + instrument, the other frees them and
// leaves every instrument bound to them dangling.

import { hex2 } from "../notenames.js";
import { themeColors } from "../theme.js";
import { unescapeName, escapeNonAscii } from "../names.js";
import { sampleSpans, isStereoSample } from "../../doc/document.js";
import { TOTAL_VOICES } from "../../engine/constants.js";
import { Lamp, liveBrightnessByKey } from "../lamp.js";
import {
  ModGeom, resolveModGeom, modTouches, modAddress,
  extModTouches, modAddressExt, applyExtLevel, isExtFunkOp,
} from "../../engine/samplemod.js";
import { encodeU8Wav } from "../../audio/wavwrite.js";
import { download } from "../../storage/import-export.js";
import { sanitiseName } from "../../audio/stem-export.js";
import {
  planDuplicateSample, duplicateInstrumentName,
  planDeleteRegion, planRenameRegion, planRegionSlice,
} from "../../doc/bankmerge.js";
import { planDeleteSample } from "../../doc/cleanup.js";
import { importBankOp, cleanupBankOp } from "../../doc/ops.js";
import {
  regionSpans, regionBytes, wholeMemoryRegion, POOL_SIZE, DEFAULT_RATE,
} from "../../doc/sampleregions.js";
import { showModal } from "../widgets/modal.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";
import { PoolPanel } from "./poolpanel.js";
import { PoolWave } from "./poolwave.js";

/** The map view (item 175.1) is off by default and remembered per browser —
 *  the same treatment the memory panel's toggle gets. */
const MAP_PREF_KEY = "microtone-samplemap";
function loadMapPref() {
  try { return localStorage.getItem(MAP_PREF_KEY) === "1"; } catch { return false; }
}
function saveMapPref(v) {
  try { localStorage.setItem(MAP_PREF_KEY, v ? "1" : "0"); } catch { /* private mode */ }
}

/** The memory panel is off by default and remembered per browser. */
const POOL_PREF_KEY = "microtone-poolpanel";
function loadPoolPref() {
  try { return localStorage.getItem(POOL_PREF_KEY) === "1"; } catch { return false; }
}
function savePoolPref(v) {
  try { localStorage.setItem(POOL_PREF_KEY, v ? "1" : "0"); } catch { /* private mode */ }
}

/** Waveform canvas height PER CHANNEL (px). */
const WAVE_LANE_H = 220;

/** An instrument slot as the rest of the app spells it: $01–$FF in two digits,
 *  a $100+ layer child in three (a sample's users are often layer children). */
const instLabel = (slot) => "$" + (slot > 0xff ? slot.toString(16).toUpperCase().padStart(3, "0") : hex2(slot));

export class SamplesView {
  constructor(store, host, callbacks = {}) {
    this.store = store;
    this.host = host;
    this.cb = callbacks;
    this.selected = 0;
    this.list = [];
    // Pool regions (item 175) share the list with the census: they are the
    // OTHER thing the pool holds, and the one the samples below them are cut
    // out of. -1 means a census row is selected, which is the ordinary state.
    this.regions = [];
    this.selRegion = -1;
    this.lamps = new Map(); // sample ptr -> Lamp (item 169); outlives refresh() rebuilds
    this._lampLastMs = 0;
    this.root = document.createElement("div");
    this.root.className = "split-view";
    this.listEl = document.createElement("div");
    this.listEl.className = "side-list";
    this.right = document.createElement("div");
    // `smp-detail` makes the pane a flex column so the map can stretch to the
    // bottom of it (item 175) — the Instruments view shares `side-detail` and
    // is deliberately left as a block flow.
    this.right.className = "side-detail smp-detail";
    this.info = document.createElement("div");
    this.info.className = "detail-info";
    // Live funk-repeat state (item 164) — its own line so the static one above
    // is not rebuilt sixty times a second. It lives UNDER the waveform (item
    // 175.4), so its coming and going never moves the canvas.
    this.funkInfo = document.createElement("div");
    this.funkInfo.className = "detail-info funk-info";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "smp-toolbar";
    // "Edit…" is the ONE sample editor (item 109): the Sample Lab, opened on a
    // float copy of the selected sample. It commits either way — Replace writes
    // the edit back over these pool bytes (every instrument using them follows),
    // or Import as new mints fresh samples and instruments and leaves the
    // original alone.
    this.editBtn = document.createElement("button");
    this.editBtn.textContent = t("smp.edit");
    this.editBtn.title = t("smp.editTitle");
    this.editBtn.addEventListener("click", () => this.openInLab());
    // Create a fresh instrument that plays the selected pooled sample (item 40).
    this.newInstBtn = document.createElement("button");
    this.newInstBtn.textContent = t("smp.newInst");
    this.newInstBtn.title = t("smp.newInstBtnTitle");
    this.newInstBtn.addEventListener("click", async () => {
      const s = this.list?.[this.selected];
      if (!s) return;
      const { newInstrumentFromSample } = await import("../popups/importsample.js");
      const res = await newInstrumentFromSample(this.store, s);
      if (res) this.cb.onNewInstrument?.(res.firstSlot);
    });
    // "Paint…" is a second editor for the SELECTED pooled sample — repaint its
    // waveform in place (affects every instrument using it). Sits next to Edit….
    this.paintBtn = document.createElement("button");
    this.paintBtn.textContent = t("smp.paint");
    this.paintBtn.title = t("smp.paintTitle");
    this.paintBtn.addEventListener("click", async () => {
      const s = this.list?.[this.selected];
      if (!s) return;
      const { paintEditSample } = await import("../popups/waveformpaint.js");
      await paintEditSample(this.store, s);
      this.refresh(); // repaint the waveform view
    });
    // "Chord…" (item 89) is the same trip into the Lab with the chord maker
    // opened on arrival: mix pitch-shifted copies of the sample into one
    // chorded sample, the Amiga trick. The Lab then names/auditions/commits it.
    this.chordBtn = document.createElement("button");
    this.chordBtn.textContent = t("smp.chord");
    this.chordBtn.title = t("smp.chordTitle");
    this.chordBtn.addEventListener("click", () => this.openInLab(true));
    // "Export" downloads the selected pooled sample as a WAV file — its
    // current committed bytes, 8-bit PCM straight out of the pool (bit-exact,
    // no requantisation).
    this.exportBtn = document.createElement("button");
    setIconLabel(this.exportBtn, "download", t("smp.export"), { after: true });
    this.exportBtn.title = t("smp.exportTitle");
    this.exportBtn.addEventListener("click", () => this.exportSample());
    // "Duplicate" (item 151) copies the bytes — the copy is a sample of its own,
    // so editing it can never reach the music written with the original. (New
    // instrument, next to it, is the version that SHARES the bytes.)
    this.dupBtn = document.createElement("button");
    this.dupBtn.textContent = t("smp.duplicate");
    this.dupBtn.title = t("smp.duplicateTitle");
    this.dupBtn.addEventListener("click", () => this.duplicateSample());
    // "Delete" frees the pool bytes. Every instrument bound to the sample is
    // named in the confirm dialog: they keep their slot and lose their sample.
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.textContent = t("smp.delete");
    this.deleteBtn.title = t("smp.deleteTitle");
    this.deleteBtn.addEventListener("click", () => this.deleteSample());
    // "Memory" (item 166) toggles the pool map under the waveform: the list is
    // a CENSUS of (ptr:len) claims and says nothing about where the bytes are,
    // and this is the view that does. Off by default and remembered.
    this.poolBtn = document.createElement("button");
    this.poolBtn.className = "smp-pool";
    this.poolBtn.textContent = t("pool.toggle");
    this.poolBtn.title = t("pool.toggleTitle");
    this.poolBtn.addEventListener("click", () => this.togglePool());
    // "Map" (item 175.1) swaps the one-line waveform for the pool drawn across
    // as many lines as it takes. It is the only way to SEE a recording longer
    // than a screen, and the way a window is dragged out of one.
    this.mapBtn = document.createElement("button");
    this.mapBtn.className = "smp-pool";
    this.mapBtn.textContent = t("pw.toggle");
    this.mapBtn.title = t("pw.toggleTitle");
    this.mapBtn.addEventListener("click", () => this.toggleMap());
    this.toolbar.append(this.editBtn, this.paintBtn, this.chordBtn, this.dupBtn,
      this.exportBtn, this.newInstBtn, this.deleteBtn, this.mapBtn, this.poolBtn);

    // ── the region toolbar: the same row, for the other kind of selection ──
    this.regionBar = document.createElement("div");
    this.regionBar.className = "smp-toolbar";
    this.rgnRenameBtn = document.createElement("button");
    this.rgnRenameBtn.textContent = t("rgn.rename");
    this.rgnRenameBtn.title = t("rgn.renameTitle");
    this.rgnRenameBtn.addEventListener("click", () => this.renameRegion());
    this.rgnExportBtn = document.createElement("button");
    setIconLabel(this.rgnExportBtn, "download", t("smp.export"), { after: true });
    this.rgnExportBtn.title = t("rgn.exportTitle");
    this.rgnExportBtn.addEventListener("click", () => this.exportRegion());
    this.rgnDeleteBtn = document.createElement("button");
    this.rgnDeleteBtn.textContent = t("smp.delete");
    this.rgnDeleteBtn.title = t("rgn.deleteTitle");
    this.rgnDeleteBtn.addEventListener("click", () => this.deleteRegion());
    this.regionBar.append(this.rgnRenameBtn, this.rgnExportBtn, this.rgnDeleteBtn);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "wave-canvas";
    // Hover hairline (item 171): the byte offset under the pointer, or -1.
    // A waveform is the one view where "where in the sample is that click?" is
    // the whole question, and the loop points, the offset effect (O) and the
    // sample-mod ranges are all spelled in bytes — so the readout is the byte,
    // not a percentage or a time.
    this.hoverByte = -1;
    this.hoverLane = 0;
    this.canvas.addEventListener("pointermove", (e) => this.wavePointerMove(e));
    this.canvas.addEventListener("pointerleave", () => this.clearWaveHover());
    this.pool = new PoolPanel(store, {
      onSelect: (idx) => {
        if (idx === this.selected || idx < 0 || idx >= this.list.length) return;
        this.selected = idx;
        this.refresh();
        this.rowEls?.[idx]?.el.scrollIntoView({ block: "nearest" });
      },
    });
    this.poolOpen = loadPoolPref();
    this.pool.element.hidden = !this.poolOpen;
    this.poolBtn.classList.toggle("on", this.poolOpen);
    // The map: the pool as a wrapped waveform (item 175.1). Clicking a claim in
    // it selects that census row, so the map navigates the list exactly as the
    // address-line panel does; a dragged window becomes an instrument.
    this.poolWave = new PoolWave(store, {
      onSelectSample: (idx) => this.selectSample(idx),
      onSlice: (sel) => this.sliceToInstrument(sel),
    });
    this.mapOpen = loadMapPref();
    this.mapBtn.classList.toggle("on", this.mapOpen);
    // The funk-repeat readout sits BELOW the waveform (item 175.4): it comes and
    // goes with the effect, and a line that appears and disappears above the
    // canvas shifts the picture the reader is watching down and up again.
    this.right.append(this.info, this.toolbar, this.regionBar, this.canvas,
      this.poolWave.element, this.funkInfo, this.pool.element);
    this.root.append(this.listEl, this.right);
    host.appendChild(this.root);
    this.visible = false;

    store.on("doc", () => { this.selected = 0; this.selRegion = -1; if (this.visible) this.refresh(); });
    store.on("edit", (tags) => {
      // bank import/undo changes the census; inst edits move loop points; an
      // SRgn write changes which regions the list and the map know about.
      if (this.visible && tags?.some?.((t) =>
        t.kind === "bank" || t.kind === "inst" ||
        (t.kind === "section" && t.fourcc === "SRgn"))) this.refresh();
    });
    new ResizeObserver(() => {
      if (!this.visible) return;
      this.drawWave();
      if (this.mapVisible()) this.poolWave.relayout();
      if (this.poolOpen) this.pool.draw();
    }).observe(this.right);
  }

  /** True while the wrapped map is the picture on screen: always for a region
   *  (which cannot be drawn on one line), and by the toggle for a sample. */
  mapVisible() {
    return this.selRegion >= 0 || this.mapOpen;
  }

  /** The selected region, or null when a census row is selected. */
  selectedRegion() {
    return this.selRegion >= 0 ? (this.regions[this.selRegion] ?? null) : null;
  }

  /** Select census row `idx` (from the map, the memory panel or the list). */
  selectSample(idx) {
    if (idx < 0 || idx >= this.list.length) return;
    if (idx === this.selected && this.selRegion < 0) return;
    this.selected = idx;
    this.selRegion = -1;
    this.refresh();
    this.rowEls?.find((r) => r.index === idx)?.el.scrollIntoView({ block: "nearest" });
  }

  /** Swap the one-line waveform for the wrapped map, and remember the choice. */
  toggleMap() {
    this.mapOpen = !this.mapOpen;
    if (!this.mapOpen) this.poolWave.stopPreview();
    saveMapPref(this.mapOpen);
    this.mapBtn.classList.toggle("on", this.mapOpen);
    this.refresh();
    if (this.mapOpen && this.selRegion < 0) {
      const s = this.list[this.selected];
      if (s) this.poolWave.scrollToByte(s.ptr);
    }
  }

  /** Show/hide the sample-memory panel, and remember the choice. */
  togglePool() {
    this.poolOpen = !this.poolOpen;
    savePoolPref(this.poolOpen);
    this.poolBtn.classList.toggle("on", this.poolOpen);
    this.pool.element.hidden = !this.poolOpen;
    if (!this.poolOpen) return;
    this.pool.refresh(this.selected);
    // Opened from a toolbar at the top of a pane whose waveform can be two
    // lanes tall, so bring the thing that just appeared into view.
    this.pool.element.scrollIntoView({ block: "nearest" });
  }

  show() { this.visible = true; this.refresh(); }
  hide() {
    this.visible = false;
    this.poolWave.stopPreview();   // nothing should still be sounding off-screen
  }

  /** Open a float copy of the selected sample in the Sample Lab; `openChord`
   *  opens the chord maker on top of it. `replaceTarget` is what lets the Lab
   *  write the edit BACK over these pool bytes (item 109) — the alternative
   *  commit, importing the result as new instruments, leaves them untouched. */
  async openInLab(openChord = false) {
    const s = this.list?.[this.selected];
    if (!s) return;
    const [{ openSampleLab }, { u8ToFloat }] = await Promise.all([
      import("../popups/samplelab.js"), import("../../doc/wavelab.js"),
    ]);
    // Every channel travels: a stereo pooled sample opens as a stereo take.
    const chans = sampleSpans(s).map((sp) =>
      u8ToFloat(this.store.doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len)));
    const res = await openSampleLab(this.store, {
      data: chans,
      rate: s.rate,
      name: unescapeName(s.name) || `sample ${s.index}`,
      sourceLabel: t("smp.labSource", { idx: s.index }),
      openChord,
      replaceTarget: s,
    });
    if (res?.firstSlot !== undefined) this.cb.onNewInstrument?.(res.firstSlot);
    else if (res?.replaced) this.refresh();
  }

  /** Copy the selected sample's bytes into a fresh pool span plus an instrument
   *  that plays them (item 151). The name defaults to "<name> (2)" — the same
   *  numbering a duplicated instrument gets — and the new sample is selected. */
  async duplicateSample() {
    const s = this.list?.[this.selected];
    const doc = this.store.doc;
    if (!s || !doc) return;
    const base = unescapeName(s.name) || `sample ${s.index}`;
    const takenNames = new Set(this.list.map((e) => unescapeName(e.name)));
    const suggested = duplicateInstrumentName(takenNames, base) || base;
    const res = await showModal({
      title: t("smp.dupTitle", { name: base }),
      body: t("smp.dupBody", { bytes: s.len * sampleSpans(s).length }),
      fields: [{ name: "name", label: t("inst.sampleImportName"), value: suggested }],
      okLabel: t("common.create"),
    });
    if (!res) return;
    const nameBytes = new TextEncoder().encode(escapeNonAscii(res.name || suggested));
    const plan = planDuplicateSample(doc, s, nameBytes);
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(importBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
    // Land on the copy: the census is pool-ordered, so find it by its pointer.
    // The view stays put — this duplicated a SAMPLE, and the instrument minted
    // to carry it is a means to that; "New instrument" is the button that means
    // to go and edit one.
    const at = this.list.findIndex((e) => e.ptr === plan.duplicate.ptr);
    if (at >= 0) { this.selected = at; this.refresh(); }
  }

  /** Free the selected sample's pool bytes (item 151). Everything bound to it is
   *  named first: base records are left DANGLING (slot and notes survive, the
   *  sample does not) and Ixmp patches bound to it are dropped. */
  async deleteSample() {
    const s = this.list?.[this.selected];
    const doc = this.store.doc;
    if (!s || !doc) return;
    const plan = planDeleteSample(doc, s);
    if (plan.error) { alert(plan.error); return; }
    const bodyParts = [];
    if (plan.clearedInsts.length > 0) {
      bodyParts.push(t("smp.delBodyDangling", {
        n: plan.clearedInsts.length,
        list: plan.clearedInsts.map(instLabel).join(", "),
      }));
    }
    if (plan.removedPatches > 0) {
      bodyParts.push(t("smp.delBodyPatches", {
        n: plan.removedPatches, insts: plan.patchedInsts.length, blobs: plan.removedBlobs,
      }));
    }
    bodyParts.push(t("smp.delBodyFrees", { kb: (plan.freedSampleBytes / 1024).toFixed(1) }));
    const res = await showModal({
      title: t("smp.delTitle", { name: unescapeName(s.name) || `sample ${s.index}`, idx: s.index }),
      body: bodyParts.join(" "),
      okLabel: t("smp.delOk"),
    });
    if (!res) return;
    this.store.undo.apply(cleanupBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.selected = Math.max(0, Math.min(this.selected, doc.sampleList().length - 1));
    this.refresh();
  }

  // ── pool regions (item 175) ───────────────────────────────────────────────

  /** The census rows that are windows INTO `region` — the instruments that
   *  have already been cut out of it. */
  regionWindows(region) {
    const spans = regionSpans(region);
    return (this.list ?? []).filter((e) =>
      sampleSpans(e).some((sp) => spans.some((rs) =>
        sp.ptr >= rs.ptr && sp.ptr + sp.len <= rs.ptr + rs.len)));
  }

  /** Load a long recording straight into the pool (item 175) and select it. */
  async loadRegion() {
    const { importRegion } = await import("../popups/importregion.js");
    const region = await importRegion(this.store);
    if (!region) return;
    this.refresh();
    const at = this.regions.findIndex((r) => r.ptr === region.ptr && r.len === region.len);
    if (at >= 0) { this.selRegion = at; this.refresh(); }
  }

  async renameRegion() {
    const region = this.selectedRegion();
    if (!region || region.synthetic) return;
    const cur = unescapeName(region.name);
    const res = await showModal({
      title: t("rgn.renameTitle"),
      fields: [{ name: "name", label: t("inst.sampleImportName"), value: cur }],
      okLabel: t("common.ok"),
    });
    if (!res) return;
    const plan = planRenameRegion(this.store.doc,
      region, new TextEncoder().encode(escapeNonAscii(res.name ?? "")));
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(importBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
  }

  /** Free a region's bytes. The windows already cut out of it survive — they
   *  are instruments now, and deleting the source is not deleting them. */
  async deleteRegion() {
    const region = this.selectedRegion();
    if (!region || region.synthetic) return;
    const windows = this.regionWindows(region);
    const plan = planDeleteRegion(this.store.doc, region);
    if (plan.error) { alert(plan.error); return; }
    const bodyParts = [t("rgn.delBodyFrees", {
      human: fmtSize(plan.samples.reduce((n, w) => n + w.bytes.length, 0)),
    })];
    if (windows.length > 0) {
      bodyParts.push(t("rgn.delBodyKeeps", {
        n: windows.length,
        list: windows.slice(0, 6).map((e) => String(e.index).padStart(3, "0")).join(", "),
      }));
    }
    const res = await showModal({
      title: t("rgn.delTitle", { name: unescapeName(region.name) || t("rgn.namePlaceholder") }),
      body: bodyParts.join(" "),
      okLabel: t("smp.delOk"),
    });
    if (!res) return;
    this.store.undo.apply(importBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.selRegion = Math.max(-1, Math.min(this.selRegion, this.regions.length - 2));
    this.refresh();
  }

  /** Download a region as a WAV — every channel, bit-exact out of the pool. */
  exportRegion() {
    const region = this.selectedRegion();
    const doc = this.store.doc;
    if (!region || !doc?.sampleBin) return;
    const chans = regionSpans(region).map((sp) =>
      doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len));
    // The implicit recording declares no rate, so the file gets the engine's
    // own — it is a dump of memory, and every sample in it is at its own pitch
    // anyway.
    const bytes = encodeU8Wav(chans, region.rate || DEFAULT_RATE);
    download(bytes, `${sanitiseName(
      region.synthetic ? "sample memory" : unescapeName(region.name), "region")}.wav`);
  }

  /**
   * Cut the map's dragged window into a fresh instrument (item 175). No pool
   * bytes move: the instrument claims the recording's own bytes, so editing it
   * later edits the recording — which is the point of working this way.
   */
  async sliceToInstrument({ ptr, len, region, rate }) {
    const doc = this.store.doc;
    if (!doc || len <= 0) return;
    // Name it after where it came from: the recording plus the offset into it,
    // or — cutting out of plain memory — the sample the window starts inside,
    // which is what "the whole pool" is mostly made of.
    const under = region ? null : this.list.find((e) =>
      sampleSpans(e).some((sp) => ptr >= sp.ptr && ptr < sp.ptr + sp.len));
    const base = region
      ? `${unescapeName(region.name) || t("rgn.namePlaceholder")} ${ptr - region.ptr}`
      : under
        ? `${unescapeName(under.name) || `sample ${under.index}`} ${ptr - under.ptr}`
        : `memory ${ptr}`;
    const res = await showModal({
      title: t("pw.sliceModalTitle"),
      body: t("pw.sliceBody", { len, human: fmtSize(len), rate }),
      fields: [
        { name: "name", label: t("inst.sampleImportName"), value: base },
        { name: "loop", label: t("pw.sliceLoop"), type: "checkbox", value: false,
          hint: t("pw.sliceLoopHint") },
      ],
      okLabel: t("common.create"),
    });
    if (!res) return;
    const nameBytes = new TextEncoder().encode(escapeNonAscii(res.name || base));
    // A window cut out of plain pool bytes is planned against a region of one:
    // the plan only ever reads ptr, len, rate and channel count off it.
    const src = region ?? { ptr, len, rate, chan: 1, name: "" };
    const plan = planRegionSlice(doc, src, {
      from: ptr - src.ptr, len, nameBytes, loop: !!res.loop,
    });
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(importBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
    const at = this.list.findIndex((e) => e.ptr === plan.ptr && e.len === plan.sliceLen);
    if (at >= 0) this.selectSample(at);
    this.cb.onNewInstrument?.(plan.slot);
  }

  exportSample() {
    const s = this.list?.[this.selected];
    const doc = this.store.doc;
    if (!s || !doc?.sampleBin) return;
    const chans = sampleSpans(s).map((sp) => doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len));
    const bytes = encodeU8Wav(chans, s.rate);
    download(bytes, `${sanitiseName(s.name, `sample_${String(s.index).padStart(3, "0")}`)}.wav`);
  }

  refresh() {
    const doc = this.store.doc;
    this.listEl.innerHTML = "";
    this.rowEls = [];
    if (!doc) return;
    this.list = doc.sampleList();
    // The display list of recordings: the whole occupied pool FIRST — the
    // implicit recording every project has, including every project made
    // before SRgn existed — then whatever the document actually declares. The
    // synthetic one is a view: it reserves nothing, is never written, and
    // holds index 0 so adding or dropping a real recording cannot shuffle it
    // out from under the selection.
    const whole = wholeMemoryRegion(this.list.flatMap(sampleSpans), doc.sampleRegions());
    this.regions = [...(whole ? [whole] : []), ...doc.sampleRegions()];
    if (this.selRegion >= this.regions.length) this.selRegion = -1;

    // "Load recording…" sits over the list, where the Instruments view keeps
    // the buttons that fill a slot from outside the project.
    const bar = document.createElement("div");
    bar.className = "side-toolbar-inst";
    const loadBtn = document.createElement("button");
    loadBtn.textContent = t("rgn.load");
    loadBtn.title = t("rgn.loadTitle");
    loadBtn.addEventListener("click", () => this.loadRegion());
    bar.appendChild(loadBtn);
    this.listEl.appendChild(bar);

    const head = (text) => {
      const h = document.createElement("div");
      h.className = "side-head";
      h.textContent = text;
      this.listEl.appendChild(h);
    };

    // Regions first: they are the source material, and the samples under them
    // are cut out of them.
    if (this.regions.length > 0) {
      head(t("rgn.listHead"));
      this.regions.forEach((r, i) => {
        const row = document.createElement("div");
        row.className = "side-row rgn" + (r.synthetic ? " whole" : "") +
          (i === this.selRegion ? " sel" : "");
        row.innerHTML =
          `<span class="dot"></span>` +
          `<span class="idx">${r.synthetic ? escape(t("rgn.allTag")) : "R" + String(r.index).padStart(2, "0")}</span>` +
          `<span class="name">${escape(r.synthetic ? t("rgn.allName")
            : (unescapeName(r.name) || t("rgn.namePlaceholder")))}</span>` +
          (r.chan > 1 ? `<span class="smp-tag">\u00d7${r.chan}</span>` : "") +
          `<span class="dim">${fmtSize(regionBytes(r))}</span>`;
        row.addEventListener("click", () => {
          this.selRegion = i;
          this.refresh();
        });
        this.listEl.appendChild(row);
      });
      head(t("rgn.listSamples"));
    }

    this.list.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "side-row" +
        (i === this.selected && this.selRegion < 0 ? " sel" : "");
      row.innerHTML =
        `<span class="dot"></span>` +
        `<span class="idx">${String(i).padStart(3, "0")}</span>` +
        `<span class="name">${escape(unescapeName(s.name) || "(unnamed)")}</span>` +
        (isStereoSample(s) ? `<span class="smp-tag">${escape(t("smp.stereoTag"))}</span>` : "") +
        `<span class="dim">${(s.len / 1024).toFixed(1)}K</span>`;
      row.addEventListener("click", () => {
        this.selected = i;
        this.selRegion = -1;
        this.refresh();
      });
      this.listEl.appendChild(row);
      this.rowEls.push({ el: row, ptr: s.ptr, index: i });
    });

    const region = this.selectedRegion();
    this.toolbar.hidden = region !== null;
    this.regionBar.hidden = region === null;
    // Nothing declares the implicit recording, so there is nothing to rename
    // and nothing that deleting it could free — the samples in it are the
    // Samples list's own business.
    const synthetic = region?.synthetic === true;
    this.rgnRenameBtn.disabled = synthetic;
    this.rgnDeleteBtn.disabled = synthetic;
    this.rgnRenameBtn.title = synthetic ? t("rgn.wholeNoEdit") : t("rgn.renameTitle");
    this.rgnDeleteBtn.title = synthetic ? t("rgn.wholeNoEdit") : t("rgn.deleteTitle");
    // A region can never be drawn on one line, so selecting one IS the map.
    this.canvas.hidden = this.mapVisible();
    this.poolWave.element.hidden = !this.mapVisible();
    this.mapBtn.disabled = region !== null;

    this.updateInfo();
    this.hoverByte = -1;   // a different sample under the same pointer position
    if (this.mapVisible()) {
      this.poolWave.setScope(region
        ? { kind: "region", ptr: region.ptr, len: regionBytes(region) }
        : { kind: "pool", ptr: 0, len: POOL_SIZE });
      this.poolWave.refresh(this.selRegion < 0 ? this.selected : -1);
      // The map FOLLOWS the list: picking a row while the whole pool is on
      // screen has to bring that row into view, or selecting sample 20 leaves
      // you looking at address 0. Only on a real selection change, and
      // scrollToByte is a no-op when the row is already visible — so clicking a
      // claim in the map never scrolls the map out from under the pointer.
      const follow = region ? `r${this.selRegion}` : `s${this.selected}`;
      if (follow !== this._mapFollow) {
        this._mapFollow = follow;
        const s = region ? null : this.list[this.selected];
        if (s) this.poolWave.scrollToByte(s.ptr);
      }
    } else {
      this.drawWave();
    }
    if (this.poolOpen) this.pool.refresh(this.selRegion < 0 ? this.selected : -1);
  }

  /** Pointer over the waveform: latch the byte offset and repaint. The whole
   *  trace is redrawn rather than an overlay layer being kept — it is one pass
   *  over at most `width × 8` bytes, and it is already what the play cursors
   *  ride on sixty times a second. */
  wavePointerMove(e) {
    const s = this.list[this.selected];
    if (!s || !s.len) return;
    const r = this.canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const byte = Math.floor(((e.clientX - r.left) / r.width) * s.len);
    const lanes = sampleSpans(s).length;
    const lane = Math.min(lanes - 1, Math.max(0,
      Math.floor(((e.clientY - r.top) / r.height) * lanes)));
    const clamped = Math.min(Math.max(byte, 0), s.len - 1);
    if (clamped === this.hoverByte && lane === this.hoverLane) return;
    this.hoverByte = clamped;
    this.hoverLane = lane;
    this.drawWave();
  }

  clearWaveHover() {
    if (this.hoverByte < 0) return;
    this.hoverByte = -1;
    this.drawWave();
  }

  /** Light the list rows of samples any voice is sounding right now — the
   *  dot's brightness (item 169), not just on/off, follows lamp.js's volume-
   *  driven, slewed, probabilistic-sum ballistics (several instruments or
   *  notes sharing one sample combine rather than simply flag it "on"). */
  updateLiveDots() {
    if (!this.rowEls) return;
    const audio = this.store.audio;
    const now = performance.now();
    const dt = this._lampLastMs ? now - this._lampLastMs : 16;
    this._lampLastMs = now;
    const brightByKey = audio
      ? liveBrightnessByKey(audio, TOTAL_VOICES, (vi) => audio.getVoiceSamplePtr(vi))
      : new Map();
    for (const r of this.rowEls) {
      let lamp = this.lamps.get(r.ptr);
      if (!lamp) this.lamps.set(r.ptr, lamp = new Lamp());
      r.el.style.setProperty("--lamp", lamp.update(brightByKey.get(r.ptr) ?? 0, dt).toFixed(3));
    }
  }

  /**
   * Per-frame line under the sample's own: what funk repeat is doing to it
   * right now. The band on the canvas says WHERE; this says how far along the
   * sweep that is, and where the next hop lands — the two numbers you cannot
   * read off a 30-pixel block.
   */
  updateFunkReadout() {
    const s = this.selRegion < 0 ? this.list[this.selected] : null;
    const fws = s
      ? [...collectFunkWindows(this.store.audio, s), ...collectExtFunkWindows(this.store.audio, s)]
      : [];
    if (!fws.length) {
      if (this.funkInfo.textContent !== "") this.funkInfo.textContent = "";
      return;
    }
    const fw = fws[0];
    // The walk's grid is the HOP's, not the window's (item 163): a half- or
    // eighth-block walk visits four or eight times as many positions over the
    // same sample, and counting them in loop lengths would say "step 3 of 7"
    // while the band was plainly somewhere else. `fw.home` is the walk's own
    // domain start — Z's declared loop, or (extended funk) the resolved
    // region, which is not always the same thing.
    const hop = funkHopSize(fw);
    const blocks = Math.max(1, Math.floor((s.len - fw.len - fw.home) / hop) + 1);
    const at = Math.min(Math.max(Math.round((fw.window - fw.home) / hop), 0), blocks - 1) + 1;
    // The pending hop is only worth a clause while it differs from the window:
    // right after a restart latches it the two are equal, and printing the same
    // number twice reads as a bug rather than as "it has just landed".
    const next = fw.pending >= 0 && fw.pending !== fw.window
      ? t("smp.funkReadoutNext", { next: fw.pending }) : "";
    this.funkInfo.textContent =
      t("smp.funkReadout", { f: funkLabel(fw), at: fw.window, k: at, n: blocks }) + next;
  }

  updateInfo() {
    const region = this.selectedRegion();
    if (region?.synthetic) {
      // No rate and no name to print: a hundred samples at a hundred rates have
      // no single rate between them, which is exactly why a window cut out of
      // here takes the rate of whatever sample it lands in.
      const total = regionBytes(region);
      this.info.innerHTML =
        `<b>${escape(t("rgn.allName"))}</b> · ${escape(t("rgn.wholeKind"))} · ` +
        `0x0–0x${region.len.toString(16).toUpperCase()} · ` +
        `${escape(t("rgn.infoBytes", { n: total, human: fmtSize(total) }))} · ` +
        `${escape(t("rgn.wholeHolds", { n: this.regionWindows(region).length }))}`;
      return;
    }
    if (region) {
      const total = regionBytes(region);
      this.info.innerHTML =
        `<b>${escape(unescapeName(region.name) || escape(t("rgn.namePlaceholder")))}</b> · ` +
        `${escape(t("rgn.infoKind"))} · ptr 0x${region.ptr.toString(16).toUpperCase()} · ` +
        `${escape(t("rgn.infoBytes", { n: total, human: fmtSize(total) }))} · ` +
        `${escape(t("rgn.infoChans", { n: region.chan }))} · ${region.rate} Hz@C4 · ` +
        `${escape(t("rgn.infoSeconds", { s: (region.len / Math.max(1, region.rate)).toFixed(1) }))} · ` +
        `${escape(t("rgn.infoWindows", { n: this.regionWindows(region).length }))}`;
      return;
    }
    const s = this.list[this.selected];
    if (!s) { this.info.textContent = t("smp.noSamples"); return; }
    const loopModes = [t("smp.noLoop"), t("smp.loopForward"), t("smp.loopPingpong"), t("smp.loopOneshot")];
    this.info.innerHTML =
      `<b>${escape(unescapeName(s.name) || escape(t("smp.namePlaceholder")))}</b> · ptr 0x${s.ptr.toString(16).toUpperCase()} · ` +
      `${escape(t("smp.infoBytes", { n: s.len }))}${isStereoSample(s) ? " ×2" : ""} · ` +
      `${escape(t(isStereoSample(s) ? "smp.stereo" : "smp.mono"))} · ` +
      `${s.rate} Hz@C4 · ${escape(loopModes[s.loopMode & 3])}` +
      `${(s.loopMode & 3) !== 0 ? ` [${s.loopStart}..${s.loopEnd}]` : ""}` +
      `${(s.loopMode & 4) !== 0 ? ` · ${escape(t("smp.infoSustain"))}` : ""}` +
      ` · ${escape(t("smp.infoUsedBy", { list: s.users.map(instLabel).join(" ") }))}`;
  }

  /** Per-frame: live play cursors + list dots while audio runs. */
  frame() {
    if (!this.visible) return;
    const audio = this.store.audio;
    // Refresh the invert-loop masks of the shown sample's instruments so the
    // waveform overlay tracks the live S$Fx inversion (reply lands next frame).
    if (audio?.isPlaying() && this.selRegion < 0) {
      const s = this.list[this.selected];
      if (s) for (const inst of s.users) audio.requestInvertMask(inst);
    }
    if (this.mapVisible()) {
      // Only the overlay layer moves per frame — the trace is megabytes of
      // pool and has no business in the frame loop.
      if (audio?.isPlaying() || audio?.snapshot) this.poolWave.frame();
    } else if (audio?.isPlaying() || audio?.snapshot) {
      this.drawWave();
    }
    this.updateFunkReadout();
    this.updateLiveDots();
    // Only the tick layer — the map itself is arithmetic over the census and
    // has no business being repainted sixty times a second.
    if (this.poolOpen && (audio?.isPlaying() || audio?.snapshot)) this.pool.drawLive();
  }

  drawWave() {
    const s = this.list[this.selected];
    const doc = this.store.doc;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, this.right.clientWidth - 20);
    // One FULL lane per channel: a stereo sample gets a canvas twice as tall
    // rather than two half-height lanes — the view has the room, and squeezing
    // them would cost exactly the amplitude detail the display is for.
    const h = WAVE_LANE_H * (s ? sampleSpans(s).length : 1);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    const C = themeColors();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    if (!s || !doc?.sampleBin) return;
    const bin = doc.sampleBin;

    // loop region shading
    const hasLoop = (s.loopMode & 3) !== 0 && s.loopEnd > s.loopStart;
    if (hasLoop) {
      ctx.fillStyle = C.waveLoop;
      ctx.fillRect((s.loopStart / s.len) * w, 0, ((s.loopEnd - s.loopStart) / s.len) * w, h);
    }

    // Funk repeat (Z $F0xx, item 161; and extended notefx 2/3's own `$xuu`
    // 102/12x, item 173 follow-up) — where the loop has been walked TO. The
    // shading above is the loop the sample declares; this is the window the
    // voice is actually sounding, which the walk hops through the sample a whole
    // loop length at a time. Two marks per sounding voice: a filled band for the
    // window under the playhead, and an outline one block on for where the next
    // loop restart will jump. Identical windows are drawn once, so two voices
    // sitting on the same block do not stack into a brighter band. The two
    // commands "do not share state" (TAUD_NOTE_EFFECTS.md) and can both be
    // live on one voice at once, so both lists are drawn — the caption on
    // each band says which command owns it.
    const funkWindows = [
      ...collectFunkWindows(this.store.audio, s),
      ...collectExtFunkWindows(this.store.audio, s),
    ];
    if (funkWindows.length) {
      const xOf = (byte) => (byte / s.len) * w;
      for (const fw of funkWindows) {
        ctx.fillStyle = C.waveFunk;
        ctx.globalAlpha = 0.28;
        ctx.fillRect(xOf(fw.window), 0, Math.max(1, xOf(fw.len)), h);
        ctx.globalAlpha = 1;
        if (fw.pending >= 0 && fw.pending !== fw.window) {
          // Where the NEXT loop restart will jump to: a faint block plus a
          // dashed line on its leading edge. An outlined rectangle was tried
          // and reads as noise once the trace is drawn over the middle of it.
          ctx.fillStyle = C.waveFunk;
          ctx.globalAlpha = 0.10;
          ctx.fillRect(xOf(fw.pending), 0, Math.max(1, xOf(fw.len)), h);
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = C.waveFunk;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(Math.round(xOf(fw.pending)) + 0.5, 0);
          ctx.lineTo(Math.round(xOf(fw.pending)) + 0.5, h);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        // Name the band where there is room for it — a teal block over a
        // waveform means nothing on its own, and the effect code is the one
        // caption that needs no translating.
        if (xOf(fw.len) >= 46) {
          ctx.fillStyle = C.waveFunk;
          ctx.globalAlpha = 0.9;
          ctx.font = "10px sans-serif";
          ctx.fillText(funkLabel(fw), xOf(fw.window) + 4, h - 4);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Live sample-modification overlay: the invert loop's per-instrument XOR
    // mask (S$Fx, and notefx 2/3's INVERT operation) flips bytes by 0xFF and
    // persists like ProTracker's destructive EFx; notefx 2/3 can also rotate a
    // region's bytes, scatter them one by one, or slide their level. Everything
    // the modifications touch — inverted, moved or shifted — is drawn in the
    // invert colour. (taut.js)
    const audio = this.store.audio;
    let invertMask = null;
    let mod = null;
    let modMask = null;
    if (audio) {
      for (const inst of s.users) {
        const m = audio.getInvertMask(inst);
        if (m && m.length) { invertMask = m; break; }
      }
      for (const inst of s.users) {
        const g = audio.getSampleMod(inst);
        if (g && g.modOn) { mod = g; modMask = audio.getModMask(inst); break; }
      }
    }
    // The region is a FRACTION of the sample's loop region (item 153), resolved
    // here through the engine's own geometry — the snapshot carries the
    // instrument's field names precisely so this cannot drift from playback.
    const modGeom = new ModGeom();
    if (mod) resolveModGeom(modGeom, mod, s.loopStart, s.loopEnd, s.len);
    const modLive = mod !== null && modGeom.live;
    // Argument extension (item 162, `2`/`3 $sexy : $fuuk`): the wider $xuu
    // table plus $f's sub-range narrowing replace the classic $x/$se-only test
    // and address transform whenever an instrument's modOpExt is non-zero (the
    // two are mutually exclusive — inst.js setModOp/setModOpExt).
    const extended = mod !== null && mod.modOpExt !== 0;
    const touches = extended
      ? (p) => extModTouches(modGeom, mod.modInvert, mod.modF, mod.modStepIndex, p)
      : (p) => modTouches(modGeom, mod.modInvert, p);
    // A mask sized for a shorter sample than the one on screen (the engine
    // grows it lazily) stops where the bits do.
    const invertEnd = invertMask
      ? Math.min(s.loopEnd, s.loopStart + invertMask.length * 8) : 0;
    const byteAt = (p, base = s.ptr) => {
      let src = p;
      const hit = modLive && touches(p);
      // The scatter throws every byte its own way, so the picture has to be
      // drawn through the engine's own mapping rather than one offset. The
      // extended table adds its own address transforms (mirror, byte-pair
      // swap) that the classic modAddress knows nothing about.
      if (hit) {
        src = extended
          ? modAddressExt(modGeom, p, mod)
          : modAddress(modGeom, p, mod.modRot, mod.modScatter, mod.modSeed);
      }
      let v = bin[base + src];
      let flipped = src !== p;
      // The legacy mask is tested against the byte actually READ, exactly as
      // the engine does — a rotation moves which byte that is.
      if (invertMask && src >= s.loopStart && src < invertEnd) {
        const k = src - s.loopStart;
        if ((invertMask[k >>> 3] >>> (k & 7)) & 1) { v ^= 0xff; flipped = true; }
      }
      if (hit) {
        if (modMask && modMask.length) {
          if ((modMask[src >>> 3] >>> (src & 7)) & 1) { v ^= 0xff; flipped = true; }
        } else if (extended) {
          // xor / sub-add / bit-rotate / bit-permute (item 162's level-only
          // transforms) — only ever one live at a time, same as the classic
          // form's own modSub, so applying all four unconditionally is safe.
          const lv = applyExtLevel(mod, v);
          if (lv !== v) { v = lv; flipped = true; }
        } else if (mod.modSub) { v = (v - mod.modSub) & 0xff; flipped = true; }
      }
      return { v, flipped };
    };

    // Bars anchored to the centre line (taut style): value 128 sits at the
    // middle, each bar filled from the baseline out to its sample value. A
    // stereo sample (item 90) draws one lane per channel, stacked, sharing the
    // loop shading and the play cursors — it is one sample, seen twice.
    const spans = sampleSpans(s);
    const laneH = h / spans.length;
    spans.forEach((span, li) => {
      const top0 = li * laneH;
      const baseY = top0 + laneH / 2;
      const yOf = (v) => top0 + (laneH * (255 - v)) / 255;
      ctx.fillStyle = C.waveMid ?? C.dim;
      ctx.fillRect(0, Math.round(baseY), w, 1);
      const at = (i) => byteAt(i, span.ptr);

      if (s.len <= w) {
        const rectW = Math.max(1, Math.ceil(w / s.len));
        for (let i = 0; i < s.len; i++) {
          const { v, flipped } = at(i);
          const yv = yOf(v);
          const top = Math.min(baseY, yv);
          ctx.fillStyle = flipped ? C.waveInvert : C.wave;
          ctx.fillRect(Math.floor((i * w) / s.len), top, rectW, Math.max(1, Math.abs(baseY - yv)));
        }
      } else {
        for (let col = 0; col < w; col++) {
          const start = Math.floor((col * s.len) / w);
          const end = Math.min(s.len, Math.floor(((col + 1) * s.len) / w));
          if (end <= start) continue;
          const step = Math.max(1, ((end - start) / 8) | 0);
          let mn = 255, mx = 0, anyFlip = false;
          for (let p = start; p < end; p += step) {
            const { v, flipped } = at(p);
            if (v < mn) mn = v;
            if (v > mx) mx = v;
            if (flipped) anyFlip = true;
          }
          const yTop = Math.min(baseY, yOf(mx));
          const yBot = Math.max(baseY, yOf(mn));
          ctx.fillStyle = anyFlip ? C.waveInvert : C.wave;
          ctx.fillRect(col, yTop, 1, Math.max(1, yBot - yTop + 1));
        }
      }
      if (spans.length > 1) {
        ctx.fillStyle = C.fg2 ?? C.fg;
        ctx.globalAlpha = 0.85;
        ctx.font = "10px sans-serif";
        ctx.fillText(t(li === 0 ? "lab.chanL" : "lab.chanR"), 3, top0 + 11);
        ctx.globalAlpha = 1;
        if (li > 0) {
          ctx.fillStyle = C.dim;
          ctx.globalAlpha = 0.6;
          ctx.fillRect(0, Math.round(top0), w, 1);
          ctx.globalAlpha = 1;
        }
      }
    });

    // Live play-position cursors — vertical bars in the waveform's OWN cursor
    // colour, which no part of the trace can wear: the old one was the same
    // orange as a byte the sample-modification command has inverted, so the
    // hairline disappeared into exactly the picture it was measuring (item 160).
    if (audio) {
      ctx.fillStyle = C.waveCursor ?? C.playCursor;
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
        if (!audio.getVoiceActive(vi)) continue;
        if (audio.getVoiceSamplePtr(vi) !== s.ptr) continue;
        const pos = audio.getVoiceSamplePos(vi);
        if (pos < 0 || pos > s.len) continue;
        const x = (pos / s.len) * w;
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }

    // Hover hairline + byte readout (item 171). Drawn LAST so it is never lost
    // under the trace, and in the foreground ink rather than any of the four
    // colours the picture itself already uses — a measuring line that could be
    // mistaken for a play cursor or an inverted byte measures nothing.
    if (this.hoverByte >= 0 && this.hoverByte < s.len) {
      const hx = Math.round((this.hoverByte / s.len) * w) + 0.5;
      ctx.save();
      ctx.strokeStyle = C.fg;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const lane = Math.min(this.hoverLane, spans.length - 1);
      const { v } = byteAt(this.hoverByte, spans[lane].ptr);
      const label = t("smp.hoverByte", {
        at: this.hoverByte,
        hex: this.hoverByte.toString(16).toUpperCase(),
        v,
      });
      ctx.font = "10px sans-serif";
      const tw = ctx.measureText(label).width;
      // Flip to the left of the line when the label would run off the canvas,
      // so the number stays readable at the end of the sample.
      const lx = hx + 5 + tw <= w ? hx + 5 : hx - 5 - tw;
      const ly = lane * laneH + 4;
      ctx.fillStyle = C.panel;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(lx - 3, ly, tw + 6, 13);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.fg;
      ctx.fillText(label, lx, ly + 10);
      ctx.restore();
    }
  }
}

/** The walk's hop in bytes: the window's length shifted by `$f`'s low two bits
 *  ($0 a whole block, $3 an eighth of one), never less than a byte. */
function funkHopSize(fw) {
  return Math.max(1, fw.len >> (fw.mode & 3));
}

/** How the command that is driving this window is spelled — `$F0` … `$FF`. The
 *  effect code is the one caption that needs no translating. */
function funkSpelling(fw) {
  return `$F${(fw.mode & 0xf).toString(16).toUpperCase()}`;
}

/** Extended funk repeat's own spelling — the exact `$xuu` code (`$102`,
 *  `$123`, …), unlike Z's template above: there is no separate speed byte to
 *  fold away, `modOpExt` already names this one instance exactly. */
function extFunkSpelling(fw) {
  return `$${fw.opExt.toString(16).toUpperCase().padStart(3, "0")}`;
}

/** The caption for either kind of funk window, from `collectFunkWindows`
 *  (`Z $Fxxx`, a template — `fw.mode` present, `fw.opExt` is not) or
 *  `collectExtFunkWindows` (`fw.opExt`, the exact extended code). */
function funkLabel(fw) {
  return fw.opExt !== undefined ? extFunkSpelling(fw) : `Z ${funkSpelling(fw)}xx`;
}

/**
 * The distinct funk-repeat windows live on `s` right now, newest state per
 * frame: `{ window, pending, len }` in bytes plus the walk's `mode` (item
 * 163's `$f`), ready to scale onto the canvas.
 *
 * The width comes from the VOICE (its active loop length), not from the
 * document's loop points — an Ixmp patch replaces those under a sounding voice
 * (item 116), and a band drawn at the document's width would then be the wrong
 * size on exactly the instrument whose loop is most worth watching.
 */
function collectFunkWindows(audio, s) {
  const out = [];
  if (!audio || !s) return out;
  const home = (s.loopMode & 3) !== 0 ? s.loopStart : 0;
  for (let vi = 0; vi < TOTAL_VOICES; vi++) {
    if (!audio.getVoiceActive(vi)) continue;
    if (audio.getVoiceSamplePtr(vi) !== s.ptr) continue;
    const len = audio.getVoiceFunkLen(vi);
    const window = audio.getVoiceFunkWindow(vi);
    if (!(len > 0) || window < 0 || window + len > s.len) continue;
    const pending = audio.getVoiceFunkPos(vi);
    const mode = audio.getVoiceFunkMode(vi) | 0;
    if (out.some((o) => o.window === window && o.len === len
      && o.pending === pending && o.mode === mode)) continue;
    out.push({ window, pending, len, mode, home });
  }
  return out;
}

/**
 * Extended `2`/`3 $sexy : $fuuk`'s own funk repeat (`$xuu` 102/12x, item 173
 * follow-up) — the SAME idea as `collectFunkWindows` above, but this walk is
 * the INSTRUMENT's (shared by every voice sounding it), not the voice's own,
 * and its window is a SEPARATE latch from Z's (the two "do not share state"
 * and may be live on one voice at once). The window's pending target and
 * width therefore come from the instrument's queried mod state
 * (`audio.getSampleMod`, the same reply the invert/rotate overlay below
 * already polls via `s.users`) rather than a voice snapshot field; only the
 * voice's own latched restart point (`getVoiceModFunkWindow`) is per-voice.
 * `home` is the resolved region's own start — the "loop" this walk's hop is
 * measured from — which is not always the sample's declared loop the way
 * Z's is (`$se`/`$f` can narrow further, or there may be no loop at all).
 */
function collectExtFunkWindows(audio, s) {
  const out = [];
  if (!audio || !s) return out;
  const modGeom = new ModGeom();
  for (let vi = 0; vi < TOTAL_VOICES; vi++) {
    if (!audio.getVoiceActive(vi)) continue;
    if (audio.getVoiceSamplePtr(vi) !== s.ptr) continue;
    const instSlot = audio.getVoiceInstrument(vi);
    const mod = audio.getSampleMod(instSlot);
    if (!mod || !isExtFunkOp(mod.modOpExt)) continue;
    const len = mod.modFunkLen;
    const window = audio.getVoiceModFunkWindow(vi);
    if (!(len > 0) || window < 0 || window + len > s.len) continue;
    const pending = mod.modFunkPos;
    resolveModGeom(modGeom, mod, s.loopStart, s.loopEnd, s.len);
    const home = modGeom.live ? modGeom.ds : 0;
    if (out.some((o) => o.window === window && o.len === len
      && o.pending === pending && o.opExt === mod.modOpExt)) continue;
    out.push({ window, pending, len, mode: 3, opExt: mod.modOpExt, home });
  }
  return out;
}

/** Byte counts as a person reads them — a region is usually megabytes. */
function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
