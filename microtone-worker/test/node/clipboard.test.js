// Block clipboard (item 17): the pure block helpers (clipboard.js) and the
// multi-cell invertible op (setCellsBytesOp) used by Timeline/Pattern
// copy/cut/paste/delete.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  emptyCellBytes, cellToBytes, makeBlock, blockCell, overlayCols,
} from "../../src/doc/clipboard.js";
import {
  COL_NOTE, COL_INST, COL_VOL, COL_PAN, COL_FX, COL_FX2, ALL_COLS, subToCol, colsForSubs,
  SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG, SUB_FX2_OP, SUB_FX2_ARG,
} from "../../src/ui/edit.js";
import { setCellsBytesOp } from "../../src/doc/ops.js";
import { TaudPlayData } from "../../src/engine/state.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

test("emptyCellBytes: converter blank-cell convention (0xC0 vol/pan)", () => {
  const b = emptyCellBytes();
  assert.equal(b.length, 8);
  assert.equal(b[3], 0xc0);
  assert.equal(b[4], 0xc0);
  for (const off of [0, 1, 2, 5, 6, 7]) assert.equal(b[off], 0);
});

test("cellToBytes round-trips through TaudPlayData", () => {
  const cell = new TaudPlayData();
  cell.note = 0x5155; cell.instrment = 0x0c; cell.volume = 0x2a; cell.volumeEff = 1;
  cell.pan = 0x10; cell.panEff = 2; cell.effect = 5; cell.effectArg = 0xbeef;
  const bytes = cellToBytes(cell);
  const back = new TaudPlayData();
  for (let i = 0; i < 8; i++) back.setByte(i, bytes[i]);
  assert.deepEqual({ ...back }, { ...cell });
});

test("makeBlock: rows×chans of blank cells; blockCell addresses row-major", () => {
  const block = makeBlock(3, 2);
  assert.equal(block.rows, 3);
  assert.equal(block.chans, 2);
  assert.equal(block.cells.length, 3 * 2 * 8);
  // every slot starts blank
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      assert.deepEqual([...blockCell(block, r, c)], [...emptyCellBytes()]);
    }
  }
  // writes to (1,1) do not bleed into neighbours
  blockCell(block, 1, 1).set([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...blockCell(block, 1, 1)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...blockCell(block, 1, 0)], [...emptyCellBytes()]);
  assert.deepEqual([...blockCell(block, 0, 1)], [...emptyCellBytes()]);
});

test("setCellsBytesOp: multi-pattern write, dirty tags, undo/redo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  const w = [
    { pat: 0, row: 5, bytes: Uint8Array.from([0x55, 0x51, 0x0c, 0x2a | 0x40, 0x10 | 0x80, 5, 0xef, 0xbe]) },
    { pat: 2, row: 9, bytes: emptyCellBytes() },
  ];
  const op = setCellsBytesOp(0, w);
  // dirty covers every touched pattern (order-independent)
  const tags = op.dirty().map((t) => t.pat).sort((a, b) => a - b);
  assert.deepEqual(tags, [0, 2]);

  undo.apply(op);
  assert.deepEqual([...cellToBytes(doc.songs[0].patterns[0][5])], [...w[0].bytes]);
  assert.deepEqual([...cellToBytes(doc.songs[0].patterns[2][9])], [...w[1].bytes]);
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before));

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("subToCol / colsForSubs: sub-cursor → logical columns (fx op+arg = one)", () => {
  assert.equal(subToCol(SUB_NOTE), COL_NOTE);
  assert.equal(subToCol(SUB_INST), COL_INST);
  assert.equal(subToCol(SUB_VOL), COL_VOL);
  assert.equal(subToCol(SUB_PAN), COL_PAN);
  assert.equal(subToCol(SUB_FX_OP), COL_FX);
  assert.equal(subToCol(SUB_FX_ARG), COL_FX);
  assert.equal(subToCol(SUB_FX2_OP), COL_FX2);
  assert.equal(subToCol(SUB_FX2_ARG), COL_FX2);
  assert.deepEqual(colsForSubs(SUB_INST, SUB_VOL), [COL_INST, COL_VOL]);
  assert.deepEqual(colsForSubs(SUB_VOL, SUB_INST), [COL_INST, COL_VOL], "order-independent");
  assert.deepEqual(colsForSubs(SUB_NOTE, SUB_FX2_ARG), ALL_COLS, "full span = all columns");
  assert.deepEqual(colsForSubs(SUB_FX_OP, SUB_FX_ARG), [COL_FX], "op+arg collapse to fx");
  assert.deepEqual(colsForSubs(SUB_FX2_OP, SUB_FX2_ARG), [COL_FX2], "…and so do the second's");
  // A cell whose second effect is HIDDEN spans only as far as the first one, so
  // the block operations leave the second effect alone (edit.js lastSub).
  assert.deepEqual(colsForSubs(SUB_NOTE, SUB_FX_ARG),
    [COL_NOTE, COL_INST, COL_VOL, COL_PAN, COL_FX], "hidden fx2 is outside the span");
});

test("overlayCols: only the named columns overwrite; others keep dest bytes", () => {
  // dest: note C4, inst 0x05, vol 0x20, pan 0x30, fx A0F00
  const dest = Uint8Array.from([0x00, 0x50, 0x05, 0x20, 0x30, 0x0a, 0x00, 0x0f]);
  // src: note D4, inst 0x0A, vol 0x3F, pan 0x00, fx B1234
  const src = Uint8Array.from([0x00, 0x54, 0x0a, 0x3f, 0x00, 0x0b, 0x34, 0x12]);

  // overlay only inst + vol
  const out = overlayCols(Uint8Array.from(dest), src, [COL_INST, COL_VOL]);
  assert.equal(out[2], 0x0a, "inst overwritten");
  assert.equal(out[3], 0x3f, "vol overwritten");
  assert.equal(out[0], 0x00); assert.equal(out[1], 0x50, "note untouched");
  assert.equal(out[4], 0x30, "pan untouched");
  assert.deepEqual([...out.subarray(5, 8)], [0x0a, 0x00, 0x0f], "fx untouched");

  // all columns = full overwrite
  assert.deepEqual([...overlayCols(Uint8Array.from(dest), src, ALL_COLS)], [...src]);
});

test("copy → paste block: bytes land verbatim at the destination", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const pat = doc.songs[0].patterns[0];

  // capture rows 0..2 of pattern 0 into a 1-lane block (Pattern-view copy)
  const block = makeBlock(3, 1);
  for (let r = 0; r < 3; r++) blockCell(block, r, 0).set(cellToBytes(pat[r]));

  // paste at row 20 (Pattern-view paste)
  const writes = [];
  for (let r = 0; r < 3; r++) {
    writes.push({ pat: 0, row: 20 + r, bytes: Uint8Array.from(blockCell(block, r, 0)) });
  }
  undo.apply(setCellsBytesOp(0, writes));

  for (let r = 0; r < 3; r++) {
    assert.deepEqual([...cellToBytes(pat[20 + r])], [...cellToBytes(pat[r])], `row ${r} pasted`);
  }
});
