// PSG instrument editing — the Instruments view's PSG tab reads a type-9
// record's patch as fields and writes it back as record bytes; a new
// instrument starts as a square with a muted triangle in the first free slot,
// and a formant instrument may be sung from one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTaud } from "../../core/format/taud-parse.js";
import { SAMPLEINST_SIZE } from "../../core/format/taud-const.js";
import { PSG_BLOCK_START, PSG_B_OSC, PSG_OSC_BYTES } from "../../core/engine/psg.js";
import { buildFormantRecord } from "../../core/engine/inst.js";
import * as F from "../../core/engine/formant.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp, setInstBytesOp } from "../../src/doc/ops.js";
import { planCreateOpl, planSetFormantSource } from "../../src/doc/bankmerge.js";
import { canSourceFormant } from "../../src/doc/formantedit.js";
import {
  psgFields, psgOscillator, psgOscBytes, psgSwitchBytes, defaultPsgRecord, psgBadge,
  psgWavePoints, PSG_ENV_FIELDS,
} from "../../src/doc/psgedit.js";

function emptyProject() {
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  return new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: new Uint8Array(SAMPLEINST_SIZE),
    songs: [{
      numVoices: 32, bpm: 125, tickRate: 6, tuningBaseNote: 0x4500,
      tuningFreq: 440, globalFlags: 0, globalVolume: 128, mixingVolume: 48,
      patterns: [emptyPat], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections: [], ixmp: [],
    meta: { projectName: "test", songMeta: {} },
  });
}

/** A project holding one new PSG instrument, and that instrument's slot. */
function withPsg() {
  const doc = emptyProject();
  doc.undo = new UndoStack(doc);
  const plan = planCreateOpl(doc, defaultPsgRecord(), "PSG");
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(importBankOp(plan));
  return { doc, slot: plan.metaSlot };
}

const edit = (doc, slot, pairs) => doc.undo.apply(setInstBytesOp(slot, pairs));

/** Every oscillator field and its range, the editor's and the PSG's own. */
const ALL_FIELDS = [...PSG_ENV_FIELDS,
  { key: "wave", max: 15 }, { key: "invert", max: 1 }, { key: "reset", max: 1 },
  { key: "tremolo", max: 3 }, { key: "vibrato", max: 3 }, { key: "advance", max: 255 }];

test("a new PSG instrument is a square with a muted triangle, in the first free slot", () => {
  const { doc, slot } = withPsg();
  const inst = doc.instruments[slot];
  assert.equal(slot, 1);
  assert.ok(inst.isPsg && !inst.isMeta && !inst.isOpl);
  assert.equal(doc.instrumentName(slot), "PSG");
  const f = psgFields(inst);
  assert.deepEqual([f.multiply, f.muteA, f.muteB], [false, false, true]);
  assert.equal(f.osc[0].wave, 4, "A: the square");
  assert.equal(f.osc[1].wave, 9, "B: the triangle");
  assert.equal(f.osc[1].mult, 0, "…an octave down");
  assert.ok(f.osc[0].ar === 15 && f.osc[0].eg === 1, "it sounds at once and holds");
  assert.equal(psgBadge(inst), "PSG");
  const back = new Document(parseTaud(doc.toBytes())).instruments[slot];
  assert.ok(back.isPsg);
  assert.deepEqual([...back.psgRaw], [...inst.psgRaw]);
});

test("every oscillator field writes its own bits and nothing else", () => {
  const { doc, slot } = withPsg();
  const inst = doc.instruments[slot];
  for (let o = 0; o < 2; o++) {
    for (const { key, max } of ALL_FIELDS) {
      const before = psgOscillator(inst, o);
      const value = before[key] === max ? 0 : max;
      const pairs = psgOscBytes(inst, o, key, value);
      assert.equal(pairs.length, 1);
      const at = pairs[0][0] - PSG_BLOCK_START;
      assert.ok(at >= PSG_B_OSC + o * PSG_OSC_BYTES && at < PSG_B_OSC + (o + 1) * PSG_OSC_BYTES,
        `${key} lands in oscillator ${o}'s bytes`);
      edit(doc, slot, pairs);
      const after = psgOscillator(inst, o);
      assert.equal(after[key], value, `oscillator ${o} ${key}`);
      for (const k of Object.keys(before)) if (k !== key) assert.equal(after[k], before[k], `${key} left ${k} alone`);
      // The decoded patch the engine plays follows at once.
      if (key === "tl") assert.equal(inst.psg.osc[o].tl, value);
      if (key === "wave") assert.equal(inst.psg.osc[o].wave, value);
      doc.undo.undo();
      assert.deepEqual(psgOscillator(inst, o), before);
    }
  }
});

test("the mixer switches, and the badge that names the multiplying mix", () => {
  const { doc, slot } = withPsg();
  const inst = doc.instruments[slot];
  edit(doc, slot, psgSwitchBytes(inst, "multiply", true));
  assert.ok(inst.psg.multiply);
  assert.equal(psgBadge(inst), "PSG·×");
  edit(doc, slot, psgSwitchBytes(inst, "muteB", false));
  edit(doc, slot, psgSwitchBytes(inst, "muteA", true));
  assert.deepEqual([inst.psg.muteA, inst.psg.muteB, inst.psg.multiply], [true, false, true]);
  assert.equal(inst.psgRaw[0], 0b1001, "X set, Y clear, m set");
  doc.undo.undo(); doc.undo.undo(); doc.undo.undo();
  assert.equal(psgBadge(inst), "PSG");
  assert.equal(inst.psgRaw[0], 0b0100);
});

test("the waveform window draws what the engine plays", () => {
  const sq = psgWavePoints(4, false, 16, 1);
  assert.deepEqual([...sq], [1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1, -1]);
  assert.deepEqual([...psgWavePoints(0, true, 4, 1)], [-1, -1, -1, -1], "inverted DC");
  assert.deepEqual([...psgWavePoints(15, false, 4, 1)], [0, 0, 0, 0], "silence");
  const noise = psgWavePoints(0xc, false, 256, 2);
  assert.ok(noise.every((v) => v === 1 || v === -1) && noise.some((v) => v === 1) && noise.some((v) => v === -1));
});

test("a formant instrument may be sung from a PSG instrument", () => {
  const { doc, slot } = withPsg();
  assert.ok(canSourceFormant(doc.instruments[slot]));
  const fp = new F.FormantPatch();
  fp.srcPtr = 0x1000;
  const rec = buildFormantRecord(F.encodeFormantBlock(fp),
    { ptr: 0x1000, len: 128, rate: 33488, loopStart: 0, loopEnd: 128, loopMode: 1 });
  const fplan = planCreateOpl(doc, rec, "Formant");
  doc.undo.apply(importBankOp(fplan));
  const fslot = fplan.metaSlot;
  const plan = planSetFormantSource(doc, fslot, slot);
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(importBankOp(plan));
  const child = doc.instruments[fslot].formant.srcInst;
  assert.ok(child >= 0x100, "copied in as a sub-instrument");
  assert.ok(doc.instruments[child].isPsg);
  assert.deepEqual([...doc.instruments[child].psgRaw], [...doc.instruments[slot].psgRaw]);
});
