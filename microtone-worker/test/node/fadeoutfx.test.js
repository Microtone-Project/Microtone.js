// Z $Exxx — the note's fadeout, set on the fly (item 345; TAUD_NOTE_EFFECTS.md
// "Z $Exxx", engine spec §6). The command writes the sounding note's fadeout
// step and nothing else: the record is untouched, the next trigger reads it
// again, a key-off fades at the new step, and the instrument tab reads what is
// in force through getInstrumentFadeoutState.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudPlayData } from "../../core/engine/state.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { EffectOp } from "../../core/engine/tables.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";

setSamplingRate(32000);

const RECORD_FADEOUT = 0x020;

function engineWith(rows, { surround = 0 } = {}) {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  rec[172] = RECORD_FADEOUT & 0xff; rec[173] = RECORD_FADEOUT >> 8;
  eng.uploadInstrument(1, rec);

  const p = [];
  for (let r = 0; r < 64; r++) {
    const c = new TaudPlayData();
    c.volumeEff = 3; c.panEff = 3;
    p.push(c);
  }
  rows(p);
  const bytes = new Uint8Array(64 * 8);
  for (let r = 0; r < 64; r++) for (let o = 0; o < 8; o++) bytes[r * 8 + o] = p[r].getByte(o);
  eng.uploadPattern(0, bytes);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setSurroundModel(0, surround);
  eng.setBPM(0, 125); eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255); eng.setCuePosition(0, 0);
  eng.play(0);
  return eng;
}

/** Render until `row`, tick 1 or later (the row's events applied). */
function renderTo(eng, row) {
  const ts = eng.playheads[0].trackerState;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < 100000; i++) {
    if (ts.rowIndex === row && ts.tickInRow >= 1) return ts;
    eng.renderChunk(0, out);
  }
  throw new Error(`row ${row} never reached`);
}

const fx = (c, op, arg) => { c.effect = op; c.effectArg = arg; };

test("Z $Exxx sets the sounding note's fadeout step; the next trigger reads the record again", () => {
  const eng = engineWith((p) => {
    p[0].note = 0x5000; p[0].instrment = 1;
    fx(p[2], EffectOp.OP_Z, 0xe123);
    p[4].note = 0x5000; p[4].instrment = 1;
  });
  const v = renderTo(eng, 1).voices[0];
  assert.equal(v.activeFadeoutStep, RECORD_FADEOUT, "a note starts with the record's fadeout");
  assert.deepEqual(eng.getInstrumentFadeoutState(1), [], "…and nothing of its own to show");

  renderTo(eng, 2);
  assert.equal(v.activeFadeoutStep, 0x123, "Z $E123 in force — in a stereo song too");
  assert.deepEqual(eng.getInstrumentFadeoutState(1), [{ step: 0x123, released: false }]);
  assert.deepEqual(eng.getInstrumentFadeoutState(2), [], "another instrument shows none");
  assert.equal(eng.instruments[1].volumeFadeoutLow | ((eng.instruments[1].fadeoutHigh & 0xf) << 8),
    RECORD_FADEOUT, "the record is untouched");

  renderTo(eng, 4);
  assert.equal(v.activeFadeoutStep, RECORD_FADEOUT, "a new note is the instrument's again");
  // …while the old one, moved to the background by its NNA, fades at its own.
  assert.deepEqual(eng.getInstrumentFadeoutState(1).filter((f) => !f.released), []);
  assert.ok(eng.getInstrumentFadeoutState(1).every((f) => f.step === 0x123));
});

test("a key-off fades at the step Z $Exxx gave the note", () => {
  // $400 = one tick to silence; the record's $020 would take 32 ticks.
  const ticksToSilence = (z) => {
    const eng = engineWith((p) => {
      p[0].note = 0x5000; p[0].instrment = 1;
      if (z !== null) fx(p[1], EffectOp.OP_Z, z);
      p[2].note = 0x0001; // key-off
    });
    const ts = renderTo(eng, 2);
    const v = ts.voices[0];
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let ticks = 0, lastTick = ts.tickInRow;
    for (let i = 0; i < 100000 && v.active; i++) {
      eng.renderChunk(0, out);
      if (ts.tickInRow !== lastTick) { ticks++; lastTick = ts.tickInRow; }
    }
    return { ticks, active: v.active };
  };
  const fast = ticksToSilence(0xe400);
  const slow = ticksToSilence(null);
  assert.equal(fast.active, false);
  assert.ok(fast.ticks <= 3, `Z $E400 cuts within a tick or two (${fast.ticks})`);
  assert.ok(slow.ticks >= 30, `the record's fadeout takes its 32 ticks (${slow.ticks})`);
});

test("Z $Exxx is not a spatial slide", () => {
  const eng = engineWith((p) => {
    p[0].note = 0x5000; p[0].instrment = 1;
    fx(p[1], EffectOp.OP_Z, 0xe040);
  }, { surround: 2 });
  const v = renderTo(eng, 1).voices[0];
  renderTo(eng, 2);
  assert.equal(v.spatialSlideActive, false);
  assert.equal(v.activeFadeoutStep, 0x040);
});
