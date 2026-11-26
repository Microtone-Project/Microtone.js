// The Microtone Player's visualiser (item 373): the song's rows marching up
// past a fixed playhead, a lane to a column, as a tracker shows them — with
// each lane's level and pan in the strip above its column.
//
// It draws what the FILE says (the editor's Document: every lane's pattern
// for the cue being played) at the row the ENGINE says it is on (taudplay's
// cue and row). It marches a whole row at a time, as a tracker's grid does —
// never a smooth scroll between rows (the user's ruling). Rows above the playhead are what was just heard — the cue played
// before, when the song came from one — and rows below are the cue to come:
// the next in order, which is what a tracker shows too.
//
// Notes are spelled by the tracker's own painter (cellpaint.js, Motif Grid)
// in the lane's notation. How much of a cell is shown depends on the room:
// note + instrument + volume, note + instrument, the note alone, and — when
// even that does not fit — a mark where each note starts.

import { paintNoteCell } from "../ui/cellpaint.js";
import { hex2 } from "../ui/notenames.js";
import { canvasFont, canvasMonoFont } from "../ui/fonts.js";
import { themeColors } from "../ui/theme.js";
import { presetForNotation } from "../../core/tuning/pitchtables.js";
import { CUE_EMPTY } from "../../core/format/taud-const.js";

const NOTE_CHARS = 4;
const DPR_CAP = 2;

/** Cell layouts, widest first: the characters each lane takes, gap included. */
const MODES = [
  { name: "full", chars: NOTE_CHARS + 1 + 2 + 1 + 2 + 1 },
  { name: "inst", chars: NOTE_CHARS + 1 + 2 + 1 },
  { name: "note", chars: NOTE_CHARS + 1 },
];

export class RowMarch {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.song = null;
    this.doc = null;
    this.lanes = [];
    this.peaks = new Float32Array(64);
    this.prevCue = -1;     // the cue played before the one playing
    this.curCue = -1;
    this.lastPaintKey = "";
  }

  /** A new song: `doc` the editor's Document, `facts` songfacts.js's. */
  setSong(doc, songIndex, facts) {
    this.doc = doc;
    this.songIndex = songIndex;
    this.song = doc.songs[songIndex];
    this.facts = facts;
    this.map = this.song.songMap();
    this.lastCue = this.map.entries.length - 1;
    this.wide = !!doc.wideCells;
    // Only the lanes the song writes on: a 32-lane song played on eight
    // shows eight wide columns rather than 24 empty ones.
    const used = new Set();
    for (const words of this.song.cues) {
      for (let ch = 0; ch < this.song.numVoices; ch++) {
        if ((words[ch] & 0x7fff) !== CUE_EMPTY) used.add(ch);
      }
    }
    this.lanes = [...used].sort((a, b) => a - b);
    if (!this.lanes.length) this.lanes = [0];
    // A lane may have a notation of its own (§9.19); instruments' own
    // (§9.20) are left to the tracker — the player spells by lane and song.
    const songPreset = presetForNotation(facts.notation, doc);
    this.presets = this.lanes.map((ch) => {
      const own = doc.laneNotation?.(songIndex, ch) ?? null;
      return own === null ? songPreset : presetForNotation(own, doc);
    });
    this.prevCue = -1;
    this.curCue = -1;
    this.peaks.fill(0);
    this.lastPaintKey = "";
  }

  /** Rows in cue `c` (0 for a cue the song does not have). */
  rowsIn(c) {
    return c >= 0 && c <= this.lastCue ? this.map.entries[c].rowLimit : 0;
  }

  /** The cell lane `ch` plays at row `r` of cue `c`, or null. */
  cellAt(c, ch, r) {
    if (c < 0 || c > this.lastCue) return null;
    const p = this.song.cues[c][ch] & 0x7fff;
    if (p === CUE_EMPTY) return null;
    return this.song.patterns[p]?.[r] ?? null;
  }

  /** Map a row offset from the playhead to (cue, row): through the cue played
   *  before when it goes up past row 0, the next cue when down past the end. */
  locate(cue, row) {
    if (row < 0) {
      const c = this.prevCue >= 0 ? this.prevCue : cue - 1;
      const n = this.rowsIn(c);
      return n > 0 && row >= -n ? { c, r: n + row } : null;
    }
    const n = this.rowsIn(cue);
    if (row < n) return { c: cue, r: row };
    const next = cue + 1;
    const m = this.rowsIn(next);
    return row - n < m ? { c: next, r: row - n } : null;
  }

  _fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.lastPaintKey = "";
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  /** Paint one frame. `player` is the TaudPlayer; `now` performance.now(). */
  frame(player, now) {
    const { w: W, h: H } = this._fit();
    const ctx = this.ctx;
    const C = themeColors();
    if (!this.song) {
      ctx.fillStyle = C.cvBg || C.panel;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const playing = player.playing;
    const cue = player.cue, row = player.row;
    if (cue !== this.curCue) {
      if (this.curCue >= 0) this.prevCue = this.curCue;
      this.curCue = cue;
    }

    // Nothing moves on a stopped song with still meters: leave the canvas be.
    let loud = 0;
    for (const ch of this.lanes) loud += player.getVoiceVolume(ch) + this.peaks[ch];
    const paintKey = `${W}x${H}:${cue}:${row}:${playing}:${loud > 0.0005}`;
    if (!playing && loud <= 0.0005 && paintKey === this.lastPaintKey) return;
    this.lastPaintKey = paintKey;

    ctx.fillStyle = C.cvBg || C.panel;
    ctx.fillRect(0, 0, W, H);

    // Layout: the widest cell that fits every lane, at the largest size
    // between 10 and 16 px; failing all three, the marks.
    const n = this.lanes.length;
    const gutter = 6;
    let px = 0, mode = null, charW = 0;
    for (const m of MODES) {
      for (let size = 16; size >= 10; size--) {
        ctx.font = canvasFont(size);
        const cw = ctx.measureText("0").width;
        if (cw * m.chars * n + gutter * 2 <= W) { px = size; mode = m; charW = cw; break; }
      }
      if (mode) break;
    }
    const marks = !mode;
    if (marks) { px = 10; ctx.font = canvasFont(px); charW = ctx.measureText("0").width; }
    const rowH = Math.round(px * 1.45);
    const headH = Math.round(Math.max(26, px * 2.4));
    const colW = (W - gutter * 2) / n;
    const bodyTop = headH;
    const playY = bodyTop + Math.round((H - bodyTop) * 0.38);

    // Rows. Beat and bar rows tinted as the Timeline tints them; a cue's
    // first row ruled, so a jump shows as a seam in the march.
    const above = Math.ceil((playY - bodyTop) / rowH) + 1;
    const below = Math.ceil((H - playY) / rowH) + 1;
    const base = row;
    const rpb = this.facts.rowsPerBeat || 4, rpbar = this.facts.rowsPerBar || 16;
    const pal = { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent };
    ctx.textBaseline = "middle";
    const rows = [];
    for (let k = -above; k <= below; k++) {
      const at = this.locate(cue, base + k);
      if (!at) continue;
      const y = Math.round(playY + k * rowH - rowH / 2);
      if (y + rowH < bodyTop || y > H) continue;
      rows.push({ k, at, y });
      if (at.r % rpbar === 0) { ctx.fillStyle = C.rowBar; ctx.fillRect(0, y, W, rowH); }
      else if (at.r % rpb === 0) { ctx.fillStyle = C.rowBeat; ctx.fillRect(0, y, W, rowH); }
      if (at.r === 0) { ctx.fillStyle = C.cueLine; ctx.fillRect(0, y, W, 1); }
    }
    // The playhead: a band at the row being played, under the cells.
    const bandY = Math.round(playY - rowH / 2);
    ctx.fillStyle = C.playhead;
    ctx.fillRect(0, bandY, W, rowH);
    ctx.fillStyle = C.accent;
    ctx.fillRect(0, bandY, 4, rowH);
    for (const { k, at, y } of rows) {
      ctx.globalAlpha = k < 0 ? 0.55 : 1;
      for (let i = 0; i < n; i++) {
        const cell = this.cellAt(at.c, this.lanes[i], at.r);
        if (!cell) continue;
        const x = gutter + i * colW;
        if (marks) {
          if (cell.note > 0x0004) {
            ctx.fillStyle = cell.note >= 0x20 ? C.fg : C.fg2;
            ctx.fillRect(Math.round(x + colW * 0.2), y + 2, Math.max(1, Math.round(colW * 0.6)), rowH - 4);
          }
          continue;
        }
        ctx.font = canvasFont(px);
        paintNoteCell(ctx, cell.note, this.presets[i], x, y, charW, rowH, pal, false, false);
        if (mode.name !== "note" && cell.instrment > 0) {
          ctx.fillStyle = C.fxA1 || C.accent2;
          ctx.font = canvasMonoFont(px);
          ctx.fillText(hex2(cell.instrment & 0xff), x + (NOTE_CHARS + 1) * charW, y + rowH / 2);
        }
        if (mode.name === "full" && cell.volumeEff === 0 && cell.note > 0x0004) {
          ctx.fillStyle = C.dim;
          ctx.font = canvasMonoFont(px);
          ctx.fillText(hex2(cell.volume & 0xff), x + (NOTE_CHARS + 4) * charW, y + rowH / 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    // The strip above: lane number, level with peak hold, and pan.
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, W, headH);
    ctx.fillStyle = C.border;
    ctx.fillRect(0, headH - 1, W, 1);
    const labelPx = Math.min(11, Math.max(8, Math.round(colW * 0.4)));
    ctx.font = canvasMonoFont(labelPx);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const meterY = labelPx + 7, meterH = Math.max(3, headH - meterY - 9);
    for (let i = 0; i < n; i++) {
      const ch = this.lanes[i];
      const x = gutter + i * colW;
      const bw = Math.max(2, colW - 4);
      const vol = player.getVoiceVolume(ch);
      this.peaks[ch] = Math.max(this.peaks[ch] * 0.94, vol);
      if (this.peaks[ch] < 0.0005) this.peaks[ch] = 0;
      if (colW >= labelPx * 1.4 || i % 4 === 0) {
        ctx.fillStyle = C.dim;
        ctx.fillText(String(ch + 1), x, labelPx + 2);
      }
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(x, meterY, bw, meterH);
      ctx.fillStyle = C.meter;
      ctx.fillRect(x, meterY, Math.round(vol * bw), meterH);
      const pk = Math.round(this.peaks[ch] * bw);
      if (pk > 0) { ctx.fillStyle = C.accent; ctx.fillRect(x + pk - 1, meterY, 2, meterH); }
      ctx.fillStyle = C.accent2;
      ctx.fillRect(x + player.getVoicePan(ch) * (bw - 3), meterY + meterH + 2, 3, 3);
    }
  }
}
