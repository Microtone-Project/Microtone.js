// Targeted regression tests for the historically-subtle engine behaviours
// (see CLAUDE.md porting rules). The corpus conformance covers these end to
// end; these keep them pinned even if the corpus changes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { Voice } from "../../src/engine/voice.js";
import {
  envPoint, buildMetaRecord, makeMetaLayer, makeInstPatch, writePatchesBlob,
  TaudInst,
} from "../../src/engine/inst.js";
import { ghostVoice } from "../../src/engine/trigger.js";
import { advancePitchRamp } from "../../src/engine/sampler.js";
import { applyFilterParamEffect } from "../../src/engine/effects.js";
import {
  advancePfRole, seedPfRole, advanceEnvelope, pfIdxBox, pfTimeBox, applyKeyLift, forceKeyLift,
} from "../../src/engine/envelope.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { loadIntoEngine } from "../../src/audio/offline-render.js";

// Pinned to the Kotlin engine's 32 kHz (item 108 moved the web default to
// 48 kHz): the expectations below are sample counts and reference renders
// taken from AudioAdapter.kt, and they stay diffable against it.
setSamplingRate(32000);

const scratch = new Int32Array(2);

// Render ≈ `samples` frames of playhead 0, chunk-size-agnostic (renderChunk
// always emits exactly TRACKER_CHUNK, so these tests advance by sample count
// rather than counting chunks — output is bit-identical at any TRACKER_CHUNK).
function renderSamples(eng, samples) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const calls = Math.ceil(samples / TRACKER_CHUNK);
  for (let i = 0; i < calls; i++) eng.renderChunk(0, out);
}

function makeTestEngine() {
  const eng = new TaudEngine();
  // Simple looping instrument in slot 1: 1000-byte ramp sample @32 kHz.
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);       // sampleLength
  w16(6, 32000);      // samplingRate @C4
  w16(12, 1000);      // loopEnd
  rec[14] = 1;        // forward loop
  rec[21] = 0x3f;     // vol env node 0 = full — a zeroed env is a value-0
                      // terminator and the Schism cut rule ramps the voice out
                      // instantly (real converter records always fill this)
  rec[171] = 255;     // instGlobalVolume
  rec[196] = 255;     // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  return eng;
}

test("S$Dx note delay fires on a FRESH channel (stale-inst re-bind)", () => {
  const eng = makeTestEngine();
  // Pattern 0 row 0: note C4, inst 1, S $D200 (note delay to tick 2).
  const pat = new Uint8Array(512);
  pat.fill(0);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50;  // note 0x5000
  pat[2] = 1;                    // inst 1
  pat[5] = 0x1c;                 // OP_S
  pat[6] = 0x00; pat[7] = 0xd2;  // arg 0xD200 → S$D2
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;  // ch0 → pattern 0
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);

  const v = eng.playheads[0].trackerState.voices[0];

  renderSamples(eng, 512); // 512 samples < 640/tick — delay tick not reached
  assert.equal(v.active, false, "voice must not sound before the delay tick");

  renderSamples(eng, 3 * 512); // advance through tickInRow=2 → deferred trigger fires
  assert.equal(v.active, true, "delayed note must fire");
  assert.equal(v.instrumentId, 1);
  // The stale-inst bug zeroed playbackRate via instruments[0].samplingRate == 0.
  assert.ok(Math.abs(v.playbackRate - 1.0) < 1e-12, `playbackRate ${v.playbackRate} must be 1.0`);
  assert.ok(v.samplePos > 0, "sample must be advancing on the trigger tick");
});

// item 94: S$Dxny's $n follow-up action, fired $y ticks after the (deferred or
// immediate) trigger — the half of S$Dxny neither engine implemented before
// (Kotlin's applySEffect literally no-ops case 0xD; only the row-level "delay
// to tick $x" existed). One tick-fire event happens per elapsed samplesPerTick
// (= SAMPLING_RATE·2.5/bpm = 640 samples here); tick index k's event lands at
// cumulative sample count (k+1)·640 (see mixer.js generateTrackerAudio).
test("S$Dxny schedules the $n action at tick $x+$y (note cut 2 ticks after a delayed trigger)", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50;  // note 0x5000
  pat[2] = 1;                    // inst 1
  pat[5] = 0x1c;                 // OP_S
  pat[6] = 0x12; pat[7] = 0xd1;  // arg 0xD112 → S$D 1 1 2: delay 1, action 1 (note cut), 2 ticks later
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
  const v = eng.playheads[0].trackerState.voices[0];

  renderSamples(eng, 1024); // < tick1's 1280-sample fire point — still nothing
  assert.equal(v.active, false, "voice must not sound before the delay tick");

  renderSamples(eng, 512); // cumulative 1536: past tick1 (1280), before tick3 (2560)
  assert.equal(v.active, true, "delayed trigger fired");
  assert.equal(v.noteActionTick, 3, "action scheduled at x+y = 1+2");

  renderSamples(eng, 1536); // cumulative 3072: past tick3 (2560)
  assert.equal(v.active, false, "the $n=1 (note cut) follow-up action fired");
  assert.equal(v.noteActionTick, -1, "consumed, not re-armed");
});

test("a note cut RAMPS to silence instead of stepping to it (item 140)", () => {
  // A cut used to drop `active` on the spot: mid-cycle that is a step straight
  // to zero, which clicks. It now fades over the ATTACK ramp's samples.
  //
  // Worth knowing WHY this needs its own test: across the whole corpus the cut
  // ramp engages nine times and the voice is already inactive every one of
  // them, so conformance cannot see this behaviour at all.
  // A DC sample, not makeTestEngine's sawtooth: that one steps by ~0.78 every
  // 100 samples all by itself, which would drown the very edge being measured.
  // With a constant sample every step in the output belongs to the cut.
  const eng = new TaudEngine();
  eng.sampleBin.fill(178, 0, 1000);
  const rec = new Uint8Array(256);
  const w16 = (o, val) => { rec[o] = val & 0xff; rec[o + 1] = (val >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1;        // forward loop
  rec[21] = 0x3f;     // vol env node 0 = full
  rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50;   // row 0: note 0x5000, inst 1 — a loud sustained note
  pat[2] = 1;
  pat[8 * 4] = 0x02; pat[8 * 4 + 1] = 0x00; // row 4: NOTE CUT (0x0002)
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

  const ts = eng.playheads[0].trackerState;
  const v = ts.voices[0];
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const trace = [];
  let ampAtCut = 0;
  // Row 4 lands at 4 rows x 6 ticks x 640 samples = 15360, so render past it.
  let rampAt = -1;
  for (let i = 0; i < 200; i++) {
    eng.renderChunk(0, out);
    if (rampAt < 0 && v.rampOutSamples > 0) rampAt = trace.length;
    for (let k = 0; k < TRACKER_CHUNK; k++) trace.push(ts.mixLeft[k]);
    if (rampAt >= 0 && trace.length > rampAt + 4 * TRACKER_CHUNK) break;
  }
  assert.ok(rampAt > 0, "the cut engaged a ramp at all");

  // Measure the DESCENT ITSELF rather than the whole trace: the fixture loops,
  // and a looping sample has edges of its own that would drown the one edge
  // this test is about.
  let last = trace.length - 1;
  while (last > 0 && Math.abs(trace[last]) < 1e-9) last--;
  ampAtCut = Math.abs(trace[rampAt > 0 ? rampAt - 1 : 0]);
  assert.ok(ampAtCut > 1e-3, `the note must be sounding at the cut (was ${ampAtCut})`);

  // Walk back from silence to the last sample still at full level: that span is
  // the ramp, and a bare cut would have made it one sample long.
  let full = last;
  while (full > 0 && Math.abs(trace[full]) < ampAtCut * 0.9) full--;
  const span = last - full;
  assert.ok(span >= 8, `the cut took ${span} samples to reach silence, not a step`);
  let worst = 0;
  for (let i = full + 1; i <= last + 1 && i < trace.length; i++) {
    const d = Math.abs(trace[i] - trace[i - 1]);
    if (d > worst) worst = d;
  }
  assert.ok(worst < ampAtCut * 0.25,
    `biggest step in the descent ${worst.toFixed(6)} vs level ${ampAtCut.toFixed(6)}`);
  assert.equal(v.active, false, "the voice stopped once the ramp finished");
  const tail = trace.slice(-TRACKER_CHUNK);
  assert.ok(Math.max(...tail.map(Math.abs)) < 1e-6, "…and is silent afterwards");
});

test("pan moves per SAMPLE, not per tick (item 141)", () => {
  // The pan law is evaluated every sample but every input to it moved once a
  // tick, so the gain used to step at each tick boundary — a zipper at the tick
  // rate. Measured as: is the biggest sample-to-sample jump AT a tick boundary
  // bigger than the waveform's own slope elsewhere?
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) {
    eng.sampleBin[i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * i) / 1000));
  }
  const rec = new Uint8Array(256);
  const w16 = (o, val) => { rec[o] = val & 0xff; rec[o + 1] = (val >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  for (let r = 1; r < 64; r++) {            // P $0f00 — pan slide, every row
    pat[r * 8 + 5] = 0x19; pat[r * 8 + 6] = 0x00; pat[r * 8 + 7] = 0x0f;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);

  const ts = eng.playheads[0].trackerState;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const L = [], R = [];
  for (let i = 0; i < 300; i++) {
    eng.renderChunk(0, out);
    for (let k = 0; k < TRACKER_CHUNK; k++) { L.push(ts.mixLeft[k]); R.push(ts.mixRight[k]); }
  }
  const TICK = 640; // SAMPLING_RATE * 2.5 / bpm at 32 kHz, BPM 125
  let onTick = 0, offTick = 0;
  for (let i = 4001; i < L.length; i++) {
    const d = Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
    if (i % TICK <= 1 || i % TICK >= TICK - 1) { if (d > onTick) onTick = d; }
    else if (d > offTick) offTick = d;
  }
  assert.ok(offTick > 0, "the voice was sounding");
  assert.ok(onTick < offTick * 1.5,
    `tick boundaries step ${(onTick / offTick).toFixed(1)}x the waveform's own slope`);
});

test("pitch is interpolated per sample, not held for a tick (item 141)", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  for (let r = 1; r < 64; r++) {            // H $0f0f — fast, deep vibrato
    pat[r * 8 + 5] = 0x11; pat[r * 8 + 6] = 0x0f; pat[r * 8 + 7] = 0x0f;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const v = eng.playheads[0].trackerState.voices[0];
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const rate = [];
  for (let i = 0; i < 80; i++) { eng.renderChunk(0, out); rate.push(v.currentPlaybackRate); }

  const span = Math.max(...rate) - Math.min(...rate);
  assert.ok(span > 0, "the vibrato moved the pitch at all");
  // A staircase visits one value per tick and holds it: ~16 distinct values over
  // these 80 probes, with jumps a large fraction of the whole excursion.
  const distinct = new Set(rate.map((x) => x.toFixed(6))).size;
  assert.ok(distinct > 25, `only ${distinct} distinct rates — still a staircase`);
  let jump = 0;
  for (let i = 1; i < rate.length; i++) jump = Math.max(jump, Math.abs(rate[i] - rate[i - 1]));
  assert.ok(jump < span * 0.25, `biggest jump is ${((100 * jump) / span).toFixed(0)}% of the excursion`);
});

test("the pitch glide spends (interval × time), not time (item 144)", () => {
  // How many calls it takes the glide to arrive, driving the ramp directly.
  const glideSamples = (cents, spt = 640) => {
    const v = new Voice();
    v.snapPlaybackRate = false;
    v.currentPlaybackRate = 1.0;
    v.playbackRate = 2 ** (cents / 1200);
    let n = 0;
    while (v.currentPlaybackRate !== v.playbackRate && n < spt * 4) { advancePitchRamp(v, spt); n++; }
    return n;
  };
  // A control-sized move — vibrato, an ordinary slide — still gets the whole tick.
  assert.equal(glideSamples(1), 640);
  assert.equal(glideSamples(25), 640);
  // Past the budget the glide shortens in proportion, so an EVENT lands at once:
  // a 2-semitone portamento arrival in 2.4 ms, an arpeggio's third in 1.1 ms.
  assert.equal(glideSamples(200), 76);
  assert.equal(glideSamples(400), 36);
  // …down to the attack ramp's floor (21 samples at this 32 kHz), never to zero:
  // the corner still gets rounded off however wide the jump.
  assert.equal(glideSamples(4800), 21);
  assert.equal(glideSamples(-4800), 21);
  // A fall costs what the rise back up costs — the interval is read the way up
  // whichever way it goes.
  assert.equal(glideSamples(-200), glideSamples(200));
  // Rate-independent in TIME: half the tick, half the samples, same milliseconds.
  assert.equal(glideSamples(200, 320), 38);
});

test("a fast tone portamento ARRIVES; it does not bend across the tick (item 144)", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  for (let r = 1; r < 64; r++) {            // whole tones up, each on G $1400
    const note = 0x5000 + r * 683;
    pat[r * 8] = note & 0xff; pat[r * 8 + 1] = (note >> 8) & 0xff;
    pat[r * 8 + 5] = 0x10; pat[r * 8 + 6] = 0x00; pat[r * 8 + 7] = 0x14;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  // 137 BPM makes a tick 583.94 samples — NOT a whole number of 128-sample
  // chunks, so the probes below walk through the tick instead of landing on the
  // same phase of it every time, and count time in transit fairly.
  eng.setBPM(0, 137); eng.setTickRate(0, 3); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const v = eng.playheads[0].trackerState.voices[0];
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let inTransit = 0, moved = 0;
  const probes = 300;
  for (let i = 0; i < probes; i++) {
    eng.renderChunk(0, out);
    if (Math.abs(1200 * Math.log2(v.currentPlaybackRate / v.playbackRate)) > 5) inTransit++;
    moved = Math.max(moved, 1200 * Math.log2(v.playbackRate));
  }
  assert.ok(moved > 1000, "the portamento climbed at all");
  // The arrival is one whole tone, so it may glide for 25/200 of a tick out of
  // the three a row lasts — 4% of the time. A tick-long glide is 33%.
  const share = (100 * inTransit) / probes;
  assert.ok(share < 15, `pitch is in transit ${share.toFixed(0)}% of the row — that is a bend`);
});

test("arpeggio steps between pitches instead of wobbling between them (item 144)", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  for (let r = 0; r < 64; r++) {            // J $0509 — the major-chord arpeggio
    pat[r * 8 + 5] = 0x13; pat[r * 8 + 6] = 0x09; pat[r * 8 + 7] = 0x05;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 137); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255); // see above
  eng.setCuePosition(0, 0); eng.play(0);
  const v = eng.playheads[0].trackerState.voices[0];
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const seen = new Set();
  let inTransit = 0;
  const probes = 300;
  for (let i = 0; i < probes; i++) {
    eng.renderChunk(0, out);
    if (Math.abs(1200 * Math.log2(v.currentPlaybackRate / v.playbackRate)) > 5) inTransit++;
    seen.add((1200 * Math.log2(v.playbackRate)).toFixed(0));
  }
  assert.equal(seen.size, 3, "the arpeggio visited its three pitches");
  // A new pitch EVERY tick, so a tick-long glide never settles: 100% in transit,
  // which is the wobble. 25 cents' worth of a ~400-cent step is 6%.
  const share = (100 * inTransit) / probes;
  assert.ok(share < 15, `pitch is in transit ${share.toFixed(0)}% of the time — that is a wobble`);
});

test("S$Dxny: a zero $y schedules no action at all", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  pat[5] = 0x1c; pat[6] = 0x10; pat[7] = 0xd1; // arg 0xD110: delay 1, n=1, y=0
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  const v = eng.playheads[0].trackerState.voices[0];

  renderSamples(eng, 1536); // past the delayed trigger (tick1 @1280)
  assert.equal(v.active, true, "delayed trigger still fires");
  assert.equal(v.noteActionTick, -1, "y=0 never arms a follow-up action");

  renderSamples(eng, 3200); // well past where a stray action could have fired
  assert.equal(v.active, true, "nothing came along to cut it");
});

// item 97: FastTracker Kxx has no note column entry of its own — it acts on
// whatever note is already sounding. TAUD_NOTE_EFFECTS.md's compat note
// ("Kxx maps to S $D00xx") only works if the $n action can arm on a
// note-less row; previously scheduleDxnyAction was only ever called from the
// note-bearing branches (row.js note===0x0000 skipped it entirely).
test("S$Dxny's $n action arms on a note-less row (Kxx-style deferred key-off)", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50;  // row0: note 0x5000
  pat[2] = 1;                    // inst 1
  // row1: no note, S $D002 (x=0, n=0 note-off, y=2) — the Kxx idiom.
  pat[8 + 5] = 0x1c;             // OP_S
  pat[8 + 6] = 0x02; pat[8 + 7] = 0xd0; // arg 0xD002
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
  const v = eng.playheads[0].trackerState.voices[0];

  renderSamples(eng, 5500); // past row0's trigger, before row1 tick2's 5760-sample fire point
  assert.equal(v.active, true, "note from row0 still sounding");
  assert.equal(v.keyOff, false, "row1 tick2 hasn't fired yet");
  assert.equal(v.noteActionTick, 2, "armed at x+y = 0+2 even with no note on row1");

  renderSamples(eng, 700); // cumulative 6200: past row1 tick2 (5760)
  assert.equal(v.keyOff, true, "the $n=0 (note off) action fired on the currently-sounding voice");
  assert.equal(v.noteActionTick, -1, "consumed, not re-armed");
});

test("applyKeyLift respects the instrument's Key-Lift flag; forceKeyLift (S$Dxny n=4) bypasses it", () => {
  const sustainWord = (1 << 8) | 3 | 0x20; // enable, start=1, end=3
  const makeVoice = () => { const v = new Voice(); v.activeVolEnvSustain = sustainWord; return v; };

  const vOff = makeVoice();
  applyKeyLift(vOff, { nnaKeyLift: false });
  assert.equal(vOff.envIndex, 0, "flag OFF: applyKeyLift (S$Dxny n=0 / '===') is a no-op");

  const vOn = makeVoice();
  applyKeyLift(vOn, { nnaKeyLift: true });
  assert.equal(vOn.envIndex, 3, "flag ON: applyKeyLift jumps to the sustain-end node");

  const vForced = makeVoice();
  forceKeyLift(vForced);
  assert.equal(vForced.envIndex, 3, "forceKeyLift jumps regardless of the instrument's flag");
});

test("advancePfRole SKIPS zero-duration nodes; seedPfRole settles past them", () => {
  // Node 0: instant (offset 0) value 0 → node 1: value 200 over ~0.25 s.
  const env = new Array(25);
  for (let i = 0; i < 25; i++) env[i] = envPoint(220, 0);
  env[0] = envPoint(0, 0);     // zero-duration attack node
  env[1] = envPoint(200, 64);  // minifloat idx 64 = 0.25 s
  env[2] = envPoint(220, 64);

  const seed = seedPfRole(env, 0x2000 /* P bit only */, 0);
  assert.equal(pfIdxBox[0], 1, "seed must settle past the zero-duration node");
  assert.ok(Math.abs(seed - 200 / 255) < 1e-12, "seed value is node 1's, not node 0's");

  // A fresh walk from index 0 must also skip, not freeze at node 0.
  pfIdxBox[0] = 0;
  pfTimeBox[0] = 0.0;
  const v = advancePfRole(env, 0x2000, 0, false, 0.012, scratch, pfIdxBox, pfTimeBox);
  assert.equal(pfIdxBox[0], 1);
  assert.ok(v > 200 / 255 - 1e-9, "walker moved onto the node-1 segment");
});

test("vol/pan walker FREEZES on zero-offset nodes (IT terminator semantics)", () => {
  const v = new Voice();
  v.activeVolEnv = new Array(25);
  for (let i = 0; i < 25; i++) v.activeVolEnv[i] = envPoint(63, 0);
  v.activeVolEnv[0] = envPoint(32, 0); // terminator at node 0
  v.activeVolEnvLoop = 0x2000;
  v.activeVolEnvSustain = 0;
  v.envIndex = 0;
  advanceEnvelope(v, 0.05);
  advanceEnvelope(v, 0.05);
  assert.equal(v.envIndex, 0, "vol env must hold at the terminator");
  assert.ok(Math.abs(v.envVolume - 32 / 63) < 1e-12);
});

test("ghostVoice copies SF2 biquad state and the active-envelope view", () => {
  const src = new Voice();
  src.active = true;
  src.filterIsBiquad = true;
  src.filterSfMode = true;
  src.filterBqB02 = 0.123;
  src.filterBqB1 = 0.456;
  src.filterBqA1 = -0.7;
  src.filterBqA2 = 0.2;
  src.filterX1 = 0.9;
  src.filterX2 = -0.4;
  src.filterY1 = 0.11;
  src.filterY2 = -0.22;
  src.activeFadeoutStep = 777;
  src.activeDefaultCutoff = 13500;
  src.activeAttenGain = 0.5;
  const customEnv = new Array(25);
  for (let i = 0; i < 25; i++) customEnv[i] = envPoint(i, 1);
  src.activeVolEnv = customEnv;
  src.activeVolEnvSustain = 0x1234;

  const g = ghostVoice(src, 3);
  assert.equal(g.sourceChannel, 3);
  assert.equal(g.filterIsBiquad, true);
  assert.equal(g.filterSfMode, true);
  assert.equal(g.filterBqB02, 0.123);
  assert.equal(g.filterBqB1, 0.456);
  assert.equal(g.filterBqA1, -0.7);
  assert.equal(g.filterBqA2, 0.2);
  assert.equal(g.filterX1, 0.9);
  assert.equal(g.filterX2, -0.4);
  assert.equal(g.filterY1, 0.11);
  assert.equal(g.filterY2, -0.22);
  assert.equal(g.activeFadeoutStep, 777);
  assert.equal(g.activeDefaultCutoff, 13500);
  assert.equal(g.activeAttenGain, 0.5);
  assert.strictEqual(g.activeVolEnv, customEnv, "env view is shared by reference");
  assert.equal(g.activeVolEnvSustain, 0x1234);
});

test("dither stream is deterministic across engine instances", () => {
  const render = () => {
    const eng = makeTestEngine();
    const pat = new Uint8Array(512);
    pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
    for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
    eng.uploadPattern(0, pat);
    const cue = new Uint8Array(64);
    for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
    cue[0] = 0;
    eng.uploadCue(0, cue);
    eng.setMasterVolume(0, 255);
    eng.play(0);
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    const all = new Uint8Array(TRACKER_CHUNK * 2 * 8);
    for (let i = 0; i < 8; i++) { eng.renderChunk(0, out); all.set(out, i * TRACKER_CHUNK * 2); }
    return all;
  };
  assert.deepEqual(render(), render());
});

test("renderPitch display tap: follows arpeggio per tick; noteVal stays at base", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50;   // note 0x5000
  pat[2] = 1;                     // inst 1
  pat[5] = 0x13;                  // OP_J arpeggio
  pat[6] = 0x04; pat[7] = 0x03;   // arg 0x0304 → arpOff1=3, arpOff2=4 semitones
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);

  const v = eng.playheads[0].trackerState.voices[0];
  const SPT = 640; // samples/tick at bpm 125 (32000*2.5/125)
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    renderSamples(eng, SPT); // advance ~one arp tick, chunk-size-agnostic
    seen.add(v.renderPitch);
    assert.equal(v.noteVal, 0x5000, "base noteVal never moves under arpeggio");
  }
  // The arp overlay shifts the SOUNDING pitch off the base on some ticks.
  assert.ok([...seen].some((p) => p !== 0x5000), "renderPitch deviates from base per tick");
  assert.ok(seen.size >= 2, "renderPitch varies across ticks");
});

test("setTrackerRow clears NNA ghosts + transient state (no lingering notes on replay)", () => {
  const eng = makeTestEngine();
  const ts = eng.playheads[0].trackerState;
  // Simulate a prior playback that left state behind: an active foreground
  // voice, a lingering NNA background ghost, a pattern-delay block, a pending
  // interrupt, a stale row jump.
  ts.voices[3].active = true;
  const ghost = new Voice();
  ghost.active = true;
  ts.backgroundVoices.push(ghost);
  ts.patternDelayActive = true;
  ts.patternDelayRemaining = 4;
  ts.sexWinningChannel = 7;
  ts.finePatternDelayExtra = 2;
  ts.pendingInterrupts = 0b101;
  ts.pendingRowJump = 12;
  ts.pendingRowJumpLocal = true;
  // Leftover pattern-loop + Ditto (effect 7) memory from the prior play (item 44).
  ts.voices[3].dittoActive = true;
  ts.voices[3].dittoSourceStart = 4; ts.voices[3].dittoLength = 2; ts.voices[3].dittoEndRow = 10;
  ts.voices[5].loopStartRow = 8; ts.voices[5].loopCount = 3;

  eng.setTrackerRow(0, 0);

  assert.equal(ts.voices[3].active, false, "foreground voice silenced");
  assert.equal(ts.backgroundVoices.length, 0, "NNA ghosts dropped");
  assert.equal(ts.patternDelayActive, false);
  assert.equal(ts.patternDelayRemaining, 0);
  assert.equal(ts.sexWinningChannel, -1);
  assert.equal(ts.finePatternDelayExtra, 0);
  assert.equal(ts.pendingInterrupts, 0);
  assert.equal(ts.pendingRowJump, -1);
  assert.equal(ts.pendingRowJumpLocal, false);
  // item 44: ditto + loop status cleared so effects don't linger on replay.
  assert.equal(ts.voices[3].dittoActive, false, "ditto cleared");
  assert.equal(ts.voices[3].dittoSourceStart, 0);
  assert.equal(ts.voices[3].dittoLength, 0);
  assert.equal(ts.voices[3].dittoEndRow, 0);
  assert.equal(ts.voices[5].loopStartRow, 0, "S$Bx loop start cleared");
  assert.equal(ts.voices[5].loopCount, 0, "S$Bx loop count cleared");
});

// item 51: auditioning a strict metainstrument snaps to a note it can sound.
test("jamNote audition finds an in-range note for a strict metainstrument", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  // meta $4 is strict; at 0x5000 its layers' Ixmp zones don't cover the note.
  const inst = eng.instruments[4];
  assert.ok(inst.isMeta && inst.metaStrict, "meta $4 is a strict metainstrument");
  assert.ok(!eng._metaSoundsAt(inst, 0x5000), "silent at 0x5000 without audition");

  const jam = (audition) => {
    eng.stop(0);
    const ts = eng.playheads[0].trackerState;
    for (const v of ts.voices) v.active = false;
    ts.backgroundVoices.length = 0;
    eng.jamNote(0, 0, 0x5000, 4, audition);
    return ts.voices[0].active || ts.backgroundVoices.some((b) => b.active);
  };
  assert.equal(jam(false), false, "note-entry jam stays silent (exact pitch)");
  assert.equal(jam(true), true, "audition jam retries at an in-range note → sounds");
  // The chosen alternative note actually sounds.
  const alt = eng._auditionNoteFor(4, 0x5000);
  assert.ok(alt >= 0 && eng._metaSoundsAt(inst, alt), "audition note sounds");
});

// item 45: muting a channel silences its layer children / NNA ghosts too.
test("channel mute covers metainstrument layer children (background voices)", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  const ts = eng.playheads[0].trackerState;
  const rms = () => {
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let sum = 0, n = 0;
    for (let c = 0; c < 30; c++) { eng.renderChunk(0, out); for (let i = 0; i < out.length; i++) { const d = out[i] - 128; sum += d * d; n++; } }
    return Math.sqrt(sum / n);
  };
  const jam = () => {
    eng.stop(0);
    for (const v of ts.voices) v.active = false;
    ts.backgroundVoices.length = 0;
    eng.jamNote(0, 0, 0x50ab, 6); // meta $6 fans out ≥1 layer child onto ch 0
  };
  jam();
  assert.ok(ts.backgroundVoices.length >= 1, "meta $6 spawns a background layer child");
  const loud = rms();
  assert.ok(loud > 1, "sounds while unmuted");

  jam();
  eng.setVoiceMute(0, 0, true); // mute channel 0 (foreground + its children)
  const muted = rms();
  assert.ok(muted < loud * 0.05, `muted RMS ${muted.toFixed(2)} ≪ ${loud.toFixed(2)} (layer child silenced too)`);
});

// item 43: note 0 + instrument + a pitch effect (E/F/G) re-triggers the note.
test("note0 + inst + Fx F triggers the note at the current pitch (item 43)", () => {
  const eng = new TaudEngine();
  // Short NON-looping sample so the row-0 note ends before row 1.
  for (let i = 0; i < 200; i++) eng.sampleBin[i] = 128 + 40;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 200); w16(6, 32000); rec[14] = 0; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;                       // row 0: C4, inst 1
  pat[8 + 2] = 1; pat[8 + 5] = 0x0f; pat[8 + 6] = 0x01; pat[8 + 7] = 0x01; // row 1: note 0, inst 1, F 0101
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0; // ch0 → pattern 0
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const v = eng.playheads[0].trackerState.voices[0];
  renderSamples(eng, 3072); // still within row 0 (< 6 ticks = 3840): the 200-frame note has ended
  assert.equal(v.active, false, "short row-0 note ended, voice idle");
  assert.ok(v.noteVal >= 0x20, "voice remembers the last note");
  renderSamples(eng, 1024);  // cross into row 1 (sample 3840)
  assert.equal(v.active, true, "note0 + inst + F re-triggered the note");
  assert.equal(v.instrumentId, 1);
  assert.ok(v.samplePos < 200, "re-triggered from the sample start");
});

// Timeline header: a metainstrument voice reports the META slot (what the
// pattern shows), not the layer child it resolves to (displayInst).
test("getVoiceInstrument reports the metainstrument slot, not the layer child", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  eng.jamNote(0, 0, 0x50ab, 6); // meta $6 sounds here; foreground = its layer-0 child
  const v = eng.playheads[0].trackerState.voices[0];
  assert.ok(v.active, "meta foreground voice is active");
  assert.equal(eng.instruments[6].isMeta, true, "slot 6 is a metainstrument");
  assert.notEqual(v.instrumentId, 6, "instrumentId resolved to a sub-instrument");
  assert.equal(eng.getVoiceInstrument(0, 0), 6, "header shows the meta slot $06");

  // A plain instrument still reports itself.
  eng.jamStop(0);
  const plain = eng.usedInstrumentSlots?.().find?.(() => false);
  let plainSlot = 0;
  for (let s = 1; s < 256; s++) { const i = eng.instruments[s]; if (i && !i.isMeta && i.sampleLength > 0) { plainSlot = s; break; } }
  eng.jamNote(0, 1, 0x5000, plainSlot);
  assert.equal(eng.getVoiceInstrument(0, 1), plainSlot, "plain instrument reports itself");
});

// bug #65: the Samples/Instruments editor preview must play the EXACT pooled
// sample on screen, not whatever a metainstrument would map C4 to. jamSample
// bypasses all instrument/zone resolution via a scratch AUDITION_SLOT.
test("jamSample previews the exact pooled sample, bypassing metainstrument zones (bug #65)", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  assert.ok(eng.instruments[6].isMeta, "slot 6 is a metainstrument");

  // A real pooled sample owned by one of the meta's layer children — exactly
  // the kind of sample the Samples view lists and the census attributes to a
  // metainstrument (so the old jamNote(slot) preview mis-resolved it at C4).
  let target = null;
  for (const l of eng.instruments[6].metaLayers) {
    const child = eng.instruments[l.instIdx & 0x3ff];
    if (child && !child.isMeta && child.sampleLength > 0) {
      target = { ptr: child.samplePtr, len: child.sampleLength, rate: child.samplingRate,
        playStart: 0, loopStart: child.sampleLoopStart, loopEnd: child.sampleLoopEnd,
        loopMode: child.loopMode };
      break;
    }
  }
  assert.ok(target, "found a layer-child sample to preview");

  // jamSample plays that exact region on the top channel regardless of the bank.
  const vi = 5;
  eng.jamSample(0, vi, 0x5000, target);
  const v = eng.playheads[0].trackerState.voices[vi];
  assert.ok(v.active, "audition voice is active");
  assert.equal(v.activeSamplePtr, target.ptr, "plays the exact sample ptr");
  assert.equal(v.activeSampleLength, target.len, "plays the exact sample length");
  // The scratch slot never disturbs a real bank slot.
  assert.equal(v.instrumentId, 1024, "audition plays through the reserved scratch slot");

  // Renders end-to-end through the reserved AUDITION_SLOT — proves the extended
  // instruments array is safe in the tick/mixer hot paths.
  renderSamples(eng, 256);
  assert.ok(v.samplePos > 0, "audition sample advanced");

  eng.jamStop(0);
  assert.equal(v.active, false, "jamStop ends the audition");
});

// item 140: the jam bank sits above every addressable channel, so the desk
// cannot mute an audition and one released key of a chord cannot take the
// others (or the song) with it.
test("item 140: the jam bank plays through a muted desk and releases per voice", () => {
  const eng = makeTestEngine();
  eng.setMasterVolume(0, 255);
  for (let ch = 0; ch < 64; ch++) eng.setVoiceMute(0, ch, true);

  const v0 = eng.jamVoice(0), v1 = eng.jamVoice(1);
  assert.ok(v0 >= 64 && v1 >= 64 && v0 !== v1, "bank voices are not channels");
  eng.jamNote(0, v0, 0x5000, 1);
  eng.jamNote(0, v1, 0x5100, 1);
  const ts = eng.playheads[0].trackerState;
  assert.ok(ts.voices[v0].active && ts.voices[v1].active, "both chord notes sound");
  assert.equal(ts.voices[v0].fader, 0, "a bank voice carries no desk fader");

  const out = new Uint8Array(TRACKER_CHUNK * 2);
  eng.renderChunk(0, out);
  let peak = 0;
  for (const b of out) peak = Math.max(peak, Math.abs(b - 128));
  assert.ok(peak > 8, `audible with every channel muted (peak ${peak})`);

  // One key up: its voice ramps out (a cut ramp, not a step), the other holds.
  eng.jamStopVoice(0, v0);
  renderSamples(eng, TRACKER_CHUNK);
  assert.equal(ts.voices[v0].active, false, "the released key stopped");
  assert.ok(ts.voices[v1].active, "the held key is still sounding");

  // Focus loss clears the whole bank in one call.
  eng.jamStopVoice(0, -1);
  renderSamples(eng, TRACKER_CHUNK);
  assert.equal(ts.voices[v1].active, false, "the bank is empty");
});

test("item 140: playback never writes to the jam bank", () => {
  const eng = makeTestEngine();
  // Every channel plays a note every row; the bank must stay untouched.
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) {
    pat[r * 8] = 0x00; pat[r * 8 + 1] = 0x50; pat[r * 8 + 2] = 1;
    pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0; cue[ch * 2 + 1] = 0; }
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  renderSamples(eng, 8192);
  const ts = eng.playheads[0].trackerState;
  assert.ok(ts.voices[0].active, "the song is playing");
  for (let v = 64; v < ts.voices.length; v++) {
    assert.equal(ts.voices[v].active, false, `bank voice ${v} untouched by playback`);
  }

  // …and jamming ALONG with the song neither steals a channel nor — on the
  // release — cuts it, which is what the old whole-playhead jamStop did.
  const jv = eng.jamVoice(0);
  eng.jamNote(0, jv, 0x5000, 1);
  eng.jamStopVoice(0, jv);
  renderSamples(eng, TRACKER_CHUNK);
  for (let ch = 0; ch < 32; ch++) {
    assert.ok(ts.voices[ch].active, `channel ${ch} still sounding after a jam release`);
  }
});

// ── a stopped transport owns no sounding voice ─────────────────────────────
// Stopping only cleared isPlaying, and the mixer runs while isPlaying OR
// jamActive — so the song's voices sat frozen mid-note, and the next thing to
// turn the mix back on inherited them: jamming a key after Stop revived the
// whole chord the stop had cut, and a Stop pressed while an audition rang kept
// the song playing for ever (nothing goes silent, so jamActive never clears).

/** Engine + a 4-channel song on cue 0 (`haltAfter` rows ⇒ the cue halts). */
function makeSongEngine(haltAfter = 0) {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) {
    pat[r * 8] = 0x00; pat[r * 8 + 1] = 0x50; pat[r * 8 + 2] = 1;
    pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  for (let ch = 0; ch < 4; ch++) { cue[ch * 2] = 0; cue[ch * 2 + 1] = 0; }
  if (haltAfter > 0) {
    // Instruction word 0 = "halt at row x" ($01, $40|x), carried in bit 15 of
    // the first 16 channel words — bit k of the word lives on channel k.
    const w = 0x0100 | 0x40 | (haltAfter & 0x3f);
    for (let k = 0; k < 16; k++) {
      if ((w >>> k) & 1) { cue[k * 2] |= 0xff; cue[k * 2 + 1] |= 0x80; }
    }
  }
  eng.uploadCue(0, cue);
  eng.setBPM(0, 535); eng.setTickRate(0, 1); eng.setMasterVolume(0, 255);
  eng.setSongGlobalVolume(0, 255); eng.setSongMixingVolume(0, 255);
  eng.setCuePosition(0, 0); eng.setTrackerRow(0, 0);
  return eng;
}

/** Peak deviation from silence over one rendered chunk. */
function renderPeak(eng) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  eng.renderChunk(0, out);
  let peak = 0;
  for (const b of out) peak = Math.max(peak, Math.abs(b - 128));
  return peak;
}

test("Stop ends the song's voices, so a later jam revives nothing", () => {
  const eng = makeSongEngine();
  const ts = eng.playheads[0].trackerState;
  eng.play(0);
  renderSamples(eng, 4096);
  assert.ok(ts.voices[0].active, "premise: the song is sounding");

  eng.stop(0);
  for (let ch = 0; ch < 4; ch++) {
    assert.equal(ts.voices[ch].active, false, `channel ${ch} ended with the stop`);
  }
  assert.equal(ts.backgroundVoices.some((b) => b.active), false, "…NNA ghosts too");

  // Jam a key with the bank voice muted: what is left in the mix is whatever
  // the stop failed to end, and there must be none of it.
  const jv = eng.jamVoice(0);
  eng.jamNote(0, jv, 0x5000, 1);
  ts.voices[jv].fader = 255;
  const peak = renderPeak(eng);
  assert.ok(peak <= 1, `nothing but the dither floor comes back (peak ${peak})`);
  for (let ch = 0; ch < 4; ch++) assert.equal(ts.voices[ch].active, false);

  // The silencing does not outlive the stop: the delegate's own jam-on-a-song-
  // channel (what the Kotlin device does — see JAM_VOICES) still sounds.
  eng.jamNote(0, 1, 0x5000, 1);
  assert.ok(renderPeak(eng) > 8, "a channel jam after the stop is audible");
  renderSamples(eng, TRACKER_CHUNK);
  assert.ok(ts.voices[1].active, "…and sustains — it is a note, not a leftover to cut");
});

test("Stop stops the song even while an audition is sounding", () => {
  const eng = makeSongEngine();
  const ph = eng.playheads[0];
  const ts = ph.trackerState;
  eng.play(0);
  renderSamples(eng, 4096);
  const jv = eng.jamVoice(0);
  eng.jamNote(0, jv, 0x5000, 1); // a key held down while the song plays
  renderSamples(eng, TRACKER_CHUNK);

  eng.stop(0);
  renderSamples(eng, TRACKER_CHUNK); // the audition's mix is still running
  for (let ch = 0; ch < 4; ch++) {
    assert.equal(ts.voices[ch].active, false, `channel ${ch} ramped out on the stop`);
  }
  assert.ok(ts.voices[jv].active, "the held key is untouched — the bank is not the song's");
  assert.ok(ph.jamActive, "…so the jam render is still on");

  eng.jamStopVoice(0, -1); // key up
  renderSamples(eng, TRACKER_CHUNK * 2);
  assert.equal(ph.jamActive, false, "and now the render spin ends");
});

test("a halt cue leaves nothing frozen behind either", () => {
  const eng = makeSongEngine(2); // cue 0 halts after 2 rows
  const ts = eng.playheads[0].trackerState;
  eng.play(0);
  for (let i = 0; i < 64 && eng.isPlaying(0); i++) renderSamples(eng, TRACKER_CHUNK);
  assert.equal(eng.isPlaying(0), false, "premise: the cue halted playback");
  for (let ch = 0; ch < 4; ch++) {
    assert.equal(ts.voices[ch].active, false, `channel ${ch} ended with the halt`);
  }
  assert.equal(ts.backgroundVoices.some((b) => b.active), false, "…NNA ghosts too");
});

test("item 72: a buildMetaRecord metainstrument sounds both layers", () => {
  const eng = makeTestEngine();
  // A second sounding instrument in slot 2 (same shape as slot 1's ramp).
  const rec2 = new Uint8Array(256);
  const w16 = (o, v) => { rec2[o] = v & 0xff; rec2[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec2[14] = 1; rec2[21] = 0x3f; rec2[171] = 255; rec2[196] = 255;
  eng.uploadInstrument(2, rec2);

  // Slot 3 = a meta layering $01 (foreground) and $02 (background child), the
  // exact record planCreateMeta writes — full rect, unity mix, no detune.
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));
  assert.equal(eng.instruments[3].isMeta, true);

  eng.setMasterVolume(0, 255);
  eng.jamNote(0, 0, 0x5000, 3);
  const ts = eng.playheads[0].trackerState;
  // The foreground voice resolves to layer 0's child instrument; layer 1 spawns
  // a background voice (trigger.js triggerMetaOrNote).
  assert.equal(ts.voices[0].active, true);
  assert.equal(ts.voices[0].instrumentId, 1);
  assert.equal(ts.voices[0].displayInst, 3, "the header shows the meta's slot");
  assert.equal(ts.backgroundVoices.filter((v) => v.active && v.instrumentId === 2).length, 1);

  const out = new Uint8Array(TRACKER_CHUNK * 2);
  eng.renderChunk(0, out);
  assert.ok(out.some((b) => b !== 128), "the meta must produce audio");
});

// Item 113: LINKED layers — several layers of one meta pointing at the SAME
// sub-instrument, which is how a unison/chord stack is built ("three pianos"
// off one editable piano). Nothing in the trigger path keys on instIdx, so the
// three voices must coexist: applyDuplicateCheck is only ever called with the
// PATTERN's instrument byte (the meta's slot), never per layer, so a DCT of
// "same instrument" can't make the siblings cut each other.
test("item 113: three layers on ONE sub-instrument sound as three detuned voices", () => {
  const eng = makeTestEngine(); // looping inst in slot 1
  eng.instruments[1].dupCheckFlag = 0x03;   // DCT "same instrument" — the worst case
  eng.instruments[1].instrumentFlag = 0x02; // NNA continue

  const third = Math.round((4096 * 4) / 12); // +4 semitones in 4096-TET
  const fifth = Math.round((4096 * 7) / 12); // +7
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(1, 159, third, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(1, 159, fifth, 0x0000, 0xffff, 0, 63),
  ]));
  assert.equal(eng.instruments[3].metaLayers.length, 3, "duplicate instIdx is legal");

  eng.setMasterVolume(0, 255);
  eng.jamNote(0, 0, 0x5000, 3);
  const ts = eng.playheads[0].trackerState;
  const kids = ts.backgroundVoices.filter((v) => v.active && v.isLayerChild);
  assert.equal(kids.length, 2, "layers 1-2 spawn background children");
  assert.equal(ts.voices[0].active, true, "layer 0 is the foreground voice");
  assert.equal(ts.voices[0].instrumentId, 1);

  // All three sound the SAME sub-instrument at three pitches.
  assert.ok(kids.every((v) => v.instrumentId === 1));
  assert.deepEqual(kids.map((v) => v.noteVal).sort((a, b) => a - b),
    [0x5000 + third, 0x5000 + fifth], "children carry their layer's detune");
  assert.deepEqual(kids.map((v) => v.layerRelDetune).sort((a, b) => a - b), [third, fifth],
    "relative detune is measured from the foreground layer");
  assert.ok(kids.every((v) => v.displayInst === 3), "the header still shows the meta");

  const out = new Uint8Array(TRACKER_CHUNK * 2);
  eng.renderChunk(0, out);
  assert.ok(out.some((b) => b !== 128), "the stack must produce audio");
});

// item 81: starting playback mid-pattern on a ghosted (Pattern-Ditto, effect 7)
// row must SOUND — setTrackerRow re-arms the ditto region so the ghost row
// re-derives its inherited note, instead of the engine seeing no active ditto
// (the arm row was seeked past) and playing the empty raw cell.
test("mid-pattern seek onto a ditto ghost row re-arms + sounds it (item 81)", () => {
  const eng = makeTestEngine(); // looping inst in slot 1
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;                 // row 0: C4 (0x5000), inst 1
  pat[8 + 5] = 0x07; pat[8 + 6] = 0x04; pat[8 + 7] = 0x01;  // row 1: OP_7 arg 0x0104 (len 1, rep 4)
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0; // ch0 → pattern 0
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);

  // Seek onto row 3 — a pure ghost (the arm at row 1 covers rows 1..4, srcRow 0).
  eng.setCuePosition(0, 0);
  eng.setTrackerRow(0, 3);
  const ts = eng.playheads[0].trackerState;
  const v = ts.voices[0];
  assert.equal(v.dittoActive, true, "ditto re-armed on the mid-pattern seek");
  assert.equal(v.dittoSourceStart, 0);
  assert.equal(v.dittoLength, 1);
  assert.equal(v.dittoEndRow, 4);

  eng.play(0);
  renderSamples(eng, 512); // process row 3's first tick
  assert.equal(v.active, true, "the ghost row triggers the note");
  assert.equal(v.noteVal, 0x5000, "it sounds the ditto SOURCE note (C4)");

  // Control: seeking PAST the ditto region (row 5 > endRow 4) onto an empty row
  // must NOT trigger — the reconstruction sets state, it doesn't over-play.
  const eng2 = makeTestEngine();
  eng2.uploadPattern(0, pat);
  eng2.uploadCue(0, cue);
  eng2.setBPM(0, 125); eng2.setTickRate(0, 6); eng2.setMasterVolume(0, 255);
  eng2.setCuePosition(0, 0);
  eng2.setTrackerRow(0, 5);
  const v2 = eng2.playheads[0].trackerState.voices[0];
  assert.equal(v2.dittoActive, true, "arm still detected");
  assert.equal(v2.dittoEndRow, 4, "but its coverage ended at row 4");
  eng2.play(0);
  renderSamples(eng2, 512);
  assert.equal(v2.active, false, "empty row past the ditto stays silent");
});

// ── Item 116: Ixmp per-patch overrides ──────────────────────────────────────
// A patch's `default pan` (common byte 24) carries its own "no override"
// sentinel, 0xFF. It used to be gated behind the BASE record's pan-envelope
// `p` flag as well, which silently dropped every per-zone pan an SF2-derived
// bank writes: those base records carry no pan envelope at all, so `p` is
// clear and the whole keyboard collapsed to centre.
test("item 116: a patch's default pan applies with the base 'p' bit CLEAR", () => {
  const eng = makeTestEngine();
  assert.equal((eng.instruments[1].panEnvLoop >>> 7) & 1, 0, "base record has no 'p' flag");
  eng.uploadInstrumentPatches(1, writePatchesBlob([
    makeInstPatch({
      pitchStart: 0x0000, pitchEnd: 0x4fff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
      defaultPan: 0x20, // hard-ish left
    }),
    makeInstPatch({
      pitchStart: 0x5000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
      defaultPan: 0xe0, // hard-ish right
    }),
  ]));

  // Item 117: a zone pan lands on the NOTE axis, as an offset from centre, so
  // the channel's own position is left for the pattern to command.
  const ts = eng.playheads[0].trackerState;
  eng.jamNote(0, 0, 0x4000, 1);
  assert.equal(ts.voices[0].activePatchIndex, 0);
  assert.equal(ts.voices[0].notePan, 0x20 - 0x80, "low zone takes its own pan");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x20, "…and that is where it sounds");
  eng.jamNote(0, 0, 0x6000, 1);
  assert.equal(ts.voices[0].activePatchIndex, 1);
  assert.equal(ts.voices[0].notePan, 0xe0 - 0x80, "high zone takes its own pan");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0xe0);
  assert.equal(ts.voices[0].channelPan, 0x80, "the channel axis stays where it was");
});

// Item 117's payoff: the channel pan no longer fights the zone pan, it ROTATES
// it — the whole zone-panned keyboard swings with S $80xx instead of collapsing
// onto it at the next note.
test("item 117: a channel pan rotates a zone-panned instrument", () => {
  const eng = makeTestEngine();
  eng.uploadInstrumentPatches(1, writePatchesBlob([
    makeInstPatch({
      pitchStart: 0x0000, pitchEnd: 0x4fff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
      defaultPan: 0x60, // 32 left of centre
    }),
    makeInstPatch({
      pitchStart: 0x5000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
      defaultPan: 0xa0, // 32 right of centre
    }),
  ]));
  const ts = eng.playheads[0].trackerState;
  ts.voices[0].channelPan = 0x40; // as an S $8040 would leave it

  eng.jamNote(0, 0, 0x4000, 1);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 - 32, "low zone keeps its offset");
  eng.jamNote(0, 0, 0x6000, 1);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 + 32, "high zone keeps its own");
  assert.equal(ts.voices[0].channelPan, 0x40, "and neither note moved the channel");
});

test("item 116: the 0xFF sentinel still defers, and still respects 'p'", () => {
  const eng = makeTestEngine();
  eng.instruments[1].defaultPan = 0x30;
  eng.uploadInstrumentPatches(1, writePatchesBlob([
    makeInstPatch({
      pitchStart: 0x0000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
      defaultPan: 0xff, // no override
    }),
  ]));
  const ts = eng.playheads[0].trackerState;

  // 'p' clear + sentinel patch: nothing writes pan, both axes stand as they are.
  ts.voices[0].channelPan = 0x11;
  eng.jamNote(0, 0, 0x5000, 1);
  assert.equal(ts.voices[0].channelPan, 0x11, "no pan source: channel pan persists");
  assert.equal(ts.voices[0].notePan, 0, "…and the note axis stays neutral");

  // 'p' set + sentinel patch: the BASE record's byte 177 lands — on the note
  // axis too (item 117: an instrument never writes the channel's own position),
  // so with the channel at $11 it now sounds $11 offset by the default's $30.
  eng.instruments[1].panEnvLoop |= 0x80;
  eng.jamNote(0, 0, 0x5000, 1);
  assert.equal(ts.voices[0].notePan, 0x30 - 0x80, "sentinel defers to the base default pan");
  assert.equal(ts.voices[0].channelPan, 0x11, "which still is not a channel write");
  assert.equal(eng.getVoiceEffectivePan(0, 0), Math.max(0x11 + 0x30 - 0x80, 0));
});

// A meta layer child used to have its pan overwritten by the PARENT voice's
// post-trigger pan, so every layer inherited layer 0's position — the second
// half of the same symptom (an SF2 kit whose layers pan apart played mono).
test("item 116: each meta layer child keeps its OWN default pan", () => {
  const eng = makeTestEngine();
  const rec2 = new Uint8Array(256);
  const w16 = (o, v) => { rec2[o] = v & 0xff; rec2[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec2[14] = 1; rec2[21] = 0x3f; rec2[171] = 255; rec2[196] = 255;
  eng.uploadInstrument(2, rec2);

  const zone = (pan) => writePatchesBlob([makeInstPatch({
    pitchStart: 0x0000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
    defaultPan: pan,
  })]);
  eng.uploadInstrumentPatches(1, zone(0x20));
  eng.uploadInstrumentPatches(2, zone(0xe0));

  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));

  const ts = eng.playheads[0].trackerState;
  eng.jamNote(0, 0, 0x5000, 3);
  assert.equal(ts.voices[0].notePan, 0x20 - 0x80, "layer 0 pans left");
  const kids = ts.backgroundVoices.filter((v) => v.active && v.isLayerChild);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].instrumentId, 2);
  assert.equal(kids[0].notePan, 0xe0 - 0x80, "layer 1 keeps its own pan, not layer 0's");
});

// …but a layer with NO default pan of its own must still inherit the channel's
// pan (what the parent's copy was there for): the pattern's pan column and Mxx
// have to reach every layer.
test("item 116: a pan-less meta layer still inherits the channel pan", () => {
  const eng = makeTestEngine();
  const rec2 = new Uint8Array(256);
  const w16 = (o, v) => { rec2[o] = v & 0xff; rec2[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec2[14] = 1; rec2[21] = 0x3f; rec2[171] = 255; rec2[196] = 255;
  eng.uploadInstrument(2, rec2);
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));

  const ts = eng.playheads[0].trackerState;
  ts.voices[0].channelPan = 0x40;
  ts.voices[0].rowPan = 0x10;
  eng.jamNote(0, 0, 0x5000, 3);
  assert.equal(ts.voices[0].channelPan, 0x40, "layer 0 keeps the channel pan");
  const kids = ts.backgroundVoices.filter((v) => v.active && v.isLayerChild);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].channelPan, 0x40, "the child inherits it too");
  assert.equal(kids[0].rowPan, 0x10);
});

// Item 116 (audit): the same "a per-patch override is dropped by a consumer
// that reads the base record" fault, in three more places.

// The Ixmp/meta rectangle's velocity axis is 6-bit in EVERY format version, so
// a v3 song's 8-bit note volume must be narrowed for the lookup. triggerNote
// did; the note-less "instrument byte alone" row did not, so a wide-cell song
// silently reverted a patched voice to the base sample (the DNV seed is 255,
// which is outside every 0…63 rectangle).
test("item 116: wide cells — the inst-change row still resolves the patch", () => {
  const eng = makeTestEngine();
  eng.setCellFormat(true); // format v3
  for (let i = 0; i < 1000; i++) eng.sampleBin[1000 + i] = 128 + ((i % 50) - 25);
  eng.uploadInstrumentPatches(1, writePatchesBlob([makeInstPatch({
    pitchStart: 0x0000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    samplePtr: 1000, sampleLength: 1000, samplingRate: 32000,
    loopEnd: 1000, loopMode: 1,
  })]));

  const ts = eng.playheads[0].trackerState;
  const v = ts.voices[0];
  eng.jamNote(0, 0, 0x5000, 1);
  assert.equal(v.activeSamplePtr, 1000, "the trigger path narrows and matches");
  assert.equal(v.noteVolume, 255, "a wide cell seeds an 8-bit note volume");

  // Row 0: no note, instrument 1. Wide cell byte 8 = vol/pan effect nibbles;
  // SEL_FINE (3) with value 0 is the no-op in both columns.
  const pat = new Uint8Array(64 * 16);
  for (let r = 0; r < 64; r++) pat[r * 16 + 8] = (3 << 4) | 3;
  pat[2] = 1;
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  renderSamples(eng, 512);
  assert.equal(v.activeSamplePtr, 1000, "the inst-change row keeps the patch");
});

// notefx 5/6 set an instrument-wide filter override. It is absolute, so it
// legitimately wins over a patch — but CLEARING it ($FFFF) used to drop every
// voice onto the base record, discarding the patch's own 'x' block (and its
// SF-vs-IT mode, which decides what the number even means).
test("item 116: clearing the cutoff override returns a patched voice to its patch", () => {
  const eng = makeTestEngine();
  eng.instruments[1].defaultCutoff = 0xff; // base: filter OFF, IT mode
  eng.uploadInstrumentPatches(1, writePatchesBlob([makeInstPatch({
    pitchStart: 0x0000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
    hasExtra: true, filterSfMode: true, extraCutoff: 4000, extraResonance: 20,
  })]));

  const ts = eng.playheads[0].trackerState;
  const v = ts.voices[0];
  eng.jamNote(0, 0, 0x5000, 1);
  assert.equal(v.activeDefaultCutoff, 4000, "the trigger takes the patch's cutoff");
  assert.equal(v.filterSfMode, true, "and the patch's filter mode");

  applyFilterParamEffect(eng, ts, v, 0, 0x2000, false);
  assert.equal(v.activeDefaultCutoff, 0x20, "an override is absolute and wins");
  assert.equal(v.filterSfMode, false, "decoded in the INSTRUMENT's mode");

  applyFilterParamEffect(eng, ts, v, 0, 0xffff, false); // $FFFF clears it
  assert.equal(v.activeDefaultCutoff, 4000, "clearing returns to the PATCH, not the base");
  assert.equal(v.filterSfMode, true, "and restores the patch's units");

  // A voice with no patch still falls back to the base record.
  const v2 = ts.voices[1];
  eng.instruments[1].extraPatches = null;
  eng.jamNote(0, 1, 0x5000, 1);
  assert.equal(v2.activePatchIndex, -1);
  applyFilterParamEffect(eng, ts, v2, 1, 0xffff, false);
  assert.equal(v2.activeDefaultCutoff, 0xff, "no patch: the base record stands");
});

// The invert loop (S $F0xx) inverts bytes inside the LOOP. The mask was sized and
// indexed off the base record's loop, so on a patched voice — whose loop is the
// patch's — the inversion landed on the wrong bytes.
test("item 116: the invert loop follows the patch's loop, not the base record's", () => {
  const eng = makeTestEngine(); // base inst: loop 0..1000
  eng.uploadInstrumentPatches(1, writePatchesBlob([makeInstPatch({
    pitchStart: 0x0000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    samplePtr: 1000, sampleLength: 600, samplingRate: 32000,
    loopStart: 100, loopEnd: 400, loopMode: 1, // a DIFFERENT loop
  })]));
  // The invert walker lives in the per-tick advance, which only runs on a PLAYING
  // playhead — so this drives a real pattern rather than jamNote.
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1; // row 0: note 0x5000, inst 1
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);

  const ts = eng.playheads[0].trackerState;
  const v = ts.voices[0];
  renderSamples(eng, 512); // row 0 triggers
  assert.equal(v.activeSampleLoopStart, 100);
  assert.equal(v.activeSampleLoopEnd, 400);

  v.invertSpeed = 0x40; // arm the invert loop on this voice
  renderSamples(eng, TRACKER_CHUNK * 8);

  const inst = eng.instruments[1];
  assert.notEqual(inst.invertMask, null, "the mask was allocated");
  const patchLoopLen = 400 - 100;
  assert.equal(inst.invertMask.length, (patchLoopLen + 7) >> 3,
    "sized to the PATCH's 300-byte loop, not the base record's 1000");
  assert.ok(v.invertWritePos < patchLoopLen, "the write head wraps on the patch's loop");
});

// ── byte 186: the New Note Action is FIVE values, not four and a flag ────────

test("New Note Action is one five-value field, key lift included", () => {
  const nnaOf = (flag) => {
    const inst = new TaudInst(1);
    inst.instrumentFlag = flag;
    return [inst.newNoteAction, inst.nnaKeyLift];
  };
  // 0..3 sit in bits 0-1 with bit 5 clear; 4 — KEY LIFT — is bit 5 with those
  // two at 0, which is the value a writer means by 0b100_000.
  assert.deepEqual(nnaOf(0x00), [0, false], "note off");
  assert.deepEqual(nnaOf(0x01), [1, false], "note cut");
  assert.deepEqual(nnaOf(0x02), [2, false], "continue");
  assert.deepEqual(nnaOf(0x03), [3, false], "note fade");
  assert.deepEqual(nnaOf(0x20), [4, true], "key lift");

  // The auto-vibrato waveform sits BETWEEN the halves and must not leak in.
  assert.deepEqual(nnaOf(0x1c), [0, false], "waveform 7, note off");
  assert.deepEqual(nnaOf(0x3c), [4, true], "waveform 7, key lift");

  // Key lift is an ACTION, so it cannot also be a cut: `Nnn` 5..7 are
  // undefined and read as note off rather than minting "cut with key lift".
  assert.deepEqual(nnaOf(0x21), [0, false], "Nnn=5 is undefined");
  assert.deepEqual(nnaOf(0x22), [0, false], "Nnn=6 is undefined");
  assert.deepEqual(nnaOf(0x23), [0, false], "Nnn=7 is undefined");
});

test("key lift is the question every key-off asks", () => {
  // applyKeyLift reads the instrument, and the instrument's answer is simply
  // "is my New Note Action 4?" — so it follows the field and nothing else.
  const lift = new TaudInst(1);
  lift.instrumentFlag = 0x20;
  const cut = new TaudInst(2);
  cut.instrumentFlag = 0x01;
  assert.equal(lift.nnaKeyLift, true);
  assert.equal(cut.nnaKeyLift, false);
});
