// Sample editor foundations — the pure DSP set (sampledsp.js) and the two
// invertible ops it drives (setSampleBytesOp pool-span writes,
// multiInstBytesOp shared loop-field writes across a sample's users).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normalise, fadeIn, fadeOut, reverse, invert, removeDC } from "../../src/doc/sampledsp.js";
import { setSampleBytesOp, multiInstBytesOp, setSectionOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

test("DSP ops: length-preserving, input untouched, correct shapes", () => {
  const src = Uint8Array.from([128, 160, 96, 128, 192, 64, 128]);
  const snapshot = Uint8Array.from(src);

  const norm = normalise(src);
  assert.equal(norm.length, src.length);
  assert.deepEqual([...src], [...snapshot], "input untouched");
  // peak dev was 64 (192/64) → scaled to 127: 128±127
  assert.equal(Math.max(...norm.map((v) => Math.abs(v - 128))), 127);
  assert.equal(norm[0], 128, "centre stays centre");
  assert.ok(norm[4] === 255 && norm[5] === 1, "peaks hit full scale");

  const silence = Uint8Array.from([128, 128, 128]);
  assert.deepEqual([...normalise(silence)], [128, 128, 128], "silence is a no-op");

  const fi = fadeIn(src);
  assert.equal(fi[0], 128, "fade-in starts silent");
  assert.equal(fi.at(-1), src.at(-1), "fade-in ends at full level");
  const fo = fadeOut(src);
  assert.equal(fo[0], src[0], "fade-out starts at full level");
  assert.equal(fo.at(-1), 128, "fade-out ends silent");

  const rev = reverse(src);
  assert.deepEqual([...reverse(rev)], [...src], "reverse is an involution");
  assert.equal(rev[0], src.at(-1));

  // invert (polarity swap about 0x80): centre fixed, 256-s clamped, involution
  const inv = invert(src);
  assert.equal(inv.length, src.length);
  assert.deepEqual([...src], [...snapshot], "input untouched");
  assert.equal(inv[0], 128, "centre stays centre");
  assert.equal(inv[1], 96, "160 → 96");
  assert.equal(inv[2], 160, "96 → 160");
  assert.deepEqual([...invert(inv)], [...src], "invert is an involution (no 0x00 in src)");
  assert.equal(invert(Uint8Array.from([0]))[0], 255, "0x00 clamps to 0xFF");

  // removeDC (item 68): mean shifts to the 0x80 centre, shape preserved,
  // idempotent when no clamping, input untouched.
  const biased = Uint8Array.from([148, 180, 116, 148, 212, 84, 148]); // src + 20
  const biasedSnap = Uint8Array.from(biased);
  const dc = removeDC(biased);
  assert.equal(dc.length, biased.length);
  assert.deepEqual([...biased], [...biasedSnap], "input untouched");
  assert.deepEqual([...dc], [...src], "bias of +20 removed exactly");
  const mean = dc.reduce((a, b) => a + b, 0) / dc.length;
  assert.ok(Math.abs(mean - 128) < 1, "mean sits at the centre");
  assert.deepEqual([...removeDC(dc)], [...dc], "idempotent once centred");
  assert.deepEqual([...removeDC(src)], [...src], "already-centred span is a no-op");
  assert.equal(removeDC(new Uint8Array(0)).length, 0, "empty span tolerated");
  // extreme offset: clamping bites but output stays in range
  const railed = removeDC(Uint8Array.from([250, 255, 245, 250]));
  assert.ok(railed.every((v) => v >= 0 && v <= 255));
  const railedMean = railed.reduce((a, b) => a + b, 0) / railed.length;
  assert.ok(Math.abs(railedMean - 128) < 4, "railed span pulled to the centre");
});

test("rename: buildSampleNames splices SNam by census index; setSectionOp undoes", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const list = doc.sampleList();
  assert.ok(list.length >= 2);
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  const idx = 1;
  const other = doc.sampleName(0); // must stay byte-identical
  undo.apply(setSectionOp("SNam", doc.buildSampleNames(idx, "MyKick")));
  assert.equal(doc.sampleName(idx), "MyKick", "renamed entry");
  assert.equal(doc.sampleName(0), other, "sibling name untouched");
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before));

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("setSampleBytesOp: pool write, bank dirty tag, undo/redo byte-exact", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const s = doc.sampleList()[0];
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  const span = doc.sampleBin.subarray(s.ptr, s.ptr + s.len);
  const op = setSampleBytesOp(s.ptr, reverse(span));
  assert.deepEqual(op.dirty(), [{ kind: "bank" }]);
  undo.apply(op);
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before), "pool changed");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("multiInstBytesOp: shared loop fields across users, one undo step", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const s = doc.sampleList().find((e) => e.users.length >= 2 &&
    e.users.every((u) => !doc.instruments[u].isMeta &&
      doc.instruments[u].samplePtr === e.ptr && doc.instruments[u].sampleLength === e.len))
    ?? doc.sampleList()[0];
  const slots = s.users.filter((u) => !doc.instruments[u].isMeta &&
    doc.instruments[u].samplePtr === s.ptr && doc.instruments[u].sampleLength === s.len);
  assert.ok(slots.length >= 1);

  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const loopStart = 4, loopEnd = Math.min(100, s.len);
  const pairs = [
    [10, loopStart & 0xff], [11, (loopStart >>> 8) & 0xff],
    [12, loopEnd & 0xff], [13, (loopEnd >>> 8) & 0xff],
    [14, (doc.instruments[slots[0]].loopMode & 0x10) | 1], // forward, keep perc bit
  ];
  undo.apply(multiInstBytesOp(slots.map((slot) => ({ slot, pairs }))));
  for (const slot of slots) {
    assert.equal(doc.instruments[slot].sampleLoopStart, loopStart, `slot ${slot} loopStart`);
    assert.equal(doc.instruments[slot].sampleLoopEnd, loopEnd, `slot ${slot} loopEnd`);
    assert.equal(doc.instruments[slot].loopMode & 3, 1);
  }
  assert.equal(undo.undoStack.length, 1, "single undo step");
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("multiInstBytesOp drag gesture coalesces", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const s = doc.sampleList()[0];
  const slots = s.users.filter((u) => !doc.instruments[u].isMeta &&
    doc.instruments[u].samplePtr === s.ptr && doc.instruments[u].sampleLength === s.len);
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const mk = (v, g) => multiInstBytesOp(
    slots.map((slot) => ({ slot, pairs: [[10, v & 0xff], [11, (v >>> 8) & 0xff]] })), g);
  undo.apply(mk(10, "drag1"));
  undo.apply(mk(20, "drag1"));
  undo.apply(mk(30, "drag1"));
  assert.equal(undo.undoStack.length, 1, "drag collapses to one step");
  assert.equal(doc.instruments[slots[0]].sampleLoopStart, 30);
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo restores pre-drag state");
});
