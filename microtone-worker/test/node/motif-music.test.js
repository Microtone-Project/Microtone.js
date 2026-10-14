// Motif (item 208): the music half of TML — tunings and pitch names, the cell
// merge rules, melody strings, chords, the compiler's two cell layouts, the
// declarations' checks, and a whole build through to a Document.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { interpret, buildProject, MOTIF_FOURCC } from "../../src/motif/build.js";
import { compileScore } from "../../src/motif/compile.js";
import { dbOctet, KEY_OFF } from "../../src/motif/music.js";
import { MotifError } from "../../src/motif/lexer.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { splitNameTable } from "../../src/doc/bankmerge.js";
import { evaluate } from "../../src/motif/build.js";
import { MOTIF_EXAMPLE } from "../../src/ui/motifexample.js";

const HEAD = (song) => `tml 1\nsong { ${song} }\ninstrument P { bank: 0, program: 0 }\nlane a { inst: P }\n`;
function run(song, body) {
  const lines = [];
  const score = interpret(HEAD(song) + body, { log: (l) => lines.push(l) });
  return { score, out: lines.join("\n") };
}
function err(src) {
  try { interpret(src); } catch (e) { if (e instanceof MotifError) return e; throw e; }
  assert.fail("expected a MotifError");
}
/** A cell as plain data: the instrument it names reads as its slot. */
const cell = (score, row, lane = 0) => {
  const c = score.lanes[lane].ev.get(row);
  return c && c.inst ? { ...c, inst: c.inst.slot } : c;
};

test("pitches are steps of the song's notation, spelt as the Timeline spells them", () => {
  assert.equal(run('bars: 1, tuning: "31-TET"', "print('C4', 'Cp4', note_name(154), note(\"F#3\"), degree(\"Bb\"), period())").out, "124 154 Cp4 108 26 31");
  assert.equal(run('bars: 1, tuning: "12-TET"', "print('C4', 'A4', note_name(61), word('A4') == $5C00)").out, "48 57 C#5 true");
  // Kite: the up/down ticks are part of the name; the big dot is silent
  assert.equal(run('bars: 1, tuning: "41-TET (Kite)"', "print('uC4', note_name(41 * 4 + 2), 'C#4' - 'C4')").out, "165 DC#4 4");
  // by notation number, too
  assert.equal(run("bars: 1, tuning: 310", "print(period())").out, "31");
});

test("a tuning Microtone has no notation for becomes a custom one", () => {
  const { score } = run('bars: 1, tuning: "29-TET"', "");
  assert.equal(score.tuning.n, 29);
  assert.equal(score.tuning.notation, 0xffff, "custom notation slot 0");
  assert.ok(score.tuning.nota?.length > 0, "and the project carries its definition");
  const scale = 'bars: 1, tuning: { name: "Seven", cents: [0, 120, 270, 540, 670, 785, 950], names: ["C", "D", "E", "F", "G", "A", "B"] }';
  const r = run(scale, "print('G4', word('G4') - $5000)");
  assert.equal(r.out, `32 ${Math.round((670 * 4096) / 1200)}`);
  assert.match(err('tml 1\nsong { bars: 1, tuning: "Wobbly" }').message, /not a tuning Microtone knows/);
});

test("midi() lands where Huygens' Clock's drum map did (31-TET, ties to the lower step)", () => {
  const { score } = run('bars: 1, tuning: "31-TET"', "");
  const huygens = (k) => {
    const x = ((k - 60) * 31) / 12;
    return 124 + (x - Math.floor(x) === 0.5 ? Math.floor(x) : Math.round(x));
  };
  for (let k = 12; k < 128; k++) assert.equal(score.tuning.midi(k), huygens(k), `key ${k}`);
  assert.equal(run('bars: 1, tuning: "31-TET"', "print(note_name(midi(42)))").out, "F#2");
});

test("cells merge: a note replaces a key-off, a key-off never replaces a note, two values clash", () => {
  const { score } = run("bars: 2, tuning: \"12-TET\"", `
keyoff(a, 4)
hit(a, 4, 'C4', 40)
hit(a, 8, 'D4', 40)
keyoff(a, 8)
fx(a, 8, "H", $1234)
cut(a, 12)
`);
  assert.deepEqual(cell(score, 4), { note: 0x5000, inst: 1, vol: 40 });
  assert.deepEqual(cell(score, 8), { note: score.tuning.word(50), inst: 1, vol: 40, fx: 17, arg: 0x1234 });
  assert.deepEqual(cell(score, 12), { note: 2 });
  const e = err(HEAD("bars: 2") + "hit(a, 0, 'C4', 40)\nhit(a, 0, 'D4', 40)");
  assert.match(e.message, /lane a, bar 1 row 0: two different notes on one row \(C4 and D4\)/);
  assert.match(err(HEAD("bars: 2") + "fx(a, 3, \"S\", 1)\nfx(a, 3, \"T\", 1)").message, /two different effects on one row \(S and T\)/);
});

test("melody strings: notes, glides, rests, vibrato, ties", () => {
  const { score, out } = run('bars: 2, tuning: "12-TET", speed: 6', `
print(melody(a, 0, "C4:2 ~D4:2@30 r:2 E4:4v G4:2> r:2 A4:1", vib: [1, 2]))`);
  assert.equal(out, "15");
  const w = (s) => score.tuning.word(score.tuning.parse(s));
  assert.deepEqual(cell(score, 0), { note: w("C4"), inst: 1 });
  // a glide is the note with G and no instrument (no re-attack), its speed
  // covering the step in one row: |$52AB − $5000| / (1 row × 5 ticks), rounded up
  assert.deepEqual(cell(score, 2), { note: w("D4"), fx: 16, arg: 137, vol: 30 });
  assert.deepEqual(cell(score, 4), { note: KEY_OFF });
  assert.deepEqual(cell(score, 6), { note: w("E4"), inst: 1 });
  assert.deepEqual(cell(score, 8), { fx: 17, arg: 0x0102 });  // vibrato from two rows in
  assert.deepEqual(cell(score, 9), { fx: 17, arg: 0 });
  assert.equal(cell(score, 12), undefined, "a tied note is not keyed off by the rest after it");
  assert.deepEqual(cell(score, 15), { note: KEY_OFF });
  assert.match(err(HEAD("bars: 2") + 'melody(a, 0, "C4:3 | D4:1")').message, /bar line/);
  assert.match(err(HEAD("bars: 2") + 'melody(a, 0, "C4")').message, /not a melody token/);
  // ring: no key-offs at all; map: every pitch through a function
  const r = run('bars: 1, tuning: "12-TET"', 'melody(a, 0, "C4:2 r:2 E4:2", ring: true, map: fn(p) => mirror(p, \'D4\'))');
  assert.deepEqual([...r.score.lanes[0].ev.keys()], [0, 4]);
  assert.equal(r.score.lanes[0].ev.get(0).note, r.score.tuning.word(r.score.tuning.parse("E4")));
});

test("nearest_chord moves a chord as little as it can", () => {
  const { out } = run('bars: 1, tuning: "31-TET"', `
let dsub7 = { root: degree("D"), ivs: [0, 7, 18, 25], name: "Dsub7" }
print(nearest_chord(notes("D3 A3 Fp4 Cp4"), dsub7, 'C3', 'D5'))
let maj = { root: degree("F"), ivs: [0, 10, 18] }
print(map(nearest_chord(notes("Bb3 D4 F4"), maj, 'D3', 'A4'), note_name))
print(map(nearest_chord(notes("C4 E4 G4 B4"), maj, 'C3', 'C5', n: 3, need_root: true), note_name))`);
  // the last: from C4 E4 G4, C4 F4 A4 moves 0 + 3 + 5 steps; A3 C4 F4 would move 8 + 10 + 5
  assert.deepEqual(out.split("\n"), ["[98, 116, 136, 154]", '["A3", "C4", "F4"]', '["C4", "F4", "A4"]']);
  assert.match(err(HEAD('bars: 1, tuning: "31-TET"') + "nearest_chord(['C4'], {root: 0, ivs: [0, 10]}, 'D4', 'D4')").message, /no spelling/);
});

test("compile: version-2 cells, trim, cue lengths, the last cue halts, sections name patterns, lane pan on row 0", () => {
  const src = `tml 1
song { bars: 3, bar_rows: 16, cue_bars: 2, tuning: "12-TET" }
instrument P { bank: 0, program: 0 }
lane a { inst: P, pan: $40, trim: 0.5, label: "A" }
lane b { inst: P }
section "one" 1..2
section "two" 3..3
hit(a, 0, 'C4', 40)
hit(b, at(3), 'C4', 63)
vol_fine(b, at(3, 1), -3)
vol_slide(b, at(3, 2), 4)
set_vol(b, at(3, 3), 0)
`;
  const score = interpret(src);
  const { patterns, cues, names } = compileScore(score);
  assert.deepEqual(names, ["A one", "b two"]);
  const instr = (words, from) => { let w = 0; for (let b = 0; b < 16; b++) w |= ((words[from + b] >> 15) & 1) << b; return w; };
  assert.equal(instr(cues[0], 0), 0x0200 | 31, "cue 0 plays 32 rows");
  assert.equal(instr(cues[0], 16), 0);
  assert.equal(instr(cues[1], 0), 0x0200 | 15, "the last cue holds the song's last 16 rows");
  assert.equal(instr(cues[1], 16), 0x0100, "and then the song stops");
  assert.equal(cues[0][0] & 0x7fff, 0);
  assert.equal(cues[0][1] & 0x7fff, 0x7fff);
  assert.equal(cues[1][1] & 0x7fff, 1);
  // lane a, row 0: C4, instrument 1, volume 40 × trim 0.5, and its pan as S $8040
  assert.deepEqual(Array.from(patterns[0].subarray(0, 8)), [0x00, 0x50, 1, 20, 0xc0, 28, 0x40, 0x80]);
  const b = patterns[1];
  assert.deepEqual(Array.from(b.subarray(0, 8)), [0x00, 0x50, 1, 63, 0xc0, 0, 0, 0]);
  assert.equal(b[8 + 3], 0xc3, "fine slide down 3");
  assert.equal(b[16 + 3], 0x44, "slide up 4 a tick");
  assert.equal(b[24 + 3], 0, "a volume of 0 stays silent");
  assert.equal(b[32 + 3], 0xc0, "an empty cell is FINE by zero");
});

test("compile: the wide cell of a surround song (format 3)", () => {
  const src = `tml 1
song { bars: 1, bar_rows: 16, surround: "spatial" }
instrument P { bank: 0, program: 0 }
lane a { inst: P }
hit(a, 0, 'C4', 200, pos: dir(90, 45))
fx2(a, 0, "X", $1234)
vol_fine(a, 1, 100)
`;
  const score = interpret(src);
  assert.equal(score.song.format, 3);
  const p = compileScore(score).patterns[0];
  assert.equal(p.length, 1024);
  // azimuth 90° right = 256 (bit 8 in the selector byte), elevation 45° = 64
  assert.deepEqual(Array.from(p.subarray(0, 16)), [0x00, 0x50, 1, 200, 0x00, 0, 0, 0, 0x80, 64, 33, 0x34, 0x12, 0, 0, 0]);
  assert.equal(p[16 + 3], 0x80 | 100, "fine up 100");
  assert.equal(p[16 + 8], 0x33);
  assert.match(err(HEAD("bars: 1") + "fx2(a, 0, \"X\", 1)").message, /format-3/);
  assert.match(err('tml 1\nsong { bars: 1, format: 3 }').message, /surround/);
});

test("declarations say what is wrong with them", () => {
  assert.match(err("tml 1\nsong { bars: 4, tmepo: 120 }").message, /no option "tmepo" \(did you mean "tempo"\?\)/);
  assert.match(err("tml 1\nsong { tempo: 120 }").message, /needs bars/);
  assert.match(err("tml 1\nsong { bars: 1, bar_rows: 16, cue_bars: 8 }").message, /at most 64 rows/);
  assert.match(err("tml 1\ninstrument P { bank: 0, program: 0 }").message, /needs the song first/);
  assert.match(err("tml 1\nprint('C4')").message, /needs the song's tuning/);
  assert.match(err("tml 1\nsong { bars: 1 }\ninstrument P { bank: 0 }").message, /needs bank and program/);
  assert.match(err("tml 1\nsong { bars: 1 }\ninstrument P { bank: 0, program: 0 }\nlane a { label: \"x\" }").message, /must be an instrument/);
  assert.match(err(HEAD("bars: 1") + "hit(a, 999, 'C4', 1)").message, /outside the song/);
  assert.match(err(HEAD("bars: 1") + "hit(a, 0, 'C4', 64)").message, /0…63/);
  assert.match(err(HEAD("bars: 1") + "instrument Q { bank: 0, program: 1 }").message, /before the first lane/);
  assert.match(err(HEAD("bars: 1") + "master { eq: [{ type: \"notch\" }] }").message, /low_shelf/);
});

test("layer gains are decibel octets (§7.5)", () => {
  assert.equal(dbOctet(0), 0x9f);
  assert.equal(dbOctet(3), 0xb7);
  assert.equal(dbOctet(-3), 0x87);
  assert.equal(dbOctet(24), 255);
  assert.equal(dbOctet(-86), 1);
});

test("a whole build: bank, texts, notation, master and the source, into a Document that saves as it loads", async () => {
  // The bank step is the host's; hand it Huygens' Clock's own instruments.
  const demo = new Uint8Array(readFileSync(new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url)));
  const src = `tml 1
song { title: "Tiny", composer: "Tests", message: "line one\\nline two", bars: 2, bar_rows: 14, beat_rows: 2, tuning: "31-TET", tempo: 120 }
master { trim_db: -1, lim_on: true }
instrument KIT { bank: 128, program: 0, name: "Drums" }
instrument BASS { bank: 0, program: 35 }
lane k { inst: KIT, pan: $80 }
lane b { inst: BASS, label: "Bass" }
section "all" 1..2
for bar in 1..2 { hit(k, at(bar), midi(36), 50) }
melody(b, 0, "D2:7@40 A2:7@36 | D3:14@30")
`;
  const asked = [];
  const { doc, report } = await buildProject(src, {
    sf2Bank: async (selection, opts) => { asked.push([selection, opts]); return demo; },
  });
  assert.deepEqual(asked, [[[[128, 0], [0, 35]], { bpm: 120, soundfont: null }]]);
  assert.equal(report.lanes, 2);
  const td = new TextDecoder();
  const sec = (f) => doc.projSections.find((s) => s.fourcc === f)?.payload ?? null;
  assert.equal(td.decode(sec(MOTIF_FOURCC)), src, "the project keeps its source");
  assert.equal(td.decode(sec("PMsg")), "line one\nline two");
  assert.equal(td.decode(splitNameTable(sec("INam"))[1]), "Drums");
  assert.ok(sec("sMst"), "the master block becomes the song's mastering chain");
  assert.equal(doc.songs[0].numVoices, 2);
  // what the app does with a build from its worker: bytes → parse → Document
  const bytes = doc.toBytes();
  const again = new Document(parseTaud(bytes));
  assert.deepEqual(again.toBytes(), bytes);
  assert.equal(again.meta.songMeta[0].notation, 310);
  assert.equal(again.meta.songMeta[0].beatPri, 2);
  assert.equal(again.meta.songMeta[0].beatSec, 14);
  assert.equal(again.meta.songMeta[0].composer, "Tests");
});

test("every whole program in the docs, and the Motif view's example, runs", () => {
  const programs = [["the example", MOTIF_EXAMPLE]];
  for (const doc of ["TAUD_MOTIF_LANGUAGE.md", "USER_MANUAL.md"]) {
    const md = readFileSync(new URL(`../../assets/${doc}`, import.meta.url), "utf8");
    for (const m of md.matchAll(/```\n(tml [12]\n[\s\S]*?)```/g)) programs.push([doc, m[1]]);
  }
  assert.ok(programs.length >= 3);
  for (const [where, src] of programs) {
    const score = evaluate(src);
    assert.ok(score.lanes.some((l) => l.ev.size > 0), `${where}: a program that places nothing`);
  }
});
