// Auto-vibrato calibration — the instrument record's own LFO.
//
// Both record bytes are the source tracker's 6-bit field × 4 (IT `Vis`/`Vid`
// 0…64, XM rate/depth), and the engine is calibrated so that a converted
// instrument sounds like the source player. The reference numbers below come
// from openmpt123 rendering purpose-built .it/.xm modules with sinc
// interpolation; test/oracle/autovib-oracle.py generates, renders and measures
// them, and the last test here re-runs it when openmpt123 is installed.
//
// What this pins, and what it used to do:
//
// - Depth: byte 255 (= IT `Vid` 64) is ±1 semitone. It used to be ±9 cents —
//   a tenth of IT's deepest wobble at the record's own maximum.
// - Speed: a full cycle is 1024 ÷ speed ticks. The phase used to be 256 steps
//   advanced by speed × 2, which stepped a widened byte clean over the 64-entry
//   table: every multiple of 64 landed only on entries 0 and 32 — both zero —
//   so IT `Vis` 16 and 32 (bytes 64 and 128) played NOTHING at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Voice } from "../../core/engine/voice.js";
import { advanceAutoVibrato } from "../../core/engine/envelope.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";

setSamplingRate(32000);

const UNITS_PER_SEMITONE = 4096 / 12;          // 4096-TET, one octave per 4096
const cents = (units) => (units / 4096) * 1200;

/** A bare voice carrying nothing but an auto-vibrato setting. */
function voiceWith({ speed, depth, sweep = 0, rate = 0, wave = 0 }) {
  const v = new Voice();
  v.activeVibratoSpeed = speed;
  v.activeVibratoDepth = depth;
  v.activeVibratoSweep = sweep;
  v.activeVibratoRate = rate;
  v.activeVibratoWaveform = wave;
  return v;
}

/** `ticks` consecutive pitch deltas, in 4096-TET units. */
function deltas(cfg, ticks) {
  const v = voiceWith(cfg);
  const out = [];
  for (let t = 0; t < ticks; t++) out.push(advanceAutoVibrato(v, null));
  return out;
}

/** Mean ticks between upward crossings of zero — the LFO's period. */
function periodTicks(seq) {
  const cross = [];
  for (let i = 1; i < seq.length; i++) if (seq[i - 1] <= 0 && seq[i] > 0) cross.push(i);
  assert.ok(cross.length > 1, "sequence never crosses zero upwards");
  return (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
}

test("depth 255 is IT's deepest auto-vibrato: ±1 semitone", () => {
  const seq = deltas({ speed: 16, depth: 255 }, 64);   // 64 ticks = one full cycle
  const peak = Math.max(...seq), trough = Math.min(...seq);
  // ±339.98 before the arithmetic shift, which floors both ends the same way.
  assert.equal(peak, 339, "peak delta in 4096-TET units");
  assert.equal(trough, -340);
  // IT's Vid 64 renders at ±99.61 cents (openmpt123); one semitone is 341.33.
  assert.ok(Math.abs(cents(peak) - 99.61) < 0.5, `peak is ±${cents(peak).toFixed(2)} cents`);
  assert.ok(Math.abs(peak - UNITS_PER_SEMITONE) < 3, "within three units of a semitone");
});

test("depth is linear in the record byte", () => {
  for (const [byte, expected] of [[255, 339], [128, 170], [64, 85], [32, 42], [4, 5]]) {
    const peak = Math.max(...deltas({ speed: 16, depth: byte }, 64));
    assert.equal(peak, expected, `depth byte ${byte}`);
  }
});

test("a full cycle is 1024 ÷ speed ticks", () => {
  for (const speed of [8, 16, 32, 64, 128, 255]) {
    const seq = deltas({ speed, depth: 255 }, Math.ceil((1024 / speed) * 8) + 8);
    assert.ok(Math.abs(periodTicks(seq) - 1024 / speed) < 0.05,
      `speed ${speed}: ${periodTicks(seq)} ticks, want ${1024 / speed}`);
  }
});

test("every speed byte modulates — the multiples of 64 used to be silent", () => {
  // The old 256-step phase advanced by speed × 2 sampled only table entries 0
  // and 32 at these bytes, and both are zero. IT `Vis` 16 and 32 land here.
  for (const speed of [64, 128, 192]) {
    const seq = deltas({ speed, depth: 255 }, 64);
    assert.ok(seq.some((d) => d !== 0), `speed byte ${speed} produced no pitch movement`);
    assert.equal(Math.max(...seq), 339, `speed byte ${speed} reaches full depth`);
  }
});

test("an IT sample reproduces the reference player", () => {
  // it2taud writes Vis/Vid × 255/64: Vis 32 → 128, Vid 64 → 255.
  // openmpt123 renders that as ±99.61 cents at 8.04 ticks per cycle.
  const seq = deltas({ speed: 128, depth: 255 }, 64);
  assert.ok(Math.abs(periodTicks(seq) - 8) < 0.05);
  assert.ok(Math.abs(cents(Math.max(...seq)) - 99.61) < 0.5);
});

test("an XM instrument reproduces the reference player", () => {
  // xm2taud writes rate/depth × 4: rate 32 → 128, depth 15 → 60. XM's depth
  // unit measures the same as IT's, so this is 15/64 of a semitone.
  const seq = deltas({ speed: 128, depth: 60 }, 64);
  assert.ok(Math.abs(periodTicks(seq) - 8) < 0.05);
  const measured = cents(Math.max(...seq));
  assert.ok(Math.abs(measured - 23.4) < 1.0, `${measured.toFixed(2)} cents`);
});

test("waveform 4 (FT2 ramp up) is the negation of waveform 1", () => {
  const down = deltas({ speed: 16, depth: 255, wave: 1 }, 64);
  const up = deltas({ speed: 16, depth: 255, wave: 4 }, 64);
  // The negation happens before the shift, so the two ends floor differently:
  // a mirrored pair sums to 0 or to -1, never to anything else.
  assert.equal(up.length, down.length);
  for (let i = 0; i < up.length; i++) {
    assert.ok(up[i] + down[i] === 0 || up[i] + down[i] === -1,
      `tick ${i}: ${up[i]} is not the mirror of ${down[i]}`);
  }
});

test("the two ramp-in conventions are unchanged", () => {
  // FT2 sweep: ticks to full depth, linear. Speed 16 is a 64-tick cycle, so
  // these slices are whole cycles and their maxima are the LFO's own peak.
  const swept = deltas({ speed: 16, depth: 255, sweep: 32 }, 192);
  assert.equal(swept[0], 0, "no depth on the trigger tick");
  assert.ok(Math.max(...swept.slice(0, 64)) < 200, "still ramping through the first cycle");
  assert.equal(Math.max(...swept.slice(128)), 339, "full depth once the sweep completes");
  // IT rate: an accumulator of rate ÷ 256 of the depth per tick, so a rate of 8
  // needs some 8000 ticks — two and a half minutes — to arrive.
  const ramped = deltas({ speed: 16, depth: 255, rate: 8 }, 192);
  assert.ok(Math.max(...ramped) < 20, "an IT rate of 8 has barely started after 192 ticks");
  // Neither: full depth from the first cycle (FT2's reading of a zero sweep).
  assert.equal(Math.max(...deltas({ speed: 16, depth: 255 }, 64)), 339);
});

test("auto-vibrato reaches the mixer's pitch", () => {
  // The unit tests above call advanceAutoVibrato directly; this one proves the
  // per-tick path still adds it to the rate the sampler steps by.
  const eng = new TaudEngine();
  for (let i = 0; i < 64; i++) {
    eng.sampleBin[i] = 128 + Math.round(120 * Math.sin((2 * Math.PI * i) / 64));
  }
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 64); w16(6, 32000); w16(12, 64);
  rec[14] = 1;                    // forward loop
  rec[21] = 0x3f;                 // vol env node 0 = full
  rec[171] = 255;                 // instrument global volume
  rec[175] = 128;                 // auto-vibrato speed  (IT Vis 32)
  rec[182] = 0xff;                // filter off
  rec[187] = 255;                 // auto-vibrato depth  (IT Vid 64)
  rec[196] = 255;                 // default note volume
  eng.uploadInstrument(1, rec);

  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;         // C4, instrument 1
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);

  const voice = eng.playheads[0].trackerState.voices[0];
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const pitches = [];
  for (let t = 0; t < 16; t++) {                     // two full LFO cycles
    for (let i = 0; i < 640 / TRACKER_CHUNK; i++) eng.renderChunk(0, out);
    pitches.push(voice.renderPitch);
  }
  const hi = Math.max(...pitches), lo = Math.min(...pitches);
  assert.equal(hi - lo, 679, "peak-to-peak pitch swing, in 4096-TET units");
  assert.ok(Math.abs((hi + lo) / 2 - 0x5000) <= 1, "centred on the note it was triggered at");
});

// ── The oracle itself, when the machine has it ──────────────────────────────
// Skipped rather than failed where openmpt123 or numpy are missing: this is the
// only test here that needs anything outside the repo.
const oracle = fileURLToPath(new URL("../oracle/autovib-oracle.py", import.meta.url));
const haveOracle = spawnSync("openmpt123", ["--version"]).status === 0
  && spawnSync("python3", ["-c", "import numpy"]).status === 0;

test("openmpt123 still measures what the calibration claims", { skip: !haveOracle }, () => {
  const run = spawnSync("python3", [oracle, "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const byCase = new Map(JSON.parse(run.stdout).map((r) => [r.case, r]));

  // What the converters emit for each case, and the engine's answer for it.
  const engineFor = (speed, depth) => {
    const seq = deltas({ speed, depth }, Math.ceil((1024 / speed) * 8) + 8);
    return { depth_cents: cents(Math.max(...seq)), ticks_per_cycle: periodTicks(seq) };
  };
  const cases = [
    ["IT Vis=32 Vid=64 Vir=255", 128, 255],
    ["IT Vis=32 Vid=32 Vir=255", 128, 128],
    ["IT Vis=8  Vid=64 Vir=255", 32, 255],
    ["IT Vis=64 Vid=64 Vir=255", 255, 255],
    ["XM rate=32 depth=15", 128, 60],
    ["XM rate=8  depth=15", 32, 60],
  ];
  for (const [label, speed, depth] of cases) {
    const ref = byCase.get(label);
    assert.ok(ref, `oracle produced no ${label}`);
    const got = engineFor(speed, depth);
    // The measurement reads a rendered waveform, so it carries the estimator's
    // own error: it over-reads shallow excursions (the percentile of a noisy
    // instantaneous frequency) and quantises slow LFOs to its FFT bins.
    const depthErr = Math.abs(got.depth_cents - ref.depth_cents) / ref.depth_cents;
    const rateErr = Math.abs(got.ticks_per_cycle - ref.ticks_per_cycle) / ref.ticks_per_cycle;
    assert.ok(depthErr < 0.15,
      `${label}: engine ±${got.depth_cents.toFixed(2)} cents vs reference ±${ref.depth_cents}`);
    assert.ok(rateErr < 0.08,
      `${label}: engine ${got.ticks_per_cycle.toFixed(2)} ticks vs reference ${ref.ticks_per_cycle}`);
  }

  // Vir = 0 renders flat in IT: the depth accumulator never leaves zero. The
  // converters carry that as depth 0 (the engine's zero-ramp reading is FT2's,
  // full depth at once), so the reference is checked here rather than replayed.
  assert.ok(byCase.get("IT Vis=32 Vid=64 Vir=0").depth_cents < 3.0,
    "an IT sample with Vir = 0 must render flat");
});
