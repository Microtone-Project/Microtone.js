#!/usr/bin/env node
// stage-frontend.js — the web app the Qt desktop build ships: what git would
// commit under microtone-worker/ and core/ (through the repository's
// tools/stage-site.js, so the `core` link is laid in as real files — a Windows
// checkout has it as a text file), minus what only the website serves, into
// <out> (default desktop-qt/build/www). The binary looks for it as `www`
// beside itself (src/main.cpp findRoot).
//
// The exclusions are the Tauri build's (desktop/tools/stage-frontend.js),
// which this build replaces.
//
// Usage: node desktop-qt/tools/stage-frontend.js [out-dir]
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stageSite } from "../../tools/stage-site.js";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(HERE, "build", "www"));

/** Served by the website, never read by the app. Same syntax as .assetsignore. */
const DESKTOP_EXCLUDE = [
  "test/",              // the test suite and its fixtures
  "tools/",             // golden renders, bundlers, the test server
  "_headers",           // Cloudflare's; the shell's server sends its own
  ".assetsignore",
  "translation/",       // the translation workbench: a page of the website, not of the app
  "src/cat/",
  "about/",             // the product page: the app links to microtone.cc/about/ itself
];

try {
  const { files, bytes } = stageSite({ site: "microtone-worker", out: OUT, exclude: DESKTOP_EXCLUDE });
  console.log(`stage-frontend: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB → ${OUT}`);
} catch (e) {
  console.error(e.message.replace(/^stage-site/, "stage-frontend"));
  process.exit(1);
}
