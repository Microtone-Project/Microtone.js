#!/usr/bin/env node
// Export a .taud as Impulse Tracker module(s) — the same exporter the Files
// view's "Export .IT…" runs (src/convert/itexport.js), for testing and batch use.
// Usage: node tools/taud2it.js <in.taud> [out.it]
//   One .it per song: a second song is written as <out>-2.it and so on.
//   Prints every finding; exits 1 when a song cannot be exported.

import { readFile, writeFile } from "node:fs/promises";
import { parseTaud } from "../core/format/taud-parse.js";
import { Document } from "../src/doc/document.js";
import { exportItSongs, itFileName } from "../src/convert/itexport.js";

const [inPath, outArg] = process.argv.slice(2);
if (!inPath) {
  console.error("usage: taud2it.js <in.taud> [out.it]");
  process.exit(2);
}
const base = (outArg ?? inPath).replace(/\.(taud|it)$/i, "");
const doc = new Document(parseTaud(await readFile(inPath)));

const where = (w) => (w ? ` (cue ${w.cue.toString(16)}, lane ${w.lane + 1}, row ${w.row.toString(16)})` : "");
const show = (f) => `${f.code} ${JSON.stringify(f.args)}${f.count > 1 ? ` ×${f.count}` : ""}${where(f.where)}`;

let failed = false;
const results = exportItSongs(doc);
for (const r of results) {
  console.log(`song ${r.songIndex} "${r.title}"`);
  for (const e of r.errors) console.log("  error   " + show(e));
  for (const w of r.warnings) console.log("  warning " + show(w));
  if (r.bytes === null) { failed = true; continue; }
  const name = itFileName(base, r.songIndex, results.length);
  await writeFile(name, r.bytes);
  console.log(`  wrote ${r.bytes.length} bytes to ${name}`);
}
process.exit(failed ? 1 : 0);
