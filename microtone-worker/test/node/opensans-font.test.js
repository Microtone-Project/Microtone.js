// Open Sans as the tracker serves it: static families, one per width, baked by
// design-system/fonts/opensans.py into fonts/open-sans/ with the @font-face
// rules in fonts/open-sans.css, so every browser gets the same files (Google
// Fonts sent the desktop app's Linux webview static files at three named
// widths, without the ones the app uses). The fonts have no axes, so the rule
// these tests keep is that NO page picks a width or a weight through a font
// variation: every width is a family of its own, named by a --ui-*font token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

import { readWoff2, cmapOf, advancesOf } from "../fixtures/woff2.js";

const WORKER = new URL("../../", import.meta.url);
const REPO = new URL("../", WORKER);
const FONTS = new URL("fonts/", WORKER);
const SHEET = readFileSync(new URL("open-sans.css", FONTS), "utf8");
const CSS = readFileSync(new URL("css/microtone.css", WORKER), "utf8");
const WEIGHTS = [400, 500, 600, 700, 800];

const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The generated sheet's faces. */
const FACES = [...SHEET.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
  family: /font-family:\s*"([^"]+)"/.exec(body)[1],
  file: /url\("([^"]+)"\)/.exec(body)[1],
  weight: +/font-weight:\s*(\d+);/.exec(body)[1],
  style: /font-style:\s*(\w+);/.exec(body)[1],
  range: /unicode-range:\s*([^;]+);/.exec(body)[1],
}));

function parseRange(text) {
  const cps = new Set();
  for (const part of text.split(",")) {
    const [lo, hi] = part.trim().slice(2).split("-").map((h) => parseInt(h, 16));
    for (let cp = lo; cp <= (hi ?? lo); cp++) cps.add(cp);
  }
  return cps;
}

/** Every text file under `dir` (a URL) whose name passes `keep`. */
function walk(dir, keep, skip = /(^|\/)(vendor|node_modules|corpus|reference|oracle)(\/|$)/) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((f) => keep.test(f) && !skip.test(f))
    .map((f) => ({ name: new URL(f, dir).pathname.slice(REPO.pathname.length), text: readFileSync(new URL(f, dir), "utf8") }));
}

test("the sheet declares exactly the files in fonts/open-sans/, each once", () => {
  const files = readdirSync(new URL("open-sans/", FONTS)).filter((f) => f.endsWith(".woff2")).sort();
  const declared = FACES.map((f) => f.file.replace(/^open-sans\//, "")).sort();
  assert.deepEqual(declared, files);
  assert.ok(existsSync(new URL("open-sans/OFL.txt", FONTS)), "the licence ships beside the fonts");
});

test("every family has every weight, upright and italic, as a Latin file and an ext file", () => {
  const families = [...new Set(FACES.map((f) => f.family))];
  assert.deepEqual(families.sort(), ["Open Sans W100", "Open Sans W75", "Open Sans W87", "Open Sans W96"]);
  for (const family of families) {
    for (const weight of WEIGHTS) {
      for (const style of ["normal", "italic"]) {
        const parts = FACES.filter((f) => f.family === family && f.weight === weight && f.style === style);
        assert.equal(parts.length, 2, `${family} ${weight} ${style}`);
        const [a, b] = parts.map((p) => parseRange(p.range));
        assert.ok([...a].every((cp) => !b.has(cp)), `${family} ${weight} ${style}: the two files' ranges overlap`);
        assert.ok(a.has(0x61) || b.has(0x61));
      }
    }
  }
});

test("each file is a STATIC font at the weight, style and character range the sheet declares", () => {
  for (const f of FACES) {
    const t = readWoff2(new URL(f.file, FONTS));
    assert.ok(!t.fvar && !t.gvar, `${f.file} is still variable`);
    assert.equal(t["OS/2"].readUInt16BE(4), f.weight, `${f.file}: usWeightClass`);
    assert.equal(!!(t["OS/2"].readUInt16BE(62) & 1), f.style === "italic", `${f.file}: fsSelection ITALIC`);
    const range = parseRange(f.range);
    const cmap = cmapOf(t);
    for (const cp of cmap.keys()) {
      if (cp > 0x20) assert.ok(range.has(cp), `${f.file} maps U+${cp.toString(16)} outside its unicode-range`);
    }
    // Every character a face promises is really in it (or the page shows a
    // fallback for it while the right file sits unused).
    for (const cp of range) assert.ok(cmap.has(cp), `${f.file} lacks U+${cp.toString(16)} its unicode-range claims`);
  }
});

test("the families really are four widths: W75 < W87 < W96 < W100 at every weight", () => {
  const widthOf = (family, weight) => {
    const f = FACES.find((x) => x.family === family && x.weight === weight && x.style === "normal" && /latin/.test(x.file));
    const t = readWoff2(new URL(f.file, FONTS));
    const cmap = cmapOf(t), adv = advancesOf(t);
    return [..."abcdefghijklmnopqrstuvwxyz"].reduce((s, ch) => s + adv[cmap.get(ch.codePointAt(0))], 0);
  };
  for (const weight of WEIGHTS) {
    const w = ["W75", "W87", "W96", "W100"].map((k) => widthOf(`Open Sans ${k}`, weight));
    for (let i = 1; i < w.length; i++) assert.ok(w[i] > w[i - 1], `weight ${weight}: ${w.join(" < ")}`);
  }
});

test("the --ui-*font tokens name exactly the baked families, and the stylesheet imports them", () => {
  const tokens = Object.fromEntries([...CSS.matchAll(/--(ui(?:-\w+)?-font):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(tokens).sort(), ["ui-condensed-font", "ui-font", "ui-full-font", "ui-small-font"]);
  assert.deepEqual(Object.values(tokens).sort(), [...new Set(FACES.map((f) => f.family))].sort());
  assert.match(CSS, /@import url\("\.\.\/fonts\/open-sans\.css"\);/);
});

test("no page picks a face through a font variation, or names Open Sans past its token", () => {
  const files = [
    ...walk(new URL("css/", WORKER), /\.css$/),
    ...walk(new URL("about/", WORKER), /\.(css|html|js)$/),
    ...walk(new URL("translation/", WORKER), /\.(css|html)$/),
    ...walk(new URL("src/", WORKER), /\.(js|css|html)$/),
    ...walk(WORKER, /^[^/]+\.html$/),
    ...walk(new URL("design-system/docs/", REPO), /\.(css|html|js)$/),
    ...walk(new URL("microtone-touch-worker/css/", REPO), /\.css$/),
    ...walk(new URL("microtone-touch-worker/src/", REPO), /\.js$/),
    ...walk(new URL("microtone-touch-worker/", REPO), /^[^/]+\.html$/),
  ];
  assert.ok(files.length > 100, `scanned only ${files.length} files`);
  for (const { name, text } of files) {
    const code = /\.css$/.test(name) ? uncomment(text) : text;
    assert.doesNotMatch(code, /font-variation-settings\s*:|fontVariationSettings|font-optical-sizing\s*:/,
      `${name} uses a font variation — the chrome's fonts are static; use a --ui-*font token`);
    assert.doesNotMatch(code, /fonts\.googleapis\.com\/[^"')]*Open\+Sans/, `${name} fetches Open Sans from Google Fonts`);
    for (const m of code.matchAll(/"Open Sans[^"]*"/g)) {
      const line = code.slice(code.lastIndexOf("\n", m.index) + 1, code.indexOf("\n", m.index));
      assert.match(line, /^\s*--ui(?:-\w+)?-font:/, `${name} names ${m[0]} outside its token: ${line.trim()}`);
    }
  }
});
