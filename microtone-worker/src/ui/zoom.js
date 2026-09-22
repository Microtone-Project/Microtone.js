// UI zoom (item 198.4) — the in-app equivalent of the browser's own Ctrl+± .
//
// A page cannot drive the browser's zoom, so this is the app zooming itself:
// a `zoom` on the root element, which scales the DOM chrome, the popups and
// the canvas grids together. Two consequences, both of which every caller has
// to respect, and both of which `uiDpr` / `localPoint` below exist to hide:
//
//   1. LAYOUT pixels shrink. At 125% a 1200 px viewport lays out as 960, so a
//      canvas sized from `host.clientWidth` gets a 960-wide backing store that
//      the browser then blows up to 1200 — a quarter of the grid's crispness
//      thrown away. The backing store therefore carries the zoom as well as
//      the device pixel ratio: that is `uiDpr()`, which is what every canvas
//      here sizes itself by.
//
//   2. POINTER coordinates do not. `clientX`, `offsetX` and
//      `getBoundingClientRect()` all report VISUAL pixels, so the usual
//      `e.clientX - rect.left` is 1.25× the layout distance the canvas painted
//      in. Dividing by the zoom puts it back; `localPoint()` is that division,
//      and a hit test that works in RATIOS (`delta / rect.width`) needs
//      nothing, since the factor cancels.
//
// The steps are the ones a browser offers, so the buttons feel like the
// keyboard shortcut they stand in for. The choice is a per-browser preference
// like the theme: remembered, never part of a document.

const STEPS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5]);
const STORAGE_KEY = "microtone-zoom";
const DEFAULT_ZOOM = 1;

let _zoom = DEFAULT_ZOOM;
const _listeners = new Set();

/** The factor in force. 1 unless someone has zoomed. */
export function uiZoom() { return _zoom; }

/** Canvas backing-store scale: device pixels per LAYOUT pixel. Every canvas in
 *  the app sizes itself by this rather than by `devicePixelRatio` alone. */
export function uiDpr() { return (globalThis.devicePixelRatio || 1) * _zoom; }

/**
 * Where a pointer event landed inside `el`, in that element's own LAYOUT
 * pixels — the coordinate space its canvas painted in. The one conversion
 * every hit test needs; see note 2 in the header for why.
 */
export function localPoint(el, ev) {
  const r = el.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / _zoom, y: (ev.clientY - r.top) / _zoom };
}

/** The inverse trip: a layout-pixel point inside `el`, as client coordinates —
 *  for the synthetic events the keyboard context menu raises (gridmenu.js). */
export function clientPoint(el, x, y) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + x * _zoom, clientY: r.top + y * _zoom };
}

/** Visual pixels → layout pixels. For the few places holding a bare distance
 *  rather than a point (`offsetX`, a viewport width used as a layout bound). */
export function toLayout(px) { return px / _zoom; }

/** "125%", for the readout between the two buttons. */
export function zoomLabel() { return `${Math.round(_zoom * 100)}%`; }

export function canZoomIn() { return _zoom < STEPS[STEPS.length - 1]; }
export function canZoomOut() { return _zoom > STEPS[0]; }

/** One notch along STEPS; `dir` is +1 in, -1 out. Ends are a no-op.
 *  "The next step past where we are" rather than an index walk, so a factor
 *  restored from a build with a different ladder still steps sensibly. */
export function zoomStep(dir) {
  const next = dir > 0
    ? STEPS.find((s) => s > _zoom + 1e-6)
    : STEPS.filter((s) => s < _zoom - 1e-6).pop();
  if (next !== undefined) setUiZoom(next);
}

export function resetZoom() { setUiZoom(DEFAULT_ZOOM); }

/** Apply and remember a factor. Out-of-range values are clamped, not refused —
 *  the stored value is user data and a stale one must never wedge the app. */
export function setUiZoom(z) {
  const next = Math.min(Math.max(Number(z) || DEFAULT_ZOOM, STEPS[0]), STEPS[STEPS.length - 1]);
  if (Math.abs(next - _zoom) < 1e-6) return;
  _zoom = next;
  applyZoom();
  try {
    if (next === DEFAULT_ZOOM) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(next));
  } catch { /* private mode — the zoom still applies, it just is not remembered */ }
  for (const fn of _listeners) fn(_zoom);
}

/** Fired after every change, so the canvas views can re-measure. Most of them
 *  are woken by their own ResizeObserver anyway — the root's layout width
 *  really does change — but a canvas sized in fixed pixels would not be. */
export function onZoomChange(fn) { _listeners.add(fn); }

function applyZoom() {
  const root = document.documentElement;
  // At 100% the property comes OFF rather than going to "1": a page with no
  // zoom at all is the one configuration every browser agrees about.
  if (_zoom === DEFAULT_ZOOM) root.style.removeProperty("zoom");
  else root.style.zoom = String(_zoom);
}

/** Boot-time zoom: the remembered factor, else 100%. Call before the first paint. */
export function initZoom() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  const z = Number(saved);
  _zoom = Number.isFinite(z) && z > 0
    ? Math.min(Math.max(z, STEPS[0]), STEPS[STEPS.length - 1])
    : DEFAULT_ZOOM;
  applyZoom();
}
