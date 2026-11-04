// Motif (item 289): lyric instruments written in TML — a formant instrument
// given `lyrics`, built into the ILyr entry the Lyrics tab would make, and
// compiled so that its notes sing the lyrics on (its instrument number only
// where the lane comes to it).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProject } from "../../src/motif/build.js";
import { continuingLyricRows } from "../../src/motif/compile.js";
import { deriveLyrics } from "../../src/doc/lyrics.js";
import { blankLyricEditor } from "../../core/format/lyric-section.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";

const SONG = `tml 2
song { title: "Twinkle", bars: 2, bar_rows: 16, tuning: "12-TET", speed: 3 }
instrument BUZZ  { psg: { a: { waveform: "saw" } } }
instrument VERSE { lyrics: "twɪŋ.kəl twɪŋ.kəl lɪ.təl stɑɹ" }
instrument CHORUS { formant: { source: BUZZ, consonant_length: 0.8, reference: 'A3' },
  lyrics: { sampa: ["la", "la", "l_jA"], towards_median: 0.5, consonant_lengths: { "l": 1.5 }, syllable_lengths: [[2, 0.7]] } }
lane v { inst: VERSE }
melody(v, 0, "C4:2 C4:2 G4:2 G4:2 A4:2 A4:2 G4:4")
hit(v, 16, 'F4', 40, inst: CHORUS)
hit(v, 18, 'F4', 40, inst: CHORUS)
hit(v, 20, 'E4', 40)
hit(v, 22, 'E4', 40)
loop(hit(v, 24, 'D4', 40, inst: CHORUS), 4, 2)
`;

async function build(src = SONG) {
  const { doc, score } = await buildProject(src, {});
  // reloaded from the saved bytes: what a file says, not what the build held
  const back = new Document(parseTaud(await doc.toSaveBytes(3)));
  back._rebuildInstRegion();
  const I = Object.fromEntries(score.instruments.map((i) => [i.id, i.slot]));
  return { doc, back, score, I };
}

test("lyrics are the entry the Lyrics tab derives from the same text and settings", async () => {
  const { back, I } = await build();
  assert.ok(back.isLyricSlot(I.VERSE) && back.isLyricSlot(I.CHORUS));
  assert.ok(!back.isLyricSlot(I.BUZZ));

  const verse = back.lyricEntry(I.VERSE);
  assert.equal(verse.syllables.length, 7);
  assert.deepEqual(verse.editor, { ...blankLyricEditor(), text: "twɪŋ.kəl twɪŋ.kəl lɪ.təl stɑɹ" });
  assert.deepEqual(verse.recipes, [], "its consonants sound the noise generator, as a Motif formant instrument's do");
  const want = deriveLyrics(back.instruments[I.VERSE].formant, verse.editor, null).entry;
  assert.deepEqual(verse.syllables, want.syllables);

  const chorus = back.lyricEntry(I.CHORUS);
  assert.deepEqual(chorus.editor, {
    text: "la la l_jA", xsampa: true, converge: 50,
    overrides: [{ cons: chorus.editor.overrides[0].cons, timing: 128 + 37 }], // 64·log2 1.5 = 37.4
    sylOverrides: [{ index: 2, timing: 128 - 33 }],                          // 64·log2 0.7 = −32.9
  });
  const f = back.instruments[I.CHORUS].formant;
  assert.equal(f.srcInst, I.BUZZ, "sung from the PSG");
  assert.equal(f.timing, 128 - 21, "consonant_length is the base every syllable scales");
  assert.deepEqual(chorus.syllables, deriveLyrics(f, chorus.editor, null).entry.syllables);
  assert.ok(chorus.syllables[2].gr & 0x18, "[lʲ] is palatalised");
});

test("a lyric instrument's number is written only where the lane comes to it", async () => {
  const { back, I } = await build();
  const cells = back.songs[0].patterns[back.songs[0].cues[0][0] & 0x7fff];
  const insts = [];
  cells.forEach((c, r) => { if (c.note >= 0x20) insts.push([r, c.instrment]); });
  assert.deepEqual(insts, [
    [0, I.VERSE], [2, 0], [4, 0], [6, 0], [8, 0], [10, 0], [12, 0],
    [16, I.CHORUS], [18, 0],
    [20, I.VERSE], [22, 0],         // the lane's own instrument again: its lyrics start over
    [24, I.CHORUS], [26, 0], [28, 0], [30, 0],
  ]);
});

test("the notes sing the lyrics on, a syllable each, and wrap", async () => {
  const { doc, I } = await build();
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(await doc.toSaveBytes(3)), 0);
  eng.setCuePosition(0, 0);
  eng.play(0);
  const ts = eng.playheads[0].trackerState;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const perRow = Math.round((48000 * 3 * 2.5) / 125); // speed 3 at 125 BPM
  const sung = [];
  let done = 0;
  for (const r of [0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 28, 30]) {
    const mid = r * perRow + perRow / 2;
    while (done < mid) { eng.renderChunk(0, out); done += TRACKER_CHUNK; }
    const st = ts.voices[0].formant;
    const who = [I.VERSE, I.CHORUS].find((s) => eng.instruments[s].lyric?.includes(st?.patch));
    sung.push(`${who === I.VERSE ? "V" : who === I.CHORUS ? "C" : "?"}${who ? eng.instruments[who].lyric.indexOf(st.patch) : ""}`);
  }
  assert.deepEqual(sung, ["V0", "V1", "V2", "V3", "V4", "V5", "V6", "C0", "C1", "V0", "V1", "C0", "C1", "C2", "C0"]);
});

test("the continuation rule: a lyric instrument's repeats, nothing else's", () => {
  const lyric = (k) => k === "L" || k === "M";
  const rows = [[0, "L"], [1, undefined], [2, "L"], [3, "X"], [4, "X"], [5, "L"], [6, "M"], [7, "M"], [8, "L"]];
  assert.deepEqual([...continuingLyricRows(rows, lyric)], [2, 7]);
});

test("the lyrics may be a list, and X-SAMPA is read as the IPA it stands for", async () => {
  const ipa = await build(SONG.replace(`lyrics: "twɪŋ.kəl twɪŋ.kəl lɪ.təl stɑɹ"`, `lyrics: ["twɪŋ.kəl", "twɪŋ.kəl", "lɪ.təl stɑɹ"]`));
  const sampa = await build(SONG.replace(`lyrics: "twɪŋ.kəl twɪŋ.kəl lɪ.təl stɑɹ"`, `lyrics: { sampa: "twIN.k@l twIN.k@l lI.t@l stAr\\\\" }`));
  const a = ipa.back.lyricEntry(ipa.I.VERSE), b = sampa.back.lyricEntry(sampa.I.VERSE);
  assert.equal(a.editor.text, "twɪŋ.kəl twɪŋ.kəl lɪ.təl stɑɹ");
  assert.deepEqual(a.syllables, b.syllables);
  assert.equal(b.editor.xsampa, true);
});

test("lyrics say what is wrong with them", async () => {
  const head = `tml 2\nsong { bars: 1 }\n`;
  const tail = `\nlane v { inst: V }\nhit(v, 0, 'C4')\n`;
  const fails = async (inst, re) => {
    await assert.rejects(buildProject(head + inst + tail, {}), (e) => {
      assert.equal(e.name, "MotifError");
      assert.match(e.message, re);
      return true;
    }, inst);
  };
  await fails(`instrument V { lyrics: "la qqq la" }`, /syllable 1 \("qqq"\)/);
  await fails(`instrument V { lyrics: "" }`, /no syllables/);
  await fails(`instrument V { lyrics: 5 }`, /a string of syllables/);
  await fails(`instrument V { wave: "saw", lyrics: "la" }`, /sung by a formant instrument/);
  await fails(`instrument V { formant: { syl_ipa: "ka" }, lyrics: "la" }`, /no syllable of its own \(syl_ipa\)/);
  await fails(`instrument V { lyrics: { ipa: "la", sampa: "la" } }`, /once: as ipa or as sampa/);
  await fails(`instrument V { lyrics: { text: "la" } }`, /no option "text"/);
  await fails(`instrument V { lyrics: { ipa: "la", consonant_lengths: { "s": 2 } } }`, /no syllable of the lyrics says \[s\]/);
  await fails(`instrument V { lyrics: { ipa: "la", consonant_lengths: { "l": 9 } } }`, /0\.25…/);
  await fails(`instrument V { lyrics: { ipa: "la la", syllable_lengths: [[2, 1]] } }`, /no syllable 2 \(the lyrics have 2, from 0\)/);
  await fails(`instrument V { lyrics: { ipa: "la", towards_median: 2 } }`, /towards_median must be 0…1/);
});
