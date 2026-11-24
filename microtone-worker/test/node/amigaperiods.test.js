// The Amiga periods notation (item 359): notation index 2 shows a note as the
// period that sounds it, %HHH, and the note column takes the period in hex.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pitchTablePresets, presetForNotation, finePreset, amigaPeriodOf, amigaPeriodExact, noteOfAmigaPeriod,
  onAmigaPeriod, stepNoteInTable, AMIGA_PERIOD_MAX, PT_PERIODS,
} from "../../core/tuning/pitchtables.js";
import { interpretEditKey, rawNoteView, PERIOD_ENTRY, SUB_NOTE, nudgeColumn, COL_NOTE } from "../../src/ui/edit.js";
import { noteCellText } from "../../src/ui/cellpaint.js";
import { TaudPlayData } from "../../core/engine/state.js";

const P = finePreset(pitchTablePresets[2]);

test("every three-digit period is a note that reads back as itself", () => {
  for (let p = 1; p <= AMIGA_PERIOD_MAX; p++) {
    const n = noteOfAmigaPeriod(p);
    assert.ok(n >= 0x20 && n <= 0xffff, `period ${p} → ${n}`);
    assert.equal(n, Math.round(n * 16) / 16, "a 65536-TET note");
    assert.equal(amigaPeriodOf(n), p);
    assert.ok(onAmigaPeriod(n));
    // A whole 4096-TET word (a narrow cell) still reads back as the period.
    assert.equal(amigaPeriodOf(Math.round(n)), p);
  }
  // Period 428 is C4, as the engine's Amiga mode and mod2taud have it.
  assert.equal(noteOfAmigaPeriod(428), 0x5000);
  assert.equal(amigaPeriodOf(0x10), null, "a sentinel has no period");
  assert.equal(amigaPeriodOf(0xffff), null, "above period 1");
});

test("notation 2 is the periods notation, in both forms", () => {
  assert.equal(presetForNotation(2).periods, true);
  assert.equal(P.periods, true);
  assert.equal(rawNoteView(false, P), PERIOD_ENTRY);
  assert.equal(rawNoteView(true, P), true, "the Raw toggle still shows hex words");
  assert.equal(rawNoteView(false, pitchTablePresets[0]), true);
  assert.equal(rawNoteView(false, pitchTablePresets[120]), false);
});

test("the note cell shows %HHH, off-grid between whole periods", () => {
  assert.deepEqual(noteCellText(0x5000, P, false, true), { text: "%1AC", ink: "note" });
  assert.deepEqual(noteCellText(noteOfAmigaPeriod(0xd6), P, false, true), { text: "%0D6", ink: "note" });
  assert.equal(noteCellText(0x5000 + 3, P, false, true).ink, "offGrid");
  // A whole note word rounded from a period (a .mod's) is on it.
  assert.equal(noteCellText(Math.round(noteOfAmigaPeriod(0x7f)), P, false, true).ink, "note");
  // The Raw toggle wins; a sentinel stays a sentinel; out of reach, the word.
  assert.equal(noteCellText(0x5000, P, true, false).text, "5000");
  assert.equal(noteCellText(0x0001, P, false, true).ink, "sentinel");
  assert.equal(noteCellText(0xff00, P, false, false).ink, "dim");
});

test("typing hex shifts digits into the period", () => {
  const ctx = { octave: 4, currentInst: 3, preset: P, rawHex: PERIOD_ENTRY, wideCells: true };
  const cell = new TaudPlayData();
  const type = (key) => {
    const a = interpretEditKey({ code: `Key${key}`, key, repeat: false }, SUB_NOTE, 0, cell, ctx);
    if (a?.fields) Object.assign(cell, a.fields);
    return a;
  };
  // A leading zero on an empty cell writes nothing.
  assert.deepEqual(type("0"), { consumed: true });
  assert.equal(cell.note, 0);
  type("d");
  assert.equal(amigaPeriodOf(cell.note), 0x00d);
  const a = type("6");
  assert.equal(amigaPeriodOf(cell.note), 0x0d6);
  assert.equal(cell.note, noteOfAmigaPeriod(0x0d6));
  assert.equal(a.fields.instrment, undefined, "raw entry stamps no instrument, as Raw does");
  assert.equal(a.advanceRow, undefined);
  // Three more digits replace it whole.
  for (const k of "1ac") type(k);
  assert.equal(cell.note, 0x5000);
  // Not a hex digit: swallowed.
  assert.deepEqual(interpretEditKey({ code: "KeyZ", key: "z" }, SUB_NOTE, 0, cell, ctx), { consumed: true });
});

test("a step is one period, up in pitch is shorter", () => {
  assert.equal(stepNoteInTable(0x5000, P, 1), noteOfAmigaPeriod(427));
  assert.equal(stepNoteInTable(0x5000, P, -1), noteOfAmigaPeriod(429));
  assert.equal(stepNoteInTable(noteOfAmigaPeriod(1), P, 1), noteOfAmigaPeriod(1), "clamps at %001");
  // An off-period note snaps to its nearest period's neighbour.
  const off = 0x5000 + 3;
  assert.equal(Math.round(amigaPeriodExact(off)), 428);
  assert.deepEqual(nudgeColumn(COL_NOTE, { note: 0x5000 }, 1, false, { preset: P }), { note: noteOfAmigaPeriod(427) });
  // ProTracker's table is a set of periods like any other.
  assert.ok(PT_PERIODS.every((p) => onAmigaPeriod(noteOfAmigaPeriod(p))));
});
