// Chord maker core (item 89) — the pitch-offset algebra behind the four note
// modes, degree counting against real pitch tables, and the mix itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JI_INTERVALS, CHORD_GROUPS, CHORD_PRESETS, MAX_UNITS, MAX_VOICES, UNITS_PER_OCTAVE,
  applyChordPreset, buildChord, chordLength, chordPresetLabel, chordPresetsFor,
  defaultVoice, defaultVoices, degreeUnits, invertVoiceSpecs, jiById,
  chordLimitLabel, chordPresetById, chordPresetTitle, equalDivisions, maxInversion, presetVoiceCount, voiceNote, voiceRatio,
  voiceUnits,
} from "../../src/doc/chord.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";
import { pitchTablePresets, gridDelta } from "../../core/tuning/pitchtables.js";
import { MIDDLE_C } from "../../core/engine/constants.js";

const P12 = pitchTablePresets[120];
const P24 = pitchTablePresets[240];
const P31 = pitchTablePresets[310];
const PBP = pitchTablePresets[35130];   // Bohlen-Pierce: period is a TRITAVE
const PPT = pitchTablePresets[1];       // ProTracker: absolute table, interval 0
const PRAW = pitchTablePresets[0];      // Raw: no table at all

const voice = (patch) => ({ ...defaultVoice(), on: true, ...patch });
const sine = (n, cycles) =>
  Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * cycles * i) / n));

// ── the four modes ─────────────────────────────────────────────────────────

test("ji mode: units are the log of the ratio; the table is sane", () => {
  const fifth = voice({ mode: "ji", ji: "3/2" });
  assert.ok(Math.abs(voiceUnits(fifth, P12) - 4096 * Math.log2(1.5)) < 1e-9);
  assert.ok(Math.abs(voiceRatio(fifth, P12) - 1.5) < 1e-12);
  // 3:2 is 701.955¢ — the classic 2¢ over 12-TET's 700
  assert.equal(Math.round((voiceUnits(fifth, P12) * 1200) / 4096), 702);
  assert.equal(voiceUnits(voice({ mode: "ji", ji: "1/1" }), P12), 0);
  assert.equal(voiceUnits(voice({ mode: "ji", ji: "2/1" }), P12), UNITS_PER_OCTAVE);

  // every entry is inside one octave, ascending, and uniquely named
  let prev = -1;
  for (const iv of JI_INTERVALS) {
    const u = 4096 * Math.log2(iv.num / iv.den);
    assert.ok(u > prev, `${iv.id} ascends`);
    assert.ok(u >= 0 && u <= UNITS_PER_OCTAVE, `${iv.id} within the octave`);
    prev = u;
  }
  assert.equal(new Set(JI_INTERVALS.map((iv) => iv.key)).size, JI_INTERVALS.length);
  assert.equal(jiById("nonesuch").id, "1/1", "unknown id falls back to unison");
});

test("key mode: degrees follow the song's notation, and wrap into periods", () => {
  // 12-TET: 7 degrees = the tempered fifth, exactly the table entry
  assert.equal(degreeUnits(P12, 7), P12.table[7]);
  assert.equal(degreeUnits(P12, 0), 0);
  assert.equal(degreeUnits(P12, 12), UNITS_PER_OCTAVE, "a full table wraps to a period");
  assert.equal(degreeUnits(P12, 13), UNITS_PER_OCTAVE + P12.table[1]);
  assert.equal(degreeUnits(P12, -1), -UNITS_PER_OCTAVE + P12.table[11], "negative wraps down");
  assert.equal(degreeUnits(P12, -12), -UNITS_PER_OCTAVE);

  // finer tunings simply offer more of them: 4 degrees of 24-TET is a whole
  // tone, of 12-TET a major third — the TODO's "24-TET has more options"
  assert.equal(degreeUnits(P24, 4), P24.table[4]);
  assert.ok(degreeUnits(P24, 4) < degreeUnits(P12, 4));
  assert.equal(degreeUnits(P24, 14), degreeUnits(P12, 7), "24-TET's 14 = 12-TET's 7");

  // 31-TET's 10th degree is its major third — meantone's whole point, and far
  // closer to just 5:4 than 12-TET's 4 semitones
  const justThird = 4096 * Math.log2(1.25);
  assert.ok(Math.abs(degreeUnits(P31, 10) - justThird) < Math.abs(degreeUnits(P12, 4) - justThird));

  // periods are not assumed to be octaves
  assert.equal(degreeUnits(PBP, PBP.table.length), PBP.interval);
  assert.ok(PBP.interval > UNITS_PER_OCTAVE, "Bohlen-Pierce repeats at a tritave");
});

test("key mode: absolute tables clamp, Raw counts raw units", () => {
  // ProTracker's table IS every note it can say, so degrees clamp at the ends
  const top = degreeUnits(PPT, 999);
  assert.equal(top, degreeUnits(PPT, PPT.table.length), "clamped at the top");
  assert.equal(degreeUnits(PPT, -999), degreeUnits(PPT, -PPT.table.length));
  assert.equal(degreeUnits(PPT, 0), 0, "degree 0 is unison (PT period 428 ≡ C4)");
  assert.ok(Math.abs(degreeUnits(PPT, 12) - UNITS_PER_OCTAVE) < 20, "PT's octave is inexact");

  assert.equal(degreeUnits(PRAW, 100), 100, "no table: one degree = one 4096-TET unit");
});

test("ratio and 4096-TET modes are the two manual inputs", () => {
  assert.ok(Math.abs(voiceRatio(voice({ mode: "ratio", ratio: 1.9632 }), P12) - 1.9632) < 1e-12);
  assert.equal(voiceUnits(voice({ mode: "ratio", ratio: 2 }), P12), UNITS_PER_OCTAVE);
  assert.equal(voiceUnits(voice({ mode: "ratio", ratio: 0 }), P12), 0, "non-positive ratio ignored");
  assert.equal(voiceUnits(voice({ mode: "units", units: 0x100 }), P12), 0x100);
  assert.ok(Math.abs(voiceRatio(voice({ mode: "units", units: 0x1000 }), P12) - 2) < 1e-12);
});

test("oct rides on top of every mode, and travel is clamped", () => {
  for (const v of [{ mode: "ji", ji: "3/2" }, { mode: "key", step: 7 },
                   { mode: "ratio", ratio: 1.5 }, { mode: "units", units: 0x95b }]) {
    const flat = voiceUnits(voice(v), P12);
    assert.equal(voiceUnits(voice({ ...v, oct: 1 }), P12), flat + UNITS_PER_OCTAVE);
    assert.equal(voiceUnits(voice({ ...v, oct: -2 }), P12), flat - 2 * UNITS_PER_OCTAVE);
  }
  assert.equal(voiceUnits(voice({ mode: "ratio", ratio: 16, oct: 4 }), P12), MAX_UNITS);
  assert.equal(voiceUnits(voice({ mode: "units", units: -0x9000 }), P12), -MAX_UNITS);
});

test("voiceNote names where a voice lands when the root sounds Middle C", () => {
  assert.equal(voiceNote(voice({ mode: "ji", ji: "1/1" }), P12), MIDDLE_C);
  assert.equal(voiceNote(voice({ mode: "key", step: 12 }), P12), MIDDLE_C + UNITS_PER_OCTAVE);
  // the just third is 14¢ (≈48 units) under 12-TET's E
  const third = voiceNote(voice({ mode: "ji", ji: "5/4" }), P12);
  assert.ok(third < MIDDLE_C + P12.table[4] && MIDDLE_C + P12.table[4] - third < 60);
  assert.ok(voiceNote(voice({ mode: "units", units: -0x9000 }), P12) >= 0x20, "clamped playable");
});

test("gridDelta signs how far a voice sits from the notation's nearest degree", () => {
  const cents = (u) => (u * 1200) / UNITS_PER_OCTAVE;
  // the readout that makes the just intervals legible: 5:4 lands 13.7¢ under
  // 12-TET's E, 3:2 lands 2¢ over its G
  assert.ok(Math.abs(cents(gridDelta(voiceNote(voice({ mode: "ji", ji: "5/4" }), P12), P12)) + 13.7) < 0.5);
  assert.ok(Math.abs(cents(gridDelta(voiceNote(voice({ mode: "ji", ji: "3/2" }), P12), P12)) - 2.0) < 0.5);
  // 31-TET all but swallows the third; a degree of any table reads exactly 0
  assert.ok(Math.abs(cents(gridDelta(voiceNote(voice({ mode: "ji", ji: "5/4" }), P31), P31))) < 1.5);
  assert.equal(gridDelta(MIDDLE_C + P12.table[7], P12), 0);
  assert.equal(gridDelta(MIDDLE_C + 123, PRAW), 0, "Raw has no grid to be off");
});

// ── presets ────────────────────────────────────────────────────────────────

test("chord presets fill six slots, extras stay silent", () => {
  for (const p of CHORD_PRESETS) {
    const vs = applyChordPreset(p.id);
    assert.equal(vs.length, MAX_VOICES);
    assert.equal(vs.filter((v) => v.on).length, p.voices.length, `${p.id} note count`);
    assert.ok(vs.slice(p.voices.length).every((v) => !v.on), `${p.id} pads with silence`);
  }
  assert.equal(new Set(CHORD_PRESETS.map((p) => p.id)).size, CHORD_PRESETS.length);
  assert.equal(defaultVoices().filter((v) => v.on).length, 3, "opens on a major triad");
  assert.ok(applyChordPreset("nonesuch").every((v) => !v.on), "unknown preset = all silent");

  // the just major triad really is 4:5:6
  const [r, third, fifth] = applyChordPreset("major").map((v) => voiceRatio(v, P12));
  assert.ok(Math.abs(r - 1) < 1e-12 && Math.abs(third - 1.25) < 1e-12 && Math.abs(fifth - 1.5) < 1e-12);
  // detune is the manual-ratio demo: three near-unison copies
  assert.ok(applyChordPreset("detune").filter((v) => v.on).every((v) => v.mode === "ratio"));
});

// ── tetrachords (item 141) ─────────────────────────────────────────────────

test("tetrachords divide their tuning's perfect fourth three ways", () => {
  // The complete charts of the Xenharmonic Wiki: every composition of the
  // fourth into three positive steps, which is (fourth−1 choose 2) of them.
  const expected = { 170: [7, 15], 220: [9, 28], 310: [13, 66] };
  for (const [notation, [fourth, count]] of Object.entries(expected)) {
    const tetra = CHORD_PRESETS.filter((p) => p.notation === Number(notation) && p.steps);
    assert.equal(tetra.length, count, `${notation} has ${count} tetrachords`);
    for (const p of tetra) {
      const steps = p.steps.split("-").map(Number);
      assert.equal(steps.length, 3, `${p.id} is three steps`);
      assert.ok(steps.every((n) => n >= 1), `${p.id} has no zero step`);
      assert.equal(steps.reduce((a, b) => a + b, 0), fourth,
        `${p.id} adds up to the fourth`);
      // …and the notes stand on the unison, the two inner degrees and the fourth
      assert.deepEqual(p.voices.map((v) => v.step),
        [0, steps[0], steps[0] + steps[1], fourth], `${p.id} voice degrees`);
      assert.ok(p.voices.every((v) => v.mode === "key"), `${p.id} counts degrees`);
    }
    assert.equal(new Set(tetra.map((p) => p.steps)).size, count, "no duplicates");
  }
});

test("a tetrachord's top voice IS the perfect fourth of its own tuning", () => {
  const cents = (u) => (u * 1200) / UNITS_PER_OCTAVE;
  for (const [notation, table] of [[170, pitchTablePresets[170]],
    [220, pitchTablePresets[220]], [310, pitchTablePresets[310]]]) {
    const p = CHORD_PRESETS.find((q) => q.notation === notation && q.steps);
    const units = applyChordPreset(p.id).filter((v) => v.on).map((v) => voiceUnits(v, table));
    assert.equal(units.length, 4, "four pitches");
    assert.equal(units[0], 0, "…standing on the root");
    // A fourth is ~498 ¢ in any of these EDOs (17edo's is the widest, 494 ¢).
    assert.ok(Math.abs(cents(units[3]) - 498) < 12,
      `${notation} tetrachord spans a fourth (got ${Math.round(cents(units[3]))} ¢)`);
    for (let i = 1; i < units.length; i++) assert.ok(units[i] > units[i - 1]);
  }
});

test("tetrachords are offered only in their own tuning, and never invert", () => {
  const ids = (index) => new Set(chordPresetsFor(pitchTablePresets[index]).map((p) => p.id));
  const plain = CHORD_PRESETS.filter((p) => p.notation === undefined && p.edo === undefined);
  assert.equal(chordPresetsFor({ index: 120 }).length, plain.length,
    "a notation with no table sees the tuning-independent vocabulary and nothing else");
  assert.equal(chordPresetsFor(null).length, plain.length, "…as does no notation at all");
  // the families that follow the tuning's size, on top of its tetrachords
  const bySize = (edo, group) => CHORD_PRESETS
    .filter((p) => p.edo === edo && (!group || p.group === group)).length;
  assert.equal(ids(170).size, plain.length + 15 + bySize(17));
  assert.equal(ids(220).size, plain.length + 28 + bySize(22));
  assert.equal(ids(310).size, plain.length + 66 + bySize(31));
  assert.equal(bySize(22, "extraclassical"), 14, "22-TET has both families on its menu");
  assert.ok(!ids(220).has("tetra170-3-3-1"), "17-TET's tetrachords stay in 17-TET");
  assert.ok(ids(170).has("major"), "…and the ordinary chords are always there");

  // A tetrachord is a scale segment: inverting it would only scramble it.
  assert.equal(maxInversion("tetra170-3-3-1"), 0);
  assert.deepEqual(applyChordPreset("tetra170-3-3-1", 2), applyChordPreset("tetra170-3-3-1"));
});

test("tetrachord menu labels are the step pattern, plus the source's name", () => {
  const t = (k) => `«${k}»`;
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "major"), t),
    "«chord.preset.major»");
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra170-3-3-1"), t),
    "3-3-1 · ionian (jins ʻAjam)");
  // Several modes to one pattern: the wiki lists them all, the menu keeps the
  // first — the pattern is the real name and the select has a width.
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra220-4-4-1"), t),
    "4-4-1 · diatonic · Superpyth major");
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra220-3-3-3"), t),
    "3-3-3 · diatonic · Porcupine");
  for (const p of CHORD_PRESETS) {
    assert.ok(chordPresetLabel(p, t).length <= 44, `${p.id} label fits a menu`);
  }
  // 31edo's chart names nothing, so the pattern stands alone
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra310-5-3-5"), t), "5-3-5");
  assert.equal(chordPresetLabel(null, t), "");
});

// ── higher-limit harmony: septimal, nonal, undecimal … ─────────────────────

/** An equal octave division as a pitch table, rounded the way the built-in
 *  ones are — what a Notation Maker table of that size looks like. */
const equalTable = (n) => ({
  index: 0xfff0, interval: UNITS_PER_OCTAVE,
  table: Array.from({ length: n }, (_, i) => Math.round((i * UNITS_PER_OCTAVE) / n)),
});
const HL = CHORD_PRESETS.filter((p) => p.group === "higherlimit");
const hlLimits = (edo) => [...new Set(HL.filter((p) => p.edo === edo).map((p) => p.limit))];
/** Cents error of the nearest degree to harmonic h — checked from scratch. */
const hErr = (edo, h) => (Math.round(edo * Math.log2(h)) - edo * Math.log2(h)) * (1200 / edo);

test("each tuning's higher limits are its new, well-approximated harmonics", () => {
  // The Xenharmonic Wiki's own list for 23edo, and 31-TET's septimal alone
  assert.deepEqual(hlLimits(23), [9, 13, 15, 17, 21, 23, 31, 33, 35]);
  assert.deepEqual(hlLimits(31), [7]);
  assert.deepEqual(hlLimits(12), [17, 19]);
  assert.deepEqual(hlLimits(22), [11, 17, 29, 31]);
  assert.deepEqual(hlLimits(53), [7, 13, 19]);
  assert.deepEqual(hlLimits(96), [11, 13, 19]);
  // the 8 ¢ line sits between what the 23edo list keeps and what it drops
  assert.ok([9, 13, 15, 17, 21, 23, 31, 33, 35].every((h) => Math.abs(hErr(23, h)) <= 7.5));
  assert.ok(Math.abs(hErr(23, 25)) >= 9.9 && Math.abs(hErr(22, 7)) > 12);
  // and every limit offered anywhere obeys the rule
  for (let edo = 5; edo <= 96; edo++) {
    const good = [];
    for (let h = 3; h <= 35; h += 2) {
      const e = Math.abs(hErr(edo, h));
      if (e <= 8 && e <= 1200 / edo / 4) good.push(h);
    }
    const isNew = (h) => !good.some((a) => a < h && h % a === 0 && good.includes(h / a));
    const offered = hlLimits(edo);
    if (edo > 53 && edo !== 96) {
      assert.deepEqual(offered, [], `${edo}-TET is not in the range`);
      continue;
    }
    for (const h of offered) {
      assert.ok(good.includes(h) && isNew(h) && h >= 7, `${edo}-TET's ${h} is new and in tune`);
    }
    // a limit only goes missing in a coarse tuning, where nothing in close
    // position survives the collisions
    const lost = { 7: [29], 8: [19], 14: [25], 15: [35] };
    assert.deepEqual(good.filter((g) => g >= 7 && isNew(g) && !offered.includes(g)),
      lost[edo] ?? [], `${edo}-TET offers every new harmonic it can voice`);
  }
});

test("higher-limit chords are harmonic-series chords on the tuning's own degrees", () => {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const odd = (n) => { while (n % 2 === 0) n /= 2; return n; };
  for (const p of HL) {
    const { edo, limit, harmonics: h, utonal } = p;
    assert.ok(h.length >= 3 && h.length <= 4, `${p.id} is a triad or tetrad`);
    assert.equal(h.reduce(gcd), 1, `${p.id} is in lowest terms`);
    assert.ok(h[h.length - 1] < 2 * h[0], `${p.id} is in close position`);
    assert.ok(h.some((n) => odd(n) % limit === 0), `${p.id} uses its limit's harmonic`);
    assert.equal(p.variant, utonal ? `1/(${h.join(":")})` : h.join(":"));
    // each note sits within a step of the just interval it stands for
    const just = h.map((n) => 1200 * Math.log2(n / h[0]));
    const want = utonal ? just.map((c) => just[just.length - 1] - c).reverse() : just;
    p.voices.forEach((v, i) => {
      assert.equal(v.mode, "key");
      assert.ok(Math.abs((v.step * 1200) / edo - want[i]) < 1200 / edo + 16,
        `${p.id} note ${i} is ${(v.step * 1200) / edo} ¢, near ${want[i].toFixed(0)} ¢`);
    });
  }
  for (const p of HL) {
    const { edo, harmonics: h, utonal } = p;
    const just = h.map((n) => 1200 * Math.log2(n / h[0]));
    const at = utonal ? just.map((c) => just[just.length - 1] - c).reverse() : just;
    const tempered = p.voices.map((v) => (v.step * 1200) / edo);
    p.errors.forEach((e, i) => assert.ok(Math.abs(e - (tempered[i] - at[i])) <= 0.05,
      `${p.id} note ${i} error`));
    let worst = 0;
    for (let i = 0; i < h.length; i++) {
      for (let j = i + 1; j < h.length; j++) {
        worst = Math.max(worst, Math.abs(tempered[j] - tempered[i] - (at[j] - at[i])));
      }
    }
    assert.ok(Math.abs(p.worst - worst) <= 0.05, `${p.id} worst interval error`);
    assert.ok(p.worst >= Math.max(...p.errors.map(Math.abs)) - 0.05, `${p.id} worst covers the bass`);
    assert.ok(Math.abs(p.limitError) <= 8, `${p.id} limit is in tune`);
  }
  const deg = (id) => chordPresetById(id).voices.map((v) => v.step);
  // 31-TET's septimal staples, on the degrees every 31-TET player knows
  assert.deepEqual(deg("hl31-4.5.6.7"), [0, 10, 18, 25], "harmonic seventh");
  assert.deepEqual(deg("hl31-6.7.9"), [0, 7, 18], "subminor triad");
  assert.deepEqual(deg("hl31-u6.7.9"), [0, 11, 18], "…and its mirror, the supermajor");
  assert.deepEqual(deg("hl31-u4.5.6.7"), [0, 7, 15, 25]);
  // 23-TET's nonal is the 2.9 subgroup on its own: stacked 9/8s
  assert.deepEqual(HL.filter((p) => p.edo === 23 && p.limit === 9).map((p) => p.id), ["hl23-64.72.81"]);
  assert.deepEqual(HL.filter((p) => p.edo === 45 && p.limit === 15).map((p) => p.id), ["hl45-120.128.225"]);
  assert.deepEqual(deg("hl23-64.72.81"), [0, 4, 8]);
  assert.deepEqual(deg("hl23-8.9.13.15"), [0, 4, 16, 21]);
  // no tuning offers one chord twice, not even as another's inversion
  for (const edo of new Set(HL.map((p) => p.edo))) {
    const seen = new Set();
    for (const p of HL.filter((q) => q.edo === edo)) {
      const d = p.voices.map((v) => v.step);
      const cls = d.map((b) => d.map((x) => (((x - b) % edo) + edo) % edo).sort((a, c) => a - c).join(","))
        .sort()[0];
      assert.ok(!seen.has(cls), `${p.id} repeats an earlier chord`);
      seen.add(cls);
    }
    assert.ok(hlLimits(edo).every((l) => HL.filter((p) => p.edo === edo && p.limit === l).length <= 12));
  }
});

test("higher-limit chords follow any equal octave division, built-in or not", () => {
  assert.equal(equalDivisions(P12), 12);
  assert.equal(equalDivisions(P31), 31);
  assert.equal(equalDivisions(pitchTablePresets[531]), 53);
  assert.equal(equalDivisions(equalTable(27)), 27);
  for (const p of [PBP, PPT, PRAW, pitchTablePresets[10121], pitchTablePresets[10123], null]) {
    assert.equal(equalDivisions(p), null);
  }
  const on = (preset) => chordPresetsFor(preset).filter((p) => p.group === "higherlimit");
  assert.ok(on(P31).length > 0 && on(P31).every((p) => p.edo === 31));
  // a tuning with no built-in notation still gets its chords from a custom table
  assert.ok(!Object.values(pitchTablePresets).some((p) => p.table.length === 27));
  assert.ok(on(equalTable(27)).length > 0 && on(equalTable(27)).every((p) => p.edo === 27));
  // both 53-TET notations see the same chords
  assert.deepEqual(on(pitchTablePresets[530]), on(pitchTablePresets[531]));
  for (const p of [PBP, PPT, PRAW, pitchTablePresets[10121], equalTable(9)]) {
    assert.deepEqual(on(p), []);
  }
});

test("higher-limit chords are their own group, before neutral, and named", () => {
  assert.ok(CHORD_GROUPS.indexOf("higherlimit") < CHORD_GROUPS.indexOf("neutral"));
  assert.ok(CHORD_GROUPS.indexOf("spread") < CHORD_GROUPS.indexOf("higherlimit"));
  for (const l of new Set(HL.map((p) => p.limit))) {
    assert.ok(en[`chord.limit.${l}`] && ko[`chord.limit.${l}`], `limit ${l} is named`);
  }
  const t = (k, params) => Object.entries(params ?? {})
    .reduce((s, [p, v]) => s.replaceAll(`{${p}}`, String(v)), en[k]);
  // the optgroup carries the limit and its harmonic's error; the row, its
  // ratio and the worst interval in it
  assert.equal(chordLimitLabel(chordPresetById("hl31-4.5.6.7"), t), "Septimal (7) · −1.1 cents");
  assert.equal(chordLimitLabel(chordPresetById("hl23-8.9.13"), t), "Tridecimal (13) · −5.7 cents");
  assert.equal(chordPresetLabel(chordPresetById("hl31-4.5.6.7"), t), "4:5:6:7 · max error 6.0 cents");
  assert.equal(chordPresetLabel(chordPresetById("hl31-u4.5.6.7"), t),
    "1/(4:5:6:7) · max error 6.0 cents");
  assert.equal(chordPresetTitle(chordPresetById("hl31-4.5.6.7"), t),
    "Each note against just intonation, from the bass: 0, +0.8, −5.2, −1.1 cents");
  assert.equal(chordLimitLabel(chordPresetById("major"), t), "");
  assert.equal(chordPresetTitle(chordPresetById("major"), t), "");
  assert.ok(ko["chord.maxError"] && ko["chord.noteErrors"]);
  // a degree-mode chord inverts like the neutral ones
  const cents = (id, inv) => applyChordPreset(id, inv, P31).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, P31) * 1200) / UNITS_PER_OCTAVE));
  assert.deepEqual(cents("hl31-4.5.6.7", 0), [0, 387, 697, 968]);
  assert.deepEqual(cents("hl31-4.5.6.7", 1), [387, 697, 968, 1200]);
});

// ── neutral harmony (item 167, follow-up) ──────────────────────────────────

const NT_EDOS = [...new Set(CHORD_PRESETS.filter((p) => p.group === "neutral")
  .map((p) => p.edo))];

test("a neutral third is half the fifth, inside the wiki's 341-361 ¢ band", () => {
  // Swept from scratch over every tuning the family covers: a proper
  // diatonic with distinct major and minor thirds to be the centre of, half
  // its fifth in the band, spelt exactly when the fifth is even, and as the
  // two degrees either side when it is odd — the wiki's artoneutral (11/9) and
  // tendoneutral (16/13) — provided both are within 12 ¢ of the centre.
  const want = {};
  for (const edo of [...Array.from({ length: 43 }, (_, i) => 11 + i), 96]) {
    const { fifth, proper, L, s } = diatonic(edo);
    const centre = (fifth * 1200) / (2 * edo);
    if (!proper || L === s || centre < 341 || centre > 361) continue;
    if (fifth % 2 === 0) want[edo] = [fifth / 2];
    else if (centre - (((fifth - 1) / 2) * 1200) / edo <= 12 + 1e-9) {
      want[edo] = [(fifth - 1) / 2, (fifth + 1) / 2];
    }
  }
  assert.deepEqual(NT_EDOS.slice().sort((a, b) => a - b), Object.keys(want).map(Number));
  // …and every tuning the hand-made table used to list is still among them
  for (const edo of [17, 24, 31, 41, 53, 96]) assert.ok(want[edo], `${edo}-TET keeps its neutral`);
  assert.deepEqual(want[53], [15, 16]);
  for (const [key, thirds] of Object.entries(want)) {
    const edo = Number(key);
    const { fifth } = diatonic(edo);
    const triads = CHORD_PRESETS.filter((p) => p.edo === edo && p.id.endsWith("-neutral"));
    assert.deepEqual(triads.map((p) => p.voices[1].step), thirds, `${edo} thirds`);
    const centre = (fifth * 1200) / (2 * edo);
    for (const p of triads) {
      const n3 = p.voices[1].step;
      assert.deepEqual(p.voices.map((v) => v.step), [0, n3, fifth], `${p.id} is root/third/fifth`);
      // it IS the degree nearest half the fifth — latitude 0, the centre of
      // the category rather than a side of it
      assert.ok(Math.abs(n3 - fifth / 2) <= 0.5, `${edo}/${n3} halves the fifth`);
      // …and a tuning only gets the split when both halves still read neutral
      assert.ok(Math.abs((n3 * 1200) / edo - centre) <= 12 + 1e-9, `${edo}/${n3} stays neutral`);
    }
  }
  // 12-TET halves its fifth at exactly 350 ¢ but cannot SPELL it: the nearest
  // degrees are its plain major and minor thirds, 50 ¢ either side. 43-TET's
  // two are 14 ¢ out, 10-TET's 360 ¢ is one of only ten degrees, 20- and
  // 30-TET's 360 ¢ halves a 720 ¢ fifth that makes no diatonic, and 14- and
  // 35-TET's 343 ¢ is their major and minor third at once.
  assert.equal((diatonic(12).fifth * 1200) / 24, 350);
  for (const preset of [120, 150, 160, 190, 220, 430, 0, 1, 35130].map((i) => pitchTablePresets[i])
    .concat([equalTable(10), equalTable(7), equalTable(43), equalTable(20), equalTable(30),
      equalTable(14), equalTable(35)])) {
    assert.ok(!chordPresetsFor(preset).some((p) => p.group === "neutral"),
      `${preset.name ?? preset.table.length} cannot spell a neutral third`);
  }
  // a Notation Maker table of a size with no built-in notation gets them too
  assert.ok(chordPresetsFor(equalTable(27)).some((p) => p.group === "neutral"));
});

test("the neutral ladder stacks and inverts like the arto/tendo one", () => {
  const JI = { n3: 350.978, n7: 1049.363, n6: 852.592, n2: 150.637 };
  for (const edo of NT_EDOS) {
    const { fifth, L, s, proper } = diatonic(edo);
    // A shape that spells the same notes as one before it on the menu is
    // offered once, under the first name (14-TET's chain IS its 9th chord).
    const seen = new Set();
    const once = (degrees) => {
      const sig = degrees.join(",");
      if (seen.has(sig)) return undefined;
      seen.add(sig);
      return degrees;
    };
    for (const triad of CHORD_PRESETS.filter((p) => p.edo === edo && p.id.endsWith("-neutral"))) {
      const n3 = triad.voices[1].step;
      const deg = (shape) => CHORD_PRESETS
        .find((p) => p.id === `nt${edo}-${n3}-${shape}`)?.voices.map((v) => v.step);
      const n7 = fifth + n3, n6 = edo - n3, n2 = edo - n7;
      const m7 = 4 * L + 2 * s, M7 = 5 * L + s;
      const mixes = proper && m7 < n7 && n7 < M7;
      once([0, n3, fifth]);
      assert.deepEqual(deg("neutral7"), once([0, n3, fifth, n7]), `${edo}/${n3} 7th`);
      if (mixes) {
        assert.deepEqual(deg("neutralmin7"), once([0, n3, fifth, m7]));
        assert.deepEqual(deg("neutralmaj7"), once([0, n3, fifth, M7]));
      }
      assert.deepEqual(deg("neutral6"), once([0, n3, fifth, n6]));
      assert.deepEqual(deg("neutraladd9"), once([0, n3, fifth, edo + n2]));
      assert.deepEqual(deg("neutral9"), once([0, n3, fifth, n7, edo + n2]));
      // the chain is the fifth halved, then its own fifth halved again
      assert.deepEqual(deg("neutralchain"), once([0, n3, fifth, n7, 2 * fifth]), `${edo} chain`);
      // neutral IS between: the third between the tuning's minor and major
      // thirds, the seventh between its minor and major sevenths
      assert.ok(L + s < n3 && n3 < 2 * L, `${edo}/${n3} sits between minor and major`);
      assert.ok(m7 < n7 && n7 < M7, `${edo}/${n3} neutral 7th sits between minor and major`);
      // and in the tunings with a near-just fifth — the six the hand-made
      // table listed — every rung lands within 15 ¢ of the just interval the
      // wiki names for it. (A rung is the fifth stacked, so a fifth 10 ¢ out
      // moves the seventh 15 ¢: 37-TET's is 1070 ¢ to 11/6's 1049 ¢.)
      const cents = (d) => (d * 1200) / edo;
      if ([17, 24, 31, 41, 53, 96].includes(edo)) {
        for (const [name, d] of [["n3", n3], ["n7", n7], ["n6", n6], ["n2", n2]]) {
          assert.ok(Math.abs(cents(d) - JI[name]) <= 15,
            `${edo}/${n3} ${name} is ${Math.round(cents(d))} ¢, near ${Math.round(JI[name])} ¢`);
        }
      }
      // the two mixed sevenths, checked above, are the tuning's OWN
      assert.ok(proper && mixes, `${edo}/${n3} has its own sevenths to mix`);
    }
  }
  // every tuning the hand-made table listed has its two mixed sevenths
  for (const edo of [17, 24, 31, 41, 53, 96]) {
    assert.ok(CHORD_PRESETS.some((p) => p.edo === edo && p.id.endsWith("-neutralmin7")));
  }
});

test("neutral chords are their own group, tuning-locked and named", () => {
  assert.ok(CHORD_GROUPS.includes("neutral"));
  assert.ok(CHORD_GROUPS.indexOf("neutral") < CHORD_GROUPS.indexOf("extraclassical"),
    "between major and minor comes before outside them");
  assert.ok(en["chord.group.neutral"] && ko["chord.group.neutral"]);
  const all = CHORD_PRESETS.filter((p) => p.group === "neutral");
  for (const p of all) {
    assert.ok(en[p.key] && ko[p.key], `${p.id} is named in both languages`);
    assert.ok(p.voices.every((v) => v.mode === "key"), `${p.id} counts degrees`);
    assert.ok(!chordPresetsFor(P12).includes(p), `${p.id} stays out of 12-TET`);
    assert.ok(chordPresetsFor(equalTable(p.edo)).includes(p), `${p.id} is on its own menu`);
  }
  // both 53-TET notations see the same chords
  const nt = (preset) => chordPresetsFor(preset).filter((p) => p.group === "neutral");
  assert.deepEqual(nt(pitchTablePresets[530]), nt(pitchTablePresets[531]));
  assert.equal(nt(pitchTablePresets[530]).length, 16);
  // 53-TET names its two by the just thirds they temper, the rest need no tag
  const t = (k) => `«${k}»`;
  assert.equal(chordPresetLabel(chordPresetById("nt53-15-neutral"), t),
    "«chord.preset.nt.neutral» · 11/9");
  assert.equal(chordPresetLabel(chordPresetById("nt53-16-neutral"), t),
    "«chord.preset.nt.neutral» · 16/13");
  assert.equal(chordPresetLabel(chordPresetById("nt24-7-neutral"), t),
    "«chord.preset.nt.neutral»");
  // a neutral triad inverts like any other voicing
  const cents = (id, inv) => applyChordPreset(id, inv, P24).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, P24) * 1200) / UNITS_PER_OCTAVE));
  assert.deepEqual(cents("nt24-7-neutral", 0), [0, 350, 700]);
  assert.deepEqual(cents("nt24-7-neutral", 1), [350, 700, 1200]);
  // …and 24-TET's neutral third really is half its fifth, to the cent
  assert.equal(cents("nt24-7-neutral", 0)[1] * 2, cents("nt24-7-neutral", 0)[2]);
});

// ── extraclassical harmony: arto and tendo (item 167) ──────────────────────

/** Best fifth and diatonic step sizes of an EDO, straight from its chain of
 *  fifths — derived here rather than imported, so the presets are checked
 *  against arithmetic and not against themselves. `half` is half a chroma,
 *  null when the tuning has no proper diatonic or an odd chroma. */
function diatonic(edo) {
  const fifth = Math.round(edo * Math.log2(1.5));
  const chain = [-1, 0, 1, 2, 3, 4, 5]
    .map((i) => (((i * fifth) % edo) + edo) % edo).sort((a, b) => a - b);
  const steps = chain.map((v, i) => (i === 6 ? edo + chain[0] - v : chain[i + 1] - v));
  const uniq = [...new Set(steps)].sort((a, b) => a - b);
  const L = uniq[uniq.length - 1], s = uniq[0];
  return {
    fifth, L, s,
    // a real 5L2s: 16-TET's chain scale is 2L5s and 5/10/15-TET's collapses
    proper: s > 0 && 3 * L + s === fifth,
    half: s > 0 && (L - s) % 2 === 0 ? (L - s) / 2 : null,
  };
}
/** Sharpest fifth that still reads as diatonic-with-ordinary-thirds: 22-TET's
 *  own, which is where the wiki says the native triads reach arto and tendo. */
const SUPERPYTH_FIFTH = (13 * 1200) / 22;
/** Where a third sits between root and fifth: 0° dead centre, ±90° the fifth
 *  itself. Arto and tendo are ±22.5–30° by the wiki's broadened table. */
const latitude = (third, fifth) => (third / fifth - 0.5) * 180;
const LAT_EPS = 1e-9;

/** The pairs a tuning of `edo` steps offers, read back off its own presets. */
function extraclassicalPairs(edo) {
  const of = (shape) => CHORD_PRESETS
    .filter((p) => p.edo === edo && p.group === "extraclassical" && p.id.endsWith(`-${shape}`))
    .map((p) => p.voices.map((v) => v.step));
  const artos = of("arto"), tendos = of("tendo");
  assert.equal(artos.length, tendos.length, `${edo} pairs arto with tendo`);
  return artos.map(([, a, fifth], i) => ({ a, t: tendos[i][1], fifth }));
}

const XC_EDOS = [...new Set(CHORD_PRESETS.filter((p) => p.group === "extraclassical")
  .map((p) => p.edo))];
/** 43-TET's outer two pairs were picked by hand when it was added. */
const XC_HAND_PICKED = { 43: [8, 10] };

test("every arto/tendo pair is one the Xenharmonic Wiki recognises", () => {
  // The tunings the hand-made table used to list, and the pairs each one got.
  // 31/41/43/96 have more than one: reproduced below from latitude and from
  // quality arithmetic independently.
  const kept = {
    15: [[3, 6]], 16: [[3, 6]], 17: [[3, 7]], 19: [[4, 7]],
    22: [[5, 8]], 24: [[5, 9]],
    31: [[6, 12], [7, 11]], 41: [[8, 16], [9, 15]],
    43: [[8, 17], [9, 16], [10, 15]], 53: [[11, 20]],
    96: [[19, 37], [20, 36], [21, 35]],
  };
  for (const [edo, want] of Object.entries(kept)) {
    assert.deepEqual(extraclassicalPairs(Number(edo)).map((p) => [p.a, p.t]), want, `${edo} pairs`);
  }
  // Every tuning the family covers, swept from scratch: a pair is offered
  // exactly when it is arto/tendo by one of the three readings.
  for (const edo of [...Array.from({ length: 43 }, (_, i) => 11 + i), 96]) {
    const { fifth, L, s, half, proper } = diatonic(edo);
    const reading = (a) => {
      const lat = -latitude(a, fifth);
      // EITHER wide enough to sound extraclassical…
      if (lat >= 22.5 - LAT_EPS && lat <= 30 + LAT_EPS) return "by ear";
      // …OR the one a proper diatonic spells with a demiflat and a demisharp,
      // between 31-TET's ±20° and 17-TET's ±36°…
      if (proper && half && a === L + s - half && lat >= 20 - LAT_EPS && lat <= 36 + LAT_EPS) {
        return "spelt";
      }
      // …OR the tuning's own thirds, dragged out there by a superpyth fifth.
      if (proper && (fifth * 1200) / edo >= SUPERPYTH_FIFTH - LAT_EPS && a === L + s) return "native";
      if (XC_HAND_PICKED[edo]?.includes(a)) return "by hand";
      return null;
    };
    const want = [];
    for (let a = 1; 2 * a < fifth; a++) if (reading(a)) want.push([a, fifth - a]);
    const got = extraclassicalPairs(edo);
    assert.deepEqual(got.map((p) => [p.a, p.t]), want, `${edo}-TET pairs`);
    for (const p of got) assert.equal(p.fifth, fifth, `${edo} stands on its own best fifth`);
  }
  // 22-TET is the whole of that third case: its own minor and major thirds are
  // within 6 ¢ of 7/6 and 9/7, the wiki's first 7-limit tuning of the pair,
  // though their latitude is only ±20.8° and its chroma is odd.
  const p22 = diatonic(22);
  assert.equal(p22.half, null, "22-TET has an odd chroma, so no ladder");
  assert.ok(Math.round(-latitude(5, p22.fifth) * 10) / 10 === 20.8);
  assert.ok(Math.abs((5 * 1200) / 22 - 1200 * Math.log2(7 / 6)) < 6);
  assert.ok(Math.abs((8 * 1200) / 22 - 1200 * Math.log2(9 / 7)) < 6);
  for (const edo of [12, 17, 19, 24, 31, 41, 53, 96]) {
    const d = diatonic(edo);
    assert.ok(!d.proper || (d.fifth * 1200) / edo < SUPERPYTH_FIFTH - LAT_EPS,
      `${edo}-TET's fifth is not superpyth, so its own thirds stay put`);
  }
  // 17-TET has only the spelling (its thirds are at ±36°, and its tendo third
  // IS its perfect fourth — the collision the wiki warns about); 31-TET's
  // spelt pair is at ±20°, so it also offers the wide one it can only hear.
  assert.equal(Math.round(-latitude(3, 10)), 36);
  assert.equal(Math.round(-latitude(7, 18)), 20);
  assert.equal(extraclassicalPairs(17)[0].t, diatonic(17).fifth - 3);
  // …while 12-TET has none of the three, so it is offered nothing; 5- and
  // 10-TET have one by ear but only five-note slices to voice it with.
  for (const preset of [P12, PRAW, PPT, PBP, equalTable(5), equalTable(10), equalTable(23)]) {
    assert.ok(!chordPresetsFor(preset).some((p) => p.group === "extraclassical"),
      `${preset.name ?? preset.table.length} has no arto/tendo pair`);
  }
  // 26-TET, which no built-in notation covers, is the 8/7·21/16 pair at 30°
  assert.deepEqual(extraclassicalPairs(26).map((p) => [p.a, p.t]), [[5, 10]]);
  assert.ok(chordPresetsFor(equalTable(26)).some((p) => p.id === "xc26-5-arto"));
});

test("the arto/tendo ladder is the pair stacked on the fifth, then inverted", () => {
  // The wiki tabulates a ladder; we derive one from the pair and the fifth
  //   arto/tendo seventh = fifth + arto/tendo third
  //   tendo second = octave − arto seventh, tendo sixth = octave − arto third
  // and these are the identities that make the derivation legal.
  for (const edo of XC_EDOS) {
    for (const { a, t, fifth } of extraclassicalPairs(edo)) {
      const deg = (shape) => CHORD_PRESETS
        .find((p) => p.id === `xc${edo}-${a}-${shape}`)?.voices.map((v) => v.step);
      const a7 = fifth + a, t7 = fifth + t, t2 = edo - a7, t6 = edo - a;
      assert.deepEqual(deg("arto7"), [0, a, fifth, a7], `${edo}/${a} arto 7th`);
      if (t7 % edo !== 0) {
        assert.deepEqual(deg("tendo7"), [0, t, fifth, t7], `${edo}/${a} tendo 7th`);
        assert.deepEqual(deg("artotendo7"), [0, a, fifth, t7]);
      } else {
        assert.equal(deg("tendo7"), undefined, `${edo}/${a} tendo 7th IS the octave`);
      }
      assert.deepEqual(deg("tendodom7"), [0, t, fifth, a7]);
      assert.deepEqual(deg("tendoadd9"), [0, t, fifth, edo + t2]);
      // A sixth chord only appears where the sixth is not already the seventh,
      // which is exactly when the fourth is twice the arto third.
      if (edo - fifth === 2 * a) assert.equal(deg("arto6"), undefined, `${edo}/${a} 6 = 7`);
      else assert.deepEqual(deg("arto6"), [0, a, fifth, t6]);
      // The equal-stepped six-note chain belongs to the pairs that trisect
      // the fifth — the slendric generator, three of them making a fifth.
      const chain = deg("chain");
      if (fifth % 3 === 0 && a === fifth / 3 && t7 % edo !== 0) {
        assert.deepEqual(chain, [0, a, 2 * a, 3 * a, 4 * a, 5 * a], `${edo} slendric chain`);
      } else {
        assert.equal(chain, undefined, `${edo}/${a} has no equal chain`);
      }
    }
  }
});

test("the derived ladder reproduces the wiki's interval-quality table", () => {
  // "Arto and tendo as interval qualities": arto is semi-diminished, tendo
  // semi-augmented, so each is half a chroma off the classical interval. The
  // table is the wiki's, verbatim, in cents.
  const wiki = {
    tendoUnison:  { 24: 50, 31: 39, 17: 71, 41: 59 },
    artoSecond:   { 24: 50, 31: 77, 17: 0, 41: 29 },
    tendoSecond:  { 24: 250, 31: 232, 17: 282, 41: 263 },
    artoThird:    { 24: 250, 31: 271, 17: 212, 41: 234 },
    tendoThird:   { 24: 450, 31: 426, 17: 494, 41: 468 },
    artoFourth:   { 24: 450, 31: 465, 17: 424, 41: 439 },
    tendoFourth:  { 24: 550, 31: 541, 17: 565, 41: 556 },
    artoFifth:    { 24: 650, 31: 659, 17: 635, 41: 654 },
    tendoFifth:   { 24: 750, 31: 735, 17: 776, 41: 761 },
    artoSixth:    { 24: 750, 31: 774, 17: 706, 41: 732 },
    tendoSixth:   { 24: 950, 31: 929, 17: 988, 41: 966 },
    artoSeventh:  { 24: 950, 31: 968, 17: 918, 41: 937 },
    tendoSeventh: { 24: 1150, 31: 1123, 17: 1200, 41: 1171 },
    artoOctave:   { 24: 1150, 31: 1161, 17: 1129, 41: 1141 },
  };
  // Three cells of it are typos, and the corrections are what we implement:
  // an arto fifth and a tendo fourth must add up to an octave, and 41-TET's
  // 654 ¢ is not even a degree of 41-TET.
  const errata = { "31/tendoFourth": 542, "31/artoFifth": 658, "41/artoFifth": 644 };

  for (const edo of [24, 31, 17, 41]) {
    const { fifth, L, s, half } = diatonic(edo);
    assert.ok(half !== null, `${edo}-TET has an even chroma`);
    const ladder = {
      tendoUnison: half, artoSecond: s - half, tendoSecond: L + half,
      artoThird: L + s - half, tendoThird: 2 * L + half,
      artoFourth: 2 * L + s - half, tendoFourth: 2 * L + s + half,
      artoFifth: fifth - half, tendoFifth: fifth + half,
      artoSixth: 3 * L + 2 * s - half, tendoSixth: 4 * L + half + s,
      artoSeventh: 4 * L + 2 * s - half, tendoSeventh: 5 * L + s + half,
      artoOctave: edo - half,
    };
    for (const [name, steps] of Object.entries(ladder)) {
      const cents = Math.round((steps * 1200) / edo);
      assert.equal(cents, errata[`${edo}/${name}`] ?? wiki[name][edo],
        `${edo}-TET ${name}`);
    }
    // and the ladder's own third pair is one this tuning actually offers
    assert.ok(extraclassicalPairs(edo)
      .some((p) => p.a === ladder.artoThird && p.t === ladder.tendoThird),
      `${edo}-TET offers its spelt pair`);
    // the derivation the presets use agrees with the ladder cell by cell
    assert.equal(ladder.artoSeventh, fifth + ladder.artoThird);
    assert.equal(ladder.tendoSeventh, fifth + ladder.tendoThird);
    assert.equal(ladder.tendoSecond, edo - ladder.artoSeventh);
    assert.equal(ladder.artoSecond, edo - ladder.tendoSeventh);
    assert.equal(ladder.tendoSixth, edo - ladder.artoThird);
    assert.equal(ladder.artoSixth, edo - ladder.tendoThird);
    // …and the altered fourths and fifths, which only a half chroma can reach
    assert.equal(ladder.artoFourth + ladder.tendoFifth, edo);
    assert.equal(ladder.tendoFourth + ladder.artoFifth, edo);
  }
});

test("arto/tendo chords are tuning-locked, unique, and named in both languages", () => {
  for (const edo of XC_EDOS) {
    const table = equalTable(edo);
    const mine = chordPresetsFor(table).filter((p) => p.group === "extraclassical");
    assert.ok(mine.length >= 9, `${edo} offers a vocabulary (${mine.length})`);
    const sigs = new Set();
    for (const p of mine) {
      assert.ok(p.voices.every((v) => v.mode === "key"), `${p.id} counts degrees`);
      assert.ok(en[p.key] && ko[p.key], `${p.id} is named in both languages`);
      // no note doubles the root at the octave — that is a level change
      assert.ok(p.voices.slice(1).every((v) => v.step % table.table.length !== 0),
        `${p.id} never lands on an octave of the root`);
      const sig = p.voices.map((v) => v.step).join(",");
      assert.ok(!sigs.has(sig), `${p.id} is not a second name for another chord`);
      sigs.add(sig);
      // and it is off every other tuning's menu
      assert.ok(!chordPresetsFor(P12).includes(p), `${p.id} stays out of 12-TET`);
    }
    // the pair's own triads really are the tuning's degrees, in cents
    const [{ a, t, fifth }] = extraclassicalPairs(edo);
    const cents = (d) => Math.round((voiceUnits({ ...defaultVoice(), mode: "key", step: d }, table)
      * 1200) / UNITS_PER_OCTAVE);
    assert.ok(Math.abs(cents(a) - (a * 1200) / table.table.length) <= 1);
    assert.ok(cents(t) - cents(a) > 150 && cents(fifth) - cents(t) > 100,
      `${edo} arto, tendo and the fifth are three distinct pitches`);
  }
  // a tuning with two pairs tells them apart in the menu by their just ratios
  const t = (k) => `«${k}»`;
  assert.equal(chordPresetLabel(chordPresetById("xc31-6-arto"), t),
    "«chord.preset.xc.arto» · 8/7·21/16");
  assert.equal(chordPresetLabel(chordPresetById("xc31-7-arto"), t),
    "«chord.preset.xc.arto» · 7/6·9/7");
  // …a tuning with one does not
  assert.equal(chordPresetLabel(chordPresetById("xc24-5-tendo"), t), "«chord.preset.xc.tendo»");
});

test("a degree-mode chord inverts only when it is handed the pitch table", () => {
  const P17 = pitchTablePresets[170];
  const cents = (id, inv, table) => applyChordPreset(id, inv, table).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, table) * 1200) / UNITS_PER_OCTAVE));
  // 24-TET's tendo triad is 0/450/700; its inversions put those on top in turn
  assert.deepEqual(cents("xc24-5-tendo", 0, P24), [0, 450, 700]);
  assert.deepEqual(cents("xc24-5-tendo", 1, P24), [450, 700, 1200]);
  assert.deepEqual(cents("xc24-5-tendo", 2, P24), [700, 1200, 1650]);
  assert.equal(maxInversion("xc24-5-tendo"), 2);
  // 17-TET's tendo third IS its fourth, and inverting still only moves notes
  assert.deepEqual(cents("xc17-3-tendo", 0, P17), [0, 494, 706]);
  assert.deepEqual(cents("xc17-3-tendo", 1, P17), [494, 706, 1200]);
  // With no table a degree is a bare count, so the chord stays put rather than
  // come out scrambled — the ji-mode presets are unaffected either way.
  assert.deepEqual(applyChordPreset("xc24-5-tendo", 2), applyChordPreset("xc24-5-tendo", 0));
  assert.deepEqual(applyChordPreset("major", 2, P24), applyChordPreset("major", 2));
  assert.deepEqual(invertVoiceSpecs([{ mode: "key", step: 0 }, { mode: "key", step: 9 }], 1),
    [{ mode: "key", step: 0 }, { mode: "key", step: 9 }]);
});

test("the vocabulary is grouped, named in both languages, and fits the slots", () => {
  const cents = (u) => Math.round((u * 1200) / UNITS_PER_OCTAVE);
  for (const p of CHORD_PRESETS) {
    assert.ok(CHORD_GROUPS.includes(p.group), `${p.id} is in a known group`);
    assert.ok(p.voices.length >= 2 && p.voices.length <= MAX_VOICES, `${p.id} fits six slots`);
    if (p.steps) {
      // A tetrachord is named by its step pattern, in any language (item 141).
      assert.match(p.steps, /^\d+-\d+-\d+$/, `${p.id} carries a step pattern`);
    } else {
      assert.ok(en[p.key], `${p.id} is named in en`);
      assert.ok(ko[p.key], `${p.id} is named in ko`);
    }
    // …and reads bottom to top, which is what makes a preset checkable by eye
    const table = p.edo !== undefined ? equalTable(p.edo)
      : p.notation === undefined ? P12 : pitchTablePresets[p.notation];
    const units = p.voices.map((v) => voiceUnits({ ...defaultVoice(), ...v }, table));
    for (let i = 1; i < units.length; i++) {
      assert.ok(units[i] > units[i - 1], `${p.id} voice ${i} is above voice ${i - 1}`);
    }
  }
  for (const g of CHORD_GROUPS) {
    assert.ok(CHORD_PRESETS.some((p) => p.group === g), `group ${g} has entries`);
    assert.ok(en[`chord.group.${g}`] && ko[`chord.group.${g}`], `group ${g} is named`);
  }
  for (let i = 0; i <= MAX_VOICES - 1; i++) {
    assert.ok(en[`chord.inv${i}`] && ko[`chord.inv${i}`], `inversion ${i} is named`);
  }

  // the added/extended chords put their upper degrees where the degree names
  // say they are: the 9th IS the major second an octave up, and so on
  const of = (id) => applyChordPreset(id).filter((v) => v.on).map((v) => cents(voiceUnits(v, P12)));
  assert.deepEqual(of("add9"), [0, 386, 702, 1404], "add9 = major triad + a ninth");
  assert.deepEqual(of("madd9"), [0, 316, 702, 1404]);
  assert.deepEqual(of("add11"), [0, 386, 702, 1698], "the eleventh is the fourth, up an octave");
  assert.deepEqual(of("six9"), [0, 386, 702, 884, 1404]);
  assert.deepEqual(of("dom13").slice(-1), [2084], "the thirteenth is the sixth, up an octave");
  assert.equal(of("dom13").length, 6, "…and it drops the eleventh to fit");
  assert.equal(of("dom11").length, 5);
  assert.ok(!of("dom11").includes(386), "the eleventh chord drops the third");
  // sus2/sus4 are the same fifth with the third moved either way
  assert.deepEqual(of("sus2"), [0, 204, 702]);
  assert.deepEqual(of("sus4"), [0, 498, 702]);
  // quartal is fourths all the way up: 4/3 then 4/3 of that (16/9)
  assert.deepEqual(of("quartal"), [0, 498, 996]);
});

test("inversions lift the lowest voices an octave and re-sort", () => {
  const cents = (id, inv, table = P12) => applyChordPreset(id, inv, table).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, table) * 1200) / UNITS_PER_OCTAVE));

  // the textbook case: a major triad's root goes on top, then its third
  assert.deepEqual(cents("major", 0), [0, 386, 702]);
  assert.deepEqual(cents("major", 1), [386, 702, 1200]);
  assert.deepEqual(cents("major", 2), [702, 1200, 1586]);
  // a seventh chord has three, and the highest one is the chord over its 7th
  assert.deepEqual(cents("dom7", 3), [969, 1200, 1586, 1902]);

  // every inversion keeps the same PITCH CLASSES — nothing is added or dropped
  for (const p of CHORD_PRESETS) {
    const table = p.edo !== undefined ? equalTable(p.edo)
      : p.notation === undefined ? P12 : pitchTablePresets[p.notation];
    const base = cents(p.id, 0, table);
    for (let inv = 1; inv <= maxInversion(p.id); inv++) {
      const got = cents(p.id, inv, table);
      assert.equal(got.length, base.length, `${p.id} inv ${inv} keeps its note count`);
      const mod = (xs) => xs.map((c) => ((c % 1200) + 1200) % 1200).sort((a, b) => a - b);
      assert.deepEqual(mod(got), mod(base), `${p.id} inv ${inv} keeps its notes`);
      for (let i = 1; i < got.length; i++) {
        assert.ok(got[i] > got[i - 1], `${p.id} inv ${inv} still reads bottom to top`);
      }
    }
  }

  // a chord that already owns its octave lifts PAST it rather than doubling a
  // note onto one it already has (which would only be a level change)
  assert.deepEqual(cents("power", 0), [0, 702, 1200]);
  assert.deepEqual(cents("power", 1), [702, 1200, 2400]);
  assert.deepEqual(cents("octaves", 1), [0, 1200, 2400]);

  // out of range clamps rather than wrapping: inverting EVERY note would just
  // be the chord an octave up, so the last real inversion is notes−1
  assert.equal(maxInversion("major"), 2);
  assert.equal(maxInversion("dom13"), 5);
  assert.equal(maxInversion("nonesuch"), 0);
  assert.equal(presetVoiceCount("dom13"), MAX_VOICES);
  assert.deepEqual(cents("major", 9), cents("major", 2));
  assert.deepEqual(cents("major", -3), cents("major", 0));

  // the specs themselves are untouched (the preset table is shared state)
  const before = JSON.stringify(CHORD_PRESETS.find((p) => p.id === "major").voices);
  invertVoiceSpecs(CHORD_PRESETS.find((p) => p.id === "major").voices, 2);
  assert.equal(JSON.stringify(CHORD_PRESETS.find((p) => p.id === "major").voices), before);

  // an inversion is a plain octave on the note, so it survives every mode
  const det = invertVoiceSpecs([{ mode: "ratio", ratio: 0.994 }, { mode: "ratio", ratio: 1 }], 1);
  assert.deepEqual(det, [{ mode: "ratio", ratio: 1 }, { mode: "ratio", ratio: 0.994, oct: 1 }]);
});

// ── the mix ────────────────────────────────────────────────────────────────

test("chordLength: the lowest voice sets the length, or the source, or the highest", () => {
  const vs = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "ji", ji: "1/1", oct: -1 })];
  assert.equal(chordLength(1000, vs, P12, "longest"), 2000, "an octave down runs twice as long");
  assert.equal(chordLength(1000, vs, P12, "source"), 1000);
  assert.equal(chordLength(1000, vs, P12, "shortest"), 1000, "…and the unison stops it there");
  const up = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "ji", ji: "2/1" })];
  assert.equal(chordLength(1000, up, P12, "longest"), 1000, "voices above unison never grow it");
  assert.equal(chordLength(1000, up, P12, "shortest"), 500, "an octave up runs out halfway");
  // the three modes bracket each other, whatever the chord
  const wide = [voice({ mode: "ji", ji: "1/1", oct: -2 }), voice({ mode: "ji", ji: "5/4" }),
    voice({ mode: "ji", ji: "3/2", oct: 1 })];
  const shortest = chordLength(1000, wide, P12, "shortest");
  const longest = chordLength(1000, wide, P12, "longest");
  assert.ok(shortest < 1000 && longest === 4000 && shortest < longest);
  assert.equal(shortest, Math.floor(1000 / 3), "the top voice is a fifth up an octave");
  for (const mode of ["longest", "source", "shortest"]) {
    assert.equal(chordLength(1000, [], P12, mode), 1000, `no voices: source length (${mode})`);
  }
  // …and the built mix really is that long, every note still sounding at the end
  const buf = sine(1000, 8);
  assert.equal(buildChord(buf, wide, P12, { lengthMode: "shortest" }).data.length, shortest);
  assert.equal(buildChord(buf, wide, P12, { lengthMode: "longest" }).data.length, longest);
});

test("buildChord mixes pitch-shifted copies; unison is the source itself", () => {
  const src = sine(4096, 8);
  const solo = buildChord(src, [voice({ mode: "ji", ji: "1/1" })], P12, { normalise: false });
  assert.equal(solo.voices, 1);
  assert.equal(solo.data.length, src.length);
  for (let i = 0; i < src.length; i++) {
    assert.ok(Math.abs(solo.data[i] - src[i]) < 1e-7, "unison passes through untouched");
  }

  // an octave up is the same wave at half the length, so a zero crossing of
  // the source at frame 2i lands at frame i
  const up = buildChord(src, [voice({ mode: "ji", ji: "2/1" })], P12,
    { normalise: false, lengthMode: "source" });
  assert.equal(up.data.length, src.length, "source length keeps the frames");
  for (let i = 100; i < 1900; i += 97) {
    assert.ok(Math.abs(up.data[i] - src[2 * i]) < 0.02, `octave-up frame ${i}`);
  }
  assert.ok(up.data.slice(2048).every((v) => v === 0), "the tail past the copy is silence");
});

test("buildChord: gains, peak reporting and normalisation", () => {
  const src = sine(2048, 4);
  const two = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "ji", ji: "1/1" })];
  const raw = buildChord(src, two, P12, { normalise: false });
  assert.ok(Math.abs(raw.peak - 1.0) < 1e-3, "two copies at unity double the peak");
  assert.ok(Math.abs(Math.max(...raw.data) - 1.0) < 1e-3, "not normalised");

  const norm = buildChord(src, two, P12, { normalise: true });
  assert.ok(Math.abs(norm.peak - 1.0) < 1e-3, "peak reports the PRE-normalise level");
  let mx = 0;
  for (const v of norm.data) mx = Math.max(mx, Math.abs(v));
  assert.ok(Math.abs(mx - 1.0) < 1e-6, "normalised to full scale");

  // −6 dB halves a note: one at unity + one at −6 dB peaks at 1.5×
  const ducked = buildChord(src, [two[0], { ...two[1], gainDb: -6.0206 }], P12, { normalise: false });
  assert.ok(Math.abs(ducked.peak - 0.75) < 2e-3, `peak ${ducked.peak}`);

  assert.equal(buildChord(src, [], P12).data.length, 0, "no voices: nothing to mix");
  assert.equal(buildChord(src, [{ ...voice({}), on: false }], P12).voices, 0);
});

test("buildChord is deterministic and notation-aware", () => {
  const src = sine(3000, 5);
  const vs = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "key", step: 7 }),
              voice({ mode: "units", units: 0x100 }), voice({ mode: "ratio", ratio: 1.9632 })];
  const a = buildChord(src, vs, P12);
  const b = buildChord(src, vs, P12);
  assert.deepEqual([...a.data], [...b.data], "same inputs, same bytes");

  // the SAME note list retunes with the song: step 7 is a fifth in 12-TET and
  // a quarter-tone-flat fourth in 24-TET, so the mixes differ
  const c = buildChord(src, vs, P24);
  assert.notDeepEqual([...a.data], [...c.data]);
  assert.equal(voiceUnits(vs[1], P24), P24.table[7]);
});
