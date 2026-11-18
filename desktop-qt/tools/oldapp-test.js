#!/usr/bin/env node
// A test of how the Qt build brings over what the earlier desktop app kept
// (src/oldapp.cpp), through the oldapp-dump tool built beside the app:
//
//   node desktop-qt/tools/oldapp-test.js <oldapp-dump executable> [--browser <chrome or msedge>]
//
// First the copy's rules, on a store laid out as WebKit keeps OPFS (plain
// files beside an `origin` file — the Linux and macOS builds): a new file is
// created, an unchanged one left alone, a changed one replaces its copy only
// while that copy is untouched and otherwise goes beside it as
// "name (from the old app)", someone else's file is never overwritten, names
// are made portable, and the soundfonts' notes are merged in.
//
// Then, with --browser, the Chromium reader on a real profile: a headless
// Chromium (on CI's Windows runner, Edge — WebView2's own engine and storage)
// keeps projects in OPFS under the earlier app's Windows origin,
// http://tauri.localhost, renaming, overwriting, deleting and churning until
// LevelDB writes a compressed table; the tool must list and copy exactly what
// the page says it has.
//
// Exit 0: all passed; 1: something failed (each failure is printed).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const tool = args[0];
const browserAt = args.indexOf("--browser");
const browser = browserAt >= 0 ? args[browserAt + 1] : null;
if (!tool) {
  console.error("usage: node oldapp-test.js <oldapp-dump executable> [--browser <chrome or msedge>]");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "microtone-oldapp-"));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(env, ...toolArgs) {
  const r = spawnSync(tool, toolArgs, { env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status, out: r.stdout + r.stderr };
}
/** "copied: 1 projects, 0 soundfonts, 0 keymaps; 0 beside; 0 failed" → numbers. */
function copied(out) {
  const m = /copied: (\d+) projects, (\d+) soundfonts, (\d+) keymaps; (\d+) beside; (\d+) failed/.exec(out);
  if (!m) return { error: out.trim() };
  const [projects, soundfonts, keymaps, beside, failed] = m.slice(1).map(Number);
  return { projects, soundfonts, keymaps, beside, failed };
}
const text = (path) => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── the rules, on a WebKit-shaped store ──
{
  const base = join(work, "webkit");
  const salt = "a7Fsiu3p4gHsl53EYWy82a6O9fTK595WUsOZCqmtQk0";
  const fs = join(base, "storage", salt, salt, "FileSystem");
  // A dev server's origin beside it, which must not be taken for the app's.
  const decoy = join(base, "storage", "decoy", "decoy");
  mkdirSync(join(decoy, "FileSystem", "projects"), { recursive: true });
  writeFileSync(join(decoy, "origin"), "\x04http\x09127.0.0.1\x04http\x09127.0.0.1");
  writeFileSync(join(decoy, "FileSystem", "projects", "decoy.taud"), "DECOY");
  mkdirSync(fs, { recursive: true });
  writeFileSync(join(base, "storage", salt, salt, "origin"), "\x05tauri\x09localhost\x05tauri\x09localhost");

  let clock = Date.UTC(2026, 9, 1) / 1000;
  const src = (path, data) => {
    const file = join(fs, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    clock += 60;
    utimesSync(file, clock, clock);
  };
  const root = join(work, "Microtone");
  const dst = (path) => join(root, path);
  const mine = (path, data) => {  // the person's own, in the folder
    mkdirSync(dirname(dst(path)), { recursive: true });
    writeFileSync(dst(path), data);
    clock += 60;
    utimesSync(dst(path), clock, clock);
  };
  const env = { MICROTONE_OLDAPP_DIR: base };
  const copy = () => copied(run(env, "--copy", root).out);

  src("projects/a.taud", "A1");
  src("projects/Album/b.taud", "B1");
  src("projects/c.taud", "C1");
  src("projects/d.taud", "D1");
  src("projects/e.taud", "E1");
  src("projects/bad:name?.taud", "BAD");
  src("projects/con.taud", "CON");
  mkdirSync(join(fs, "projects", "Empty folder"), { recursive: true });
  src("soundfonts/s.taud.sf2.gz", "S1");
  src("soundfonts/index.json", JSON.stringify({ "s.taud.sf2.gz": { notes: "old app's" }, "t.taud.sf2.gz": { notes: "t" } }));
  src("soundfonts/sub/nested.taud.sf2.gz", "NESTED");  // the store is flat: not taken
  src("keymaps/k.taudkey", "K1");
  mine("Projects/c.taud", "C1");    // already there, the same bytes
  mine("Projects/d.taud", "MINE");  // someone's own file of that name
  mkdirSync(dst("Projects/e.taud"), { recursive: true });  // a folder where a file would go
  mine("Soundfonts/index.json", JSON.stringify({ "s.taud.sf2.gz": { notes: "the folder's" }, "other.taud.sf2.gz": { notes: "x" } }));

  const listing = run(env).out;
  check(listing.startsWith("webkit: ") && listing.includes(salt) && !listing.includes("decoy"),
    "the app's origin is found, not the dev server's");

  let c = copy();
  check(same(c, { projects: 6, soundfonts: 1, keymaps: 1, beside: 2, failed: 0 }), `first copy: ${JSON.stringify(c)}`);
  check(text(dst("Projects/a.taud")) === "A1" && text(dst("Projects/Album/b.taud")) === "B1", "new files are created, folders and all");
  check(text(dst("Projects/d.taud")) === "MINE" && text(dst("Projects/d (from the old app).taud")) === "D1",
    "someone's own file is kept; the copy goes beside it");
  check(text(dst("Projects/e (from the old app).taud")) === "E1", "a folder in the way: the copy goes beside it");
  check(text(dst("Projects/bad_name_.taud")) === "BAD" && text(dst("Projects/_con.taud")) === "CON",
    "names every system can hold");
  check(statSync(dst("Projects/Empty folder")).isDirectory(), "an empty folder comes too");
  check(text(dst("Soundfonts/nested.taud.sf2.gz")) === null && text(dst("Soundfonts/sub/nested.taud.sf2.gz")) === null,
    "soundfonts are flat, as the page keeps them");
  const index = JSON.parse(text(dst("Soundfonts/index.json")));
  check(index["s.taud.sf2.gz"]?.notes === "the folder's" && index["other.taud.sf2.gz"] && index["t.taud.sf2.gz"]?.notes === "t",
    "the soundfonts' notes are merged, the folder's winning");

  c = copy();
  check(same(c, { projects: 0, soundfonts: 0, keymaps: 0, beside: 0, failed: 0 }), `nothing changed, nothing copied: ${JSON.stringify(c)}`);
  const indexTime = statSync(dst("Soundfonts/index.json")).mtimeMs;

  src("projects/a.taud", "A2");  // changed in the old app; its copy untouched
  c = copy();
  check(c.projects === 1 && c.beside === 0 && text(dst("Projects/a.taud")) === "A2", "a changed file replaces its untouched copy");

  mine("Projects/Album/b.taud", "B by hand");  // the copy changed here...
  src("projects/Album/b.taud", "B2");          // ...and there
  c = copy();
  check(c.beside === 1 && text(dst("Projects/Album/b.taud")) === "B by hand" && text(dst("Projects/Album/b (from the old app).taud")) === "B2",
    "a copy changed since is kept; the new one goes beside it");
  src("projects/Album/b.taud", "B3");
  c = copy();
  check(c.projects === 1 && c.beside === 0 && text(dst("Projects/Album/b (from the old app).taud")) === "B3",
    "the next change replaces the copy beside, while that is untouched");
  mine("Projects/Album/b (from the old app).taud", "B beside, by hand");
  src("projects/Album/b.taud", "B4");
  c = copy();
  check(c.projects === 0 && text(dst("Projects/Album/b (from the old app).taud")) === "B beside, by hand" &&
    text(dst("Projects/Album/b (from the old app) (from the old app).taud")) === null,
    "both copies changed by hand: nothing is overwritten, nor a third made");

  src("projects/d.taud", "D2");
  c = copy();
  check(text(dst("Projects/d (from the old app).taud")) === "D2" && text(dst("Projects/d.taud")) === "MINE",
    "a file that went beside keeps going there");
  check(statSync(dst("Soundfonts/index.json")).mtimeMs === indexTime, "an unchanged index is not rewritten");

  // Written by the earlier app's own hand-over (the same bytes): not again.
  src("keymaps/k2.taudkey", "K2");
  mine("Keymaps/k2.taudkey", "K2");
  c = copy();
  check(c.keymaps === 0 && text(dst("Keymaps/k2.taudkey")) === "K2", "a file the earlier app already handed over counts as copied");

  check(run({ MICROTONE_OLDAPP_DIR: join(work, "nowhere") }).status === 2, "no earlier app: nothing to do");
}

// ── the Chromium reader, on a real profile ──
if (browser) {
  const PAGE = `<!doctype html><meta charset="utf-8"><script>
const enc = (t) => new TextEncoder().encode(t);
async function dir(path) {
  let d = await navigator.storage.getDirectory();
  for (const n of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(n, { create: true });
  return d;
}
async function write(path, bytes) {
  const at = path.lastIndexOf("/");
  const w = await (await (await dir(path.slice(0, at))).getFileHandle(path.slice(at + 1), { create: true })).createWritable();
  await w.write(bytes); await w.close();
}
async function churn(name, count) {
  const junk = await dir("projects/" + name);
  for (let i = 0; i < count; i++) await junk.getFileHandle("junk-file-number-" + String(i).padStart(6, "0") + ".taud", { create: true });
  await (await dir("projects")).removeEntry(name, { recursive: true });
}
async function seed() {
  await write("projects/one.taud", enc("ONE v1"));
  await write("projects/Album/two.taud", enc("TWO ".repeat(4000)));
  await write("projects/Album/Deep/three.taud", enc("THREE"));
  await write("projects/\\uD55C\\uAD6D\\uC5B4 \\uACE1.taud", enc("KO"));
  await write("projects/bad:name?.taud", enc("BAD"));
  await write("projects/gone.taud", enc("GONE"));
  await write("soundfonts/a.taud.sf2.gz", new Uint8Array(70000).map((_, i) => (i * 7) & 255));
  await write("soundfonts/index.json", enc(JSON.stringify({ "a.taud.sf2.gz": { notes: "mine" } })));
  await write("keymaps/Mine.taudkey", enc("KEYS"));
  await churn("junk", 20000);  // until LevelDB flushes a table
  // After the flush: these are in the log, over the table.
  await write("projects/one.taud", enc("ONE v2, longer"));
  await (await (await dir("projects/Album")).getFileHandle("two.taud")).move("two-renamed.taud");
  await (await dir("projects")).removeEntry("gone.taud");
  await (await (await dir("keymaps")).getFileHandle("Mine.taudkey")).move("Yours.taudkey");
  return "seeded";
}
</script>`;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const profile = join(work, "profile");
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`,
    `--host-resolver-rules=MAP tauri.localhost 127.0.0.1:${port}`, "about:blank"], {
    stdio: "ignore",
    // Chromium's singleton socket goes in TMPDIR, and a long one is refused.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TMPDIR")),
  });
  let result = null;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page"); } catch { /* not up */ }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); };
    const send = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send("Page.navigate", { url: "http://tauri.localhost/" });
    await sleep(2000);
    const r = await send("Runtime.evaluate", { expression: "seed().then(() => location.origin + ' seeded', (e) => 'ERROR ' + e)", awaitPromise: true, returnByValue: true });
    result = r.result?.result?.value;
    await send("Browser.close");
    await sleep(2000);
  } catch (err) {
    result = `ERROR ${err}`;
  } finally {
    chrome.kill();
    server.close();
  }
  check(result === "http://tauri.localhost seeded", `the browser kept a store under the earlier app's origin (${result})`);

  const env = { MICROTONE_OLDAPP_DIR: profile };
  const listing = run(env).out.replace(/\r/g, "");
  const files = listing.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim().split("  ").slice(0, 2).join(" "));
  const want = ["Album/", "Album/Deep/", "Album/Deep/three.taud 5", "Album/two-renamed.taud 16000", "bad:name?.taud 3",
    "one.taud 14", "한국어 곡.taud 2", "a.taud.sf2.gz 70000", "index.json 34", "Yours.taudkey 4"];
  const listed = listing.startsWith("chromium: ") && same(files, want);
  check(listed, `the Chromium reader lists the store${listed ? "" : `:\n${listing}`}`);
  let tables = 0;
  try {
    const t = listing.split("\n")[0].slice("chromium: ".length).trim();
    tables = (await import("node:fs")).readdirSync(join(t, "Paths")).filter((n) => n.endsWith(".ldb")).length;
  } catch { /* none */ }
  check(tables > 0, `the index was read from a LevelDB table, not only a log (${tables} tables)`);

  const root = join(work, "FromChromium");
  const c = copied(run(env, "--copy", root).out);
  check(same(c, { projects: 5, soundfonts: 1, keymaps: 1, beside: 0, failed: 0 }), `copied from Chromium: ${JSON.stringify(c)}`);
  check(text(join(root, "Projects/one.taud")) === "ONE v2, longer" && text(join(root, "Projects/Album/two-renamed.taud")) === "TWO ".repeat(4000) &&
    text(join(root, "Projects/한국어 곡.taud")) === "KO" && text(join(root, "Projects/bad_name_.taud")) === "BAD" &&
    text(join(root, "Keymaps/Yours.taudkey")) === "KEYS" && readFileSync(join(root, "Soundfonts/a.taud.sf2.gz")).length === 70000,
  "every file came over with its bytes");
}

console.log(failures ? `${failures} failed (work in ${work})` : `all passed (work in ${work})`);
process.exit(failures ? 1 : 0);
