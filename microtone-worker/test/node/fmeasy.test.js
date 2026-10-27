// FM Easy Mode (item 247) — the overlay over a type-4 rack (doc/fmeasy.js),
// the plans that make its instruments (bankmerge planEasyFm / planEasyConvert),
// and the one engine rule it brought along, S $Apsd.
//
// The contract pinned here is the two-way one: an Easy model written as a rack
// and read back is the same model; a rack read as Easy and written back sounds
// the same. Everything else is the pieces that make that true — the presets,
// the feedback unit, the multiplier — and the racks it must refuse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EASY_PRESETS, EASY_PRESET_FORMULAS, EASY_FB_OCTETS, OCTET_UNITY, parseEasyFormula,
  easyDecode, easyCompile, easyFill, easyNeeds, easyNewModel, easyFormula, easyPresetOf,
  easyApplyPreset, easyToggleWire, easyToggleCarrier, easySetFeedback, easyWireKind,
  easySplitDetune, easyJoinDetune, easyFbAmount, easyRemoveOperator, easyAddOperator,
  easyRecordOf, easyTree,
} from "../../src/doc/fmeasy.js";
import { fmValidate, fmOperators, fmProgramOf, fmFormula } from "../../src/doc/fmedit.js";
import { fmTreeGraph } from "../../src/doc/fmlayout.js";
import { planEasyFm, planEasyConvert, planCreateFm } from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { Document } from "../../src/doc/document.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import {
  makeMetaLayer, FM_WORD_OSC as OSC0, FM_WORD_MOD as MOD0, FM_WORD_FB as FB0, FmOp, TaudInst,
  buildMetaRecord, META_TYPE_FM,
} from "../../core/engine/inst.js";
import { fmPrincipalIsDsp } from "../../core/engine/fm.js";
import { META_MIX_GAIN, EffectOp } from "../../core/engine/tables.js";

setSamplingRate(32000);

const OSC = (k) => OSC0 | k, MOD = (k) => MOD0 | k, FB = (k) => FB0 | k;
const entry = (slot, mix = OCTET_UNITY, detune = 0) => makeMetaLayer(slot, mix, detune, 0, 0xffff, 0, 63);
/** A model with every operator given a made-up instrument, ready to compile. */
const filled = (model) => easyFill({ ...model, principal: { ...model.principal, instIdx: 0x1ff } },
  easyNeeds(model).osc.map((i) => 0x100 + i), 0x1fe);
const demo = () => new Document(parseTaud(readFileSync(
  new URL("../../assets/demo_projects/Daisy_bell.taud", import.meta.url))));

// ── the presets ─────────────────────────────────────────────────────────────

test("forty presets: two of two operators, six of four, thirty-two of six", () => {
  assert.equal(EASY_PRESETS.length, 40);
  const counts = EASY_PRESETS.map((p) => p.count);
  assert.deepEqual(counts.slice(0, 2), [2, 2]);
  assert.deepEqual(counts.slice(2, 8), [4, 4, 4, 4, 4, 4]);
  assert.ok(counts.slice(8).every((n) => n === 6));
  // Every preset has exactly one feedback loop, as the classic algorithms do.
  for (const p of EASY_PRESETS) assert.equal(p.feedback.length, 1, `preset ${p.n}`);
});

test("every preset round-trips: Easy → rack → Easy is the identity, and reads back as its formula", () => {
  for (const p of EASY_PRESETS) {
    const m = filled(easyNewModel(p.n));
    const rack = easyCompile(m);
    assert.ok(fmValidate(rack.program, rack.ops.length).ok, `preset ${p.n} verifies`);
    assert.ok(fmPrincipalIsDsp(rack.program), `preset ${p.n}: the principal is DSP-only`);
    const back = easyDecode(rack.ops, rack.program);
    assert.ok(back.ok, `preset ${p.n}: ${back.reason}`);
    assert.deepEqual(back.model, m, `preset ${p.n}: the model comes back`);
    assert.deepEqual(easyCompile(back.model), rack, `preset ${p.n}: the words come back`);
    assert.equal(easyFormula(back.model), p.formula);
    assert.equal(easyPresetOf(back.model), p.n);
  }
});

test("a shared modulator is one operator, and a formula's spare parentheses mean nothing", () => {
  const a = parseEasyFormula("2[(0 + 1)] + (4[3[3′]] + 5[3[3′]])");
  const b = parseEasyFormula(EASY_PRESET_FORMULAS[27]);
  assert.deepEqual(a, b);
  assert.deepEqual(b.mods[4], [3]);
  assert.deepEqual(b.mods[5], [3]);
  assert.deepEqual(b.feedback, [{ from: 3, to: 3 }]);
  assert.throws(() => parseEasyFormula("1[0] + 2[0[0′]]"), /two ways/);
});

test("the diagram draws every preset on its grid", () => {
  for (const p of EASY_PRESETS) {
    const g = fmTreeGraph(easyTree(easyNewModel(p.n)));
    const ops = new Set(g.cells.filter((c) => c.kind === "op").map((c) => c.op));
    assert.equal(ops.size, p.count, `preset ${p.n} shows every operator`);
  }
});

// ── the units ───────────────────────────────────────────────────────────────

test("feedback 0…7 is 0, π/16 … 4π: octets within 1.2 % of 1/32 … 2 cycles, 2π exactly unity", () => {
  assert.equal(EASY_FB_OCTETS[0], 0);
  assert.equal(EASY_FB_OCTETS[6], OCTET_UNITY);
  for (let n = 1; n < 8; n++) {
    const want = 2 ** (n - 6);
    const got = META_MIX_GAIN[EASY_FB_OCTETS[n]];
    assert.ok(Math.abs(got / want - 1) < 0.012, `amount ${n}: ${got} for ${want}`);
    assert.deepEqual(easyFbAmount(EASY_FB_OCTETS[n]), { amount: n, exact: true });
  }
  assert.deepEqual(easyFbAmount(100), { amount: 5, exact: false }, "an odd octet reads as its nearest");
});

test("a loop at 2π is a bare tap and costs no constant; any other depth costs one", () => {
  const m = filled(easySetFeedback(easyNewModel(2), 0, 0, EASY_FB_OCTETS[6]));
  const rack = easyCompile(m);
  assert.equal(rack.ops.length, 3, "principal + two operators");
  assert.ok(!rack.program.includes(FmOp.MUL) || rack.program.indexOf(FmOp.MUL) === rack.program.length - 1);
  const deep = easyCompile(filled(easySetFeedback(easyNewModel(2), 0, 0, EASY_FB_OCTETS[3])));
  assert.equal(deep.ops.length, 4, "…plus the depth's constant");
  assert.equal(deep.ops[3].mixOctet, EASY_FB_OCTETS[3]);
});

test("multiplier and detune are one field: detune = fine + 4096 × multiplier, fine within half an octave", () => {
  for (let d = -32768; d <= 32767; d += 37) {
    const { mult, fine } = easySplitDetune(d);
    assert.ok(fine >= -2048 && fine <= 2047, `${d}: fine ${fine}`);
    assert.equal(fine + 4096 * mult, d);
    if (mult >= -8 && mult <= 7) assert.equal(easyJoinDetune(mult, fine), d);
  }
  assert.deepEqual(easySplitDetune(4096), { mult: 1, fine: 0 });
  assert.deepEqual(easySplitDetune(-8192), { mult: -2, fine: 0 });
  assert.equal(Object.is(easySplitDetune(-100).mult, -0), false, "never −0");
});

test("the S16 top is multiplier 8 with no fine: lowering the multiplier leaves no off-by-one", () => {
  const top = easyJoinDetune(8, 0);
  assert.equal(top, 32767);
  assert.deepEqual(easySplitDetune(top), { mult: 8, fine: 0 });
  assert.equal(easyJoinDetune(7, easySplitDetune(top).fine), 7 * 4096);
});

// ── reading a rack as Easy Mode ─────────────────────────────────────────────

const ops4 = [entry(0x1ff), entry(0x100), entry(0x101), entry(0x102)];

test("an FM tab's own spelling still reads: DUP for a shared modulator, a bare tap, constants mid-table", () => {
  // 2[1′ × 3] is a loop through a constant that sits BEFORE an oscillator;
  // op 1 feeds both 2 and 3 by DUP. Table: P, osc 1, constant 2, osc 3.
  const opsMixed = [entry(0x1ff), entry(0x100), entry(0x1fe, EASY_FB_OCTETS[2]), entry(0x101)];
  const program = [FB(1), OSC(2), FmOp.MUL, MOD(1), FmOp.DUP, MOD(3), FmOp.SWAP, FmOp.ADD, OSC(0), FmOp.MUL];
  const d = easyDecode(opsMixed, program);
  assert.ok(d.ok, d.reason);
  assert.deepEqual(d.model.labels, [0, 2], "labels are table positions less one — what S $Apsd addresses");
  assert.deepEqual(d.model.carriers, [0, 1]);
  assert.deepEqual(d.model.mods, [[], [0]]);
  assert.equal(d.model.feedback[0].octet, EASY_FB_OCTETS[2]);
  // …and writing it back is canonical: constants last, labels dense.
  const again = easyDecode(...Object.values(easyCompile(d.model)));
  assert.ok(again.ok);
  assert.deepEqual(again.model.labels, [0, 1]);
});

test("what Easy Mode cannot show is refused, with the reason", () => {
  const no = (program, reason, ops = ops4) => assert.equal(easyDecode(ops, program).reason, reason);
  no([OSC(1), FmOp.NEG, OSC(0), FmOp.MUL], "sign");
  no([OSC(1), OSC(2), FmOp.MUL, OSC(0), FmOp.MUL], "ring");
  no([OSC(1), OSC(2), OSC(0), FmOp.MUL], "leftover");
  no([OSC(1), MOD(0)], "principal", [entry(0x1ff), entry(0x100)]);
  no([OSC(0), OSC(1), FmOp.ADD, OSC(0), FmOp.MUL], "principal");
  no([FB(1), OSC(0), FmOp.MUL], "shape", [entry(0x1ff), entry(0x100)]);
  no([OSC(1), OSC(1), FmOp.ADD, OSC(0), FmOp.MUL], "twice", [entry(0x1ff), entry(0x100)]);
  // A constant that is also heard.
  no([FB(1), OSC(2), FmOp.MUL, MOD(1), OSC(2), FmOp.ADD, OSC(0), FmOp.MUL], "constant", ops4.slice(0, 3));
});

// ── editing ─────────────────────────────────────────────────────────────────

test("a wire that would close a loop is a feedback loop; the same wire again removes it", () => {
  const m = easyNewModel(3); // 3[2[1[0[0′]]]]
  assert.equal(easyWireKind(m, 0, 2), "mod", "0 into 2 is more modulation");
  assert.equal(easyWireKind(m, 3, 0), "fb", "0 feeds 3, so 3 into 0 is a loop");
  assert.equal(easyWireKind(m, 1, 0), "fb");
  assert.equal(easyWireKind(m, 2, 2), "fb", "into itself");
  const a = easyToggleWire(m, 3, 0);
  assert.ok(a.feedback.some((f) => f.from === 3 && f.to === 0 && f.octet === 0), "a new loop starts silent");
  assert.deepEqual(easyToggleWire(a, 3, 0), m);
  const b = easyToggleWire(easyAddOperator(m), 4, 3);
  assert.deepEqual(b.mods[3], [2, 4]);
  assert.equal(easyToggleCarrier(m, 3).carriers.length, 1, "the last carrier stays");
});

test("rewiring to another preset keeps the operators it can and adds blank ones", () => {
  const two = filled(easyNewModel(1));
  const tuned = { ...two, ops: two.ops.map((o, i) => ({ ...o, detune: 4096 * (i + 1) })) };
  const six = easyApplyPreset(easySetFeedback(tuned, 0, 0, EASY_FB_OCTETS[4]), 9);
  assert.equal(six.ops.length, 6);
  assert.equal(six.ops[0].detune, 4096);
  assert.equal(six.ops[1].detune, 8192);
  assert.deepEqual(easyNeeds(six).osc, [2, 3, 4, 5]);
  assert.equal(six.feedback[0].octet, EASY_FB_OCTETS[4], "the loop keeps its depth");
  const back = easyApplyPreset(filled(six), 2);
  assert.equal(back.ops.length, 2);
  assert.equal(easyRemoveOperator(easyNewModel(1), 0).ops.length, 1);
});

// ── the plans ───────────────────────────────────────────────────────────────

test("a new Easy rack makes its own instruments, once per project for the waveforms", () => {
  const doc = demo();
  const a = planEasyFm(doc, null, easyNewModel(9), "Easy");
  assert.equal(a.error, undefined);
  importBankOp(a).apply(doc);
  const inst = doc.instruments[a.metaSlot];
  assert.ok(inst.isFm);
  assert.equal(inst.metaRaw[0] & 1, 1, "the Easy Mode bit");
  assert.equal(inst.metaStrict, false, "…which is not strict layering in a rack");
  assert.equal(a.childSlots.length, 8, "six sines, a principal, a constant");
  assert.equal(a.newSampleBytes, 256 + 16);
  const d = easyDecode(fmOperators(inst), fmProgramOf(inst));
  assert.ok(d.ok);
  assert.equal(easyPresetOf(d.model), 9);

  const b = planEasyFm(doc, null, easySetFeedback(easyNewModel(1), 0, 0, EASY_FB_OCTETS[5]), "Easy 2");
  importBankOp(b).apply(doc);
  assert.equal(b.newSampleBytes, 0, "the sine and the constant are already in the pool");
  assert.equal(b.childSlots.length, 3, "two sines and a principal — the constant is shared");
  // A plain rewire needs no plan at all.
  const rec = easyRecordOf(doc.instruments[b.metaSlot], easyToggleCarrier(
    easyDecode(fmOperators(doc.instruments[b.metaSlot]), fmProgramOf(doc.instruments[b.metaSlot])).model, 0));
  assert.ok(rec instanceof Uint8Array);
});

/** Render `slot` playing C-4 for `chunks` chunks; the U8 of every chunk. */
function renderNote(doc, slot, chunks, effect = null) {
  const eng = new TaudEngine();
  eng.sampleBin.set(doc.sampleBin);
  for (const s of doc.usedInstrumentSlots()) eng.uploadInstrument(s, doc.instRecordBytes(s));
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = slot;
  if (effect) { pat[5] = effect.op; pat[6] = effect.arg & 0xff; pat[7] = effect.arg >>> 8; }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const out = [];
  for (let i = 0; i < chunks; i++) {
    const buf = new Uint8Array(TRACKER_CHUNK * 2);
    eng.renderChunk(0, buf);
    out.push(buf);
  }
  return { out, eng };
}

test("turning Easy Mode on wraps an ordinary rack in a principal, and it sounds the same", () => {
  const doc = demo();
  const sampled = (s) => !doc.instruments[s].isMeta && !doc.instruments[s].isHighMeta &&
    doc.instruments[s].sampleLength > 0;
  const cands = doc.selectableInstrumentSlots().filter(sampled);
  const p = planCreateFm(doc, [{ slot: cands[0], count: 2 }], "Plain"); // 0[1]
  importBankOp(p).apply(doc);
  const before = renderNote(doc, p.metaSlot, 24).out;

  const cv = planEasyConvert(doc, p.metaSlot);
  assert.equal(cv.kind, "wrap");
  importBankOp(cv.plan).apply(doc);
  const inst = doc.instruments[p.metaSlot];
  assert.equal(fmFormula([...inst.fmProgram], inst.metaLayers.length), "1[2] × 0");
  assert.ok(easyDecode(fmOperators(inst), fmProgramOf(inst)).ok);
  const after = renderNote(doc, p.metaSlot, 24).out;
  // The note's first samples hold the anti-click attack, which the old
  // principal now takes twice (as an operator, and through the new principal),
  // and the output stage remembers that for a few chunks; after it the two are
  // the same sound to the bit — the new principal multiplies by exactly 1.0.
  for (let i = 4; i < 24; i++) assert.deepEqual(after[i], before[i], `chunk ${i}`);

  // …and a rack that already reads as Easy Mode only needs its bit.
  assert.equal(planEasyConvert(doc, p.metaSlot).kind, "flag");
});

test("a rack that ring-modulates can't be converted, and says why", () => {
  const doc = demo();
  const cands = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta);
  const p = planCreateFm(doc, [{ slot: cands[0], count: 2 }], "Ring");
  importBankOp(p).apply(doc);
  const inst = doc.instruments[p.metaSlot];
  inst.loadRecord(buildMetaRecord(fmOperators(inst), { type: META_TYPE_FM, program: [OSC(0), OSC(1), FmOp.MUL] }));
  const cv = planEasyConvert(doc, p.metaSlot);
  assert.equal(cv.reason, "ring");
});

// ── S $Apsd ─────────────────────────────────────────────────────────────────

test("the principal is DSP-only exactly when the program ends × operator 0 and names it nowhere else", () => {
  assert.equal(fmPrincipalIsDsp(Uint16Array.from([OSC(1), OSC(0), FmOp.MUL])), true);
  assert.equal(fmPrincipalIsDsp(Uint16Array.from([OSC(1), MOD(0)])), false);
  assert.equal(fmPrincipalIsDsp(Uint16Array.from([FB(0), OSC(1), FmOp.ADD, OSC(0), FmOp.MUL])), false);
  assert.equal(fmPrincipalIsDsp(Uint16Array.from([OSC(0), OSC(1), FmOp.MUL])), false);
  assert.equal(fmPrincipalIsDsp(null), false);
});

test("S $Apsd sets operator p's auto-vibrato for the note — past the principal on an Easy rack", () => {
  const doc = demo();
  const a = planEasyFm(doc, null, easyNewModel(2), "Easy");
  importBankOp(a).apply(doc);
  // Operator 1 of the Easy rack is table entry 2; speed 3, depth 5.
  const { eng } = renderNote(doc, a.metaSlot, 2, { op: EffectOp.OP_S, arg: 0xa135 });
  const rig = eng.playheads[0].trackerState.voices[0].fmRig;
  assert.ok(rig, "the lane sounds the rack");
  assert.equal(rig.voices[2].activeVibratoSpeed, 3 * 17);
  assert.equal(rig.voices[2].activeVibratoDepth, 5 * 17);
  assert.equal(rig.voices[1].activeVibratoDepth, 0, "operator 0 untouched");

  // An ordinary rack counts from its principal.
  const cands = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta && !doc.instruments[s].isFm);
  const p = planCreateFm(doc, [{ slot: cands[0], count: 1 }, { slot: cands[1], count: 1 }], "Plain");
  importBankOp(p).apply(doc);
  const plain = renderNote(doc, p.metaSlot, 2, { op: EffectOp.OP_S, arg: 0xa1f0 }).eng;
  const rig2 = plain.playheads[0].trackerState.voices[0].fmRig;
  assert.equal(rig2.voices[1].activeVibratoSpeed, 255);
  assert.equal(rig2.voices[1].activeVibratoDepth, 0);
});

test("the Easy Mode bit survives a flag edit and reads as nothing to the engine", () => {
  const rec = buildMetaRecord([entry(0x101), entry(0x102)], {
    type: META_TYPE_FM, program: [OSC(1), OSC(0), FmOp.MUL], easy: true,
  });
  assert.equal(rec[0] & 1, 1);
  const inst = new TaudInst(5);
  inst.loadRecord(rec);
  assert.equal(inst.metaStrict, false);
  assert.ok(inst.isFm);
});
