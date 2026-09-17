// Q effect (item: Q xy00 nibble layout) — TAUD_NOTE_EFFECTS.md §"Q $xy00 —
// Retrigger note every $y ticks with volume modifier $x". The engine used to
// pull x/y out of the arg's LOW byte (as if the format were $00xy), so any Q
// command written the documented way — high byte carries the digits, low
// byte is always $00 — parsed y as 0 and the whole command was ignored (spec:
// "y == 0 → entire effect ignored, even memory").

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";

setSamplingRate(32000);

/** One instrument (a looping ramp) playing C4 on lane 0 of pattern 0. */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);   // sampleLength
  w16(6, 32000);  // samplingRate @C4 — matches the engine rate, so playback rate is 1.0
  w16(12, 1000);  // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; // instGlobalVolume
  rec[196] = 255; // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  return eng;
}

/** rows: [{row, note, inst, effect, arg}] → uploaded pattern 0, then played. */
function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.effect !== undefined) {
      pat[o + 5] = c.effect;
      pat[o + 6] = c.arg & 0xff;
      pat[o + 7] = (c.arg >>> 8) & 0xff;
    }
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  return eng;
}

const CHUNKS_PER_TICK = (SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK;
assert.ok(Number.isInteger(CHUNKS_PER_TICK));

function render(eng, ticks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < ticks * CHUNKS_PER_TICK; i++) eng.renderChunk(0, out);
}

/** One chunk (< one tick's worth of samples): just enough to process the row
 *  trigger (firstRow) without crossing a tick boundary. */
function renderRowTriggerOnly(eng) {
  eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
}

const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];

test("Q $xy00 reads x (retrigVolMod) from the high nibble, y (retrigInterval) from the next", () => {
  // x=3, y=2 packed as the manual documents: digits at the TOP of the arg,
  // low byte always $00.
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Q, arg: 0x3200 },
  ]);
  renderRowTriggerOnly(eng);
  assert.equal(voice0(eng).retrigInterval, 2, "y came from the arg's second nibble");
  assert.equal(voice0(eng).retrigVolMod, 3, "x came from the arg's top nibble");
  assert.equal(voice0(eng).retrigActive, true);
});

test("y == 0 leaves the command — and its memory — untouched", () => {
  // x=0xA, y=0: per spec this whole command is ignored, memory included, even
  // though the raw 16-bit arg is non-zero (so it would NOT hit the resolveArg
  // recall path).
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Q, arg: 0xa000 },
  ]);
  renderRowTriggerOnly(eng);
  assert.equal(voice0(eng).retrigActive, false, "row reset retrigActive; y==0 never re-armed it");
  assert.equal(voice0(eng).retrigInterval, 0);
  assert.equal(voice0(eng).retrigVolMod, 0);
});

test("the retrigger actually fires every y ticks and applies the x volume modifier", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Q, arg: 0x3200 }, // x=3 (-4/tick), y=2
  ]);
  render(eng, 1);
  assert.equal(voice0(eng).retrigCounter, 1, "one tick elapsed, interval is 2: no fire yet");
  assert.equal(voice0(eng).noteVolume, 63, "volume untouched before the retrigger fires");
  assert.ok(voice0(eng).samplePos > 0, "sample kept playing forward");

  render(eng, 1); // second tick boundary — interval reached, retrigger fires
  assert.equal(voice0(eng).retrigCounter, 0, "counter reset on fire");
  // The reset happens on the tick-boundary sample itself, which then keeps
  // rendering — so by the time this call returns, playback has moved one
  // sample past activeSamplePlayStart (rate ≈ 1.0 at C4 here).
  assert.ok(voice0(eng).samplePos <= 1, `sample position snapped back to the trigger point, got ${voice0(eng).samplePos}`);
  assert.equal(voice0(eng).noteVolume, 59, "x=3 subtracts 4 volume units (case 3 of applyRetrigVolMod)");

  render(eng, 2); // one more full interval
  assert.equal(voice0(eng).retrigCounter, 0);
  assert.ok(voice0(eng).samplePos <= 1, `sample position snapped back to the trigger point, got ${voice0(eng).samplePos}`);
  assert.equal(voice0(eng).noteVolume, 55, "a second retrigger subtracts another 4 units");
});

test("Q memory recall (arg $0000) keeps the last xy00 value, decoded the same way", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Q, arg: 0x1300 }, // x=1 (-1/tick), y=3
    { row: 1, effect: EffectOp.OP_Q, arg: 0x0000 }, // recall
  ]);
  render(eng, 1);
  assert.equal(voice0(eng).retrigInterval, 3, "row 0 armed y=3 directly");
  render(eng, 5); // land in row 1 (speed 6) and confirm the recall re-armed the same y/x
  assert.equal(voice0(eng).retrigInterval, 3, "row 1's recall kept y=3 from memory");
  assert.equal(voice0(eng).retrigVolMod, 1, "…and x=1 from memory");
});
