// 8-bit volume envelopes — byte 14 bit 6 (file format §7.2).
//
// A record with the bit holds its volume envelopes (its own and its Ixmp
// patches') in 0…255; without it, in the 0…63 they have always been. The
// engine reads either. A format-3 project in the editor holds only the first
// kind: opening one converts its instruments, and so does importing one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import {
  TaudInst, INST_VOLENV8, makeInstPatch, writePatchesBlob, parsePatchesBlob, buildMetaRecord, makeMetaLayer,
} from "../../core/engine/inst.js";
import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { importBankOp } from "../../src/doc/ops.js";
import { widenVolume, narrowVolume } from "../../src/doc/upgrade.js";
import {
  widenRecordVolEnv, widenPatchesBlobVolEnv, widenInstrumentVolEnv, volEnvFrom63, volEnvMaxOf,
} from "../../src/doc/volenv.js";
import { buildIxmpSection } from "../../src/doc/ixmpsection.js";

setSamplingRate(32000);

const ENV_PRESENT = 0x2000;

/** A looping square instrument whose volume envelope is `vals`, a node every
 *  1/16 s, holding at the last; `eightBit` sets byte 14's bit. */
function record(vals, eightBit = false) {
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256); w16(6, 32000); w16(12, 256);
  rec[14] = 1 | (eightBit ? INST_VOLENV8 : 0);
  for (let k = 0; k < 25; k++) {
    const n = Math.min(k, vals.length - 1);
    rec[21 + 2 * k] = vals[n];
    rec[22 + 2 * k] = k < vals.length - 1 ? 16 : 0;
  }
  w16(15, ENV_PRESENT);
  rec[171] = 255; rec[182] = 0xff; rec[196] = 255;
  return rec;
}

function engineWith(rec, patches = null) {
  const eng = new TaudEngine();
  for (let i = 0; i < 256; i++) eng.sampleBin[i] = i < 128 ? 0x00 : 0xff;
  eng.uploadInstrument(1, rec);
  if (patches) eng.uploadInstrumentPatches(1, patches);
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  return eng;
}

function render(eng, chunks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2 * chunks);
  const buf = new Uint8Array(TRACKER_CHUNK * 2);
  for (let c = 0; c < chunks; c++) { eng.renderChunk(0, buf); out.set(buf, c * buf.length); }
  return out;
}

test("the engine reads an 8-bit envelope out of 255 and a 6-bit one out of 63", () => {
  // Full and silent are the same number in both, and so is every point a
  // straight line between them passes: these two render byte for byte alike.
  const six = render(engineWith(record([63, 0, 63, 0])), 400);
  const eight = render(engineWith(record([255, 0, 255, 0], true)), 400);
  assert.ok(new Set(six).size > 16, "the note sounds — this compares sound, not silence");
  assert.deepEqual(eight, six);
  // A level between: the hold reads value / 255.
  const eng = engineWith(record([128], true));
  render(eng, 40);
  assert.equal(eng.playheads[0].trackerState.voices[0].envVolume, 128 / 255);
  const old = engineWith(record([32]));
  render(old, 40);
  assert.equal(old.playheads[0].trackerState.voices[0].envVolume, 32 / 63);
});

test("an Ixmp patch's volume envelope is in its instrument's units", () => {
  const patch = (v) => writePatchesBlob([makeInstPatch({
    pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    sampleLength: 256, samplingRate: 32000, loopEnd: 256, loopMode: 1, defaultNoteVolume: 255,
    volEnv: Array.from({ length: 25 }, () => ({ value: v, offset: 0 })), volEnvLoop: ENV_PRESENT,
  })]);
  const eng = engineWith(record([255], true), patch(128));
  render(eng, 40);
  assert.equal(eng.playheads[0].trackerState.voices[0].envVolume, 128 / 255);
  const old = engineWith(record([63]), patch(32));
  render(old, 40);
  assert.equal(old.playheads[0].trackerState.voices[0].envVolume, 32 / 63);
});

test("the bit survives the record's own codec, and the loop bits beside it", () => {
  const inst = new TaudInst(1);
  inst.loadRecord(record([255], true));
  assert.equal(inst.volEnv8, true);
  assert.equal(inst.getByteNormal(14), 1 | INST_VOLENV8);
  inst.setByte(14, 2 | 0x10 | INST_VOLENV8);
  assert.equal(inst.getByteNormal(14), 2 | 0x10 | INST_VOLENV8);
  assert.equal(new TaudInst(1).volEnv8, false, "a fresh record is 6-bit");
});

test("widening: every value of 0…63 goes to 0…255 and narrows back to itself", () => {
  for (let v = 0; v <= 63; v++) {
    assert.equal(narrowVolume(widenVolume(v)), v);
    assert.equal(volEnvFrom63(v, 255), widenVolume(v));
    assert.equal(volEnvFrom63(v, 63), v);
  }
  assert.equal(widenVolume(63), 255);
  assert.equal(volEnvMaxOf(INST_VOLENV8), 255);
  assert.equal(volEnvMaxOf(0x37), 63);
});

test("a record widens its 25 volume values and nothing else, once", () => {
  const rec = record([63, 40, 1, 0]);
  rec[71] = 0x80; rec[121] = 0x33; // pan and pitch/filter nodes: not volume
  const out = widenRecordVolEnv(rec);
  assert.notEqual(out, rec, "a copy");
  assert.equal(out[14], rec[14] | INST_VOLENV8);
  for (let k = 0; k < 25; k++) assert.equal(out[21 + 2 * k], widenVolume(rec[21 + 2 * k]));
  for (let o = 0; o < 256; o++) {
    if (o === 14 || (o >= 21 && o <= 70 && (o - 21) % 2 === 0)) continue;
    assert.equal(out[o], rec[o], `byte ${o}`);
  }
  assert.equal(widenRecordVolEnv(out), out, "an 8-bit record is left alone");
  const meta = buildMetaRecord([makeMetaLayer(2, 159, 0, 0, 0xffff, 0, 63)]);
  assert.equal(widenRecordVolEnv(meta), meta, "a layer table has no envelope");
});

test("a patch blob widens only its volume envelopes, whatever else it carries", () => {
  const env = (v) => Array.from({ length: 25 }, (_, k) => ({ value: v - (k % 3), offset: k }));
  const patches = [
    makeInstPatch({ volEnv: env(63), volEnvLoop: ENV_PRESENT, panEnv: env(40), panEnvLoop: ENV_PRESENT,
      hasExtra: true, fadeoutStep: 7, hasChanBlock: true, chanCount: 2, chanPtrs: [0x1234] }),
    makeInstPatch({ panEnv: env(30), panEnvLoop: ENV_PRESENT }),
    makeInstPatch({ volEnv: env(20), volEnvLoop: ENV_PRESENT, pitchEnv: env(50), pitchEnvLoop: ENV_PRESENT }),
  ];
  const blob = writePatchesBlob(patches);
  const out = widenPatchesBlobVolEnv(blob);
  assert.equal(out.length, blob.length);
  const a = parsePatchesBlob(blob), b = parsePatchesBlob(out);
  a.forEach((p, i) => {
    const q = b[i];
    if (p.volEnv) assert.deepEqual(q.volEnv, p.volEnv.map((n) => ({ ...n, value: widenVolume(n.value) })));
    else assert.equal(q.volEnv, null);
    assert.deepEqual(q.panEnv, p.panEnv);
    assert.deepEqual(q.pitchEnv, p.pitchEnv);
    assert.deepEqual(q.chanPtrs, p.chanPtrs);
  });
  const none = writePatchesBlob([patches[1]]);
  assert.equal(widenPatchesBlobVolEnv(none), none);
  // An instrument already 8-bit keeps its patches as they are.
  const rec8 = record([255], true);
  assert.equal(widenInstrumentVolEnv(rec8, blob).blob, blob);
});

/** A format-`fmtVer` project with instrument 1 = `rec` and its patches. */
function project(fmtVer, rec, blob = null) {
  const image = new Uint8Array(SAMPLEBIN_SIZE + 1024 * 256);
  image.set(rec, SAMPLEBIN_SIZE + 256);
  const ixmp = blob ? [{ instId: 1, count: parsePatchesBlob(blob).length, blob }] : [];
  return new Document({
    kind: "taud", fmtVer, is64Channel: false, signature: "test          ",
    sampleInstImage: image,
    songs: [{
      numVoices: 1, bpm: 125, tickRate: 6, tuningBaseNote: 0, tuningFreq: 0, globalFlags: 0,
      globalVolume: 128, mixingVolume: 128, surroundModel: 0,
      patterns: [], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections: blob ? [{ fourcc: "Ixmp", payload: buildIxmpSection(ixmp) }] : [],
    ixmp,
    meta: { projectName: "", songMeta: {} },
  });
}

test("opening a format-3 project converts its instruments and their patches, and only once", () => {
  const blob = writePatchesBlob([makeInstPatch({
    volEnv: Array.from({ length: 25 }, () => ({ value: 32, offset: 0 })), volEnvLoop: ENV_PRESENT,
  })]);
  const doc = project(3, record([63, 32]), blob);
  assert.equal(doc.upgradeVolEnvelopes(), 1);
  assert.equal(doc.dirty, false, "the file is untouched until it is saved");
  const inst = doc.instruments[1];
  assert.equal(inst.volEnv8, true);
  assert.deepEqual(inst.volEnvelopes.slice(0, 2).map((n) => n.value), [255, widenVolume(32)]);
  assert.equal(inst.extraPatches[0].volEnv[0].value, widenVolume(32));
  assert.equal(doc.upgradeVolEnvelopes(), 0, "nothing left to do");
  // …and it saves that way.
  const again = new Document(parseTaud(doc.toBytes()));
  assert.equal(again.instruments[1].volEnv8, true);
  assert.equal(again.instruments[1].extraPatches[0].volEnv[0].value, widenVolume(32));
  assert.equal(project(2, record([63])).upgradeVolEnvelopes(), 0, "a format-2 document is not the editor's");
});

test("an instrument imported into a format-3 project arrives 8-bit; undo and redo agree", () => {
  const plan = {
    insts: [{ destSlot: 2, record: record([63, 16]), ixmpBlob: null, ixmpCount: 0 }],
    samples: [], inamPayload: null, snamNames: new Map(), writeSnam: false, slotMap: new Map(),
  };
  const doc = project(3, record([255], true));
  const undo = importBankOp(plan).apply(doc);
  assert.equal(doc.instruments[2].volEnv8, true);
  assert.equal(doc.instruments[2].volEnvelopes[1].value, widenVolume(16));
  assert.equal(plan.insts[0].record[14] & INST_VOLENV8, 0, "the plan is left as it was");
  const redo = undo.apply(doc);
  redo.apply(doc);
  assert.equal(doc.instruments[2].volEnvelopes[1].value, widenVolume(16));
  const narrow = project(2, record([63]));
  importBankOp(plan).apply(narrow);
  assert.equal(narrow.instruments[2].volEnv8, false, "a format-2 document takes it as it is");
});
