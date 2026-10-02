#!/usr/bin/env node
// stage-frontend.js — copy the shipped part of ../microtone-worker (and the
// shared ../core it links to) into desktop/dist, which tauri.conf.json's
// `frontendDist` embeds into the binary. Run by `cargo tauri dev` / `cargo
// tauri build` (beforeDevCommand / beforeBuildCommand) from desktop/.
//
// Why a copy rather than pointing frontendDist at microtone-worker: Tauri
// embeds EVERY file under frontendDist, and a working tree of microtone-worker
// also holds node_modules, the local test corpus and reference dumps, the
// soundfont symlink and the server code — and it reaches core/ through a
// symlink that a Windows checkout turns into a text file. What ships is what
// tools/stage-site.js stages for the website (files git would commit under
// microtone-worker/ and core/, minus microtone-worker/.assetsignore), minus
// DESKTOP_EXCLUDE below.

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stageSite } from "../../tools/stage-site.js";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

try {
  const { files, bytes } = stageSite({ site: "microtone-worker", out: OUT, exclude: DESKTOP_EXCLUDE });
  console.log(`stage-frontend: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB → desktop/dist`);
} catch (e) {
  console.error(e.message.replace(/^stage-site/, "stage-frontend"));
  process.exit(1);
}
