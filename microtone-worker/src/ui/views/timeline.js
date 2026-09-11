// Timeline view (F1) — the multi-voice pattern grid across the whole song,
// canvas-rendered and row-virtualised. M5 scope: read-only navigation, follow
// mode, per-channel VU/pan header meters, cue-boundary gutter. Feature
// reference: taut.js VIEW_TIMELINE.

import { PATTERN_EMPTY } from "../../engine/constants.js";
import {
  AZIMUTH_TURN, ELEVATION_QUARTER, SURROUND_SPATIAL, lateralProjection,
} from "../../engine/spatial.js";
import { hex2, hex4, fxColonWarns } from "../notenames.js";
import { paintNoteCell, paintVolPanCell, paintFxCell, monoPalette } from "../glyphs.js";
import {
  interpretEditKey, interpretBracketKey, rawNoteView, SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG,
  SUB_FX2_OP, SUB_FX2_ARG, COL_FX, COL_FX2, lastSub,
  subPositions, subCharPos, charToSub, CELL_CHARS, CELL_CHARS_WIDE, CELL_CHARS_WIDE_FX2,
  lookahead, wheelStep, stepNoteCell,
  colsForSubs, subToCol, ALL_COLS, colCharRange, subIsEmpty,
  volPanStep, volPanState, elevationStep,
} from "../edit.js";
import { setCellOp, setCellsBytesOp, setCuesOp } from "../../doc/ops.js";
import { dittoGhosts } from "../../doc/ditto.js";
import {
  makeBlock, blockCell, cellToBytes, emptyCellBytes, overlayCols,
  fxPasteRemap, remapFxBytes,
} from "../../doc/clipboard.js";
import { themeColors } from "../theme.js";
import { canvasFont } from "../fonts.js";
import { unescapeName } from "../names.js";
import { paintSpatialDot } from "../spatialdot.js";
import { showContextMenu } from "../widgets/contextmenu.js";
import {
  clipboardItems, channelItems, newPatternItem, insertChannelAt,
  patternSlotItems, isPatternSlotItem, moveSlots, duplicateSlots,
  muteItems, runMuteItem, fx2Items, runFx2Item,
} from "../gridmenu.js";
import { blockToolItems, runBlockTool, isBlockTool } from "../blocktools.js";
import { rowBandItems, cueItems, beatItems, runRowTool, isRowTool, canSplitAt } from "../rowtools.js";
import { t } from "../i18n.js";

const FONT_PX = 13; // family comes from --cv-font via fonts.js
const CHAR_W = 7.9;
const ROW_H = 16;
const HEADER_H = 58;   // header: [voxnum·note+inst·patNum] / VU / pan / patName
const RADAR_H = 44;    // extra height when the surround radar is expanded (#998.6)
const GUTTER_W = 76;   // "cue:row | absrow"
const COL_W = Math.ceil(CELL_CHARS * CHAR_W) + 10;
// Format v3's wide cell needs three more characters for the panning column's
// elevation, so the channel column's width follows the document (§5.5) — and
// six more again on the channels showing their SECOND effect, which is why the
// strips are no longer all the same width.
const COL_W_WIDE = Math.ceil(CELL_CHARS_WIDE * CHAR_W) + 10;
const COL_W_WIDE_FX2 = Math.ceil(CELL_CHARS_WIDE_FX2 * CHAR_W) + 10;
const CHAN_STEP_PX = 120; // ≈ one mouse-wheel notch; horizontal scroll's "one channel" reference

export class TimelineView {
  constructor(store, canvas) {
    this.store = store;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scrollRow = 0;   // top visible absolute row (fractional while wheeling or follow-scrolling)
    this._wheelRem = 0;   // leftover row-units between wheel notches (see wheel listener below)
    this.scrollCh = 0;    // leftmost visible channel
    this._wheelChRem = 0; // leftover channel-units between horizontal wheel events
    this.map = null;      // songMap cache
    this.needsRedraw = true;
    this.lastPlayRow = -1; // remembered so resize() can repaint synchronously
    this.sel = null;       // block selection {aRow, aCh, row, ch} (absolute rows/channels)
    this._drag = null;     // active pointer-drag anchor {aRow, aCh}
    this._troughDrag = null; // active row-band drag down the trough {aRow}
    this._ghosts = new Map(); // per-frame memos, replaced at the top of draw()
    this._hasFx2 = new Map();

    store.on("doc", () => { this.map = null; this.scrollRow = 0; this.scrollCh = 0; this.sel = null; this.invalidate(); });
    store.on("edit", () => { this.map = null; this.invalidate(); });
    store.on("cursor", () => this.invalidate());
    store.on("mutes", () => this.invalidate());
    // Showing/hiding a second effect changes a strip's WIDTH and its cursor
    // walk, so the cursor may be standing on a sub-column that just vanished.
    store.on("fx2", () => { this.clampCursorSub(); this.invalidate(); });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Horizontal = Shift+wheel (which reports its delta in deltaX on most
      // platforms) OR a genuinely horizontal gesture (touchpad swipe / tilt
      // wheel: deltaX dominant). Read the delta off the axis that applies.
      const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const d = horiz ? (e.deltaX !== 0 ? e.deltaX : e.deltaY) : e.deltaY;
      // Record mode: wheel over the CURSOR cell increments/decrements the
      // hovered column (wheel up = +1); elsewhere the wheel scrolls. Horizontal
      // always means "scroll channels" — never a cell edit.
      // Never wheel-edit mid drag-selection — then the wheel only scrolls (item 57).
      if (!horiz && this.store.record && this._drag === null &&
          this.wheelEdit(e, d < 0 ? 1 : -1)) return;
      if (horiz) {
        const { step, remainder } = wheelStep(this._wheelChRem, d / CHAN_STEP_PX, 1);
        this._wheelChRem = remainder;
        if (step !== 0) {
          this.scrollCh = clampInt(this.scrollCh + step, 0, this.maxScrollCh());
          this.invalidate();
        }
      } else {
        const { step, remainder } = wheelStep(this._wheelRem, d / ROW_H);
        this._wheelRem = remainder;
        if (step !== 0) this.scrollBy(step);
      }
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    this.resize();
  }

  /** The canvas can be moved between split panes (item 148) — point the size
   *  observer at the stage it landed in and measure that one. */
  rehost() {
    this._ro.disconnect();
    this._ro.observe(this.canvas.parentElement);
    this.resize();
  }

  resize() {
    const host = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, Math.round(host.clientWidth * dpr));
    const h = Math.max(100, Math.round(host.clientHeight * dpr));
    // Skip no-op resizes (ResizeObserver fires on unrelated reflows too).
    if (this.canvas.width === w && this.canvas.height === h && this.dpr === dpr) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = host.clientWidth + "px";
    this.canvas.style.height = host.clientHeight + "px";
    this.dpr = dpr;
    // Setting canvas.width blanks the backing store; repaint synchronously
    // (ResizeObserver runs before paint) so the empty frame never shows — this
    // is the "moving the cursor in/out of the note column flickers" fix, since
    // that resizes the command palette and reflows the view host.
    this.needsRedraw = false;
    this.draw(this.lastPlayRow);
  }

  invalidate() { this.needsRedraw = true; }

  visibleRows() { return Math.floor((this.canvas.height / this.dpr - this.headerH()) / ROW_H); }

  /** Header height — the surround radar (#998.6) expands it for every channel. */
  headerH() { return HEADER_H + (this.radarOn() ? RADAR_H : 0); }

  /** True when the song is planar/spatial AND the radar toggle is on. */
  radarOn() {
    return this.store.surroundMeters === true &&
      (this.store.doc?.songs[this.store.songIndex]?.surroundModel ?? 0) !== 0;
  }
  /** The document's cell format — v3's wide cell changes the column layout. */
  wide() { return this.store.doc?.wideCells === true; }
  /** Is channel `ch` showing its second effect column (§5.5)? */
  fx2On(ch) { return this.store.fx2Chan(ch); }
  /** Width of channel `ch`'s strip — per channel, because the second effect is
   *  exposed per channel. */
  colWFor(ch) {
    if (!this.wide()) return COL_W;
    return this.fx2On(ch) ? COL_W_WIDE_FX2 : COL_W_WIDE;
  }
  /** Cursor walk order within channel `ch` — six sub-columns, or eight. */
  subPosFor(ch) { return subPositions(this.wide(), this.fx2On(ch)); }
  /** The last logical column channel `ch` shows (what "the whole cell" means). */
  lastColFor(ch) { return this.fx2On(ch) ? COL_FX2 : COL_FX; }

  /** Canvas width available to the channel strips. */
  gridW() { return this.canvas.width / this.dpr - GUTTER_W; }

  /**
   * The visible channel strips, left to right: `[{ch, x, w}]` from `scrollCh`
   * until the canvas runs out (the last one may be clipped). Strips differ in
   * width, so every x in this view is a running sum rather than `i * COL_W` —
   * this is the one place that sum is computed.
   */
  chanLayout() {
    const chans = this.store.doc?.channelCount ?? 0;
    const W = this.canvas.width / this.dpr;
    const out = [];
    let x = GUTTER_W;
    for (let ch = this.scrollCh; ch < chans && x < W; ch++) {
      const w = this.colWFor(ch);
      out.push({ ch, x, w });
      x += w;
    }
    return out;
  }

  /**
   * The strip under canvas `x`, or null (in the gutter, or past the last
   * channel — empty space to the right belongs to no channel).
   *
   * `clamp` makes the last strip swallow everything to its right, which is what
   * a drag wants: pulling the pointer off the end of the grid should keep
   * extending the block through the last channel rather than stopping dead.
   * The context menu deliberately does NOT clamp — right-clicking blank space
   * is not right-clicking channel 32.
   */
  stripAt(x, clamp = false) {
    if (x < GUTTER_W) return null;
    const chans = this.store.doc?.channelCount ?? 0;
    let sx = GUTTER_W;
    let last = null;
    for (let ch = this.scrollCh; ch < chans; ch++) {
      const w = this.colWFor(ch);
      last = { ch, x: sx, w };
      if (x < sx + w) return last;
      sx += w;
    }
    return clamp ? last : null;
  }

  /** How many strips fit WHOLE from the current scroll — the count the
   *  cursor-follow lookahead reasons in. */
  visibleChans() {
    const chans = this.store.doc?.channelCount ?? 32;
    const avail = this.gridW();
    let acc = 0, n = 0;
    for (let ch = this.scrollCh; ch < chans; ch++) {
      const w = this.colWFor(ch);
      if (acc + w > avail) break;
      acc += w;
      n++;
    }
    return Math.max(1, n);
  }

  /** Leftmost channel that still leaves the grid full — walked from the RIGHT,
   *  since the strips are no longer a fixed width to divide by. */
  maxScrollCh() {
    const chans = this.store.doc?.channelCount ?? 32;
    const avail = this.gridW();
    let acc = 0, first = chans;
    while (first > 0) {
      const w = this.colWFor(first - 1);
      if (acc + w > avail) break;
      acc += w;
      first--;
    }
    return Math.max(0, Math.min(first, chans - 1));
  }

  /** Put the cursor back on a sub-column its channel actually shows — called
   *  when a second effect column is hidden out from under it. */
  clampCursorSub() {
    const c = this.store.cursor;
    if (c.sub > SUB_FX_ARG && !this.fx2On(c.ch)) { c.sub = SUB_FX_ARG; c.nib = 3; }
  }

  getMap() {
    if (this.map === null && this.store.song) this.map = this.store.song.songMap();
    return this.map;
  }

  scrollBy(rows) {
    const map = this.getMap();
    if (!map) return;
    this.scrollRow = Math.max(0, Math.min(this.scrollRow + rows, map.totalRows - 4));
    this.invalidate();
  }

  /** Centre an absolute row (follow mode / cursor jumps). */
  centreRow(row) {
    const map = this.getMap();
    if (!map) return;
    const want = row - this.visibleRows() / 2;
    this.scrollRow = Math.max(0, Math.min(want, Math.max(0, map.totalRows - 4)));
    this.invalidate();
  }

  /**
   * One channel's surround radar (#998.6): the horizon circle seen from above,
   * front at the top, with the sounding voice as a dot. Elevation shrinks the
   * radius (overhead = dead centre), which is what makes the pan strip above it
   * the dot's own horizontal shadow. A spatial song also gets a height tick on
   * the right edge.
   */
  paintChannelRadar(ctx, C, x, y, ch, colW, audio, spatialSong) {
    const r = (RADAR_H - 10) / 2;
    const cx = x + (colW - 2) / 2;
    const cy = y + RADAR_H / 2 - 3;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // front tick + centre (the listener)
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 2);
    ctx.lineTo(cx, cy - r + 3);
    ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    if (!audio || !audio.getVoiceActive(ch)) return;

    const az = audio.getVoiceAzimuth(ch);
    const el = audio.getVoiceElevation(ch);
    const k = Math.cos((el * Math.PI) / (2 * ELEVATION_QUARTER));
    const rad = ((az - 128) * 2 * Math.PI) / AZIMUTH_TURN;
    const dx = Math.sin(rad) * k * r;
    const dy = -Math.cos(rad) * k * r;
    const vol = audio.getVoiceEffectiveVolume(ch);
    ctx.strokeStyle = C.meterBg;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.stroke();
    const dotR = 2 + 2.5 * Math.min(vol * 2, 1);
    if (spatialSong) {
      // Height cue (#998.6): the dot grows as it rises and casts a shadow that
      // slides away from the light — the dial alone cannot tell up from down.
      paintSpatialDot(ctx, cx + dx, cy + dy, el, r, dotR, C.accent2);
    } else {
      ctx.fillStyle = C.accent2;
      ctx.beginPath();
      ctx.arc(cx + dx, cy + dy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    // The dot's shadow on the left/right line — the same number the pan strip
    // above is showing, so the two readings visibly belong together.
    ctx.fillStyle = C.dim;
    ctx.fillRect(cx + dx - 0.5, cy - 2, 1, 4);

    if (spatialSong) {
      // Height bar: centre line = ear level, up = above.
      const bx = x + colW - 10;
      const half = r;
      ctx.strokeStyle = C.border;
      ctx.beginPath();
      ctx.moveTo(bx, cy - half);
      ctx.lineTo(bx, cy + half);
      ctx.moveTo(bx - 2, cy);
      ctx.lineTo(bx + 2, cy);
      ctx.stroke();
      const ey = cy - (el / ELEVATION_QUARTER) * half;
      ctx.fillStyle = C.accent2;
      ctx.fillRect(bx - 3, ey - 1, 6, 2);
    }
  }

  /** Map absolute song row → {entry, rowInCue} via the song map. */
  locate(absRow) {
    const map = this.getMap();
    if (!map || map.entries.length === 0) return null;
    // linear scan is fine (≤ a few thousand cues); binary-search later if needed
    for (let i = map.entries.length - 1; i >= 0; i--) {
      const e = map.entries[i];
      if (absRow >= e.startRow) {
        const rowInCue = absRow - e.startRow;
        if (rowInCue >= e.rowLimit) return null; // past end
        return { entry: e, rowInCue };
      }
    }
    return null;
  }

  onPointerDown(e) {
    // Primary button only — the secondary one belongs to the context menu, and
    // without this it would also move the cursor / toggle the header's mute
    // underneath the menu it just opened.
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < this.headerH()) {
      // channel header: click = mute toggle, Ctrl/⌘+click = solo toggle
      const ch = this.channelAt(x);
      if (ch >= 0) {
        if (e.ctrlKey || e.metaKey) this.store.toggleSolo(ch);
        else this.store.toggleMute(ch);
      }
      return;
    }
    if (this.inTrough(x)) { this.troughPointerDown(e, y); return; }
    const hit = this.hitTest(x, y);
    if (!hit) return;
    if (e.shiftKey) {
      // Shift+click extends a FULL-column block from the current cursor.
      const c = this.store.cursor;
      const end = lastSub(this.fx2On(hit.ch));
      if (!this.sel) this.sel = { aRow: c.row, aCh: c.ch, aSub: 0, row: hit.row, ch: hit.ch, sub: end };
      else { this.sel.row = hit.row; this.sel.ch = hit.ch; this.sel.aSub = 0; this.sel.sub = end; }
    } else {
      // Mouse-drag carries sub-column granularity (the hit's sub-position).
      this.sel = null;
      this._drag = { aRow: hit.row, aCh: hit.ch, aSub: hit.sub };
      this.canvas.setPointerCapture?.(e.pointerId);
    }
    this.store.cursor = hit;
    this.store.emit("cursor");
    this.invalidate();
  }

  // ── the row trough (item 136) ──
  // The numbered gutter down the left addresses SONG ROWS rather than cells, so
  // it selects and acts on whole rows: a drag there is a row band across every
  // channel, which is what the insert/delete row commands take as their span.

  /** Is canvas `x` in the trough (rather than over a channel strip)? */
  inTrough(x) { return x < GUTTER_W; }

  /** Absolute row at canvas `y`, clamped into the song (a drag that runs off
   *  the top or bottom keeps extending to the end, it does not stop dead). */
  rowAt(y) {
    const map = this.getMap();
    if (!map || map.totalRows === 0) return -1;
    const r = Math.floor(this.scrollRow) + Math.floor((y - this.headerH()) / ROW_H);
    return clampInt(r, 0, map.totalRows - 1);
  }

  /** True when the selection is a full-width band — what a trough drag makes,
   *  and what the row commands describe themselves against. */
  isRowBand() {
    const b = this.selBounds();
    return !!b && b.c0 === 0 && b.c1 >= (this.store.doc?.channelCount ?? 1) - 1;
  }

  /** Select a row band from `a` to `b`, every channel, every sub-column. */
  selectRowBand(a, b) {
    const last = (this.store.doc?.channelCount ?? 1) - 1;
    this.sel = { aRow: a, aCh: 0, aSub: 0, row: b, ch: last, sub: lastSub(this.fx2On(last)) };
  }

  troughPointerDown(e, y) {
    const row = this.rowAt(y);
    if (row < 0) return;
    // Shift extends the band that is already there (or from the cursor row),
    // exactly as it does in a spreadsheet's row headers.
    const anchor = e.shiftKey ? (this.sel?.aRow ?? this.store.cursor.row) : row;
    this.selectRowBand(anchor, row);
    this._troughDrag = { aRow: anchor };
    this.canvas.setPointerCapture?.(e.pointerId);
    this.store.cursor.row = row;
    this.store.emit("cursor");
    this.invalidate();
  }

  onPointerMove(e) {
    if (!this._drag && !this._troughDrag) return;
    const rect = this.canvas.getBoundingClientRect();
    if (this._troughDrag) {
      const row = this.rowAt(e.clientY - rect.top);
      if (row < 0) return;
      this.selectRowBand(this._troughDrag.aRow, row);
      this.store.cursor.row = row;
      this.store.emit("cursor");
      this.invalidate();
      return;
    }
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    // ANY drag makes a block — including one that never leaves the cell, or
    // never leaves a single column. "Just the pan column of this row" is a
    // selection worth copying, and a degenerate one is still a real answer to
    // "what did I drag over". A plain click fires no pointermove at all, so
    // that remains the way to have no selection.
    this.sel = {
      aRow: this._drag.aRow, aCh: this._drag.aCh, aSub: this._drag.aSub,
      row: hit.row, ch: hit.ch, sub: hit.sub,
    };
    const c = this.store.cursor;
    c.row = hit.row; c.ch = hit.ch; c.sub = hit.sub; c.nib = hit.nib;
    this.store.emit("cursor");
    this.invalidate();
  }

  onPointerUp(e) {
    if (this._drag || this._troughDrag) {
      this.canvas.releasePointerCapture?.(e.pointerId);
      this._drag = null;
      this._troughDrag = null;
    }
  }

  // ── right-click context menu ──

  /** Channel under a canvas x — the whole strip, header and grid alike — or -1
   *  when x is in the gutter or past the last channel. */
  channelAt(x) { return this.stripAt(x)?.ch ?? -1; }

  /**
   * Context menu (icon-cell palette). Anywhere on a channel — its header or any
   * row down its strip — offers the two channel inserts. On the grid it also
   * offers the clipboard: copy/cut while a block is selected, paste onto a cell
   * that has a pattern to paste into; a cell whose cue slot is EMPTY offers a
   * fresh pattern instead (the two are mutually exclusive by construction), and
   * one that is FILLED offers to move or duplicate what is in it (item 103.1).
   *
   * The second row depends on where the pointer is: over the grid it is the
   * column tools, over the HEADER — where there are no cells for them to act on
   * — it is that channel's mute/solo (item 103.2).
   */
  async onContextMenu(e) {
    e.preventDefault();
    const store = this.store;
    if (!store.doc || !store.song) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (this.inTrough(x)) {
      if (y >= this.headerH()) await this.troughMenu(e, y);
      return;
    }
    const ch = this.channelAt(x);
    if (ch < 0) return;
    const chans = store.doc.channelCount;
    const surroundModel = store.doc.songs[store.songIndex]?.surroundModel ?? 0;

    // The "no pattern here" target: a grid row (not the header) inside the song
    // whose cue leaves this channel empty.
    const hit = this.hitTest(x, y);
    const loc = hit ? this.locate(hit.row) : null;
    // Two different questions, and conflating them once cost Paste its cell:
    // whether the CLICKED cell has a pattern (Paste needs somewhere to write
    // cells into), and whether ANY slot the block covers is free (what "New
    // pattern" would fill).
    const clickedEmpty = loc !== null &&
      (store.song.cues[loc.entry.cue][ch] & 0x7fff) === PATTERN_EMPTY;
    const slots = this.slotsInBlock(hit, ch);
    const emptySlots = slots.filter((s) =>
      (store.song.cues[s.cue][s.ch] & 0x7fff) === PATTERN_EMPTY);

    const items = [
      ...clipboardItems({
        hasSelection: this.hasSelection(),
        canPaste: !!store.clipboard && hit !== null && !clickedEmpty &&
          this.cellAt(hit.row, ch) !== null,
        selAnchored: this.hasSelection(),
      }),
      ...channelItems(ch, chans),
    ];
    if (loc !== null && emptySlots.length > 0) items.push(newPatternItem());
    items.push(...patternSlotItems(store, slots));

    // Second row: over the grid, the column tools aimed at the selection's
    // column band or at the single column under the pointer; over the HEADER,
    // that channel's mutes (item 103.2). The header is about the channel, not
    // about a block someone left selected elsewhere, so it wins outright rather
    // than only when there happens to be nothing for the tools to act on.
    const onHeader = y < this.headerH();
    const cells = onHeader ? [] : this.toolCells(hit, ch);
    const cols = onHeader ? [] : this.toolCols(hit);
    const second = onHeader
      ? [...muteItems(store, ch), ...fx2Items(store, ch)]
      : (cells.length > 0
          ? blockToolItems(cols, { surround: surroundModel !== 0,
              wide: store.doc.wideCells === true, block: this.hasSelection() })
          : []);

    const pick = await showContextMenu(e.clientX, e.clientY, [items, second]);
    if (isBlockTool(pick)) {
      const anchor = this.toolAnchor(hit, ch);
      if (await runBlockTool(pick, { store, cells, cols, lanes: this.toolLanes(hit, ch),
        anchor, scope: this.toolScope(cells) })) {
        this.invalidate();
      }
      return;
    }
    if (isPatternSlotItem(pick)) { this.runSlotItem(pick, slots); return; }
    if (runMuteItem(store, pick, ch)) return;
    if (runFx2Item(store, pick, ch)) return;
    switch (pick) {
      case "copy": this.copySelection(); break;
      case "cut": this.cutSelection(); break;
      case "paste":
        // With no block selected, paste goes to the cursor — so put the cursor
        // where the menu was opened, or the paste would land somewhere the user
        // is not even looking. With a selection, its top-left already wins.
        if (!this.hasSelection()) {
          store.cursor.row = hit.row;
          store.cursor.ch = ch;
          store.emit("cursor");
        }
        this.paste();
        break;
      case "insLeft": this.insertChannel(ch); break;
      case "insRight": this.insertChannel(ch + 1); break;
      case "newPat": this.createPattern(loc.entry.cue, ch, hit.row, emptySlots); break;
    }
  }

  /**
   * The trough's own menu (item 136): the row commands over the band that was
   * right-clicked, and the row highlighting underneath them.
   *
   * The band is the trough's own row selection when the click landed inside it,
   * and otherwise the single row under the pointer — which is also what a
   * right-click OUTSIDE the selection means: you are pointing at this row, not
   * at the one you selected earlier.
   */
  async troughMenu(e, y) {
    const store = this.store;
    if (!store.doc || !store.song) return;
    const row = this.rowAt(y);
    if (row < 0) return;
    const b = this.isRowBand() ? this.selBounds() : null;
    const band = b && row >= b.r0 && row <= b.r1
      ? { row0: b.r0, row1: b.r1 }
      : { row0: row, row1: row };
    if (band.row0 === row && band.row1 === row) {
      // Acting on one row: put the cursor on it, so what happens next is
      // visibly about the row that was clicked.
      this.selectRowBand(row, row);
      store.cursor.row = row;
      store.emit("cursor");
      this.invalidate();
    }
    const n = band.row1 - band.row0 + 1;
    const pick = await showContextMenu(e.clientX, e.clientY,
      [rowBandItems(n), cueItems(canSplitAt(store.song, band.row0)), beatItems()]);
    if (!isRowTool(pick)) return;
    if (await runRowTool(pick, { store, ...band })) {
      // The order list may be a different shape now: drop the selection, put
      // the cursor back inside the song and rebuild the map.
      this.sel = null;
      this.map = null;
      const total = this.getMap()?.totalRows ?? 0;
      store.cursor.row = clampInt(store.cursor.row, 0, Math.max(0, total - 1));
      store.emit("cursor");
      this.invalidate();
    }
  }

  /** Logical columns the second row's tools should cover: the selection's
   *  column band, else the single column under the pointer. */
  toolCols(hit) {
    if (this.hasSelection()) return this.selCols();
    return hit ? [subToCol(hit.sub)] : [];
  }

  /** Deduped [{pat, row}] the tools act on: every cell of the block selection,
   *  else the one cell under the pointer. Channels sharing a pattern would
   *  otherwise yield the same (pat,row) twice and corrupt the undo capture. */
  toolCells(hit, ch) {
    const seen = new Map();
    const push = (t) => { if (t) seen.set(`${t.pat}:${t.rowInCue}`, { pat: t.pat, row: t.rowInCue }); };
    const b = this.selBounds();
    if (b) {
      for (let r = b.r0; r <= b.r1; r++) {
        for (let c = b.c0; c <= b.c1; c++) push(this.cellAt(r, c));
      }
    } else if (hit) {
      push(this.cellAt(hit.row, ch));
    }
    return [...seen.values()];
  }

  /**
   * The same cells as toolCells, but kept as ONE LANE PER CHANNEL in song-row
   * order — what an interpolation runs down.
   *
   * A song row this channel has no pattern on becomes a `null` rather than
   * being left out, because the lane's SPACING is the curve's x axis: drop the
   * holes and a ramp written across a gap in the song arrives at the wrong
   * slope on the far side of it.
   */
  toolLanes(hit, ch) {
    const b = this.selBounds();
    const lanes = [];
    if (b) {
      for (let c = b.c0; c <= b.c1; c++) {
        const lane = [];
        for (let r = b.r0; r <= b.r1; r++) {
          const t0 = this.cellAt(r, c);
          lane.push(t0 ? { pat: t0.pat, row: t0.rowInCue } : null);
        }
        lanes.push(lane);
      }
    } else if (hit) {
      const t0 = this.cellAt(hit.row, ch);
      if (t0) lanes.push([{ pat: t0.pat, row: t0.rowInCue }]);
    }
    return lanes;
  }

  /** The cell a tool reads its STARTING state from (the panner's dial): the
   *  block's top-left when there is a selection, else the clicked cell. */
  toolAnchor(hit, ch) {
    const b = this.selBounds();
    const row = b ? b.r0 : hit.row;
    const channel = b ? b.c0 : ch;
    const t0 = this.cellAt(row, channel);
    return t0
      ? { pat: t0.pat, row: t0.rowInCue, channel, rowLabel: String(row) }
      : { pat: -1, row: 0, channel, rowLabel: String(row) };
  }

  /** Human label for the modals' "this applies to …" line. */
  toolScope(cells) {
    const b = this.selBounds();
    return b
      ? t("ctx.scopeBlock", { rows: b.r1 - b.r0 + 1, chans: b.c1 - b.c0 + 1 })
      : t("ctx.scopeCell", { n: cells.length });
  }

  insertChannel(at) {
    if (insertChannelAt(this.store, at)) this.invalidate();
  }

  /** Move / duplicate the patterns in `slots` (item 103.1). A move takes the
   *  block selection with it, so the same block can be walked across several
   *  channels without re-selecting it after every step — clamped, because only
   *  the block's FILLED slots had to have somewhere to go, and a selection can
   *  reach past them into empty channels. */
  runSlotItem(id, slots) {
    const dir = id === "movLeft" ? -1 : 1;
    const ok = id === "dupPat"
      ? duplicateSlots(this.store, slots)
      : moveSlots(this.store, slots, dir);
    if (!ok) return;
    if (id !== "dupPat" && this.sel) {
      const last = this.store.doc.channelCount - 1;
      this.sel = {
        ...this.sel,
        aCh: clampInt(this.sel.aCh + dir, 0, last),
        ch: clampInt(this.sel.ch + dir, 0, last),
      };
    }
    this.invalidate();
  }

  /** The (cue, ch) slots the tools' block covers — a Timeline selection is
   *  rows × channels, and many rows map onto the same cue, so this collapses
   *  them. Deduped, in reading order. */
  slotsInBlock(hit, ch) {
    const b = this.selBounds();
    const seen = new Map();
    const add = (row, c) => {
      const loc = this.locate(row);
      if (loc) seen.set(`${loc.entry.cue}:${c}`, { cue: loc.entry.cue, ch: c });
    };
    if (b) {
      for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) add(r, c);
    } else if (hit) {
      add(hit.row, ch);
    }
    return [...seen.values()];
  }

  /** Point every EMPTY cue slot the block covers at a brand-new pattern number,
   *  one each, lowest first. The patterns themselves materialise on their first
   *  edit — item 48 — so this is just cue words, in one undo step. */
  createPattern(cue, ch, row, slots = null) {
    const store = this.store;
    const song = store.song;
    const targets = (slots ?? [{ cue, ch }])
      .filter((s) => (song.cues[s.cue][s.ch] & 0x7fff) === PATTERN_EMPTY);
    if (targets.length === 0) return;
    const nums = song.freePatternNumbers(targets.length);
    const writes = targets.slice(0, nums.length).map((s, i) => ({
      cue: s.cue, ch: s.ch,
      value: (song.cues[s.cue][s.ch] & 0x8000) | (nums[i] & 0x7fff),
    }));
    if (!writes.length) return;
    store.undo.apply(setCuesOp(store.songIndex, writes));
    // Land the cursor on what was just created — the point of making it is to
    // start typing into it.
    store.cursor.row = row;
    store.cursor.ch = ch;
    store.emit("cursor");
    this.invalidate();
  }

  // ── block selection + clipboard ──
  hasSelection() { return this.sel !== null; }
  clearSelection() { if (this.sel) { this.sel = null; this.invalidate(); } }

  /** Ctrl+A — select the whole column of the cursor's channel (single voice):
   *  every row, all sub-columns. */
  selectColumn() {
    const map = this.getMap();
    if (!map) return;
    const ch = this.store.cursor.ch;
    this.sel = { aRow: 0, aCh: ch, aSub: 0, row: map.totalRows - 1, ch,
      sub: lastSub(this.fx2On(ch)) };
    this.invalidate();
    this.store.emit("cursor");
  }

  /** Normalised inclusive bounds {r0,r1,c0,c1,colLo,colHi}, or null. colLo/colHi
   *  are the logical-column band (all columns when the selection has no sub
   *  span, e.g. keyboard selections). */
  selBounds() {
    const s = this.sel;
    if (!s) return null;
    const aSub = s.aSub ?? 0, sub = s.sub ?? SUB_FX_ARG;
    return {
      r0: Math.min(s.aRow, s.row), r1: Math.max(s.aRow, s.row),
      c0: Math.min(s.aCh, s.ch), c1: Math.max(s.aCh, s.ch),
      colLo: subToCol(Math.min(aSub, sub)), colHi: subToCol(Math.max(aSub, sub)),
    };
  }

  /** Logical columns the selection covers (for partial copy/paste/clear). */
  selCols() {
    const s = this.sel;
    return s ? colsForSubs(s.aSub ?? 0, s.sub ?? SUB_FX_ARG) : ALL_COLS;
  }

  /** Anchor a keyboard selection at the current cursor cell/column if none is
   *  active. Keyboard selection carries the SAME sub-column granularity as a
   *  mouse drag: it anchors on the cursor's sub and tracks it as the cursor
   *  moves, so Shift+↑/↓ grow the row span and Shift+←/→ the column band. */
  _ensureSel() {
    const c = this.store.cursor;
    if (!this.sel) this.sel = { aRow: c.row, aCh: c.ch, aSub: c.sub, row: c.row, ch: c.ch, sub: c.sub };
  }

  /** Keyboard block-extend (Shift+↑/↓, Page, Home/End): grow the row span,
   *  tracking the cursor's sub-column band. */
  extendSelection(dRow, dCh) {
    const map = this.getMap();
    if (!map) return;
    this._ensureSel();
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    c.row = clampInt(c.row + dRow, 0, map.totalRows - 1);
    c.ch = clampInt(c.ch + dCh, 0, chans - 1);
    this.clampCursorSub(); // the channel we landed on may show fewer columns
    this.sel.row = c.row; this.sel.ch = c.ch; this.sel.sub = c.sub;
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  /** Shift+←/→: extend the selection by walking the sub-cursor (crossing
   *  channels at the edges, like moveSubCursor), so the block carries
   *  sub-column granularity just like a mouse drag. */
  extendSelectionSub(dir) {
    const map = this.getMap();
    if (!map) return;
    this._ensureSel();
    const c = this.store.cursor;
    this.stepSubCursor(dir);
    this.sel.ch = c.ch; this.sel.sub = c.sub; this.sel.row = c.row;
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  /**
   * Walk the cursor one sub-position, crossing into the neighbouring channel at
   * either end. The walk order is that CHANNEL's — a channel showing its second
   * effect has eight sub-columns and its neighbour may have six — so the index
   * is re-seated against the destination channel's list after every crossing.
   */
  stepSubCursor(dir) {
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    let idx = this.subPosFor(c.ch).findIndex(([s, n]) => s === c.sub && n === c.nib);
    if (idx < 0) idx = 0;
    idx += dir;
    if (idx < 0) {
      if (c.ch > 0) { c.ch--; idx = this.subPosFor(c.ch).length - 1; } else idx = 0;
    } else if (idx >= this.subPosFor(c.ch).length) {
      if (c.ch < chans - 1) { c.ch++; idx = 0; } else idx = this.subPosFor(c.ch).length - 1;
    }
    [c.sub, c.nib] = this.subPosFor(c.ch)[idx];
  }

  /** Dedupe writes by (pat,row) — channels sharing a pattern would otherwise
   *  produce two writes to the same cell and corrupt the undo capture. */
  dedupeWrites(fn) {
    const map = new Map();
    fn((pat, row, bytes) => map.set(`${pat}:${row}`, { pat, row, bytes: Uint8Array.from(bytes) }));
    return [...map.values()];
  }

  copySelection() {
    const b = this.selBounds();
    if (!b) return false;
    const rows = b.r1 - b.r0 + 1, chans = b.c1 - b.c0 + 1;
    const block = makeBlock(rows, chans, this.wide());
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < chans; c++) {
        const t = this.cellAt(b.r0 + r, b.c0 + c);
        if (t) blockCell(block, r, c).set(cellToBytes(t.cell, this.wide()));
      }
    }
    block.cols = this.selCols(); // which logical columns the paste will carry
    this.store.clipboard = block;
    return true;
  }

  cutSelection() {
    if (!this.copySelection()) return false;
    this.clearRegion(this.selBounds(), this.selCols());
    return true;
  }

  deleteSelection() {
    const b = this.selBounds();
    if (!b) return false;
    this.clearRegion(b, this.selCols());
    return true;
  }

  clearRegion(b, cols = ALL_COLS) {
    const empty = emptyCellBytes(this.wide());
    const writes = this.dedupeWrites((push) => {
      for (let r = b.r0; r <= b.r1; r++) {
        for (let ch = b.c0; ch <= b.c1; ch++) {
          const t = this.cellAt(r, ch);
          // overlay only the selected columns' empty bytes onto the cell
          if (t) push(t.pat, t.rowInCue, overlayCols(cellToBytes(t.cell, this.wide()), empty, cols, this.wide()));
        }
      }
    });
    if (writes.length) {
      this.store.undo.apply(setCellsBytesOp(this.store.songIndex, writes));
      this.invalidate();
    }
  }

  /** Where a paste lands: the TOP-LEFT of the block selection when there is
   *  one — the corner you started the drag from, not the cursor, which sits
   *  wherever the drag happened to end — otherwise the cursor. */
  pasteAnchor() {
    const b = this.selBounds();
    const c = this.store.cursor;
    return b ? { row: b.r0, ch: b.c0 } : { row: c.row, ch: c.ch };
  }

  paste() {
    const block = this.store.clipboard;
    if (!block) return false;
    const wide = this.wide();
    // An effect-column block pastes into whichever effect column the caret is
    // on, first slot or second (item 127); everything else lands where it came
    // from. `cols` follows the remap so the OTHER slot is left alone.
    const remap = fxPasteRemap(block.cols, subToCol(this.store.cursor.sub ?? 0), wide);
    const cols = remap ? [remap.to] : (block.cols ?? ALL_COLS);
    const a = this.pasteAnchor();
    const writes = this.dedupeWrites((push) => {
      for (let r = 0; r < block.rows; r++) {
        for (let ch = 0; ch < block.chans; ch++) {
          const t = this.cellAt(a.row + r, a.ch + ch);
          // merge only the block's columns onto the destination cell
          if (t) push(t.pat, t.rowInCue, overlayCols(cellToBytes(t.cell, wide), remapFxBytes(blockCell(block, r, ch), remap, wide), cols, wide));
        }
      }
    });
    if (!writes.length) return false;
    this.store.undo.apply(setCellsBytesOp(this.store.songIndex, writes));
    const map = this.getMap();
    const chans = this.store.doc.channelCount;
    this.sel = {
      aRow: a.row, aCh: a.ch, aSub: 0, sub: lastSub(this.fx2On(a.ch)),
      row: Math.min(a.row + block.rows - 1, map.totalRows - 1),
      ch: Math.min(a.ch + block.chans - 1, chans - 1),
    };
    this.invalidate();
    return true;
  }

  /** Canvas-relative coords → {row, ch, sub, nib}, or null off-grid. */
  hitTest(x, y) {
    if (y < this.headerH()) return null;
    const row = Math.floor(this.scrollRow) + Math.floor((y - this.headerH()) / ROW_H);
    const map = this.getMap();
    if (!map || row < 0 || row >= map.totalRows) return null;
    const strip = this.stripAt(x, true);
    if (!strip) return null;
    const charX = (x - strip.x - 2) / CHAR_W;
    const [sub, nib] = charToSub(charX, this.wide(), this.fx2On(strip.ch));
    return { row, ch: strip.ch, sub, nib };
  }

  /**
   * Wheel-over-the-cursor-cell editing (record mode): the hovered column steps
   * by one unit — notes by one degree of the ACTIVE pitch table (a quarter-tone
   * in 24-TET, a semitone in 12-TET…), inst/vol/pan/fx by ±1. Consecutive
   * ticks coalesce into one undo entry.
   */
  wheelEdit(e, dir) {
    const store = this.store;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return false;
    const c = store.cursor;
    if (hit.row !== c.row || hit.ch !== c.ch) return false;
    const target = this.cursorCell();
    if (!target) return false;
    const cell = target.cell;
    // An empty sub-column (shown as dots) is not wheel-editable — the wheel just
    // scrolls the view instead of conjuring a value out of nothing.
    if (subIsEmpty(hit.sub, cell)) return false;

    let fields = null;
    switch (hit.sub) {
      case SUB_NOTE: fields = { note: stepNoteCell(cell.note, store.pitchPreset, dir) }; break;
      case SUB_INST: fields = { instrment: clampInt(cell.instrment + dir, 0, 255) }; break;
      // vol/pan: a fine slide steps its SIGNED delta (item 87), everything else
      // the plain value; neither ever steps into the no-op sentinel.
      case SUB_VOL: fields = volPanStep(false, cell, dir, this.wide()); break;
      case SUB_PAN:
        // In a wide cell the panning column's first two digits are the
        // elevation, which steps on its own signed axis.
        fields = this.wide() && c.nib >= 1 && c.nib <= 2
          ? elevationStep(cell, dir)
          : volPanStep(true, cell, dir, this.wide());
        break;
      case SUB_FX_OP: fields = { effect: clampInt(cell.effect + dir, 0, 35) }; break;
      case SUB_FX_ARG: fields = { effectArg: clampInt(cell.effectArg + dir, 0, 0xffff) }; break;
      case SUB_FX2_OP: fields = { effect2: clampInt(cell.effect2 + dir, 0, 35) }; break;
      case SUB_FX2_ARG: fields = { effectArg2: clampInt(cell.effectArg2 + dir, 0, 0xffff) }; break;
    }
    if (fields === null) return false;
    store.undo.apply(setCellOp(store.songIndex, target.pat, target.rowInCue, fields,
      `wheel:${target.pat}:${target.rowInCue}:${c.ch}:${hit.sub}`));
    this.invalidate();
    return true;
  }

  moveCursor(dRow, dCh) {
    const map = this.getMap();
    if (!map) return;
    this.sel = null; // plain navigation drops any block selection
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    c.row = clampInt(c.row + dRow, 0, map.totalRows - 1);
    c.ch = clampInt(c.ch + dCh, 0, chans - 1);
    this.clampCursorSub(); // the channel we landed on may show fewer columns
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  /** Move through sub-positions (nibble-level), wrapping across channels. */
  moveSubCursor(dir) {
    this.sel = null; // plain navigation drops any block selection
    this.stepSubCursor(dir);
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  // Lookahead-scrolling (item 42): the cursor moves freely inside the central
  // 64% of the viewport; the view only scrolls once the cursor enters the 18%
  // edge band, and then just enough to bring it back to that band's boundary.
  // (Playback follow still centres — it uses centreRow, not this.)
  keepCursorVisible() {
    const map = this.getMap();
    if (!map) return;
    const c = this.store.cursor;
    this.scrollRow = lookahead(c.row, this.scrollRow, this.visibleRows(),
      Math.max(0, map.totalRows - this.visibleRows()));
    this.scrollCh = lookahead(c.ch, this.scrollCh, this.visibleChans(), this.maxScrollCh());
  }

  /** Read view of pattern `patNum`: the materialised one, else the shared empty
   *  pattern — a cue may address any number (item 48), and an unmaterialised one
   *  displays and edits as empty (the first edit materialises it via the op).
   *  Same contract as PatternPane.pattern(). */
  patternFor(patNum) {
    const { store } = this;
    return store.doc.patternAt(store.songIndex, patNum) ?? store.doc.emptyPattern();
  }

  /**
   * Ditto ghost map for a pattern played under a cue of `rowLimit` rows
   * (the endRow clamp is cue-dependent, so that's part of the cache key).
   * Rebuilt per draw — patterns repeat across channels, hence the memo.
   */
  ghostsFor(patNum, rowLimit) {
    const key = `${patNum}:${rowLimit}`;
    let g = this._ghosts.get(key);
    if (g === undefined) {
      g = dittoGhosts(this.patternFor(patNum), rowLimit);
      this._ghosts.set(key, g);
    }
    return g;
  }

  /** The pattern cell at (row, ch), or null (empty cue slot / off-map). */
  cellAt(row, ch) {
    const { store } = this;
    if (ch < 0 || ch >= store.doc.channelCount) return null;
    const loc = this.locate(row);
    if (!loc) return null;
    const patNum = store.song.cues[loc.entry.cue][ch] & 0x7fff;
    if (patNum === PATTERN_EMPTY) return null;
    return { pat: patNum, rowInCue: loc.rowInCue, cell: this.patternFor(patNum)[loc.rowInCue] };
  }

  /** The pattern cell under the cursor, or null (empty cue slot / off-map). */
  cursorCell() { return this.cellAt(this.store.cursor.row, this.store.cursor.ch); }

  /**
   * Record-mode key dispatch. Returns true when consumed. `jam` provides
   * octave/currentInst context and auditions entered notes.
   */
  processEditKey(e, jam) {
    const store = this.store;
    if (!store.record) return false;
    const target = this.cursorCell();
    if (!target) return false;
    const c = store.cursor;
    const action = interpretEditKey(
      { code: e.code, key: e.key, repeat: e.repeat }, c.sub, c.nib, target.cell,
      { octave: jam.octave, currentInst: jam.currentInst, preset: store.pitchPreset,
        rawHex: rawNoteView(store.rawNoteView, store.pitchPreset),
        wideCells: store.doc?.wideCells === true });
    if (!action) return false;

    if (action.fields) {
      store.undo.apply(setCellOp(store.songIndex, target.pat, target.rowInCue, action.fields));
    }
    if (action.jamNote !== undefined) {
      jam.hold(e.code, action.jamNote);
    }
    if (action.advanceNib) {
      this.moveSubCursor(1);
    } else if (action.advanceRow) {
      c.nib = 0; // field complete: back to its first nibble
      this.moveCursor(store.editStep, 0);
    }
    this.invalidate();
    return true;
  }

  /** Contextual bracket-key cell edit (item 47.6), record mode only. Returns
   *  true when consumed. */
  bracketEdit(dir, shift) {
    const store = this.store;
    if (!store.record) return false;
    const target = this.cursorCell();
    if (!target) return false;
    const action = interpretBracketKey(dir, shift, store.cursor.sub, target.cell,
      { preset: store.pitchPreset, instSlots: store.doc.selectableInstrumentSlots() });
    if (!action) return false;
    store.undo.apply(setCellOp(store.songIndex, target.pat, target.rowInCue, action.fields));
    this.invalidate();
    return true;
  }

  /** Per-frame: follow playback + repaint when needed. */
  frame() {
    const store = this.store;
    if (!store.doc) return;
    const audio = store.audio;
    let playRow = -1;
    if (audio && audio.isPlaying()) {
      const map = this.getMap();
      const cue = audio.getCuePosition();
      const entry = map?.entries[cue];
      if (entry) {
        playRow = entry.startRow + Math.min(audio.getTrackerRow(), entry.rowLimit - 1);
        if (store.follow) {
          const centred = playRow - this.visibleRows() / 2;
          const target = Math.max(0, Math.min(centred, map.totalRows - 4));
          if (Math.abs(target - this.scrollRow) > 0.01) {
            this.scrollRow = target;
            this.needsRedraw = true;
          }
        }
      }
      this.needsRedraw = true; // meters + playhead move every frame while playing
    }
    if (this.needsRedraw) {
      this.needsRedraw = false;
      this.draw(playRow);
    }
  }

  /** Pattern number assigned to channel `ch` at the current play/cursor cue. */
  currentPatternFor(ch) {
    const song = this.store.song;
    if (!song) return null;
    const map = this.getMap();
    const audio = this.store.audio;
    let entry = null;
    if (audio && audio.isPlaying() && map) entry = map.entries[audio.getCuePosition()];
    else { const loc = this.locate(this.store.cursor.row); entry = loc?.entry ?? null; }
    if (!entry) return null;
    const words = song.cues[entry.cue];
    if (!words) return null;
    return words[ch] & 0x7fff;
  }

  draw(playRow) {
    if (playRow === undefined) playRow = -1;
    this.lastPlayRow = playRow;
    this._ghosts = new Map(); // ditto ghost maps, memoised for this frame only
    this._hasFx2 = new Map(); // "does this pattern use effect 2", same lifetime
    const C = themeColors();
    const { ctx, store } = this;
    const dpr = this.dpr;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const doc = store.doc;
    const song = store.song;
    if (!doc || !song) return;
    const map = this.getMap();
    const strips = this.chanLayout(); // [{ch, x, w}] — widths differ per channel
    const visRows = this.visibleRows() + 1;
    const top = Math.floor(this.scrollRow);
    const audio = store.audio;

    ctx.font = canvasFont(FONT_PX);
    ctx.textBaseline = "middle";

    // ── channel headers: two text rows split by the VU/pan meters ──
    //   upper: voxnum (L) · live note+inst (C) · pattern number (R, amber)
    //   lower: pattern name (C) — the rename display, alongside the number above
    const headPal = { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent };
    const NOTE_H = 15, UP_Y = 4, UP_MID = UP_Y + NOTE_H / 2; // upper row
    const VU_Y = 23, PAN_Y = 32;                             // meters
    // The radar (#998.6) slots in between the pan strip and the name row.
    const radar = this.radarOn();
    const headerH = this.headerH();
    const RADAR_Y = 44;
    const NAME_Y = 49 + (radar ? RADAR_H : 0);
    const surroundModel = store.doc?.songs[store.songIndex]?.surroundModel ?? 0;
    const surroundSong = surroundModel !== 0;
    const spatialSong = surroundModel === SURROUND_SPATIAL;
    for (const { ch, x: stripX, w: colW } of strips) {
      // A header panel is the CELL's rectangle, not the strip's: every grid
      // cell is painted from `x - 2` and the channel boundary rule sits on its
      // right edge, so a header drawn from `x` overhangs that rule by 2 px and
      // its text sits 2 px right of the notes underneath it (item 137). The
      // whole header block therefore shares the cell origin.
      const x = stripX - 2;
      ctx.fillStyle = ch % 2 ? C.panel : C.panel2;
      ctx.fillRect(x, 0, colW - 2, headerH - 2);
      const patNum = this.currentPatternFor(ch);

      // upper row: channel number (left) + current pattern number (right, amber)
      ctx.fillStyle = C.dim;
      ctx.textAlign = "left";
      ctx.fillText(String(ch + 1).padStart(2, "0"), x + 4, UP_MID);
      // …and, between them, the hint that this channel is HIDING second effects
      // it actually carries — the column is off by default, so without this the
      // only way to find out is to turn it on channel by channel.
      if (!this.fx2On(ch) && this.patternHasFx2(patNum)) {
        ctx.fillStyle = C.fxOp;
        ctx.globalAlpha = 0.75;
        ctx.fillText("ƒx2", x + 4 + 2.4 * CHAR_W, UP_MID);
        ctx.globalAlpha = 1;
      }
      if (patNum !== null && patNum !== PATTERN_EMPTY) {
        ctx.fillStyle = C.accent;
        ctx.textAlign = "right";
        ctx.fillText(hex4(patNum), x + colW - 6, UP_MID);
        ctx.textAlign = "left";
      }
      // upper row centre: live note + instrument (only while sounding)
      if (audio && audio.getVoiceActive(ch)) {
        const groupX = x + Math.round((colW - 7 * CHAR_W) / 2);
        paintNoteCell(ctx, audio.getVoiceNote(ch), store.pitchPreset, groupX, UP_Y,
          CHAR_W, NOTE_H, headPal, store.rawNoteView);
        ctx.fillStyle = C.dim;
        ctx.fillText(hex2(audio.getVoiceInstrument(ch)), groupX + 5 * CHAR_W, UP_MID);
      }

      // VU
      const barX = x + 4;
      const barW = colW - 12;
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(barX, VU_Y, barW, 7);
      if (audio && audio.getVoiceActive(ch)) {
        const vol = audio.getVoiceEffectiveVolume(ch);
        ctx.fillStyle = C.meter;
        ctx.fillRect(barX, VU_Y, Math.round(barW * vol), 7);
      }
      // pan — in a surround song the strip is the ORTHOGONAL PROJECTION of the
      // source onto the left/right line, i.e. the shadow of the radar dot
      // below: height and depth both collapse onto it, so a hard-left source
      // 60° up reads half-left and one directly behind reads centre.
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(barX, PAN_Y + 2, barW, 3);
      let pan = 0.5;
      if (audio) {
        pan = surroundSong
          ? 0.5 + 0.5 * lateralProjection(audio.getVoiceAzimuth(ch), audio.getVoiceElevation(ch))
          : audio.getVoiceEffectivePan(ch) / 255;
      }
      ctx.fillStyle = C.accent2;
      ctx.fillRect(barX + pan * (barW - 3), PAN_Y, 3, 7);

      // expanded radar: the source as it really sits, seen from above
      if (radar) {
        this.paintChannelRadar(ctx, C, x, RADAR_Y, ch, colW, audio, spatialSong);
      }

      // lower row: pattern name, centred + clipped to the column width
      if (patNum !== null && patNum !== PATTERN_EMPTY) {
        const nm = unescapeName(this.store.doc.patternName(patNum));
        if (nm) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 2, NAME_Y - 8, colW - 6, 16);
          ctx.clip();
          ctx.fillStyle = C.fg2;
          ctx.textAlign = "center";
          ctx.fillText(nm, x + (colW - 2) / 2, NAME_Y);
          ctx.restore();
          ctx.textAlign = "left";
        }
      }

      // muted channel: dim the header, MUTE tag over the meters
      if (store.voiceMutes[ch]) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = C.bg;
        ctx.fillRect(x, 0, colW - 2, headerH - 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.fg2;
        ctx.textAlign = "center";
        ctx.fillText("MUTE", x + (colW - 2) / 2, (VU_Y + PAN_Y) / 2 + 3);
        ctx.textAlign = "left";
      }
    }

    // ── rows ──
    const cursor = store.cursor;
    const dittoPal = monoPalette(C.ditto); // ghost cells (pattern ditto)
    const fxPal = { op: C.fxOp, a1: C.fxA1, a2: C.fxA2, a3: C.fxA3, dim: C.dim, ext: C.fxExt };
    const sb = this.selBounds(); // block selection bounds (or null)
    const rowBand = this.isRowBand(); // …and whether it spans every channel
    const beats = store.beats(); // primary/secondary divisions from sMet
    for (let r = 0; r < visRows; r++) {
      const absRow = top + r;
      const y = headerH + r * ROW_H;
      const loc = this.locate(absRow);
      if (!loc) continue;
      const { entry, rowInCue } = loc;

      // row background banding from the song's beat divisions
      if (absRow === playRow) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (rowInCue % beats.sec === 0) {
        ctx.fillStyle = C.rowBar;
        ctx.fillRect(GUTTER_W, y, W - GUTTER_W, ROW_H);
      } else if (rowInCue % beats.pri === 0) {
        ctx.fillStyle = C.rowBeat;
        ctx.fillRect(GUTTER_W, y, W - GUTTER_W, ROW_H);
      }

      // cue boundary line
      if (rowInCue === 0) {
        ctx.strokeStyle = C.cueLine;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
        ctx.stroke();
      }

      // gutter: "cue:row" (cue is 4-digit hex); beat rows highlighted; the
      // cursor row gets its own background so it's findable at a glance.
      // A row BAND (a trough drag) is marked in the trough too — the grid
      // highlight alone leaves it invisible wherever the channels are empty,
      // which is exactly where a row edit is easiest to get wrong.
      if (rowBand && absRow >= sb.r0 && absRow <= sb.r1) {
        ctx.fillStyle = C.sel;
        ctx.fillRect(0, y, GUTTER_W - 4, ROW_H);
      }
      if (absRow === cursor.row) {
        ctx.fillStyle = C.cursor;
        ctx.fillRect(0, y, GUTTER_W - 4, ROW_H);
      }
      ctx.textAlign = "left";
      ctx.fillStyle = absRow === cursor.row ? C.fg
        : rowInCue === 0 ? C.accent
        : rowInCue % beats.pri === 0 ? C.fg : C.dim;
      ctx.fillText(
        `${entry.cue.toString(16).toUpperCase().padStart(4, "0")}:${rowInCue.toString(16).toUpperCase().padStart(2, "0")}`,
        6, y + ROW_H / 2);

      // cells
      for (const { ch, x, w: colW } of strips) {
        const fx2 = this.fx2On(ch);
        if (sb && absRow >= sb.r0 && absRow <= sb.r1 && ch >= sb.c0 && ch <= sb.c1) {
          ctx.fillStyle = C.sel;
          if (sb.colLo === 0 && sb.colHi >= this.lastColFor(ch)) {
            ctx.fillRect(x - 2, y, colW - 2, ROW_H); // whole cell
          } else { // partial column band
            const ccr = colCharRange(this.wide(), fx2);
            const cs = ccr[sb.colLo][0], ce = ccr[Math.min(sb.colHi, this.lastColFor(ch))][1];
            ctx.fillRect(x + 2 + cs * CHAR_W - 1, y, (ce - cs) * CHAR_W + 2, ROW_H);
          }
        }
        if (absRow === cursor.row && ch === cursor.ch) {
          ctx.fillStyle = C.cursor;
          ctx.fillRect(x - 2, y, colW - 2, ROW_H);
          // sub-column caret: amber in record mode, blue otherwise
          const [cpos, cw] = subCharPos(cursor.sub ?? 0, cursor.nib ?? 0, this.wide());
          ctx.fillStyle = store.record ? C.caret : C.caretNav;
          ctx.fillRect(x + 2 + cpos * CHAR_W - 1, y, cw * CHAR_W + 2, ROW_H);
        }
        const patNum = entry.info ? (this.store.song.cues[entry.cue][ch] & 0x7fff) : PATTERN_EMPTY;
        if (patNum === PATTERN_EMPTY) {
          continue;
        }
        const cell = this.patternFor(patNum)[rowInCue];
        // Pattern-ditto (effect 7): the rows the engine repeats show the
        // would-be-played source values in grey wherever the cell is blank.
        const ghost = this.ghostsFor(patNum, entry.rowLimit)[rowInCue] ?? null;
        // Note glyphs: taut-style vector accidentals/ticks/sentinels, CJK
        // Shi'er lü via a conventional font, hex4 for raw/off-grid notes.
        if (ghost && ghost.note !== null) {
          paintNoteCell(ctx, ghost.note, store.pitchPreset, x + 2, y, CHAR_W, ROW_H,
            dittoPal, store.rawNoteView);
        } else {
          paintNoteCell(ctx, cell.note, store.pitchPreset, x + 2, y, CHAR_W, ROW_H,
            { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent },
            store.rawNoteView);
        }
        const instS = ghost?.inst != null ? hex2(ghost.inst)
          : cell.instrment !== 0 ? hex2(cell.instrment) : "··";

        ctx.fillStyle = ghost?.inst != null ? C.ditto
          : cell.instrment !== 0 ? C.accent2 : C.dim;
        if (cell.instrment === 0 && !(ghost?.inst != null)) ctx.globalAlpha = 0.4;
        ctx.fillText(instS, x + 2 + 5 * CHAR_W, y + ROW_H / 2);
        ctx.globalAlpha = 1;
        // vol/pan: symbol cell (vector ticks) + argument digits — item 87
        const wide = this.wide();
        const vol = ghost?.vol ?? [cell.volume, cell.volumeEff];
        paintVolPanCell(ctx, vol[0], vol[1], false, x + 2 + 8 * CHAR_W, y, CHAR_W, ROW_H,
          { ink: ghost?.vol ? C.ditto : C.meter, dim: C.dim, wide });
        // A wide cell's panning column IS the azimuth, with the elevation in
        // front of it in its own ink (§5.5).
        const pan = ghost?.pan ?? [wide ? cell.azimuth : cell.pan, cell.panEff];
        paintVolPanCell(ctx, pan[0], pan[1], true, x + 2 + 12 * CHAR_W, y, CHAR_W, ROW_H,
          { ink: ghost?.pan ? C.ditto : C.colPan, dim: C.dim, wide,
            elevation: wide ? cell.elevation : 0, elevationInk: C.accent2,
          // On the sphere, ear level is a stated position, not an absent one.
          spatial: (store.doc?.songs[store.songIndex]?.surroundModel ?? 0) === SURROUND_SPATIAL });
        // Effect column: one shade of amber per argument field (item 120), or
        // — when this row's `:` needs a second look (fxColonWarns: `:` on the
        // first slot, paired with a command that ignores it, or a second `:`
        // behind the one an interrupt row is reading) — that cell in red. The
        // flag is per SLOT, so an interrupt row can redden the losing `:` and
        // leave the winning one painting normally.
        const warn = wide ? fxColonWarns(cell.effect, cell.effect2, ghost?.note ?? cell.note) : 0;
        const fx = ghost?.fx ?? [cell.effect, cell.effectArg];
        paintFxCell(ctx, fx[0], fx[1], x + 2 + (wide ? 19 : 16) * CHAR_W, y, CHAR_W, ROW_H,
          ghost?.fx ? dittoPal : fxPal, (warn & 1) !== 0, cell.effect2);
        // …and the second effect in the same inks, since it is the same column
        // twice (§5.5). Ditto never reaches it: effect 7 repeats the SOURCE
        // row's first effect, and the ghost map has no second slot to fill.
        if (fx2) {
          paintFxCell(ctx, cell.effect2, cell.effectArg2,
            x + 2 + 25 * CHAR_W, y, CHAR_W, ROW_H, fxPal, (warn & 2) !== 0, cell.effect);
        }
      }
    }

    // gutter/header separators
    ctx.strokeStyle = C.border;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W - 4.5, 0);
    ctx.lineTo(GUTTER_W - 4.5, H);
    ctx.moveTo(0, this.headerH() - 1.5);
    ctx.lineTo(W, this.headerH() - 1.5);
    // A rule down each channel BOUNDARY. The headers are already separated by
    // their alternating panels, but the grid rows are not, and the strips are
    // no longer a uniform width to count by — so where one channel ends and the
    // next begins is the division worth drawing. The space between the two
    // effect groups is separation enough for them.
    // Sits in the middle of the 10 px every column carries past its last
    // character, so it never crowds a cell; the last channel gets none, or the
    // grid would end on a rule with nothing beyond it.
    const lastCh = (doc.channelCount ?? 0) - 1;
    for (const { ch, x, w } of strips) {
      if (ch >= lastCh) continue;
      const sx = Math.round(x + w - 4) + 0.5;
      ctx.moveTo(sx, headerH);
      ctx.lineTo(sx, H);
    }
    ctx.stroke();
  }

  /** Does pattern `patNum` carry any second effect? Memoised for the frame —
   *  one pattern is usually on several channels. Only asked of a v3 document. */
  patternHasFx2(patNum) {
    if (!this.wide() || patNum === null || patNum === PATTERN_EMPTY) return false;
    let has = this._hasFx2.get(patNum);
    if (has === undefined) {
      has = this.patternFor(patNum).some((c) => c.effect2 !== 0 || c.effectArg2 !== 0);
      this._hasFx2.set(patNum, has);
    }
    return has;
  }
}

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
