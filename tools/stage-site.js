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

import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync,
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [site, outArg] = process.argv.slice(2);
  if (!site || !outArg) {
    console.error("usage: node tools/stage-site.js <site-dir> <out-dir>");
    process.exit(2);
  }
  const out = resolve(outArg);
  try {
    const { files, bytes } = stageSite({ site, out });
    console.log(`stage-site: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB → ${relative(ROOT, out) || out}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
