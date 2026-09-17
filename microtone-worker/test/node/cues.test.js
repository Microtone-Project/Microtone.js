// Cue-sheet growth + block clipboard (Cues view): the growable bulk cue op
// (setCuesOp — edit/paste past the last stored cue) and the pure cue-block
// helpers (makeCueBlock / cueBlockIndex / mergeCueWord).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { setCuesOp } from "../../src/doc/ops.js";
import { makeCueBlock, cueBlockIndex, mergeCueWord } from "../../src/doc/clipboard.js";
import { CUE_EMPTY } from "../../src/format/taud-const.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

test("makeCueBlock: rows×chans of empty pattern words, row-major indexing", () => {
  const block = makeCueBlock(3, 2);
  assert.equal(block.rows, 3);
  assert.equal(block.chans, 2);
  assert.equal(block.words.length, 6);
  for (const w of block.words) assert.equal(w, CUE_EMPTY);
  block.words[cueBlockIndex(block, 1, 1)] = 0x0042;
  assert.equal(block.words[cueBlockIndex(block, 1, 1)], 0x0042);
  assert.equal(block.words[cueBlockIndex(block, 1, 0)], CUE_EMPTY);
  assert.equal(block.words[cueBlockIndex(block, 0, 1)], CUE_EMPTY);
});

test("mergeCueWord: takes the source pattern, keeps the dest command sign bit", () => {
  // dest has a command bit (0x8000) + pattern 0x0005; source pattern 0x0042
  assert.equal(mergeCueWord(0x8005, 0x0042), 0x8042);
  // dest without a command bit
  assert.equal(mergeCueWord(0x0005, 0x0042), 0x0042);
  // pasting an empty source blanks the pattern but keeps the command bit
  assert.equal(mergeCueWord(0x8005, CUE_EMPTY), 0xffff);
});

test("setCuesOp: in-range edit, dirty tags, undo/redo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const len0 = doc.songs[0].cues.length;

  const op = setCuesOp(0, [
    { cue: 0, ch: 0, value: 0x0007 },
    { cue: 0, ch: 1, value: CUE_EMPTY },
  ]);
  const tags = op.dirty(doc).map((t) => t.cue);
  undo.apply(op);
  assert.deepEqual(tags, [0], "one dirty tag per touched cue");
  assert.equal(doc.songs[0].cues[0][0], 0x0007);
  assert.equal(doc.songs[0].cues.length, len0, "no growth for an in-range write");

  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before));
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("setCuesOp: grows the cue list past the end and truncates on undo", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const len0 = doc.songs[0].cues.length;
  const target = len0 + 3; // three cues past the current end

  undo.apply(setCuesOp(0, [{ cue: target, ch: 5, value: 0x0011 }]));
  assert.equal(doc.songs[0].cues.length, target + 1, "grew to cover the new cue");
  assert.equal(doc.songs[0].cues[target][5], 0x0011);
  // the gap-filler cues are empty
  assert.equal(doc.songs[0].cues[len0][0], CUE_EMPTY);

  undo.undo();
  assert.equal(doc.songs[0].cues.length, len0, "undo truncates the appended cues");
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo of a grow is byte-exact");

  undo.redo();
  assert.equal(doc.songs[0].cues.length, target + 1, "redo re-grows");
  assert.equal(doc.songs[0].cues[target][5], 0x0011);
});

test("setCuesOp: dirty tags cover only the WRITTEN cues (not gap-fillers)", () => {
  const doc = loadWhen();
  const len0 = doc.songs[0].cues.length;
  const op = setCuesOp(0, [{ cue: len0 + 2, ch: 0, value: 0x0001 }]);
  op.apply(doc);
  const tags = op.dirty(doc).map((t) => t.cue);
  // gap-fillers len0, len0+1 stay empty and are not uploaded
  assert.deepEqual(tags, [len0 + 2]);
});

test("setCuesOp: growth is capped at the channel-mode cue limit", () => {
  const doc = loadWhen(); // 32-lane → NUM_CUES = 8192
  const undo = new UndoStack(doc);
  undo.apply(setCuesOp(0, [{ cue: 999999, ch: 0, value: 0x0001 }]));
  assert.equal(doc.songs[0].cues.length, 8192, "clamped to the format limit");
});

test("setCuesOp: copy voices 7..10 → paste onto voices 1..4 (cue-word block)", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const song = doc.songs[0];

  // seed a recognisable pattern in cue 0, voices 7..10
  undo.apply(setCuesOp(0, [
    { cue: 0, ch: 7, value: 0x0071 },
    { cue: 0, ch: 8, value: 0x0072 },
    { cue: 0, ch: 9, value: 0x0073 },
    { cue: 0, ch: 10, value: 0x0074 },
  ]));

  // copy that 1×4 block (pattern index only)
  const block = makeCueBlock(1, 4);
  for (let c = 0; c < 4; c++) block.words[cueBlockIndex(block, 0, c)] = song.cues[0][7 + c] & 0x7fff;

  // paste onto voices 1..4 of cue 2, preserving each dest command bit
  const writes = [];
  for (let c = 0; c < 4; c++) {
    const dch = 1 + c;
    writes.push({ cue: 2, ch: dch, value: mergeCueWord(song.cues[2][dch], block.words[c]) });
  }
  undo.apply(setCuesOp(0, writes));
  assert.deepEqual([...song.cues[2].subarray(1, 5)], [0x0071, 0x0072, 0x0073, 0x0074]);
});

test("setCuesOp: paste preserves the destination cue's HALT command bits", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const song = doc.songs[0];

  // give cue 1 a command bit on lane 0 (simulated HALT sign bit)
  song.cues[1][0] |= 0x8000;
  const cmdBefore = song.cues[1][0] & 0x8000;

  // paste a plain pattern onto that same lane
  undo.apply(setCuesOp(0, [{ cue: 1, ch: 0, value: mergeCueWord(song.cues[1][0], 0x0009) }]));
  assert.equal(song.cues[1][0] & 0x7fff, 0x0009, "pattern index pasted");
  assert.equal(song.cues[1][0] & 0x8000, cmdBefore, "command bit preserved");
});

test("serialisation trims trailing empty cues (save only what's used)", () => {
  const doc = loadWhen();
  const s = doc.songs[0];
  const chans = doc.channelCount;
  assert.equal(s.cues.length, 1024, "in-memory buffer keeps the loaded length");

  // highest non-empty cue in the loaded song
  let lastUsed = 0;
  for (let c = 0; c < s.cues.length; c++) if (!s.cues[c].every((w) => w === CUE_EMPTY)) lastUsed = c;
  const reBefore = parseTaud(doc.toBytes());
  assert.equal(reBefore.songs[0].cues.length, lastUsed + 1, "unedited save trims to lastUsed+1");

  // blank every cue past index 15 (patterns AND commands) → 16-cue song
  const undo = new UndoStack(doc);
  const writes = [];
  for (let c = 16; c < s.cues.length; c++) for (let ch = 0; ch < chans; ch++) {
    writes.push({ cue: c, ch, value: CUE_EMPTY });
  }
  undo.apply(setCuesOp(0, writes));
  assert.equal(s.cues.length, 1024, "delete does not shrink the in-memory buffer");
  assert.equal(parseTaud(doc.toBytes()).songs[0].cues.length, 16, "serialised to 16 cues");

  undo.undo();
  assert.equal(parseTaud(doc.toBytes()).songs[0].cues.length, lastUsed + 1, "undo restores the count");
});

test("serialisation keeps INTERIOR empty cues, trims only the trailing run", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  // Clear everything, then set content only at cue 0 and cue 10 (1..9 empty).
  const s = doc.songs[0];
  const chans = doc.channelCount;
  const clear = [];
  for (let c = 0; c < s.cues.length; c++) for (let ch = 0; ch < chans; ch++) clear.push({ cue: c, ch, value: CUE_EMPTY });
  undo.apply(setCuesOp(0, clear));
  undo.apply(setCuesOp(0, [{ cue: 0, ch: 0, value: 0x0001 }, { cue: 10, ch: 0, value: 0x0002 }]));

  const re = parseTaud(doc.toBytes());
  assert.equal(re.songs[0].cues.length, 11, "kept through the last used cue (10)");
  assert.equal(re.songs[0].cues[0][0], 0x0001);
  assert.equal(re.songs[0].cues[10][0], 0x0002);
  assert.ok(re.songs[0].cues[5].every((w) => w === CUE_EMPTY), "interior cue 5 preserved as empty");
});

test("cueBytes tolerates an out-of-range (truncated) cue index", () => {
  const doc = loadWhen();
  const chans = doc.channelCount;
  const bytes = doc.cueBytes(0, 999999); // never materialised
  assert.equal(bytes.length, chans * 2);
  // all words are CUE_EMPTY (0x7FFF → bytes 0xFF, 0x7F)
  for (let ch = 0; ch < chans; ch++) {
    assert.equal(bytes[ch * 2], 0xff);
    assert.equal(bytes[ch * 2 + 1], 0x7f);
  }
});
