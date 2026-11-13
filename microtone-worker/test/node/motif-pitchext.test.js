// Motif and the pitch extension (file format §9.18, item 319): a TML 2 build
// writes an instrument's pitches at 65536-TET — the field and its `IPit`
// extension — where TML 1 rounds to the 4096-TET unit, as it always has (a
// TML 1 program builds the bytes it always did).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProject } from "../../src/motif/build.js";
import { Document } from "../../src/doc/document.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { layerDetune, layerLow, layerHigh, instDetune } from "../../src/doc/pitchedit.js";

const reload = (doc) => new Document(parseTaud(doc.toBytes()));

const program = (version) => `tml ${version}
song { bars: 1, bar_rows: 16, tuning: "31-TET" }
instrument SINE  { wave: "sine", length: 300 }
instrument STACK { layers: [{ inst: SINE }, { inst: SINE, gain: -12, detune: 7.3, notes: 'C4'..'E5' }] }
instrument BELL  { fm: { operators: [{ inst: SINE }, { inst: SINE, ratio: 5, detune: 1.5, level: -6 }, { inst: SINE, ratio: 256, detune: 50, level: -40 }],
  algorithm: "0[1[2]]" } }
instrument CYM   { opl: { kind: "cymbal", operators: [{ attack: 15, decay: 4, sustain_level: 15, release: 4 }] } }
lane a { inst: STACK }
lane b { inst: BELL }
lane c { inst: CYM }
hit(a, 0, 'C4', ${version >= 2 ? 200 : 50})
hit(b, 0, 'C4', ${version >= 2 ? 200 : 50})
hit(c, 0, 'C4', ${version >= 2 ? 200 : 50})
`;

const slotOf = (score, id) => score.instruments.find((i) => i.id === id).slot;
const q16 = (u) => Math.round(u * 16) / 16;

test("TML 2: a layer's detune, an operator's ratio, a range and an OPL partner keep their sixteenths", async () => {
  const { doc, score } = await buildProject(program(2), {});
  assert.ok(doc.pitchExt() !== null, "the project carries an IPit section");
  const back = reload(doc);
  const stack = back.instruments[slotOf(score, "STACK")].metaLayers;
  assert.equal(layerDetune(stack[1]), q16((7.3 * 4096) / 1200), "7.3 cents, to the sixteenth");
  assert.equal(layerLow(stack[1]), score.tuning.word(score.tuning.parse("C4")));
  const e5 = score.tuning.word(score.tuning.parse("E5"));
  assert.ok(!Number.isInteger(e5), "31-TET's E5 lies between two units");
  assert.equal(layerHigh(stack[1]), e5, "the range runs to E5 exactly");

  const ops = back.instruments[slotOf(score, "BELL")].metaLayers;
  assert.equal(layerDetune(ops[1]), q16(4096 * Math.log2(5) + (1.5 * 4096) / 1200), "×5 and 1.5 cents, to the sixteenth");
  assert.equal(layerDetune(ops[2]), q16(8 * 4096 + (50 * 4096) / 1200), "×256 and 50 cents is past what sixteen bits hold");

  const cym = back.instruments[slotOf(score, "CYM")];
  assert.equal(cym.opl.partnerDetune + cym.opl.dPartnerDetune, q16((700 * 4096) / 1200), "the cymbal's partner 700 cents up");
});

test("TML 2: a waveform is tuned to middle C to the sixteenth of a unit", async () => {
  const { doc, score } = await buildProject(program(2), {});
  const sine = reload(doc).instruments[slotOf(score, "SINE")];
  const hz = (sine.samplingRate / 300) * 2 ** (instDetune(sine) / 4096);
  assert.ok(Math.abs(1200 * Math.log2(hz / 261.6255653)) < 0.01, `within a hundredth of a cent (${hz} Hz)`);
});

test("TML 1 rounds to the unit and writes no section, as it always has", async () => {
  const src = program(1).replace(", { inst: SINE, ratio: 256, detune: 50, level: -40 }", "").replace("0[1[2]]", "0[1]");
  const { doc, score } = await buildProject(src, {});
  assert.equal(doc.pitchExt(), null);
  const stack = doc.instruments[slotOf(score, "STACK")].metaLayers;
  assert.equal(stack[1].detune, Math.round((7.3 * 4096) / 1200));
  const ops = doc.instruments[slotOf(score, "BELL")].metaLayers;
  assert.equal(ops[1].detune, Math.round(4096 * Math.log2(5)) + Math.round((1.5 * 4096) / 1200));
  await assert.rejects(buildProject(program(1), {}), /ratio is out of range/, "×256 and 50 cents is past a TML 1 ratio");
});

test("word() gives the pitch as the pattern grid stores it: 65536-TET in TML 2's format-3 song", async () => {
  const { interpret } = await import("../../src/motif/build.js");
  const out = (src) => { const lines = []; interpret(src, { log: (l) => lines.push(l) }); return lines.join("\n"); };
  const song = (v, fmt = "") => `tml ${v}\nsong { bars: 1, tuning: "31-TET"${fmt} }\n`;
  // 31-TET's Db4 (three of its steps above C) lies between two note words;
  // C4 and C5 sit on them
  const db4 = 0x50000 + Math.round((65536 * 3) / 31);
  assert.equal(out(song(2) + "print(word('C4'), word('Db4'), word('C5') - word('C4'))"), `${0x50000} ${db4} ${0x10000}`);
  assert.equal(out(song(2, ", format: 2") + "print(word('C4'), word('Db4'))"), `${0x5000} ${0x5000 + Math.round((4096 * 3) / 31)}`, "a format-2 song: the note word");
  assert.equal(out(song(1, ", format: 3") + "print(word('Db4'))"), String(db4 / 16), "TML 1 keeps the units it returned");
  // a degree a fifth of a cent under the octave: its B14 lies above the
  // last note word, inside the sixteen steps that word names
  const edge = 'tml 2\nsong { bars: 1, tuning: { name: "Edge", cents: [0, 1199.8], names: ["C", "B"] } }\n';
  assert.equal(out(edge + "print(word('B14'))"), String(0xffff5), "the top of the grid is a pitch, not an error");
});
