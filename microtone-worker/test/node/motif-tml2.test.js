// TML 2, the declarative Taud Motif Language: a program says what the song is.
// Names can be used anywhere in their block, nothing changes once named, the
// music is a value (a phrase) and the song is every phrase the program's lines
// make — so the order they are written in changes nothing. TML 1 programs
// still build as they always did (the other motif-*.test.js files, all TML 1,
// are that promise); here, TML 2 itself, and the two side by side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { interpret, evaluate, captureCall } from "../../src/motif/build.js";
import { compileScore } from "../../src/motif/compile.js";
import { keyedRandom } from "../../src/motif/stdlib.js";
import { analyze, planRename } from "../../src/motif/analysis.js";
import { MotifError } from "../../src/motif/lexer.js";

const HEAD = (song = "bars: 2, bar_rows: 16") => `tml 2
song { ${song}, tuning: "12-TET" }
instrument P { bank: 0, program: 0 }
instrument Q { bank: 0, program: 1 }
lane a { inst: P }
lane b { inst: P }
lane c { inst: Q }
`;
const run = (body, opts = {}) => {
  const lines = [];
  const score = interpret(HEAD(opts.song) + body, { log: (l) => lines.push(l) });
  return { score, lines };
};
const err = (src) => {
  try { interpret(src); } catch (e) { if (e instanceof MotifError) return e; throw e; }
  assert.fail("expected a MotifError");
};
/** A lane's cells as [row, "NOTE@vol fx…"] — readable enough to compare. */
const cellsOf = (score, id) => {
  const lane = score.lanes.find((l) => l.id === id);
  return [...lane.ev].map(([r, c]) => {
    const note = c.note === undefined ? "" : c.note === 1 ? "off" : c.note === 2 ? "cut" : c.note === 3 ? "fade"
      : score.tuning.nameOfWord(c.note);
    const parts = [note];
    if (c.inst && c.inst !== lane.instrument) parts.push(`(${c.inst.id})`);
    if (c.vol !== undefined) parts.push(`@${c.vol}`);
    if (c.volRaw !== undefined) parts.push(`v$${c.volRaw.toString(16)}`);
    if (c.fx !== undefined) parts.push(`${String.fromCharCode(c.fx < 10 ? 48 + c.fx : 55 + c.fx)}$${c.arg.toString(16)}`);
    return [r, parts.join(" ").trim()];
  });
};
/** Every lane's cells, by place — for comparing two programs' songs. */
const song = (score) => score.lanes.map((l) => [l.index, [...l.ev].sort((p, q) => p[0] - q[0])
  .map(([r, c]) => [r, JSON.stringify(Object.entries({ ...c, inst: c.inst?.id }).sort())])]);

test("the order the lines are written in changes nothing", () => {
  const lines = [
    `hit(a, 0, 'C4', 40)`,
    `melody(b, 0, "E4:4v G4:8 r:4", vol: 30)`,
    `keyoff(a, 4)`,
    `hit(a, 4, 'D4', 41)`,       // a note wins over the key-off on its row, written either side of it
    `under(hit(c, 0, 'G4', 9))`,
    `under(hit(c, 2, 'G4', 9))`,
    `hit(c, 0, 'A4', 20)`,
    `let x = y + 1`,
    `let y = 2`,
    `hit(a, at(2), 'C4' + x)`,
  ];
  const forward = run(lines.join("\n")).score;
  const backward = run([...lines].reverse().join("\n")).score;
  assert.deepEqual(song(backward), song(forward));
  assert.deepEqual(cellsOf(forward, "a"), [[0, "C4 @40"], [4, "D4 @41"], [16, "D#4"]]);
  // under() gave way on row 0, where the song already plays an A4, and played on row 2
  assert.deepEqual(cellsOf(forward, "c"), [[0, "A4 @20"], [2, "G4 @9"]]);
  // the vibrato is fitted round the melody, two rows into its note
  assert.deepEqual(cellsOf(forward, "b"), [[0, "E4 @30"], [2, "H$7d14"], [3, "H$0"], [4, "G4 @30"], [12, "off"]]);
});

test("a TML 2 song is filled in time order, whatever order it was made in", () => {
  const { score } = run("hit(a, 20, 'C4')\nhit(a, 3, 'C4')\nhit(a, 11, 'C4')");
  assert.deepEqual([...score.lanes[0].ev.keys()], [3, 11, 20]);
});

test("names: anywhere in their block, defined once, never changed", () => {
  // a song block can read a name defined at the end of the file
  const s = evaluate(`tml 2
song { title: TITLE, bars: 1 }
lane a { inst: P }
instrument P { bank: 0, program: 0 }
hit(a, 0, 'C4')
let TITLE = "From " + where
let where = "below"
`);
  assert.equal(s.song.title, "From below");
  // lanes and instruments are numbered in the order written, whichever is needed first
  const t = interpret(`tml 2
song { bars: 1 }
lane second_lane { inst: LATER }
instrument EARLY { bank: 0, program: 0 }
instrument LATER { layers: [{ inst: EARLY }] }
lane first { inst: EARLY }
`);
  assert.deepEqual(t.lanes.map((l) => [l.id, l.index]), [["second_lane", 0], ["first", 1]]);
  assert.deepEqual(t.instruments.map((i) => [i.id, i.slot]), [["EARLY", 1], ["LATER", 2]]);
  assert.match(err("tml 2\nlet x = x + 1\n").message, /"x" is defined in terms of itself/);
  assert.match(err("tml 2\nlet a = b\nlet b = a\n").message, /defined in terms of itself/);
  assert.match(err("tml 2\nlet x = 1\nlet x = 2\n").message, /already defined here/);
  // a block's own names are its own, throughout the block
  assert.deepEqual(run("let k = 1\nfn f() {\n  print(k)\n  let k = 2\n}\nf()").lines, ["2"]);
});

test("what TML 2 leaves out, and what it says instead", () => {
  assert.match(err("tml 2\nlet x = 1\nx = 2\n").message, /never changes a name/);
  assert.match(err("tml 2\nlet r = { a: 1 }\nr.a += 1\n").message, /never changes a name/);
  assert.match(err("tml 2\nwhile false { }\n").message, /no while/);
  assert.match(err("tml 2\nfor i in 0..<3 { continue }\n").message, /no break or continue/);
  assert.match(err("tml 2\nfn f() { song { bars: 1 } }\n").message, /declared at the top of the program/);
  assert.match(err("tml 2\nlet xs = [1]\npush(xs, 2)\n").message, /xs \+ \[v\]/);
  assert.match(err("tml 2\nseed(4)\n").message, /song's seed is song \{ seed/);
  assert.match(err("tml 2\nprint(random())\n").message, /needs a key/);
  assert.match(err(HEAD() + "print(occupied(a, 0))").message, /occupied\(music, lane, row\)/);
  // a line on its own is music: a value nobody uses is a mistake
  assert.match(err("tml 2\n1 + 2\n").message, /makes a number and nothing uses it/);
  assert.match(err("tml 2\n[1, 2]\n").message, /a list with a number in it/);
  // a function makes music or returns a value — or returns music with it
  assert.match(err(HEAD() + "fn f() { hit(a, 0, 'C4'); return 3 }\nf()").message, /makes music and also returns a number/);
  assert.deepEqual(cellsOf(run("fn f() { hit(a, 0, 'C4'); return hit(a, 1, 'D4') }\nf()").score, "a"), [[0, "C4"], [1, "D4"]]);
  assert.deepEqual(run("fn f(n) { return n * 2 }\nprint(f(4))").lines, ["8"]);
});

test("comprehensions, filtered loops and expression functions", () => {
  const { lines } = run(`
fn sq(n) => n * n
print([sq(n) for n in 1..5 if n % 2 == 1])
print([[x, y] for x in 0..<3 for y in 0..<x])
print([i + v for i, v in [10, 20, 30]])
for n in 0..<6 if n % 3 == 0 { print(n) }
print(scan([1, 2, 3, 4], 0, fn(acc, v) => acc + v), with([1, 2, 3], -1, 9), with({ a: 1, b: 2 }, "a", 5))
`);
  assert.deepEqual(lines, ["[1, 9, 25]", "[[1, 0], [2, 0], [2, 1]]", "[10, 21, 32]", "0", "3", "[1, 3, 6, 10] [1, 2, 9] {a: 5, b: 2}"]);
});

test("putting music together: cells merge, and a clash names its place", () => {
  // two different notes on one row
  const e = err(HEAD() + "hit(a, 17, 'C4')\nhit(a, 17, 'D4')");
  assert.match(e.message, /lane a, bar 2 row 1: two different notes on one row \(C4 and D4\)/);
  assert.equal(e.pos.line, 9, "reported at the line that brings the clash");
  // two different endings clash too (neither is a note to win)
  assert.match(err(HEAD() + "keyoff(a, 3)\ncut(a, 3)").message, /two different notes on one row \(key-off and note cut\)/);
  // the same thing twice is the same thing
  assert.deepEqual(cellsOf(run("hit(a, 0, 'C4', 3)\nhit(a, 0, 'C4', 3)").score, "a"), [[0, "C4 @3"]]);
});

test("phrases are values: named, moved, repeated, joined, transformed, read", () => {
  const { score, lines } = run(`
let riff = melody(a, 0, "C4:2 E4:2 G4:4", vol: 30)
print(riff.from, riff.to, riff.rows, riff.lanes)
loop(riff, 2)                                 // rows 0–15, the second key-off meeting the next note
seq(hit(b, 0, 'C5'), rest(3), hit(b, 0, 'D5'))
on(c, transpose(slice(riff, 0, 4), 12))       // its first half, an octave up, on lane c — with c's instrument
let back = invert(hit(b, 20, 'E4', 5), 'C4')
back
map_vols(map_notes(hit(b, 24, 'C4', 10), fn(p) => p + 1), fn(v) => v * 2)
filter(melody(b, at(2, 12), "C4:1 D4:1 E4:1"), fn(cell) => cell.note != 'D4')
print(len(cells(riff)), cell(riff, a, 2).note == 'E4', occupied(riff, a, 3), cell(riff, a, 3))
`);
  assert.deepEqual(lines, ["0 8 8 [lane a]", "4 true false none"]);
  assert.deepEqual(cellsOf(score, "a"), [[0, "C4 @30"], [2, "E4 @30"], [4, "G4 @30"], [8, "C4 @30"], [10, "E4 @30"], [12, "G4 @30"], [16, "off"]]);
  assert.deepEqual(cellsOf(score, "b"), [[0, "C5"], [4, "D5"], [20, "G#3 @5"], [24, "C#4 @20"], [28, "C4"], [30, "E4"], [31, "off"]]);
  // the riff's notes played P, and on lane c play c's instrument
  assert.deepEqual(cellsOf(score, "c"), [[0, "C5 @30"], [2, "E5 @30"]]);
  assert.match(err(HEAD() + "shift(hit(a, 30, 'C4'), 4)").message, /outside the song/);
  // a phrase's last key-off moved to where the song ends is left out, as a melody leaves it
  assert.deepEqual(cellsOf(run(`loop(melody(a, 0, "C4:8 D4:8"), 2)`).score, "a"), [[0, "C4"], [8, "D4"], [16, "C4"], [24, "D4"]]);
});

test("reverse: the sounds and silences in the opposite order, each as long as it was", () => {
  const rev = (m) => cellsOf(run(`reverse(${m})`, { song: "bars: 4, bar_rows: 16" }).score, "a");
  const mel = (m) => cellsOf(run(m, { song: "bars: 4, bar_rows: 16" }).score, "a");
  // a melody backwards is the melody of its notes backwards, let go at its end
  assert.deepEqual(rev(`melody(a, 0, "C4:2 D4:2 E4:4")`), mel(`melody(a, 0, "E4:4 D4:2 C4:2")`));
  assert.deepEqual(rev(`melody(a, 0, "C4:4 r:4 D4:2 E4:6")`), mel(`melody(a, 0, "E4:6 D4:2 r:4 C4:4")`));
  assert.deepEqual(rev(`melody(a, 0, "r:4 C4:4")`), mel(`melody(a, 0, "C4:4 r:4")`));
  assert.deepEqual(rev(`melody(a, 0, "C4:2 D4:2 E4:4", ring: true)`), mel(`melody(a, 0, "E4:4 D4:2 C4:2", ring: true)`));
  // glides run the other way, each at the speed of the glide between the same two notes
  const g = mel(`melody(a, 0, "C4:4 ~E4:4 ~G4:4")`);
  assert.deepEqual(rev(`melody(a, 0, "C4:4 ~E4:4 ~G4:4")`), [[0, "G4"], [4, `E4 ${g[2][1].split(" ")[1]}`], [8, `C4 ${g[1][1].split(" ")[1]}`], [12, "off"]]);
  // a swell becomes a fade: struck at the volume the note ended at
  assert.deepEqual(rev(`stack(hit(a, 0, 'C4', 10), vol_ramp(a, 1, 8, 10, 40), keyoff(a, 8))`),
    [[0, "C4 @40"], [1, "v$c4"], [2, "v$c5"], [3, "v$c4"], [4, "v$c4"], [5, "v$c4"], [6, "v$c5"], [7, "v$c4"], [8, "off"]]);
  // a fitted vibrato is fitted again where its rows now lie
  assert.deepEqual(rev(`melody(a, 0, "C4:8v D4:4", vol: 30)`),
    [[0, "D4 @30"], [4, "C4 @30 H$7d14"], [5, "H$0"], [6, "H$0"], [7, "H$0"], [8, "H$0"], [9, "H$0"], [12, "off"]]);
  // lists and strings reverse as before
  assert.deepEqual(run(`print(reverse([1, 2, 3]), reverse("abc"))`).lines, ["[3, 2, 1] cba"]);
});

test("stretch: slower or faster, from the music's start", () => {
  const out = (m) => cellsOf(run(m, { song: "bars: 4, bar_rows: 16" }).score, "a");
  const twice = out(`stretch(melody(a, 0, "C4:2 ~D4:2 E4:4v", vol: 30), 2)`);
  const once = out(`melody(a, 0, "C4:2 ~D4:2 E4:4v", vol: 30)`);
  const speed = (cells, r) => parseInt(cells.find(([row]) => row === r)[1].split("G$")[1], 16);
  assert.deepEqual(twice.map(([r, c]) => [r, c.replace(/G\$\w+/, "G")]), [[0, "C4 @30"], [4, "D4 G"], [8, "E4 @30"], [12, "H$7d14"], [13, "H$0"], [14, "H$0"], [15, "H$0"], [16, "off"]]);
  assert.equal(speed(twice, 4), Math.round(speed(once, 2) / 2), "a glide takes twice as long");
  assert.deepEqual(out(`stretch(melody(a, 0, "C4:2 D4:2 E4:4"), 0.5)`), out(`melody(a, 0, "C4:1 D4:1 E4:2")`));
  // a run of an effect is drawn out; a volume slide's change is spread over the new rows
  assert.deepEqual(out(`stretch(stack(hit(a, 0, 'C4', 20), [vol_slide(a, r, 2) for r in 1..2], fx(a, 3, "Q", $0300), fx(a, 4, "Q", $0300)), 2)`),
    [[0, "C4 @20"], [2, "v$41"], [3, "v$41"], [4, "v$41"], [5, "v$41"], [6, "Q$300"], [7, "Q$300"], [8, "Q$300"], [9, "Q$300"]]);
  assert.match(err(HEAD() + `stretch(melody(a, 0, "C4:1 D4:1"), 0.5)`).message, /row 1 of lane a between two rows/);
  assert.match(err(HEAD() + `stretch(hit(a, 0, 'C4'), 0)`).message, /factor above 0/);
});

test("reverse and stretch keep their laws", () => {
  // the phrases notes, volumes, glides, vibratos, slides, steps, effects and ramps
  const phrases = [
    `melody(a, 0, "C4:4@30 r:4 D4:2@30 ~E4:6@34v F4:2@20", vol: 30)`,
    `stack(melody(a, 0, "G4:6 C4:2v ~A4:4 ~E4:8 ~D4:2@27v", vol: 30), melody(b, 0, "r:4 E4:2 r:8 C5:4v ~B4:2@26v", vol: 20))`,
    `stack(hit(a, 0, 'C4', 20), [vol_slide(a, r, 2) for r in 1..3], [vol_fine(a, r, -1) for r in 5..7], keyoff(a, 8), fx(c, 3, "S", $7300), fx(c, 4, "Q", $0300), [fx(c, r, "Q", 0) for r in 5..7])`,
    `stack(hit(c, 0, 'C4', 20), vol_ramp(c, 1, 8, 20, 50), keyoff(c, 8), under(hit(b, 6, 'E4', 9)))`,
  ];
  for (const p of phrases) {
    const long = { song: "bars: 8, bar_rows: 16" };
    const same = (x, y, law) => assert.deepEqual(song(run(`let P0 = ${p}\n${y}`, long).score), song(run(`let P0 = ${p}\n${x}`, long).score), `${law}: ${p}`);
    same("P0", "reverse(reverse(P0))", "reversed twice");
    same("stretch(P0, 2)", "reverse(reverse(stretch(P0, 2)))", "reversed twice, stretched");
  }
  // stretched and back (a glide's speed is rounded: compared without it)
  const noGlides = (score) => song(score).map(([i, cells]) => [i, cells.map(([r, c]) => [r, c.replace(/\["arg",\d+\],(\["fx",16\])/, "$1")])]);
  for (const p of phrases) {
    const long = { song: "bars: 8, bar_rows: 16" };
    assert.deepEqual(noGlides(run(`let P0 = ${p}\nstretch(stretch(P0, 2), 0.5)`, long).score), noGlides(run(`let P0 = ${p}\nP0`, long).score), `stretched and back: ${p}`);
    assert.deepEqual(noGlides(run(`let P0 = ${p}\nstretch(stretch(P0, 3), 1 / 3)`, long).score), noGlides(run(`let P0 = ${p}\nP0`, long).score), `stretched by 3 and back: ${p}`);
  }
  // reverse and stretch in either order: the same notes
  const m = `stack(melody(a, 0, "C4:4@30 r:4 D4:2@30 ~E4:6@34v"), melody(b, 0, "B4:8 F4:2", ring: true))`;
  assert.deepEqual(song(run(`reverse(stretch(${m}, 2))`, { song: "bars: 8, bar_rows: 16" }).score), song(run(`stretch(reverse(${m}), 2)`, { song: "bars: 8, bar_rows: 16" }).score));
  // one volume column: a volume and a command on one row is a clash
  assert.match(err(HEAD() + "hit(a, 0, 'C4', 40)\nvol_fine(a, 0, -2)").message, /a volume \(40\) and a volume-column command on one row/);
});

test("fitted music: placed once the whole song is known, so order cannot matter", () => {
  // the vibrato steps round an effect written on a later line, and a key-off ends it
  const v = run(`melody(a, 0, "C4:8v", vol: 20)\nfx(a, 4, "S", $7300)`).score;
  assert.deepEqual(cellsOf(v, "a"), [[0, "C4 @20"], [2, "H$7d14"], [3, "H$0"], [4, "S$7300"], [5, "H$7d14"], [6, "H$0"], [7, "H$0"], [8, "off"]]);
  // a ramp steps round volumes the song sets
  const r = run(`hit(a, 0, 'C4', 10)\nvol_ramp(a, 1, 5, 10, 30)\nhit(a, 3, 'D4', 50)`).score;
  assert.deepEqual(cellsOf(r, "a"), [[0, "C4 @10"], [1, "v$e5"], [2, "v$e5"], [3, "D4 @50"], [4, "v$ea"]]);
  // under() a column: only the rows where that column is free
  const u = run(`hit(a, 0, 'C4', 10, fx: "S", arg: $7300)\nunder([fx(a, r, "Z", 1) for r in 0..<3], "fx")\nhit(a, 1, 'D4')`).score;
  assert.deepEqual(cellsOf(u, "a"), [[0, "C4 @10 S$7300"], [1, "D4 Z$1"], [2, "Z$1"]]);
  // follow(): music made from what another lane plays — a harmony a third up
  const f = run(`melody(a, 0, "C4:2 E4:2 r:4")
follow(a, 0, 8, fn(heard) => [hit(b, r, n.note + 4, 9) for r, n in heard if n != none and type(n.note) == "number"])`).score;
  assert.deepEqual(cellsOf(f, "b"), [[0, "E4 @9"], [2, "G#4 @9"]]);
  // a fitted part moves with its phrase
  const s = run(`shift(melody(a, 0, "C4:4v", vol: 20), 16)\nfx(a, 18, "S", 0)`).score;
  assert.deepEqual(cellsOf(s, "a"), [[16, "C4 @20"], [18, "S$0"], [19, "H$7d14"], [20, "off"]]);
  // two fitted parts that collide are a clash, reported where the second was made
  assert.match(err(HEAD() + "under(hit(a, 2, 'C4'))\nunder(hit(a, 2, 'D4'))").message, /two different notes/);
});

test("randomness: a function of the seed and the keys, specified", () => {
  // the test vectors of TAUD_MOTIF_LANGUAGE.md §10
  assert.equal(keyedRandom(1, [0]), 0.6445763253141195);
  assert.equal(keyedRandom(1, ["walk", 1]), 0.8974380060099065);
  assert.equal(keyedRandom(19, ["walk", 1]), 0.4422831176780164);
  assert.equal(keyedRandom(1, ["héllo, 世界"]), 0.9516397698316723);
  assert.equal(keyedRandom(1, [-1]), keyedRandom(1, [4294967295]));
  assert.notEqual(keyedRandom(1, ["a", "b"]), keyedRandom(1, ["ab"]));
  assert.notEqual(keyedRandom(1, [97]), keyedRandom(1, ["a"]));
  // the same keys, the same answer, wherever and however often they are asked
  const { lines } = run(`
print(random("x", 1) == random("x", 1), random("x", 1) == random("x", 2))
print(random_int(1, 6, "die", 3), chance(0.5, "coin"), choose([1, 2, 3], "pick"))
print(sort(shuffle([1, 2, 3, 4, 5], "deal")), choose_weighted(["a", "b"], [0, 1], "w"))
`, { song: "bars: 1, seed: 7" });
  assert.equal(lines[0], "true false");
  assert.deepEqual(lines[1].split(" ").map(Number).length, 3);
  assert.equal(lines[2], "[1, 2, 3, 4, 5] b");
  const again = run(`print(random_int(1, 6, "die", 3), chance(0.5, "coin"), choose([1, 2, 3], "pick"))`, { song: "bars: 1, seed: 7" }).lines;
  assert.deepEqual(again, [lines[1]]);
  assert.match(err(HEAD() + "print(random(1.5))").message, /whole number/);
});

test("Huygens' Clock in TML 2 is the song TML 1 wrote, cell for cell", () => {
  const v1 = evaluate(readFileSync(new URL("../fixtures/huygens-clock-tml1.tml", import.meta.url), "utf8"));
  const v2 = evaluate(readFileSync(new URL("../../assets/demo_projects/Huygens_clock.tml", import.meta.url), "utf8"));
  assert.match(readFileSync(new URL("../../assets/demo_projects/Huygens_clock.tml", import.meta.url), "utf8"), /^tml 2\n/);
  assert.deepEqual(song(v2), song(v1));
  const a = compileScore(v1), b = compileScore(v2);
  assert.deepEqual(b.names, a.names);
  assert.deepEqual(b.patterns.map((p) => Array.from(p)), a.patterns.map((p) => Array.from(p)));
  assert.deepEqual(b.cues.map((c) => Array.from(c)), a.cues.map((c) => Array.from(c)));
  assert.equal(v2.song.message, v1.song.message);
});

test("Preview in TML 2: everything a call makes, as the song plays it", () => {
  const src = HEAD() + `fn beat(row) => hit(b, row, 'C4', 40)
for bar in 1..2 { beat(at(bar, 4)) }
transpose(melody(a, 0, "C4:2 D4:2"), 12)
under(hit(c, 0, 'E4', 9))
hit(c, 0, 'F4', 1)
`;
  // a call inside a loop: each time it runs
  const loop = captureCall(src, src.indexOf("beat(at"));
  assert.deepEqual(loop.lanes.map((l) => [l.id, l.cells.map(([r]) => r)]), [["b", [4, 20]]]);
  // a call inside a transformation: what the song plays (an octave up)
  const mel = captureCall(src, src.indexOf("melody(a"));
  assert.deepEqual(mel.lanes[0].cells.map(([r, c]) => [r, mel.names[c.note] ?? c.note]), [[0, "C5"], [2, "D5"], [4, 1]]);
  // music that gave way to the rest of the song is not played
  assert.equal(captureCall(src, src.indexOf("under(")).first, null);
  // a transformation of music made elsewhere: what the transformation makes
  const named = HEAD() + `let RIFF = melody(a, 0, "C4:2 E4:2v")\nstack(RIFF, on(b, transpose(RIFF, 7)))\n`;
  const tr = captureCall(named, named.indexOf("transpose("));
  assert.deepEqual(tr.lanes.map((l) => [l.id, l.cells.map(([r, c]) => tr.names[c.note] ?? c.note)]), [["b", ["G4", "B4", 1]]]);
  const moved = captureCall(named, named.indexOf("on(b"));
  assert.deepEqual(moved.lanes.map((l) => l.id), ["b"]);
  // …but a call's own key-off still ends its last note where the next phrase begins
  const two = HEAD() + `melody(a, 0, "C4:4")\nmelody(a, 4, "D4:4")\n`;
  const first = captureCall(two, two.indexOf("melody(a, 0"));
  assert.deepEqual(first.lanes[0].cells.map(([r, c]) => [r, c.note]), [[0, first.lanes[0].cells[0][1].note], [4, 1]]);
});

test("the editor reads TML 2 by its rules", () => {
  const src = `tml 2
hit(a, 0, top(), 1)
fn top() => base + 2
let base = [k for k in 0..<3][2]
lane a { inst: P }
instrument P { bank: 0, program: 0 }
song { bars: 1 }
`;
  const an = analyze(src);
  const use = (needle, n = 0) => {
    let i = -1;
    for (let k = 0; k <= n; k++) i = src.indexOf(needle, i + 1);
    return an.occAt(i);
  };
  // used before the line that defines it: the same name
  assert.equal(use("a,").sym, use("a {").sym);
  assert.equal(use("base").sym, use("base =").sym);
  assert.equal(use("P }").sym.kind, "instrument");
  // a comprehension's variable, named before its `for`
  assert.equal(use("k for").sym, use("k in").sym);
  const r = planRename(src, src.indexOf("base"), "floor_note");
  assert.equal(r.count, 2);
  assert.ok(r.source.includes("fn top() => floor_note + 2") && r.source.includes("let floor_note ="));
  // a new name that a block already defines (anywhere in it) is a clash
  assert.equal(planRename(src, src.indexOf("base"), "top").error, "conflict");
});
