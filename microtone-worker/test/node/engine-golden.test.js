// The engine's golden gate. The web engine is the reference implementation of
// the Taud engine (the TSVM Kotlin engine is downstream), so what it renders
// for the golden set IS the specification's worked example: a refactor must
// reproduce every digest in test/fixtures/engine-golden.json bit for bit —
// dithered U8 device output and the f32 mix bus both.
//
// A deliberate change to the sound regenerates the digests in the same batch
// (node tools/make-golden.js [label …]) and names the songs that moved. To
// see WHERE a render diverged, dump both sides with tools/render-taud.js and
// compare them with tools/compare-pcm.js.
//
// test/corpus/ is gitignored, so its songs run only where they exist; the demo
// projects are tracked and always run.
//
// Its second half is what a HOST does besides playing a song from the top —
// auditioning, the chase, faders, edits under sounding notes, resets, the
// meters: the scenarios of tools/engine-scenarios.js, whose renders, snapshots
// and readbacks are digested against test/fixtures/engine-scenarios.json. A
// new host call gets a scenario there; a deliberate change re-records the
// scenarios it moved (node --no-use-std-math-pow tools/engine-scenarios.js
// --write [name …]) and says which.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  GOLDEN_SET, GOLDEN_RATE, GOLDEN_SECONDS, GOLDEN_SEED, goldenPath, renderGolden,
} from "../../tools/golden-set.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/engine-golden.json", import.meta.url), "utf8"));

test("golden fixture matches the golden set's render settings", () => {
  assert.equal(fixture.rate, GOLDEN_RATE);
  assert.equal(fixture.seconds, GOLDEN_SECONDS);
  assert.equal(fixture.seed, GOLDEN_SEED);
  for (const label of Object.keys(GOLDEN_SET)) {
    if (existsSync(goldenPath(GOLDEN_SET[label]))) assert.ok(fixture.songs[label], `${label} has no digest — run tools/make-golden.js`);
  }
});

for (const [label, entry] of Object.entries(GOLDEN_SET)) {
  const want = fixture.songs[label];
  const present = existsSync(goldenPath(entry));
  test(`golden render: ${label}`, { skip: !present ? "file not on this machine" : !want ? "no digest recorded" : false }, async () => {
    const got = await renderGolden(entry);
    assert.equal(got.frames, want.frames, "rendered length");
    assert.equal(got.f32, want.f32, "f32 mix bus digest");
    assert.equal(got.u8, want.u8, "U8 device output digest");
  });
}

// The scenarios record the page's JavaScript meter taps too, so they run in a
// child that has V8 compute Math.pow with its own fdlibm port — the same bits
// on every machine (and the pow the C engine carries).
const POW_FLAG = "--no-use-std-math-pow";
const flagKnown = spawnSync(process.execPath, [POW_FLAG, "-e", "0"]).status === 0;

test("host scenarios: every render, snapshot and readback is the recorded one",
  { skip: flagKnown ? false : `this Node has no ${POW_FLAG}` }, () => {
    const tool = fileURLToPath(new URL("../../tools/engine-scenarios.js", import.meta.url));
    const r = spawnSync(process.execPath, [POW_FLAG, tool], { encoding: "utf8", maxBuffer: 1 << 24 });
    assert.equal(r.status, 0, `a scenario moved:\n${r.stdout}\n${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.ok(lines.length > 0, "no scenario ran");
    for (const line of lines) {
      assert.match(line, /: unchanged \(/, line);
      assert.doesNotMatch(line, /peak 0\)/, `${line} — a scenario that renders silence proves nothing`);
    }
  });
