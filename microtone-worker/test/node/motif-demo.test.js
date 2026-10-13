// Motif (item 208): the Huygens' Clock demo is BUILT from its Taud Motif
// Language source, assets/demo_projects/Huygens_clock.tml. When Motif arrived,
// that source rebuilt the file the old JavaScript generator had made byte for
// byte (bank, cleanup and re-tuning included — `node tools/motif.js`, which
// needs python3 and takes a while). These tests keep the quick half of that
// promise on every run: the song the source composes is the song in the file,
// pattern for pattern, and the file carries the source it was built from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseTaud } from "../../core/format/taud-parse.js";
import { evaluate, MOTIF_FOURCC } from "../../src/motif/build.js";
import { compileScore } from "../../src/motif/compile.js";
import { splitNameTable } from "../../src/doc/bankmerge.js";

const DIR = new URL("../../assets/demo_projects/", import.meta.url);
const source = readFileSync(new URL("Huygens_clock.tml", DIR), "utf8");
const file = parseTaud(new Uint8Array(readFileSync(new URL("Huygens_clock.taud", DIR))));
const score = evaluate(source);
const compiled = compileScore(score);
const section = (f) => file.projSections.find((s) => s.fourcc === f)?.payload ?? null;

test("Huygens' Clock: the source composes the song the file holds, pattern for pattern", () => {
  const song = file.songs[0];
  assert.equal(compiled.patterns.length, song.patterns.length);
  compiled.patterns.forEach((p, i) => {
    assert.deepEqual(Array.from(p), Array.from(song.patterns[i]), `pattern ${i} (${compiled.names[i]})`);
  });
  assert.equal(compiled.cues.length, 16);
  compiled.cues.forEach((w, c) => assert.deepEqual(Array.from(w), Array.from(song.cues[c]).slice(0, 64), `cue ${c}`));
});

test("Huygens' Clock: names, tempo, levels and notation agree", () => {
  const song = file.songs[0];
  assert.equal(song.numVoices, score.lanes.length);
  assert.equal(song.bpm, score.song.tempo);
  assert.equal(song.tickRate, score.song.speed);
  assert.equal(song.globalVolume, score.song.globalVolume);
  assert.equal(song.mixingVolume, score.song.mixingVolume);
  const td = new TextDecoder();
  const pNam = splitNameTable(section("pNam")).map((b) => td.decode(b));
  assert.deepEqual(pNam, compiled.names);
  assert.equal(file.meta.songMeta[0].notation, 310, "31-TET notation");
  assert.equal(td.decode(section("PMsg")), score.song.message);
  assert.equal(file.signature, "Microtone Demo", "the demo songs' Makefile signs them");
});

test("Huygens' Clock carries its own source, verbatim", () => {
  const payload = section(MOTIF_FOURCC);
  assert.ok(payload, "the demo has no PMtf section — rebuild it with node tools/motif.js");
  assert.equal(new TextDecoder().decode(payload), source,
    "the source in the .taud is not the .tml next to it — rebuild with node tools/motif.js assets/demo_projects/Huygens_clock.tml");
});
