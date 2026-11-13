// The pitch extension — the `IPit` section (file format §9.18) — and the range
// rule it rests on (§9.11): a pitch range runs through the WHOLE of the last
// unit its high bound names.
//
// Every engine check goes through the host API on TaudEngine, so the same file
// pins the C engine (the default) and, under tools/use-js-engine.mjs, the
// JavaScript one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import {
  TaudInst, makeInstPatch, writePatchesBlob, parsePatchesBlob, buildMetaRecord, makeMetaLayer,
  META_TYPE_FM, FM_WORD_OSC, FM_WORD_MOD, FmOp, parsePitchExtSection, pitchExtDelta, pitchExtDeltaHigh,
} from "../../core/engine/inst.js";
import {
  splitPitch, joinPitch, pitchExtEntry, buildPitchExtSection, IPIT_FOURCC,
} from "../../core/format/pitch-ext-section.js";

setSamplingRate(32000);

const C4 = 0x5000;
const w16 = (rec, o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };

/** A looping 256-byte ramp at `ptr`, sounding C at C-4. */
function sampleRecord({ detune = 0, ptr = 0 } = {}) {
  const rec = new Uint8Array(256);
  rec[0] = ptr & 0xff; rec[1] = (ptr >> 8) & 0xff; rec[2] = (ptr >> 16) & 0xff;
  w16(rec, 4, 256);        // sample length
  w16(rec, 6, 32000);      // sampling rate at C4
  w16(rec, 12, 256);       // loop end
  rec[14] = 1;             // forward loop
  rec[21] = 0x3f;          // volume envelope node 0: full
  rec[171] = 255;          // instrument global volume
  rec[182] = 0xff;         // filter off
  w16(rec, 184, detune & 0xffff);
  rec[196] = 255;          // default note volume
  return rec;
}

function makeEngine() {
  const eng = new TaudEngine();
  const bin = eng.sampleBin;
  for (let i = 0; i < 1024; i++) bin[i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * i) / 256));
  return eng;
}

/** The editor's model of instrument `slot`, as `eng` was given it: what an
 *  entry's guard is computed from. */
function modelOf(slot, rec, patchBlob = null) {
  const m = new TaudInst(slot);
  m.loadRecord(rec);
  if (patchBlob !== null) m.extraPatches = parsePatchesBlob(patchBlob);
  return m;
}

const zone = (fields) => makeInstPatch({
  volumeStart: 0, volumeEnd: 63, samplePtr: 0, sampleLength: 256, loopEnd: 256,
  samplingRate: 32000, loopMode: 1, ...fields,
});

const render = (eng, chunks = 1) => {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < chunks; i++) eng.renderChunk(0, out);
};
const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];
const kids = (eng) => eng.playheads[0].trackerState.backgroundVoices.filter((v) => v.active);

// ── the arithmetic ─────────────────────────────────────────────────────────

test("a pitch on the 4096-TET grid needs no extension", () => {
  assert.deepEqual(splitPitch(C4), { field: 0x5000, ext: 0 });
  assert.deepEqual(splitPitch(-341, { signed: true }), { field: (-341) & 0xffff, ext: 0 });
  // A range's high bound covers its whole last unit with a ZERO byte: the last
  // pitch inside [.., $4FFF] is $4FFF and fifteen sixteenths.
  assert.deepEqual(splitPitch(0x4fff + 15 / 16, { high: true }), { field: 0x4fff, ext: 0 });
  assert.equal(pitchExtDelta(0), 0);
  assert.equal(pitchExtDeltaHigh(0), 0);
});

test("the extension is four bits of fraction below the field and four of octave above it", () => {
  assert.deepEqual(splitPitch(C4 + 5 / 16), { field: 0x5000, ext: 0x05 });
  // Sixteen octaves is one step of the octave nibble; C-1 is the top of the
  // sixteen octaves BELOW the field's own, so its nibble is −1.
  assert.deepEqual(splitPitch(-0x1000), { field: 0xf000, ext: 0xf0 });
  assert.deepEqual(splitPitch(0x10000 + 0x20), { field: 0x0020, ext: 0x10 });
  // A signed field keeps its own sign; the nibble only adds whole sixteens.
  assert.deepEqual(splitPitch(-0.5, { signed: true }), { field: 0xffff, ext: 0x08 });
  assert.deepEqual(splitPitch(-20 * 4096 + 3 / 16, { signed: true }), { field: (-4 * 4096) & 0xffff, ext: 0xf3 });
  // The whole range: 256 octaves, and nothing past them.
  assert.equal(splitPitch(-128 * 4096).ext, 0x80);
  assert.equal(splitPitch(128 * 4096 - 1 / 16).ext, 0x7f);
  assert.throws(() => splitPitch(128 * 4096), RangeError);
  assert.throws(() => splitPitch(-128 * 4096 - 1), RangeError);
});

test("splitPitch and joinPitch are inverses over every kind of field", () => {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 4000; i++) {
    const v = Math.round((rnd() * 240 - 120) * 65536) / 16;
    for (const kind of [{}, { signed: true }, { high: true }]) {
      const { field, ext } = splitPitch(v, kind);
      assert.equal(joinPitch(field, ext, kind), v, `${v} as ${JSON.stringify(kind)}`);
    }
  }
});

// ── the range rule, with no section at all ─────────────────────────────────

test("two zones that meet leave no gap for a note between their units", () => {
  const eng = makeEngine();
  eng.uploadInstrument(1, sampleRecord());
  eng.uploadInstrumentPatches(1, writePatchesBlob([
    zone({ pitchStart: 0x0020, pitchEnd: 0x4fff, sampleDetune: 100 }),
    zone({ pitchStart: 0x5000, pitchEnd: 0xffff, sampleDetune: 200 }),
  ]));
  const inst = eng.instruments[1];
  assert.equal(inst.resolvePatch(0x4fff, 0x3f).sampleDetune, 100);
  assert.equal(inst.resolvePatch(0x5000, 0x3f).sampleDetune, 200);
  // A wide cell's note carries sixteenths, and this one sits past $4FFF and
  // short of $5000: it used to match neither zone and play the base sample.
  for (const fine of [1, 8, 15]) {
    const p = inst.resolvePatch(0x4fff + fine / 16, 0x3f);
    assert.notEqual(p, null, `$4FFF + ${fine}/16 falls between the zones`);
    assert.equal(p.sampleDetune, 100, "it belongs to the zone whose last unit it is in");
  }
});

test("a layer's and an operator's rectangle follow the same rule", () => {
  const eng = makeEngine();
  eng.uploadInstrument(1, sampleRecord());
  eng.uploadInstrument(2, sampleRecord());
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0x4fff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x5000, 0xffff, 0, 63),
  ]));
  const layersAt = (note) => eng.instruments[3].resolveMetaLayers(note, 0x3f).map((l) => l.instIdx);
  assert.deepEqual(layersAt(0x4fff), [1]);
  assert.deepEqual(layersAt(0x4fff + 9 / 16), [1], "the note between the units is in the layer whose last unit that is");
  assert.deepEqual(layersAt(0x5000), [2]);
});

// ── the section ────────────────────────────────────────────────────────────

test("a section round-trips: every group, the guard, a second instrument", () => {
  const rec = sampleRecord({ detune: -7 });
  const blob = writePatchesBlob([zone({ pitchStart: 0x20, pitchEnd: 0x4fff }), zone({ pitchStart: 0x5000, pitchEnd: 0xffff })]);
  const a = pitchExtEntry(modelOf(1, rec, blob), { base: [0x05, 0, 0], patches: [0, 0x08, 0, 0x09, 0, 0x03] });
  const meta = buildMetaRecord([makeMetaLayer(1, 159, 10, 0, 0xffff, 0, 63), makeMetaLayer(1, 159, 20, 0, 0xffff, 0, 63)]);
  const b = pitchExtEntry(modelOf(700, meta), { table: [0x01, 0, 0, 0xf2, 0, 0] });
  const section = buildPitchExtSection([a, b]);
  const back = parsePitchExtSection(section);
  assert.deepEqual([...back.keys()], [1, 700]);
  assert.deepEqual([...back.get(1).base], [0x05, 0, 0]);
  assert.deepEqual([...back.get(1).patches], [0, 0x08, 0, 0x09, 0, 0x03]);
  assert.equal(back.get(1).table, null);
  assert.equal(back.get(1).guard, a.guard);
  assert.deepEqual([...back.get(700).table], [0x01, 0, 0, 0xf2, 0, 0]);
  // Nothing to say is nothing written.
  assert.equal(pitchExtEntry(modelOf(1, rec, blob), { base: [0, 0, 0] }), null);
  assert.equal(buildPitchExtSection([null]), null);
});

test("an entry the section cannot finish ends the read; what came before it stands", () => {
  const rec = sampleRecord();
  const a = pitchExtEntry(modelOf(1, rec), { base: [0x04, 0, 0] });
  const good = buildPitchExtSection([a]);
  const reserved = Uint8Array.from([...good, 2, 0x04 | 0x80, 0, 0, 1, 2, 3]);
  assert.deepEqual([...parsePitchExtSection(reserved).keys()], [1], "a reserved flag: its size is unknowable");
  const truncated = Uint8Array.from([...good, 2, 0x10, 0, 0, 9, 0, 1, 2, 3]);
  assert.deepEqual([...parsePitchExtSection(truncated).keys()], [1], "a patch group that runs off the end");
  assert.equal(parsePitchExtSection(null).size, 0);
});

// ── what the engine does with it ───────────────────────────────────────────

test("a zone's bounds and detune take their sixteenths", () => {
  const eng = makeEngine();
  const rec = sampleRecord();
  // Zone 0 ends ON $4FFF + 8/16; zone 1 starts at the next sixteenth.
  const lo = splitPitch(0x4fff + 9 / 16), hi = splitPitch(0x4fff + 8 / 16, { high: true });
  const det = splitPitch(200 + 3 / 16, { signed: true });
  const blob = writePatchesBlob([
    zone({ pitchStart: 0x0020, pitchEnd: hi.field, sampleDetune: 100 }),
    zone({ pitchStart: lo.field, pitchEnd: 0xffff, sampleDetune: det.field }),
  ]);
  eng.uploadInstrument(1, rec);
  eng.uploadInstrumentPatches(1, blob);
  const inst = eng.instruments[1];
  // Without the section zone 0 runs through the whole of $4FFF.
  assert.equal(inst.resolvePatch(0x4fff + 9 / 16, 0x3f).sampleDetune, 100);

  eng.setPitchExt(buildPitchExtSection([pitchExtEntry(modelOf(1, rec, blob), { patches: [0, hi.ext, 0, lo.ext, 0, det.ext] })]));
  assert.equal(inst.resolvePatch(0x4fff + 8 / 16, 0x3f).sampleDetune, 100, "the last pitch of zone 0");
  assert.equal(inst.resolvePatch(0x4fff + 9 / 16, 0x3f).sampleDetune, 200, "the first of zone 1");
  eng.jamNote(0, 0, 0x5800, 1);
  assert.equal(voice0(eng).activeSampleDetune, 200 + 3 / 16, "the zone's detune, sixteenths and all");

  // Taking the section away puts the sixteen-bit values back.
  eng.setPitchExt(null);
  assert.equal(inst.resolvePatch(0x4fff + 9 / 16, 0x3f).sampleDetune, 100);
  eng.jamNote(0, 0, C4, 1);
  assert.equal(voice0(eng).activeSampleDetune, 200);
});

test("the base record's detune is extended, and reaches the pitch that sounds", () => {
  const rateFor = (ext) => {
    const eng = makeEngine();
    const rec = sampleRecord({ detune: 10 });
    eng.uploadInstrument(1, rec);
    if (ext !== 0) eng.setPitchExt(buildPitchExtSection([pitchExtEntry(modelOf(1, rec), { base: [ext, 0, 0] })]));
    eng.jamNote(0, 0, C4, 1);
    render(eng);
    return voice0(eng).playbackRate;
  };
  const plain = rateFor(0);
  assert.ok(Math.abs(rateFor(0x08) / plain - 2 ** (0.5 / 4096)) < 1e-13, "half a 4096-TET unit sharp");
  assert.ok(Math.abs(rateFor(0x10) / plain - 2 ** 16) < 1e-6, "one step of the octave nibble is sixteen octaves");
});

test("the order a host uploads in does not matter", () => {
  const rec = sampleRecord();
  const blob = writePatchesBlob([zone({ pitchStart: 0x20, pitchEnd: 0xffff, sampleDetune: 50 })]);
  const section = buildPitchExtSection([pitchExtEntry(modelOf(1, rec, blob), { patches: [0, 0, 0x07] })]);
  const detuneAfter = (steps) => {
    const eng = makeEngine();
    for (const s of steps) {
      if (s === "rec") eng.uploadInstrument(1, rec);
      if (s === "patches") eng.uploadInstrumentPatches(1, blob);
      if (s === "ext") eng.setPitchExt(section);
    }
    eng.jamNote(0, 0, C4, 1);
    return voice0(eng).activeSampleDetune;
  };
  for (const order of [["rec", "patches", "ext"], ["ext", "rec", "patches"], ["rec", "ext", "patches"], ["patches", "ext", "rec", "patches"]]) {
    assert.equal(detuneAfter(order), 50 + 7 / 16, order.join(" → "));
  }
});

test("the guard: an entry whose instrument has changed under it is ignored whole", () => {
  const eng = makeEngine();
  const rec = sampleRecord({ detune: 10 });
  eng.uploadInstrument(1, rec);
  eng.setPitchExt(buildPitchExtSection([pitchExtEntry(modelOf(1, rec), { base: [0x08, 0, 0] })]));
  const detune = () => { eng.jamNote(0, 0, C4, 1); return voice0(eng).activeSampleDetune; };
  assert.equal(detune(), 10.5);
  // An editor that does not know the section rewrites the record and keeps
  // the section as it found it.
  eng.uploadInstrument(1, sampleRecord({ detune: 11 }));
  assert.equal(detune(), 11, "the stale half-unit is not added to a field it was never written for");
  // The fields as the entry knew them: it applies again.
  eng.uploadInstrument(1, rec);
  assert.equal(detune(), 10.5);
  // A patch group needs the patch list it counted.
  const blob = writePatchesBlob([zone({ pitchStart: 0x20, pitchEnd: 0xffff, sampleDetune: 50 })]);
  eng.uploadInstrumentPatches(1, blob);
  eng.setPitchExt(buildPitchExtSection([pitchExtEntry(modelOf(1, rec, blob), { patches: [0, 0, 0x04] })]));
  assert.equal(detune(), 50.25);
  eng.uploadInstrumentPatches(1, writePatchesBlob([
    zone({ pitchStart: 0x20, pitchEnd: 0x4fff, sampleDetune: 50 }), zone({ pitchStart: 0x5000, pitchEnd: 0xffff, sampleDetune: 50 }),
  ]));
  assert.equal(detune(), 50, "two patches now: the entry counted one");
});

test("a layer's detune takes its sixteenths, and its child keeps the interval", () => {
  const eng = makeEngine();
  eng.uploadInstrument(1, sampleRecord());
  eng.uploadInstrument(2, sampleRecord());
  const meta = buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 7, 0x0000, 0xffff, 0, 63),
  ]);
  eng.uploadInstrument(3, meta);
  eng.setPitchExt(buildPitchExtSection([pitchExtEntry(modelOf(3, meta), { table: [0, 0, 0, 0x0b, 0, 0] })]));
  eng.jamNote(0, 0, C4, 3);
  const child = kids(eng).find((v) => v.instrumentId === 2);
  assert.equal(child.noteVal, C4 + 7 + 11 / 16);
  assert.equal(child.layerRelDetune, 7 + 11 / 16);
  render(eng, 8); // a tick or more: the per-tick sync re-derives the child from its parent
  assert.equal(child.noteVal, C4 + 7 + 11 / 16, "and the sync keeps it there");
});

test("a fixed operator below C0: the note value stays in range, the rest is carried", () => {
  const eng = makeEngine();
  eng.uploadInstrument(1, sampleRecord());
  eng.uploadInstrument(2, sampleRecord());
  // Operator 1 modulates operator 0 and is FIXED four octaves below C0: an
  // LFO-rate modulator, which sixteen bits of note word cannot name.
  const fixed = splitPitch(-4 * 4096 + 2 / 16);
  const program = Uint16Array.from([FM_WORD_OSC | 1, FM_WORD_MOD | 0, FmOp.END]);
  const rack = buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, fixed.field, 0x0000, 0xffff, 0, 63, true),
  ], { type: META_TYPE_FM, program });
  eng.uploadInstrument(3, rack);

  // Without the section the field is the note word it always was.
  eng.jamNote(0, 0, C4, 3);
  let op = kids(eng).find((v) => v.instrumentId === 2);
  assert.equal(op.noteVal, fixed.field);
  assert.equal(op.pitchExcess, 0);
  render(eng);
  const rateAtWord = op.playbackRate;

  eng.setPitchExt(buildPitchExtSection([pitchExtEntry(modelOf(3, rack), { table: [0, 0, 0, fixed.ext, 0, 0] })]));
  eng.jamNote(0, 0, C4, 3);
  op = kids(eng).find((v) => v.instrumentId === 2);
  assert.equal(op.noteVal, 0x20, "the voice's note value is the lowest a note can be");
  assert.equal(op.pitchExcess, -4 * 4096 + 2 / 16 - 0x20, "and the excess is everything below it");
  assert.equal(op.layerFixedNote, 0x20);
  render(eng, 8);
  assert.equal(op.noteVal, 0x20, "the per-tick sync holds a fixed operator where it is");
  // The pitch that sounds is the whole of it: sixteen octaves and two
  // sixteenths away from where the bare field put it.
  const want = 2 ** ((-4 * 4096 + 2 / 16 - fixed.field) / 4096);
  assert.ok(Math.abs(op.playbackRate / rateAtWord / want - 1) < 1e-12, `${op.playbackRate / rateAtWord} vs ${want}`);
});

test("an operator's ratio that leaves the sixteen octaves is carried too, and follows its parent", () => {
  const eng = makeEngine();
  eng.uploadInstrument(1, sampleRecord());
  eng.uploadInstrument(2, sampleRecord());
  // +7 octaves on a note in the tenth octave: past $FFFF.
  const program = Uint16Array.from([FM_WORD_OSC | 1, FM_WORD_MOD | 0, FmOp.END]);
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 7 * 4096, 0x0000, 0xffff, 0, 63),
  ], { type: META_TYPE_FM, program }));
  eng.jamNote(0, 0, 0xa000, 3);
  const op = kids(eng).find((v) => v.instrumentId === 2);
  assert.equal(op.noteVal, 0xffff);
  assert.equal(op.pitchExcess, 0xa000 + 7 * 4096 - 0xffff);
  render(eng, 8);
  assert.equal(op.noteVal + op.pitchExcess, 0xa000 + 7 * 4096, "the sync re-derives both halves");
});

// ── the file ───────────────────────────────────────────────────────────────

test("the section reaches an engine from a document, and from a parsed file", async () => {
  const { Document } = await import("../../src/doc/document.js");
  const { parseTaud } = await import("../../core/format/taud-parse.js");
  const { loadIntoEngine } = await import("../../core/audio/offline-render.js");
  const { readFileSync } = await import("node:fs");
  const doc = new Document(parseTaud(readFileSync(new URL("../../assets/demo_projects/Zeta_valley.taud", import.meta.url))));
  const SLOT = 1000; // free in the demo
  const rec = sampleRecord({ detune: 10 });
  doc.instruments[SLOT].loadRecord(rec);
  doc.markInstUsed(SLOT);
  // The entry comes straight from the editor's own model of the instrument.
  const section = buildPitchExtSection([pitchExtEntry(doc.instruments[SLOT], { base: [0x08, 0, 0] })]);
  doc.setSection(IPIT_FOURCC, section);
  assert.deepEqual(doc.toRenderable(0).pitchExt, section);

  const parsed = parseTaud(doc.toBytes());
  assert.deepEqual([...parsed.pitchExt], [...section], "saved and read back");
  const eng = new TaudEngine();
  loadIntoEngine(eng, parsed, 0);
  eng.jamNote(0, 0, C4, SLOT);
  assert.equal(voice0(eng).activeSampleDetune, 10.5);
});
