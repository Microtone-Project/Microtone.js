// Harmonic (scalar) transposition — the scale vocabulary (core/tuning/scales.js),
// the dissonance metrics (consonance.js), the inference/mapping/clash core
// (harmonise.js) and the song walker (src/doc/harmonise.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import { pitchTablePresets, ANCHOR_NOTE, resolveNoteSymbol } from "../../core/tuning/pitchtables.js";
import { degreeSpace, scaleVocabulary, clusterPitchClasses } from "../../core/tuning/scales.js";
import { harmonicEntropy, setharesDissonance, dissonanceMetric } from "../../core/tuning/consonance.js";
import { harmoniseTranspose } from "../../core/tuning/harmonise.js";
import { harmoniseSongNotes, collectHarmoniseInput, beatWeight } from "../../src/doc/harmonise.js";
import { bulkNotesOp } from "../../src/doc/ops.js";
import { CUE_EMPTY } from "../../core/format/taud-const.js";

const P = (i) => pitchTablePresets[i];
const p12 = P(120);

/** Note word of absolute degree `d` of `preset` (0 = C4). */
function deg(preset, d) {
  const n = preset.table.length;
  const q = Math.floor(d / n);
  return ANCHOR_NOTE + q * preset.interval + preset.table[d - q * n];
}
const c12 = (semi) => deg(p12, semi);

/** Spell a note in its notation, e.g. "F#4". */
function spell(note, preset = p12) {
  const s = resolveNoteSymbol(note, preset);
  if (s.cjk) return s.cjk + s.octave;
  return s.tick.trim() + s.letter + (s.acc === "-" ? "" : s.acc) + s.octave;
}

/** A monophonic line: one note every `dur` rows from t0. */
function line(preset, degrees, { dur = 4, lane = 0, t0 = 0, id = "n" } = {}) {
  return degrees.map((d, i) => ({
    id: `${id}${i}`, pitch: deg(preset, d), lane,
    occ: [{ t: t0 + i * dur, dur, beat: i % 4 === 0 ? 1.5 : 1 }],
  }));
}
/** Block chords: [[degrees], …] each held `dur` rows. */
function chords(preset, list, dur = 8) {
  const out = [];
  list.forEach((ch, i) => ch.forEach((d) => out.push({ pitch: deg(preset, d), t: i * dur, dur, beat: 1.5 })));
  return out;
}
function run(preset, moving, fixed, opts) {
  const { pitches, report } = harmoniseTranspose(preset, { moving, fixed }, opts);
  return { out: moving.map((m) => spell(pitches.get(m.id), preset)), pitches, report };
}

// ── vocabulary ──────────────────────────────────────────────────────────────

test("vocabulary: the 12-TET diatonic family, every transposition, no near-chromatic chains", () => {
  const v = scaleVocabulary(degreeSpace(p12));
  const fam = (f) => v.filter((s) => s.family === f);
  assert.equal(fam("diatonic").length, 12);
  assert.equal(fam("harmonicMinor").length, 12);
  assert.deepEqual(fam("diatonic").find((s) => s.root === 0).asc, [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(fam("harmonicMinor").find((s) => s.root === 9).asc, [0, 2, 4, 5, 8, 9, 11]);
  assert.equal(fam("chromatic").length, 1);
  assert.ok(!v.some((s) => /^mos(9|10|11)$/.test(s.family)), "no 9..11-note chains of fifths in 12-TET");
  assert.ok(!v.some((s) => ["rast", "bayati", "slendro"].includes(s.family)), "12-TET cannot play neutral steps");
});

test("vocabulary: melodic minor keeps asc/desc aligned by position across the period seam", () => {
  const v = scaleVocabulary(degreeSpace(p12));
  for (const s of v.filter((x) => x.family === "melodicMinor")) {
    assert.equal(s.asc.length, s.desc.length);
    s.asc.forEach((a, i) => assert.ok(a - s.desc[i] === 0 || a - s.desc[i] === 1, `root ${s.root} pos ${i}`));
    assert.equal(s.union.length, 9, "natural and raised 6th and 7th");
  }
});

test("vocabulary: maqamat and gamelan appear only where the tuning can play them", () => {
  const has = (preset, f) => scaleVocabulary(degreeSpace(preset)).some((s) => s.family === f);
  for (const idx of [170, 240, 310]) assert.ok(has(P(idx), "rast"), `${P(idx).name} has Rast`);
  assert.ok(!has(P(190), "rast"), "19-TET's nearest thirds are too far from neutral");
  assert.ok(has(P(50), "slendro"), "5-TET IS slendro");
  assert.ok(has(P(220), "pelog"));
  // Bohlen–Pierce: no chain of fifths, but the nine-note Lambda MOS is there.
  const bp = scaleVocabulary(degreeSpace(P(35130)));
  assert.ok(!bp.some((s) => s.family === "diatonic"));
  assert.ok(bp.some((s) => s.family === "mos9" && s.asc.join() === "0,2,3,5,6,8,9,11,12"), "Lambda");
});

test("raw degree space: pitch classes clustered with a tolerance, across the period seam", () => {
  const notes = [0x5000, 0x5003, 0x5ffe, 0x5400, 0x5402, 0x6401];
  assert.deepEqual(clusterPitchClasses(notes), [0x0, 0x401]);
  const sp = degreeSpace(P(0), notes);
  assert.equal(sp.kind, "raw");
  assert.equal(sp.n, 2);
});

// ── consonance ──────────────────────────────────────────────────────────────

test("harmonic entropy orders intervals the way the ear does, in any tuning", () => {
  const he = harmonicEntropy;
  assert.ok(he(0) < he(700) && he(700) < he(500) && he(500) < he(386));
  assert.ok(he(386) < he(600) && he(600) < he(1100) && he(1100) < he(100));
  assert.ok(he(1200) < 0.05, "octave");
  // 31-TET's 10-step third is nearer 5/4 than 12-TET's 400 cents
  assert.ok(he(10 * 1200 / 31) < he(400));
  const m = dissonanceMetric();
  assert.equal(m(0x5000, 0x5000 + 0x955), m(0x5000 + 0x955, 0x5000), "symmetric");
  assert.ok(setharesDissonance(0x4000, 0x4000 + 0x155) > setharesDissonance(0x4000, 0x4000 + 0x955));
  const custom = () => 0.5;
  assert.equal(dissonanceMetric(custom), custom);
});

// ── the core ────────────────────────────────────────────────────────────────

test("C major up a major third: diatonic thirds, k = 2", () => {
  const { out, report } = run(p12, line(p12, [0, 2, 4, 5, 7, 9, 11, 12]), [], { fine: 4 });
  assert.deepEqual(out, ["E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5"]);
  assert.equal(report.k, 2);
  assert.equal(report.baseScale.family, "diatonic");
  assert.equal(report.fallback, null);
});

test("the base note always lands exactly on the requested interval, up or down", () => {
  for (const fine of [4, 7, -3, -5, 9]) {
    const m = line(p12, [2, 5, 9, 7, 5, 4, 2]);
    const { pitches } = harmoniseTranspose(p12, { moving: m, fixed: [] }, { fine });
    assert.equal(pitches.get(m[0].id), c12(2 + fine), `fine ${fine}`);
  }
});

test("coarse periods ride on top; an octave-only request needs no inference", () => {
  const m = line(p12, [0, 2, 4]);
  const { out } = run(p12, m, [], { fine: 4, coarse: 1 });
  assert.deepEqual(out, ["E5", "F5", "G5"]);
  const r = run(p12, m, [], { fine: 0, coarse: -1 });
  assert.deepEqual(r.out, ["C3", "D3", "E3"]);
});

test("underdetermined scale: the accompaniment decides between F and F#", () => {
  const mel = line(p12, [0, 2, 4, 7, 9, 7, 4, 2]); // C D E G A — fits C, G and F major
  const withF = chords(p12, [[-12, -7, -3], [-7, -3, 0]], 16);   // C/F-ish: F present
  const withFs = chords(p12, [[-5, -1, 2, 6], [-5, -1, 2, 6]], 16); // G7 colour: F# present
  assert.equal(run(p12, mel, withF, { fine: 4, avoidClashes: false }).out[1], "F4");
  assert.equal(run(p12, mel, withFs, { fine: 4, avoidClashes: false }).out[1], "F#4");
});

test("harmony overrides the key: over E7 in A minor the scale is harmonic minor", () => {
  const mel = line(p12, [9, 11, 12, 11, 9, 8, 9, 11]);
  const acc = chords(p12, [[-3, 0, 4], [-8, -4, -1, 2]], 16);
  const { out, report } = run(p12, mel, acc, { fine: 3, avoidClashes: false });
  assert.equal(report.baseScale.family, "harmonicMinor");
  assert.deepEqual(out, ["C5", "D5", "E5", "D5", "C5", "B4", "C5", "D5"]);
});

test("a request the passage's key cannot express is carried out chromatically", () => {
  const mel = line(p12, [0, 2, 4, 5, 7, 9, 11, 12]);
  const { out, report } = run(p12, mel, [], { fine: 1 });
  assert.deepEqual(out, ["C#4", "D#4", "F4", "F#4", "G#4", "A#4", "C5", "C#5"]);
  assert.equal(report.fallback, "outOfKey");
});

test("modulation is followed: C major while F sounds, then G major", () => {
  const mel = line(p12, [0, 4, 7, 5, 4, 2, 0, 2, 7, 11, 9, 6, 7, 9, 11, 7]);
  const acc = chords(p12, [[-12, -8, -5], [-7, -3, 0], [-5, -1, 2], [-12, -8, -5],
    [-5, -1, 2], [-12, -8, -3], [-10, -6, -3], [-5, -1, 2]]);
  const { out, report } = run(p12, mel, acc, { fine: 4, avoidClashes: false });
  assert.deepEqual(report.segments.map((s) => `${s.family}@${s.root}`), ["diatonic@0", "diatonic@7"]);
  assert.equal(out[3], "A4", "F → A in C major");
  assert.equal(out[11], "A4", "F# → A in G major");
  // the switch falls between the last F (row 16) and the first F# (row 44);
  // the bars between fit both keys, so exactly where is not the music's to say
  const sw = report.segments[1].t0;
  assert.ok(sw >= 16 && sw <= 44, `switch at ${sw}`);
});

test("chromatic notes: each policy", () => {
  const mel = line(p12, [0, 1, 2, 3, 4, 5, 7, 9, 11, 12]); // C C# D D# E …
  const at = (policy) => run(p12, mel, [], { fine: 4, policy }).out;
  assert.deepEqual(at("offset").slice(0, 4), ["E4", "F4", "F4", "F#4"]);
  assert.deepEqual(at("snap").slice(0, 4), ["E4", "E4", "F4", "F4"]);
  assert.deepEqual(at("chromatic").slice(0, 4), ["E4", "F4", "F4", "G4"]);
  assert.deepEqual(at("neighbour").slice(0, 4), ["E4", "F4", "F4", "F#4"]);
  assert.equal(run(p12, mel, [], { fine: 4 }).report.outside, 2);
});

test("directional scales: melodic minor rises with F#/G#, falls with G/F", () => {
  const mel = line(p12, [9, 11, 12, 14, 16, 18, 20, 21, 19, 17, 16, 14, 12, 11, 9]);
  const { out, report } = run(p12, mel, [], { fine: 3 });
  assert.equal(report.baseScale.family, "melodicMinor");
  assert.equal(out[4], "G#5", "E rising → G#");
  assert.equal(out[10], "G5", "E falling → G");
  assert.equal(out[9], "A5", "F falling → A");
});

test("clash avoidance: a scale step grinding on a strong beat moves to a chord tone", () => {
  const mel = line(p12, [9, 11, 12, 11, 9, 8, 9, 11]);
  const acc = chords(p12, [[-3, 0, 4], [-8, -4, -1, 2]], 16);
  const plain = run(p12, mel, acc, { fine: 3, avoidClashes: false });
  const smooth = run(p12, mel, acc, { fine: 3 });
  assert.equal(plain.out[4], "C5");
  assert.equal(smooth.out[4], "B4", "C over E7 grinds against B and D; B is a chord tone");
  assert.equal(smooth.out[0], "C5", "the base note is never moved off the request");
  assert.ok(smooth.report.adjusted >= 1);
  // nothing to clash with → identical to the plain scalar result
  assert.deepEqual(run(p12, mel, [], { fine: 3 }).out, run(p12, mel, [], { fine: 3, avoidClashes: false }).out);
});

test("31-TET: meantone diatonic thirds, counted in 31-TET steps", () => {
  const p31 = P(310);
  const { out, report } = run(p31, line(p31, [0, 5, 10, 13, 18, 23, 28, 31]), [], { fine: 10 });
  assert.deepEqual(out, ["E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5"]);
  assert.equal(report.k, 2);
});

test("24-TET maqam Rast: neutral thirds stay neutral", () => {
  const p24 = P(240);
  // C D E‡ F G A B‡ C, up 7 quarter-steps (C → E‡)
  const { pitches, report } = harmoniseTranspose(p24,
    { moving: line(p24, [0, 4, 7, 10, 14, 18, 21, 24]), fixed: [] }, { fine: 7 });
  const steps = [...pitches.values()].map((n) => Math.round((n - ANCHOR_NOTE) / (0x1000 / 24)));
  assert.deepEqual(steps, [7, 10, 14, 18, 21, 24, 28, 31]);
  assert.ok(["rast", "sikah"].includes(report.baseScale.family), "a Rast pitch set");
});

test("Bohlen–Pierce: Lambda thirds over a tritave period", () => {
  const bp = P(35130);
  const { pitches, report } = harmoniseTranspose(bp,
    { moving: line(bp, [0, 2, 3, 5, 6, 8, 9, 11, 12, 13]), fixed: [] }, { fine: 3 });
  assert.equal(report.baseScale.size, 9);
  const space = degreeSpace(bp);
  const degs = [...pitches.values()].map((n) => space.locate(n).deg);
  // two Lambda positions up: …, 11 → 13 (the tritave), 12 → 13+2, 13 → 13+3
  assert.deepEqual(degs, [3, 5, 6, 8, 9, 11, 12, 13, 13 + 2, 13 + 3]);
});

test("Raw: a just-intoned scale is clustered and harmonised along itself", () => {
  const ji = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2].map((r) => ANCHOR_NOTE + Math.round(4096 * Math.log2(r)));
  const moving = ji.map((p, i) => ({ id: i, pitch: p, lane: 0, occ: [{ t: i * 4, dur: 4, beat: 1 }] }));
  const { pitches, report } = harmoniseTranspose(P(0), { moving, fixed: [] }, { fine: ji[2] - ji[0] });
  assert.equal(report.fallback, null);
  assert.equal(pitches.get(0), ji[2]);
  assert.equal(pitches.get(1), ji[3], "9/8 → 4/3, the scale's own third");
  assert.equal(pitches.get(6), ji[1] + 0x1000, "15/8 → 9/4");
  // a target pitch the song never plays: nothing to move along
  const off = harmoniseTranspose(P(0), { moving, fixed: [] }, { fine: 0x200 });
  assert.equal(off.report.fallback, "notInSet");
  assert.equal(off.pitches.get(0), ji[0] + 0x200);
});

test("ProTracker (absolute table): computed as 12-TET, snapped back onto the table", () => {
  const pt = P(1);
  const m = line(p12, [0, 2, 4, 5]);
  const { pitches } = harmoniseTranspose(pt, { moving: m, fixed: [] }, { fine: 4 });
  for (const v of pitches.values()) {
    assert.ok(pt.table.some((o) => pt.base + o === v), `${v.toString(16)} is a ProTracker note`);
  }
});

test("off-grid detune is carried through the move", () => {
  const m = line(p12, [0, 2, 4]);
  m[1].pitch += 5; // a slightly sharp D
  const { pitches } = harmoniseTranspose(p12, { moving: m, fixed: [] }, { fine: 4 });
  assert.equal(pitches.get(m[1].id), c12(5) + 5);
});

// ── the song walker ─────────────────────────────────────────────────────────

/** A minimal song: patterns of {note, instrment} cells and plain cue words. */
function mkSong(patterns, cueLanes) {
  const cues = cueLanes.map((lanes) => {
    const w = new Uint16Array(64).fill(CUE_EMPTY);
    lanes.forEach((p, ch) => { if (p !== null) w[ch] = p; });
    return w;
  });
  const pats = patterns.map((rows) => {
    const cells = Array.from({ length: 64 }, () => ({ note: 0, instrment: 0, effect: 0, effect2: 0 }));
    for (const [row, note, inst = 0, effect = 0] of rows) cells[row] = { note, instrment: inst, effect, effect2: 0 };
    return cells;
  });
  return { patterns: pats, cues };
}

test("song walker: occurrences, durations, beats and the accompaniment", () => {
  const song = mkSong([
    [[0, c12(0)], [8, c12(4)], [16, 0x0001], [32, c12(7)]],  // melody
    [[0, c12(-24), 3], [4, c12(-12)]],                        // bass (inst 3 at row 0)
  ], [[0, 1], [0, null]]);
  const { moving, fixed } = collectHarmoniseInput(song, null, (pat) => pat === 0);
  const first = moving.find((m) => m.id === "0:0");
  assert.equal(first.occ.length, 2, "pattern 0 sounds in both cues");
  assert.deepEqual(first.occ.map((o) => o.t), [0, 64]);
  assert.equal(first.occ[0].dur, 8, "until the next note");
  assert.equal(moving.find((m) => m.id === "0:8").occ[0].dur, 8, "until the key-off");
  assert.equal(first.occ[0].beat, beatWeight(0));
  assert.equal(fixed.length, 2);
});

test("song walker: percussion and sentinels never move; one undo step restores all", () => {
  const perc = new Uint8Array(1024);
  perc[9] = 1;
  const song = mkSong([
    [[0, c12(0), 1], [4, c12(2)], [8, c12(4)], [12, 0x0011]],
    [[0, c12(0), 9], [4, c12(2)]], // a drum lane by running instrument
  ], [[0, 1]]);
  const before = song.patterns.map((p) => p.map((c) => c.note));
  const op = bulkNotesOp(0, (s) => harmoniseSongNotes(s, p12, perc, () => true, { fine: 4 }).changes);
  const doc = { songs: [song], dirty: false };
  const inverse = op.apply(doc);
  assert.deepEqual(song.patterns[0].slice(0, 13).map((c) => c.note).filter((n) => n >= 0x20).map((n) => spell(n)),
    ["E4", "F4", "G4"]);
  assert.equal(song.patterns[0][12].note, 0x0011, "interrupt untouched");
  assert.deepEqual(song.patterns[1].map((c) => c.note), before[1], "percussion untouched");
  inverse.apply(doc);
  assert.deepEqual(song.patterns.map((p) => p.map((c) => c.note)), before);
});

test("song walker: a block selection harmonises against the lanes it leaves alone", () => {
  // lane 0: melody to harmonise in place; lane 1: E7 then Am under it
  const song = mkSong([
    [[0, c12(9)], [8, c12(11)], [16, c12(12)], [24, c12(11)], [32, c12(9)], [40, c12(8)], [48, c12(9)], [56, c12(11)]],
    [[0, c12(-3)], [32, c12(-8)]],
    [[0, c12(0)], [32, c12(-4)]],
    [[0, c12(4)], [32, c12(-1)]],
    [[32, c12(2)]],
  ], [[0, 1, 2, 3, 4]]);
  const { changes, report } = harmoniseSongNotes(song, p12, null, (pat) => pat === 0, { fine: 3 });
  assert.equal(report.baseScale.family, "harmonicMinor");
  assert.equal(changes.length, 8);
  assert.equal(spell(song.patterns[0][0].note), "C5");
  assert.equal(spell(song.patterns[0][40].note), "B4", "G# → B over E7");
  assert.deepEqual(song.patterns[1][0].note, c12(-3), "accompaniment untouched");
});

test("song walker: a pattern no cue places still transposes", () => {
  const song = mkSong([
    [[0, c12(0)]],
    [[0, c12(0)], [4, c12(2)], [8, c12(4)]],
  ], [[0]]);
  const { changes } = harmoniseSongNotes(song, p12, null, (pat) => pat === 1, { fine: 4 });
  assert.equal(changes.length, 3);
  assert.deepEqual([0, 4, 8].map((r) => spell(song.patterns[1][r].note)), ["E4", "F4", "G4"]);
});

// ── real-song robustness (a song in G major, then A♭ major, with bends, a
//    pitched hi-hat and a chromatic riser — the shapes that made the first
//    version flicker between keys) ──────────────────────────────────────────

const G_PORTA = 0x10;
const keysOf = (report) => report.keys.map((k) => `${k.family}@${k.root}`);

/** Block chords over `bars` bars of 16 rows, from a list of chords that repeats. */
function progression(chordList, bars, t0 = 0, src = 1) {
  const out = [];
  for (let b = 0; b < bars; b++) {
    const ch = chordList[b % chordList.length];
    for (const d of ch) out.push({ pitch: c12(d), t: t0 + b * 16, dur: 16, beat: 1.5, src });
  }
  return out;
}

test("a key that holds for a shorter time is not swallowed by the longer one", () => {
  // 8 bars of G major, then 16 of A♭ major — the A♭ half outweighs the G half
  const g = progression([[-17, -13, -10], [-12, -8, -5], [-10, -6, -3], [-15, -12, -8]], 8);
  const ab = progression([[-16, -12, -9], [-11, -7, -4], [-9, -5, -2], [-14, -11, -7]], 16, 128);
  // the melody runs through both sections
  const mel = line(p12, [7, 9, 11, 7, 12, 11, 9, 7, 8, 10, 12, 8, 13, 12, 10, 8, 15, 13, 12, 10, 8, 7, 8, 8], { dur: 16 });
  const { report } = run(p12, mel, [...g, ...ab], { fine: 4, avoidClashes: false });
  assert.deepEqual(keysOf(report), ["diatonic@7", "diatonic@8"]);
  assert.equal(report.baseScale.family, "diatonic");
  assert.equal(report.baseScale.root, 7, "the base note's key is G major, not a scale nearer A♭");
  assert.equal(report.keys[1].t0, 128, "the modulation is found where it happens");
});

test("a part stuck on one pitch class says nothing about the key", () => {
  // G major, with a 'hi-hat' sample on C# every two rows (not flagged percussion)
  const acc = progression([[-17, -13, -10], [-12, -8, -5], [-10, -6, -3]], 6);
  const hat = Array.from({ length: 48 }, (_, i) => ({ pitch: c12(13), t: i * 2, dur: 2, beat: 1, src: 17 }));
  const mel = line(p12, [7, 11, 14, 12, 11, 9, 7, 9], { dur: 12 });
  const { report } = run(p12, mel, [...acc, ...hat], { fine: 4, avoidClashes: false });
  assert.deepEqual(report.fixedPitchParts, [17]);
  assert.deepEqual(keysOf(report), ["diatonic@7"], "not D major, not E melodic minor");
});

test("one passing note is a chromatic note, not a change of scale", () => {
  const acc = progression([[-12, -8, -5], [-7, -3, 0], [-5, -1, 2]], 6);
  const mel = line(p12, [0, 2, 4, 5, 6, 7, 9, 11, 12, 11, 9, 7], { dur: 8 }); // one F# passing
  const { report, out } = run(p12, mel, acc, { fine: 4, avoidClashes: false });
  assert.deepEqual(keysOf(report), ["diatonic@0"]);
  assert.equal(report.detours, 0);
  assert.equal(out[4], "A#4", "F# keeps its offset from F: F → A, so F# → A#");
});

test("a whole bar of a secondary dominant is followed, and reported as a detour", () => {
  // C major — C, F, then a bar of E7 (G#) leading to Am, and home
  const acc = progression([[-12, -8, -5], [-7, -3, 0], [-8, -4, -1, 2], [-3, 0, 4], [-12, -8, -5]], 5);
  const mel = line(p12, [0, 4, 7, 4, 5, 9, 12, 9, 8, 11, 8, 4, 9, 12, 9, 4, 7, 4, 0, 4], { dur: 4 });
  const { report, out } = run(p12, mel, acc, { fine: 4, avoidClashes: false });
  assert.deepEqual(keysOf(report), ["diatonic@0"]);
  assert.ok(report.detours >= 1);
  assert.equal(out[8], "B4", "G# over E7 → B, the harmonic-minor third, not C");
});

test("the reading does not depend on which lanes are selected", () => {
  const acc = progression([[-17, -13, -10], [-12, -8, -5], [-10, -6, -3], [-15, -12, -8]], 8);
  const ab = progression([[-16, -12, -9], [-11, -7, -4]], 8, 128);
  const lead = line(p12, [7, 9, 11, 12, 14, 12, 11, 9], { dur: 16, lane: 0, id: "a" });
  const alto = line(p12, [2, 4, 7, 9, 7, 6, 4, 2], { dur: 16, lane: 1, id: "b", t0: 3 });
  const all = [...lead, ...alto];
  const asFixed = (ms) => ms.map((m) => ({ pitch: m.pitch, ...m.occ[0] }));
  const r1 = harmoniseTranspose(p12, { moving: lead, fixed: [...acc, ...ab, ...asFixed(alto)] }, { fine: 4 }).report;
  const r2 = harmoniseTranspose(p12, { moving: alto, fixed: [...acc, ...ab, ...asFixed(lead)] }, { fine: 4 }).report;
  const r3 = harmoniseTranspose(p12, { moving: all, fixed: [...acc, ...ab] }, { fine: 4 }).report;
  // each selection only spans its own notes, so compare where they overlap
  assert.equal(keysOf(r1)[0], "diatonic@7");
  assert.equal(keysOf(r2)[0], "diatonic@7");
  assert.equal(keysOf(r3)[0], "diatonic@7");
});

test("a bend is an ornament: the base note is its target, and the bend keeps its size", () => {
  // [B4] then [C5 G-slide] a row later: a scoop into C, then D E
  const moving = [
    { id: "scoop", pitch: c12(11), lane: 0, src: 1, bendTo: "c", occ: [{ t: 0, dur: 1, beat: 1.5, w: 0.25 }] },
    { id: "c", pitch: c12(12), lane: 0, src: 1, occ: [{ t: 1, dur: 7, beat: 1 }] },
    { id: "d", pitch: c12(14), lane: 0, src: 1, occ: [{ t: 8, dur: 8, beat: 1.2 }] },
    { id: "e", pitch: c12(16), lane: 0, src: 1, occ: [{ t: 16, dur: 8, beat: 1.5 }] },
  ];
  const acc = progression([[-12, -8, -5, -1]], 2);
  const { pitches, report } = harmoniseTranspose(p12, { moving, fixed: acc }, { fine: 4, avoidClashes: false });
  assert.equal(report.baseId, "c", "the scoop is not the first note");
  assert.equal(spell(pitches.get("c")), "E5");
  assert.equal(spell(pitches.get("scoop")), "D#5", "a semitone scoop into E, not D (B's own diatonic third)");
  assert.deepEqual(["d", "e"].map((id) => spell(pitches.get(id))), ["F5", "G5"]);
});

test("song walker: G-slides make ornaments only within a beat; the lane's instrument carries over", () => {
  const perc = new Uint8Array(1024);
  perc[9] = 1;
  const song = mkSong([
    // lane 0, pattern 0: scoop B→C (a row apart), then a held D gliding to E a bar later
    [[0, c12(11), 1], [1, c12(12), 0, G_PORTA], [8, c12(14)], [24, c12(16), 0, G_PORTA]],
    // lane 1: pattern 1 sets the drum kit; pattern 2 (next cue) sets nothing
    [[0, c12(0), 9]],
    [[0, c12(5)], [8, c12(7)]],
  ], [[0, 1], [null, 2]]);
  const { moving } = collectHarmoniseInput(song, perc, () => true);
  const byId = Object.fromEntries(moving.map((m) => [m.id, m]));
  assert.equal(byId["0:0"].bendTo, "0:1", "B scoops into C");
  assert.equal(byId["0:0"].occ[0].w, 0.25);
  assert.equal(byId["0:8"].bendTo, undefined, "a note held two beats before gliding is a note");
  assert.equal(byId["0:8"].occ[0].w, undefined);
  assert.ok(!("2:0" in byId) && !("2:8" in byId), "pattern 2 plays the kit lane 1 set in pattern 1");
  assert.equal(byId["0:0"].src, 1);
});
