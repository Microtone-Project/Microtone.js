// Drawing helpers for the Mixing tab's spectra (item 217): the ground every
// spectrum sits on (frequency and dB rules), the per-column ballistics, the
// band-inked fill, and the hairline cursor that reads the AXES under the
// pointer — the frequency and level where it points, not the value the graph
// happens to draw there.
//
// The frequency axis is logarithmic, 20 Hz … 20 kHz, column x of `cols`.

import { SAMPLING_RATE } from "../../../core/engine/constants.js";
import { canvasMonoFont } from "../fonts.js";
import { localPoint } from "../zoom.js";
import { RAD_BANDS } from "../radiation.js";
import { t } from "../i18n.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const LOG_SPAN = Math.log(1000);

/** The frequency at column x of `cols`. */
export const freqAt = (x, cols) => 20 * Math.exp((x / (cols - 1)) * LOG_SPAN);
/** …and the (fractional) column of frequency f. */
export const colOfFreq = (f, cols) => (Math.log(f / 20) / LOG_SPAN) * (cols - 1);

/** "120 Hz", "1.25 kHz", "12.5 kHz". */
export function fmtHz(f) {
  if (f < 1000) return `${Math.round(f)} Hz`;
  return `${(f / 1000).toFixed(f < 10000 ? 2 : 1)} kHz`;
}
/** A signed dB figure with a real minus sign. */
export function fmtDb(db, digits = 1) {
  const s = Math.abs(db).toFixed(digits);
  return `${db < 0 && +s !== 0 ? "−" : db > 0 && +s !== 0 ? "+" : ""}${s}`;
}

/**
 * Step the columns `cols` toward the spectrum `bins` (dB per FFT bin of a
 * `frames`-long window): snap up by `attack`, fall at `fallDb` per call. A
 * column takes the LOUDEST bin under it, and one that owns no bin at the low
 * end inherits its neighbour's. `bins` null lets every column fall.
 */
export function stepColumns(cols, bins, frames, floorDb, attack, fallDb) {
  const n = cols.length;
  const binHz = SAMPLING_RATE / frames;
  const nBins = frames >> 1;
  let prev = floorDb;
  for (let x = 0; x < n; x++) {
    let tgt = floorDb;
    if (bins) {
      const f0 = freqAt(x - 0.5, n), f1 = freqAt(x + 0.5, n);
      const k0 = Math.max(1, Math.floor(f0 / binHz));
      const k1 = Math.min(nBins - 1, Math.ceil(f1 / binHz));
      if (k1 < k0) tgt = prev;
      else for (let k = k0; k <= k1; k++) if (bins[k] > tgt) tgt = bins[k];
      prev = tgt;
    }
    const cur = cols[x];
    cols[x] = tgt > cur ? cur + (tgt - cur) * attack : Math.max(tgt, cur - fallDb);
  }
}

/**
 * The ground of a spectrum plot: the trough, the frequency rules with their
 * labels along the foot, the level rules (`lo`…`hi` dB) labelled at the left,
 * and — when `curveDb` is given — the ± gain axis of a response curve, ticked
 * and labelled at the right with its 0 dB line across. `ground` overrides the
 * trough's ink (the Mastering tab's graph sits on the canvas ground).
 */
export function drawSpecGround(ctx, w, h, C, { lo, hi, curveDb = 0, ground = null }) {
  ctx.fillStyle = ground ?? C.meterBg;
  ctx.fillRect(0, 0, w, h);
  ctx.font = canvasMonoFont(9);
  ctx.fillStyle = C.border;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    ctx.fillRect(Math.round(colOfFreq(f, w)), 0, 1, h);
  }
  // Level rules every 12 dB; labelled every 12 where there is room, else 24.
  const px12 = (12 / (hi - lo)) * h;
  const every = px12 >= 22 ? 12 : 24;
  ctx.textAlign = "left";
  for (let db = Math.ceil(lo / 12) * 12; db < hi; db += 12) {
    if (db <= lo) continue;
    const y = Math.round(h - ((db - lo) / (hi - lo)) * h);
    ctx.fillStyle = C.border;
    ctx.fillRect(0, y, w, 1);
    if (db % every === 0 && y > 12 && y < h - 12) {
      ctx.fillStyle = C.dim;
      ctx.fillText(fmtDb(db, 0), 2, y - 2);
    }
  }
  ctx.fillStyle = C.dim;
  for (const [f, s] of [[100, "100"], [1000, "1k"], [10000, "10k"]]) {
    ctx.fillText(s, Math.round(colOfFreq(f, w)) + 2, h - 3);
  }
  if (curveDb > 0) {
    const mid = Math.round(h / 2);
    ctx.fillStyle = C.border;
    ctx.fillRect(0, mid, w, 1);
    ctx.textAlign = "right";
    const half = h / 2 - 4;
    for (const db of [curveDb, curveDb / 2, 0, -curveDb / 2, -curveDb]) {
      const y = h / 2 - (db / curveDb) * half;
      ctx.fillStyle = C.dim;
      ctx.fillRect(w - 4, Math.round(y), 4, 1);
      if (db === curveDb || db === -curveDb) continue;
      ctx.fillText(fmtDb(db, 0), w - 6, y + (db === 0 ? -2 : 3));
    }
    ctx.textAlign = "left";
  }
}

/** The five bands' inks under the line of `cols` (dB → y by `yOf`). */
export function fillBands(ctx, cols, yOf, h, C, alpha = 0.55) {
  const n = cols.length;
  ctx.globalAlpha = alpha;
  let band = 0;
  let x = 0;
  while (x < n) {
    while (band < RAD_BANDS.length - 1 && freqAt(x, n) >= RAD_BANDS[band].hi) band++;
    let end = x;
    while (end + 1 < n && freqAt(end + 1, n) < RAD_BANDS[band].hi) end++;
    ctx.fillStyle = C[RAD_BANDS[band].ink];
    ctx.beginPath();
    ctx.moveTo(x, h);
    for (let i = x; i <= end; i++) ctx.lineTo(i, yOf(cols[i]));
    ctx.lineTo(end, h);
    ctx.closePath();
    ctx.fill();
    x = end + 1;
  }
  ctx.globalAlpha = 1;
}

/** A polyline through `cols` (dB → y by `yOf`). */
export function strokeColumns(ctx, cols, yOf, ink, width = 1) {
  ctx.strokeStyle = ink;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < cols.length; i++) {
    const y = yOf(cols[i]);
    if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
  }
  ctx.stroke();
}

/**
 * Follow the pointer over `canvas`: the returned object's `x`/`y` are CSS
 * pixels inside it, `on` whether it is there at all. `changed()` runs on every
 * move, entry and exit, so the owner can repaint a plot that is otherwise at
 * rest.
 */
export function trackCursor(canvas, changed) {
  const st = { on: false, x: 0, y: 0 };
  const at = (ev) => {
    // Layout pixels, the space the canvas paints in (the UI zoom divided out).
    const p = localPoint(canvas, ev);
    st.x = p.x;
    st.y = p.y;
    st.on = st.x >= 0 && st.y >= 0 && st.x <= canvas.clientWidth && st.y <= canvas.clientHeight;
    changed();
  };
  canvas.addEventListener("pointermove", at);
  canvas.addEventListener("pointerdown", at);
  canvas.addEventListener("pointerleave", () => { st.on = false; changed(); });
  return st;
}

/**
 * The hairline cursor: a cross through the pointer and a label reading the
 * axes there — the frequency, the level on the spectrum's `lo`…`hi` scale and,
 * with `curveDb`, the gain on the response curve's ± scale.
 */
export function drawCursor(ctx, w, h, C, cur, { lo, hi, curveDb = 0 }) {
  if (!cur?.on) return;
  const x = clamp(Math.round(cur.x), 0, w - 1);
  const y = clamp(Math.round(cur.y), 0, h - 1);
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = C.fg;
  ctx.fillRect(x, 0, 1, h);
  ctx.fillRect(0, y, w, 1);
  ctx.globalAlpha = 1;
  const parts = [fmtHz(freqAt(x, w)), `${fmtDb(lo + (1 - y / h) * (hi - lo))} dB`];
  if (curveDb > 0) {
    const g = ((h / 2 - y) / (h / 2 - 4)) * curveDb;
    parts.push(t("imix.cursorGain", { db: fmtDb(clamp(g, -curveDb, curveDb)) }));
  }
  const text = parts.join(" · ");
  ctx.font = canvasMonoFont(10);
  const tw = ctx.measureText(text).width + 8;
  const bx = x + 8 + tw <= w ? x + 8 : Math.max(0, x - 8 - tw);
  const by = y - 20 >= 0 ? y - 20 : Math.min(h - 16, y + 6);
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = C.panel;
  ctx.fillRect(bx, by, tw, 15);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.fg;
  ctx.textAlign = "left";
  ctx.fillText(text, bx + 4, by + 11);
}
