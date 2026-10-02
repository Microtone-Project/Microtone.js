// Retune methods (pitchtables.retuneAllPatterns — verbatim port of taut.js
// retuneAllPatterns) — golden vectors + behavioural properties for the four
// mapping methods, plus retuneOp undo/redo byte-exactness on a real corpus
// document. Golden outputs were generated from the port and sanity-checked
// musically (e.g. the harmonic method's held-note JI pull lands the final
// off-grid fifth on the near-4:3 candidate).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { presetForNotation, retuneAllPatterns, retuneNearest, surveyTuning, OFF_GRID_TOL }
  from "../../core/tuning/pitchtables.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { retuneOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const p12 = presetForNotation(120);
const p19 = presetForNotation(190);

const cell = (note, inst = 0) => ({ note, instrment: inst });
const N12 = (semi, oct = 0) => 0x5000 + oct * 0x1000 + p12.table[semi];

/** C4 E4 G4 C5 B4 G4 on the exact 12-TET grid; final G held via key-offs. */
function diatonicMelody() {
  const rows = new Array(16).fill(null).map(() => cell(0));
  const seq = [[0, N12(0)], [2, N12(4)], [4, N12(7)], [6, N12(0, 1)], [8, N12(11)], [10, N12(7)]];
  for (const [r, n] of seq) rows[r] = cell(n, 1);
  rows[11] = cell(0x0001); rows[12] = cell(0x0001); rows[13] = cell(0x0001);
  return { patterns: [rows] };
}

/** Same shape but OFF the 12-TET grid (0x100-steps) — methods diverge here. */
function offGridMelody(hold = true) {
  const rows = new Array(16).fill(null).map(() => cell(0));
  const seq = [[0, 0x5000], [2, 0x5400], [4, 0x5700], [6, 0x6000], [8, 0x5b00], [10, 0x5700]];
  for (const [r, n] of seq) rows[r] = cell(n, 1);
  if (hold) { rows[11] = cell(0x0001); rows[12] = cell(0x0001); rows[13] = cell(0x0001); }
  return { patterns: [rows] };
}

const mappedNotes = (song) => song.patterns[0].filter((c) => c.note >= 0x20).map((c) => c.note);

test("on-grid diatonic 12→19-TET: every method lands the canonical degrees", () => {
  // 19-TET approximates the diatonic intervals well, so nearest/delta/
  // cadence/harmonic all agree: degrees 0, 6, 11, 0(+oct), 17, 11.
  const want = [0x5000, 0x550d, 0x5943, 0x6000, 0x5e51, 0x5943];
  for (const method of ["pitch", "delta", "cadence", "harmonic"]) {
    const song = diatonicMelody();
    retuneAllPatterns(song, p19, p12, null, method);
    assert.deepEqual(mappedNotes(song), want, method);
  }
});

test("same-table retune is the identity for on-grid notes (all methods)", () => {
  for (const method of ["pitch", "delta", "cadence", "harmonic"]) {
    const song = diatonicMelody();
    const changes = retuneAllPatterns(song, p12, p12, null, method);
    assert.equal(changes.length, 0, method);
  }
});

test("off-grid melody 12→19-TET: method-specific golden vectors", () => {
  const want = {
    pitch:    [0x5000, 0x5436, 0x56bd, 0x6000, 0x5af3, 0x56bd],
    delta:    [0x5000, 0x5436, 0x5794, 0x60d8, 0x5bca, 0x5794],
    cadence:  [0x5000, 0x5436, 0x5794, 0x6000, 0x5af3, 0x56bd],
    harmonic: [0x5000, 0x5436, 0x5794, 0x60d8, 0x5bca, 0x56bd],
  };
  for (const [method, expect] of Object.entries(want)) {
    const song = offGridMelody(true);
    retuneAllPatterns(song, p19, p12, null, method);
    assert.deepEqual(mappedNotes(song), expect, method);
  }
});

test("harmonic λ: the held-note JI pull vanishes when the hold is removed", () => {
  const held = offGridMelody(true);
  retuneAllPatterns(held, p19, p12, null, "harmonic");
  const short = offGridMelody(false);
  retuneAllPatterns(short, p19, p12, null, "harmonic");
  const heldNotes = mappedNotes(held);
  const shortNotes = mappedNotes(short);
  assert.equal(heldNotes.at(-1), 0x56bd, "held final note pulls onto the near-4:3 JI candidate");
  assert.equal(shortNotes.at(-1), 0x5794, "unheld final note stays nearest-delta");
  assert.deepEqual(heldNotes.slice(0, -1), shortNotes.slice(0, -1), "earlier notes unaffected");
});

test("sentinels, interrupts, and percussion notes are untouched", () => {
  const rows = new Array(8).fill(null).map(() => cell(0));
  rows[0] = cell(0x0001);       // key-off
  rows[1] = cell(0x0002);       // cut
  rows[2] = cell(0x0015);       // interrupt Int5
  rows[3] = cell(0x5400, 9);    // percussion inst 9 — explicit
  rows[4] = cell(0x5700);       // percussion via running instrument 9
  rows[5] = cell(0x5400, 1);    // melodic
  const song = { patterns: [rows] };
  const percSlots = new Uint8Array(1024);
  percSlots[9] = 1;
  const changes = retuneAllPatterns(song, p19, p12, percSlots, "pitch");
  assert.equal(rows[0].note, 0x0001);
  assert.equal(rows[1].note, 0x0002);
  assert.equal(rows[2].note, 0x0015);
  assert.equal(rows[3].note, 0x5400, "explicit percussion note untouched");
  assert.equal(rows[4].note, 0x5700, "running-instrument percussion note untouched");
  assert.equal(rows[5].note, 0x5436, "melodic note remapped");
  assert.equal(changes.length, 1);
});

// ── item 73: out-of-tune detection ──

test("surveyTuning: an on-grid song has nothing to retune", () => {
  const s = surveyTuning(diatonicMelody(), p12, null);
  assert.equal(s.total, 6);
  assert.equal(s.offGrid, 0);
  assert.equal(s.wouldChange, 0, "a same-table nearest-pitch pass would rewrite nothing");
});

test("surveyTuning: an out-of-tune song reports the notes a cleanup would snap", () => {
  const s = surveyTuning(offGridMelody(), p12, null);
  assert.equal(s.total, 6);
  assert.ok(s.offGrid > 0, "off-grid notes are seen");
  // wouldChange is what the same-table cleanup actually rewrites — the number
  // the old same-index guard silently threw away.
  const song = offGridMelody();
  const changes = retuneAllPatterns(song, p12, p12, null, "pitch");
  assert.equal(s.wouldChange, changes.length, "wouldChange predicts the cleanup exactly");
  assert.ok(s.wouldChange > 0, "the cleanup is NOT a no-op on an out-of-tune song");
});

test("surveyTuning: offGrid follows the display tolerance, wouldChange is exact", () => {
  // A note OFF_GRID_TOL units sharp still reads as in tune (no yellow), but is
  // not exactly on a degree — so it is not off-grid, yet a cleanup would move it.
  const near = { patterns: [[cell(0x5000 + OFF_GRID_TOL, 1)]] };
  const sNear = surveyTuning(near, p12, null);
  assert.equal(sNear.offGrid, 0, "within tolerance: reads as in tune");
  assert.equal(sNear.wouldChange, 1, "…but a cleanup still snaps it exactly onto the degree");
  const far = { patterns: [[cell(0x5000 + OFF_GRID_TOL + 1, 1)]] };
  assert.equal(surveyTuning(far, p12, null).offGrid, 1, "past tolerance: out of tune");
});

test("surveyTuning: skips sentinels and percussion like the retune does", () => {
  const perc = new Uint8Array(1024);
  perc[9] = 1;
  const song = { patterns: [[cell(0x0001), cell(0x0004), cell(0x5011, 9), cell(0x5011, 1)]] };
  const s = surveyTuning(song, p12, perc);
  assert.equal(s.total, 1, "only the one pitched non-percussion note counts");
  assert.equal(s.offGrid, 1);
});

test("surveyTuning: Raw preset has no grid to be off", () => {
  const raw = { index: 0, name: "Raw", table: [], interval: 0x1000 };
  assert.deepEqual(surveyTuning(offGridMelody(), raw, null), { total: 0, offGrid: 0, wouldChange: 0 });
});

test("retune and survey tolerate null pattern gaps (item 48 sparsity)", () => {
  // Editing an arbitrary high pattern number pads song.patterns with nulls;
  // retuneAllPatterns used to throw a TypeError on the first gap.
  const song = offGridMelody();
  song.patterns = [null, song.patterns[0], null];
  assert.doesNotThrow(() => retuneAllPatterns(song, p19, p12, null, "pitch"));
  const s = surveyTuning(offGridMelody(), p12, null);
  const gapped = offGridMelody();
  gapped.patterns = [null, gapped.patterns[0], null];
  assert.deepEqual(surveyTuning(gapped, p12, null), s, "gaps contribute nothing");
});

test("surveyTuning on a real document: a converted .mod-style detune is flagged", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const clean = surveyTuning(doc.songs[0], p12, null);
  assert.equal(clean.offGrid, 0, "WHEN is written exactly on the 12-TET grid");
  assert.equal(clean.wouldChange, 0);
  // Detune every note a few units, as an Amiga period table would.
  for (const ptn of doc.songs[0].patterns) {
    if (!ptn) continue;
    for (const c of ptn) if (c.note >= 0x20) c.note += 11;
  }
  const dirty = surveyTuning(doc.songs[0], p12, null);
  assert.equal(dirty.total, clean.total);
  assert.equal(dirty.offGrid, dirty.total, "every note now reads out of tune");
  assert.equal(dirty.wouldChange, dirty.total);
});

test("retuneNearest wrapper matches method 'pitch'", () => {
  const a = offGridMelody(true);
  retuneNearest(a, p19, null);
  const b = offGridMelody(true);
  retuneAllPatterns(b, p19, p12, null, "pitch");
  assert.deepEqual(mappedNotes(a), mappedNotes(b));
});

test("retuneOp on a real document: undo/redo byte-exact", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const cur = presetForNotation(doc.meta.songMeta[0]?.notation ?? 120);
  undo.apply(retuneOp(0, p19, null, (song, np, ps) => retuneAllPatterns(song, np, cur, ps, "delta")));
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before), "retune changed the document");
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});
