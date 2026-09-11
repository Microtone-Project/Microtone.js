#!/usr/bin/env node
// Build the standalone `taudplay` library (TODO item 179) out of this tree.
//
//   node tools/make-taudplay.js [outDir]    (default ../../../microtone-taudplay)
//
// Microtone.js is the source of truth for the ENGINE — the port rules say never
// to reimplement tracker behaviour, and two hand-maintained copies of an engine
// is exactly the reimplementation those rules forbid. So taudplay is generated:
// its engine is a byte-for-byte copy of this one, its player is the authored
// code in `src/taudplay/`, and the standalone repo is an ARTEFACT. Re-run this
// after any engine change, or the library plays a different song from the app.
//
// Two things come out of it:
//   1. `src/taudplay/worklet.bundle.js` — HERE, committed. The single-file
//      classic-script worklet, for browsers whose AudioWorklet cannot import ES
//      modules (historically Firefox), exactly as the tracker keeps its own.
//   2. `<outDir>/` — the standalone LGPL-3.0 repo: the same sources laid out
//      the same way (so every relative import resolves unchanged), plus the
//      licence texts, a README and a package.json.
//
// There is deliberately NO single-file ESM "dist" for the main thread. This
// project ships ES modules and no build step; a naive concat of the vendored
// compressors alongside the engine is a name-collision waiting to happen, and a
// browser resolves the module graph natively anyway. The worklet is the one
// place a concat is unavoidable, because a classic worklet script cannot import.

import { readFile, writeFile, mkdir, rm, readdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
// A SIBLING of the microtone-js checkout, not a child of it: the library is its
// own repository, and nesting one inside the other makes the parent's git
// status permanently noisy.
const outDir = process.argv[2] ??
  fileURLToPath(new URL("../../../microtone-taudplay/", import.meta.url));

// ── the module graph, in dependency order (mirrors make-worklet-bundle.js) ──
const ENGINE = [
  "src/engine/constants.js",
  "src/engine/minifloat.js",
  "src/engine/rng.js",
  "src/engine/tables.js",
  "src/engine/spatial.js",
  "src/engine/hrir-sadie.js",
  "src/engine/binaural.js",
  "src/engine/speakers.js",
  "src/engine/analysis.js",
  "src/engine/mastering.js",
  "src/engine/loudness.js",
  "src/engine/samplemod.js",
  "src/engine/inst.js",
  "src/engine/voice.js",
  "src/engine/state.js",
  "src/engine/sampler.js",
  "src/engine/filter.js",
  "src/engine/fm.js",
  "src/engine/envelope.js",
  "src/engine/trigger.js",
  "src/engine/effects.js",
  "src/engine/row.js",
  "src/engine/tick.js",
  "src/engine/mixer.js",
  "src/engine/engine.js",
];

/** Everything the worklet bundle concatenates, in order. */
const WORKLET_BUNDLE = [
  ...ENGINE,
  "src/audio/resampler.js",
  "src/audio/offline-render.js", // loadIntoEngine: the one upload sequence
  "src/taudplay/protocol.js",
  "src/taudplay/faders.js",
  "src/taudplay/worklet.js",
];

/** Everything the standalone repo carries, verbatim, at the same paths. */
const REPO_FILES = [
  ...ENGINE,
  "src/engine/fft.js",           // analysis.js imports it
  "src/audio/resampler.js",
  "src/audio/offline-render.js",
  "src/format/taud-const.js",
  "src/format/compress.js",
  "src/format/mastering-section.js",
  "src/format/taud-parse.js",
  "src/taudplay/protocol.js",
  "src/taudplay/faders.js",
  "src/taudplay/interrupts.js",
  "src/taudplay/worklet.js",
  "src/taudplay/player.js",
  "src/taudplay/render.js",
  "src/taudplay/index.js",
  "vendor/fflate.esm.js",
  "vendor/fzstd.esm.js",
];

// ── 1. the single-file classic worklet ──────────────────────────────────────

async function buildWorkletBundle() {
  let out = `// GENERATED FILE — do not edit. Rebuild with: node tools/make-taudplay.js
// Single-file concat of the Taud engine + taudplay's worklet, for browsers
// whose AudioWorklet cannot import ES modules.
"use strict";
`;
  for (const rel of WORKLET_BUNDLE) {
    let src = await readFile(root + rel, "utf8");
    src = src.replace(/^import\s[\s\S]*?from\s*"[^"]+";\s*$/gm, "");
    src = src.replace(/^export\s+(async\s+function|function|const|class|let|var)/gm, "$1");
    out += `\n// ══ ${rel} ══\n${src}`;
  }
  if (/^\s*(import|export)\s/m.test(out)) {
    const line = out.split("\n").find((l) => /^\s*(import|export)\s/.test(l));
    throw new Error(`unstripped module syntax: ${line}`);
  }
  // Every module the graph imports must actually BE on the list: stripping the
  // import lines hides a missing file completely, and the only symptom is a
  // ReferenceError inside AudioWorkletGlobalScope where nothing can report it.
  const listed = new Set(WORKLET_BUNDLE);
  const missing = new Set();
  for (const rel of WORKLET_BUNDLE) {
    const src = await readFile(root + rel, "utf8");
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    for (const m of src.matchAll(/^import\s[\s\S]*?from\s*"([^"]+)";/gm)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const abs = new URL(spec, `file:///${dir}/`).pathname.replace(/^\/+/, "");
      if (!listed.has(abs)) missing.add(`${rel} imports ${spec}`);
    }
  }
  if (missing.size > 0) throw new Error(`module(s) missing from WORKLET_BUNDLE:\n  ${[...missing].join("\n  ")}`);
  return out;
}

// ── 2. the standalone repo ──────────────────────────────────────────────────

const PACKAGE_JSON = (version) => JSON.stringify({
  name: "taudplay",
  version,
  description:
    "Plays .taud tracker songs in the browser and in Node. One fader per voice, " +
    "two probes per voice, no editor.",
  type: "module",
  main: "./src/taudplay/index.js",
  exports: { ".": "./src/taudplay/index.js" },
  files: ["src", "COPYING", "COPYING.LESSER", "README.md"],
  license: "LGPL-3.0-or-later",
  author: "CuriousTorvald",
  keywords: ["taud", "tracker", "microtone", "audio", "webaudio", "chiptune", "module"],
  repository: { type: "git", url: "https://github.com/curioustorvald/microtone-taudplay" },
  engines: { node: ">=22" },
  scripts: { test: "node --test" },
}, null, 2) + "\n";

const README = (version, engineHash) => `# taudplay

**Play \`.taud\` songs — in a browser tab, or in Node. No tracker attached.**

\`taudplay\` is the playback half of the [Microtone](https://microtone.cc)
tracker, cut down to the part a *listener* needs. It is the same engine, note
for note and sample for sample: a file rendered here is bit-identical to the
same file rendered in the tracker.

What it exposes is deliberately small — the whole API is a transport, **one
fader per voice**, and **two probes per voice**:

| | |
|---|---|
| **Knob** | \`setVoiceGain(voice, gain, fadeMs)\` — 1 = as written, 0 = silent |
| **Probe** | \`getVoiceVolume(voice)\` — how loud that channel is right now, 0…1 |
| **Probe** | \`getVoicePan(voice)\` — where it sits, 0 (left) … 0.5 … 1 (right) |

…plus **interrupts**: sixteen events the *song itself* fires, in time with the
music (\`setInterrupt(n, fn)\`).

That is the point. A game does not want a pattern editor; it wants to duck the
lead when the player enters a cave, bring the drums up in combat, and draw a
little dancing meter on the pause screen. A tracker song is 32 or 64
independent channels of music that were *written together* — fading them
against each other gives you contextual scoring for the cost of one file.

## Install

\`\`\`
npm install taudplay
\`\`\`

…or just copy \`src/\` in. There is no build step and no dependency to install:
everything is ES modules, and the two vendored decompressors are single files.

## Play something

\`\`\`js
import { TaudPlayer } from "taudplay";

const player = await new TaudPlayer().init();
const songs = await player.load(await (await fetch("theme.taud")).arrayBuffer());

// Browsers only start audio from a user gesture.
button.onclick = async () => { await player.resume(); player.play(); };
\`\`\`

### Mix it

\`\`\`js
player.setVoiceGain(4, 0.0, 1200);   // fade channel 5 out over 1.2 s
player.setVoiceGain(4, 1.0, 400);    // …and back in, faster

// Duck everything but the drums.
for (let v = 0; v < player.channelCount; v++) {
  if (v !== DRUMS) player.setVoiceGain(v, 0.3, 800);
}
\`\`\`

The fade is applied inside the audio worklet, once per rendered block (every
2.7 ms at 48 kHz), so a slow fade is smooth without your game loop driving it.
A voice's NNA ghosts and metainstrument layer children follow its fader, so a
faded channel really does take everything it spawned with it.

### Let the song call you

A song can fire sixteen **interrupts** — \`Int0\`…\`IntF\`, written in a note
column, making no sound and disturbing no channel. Each carries a number the
composer chose (0…65535). That is the song telling your program something, on
the beat, without your program having to guess where the beat is.

\`\`\`js
player.setInterrupt(0, (arg) => flashLight(arg));        // arg = which lamp
player.setInterrupt(1, () => spawnEnemyWave());
player.setInterrupt(2, (arg) => showSubtitle(lines[arg]));
\`\`\`

Callbacks run on the main thread, from the same ~16 ms snapshot the probes ride
on, so they can touch the DOM, your renderer, anything. \`setInterrupt(n, null)\`
unregisters one; \`clearInterrupts()\` drops the lot. If the same interrupt fires
twice inside one snapshot window you are called once, with the later argument.

\`TaudRenderer\` has the same call, dispatched per rendered block — which is how
you bounce a song and get its cue list out at the same time.

### Watch it

\`\`\`js
function frame() {
  for (let v = 0; v < player.channelCount; v++) {
    bars[v].style.height = \`\${player.getVoiceVolume(v) * 100}%\`;
    bars[v].style.left = \`\${player.getVoicePan(v) * 100}%\`;
  }
  requestAnimationFrame(frame);
}
\`\`\`

Both probes are read out of a snapshot the worklet posts about every 16 ms, so
reading them costs nothing and they never block the audio thread.

### Use your own graph

\`\`\`js
await player.init({ context: myAudioContext, destination: myReverbSend });
\`\`\`

## …and in Node

\`TaudRenderer\` is the same library without Web Audio: you pull blocks instead
of the sound card pulling them, and the probes describe the state at the end of
each block.

\`\`\`js
import { readFile, writeFile } from "node:fs/promises";
import { TaudRenderer } from "taudplay";

const r = new TaudRenderer(await readFile("theme.taud"));
r.setVoiceGain(4, 0);                      // bounce the song without channel 5
await writeFile("theme.wav", r.toWav(120));
\`\`\`

Or drive it block by block and automate the mix as it renders:

\`\`\`js
r.play();
let pcm = r.render(30, (rr, frame) => {
  if (frame === 48000 * 8) rr.setVoiceGain(4, 0, 2.0);  // fade at 0:08
});
\`\`\`

## API

### \`TaudPlayer\` (browser)

- \`await init({ context, destination, snapshotIntervalMs, workletUrl })\`
- \`await resume()\` / \`await close()\` — \`running\`, \`sampleRate\`
- \`await load(bytes)\` → song descriptors; \`songs\`, \`title\`, \`info\`
- \`selectSong(i)\`, \`play()\`, \`stop()\`, \`seekCue(n)\`, \`setVolume(0…1)\`
- \`setBinaural(on)\` — head-model monitoring for surround songs
- \`setVoiceGain(v, gain, fadeMs)\`, \`getVoiceGain(v)\`
- \`getVoiceVolume(v)\`, \`getVoicePan(v)\`
- \`setInterrupt(n, fn)\`, \`clearInterrupts()\` — the song's own 16 events
- \`playing\`, \`cue\`, \`row\`, \`bpm\`, \`speed\`, \`channelCount\`
- \`onSnapshot\`, \`onLoaded\` callbacks

### \`TaudRenderer\` (anywhere)

The same knob, probes, interrupts and transport, plus \`renderChunk()\`,
\`render(seconds, onChunk)\` and \`toWav(seconds, { sampleRate })\`.

## What is *not* here

No pattern or instrument editing, no document model, no undo, no import
converters, no jam keyboard, no analysis or loudness metering, no stem or
ambisonic export, and no per-voice observability beyond those two numbers. All
of that lives in [Microtone](https://microtone.cc), which is where songs are
made. This library only plays them.

Songs are made with **Microtone** — a tracker for the notes a piano cannot
play, free and in your browser at [microtone.cc](https://microtone.cc).

## Format support

Full \`.taud\` files, any format version the engine reads, 32- or 64-channel,
stereo or surround. \`.tsii\` (samples and instruments) and \`.tpif\` (a single
pattern) carry no song and are rejected.

## Licence

LGPL-3.0-or-later — see \`COPYING.LESSER\` (and \`COPYING\` for the GPL text it
builds on). You may link this library into a proprietary application; changes
*to the library itself* must be shared.

The vendored decompressors keep their own (MIT) licences:
[fflate](https://github.com/101arrowz/fflate) and
[fzstd](https://github.com/101arrowz/fzstd). The binaural filter set in
\`src/engine/hrir-sadie.js\` is the GoogleVR/SADIE set, Apache-2.0.

---

Generated from Microtone.js ${version} (engine ${engineHash}) by
\`tools/make-taudplay.js\`. Do not edit the engine here — edit it there and
regenerate, or the library and the tracker stop agreeing about what a song
sounds like.
`;

const GITIGNORE = "node_modules/\n*.wav\n";

/** Corpus songs the library's tests need. Small ones: the repo is a library,
 *  not a music archive. */
const TEST_CORPUS = ["WHEN.taud", "slumberjack.taud"];

async function main() {
  // 1. the committed worklet bundle, in THIS tree
  const bundle = await buildWorkletBundle();
  await writeFile(root + "src/taudplay/worklet.bundle.js", bundle);
  console.log(`wrote src/taudplay/worklet.bundle.js (${bundle.length} bytes)`);

  // 2. the standalone repo
  const pkg = JSON.parse(await readFile(root + "package.json", "utf8"));
  // A cheap content hash over the engine sources: it tells a reader of the
  // generated repo whether it was cut from the engine they are looking at.
  let acc = 0n;
  for (const rel of ENGINE) {
    for (const b of await readFile(root + rel)) acc = (acc * 131n + BigInt(b)) & 0xffffffffffffffffn;
  }
  const engineHash = acc.toString(16).padStart(16, "0").slice(0, 12);

  for (const sub of ["src", "vendor"]) {
    await rm(join(outDir, sub), { recursive: true, force: true });
  }
  for (const rel of REPO_FILES) {
    const dest = join(outDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(root + rel, dest);
  }
  await writeFile(join(outDir, "src/taudplay/worklet.bundle.js"), bundle);
  await writeFile(join(outDir, "package.json"), PACKAGE_JSON(pkg.version));
  await writeFile(join(outDir, "README.md"), README(pkg.version, engineHash));
  await writeFile(join(outDir, ".gitignore"), GITIGNORE);
  await copyFile(root + "../COPYING", join(outDir, "COPYING"));
  await copyFile(fileURLToPath(new URL("./lgpl-3.0.txt", import.meta.url)),
    join(outDir, "COPYING.LESSER"));

  // The library's own tests travel with it, at the SAME depth as here, so the
  // `../../src/…` imports inside them resolve in both trees untouched.
  await rm(join(outDir, "test"), { recursive: true, force: true });
  await mkdir(join(outDir, "test/taudplay"), { recursive: true });
  for (const f of await readdir(root + "test/taudplay")) {
    await copyFile(root + "test/taudplay/" + f, join(outDir, "test/taudplay", f));
  }
  await mkdir(join(outDir, "test/corpus"), { recursive: true });
  for (const f of TEST_CORPUS) {
    await copyFile(root + "test/corpus/" + f, join(outDir, "test/corpus", f));
  }

  const n = REPO_FILES.length + 1;
  console.log(`wrote ${outDir} (${n} sources + licences, engine ${engineHash})`);
}

await main();
