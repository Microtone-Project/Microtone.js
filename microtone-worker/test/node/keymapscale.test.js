// The Keymap Maker's scales and layouts (src/ui/keymapscale.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makerFrame, kindAvailable, scaleOf, scaleOffsets, makeScaleKeymap,
  mosPatterns, mosModes, mosSizes, defaultMosSize, rowStepOf, HEPTA_MODES,
  scaleChroma, pianoAvailable, arrangementOf,
  naturalEquave, equaveChoices, equaveSteps,
} from "../../src/ui/keymapscale.js";
import {
  ROW_CODES, builtinKeymap, resolveKeymap, keymapNote, keymapStats, parseTaudkey, buildTaudkey,
} from "../../src/ui/keymap.js";
import { pitchTablePresets, nearestDegreeIndex } from "../../core/tuning/pitchtables.js";

const P = pitchTablePresets;
const tuning = (idx) => makerFrame("tuning", P[idx]);
const ANY = makerFrame("any");
const rowValues = (spec, row) => ROW_CODES[row].map((c) => spec.overrides[c]);

test("the frames: degrees of the song's tuning, or semitones for any", () => {
  assert.deepEqual(tuning(310), { mode: "tuning", unit: "deg", n: 31, cents: 1200, octave: true, usable: true });
  assert.equal(tuning(35130).octave, false, "Bohlen–Pierce repeats at the tritave");
  // ProTracker's absolute table steps a semitone per entry: counted as 12-EDO.
  assert.deepEqual(tuning(1), { mode: "tuning", unit: "semi", n: 12, cents: 1200, octave: true, usable: true });
  assert.equal(tuning(0).usable, false, "a Raw song has no degrees to count");
  assert.deepEqual(ANY, { mode: "any", unit: "semi", n: 12, cents: 1200, octave: true, usable: true });
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
    { steps: [2, 2, 1, 2, 2, 2, 1], period: 12, unitPerStep: 1, word: null, equave: "octave" });
});

test("MOS patterns: four to twelve notes, multi-period ones included", () => {
  const ps = mosPatterns();
  const find = (a, b) => ps.find((p) => p.a === a && p.b === b);
  assert.equal(find(5, 2).periods, 1);
  assert.ok(ps.every((p) => p.size >= 4 && p.size <= 12 && p.a + p.b === p.size));
  // Still scales of the octave, repeating within it (Xenharmonic Wiki: citric,
  // ekic, triwood — equave 2/1, period 600 ¢, 600 ¢, 400 ¢).
  assert.equal(find(4, 2).periods, 2);
  assert.equal(find(6, 2).periods, 2);
  assert.equal(find(3, 3).periods, 3);
  assert.equal(ps.length, [4, 5, 6, 7, 8, 9, 10, 11, 12].reduce((n, k) => n + k - 1, 0));
});

test("multi-period MOS: one period's modes, each repeated", () => {
  // The wiki's table for 6L 2s: Paralysis … Incubus, brightest first.
  assert.deepEqual(mosModes(6, 2), ["LLLsLLLs", "LLsLLLsL", "LsLLLsLL", "sLLLsLLL"]);
  assert.deepEqual(mosModes(4, 2), ["LLsLLs", "LsLLsL", "sLLsLL"]);
  assert.deepEqual(mosModes(3, 3), ["LsLsLs", "sLsLsL"]);
  // 12-TET's augmented scale is 3L 3s at 3:1, its octatonic 4L 4s at 2:1.
  assert.deepEqual(mosSizes(3, 3, tuning(120)), [[3, 1]]);
  assert.deepEqual(mosSizes(4, 4, tuning(120)), [[2, 1]]);
  assert.deepEqual(scaleOffsets(scaleOf({ kind: "mos", mos: { a: 3, b: 3, L: 3, s: 1, mode: 1 } }, tuning(120))),
    [0, 1, 4, 5, 8, 9]);
  assert.deepEqual(scaleOffsets(scaleOf({ kind: "mos", mos: { a: 4, b: 4, L: 2, s: 1, mode: 0 } }, ANY)),
    [0, 2, 3, 5, 6, 8, 9, 11]);
  // In any tuning, 4L 2s at 2:1 is 10-TET (the wiki's basic tuning, 2\10).
  assert.equal(scaleOf({ kind: "mos", mos: { a: 4, b: 2, L: 2, s: 1, mode: 0 } }, ANY).period, 10);
  assert.equal(mosSizes(6, 2, tuning(120)).length, 0, "12-TET has no 6L 2s");
});

test("MOS modes, brightest first: 5L 2s runs Lydian … Locrian", () => {
  assert.deepEqual(mosModes(5, 2),
    ["LLLsLLs", "LLsLLLs", "LLsLLsL", "LsLLLsL", "LsLLsLL", "sLLLsLL", "sLLsLLL"]);
  assert.deepEqual(mosModes(2, 3), ["LsLss", "LssLs", "sLsLs", "sLssL", "ssLsL"]);
  for (const p of mosPatterns()) {
    const modes = mosModes(p.a, p.b);
    assert.equal(modes.length, p.size / p.periods, `${p.a}L ${p.b}s has one mode per note of a period`);
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

test("scale only: a run up the scale per row, a period between rows, the A row on the tonic", () => {
  const spec = makeScaleKeymap({
    kind: "hepta", hepta: "ionian", tonic: 0, rows: ["N", "Q", "A", "Z"], name: "C major", arrangement: "inkey",
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
  const d = makeScaleKeymap({ kind: "hepta", hepta: "dorian", tonic: 5, rows: ["A"], arrangement: "inkey" }, f);
  assert.deepEqual(rowValues(d, "A"), [5, 10, 13, 18, 23, 28, 31, 36, 41, 44]);
  assert.deepEqual(d.rows, ["A"]);
  assert.equal(d.origin.value, 5);
  // Continuing rows: the Q row picks up where A ends, nothing doubled.
  const run = makeScaleKeymap({ kind: "penta", penta: "major", tonic: 0, rows: ["Q", "A"], rowStep: 10, arrangement: "inkey" }, tuning(120));
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

test("piano: the major scale in semitones IS Double-Deck Piano 12", () => {
  const spec = makeScaleKeymap({ kind: "hepta", hepta: "ionian", tonic: 0, rows: ["N", "Q", "A", "Z"] }, ANY);
  const dd = builtinKeymap("Double-Deck Piano 12");
  for (const row of ["N", "Q", "A", "Z"]) assert.deepEqual(rowValues(spec, row), rowValues(dd, row), row);
  assert.deepEqual(spec.origin, { code: "KeyZ", value: 0 }, "the lowest white row starts on the tonic");
  assert.equal(arrangementOf({}, scaleOf({ kind: "hepta", hepta: "ionian" }, ANY)), "piano", "and it is the default");
});

test("piano: a black key in every large step, a chroma from its neighbours", () => {
  // 31-TET meantone, 5L 2s at 5:3 in Ionian (mode 2): the chroma is 2, the
  // diatonic semitone 3 — C♯ is degree 2 and D♭ degree 3.
  const f = tuning(310);
  const mos = { a: 5, b: 2, L: 5, s: 3, mode: 1 };
  assert.deepEqual(scaleChroma(scaleOf({ kind: "mos", mos }, f)), { L: 5, s: 3, c: 2 });
  const sharp = makeScaleKeymap({ kind: "mos", mos, tonic: 0, rows: ["Z", "A"] }, f);
  const flat = makeScaleKeymap({ kind: "mos", mos, tonic: 0, rows: ["Z", "A"], blackKeys: "flat" }, f);
  assert.deepEqual(rowValues(sharp, "Z"), [0, 5, 10, 13, 18, 23, 28, 31, 36, 41]);
  assert.deepEqual(rowValues(sharp, "A"), [null, 2, 7, null, 15, 20, 25, null, 33, 38]);
  assert.deepEqual(rowValues(flat, "A"), [null, 3, 8, null, 16, 21, 26, null, 34, 39]);
  // A MOS that is not diatonic: 3L 4s at 3:2 in 17-TET (3·3 + 4·2), brightest
  // mode. Black keys sit only in the large steps, a chroma (1) above.
  const t = makeScaleKeymap({ kind: "mos", mos: { a: 3, b: 4, L: 3, s: 2, mode: 0 }, tonic: 0, rows: ["A", "Q"] }, tuning(170));
  const word = mosModes(3, 4)[0];
  const white = rowValues(t, "A"), black = rowValues(t, "Q");
  for (let col = 1; col < 10; col++) {
    const large = word[(col - 1) % 7] === "L";
    assert.equal(black[col], large ? white[col - 1] + 1 : null, `Q col ${col} (${word[(col - 1) % 7]})`);
  }
  assert.equal(black[0], word[6] === "L" ? -2 : null, "the first black key is the step below the tonic");
});

test("piano: rows pair into decks from the lowest one in use; a deck is a period up", () => {
  const f = tuning(120);
  // A, Q and the numbers: A white, Q black, the number row white an octave up.
  const three = makeScaleKeymap({ kind: "hepta", hepta: "ionian", tonic: 0, rows: ["N", "Q", "A"] }, f);
  assert.deepEqual(rowValues(three, "A"), [0, 2, 4, 5, 7, 9, 11, 12, 14, 16]);
  assert.deepEqual(rowValues(three, "Q"), [null, 1, 3, null, 6, 8, 10, null, 13, 15]);
  assert.deepEqual(rowValues(three, "N"), [12, 14, 16, 17, 19, 21, 23, 24, 26, 28]);
  // An unused row still counts: Z and Q are both white.
  const gap = makeScaleKeymap({ kind: "hepta", hepta: "ionian", tonic: 0, rows: ["Q", "Z"] }, f);
  assert.deepEqual(rowValues(gap, "Q"), rowValues(gap, "Z").map((v) => v + 12));
  // Continuing decks: the upper white row picks up where the lower one ends,
  // and so does its black row — nothing doubled on the board.
  const run = makeScaleKeymap({ kind: "hepta", hepta: "ionian", tonic: 0, rows: ["N", "Q", "A", "Z"], rowStep: 10 }, f);
  assert.deepEqual(rowValues(run, "Q"), [17, 19, 21, 23, 24, 26, 28, 29, 31, 33]);
  assert.deepEqual(rowValues(run, "N"), [null, 18, 20, 22, null, 25, 27, null, 30, 32]);
  assert.equal(keymapStats(run, P[120], 3).duplicates, 0);
  // The piano reaches the whole chromatic scale of 12-TET; scale-only, seven notes.
  assert.equal(keymapStats(three, P[120], 4).reachable, 12);
});

test("piano needs two step sizes: 5-TET's equal pentatonic is laid out scale-only", () => {
  const scale = scaleOf({ kind: "penta", penta: "major" }, tuning(50));
  assert.deepEqual(scale.steps, [1, 1, 1, 1, 1]);
  assert.equal(scaleChroma(scale), null);
  assert.equal(pianoAvailable(scale), false);
  assert.equal(arrangementOf({ arrangement: "piano" }, scale), "inkey");
  const spec = makeScaleKeymap({ kind: "penta", penta: "major", tonic: 0, rows: ["Q", "A"] }, tuning(50));
  assert.ok(Object.values(spec.overrides).every((v) => v !== null), "no empty black keys");
});

test("equaves: the tuning's own by default, the others its nearest degrees", () => {
  assert.equal(naturalEquave(tuning(120)), "octave");
  assert.equal(naturalEquave(tuning(35130)), "tritave", "Bohlen–Pierce repeats at the tritave");
  assert.equal(naturalEquave(ANY), "octave");
  assert.deepEqual(equaveChoices(tuning(120)), ["octave", "tritave", "fifth"]);
  // A period that is none of the three is offered as itself.
  const odd = makerFrame("tuning", { ...P[120], interval: 0x1000 * 5 / 4, name: "x" });
  assert.equal(naturalEquave(odd), "period");
  assert.deepEqual(equaveChoices(odd), ["octave", "tritave", "fifth", "period"]);
  // 12-TET's tritave is 19 degrees, 1.96 ¢ flat; its fifth 7 degrees.
  const t12 = equaveSteps("tritave", tuning(120));
  assert.equal(t12.n, 19);
  assert.ok(Math.abs(t12.error + 1.955) < 0.001);
  assert.equal(equaveSteps("fifth", tuning(120)).n, 7);
  assert.equal(equaveSteps("tritave", tuning(35130)).n, 13);
  assert.ok(Math.abs(equaveSteps("tritave", tuning(35130)).error) < 0.01);
  assert.equal(equaveSteps("octave", tuning(35130)).n, 8, "BP's nearest octave");
  assert.equal(equaveSteps("octave", ANY), null, "any tuning: the ratio makes the steps");
  // The sizes fill the equave's degrees.
  for (const [L, sm] of mosSizes(4, 3, tuning(120), "tritave")) assert.equal(4 * L + 3 * sm, 19);
  assert.deepEqual(mosSizes(4, 5, tuning(35130)), [[2, 1]], "Lambda, in BP's own tritave");
  assert.deepEqual(mosSizes(4, 5, tuning(35130), "tritave"), [[2, 1]]);
  // 53-TET's tritave is 84 degrees, which 6L 3s fills four ways.
  assert.deepEqual(mosSizes(6, 3, tuning(530), "tritave"), [[13, 2], [12, 4], [11, 6], [10, 8]]);
});

test("6L 3s⟨3/1⟩, the Xenharmonic Wiki's example: three modes, 15-EDT at 2:1", () => {
  assert.deepEqual(mosModes(6, 3), ["LLsLLsLLs", "LsLLsLLsL", "sLLsLLsLL"]);
  const mos = { a: 6, b: 3, L: 2, s: 1, mode: 0, equave: "tritave" };
  const scale = scaleOf({ kind: "mos", mos }, ANY);
  assert.equal(scale.period, 15);
  assert.equal(scale.equave, "tritave");
  // Its 1-step generator is 2\15 of a tritave, 253.6 ¢ (the wiki's table).
  assert.ok(Math.abs(scale.unitPerStep * 2 * 100 - 253.6) < 0.05);
  const spec = makeScaleKeymap({ kind: "mos", mos, tonic: 0, rows: ["A"], arrangement: "inkey" }, ANY);
  const row = rowValues(spec, "A");
  // Nine notes reach the tritave: key 10 is 3/1 above the tonic.
  assert.ok(Math.abs(row[9] * 100 - 1901.955) < 0.001);
  // The default rows are a tritave apart.
  const two = makeScaleKeymap({ kind: "mos", mos, tonic: 0, rows: ["Q", "A"], arrangement: "inkey" }, ANY);
  assert.deepEqual(rowValues(two, "Q").slice(0, 1), [row[9]]);
  // In a tuning, the steps are degrees and the rows its patent tritave apart.
  const t53 = makeScaleKeymap({ kind: "mos", mos: { ...mos, L: 12, s: 4 }, tonic: 0, rows: ["A"], arrangement: "inkey" }, tuning(530));
  assert.deepEqual(rowValues(t53, "A"), [0, 12, 24, 28, 40, 52, 56, 68, 80, 84]);
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
