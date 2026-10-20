// Note glyphs for the DOM editors — a note spelled exactly as the grids spell
// it, as ordinary text in the grids' font.
//
// The pattern and timeline grids spell every note through cellpaint.js, so a
// note reads in the SONG's notation: 24-TET's demisharps, Kite's tick marks,
// Shi'er lü's ideographs, and the off-grid yellow when a pitch sits between
// two degrees. The DOM editors had no way to say that and spelled their notes
// with notenames.js's noteToStr, which is 12-EDO by construction — so a
// metainstrument's layers read "C-4" in a song that has never heard of C.
//
// Every mark of a note cell is a character of Motif Grid (cellpaint.js
// noteCellText), so a note here is a span of text in --cv-font: it sits on the
// line's baseline, takes the line's size and the theme's colours, and is read
// by a screen reader as what it is. Styling: .note-glyph in css/microtone.css.

import { noteCellText } from "../cellpaint.js";
import { rangeBoundsOpen } from "../notenames.js";

/**
 * A span holding `items` left to right: a NUMBER is a note word, spelled as a
 * note cell in `preset`'s notation; a STRING is a literal separator, dim.
 */
export function noteRun(items, preset) {
  const run = document.createElement("span");
  run.className = "note-glyph";
  for (const item of items) {
    const part = document.createElement("span");
    if (typeof item === "number") {
      const { text, ink, faint } = noteCellText(item, preset);
      part.className = "ng-note" + (ink === "note" ? "" : ` ng-${ink}`) + (faint ? " ng-faint" : "");
      part.textContent = text;
    } else {
      part.className = "ng-sep";
      part.textContent = item;
    }
    run.appendChild(part);
  }
  return run;
}

/** One note, in the song's notation. */
export function noteGlyph(note, preset) {
  return noteRun([note], preset);
}

/**
 * A note RANGE, in the song's notation — the glyph counterpart of
 * notenames.js rangeToStr, and it collapses open bounds exactly as that does:
 * a range open at both ends is the translated "whole range" and spells no
 * notes at all, so `wholeText` is passed in rather than looked up here.
 */
export function rangeGlyph(lo, hi, preset, wholeText) {
  const { openLo, openHi } = rangeBoundsOpen(lo, hi);
  if (openLo && openHi) return noteRun([wholeText], preset);
  if (openLo) return noteRun(["~", hi], preset);
  if (openHi) return noteRun([lo, "~"], preset);
  return noteRun([lo, "‥", hi], preset);
}
