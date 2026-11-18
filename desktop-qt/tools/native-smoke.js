#!/usr/bin/env node
// A smoke test of a built desktop app, for machines nobody here can sit at
// (CI's macOS runner): it starts the app on a demo song, checks the page over
// the DevTools protocol, captures what the native audio host sent the device,
// and compares it with the WebAssembly engine's own render of the song.
//
//   node desktop-qt/tools/native-smoke.js <the microtone executable>
//        [--song Eighth.taud] [--seconds 10] [--rate 48000] [--port 9339]
//
// Checked: the page loads from the shell's server, cross-origin isolated
// (SharedArrayBuffer), with OPFS (the projects' store); the native host is
// running and the song plays; the capture is complete; and — at 48 kHz, where
// nothing converts — it is the WebAssembly render, bit for bit. A host load
// figure is reported, not judged (a CI runner's is no one's computer).
//
// Exit 0: all of that. 1: something failed. 3: the page is fine but no audio
// device opened (a runner without one), so the audio was not checked.
//
// The environment passes through: on Linux run it on Xvfb with
// `env -u WAYLAND_DISPLAY QT_QPA_PLATFORM=xcb DISPLAY=:N` and a null sink
// (desktop-qt/README.md, "Running").
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, createWriteStream } from "node:fs";
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

const work = mkdtempSync(join(tmpdir(), "microtone-smoke-"));
const dumpPath = join(work, "native.f32");
const log = createWriteStream(join(work, "app.log"));
const report = { song, seconds, rate, work, checks: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.pipe(log);
app.stderr.pipe(log);
let exited = null;
app.on("exit", (code, signal) => { exited = { code, signal }; });

function finish(code) {
  if (exited === null) app.kill("SIGTERM");
  report.exit = code;
  report.log = readFileSync(join(work, "app.log"), "utf8").split("\n").filter((l) => /microtone|error|fatal/i.test(l)).slice(-20);
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
             native: !!window.__MICROTONE_NATIVE__?.engine, url: location.href };
  })()`);
  report.page = page;
  report.checks.page = page?.isolated && page.sab && page.opfs && page.native ? "ok" : "the page is not what the shell should give it";

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
    finish(report.checks.page === "ok" ? 3 : 1);
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
