// The Instruments view's MIXING tab (item 217): the instrument's IMix chain —
// which block it uses, the twelve pieces of equipment in their fixed order,
// and four monitors on the instrument's own bus.
//
// The chain is the BLOCK's, not the instrument's: two instruments naming one
// block share every setting (never the bus — each runs its own instance), so
// this tab says who else is on it and offers to make a private copy. A piece
// of equipment is absent until it is first switched on; from then on it stays
// in the block (§9.15: equipment is never retired once touched) and the switch
// bypasses it.
//
// Rebuilds vs refreshes, as in the Mastering tab: a slider drag is a stream of
// edits, so an edit only REPAINTS values (refreshValues); the DOM is rebuilt
// when the block's SHAPE changes — a piece inserted, a band added, the chain
// swapped for another — which no drag can do.

import {
  IMX_PIPELINES, IMX_WET_APPLICABLE, IMX_RANGE, FX16,
  IMX_ITRM, IMX_EQU1, IMX_EQU2, IMX_COMP, IMX_DEQ1, IMX_DEQ2, IMX_SATU, IMX_UNIS,
  IMX_VERB, IMX_DLAY, IMX_LIMI, IMX_MXTL,
  IMX_EQ_SHAPES, IMX_EQ_MAX_BANDS, IMX_EQ_BELL, IMX_SLOPES, IMX_COMP_MAX_BANDS,
  IMX_DEQ_BANDS, IMX_SAT_CURVES, IMX_UNIS_MIN_VOICES, IMX_UNIS_MAX_VOICES,
  IMX_LFO_WAVES, IMX_RING_FRAMES,
  defaultEquipment, defaultImixBlock, defaultCompBand, defaultCrossovers,
  normaliseImixBlock, imixBlockEqual, isCutShape, InstrumentChain,
  makeImixMeterReadout,
} from "../../../core/engine/imix.js";
import { COMP_PEAK, COMP_RMS } from "../../../core/engine/mastering.js";
import { SAMPLING_RATE } from "../../../core/engine/constants.js";
import { SURROUND_STEREO } from "../../../core/engine/spatial.js";
import { Fft, hannWindow, spectrumDb, tiltDbAt } from "../../../core/engine/fft.js";
import { setImixOp, setInstFieldOp, compositeOp } from "../../doc/ops.js";
import { unescapeName } from "../../../core/format/names.js";
import { showNotice } from "../components/modal.js";
import { themeColors } from "../theme.js";
import { canvasMonoFont } from "../fonts.js";
import { uiDpr } from "../zoom.js";
import { RAD_BANDS } from "../radiation.js";
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
/** How long the monitors keep painting after the bus last ran, so the
 *  ballistics come to rest instead of freezing mid-fall. */
const REST_MS = 2000;
const frac = (db, lo, hi) => clamp((db - lo) / (hi - lo), 0, 1);

/** The unit each equipment's name is looked up under. */
const NAME_KEY = {
  [IMX_ITRM]: "imix.itrm", [IMX_EQU1]: "imix.equ1", [IMX_DEQ1]: "imix.deq1",
  [IMX_COMP]: "imix.comp", [IMX_EQU2]: "imix.equ2", [IMX_DEQ2]: "imix.deq2",
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
      deq2: new Float64Array(IMX_DEQ_BANDS), lim: 0 };
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
    this.gonioGain = 1;
    /** A chain kept off the audio path purely to draw the EQ curve with. */
    this.curveChain = null;

    this.store.on("edit", (tags) => {
      if (!this.root?.isConnected) return;
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

  /** What decides the DOM: which pieces are in, how many bands each has. */
  shapeKey() {
    const b = this.block;
    if (!b) return `none:${this.blockId}`;
    const parts = [b.id, b.order];
    for (const id of IMX_PIPELINES[0]) {
      const e = b.equipment[id];
      if (!e) { parts.push("-"); continue; }
      parts.push(`${id}:${e.bands?.length ?? 0}:${e.sync ?? ""}:` +
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

  editEquipment(id, mutate, control = null) {
    this.edit((b) => { mutate(b.equipment[id]); }, control ? `${id}:${control}` : null);
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

  useChainOf(otherSlot) {
    const id = this.doc.instruments[otherSlot]?.imixId ?? 0;
    if (id === 0 || id === this.blockId) return;
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

  /** Every OTHER instrument that has a chain, as [slot, label]. */
  otherChains() {
    const doc = this.doc;
    const out = [];
    for (const s of doc.selectableInstrumentSlots()) {
      if (s === this.slot) continue;
      const id = doc.instruments[s].imixId;
      if (id === 0 || !doc.imixBlock(id)) continue;
      out.push([s, `${hex3(s)} ${unescapeName(doc.instrumentName(s)) || t("inst.unnamed")}`]);
    }
    return out;
  }

  // ── building ──

  render(host) {
    this.controls = [];
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
    o0.textContent = t("imix.useChainOf");
    use.appendChild(o0);
    for (const [s, label] of others) {
      const o = document.createElement("option");
      o.value = String(s);
      o.textContent = label;
      use.appendChild(o);
    }
    use.disabled = others.length === 0;
    use.addEventListener("change", () => { if (use.value !== "") this.useChainOf(+use.value); });

    if (!block) {
      head.appendChild(note("imix.none"));
      bar.append(newBtn, use);
      head.appendChild(bar);
      return head;
    }

    const title = document.createElement("span");
    title.className = "mst-title";
    title.textContent = t("imix.chainN", { id: block.id });
    const power = this.switchEl(t("imix.enabled"), () => this.block?.enabled ?? false,
      (on) => this.edit((b) => { b.enabled = on; }));
    power.title = t("imix.enabledTitle");
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
    bar.append(title, power, order, grow, indep, remove);
    head.appendChild(bar);
    const shared = document.createElement("p");
    shared.className = "mst-hint";
    shared.textContent = users.length === 0
      ? t("imix.notShared")
      : t("imix.sharedWith", {
        list: users.map((s) => `${hex3(s)} ${unescapeName(doc.instrumentName(s)) || t("inst.unnamed")}`).join(", "),
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

  /** One piece of equipment: a titlebar (name · mix · switch) and its body. */
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
    const e = this.block.equipment[id];
    if (e && IMX_WET_APPLICABLE.has(id)) head.appendChild(this.mixSlider(id));
    const sw = this.switchEl("", () => {
      const x = this.block?.equipment[id];
      return !!x && !x.bypass;
    }, (on) => this.edit((b) => {
      if (!b.equipment[id]) b.equipment[id] = defaultEquipment(id);
      else b.equipment[id].bypass = !on;
    }));
    sw.title = t(e ? "imix.bypassTitle" : "imix.insertTitle");
    head.appendChild(sw);
    this.controls.push({ refresh: () => box.classList.toggle("mst-off", !(this.block?.equipment[id] && !this.block.equipment[id].bypass)) });
    const body = document.createElement("div");
    body.className = "mst-unit-body";
    box.append(head, body);
    if (!e) {
      const p = document.createElement("p");
      p.className = "mst-hint";
      p.textContent = t("imix.notInserted");
      body.appendChild(p);
      return box;
    }
    switch (id) {
      case IMX_ITRM: body.append(this.num(id, "imix.gain", "gainDb", "trimDb", { unit: "dB", digits: 1 })); break;
      case IMX_EQU1:
      case IMX_EQU2: this.bodyEq(id, body); break;
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
    const get = () => this.block?.equipment[id]?.dry ?? 0;
    const paint = () => {
      const dry = get();
      if (this._dragging !== range) range.value = String(255 - dry);
      const s = `${Math.round(((255 - dry) / 255) * 100)}%`;
      if (val.textContent !== s) val.textContent = s;
    };
    range.addEventListener("pointerdown", () => { this._dragging = range; this.beginGesture(); });
    for (const ev of ["pointerup", "pointercancel", "blur"]) {
      range.addEventListener(ev, () => { this._dragging = null; this.endGesture(); });
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
    const cv = document.createElement("canvas");
    cv.className = "mst-eq-curve imx-curve";
    cv.dataset.curve = id;
    body.appendChild(cv);
    this.controls.push({ refresh: () => this.drawCurve(cv, [id]) });
    const e = this.block.equipment[id];
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
    head.append(name, del, this.switchEl("", () => this.block?.equipment[id]?.bands[i]?.on ?? false,
      (on) => this.editEquipment(id, (x) => { x.bands[i].on = on; })));
    box.appendChild(head);
    const band = () => this.block?.equipment[id]?.bands[i];
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
    const e = () => this.block?.equipment[id];
    const counts = [];
    for (let n = 1; n <= IMX_COMP_MAX_BANDS; n++) counts.push([n, String(n)]);
    body.append(
      this.choiceRow("imix.detector", [[COMP_PEAK, t("imix.peak")], [COMP_RMS, t("imix.rms")]],
        () => e()?.detector ?? 0, (v) => this.editEquipment(id, (x) => { x.detector = v; })),
      this.choiceRow("imix.bands", counts, () => e()?.bands.length ?? 1, (n) => this.editEquipment(id, (x) => {
        while (x.bands.length < n) x.bands.push(defaultCompBand());
        x.bands.length = n;
        x.crossovers = defaultCrossovers(n);
      })),
    );
    const cur = e();
    for (let k = 0; k < cur.crossovers.length; k++) {
      body.appendChild(this.numRow("imix.xover", "xover", () => e()?.crossovers[k] ?? 1000,
        (v) => this.editEquipment(id, (x) => {
          // Keep the order: a crossover cannot pass its neighbours.
          const lo = k > 0 ? x.crossovers[k - 1] * 1.01 : 20;
          const hi = k < x.crossovers.length - 1 ? x.crossovers[k + 1] / 1.01 : 20000;
          x.crossovers[k] = clamp(v, lo, hi);
        }, `x${k}`), { unit: "Hz", digits: 0, log: true, args: { n: k + 1 } }));
    }
    cur.bands.forEach((_, i) => {
      const box = document.createElement("div");
      box.className = "mst-band";
      const head = document.createElement("div");
      head.className = "mst-band-head";
      const name = document.createElement("span");
      name.textContent = cur.bands.length === 1 ? t("imix.allBands") : t("imix.band", { n: i + 1 });
      head.append(name, this.switchEl("", () => e()?.bands[i]?.on ?? false,
        (on) => this.editEquipment(id, (x) => { x.bands[i].on = on; })));
      box.appendChild(head);
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
      body.appendChild(box);
    });
  }

  bodyDeq(id, body) {
    const cv = document.createElement("canvas");
    cv.className = "mst-eq-curve imx-curve";
    body.appendChild(cv);
    this.controls.push({ refresh: () => this.drawCurve(cv, [id]) });
    const e = () => this.block?.equipment[id];
    for (let i = 0; i < IMX_DEQ_BANDS; i++) {
      const box = document.createElement("div");
      box.className = "mst-band";
      const head = document.createElement("div");
      head.className = "mst-band-head";
      const name = document.createElement("span");
      name.textContent = i === 0 ? t("imix.lowShelf") : i === 1 ? t("imix.highShelf") : t("imix.bell", { n: i - 1 });
      head.append(name, this.switchEl("", () => e()?.bands[i]?.on ?? false,
        (on) => this.editEquipment(id, (x) => { x.bands[i].on = on; })));
      box.appendChild(head);
      const b = () => e()?.bands[i];
      const row = (lab, key, range, opts) => this.numRow(lab, range, () => b()?.[key] ?? 0,
        (v) => this.editEquipment(id, (x) => {
          x.bands[i][key] = v;
          // A linked band senses where it acts.
          if (!x.bands[i].unlinked) { x.bands[i].senseFreq = x.bands[i].freq; x.bands[i].senseQ = x.bands[i].q; }
        }, `b${i}${key}`), opts);
      box.append(
        this.choiceRow("imix.direction", [[0, t("imix.cut")], [1, t("imix.boost")]],
          () => (b()?.boost ? 1 : 0), (v) => this.editEquipment(id, (x) => { x.bands[i].boost = v === 1; })),
        row("imix.freq", "freq", "eqFreq", { unit: "Hz", digits: 0, log: true }),
        row("imix.q", "q", "eqQ", { digits: 2, log: true }),
        row("imix.staticGain", "gainDb", "eqGainDb", { unit: "dB", digits: 1 }),
        row("imix.threshold", "threshDb", "compThreshDb", { unit: "dB", digits: 1 }),
        row("imix.ratio", "ratio", "compRatio", { digits: 2, suffix: ":1", log: true }),
        row("imix.attack", "attackMs", "compAttackMs", { unit: "ms", digits: 1, log: true }),
        row("imix.release", "releaseMs", "compReleaseMs", { unit: "ms", digits: 0, log: true }),
        row("imix.range", "rangeDb", "deqRangeDb", { unit: "dB", digits: 1 }),
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
      body.appendChild(box);
    }
  }

  bodySat(body) {
    const id = IMX_SATU;
    const curves = [];
    for (let c = 0; c < IMX_SAT_CURVES; c++) curves.push([c, t(`imix.curve${c}`)]);
    body.append(
      this.choiceRow("imix.curve", curves, () => this.block?.equipment[id]?.curve ?? 0,
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
    body.append(
      hint,
      this.choiceRow("imix.voices", voices, () => this.block?.equipment[id]?.voices ?? 4,
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
    const l = () => this.block?.equipment[id]?.[key];
    const waves = [];
    for (let w = 0; w < IMX_LFO_WAVES; w++) waves.push([w, t(`imix.wave${w}`)]);
    const sync = l().sync;
    box.append(
      this.choiceRow("imix.wave", waves, () => l()?.wave ?? 0,
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
      this.numRow("imix.preDelay", "verbPreDelay", () => this.block?.equipment[id]?.preDelay ?? 0,
        (v) => this.editEquipment(id, (x) => { x.preDelay = v; }, "pre"),
        { unit: "ms", digits: 1, fx: true, scale: 1000 }),
    );
  }

  bodyDelay(body) {
    const id = IMX_DLAY;
    const e = () => this.block?.equipment[id];
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
      this.checkRow("imix.truePeak", "imix.truePeakTitle", () => this.block?.equipment[id]?.truePeak ?? false,
        (on) => this.editEquipment(id, (x) => { x.truePeak = on; })),
    );
  }

  bodyMix(body) {
    const id = IMX_MXTL;
    const flag = (lab, key) => this.checkRow(lab, null, () => this.block?.equipment[id]?.[key] ?? false,
      (on) => this.editEquipment(id, (x) => { x[key] = on; }));
    body.append(
      this.num(id, "imix.gain", "gainDb", "mxGainDb", { unit: "dB", digits: 1 }),
      this.num(id, "imix.width", "width", "mxWidth", { unit: "%", digits: 0, scale: 100 }),
      flag("imix.swap", "swap"),
      flag("imix.invL", "invL"),
      flag("imix.invR", "invR"),
    );
  }

  // ── controls ──

  /** A number row bound to equipment field `key`. */
  num(id, labelKey, key, rangeKey, opts) {
    return this.numRow(labelKey, rangeKey, () => this.block?.equipment[id]?.[key] ?? 0,
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
    for (const ev of ["pointerup", "pointercancel", "blur"]) {
      range.addEventListener(ev, () => { this._dragging = null; this.endGesture(); });
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

  checkRow(labelKey, titleKey, get, set) {
    const row = document.createElement("div");
    row.className = "mst-row mst-row-check";
    const wrap = document.createElement("label");
    wrap.className = "mst-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => set(box.checked));
    const txt = document.createElement("span");
    txt.textContent = t(labelKey);
    wrap.append(box, txt);
    if (titleKey) wrap.title = t(titleKey);
    row.appendChild(wrap);
    this.controls.push({ refresh: () => { box.checked = !!get(); } });
    return row;
  }

  switchEl(label, get, set) {
    const wrap = document.createElement("label");
    wrap.className = "mst-switch";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!get();
    box.addEventListener("change", () => set(box.checked));
    const txt = document.createElement("span");
    txt.textContent = label;
    wrap.append(box, txt);
    this.controls.push({ refresh: () => { box.checked = !!get(); } });
    return wrap;
  }

  refreshValues() {
    const b = this.block;
    if (b && this.curveChain) this.curveChain.setBlock(b);
    for (const c of this.controls) c.refresh();
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
    // ballistics settle; a still picture is not repainted.
    if (!fresh && now - this.lastLive > REST_MS) return;
    this.ingest(fresh, now, dt);
    const C = themeColors();
    this.drawLevels(C, now);
    this.drawReduction(C);
    this.drawSpectrum(C, fresh, dt);
    this.drawGonio(C, fresh);
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
    if (on(IMX_COMP)) {
      e[IMX_COMP].bands.forEach((band, i) => {
        if (band.on) rows.push([e[IMX_COMP].bands.length === 1 ? t("imix.comp") : t("imix.compBand", { n: i + 1 }), this.gr.comp[i], false]);
      });
    }
    for (const [id, arr] of [[IMX_DEQ1, this.gr.deq1], [IMX_DEQ2, this.gr.deq2]]) {
      if (!on(id)) continue;
      e[id].bands.forEach((band, i) => {
        if (band.on) rows.push([`${t(id === IMX_DEQ1 ? "imix.deqShort1" : "imix.deqShort2")} ${i === 0 ? "LS" : i === 1 ? "HS" : `B${i - 1}`}`, arr[i], true]);
      });
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
        ctx.fillStyle = C.border;
        ctx.fillRect(mid, y + 2, 1, 10);
      } else {
        const f = clamp(-gr / GR_MAX_DB, 0, 1);
        ctx.fillStyle = C.accent;
        ctx.fillRect(x0 + span * (1 - f), y + 2, span * f, 10);
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
    const box = this.ctxFor(this.specCanvas, 150);
    if (!box) return;
    const { ctx, w, h } = box;
    const cols = Math.max(2, Math.round(w));
    if (this.specCols === null || this.specCols.length !== cols) {
      this.specCols = new Float64Array(cols).fill(SPEC_MIN_DB);
      this.specPre = new Float64Array(cols).fill(SPEC_MIN_DB);
      this.specHold = new Float64Array(cols).fill(SPEC_MIN_DB);
    }
    const r = this.readout;
    const fOf = (x) => 20 * Math.exp((x / (cols - 1)) * Math.log(1000));
    if (fresh) {
      // The pair's mono sum, unrolled out of the frame-interleaved ring.
      const ring = r.ring;
      const mono = this.specMono;
      for (let k = 0; k < IMX_RING_FRAMES; k++) mono[k] = (ring[k * 2] + ring[k * 2 + 1]) * 0.5;
      spectrumDb(this.fft, this.specWin, this.specNorm, mono, r.write, this.specBins, SPEC_MIN_DB - 24);
      spectrumDb(this.fft, this.specWin, this.specNorm, r.ringPre, r.write, this.specBinsPre, SPEC_MIN_DB - 24);
      for (let k = 1; k < this.specBins.length; k++) {
        this.specBins[k] += this.specTilt[k];
        this.specBinsPre[k] += this.specTilt[k];
      }
    }
    const binHz = SAMPLING_RATE / IMX_RING_FRAMES;
    const nBins = this.specBins.length;
    const fall = (SPEC_RELEASE_DB_S * dt) / 1000;
    const holdFall = (SPEC_HOLD_FALL_DB_S * dt) / 1000;
    const colOf = (bins, x) => {
      const f0 = 20 * Math.exp(((x - 0.5) / (cols - 1)) * Math.log(1000));
      const f1 = 20 * Math.exp(((x + 0.5) / (cols - 1)) * Math.log(1000));
      const k0 = Math.max(1, Math.floor(f0 / binHz));
      const k1 = Math.min(nBins - 1, Math.ceil(f1 / binHz));
      let v = SPEC_MIN_DB;
      for (let k = k0; k <= k1; k++) if (bins[k] > v) v = bins[k];
      return v;
    };
    for (let x = 0; x < cols; x++) {
      const tgt = fresh ? colOf(this.specBins, x) : SPEC_MIN_DB;
      const tgtPre = fresh ? colOf(this.specBinsPre, x) : SPEC_MIN_DB;
      const cur = this.specCols[x];
      this.specCols[x] = tgt > cur ? cur + (tgt - cur) * SPEC_ATTACK : Math.max(tgt, cur - fall);
      const cp = this.specPre[x];
      this.specPre[x] = tgtPre > cp ? cp + (tgtPre - cp) * SPEC_ATTACK : Math.max(tgtPre, cp - fall);
      this.specHold[x] = Math.max(this.specCols[x], this.specHold[x] - holdFall);
    }
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(0, 0, w, h);
    const yOf = (db) => h - frac(db, SPEC_MIN_DB, SPEC_MAX_DB) * h;
    // Frequency grid.
    ctx.font = canvasMonoFont(9);
    ctx.fillStyle = C.border;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = (Math.log(f / 20) / Math.log(1000)) * (cols - 1);
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
    ctx.fillStyle = C.dim;
    for (const [f, s] of [[100, "100"], [1000, "1k"], [10000, "10k"]]) {
      const x = (Math.log(f / 20) / Math.log(1000)) * (cols - 1);
      ctx.fillText(s, Math.round(x) + 2, h - 3);
    }
    // After the chain: the five bands' inks, as the Mastering tab draws them.
    ctx.globalAlpha = 0.55;
    let band = 0;
    let x = 0;
    while (x < cols) {
      while (band < RAD_BANDS.length - 1 && fOf(x) >= RAD_BANDS[band].hi) band++;
      let end = x;
      while (end + 1 < cols && fOf(end + 1) < RAD_BANDS[band].hi) end++;
      ctx.fillStyle = C[RAD_BANDS[band].ink];
      ctx.beginPath();
      ctx.moveTo(x, h);
      for (let i = x; i <= end; i++) ctx.lineTo(i, yOf(this.specCols[i]));
      ctx.lineTo(end, h);
      ctx.closePath();
      ctx.fill();
      x = end + 1;
    }
    ctx.globalAlpha = 1;
    // Before it, and the held peak.
    const line = (arr, ink, width) => {
      ctx.strokeStyle = ink;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        const y = yOf(arr[i]);
        if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
      }
      ctx.stroke();
    };
    line(this.specPre, C.dim, 1);
    line(this.specHold, C.accent2, 1);
    // The chain's static EQ, on its own ±24 dB axis.
    if (this.curveChain) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < cols; i += 2) {
        const db = this.curveChain.responseDb(fOf(i));
        const y = h / 2 - clamp(db / CURVE_DB, -1, 1) * (h / 2 - 4);
        if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
      }
      ctx.stroke();
    }
  }

  /** M/S Lissajous of the pair after the chain: mono stands up the middle,
   *  a left-only sound leans left, out-of-phase material lies flat. The
   *  correlation of the window is the bar under it. */
  drawGonio(C, fresh) {
    const box = this.ctxFor(this.gonioCanvas, 196);
    if (!box) return;
    const { ctx, w, h } = box;
    const size = Math.min(w, h - 20);
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
    // Auto-gain: fast up, slow down, so a quiet instrument still draws a shape.
    const want = 0.9 / peak;
    this.gonioGain = want < this.gonioGain ? want : this.gonioGain + (want - this.gonioGain) * 0.05;
    const g = this.gonioGain * (size / 2) * Math.SQRT1_2;
    if (fresh) {
      ctx.fillStyle = C.meter;
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
    ctx.fillText(`${t("imix.correlation")} ${fresh ? corr.toFixed(2) : "—"}`, bx, by + 20);
  }

  /** One equaliser's static response, drawn in its own unit. */
  drawCurve(cv, ids) {
    const box = this.ctxFor(cv, 70);
    if (!box) return;
    const { ctx, w, h } = box;
    const C = themeColors();
    const block = this.block;
    if (!block) return;
    const only = { ...normaliseImixBlock(block), equipment: {} };
    for (const id of ids) {
      const e = block.equipment[id];
      if (e) only.equipment[id] = { ...e, bypass: false };
    }
    const chain = new InstrumentChain(only, SAMPLING_RATE, 2, true);
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = C.border;
    ctx.fillRect(0, Math.round(h / 2), w, 1);
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log(f / 20) / Math.log(1000)) * (w - 1);
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < w; x += 2) {
      const f = 20 * Math.exp((x / (w - 1)) * Math.log(1000));
      const db = chain.responseDb(f);
      const y = h / 2 - clamp(db / CURVE_DB, -1, 1) * (h / 2 - 3);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.font = canvasMonoFont(9);
    ctx.fillStyle = C.dim;
    ctx.fillText(`±${CURVE_DB} dB`, 3, 10);
  }
}
