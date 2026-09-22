// Cues view (F2) — the order list: cue rows × lane columns of pattern
// numbers, plus the two per-cue instruction words (Cmd1/Cmd2 — BAK/FWD/JMP/
// LEN/HALT, encoded in the sign bits of ch 0-15 / 16-31). Edits are eager-
// synced to the worklet (DocSync). Feature reference: taut.js VIEW_CUES.

import { CUE_EMPTY, MAX_VOICES, NUM_CUES, NUM_CUES_64 } from "../../format/taud-const.js";
import { cueInstructionWords } from "../../format/taud-parse.js";
import { cueInfo } from "../../doc/document.js";
import { INST_NOP, INST_GOBACK, INST_SKIP, INST_JUMP, INST_PATLEN, INST_HALTAT, INST_HALT } from "../../engine/state.js";
import { setCuesOp } from "../../doc/ops.js";
import { lookahead } from "../edit.js";
import { makeCueBlock, cueBlockIndex, mergeCueWord } from "../../doc/clipboard.js";
import { showModal } from "../widgets/modal.js";
import { showContextMenu } from "../widgets/contextmenu.js";
import { ICON } from "../icons.js";
import { LongPress, longPressable, paintPerimeterGauge } from "../longpress.js";
import {
  clipboardItems, channelItems, newPatternItem, insertChannelAt,
  patternSlotItems, isPatternSlotItem, moveSlots, duplicateSlots, deleteSlots,
  openMenuAtCursor,
} from "../gridmenu.js";
import { themeColors } from "../theme.js";
import { canvasFont } from "../fonts.js";
import { unescapeName } from "../names.js";
import { t } from "../i18n.js";
import { uiDpr, localPoint } from "../zoom.js";

const FONT_PX = 13; // family comes from --cv-font via fonts.js
const CHAR_W = 7.9;
const ROW_H = 16;
const HEADER_H = 22;
const GUTTER_W = 52;             // cue index (4-digit hex)
const CMD_W = Math.ceil(9 * CHAR_W); // "HALT@40 " per word
const COL_W = Math.ceil(4 * CHAR_W) + 8; // 4 hex digits per lane (0000..7FFE)

const INST_NAMES = {
  [INST_NOP]: "", [INST_HALT]: "HALT", [INST_HALTAT]: "HALT@",
  [INST_PATLEN]: "LEN·", [INST_GOBACK]: "BAK·", [INST_SKIP]: "FWD·", [INST_JUMP]: "JMP·",
};

function instToStr(inst) {
  if (inst.type === INST_NOP) return "····";
  const name = INST_NAMES[inst.type];
  if (inst.type === INST_HALT) return name;
  return name + inst.arg.toString(16).toUpperCase();
}

// Encode a command choice back to its 16-bit instruction word.
function encodeInstWord(kind, arg) {
  switch (kind) {
    case "nop": return 0;
    case "halt": return 0x0100;
    case "haltAt": return 0x0140 | (arg & 0x3f);
    case "len": return 0x0200 | ((arg - 1) & 0x3f);
    case "bak": return 0x8000 | (arg & 0xfff);
    case "fwd": return 0x9000 | (arg & 0xfff);
    case "jmp": return 0xf000 | (arg & 0xfff);
    default: return 0;
  }
}

export class CuesView {
  constructor(store, canvas) {
    this.store = store;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scrollCue = 0;
    this.scrollCh = 0;
    this.cursor = { cue: 0, col: 0, nib: 0 }; // col: 0/1 = cmd words, 2+ = lane-2
    // Block selection {aCue, aCh, cue, ch, cmd}. The grid has TWO spaces and a
    // block lives in exactly one of them: `cmd` true makes aCh/ch the Cmd word
    // SLOT (0 = Cmd1, 1 = Cmd2), false makes them lane indices. Nothing
    // straddles the two — an instruction word and a pattern number are not the
    // same kind of thing, so a rectangle across the boundary would mean nothing.
    this.sel = null;
    this._drag = null; // active pointer-drag anchor {aCue, aCh, cmd}
    this.needsRedraw = true;

    store.on("doc", () => { this.cursor = { cue: 0, col: 0, nib: 0 }; this.sel = null; this.scrollCue = 0; this.invalidate(); });
    store.on("edit", () => this.invalidate());

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Horizontal = Shift+wheel (which reports its delta in deltaX on most
      // platforms) OR a genuinely horizontal gesture (touchpad swipe / tilt
      // wheel: deltaX dominant). Read the delta off the axis that applies.
      const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const d = horiz ? (e.deltaX !== 0 ? e.deltaX : e.deltaY) : e.deltaY;
      if (horiz) this.scrollCh = Math.max(0, this.scrollCh + Math.sign(d) * 2);
      else this.scrollCue = clampInt(this.scrollCue + Math.sign(d) * 3, 0, this.maxScrollCue());
      this.invalidate();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", () => this.hold.cancel());
    canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    canvas.addEventListener("dblclick", () => this.openCmdEditor());

    // Press-and-hold opens the same menu on a touch screen (item 190.1).
    this.hold = new LongPress({
      onPaint: () => this.invalidate(),
      onFire: (press) => this.onContextMenu({
        clientX: press.clientX, clientY: press.clientY,
        preventDefault() {}, fromKeyboard: true,
      }),
    });
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
  }

  /** The canvas can be moved between split panes (item 148) — point the size
   *  observer at the stage it landed in and measure that one. */
  rehost() {
    this._ro.disconnect();
    this._ro.observe(this.canvas.parentElement);
    this.resize();
  }

  invalidate() { this.needsRedraw = true; }

  resize() {
    const host = this.canvas.parentElement;
    const dpr = uiDpr();
    this.canvas.width = Math.max(100, host.clientWidth * dpr);
    this.canvas.height = Math.max(100, host.clientHeight * dpr);
    this.canvas.style.width = host.clientWidth + "px";
    this.canvas.style.height = host.clientHeight + "px";
    this.dpr = dpr;
    this.invalidate();
  }

  visibleRows() { return Math.floor((this.canvas.height / this.dpr - HEADER_H) / ROW_H); }
  chanX(i) { return GUTTER_W + 2 * CMD_W + i * COL_W; }
  numCues() { return this.store.song?.cues.length ?? 0; }
  /** Scrollable/editable row count = the WHOLE cue address space (8192 / 4096),
   *  Excel-style: every row down to the hard limit is navigable and editable,
   *  but a cue is only materialised into the document when you write to it, so
   *  scrolling never bloats the save. Editing far down fills the gap in between
   *  (the accepted "cue 0 and 8191 ⇒ serialise 0..8191" caveat). */
  editRows() { return this.cueLimit(); }
  /** Top scroll position that still shows the last row (no scrolling into void). */
  maxScrollCue() { return Math.max(0, this.editRows() - this.visibleRows()); }
  /** Word for cue/ch, or CUE_EMPTY for an unmaterialised row past the cue list. */
  wordAt(cue, ch) {
    const words = this.store.song?.cues[cue];
    return words ? words[ch] : CUE_EMPTY;
  }

  /** The cue's two instruction words [Cmd1, Cmd2] — 0 (NOP) on a row the song
   *  has not materialised, which is exactly what its absence says. */
  instWordsAt(cue) {
    const words = this.store.song?.cues[cue];
    return words ? cueInstructionWords(words) : [0, 0];
  }

  /** Lane writes that put instruction `word` in cue `cue`'s Cmd `slot`,
   *  leaving every lane's pattern index alone. The word IS the sign bits of
   *  lanes 0-15 / 16-31 (taud-parse cueInstructionWords), so setting one
   *  command is sixteen one-bit edits — and the two slots never collide,
   *  because they own different lanes. */
  cmdWrites(cue, slot, word) {
    const base = slot * 16;
    const out = [];
    for (let i = 0; i < 16; i++) {
      const ch = base + i;
      out.push({ cue, ch, value: (this.wordAt(cue, ch) & 0x7fff) | (((word >> i) & 1) << 15) });
    }
    return out;
  }

  /** Canvas-relative x → {col} (0/1 = Cmd words, 2+ = lane-2), or -1 off-grid. */
  hitCol(x) {
    if (x < GUTTER_W) return -1;
    if (x < GUTTER_W + CMD_W) return 0;
    if (x < GUTTER_W + 2 * CMD_W) return 1;
    return 2 + this.scrollCh + Math.floor((x - GUTTER_W - 2 * CMD_W) / COL_W);
  }

  onPointerDown(e) {
    // Primary button only — the secondary one opens the context menu, and must
    // not move the cursor or drop the selection the menu is about to act on.
    if (e.button !== 0) return;
    const { x, y } = localPoint(this.canvas, e);
    if (longPressable(e)) this.hold.start(e, x, y, this.holdRect(x, y));
    if (y < HEADER_H) return;
    const cue = this.scrollCue + Math.floor((y - HEADER_H) / ROW_H);
    if (cue >= this.editRows()) return;
    const col = this.hitCol(x);
    if (col < 0) return;
    const cmd = col < 2;              // the Cmd words are a space of their own
    const idx = cmd ? col : col - 2;  // slot, or lane
    if (e.shiftKey) {
      // Shift+click extends a block from the cursor cell — but only inside the
      // space the cursor is already in, since no block straddles the two. From
      // the other space it does nothing rather than something arbitrary.
      const c = this.cursor;
      if ((c.col < 2) === cmd) {
        const aIdx = cmd ? c.col : c.col - 2;
        if (!this.sel || this.sel.cmd !== cmd) {
          this.sel = { aCue: c.cue, aCh: aIdx, cue, ch: idx, cmd };
        } else { this.sel.cue = cue; this.sel.ch = idx; }
      }
    } else {
      this.sel = null;
      this._drag = { aCue: cue, aCh: idx, cmd };
      this.canvas.setPointerCapture?.(e.pointerId);
    }
    this.cursor = { cue, col, nib: 0 };
    this.invalidate();
  }

  onPointerMove(e) {
    if (this.hold.active) {
      const p = localPoint(this.canvas, e);
      this.hold.moved(e, p.x, p.y);
    }
    if (!this._drag) return;
    const { x, y } = localPoint(this.canvas, e);
    const cue = clampInt(this.scrollCue + Math.floor((y - HEADER_H) / ROW_H), 0, this.editRows() - 1);
    const col = this.hitCol(x);
    const d = this._drag;
    // The drag keeps the space it started in: dragging a command block off the
    // side of the Cmd columns pins it to Cmd1/Cmd2 rather than turning into a
    // lane block halfway across.
    const idx = d.cmd ? clampInt(col, 0, 1)
      : clampInt(col - 2, 0, this.store.doc.channelCount - 1);
    // Any drag is a block, single-cell ones included (same rule as the other
    // two grids). A plain click fires no pointermove, so that is still how you
    // end up with no selection.
    this.sel = { aCue: d.aCue, aCh: d.aCh, cue, ch: idx, cmd: d.cmd };
    this.cursor = { cue, col: d.cmd ? idx : idx + 2, nib: 0 };
    this.invalidate();
  }

  onPointerUp(e) {
    this.hold.cancel();
    if (this._drag) {
      this.canvas.releasePointerCapture?.(e.pointerId);
      this._drag = null;
    }
  }

  // ── press-and-hold + the \ key (item 190) ──

  /** What the hold gauge is drawn around: the block the press landed inside,
   *  else the single slot under it. Canvas coordinates, or null off-grid. */
  holdRect(x, y) {
    if (y < HEADER_H) return null;
    const cue = this.scrollCue + Math.floor((y - HEADER_H) / ROW_H);
    const col = this.hitCol(x);
    if (cue >= this.editRows() || col < 0) return null;
    const sb = this.selBounds();
    if (col < 2) {
      const cb = sb?.cmd ? sb : null;
      const in2 = cb && cue >= cb.r0 && cue <= cb.r1 && col >= cb.c0 && col <= cb.c1;
      const [s0, s1] = in2 ? [cb.c0, cb.c1] : [col, col];
      return this.slotRect(in2 ? cb.r0 : cue, in2 ? cb.r1 : cue,
        GUTTER_W + s0 * CMD_W, (s1 - s0 + 1) * CMD_W);
    }
    const ch = col - 2;
    const b = sb && !sb.cmd ? sb : null;
    const inside = b && cue >= b.r0 && cue <= b.r1 && ch >= b.c0 && ch <= b.c1;
    const [c0, c1] = inside ? [b.c0, b.c1] : [ch, ch];
    // Clipped to the columns actually on screen at both ends, so a block that
    // runs off the side is ringed where it IS rather than past the edge.
    const lo = Math.max(c0, this.scrollCh);
    const hi = Math.min(c1, this.scrollCh + this.visibleChans() - 1);
    if (hi < lo) return null;
    const x0 = this.chanX(lo - this.scrollCh);
    const cols = hi - lo + 1;
    return this.slotRect(inside ? b.r0 : cue, inside ? b.r1 : cue, x0, cols * COL_W);
  }

  /** The canvas rectangle cues r0…r1 occupy over [x, x+w), clipped to what is
   *  actually on screen. */
  slotRect(r0, r1, x, w) {
    const y0 = HEADER_H + Math.max(0, r0 - this.scrollCue) * ROW_H;
    const y1 = HEADER_H + Math.min(this.visibleRows(), r1 - this.scrollCue + 1) * ROW_H;
    return y1 <= y0 ? null : { x, y: y0, w, h: y1 - y0 };
  }

  /** The \ key opens the right-click menu where the cursor is (item 190). */
  openMenuAtCursor() { return openMenuAtCursor(this); }

  /** Where the \ key's menu opens — the middle of the cursor's own cell,
   *  scrolled into view first. Canvas coordinates, or null with no song. */
  cursorPoint() {
    if (!this.store.song) return null;
    this.keepCursorVisible();
    this.invalidate();
    const c = this.cursor;
    const x = c.col < 2
      ? GUTTER_W + c.col * CMD_W + CMD_W / 2
      : this.chanX(c.col - 2 - this.scrollCh) + COL_W / 2;
    return { x, y: HEADER_H + (c.cue - this.scrollCue) * ROW_H + ROW_H / 2 };
  }

  moveCursor(dRow, dCol) {
    const chans = this.store.doc.channelCount;
    const c = this.cursor;
    this.sel = null; // plain navigation drops any block selection
    c.cue = clampInt(c.cue + dRow, 0, this.editRows() - 1);
    c.col = clampInt(c.col + dCol, 0, chans + 1);
    if (dCol !== 0) c.nib = 0;
    this.keepCursorVisible();
    this.invalidate();
  }

  // Lookahead-scroll: keep the cursor in the central 64% of the view (item 42).
  // Sideways too, on the same rule the Timeline uses — a column selection walks
  // the cursor across lanes, and a block growing into lanes nobody can see
  // is a block nobody can judge.
  keepCursorVisible() {
    this.scrollCue = lookahead(this.cursor.cue, this.scrollCue, this.visibleRows(), this.maxScrollCue());
    if (this.cursor.col >= 2) {
      this.scrollCh = lookahead(this.cursor.col - 2, this.scrollCh, this.visibleChans(),
        this.maxScrollCh());
    }
  }

  /** Whole lane columns the canvas shows, and the leftmost lane that
   *  still fills it — the sideways pair of visibleRows/maxScrollCue. */
  visibleChans() {
    // `dpr` is only set once the size observer has fired; 1 until then, so a
    // keystroke that arrives first scrolls by a sane number rather than by NaN.
    return Math.max(1, Math.floor((this.canvas.width / (this.dpr || 1) - this.chanX(0)) / COL_W));
  }
  maxScrollCh() {
    return Math.max(0, (this.store.doc?.channelCount ?? 0) - this.visibleChans());
  }

  // ── block selection + cue clipboard ──
  hasSelection() { return this.sel !== null; }
  /** …and specifically one in the space `cmd` names — what the two context
   *  menus ask, since neither can act on a block from the other one. */
  hasSelectionIn(cmd) { return this.sel !== null && (this.sel.cmd === true) === cmd; }
  clearSelection() { if (this.sel) { this.sel = null; this.invalidate(); } }

  /** The last cue row a whole-column selection reaches: the end of the CUE
   *  LIST, not of the address space the grid lets you scroll into. Selecting
   *  8192 mostly-imaginary rows would make one paste materialise the lot. */
  lastCue() { return Math.max(0, this.numCues() - 1); }

  /** Ctrl+A — select the whole column the cursor is in: every cue the song has,
   *  one lane — or, on a Cmd word, that command slot all the way down. The
   *  commands ARE a column; they just belong to the cue rather than to a lane. */
  selectColumn() {
    const c = this.cursor;
    const cmd = c.col < 2;
    const idx = cmd ? c.col : c.col - 2;
    this.sel = { aCue: 0, aCh: idx, cue: this.lastCue(), ch: idx, cmd };
    this.invalidate();
  }

  /** Ctrl+←/→ — widen (or narrow) that column block by one lane, anchor
   *  lane staying put and the far edge walking, exactly as the Timeline
   *  does it. With nothing selected it starts from Ctrl+A's block. On a command
   *  column there is exactly one neighbour, so it reaches Cmd1+Cmd2 and stops. */
  extendColumn(dir) {
    if (!this.sel) this.selectColumn();
    const s = this.sel;
    if (!s) return;
    const idx = clampInt(s.ch + dir, 0, s.cmd ? 1 : this.store.doc.channelCount - 1);
    s.ch = idx;
    s.aCue = 0; s.cue = this.lastCue();
    this.cursor.col = s.cmd ? idx : idx + 2;
    this.cursor.nib = 0;
    this.keepCursorVisible();
    this.invalidate();
  }

  /** Normalised inclusive bounds {r0,r1,c0,c1,cmd} — cue rows × whichever
   *  columns the block's own space names — or null. */
  selBounds() {
    const s = this.sel;
    if (!s) return null;
    return {
      r0: Math.min(s.aCue, s.cue), r1: Math.max(s.aCue, s.cue),
      c0: Math.min(s.aCh, s.ch), c1: Math.max(s.aCh, s.ch),
      cmd: s.cmd === true,
    };
  }

  _ensureSel() {
    const c = this.cursor;
    if (this.sel) return;
    const cmd = c.col < 2;
    const idx = cmd ? c.col : c.col - 2;
    this.sel = { aCue: c.cue, aCh: idx, cue: c.cue, ch: idx, cmd };
  }

  /** Shift+arrows: grow the block, moving the cursor with it. Sideways growth
   *  stays inside the block's own space — a command block reaches Cmd2 and
   *  stops, a lane block stops at lane 1 rather than falling into the
   *  commands. */
  extendSelection(dCue, dCol) {
    const c = this.cursor;
    // A block from the OTHER space is not one these arrows can grow — the
    // cursor is what the keyboard is holding, so it re-seeds from there.
    if (this.sel && (this.sel.cmd === true) !== (c.col < 2)) this.sel = null;
    this._ensureSel();
    const s = this.sel;
    const chans = this.store.doc.channelCount;
    c.cue = clampInt(c.cue + dCue, 0, this.editRows() - 1);
    c.col = s.cmd ? clampInt(c.col + dCol, 0, 1) : clampInt(c.col + dCol, 2, chans + 1);
    s.cue = c.cue; s.ch = s.cmd ? c.col : c.col - 2;
    this.keepCursorVisible();
    this.invalidate();
  }

  copySelection() {
    const b = this.selBounds();
    if (!b) return false;
    const rows = b.r1 - b.r0 + 1, cols = b.c1 - b.c0 + 1;
    const block = makeCueBlock(rows, cols, b.cmd);
    for (let r = 0; r < rows; r++) {
      const inst = b.cmd ? this.instWordsAt(b.r0 + r) : null;
      for (let c = 0; c < cols; c++) {
        block.words[cueBlockIndex(block, r, c)] = b.cmd
          // a whole instruction word …
          ? inst[b.c0 + c]
          // … or the pattern index only (strip the command sign bit)
          : this.wordAt(b.r0 + r, b.c0 + c) & 0x7fff;
      }
    }
    this.store.cueClipboard = block;
    return true;
  }

  cutSelection() {
    if (!this.copySelection()) return false;
    this.clearRegion(this.selBounds());
    return true;
  }

  deleteSelection() {
    const b = this.selBounds();
    if (!b) return false;
    this.clearRegion(b);
    return true;
  }

  /** Blank every cell in bounds — the pattern index, keeping the command bits,
   *  or (over a command block) the instruction, keeping every pattern index.
   *  Rows past the real cue list (unmaterialised) are skipped so a delete never
   *  materialises an empty cue. */
  clearRegion(b) {
    const nCues = this.numCues();
    const last = Math.min(b.r1, nCues - 1);
    const writes = [];
    if (b.cmd) {
      for (let cue = b.r0; cue <= last; cue++) {
        for (let slot = b.c0; slot <= b.c1; slot++) writes.push(...this.cmdWrites(cue, slot, 0));
      }
    } else {
      const chans = this.store.doc.channelCount;
      for (let cue = b.r0; cue <= last; cue++) {
        for (let ch = b.c0; ch <= Math.min(b.c1, chans - 1); ch++) {
          writes.push({ cue, ch, value: (this.wordAt(cue, ch) & 0x8000) | 0x7fff });
        }
      }
    }
    if (writes.length) {
      this.store.undo.apply(setCuesOp(this.store.songIndex, writes));
      this.invalidate();
    }
  }

  /** Where a paste lands: the top-left of the block selection when there is
   *  one IN THE CLIPBOARD'S OWN SPACE — the corner the drag started from, not
   *  the cursor, which ends up wherever the drag stopped — otherwise the
   *  cursor. Same rule as the other two grids. A command block pasted with the
   *  cursor parked on a lane has no slot to read off it, so it takes Cmd1. */
  pasteAnchor(cmd = false) {
    const b = this.selBounds();
    const c = this.cursor;
    if (b && b.cmd === cmd) return { cue: b.r0, ch: b.c0 };
    if (cmd) return { cue: c.cue, ch: c.col < 2 ? c.col : 0 };
    return { cue: c.cue, ch: Math.max(0, c.col - 2) };
  }

  /** Paste the cue clipboard, into whichever space the block came from — the
   *  two are never interchangeable. */
  paste() {
    const block = this.store.cueClipboard;
    if (!block) return false;
    return block.cmd ? this.pasteCmd(block) : this.pastePatterns(block);
  }

  pastePatterns(block) {
    const a = this.pasteAnchor(false);
    const chans = this.store.doc.channelCount;
    const limit = this.cueLimit();
    const writes = [];
    for (let r = 0; r < block.rows; r++) {
      const cue = a.cue + r;
      if (cue >= limit) break;
      for (let ch = 0; ch < block.chans; ch++) {
        const dch = a.ch + ch;
        if (dch >= chans) break; // clip past the last lane
        const src = block.words[cueBlockIndex(block, r, ch)];
        writes.push({ cue, ch: dch, value: mergeCueWord(this.wordAt(cue, dch), src) });
      }
    }
    if (!writes.length) return false;
    this.store.undo.apply(setCuesOp(this.store.songIndex, writes));
    this.sel = {
      aCue: a.cue, aCh: a.ch, cmd: false,
      cue: Math.min(a.cue + block.rows - 1, limit - 1),
      ch: Math.min(a.ch + block.chans - 1, chans - 1),
    };
    this.invalidate();
    return true;
  }

  /** Paste a command block: whole instruction words into the Cmd slots, every
   *  pattern index left exactly where it was. A row past the end of the cue
   *  list is materialised, as typing a command there would — except by a NOP,
   *  which is already what an absent cue says, so pasting blank commands past
   *  the end grows nothing. */
  pasteCmd(block) {
    const a = this.pasteAnchor(true);
    const limit = this.cueLimit();
    const nCues = this.numCues();
    const writes = [];
    for (let r = 0; r < block.rows; r++) {
      const cue = a.cue + r;
      if (cue >= limit) break;
      for (let c = 0; c < block.chans; c++) {
        const slot = a.ch + c;
        if (slot > 1) break; // clip past Cmd2
        const w = block.words[cueBlockIndex(block, r, c)];
        if (w === 0 && cue >= nCues) continue;
        writes.push(...this.cmdWrites(cue, slot, w));
      }
    }
    if (!writes.length) return false;
    this.store.undo.apply(setCuesOp(this.store.songIndex, writes));
    this.sel = {
      aCue: a.cue, aCh: a.ch, cmd: true,
      cue: Math.min(a.cue + block.rows - 1, limit - 1),
      ch: Math.min(a.ch + block.chans - 1, 1),
    };
    this.invalidate();
    return true;
  }

  /** The cue address space's hard end — one past the last index that exists. */
  cueLimit() { return this.store.doc?.is64Channel ? NUM_CUES_64 : NUM_CUES; }

  // ── right-click context menu ──

  /**
   * The same palette the Timeline shows, over the order list: the clipboard
   * cells, the two lane inserts (a Cues column IS a lane), and a fresh
   * pattern for an empty slot. The Cmd1/Cmd2 columns belong to the cue rather
   * than to any lane, so they get a menu of their own (cmdContextMenu).
   */
  async onContextMenu(e) {
    e.preventDefault();
    const store = this.store;
    if (!store.doc || !store.song) return;
    const { x, y } = localPoint(this.canvas, e);
    if (y < HEADER_H) return;
    const col = this.hitCol(x);
    if (col < 0) return; // the gutter
    const cue = this.scrollCue + Math.floor((y - HEADER_H) / ROW_H);
    if (cue >= this.editRows()) return;
    if (col < 2) { await this.cmdContextMenu(e, cue, col); return; }
    const chans = store.doc.channelCount;
    const ch = col - 2;
    if (ch >= chans) return;
    // An unmaterialised row past the cue list reads as empty, which is exactly
    // what "no pattern here" means — writing to it materialises the cue. Over a
    // block, "New pattern" fills every empty slot it covers, so the cell is
    // offered whenever ANY of them is free.
    const slots = this.slotsInBlock(cue, ch);
    const emptySlots = slots.filter((s) => (this.wordAt(s.cue, s.ch) & 0x7fff) === CUE_EMPTY);
    const emptySlot = emptySlots.length > 0;

    // Only a PATTERN block belongs here — a command block copied off Cmd1/Cmd2
    // has no meaning over a lane, and pastes from its own menu instead.
    const hasSel = this.hasSelectionIn(false);
    const items = [
      ...clipboardItems({
        hasSelection: hasSel,
        canPaste: store.cueClipboard?.cmd === false,
        selAnchored: hasSel,
      }),
      ...channelItems(ch, chans),
    ];
    if (emptySlot) items.push(newPatternItem());
    // …and a slot that HAS one can send it sideways or unshare it (item 103.1),
    // which here is the same cue-word arithmetic the Timeline does.
    items.push(...patternSlotItems(store, slots));

    // The Cues grid holds pattern NUMBERS, not note cells, so it has no second
    // row: none of the column tools has anything to act on here.
    const pick = await showContextMenu(e.clientX, e.clientY, [items],
      { keyboard: e.fromKeyboard === true });
    if (isPatternSlotItem(pick)) { this.runSlotItem(pick, slots); return; }
    switch (pick) {
      case "copy": this.copySelection(); break;
      case "cut": this.cutSelection(); break;
      case "paste":
        // No block for it to anchor on: paste where the menu was opened, not
        // wherever the cursor happens to be sitting.
        if (!hasSel) { this.cursor = { cue, col, nib: 0 }; }
        this.paste();
        break;
      case "insLeft": this.insertChannel(ch); break;
      case "insRight": this.insertChannel(ch + 1); break;
      case "newPat": this.createPattern(cue, ch, emptySlots); break;
    }
  }

  /**
   * The Cmd columns' own menu: the cue clipboard over the command space, plus
   * the command editor — which over a block fills every Cmd word it covers with
   * the one instruction, so a run of cues gets its `LEN` in a single step.
   *
   * The lane cells' own palette is deliberately absent: an instruction word
   * belongs to the cue, so inserting a lane or making a pattern has nothing
   * to do here.
   */
  async cmdContextMenu(e, cue, slot) {
    const store = this.store;
    const hasSel = this.hasSelectionIn(true);
    const items = [
      ...clipboardItems({
        hasSelection: hasSel,
        canPaste: store.cueClipboard?.cmd === true,
        selAnchored: hasSel,
      }),
      { id: "cmdFill", label: t(hasSel ? "ctx.cmdFill" : "ctx.cmdSet"),
        icon: ICON.cmdFill,
        title: t(hasSel ? "ctx.cmdFillTitle" : "ctx.cmdSetTitle") },
    ];
    const pick = await showContextMenu(e.clientX, e.clientY, [items],
      { keyboard: e.fromKeyboard === true });
    // Without a block, both actions work on the cell the menu was opened over,
    // not on wherever the cursor happens to be sitting.
    if ((pick === "paste" || pick === "cmdFill") && !hasSel) {
      this.cursor = { cue, col: slot, nib: 0 };
    }
    switch (pick) {
      case "copy": this.copySelection(); break;
      case "cut": this.cutSelection(); break;
      case "paste": this.paste(); break;
      case "cmdFill": this.openCmdEditor(); break;
    }
  }

  insertChannel(at) {
    if (insertChannelAt(this.store, at)) this.invalidate();
  }

  /** Move / duplicate / delete the patterns in `slots` (item 103.1). A move carries the
   *  selection along so the block can be walked lane by lane — clamped,
   *  because only the block's FILLED slots had to have somewhere to go, and a
   *  selection can reach past them into empty lanes. */
  runSlotItem(id, slots) {
    const dir = id === "movLeft" ? -1 : 1;
    const moving = id === "movLeft" || id === "movRight";
    const ok = id === "dupPat" ? duplicateSlots(this.store, slots)
      : id === "delPat" ? deleteSlots(this.store, slots)
      : moveSlots(this.store, slots, dir);
    if (!ok) return;
    if (moving && this.sel && !this.sel.cmd) {
      const last = this.store.doc.channelCount - 1;
      this.sel = {
        ...this.sel,
        aCh: clampInt(this.sel.aCh + dir, 0, last),
        ch: clampInt(this.sel.ch + dir, 0, last),
      };
    }
    this.invalidate();
  }

  /** The (cue, lane) slots a block covers — the selection, else the one cell
   *  under the pointer. Clipped to the lane count; rows past the stored cue
   *  list are fine, since writing one materialises it. */
  slotsInBlock(cue, ch) {
    const chans = this.store.doc.channelCount;
    const b = this.selBounds();
    if (!b || b.cmd) return [{ cue, ch }]; // a command block covers no slots
    const out = [];
    for (let c = b.r0; c <= Math.min(b.r1, this.editRows() - 1); c++) {
      for (let v = b.c0; v <= Math.min(b.c1, chans - 1); v++) out.push({ cue: c, ch: v });
    }
    return out;
  }

  /** Point every EMPTY slot in `targets` at a brand-new pattern number, one
   *  each, lowest first — over a block that is one fresh pattern per slot, in a
   *  single undo step. The patterns themselves materialise on their first edit
   *  (item 48), so this is only cue words. */
  createPattern(cue, ch, targets = null) {
    const store = this.store;
    const list = (targets ?? [{ cue, ch }])
      .filter((s) => (this.wordAt(s.cue, s.ch) & 0x7fff) === CUE_EMPTY);
    if (list.length === 0) return;
    const nums = store.song.freePatternNumbers(list.length);
    const writes = list.slice(0, nums.length).map((s, i) => ({
      cue: s.cue, ch: s.ch,
      value: (this.wordAt(s.cue, s.ch) & 0x8000) | (nums[i] & 0x7fff),
    }));
    if (!writes.length) return;
    store.undo.apply(setCuesOp(store.songIndex, writes));
    this.cursor = { cue, col: ch + 2, nib: 0 };
    this.invalidate();
  }

  /** Cue-view key handling. Returns true when consumed. */
  processKey(e) {
    const store = this.store;
    const c = this.cursor;
    switch (e.code) {
      case "ArrowUp": e.shiftKey ? this.extendSelection(-1, 0) : this.moveCursor(-1, 0); return true;
      case "ArrowDown": e.shiftKey ? this.extendSelection(1, 0) : this.moveCursor(1, 0); return true;
      case "ArrowLeft": e.shiftKey ? this.extendSelection(0, -1) : this.moveCursor(0, -1); return true;
      case "ArrowRight": e.shiftKey ? this.extendSelection(0, 1) : this.moveCursor(0, 1); return true;
      case "PageUp": e.shiftKey ? this.extendSelection(-16, 0) : this.moveCursor(-16, 0); return true;
      case "PageDown": e.shiftKey ? this.extendSelection(16, 0) : this.moveCursor(16, 0); return true;
      case "Enter": this.openCmdEditor(); return true;
    }
    if (!store.record) return false;
    if (c.col < 2) {
      // A Cmd word holds no digits to type, so Delete is the only key that
      // applies: it clears the command, exactly as it empties a pattern slot.
      if (e.code === "Delete" || e.code === "Period") {
        if (c.cue < this.numCues()) { // nothing to clear on the phantom row
          store.undo.apply(setCuesOp(store.songIndex, this.cmdWrites(c.cue, c.col, 0)));
        }
        this.moveCursor(1, 0);
        return true;
      }
      return false;
    }
    const ch = c.col - 2;
    if (e.code === "Delete" || e.code === "Period") {
      if (c.cue < this.numCues()) { // nothing to delete on the phantom row
        store.undo.apply(setCuesOp(store.songIndex,
          [{ cue: c.cue, ch, value: (this.wordAt(c.cue, ch) & 0x8000) | 0x7fff }]));
      }
      this.moveCursor(1, 0);
      return true;
    }
    const d = parseInt(e.key, 16);
    if (Number.isNaN(d) || e.key.length !== 1) return false;
    // 4-nibble pattern entry (0000..7FFE; the top nibble masks to 15 bits).
    // An empty slot starts from 0. setCuesOp materialises the cue if it is the
    // blank row past the end (edit beyond HALT / a new song's cue 0).
    const cur = this.wordAt(c.cue, ch);
    const sign = cur & 0x8000;
    let pat = cur & 0x7fff;
    if (pat === CUE_EMPTY) pat = 0;
    const shift = (3 - c.nib) * 4;
    pat = (pat & ~(0xf << shift)) | (d << shift);
    store.undo.apply(setCuesOp(store.songIndex,
      [{ cue: c.cue, ch, value: sign | (pat & 0x7fff) }]));
    if (c.nib === 3) { c.nib = 0; this.moveCursor(1, 0); }
    else { c.nib++; this.invalidate(); }
    return true;
  }

  /** Is there a Cmd word for the popup to act on — the cursor's own, or a
   *  whole command block? What the Space key asks before claiming the key. */
  cmdEditable() { return this.cursor.col <= 1 || this.selBounds()?.cmd === true; }

  /**
   * CueCmd popup: choose the instruction for a Cmd word slot (Cmd1/Cmd2) — and
   * over a command block, FILL every Cmd word it covers with that one
   * instruction, which is how a run of cues gets its `LEN` in one step.
   *
   * The block wins over the cursor when there is one, so the fill acts on what
   * is highlighted rather than on whichever cell the drag happened to stop in.
   */
  async openCmdEditor() {
    const store = this.store;
    const c = this.cursor;
    const sb = this.selBounds();
    const b = sb?.cmd ? sb
      : c.col <= 1 ? { r0: c.cue, r1: c.cue, c0: c.col, c1: c.col }
      : null;
    if (!b) return;
    const cells = (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1);
    const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
    // Seeded from the block's top-left cell — the corner the drag started from.
    const existing = store.song.cues[b.r0]; // undefined on the phantom row
    const info = cueInfo(existing ?? new Uint16Array(MAX_VOICES).fill(CUE_EMPTY));
    const current = b.c0 === 0 ? info.inst0 : info.inst1;
    const result = await showModal({
      title: cells > 1
        ? t("cue.cmdFillTitle", { from: hex4(b.r0), to: hex4(b.r1), n: cells })
        : t("cue.cmdTitle", { cue: hex4(b.r0), word: b.c0 + 1 }),
      body: t("cue.cmdBody"),
      fields: [
        { name: "kind", label: t("cue.command"), type: "select", value: kindOf(current), options: [
          { value: "nop", label: t("cue.none") },
          { value: "len", label: t("cue.len") },
          { value: "halt", label: t("cue.halt") },
          { value: "haltAt", label: t("cue.haltAt") },
          { value: "bak", label: t("cue.bak") },
          { value: "fwd", label: t("cue.fwd") },
          { value: "jmp", label: t("cue.jmp") },
        ]},
        // Hex like every other cue/row number (the grid shows args in hex too).
        { name: "arg", label: t("cue.argument"),
          value: (current.arg || 0).toString(16).toUpperCase() },
      ],
    });
    if (!result) return;
    const arg = Math.min(0xfff, Math.max(0, parseInt(result.arg || "0", 16) || 0));
    const newWord = encodeInstWord(result.kind, arg);
    // Written through the growable cue op so a command on the phantom row
    // materialises the cue (edit past HALT).
    const nCues = this.numCues();
    const writes = [];
    for (let cue = b.r0; cue <= b.r1; cue++) {
      // …but writing "no command" to a cue the song does not have yet would
      // materialise a row only to say nothing, which its absence already says.
      if (newWord === 0 && cue >= nCues) continue;
      for (let slot = b.c0; slot <= b.c1; slot++) writes.push(...this.cmdWrites(cue, slot, newWord));
    }
    if (!writes.length) return;
    store.undo.apply(setCuesOp(store.songIndex, writes));
    this.invalidate();
  }

  frame() {
    if (!this.store.doc) return;
    if (this.store.audio?.isPlaying()) this.needsRedraw = true; // playhead marker
    if (this.hold.active) this.needsRedraw = true; // the gauge travels every frame
    if (this.needsRedraw) { this.needsRedraw = false; this.draw(); }
  }

  draw() {
    const C = themeColors();
    const { ctx, store } = this;
    const dpr = this.dpr ?? 1;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const song = store.song;
    if (!song) return;
    const chans = store.doc.channelCount;
    ctx.font = canvasFont(FONT_PX);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    // header
    ctx.fillStyle = C.dim;
    ctx.fillText("cue", 6, HEADER_H / 2);
    // The Cmd headers light up with the cursor the same way the lane headers
    // do below — they are columns you can select now, so they read as columns.
    for (let slot = 0; slot < 2; slot++) {
      const selected = this.cursor.col === slot;
      if (selected) {
        ctx.fillStyle = C.cursor;
        ctx.fillRect(GUTTER_W + slot * CMD_W, 0, CMD_W - 2, HEADER_H);
      }
      ctx.fillStyle = selected ? C.fg : C.dim;
      ctx.fillText(`Cmd${slot + 1}`, GUTTER_W + slot * CMD_W + 4, HEADER_H / 2);
    }
    const visCh = Math.min(Math.floor((W - this.chanX(0)) / COL_W) + 1, chans - this.scrollCh);
    for (let i = 0; i < visCh; i++) {
      const ch = this.scrollCh + i;
      // highlight the selected lane's header too, same idea as the
      // leftmost row number: findable at a glance regardless of cue row
      const selected = this.cursor.col === ch + 2;
      if (selected) {
        ctx.fillStyle = C.cursor;
        ctx.fillRect(this.chanX(i) - 2, 0, COL_W - 2, HEADER_H);
      }
      ctx.fillStyle = selected ? C.fg : C.dim;
      ctx.fillText(String(ch + 1).padStart(2, "0"), this.chanX(i) + 4, HEADER_H / 2);
    }

    const playCue = store.audio?.isPlaying() ? store.audio.getCuePosition() : -1;
    const editRows = this.editRows();
    const sb = this.selBounds();
    const vis = this.visibleRows() + 1;
    for (let r = 0; r < vis; r++) {
      const cueIdx = this.scrollCue + r;
      if (cueIdx >= editRows) break;
      const y = HEADER_H + r * ROW_H;
      const words = song.cues[cueIdx]; // undefined on the phantom (append) row
      const info = words ? cueInfo(words) : cueInfo(new Uint16Array(MAX_VOICES).fill(CUE_EMPTY));

      if (cueIdx === playCue) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (cueIdx % 4 === 0) {
        ctx.fillStyle = C.panel;
        ctx.fillRect(0, y, W, ROW_H);
      }
      // block selection highlight, over whichever space the block belongs to
      if (sb && cueIdx >= sb.r0 && cueIdx <= sb.r1) {
        ctx.fillStyle = C.sel;
        if (sb.cmd) {
          for (let slot = sb.c0; slot <= sb.c1; slot++) {
            ctx.fillRect(GUTTER_W + slot * CMD_W, y, CMD_W - 2, ROW_H);
          }
        } else {
          for (let i = 0; i < visCh; i++) {
            const ch = this.scrollCh + i;
            if (ch >= sb.c0 && ch <= sb.c1) ctx.fillRect(this.chanX(i) - 2, y, COL_W - 2, ROW_H);
          }
        }
      }
      if (this.cursor.cue === cueIdx) {
        // leftmost row number gets its own background so the cursor row is
        // findable at a glance, regardless of which column is selected
        ctx.fillStyle = C.cursor;
        ctx.fillRect(0, y, GUTTER_W - 2, ROW_H);
        const cx = this.cursor.col === 0 ? GUTTER_W :
                   this.cursor.col === 1 ? GUTTER_W + CMD_W :
                   this.chanX(this.cursor.col - 2 - this.scrollCh);
        const cw = this.cursor.col <= 1 ? CMD_W : COL_W;
        ctx.fillStyle = C.cursor;
        ctx.fillRect(cx, y, cw - 2, ROW_H);
        if (this.cursor.col >= 2) {
          ctx.fillStyle = store.record ? C.caret : C.cursor;
          ctx.fillRect(cx + 4 + this.cursor.nib * CHAR_W - 1, y, CHAR_W + 2, ROW_H);
        }
      }

      ctx.fillStyle = cueIdx % 4 === 0 ? C.accent : C.fg;
      ctx.fillText(cueIdx.toString(16).toUpperCase().padStart(4, "0"), 6, y + ROW_H / 2);
      ctx.fillStyle = info.inst0.type !== INST_NOP ? C.accent2 : C.dim;
      if (info.inst0.type === INST_NOP) ctx.globalAlpha = 0.35;
      ctx.fillText(instToStr(info.inst0), GUTTER_W + 4, y + ROW_H / 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = info.inst1.type !== INST_NOP ? C.accent2 : C.dim;
      if (info.inst1.type === INST_NOP) ctx.globalAlpha = 0.35;
      ctx.fillText(instToStr(info.inst1), GUTTER_W + CMD_W + 4, y + ROW_H / 2);
      ctx.globalAlpha = 1;

      for (let i = 0; i < visCh; i++) {
        const ch = this.scrollCh + i;
        const pat = (words ? words[ch] : CUE_EMPTY) & 0x7fff;
        const x = this.chanX(i) + 4;
        if (pat === CUE_EMPTY) {
          ctx.fillStyle = C.dim;
          ctx.globalAlpha = 0.3;
          ctx.fillText("····", x, y + ROW_H / 2);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = C.fg;
          ctx.fillText(pat.toString(16).toUpperCase().padStart(4, "0"), x, y + ROW_H / 2);
        }
      }
    }

    ctx.strokeStyle = C.border;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W - 2.5, 0); ctx.lineTo(GUTTER_W - 2.5, H);
    ctx.moveTo(this.chanX(0) - 2.5, 0); ctx.lineTo(this.chanX(0) - 2.5, H);
    ctx.moveTo(0, HEADER_H - 0.5); ctx.lineTo(W, HEADER_H - 0.5);
    ctx.stroke();

    // Floating name tag for the pattern under the cursor (rename display). The
    // grid cells are too narrow for names, so a tag floats by the cursor cell.
    if (this.cursor.col >= 2) {
      const ch = this.cursor.col - 2;
      const vOff = ch - this.scrollCh;
      const rOff = this.cursor.cue - this.scrollCue;
      const words = song.cues[this.cursor.cue];
      const pat = words ? (words[ch] & 0x7fff) : CUE_EMPTY;
      const nm = pat !== CUE_EMPTY ? unescapeName(store.doc.patternName(pat)) : "";
      if (nm && vOff >= 0 && vOff < visCh && rOff >= 0 && rOff < vis) {
        const cellX = this.chanX(vOff);
        let ty = HEADER_H + rOff * ROW_H + ROW_H;         // below the cursor row
        if (ty + ROW_H > H) ty = HEADER_H + rOff * ROW_H - ROW_H; // flip up near bottom
        const label = pat.toString(16).toUpperCase().padStart(4, "0") + "  " + nm;
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = C.panel;
        ctx.fillRect(cellX, ty + 2, tw, ROW_H - 3);
        ctx.strokeStyle = C.accent;
        ctx.strokeRect(cellX + 0.5, ty + 2.5, tw, ROW_H - 4);
        ctx.fillStyle = C.fg;
        ctx.fillText(label, cellX + 6, ty + 2 + (ROW_H - 3) / 2);
      }
    }

    // The press-and-hold gauge, last of all, so nothing is drawn over it.
    paintPerimeterGauge(ctx, this.hold.press?.rect ?? null, this.hold.progress(),
      C.accent, C.dim);
  }
}

function kindOf(inst) {
  switch (inst.type) {
    case INST_HALT: return "halt";
    case INST_HALTAT: return "haltAt";
    case INST_PATLEN: return "len";
    case INST_GOBACK: return "bak";
    case INST_SKIP: return "fwd";
    case INST_JUMP: return "jmp";
    default: return "nop";
  }
}

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
