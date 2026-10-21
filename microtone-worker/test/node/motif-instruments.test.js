// Motif (item 208 cont.): instruments beyond a soundfont's presets — from an
// instrument pack (.tsii), generated waveforms, OPL and PSG chip instruments
// (item 230), and metainstruments a program defines itself (layers, FM racks),
// each placed in the bank at build time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildProject, interpret } from "../../src/motif/build.js";
import { fmAlgorithm } from "../../src/motif/music.js";
import { MotifError } from "../../src/motif/lexer.js";
import { FM_WORD_OSC, FM_WORD_MOD, FM_WORD_FB, FmOp, buildOplRecord, buildPsgRecord } from "../../core/engine/inst.js";
import { encodeOplPatch, OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_HH } from "../../core/engine/opl.js";
import { encodePsgPatch } from "../../core/engine/psg.js";
import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";

const ASSETS = new URL("../../assets/", import.meta.url);
const DEMO = new Uint8Array(readFileSync(new URL("demo_projects/Huygens_clock.taud", ASSETS)));
const TOUCH = new Uint8Array(readFileSync(new URL("MicrotoneTouch.tsii", ASSETS)));
// the bank step is the host's: Huygens' Clock's bank stands in for a soundfont
// (its slot 1 is a three-layer drum kit), the Touch pack for a pack file
const host = {
  sf2Bank: async () => DEMO,
  pack: async (name) => {
    if (name !== "MicrotoneTouch.tsii") throw new MotifError(`no pack ${name}`);
    return TOUCH;
  },
};

const SONG = `tml 1
song { title: "Instruments", bars: 2, bar_rows: 16, tuning: "12-TET", global_volume: 255 }
instrument KIT   { bank: 128, program: 0 }
instrument SINE  { wave: "sine", envelope: [[0, 63], [0.3, 40], [2, 0]], sustain: 1 }
instrument SQ    { wave: "square", length: 64, name: "Square" }
instrument PLUCK { pack: "MicrotoneTouch.tsii", slot: 4 }
instrument SNARE { pack: "MicrotoneTouch.tsii", slot: "Snare" }
instrument STACK { layers: [
  { inst: SINE },
  { inst: SQ, gain: -12, detune: 7, notes: 'C4'..'C6' },
  { inst: SQ, gain: -18, fixed: 'C2', vols: 32..63 },
] }
instrument DRUMS { layers: [{ inst: KIT, gain: -6 }] }
instrument BELL  { fm: { operators: [{ inst: SINE }, { inst: SINE, ratio: 3.5, level: -3 }], algorithm: "0[1]" } }
lane a { inst: BELL }
lane b { inst: STACK }
lane c { inst: PLUCK }
lane d { inst: SNARE }
hit(a, 0, 'C4', 60)
hit(b, 8, 'E4', 50)
hit(c, 16, 'G4', 50)
hit(d, 20, 'C4', 50)
hit(c, 24, 'C4', 40, inst: DRUMS)
`;

test("instruments from a soundfont, a pack, waveforms, layers and an FM rack share one bank", async () => {
  const { doc, score } = await buildProject(SONG, host);
  const I = Object.fromEntries(score.instruments.map((i) => [i.id, i]));
  const slots = score.instruments.map((i) => i.slot);
  assert.equal(new Set(slots).size, slots.length, "every instrument its own slot");
  assert.ok(slots.every((s) => s >= 1 && s <= 255), "every one reachable from a pattern");
  assert.equal(I.KIT.slot, 1, "the soundfont presets come first, in the order declared");
  const at = (i) => doc.instruments[I[i].slot];

  // the pack's instruments, with their names
  assert.equal(doc.instrumentName(I.PLUCK.slot), "Pluck");
  assert.equal(doc.instrumentName(I.SNARE.slot), "Snare", "a pack instrument found by its name");

  // a waveform: one looped cycle, its envelope, its name
  const sine = at("SINE");
  assert.ok(!sine.isMeta && sine.sampleLength === 256 && sine.loopMode !== 0);
  assert.equal(sine.volEnvelopes[0].value, 63);
  assert.equal(sine.volEnvelopes[2].value, 0);
  assert.equal(sine.volEnvLoop & 0x2000, 0x2000, "the envelope is marked present");
  assert.equal(sine.volEnvSustainWord, (1 << 8) | 0x20 | 1, "sustained on point 1");
  assert.equal(doc.instrumentName(I.SQ.slot), "Square");
  assert.equal(at("SQ").sampleLength, 64);

  // a layered metainstrument over them
  const stack = at("STACK");
  assert.ok(stack.isMeta && !stack.isFm);
  assert.equal(stack.metaLayers.length, 3);
  const [l0, l1, l2] = stack.metaLayers;
  assert.equal(l0.instIdx, I.SINE.slot);
  assert.equal(l0.mixOctet, 0x9f, "0 dB");
  assert.equal(l1.instIdx, I.SQ.slot);
  assert.equal(l1.detune, Math.round((7 * 4096) / 1200), "7 cents");
  assert.deepEqual([l1.pitchStart, l1.pitchEnd], [score.tuning.word(score.tuning.parse("C4")), score.tuning.word(score.tuning.parse("C6"))]);
  assert.ok(l2.fixedPitch && l2.detune === score.tuning.word(score.tuning.parse("C2")) && l2.volStart === 32);

  // a layer over a layered preset stands in for its layers
  const drums = at("DRUMS");
  const kit = doc.instruments[I.KIT.slot];
  assert.equal(drums.metaLayers.length, kit.metaLayers.length, "the kit's three layers, flattened");
  drums.metaLayers.forEach((l, k) => assert.equal(l.instIdx, kit.metaLayers[k].instIdx));

  // an FM rack: operator 0 modulated by operator 1 at 3.5 times its frequency
  const bell = at("BELL");
  assert.ok(bell.isFm);
  assert.equal(bell.metaLayers.length, 2);
  assert.equal(bell.metaLayers[1].detune, Math.round(4096 * Math.log2(3.5)));
  assert.deepEqual([...bell.fmProgram], [FM_WORD_OSC | 1, FM_WORD_MOD | 0]);

  // and it plays: render the first beat and hear something
  const reloaded = parseTaud(doc.toBytes());
  const eng = new TaudEngine();
  loadIntoEngine(eng, reloaded, 0);
  eng.setCuePosition(0, 0);
  eng.play(0);
  const ts = eng.playheads[0].trackerState;
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  let energy = 0;
  for (let c = 0; c < 40; c++) {
    eng.renderChunk(0, chunk);
    for (let k = 0; k < TRACKER_CHUNK; k++) energy += ts.mixLeft[k] ** 2;
  }
  assert.ok(energy > 1, `the rack sounds (energy ${energy})`);
  // the project survives its own round trip
  assert.deepEqual(new Document(reloaded).toBytes(), doc.toBytes());
});

test("the FM algorithm reads the FM editor's notation", () => {
  assert.deepEqual(fmAlgorithm("0", 1), [FM_WORD_OSC | 0]);
  assert.deepEqual(fmAlgorithm("0[1[2]]", 3), [FM_WORD_OSC | 2, FM_WORD_MOD | 1, FM_WORD_MOD | 0]);
  assert.deepEqual(fmAlgorithm("0[1] + 2", 3), [FM_WORD_OSC | 1, FM_WORD_MOD | 0, FM_WORD_OSC | 2, FmOp.ADD]);
  assert.deepEqual(fmAlgorithm("0[0']", 1), [FM_WORD_FB | 0, FM_WORD_MOD | 0]);
  assert.deepEqual(fmAlgorithm("(0 × 1) - 2", 3), [FM_WORD_OSC | 0, FM_WORD_OSC | 1, FmOp.MUL, FM_WORD_OSC | 2, FmOp.NEG, FmOp.ADD]);
  assert.throws(() => fmAlgorithm("0[3]", 2), /no operator 3/);
  assert.throws(() => fmAlgorithm("0'[1]", 2), /cannot be modulated/);
  assert.throws(() => fmAlgorithm("0 +", 1), /ends too soon/);
});

test("instrument declarations say what is wrong with them", () => {
  const err = (body) => {
    try { interpret(`tml 1\nsong { bars: 1 }\n${body}`); } catch (e) { if (e instanceof MotifError) return e.message; throw e; }
    assert.fail("expected a MotifError");
  };
  assert.match(err("instrument X { name: \"x\" }"), /needs a source/);
  assert.match(err("instrument X { bank: 0, program: 0, wave: \"sine\" }"), /more than one source/);
  assert.match(err("instrument X { pack: \"p.tsii\" }"), /needs slot/);
  assert.match(err("instrument X { wave: \"wobble\" }"), /must be one of/);
  assert.match(err("instrument X { bank: 0, program: 0, envelope: [[0, 63]] }"), /envelope is for a wave/);
  assert.match(err("instrument S { wave: \"sine\" }\ninstrument X { fm: { operators: [{ inst: S }], algorithm: \"0[1]\" } }"), /no operator 1/);
  assert.match(err("instrument X { layers: [] }"), /has no layers/);
  assert.match(err("instrument S { wave: \"sine\" }\ninstrument X { layers: [{ inst: S, fixed: 'C4', detune: 5 }] }"), /fixed-pitch layer has no detune/);
});

test("a metainstrument cannot be an FM operator", async () => {
  await assert.rejects(buildProject(`tml 1
song { bars: 1 }
instrument KIT { bank: 128, program: 0 }
instrument X { fm: { operators: [{ inst: KIT }] } }
lane a { inst: X }
hit(a, 0, 'C4', 40)`, host), /operator 0 reads KIT, a metainstrument/);
});

// item 230: OPL and PSG chip instruments declared in the program itself — the
// Instruments view's OPL and PSG tabs as options, through the engine's own
// patch encoders, placed after the waveforms and before the metainstruments.
test("OPL and PSG instruments are written as the OPL and PSG tabs would write them", async () => {
  const { doc, score } = await buildProject(`tml 1
song { title: "Chips", bars: 2, bar_rows: 16, tuning: "12-TET" }
instrument SINE  { wave: "sine" }
instrument ORGAN { opl: { kind: "4op", connection: "1 + 2 → 3 + 4", operators: [
  { multiple: 1 }, { multiple: 4, level: 30, decay: 5, sustain_level: 7 }, { multiple: 2, level: 5 }, { multiple: 3, level: 10 } ] } }
instrument BASS  { opl: { feedback: 4, deep_vibrato: true, operators: [
  { level: 24, decay: 6, sustain_level: 8, release: 9, vibrato: true, key_scale_level: 1 }, { decay: 3, sustain_level: 2, release: 9, waveform: 2 } ] } }
instrument HAT   { opl: { kind: "hi_hat", operators: [{ decay: 10, sustain_level: 15, sustain: false, release: 10 }] }, percussion: true }
instrument PLUCK { psg: { mix: "multiplicative",
  a: { waveform: "pulse6", level: 4, decay: 6, sustain_level: 15, sustain: false, reset: true, advance: 16, pattern: 1 },
  b: { waveform: 9, multiple: 2, tremolo: 2, invert: true } } }
instrument SUB   { psg: { a: { waveform: "triangle4", attack: 13 } }, envelope: [[0, 0], [0.5, 63]], nna: "off" }
instrument STACK { layers: [{ inst: ORGAN }, { inst: PLUCK, gain: -6 }] }
instrument RACK  { fm: { operators: [{ inst: SINE }, { inst: ORGAN, ratio: 2, level: -12 }] } }
lane a { inst: ORGAN }
lane b { inst: BASS }
lane c { inst: HAT }
lane d { inst: PLUCK }
lane e { inst: SUB }
lane f { inst: STACK }
lane g { inst: RACK }
hit(a, 0, 'C4', 50)
hit(b, 0, 'C2', 50)
hit(c, 2, 'C5', 50)
hit(d, 4, 'C5', 50)
hit(e, 6, 'C1', 50)
hit(f, 8, 'C5', 50)
hit(g, 10, 'C3', 50)
`, host);
  const I = Object.fromEntries(score.instruments.map((i) => [i.id, i.slot]));
  // the waveform, then the chips in declaration order, then the metainstruments
  assert.deepEqual([I.SINE, I.ORGAN, I.BASS, I.HAT, I.PLUCK, I.SUB, I.STACK, I.RACK], [1, 2, 3, 4, 5, 6, 7, 8]);
  const rec = (slot) => doc.sampleInstImage.subarray(SAMPLEBIN_SIZE + slot * 256, SAMPLEBIN_SIZE + slot * 256 + 256);
  const same = (slot, want, what) => {
    const got = rec(slot);
    const diff = [...want].findIndex((x, k) => k !== 186 && x !== got[k]); // 186: the nna the build applies
    assert.equal(diff, -1, `${what}: byte ${diff} is ${got[diff]}, wanted ${want[diff]}`);
  };
  const held = { ar: 15, dr: 0, sl: 0, rr: 7, eg: 1 };
  same(I.ORGAN, buildOplRecord(encodeOplPatch({ kind: OPL_KIND_4OP, cntA: 1, cntB: 1, ops: [
    { ...held, mult: 1 }, { ...held, mult: 4, tl: 30, dr: 5, sl: 7 }, { ...held, mult: 2, tl: 5 }, { ...held, mult: 3, tl: 10 }] })), "ORGAN");
  same(I.BASS, buildOplRecord(encodeOplPatch({ kind: OPL_KIND_2OP, feedback: 4, deepVibrato: true, ops: [
    { ...held, mult: 1, tl: 24, dr: 6, sl: 8, rr: 9, vib: 1, ksl: 1 }, { ...held, mult: 1, dr: 3, sl: 2, rr: 9, ws: 2 }] })), "BASS");
  // the hi-hat reads the cymbal's channel seven semitones down, as the AdLib driver keeps them
  same(I.HAT, buildOplRecord(encodeOplPatch({ kind: OPL_KIND_HH, partnerMult: 1, partnerDetune: -2389, ops: [
    { ar: 15, dr: 10, sl: 15, rr: 10, eg: 0, mult: 1 }] }), { percussion: true }), "HAT");
  same(I.PLUCK, buildPsgRecord(encodePsgPatch({ multiply: true, osc: [
    { wave: 6, ar: 15, dr: 6, sl: 15, rr: 7, mult: 1, tl: 4, eg: false, reset: true, advance: 16, pattern: 1 },
    { wave: 9, ar: 15, dr: 0, sl: 0, rr: 7, mult: 2, eg: true, tremolo: 2, invert: true }] })), "PLUCK");
  doc._rebuildInstRegion();
  const sub = doc.instruments[I.SUB];
  assert.ok(sub.isPsg && sub.psg.muteB && !sub.psg.muteA, "an oscillator left out is muted");
  assert.equal(sub.volEnvLoop & 0x2000, 0x2000, "SUB carries its envelope");
  assert.equal(sub.volEnvelopes[0].value, 0);
  assert.equal(rec(I.SUB)[186] & 3, 0, "nna off");
  assert.equal(doc.instrumentName(I.ORGAN), "ORGAN");
  assert.deepEqual([...doc.instruments[I.STACK].sourceSlots], [I.ORGAN, I.PLUCK], "a chip is a layer");
  assert.deepEqual([...doc.instruments[I.RACK].sourceSlots], [I.SINE, I.ORGAN], "…and an FM operator");
  // every lane sounds
  const parsed = parseTaud(await doc.toSaveBytes(3));
  for (let keep = 0; keep < 7; keep++) {
    const eng = new TaudEngine();
    loadIntoEngine(eng, parsed, 0);
    for (let l = 0; l < 7; l++) if (l !== keep) eng.setVoiceMute(0, l, true);
    eng.setCuePosition(0, 0);
    eng.play(0);
    const ts = eng.playheads[0].trackerState;
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let e = 0;
    for (let f = 0; f < 2 * 48000; f += TRACKER_CHUNK) { // the song: 32 rows of 0.12 s
      eng.renderChunk(0, out);
      for (let k = 0; k < TRACKER_CHUNK; k++) { assert.ok(Number.isFinite(ts.mixLeft[k])); e += ts.mixLeft[k] ** 2; }
    }
    assert.ok(e > 1, `lane ${"abcdefg"[keep]} sounds`);
  }
});

test("OPL and PSG declarations say what is wrong with them", () => {
  const err = (body) => {
    try { interpret(`tml 1\nsong { bars: 1 }\n${body}`); } catch (e) { if (e instanceof MotifError) return e.message; throw e; }
    assert.fail("expected a MotifError");
  };
  assert.match(err("instrument X { opl: { kind: \"4op\", operators: [{}, {}] } }"), /a 4op has 4 operators, not 2/);
  assert.match(err("instrument X { opl: { kind: \"snare\", connection: \"fm\", operators: [{}] } }"), /a snare has one operator, so no connection/);
  assert.match(err("instrument X { opl: { kind: \"tom\", feedback: 3, operators: [{}] } }"), /a tom has no feedback/);
  assert.match(err("instrument X { opl: { partner_multiple: 2, operators: [{}, {}] } }"), /only a snare, cymbal or hi_hat has a partner/);
  assert.match(err("instrument X { opl: { kind: \"snare\", partner_pitch: 700, operators: [{}] } }"), /no partner_pitch/);
  assert.match(err("instrument X { opl: { kind: \"4op\", connection: \"1>3\", operators: [{}, {}, {}, {}] } }"), /connection is one of "1>2>3>4"/);
  assert.match(err("instrument X { opl: { kind: \"2op\", connection: \"ring\", operators: [{}, {}] } }"), /must be one of "fm", "additive"/);
  assert.match(err("instrument X { opl: { operators: [{ attak: 3 }, {}] } }"), /no option "attak" \(did you mean "attack"\?\)/);
  assert.match(err("instrument X { opl: { operators: [{ level: 64 }, {}] } }"), /level must be 0…63/);
  assert.match(err("instrument X { opl: { kind: \"6op\", operators: [] } }"), /must be one of "2op", "4op"/);
  assert.match(err("instrument X { psg: { mix: \"additive\" } }"), /needs an oscillator: a, b or both/);
  assert.match(err("instrument X { psg: { a: { waveform: \"triangel\" } } }"), /did you mean "triangle"/);
  assert.match(err("instrument X { psg: { a: { tremolo: 3 } } }"), /tremolo must be 0…2/);
  assert.match(err("instrument X { psg: { a: {} }, length: 64 }"), /length is for a wave instrument/);
  assert.match(err("instrument X { psg: { a: {} }, opl: { operators: [{}, {}] } }"), /more than one source/);
});
