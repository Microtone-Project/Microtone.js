// The Keymap Maker's scales and layouts (src/ui/keymapscale.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makerFrame, kindAvailable, scaleOf, scaleOffsets, makeScaleKeymap,
  mosPatterns, mosModes, mosSizes, defaultMosSize, rowStepOf, HEPTA_MODES,
} from "../../src/ui/keymapscale.js";
import {
  ROW_CODES, resolveKeymap, keymapNote, keymapStats, parseTaudkey, buildTaudkey,
} from "../../src/ui/keymap.js";
import { pitchTablePresets, nearestDegreeIndex } from "../../core/tuning/pitchtables.js";

const P = pitchTablePresets;
const tuning = (idx) => makerFrame("tuning", P[idx]);
const ANY = makerFrame("any");
const rowValues = (spec, row) => ROW_CODES[row].map((c) => spec.overrides[c]);

test("the frames: degrees of the song's tuning, or semitones for any", () => {
  assert.deepEqual(tuning(310), { mode: "tuning", unit: "deg", n: 31, octave: true, usable: true });
  assert.equal(tuning(35130).octave, false, "Bohlen–Pierce repeats at the tritave");
  // ProTracker's absolute table steps a semitone per entry: counted as 12-EDO.
  assert.deepEqual(tuning(1), { mode: "tuning", unit: "semi", n: 12, octave: true, usable: true });
  assert.equal(tuning(0).usable, false, "a Raw song has no degrees to count");
  assert.deepEqual(ANY, { mode: "any", unit: "semi", n: 12, octave: true, usable: true });
});

test("what each tuning can play — and what it cannot is still asked about, not hidden", () => {
  const avail = (idx) => ["penta", "hepta", "mos"].map((k) => kindAvailable(k, tuning(idx)));
  assert.deepEqual(avail(120), [true, true, true]);
  assert.deepEqual(avail(310), [true, true, true]);
  assert.deepEqual(avail(170), [true, true, true]);
  // 13-TET's patent fifth gives a limma of −1: no diatonic, but MOS scales.
  assert.deepEqual(avail(130), [false, false, true]);
  // 5-TET is its own (equal) pentatonic, and has no room for seven notes.
  assert.deepEqual(avail(50), [true, false, true]);
  // A non-octave period has no chain of fifths, but it has MOS scales (Lambda).
  assert.deepEqual(avail(35130), [false, false, true]);
  assert.deepEqual(avail(0), [false, false, false]);
  for (const k of ["penta", "hepta", "mos"]) assert.equal(kindAvailable(k, ANY), true);
});

test("12-TET: the seven modes are the major scale rotated", () => {
  const f = tuning(120);
  const expect = {
    ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
  };
  assert.deepEqual(Object.keys(expect), [...HEPTA_MODES]);
  for (const [mode, offsets] of Object.entries(expect)) {
    assert.deepEqual(scaleOffsets(scaleOf({ kind: "hepta", hepta: mode }, f)), offsets, mode);
  }
  assert.deepEqual(scaleOffsets(scaleOf({ kind: "penta", penta: "major" }, f)), [0, 2, 4, 7, 9]);
  assert.deepEqual(scaleOffsets(scaleOf({ kind: "penta", penta: "minor" }, f)), [0, 3, 5, 7, 10]);
});

test("the diatonic follows the tuning's own chain of fifths", () => {
  // 31-TET is meantone: tone 5, diatonic semitone 3.
  assert.deepEqual(scaleOf({ kind: "hepta", hepta: "ionian" }, tuning(310)).steps, [5, 5, 3, 5, 5, 5, 3]);
  // 17-TET is superpythagorean: tone 3, semitone 1.
  assert.deepEqual(scaleOf({ kind: "hepta", hepta: "dorian" }, tuning(170)).steps, [3, 1, 3, 3, 3, 1, 3]);
  // Any tuning: 12-EDO semitones, whole numbers.
  assert.deepEqual(scaleOf({ kind: "hepta", hepta: "ionian" }, ANY),
    { steps: [2, 2, 1, 2, 2, 2, 1], period: 12, unitPerStep: 1, word: null });
});

test("MOS patterns: coprime, four to twelve notes", () => {
  const ps = mosPatterns();
  assert.ok(ps.some((p) => p.a === 5 && p.b === 2));
  assert.ok(ps.every((p) => p.size >= 4 && p.size <= 12 && p.a + p.b === p.size));
  assert.ok(!ps.some((p) => p.a === 2 && p.b === 4), "2L 4s is 1L 2s twice");
});

test("MOS modes, brightest first: 5L 2s runs Lydian … Locrian", () => {
  assert.deepEqual(mosModes(5, 2),
    ["LLLsLLs", "LLsLLLs", "LLsLLsL", "LsLLLsL", "LsLLsLL", "sLLLsLL", "sLLsLLL"]);
  assert.deepEqual(mosModes(2, 3), ["LsLss", "LssLs", "sLsLs", "sLssL", "ssLsL"]);
  for (const p of mosPatterns()) {
    const modes = mosModes(p.a, p.b);
    assert.equal(modes.length, p.size, `${p.a}L ${p.b}s has one mode per note`);
    for (const w of modes) {
      assert.equal([...w].filter((c) => c === "L").length, p.a);
    }
  }
});

test("MOS step sizes: exactly the pairs that fill the tuning's period", () => {
  assert.deepEqual(mosSizes(5, 2, tuning(120)), [[2, 1]]);
  assert.deepEqual(mosSizes(5, 2, tuning(310)), [[5, 3]]);
  assert.deepEqual(mosSizes(5, 2, tuning(530)), [[9, 4]]);
  assert.deepEqual(mosSizes(5, 2, tuning(130)), [], "13-TET has no 5L 2s with L > s");
  // Bohlen–Pierce's Lambda scale is 4L 5s at 2:1 on thirteen steps of the tritave.
  assert.deepEqual(mosSizes(4, 5, tuning(35130)), [[2, 1]]);
  for (const [L, s] of mosSizes(3, 4, tuning(410))) assert.equal(3 * L + 4 * s, 41);
  // Any tuning offers ratios, each making an equal tuning of its own.
  assert.ok(mosSizes(5, 2, ANY).some(([L, s]) => L === 3 && s === 1));
  assert.deepEqual(defaultMosSize(mosSizes(5, 2, ANY)), [2, 1]);
  assert.deepEqual(defaultMosSize([[5, 3]]), [5, 3]);
  assert.equal(defaultMosSize([]), null);
});

test("an unplayable choice makes no scale", () => {
  assert.equal(scaleOf({ kind: "hepta", hepta: "ionian" }, tuning(130)), null);
  assert.equal(scaleOf({ kind: "mos", mos: { a: 5, b: 2, L: 2, s: 1, mode: 0 } }, tuning(310)), null,
    "2:1 does not fill 31 degrees");
  assert.equal(makeScaleKeymap({ kind: "hepta", hepta: "ionian" }, tuning(0)), null);
});

test("the layout: a run up the scale per row, a period between rows, the A row on the tonic", () => {
  const spec = makeScaleKeymap({
    kind: "hepta", hepta: "ionian", tonic: 0, rows: ["N", "Q", "A", "Z"], name: "C major",
  }, tuning(120));
  assert.equal(spec.unit, "deg");
  assert.equal(spec.x, 0);
  assert.equal(spec.y, 0);
  assert.deepEqual(spec.rows, ["Z", "A", "Q", "N"]);
  assert.deepEqual(rowValues(spec, "A"), [0, 2, 4, 5, 7, 9, 11, 12, 14, 16]);
  assert.deepEqual(rowValues(spec, "Q"), [12, 14, 16, 17, 19, 21, 23, 24, 26, 28]);
  assert.deepEqual(rowValues(spec, "Z"), [-12, -10, -8, -7, -5, -3, -1, 0, 2, 4]);
  assert.equal(resolveKeymap(spec).size, 40, "every key plays");
  const stats = keymapStats(spec, P[120], 4);
  assert.equal(stats.reachable, 7, "only the scale's seven notes");
  // Every key lands on a degree of the scale.
  for (const code of resolveKeymap(spec).keys()) {
    const deg = nearestDegreeIndex(keymapNote(spec, code, 4, P[120]), P[120]).index;
    assert.ok([0, 2, 4, 5, 7, 9, 11].includes(deg), `${code} → degree ${deg}`);
  }
});

test("the tonic, the row step and the rows", () => {
  const f = tuning(310);
  const d = makeScaleKeymap({ kind: "hepta", hepta: "dorian", tonic: 5, rows: ["A"] }, f);
  assert.deepEqual(rowValues(d, "A"), [5, 10, 13, 18, 23, 28, 31, 36, 41, 44]);
  assert.deepEqual(d.rows, ["A"]);
  assert.equal(d.origin.value, 5);
  // Continuing rows: the Q row picks up where A ends, nothing doubled.
  const run = makeScaleKeymap({ kind: "penta", penta: "major", tonic: 0, rows: ["Q", "A"], rowStep: 10 }, tuning(120));
  assert.deepEqual(rowValues(run, "A"), [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]);
  assert.deepEqual(rowValues(run, "Q"), [24, 26, 28, 31, 33, 36, 38, 40, 43, 45]);
  assert.equal(keymapStats(run, P[120], 3).duplicates, 0);
  assert.equal(rowStepOf({ rowStep: null }, 7), 7);
  assert.equal(rowStepOf({ rowStep: 3 }, 7), 3);
  assert.equal(rowStepOf({ rowStep: 0 }, 7), 7);
});

test("any tuning: semitones, and a MOS lands on the equal tuning it defines", () => {
  // 5L 2s at 3:1 is 17-TET; mode 2 (Ionian-shaped) LLsLLLs.
  const spec = makeScaleKeymap({
    kind: "mos", mos: { a: 5, b: 2, L: 3, s: 1, mode: 1 }, tonic: 2, rows: ["A"], name: "x",
  }, ANY);
  assert.equal(spec.unit, "semi");
  const step = 12 / 17;
  const expect = [0, 3, 6, 7, 10, 13, 16, 17, 20, 23].map((k) => Math.round((2 + k * step) * 1e6) / 1e6);
  assert.deepEqual(rowValues(spec, "A"), expect);
  // Played in 17-TET the keys are the scale's own degrees, k steps above the
  // degree nearest the tonic (two semitones ≈ 2.83 steps → degree 3).
  const degrees = ROW_CODES.A.map((code) => nearestDegreeIndex(keymapNote(spec, code, 4, P[170]), P[170]));
  assert.deepEqual(degrees.map((d) => d.period * 17 + d.index),
    [0, 3, 6, 7, 10, 13, 16, 17, 20, 23].map((k) => 3 + k));
  assert.equal(keymapStats(spec, P[170], 4).reachable, 7);
  // …and the diatonic in semitones is the 12-TET scale, played as such in 12-TET.
  const c = makeScaleKeymap({ kind: "hepta", hepta: "aeolian", tonic: 9, rows: ["A"] }, ANY);
  assert.deepEqual(rowValues(c, "A"), [9, 11, 12, 14, 16, 17, 19, 21, 23, 24]);
});

test("a made layout round-trips through a .taudkey", () => {
  const spec = makeScaleKeymap({
    kind: "mos", mos: { a: 4, b: 5, L: 2, s: 1, mode: 0 }, tonic: 0, rows: ["Q", "A", "Z"], name: "Lambda",
  }, tuning(35130));
  assert.deepEqual(parseTaudkey(buildTaudkey(spec)), spec);
  const any = makeScaleKeymap({
    kind: "mos", mos: { a: 5, b: 2, L: 5, s: 2, mode: 3 }, tonic: 0, rows: ["A"], name: "y",
  }, ANY);
  assert.deepEqual(parseTaudkey(buildTaudkey(any)), any);
});
