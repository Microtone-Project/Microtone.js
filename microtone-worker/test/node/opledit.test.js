// OPL instrument editing (item 209) — the Instruments view's OPL tab reads a
// type-8 record's patch as fields and writes it back as record bytes; a new
// instrument starts as IMS Studio's default patch in the first free slot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTaud } from "../../core/format/taud-parse.js";
import { SAMPLEINST_SIZE } from "../../core/format/taud-const.js";
import { OPL_BLOCK_START, OPL_B_OPS, OPL_OP_BYTES } from "../../core/engine/opl.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp, setInstBytesOp } from "../../src/doc/ops.js";
import { planCreateOpl } from "../../src/doc/bankmerge.js";
import {
  oplFields, oplOperator, oplOpBytes, oplKindBytes, oplSwitchBytes, oplChannelBytes,
  oplPartnerMultBytes, oplPartnerDetuneBytes, oplOperatorCount, oplHasPartner,
  defaultOplRecord, oplBadge, OPL_OP_FIELDS,
  OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM, OPL_KIND_TC, OPL_KIND_HH,
} from "../../src/doc/opledit.js";

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

/** A project holding one new OPL instrument, and that instrument's slot. */
function withOpl() {
  const doc = emptyProject();
  doc.undo = new UndoStack(doc);
  const plan = planCreateOpl(doc, defaultOplRecord(), "OPL");
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(importBankOp(plan));
  return { doc, slot: plan.metaSlot };
}

const edit = (doc, slot, pairs) => doc.undo.apply(setInstBytesOp(slot, pairs));

test("a new OPL instrument is IMS Studio's default patch in the first free slot", () => {
  const { doc, slot } = withOpl();
  const inst = doc.instruments[slot];
  assert.equal(slot, 1);
  assert.ok(inst.isOpl && !inst.isMeta);
  assert.equal(doc.instrumentName(slot), "OPL");
  const f = oplFields(inst);
  assert.equal(f.kind, OPL_KIND_2OP);
  assert.deepEqual(
    [f.ops[0].tl, f.ops[0].ar, f.ops[0].dr, f.ops[0].sl, f.ops[0].rr, f.ops[0].eg],
    [32, 15, 4, 4, 6, 1], "a quiet modulator");
  assert.deepEqual(
    [f.ops[1].tl, f.ops[1].ar, f.ops[1].dr, f.ops[1].sl, f.ops[1].rr, f.ops[1].eg],
    [0, 15, 2, 3, 6, 1], "a full-level sustaining carrier");
  assert.equal(oplBadge(inst), "OPL");
  // …and it survives the file.
  const back = new Document(parseTaud(doc.toBytes())).instruments[slot];
  assert.ok(back.isOpl);
  assert.deepEqual([...back.oplRaw], [...inst.oplRaw]);
});

test("every operator field writes its own bits and nothing else", () => {
  const { doc, slot } = withOpl();
  const inst = doc.instruments[slot];
  for (let op = 0; op < 4; op++) {
    for (const { key, max } of OPL_OP_FIELDS) {
      const before = oplOperator(inst, op);
      const value = before[key] === max ? 0 : max;
      const pairs = oplOpBytes(inst, op, key, value);
      assert.equal(pairs.length, 1);
      const at = pairs[0][0] - OPL_BLOCK_START;
      assert.ok(at >= OPL_B_OPS + op * OPL_OP_BYTES && at < OPL_B_OPS + (op + 1) * OPL_OP_BYTES,
        `${key} lands in operator ${op}'s registers`);
      edit(doc, slot, pairs);
      const after = oplOperator(inst, op);
      assert.equal(after[key], value, `operator ${op} ${key}`);
      for (const k of Object.keys(before)) if (k !== key) assert.equal(after[k], before[k], `${key} left ${k} alone`);
      // The decoded patch the engine plays follows at once (TaudInst.setByte).
      if (key === "tl") assert.equal(inst.opl.ops[op].tl, value);
      doc.undo.undo();
      assert.deepEqual(oplOperator(inst, op), before);
    }
  }
});

test("the chip switches, the channels and the partner", () => {
  const { doc, slot } = withOpl();
  const inst = doc.instruments[slot];
  for (const name of ["deepTremolo", "deepVibrato", "nts", "lowFnum"]) {
    edit(doc, slot, oplSwitchBytes(inst, name, true));
    assert.equal(oplFields(inst)[name], true, name);
    assert.equal(oplFields(inst).kind, OPL_KIND_2OP, `${name} kept the kind`);
  }
  edit(doc, slot, oplChannelBytes(inst, 0, "feedback", 5));
  edit(doc, slot, oplChannelBytes(inst, 0, "cnt", 1));
  edit(doc, slot, oplChannelBytes(inst, 1, "cnt", 1));
  let f = oplFields(inst);
  assert.deepEqual([f.feedback, f.cntA, f.cntB], [5, 1, 1]);
  assert.equal(inst.opl.feedback, 5);
  edit(doc, slot, oplPartnerMultBytes(3));
  edit(doc, slot, oplPartnerDetuneBytes(-2389));
  f = oplFields(inst);
  assert.deepEqual([f.partnerMult, f.partnerDetune], [3, -2389]);
  assert.deepEqual(oplPartnerDetuneBytes(1e9).map((p) => p[1]), [0xff, 0x7f], "clamped to S16");
});

test("switching kinds keeps the operators a kind does not show", () => {
  const { doc, slot } = withOpl();
  const inst = doc.instruments[slot];
  const first = [oplOperator(inst, 0), oplOperator(inst, 1)];
  // A fresh second pair has no attack and would silence a four-operator
  // chain, so it starts as IMS Studio's does: the first pair again.
  edit(doc, slot, oplKindBytes(inst, OPL_KIND_4OP));
  assert.equal(oplFields(inst).kind, OPL_KIND_4OP);
  assert.deepEqual([oplOperator(inst, 2), oplOperator(inst, 3)], first);
  assert.equal(oplFields(inst).cntB, oplFields(inst).cntA);
  // Once written, the second pair is the user's: no reseeding over it.
  edit(doc, slot, oplOpBytes(inst, 3, "mult", 7));
  edit(doc, slot, oplKindBytes(inst, OPL_KIND_SD));
  assert.equal(oplOperatorCount(OPL_KIND_SD), 1);
  edit(doc, slot, oplKindBytes(inst, OPL_KIND_4OP));
  assert.equal(oplOperator(inst, 3).mult, 7, "a trip through the snare lost nothing");
  // One undo per kind change.
  doc.undo.undo(); doc.undo.undo(); doc.undo.undo();
  assert.equal(oplFields(inst).kind, OPL_KIND_4OP);
  doc.undo.undo();
  assert.equal(oplFields(inst).kind, OPL_KIND_2OP);
  assert.ok(oplOperator(inst, 2).ar === 0, "the seeded pair went with its kind");
});

test("kind helpers: operator counts, partners, badges", () => {
  assert.deepEqual(
    [OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM, OPL_KIND_TC, OPL_KIND_HH]
      .map(oplOperatorCount), [2, 4, 2, 1, 1, 1, 1]);
  assert.deepEqual(
    [OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM, OPL_KIND_TC, OPL_KIND_HH].map(oplHasPartner),
    [false, true, false, true, true]);
  const { doc, slot } = withOpl();
  const inst = doc.instruments[slot];
  const badges = [];
  for (let k = 0; k <= 6; k++) {
    edit(doc, slot, oplKindBytes(inst, k));
    badges.push(oplBadge(inst));
  }
  assert.deepEqual(badges, ["OPL", "OPL·4", "OPL·BD", "OPL·SD", "OPL·TOM", "OPL·CY", "OPL·HH"]);
});
