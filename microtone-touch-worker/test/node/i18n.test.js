// Touch's languages: every table says everything en.js says, with the same
// placeholders; every key the code asks for exists; the things named by id —
// presets, drums, layouts, tunings, effects, themes — are named in every
// language; and index.html's early script picks the language i18n.js would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";

import en from "../../src/lang/en.js";
import ko from "../../src/lang/ko.js";
import { LANGS, phoneLang, t, tHtml, html, plural } from "../../src/i18n.js";
import { PRESETS, DRUMS } from "../../core/sketch/pack.js";
import { LAYOUTS } from "../../src/lattice.js";
import { TUNINGS, FX, FX_IDS } from "../../src/sketch.js";
import { message } from "../../src/saving.js";

const SITE = new URL("../../", import.meta.url);
const TABLES = { en, ko };
const read = (path) => readFileSync(new URL(path, SITE), "utf8");
const indexHtml = read("index.html");

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("i18n: every language is registered, and has a table", () => {
  assert.deepEqual(Object.keys(LANGS).sort(), Object.keys(TABLES).sort());
  const files = readdirSync(new URL("src/lang/", SITE)).map((f) => f.replace(/\.js$/, "")).sort();
  assert.deepEqual(files, Object.keys(LANGS).sort(), "src/lang/ holds exactly the registered languages");
});

test("i18n: every language says everything en.js says, and nothing else", () => {
  for (const [code, table] of Object.entries(TABLES)) {
    assert.deepEqual(Object.keys(table).filter((k) => !(k in en)), [], `${code}: keys en.js does not have`);
    assert.deepEqual(Object.keys(en).filter((k) => !(k in table)), [], `${code}: keys missing`);
    for (const [k, v] of Object.entries(table)) {
      assert.equal(typeof v, "string", `${code} ${k}`);
      assert.ok(v.length > 0, `${code} ${k} is empty`);
      assert.deepEqual(placeholders(v), placeholders(en[k]), `${code} ${k}: the same placeholders as en`);
    }
  }
});

test("i18n: a translation is a translation — only notation stays as it is", () => {
  // Codes, marks and figures that read the same in every language.
  const SAME = /\.short$|^cell\.off$|^edit\.fx$|^menu\.bpm$|^tuning\.edo$|^files\.kb$/;
  for (const [code, table] of Object.entries(TABLES)) {
    if (code === "en") continue;
    const untranslated = Object.keys(en).filter((k) => !SAME.test(k) && table[k] === en[k]);
    assert.deepEqual(untranslated, [], `${code}: still in English`);
  }
});

test("i18n: every key the code asks for is in en.js", () => {
  // A string literal whose first segment is one of the tables' sections is a
  // key (or a count's, whose forms are key.one, key.other…); keys built from
  // an id are checked by the next test.
  const sections = new Set(Object.keys(en).map((k) => k.split(".")[0]));
  const src = new URL("src/", SITE);
  const missing = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(new URL(file, src), "utf8");
    for (const [, key] of text.matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9-]+)+)"/g)) {
      if (sections.has(key.split(".")[0]) && !(key in en) && !(`${key}.other` in en)) missing.push(`${file}: ${key}`);
    }
  }
  for (const [, key] of indexHtml.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)) {
    if (!(key in en)) missing.push(`index.html: ${key}`);
  }
  assert.deepEqual(missing, []);
});

test("i18n: everything named by its id is named in every language", () => {
  const keys = [
    ...PRESETS.flatMap((p) => [`preset.${p.id}`, `preset.${p.id}.short`]),
    ...DRUMS.flatMap((d) => [`drum.${d.id}`, `drum.${d.id}.short`]),
    ...LAYOUTS.flatMap((l) => [`layout.${l.id}`, `layout.${l.id}.short`]),
    ...TUNINGS.filter((tu) => !/^\d+$/.test(tu.id)).map((tu) => `tuning.${tu.id}`),
    ...FX_IDS.map((id) => `fx.${id}`),
    ...FX.slide.args.map((_, i) => `fx.level${i}`),
    ...["system", "dark", "dim", "light"].map((id) => `theme.${id}`),
  ];
  for (const k of keys) assert.ok(k in en, k);
  for (const id of FX_IDS) assert.equal(FX[id].args.length, FX.slide.args.length, `${id} has as many levels`);
});

test("i18n: every failure with a sentence of its own gets that sentence", () => {
  for (const k of Object.keys(en).filter((k) => k.startsWith("err.") && k !== "err.other")) {
    assert.equal(message(k.slice(4)), en[k], k);
  }
  assert.equal(message("teapot"), "The server said no (teapot).");
});

test("i18n: index.html's own words are en.js's", () => {
  // What the page says before a script runs (and with none) is English.
  for (const [, key, text] of indexHtml.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    assert.equal(text, en[key], `index.html ${key}`);
  }
  for (const m of indexHtml.matchAll(/<[^>]*\bdata-i18n-(aria|title)="[^"]+"[^>]*>/g)) {
    const tag = m[0];
    for (const [, which, key] of tag.matchAll(/data-i18n-(aria|title)="([^"]+)"/g)) {
      const attr = which === "aria" ? "aria-label" : "title";
      const value = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag)?.[1];
      assert.equal(value, en[key], `index.html ${attr} of ${key}`);
    }
  }
});

test("i18n: t fills placeholders, and falls back to English, then to the key", () => {
  assert.equal(t("keys.lane", { n: 3 }), "Lane 3");
  assert.equal(t("no.such.key"), "no.such.key");
  assert.equal(plural("files.sections", 1), "1 section");
  assert.equal(plural("files.sections", 2), "2 sections");
});

test("i18n: tHtml escapes the string and its parameters, but for html()", () => {
  assert.equal(tHtml("save.savedLocal", { name: `<i>"a" & b</i>` }), "Saved “&lt;i&gt;&quot;a&quot; &amp; b&lt;/i&gt;” on this phone.");
  assert.equal(tHtml("files.signedInAs", { name: html("<b>x</b>") }), "Signed in as <b>x</b>");
});

test("i18n: the phone's own language, else English", () => {
  assert.equal(phoneLang(["ko-KR", "en-US"]), "ko");
  assert.equal(phoneLang(["fr-FR", "ko"]), "ko");
  assert.equal(phoneLang(["en-GB", "ko-KR"]), "en");
  assert.equal(phoneLang(["de", "fr"]), "en");
  assert.equal(phoneLang(["KO_kr"]), "ko");
  assert.equal(phoneLang([]), "en");
});

/** index.html's inline scripts, found by what they keep. */
function inlineScript(marker) {
  const bodies = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).filter((s) => s.includes(marker));
  assert.equal(bodies.length, 1, `one inline script keeps ${marker}`);
  return bodies[0];
}

/** Run the early script as a page about to paint would, and → <html lang>. */
function earlyLang({ saved = null, languages = [], blocked = false }) {
  const root = { dataset: {}, lang: "en" };
  const storage = {
    getItem(k) {
      if (blocked) throw new Error("SecurityError");
      return k === "microtone-touch:lang" ? saved : null;
    },
  };
  runInNewContext(inlineScript("microtone-touch:lang"), {
    localStorage: storage,
    navigator: { languages, language: languages[0] },
    matchMedia: () => ({ matches: false }),
    document: { documentElement: root },
  });
  return root.lang;
}

test("i18n: index.html's early script picks the language i18n.js picks", () => {
  const cases = [
    { languages: ["ko-KR"] }, { languages: ["en-US", "ko-KR"] }, { languages: ["ja-JP", "ko"] },
    { languages: ["de-DE"] }, { languages: [] },
    { saved: "en", languages: ["ko-KR"] }, { saved: "ko", languages: ["en-GB"] },
    { saved: "xx", languages: ["ko-KR"] }, { blocked: true, languages: ["ko-KR"] },
  ];
  for (const c of cases) {
    const want = Object.hasOwn(LANGS, c.saved ?? "") && !c.blocked ? c.saved : phoneLang(c.languages);
    assert.equal(earlyLang(c), want, JSON.stringify(c));
  }
  const listed = /var LANGS = (\[[^\]]*\]);/.exec(inlineScript("microtone-touch:lang"))?.[1];
  assert.deepEqual(JSON.parse(listed), Object.keys(LANGS), "the early script's LANGS is i18n.js's");
});

/** The veil's early words, as index.html's second script carries them. */
function earlyWords() {
  const script = inlineScript("var EARLY");
  const words = {};
  for (const [, key, forms] of script.matchAll(/"([\w.]+)": (\{[^}]*\})/g)) {
    words[key] = JSON.parse(forms.replace(/(\w+):/g, '"$1":'));
  }
  return { script, words };
}

/** Run that script at `url` with <html lang> at `lang`; → what it did. */
function runVeil(lang, url = "/") {
  const { script } = earlyWords();
  const veilHtml = /<div id="startVeil"[\s\S]*?<\/div>/.exec(indexHtml)[0];
  const parts = [...veilHtml.matchAll(/data-i18n="([^"]+)"/g)].map(([, key]) => ({ key, textContent: "" }));
  const el = {
    startHint: { textContent: "" },
    veilNote: { hidden: true, querySelectorAll: () => parts.map((p) => ({ getAttribute: () => p.key, set textContent(v) { p.textContent = v; } })) },
  };
  const [path, search = ""] = url.split("?");
  let replaced = null;
  runInNewContext(script, {
    document: { documentElement: { lang }, getElementById: (id) => el[id] },
    location: { pathname: path, search: search ? `?${search}` : "", hash: "" },
    history: { state: null, replaceState: (_, __, to) => { replaced = to; } },
  });
  return { hint: el.startHint.textContent, noteShown: !el.veilNote.hidden, parts, replaced };
}

test("i18n: the veil speaks the page's language before any module runs", () => {
  const { words } = earlyWords();
  assert.ok(words["veil.loading"], "Loading… is among them");
  for (const [key, forms] of Object.entries(words)) {
    assert.deepEqual(Object.keys(forms).sort(), Object.keys(LANGS).sort(), `${key} in every language`);
    for (const [code, text] of Object.entries(forms)) assert.equal(text, TABLES[code][key], `${code} ${key}`);
  }
  for (const lang of [...Object.keys(LANGS), "xx"]) {
    const table = TABLES[lang] ?? en;
    const { hint, noteShown, replaced } = runVeil(lang);
    assert.equal(hint, table["veil.loading"], lang);
    assert.ok(!noteShown && replaced === null, `${lang}: no note, and the address untouched, unless redirected`);
  }
});

test("i18n: sent by microtone.cc's redirect, the veil says so — once — and offers the tracker", () => {
  for (const lang of Object.keys(LANGS)) {
    const { noteShown, parts, replaced } = runVeil(lang, "/?from=tracker");
    assert.ok(noteShown, lang);
    assert.ok(parts.length >= 2);
    for (const p of parts) assert.equal(p.textContent, TABLES[lang][p.key], `${lang} ${p.key}`);
    assert.equal(replaced, "/", "the parameter is spent");
  }
  assert.ok(!runVeil("en", "/?from=trackers").noteShown, "only the whole parameter");
  const link = /<p class="veil-note"[\s\S]*?<\/p>/.exec(indexHtml)[0];
  assert.match(link, /href="https:\/\/microtone\.cc\/\?tracker=1"/);
});

test("i18n: every link to Microtone asks for the tracker, or a phone is sent straight back", () => {
  const links = [indexHtml, read("src/about.js")].flatMap((text) =>
    [...text.matchAll(/https:\/\/microtone\.cc\/[^"'\s)]*/g)].map((m) => m[0]));
  assert.ok(links.length >= 3, "the veil's note, the menu and About");
  for (const href of links) assert.equal(href, "https://microtone.cc/?tracker=1");
});
