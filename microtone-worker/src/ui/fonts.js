// Canvas webfont plumbing. The tracker-grid typeface is the --cv-font custom
// property in css/microtone.css, and the one for labels and numbers is
// --mono-font; the canvas views build their ctx.font through canvasFont() /
// canvasMonoFont() so ANY webfont declared there (@font-face, FontFace API)
// works. One catch makes this module necessary:
// canvas fillText never TRIGGERS a webfont download — only DOM usage does —
// so an undownloaded face silently renders as the fallback forever.
// loadCanvasFonts() force-loads the stack through the CSS Font Loading API
// and fires a repaint callback once the real faces are in.

const FALLBACK = 'ui-monospace, "Cascadia Mono", "DejaVu Sans Mono", monospace';

const _families = new Map();

/** A family stack from a custom property (cached — getComputedStyle is too
 *  slow for per-frame reads; see refreshCanvasFont). */
function familyOf(token) {
  let f = _families.get(token);
  if (f === undefined) {
    f = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || FALLBACK;
    _families.set(token, f);
  }
  return f;
}

/** The --cv-font family stack. */
export function canvasFontFamily() {
  return familyOf("--cv-font");
}

/** ctx.font string for the tracker grid at `px`. */
export function canvasFont(px) {
  return `${px}px ${familyOf("--cv-font")}`;
}

/** ctx.font string for a canvas's labels and numbers at `px` (Motif Mono). */
export function canvasMonoFont(px) {
  return `${px}px ${familyOf("--mono-font")}`;
}

/** ctx.font string for a canvas's labels and numbers at `px` (Motif Code). */
export function canvasCodeFont(px) {
  return `${px}px ${familyOf("--code-font")}`;
}

/** Drop the cached families — call when --cv-font or --mono-font may have
 *  changed (theme switch, live experimentation from the console). */
export function refreshCanvasFont() {
  _families.clear();
}

/**
 * Force-load the webfont faces the canvas views use (one load per size the
 * views draw at), then fire onReady so they repaint with the real font —
 * paints before this resolves may show the fallback stack.
 */
export async function loadCanvasFonts(sizes, onReady) {
  try {
    await Promise.all(sizes.flatMap((px) => [canvasFont(px), canvasMonoFont(px), canvasCodeFont(px)].map((f) => document.fonts.load(f))));
    await document.fonts.ready;
  } catch { /* no Font Loading API / blocked fetch — the fallback stack stands */ }
  onReady?.();
}
