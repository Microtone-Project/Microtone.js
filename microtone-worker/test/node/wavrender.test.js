// Async WAV render (item 38): renderSongAsync must be bit-identical to the sync
// renderSong (chunk batching is decoupled from timing), and drive the progress
// callback + honour an AbortSignal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { TaudEngine } from "../../core/engine/engine.js";
import {
  loadIntoEngine, renderSong, renderSongAsync, renderToWav, renderToWavAsync,
} from "../../core/audio/offline-render.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud"))).toRenderable(0);

test("renderSongAsync is bit-identical to renderSong", async () => {
  const doc = loadWhen();
  const e1 = new TaudEngine(); loadIntoEngine(e1, doc, 0);
  const sync = renderSong(e1, 3);
  const e2 = new TaudEngine(); loadIntoEngine(e2, doc, 0);
  const asyncR = await renderSongAsync(e2, 3, { yieldMs: 0 }); // yield every batch

  assert.equal(asyncR.frames, sync.frames);
  assert.equal(asyncR.halted, sync.halted);
  assert.deepEqual(asyncR.u8, sync.u8, "u8 device output identical");
  assert.deepEqual(asyncR.f32, sync.f32, "f32 mix-bus tap identical");
});

test("renderSongAsync drives onProgress monotonically up to 1", async () => {
  const doc = loadWhen();
  const eng = new TaudEngine(); loadIntoEngine(eng, doc, 0);
  const seen = [];
  await renderSongAsync(eng, 3, { yieldMs: 0, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 0, "progress fired");
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "monotonic");
  assert.ok(seen.every((f) => f >= 0 && f <= 1), "fractions in [0,1]");
  assert.equal(seen[seen.length - 1], 1, "reaches 1 at the end");
});

test("renderSongAsync stops on an aborted signal", async () => {
  const doc = loadWhen();
  const eng = new TaudEngine(); loadIntoEngine(eng, doc, 0);
  const ctrl = new AbortController();
  let ticks = 0;
  const r = await renderSongAsync(eng, 30, {
    yieldMs: 0,
    signal: ctrl.signal,
    onProgress: () => { if (++ticks === 2) ctrl.abort(); },
  });
  assert.equal(r.aborted, true, "reports aborted");
  assert.ok(r.frames < 30 * 32000, "stopped short of the cap");
});

test("renderToWavAsync == renderToWav when not aborted", async () => {
  const doc = loadWhen();
  const sync = renderToWav(doc, 0, 3);
  const asyncR = await renderToWavAsync(doc, 0, 3, {});
  assert.equal(asyncR.aborted, false);
  assert.equal(asyncR.seconds, sync.seconds);
  assert.deepEqual(asyncR.bytes, sync.bytes, "WAV bytes identical");
});

test("renderToWavAsync returns null bytes when aborted", async () => {
  const doc = loadWhen();
  const ctrl = new AbortController();
  let ticks = 0;
  const r = await renderToWavAsync(doc, 0, 30, {
    onProgress: () => { if (++ticks === 2) ctrl.abort(); },
    signal: ctrl.signal,
  });
  assert.equal(r.aborted, true);
  assert.equal(r.bytes, null);
});
