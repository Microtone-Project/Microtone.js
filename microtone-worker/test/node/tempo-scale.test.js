// The host's tempo scale (item 373, the Music Hub's radio mix): every tick
// lasts 1/scale of what the song's BPM says; a glide travels there
// exponentially over seconds of ticks and ends exactly on the target. The
// golden set and the host scenarios pin that scale 1 is the old engine to the
// bit; this pins what a scale other than 1 does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTaud } from "../../core/format/taud-parse.js";
import { WasmTaudEngine } from "../../core/engine/wasm-engine.js";
import { setSamplingRate, TRACKER_CHUNK } from "../../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";

const RATE = 48000;
const FILE = new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url);

function engineAt(scale) {
  setSamplingRate(RATE);
  setRandomSource(makeSeededRandom(1));
  const doc = parseTaud(readFileSync(FILE));
  const eng = new WasmTaudEngine(RATE);
  loadIntoEngine(eng, doc, 0);
  eng.setTempoScale(scale);
  eng.setCuePosition(0, 0);
  eng.setTrackerRow(0, 0);
  eng.play(0);
  return eng;
}

/** Frames rendered until the song has advanced `rows` rows. */
function framesForRows(eng, rows) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let seen = 0, last = eng.getTrackerRow(0), lastCue = eng.getCuePosition(0), frames = 0;
  while (seen < rows) {
    eng.renderFrames(0, 1, out);
    frames++;
    const row = eng.getTrackerRow(0), cue = eng.getCuePosition(0);
    if (row !== last || cue !== lastCue) { seen++; last = row; lastCue = cue; }
    if (frames > RATE * 600) throw new Error("the song stopped advancing");
  }
  return frames;
}

test("a tempo scale of 2 plays rows in half the time, 0.5 in twice", () => {
  try {
    const one = framesForRows(engineAt(1), 32);
    const two = framesForRows(engineAt(2), 32);
    const half = framesForRows(engineAt(0.5), 32);
    // A tick boundary is a whole frame, so each measurement is within a frame
    // per tick of the exact ratio.
    assert.ok(Math.abs(two * 2 - one) <= 32 * 8, `${one} vs ${two}`);
    assert.ok(Math.abs(half - one * 2) <= 32 * 8, `${one} vs ${half}`);
  } finally {
    setRandomSource(null);
  }
});

test("a glide ends exactly on its target and moves only one way", () => {
  try {
    const eng = engineAt(1.6);
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    eng.setTempoScale(1, 2);
    let prev = eng.getTempoScale();
    assert.equal(prev, 1.6);
    for (let i = 0; i < Math.ceil((RATE * 3) / TRACKER_CHUNK); i++) {
      eng.renderChunk(0, out);
      const s = eng.getTempoScale();
      assert.ok(s <= prev, `rose from ${prev} to ${s}`);
      prev = s;
    }
    assert.equal(eng.getTempoScale(), 1);
  } finally {
    setRandomSource(null);
  }
});

test("the scale is clamped to 0.25…4, and a stop and play keep it", () => {
  try {
    const eng = engineAt(1);
    eng.setTempoScale(9);
    assert.equal(eng.getTempoScale(), 4);
    eng.setTempoScale(0);
    assert.equal(eng.getTempoScale(), 0.25);
    eng.setTempoScale(NaN);
    assert.equal(eng.getTempoScale(), 0.25);
    eng.setTempoScale(1.25);
    eng.stop(0);
    eng.setCuePosition(0, 0);
    eng.play(0);
    assert.equal(eng.getTempoScale(), 1.25);
  } finally {
    setRandomSource(null);
  }
});
