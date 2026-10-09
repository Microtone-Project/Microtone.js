#!/usr/bin/env node
// Run one test/browser/*.html page in headless Chromium and print its <pre
// id="out"> log. (Named away from `*-test.js` on purpose: `node --test` globs
// that pattern and would launch a browser in the middle of the unit suite.)
// Usage:
//
//   node tools/browser-smoke.js test/browser/taudplay-smoke.html [seconds]
//
// Drives the browser over CDP rather than `--dump-dom --timeout=N`: current
// headless Chromium has dropped `--timeout`, so a page that deliberately never
// fires `load` (every smoke page here holds one open with `<img src="/hang">`)
// dumps nothing at all. Polling the log element over CDP also means the run
// ends the moment the page prints its FAILURES line instead of always burning
// the whole budget — and it runs in REAL time, which anything with audio in it
// needs (a virtual-time budget starves the audio thread).
//
// Chromium is found as tools/chromium.js finds it. The file server
// (tools/test-server.py) is started here.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, Cdp, sleep } from "./chromium.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const [page, secondsArg] = process.argv.slice(2);
if (!page) {
  console.error("usage: browser-smoke.js <test/browser/x.html> [seconds=60]");
  process.exit(2);
}
const budgetMs = (secondsArg ? Number(secondsArg) : 60) * 1000;
const PORT = 8932;
const DEBUG_PORT = 9333;

/** How a smoke page says it has finished. The pages here use one of three
 *  conventions; any of them ends the poll and decides the exit code. */
const DONE = /FAILURES:\s*\d+|RESULT:\s*(PASS|FAIL)|^DONE$/m;

async function cdpTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page");
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("Chromium never opened its debugging port");
}

const chrome = await findChrome();
const profile = await mkdtemp(join(tmpdir(), "taud-browser-"));
const server = spawn("python3", [join(root, "tools/test-server.py")], { cwd: root, stdio: "ignore" });
await sleep(800);

const browser = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-sync",
  "--password-store=basic", "--use-mock-keychain", "--disable-dev-shm-usage",
  "--autoplay-policy=no-user-gesture-required",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  "about:blank",
], { stdio: "ignore" });

let exitCode = 1;
try {
  const cdp = await Cdp.connect(await cdpTarget());
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/${page}` });

  const deadline = Date.now() + budgetMs;
  let text = "";
  while (Date.now() < deadline) {
    await sleep(500);
    text = (await cdp.evaluate(
      "document.getElementById('out') ? document.getElementById('out').textContent : ''")) ?? "";
    if (DONE.test(text)) break;
  }
  console.log(text.trim() || "!! the page printed nothing");
  const fails = text.match(/FAILURES:\s*(\d+)/);
  const verdict = text.match(/RESULT:\s*(PASS|FAIL)/);
  const done = /^DONE$/m.test(text);
  if (fails) {
    exitCode = fails[1] === "0" ? 0 : 1;
  } else if (verdict) {
    exitCode = verdict[1] === "PASS" ? 0 : 1;
  } else if (done) {
    // A page that only says DONE marks its own lines: any FAIL or EXCEPTION in
    // the log is the failure.
    exitCode = /\bFAIL\b|^EXCEPTION /m.test(text) ? 1 : 0;
  } else {
    console.log(`\n!! no verdict after ${budgetMs / 1000}s — the page did not finish`);
    exitCode = 1;
  }
} finally {
  browser.kill("SIGKILL");
  server.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
}
process.exit(exitCode);
