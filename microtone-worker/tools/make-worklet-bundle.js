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
  // The engine: the C engine built as WebAssembly (item 312) and the
  // JavaScript half that drives it (wasm-engine.js), in dependency order.
  "core/engine/taud-engine.wasm.js",
  "core/engine/wasm-module.js",
  "core/engine/constants.js",
  "core/engine/rng.js",
  "core/engine/tables.js",
  "core/engine/spatial.js",
  "core/engine/speakers.js",
  "core/engine/analysis.js",   // the master strip's tap (JavaScript, on the module's memory)
  "core/engine/dither.js",
  "core/engine/loudness.js",   // the Mastering view's tap, likewise
  "core/engine/mastering.js",
  "core/engine/imix.js",
  // The mastering and mixing-chain blocks cross into the engine as the file's
  // own bytes, built by their codecs.
  "core/format/mastering-section.js",
  "core/format/imix-section.js",
  "core/engine/wasm-engine.js",
  // The host.
  "core/worklet/protocol.js",
  "core/worklet/engine-commands.js",
  "core/audio/audio-ring.js",
  "core/audio/resampler.js",
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

// Sanity: the bundle is ONE scope. A top-level name two modules both declare
// is a SyntaxError when either is a const/let/class — reported nowhere inside
// AudioWorkletGlobalScope — and when both are function declarations it is not
// even that: the later one silently replaces the earlier for every caller, the
// earlier module's own included. (opl.js and envelope.js once both had an
// `advanceEnvelope`; bundled, every OPL voice ran the sampler's and was silent.)
// Module scope never shows it, so check here.
{
  const owner = new Map();
  const clashes = [];
  for (const rel of FILES) {
    const src = await readFile(root + rel, "utf8");
    const decl = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:const|let|var|class)\s+)([A-Za-z_$][\w$]*)/gm;
    for (const m of src.matchAll(decl)) {
      const prev = owner.get(m[1]);
      if (prev && prev !== rel) clashes.push(`${m[1]}: ${prev} and ${rel}`);
      else owner.set(m[1], rel);
    }
  }
  if (clashes.length > 0) {
    throw new Error(`top-level name(s) declared by two bundled modules:\n  ${clashes.join("\n  ")}`);
  }
}

await writeFile(root + "core/worklet/taud-processor.bundle.js", out);
console.log(`wrote core/worklet/taud-processor.bundle.js (${out.length} bytes)`);
