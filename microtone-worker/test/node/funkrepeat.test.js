// Funk repeat — `Z $F0xx`, ProTracker 1.0C's EFx (item 161).
//
// Pinned against the transcription in the TSVM tree's
// reference_materials/protracker_1/FUNK_REPEAT.md, which derives both halves of
// `EF $x` line by line from the 1.0C and 1.1B playroutine sources. Section
// numbers below are that document's.
//
// The disambiguation this file exists to hold: `EF $x` is ONE slot with TWO
// algorithms. **Invert Loop** (1.1B onwards) is `S $F0xx` and one's-complements
// the loop's bytes in place. **Funk Repeat** (1.0C) is this command: it adds a
// whole loop length to the repeat pointer, writes it into Paula's AUDxLC, and
// snaps back to the real loop start when the next block would not fit whole
// (§3.1). The sample data is never touched. They share the ladder, the
// accumulator, the sticky speed nibble and — in PT's sources — every name.
//
// State scope (§2.1, §7.2): the window is per voice and follows the note; the
// speed and the accumulator are per lane and outlive it. PT never cleared
// the accumulator anywhere but on its own overflow — not on a note, not on a
// speed change, not on `EF $0` — so the ladder is a running phase, not a
// period counter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { setRandomSource, makeSeededRandom } from "../../src/engine/rng.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { FUNK_XFADE_SAMPLES } from "../../src/engine/sampler.js";
import { SURROUND_SPATIAL } from "../../src/engine/spatial.js";
import { INTERP_NONE } from "../../src/engine/constants.js";
import { TOTAL_VOICES } from "../../src/engine/constants.js";
import { fillSnapshotInto } from "../../src/worklet/engine-commands.js";
import {
  SNAP_FLOATS, SNAP_HEADER_SIZE, SNAP_VOICE_STRIDE, SNAP_V_ACTIVE,
  SNAP_V_FUNK_WINDOW, SNAP_V_FUNK_POS, SNAP_V_FUNK_LEN, SNAP_V_FUNK_MODE,
} from "../../src/worklet/protocol.js";

setSamplingRate(32000);

const SAMPLE_LEN = 1000;
const TICK = 640;          // 125 BPM at 32 kHz
const ROW = 6 * TICK;      // six ticks to the row

/** Engine with a 1000-byte ramp sample in slot 1, looping over `[ls, le)`. */
function makeEngine(ls = 100, le = 132, loopMode = 1) {
  const eng = new TaudEngine();
  for (let i = 0; i < SAMPLE_LEN; i++) eng.sampleBin[i] = i & 0xff;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, SAMPLE_LEN); // sampleLength
  w16(6, 32000);      // samplingRate @C4 — playback rate exactly 1.0
  w16(10, ls);        // loopStart
  w16(12, le);        // loopEnd
  rec[14] = loopMode;
  rec[21] = 0x3f;     // vol env node 0 = full
  rec[171] = 255;
  rec[196] = 255;
  eng.uploadInstrument(1, rec);
  return eng;
}

/**
 * Row 0 sounds C4 on instrument 1; `rows` gives each row's [effect, arg] in
 * turn. `retrigger` re-sounds the note on every row that carries one.
 */
function loadRows(eng, rows, retriggerRows = []) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  for (const r of retriggerRows) { pat[r * 8] = 0x00; pat[r * 8 + 1] = 0x50; pat[r * 8 + 2] = 1; }
  rows.forEach(([effect, arg], r) => {
    pat[r * 8 + 5] = effect;
    pat[r * 8 + 6] = arg & 0xff;
    pat[r * 8 + 7] = (arg >> 8) & 0xff;
  });
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
}

function render(eng, samples) {
  const buf = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < Math.ceil(samples / TRACKER_CHUNK); i++) eng.renderChunk(0, buf);
}

const voiceOf = (eng) => eng.playheads[0].trackerState.voices[0];

test("the window hops a WHOLE LOOP LENGTH per step (§3.2)", () => {
  // Loop [100, 132) — 32 bytes — in a 1000-byte sample.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]); // $80 — the ladder's top rung, one step per tick
  const v = voiceOf(eng);
  assert.equal(v.funkPos, -1, "nothing has moved before the row runs");

  render(eng, TICK);
  assert.equal(v.funkSpeed, 0x80);
  assert.equal(v.funkPos, 132, "one step = one loop length, not one byte");
  render(eng, TICK * 3);
  assert.equal(v.funkPos, 228, "…and it keeps hopping by 32");
});

test("the walk snaps back to the LOOP START, not the sample start (§3.3)", () => {
  // §8.2's first vector in offsets: loopStart 16, loopLen 16, sample 128 bytes.
  // Successive positions 32 48 64 80 96 112 → 16, i.e. seven distinct blocks.
  const eng = makeEngine(16, 32);
  eng.instruments[1].sampleLength = 128;
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  const seen = [];
  for (let i = 0; i < 9; i++) { render(eng, TICK); seen.push(v.funkPos); }
  assert.deepEqual(seen, [32, 48, 64, 80, 96, 112, 16, 32, 48],
    "the last block visited is the last one that fits WHOLE, then back to 16");
});

test("a loop at the tail of its sample is inert — by design (§3.5)", () => {
  // limit == loopStart, so every candidate overshoots and every step resets.
  const eng = makeEngine(SAMPLE_LEN - 32, SAMPLE_LEN);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 4);
  assert.equal(v.funkPos, SAMPLE_LEN - 32,
    "pinned to the real loop start — this is why the manual asks for a SHORT loop");
});

test("the window is what SOUNDS, and it follows the walk", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 4);
  assert.equal(v.funkPos, 228);
  assert.ok(v.funkWindow >= 100, "the window has been latched at least once");
  assert.ok(v.samplePos >= v.funkWindow && v.samplePos < v.funkWindow + 32,
    `samplePos ${v.samplePos} sits inside the window at ${v.funkWindow}`);
  assert.ok(v.samplePos >= 132,
    "…which is past the end of the loop the instrument declares");
});

test("the window is latched at the loop restart, not the moment the walk steps", () => {
  // A loop long enough that one iteration outlasts a tick — at rate 1.0 a
  // 300-byte loop is 300 samples against the tick's 640 is not enough, so take
  // 900: the pointer gets to move between two restarts and the lag is visible.
  const eng = makeEngine(0, 900);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 3);
  assert.equal(v.funkPos, 0,
    "a 900-byte window in a 1000-byte sample cannot fit twice: every step resets");
  assert.equal(v.funkWindow, 0, "so the window it latches is the loop start");
});

test("the accumulator is a running phase: nothing resets it (§2.1, §7.3)", () => {
  // $2B steps every 3rd tick. Two ticks in, the phase is 2×$2B = $56; a fresh
  // Z $F02B on the next row must NOT restart the count, so the step still lands
  // on the 3rd tick of the ORIGINAL count rather than three ticks later.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf02b]]);
  const v = voiceOf(eng);
  render(eng, TICK * 2);
  assert.equal(v.funkAccumulator, 0x2b * 2, "two ticks of phase, unspent");
  assert.equal(v.funkPos, -1, "and no step yet");
  render(eng, TICK);
  assert.equal(v.funkPos, 132, "the third tick overflows $80 and steps");
  assert.equal(v.funkAccumulator, 0, "reset to zero, not decremented by $80");
});

test("Z $F000 stops the walk, keeps the phase, and leaves the window where it is", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080], [0x00, 0x0000], [0x23, 0xf000]]);
  const v = voiceOf(eng);
  render(eng, ROW * 3);
  const stopped = v.funkPos;
  assert.equal(v.funkSpeed, 0);
  assert.ok(stopped > 100, "the walk had moved before it was switched off");
  render(eng, ROW * 4);
  assert.equal(v.funkPos, stopped, "and it stays exactly where it was");
  assert.ok(v.samplePos >= v.funkWindow && v.samplePos < v.funkWindow + 32,
    "the moved window keeps sounding — PT leaves the repeat pointer alone too");
});

test("a fresh trigger puts the loop back; the speed and the phase do not", () => {
  const eng = makeEngine(100, 132);
  // Row 0 arms the walk, row 4 sounds the note again with no effect at all.
  loadRows(eng, [[0x23, 0xf080]], [4]);
  const v = voiceOf(eng);
  render(eng, ROW * 4 + TICK);   // one tick into the re-triggered note
  assert.equal(v.funkSpeed, 0x80, "the speed is channel state and survives the note");
  assert.equal(v.funkPos, 132,
    "the walk restarts from the loop start (PT's n_wavestart = n_loopstart)");
  assert.ok(v.samplePos < 164, "and the voice is sounding near the sample's own loop again");
});

test("an unlooped sample is left alone — the effect needs a loop to move", () => {
  const eng = makeEngine(0, 0, 0); // loop mode 0: no loop
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, ROW);
  assert.equal(v.funkSpeed, 0x80, "the command still lands");
  assert.equal(v.funkPos, -1, "…and finds nothing to walk");
});

test("the ladder fires on the ticks §8.1 tabulates", () => {
  // The report's accumulator table, read back through the engine: the tick a
  // walk starting from a zero phase takes its FIRST step on.
  const LADDER = [
    [0x05, 26], [0x06, 22], [0x07, 19], [0x08, 16], [0x0a, 13], [0x0b, 12],
    [0x0d, 10], [0x10, 8], [0x13, 7], [0x16, 6], [0x1a, 5], [0x20, 4],
    [0x2b, 3], [0x40, 2], [0x80, 1],
  ];
  for (const [speed, tick] of LADDER) {
    const eng = makeEngine(100, 132);
    loadRows(eng, [[0x23, 0xf000 | speed]]);
    const v = voiceOf(eng);
    render(eng, TICK * (tick - 1));
    assert.equal(v.funkPos, -1,
      `speed $${speed.toString(16)}: nothing before tick ${tick}`);
    render(eng, TICK);
    assert.equal(v.funkPos, 132,
      `speed $${speed.toString(16)}: the first step lands on tick ${tick}`);
  }
});

test("nothing is written to the sample: the pool is untouched", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  render(eng, ROW * 8);
  for (let i = 0; i < SAMPLE_LEN; i++) {
    assert.equal(eng.sampleBin[i], i & 0xff, `sample byte ${i} is as it was uploaded`);
  }
  assert.equal(eng.instruments[1].invertMask, null,
    "and no invert-loop mask was allocated — this is the OTHER EFx");
});

test("the funk form of Z is live in a stereo song, and leaves the slide alone", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  assert.equal(eng.getSurroundModel(0), 0, "a plain stereo song");
  render(eng, TICK);
  assert.equal(v.funkPos, 132, "…which ignores Z $0xxx but must not ignore Z $F0xx");
  assert.equal(v.spatialSlideActive, false);
  assert.equal(v.mem.z, 0, "the spatial slide's memory slot is not the funk speed");
});

test("Z $0xxx still slides, and does not arm the walk", () => {
  const eng = makeEngine(100, 132);
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  loadRows(eng, [[0x04, 0x0040], [0x23, 0x0100]]); // aim front-left, then slide
  const v = voiceOf(eng);
  render(eng, ROW * 2);
  assert.equal(v.mem.z, 0x100, "the slide speed went to the slide's memory");
  assert.equal(v.funkSpeed, 0, "and nothing to the walk");
  assert.equal(v.funkPos, -1);
});

test("a transport reset clears the walk", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, ROW * 2);
  assert.ok(v.funkPos > 100);
  eng.resetSampleFxState(0);
  assert.equal(v.funkSpeed, 0);
  assert.equal(v.funkAccumulator, 0);
  assert.equal(v.funkPos, -1);
  assert.equal(v.funkWindow, -1, "a clean replay starts from the file's own loop");
});

// ── The Samples view's state overlay (item 164) ──────────────────────────────
// The view draws the window from the SNAPSHOT, so what is pinned here is the
// data path: the three per-voice fields, and that they say what the overlay
// needs — where the loop is, where it is going, and how wide to draw it.

test("the snapshot carries the window, the pending hop and the width", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  const f = new Float64Array(SNAP_FLOATS);
  const vField = (vi, k) => f[SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE + k];

  render(eng, TICK * 4);
  fillSnapshotInto(eng, 0, f);
  assert.equal(vField(0, SNAP_V_FUNK_WINDOW), v.funkWindow);
  assert.equal(vField(0, SNAP_V_FUNK_POS), v.funkPos);
  assert.equal(vField(0, SNAP_V_FUNK_LEN), 32, "the VOICE's active loop length");
  assert.ok(vField(0, SNAP_V_FUNK_POS) >= vField(0, SNAP_V_FUNK_WINDOW),
    "the pending hop runs ahead of the window that is sounding");
  // …and the overlay's own guard: the band must fit inside the sample it is
  // drawn over, whatever the walk is doing.
  assert.ok(vField(0, SNAP_V_FUNK_WINDOW) + vField(0, SNAP_V_FUNK_LEN) <= SAMPLE_LEN);
});

test("a voice with no walk reports -1, so nothing is drawn", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x00, 0x0000]]);   // a note, no funk
  const f = new Float64Array(SNAP_FLOATS);
  const vField = (vi, k) => f[SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE + k];
  render(eng, TICK * 4);
  fillSnapshotInto(eng, 0, f);
  assert.equal(vField(0, SNAP_V_ACTIVE), 1, "the voice is sounding");
  assert.equal(vField(0, SNAP_V_FUNK_WINDOW), -1, "…on the sample's own loop");
  assert.equal(vField(0, SNAP_V_FUNK_POS), -1);
  // A silent voice reports -1 too, rather than a stale window from last time.
  assert.equal(vField(TOTAL_VOICES - 1, SNAP_V_FUNK_WINDOW), -1);
  assert.equal(vField(TOTAL_VOICES - 1, SNAP_V_FUNK_POS), -1);
});

// ── The walk selector (Z $Ffxx, item 163) ────────────────────────────────────
// `$f` reads as two independent choices over the ONE thing 1.0C had: the hop.
// Low two bits size it (whole / half / quarter / eighth of the loop), high two
// pick what it does with it (forward / backward / forward with the landing
// jittered / free throw). `$f = 0` is 1.0C's own, which every test above still
// pins.
//
// The walk lives on a grid of hop-sized positions rooted at the loop start and
// stops at the last one whose whole window fits before the sample end, so with
// loop [100, 132) in a 1000-byte sample there are (1000 − 32 − 100) / hop + 1
// positions: 28 whole blocks, 55 halves, 109 quarters, 218 eighths.

test("the low two bits of $f size the hop: whole, half, quarter, eighth", () => {
  for (const [mode, step] of [[0x0, 32], [0x1, 16], [0x2, 8], [0x3, 4]]) {
    const eng = makeEngine(100, 132);
    loadRows(eng, [[0x23, 0xf080 | (mode << 8)]]);
    const v = voiceOf(eng);
    const seen = [];
    for (let i = 0; i < 3; i++) { render(eng, TICK); seen.push(v.funkPos); }
    assert.deepEqual(seen, [100 + step, 100 + 2 * step, 100 + 3 * step],
      `$F${mode.toString(16)}80 hops by ${step}`);
    assert.equal(v.funkMode, mode, "the selector is channel state, like the speed");
  }
});

test("the grain overlaps but never grows: the WINDOW is still the loop", () => {
  // A half-block walk is the same grain heard twice as often, not a shorter
  // one — the pitch of a looped grain is its length, and that must not move.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf180]]);
  const v = voiceOf(eng);
  render(eng, TICK * 6);
  assert.equal(v.funkPos, 100 + 6 * 16);
  assert.ok(v.samplePos >= v.funkWindow && v.samplePos < v.funkWindow + 32,
    `samplePos ${v.samplePos} is inside a 32-byte window at ${v.funkWindow}`);
});

test("$f4..$f7 walk BACKWARD, and the first step goes to the top of the sample", () => {
  // The mirror of §3.3: forward snaps home when the next window would not fit,
  // backward wraps to the last position that does. From an unmoved pointer that
  // is the first thing it does, which is what makes the family audible at all.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf480]]);
  const v = voiceOf(eng);
  const seen = [];
  for (let i = 0; i < 3; i++) { render(eng, TICK); seen.push(v.funkPos); }
  assert.deepEqual(seen, [100 + 27 * 32, 100 + 26 * 32, 100 + 25 * 32],
    "top of the walk (block 27 of 0…27), then down a block a step");
  assert.ok(seen[0] + 32 <= SAMPLE_LEN, "and the whole window still fits");
});

test("a backward walk wraps at the bottom, not at zero", () => {
  const eng = makeEngine(16, 32);
  eng.instruments[1].sampleLength = 128;   // positions 16 32 48 64 80 96 112
  loadRows(eng, [[0x23, 0xf480]]);
  const v = voiceOf(eng);
  const seen = [];
  for (let i = 0; i < 8; i++) { render(eng, TICK); seen.push(v.funkPos); }
  assert.deepEqual(seen, [112, 96, 80, 64, 48, 32, 16, 112],
    "…and back to the top, never below the loop the instrument declares");
});

test("changing $f mid-walk re-grids the pointer instead of jumping it", () => {
  // A finer grid contains every coarser one, so full → half must not move the
  // window; coarse-ward it lands on the nearest whole hop.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080], [0x23, 0xf180]]);
  const v = voiceOf(eng);
  render(eng, ROW);                     // six whole-block steps: 100 + 6×32
  assert.equal(v.funkPos, 292);
  render(eng, TICK);                    // first half-block step off 292
  assert.equal(v.funkPos, 308, "292 is on the half grid too, so it just adds 16");
});

test("a loop with no room to move is inert whatever $f says", () => {
  for (const mode of [0x0, 0x3, 0x4, 0x7, 0x8, 0xb, 0xc, 0xf]) {
    const eng = makeEngine(SAMPLE_LEN - 32, SAMPLE_LEN);
    loadRows(eng, [[0x23, 0xf080 | (mode << 8)]]);
    const v = voiceOf(eng);
    render(eng, TICK * 4);
    assert.equal(v.funkPos, SAMPLE_LEN - 32,
      `$F${mode.toString(16)}80: pinned to the real loop start`);
  }
});

// The two random families are pinned through the engine's own seam (rng.js):
// production draws from Math.random, the tests from a seeded mulberry32, and
// the engine never calls Math.random itself.

/** Run one walk with a seeded RNG and report every position it visited. */
function walkPositions(mode, ticks, seed = 12345, ls = 100, le = 132) {
  setRandomSource(makeSeededRandom(seed));
  try {
    const eng = makeEngine(ls, le);
    loadRows(eng, [[0x23, 0xf080 | (mode << 8)]]);
    const v = voiceOf(eng);
    const seen = [];
    for (let i = 0; i < ticks; i++) { render(eng, TICK); seen.push(v.funkPos); }
    return seen;
  } finally {
    setRandomSource(null);
  }
}

test("$f8..$fB keep walking — the throw jitters the landing, not the walk", () => {
  // 28 whole-block positions ⇒ a reach of round(28/8) = 4 blocks either way.
  setRandomSource(makeSeededRandom(4242));
  try {
    const eng = makeEngine(100, 132);
    loadRows(eng, [[0x23, 0xf880]]);
    const v = voiceOf(eng);
    const K = 27, reach = 4;
    const walks = [], landed = [];
    for (let i = 0; i < 200; i++) {
      render(eng, TICK);
      walks.push((v.funkWalk - 100) / 32);
      landed.push((v.funkPos - 100) / 32);
    }
    // The WALK is exactly Z $F080's, untouched by the randomness: one block a
    // step, wrapping home at the top.
    walks.forEach((w, i) => assert.equal(w, (i + 1) % (K + 1), `walk at step ${i}`));
    landed.forEach((p, i) => {
      assert.ok(Number.isInteger(p) && p >= 0 && p <= K, `${p} is a grid position`);
      assert.ok(Math.abs(p - walks[i]) <= reach,
        `step ${i}: landed on ${p}, walk was at ${walks[i]}`);
    });
    assert.ok(landed.some((p, i) => p !== walks[i]), "…and it does jitter");
  } finally { setRandomSource(null); }
});

test("the jitter is measured from the WALK, never from the last throw", () => {
  // The bug this pins: feed each throw into the next one and ±1/8 becomes a
  // random walk whose spread grows without bound — the narrowest rung of the
  // ladder diffuses into the widest within seconds, and every setting ends up
  // the same effect with a different rise time. ENGINE_SPEC §8.5 says exactly
  // this of the sample modifications' jumps and scatters, and this family
  // follows the same rule. So: after 600 steps the spread must be what it was
  // after one, and the walk must have swept the sample the whole time.
  setRandomSource(makeSeededRandom(31337));
  try {
    const eng = makeEngine(100, 132);
    loadRows(eng, [[0x23, 0xf880]]);
    const v = voiceOf(eng);
    let worst = 0, sweeps = 0, prevWalk = -1;
    for (let i = 0; i < 600; i++) {
      render(eng, TICK);
      const walk = (v.funkWalk - 100) / 32;
      worst = Math.max(worst, Math.abs((v.funkPos - 100) / 32 - walk));
      if (walk === 0 && prevWalk === 27) sweeps++;
      prevWalk = walk;
    }
    assert.ok(worst <= 4, `the widest throw in 600 steps was ${worst} blocks, not more`);
    assert.equal(sweeps, 21, "and the walk swept the sample end to end throughout");
  } finally { setRandomSource(null); }
});

test("the throw CLAMPS at the ends, and the walk carries it away again", () => {
  // A four-position territory with a reach of 1: from the bottom the draw
  // {−1, 0, +1} can only land on {0, 0, 1}. Clamping is safe here in a way it
  // would not be for an accumulating walk — the walk moves on regardless, so
  // nothing can pile up against the end.
  const seen = walkPositions(0x8, 60, 7, 0, 250); // 250-byte loop, 4 positions
  const hist = [0, 0, 0, 0];
  for (const pos of seen) {
    assert.ok(pos >= 0 && pos <= 750, `${pos} inside the territory`);
    assert.equal(pos % 250, 0, "on the grid");
    hist[pos / 250]++;
  }
  assert.ok(hist.every((n) => n > 0), `every position is reached: ${hist}`);
});

test("$fC..$fF throw freely: uniform over the whole territory", () => {
  const seen = walkPositions(0xc, 400);
  const blocks = new Set(seen.map((p) => (p - 100) / 32));
  for (const pos of seen) {
    assert.equal((pos - 100) % 32, 0, `${pos} is on the whole-block grid`);
    assert.ok(pos >= 100 && pos + 32 <= SAMPLE_LEN, `${pos} keeps the window inside`);
  }
  assert.ok(blocks.size >= 25, `reaches nearly every block of 28 (${blocks.size})`);
  // …and it has no memory: consecutive throws are as far apart as any two.
  let far = 0;
  for (let i = 1; i < seen.length; i++) if (Math.abs(seen[i] - seen[i - 1]) > 8 * 32) far++;
  assert.ok(far > 40, `${far} steps crossed a quarter of the sample — a THROW, not a walk`);
});

test("the random families take their grain from the same two bits", () => {
  const eighths = walkPositions(0xf, 120);
  for (const pos of eighths) {
    assert.equal((pos - 100) % 4, 0, `${pos} is on the eighth-block grid`);
  }
  assert.ok(new Set(eighths).size > 40, "218 positions, so the throws rarely repeat");
});

test("the walk draws through rng.js, so a seed makes it reproducible", () => {
  assert.deepEqual(walkPositions(0xc, 40, 99), walkPositions(0xc, 40, 99));
  assert.notDeepEqual(walkPositions(0xc, 40, 99), walkPositions(0xc, 40, 100));
});

test("Z $Ff00 arms a walk without starting one, and it outlives the note", () => {
  const eng = makeEngine(100, 132);
  // Row 0 arms mode 4 at speed $00; row 1 re-sounds the note and says nothing.
  loadRows(eng, [[0x23, 0xf400]], [1]);
  const v = voiceOf(eng);
  render(eng, TICK * 5);
  assert.equal(v.funkMode, 4, "the selector landed");
  assert.equal(v.funkSpeed, 0, "…with nothing driving it");
  assert.equal(v.funkPos, -1, "so nothing walked");
  render(eng, ROW);
  assert.equal(v.funkMode, 4, "and a fresh note does not clear it, as it does not the speed");
});

test("Z $F0xx rewrites BOTH halves, so an old song's spelling still means mode 0", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf480], [0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK);
  assert.equal(v.funkPos, 100 + 27 * 32, "row 0 walks backward from the top");
  render(eng, TICK * 5);                // the rest of row 0: five blocks down
  assert.equal(v.funkPos, 100 + 22 * 32);
  render(eng, TICK);                    // row 1's first tick, and its Z $F080
  assert.equal(v.funkMode, 0);
  assert.equal(v.funkSpeed, 0x80);
  assert.equal(v.funkPos, 100 + 23 * 32, "…and the very next step goes forward again");
});

test("a transport reset clears the walk selector too", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf680]]);
  const v = voiceOf(eng);
  render(eng, ROW);
  assert.equal(v.funkMode, 6);
  eng.resetSampleFxState(0);
  assert.equal(v.funkMode, 0);
});

test("the snapshot carries the selector, so the overlay can name and space it", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf280]]);
  const f = new Float64Array(SNAP_FLOATS);
  const vField = (vi, k) => f[SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE + k];
  render(eng, TICK * 3);
  fillSnapshotInto(eng, 0, f);
  assert.equal(vField(0, SNAP_V_FUNK_MODE), 2);
  const hop = vField(0, SNAP_V_FUNK_LEN) / (1 << (vField(0, SNAP_V_FUNK_MODE) & 3));
  assert.equal(hop, 8, "the overlay derives the hop from the pair");
  assert.equal(vField(0, SNAP_V_FUNK_POS), 100 + 3 * 8);
});

// ── The seam crossfade (item 163.2) ──────────────────────────────────────────
// Latching the window at the loop restart is what keeps the walk from moving
// the loop out from under a block that is still sounding — but the restart
// itself lands in a part of the sample that has nothing to do with the one just
// playing, and between two output samples that is a step: a click per hop, up
// to one a tick. The sample modifications crossfade their steps for exactly
// this reason (§8.5) and so does this one now.

/** Render `samples` frames and return the PRE-DITHER float bus (left). */
function renderFloat(eng, samples) {
  const ts = eng.playheads[0].trackerState;
  const buf = new Uint8Array(TRACKER_CHUNK * 2);
  const out = [];
  for (let i = 0; i < Math.ceil(samples / TRACKER_CHUNK); i++) {
    eng.renderChunk(0, buf);
    for (let n = 0; n < TRACKER_CHUNK; n++) out.push(ts.mixLeft[n]);
  }
  return out;
}

/**
 * A 1000-byte sample in DC steps, played with NO interpolation, so a hop is a
 * pure level change of a known size and the seam is the only thing in the
 * signal. Everything below 132 is one level — the note plays through it and
 * loops [100,132) inside it — and everything from 132 up is another, which is
 * where the first hop lands. Paula ZOH (INTERP_NONE) keeps the sinc kernel from
 * reading across the DC edges and wiggling the flat parts.
 */
function makeStepEngine() {
  const eng = makeEngine(100, 132);
  for (let i = 0; i < SAMPLE_LEN; i++) eng.sampleBin[i] = i < 132 ? 0x60 : 0xa0;
  eng.instruments[1].defaultCutoff = 0xff;   // filter OFF, or its own step response is the signal
  eng.playheads[0].trackerState.interpolationMode = INTERP_NONE;
  return eng;
}

test("the hop is crossfaded, not cut — no step between two output samples", () => {
  const eng = makeStepEngine();
  loadRows(eng, [[0x23, 0xf080]]);
  // The first tick lands the walk on 132 and the next loop restart installs it,
  // a little past output sample 640; a whole tick either side of that is plenty.
  const ts = eng.playheads[0].trackerState;
  ts.interpolationMode = INTERP_NONE;        // …again: play() re-reads it from the song flags
  const sig = renderFloat(eng, 1200);
  const change = Math.abs(sig[900] - sig[400]);
  assert.ok(change > 0.05, `the hop changed the material by ${change}`);
  // …and it got there over a ramp, not in one sample. The window is 32 bytes at
  // rate 1.0, so the crossfade is 32 output samples and no adjacent pair may
  // carry more than a fraction of the whole change. Measured past the note's own
  // attack ramp (ATTACK_RAMP_SAMPLES = 32 at 32 kHz).
  let worst = 0, worstAt = -1;
  for (let n = 40; n < 1200; n++) {
    const d = Math.abs(sig[n] - sig[n - 1]);
    if (d > worst) { worst = d; worstAt = n; }
  }
  assert.ok(worst < change / 8,
    `biggest step ${worst} at sample ${worstAt}, against a total change of ${change}`);
});

test("an ordinary loop wrap is NOT crossfaded — a plain looped sample is untouched", () => {
  // The guard on the paragraph above: the crossfade must arm only where the
  // WINDOW moved. A loop point is the one seam the musician chose, and running
  // a 2 ms fade over every wrap of every looped sample in every song would be a
  // change to all of them.
  const eng = makeStepEngine();
  loadRows(eng, [[0x00, 0x0000]]);      // a note, no funk
  const v = voiceOf(eng);
  render(eng, TICK * 4);
  assert.equal(v.funkXfade, 0, "nothing armed over four ticks of plain looping");
  assert.equal(v.funkWindow, -1);
});

test("the crossfade reads the window the hop replaced, and lasts one grain", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  // The walk steps on the tick; the window installs at the loop restart just
  // after it, which is a few samples into the next chunk.
  render(eng, TICK + TRACKER_CHUNK);
  assert.equal(v.funkPos, 132);
  assert.equal(v.funkWindow, 132, "the restart latched it");
  // Offset = old window − new window, so the ghost read is just the live
  // position shifted back into the block that was playing.
  assert.equal(v.funkXfadeOffset, -32);
  // 32 bytes at rate 1.0 is 32 output samples, under the 64-sample cap: a
  // crossfade never outlives the grain it is fading into.
  assert.equal(v.funkXfadeLen, 32);
});

test("a long window caps the crossfade at 64 samples, not at the grain", () => {
  const eng = makeEngine(0, 300);       // 300-byte window, three of them fit
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 2);
  assert.ok(v.funkWindow > 0, "the window moved");
  assert.equal(v.funkXfadeLen, FUNK_XFADE_SAMPLES);
});

test("a fresh trigger drops a crossfade in flight", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]], [1]);
  const v = voiceOf(eng);
  render(eng, ROW);
  assert.equal(v.funkXfade, 0, "the new note is not still fading out of the old walk");
});
