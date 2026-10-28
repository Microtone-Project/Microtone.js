// Motif (item 260): mixing chains written in TML — `chain NAME { … }`
// declarations and records given straight to an instrument's `chain`, saved as
// the IMix blocks the Mixing tab edits (and their names in IMcn).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProject, interpret } from "../../src/motif/build.js";
import { MotifError } from "../../src/motif/lexer.js";
import { encodeEquipment } from "../../core/format/imix-section.js";
import {
  defaultEquipment, defaultCrossovers, FX16, IMX_ITRM, IMX_EQU1, IMX_DEQ1, IMX_COMP, IMX_UNIS, IMX_SATU, IMX_DLAY,
  IMX_VERB, IMX_LIMI, IMX_MXTL,
} from "../../core/engine/imix.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";

const SONG = (version, chains) => `tml ${version}
song { title: "Chains", bars: 2, bar_rows: 16, tuning: "12-TET" }
${chains}
instrument SINE { wave: "sine", chain: ROOM }
instrument SAW  { wave: "saw", envelope: [[0, 63], [0.5, 0]], chain: {
  input_trim: { gain: -3 },
  equaliser_1: { bands: [{ shape: "high_pass", freq: 120, slope: 24 }, { shape: "bell", freq: 900, gain: 4, q: 2, on: false }] },
  dynamic_eq_1: { bell_2: { freq: 1500, threshold: -30, above: "boost", range: 9, sensor_freq: 300 } },
  compressor: { detector: "rms", crossovers: [200, 3000], bands: [{ threshold: -24, ratio: 6 }, {}, { make_up: 2, on: false }] },
  unison: { voices: 6, detune: 22, mix: 0.5, detune_lfo: { waveform: "triangle", rate: 0.25, depth: 0.5 },
    width_lfo: { period_ticks: 24, restart: true, depth: 1 } },
  saturator: { curve: "tube", drive: 12, bias: 0.25 },
  tape_delay: { time: 375, feedback: 0.5, ping_pong: true, on: false },
  limiter: { ceiling: -2, true_peak: true },
  mix_tool: { width: 1.5, remove_dc: true, invert_left: true },
} }
instrument SQ   { wave: "square", chain: ROOM }
instrument TRI  { wave: "triangle", chain: { reverb: { pre_delay: 20 } } }
lane a { inst: SINE }
lane b { inst: SAW }
lane c { inst: SQ }
lane d { inst: TRI }
hit(a, 0, 'C4', 50)
hit(b, 4, 'E4', 50)
hit(c, 8, 'G4', 50)
hit(d, 12, 'C5', 50)
`;
const ROOM = `chain ROOM { name: "Room bus", mode: "bus", order: "reverb_delay",
  reverb: { size: 0.7, decay: 2.5, damping: 6000, mix: 0.3 }, tape_delay: { time_ticks: 12, feedback: 0.4 },
  compressor: { threshold: -20, ratio: 4, attack: 5 } }`;

const piece = (id, over) => ({ ...defaultEquipment(id), ...over });

test("chains are saved as the Mixing tab saves them", async () => {
  for (const version of [1, 2]) {
    const { doc, score } = await buildProject(SONG(version, ROOM), {});
    const back = new Document(parseTaud(await doc.toSaveBytes(3)));
    back._rebuildInstRegion();
    const I = Object.fromEntries(score.instruments.map((i) => [i.id, i.slot]));
    const ids = ["SINE", "SAW", "SQ", "TRI"].map((k) => back.instruments[I[k]].imixId);
    // numbered from the first instrument that uses one; one block per chain
    assert.deepEqual(ids, [1, 2, 1, 3], `TML ${version}: chain numbers`);
    const blocks = back.imixBlocks();
    assert.equal(blocks.length, 3);
    const same = (block, id, want, what) => {
      assert.deepEqual([...encodeEquipment(id, block.equipment[id])], [...encodeEquipment(id, want)], `TML ${version}: ${what} ${id}`);
    };
    const room = back.imixBlock(1);
    assert.deepEqual([room.enabled, room.bus, room.order], [true, true, 1]);
    assert.deepEqual(Object.keys(room.equipment).sort(), [IMX_COMP, IMX_DLAY, IMX_VERB].sort());
    same(room, IMX_VERB, piece(IMX_VERB, { size: 0.7, decay: 2.5, damping: 6000, dry: Math.round(255 * 0.7) }), "ROOM");
    same(room, IMX_DLAY, piece(IMX_DLAY, { sync: true, time: 48 * FX16, feedback: 0.4 }), "ROOM");
    same(room, IMX_COMP, piece(IMX_COMP, { bands: [{ on: true, threshDb: -20, ratio: 4, attackMs: 5, releaseMs: 120, kneeDb: 6, makeupDb: 0 }], crossovers: [] }), "ROOM");
    assert.equal(back.imixName(1), "Room bus");
    assert.equal(back.imixName(2), "", "a chain of its own is unnamed");

    const saw = back.imixBlock(2);
    assert.deepEqual([saw.enabled, saw.bus, saw.order], [true, false, 0]);
    same(saw, IMX_ITRM, piece(IMX_ITRM, { gainDb: -3 }), "SAW");
    same(saw, IMX_EQU1, piece(IMX_EQU1, { bands: [
      { on: true, shape: 0, slope: 1, freq: 120, gainDb: 0, q: Math.SQRT1_2 },
      { on: false, shape: 2, slope: 0, freq: 900, gainDb: 4, q: 2 }] }), "SAW");
    const deq = defaultEquipment(IMX_DEQ1);
    Object.assign(deq.bands[3], { on: true, freq: 1500, threshDb: -30, boost: true, rangeDb: 9, unlinked: true, senseFreq: 300, senseQ: 1 });
    same(saw, IMX_DEQ1, deq, "SAW");
    const band = { on: true, threshDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, kneeDb: 6, makeupDb: 0 };
    same(saw, IMX_COMP, piece(IMX_COMP, { detector: 1, crossovers: [200, 3000],
      bands: [{ ...band, threshDb: -24, ratio: 6 }, band, { ...band, makeupDb: 2, on: false }] }), "SAW");
    same(saw, IMX_UNIS, piece(IMX_UNIS, { voices: 6, detune: 22, dry: 128,
      detuneLfo: { wave: 1, retrigger: false, sync: false, rate: FX16 / 4, depth: 0.5 },
      widthLfo: { wave: 0, retrigger: true, sync: true, rate: 96 * FX16, depth: 1 } }), "SAW");
    same(saw, IMX_SATU, piece(IMX_SATU, { curve: 3, driveDb: 12, bias: 0.25 }), "SAW");
    same(saw, IMX_DLAY, piece(IMX_DLAY, { bypass: true, sync: false, time: Math.round(0.375 * FX16), feedback: 0.5, pingPong: true }), "SAW");
    same(saw, IMX_LIMI, piece(IMX_LIMI, { ceilingDb: -2, truePeak: true }), "SAW");
    same(saw, IMX_MXTL, piece(IMX_MXTL, { width: 1.5, removeDc: true, invL: true }), "SAW");
    same(back.imixBlock(3), IMX_VERB, piece(IMX_VERB, { preDelay: Math.round(0.02 * FX16) }), "TRI");
  }
});

test("a chain is heard", async () => {
  const energy = async (src) => {
    const { doc } = await buildProject(src, {});
    const eng = new TaudEngine();
    loadIntoEngine(eng, parseTaud(await doc.toSaveBytes(3)), 0);
    eng.setCuePosition(0, 0);
    eng.play(0);
    const ts = eng.playheads[0].trackerState;
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let e = 0;
    for (let n = 0; n < 48000; n += TRACKER_CHUNK) {
      eng.renderChunk(0, out);
      for (let k = 0; k < TRACKER_CHUNK; k++) { assert.ok(Number.isFinite(ts.mixLeft[k])); e += ts.mixLeft[k] ** 2; }
    }
    return e;
  };
  const song = (chain) => `tml 2
song { bars: 1 }
instrument SINE { wave: "sine"${chain} }
lane a { inst: SINE }
hit(a, 0, 'C4', 60)
`;
  const dry = await energy(song(""));
  const quiet = await energy(song(`, chain: { input_trim: { gain: -12 } }`));
  assert.ok(Math.abs(quiet / dry - 10 ** (-12 / 10)) < 0.02, `−12 dB of trim is a sixteenth of the energy (${quiet / dry})`);
  assert.equal(await energy(song(`, chain: { input_trim: { gain: -12 }, on: false }`)), dry, "a chain switched off is not heard");
});

test("chain declarations say what is wrong with them", () => {
  const err = (body) => {
    try { interpret(`tml 2\nsong { bars: 1 }\n${body}`); } catch (e) { if (e instanceof MotifError) return e.message; throw e; }
    assert.fail("expected a MotifError");
  };
  const c = (x) => err(`chain C { ${x} }\ninstrument S { wave: "sine", chain: C }`);
  assert.match(c(`revrb: {}`), /no option "revrb" \(did you mean "reverb"\?\)/);
  assert.match(c(`input_trim: { gain: 30 }`), /gain must be -24…24, not 30/);
  assert.match(c(`tape_delay: { time: 5000 }`), /time must be 1\.01…4000 ms, not 5000 ms/);
  assert.match(c(`tape_delay: { time: 300, time_ticks: 12 }`), /in ms or in ticks, not both/);
  assert.match(c(`mode: "group"`), /must be one of "separate", "bus"/);
  assert.match(c(`equaliser_1: { bands: [{ freq: 100 }] }`), /needs a shape/);
  assert.match(c(`equaliser_1: { bands: [{ shape: "bell", slope: 12 }] }`), /only a high_pass or a low_pass has a slope/);
  assert.match(c(`equaliser_1: { bands: [{ shape: "high_pass", slope: 18 }] }`), /12, 24, 36 or 48/);
  assert.match(c(`compressor: { bands: [{}, {}], crossovers: [100, 200] }`), /2 bands take 1 crossover, not 2/);
  assert.match(c(`compressor: { bands: [{}, {}, {}], crossovers: [800, 200] }`), /crossovers must rise/);
  assert.match(c(`compressor: { threshold: -10, bands: [{}] }`), /with bands, give threshold to each band/);
  assert.match(c(`dynamic_eq_1: { bell_5: {} }`), /no option "bell_5"/);
  assert.match(c(`limiter: { mix: 0.5 }`), /no option "mix"/);
  assert.match(c(`unison: { voices: 9 }`), /voices must be 2…8/);
  assert.match(c(`unison: { detune_lfo: { rate: 1, period_ticks: 4 } }`), /rate \(Hz\) or its period in ticks, not both/);
  assert.match(err(`instrument S { wave: "sine", chain: "ROOM" }`), /chain is a chain .* not string/);
});
