#!/usr/bin/env node
// Bring assets/demo_projects/demos.json's `bytes` up to date with the files.
// The welcome panel draws a demo's row from the manifest before it fetches the
// song, so every display field there is a copy (test/node/demos.test.js checks
// them all); this refreshes the one a rebuild changes. Run by the demo
// Makefile after it builds, or by hand from microtone-worker/.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../assets/demo_projects/", import.meta.url));
const path = DIR + "demos.json";
const text = readFileSync(path, "utf8");
const manifest = JSON.parse(text);
let changed = 0;
for (const d of manifest.demos) {
  const bytes = statSync(DIR + d.file).size;
  if (d.bytes !== bytes) {
    console.log(`${d.file}: ${d.bytes} → ${bytes} bytes`);
    d.bytes = bytes;
    changed++;
  }
}
if (changed) writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
else console.log("demos.json is up to date");
