// Lane insert/remove (the Timeline lane context menu) + the free-pattern
// allocator behind its "New pattern" item.
//
// The load-bearing invariant is that only the PATTERN half of a cue word moves:
// bit 15 of lanes 0-31 spells the cue's two instruction words, so a shift
// that carried it would silently rewrite LEN/HALT/jump. Every test below checks
// the instruction words survive the shift unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { insertChannelOp, removeChannelOp, channelHasContent } from "../../src/doc/ops.js";
import { CUE_EMPTY } from "../../src/format/taud-const.js";
import { parseTaud, cueInstructionWords } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

/** Pattern numbers of cue `c`'s first `n` lanes. */
const pats = (doc, c, n = 8) =>
  [...doc.songs[0].cues[c].subarray(0, n)].map((w) => w & 0x7fff);
/** Every cue's instruction-word pair — the thing a shift must not disturb. */
const insts = (doc) => doc.songs[0].cues.map((w) => cueInstructionWords(w));

test("insertChannel: shifts patterns right, blanks the inserted slot", () => {
  const doc = loadWhen();
  const before = pats(doc, 0);
  const chans = doc.channelCount;
  insertChannelOp(0, 2).apply(doc);
  const after = pats(doc, 0);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2), "left of the insert is untouched");
  assert.equal(after[2], CUE_EMPTY, "the inserted slot is empty");
  assert.deepEqual(after.slice(3), before.slice(2, 7), "the rest shifted one right");
  // the last lane fell off the end
  assert.equal(doc.songs[0].cues[0][chans - 1] & 0x7fff,
    doc.songs[0].cues[0][chans - 1] & 0x7fff);
});

test("insertChannel: cue instruction words are position-bound, not shifted", () => {
  const doc = loadWhen();
  const before = insts(doc);
  insertChannelOp(0, 0).apply(doc);
  assert.deepEqual(insts(doc), before);
});

test("insertChannel at 0: every channel moves one along", () => {
  const doc = loadWhen();
  const before = pats(doc, 0);
  insertChannelOp(0, 0).apply(doc);
  const after = pats(doc, 0);
  assert.equal(after[0], CUE_EMPTY);
  assert.deepEqual(after.slice(1), before.slice(0, 7));
});

test("insertChannel: the op's inverse restores every cue word exactly", () => {
  const doc = loadWhen();
  const snapshot = doc.songs[0].cues.map((w) => Uint16Array.from(w));
  const inverse = insertChannelOp(0, 3).apply(doc);
  assert.notDeepEqual(doc.songs[0].cues[0], snapshot[0]);
  inverse.apply(doc);
  doc.songs[0].cues.forEach((w, c) => assert.deepEqual(w, snapshot[c], `cue ${c}`));
});

test("insertChannel: content pushed off the last channel comes back on undo", () => {
  const doc = loadWhen();
  const chans = doc.channelCount;
  // Put a pattern on the last lane of cue 0 so the insert has to drop it.
  doc.songs[0].cues[0][chans - 1] = (doc.songs[0].cues[0][chans - 1] & 0x8000) | 0x0123;
  assert.equal(channelHasContent(doc.songs[0], chans - 1), true);
  const snapshot = doc.songs[0].cues.map((w) => Uint16Array.from(w));
  const inverse = insertChannelOp(0, 0).apply(doc);
  assert.notEqual(doc.songs[0].cues[0][chans - 1] & 0x7fff, 0x0123);
  inverse.apply(doc);
  assert.equal(doc.songs[0].cues[0][chans - 1] & 0x7fff, 0x0123);
  doc.songs[0].cues.forEach((w, c) => assert.deepEqual(w, snapshot[c], `cue ${c}`));
});

test("removeChannel is insertChannel's mirror: shift left, blank the last", () => {
  const doc = loadWhen();
  const before = pats(doc, 0);
  const chans = doc.channelCount;
  removeChannelOp(0, 1).apply(doc);
  const after = pats(doc, 0);
  assert.equal(after[0], before[0]);
  assert.deepEqual(after.slice(1, 7), before.slice(2, 8));
  assert.equal(doc.songs[0].cues[0][chans - 1] & 0x7fff, CUE_EMPTY);
});

test("insert/remove round-trip through the undo stack is byte-exact", () => {
  const doc = loadWhen();
  const bytesBefore = doc.toBytes();
  const undo = new UndoStack(doc);
  undo.apply(insertChannelOp(0, 5));
  assert.notDeepEqual(doc.toBytes(), bytesBefore);
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytesBefore);
  undo.redo();
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytesBefore, "redo then undo returns to the original");
});

test("insertChannel dirty tags cover exactly the cues that changed", () => {
  const doc = loadWhen();
  const op = insertChannelOp(0, 0);
  op.apply(doc);
  const tags = op.dirty(doc);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.equal(tag.kind, "cue");
    assert.equal(tag.song, 0);
  }
  // A song with no content at all changes nothing, so it tags nothing.
  const empty = loadWhen();
  for (const w of empty.songs[0].cues) w.fill(CUE_EMPTY);
  const op2 = insertChannelOp(0, 0);
  op2.apply(empty);
  assert.deepEqual(op2.dirty(empty), []);
});

test("channelHasContent: only counts real pattern references", () => {
  const doc = loadWhen();
  const chans = doc.channelCount;
  assert.equal(channelHasContent(doc.songs[0], chans - 1), false);
  assert.equal(channelHasContent(doc.songs[0], 0), true);
  // A bare command bit on an otherwise empty slot is an instruction, not content.
  doc.songs[0].cues[0][chans - 1] = 0x8000 | CUE_EMPTY;
  assert.equal(channelHasContent(doc.songs[0], chans - 1), false);
});

// ── lane mutes ride with the content ─────

const muteArr = (doc, ...on) => {
  const m = new Array(doc.channelCount).fill(false);
  for (const i of on) m[i] = true;
  return m;
};

test("insertChannel: mutes shift with the patterns they belong to", () => {
  const doc = loadWhen();
  const mutes = muteArr(doc, 2, 5);
  insertChannelOp(0, 2, null, mutes).apply(doc);
  assert.equal(mutes[2], false, "the inserted channel starts unmuted");
  assert.equal(mutes[3], true, "channel 2's mute moved with it");
  assert.equal(mutes[6], true, "channel 5's mute moved with it");
  assert.equal(mutes[5], false);
});

test("insertChannel: a mute pushed off the end comes back on undo", () => {
  const doc = loadWhen();
  const chans = doc.channelCount;
  const mutes = muteArr(doc, 0, chans - 1);
  const before = mutes.slice();
  const inverse = insertChannelOp(0, 0, null, mutes).apply(doc);
  assert.equal(mutes[chans - 1], false, "the last channel's mute fell off the end");
  assert.equal(mutes[1], true, "channel 0's mute moved along");
  inverse.apply(doc);
  assert.deepEqual(mutes, before, "undo restores the whole mute array");
});

test("insertChannel: undo shifts mutes back, keeping later toggles in place", () => {
  const doc = loadWhen();
  const mutes = muteArr(doc);
  const inverse = insertChannelOp(0, 1, null, mutes).apply(doc);
  // The user mutes a lane AFTER the insert — its content sits at index 5,
  // and undo moves that content (and so its mute) back to 4.
  mutes[5] = true;
  inverse.apply(doc);
  assert.equal(mutes[4], true, "the later mute followed its content back");
  assert.equal(mutes[5], false);
});

test("removeChannel: mutes shift left and the restored one lands last", () => {
  const doc = loadWhen();
  const chans = doc.channelCount;
  const mutes = muteArr(doc, 3);
  removeChannelOp(0, 1, { pats: null, mute: true }, mutes).apply(doc);
  assert.equal(mutes[2], true, "channel 3's mute shifted left with it");
  assert.equal(mutes[3], false);
  assert.equal(mutes[chans - 1], true, "the carried mute lands on the last channel");
});

test("channel ops tag {kind:\"voices\"} only when they were given mutes", () => {
  const doc = loadWhen();
  const bare = insertChannelOp(0, 0);
  bare.apply(doc);
  assert.equal(bare.dirty(doc).some((tg) => tg.kind === "voices"), false);
  const doc2 = loadWhen();
  const withMutes = insertChannelOp(0, 0, null, muteArr(doc2));
  withMutes.apply(doc2);
  assert.equal(withMutes.dirty(doc2).filter((tg) => tg.kind === "voices").length, 1);
});

test("firstFreePattern: lowest number no cue and no materialised pattern claims", () => {
  const doc = loadWhen();
  const song = doc.songs[0];
  const free = song.firstFreePattern();
  // Nothing may already be using it…
  assert.ok(song.patterns[free] === undefined || song.patterns[free] === null);
  for (const w of song.cues) {
    for (const word of w) assert.notEqual(word & 0x7fff, free);
  }
  // …and every number below it must be taken, otherwise it isn't the lowest.
  const used = new Set();
  for (const w of song.cues) for (const word of w) used.add(word & 0x7fff);
  for (let p = 0; p < free; p++) {
    assert.ok(used.has(p) || song.patterns[p], `pattern ${p} should be claimed`);
  }
});

test("firstFreePattern: a cue reference alone claims a number (item 48)", () => {
  const doc = loadWhen();
  const song = doc.songs[0];
  const free = song.firstFreePattern();
  song.cues[0][0] = (song.cues[0][0] & 0x8000) | free;
  assert.notEqual(song.firstFreePattern(), free);
});

// ── "New pattern" over a block ──

test("freePatternNumbers: N lowest unclaimed numbers, none of them in use", () => {
  const doc = loadWhen();
  const song = doc.songs[0];
  const used = song.usedPatternNumbers();
  const nums = song.freePatternNumbers(5);
  assert.equal(nums.length, 5);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "ascending");
  assert.equal(new Set(nums).size, 5, "all distinct — a block wants one each");
  for (const n of nums) assert.equal(used.has(n), false, `pattern ${n} was already claimed`);
  assert.equal(nums[0], song.firstFreePattern(), "the first is what firstFreePattern gives");
});

test("usedPatternNumbers counts cue references AND materialised patterns", () => {
  const doc = loadWhen();
  const song = doc.songs[0];
  const free = song.firstFreePattern();
  assert.equal(song.usedPatternNumbers().has(free), false);
  // A bare cue reference claims it (item 48) …
  song.cues[0][0] = (song.cues[0][0] & 0x8000) | free;
  assert.equal(song.usedPatternNumbers().has(free), true);
  // … and so does a materialised pattern nothing points at.
  const doc2 = loadWhen();
  const free2 = doc2.songs[0].firstFreePattern();
  doc2.ensurePattern(0, free2);
  assert.equal(doc2.songs[0].usedPatternNumbers().has(free2), true);
  assert.notEqual(doc2.songs[0].firstFreePattern(), free2);
});
