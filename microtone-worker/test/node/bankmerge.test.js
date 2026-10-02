// Bank merge (instrument import) — planImport / importBankOp against real
// corpus sources merged into a synthetic empty project (the New Project
// wizard's parsed shape).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud, parseIxmpSection } from "../../core/format/taud-parse.js";
import { SAMPLEINST_SIZE, SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp, setInstFieldOp } from "../../src/doc/ops.js";
import {
  planImport, bankInventory, splitNameTable, joinNameTable, buildIxmpSection,
  planCreateMeta, planDuplicateInstruments, duplicateInstrumentName,
} from "../../src/doc/bankmerge.js";
import {
  TaudInst, buildMetaRecord, makeMetaLayer, META_MAX_LAYERS,
} from "../../core/engine/inst.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const when = new Document(parseTaud(await readFile(corpusDir + "WHEN.taud")));
const e1m1 = new Document(parseTaud(await readFile(corpusDir + "M_E1M1.taud")));

/** Empty 32-channel project (the New Project wizard's parsed shape). */
function emptyProject({ image = null, projSections = [] } = {}) {
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  return new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: image ?? new Uint8Array(SAMPLEINST_SIZE),
    songs: [{
      numVoices: 32, bpm: 125, tickRate: 6, tuningBaseNote: 0x4500,
      tuningFreq: 440, globalFlags: 0, globalVolume: 128, mixingVolume: 48,
      patterns: [emptyPat], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections, ixmp: [],
    meta: { projectName: "test", songMeta: {} },
  });
}

test("name table helpers round-trip", () => {
  const payload = Uint8Array.from([0x61, 0x1e, 0x1e, 0x62, 0x63]); // "a", "", "bc"
  const parts = splitNameTable(payload);
  assert.equal(parts.length, 3);
  assert.deepEqual([...parts[2]], [0x62, 0x63]);
  assert.deepEqual([...joinNameTable(parts)], [...payload]);
  // trailing empties trim
  assert.deepEqual([...joinNameTable([...parts, new Uint8Array(0)])], [...payload]);
});

test("basic import: record verbatim except sample pointer; bytes land in pool", () => {
  const dest = emptyProject();
  const srcSlot = when.usedInstrumentSlots().find(
    (s) => !when.instruments[s].isMeta && when.instruments[s].sampleLength > 0);
  const plan = planImport(dest, when, [srcSlot]);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.insts.length, 1);
  const it = plan.insts[0];
  assert.equal(it.destSlot, 1); // first free note-addressable slot

  importBankOp(plan).apply(dest);

  const srcRec = when.instRecordBytes(srcSlot);
  const dstRec = dest.instRecordBytes(1);
  for (let i = 4; i < 256; i++) assert.equal(dstRec[i], srcRec[i], `record byte ${i}`);

  const inst = dest.instruments[1];
  const src = when.instruments[srcSlot];
  assert.equal(inst.sampleLength, src.sampleLength);
  assert.ok(Buffer.from(dest.sampleBin.subarray(inst.samplePtr, inst.samplePtr + inst.sampleLength))
    .equals(Buffer.from(when.sampleBin.subarray(src.samplePtr, src.samplePtr + src.sampleLength))));
  assert.deepEqual(dest.usedInstrumentSlots(), [1]);
});

test("re-import dedupes samples by content", () => {
  const dest = emptyProject();
  const srcSlot = when.usedInstrumentSlots().find(
    (s) => !when.instruments[s].isMeta && when.instruments[s].sampleLength > 0);
  const plan1 = planImport(dest, when, [srcSlot]);
  assert.ok(plan1.newSampleBytes > 0);
  importBankOp(plan1).apply(dest);

  const plan2 = planImport(dest, when, [srcSlot]);
  assert.ok(!plan2.error, plan2.error);
  assert.equal(plan2.newSampleBytes, 0, "second import allocates no pool bytes");
  assert.equal(plan2.dedupedSamples, 1);
  importBankOp(plan2).apply(dest);
  assert.equal(dest.instruments[2].samplePtr, dest.instruments[1].samplePtr);
});

test("meta import pulls layer deps, remaps 10-bit indices, zeroes unmapped", () => {
  const dest = emptyProject();
  const metaSlot = e1m1.usedInstrumentSlots().find((s) => e1m1.instruments[s].isMeta);
  const srcLayers = e1m1.instruments[metaSlot].metaLayers;
  const plan = planImport(dest, e1m1, [metaSlot]);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.insts.length, 1 + new Set(srcLayers.map((l) => l.instIdx)).size);
  // meta is the only top-level pick → slot 1; deps land 1023 downward
  const metaIt = plan.insts.find((it) => it.srcSlot === metaSlot);
  assert.equal(metaIt.destSlot, 1);
  for (const it of plan.insts) {
    if (it.srcSlot !== metaSlot) assert.ok(it.destSlot > 255, "layer dep in high slots");
  }

  importBankOp(plan).apply(dest);
  const meta = dest.instruments[1];
  assert.ok(meta.isMeta);
  assert.equal(meta.metaLayers.length, srcLayers.length);
  meta.metaLayers.forEach((l, i) => {
    assert.equal(l.instIdx, plan.slotMap.get(srcLayers[i].instIdx), `layer ${i} remap`);
    assert.equal(l.mixOctet, srcLayers[i].mixOctet);
    assert.equal(l.detune, srcLayers[i].detune);
    assert.equal(l.pitchStart, srcLayers[i].pitchStart);
    // layer instrument really exists in the destination
    const li = dest.instruments[l.instIdx];
    assert.ok(!li.isMeta && (li.sampleLength > 0 || li.extraPatches !== null));
  });
});

test("Ixmp blobs: pointers remapped, section round-trips, patches resolve", () => {
  const dest = emptyProject();
  const srcSlot = e1m1.usedInstrumentSlots().find(
    (s) => !e1m1.instruments[s].isMeta && (e1m1.instruments[s].extraPatches?.length ?? 0) > 0);
  const plan = planImport(dest, e1m1, [srcSlot]);
  assert.ok(!plan.error, plan.error);
  importBankOp(plan).apply(dest);

  const srcPatches = e1m1.instruments[srcSlot].extraPatches;
  const dstPatches = dest.instruments[1].extraPatches;
  assert.equal(dstPatches.length, srcPatches.length);
  dstPatches.forEach((p, i) => {
    const sp = srcPatches[i];
    assert.equal(p.sampleLength, sp.sampleLength);
    assert.equal(p.pitchStart, sp.pitchStart);
    assert.equal(p.volumeEnd, sp.volumeEnd);
    if (p.sampleLength > 0) {
      assert.ok(Buffer.from(dest.sampleBin.subarray(p.samplePtr, p.samplePtr + p.sampleLength))
        .equals(Buffer.from(e1m1.sampleBin.subarray(sp.samplePtr, sp.samplePtr + sp.sampleLength))),
        `patch ${i} sample content`);
    }
  });

  // Ixmp section rebuilt and parseable back to the same entries
  const sec = dest.projSections.find((s) => s.fourcc === "Ixmp");
  assert.ok(sec);
  const entries = parseIxmpSection(sec.payload);
  assert.equal(entries.length, dest.ixmp.length);
  assert.equal(entries[0].instId, 1);
  assert.equal(entries[0].count, dest.ixmp[0].count);
  assert.ok(Buffer.from(entries[0].blob).equals(Buffer.from(dest.ixmp[0].blob)));
});

test("names: INam splices by slot, SNam follows the census", () => {
  const dest = emptyProject();
  const named = e1m1.usedInstrumentSlots().filter(
    (s) => !e1m1.instruments[s].isMeta && e1m1.instrumentName(s));
  const picks = named.slice(0, 3);
  const plan = planImport(dest, e1m1, picks);
  assert.ok(!plan.error, plan.error);
  importBankOp(plan).apply(dest);
  picks.forEach((srcSlot, i) => {
    assert.equal(dest.instrumentName(plan.slotMap.get(srcSlot)), e1m1.instrumentName(srcSlot));
  });
  // every dest sample that came from a named source sample keeps its name
  const srcNameByKey = new Map();
  e1m1.sampleList().forEach((e) => srcNameByKey.set(`${e.ptr}:${e.len}`, e.name));
  for (const it of plan.insts) {
    const inst = dest.instruments[it.destSlot];
    if (inst.isMeta || inst.sampleLength === 0) continue;
    const src = e1m1.instruments[it.srcSlot];
    const want = srcNameByKey.get(`${src.samplePtr}:${src.sampleLength}`) ?? "";
    const got = dest.sampleList().find((e) => e.ptr === inst.samplePtr && e.len === inst.sampleLength);
    assert.equal(got.name, want, `sample name for slot ${it.destSlot}`);
  }
});

test("undo restores toBytes byte-exact; redo re-applies byte-exact", () => {
  const dest = emptyProject();
  // seed with one instrument so undo has non-trivial surroundings
  importBankOp(planImport(dest, when, [when.usedInstrumentSlots()[0]])).apply(dest);
  const before = Buffer.from(dest.toBytes());

  const undo = new UndoStack(dest);
  const metaSlot = e1m1.usedInstrumentSlots().find((s) => e1m1.instruments[s].isMeta);
  const ixmpSlot = e1m1.usedInstrumentSlots().find(
    (s) => !e1m1.instruments[s].isMeta && (e1m1.instruments[s].extraPatches?.length ?? 0) > 0);
  const plan = planImport(dest, e1m1, [metaSlot, ixmpSlot]);
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const after = Buffer.from(dest.toBytes());
  assert.ok(!after.equals(before));

  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(dest.toBytes()).equals(after), "redo byte-exact");
  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "second undo byte-exact");
});

test("import into a REAL corpus project: undo byte-exact (quirk bits survive)", () => {
  // WHEN's image carries record bytes outside the decode masks (e.g. byte 173
  // & ~0x1f); only EDITED slots may be re-encoded or those bits are lost.
  const dest = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const before = Buffer.from(dest.toBytes());
  const undo = new UndoStack(dest);
  const metaSlot = e1m1.usedInstrumentSlots().find((s) => e1m1.instruments[s].isMeta);
  const plan = planImport(dest, e1m1, [metaSlot]);
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const after = Buffer.from(dest.toBytes());
  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(dest.toBytes()).equals(after), "redo byte-exact");
});

test("full round-trip: imported doc re-parses with identical instruments", () => {
  const dest = emptyProject();
  const picks = e1m1.usedInstrumentSlots().slice(0, 6);
  const plan = planImport(dest, e1m1, picks);
  assert.ok(!plan.error, plan.error);
  importBankOp(plan).apply(dest);

  const re = new Document(parseTaud(dest.toBytes()));
  assert.deepEqual(re.usedInstrumentSlots(), dest.usedInstrumentSlots());
  for (const s of dest.usedInstrumentSlots()) {
    assert.ok(Buffer.from(re.instRecordBytes(s)).equals(Buffer.from(dest.instRecordBytes(s))), `slot ${s}`);
    assert.equal(re.instrumentName(s), dest.instrumentName(s));
  }
  assert.equal(re.ixmp.length, dest.ixmp.length);
  assert.deepEqual(re.sampleList().map((e) => e.name), dest.sampleList().map((e) => e.name));
});

test("slot budget: full 1..255 range errors for top-level picks", () => {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  for (let s = 1; s <= 255; s++) image[SAMPLEBIN_SIZE + s * 256 + 6] = 1; // any nonzero byte
  const dest = emptyProject({ image });
  const plan = planImport(dest, when, [when.usedInstrumentSlots()[0]]);
  assert.match(plan.error ?? "", /note-addressable/);
});

test("inventory lists metas and marks layer children", () => {
  const inv = bankInventory(e1m1);
  assert.equal(inv.length, e1m1.usedInstrumentSlots().length);
  const metas = inv.filter((e) => e.isMeta);
  assert.equal(metas.length, 4);
  const children = inv.filter((e) => e.layerOf.length > 0);
  assert.ok(children.length > 0);
  for (const c of children) assert.ok(c.layerOf.every((m) => e1m1.instruments[m].isMeta));
  const withSample = inv.find((e) => !e.isMeta && e.sampleBytes > 0);
  assert.ok(withSample);
});

test("buildIxmpSection is the exact inverse of parseIxmpSection", () => {
  const sec = e1m1.projSections.find((s) => s.fourcc === "Ixmp");
  const entries = parseIxmpSection(sec.payload);
  assert.ok(Buffer.from(buildIxmpSection(entries)).equals(Buffer.from(sec.payload)));
});

// ── item 72: build a metainstrument out of existing instruments ──

test("buildMetaRecord round-trips through TaudInst.loadRecord", () => {
  const layers = [
    makeMetaLayer(0x101, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(0x3ff, 0, -12345, 0x1234, 0x5678, 3, 60),   // 10-bit idx + negative detune
    makeMetaLayer(0x0002, 255, 32767, 0xffff, 0xffff, 63, 63), // extremes
  ];
  const inst = new TaudInst(7);
  inst.loadRecord(buildMetaRecord(layers, { strict: true }));
  assert.equal(inst.isMeta, true);
  assert.equal(inst.metaStrict, true);
  assert.equal(inst.metaLayers.length, 3);
  for (let i = 0; i < layers.length; i++) {
    for (const k of ["instIdx", "mixOctet", "detune", "pitchStart", "pitchEnd", "volStart", "volEnd"]) {
      assert.equal(inst.metaLayers[i][k], layers[i][k], `layer ${i} ${k}`);
    }
  }
  // Non-strict + percussion flags ride in the same byte without disturbing the
  // 0xFFFF metainstrument sentinel.
  const plain = new TaudInst(7);
  plain.loadRecord(buildMetaRecord(layers, { percussion: true }));
  assert.equal(plain.metaStrict, false);
  assert.equal(plain.isMeta, true);
});

test("planCreateMeta copies picks to $100+ and layers them, originals intact", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 3);
  const before = picks.map((s) => doc.instRecordBytes(s));
  const censusBefore = doc.sampleList().map((e) => `${e.ptr}:${e.len}`);
  const poolBefore = Uint8Array.from(doc.sampleBin);

  const plan = planCreateMeta(doc, picks, "Stack");
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.samples.length, 0);          // no pool bytes spent
  assert.equal(plan.writeSnam, false);           // census unchanged → SNam verbatim
  assert.ok(plan.metaSlot >= 1 && plan.metaSlot <= 255);
  assert.equal(plan.childSlots.length, picks.length);
  for (const c of plan.childSlots) assert.ok(c >= 0x100 && c <= 0x3ff, `child $${c.toString(16)}`);

  const undo = new UndoStack(doc);
  undo.apply(importBankOp(plan));

  // The meta layers the copies, in pick order, at unity mix over the full grid.
  const meta = doc.instruments[plan.metaSlot];
  assert.equal(meta.isMeta, true);
  assert.deepEqual(meta.metaLayers.map((l) => l.instIdx), plan.childSlots);
  for (const l of meta.metaLayers) {
    assert.equal(l.mixOctet, 159);
    assert.equal(l.detune, 0);
    assert.deepEqual([l.pitchStart, l.pitchEnd, l.volStart, l.volEnd], [0x0000, 0xffff, 0, 63]);
  }
  assert.equal(doc.instrumentName(plan.metaSlot), "Stack");

  // Each copy is byte-identical to its source, which is untouched and still
  // selectable; the sample pool and census never moved.
  picks.forEach((src, i) => {
    const child = plan.childSlots[i];
    assert.deepEqual([...doc.instRecordBytes(child)], [...before[i]], `copy of $${src.toString(16)}`);
    assert.deepEqual([...doc.instRecordBytes(src)], [...before[i]], `original $${src.toString(16)}`);
    assert.equal(doc.instrumentName(child), doc.instrumentName(src));
    assert.ok(doc.selectableInstrumentSlots().includes(src));
  });
  assert.ok(Buffer.from(doc.sampleBin).equals(Buffer.from(poolBefore)));
  assert.deepEqual(doc.sampleList().map((e) => `${e.ptr}:${e.len}`), censusBefore);
  // The copies are layer children — not selectable (item 59).
  const sel = doc.selectableInstrumentSlots();
  for (const c of plan.childSlots) assert.ok(!sel.includes(c));
  assert.ok(sel.includes(plan.metaSlot));
});

test("planCreateMeta carries a pick's Ixmp patches onto its copy", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "M_E1M1.taud")));
  // M_E1M1's patch carriers are meta children — reach one through its meta.
  const metaSlot = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const child = doc.instruments[metaSlot].metaLayers
    .map((l) => l.instIdx & 0x3ff)
    .find((c) => (doc.instruments[c].extraPatches?.length ?? 0) > 0);
  const patches = doc.instruments[child].extraPatches.length;

  const plan = planCreateMeta(doc, [child], "Copy");
  assert.ok(!plan.error, plan.error);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(plan));
  const copy = plan.childSlots[0];
  assert.equal(doc.instruments[copy].extraPatches.length, patches);
  assert.equal(doc.instruments[child].extraPatches.length, patches); // source intact
  assert.ok(doc.ixmp.some((e) => (e.instId & 0x3ff) === copy));
});

test("planCreateMeta refuses metas, empty picks and over-long layer stacks", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "M_E1M1.taud")));
  const metaSlot = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  // Nesting is impossible: triggerMetaOrNote resolves layers via triggerNote.
  assert.match(planCreateMeta(doc, [metaSlot], "x").error ?? "", /metainstrument/i);
  assert.match(planCreateMeta(doc, [], "x").error ?? "", /No instruments selected/);
  const many = new Array(META_MAX_LAYERS + 1).fill(0).map((_, i) => i + 1)
    .filter((s) => doc.usedInstrumentSlots().includes(s));
  if (many.length > META_MAX_LAYERS) {
    assert.match(planCreateMeta(doc, many, "x").error ?? "", /at most/);
  }
});

test("importBankOp undo of a created meta restores the file byte-exactly", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const baseline = doc.toBytes();
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  const plan = planCreateMeta(doc, picks, "Layered");
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(plan));
  assert.notEqual(Buffer.compare(Buffer.from(doc.toBytes()), Buffer.from(baseline)), 0);
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo is byte-exact");
  undo.redo();
  assert.equal(doc.instruments[plan.metaSlot].isMeta, true);
});

// ── item 114: duplicate an instrument already in the project ──

test("duplicateInstrumentName: ' (N)' suffix, existing trailing numbers kept", () => {
  const taken = new Set(["Piano", "Piano (2)", "Synth Strings 1"]);
  assert.equal(duplicateInstrumentName(taken, "Piano"), "Piano (3)");
  assert.equal(duplicateInstrumentName(taken, "Piano (2)"), "Piano (3)", "the stem, not a second suffix");
  // "Synth Strings 2" is a DIFFERENT GM instrument — the ordinal is part of the name.
  assert.equal(duplicateInstrumentName(taken, "Synth Strings 1"), "Synth Strings 1 (2)");
  assert.equal(duplicateInstrumentName(taken, ""), "", "an unnamed instrument stays unnamed");
});

test("duplicate an Ixmp instrument: patches copied, samples SHARED", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "4THSYM.taud")));
  const baseline = Buffer.from(doc.toBytes());
  const src = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].extraPatches?.length > 0);
  const censusBefore = doc.sampleList().map((e) => `${e.ptr}:${e.len}:${e.name}`);
  const poolBefore = Buffer.from(doc.sampleBin);

  const undo = new UndoStack(doc);
  const plan = planDuplicateInstruments(doc, [src]);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.samples.length, 0, "a duplicate writes no pool bytes");
  assert.equal(plan.writeSnam, false, "the census is unchanged, so SNam must not be rewritten");
  undo.apply(importBankOp(plan));

  const copy = plan.duplicates[0].destSlot;
  assert.ok(copy >= 1 && copy <= 0xff, "copies stay note-addressable");
  assert.ok(Buffer.from(doc.instRecordBytes(copy)).equals(Buffer.from(doc.instRecordBytes(src))),
    "the record is copied verbatim — same sample pointers");
  assert.equal(doc.instruments[copy].extraPatches.length, doc.instruments[src].extraPatches.length);
  assert.equal(doc.instrumentName(copy), doc.instrumentName(src) + " (2)");
  assert.ok(Buffer.from(doc.sampleBin).equals(poolBefore), "the sample pool is untouched");
  assert.deepEqual(doc.sampleList().map((e) => `${e.ptr}:${e.len}:${e.name}`), censusBefore,
    "same spans, same order, same names");

  // The Ixmp SECTION (not just doc.ixmp) has to carry the copy, or a reload loses it.
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.instruments[copy].extraPatches.length, doc.instruments[src].extraPatches.length);
  assert.equal(reloaded.instrumentName(copy), doc.instrumentName(copy));

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(baseline), "undo is byte-exact");
});

test("duplicating twice counts up, and the copy is independently editable", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const src = doc.selectableInstrumentSlots()[0];
  const undo = new UndoStack(doc);
  const first = planDuplicateInstruments(doc, [src]);
  undo.apply(importBankOp(first));
  const second = planDuplicateInstruments(doc, [src]);
  undo.apply(importBankOp(second));
  const [a, b] = [first.duplicates[0].destSlot, second.duplicates[0].destSlot];
  assert.notEqual(a, b);
  assert.equal(doc.instrumentName(a), doc.instrumentName(src) + " (2)");
  assert.equal(doc.instrumentName(b), doc.instrumentName(src) + " (3)");

  // The point of the feature: change one field on the copy, original unmoved.
  const fadeBefore = doc.instruments[src].volumeFadeoutLow;
  undo.apply(setInstFieldOp(a, "volumeFadeoutLow", (fadeBefore + 7) & 0xff));
  assert.equal(doc.instruments[src].volumeFadeoutLow, fadeBefore);
  assert.notEqual(doc.instruments[a].volumeFadeoutLow, fadeBefore);
});

test("duplicating a metainstrument deep-copies its layer children, links intact", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "M_E1M1.taud")));
  const baseline = Buffer.from(doc.toBytes());
  const src = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const srcLayers = doc.instruments[src].metaLayers.map((l) => l.instIdx);

  const undo = new UndoStack(doc);
  const plan = planDuplicateInstruments(doc, [src]);
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const copy = plan.duplicates[0].destSlot;
  const copyLayers = doc.instruments[copy].metaLayers.map((l) => l.instIdx);

  assert.equal(copyLayers.length, srcLayers.length);
  assert.ok(copyLayers.every((s) => s >= 0x100), "children land in the hidden $100+ range");
  assert.ok(copyLayers.every((s) => !srcLayers.includes(s)), "no layer still points at the original's child");
  // One child per DISTINCT source child: item 113's linking survives the copy.
  assert.equal(new Set(copyLayers).size, new Set(srcLayers).size);
  srcLayers.forEach((s, i) => {
    srcLayers.forEach((t, j) => {
      assert.equal(copyLayers[i] === copyLayers[j], s === t, "sharing pattern preserved");
    });
  });
  for (const [i, child] of copyLayers.entries()) {
    assert.ok(Buffer.from(doc.instRecordBytes(child))
      .equals(Buffer.from(doc.instRecordBytes(srcLayers[i]))), "child record copied verbatim");
    assert.equal(doc.instrumentName(child), doc.instrumentName(srcLayers[i]), "children keep their name");
  }
  assert.ok(!doc.selectableInstrumentSlots().some((s) => copyLayers.includes(s)),
    "the copies' children stay out of the instrument list");
  assert.deepEqual(doc.instruments[src].metaLayers.map((l) => l.instIdx), srcLayers, "source untouched");

  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.deepEqual(reloaded.instruments[copy].metaLayers.map((l) => l.instIdx), copyLayers);

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(baseline), "undo is byte-exact");
});

test("planDuplicateInstruments: several at once, and the empty/exhausted cases", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const picks = doc.selectableInstrumentSlots().slice(0, 3);
  const plan = planDuplicateInstruments(doc, picks);
  assert.deepEqual(plan.duplicates.map((d) => d.srcSlot), picks, "requested order kept");
  assert.equal(new Set(plan.duplicates.map((d) => d.destSlot)).size, picks.length, "distinct slots");
  assert.match(planDuplicateInstruments(doc, []).error ?? "", /No instruments selected/);
  assert.match(planDuplicateInstruments(doc, [0x3ff]).error ?? "", /No instruments selected/,
    "an empty slot is not a source");

  // Every note-addressable slot occupied → nowhere for a copy to go.
  const full = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const rec = full.instRecordBytes(full.selectableInstrumentSlots()[0]);
  for (let s = 1; s <= 0xff; s++) { full.instruments[s].loadRecord(rec); full.markInstUsed(s); }
  assert.match(planDuplicateInstruments(full, [1]).error ?? "", /No free instrument slots/);
});
