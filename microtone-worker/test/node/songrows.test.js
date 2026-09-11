// Row-level song surgery (item 136.2) — the Timeline trough's insert/delete
// rows, the empty-cue insert beside them, and the cue split (item 185).
//
// Two properties carry the insert/delete half. The first is LINEAR: the song read top
// to bottom must come out as the original with those rows spliced out (or blanks
// spliced in), whatever the cue lengths were and however the patterns underneath
// were shared. The second is that the CUE GRID stays put: a row is a row of the
// song, so the music slides up or down THROUGH the cues rather than the cue
// boundaries moving with it — which is what forces every pattern below the edit
// to be rebuilt, and what most of these tests are about.
//
// The split and the cut invert the first property: they move a cue BOUNDARY and
// no music at all, so what they must prove is that the linear reading comes out
// IDENTICAL — same rows, same order, same length — with the cue grid the only
// thing that changed underneath it. They differ in how far that change reaches:
// the split stops at the cue it cut, the cut re-bars everything below it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  planDeleteRows, planInsertRows, planInsertCue, planSplitCue, planCutCue,
  splitPointAt, PATTERN_ROWS,
} from "../../src/doc/songrows.js";
import { remapPatternsOp } from "../../src/doc/ops.js";
import { Document, cueInfo } from "../../src/doc/document.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { UndoStack } from "../../src/doc/undo.js";
import { CUE_EMPTY, MAX_VOICES } from "../../src/format/taud-const.js";
import { emptyPatternBytes } from "../../src/doc/patterntools.js";
import { INST_JUMP, INST_GOBACK } from "../../src/engine/state.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (name) => new Document(parseTaud(readFileSync(corpusDir + name)));

/** One cell as a comparable string. */
function cellKey(cell, wide) {
  if (!cell) return "";
  let s = "";
  for (let b = 0; b < (wide ? 16 : 8); b++) {
    s += (wide ? cell.getByteWide(b) : cell.getByte(b)).toString(16).padStart(2, "0");
  }
  return s;
}

/** The key an EMPTY cell has — the FINE-with-0 sentinel in both columns, not
 *  all-zero bytes (patterntools.js). */
function emptyKey(wide) {
  const bytes = emptyPatternBytes(wide);
  let s = "";
  for (let b = 0; b < (wide ? 16 : 8); b++) s += bytes[b].toString(16).padStart(2, "0");
  return s;
}

/**
 * The song as it SOUNDS, read top to bottom: one string per absolute row holding
 * every channel's cell, with silence written as ".". A channel with no pattern
 * and a channel whose pattern is blank on that row are both silence, and an
 * insert makes one kind or the other depending on where it landed — so
 * distinguishing them here would compare the structure instead of the music,
 * which is the thing these edits are allowed to change.
 */
function linear(song, wide = false) {
  const empty = emptyKey(wide);
  const out = [];
  for (const e of song.songMap().entries) {
    for (let r = 0; r < e.rowLimit; r++) {
      const row = [];
      for (let ch = 0; ch < MAX_VOICES; ch++) {
        const p = song.cues[e.cue][ch] & 0x7fff;
        const key = p === CUE_EMPTY ? empty : (cellKey(song.patterns[p]?.[r], wide) || empty);
        row.push(key === empty ? "." : key);
      }
      out.push(row.join("|"));
    }
  }
  return out;
}

/** Every cue's playable length, in order — the grid the music slides through. */
const limits = (song) => song.songMap().entries.map((e) => e.rowLimit);
/** Materialised pattern count, the thing a naive rebuild would explode. */
const patCount = (song) => song.patterns.filter(Boolean).length;

/** Apply a plan to `doc` (no undo stack — the op is enough for the maths). */
function applyPlan(doc, plan) {
  assert.ok(plan, "the planner refused");
  remapPatternsOp(0, plan.patterns, plan.cues, null).apply(doc);
  return doc.songs[0];
}

/** A row of silence, however it is spelled underneath. */
const blankRow = () => new Array(MAX_VOICES).fill(".").join("|");

// ── delete: the linear result ──

test("delete inside one cue: everything below moves up", () => {
  const doc = load("town.taud");
  const before = linear(doc.songs[0]);
  const song = applyPlan(doc, planDeleteRows(doc.songs[0], 10, 13,
    { patternNames: doc._nameTable("pNam") }));
  const want = before.slice();
  want.splice(10, 4);
  assert.deepEqual(linear(song), want);
});

test("delete spanning a cue boundary", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const cut = song0.songMap().entries[1].startRow; // last 3 of cue 0 + first 3 of cue 1
  const before = linear(song0);
  const song = applyPlan(doc, planDeleteRows(song0, cut - 3, cut + 2, {}));
  const want = before.slice();
  want.splice(cut - 3, 6);
  assert.deepEqual(linear(song), want);
});

test("delete every row leaves one empty cue rather than no song", () => {
  const doc = load("town.taud");
  const song = applyPlan(doc, planDeleteRows(doc.songs[0], 0, 1e6, {}));
  assert.equal(song.cues.length, 1);
  assert.equal(song.songMap().totalRows, PATTERN_ROWS);
  assert.deepEqual(linear(song), new Array(PATTERN_ROWS).fill(blankRow()));
});

// ── delete: the music moves through the cue grid ──

test("the cue grid stays put — only the song's LAST cue loses the rows", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const was = limits(song0);
  const song = applyPlan(doc, planDeleteRows(song0, 100, 103, {}));
  const now = limits(song);
  assert.deepEqual(now.slice(0, -1), was.slice(0, -1), "every cue keeps its length");
  assert.equal(now[now.length - 1], was[was.length - 1] - 4, "the song ends four rows earlier");
});

test("music from the cue BELOW moves up into the edited one", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[1];
  const before = linear(song0);
  // The four rows at the top of cue 2 are what cue 1 should end with afterwards.
  const pulled = before.slice(e.startRow + e.rowLimit, e.startRow + e.rowLimit + 4);
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow, e.startRow + 3, {}));
  const after = linear(song);
  assert.deepEqual(after.slice(e.startRow + e.rowLimit - 4, e.startRow + e.rowLimit), pulled,
    "cue 1 now ends with what cue 2 began with");
  assert.equal(limits(song)[1], e.rowLimit, "…and cue 1 is still the same length");
});

test("a delete at the very end is a length edit and nothing else", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const total = song0.songMap().totalRows;
  const pats = patCount(song0);
  const cues = song0.cues.map((w) => Uint16Array.from(w));
  const song = applyPlan(doc, planDeleteRows(song0, total - 4, total - 1, {}));
  assert.equal(song.songMap().totalRows, total - 4);
  assert.equal(patCount(song), pats, "no pattern was rebuilt");
  // Only the last cue's words differ, and only in its instruction bits.
  song.cues.forEach((w, c) => {
    const same = c !== limits(song).length - 1;
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      assert.equal(w[ch] & 0x7fff, cues[c][ch] & 0x7fff, `cue ${c} ch ${ch} pattern`);
      if (same) assert.equal(w[ch], cues[c][ch], `cue ${c} ch ${ch} word`);
    }
  });
});

// ── the cheap alignments ──

test("deleting whole cues splices them out, touching no pattern", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  const a = map.entries[2], b = map.entries[3];
  const before = linear(song0);
  const pats = song0.patterns.map((p) => (p ? p.map((c) => cellKey(c)).join() : null));
  const song = applyPlan(doc, planDeleteRows(song0, a.startRow, b.startRow + b.rowLimit - 1, {}));
  const want = before.slice();
  want.splice(a.startRow, a.rowLimit + b.rowLimit);
  assert.deepEqual(linear(song), want);
  assert.equal(song.cues.length, before.length && song0.cues.length, "cue list is two shorter");
  assert.deepEqual(song.patterns.map((p) => (p ? p.map((c) => cellKey(c)).join() : null)),
    pats.slice(0, song.patterns.length), "every pattern is byte-identical");
  assert.deepEqual(limits(song), [...limits(song).slice(0, 2), ...limits(song).slice(2)]);
});

test("inserting AT a cue boundary is a blank cue, touching no pattern", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const at = song0.songMap().entries[2].startRow;
  const before = linear(song0);
  const pats = patCount(song0);
  const song = applyPlan(doc, planInsertRows(song0, at, 8, {}));
  const want = before.slice();
  want.splice(at, 0, ...new Array(8).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.equal(patCount(song), pats, "no pattern was rebuilt");
  assert.equal(limits(song)[2], 8, "the blank cue holds the eight rows");
});

test("insert past the last row appends blank cues", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const total = song0.songMap().totalRows;
  const before = linear(song0);
  const song = applyPlan(doc, planInsertRows(song0, total, 100, {}));
  assert.deepEqual(linear(song), [...before, ...new Array(100).fill(blankRow())]);
  assert.deepEqual(limits(song).slice(-2), [64, 36], "spilled into two cues");
});

// ── insert inside a cue: the shift ──

test("insert inside a cue pushes the whole song down through the grid", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const was = limits(song0);
  const before = linear(song0);
  const at = song0.songMap().entries[1].startRow + 10;
  const song = applyPlan(doc, planInsertRows(song0, at, 6, {}));
  const want = before.slice();
  want.splice(at, 0, ...new Array(6).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  const now = limits(song);
  assert.deepEqual(now.slice(0, -1), was.slice(0, -1), "every cue above it keeps its length");
  // The six rows pushed off the bottom land in the last cue, which had room for
  // them (32 of its 64); a full one would have spilled into a new cue instead.
  assert.equal(now.length, was.length);
  assert.equal(now[now.length - 1], was[was.length - 1] + 6);
});

test("…and spills into a new cue when the last one is already full", () => {
  const doc = load("WHEN.taud"); // every cue is a full 64 rows
  const song0 = doc.songs[0];
  const was = limits(song0);
  assert.equal(was[was.length - 1], PATTERN_ROWS, "fixture: the last cue is full");
  const before = linear(song0);
  const song = applyPlan(doc, planInsertRows(song0, 70, 5, {}));
  const want = before.slice();
  want.splice(70, 0, ...new Array(5).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.deepEqual(limits(song), [...was, 5]);
});

test("insert then delete the same rows returns the song to where it started", () => {
  const doc = load("town.taud");
  const before = linear(doc.songs[0]);
  const grown = applyPlan(doc, planInsertRows(doc.songs[0], 100, 6, {}));
  const shrunk = applyPlan(doc, planDeleteRows(grown, 100, 105, {}));
  assert.deepEqual(linear(shrunk), before);
});

// ── what happens to the patterns ──

test("patterns ABOVE the cut are untouched, sharing and all", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  const cut = map.entries[10].startRow + 3;
  // Every pattern only cues 0..9 play must come out byte-identical.
  const above = new Set();
  const below = new Set();
  song0.cues.forEach((w, c) => {
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      const p = w[ch] & 0x7fff;
      if (p !== CUE_EMPTY) (c < 10 ? above : below).add(p);
    }
  });
  const kept = [...above].filter((p) => !below.has(p) && song0.patterns[p]);
  assert.ok(kept.length > 0, "fixture: some patterns are played only above the cut");
  const was = new Map(kept.map((p) => [p, song0.patterns[p].map((c) => cellKey(c)).join()]));
  const cues = song0.cues.slice(0, 10).map((w) => Uint16Array.from(w));

  const song = applyPlan(doc, planDeleteRows(song0, cut, cut + 1, {}));
  for (const [p, key] of was) {
    assert.equal(song.patterns[p].map((c) => cellKey(c)).join(), key, `pattern ${p}`);
  }
  song.cues.slice(0, 10).forEach((w, c) => assert.deepEqual(w, cues[c], `cue ${c}`));
});

test("a pattern an untouched cue still plays is never written over", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  // Pattern 14 is played all over this song, above the cut as well as below.
  const users = [];
  song0.cues.forEach((w, c) => {
    for (let ch = 0; ch < MAX_VOICES; ch++) if ((w[ch] & 0x7fff) === 14) users.push([c, ch]);
  });
  assert.ok(users.some(([c]) => c < 5) && users.some(([c]) => c > 15),
    "fixture: pattern 14 plays both sides of the cut");
  const was = song0.patterns[14].map((c) => cellKey(c));
  const cut = song0.songMap().entries[12].startRow + 5;
  const song = applyPlan(doc, planDeleteRows(song0, cut, cut, {}));
  assert.deepEqual(song.patterns[14].map((c) => cellKey(c)), was,
    "the cues above the cut still play it exactly as it was");
});

test("the rebuild recycles numbers instead of one pattern per slot", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  const before = patCount(song0);
  // A cut near the TOP is the worst case: every cue below it is rebuilt.
  const song = applyPlan(doc, planDeleteRows(song0, map.entries[1].startRow + 4,
    map.entries[1].startRow + 7, {}));
  const slots = song0.cues.reduce((n, w) => n +
    [...w].filter((x) => (x & 0x7fff) !== CUE_EMPTY).length, 0);
  // The naive rebuild is one fresh pattern per rebuilt slot. Recycling the
  // numbers the rebuilt cues just freed keeps the real cost a fraction of that:
  // what is left over is the slots that had nothing to recycle, i.e. a channel
  // silent in one cue and playing in the next one it now borrows rows from.
  assert.ok(patCount(song) < before + slots / 4,
    `pattern count stayed close (${before} → ${patCount(song)}, ${slots} slots rebuilt)`);
});

test("channels drawing the same rows out of the same patterns share one copy", () => {
  const doc = load("Onestop.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  // A rebuilt cue borrows rows from the cue BELOW it, so what decides whether
  // two channels can go on sharing is whether they match in BOTH — matching in
  // the edited cue alone is not enough, and two channels that diverge below it
  // have to diverge here too, because their music now differs.
  const pairs = [];
  let matched = 0;
  for (let a = 0; a < MAX_VOICES; a++) {
    for (let b = a + 1; b < MAX_VOICES; b++) {
      const here = (song0.cues[e.cue][a] & 0x7fff) === (song0.cues[e.cue][b] & 0x7fff);
      const next = (song0.cues[e.cue + 1][a] & 0x7fff) === (song0.cues[e.cue + 1][b] & 0x7fff);
      if (here && next) { pairs.push([a, b]); matched++; }
    }
  }
  assert.ok(matched > 0, "fixture: some channels match across both cues");
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow + 2, e.startRow + 3, {}));
  for (const [a, b] of pairs) {
    assert.equal(song.cues[e.cue][a] & 0x7fff, song.cues[e.cue][b] & 0x7fff,
      `channels ${a}/${b} kept their sharing`);
  }
});

test("a channel with nothing anywhere in the rebuilt span stays empty", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const empty = [];
  for (let ch = 0; ch < MAX_VOICES; ch++) {
    if (song0.cues.every((w) => (w[ch] & 0x7fff) === CUE_EMPTY)) empty.push(ch);
  }
  assert.ok(empty.length > 0, "fixture: the song does not use every channel");
  const song = applyPlan(doc, planDeleteRows(song0, 80, 83, {}));
  for (const ch of empty) {
    for (const w of song.cues) {
      assert.equal(w[ch] & 0x7fff, CUE_EMPTY, `channel ${ch} was given a pattern`);
    }
  }
});

// ── empty cue insert (the structural alternative) ──

test("planInsertCue adds a blank cue as long as the one it sits beside", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  const before = linear(song0);
  const pats = patCount(song0);
  const song = applyPlan(doc, planInsertCue(song0, e.startRow + 5, true, {}));
  const want = before.slice();
  want.splice(e.startRow, 0, ...new Array(e.rowLimit).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.equal(limits(song)[3], e.rowLimit, "…the same length as the cue it went above");
  assert.equal(patCount(song), pats, "no pattern was touched");
});

test("planInsertCue below puts it after that cue", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[0]; // the 16-row cue
  const before = linear(song0);
  const song = applyPlan(doc, planInsertCue(song0, e.startRow, false, {}));
  const want = before.slice();
  want.splice(e.startRow + e.rowLimit, 0, ...new Array(e.rowLimit).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.deepEqual(limits(song).slice(0, 3), [16, 16, 64]);
});

// ── split a cue in two (item 185) ──
// The split is the one edit here that moves a cue BOUNDARY instead of the music,
// so its first property is the opposite of every test above: the linear reading
// must come out IDENTICAL, and the song must be exactly as long as it was.

test("a split reads back as exactly the same song", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const before = linear(song0);
  const e = song0.songMap().entries[1];
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 20, {}));
  assert.deepEqual(linear(song), before, "every row is where it was");
  assert.equal(song.songMap().totalRows, before.length, "the song is the same length");
});

test("…and splits the cue into the two halves the click asked for", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const was = limits(song0);
  const e = song0.songMap().entries[1];
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 20, {}));
  assert.deepEqual(limits(song),
    [...was.slice(0, 1), 20, e.rowLimit - 20, ...was.slice(2)]);
});

test("the head keeps the cue's own patterns, word for word", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  const words = Uint16Array.from(song0.cues[e.cue]);
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 8, {}));
  for (let ch = 0; ch < MAX_VOICES; ch++) {
    assert.equal(song.cues[e.cue][ch] & 0x7fff, words[ch] & 0x7fff, `ch ${ch}`);
  }
});

test("the tail's music starts at the top of its new patterns", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[2];
  const at = 12;
  const src = [];
  for (let ch = 0; ch < MAX_VOICES; ch++) {
    const p = song0.cues[e.cue][ch] & 0x7fff;
    src.push(p === CUE_EMPTY ? null : song0.patterns[p]?.[at] ?? null);
  }
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + at, {}));
  for (let ch = 0; ch < MAX_VOICES; ch++) {
    const p = song.cues[e.cue + 1][ch] & 0x7fff;
    // A channel the cue had nothing on gets nothing — the tail is not padded out.
    if (p === CUE_EMPTY) { assert.equal(src[ch], null, `ch ${ch} had nothing to carry`); continue; }
    assert.equal(cellKey(song.patterns[p][0]), cellKey(src[ch]),
      `ch ${ch}: row ${at} of the cue is now row 0 of its pattern`);
  }
});

test("a pattern another cue still plays whole is never written over", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  // Pattern 14 plays all over this song — the cue being split is only one user.
  const e = song0.songMap().entries.find(
    (x) => [...song0.cues[x.cue]].some((w) => (w & 0x7fff) === 14));
  assert.ok(e, "fixture: some cue plays pattern 14");
  const was = song0.patterns[14].map((c) => cellKey(c));
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 16, {}));
  assert.deepEqual(song.patterns[14].map((c) => cellKey(c)), was);
});

test("channels sharing a pattern go on sharing one copy in the tail", () => {
  const doc = load("Onestop.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  const pairs = [];
  for (let a = 0; a < MAX_VOICES; a++) {
    for (let b = a + 1; b < MAX_VOICES; b++) {
      const p = song0.cues[e.cue][a] & 0x7fff;
      if (p !== CUE_EMPTY && p === (song0.cues[e.cue][b] & 0x7fff)) pairs.push([a, b]);
    }
  }
  assert.ok(pairs.length > 0, "fixture: two channels of this cue share a pattern");
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 9, {}));
  for (const [a, b] of pairs) {
    assert.equal(song.cues[e.cue + 1][a] & 0x7fff, song.cues[e.cue + 1][b] & 0x7fff,
      `channels ${a}/${b} kept their sharing`);
  }
});

test("splitting AT a cue boundary is nothing to do", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  for (const e of map.entries) {
    assert.equal(splitPointAt(song0, e.startRow), null, `cue ${e.cue} starts here`);
    assert.equal(planSplitCue(song0, e.startRow, {}), null);
  }
  assert.equal(planSplitCue(song0, map.totalRows, {}), null, "past the end: nothing");
  assert.equal(splitPointAt(song0, map.entries[1].startRow + 1).local, 1, "…but one row in, it is");
});

test("the head is left with its length and nothing else", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[4];
  // A cue that HALTS and jumps: both belong to the half that now ends it.
  for (let ch = 0; ch < 16; ch++) {
    const w0 = 0x0100; // plain HALT
    song0.cues[e.cue][ch] = (song0.cues[e.cue][ch] & 0x7fff) | (((w0 >> ch) & 1) << 15);
    const w1 = 0xf000 | 2; // JMP 2
    song0.cues[e.cue][16 + ch] = (song0.cues[e.cue][16 + ch] & 0x7fff) | (((w1 >> ch) & 1) << 15);
  }
  assert.equal(cueInfo(song0.cues[e.cue]).isHalt, true);
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 24, {}));
  const head = cueInfo(song.cues[e.cue]);
  const taild = cueInfo(song.cues[e.cue + 1]);
  assert.equal(head.rowLimit, 24, "the head says how long it is");
  assert.equal(head.isHalt, false, "…and does not halt part-way through the music");
  assert.equal(head.flow, null, "…nor jump away from it");
  assert.equal(taild.rowLimit, e.rowLimit - 24, "the tail holds the rest");
  assert.equal(taild.isHalt, true, "the halt moved to where the cue now ends");
  assert.equal(taild.flow.type, INST_JUMP, "…and so did the jump");
  assert.equal(taild.flow.arg, 2, "which still aims at the same music");
});

test("a jump aimed at the split cue still lands on its top", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const jmp = 0xf000 | 6; // JMP 6, on cue 9
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][16 + ch] = (song0.cues[9][16 + ch] & 0x7fff) | (((jmp >> ch) & 1) << 15);
  }
  const e = song0.songMap().entries[6];
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 30, {}));
  const flow = cueInfo(song.cues[10]).flow; // cue 9 moved one along
  assert.equal(flow.type, INST_JUMP);
  assert.equal(flow.arg, 6, "cue 6 is still the head of the cue it was aimed at");
});

test("a relative jump is re-measured across the new boundary", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const back = 0x8000 | 4; // BAK 4 on cue 9 → cue 5
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][ch] = (song0.cues[9][ch] & 0x7fff) | (((back >> ch) & 1) << 15);
  }
  const e = song0.songMap().entries[7];
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 5, {}));
  const flow = cueInfo(song.cues[10]).flow;
  assert.equal(flow.type, INST_GOBACK);
  assert.equal(flow.arg, 5, "one more cue now sits between it and its target");
});

test("a split costs one pattern per voice the tail actually plays", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[2];
  const voices = new Set();
  for (let ch = 0; ch < MAX_VOICES; ch++) {
    const p = song0.cues[e.cue][ch] & 0x7fff;
    if (p !== CUE_EMPTY) voices.add(p);
  }
  const before = patCount(song0);
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 6, {}));
  assert.equal(patCount(song), before + voices.size,
    "the head keeps its own, the tail gets one per distinct pattern under it");
});

test("splitting twice in the same cue reads the same song three cues long", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const before = linear(song0);
  const was = limits(song0);
  const e = song0.songMap().entries[5];
  let song = applyPlan(doc, planSplitCue(song0, e.startRow + 48, {}));
  song = applyPlan(doc, planSplitCue(song, e.startRow + 16, {}));
  assert.deepEqual(linear(song), before);
  assert.deepEqual(limits(song).slice(5, 8), [16, 32, e.rowLimit - 48]);
  assert.equal(limits(song).length, was.length + 2);
});

test("the wide cell (format v3) survives a split", () => {
  const doc = load("town.taud");
  doc.upgradeToWideCells();
  const song0 = doc.songs[0];
  const before = linear(song0, true);
  const e = song0.songMap().entries[2];
  const song = applyPlan(doc, planSplitCue(song0, e.startRow + 7, { wide: true }));
  assert.deepEqual(linear(song, true), before);
});

test("split then undo restores the document byte-for-byte", () => {
  const doc = load("town.taud");
  const bytes = doc.toBytes();
  const undo = new UndoStack(doc);
  const e = doc.songs[0].songMap().entries[2];
  const plan = planSplitCue(doc.songs[0], e.startRow + 11,
    { patternNames: doc._nameTable("pNam") });
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, null));
  assert.notDeepEqual(doc.toBytes(), bytes);
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytes);
});

// ── cut a cue and re-bar the song below it (item 185.1) ──
// Same boundary as the split, same untouched music — but the cue below takes the
// cut cue's FULL length and the grid under it keeps its own, so the song slides
// up through it and every pattern from the cut down is rebuilt.

test("a cut reads back as exactly the same song", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const before = linear(song0);
  const e = song0.songMap().entries[1];
  const song = applyPlan(doc, planCutCue(song0, e.startRow + 20, {}));
  assert.deepEqual(linear(song), before, "every row is where it was");
  assert.equal(song.songMap().totalRows, before.length, "nothing was lost");
});

test("…and the cue below the cut gets the cut cue's FULL length", () => {
  const doc = load("WHEN.taud"); // every cue is a full 64
  const song0 = doc.songs[0];
  const was = limits(song0);
  const song = applyPlan(doc, planCutCue(song0, 32, {}));
  // The user's own example: cue $0 cut at row $20 leaves $20 then a full $40.
  assert.deepEqual(limits(song).slice(0, 3), [32, PATTERN_ROWS, PATTERN_ROWS]);
  assert.deepEqual(limits(song).slice(1, -1), was.slice(1),
    "…and every cue under it keeps the length it had");
  assert.equal(limits(song).pop(), PATTERN_ROWS - 32,
    "the song's last cue absorbs what the head kept");
  assert.equal(limits(song).length, was.length + 1);
});

test("a split leaves the grid below alone where a cut re-bars it", () => {
  const doc = load("WHEN.taud");
  const e = doc.songs[0].songMap().entries[0];
  const split = applyPlan(load("WHEN.taud"), planSplitCue(
    load("WHEN.taud").songs[0], e.startRow + 32, {}));
  const cut = applyPlan(doc, planCutCue(doc.songs[0], e.startRow + 32, {}));
  assert.deepEqual(limits(split).slice(0, 3), [32, 32, PATTERN_ROWS]);
  assert.deepEqual(limits(cut).slice(0, 3), [32, PATTERN_ROWS, PATTERN_ROWS]);
  assert.equal(limits(split).length, limits(cut).length,
    "both add exactly one cue — they differ in where the short one ends up");
});

test("the music below the cut moves up through the grid", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[2];
  const local = 12;
  const before = linear(song0);
  const song = applyPlan(doc, planCutCue(song0, e.startRow + local, {}));
  // The cue after the cut now BEGINS with what was `local` rows into the cut one
  // and RUNS ON past the old boundary into the next cue's opening rows.
  const map = song.songMap();
  const made = map.entries[3];
  assert.equal(made.startRow, e.startRow + local, "it starts at the cut");
  assert.equal(made.rowLimit, e.rowLimit, "…and is as long as the cue it came out of");
  assert.deepEqual(linear(song).slice(made.startRow, made.startRow + made.rowLimit),
    before.slice(e.startRow + local, e.startRow + local + e.rowLimit));
});

test("the cut cue and everything above it keep their own patterns", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  const words = song0.cues.map((w) => Uint16Array.from(w));
  const pats = patCount(song0);
  const song = applyPlan(doc, planCutCue(song0, e.startRow + 8, {}));
  for (let c = 0; c <= e.cue; c++) {
    assert.deepEqual([...song.cues[c]].map((w) => w & 0x7fff),
      [...words[c]].map((w) => w & 0x7fff), `cue ${c} still plays its own patterns`);
  }
  // …which is exactly why the cues below have to be given copies: the music they
  // now hold starts part-way into patterns somebody above still plays whole.
  assert.ok(patCount(song) > pats, `the re-bar materialised copies (${pats} → ${patCount(song)})`);
});

test("a pattern only the cues ABOVE the cut play is left alone", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  const cut = song0.songMap().entries[10];
  const above = new Set(), below = new Set();
  song0.cues.forEach((w, c) => {
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      const p = w[ch] & 0x7fff;
      if (p !== CUE_EMPTY) (c < 10 ? above : below).add(p);
    }
  });
  const kept = [...above].filter((p) => !below.has(p) && song0.patterns[p]);
  assert.ok(kept.length > 0, "fixture: some patterns play only above the cut");
  const was = new Map(kept.map((p) => [p, song0.patterns[p].map((c) => cellKey(c)).join()]));
  const song = applyPlan(doc, planCutCue(song0, cut.startRow + 3, {}));
  for (const [p, key] of was) {
    assert.equal(song.patterns[p].map((c) => cellKey(c)).join(), key, `pattern ${p}`);
  }
});

test("the rebuild recycles numbers rather than one pattern per slot", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[1];
  const before = patCount(song0);
  const slots = song0.cues.reduce((n, w) => n +
    [...w].filter((x) => (x & 0x7fff) !== CUE_EMPTY).length, 0);
  const song = applyPlan(doc, planCutCue(song0, e.startRow + 20, {}));
  assert.ok(patCount(song) < before + slots / 2,
    `pattern count stayed bounded (${before} → ${patCount(song)}, ${slots} slots)`);
});

test("a cut inside the LAST cue is exactly a split", () => {
  const doc = load("town.taud");
  const map = doc.songs[0].songMap();
  const last = map.entries[map.entries.length - 1];
  const at = last.startRow + 9;
  const cut = applyPlan(doc, planCutCue(doc.songs[0], at, {}));
  const cutLimits = limits(cut), cutLinear = linear(cut);
  const doc2 = load("town.taud");
  const split = applyPlan(doc2, planSplitCue(doc2.songs[0], at, {}));
  assert.deepEqual(cutLimits, limits(split), "there is nothing below to re-bar");
  assert.deepEqual(cutLinear, linear(split));
});

test("a cut hands the cue's halt and jump to the cue below it", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[4];
  for (let ch = 0; ch < 16; ch++) {
    const w0 = 0x0100; // plain HALT
    song0.cues[e.cue][ch] = (song0.cues[e.cue][ch] & 0x7fff) | (((w0 >> ch) & 1) << 15);
    const w1 = 0xf000 | 2; // JMP 2
    song0.cues[e.cue][16 + ch] = (song0.cues[e.cue][16 + ch] & 0x7fff) | (((w1 >> ch) & 1) << 15);
  }
  const song = applyPlan(doc, planCutCue(song0, e.startRow + 24, {}));
  const head = cueInfo(song.cues[e.cue]);
  const next = cueInfo(song.cues[e.cue + 1]);
  assert.equal(head.rowLimit, 24);
  assert.equal(head.isHalt, false, "the head does not halt part-way through the music");
  assert.equal(head.flow, null);
  assert.equal(next.isHalt, true, "the halt went to the cue that now ends there");
  assert.equal(next.flow.type, INST_JUMP);
  assert.equal(next.flow.arg, 2);
});

test("a jump aimed at the cut cue still lands on its top", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const jmp = 0xf000 | 6;
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][16 + ch] = (song0.cues[9][16 + ch] & 0x7fff) | (((jmp >> ch) & 1) << 15);
  }
  const e = song0.songMap().entries[6];
  const song = applyPlan(doc, planCutCue(song0, e.startRow + 30, {}));
  const flow = cueInfo(song.cues[10]).flow; // cue 9 moved one along
  assert.equal(flow.type, INST_JUMP);
  assert.equal(flow.arg, 6, "cue 6 is still the head of the music it aimed at");
});

test("cutting at a cue boundary is nothing to do", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  for (const e of song0.songMap().entries) {
    assert.equal(planCutCue(song0, e.startRow, {}), null, `cue ${e.cue} starts here`);
  }
  assert.equal(planCutCue(song0, song0.songMap().totalRows, {}), null);
});

test("the wide cell (format v3) survives a cut", () => {
  const doc = load("town.taud");
  doc.upgradeToWideCells();
  const song0 = doc.songs[0];
  const before = linear(song0, true);
  const e = song0.songMap().entries[2];
  const song = applyPlan(doc, planCutCue(song0, e.startRow + 7, { wide: true }));
  assert.deepEqual(linear(song, true), before);
});

test("cut then undo restores the document byte-for-byte", () => {
  const doc = load("town.taud");
  const bytes = doc.toBytes();
  const undo = new UndoStack(doc);
  const e = doc.songs[0].songMap().entries[2];
  const plan = planCutCue(doc.songs[0], e.startRow + 11,
    { patternNames: doc._nameTable("pNam") });
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, null));
  assert.notDeepEqual(doc.toBytes(), bytes);
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytes);
});

// ── cue instructions ──

test("a shortened cue gets a LEN saying so", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const total = song0.songMap().totalRows;
  const song = applyPlan(doc, planDeleteRows(song0, total - 10, total - 1, {}));
  const last = song.songMap().entries.length - 1;
  assert.equal(cueInfo(song.cues[last]).rowLimit, 22, "the 32-row last cue lost ten");
});

test("a cue keeps its HALT when the music through it changes", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[5];
  song0.cues[e.cue][8] |= 0x8000; // word 0 = 0x0100 → plain HALT
  assert.equal(cueInfo(song0.cues[e.cue]).isHalt, true);
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow - 2, e.startRow + 1, {}));
  assert.equal(cueInfo(song.cues[e.cue]).isHalt, true, "the halt stayed on its cue");
});

test("an absolute jump follows the cue it aimed at", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const jmp = 0xf000 | 6; // JMP 6 on cue 9, in instruction word 1 (channels 16-31)
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][16 + ch] = (song0.cues[9][16 + ch] & 0x7fff) | (((jmp >> ch) & 1) << 15);
  }
  assert.equal(cueInfo(song0.cues[9]).flow.type, INST_JUMP);
  const e = song0.songMap().entries[2];
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow, e.startRow + e.rowLimit - 1, {}));
  const flow = cueInfo(song.cues[8]).flow; // cue 9 shifted down to 8
  assert.equal(flow.type, INST_JUMP);
  assert.equal(flow.arg, 5, "cue 6 became cue 5, so the jump did too");
});

test("relative jumps are re-measured across an inserted cue", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const back = 0x8000 | 4; // BAK 4 on cue 9 → cue 5
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][ch] = (song0.cues[9][ch] & 0x7fff) | (((back >> ch) & 1) << 15);
  }
  assert.equal(cueInfo(song0.cues[9]).flow.type, INST_GOBACK);
  const song = applyPlan(doc, planInsertCue(song0, song0.songMap().entries[7].startRow, true, {}));
  const flow = cueInfo(song.cues[10]).flow; // cue 9 moved one along
  assert.equal(flow.type, INST_GOBACK);
  assert.equal(flow.arg, 5, "one more cue now sits between it and its target");
});

// ── document integration ──

test("nothing to do reports it", () => {
  const song = load("town.taud").songs[0];
  const total = song.songMap().totalRows;
  assert.equal(planDeleteRows(song, total + 10, total + 20, {}), null, "past the end: nothing");
  assert.equal(planInsertRows(song, 0, 0, {}).changed, true, "a 0 becomes one row");
});

test("pattern names follow a copy the rebuild had to make", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  const names = doc._nameTable("pNam");
  names[14] = "chorus";
  const e = song0.songMap().entries.find(
    (x) => [...song0.cues[x.cue]].some((w) => (w & 0x7fff) === 14));
  const ch = [...song0.cues[e.cue]].findIndex((w) => (w & 0x7fff) === 14);
  const plan = planDeleteRows(song0, e.startRow, e.startRow, { patternNames: names });
  const song = applyPlan(doc, plan);
  const now = song.cues[e.cue][ch] & 0x7fff;
  assert.equal(plan.pNam[now], "chorus", "whatever it plays now carries the name");
});

test("delete then undo restores the document byte-for-byte", () => {
  const doc = load("town.taud");
  const bytes = doc.toBytes();
  const undo = new UndoStack(doc);
  const plan = planDeleteRows(doc.songs[0], 20, 40, { patternNames: doc._nameTable("pNam") });
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, null));
  assert.notDeepEqual(doc.toBytes(), bytes);
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytes);
  undo.redo();
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytes, "redo then undo returns to the original");
});

test("the wide cell (format v3) survives a row delete", () => {
  const doc = load("town.taud");
  doc.upgradeToWideCells();
  const song0 = doc.songs[0];
  const before = linear(song0, true);
  const song = applyPlan(doc, planDeleteRows(song0, 12, 15, { wide: true }));
  const want = before.slice();
  want.splice(12, 4);
  assert.deepEqual(linear(song, true), want);
});

test("a song whose cues all differ in length still reads straight through", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  assert.ok(new Set(limits(song0)).size >= 3, "fixture: cues of several lengths");
  const before = linear(song0);
  // Three cuts in a row, each landing inside a different cue.
  let song = song0;
  const want = before.slice();
  for (const at of [1000, 300, 20]) {
    song = applyPlan(doc, planDeleteRows(song, at, at + 2, {}));
    want.splice(at, 3);
  }
  assert.deepEqual(linear(song), want);
});
