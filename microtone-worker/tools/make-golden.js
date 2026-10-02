#!/usr/bin/env node
// Regenerate test/fixtures/engine-golden.json — the digests the engine's
// golden gate (test/node/engine-golden.test.js) holds core/engine/ to.
//
// Run it ONLY for an intentional change to what the engine renders, in the
// same batch as that change (and say which songs moved — that is the real
// review). A refactor must leave every digest alone. Songs whose file is not
// on this machine keep their recorded digests.
//
// Usage: node tools/make-golden.js [label …]   (no labels = every present song)

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_SET, GOLDEN_RATE, GOLDEN_SECONDS, GOLDEN_SEED, goldenPath, renderGolden,
} from "./golden-set.js";

const OUT = fileURLToPath(new URL("../test/fixtures/engine-golden.json", import.meta.url));
const want = process.argv.slice(2);

let fixture = { rate: GOLDEN_RATE, seconds: GOLDEN_SECONDS, seed: GOLDEN_SEED, songs: {} };
try { fixture = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first run */ }
const stale = fixture.rate !== GOLDEN_RATE || fixture.seconds !== GOLDEN_SECONDS || fixture.seed !== GOLDEN_SEED;
if (stale) fixture = { rate: GOLDEN_RATE, seconds: GOLDEN_SECONDS, seed: GOLDEN_SEED, songs: {} };

for (const [label, entry] of Object.entries(GOLDEN_SET)) {
  if (want.length && !want.includes(label)) continue;
  try { await access(goldenPath(entry)); } catch { console.log(`${label}: not on this machine — kept`); continue; }
  const t0 = performance.now();
  const d = await renderGolden(entry);
  const prev = fixture.songs[label];
  const moved = prev && (prev.u8 !== d.u8 || prev.f32 !== d.f32 || prev.frames !== d.frames);
  fixture.songs[label] = { file: entry.file, ...(entry.monitor !== undefined ? { monitor: entry.monitor } : {}), ...d };
  console.log(`${label}: ${prev ? (moved ? "CHANGED" : "unchanged") : "new"} (${(performance.now() - t0).toFixed(0)} ms)`);
}
for (const label of Object.keys(fixture.songs)) {
  if (!(label in GOLDEN_SET)) { delete fixture.songs[label]; console.log(`${label}: no longer in the set — dropped`); }
}
await writeFile(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${OUT}`);
