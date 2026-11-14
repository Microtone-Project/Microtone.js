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
// scenarios it moved (node tools/engine-scenarios.js --write [name …]) and
// says which.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  GOLDEN_SET, GOLDEN_RATE, GOLDEN_SECONDS, GOLDEN_SEED, goldenPath, renderGolden,
} from "../../tools/golden-set.js";
import {
  SCENARIO_FIXTURE, scenarioNames, scenarioByName, digestScenario,
} from "../../tools/engine-scenarios.js";

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

// Every number a scenario records is the engine's, meters included (meters.c),
// so they run here as they would anywhere: the module carries its own pow.
const scenarios = JSON.parse(readFileSync(SCENARIO_FIXTURE, "utf8")).scenarios;
for (const name of scenarioNames()) {
  test(`host scenario: ${name}`, () => {
    const want = scenarios[name];
    assert.ok(want, "no recorded digests — record them (node tools/engine-scenarios.js --write)");
    const got = digestScenario(scenarioByName(name));
    assert.ok(got.peak > 0, "a scenario that renders silence proves nothing");
    assert.equal(got.chunks, want.chunks, "chunks rendered");
    assert.equal(got.f32, want.f32, "f32 mix bus digest");
    assert.equal(got.u8, want.u8, "U8 device output digest");
    assert.equal(got.notes, want.notes, "snapshots and readbacks digest");
  });
}
