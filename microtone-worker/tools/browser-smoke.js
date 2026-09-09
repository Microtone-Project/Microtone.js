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
// Chromium is found via CHROME_PATH, then the usual PATH names, then a
// Playwright cache. The file server (tools/test-server.py) is started here.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [page, secondsArg] = process.argv.slice(2);
if (!page) {
  console.error("usage: browser-smoke.js <test/browser/x.html> [seconds=60]");
  process.exit(2);
}
const budgetMs = (secondsArg ? Number(secondsArg) : 60) * 1000;
const PORT = 8932;
const DEBUG_PORT = 9333;

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    const hit = await new Promise((r) => {
      const p = spawn("sh", ["-c", `command -v ${name}`]);
      let o = "";
      p.stdout.on("data", (d) => { o += d; });
      p.on("close", (c) => r(c === 0 ? o.trim() : null));
    });
    if (hit) return hit;
  }
  const cache = join(process.env.HOME ?? "", ".cache/ms-playwright");
  try {
    const dirs = (await readdir(cache)).filter((d) => d.startsWith("chromium-")).sort();
    for (const d of dirs.reverse()) {
      const exe = join(cache, d, "chrome-linux64/chrome");
      try { await access(exe); return exe; } catch { /* next */ }
    }
  } catch { /* no playwright cache */ }
  throw new Error("no Chromium found — set CHROME_PATH");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Minimal CDP client over Node's built-in WebSocket. */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  }
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
