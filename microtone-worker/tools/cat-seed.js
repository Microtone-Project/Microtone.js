#!/usr/bin/env node
// cat-seed.js — fill the translation workbench's `reviewed` record for a
// language from git history: for every key, the English as it stood when its
// translation was last written. A translation whose English has changed since
// then is what the workbench calls STALE.
//
//   node tools/cat-seed.js <lang> [--dry-run]     (from microtone-worker/)
//
// Walks every commit that touched a corpus's en.js or <lang>.js, oldest
// first, then the working tree. Where a translation and its English changed
// in the same commit, the translation counts as written against the new
// English. The rest of translation/data/<lang>.json (glossary, keep,
// dismissed) is kept; `reviewed` is replaced.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPORA, LANG_CODE, dataRepoPath } from "../src/cat/corpora.js";
import { parseData, stringifyData, emptyData } from "../src/cat/project.js";
import { langValues } from "../src/cat/langfile.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });

// Old revisions of a table need not be in today's one-line layout, so they
// are evaluated as the modules they are.
// A revision that is not even a valid module (a broken commit) is read line
// by line; one that cannot be read either way is skipped (null).
async function values(text) {
  if (!text) return {};
  const url = "data:text/javascript;base64," + Buffer.from(text).toString("base64");
  try { return (await import(url)).default; } catch { /* fall through */ }
  try { return langValues(text); } catch { return null; }
}

function show(rev, path) {
  try { return git("show", `${rev}:${path}`); } catch { return null; }
}

export async function seedReviewed(lang) {
  const out = {};
  for (const def of CORPORA) {
    const enPath = def.repo + "en.js", tPath = def.repo + lang + ".js";
    if (!existsSync(join(ROOT, tPath))) continue;
    const revs = git("log", "--format=%H", "--reverse", "--", enPath, tPath).split("\n").filter(Boolean);
    const reviewed = {};
    let prevT = {};
    const step = (en, t) => {
      for (const [k, v] of Object.entries(t)) {
        if (prevT[k] !== v) reviewed[k] = en[k]; // written now
        // A translation written before its English existed takes the first English seen.
        else if (reviewed[k] === undefined) reviewed[k] = en[k];
      }
      for (const k of Object.keys(reviewed)) if (!(k in t)) delete reviewed[k];
      prevT = t;
    };
    let en = {};
    for (const rev of revs) {
      const e = await values(show(rev, enPath)), t = await values(show(rev, tPath));
      if (e) en = e;
      if (t) step(en, t);
    }
    const enNow = await values(readFileSync(join(ROOT, enPath), "utf8"));
    step(enNow, await values(readFileSync(join(ROOT, tPath), "utf8")));
    // In English's order, keys English still has, as the workbench writes them.
    out[def.id] = Object.fromEntries(Object.keys(enNow)
      .filter((k) => k in reviewed && reviewed[k] !== undefined && !k.startsWith("css."))
      .map((k) => [k, reviewed[k]]));
    const stale = Object.entries(out[def.id]).filter(([k, v]) => v !== enNow[k]).length;
    console.log(`${def.id}: ${revs.length} commits, ${Object.keys(out[def.id]).length} translations, ${stale} stale`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lang = process.argv[2];
  if (!lang || !LANG_CODE.test(lang) || lang === "en") {
    console.error("usage: node tools/cat-seed.js <lang> [--dry-run]");
    process.exit(2);
  }
  const reviewed = await seedReviewed(lang);
  const file = join(ROOT, dataRepoPath(lang));
  const data = existsSync(file) ? parseData(readFileSync(file, "utf8"), lang) : emptyData(lang);
  for (const [id, r] of Object.entries(reviewed)) {
    data.corpora[id] = { keep: [], dismissed: [], ...data.corpora[id], reviewed: r };
  }
  if (process.argv.includes("--dry-run")) process.exit(0);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifyData(data));
  console.log(`→ ${dataRepoPath(lang)}`);
}
