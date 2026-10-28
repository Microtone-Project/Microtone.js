// One CRT vectorscope panel (items 106, 257) — the master strip's Goniometer
// and the Mastering view's, drawn by the same beam.
//
// crtbeam.js is the physics, and touches no DOM; this is what stands between
// it and a canvas: the beam's energy buffer, the small canvas it is developed
// into and blitted through, and the auto-gain a hardware vectorscope has.
// A caller hands it the samples that arrived since its last frame, already in
// dial units, and says where on its own canvas the dial sits.

import { CrtBeam, beamCoreInk } from "./crtbeam.js";

/** Time constant of the vectorscope auto-gain, both directions. Long enough
 *  that the dial BREATHES with the music instead of snapping at every
 *  transient — the trace's shape is the reading, and a gain that jumps makes
 *  shapes impossible to compare from one moment to the next. */
export const SCOPE_GAIN_SLEW_MS = 300;
/** How much of the dial's radius the auto-gain aims to fill. */
export const SCOPE_GAIN_FILL = 0.92;
/**
 * …taken back by this much, because the peak it divides by is a B-FORMAT
 * COMPONENT and not the delivered mix. A mono full-scale mix peaks at √2 in W,
 * but a hard-panned or wide one peaks at only ~0.71 in W and Y alike — so the
 * bare fill target asks for 1.3× on material that is already clipping, which is
 * the one case where the gain has to be 1. The headroom pulls that back under
 * the floor, and costs every other reading a fifth of its size.
 */
export const SCOPE_GAIN_HEADROOM = 0.7;
/** Ceiling, so a near-silent passage does not amplify the dither into a disc. */
export const SCOPE_GAIN_MAX = 64;

/**
 * The gain a window that peaked at `peak` asks for: enough to fill the dial,
 * never below 1 (the scope is a magnifier, and shrinking a mix that already
 * fills the dial would only hide how wide it is), never above the ceiling.
 */
export function scopeAutoGain(peak) {
  const want = (SCOPE_GAIN_FILL * SCOPE_GAIN_HEADROOM) / Math.max(peak, 1e-4);
  return Math.max(1, Math.min(want, SCOPE_GAIN_MAX));
}

/** "#rgb" / "#rrggbb" / "rgb(…)" → [r, g, b]; anything else → mid grey. */
export function parseInk(css) {
  const s = String(css ?? "").trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
    if (h.length >= 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((x) => parseInt(x, 10));
    if (p.length >= 3 && p.every((x) => Number.isFinite(x))) return p.slice(0, 3);
  }
  return [128, 128, 128];
}

/**
 * One display frame of an exponential approach to `want`, so the result after a
 * given stretch of TIME is the same however many frames it was cut into — the
 * display moves at the same speed on a 30 fps machine as on a 144 fps one.
 */
export function slewTowards(prev, want, dtMs, tauMs) {
  if (!(dtMs > 0)) return prev;
  return prev + (want - prev) * (1 - Math.exp(-dtMs / tauMs));
}

export class CrtScope {
  constructor() {
    /** The auto-gain, slewed (see follow). */
    this.gain = 1;
    this.cell = null;
  }

  /** Blank the phosphor and lift the beam. */
  clear() { this.cell?.beam.clear(); }

  /**
   * Slew the gain toward what a window that peaked at `peak` asks for. The
   * peak is a WINDOW statistic — a caller reads the whole ring for it however
   * few samples this frame draws, or it would wobble with every transient.
   */
  follow(peak, dtMs) {
    this.gain = slewTowards(this.gain, scopeAutoGain(peak), dtMs, SCOPE_GAIN_SLEW_MS);
    return this.gain;
  }

  /**
   * One frame: let the phosphor decay by `dtMs`, sweep the beam through the
   * `n` new samples of `xs`/`ys` (dial units, ±1 the rim, +y up — the gain
   * already applied), develop it in `ink` on `ground`, and blit it centred on
   * (cx, cy) with radius `r`. `gap` lifts the beam first, so a trace that is
   * not continuous with the last one is not joined to it. `kind` is the
   * caller's name for what the dial shows: a change of it blanks the screen.
   */
  draw(ctx, cx, cy, r, ink, ground, xs, ys, n, dtMs, gap, kind = null) {
    const size = Math.ceil(2 * r) + 2;
    const cell = this._cell(size, ink, ground, kind);
    const beam = cell.beam;
    beam.decay(dtMs);
    if (n > 0) {
      if (gap) beam.lift();
      beam.trace(xs, ys, n);
    }
    beam.develop(cell.image.data, cell.rgb, cell.core);
    cell.ctx.putImageData(cell.image, 0, 0);
    ctx.drawImage(cell.canvas, cx - size / 2, cy - size / 2);
  }

  /** The magnification, where a dial shows it: only once it is magnifying. */
  drawGain(ctx, C, x, y) {
    if (this.gain <= 1.05) return;
    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`×${this.gain.toFixed(1)}`, x, y);
  }

  /**
   * The beam, its blit canvas and its ImageData. The beam survives a theme
   * change (only the ink is re-parsed) but not a resize or a change of view:
   * both of those move every pixel of it, and the phosphor would spend half a
   * second showing the previous geometry.
   */
  _cell(size, ink, ground, kind) {
    let c = this.cell;
    if (c === null || c.size !== size) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const cctx = canvas.getContext("2d");
      c = this.cell = {
        size, ink: null, ground: null, kind, rgb: [128, 128, 128], core: [255, 255, 255],
        canvas, ctx: cctx,
        image: cctx.createImageData(size, size), beam: new CrtBeam(size),
      };
    }
    if (c.ink !== ink) {
      c.ink = ink;
      c.rgb = parseInk(ink);
    }
    if (c.ground !== ground) {
      c.ground = ground;
      c.core = beamCoreInk(parseInk(ground));
    }
    if (c.kind !== kind) {
      c.kind = kind;
      c.beam.clear();
    }
    return c;
  }
}
