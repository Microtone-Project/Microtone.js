// The lane wavescopes (item 358): a small oscilloscope in each Timeline lane
// header, showing that lane's own signal — its voice, its layers and the
// notes it left ringing, as the mixer adds them (the engine's lane tap,
// protocol.js SNAP_LS_*). A diagnostic, not an ornament: it is there to show
// what a lane is really playing, so it draws every sample (a column's
// minimum to maximum, never one point in every few) and says where it lined
// the trace up.
//
// Triggering. The tap hands over the last SCOPE_RING frames whole, so the
// level is found before anything is drawn: AUTO, halfway between the
// window's lowest and highest sample, with a tenth of that span as
// hysteresis. The trace is lined up on the latest rising crossing that
// leaves a whole display window around it, put at `trigPos` across the
// scope (the centre unless moved; the small triangles at the top and bottom
// mark it). With no crossing — silence, a sound too low for the window, DC —
// it runs free on the newest frames.

/** Frames the scope shows across its width: half the ring, so a crossing
 *  anywhere in the other half can be placed anywhere across it. */
export const SCOPE_SHOW = 512;
/** Below this peak a lane is drawn as silent rather than scaled up (−60 dBFS). */
export const SCOPE_FLOOR = 1 / 1024;

/** How far apart the frames are that a trace is compared by (item 376). */
const MATCH_STEP = 4;
/** The most crossings weighed against the last trace: the latest ones. */
const MATCH_CANDIDATES = 48;

/**
 * A lane scope's memory between frames (item 376): the trace it last showed,
 * sampled every MATCH_STEP frames, and the level it was scaled to. Lets the
 * trigger keep to the same point of a waveform with several rising edges per
 * cycle, and the gain fall back slowly instead of flickering.
 */
export function makeScopeState() {
  return { prev: null, peak: 0 };
}

/**
 * Where the shown window starts in `data` (oldest frame first), lining a
 * rising crossing of the auto level up at `trigPos` (0…1) across it.
 * Without `state` (or on a first frame) that is the latest crossing; with it,
 * the one whose trace looks most like the last frame's — so a waveform that
 * crosses the level more than once a cycle (most real sounds) does not hop
 * between those crossings from frame to frame. Returns { start, triggered,
 * level }, and remembers the trace shown in `state`.
 */
export function scopeWindow(data, trigPos = 0.5, show = SCOPE_SHOW, state = null) {
  const n = data.length;
  show = Math.min(show, n);
  const before = Math.round(trigPos * show);
  const free = { start: n - show, triggered: false, level: 0 };
  const remember = (start) => {
    if (!state) return;
    const m = Math.floor(show / MATCH_STEP);
    const prev = state.prev?.length === m ? state.prev : new Float32Array(m);
    for (let k = 0; k < m; k++) prev[k] = data[start + k * MATCH_STEP];
    state.prev = prev;
  };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (!(span > SCOPE_FLOOR / 8)) { if (state) state.prev = null; return free; }
  const level = (lo + hi) / 2;
  const arm = level - span / 10;
  // The crossing must leave `before` frames ahead of it and the rest after.
  const first = before, last = n - (show - before);
  const found = [];
  let armed = false;
  for (let i = 0; i <= last; i++) {
    const v = data[i];
    if (v < arm) armed = true;
    else if (armed && v >= level && i > 0) {
      armed = false;
      if (i >= first) found.push(i);
    }
  }
  if (found.length === 0) { if (state) state.prev = null; return { ...free, level }; }
  let pick = found[found.length - 1];
  const prev = state?.prev;
  if (prev && found.length > 1) {
    // Normalised correlation with the last trace, the latest crossings first;
    // a later one wins a near tie, so the scope still follows the newest sound.
    let pe = 0;
    for (let k = 0; k < prev.length; k++) pe += prev[k] * prev[k];
    if (pe > 0) {
      let best = -Infinity;
      const from = Math.max(0, found.length - MATCH_CANDIDATES);
      for (let c = found.length - 1; c >= from; c--) {
        const start = found[c] - before;
        let xy = 0, yy = 0;
        for (let k = 0; k < prev.length; k++) {
          const y = data[start + k * MATCH_STEP];
          xy += prev[k] * y;
          yy += y * y;
        }
        const score = yy > 0 ? xy / Math.sqrt(pe * yy) : -1;
        if (score > best + 0.02) { best = score; pick = found[c]; }
      }
    }
  }
  remember(pick - before);
  return { start: pick - before, triggered: true, level };
}

/**
 * Paint lane data `data` into the rectangle (x, y, w, h): the trace, the
 * centre line and the trigger marks. `ink` = { bg, line, trace, mark };
 * `state` the lane's makeScopeState(), or null.
 *
 * The trace is drawn on the DEVICE pixel grid (item 383), not the layout's:
 * a canvas painted under a scale of 1.25 would stretch a one-layout-pixel
 * column to a blurred 1.25 device pixels, so the scope lays its own columns
 * (one per device pixel across the rectangle) with the transform set aside.
 * `ctx`'s transform must be a plain scale + translation, which is how the
 * Timeline sets it; its clip is kept.
 */
export function paintLaneScope(ctx, ink, x, y, w, h, data, trigPos = 0.5, state = null) {
  const T = ctx.getTransform();
  const sx = T.a || 1, sy = T.d || 1;
  // The rectangle in device pixels, edges snapped, so the box and the trace
  // meet the pixel grid exactly.
  const dx0 = Math.round(sx * x + T.e), dx1 = Math.round(sx * (x + w) + T.e);
  const dy0 = Math.round(sy * y + T.f), dy1 = Math.round(sy * (y + h) + T.f);
  const dw = Math.max(1, dx1 - dx0), dh = Math.max(1, dy1 - dy0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = ink.bg;
  ctx.fillRect(dx0, dy0, dw, dh);
  const mid = dy0 + dh / 2;
  ctx.fillStyle = ink.line;
  ctx.globalAlpha = 0.5;
  // Lines keep their LAYOUT weight (one layout pixel, as before the device
  // grid): 1.25 device pixels at 125 %, 2 at 200 %, never thinner than one.
  const lineT = Math.max(1, Math.round(sy));
  ctx.fillRect(dx0, Math.round(mid - lineT / 2), dw, lineT);
  ctx.globalAlpha = 1;
  if (data) {
    const show = Math.min(SCOPE_SHOW, data.length);
    const { start } = scopeWindow(data, trigPos, show, state);
    let peak = 0;
    for (let i = start; i < start + show; i++) peak = Math.max(peak, Math.abs(data[i]));
    // The scale rises at once and falls back over a few frames, so a note's
    // decay reads as a decay instead of the trace jumping to fit every frame.
    if (state) {
      peak = Math.max(peak, state.peak * 0.85);
      state.peak = peak;
    }
    if (peak >= SCOPE_FLOOR) {
      const gain = (dh / 2 - 1) / peak;
      // A round pen of one layout pixel's weight, stroked through the wave:
      // one column per device pixel, each contributing its lowest and highest
      // frame in the order they come, so the line is as heavy at a slope or
      // an edge as it is across a flat stretch (a filled bar per column was
      // thinner by cos θ on a diagonal, and could not widen a vertical).
      ctx.strokeStyle = ink.trace;
      ctx.lineWidth = sy;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // the round pen may reach a half line past the box at a peak: keep it in
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx0, dy0, dw, dh);
      ctx.clip();
      ctx.beginPath();
      let first = true;
      const put = (xc, v) => {
        const yy = mid - v * gain;
        if (first) { ctx.moveTo(xc, yy); first = false; } else ctx.lineTo(xc, yy);
      };
      for (let c = 0; c < dw; c++) {
        const a = start + Math.floor((c * show) / dw);
        const b = Math.max(a + 1, start + Math.floor(((c + 1) * show) / dw));
        let mn = Infinity, mx = -Infinity, imn = a, imx = a;
        for (let i = a; i < b; i++) {
          const v = data[i];
          if (v < mn) { mn = v; imn = i; }
          if (v > mx) { mx = v; imx = i; }
        }
        const xc = dx0 + c + 0.5;
        if (imn === imx) put(xc, mn);
        else if (imn < imx) { put(xc, mn); put(xc, mx); }
        else { put(xc, mx); put(xc, mn); }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
  // The trigger position: a small triangle pointing in from each edge
  // (a path, so it is anti-aliased at any scale).
  const tx = Math.round(x + trigPos * (w - 1));
  ctx.fillStyle = ink.mark;
  ctx.beginPath();
  ctx.moveTo(tx - 3, y);
  ctx.lineTo(tx + 3, y);
  ctx.lineTo(tx, y + 3);
  ctx.closePath();
  ctx.moveTo(tx - 3, y + h);
  ctx.lineTo(tx + 3, y + h);
  ctx.lineTo(tx, y + h - 3);
  ctx.closePath();
  ctx.fill();
}
