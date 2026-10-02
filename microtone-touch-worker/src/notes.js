// Note names as plain text, from the tuning's own symbol table.
//
// The tracker paints its accidentals as glyphs on a canvas; Touch writes them
// as TEXT, on keys and in cells, so every character here has to exist in a
// phone's stock fonts. Sharps and flats do (♯ ♭); the quarter-tone and Kite
// symbols in the Musical Symbols block often do not, so those fall back to
// the plain-text spellings microtonal writing already uses: C+ / Dd for the
// half-sharp and half-flat, arrows for Kite's up and down ticks.

import { resolveNoteSymbol, nearestDegreeIndex } from "../core/tuning/pitchtables.js";
import { NOTE_OFF } from "./sketch.js";

const TICK = { " ": "", ".": "", u: "↑", d: "↓", U: "⇈", D: "⇊" };
const ACC = {
  "-": "", "#": "♯", b: "♭", t: "+", p: "d",
  x: "x", B: "♭♭", 3: "♯x", T: "♭♭♭", 4: "xx",
};

/** The pitch class alone: "C♯", "↑D", "E+". */
export function noteClass(note, preset) {
  const s = resolveNoteSymbol(note, preset);
  if (!s) return "?";
  if (s.cjk) return s.cjk;
  return (TICK[s.tick] ?? "") + s.letter + (ACC[s.acc] ?? "");
}

/** The full label with its octave: "C♯4". A key-off reads "off". */
export function noteLabel(note, preset) {
  if (note === NOTE_OFF) return "off";
  const s = resolveNoteSymbol(note, preset);
  if (!s) return "?";
  return noteClass(note, preset) + s.octave;
}

/** How a key should be shaded: "natural", "near" (a Kite tick or a
 *  quarter-tone off one), or "accidental". Shi'er lü has no accidentals; it
 *  has its own split, the six yang lü (律, the even degrees from 黃) and the
 *  six yin lü (呂, the odd ones), and that is what its keys are shaded by. */
export function noteShade(note, preset) {
  const s = resolveNoteSymbol(note, preset);
  if (!s) return "natural";
  if (s.cjk) return nearestDegreeIndex(note, preset).index % 2 === 0 ? "natural" : "accidental";
  if (s.acc === "-" ) return s.tick === " " || s.tick === "." ? "natural" : "near";
  if (s.acc === "t" || s.acc === "p") return "near";
  return "accidental";
}
