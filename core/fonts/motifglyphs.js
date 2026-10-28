// The code points of the Motif fonts' own symbols (design-system/fonts,
// motiffont/symbols.py draws them; the fonts sit beside this file). Motif Grid
// carries all of them; Motif Code and Motif Mono carry the single-cell
// accidentals. A canvas or a DOM node that means to show one sets its font to
// Motif Grid (the tracker's --cv-font, Touch's --note-font) and writes the
// character. Both apps spell notes from here: the tracker's cellpaint.js and
// Microtone Touch's notes.js.
//
// Widths are in cells — one cell is Motif Grid's advance, 0.6 em.

/** Private-use symbols (Motif Grid only). */
export const MOTIF = Object.freeze({
  // Kite notation ticks, one cell. Up: top on the capital height; down: bottom
  // on the baseline; a double pair spans the capitals; the dot is the
  // unmarked degree, centred.
  KITE_UP: "\uF000",
  KITE_DOWN: "\uF001",
  KITE_UP2: "\uF002",
  KITE_DOWN2: "\uF003",
  KITE_DOT: "\uF004",
  // Volume and panning slides, one cell, centred on the capitals.
  VOL_UP: "\uF00C",
  VOL_DOWN: "\uF00D",
  PAN_LEFT: "\uF00E",
  PAN_RIGHT: "\uF00F",
  // Accidentals two cells wide: the note cell's [letter][acc acc][octave].
  SHARP2: "\uF010",
  FLAT2: "\uF011",
  DOUBLE_SHARP2: "\uF012",
  DOUBLE_FLAT2: "\uF013",
  TRIPLE_FLAT2: "\uF014",
  HALF_SHARP2: "\uF015",
  SESQUI_SHARP2: "\uF016",
  REVERSED_FLAT2: "\uF017",
  SESQUI_FLAT2: "\uF018",
  // No code point exists for these two (Unicode spells them ♯𝄪 and 𝄪𝄪):
  // one two-cell glyph each, the double sharps enlarged and, in the
  // quadruple, overlapping.
  TRIPLE_SHARP2: "\uF019",
  QUADRUPLE_SHARP2: "\uF01A",
  // The tracker's natural, the "-" of "C-4": the minus centred on two cells.
  NATURAL2: "\uF01B",
  // Note sentinels, four cells: the whole note cell.
  KEY_OFF: "\uF030",
  NOTE_CUT: "\uF031",
  FADE: "\uF032",
  FAST_FADE: "\uF033",
  // Vibrato (and LFO) waveforms, two cells, one period edge to edge — written
  // twice they draw two seamless periods.
  WAVE_SINE: "\uF040",
  WAVE_RAMP_DOWN: "\uF041",
  WAVE_SQUARE: "\uF042",
  WAVE_RANDOM: "\uF043",
  WAVE_RAMP_UP: "\uF044",
  WAVE_TRIANGLE: "\uF045",
});

/** Unicode's own accidentals, one cell (Unicode 18.0 for the last five). */
export const MUSIC = Object.freeze({
  SHARP: "\u266F",
  NATURAL: "\u266E",
  FLAT: "\u266D",
  DOUBLE_SHARP: "\u{1D12A}",
  DOUBLE_FLAT: "\u{1D12B}",
  TRIPLE_FLAT: "\u{1D260}",
  HALF_SHARP: "\u{1D1EB}",
  SESQUI_SHARP: "\u{1D1EC}",
  REVERSED_FLAT: "\u{1D1ED}",
  SESQUI_FLAT: "\u{1D1EE}",
});

/** The width, in cells, of a character in Motif Grid (the font test pins it
 *  for every one above): the symbols by their block, the lü two. */
export function motifCells(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0xf030 && cp <= 0xf03f) return 4;
  if ((cp >= 0xf010 && cp <= 0xf01f) || (cp >= 0xf040 && cp <= 0xf04f)) return 2;
  if (cp >= 0x2e80 && cp <= 0x9fff) return 2;
  return 1;
}
