// OPL instrument → Easy Mode FM rack (item 356): the rack takes the OPL
// instrument's slot, wires the chip's connection, and sounds near enough the
// chip at middle C — the same loudness, the same leading harmonics.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp } from "../../src/doc/ops.js";
import { planCreateOpl, planOplFm } from "../../src/doc/bankmerge.js";
import { defaultOplRecord } from "../../src/doc/opledit.js";
import { easyDecode } from "../../src/doc/fmeasy.js";
import { fmOperators, fmProgramOf } from "../../src/doc/fmedit.js";
import { metaFlags } from "../../src/doc/metaedit.js";
import {
  oplWaveValue, oplRackSpec, oplVolumeEnvelope, snapEnvelope, OPL_FM_KINDS,
} from "../../src/doc/opltofm.js";
import {
  encodeOplPatch, decodeOplPatch, OPL_BLOCK_START, OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_SD, OPL_KIND_HH,
} from "../../core/engine/opl.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";
import { SAMPLEINST_SIZE } from "../../core/format/taud-const.js";
import { minifloatToDouble, minifloatFromDouble } from "../../core/engine/minifloat.js";

function project() {
  const pats = [new Uint8Array(512)];
  for (let r = 0; r < 64; r++) { pats[0][r * 8 + 3] = 0xc0; pats[0][r * 8 + 4] = 0xc0; }
  const cue = new Uint16Array(64).fill(0x7fff);
  cue[0] = 0;
  const doc = new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: new Uint8Array(SAMPLEINST_SIZE),
    songs: [{ numVoices: 32, bpm: 125, tickRate: 6, tuningBaseNote: 0x5c00, tuningFreq: 440, globalFlags: 1,
      globalVolume: 255, mixingVolume: 255, patterns: pats, cues: [cue] }],
    projSections: [], ixmp: [], meta: { projectName: "t", songMeta: {} },
  });
  doc.undo = new UndoStack(doc);
  return doc;
}

/** A project with one OPL instrument (record `rec`) playing C4 from row 0. */
function withOpl(rec) {
  const doc = project();
  const plan = planCreateOpl(doc, rec, "Chip");
  doc.undo.apply(importBankOp(plan));
  const c = doc.songs[0].patterns[0][0];
  c.note = 0x5000;
  c.instrment = plan.metaSlot;
  return { doc, slot: plan.metaSlot };
}

function render(doc, seconds = 1) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc.toRenderable(0), 0);
  return renderSong(eng, seconds).f32;
}

/** Magnitude (dB) of harmonics 1…n of f0 over [t0, t1) s, Hann-windowed. */
function harmonics(f32, f0, t0, t1, n = 6) {
  const a = Math.round(t0 * 48000), b = Math.round(t1 * 48000);
  return Array.from({ length: n }, (_, k) => {
    let re = 0, im = 0;
    for (let i = a; i < b; i++) {
      const v = (f32[2 * i] + f32[2 * i + 1]) / 2;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
      const ph = (2 * Math.PI * (k + 1) * f0 * i) / 48000;
      re += v * w * Math.cos(ph);
      im += v * w * Math.sin(ph);
    }
    return 20 * Math.log10((Math.hypot(re, im) / (b - a)) * 4 + 1e-12);
  });
}

test("the waveforms are the chip's eight shapes", () => {
  const at = (ws, p) => oplWaveValue(ws, p);
  assert.ok(Math.abs(at(0, 256) - 1) < 1e-9 && Math.abs(at(0, 768) + 1) < 1e-9, "sine");
  assert.equal(at(1, 768), 0, "half sine: silent in the second half");
  assert.ok(at(2, 768) > 0.99, "absolute sine");
  assert.equal(at(3, 300), 0, "pulse sine: off in the second quarter");
  assert.ok(Math.abs(at(4, 128) - 1) < 1e-9 && at(4, 600) === 0, "even sine");
  assert.equal(at(6, 100), 1);
  assert.equal(at(6, 600), -1);
  assert.equal(at(7, 0), 1, "log saw starts full");
  assert.ok(at(7, 511) < 1e-4 && at(7, 1023) < 0, "…falls 96 dB, then the negative half");
});

test("an envelope stays on the record's time grid and follows the chip's times", () => {
  // A slow attack and decay with EG-TYP: held at the sustain level, then the release.
  const op = { ar: 4, dr: 3, sl: 64, rr: 4, eg: 1 };
  const { env, release } = oplVolumeEnvelope(op, 1);
  assert.ok(env.sustain !== null && env.points[env.sustain][1] > 15 && env.points[env.sustain][1] < 17, "−12 dB sustain");
  assert.ok(release > 0);
  for (const [t] of env.points) {
    // every node time is a sum of minifloat steps the record can hold
    assert.ok(Number.isFinite(t));
  }
  const pts = [[0, 0], [0.001, 10], [0.0015, 20], [0.5, 63], [0.5004, 30], [2, 0]];
  const s = snapEnvelope(pts, 3);
  for (let i = 1; i < s.points.length; i++) {
    const dt = s.points[i][0] - s.points[i - 1][0];
    assert.equal(minifloatToDouble(minifloatFromDouble(dt)), dt, "a node time the record holds");
  }
  assert.equal(s.points[s.sustain][1], 63, "the sustain point survives the snap");
  assert.ok(Math.abs(s.points[s.points.length - 1][0] - 2) < 0.03, "no drift over the envelope");
});

test("the connection becomes the rack's wiring", () => {
  const patch = (o) => decodeOplPatch(encodeOplPatch({ ops: [{ ar: 15, mult: 1 }, { ar: 15, mult: 1 }, { ar: 15, mult: 1 }, { ar: 15, mult: 1 }], ...o }));
  const wiring = (o) => { const r = oplRackSpec(patch(o)); return { mods: r.mods, carriers: r.carriers }; };
  assert.deepEqual(wiring({ kind: OPL_KIND_2OP, cntA: 0 }), { mods: [[], [0]], carriers: [1] });
  assert.deepEqual(wiring({ kind: OPL_KIND_2OP, cntA: 1 }), { mods: [[], []], carriers: [0, 1] });
  assert.deepEqual(wiring({ kind: OPL_KIND_4OP, cntA: 0, cntB: 0 }), { mods: [[], [0], [1], [2]], carriers: [3] });
  assert.deepEqual(wiring({ kind: OPL_KIND_4OP, cntA: 0, cntB: 1 }), { mods: [[], [0], [], [2]], carriers: [1, 3] });
  assert.deepEqual(wiring({ kind: OPL_KIND_4OP, cntA: 1, cntB: 0 }), { mods: [[], [], [1], [2]], carriers: [0, 3] });
  assert.deepEqual(wiring({ kind: OPL_KIND_4OP, cntA: 1, cntB: 1 }), { mods: [[], [], [1], []], carriers: [0, 2, 3] });
  for (const kind of [OPL_KIND_SD, OPL_KIND_HH]) {
    assert.ok(!OPL_FM_KINDS.includes(kind));
    assert.deepEqual(oplRackSpec(patch({ kind })), { error: "noise" });
  }
  // Multipliers: MULT 0 is ×½, 11 is ×10, 15 is ×15.
  const r = oplRackSpec(decodeOplPatch(encodeOplPatch({ ops: [{ ar: 15, mult: 0 }, { ar: 15, mult: 11 }] })));
  assert.deepEqual(r.ops.map((o) => o.ratio), [0.5, 10]);
});

test("an OPL instrument becomes an Easy rack in its own slot, one undo step, and sounds like it", () => {
  const { doc, slot } = withOpl(defaultOplRecord());
  const before = render(doc);
  const plan = planOplFm(doc, slot);
  assert.equal(plan.error, undefined);
  doc.undo.apply(importBankOp(plan));
  const inst = doc.instruments[slot];
  assert.ok(inst.isFm && !inst.isOpl);
  assert.ok(metaFlags(inst).easy);
  const decoded = easyDecode(fmOperators(inst), fmProgramOf(inst));
  assert.ok(decoded.ok, decoded.reason);
  assert.equal(decoded.model.ops.length, 2);
  const after = render(doc);
  const f0 = 261.6255653005986;
  const a = harmonics(before, f0, 0.2, 0.6), b = harmonics(after, f0, 0.2, 0.6);
  assert.ok(Math.abs(a[0] - b[0]) < 1.5, `the fundamental: ${a[0].toFixed(1)} vs ${b[0].toFixed(1)} dB`);
  for (let k = 0; k < a.length; k++) {
    if (a[k] < a[0] - 30) continue;
    assert.ok(Math.abs(a[k] - b[k]) < 4, `harmonic ${k + 1}: ${a[k].toFixed(1)} vs ${b[k].toFixed(1)} dB`);
  }
  // Undo brings the chip back.
  doc.undo.undo();
  assert.ok(doc.instruments[slot].isOpl);
});

test("feedback is a loop on operator 1, as deep as the chip's", () => {
  const rec = defaultOplRecord();
  rec[OPL_BLOCK_START + 1] = (rec[OPL_BLOCK_START + 1] & 1) | (6 << 1);
  const { doc, slot } = withOpl(rec);
  const before = render(doc);
  const plan = planOplFm(doc, slot);
  doc.undo.apply(importBankOp(plan));
  assert.deepEqual(plan.model.feedback.map((f) => [f.from, f.to]), [[0, 0]]);
  const after = render(doc);
  const f0 = 261.6255653005986;
  const a = harmonics(before, f0, 0.2, 0.6), b = harmonics(after, f0, 0.2, 0.6);
  for (let k = 0; k < a.length; k++) {
    if (a[k] < a[0] - 30) continue;
    assert.ok(Math.abs(a[k] - b[k]) < 5, `harmonic ${k + 1}: ${a[k].toFixed(1)} vs ${b[k].toFixed(1)} dB`);
  }
});

test("what the chip has and a rack does not is reported; noise drums and sub-instruments are refused", () => {
  const rec = defaultOplRecord();
  rec[OPL_BLOCK_START + 6] |= 0x80; // operator 1: AM
  const { doc, slot } = withOpl(rec);
  assert.ok(planOplFm(doc, slot).lost.includes("tremolo"));
  const sd = defaultOplRecord();
  sd[OPL_BLOCK_START] = (sd[OPL_BLOCK_START] & ~7) | OPL_KIND_SD;
  const d2 = withOpl(sd);
  assert.equal(planOplFm(d2.doc, d2.slot).reason, "noise");
  assert.equal(planOplFm(doc, 0x100).reason, "notOpl");
});
