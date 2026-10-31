// Which instrument a lane is sounding at a given row — for the editor tools
// whose answer depends on it (item 272: `S $Axxx` is read by the INSTRUMENT,
// so interpolating one needs to know which reading it is).
//
// An instrument stays in force on a lane until a note names another, so the
// answer for a row is the last row at or above it that STRUCK a note with an
// instrument. A cell naming an instrument without a pitch strikes nothing, and
// a pitch without an instrument keeps the one before.
//
// The walk back through the song follows the cue list in order, the way the
// Timeline lays it out; jumps are not followed (they are shown, not played,
// there too). Pure — a song and its instruments in, numbers out.

import { cueInfo } from "./document.js";

const PAT_MASK = 0x7fff;

/** True when the cell strikes a note that names its instrument. */
const strikes = (cell) => !!cell && cell.instrment !== 0 && cell.note >= 0x20;

/**
 * How instrument `slot` reads `S $Axxx` (TAUD_NOTE_EFFECTS.md, "S $Axxx"):
 * "fm" an FM rack's `$Apsd`, "formant" a formant instrument's `$Afgr`, "psg" a
 * PSG instrument's register write, "none" an instrument it means nothing to.
 * A layered instrument passes the command to its layers, so it reads it the
 * way they all do — "mixed" when they disagree. Null for no instrument.
 */
export function soundControlKind(instruments, slot, depth = 0) {
  const inst = slot > 0 ? instruments[slot] : null;
  if (!inst) return null;
  if (inst.isFm) return "fm";
  if (inst.isFormant) return "formant";
  if (inst.isPsg) return "psg";
  if (!inst.isMeta || depth > 8) return "none";
  const kinds = new Set();
  for (const layer of inst.metaLayers) {
    const k = soundControlKind(instruments, layer.instIdx, depth + 1);
    if (k !== null && k !== "none") kinds.add(k);
  }
  return kinds.size === 0 ? "none" : kinds.size === 1 ? [...kinds][0] : "mixed";
}

/**
 * The instrument in force on lane `ch` just BEFORE row `row` of cue `cue`, or
 * 0 when nothing above it struck one.
 */
export function instrumentBefore(song, ch, cue, row) {
  for (let c = cue; c >= 0; c--) {
    const words = song.cues[c];
    if (!words) continue;
    const pat = song.patterns[(words[ch] ?? PAT_MASK) & PAT_MASK];
    if (!pat) continue;
    const from = c === cue ? row - 1 : cueInfo(words).rowLimit - 1;
    for (let r = Math.min(from, pat.length - 1); r >= 0; r--) {
      if (strikes(pat[r])) return pat[r].instrment;
    }
  }
  return 0;
}

/**
 * The instruments that can be in force just before row `row` of pattern `pat`,
 * as a pattern on its own sees it: the one the rows above it in the pattern
 * struck, and failing that, the one in force at each place in the song the
 * pattern is played (0 where nothing is). Distinct slots, in song order; empty
 * when the pattern plays nowhere.
 */
export function patternInstrumentsBefore(song, pat, row) {
  const cells = song.patterns[pat];
  if (cells) {
    for (let r = Math.min(row, cells.length) - 1; r >= 0; r--) {
      if (strikes(cells[r])) return [cells[r].instrment];
    }
  }
  const found = new Set();
  for (let c = 0; c < song.cues.length; c++) {
    const words = song.cues[c];
    for (let ch = 0; ch < words.length; ch++) {
      if ((words[ch] & PAT_MASK) === pat) found.add(instrumentBefore(song, ch, c, 0));
    }
  }
  return [...found];
}

/** The one kind (soundControlKind) every slot in `slots` agrees on, else null. */
export function agreedKind(instruments, slots) {
  let kind;
  for (const s of slots) {
    const k = soundControlKind(instruments, s);
    if (k === null) return null;
    if (kind !== undefined && k !== kind) return null;
    kind = k;
  }
  return kind ?? null;
}
