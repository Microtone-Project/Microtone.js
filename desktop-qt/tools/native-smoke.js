#!/usr/bin/env node
// A smoke test of a built desktop app, for machines nobody here can sit at
// (CI's macOS runner): it starts the app on a demo song, checks the page over
// the DevTools protocol, captures what the native audio host sent the device,
// and compares it with the WebAssembly engine's own render of the song.
//
//   node desktop-qt/tools/native-smoke.js <the microtone executable>
//        [--song Eighth.taud] [--seconds 10] [--rate 48000] [--port 9339]
//        [--expect-platform wayland|xcb|cocoa|windows]
//
// --expect-platform: the windowing Qt must have chosen (the log's first
// line says), e.g. that a Linux package runs natively on Wayland.
//
// Checked: the page loads from the shell's server, cross-origin isolated
// (SharedArrayBuffer), with OPFS; the file store (~/Microtone, here a
// folder of the test's own) takes a 40 MB project and gives it back; what an
// earlier desktop app kept (a store laid out as WebKit keeps it) comes over
// into that folder and the page says so; online projects reach the site
// through the app (one GET of https://microtone.cc/api/online/me: TLS works
// in the packaged app); the native host is
// running and the song plays; the capture is complete; and — at 48 kHz, where
// nothing converts — it is the WebAssembly render, bit for bit. A host load
// figure is reported, not judged (a CI runner's is no one's computer).
//
// Exit 0: all of that. 1: something failed. 3: the page and the files are
// fine but no audio device opened (a runner without one), so the audio was
// not checked.
//
// The environment passes through: on Linux run it on Xvfb with
// `env -u WAYLAND_DISPLAY QT_QPA_PLATFORM=xcb DISPLAY=:N` and a null sink
// (desktop-qt/README.md, "Running").
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url);
const args = process.argv.slice(2);
const exe = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (!exe) {
  console.error("usage: node native-smoke.js <microtone executable> [--song X.taud] [--seconds N] [--rate R] [--port P]");
  process.exit(2);
}
const song = opt("song", "Eighth.taud");
const seconds = Number(opt("seconds", "10"));
const rate = Number(opt("rate", "48000"));
const port = Number(opt("port", "9339"));
const expectPlatform = opt("expect-platform", null);

const work = mkdtempSync(join(tmpdir(), "microtone-smoke-"));
const dumpPath = join(work, "native.f32");
const log = createWriteStream(join(work, "app.log"));
const report = { song, seconds, rate, work, checks: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What an earlier desktop app kept, as WebKit keeps OPFS (src/oldapp.h).
const oldApp = join(work, "oldapp");
const oldStore = join(oldApp, "storage", "salt", "salt");
mkdirSync(join(oldStore, "FileSystem", "projects", "Album"), { recursive: true });
mkdirSync(join(oldStore, "FileSystem", "keymaps"), { recursive: true });
writeFileSync(join(oldStore, "origin"), "\x05tauri\x09localhost\x05tauri\x09localhost");
writeFileSync(join(oldStore, "FileSystem", "projects", "Album", "Old song.taud"), "an earlier app's project");
writeFileSync(join(oldStore, "FileSystem", "keymaps", "Old.taudkey"), "an earlier app's keymap");

// ── the app ──
const app = spawn(exe, ["--open", `index.html?load=assets/demo_projects/${song}&autoplay`], {
  env: {
    ...process.env,
    QTWEBENGINE_REMOTE_DEBUGGING: String(port),
    QT_FORCE_STDERR_LOGGING: "1",
    MICROTONE_NATIVE_DUMP: dumpPath,
    MICROTONE_NATIVE_DUMP_SECONDS: String(seconds),
    // Core Audio's default keeps the device's own rate; ask for the engine's,
    // where the capture can be compared without a resampler in between.
    MICROTONE_SAMPLE_RATE: String(rate),
    // The file store's folder: the test's own, not the person's ~/Microtone.
    MICROTONE_FILES_ROOT: join(work, "Microtone"),
    MICROTONE_OLDAPP_DIR: oldApp,
    // Linux: the app's own data (its web profile, the copy's record) in the
    // test's folder too. Windows and macOS do not read it.
    XDG_DATA_HOME: join(work, "data"),
    // …and its settings and cache: never the person's own (the audio
    // crash guard and the window's place live in the settings).
    XDG_CONFIG_HOME: join(work, "config"),
    XDG_CACHE_HOME: join(work, "cache"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.pipe(log);
app.stderr.pipe(log);
let exited = null;
app.on("exit", (code, signal) => { exited = { code, signal }; });

function finish(code) {
  if (exited === null) app.kill("SIGTERM");
  const lines = readFileSync(join(work, "app.log"), "utf8").split("\n");
  // "Microtone <v>; Qt <v> (<platform>); …" (src/diagnostics.cpp)
  report.platform = lines.map((l) => /^Microtone \S+; Qt \S+ \(([^)]+)\)/.exec(l)?.[1]).find(Boolean) ?? null;
  if (expectPlatform) {
    report.checks.platform = report.platform === expectPlatform ? "ok" : `${report.platform}, not ${expectPlatform}`;
    if (report.platform !== expectPlatform) code = 1;
  }
  report.exit = code;
  report.log = lines.filter((l) => /microtone|error|fatal/i.test(l)).slice(-20);
  console.log(JSON.stringify(report, null, 1));
  setTimeout(() => process.exit(code), 500);
}

// ── the page ──
let target;
for (let i = 0; i < 120 && !target && exited === null; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((x) => x.type === "page" && x.url.includes("microtone.localhost"));
  } catch { /* not up yet */ }
  if (!target) await sleep(500);
}
if (!target) {
  report.checks.page = exited ? `the app exited (${JSON.stringify(exited)})` : "no page after 60 s";
  finish(1);
} else {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ev = (expression) => new Promise((r) => {
    const n = ++id;
    pending.set(n, (m) => r(m.result?.exceptionDetails ? { error: m.result.exceptionDetails.exception?.description } : m.result?.result?.value));
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });

  // The app shell is up once its debug handle is.
  for (let i = 0; i < 60 && !(await ev("!!window.__microtone?.store")); i++) await sleep(500);
  const page = await ev(`(async () => {
    let opfs = false;
    try { await navigator.storage.getDirectory(); opfs = true; } catch { /* none */ }
    return { isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer === "function", opfs,
             shell: !!window.__MICROTONE_NATIVE__?.files, url: location.href };
  })()`);
  report.page = page;
  // The native audio host is the audio check's: a runner without a sound
  // device has none, and the page is no less right for it.
  report.checks.page = page?.isolated && page.sab && page.opfs && page.shell ? "ok" : "the page is not what the shell should give it";

  // The file store: a project bigger than any default request limit, in and
  // out through the page's own storage module.
  report.files = await ev(`(async () => {
    const o = await import("/src/storage/opfs.js");
    if (o.backend !== "native") return { error: "the page has no file store" };
    const bytes = new Uint8Array(40 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 255;
    try {
      await o.write("Smoke/test.taud", bytes);
      const back = await o.read("Smoke/test.taud");
      let same = back.length === bytes.length;
      for (let i = 0; same && i < bytes.length; i += 4096) same = back[i] === bytes[i];
      const listed = (await o.list()).some((f) => f.name === "Smoke/test.taud");
      await o.removeFolder("Smoke");
      return { same, listed, gone: !(await o.exists("Smoke")) };
    } catch (err) {
      return { error: String(err) };
    }
  })()`);
  report.checks.files = report.files?.same && report.files.listed && report.files.gone
    ? "ok" : `the file store failed: ${JSON.stringify(report.files)}`;

  // What the earlier app kept: in the folder, and said once.
  report.oldApp = await ev(`(async () => {
    const c = await import("/src/storage/carry-over.js");
    const o = await import("/src/storage/opfs.js");
    const status = await c.oldAppCopy({ every: 250 });
    let banner = false;
    for (let i = 0; i < 40 && !banner; i++) {
      banner = [...document.querySelectorAll(".banner")].some((b) => b.textContent.includes(o.location("root")));
      if (!banner) await new Promise((r) => setTimeout(r, 250));
    }
    return { status, files: (await o.list()).map((f) => f.name), keymaps: await o.listKeymaps(), banner };
  })()`);
  const old = report.oldApp;
  report.checks.oldApp = old?.status?.found && old.status.projects === 1 && old.status.keymaps === 1 &&
    old.files.includes("Album/Old song.taud") && old.keymaps.includes("Old.taudkey") && old.banner
    ? "ok" : `the earlier app's projects did not come over: ${JSON.stringify(old)}`;

  // Online projects: the site's own API, through the app's proxy (online.h).
  report.online = await ev(`(async () => (await import("/core/storage/online.js")).status())()`);
  report.checks.online = report.online?.available
    ? "ok" : `the site's online API did not answer through the app: ${JSON.stringify(report.online)}`;

  // Audio: autoplay starts it; a gesture-less start where it did not.
  for (let i = 0; i < 20 && !(await ev("!!window.__microtone.store.audio?.isPlaying()")); i++) await sleep(500);
  if (!(await ev("!!window.__microtone.store.audio"))) await ev("window.__microtoneEnsureAudio()");
  const audio = await ev(`(() => {
    const a = window.__microtone.store.audio;
    return a ? { native: a.usingNative, playing: a.isPlaying(), status: a.native?.hello ?? null } : null;
  })()`);
  report.audio = audio;
  if (!audio?.native) {
    report.checks.audio = "no native audio (no output device?): the page plays through Web Audio";
    ws.close();
    const quiet = ["page", "files", "oldApp", "online"].every((k) => report.checks[k] === "ok");
    finish(quiet ? 3 : 1);
  } else {
    report.checks.audio = audio.playing ? "ok" : "the song is not playing";
    await ev("window.__microtone.store.audio.setProfiling(true)");

    // The capture: written by the app once it holds `seconds` of audio.
    const want = seconds * (audio.status?.rate || rate) * 2 * 4;
    const until = Date.now() + (seconds + 60) * 1000;
    let size = 0;
    while (Date.now() < until && size < want) {
      await sleep(1000);
      try { size = statSync(dumpPath).size; } catch { size = 0; }
    }
    report.profile = await ev(`(() => {
      const p = window.__microtone.store.audio.profile;
      return p && { cpuFrac: p.cpuFrac, procMaxMs: p.procMaxMs, quantumMs: p.quantumMs, xruns: p.xruns, peakVoices: p.peakVoices };
    })()`);
    ws.close();
    if (size < want) {
      report.checks.capture = `${size} of ${want} bytes`;
      finish(1);
    } else {
      report.checks.capture = "ok";
      if (audio.status?.rate !== 48000) {
        report.checks.bitExact = `skipped: the device runs at ${audio.status?.rate} Hz`;
      } else {
        // The WebAssembly engine's render of the same song, from its start.
        const { parseTaud } = await import(new URL("core/format/taud-parse.js", REPO));
        const { TaudEngine } = await import(new URL("core/engine/engine.js", REPO));
        const { setSamplingRate } = await import(new URL("core/engine/constants.js", REPO));
        const { loadIntoEngine, renderSong } = await import(new URL("core/audio/offline-render.js", REPO));
        setSamplingRate(48000);
        const eng = new TaudEngine(48000);
        loadIntoEngine(eng, parseTaud(readFileSync(new URL(`microtone-worker/assets/demo_projects/${song}`, REPO))), 0);
        const ref = renderSong(eng, seconds).f32;
        const nat = new Float32Array(readFileSync(dumpPath).buffer.slice(0));
        const n = Math.min(ref.length, nat.length);
        let diffs = 0, first = -1, max = 0;
        for (let i = 0; i < n; i++) {
          if (ref[i] !== nat[i]) {
            diffs++;
            if (first < 0) first = i;
            max = Math.max(max, Math.abs(ref[i] - nat[i]));
          }
        }
        report.compare = { frames: n / 2, differ: diffs, firstFrame: first >= 0 ? first >> 1 : null, maxAbs: max };
        report.checks.bitExact = diffs === 0 && n > 0 ? "ok" : `${diffs} of ${n} samples differ`;
      }
      const ok = Object.values(report.checks).every((v) => v === "ok" || String(v).startsWith("skipped"));
      finish(ok ? 0 : 1);
    }
  }
}
