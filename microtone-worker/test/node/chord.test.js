// Chord maker core (item 89) — the pitch-offset algebra behind the four note
// modes, degree counting against real pitch tables, and the mix itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JI_INTERVALS, CHORD_GROUPS, CHORD_PRESETS, MAX_UNITS, MAX_VOICES, UNITS_PER_OCTAVE,
  applyChordPreset, buildChord, chordLength, chordPresetLabel, chordPresetsFor,
  defaultVoice, defaultVoices, degreeUnits, invertVoiceSpecs, jiById,
  chordPresetById, maxInversion, presetVoiceCount, voiceNote, voiceRatio, voiceUnits,
} from "../../src/doc/chord.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";
import { pitchTablePresets, gridDelta } from "../../src/ui/pitchtables.js";
import { MIDDLE_C } from "../../src/engine/constants.js";

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
  const ids = (index) => new Set(chordPresetsFor({ index }).map((p) => p.id));
  const plain = CHORD_PRESETS.filter((p) => p.notation === undefined);
  assert.equal(chordPresetsFor({ index: 120 }).length, plain.length,
    "12-TET sees the tuning-independent vocabulary and nothing else");
  assert.equal(chordPresetsFor(null).length, plain.length, "…as does no notation at all");
  const xc = (index) => CHORD_PRESETS.filter((p) => p.notation === index && !p.steps).length;
  assert.equal(ids(170).size, plain.length + 15 + xc(170));
  assert.equal(ids(220).size, plain.length + 28 + xc(220));
  assert.equal(ids(310).size, plain.length + 66 + xc(310));
  assert.equal(xc(220), 14, "22-TET has both families on its menu");
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

// ── neutral harmony (item 167, follow-up) ──────────────────────────────────

const NT_NOTATIONS = [...new Set(CHORD_PRESETS.filter((p) => p.group === "neutral")
  .map((p) => p.notation))];

test("a neutral third is half the fifth, inside the wiki's 341-361 ¢ band", () => {
  // The tunings that can spell one, and the third(s) each spells. 53-TET's
  // fifth is an odd number of steps, so it cannot halve it — the two degrees
  // either side are the wiki's artoneutral (11/9) and tendoneutral (16/13).
  const expected = { 170: [5], 240: [7], 310: [9], 410: [12],
    530: [15, 16], 531: [15, 16], 960: [28] };
  assert.deepEqual(NT_NOTATIONS.slice().sort((a, b) => a - b),
    Object.keys(expected).map(Number).sort((a, b) => a - b));
  for (const [notation, want] of Object.entries(expected)) {
    const edo = pitchTablePresets[notation].table.length;
    const { fifth } = diatonic(edo);
    const triads = CHORD_PRESETS
      .filter((p) => p.notation === Number(notation) && p.id.endsWith("-neutral"));
    assert.deepEqual(triads.map((p) => p.voices[1].step), want, `${notation} thirds`);
    const centre = (fifth * 1200) / (2 * edo);
    assert.ok(centre >= 341 && centre <= 361, `${notation} halves its fifth into the band`);
    for (const p of triads) {
      const n3 = p.voices[1].step;
      assert.deepEqual(p.voices.map((v) => v.step), [0, n3, fifth], `${p.id} is root/third/fifth`);
      // it IS the degree nearest half the fifth — latitude 0, the centre of
      // the category rather than a side of it
      assert.ok(Math.abs(n3 - fifth / 2) <= 0.5, `${notation}/${n3} halves the fifth`);
      // …and a tuning only gets the split when both halves still read neutral
      assert.ok(Math.abs((n3 * 1200) / edo - centre) <= 15, `${notation}/${n3} stays neutral`);
    }
    assert.equal(triads.length, fifth % 2 === 0 ? 1 : 2,
      `${notation} splits its third only when the fifth is odd`);
  }
  // 12-TET halves its fifth at exactly 350 ¢ but cannot SPELL it: the nearest
  // degrees are its plain major and minor thirds, 50 ¢ either side.
  assert.equal((diatonic(12).fifth * 1200) / 24, 350);
  for (const index of [120, 150, 160, 190, 220, 0, 1, 35130]) {
    assert.ok(!chordPresetsFor({ index }).some((p) => p.group === "neutral"),
      `notation ${index} cannot spell a neutral third`);
  }
});

test("the neutral ladder stacks and inverts like the arto/tendo one", () => {
  const JI = { n3: 350.978, n7: 1049.363, n6: 852.592, n2: 150.637 };
  for (const notation of NT_NOTATIONS) {
    const edo = pitchTablePresets[notation].table.length;
    const { fifth } = diatonic(edo);
    for (const triad of CHORD_PRESETS
      .filter((p) => p.notation === notation && p.id.endsWith("-neutral"))) {
      const n3 = triad.voices[1].step;
      const deg = (shape) => CHORD_PRESETS
        .find((p) => p.id === `nt${notation}-${n3}-${shape}`)?.voices.map((v) => v.step);
      const n7 = fifth + n3, n6 = edo - n3, n2 = edo - n7;
      assert.deepEqual(deg("neutral7"), [0, n3, fifth, n7], `${notation}/${n3} 7th`);
      assert.deepEqual(deg("neutral6"), [0, n3, fifth, n6]);
      assert.deepEqual(deg("neutraladd9"), [0, n3, fifth, edo + n2]);
      assert.deepEqual(deg("neutral9"), [0, n3, fifth, n7, edo + n2]);
      // the chain is the fifth halved, then its own fifth halved again
      assert.deepEqual(deg("neutralchain"), [0, n3, fifth, n7, 2 * fifth]);
      // every rung lands on the just interval the wiki names for it
      const cents = (d) => (d * 1200) / edo;
      for (const [name, d] of [["n3", n3], ["n7", n7], ["n6", n6], ["n2", n2]]) {
        assert.ok(Math.abs(cents(d) - JI[name]) <= 15,
          `${notation}/${n3} ${name} is ${Math.round(cents(d))} ¢, near ${Math.round(JI[name])} ¢`);
      }
      // the two mixed sevenths are the tuning's OWN, and the neutral seventh
      // is what they sit either side of
      const { L, s } = diatonic(edo);
      assert.deepEqual(deg("neutralmin7"), [0, n3, fifth, 4 * L + 2 * s]);
      assert.deepEqual(deg("neutralmaj7"), [0, n3, fifth, 5 * L + s]);
      assert.ok(4 * L + 2 * s < n7 && n7 < 5 * L + s,
        `${notation}/${n3} neutral 7th sits between minor and major`);
    }
  }
});

test("neutral chords are their own group, tuning-locked and named", () => {
  assert.ok(CHORD_GROUPS.includes("neutral"));
  assert.ok(CHORD_GROUPS.indexOf("neutral") < CHORD_GROUPS.indexOf("extraclassical"),
    "between major and minor comes before outside them");
  assert.ok(en["chord.group.neutral"] && ko["chord.group.neutral"]);
  const all = CHORD_PRESETS.filter((p) => p.group === "neutral");
  assert.equal(all.length, 72);
  for (const p of all) {
    assert.ok(en[p.key] && ko[p.key], `${p.id} is named in both languages`);
    assert.ok(p.voices.every((v) => v.mode === "key"), `${p.id} counts degrees`);
    assert.ok(!chordPresetsFor({ index: 120 }).includes(p), `${p.id} stays out of 12-TET`);
  }
  // 53-TET names its two by the just thirds they temper, the rest need no tag
  const t = (k) => `«${k}»`;
  assert.equal(chordPresetLabel(chordPresetById("nt530-15-neutral"), t),
    "«chord.preset.nt.neutral» · 11/9");
  assert.equal(chordPresetLabel(chordPresetById("nt530-16-neutral"), t),
    "«chord.preset.nt.neutral» · 16/13");
  assert.equal(chordPresetLabel(chordPresetById("nt240-7-neutral"), t),
    "«chord.preset.nt.neutral»");
  // a neutral triad inverts like any other voicing
  const cents = (id, inv) => applyChordPreset(id, inv, P24).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, P24) * 1200) / UNITS_PER_OCTAVE));
  assert.deepEqual(cents("nt240-7-neutral", 0), [0, 350, 700]);
  assert.deepEqual(cents("nt240-7-neutral", 1), [350, 700, 1200]);
  // …and 24-TET's neutral third really is half its fifth, to the cent
  assert.equal(cents("nt240-7-neutral", 0)[1] * 2, cents("nt240-7-neutral", 0)[2]);
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

/** The pairs each notation offers, read back off its own presets. */
function extraclassicalPairs(notation) {
  const of = (shape) => CHORD_PRESETS
    .filter((p) => p.notation === notation && p.id.endsWith(`-${shape}`) && !p.steps)
    .map((p) => p.voices.map((v) => v.step));
  const artos = of("arto"), tendos = of("tendo");
  assert.equal(artos.length, tendos.length, `${notation} pairs arto with tendo`);
  return artos.map(([, a, fifth], i) => ({ a, t: tendos[i][1], fifth }));
}

const XC_NOTATIONS = [...new Set(CHORD_PRESETS.filter((p) => p.group === "extraclassical")
  .map((p) => p.notation))];

test("every arto/tendo pair is one the Xenharmonic Wiki recognises", () => {
  // The tunings, and the pairs each one gets. 31/41/96 have more than one:
  // reproduced below from latitude and from quality arithmetic independently.
  const expected = {
    150: [[3, 6]], 160: [[3, 6]], 170: [[3, 7]], 190: [[4, 7]],
    220: [[5, 8]], 240: [[5, 9]],
    310: [[6, 12], [7, 11]], 410: [[8, 16], [9, 15]],
    530: [[11, 20]], 531: [[11, 20]],
    960: [[19, 37], [20, 36], [21, 35]],
  };
  assert.deepEqual(XC_NOTATIONS.slice().sort((a, b) => a - b),
    Object.keys(expected).map(Number).sort((a, b) => a - b));
  for (const [notation, want] of Object.entries(expected)) {
    const edo = pitchTablePresets[notation].table.length;
    const { fifth, L, s, half, proper } = diatonic(edo);
    const got = extraclassicalPairs(Number(notation));
    assert.deepEqual(got.map((p) => [p.a, p.t]), want, `${notation} pairs`);
    for (const p of got) {
      assert.equal(p.fifth, fifth, `${notation} stands on its own best fifth`);
      // Every pair is symmetric about the middle of the fifth…
      assert.equal(p.a + p.t, fifth, `${notation} ${p.a}/${p.t} is a latitude pair`);
      const lat = -latitude(p.a, fifth);
      // …and is EITHER wide enough to sound extraclassical, OR the one the
      // tuning's own notation spells with a demiflat and a demisharp.
      const byEar = lat >= 22.5 - LAT_EPS && lat <= 30 + LAT_EPS;
      const spelt = half !== null && p.a === L + s - half && p.t === 2 * L + half;
      // …OR the tuning's own thirds, dragged out there by a superpyth fifth.
      const native = proper && (fifth * 1200) / edo >= SUPERPYTH_FIFTH - LAT_EPS
        && p.a === L + s && p.t === 2 * L;
      assert.ok(byEar || spelt || native,
        `${notation} ${p.a}/${p.t} is arto/tendo by ear (${lat.toFixed(1)}°), ` +
        "by spelling, or by a superpyth fifth");
    }
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
  assert.equal(extraclassicalPairs(170)[0].t, diatonic(17).fifth - 3);
  // …while 12-TET has none of the three, so it is offered nothing.
  for (const index of [120, 190 + 1, 0, 1, 35130]) {
    assert.ok(!chordPresetsFor({ index }).some((p) => p.group === "extraclassical"),
      `notation ${index} has no arto/tendo pair`);
  }
});

test("the arto/tendo ladder is the pair stacked on the fifth, then inverted", () => {
  // The wiki tabulates a ladder; we derive one from the pair and the fifth
  //   arto/tendo seventh = fifth + arto/tendo third
  //   tendo second = octave − arto seventh, tendo sixth = octave − arto third
  // and these are the identities that make the derivation legal.
  for (const notation of XC_NOTATIONS) {
    const edo = pitchTablePresets[notation].table.length;
    for (const { a, t, fifth } of extraclassicalPairs(notation)) {
      const deg = (shape) => CHORD_PRESETS
        .find((p) => p.id === `xc${notation}-${a}-${shape}`)?.voices.map((v) => v.step);
      const a7 = fifth + a, t7 = fifth + t, t2 = edo - a7, t6 = edo - a;
      assert.deepEqual(deg("arto7"), [0, a, fifth, a7], `${notation}/${a} arto 7th`);
      if (t7 % edo !== 0) {
        assert.deepEqual(deg("tendo7"), [0, t, fifth, t7], `${notation}/${a} tendo 7th`);
        assert.deepEqual(deg("artotendo7"), [0, a, fifth, t7]);
      } else {
        assert.equal(deg("tendo7"), undefined, `${notation}/${a} tendo 7th IS the octave`);
      }
      assert.deepEqual(deg("tendodom7"), [0, t, fifth, a7]);
      assert.deepEqual(deg("tendoadd9"), [0, t, fifth, edo + t2]);
      // A sixth chord only appears where the sixth is not already the seventh,
      // which is exactly when the fourth is twice the arto third.
      if (edo - fifth === 2 * a) assert.equal(deg("arto6"), undefined, `${notation}/${a} 6 = 7`);
      else assert.deepEqual(deg("arto6"), [0, a, fifth, t6]);
      // The equal-stepped six-note chain belongs to the pairs that trisect
      // the fifth — the slendric generator, three of them making a fifth.
      const chain = deg("chain");
      if (fifth % 3 === 0 && a === fifth / 3 && t7 % edo !== 0) {
        assert.deepEqual(chain, [0, a, 2 * a, 3 * a, 4 * a, 5 * a], `${notation} slendric chain`);
      } else {
        assert.equal(chain, undefined, `${notation}/${a} has no equal chain`);
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
    assert.ok(extraclassicalPairs(edo * 10)
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
  for (const notation of XC_NOTATIONS) {
    const table = pitchTablePresets[notation];
    const mine = chordPresetsFor({ index: notation }).filter((p) => p.group === "extraclassical");
    assert.ok(mine.length >= 9, `${notation} offers a vocabulary (${mine.length})`);
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
      assert.ok(!chordPresetsFor({ index: 120 }).includes(p), `${p.id} stays out of 12-TET`);
    }
    // the pair's own triads really are the tuning's degrees, in cents
    const [{ a, t, fifth }] = extraclassicalPairs(notation);
    const cents = (d) => Math.round((voiceUnits({ ...defaultVoice(), mode: "key", step: d }, table)
      * 1200) / UNITS_PER_OCTAVE);
    assert.equal(cents(a), Math.round((a * 1200) / table.table.length));
    assert.ok(cents(t) - cents(a) > 150 && cents(fifth) - cents(t) > 100,
      `${notation} arto, tendo and the fifth are three distinct pitches`);
  }
  // a tuning with two pairs tells them apart in the menu by their just ratios
  const t = (k) => `«${k}»`;
  assert.equal(chordPresetLabel(chordPresetById("xc310-6-arto"), t),
    "«chord.preset.xc.arto» · 8/7·21/16");
  assert.equal(chordPresetLabel(chordPresetById("xc310-7-arto"), t),
    "«chord.preset.xc.arto» · 7/6·9/7");
  // …a tuning with one does not
  assert.equal(chordPresetLabel(chordPresetById("xc240-5-tendo"), t), "«chord.preset.xc.tendo»");
});

test("a degree-mode chord inverts only when it is handed the pitch table", () => {
  const P17 = pitchTablePresets[170];
  const cents = (id, inv, table) => applyChordPreset(id, inv, table).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, table) * 1200) / UNITS_PER_OCTAVE));
  // 24-TET's tendo triad is 0/450/700; its inversions put those on top in turn
  assert.deepEqual(cents("xc240-5-tendo", 0, P24), [0, 450, 700]);
  assert.deepEqual(cents("xc240-5-tendo", 1, P24), [450, 700, 1200]);
  assert.deepEqual(cents("xc240-5-tendo", 2, P24), [700, 1200, 1650]);
  assert.equal(maxInversion("xc240-5-tendo"), 2);
  // 17-TET's tendo third IS its fourth, and inverting still only moves notes
  assert.deepEqual(cents("xc170-3-tendo", 0, P17), [0, 494, 706]);
  assert.deepEqual(cents("xc170-3-tendo", 1, P17), [494, 706, 1200]);
  // With no table a degree is a bare count, so the chord stays put rather than
  // come out scrambled — the ji-mode presets are unaffected either way.
  assert.deepEqual(applyChordPreset("xc240-5-tendo", 2), applyChordPreset("xc240-5-tendo", 0));
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
    const table = p.notation === undefined ? P12 : pitchTablePresets[p.notation];
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
    const table = p.notation === undefined ? P12 : pitchTablePresets[p.notation];
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
