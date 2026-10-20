// Note names as text, from the tuning's own symbol table, in the tracker's
// grid font.
//
// Touch writes its notes as TEXT, on keys and in cells, in Motif Grid
// (css/touch.css --note-font; the fonts are core/fonts/, shared with the
// tracker), so every sign a tuning has reads as itself: the quarter-tone
// accidentals, Kite's ticks, the double and triple flats. The spelling is the
// tracker's one-cell one (a Kite note cell's), less the two marks a key does
// without: the natural's dash and Kite's dot on an unmarked degree, so a white
// key is just its letter. Unicode has no triple or quadruple sharp; those are
// written as the sharps they are made of. Whatever shows one of these strings
// must be in --note-font: the ticks are private-use characters no other font
// has.

import { resolveNoteSymbol } from "../core/tuning/pitchtables.js";
import { MOTIF, MUSIC } from "../core/fonts/motifglyphs.js";
import { NOTE_OFF } from "./sketch.js";
import { t } from "./i18n.js";

const TICK = { " ": "", ".": "", u: MOTIF.KITE_UP, d: MOTIF.KITE_DOWN, U: MOTIF.KITE_UP2, D: MOTIF.KITE_DOWN2 };
const ACC = {
  "-": "", "#": MUSIC.SHARP, b: MUSIC.FLAT, t: MUSIC.HALF_SHARP, p: MUSIC.REVERSED_FLAT,
  x: MUSIC.DOUBLE_SHARP, B: MUSIC.DOUBLE_FLAT, 3: MUSIC.SHARP + MUSIC.DOUBLE_SHARP,
  T: MUSIC.TRIPLE_FLAT, 4: MUSIC.DOUBLE_SHARP + MUSIC.DOUBLE_SHARP,
};

/** The pitch class alone: "C♯", Kite's up-tick D, E demisharp. */
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
