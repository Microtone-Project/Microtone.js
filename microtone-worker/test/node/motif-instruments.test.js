// Motif (item 208 cont.): instruments beyond a soundfont's presets — from an
// instrument pack (.tsii), generated waveforms, and metainstruments a program
// defines itself (layers, FM racks), each placed in the bank at build time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildProject, interpret } from "../../src/motif/build.js";
import { fmAlgorithm } from "../../src/motif/music.js";
import { MotifError } from "../../src/motif/lexer.js";
import { FM_WORD_OSC, FM_WORD_MOD, FM_WORD_FB, FmOp } from "../../core/engine/inst.js";
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
