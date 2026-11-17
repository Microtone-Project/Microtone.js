// renderFrames (tw_render_frames): a span of any length, 1…TRACKER_CHUNK, is
// the same audio as whole chunks. Tick and row timing are per sample, so a
// span's length only batches the work; a native host renders exactly what its
// device asks for (64 frames, or whatever a driver hands over) and must hear,
// to the bit, what the web build hears. Covered here: FM racks at their own
// rate, chains + lyrics, formant voices, a surround song through the object
// bus and through the binaural monitor, and a mastering chain that works hard
// (compressor, true-peak limiter) with every meter running. A halt cue is the
// one place spans may differ (the song's voices end at the close of the span
// the halt fell in), so no song here halts inside the window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { parseTaud } from "../../core/format/taud-parse.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { setSamplingRate, TRACKER_CHUNK, MONITOR_BINAURAL } from "../../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { normaliseMastering } from "../../core/engine/mastering.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";

const RATE = 48000;
const SECONDS = 6;
const TOTAL = RATE * SECONDS;

const HARD_CHAIN = normaliseMastering({
  on: true, trimDb: 9, hpOn: true, hpFreq: 60, hpSlope: 1, eqOn: true,
  eq: [
    { on: true, type: 0, freq: 120, gainDb: 4, q: 0.7 },
    { on: true, type: 1, freq: 500, gainDb: -3, q: 1.4 },
    { on: false, type: 1, freq: 2500, gainDb: 6, q: 1 },
    { on: true, type: 2, freq: 9000, gainDb: 5, q: 0.7 },
  ],
  compOn: true, compDetector: 1, compThreshDb: -24, compRatio: 6, compAttackMs: 3,
  compReleaseMs: 120, compKneeDb: 8, compMakeupDb: 4,
  widthOn: true, width: 1.6,
  limOn: true, limTruePeak: true, limCeilingDb: -1.5, limReleaseMs: 60, outGainDb: 1,
});

const CASES = {
  "Eighth (FM racks)": { file: "Eighth.taud" },
  "Daisy_bell (chains + lyrics)": { file: "Daisy_bell.taud" },
  "Temjin_speaki (formant)": { file: "Temjin_speaki.taud" },
  "WHEN_AMBI (surround)": { file: "WHEN_AMBI.taud" },
  "WHEN_AMBI (binaural monitor)": { file: "WHEN_AMBI.taud", setup: (eng) => eng.setMonitorMode(0, MONITOR_BINAURAL) },
  "16uba_baion (hard mastering chain, every meter on)": {
    file: "16uba_baion.taud",
    setup: (eng) => {
      eng.setMastering(0, HARD_CHAIN);
      eng.setAnalysis(0, "stereo");
      eng.setMasterMeter(0, true, true, 16, 2);
    },
  },
};

/** Render the case's first SECONDS. `spans` null = whole chunks through
 *  renderChunk (the reference); otherwise renderFrames, cycling the lengths. */
async function render({ file, setup }, spans) {
  setSamplingRate(RATE);
  setRandomSource(makeSeededRandom(1));
  try {
    const doc = parseTaud(await readFile(new URL(`../../assets/demo_projects/${file}`, import.meta.url)));
    const eng = new TaudEngine(RATE);
    loadIntoEngine(eng, doc, 0);
    setup?.(eng);
    eng.setCuePosition(0, 0);
    eng.play(0);
    const ts = eng.playheads[0].trackerState;
    const f32 = new Float32Array(TOTAL * 2);
    const u8 = new Uint8Array(TOTAL * 2);
    const chunk = new Uint8Array(TRACKER_CHUNK * 2);
    let at = 0;
    for (let k = 0; at < TOTAL; k++) {
      const want = Math.min(spans === null ? TRACKER_CHUNK : spans[k % spans.length], TOTAL - at);
      const got = spans === null ? eng.renderChunk(0, chunk) : eng.renderFrames(0, want, chunk);
      assert.ok(got, `${file} halted at frame ${at}`);
      // Views on the module's memory: taken afresh after each render.
      const left = ts.mixLeft, right = ts.mixRight;
      for (let n = 0; n < want; n++) {
        f32[(at + n) * 2] = left[n];
        f32[(at + n) * 2 + 1] = right[n];
      }
      u8.set(got.subarray(0, want * 2), at * 2);
      at += want;
    }
    return { f32: digest(f32), u8: digest(u8), peak: f32.reduce((m, v) => Math.max(m, Math.abs(v)), 0) };
  } finally {
    setRandomSource(null);
  }
}

const digest = (a) => createHash("sha256").update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

for (const [name, c] of Object.entries(CASES)) {
  test(`spans render whole chunks' audio: ${name}`, async () => {
    const whole = await render(c, null);
    assert.ok(whole.peak > 0.01, "the window is not silence");
    for (const spans of [[64], [1, 63, 128, 7, TRACKER_CHUNK, 300, 11, 97]]) {
      const got = await render(c, spans);
      assert.equal(got.f32, whole.f32, `f32 mix bus, spans ${spans.join("/")}`);
      assert.equal(got.u8, whole.u8, `U8 device output, spans ${spans.join("/")}`);
    }
  });
}

test("a span is clamped to 1…TRACKER_CHUNK", async () => {
  setSamplingRate(RATE);
  const doc = parseTaud(await readFile(new URL("../../assets/demo_projects/Eighth.taud", import.meta.url)));
  const eng = new TaudEngine(RATE);
  loadIntoEngine(eng, doc, 0);
  eng.setCuePosition(0, 0);
  eng.play(0);
  assert.equal(eng.renderFrames(0, 0).length, 2);
  assert.equal(eng.renderFrames(0, 100000).length, TRACKER_CHUNK * 2);
  assert.equal(eng.renderFrames(0, 77).length, 77 * 2);
});
