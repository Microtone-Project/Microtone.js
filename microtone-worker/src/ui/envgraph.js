// Envelope graph (item 227) — the time axis, the painter and the pointer
// handling shared by the instrument's envelope tabs (views/instruments.js)
// and Advanced Edit's patch envelopes (views/instadvanced.js), which used to
// carry a copy each.
//
// THE TIME AXIS IS A WINDOW. Unzoomed it FITS the envelope: node 0 at the
// left, the last node ENV_TIME_FRAC of the way across, and the rest left empty
// so the last node can always be dragged further out (item 37). The wheel
// zooms about the pointer, as MilkyTracker's does, and PINS the window in
// time, so it stops following the envelope's length; Shift+wheel, a sideways
// wheel or a drag on empty graph scrolls it, a double-click there fits it
// again, and zooming back out through the fit lands on it (a detent). On a
// touch screen two fingers pinch the window: it zooms about the fingers and
// follows them sideways.
//
// A drag HOLDS whatever window is on screen until the button comes up. The
// fit used to re-measure the envelope at every pointer move, so a last node
// dragged into the headroom stretched the axis, which put the pointer further
// out, which stretched it again: a second of envelope became ten in a flick.
//
// What a sideways drag does to the nodes is envDragNode's (doc/envedit.js).

import { envActiveCount, envCopy, envDragNode, ENV_MAX_SEGMENT } from "../doc/envedit.js";
import { minifloatToDouble } from "../../core/engine/minifloat.js";
import { themeColors } from "./theme.js";
import { canvasMonoFont } from "./fonts.js";
import { uiDpr, localPoint } from "./zoom.js";

/** Share of the fitted plot the envelope spans; the rest is headroom. */
export const ENV_TIME_FRAC = 0.8;
const FIT_U1 = 1 / ENV_TIME_FRAC;
/** Plot inset, left and right, px. */
const PAD = 10;
/** A node is grabbed within this many px of it, sideways, at any height. */
const GRAB_PX = 12;
/** How far from the pointer a dragged node may sit, px (envDragNode's slack). */
const SLACK_PX = 3;
/** A press on empty graph scrolls once it has moved this far, px. */
const PAN_START_PX = 3;
/** A finger that has pressed a node lets go of it for a pinch until it has
 *  moved this far, px: a finger is not still, and a node must not jump to it
 *  while a second finger may yet be on its way. */
const TOUCH_START_PX = 8;
/** A pinch snaps to the fit when its span lands within this share of it. */
const PINCH_DETENT = 0.06;
/** The narrowest window, seconds: a handful of the shortest segment. */
const MIN_SPAN = 0.02;
/** Zoom per pixel of wheel travel: a 100 px notch is about ×1.22. */
const WHEEL_ZOOM = 0.002;

/**
 * An envelope's node times: `times` (cumulative seconds, one per slot),
 * `active`, `total` (the length, at least a quarter-second so a one-node
 * envelope still has an axis) and `reach` (the furthest the last node can be
 * dragged — the zoomed-out axis always has room for it).
 */
export function envTimes(env) {
  const times = [0];
  for (let i = 0; i < 24; i++) times.push(times[i] + minifloatToDouble(env[i].offset));
  const active = envActiveCount(env);
  const total = Math.max(times[active - 1], 0.25);
  const reach = Math.max(total, active >= 2 ? times[active - 2] + ENV_MAX_SEGMENT : 0);
  return { times, active, total, reach };
}

/**
 * The time axis of one editor. It outlives the canvas — every edit rebuilds
 * the panel — and forgets its zoom when it is bound to another envelope.
 *
 * Positions along it are `u`: seconds as a share of a reference length `ref`
 * (linear), or their log map, which spreads the first milliseconds out. The
 * fit's reference is the envelope's length; a pinned window keeps the one it
 * was pinned with, so it stays put while the envelope changes under it.
 */
export class EnvAxis {
  constructor() {
    this.log = false; // logarithmic time
    this.key = null;  // the envelope the window belongs to
    this.pin = null;  // a zoomed window { ref, u0, u1 }; null = fit
    this.held = null; // the window a drag froze
  }

  /** Show envelope `key`: a different one starts fitted. */
  bind(key) {
    if (key === this.key) return;
    this.key = key;
    this.pin = this.held = null;
  }

  u(t, ref) {
    if (!this.log) return ref > 0 ? t / ref : 0;
    const t0 = Math.max(ref / 400, 1e-4);
    return Math.log((t + t0) / t0) / Math.log((ref + t0) / t0);
  }

  time(u, ref) {
    if (!this.log) return u * ref;
    const t0 = Math.max(ref / 400, 1e-4);
    return t0 * (Math.pow((ref + t0) / t0, u) - 1);
  }

  /** The window on screen: held by a drag, pinned by a zoom, or the fit. */
  window(total) {
    return this.held ?? this.pin ?? { ref: total, u0: 0, u1: FIT_U1 };
  }

  /** Pixel ↔ seconds on a graph `w` px wide, and the seconds it shows. */
  scale(w, total) {
    const { ref, u0, u1 } = this.window(total);
    const k = (w - 2 * PAD) / (u1 - u0);
    return {
      x: (t) => PAD + (this.u(t, ref) - u0) * k,
      t: (x) => this.time(u0 + (x - PAD) / k, ref),
      t0: this.time(u0, ref),
      t1: this.time(u1, ref),
    };
  }

  hold(total) { this.held = { ...this.window(total) }; }
  release() { this.held = null; }
  fit() { this.pin = null; }

  /** Switch the log map, keeping a pinned window on the same seconds. */
  setLog(on) {
    if (on === this.log) return;
    const p = this.pin;
    const ends = p && [this.time(p.u0, p.ref), this.time(p.u1, p.ref)];
    this.log = on;
    if (p) this.pin = { ref: p.ref, u0: this.u(ends[0], p.ref), u1: this.u(ends[1], p.ref) };
  }

  /** Zoom by `factor` (above 1 = in) about pixel `x`; `m` is envTimes. */
  zoom(factor, x, w, m) {
    const from = this.window(m.total);
    const at = from.u0 + ((x - PAD) / (w - 2 * PAD)) * (from.u1 - from.u0);
    const next = this._clamp({
      ref: from.ref, u0: at - (at - from.u0) / factor, u1: at + (from.u1 - at) / factor,
    }, m);
    if (next === null) return;
    // The detent: a pinned window whose span crosses the fit's becomes the
    // fit, which follows the envelope again. The next notch goes on past it.
    // (A notch in and a notch out land a rounding error off the fit.)
    const fit = m.total * FIT_U1;
    const lo = fit * (1 - 1e-9), hi = fit * (1 + 1e-9);
    const was = this._span(from), now = this._span(next);
    if (this.pin !== null && ((was < lo && now >= lo) || (was > hi && now <= hi))) {
      this.pin = null;
      return;
    }
    this.pin = next;
  }

  /** A pinch: the window as it was when the fingers landed (`from`), with
   *  the seconds that were under pixel `x0` now under `x1`, `factor` (above 1
   *  = in) times as close. Near the fit's span it snaps to the fit. */
  pinch(from, factor, x0, x1, w, m) {
    const k = w - 2 * PAD;
    const at = from.u0 + ((x0 - PAD) / k) * (from.u1 - from.u0);
    const span = (from.u1 - from.u0) / factor;
    const u0 = at - ((x1 - PAD) / k) * span;
    const next = this._clamp({ ref: from.ref, u0, u1: u0 + span }, m);
    if (next === null) return;
    const fit = m.total * FIT_U1;
    this.pin = Math.abs(this._span(next) / fit - 1) < PINCH_DETENT ? null : next;
  }

  /** Window `from` scrolled by `dx` px (content following the pointer). */
  pan(from, dx, w, m) {
    const du = (dx / (w - 2 * PAD)) * (from.u1 - from.u0);
    const next = this._clamp({ ref: from.ref, u0: from.u0 - du, u1: from.u1 - du }, m);
    if (next !== null) this.pin = next;
  }

  _span(win) { return this.time(win.u1, win.ref) - this.time(win.u0, win.ref); }

  /** Keep a window inside [0, the zoomed-out end]; null when it is narrower
   *  than MIN_SPAN (the zoom stops there). */
  _clamp({ ref, u0, u1 }, m) {
    const end = this.u(m.reach * FIT_U1, ref);
    const width = Math.min(u1 - u0, end);
    const start = Math.min(Math.max(u0, 0), end - width);
    const out = { ref, u0: start, u1: start + width };
    return this._span(out) < MIN_SPAN ? null : out;
  }
}

/** The painted size of a graph canvas, CSS px (paintEnvGraph's w × h). */
export function envGraphSize(canvas) {
  return {
    w: parseFloat(canvas.style.width) || canvas.clientWidth,
    h: parseFloat(canvas.style.height) || canvas.clientHeight,
  };
}

/** The pointer in the painted picture's own pixels. Everything here is
 *  border-box, so the picture is squeezed into the box inside the border, and
 *  a point measured from the outer edge against the inner width missed the
 *  drawing by the border and the squeeze: two pixels at the far end. */
function picturePoint(canvas, e) {
  const { x, y } = localPoint(canvas, e);
  const { w, h } = envGraphSize(canvas);
  return {
    x: (x - canvas.clientLeft) * (w / (canvas.clientWidth || w)),
    y: (y - canvas.clientTop) * (h / (canvas.clientHeight || h)),
  };
}

/** Index of the active node within GRAB_PX of `x`, sideways; −1 for none. */
function hitNode(sc, m, x) {
  let best = -1, bestD = GRAB_PX;
  for (let i = 0; i < m.active; i++) {
    const d = Math.abs(sc.x(m.times[i]) - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Paint an envelope graph `w` × `h` CSS px into `canvas`. `o`: `env`, `max`
 * (the top of the value axis), `axis`, `sus` and `loop` (the control words),
 * `selected` (the node the spinners edit) and `live` ([{ idx, t }], one per
 * voice playing through this envelope: the node it is on and seconds since).
 */
export function paintEnvGraph(canvas, w, h, o) {
  const { env, max, axis } = o;
  const dpr = uiDpr();
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const C = themeColors();
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.cvBg;
  ctx.fillRect(0, 0, w, h);

  const m = envTimes(env);
  const { times, total } = m;
  const sc = axis.scale(w, total);
  const X = (i) => sc.x(times[i]);
  const Y = (v) => h - 14 - (v / max) * (h - 28);

  // ── grids ── magnitude (horizontal, value labels) + time (vertical, seconds)
  ctx.font = canvasMonoFont(9);
  ctx.textAlign = "left";
  ctx.strokeStyle = C.border;
  for (let g = 0; g <= 4; g++) {
    const val = (max * g) / 4;
    const y = Y(val);
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(w - PAD, y); ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = C.dim;
    ctx.fillText(String(Math.round(val)), 1, y - 1.5);
  }
  // A label that would run into the one before it is left out, line and all
  // (the log ladder bunches up near zero on a long envelope), and so is one
  // that would run off the right-hand edge.
  let lastRight = -Infinity;
  for (const { t, step } of timeTicks(sc.t0, sc.t1, axis.log)) {
    const x = sc.x(t);
    const label = secLabel(t, step);
    const right = x + 1 + ctx.measureText(label).width;
    if (x < lastRight + 4 || right > w - 1) continue;
    lastRight = right;
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 12); ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = C.dim;
    ctx.fillText(label, x + 1, h - 3);
  }
  ctx.globalAlpha = 1;

  // Zoomed in, the envelope runs past the edges: keep it off the margins'
  // labels beyond a node's own radius.
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD - 7, 0, w - 2 * PAD + 14, h);
  ctx.clip();

  // sustain / loop region shading
  const shade = (word, color) => {
    if (((word >> 5) & 1) === 0) return;
    const s = Math.min((word >> 8) & 0x1f, 24);
    const e = Math.min(word & 0x1f, 24);
    ctx.fillStyle = color;
    ctx.fillRect(X(s), 0, Math.max(X(e) - X(s), 2), h);
  };
  shade(o.sus, C.envSus);
  shade(o.loop, C.envLoop);

  // polyline + nodes (active nodes only — up to the terminator)
  ctx.strokeStyle = C.envLine;
  ctx.beginPath();
  for (let i = 0; i < m.active; i++) {
    if (i === 0) ctx.moveTo(X(i), Y(env[i].value));
    else ctx.lineTo(X(i), Y(env[i].value));
  }
  ctx.stroke();
  ctx.fillStyle = C.envNode;
  for (let i = 0; i < m.active; i++) {
    ctx.beginPath();
    ctx.arc(X(i), Y(env[i].value), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (o.selected >= 0 && o.selected < m.active) {
    ctx.strokeStyle = C.playCursor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(X(o.selected), Y(env[o.selected].value), 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  ctx.fillStyle = C.live;
  for (const { idx, t } of o.live ?? []) {
    if (idx < 0 || idx > 24) continue;
    const x = sc.x(Math.min(times[idx] + t, total));
    ctx.fillRect(x - 1, 0, 2, h);
  }
  ctx.restore();

  // Zoomed: where the window sits along the whole envelope, as a thin bar.
  if (axis.pin !== null) {
    const end = Math.max(total, sc.t1);
    const span = w - 2 * PAD;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = C.border;
    ctx.fillRect(PAD, 1, span, 3);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = C.accent;
    const a = PAD + (Math.max(sc.t0, 0) / end) * span;
    ctx.fillRect(a, 1, Math.max(PAD + (sc.t1 / end) * span - a, 2), 3);
    ctx.globalAlpha = 1;
  }
}

/**
 * Wire a graph canvas to its editor: node drags, scrolling, the wheel zoom, a
 * two-finger pinch and a double-click to fit. `h` holds the editor's side, every hook asked at the
 * moment it is needed, since the envelope changes under a drag:
 *
 * - `env()` — the node array as it stands; `max` — the value axis' top
 * - `begin(idx)` — a node was grabbed (select it; claim presence)
 * - `change(idx, change)` — one step of its drag: `{ value, prevOffset?,
 *   offset? }`, the codes from envDragNode, every step measured from the
 *   envelope as the press found it
 * - `end(dragged)` — the button came up; `dragged` is false after a scroll
 * - `paint()` — repaint the graph
 */
export function attachEnvGraph(canvas, axis, h) {
  let drag = null;
  const pts = new Map(); // the fingers that count: pointerId → picture point
  const width = () => envGraphSize(canvas).w;

  const step = (e) => {
    const { x, y } = picturePoint(canvas, e);
    const H = envGraphSize(canvas).h;
    const v = Math.round(((H - 14 - y) / (H - 28)) * h.max);
    const change = { value: Math.min(Math.max(v, 0), h.max) };
    if (drag.idx > 0) {
      // The node keeps the distance it was grabbed at, so a press beside it
      // does not move it; the window is held, so the scale is the press's.
      const sc = axis.scale(width(), drag.total);
      const nx = x - drag.grab;
      const slack = Math.abs(sc.t(nx + SLACK_PX) - sc.t(nx - SLACK_PX)) / 2;
      Object.assign(change, envDragNode(drag.orig, drag.idx, sc.t(nx), { carry: e.shiftKey, slack }));
    }
    h.change(drag.idx, change);
    h.paint();
  };

  // A finger's press on a node waits (`pending`) until it moves or lifts, so
  // that a second finger arriving first makes a pinch and leaves the node be.
  const engage = (e) => {
    drag.pending = false;
    axis.hold(drag.total);
    h.begin(drag.idx);
    step(e);
  };

  const capture = (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
  };

  canvas.addEventListener("pointerdown", (e) => {
    if ((e.button ?? 0) > 1) return;
    const m = envTimes(h.env());
    if (drag) {
      // A second finger turns a scroll, or a press on a node that has not
      // moved, into a pinch. A node already being dragged keeps the drag.
      if (e.pointerType !== "touch" || !drag.touch || drag.pinch || pts.size !== 1
          || !(drag.pan || drag.pending)) return;
      capture(e);
      pts.set(e.pointerId, picturePoint(canvas, e));
      const ids = [...pts.keys()];
      drag = { pinch: true, touch: true, ids, from: { ...axis.window(m.total) },
               start: ids.map((id) => pts.get(id)) };
      return;
    }
    const env = h.env();
    const p = picturePoint(canvas, e);
    const sc = axis.scale(width(), m.total);
    const idx = e.button === 1 ? -1 : hitNode(sc, m, p.x);
    capture(e);
    const touch = e.pointerType === "touch";
    if (touch) pts.set(e.pointerId, p);
    if (idx < 0) {
      drag = { id: e.pointerId, touch, pan: true, x0: p.x, from: { ...axis.window(m.total) }, moving: false };
      return;
    }
    drag = { id: e.pointerId, touch, idx, grab: p.x - sc.x(m.times[idx]), orig: envCopy(env),
             total: m.total, pending: touch, x0: p.x, y0: p.y };
    if (!touch) engage(e);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = picturePoint(canvas, e);
    if (drag.pinch) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, p);
      const [a0, b0] = drag.start;
      const [a, b] = drag.ids.map((id) => pts.get(id));
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
      // Fingers that landed on top of each other have no distance to scale by.
      if (d0 < 1) return;
      axis.pinch(drag.from, Math.hypot(b.x - a.x, b.y - a.y) / d0,
        (a0.x + b0.x) / 2, (a.x + b.x) / 2, width(), envTimes(h.env()));
      h.paint();
      return;
    }
    if (e.pointerId !== drag.id) return;
    if (drag.pending) {
      if (Math.hypot(p.x - drag.x0, p.y - drag.y0) >= TOUCH_START_PX) engage(e);
      return;
    }
    if (!drag.pan) { step(e); return; }
    const dx = p.x - drag.x0;
    if (!drag.moving && Math.abs(dx) < PAN_START_PX) return;
    drag.moving = true;
    canvas.style.cursor = "grabbing";
    axis.pan(drag.from, dx, width(), envTimes(h.env()));
    h.paint();
  });

  const finish = (e) => {
    pts.delete(e.pointerId);
    if (!drag) return;
    if (drag.pinch) {
      // The finger left behind starts nothing: it is no press of its own.
      if (drag.ids.includes(e.pointerId)) { drag = null; pts.clear(); }
      return;
    }
    if (e.pointerId !== drag.id) return;
    // A tap on a node still selects it and puts it where it was touched.
    if (drag.pending && e.type === "pointerup") engage(e);
    const dragged = !drag.pan;
    drag = null;
    axis.release();
    canvas.style.cursor = "";
    h.paint();
    h.end(dragged);
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  // The wheel belongs to the graph while the pointer is over it, as in
  // MilkyTracker: up/down zooms about the pointer (Ctrl+wheel and a trackpad
  // pinch too), Shift or a sideways wheel scrolls. Nothing moves mid-drag.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (drag && !drag.pan) return;
    const px = (d) => (e.deltaMode === 1 ? d * 33 : e.deltaMode === 2 ? d * width() : d);
    const dx = px(e.deltaX), dy = px(e.deltaY);
    const m = envTimes(h.env());
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      axis.pan(axis.window(m.total), -(Math.abs(dx) > Math.abs(dy) ? dx : dy), width(), m);
    } else {
      axis.zoom(Math.exp(-dy * WHEEL_ZOOM), picturePoint(canvas, e).x, width(), m);
    }
    h.paint();
  }, { passive: false });

  canvas.addEventListener("dblclick", (e) => {
    const m = envTimes(h.env());
    if (hitNode(axis.scale(width(), m.total), m, picturePoint(canvas, e).x) >= 0) return;
    axis.fit();
    h.paint();
  });
}

/** A "nice" grid interval (1/2/5 × 10ⁿ) giving about six lines over `span`. */
function niceStep(span) {
  const raw = span / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / pow;
  const mult = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return Math.max(mult * pow, 0.001);
}

/** Time gridlines over the window [t0, t1] as `{ t, step }`. Linear: evenly
 *  spaced nice steps, as many as the fit drew over the envelope itself. Log:
 *  a 1/2/5-per-decade ladder (it spreads evenly in log space) — unless zoomed
 *  in so far that fewer than three of it show, when the window is nearly
 *  linear anyway. */
function timeTicks(t0, t1, log) {
  const lo = Math.max(t0, 0);
  if (log) {
    const out = lo <= 1e-9 ? [{ t: 0, step: 1 }] : [];
    for (let e = -3; e <= 2; e++) {
      for (const k of [1, 2, 5]) {
        const t = k * 10 ** e;
        if (t >= lo - 1e-9 && t <= t1 + 1e-9) out.push({ t, step: t });
      }
    }
    if (out.length >= 3) return out;
  }
  const step = niceStep((t1 - lo) * ENV_TIME_FRAC);
  const out = [];
  for (let i = Math.ceil(lo / step - 1e-9); i * step <= t1 + 1e-9; i++) out.push({ t: i * step, step });
  return out;
}

/** "0.25s", "1.5s", and as many places as a fine step needs ("0.004s"). */
function secLabel(t, step) {
  const places = Math.min(4, Math.max(t < 1 ? 2 : 1, Math.ceil(-Math.log10(step) - 1e-9)));
  return t.toFixed(places) + "s";
}
