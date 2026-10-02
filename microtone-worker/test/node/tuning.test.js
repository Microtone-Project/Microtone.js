// Song tuning (item 77) — terranmon.txt:3297-3324 + §"Note Tuning".
//
// The song table declares "note `baseNote` sounds at `freq` Hz". Until item 77
// the engine ignored the pair entirely and the fields were a cosmetic option;
// now they scale every note the playhead sounds.
//
// The zero point is 12-TET concert C4. That is a deliberate choice with a
// consequence worth stating plainly: the TRACKER DEFAULT (C9 @ 8363) is NOT
// concert — it puts A4 at ~439.53 Hz, ~1.87 cents flat of 440, which is what a
// real Amiga does and what the spec means by "tracker default tuning at A4 is
// 439.548 Hz". So a default-declaring song renders 1.87 cents flat ON PURPOSE.
//
// The expected frequencies below are written as independent arithmetic (a
// frequency divided by concert A4, or a hand-checked Hz figure), NOT re-derived
// through tuningRatioOf — a bug in the function must fail this file rather than
// agree with itself.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { tuningRatioOf } from "../../core/engine/tables.js";
import {
  TUNING_REF_C4_HZ, TUNING_DEFAULT_BASE_NOTE, TUNING_DEFAULT_FREQ_HZ, MIDDLE_C,
} from "../../core/engine/constants.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { Document } from "../../src/doc/document.js";

const A4 = 0x5c00; // spec: "A4 (western default) is 0x5C00"
const C9 = 0xa000; // spec: "C9 (tracker default) is 0xA000"
const cents = (ratio) => 1200 * Math.log2(ratio);

test("A4 = 0x5C00 and C9 = 0xA000 really are those notes", () => {
  // 0x1000 per octave, C4 = 0x5000. A4 is 9 semitones up; C9 is 5 octaves up.
  assert.equal(A4 - MIDDLE_C, Math.round((9 / 12) * 4096));
  assert.equal(C9 - MIDDLE_C, 5 * 4096);
});

test("concert A4 = 440 is EXACTLY 1.0 — an identity multiply", () => {
  // Load-bearing, not incidental: 440 is f32-representable and 440/2**0.75 is
  // bit-identical to the concert-C4 literal, so `rate * ratio === rate`. This
  // is what lets a concert-declared song render without a bit disturbed.
  const r = tuningRatioOf(A4, 440);
  assert.ok(Object.is(r, 1.0), `expected exactly 1.0, got ${r}`);
  assert.equal(440 / 2 ** 0.75, TUNING_REF_C4_HZ);
  const rate = 1.2345678901234567;
  assert.ok(Object.is(rate * r, rate), "identity multiply must not perturb a rate");
});

test("spec step 1 worked example: A4/440 folds to C4/261.6255653", () => {
  // "If the values are A4,440Hz, it will be converted to C4,261.6255653Hz".
  const c4 = tuningRatioOf(A4, 440) * TUNING_REF_C4_HZ;
  assert.ok(Math.abs(c4 - 261.6255653) < 1e-6, `C4 = ${c4}`);
});

test("the tracker default is 1.87 cents FLAT of concert, not equal to it", () => {
  const r = tuningRatioOf(C9, 8363);
  assert.ok(r < 1, "tracker default must be flat of concert");
  assert.ok(Math.abs(cents(r) - -1.8658) < 1e-3, `${cents(r)} cents`);

  // Cross-check against the spec's own reference figure for the same tuning:
  // "tracker default tuning at A4 is 439.548 Hz ((3579545/428)*2^(3/4) / 32)".
  // We land 0.09 cents below it because the format stores the ROUNDED 8363.0
  // rather than the exact NTSC clock ratio 3579545/428 = 8363.42 Hz.
  const a4Hz = r * TUNING_REF_C4_HZ * 2 ** 0.75;
  const specA4 = (3579545 / 428) * 2 ** 0.75 / 32;
  assert.ok(Math.abs(specA4 - 439.548) < 1e-3, `spec formula = ${specA4}`);
  assert.ok(Math.abs(a4Hz - 439.526) < 1e-3, `field-default A4 = ${a4Hz}`);
  assert.ok(Math.abs(cents(a4Hz / specA4)) < 0.1, "within 0.1 cents of the spec figure");
});

test("zero fields mean the tracker default (spec: 'If zero, assume the tracker default')", () => {
  const dflt = tuningRatioOf(C9, 8363);
  assert.equal(TUNING_DEFAULT_BASE_NOTE, C9);
  assert.equal(TUNING_DEFAULT_FREQ_HZ, 8363.0);
  assert.equal(tuningRatioOf(0, 0), dflt, "blank song table");
  assert.equal(tuningRatioOf(0, 8363), dflt, "zero base note only");
  assert.equal(tuningRatioOf(C9, 0), dflt, "zero frequency only");
  // Malformed values must not silence or NaN the song.
  assert.equal(tuningRatioOf(C9, NaN), dflt, "NaN frequency");
  assert.equal(tuningRatioOf(C9, -440), dflt, "negative frequency");
});

test("the spec's Known standard tunings land on their real pitches", () => {
  // Expected values derived independently: ratio = requested A4 / concert A4
  // for the A4 rows; for the C4 rows, requested C4 / concert C4.
  const vectors = [
    ["A4 @ 440 ISO standard", A4, 440, 440 / 440],
    ["A4 @ 435 French 1859", A4, 435, 435 / 440],
    ["A4 @ 452 Old Philharmonic", A4, 452, 452 / 440],
    ["C4 @ 256 power of two", MIDDLE_C, 256, 256 / 261.6255653005986],
    ["C4 @ 262 Chinese a-ak", MIDDLE_C, 262, 262 / 261.6255653005986],
    ["C4 @ 311 Korean hyang-ak", MIDDLE_C, 311, 311 / 261.6255653005986],
  ];
  for (const [label, base, freq, expected] of vectors) {
    const r = tuningRatioOf(base, freq);
    assert.ok(Math.abs(r - expected) < 1e-12, `${label}: ratio ${r} vs ${expected}`);
  }
  // The user's motivating examples, stated as audible intervals.
  assert.ok(Math.abs(cents(tuningRatioOf(MIDDLE_C, 256)) - -37.631) < 1e-2, "C4@256 ≈ -37.6c");
  assert.ok(Math.abs(cents(tuningRatioOf(A4, 412)) - -113.831) < 1e-2, "A4@412 ≈ -113.8c");
});

test("a declared tuning is exact: asking for A4 = 412 really sounds 412 Hz", () => {
  // The whole point of the item. Concert-zero makes the request literal.
  const a4Hz = tuningRatioOf(A4, 412) * TUNING_REF_C4_HZ * 2 ** 0.75;
  assert.ok(Math.abs(a4Hz - 412) < 1e-9, `A4 = ${a4Hz}, asked for 412`);
  const c4Hz = tuningRatioOf(MIDDLE_C, 256) * TUNING_REF_C4_HZ;
  assert.ok(Math.abs(c4Hz - 256) < 1e-9, `C4 = ${c4Hz}, asked for 256`);
});

test("the pair is redundant: any note declaring the same pitch gives the same ratio", () => {
  // A4@440, C4@261.6255653 and C9@8372.018 all describe one tuning.
  const viaA4 = tuningRatioOf(A4, 440);
  const viaC4 = tuningRatioOf(MIDDLE_C, TUNING_REF_C4_HZ);
  const viaC9 = tuningRatioOf(C9, TUNING_REF_C4_HZ * 32);
  assert.ok(Math.abs(viaC4 - viaA4) < 1e-12);
  assert.ok(Math.abs(viaC9 - viaA4) < 1e-12);
});

test("engine: setTuning drives the playhead, zero fields resolve to the default", () => {
  const eng = new TaudEngine();
  // Untuned until a song load pushes a pair — the engine has no song table.
  assert.equal(eng.getTuningRatio(0), 1.0);

  eng.setTuning(0, A4, 440);
  assert.ok(Object.is(eng.getTuningRatio(0), 1.0), "concert is identity");

  eng.setTuning(0, A4, 412);
  assert.ok(Math.abs(cents(eng.getTuningRatio(0)) - -113.831) < 1e-2);

  eng.setTuning(0, 0, 0);
  assert.equal(eng.getTuningRatio(0), tuningRatioOf(C9, 8363), "zero pair → tracker default");

  // Per-playhead, like bpm — playhead 1 must be untouched.
  assert.equal(eng.getTuningRatio(1), 1.0);

  eng.resetParams(0);
  assert.equal(eng.getTuningRatio(0), 1.0, "resetParams returns to untuned");
});

test("a corpus song loads its declared tuning (all corpus declares the default)", async () => {
  const doc = parseTaud(await readFile(new URL("../corpus/WHEN.taud", import.meta.url)));
  assert.equal(doc.songs[0].tuningBaseNote, C9, "corpus declares the tracker default");
  assert.equal(doc.songs[0].tuningFreq, 8363);

  const eng = new TaudEngine();
  loadIntoEngine(eng, doc, 0);
  // loadIntoEngine must push the tuning — the conformance + WAV paths share it,
  // so a miss here would render files that disagree with live playback.
  assert.equal(eng.getTuningRatio(0), tuningRatioOf(C9, 8363));
  assert.ok(Math.abs(cents(eng.getTuningRatio(0)) - -1.8658) < 1e-3,
    "a default-declaring song renders 1.87 cents flat, on purpose");
});

test("tuning scales the sounding rate by exactly the ratio", async () => {
  // End-to-end through the real trigger path: the same note under two tunings
  // must differ in playback rate by precisely the ratio of the two tunings.
  const doc = parseTaud(await readFile(new URL("../corpus/WHEN.taud", import.meta.url)));
  const rateFor = (baseNote, freq) => {
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    eng.setTuning(0, baseNote, freq);
    eng.jamNote(0, 0, 0x5000, 1);
    return eng.playheads[0].trackerState.voices[0].playbackRate;
  };
  const concert = rateFor(A4, 440);
  assert.ok(concert > 0, "the jam must actually sound");
  for (const [base, freq] of [[A4, 412], [MIDDLE_C, 256], [C9, 8363], [A4, 452]]) {
    const got = rateFor(base, freq);
    const want = concert * tuningRatioOf(base, freq);
    assert.ok(Math.abs(got - want) < 1e-12, `${base.toString(16)}@${freq}: ${got} vs ${want}`);
  }
});

test("an EXPORT sees the song's tuning, not the tracker default", async () => {
  // toRenderable() is what WAV and stem export render from. It used to drop the
  // tuning pair, so an exported file came out ~2 cents off what playback had
  // just sounded (and much further off for a genuinely retuned song).
  const doc = new Document(parseTaud(await readFile(new URL("../corpus/WHEN.taud", import.meta.url))));
  doc.songs[0].tuningBaseNote = A4;
  doc.songs[0].tuningFreq = 415; // baroque-ish, 101.27 cents down: audible, not subtle

  const eng = new TaudEngine();
  loadIntoEngine(eng, doc.toRenderable(0), 0);
  assert.equal(eng.getTuningRatio(0), tuningRatioOf(A4, 415));
  assert.ok(Math.abs(cents(eng.getTuningRatio(0)) - -101.2706) < 1e-3);

  // …and it reaches the sounding voice, not just the readback.
  eng.jamNote(0, 0, 0x5000, 1);
  const tuned = eng.playheads[0].trackerState.voices[0].playbackRate;
  const plain = new TaudEngine();
  loadIntoEngine(plain, doc.toRenderable(0), 0);
  plain.setTuning(0, A4, 440);
  plain.jamNote(0, 0, 0x5000, 1);
  const concert = plain.playheads[0].trackerState.voices[0].playbackRate;
  assert.ok(Math.abs(tuned - concert * tuningRatioOf(A4, 415)) < 1e-12);
});
