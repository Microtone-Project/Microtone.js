// The tracker's Korean (design-system/fonts/korean.py → fonts/korean.css):
// Pretendard's own dynamic-subset files, unmodified, each narrowed to the
// Hangul it holds, and "Microtone Hanja", the few ideographs the interface
// writes, cut from Chiron Hei HK. Both stand behind every font stack.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

import { readWoff2, cmapOf } from "../fixtures/woff2.js";

const WORKER = new URL("../../", import.meta.url);
const REPO = new URL("../", WORKER);
const FONTS = new URL("fonts/", WORKER);
const SHEET = readFileSync(new URL("korean.css", FONTS), "utf8");
const CSS = readFileSync(new URL("css/microtone.css", WORKER), "utf8");
const SCRIPT = readFileSync(new URL("design-system/fonts/korean.py", REPO), "utf8");

const FACES = [...SHEET.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
  family: /font-family:\s*"([^"]+)"/.exec(body)[1],
  file: /url\("([^"]+)"\)/.exec(body)[1],
  weight: /font-weight:\s*([^;]+);/.exec(body)[1],
  range: /unicode-range:\s*([^;]+);/.exec(body)[1],
}));
const PRETENDARD = FACES.filter((f) => f.family === "Pretendard");
const HANJA_FACE = FACES.find((f) => f.family === "Microtone Hanja");

function parseRange(text) {
  const cps = new Set();
  for (const part of text.split(",")) {
    const [lo, hi] = part.trim().slice(2).split("-").map((h) => parseInt(h, 16));
    for (let cp = lo; cp <= (hi ?? lo); cp++) cps.add(cp);
  }
  return cps;
}

const HANGUL = parseRange(/^HANGUL = \(([^)]*)\)/m.exec(SCRIPT)[1].replace(/"\s*"/g, "").replace(/"/g, ""));
const HANJA = /^HANJA = "([^"]+)"/m.exec(SCRIPT)[1];

test("the sheet declares exactly the files in fonts/korean/, each once, with their licences", () => {
  const files = readdirSync(new URL("korean/pretendard/", FONTS)).filter((f) => f.endsWith(".woff2")).sort();
  assert.deepEqual(PRETENDARD.map((f) => f.file.replace(/^korean\/pretendard\//, "")).sort(), files);
  assert.ok(files.length > 50, `only ${files.length} Pretendard files`);
  assert.equal(HANJA_FACE.file, "korean/hanja.woff2");
  assert.equal(FACES.length, PRETENDARD.length + 1);
  assert.match(readFileSync(new URL("korean/pretendard/OFL.txt", FONTS), "utf8"), /Reserved Font Name Pretendard/);
  assert.match(readFileSync(new URL("korean/OFL-hanja.md", FONTS), "utf8"), /Open Font License/);
});

test("Pretendard is asked for Hangul alone: every syllable, once, from a file that has it", () => {
  const seen = new Map();
  for (const f of PRETENDARD) {
    assert.equal(f.weight, "45 920");
    const range = parseRange(f.range);
    const cmap = cmapOf(readWoff2(new URL(f.file, FONTS)));
    for (const cp of range) {
      assert.ok(HANGUL.has(cp), `${f.file} claims U+${cp.toString(16)}, which is not Hangul`);
      assert.ok(cmap.has(cp), `${f.file} lacks U+${cp.toString(16)} its unicode-range claims`);
      assert.ok(!seen.has(cp), `U+${cp.toString(16)} is in ${seen.get(cp)} and ${f.file}`);
      seen.set(cp, f.file);
    }
  }
  for (let cp = 0xac00; cp <= 0xd7a3; cp++) assert.ok(seen.has(cp), `syllable U+${cp.toString(16)} has no file`);
  for (const ch of "ㄱㅎㅏㅣ「」、。") assert.ok(seen.has(ch.codePointAt(0)), `${ch} has no file`);
});

test("Microtone Hanja holds what it claims, and the claim is the HANJA list", () => {
  const cmap = cmapOf(readWoff2(new URL(HANJA_FACE.file, FONTS)));
  const range = parseRange(HANJA_FACE.range);
  assert.deepEqual([...range].sort(), [...HANJA].map((c) => c.codePointAt(0)).sort());
  for (const cp of range) assert.ok(cmap.has(cp), `hanja.woff2 lacks ${String.fromCodePoint(cp)}`);
});

test("every ideograph the app writes is in Microtone Hanja (or the note grids' Motif)", () => {
  const skip = /(^|\/)(vendor|node_modules|corpus|reference|oracle|test)(\/|$)/;
  const walk = (dir, keep) => existsSync(dir) ? readdirSync(dir, { recursive: true })
    .filter((f) => keep.test(f) && !skip.test(f))
    .map((f) => ({ name: f, text: readFileSync(new URL(f, dir), "utf8") })) : [];
  const files = [
    ...walk(new URL("src/", WORKER), /\.js$/),
    ...walk(new URL("assets/", WORKER), /\.md$/),
    ...walk(new URL("translation/data/", WORKER), /\.json$/),
    ...walk(WORKER, /^[^/]+\.html$/),
    ...walk(new URL("design-system/docs/", REPO), /\.(html|js)$/),
  ];
  assert.ok(files.length > 100, `scanned only ${files.length} files`);
  const have = new Set(HANJA);
  for (const { name, text } of files) {
    // markdown.js's CJK test is a regex class (一-鿿), not text anyone reads.
    const shown = name.endsWith("markdown.js") ? text.replace(/一-鿿/g, "") : text;
    for (const [ch] of shown.matchAll(/[㐀-鿿豈-﫿]/g)) {
      assert.ok(have.has(ch), `${name} writes ${ch}, which Microtone Hanja lacks: add it to HANJA in design-system/fonts/korean.py and rebuild`);
    }
  }
});

test("every font stack names Pretendard and Microtone Hanja right after its own faces", () => {
  assert.match(CSS, /@import url\("\.\.\/fonts\/korean\.css"\);/);
  const stacks = [...CSS.matchAll(/^\s*--((?:ui|cv|mono|transport|code)(?:-\w+)?-font):\s*([^;]+);/gm)];
  assert.equal(stacks.length, 8);
  for (const [, name, value] of stacks) {
    const fams = value.split(",").map((s) => s.trim());
    const at = fams.indexOf('"Pretendard"');
    assert.ok(at > 0, `--${name} lacks Pretendard`);
    assert.equal(fams[at + 1], '"Microtone Hanja"', `--${name}`);
    assert.ok(fams.slice(0, at).every((f) => /^"(Open Sans|Motif) /.test(f)), `--${name}: only its own faces before Pretendard`);
  }
});
