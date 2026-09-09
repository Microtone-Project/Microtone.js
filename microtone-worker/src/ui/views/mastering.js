// Mastering view (item 178) — the rack on the left, the instruments on the
// right, and nothing in between that has an opinion.
//
// ── What this view is for ──
// Everything else in the app is about writing the music. This is about
// delivering it: how loud it ends up, whether it clips, how much of the 8-bit
// code space it actually uses, and what the chain did to get there. That is a
// different job with different tools, which is why it is a tab and not a panel
// bolted onto the Timeline.
//
// ── The two halves ──
// The RACK is the seven stages of engine/mastering.js, in signal order, each
// with a power switch and its own controls. Nothing is hidden and nothing is
// clever: what you set is what the file gets, and a conforming player applies
// the same chain from the song's `sMst` section.
//
// The PANEL is instruments. They are deliberately numerous, because the chain
// makes no judgements at all — item 178.4's bargain is that if the tool will
// not tell you what is wrong, it owes you enough measurement to see it
// yourself. Everything there reads a tap that measures BOTH sides of the chain
// every block, so the PRE/POST switch is instant and the two readings always
// describe the same moment.
//
// ── Live and offline ──
// The live instruments answer "what is happening now". The OFFLINE ANALYSIS
// answers "where in the song is the problem" — it renders the whole thing as
// fast as the machine can and plots a measurement every 100 ms, so a sag in the
// middle eight or a limiter working three times as hard in the last chorus is
// something you can point at instead of something you have to catch.
//
// ── Automation ──
// The measure-and-set buttons are the only automation here, and they are
// arithmetic: "the render's true peak came out at −0.2 dBTP, you asked for
// −1.0, so the output gain wants to move by −0.8 dB". Each one lands as one
// ordinary undoable edit that you can see and change. Nothing decides whether
// −1.0 was the right answer.

import {
  defaultMastering, normaliseMastering, cloneMastering, masteringEqual,
  responseCurve, MasterChain, RANGE, EQ_BANDS,
  EQ_LOW_SHELF, EQ_PEAKING, EQ_HIGH_SHELF, COMP_PEAK, COMP_RMS,
  HP_SLOPE_12, HP_SLOPE_24,
} from "../../engine/mastering.js";
import {
  LoudnessIntegrator, makeMasterMeterReadout, TAP_PRE, TAP_POST, SPEC_FRAMES,
  crestDb, dbfs, BIT_DEPTHS, DEFAULT_BIT_DEPTH,
} from "../../engine/loudness.js";
import {
  Fft, hannWindow, spectrumDb, tiltDbAt, SPECTRUM_BANDS, SPECTRUM_NBANDS,
  SPECTRUM_TILT_DB_PER_OCT,
} from "../../engine/fft.js";
import { RAD_BANDS } from "../radiation.js";
import { SAMPLING_RATE } from "../../engine/constants.js";
import {
  analyseSongAsync, gainForTruePeak, gainForLoudness, trimForLoudness,
} from "../../audio/master-analysis.js";
import { setMasteringOp } from "../../doc/ops.js";
import { themeColors } from "../theme.js";
import { parseInk } from "./masterstrip.js";
import { t } from "../i18n.js";

/** Metering scale for the level bars, in dBFS. */
const METER_MIN_DB = -60;
const METER_MAX_DB = 6;
/** …and for the loudness bar, in LUFS. */
const LUFS_MIN = -40;
const LUFS_MAX = 0;
/** Gain-reduction meter span, in dB. */
const GR_MAX_DB = 24;
/** Peak-hold fall rate, dB per second — the classic 20 dB/1.7 s. */
const PEAK_FALL_DB_S = 11.8;
/** How long a clip lamp stays lit after the last over, in ms… */
const CLIP_HOLD_MS = 1600;
/** …of which this last fraction is the fade. Before that it is at full. */
const CLIP_FADE_FRACTION = 0.25;
/** Spectrometer scale, in dBFS — what the EQ graph's analyser draws between. */
const SPEC_MIN_DB = -96;
const SPEC_MAX_DB = -6;
/** Per-column ballistics for it: snap up, fall away. A spectrum that strobes is
 *  unreadable, and one that only ever rises is a peak-hold, not an analyser. */
const SPEC_ATTACK = 0.55;
const SPEC_RELEASE_DB_S = 42;
/** Default cap for the offline pass, in seconds — the same 5 minutes the
 *  exporters start at. */
const DEFAULT_ANALYSIS_CAP = 300;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fmtDb = (v, digits = 1) =>
  (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(digits) : "—");
const fmtLufs = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");
/** Code counts get big at 16 bits — group them so they can be read at a glance. */
const fmtCount = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "—");

/** Blend two theme inks, `t` of the way from `a` to `b`. The canvas twin of the
 *  `color-mix()` the DOM lamps use, so a lamp drawn here lights like one drawn
 *  there rather than snapping between two states. */
function mixInk(a, b, t) {
  const x = parseInk(a);
  const y = parseInk(b);
  const k = clamp(t, 0, 1);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * k)},${
    Math.round(x[1] + (y[1] - x[1]) * k)},${Math.round(x[2] + (y[2] - x[2]) * k)})`;
}

/** A rounded rectangle, falling back to a square one where roundRect is absent. */
function roundedRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

/** dB → 0..1 across the meter scale. */
const meterFrac = (db) => clamp((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB), 0, 1);

export class MasteringView {
  constructor(store, host) {
    this.store = store;
    this.host = host;
    this.visible = false;
    /** Which side of the chain the instruments read. */
    this.stage = TAP_POST;
    /** Live meter state (ballistics live here, not in the engine). */
    this.readout = makeMasterMeterReadout();
    this.readout.histTotal = 0;
    this.loud = [new LoudnessIntegrator(SAMPLING_RATE), new LoudnessIntegrator(SAMPLING_RATE)];
    this.peakHoldDb = [-144, -144, -144, -144];
    this.clipUntil = [0, 0, 0, 0];
    /** …and the LATCH: once anything has gone over full scale in this take, the
     *  meter's over-scale tip stays lit until the transport starts a new one.
     *  A clip that happened thirty seconds ago is still a clip in the file. */
    this.clipLatched = [false, false, false, false];
    this.grComp = 0;
    this.grLim = 0;
    this._wasPlaying = false;
    /** The last offline analysis, and the state of a running one. */
    this.analysis = null;
    /** The chain the analysis was rendered THROUGH. Every measure-and-set
     *  answer is "move this control by the distance between what I measured and
     *  what you asked for" — which is only true while the control still holds
     *  what it held during the render. Comparing against this is what stops a
     *  second click adding the same distance a second time. */
    this.analysisParams = null;
    this.analysing = false;
    this.analysisProgress = 0;
    this.analysisAbort = null;
    this.plotSeries = "lufs";
    this.analysisCap = DEFAULT_ANALYSIS_CAP;
    /** Which delivered format the bit-usage census describes: 16 bits is what
     *  a stereo WAV export writes, 8 is what the Taud device itself plays. */
    this.bitDepth = DEFAULT_BIT_DEPTH;
    /** A response-curve chain, kept off the audio path purely to draw with. */
    this.curveChain = new MasterChain(defaultMastering(), SAMPLING_RATE);
    /** The live spectrometer drawn behind the EQ curve: one transform of the
     *  tap's ring per frame, then a per-COLUMN slew so it reads as a spectrum
     *  rather than as a flicker. */
    this.fft = new Fft(SPEC_FRAMES);
    const hann = hannWindow(SPEC_FRAMES);
    this.specWin = hann.win;
    this.specNorm = 1 / ((SPEC_FRAMES / 2) * hann.sumSq);
    this.specBins = new Float64Array(SPEC_FRAMES >> 1);
    // The pink display tilt, precomputed per bin (fft.js explains why). It is
    // added to the dB the transform reports and goes no further than the paint.
    this.specTiltDb = new Float64Array(SPEC_FRAMES >> 1);
    for (let k = 1; k < this.specTiltDb.length; k++) {
      this.specTiltDb[k] = tiltDbAt((k * SAMPLING_RATE) / SPEC_FRAMES);
    }
    this.specCols = null;     // per-x smoothed dB, sized to the canvas
    this.specBandOfCol = null;
    /** Undo-gesture id for the control being dragged. */
    this.gesture = null;

    this.root = document.createElement("div");
    this.root.className = "mastering-view";
    host.appendChild(this.root);
    store.on("doc", () => {
      // A new document — or a different song of the same one — makes the
      // analysis on screen a measurement of something else. Throw it away
      // rather than leave it there looking current.
      this.clearAnalysis();
      this.resetIntegration();
      if (this.visible) this.rebuild();
    });
    store.on("edit", (tags) => {
      // Undo/redo of a mastering edit has to move the controls back. Values
      // only — REBUILDING here would tear the DOM out from under whatever
      // slider is being dragged, since a drag is a stream of edits.
      if (this.visible && tags?.some((x) => x.kind === "mastering")) {
        this.refreshValues();
        // …and the offline figures may no longer describe the chain.
        this.refreshOffline();
      }
    });
  }

  // ── lifecycle ──

  show() {
    this.visible = true;
    this.rebuild();
    this.syncTap();
  }

  hide() {
    this.visible = false;
    this.syncTap();
  }

  /**
   * The engine only pays for the tap while this view is on screen — and the
   * question is whether ANY pane is showing it, not whether this copy is. A
   * split screen can hold two Mastering views (item 148.1), and a per-copy
   * answer would have the one being closed switch the tap off under the one
   * still open.
   */
  syncTap() {
    const audio = this.store.audio;
    if (!audio) return;
    const want = this.store.viewOpen("mastering") && !!this.store.doc;
    if (audio.masterMeterOn !== want || audio.masterMeterDepth !== this.bitDepth) {
      audio.setMasterMeter(0, want, this.bitDepth);
    }
  }

  rehost() { this.rebuild(); }

  // ── the document's parameters ──

  get params() {
    return this.store.doc ? this.store.doc.mastering(this.store.songIndex) : defaultMastering();
  }

  /**
   * Apply a change. `mutate` receives a mutable copy; `control` names the
   * gesture for undo coalescing (so a slider drag is one Ctrl+Z), and null
   * never coalesces.
   */
  edit(mutate, control = null) {
    const doc = this.store.doc;
    if (!doc) return;
    const next = cloneMastering(this.params);
    mutate(next);
    const norm = normaliseMastering(next);
    if (masteringEqual(norm, this.params)) return;
    const song = this.store.songIndex;
    this.store.undo.apply(setMasteringOp(
      song, doc.masteringPayloadWith(song, norm), control, this.gesture));
    this.refreshValues();
  }

  /** Bracket a drag so every step of it collapses into one undo entry. */
  beginGesture() { this.gesture = `mst-${Date.now()}-${Math.random()}`; }
  endGesture() { this.gesture = null; }

  // ── building the rack ──

  rebuild() {
    this.root.textContent = "";
    this.controls = [];
    if (!this.store.doc) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = t("mst.noDoc");
      this.root.appendChild(empty);
      return;
    }
    this.root.append(this.buildHead(), this.buildRack(), this.buildPanel());
    this.refreshValues();
  }

  buildHead() {
    const head = document.createElement("div");
    head.className = "mst-head";

    const title = document.createElement("span");
    title.className = "mst-title";
    title.textContent = t("mst.title");

    const power = this.switchEl(t("mst.chainOn"), () => this.params.on,
      (on) => this.edit((p) => { p.on = on; }));
    power.classList.add("mst-power");

    const seg = document.createElement("div");
    seg.className = "mst-seg";
    for (const [stage, key] of [[TAP_PRE, "mst.pre"], [TAP_POST, "mst.post"]]) {
      const b = document.createElement("button");
      b.textContent = t(key);
      b.title = t(stage === TAP_PRE ? "mst.preTitle" : "mst.postTitle");
      b.classList.toggle("active", this.stage === stage);
      b.addEventListener("click", () => {
        this.stage = stage;
        for (const other of seg.children) other.classList.toggle("active", other === b);
        // The spectrogram draws ONE side, so the switch changes what it shows.
        this._plotW = -1;
        // …and the spectrometer's columns belong to the side they were measured
        // on; let them re-converge rather than cross-fade between two signals.
        this.specCols?.fill(SPEC_MIN_DB);
      });
      seg.appendChild(b);
    }

    const reset = document.createElement("button");
    reset.textContent = t("mst.reset");
    reset.title = t("mst.resetTitle");
    reset.addEventListener("click", () => {
      this.edit((p) => Object.assign(p, defaultMastering()));
      this.rebuild();
    });

    const spacer = document.createElement("div");
    spacer.className = "grow";
    head.append(title, power, spacer, seg, reset);
    return head;
  }

  buildRack() {
    const rack = document.createElement("div");
    rack.className = "mst-rack";
    rack.append(
      this.unitTrim(),
      this.unitHighPass(),
      this.unitEq(),
      this.unitCompressor(),
      this.unitWidth(),
      this.unitLimiter(),
      this.unitOutput(),
    );
    return rack;
  }

  /** One rack unit: a titled box with an optional power switch. */
  unit(titleKey, { power = null, hint = null } = {}) {
    const box = document.createElement("section");
    box.className = "mst-unit";
    const head = document.createElement("div");
    head.className = "mst-unit-head";
    const name = document.createElement("span");
    name.className = "mst-unit-name";
    name.textContent = t(titleKey);
    head.append(name);
    if (power) {
      const sw = this.switchEl("", power.get, power.set);
      head.appendChild(sw);
      box.classList.add("mst-switchable");
      this.controls.push({ el: box, refresh: () => box.classList.toggle("mst-off", !power.get()) });
    }
    const body = document.createElement("div");
    body.className = "mst-unit-body";
    box.append(head, body);
    if (hint) {
      const h = document.createElement("p");
      h.className = "mst-hint";
      h.textContent = t(hint);
      body.appendChild(h);
    }
    box.body = body;
    return box;
  }

  unitTrim() {
    const u = this.unit("mst.trim", { hint: "mst.trimHint" });
    u.body.append(this.dbRow("mst.trimAmount", "trimDb", "trimDb"));
    return u;
  }

  unitHighPass() {
    const u = this.unit("mst.hp", {
      power: { get: () => this.params.hpOn, set: (on) => this.edit((p) => { p.hpOn = on; }) },
      hint: "mst.hpHint",
    });
    u.body.append(
      this.numRow("mst.hpFreq", "hpFreq", "hpFreq", { unit: "Hz", digits: 0, log: true }),
      this.choiceRow("mst.hpSlope", [
        [HP_SLOPE_12, "12 dB/oct"], [HP_SLOPE_24, "24 dB/oct"],
      ], () => this.params.hpSlope, (v) => this.edit((p) => { p.hpSlope = v; }, "hpSlope")),
    );
    return u;
  }

  unitEq() {
    const u = this.unit("mst.eq", {
      power: { get: () => this.params.eqOn, set: (on) => this.edit((p) => { p.eqOn = on; }) },
      hint: "mst.eqNote",
    });
    // The response curve sits inside the unit: an EQ you cannot see is a set of
    // numbers, and the whole point of four bands is the shape they make.
    this.eqCanvas = document.createElement("canvas");
    this.eqCanvas.className = "mst-eq-curve";
    u.body.appendChild(this.eqCanvas);
    for (let i = 0; i < EQ_BANDS; i++) u.body.appendChild(this.eqBand(i));
    return u;
  }

  eqBand(i) {
    const box = document.createElement("div");
    box.className = "mst-band";
    const head = document.createElement("div");
    head.className = "mst-band-head";
    const name = document.createElement("span");
    name.textContent = t("mst.band", { n: i + 1 });
    head.append(name,
      this.switchEl("", () => this.params.eq[i].on,
        (on) => this.edit((p) => { p.eq[i].on = on; })));
    box.appendChild(head);
    // Only the outer bands may be shelves (mastering.js normalises the rest),
    // so the middle two do not offer a choice they would not keep.
    if (i === 0 || i === EQ_BANDS - 1) {
      const shelf = i === 0 ? EQ_LOW_SHELF : EQ_HIGH_SHELF;
      box.appendChild(this.choiceRow("mst.bandType", [
        [shelf, t(i === 0 ? "mst.lowShelf" : "mst.highShelf")], [EQ_PEAKING, t("mst.bell")],
      ], () => this.params.eq[i].type,
        (v) => this.edit((p) => { p.eq[i].type = v; }, `eqType${i}`)));
    }
    box.append(
      this.numRow("mst.freq", null, `eq${i}freq`, {
        unit: "Hz", digits: 0, log: true, range: "eqFreq",
        get: () => this.params.eq[i].freq,
        set: (v) => this.edit((p) => { p.eq[i].freq = v; }, `eq${i}freq`),
      }),
      this.numRow("mst.gain", null, `eq${i}gain`, {
        unit: "dB", digits: 1, signed: true, range: "eqGainDb",
        get: () => this.params.eq[i].gainDb,
        set: (v) => this.edit((p) => { p.eq[i].gainDb = v; }, `eq${i}gain`),
      }),
      this.numRow("mst.q", null, `eq${i}q`, {
        digits: 2, log: true, range: "eqQ",
        get: () => this.params.eq[i].q,
        set: (v) => this.edit((p) => { p.eq[i].q = v; }, `eq${i}q`),
      }),
    );
    return box;
  }

  unitCompressor() {
    const u = this.unit("mst.comp", {
      power: { get: () => this.params.compOn, set: (on) => this.edit((p) => { p.compOn = on; }) },
      hint: "mst.compHint",
    });
    u.body.append(
      this.choiceRow("mst.detector", [
        [COMP_PEAK, t("mst.peak")], [COMP_RMS, t("mst.rms")],
      ], () => this.params.compDetector,
        (v) => this.edit((p) => { p.compDetector = v; }, "compDet")),
      this.numRow("mst.threshold", "compThreshDb", "compThresh", { unit: "dB", digits: 1 }),
      this.numRow("mst.ratio", "compRatio", "compRatio", { digits: 2, suffix: ":1", log: true }),
      this.numRow("mst.attack", "compAttackMs", "compAttack", { unit: "ms", digits: 1, log: true }),
      this.numRow("mst.release", "compReleaseMs", "compRelease", { unit: "ms", digits: 0, log: true }),
      this.numRow("mst.knee", "compKneeDb", "compKnee", { unit: "dB", digits: 1 }),
      this.numRow("mst.makeup", "compMakeupDb", "compMakeup", { unit: "dB", digits: 1, signed: true }),
    );
    return u;
  }

  unitWidth() {
    const u = this.unit("mst.width", {
      power: { get: () => this.params.widthOn, set: (on) => this.edit((p) => { p.widthOn = on; }) },
      hint: "mst.widthHint",
    });
    u.body.append(this.numRow("mst.widthAmount", "width", "width", {
      digits: 0, scale: 100, unit: "%",
    }));
    return u;
  }

  unitLimiter() {
    const u = this.unit("mst.limiter", {
      power: { get: () => this.params.limOn, set: (on) => this.edit((p) => { p.limOn = on; }) },
      hint: "mst.limHint",
    });
    u.body.append(
      this.numRow("mst.ceiling", "limCeilingDb", "limCeiling", { unit: "dB", digits: 1 }),
      this.numRow("mst.release", "limReleaseMs", "limRelease", { unit: "ms", digits: 0, log: true }),
      this.checkRow("mst.truePeak", "mst.truePeakTitle",
        () => this.params.limTruePeak,
        (v) => this.edit((p) => { p.limTruePeak = v; })),
    );
    return u;
  }

  unitOutput() {
    const u = this.unit("mst.output", { hint: "mst.outputHint" });
    u.body.append(this.dbRow("mst.outGain", "outGainDb", "outGain"));
    return u;
  }

  // ── control widgets ──

  /** A small on/off switch that reads its state from the document. */
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
    this.controls.push({ el: wrap, refresh: () => { box.checked = !!get(); } });
    return wrap;
  }

  dbRow(labelKey, key, control) {
    return this.numRow(labelKey, key, control, { unit: "dB", digits: 1, signed: true });
  }

  /**
   * Label · number · slider. The slider is logarithmic where the parameter is
   * (frequency, ratio, times) so the useful half of the range is not squeezed
   * into the last centimetre.
   */
  numRow(labelKey, key, control, opts = {}) {
    const rangeKey = opts.range ?? key;
    const [lo, hi] = RANGE[rangeKey];
    const scale = opts.scale ?? 1;
    const get = opts.get ?? (() => this.params[key]);
    const set = opts.set ?? ((v) => this.edit((p) => { p[key] = v; }, control));

    const row = document.createElement("div");
    row.className = "mst-row";
    const lab = document.createElement("span");
    lab.className = "mst-lab";
    lab.textContent = t(labelKey);
    const digits = opts.digits ?? 2;
    const num = document.createElement("input");
    num.type = "number";
    num.className = "mst-num";
    num.min = lo * scale; num.max = hi * scale;
    num.step = 10 ** -digits;
    const range = document.createElement("input");
    range.type = "range";
    range.className = "mst-range";
    range.min = 0; range.max = 1000; range.step = 1;
    const ann = document.createElement("span");
    ann.className = "mst-ann";

    const STEPS = 1000;
    const logLo = Math.max(lo, 1e-3);
    const toPos = (v) => (opts.log
      ? Math.round((Math.log(clamp(v, logLo, hi) / logLo) / Math.log(hi / logLo)) * STEPS)
      : Math.round(((clamp(v, lo, hi) - lo) / (hi - lo)) * STEPS));
    const fromPos = (p) => (opts.log
      ? logLo * (hi / logLo) ** (p / STEPS)
      : lo + (p / STEPS) * (hi - lo));
    // Rounding happens in the DISPLAYED units, not the stored ones: width is
    // shown as a percentage with no decimals, and rounding its stored 0…2 to
    // whole numbers would leave three settings.
    const round = (v) => clamp(
      Math.round(v * scale * 10 ** digits) / 10 ** digits / scale, lo, hi);

    const paint = () => {
      const v = get();
      num.value = (v * scale).toFixed(digits);
      // Never move the control the pointer is holding.
      if (this._dragging !== range) range.value = toPos(v);
      ann.textContent = opts.suffix ?? opts.unit ?? "";
    };
    num.addEventListener("change", () => {
      set(round(parseFloat(num.value || "0") / scale));
      paint();
    });
    range.addEventListener("pointerdown", () => { this._dragging = range; this.beginGesture(); });
    for (const ev of ["pointerup", "pointercancel", "blur"]) {
      range.addEventListener(ev, () => { this._dragging = null; this.endGesture(); });
    }
    range.addEventListener("input", () => {
      set(round(fromPos(+range.value)));
      num.value = (get() * scale).toFixed(digits);
    });
    row.append(lab, num, ann, range);
    this.controls.push({ el: row, refresh: paint });
    return row;
  }

  choiceRow(labelKey, options, get, set) {
    const row = document.createElement("div");
    row.className = "mst-row mst-row-choice";
    const lab = document.createElement("span");
    lab.className = "mst-lab";
    lab.textContent = t(labelKey);
    const sel = document.createElement("select");
    for (const [value, text] of options) {
      const o = document.createElement("option");
      o.value = String(value);
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => set(+sel.value));
    row.append(lab, sel);
    this.controls.push({ el: row, refresh: () => { sel.value = String(get()); } });
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
    this.controls.push({ el: row, refresh: () => { box.checked = !!get(); } });
    return row;
  }

  /** Push the document's values back into every control (rebuild, undo). */
  refreshValues() {
    for (const c of this.controls ?? []) c.refresh();
    this.curveChain.setParams(this.params);
  }
  // ── building the instrument panel ──

  buildPanel() {
    const panel = document.createElement("div");
    panel.className = "mst-panel";
    panel.append(
      this.scopeLoudness(),
      this.scopeLevels(),
      this.scopeReduction(),
      this.scopeHistogram(),
      this.scopeOffline(),
    );
    return panel;
  }

  /** A titled instrument box. */
  scope(titleKey, { note = null } = {}) {
    const box = document.createElement("section");
    box.className = "mst-scope";
    const head = document.createElement("div");
    head.className = "mst-scope-head";
    const name = document.createElement("span");
    name.textContent = t(titleKey);
    head.append(name);
    const stageTag = document.createElement("span");
    stageTag.className = "mst-stagetag";
    head.append(stageTag);
    box.stageTag = stageTag;
    const body = document.createElement("div");
    body.className = "mst-scope-body";
    box.append(head, body);
    if (note) {
      const n = document.createElement("p");
      n.className = "mst-hint";
      n.textContent = t(note);
      body.appendChild(n);
    }
    box.body = body;
    return box;
  }

  /** A grid of big numbers with small captions. */
  readoutGrid(fields) {
    const grid = document.createElement("div");
    grid.className = "mst-readouts";
    const cells = {};
    for (const [key, labelKey, titleKey] of fields) {
      const cell = document.createElement("div");
      cell.className = "mst-readout";
      const v = document.createElement("b");
      v.textContent = "—";
      const l = document.createElement("span");
      l.textContent = t(labelKey);
      if (titleKey) cell.title = t(titleKey);
      cell.append(v, l);
      grid.appendChild(cell);
      cells[key] = v;
    }
    return { grid, cells };
  }

  scopeLoudness() {
    const box = this.scope("mst.loudness", { note: "mst.loudnessNote" });
    const { grid, cells } = this.readoutGrid([
      ["m", "mst.momentary", "mst.momentaryTitle"],
      ["s", "mst.shortTerm", "mst.shortTermTitle"],
      ["i", "mst.integrated", "mst.integratedTitle"],
      ["lra", "mst.lra", "mst.lraTitle"],
      ["tp", "mst.truePeakRead", "mst.truePeakReadTitle"],
      ["plr", "mst.plr", "mst.plrTitle"],
      ["crest", "mst.crest", "mst.crestTitle"],
    ]);
    this.loudCells = cells;
    this.loudCanvas = document.createElement("canvas");
    this.loudCanvas.className = "mst-canvas mst-loudbar";
    box.body.append(grid, this.loudCanvas);
    this.loudBox = box;
    return box;
  }

  scopeLevels() {
    const box = this.scope("mst.levels", { note: "mst.levelsNote" });
    this.levelCanvas = document.createElement("canvas");
    this.levelCanvas.className = "mst-canvas mst-levels";
    // Clicking a lit over-scale tip acknowledges it. The latch is a claim about
    // the take ("this clipped"), so the way to put it out is to say you have
    // seen it — the alternative, waiting for the next take, means a clip you
    // have already fixed keeps accusing you.
    //
    // One click clears EVERY channel, and both sides of the chain, rather than
    // the band under the pointer: the gesture means "noted", and having to
    // chase each lit band separately — or find a fifth one waiting behind the
    // pre/post switch — would make an acknowledgement feel like a chore.
    this.levelCanvas.addEventListener("click", (e) => {
      if (this.tipAt(e) < 0) return;
      this.clipLatched.fill(false);
      this.clipUntil.fill(0);
    });
    this.levelCanvas.addEventListener("pointermove", (e) => {
      this.levelCanvas.style.cursor = this.tipAt(e) >= 0 ? "pointer" : "";
    });
    this.levelCanvas.addEventListener("pointerleave", () => {
      this.levelCanvas.style.cursor = "";
    });
    box.body.append(this.levelCanvas);
    this.levelBox = box;
    return box;
  }

  /** Which channel's LIT over-scale tip a pointer event is over, or −1. The
   *  geometry has to agree with drawLevels, so both read it from here. */
  tipAt(e) {
    const geom = this.levelGeom;
    if (!geom) return -1;
    const r = this.levelCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < geom.tipX || x > geom.right) return -1;
    for (let c = 0; c < 2; c++) {
      const i = this.stage * 2 + c;
      const top = geom.top + c * (geom.barH + 3);
      if (this.clipLatched[i] && y >= top && y <= top + geom.barH) return i;
    }
    return -1;
  }

  scopeReduction() {
    const box = this.scope("mst.reduction", { note: "mst.reductionNote" });
    this.grCanvas = document.createElement("canvas");
    this.grCanvas.className = "mst-canvas mst-gr";
    box.body.append(this.grCanvas);
    return box;
  }

  scopeHistogram() {
    const box = this.scope("mst.bits", { note: "mst.bitsNote" });
    // Which output the census describes. The default is the 16 bits a stereo
    // WAV export writes; the Taud device's own 8-bit delivery is the other
    // answer, and both are worth being able to ask for.
    const depth = document.createElement("select");
    depth.className = "mst-depth";
    for (const d of BIT_DEPTHS) {
      const o = document.createElement("option");
      o.value = String(d);
      o.textContent = t(d === 8 ? "mst.depth8" : "mst.depth16");
      depth.appendChild(o);
    }
    depth.value = String(this.bitDepth);
    depth.title = t("mst.depthTitle");
    depth.addEventListener("change", () => {
      this.bitDepth = Number(depth.value);
      // A census taken at another depth is a census of something else.
      this.syncTap();
    });
    box.querySelector(".mst-scope-head").insertBefore(depth, box.stageTag);

    this.histCanvas = document.createElement("canvas");
    this.histCanvas.className = "mst-canvas mst-hist";
    const { grid, cells } = this.readoutGrid([
      ["span", "mst.codeSpan", "mst.codeSpanTitle"],
      ["used", "mst.codesUsed", "mst.codesUsedTitle"],
      ["eff", "mst.effBits", "mst.effBitsTitle"],
      ["ent", "mst.entBits", "mst.entBitsTitle"],
    ]);
    this.bitCells = cells;
    box.body.append(this.histCanvas, grid);
    return box;
  }

  // ── the offline analysis instrument ──

  scopeOffline() {
    const box = this.scope("mst.offline", { note: "mst.offlineNote" });

    const bar = document.createElement("div");
    bar.className = "mst-offbar";
    this.runBtn = document.createElement("button");
    this.runBtn.textContent = t("mst.analyse");
    this.runBtn.addEventListener("click", () => (this.analysing ? this.cancelAnalysis() : this.runAnalysis()));
    const capLab = document.createElement("label");
    capLab.className = "mst-caplab";
    capLab.append(t("mst.cap") + " ");
    const cap = document.createElement("input");
    cap.type = "number"; cap.min = 1; cap.max = 3600; cap.value = String(this.analysisCap);
    cap.className = "mst-cap";
    cap.addEventListener("change", () => {
      this.analysisCap = clamp(parseInt(cap.value || "300", 10) || 300, 1, 3600);
      cap.value = String(this.analysisCap);
    });
    capLab.appendChild(cap);
    this.progressEl = document.createElement("span");
    this.progressEl.className = "mst-progress";
    bar.append(this.runBtn, capLab, this.progressEl);

    const pick = document.createElement("div");
    pick.className = "mst-seg mst-serieseg";
    for (const [key, labelKey] of [
      ["lufs", "mst.plotLufs"],
      ["peak", "mst.plotPeak"],
      ["crest", "mst.plotCrest"],
      ["gap", "mst.plotGap"],
      ["spectrum", "mst.plotSpectrum"],
    ]) {
      const b = document.createElement("button");
      b.textContent = t(labelKey);
      b.classList.toggle("active", this.plotSeries === key);
      b.addEventListener("click", () => {
        this.plotSeries = key;
        for (const other of pick.children) other.classList.toggle("active", other === b);
        this._plotW = -1;
      });
      pick.appendChild(b);
    }

    this.plotCanvas = document.createElement("canvas");
    this.plotCanvas.className = "mst-canvas mst-plot";
    this._plotW = -1;

    this.summaryEl = document.createElement("div");
    this.summaryEl.className = "mst-summary";

    // ── the measure-and-set buttons (item 178.2) ──
    const auto = document.createElement("div");
    auto.className = "mst-auto";
    const autoHint = document.createElement("p");
    autoHint.className = "mst-hint";
    autoHint.textContent = t("mst.autoHint");
    auto.appendChild(autoHint);

    const mkTarget = (labelKey, value, step, min, max) => {
      const lab = document.createElement("label");
      lab.className = "mst-caplab";
      lab.append(t(labelKey) + " ");
      const inp = document.createElement("input");
      inp.type = "number"; inp.value = String(value);
      inp.step = step; inp.min = min; inp.max = max;
      inp.className = "mst-cap";
      lab.appendChild(inp);
      return { lab, inp };
    };
    const tp = mkTarget("mst.targetTp", -1, 0.1, -24, 0);
    const lu = mkTarget("mst.targetLufs", -14, 0.5, -40, 0);
    const inTrim = mkTarget("mst.targetTrim", -18, 0.5, -40, 0);

    const row = (target, btnKey, titleKey, needs, run) => {
      const line = document.createElement("div");
      line.className = "mst-autorow";
      const b = document.createElement("button");
      b.textContent = t(btnKey);
      b.dataset.needs = needs;
      b.dataset.help = titleKey;
      b.title = t(titleKey);
      b.addEventListener("click", () => run(parseFloat(target.inp.value)));
      line.append(target.lab, b);
      this.autoButtons.push(b);
      return line;
    };
    this.autoButtons = [];
    auto.append(
      row(tp, "mst.setGain", "mst.setGainTitle", "post", (v) => this.applyMakeupForTruePeak(v)),
      row(lu, "mst.setGainLufs", "mst.setGainLufsTitle", "post", (v) => this.applyMakeupForLoudness(v)),
      row(inTrim, "mst.setTrim", "mst.setTrimTitle", "pre", (v) => this.applyTrimForLoudness(v)),
    );

    box.body.append(bar, this.summaryEl, pick, this.plotCanvas, auto);
    this.offlineBox = box;
    this.refreshOffline();
    return box;
  }

  async runAnalysis() {
    const doc = this.store.doc;
    if (!doc || this.analysing) return;
    this.analysing = true;
    this.analysisProgress = 0;
    this.analysisAbort = new AbortController();
    this.refreshOffline();
    try {
      this.analysisParams = cloneMastering(this.params);
      this.analysis = await analyseSongAsync(
        doc.toRenderable(this.store.songIndex), this.store.songIndex, this.analysisCap, {
          onProgress: (f) => { this.analysisProgress = f; this.refreshOffline(); },
          signal: this.analysisAbort.signal,
        });
    } catch (err) {
      console.error("mastering analysis failed", err);
      this.analysis = null;
    } finally {
      this.analysing = false;
      this.analysisAbort = null;
      this.refreshOffline();
      this._plotW = -1;
    }
  }

  cancelAnalysis() { this.analysisAbort?.abort(); }

  /** Drop the offline result (and stop one in flight). */
  clearAnalysis() {
    this.analysisAbort?.abort();
    this.analysis = null;
    this.analysisParams = null;
    this.analysisProgress = 0;
    this._plotW = -1;
    if (this.runBtn) this.refreshOffline();
  }

  /**
   * Does the analysis still describe the chain that is set up now?
   *
   * Every POST figure was measured through the chain as it stood during the
   * render, so any edit at all — including one a measure-and-set button just
   * made — leaves those numbers describing something else. The chain is not
   * linear either (a compressor and a limiter both bite), so there is no
   * correcting for it arithmetically: the honest move is to say so and ask for
   * another pass.
   */
  get stale() {
    return this.analysis !== null && this.analysisParams !== null &&
      !masteringEqual(this.analysisParams, this.params);
  }

  /**
   * …and the narrower question the two make-up buttons ask, which is NOT the
   * same one.
   *
   * They answer with an absolute make-up value derived from the analysis: the
   * make-up the render was made at, plus the distance the render missed its
   * target by. So the one field they write is the one field whose drift they
   * already account for — after a click, their answer is the number that is
   * already in the box, and clicking again is a no-op rather than a second
   * helping. Any OTHER difference does invalidate them, because the
   * measurement was taken through a chain that no longer exists.
   */
  get makeupStale() {
    if (this.analysis === null || this.analysisParams === null) return false;
    const live = cloneMastering(this.params);
    live.compMakeupDb = this.analysisParams.compMakeupDb;
    return !masteringEqual(this.analysisParams, live);
  }

  refreshOffline() {
    if (!this.runBtn) return;
    this.runBtn.textContent = t(this.analysing ? "mst.cancel" : "mst.analyse");
    this.progressEl.textContent = this.analysing
      ? `${Math.round(this.analysisProgress * 100)}%`
      : (this.analysis ? t("mst.analysedFor", { s: this.analysis.seconds.toFixed(1) }) : "");
    const a = this.analysis;
    const stale = this.stale;
    const makeupStale = this.makeupStale;
    const compOff = !this.params.compOn;
    for (const b of this.autoButtons ?? []) {
      // The two POST buttons need an analysis of THIS chain and a compressor to
      // write into. "This chain" is `makeupStale`, not `stale`: their own edit
      // moves the make-up and nothing else, and their answer is anchored to the
      // make-up the analysis was rendered at, so it survives that edit
      // unchanged. The PRE one (the input trim) needs neither, because the pre
      // tap sits upstream of the whole chain and no chain edit can invalidate
      // it.
      const needsPost = b.dataset.needs === "post";
      b.disabled = !a || this.analysing ||
        (needsPost && (makeupStale || compOff));
      b.title = t(!a ? "mst.needAnalysis"
        : needsPost && makeupStale ? "mst.needReanalysis"
        : needsPost && compOff ? "mst.needComp"
        : b.dataset.help);
    }
    if (!a) { this.summaryEl.textContent = ""; return; }
    const g = (side) => a[side];
    const line = (key, side) => {
      const s = g(side);
      return `${t(key)} ${fmtLufs(s.integratedLufs)} LUFS · ${t("mst.lra")} ${s.rangeLu.toFixed(1)} LU · ` +
        `${t("mst.truePeakRead")} ${fmtDb(s.truePeakDb)} dBTP · ${t("mst.plr")} ${s.plr.toFixed(1)} LU · ` +
        `${t("mst.crestGap")} ${s.crestGapDb.toFixed(2)} dB · ${t("mst.clips")} ${s.clipCount}`;
    };
    this.summaryEl.textContent = "";
    for (const [key, side] of [["mst.pre", "pre"], ["mst.post", "post"]]) {
      const p = document.createElement("div");
      p.textContent = line(key, side);
      this.summaryEl.appendChild(p);
    }
    if (stale) {
      const p = document.createElement("div");
      p.className = "mst-warn";
      p.textContent = t("mst.stale");
      this.summaryEl.appendChild(p);
    }
    if (a.aborted) {
      const p = document.createElement("div");
      p.className = "mst-warn";
      p.textContent = t("mst.aborted");
      this.summaryEl.appendChild(p);
    } else if (!a.halted) {
      const p = document.createElement("div");
      p.className = "mst-warn";
      p.textContent = t("mst.capped", { s: a.seconds.toFixed(0) });
      this.summaryEl.appendChild(p);
    }
  }

  /**
   * The two POST helpers write the COMPRESSOR's make-up, not the output gain.
   *
   * Make-up is where a master's level is found in practice — it drives the
   * limiter, which is what holds the ceiling — while the output gain is the
   * last thing in the chain and belongs to the composer's own hand.
   *
   * Each answers with ONE ABSOLUTE NUMBER, and the anchor is what makes that
   * work: `analysisParams.compMakeupDb` is the make-up the analysis was
   * RENDERED at, so "that, plus the distance the render missed by" is a
   * property of the measurement alone. The live value is not consulted and is
   * simply overwritten. Click it twice and the second click computes the same
   * number, which `edit` then discards as a no-op — no compounding, and no
   * button that goes dead after one use. (Anchoring on the LIVE make-up is what
   * used to compound, and disabling the button was the wrong half of the fix.)
   *
   * The chain is not linear, so one click does not guarantee the target is met
   * exactly — the compressor's curve and the limiter both sit downstream of
   * make-up. Re-analysing and clicking again converges; the amber line says
   * when the numbers on screen no longer describe the chain.
   */
  applyMakeupForTruePeak(target) {
    if (!this.analysis || this.makeupStale || !this.params.compOn) return;
    const v = gainForTruePeak(this.analysis, target, this.analysisParams.compMakeupDb);
    if (v === null) return;
    this.edit((p) => { p.on = true; p.compMakeupDb = v; });
    this.refreshValues();
  }

  applyMakeupForLoudness(target) {
    if (!this.analysis || this.makeupStale || !this.params.compOn) return;
    const v = gainForLoudness(this.analysis, target, this.analysisParams.compMakeupDb);
    if (v === null) return;
    this.edit((p) => { p.on = true; p.compMakeupDb = v; });
    this.refreshValues();
  }

  applyTrimForLoudness(target) {
    if (!this.analysis) return;
    const v = trimForLoudness(this.analysis, target);
    if (v === null) return;
    this.edit((p) => { p.on = true; p.trimDb = v; });
    this.refreshValues();
  }

  // ── per-frame ──

  frame() {
    if (!this.visible || !this.store.doc) return;
    this.syncTap();
    const now = performance.now();
    const dt = this._lastMs ? Math.min(now - this._lastMs, 250) : 16;
    this._lastMs = now;

    const audio = this.store.audio;
    if (audio) {
      const playing = audio.isPlaying();
      // A fresh take starts the integration again — an integrated loudness that
      // spans two different playbacks is a number about nothing.
      if (playing && !this._wasPlaying) this.resetIntegration();
      this._wasPlaying = playing;
      const r = audio.readMasterMeter(this.readout);
      if (r.frames > 0) {
        for (let s = 0; s < 2; s++) {
          const sq = (r.meanSquare[s * 2] + r.meanSquare[s * 2 + 1]) * 0.5 * r.frames;
          this.loud[s].push(r.sumZ[s], sq * 2,
            Math.max(r.peak[s * 2], r.peak[s * 2 + 1]),
            Math.max(r.truePeak[s * 2], r.truePeak[s * 2 + 1]), r.frames);
        }
        for (let i = 0; i < 4; i++) {
          const db = dbfs(r.truePeak[i]);
          if (db > this.peakHoldDb[i]) this.peakHoldDb[i] = db;
          if (r.clip[i] > 0) {
            this.clipUntil[i] = now + CLIP_HOLD_MS;
            this.clipLatched[i] = true;
          }
        }
        this.grComp = r.compGrDb;
        this.grLim = r.limGrDb;
      }
      // Peak holds always fall, whether or not this interval carried frames.
      const fall = (PEAK_FALL_DB_S * dt) / 1000;
      for (let i = 0; i < 4; i++) this.peakHoldDb[i] = Math.max(this.peakHoldDb[i] - fall, -144);
    }

    const C = themeColors();
    this.drawLoudness(C);
    this.drawLevels(C, now);
    this.drawReduction(C);
    this.drawHistogram(C);
    this.drawEqCurve(C, dt);
    // The offline plot only changes when the analysis, the series or the
    // canvas width does — redrawing a five-minute polyline sixty times a
    // second would be the most expensive thing on this screen for no reason.
    if (this.plotCanvas && this.plotCanvas.clientWidth !== this._plotW) {
      this._plotW = this.plotCanvas.clientWidth;
      this.drawPlot();
    }
  }

  resetIntegration() {
    for (const l of this.loud) l.reset();
    this.peakHoldDb.fill(-144);
    this.clipUntil.fill(0);
    this.clipLatched.fill(false);
  }

  // ── painting ──

  /** Size a canvas to its box at the device pixel ratio; returns its 2D context
   *  already scaled, or null when it has no box yet. */
  ctxFor(canvas, cssHeight) {
    const w = canvas.clientWidth;
    if (!w) return null;
    const dpr = window.devicePixelRatio || 1;
    const h = cssHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.height = h + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  stageLabel() { return t(this.stage === TAP_PRE ? "mst.pre" : "mst.post"); }

  drawLoudness(C) {
    const l = this.loud[this.stage];
    const cells = this.loudCells;
    if (!cells) return;
    if (this.loudBox) this.loudBox.stageTag.textContent = this.stageLabel();
    const i = this.stage * 2;
    const r = this.readout;
    const peak = Math.max(r.peak[i], r.peak[i + 1]);
    const ms = (r.meanSquare[i] + r.meanSquare[i + 1]) * 0.5;
    cells.m.textContent = fmtLufs(l.momentary);
    cells.s.textContent = fmtLufs(l.shortTerm);
    cells.i.textContent = fmtLufs(l.integrated);
    cells.lra.textContent = l.range > 0 ? l.range.toFixed(1) : "—";
    cells.tp.textContent = l.truePeak > 0 ? fmtDb(dbfs(l.truePeak)) : "—";
    cells.plr.textContent = Number.isFinite(l.plr) ? l.plr.toFixed(1) : "—";
    cells.crest.textContent = ms > 0 ? crestDb(peak, ms).toFixed(1) : "—";

    const box = this.ctxFor(this.loudCanvas, 38);
    if (!box) return;
    const { ctx, w, h } = box;
    const top = 14;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(0, top, w, h - top);
    const frac = (v) => clamp((v - LUFS_MIN) / (LUFS_MAX - LUFS_MIN), 0, 1);
    // Short-term as the bar, momentary as a bright tick over it: the slow
    // reading is the shape of the mix, the fast one is what just happened.
    const st = l.shortTerm;
    if (Number.isFinite(st)) {
      ctx.fillStyle = C.meter;
      ctx.fillRect(0, top, frac(st) * w, h - top);
    }
    const mo = l.momentary;
    if (Number.isFinite(mo)) {
      ctx.fillStyle = C.accent;
      ctx.fillRect(frac(mo) * w - 1, top, 2, h - top);
    }
    // Scale ticks every 10 LU.
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let v = LUFS_MIN; v <= LUFS_MAX; v += 10) {
      const x = frac(v) * w;
      ctx.fillRect(x, top - 4, 1, 4);
      ctx.fillText(String(v), clamp(x, 12, w - 12), top - 5);
    }
  }

  drawLevels(C, now) {
    if (this.levelBox) this.levelBox.stageTag.textContent = this.stageLabel();
    const box = this.ctxFor(this.levelCanvas, 84);
    if (!box) return;
    const { ctx, w, h } = box;
    const r = this.readout;
    const labels = ["L", "R"];
    const barH = 20;
    // Room above the bars for the scale row, whose labels hang off an
    // alphabetic baseline and would otherwise sit off the top of the canvas.
    const top = 22;
    ctx.font = "10px system-ui, sans-serif";
    // Scale ticks first, so the bars sit over them.
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(22, top, w - 22, barH * 2 + 6);
    ctx.textAlign = "center";
    ctx.fillStyle = C.dim;
    for (let db = METER_MIN_DB; db <= METER_MAX_DB; db += 6) {
      const x = 22 + meterFrac(db) * (w - 30);
      ctx.fillRect(x, top - 5, 1, 4);
      if (db % 12 === 0) ctx.fillText(String(db), clamp(x, 30, w - 12), top - 7);
    }
    ctx.textAlign = "left";
    for (let c = 0; c < 2; c++) {
      const i = this.stage * 2 + c;
      const y = top + c * (barH + 3);
      const rms = r.meanSquare[i] > 0 ? 10 * Math.log10(r.meanSquare[i]) : -144;
      const peakDb = dbfs(r.peak[i]);
      const span = w - 30;
      ctx.fillStyle = C.meter;
      ctx.fillRect(22, y, meterFrac(rms) * span, barH);
      // The over-scale TIP: everything past 0 dBFS, lit red and LATCHED. The
      // lamp below says "clipping now" and goes out; this says "this take
      // clipped" and stays, because a clip thirty seconds ago is still in the
      // file. Both are cleared when the transport starts a fresh take.
      const zero = 22 + meterFrac(0) * span;
      // Published for tipAt, so the click target and the paint cannot drift.
      this.levelGeom = { top, barH, tipX: zero, right: 22 + span };
      if (this.clipLatched[i]) {
        ctx.fillStyle = C.errFg;
        ctx.fillRect(zero, y, 22 + span - zero, barH);
      }
      // 0 dBFS rule — the wall the file cannot go past.
      ctx.fillStyle = C.border;
      ctx.fillRect(zero, y, 1, barH);
      // The true-peak line and its falling hold go on LAST, so they still read
      // where they matter most: inside the tip, on a take that went over.
      ctx.fillStyle = C.accent2;
      ctx.fillRect(22 + meterFrac(peakDb) * span - 1, y, 2, barH);
      ctx.fillStyle = C.accent;
      ctx.fillRect(22 + meterFrac(this.peakHoldDb[i]) * span - 1, y, 2, barH);
      // The channel letter is a blinkenlight, backing and all (lamp.js's look,
      // drawn on canvas): a colour change alone on two thin glyphs was not
      // something you could catch out of the corner of your eye.
      // Full brightness for most of the hold, then a quick fade — a lamp that
      // starts dimming immediately is a lamp you miss.
      const left = clamp((this.clipUntil[i] - now) / CLIP_HOLD_MS, 0, 1);
      const lit = clamp(left / CLIP_FADE_FRACTION, 0, 1);
      if (lit > 0) {
        ctx.fillStyle = mixInk(C.meterBg, C.errFg, lit);
        roundedRect(ctx, 2, y + barH / 2 - 8, 17, 16, 3);
      }
      ctx.fillStyle = lit > 0 ? mixInk(C.dim, C.bg, lit) : C.dim;
      ctx.fillText(labels[c], 7, y + barH - 6);
    }
    // Numeric peak readout under the bars.
    ctx.fillStyle = C.dim;
    ctx.textAlign = "left";
    const pl = dbfs(r.truePeak[this.stage * 2]);
    const pr = dbfs(r.truePeak[this.stage * 2 + 1]);
    ctx.fillText(`${t("mst.truePeakRead")}  L ${fmtDb(pl)}  R ${fmtDb(pr)} dBTP`, 22, h - 2);
  }

  drawReduction(C) {
    const box = this.ctxFor(this.grCanvas, 46);
    if (!box) return;
    const { ctx, w, h } = box;
    const rows = [
      [t("mst.comp"), -this.grComp, this.params.compOn],
      [t("mst.limiter"), -this.grLim, this.params.limOn],
    ];
    ctx.font = "10px system-ui, sans-serif";
    let y = 4;
    for (const [name, gr, on] of rows) {
      ctx.fillStyle = C.dim;
      ctx.textAlign = "left";
      ctx.fillText(name, 2, y + 12);
      const x0 = 62;
      const span = w - x0 - 42;
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(x0, y + 2, span, 12);
      if (on) {
        // Reduction grows RIGHT to LEFT: the bar eats into the signal.
        const frac = clamp(gr / GR_MAX_DB, 0, 1);
        ctx.fillStyle = C.accent;
        ctx.fillRect(x0 + span * (1 - frac), y + 2, span * frac, 12);
      }
      ctx.fillStyle = on ? C.fg : C.dim;
      ctx.textAlign = "right";
      ctx.fillText(on ? `−${gr.toFixed(1)} dB` : t("mst.bypassed"), w - 2, y + 12);
      y += 20;
    }
  }

  drawHistogram(C) {
    const box = this.ctxFor(this.histCanvas, 90);
    if (!box) return;
    const { ctx, w, h } = box;
    const audio = this.store.audio;
    const bins = audio ? audio.bitHistogram() : null;
    const total = this.readout.histTotal ?? 0;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(0, 0, w, h);
    if (!bins || total <= 0) {
      ctx.fillStyle = C.dim;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(t("mst.histIdle"), w / 2, h / 2);
      for (const k of Object.keys(this.bitCells)) this.bitCells[k].textContent = "—";
      return;
    }

    let peak = 0;
    for (let i = 0; i < 256; i++) if (bins[i] > peak) peak = bins[i];
    const bw = w / 256;
    ctx.fillStyle = C.meter;
    for (let i = 0; i < 256; i++) {
      if (bins[i] <= 0) continue;
      // Square root, not linear: a histogram of an audio signal is dominated by
      // the codes near silence, and a linear one is a single spike.
      const v = Math.sqrt(bins[i] / peak);
      ctx.fillRect(i * bw, h - v * (h - 12), Math.max(bw, 1), v * (h - 12));
    }
    // The middle code is digital silence; the two ends are full scale.
    const depth = this.readout.histDepth || this.bitDepth;
    const top = (1 << depth) - 1;
    const digits = depth >> 2;
    ctx.fillStyle = C.border;
    ctx.fillRect(128 * bw, 0, 1, h);
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("$" + "0".repeat(digits), 2, h - 2);
    ctx.textAlign = "right";
    ctx.fillText("$" + top.toString(16).toUpperCase().padStart(digits, "0"), w - 2, h - 2);

    // The FIGURES come from the engine, which walked the full-resolution census
    // — at 16 bits an exact `used` and `span` cannot be recovered from the 256
    // buckets this canvas draws.
    const r = this.readout;
    this.bitCells.span.textContent = fmtCount(r.histMax - r.histMin + 1);
    this.bitCells.used.textContent = fmtCount(r.histUsed);
    this.bitCells.eff.textContent = Math.log2(Math.max(1, r.histMax - r.histMin + 1)).toFixed(2);
    this.bitCells.ent.textContent = r.histEntropy.toFixed(2);
  }

  drawEqCurve(C, dt) {
    const box = this.ctxFor(this.eqCanvas, 110);
    if (!box) return;
    const { ctx, w, h } = box;
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    this.drawSpectrometer(ctx, w, h, C, dt);
    const SPAN = 18; // ±dB the plot shows
    const y0 = h / 2;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5); ctx.lineTo(w, y0 + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log(f / 20) / Math.log(20000 / 20)) * w;
      ctx.fillRect(x, 0, 1, h);
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, h - 2);
    }
    const { freq, db } = responseCurve(this.curveChain, 20, 20000, Math.max(64, Math.round(w)));
    ctx.strokeStyle = this.params.eqOn || this.params.hpOn ? C.accent : C.dim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < freq.length; i++) {
      const x = (i / (freq.length - 1)) * w;
      const y = y0 - clamp(db[i], -SPAN, SPAN) * (h / 2 / SPAN);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * The live spectrum, filled from the bottom of the EQ graph and coloured by
   * BAND — the same five inks the radiation surface and the soundfield cloud
   * use, so the same frequencies wear the same colour wherever you look at
   * them. It reads whichever side of the chain the pre/post switch is on.
   *
   * Bins are linear and the axis is logarithmic, so each column takes the LOUDEST
   * bin that falls in it: a peak that lands between two columns must not vanish,
   * and at the bottom of the range a column may own no bin at all and inherits
   * its neighbour's.
   */
  drawSpectrometer(ctx, w, h, C, dt) {
    const audio = this.store.audio;
    if (!audio) return;
    const cols = Math.max(1, Math.round(w));
    if (this.specCols === null || this.specCols.length !== cols) {
      this.specCols = new Float64Array(cols).fill(SPEC_MIN_DB);
      this.specBandOfCol = new Int8Array(cols);
      for (let x = 0; x < cols; x++) {
        const f = 20 * Math.exp((x / (cols - 1)) * Math.log(20000 / 20));
        let b = SPECTRUM_NBANDS - 1;
        for (let i = 0; i < SPECTRUM_NBANDS; i++) {
          if (f < SPECTRUM_BANDS[i].hi) { b = i; break; }
        }
        this.specBandOfCol[x] = b;
      }
    }
    const ring = audio.masterSpectrumRing(this.stage);
    const write = this.readout.specWrite | 0;
    // Nothing has been rendered yet: let the columns fall away rather than
    // freezing the last picture on screen.
    const live = this.readout.frames > 0 || audio.isPlaying();
    if (live) {
      spectrumDb(this.fft, this.specWin, this.specNorm, ring, write, this.specBins,
                 SPEC_MIN_DB - 24);
      // …then the display tilt, which is the whole reason the top of the band
      // is legible at all.
      for (let k = 1; k < this.specBins.length; k++) this.specBins[k] += this.specTiltDb[k];
    }
    const binHz = SAMPLING_RATE / SPEC_FRAMES;
    const nBins = this.specBins.length;
    const fall = (SPEC_RELEASE_DB_S * dt) / 1000;
    let prev = SPEC_MIN_DB;
    for (let x = 0; x < cols; x++) {
      let target = SPEC_MIN_DB;
      if (live) {
        // The bin range this column owns, on the log axis.
        const f0 = 20 * Math.exp(((x - 0.5) / (cols - 1)) * Math.log(20000 / 20));
        const f1 = 20 * Math.exp(((x + 0.5) / (cols - 1)) * Math.log(20000 / 20));
        const k0 = Math.max(1, Math.floor(f0 / binHz));
        const k1 = Math.min(nBins - 1, Math.ceil(f1 / binHz));
        if (k1 < k0) target = prev; // no bin of its own down here
        else for (let k = k0; k <= k1; k++) {
          if (this.specBins[k] > target) target = this.specBins[k];
        }
        prev = target;
      }
      const cur = this.specCols[x];
      this.specCols[x] = target > cur
        ? cur + (target - cur) * SPEC_ATTACK
        : Math.max(target, cur - fall);
    }
    // One filled path per band, so each gets its own ink in one fill.
    const span = SPEC_MAX_DB - SPEC_MIN_DB;
    const yOf = (db) => h - clamp((db - SPEC_MIN_DB) / span, 0, 1) * h;
    ctx.globalAlpha = 0.5;
    let x = 0;
    while (x < cols) {
      const b = this.specBandOfCol[x];
      let end = x;
      while (end + 1 < cols && this.specBandOfCol[end + 1] === b) end++;
      ctx.fillStyle = C[RAD_BANDS[b].ink];
      ctx.beginPath();
      ctx.moveTo(x, h);
      for (let i = x; i <= end; i++) ctx.lineTo(i, yOf(this.specCols[i]));
      ctx.lineTo(end, h);
      ctx.closePath();
      ctx.fill();
      x = end + 1;
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The offline SPECTRAL DISTRIBUTION: one column per 100 ms frame, the five
   * bands stacked as their share of that frame's energy, in the cloud's own
   * inks. It answers "where was the energy sitting, and when did that change" —
   * a bass-heavy passage is a tall salmon band, a bright one a tall violet one.
   *
   * Normalised per column, so it is a DISTRIBUTION and not a level: a quiet
   * passage has the same stack as a loud one with the same balance. The column's
   * opacity carries the level instead, so a silent tail fades out rather than
   * showing the shape of its own noise floor.
   */
  drawSpectrogram(ctx, w, h, pad, plotW, plotH, C, side) {
    const s = this.analysis[side];
    const nb = s.bandCount ?? SPECTRUM_NBANDS;
    const frames = s.bandSeries.length / nb;
    if (!(frames > 0)) return;
    let loudest = 0;
    for (let i = 0; i < frames; i++) {
      let t = 0;
      for (let b = 0; b < nb; b++) t += s.bandSeries[i * nb + b];
      if (t > loudest) loudest = t;
    }
    if (loudest <= 0) return;
    const colW = plotW / frames;
    for (let i = 0; i < frames; i++) {
      let total = 0;
      for (let b = 0; b < nb; b++) total += s.bandSeries[i * nb + b];
      if (total <= 0) continue;
      // −40 dB below the loudest frame is where a column has faded out.
      const lvl = clamp(1 + (10 * Math.log10(total / loudest)) / 40, 0, 1);
      let y = 2 + plotH;
      for (let b = 0; b < nb; b++) {
        const seg = (s.bandSeries[i * nb + b] / total) * plotH;
        ctx.globalAlpha = 0.25 + 0.75 * lvl;
        ctx.fillStyle = C[RAD_BANDS[b].ink];
        ctx.fillRect(pad + i * colW, y - seg, Math.max(colW, 1), seg + 0.5);
        y -= seg;
      }
    }
    ctx.globalAlpha = 1;
    // A key along the top. It sits OVER the stack, so it gets its own backing —
    // five short labels against five saturated colours are unreadable otherwise.
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    let width = 4;
    for (const band of SPECTRUM_BANDS) width += 12 + ctx.measureText(band.label).width + 8;
    // …and the tilt says so, right beside the colours it re-weighted. A display
    // that is tilted and does not admit it is a display that lies.
    const tiltTag = t("mst.tiltTag", { db: SPECTRUM_TILT_DB_PER_OCT });
    width += ctx.measureText(tiltTag).width + 8;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(pad, 2, Math.min(width, plotW), 13);
    ctx.globalAlpha = 1;
    let kx = pad + 4;
    for (let b = 0; b < nb; b++) {
      ctx.fillStyle = C[RAD_BANDS[b].ink];
      const label = SPECTRUM_BANDS[b].label;
      ctx.fillRect(kx, 5, 6, 6);
      ctx.fillStyle = C.fg;
      ctx.fillText(label, kx + 9, 11);
      kx += 12 + ctx.measureText(label).width + 8;
    }
    ctx.fillStyle = C.dim;
    ctx.fillText(tiltTag, kx, 11);
  }

  /** The offline time plot. One series at a time, over the whole song. */
  drawPlot() {
    const box = this.ctxFor(this.plotCanvas, 132);
    if (!box) return;
    const { ctx, w, h } = box;
    const C = themeColors();
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    const a = this.analysis;
    if (!a) {
      ctx.fillStyle = C.dim;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(t("mst.plotIdle"), w / 2, h / 2);
      return;
    }
    const spec = this.plotSpec();
    const pad = 26;
    const plotW = w - pad - 4;
    const plotH = h - 18;
    if (this.plotSeries === "spectrum") {
      // A distribution, not a level — so it is drawn for ONE side (the pre/post
      // switch picks it) rather than as a pre/post pair of lines.
      const side = this.stage === TAP_PRE ? "pre" : "post";
      this.drawSpectrogram(ctx, w, h, pad, plotW, plotH, C, side);
      ctx.fillStyle = C.dim;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      for (const [v, label] of [[0, "0%"], [0.5, "50%"], [1, "100%"]]) {
        ctx.fillText(label, pad - 3, 2 + (1 - v) * plotH + 3);
      }
      this.drawTimeAxis(ctx, w, h, pad, plotW, C);
      return;
    }
    // Both stages, always: the point of the plot is the DIFFERENCE the chain
    // made, and drawing one line at a time would hide it.
    for (const [side, colour, dash] of [["pre", C.dim, [3, 3]], ["post", spec.colour, null]]) {
      const series = spec.pick(a[side]);
      if (!series || series.length === 0) continue;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.4;
      ctx.setLineDash(dash ?? []);
      ctx.beginPath();
      for (let i = 0; i < series.length; i++) {
        const x = pad + (i / Math.max(1, series.length - 1)) * plotW;
        const v = clamp(Number.isFinite(series[i]) ? series[i] : spec.lo, spec.lo, spec.hi);
        const y = 2 + (1 - (v - spec.lo) / (spec.hi - spec.lo)) * plotH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Axes: value on the left, time along the bottom.
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "right";
    for (const v of spec.ticks) {
      const y = 2 + (1 - (v - spec.lo) / (spec.hi - spec.lo)) * plotH;
      ctx.fillRect(pad, y, plotW, 1);
      ctx.fillText(String(v), pad - 3, y + 3);
    }
    this.drawTimeAxis(ctx, w, h, pad, plotW, C);
    ctx.textAlign = "left";
    ctx.fillStyle = spec.colour;
    ctx.fillText(spec.label, pad + 2, 10);
  }

  /** Minutes:seconds along the bottom of the offline plot. */
  drawTimeAxis(ctx, w, h, pad, plotW, C) {
    const secs = this.analysis?.seconds ?? 0;
    if (!(secs > 0)) return;
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    const step = secs > 240 ? 60 : secs > 60 ? 30 : 10;
    for (let s = 0; s <= secs; s += step) {
      const x = pad + (s / secs) * plotW;
      ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, x, h - 4);
    }
  }

  /** Range, colour and picker for the selected plot series. */
  plotSpec() {
    const C = themeColors();
    switch (this.plotSeries) {
      case "peak":
        return {
          label: t("mst.plotPeak"), colour: C.accent2, lo: -48, hi: 6,
          ticks: [0, -12, -24, -36], pick: (s) => s.truePeakSeriesDb,
        };
      case "crest":
        return {
          label: t("mst.plotCrest"), colour: C.meter, lo: 0, hi: 24,
          ticks: [6, 12, 18], pick: (s) => s.crestSeriesDb,
        };
      case "gap":
        return {
          label: t("mst.plotGap"), colour: C.colPan, lo: 0, hi: 24,
          ticks: [6, 12, 18], pick: (s) => s.apCrestSeriesDb,
        };
      case "spectrum":
        // Drawn by drawSpectrogram, which has its own axis — this only names it.
        return {
          label: t("mst.plotSpectrum"), colour: C.fg, lo: 0, hi: 1,
          ticks: [], pick: () => null,
        };
      default:
        return {
          label: t("mst.plotLufs"), colour: C.accent, lo: -50, hi: 0,
          ticks: [-14, -23, -35], pick: (s) => s.shortTermLufs,
        };
    }
  }
}

