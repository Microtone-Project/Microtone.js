#!/usr/bin/env node
// Regenerate the promo screenshots: the tracker's eight (Screenshot1..8.png at
// the repository root, which README.md shows — the first is also
// microtone-worker/screenshot.png, the og:image) and Microtone Touch's
// (microtone-touch-worker/screenshots/).
//
//   node tools/make-screenshots.js               # the tracker's eight
//   node tools/make-screenshots.js 1 6           # two of them
//   node tools/make-screenshots.js touch [n …]   # Touch's
//   … --out <dir>                                # somewhere else, to look first
//
// Each shot is a SCENE (tools/shots/<app>.js): a page to load, and a function
// run IN the page that puts the app where the shot wants it — a tab, a
// selection, the song playing from a given row — resolving once it is there.
// The capture follows at once. Every shot starts from a clean slate (the
// origin's storage is cleared and the page loaded afresh), so one scene's
// preferences never leak into the next.
//
// Shots with the song playing are taken in REAL time, so their meters,
// playhead and sample tint are live: each run gives the same scene, not the
// same pixels — a row of drift either way is normal. Look before committing.
//
// The tracker's songs come from test/corpus/, which is local-only.

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { launchChromium, startTestServer, sleep } from "./chromium.js";
import tracker from "./shots/tracker.js";
import touch from "./shots/touch.js";

const APPS = { tracker, touch };

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outDir = outAt >= 0 ? resolve(args.splice(outAt, 2)[1] ?? ".") : null;
const app = APPS[args[0]] ?? tracker;
if (APPS[args[0]]) args.shift();
const wanted = args.map(Number);
if (wanted.some((n) => !Number.isInteger(n) || n < 1 || n > app.shots.length)) {
  console.error(`usage: make-screenshots.js [${Object.keys(APPS).join("|")}] [1…${app.shots.length} …]`);
  process.exit(2);
}
const shots = app.shots.map((s, i) => ({ ...s, n: i + 1 }))
  .filter((s) => wanted.length === 0 || wanted.includes(s.n))
  .map((s) => (outDir ? { ...s, out: [join(outDir, basename(s.out[0]))] } : s));

const server = await startTestServer(app.root);
const { cdp, close } = await launchChromium();
let failed = 0;
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // The page's own errors, as they happen: a scene that never becomes ready
  // is usually a module that never loaded.
  cdp.on("Runtime.exceptionThrown", (p) => {
    console.log(`  page: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  });

  for (const shot of shots) {
    const t0 = Date.now();
    try {
      await capture(shot);
      console.log(`${app.name} ${shot.n}: ${shot.out.map(shown).join(", ")} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      failed++;
      console.log(`${app.name} ${shot.n}: FAILED — ${e.message}`);
    }
  }
} finally {
  await close();
  server.close();
}
process.exit(failed ? 1 : 0);

/** A path as the console should show it: relative when it is under here. */
function shown(file) {
  const rel = relative(process.cwd(), file);
  return rel.startsWith("..") ? file : rel;
}

async function capture(shot) {
  const viewport = { ...app.viewport, ...shot.viewport };
  await cdp.send("Storage.clearDataForOrigin", { origin: server.origin, storageTypes: "all" });
  await cdp.send("Emulation.setDeviceMetricsOverride", viewport);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!viewport.mobile, maxTouchPoints: 5 });

  // Anything the app reads at boot (a saved sketch, a preference) goes in
  // first, from a page of the same origin that runs nothing.
  if (shot.storage) {
    await navigate(`${server.origin}/favicon.svg`);
    await cdp.call((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    }, shot.storage);
  }
  await navigate(`${server.origin}/${shot.url}`);
  await cdp.call(app.ready, { timeout: 30000 });
  await cdp.call(shot.stage, shot.arg);
  await cdp.call(() => document.fonts.ready.then(() => true));
  await sleep(shot.settle ?? 300);

  const { result } = await cdp.send("Page.captureScreenshot", { format: "png" });
  if (!result?.data) throw new Error("the capture came back empty");
  const png = Buffer.from(result.data, "base64");
  for (const file of shot.out) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, png);
  }
}

async function navigate(url) {
  const loaded = cdp.once("Page.domContentEventFired");
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(15000)]);
}
