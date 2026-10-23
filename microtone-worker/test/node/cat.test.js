// The translation workbench (translation/, src/cat/): reading and rewriting
// the language tables without disturbing them, the translation memory, the
// glossary builder, the checks, the project's unsaved layer and the files a
// save writes, the write-back server's allowlist, and the staging that puts
// Touch's tables beside the page on microtone.cc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { parseLangFile, langValues, writeLangFile, newLangFile, encodeLiteral, decodeLiteral } from "../../src/cat/langfile.js";
import { placeholders, codes, numbers, lemma, wordDiff, tokens } from "../../src/cat/text.js";
import { TranslationMemory, concordance } from "../../src/cat/tm.js";
import { extractTerms, alignTerms, findTerms, targetHasTerm, termKey, targetCandidates } from "../../src/cat/glossary.js";
import { runChecks } from "../../src/cat/checks.js";
import { Project, stringifyData, parseData, emptyData } from "../../src/cat/project.js";
import { CORPORA, LANGUAGES, dataRepoPath } from "../../src/cat/corpora.js";
import { stageTranslation } from "../../../tools/stage-site.js";
import { LANGS as TRACKER_LANGS } from "../../src/ui/i18n.js";
import { LANGS as TOUCH_LANGS } from "../../../microtone-touch-worker/src/i18n.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
const NBSP = String.fromCharCode(0xa0);
const asModule = async (text) => (await import("data:text/javascript;base64," + Buffer.from(text).toString("base64"))).default;

const TABLES = CORPORA.flatMap((c) => ["en", ...Object.keys(LANGUAGES)].map((l) => c.repo + l + ".js"))
  .filter((p) => existsSync(join(ROOT, p)));

test("the shipped tables: the parser agrees with import(), and a rewrite with nothing changed is byte for byte", async () => {
  assert.ok(TABLES.length >= 4);
  for (const path of TABLES) {
    const text = readFileSync(join(ROOT, path), "utf8");
    const parsed = parseLangFile(text);
    const imported = await asModule(text);
    assert.deepEqual(langValues(text), imported, path);
    assert.deepEqual(parsed.order, Object.keys(imported), `${path}: every entry is one line`);
    assert.equal(writeLangFile({ text, values: { ...imported }, order: parsed.order }), text, path);
  }
});

test("LANGUAGES is every language either app speaks besides English", () => {
  const both = { ...TRACKER_LANGS, ...TOUCH_LANGS };
  delete both.en;
  assert.deepEqual(LANGUAGES, both);
});

test("literals: decode what JS decodes, encode what JS reads back, invisible characters escaped", async () => {
  const tricky = ["plain", 'quote " and \\ backslash', "line\nbreak\ttab", `S${NBSP}$7300`, "한국어 …", "emoji 🎹", String.fromCharCode(0x2028)];
  for (const s of tricky) {
    const lit = encodeLiteral(s);
    assert.equal(decodeLiteral(lit), s);
    assert.equal(await asModule(`export default ${lit};`), s);
  }
  assert.match(encodeLiteral(`S${NBSP}$7300`), /\\u00a0/);
  assert.equal(decodeLiteral(String.raw`"é\x41\u{1F3B9}\'"`), "éA🎹'");
});

const EN = `// English
export default {
  // ── one ──
  // a note for the group
  "a.one": "One",
  "a.two": "Two {n}", // trailing note

  // ── two ──
  "b.one": "Bee",
  "b.two": "Bee two",
};
`;
const KO = `// 한국어
export default {
  // ── one ──
  "a.one": "하나",
  "gone.key": "obsolete",

  // ── two ──
  "b.two": "비 둘",
};
`;

test("context: a key's section, its group's comment and its own trailing comment", () => {
  const p = parseLangFile(EN);
  assert.deepEqual(p.context.get("a.one"), { section: "one", notes: ["a note for the group"] });
  assert.deepEqual(p.context.get("a.two"), { section: "one", notes: ["a note for the group", "trailing note"] });
  assert.deepEqual(p.context.get("b.one"), { section: "two", notes: [] });
});

test("writeLangFile: changes in place, new keys in English's order, obsolete and emptied keys out", async () => {
  const order = parseLangFile(EN).order;
  const out = writeLangFile({ text: KO, values: { "a.one": "하나!", "a.two": `둘${NBSP}{n}`, "b.one": null, "b.two": "비 둘" }, order });
  assert.deepEqual(await asModule(out), { "a.one": "하나!", "a.two": `둘${NBSP}{n}`, "b.two": "비 둘" });
  const lines = out.split("\n");
  assert.ok(lines.indexOf('  "a.two": "둘\\u00a0{n}",') === lines.indexOf('  "a.one": "하나!",') + 1, "a.two right after a.one");
  assert.ok(lines.includes("  // ── two ──") && lines[0] === "// 한국어", "comments kept");
  assert.ok(!out.includes("gone.key"));
  assert.ok(writeLangFile({ text: KO, values: { "a.one": "하나", "b.two": "비 둘" }, order, drop: false }).includes("gone.key"));
  assert.deepEqual(await asModule(writeLangFile({ text: KO, values: { "a.one": "", "b.two": "비 둘" }, order })), { "a.one": "", "b.two": "비 둘" },
    "an empty string is a value, not an absence");
});

test("newLangFile: English's sections, only translated keys, importable", async () => {
  const out = newLangFile({ code: "ja", name: "日本語", englishText: EN, values: { "b.one": "ビー" } });
  assert.deepEqual(await asModule(out), { "b.one": "ビー" });
  assert.ok(out.includes("// ── two ──") && !out.includes("// ── one ──"), "an empty section leaves no trace");
});

test("text: placeholders, codes, numbers, lemmas", () => {
  assert.deepEqual(placeholders("{b} and {a} and {b}"), ["{a}", "{b}", "{b}"]);
  assert.deepEqual(codes("Undo (Ctrl+Z), Shift+Alt+← · F8 · (Space) · $FF"), ["$FF", "Ctrl+Z", "F8", "Shift+Alt+←", "Space"]);
  assert.deepEqual(codes("Ctrl+click the header"), ["Ctrl+"], "the action after a modifier is a word, translated");
  assert.deepEqual(codes("Ctrl+Z로 되돌리기"), ["Ctrl+Z"]);
  assert.deepEqual(numbers("{n} of 12 at 1.5x, F8"), ["1.5", "12"]);
  assert.equal(lemma("lanes"), "lane");
  assert.equal(lemma("entries"), "entry");
  assert.equal(lemma("bus"), "bus");
  assert.equal(tokens("Hello, {n} world!").join(""), "Hello, {n} world!");
});

test("wordDiff: 1 only for identical text, near 1 for a case change, ops rebuild both sides", () => {
  assert.equal(wordDiff("Save the song", "Save the song").score, 1);
  assert.equal(wordDiff("Save the song", "save the song").score, 0.99);
  const d = wordDiff("Delete this pattern", "Delete every pattern");
  assert.ok(d.score > 0.6 && d.score < 0.95);
  assert.equal(d.ops.filter((o) => o.op !== "+").map((o) => o.text).join(""), "Delete this pattern");
  assert.equal(d.ops.filter((o) => o.op !== "-").map((o) => o.text).join(""), "Delete every pattern");
});

test("translation memory: nearest first, the segment itself excluded, one row per pair", () => {
  const tm = new TranslationMemory([
    { id: "1", source: "Delete this pattern", target: "이 패턴 삭제" },
    { id: "2", source: "Delete this sample", target: "이 샘플 삭제" },
    { id: "3", source: "Rename the song", target: "곡 이름 바꾸기" },
    { id: "4", source: "Delete this sample", target: "이 샘플 삭제" },
  ]);
  const m = tm.match("Delete this pattern?", { exclude: "1" });
  assert.equal(m[0].unit.id, "2");
  assert.equal(m.length, 1, "the duplicate pair is one suggestion; the song is not similar");
  assert.equal(tm.match("Delete this pattern")[0].score, 1);
  assert.deepEqual(concordance(tm.units, "SAMPLE").map((u) => u.id), ["2", "4"]);
});

const PAIRS = [
  ["Mute this lane", "이 레인 음소거"], ["Solo the lane", "레인 솔로"], ["Lanes in use: {n}", "사용 중인 레인: {n}"],
  ["Copy the lane", "레인을 복사"], ["Paste into the lane", "레인에 붙여넣기"], ["Open the pattern", "패턴 열기"],
  ["Copy the pattern", "패턴을 복사"], ["Pattern {n} is empty", "패턴 {n}은 비어 있습니다"], ["Clear the pattern", "패턴 지우기"],
  ["Import MIDI", "MIDI 가져오기"], ["MIDI file", "MIDI 파일"], ["Export as MIDI", "MIDI로 내보내기"],
  ["Effect column", "이펙트 칸"], ["Second effect column", "두 번째 이펙트 칸"], ["Hide the effect column", "이펙트 칸 숨기기"],
].map(([source, target]) => ({ source, target }));

test("glossary: terms from the English, their translations from the company they keep", () => {
  const terms = alignTerms(extractTerms(PAIRS.map((p) => p.source), { minDf: 3 }), PAIRS);
  const best = (k) => terms.find((t) => t.key === k)?.proposals[0];
  assert.equal(best("lane").target, "레인", "the particle-bearing forms (레인을, 레인에) share the stem");
  assert.equal(best("pattern").target, "패턴");
  assert.equal(best("effect column").target, "이펙트 칸", "a two-word term");
  assert.equal(best("midi").dnt, true, "kept in English");
  assert.ok(!targetCandidates("사용 중인 레인: {n}").has("n"), "a placeholder's name is not a word");
});

test("glossary lookup: lemmas, longest first, no crossing punctuation", () => {
  const entries = [
    { key: termKey("effect column"), source: "effect column", targets: ["이펙트 칸"] },
    { key: termKey("column"), source: "column", targets: ["칸"] },
    { key: termKey("lane"), source: "lane", targets: ["레인"] },
  ];
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const hits = findTerms("Effect columns on every lane; effect, column", byKey);
  assert.deepEqual(hits.map((h) => h.entry.source), ["effect column", "lane", "column"]);
  assert.ok(targetHasTerm(entries[2], "레인을 모두"));
  assert.ok(!targetHasTerm(entries[2], "채널을 모두"));
  assert.ok(targetHasTerm({ source: "MIDI", targets: [], dnt: true }, "midi 파일"));
});

test("checks: each one fires on its mistake and nothing fires on a clean translation", () => {
  const seg = (key, source, target, extra = {}) => ({ id: key, corpus: "t", key, source, target, ...extra });
  const issues = runChecks([
    seg("ok", "Delete {n} lanes (Ctrl+D)…", "레인 {n}개 삭제 (Ctrl+D)…"),
    seg("ph", "{n} files", "파일 {count}개"),
    seg("code", "Undo (Ctrl+Z)", "실행 취소"),
    seg("ell", "Open…", "열기"),
    seg("space", "Song ", "곡"),
    seg("num", "Wait 5 seconds", "잠시 기다리세요"),
    seg("same", "Volume", "Volume"),
    seg("kept", "Hz", "Hz", { keep: true }),
    seg("x1", "Close", "닫기"), seg("x2", "Close", "끝내기"),
    seg("css", "", "@import x", { technical: true }),
    seg("gl", "Mute this lane", "이 채널 음소거"),
  ], [{ key: "lane", source: "lane", targets: ["레인"] }]);
  const by = (key) => issues.filter((i) => i.segment.key === key).map((i) => i.check).sort();
  assert.deepEqual(by("ok"), []);
  assert.deepEqual(by("ph"), ["placeholder"]);
  assert.deepEqual(by("code"), ["code"]);
  assert.deepEqual(by("ell"), ["ellipsis"]);
  assert.deepEqual(by("space"), ["space"]);
  assert.deepEqual(by("num"), ["number"]);
  assert.deepEqual(by("same"), ["identical"]);
  assert.deepEqual(by("kept"), []);
  assert.deepEqual(by("x1"), ["inconsistent"]);
  assert.deepEqual(by("gl"), ["glossary"]);
  assert.deepEqual(by("css"), []);
  const id = issues.find((i) => i.segment.key === "ph").id;
  assert.notEqual(runChecks([seg("ph", "{n} files", "파일 {c}개")]).find((i) => i.check === "placeholder").id, id,
    "a different mistake on the same string is a different issue");
});

function memoryStorage() {
  let saved = null;
  return { load: () => saved && JSON.parse(saved), save: (l) => { saved = JSON.stringify(l); }, peek: () => saved && JSON.parse(saved) };
}
const KO_FULL = KO.replace('  "gone.key": "obsolete",\n', "");
const project = (opts = {}) => new Project({
  lang: "ko",
  corpora: [{ def: CORPORA[0], englishText: opts.en ?? EN, targetText: opts.ko === undefined ? KO_FULL : opts.ko }],
  dataText: opts.data ?? null,
  storage: opts.storage ?? memoryStorage(),
});

test("project: statuses, drafts, confirm, keep — and a save writes exactly what changed", async () => {
  const seeded = stringifyData({ ...emptyData("ko"), corpora: { tracker: { keep: [], dismissed: [], reviewed: { "a.one": "One (old)", "b.two": "Bee two" } } } });
  const storage = memoryStorage();
  const p = project({ data: seeded, storage });
  const seg = (k) => p.byId.get(`tracker/${k}`);
  assert.equal(p.status(seg("a.one")), "stale", "its English changed since");
  assert.equal(p.status(seg("a.two")), "untranslated");
  assert.equal(p.status(seg("b.two")), "translated");
  assert.equal(p.unsaved(), 0);

  p.setTarget(seg("a.two"), "둘 {n}");
  p.confirm(seg("a.one"));
  assert.equal(p.status(seg("a.one")), "translated");
  assert.equal(p.unsaved(), 2);
  assert.deepEqual(storage.peek().drafts, { tracker: { "a.two": "둘 {n}" } }, "kept in the browser at once");

  const files = p.files();
  assert.deepEqual(files.map((f) => f.path), ["microtone-worker/src/ui/lang/ko.js", dataRepoPath("ko")]);
  assert.deepEqual(await asModule(files[0].text), { "a.one": "하나", "a.two": "둘 {n}", "b.two": "비 둘" });
  const data = parseData(files[1].text, "ko");
  assert.deepEqual(data.corpora.tracker.reviewed, { "a.one": "One", "a.two": "Two {n}", "b.two": "Bee two" });

  p.markSaved(files);
  assert.equal(p.unsaved(), 0);
  assert.deepEqual(p.files(), [], "nothing left to write");

  // A reload over the saved files drops the local layer that now matches them.
  const again = project({ ko: files[0].text, data: files[1].text, storage: memoryStorage() });
  assert.deepEqual(again.files(), []);
});

test("project: local changes the files already agree with are dropped on load", () => {
  const storage = memoryStorage();
  storage.save({ drafts: { tracker: { "a.one": "하나", "b.one": "비" } }, reviewed: {}, keep: {}, dismissed: {}, glossary: null });
  const p = project({ storage });
  assert.deepEqual(p.local.drafts, { tracker: { "b.one": "비" } });
});

test("project: a language with no table yet is written as a new one", async () => {
  const p = project({ ko: null });
  assert.equal(p.counts().untranslated, 4);
  p.setTarget(p.byId.get("tracker/b.one"), "비");
  const [f] = p.files();
  assert.equal(f.created, true);
  assert.deepEqual(await asModule(f.text), { "b.one": "비" });
});

test("project: the glossary and dismissals round-trip through the data file", () => {
  const p = project();
  p.setGlossary([{ source: "lane", targets: ["레인"], status: "accepted" }, { source: "the", status: "rejected" }]);
  const issue = p.allIssues()[0];
  if (issue) p.setDismissed(issue, true);
  const data = p.files().find((f) => f.path.endsWith(".json")).text;
  const q = project({ data });
  assert.deepEqual(q.glossary.map((e) => [e.source, e.status]), [["lane", "accepted"], ["the", "rejected"]]);
  if (issue) assert.ok(q.isDismissed(issue.id));
  assert.equal(stringifyData(parseData(data, "ko")), data, "the data file's text is stable");
});

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

test("cat-server.py writes translations and nothing else", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-server-"));
  mkdirSync(join(dir, "microtone-worker", "translation"), { recursive: true });
  const port = await freePort();
  const srv = spawn("python3", [join(ROOT, "microtone-worker/tools/cat-server.py"), String(port)], { cwd: dir, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/__cat/ping`)).ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(await (await fetch(`${base}/__cat/ping`)).json(), { cat: 1 });
    const post = (files, headers = { "x-microtone-cat": "1" }) => fetch(`${base}/__cat/save`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ files }),
    });
    const ok = await post([
      { path: "microtone-worker/src/ui/lang/ko.js", text: "export default {};\n" },
      { path: "microtone-worker/translation/data/ko.json", text: "{}\n" },
    ]);
    assert.equal(ok.status, 200);
    assert.equal(readFileSync(join(dir, "microtone-worker/src/ui/lang/ko.js"), "utf8"), "export default {};\n");
    for (const path of ["microtone-worker/src/ui/lang/en.js", "microtone-worker/src/ui/app.js", "microtone-worker/src/ui/lang/../../x.js", "../escape.js"]) {
      assert.equal((await post([{ path, text: "x" }])).status, 400, path);
    }
    assert.equal((await post([{ path: "microtone-worker/src/ui/lang/ja.js", text: "x" }], {})).status, 403, "no header, no write");
    assert.equal((await post([{ path: "microtone-worker/src/ui/lang/ja.js", text: "x" }], { "x-microtone-cat": "1", origin: "https://evil.example" })).status, 403);
    assert.ok(!existsSync(join(dir, "microtone-worker/src/ui/lang/ja.js")));
    // All or none: one bad path and nothing is written.
    assert.equal((await post([{ path: "microtone-worker/src/ui/lang/ja.js", text: "x" }, { path: "README.md", text: "x" }])).status, 400);
    assert.ok(!existsSync(join(dir, "microtone-worker/src/ui/lang/ja.js")));
  } finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staging lays Touch's tables in at translation/touch/, where the page looks first", () => {
  const out = mkdtempSync(join(tmpdir(), "cat-stage-"));
  try {
    assert.throws(() => stageTranslation({ out }), /no translation\/index\.html/);
    mkdirSync(join(out, "translation"));
    writeFileSync(join(out, "translation", "index.html"), "");
    assert.ok(stageTranslation({ out }) >= 2);
    assert.equal(readFileSync(join(out, "translation/touch/en.js"), "utf8"), readFileSync(join(ROOT, "microtone-touch-worker/src/lang/en.js"), "utf8"));
    const touch = CORPORA.find((c) => c.id === "touch");
    assert.equal(touch.urls[0], "touch/");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the committed record is readable and names only keys English has", () => {
  for (const lang of Object.keys(LANGUAGES)) {
    const path = join(ROOT, dataRepoPath(lang));
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const data = parseData(text, lang);
    assert.equal(stringifyData(data), text, `${dataRepoPath(lang)} is in the workbench's own layout`);
    for (const c of CORPORA) {
      const en = langValues(readFileSync(join(ROOT, c.repo + "en.js"), "utf8"));
      for (const key of Object.keys(data.corpora[c.id]?.reviewed ?? {})) assert.ok(key in en, `${c.id}/${key}`);
    }
  }
});
