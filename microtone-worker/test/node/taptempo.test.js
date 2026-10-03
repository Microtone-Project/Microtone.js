// Tap tempo in the New Project modal (src/ui/popups/newproject.js). A tap marks
// a notated beat — beatPri rows × tickRate ticks, one tick being 2.5/BPM seconds
// — so what the tapper writes into the BPM field depends on the meter and the
// speed, and only equals the tapped tempo on the classic 4 rows/beat × speed 6.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TAP_MAX, TAP_RESET_MIN_MS, TAP_RESET_MAX_MS,
  tapAnalyse, tapResetMs,
} from "../../src/ui/popups/newproject.js";

/** n taps `ms` apart, starting at an arbitrary clock offset. */
const series = (n, ms, t0 = 1234.5) =>
  Array.from({ length: n }, (_, i) => t0 + i * ms);

test("tapAnalyse needs two taps to measure anything", () => {
  assert.equal(tapAnalyse([], 4, 6), null);
  assert.equal(tapAnalyse([1000], 4, 6), null);
  assert.equal(tapAnalyse([1000, 1000], 4, 6), null); // zero interval
  assert.ok(tapAnalyse([1000, 1480], 4, 6));
});

test("4 rows/beat × speed 6 (24 ticks) → the field IS the tapped tempo", () => {
  const a = tapAnalyse(series(5, 480), 4, 6); // 480 ms/beat = 125 BPM
  assert.equal(a.intervalMs, 480);
  assert.equal(a.bpm, 125);
  assert.ok(Math.abs(a.tapBpm - 125) < 1e-9);

  assert.equal(tapAnalyse(series(4, 300), 4, 6).bpm, 200);
  assert.equal(tapAnalyse(series(4, 600), 4, 6).bpm, 100);
});

test("another meter/speed keeps the tapped beat, not the number", () => {
  // 3 rows/beat × speed 8 = 24 ticks as well → same field value
  assert.equal(tapAnalyse(series(4, 480), 3, 8).bpm, 125);
  // 4 rows/beat × speed 3 = half the ticks per beat → half the field BPM
  const a = tapAnalyse(series(4, 480), 4, 3);
  assert.equal(a.bpm, 63);                       // 62.5 rounded
  assert.ok(Math.abs(a.tapBpm - 125) < 1e-9);    // …still 125 BPM tapped
  // 8 rows/beat × speed 6 → twice the ticks per beat → twice the field BPM
  assert.equal(tapAnalyse(series(4, 480), 8, 6).bpm, 250);
});

test("the field value stays inside the song's 25..1048 range", () => {
  assert.equal(tapAnalyse(series(4, 60), 16, 16).bpm, 1048);  // absurdly fast
  assert.equal(tapAnalyse(series(4, 4000), 1, 1).bpm, 25);    // absurdly slow
});

test("the tapped tempo is the mean over the whole window", () => {
  // uneven taps: 400, 600, 400, 600 → mean 500 ms
  const taps = [0, 400, 1000, 1400, 2000];
  const a = tapAnalyse(taps, 4, 6);
  assert.equal(a.intervalMs, 500);
  assert.equal(a.bpm, 120);
});

test("tapResetMs waits a couple of the user's own beats, within bounds", () => {
  assert.equal(tapResetMs([]), TAP_RESET_MIN_MS);
  assert.equal(tapResetMs([1000]), TAP_RESET_MIN_MS);
  assert.equal(tapResetMs(series(4, 300)), TAP_RESET_MIN_MS);   // fast → the floor
  assert.equal(tapResetMs(series(4, 1000)), 2500);              // 2.5 beats
  assert.equal(tapResetMs(series(4, 9000)), TAP_RESET_MAX_MS);  // slow → the ceiling
});

test("TAP_MAX taps of window is enough to average over", () => {
  assert.ok(TAP_MAX >= 4);
});
