// Tone portamento (G) on a metainstrument's foreground voice (item 176, user
// report + minimal repro "portaonmeta.taud": two identical G-chains, channel 1
// on a plain instrument, channel 2 on a metainstrument whose layer 0 carries a
// detune — channel 1 glides and stops normally, channel 2's bend "continues
// along the entire porta region" and never seems to stop).
//
// Root cause: triggerMetaOrNote seeds a metainstrument's foreground voice.noteVal
// from `note + layer0.detune` (trigger.js pitchOf), so the voice's own noteVal
// lives in a coordinate space shifted by that detune — but row.js's G handler
// was writing the pattern's RAW note straight into tonePortaTarget, unshifted.
// The glide then chased a target a whole detune further away than intended,
// so it rarely (if ever) finished before the NEXT G row retargeted it — which
// reads exactly like "the bend never stops".

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { buildMetaRecord, makeMetaLayer } from "../../src/engine/inst.js";
import { EffectOp } from "../../src/engine/tables.js";

setSamplingRate(32000);

/** Engine with a looping ramp sample in slot 1, an octave-down single-layer
 *  metainstrument in slot 2 (layer 0 = slot 1, detune = -0x1000), and an
 *  optional fixed-pitch-layer-0 metainstrument in slot 3. */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 4000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 4000); w16(6, 32000); w16(12, 4000);
  rec[14] = 1;        // forward loop
  rec[21] = 0x3f;     // vol env node 0 = full
  rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);

  const octaveDown = [makeMetaLayer(1, 0xff, -0x1000, 0x0000, 0xffff, 0, 0x3f)];
  eng.uploadInstrument(2, buildMetaRecord(octaveDown));

  const fixedLayer0 = [makeMetaLayer(1, 0xff, 0x5000, 0x0000, 0xffff, 0, 0x3f, true)];
  eng.uploadInstrument(3, buildMetaRecord(fixedLayer0));

  return eng;
}

/** rows: [{row, note, inst, effect, arg}] on channels 0 and 1, uploaded as
 *  patterns 0 and 1 (format v2, 8-byte narrow cells). */
function loadSong(eng, rowsCh0, rowsCh1) {
  const write = (p, c) => {
    const o = c.row * 8;
    if (c.note !== undefined) { p[o] = c.note & 0xff; p[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) p[o + 2] = c.inst;
    if (c.effect !== undefined) { p[o + 5] = c.effect; p[o + 6] = c.arg & 0xff; p[o + 7] = (c.arg >>> 8) & 0xff; }
  };
  const pat0 = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat0[r * 8 + 3] = 0xc0; pat0[r * 8 + 4] = 0xc0; }
  for (const c of rowsCh0) write(pat0, c);
  eng.uploadPattern(0, pat0);
  const pat1 = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat1[r * 8 + 3] = 0xc0; pat1[r * 8 + 4] = 0xc0; }
  for (const c of rowsCh1) write(pat1, c);
  eng.uploadPattern(1, pat1);

  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00; // ch0 -> pattern 0
  cue[2] = 0x01; cue[3] = 0x00; // ch1 -> pattern 1
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
}

function renderTicks(eng, ticks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const spt = (32000 * 2.5) / 125; // samples per tick at bpm 125
  const frames = ticks * spt;
  const chunks = Math.ceil(frames / TRACKER_CHUNK);
  for (let i = 0; i < chunks; i++) eng.renderChunk(0, out);
}

const DETUNE = -0x1000;
const rows = (inst) => [
  { row: 0, note: 0x5c00, inst },
  { row: 2, note: 0x6000, effect: EffectOp.OP_G, arg: 0x0100 },
  { row: 4, note: 0x5c00, effect: EffectOp.OP_G, arg: 0x0100 },
];

test("metainstrument G-chain: foreground stays in lockstep with a plain instrument's, offset by layer 0's own detune", () => {
  const eng = makeEngine();
  loadSong(eng, rows(1), rows(2));
  const ts = eng.playheads[0].trackerState;
  const v0 = ts.voices[0], v1 = ts.voices[1];

  let sawTargetTogether = false, sawStopTogether = false;
  for (let tick = 0; tick < 30; tick++) {
    renderTicks(eng, 1);
    // The whole point of the fix: at every tick, channel 1's noteVal tracks
    // channel 0's by EXACTLY the layer's detune — never drifting off toward
    // an unshifted target.
    assert.equal(v1.noteVal, v0.noteVal + DETUNE,
      `tick ${tick}: meta foreground must stay detune-locked to the plain voice (0x${v0.noteVal.toString(16)} vs 0x${v1.noteVal.toString(16)})`);
    if (v0.tonePortaTarget >= 0 && v1.tonePortaTarget >= 0) sawTargetTogether = true;
    if (v0.tonePortaTarget < 0 && v1.tonePortaTarget < 0) sawStopTogether = true;
  }
  assert.ok(sawTargetTogether, "both voices must have been mid-glide together at some point");
  assert.ok(sawStopTogether, "both voices must have STOPPED (target -1) together — the bug made channel 2 keep chasing");
});

test("a fixed-pitch layer 0 ignores a portamento row's target entirely (its note never tracked the trigger)", () => {
  const eng = makeEngine();
  loadSong(eng, rows(1), rows(3));
  const ts = eng.playheads[0].trackerState;
  const v1 = ts.voices[1];

  // tickRate is 6 ticks/row, so row 2's G fires at tick 12 and row 4's at 24.
  renderTicks(eng, 13); // past row 2's G row
  assert.equal(v1.noteVal, 0x5000, "fixed-pitch layer 0 always sounds its own note");
  assert.equal(v1.tonePortaTarget, -1, "no target: there is nothing for this voice to glide to");

  renderTicks(eng, 12); // past row 4's G row too (cumulative tick 25)
  assert.equal(v1.noteVal, 0x5000, "still the fixed pitch — a G row never moved it");
  assert.equal(v1.tonePortaTarget, -1);
});
