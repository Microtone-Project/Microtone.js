// Item 163: the bundled demo projects. assets/demo_projects/demos.json is what
// the welcome panel and the File-tab picker draw BEFORE fetching half a
// megabyte, so every display field in it is a copy of something the container
// already stores. These tests are what stops the copy rotting: each row is
// parsed out of the real .taud and compared against the manifest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";

const DIR = new URL("../../assets/demo_projects/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("demos.json", DIR), "utf8"));
const demos = manifest.demos;

test("the manifest is a non-empty list of demos", () => {
  assert.ok(Array.isArray(demos), "demos.json must carry a `demos` array");
  assert.ok(demos.length > 0, "ship at least one demo, or drop the panel");
  const files = demos.map((d) => d.file);
  assert.equal(new Set(files).size, files.length, "duplicate file entries");
  for (const d of demos) {
    assert.match(d.file, /^[\w.-]+\.taud$/, `${d.file}: native containers only`);
    assert.ok(d.title?.trim(), `${d.file}: needs a title`);
    assert.ok(d.composer?.trim(), `${d.file}: needs a composer credit`);
    assert.ok([0, 1, 2].includes(d.surroundModel ?? 0),
      `${d.file}: surroundModel is 0/1/2`);
  }
});

for (const d of demos) {
  test(`${d.file}: the file is there and parses`, () => {
    const bytes = new Uint8Array(readFileSync(new URL(d.file, DIR)));
    const doc = parseTaud(bytes);
    assert.equal(doc.kind, "taud", "a demo is a whole project, not a bank");
    assert.ok(doc.songs.length > 0);
    assert.ok(doc.sampleInstImage, "a demo must carry its own samples");
  });

  test(`${d.file}: the manifest agrees with the container`, () => {
    const path = fileURLToPath(new URL(d.file, DIR));
    const doc = parseTaud(new Uint8Array(readFileSync(path)));
    assert.equal(d.bytes, statSync(path).size, "manifest `bytes` is stale");
    assert.equal(d.songs, doc.songs.length, "manifest `songs` is stale");
    assert.equal(d.title, doc.meta.projectName, "manifest `title` is stale");
    // Every song of a project shares one spatial model in practice; the row can
    // only show one, so insist the file does not contradict it.
    for (const [i, song] of doc.songs.entries()) {
      assert.equal(song.surroundModel, d.surroundModel ?? 0,
        `song ${i}: manifest \`surroundModel\` is stale`);
    }
    // The credit on the row has to be the credit in the file — this is the
    // field the composer's permission actually rests on.
    const composers = new Set(Object.values(doc.meta.songMeta).map((m) => m.composer));
    assert.ok([...composers].some((c) => c?.includes(d.composer)),
      `manifest composer "${d.composer}" appears in no song's sMet (${[...composers]})`);
  });

  test(`${d.file}: permitted demos are documented`, () => {
    if (!d.permission) return;
    const readme = readFileSync(new URL("README.md", DIR), "utf8");
    assert.ok(readme.includes(d.file),
      `${d.file} claims permission — record its terms in demo_projects/README.md`);
  });
}
