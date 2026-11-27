// The Microtone Player's visualiser in the Music Hub's bottom bar: one
// vertical level bar per lane the song writes on, and nothing else — no lane
// number, no pan, no notes. The row march (marching.js) is the full page's;
// a strip a few dozen pixels tall has room for levels only.
//
// The lanes are the march's (`RowMarch.lanes`: only those the song uses), so
// both views show the same columns. Each bar is the lane's volume as the
// engine reports it (taudplay `getVoiceVolume`), falling back gently rather
// than dropping in one frame, as any level meter does.
//
// Change-driven, like the march: a frame whose bars land on the same pixels
// as the last one paints nothing.

import { themeColors } from "../ui/theme.js";

const DPR_CAP = 2;
const FALL = 0.86;      // per frame: what a bar keeps of its last height
const MAX_COL = 22;     // px: a song on few lanes does not get slabs
const PAD_Y = 6;        // px above and below the bars

export class LaneBars {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lanes = [];
    this.shown = new Float32Array(64);
    this.lastPaintKey = "";
  }

  /** The lanes to show (lane numbers, 0-based). */
  setLanes(lanes) {
    this.lanes = lanes.slice();
    this.shown.fill(0);
    this.lastPaintKey = "";
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
    return { w, h, dpr };
  }

  /** Paint one frame. `player` is the TaudPlayer. */
  frame(player) {
    const { w: W, h: H, dpr } = this._fit();
    const n = this.lanes.length;
    const colW = n ? Math.min(MAX_COL, W / n) : 0;
    const barH = Math.max(1, H - PAD_Y * 2);
    // Heights in device pixels: the key is what would actually be drawn.
    let key = `${W}x${H}:${n}`;
    for (let i = 0; i < n; i++) {
      const ch = this.lanes[i];
      const v = Math.min(1, Math.max(0, player.getVoiceVolume(ch)));
      const s = Math.max(v, this.shown[ch] * FALL);
      this.shown[ch] = s < 0.002 ? 0 : s;
      key += "," + Math.round(this.shown[ch] * barH * dpr);
    }
    if (key === this.lastPaintKey) return;
    this.lastPaintKey = key;

    const ctx = this.ctx;
    const C = themeColors();
    ctx.fillStyle = C.cvBg || C.panel;
    ctx.fillRect(0, 0, W, H);
    if (!n) return;
    const gap = colW >= 6 ? 2 : colW >= 3 ? 1 : 0;
    const bw = Math.max(1, colW - gap);
    for (let i = 0; i < n; i++) {
      const x = i * colW;
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(x, PAD_Y, bw, barH);
      const h = this.shown[this.lanes[i]] * barH;
      if (h > 0) {
        ctx.fillStyle = C.meter;
        ctx.fillRect(x, PAD_Y + barH - h, bw, h);
      }
    }
  }
}
