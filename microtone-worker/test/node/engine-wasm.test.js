// The C engine built as WebAssembly (core/engine/c/ → taud-engine.wasm.js,
// driven through core/engine/wasm-engine.js).
//
// Three things are held here:
//  1. the committed module IS the sources in the tree (no compiler needed to
//     know: the module records a digest of what it was built from);
//  2. it imports nothing and exports the host API;
//  3. what it renders for the golden set — digests in
//     test/fixtures/engine-golden-wasm.json, the same on every machine since
//     the module carries its own maths — and that this is, sample for sample,
//     what the JavaScript engine renders (tools/engine-diff.js, run in a child
//     with V8's own pow so both sides compute the same one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  GOLDEN_SET, GOLDEN_RATE, GOLDEN_SECONDS, GOLDEN_SEED, goldenPath, renderGolden,
} from "../../tools/golden-set.js";
import { engineSourceDigest, snapLayoutHeader } from "../../tools/make-engine-wasm.js";
import { engineModule, engineWasmBytes, decodeBase64 } from "../../core/engine/wasm-module.js";
import { ENGINE_SOURCE_SHA256 } from "../../core/engine/taud-engine.wasm.js";
import { WasmTaudEngine } from "../../core/engine/wasm-engine.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/engine-golden-wasm.json", import.meta.url), "utf8"));
const jsFixture = JSON.parse(readFileSync(new URL("../fixtures/engine-golden.json", import.meta.url), "utf8"));

test("the committed wasm module is built from the C sources in the tree", () => {
  assert.equal(ENGINE_SOURCE_SHA256, engineSourceDigest(),
    "core/engine/c/ changed — rebuild with node tools/make-engine-wasm.js");
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
  assert.equal(eng.getBPM(0), 25 + 0x3ff, "the tempo is clamped as the JavaScript engine clamps it");
  assert.equal(eng.outOfMemory, false);
});

test("wasm golden fixture matches the golden set's render settings", () => {
  assert.equal(fixture.rate, GOLDEN_RATE);
  assert.equal(fixture.seconds, GOLDEN_SECONDS);
  assert.equal(fixture.seed, GOLDEN_SEED);
  for (const label of Object.keys(GOLDEN_SET)) {
    if (existsSync(goldenPath(GOLDEN_SET[label]))) {
      assert.ok(fixture.songs[label], `${label} has no digest — run tools/make-golden.js --wasm`);
    }
  }
});

test("the two engines' recorded renders agree on every 8-bit output", () => {
  // The f32 bus may differ in a last bit where the JavaScript engine's digest
  // was recorded with the platform's pow; what the device plays may not.
  for (const [label, w] of Object.entries(fixture.songs)) {
    const j = jsFixture.songs[label];
    if (!j) continue;
    assert.equal(w.frames, j.frames, `${label}: rendered length`);
    assert.equal(w.u8, j.u8, `${label}: U8 device output digest`);
  }
});

for (const [label, entry] of Object.entries(GOLDEN_SET)) {
  const want = fixture.songs[label];
  const present = existsSync(goldenPath(entry));
  test(`wasm golden render: ${label}`, { skip: !present ? "file not on this machine" : !want ? "no digest recorded" : false }, async () => {
    const got = await renderGolden(entry, "wasm");
    assert.equal(got.frames, want.frames, "rendered length");
    assert.equal(got.f32, want.f32, "f32 mix bus digest");
    assert.equal(got.u8, want.u8, "U8 device output digest");
  });
}

// V8 computes Math.pow with the platform's libm unless told to keep its own
// fdlibm port — which is the one the C engine carries. Only with that flag do
// the two engines compute the same pow, so the exact comparison runs in a
// child that has it.
const POW_FLAG = "--no-use-std-math-pow";
const flagKnown = spawnSync(process.execPath, [POW_FLAG, "-e", "0"]).status === 0;

test("everything a host does besides playing from the top is sample for sample the JavaScript engine's",
  { skip: flagKnown ? false : `this Node has no ${POW_FLAG}` }, () => {
    // Auditioning, the chase, starting at a row, faders, edits under sounding
    // notes, resets, a second file: tools/engine-scenarios-diff.js.
    const tool = fileURLToPath(new URL("../../tools/engine-scenarios-diff.js", import.meta.url));
    const r = spawnSync(process.execPath, [POW_FLAG, tool], { encoding: "utf8", maxBuffer: 1 << 24 });
    assert.equal(r.status, 0, `engine-scenarios-diff found a difference:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /scenarios compared, none differ\n$/);
    assert.doesNotMatch(r.stdout, /peak 0\.000/, "no scenario may render silence");
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
  // and the heap did not grow by a table per upload (each is some kilobytes).
  assert.ok(eng._x.memory.buffer.byteLength - before < (1 << 20), "memory grew under re-uploads");
  assert.equal(eng.outOfMemory, false);
});

test("the wasm engine renders the golden set sample for sample as the JavaScript engine does",
  { skip: flagKnown ? false : `this Node has no ${POW_FLAG}` }, () => {
    const tool = fileURLToPath(new URL("../../tools/engine-diff.js", import.meta.url));
    const r = spawnSync(process.execPath, [POW_FLAG, tool], { encoding: "utf8", maxBuffer: 1 << 24 });
    assert.equal(r.status, 0, `engine-diff found a difference:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /entries compared, none differ\n$/);
  });
