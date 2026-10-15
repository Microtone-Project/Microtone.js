// Item 215 — a play that starts in the middle of the song finds every lane
// where the song itself leaves it there: the chase (core/engine/chase.js,
// TAUD_ENGINE_SPEC.md §15.1).
//
// The reference is a real render: play the song from its start and note the
// state on each row's first arrival; a chase to that row has to land on the
// same state. Every chase below runs on the engine the reference render has
// just played to the end of, so nothing the play left behind may leak in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import { EffectOp } from "../../core/engine/tables.js";
import { Voice } from "../../core/engine/voice.js";
import { applyTrackerRow } from "../../core/engine/row.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { CMD } from "../../core/worklet/protocol.js";
import { applyAudioCommand, isTransportReset } from "../../core/worklet/engine-commands.js";
import { GOLDEN_SET, goldenPath } from "../../tools/golden-set.js";

// ── what a chase promises: the lanes, their memory, the playhead's tempo ──

const LANE_FIELDS = [
  "channelVolume", "channelVolumeSet", "channelPan", "channelPanSet", "rowPan",
  "panAzimuth", "panElevation", "notePan", "noteElevation", "glissandoOn",
  "clipMode", "bitcrusherDepth", "bitcrusherSkip", "overdriveAmp",
  "nnaOverride", "volEnvOn", "panEnvOn", "pitchEnvOn", "filterEnvOn",
  "invertSpeed", "funkSpeed", "funkMode", "instrumentId",
  "vibratoWave", "tremoloWave", "panbrelloWave",
  "loopStartRow", "loopCount", "dittoActive", "dittoSourceStart", "dittoLength", "dittoEndRow",
];

function laneState(eng) {
  const ph = eng.playheads[0];
  const ts = ph.trackerState;
  const s = {
    bpm: ph.bpm, tickRate: ph.tickRate, globalVolume: ph.globalVolume,
    toneMode: ts.toneMode, interpolationMode: ts.interpolationMode, ledFilterOn: ts.ledFilterOn,
  };
  for (let vi = 0; vi < eng.channelCount(); vi++) {
    const v = ts.voices[vi];
    for (const k of LANE_FIELDS) s[`${vi}.${k}`] = v[k];
    s[`${vi}.mem`] = JSON.stringify(v.mem);
  }
  return s;
}

/**
 * Play from the start for up to `seconds`; the lane state at each row's FIRST
 * arrival, just after its row event and before its first tick pass — which
 * is where a chunk boundary leaves tickInRow at 0. key = cue * 64 + row.
 */
function arrivals(eng, seconds) {
  const ts = eng.playheads[0].trackerState;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const seen = new Map();
  eng.setCuePosition(0, 0);
  eng.play(0);
  const chunks = Math.ceil((seconds * 48000) / TRACKER_CHUNK);
  for (let i = 0; i < chunks && eng.isPlaying(0); i++) {
    eng.renderChunk(0, out);
    if (ts.tickInRow !== 0 || ts.patternDelayActive) continue;
    const key = ts.cuePos * 64 + ts.rowIndex;
    if (!seen.has(key)) seen.set(key, laneState(eng));
  }
  eng.stop(0);
  return seen;
}

/** What the app's play-from-cursor does: the song's own starting tempo,
 *  speed and volumes, then the chase. Returns the state on the row. */
function chaseTo(eng, start, cue, row) {
  eng.setBPM(0, start.bpm);
  eng.setTickRate(0, start.tickRate);
  eng.setSongGlobalVolume(0, start.globalVolume);
  eng.setSongMixingVolume(0, start.mixingVolume);
  const reached = eng.chaseTrackerRow(0, cue, row);
  return { reached, eng };
}

/** The chased state with the row's own event applied, as the reference has it. */
function chasedState(eng, start, cue, row) {
  const { reached } = chaseTo(eng, start, cue, row);
  const ph = eng.playheads[0];
  applyTrackerRow(eng, ph.trackerState, ph);
  return { reached, state: laneState(eng) };
}

function assertMatches(label, ref, got) {
  const diffs = Object.keys(ref).filter((k) => !Object.is(ref[k], got[k]))
    .map((k) => `${k}: played ${ref[k]}, chased ${got[k]}`);
  assert.deepEqual(diffs, [], `${label}: the chase differs from the play`);
}

// ── a small song, built by hand ──

const DEFAULT_START = { bpm: 125, tickRate: 6, globalVolume: 0x80, mixingVolume: 0x80 };

/** `patterns`: {index: [[row, note, inst, effect, arg], …]}; `cues`: [{lanes:
 *  [pattern per lane…], inst0?: instruction word}]. Instrument 1 is a looped
 *  square, so its notes sound until something ends them. */
function songEngine(patterns, cues) {
  const eng = new TaudEngine();
  for (let i = 0; i < 256; i++) eng.sampleBin[i] = i < 128 ? 0x00 : 0xff;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256); w16(6, 32000); w16(12, 256);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[182] = 0xff; rec[196] = 255;
  eng.uploadInstrument(1, rec);
  for (const [idx, cells] of Object.entries(patterns)) {
    const pat = new Uint8Array(512);
    for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
    for (const [r, note, inst, effect, arg] of cells) {
      const o = r * 8;
      pat[o] = note & 0xff; pat[o + 1] = (note >>> 8) & 0xff;
      pat[o + 2] = inst;
      pat[o + 5] = effect;
      pat[o + 6] = arg & 0xff; pat[o + 7] = (arg >>> 8) & 0xff;
    }
    eng.uploadPattern(Number(idx), pat);
  }
  cues.forEach((c, i) => {
    const bytes = new Uint8Array(64);
    for (let ch = 0; ch < 32; ch++) { bytes[ch * 2] = 0xff; bytes[ch * 2 + 1] = 0x7f; }
    c.lanes.forEach((p, ch) => { bytes[ch * 2] = p & 0xff; bytes[ch * 2 + 1] = (p >>> 8) & 0x7f; });
    // An instruction word rides the lane words' sign bits, bit k on lane k.
    for (let k = 0; k < 16; k++) if (((c.inst0 ?? 0) >>> k) & 1) bytes[k * 2 + 1] |= 0x80;
    eng.uploadCue(i, bytes);
  });
  eng.setMasterVolume(0, 255);
  chaseTo(eng, DEFAULT_START, 0, 0);
  return eng;
}

const { OP_S, OP_M, OP_N, OP_P, OP_D, OP_T, OP_A, OP_V, OP_W, OP_B, OP_C, OP_8, OP_9 } = EffectOp;
const HALT = 0x0100;
const goBack = (n) => 0x8000 | n;
const NOTE = 0x5000;

/** Lane 0 moved about, lane 1 sliding, lane 2 carrying the playhead's state. */
const BUSY = {
  0: [
    [0, NOTE, 1, OP_S, 0x80ff], [1, 0, 0, OP_M, 0x2000], [2, 0, 0, OP_S, 0x1100],
    [3, 0, 0, OP_8, 0x1304], [4, 0, 0, OP_9, 0x2020], [5, 0, 0, OP_D, 0x0400],
    [6, 0, 0, OP_N, 0x0200], [7, 0, 0, OP_N, 0], [9, 0, 0, OP_S, 0x8040],
  ],
  1: [[0, NOTE, 1, OP_P, 0x0300], [1, 0, 0, OP_P, 0], [2, 0, 0, OP_N, 0x0100], [4, 0, 0, OP_M, 0x3000]],
  2: [[1, 0, 0, OP_T, 0x9600], [2, 0, 0, OP_A, 0x0300], [3, 0, 0, OP_V, 0x4000], [5, 0, 0, OP_W, 0x0100],
    [6, 0, 0, OP_T, 0x0012]],
};

setSamplingRate(48000);

test("Voice.resetToPowerOn leaves a voice as the constructor makes one, fader aside", () => {
  const eng = songEngine(BUSY, [{ lanes: [0, 1, 2] }]);
  arrivals(eng, 4);
  const v = eng.playheads[0].trackerState.voices[0];
  assert.notEqual(v.mem.d, 0, "premise: the play wrote the effect memory");
  v.fader = 77;
  v.resetToPowerOn(63);
  const fresh = new Voice();
  for (const k of Object.keys(fresh)) {
    if (k === "fader" || k === "scopeBuffer") continue;
    assert.deepEqual(v[k], fresh[k], `field ${k}`);
  }
  assert.equal(v.fader, 77, "the desk's fader is not the song's to reset");
});

test("a chase arrives on every row with the state a play from the start has there", () => {
  const eng = songEngine(BUSY, [{ lanes: [0, 1, 2] }, { lanes: [0, 1, 2] }]);
  const ref = arrivals(eng, 30);
  assert.ok(ref.size > 100, `premise: the play visited both cues (${ref.size} rows)`);
  for (const [key, state] of ref) {
    const { reached, state: got } = chasedState(eng, DEFAULT_START, key >> 6, key & 63);
    assert.equal(reached, true, `cue ${key >> 6} row ${key & 63} is on the song's path`);
    assertMatches(`cue ${key >> 6} row ${key & 63}`, state, got);
  }
  // …and the play really did move what the chase has to carry.
  const late = ref.get(64 + 20);
  assert.equal(late["0.channelPan"], 0x40);
  assert.equal(late["0.channelVolume"] < 0x20, true, "N slid lane 0's volume down");
  assert.equal(late["0.bitcrusherDepth"], 3);
  assert.equal(late.tickRate, 3);
  assert.equal(late.globalVolume < 0x40, true, "W slid the global volume down");
  assert.equal(late.bpm > 0x96 + 0x19, true, "T slid the tempo up");
});

test("a chase leaves nothing sounding, keeps the desk's faders and fires no interrupt", () => {
  const eng = songEngine({ 0: [[0, NOTE, 1, OP_S, 0x80ff], [2, 0x0013, 0, 0, 0], [4, NOTE, 1, 0, 0]] },
    [{ lanes: [0, 0] }]);
  eng.setVoiceMute(0, 3, true);
  eng.setVoiceFader(0, 1, 200);
  chaseTo(eng, DEFAULT_START, 0, 8);
  const ts = eng.playheads[0].trackerState;
  assert.equal(ts.voices.some((v) => v.active), false, "every chased note is let go");
  assert.equal(ts.backgroundVoices.length, 0, "and the ghost pool is empty");
  assert.equal(eng.pollTrackerInterrupts(0), 0, "Int3 on row 2 was passed, not fired");
  assert.equal(eng.getVoiceMute(0, 3), true, "a muted lane stays muted");
  assert.equal(eng.getVoiceFader(0, 1), 200, "and a set fader keeps its value");
  assert.equal(ts.voices[0].channelPan, 0xff, "while the lane itself is the song's");
  assert.equal(eng.getCuePosition(0), 0);
  assert.equal(eng.getTrackerRow(0), 8);
  assert.equal(ts.firstRow, true, "the row itself is the play's to apply");
});

test("a chase to the start puts back the song's own tempo, speed and volume", () => {
  const eng = songEngine(BUSY, [{ lanes: [0, 1, 2] }]);
  arrivals(eng, 4);
  assert.notEqual(eng.getBPM(0), 125, "premise: the play moved the tempo");
  chaseTo(eng, DEFAULT_START, 0, 0);
  assert.equal(eng.getBPM(0), 125);
  assert.equal(eng.getTickRate(0), 6);
  assert.equal(eng.getSongGlobalVolume(0), 0x80);
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.channelPan, 0x80);
  assert.equal(v.channelVolume, 63);
  assert.equal(v.mem.d, 0, "the last play's effect memory is gone with it");
});

test("a cue that a B jump skips is not chased", () => {
  const eng = songEngine({
    0: [[0, NOTE, 1, OP_S, 0x80ff], [3, 0, 0, OP_B, 2]],
    1: [[0, 0, 0, OP_S, 0x8000]],
    2: [[0, 0, 0, OP_M, 0x2000]],
  }, [{ lanes: [0] }, { lanes: [1] }, { lanes: [2] }]);
  const { reached } = chaseTo(eng, DEFAULT_START, 2, 5);
  assert.equal(reached, true);
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.channelPan, 0xff, "cue 1's S $8000 never played");
  assert.equal(v.channelVolume, 0x20, "cue 2's own rows did");
});

test("a row past a halt is chased through the cues in order", () => {
  const eng = songEngine({ 0: [[0, NOTE, 1, OP_S, 0x80ff]], 1: [[0, 0, 0, OP_M, 0x2000]] },
    [{ lanes: [0], inst0: HALT }, { lanes: [1] }]);
  const { reached } = chaseTo(eng, DEFAULT_START, 1, 4);
  assert.equal(reached, false, "the song stops before cue 1");
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.channelPan, 0xff);
  assert.equal(v.channelVolume, 0x20);
  assert.equal(eng.isPlaying(0), false, "the walk's halt does not leave the transport running");
  assert.equal(eng.getCuePosition(0), 1);
  assert.equal(eng.getTrackerRow(0), 4);
});

test("a row a song that loops for ever never plays is chased through the cues in order", () => {
  const eng = songEngine({
    0: [[0, NOTE, 1, OP_S, 0x80ff]], 1: [[0, 0, 0, OP_M, 0x2000]], 2: [[0, 0, 0, OP_S, 0x8000]],
  }, [{ lanes: [0] }, { lanes: [1], inst0: goBack(1) }, { lanes: [2] }]);
  const { reached } = chaseTo(eng, DEFAULT_START, 2, 3);
  assert.equal(reached, false, "cue 1 sends the song back to cue 0 every time");
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.channelVolume, 0x20, "cue 1 was walked");
  assert.equal(v.channelPan, 0x00, "and so was cue 2, up to the row");
});

test("a row after a pattern break in its own cue goes by the cue order; the song's path does not", () => {
  const patterns = {
    0: [[0, NOTE, 1, OP_S, 0x80ff], [7, 0, 0, OP_C, 0], [10, 0, 0, OP_M, 0x1000]],
    1: [[0, 0, 0, OP_M, 0x3000]],
  };
  const cues = [{ lanes: [0] }, { lanes: [1] }];
  const past = songEngine(patterns, cues);
  assert.equal(chaseTo(past, DEFAULT_START, 0, 12).reached, false, "row 12 of cue 0 never plays");
  assert.equal(past.playheads[0].trackerState.voices[0].channelVolume, 0x10,
    "the cue order walked row 10");
  const after = songEngine(patterns, cues);
  assert.equal(chaseTo(after, DEFAULT_START, 1, 2).reached, true);
  assert.equal(after.playheads[0].trackerState.voices[0].channelVolume, 0x30,
    "the song breaks at row 7, so row 10's M never played");
});

test("inside a pattern loop, a chase lands on the first time round", () => {
  const eng = songEngine({ 0: [[2, 0, 0, OP_S, 0xb000], [3, 0, 0, OP_W, 0xf100], [5, 0, 0, OP_S, 0xb200]] },
    [{ lanes: [0] }]);
  chaseTo(eng, DEFAULT_START, 0, 4);
  assert.equal(eng.getSongGlobalVolume(0), 0x7f, "row 3 ran once");
  chaseTo(eng, DEFAULT_START, 0, 6);
  assert.equal(eng.getSongGlobalVolume(0), 0x7d, "…and three times once the loop is through");
});

test("the chase is a transport command", () => {
  const eng = songEngine(BUSY, [{ lanes: [0, 1, 2] }]);
  assert.equal(applyAudioCommand(eng, { t: CMD.CHASE_TRACKER_ROW, ph: 0, cue: 0, row: 6 }), true);
  assert.equal(eng.getTrackerRow(0), 6);
  assert.equal(eng.playheads[0].trackerState.voices[0].channelVolume, 0x20);
  assert.equal(isTransportReset(CMD.CHASE_TRACKER_ROW), true,
    "the render worker drops its look-ahead on it, as on setTrackerRow");
});

// ── the demo projects (always) and the local corpus (where present) ──

const exists = (p) => access(p).then(() => true, () => false);

for (const [label, entry] of Object.entries(GOLDEN_SET)) {
  if (entry.monitor !== undefined) continue; // the same song as another entry
  test(`chase vs play: ${label}`, async (t) => {
    const path = goldenPath(entry);
    if (!(await exists(path))) { t.skip("local-only corpus file"); return; }
    setRandomSource(makeSeededRandom(1));
    const doc = parseTaud(await readFile(path));
    const song = doc.songs[0];
    const start = {
      bpm: song.bpm, tickRate: song.tickRate > 0 ? song.tickRate : 6,
      globalVolume: song.globalVolume, mixingVolume: song.mixingVolume,
    };
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    const ref = arrivals(eng, 20);
    const keys = [...ref.keys()];
    const step = Math.max(1, Math.floor(keys.length / 24));
    for (let i = 0; i < keys.length; i += step) {
      const key = keys[i];
      const { reached, state } = chasedState(eng, start, key >> 6, key & 63);
      assert.equal(reached, true, `cue ${key >> 6} row ${key & 63} is on the song's path`);
      assertMatches(`${label} cue ${key >> 6} row ${key & 63}`, ref.get(key), state);
    }
  });
}
