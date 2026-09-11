// Interrupt markers (item 181) — Int0…IntF in the note column, the `:` beside
// them as their 16-bit argument, and the latch the host drains.
//
// The marker itself is old (note words $0010…$001F, TAUD_FILE_FORMAT.md); what
// these pin is everything that makes it usable: the argument, which `:` wins
// when a wide cell holds two, the columns the marker is required to ignore,
// and the edge-triggered collapse the drain contract promises.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import {
  TRACKER_CHUNK, PATTERN_BYTES, PATTERN_BYTES_WIDE, CELL_BYTES_WIDE,
  SAMPLING_RATE, setSamplingRate,
} from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";
import { SURROUND_SPATIAL } from "../../src/engine/spatial.js";
import { drainInterruptsInto } from "../../src/worklet/engine-commands.js";
import {
  SNAP_FLOATS, SNAP_INTERRUPT_MASK, SNAP_INTERRUPT_ARGS,
  SNAP_SAB_I32_MASK, SNAP_SAB_I32_ARGS, SNAP_SAB_I32_CELLS,
} from "../../src/worklet/protocol.js";

setSamplingRate(32000);

const COLON = EffectOp.OP_COLON;
const INT = (n) => 0x0010 + n;
const C4 = 0x5000;

/** Engine with a looping ramp sample in slot 1. `wide` picks format 3. */
function makeEngine(wide = false) {
  const eng = new TaudEngine();
  if (wide) { eng.setCellFormat(true); eng.setSurroundModel(0, SURROUND_SPATIAL); }
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1;      // forward loop
  rec[21] = 0x3f;   // vol env node 0 = full
  rec[171] = 255;   // instGlobalVolume
  rec[196] = 255;   // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  return eng;
}

/** rows: [{row, note, inst, vol, volEff, pan, panEff, effect, arg, effect2, arg2}]
 *  → pattern `slot`, in whichever cell format the engine is in. */
function buildPattern(wide, rows) {
  const stride = wide ? CELL_BYTES_WIDE : 8;
  const pat = new Uint8Array(wide ? PATTERN_BYTES_WIDE : PATTERN_BYTES);
  for (let r = 0; r < 64; r++) {
    if (wide) pat[r * stride + 8] = 0x33;              // vol + pan = FINE 0
    else { pat[r * stride + 3] = 0xc0; pat[r * stride + 4] = 0xc0; }
  }
  for (const c of rows) {
    const o = c.row * stride;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.vol !== undefined) {
      if (wide) { pat[o + 3] = c.vol & 0xff; pat[o + 8] = (pat[o + 8] & 0x8f) | ((c.volEff ?? 0) << 4); }
      else pat[o + 3] = ((c.volEff ?? 0) << 6) | (c.vol & 0x3f);
    }
    if (c.pan !== undefined) {
      if (wide) { pat[o + 4] = c.pan & 0xff; pat[o + 8] = (pat[o + 8] & 0xf0) | (c.panEff ?? 0); }
      else pat[o + 4] = ((c.panEff ?? 0) << 6) | (c.pan & 0x3f);
    }
    if (c.effect !== undefined) {
      pat[o + 5] = c.effect;
      pat[o + 6] = c.arg & 0xff; pat[o + 7] = (c.arg >>> 8) & 0xff;
    }
    if (wide && c.effect2 !== undefined) {
      pat[o + 10] = c.effect2;
      pat[o + 11] = c.arg2 & 0xff; pat[o + 12] = (c.arg2 >>> 8) & 0xff;
    }
  }
  return pat;
}

/** Load one pattern onto channel 0 (plus any extra channel → pattern pairs)
 *  and start the transport. */
function loadSong(eng, patterns, { wide = false } = {}) {
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  patterns.forEach((rows, ch) => {
    if (rows === null) return;
    eng.uploadPattern(ch, buildPattern(wide, rows));
    cue[ch * 2] = ch; cue[ch * 2 + 1] = 0;
  });
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  return eng;
}

// One row at 32 kHz / 125 BPM / tick rate 6 is 6 × 640 = 3840 samples, an exact
// 30 render chunks — so a stepper can stop between two rows' event passes,
// which is where a host polls.
const ROW_CHUNKS = (SAMPLING_RATE * 2.5 / 125 * 6) / TRACKER_CHUNK;

/** Advance the song one row at a time, stopping just after that row's events
 *  have run and before the next row's. The first step is one chunk, because
 *  the very first renderChunk is what processes row 0. */
function rowStepper(eng) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let started = false;
  return () => {
    const n = started ? ROW_CHUNKS : 1;
    started = true;
    for (let i = 0; i < n; i++) eng.renderChunk(0, out);
  };
}

const ts = (eng) => eng.playheads[0].trackerState;

// ── the marker itself ──────────────────────────────────────────────────────

test("an Int marker latches its bit and makes no sound", () => {
  const eng = makeEngine();
  loadSong(eng, [[{ row: 0, note: INT(3), inst: 1 }]]);
  rowStepper(eng)();
  assert.equal(ts(eng).pendingInterrupts, 1 << 3, "Int3 latched");
  // The instrument byte beside it is one of the columns the marker ignores:
  // nothing triggered, so the channel is still silent.
  assert.equal(ts(eng).voices[0].active, false, "no voice was started");
});

test("an Int marker leaves a sounding note alone", () => {
  const eng = makeEngine();
  loadSong(eng, [[{ row: 0, note: C4, inst: 1 }, { row: 1, note: INT(0) }]]);
  const step = rowStepper(eng);
  step();
  const before = ts(eng).voices[0].samplePos;
  step(); // row 1: the marker
  assert.equal(ts(eng).pendingInterrupts, 1, "Int0 latched");
  assert.equal(ts(eng).voices[0].active, true, "the note is still sounding");
  assert.ok(ts(eng).voices[0].samplePos !== before, "…and still advancing");
});

test("all sixteen markers are distinct bits, and $000F below them is inert", () => {
  const eng = makeEngine();
  loadSong(eng, [Array.from({ length: 16 }, (_, n) => ({ row: n, note: INT(n) }))
    .concat([{ row: 16, note: 0x000f }])]);
  const step = rowStepper(eng);
  for (let n = 0; n < 16; n++) {
    step();
    assert.equal(eng.pollTrackerInterrupts(0), 1 << n, `row ${n} is Int${n}`);
  }
  step();
  assert.equal(eng.pollTrackerInterrupts(0), 0, "the reserved sentinel fires nothing");
});

// ── the argument ───────────────────────────────────────────────────────────

test("`:` on the row is the argument; no `:` means 0", () => {
  const eng = makeEngine();
  loadSong(eng, [[
    { row: 0, note: INT(1), effect: COLON, arg: 0xbeef },
    { row: 1, note: INT(2) },
  ]]);
  const step = rowStepper(eng);
  step();
  assert.equal(eng.pollTrackerInterrupts(0), 1 << 1);
  assert.equal(eng.interruptArg(0, 1), 0xbeef);
  step();
  assert.equal(eng.pollTrackerInterrupts(0), 1 << 2);
  assert.equal(eng.interruptArg(0, 2), 0, "a marker with nothing to say says 0");
});

test("the argument spans the full 0…65535", () => {
  const eng = makeEngine();
  loadSong(eng, [[
    { row: 0, note: INT(0), effect: COLON, arg: 0x0000 },
    { row: 1, note: INT(0), effect: COLON, arg: 0xffff },
  ]]);
  const step = rowStepper(eng);
  step();
  assert.equal(eng.interruptArg(0, 0), 0);
  eng.pollTrackerInterrupts(0);
  step();
  assert.equal(eng.interruptArg(0, 0), 0xffff);
});

test("wide cell: either slot's `:` serves, and the FIRST one wins", () => {
  const eng = makeEngine(true);
  loadSong(eng, [[
    { row: 0, note: INT(4), effect: COLON, arg: 0x1111 },                        // slot 1
    { row: 1, note: INT(4), effect: EffectOp.OP_NONE, effect2: COLON, arg2: 0x2222 }, // slot 2
    { row: 2, note: INT(4), effect: COLON, arg: 0x3333, effect2: COLON, arg2: 0x4444 },
  ]], { wide: true });
  const step = rowStepper(eng);
  for (const expect of [0x1111, 0x2222, 0x3333]) {
    step();
    assert.equal(eng.pollTrackerInterrupts(0), 1 << 4);
    assert.equal(eng.interruptArg(0, 4), expect);
  }
});

test("the other columns are the marker's business not at all — and still do their own job", () => {
  const eng = makeEngine(true);
  loadSong(eng, [[
    // A sounding note first, so the channel volume the M below writes has
    // somewhere visible to land.
    { row: 0, note: C4, inst: 1 },
    // …then a marker row carrying an instrument, a volume, a pan, an unrelated
    // effect and the `:` that belongs to the interrupt.
    {
      row: 1, note: INT(7), inst: 1, vol: 0x20, volEff: 0, pan: 0x40, panEff: 0,
      effect: EffectOp.OP_M, arg: 0x2000, effect2: COLON, arg2: 0x00c8,
    },
  ]], { wide: true });
  const step = rowStepper(eng);
  step();
  const noteVolBefore = ts(eng).voices[0].noteVolume;
  step();
  assert.equal(eng.pollTrackerInterrupts(0), 1 << 7);
  assert.equal(eng.interruptArg(0, 7), 0xc8, "the `:` argument, not the M or the volume column");
  // The row's OTHER commands are untouched by the marker: M still set the
  // channel volume, and the volume column still wrote the note volume.
  assert.equal(ts(eng).voices[0].channelVolume, 0x20);
  assert.equal(ts(eng).voices[0].noteVolume, 0x20);
  assert.ok(noteVolBefore !== 0x20, "…which is a change, so the assertion means something");
});

test("a `:` doing double duty still extends the J it shares the row with", () => {
  const eng = makeEngine(true);
  loadSong(eng, [[
    { row: 0, note: C4, inst: 1 },
    { row: 1, note: INT(5), effect: EffectOp.OP_J, arg: 0x0155, effect2: COLON, arg2: 0x02aa },
  ]], { wide: true });
  const step = rowStepper(eng);
  step();
  step();
  assert.equal(eng.pollTrackerInterrupts(0), 1 << 5);
  assert.equal(eng.interruptArg(0, 5), 0x02aa, "the interrupt read it");
  const v = ts(eng).voices[0];
  assert.equal(v.arpActive, true, "…and so did the arpeggio");
  assert.equal(v.arpOff1, 0x0155);
  assert.equal(v.arpOff2, 0x02aa, "J's second offset is the same `:` argument");
});

// ── the drain contract ─────────────────────────────────────────────────────

test("draining is read-to-acknowledge: the second read is empty", () => {
  const eng = makeEngine();
  loadSong(eng, [[{ row: 0, note: INT(9), effect: COLON, arg: 0x0042 }]]);
  rowStepper(eng)();
  assert.equal(eng.pollTrackerInterrupts(0), 1 << 9);
  assert.equal(eng.pollTrackerInterrupts(0), 0);
});

test("two fires of ONE interrupt between drains collapse, keeping the LAST argument", () => {
  const eng = makeEngine();
  loadSong(eng, [[
    { row: 0, note: INT(2), effect: COLON, arg: 0x0001 },
    { row: 1, note: INT(2), effect: COLON, arg: 0x0002 },
  ]]);
  const step = rowStepper(eng);
  step(); step(); // both rows, no drain in between
  assert.equal(eng.pollTrackerInterrupts(0), 1 << 2, "one bit, not two events");
  assert.equal(eng.interruptArg(0, 2), 0x0002, "the later argument");
});

test("different interrupts in one window each keep their own argument", () => {
  const eng = makeEngine();
  // Two channels firing on the same row — the classic same-window collision.
  loadSong(eng, [
    [{ row: 0, note: INT(0), effect: COLON, arg: 0x00aa }],
    [{ row: 0, note: INT(1), effect: COLON, arg: 0x00bb }],
  ]);
  rowStepper(eng)();
  assert.equal(eng.pollTrackerInterrupts(0), 0b11);
  assert.equal(eng.interruptArg(0, 0), 0xaa);
  assert.equal(eng.interruptArg(0, 1), 0xbb);
});

test("a replay reset clears the latch AND the arguments", () => {
  const eng = makeEngine();
  loadSong(eng, [[{ row: 0, note: INT(6), effect: COLON, arg: 0x1234 }]]);
  rowStepper(eng)();
  assert.equal(ts(eng).pendingInterrupts, 1 << 6);
  eng.setTrackerRow(0, 0);
  assert.equal(ts(eng).pendingInterrupts, 0, "mask cleared");
  assert.equal(eng.interruptArg(0, 6), 0, "…and the stale argument with it");
});

// ── the wire: one drain site, two shapes ───────────────────────────────────
// Microtone hosts the engine in three places (the worklet with and without
// shared memory, and the Tier 2 render Worker) and all three drain through
// drainInterruptsInto. The two shapes differ in more than storage: the shared
// cells ACCUMULATE, because the main thread reads them on its own clock.

test("postMessage shape: the mask and its arguments land in the float snapshot", () => {
  const eng = makeEngine();
  loadSong(eng, [[{ row: 0, note: INT(3), effect: COLON, arg: 0xcafe }]]);
  rowStepper(eng)();
  const f = new Float32Array(SNAP_FLOATS);
  drainInterruptsInto(eng, 0, f);
  assert.equal(f[SNAP_INTERRUPT_MASK], 1 << 3);
  assert.equal(f[SNAP_INTERRUPT_ARGS + 3], 0xcafe);
  // Read-to-acknowledge: a second drain into a fresh buffer reports nothing.
  const g = new Float32Array(SNAP_FLOATS);
  drainInterruptsInto(eng, 0, g);
  assert.equal(g[SNAP_INTERRUPT_MASK], 0);
});

test("SAB shape: bits accumulate across drains until the main thread takes them", () => {
  const eng = makeEngine();
  loadSong(eng, [[
    { row: 0, note: INT(0), effect: COLON, arg: 0x0011 },
    { row: 1, note: INT(1), effect: COLON, arg: 0x0022 },
  ]]);
  const f = new Float32Array(SNAP_FLOATS);
  const i32 = new Int32Array(SNAP_SAB_I32_CELLS);
  const step = rowStepper(eng);
  step(); drainInterruptsInto(eng, 0, f, i32);
  step(); drainInterruptsInto(eng, 0, f, i32);
  assert.equal(i32[SNAP_SAB_I32_MASK], 0b11, "two snapshots, both fires still there");
  assert.equal(i32[SNAP_SAB_I32_ARGS + 0], 0x0011);
  assert.equal(i32[SNAP_SAB_I32_ARGS + 1], 0x0022);
  assert.equal(f[SNAP_INTERRUPT_MASK], 0, "the float slot belongs to the other path");
  // …and the main thread's exchange is what clears them.
  assert.equal(Atomics.exchange(i32, SNAP_SAB_I32_MASK, 0), 0b11);
  assert.equal(i32[SNAP_SAB_I32_MASK], 0);
});
