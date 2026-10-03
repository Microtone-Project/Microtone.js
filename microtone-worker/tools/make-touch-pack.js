#!/usr/bin/env node
// Write assets/MicrotoneTouch.tsii — the Microtone Touch instrument pack
// (core/sketch/pack.js) as a file, which the sketch format's specification
// (assets/MICROTONE_SKETCH_FORMAT.md) points at for anything that plays
// sketches without carrying the synthesis code. test/node/sketch-format.test.js
// holds the pack to this file, so a change to how an instrument sounds fails
// there until it is made on purpose: run this, and give the format a new
// version, in the same batch.
//
// Usage: node tools/make-touch-pack.js

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildBank, packAsTsii } from "../../core/sketch/pack.js";
import { writeTaudWith } from "../../core/format/taud-write.js";
import { loadZstd } from "../../core/format/zstd.js";

const OUT = fileURLToPath(new URL("../assets/MicrotoneTouch.tsii", import.meta.url));

const zstd = await loadZstd();
const bytes = await writeTaudWith(packAsTsii(buildBank()), async (parts) => parts.map((p) => zstd.compress(p, 19)));
await writeFile(OUT, bytes);
console.log(`wrote ${OUT} (${bytes.length} bytes)`);
