// Ixmp patch editing (item 49b) — writePatchesBlob codec round-trips +
// setInstPatchesOp invertibility (byte-exact undo through toBytes) + the SNam
// fold-in + the DocSync {kind:"ixmp"} upload route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { DocSync } from "../../src/doc/sync.js";
import { setInstPatchesOp } from "../../src/doc/ops.js";
import { parsePatchesBlob, writePatchesBlob, makeInstPatch } from "../../core/engine/inst.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = async (name) => new Uint8Array(await readFile(corpusDir + name));

const WITH_IXMP = ["M_E1M1.taud", "flourish.taud", "town.taud", "Onestop.taud",
                   "4THSYM.taud", "Insaniq2.taud"];

test("writePatchesBlob is the byte-inverse of parsePatchesBlob on every corpus entry", async () => {
  let entries = 0;
  for (const name of WITH_IXMP) {
    const parsed = parseTaud(await load(name));
    for (const e of parsed.ixmp) {
      const back = writePatchesBlob(parsePatchesBlob(e.blob));
      assert.deepEqual([...back], [...e.blob], `${name} inst $${e.instId.toString(16)}`);
      entries++;
    }
  }
  assert.ok(entries > 100, `swept ${entries} entries`);
});

test("setInstPatchesOp: edit → persists; undo → byte-exact; redo reproduces", async () => {
  const raw = await load("M_E1M1.taud");
  const doc = new Document(parseTaud(raw));
  const baseline = doc.toBytes();
  const undo = new UndoStack(doc, () => {});
  const slot = 0x0a; // 11 patches

  const patches = parsePatchesBlob(doc.ixmp.find((e) => e.instId === slot).blob);
  const before = patches[0].pitchEnd;
  patches[0].pitchEnd = 0x1234;
  undo.apply(setInstPatchesOp(slot, writePatchesBlob(patches)));

  // live decoded view refreshed + doc dirty
  assert.equal(doc.instruments[slot].extraPatches[0].pitchEnd, 0x1234);
  assert.equal(doc.dirty, true);

  // persists through toBytes → parse
  const reparsed = parseTaud(doc.toBytes());
  const entry = reparsed.ixmp.find((e) => e.instId === slot);
  assert.equal(parsePatchesBlob(entry.blob)[0].pitchEnd, 0x1234);
  assert.equal(entry.count, 11);

  undo.undo();
  assert.equal(doc.instruments[slot].extraPatches[0].pitchEnd, before);
  assert.deepEqual([...doc.toBytes()], [...baseline], "undo is byte-exact");

  undo.redo();
  assert.equal(doc.instruments[slot].extraPatches[0].pitchEnd, 0x1234);
});

test("add / delete / reorder patches update count + section; undo restores", async () => {
  const raw = await load("M_E1M1.taud");
  const doc = new Document(parseTaud(raw));
  const baseline = doc.toBytes();
  const undo = new UndoStack(doc, () => {});
  const slot = 0x07; // 1 patch

  // add a fresh full-range patch
  const inst = doc.instruments[slot];
  const patches = (inst.extraPatches ?? []).map((p) => ({ ...p }));
  patches.push(makeInstPatch({
    pitchStart: 0x20, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    samplePtr: inst.samplePtr, sampleLength: inst.sampleLength,
    samplingRate: inst.samplingRate,
  }));
  undo.apply(setInstPatchesOp(slot, writePatchesBlob(patches)));
  assert.equal(doc.instruments[slot].extraPatches.length, 2);
  assert.equal(doc.ixmp.find((e) => (e.instId & 0x3ff) === slot).count, 2);

  // reorder: the new patch first
  const two = doc.instruments[slot].extraPatches;
  undo.apply(setInstPatchesOp(slot, writePatchesBlob([two[1], two[0]])));
  assert.equal(doc.instruments[slot].extraPatches[0].pitchStart, 0x20);

  // delete all → entry gone; when no entries remain the section is removed
  undo.apply(setInstPatchesOp(slot, null));
  assert.equal(doc.instruments[slot].extraPatches, null);
  assert.ok(!doc.ixmp.some((e) => (e.instId & 0x3ff) === slot));

  undo.undo(); // restore the reordered pair
  assert.equal(doc.instruments[slot].extraPatches.length, 2);
  undo.undo(); // restore original order
  assert.equal(doc.instruments[slot].extraPatches[0].pitchStart !== 0x20, true);
  undo.undo(); // back to 1 patch
  assert.deepEqual([...doc.toBytes()], [...baseline], "triple undo is byte-exact");
});

test("aux-bin instrument ids ($100+) survive the section rebuild", async () => {
  const raw = await load("flourish.taud");
  const doc = new Document(parseTaud(raw));
  const undo = new UndoStack(doc, () => {});
  const slot = 0x100; // aux bin, 75 patches
  const patches = parsePatchesBlob(doc.ixmp.find((e) => e.instId === slot).blob);
  patches[0].volumeEnd = 62;
  undo.apply(setInstPatchesOp(slot, writePatchesBlob(patches)));
  const reparsed = parseTaud(doc.toBytes());
  const entry = reparsed.ixmp.find((e) => e.instId === slot);
  assert.ok(entry, "aux-bin entry kept its 10-bit id");
  assert.equal(parsePatchesBlob(entry.blob)[0].volumeEnd, 62);
});

test("snam payload swaps atomically and undo restores it verbatim", async () => {
  const raw = await load("M_E1M1.taud");
  const doc = new Document(parseTaud(raw));
  const baseline = doc.toBytes();
  const undo = new UndoStack(doc, () => {});
  const slot = 0x0a;
  const prevSnam = doc.projSections.find((s) => s.fourcc === "SNam")?.payload;
  assert.ok(prevSnam, "corpus file carries SNam");

  const patches = parsePatchesBlob(doc.ixmp.find((e) => e.instId === slot).blob);
  patches[0].pitchEnd = 0x2222;
  const newSnam = new TextEncoder().encode("first\x1esecond");
  undo.apply(setInstPatchesOp(slot, writePatchesBlob(patches), newSnam));
  assert.equal(doc.sampleName(0), "first");
  assert.equal(doc.sampleName(1), "second");

  undo.undo();
  assert.deepEqual([...doc.toBytes()], [...baseline], "SNam + patches restored byte-exact");
});

test("sampleList(patchOverrides) previews the census without applying", async () => {
  const raw = await load("M_E1M1.taud");
  const doc = new Document(parseTaud(raw));
  const slot = 0x0a;
  const before = doc.sampleList();
  const patches = doc.instruments[slot].extraPatches.map((p) => ({ ...p }));
  // retarget every patch of the slot at the base sample of inst $1 → the
  // slot's own sample bytes leave the census if nobody else points at them
  const donor = doc.instruments[0x01];
  for (const p of patches) { p.samplePtr = donor.samplePtr; p.sampleLength = donor.sampleLength; }
  const after = doc.sampleList(new Map([[slot, patches]]));
  assert.notEqual(before.length, after.length, "prospective census differs");
  const unchanged = doc.sampleList();
  assert.equal(unchanged.length, before.length, "real census untouched");
});

test("DocSync routes {kind:'ixmp'} to uploadInstrumentPatches (empty blob clears)", async () => {
  const raw = await load("M_E1M1.taud");
  const doc = new Document(parseTaud(raw));
  const calls = [];
  const audio = new Proxy({}, {
    get: (_, name) => (...args) => { calls.push([name, args]); },
  });
  const sync = new DocSync(audio, doc, 0);
  const undo = new UndoStack(doc, (tags) => sync.onDirty(tags));
  const slot = 0x0a;

  const patches = parsePatchesBlob(doc.ixmp.find((e) => e.instId === slot).blob);
  patches[0].pitchEnd = 0x1111;
  undo.apply(setInstPatchesOp(slot, writePatchesBlob(patches)));
  let up = calls.filter(([n]) => n === "uploadInstrumentPatches");
  assert.equal(up.length, 1);
  assert.equal(up[0][1][0], slot);
  assert.equal(parsePatchesBlob(up[0][1][1])[0].pitchEnd, 0x1111);

  undo.apply(setInstPatchesOp(slot, null));
  up = calls.filter(([n]) => n === "uploadInstrumentPatches");
  assert.equal(up.length, 2);
  assert.equal(up[1][1][1].length, 0, "clearing uploads an empty blob");

  undo.undo(); // restore the edit → re-upload
  up = calls.filter(([n]) => n === "uploadInstrumentPatches");
  assert.equal(up.length, 3);
  assert.equal(parsePatchesBlob(up[2][1][1])[0].pitchEnd, 0x1111);
});
