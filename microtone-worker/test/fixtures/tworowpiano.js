// The two-row piano: the keyboard Microtone had from the start until 4.8.4,
// when it was retired for the Double-Deck pianos. Kept as a TEST FIXTURE, not
// a layout anyone can pick, because it is the shape a user's own layout can
// still have — semitones (unit "semi"), the bottom row left to the note
// column's sentinels — and its three half-sharp keys are the quarter-tone
// cases semiToNoteInTable has to get right.
//
//   (q) w e (r) t y u (i) o p
//      a s d   f g h j | k l ;
//
// White: a … ; → C D E F G A B +C +D +E; black: w e t y u o p. q, r and i sit
// where a piano has no black key and play the half-sharp of the white key to
// their left (q borrows from the octave below).

import { normaliseKeymap } from "../../src/ui/keymap.js";

export const TWO_ROW_SEMIS = Object.freeze({
  KeyQ: -0.5,
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyR: 4.5, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyI: 11.5, KeyK: 12,
  KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
});

export const TWO_ROW_PIANO = normaliseKeymap({
  name: "Two-row piano (fixture)", unit: "semi", rows: ["Q", "A"],
  origin: { code: "KeyA", value: 0 }, x: 0, y: 0,
  overrides: TWO_ROW_SEMIS,
});
