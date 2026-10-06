// Note names as plain text, from the tuning's own symbol table.
//
// The tracker paints its accidentals as glyphs on a canvas; Touch writes them
// as TEXT, on keys and in cells, so every character here has to exist in a
// phone's stock fonts. Sharps and flats do (♯ ♭); the quarter-tone and Kite
// symbols in the Musical Symbols block often do not, so those fall back to
// the plain-text spellings microtonal writing already uses: C+ / Dd for the
// half-sharp and half-flat, arrows for Kite's up and down ticks.

import { resolveNoteSymbol } from "../core/tuning/pitchtables.js";
import { NOTE_OFF } from "./sketch.js";
import { t } from "./i18n.js";

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

/** The full label with its octave: "C♯4". A key-off reads "off" (the
 *  language's cell.off). */
export function noteLabel(note, preset) {
  if (note === NOTE_OFF) return t("cell.off");
  const s = resolveNoteSymbol(note, preset);
  if (!s) return "?";
  return noteClass(note, preset) + s.octave;
}

/** Shi'er lü has no accidentals, so its keys are shaded by name: white for
 *  黃 太 仲 林 無, grey for 姑 南, black for the other five. */
const LU_SHADE = {
  "\u9EC3": "natural", "\u592A": "natural", "\u4EF2": "natural", "\u6797": "natural", "\u7121": "natural", // 黃 太 仲 林 無
  "\u59D1": "near", "\u5357": "near",                                                                        // 姑 南
  "\u5927": "accidental", "\u593E": "accidental", "\u8564": "accidental", "\u5937": "accidental", "\u61C9": "accidental", // 大 夾 蕤 夷 應
};

/** How a key should be shaded: "natural" (white), "near" (grey: a Kite tick
 *  or a quarter-tone off a natural), or "accidental" (black). */
export function noteShade(note, preset) {
  const s = resolveNoteSymbol(note, preset);
  if (!s) return "natural";
  if (s.cjk) return LU_SHADE[s.cjk] ?? "accidental";
  if (s.acc === "-" ) return s.tick === " " || s.tick === "." ? "natural" : "near";
  if (s.acc === "t" || s.acc === "p") return "near";
  return "accidental";
}
