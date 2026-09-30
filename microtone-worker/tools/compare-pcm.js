#!/usr/bin/env node
// Compare two PCM dumps — two builds of the reference engine, or a port
// (e.g. TSVM's RenderDumpTest) against the reference.
//   .u8.pcm  → exact-byte %, max abs LSB delta, histogram of deltas
//   .f32.pcm → max abs error, RMS error, first divergence position
// Usage: node tools/compare-pcm.js <a.pcm> <b.pcm>

import { readFile } from "node:fs/promises";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: compare-pcm.js <a.pcm> <b.pcm>");
  process.exit(2);
}

const a = await readFile(aPath);
const b = await readFile(bPath);
const isF32 = aPath.endsWith(".f32.pcm") || bPath.endsWith(".f32.pcm");
const n = Math.min(a.length, b.length);
if (a.length !== b.length) {
  console.log(`length mismatch: ${a.length} vs ${b.length} (comparing first ${n} bytes)`);
}

if (isF32) {
  const fa = new Float32Array(a.buffer, a.byteOffset, Math.floor(n / 4));
  const fb = new Float32Array(b.buffer, b.byteOffset, Math.floor(n / 4));
  let maxErr = 0, sumSq = 0, firstDiv = -1, over1e6 = 0;
  for (let i = 0; i < fa.length; i++) {
    const e = Math.abs(fa[i] - fb[i]);
    if (e > maxErr) maxErr = e;
    if (e > 1e-6) over1e6++;
    if (e !== 0 && firstDiv < 0) firstDiv = i;
    sumSq += e * e;
  }
  const rms = Math.sqrt(sumSq / fa.length);
  console.log(`f32: samples=${fa.length} maxAbsErr=${maxErr.toExponential(3)} rmsErr=${rms.toExponential(3)} >1e-6=${over1e6} (${((100 * over1e6) / fa.length).toFixed(4)}%) firstDivergence=${firstDiv < 0 ? "none" : `sample ${firstDiv} (${(firstDiv / 2 / 32000).toFixed(3)}s)`}`);
  process.exit(maxErr <= 1e-6 ? 0 : 1);
} else {
  let exact = 0, maxDelta = 0, firstDiv = -1;
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d === 0) exact++;
    else {
      if (firstDiv < 0) firstDiv = i;
      hist.set(d, (hist.get(d) ?? 0) + 1);
      if (d > maxDelta) maxDelta = d;
    }
  }
  const histStr = [...hist.entries()].sort((x, y) => x[0] - y[0]).slice(0, 8)
    .map(([d, c]) => `±${d}×${c}`).join(" ");
  console.log(`u8: bytes=${n} exact=${((100 * exact) / n).toFixed(3)}% maxDelta=${maxDelta} deltas[${histStr}] firstDivergence=${firstDiv < 0 ? "none" : `byte ${firstDiv} (${(firstDiv / 2 / 32000).toFixed(3)}s)`}`);
  process.exit(exact / n >= 0.999 && maxDelta <= 1 ? 0 : 1);
}
