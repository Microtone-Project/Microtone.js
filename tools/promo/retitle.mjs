#!/usr/bin/env node
// Rename one song inside a .taud, leaving the project's own name alone.
//
//   node retitle.mjs <in.taud> <out.taud> <song index> <new song name>
//
// TML's `title` names the project AND song 0. The promo wants the song short
// ("Eighth"), so the top bar's song picker stays on one line, while the
// project keeps the program's full title.

import { readFileSync, writeFileSync } from "node:fs";
import { parseTaud } from "../../core/format/taud-parse.js";
import { ZSTD_LEVEL_SAVE } from "../../core/format/zstd.js";
import { Document } from "../../microtone-worker/src/doc/document.js";

const [inp, out, idx, name] = process.argv.slice(2);
if (!name) { console.error("usage: retitle.mjs <in.taud> <out.taud> <song index> <new song name>"); process.exit(2); }
const doc = new Document(parseTaud(new Uint8Array(readFileSync(inp))));
const meta = doc.meta.songMeta[Number(idx)];
if (!meta) { console.error(`retitle: no song ${idx} in ${inp}`); process.exit(1); }
const was = meta.name;
meta.name = name;
doc.smetEdited = true;
writeFileSync(out, await doc.toSaveBytes(ZSTD_LEVEL_SAVE));
console.log(`${out}: song ${idx} "${was}" → "${name}" (project "${doc.meta.projectName}")`);
