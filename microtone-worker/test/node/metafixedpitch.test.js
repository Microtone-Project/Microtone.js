// Item 179 — the type-0 layer's NON-MELODIC flag. A layer with it set sounds
// ONE pitch whatever key was struck, and its detune field stops being a signed
// offset: it becomes that pitch, an unsigned 4096-TET note word.
//
// Three things have to hold together for that to be true rather than merely
// stored: the record codec has to read the field as unsigned only when the flag
// is there (§7.4 byte +9 bit 6), the trigger has to sound the layer at its own
// note while still GATING it on the trigger's, and the per-tick sync has to
// leave it alone for the whole note.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../core/engine/constants.js";
import {
  TaudInst, buildMetaRecord, makeMetaLayer, layerNote, META_TYPE_FM,
  META_LAYER_FIXED_PITCH, defaultFmProgram,
} from "../../core/engine/inst.js";
import {
  metaLayers, patchLayer, duplicateLayer, stackLayer,
  fixedPitchFields, clampLayerPitch, FIXED_PITCH_ANCHOR,
} from "../../src/doc/metaedit.js";

setSamplingRate(32000);

const C4 = 0x5000;
const A4 = 0x5900; // any second key — what the fixed layer must ignore

/** A looping ramp instrument in `slot`. */
function uploadRamp(eng, slot) {
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(slot, rec);
}

function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  uploadRamp(eng, 1);
  uploadRamp(eng, 2);
  eng.setMasterVolume(0, 255);
  return eng;
}

const ts0 = (eng) => eng.playheads[0].trackerState;
const kids = (eng) => ts0(eng).backgroundVoices.filter(
  (v) => v.active && v.isLayerChild && v.sourceChannel === 0);

// ── the record ─────────────────────────────────────────────────────────────

test("the flag rides in byte +9 bit 6 and leaves the volume range alone", () => {
  const rec = buildMetaRecord([
    makeMetaLayer(1, 159, 0x6000, 0x0000, 0xffff, 5, 60, true),
    makeMetaLayer(2, 159, -341, 0x0000, 0xffff, 0, 63),
  ]);
  assert.equal(rec[4 + 9] & 0x3f, 60, "vol range high survives the flag");
  assert.equal(rec[4 + 9] & META_LAYER_FIXED_PITCH, META_LAYER_FIXED_PITCH);
  assert.equal(rec[4 + 8] & 0x3f, 5, "vol range low is untouched");
  assert.equal(rec[14 + 9] & META_LAYER_FIXED_PITCH, 0, "an ordinary layer sets nothing");
});

test("a fixed-pitch layer's detune reads back UNSIGNED; an ordinary one signed", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(buildMetaRecord([
    makeMetaLayer(1, 159, 0xa000, 0x0000, 0xffff, 0, 63, true), // above $7FFF
    makeMetaLayer(2, 159, -341, 0x0000, 0xffff, 0, 63),
  ]));
  assert.equal(inst.metaLayers[0].fixedPitch, true);
  assert.equal(inst.metaLayers[0].detune, 0xa000, "a note word, not −24576");
  assert.equal(inst.metaLayers[1].fixedPitch, false);
  assert.equal(inst.metaLayers[1].detune, -341, "an ordinary layer is still signed");
});

test("record round-trip: layers rebuild byte-exact through the document layer", () => {
  const layers = [
    makeMetaLayer(1, 159, 0xa000, 0x1000, 0x8000, 0, 63, true),
    makeMetaLayer(2, 100, -341, 0x0000, 0xffff, 3, 60),
  ];
  const rec = buildMetaRecord(layers);
  const inst = new TaudInst(0);
  inst.loadRecord(rec);
  const again = buildMetaRecord(metaLayers(inst));
  assert.deepEqual(Array.from(again), Array.from(rec));
});

test("the bit is the Layered kind's alone — a rack keeps a signed ratio", () => {
  const inst = new TaudInst(0);
  const rec = buildMetaRecord(
    [makeMetaLayer(1, 159, -4096, 0x0000, 0xffff, 0, 63)],
    { type: META_TYPE_FM, program: defaultFmProgram(1) });
  rec[4 + 9] |= META_LAYER_FIXED_PITCH; // as a corrupt file might leave it
  inst.loadRecord(rec);
  assert.equal(inst.isFm, true);
  assert.equal(inst.metaLayers[0].fixedPitch, false, "reserved in a rack: read as nothing");
  assert.equal(inst.metaLayers[0].detune, -4096, "the ratio stays signed");
});

test("layerNote: the flag decides whether the trigger is added at all", () => {
  const fixed = makeMetaLayer(1, 159, 0x6000, 0, 0xffff, 0, 63, true);
  const plain = makeMetaLayer(1, 159, 0x0100, 0, 0xffff, 0, 63);
  assert.equal(layerNote(fixed, C4), 0x6000);
  assert.equal(layerNote(fixed, A4), 0x6000, "the key does not reach it");
  assert.equal(layerNote(plain, C4), C4 + 0x0100);
  assert.equal(layerNote(plain, A4), A4 + 0x0100);
});

// ── the trigger ────────────────────────────────────────────────────────────

test("a fixed-pitch layer child sounds its own note at every key", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0x6000, 0x0000, 0xffff, 0, 63, true),
  ]));
  for (const key of [C4, A4, 0x3000]) {
    eng.jamNote(0, 0, key, 3);
    assert.equal(ts0(eng).voices[0].noteVal, key, "layer 0 still plays the key");
    const child = kids(eng).find((v) => v.instrumentId === 2);
    assert.ok(child, "the fixed layer sounds");
    assert.equal(child.noteVal, 0x6000, `fixed at $6000 for key $${key.toString(16)}`);
    assert.equal(child.layerFixedNote, 0x6000);
  }
});

test("…and it holds that note through the per-tick sync", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0x6000, 0x0000, 0xffff, 0, 63, true),
  ]));
  eng.jamNote(0, 0, A4, 3);
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const chunksPerTick = (SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK;
  for (let i = 0; i < chunksPerTick * 4; i++) eng.renderChunk(0, out);
  const child = kids(eng).find((v) => v.instrumentId === 2);
  assert.ok(child, "the child is still sounding");
  assert.equal(child.noteVal, 0x6000, "four ticks later, still its own note");
});

test("layer 0 fixed: the channel sounds the fixed note, the melodic child still tracks", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0x6000, 0x0000, 0xffff, 0, 63, true),
    makeMetaLayer(2, 159, 0x0100, 0x0000, 0xffff, 0, 63),
  ]));
  eng.jamNote(0, 0, A4, 3);
  assert.equal(ts0(eng).voices[0].noteVal, 0x6000, "the foreground voice is the fixed one");
  const child = kids(eng).find((v) => v.instrumentId === 2);
  assert.equal(child.noteVal, A4 + 0x0100, "the melodic layer still plays the key");
  assert.equal(child.layerRelDetune, A4 + 0x0100 - 0x6000,
    "the interval is measured between the NOTES, so it survives a fixed layer 0");
  assert.equal(child.layerFixedNote, -1);
});

test("an ordinary two-layer meta keeps the exact relative detune it always had", () => {
  const eng = makeEngine();
  const third = Math.round((4096 * 4) / 12);
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, -100, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, third, 0x0000, 0xffff, 0, 63),
  ]));
  eng.jamNote(0, 0, C4, 3);
  const child = kids(eng).find((v) => v.instrumentId === 2);
  assert.equal(child.layerRelDetune, third - -100);
});

test("the gating rectangle still asks about the KEY, not the fixed pitch", () => {
  const eng = makeEngine();
  // The fixed layer sounds $6000 but is gated to the bottom two octaves: a key
  // above the rectangle must not reach it, however high the pitch it would play.
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0x6000, 0x0000, 0x4000, 0, 63, true),
  ]));
  eng.jamNote(0, 0, 0x3000, 3);
  assert.ok(kids(eng).some((v) => v.instrumentId === 2), "inside the rectangle: sounds");
  eng.jamNote(0, 0, A4, 3);
  assert.ok(!kids(eng).some((v) => v.instrumentId === 2), "outside it: silent");
});

// ── the editor's arithmetic ────────────────────────────────────────────────

test("fixedPitchFields carries the pitch the row was showing across the switch", () => {
  const plain = makeMetaLayer(1, 159, 341, 0, 0xffff, 0, 63);
  const on = fixedPitchFields(plain, true);
  assert.equal(on.fixedPitch, true);
  assert.equal(on.detune, FIXED_PITCH_ANCHOR + 341, "the glyph does not jump");
  const off = fixedPitchFields({ ...plain, ...on }, false);
  assert.equal(off.fixedPitch, false);
  assert.equal(off.detune, 341, "and it comes back");
});

test("clampLayerPitch fits the field to whichever thing it is", () => {
  const fixed = makeMetaLayer(1, 159, 0x6000, 0, 0xffff, 0, 63, true);
  const plain = makeMetaLayer(1, 159, 0, 0, 0xffff, 0, 63);
  assert.equal(clampLayerPitch(fixed, 0xa000), 0xa000, "a note word above $7FFF is legal");
  assert.equal(clampLayerPitch(fixed, 0x10), 0x20, "…but not one in the sentinel space");
  assert.equal(clampLayerPitch(fixed, 0x1ffff), 0xffff);
  assert.equal(clampLayerPitch(plain, 0xa000), 0x7fff, "an offset is still signed 16-bit");
  assert.equal(clampLayerPitch(plain, -0x9000), -0x8000);
});

test("duplicate and chord-stack copies keep the flag", () => {
  const layers = [makeMetaLayer(1, 159, 0x6000, 0, 0xffff, 0, 63, true)];
  assert.equal(duplicateLayer(layers, 0)[1].fixedPitch, true);
  const stacked = stackLayer(layers, 0, [0x6000 + 1365, 0x6000 + 2048]);
  assert.equal(stacked.length, 3);
  assert.deepEqual(stacked.map((l) => l.fixedPitch), [true, true, true]);
  assert.deepEqual(stacked.map((l) => l.detune), [0x6000, 0x6000 + 1365, 0x6000 + 2048],
    "a stack off a fixed layer is a chord of absolute pitches");
});

test("patchLayer edits a fixed layer's pitch without disturbing its neighbours", () => {
  const layers = [
    makeMetaLayer(1, 159, 0, 0, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0x6000, 0, 0xffff, 0, 63, true),
  ];
  const next = patchLayer(layers, 1, { detune: 0x7000 });
  assert.equal(next[1].detune, 0x7000);
  assert.equal(next[1].fixedPitch, true);
  assert.equal(next[0].detune, 0);
  const inst = new TaudInst(0);
  inst.loadRecord(buildMetaRecord(next));
  assert.equal(inst.metaLayers[1].detune, 0x7000);
  assert.equal(inst.metaLayers[1].fixedPitch, true);
});
