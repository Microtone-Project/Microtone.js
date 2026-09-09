#!/usr/bin/env node
// Concatenate the engine + worklet module graph into a single classic-script
// worklet file for browsers whose AudioWorklet cannot import ES modules
// (historically Firefox). Output is COMMITTED: src/worklet/taud-processor.bundle.js
// — regenerate after any engine change: node tools/make-worklet-bundle.js
//
// The strip is naive by design (this repo's import/export usage is uniform):
//   - `import {...} from "...";` statements removed (multi-line supported)
//   - leading `export ` keywords removed
// Duplicate local helpers (e.g. clamp) are benign re-declarations.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const FILES = [
  "src/engine/constants.js",
  "src/engine/minifloat.js",
  "src/engine/rng.js",
  "src/engine/tables.js",
  "src/engine/spatial.js",
  "src/engine/hrir-sadie.js",  // …which binaural.js decodes
  "src/engine/binaural.js",
  "src/engine/speakers.js",  // …which analysis.js needs
  "src/engine/analysis.js",  // before state.js (TrackerState builds a tap) AND
                             // before protocol.js (the snapshot layout sizes
                             // its blocks from the tap's own constants)
  "src/engine/mastering.js", // …and both of these before state.js too, which
  "src/engine/loudness.js",  // builds a chain and a meter tap (item 178);
                             // loudness.js reads analysis.js's oversampler
  "src/engine/samplemod.js",  // …before sampler.js (readSamplePoint) and inst.js
  "src/engine/inst.js",
  "src/engine/voice.js",
  "src/engine/state.js",
  "src/engine/sampler.js",
  "src/engine/filter.js",
  "src/engine/fm.js",   // …after sampler + filter, whose per-sample calls it makes
  "src/engine/envelope.js",
  "src/engine/trigger.js",
  "src/engine/effects.js",
  "src/engine/row.js",
  "src/engine/tick.js",
  "src/engine/mixer.js",
  "src/engine/engine.js",
  "src/worklet/protocol.js",
  "src/audio/audio-ring.js",
  "src/audio/resampler.js",
  "src/worklet/engine-commands.js",
  "src/worklet/taud-processor.js",
];

let out = `// GENERATED FILE — do not edit. Rebuild with: node tools/make-worklet-bundle.js
// Single-file concat of src/engine/* + src/worklet/* for non-module AudioWorklets.
"use strict";
`;

for (const rel of FILES) {
  let src = await readFile(root + rel, "utf8");
  src = src.replace(/^import\s[\s\S]*?from\s*"[^"]+";\s*$/gm, "");
  src = src.replace(/^export\s+(async\s+function|function|const|class|let|var)/gm, "$1");
  out += `\n// ══ ${rel} ══\n${src}`;
}

// Sanity: no import/export may survive.
if (/^\s*(import|export)\s/m.test(out)) {
  const line = out.split("\n").find((l) => /^\s*(import|export)\s/.test(l));
  throw new Error(`unstripped module syntax: ${line}`);
}

// Sanity: every module the graph imports must actually BE in FILES. Stripping
// the import lines hides a missing file completely — the bundle parses, then
// dies on a ReferenceError inside AudioWorkletGlobalScope, where the only
// symptom is "the node name is not defined". (That is exactly what a missing
// analysis.js did to the fallback path.) So re-read the sources and check that
// everything they import from is on the list.
const listed = new Set(FILES);
const missing = new Set();
for (const rel of FILES) {
  const src = await readFile(root + rel, "utf8");
  const dir = rel.slice(0, rel.lastIndexOf("/"));
  for (const m of src.matchAll(/^import\s[\s\S]*?from\s*"([^"]+)";/gm)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const abs = new URL(spec, `file:///${dir}/`).pathname.replace(/^\/+/, "");
    if (!listed.has(abs)) missing.add(`${rel} imports ${spec}`);
  }
}
if (missing.size > 0) {
  throw new Error(`module(s) missing from FILES:\n  ${[...missing].join("\n  ")}`);
}

await writeFile(root + "src/worklet/taud-processor.bundle.js", out);
console.log(`wrote src/worklet/taud-processor.bundle.js (${out.length} bytes)`);
