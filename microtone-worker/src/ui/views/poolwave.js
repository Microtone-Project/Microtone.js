// The sample pool drawn as a WAVEFORM, wrapped across as many lines as it takes
// (item 175.1) — the map view of the Samples tab.
//
// The one-line waveform above it answers "what does this sample look like?".
// This answers a different question, and the working method item 175 is about
// needs it: a recording loaded into memory can be megabytes, no instrument can
// claim more than 65535 bytes of it, and the interesting thing about any byte
// in it is WHERE IT IS. So the pool is drawn like a hex dump is drawn — an
// address down the left, a fixed number of bytes across, line after line — only
// the bytes are drawn as audio instead of as digits.
//
// Three layers, two canvases:
//   * the map canvas: the claim/region bands and the trace itself, repainted
//     only when the pool, the scope, the zoom or the scroll position moves;
//   * the overlay canvas: the hover hairline, the drag selection and one tick
//     per sounding voice, repainted every frame.
// A third of a megabyte of bytes gets read per repaint of the map; none of it
// belongs in the frame loop, which is the whole reason for the split.
//
// The drag selection is what turns the view into a tool: drag out a window,
// and "Cut instrument" mints an instrument that plays exactly those bytes.

import { themeColors, pickInk } from "../theme.js";
import { unescapeName } from "../names.js";
import { sampleSpans } from "../../doc/document.js";
import { regionSpans, POOL_SIZE, DEFAULT_RATE } from "../../doc/sampleregions.js";
import { u8ToFloat } from "../../doc/wavelab.js";
import { SamplePreview } from "../samplepreview.js";
import { TOTAL_VOICES } from "../../engine/constants.js";
import { t } from "../i18n.js";
import { uiDpr, localPoint } from "../zoom.js";

/** Waveform height of one line, the claim ribbon under it, and the gap. The
 *  ribbon is deep enough to hold a NUMBER: drawn as a five-pixel underline it
 *  was one continuous blue line under a packed pool, with the row numbers
 *  floating over the trace above it and nothing tying either to the other. */
const WAVE_H = 40;
const RIBBON_H = 14;
/** How far a claim block is inset inside the ribbon lane. Over a recording
 *  that margin shows the recording's colour, so a window cut out of one is
 *  drawn visibly INSIDE it. */
const CLAIM_INSET = 2;
const ROW_GAP = 6;
const ROW_H = WAVE_H + RIBBON_H + ROW_GAP;
/** Address gutter width. Six hex digits address the whole 8 MB pool. */
const GUTTER_W = 74;
/** Fallback height for the scrolling window, used only before the pane has
 *  been laid out (a hidden view measures zero). In the document the scroller
 *  fills whatever is left of the detail pane — see `viewH`. */
const FALLBACK_VIEW_H = ROW_H * 8;

/** Zoom ladder, in POOL BYTES PER PIXEL. Below 1 a byte is drawn as a bar
 *  several pixels wide, which is the only way to see an individual sample. */
const ZOOMS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];

/** An instrument's sample length is a U16 — the ceiling on any window cut out
 *  of the pool, and the reason a long recording needs this view at all. */
const MAX_SLICE = 0xffff;

/** How much a double-click auditions when there is no window to play: enough
 *  to recognise what is there, short enough to double-click again straight
 *  away while walking through a long recording. */
const SCRUB_SECONDS = 3;

/** The row's geometry, so a test can find the ribbon lane on the canvas
 *  without guessing at it. Read-only metadata about the drawing. */
export const LAYOUT = Object.freeze({
  WAVE_H, RIBBON_H, CLAIM_INSET, ROW_GAP, ROW_H, GUTTER_W,
});

/**
 * The colour a census row's blocks wear on the strip.
 *
 * The census is sorted by pool pointer and numbered in that order, so two
 * blocks that TOUCH always hold consecutive row numbers — which is what makes
 * a plain cycle enough to separate every neighbour without any per-row search.
 * A sample keeps its colour wherever it appears, including across the several
 * lines a long one spans, so a block on screen can be matched to a row in the
 * list by colour alone.
 */
const CLAIM_HUES = ["poolC0", "poolC1", "poolC2", "poolC3", "poolC4"];
function claimFill(C, index) {
  return C[CLAIM_HUES[((index % CLAIM_HUES.length) + CLAIM_HUES.length) % CLAIM_HUES.length]]
    || C.poolUsed;
}

const hexAddr = (n) => "0x" + Math.max(0, n).toString(16).toUpperCase().padStart(6, "0");

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

export class PoolWave {
  /**
   * @param onSelectSample called with a census index when a claim is clicked.
   * @param onSlice called with {ptr, len, region} when "Cut instrument" is hit.
   */
  constructor(store, { onSelectSample, onSlice } = {}) {
    this.store = store;
    this.onSelectSample = onSelectSample;
    this.onSlice = onSlice;
    this.selected = -1;          // selected census row (drawn in the accent)
    this.scope = { kind: "pool", ptr: 0, len: POOL_SIZE };
    this.zoom = 10;              // index into ZOOMS
    this.zoomTouched = false;    // once the user has zoomed, stop auto-fitting
    this.hoverByte = -1;
    this.sel = null;             // {from, to} absolute pool bytes
    this.drag = null;            // {anchor, moved}
    this.rows = 0;
    this.bytesPerRow = 1;

    this.root = document.createElement("div");
    this.root.className = "pw-root";

    // ── the bar: zoom, what is under the pointer, what is selected ──
    this.bar = document.createElement("div");
    this.bar.className = "pw-bar";
    this.zoomOut = this.barButton("−", t("pw.zoomOut"), () => this.setZoom(this.zoom + 1));
    this.zoomIn = this.barButton("+", t("pw.zoomIn"), () => this.setZoom(this.zoom - 1));
    this.fitBtn = this.barButton(t("pw.fit"), t("pw.fitTitle"), () => {
      this.zoomTouched = false;
      this.relayout();
    });
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "pw-zoom";
    this.readout = document.createElement("span");
    this.readout.className = "pw-readout";
    this.selLabel = document.createElement("span");
    this.selLabel.className = "pw-sel";
    this.sliceBtn = document.createElement("button");
    this.sliceBtn.className = "pw-slice";
    this.sliceBtn.textContent = t("pw.slice");
    this.sliceBtn.title = t("pw.sliceTitle");
    this.sliceBtn.disabled = true;
    this.sliceBtn.addEventListener("click", () => this.emitSlice());
    // ── audition (item 175 follow-up) ──
    // Cutting a window out of memory blind is guesswork; this is the ear on it.
    this.preview = new SamplePreview(() => this.store.audio?.context ?? null);
    this.preview.onChange = () => this.syncPlayBtn();
    this.playBtn = document.createElement("button");
    this.playBtn.className = "pw-play";
    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.loopBtn = this.barButton("\u21bb", t("pw.loopTitle"), () => {
      this.loopPreview = !this.loopPreview;
      this.loopBtn.classList.toggle("on", this.loopPreview);
      if (this.preview.active) this.playSelection();
    });
    this.loopPreview = false;
    this.clearBtn = this.barButton(t("pw.clearSel"), t("pw.clearSelTitle"), () => {
      this.sel = null;
      this.syncSelection();
      this.drawOverlay();
    });
    this.bar.append(this.zoomOut, this.zoomLabel, this.zoomIn, this.fitBtn,
      this.readout, this.selLabel, this.playBtn, this.loopBtn, this.sliceBtn, this.clearBtn);
    this.syncPlayBtn();

    // ── the scroller: a real scrollbar, a canvas the size of the window ──
    this.scroll = document.createElement("div");
    this.scroll.className = "pw-scroll";
    this.spacer = document.createElement("div");
    this.spacer.className = "pw-spacer";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pw-canvas";
    this.overlay = document.createElement("canvas");
    this.overlay.className = "pw-overlay";
    this.spacer.append(this.canvas, this.overlay);
    this.scroll.appendChild(this.spacer);
    this.root.append(this.bar, this.scroll);

    this.scroll.addEventListener("scroll", () => this.onScroll());
    // Ctrl/⌘+wheel zooms about the pointer; a plain wheel is the browser's own
    // scroll, which is what a scroll container is for.
    this.scroll.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.setZoom(this.zoom + (e.deltaY > 0 ? 1 : -1), this.byteAtEvent(e));
    }, { passive: false });
    this.overlay.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.overlay.addEventListener("pointerleave", () => {
      if (this.hoverByte < 0) return;
      this.hoverByte = -1;
      this.writeReadout();
      this.drawOverlay();
    });
    this.overlay.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.overlay.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.overlay.addEventListener("pointercancel", () => { this.drag = null; });
    // Double-click anywhere: hear a few seconds from that byte. Walking a long
    // recording by ear needs no selection and no round trip through a dialog.
    this.overlay.addEventListener("dblclick", (e) => this.scrubAt(this.byteAtEvent(e)));
  }

  get element() { return this.root; }

  /** The scroller's height RIGHT NOW: it stretches to the bottom of the detail
   *  pane, so every row count below is measured rather than assumed. */
  viewH() {
    const h = this.scroll.clientHeight;
    return h > 0 ? h : FALLBACK_VIEW_H;
  }

  barButton(text, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  // ── scope, zoom, layout ────────────────────────────────────────────────────

  /** What range of the pool this view draws: the whole pool, one region, or
   *  one sample's neighbourhood. Changing it re-fits the zoom unless the user
   *  has taken the zoom over. */
  setScope(scope) {
    const same = this.scope.kind === scope.kind && this.scope.ptr === scope.ptr &&
      this.scope.len === scope.len;
    this.scope = { ...scope };
    if (!same) {
      this.stopPreview();   // a different stretch of memory is on screen now
      this.sel = null;
      this.zoomTouched = false;
      this.scroll.scrollTop = 0;
    }
    this.relayout();
  }

  /** `about` keeps that pool byte under the pointer across the zoom change. */
  setZoom(index, about = -1) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, index));
    if (next === this.zoom) return;
    this.zoom = next;
    this.zoomTouched = true;
    this.relayout(about);
  }

  /** Bytes the view spans, clamped into the pool. */
  range() {
    const from = Math.max(0, Math.min(this.scope.ptr | 0, POOL_SIZE - 1));
    const to = Math.max(from + 1, Math.min(from + (this.scope.len | 0), POOL_SIZE));
    return { from, to };
  }

  waveWidth() {
    return Math.max(80, (this.scroll.clientWidth || this.root.clientWidth || 640) - GUTTER_W - 14);
  }

  /** Rows, bytes per row and the spacer height for the current zoom. Without a
   *  user zoom, pick the coarsest level that still shows at least four lines and
   *  the finest that keeps the whole scope under a thousand — "fit" means
   *  legible, not "one line". */
  relayout(keepByte = -1) {
    const { from, to } = this.range();
    const span = to - from;
    const w = this.waveWidth();
    if (!this.zoomTouched) {
      let best = ZOOMS.length - 1;
      for (let i = 0; i < ZOOMS.length; i++) {
        const rows = Math.ceil(span / Math.max(1, Math.round(w * ZOOMS[i])));
        if (rows <= 48) { best = i; break; }
      }
      this.zoom = best;
    }
    this.bytesPerRow = Math.max(1, Math.round(w * ZOOMS[this.zoom]));
    this.rows = Math.max(1, Math.ceil(span / this.bytesPerRow));
    this.spacer.style.height = this.rows * ROW_H + "px";
    this.zoomLabel.textContent = t("pw.zoomLabel", {
      n: ZOOMS[this.zoom] < 1 ? `1/${Math.round(1 / ZOOMS[this.zoom])}` : ZOOMS[this.zoom],
      row: fmtBytes(this.bytesPerRow),
    });
    if (keepByte >= 0) {
      const row = Math.floor((keepByte - from) / this.bytesPerRow);
      this.scroll.scrollTop = Math.max(0, row * ROW_H - this.viewH() / 2);
    }
    this.draw();
  }

  onScroll() {
    this.draw();
  }

  /** Put `byte` on screen (used when the view is opened on a selected sample —
   *  a pool-scoped map opens at address 0, which is nowhere near it). */
  scrollToByte(byte) {
    const { from, to } = this.range();
    if (!(byte >= from) || byte >= to) return;
    const row = Math.floor((byte - from) / this.bytesPerRow);
    // Already on screen: leave the view exactly where it is. Clicking a claim
    // in the map selects it, and a selection that scrolls the picture out from
    // under the pointer is the one thing a map must not do.
    const top = this.topRow();
    if (row >= top && row < top + Math.floor(this.viewH() / ROW_H)) return;
    this.scroll.scrollTop = Math.max(0, row * ROW_H - this.viewH() / 3);
    this.draw();
  }

  // ── hit testing ────────────────────────────────────────────────────────────

  /** The pool byte under a pointer event, or -1 when it is off the trace. */
  byteAtEvent(e) {
    const p = localPoint(this.overlay, e);
    const x = p.x - GUTTER_W;
    const y = p.y;
    const w = this.waveWidth();
    if (x < 0 || x > w) return -1;
    const row = this.topRow() + Math.floor(y / ROW_H);
    if (row < 0 || row >= this.rows) return -1;
    const { from, to } = this.range();
    const byte = from + row * this.bytesPerRow + Math.floor((x / w) * this.bytesPerRow);
    return byte >= from && byte < to ? byte : -1;
  }

  topRow() {
    return Math.max(0, Math.floor(this.scroll.scrollTop / ROW_H));
  }

  /** The census claim covering `byte`, preferring the shortest (a window cut
   *  out of a long sample is the more specific answer). */
  claimAt(byte) {
    let best = null;
    for (const e of this.census()) {
      for (const sp of sampleSpans(e)) {
        if (byte < sp.ptr || byte >= sp.ptr + sp.len) continue;
        if (!best || sp.len < best.len) best = { entry: e, ...sp };
      }
    }
    return best;
  }

  /** The census and the region list as of the last paint. sampleList() rebuilds
   *  a Map and sorts it on every call, and the hover readout would otherwise do
   *  that on every pointer move; refresh() runs on every edit, so this is never
   *  stale for longer than a frame. */
  census() {
    return this._census ?? this.store.doc?.sampleList() ?? [];
  }

  regionList() {
    return this._regions ?? this.store.doc?.sampleRegions() ?? [];
  }

  regionAt(byte) {
    for (const r of this.regionList()) {
      for (const sp of regionSpans(r)) {
        if (byte >= sp.ptr && byte < sp.ptr + sp.len) return { region: r, ...sp };
      }
    }
    return null;
  }

  pointerMove(e) {
    const byte = this.byteAtEvent(e);
    if (this.drag) {
      if (byte >= 0) {
        this.drag.moved = true;
        this.sel = {
          from: Math.min(this.drag.anchor, byte),
          to: Math.max(this.drag.anchor, byte) + 1,
        };
        this.syncSelection();
      }
    }
    if (byte === this.hoverByte && !this.drag) return;
    this.hoverByte = byte;
    this.writeReadout();
    this.drawOverlay();
  }

  pointerDown(e) {
    const byte = this.byteAtEvent(e);
    if (byte < 0) return;
    // A synthetic pointer (the headless smokes) has no real capture behind it
    // and setPointerCapture throws on one; the drag works either way.
    try { this.overlay.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.drag = { anchor: byte, moved: false };
  }

  pointerUp(e) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    try { this.overlay.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    if (drag.moved) return;
    // A click, not a drag: select whatever the byte belongs to. Selecting the
    // census row is what makes the map navigate the list, exactly as the
    // address-line panel below it does.
    this.sel = null;
    this.syncSelection();
    const hit = this.claimAt(drag.anchor);
    if (hit) this.onSelectSample?.(hit.entry.index);
    this.drawOverlay();
  }

  /** What the trailing part of the bar says about the drag selection. */
  syncSelection() {
    const n = this.sel ? this.sel.to - this.sel.from : 0;
    this.sliceBtn.disabled = !(n > 0 && n <= MAX_SLICE);
    this.syncPlayBtn();
    this.clearBtn.disabled = !this.sel;
    if (!this.sel) { this.selLabel.textContent = ""; return; }
    this.selLabel.textContent = t("pw.selRange", {
      from: hexAddr(this.sel.from), to: hexAddr(this.sel.to),
      len: fmtBytes(n),
    }) + (n > MAX_SLICE ? " · " + t("pw.selTooLong", { max: MAX_SLICE }) : "");
  }

  writeReadout() {
    const b = this.hoverByte;
    if (b < 0) { this.readout.textContent = ""; return; }
    const bin = this.store.doc?.sampleBin;
    const region = this.regionAt(b);
    const claim = this.claimAt(b);
    const parts = [t("pw.hoverByte", { at: b, hex: hexAddr(b), v: bin ? bin[b] : 0 })];
    if (region) {
      parts.push(t("pw.hoverRegion", {
        name: unescapeName(region.region.name) || t("rgn.namePlaceholder"),
        off: b - region.ptr,
        chan: region.region.chan > 1 ? t("pw.hoverChan", { n: region.chan + 1 }) : "",
      }));
    }
    if (claim) {
      parts.push(t("pw.hoverClaim", {
        idx: String(claim.entry.index).padStart(3, "0"),
        name: unescapeName(claim.entry.name) || t("smp.namePlaceholder"),
        off: b - claim.ptr,
      }));
    }
    this.readout.textContent = parts.join(" · ");
  }

  // ── audition ───────────────────────────────────────────────────────────────

  /** The rate a window at `ptr` should be heard at: the recording it sits in,
   *  else the sample it sits in, else the engine's own. Exactly the rule the
   *  cut uses, so what you hear is what the instrument will play. */
  rateAt(ptr) {
    return this.regionAt(ptr)?.region.rate ||
      this.claimAt(ptr)?.entry.rate || DEFAULT_RATE;
  }

  /**
   * The bytes of [ptr, ptr+len) as one float channel per SOURCE channel: a
   * window inside a multi-channel recording, or inside a stereo sample, is
   * auditioned as the pair it will be cut as — not as its left half.
   */
  windowChannels(ptr, len) {
    const bin = this.store.doc?.sampleBin;
    if (!bin || len <= 0) return [];
    const take = (from) => u8ToFloat(bin.subarray(from, from + len));
    const region = this.regionAt(ptr);
    if (region && region.region.chan > 1) {
      const off = ptr - region.ptr;
      const spans = regionSpans(region.region);
      if (off + len <= region.len) return spans.map((sp) => take(sp.ptr + off));
    }
    const claim = this.claimAt(ptr);
    const extra = claim?.entry.chanPtrs ?? [];
    if (claim && extra.length > 0) {
      const off = ptr - claim.ptr;
      if (off + len <= claim.len) {
        return [take(ptr), ...extra.map((p) => take(p + off))];
      }
    }
    return [take(ptr)];
  }

  /** What Play would sound: the dragged window, else the selected census row's
   *  own span, else nothing. */
  playTarget() {
    if (this.sel) return { ptr: this.sel.from, len: this.sel.to - this.sel.from };
    const e = (this.census() ?? [])[this.selected];
    if (e && e.len > 0) return { ptr: e.ptr, len: e.len };
    return null;
  }

  togglePlay() {
    if (this.preview.active) { this.preview.stop(); return; }
    this.playSelection();
  }

  playSelection() {
    const target = this.playTarget();
    if (!target) return;
    this.audition(target.ptr, target.len, this.loopPreview);
  }

  /** Double-click: a few seconds from `byte`, never looped — this is a way of
   *  walking through memory, not of judging a loop. */
  scrubAt(byte) {
    if (byte < 0) return;
    const { to } = this.range();
    const rate = this.rateAt(byte);
    const len = Math.min(Math.round(rate * SCRUB_SECONDS), to - byte);
    if (len > 0) this.audition(byte, len, false);
  }

  audition(ptr, len, loop) {
    const chans = this.windowChannels(ptr, len);
    if (!chans.length) return;
    this.preview.play(chans, this.rateAt(ptr), { loop, meta: { ptr, len } });
    this.pumpPreview();
  }

  /** Repaint the overlay while the preview runs. The view's own frame() only
   *  fires while the ENGINE is running, and a preview is deliberately not the
   *  engine — so the playhead needs a loop of its own. */
  pumpPreview() {
    if (this._pumping) return;
    this._pumping = true;
    const tick = () => {
      if (!this.preview.active) { this._pumping = false; this.drawOverlay(); return; }
      this.drawOverlay();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  syncPlayBtn() {
    const on = this.preview.active;
    this.playBtn.textContent = on ? "\u25a0" : "\u25b6";
    this.playBtn.title = t(on ? "pw.stopTitle" : "pw.playTitle");
    this.playBtn.classList.toggle("on", on);
    this.playBtn.disabled = !on && !this.playTarget();
  }

  /** Stop anything sounding — the view is going away, or what was playing is
   *  no longer what is selected. */
  stopPreview() { this.preview.stop(); }

  emitSlice() {
    if (!this.sel) return;
    const len = this.sel.to - this.sel.from;
    if (len <= 0 || len > MAX_SLICE) return;
    const region = this.regionAt(this.sel.from);
    // A window that runs off the end of its region's channel is not a slice of
    // that channel — clamp it rather than quietly cutting across the boundary.
    let ptr = this.sel.from, count = len;
    if (region) count = Math.min(count, region.ptr + region.len - ptr);
    const rate = region ? region.region.rate
      : (this.claimAt(ptr)?.entry.rate || DEFAULT_RATE);
    this.onSlice?.({ ptr, len: count, region: region?.region ?? null, rate });
  }

  // ── painting ───────────────────────────────────────────────────────────────

  refresh(selected = this.selected) {
    this.selected = selected;
    this.syncSelection();
    this.relayout();
  }

  /** Per-frame: only the overlay (cursors, hairline, selection). */
  frame() {
    this.drawOverlay();
  }

  /** Size both canvases to the scroll VIEWPORT and park them at the scroll
   *  offset — the spacer owns the height, so a pool 30 000 lines tall costs
   *  one screen of pixels. */
  sizeCanvases() {
    const dpr = uiDpr();
    const w = GUTTER_W + this.waveWidth();
    const visible = Math.min(this.rows - this.topRow(), Math.ceil(this.viewH() / ROW_H) + 1);
    const h = Math.max(ROW_H, visible * ROW_H);
    for (const cv of [this.canvas, this.overlay]) {
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      cv.style.width = w + "px";
      cv.style.height = h + "px";
      cv.style.top = this.topRow() * ROW_H + "px";
    }
    return { w, h, dpr, visible };
  }

  draw() {
    const doc = this.store.doc;
    const { w, h, dpr, visible } = this.sizeCanvases();
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = themeColors();
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    if (!doc?.sampleBin) return;
    const bin = doc.sampleBin;
    const { from, to } = this.range();
    const top = this.topRow();
    const waveW = this.waveWidth();
    const census = doc.sampleList();
    const regions = doc.sampleRegions();
    this._census = census;
    this._regions = regions;

    ctx.font = "10px monospace";
    ctx.textBaseline = "alphabetic";

    for (let i = 0; i < visible; i++) {
      const row = top + i;
      if (row >= this.rows) break;
      const rowFrom = from + row * this.bytesPerRow;
      const rowTo = Math.min(to, rowFrom + this.bytesPerRow);
      const y = i * ROW_H;
      const xOf = (byte) => GUTTER_W + ((byte - rowFrom) / this.bytesPerRow) * waveW;

      // address gutter
      ctx.fillStyle = C.dim;
      ctx.fillText(hexAddr(rowFrom), 4, y + WAVE_H / 2 + 4);

      // the line's own ground: free pool is the panel's "free" colour, so a
      // region or a claim reads as something ON it.
      ctx.fillStyle = C.poolFree;
      ctx.fillRect(GUTTER_W, y, waveW, WAVE_H);

      // Which pixel columns of this line ANYTHING claims. A swept hole is all
      // zero bytes, and zero is not silence in U8 — it is full negative — so an
      // empty pool would otherwise draw as a solid block of the loudest
      // possible DC. Unclaimed memory reading all-zero is drawn as nothing;
      // unclaimed memory that still holds audio is drawn, because seeing that
      // is one of the things a byte-level view is for.
      const covered = new Uint8Array(Math.ceil(waveW));
      const markCovered = (a, b) => {
        const c0 = Math.max(0, Math.floor(((a - rowFrom) / this.bytesPerRow) * waveW));
        const c1 = Math.min(covered.length, Math.ceil(((b - rowFrom) / this.bytesPerRow) * waveW));
        for (let c = c0; c < c1; c++) covered[c] = 1;
      };

      // region bands sit UNDER the claims: an instrument cut out of a recording
      // is drawn on top of the recording it came from.
      for (const r of regions) {
        for (const sp of regionSpans(r)) {
          if (sp.ptr >= rowTo || sp.ptr + sp.len <= rowFrom) continue;
          const x = xOf(Math.max(sp.ptr, rowFrom));
          const x2 = xOf(Math.min(sp.ptr + sp.len, rowTo));
          const w = Math.max(1, x2 - x);
          ctx.fillStyle = C.poolRegion;
          ctx.globalAlpha = 0.22;
          ctx.fillRect(x, y, w, WAVE_H);
          ctx.globalAlpha = 1;
          ctx.fillRect(x, y + WAVE_H, w, RIBBON_H);
          markCovered(Math.max(sp.ptr, rowFrom), Math.min(sp.ptr + sp.len, rowTo));
          // Name the recording once, where it starts — in the pool-wide view a
          // green band is otherwise unlabelled.
          if (sp.ptr >= rowFrom && sp.ptr < rowTo && sp.chan === 0) {
            const label = unescapeName(r.name) || t("rgn.namePlaceholder");
            const tw = ctx.measureText(label).width;
            if (w >= tw + 8) {
              ctx.fillStyle = C.poolRegion;
              ctx.fillRect(x + 1, y + 1, tw + 6, 13);
              ctx.fillStyle = pickInk(C.poolRegion, C);
              ctx.fillText(label, x + 4, y + 11);
            }
          }
        }
      }

      // The claim ribbon: who says these bytes are theirs. A pool packed end to
      // end — which is every module conversion — puts hundreds of these edge to
      // edge, so each claim is drawn as a BLOCK with its number inside it,
      // exactly as the memory panel's own map draws one, rather than as a strip
      // of underline with the numbers floating over the trace. Three things
      // keep neighbours apart at every zoom: the block is inset inside the
      // lane, it is outlined against the ground and gapped from the next one,
      // and it is COLOURED by census row — see claimFill, where the fact that
      // touching blocks always hold consecutive numbers is what makes a plain
      // five-colour cycle separate every neighbour there can be, down to a
      // block three pixels wide with no room for anything else.
      for (const e of census) {
        for (const sp of sampleSpans(e)) {
          if (sp.ptr >= rowTo || sp.ptr + sp.len <= rowFrom) continue;
          const a = Math.max(sp.ptr, rowFrom);
          const b = Math.min(sp.ptr + sp.len, rowTo);
          const x = xOf(a);
          const w = Math.max(1, xOf(b) - x);
          const by = y + WAVE_H + CLAIM_INSET;
          const bh = RIBBON_H - CLAIM_INSET * 2;
          const selected = e.index === this.selected;
          const fill = selected ? C.accent : claimFill(C, e.index);
          ctx.fillStyle = fill;
          ctx.fillRect(x, by, Math.max(1, w - 1), bh);
          if (w >= 3) {
            ctx.strokeStyle = C.cvBg;
            ctx.strokeRect(Math.round(x) + 0.5, by + 0.5, Math.round(w) - 2, bh - 1);
          }
          markCovered(a, b);
          if (selected) {
            ctx.globalAlpha = 0.16;
            ctx.fillRect(x, y, w, WAVE_H);
            ctx.globalAlpha = 1;
          }
          // Where the claim STARTS, run up through the trace: the most useful
          // mark on the line, since it is where one sample's audio ends and the
          // next one's begins.
          if (sp.ptr >= rowFrom && sp.ptr < rowTo) {
            ctx.fillStyle = fill;
            ctx.globalAlpha = selected ? 0.9 : 0.45;
            ctx.fillRect(Math.round(x), y, 1, WAVE_H);
            ctx.globalAlpha = 1;
          }
          // The number lives IN the block, so it labels something.
          if (sp.ptr >= rowFrom && sp.ptr < rowTo && sp.chan === 0) {
            const label = `${String(e.index).padStart(3, "0")} ${unescapeName(e.name) || ""}`.trim();
            let text = label;
            let tw = ctx.measureText(text).width;
            // A block too narrow for the name still has room for the number,
            // which is what the list is keyed by.
            if (tw + 7 > w) {
              text = String(e.index).padStart(3, "0");
              tw = ctx.measureText(text).width;
            }
            if (tw + 7 <= w) {
              ctx.fillStyle = pickInk(fill, C);
              ctx.fillText(text, x + 3, by + bh - 2);
            }
          }
        }
      }

      // the trace
      const baseY = y + WAVE_H / 2;
      ctx.fillStyle = C.waveMid ?? C.dim;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(GUTTER_W, Math.round(baseY), waveW, 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.wave;
      const bytes = rowTo - rowFrom;
      if (bytes <= 0) continue;
      if (bytes <= waveW) {
        const bw = Math.max(1, waveW / bytes);
        for (let b = rowFrom; b < rowTo; b++) {
          const v = bin[b];
          const bx = ((b - rowFrom) / this.bytesPerRow) * waveW;
          if (v === 0 && !covered[Math.min(covered.length - 1, Math.floor(bx))]) continue;
          const yv = baseY + (WAVE_H / 2) * ((128 - v) / 128);
          ctx.fillRect(GUTTER_W + bx, Math.min(baseY, yv), bw, Math.max(1, Math.abs(baseY - yv)));
        }
      } else {
        for (let col = 0; col < waveW; col++) {
          const b0 = rowFrom + Math.floor((col * bytes) / waveW);
          const b1 = rowFrom + Math.floor(((col + 1) * bytes) / waveW);
          if (b1 <= b0) continue;
          const step = Math.max(1, ((b1 - b0) / 8) | 0);
          let mn = 255, mx = 0;
          for (let p = b0; p < b1; p += step) {
            const v = bin[p];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          if (mn === 0 && mx === 0 && !covered[col]) continue; // swept memory
          // Anchored to the centre line, like the one-line waveform: the bar
          // always spans from the baseline out to the extreme, so a column
          // whose bytes are all on one side of centre is drawn on that side
          // rather than floating off it.
          const yTop = Math.min(baseY, baseY + (WAVE_H / 2) * ((128 - mx) / 128));
          const yBot = Math.max(baseY, baseY + (WAVE_H / 2) * ((128 - mn) / 128));
          ctx.fillRect(GUTTER_W + col, yTop, 1, Math.max(1, yBot - yTop));
        }
      }
    }
    this.drawOverlay();
  }

  drawOverlay() {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const dpr = uiDpr();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const C = themeColors();
    const { from, to } = this.range();
    const top = this.topRow();
    const waveW = this.waveWidth();
    const visible = Math.ceil(this.viewH() / ROW_H) + 1;
    const rowOf = (byte) => Math.floor((byte - from) / this.bytesPerRow);
    const xOf = (byte, row) =>
      GUTTER_W + (((byte - from) - row * this.bytesPerRow) / this.bytesPerRow) * waveW;

    // The drag selection: a band per line it crosses, plus a hard rule at each
    // END of it. A wash alone is easy to lose over a loud trace, and the two
    // edges are the numbers in the readout — they have to be findable.
    if (this.sel) {
      const r0 = Math.max(top, rowOf(this.sel.from));
      const r1 = Math.min(top + visible, rowOf(this.sel.to - 1) + 1);
      for (let row = r0; row < r1; row++) {
        const a = Math.max(this.sel.from, from + row * this.bytesPerRow);
        const b = Math.min(this.sel.to, from + (row + 1) * this.bytesPerRow);
        if (b <= a) continue;
        const y = (row - top) * ROW_H;
        ctx.fillStyle = C.accent2 ?? C.accent;
        ctx.globalAlpha = 0.28;
        ctx.fillRect(xOf(a, row), y, Math.max(2, xOf(b, row) - xOf(a, row)), WAVE_H);
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.accent;
        // A solid bar in the ribbon lane: the wash can be lost over a loud
        // trace, and this cannot.
        ctx.fillRect(xOf(a, row), y + WAVE_H, Math.max(2, xOf(b, row) - xOf(a, row)), RIBBON_H);
        if (a === this.sel.from) ctx.fillRect(Math.round(xOf(a, row)), y, 2, WAVE_H);
        if (b === this.sel.to) ctx.fillRect(Math.round(xOf(b, row)) - 2, y, 2, WAVE_H);
      }
    }

    // The AUDITION playhead — its own colour, because it is not a voice: the
    // preview is Web Audio over a copy of these bytes and owes nothing to the
    // engine. Drawn under the voice ticks so a song playing the same sample
    // still reads on top.
    if (this.preview.active) {
      const m = this.preview.meta;
      const f = this.preview.frame();
      if (m && f >= 0) {
        const addr = m.ptr + f;
        const row = rowOf(addr);
        if (addr >= from && addr < to && row >= top && row < top + visible) {
          ctx.fillStyle = C.accent;
          ctx.fillRect(Math.round(xOf(addr, row)) - 1, (row - top) * ROW_H, 2, WAVE_H);
        }
      }
    }

    // one tick per sounding voice, wherever its playhead is in memory
    const audio = this.store.audio;
    if (audio) {
      ctx.fillStyle = C.waveCursor ?? C.playCursor;
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
        if (!audio.getVoiceActive(vi)) continue;
        const addr = audio.getVoiceSamplePtr(vi) + audio.getVoiceSamplePos(vi);
        if (!(addr >= from) || addr >= to) continue;
        const row = rowOf(addr);
        if (row < top || row >= top + visible) continue;
        ctx.fillRect(Math.round(xOf(addr, row)) - 1, (row - top) * ROW_H, 2, WAVE_H);
      }
    }

    // the hover hairline, drawn last so nothing can hide the measuring line
    if (this.hoverByte >= from && this.hoverByte < to) {
      const row = rowOf(this.hoverByte);
      if (row >= top && row < top + visible) {
        const y = (row - top) * ROW_H;
        const hx = Math.round(xOf(this.hoverByte, row)) + 0.5;
        ctx.strokeStyle = C.fg;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(hx, y);
        ctx.lineTo(hx, y + WAVE_H);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
}
