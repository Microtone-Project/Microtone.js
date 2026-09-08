// Master channel strip (item 98) — the mastering view, docked to the right of
// the Timeline grid: a stack of scope panels over one fader + meter.
//
// Everything it draws comes from the engine's analysis tap (src/engine/
// analysis.js) through the snapshot, and the two kinds of panel ask different
// questions of it:
//
//   * the SCOPES read the first-order B-format ring, so they show the sound
//     FIELD and never a particular speaker set. Their axes are literally the
//     field's own: left-right is Y, front-back is X, up-down is Z. A stereo
//     song has no front-back axis at all, so its vertical is the mono sum W —
//     which is exactly the classic mid/side goniometer, drawn by the same code.
//   * the METERS read a metering TARGET you pick, rendered through the same
//     renderers the exporter uses. What the bars say is what the file will hold.
//
// The fader is the SONG's global volume, not a monitor gain: effects V and W
// move it while the song plays and the cap follows them, but letting go of the
// mouse writes the project's value (one undo step per drag), and stopping
// playback snaps the cap back to it.
//
// ── Layout: one state, one reconciler ──
// A scope panel is a FIXED size — chooser, square dial, correlation bar — set
// by the strip's width, so how many of them fit is a question about the
// viewport's height, and the meter takes whatever they leave.
//
// `layout()` is the ONLY place that decides any of it. Adding a panel, closing
// one, dragging the divider, resizing the window and loading a song all end
// there, and when it returns `this.scopes` is the panels, `this.drawn` is how
// many are up, and the meter's height follows from that. Nothing keeps a
// second opinion, because two opinions is how this went wrong: a `fit` computed
// in one place and a panel list edited in another disagreed the moment either
// changed, so the strip believed in three panels while showing six, "+" refused
// to add a fourth, and a resize "fixed" it by accident.
//
// The COUNT is that state, and everything is expressed as setting it: "+" is
// one more, the chooser's "hide this panel" is one fewer, and the divider — a
// fixed panel size means where it sits and how many panels are above it are the
// same fact — drags straight to a count, closing panels on the way down and
// opening them on the way up. (The ✕ in the header hides the whole strip.)

import {
  ANALYSIS_OFF, ANALYSIS_STEREO, ANALYSIS_AMBISONIC,
  SCOPE_FRAMES, SCOPE_CHANNELS, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
  availableTargets, meterDisplay, makeAnalysisReadout,
} from "../../engine/analysis.js";
import {
  SURROUND_STEREO, SURROUND_SPATIAL, directionFromAngles,
} from "../../engine/spatial.js";
import { SAMPLING_RATE } from "../../engine/constants.js";
import { setSongScalarOp } from "../../doc/ops.js";
import { themeColors } from "../theme.js";
import { paintSpatialDot } from "../spatialdot.js";
import { CrtBeam, beamCoreInk } from "../crtbeam.js";
import {
  RAD_BANDS, RAD_VIEWS, RadiationField, RadiationView, srgbToLinear,
} from "../radiation.js";
import { CloudField, CloudView } from "../cloud.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

const PREF_KEY = "microtone-masterstrip";

/** Scratch for the blob dials' direction vectors — one per frame, not per dot. */
const dirScratch = new Float64Array(3);
/** Scratch for one panel's projected trace, refilled per panel per frame. */
const traceX = new Float32Array(SCOPE_FRAMES);
const traceY = new Float32Array(SCOPE_FRAMES);

/**
 * Scope kinds — three families over the same three views of the same space
 * (top, front and side), so any two panels sit side by side on matching axes
 * and answer different questions about the same moment:
 *
 *   * BLOBS draws the SOURCES: one dot per sounding channel, where the engine
 *     has it.
 *   * TOP/FRONT/SIDE are the goniometers: the SOUND, as a pair of the field's
 *     own axes.
 *   * RAD is the radiation monitor (item 129, src/ui/radiation.js): the whole
 *     coherent field as one spectrally-coloured solid.
 *
 * HIDE is the chooser's own "drop this panel" entry.
 */
export const SCOPE_BLOBS = "blobs";
export const SCOPE_BLOBS_FRONT = "blobsfront";
export const SCOPE_BLOBS_SIDE = "blobsside";
export const SCOPE_TOP = "top";
export const SCOPE_FRONT = "front";
export const SCOPE_SIDE = "side";
export const SCOPE_RAD = "rad";
export const SCOPE_RAD_FRONT = "radfront";
export const SCOPE_RAD_SIDE = "radside";
export const SCOPE_CLOUD = "cloud";
export const SCOPE_CLOUD_FRONT = "cloudfront";
export const SCOPE_CLOUD_SIDE = "cloudside";
export const SCOPE_HIDE = "hide";

/** Meter scale, in dBFS. Above 0 exists because an object bus is not clamped. */
export const METER_MIN_DB = -60;
export const METER_MAX_DB = 6;

/** Panel geometry (CSS px). The chooser and correlation bar are fixed; the dial
 *  is square, so the strip's WIDTH decides a scope panel's height. */
export const SCOPE_SELECT_H = 22;
export const SCOPE_CORR_H = 9;
export const SPLIT_H = 7;
export const METER_MIN_H = 112;
/** How many scope panels a strip that has never been configured starts with,
 *  and what the divider's double-click puts back. */
export const DEFAULT_PANELS = 2;
/** The strip's own padding, top and bottom (CSS .master-strip). */
export const STRIP_PAD = 4;

/** Time constant of the vectorscope auto-gain, both directions. Long enough
 *  that the dial BREATHES with the music instead of snapping at every
 *  transient — the trace's shape is the reading, and a gain that jumps makes
 *  shapes impossible to compare from one moment to the next. */
export const SCOPE_GAIN_SLEW_MS = 300;
/** How much of the dial's radius the auto-gain aims to fill. */
export const SCOPE_GAIN_FILL = 0.92;
/**
 * …taken back by this much, because the peak it divides by is a B-FORMAT
 * COMPONENT and not the delivered mix. A mono full-scale mix peaks at √2 in W,
 * but a hard-panned or wide one peaks at only ~0.71 in W and Y alike — so the
 * bare fill target asks for 1.3× on material that is already clipping, which is
 * the one case where the gain has to be 1. The headroom pulls that back under
 * the floor, and costs every other reading a fifth of its size.
 */
export const SCOPE_GAIN_HEADROOM = 0.7;
/** Ceiling, so a near-silent passage does not amplify the dither into a disc. */
export const SCOPE_GAIN_MAX = 64;
/**
 * Correlation is a STATISTIC, and one snapshot interval (~16 ms) is far too
 * short a sample of one: read that raw and the bar dances on every transient
 * while telling you nothing. The sums are integrated over this much audio
 * first — near enough a bar of music — and the result is then slewed, so the
 * bar moves at the speed of the mix rather than the speed of the frame rate.
 */
export const CORR_INTEGRATE_MS = 600;
export const CORR_SLEW_MS = 150;

// ── pure helpers (unit-tested in test/node/analysis.test.js) ───────────────

/**
 * The gain a window that peaked at `peak` asks for: enough to fill the dial,
 * never below 1 (the scope is a magnifier, and shrinking a mix that already
 * fills the dial would only hide how wide it is), never above the ceiling.
 */
export function scopeAutoGain(peak) {
  const want = (SCOPE_GAIN_FILL * SCOPE_GAIN_HEADROOM) / Math.max(peak, 1e-4);
  return Math.max(1, Math.min(want, SCOPE_GAIN_MAX));
}

/** Amplitude → dBFS, with a floor rather than −Infinity. */
export function dbfs(v) {
  const a = v < 0 ? -v : v;
  return a <= 0 ? METER_MIN_DB - 1 : 20 * Math.log10(a);
}

/** dBFS → 0 (bottom of the scale) … 1 (top), clamped. */
export function meterFrac(db) {
  const f = (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Phase correlation of the interval's sums: +1 identical, 0 uncorrelated, −1
 * anti-phase. Silence reads +1 (nothing wrong with it) rather than 0/0.
 */
export function correlation(ll, rr, lr) {
  const d = Math.sqrt(ll * rr);
  if (!(d > 1e-20)) return 1;
  const c = lr / d;
  return c < -1 ? -1 : c > 1 ? 1 : c;
}

/** Height of one scope panel in a strip whose panels are `width` px wide. */
export function scopePanelHeight(width) {
  return SCOPE_SELECT_H + Math.max(48, width) + SCOPE_CORR_H;
}

/**
 * How many scope panels fit above a meter panel of `meterH` — pure geometry,
 * with no upper limit of its own. What you actually get is this against the
 * number of views the song HAS: min(what fits, what there is to show).
 */
export function scopePanelsThatFit(stripH, headH, meterH, panelH) {
  if (!(panelH > 0)) return 0;
  return Math.max(0, Math.floor((stripH - headH - meterH - SPLIT_H) / panelH));
}

/** "#rgb" / "#rrggbb" / "rgb(…)" → [r, g, b]; anything else → mid grey. */
export function parseInk(css) {
  const s = String(css ?? "").trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
    if (h.length >= 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((x) => parseInt(x, 10));
    if (p.length >= 3 && p.every((x) => Number.isFinite(x))) return p.slice(0, 3);
  }
  return [128, 128, 128];
}

/**
 * One display frame of an exponential approach to `want`, so the result after a
 * given stretch of TIME is the same however many frames it was cut into — the
 * display moves at the same speed on a 30 fps machine as on a 144 fps one.
 */
export function slewTowards(prev, want, dtMs, tauMs) {
  if (!(dtMs > 0)) return prev;
  return prev + (want - prev) * (1 - Math.exp(-dtMs / tauMs));
}

/**
 * Fold one interval's correlation sums into an exponentially-weighted running
 * pair and read the correlation off THAT — a proper windowed statistic rather
 * than 16 ms of guesswork. `sums` is mutated; `frames` is what the interval
 * covered, so the window is a length of AUDIO and does not change with the
 * frame rate or with how the host chunks its rendering.
 */
export function integrateCorrelation(sums, ll, rr, lr, frames, tauMs = CORR_INTEGRATE_MS) {
  const k = Math.exp(-frames / ((tauMs / 1000) * SAMPLING_RATE));
  sums.ll = sums.ll * k + ll;
  sums.rr = sums.rr * k + rr;
  sums.lr = sums.lr * k + lr;
  return correlation(sums.ll, sums.rr, sums.lr);
}

/**
 * Every scope kind, in the order a newly added panel is offered one. The two
 * extra blob views come last on purpose: they are a CHOICE, not something the
 * strip hands you on its own.
 */
export const SCOPE_KINDS = [
  SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD, SCOPE_FRONT, SCOPE_SIDE,
  SCOPE_RAD_FRONT, SCOPE_RAD_SIDE, SCOPE_CLOUD_FRONT, SCOPE_CLOUD_SIDE,
  SCOPE_BLOBS_FRONT, SCOPE_BLOBS_SIDE,
];

/**
 * How many scope panels can exist. There is no arbitrary limit: a panel per
 * view is as many as there is anything to see, so the number of KINDS is the
 * bound (the height decides the rest — see scopePanelsThatFit). The DOM panels
 * are built once to this size and shown or hidden.
 */
export const MAX_SCOPE_PANELS = SCOPE_KINDS.length;

/**
 * Which scope kinds a surround model can express, in chooser order (each family
 * whole, in the order they were added). Z is identically zero unless the song
 * is spatial, so every vertical-plane view would be a flat line — item 98's
 * "nonsensical options are hidden".
 *
 * The radiation monitor's top view survives the cut on a stereo song and earns
 * its place there: with no X and no Z the surface becomes a figure of
 * revolution about the left-right axis, which is a sphere for mono, a cardioid
 * for a hard pan, and a figure of eight with a null through the middle for an
 * anti-phase pair — the phase reading, as a shape.
 */
export function availableScopes(model) {
  return model === SURROUND_SPATIAL
    ? [SCOPE_BLOBS, SCOPE_BLOBS_FRONT, SCOPE_BLOBS_SIDE, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE,
      SCOPE_RAD, SCOPE_RAD_FRONT, SCOPE_RAD_SIDE,
      SCOPE_CLOUD, SCOPE_CLOUD_FRONT, SCOPE_CLOUD_SIDE]
    : [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD];
}

/** Which plane a blobs kind is drawn in, or null if it is not a blobs kind. */
export function blobView(kind) {
  switch (kind) {
    case SCOPE_BLOBS: return "top";
    case SCOPE_BLOBS_FRONT: return "front";
    case SCOPE_BLOBS_SIDE: return "side";
    default: return null;
  }
}

/** Which camera a cloud kind is drawn through, or null if it is not one. */
export function cloudView(kind) {
  switch (kind) {
    case SCOPE_CLOUD: return "top";
    case SCOPE_CLOUD_FRONT: return "front";
    case SCOPE_CLOUD_SIDE: return "side";
    default: return null;
  }
}

/** Which camera a radiation kind is drawn through, or null if it is not one. */
export function radView(kind) {
  switch (kind) {
    case SCOPE_RAD: return "top";
    case SCOPE_RAD_FRONT: return "front";
    case SCOPE_RAD_SIDE: return "side";
    default: return null;
  }
}

/**
 * The four edge labels for any kind. A blobs or radiation dial is a MAP, so its
 * labels are the directions themselves; the Goniometer kinds carry theirs on
 * the axes they plot. All three families use the same screen orientation per
 * plane, which is what lets any two panels sit next to each other and agree.
 */
export function scopeLabels(kind, stereoSong) {
  const axes = scopeAxes(kind, stereoSong);
  if (axes) return axes;
  switch (blobView(kind) ?? radView(kind) ?? cloudView(kind)) {
    case "front": return { left: "L", right: "R", top: "U", bottom: "D" };
    case "side": return { left: "F", right: "B", top: "U", bottom: "D" };
    default: return { left: "L", right: "R", top: "F", bottom: "B" };
  }
}

/**
 * What each panel actually SHOWS, given what the user asked for — one entry per
 * wish, `null` where the panel cannot be shown at all.
 *
 * `scopes` is a list of WISHES and is never rewritten: the strip is built
 * before any song is loaded (so the model reads stereo) and the song can change
 * model later, and a panel asking for the side view must still be asking for it
 * when a spatial song finally arrives. Overwriting the wishes was the bug where
 * four configured panels came back from a reload as several copies of one view.
 *
 * There is never more than ONE PANEL PER VIEW the song has: a stereo or planar
 * song has exactly two things worth looking at, so it draws at most two panels
 * however many are configured (a duplicate would only tell you what the panel
 * beside it already does). A wish the model cannot express falls back to the
 * first view no earlier panel is showing; once the views are used up, the
 * remaining panels are dropped (null) and wait for a song that has more.
 */
export function effectiveScopes(scopes, model) {
  const kinds = availableScopes(model);
  const out = [];
  let drawn = 0;
  for (const wish of scopes) {
    if (drawn >= kinds.length) { out.push(null); continue; }
    const kind = kinds.includes(wish) ? wish : kinds.find((k) => !out.includes(k));
    if (kind === undefined) out.push(null);
    else { out.push(kind); drawn++; }
  }
  return out;
}

/**
 * The B-format components a Goniometer kind plots, as {h, v} ring indices, plus
 * the labels for the four edges. `stereoSong` swaps the top view's vertical
 * from front-back (which it does not have) to the mono sum.
 */
export function scopeAxes(kind, stereoSong) {
  switch (kind) {
    case SCOPE_TOP:
      return stereoSong
        ? { h: SCOPE_Y, v: SCOPE_W, left: "L", right: "R", top: "M", bottom: "−M" }
        : { h: SCOPE_Y, v: SCOPE_X, left: "L", right: "R", top: "F", bottom: "B" };
    case SCOPE_FRONT:
      return { h: SCOPE_Y, v: SCOPE_Z, left: "L", right: "R", top: "U", bottom: "D"};
    case SCOPE_SIDE:
      return { h: SCOPE_X, v: SCOPE_Z, left: "F", right: "B", top: "U", bottom: "D" };
    default:
      return null;
  }
}

/**
 * Meter ballistics — one channel's moving state. The engine ships sums per
 * snapshot interval; the LOOK (integration, peak hold and fall, clip hold) is
 * the display's business and lives here.
 */
export class MeterBallistics {
  constructor() { this.reset(); }

  reset() {
    this.rms = 0;        // mean square, leaky-integrated
    this.peakDb = METER_MIN_DB - 1;
    this.holdMs = 0;
    this.clipped = false;
  }

  /** Clear the clip latch. Only a fresh playback does this — see `update`. */
  clearClip() { this.clipped = false; }

  /**
   * @param {number} meanSquare mean square over the interval
   * @param {number} peak       true peak over the interval (amplitude)
   * @param {boolean} clipped   any sample at/over full scale
   * @param {number} dtMs       wall time since the previous update
   */
  update(meanSquare, peak, clipped, dtMs) {
    // ~300 ms RMS window, frame-rate independent.
    const a = 1 - Math.exp(-dtMs / 300);
    this.rms += (meanSquare - this.rms) * a;
    const db = dbfs(peak);
    if (db >= this.peakDb) {
      this.peakDb = db;
      this.holdMs = 1200;
    } else if (this.holdMs > 0) {
      this.holdMs -= dtMs;
    } else {
      this.peakDb -= (dtMs / 1000) * 20; // 20 dB/s fall
    }
    if (this.peakDb < METER_MIN_DB - 1) this.peakDb = METER_MIN_DB - 1;
    // The clip lamp LATCHES: one clipped sample anywhere in a take is something
    // you have to be told about, and a lamp that times out is one you can miss
    // while looking at the grid. Starting playback again clears it.
    if (clipped) this.clipped = true;
  }

  rmsDb() { return dbfs(Math.sqrt(this.rms)); }
  clipping() { return this.clipped; }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private mode / corrupt */ }
  return {};
}

// ── the strip ─────────────────────────────────────────────────────────────

export class MasterStrip {
  constructor(store, el) {
    this.store = store;
    this.el = el;
    const p = loadPrefs();
    this.visible = p.visible !== false; // item 98: visible by default
    this.scopes = Array.isArray(p.scopes) && p.scopes.length
      ? p.scopes.slice(0, MAX_SCOPE_PANELS)
      : [SCOPE_BLOBS, SCOPE_TOP];
    // Default chosen so two scope panels and a usable meter fit an ordinary
    // window; the divider moves it from there.
    this.savedTarget = p.target ?? null;
    this.target = ANALYSIS_STEREO;

    this.readout = makeAnalysisReadout();
    this.meters = Array.from({ length: 10 }, () => new MeterBallistics());
    this.field = new MeterBallistics();
    this.corr = 1;
    this.corrSums = { ll: 0, rr: 0, lr: 0 }; // exponentially-weighted window
    // Derived by layout(), and by nothing else: what each panel shows, the
    // panel → entry map, and how many are on screen. Empty until the strip has
    // been measured — a guess here is what once drew six panels in a box with
    // room for three.
    this.effective = [];
    this.slots = [];
    this.drawn = 0;
    this._kindsSig = null;
    this._prefSig = null;
    this._wasPlaying = false;
    this.scopeGain = new Array(MAX_SCOPE_PANELS).fill(1); // auto-gain per panel
    this.beams = new Array(MAX_SCOPE_PANELS).fill(null);  // CRT beam per panel
    // The radiation family (item 129): ONE field, however many cameras are
    // looking at it, and none at all until a panel asks for one.
    this.radField = null;
    this.radCells = new Array(MAX_SCOPE_PANELS).fill(null);
    // The cloud family (item 133): likewise one image, many cameras.
    this.cloudField = null;
    this.cloudCells = new Array(MAX_SCOPE_PANELS).fill(null);
    this._radInkSig = null;
    this._radBandLin = null;
    // The scopes draw the samples that arrived SINCE THE LAST FRAME and let the
    // phosphor hold the rest, so the strip has to remember where in the ring it
    // stopped. −1 is "no idea", which draws nothing and joins nothing.
    this._lastWrite = -1;
    this.freshFrames = 0;
    this.traceGap = true;
    this.lastMs = 0;
    this._tapAudio = null;
    this._tapTarget = null;
    this._drag = null;
    this._split = null;
    this._wheelGesture = null;
    this._wheelAt = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.onToggle = null; // set by the shell so the toolbox button can follow

    this.build();
    store.on("doc", () => { this.pickTarget(); this.refreshControls(); this.applyVisibility(); });
    store.on("view", () => this.applyVisibility());
    // The surround model decides which targets and which scopes exist at all.
    store.on("edit", (tags) => {
      if (tags?.some?.((tag) => tag.kind === "scalar" && tag.key === "surroundModel")) {
        this.pickTarget();
        this.refreshControls();
      }
    });
    this.pickTarget();
    this.refreshControls();
    this.applyVisibility();
  }

  // ── DOM ──

  build() {
    this.el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "ms-head";
    this.head = head;
    const title = document.createElement("span");
    title.className = "ms-title";
    title.textContent = t("master.title");
    this.addBtn = document.createElement("button");
    this.addBtn.className = "icon-btn";
    this.addBtn.textContent = "+";
    this.addBtn.title = t("master.addTitle");
    this.addBtn.addEventListener("click", () => this.addScope());
    const close = document.createElement("button");
    close.className = "icon-btn";
    setIconLabel(close, "close");
    close.title = t("master.hideTitle");
    close.addEventListener("click", () => this.setVisible(false));
    head.append(title, this.addBtn, close);
    this.el.appendChild(head);

    this.scopePanel = [];
    this.scopeCanvas = [];
    this.scopeSel = [];
    for (let i = 0; i < MAX_SCOPE_PANELS; i++) {
      const box = document.createElement("div");
      box.className = "ms-scope";
      const sel = document.createElement("select");
      sel.className = "ms-mode";
      sel.addEventListener("change", () => {
        // `i` is the panel's place on screen; the wish it edits is slots[i].
        const wish = this.slots?.[i] ?? i;
        if (sel.value === SCOPE_HIDE) { // drops THIS panel, not the strip
          this.removeScope(wish);
          return;
        }
        this.scopes[wish] = sel.value;
        this.layout();
      });
      const wrap = document.createElement("div");
      wrap.className = "ms-canvaswrap";
      const cv = document.createElement("canvas");
      wrap.appendChild(cv);
      box.append(sel, wrap);
      this.el.appendChild(box);
      this.scopePanel.push(box);
      this.scopeCanvas.push(cv);
      this.scopeSel.push(sel);
    }

    // The divider doubles as the separator above the meter and its resize grip.
    this.split = document.createElement("div");
    this.split.className = "ms-split";
    this.split.title = t("master.splitTitle");
    this.split.addEventListener("pointerdown", (e) => this.onSplitDown(e));
    this.split.addEventListener("pointermove", (e) => this.onSplitMove(e));
    this.split.addEventListener("pointerup", (e) => this.onSplitUp(e));
    this.split.addEventListener("pointercancel", (e) => this.onSplitUp(e));
    this.split.addEventListener("dblclick", () => this.setPanelCount(DEFAULT_PANELS));
    this.el.appendChild(this.split);

    const mbox = document.createElement("div");
    mbox.className = "ms-meterbox";
    const mwrap = document.createElement("div");
    mwrap.className = "ms-canvaswrap";
    this.meterCanvas = document.createElement("canvas");
    mwrap.appendChild(this.meterCanvas);
    // Item 98 note 4: the metering chooser belongs to the meter, at its foot.
    this.targetSel = document.createElement("select");
    this.targetSel.className = "ms-target";
    this.targetSel.title = t("master.targetTitle");
    this.targetSel.addEventListener("change", () => {
      this.target = this.targetSel.value;
      this.savedTarget = this.target;
      this.resetMeters();
      this.savePrefs();
      this.syncTap();
    });
    mbox.append(mwrap, this.targetSel);
    this.el.appendChild(mbox);
    this.meterBox = mbox;

    this.meterCanvas.addEventListener("pointerdown", (e) => this.onFaderDown(e));
    this.meterCanvas.addEventListener("pointermove", (e) => this.onFaderMove(e));
    this.meterCanvas.addEventListener("pointerup", (e) => this.onFaderUp(e));
    this.meterCanvas.addEventListener("pointercancel", (e) => this.onFaderUp(e));
    this.meterCanvas.addEventListener("dblclick", (e) => {
      if (this.faderHit(e)) this.writeVolume(0x80, null);
    });
    this.meterCanvas.addEventListener("wheel", (e) => {
      if (!this.faderHit(e)) return;
      e.preventDefault();
      const step = e.shiftKey ? 8 : 1;
      // A run of wheel clicks is one gesture, so it undoes in one go.
      const now = Date.now();
      if (this._wheelGesture === null || now - this._wheelAt > 600) this._wheelGesture = `wheel:${now}`;
      this._wheelAt = now;
      this.writeVolume(this.volumeValue() + (e.deltaY < 0 ? step : -step), this._wheelGesture);
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  /** Scope panels on screen. Set by layout, which is the only thing that
   *  decides it — never re-derived here, and never a guess before the strip has
   *  been measured (that guess is what once put six panels in a box with room
   *  for three). */
  panelCount() { return this.drawn; }

  /** "+" — one more panel, taking its room from the meter. */
  addScope() { this.setPanelCount(this.drawn + 1); }

  /** "Hide this panel" — close the panel that entry `i` belongs to. */
  removeScope(i) {
    this.scopes.splice(i, 1);
    this.layout();
  }

  /**
   * The song's model changed what can be metered and what can be seen: rebuild
   * the target chooser, mark the scope choosers for a rebuild, and reconcile.
   */
  refreshControls() {
    const model = this.model();
    const targets = availableTargets(model);
    this.targetSel.innerHTML = "";
    for (const id of targets) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = t(`master.target.${id}`);
      this.targetSel.appendChild(o);
    }
    this.targetSel.value = this.target;
    this.targetSel.disabled = targets.length < 2;
    this._kindsSig = null; // the scope choosers' options follow the model
    this.layout();
  }

  /** Point each visible panel's chooser at the view that panel is showing.
   *  Called by layout — the choosers are a VIEW of the state, never its owner. */
  syncChoosers(model) {
    const kinds = availableScopes(model);
    const sig = kinds.join();
    const rebuild = sig !== this._kindsSig;
    this._kindsSig = sig;
    for (let p = 0; p < this.drawn; p++) {
      const sel = this.scopeSel[p];
      // `rebuild` alone once left a freshly-added panel's <select> with no
      // <option>s at all: it only fires when the KINDS signature changes, but
      // a panel's own chooser is built once, in the constructor, with none —
      // "+"-ing a new panel into an unchanged model skipped it forever (item
      // 175). A panel with nothing in it yet always needs the fill, whatever
      // the signature did.
      if (rebuild || sel.options.length === 0) {
        sel.innerHTML = "";
        for (const k of [...kinds, SCOPE_HIDE]) {
          const o = document.createElement("option");
          o.value = k;
          o.textContent = t(`master.scope.${k}`);
          sel.appendChild(o);
        }
      }
      const kind = this.effective[this.slots[p]];
      sel.value = kind;
      // The radiation panel's colour key is five unlabelled swatches — small
      // enough to live in the dial's corner, which means the band edges
      // themselves have to be readily accessible rather than always visible.
      const key = radView(kind) !== null ? "master.scope.radKey"
        : cloudView(kind) !== null ? "master.scope.cloudKey" : null;
      this.scopeCanvas[p].title = key === null ? ""
        : `${t(key)}: ${RAD_BANDS.map((b) => b.label).join(" · ")}`;
    }
  }

  /** Default metering target for a freshly loaded song, or the saved one. */
  pickTarget() {
    const targets = availableTargets(this.model());
    if (this.savedTarget && targets.includes(this.savedTarget)) {
      this.target = this.savedTarget;
    } else {
      const m = this.model();
      this.target = m === SURROUND_STEREO ? ANALYSIS_STEREO
        : m === SURROUND_SPATIAL ? ANALYSIS_AMBISONIC : "5.1";
    }
    this.resetMeters();
    this.syncTap();
  }

  model() {
    return this.store.doc?.songs[this.store.songIndex]?.surroundModel ?? SURROUND_STEREO;
  }

  savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        visible: this.visible, scopes: this.scopes, target: this.savedTarget,
      }));
    } catch { /* private mode */ }
  }

  resetMeters() {
    for (const m of this.meters) m.reset();
    this.field.reset();
    this.corr = 1;
    this.corrSums.ll = this.corrSums.rr = this.corrSums.lr = 0;
  }

  /** The one thing that puts the clip lamps out: starting playback again. */
  clearClips() {
    for (const m of this.meters) m.clearClip();
    this.field.clearClip();
  }

  setVisible(on) {
    this.visible = on;
    this.savePrefs();
    this.applyVisibility();
    this.onToggle?.(on);
  }

  toggle() { this.setVisible(!this.visible); return this.visible; }

  /** The strip is a Timeline fixture; anywhere else it is neither shown nor
   *  paid for. With the view split (item 148) it is enough for EITHER pane to
   *  be showing the Timeline — the strip sits beside the whole split, not
   *  inside a pane, so it keeps the right-hand edge either way. */
  applyVisibility() {
    const show = this.visible && this.store.viewOpen("timeline") && !!this.store.doc;
    this.el.hidden = !show;
    this.shown = show;
    if (show) this.resize();
    // A hidden strip stops consuming the ring, so what it knows about the beam
    // goes stale: wipe the screens rather than come back with a frozen trace
    // from whenever it was last on, and pick the ring up fresh.
    if (!show) this.resetBeams();
    this.syncTap();
  }

  /** Blank every scope's phosphor and forget where in the ring the beam was. */
  resetBeams() {
    for (const cell of this.beams) cell?.beam.clear();
    for (const cell of this.cloudCells) cell?.view.clear();
    this.radField?.reset();
    this.cloudField?.reset();
    this._lastWrite = -1;
    this.freshFrames = 0;
    this.traceGap = true;
  }

  /**
   * Install or drop the engine-side tap. Called whenever anything that decides
   * it changes — including a new AudioSystem, which the frame loop notices.
   */
  syncTap() {
    const audio = this.store.audio;
    const want = this.shown ? this.target : ANALYSIS_OFF;
    if (!audio) { this._tapAudio = null; this._tapTarget = null; return; }
    if (this._tapAudio === audio && this._tapTarget === want) return;
    audio.setAnalysis(0, want);
    this._tapAudio = audio;
    this._tapTarget = want;
  }

  // ── layout ──

  /**
   * THE reconcile step. Everything that can change the strip's shape — adding a
   * panel, hiding one, dragging the divider, resizing the window, loading a
   * song — ends here, and when it returns the strip's state IS what is on
   * screen. There is no second opinion to go stale: `this.scopes` is the panels,
   * `this.drawn` is how many are up, and the meter's height is a function of
   * that rather than a number of its own that could disagree.
   *
   * Two rules decide the count:
   *   * GEOMETRY IS AUTHORITATIVE, and destructive. A panel the height can no
   *     longer hold has been REMOVED — dragging the divider down over a panel
   *     is how you close it, and it does not come back on its own. One panel
   *     always survives, so shrinking the window to nothing cannot wipe the
   *     strip.
   *   * THE MODEL IS NOT. A panel set to a view this song cannot express waits
   *     (drawn as null by effectiveScopes) and returns intact for a song that
   *     can — losing those was a real bug once, see effectiveScopes.
   *
   * The meter is the only elastic panel: it takes whatever the panels leave, so
   * the divider is always exactly where the count says it is.
   */
  /**
   * The strip's measurements, or null while it is hidden (nothing to reconcile
   * against, and a zero height would "close" panels nobody closed).
   * `capacity` is the most panels the column can hold while the meter keeps its
   * minimum — the geometric ceiling on the count.
   */
  geometry() {
    // clientHeight/Width include the strip's own padding; the panels do not.
    const stripH = this.el.clientHeight - STRIP_PAD * 2;
    const width = this.el.clientWidth - STRIP_PAD * 2;
    if (stripH <= 0 || width <= 0) return null;
    const headH = this.head.offsetHeight;
    const panelH = scopePanelHeight(width);
    const capacity = scopePanelsThatFit(stripH, headH, METER_MIN_H, panelH);
    return { stripH, width, headH, panelH, capacity };
  }

  layout() {
    const g = this.geometry();
    if (g === null) return;
    const model = this.model();

    // Derive what is on screen, then let the GEOMETRY close whatever the column
    // can no longer hold. Only DRAWN panels count against the capacity: a panel
    // waiting for a song that can show its view takes up no room and is not
    // closed by a resize.
    this.derive(model);
    while (this.slots.length > g.capacity) {
      this.scopes.splice(this.slots[this.slots.length - 1], 1);
      this.derive(model);
    }
    this.drawn = this.slots.length;

    for (let p = 0; p < MAX_SCOPE_PANELS; p++) {
      const box = this.scopePanel[p];
      box.hidden = p >= this.drawn;
      box.style.height = `${g.panelH}px`;
    }
    // The meter is the elastic panel: its height is a FUNCTION of the count,
    // never a stored number that could disagree with it.
    this.meterBox.style.height =
      `${g.stripH - g.headH - SPLIT_H - this.drawn * g.panelH}px`;

    this.addBtn.hidden = this.nextScope(model) === null;
    this.resizeCanvases();
    this.syncChoosers(model);
    this.savePrefsIfChanged();
  }

  /** What each panel shows, and the panel → entry map. */
  derive(model) {
    this.effective = effectiveScopes(this.scopes, model);
    this.slots = this.effective
      .map((kind, i) => (kind === null ? -1 : i))
      .filter((i) => i >= 0);
  }

  /**
   * The view a new panel would take, or null if one cannot be added: no room
   * left in the column, or no view this song has that is not already up.
   */
  nextScope(model = this.model()) {
    const g = this.geometry();
    if (g === null || this.scopes.length >= MAX_SCOPE_PANELS) return null;
    if (this.slots.length >= g.capacity) return null;
    const next = SCOPE_KINDS.find((k) => !this.scopes.includes(k)) ?? SCOPE_TOP;
    const would = effectiveScopes([...this.scopes, next], model)
      .filter((k) => k !== null).length;
    return would > this.slots.length ? next : null;
  }

  /**
   * Make exactly `n` panels be on screen — the one operation behind "+",
   * "hide this panel" and the divider, so all three agree by construction.
   * Bounded by the column's capacity and by how many views the song has.
   */
  setPanelCount(n) {
    for (let guard = 0; guard <= MAX_SCOPE_PANELS; guard++) {
      if (this.drawn === n) break;
      if (this.drawn < n) {
        const next = this.nextScope();
        if (next === null) break;
        this.scopes.push(next);
      } else {
        this.scopes.splice(this.slots[this.drawn - 1], 1);
      }
      this.layout();
    }
  }

  /** Persist only when the state actually moved — a drag lays out every frame. */
  savePrefsIfChanged() {
    const sig = `${this.scopes.join()}|${this.visible}|${this.savedTarget}`;
    if (sig === this._prefSig) return;
    this._prefSig = sig;
    this.savePrefs();
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.layout();
  }

  resizeCanvases() {
    const dpr = this.dpr;
    for (const cv of [...this.scopeCanvas, this.meterCanvas]) {
      const host = cv.parentElement;
      const w = Math.max(20, host.clientWidth);
      const h = Math.max(20, host.clientHeight);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + "px";
        cv.style.height = h + "px";
      }
    }
  }

  // ── the meter/scope divider ──

  onSplitDown(e) {
    this._split = this.el.getBoundingClientRect();
    this.split.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  /**
   * The divider IS the panel count — scope panels are a fixed size, so where it
   * sits and how many panels are above it are the same fact. Dragging it down
   * closes panels, dragging it up opens them again (taking the next view the
   * song has), and it lands on the boundary nearest the pointer. The meter
   * takes whatever is left, which is why there is no meter height to keep in
   * step with anything.
   */
  onSplitMove(e) {
    if (this._split === null) return;
    const g = this.geometry();
    if (g === null) return;
    const y = e.clientY - this._split.top - STRIP_PAD;
    this.setPanelCount(Math.max(0, Math.round((y - g.headH) / g.panelH)));
  }

  onSplitUp(e) {
    if (this._split === null) return;
    this._split = null;
    this.split.releasePointerCapture?.(e.pointerId);
  }

  // ── fader ──

  /** Fader geometry in CSS pixels, shared by the painter and the hit test. */
  faderRect() {
    const h = this.meterCanvas.height / this.dpr;
    return { x: 4, y: 18, w: 22, h: Math.max(20, h - 38) };
  }

  faderHit(e) {
    const r = this.faderRect();
    const x = e.offsetX;
    return x >= r.x - 3 && x <= r.x + r.w + 3;
  }

  /** The value the cap sits at: the engine's live one while it plays (V and W
   *  effects move it), the project's own the moment it stops. */
  volumeValue() {
    const song = this.store.doc?.songs[this.store.songIndex];
    const docVol = song?.globalVolume ?? 0x80;
    const audio = this.store.audio;
    if (audio && audio.isPlaying()) {
      const live = audio.getLiveGlobalVolume();
      if (live > 0 || docVol === 0) return Math.round(live);
    }
    return docVol;
  }

  /** Write the PROJECT's global volume (undoable; DocSync pushes it live). */
  writeVolume(value, gestureId) {
    const v = Math.max(0, Math.min(255, Math.round(value)));
    const song = this.store.doc?.songs[this.store.songIndex];
    if (!song || !this.store.undo) return;
    if (song.globalVolume === v && gestureId === null) return;
    this.store.undo.apply(setSongScalarOp(this.store.songIndex, "globalVolume", v, gestureId));
  }

  faderValueAt(offsetY) {
    const r = this.faderRect();
    const f = 1 - (offsetY - r.y) / r.h;
    return (f < 0 ? 0 : f > 1 ? 1 : f) * 255;
  }

  onFaderDown(e) {
    if (!this.faderHit(e)) return;
    this._drag = `fader:${Date.now()}`;
    this.meterCanvas.setPointerCapture?.(e.pointerId);
    this.writeVolume(this.faderValueAt(e.offsetY), this._drag);
  }

  onFaderMove(e) {
    if (this._drag === null) return;
    this.writeVolume(this.faderValueAt(e.offsetY), this._drag);
  }

  onFaderUp(e) {
    if (this._drag === null) return;
    this._drag = null;
    this.meterCanvas.releasePointerCapture?.(e.pointerId);
  }

  // ── per-frame ──

  frame() {
    if (!this.shown) return;
    this.syncTap(); // a rebuilt AudioSystem needs the tap again
    const now = performance.now();
    const dt = this.lastMs === 0 ? 16 : Math.min(now - this.lastMs, 250);
    this.lastMs = now;
    this.dtMs = dt; // the scope painters slew against wall time too

    const audio = this.store.audio;
    if (audio) {
      // A clip lamp stays lit until the next take starts — this is the edge
      // that puts it out.
      const playing = audio.isPlaying();
      if (playing && !this._wasPlaying) this.clearClips();
      this._wasPlaying = playing;

      const r = audio.readAnalysis(this.readout);
      if (r.frames > 0) {
        const wantCorr = integrateCorrelation(
          this.corrSums, r.corrLL, r.corrRR, r.corrLR, r.frames);
        this.corr = slewTowards(this.corr, wantCorr, dt, CORR_SLEW_MS);
        // The field bar reads item 98's pair literally: RMS is the energy
        // density of the encoded field, peak is the worst true peak any encoded
        // channel reached (that is what would clip the exported file).
        let worst = 0;
        let anyClip = false;
        for (let c = 0; c < r.meterCount; c++) {
          if (r.truePeak[c] > worst) worst = r.truePeak[c];
          if (r.clip[c] > 0) anyClip = true;
          this.meters[c].update(r.meanSquare[c], r.truePeak[c], r.clip[c] > 0, dt);
        }
        this.field.update(r.fieldEnergy / r.frames, worst, anyClip, dt);
      } else if (!playing) {
        // Stopped: let everything fall away.
        this.field.update(0, 0, false, dt);
        for (const m of this.meters) m.update(0, 0, false, dt);
      }
      // Playing but nothing rendered in this interval: HOLD. When the engine
      // runs off the audio thread (Tier 2) the worker tops its ring up in
      // bursts and idles in between, so empty windows are normal and reading
      // them as silence made the meters dip a few times a second.

      // How much of the ring is new since the last frame — the span every scope
      // sweeps its beam through. A snapshot can carry none of it (the ring is
      // topped up in bursts) or, after a stall, most of it; more than half the
      // ring means the beam's remembered position is stale, so the trace is
      // drawn without joining it to one.
      const write = this.readout.ringWrite | 0;
      const fresh = this._lastWrite < 0
        ? 0 : (write - this._lastWrite + SCOPE_FRAMES) % SCOPE_FRAMES;
      this.traceGap = this._lastWrite < 0 || fresh > SCOPE_FRAMES / 2;
      this.freshFrames = fresh;
      this._lastWrite = write;
    }

    const C = themeColors();
    this.updateRadiation(C, dt);
    this.updateCloud(C, dt);
    const n = this.panelCount();
    for (let i = 0; i < n; i++) this.drawScope(i, C);
    this.drawMeters(C);
  }

  /**
   * The one soundfield the radiation panels share (item 129 §12: one field, one
   * surface, three possible observations). Analysed once per frame however many
   * of them are up, and not at all when none is — the FFT, the smoothing and
   * the surface are the whole cost of the family, and the cameras are cheap.
   */
  updateRadiation(C, dt) {
    if (!this.slots.some((wish) => radView(this.effective[wish]) !== null)) return;
    const audio = this.store.audio;
    if (!audio) return;
    if (this.radField === null) this.radField = new RadiationField();
    const f = this.radField;
    // Playing but nothing new this interval is normal (the worker tops the ring
    // up in bursts), and the surface HOLDS through it exactly as the meters do.
    // Stopped is different: the ring keeps its last window forever, so the
    // surface has to be told to let go of it.
    if (audio.isPlaying()) {
      f.analyse(audio.scopeRing(), this.readout.ringWrite | 0, SAMPLING_RATE, this.freshFrames);
    } else {
      f.fade();
    }
    f.smooth(dt);
    f.build(dt, this.radBandLin(C));
  }

  /** The one spatial image the cloud panels share (item 133) — analysed once
   *  per strip, projected per panel. */
  updateCloud(C, dt) {
    if (!this.slots.some((wish) => cloudView(this.effective[wish]) !== null)) return;
    const audio = this.store.audio;
    if (!audio) return;
    if (this.cloudField === null) this.cloudField = new CloudField();
    // Stopped, nothing new is laid down and each panel's accumulator simply
    // fades — the cloud dies away rather than freezing on the ring's last
    // window. `cloudFresh` tells the panels whether there is anything new to
    // lay down; the decay itself is theirs, and happens in drawCloud.
    this.cloudFresh = audio.isPlaying()
      && this.cloudField.analyse(audio.scopeRing(), this.readout.ringWrite | 0,
        SAMPLING_RATE, this.freshFrames);
  }

  /** The five band inks in linear light, re-derived only on a theme change. */
  radBandLin(C) {
    const sig = RAD_BANDS.map((b) => C[b.ink]).join();
    if (sig !== this._radInkSig) {
      this._radInkSig = sig;
      this._radBandLin = RAD_BANDS.map((b) => parseInk(C[b.ink]).map(srgbToLinear));
    }
    return this._radBandLin;
  }

  // ── scopes ──

  drawScope(i, C) {
    const cv = this.scopeCanvas[i];
    const ctx = cv.getContext("2d");
    const dpr = this.dpr;
    const W = cv.width / dpr;
    const H = cv.height / dpr;
    if (W < 4 || H < 4) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, W, H);

    const pad = 12;
    const boxH = H - SCOPE_CORR_H - 3;
    const r = Math.max(8, Math.min(W - pad * 2, boxH - pad * 2) / 2);
    const cx = W / 2;
    const cy = boxH / 2;

    // Dial: the horizon circle, the axes and the listener at the centre.
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = C.meterBg;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    const kind = this.effective?.[this.slots?.[i] ?? i] ?? this.scopes[i];
    const stereoSong = this.model() === SURROUND_STEREO;
    const axes = scopeAxes(kind, stereoSong);
    const blobs = blobView(kind);
    const rad = radView(kind);
    const cloud = cloudView(kind);
    if (blobs !== null) this.drawBlobs(ctx, C, cx, cy, r, blobs);
    else if (rad !== null) this.drawRadiation(ctx, C, cx, cy, r, i, rad);
    else if (cloud !== null) this.drawCloud(ctx, C, cx, cy, r, i, cloud);
    else if (axes) this.drawTrace(ctx, C, cx, cy, r, axes, i, kind);

    // Edge labels — which way is which (item 98: "all four label the direction").
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillStyle = C.dim;
    const lab = scopeLabels(kind, stereoSong);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(lab.left, cx - r - 10, cy);
    ctx.textAlign = "right";
    ctx.fillText(lab.right, cx + r + 10, cy);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(lab.top, cx, cy - r - 10);
    ctx.textBaseline = "bottom";
    ctx.fillText(lab.bottom, cx, cy + r + 11);

    this.drawCorrelation(ctx, C, 6, H - SCOPE_CORR_H, W - 12, SCOPE_CORR_H - 3);
  }

  /**
   * The tracker-friendly view: one dot per sounding channel where the engine
   * actually has it, not a waveform. Same dial and the same height cue as the
   * Panner and the channel radars, so a source reads the same everywhere.
   */
  drawBlobs(ctx, C, cx, cy, r, view) {
    const audio = this.store.audio;
    if (!audio) return;
    const spatial = this.model() === SURROUND_SPATIAL;
    const n = Math.min(audio.channelCount(), 64);
    for (let ch = 0; ch < n; ch++) {
      if (!audio.getVoiceActive(ch)) continue;
      const vol = audio.getVoiceEffectiveVolume(ch);
      if (vol <= 0.002) continue;
      const az = audio.getVoiceAzimuth(ch);
      const el = audio.getVoiceElevation(ch);
      // Orthographic projection of the source onto the dial's plane: the unit
      // direction the engine has it at, with the axis we are looking ALONG
      // dropped. +x front, +y left, +z up (spatial.js), and the screen mapping
      // is the one the matching Goniometer view uses.
      directionFromAngles(az, el, dirScratch);
      let x, y;
      if (view === "front") {        // left-right against height
        x = cx - dirScratch[1] * r;
        y = cy - dirScratch[2] * r;
      } else if (view === "side") {  // front-back against height, front to the left
        x = cx - dirScratch[0] * r;
        y = cy - dirScratch[2] * r;
      } else {                       // top: left-right against front-back
        x = cx - dirScratch[1] * r;
        y = cy - dirScratch[0] * r;
      }
      const dotR = 1.5 + 4 * Math.min(vol * 2, 1);
      // The height cue belongs to the TOP view alone — that is the one that
      // cannot tell up from down. On the other two, height IS the vertical axis.
      if (spatial && view === "top") paintSpatialDot(ctx, x, y, el, r, dotR, C.accent2);
      else {
        ctx.fillStyle = C.accent2;
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * The radiation monitor (item 129): the coherent field as a solid, seen
   * through one of three orthographic cameras. All the work — the analysis, the
   * surface and its colours — has already happened in updateRadiation; a panel
   * is only a projection and a rasteriser, which is what makes three of them
   * cost barely more than one.
   */
  drawRadiation(ctx, C, cx, cy, r, slot, view) {
    const f = this.radField;
    if (f === null) return;
    const size = Math.ceil(2 * r) + 2;
    const cell = this.radCell(slot, size, C.cvBg);
    cell.view.render(f, RAD_VIEWS[view], cell.image.data, cell.ground, cell.core);
    cell.ctx.putImageData(cell.image, 0, 0);
    ctx.drawImage(cell.canvas, cx - size / 2, cy - size / 2);
    this.drawSpectrumKey(ctx, C, cx - r, cy + r + 8, r);
  }

  /**
   * The cloud (item 133): the spatial IMAGE, splatted frequency by frequency.
   * Unlike the radiation surface this panel ACCUMULATES — a single window is a
   * handful of dots, and what makes it a cloud is the trail the image leaves
   * behind it — so the decay and the deposit both live here, once per panel per
   * frame, and the analysis they share happened in updateCloud.
   */
  drawCloud(ctx, C, cx, cy, r, slot, view) {
    const f = this.cloudField;
    if (f === null) return;
    const size = Math.ceil(2 * r) + 2;
    const cell = this.cloudCell(slot, size, C.cvBg, view);
    cell.view.decay(this.dtMs ?? 16);
    if (this.cloudFresh) cell.view.splat(f, RAD_VIEWS[view], this.radBandLin(C), 1);
    cell.view.develop(cell.image.data, cell.core, this.dtMs ?? 16);
    cell.ctx.putImageData(cell.image, 0, 0);
    ctx.drawImage(cell.canvas, cx - size / 2, cy - size / 2);
    this.drawSpectrumKey(ctx, C, cx - r, cy + r + 8, r);
  }

  /** One cloud panel's accumulator and blit canvas. The accumulator IS the
   *  display's memory, so a change of camera wipes it — the trail belongs to
   *  the projection it was laid down in. */
  cloudCell(slot, size, ground, view) {
    let c = this.cloudCells[slot];
    if (c === null || c.size !== size) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const cctx = canvas.getContext("2d");
      c = this.cloudCells[slot] = {
        size, groundCss: null, core: [255, 255, 255], view3: view,
        canvas, ctx: cctx,
        image: cctx.createImageData(size, size), view: new CloudView(size),
      };
    }
    if (c.groundCss !== ground) {
      c.groundCss = ground;
      c.core = beamCoreInk(parseInk(ground));
    }
    if (c.view3 !== view) {
      c.view3 = view;
      c.view.clear();
    }
    return c;
  }

  /** One panel's camera, its blit canvas and its ImageData. Nothing in here
   *  carries over between frames, so unlike a beam cell it survives every
   *  change but a resize. */
  radCell(slot, size, ground) {
    let c = this.radCells[slot];
    if (c === null || c.size !== size) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const cctx = canvas.getContext("2d");
      c = this.radCells[slot] = {
        size, groundCss: null, ground: [0, 0, 0], core: [255, 255, 255],
        canvas, ctx: cctx,
        image: cctx.createImageData(size, size), view: new RadiationView(size),
      };
    }
    if (c.groundCss !== ground) {
      c.groundCss = ground;
      c.ground = parseInk(ground);
      c.core = beamCoreInk(c.ground);
    }
    return c;
  }

  /**
   * The band legend (item 129 §9), five swatches low to high in the corner the
   * dial's edge labels leave free. Colour on the surface is SPECTRUM and never
   * level — a quiet cymbal and a loud one are the same colour — so a key that
   * is always on screen is what makes the colour mean anything at all.
   */
  drawSpectrumKey(ctx, C, x, y, r) {
    // It shares the bottom edge with the centred direction label, so the
    // swatches narrow with the dial rather than running into it, and a dial too
    // small for a legible key gets none (the panel's tooltip still carries it).
    const w = Math.min(7, Math.floor((r - 6) / 5));
    if (w < 2) return;
    for (let b = 0; b < RAD_BANDS.length; b++) {
      ctx.fillStyle = C[RAD_BANDS[b].ink];
      ctx.fillRect(x + b * (w + 1), y, w, 3);
    }
  }

  /**
   * The vectorscope proper: a CRT beam dragged through the ring's samples (item
   * 106, src/ui/crtbeam.js). Every frame sweeps the beam through the samples
   * that arrived since the last one and lets the phosphor hold the rest, so the
   * trace is CONTINUOUS — a connected figure rather than a fog of dots — and
   * where it passes again and again the energy builds up, which is what tells
   * you where the sound actually sits.
   *
   * Auto-gained the way a hardware vectorscope is: the display is about SHAPE —
   * where the energy sits and whether the two sides agree — and a mix sitting at
   * a sane −20 dBFS would otherwise be a speck in the middle. The meters are the
   * absolute reading, so the gain is shown rather than hidden.
   */
  drawTrace(ctx, C, cx, cy, r, axes, slot, kind) {
    const audio = this.store.audio;
    if (!audio) return;
    const ring = audio.scopeRing();
    const write = this.readout.ringWrite;
    const hSign = axes.flipH ? 1 : -1; // +Y is LEFT on screen, +X is FRONT (up)

    // The gain is a WINDOW statistic, so it reads the whole ring however few
    // samples this frame draws: measured over the 16 ms just gone it would
    // wobble with every transient.
    let peak = 0;
    for (let k = 0; k < SCOPE_FRAMES; k++) {
      const o = k * SCOPE_CHANNELS;
      const a = Math.abs(ring[o + axes.h]);
      const b = Math.abs(ring[o + axes.v]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    // One slew for both directions (~300 ms): a transient briefly overruns the
    // dial rather than yanking the whole trace smaller, which is the readable
    // trade — you are looking at the SHAPE, and it has to hold still enough to
    // be looked at.
    this.scopeGain[slot] = slewTowards(
      this.scopeGain[slot], scopeAutoGain(peak), this.dtMs ?? 16, SCOPE_GAIN_SLEW_MS);
    const g = this.scopeGain[slot];

    // The screen is built in CSS pixels and blitted through the canvas
    // transform, so the trace looks the same on a HiDPI screen as on a plain
    // one (and costs the same) instead of thinning out as the pixels get finer.
    const size = Math.ceil(2 * r) + 2;
    const cell = this.beamCell(slot, size, C.accent, C.cvBg, kind);
    const beam = cell.beam;
    beam.decay(this.dtMs ?? 16);

    const n = this.freshFrames;
    if (n > 0) {
      if (this.traceGap) beam.lift();
      for (let k = 0; k < n; k++) {
        const o = ((write - n + k + SCOPE_FRAMES * 2) % SCOPE_FRAMES) * SCOPE_CHANNELS;
        traceX[k] = hSign * ring[o + axes.h] * g;
        traceY[k] = ring[o + axes.v] * g;
      }
      beam.trace(traceX, traceY, n);
    }
    beam.develop(cell.image.data, cell.rgb, cell.core);
    cell.ctx.putImageData(cell.image, 0, 0);
    ctx.drawImage(cell.canvas, cx - size / 2, cy - size / 2);

    if (this.scopeGain[slot] > 1.05) {
      ctx.fillStyle = C.dim;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(`×${this.scopeGain[slot].toFixed(1)}`, cx + r + 10, cy - r - 10);
    }
  }

  /**
   * One panel's beam, its blit canvas and its ImageData. The beam survives a
   * theme change (only the ink is re-parsed) but not a resize or a change of
   * view: both of those move every pixel of it, and the phosphor would spend
   * half a second showing the previous geometry.
   */
  beamCell(slot, size, ink, ground, kind) {
    let c = this.beams[slot];
    if (c === null || c.size !== size) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const cctx = canvas.getContext("2d");
      c = this.beams[slot] = {
        size, ink: null, ground: null, kind, rgb: [128, 128, 128], core: [255, 255, 255],
        canvas, ctx: cctx,
        image: cctx.createImageData(size, size), beam: new CrtBeam(size),
      };
    }
    if (c.ink !== ink) {
      c.ink = ink;
      c.rgb = parseInk(ink);
    }
    if (c.ground !== ground) {
      c.ground = ground;
      c.core = beamCoreInk(parseInk(ground));
    }
    if (c.kind !== kind) {
      c.kind = kind;
      c.beam.clear();
    }
    return c;
  }

  /**
   * The inverse-correlation meter: nothing at all when the image is mono-safe,
   * growing out of the centre as the two ears disagree, full width in anti-
   * phase. It rides under every scope, which is where you look when you are
   * checking whether the mix survives a fold-down.
   */
  drawCorrelation(ctx, C, x, y, w, h) {
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(x, y, w, h);
    const inv = (1 - this.corr) / 2; // 0 mono … 0.5 uncorrelated … 1 anti-phase
    const half = (w / 2) * inv;
    ctx.fillStyle = inv > 0.75 ? "#e05a4a" : inv > 0.5 ? "#e0a33a" : C.meter;
    ctx.fillRect(x + w / 2 - half, y, half * 2, h);
    ctx.fillStyle = C.dim;
    ctx.fillRect(x + w / 2 - 0.5, y - 1, 1, h + 2);
  }

  // ── fader + meters ──

  /**
   * The bars to draw, left to right. A speaker layout is arranged the way the
   * speakers stand rather than in channel order (and drops the LFE); the
   * ambisonic target leads with the field.
   */
  meterBars() {
    const bars = [];
    if (this.target === ANALYSIS_AMBISONIC) {
      bars.push({ label: "E", meter: this.field, weight: 1.7, field: true });
    }
    const n = this.readout.meterCount;
    for (const { label, channel } of meterDisplay(this.target)) {
      if (n > 0 && channel >= n) continue; // tap not up to this target yet
      bars.push({ label, meter: this.meters[channel], weight: 1 });
    }
    return bars;
  }

  drawMeters(C) {
    const cv = this.meterCanvas;
    const ctx = cv.getContext("2d");
    const dpr = this.dpr;
    const W = cv.width / dpr;
    const H = cv.height / dpr;
    if (W < 4 || H < 4) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, W, H);
    ctx.font = "9px system-ui, sans-serif";

    const fr = this.faderRect();
    this.drawFader(ctx, C, fr);

    // Scale ticks, between the fader and the bars.
    const scaleX = fr.x + fr.w + 3;
    const top = fr.y;
    const barH = fr.h;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = C.meterBg;
    for (const db of [0, -6, -12, -24, -36, -48]) {
      const y = top + barH * (1 - meterFrac(db));
      ctx.fillStyle = C.dim;
      ctx.fillText(String(db), scaleX + 13, y);
      ctx.beginPath();
      ctx.moveTo(scaleX + 15, y);
      ctx.lineTo(scaleX + 17, y);
      ctx.stroke();
    }

    const bars = this.meterBars();
    const x0 = scaleX + 18;
    const avail = W - x0 - 3;
    const totalWeight = bars.reduce((s, b) => s + b.weight, 0) || 1;
    const gap = 2;
    const unit = (avail - gap * (bars.length - 1)) / totalWeight;
    let x = x0;
    for (const bar of bars) {
      const bw = Math.max(3, unit * bar.weight);
      this.drawBar(ctx, C, x, top, bw, barH, bar);
      ctx.fillStyle = C.dim;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(bar.label, x + bw / 2, top + barH + 3);
      x += bw + gap;
    }
  }

  drawBar(ctx, C, x, y, w, h, bar) {
    const m = bar.meter;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(x, y, w, h);

    const rmsF = meterFrac(m.rmsDb());
    if (rmsF > 0) {
      const rh = h * rmsF;
      const grad = ctx.createLinearGradient(0, y + h, 0, y);
      grad.addColorStop(0, C.meter);
      grad.addColorStop(meterFrac(-12), C.meter);
      grad.addColorStop(meterFrac(-3), "#e0a33a");
      grad.addColorStop(1, "#e05a4a");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y + h - rh, w, rh);
    }

    const pf = meterFrac(m.peakDb);
    if (pf > 0) {
      ctx.fillStyle = m.peakDb >= 0 ? "#e05a4a" : C.fg;
      ctx.fillRect(x, y + h - h * pf - 1, w, 1.5);
    }

    // Clip indicator: the cap of the bar. Latched, so a single clipped sample
    // half an hour ago is still telling you about itself.
    ctx.fillStyle = m.clipping() ? "#e05a4a" : C.meterBg;
    ctx.fillRect(x, y - 5, w, 4);
  }

  drawFader(ctx, C, r) {
    const v = this.volumeValue();
    const f = v / 255;
    // Track, with the travel filled in below the cap so the setting reads at a
    // glance from across the room.
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(r.x + r.w / 2 - 3, r.y, 6, r.h);
    const capY = r.y + r.h * (1 - f);
    ctx.fillStyle = C.meter;
    ctx.fillRect(r.x + r.w / 2 - 3, capY, 6, r.y + r.h - capY);
    // The file's own default ($80) marked on the track.
    ctx.fillStyle = C.border;
    ctx.fillRect(r.x + 2, r.y + r.h * (1 - 0x80 / 255) - 0.5, r.w - 4, 1);

    ctx.fillStyle = this._drag !== null ? C.accent : C.fg;
    ctx.fillRect(r.x, capY - 5, r.w, 10);
    ctx.fillStyle = C.bg;
    ctx.fillRect(r.x, capY - 0.5, r.w, 1);

    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(String(v), r.x + r.w / 2, r.y + r.h + 3);
    ctx.fillText(t("master.vol"), r.x + r.w / 2, 1);
  }
}
