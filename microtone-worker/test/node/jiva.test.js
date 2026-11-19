// Item 348 — Jiva: lyric instruments that sing gibberish, written in Eri's
// marks (* a drawn syllable, ( a drawn onset, ) a drawn coda; src/doc/jiva.js).
//
// What is pinned here: the grammar (what each mark draws, what it refuses);
// the draw is reproducible (the same lyrics and seed sing the same syllables,
// a draw is keyed by its syllable and part, not by its neighbours); every
// draw is a syllable a lyric instrument can sing; the seed is kept in the
// ILyr entry's editor part — and written only when it is not 0, so lyrics
// without one keep the layout earlier versions wrote; and the notation switch
// carries the marks across.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as F from "../../core/engine/formant.js";
import {
  parseLyricSection, buildLyricEntry, blankSyllable, blankLyricEditor, LYRIC_ED_SEED,
} from "../../core/format/lyric-section.js";
import { deriveLyrics, readLyrics } from "../../src/doc/lyrics.js";
import {
  eriOf, expandEri, hasEri, nextSeed, ERI_ONSETS, ERI_VOWELS, ERI_CODAS, JIVA_LYRICS, JIVA_SEED_MAX,
} from "../../src/doc/jiva.js";
import { readIpaSyllable, ipaToXsampa, xsampaToIpa } from "../../src/motif/syllable.js";
import { keyedRandom } from "../../src/motif/stdlib.js";

const ONSETS = new Set(ERI_ONSETS.map(([x]) => x));
const VOWELS = new Set(ERI_VOWELS.map(([x]) => x));
const CODAS = new Set(ERI_CODAS.map(([x]) => x));

/** Split a drawn [onset][vowel][coda] back into its parts by the tables. */
function parts(ipa) {
  for (const v of VOWELS) {
    const at = ipa.indexOf(v);
    if (at >= 0) return { onset: ipa.slice(0, at), vowel: v, coda: ipa.slice(at + v.length) };
  }
  return null;
}

test("every entry of the tables is a sound a lyric instrument can say, in the place it is drawn for", () => {
  for (const o of ONSETS) {
    const s = readIpaSyllable(`${o}a`);
    assert.ok(s.onset.length > 0 || s.glide !== 0, `[${o}] is an onset`);
    assert.equal(s.coda, 0);
  }
  for (const v of VOWELS) assert.notEqual(readIpaSyllable(v).vowel, null, `[${v}] is a vowel`);
  for (const c of CODAS) {
    const s = readIpaSyllable(`a${c}`);
    assert.notEqual(s.coda, 0, `[${c}] is a coda`);
    assert.deepEqual(s.onset, []);
  }
  for (const table of [ERI_ONSETS, ERI_VOWELS, ERI_CODAS]) {
    for (const [, w] of table) assert.ok(Number.isInteger(w) && w > 0);
  }
});

test("what each mark draws", () => {
  const seed = 77;
  const at = (tok, i = 3) => parts(expandEri(tok, i, seed));
  // * : onset, vowel, coda
  const whole = at("*");
  assert.ok(ONSETS.has(whole.onset) && CODAS.has(whole.coda), JSON.stringify(whole));
  // ( : onset + vowel; ) : vowel + coda — no more
  const open = at("(");
  assert.ok(ONSETS.has(open.onset) && open.coda === "", JSON.stringify(open));
  const close = at(")");
  assert.ok(close.onset === "" && CODAS.has(close.coda), JSON.stringify(close));
  // the written part stays as written
  assert.match(expandEri("(e", 3, seed), /e$/);
  assert.match(expandEri("(e)", 3, seed), /e[^e]+$/);
  assert.match(expandEri("e)", 3, seed), /^e/);
  assert.match(expandEri("(ek", 3, seed), /ek$/);
  assert.match(expandEri("ke)", 3, seed), /^ke/);
  // a syllable with no mark is not Eri's
  assert.equal(expandEri("ka", 3, seed), null);
  assert.equal(eriOf("ka"), null);
  assert.deepEqual(eriOf("*"), { onset: true, coda: true, middle: "" });
  assert.deepEqual(eriOf("(a)"), { onset: true, coda: true, middle: "a" });
  assert.ok(hasEri("la (a") && !hasEri("la la"));
});

test("a draw is keyed by its syllable and its part: the same everywhere, and its neighbours do not move it", () => {
  const seed = 2026;
  // the same lyrics and seed sing the same syllables
  assert.deepEqual(readLyrics(JIVA_LYRICS, false, seed), readLyrics(JIVA_LYRICS, false, seed));
  // the vowel written into a ( keeps its drawn onset; a ) keeps the drawn vowel
  const o = parts(expandEri("(", 5, seed));
  assert.equal(expandEri(`(${"u"}`, 5, seed), `${o.onset}u`);
  const c = parts(expandEri(")", 5, seed));
  assert.equal(expandEri("(", 5, seed).endsWith(c.vowel), true, "( and ) draw syllable 5's vowel alike");
  // an edit of one syllable leaves the draws of the others alone
  const a = readLyrics("*.*.*.*", false, seed).syllables.map((s) => s.ipa);
  const b = readLyrics("*.ka.*.*", false, seed).syllables.map((s) => s.ipa);
  assert.deepEqual([a[0], a[2], a[3]], [b[0], b[2], b[3]]);
  // the draw is TML's keyed hash of (seed, [syllable, part]), weighted
  const u = keyedRandom(seed, [5, "vowel"]);
  const total = ERI_VOWELS.reduce((n, [, w]) => n + w, 0);
  let x = u * total, want = null;
  for (const [v, w] of ERI_VOWELS) { if (x < w) { want = v; break; } x -= w; }
  assert.equal(c.vowel, want);
  // another seed is another draw
  const other = readLyrics("*.*.*.*.*.*.*.*", false, seed + 1).syllables.map((s) => s.ipa);
  assert.notDeepEqual(readLyrics("*.*.*.*.*.*.*.*", false, seed).syllables.map((s) => s.ipa), other);
});

test("draws cover the tables and every one is sung", () => {
  const rec = new F.FormantPatch();
  const seen = { onset: new Set(), vowel: new Set(), coda: new Set() };
  const text = Array.from({ length: 4000 }, () => "*").join(".");
  const { entry, errors } = deriveLyrics(rec, { ...blankLyricEditor(), text, seed: 5 });
  assert.deepEqual(errors, []);
  assert.equal(entry.syllables.length, 4000);
  for (const { ipa } of readLyrics(text, false, 5).syllables) {
    const p = parts(ipa);
    seen.onset.add(p.onset); seen.vowel.add(p.vowel); seen.coda.add(p.coda);
  }
  assert.deepEqual([...seen.onset].sort(), [...ONSETS].sort());
  assert.deepEqual([...seen.vowel].sort(), [...VOWELS].sort());
  assert.deepEqual([...seen.coda].sort(), [...CODAS].sort());
  for (const s of entry.syllables) assert.ok(s.vowel && s.cons[2] !== 0 && (s.cons[0] !== 0 || (s.gr & 7) !== 0));
});

test("a new lyric instrument's lyrics read, and the marks say what is wrong with them", () => {
  assert.deepEqual(JIVA_LYRICS.split("\n"), ["a.(.(.*.( | *.(.).(", "d͡ʒɪ.va.ɛ.ɾɪ.ɸʊ", "*.*.( | (.(.(.* | *.("]);
  for (const seed of [0, 1, JIVA_SEED_MAX]) {
    const { syllables, errors } = readLyrics(JIVA_LYRICS, false, seed);
    assert.deepEqual(errors, []);
    assert.equal(syllables.length, 9 + 5 + 9, "a line break separates syllables");
    assert.deepEqual(syllables.map((s) => s.drawn).slice(9, 14), [false, false, false, false, false], "the middle line is written out");
  }
  const bad = (text) => readLyrics(text).errors.map((e) => e.message);
  assert.match(bad("(pa")[0], /own consonants before the vowel/);
  assert.match(bad("ak)")[0], /own consonant after the vowel/);
  assert.match(bad("(ja")[0], /own consonants before the vowel/, "a glide is part of the onset");
  assert.match(bad("a(")[0], /opens the syllable/);
  assert.match(bad(")a")[0], /closes the syllable/);
  assert.match(bad("*a")[0], /stands alone/);
  assert.match(bad("(n)")[0], /no vowel/);
  assert.match(bad("(ʘa")[0], /not a sound/);
});

test("the seed is kept in the editor part, and only when it is not 0", () => {
  const rec = new F.FormantPatch();
  const ed = { ...blankLyricEditor(), text: "*.(a.ko)", converge: 30, sylOverrides: [{ index: 1, timing: 100 }] };
  const plain = deriveLyrics(rec, ed).entry;
  plain.instId = 3;
  const plainBytes = buildLyricEntry(plain);
  const drawn = deriveLyrics(rec, { ...ed, seed: 0x89abcdef }).entry;
  drawn.instId = 3;
  const drawnBytes = buildLyricEntry(drawn);
  assert.equal(drawnBytes.length, plainBytes.length + 4);
  const tail = 6 + 4 + 3 * 12;
  assert.equal(plainBytes[tail] & LYRIC_ED_SEED, 0, "no seed, no flag: the layout every earlier version wrote");
  assert.equal(drawnBytes[tail] & LYRIC_ED_SEED, LYRIC_ED_SEED);
  for (const [bytes, e] of [[plainBytes, plain], [drawnBytes, drawn]]) {
    const back = parseLyricSection(bytes).entries.get(3);
    assert.deepEqual(back.editor, e.editor);
    assert.deepEqual(back.syllables, e.syllables);
    // re-derived from what was saved, the draw is the one saved
    assert.deepEqual(deriveLyrics(rec, back.editor).entry.syllables, e.syllables);
  }
  assert.notDeepEqual(drawn.syllables, plain.syllables);
  assert.equal(parseLyricSection(drawnBytes).entries.get(3).editor.text, "*.(a.ko)");
  // an old entry (no seed) reads as seed 0
  const s = blankSyllable();
  const old = buildLyricEntry({ instId: 4, syllables: [s], recipes: [], editor: { ...blankLyricEditor(), text: "*" } });
  assert.equal(parseLyricSection(old).entries.get(4).editor.seed, 0);
});

test("Draw again picks another seed, never 0", () => {
  let k = 0;
  const seq = [0, 0, 0.5, 0.5, 0.25];
  const rnd = () => seq[k++];
  assert.equal(nextSeed(1, rnd), Math.floor(0.5 * JIVA_SEED_MAX) + 1, "a draw of the current seed (1) is skipped");
  for (let i = 0; i < 50; i++) {
    const s = nextSeed(7);
    assert.ok(Number.isInteger(s) && s >= 1 && s <= JIVA_SEED_MAX && s !== 7);
  }
});

test("X-SAMPA lyrics draw as their IPA do, and the notation switch keeps the marks", () => {
  const ipa = "(ɛ.*.dɔ).(a) | )";
  const xs = ipaToXsampa(ipa);
  assert.ok(xs.ok, "the marks are no reason to call the switch lossy");
  assert.equal(xs.text, "(E.*.dO).(a) | )");
  const a = readLyrics(ipa, false, 9).syllables.map((s) => s.ipa);
  const b = readLyrics(xs.text, true, 9).syllables.map((s) => s.ipa);
  assert.deepEqual(b, a);
  assert.equal(xsampaToIpa("d_Z"), "d͡ʒ");
});

test("the User Manual lists what is drawn, as the tables have it, commonest first", async () => {
  const { readFileSync } = await import("node:fs");
  const manual = readFileSync(new URL("../../assets/USER_MANUAL.md", import.meta.url), "utf8");
  const row = (name) => {
    const line = manual.split("\n").find((l) => l.startsWith(`| ${name} | `));
    assert.ok(line, `the manual's ${name} row`);
    return [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  };
  const byWeight = (table) => table.map(([x, w], i) => [x, w, i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([x]) => x);
  const singles = ERI_ONSETS.filter(([x]) => [...readIpaSyllable(`${x}a`).onset].length + (readIpaSyllable(`${x}a`).glide ? 1 : 0) === 1);
  const clusters = ERI_ONSETS.filter((e) => !singles.includes(e));
  assert.deepEqual(row("Onset"), [...byWeight(singles), ...clusters.map(([x]) => x)]);
  assert.deepEqual(row("Vowel"), byWeight(ERI_VOWELS));
  assert.deepEqual(row("Coda"), byWeight(ERI_CODAS));
});
