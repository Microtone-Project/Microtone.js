// ProTracker pitch (sMet notation 1) + the `interval: 0` absolute-table mode
// it is the built-in example of.
//
// Why this notation exists: ProTracker tunes from a hand-made table of INTEGER
// Amiga periods (Paula divides a reference clock by a period counter), not from
// 12-TET. Its notes therefore sit up to ~6 cents off the 12-TET grid, and the
// table is not even exactly octave-periodic — E-3 is period 170, not 339/2 =
// 169.5 — so no single period of a repeating lattice can describe it. Hence
// terranmon.txt §nota's second mode: "If you are not using an interval system
// (which means you are responsible for defining every note expressible), this
// must be 0".
//
// The period table below is ProTracker's own, restated here as a golden vector
// rather than re-derived from the preset — a bug in the preset's construction
// must fail this file, not agree with itself. Octaves 1-3 are PT's table
// verbatim; 0 and 4 are the FT2/OpenMPT extension the preset also covers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pitchTablePresets, presetForNotation, resolveNoteSymbol, stepNoteInTable,
  transposePatternNotes, surveyTuning, retuneAllPatterns, ANCHOR_NOTE, OFF_GRID_TOL,
} from "../../core/tuning/pitchtables.js";

const PT = presetForNotation(1);

// ProTracker's period table, finetune 0.
const PT_OCTAVES = [
  [1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 907], // ext
  [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453],
  [428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226],
  [214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113],
  [107, 101, 95, 90, 85, 80, 75, 71, 67, 63, 60, 56],                     // ext
];
const PT_PERIODS = PT_OCTAVES.flat();
const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

/** mod2taud's period_to_taud_note: the contract this table has to satisfy. */
const noteForPeriod = (period) =>
  Math.round(ANCHOR_NOTE + 4096 * Math.log2(428 / period));

const cell = (note, inst = 0) => ({ note, instrment: inst });
const songOf = (notes) => ({ patterns: [notes.map((n) => cell(n, 1))] });

test("ProTracker pitch has the nota interval-0 shape", () => {
  assert.equal(PT.index, 1);
  assert.equal(PT.name, "ProTracker Temperament"); // renamed in e31d771
  assert.equal(PT.interval, 0, "interval 0 = no interval system");
  assert.equal(PT.t, "d", "12 notes per octave");
  assert.equal(PT.table.length, 60);
  assert.equal(PT.sym.length, 60);

  // Spec shape: offsets are relative to the base note, index 0 is 0x0, and
  // every offset fits a Uint16 — so the table could serialise into a nota def.
  assert.equal(PT.table[0], 0, "index zero of the table must be 0x0");
  assert.ok(PT.table.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffff));
  for (let i = 1; i < PT.table.length; i++) {
    assert.ok(PT.table[i] > PT.table[i - 1], `table must ascend (degree ${i})`);
  }
  // Period 1712 = 4 x 428, i.e. exactly two octaves below the C4 anchor.
  assert.equal(PT.base, ANCHOR_NOTE - 2 * 0x1000);
  assert.equal(PT.base, 0x3000);
});

test("every ProTracker period lands exactly on a degree, in tune", () => {
  assert.equal(PT_PERIODS.length, 60);
  PT_PERIODS.forEach((period, i) => {
    const note = noteForPeriod(period);
    // Exactly ON a degree — not merely within tolerance.
    assert.ok(PT.table.includes(note - PT.base),
      `period ${period} (note ${note}) is not a degree`);

    const r = resolveNoteSymbol(note, PT);
    assert.equal(r.letter + r.acc, NAMES[i % 12], `period ${period} letter`);
    assert.equal(r.octave, 2 + Math.floor(i / 12), `period ${period} octave`);
    assert.equal(r.offGrid, false, `period ${period} must read in tune`);
  });
});

test("the PT table is not octave-periodic — the reason interval 0 is needed", () => {
  // E-2 (339) and E-3 (170): a strict octave apart would be 339/2 = 169.5.
  const e2 = noteForPeriod(339), e3 = noteForPeriod(170);
  assert.notEqual(e3 - e2, 0x1000);
  assert.equal(e3 - e2, 0x1000 - 18, "PT's E-3 is 18 units (5.3 cents) flat");
  // Both are still exact degrees here — they are simply SEPARATE degrees,
  // which is precisely what a repeating lattice could not express.
  for (const n of [e2, e3]) assert.ok(PT.table.includes(n - PT.base));

  // On 12-TET BOTH read out of tune — PT's E sits 13 units sharp of 12-TET's
  // in every octave, which is why .mod imports used to paint yellow wholesale.
  const p12 = presetForNotation(120);
  assert.equal(resolveNoteSymbol(e2, p12).offGrid, true);
  assert.equal(resolveNoteSymbol(e3, p12).offGrid, true);
});

test("a song of ProTracker periods is fully in tune on PT, badly off on 12-TET", () => {
  const song = songOf(PT_PERIODS.map(noteForPeriod));
  const onPt = surveyTuning(song, PT, null);
  assert.equal(onPt.total, 60);
  assert.equal(onPt.offGrid, 0, "no PT note may read out of tune");
  assert.equal(onPt.wouldChange, 0, "and none is merely within tolerance");

  const on12 = surveyTuning(song, presetForNotation(120), null);
  assert.ok(on12.offGrid > 20, `12-TET should flag many (got ${on12.offGrid})`);
});

test("stepping an absolute table walks semitones and clamps at both ends", () => {
  const c2 = noteForPeriod(428);
  const up = stepNoteInTable(c2, PT, 1), down = stepNoteInTable(c2, PT, -1);
  assert.equal(up, noteForPeriod(404), "up from C-2 is C#2 (period 404)");
  assert.equal(down, noteForPeriod(453), "down from C-2 is B-1 (period 453)");

  // The table's ends are the limit of what the notation can express, so a step
  // past them stays put rather than wrapping into a period that has no degrees.
  const lo = PT.base + PT.table[0], hi = PT.base + PT.table[59];
  assert.equal(stepNoteInTable(lo, PT, -1), lo);
  assert.equal(stepNoteInTable(hi, PT, 1), hi);
  assert.equal(stepNoteInTable(lo, PT, 1), PT.base + PT.table[1]);
  assert.equal(stepNoteInTable(hi, PT, -1), PT.base + PT.table[58]);
});

test("transpose: fine steps a semitone, coarse an octave — both exact", () => {
  const at = (p) => songOf([noteForPeriod(p)]);

  let song = at(428);
  transposePatternNotes(song, 0, PT, null, 1, 0);
  assert.equal(song.patterns[0][0].note, noteForPeriod(404), "fine +1 = C#2");

  song = at(428);
  transposePatternNotes(song, 0, PT, null, 0, 1);
  assert.equal(song.patterns[0][0].note, noteForPeriod(214), "coarse +1 = C-3");

  song = at(428);
  transposePatternNotes(song, 0, PT, null, 0, -1);
  assert.equal(song.patterns[0][0].note, noteForPeriod(856), "coarse -1 = C-1");

  // Coarse re-snaps onto the table, so it stays exact even where the octave is
  // not a clean doubling: E-2 -> E-3 is PT's 18-unit-flat entry, not e2+0x1000.
  song = at(339);
  transposePatternNotes(song, 0, PT, null, 0, 1);
  assert.equal(song.patterns[0][0].note, noteForPeriod(170));

  // Fine clamps at the ends rather than running off the table.
  song = at(56);
  transposePatternNotes(song, 0, PT, null, 5, 0);
  assert.equal(song.patterns[0][0].note, PT.base + PT.table[59]);
});

test("retune onto ProTracker pitch snaps 12-TET notes to the period grid", () => {
  const p12 = presetForNotation(120);
  // A 12-TET E-3 (which PT plays 18 units flat) must land on PT's own E-3.
  const song = songOf([ANCHOR_NOTE + 0x1000 + p12.table[4]]);
  const changes = retuneAllPatterns(song, PT, p12, null, "pitch");
  assert.equal(changes.length, 1);
  assert.equal(song.patterns[0][0].note, noteForPeriod(170));
  assert.equal(surveyTuning(song, PT, null).offGrid, 0);
});

test("interval presets are unaffected by the absolute branch", () => {
  // 12-TET: resolve, step and transpose still behave exactly as before.
  const p12 = presetForNotation(120);
  const r = resolveNoteSymbol(ANCHOR_NOTE, p12);
  assert.deepEqual([r.letter + r.acc, r.octave, r.offGrid], ["C-", 4, false]);
  assert.equal(stepNoteInTable(ANCHOR_NOTE, p12, 1), ANCHOR_NOTE + p12.table[1]);
  // Interval presets still WRAP across periods (an absolute table clamps).
  assert.equal(stepNoteInTable(ANCHOR_NOTE + p12.table[11], p12, 1), ANCHOR_NOTE + 0x1000);
  assert.equal(stepNoteInTable(ANCHOR_NOTE, p12, -1), ANCHOR_NOTE - 0x1000 + p12.table[11]);

  const song = songOf([ANCHOR_NOTE]);
  transposePatternNotes(song, 0, p12, null, 0, 1);
  assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + 0x1000);

  // Bohlen-Pierce keeps its tritave period.
  const bp = presetForNotation(35130);
  assert.equal(bp.interval, 0x195c);
  assert.equal(stepNoteInTable(ANCHOR_NOTE + bp.table[12], bp, 1), ANCHOR_NOTE + 0x195c);

  // Raw and every shipped interval preset still declare a non-zero interval —
  // only ProTracker opts into the absolute mode.
  for (const [k, p] of Object.entries(pitchTablePresets)) {
    if (Number(k) === 1) continue;
    assert.ok(p.interval > 0, `preset ${k} (${p.name}) must keep an interval`);
    assert.equal(p.base, undefined, `preset ${k} must not carry a base`);
  }
});

test("OFF_GRID_TOL stays the shared 2 units — no per-preset fudge", () => {
  // The PT table earns its in-tune reading by being exact, not by widening the
  // tolerance the painter and surveyTuning share.
  assert.equal(OFF_GRID_TOL, 2);
  const justOff = noteForPeriod(428) + OFF_GRID_TOL + 1;
  assert.equal(resolveNoteSymbol(justOff, PT).offGrid, true);
  assert.equal(resolveNoteSymbol(noteForPeriod(428) + OFF_GRID_TOL, PT).offGrid, false);
});
