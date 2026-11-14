// Motif (item 208): the Huygens' Clock demo is BUILT from its Taud Motif
// Language source, assets/demo_projects/Huygens_clock.tml (and Eighteenfold Euphonic DisOrder from
// Zeta_valley.tml and the Eighth Baffling Incongruity Theorem from Eighth.tml, which were Motif
// programs from the start). When Motif arrived,
// that source rebuilt the file the old JavaScript generator had made byte for
// byte (bank, cleanup and re-tuning included — `node tools/motif.js`, which
// needs python3 and takes a while). These tests keep the quick half of that
// promise on every run: the song the source composes is the song in the file,
// pattern for pattern, and the file carries the source it was built from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseTaud } from "../../core/format/taud-parse.js";
import { evaluate, buildProject, MOTIF_FOURCC } from "../../src/motif/build.js";
import { compileScore } from "../../src/motif/compile.js";
import { splitNameTable } from "../../src/doc/bankmerge.js";

const DIR = new URL("../../assets/demo_projects/", import.meta.url);

// The demos Motif builds: [name, file stem, cues, notation number].
const DEMOS = [
  ["Huygens' Clock", "Huygens_clock", 16, 310],
  ["Eighteenfold Euphonic DisOrder", "Zeta_valley", 44, 180],
  ["Eighth Baffling Incongruity Theorem", "Eighth", 20, 80],
];

for (const [name, stem, cueCount, notation] of DEMOS) {
  const source = readFileSync(new URL(`${stem}.tml`, DIR), "utf8");
  const file = parseTaud(new Uint8Array(readFileSync(new URL(`${stem}.taud`, DIR))));
  // A song of soundfont presets takes its slots in declaration order (the
  // bank sf2bank.py builds) and needs python to make, so no bank is made here;
  // the bank step also marks which instruments sing lyrics (the compiler
  // writes a lyric instrument's number only where its lyrics start), so mark
  // the program's own as it would. A song with no soundfont preset (waves and
  // racks: Eighth) slots them as the bank imports them, which needs nothing
  // outside Node — so its bank is made, as the build makes it.
  let score = evaluate(source);
  if (score.instruments.some((i) => i.kind === "sf2")) {
    for (const i of score.instruments) i.lyric = Boolean(i.lyrics);
  } else {
    ({ score } = await buildProject(source, {}));
  }
  const compiled = compileScore(score);
  const section = (f) => file.projSections.find((s) => s.fourcc === f)?.payload ?? null;

  test(`${name}: the source composes the song the file holds, pattern for pattern`, () => {
    const song = file.songs[0];
    assert.equal(compiled.patterns.length, song.patterns.length);
    compiled.patterns.forEach((p, i) => {
      assert.deepEqual(Array.from(p), Array.from(song.patterns[i]), `pattern ${i} (${compiled.names[i]})`);
    });
    assert.equal(compiled.cues.length, cueCount);
    compiled.cues.forEach((w, c) => assert.deepEqual(Array.from(w), Array.from(song.cues[c]).slice(0, 64), `cue ${c}`));
  });

  test(`${name}: names, tempo, levels and notation agree`, () => {
    const song = file.songs[0];
    assert.equal(song.numVoices, score.lanes.length);
    assert.equal(song.bpm, score.song.tempo);
    assert.equal(song.tickRate, score.song.speed);
    assert.equal(song.globalVolume, score.song.globalVolume);
    assert.equal(song.mixingVolume, score.song.mixingVolume);
    const td = new TextDecoder();
    const pNam = splitNameTable(section("pNam")).map((b) => td.decode(b));
    assert.deepEqual(pNam, compiled.names);
    assert.equal(file.meta.songMeta[0].notation, notation, `notation ${notation}`);
    assert.equal(td.decode(section("PMsg")), score.song.message);
    assert.equal(file.signature, "Microtone Demo", "the demo songs' Makefile signs them");
  });

  test(`${name} carries its own source, verbatim`, () => {
    const payload = section(MOTIF_FOURCC);
    assert.ok(payload, `the demo has no PMtf section — rebuild it with make in assets/demo_projects/`);
    assert.equal(new TextDecoder().decode(payload), source,
      `the source in the .taud is not the .tml next to it — rebuild with make in assets/demo_projects/`);
  });
}
