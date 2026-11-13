// The C engine built as WebAssembly (core/engine/c/ → taud-engine.wasm.js,
// driven through core/engine/wasm-engine.js).
//
// Held here (what it renders — the golden set and the host scenarios — is
// engine-golden.test.js's, the engine's contract):
//  1. the committed module IS the sources in the tree (no compiler needed to
//     know: the module records a digest of what it was built from), and so
//     are the snapshot layout and the struct layouts written with it;
//  2. it imports nothing and exports the host API;
//  3. instrument data a host replaces under sounding notes is kept for them
//     and then given back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { engineSourceDigest, snapLayoutHeader } from "../../tools/make-engine-wasm.js";
import { engineModule, engineWasmBytes, decodeBase64 } from "../../core/engine/wasm-module.js";
import { ENGINE_SOURCE_SHA256 } from "../../core/engine/taud-engine.wasm.js";
import { ENGINE_LAYOUT, ENGINE_LAYOUT_SOURCE_SHA256 } from "../../core/engine/taud-engine.layout.js";
import { WasmTaudEngine } from "../../core/engine/wasm-engine.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";

test("the committed wasm module is built from the C sources in the tree", () => {
  assert.equal(ENGINE_SOURCE_SHA256, engineSourceDigest(),
    "core/engine/c/ changed — rebuild with node tools/make-engine-wasm.js");
});

test("the struct layouts were written with the module", () => {
  assert.equal(ENGINE_LAYOUT_SOURCE_SHA256, ENGINE_SOURCE_SHA256,
    "taud-engine.layout.js is from another build — rebuild with node tools/make-engine-wasm.js");
  for (const type of ["TaudEngine", "TaudVoice", "TaudInst", "TaudCell", "TaudPatch", "TaudSpatialBus"]) {
    assert.ok(ENGINE_LAYOUT[type]?.size > 0, `a layout for ${type}`);
  }
});

test("the C snapshot layout is the one protocol.js declares", async () => {
  const have = readFileSync(new URL("../../core/engine/c/src/snap_layout.h", import.meta.url), "utf8");
  assert.equal(have, await snapLayoutHeader(),
    "core/worklet/protocol.js moved — rebuild with node tools/make-engine-wasm.js");
});

test("the module imports nothing and carries the host API", () => {
  const mod = engineModule();
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const names = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
  for (const n of ["memory", "_initialize", "malloc", "free", "tw_new", "tw_render_chunk", "tw_fill_snapshot",
    "tw_jam_note", "tw_chase_tracker_row", "tw_set_analysis_bus", "taud_open"]) {
    assert.ok(names.has(n), `exports ${n}`);
  }
});

test("base64 is decoded without atob, exactly", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 257]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 73 + 11) & 0xff);
    const back = decodeBase64(Buffer.from(bytes).toString("base64"));
    assert.deepEqual([...back], [...bytes], `${n} bytes`);
  }
  assert.equal(engineWasmBytes()[0], 0x00);
  assert.equal(String.fromCharCode(...engineWasmBytes().subarray(1, 4)), "asm");
});

test("an engine starts stopped, at the engine's defaults", () => {
  const eng = new WasmTaudEngine(48000);
  assert.equal(eng.isPlaying(0), false);
  assert.equal(eng.getBPM(0), 125);
  assert.equal(eng.getTickRate(0), 6);
  assert.equal(eng.getSongGlobalVolume(0), 0x80);
  assert.equal(eng.getMasterPan(0), 128);
  assert.equal(eng.channelCount(), 32);
  eng.set64ChannelMode(true);
  assert.equal(eng.channelCount(), 64);
  eng.setBPM(0, 5000);
  assert.equal(eng.getBPM(0), 25 + 0x3ff, "the tempo is clamped to the field's range");
  assert.equal(eng.outOfMemory, false);
});

test("instrument data replaced under sounding notes is kept for them, then given back", () => {
  const file = new URL("../../assets/demo_projects/16uba_baion.taud", import.meta.url);
  const doc = parseTaud(readFileSync(file));
  const eng = new WasmTaudEngine(48000);
  loadIntoEngine(eng, doc, 0);
  eng.setCuePosition(0, 0);
  eng.setTrackerRow(0, 0);
  eng.play(0);
  for (let i = 0; i < 200; i++) eng.renderChunk(0);
  const before = eng._x.memory.buffer.byteLength;
  // 1380 patch tables replaced while voices play from them…
  for (let round = 0; round < 60; round++) {
    for (const e of doc.ixmp) eng.uploadInstrumentPatches(e.instId, e.blob);
    eng.renderChunk(0);
  }
  // …of which only the ones a voice still points into may be held,
  const held = eng.retireSweep();
  assert.ok(held < 80, `${held} retired blocks held`);
  // and the heap did not grow by a table per upload: sixty rounds of these
  // tables are over twenty megabytes, and what is held between two sweeps is
  // about one (it levels off after the third round).
  const grew = eng._x.memory.buffer.byteLength - before;
  assert.ok(grew < (4 << 20), `memory grew by ${grew} bytes under re-uploads`);
  assert.equal(eng.outOfMemory, false);
});
