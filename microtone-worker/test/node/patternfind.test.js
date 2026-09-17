// Find (item 177) — the walk, over patternquery.js's predicate.
//
// The predicate itself is pinned by patternquery.test.js; what is pinned here
// is the two ORDERS and the stepping, because those are what make a set of
// matches a thing you can walk: play order across cues and lanes, the
// pattern bank ascending, and a Next/Previous that wraps and never lands on
// where it already is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  songMatches, patternMatches, stepMatch, songCursorCmp, patternCursorCmp, indexAt,
} from "../../src/doc/patternfind.js";
import { compileQuery } from "../../src/doc/patternquery.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { setCellOp, setCueWordOp } from "../../src/doc/ops.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (f) => new Document(parseTaud(readFileSync(corpusDir + f)));

/** A one-term predicate, in the COMPILED shape the walk takes (numbers, not
 *  the dialog's text — compileQuery is what turns one into the other, and it is
 *  exercised on its own below). */
const pred = (field, op, a, b) => [[{ field, op, a, b }]];

// ── the two orders ─────────────────────────────────────────────────────────

test("songMatches walks play order: row, then channel", () => {
  const doc = load("WHEN.taud");
  const hits = songMatches(doc, 0, pred("cell", "has"));
  assert.ok(hits.length > 100, "premise: a real song is mostly non-empty cells");
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1], b = hits[i];
    assert.ok(a.row < b.row || (a.row === b.row && a.ch < b.ch),
      `hit ${i} is after hit ${i - 1}`);
  }
});

test("…and every hit says where it is in BOTH coordinate systems", () => {
  const doc = load("WHEN.taud");
  const song = doc.songs[0];
  const map = song.songMap();
  for (const m of songMatches(doc, 0, pred("cell", "has")).slice(0, 200)) {
    const e = map.entries[m.cue];
    assert.equal(m.row, e.startRow + m.patRow, "absolute row = cue start + pattern row");
    assert.ok(m.patRow < e.rowLimit, "…and inside the cue's own length");
    assert.equal(song.cues[m.cue][m.ch] & 0x7fff, m.pat, "the pattern the cue placed there");
  }
});

test("a note search finds exactly the cells that carry that note", () => {
  const doc = load("WHEN.taud");
  const song = doc.songs[0];
  const target = song.patterns.flatMap((p) => (p ? [p[0].note] : []))
    .find((n) => n >= 0x0020);
  assert.ok(target, "premise: some pattern's first row has a real note");
  assert.ok(patternMatches(doc, 0, pred("note", "eq", target)).length > 0);
  const hits = songMatches(doc, 0, pred("note", "eq", target));
  assert.ok(hits.length > 0);
  for (const m of hits) {
    assert.equal(doc.patternAt(0, m.pat)[m.patRow].note, target);
  }
});

test("one pattern placed in several cues is found in every one of them", () => {
  const doc = load("WHEN.taud");
  const undo = new UndoStack(doc);
  // A note nothing else in the song carries, written once, into a pattern that
  // is then placed on two lanes of two cues.
  undo.apply(setCellOp(0, 0, 3, { note: 0x1234, instrment: 1 }));
  undo.apply(setCueWordOp(0, 0, 5, 0));
  undo.apply(setCueWordOp(0, 1, 6, 0));
  const hits = songMatches(doc, 0, pred("note", "eq", 0x1234));
  const places = hits.map((m) => `${m.cue}/${m.ch}`);
  assert.ok(places.includes("0/5"), "cue 0 channel 5");
  assert.ok(places.includes("1/6"), "cue 1 channel 6");
  for (const m of hits) assert.equal(m.patRow, 3);
});

test("an empty cue slot holds nothing to find", () => {
  const doc = load("WHEN.taud");
  const undo = new UndoStack(doc);
  // A pattern of its own (past the end of the list, so no cue places it yet),
  // put on one lane of one cue and then taken off again.
  const pat = doc.songs[0].patterns.length;
  undo.apply(setCellOp(0, pat, 3, { note: 0x1234, instrment: 1 }));
  undo.apply(setCueWordOp(0, 0, 5, pat));
  assert.deepEqual(songMatches(doc, 0, pred("note", "eq", 0x1234)),
    [{ row: 3, ch: 5, cue: 0, pat, patRow: 3 }]);
  undo.apply(setCueWordOp(0, 0, 5, 0x7fff)); // empty the slot again
  assert.deepEqual(songMatches(doc, 0, pred("note", "eq", 0x1234)), []);
});

test("patternMatches walks the bank, materialised patterns only", () => {
  const doc = load("WHEN.taud");
  const hits = patternMatches(doc, 0, pred("cell", "has"));
  const materialised = new Set(
    doc.songs[0].patterns.flatMap((p, i) => (p ? [i] : [])));
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1], b = hits[i];
    assert.ok(a.pat < b.pat || (a.pat === b.pat && a.row < b.row), "ascending");
  }
  for (const m of hits) assert.ok(materialised.has(m.pat), "never an unmaterialised index");
});

test("the bank walk reaches a pattern no cue plays — the song walk cannot", () => {
  const doc = load("WHEN.taud");
  const undo = new UndoStack(doc);
  const song = doc.songs[0];
  // An arbitrary pattern number past the end of the song's list (item 48): the
  // edit materialises it, no cue places it, and it is findable in the bank and
  // nowhere in the song.
  const orphan = song.patterns.length;
  undo.apply(setCellOp(0, orphan, 7, { note: 0x1234, instrment: 1 }));

  const q = pred("note", "eq", 0x1234);
  assert.deepEqual(patternMatches(doc, 0, q), [{ pat: orphan, row: 7 }]);
  assert.deepEqual(songMatches(doc, 0, q), []);
});

test("the `row` a term tests is the row inside the pattern", () => {
  const doc = load("WHEN.taud");
  const hits = songMatches(doc, 0,
    [[{ field: "row", op: "mod", a: 4, b: 0 }, { field: "cell", op: "has" }]]);
  assert.ok(hits.length > 0);
  for (const m of hits) assert.equal(m.patRow % 4, 0);
});

test("a query typed the way the dialog types it walks the same cells", () => {
  const doc = load("WHEN.taud");
  const undo = new UndoStack(doc);
  undo.apply(setCellOp(0, 0, 3, { note: 0x5400, instrment: 3 }));
  // `$5400` and `C-4`-style names both go through parseFieldValue, and the
  // column's base is HEX — the whole point of compiling before walking.
  const typed = compileQuery({
    predicate: [[{ field: "note", op: "eq", a: "5400" }, { field: "inst", op: "eq", a: "3" }]],
    actions: [],
  });
  assert.deepEqual(typed.predicate, [[
    { field: "note", op: "eq", a: 0x5400 }, { field: "inst", op: "eq", a: 3 },
  ]]);
  const hits = songMatches(doc, 0, typed.predicate);
  assert.ok(hits.length > 0, "found where it was written");
  for (const m of hits) {
    const cell = doc.patternAt(0, m.pat)[m.patRow];
    assert.equal(cell.note, 0x5400);
    assert.equal(cell.instrment, 3);
  }
});

// ── stepping ───────────────────────────────────────────────────────────────

const songList = [
  { row: 4, ch: 0 }, { row: 4, ch: 3 }, { row: 9, ch: 1 }, { row: 20, ch: 2 },
];

test("stepMatch goes to the next match strictly after the cursor", () => {
  assert.equal(stepMatch(songList, songCursorCmp(0, 0), 1), 0);
  assert.equal(stepMatch(songList, songCursorCmp(4, 0), 1), 1, "past the one it is on");
  assert.equal(stepMatch(songList, songCursorCmp(4, 3), 1), 2);
  assert.equal(stepMatch(songList, songCursorCmp(9, 9), 1), 3);
});

test("…and backwards to the last one strictly before it", () => {
  assert.equal(stepMatch(songList, songCursorCmp(20, 2), -1), 2);
  assert.equal(stepMatch(songList, songCursorCmp(4, 3), -1), 0);
  assert.equal(stepMatch(songList, songCursorCmp(9, 1), -1), 1);
});

test("both directions wrap", () => {
  assert.equal(stepMatch(songList, songCursorCmp(20, 2), 1), 0, "past the last: back to the first");
  assert.equal(stepMatch(songList, songCursorCmp(4, 0), -1), 3, "before the first: on to the last");
  assert.equal(stepMatch([], songCursorCmp(0, 0), 1), -1, "nothing to step through");
});

test("a one-match list steps to itself rather than nowhere", () => {
  const one = [{ row: 5, ch: 2 }];
  assert.equal(stepMatch(one, songCursorCmp(5, 2), 1), 0);
  assert.equal(stepMatch(one, songCursorCmp(5, 2), -1), 0);
});

test("patternCursorCmp orders by pattern first", () => {
  const list = [{ pat: 1, row: 60 }, { pat: 2, row: 0 }];
  assert.equal(stepMatch(list, patternCursorCmp(1, 60), 1), 1);
  assert.equal(stepMatch(list, patternCursorCmp(2, 0), -1), 0);
  assert.equal(indexAt(list, patternCursorCmp(2, 0)), 1);
  assert.equal(indexAt(list, patternCursorCmp(2, 1)), -1, "not on a match");
});

// ── the degenerate predicate ───────────────────────────────────────────────

test("a predicate with no usable term compiles away, and finds nothing", () => {
  const doc = load("WHEN.taud");
  // "note is <nothing typed yet>" — compileQuery drops it, and an EMPTY
  // predicate means "every cell" to the evaluator, so the bar must never hand
  // one to the walk. This pins what the walk does with what it is given.
  const compiled = compileQuery({ predicate: [[{ field: "note", op: "eq", a: "" }]], actions: [] });
  assert.deepEqual(compiled.predicate, []);
  assert.ok(songMatches(doc, 0, [[{ field: "note", op: "eq", a: 0xffff }]]).length === 0,
    "a note no cell carries");
});
