// Automatic loop-region resolver (item 176) — the pure search in
// src/doc/looptune.js. Synthetic signals pin the two mode-specific rules (a
// forward loop is whole pitch periods; a ping-pong turning point is an
// EXTREMUM, not a zero crossing), and a corpus sweep pins the invariants the
// marker editor relies on: inside the sample, after playStart, deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveLoopRegion, estimatePeriod, seamResidual, cornerResidual, residualDb,
  toSignal, usableRange, LOOP_POLICIES, LOOP_BUDGET,
} from "../../src/doc/looptune.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

/** U8 sample of `n` bytes from a phase→value function (±127 about 0x80). */
const synth = (n, fn) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.max(0, Math.min(255, Math.round(128 + fn(i))));
  return b;
};
const sine = (n, T, amp = 100) => synth(n, (i) => amp * Math.sin((2 * Math.PI * i) / T));

test("period estimate: fundamental, not an octave of it", () => {
  // A pure sine correlates equally well at 2× and 3× its period — whichever way
  // the floating point falls. The estimator must still say 97.3.
  const s = estimatePeriod(toSignal(sine(8000, 97.3)), 0, 8000);
  assert.ok(Math.abs(s.period - 97.3) < 0.5, `period ${s.period}`);
  assert.ok(s.r > 0.95, `r ${s.r}`);

  // Two harmonics with the second louder than the first: the fundamental is
  // the period, even though half of it correlates nearly as well.
  const rich = synth(8000, (i) =>
    30 * Math.sin((2 * Math.PI * i) / 220) + 90 * Math.sin((4 * Math.PI * i) / 220));
  const r2 = estimatePeriod(toSignal(rich), 0, 8000);
  assert.ok(Math.abs(r2.period - 220) < 1.5, `rich period ${r2.period}`);

  // Noise has no period worth building a length grid on.
  let seed = 12345;
  const noise = synth(4096, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed >>> 8) % 255) - 127;
  });
  assert.ok(estimatePeriod(toSignal(noise), 0, 4096).r < 0.5);
});

test("seam and corner residuals measure what they claim", () => {
  const x = toSignal(sine(4000, 100));
  // Two points a whole period apart continue each other exactly.
  assert.ok(seamResidual(x, 1000, 1400, 200) < 0.02);
  // Half a period apart is a full polarity flip — the worst seam there is.
  assert.ok(seamResidual(x, 1000, 1450, 200) > 1.5);
  // A reflection is smooth at an extremum and a corner at a zero crossing.
  const peak = 1000 + 25, zero = 1000;      // sin() peaks a quarter period in
  assert.ok(cornerResidual(x, peak, 24) < 0.05, `peak ${cornerResidual(x, peak, 24)}`);
  assert.ok(cornerResidual(x, zero, 24) > 0.5, `zero ${cornerResidual(x, zero, 24)}`);
  assert.equal(residualDb(1), 0);
  assert.ok(residualDb(0.1) + 20 < 1e-9);
});

test("forward: whole pitch periods, and it hears its own seam", () => {
  const bytes = sine(8000, 97.3);
  for (const policy of LOOP_POLICIES) {
    const r = resolveLoopRegion(bytes, { mode: 1, policy });
    assert.ok(r, `no result for ${policy}`);
    assert.equal(r.mode, 1);
    const cycles = (r.loopEnd - r.loopStart) / 97.3;
    assert.ok(Math.abs(cycles - Math.round(cycles)) < 0.05,
      `${policy}: ${cycles} cycles is not a whole number`);
    assert.ok(r.metBudget, `${policy}: a sine has a perfect loop and must meet any budget`);
    assert.ok(r.rel < LOOP_BUDGET[policy], `${policy}: rel ${r.rel}`);
    assert.ok(r.loopEnd - r.loopStart > 2000, `${policy}: kept only ${r.loopEnd - r.loopStart}`);
  }
});

test("ping-pong: both ends land on an extremum, and they are independent", () => {
  const T = 97.3;
  const r = resolveLoopRegion(sine(8000, T), { mode: 2, policy: "clean" });
  assert.ok(r);
  // Phase 0.25 is the peak and 0.75 the trough; the reflection is smooth at
  // either and a corner anywhere else, so both ends must sit on one of them.
  for (const p of [r.loopStart, r.loopEnd]) {
    const ph = (p % T) / T;
    const nearest = Math.min(Math.abs(ph - 0.25), Math.abs(ph - 0.75));
    assert.ok(nearest < 0.05, `turning point at phase ${ph.toFixed(3)} is not an extremum`);
  }
  assert.ok(r.relStart < 0.05 && r.relEnd < 0.05, `corners ${r.relStart}/${r.relEnd}`);

  // The two ends are scored independently (that is the whole reason ping-pong
  // needs no pair search): lengthening the sample cannot move the start.
  const long = resolveLoopRegion(sine(12000, T), { mode: 2, policy: "clean" });
  assert.equal(long.loopStart, r.loopStart);
  assert.ok(long.loopEnd > r.loopEnd);
});

test("policies trade length against the seam, in that direction", () => {
  // A decaying, drifting note: no long loop is clean, so the budget bites.
  const bytes = synth(20000, (i) =>
    110 * Math.exp(-i / 26000) * Math.sin((2 * Math.PI * i) / (180 + i / 900)));
  const got = {};
  for (const policy of LOOP_POLICIES) got[policy] = resolveLoopRegion(bytes, { mode: 1, policy });
  for (const policy of LOOP_POLICIES) assert.ok(got[policy], `no result for ${policy}`);
  assert.ok(got.longest.loopEnd - got.longest.loopStart >= got.clean.loopEnd - got.clean.loopStart,
    "the loosest budget must not return the shortest region");
  assert.ok(got.longest.rel >= got.clean.rel, "a longer region cannot have a cleaner seam here");
  for (const policy of LOOP_POLICIES) {
    if (got[policy].metBudget) {
      assert.ok(got[policy].rel <= LOOP_BUDGET[policy] + 1e-9,
        `${policy} claims it met a budget it did not: ${got[policy].rel}`);
    }
  }
});

test("refuses what it cannot answer", () => {
  assert.equal(resolveLoopRegion(new Uint8Array(64).fill(128), { mode: 1 }), null, "too short");
  assert.equal(resolveLoopRegion(new Uint8Array(4000).fill(128), { mode: 1 }), null, "silence");
  assert.equal(resolveLoopRegion(sine(4000, 100), { mode: 0 }), null, "mode 0 does not loop");
  assert.equal(resolveLoopRegion(sine(4000, 100), { mode: 3 }), null, "mode 3 does not loop");
  assert.equal(resolveLoopRegion(null, { mode: 1 }), null);
});

test("playStart is a floor the search may not cross", () => {
  const bytes = sine(8000, 97.3);
  const r = resolveLoopRegion(bytes, { mode: 1, policy: "longest", playStart: 5000 });
  assert.ok(r);
  assert.ok(r.loopStart >= 5000, `loop starts at ${r.loopStart}, before playStart`);
  assert.ok(r.loopEnd <= bytes.length);
});

test("usableRange keeps the loop out of the attack", () => {
  // 2000 bytes of attack ramp, then a steady tone.
  const bytes = synth(16000, (i) =>
    100 * Math.min(1, i / 2000) * Math.sin((2 * Math.PI * i) / 120));
  const { lo, hi } = usableRange(toSignal(bytes), 0);
  assert.ok(lo >= 1800, `usable range starts at ${lo}, inside the attack`);
  assert.ok(hi > lo + 4000);
  const r = resolveLoopRegion(bytes, { mode: 1, policy: "longest" });
  assert.ok(r.loopStart >= 1800, `loop starts at ${r.loopStart}, inside the attack`);
});

test("corpus sweep: valid, deterministic, and no worse than the authored loop", async () => {
  let runs = 0, beat = 0, compared = 0;
  for (const file of readdirSync(corpusDir).filter((f) => f.endsWith(".taud"))) {
    const doc = new Document(parseTaud(readFileSync(corpusDir + file)));
    let seen = 0;
    // Six searches on a 64 KB sample is a fifth of a second; the shapes repeat
    // long before a song runs out of instruments, so take the first handful of
    // each file rather than making this test a fifth of the whole suite.
    for (let slot = 0; slot < 1024 && seen < 6; slot++) {
      const inst = doc.instruments[slot];
      if (!inst || inst.sampleLength < 1024) continue;
      seen++;
      const len = inst.sampleLength;
      const bytes = doc.sampleBin.subarray(inst.samplePtr, inst.samplePtr + len);
      const rate = inst.samplingRate || 32000;
      const playStart = inst.samplePlayStart | 0;
      for (const mode of [1, 2]) {
        for (const policy of LOOP_POLICIES) {
          const r = resolveLoopRegion(bytes, { mode, policy, playStart, rate });
          if (!r) continue;
          runs++;
          assert.ok(r.loopStart >= playStart && r.loopEnd <= len && r.loopEnd > r.loopStart,
            `${file} #${slot} ${mode}/${policy}: [${r.loopStart},${r.loopEnd}) outside [${playStart},${len}]`);
          assert.ok(Number.isFinite(r.rel), `${file} #${slot}: rel ${r.rel}`);
          if (r.metBudget) {
            assert.ok(r.rel <= LOOP_BUDGET[policy] + 1e-9,
              `${file} #${slot} ${mode}/${policy}: claims budget met at rel ${r.rel}`);
          }
          if (policy === "balanced") {
            const again = resolveLoopRegion(bytes, { mode, policy, playStart, rate });
            assert.deepEqual([again.loopStart, again.loopEnd], [r.loopStart, r.loopEnd],
              `${file} #${slot} ${mode}/${policy}: not deterministic`);
          }
        }
      }
      // Where the song itself carries a forward loop, the cleanest policy
      // should not be BEATEN by it — those loop points were placed by hand, so
      // matching them on most of the corpus is the bar the search has to clear.
      if ((inst.loopMode & 3) === 1 && inst.sampleLoopEnd > inst.sampleLoopStart
          && inst.sampleLoopEnd < len) {
        const x = toSignal(bytes);
        const P = estimatePeriod(x, 0, len).period;
        const win = Math.min(256, Math.max(32, Math.round(P * 2) || 128));
        const authored = seamResidual(x, inst.sampleLoopStart, inst.sampleLoopEnd, win);
        const r = resolveLoopRegion(bytes, { mode: 1, policy: "clean", playStart, rate });
        if (r && Number.isFinite(authored)) {
          compared++;
          if (r.rel <= authored) beat++;
        }
      }
    }
  }
  assert.ok(runs > 100, `only ${runs} corpus runs`);
  assert.ok(compared === 0 || beat / compared >= 0.7,
    `beat the authored loop on only ${beat}/${compared} samples`);
});
