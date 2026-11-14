// The audio profiler: the pure verdict classifier and the rows it shows
// (src/ui/profileoverlay.js). The panel's DOM is exercised in the browser
// smoke; here we pin the logic that decides whether the engine is the cost (the
// song is heavier than the machine) or everything around it is.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  profileVerdict, profileRows, PF_LOAD_WARN, PF_LOAD_SATURATED, PF_DSP_SHARE,
} from "../../src/ui/profileoverlay.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";

// A comfortable desktop: low load, no xruns, plenty of budget.
test("headroom OK when load is low and nothing glitches", () => {
  const v = profileVerdict({
    cpuFrac: 0.3, renderFrac: 0.25, procMaxMs: 1.2, quantumMs: 2.67, xruns: 0,
  });
  assert.equal(v.tone, "ok");
  assert.equal(v.key, "ok");
});

// The real iPad case: only 35% average load but heavy xruns → bursty, not
// saturated. A burst problem, not an engine problem, even though the engine is
// ~all the busy time (dspShare high).
test("bursty overrun when glitching with spare average headroom", () => {
  const v = profileVerdict({
    cpuFrac: 0.35, renderFrac: 0.34, procMeanMs: 0.92, procMaxMs: 14.0,
    quantumMs: 2.67, xruns: 63,
  });
  assert.equal(v.tone, "bad");
  assert.equal(v.key, "bursty");
  assert.ok(0.35 < PF_LOAD_SATURATED);
});

// Saturated (high load) AND the engine dominates → the song is too heavy here.
test("engine-bound when saturated and renderChunk dominates", () => {
  const v = profileVerdict({
    cpuFrac: 0.95, renderFrac: 0.85, procMaxMs: 3.1, quantumMs: 2.67, xruns: 7,
  });
  assert.equal(v.tone, "bad");
  assert.equal(v.key, "engine");
  assert.ok(0.95 >= PF_LOAD_SATURATED);
  assert.ok(0.85 / 0.95 >= PF_DSP_SHARE);
});

// Saturated but the engine is a minority of the callback.
test("overhead-bound when saturated but render is a small share", () => {
  const v = profileVerdict({
    cpuFrac: 0.95, renderFrac: 0.3, procMaxMs: 3.0, quantumMs: 2.67, xruns: 4,
  });
  assert.equal(v.key, "overhead");
  assert.ok(0.3 / 0.95 < PF_DSP_SHARE);
});

// procMax over the quantum budget counts as over-budget even with zero counted
// xruns in the window (belt-and-braces on the glitch predictor).
test("procMax over budget alone trips the over-budget branch", () => {
  const v = profileVerdict({
    cpuFrac: 0.4, renderFrac: 0.38, procMaxMs: 3.5, quantumMs: 2.67, xruns: 0,
  });
  assert.notEqual(v.tone, "ok"); // went over budget on a spike
  assert.equal(v.key, "bursty"); // low mean load → bursty
});

// High sustained load (above PF_LOAD_WARN) with no dropouts → "Near budget".
test("sustained high load without xruns is Near budget, not OK", () => {
  const v = profileVerdict({
    cpuFrac: PF_LOAD_WARN + 0.05, renderFrac: 0.2, procMaxMs: 2.0, quantumMs: 2.67, xruns: 0,
  });
  assert.equal(v.tone, "warn");
  assert.equal(v.key, "nearOverhead");
  const e = profileVerdict({ cpuFrac: 0.8, renderFrac: 0.7, procMaxMs: 2.0, quantumMs: 2.67, xruns: 0 });
  assert.equal(e.key, "nearEngine", "the engine is most of a busy thread");
});

// Tier 2 (worker render): the audio thread only copies, so xruns/load are 0 and
// irrelevant — the verdict must key off ring underruns instead.
test("worker render with no underruns is Off-thread OK", () => {
  const v = profileVerdict({
    workerRender: true, underruns: 0,
    cpuFrac: 0, renderFrac: 0, renderCount: 0, procMaxMs: 0, quantumMs: 2.67, xruns: 0,
  });
  assert.equal(v.tone, "ok");
  assert.equal(v.key, "workerOk");
});

// Tier 2 times the engine in the Worker: its load tells a song too heavy for
// the machine from a thread that woke late.
test("worker render: a busy engine is near budget; a dry queue is the engine or the scheduler", () => {
  const base = { workerRender: true, quantumMs: 2.67, xruns: 0 };
  assert.equal(profileVerdict({ ...base, underruns: 0, worker: { engineFrac: PF_LOAD_WARN + 0.05 } }).key, "workerNear");
  assert.equal(profileVerdict({ ...base, underruns: 4, worker: { engineFrac: 0.95 } }).key, "workerSlow");
  assert.equal(profileVerdict({ ...base, underruns: 4, worker: { engineFrac: 0.2 } }).key, "workerLate");
  assert.equal(profileVerdict({ ...base, underruns: 4, worker: null }).key, "workerLate", "no reading is not a slow engine");
});

test("worker render with ring underruns flags a dropout", () => {
  const v = profileVerdict({
    workerRender: true, underruns: 12,
    cpuFrac: 0, renderFrac: 0, renderCount: 0, procMaxMs: 0, quantumMs: 2.67, xruns: 0,
  });
  assert.equal(v.tone, "bad");
  assert.equal(v.key, "workerLate");
});

// Degenerate/empty report must not throw or divide by zero.
test("empty report is safe", () => {
  const v = profileVerdict({});
  assert.ok(v.tone);
  assert.ok(v.key);
  assert.ok(profileRows({}).length > 0);
});

// Every verdict the classifier can give has its words in both tables.
test("every verdict has a label and a detail in English and Korean", () => {
  const keys = ["ok", "nearEngine", "nearOverhead", "bursty", "engine", "overhead",
    "workerOk", "workerNear", "workerSlow", "workerLate"];
  for (const table of [en, ko]) {
    for (const k of keys) {
      assert.ok(table[`profiler.verdict.${k}`], `profiler.verdict.${k}`);
      assert.ok(table[`profiler.detail.${k}`], `profiler.detail.${k}`);
    }
  }
});

// The rows read the engine where it runs: the Worker's timings in Tier 2,
// the worklet's own otherwise, and say when the output is converted.
test("rows: the engine's load comes from the thread that renders", () => {
  const worker = { engineFrac: 0.3, renderMeanMs: 0.8, renderMaxMs: 1.9, peakVoices: 12,
    ringLowMs: 20.1, ringTargetMs: 42.7, wakeMaxMs: 6.2, memoryBytes: 9 * 1024 * 1024, engineRate: 48000 };
  const tier2 = Object.fromEntries(profileRows({ workerRender: true, contextSampleRate: 44100, sampleRate: 44100,
    step: 48000 / 44100, usingSab: true, hiResClock: true, underruns: 2, worker }).map(([l, v, tone]) => [l, [v, tone]]));
  assert.match(tier2.Engine[0], /WebAssembly · 9\.0 MB/);
  assert.match(tier2.Output[0], /44100 Hz, converted from 48000 Hz/);
  assert.match(tier2["Engine load"][0], /^30% of real time/);
  assert.match(tier2.Queue[0], /^20\.1 ms left/);
  assert.deepEqual(tier2.Dropouts, ["2: the queue ran dry", "bad"]);
  assert.match(tier2["Renders in"][0], /render Worker\)$/);
  // Without shared memory (the desktop apps) the same Worker posts its audio.
  const port = Object.fromEntries(profileRows({ workerRender: true, usingPort: true, sampleRate: 48000, step: 1,
    usingSab: false, hiResClock: true, underruns: 0, worker }).map(([l, v, tone]) => [l, [v, tone]]));
  assert.match(port["Renders in"][0], /render Worker\), its audio sent as messages$/);
  assert.match(port.Queue[0], /^20\.1 ms left/);
  const worklet = Object.fromEntries(profileRows({ workerRender: false, sampleRate: 48000, step: 1, hiResClock: false,
    clockResMs: 1, cpuFrac: 0.5, renderFrac: 0.4, renderCount: 375, renderMeanMs: 1, renderMaxMs: 2,
    procMeanMs: 1.3, procMaxMs: 2.2, quantumMs: 2.67, xruns: 0, peakVoices: 3, memoryBytes: 1 << 23 })
    .map(([l, v, tone]) => [l, [v, tone]]));
  assert.match(worklet.Output[0], /no conversion/);
  assert.match(worklet["Engine load"][0], /80% of the audio thread's work$/);
  assert.equal(worklet.Clock[1], "warn", "a coarse clock is flagged");
  assert.deepEqual(worklet.Dropouts, ["none", null]);
  assert.equal(worklet.Queue, undefined, "no queue without a render Worker");
  assert.equal(worklet["Renders in"][0], "the audio thread");
});
