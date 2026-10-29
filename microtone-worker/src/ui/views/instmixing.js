// The Instruments view's MIXING tab (item 217): the instrument's IMix chain —
// which block it uses, the fourteen pieces of equipment in their fixed order,
// and four monitors on the instrument's own bus.
//
// The chain is the BLOCK's, not the instrument's: two instruments naming one
// block share every setting — and, in bus mode, the bus itself (item 247:
// separate mode gives each its own instance) — so this tab says who else is
// on it and offers to make a private copy. The block's name is the IMcn
// section's, "Chain N" while it has none. A piece
// of equipment is absent until it is first switched on; from then on it stays
// in the block (§9.15: equipment is never retired once touched) and the switch
// bypasses it.
//
// Every unit folds to its titlebar (components/fold.js). The fold is the
// BLOCK's, saved with it — the folded flag beside each piece's bypass (§9.15) —
// so every instrument on a chain opens it alike; it is written straight into
// the section and never enters the undo history. A piece not in the chain has
// no record to hold it, so its fold lives for the session and is written into
// the record the moment the piece is inserted. That piece still shows its
// settings at their defaults: moving one inserts the piece switched OFF
// (touched, so it stays — but nothing sounds different until its switch says
// so).
//
// Rebuilds vs refreshes, as in the Mastering tab: a slider drag is a stream of
// edits, so an edit only REPAINTS values (refreshValues); the DOM is rebuilt
// when the block's SHAPE changes — a band added, a shape picked, the chain
// swapped for another — which no drag can do. Inserting a piece is NOT a new
// shape: its body was already drawn from the same defaults.
//
// The plots (the spectra in the equalisers, the dynamic EQs, the transient
// shaper and the compressor, the saturator's transfer, the unison's copies) paint from the
// frame loop while the bus runs and for REST_MS after, on an edit, and when
// the hairline cursor moves over a spectrum — never on a schedule.

import {
  IMX_PIPELINES, IMX_WET_APPLICABLE, IMX_RANGE, FX16,
  IMX_ITRM, IMX_EXPD, IMX_EQU1, IMX_EQU2, IMX_COMP, IMX_DEQ1, IMX_DEQ2, IMX_TSH1, IMX_SATU, IMX_UNIS,
  IMX_VERB, IMX_DLAY, IMX_LIMI, IMX_MXTL,
  IMX_EQ_SHAPES, IMX_EQ_MAX_BANDS, IMX_EQ_BELL, IMX_SLOPES, IMX_COMP_MAX_BANDS, IMX_TSH_MAX_BANDS,
  IMX_DEQ_BANDS, IMX_SAT_CURVES, IMX_UNIS_MIN_VOICES, IMX_UNIS_MAX_VOICES,
  IMX_LFO_WAVES, IMX_RING_FRAMES, IMX_TAP_STAGES,
  IMX_DEQ_LOW_SHELF_BAND, IMX_DEQ_HIGH_SHELF_BAND,
  defaultEquipment, defaultImixBlock, defaultCompBand, defaultTshBand, resizeSplit, IMX_XOVER_GAP,
  normaliseImixBlock, normaliseEquipment, imixBlockEqual, isCutShape, InstrumentChain,
  makeImixMeterReadout, imxSatTransfer, unisonPositions,
} from "../../../core/engine/imix.js";
import { COMP_PEAK, COMP_RMS } from "../../../core/engine/mastering.js";
import { SAMPLING_RATE } from "../../../core/engine/constants.js";
import { SURROUND_STEREO } from "../../../core/engine/spatial.js";
import { Fft, hannWindow, spectrumDb, tiltDbAt } from "../../../core/engine/fft.js";
import {
  freqAt, colOfFreq, fmtDb, stepColumns, drawSpecGround, fillBands, strokeColumns,
  trackCursor, drawCursor, drawBarRules,
} from "./imixplots.js";
import { setImixOp, setInstFieldOp, setSectionOp, compositeOp } from "../../doc/ops.js";
import { IMCN_FOURCC } from "../../../core/format/imix-section.js";
import { unescapeName, escapeNonAscii } from "../../../core/format/names.js";
import { MOTIF } from "../../../core/fonts/motifglyphs.js";
import { SCOPE_GAIN_MAX } from "../crtscope.js";
import { showNotice } from "../components/modal.js";
import { makeFoldable } from "../components/fold.js";
import { lampButton } from "../components/lampbutton.js";
import { flipSwitch } from "../components/flipswitch.js";
import { themeColors } from "../theme.js";
import { canvasMonoFont } from "../fonts.js";
import { uiDpr, localPoint } from "../zoom.js";
import { t } from "../i18n.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hex3 = (s) => "$" + s.toString(16).toUpperCase().padStart(3, "0");

const METER_MIN_DB = -60;
const METER_MAX_DB = 6;
const GR_MAX_DB = 24;
const PEAK_HOLD_MS = 1500;
const PEAK_FALL_DB_S = 20;
const SPEC_MIN_DB = -96;
const SPEC_MAX_DB = -6;
const SPEC_ATTACK = 0.55;
const SPEC_RELEASE_DB_S = 42;
const SPEC_HOLD_FALL_DB_S = 8;
const CURVE_DB = 24;          // the EQ curve's ± axis
const MONITOR_SPEC_H = 220;
const UNIT_SPEC_H = 120;
/** The threshold strips: a row per band on the threshold's own scale. */
const THR_ROW_H = 18;
const THR_TOP = 14;          // the axis labels above the rows
const THR_LABEL_W = 30;
const THR_VALUE_W = 62;
const THR_FALL_DB_S = 30;
/** How long the monitors keep painting after the bus last ran, so the
 *  ballistics come to rest instead of freezing mid-fall. */
const REST_MS = 2000;
const frac = (db, lo, hi) => clamp((db - lo) / (hi - lo), 0, 1);
/** The expander's floor never sits above its threshold: moving either one past
 *  the other carries the other along, so the one the user touched is the one
 *  that lands where they put it. */
const expdThreshold = (x, v) => { x.threshDb = v; if (x.floorDb > v) x.floorDb = v; };
const expdFloor = (x, v) => { x.floorDb = v; if (v > x.threshDb) x.threshDb = v; };
/** Where a floor switched on starts: 12 dB under the threshold. */
const EXPD_FLOOR_GAP_DB = 12;
/** A threshold strip's scale: the expander's reaches further down. */
const thresholdRange = (id) => IMX_RANGE[id === IMX_EXPD ? "expdThreshDb" : "compThreshDb"];
/** The dynamic EQ's bands as the rack lists them: the low shelf, the four
 *  bells, the high shelf — low to high, whatever their slots in the file. */
const DEQ_ORDER = [IMX_DEQ_LOW_SHELF_BAND, 2, 3, 4, 5, IMX_DEQ_HIGH_SHELF_BAND];
const deqShort = (i) => (i === IMX_DEQ_LOW_SHELF_BAND ? "LS" : i === IMX_DEQ_HIGH_SHELF_BAND ? "HS" : `B${i - 1}`);
/** Octaves a band-pass of quality q spans between its −3 dB points. */
const octavesOfQ = (q) => (2 * Math.asinh(1 / (2 * q))) / Math.LN2;

/** The LFO waveforms' glyphs, in IMX_LFO_* order (Motif Grid; two periods
 *  each, as the vibrato's buttons show them). */
const LFO_GLYPH = [MOTIF.WAVE_SINE, MOTIF.WAVE_TRIANGLE, MOTIF.WAVE_SQUARE,
  MOTIF.WAVE_RAMP_UP, MOTIF.WAVE_RAMP_DOWN, MOTIF.WAVE_RANDOM];

/** The unit each equipment's name is looked up under. */
const NAME_KEY = {
  [IMX_ITRM]: "imix.itrm", [IMX_EXPD]: "imix.expd", [IMX_EQU1]: "imix.equ1", [IMX_DEQ1]: "imix.deq1",
  [IMX_TSH1]: "imix.tsh1", [IMX_COMP]: "imix.comp", [IMX_EQU2]: "imix.equ2", [IMX_DEQ2]: "imix.deq2",
  [IMX_UNIS]: "imix.unis", [IMX_SATU]: "imix.satu", [IMX_DLAY]: "imix.dlay",
  [IMX_VERB]: "imix.verb", [IMX_LIMI]: "imix.limi", [IMX_MXTL]: "imix.mxtl",
};

export class MixingPanel {
  constructor(view) {
    this.view = view;
    this.store = view.store;
    this.root = null;
    this.controls = [];
    this.gesture = null;
    this._dragging = null;
    this._shape = "";
    this.stage = 1;          // the level meter's side: 0 pre, 1 post
    this.readout = makeImixMeterReadout();
    this.peakHold = [-144, -144, -144, -144];
    this.peakHoldUntil = [0, 0, 0, 0];
    this.clipUntil = [0, 0, 0, 0];
    this.gr = { comp: new Float64Array(IMX_COMP_MAX_BANDS), deq1: new Float64Array(IMX_DEQ_BANDS),
      deq2: new Float64Array(IMX_DEQ_BANDS), tsh1: new Float64Array(IMX_TSH_MAX_BANDS), expd: 0, lim: 0 };
    this.lastLive = 0;
    this._lastFrame = 0;
    this.fft = new Fft(IMX_RING_FRAMES);
    const hann = hannWindow(IMX_RING_FRAMES);
    this.specWin = hann.win;
    this.specNorm = 1 / ((IMX_RING_FRAMES / 2) * hann.sumSq);
    this.specMono = new Float32Array(IMX_RING_FRAMES);
    this.specBins = new Float64Array(IMX_RING_FRAMES >> 1);
    this.specBinsPre = new Float64Array(IMX_RING_FRAMES >> 1);
    this.specTilt = new Float64Array(IMX_RING_FRAMES >> 1);
    for (let k = 1; k < this.specTilt.length; k++) {
      this.specTilt[k] = tiltDbAt((k * SAMPLING_RATE) / IMX_RING_FRAMES);
    }
    this.specCols = null; this.specPre = null; this.specHold = null;
    this.specCursor = null;
    this.gonioGain = 1;
    /** A chain kept off the audio path purely to draw the EQ curve with. */
    this.curveChain = null;
    /** Per piece: a chain holding only that piece, in circuit — its own
     *  response for the unit's plot, whether or not the piece is in the block. */
    this.unitChains = new Map();
    /** Per spectral piece: { cols, bins } — its input spectrum's columns. */
    this.unitSpec = new Map();
    /** The plots inside the units: { canvas, paint(C, live, dt) }. */
    this.plots = [];
    /** A cursor moved over a resting plot: the next frame repaints. */
    this._cursorDirty = false;
    this._ghosts = new Map();
    /** Open or not, per `${block}:${piece}`, for pieces the block does not hold. */
    this._ghostOpen = new Map();
    /** The band each compressor / dynamic EQ is editing, by piece. */
    this._bandSel = new Map();

    this.store.on("edit", (tags) => {
      if (!this.root?.isConnected) return;
      // A chain renamed (or a rename undone): every label naming it.
      if (tags?.some?.((x) => x.kind === "section" && x.fourcc === IMCN_FOURCC)) {
        this.view.renderPanel();
        return;
      }
      if (!tags?.some?.((x) => x.kind === "imix")) return;
      // An undo can insert a piece or add a band — that is a new shape.
      if (this.shapeKey() !== this._shape) this.view.renderPanel();
      else this.refreshValues();
    });
  }

  // ── the document ──

  get doc() { return this.store.doc; }
  get slot() { return this.view.selected; }
  get inst() { return this.doc?.instruments[this.slot] ?? null; }
  get blockId() { return this.inst?.imixId ?? 0; }
  get block() { return this.blockId ? this.doc.imixBlock(this.blockId) : null; }

  /** A piece's settings: the block's, or — while it is not in the chain — the
   *  defaults it would be inserted with. */
  eqp(id) {
    const e = this.block?.equipment[id];
    if (e) return e;
    if (!this._ghosts.has(id)) this._ghosts.set(id, normaliseEquipment(id, defaultEquipment(id)));
    return this._ghosts.get(id);
  }

  /** Is piece `id`'s unit open? The block's flag, or the session's for a
   *  piece not yet in it (shut until opened). */
  unitOpen(id) {
    const e = this.block?.equipment[id];
    if (e) return !e.folded;
    return this._ghostOpen.get(`${this.blockId}:${id}`) ?? false;
  }

  setUnitOpen(id, open) {
    this._ghostOpen.set(`${this.blockId}:${id}`, open);
    if (this.block?.equipment[id] && this.doc.setImixFolded(this.blockId, id, !open)) this.store.emit("status");
  }

  /** A piece being inserted, folded as its unit is shown. */
  inserted(id, extra = {}) {
    return { ...defaultEquipment(id), ...extra, folded: !this.unitOpen(id) };
  }

  /** Is the piece in the block and not bypassed? */
  inCircuit(id) {
    const e = this.block?.equipment[id];
    return !!e && !e.bypass;
  }

  /** What decides the DOM: which pieces are in, how many bands each has. */
  shapeKey() {
    const b = this.block;
    if (!b) return `none:${this.blockId}`;
    const parts = [b.id, b.order, b.bus];
    for (const id of IMX_PIPELINES[0]) {
      const e = this.eqp(id);
      parts.push(`${id}:${e.bands?.length ?? 0}:${e.sync ?? ""}:${e.floorDb === -Infinity ? "x" : e.floorDb === undefined ? "" : "f"}${e.keyFilter ?? ""}:` +
        `${e.detuneLfo?.sync ?? ""}${e.widthLfo?.sync ?? ""}:` +
        `${(e.bands ?? []).map((x) => `${x.shape ?? ""}${x.unlinked ? "u" : ""}`).join("")}`);
    }
    return parts.join("|");
  }

  /** Apply a change to the block. `mutate` gets a mutable copy. */
  edit(mutate, control = null) {
    const doc = this.doc;
    const cur = this.block;
    if (!doc || !cur) return;
    const next = normaliseImixBlock(cur);
    mutate(next);
    const norm = normaliseImixBlock(next);
    if (imixBlockEqual(norm, cur)) return;
    this.store.undo.apply(setImixOp(doc.imixPayloadWith(cur.id, norm), control, this.gesture));
    if (this.shapeKey() !== this._shape) this.view.renderPanel();
    else this.refreshValues();
  }

  /** Edit one piece. A piece not yet in the chain is inserted, switched off:
   *  touching a setting is touching the piece, but only its switch puts it in
   *  circuit. */
  editEquipment(id, mutate, control = null) {
    this.edit((b) => {
      if (!b.equipment[id]) b.equipment[id] = this.inserted(id, { bypass: true });
      mutate(b.equipment[id]);
    }, control ? `${id}:${control}` : null);
  }

  beginGesture() { this.gesture = `imx-${Date.now()}-${Math.random()}`; }
  endGesture() { this.gesture = null; }

  // ── assigning chains ──

  newChain() {
    const doc = this.doc;
    const id = doc.freeImixId();
    if (id === 0) { showNotice({ title: t("imix.title"), body: t("imix.full") }); return; }
    this.store.undo.apply(compositeOp([
      setImixOp(doc.imixPayloadWith(id, defaultImixBlock(id))),
      setInstFieldOp(this.slot, "imixId", id),
    ]));
  }

  /** Put this instrument on block `id` (any block of the project, used or not). */
  useChain(id) {
    if (id === 0 || id === this.blockId || !this.doc.imixBlock(id)) return;
    this.store.undo.apply(setInstFieldOp(this.slot, "imixId", id));
  }

  makeIndependent() {
    const doc = this.doc;
    const cur = this.block;
    if (!cur) return;
    const id = doc.freeImixId();
    if (id === 0) { showNotice({ title: t("imix.title"), body: t("imix.full") }); return; }
    this.store.undo.apply(compositeOp([
      setImixOp(doc.imixPayloadWith(id, { ...normaliseImixBlock(cur), id })),
      setInstFieldOp(this.slot, "imixId", id),
    ]));
  }

  removeChain() {
    if (this.blockId === 0) return;
    this.store.undo.apply(setInstFieldOp(this.slot, "imixId", 0));
  }

  /** Every OTHER chain of the project, as [id, label] — by its block, not by
   *  the instruments on it, so a chain nobody uses any more (it stays until the
   *  project is saved) can still be gone back to. */
  otherChains() {
    const doc = this.doc;
    const out = [];
    for (const b of doc.imixBlocks()) {
      if (b.id === this.blockId) continue;
      const users = doc.imixUsers(b.id).filter((s) => s !== this.slot);
      out.push([b.id, users.length === 0
        ? t("imix.chainUnused", { chain: this.chainLabel(b.id) })
        : t("imix.chainUsers", { chain: this.chainLabel(b.id), list: users.map((s) => this.instLabel(s)).join(", ") })]);
    }
    return out;
  }

  /** How a chain is listed: its number, and its name when it has one. */
  chainLabel(id) {
    const name = unescapeName(this.doc.imixName(id));
    return name ? t("imix.chainNamed", { id, name }) : t("imix.chainN", { id });
  }

  /** Name chain `id` (IMcn) — "" takes the name away, back to "Chain N". */
  renameChain(id, text) {
    const doc = this.doc;
    const escaped = escapeNonAscii(text.trim());
    if (!doc || escaped === doc.imixName(id)) return;
    this.store.undo.apply(setSectionOp(IMCN_FOURCC, doc.buildImixNames(id, escaped)));
  }

  surroundSong() {
    const song = this.doc?.songs[this.store.songIndex];
    return !!song && song.surroundModel !== SURROUND_STEREO;
  }

  instLabel(s) {
    return `${hex3(s)} ${unescapeName(this.doc.instrumentName(s)) || t("inst.unnamed")}`;
  }

  // ── building ──

  render(host) {
    this.controls = [];
    this.plots = [];
    this.unitChains.clear();
    this.root = document.createElement("div");
    this.root.className = "imx-tab";
    host.appendChild(this.root);
    this._shape = this.shapeKey();
    const doc = this.doc;
    const inst = this.inst;
    if (!doc || !inst) return;
    this.root.appendChild(this.buildHead());
    const block = this.block;
    if (!block) { this.syncTap(); return; }
    const grid = document.createElement("div");
    grid.className = "imx-grid";
    const rack = document.createElement("div");
    rack.className = "imx-rack";
    for (const id of IMX_PIPELINES[block.order]) rack.appendChild(this.unit(id));
    grid.append(rack, this.buildMonitors());
    this.root.appendChild(grid);
    this.curveChain = new InstrumentChain(block, SAMPLING_RATE, 2, true);
    this.refreshValues();
    this.syncTap();
  }

  buildHead() {
    const head = document.createElement("div");
    head.className = "imx-head";
    const doc = this.doc;
    const block = this.block;
    const note = (key, args) => {
      const p = document.createElement("p");
      p.className = "mst-hint";
      p.textContent = t(key, args);
      return p;
    };
    if (this.view._childSelected === this.slot) head.appendChild(note("imix.childNote"));
    const song = doc.songs[this.store.songIndex];
    if (song && song.surroundModel !== SURROUND_STEREO) head.appendChild(note("imix.surroundNote"));

    const bar = document.createElement("div");
    bar.className = "imx-headbar";
    const newBtn = document.createElement("button");
    newBtn.textContent = t("imix.newChain");
    newBtn.title = t("imix.newChainTitle");
    newBtn.addEventListener("click", () => this.newChain());

    const others = this.otherChains();
    const use = document.createElement("select");
    use.title = t("imix.useChainTitle");
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = t("imix.useChain");
    use.appendChild(o0);
    for (const [s, label] of others) {
      const o = document.createElement("option");
      o.value = String(s);
      o.textContent = label;
      use.appendChild(o);
    }
    use.disabled = others.length === 0;
    use.addEventListener("change", () => { if (use.value !== "") this.useChain(+use.value); });

    if (!block) {
      head.appendChild(note("imix.none"));
      bar.append(newBtn, use);
      head.appendChild(bar);
      return head;
    }

    // The chain's name, edited in place; unnamed, it reads "Chain N".
    const title = document.createElement("input");
    title.type = "text";
    title.className = "imx-name";
    title.value = unescapeName(doc.imixName(block.id));
    title.placeholder = t("imix.chainN", { id: block.id });
    title.title = t("imix.nameTitle", { id: block.id });
    title.setAttribute("aria-label", t("imix.nameTitle", { id: block.id }));
    title.spellcheck = false;
    title.addEventListener("change", () => this.renameChain(block.id, title.value));
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") title.blur();
      else if (e.key === "Escape") { title.value = unescapeName(doc.imixName(block.id)); title.blur(); }
      e.stopPropagation(); // typing a name is not playing the keyboard
    });
    const power = this.lamp(t("imix.enabled"), () => this.block?.enabled ?? false,
      (on) => this.edit((b) => { b.enabled = on; }), t("imix.enabledTitle"));
    // Separate: one copy of the chain per instrument. Bus: one, over their sum.
    const mode = this.segButtons(t("imix.mode"), [
      [false, t("imix.modeSeparate"), t("imix.modeSeparateTitle")],
      [true, t("imix.modeBus"), t("imix.modeBusTitle")],
    ], () => this.block?.bus ?? false, (v) => this.edit((b) => { b.bus = v; }));
    mode.classList.add("imx-mode");
    const order = this.choiceSelect([[0, t("imix.order0")], [1, t("imix.order1")]],
      () => this.block?.order ?? 0, (v) => this.edit((b) => { b.order = v; }));
    order.title = t("imix.orderTitle");
    const users = doc.imixUsers(block.id).filter((s) => s !== this.slot);
    const indep = document.createElement("button");
    indep.textContent = t("imix.makeIndependent");
    indep.title = t("imix.makeIndependentTitle");
    indep.disabled = users.length === 0;
    indep.addEventListener("click", () => this.makeIndependent());
    const remove = document.createElement("button");
    remove.textContent = t("imix.remove");
    remove.title = t("imix.removeTitle");
    remove.addEventListener("click", () => this.removeChain());
    const grow = document.createElement("div");
    grow.className = "grow";
    bar.append(title, power, mode, order, grow, indep, remove);
    head.appendChild(bar);
    const shared = document.createElement("p");
    shared.className = "mst-hint";
    shared.textContent = users.length === 0
      ? t(block.bus ? "imix.notSharedBus" : "imix.notShared")
      : t(block.bus ? "imix.sharedBus" : "imix.sharedWith", {
        list: users.map((s) => this.instLabel(s)).join(", "),
      });
    head.appendChild(shared);
    if (block.unknown.length > 0) {
      head.appendChild(note("imix.unknownKept", { list: block.unknown.map((u) => u.fourcc).join(", ") }));
    }
    const bar2 = document.createElement("div");
    bar2.className = "imx-headbar";
    bar2.append(newBtn, use);
    head.appendChild(bar2);
    return head;
  }

  /** One piece of equipment: a titlebar (fold · name · mix · switch) and its
   *  body — the settings, at their defaults while the piece is not inserted. */
  unit(id) {
    const box = document.createElement("section");
    box.className = "mst-unit mst-switchable imx-unit";
    box.dataset.equipment = id;
    const head = document.createElement("div");
    head.className = "mst-unit-head";
    const name = document.createElement("span");
    name.className = "mst-unit-name";
    name.textContent = t(NAME_KEY[id]);
    head.appendChild(name);
    if (IMX_WET_APPLICABLE.has(id)) head.appendChild(this.mixSlider(id));
    const sw = this.flip(t(NAME_KEY[id]), () => this.inCircuit(id), (on) => this.edit((b) => {
      if (!b.equipment[id]) b.equipment[id] = this.inserted(id);
      else b.equipment[id].bypass = !on;
    }));
    head.appendChild(sw);
    const body = document.createElement("div");
    body.className = "mst-unit-body";
    box.append(head, body);
    const hint = document.createElement("p");
    hint.className = "mst-hint";
    hint.textContent = t("imix.notInserted");
    body.appendChild(hint);
    const fold = makeFoldable(box, {
      head, body, name, label: t("imix.foldTitle"),
      get: () => this.unitOpen(id), set: (open) => this.setUnitOpen(id, open),
      onToggle: (open) => { if (open) this.paintPlots(false, 0); },
    });
    this.controls.push({
      refresh: () => {
        fold.sync();
        const present = !!this.block?.equipment[id];
        box.classList.toggle("mst-off", !this.inCircuit(id));
        if (hint.hidden !== present) hint.hidden = present;
        const title = t(present ? "imix.bypassTitle" : "imix.insertTitle");
        if (sw.title !== title) sw.title = title;
      },
    });
    switch (id) {
      case IMX_ITRM: body.append(this.num(id, "imix.gain", "gainDb", "trimDb", { unit: "dB", digits: 1 })); break;
      case IMX_EXPD: this.bodyExpd(body); break;
      case IMX_EQU1:
      case IMX_EQU2: this.bodyEq(id, body); break;
      case IMX_TSH1: this.bodyTsh(body); break;
      case IMX_COMP: this.bodyComp(body); break;
      case IMX_DEQ1:
      case IMX_DEQ2: this.bodyDeq(id, body); break;
      case IMX_SATU: this.bodySat(body); break;
      case IMX_UNIS: this.bodyUnis(body); break;
      case IMX_VERB: this.bodyVerb(body); break;
      case IMX_DLAY: this.bodyDelay(body); break;
      case IMX_LIMI: this.bodyLim(body); break;
      case IMX_MXTL: this.bodyMix(body); break;
    }
    return box;
  }

  /** The titlebar's wet/dry: shown as WET %, stored as the dry byte. */
  mixSlider(id) {
    const wrap = document.createElement("label");
    wrap.className = "imx-mix";
    wrap.title = t("imix.mixTitle");
    const lab = document.createElement("span");
    lab.textContent = t("imix.mix");
    const range = document.createElement("input");
    range.type = "range";
    range.min = 0; range.max = 255; range.step = 1;
    const val = document.createElement("span");
    val.className = "imx-mixval";
    const get = () => this.eqp(id).dry ?? 0;
    const paint = () => {
      const dry = get();
      if (this._dragging !== range) range.value = String(255 - dry);
      const s = `${Math.round(((255 - dry) / 255) * 100)}%`;
      if (val.textContent !== s) val.textContent = s;
    };
    range.addEventListener("pointerdown", () => { this._dragging = range; this.beginGesture(); });
    // Only the slider being dragged ends the drag: pressing another one blurs
    // the last one touched AFTER its pointerdown began the new gesture, and
    // ending it then made every step of that drag an undo step of its own.
    for (const ev of ["pointerup", "pointercancel", "blur"]) {
      range.addEventListener(ev, () => {
        if (this._dragging !== range) return;
        this._dragging = null;
        this.endGesture();
      });
    }
    range.addEventListener("input", () => {
      this.editEquipment(id, (e) => { e.dry = 255 - (+range.value); }, "mix");
      paint();
    });
    wrap.append(lab, range, val);
    this.controls.push({ refresh: paint });
    return wrap;
  }

  // ── equipment bodies ──

  bodyEq(id, body) {
    body.appendChild(this.unitPlot(id));
    const e = this.eqp(id);
    e.bands.forEach((_, i) => body.appendChild(this.eqBand(id, i)));
    if (e.bands.length < IMX_EQ_MAX_BANDS) {
      const add = document.createElement("button");
      add.className = "imx-add";
      add.textContent = t("imix.addBand");
      add.addEventListener("click", () => this.editEquipment(id, (x) => {
        x.bands.push({ on: true, shape: IMX_EQ_BELL, slope: 0, freq: 1000, gainDb: 0, q: 1 });
      }));
      body.appendChild(add);
    }
  }

  eqBand(id, i) {
    const box = document.createElement("div");
    box.className = "mst-band";
    const head = document.createElement("div");
    head.className = "mst-band-head";
    const name = document.createElement("span");
    name.textContent = t("imix.band", { n: i + 1 });
    const del = document.createElement("button");
    del.className = "imx-del";
    del.textContent = t("imix.removeBand");
    del.addEventListener("click", () => this.editEquipment(id, (x) => { x.bands.splice(i, 1); }));
    head.append(name, del, this.flip(t("imix.band", { n: i + 1 }), () => this.eqp(id).bands[i]?.on ?? false,
      (on) => this.editEquipment(id, (x) => { x.bands[i].on = on; })));
    box.appendChild(head);
    const band = () => this.eqp(id).bands[i];
    const shapes = [];
    for (let s = 0; s < IMX_EQ_SHAPES; s++) shapes.push([s, t(`imix.shape${s}`)]);
    box.appendChild(this.choiceRow("imix.shape", shapes, () => band()?.shape ?? 0,
      (v) => this.editEquipment(id, (x) => { x.bands[i].shape = v; if (!isCutShape(v)) x.bands[i].slope = 0; })));
    if (isCutShape(band().shape)) {
      const slopes = [];
      for (let s = 0; s < IMX_SLOPES; s++) slopes.push([s, `${(s + 1) * 12} dB/oct`]);
      box.appendChild(this.choiceRow("imix.slope", slopes, () => band()?.slope ?? 0,
        (v) => this.editEquipment(id, (x) => { x.bands[i].slope = v; })));
    }
    box.append(
      this.numRow("imix.freq", "eqFreq", () => band()?.freq ?? 1000,
        (v) => this.editEquipment(id, (x) => { x.bands[i].freq = v; }, `b${i}f`), { unit: "Hz", digits: 0, log: true }),
    );
    const s = band().shape;
    if (s === 1 || s === 2 || s === 3) {
      box.appendChild(this.numRow("imix.gain", "eqGainDb", () => band()?.gainDb ?? 0,
        (v) => this.editEquipment(id, (x) => { x.bands[i].gainDb = v; }, `b${i}g`), { unit: "dB", digits: 1 }));
    }
    if (!(isCutShape(s) && band().slope > 0)) {
      box.appendChild(this.numRow("imix.q", "eqQ", () => band()?.q ?? 1,
        (v) => this.editEquipment(id, (x) => { x.bands[i].q = v; }, `b${i}q`), { digits: 2, log: true }));
    }
    return box;
  }

  bodyComp(body) {
    const id = IMX_COMP;
    const e = () => this.eqp(id);
    body.append(this.unitPlot(id), this.thresholdStrip(id));
    body.append(
      this.choiceRow("imix.detector", [[COMP_PEAK, t("imix.peak")], [COMP_RMS, t("imix.rms")]],
        () => e()?.detector ?? 0, (v) => this.editEquipment(id, (x) => { x.detector = v; })),
    );
    const rows = this.splitRows(id, body, IMX_COMP_MAX_BANDS, defaultCompBand);
    const boxes = e().bands.map((_, i) => {
      const box = document.createElement("div");
      box.className = "mst-band";
      box.dataset.band = String(i);
      const b = () => e()?.bands[i] ?? defaultCompBand();
      const row = (lab, key, range, opts) => this.numRow(lab, range, () => b()[key],
        (v) => this.editEquipment(id, (x) => { x.bands[i][key] = v; }, `b${i}${key}`), opts);
      box.append(
        row("imix.threshold", "threshDb", "compThreshDb", { unit: "dB", digits: 1 }),
        row("imix.ratio", "ratio", "compRatio", { digits: 2, suffix: ":1", log: true }),
        row("imix.attack", "attackMs", "compAttackMs", { unit: "ms", digits: 1, log: true }),
        row("imix.release", "releaseMs", "compReleaseMs", { unit: "ms", digits: 0, log: true }),
        row("imix.knee", "kneeDb", "compKneeDb", { unit: "dB", digits: 1 }),
        row("imix.makeup", "makeupDb", "compMakeupDb", { unit: "dB", digits: 1 }),
      );
      return box;
    });
    body.append(this.bandBar(id, rows, boxes), ...boxes);
  }

  /**
   * A multiband piece's split — the band count (one band is the whole signal;
   * more split the bands it has) and a row per crossover — appended to
   * `body`. Returns the band picker's rows.
   */
  splitRows(id, body, max, defaultBand) {
    const e = () => this.eqp(id);
    const counts = [];
    for (let n = 1; n <= max; n++) counts.push([n, String(n)]);
    // A band added or taken away leaves every other crossover where it was.
    body.appendChild(this.choiceRow("imix.bands", counts, () => e()?.bands.length ?? 1,
      (n) => this.editEquipment(id, (x) => { resizeSplit(x, n, defaultBand); })));
    const cur = e();
    for (let k = 0; k < cur.crossovers.length; k++) {
      body.appendChild(this.numRow("imix.xover", "xover", () => e()?.crossovers[k] ?? 1000,
        (v) => this.editEquipment(id, (x) => {
          // Keep the order: a crossover cannot pass its neighbours.
          const lo = k > 0 ? x.crossovers[k - 1] * IMX_XOVER_GAP : 20;
          const hi = k < x.crossovers.length - 1 ? x.crossovers[k + 1] / IMX_XOVER_GAP : 20000;
          x.crossovers[k] = clamp(v, lo, hi);
        }, `x${k}`), { unit: "Hz", digits: 0, log: true, args: { n: k + 1 } }));
    }
    return cur.bands.map((_, i) => [i,
      cur.bands.length === 1 ? t("imix.allShort") : String(i + 1),
      cur.bands.length === 1 ? t("imix.allBands") : t("imix.band", { n: i + 1 })]);
  }

  /** The expander, and the gate under its floor: a threshold strip to see and
   *  drag both by, the expander's curve, and the floor (off = −∞, a pure
   *  expander; at the threshold, a pure gate) with its hysteresis. */
  bodyExpd(body) {
    const id = IMX_EXPD;
    const e = () => this.eqp(id);
    const hint = document.createElement("p");
    hint.className = "mst-hint";
    hint.textContent = t("imix.expdHint");
    const [lo] = IMX_RANGE.expdThreshDb;
    body.append(
      hint,
      this.thresholdStrip(id),
      this.choiceRow("imix.detector", [[COMP_PEAK, t("imix.peak")], [COMP_RMS, t("imix.rms")]],
        () => e()?.detector ?? 0, (v) => this.editEquipment(id, (x) => { x.detector = v; })),
      this.numRow("imix.threshold", "expdThreshDb", () => e().threshDb,
        (v) => this.editEquipment(id, (x) => expdThreshold(x, v), "threshDb"), { unit: "dB", digits: 1 }),
      this.num(id, "imix.expdRatio", "ratio", "compRatio", { digits: 2, log: true }),
      this.num(id, "imix.range", "rangeDb", "expdRangeDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.attack", "attackMs", "compAttackMs", { unit: "ms", digits: 1, log: true }),
      this.num(id, "imix.hold", "holdMs", "expdHoldMs", { unit: "ms", digits: 0 }),
      this.num(id, "imix.release", "releaseMs", "compReleaseMs", { unit: "ms", digits: 0, log: true }),
      this.checkRow("imix.floorOn", "imix.floorOnTitle", () => e()?.floorDb > -Infinity,
        (on) => this.editEquipment(id, (x) => {
          x.floorDb = on ? Math.max(lo, x.threshDb - EXPD_FLOOR_GAP_DB) : -Infinity;
        })),
    );
    if (e().floorDb > -Infinity) {
      body.append(
        this.numRow("imix.floor", "expdThreshDb", () => (e().floorDb > -Infinity ? e().floorDb : lo),
          (v) => this.editEquipment(id, (x) => expdFloor(x, v), "floorDb"), { unit: "dB", digits: 1 }),
        this.num(id, "imix.hysteresis", "hysteresisDb", "expdHysteresisDb", { unit: "dB", digits: 1 }),
      );
    }
    body.append(this.checkRow("imix.keyFilter", "imix.keyFilterTitle", () => e()?.keyFilter ?? false,
      (on) => this.editEquipment(id, (x) => { x.keyFilter = on; })));
    if (e().keyFilter) {
      body.append(
        this.num(id, "imix.keyLowCut", "keyLowCut", "keyLowCut", { unit: "Hz", digits: 0, log: true }),
        this.num(id, "imix.keyHighCut", "keyHighCut", "keyHighCut", { unit: "Hz", digits: 0, log: true }),
      );
    }
  }

  /** The transient shaper: like the compressor, one band or several split at
   *  crossovers, each band lifting or lowering the attack and the sustain of
   *  every note in it, however loud. */
  bodyTsh(body) {
    const id = IMX_TSH1;
    const e = () => this.eqp(id);
    const hint = document.createElement("p");
    hint.className = "mst-hint";
    hint.textContent = t("imix.tshHint");
    body.append(hint, this.unitPlot(id));
    const rows = this.splitRows(id, body, IMX_TSH_MAX_BANDS, defaultTshBand);
    const boxes = e().bands.map((_, i) => {
      const box = document.createElement("div");
      box.className = "mst-band";
      box.dataset.band = String(i);
      const b = () => e()?.bands[i] ?? defaultTshBand();
      const row = (lab, key, range, opts) => this.numRow(lab, range, () => b()[key],
        (v) => this.editEquipment(id, (x) => { x.bands[i][key] = v; }, `b${i}${key}`), opts);
      box.append(
        row("imix.tshAttack", "attackDb", "tshGainDb", { unit: "dB", digits: 1 }),
        row("imix.tshAttackTime", "attackMs", "tshAttackMs", { unit: "ms", digits: 1, log: true }),
        row("imix.tshSustain", "sustainDb", "tshGainDb", { unit: "dB", digits: 1 }),
        row("imix.tshSustainTime", "releaseMs", "tshReleaseMs", { unit: "ms", digits: 0, log: true }),
        row("imix.tshOutput", "outDb", "tshOutDb", { unit: "dB", digits: 1 }),
      );
      return box;
    });
    body.append(this.bandBar(id, rows, boxes), ...boxes);
  }

  bodyDeq(id, body) {
    body.append(this.unitPlot(id), this.thresholdStrip(id));
    const e = () => this.eqp(id);
    const rows = DEQ_ORDER.map((i) => [i, deqShort(i),
      i === IMX_DEQ_LOW_SHELF_BAND ? t("imix.lowShelf") : i === IMX_DEQ_HIGH_SHELF_BAND ? t("imix.highShelf") : t("imix.bell", { n: i - 1 })]);
    const boxes = DEQ_ORDER.map((i) => {
      const box = document.createElement("div");
      box.className = "mst-band";
      box.dataset.band = String(i);
      const b = () => e()?.bands[i];
      const row = (lab, key, range, opts) => this.numRow(lab, range, () => b()?.[key] ?? 0,
        (v) => this.editEquipment(id, (x) => {
          x.bands[i][key] = v;
          // A linked band's sensor listens where its actor acts.
          if (!x.bands[i].unlinked) { x.bands[i].senseFreq = x.bands[i].freq; x.bands[i].senseQ = x.bands[i].q; }
        }, `b${i}${key}`), opts);
      box.append(
        this.segRow("imix.direction", [[0, t("imix.cut")], [1, t("imix.boost")]],
          () => (b()?.boost ? 1 : 0), (v) => this.editEquipment(id, (x) => { x.bands[i].boost = v === 1; })),
        row("imix.actorFreq", "freq", "eqFreq", { unit: "Hz", digits: 0, log: true }),
        row("imix.actorQ", "q", "eqQ", { digits: 2, log: true }),
        row("imix.staticGain", "gainDb", "eqGainDb", { unit: "dB", digits: 1 }),
        row("imix.threshold", "threshDb", "compThreshDb", { unit: "dB", digits: 1 }),
        row("imix.ratio", "ratio", "compRatio", { digits: 2, suffix: ":1", log: true }),
        row("imix.attack", "attackMs", "compAttackMs", { unit: "ms", digits: 1, log: true }),
        row("imix.release", "releaseMs", "compReleaseMs", { unit: "ms", digits: 0, log: true }),
        row("imix.range", "rangeDb", "deqRangeDb", { unit: "dB", digits: 1 }),
        row("imix.actorGain", "actorDb", "deqActorDb", { unit: "dB", digits: 1 }),
        this.checkRow("imix.unlinked", "imix.unlinkedTitle", () => b()?.unlinked ?? false,
          (on) => this.editEquipment(id, (x) => {
            x.bands[i].unlinked = on;
            if (!on) { x.bands[i].senseFreq = x.bands[i].freq; x.bands[i].senseQ = x.bands[i].q; }
          })),
      );
      if (b().unlinked) {
        box.append(
          row("imix.senseFreq", "senseFreq", "eqFreq", { unit: "Hz", digits: 0, log: true }),
          row("imix.senseQ", "senseQ", "eqQ", { digits: 2, log: true }),
        );
      }
      return box;
    });
    body.append(this.bandBar(id, rows, boxes), ...boxes);
  }

  /** The band piece `id`'s controls are editing (session state, per kind). */
  selectedBand(id, rows) {
    const v = this._bandSel.get(id);
    return rows.some(([i]) => i === v) ? v : rows[0][0];
  }

  selectBand(id, band) {
    if (this._bandSel.get(id) === band) return;
    this._bandSel.set(id, band);
    for (const c of this.controls) if (c.band === id) c.refresh();
  }

  /**
   * The band picker over a compressor's or a dynamic EQ's band controls: a
   * segmented row of pushbuttons, one per band, each with a lamp saying
   * whether that band is on; then a toggle pushbutton switching the SELECTED
   * band in or out. Only the selected band's controls are shown. `rows` is
   * [[band index, label, title]] in display order; `boxes` the controls, in
   * the same order.
   */
  bandBar(id, rows, boxes) {
    const bar = document.createElement("div");
    bar.className = "imx-bandbar";
    const seg = document.createElement("div");
    seg.className = "mst-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", t("imix.bandPick"));
    const lamps = [];
    const buttons = rows.map(([i, label, title]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      b.dataset.band = String(i);
      const lamp = document.createElement("span");
      lamp.className = "seg-lamp";
      lamps.push(lamp);
      b.append(lamp, label);
      b.addEventListener("click", () => this.selectBand(id, i));
      seg.appendChild(b);
      return b;
    });
    const bandOn = (i) => !!this.eqp(id).bands[i]?.on;
    const power = lampButton({
      label: t("imix.enabled"), title: t("imix.bandPowerTitle"), className: "imx-bandpower",
      onChange: (on) => {
        const i = this.selectedBand(id, rows);
        this.editEquipment(id, (x) => { x.bands[i].on = on; });
      },
    });
    bar.append(seg, power.button);
    this.controls.push({
      band: id,
      refresh: () => {
        const sel = this.selectedBand(id, rows);
        rows.forEach(([i], k) => {
          const b = buttons[k];
          if (b.classList.contains("active") !== (i === sel)) b.classList.toggle("active", i === sel);
          b.setAttribute("aria-pressed", String(i === sel));
          if (lamps[k].classList.contains("lit") !== bandOn(i)) lamps[k].classList.toggle("lit", bandOn(i));
          if (boxes[k].hidden !== (i !== sel)) boxes[k].hidden = i !== sel;
        });
        power.setOn(bandOn(sel));
      },
    });
    return bar;
  }

  /** Label · a segmented row of pushbuttons: one of a few named choices. */
  segRow(labelKey, options, get, set) {
    const row = document.createElement("div");
    row.className = "mst-row mst-row-choice";
    const lab = document.createElement("span");
    lab.className = "mst-lab";
    lab.textContent = t(labelKey);
    row.append(lab, this.segButtons(t(labelKey), options, get, set));
    return row;
  }

  /**
   * A segmented row of pushbuttons, one of which is pressed. `options` is
   * [[value, text, title?, glyph?]]: a button with a glyph shows it (in Motif
   * Grid) and keeps the text as its tooltip and accessible name.
   */
  segButtons(label, options, get, set) {
    const seg = document.createElement("div");
    seg.className = "mst-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", label);
    const buttons = options.map(([value, text, title, glyph]) => {
      const b = document.createElement("button");
      b.type = "button";
      if (glyph) {
        b.textContent = glyph;
        b.className = "wave-btn";
        b.title = text;
        b.setAttribute("aria-label", text);
      } else {
        b.textContent = text;
        if (title) b.title = title;
      }
      b.addEventListener("click", () => set(value));
      seg.appendChild(b);
      return [value, b];
    });
    this.controls.push({
      refresh: () => {
        const v = get();
        for (const [value, b] of buttons) {
          if (b.classList.contains("active") !== (value === v)) b.classList.toggle("active", value === v);
          b.setAttribute("aria-pressed", String(value === v));
        }
      },
    });
    return seg;
  }

  bodySat(body) {
    const id = IMX_SATU;
    const curves = [];
    for (let c = 0; c < IMX_SAT_CURVES; c++) curves.push([c, t(`imix.curve${c}`)]);
    const cv = document.createElement("canvas");
    cv.className = "mst-canvas imx-transfer";
    this.plots.push({ canvas: cv, paint: (C) => this.drawTransfer(cv, C) });
    body.append(
      cv,
      this.choiceRow("imix.curve", curves, () => this.eqp(id).curve ?? 0,
        (v) => this.editEquipment(id, (x) => { x.curve = v; })),
      this.num(id, "imix.drive", "driveDb", "satDriveDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.inTrim", "inDb", "satTrimDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.outTrim", "outDb", "satTrimDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.bias", "bias", "satBias", { digits: 2 }),
    );
  }

  bodyUnis(body) {
    const id = IMX_UNIS;
    const voices = [];
    for (let n = IMX_UNIS_MIN_VOICES; n <= IMX_UNIS_MAX_VOICES; n++) voices.push([n, String(n)]);
    const hint = document.createElement("p");
    hint.className = "mst-hint";
    hint.textContent = t("imix.unisHint");
    const cv = document.createElement("canvas");
    cv.className = "mst-canvas imx-unison";
    this.plots.push({ canvas: cv, paint: (C, live) => this.drawUnison(cv, C, live) });
    body.append(
      hint,
      cv,
      this.choiceRow("imix.voices", voices, () => this.eqp(id).voices ?? 4,
        (v) => this.editEquipment(id, (x) => { x.voices = v; })),
      this.num(id, "imix.detune", "detune", "unisDetune", { unit: "¢", digits: 1 }),
      this.num(id, "imix.width", "width", "unisWidth", { unit: "%", digits: 0, scale: 100 }),
      this.num(id, "imix.spacing", "spacing", "unisSpacing", { unit: "%", digits: 0, scale: 100 }),
      this.lfoBox(id, "detuneLfo", "imix.detuneLfo"),
      this.lfoBox(id, "widthLfo", "imix.widthLfo"),
    );
  }

  lfoBox(id, key, titleKey) {
    const box = document.createElement("div");
    box.className = "mst-band";
    const head = document.createElement("div");
    head.className = "mst-band-head";
    const name = document.createElement("span");
    name.textContent = t(titleKey);
    head.appendChild(name);
    box.appendChild(head);
    const l = () => this.eqp(id)[key];
    // The waveforms as pushbuttons drawing their shapes, like the vibrato's.
    const waves = [];
    for (let w = 0; w < IMX_LFO_WAVES; w++) waves.push([w, t(`imix.wave${w}`), null, LFO_GLYPH[w].repeat(2)]);
    const sync = l().sync;
    box.append(
      this.segRow("imix.wave", waves, () => l()?.wave ?? 0,
        (v) => this.editEquipment(id, (x) => { x[key].wave = v; })),
      this.checkRow("imix.sync", "imix.syncTitle", () => l()?.sync ?? false,
        (on) => this.editEquipment(id, (x) => {
          x[key].sync = on;
          x[key].rate = on ? 16 * FX16 : FX16 / 2;
        })),
      sync
        ? this.numRow("imix.periodQt", "lfoQt", () => l()?.rate ?? FX16,
          (v) => this.editEquipment(id, (x) => { x[key].rate = v; }, `${key}r`),
          { unit: "qt", digits: 2, log: true, fx: true })
        : this.numRow("imix.rateHz", "lfoHz", () => l()?.rate ?? FX16,
          (v) => this.editEquipment(id, (x) => { x[key].rate = v; }, `${key}r`),
          { unit: "Hz", digits: 2, log: true, fx: true }),
      this.numRow("imix.depth", "lfoDepth", () => l()?.depth ?? 0,
        (v) => this.editEquipment(id, (x) => { x[key].depth = v; }, `${key}d`),
        { unit: "%", digits: 0, scale: 100 }),
      this.checkRow("imix.retrigger", "imix.retriggerTitle", () => l()?.retrigger ?? false,
        (on) => this.editEquipment(id, (x) => { x[key].retrigger = on; })),
    );
    return box;
  }

  bodyVerb(body) {
    const id = IMX_VERB;
    body.append(
      this.num(id, "imix.size", "size", "verbSize", { unit: "%", digits: 0, scale: 100 }),
      this.num(id, "imix.decay", "decay", "verbDecay", { unit: "s", digits: 2, log: true }),
      this.num(id, "imix.damping", "damping", "verbDamping", { unit: "Hz", digits: 0, log: true }),
      this.numRow("imix.preDelay", "verbPreDelay", () => this.eqp(id).preDelay ?? 0,
        (v) => this.editEquipment(id, (x) => { x.preDelay = v; }, "pre"),
        { unit: "ms", digits: 1, fx: true, scale: 1000 }),
    );
  }

  bodyDelay(body) {
    const id = IMX_DLAY;
    const e = () => this.eqp(id);
    const hint = document.createElement("p");
    hint.className = "mst-hint";
    hint.textContent = t(e().sync ? "imix.syncHint" : "imix.secondsHint");
    body.append(
      hint,
      this.checkRow("imix.sync", "imix.syncTitle", () => e()?.sync ?? false,
        (on) => this.editEquipment(id, (x) => {
          x.sync = on;
          x.time = on ? 48 * FX16 : FX16 / 4;
        })),
      e().sync
        ? this.numRow("imix.time", "dlayQt", () => e()?.time ?? FX16,
          (v) => this.editEquipment(id, (x) => { x.time = v; }, "time"),
          { unit: "qt", digits: 2, log: true, fx: true })
        : this.numRow("imix.time", "dlaySec", () => e()?.time ?? FX16,
          (v) => this.editEquipment(id, (x) => { x.time = v; }, "time"),
          { unit: "ms", digits: 1, log: true, fx: true, scale: 1000 }),
      this.num(id, "imix.feedback", "feedback", "dlayFeedback", { unit: "%", digits: 0, scale: 100 }),
      this.num(id, "imix.highCut", "highCut", "dlayHighCut", { unit: "Hz", digits: 0, log: true }),
      this.num(id, "imix.lowCut", "lowCut", "dlayLowCut", { unit: "Hz", digits: 0, log: true }),
      this.num(id, "imix.wow", "wow", "dlayWow", { unit: "%", digits: 0, scale: 100 }),
      this.num(id, "imix.drive", "driveDb", "dlayDriveDb", { unit: "dB", digits: 1 }),
      this.checkRow("imix.pingPong", "imix.pingPongTitle", () => e()?.pingPong ?? false,
        (on) => this.editEquipment(id, (x) => { x.pingPong = on; })),
    );
  }

  bodyLim(body) {
    const id = IMX_LIMI;
    body.append(
      this.num(id, "imix.gain", "gainDb", "limGainDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.ceiling", "ceilingDb", "limCeilingDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.release", "releaseMs", "limReleaseMs", { unit: "ms", digits: 0, log: true }),
      this.checkRow("imix.truePeak", "imix.truePeakTitle", () => this.eqp(id).truePeak ?? false,
        (on) => this.editEquipment(id, (x) => { x.truePeak = on; })),
    );
  }

  bodyMix(body) {
    const id = IMX_MXTL;
    const flag = (lab, key, title = "") => this.lamp(t(lab), () => this.eqp(id)[key] ?? false,
      (on) => this.editEquipment(id, (x) => { x[key] = on; }), title);
    body.append(
      this.num(id, "imix.gain", "gainDb", "mxGainDb", { unit: "dB", digits: 1 }),
      // In a surround song, surround width (item 247): an ambisonic scene's
      // directions against its W; a speaker layout leaves it out.
      this.num(id, this.surroundSong() ? "imix.surroundWidth" : "imix.width", "width", "mxWidth",
        { unit: "%", digits: 0, scale: 100 }),
      this.lampRow(
        flag("imix.swap", "swap"),
        flag("imix.invL", "invL"),
        flag("imix.invR", "invR"),
        flag("imix.removeDc", "removeDc", t("imix.removeDcTitle")),
      ),
    );
  }

  // ── controls ──

  /** A number row bound to equipment field `key`. */
  num(id, labelKey, key, rangeKey, opts) {
    return this.numRow(labelKey, rangeKey, () => this.eqp(id)[key] ?? 0,
      (v) => this.editEquipment(id, (x) => { x[key] = v; }, key), opts);
  }

  /**
   * Label · number · unit · slider, the Mastering tab's row. `fx` marks a 16.16
   * field: the range and the stored value are fixed-point integers, shown in
   * their units (÷ 65536, then × `scale`).
   */
  numRow(labelKey, rangeKey, get, set, opts = {}) {
    const [rlo, rhi] = IMX_RANGE[rangeKey];
    const fx = !!opts.fx;
    const lo = fx ? rlo / FX16 : rlo;
    const hi = fx ? rhi / FX16 : rhi;
    const scale = opts.scale ?? 1;
    const digits = opts.digits ?? 2;
    const read = () => (fx ? get() / FX16 : get());
    const write = (v) => set(fx ? Math.round(clamp(v, lo, hi) * FX16) : clamp(v, lo, hi));
    const row = document.createElement("div");
    row.className = "mst-row";
    const lab = document.createElement("span");
    lab.className = "mst-lab";
    lab.textContent = t(labelKey, opts.args);
    const num = document.createElement("input");
    num.type = "number";
    num.className = "mst-num";
    num.min = lo * scale; num.max = hi * scale;
    num.step = 10 ** -digits;
    const ann = document.createElement("span");
    ann.className = "mst-ann";
    ann.textContent = opts.suffix ?? opts.unit ?? "";
    const range = document.createElement("input");
    range.type = "range";
    range.className = "mst-range";
    range.min = 0; range.max = 1000; range.step = 1;
    const logLo = Math.max(lo, 1e-3);
    const toPos = (v) => (opts.log
      ? Math.round((Math.log(clamp(v, logLo, hi) / logLo) / Math.log(hi / logLo)) * 1000)
      : Math.round(((clamp(v, lo, hi) - lo) / (hi - lo)) * 1000));
    const fromPos = (p) => (opts.log ? logLo * (hi / logLo) ** (p / 1000) : lo + (p / 1000) * (hi - lo));
    const round = (v) => clamp(Math.round(v * scale * 10 ** digits) / 10 ** digits / scale, lo, hi);
    const paint = () => {
      const v = read();
      const s = (v * scale).toFixed(digits);
      if (document.activeElement !== num && num.value !== s) num.value = s;
      if (this._dragging !== range) range.value = String(toPos(v));
    };
    num.addEventListener("change", () => { write(round(parseFloat(num.value || "0") / scale)); paint(); });
    range.addEventListener("pointerdown", () => { this._dragging = range; this.beginGesture(); });
    // Only the slider being dragged ends the drag: pressing another one blurs
    // the last one touched AFTER its pointerdown began the new gesture, and
    // ending it then made every step of that drag an undo step of its own.
    for (const ev of ["pointerup", "pointercancel", "blur"]) {
      range.addEventListener(ev, () => {
        if (this._dragging !== range) return;
        this._dragging = null;
        this.endGesture();
      });
    }
    range.addEventListener("input", () => {
      write(round(fromPos(+range.value)));
      num.value = (read() * scale).toFixed(digits);
    });
    row.append(lab, num, ann, range);
    this.controls.push({ refresh: paint });
    return row;
  }

  choiceSelect(options, get, set) {
    const sel = document.createElement("select");
    for (const [value, text] of options) {
      const o = document.createElement("option");
      o.value = String(value);
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => set(+sel.value));
    this.controls.push({ refresh: () => { const v = String(get()); if (sel.value !== v) sel.value = v; } });
    return sel;
  }

  choiceRow(labelKey, options, get, set) {
    const row = document.createElement("div");
    row.className = "mst-row mst-row-choice";
    const lab = document.createElement("span");
    lab.className = "mst-lab";
    lab.textContent = t(labelKey);
    row.append(lab, this.choiceSelect(options, get, set));
    return row;
  }

  /** An option's row: one lamp pushbutton, named for the option. */
  checkRow(labelKey, titleKey, get, set) {
    const row = document.createElement("div");
    row.className = "mst-row mst-row-check";
    row.appendChild(this.lamp(t(labelKey), get, set, titleKey ? t(titleKey) : ""));
    return row;
  }

  /** Several lamp pushbuttons side by side, on one row. */
  lampRow(...lamps) {
    const row = document.createElement("div");
    row.className = "mst-row mst-row-lamps";
    row.append(...lamps);
    return row;
  }

  /** A lamp pushbutton for an option, kept in step with the document. */
  lamp(label, get, set, title = "") {
    const b = lampButton({ label, title, on: get(), onChange: set });
    this.controls.push({ refresh: () => b.setOn(get()) });
    return b.button;
  }

  /** A flip switch putting a piece (or a band of one) in circuit, kept in step. */
  flip(label, get, set) {
    const s = flipSwitch({ label, on: get(), onChange: set });
    this.controls.push({ refresh: () => s.setOn(get()) });
    return s.button;
  }

  refreshValues() {
    const b = this.block;
    if (b && this.curveChain) this.curveChain.setBlock(b);
    for (const [id, chain] of this.unitChains) chain.setBlock(this.onlyBlock(id));
    for (const c of this.controls) c.refresh();
    this.paintPlots(false, 0);
  }

  /** A block holding piece `id` alone, in circuit — what its unit draws. */
  onlyBlock(id) {
    return { id: 1, enabled: true, order: 0, equipment: { [id]: { ...this.eqp(id), bypass: false } }, unknown: [] };
  }

  unitChain(id) {
    let c = this.unitChains.get(id);
    if (!c) {
      c = new InstrumentChain(this.onlyBlock(id), SAMPLING_RATE, 2, true);
      this.unitChains.set(id, c);
    }
    return c;
  }

  /** The spectrum inside an equaliser, a dynamic EQ, the transient shaper or
   *  the compressor. */
  unitPlot(id) {
    const cv = document.createElement("canvas");
    cv.className = "mst-eq-curve imx-curve";
    cv.dataset.curve = id;
    this.unitChain(id);
    const plot = { canvas: cv, cursor: null, paint: (C, live, dt) => this.drawUnitSpectrum(id, plot, C, live, dt) };
    plot.cursor = trackCursor(cv, () => { this._cursorDirty = true; });
    this.plots.push(plot);
    return cv;
  }

  /** Paint every unit plot. `live` = the bus ran this frame. */
  paintPlots(live, dt) {
    if (!this.root?.isConnected) return;
    const C = themeColors();
    for (const p of this.plots) p.paint(C, live, dt);
  }

  // ── monitors ──

  buildMonitors() {
    const col = document.createElement("div");
    col.className = "imx-monitors";
    const scope = (titleKey, extra = null) => {
      const box = document.createElement("section");
      box.className = "mst-scope";
      const head = document.createElement("div");
      head.className = "mst-scope-head";
      const name = document.createElement("span");
      name.textContent = t(titleKey);
      head.appendChild(name);
      if (extra) head.appendChild(extra);
      const body = document.createElement("div");
      body.className = "mst-scope-body";
      box.append(head, body);
      box.body = body;
      col.appendChild(box);
      return box;
    };
    const seg = document.createElement("div");
    seg.className = "mst-seg";
    for (const [stage, key] of [[0, "imix.pre"], [1, "imix.post"]]) {
      const b = document.createElement("button");
      b.textContent = t(key);
      b.title = t(stage === 0 ? "imix.preTitle" : "imix.postTitle");
      b.classList.toggle("active", this.stage === stage);
      b.addEventListener("click", () => {
        this.stage = stage;
        for (const o of seg.children) o.classList.toggle("active", o === b);
        this.lastLive = performance.now();
      });
      seg.appendChild(b);
    }
    const mk = (cls) => { const c = document.createElement("canvas"); c.className = `mst-canvas ${cls}`; return c; };
    this.levelCanvas = mk("imx-levels");
    scope("imix.levels", seg).body.appendChild(this.levelCanvas);
    this.grCanvas = mk("imx-gr");
    scope("imix.reduction").body.appendChild(this.grCanvas);
    this.specCanvas = mk("imx-spectrum");
    this.specCursor = trackCursor(this.specCanvas, () => { this._cursorDirty = true; });
    const tilt = document.createElement("span");
    tilt.className = "mst-stagetag";
    tilt.textContent = t("imix.tilt");
    scope("imix.spectrum", tilt).body.appendChild(this.specCanvas);
    this.gonioCanvas = mk("imx-gonio");
    scope("imix.goniometer").body.appendChild(this.gonioCanvas);
    this.lastLive = performance.now();
    return col;
  }

  /** The engine meters this instrument's bus only while this tab is up. */
  syncTap() {
    const audio = this.store.audio;
    if (!audio) return;
    const want = this.root?.isConnected && this.view.visible && this.view.tab === "mixing" && this.block
      ? this.slot : -1;
    if (audio.imixMeterSlot !== want) audio.setImixMeter(0, want);
  }

  ctxFor(canvas, cssHeight) {
    const w = canvas.clientWidth;
    if (!w) return null;
    const dpr = uiDpr();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.height = cssHeight + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, cssHeight);
    return { ctx, w, h: cssHeight };
  }

  frame() {
    this.syncTap();
    if (!this.root?.isConnected || !this.levelCanvas?.isConnected) return;
    const audio = this.store.audio;
    if (!audio) return;
    const now = performance.now();
    const dt = this._lastFrame ? Math.min(100, now - this._lastFrame) : 16;
    this._lastFrame = now;
    const r = audio.readImixMeter(this.readout);
    const fresh = r.frames > 0 && r.slot === this.slot;
    if (fresh) this.lastLive = now;
    // Change-driven: paint while the bus runs, and for a moment after so the
    // ballistics settle; a still picture is not repainted — unless a cursor
    // moved over it, which redraws it as it stands (no time passes for it).
    const resting = !fresh && now - this.lastLive > REST_MS;
    if (resting && !this._cursorDirty) return;
    this._cursorDirty = false;
    const step = resting ? 0 : dt;
    this.ingest(fresh, now, step);
    const C = themeColors();
    this.drawLevels(C, now);
    this.drawReduction(C);
    this.drawSpectrum(C, fresh, step);
    this.drawGonio(C, fresh);
    for (const p of this.plots) p.paint(C, fresh, step);
  }

  ingest(fresh, now, dt) {
    const r = this.readout;
    for (let i = 0; i < 4; i++) {
      const pk = fresh ? r.truePeak[i] : 0;
      const db = pk > 0 ? 20 * Math.log10(pk) : -144;
      if (db >= this.peakHold[i]) { this.peakHold[i] = db; this.peakHoldUntil[i] = now + PEAK_HOLD_MS; }
      else if (now > this.peakHoldUntil[i]) this.peakHold[i] -= (PEAK_FALL_DB_S * dt) / 1000;
      if (fresh && r.clip[i] > 0) this.clipUntil[i] = now + 1200;
    }
    const k = Math.min(1, dt / 120);
    const settle = (cur, tgt) => (Math.abs(tgt) > Math.abs(cur) ? tgt : cur + (tgt - cur) * k);
    for (let i = 0; i < IMX_COMP_MAX_BANDS; i++) this.gr.comp[i] = settle(this.gr.comp[i], fresh ? r.comp[i] : 0);
    for (let i = 0; i < IMX_TSH_MAX_BANDS; i++) this.gr.tsh1[i] = settle(this.gr.tsh1[i], fresh ? r.tsh1[i] : 0);
    this.gr.expd = settle(this.gr.expd, fresh ? r.expd : 0);
    for (let i = 0; i < IMX_DEQ_BANDS; i++) {
      this.gr.deq1[i] = settle(this.gr.deq1[i], fresh ? r.deq1[i] : 0);
      this.gr.deq2[i] = settle(this.gr.deq2[i], fresh ? r.deq2[i] : 0);
    }
    this.gr.lim = settle(this.gr.lim, fresh ? r.lim : 0);
    if (fresh) this._ms = r.meanSquare.slice(); else if (this._ms) for (let i = 0; i < 4; i++) this._ms[i] *= 0.8;
  }

  drawLevels(C, now) {
    const box = this.ctxFor(this.levelCanvas, 62);
    if (!box) return;
    const { ctx, w } = box;
    ctx.font = canvasMonoFont(10);
    const x0 = 22, span = w - x0 - 6, top = 14, barH = 16;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(x0, top, span, barH * 2 + 4);
    ctx.fillStyle = C.dim;
    ctx.textAlign = "center";
    for (let db = METER_MIN_DB; db <= METER_MAX_DB; db += 6) {
      const x = x0 + frac(db, METER_MIN_DB, METER_MAX_DB) * span;
      ctx.fillRect(x, top - 3, 1, 3);
      if (db % 12 === 0) ctx.fillText(String(db), clamp(x, x0 + 8, w - 12), top - 4);
    }
    ctx.textAlign = "left";
    const zero = x0 + frac(0, METER_MIN_DB, METER_MAX_DB) * span;
    for (let c = 0; c < 2; c++) {
      const i = this.stage * 2 + c;
      const y = top + c * (barH + 4);
      const ms = this._ms ? this._ms[i] : 0;
      const rmsDb = ms > 0 ? 10 * Math.log10(ms) : -144;
      ctx.fillStyle = C.meter;
      ctx.fillRect(x0, y, frac(rmsDb, METER_MIN_DB, METER_MAX_DB) * span, barH);
      drawBarRules(ctx, C, METER_MIN_DB, METER_MAX_DB, (db) => x0 + frac(db, METER_MIN_DB, METER_MAX_DB) * span, y, barH);
      ctx.fillStyle = C.border;
      ctx.fillRect(zero, y, 1, barH);
      ctx.fillStyle = C.accent2;
      ctx.fillRect(x0 + frac(this.peakHold[i], METER_MIN_DB, METER_MAX_DB) * span - 1, y, 2, barH);
      const lit = this.clipUntil[i] > now;
      if (lit) { ctx.fillStyle = C.errFg; ctx.fillRect(2, y, 17, barH); }
      ctx.fillStyle = lit ? C.bg : C.dim;
      ctx.fillText(c === 0 ? "L" : "R", 7, y + barH - 4);
    }
    ctx.fillStyle = C.dim;
    const pk = Math.max(this.peakHold[this.stage * 2], this.peakHold[this.stage * 2 + 1]);
    ctx.fillText(`${t("imix.truePeakRead")} ${pk > -144 ? pk.toFixed(1) : "—"} dBTP`, x0, top + barH * 2 + 4 + 12);
  }

  drawReduction(C) {
    const b = this.block;
    const rows = [];
    const e = b?.equipment ?? {};
    const on = (id) => e[id] && !e[id].bypass;
    // In pipeline order: the expander, the transient shaper, the compressor.
    if (on(IMX_EXPD)) rows.push([t("imix.expdShort"), this.gr.expd, false]);
    if (on(IMX_TSH1)) {
      e[IMX_TSH1].bands.forEach((band, i) => {
        if (band.on) rows.push([e[IMX_TSH1].bands.length === 1 ? t("imix.tshShort") : t("imix.tshBand", { n: i + 1 }), this.gr.tsh1[i], true]);
      });
    }
    if (on(IMX_COMP)) {
      e[IMX_COMP].bands.forEach((band, i) => {
        if (band.on) rows.push([e[IMX_COMP].bands.length === 1 ? t("imix.comp") : t("imix.compBand", { n: i + 1 }), this.gr.comp[i], false]);
      });
    }
    for (const [id, arr] of [[IMX_DEQ1, this.gr.deq1], [IMX_DEQ2, this.gr.deq2]]) {
      if (!on(id)) continue;
      for (const i of DEQ_ORDER) {
        if (e[id].bands[i].on) rows.push([`${t(id === IMX_DEQ1 ? "imix.deqShort1" : "imix.deqShort2")} ${deqShort(i)}`, arr[i], true]);
      }
    }
    if (on(IMX_LIMI)) rows.push([t("imix.limi"), this.gr.lim, false]);
    const rowH = 16;
    const box = this.ctxFor(this.grCanvas, Math.max(1, rows.length) * rowH + 4);
    if (!box) return;
    const { ctx, w } = box;
    ctx.font = canvasMonoFont(10);
    if (rows.length === 0) {
      ctx.fillStyle = C.dim;
      ctx.fillText(t("imix.noDynamics"), 2, 13);
      return;
    }
    const x0 = 78, span = w - x0 - 52;
    rows.forEach(([name, gr, signed], k) => {
      const y = 2 + k * rowH;
      ctx.fillStyle = C.dim;
      ctx.textAlign = "left";
      ctx.fillText(name, 2, y + 11);
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(x0, y + 2, span, 10);
      if (signed) {
        // A dynamic EQ moves either way: centre out, boost right, cut left.
        const mid = x0 + span / 2;
        const f = clamp(Math.abs(gr) / GR_MAX_DB, 0, 1) * (span / 2);
        ctx.fillStyle = gr >= 0 ? C.meter : C.accent;
        ctx.fillRect(gr >= 0 ? mid : mid - f, y + 2, f, 10);
        drawBarRules(ctx, C, -GR_MAX_DB, GR_MAX_DB, (db) => mid + (db / GR_MAX_DB) * (span / 2), y + 2, 10);
        ctx.fillStyle = C.border;
        ctx.fillRect(mid, y + 2, 1, 10);
      } else {
        const f = clamp(-gr / GR_MAX_DB, 0, 1);
        ctx.fillStyle = C.accent;
        ctx.fillRect(x0 + span * (1 - f), y + 2, span * f, 10);
        // Reduction grows right to left, so 6 dB of it is 6 dB in from the right.
        drawBarRules(ctx, C, 0, GR_MAX_DB, (db) => x0 + span * (1 - db / GR_MAX_DB), y + 2, 10);
      }
      ctx.fillStyle = C.fg;
      ctx.textAlign = "right";
      ctx.fillText(`${gr >= 0 && signed ? "+" : ""}${gr.toFixed(1)} dB`, w - 2, y + 11);
    });
    ctx.textAlign = "left";
  }

  /** The spectrum after the chain (band-inked), before it (a line), a held
   *  peak, and the static EQ curve of the chain over it on a ±24 dB axis. */
  drawSpectrum(C, fresh, dt) {
    const box = this.ctxFor(this.specCanvas, MONITOR_SPEC_H);
    if (!box) return;
    const { ctx, w, h } = box;
    const cols = Math.max(2, Math.round(w));
    if (this.specCols === null || this.specCols.length !== cols) {
      this.specCols = new Float64Array(cols).fill(SPEC_MIN_DB);
      this.specPre = new Float64Array(cols).fill(SPEC_MIN_DB);
      this.specHold = new Float64Array(cols).fill(SPEC_MIN_DB);
    }
    const r = this.readout;
    if (fresh) {
      // The pair's mono sum, unrolled out of the frame-interleaved ring.
      const ring = r.ring;
      const mono = this.specMono;
      for (let k = 0; k < IMX_RING_FRAMES; k++) mono[k] = (ring[k * 2] + ring[k * 2 + 1]) * 0.5;
      this.spectrum(mono, r.write, this.specBins);
      this.spectrum(r.ringPre, r.write, this.specBinsPre);
    }
    const fall = (SPEC_RELEASE_DB_S * dt) / 1000;
    const holdFall = (SPEC_HOLD_FALL_DB_S * dt) / 1000;
    stepColumns(this.specCols, fresh ? this.specBins : null, IMX_RING_FRAMES, SPEC_MIN_DB, SPEC_ATTACK, fall);
    stepColumns(this.specPre, fresh ? this.specBinsPre : null, IMX_RING_FRAMES, SPEC_MIN_DB, SPEC_ATTACK, fall);
    for (let x = 0; x < cols; x++) this.specHold[x] = Math.max(this.specCols[x], this.specHold[x] - holdFall);
    const axes = { lo: SPEC_MIN_DB, hi: SPEC_MAX_DB, curveDb: this.curveChain ? CURVE_DB : 0 };
    drawSpecGround(ctx, w, h, C, axes);
    const yOf = (db) => h - frac(db, SPEC_MIN_DB, SPEC_MAX_DB) * h;
    // After the chain: the five bands' inks, as the Mastering tab draws them;
    // before it, a line; and the held peak.
    fillBands(ctx, this.specCols, yOf, h, C);
    strokeColumns(ctx, this.specPre, yOf, C.dim, 1);
    strokeColumns(ctx, this.specHold, yOf, C.accent2, 1);
    // The chain's static EQ, on its own ±24 dB axis.
    if (this.curveChain) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < cols; i += 2) {
        const db = this.curveChain.responseDb(freqAt(i, cols));
        const y = h / 2 - clamp(db / CURVE_DB, -1, 1) * (h / 2 - 4);
        if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
      }
      ctx.stroke();
    }
    drawCursor(ctx, w, h, C, this.specCursor, axes);
  }

  /** One mono ring's spectrum into `bins`, with the display tilt. */
  spectrum(ring, write, bins) {
    spectrumDb(this.fft, this.specWin, this.specNorm, ring, write, bins, SPEC_MIN_DB - 24);
    for (let k = 1; k < bins.length; k++) bins[k] += this.specTilt[k];
  }

  /** M/S Lissajous of the pair after the chain: mono stands up the middle,
   *  a left-only sound leans left, out-of-phase material lies flat. The
   *  correlation of the window is the bar under it. */
  drawGonio(C, fresh) {
    const box = this.ctxFor(this.gonioCanvas, 200);
    if (!box) return;
    const { ctx, w, h } = box;
    // Room under the square for the correlation bar and its caption.
    const size = Math.min(w, h - 32);
    const cx = w / 2, cy = size / 2;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(cx - size / 2, 0, size, size);
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, size);
    ctx.moveTo(cx - size / 2, size); ctx.lineTo(cx + size / 2, 0);
    ctx.moveTo(cx - size / 2, 0); ctx.lineTo(cx + size / 2, size);
    ctx.stroke();
    ctx.font = canvasMonoFont(9);
    ctx.fillStyle = C.dim;
    ctx.fillText("L", cx - size / 2 + 3, 10);
    ctx.textAlign = "right";
    ctx.fillText("R", cx + size / 2 - 3, 10);
    ctx.textAlign = "left";
    const ring = this.readout.ring;
    if (!ring) return;
    const n = 1024;
    const wr = this.readout.write;
    let peak = 1e-9, ll = 0, rr = 0, lr = 0;
    for (let k = 0; k < n; k++) {
      const j = (wr - 1 - k) & (IMX_RING_FRAMES - 1);
      const l = ring[j * 2], r = ring[j * 2 + 1];
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      ll += l * l; rr += r * r; lr += l * r;
    }
    // Auto-gain: fast up, slow down, so a quiet instrument still draws a shape
    // — up to the master strip's ceiling, so silence is not magnified into a
    // runaway figure.
    const want = Math.min(0.9 / peak, SCOPE_GAIN_MAX);
    this.gonioGain = want < this.gonioGain ? want : this.gonioGain + (want - this.gonioGain) * 0.05;
    const g = this.gonioGain * (size / 2) * Math.SQRT1_2;
    // …and, while it draws, the magnification it draws at, as the master strip
    // shows its own: the cloud's size is the gain's doing, the meters are the
    // levels.
    if (fresh) {
      ctx.textAlign = "right";
      ctx.fillText(`×${this.gonioGain.toFixed(this.gonioGain < 10 ? 2 : 1)}`, cx + size / 2 - 3, size - 4);
      ctx.textAlign = "left";
    }
    if (fresh) {
      // Yellow, not the meter's green: the correlation bar under the cloud is
      // green, and the two are different readings.
      ctx.fillStyle = C.gonio;
      ctx.globalAlpha = 0.6;
      for (let k = 0; k < n; k++) {
        const j = (wr - 1 - k) & (IMX_RING_FRAMES - 1);
        const l = ring[j * 2], r = ring[j * 2 + 1];
        const px = cx + (r - l) * g;
        const py = cy - (l + r) * g;
        ctx.fillRect(px, py, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
    }
    // Correlation bar: −1 … +1.
    const corr = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 0;
    const by = size + 6, bw = size, bx = cx - size / 2;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(bx, by, bw, 8);
    const mid = bx + bw / 2;
    ctx.fillStyle = corr >= 0 ? C.meter : C.errFg;
    ctx.fillRect(corr >= 0 ? mid : mid + corr * (bw / 2), by, Math.abs(corr) * (bw / 2), 8);
    ctx.fillStyle = C.border;
    ctx.fillRect(mid, by - 1, 1, 10);
    ctx.fillStyle = C.dim;
    ctx.fillText(`${t("imix.correlation")} ${fresh ? corr.toFixed(2) : "—"}`, bx, by + 21);
  }

  /**
   * The plot inside an equaliser, a dynamic EQ, the transient shaper or the
   * compressor: what goes INTO the piece (a line — the tap rings each one's
   * input), what comes out (band-inked: the input moved by the piece's
   * response, which for these is all the piece does to a steady spectrum),
   * and the response itself on a ±24 dB axis. The dynamic pieces draw that
   * response as it stands this moment — the gains the meter reads — with the
   * resting one beside it and the difference shaded: that shading IS the
   * dynamics.
   */
  drawUnitSpectrum(id, plot, C, live, dt) {
    const box = this.ctxFor(plot.canvas, UNIT_SPEC_H);
    if (!box) return;
    const { ctx, w, h } = box;
    const cols = Math.max(2, Math.round(w));
    let st = this.unitSpec.get(id);
    if (!st || st.cols.length !== cols) {
      st = {
        cols: new Float64Array(cols).fill(SPEC_MIN_DB),
        out: new Float64Array(cols),
        resp: new Float64Array(cols),
        rest: new Float64Array(cols),
        bins: new Float64Array(IMX_RING_FRAMES >> 1),
      };
      this.unitSpec.set(id, st);
    }
    // Only a piece in circuit has an input of its own to show.
    const k = IMX_TAP_STAGES.indexOf(id);
    const r = this.readout;
    const fed = live && this.inCircuit(id) && r.stageRings !== null;
    if (fed) this.spectrum(r.stageRings[k], r.stageWrite[k], st.bins);
    stepColumns(st.cols, fed ? st.bins : null, IMX_RING_FRAMES, SPEC_MIN_DB, SPEC_ATTACK, (SPEC_RELEASE_DB_S * dt) / 1000);

    const chain = this.unitChain(id);
    const dynamic = id !== IMX_EQU1 && id !== IMX_EQU2;
    const gains = !this.inCircuit(id) ? null
      : id === IMX_COMP ? this.gr.comp : id === IMX_TSH1 ? this.gr.tsh1
        : id === IMX_DEQ1 ? this.gr.deq1 : id === IMX_DEQ2 ? this.gr.deq2 : null;
    const fill = (arr) => {
      // Every other column, joined straight: a response is smooth at this scale.
      for (let x = 0; x < cols; x += 2) arr[x] = chain.stageResponseDb(id, freqAt(x, cols));
      for (let x = 1; x < cols; x += 2) arr[x] = x + 1 < cols ? (arr[x - 1] + arr[x + 1]) / 2 : arr[x - 1];
    };
    if (dynamic) {
      chain.showGains(id, null);
      fill(st.rest);
      chain.showGains(id, gains);
    }
    fill(st.resp);

    const axes = { lo: SPEC_MIN_DB, hi: SPEC_MAX_DB, curveDb: CURVE_DB };
    drawSpecGround(ctx, w, h, C, axes);
    const yOf = (db) => h - frac(db, SPEC_MIN_DB, SPEC_MAX_DB) * h;
    const yCurve = (db) => h / 2 - clamp(db / CURVE_DB, -1, 1) * (h / 2 - 4);
    for (let x = 0; x < cols; x++) st.out[x] = st.cols[x] > SPEC_MIN_DB ? st.cols[x] + st.resp[x] : SPEC_MIN_DB;
    fillBands(ctx, st.out, yOf, h, C, 0.45);
    strokeColumns(ctx, st.cols, yOf, C.dim, 1);

    const e = this.eqp(id);
    if (id === IMX_COMP || id === IMX_TSH1) this.drawCompBands(ctx, w, h, C, e, gains);
    if (dynamic) {
      // The dynamics: from the resting response to the live one.
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(0, yCurve(st.rest[0]));
      for (let x = 1; x < cols; x++) ctx.lineTo(x, yCurve(st.rest[x]));
      for (let x = cols - 1; x >= 0; x--) ctx.lineTo(x, yCurve(st.resp[x]));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash([3, 3]);
      strokeColumns(ctx, st.rest, yCurve, C.dim, 1);
      ctx.setLineDash([]);
    }
    strokeColumns(ctx, st.resp, yCurve, this.inCircuit(id) ? C.accent : C.dim, 1.5);
    if (id === IMX_DEQ1 || id === IMX_DEQ2) this.drawDeqMarks(ctx, w, h, C, e, st.resp, yCurve);
    drawCursor(ctx, w, h, C, plot.cursor, axes);
  }

  // ── threshold strips ──

  /** The bands a strip shows, as [band index, label]: the expander's one row;
   *  every compressor band; a dynamic EQ's bands that are on, low shelf first,
   *  high shelf last. */
  thresholdRows(id) {
    const e = this.eqp(id);
    if (id === IMX_EXPD) return [[0, t("imix.allShort")]];
    if (id === IMX_COMP) {
      return e.bands.map((_, k) => [k, e.bands.length === 1 ? t("imix.allShort") : String(k + 1)]);
    }
    return DEQ_ORDER.filter((i) => e.bands[i].on).map((i) => [i, deqShort(i)]);
  }

  /**
   * The compressor's or a dynamic EQ's THRESHOLDS: a row per band on the
   * threshold's own scale (−60 … 0 dB), the band's detector level as a bar —
   * green up to the threshold, accent above it, the part the band acts on —
   * and the threshold as a marker you drag. A compressor shades its knee; a
   * dynamic EQ marks, dotted, the level where its band reaches its range and
   * moves no further. The level is what the band's own detector hears: a
   * multiband compressor's band, a dynamic EQ band's sense filter.
   *
   * The expander has one row on its own scale (−80 … 0 dB) and acts BELOW its
   * threshold, so its bar is the accent while the level is under it. Its floor
   * is a second marker, a tab at the foot, with the shut region under it
   * shaded; dotted is where the expander has moved its full range.
   */
  thresholdStrip(id) {
    const cv = document.createElement("canvas");
    cv.className = "mst-canvas imx-thresh";
    cv.dataset.thresh = id;
    cv.title = t("imix.threshTitle");
    const plot = { canvas: cv, paint: (C, live, dt) => this.drawThresholds(id, cv, C, live, dt) };
    this.plots.push(plot);
    const [lo, hi] = thresholdRange(id);
    let drag = null;
    const at = (ev) => {
      const p = localPoint(cv, ev);
      const w = cv.clientWidth;
      const x0 = THR_LABEL_W, span = w - THR_LABEL_W - THR_VALUE_W;
      const db = lo + clamp((p.x - x0) / span, 0, 1) * (hi - lo);
      return { row: Math.floor((p.y - THR_TOP) / THR_ROW_H), db: Math.round(db * 10) / 10 };
    };
    // The expander's strip carries two markers: a drag takes the nearer one.
    let field = "threshDb";
    const set = id === IMX_EXPD
      ? (_, db) => this.editEquipment(id, (x) => (field === "floorDb" ? expdFloor : expdThreshold)(x, db), field)
      : (band, db) => this.editEquipment(id, (x) => { x.bands[band].threshDb = db; }, `b${band}threshDb`);
    cv.addEventListener("pointerdown", (ev) => {
      const { row, db } = at(ev);
      const rows = this.thresholdRows(id);
      if (row < 0 || row >= rows.length) return;
      if (id === IMX_EXPD) {
        const e = this.eqp(id);
        field = e.floorDb > -Infinity && Math.abs(db - e.floorDb) < Math.abs(db - e.threshDb) ? "floorDb" : "threshDb";
      }
      drag = rows[row][0];
      this.selectBand(id, drag);
      try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      this.beginGesture();
      set(drag, db);
      ev.preventDefault();
    });
    cv.addEventListener("pointermove", (ev) => {
      if (drag === null) return;
      set(drag, at(ev).db);
    });
    const end = () => { if (drag !== null) { drag = null; this.endGesture(); } };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    return cv;
  }

  drawThresholds(id, cv, C, live, dt) {
    const rows = this.thresholdRows(id);
    const box = this.ctxFor(cv, THR_TOP + Math.max(1, rows.length) * THR_ROW_H + 2);
    if (!box) return;
    const { ctx, w } = box;
    const e = this.eqp(id);
    const expd = id === IMX_EXPD;
    const [lo, hi] = thresholdRange(id);
    const x0 = THR_LABEL_W, span = w - THR_LABEL_W - THR_VALUE_W;
    const xOf = (db) => x0 + clamp((db - lo) / (hi - lo), 0, 1) * span;
    // Each band's level: up at once, down at THR_FALL_DB_S, like a peak meter.
    let lv = this._thrLvl?.get(id);
    if (!lv) { lv = new Float64Array(IMX_DEQ_BANDS).fill(-120); (this._thrLvl ??= new Map()).set(id, lv); }
    const src = live && this.inCircuit(id)
      ? (expd ? [this.readout.expdLvl] : id === IMX_COMP ? this.readout.compLvl
        : id === IMX_DEQ1 ? this.readout.deq1Lvl : this.readout.deq2Lvl)
      : null;
    const fall = (THR_FALL_DB_S * dt) / 1000;
    for (let i = 0; i < lv.length; i++) {
      const tgt = src && i < src.length ? src[i] : -120;
      lv[i] = tgt > lv[i] ? tgt : Math.max(tgt, lv[i] - fall);
    }
    ctx.font = canvasMonoFont(9);
    ctx.fillStyle = C.dim;
    ctx.textAlign = "center";
    for (let db = hi; db >= lo; db -= 12) {
      const x = xOf(db);
      ctx.fillRect(Math.round(x), THR_TOP - 3, 1, 3);
      ctx.fillText(fmtDb(db, 0), clamp(x, x0 + 8, x0 + span - 6), THR_TOP - 4);
    }
    ctx.textAlign = "left";
    if (rows.length === 0) {
      ctx.fillText(t("imix.threshNone"), x0, THR_TOP + 12);
      return;
    }
    const on = this.inCircuit(id);
    rows.forEach(([i, label], r) => {
      const b = expd ? { ...e, on: true } : e.bands[i];
      const y = THR_TOP + r * THR_ROW_H;
      const yb = y + 3, hb = THR_ROW_H - 6;
      ctx.fillStyle = b.on ? C.fg : C.dim;
      ctx.font = canvasMonoFont(10);
      ctx.fillText(label, 2, y + 13);
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(x0, yb, span, hb);
      const xt = xOf(b.threshDb);
      if (id === IMX_COMP && b.kneeDb > 0) {
        // The knee: the band starts to act half a knee below the threshold.
        ctx.fillStyle = C.accent;
        ctx.globalAlpha = 0.18;
        const k0 = xOf(b.threshDb - b.kneeDb / 2), k1 = xOf(b.threshDb + b.kneeDb / 2);
        ctx.fillRect(k0, yb, k1 - k0, hb);
        ctx.globalAlpha = 1;
      }
      const xl = xOf(lv[i]);
      if (expd) {
        if (lv[i] > lo) {
          ctx.fillStyle = xl < xt ? C.accent : C.meter;
          ctx.fillRect(x0, yb + 3, xl - x0, hb - 6);
        }
      } else if (lv[i] > lo && b.on) {
        ctx.fillStyle = C.meter;
        ctx.fillRect(x0, yb + 3, Math.min(xl, xt) - x0, hb - 6);
        if (xl > xt) {
          ctx.fillStyle = C.accent;
          ctx.fillRect(xt, yb + 3, xl - xt, hb - 6);
        }
      }
      drawBarRules(ctx, C, lo, hi, xOf, yb, hb);
      // Where the band has moved its full range and stops — or a gate closes.
      let full = null;
      if (expd) {
        const reach = b.ratio > 1 ? b.threshDb - b.rangeDb / (b.ratio - 1) : null;
        full = reach !== null && reach > b.floorDb ? reach : null;
        if (b.floorDb > -Infinity) {
          // Shut under the floor: the region shaded, the floor a tab at the foot.
          const xf = xOf(b.floorDb);
          ctx.fillStyle = C.accent;
          ctx.globalAlpha = 0.18;
          ctx.fillRect(x0, yb, xf - x0, hb);
          ctx.globalAlpha = 1;
          ctx.fillStyle = on ? C.fg : C.dim;
          ctx.fillRect(Math.round(xf) - 1, y + 1, 2, THR_ROW_H - 2);
          ctx.beginPath();
          ctx.moveTo(xf - 3, y + THR_ROW_H);
          ctx.lineTo(xf + 3, y + THR_ROW_H);
          ctx.lineTo(xf, y + THR_ROW_H - 4);
          ctx.closePath();
          ctx.fill();
        }
      }
      else if (id !== IMX_COMP && b.ratio > 1) full = b.threshDb + b.rangeDb / (1 - 1 / b.ratio);
      if (full !== null) {
        if (full < hi && full > lo) {
          ctx.strokeStyle = C.dim;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(Math.round(xOf(full)) + 0.5, yb);
          ctx.lineTo(Math.round(xOf(full)) + 0.5, yb + hb);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      // The threshold itself: a bar across the row and a tab above it.
      ctx.fillStyle = on && b.on ? C.fg : C.dim;
      ctx.fillRect(Math.round(xt) - 1, y + 1, 2, THR_ROW_H - 2);
      ctx.beginPath();
      ctx.moveTo(xt - 3, y);
      ctx.lineTo(xt + 3, y);
      ctx.lineTo(xt, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.font = canvasMonoFont(10);
      ctx.textAlign = "right";
      ctx.fillStyle = b.on ? C.fg : C.dim;
      ctx.fillText(`${fmtDb(b.threshDb)} dB`, w - 2, y + 13);
      ctx.textAlign = "left";
    });
  }

  /** A multiband piece's bands: the crossovers, and each band's gain — the
   *  compressor's reduction, or the transient shaper's lift or cut. */
  drawCompBands(ctx, w, h, C, e, gains) {
    const xs = [0, ...e.crossovers.map((f) => colOfFreq(f, w)), w];
    ctx.font = canvasMonoFont(10);
    ctx.textAlign = "center";
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = C.fg;
    ctx.lineWidth = 1;
    for (let k = 1; k < xs.length - 1; k++) {
      ctx.beginPath();
      ctx.moveTo(Math.round(xs[k]) + 0.5, 0);
      ctx.lineTo(Math.round(xs[k]) + 0.5, h);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (let k = 0; k < e.bands.length; k++) {
      const mid = (xs[k] + xs[k + 1]) / 2;
      const b = e.bands[k];
      ctx.fillStyle = b.on ? C.fg : C.dim;
      const s = !b.on ? t("imix.bandOff") : `${fmtDb(gains ? gains[k] : 0)} dB`;
      ctx.fillText(s, clamp(mid, 26, w - 26), 12);
    }
    ctx.textAlign = "left";
  }

  /** A dynamic EQ's bands on its response: a mark where each one acts, and —
   *  for a band that senses elsewhere — the range it listens to, along the foot. */
  drawDeqMarks(ctx, w, h, C, e, resp, yCurve) {
    ctx.font = canvasMonoFont(9);
    ctx.textAlign = "center";
    for (const i of DEQ_ORDER) {
      const b = e.bands[i];
      if (!b.on) continue;
      const x = clamp(colOfFreq(b.freq, w), 0, w - 1);
      const y = yCurve(resp[Math.round(x)] ?? 0);
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.fg;
      ctx.fillText(deqShort(i), clamp(x, 8, w - 8), y > 16 ? y - 6 : y + 14);
      if (!b.unlinked) continue;
      // Low shelf senses below its frequency, high shelf above, a bell the
      // octaves its Q spans.
      let f0, f1;
      if (i === IMX_DEQ_LOW_SHELF_BAND) { f0 = 20; f1 = b.senseFreq; }
      else if (i === IMX_DEQ_HIGH_SHELF_BAND) { f0 = b.senseFreq; f1 = 20000; }
      else {
        const half = octavesOfQ(b.senseQ) / 2;
        f0 = b.senseFreq * 2 ** -half; f1 = b.senseFreq * 2 ** half;
      }
      const x0 = clamp(colOfFreq(f0, w), 0, w), x1 = clamp(colOfFreq(f1, w), 0, w);
      const yb = h - 16;
      ctx.fillStyle = C.dim;
      ctx.fillRect(x0, yb, Math.max(1, x1 - x0), 2);
      ctx.fillRect(x0, yb - 3, 1, 8);
      ctx.fillRect(x1 - 1, yb - 3, 1, 8);
      ctx.fillText(`${deqShort(i)} ${t("imix.sensor")}`, clamp((x0 + x1) / 2, 24, w - 24), yb - 4);
    }
    ctx.textAlign = "left";
  }

  /** The saturator's transfer: input across, output up, both ±1.5 of full
   *  scale, the straight line for comparison. Static — it is the settings. */
  drawTransfer(cv, C) {
    const box = this.ctxFor(cv, 150);
    if (!box) return;
    const { ctx, w, h } = box;
    const size = Math.min(w, h);
    const x0 = Math.round((w - size) / 2);
    const R = 1.5;
    const X = (v) => x0 + ((v + R) / (2 * R)) * size;
    const Y = (v) => h / 2 - (v / (2 * R)) * size;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(x0, (h - size) / 2, size, size);
    ctx.fillStyle = C.border;
    for (const v of [-1, -0.5, 0, 0.5, 1]) {
      ctx.fillRect(Math.round(X(v)), (h - size) / 2, 1, size);
      ctx.fillRect(x0, Math.round(Y(v)), size, 1);
    }
    ctx.font = canvasMonoFont(9);
    ctx.fillStyle = C.dim;
    ctx.fillText("+1", X(0) + 3, Y(1) - 2);
    ctx.fillText("−1", X(0) + 3, Y(-1) + 10);
    ctx.textAlign = "right";
    ctx.fillText(t("imix.satIn"), x0 + size - 3, Y(0) - 3);
    ctx.textAlign = "left";
    ctx.fillText(t("imix.satOut"), X(0) + 3, (h - size) / 2 + 10);
    ctx.strokeStyle = C.dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(-R), Y(-R)); ctx.lineTo(X(R), Y(R));
    ctx.stroke();
    ctx.setLineDash([]);
    const p = this.eqp(IMX_SATU);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, (h - size) / 2, size, size);
    ctx.clip();
    ctx.strokeStyle = this.inCircuit(IMX_SATU) ? C.accent : C.dim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= size; i++) {
      const v = -R + (i / size) * 2 * R;
      const y = Y(imxSatTransfer(p, v));
      if (i === 0) ctx.moveTo(x0 + i, y); else ctx.lineTo(x0 + i, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The unison's copies: where each sits across the stereo field (top) and
   * how far it is detuned (bottom), as the LFOs have them this moment while
   * the bus runs — in the meter's green — and at the settings otherwise.
   */
  drawUnison(cv, C, live) {
    const box = this.ctxFor(cv, 74);
    if (!box) return;
    const { ctx, w, h } = box;
    const p = this.eqp(IMX_UNIS);
    const r = this.readout;
    const now = live && this.inCircuit(IMX_UNIS) && r.unisCents >= 0;
    const cents = now ? r.unisCents : p.detune;
    const width = now ? r.unisWidth : p.width;
    // The detune axis spans what the LFO can reach, so a sweep is visible.
    const span = clamp(Math.max(1, p.detune * (1 + p.detuneLfo.depth)), 1, 100);
    const pos = unisonPositions(p.voices, p.spacing);
    const pad = 22;
    const span0 = w - pad * 2;
    ctx.font = canvasMonoFont(9);
    const row = (y, label, lo, hi, val) => {
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(pad, y, span0, 18);
      ctx.fillStyle = C.border;
      ctx.fillRect(Math.round(pad + span0 / 2), y, 1, 18);
      ctx.fillStyle = C.dim;
      ctx.textAlign = "right";
      ctx.fillText(lo, pad - 3, y + 13);
      ctx.textAlign = "left";
      ctx.fillText(hi, w - pad + 3, y + 13);
      ctx.fillStyle = now ? C.meter : C.accent;
      for (let k = 0; k < pos.length; k++) {
        const x = pad + ((clamp(val(pos[k]), -1, 1) + 1) / 2) * span0;
        ctx.fillRect(Math.round(x) - 1, y + 3, 3, 12);
      }
      ctx.fillStyle = C.dim;
      ctx.fillText(label, pad + 3, y - 3);
    };
    row(14, t("imix.unisPan"), "L", "R", (q) => q * width);
    row(50, t("imix.unisDetune", { c: span.toFixed(span < 10 ? 1 : 0) }), "−", "+", (q) => (q * cents) / span);
    ctx.textAlign = "right";
    ctx.fillStyle = now ? C.fg : C.dim;
    ctx.fillText(`${Math.round(width * 100)}% · ±${cents.toFixed(1)} ¢`, w - pad, 11);
    ctx.textAlign = "left";
  }
}
