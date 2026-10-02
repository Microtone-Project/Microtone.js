#!/usr/bin/env node
// Render a .taud through the reference (JS) Taud engine to PCM dumps — the
// layout tsvm/devtests/webconf/RenderDumpTest.java writes too, so a port can be
// checked against these with tools/compare-pcm.js:
//   <out>/<name>.u8.pcm   interleaved stereo unsigned-8 (device output)
//   <out>/<name>.f32.pcm  interleaved stereo float32 LE pre-dither mix bus
// Usage: node tools/render-taud.js <in.taud> <outDir> [seconds=20] [songIndex=0]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseTaud } from "../core/format/taud-parse.js";
import { TaudEngine } from "../core/engine/engine.js";
import { SAMPLING_RATE } from "../core/engine/constants.js";
import { loadIntoEngine, renderSong } from "../core/audio/offline-render.js";

export { loadIntoEngine, renderSong }; // back-compat for older importers

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const [inPath, outDir = "/tmp/tauddump-js", secondsArg, songArg] = process.argv.slice(2);
  if (!inPath) {
    console.error("usage: render-taud.js <in.taud> <outDir> [seconds=20] [songIndex=0]");
    process.exit(2);
  }
  const seconds = secondsArg ? parseInt(secondsArg, 10) : 20;
  const songIndex = songArg ? parseInt(songArg, 10) : 0;

  const doc = parseTaud(await readFile(inPath));
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc, songIndex);
  const t0 = performance.now();
  const r = renderSong(eng, seconds);
  const dt = performance.now() - t0;

  await mkdir(outDir, { recursive: true });
  const base = basename(inPath).replace(/\.taud$/, "");
  await writeFile(join(outDir, base + ".u8.pcm"), r.u8);
  await writeFile(join(outDir, base + ".f32.pcm"), Buffer.from(r.f32.buffer, r.f32.byteOffset, r.f32.byteLength));
  console.log(`${base}: frames=${r.frames} (${(r.frames / SAMPLING_RATE).toFixed(1)}s) halted=${r.halted} rendered in ${dt.toFixed(0)}ms (${(r.frames / SAMPLING_RATE / (dt / 1000)).toFixed(1)}x realtime)`);
}
