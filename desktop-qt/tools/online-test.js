#!/usr/bin/env node
// Online projects in the desktop app, end to end (src/online.h): the real app,
// a local copy of the site, and this script playing the system's browser.
//
//   node desktop-qt/tools/online-test.js <microtone executable> [--server http://127.0.0.1:8790] [--port 9342]
//
// The site: from the repository root, with its state kept out of the tree,
//   npx --yes wrangler@4 d1 migrations apply microtone-online --local --persist-to <dir>
//   npx --yes wrangler@4 dev --port 8790 --ip 127.0.0.1 --persist-to <dir> \
//       --var ONLINE_DEV_LOGIN:1 --var SCENEID_CLIENT_ID:
// (the test sign-in, not SceneID). Linux or macOS (the stand-in browser is a
// shell script); on Linux run it on Xvfb as the native smoke test is.
//
// Checked: the File view's Sign in opens "the browser" on the site's desktop
// sign-in with this app's loopback port; the browser signs in and comes back
// to the app — three times, two at once — which spends the code once and
// answers every visit with the outcome; the page hears it (the banner goes, the
// File view says who); the token is kept, readable by its owner only; nothing
// but that one page answers without the app's per-launch token (a forged
// return is refused); projects go through the proxy (create, list, read back
// byte for byte, save, a conflict, rename, delete); a new start is still
// signed in; signing out forgets the token; and with no server the page says
// "offline". Exit 0: all of that.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);

// ── the stand-in browser: `online-test.js --browser <url>` ──
if (args[0] === "--browser") {
  const url = args[1];
  const log = (...a) => appendFileSync(process.env.ONLINE_TEST_BROWSER_LOG, a.join(" ") + "\n");
  const jar = new Map();
  const get = async (u) => {
    const res = await fetch(u, { redirect: "manual", headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (/Max-Age=0/i.test(c)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
  const hide = (u) => String(u).replace(/(challenge|state|code)=[^&]+/g, "$1=…");
  try {
    await sleep(2000);  // a person takes a moment
    log("opened", hide(url));
    let res = await get(url);
    let page = await res.text();
    log("desktop page", res.status);
    if (/dev-login/.test(page)) {
      res = await get(new URL(`/api/online/auth/dev-login?name=desktop-test-${process.pid}`, url));
      page = await res.text();
      log("signed in", res.status);
    }
    const back = /id="back" href="([^"]+)"/.exec(page)?.[1]?.replace(/&amp;/g, "&");
    log("back to", hide(back));
    // Twice at once, then again: a browser may come back more than once
    // (Firefox did), and each visit must get the outcome, not a refusal.
    const answer = async (r) => `${r.status} ${(await r.text()).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 100)}`;
    const [first, second] = await Promise.all([get(back).then(answer), get(back).then(answer)]);
    const third = await get(back).then(answer);
    log("app answered", first);
    log("app answered again at once", second);
    log("app answered a third time", third);
  } catch (err) {
    log("ERROR", err);
  }
  process.exit(0);
}

const exe = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
if (!exe) {
  console.error("usage: node online-test.js <microtone executable> [--server URL] [--port P]");
  process.exit(2);
}
const server = opt("server", "http://127.0.0.1:8790");
const debugPort = Number(opt("port", "9342"));
const work = mkdtempSync(join(tmpdir(), "microtone-online-"));
const browserLog = join(work, "browser.log");
const browser = join(work, "browser.sh");
writeFileSync(browser, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(import.meta.url)}" --browser "$1"\n`);
chmodSync(browser, 0o755);

const out = { work, checks: {} };
const check = (name, ok, detail) => { out.checks[name] = ok ? "ok" : `FAIL ${JSON.stringify(detail)}`; };
let app = null;

/** A CDP page of the running app: evaluate(expression) → its value. */
async function launch(site) {
  app = spawn(exe, ["--web-audio"], {
    env: {
      ...process.env, QTWEBENGINE_REMOTE_DEBUGGING: String(debugPort), QT_FORCE_STDERR_LOGGING: "1",
      MICROTONE_ONLINE: site, MICROTONE_BROWSER: browser, ONLINE_TEST_BROWSER_LOG: browserLog,
      MICROTONE_FILES_ROOT: join(work, "Microtone"), XDG_DATA_HOME: join(work, "data"), XDG_CONFIG_HOME: join(work, "config"),
      XDG_CACHE_HOME: join(work, "cache"), MICROTONE_OLDAPP_DIR: "none",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  app.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (/^online:|error/i.test(l.trim())) (out.log ??= []).push(l.trim()); });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page" && t.url.includes("microtone.localhost"));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error("the app's page never came up");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); };
  const evaluate = (expression) => new Promise((r) => {
    waiting.set(++id, (m) => r(m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  for (let i = 0; i < 60 && !(await evaluate("!!window.__microtone?.store")); i++) await sleep(500);
  return { evaluate, close: () => ws.close() };
}
async function quit(page) {
  page.close();
  app.kill("SIGTERM");
  await new Promise((r) => app.on("exit", r));
  app = null;
  await sleep(500);
}
const ONLINE = `const o = await import("/core/storage/online.js");`;
const status = (page) => page.evaluate(`(async () => { ${ONLINE} return o.status(); })()`);
const tokenFile = () => {
  // XDG_DATA_HOME/<organisation>/<application> (Linux; macOS ignores it)
  const dir = join(work, "data", "Microtone", "Microtone");
  const f = existsSync(dir) && readdirSync(dir).find((n) => n.startsWith("online-token"));
  return f ? join(dir, f) : null;
};

try {
  let page = await launch(server);
  const before = await status(page);
  check("the site offers the test sign-in", before?.available && !before.signedIn && before.signIn === "dev", before);

  await page.evaluate(`document.querySelector('#tabs [data-view="files"]').click()`);
  let clicked = false;
  for (let i = 0; i < 40 && !clicked; i++) {
    clicked = await page.evaluate(`(() => { const b = [...document.querySelectorAll(".files-online button")].find((b) => /test account|SceneID/.test(b.textContent)); b?.click(); return !!b; })()`);
    if (!clicked) await sleep(250);
  }
  check("the File view's Sign in", clicked);
  let banner = false;
  for (let i = 0; i < 20 && !banner; i++) {
    banner = await page.evaluate(`[...document.querySelectorAll(".banner")].some((b) => /browser/.test(b.textContent))`);
    if (!banner) await sleep(100);
  }
  let after = null;
  for (let i = 0; i < 60; i++) {
    after = await status(page);
    if (after?.signedIn) break;
    await sleep(500);
  }
  const bannerGone = await page.evaluate(`![...document.querySelectorAll(".banner")].some((b) => /browser/.test(b.textContent))`);
  check("a banner while the browser signs in, gone after", banner && bannerGone, { banner, bannerGone });
  check("signed in", after?.signedIn && /^desktop-test-\d+ \(local test\)$/.test(after.user?.name), after);
  await sleep(500);
  const answers = readFileSync(browserLog, "utf8").split("\n").filter((l) => l.startsWith("app answered"));
  check("every visit back gets the outcome", answers.length === 3 && answers.every((l) => /answered[a-z ]* 200 .*Signed in as/.test(l)), answers);
  const shown = await page.evaluate(`document.querySelector(".files-online")?.textContent ?? ""`);
  check("the File view says who", /desktop-test-\d+/.test(shown), shown.slice(0, 120));

  const port = /port=(\d+)/.exec(readFileSync(browserLog, "utf8"))?.[1];
  const at = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init).then((r) => r.status, () => "no answer");
  const bare = {
    forged: await at("/signed-in?code=abc&state=def"), page: await at("/index.html"), api: await at("/api/online/me"),
    files: await at("/api/files/projects?list"), signIn: await at("/api/desktop/online-sign-in", { method: "POST" }),
  };
  check("without the token only the way back answers, and refuses a forged one",
    bare.forged === 400 && bare.page === 403 && bare.api === 403 && bare.files === 403 && bare.signIn === 403, bare);
  const tf = tokenFile();
  check("the token is kept, its owner's only", tf && (statSync(tf).mode & 0o777) === 0o600, tf && (statSync(tf).mode & 0o777).toString(8));

  const ops = await page.evaluate(`(async () => { ${ONLINE}
    const bytes = new Uint8Array(await (await fetch("/assets/demo_projects/Eighth.taud")).arrayBuffer());
    const other = new Uint8Array(await (await fetch("/assets/demo_projects/Zeta_valley.taud")).arrayBuffer());
    const r = {};
    const p = await o.create("desktop-test.taud", bytes);
    r.listed = (await o.list()).projects.some((x) => x.name === "desktop-test.taud");
    const got = await o.read(p.id);
    r.same = got.bytes.length === bytes.length && got.bytes.every((b, i) => b === bytes[i]);
    await o.save(p.id, other, got.etag);
    r.saved = (await o.read(p.id)).bytes.length === other.length;
    try { await o.save(p.id, bytes, got.etag); r.conflict = "none"; } catch (e) { r.conflict = e.code; }
    r.renamed = (await o.rename(p.id, "desktop-test-2.taud")).name;
    await o.remove(p.id);
    r.gone = !(await o.list()).projects.some((x) => x.id === p.id);
    return r;
  })().catch((e) => ({ error: String(e), code: e.code }))`);
  check("projects through the app", ops.listed && ops.same && ops.saved && ops.conflict === "conflict" &&
    ops.renamed === "desktop-test-2.taud" && ops.gone, ops);
  await quit(page);

  page = await launch(server);
  check("still signed in after a new start", (await status(page))?.signedIn);
  await page.evaluate(`(async () => { ${ONLINE} await o.signOut(); })()`);
  const signedOut = await status(page);
  check("signing out forgets the token", !signedOut?.signedIn && tokenFile() === null, { signedOut, file: tokenFile() });
  await quit(page);

  page = await launch("http://127.0.0.1:9");  // nothing listens there
  const none = await page.evaluate(`(async () => { ${ONLINE} const s = await o.status(); let code = null; try { await o.list(); } catch (e) { code = e.code; } return { s, code }; })()`);
  check("no server: no online section, and \"offline\"", none?.s?.available === false && none.code === "offline", none);
  await quit(page);
} catch (err) {
  out.error = String(err?.stack ?? err);
  app?.kill("SIGKILL");
}
try { out.browser = readFileSync(browserLog, "utf8").trim().split("\n"); } catch { /* never ran */ }
console.log(JSON.stringify(out, null, 1));
process.exit(!out.error && Object.values(out.checks).every((v) => v === "ok") ? 0 : 1);
