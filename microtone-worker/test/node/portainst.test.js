// Item 124 — an instrument byte on a tone-portamento row RE-ATTACKS the
// envelopes. Reported against unreeeal_superhero_3.taud (cue 3, lane 9,
// pattern $16): a key-off at row $21 was followed at row $22 by a note with an
// instrument, a volume-column value and `G`, and the note was inaudible —
// unless playback STARTED on row $21, where there was no sounding voice for the
// porta to attach to and the row fell through to an ordinary trigger.
//
// Ground truth is FastTracker's retrigEnvelopeVibrato, which the porta path
// runs whenever the row carries an instrument number: envelope playheads back
// to node 0, sustain re-armed, fadeout reset — everything a fresh trigger does
// EXCEPT the sample position. Checked against libopenmpt (openmpt123) on the
// source .xm, both for the real song and for a hand-built probe module:
// porta+instrument returns to full, porta WITHOUT an instrument stays decayed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";

setSamplingRate(32000);

const NOTE_C4 = 0x5000;
const NOTE_D4 = 0x5400;

/**
 * One looping instrument whose volume envelope sustains at FULL on node 1 and,
 * once released, walks to node 2 and holds there at a quarter volume — so
 * "did the release happen" and "did the envelope re-attack" are two different
 * readings of envVolume.
 */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 256; i++) eng.sampleBin[i] = i < 128 ? 0x00 : 0xff; // square
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256);       // sampleLength
  w16(6, 32000);     // samplingRate @C4
  w16(12, 256);      // loopEnd
  rec[14] = 1;       // forward loop
  // Volume envelope: node0 63 (0.25 s) → node1 63 (0.25 s, the sustain point)
  // → node2 16, zero duration = terminator.
  rec[21] = 63; rec[22] = 64;  // node 0: full, minifloat 64 = 0.25 s
  rec[23] = 63; rec[24] = 64;  // node 1: full, 0.25 s
  rec[25] = 16; rec[26] = 0;   // node 2: quarter, hold
  w16(15, 0x2000);   // vol env LOOP word: P (present), no loop
  w16(189, 0x0121);  // vol env SUSTAIN word: enabled, start 1, end 1
  rec[171] = 255;    // instGlobalVolume
  rec[182] = 0xff;   // default cutoff wide open (a zeroed record closes it)
  rec[196] = 255;    // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  return eng;
}

/**
 * Pattern: row 0 triggers C4, row 4 keys off, row 8 is the cell under test.
 * `cell` is {note, inst, effect, arg}.
 */
function uploadProbe(eng, cell) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = NOTE_C4 & 0xff; pat[1] = NOTE_C4 >>> 8; pat[2] = 1;
  pat[4 * 8] = 0x01; pat[4 * 8 + 1] = 0x00;  // key off
  const o = 8 * 8;
  pat[o] = cell.note & 0xff; pat[o + 1] = (cell.note >>> 8) & 0xff;
  pat[o + 2] = cell.inst;
  pat[o + 5] = cell.effect ?? 0;
  pat[o + 6] = (cell.arg ?? 0) & 0xff; pat[o + 7] = ((cell.arg ?? 0) >>> 8) & 0xff;
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
}

/** Render until the playhead reaches `row`, one tick into it. */
function renderToRow(eng, row) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  for (let i = 0; i < 20000; i++) {
    eng.renderChunk(0, out);
    if (ts.rowIndex === row && ts.tickInRow >= 1) return ts.voices[0];
  }
  throw new Error(`row ${row} never reached`);
}

/** State at the released row 7, for the "the release really happened" premise. */
function releasedVoice(eng) {
  const v = renderToRow(eng, 7);
  assert.equal(v.keyOff, true, "row 7: the key-off at row 4 is still in force");
  assert.ok(v.envVolume < 0.3, `row 7: released to the envelope tail (got ${v.envVolume})`);
  assert.ok(v.envIndex >= 2, `row 7: playhead past the sustain node (got ${v.envIndex})`);
  return v;
}

test("G + instrument after a key-off re-attacks the envelope", () => {
  const eng = makeEngine();
  uploadProbe(eng, { note: NOTE_D4, inst: 1, effect: EffectOp.OP_G, arg: 0x0140 });
  releasedVoice(eng);
  const v = renderToRow(eng, 8);
  assert.equal(v.keyOff, false, "the instrument byte re-arms the sustain");
  assert.equal(v.envIndex, 0, "volume envelope playhead is back at node 0");
  assert.equal(v.envVolume, 1.0, "…and reads node 0's value, not the release tail");
  assert.equal(v.envPanIndex, 0, "pan envelope playhead too");
  assert.equal(v.fadeoutVolume, 1.0, "fadeout reset");
  // Still a PORTAMENTO: the target is set and the sample is not restarted.
  assert.equal(v.tonePortaTarget, NOTE_D4, "the row's pitch became the porta target");
  assert.equal(v.noteVal, NOTE_C4, "the sounding note is unchanged (no retrigger)");
  assert.ok(v.samplePos > 0, "the sample did not jump back to its play start");
});

test("G WITHOUT an instrument leaves the released envelope alone", () => {
  const eng = makeEngine();
  uploadProbe(eng, { note: NOTE_D4, inst: 0, effect: EffectOp.OP_G, arg: 0x0140 });
  const before = releasedVoice(eng);
  const envIndexBefore = before.envIndex;
  const v = renderToRow(eng, 8);
  assert.equal(v.keyOff, true, "no instrument byte: still released");
  assert.ok(v.envIndex >= envIndexBefore, "envelope playhead did not rewind");
  assert.ok(v.envVolume < 0.3, `still in the release tail (got ${v.envVolume})`);
  assert.equal(v.tonePortaTarget, NOTE_D4, "the porta itself still runs");
});

test("a plain note + instrument still retriggers the sample outright", () => {
  const eng = makeEngine();
  uploadProbe(eng, { note: NOTE_D4, inst: 1 });
  releasedVoice(eng);
  const v = renderToRow(eng, 8);
  assert.equal(v.keyOff, false);
  assert.equal(v.envIndex, 0);
  assert.equal(v.noteVal, NOTE_D4, "a non-porta row DOES retrigger");
  assert.equal(v.tonePortaTarget, -1, "and cancels any porta target");
});

test("the re-attack is audible: the porta row comes back to full level", () => {
  // The user-facing symptom, measured rather than inspected — RMS of the mix
  // over row 8 against the same instrument's sustained level at row 2.
  const rms = (eng, row) => {
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    const ts = eng.playheads[0].trackerState;
    let sum = 0, n = 0;
    for (let i = 0; i < 20000; i++) {
      eng.renderChunk(0, out);
      if (ts.rowIndex !== row) { if (n > 0) break; else continue; }
      for (let s = 0; s < TRACKER_CHUNK; s++) { sum += ts.mixLeft[s] * ts.mixLeft[s]; n++; }
    }
    return Math.sqrt(sum / n);
  };
  const eng = makeEngine();
  uploadProbe(eng, { note: NOTE_D4, inst: 1, effect: EffectOp.OP_G, arg: 0x0140 });
  const sustained = rms(eng, 2);
  const afterPorta = rms(eng, 8);
  assert.ok(sustained > 0.01, `premise: the note sounds at all (got ${sustained})`);
  // 0.8, not 0.9: the re-attack GLIDES to envelope node 0 over one tick rather
  // than snapping to it (item 142 — snapping stepped the gain mid-waveform on a
  // porta row, which is a click, and unlike a fresh trigger there is no sample
  // restart or attack ramp to hide it). That costs a tick of ramp inside the
  // row's RMS. What this test exists to catch is a porta row arriving SILENT,
  // which is an order of magnitude away from either figure.
  assert.ok(afterPorta > sustained * 0.8,
    `porta row is back at full level (${afterPorta} vs ${sustained})`);
});
