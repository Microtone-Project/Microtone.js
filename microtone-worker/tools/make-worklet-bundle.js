#!/usr/bin/env node
// Concatenate the engine + worklet module graph into a single classic-script
// worklet file for browsers whose AudioWorklet cannot import ES modules
// (historically Firefox). Output is COMMITTED: core/worklet/taud-processor.bundle.js
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
  "core/engine/constants.js",
  "core/engine/minifloat.js",
  "core/engine/rng.js",
  "core/engine/tables.js",
  "core/engine/spatial.js",
  "core/engine/hrir-sadie.js",  // …which binaural.js decodes
  "core/engine/binaural.js",
  "core/engine/speakers.js",  // …which analysis.js needs
  "core/engine/analysis.js",  // before state.js (TrackerState builds a tap) AND
                             // before protocol.js (the snapshot layout sizes
                             // its blocks from the tap's own constants)
  "core/engine/mastering.js", // …and both of these before state.js too, which
  "core/engine/loudness.js",  // builds a chain and a meter tap (item 178);
                             // loudness.js reads analysis.js's oversampler
  "core/engine/samplemod.js",  // …before sampler.js (readSamplePoint) and inst.js
  "core/engine/inst.js",
  "core/engine/voice.js",
  "core/engine/state.js",
  "core/engine/sampler.js",
  "core/engine/filter.js",
  "core/engine/fm.js",   // …after sampler + filter, whose per-sample calls it makes
  "core/engine/envelope.js",
  "core/engine/trigger.js",
  "core/engine/effects.js",
  "core/engine/row.js",
  "core/engine/tick.js",
  "core/engine/mixer.js",
  "core/engine/engine.js",
  "core/worklet/protocol.js",
  "core/audio/audio-ring.js",
  "core/audio/resampler.js",
  "core/worklet/engine-commands.js",
  "core/worklet/taud-processor.js",
];

let out = `// GENERATED FILE — do not edit. Rebuild with: node tools/make-worklet-bundle.js
// Single-file concat of core/engine/* + core/worklet/* for non-module AudioWorklets.
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

await writeFile(root + "core/worklet/taud-processor.bundle.js", out);
console.log(`wrote core/worklet/taud-processor.bundle.js (${out.length} bytes)`);
