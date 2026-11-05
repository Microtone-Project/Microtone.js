// The Motif fonts (item 220) as the site ships them: fonts/*.woff2, built by
// design-system/fonts/build.py from Chivo Mono and committed. These tests read
// the WOFF2 files themselves (WOFF2 is brotli, which node:zlib speaks) and pin
// what the app relies on: that Motif Grid has every character the cell painter
// writes and nothing else, at the cell widths the painter assumes; that the
// transport and code faces carry the widths motif.toml asks for — so a config
// edit that was never rebuilt fails here; that every face is variable on
// weight; and that the stylesheet declares each file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MOTIF, MUSIC, motifCells } from "../../core/fonts/motifglyphs.js";
import { readWoff2 as readWoff2At, cmapOf, advancesOf } from "../fixtures/woff2.js";

const FONTS = new URL("../../core/fonts/", import.meta.url);
const CONFIG = readFileSync(new URL("../../../design-system/fonts/motif.toml", import.meta.url), "utf8");
const LU = "黃大太夾姑仲蕤林夷南無應";
const CELL = 600;

const readWoff2 = (name) => readWoff2At(new URL(name, FONTS));

function weightAxis(t) {
  const f = t.fvar;
  const axesOff = f.readUInt16BE(4), count = f.readUInt16BE(8), size = f.readUInt16BE(10);
  for (let i = 0; i < count; i++) {
    const a = axesOff + i * size;
    if (f.toString("latin1", a, a + 4) === "wght") {
      return [f.readInt32BE(a + 4), f.readInt32BE(a + 8), f.readInt32BE(a + 12)].map((v) => v / 65536);
    }
  }
  return null;
}

function face(name) {
  const t = readWoff2(name);
  const cmap = cmapOf(t);
  const adv = advancesOf(t);
  return { t, cmap, width: (ch) => adv[cmap.get(ch.codePointAt(0))] };
}

/** A number from motif.toml: `key = N` inside `[section]`. */
function config(section, key) {
  const body = CONFIG.split(/^\[/m).find((s) => s.startsWith(section + "]"));
  const m = body.match(new RegExp(`^${key}\\s*=\\s*([^#\\n]+)`, "m"));
  return JSON.parse(m[1].trim());
}

const ascii = [...Array(0x7f - 0x20)].map((_, i) => String.fromCharCode(0x20 + i));

// ── the tests ──

test("Motif Grid carries every character the cell painter writes, at the widths it lays out", () => {
  const g = face("motif-grid.woff2");
  for (const ch of ascii) assert.equal(g.width(ch), CELL, `U+${ch.codePointAt(0).toString(16)} is one cell`);
  for (const ch of ["·", "−"]) assert.equal(g.width(ch), CELL, `${ch} is one cell`);
  for (const [name, ch] of Object.entries(MOTIF)) {
    assert.equal(g.width(ch), motifCells(ch) * CELL, `${name} is ${motifCells(ch)} cell(s)`);
  }
  for (const [name, ch] of Object.entries(MUSIC)) assert.equal(g.width(ch), CELL, `${name} is one cell`);
  for (const ch of LU) assert.equal(g.width(ch), 2 * CELL, `${ch} is two cells`);
});

test("Motif Grid has no character it was not asked for (ASCII + · − + its symbols + the lü)", () => {
  const g = face("motif-grid.woff2");
  const wanted = new Set([...ascii, "·", "−", ...Object.values(MOTIF), ...Object.values(MUSIC), ...LU]
    .map((ch) => ch.codePointAt(0)));
  const extra = [...g.cmap.keys()].filter((cp) => !wanted.has(cp));
  assert.deepEqual(extra.map((cp) => cp.toString(16)), []);
});

test("Motif Transport is ASCII, every glyph and its cell as narrow as motif.toml says", () => {
  const tr = face("motif-transport.woff2");
  const cell = Math.round(CELL * (1 - config("transport", "narrow") / 100));
  assert.deepEqual([...tr.cmap.keys()].sort((a, b) => a - b), ascii.map((c) => c.charCodeAt(0)));
  for (const ch of ascii) assert.equal(tr.width(ch), cell, `"${ch}"`);
});

test("Motif Code: i I l narrow, M m W w wide, digits and punctuation on the cell — the italic too", () => {
  const narrow = Math.round(CELL * config("code", "narrow_factor"));
  const wide = Math.round(CELL * config("code", "wide_factor"));
  const roman = face("motif-code.woff2");
  const italic = face("motif-code-italic.woff2");
  for (const f of [roman, italic]) {
    for (const ch of "iIlíĺı") assert.equal(f.width(ch), narrow, `${ch} narrow`);
    for (const ch of "MmWwŵŴ") assert.equal(f.width(ch), wide, `${ch} wide`);
    for (const ch of "0123456789 .,;:()[]{}<>+-*/=_#$%&!?'\"`|\\~^@aeoxzAEOXZ") {
      assert.equal(f.width(ch), CELL, `"${ch}" on the cell`);
    }
    assert.equal(f.width(MUSIC.SHARP), CELL);
    assert.equal(f.width(LU[0]), 2 * CELL);
    assert.equal(f.width("—"), config("code", "emdash_advance"), "the em dash's wider cell");
  }
  // The editor lays its textarea over a highlighted <pre> whose tokens may be
  // italic: a character must measure the same in both.
  for (const [cp, gid] of roman.cmap) {
    if (!italic.cmap.has(cp) || cp < 0x20) continue;
    const ch = String.fromCodePoint(cp);
    assert.equal(italic.width(ch), roman.width(ch), `U+${cp.toString(16)} (gid ${gid}) roman = italic`);
  }
});

test("Motif Mono is Motif Code with every letter on the cell: the same characters, strictly monospaced", () => {
  const mono = face("motif-mono.woff2");
  const code = face("motif-code.woff2");
  assert.deepEqual([...mono.cmap.keys()].sort((a, b) => a - b), [...code.cmap.keys()].sort((a, b) => a - b));
  for (const cp of mono.cmap.keys()) {
    const ch = String.fromCodePoint(cp);
    const w = mono.width(ch);
    // Zero-width controls and marks, one cell, or two for an ideograph.
    assert.ok(w === 0 || w === CELL || (w === 2 * CELL && LU.includes(ch)), `U+${cp.toString(16)} is ${w}`);
  }
  for (const ch of "iIlMmWw0O") assert.equal(mono.width(ch), CELL, `${ch} on the cell`);
});

test("every Motif face is variable on weight, Thin to Black", () => {
  for (const name of ["motif-grid.woff2", "motif-transport.woff2", "motif-code.woff2", "motif-code-italic.woff2",
    "motif-mono.woff2"]) {
    assert.deepEqual(weightAxis(readWoff2(name)), [100, 500, 900], name);
  }
});

test("the stylesheet declares each face, and the licence travels with them", () => {
  const css = readFileSync(new URL("../../css/microtone.css", import.meta.url), "utf8");
  for (const [family, file, style] of [["Motif Grid", "motif-grid", "normal"], ["Motif Transport", "motif-transport", "normal"],
    ["Motif Code", "motif-code", "normal"], ["Motif Code", "motif-code-italic", "italic"],
    ["Motif Mono", "motif-mono", "normal"]]) {
    const rule = css.match(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*"${family}";[^}]*${file}\\.woff2[^}]*}`));
    assert.ok(rule, `${file}.woff2 declared as "${family}"`);
    assert.match(rule[0], new RegExp(`font-style:\\s*${style}`));
    assert.match(rule[0], /font-weight:\s*100 900/);
  }
  assert.match(css, /--cv-font:\s*"Motif Grid"/, "the grids draw in Motif Grid");
  assert.match(css, /--mono-font:\s*"Motif Mono"/, "values and readouts are Motif Mono");
  const ofl = readFileSync(new URL("OFL.txt", FONTS), "utf8");
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(ofl, /Chivo Project Authors/);
  assert.match(ofl, /Tamcy/);
});

test("Chivo Mono and Roboto Mono are retired: no page of either app asks for them", () => {
  const files = [
    "../../css/microtone.css", "../../docs.html", "../../index.html", "../../player.html",
    "../../../microtone-touch-worker/css/touch.css", "../../../microtone-touch-worker/index.html",
  ];
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    // A family named in a stack, or fetched from Google Fonts (the comments
    // may still say what Motif was made from).
    assert.doesNotMatch(text, /["'](Chivo|Roboto) Mono["']|family=(Chivo|Roboto)\+Mono/, f);
  }
});

test("Microtone Touch spells its notes in Motif Grid, from the shared fonts", () => {
  const css = readFileSync(new URL("../../../microtone-touch-worker/css/touch.css", import.meta.url), "utf8");
  assert.match(css, /@font-face\s*{[^}]*font-family:\s*"Motif Grid";[^}]*url\("\.\.\/core\/fonts\/motif-grid\.woff2"\)/);
  assert.match(css, /--note-font:\s*"Motif Grid"/);
});
