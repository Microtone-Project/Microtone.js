#!/usr/bin/env node
// The JavaScript engine against the C engine built as WebAssembly, over the
// golden set, SAMPLE FOR SAMPLE — the f32 mix bus and the 8-bit device output
// both. Exits 1 on the first entry that differs anywhere.
//
//   node --no-use-std-math-pow tools/engine-diff.js [label …]
//
// The flag matters. The C engine carries its own pow — V8's fdlibm port, the
// same bits on every machine. Current V8 calls the platform's std::pow instead
// unless told otherwise, and that differs in the last bit now and then; with
// the flag both engines compute one pow and every sample must agree. Without
// it a handful of f32 samples per song may differ (the 8-bit output still may
// not), and this tool says so rather than failing: pass --strict to fail.
//
// A label is a key of tools/golden-set.js's GOLDEN_SET; none = every song on
// this machine.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOLDEN_SET, goldenPath, renderGoldenPcm } from "./golden-set.js";

/** True when this V8 is computing Math.pow with its own fdlibm port — the
 *  build the C engine's pow was taken from. One probe whose last bit the two
 *  implementations are known to disagree on would be fragile; the flag is the
 *  honest test. */
export function powIsFdlibm() {
  return process.execArgv.includes("--no-use-std-math-pow");
}

export async function diffGolden(labels = [], log = () => {}) {
  const out = [];
  for (const [label, entry] of Object.entries(GOLDEN_SET)) {
    if (labels.length && !labels.includes(label)) continue;
    if (!existsSync(goldenPath(entry))) { log(`${label}: not on this machine`); continue; }
    const js = await renderGoldenPcm(entry, "js");
    const wasm = await renderGoldenPcm(entry, "wasm");
    let f32 = 0, firstF32 = -1, u8 = 0, firstU8 = -1;
    const nf = Math.min(js.f32.length, wasm.f32.length);
    for (let i = 0; i < nf; i++) {
      if (js.f32[i] !== wasm.f32[i] && !(js.f32[i] !== js.f32[i] && wasm.f32[i] !== wasm.f32[i])) {
        f32++;
        if (firstF32 < 0) firstF32 = i >> 1;
      }
    }
    const nu = Math.min(js.u8.length, wasm.u8.length);
    for (let i = 0; i < nu; i++) {
      if (js.u8[i] !== wasm.u8[i]) {
        u8++;
        if (firstU8 < 0) firstU8 = i >> 1;
      }
    }
    const r = { label, frames: js.frames, wasmFrames: wasm.frames, f32, firstF32, u8, firstU8 };
    out.push(r);
    log(`${label}: ${js.frames === wasm.frames && f32 === 0 && u8 === 0 ? "identical"
      : `frames ${js.frames}/${wasm.frames}, f32 differs in ${f32} samples (first at frame ${firstF32}), ` +
        `u8 in ${u8} (first at frame ${firstU8})`}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict") || powIsFdlibm();
  const results = await diffGolden(args.filter((a) => !a.startsWith("--")), console.log);
  const lengthOrBytes = results.filter((r) => r.frames !== r.wasmFrames || r.u8 !== 0);
  const floats = results.filter((r) => r.f32 !== 0);
  if (!powIsFdlibm() && floats.length) {
    console.log(`\nMath.pow here is the platform's; the f32 differences above may be its last bit. ` +
      `Re-run with node --no-use-std-math-pow for the exact comparison.`);
  }
  if (lengthOrBytes.length || (strict && floats.length)) {
    console.error(`\n${lengthOrBytes.length + (strict ? floats.filter((r) => !lengthOrBytes.includes(r)).length : 0)} of ` +
      `${results.length} entries differ`);
    process.exit(1);
  }
  console.log(`\n${results.length} entries compared, none differ${strict ? "" : " in length or in the 8-bit output"}`);
}
