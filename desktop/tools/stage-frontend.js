#!/usr/bin/env node
// stage-frontend.js — copy the shipped part of ../microtone-worker into
// desktop/dist, which tauri.conf.json's `frontendDist` embeds into the binary.
// Run by `cargo tauri dev` / `cargo tauri build` (beforeDevCommand /
// beforeBuildCommand) from desktop/.
//
// Why a copy rather than pointing frontendDist at microtone-worker: Tauri
// embeds EVERY file under frontendDist, and a working tree of microtone-worker
// also holds node_modules, the local test corpus and reference dumps, the
// soundfont symlink and the server code. What ships is:
//
//   files git would commit under microtone-worker/ (tracked, plus untracked
//   files that .gitignore does not exclude — so a new file shows up in a dev
//   build before it is committed)
//   − what microtone-worker/.assetsignore keeps off microtone.cc
//   − DESKTOP_EXCLUDE below (things the website serves but an app never reads)
//
// Symlinks are skipped: they point outside the tree.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(DESKTOP, "..");
const WEB = "microtone-worker";
const OUT = join(DESKTOP, "dist");

/** Served by the website, never read by the app. Same syntax as .assetsignore. */
const DESKTOP_EXCLUDE = [
  "test/",              // the test suite and its fixtures
  "tools/",             // golden renders, bundlers, the test server
  "_headers",           // Cloudflare's; tauri.conf.json sets the same two headers
  ".assetsignore",
  "package-lock.json",  // puppeteer, for the browser smokes
  "sf2taudify.py",
];

/**
 * The subset of gitignore syntax .assetsignore uses: `#` comments, `*` within
 * one path segment, a trailing `/` for "this directory", and a pattern with a
 * `/` in it anchored to the top (one without matches at any depth). No `**`,
 * no `!` negation — add them here before using them there.
 */
function compilePattern(pattern) {
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

function readPatterns(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

const excluded = [...readPatterns(join(ROOT, WEB, ".assetsignore")), ...DESKTOP_EXCLUDE]
  .map(compilePattern);

const listed = execFileSync(
  "git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", WEB],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
).split("\0").filter(Boolean);

const files = [...new Set(listed)]
  .map((path) => path.slice(WEB.length + 1))
  .filter((rel) => !excluded.some((match) => match(rel)))
  .filter((rel) => {
    const abs = join(ROOT, WEB, rel);
    // Deleted in the working tree but still in the index, or a symlink.
    return existsSync(abs) && !lstatSync(abs).isSymbolicLink();
  })
  .sort();

if (!files.includes("index.html")) {
  console.error(`stage-frontend: no ${WEB}/index.html among ${files.length} files — is this a checkout of the repository?`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
let bytes = 0;
for (const rel of files) {
  const to = join(OUT, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, WEB, rel), to);
  bytes += lstatSync(to).size;
}
console.log(`stage-frontend: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB → desktop/dist`);
