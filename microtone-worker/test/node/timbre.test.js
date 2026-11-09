// The Timbre designer (item 307): the roughness model it measures with
// (core/tuning/consonance.js, checked against Sethares' own `dissmeasure` —
// tsvm reference_materials/sethares/), the design maths (core/tuning/
// timbre.js), the settings → rack spec (doc/timbredesign.js) and the plan that
// writes it as an Easy Mode rack (bankmerge planTimbreFm).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pairRoughness, crossRoughness, setharesDissonance } from "../../core/tuning/consonance.js";
import {
  gridOf, stepRatio, designTimbre, gridReport, rankChords, decayPoints, extraDecayRate,
  harmonicPartials, defaultTargets,
} from "../../core/tuning/timbre.js";
import { pitchTablePresets } from "../../core/tuning/pitchtables.js";
import {
  defaultTimbreSettings, designFromSettings, designReport, timbreSpec, timbreVoices, releaseFadeout,
} from "../../src/doc/timbredesign.js";
import { planTimbreFm, planEasyFm, planCreateFm } from "../../src/doc/bankmerge.js";
import { easyDecode, easyNewModel } from "../../src/doc/fmeasy.js";
import { fmOperators, fmProgramOf } from "../../src/doc/fmedit.js";
import { importBankOp } from "../../src/doc/ops.js";
import { Document } from "../../src/doc/document.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";

setSamplingRate(32000);

const demo = () => new Document(parseTaud(readFileSync(
  new URL("../../assets/demo_projects/Daisy_bell.taud", import.meta.url))));
const EDO8 = { n: 8, periodCents: 1200 };

// ── the model ───────────────────────────────────────────────────────────────

test("roughness is Sethares' dissmeasure: his constants, and the MIN of the two amplitudes", () => {
  const f1 = 440, f2 = 466;
  const s = 0.24 / (0.0207 * f1 + 18.96);
  const want = 0.5 * (Math.exp(-3.51 * s * (f2 - f1)) - Math.exp(-5.75 * s * (f2 - f1)));
  assert.ok(Math.abs(pairRoughness(f1, 1, f2, 0.5) - want) < 1e-15);
  assert.equal(pairRoughness(f1, 1, f2, 0.5), pairRoughness(f1, 0.5, f2, 0.5), "the louder partial adds nothing");
  assert.equal(pairRoughness(f1, 0.3, f2, 0.7), pairRoughness(f2, 0.7, f1, 0.3), "symmetric");
  assert.equal(pairRoughness(f1, 1, f1, 1), 0, "a unison does not beat");
  assert.equal(crossRoughness([[f1, 1]], [[f2, 0.5]]), pairRoughness(f1, 1, f2, 0.5));
  // the harmonic transpose's metric still orders a semitone above a sixth
  assert.ok(setharesDissonance(0x4000, 0x4000 + 0x155) > setharesDissonance(0x4000, 0x4000 + 0x955));
});

// ── grids ───────────────────────────────────────────────────────────────────

test("an equal notation is a grid; ProTracker's table and an unequal one are not", () => {
  assert.deepEqual(gridOf(pitchTablePresets[80]), { n: 8, periodCents: 1200 });
  assert.deepEqual(gridOf(pitchTablePresets[120]), { n: 12, periodCents: 1200 });
  assert.equal(gridOf(pitchTablePresets[310]).n, 31, "31-TET's table rounds to the 4096 grid, within a unit");
  const bp = gridOf(pitchTablePresets[35130]);
  assert.equal(bp.n, 13);
  assert.ok(Math.abs(bp.periodCents - 1200 * Math.log2(3)) < 0.5, "Bohlen–Pierce's period is a 3:1");
  assert.equal(gridOf(pitchTablePresets[1]), null, "ProTracker pitch is a table of notes");
  assert.equal(gridOf({ table: [0, 0x200, 0x500], interval: 0x1000 }), null, "unequal steps");
  assert.equal(stepRatio(EDO8, 8), 2);
});

test("a fine grid aims at the steps nearest simple ratios, a coarse one at every step", () => {
  assert.deepEqual(defaultTargets(EDO8).map(([k]) => k), [1, 2, 3, 4, 5, 6, 7, 8]);
  const t31 = defaultTargets({ n: 31, periodCents: 1200 }).map(([k]) => k);
  for (const k of [8, 10, 13, 18, 31]) assert.ok(t31.includes(k), `31-EDO step ${k}`); // 6/5 5/4 4/3 3/2 2/1
  assert.ok(t31.length < 31);
});

// ── the design ──────────────────────────────────────────────────────────────

test("tempering the harmonics onto 8-EDO puts its 300, 450, 750 and 900 cents in valleys", () => {
  const plain = harmonicPartials(8, "bright");
  const tempered = designTimbre({ grid: EDO8, partials: 8, shape: "bright", freedom: 0 }).partials;
  assert.deepEqual(tempered.map((p) => p.step), [0, 8, 13, 16, 19, 21, 22, 24]);
  for (const p of tempered) assert.equal(p.ratio, stepRatio(EDO8, p.step), "every partial on the grid");
  const valley = (ps, k) => gridReport(ps, EDO8, { steps: [k] })[0].margin > 0;
  for (const k of [2, 3, 5, 6, 8]) assert.ok(valley(tempered, k), `step ${k} on the tempered spectrum`);
  assert.ok(!valley(plain, 5), "the 750-cent fifth is no valley on the plain harmonic spectrum");
});

test("the search improves on the tempered series, deterministically", () => {
  const opts = { grid: EDO8, partials: 6, shape: "bright", f0: 261.6256, freedom: 1, seed: 8, restarts: 8, iterations: 2000,
    targets: { 1: 0.3, 2: 1.2, 3: 1.5, 4: 0.8, 5: 2, 6: 1.2, 7: 0.7, 8: 2 } };
  const a = designTimbre(opts), b = designTimbre(opts);
  assert.deepEqual(a.partials, b.partials);
  assert.ok(a.score <= a.start.score);
  // "Eightfold Baffling Incongruity Theorem"'s Tempered Twin, designed with these settings
  assert.deepEqual(a.partials.map((p) => p.step), [0, 8, 13, 16, 19, 21]);
  // …and its keys, five partials, which the search moves off the tempered series
  const keys = designTimbre({ ...opts, partials: 5 });
  assert.deepEqual(keys.partials.map((p) => p.step), [0, 8, 13, 15, 18]);
  assert.ok(keys.score < keys.start.score);
});

test("on tempered 8-EDO harmonics, three of the four smoothest triads are readings of {0, 3, 5}", () => {
  // Within the octave, octave doublings left out: 0-3-6 and 0-3-5 first, then
  // the fifth with 300 cents on top (0-5-7) and the minor reading (0-2-5),
  // all but tied. The order beyond the first two depends on the spectrum.
  const ps = designTimbre({ grid: EDO8, partials: 6, shape: "bright", freedom: 0 }).partials;
  const best = rankChords(ps, EDO8, { size: 3 }).filter((c) => !c.chord.includes(8)).slice(0, 4)
    .map((c) => c.chord.join(" "));
  assert.deepEqual(best.slice(0, 2), ["0 3 6", "0 3 5"]);
  assert.deepEqual([...best.slice(2)].sort(), ["0 2 5", "0 5 7"]);
});

test("Bohlen–Pierce: partials on 13 steps of a 3:1", () => {
  const bp = gridOf(pitchTablePresets[35130]);
  const d = designTimbre({ grid: bp, partials: 5, shape: "soft", freedom: 0 });
  // on the NOTATION's grid (its period is 6492 units, 1901.95 cents), within a hair of 3^(k/13)
  for (const p of d.partials) {
    assert.equal(p.ratio, stepRatio(bp, p.step));
    assert.ok(Math.abs(p.ratio / 3 ** (p.step / 13) - 1) < 1e-4);
  }
  assert.equal(d.partials.find((p) => p.h === 3).step, 13, "the 3rd harmonic is the period itself");
});

test("decays: halving points, a hold that settles, an extra rate that grows with the partial", () => {
  const pts = decayPoints(Math.LN2);  // halves every second
  assert.deepEqual(pts.slice(0, 3), [[0, 63], [1, 32], [2, 16]]);
  assert.equal(pts[pts.length - 1][1], 0);
  const held = decayPoints(1, 0.35);
  assert.equal(held[held.length - 1][1], 22);
  for (let i = 1; i < held.length; i++) assert.ok(held[i][1] <= held[i - 1][1], "never rises");
  assert.equal(extraDecayRate(1, 1.5, 1), 0, "the fundamental decays as the note does");
  assert.ok(extraDecayRate(4, 1.5, 1) > extraDecayRate(2, 1.5, 1));
});

// ── settings → spec ─────────────────────────────────────────────────────────

test("with no grid the designer stays harmonic; with one it fits the partials to it", () => {
  const s = defaultTimbreSettings();
  const none = designFromSettings(s, null);
  assert.equal(none.placement, "harmonic");
  assert.deepEqual(none.partials.map((p) => p.ratio), [1, 2, 3, 4, 5, 6]);
  assert.equal(designReport(none), null);
  const grid = designFromSettings({ ...s, placement: "grid" }, EDO8);
  assert.deepEqual(grid.partials.map((p) => p.step), [0, 8, 13, 16, 19, 21]);
  const r = designReport(grid);
  assert.equal(r.steps, 8);
  assert.ok(r.valleys >= 5);
  const hollow = designFromSettings({ ...s, spectrum: "hollow", placement: "harmonic" }, EDO8);
  assert.deepEqual(hollow.partials.map((p) => p.h), [1, 3, 5, 7, 9, 11]);
});

test("the spec: the note's shape on the principal, faster decays on the upper partials, the bite", () => {
  const s = { ...defaultTimbreSettings(), shape: "struck", bite: "light" };
  const d = designFromSettings({ ...s, placement: "grid" }, EDO8);
  const spec = timbreSpec(d, s);
  assert.equal(spec.ops.length, 6);
  assert.equal(spec.ops[0].env, null, "the fundamental decays with the note");
  assert.ok(spec.ops.slice(1).every((o) => o.env !== null));
  const sum = spec.ops.reduce((a, o) => a + o.gain, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, "gains sum to one");
  assert.equal(spec.principal.env.sustain, null);
  assert.ok(spec.bite && spec.bite.ratio === 1);
  assert.equal(timbreVoices(s), 7);
  const held = timbreSpec(d, { ...s, shape: "held" });
  assert.equal(held.principal.env.sustain, 1);
  assert.ok(held.ops.every((o) => o.env === null));
  assert.equal(releaseFadeout(0.3), 68);
});

// ── the plan ────────────────────────────────────────────────────────────────

/** Render `slot` playing C-4 for `chunks` chunks: the peak of the U8 output. */
function peakOf(doc, slot, chunks) {
  const eng = new TaudEngine();
  eng.sampleBin.set(doc.sampleBin);
  for (const s of doc.usedInstrumentSlots()) eng.uploadInstrument(s, doc.instRecordBytes(s));
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
  let peak = 0;
  for (let i = 0; i < chunks; i++) {
    const buf = new Uint8Array(TRACKER_CHUNK * 2);
    eng.renderChunk(0, buf);
    for (const b of buf) peak = Math.max(peak, Math.abs(b - 128));
  }
  return peak;
}

test("a designed timbre is written as an Easy rack: the partials summed, each on its ratio, one undo step", () => {
  const doc = demo();
  const e = planEasyFm(doc, null, easyNewModel(9), "Easy");
  importBankOp(e).apply(doc);
  const slot = e.metaSlot;
  const principalBefore = easyDecode(fmOperators(doc.instruments[slot]), fmProgramOf(doc.instruments[slot])).model.principal.instIdx;
  const recordBefore = doc.instRecordBytes(slot);

  const s = { ...defaultTimbreSettings(), shape: "struck", bite: "light" };
  const d = designFromSettings({ ...s, placement: "grid" }, EDO8);
  const plan = planTimbreFm(doc, slot, timbreSpec(d, s));
  assert.equal(plan.error, undefined);
  const op = importBankOp(plan);
  const inverse = op.apply(doc);
  const inst = doc.instruments[slot];
  const dec = easyDecode(fmOperators(inst), fmProgramOf(inst));
  assert.ok(dec.ok, "it reads as Easy Mode");
  const m = dec.model;
  assert.deepEqual(m.carriers, [0, 1, 2, 3, 4, 5], "every partial is heard");
  assert.deepEqual(m.mods[0], [6], "the bite modulates the fundamental");
  assert.deepEqual(m.ops.slice(0, 6).map((o) => o.detune), d.partials.map((p) => p.step * 512), "8-EDO steps are 512 units");
  assert.equal(m.principal.instIdx, principalBefore, "an Easy rack keeps its principal…");
  const pr = doc.instruments[principalBefore];
  assert.equal(pr.volEnvSustainWord, 0, "…with the struck shape written into it");
  assert.equal(pr.volEnvelopes[0].value, 63);
  const upper = doc.instruments[m.ops[5].instIdx & 0x3ff];
  assert.equal(upper.volEnvLoop & 0x2000, 0x2000, "an upper partial carries its own decay");
  assert.ok(peakOf(doc, slot, 30) > 8, "it sounds");

  // Designing again reuses the operators only this rack had: no new slots.
  const usedBefore = doc.usedInstrumentSlots().length;
  importBankOp(planTimbreFm(doc, slot, timbreSpec(d, { ...s, bite: "none" }))).apply(doc);
  assert.equal(doc.usedInstrumentSlots().length, usedBefore);

  // One undo step takes the first design back.
  const doc2 = demo();
  const e2 = planEasyFm(doc2, null, easyNewModel(9), "Easy");
  importBankOp(e2).apply(doc2);
  const inv2 = importBankOp(planTimbreFm(doc2, e2.metaSlot, timbreSpec(d, s))).apply(doc2);
  inv2.apply(doc2);
  assert.deepEqual(doc2.instRecordBytes(e2.metaSlot), recordBefore);
  assert.ok(inverse);
});

test("a rack not in Easy Mode is turned into one, with a principal of its own", () => {
  const doc = demo();
  const cands = doc.selectableInstrumentSlots().filter((x) => !doc.instruments[x].isMeta && !doc.instruments[x].isHighMeta);
  const p = planCreateFm(doc, [{ slot: cands[0], count: 2 }], "Plain");
  importBankOp(p).apply(doc);
  const readBefore = doc.instRecordBytes(cands[0]);
  const s = { ...defaultTimbreSettings(), shape: "held", partials: 4 };
  const plan = planTimbreFm(doc, p.metaSlot, timbreSpec(designFromSettings(s, null), s));
  assert.equal(plan.error, undefined);
  importBankOp(plan).apply(doc);
  const inst = doc.instruments[p.metaSlot];
  assert.equal(inst.metaRaw[0] & 1, 1, "the Easy Mode bit");
  const dec = easyDecode(fmOperators(inst), fmProgramOf(inst));
  assert.ok(dec.ok);
  assert.equal(dec.model.ops.length, 4);
  assert.deepEqual(doc.instRecordBytes(cands[0]), readBefore, "the top-level instrument it read is untouched");
  assert.ok(peakOf(doc, p.metaSlot, 30) > 8);
});
