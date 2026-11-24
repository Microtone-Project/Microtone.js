// The lane wavescopes (item 358): the engine's lane tap and the Timeline's
// trigger. The tap is each lane's stem — the stem exporter's per-voice values
// summed per lane — kept for the last SNAP_LS_FRAMES frames; it changes
// nothing the engine renders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { WasmTaudEngine } from "../../core/engine/wasm-engine.js";
import { setSamplingRate, TRACKER_CHUNK, MAX_VOICES } from "../../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { fillSnapshotInto } from "../../core/worklet/engine-commands.js";
import { SNAP_FLOATS, SNAP_LS_LANES, SNAP_LS_DATA, SNAP_LS_FRAMES } from "../../core/worklet/protocol.js";
import { scopeWindow, SCOPE_SHOW, makeScopeState } from "../../src/ui/lanescope.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function engineFor(file) {
  setSamplingRate(48000);
  setRandomSource(makeSeededRandom(1));
  const eng = new WasmTaudEngine(48000);
  loadIntoEngine(eng, parseTaud(readFileSync(ROOT + file)), 0);
  eng.setCuePosition(0, 0);
  eng.setTrackerRow(0, 0);
  eng.play(0);
  return eng;
}

test("each lane's scope is its stem, the last SNAP_LS_FRAMES frames of it", () => {
  try {
    const eng = engineFor("assets/demo_projects/Zeta_valley.taud");
    const lanes = 64;
    const history = Array.from({ length: lanes }, () => []);
    eng.stemBus = {
      add(_v, lane, frame, value) {
        if (lane < 0 || lane >= MAX_VOICES) return;
        const h = history[lane];
        h[base + frame] = (h[base + frame] ?? 0) + value;
      },
    };
    eng.setLaneScope(true);
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let base = 0;
    for (let i = 0; i < 900; i++) { eng.renderChunk(0, out); base += TRACKER_CHUNK; }
    const f = new Float32Array(SNAP_FLOATS);
    fillSnapshotInto(eng, 0, f);
    const n = f[SNAP_LS_LANES];
    assert.ok(n === 32 || n === 64);
    let sounding = 0;
    for (let l = 0; l < n; l++) {
      const got = f.subarray(SNAP_LS_DATA + l * SNAP_LS_FRAMES, SNAP_LS_DATA + (l + 1) * SNAP_LS_FRAMES);
      let any = false;
      for (let k = 0; k < SNAP_LS_FRAMES; k++) {
        const want = Math.fround(history[l][base - SNAP_LS_FRAMES + k] ?? 0);
        assert.equal(got[k], want, `lane ${l} frame ${k}`);
        if (want !== 0) any = true;
      }
      if (any) sounding++;
    }
    assert.ok(sounding >= 2, `${sounding} lanes sounding`);
    // Switched on again (as every song load does), every ring starts silent.
    eng.setLaneScope(true);
    const z = new Float32Array(SNAP_FLOATS);
    fillSnapshotInto(eng, 0, z);
    assert.ok(z.subarray(SNAP_LS_DATA, SNAP_LS_DATA + n * SNAP_LS_FRAMES).every((v) => v === 0));
    // Off: the count says so, and nothing past it is written.
    eng.setLaneScope(false);
    const g = new Float32Array(SNAP_FLOATS).fill(7);
    fillSnapshotInto(eng, 0, g);
    assert.equal(g[SNAP_LS_LANES], 0);
    assert.equal(g[SNAP_LS_DATA], 7);
  } finally {
    setRandomSource(null);
  }
});

test("the tap changes nothing the engine renders", () => {
  try {
    const a = engineFor("assets/demo_projects/Zeta_valley.taud");
    const b = engineFor("assets/demo_projects/Zeta_valley.taud");
    b.setLaneScope(true);
    const oa = new Uint8Array(TRACKER_CHUNK * 2), ob = new Uint8Array(TRACKER_CHUNK * 2);
    for (let i = 0; i < 200; i++) {
      a.renderChunk(0, oa);
      b.renderChunk(0, ob);
      assert.deepEqual(ob, oa);
    }
  } finally {
    setRandomSource(null);
  }
});

test("the trigger lines up the latest rising crossing at its mark", () => {
  const n = SNAP_LS_FRAMES;
  const period = 100;
  const sine = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * (i - 17.25)) / period));
  for (const pos of [0, 0.25, 0.5, 1]) {
    const w = scopeWindow(sine, pos);
    assert.ok(w.triggered);
    const at = w.start + Math.round(pos * SCOPE_SHOW);
    assert.ok(sine[at - 1] < 0 && sine[at] >= 0, `rising crossing at the mark (pos ${pos})`);
    assert.equal((at - 18) % period, 0);
    assert.ok(w.start >= 0 && w.start + SCOPE_SHOW <= n);
    // The latest one that fits: one period later would not.
    assert.ok(at + period > n - (SCOPE_SHOW - Math.round(pos * SCOPE_SHOW)) || at + period > n);
  }
  // Silence and DC run free on the newest frames.
  for (const flat of [new Float32Array(n), new Float32Array(n).fill(0.5)]) {
    assert.deepEqual(scopeWindow(flat, 0.5), { start: n - SCOPE_SHOW, triggered: false, level: 0 });
  }
  // Noise around a crossing does not retrigger inside the hysteresis.
  const noisy = Float32Array.from(sine, (v, i) => v + (i % 2 ? 0.01 : -0.01));
  const w = scopeWindow(noisy, 0.5);
  assert.ok(w.triggered);
  const off = (((w.start + SCOPE_SHOW / 2 - 18) % period) + period) % period;
  assert.ok(off <= 2 || off >= period - 2, `lands ${off} frames from the clean crossing`);
});

test("a waveform with two rising edges a cycle keeps to the same one from frame to frame (item 376)", () => {
  const n = SNAP_LS_FRAMES, period = 137.3;
  // A fundamental with a strong second harmonic crosses its mid level upwards
  // twice a cycle; the latest crossing alone alternates between the two.
  const wave = (t) => Math.sin(2 * Math.PI * t / period) + 1.2 * Math.sin(4 * Math.PI * t / period);
  const phaseAt = (frame, offset) => ((((frame + offset) / period) % 1) + 1) % 1;
  const st = makeScopeState();
  const phases = [], plain = [];
  for (let f = 0; f < 40; f++) {
    const offset = f * 801.7; // a snapshot's worth of frames later, never a whole number of cycles
    const data = Float32Array.from({ length: n }, (_, i) => wave(i + offset));
    const at = (w) => w.start + Math.round(0.5 * SCOPE_SHOW);
    phases.push(phaseAt(at(scopeWindow(data, 0.5, SCOPE_SHOW, st)), offset));
    plain.push(phaseAt(at(scopeWindow(data, 0.5)), offset));
  }
  const spread = (ps) => {
    const d = ps.slice(1).map((p) => Math.min(Math.abs(p - ps[0]), 1 - Math.abs(p - ps[0])));
    return Math.max(...d);
  };
  assert.ok(spread(phases) < 0.03, `with memory: the same point of the cycle (spread ${spread(phases).toFixed(3)})`);
  assert.ok(spread(plain) > 0.1, "without it the latest crossing hops between the two edges");
});
