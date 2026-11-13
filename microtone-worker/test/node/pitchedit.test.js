// The editor's side of the pitch extension (item 319, file format §9.18): every
// pitch field of an instrument a format-3 project holds is a 65536-TET value —
// the sixteen-bit field and its `IPit` extension byte — and the document keeps
// the section in step with its instruments through every edit, undo, save,
// bank copy and renumber. The FM Easy tab writes a whole multiplier into an
// operator's ratio this way instead of into its oscillator's rate.
//
// The reader (both engines) is pitchext.test.js's; this file is the writer's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Document } from "../../src/doc/document.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { UndoStack } from "../../src/doc/undo.js";
import {
  setInstFieldOp, setMetaRecordOp, setMetaLayersOp, withPitchExtOp, importBankOp, renumberInstrumentOp,
} from "../../src/doc/ops.js";
import { metaLayers, metaRecordOf, moveLayer, patchLayer, duplicateLayer, removeLayer } from "../../src/doc/metaedit.js";
import { patchLow, patchHigh, patchDetune, patchLowFields, patchHighFields, patchDetuneFields, pitchPatchesOf } from "../../src/doc/pitchedit.js";
import {
  layerDetune, layerLow, layerHigh, layerDetuneFields, layerLowFields, layerHighFields,
  instDetune, splitOffset, baseExtWith, HIGH_FRACTION,
} from "../../src/doc/pitchedit.js";
import { planCreateMeta, planDuplicateInstruments, planImport, planEasyFm } from "../../src/doc/bankmerge.js";
import { planRenumberInstrument, planDeleteSample, planDeleteInstruments } from "../../src/doc/cleanup.js";
import { cleanupBankOp, deleteInstrumentOp, setInstPatchesOp, rebindBaseStereoPatchOp } from "../../src/doc/ops.js";
import { makeInstPatch, writePatchesBlob } from "../../core/engine/inst.js";
import {
  easyDecode, easyNewModel, easyPatchOp, easyRackOf, easySplitRatio, easyJoinRatio, easyFineRange,
  easyMultiplierUnits, easyRatioOf, easyOscOf,
} from "../../src/doc/fmeasy.js";
import { fmOperators, fmProgramOf } from "../../src/doc/fmedit.js";
import {
  extOfDelta, splitPitchDelta, pitchExtGroupsOf, pitchExtApplies,
} from "../../core/format/pitch-ext-section.js";
import { pitchExtDelta, pitchExtDeltaHigh } from "../../core/engine/inst.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import { widePitchMap, centsMap } from "../../src/ui/spinmaps.js";
import { pitchTablePresets, finePreset } from "../../core/tuning/pitchtables.js";

setSamplingRate(32000);

const demo = () => {
  const doc = new Document(parseTaud(readFileSync(
    new URL("../../assets/demo_projects/Daisy_bell.taud", import.meta.url))));
  doc.upgradeToWideCells?.();
  return doc;
};
const reload = (doc) => new Document(parseTaud(doc.toBytes()));
const sampled = (doc) => doc.selectableInstrumentSlots().filter((s) => {
  const i = doc.instruments[s];
  return !i.isMeta && !i.isHighMeta && i.sampleLength > 0;
});

/** A layered instrument of three layers over the demo's first sampled one. */
function stack() {
  const doc = demo();
  const p = planCreateMeta(doc, [{ slot: sampled(doc)[0], count: 3 }], "Stack");
  importBankOp(p).apply(doc);
  const slot = p.insts.find((it) => it.topLevel).destSlot;
  return { doc, slot };
}

/** Write `layers` into the meta in `slot` through the undo stack. */
function writeLayers(undo, doc, slot, layers) {
  undo.apply(setMetaLayersOp(slot, metaRecordOf(doc.instruments[slot], layers), layers));
}

// ── the codec's way back ────────────────────────────────────────────────────

test("a delta and its extension byte are inverses, the high bound's complemented fraction too", () => {
  for (let b = 0; b < 256; b++) {
    assert.equal(extOfDelta(pitchExtDelta(b)), b);
    assert.equal(extOfDelta(pitchExtDeltaHigh(b), true), b);
  }
  assert.equal(extOfDelta(1 / 32), 1, "finer than a sixteenth is rounded to one");
  assert.throws(() => extOfDelta(9 * 65536), RangeError, "past the octave nibble");
  const { field, delta } = splitPitchDelta(-0x8000 - 1 / 16, { signed: true });
  assert.equal(field + delta, -0x8000 - 1 / 16);
});

// ── values on a layer table ─────────────────────────────────────────────────

test("a layer's detune, range low and range high take sixteenths, and a save keeps them", () => {
  const { doc, slot } = stack();
  const undo = new UndoStack(doc);
  let layers = metaLayers(doc.instruments[slot]);
  layers = patchLayer(layers, 0, layerDetuneFields(layers[0], 1365 + 5 / 16));
  layers = patchLayer(layers, 1, { ...layerLowFields(0x5155 + 8 / 16), ...layerHighFields(0x6000 + 3 / 16) });
  layers = patchLayer(layers, 2, layerDetuneFields(layers[2], 3 * 65536 + 12)); // +51 octaves
  writeLayers(undo, doc, slot, layers);

  const check = (d, what) => {
    const ls = d.instruments[slot].metaLayers;
    assert.equal(layerDetune(ls[0]), 1365 + 5 / 16, `${what}: detune`);
    assert.equal(layerLow(ls[1]), 0x5155 + 8 / 16, `${what}: low`);
    assert.equal(layerHigh(ls[1]), 0x6000 + 3 / 16, `${what}: high, the last pitch inside`);
    assert.equal(layerDetune(ls[2]), 3 * 65536 + 12, `${what}: past sixteen bits`);
    assert.equal(layerHigh(ls[0]), 0xffff + HIGH_FRACTION, `${what}: an unextended high bound covers its whole unit`);
  };
  check(doc, "edited");
  assert.ok(doc.pitchExt() !== null, "the section is there");
  check(reload(doc), "saved and opened again");
});

test("a reorder, a duplicate and a removal take each layer's extension with it", () => {
  const { doc, slot } = stack();
  const undo = new UndoStack(doc);
  let layers = metaLayers(doc.instruments[slot]);
  layers = layers.map((l, i) => ({ ...l, ...layerDetuneFields(l, i * 100 + (i + 1) / 16) }));
  writeLayers(undo, doc, slot, layers);
  const want = (ls) => ls.map(layerDetune);

  layers = moveLayer(metaLayers(doc.instruments[slot]), 2, -2);
  writeLayers(undo, doc, slot, layers);
  assert.deepEqual(want(doc.instruments[slot].metaLayers), [200 + 3 / 16, 1 / 16, 100 + 2 / 16]);

  layers = duplicateLayer(metaLayers(doc.instruments[slot]), 0);
  writeLayers(undo, doc, slot, layers);
  assert.deepEqual(want(doc.instruments[slot].metaLayers), [200 + 3 / 16, 200 + 3 / 16, 1 / 16, 100 + 2 / 16]);

  layers = removeLayer(metaLayers(doc.instruments[slot]), 1);
  writeLayers(undo, doc, slot, layers);
  assert.deepEqual(want(reload(doc).instruments[slot].metaLayers), [200 + 3 / 16, 1 / 16, 100 + 2 / 16]);
});

test("undo and redo put the section back exactly, and the deltas with it", () => {
  const { doc, slot } = stack();
  const undo = new UndoStack(doc);
  const before = doc.pitchExt();
  const layers = metaLayers(doc.instruments[slot]);
  writeLayers(undo, doc, slot, patchLayer(layers, 0, layerDetuneFields(layers[0], 7 / 16)));
  const after = doc.pitchExt();
  assert.notEqual(after, null);
  undo.undo();
  assert.equal(doc.pitchExt(), before);
  assert.equal(layerDetune(doc.instruments[slot].metaLayers[0]), 0);
  undo.redo();
  assert.deepEqual(doc.pitchExt(), after);
  assert.equal(layerDetune(doc.instruments[slot].metaLayers[0]), 7 / 16);
});

test("an edit that rewrites a guarded field switches the entry off, and the save retires it", () => {
  const { doc, slot } = stack();
  const undo = new UndoStack(doc);
  const layers = metaLayers(doc.instruments[slot]);
  writeLayers(undo, doc, slot, patchLayer(layers, 0, layerDetuneFields(layers[0], 9 / 16)));
  // An edit that does not say what became of the extension: a bare record.
  const bare = patchLayer(metaLayers(doc.instruments[slot]), 1, { detune: 700 });
  undo.apply(setMetaRecordOp(slot, metaRecordOf(doc.instruments[slot], bare)));
  assert.equal(layerDetune(doc.instruments[slot].metaLayers[0]), 0, "off, not misapplied");
  assert.equal(reload(doc).pitchExt(), null, "the save drops the outdated entry");
  undo.undo();
  assert.equal(layerDetune(doc.instruments[slot].metaLayers[0]), 9 / 16, "and undo brings it back");
});

test("an edit that names no group carries the entry through ({}); an instrument's own fields take sixteenths", () => {
  const doc = demo();
  const slot = sampled(doc)[0];
  const undo = new UndoStack(doc);
  const inst = () => doc.instruments[slot];
  const { field, ext } = splitOffset(-700 - 3 / 16);
  undo.apply(withPitchExtOp(setInstFieldOp(slot, "sampleDetune", field & 0xffff), slot,
    { base: baseExtWith(inst(), 0, ext) }));
  assert.equal(instDetune(inst()), -700 - 3 / 16);
  // The pitch-pan centre is guarded too: moving it with {} keeps the detune's.
  undo.apply(withPitchExtOp(setInstFieldOp(slot, "pitchPanCentre", 0x6000), slot, {}));
  assert.equal(instDetune(inst()), -700 - 3 / 16);
  assert.equal(instDetune(reload(doc).instruments[slot]), -700 - 3 / 16);
  // …where a bare edit of it would not.
  undo.apply(setInstFieldOp(slot, "pitchPanCentre", 0x6100));
  assert.equal(instDetune(inst()), -701, "the field alone: −701 + 13/16 was the value");
});

// ── the bank ────────────────────────────────────────────────────────────────

test("a duplicate, an import into another project and a renumber carry the entry", () => {
  const { doc, slot } = stack();
  const undo = new UndoStack(doc);
  const layers = metaLayers(doc.instruments[slot]);
  writeLayers(undo, doc, slot, patchLayer(layers, 1, layerDetuneFields(layers[1], 2400 + 11 / 16)));

  const dup = planDuplicateInstruments(doc, [slot]);
  assert.ok(!dup.error, dup.error);
  undo.apply(importBankOp(dup));
  const copy = dup.insts.find((it) => it.srcSlot === slot).destSlot;
  assert.equal(layerDetune(doc.instruments[copy].metaLayers[1]), 2400 + 11 / 16, "the copy");

  const other = demo();
  const imp = planImport(other, doc, [slot]);
  assert.ok(!imp.error, imp.error);
  importBankOp(imp).apply(other);
  const there = imp.slotMap.get(slot);
  assert.equal(layerDetune(reload(other).instruments[there].metaLayers[1]), 2400 + 11 / 16, "the import");

  const free = [...Array(255).keys()].map((k) => k + 1).find((s) => !doc.usedInstrumentSlots().includes(s));
  const ren = planRenumberInstrument(doc, slot, free);
  assert.ok(!ren.error, ren.error);
  undo.apply(renumberInstrumentOp(ren));
  assert.equal(layerDetune(reload(doc).instruments[free].metaLayers[1]), 2400 + 11 / 16, "the renumber");
  undo.undo();
  assert.equal(layerDetune(doc.instruments[slot].metaLayers[1]), 2400 + 11 / 16, "and back");
});

// ── edits that reshape a list: the survivors keep their extensions ─────────

/** A demo with many sampled instruments, and two of them on different samples. */
function twoSampled() {
  const doc = new Document(parseTaud(readFileSync(
    new URL("../../assets/demo_projects/Temjin_speaki.taud", import.meta.url))));
  const list = sampled(doc);
  const key = (s) => `${doc.instruments[s].samplePtr}:${doc.instruments[s].sampleLength}`;
  return { doc, a: list[0], b: list.find((s) => key(s) !== key(list[0])) };
}

/** A sampled instrument of a demo with three zones, each pitched to the
 *  sixteenth: [0] and [2] on its own sample, [1] on `other`'s. */
function zoned() {
  const { doc, a: slot, b: otherSlot } = twoSampled();
  const inst = doc.instruments[slot], other = doc.instruments[otherSlot];
  const zone = (src, lo, hi, det) => Object.assign(makeInstPatch({
    volumeStart: 0, volumeEnd: 63, samplePtr: src.samplePtr, sampleLength: src.sampleLength,
    loopStart: src.sampleLoopStart, loopEnd: src.sampleLoopEnd, samplingRate: src.samplingRate,
    loopMode: src.loopMode & 7,
  }), patchLowFields(lo), patchHighFields(hi), patchDetuneFields(det));
  const patches = [
    zone(inst, 0x20, 0x4fff + 7 / 16, 3 / 16),
    zone(other, 0x4fff + 8 / 16, 0x5fff + 15 / 16, -5 / 16),
    zone(inst, 0x6000, 0xffff + 15 / 16, 100 + 9 / 16),
  ];
  const undo = new UndoStack(doc);
  undo.apply(withPitchExtOp(setInstPatchesOp(slot, writePatchesBlob(patches)), slot, { patches: pitchPatchesOf(patches) }));
  return { doc, undo, slot, other };
}
const zones = (doc, slot) => (doc.instruments[slot].extraPatches ?? []).map((p) => [patchLow(p), patchHigh(p), patchDetune(p)]);

test("zones pitched to the sixteenth keep it through a reload", () => {
  const { doc, slot } = zoned();
  const want = [[0x20, 0x4fff + 7 / 16, 3 / 16], [0x4fff + 8 / 16, 0x5fff + 15 / 16, -5 / 16], [0x6000, 0xffff + 15 / 16, 100 + 9 / 16]];
  assert.deepEqual(zones(doc, slot), want);
  assert.deepEqual(zones(reload(doc), slot), want);
});

test("deleting a sample drops its zones; the zones left keep their extensions", () => {
  const { doc, undo, slot, other } = zoned();
  const plan = planDeleteSample(doc, { ptr: other.samplePtr, len: other.sampleLength });
  assert.ok(!plan.error, plan.error);
  undo.apply(cleanupBankOp(plan));
  assert.deepEqual(zones(reload(doc), slot), [[0x20, 0x4fff + 7 / 16, 3 / 16], [0x6000, 0xffff + 15 / 16, 100 + 9 / 16]]);
  undo.undo();
  assert.equal(zones(doc, slot).length, 3, "and undo puts all three back");
  assert.equal(zones(doc, slot)[1][2], -5 / 16);
});

test("adopting a stereo sample adds the base stereo zone; the others keep theirs, and it mirrors the detune's", () => {
  const { doc, undo, slot } = zoned();
  const inst = doc.instruments[slot];
  const { field, ext } = splitOffset(-7 - 3 / 16);
  undo.apply(withPitchExtOp(setInstFieldOp(slot, "sampleDetune", field & 0xffff), slot, { base: baseExtWith(inst, 0, ext) }));
  const op = rebindBaseStereoPatchOp(doc, slot, {
    samplePtr: inst.samplePtr, sampleLength: inst.sampleLength, playStart: 0,
    loopStart: inst.sampleLoopStart, loopEnd: inst.sampleLoopEnd, samplingRate: inst.samplingRate,
    sampleDetune: inst.sampleDetune, loopMode: inst.loopMode & 7,
  }, [inst.samplePtr + 1], 0);
  undo.apply(op);
  const z = zones(reload(doc), slot);
  assert.equal(z.length, 4);
  assert.deepEqual(z.slice(0, 3).map((x) => x[2]), [3 / 16, -5 / 16, 100 + 9 / 16], "the zones that were there");
  assert.equal(z[3][2], -7 - 3 / 16, "the stereo zone plays the instrument's own detune, sixteenths and all");
  assert.equal(instDetune(reload(doc).instruments[slot]), -7 - 3 / 16, "…which the instrument keeps");
});

test("deleting an instrument a stack layers repacks the stack; its other layers keep their extensions", () => {
  const { doc, a, b } = twoSampled();
  const p = planCreateMeta(doc, [{ slot: a, count: 1 }, { slot: b, count: 2 }], "Stack");
  importBankOp(p).apply(doc);
  const slot = p.insts.find((it) => it.topLevel).destSlot;
  const undo = new UndoStack(doc);
  let layers = metaLayers(doc.instruments[slot]);
  layers = layers.map((l, i) => ({ ...l, ...layerDetuneFields(l, 100 * i + (i + 1) / 16) }));
  writeLayers(undo, doc, slot, layers);
  const childA = layers[0].instIdx & 0x3ff;
  const del = planDeleteInstruments(doc, [childA]);
  assert.ok(!del.error, del.error);
  undo.apply(deleteInstrumentOp(del));
  const back = reload(doc).instruments[slot].metaLayers;
  assert.equal(back.length, 2);
  assert.deepEqual(back.map(layerDetune), [100 + 2 / 16, 200 + 3 / 16]);
});

// ── FM Easy Mode: the multiplier in the ratio ───────────────────────────────

test("a ratio splits into the nearest multiplier and a detune whose reach keeps it", () => {
  for (const m of [{ k: 1, mult: 0 }, { k: 3, mult: 0 }, { k: 31, mult: 0 }, { k: 1, mult: -8 }, { k: 1, mult: 8 }]) {
    const u = easyMultiplierUnits(m);
    const [lo, hi] = easyFineRange(m);
    assert.deepEqual(easySplitRatio(u + lo).m, m);
    assert.deepEqual(easySplitRatio(u + hi).m, m);
    assert.equal(easyJoinRatio(m, 1e6), u + hi, "a detune is kept inside its reach");
  }
  assert.equal(easyMultiplierUnits({ k: 3, mult: 0 }), 6492, "4096·log₂3 to the sixteenth");
  assert.deepEqual(easySplitRatio(6492 + 10), { m: { k: 3, mult: 0 }, fine: 10 });
});

/** Play C-4 on `slot` for a few chunks, the document's sections installed. */
function play(doc, slot) {
  const eng = new TaudEngine();
  eng.sampleBin.set(doc.sampleBin);
  for (const s of doc.usedInstrumentSlots()) eng.uploadInstrument(s, doc.instRecordBytes(s));
  eng.setPitchExt(doc.pitchExt());
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = slot;
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  for (let i = 0; i < 2; i++) eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
  return eng;
}

test("×3 and ×256 go into the operator's ratio, its oscillator left plain, and sound so", () => {
  const doc = demo();
  const a = planEasyFm(doc, null, easyNewModel(2), "Easy");
  importBankOp(a).apply(doc);
  const slot = a.metaSlot;
  const undo = new UndoStack(doc);
  const model = () => easyDecode(fmOperators(doc.instruments[slot]), fmProgramOf(doc.instruments[slot])).model;
  const write = (i, value) => {
    const m = model();
    const next = easyPatchOp(m, i, layerDetuneFields(m.ops[i], value));
    const rack = easyRackOf(doc.instruments[slot], next);
    undo.apply(setMetaLayersOp(slot, rack.record, rack.ops));
  };
  const oscBefore = doc.instRecordBytes(model().ops[1].instIdx & 0x3ff);
  write(1, easyJoinRatio({ k: 3, mult: 0 }, 0));
  assert.deepEqual(doc.instRecordBytes(model().ops[1].instIdx & 0x3ff), oscBefore, "the oscillator is not retuned");
  const osc = easyOscOf(doc.instruments[model().ops[1].instIdx & 0x3ff]);
  assert.deepEqual(easySplitRatio(easyRatioOf(model().ops[1], osc)).m, { k: 3, mult: 0 });

  const back = reload(doc);
  const rig = play(back, slot).playheads[0].trackerState.voices[0].fmRig;
  const r = rig.voices[2].currentPlaybackRate / rig.voices[1].currentPlaybackRate;
  assert.ok(Math.abs(1200 * Math.log2(r / 3)) < 0.002, `×3 within 0.002 cent, got ${r}`);

  write(1, easyJoinRatio({ k: 1, mult: 8 }, 0));
  assert.equal(layerDetune(model().ops[1]), 8 * 4096, "past what sixteen bits hold");
  const rig2 = play(reload(doc), slot).playheads[0].trackerState.voices[0].fmRig;
  const r2 = rig2.voices[2].currentPlaybackRate / rig2.voices[1].currentPlaybackRate;
  assert.ok(Math.abs(r2 / 256 - 1) < 1e-9, `×256, got ${r2}`);
});

// ── the fields' spinners ────────────────────────────────────────────────────

test("a pitch field is 65536-TET steps: hex and decimal count them, never a hex point", () => {
  const p = finePreset(pitchTablePresets[120]);
  const lo = widePitchMap(p);
  const hi = widePitchMap(p, { high: true });
  assert.equal(lo.fromDisplay("$51555"), 0x5155 + 5 / 16, "hex counts 65536-TET steps");
  assert.equal(lo.fromDisplay("0x51555"), 0x5155 + 5 / 16);
  assert.equal(lo.fromDisplay("327680"), 0x5000, "a plain decimal counts them too");
  assert.equal(lo.fromDisplay("C-4"), 0x5000);
  assert.equal(lo.fromDisplay("Ab4"), lo.fromDisplay("G#4"), "a name before hex");
  assert.equal(lo.fromDisplay("−$10000"), -0x1000, "an octave below C0");
  assert.equal(lo.fromDisplay("$120000"), 0x12000, "past C15");
  assert.ok(Number.isNaN(lo.fromDisplay("$5155.5")), "no hex point: the field keeps its value");
  assert.ok(Number.isNaN(lo.fromDisplay("700c")), "an absolute pitch is not an interval");
  assert.equal(lo.toDisplay(-0x1000), "−$10000");
  assert.equal(lo.toDisplay(0x5155 + 5 / 16), "$51555");
  assert.equal(lo.toDisplay(0x5000), "$50000");
  assert.equal(hi.fromDisplay("$4FFFF"), 0x4fff + 15 / 16, "a typed top is the step it names");
  assert.equal(hi.fromDisplay("$50000"), 0x5000);
  assert.equal(hi.fromDisplay("C-4"), 0x5000 + 15 / 16, "a named degree on a whole unit takes that unit");
  assert.equal(hi.toDisplay(0x4fff + 15 / 16), "$4FFFF");
  assert.equal(hi.step(0x4fff + 15 / 16, 1), 0x5000 + 15 / 16, "a step lands on the next degree's unit");

  const c = centsMap(p, -1e6, 1e6, true);
  const steps = (u) => u * 16;
  assert.equal(steps(c.fromDisplay("3/2")), Math.round(65536 * Math.log2(1.5)), "a ratio straight onto the 65536 grid");
  assert.equal(steps(c.fromDisplay("5/4")), Math.round(65536 * Math.log2(1.25)));
  assert.equal(steps(c.fromDisplay("700c")), Math.round((700 * 65536) / 1200), "cents straight onto it");
  assert.equal(steps(c.fromDisplay("700")), Math.round((700 * 65536) / 1200), "a plain number is what the box shows: cents");
  assert.equal(steps(c.fromDisplay("$100")), 0x100, "hex counts 65536-TET steps");
  assert.equal(steps(c.fromDisplay("-$100")), -0x100);
  assert.ok(Number.isNaN(c.fromDisplay("nonsense")), "text that names nothing keeps the value");
  assert.equal(c.toDisplay(1 / 16), "0.018 ¢");
});

test("an Easy operator's detune goes past halfway to the next multiplier; the row reads it from there", () => {
  const u1 = easyMultiplierUnits({ k: 1, mult: 0 });
  const typed = u1 + (1000 * 4096) / 1200; // ×1 and 1000 ¢
  const { m, fine } = easySplitRatio(typed);
  assert.deepEqual(m, { k: 1, mult: 1 }, "1000 ¢ above ×1 reads as ×2…");
  assert.ok(Math.abs((fine * 1200) / 4096 + 200) < 0.02, "…less 200 ¢: the same pitch, to a 65536-TET step");
});

test("an instrument's groups read back from its deltas are the entry it was given", () => {
  const { doc, slot } = stack();
  const undo = new UndoStack(doc);
  const layers = metaLayers(doc.instruments[slot]);
  writeLayers(undo, doc, slot, patchLayer(layers, 2, { ...layerHighFields(0x7000 + 2 / 16), ...layerDetuneFields(layers[2], -5 / 16) }));
  const inst = doc.instruments[slot];
  assert.ok(pitchExtApplies(inst, inst.pitchExtEntry));
  assert.deepEqual([...pitchExtGroupsOf(inst).table], [...inst.pitchExtEntry.table]);
});
