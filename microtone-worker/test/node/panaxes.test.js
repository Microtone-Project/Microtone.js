// The two panning axes (item 117) — the pan side of TAUD_NOTE_EFFECTS.md §3.
//
// `channel_pan` is where the PART sits and only S $80xx / P / X / 4 / Z may
// write it; `note_pan` is where the NOTE sits within it, seeded by the
// instrument (its default pan, or the Ixmp zone's) and written by the panning
// column. They add at the mixer, which is what lets a lane pan ROTATE a
// zone-panned instrument instead of flattening it at the next note.
//
// The volume side of the same shape is §3's `note_vol` × `channel_vol`, and
// the mapping of commands onto axes is deliberately identical: effect column →
// lane, mini-lane → note.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../src/engine/constants.js";
import {
  EffectOp, lfoSampleWide, advanceLfoPhase, LFO_PHASE_STEPS, MOD_SIN_TABLE,
} from "../../src/engine/tables.js";
import {
  makeInstPatch, writePatchesBlob, buildMetaRecord, makeMetaLayer,
} from "../../src/engine/inst.js";
import { fillSnapshotInto } from "../../src/worklet/engine-commands.js";
import {
  SNAP_HEADER_SIZE, SNAP_VOICE_STRIDE, SNAP_V_EFF_PAN, SNAP_V_AZIMUTH,
} from "../../src/worklet/protocol.js";
import { MAX_VOICES } from "../../src/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../../src/engine/rng.js";

setSamplingRate(32000);

/** Two instruments over one looping ramp: 1 plain, 2 with two panned zones. */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = () => {
    const r = new Uint8Array(256);
    const w16 = (o, v) => { r[o] = v & 0xff; r[o + 1] = (v >> 8) & 0xff; };
    w16(4, 1000); w16(6, 32000); w16(12, 1000);
    r[14] = 1; r[21] = 0x3f; r[171] = 255; r[196] = 255;
    return r;
  };
  eng.uploadInstrument(1, rec());
  eng.uploadInstrument(2, rec());
  const zone = (lo, hi, pan) => makeInstPatch({
    pitchStart: lo, pitchEnd: hi, volumeStart: 0, volumeEnd: 63,
    sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
    defaultPan: pan,
  });
  // A two-zone keyboard: low notes left of centre, high notes right of it.
  eng.uploadInstrumentPatches(2, writePatchesBlob([
    zone(0x0000, 0x4fff, 0x60), zone(0x5000, 0xffff, 0xa0),
  ]));
  return eng;
}

/** rows: [{row, note, inst, effect, arg, pan, panEff}] → uploaded pattern 0. */
function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.pan !== undefined) pat[o + 4] = (c.pan & 0x3f) | ((c.panEff ?? 0) << 6);
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

const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];
/** The 6-bit column value that lands on 8-bit pan `p` (the engine's own map). */
const colFor = (v) => (v << 2) | (v >>> 4);

// ── the axes are separate registers ──────────────────────────────────────

test("S $80xx moves the channel, the panning column moves the note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8040 },
    { row: 1, pan: 0x30, panEff: 0 },
  ]);
  render(eng, 3);
  assert.equal(voice0(eng).channelPan, 0x40, "S $80xx wrote the channel axis");
  assert.equal(voice0(eng).notePan, 0, "…and left the note axis alone");

  render(eng, 6);
  assert.equal(voice0(eng).channelPan, 0x40, "the column did not touch the channel");
  assert.equal(voice0(eng).notePan, colFor(0x30) - 0x80, "the column wrote the note axis");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 + colFor(0x30) - 0x80, "and they sum");
});

// The precedence rule this replaces ("S $80xx wins over a column SET on the
// same row") existed only because both wrote one register. They no longer do.
test("an S $80xx and a column SET on the same row BOTH apply", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8060, pan: 0x28, panEff: 0 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).channelPan, 0x60);
  assert.equal(voice0(eng).notePan, colFor(0x28) - 0x80);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x60 + colFor(0x28) - 0x80);
});

test("P slides the channel axis while the column's slide moves the note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8080 },
    { row: 1, effect: EffectOp.OP_P, arg: 0x0400 },  // lane: right 4/tick
    { row: 2, pan: 0x06, panEff: 1 },                // note: right 6/tick
  ]);
  render(eng, 12);
  const afterP = voice0(eng).channelPan;
  assert.equal(afterP, 0x80 + 4 * 5, "five non-first ticks of P");
  assert.equal(voice0(eng).notePan, 0);

  render(eng, 6);
  assert.equal(voice0(eng).channelPan, afterP, "the column's slide left the channel alone");
  assert.equal(voice0(eng).notePan, 6 * 5, "five non-first ticks of the column slide");
});

// ── what the instrument seeds ────────────────────────────────────────────

test("a zone pan seeds the note axis, so a channel pan rotates the keyboard", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x4000, inst: 2, effect: EffectOp.OP_S, arg: 0x8040 },
    { row: 1, note: 0x6000, inst: 2 },
  ]);
  render(eng, 3);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 - 32, "low zone, 32 left of the channel");
  render(eng, 6);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 + 32, "high zone, 32 right of it");
  assert.equal(voice0(eng).channelPan, 0x40, "neither note moved the channel");
});

test("a column SET overrides the zone pan for that note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x4000, inst: 2, pan: 0x20, panEff: 0 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).notePan, colFor(0x20) - 0x80,
    "the column runs after the trigger, so it is what stands");
});

test("a trigger that brings no pan of its own leaves a column SET standing", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, pan: 0x10, panEff: 0 },
    { row: 1, note: 0x5100, inst: 1 },  // instrument 1 has no zone and no 'p'
  ]);
  render(eng, 12);
  assert.equal(voice0(eng).notePan, colFor(0x10) - 0x80, "still the column's value");
});

test("a zone-panned trigger re-seeds the note axis over a column SET", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, pan: 0x10, panEff: 0 },
    { row: 1, note: 0x4000, inst: 2 },  // instrument 2's low zone: $60
  ]);
  render(eng, 12);
  assert.equal(voice0(eng).notePan, 0x60 - 0x80, "the zone won");
});

// ── the sum ──────────────────────────────────────────────────────────────

test("the summed position saturates at the ends in a stereo song", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x80f0, pan: 0x3f, panEff: 0 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).channelPan + voice0(eng).notePan, 0xf0 + 127, "both axes keep their value");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 255, "the mixer is what clamps");
});

test("an NNA ghost keeps sounding at its own note position", () => {
  const eng = makeEngine();
  // Instrument 2, NNA = continue, so the first note lives on as a ghost.
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  rec[186] = 2; // NNA continue
  eng.uploadInstrument(2, rec);
  eng.uploadInstrumentPatches(2, writePatchesBlob([
    makeInstPatch({
      pitchStart: 0x0000, pitchEnd: 0x4fff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1, defaultPan: 0x60,
    }),
    makeInstPatch({
      pitchStart: 0x5000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1, defaultPan: 0xa0,
    }),
  ]));
  loadSong(eng, [
    { row: 0, note: 0x4000, inst: 2 },
    { row: 1, note: 0x6000, inst: 2 },
  ]);
  render(eng, 12);
  const ghosts = eng.playheads[0].trackerState.backgroundVoices.filter((v) => v.active);
  assert.equal(ghosts.length, 1, "the displaced note carried on");
  assert.equal(ghosts[0].notePan, 0x60 - 0x80, "the ghost kept the zone it was sounding");
  assert.equal(voice0(eng).notePan, 0xa0 - 0x80, "the new note took its own");
});

// ── metainstrument layers: an arrangement one level down (item 118) ───────
// A meta whose sub-instruments pan apart is a soundfield, not a point, and the
// same rule applies to it as to a zone-panned instrument: a note-pan SET places
// its CENTRE — layer 0, the foreground voice, as it already is for detune — and
// every layer keeps its distance from that centre for the whole note.

/** Meta in slot 3 layering two zone-panned instruments (1: $60, 2: $A0). */
function makeMetaEngine(pan0 = 0x60, pan1 = 0xa0) {
  const eng = makeEngine();
  const rec = () => {
    const r = new Uint8Array(256);
    const w16 = (o, v) => { r[o] = v & 0xff; r[o + 1] = (v >> 8) & 0xff; };
    w16(4, 1000); w16(6, 32000); w16(12, 1000);
    r[14] = 1; r[21] = 0x3f; r[171] = 255; r[196] = 255;
    return r;
  };
  eng.uploadInstrument(1, rec());
  eng.uploadInstrument(2, rec());
  const zone = (pan) => writePatchesBlob([makeInstPatch({
    pitchStart: 0x0000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
    defaultPan: pan,
  })]);
  if (pan0 !== null) eng.uploadInstrumentPatches(1, zone(pan0));
  else eng.clearInstrumentPatches(1);
  if (pan1 !== null) eng.uploadInstrumentPatches(2, zone(pan1));
  else eng.clearInstrumentPatches(2);
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(2, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));
  return eng;
}

const kidOf = (eng) =>
  eng.playheads[0].trackerState.backgroundVoices.filter((v) => v.active && v.isLayerChild)[0];

test("a meta's layers keep their spread for the WHOLE note, not just its first tick", () => {
  const eng = loadSong(makeMetaEngine(), [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  assert.equal(voice0(eng).notePan, 0x60 - 0x80, "layer 0 at its own pan");
  assert.equal(kidOf(eng).notePan, 0xa0 - 0x80, "layer 1 at its own");
  assert.equal(kidOf(eng).layerRelPan, 0x40, "…held as a distance from layer 0");
  render(eng, 5); // past the per-tick resync that used to flatten it
  assert.equal(kidOf(eng).notePan, 0xa0 - 0x80, "and it is still there six ticks in");
});

test("a note-pan SET rotates the whole soundfield, centred on layer 0", () => {
  const eng = loadSong(makeMetaEngine(), [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, pan: 0x10, panEff: 0 },
  ]);
  render(eng, 9); // into row 1, past its first tick
  const centre = colFor(0x10) - 0x80;
  assert.equal(voice0(eng).notePan, centre, "the SET placed the centre");
  assert.equal(kidOf(eng).notePan, centre + 0x40, "layer 1 rotated with it");
  assert.equal(kidOf(eng).notePan - voice0(eng).notePan, 0x40, "spread preserved");
});

test("a channel pan rotates it too, both axes at once", () => {
  const eng = loadSong(makeMetaEngine(), [
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_S, arg: 0x8040 },
  ]);
  render(eng, 3);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 - 32, "layer 0 sits left of the channel");
  assert.equal(voice0(eng).channelPan, 0x40);
  assert.equal(kidOf(eng).channelPan, 0x40, "the child follows the channel");
  assert.equal(kidOf(eng).notePan, 0x20, "and keeps its own +32 note offset");
});

test("a layer with no pan of its own rides at the meta's centre", () => {
  const eng = loadSong(makeMetaEngine(0x60, null), [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, pan: 0x10, panEff: 0 },
  ]);
  render(eng, 3);
  assert.equal(kidOf(eng).layerRelPan, 0, "no opinion means no offset");
  assert.equal(kidOf(eng).notePan, voice0(eng).notePan, "so it sits where layer 0 sits");
  render(eng, 6);
  assert.equal(kidOf(eng).notePan, voice0(eng).notePan, "…including after the column moves them");
  assert.equal(voice0(eng).notePan, colFor(0x10) - 0x80);
});

test("a pan-less layer 0 still lets the others spread around the commanded point", () => {
  const eng = loadSong(makeMetaEngine(null, 0xa0), [
    { row: 0, note: 0x5000, inst: 3, pan: 0x10, panEff: 0 },
  ]);
  render(eng, 3);
  const centre = colFor(0x10) - 0x80;
  assert.equal(voice0(eng).notePan, centre, "layer 0 takes the column's placement");
  assert.equal(kidOf(eng).layerRelPan, 0x20, "layer 1's own pan measured from centre");
  assert.equal(kidOf(eng).notePan, centre + 0x20);
});

// ── Panbrello (Y) rides the same sum ─────────────────────────────────────
// Y used to write `rowPan`, the 6-bit register the mixer stopped reading when
// pan went 8-bit: the LFO ran every tick and the sound never moved. It is an
// offset onto the pan sum now, which is also what makes it modulate AROUND an
// instrument's own pan instead of overwriting it.

const Y_SPEED = 0x33, Y_DEPTH = 0x55, Y_ARG = 0x3355;
/** The offset the engine will hold after `ticks` ticks of Y: the LFO advances
 *  at the end of each tick, so tick 1 renders phase 0 and tick 2 phase `speed`
 *  of the 1088-step accumulator. */
const yOffsetAfter = (ticks) =>
  (lfoSampleWide(((ticks - 1) * Y_SPEED) % LFO_PHASE_STEPS, 0) * Y_DEPTH) >> 7;

/** Worst |L|/|R| tick-energy imbalance over `ticks` — 1.0 is dead centre. */
function worstImbalance(eng, ticks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let worst = 1;
  for (let t = 0; t < ticks; t++) {
    let eL = 0, eR = 0;
    for (let i = 0; i < CHUNKS_PER_TICK; i++) {
      eng.renderChunk(0, out);
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        eL += Math.abs(out[n * 2] - 128);
        eR += Math.abs(out[n * 2 + 1] - 128);
      }
    }
    const ratio = eL / Math.max(eR, 1);
    worst = Math.max(worst, ratio, 1 / Math.max(ratio, 1e-9));
  }
  return worst;
}

test("Y reaches the mixer at all", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Y, arg: Y_ARG },
  ]);
  render(eng, 1);
  assert.equal(voice0(eng).panbrelloOffset, 0, "phase 0 is the centre of the swing");
  render(eng, 1);
  const off = yOffsetAfter(2);
  assert.ok(off !== 0, "the fixture's second tick is off-centre");
  assert.equal(voice0(eng).panbrelloOffset, off, "(lfo × depth) >> 7, into the 8-bit sum");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x80 + off, "and the meters follow it");
});

test("Y actually pans the rendered audio", () => {
  const withY = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Y, arg: Y_ARG },
  ]);
  assert.ok(worstImbalance(withY, 6) > 1.5, "the row sweeps across the stereo field");

  const withoutY = loadSong(makeEngine(), [{ row: 0, note: 0x5000, inst: 1 }]);
  assert.ok(worstImbalance(withoutY, 6) < 1.1, "…and the same row without Y does not");
});

test("Y swings around both axes instead of writing either", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8040 },
    { row: 1, effect: EffectOp.OP_Y, arg: Y_ARG, pan: 0x30, panEff: 0 },
  ]);
  render(eng, 8); // row 1, second tick
  const off = yOffsetAfter(2);
  assert.equal(voice0(eng).panbrelloOffset, off);
  assert.equal(voice0(eng).channelPan, 0x40, "Y left the channel axis alone");
  assert.equal(voice0(eng).notePan, colFor(0x30) - 0x80, "…and the note axis too");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 + colFor(0x30) - 0x80 + off,
    "it is a third term on the sum, not a replacement for either");
});

test("a row without Y puts the voice back on its base pan", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Y, arg: Y_ARG },
  ]);
  render(eng, 2);
  assert.ok(voice0(eng).panbrelloOffset !== 0, "swinging during row 0");
  render(eng, 6); // row 1 carries no Y: the tick pass zeroes the offset again
  assert.equal(voice0(eng).panbrelloOffset, 0, "stopped");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x80, "back at centre");
});

// A row boundary runs applyTrackerRow AFTER the tick pass, so anything the row
// reset clears is still cleared while the new row's FIRST tick renders. Y's
// offset therefore lives in the tick pass alone; it used to be cleared per row,
// which put one tick of dead centre into the middle of every sustained sweep.
test("a sweep held across rows never collapses at the row boundary", () => {
  const rows = [{ row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_Y, arg: 0x1155 }];
  for (let r = 1; r < 4; r++) rows.push({ row: r, effect: EffectOp.OP_Y, arg: 0x1155 });
  const eng = loadSong(makeEngine(), rows);
  render(eng, 1); // tick 0 of row 0 is the retrigger's own phase zero
  for (let tick = 1; tick < 24; tick++) {
    render(eng, 1);
    assert.ok(voice0(eng).panbrelloOffset !== 0,
      `tick ${tick} (row ${(tick / 6) | 0}) fell back to centre mid-sweep`);
  }
});

// ── what the meters see ──────────────────────────────────────────────────
// The lane-header pan slider and the master strip's blobs do not read the
// engine directly: they read the worklet snapshot, which sums pan itself.

test("the snapshot's pan follows the panbrello LFO", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x80a0 },
    { row: 1, effect: EffectOp.OP_Y, arg: Y_ARG },
  ]);
  const snap = new Float64Array(SNAP_HEADER_SIZE + MAX_VOICES * SNAP_VOICE_STRIDE);
  render(eng, 8); // row 1, second tick
  fillSnapshotInto(eng, 0, snap);
  const off = yOffsetAfter(2);
  assert.ok(off !== 0);
  assert.equal(snap[SNAP_HEADER_SIZE + SNAP_V_EFF_PAN], 0xa0 + off,
    "the slider's value carries the swing");
  assert.equal(snap[SNAP_HEADER_SIZE + SNAP_V_AZIMUTH], 0xa0 + off,
    "and so does the blob's angle, which mirrors it in a stereo song");
});

// Item 155: the meters used to sum pan themselves, and their copy of the sum
// had never grown the instrument's random pan swing — so a kit panned by its
// swing sat dead centre on the slider and the blobs while sounding off-centre.
// Both now read the mixer's own voicePanByte.

test("the snapshot's pan carries the instrument's pan swing", () => {
  const eng = makeEngine();
  eng.instruments[1].panSwing = 40; // ±40 units of random placement per note
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8080 }]);
  const snap = new Float64Array(SNAP_HEADER_SIZE + MAX_VOICES * SNAP_VOICE_STRIDE);
  setRandomSource(makeSeededRandom(7)); // a throw that is not centre
  render(eng, 2);
  setRandomSource(null);
  const bias = voice0(eng).randomPanBias;
  assert.notEqual(bias, 0, "premise: this note was thrown off centre");
  fillSnapshotInto(eng, 0, snap);
  assert.equal(snap[SNAP_HEADER_SIZE + SNAP_V_EFF_PAN], 0x80 + bias,
    "the slider shows where the note actually sounds");
  assert.equal(snap[SNAP_HEADER_SIZE + SNAP_V_AZIMUTH], 0x80 + bias);
});

// Item 155.1: a metainstrument is several voices at once and the foreground
// voice is only its layer 0, so a kit whose layers pan apart was drawn at the
// FIRST layer's position. The meters show the mix-weighted mean instead.
test("a metainstrument's meters show the kit's position, not layer 0's", () => {
  const eng = makeEngine();
  // Two sub-instruments that bring their own default pan: hard left and hard
  // right of the lane. Bit 7 of the pan LOOP word is "use default pan".
  for (const [slot, pan] of [[3, 0x20], [4, 0xe0]]) {
    const r = new Uint8Array(256);
    const w16 = (o, v) => { r[o] = v & 0xff; r[o + 1] = (v >> 8) & 0xff; };
    w16(4, 1000); w16(6, 32000); w16(12, 1000);
    r[14] = 1; r[21] = 0x3f; r[171] = 255; r[196] = 255;
    r[177] = pan; r[17] = 0x80; // default pan + the 'p' flag that enables it
    eng.uploadInstrument(slot, r);
  }
  eng.uploadInstrument(5, buildMetaRecord([
    makeMetaLayer(3, 159, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(4, 159, 0, 0x0000, 0xffff, 0, 63),
  ]));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 5 }]);
  const snap = new Float64Array(SNAP_HEADER_SIZE + MAX_VOICES * SNAP_VOICE_STRIDE);
  render(eng, 2);
  const ts = eng.playheads[0].trackerState;
  const child = ts.backgroundVoices.find((v) => v.active && v.isLayerChild);
  assert.ok(child, "premise: the second layer is sounding");
  assert.equal(voice0(eng).notePan, 0x20 - 0x80, "premise: layer 0 sits hard left");
  assert.equal(child.notePan, 0xe0 - 0x80, "premise: layer 1 sits hard right");

  fillSnapshotInto(eng, 0, snap);
  const shown = snap[SNAP_HEADER_SIZE + SNAP_V_EFF_PAN];
  assert.ok(Math.abs(shown - 0x80) < 1,
    `two layers either side of centre read as centre, got ${shown}`);
});

test("a plain instrument's meters are its own voice, mean or no mean", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8030 },
  ]);
  const snap = new Float64Array(SNAP_HEADER_SIZE + MAX_VOICES * SNAP_VOICE_STRIDE);
  render(eng, 2);
  fillSnapshotInto(eng, 0, snap);
  assert.equal(snap[SNAP_HEADER_SIZE + SNAP_V_EFF_PAN], 0x30);
});

// ── the phase scale is the nibble-repeat's own factor ────────────────────
// 1088 = 64 entries x 17 steps, and 17 is what a nibble-repeat multiplies by.
// That is the whole point: a converted speed byte walks the SAME table entries
// as the tracker it came from, on the same ticks, rather than 6.25% fast (which
// is what a power-of-two 1024 would give).

test("a nibble-repeated speed reproduces the source tracker's LFO exactly", () => {
  for (let x = 1; x < 16; x++) {
    let trackerPos = 0;       // 8-bit phase, advanced by speed x 4, indexed >> 2
    let taudPos = 0;          // 1088-step phase, advanced by the repeated byte
    const speedByte = x * 0x11;
    for (let tick = 0; tick < 512; tick++) {
      const trackerSine = MOD_SIN_TABLE[(trackerPos >>> 2) & 0x3f];
      assert.equal(lfoSampleWide(taudPos, 0), trackerSine,
        `speed nibble ${x.toString(16)}, tick ${tick}`);
      trackerPos = (trackerPos + x * 4) & 0xff;
      taudPos = advanceLfoPhase(taudPos, speedByte);
    }
  }
});

test("the phase wraps on 1088, so a converted LFO never drifts", () => {
  let pos = 0;
  for (let i = 0; i < 1000; i++) pos = advanceLfoPhase(pos, 0x33);
  assert.equal(pos, (1000 * 0x33) % LFO_PHASE_STEPS);
  assert.ok(pos < LFO_PHASE_STEPS);
  // 17 steps to an entry: a whole-entry advance lands on entry boundaries.
  assert.equal(lfoSampleWide(17 * 5, 0), MOD_SIN_TABLE[5]);
  assert.equal(lfoSampleWide(17 * 5 + 16, 0), MOD_SIN_TABLE[5], "and holds across the entry");
  assert.equal(lfoSampleWide(17 * 6, 0), MOD_SIN_TABLE[6]);
});
