// 32 ↔ 64 lanes (the Project tab's lane count): one undoable op over the whole
// file — the xHDR flag, every song's lane count and cue sheet — that moves no
// music, and refuses (through laneModeBlocker) whatever would not fit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { CUE_EMPTY, NUM_CUES_64 } from "../../core/format/taud-const.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { laneModeBlocker, setLaneModeOp } from "../../src/doc/ops.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const WHEN = readFileSync(corpusDir + "WHEN.taud");
const load = () => new Document(parseTaud(WHEN));

test("32 → 64 lanes: the file says so, and lanes 1–32 keep every cue word", () => {
  const doc = load();
  assert.equal(doc.is64Channel, false);
  assert.equal(laneModeBlocker(doc, true), null);
  const before = doc.songs.map((s) => s.cues.map((w) => w.slice(0, 32)));
  const undo = new UndoStack(doc);
  undo.apply(setLaneModeOp(true));
  assert.equal(doc.channelCount, 64);

  const re = new Document(parseTaud(doc.toBytes()));
  assert.equal(re.is64Channel, true, "xHDR written and read back");
  re.songs.forEach((s, i) => {
    // (The writer stops at the last cue in use, in either mode.)
    assert.ok(s.cues.length > 0 && s.cues.length <= before[i].length);
    s.cues.forEach((w, c) => {
      assert.deepEqual(w.slice(0, 32), before[i][c], `song ${i} cue ${c}`);
      for (let ch = 32; ch < 64; ch++) assert.equal(w[ch], CUE_EMPTY, "new lanes start empty");
    });
    assert.ok(s.numVoices <= 64);
  });
});

test("undo puts the 32-lane file back byte for byte; redo is the 64-lane file", () => {
  const doc = load();
  const orig = doc.toBytes();
  const undo = new UndoStack(doc);
  undo.apply(setLaneModeOp(true));
  const wide = doc.toBytes();
  undo.undo();
  assert.deepEqual(doc.toBytes(), orig);
  assert.equal(doc.is64Channel, false);
  undo.redo();
  assert.deepEqual(doc.toBytes(), wide);
});

test("64 lanes sound exactly like 32 while lanes 33–64 are empty", () => {
  const narrow = load();
  const wide = load();
  setLaneModeOp(true).apply(wide);
  const render = (doc) => {
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc.toRenderable(0), 0);
    return renderSong(eng, 4);
  };
  const a = render(narrow), b = render(wide);
  assert.deepEqual(b.f32, a.f32);
  assert.deepEqual(b.u8, a.u8);
});

test("back to 32 lanes is refused while lane 33 or above has a pattern", () => {
  const doc = load();
  setLaneModeOp(true).apply(doc);
  doc.songs[0].cues[0][40] = 0;
  assert.equal(laneModeBlocker(doc, false), "lanes");
  doc.songs[0].cues[0][40] = CUE_EMPTY;
  assert.equal(laneModeBlocker(doc, false), null);

  const orig = load().toBytes();
  setLaneModeOp(false).apply(doc);
  assert.equal(doc.is64Channel, false);
  assert.ok(!doc.projSections.some((s) => s.fourcc === "xHDR"), "an empty xHDR is dropped");
  assert.deepEqual(doc.toBytes(), orig, "there and back is the same file");
});

test("64 lanes are refused while a song runs past cue 4096", () => {
  const doc = load();
  const song = doc.songs[0];
  while (song.cues.length <= NUM_CUES_64) song.cues.push(new Uint16Array(64).fill(CUE_EMPTY));
  song.cues[NUM_CUES_64][0] = 0;
  assert.equal(laneModeBlocker(doc, true), "cues");
  song.cues[NUM_CUES_64][0] = CUE_EMPTY;
  assert.equal(laneModeBlocker(doc, true), null, "trailing empty cues do not count");
  setLaneModeOp(true).apply(doc);
  assert.ok(song.cues.length <= NUM_CUES_64);
});
