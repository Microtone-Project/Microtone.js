// chord_line (TML 2): a melody or bass line made from a chord progression —
// random material drawn from what each chord allows, smoothed into the most
// coherent line by an exact search. The weights are part of every song that
// uses it, so one line per role is pinned note for note; the rest checks what
// the spec promises of any line, over many seeds.

import { test } from "node:test";
import assert from "node:assert/strict";

import { interpret } from "../../src/motif/build.js";
import { MotifError } from "../../src/motif/lexer.js";

const HEAD = (tuning = "12-TET", seed = 1, version = 2) => `tml ${version}
song { bars: 8, tuning: "${tuning}", seed: ${seed} }
instrument P { bank: 0, program: 0 }
lane a { inst: P }
`;
const CHORDS12 = `
fn ch(n, ivs) => { root: degree(n), ivs: ivs, name: n }
let MAJ = [0, 4, 7]
let MIN = [0, 3, 7]
let CH = [ch("C", MAJ), ch("A", MIN), ch("D", MIN), ch("G", [0, 4, 7, 10]), ch("C", MAJ), ch("F", MAJ), ch("G", MAJ), ch("C", MAJ)]
`;
/** Each print(…) of a list of pitches, as a list of numbers. */
const lines = (src) => {
  const out = [];
  interpret(src, { log: (l) => out.push(l) });
  return out.map((l) => l.split(" ").filter(Boolean).map(Number));
};
const names = (src) => {
  const out = [];
  interpret(src, { log: (l) => out.push(l) });
  return out;
};
const err = (src) => {
  try { interpret(src); } catch (e) { if (e instanceof MotifError) return e; throw e; }
  assert.fail("expected a MotifError");
};
const P = 12;
const pc = (s) => ((s % P) + P) % P;
const CH12 = [[0, [0, 4, 7]], [9, [0, 3, 7]], [2, [0, 3, 7]], [7, [0, 4, 7, 10]], [0, [0, 4, 7]], [5, [0, 4, 7]], [7, [0, 4, 7]], [0, [0, 4, 7]]]
  .map(([root, ivs]) => ({ root, classes: new Set(ivs.map((i) => pc(root + i))) }));
const DIATONIC = new Set([0, 2, 4, 5, 7, 9, 11]);

test("chord_line: the pinned lines (the weights are part of the output)", () => {
  const got = names(HEAD() + CHORDS12 + `
let M = chord_line(CH, 'C4', 'C6', "tune", per: 4)
print(join(map(M, note_name), " "))
print(join(map(chord_line(CH, 'C4', 'C6', per: 4, variety: 0), note_name), " "))
print(join(map(chord_line(CH, 'C2', 'C4', "bass", per: 2, role: "bass", against: [M[i * 2] for i in 0..<16]), note_name), " "))
`);
  assert.deepEqual(got, [
    "E5 D5 C5 B4 A4 C5 D5 E5 F5 D5 C5 D5 B4 D5 C5 D5 E5 C5 B4 C5 A4 C5 B4 C5 D5 E5 D5 B4 C5 D5 E5 C5",
    "E5 D5 C5 B4 C5 B4 C5 E5 F5 D5 E5 F5 G5 F5 G5 F5 E5 D5 C5 B4 C5 B4 C5 A4 B4 C5 B4 D5 E5 C5 B4 C5",
    "C3 G2 A2 E3 D3 A2 G2 B2 C3 C3 F3 F2 G2 B2 C3 C3",
  ]);
});

test("chord_line: what every line keeps to, over many seeds", () => {
  for (let seed = 1; seed <= 24; seed++) {
    for (const [role, lo, hi, per, variety] of [["melody", 48, 72, 4, 1], ["melody", 52, 76, 3, 2.5], ["bass", 24, 48, 2, 1]]) {
      const [L] = lines(HEAD("12-TET", seed) + CHORDS12
        + `print(join(map(chord_line(CH, ${lo}, ${hi}, ["k", ${seed}], per: ${per}, role: "${role}", variety: ${variety}), str), " "))`);
      const where = `seed ${seed}, ${role}`;
      assert.equal(L.length, 8 * per, where);
      const deg = [...DIATONIC].sort((x, y) => x - y);
      const place = (s) => Math.floor(s / P) * 7 + deg.indexOf(pc(s));
      L.forEach((s, i) => {
        const chord = CH12[Math.floor(i / per)];
        assert.ok(s >= lo && s <= hi, `${where}: note ${i} out of range`);
        assert.ok(DIATONIC.has(pc(s)), `${where}: note ${i} is off the progression's own scale`);
        // the first note of each chord is one of its notes
        if (i % per === 0) assert.ok(chord.classes.has(pc(s)), `${where}: note ${i} is the first of its chord and not in it`);
        // a note outside its chord is reached and left by a step
        if (!chord.classes.has(pc(s))) {
          assert.ok(i > 0 && i < L.length - 1, `${where}: note ${i}, outside its chord, at an end of the line`);
          assert.equal(Math.abs(place(s) - place(L[i - 1])), 1, `${where}: note ${i} is reached by a leap`);
          assert.equal(Math.abs(place(L[i + 1]) - place(s)), 1, `${where}: note ${i} is left by a leap`);
        }
        if (i > 0) assert.ok(Math.abs(s - L[i - 1]) <= 12, `${where}: a leap wider than an octave at ${i}`);
      });
      // a bass prefers its chords' roots (an inversion now and then is allowed)
      if (role === "bass") {
        const roots = L.filter((s, i) => i % per === 0 && pc(s) === CH12[i / per].root).length;
        assert.ok(roots >= 6, `${where}: only ${roots} of 8 chords on their root`);
      }
    }
  }
});

test("chord_line: keyed like every random choice; variety 0 needs no key and no seed", () => {
  const src = (seed, key) => HEAD("12-TET", seed) + CHORDS12 + `print(join(map(chord_line(CH, 'C4', 'C6', ${key}, per: 4), str), " "))`;
  const a = lines(src(1, `"tune"`))[0];
  assert.deepEqual(lines(src(1, `"tune"`))[0], a);
  assert.deepEqual(lines(src(1, `["tune"]`))[0], a, "a key and a list of one key are the same key");
  assert.notDeepEqual(lines(src(2, `"tune"`))[0], a, "another seed, another line");
  assert.notDeepEqual(lines(src(1, `"other"`))[0], a, "another key, another line");
  const flat = (seed) => lines(HEAD("12-TET", seed) + CHORDS12 + `print(join(map(chord_line(CH, 'C4', 'C6', per: 4, variety: 0), str), " "))`)[0];
  assert.deepEqual(flat(1), flat(7));
});

test("chord_line: start, end, a scale, per as a list, and against", () => {
  const [L, S, Q] = lines(HEAD() + CHORDS12 + `
print(join(map(chord_line(CH, 'C4', 'C6', "t", per: 2, start: 'G4', end: 'E5'), str), " "))
print(join(map(chord_line(CH[0..<2], 'C4', 'C6', "t", per: 8, scale: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], variety: 0), str), " "))
print(join(map(chord_line(CH, 'C4', 'C6', "t", per: [1, 1, 2, 2, 1, 1, 4, 1]), str), " "))
`);
  assert.equal(L[0], 55);
  assert.equal(L.at(-1), 64);
  assert.equal(L.length, 16);
  assert.equal(Q.length, 13);
  assert.equal(S.length, 16);
  // a melody given a bass stays above it and moves into no octave or fifth in parallel with it
  const [M, B] = lines(HEAD() + CHORDS12 + `
let B = chord_line(CH, 'C3', 'C4', "b", role: "bass")
let M = chord_line(CH, 'C3', 'C6', "m", against: B)
print(join(map(M, str), " "))
print(join(map(B, str), " "))
`);
  M.forEach((m, i) => {
    assert.ok(m > B[i], `the melody crosses the bass at ${i}`);
    if (i === 0) return;
    const perfect = (x) => x % 12 === 0 || x % 12 === 7;
    const moved = m !== M[i - 1] && B[i] !== B[i - 1] && Math.sign(m - M[i - 1]) === Math.sign(B[i] - B[i - 1]);
    assert.ok(!(moved && perfect(m - B[i]) && perfect(M[i - 1] - B[i - 1])), `parallel perfect interval into note ${i}`);
  });
});

test("chord_line works in any tuning: 31-TET, steps along the progression's scale", () => {
  const [M] = lines(HEAD("31-TET") + `
let D = degree("D")
let CH = [{root: D, ivs: [0, 10, 18, 25]}, {root: degree("G"), ivs: [0, 10, 18]}, {root: degree("A"), ivs: [0, 10, 18, 25]}, {root: D, ivs: [0, 8, 18]}]
print(join(map(chord_line(CH, 'D4', 'D6', "x", per: 3), str), " "))
`);
  assert.equal(M.length, 12);
  assert.equal(M.at(-1) % 31, 5, "ends on D");
});

test("chord_line: its errors", () => {
  const H = HEAD() + CHORDS12;
  assert.match(err(H + `chord_line(CH, 'C4', 'C6')`).message, /needs a key/);
  assert.match(err(H + `chord_line(CH, 'C4', 'C6', "t", per: [1, 2])`).message, /per gives 2 counts for 8 chords/);
  assert.match(err(H + `chord_line(CH, 'C4', 'C6', "t", per: 0)`).message, /per is at least 1/);
  assert.match(err(H + `chord_line(CH, 'C4', 'C6', "t", role: "alto")`).message, /role is "melody" or "bass"/);
  assert.match(err(H + `chord_line(CH, 'C6', 'C4', "t")`).message, /runs backwards/);
  assert.match(err(H + `chord_line(CH, 'C4', 'C#4', "t")`).message, /no note of D lies within C4…C#4/);
  assert.match(err(H + `chord_line(CH, 'C4', 'C6', "t", end: 'C2')`).message, /end C2 is outside the range/);
  assert.match(err(H + `chord_line(CH, 'C4', 'C6', "t", against: [60])`).message, /against has 1 notes, and the line 8/);
  assert.match(err(H + `chord_line([1], 'C4', 'C6', "t")`).message, /chord 1 must be a record/);
  assert.match(err(H + `chord_line([{ root: 0 }], 'C4', 'C6', "t")`).message, /chord 1 must be a chord: a record with root/);
  assert.match(err(H + `chord_line(CH * 64, 'C0', 'C9', "t", per: 4, scale: list(0..<12))`).message, /narrow its range or its scale/);
  // TML 2 only: TML 1 has its random stream, not keys
  assert.match(err(HEAD("12-TET", 1, 1) + `let x = chord_line([], 0, 1, "t")`).message, /chord_line/);
});
