// Note glyphs for the DOM editors — the grids' own note painter, in a canvas
// small enough to sit inline in a table cell or a preview row.
//
// The pattern and timeline grids paint every note through glyphs.js, so a note
// reads in the SONG's notation: 24-TET's demisharps, Kite's tick marks, Shi'er
// lü's CJK, and the off-grid yellow when a pitch sits between two degrees. The
// DOM editors had no way to say that and spelled their notes with
// notenames.js's noteToStr, which is 12-EDO by construction — so a
// metainstrument's layers read "C-4" in a song that has never heard of C.
//
// This is the bridge: build the nodes, drop them where the text used to go.
// Sizes match the chord maker's note rows (13 px, a font size app.js
// pre-loads), so a note is the same size and shape everywhere it appears
// outside the grids.

import { paintNoteCell, NOTE_CELL_CHARS } from "./glyphs.js";
import { rangeBoundsOpen } from "./notenames.js";
import { canvasFont } from "./fonts.js";
import { themeColors } from "./theme.js";
import { uiDpr } from "./zoom.js";

const FONT_PX = 13;
export const NOTE_GLYPH_CHAR_W = 9;
export const NOTE_GLYPH_H = 20;

/**
 * A canvas painting `items` left to right: a NUMBER is a note word, painted as
 * a note cell in `preset`'s notation; a STRING is a literal separator, painted
 * dim. The canvas has no background of its own, so it sits on whatever panel
 * it lands in.
 */
export function noteRunCanvas(items, preset) {
  const dpr = uiDpr();
  const cv = document.createElement("canvas");
  cv.className = "note-glyph";

  // Measure first: setting canvas.width resets every context property, so the
  // paint pass below has to re-establish the font either way.
  const measure = cv.getContext("2d");
  measure.font = canvasFont(FONT_PX);
  let w = 2;
  for (const item of items) {
    w += typeof item === "number"
      ? NOTE_CELL_CHARS * NOTE_GLYPH_CHAR_W
      : Math.ceil(measure.measureText(item).width);
  }

  cv.width = Math.ceil(w * dpr);
  cv.height = Math.ceil(NOTE_GLYPH_H * dpr);
  cv.style.width = w + "px";
  cv.style.height = NOTE_GLYPH_H + "px";

  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = canvasFont(FONT_PX);
  ctx.textBaseline = "middle";
  const C = themeColors();
  const palette = { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent };
  let x = 1;
  for (const item of items) {
    if (typeof item === "number") {
      paintNoteCell(ctx, item, preset, x, 0, NOTE_GLYPH_CHAR_W, NOTE_GLYPH_H, palette);
      x += NOTE_CELL_CHARS * NOTE_GLYPH_CHAR_W;
    } else {
      ctx.fillStyle = C.dim;
      ctx.fillText(item, x, NOTE_GLYPH_H / 2);
      x += ctx.measureText(item).width;
    }
  }
  return cv;
}

/** One note, in the song's notation. */
export function noteGlyphCanvas(note, preset) {
  return noteRunCanvas([note], preset);
}

/**
 * A note RANGE, in the song's notation — the glyph counterpart of
 * notenames.js rangeToStr, and it collapses open bounds exactly as that does:
 * a range open at both ends is the translated "whole range" and paints no
 * notes at all, so `wholeText` is passed in rather than looked up here.
 */
export function rangeGlyphCanvas(lo, hi, preset, wholeText) {
  const { openLo, openHi } = rangeBoundsOpen(lo, hi);
  if (openLo && openHi) return noteRunCanvas([wholeText], preset);
  if (openLo) return noteRunCanvas(["~", hi], preset);
  if (openHi) return noteRunCanvas([lo, "~"], preset);
  return noteRunCanvas([lo, "‥", hi], preset);
}
