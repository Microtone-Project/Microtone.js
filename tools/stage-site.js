#!/usr/bin/env node
// stage-site.js — copy one web app (microtone-worker, microtone-touch-worker)
// into a self-contained directory, with the shared code in core/ copied in
// beside it.
//
//   node tools/stage-site.js <site-dir> <out-dir>
//
// Each web app reaches core/ through a committed symlink (`<site>/core ->
// ../core`), which is what lets a plain static server and `node --test` run
// either app straight from its own directory with no build step. Neither of
// the two things that SHIP an app follows that link, so both go through here:
//
//   - Cloudflare's asset upload walks the asset directory and skips a
//     symlinked directory (or not, depending on the Node version underneath
//     it). /wrangler.toml runs this as its `[build]` command and uploads
//     build/microtone-worker.
//   - Tauri embeds desktop/dist, which desktop/tools/stage-frontend.js fills by
//     calling stageSite() with its own extra exclusions. On a Windows runner
//     git checks the link out as a one-line TEXT file, so the link is never
//     copied as such: core/ is always staged from the real directory.
//
// What is staged: files git would commit under <site>/ and core/ (tracked,
// plus untracked files .gitignore does not exclude — so a new file shows up in
// a dev build before it is committed), minus what <site>/.assetsignore lists,
// minus the caller's `exclude` patterns. Other symlinks are skipped: they point
// outside the tree. Where git is unavailable (a bare tarball), the two
// directories are walked instead.
//
// `--design-system` (the tracker's deploy only) also lays the design system's
// docs page in at /design-system/ — see stageDesignSystem().

import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = "core";

/**
 * The subset of gitignore syntax .assetsignore uses: `#` comments, `*` within
 * one path segment, a trailing `/` for "this directory", and a pattern with a
 * `/` in it anchored to the top (one without matches at any depth). No `**`,
 * no `!` negation — add them here before using them there.
 */
export function compilePattern(pattern) {
  const dirOnly = pattern.endsWith("/");
  let body = dirOnly ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes("/");
  body = body.replace(/^\//, "");
  const re = new RegExp("^" + body.split("*").map(escapeRegExp).join("[^/]*") + "$");
  return (rel) => {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      if (dirOnly && i === parts.length) break; // a directory pattern never names the file itself
      if (re.test(anchored ? parts.slice(0, i).join("/") : parts[i - 1])) return true;
    }
    return false;
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readPatterns(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** Files under `dir` (relative to it, `/`-separated) that git would commit. */
function listFiles(dir) {
  try {
    return execFileSync(
      "git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    ).split("\0").filter(Boolean).map((p) => p.slice(dir.length + 1));
  } catch {
    return walk(join(ROOT, dir));
  }
}

function walk(abs, base = abs, out = []) {
  for (const name of readdirSync(abs)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(abs, name);
    if (lstatSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/**
 * Stage `site` (a directory name under the repository root) into `out`.
 * `exclude` adds patterns in .assetsignore syntax, matched against the staged
 * path — so "core/README.md" names core's copy. Returns { files, bytes }.
 */
export function stageSite({ site, out, exclude = [] }) {
  const excluded = [...readPatterns(join(ROOT, site, ".assetsignore")), ...exclude]
    .map(compilePattern);
  const fromSite = listFiles(site)
    .filter((rel) => rel !== CORE && !rel.startsWith(CORE + "/"))
    .map((rel) => [rel, join(ROOT, site, rel)]);
  const fromCore = listFiles(CORE)
    .map((rel) => [`${CORE}/${rel}`, join(ROOT, CORE, rel)]);

  const files = [...new Map([...fromSite, ...fromCore])]
    .filter(([rel]) => !excluded.some((match) => match(rel)))
    // Deleted in the working tree but still in the index, or a symlink.
    .filter(([, abs]) => existsSync(abs) && !lstatSync(abs).isSymbolicLink())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (!files.some(([rel]) => rel === "index.html")) {
    throw new Error(`stage-site: no ${site}/index.html among ${files.length} files — is this a checkout of the repository?`);
  }
  if (!files.some(([rel]) => rel.startsWith(CORE + "/"))) {
    throw new Error(`stage-site: nothing staged from ${CORE}/ — is this a checkout of the repository?`);
  }

  // `out` is wiped first, so it must neither hold nor sit inside a source.
  const outAbs = resolve(out);
  const inside = (a, b) => a === b || a.startsWith(b + sep);
  for (const src of [join(ROOT, site), join(ROOT, CORE)]) {
    if (inside(src, outAbs) || inside(outAbs, src)) {
      throw new Error(`stage-site: refusing to stage into ${outAbs}: it overlaps ${src}`);
    }
  }
  rmSync(outAbs, { recursive: true, force: true });
  let bytes = 0;
  for (const [rel, abs] of files) {
    const to = join(outAbs, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(abs, to);
    bytes += lstatSync(to).size;
  }
  return { files: files.length, bytes };
}

/**
 * The design system's docs page, published at /design-system/ of a staged
 * tracker site (`out` is that site's directory, already staged).
 *
 * In the repository the page sits at design-system/docs/ and reaches the app
 * through the layout the repo root is served in (`../../microtone-worker/css/…`,
 * `../tokens.json`). On the site the tracker's own files ARE the root, and the
 * page's data files sit beside it, so the copies of index.html and docs.js are
 * rewritten for that layout:
 *
 *   ../../microtone-worker/X  →  ../X          (the site's /X)
 *   ../tokens.json …          →  tokens.json   (README.md, components.json, notes.json)
 *
 * The sources keep the repository layout (that is what the docs README tells
 * people to open locally); a reference this rewrite did not turn into one that
 * resolves in the staged tree is an error here, not a broken page on the site.
 * Only the page and its four data files ship — not fonts/ (Python sources and
 * the retired fonts' originals) and not the `components` link.
 */
export const DESIGN_SYSTEM_FILES = {
  // staged name → source under design-system/
  "index.html": "docs/index.html",
  "docs.js": "docs/docs.js",
  "docs.css": "docs/docs.css",
  "README.md": "README.md",
  "tokens.json": "tokens.json",
  "components.json": "components.json",
  "notes.json": "notes.json",
};

export function rewriteDesignSystemPage(text) {
  return text
    .replaceAll("../../microtone-worker/", "../")
    .replace(/(["'(])\.\.\/(README\.md|tokens\.json|components\.json|notes\.json)/g, "$1$2");
}

export function stageDesignSystem({ out }) {
  const dir = join(resolve(out), "design-system");
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(DESIGN_SYSTEM_FILES)) {
    const from = join(ROOT, "design-system", src);
    if (!existsSync(from)) throw new Error(`stage-site: design-system/${src} is missing`);
    if (/\.(html|js)$/.test(name)) {
      const text = rewriteDesignSystemPage(readFileSync(from, "utf8"));
      // Anything still naming the repository layout would 404 on the site.
      // (Prose that merely names a path is fine; a URL in an attribute or an
      // import is not.)
      const stray = text.match(/(?:from\s+|import\(|src=|href=|fetch\()\s*["'][^"']*microtone-worker\/[^"']*["']/g);
      if (stray) throw new Error(`stage-site: design-system/${src} still reaches into microtone-worker/: ${stray.join(", ")}`);
      writeFileSync(join(dir, name), text);
    } else {
      copyFileSync(from, join(dir, name));
    }
  }
  return Object.keys(DESIGN_SYSTEM_FILES).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const withDesignSystem = args.includes("--design-system");
  const [site, outArg] = args.filter((a) => !a.startsWith("--"));
  if (!site || !outArg) {
    console.error("usage: node tools/stage-site.js <site-dir> <out-dir> [--design-system]");
    process.exit(2);
  }
  const out = resolve(outArg);
  try {
    const { files, bytes } = stageSite({ site, out });
    const extra = withDesignSystem ? stageDesignSystem({ out }) : 0;
    console.log(`stage-site: ${files + extra} files, ${(bytes / 1048576).toFixed(1)} MiB → ${relative(ROOT, out) || out}${extra ? " (with /design-system/)" : ""}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
