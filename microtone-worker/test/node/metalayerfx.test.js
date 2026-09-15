// Item 154 — a note effect written against a METAINSTRUMENT must reach every
// layer of it, not just layer 0. The foreground voice IS layer 0; layers 1..n
// are background voices tagged isLayerChild, so anything the pattern says about
// the note as a whole has to be fanned out to them (effects.js
// forEachLayerTarget) or inherited when they are spawned (triggerMetaOrNote).

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";
import { buildMetaRecord, makeMetaLayer } from "../../src/engine/inst.js";
import { MOD_OFF, MOD_ROL1 } from "../../src/engine/samplemod.js";

setSamplingRate(32000);

/** A looping ramp instrument in `slot`, one sample per byte at the engine rate. */
function uploadRamp(eng, slot, { nna = 0 } = {}) {
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);   // sampleLength
  w16(6, 32000);  // samplingRate @C4 — playback rate 1.0
  w16(12, 1000);  // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; // instGlobalVolume
  rec[186] = nna & 0x03; // instrument flag: New Note Action
  rec[196] = 255; // defaultNoteVolume
  eng.uploadInstrument(slot, rec);
}

/** Slots 1 and 2 sound; slot 3 is a two-layer meta over them, slot 4 a meta
 *  that stacks slot 1 TWICE (the shared-sample kit). */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  uploadRamp(eng, 1);
  uploadRamp(eng, 2);
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));
  eng.uploadInstrument(4, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));
  return eng;
}

/** rows: [{row, note, inst, effect, arg}] on channel 0 of pattern 0, then play. */
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
/** One chunk: enough to process the row trigger without crossing a tick. */
function renderRowTriggerOnly(eng) {
  eng.renderChunk(0, new Uint8Array(TRACKER_CHUNK * 2));
}

const ts0 = (eng) => eng.playheads[0].trackerState;
const voice0 = (eng) => ts0(eng).voices[0];
const kids = (eng) => ts0(eng).backgroundVoices.filter(
  (v) => v.active && v.isLayerChild && v.sourceChannel === 0);

test("8 $xyzz crushes EVERY layer of a metainstrument, not just layer 0", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_8, arg: 0x1304 },
  ]);
  renderRowTriggerOnly(eng);
  const layer1 = kids(eng);
  assert.equal(layer1.length, 1, "premise: the meta spawned one layer child");
  for (const v of [voice0(eng), ...layer1]) {
    assert.equal(v.bitcrusherDepth, 3, "bit depth reached this layer");
    assert.equal(v.bitcrusherSkip, 4, "sample-skip reached this layer");
    assert.equal(v.clipMode, 1, "clip mode reached this layer");
  }
});

test("8 $0000 clears the crusher on every layer too", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_8, arg: 0x1304 },
    { row: 1, effect: EffectOp.OP_8, arg: 0x0000 },
  ]);
  render(eng, 6); // row 0 …
  render(eng, 1); // … then row 1's trigger
  for (const v of [voice0(eng), ...kids(eng)]) {
    assert.equal(v.bitcrusherDepth, 0);
    assert.equal(v.bitcrusherSkip, 0);
  }
});

test("9 $x0zz overdrives every layer", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_9, arg: 0x2040 },
  ]);
  renderRowTriggerOnly(eng);
  for (const v of [voice0(eng), ...kids(eng)]) {
    assert.equal(v.overdriveAmp, 0x40, "amplification reached this layer");
    assert.equal(v.clipMode, 2, "clip mode reached this layer");
  }
});

test("a crusher already running when the meta is struck is inherited by new layers", () => {
  // The crusher is CHANNEL state: it is armed on a plain note and outlives it,
  // so the layer children spawned by the NEXT note have to start out crushed.
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_8, arg: 0x0206 },
    { row: 1, note: 0x5000, inst: 3 }, // the meta, with no effect of its own
  ]);
  render(eng, 6);
  render(eng, 1);
  const layer1 = kids(eng);
  assert.equal(layer1.length, 1, "premise: the meta is sounding");
  for (const v of [voice0(eng), ...layer1]) {
    assert.equal(v.bitcrusherDepth, 2, "the channel's depth carried onto this layer");
    assert.equal(v.bitcrusherSkip, 6);
  }
});

test("vibrato bends the whole kit — the pitch overlay reaches the layer children", () => {
  const eng = loadSong(makeEngine(), [
    // H $spdp — speed $20, depth $40: a wide, fast swing so one tick is enough.
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_H, arg: 0x2040 },
  ]);
  render(eng, 2);
  const parent = voice0(eng);
  const child = kids(eng)[0];
  assert.ok(parent.pitchModDelta !== 0, "premise: the vibrato is off centre this tick");
  assert.equal(child.layerPitchMod, parent.pitchModDelta, "the child took the parent's bend");
  assert.equal(child.renderPitch - child.noteVal, parent.pitchModDelta,
    "…and it lands on the pitch the child actually renders");
});

test("arpeggio steps every layer, and a detached child drops back to its own note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_J, arg: 0x0407 },
    { row: 1, note: 0x5000, inst: 1 }, // plain note: releases the layer children
  ]);
  render(eng, 2); // tick 1 of row 0 → arpeggio voice 1 (+4 semitones)
  const bent = kids(eng)[0];
  assert.ok(bent.layerPitchMod > 0, "the arpeggio step reached the child");
  assert.equal(bent.renderPitch, bent.noteVal + bent.layerPitchMod);

  render(eng, 5); // into row 1 — the meta is replaced, children detach
  const ghosts = ts0(eng).backgroundVoices.filter((v) => v.active && !v.isLayerChild);
  for (const g of ghosts) {
    assert.equal(g.layerPitchMod, 0, "a detached child sits at its own note, not mid-arpeggio");
  }
});

test("3 $sexy modifies every layer's instrument — one clock per instrument", () => {
  const eng = loadSong(makeEngine(), [
    // whole domain ($00), ROL-by-1 ($2), every tick ($F)
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_3, arg: 0x002f },
  ]);
  renderRowTriggerOnly(eng);
  assert.equal(eng.instruments[1].modOp, MOD_ROL1, "layer 0's instrument took the command");
  assert.equal(eng.instruments[2].modOp, MOD_ROL1, "…and so did layer 1's");
  assert.ok(voice0(eng).modPeriod > 0, "layer 0 carries the clock");
  assert.ok(kids(eng)[0].modPeriod > 0, "layer 1 carries its own clock");

  render(eng, 4);
  assert.ok(eng.instruments[1].modRot > 0, "layer 0's instrument is being rotated");
  assert.ok(eng.instruments[2].modRot > 0, "layer 1's instrument is too");
  assert.equal(eng.instruments[1].modRot, eng.instruments[2].modRot,
    "both walked at the same rate — one clock each, not one channel between them");
});

test("layers sharing one instrument step it ONCE a tick", () => {
  // Slot 4 stacks slot 1 twice. Two clocks on one instrument would rotate it at
  // double speed; the duplicate's clock is suppressed instead.
  const eng = makeEngine();
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 4, effect: EffectOp.OP_3, arg: 0x002f }]);
  renderRowTriggerOnly(eng);
  assert.equal(kids(eng).length, 1, "premise: the stacked layer is sounding");
  assert.equal(kids(eng)[0].modPeriod, 0, "the duplicate layer carries no clock of its own");

  const solo = makeEngine();
  loadSong(solo, [{ row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x002f }]);
  renderRowTriggerOnly(solo);
  render(eng, 5);
  render(solo, 5);
  assert.equal(eng.instruments[1].modRot, solo.instruments[1].modRot,
    "the stacked kit rotates at exactly the plain note's rate");
});

test("2/3 $x=0 turns the modification off across the whole kit", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_3, arg: 0x002f },
    { row: 1, effect: EffectOp.OP_3, arg: 0x0000 },
  ]);
  render(eng, 6);
  render(eng, 1);
  assert.equal(eng.instruments[1].modOp, MOD_OFF);
  assert.equal(eng.instruments[2].modOp, MOD_OFF, "layer 1's instrument was reset too");
});

test("Q retriggers the whole metainstrument, layers together", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_Q, arg: 0x0200 }, // every 2 ticks
  ]);
  render(eng, 1);
  const child = kids(eng)[0];
  assert.ok(child.samplePos > 100, "premise: the child has played on for a tick");
  render(eng, 1); // the retrigger tick
  assert.ok(child.samplePos <= 1,
    `the layer child restarted with the foreground voice, got ${child.samplePos}`);
  assert.ok(voice0(eng).samplePos <= 1, "…and so did the foreground voice");
});

// ── item 191.1: the per-note NNA override reaches the whole metainstrument ───

/** A two-layer meta over slots 1 and 2, both layers at `nna`. */
function makeNnaEngine(nna) {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  uploadRamp(eng, 1, { nna });
  uploadRamp(eng, 2, { nna });
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));
  return eng;
}

/** Voices released by an earlier note — a detached layer child drops the flag,
 *  so this is everything still ringing that the pattern can no longer reach. */
const released = (eng) => ts0(eng).backgroundVoices.filter(
  (v) => v.active && !v.isLayerChild);

test("S $74 holds EVERY layer of a metainstrument, not layer 0 alone", () => {
  // Both layer instruments say Note Cut, so nothing of the first note survives
  // on its own account: whatever is still ringing is the override's doing, and
  // "continue" that reached layer 0 alone would leave exactly one voice.
  const run = (rows) => {
    const eng = loadSong(makeNnaEngine(1), rows);
    render(eng, 6); // row 0 …
    render(eng, 1); // … then row 1's trigger
    return released(eng);
  };
  assert.equal(run([
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5400, inst: 3 },
  ]).length, 0, "premise: Note Cut on both layers leaves nothing behind");

  const held = run([
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_S, arg: 0x7400 },
    { row: 1, note: 0x5400, inst: 3 },
  ]);
  assert.equal(held.length, 2, "the whole note carried on — layer 0 AND layer 1");
  for (const v of held) assert.ok(!v.keyOff && !v.noteFading, "…unreleased, as Continue says");
});

test("S $75 / S $76 release the whole metainstrument too", () => {
  const run = (sub) => {
    const eng = loadSong(makeNnaEngine(2), [ // layers say Continue on their own
      { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_S, arg: sub },
      { row: 1, note: 0x5400, inst: 3 },
    ]);
    render(eng, 6);
    render(eng, 1);
    return released(eng);
  };
  const off = run(0x7500); // Note Off
  assert.equal(off.length, 2);
  for (const v of off) assert.ok(v.keyOff, "every layer took the key-off");

  const fade = run(0x7600); // Note Fade
  assert.equal(fade.length, 2);
  for (const v of fade) assert.ok(v.noteFading, "every layer began fading");
});

test("the override is the OUTGOING note's, and one note only", () => {
  // It is written after the row-0 trigger and read by the row-1 one, which
  // then clears it — so the note started on row 1 is back on its own NNA.
  const eng = loadSong(makeNnaEngine(1), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_S, arg: 0x7400 },
    { row: 1, note: 0x5400, inst: 3 },
    { row: 2, note: 0x5800, inst: 3 },
  ]);
  render(eng, 6);
  render(eng, 6);
  assert.equal(voice0(eng).nnaOverride, -1, "the fresh trigger cleared it");
  render(eng, 1);
  assert.equal(released(eng).length, 2,
    "row 1's note was cut by its own NNA; only row 0's two voices are left");
});
