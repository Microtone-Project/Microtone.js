// Headless Chromium over CDP, for the tools that drive a page in REAL time
// (browser-smoke.js, make-screenshots.js). Nothing here knows about Microtone.
//
// Real time, not a virtual-time budget: the AudioWorklet, the render Worker,
// ResizeObserver and requestAnimationFrame all starve under virtual time, and a
// page with sound in it is exactly what these tools are for.
//
// Chromium is found via CHROME_PATH, then the usual PATH names, then a
// Playwright cache.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SERVER = fileURLToPath(new URL("./test-server.py", import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function findChrome() {
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

/** Minimal CDP client over Node's built-in WebSocket. */
export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
      else if (m.method) for (const fn of c.listeners.get(m.method) ?? []) fn(m.params);
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
  /** Call `fn` with every `method` event the browser sends. */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  /** The next `method` event's params. */
  once(method) {
    return new Promise((res) => {
      const fn = (params) => {
        const list = this.listeners.get(method);
        list.splice(list.indexOf(fn), 1);
        res(params);
      };
      this.on(method, fn);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  }
  /** Run `fn` IN THE PAGE with `arg` (JSON) and return what it resolves to. A
   *  throw in the page is thrown here, with the page's own message. `fn` goes
   *  as its source, so it can reach nothing of the caller's but `arg`; a
   *  method (`async stage() {…}`) is as good as a function expression. */
  async call(fn, arg) {
    const src = String(fn);
    const expr = /^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(src) ? src : `Object.values({ ${src} })[0]`;
    const r = await this.send("Runtime.evaluate", {
      expression: `(${expr})(${JSON.stringify(arg ?? null)})`,
      returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.error) throw new Error(r.error.message);
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? ex.text);
    return r.result?.result?.value;
  }
}

/** A TCP port nothing is listening on right now. */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/**
 * tools/test-server.py serving `dir`, on a port of its own — never a fixed
 * one, which a server left running from elsewhere would answer instead,
 * without COOP/COEP and without /hang. Resolves once it answers.
 */
export async function startTestServer(dir) {
  const port = await freePort();
  const proc = spawn("python3", [TEST_SERVER, String(port)], { cwd: dir, stdio: "ignore" });
  let exited = false;
  proc.on("exit", () => { exited = true; });
  for (let i = 0; i < 100 && !exited; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
      return { port, origin: `http://127.0.0.1:${port}`, close: () => proc.kill("SIGKILL") };
    } catch { await sleep(100); }
  }
  proc.kill("SIGKILL");
  throw new Error(`test-server.py did not come up on port ${port}`);
}

/**
 * A headless Chromium with a fresh profile and a debugging port of its own
 * (read back from DevToolsActivePort, so no fixed port can be squatted), and
 * a CDP connection to its one page.
 */
export async function launchChromium(extraArgs = []) {
  const chrome = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), "taud-browser-"));
  const browser = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-sync",
    "--password-store=basic", "--use-mock-keychain", "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    ...extraArgs,
    "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise((res) => browser.on("exit", res));
  const close = async () => {
    browser.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
      catch { await sleep(100); }
    }
    if (!port) throw new Error("Chromium never opened its debugging port");
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((x) => x.type === "page");
        if (page?.webSocketDebuggerUrl) return { cdp: await Cdp.connect(page.webSocketDebuggerUrl), close };
      } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error("Chromium never offered a page to drive");
  } catch (e) {
    await close();
    throw e;
  }
}
