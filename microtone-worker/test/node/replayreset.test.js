// Item 125 — lane-scope state (panning above all) is per-PLAY, not for ever.
//
// Nothing reset it: `setTrackerRow`, the documented pre-play reset point, only
// cleared timing + the NNA ghosts, and `loadDocument` never called resetParams
// at all — so the last `S $80xx` of one play was still steering the lane on
// the next one, and a second file opened on top of the first inherited the
// first's panning and lane volumes. taut.js has always called
// resetAudioDevice() (→ audio.resetParams) before every taud.uploadTaudFile;
// the web build simply never did.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";
import { AudioSystem } from "../../src/audio/audio-system.js";
import { CMD } from "../../src/worklet/protocol.js";

setSamplingRate(32000);

/** Engine with one instrument and a pattern that shoves lane 0 around:
 *  hard right (S $80FF), lane volume $20 (M), glissando on (S $1100). */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 256; i++) eng.sampleBin[i] = i < 128 ? 0x00 : 0xff;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256); w16(6, 32000); w16(12, 256);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[182] = 0xff; rec[196] = 255;
  eng.uploadInstrument(1, rec);

  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  const cell = (r, note, inst, effect, arg) => {
    const o = r * 8;
    pat[o] = note & 0xff; pat[o + 1] = (note >>> 8) & 0xff;
    pat[o + 2] = inst;
    pat[o + 5] = effect;
    pat[o + 6] = arg & 0xff; pat[o + 7] = (arg >>> 8) & 0xff;
  };
  cell(0, 0x5000, 1, EffectOp.OP_S, 0x80ff); // pan hard right
  cell(1, 0, 0, EffectOp.OP_M, 0x2000);      // lane volume $20
  cell(2, 0, 0, EffectOp.OP_S, 0x1100);      // glissando on
  cell(3, 0, 0, EffectOp.OP_8, 0x1304);      // bitcrusher: fold, 3-bit, skip 4
  cell(4, 0, 0, EffectOp.OP_9, 0x2020);      // overdrive amp $20 (clip mode wrap)
  eng.uploadPattern(0, pat);

  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  return eng;
}

function playRows(eng, rows) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  eng.setCuePosition(0, 0);
  eng.setTrackerRow(0, 0);
  eng.play(0);
  for (let i = 0; i < 20000; i++) {
    eng.renderChunk(0, out);
    if (ts.rowIndex >= rows) break;
  }
  return ts.voices[0];
}

test("a replay starts from the song's own panning, not the last play's", () => {
  const eng = makeEngine();
  const v = playRows(eng, 5);
  // Premise: the pattern really did move the lane.
  assert.equal(v.channelPan, 0xff, "S $80FF panned the channel hard right");
  assert.equal(v.channelVolume, 0x20, "M $2000 set the channel volume");
  assert.equal(v.glissandoOn, true, "S $1100 armed glissando");

  eng.stop(0);
  eng.setTrackerRow(0, 0); // what playFrom does before every play
  const w = eng.playheads[0].trackerState.voices[0];
  assert.equal(w.channelPan, 0x80, "pan back to centre");
  assert.equal(w.rowPan, 32, "…and its 6-bit mirror with it");
  assert.equal(w.panAzimuth, 128.0, "surround azimuth back to front");
  assert.equal(w.panElevation, 0.0);
  assert.equal(w.notePan, 0, "the note axis too (a pan-column SET lives there)");
  assert.equal(w.channelVolume, 63, "channel volume back to full scale");
  assert.equal(w.glissandoOn, false);
  assert.equal(w.nnaOverride, -1);
  assert.equal(w.volEnvOn, true);
});

test("a replay starts uncrushed, whatever the last play left running", () => {
  const eng = makeEngine();
  const v = playRows(eng, 5);
  // Premise: the pattern really did engage the crusher and the overdrive.
  assert.equal(v.bitcrusherDepth, 3, "8 $1304 set the bit depth");
  assert.equal(v.bitcrusherSkip, 4, "…and the sample-skip");
  assert.equal(v.overdriveAmp, 0x20, "9 $2020 set the overdrive amplification");
  assert.equal(v.clipMode, 2, "…and the clipper the two effects share");

  eng.stop(0);
  eng.setTrackerRow(0, 0); // what playFrom does before every play
  const w = eng.playheads[0].trackerState.voices[0];
  assert.equal(w.bitcrusherDepth, 0, "the crusher is off again");
  assert.equal(w.bitcrusherSkip, 0);
  assert.equal(w.bitcrusherCounter, 0, "…with its hold phase back at the start");
  assert.equal(w.bitcrusherHeld, 0.0);
  assert.equal(w.right.bitcrusherCounter, 0, "the stereo twin's history too");
  assert.equal(w.right.bitcrusherHeld, 0.0);
  assert.equal(w.overdriveAmp, 0, "and the overdrive with it");
  assert.equal(w.clipMode, 0);
});

test("a full reset clears the crusher and the overdrive as well", () => {
  const eng = makeEngine();
  const v = playRows(eng, 5);
  assert.equal(v.bitcrusherDepth, 3, "premise: the crusher was running");
  eng.stop(0);
  eng.resetParams(0);
  assert.equal(v.bitcrusherDepth, 0);
  assert.equal(v.bitcrusherSkip, 0);
  assert.equal(v.bitcrusherCounter, 0);
  assert.equal(v.bitcrusherHeld, 0.0);
  assert.equal(v.overdriveAmp, 0);
  assert.equal(v.clipMode, 0);
});

test("the pre-play reset leaves the desk's own faders alone", () => {
  const eng = makeEngine();
  eng.setVoiceMute(0, 3, true);
  eng.setVoiceFader(0, 4, 200);
  eng.setTrackerRow(0, 0);
  assert.equal(eng.getVoiceMute(0, 3), true, "a muted channel stays muted across a replay");
  assert.equal(eng.getVoiceFader(0, 4), 200, "and a set fader keeps its value");
});

test("the pre-play reset keeps the song's tempo and volumes", () => {
  const eng = makeEngine();
  eng.setBPM(0, 200);
  eng.setTickRate(0, 3);
  eng.setSongGlobalVolume(0, 0x40);
  eng.setTrackerRow(0, 0);
  assert.equal(eng.getBPM(0), 200, "a replay must not throw the tempo away");
  assert.equal(eng.getTickRate(0), 3);
  assert.equal(eng.getSongGlobalVolume(0), 0x40);
});

// ── the file-load half ──────────────────────────────────────────────────────

const CUE_EMPTY = 0x7fff;

function fakeDoc() {
  const w = new Uint16Array(64).fill(CUE_EMPTY);
  w[0] = 0;
  return {
    is64Channel: false,
    sampleInstImage: null,
    ixmp: [],
    songs: [{
      patterns: [new Uint8Array(512)],
      cues: [w], bpm: 120, tickRate: 6, globalFlags: 0,
      globalVolume: 0x80, mixingVolume: 0x80,
    }],
  };
}

test("loadDocument resets the engine before it uploads anything", () => {
  const sys = new AudioSystem();
  const msgs = [];
  sys.engineTarget = { postMessage: (m) => msgs.push(m) };
  sys.loadDocument(fakeDoc(), 0);

  const order = msgs.map((m) => m.t);
  const reset = order.indexOf(CMD.RESET_PARAMS);
  assert.ok(reset >= 0, "a document load resets the playhead (taut resetAudioDevice)");
  assert.ok(order.indexOf(CMD.STOP) >= 0 && order.indexOf(CMD.STOP) < reset,
    "playback stops first");
  // After the cell format (the reset seeds per-voice volumes from its full
  // scale) and before anything the song table sets.
  assert.ok(order.indexOf(CMD.SET_CELL_FORMAT) < reset, "cell format precedes the reset");
  for (const after of [CMD.UPLOAD_PATTERNS, CMD.UPLOAD_CUE, CMD.SET_BPM, CMD.SET_TICK_RATE,
    CMD.SET_SONG_GLOBAL_VOLUME, CMD.SET_TRACKER_MIXER_FLAGS]) {
    assert.ok(order.indexOf(after) > reset, `${after} is re-sent after the reset`);
  }
});
