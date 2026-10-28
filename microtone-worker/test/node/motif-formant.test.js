// Motif (item 231): formant instruments written in TML — the syllable as IPA
// (syl_ipa) or X-SAMPA (syl_sampa), the tract block's fields one by one, and
// the source the vowel is sung with (a waveform cycle, or an OPL/PSG chip).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProject, interpret } from "../../src/motif/build.js";
import { readIpaSyllable, xsampaToIpa } from "../../src/motif/syllable.js";
import { MotifError } from "../../src/motif/lexer.js";
import { formantSyllable, nearestVowelMark, FORMANT_RANGE_NONE } from "../../src/doc/formantedit.js";
import { FormantPatch, CONSONANT_LIST, SEMIVOWELS } from "../../core/engine/formant.js";
import { LINEAR_FREQ_C4_HZ, TRACKER_CHUNK } from "../../core/engine/constants.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { mulberry32 } from "../../src/motif/stdlib.js";

const SONG = `tml 2
song { title: "Voices", bars: 2, bar_rows: 16, tuning: "12-TET" }
instrument BUZZ { psg: { a: { waveform: "saw" } } }
instrument KA   { formant: { syl_ipa: "kʰa" } }
instrument TONK { formant: { syl_ipa: "[tɔ̃k̚]", source: "square" }, envelope: [[0, 63], [1, 40]], nna: "fade" }
instrument HUM  { formant: { syl_sampa: "N=", source: BUZZ } }
instrument RAW  { formant: {
  onset: ["s", { consonant: "t", tilt: -20, gain: -3 }], coda: "n", vowel: [255, 0, 0], round: 90,
  glide: "w", nasalised: true, r_coloured: true, secondary: "palatalised", coda_release: "glottalised",
  size_follows_pitch: 0.5, consonant_length: 2, vowel_glide: 80, reference: 'A2',
} }
instrument CHOIR { layers: [{ inst: KA }, { inst: HUM, gain: -6 }] }
lane a { inst: KA }
lane b { inst: TONK }
lane c { inst: HUM }
lane d { inst: RAW }
lane e { inst: CHOIR }
hit(a, 0, 'C4', 50)
hit(b, 2, 'E4', 50)
hit(c, 4, 'C3', 50)
hit(d, 6, 'G3', 50)
hit(e, 8, 'C4', 50)
`;

test("formant instruments are written as the Formant tab would write them", async () => {
  const { doc, score } = await buildProject(SONG, {});
  const I = Object.fromEntries(score.instruments.map((i) => [i.id, i.slot]));
  // reloaded from the saved bytes: what a file says, not what the build held
  const back = new Document(parseTaud(await doc.toSaveBytes(3)));
  back._rebuildInstRegion();
  const f = (id) => back.instruments[I[id]];
  for (const id of ["KA", "TONK", "HUM", "RAW"]) assert.ok(f(id).isFormant, `${id} is a formant instrument`);

  const ka = f("KA");
  assert.deepEqual(ka.formant.slots.map((s) => s.cons), [16, 0, 0], "[kʰ], no coda");
  assert.deepEqual([ka.formant.front, ka.formant.open, ka.formant.round], [255, 255, 0], "[a]");
  assert.equal(ka.formant.refNote, 0x4000, "sung unscaled at C3");
  assert.equal(formantSyllable(ka), "kʰa");
  // its source: one cycle of a saw, 128 frames, its rate at C4 middle C's
  assert.equal(ka.sampleLength, 128);
  assert.equal(ka.samplingRate, Math.round(LINEAR_FREQ_C4_HZ * 128));
  assert.equal(ka.formant.srcPtr, ka.samplePtr);
  assert.deepEqual([ka.formant.rangeLo, ka.formant.rangeHi], [ka.samplePtr, ka.samplePtr + 128], "made from its own cycle");
  assert.equal(back.instRecordBytes(I.KA)[186] & 3, 0, "note off, as a new formant instrument has");

  const tonk = f("TONK");
  assert.equal(formantSyllable(tonk), "tɔ̃k̚");
  assert.notEqual(tonk.samplePtr, ka.samplePtr, "a square is another cycle");
  assert.equal(tonk.volEnvelopes[0].value, 63, "TONK carries its envelope");
  assert.equal(back.instRecordBytes(I.TONK)[186] & 3, 3, "nna fade");

  const hum = f("HUM");
  assert.equal(formantSyllable(hum), "ŋ̍", "a syllable with no vowel holds its [ŋ]");
  assert.equal(hum.formant.refNote, 0);
  assert.equal(hum.formant.srcInst, I.BUZZ, "sung from the PSG instrument");
  assert.equal(hum.sampleLength, 0, "…and from nothing in the pool");
  assert.deepEqual([hum.formant.rangeLo, hum.formant.rangeHi], [FORMANT_RANGE_NONE, FORMANT_RANGE_NONE]);

  const raw = f("RAW").formant;
  assert.deepEqual(raw.slots.map((s) => [s.cons, s.tilt, s.gain]), [[54, 0, 0], [3, -20, raw.slots[1].gain], [34, 0, 0]]);
  assert.ok(raw.slots[1].gain > 0 && raw.slots[1].gain < 0x9f, "−3 dB as a decibel octet");
  assert.deepEqual([raw.front, raw.open, raw.round], [255, 0, 90], "the vowel's numbers, round given on its own");
  assert.deepEqual([raw.semivowel, raw.nasal, raw.rhotic, raw.secondary, raw.codaArt], [4, true, true, 1, 3]);
  assert.deepEqual([raw.track, raw.timing, raw.glide, raw.refNote], [128, 192, 40, 0x3c00]);

  assert.deepEqual([...back.instruments[I.CHOIR].sourceSlots], [I.KA, I.HUM], "a formant instrument is a layer");

  // every lane sings
  const parsed = parseTaud(await doc.toSaveBytes(3));
  for (let keep = 0; keep < 5; keep++) {
    const eng = new TaudEngine();
    loadIntoEngine(eng, parsed, 0);
    for (let l = 0; l < 5; l++) if (l !== keep) eng.setVoiceMute(0, l, true);
    eng.setCuePosition(0, 0);
    eng.play(0);
    const ts = eng.playheads[0].trackerState;
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let e = 0;
    for (let n = 0; n < 2 * 48000; n += TRACKER_CHUNK) {
      eng.renderChunk(0, out);
      for (let k = 0; k < TRACKER_CHUNK; k++) { assert.ok(Number.isFinite(ts.mixLeft[k])); e += ts.mixLeft[k] ** 2; }
    }
    assert.ok(e > 1, `lane ${"abcde"[keep]} sounds`);
  }
});

test("every syllable the Formant tab spells reads back to its fields", () => {
  const rnd = mulberry32(231);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  // a semivowel left last in the onset would be read as the glide, which it
  // also is: the tab spells the two alike, so they are not asked for here
  const onsets = CONSONANT_LIST.filter((r) => r.id < 83 || r.id > 86).map((r) => r.id);
  const all = CONSONANT_LIST.map((r) => r.id);
  for (let n = 0; n < 2000; n++) {
    const p = new FormantPatch();
    const nOn = Math.floor(rnd() * 3);
    const vowel = rnd() < 0.8;
    const k = vowel ? nOn : Math.max(1, nOn);
    for (let i = 0; i < k; i++) p.slots[i].cons = i === k - 1 ? pick(onsets) : pick(all);
    if (rnd() < 0.5) p.slots[2].cons = pick(all);
    if (k && rnd() < 0.5) p.secondary = 1 + Math.floor(rnd() * 3);
    if (p.slots[2].cons && rnd() < 0.5) p.codaArt = 1 + Math.floor(rnd() * 3);
    if (vowel) {
      p.front = Math.floor(rnd() * 256); p.open = Math.floor(rnd() * 256); p.round = rnd() < 0.5 ? 0 : 255;
      p.semivowel = Math.floor(rnd() * 5);
      p.nasal = rnd() < 0.3;
      p.rhotic = rnd() < 0.2;
    } else p.refNote = 0;
    const spelt = formantSyllable({ formant: p });
    const got = readIpaSyllable(spelt);
    const want = {
      onset: p.slots.slice(0, k).map((s) => s.cons), secondary: p.secondary, coda: p.slots[2].cons,
      release: p.codaArt, glide: vowel ? p.semivowel : 0, nasal: vowel && p.nasal, rhotic: vowel && p.rhotic,
    };
    for (const [key, v] of Object.entries(want)) assert.deepEqual(got[key], v, `${spelt}: ${key}`);
    if (vowel) {
      const m = nearestVowelMark(p.front, p.open, p.round);
      assert.deepEqual(got.vowel, { front: m.front, open: m.open, round: m.round }, `${spelt}: the vowel`);
    } else assert.equal(got.vowel, null);
  }
});

test("X-SAMPA reads as the IPA it stands for", () => {
  const cases = {
    "k_ha": "kʰa", "p_ja": "pʲa", "p'a": "pʲa", "t_Su": "t͡ʃu", "d_Z@": "d͡ʒə", "N=": "ŋ̩", "s_hak_}": "sʰak̚",
    "@`": "ɚ", "3`": "ɜ˞", "A~": "ɑ̃", "b_ta": "b̤a", "5a": "ɫa", "?_ha": "ʔ͡ha", "t`a": "ʈa", "r\\`a": "ɻa",
    "k_xa": "k͡xa", "s\\i": "ɕi", "J\\a": "ɟa", "Hi": "ɥi", "M\\a": "ɰa", "{n": "æn", "t_G": "tˠ", "t_?\\": "tˤ",
    "t_?a": "tˀa", "[ga]": "ɡa", "x\\": null,
  };
  for (const [x, ipa] of Object.entries(cases)) {
    if (ipa === null) { assert.throws(() => xsampaToIpa(x), MotifError, x); continue; }
    assert.equal(xsampaToIpa(x), ipa, x);
  }
  // …and the fields: Korean 각 [kak̚], 쌀 [sˀal], Hindi भा [bʱa]
  assert.deepEqual(readIpaSyllable(xsampaToIpa("kak_}")), readIpaSyllable("kak̚"));
  assert.deepEqual(readIpaSyllable(xsampaToIpa("s_?al")), readIpaSyllable("s͈al"));
  assert.deepEqual(readIpaSyllable(xsampaToIpa("b_ta")).onset, [18]);
});

test("formant declarations say what is wrong with them", () => {
  const err = (body) => {
    try { interpret(`tml 2\nsong { bars: 1 }\ninstrument S { wave: "sine" }\n${body}`); } catch (e) { if (e instanceof MotifError) return e.message; throw e; }
    assert.fail("expected a MotifError");
  };
  const f = (x) => err(`instrument X { formant: { ${x} } }`);
  assert.match(f(`syl_ipa: "aɪ"`), /a syllable has one vowel, not 2/);
  assert.match(f(`syl_ipa: "s"`), /has no vowel: give it one, or mark the consonant/);
  assert.match(f(`syl_ipa: "stra"`), /at most two consonants/);
  assert.match(f(`syl_ipa: "akt"`), /ends with one consonant/);
  assert.match(f(`syl_ipa: "fʰa"`), /there is no \[fʰ\]/);
  assert.match(f(`syl_ipa: "kaː"`), /long/);
  assert.match(f(`syl_ipa: "ka la"`), /without spaces/);
  assert.match(f(`syl_ipa: "kʲta"`), /goes on the onset's last consonant/);
  assert.match(f(`syl_ipa: "k̚a"`), /only the coda is unreleased/);
  assert.match(f(`syl_ipa: "ʘa"`), /"ʘ" is not a sound/);
  assert.match(f(`syl_sampa: "ka:"`), /long/);
  assert.match(f(`syl_ipa: "ka", syl_sampa: "ka"`), /give the syllable once/);
  assert.match(f(`onset: ["s", "t", "r"]`), /at most two consonants, not 3/);
  assert.match(f(`coda: "ʘ"`), /is not a consonant/);
  assert.match(f(`vowel: none`), /says nothing/);
  assert.match(f(`syl_ipa: "n̩", reference: 'C4'`), /no vowel has no reference note/);
  assert.match(f(`source: "sqare"`), /source is a waveform .* \(did you mean "square"\?\)/);
  assert.match(f(`source: S`), /S is not a chip/);
  assert.match(f(`glide: "x"`), /glide is "j", "ɥ", "ɰ", "w" or none/);
  assert.match(f(`secondary: "labialised"`), /must be one of "none", "palatalised"/);
  assert.match(f(`consonant_lenght: 2`), /did you mean "consonant_length"/);
  assert.match(err(`instrument X { formant: {}, retune: true }`), /nothing to retune/);
  assert.match(err(`instrument X { formant: {}, layer_gain: 3 }`), /layer_gain is for a layered preset/);
});

test("a formant instrument cannot be an FM operator", async () => {
  await assert.rejects(buildProject(`tml 2
song { bars: 1 }
instrument V { formant: { syl_ipa: "la" } }
instrument S { wave: "sine" }
instrument F { fm: { operators: [{ inst: S }, { inst: V }] } }
lane a { inst: F }
`, {}), /operator 1 reads V, a formant instrument/);
});

test("the four glides and the syllabic marks", () => {
  for (const s of SEMIVOWELS.filter(Boolean)) assert.equal(readIpaSyllable(`p${s.ipa}a`).glide, s.code);
  assert.deepEqual(readIpaSyllable("n̩").onset, [34]);
  assert.deepEqual(readIpaSyllable("ŋ̍").onset, [37]);
  assert.deepEqual(readIpaSyllable("ʧ̩").onset, [98], "a ligature is its affricate");
  assert.equal(readIpaSyllable("ɚ").rhotic, true);
  assert.equal(readIpaSyllable("mãn").nasal, true, "a precomposed nasal vowel");
  assert.deepEqual(readIpaSyllable("dʰa").onset, [19], "a voiced stop aspirated is breathy");
});
