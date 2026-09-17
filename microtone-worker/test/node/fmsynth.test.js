// Item 159 — Metainstrument type 4: an operator rack whose wiring is an RPN
// program in the record's own tail.
//
// Three things are worth pinning and nothing else really is. (1) The record
// round-trips, and a program that does not verify leaves the instrument silent
// rather than running the record's tail as code. (2) The rack is ONE voice: the
// modulators never reach the mix, and phase modulation moves the read without
// moving the trajectory — a modulated carrier must still be at the same place
// after N samples as an unmodulated one. (3) Operator 0 is the principal: gate
// it out and the note is silent, whatever the modulators would have done.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../src/engine/constants.js";
import {
  buildMetaRecord, makeMetaLayer, decodeFmProgram, defaultFmProgram, fmRecordBytes,
  TaudInst, FmOp, FM_WORD_MOD, FM_WORD_FB, FM_MAX_OPERATORS, FM_BUDGET_BYTES,
  META_TYPE_FM, META_TYPE_LAYERED,
} from "../../src/engine/inst.js";
import { fmReferencedOperators } from "../../src/engine/fm.js";
import { EffectOp } from "../../src/engine/tables.js";

setSamplingRate(32000);

const op = (slot, mix = 159, detune = 0, lo = 0x0000, hi = 0xffff, vlo = 0, vhi = 63) =>
  makeMetaLayer(slot, mix, detune, lo, hi, vlo, vhi);

/** A 256-frame looping sine in `slot` — a single-cycle waveform, which is what
 *  makes the modulation index read as "cycles" the way §7.6 says it does.
 *  `nna` / `dct` / `dca` / `fadeout` are the voice-lifetime fields item 191 is
 *  about: on an operator 0 they are the RACK's. */
function uploadCycle(eng, slot, ptr, { nna = 0, dct = 0, dca = 0, fadeout = 0 } = {}) {
  for (let i = 0; i < 256; i++) {
    eng.sampleBin[ptr + i] = 128 + Math.round(120 * Math.sin((2 * Math.PI * i) / 256));
  }
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  rec[0] = ptr & 0xff; rec[1] = (ptr >> 8) & 0xff; rec[2] = (ptr >> 16) & 0xff;
  w16(4, 256);    // sampleLength
  w16(6, 32000);  // samplingRate @C4 — playback rate 1.0
  w16(12, 256);   // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; // instGlobalVolume
  rec[172] = fadeout & 0xff;              // volume fadeout, low byte
  rec[173] = (fadeout >> 8) & 0x0f;       // …and its high nibble
  rec[186] = nna & 0x03;                  // instrument flag: New Note Action
  rec[195] = (dct & 3) | ((dca & 3) << 2); // Duplicate Check type + action
  rec[196] = 255; // defaultNoteVolume
  eng.uploadInstrument(slot, rec);
}

function makeEngine() {
  const eng = new TaudEngine();
  uploadCycle(eng, 1, 0);
  uploadCycle(eng, 2, 512);
  return eng;
}

function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.vol !== undefined) pat[o + 3] = c.vol & 0x3f;   // selector 0 = SET
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

/** Render `chunks` chunks, returning the interleaved U8 of the LAST one. */
function render(eng, chunks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < chunks; i++) eng.renderChunk(0, out);
  return out;
}

const ts0 = (eng) => eng.playheads[0].trackerState;
const voice0 = (eng) => ts0(eng).voices[0];
const operators = (eng) => ts0(eng).backgroundVoices.filter((v) => v.fmOperator);
/** …the ones the CHANNEL is driving, as against a ghosted rack's (item 191). */
const liveOperators = (eng) => operators(eng).filter((v) => v.fmParent === voice0(eng));
/** Every rack still sounding in the background — one per ghosted note. */
const ghostRacks = (eng) =>
  ts0(eng).backgroundVoices.filter((v) => v.fmRig !== null && v.active);

/** Peak deflection from the U8 midpoint over one rendered chunk. */
function peak(out) {
  let m = 0;
  for (let i = 0; i < out.length; i += 2) m = Math.max(m, Math.abs(out[i] - 128));
  return m;
}

// ── the record ───────────────────────────────────────────────────────────

test("a type-4 record round-trips its type, rack and algorithm", () => {
  const rec = buildMetaRecord([op(0x101), op(0x102)], { type: META_TYPE_FM });
  assert.equal(rec[0] >>> 4, META_TYPE_FM, "byte 0's high nibble is the type");
  assert.equal(rec[1], 2);
  assert.equal(rec[2], 0xff);
  assert.equal(rec[3], 0xff);
  const inst = new TaudInst(5);
  inst.loadRecord(rec);
  assert.ok(inst.isMeta && inst.isFm);
  assert.equal(inst.metaType, META_TYPE_FM);
  assert.equal(inst.metaLayers.length, 2);
  // The default algorithm is the chain: push op1, then op0 modulated by it.
  assert.deepEqual([...inst.fmProgram], [1, FM_WORD_MOD | 0]);
});

test("a layered record still reads as type 0 and carries no program", () => {
  const inst = new TaudInst(5);
  inst.loadRecord(buildMetaRecord([op(0x101), op(0x102)]));
  assert.equal(inst.metaType, META_TYPE_LAYERED);
  assert.equal(inst.isFm, false);
  assert.equal(inst.fmProgram, null);
});

test("an FM rack MUTES an unusable operator in place; a layered meta drops it", () => {
  // Operator 0 points at nothing. Compacting the rack would slide operator 1
  // into slot 0 and rewire every word of the algorithm under it.
  const layers = [op(0), op(0x102)];
  const fm = new TaudInst(5);
  fm.loadRecord(buildMetaRecord(layers, { type: META_TYPE_FM }));
  assert.equal(fm.metaLayers.length, 2, "the rack keeps its shape");
  assert.equal(fm.metaLayers[0].instIdx, 0, "…with the dead operator muted");
  assert.equal(fm.metaLayers[1].instIdx, 0x102);

  const layered = new TaudInst(5);
  layered.loadRecord(buildMetaRecord(layers));
  assert.equal(layered.metaLayers.length, 1, "a layer table compacts as it always has");
  assert.equal(layered.metaLayers[0].instIdx, 0x102);
});

test("a program that does not verify is no program at all", () => {
  const bad = (words) => {
    const rec = buildMetaRecord([op(0x101), op(0x102)],
      { type: META_TYPE_FM, program: Uint16Array.from(words) });
    const inst = new TaudInst(5);
    inst.loadRecord(rec);
    return inst.fmProgram;
  };
  assert.equal(bad([FM_WORD_MOD | 0]), null, "modulated push with an empty stack");
  assert.equal(bad([0, 1, FmOp.ADD, FmOp.ADD]), null, "one ADD too many");
  assert.equal(bad([7]), null, "operator 7 of a two-operator rack");
  assert.equal(bad([]), null, "nothing to output");
  assert.notEqual(bad([0, 1, FmOp.ADD]), null, "…and a well-formed one survives");
});

test("an unknown word is rejected, not stepped over", () => {
  // $0Cxx is not an operand class and $FF7F is not an operator. Reading past
  // either would be running the record's tail as code.
  const rec = buildMetaRecord([op(0x101)], { type: META_TYPE_FM });
  const at = 4 + 10;
  rec[at] = 0x00; rec[at + 1] = 0x0c;
  assert.equal(decodeFmProgram(rec, at, 1), null);
  rec[at] = 0x7f; rec[at + 1] = 0xff;
  assert.equal(decodeFmProgram(rec, at, 1), null);
});

test("the rack and the algorithm share one 252-byte budget", () => {
  // 16 operators is the cap precisely so the algorithm always has room left.
  assert.ok(fmRecordBytes(FM_MAX_OPERATORS, defaultFmProgram(FM_MAX_OPERATORS).length)
    <= FM_BUDGET_BYTES);
  // …and the packer never writes a word it cannot terminate. NEG is depth
  // neutral, so this program stays well-formed wherever the budget cuts it.
  const long = new Uint16Array(200).fill(FmOp.NEG);
  const rec = buildMetaRecord([op(0x101)], {
    type: META_TYPE_FM, program: Uint16Array.from([0, ...long]),
  });
  const inst = new TaudInst(5);
  inst.loadRecord(rec);
  assert.notEqual(inst.fmProgram, null, "the truncated program still verifies");
  assert.ok(inst.fmProgram.length < 201, "…because it WAS truncated");
  assert.ok(fmRecordBytes(1, inst.fmProgram.length) <= FM_BUDGET_BYTES);
});

test("only $00xx and $04xx make an operator sound", () => {
  // A feedback tap reads what an operator left LAST sample, so it can never be
  // the thing that brings one to life.
  const used = fmReferencedOperators(
    Uint16Array.from([FM_WORD_FB | 2, FM_WORD_MOD | 1, 0, FmOp.ADD]), 3);
  assert.deepEqual([...used], [1, 1, 0]);
});

// ── the engine ───────────────────────────────────────────────────────────

test("a rack is ONE voice: its modulators never reach the mix", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  const ops = operators(eng);
  assert.equal(ops.length, 1, "operator 1 spawned as a background voice");
  assert.ok(ops[0].active, "…and it is sounding");
  assert.notEqual(voice0(eng).fmRig, null, "the channel's voice carries the rack");
  assert.equal(voice0(eng).fmRig.voices[0], voice0(eng), "operator 0 IS that voice");
  // The proof that the operand is not also a sound: silence the CARRIER and
  // the lane goes quiet even though the modulator is still running at full
  // level. What is left is the output dither, which is one LSB of it.
  const quiet = makeEngine();
  quiet.uploadInstrument(4, buildMetaRecord([op(1, 0), op(2, 255)], { type: META_TYPE_FM }));
  loadSong(quiet, [{ row: 0, note: 0x5000, inst: 4 }]);
  assert.equal(operators(quiet).length, 0, "premise: nothing rendered yet");
  assert.ok(peak(render(quiet, 3)) <= 1,
    "a carrier at silence is silence, not a modulator solo");
});

test("modulation moves the read, not the trajectory", () => {
  const straight = makeEngine();
  straight.uploadInstrument(3, buildMetaRecord([op(1)], { type: META_TYPE_FM }));
  loadSong(straight, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(straight, 4);

  const modulated = makeEngine();
  modulated.uploadInstrument(3, buildMetaRecord([op(1), op(2, 200, 4096)],
    { type: META_TYPE_FM }));
  loadSong(modulated, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(modulated, 4);

  assert.equal(voice0(modulated).samplePos, voice0(straight).samplePos,
    "the carrier is exactly where it would have been unmodulated");
});

test("modulation changes the SIGNAL", () => {
  const straight = makeEngine();
  straight.uploadInstrument(3, buildMetaRecord([op(1)], { type: META_TYPE_FM }));
  loadSong(straight, [{ row: 0, note: 0x5000, inst: 3 }]);
  const a = render(straight, 3);

  const modulated = makeEngine();
  modulated.uploadInstrument(3, buildMetaRecord([op(1), op(2, 200, 4096)],
    { type: META_TYPE_FM }));
  loadSong(modulated, [{ row: 0, note: 0x5000, inst: 3 }]);
  const b = render(modulated, 3);

  assert.notDeepEqual([...a], [...b]);
  assert.ok(peak(b) > 0, "…and it is still making a sound");
});

test("an operator the algorithm never names costs nothing", () => {
  const eng = makeEngine();
  // Three operators, an algorithm that reads two of them.
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2), op(2)], {
    type: META_TYPE_FM, program: Uint16Array.from([1, FM_WORD_MOD | 0]),
  }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  assert.equal(operators(eng).length, 1, "operator 2 was never spawned");
  assert.equal(voice0(eng).fmRig.voices[2], null);
});

test("operator 0 is the principal: gate it out and the note is silent", () => {
  const eng = makeEngine();
  // Operator 0 covers nothing at C-4; operator 1 covers everything.
  eng.uploadInstrument(3, buildMetaRecord([
    op(1, 159, 0, 0x8000, 0xffff), op(2),
  ], { type: META_TYPE_FM }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 2);
  assert.equal(voice0(eng).active, false);
  assert.equal(voice0(eng).fmRig, null);
  assert.equal(operators(eng).length, 0, "and nothing was spawned to sound alone");
});

test("a rack with no verifiable algorithm is silent", () => {
  const eng = makeEngine();
  const rec = buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM });
  const at = 4 + 20;
  rec[at] = 0x00; rec[at + 1] = 0x0c;  // an unknown word where the program starts
  eng.uploadInstrument(3, rec);
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 2);
  assert.equal(voice0(eng).active, false);
});

test("retriggering the channel takes the live rack with it", () => {
  const eng = makeEngine();
  // Operator 0 at Note Cut, so the outgoing rack leaves nothing behind and
  // what is left is purely what the CHANNEL is still driving.
  uploadCycle(eng, 1, 0, { nna: 1 });
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  uploadCycle(eng, 5, 1024);
  loadSong(eng, [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5000, inst: 5 },
  ]);
  render(eng, CHUNKS_PER_TICK * 6 + 1);
  assert.equal(voice0(eng).fmRig, null, "the plain note dropped the rack");
  assert.equal(liveOperators(eng).length, 0, "…and its operands went with it");
});

test("a rack's operators die with the note rather than ageing on", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  assert.equal(operators(eng).length, 1);
  voice0(eng).active = false;               // operator 0's own note ended
  render(eng, CHUNKS_PER_TICK + 1);
  assert.equal(operators(eng).length, 0);
  assert.equal(ts0(eng).backgroundVoices.length, 0, "…and nothing was left behind");
});

// ── the principal's voice lifetime (item 191) ───────────────────────────────

test("operator 0's New Note Action is the rack's", () => {
  // Operator 0 is the principal, so the note's lifetime is its business —
  // which is what makes a rack of bells polyphonic. A rack that could not
  // ghost was monophonic whatever its instrument said: the next row cut it.
  const racksAfterSecondNote = (nna) => {
    const eng = makeEngine();
    uploadCycle(eng, 1, 0, { nna, fadeout: 8 });
    eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
    loadSong(eng, [
      { row: 0, note: 0x5000, inst: 3 },
      { row: 1, note: 0x5400, inst: 3 },
    ]);
    render(eng, CHUNKS_PER_TICK * 6 + 1);
    return ghostRacks(eng);
  };
  assert.equal(racksAfterSecondNote(1).length, 0, "Note Cut leaves nothing behind");
  const fading = racksAfterSecondNote(3);
  assert.equal(fading.length, 1, "Note Fade rings the old note on");
  assert.ok(fading[0].noteFading, "…fading, as the instrument asked");
  const off = racksAfterSecondNote(0);
  assert.equal(off.length, 1, "Note Off releases it");
  assert.ok(off[0].keyOff);
});

test("a ghosted rack keeps its operands, and keeps them to itself", () => {
  const eng = makeEngine();
  uploadCycle(eng, 1, 0, { nna: 2 }); // Continue
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5400, inst: 3 },
  ]);
  render(eng, CHUNKS_PER_TICK * 6 + 1);
  const ghosts = ghostRacks(eng);
  assert.equal(ghosts.length, 1);
  const ghost = ghosts[0];
  assert.equal(ghost.fmRig.voices[0], ghost, "the ghost IS its own operator 0");
  const mine = operators(eng).filter((v) => v.fmParent === ghost);
  assert.equal(mine.length, 1, "the modulator was ghosted beside its carrier");
  assert.equal(ghost.fmRig.voices[1], mine[0], "…and re-hung on the ghost's own rig");
  assert.equal(liveOperators(eng).length, 1, "the incoming rack has its own, untouched");
  assert.equal(ts0(eng).backgroundVoices.length, 3);
});

test("a ghosted rack still sounds the PATCH, not operator 0's bare sample", () => {
  // Operator 0's rectangle covers the first note only, so the SECOND row's
  // rack is silent and everything left in the mix belongs to the ghost. Turn
  // the modulator's level down and the remaining signal changes — which it
  // could only do if the ghost is still reading a modulator.
  const run = (modMix) => {
    const eng = makeEngine();
    uploadCycle(eng, 1, 0, { nna: 2 });
    eng.uploadInstrument(3, buildMetaRecord([
      op(1, 159, 0, 0x0000, 0x5200), op(2, modMix, 4096),
    ], { type: META_TYPE_FM }));
    loadSong(eng, [
      { row: 0, note: 0x5000, inst: 3 },
      { row: 1, note: 0x5400, inst: 3 },
    ]);
    render(eng, CHUNKS_PER_TICK * 6 + 1);
    assert.equal(voice0(eng).active, false, "premise: the new note sounds nothing");
    return render(eng, 2);
  };
  const modulated = run(200);
  assert.ok(peak(modulated) > 2, "the ghost of the first note is still sounding");
  assert.notDeepEqual([...modulated], [...run(0)],
    "…and it is the patch, not the carrier on its own");
});

test("operator 0's Duplicate Check is the rack's", () => {
  // The rack's own slot is never what a voice is playing — a metainstrument is
  // not a sample — so a check asked about it answers "no" every time and no
  // rack was ever duplicate-checked at all. It is asked about the principal.
  const racksAfterSecondNote = (dct) => {
    const eng = makeEngine();
    uploadCycle(eng, 1, 0, { nna: 2, dct, dca: 0 }); // …and Duplicate Check → Note Cut
    eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
    loadSong(eng, [
      { row: 0, note: 0x5000, inst: 3 },
      { row: 1, note: 0x5400, inst: 3 },
    ]);
    render(eng, CHUNKS_PER_TICK * 6 + 1);
    return ghostRacks(eng).length;
  };
  assert.equal(racksAfterSecondNote(0), 1, "with the check off, the old rack rings on");
  assert.equal(racksAfterSecondNote(3), 0, "DCT 3 takes it out before the NNA can ghost it");
});

test("the ADD word sums two carriers", () => {
  const one = makeEngine();
  one.uploadInstrument(3, buildMetaRecord([op(1)], { type: META_TYPE_FM }));
  loadSong(one, [{ row: 0, note: 0x5000, inst: 3 }]);
  const solo = peak(render(one, 3));

  const both = makeEngine();
  both.uploadInstrument(3, buildMetaRecord([op(1), op(1)], {
    type: META_TYPE_FM, program: Uint16Array.from([0, 1, FmOp.ADD]),
  }));
  loadSong(both, [{ row: 0, note: 0x5000, inst: 3 }]);
  const summed = peak(render(both, 3));

  assert.ok(summed > solo, `two carriers are louder than one (${summed} vs ${solo})`);
});

// ── the note's volume, and the operator's level ──────────────────────────────

/** `samples` frames of the LEFT lane, as ±1 floats. */
function renderMono(eng, samples) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const buf = new Float64Array(samples);
  for (let n = 0; n < samples;) {
    eng.renderChunk(0, out);
    for (let i = 0; i < TRACKER_CHUNK && n < samples; i++, n++) {
      buf[n] = (out[i * 2] - 128) / 128;
    }
  }
  return buf;
}

/** Amplitude at `hz`, by Goertzel over the whole buffer. */
function tone(buf, hz, from = 0) {
  const w = (2 * Math.PI * hz) / SAMPLING_RATE, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < buf.length; i++) { const s = buf[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (buf.length - from);
}

test("an operator's level is its modulation index, not the note's volume", () => {
  // The volume column must change what a rack SOUNDS LIKE not at all — only how
  // loud it is. §5.5.1's list of what an operator's value is multiplied by
  // leaves the note and lane volume out on purpose: the mixer applies them
  // once, to the finished patch, through operator 0. Fold them into the
  // operators as well and a modulator's output — which IS a phase deviation —
  // shrinks with the volume column, so a patch played quietly plays duller too.
  const measure = (vol) => {
    const eng = makeEngine();
    // Operator 1 modulates operator 0 at −6 dB: half a cycle of deviation, deep
    // enough that most of the signal is sidebands rather than carrier.
    eng.uploadInstrument(3, buildMetaRecord([op(1), op(2, 111)], { type: META_TYPE_FM }));
    loadSong(eng, [{ row: 0, note: 0x5000, inst: 3, vol }]);
    const buf = renderMono(eng, 8192);
    const from = 1024;                            // past the attack ramp
    const carrier = 2 * tone(buf, SAMPLING_RATE / 256, from);
    let sq = 0;
    for (let i = from; i < buf.length; i++) sq += buf[i] * buf[i];
    const rms = Math.sqrt(sq / (buf.length - from));
    // Everything that is not the carrier, over the carrier: the patch's colour.
    return { carrier, colour: Math.sqrt(Math.max(0, rms * rms - carrier * carrier / 2)) /
                              (carrier / Math.SQRT2) };
  };
  const loud = measure(63);
  const quiet = measure(24);
  assert.ok(loud.colour > 1, `the modulator should dominate (${loud.colour})`);
  // Loudness follows the column…
  const gain = quiet.carrier / loud.carrier;
  assert.ok(Math.abs(gain - 24 / 63) < 0.05, `volume column should scale linearly (${gain})`);
  // …and the timbre does not. Fold the column into the operators and this ratio
  // collapses by more than half.
  assert.ok(Math.abs(quiet.colour - loud.colour) < 0.1 * loud.colour,
    `modulation index moved with the volume column: ${loud.colour} → ${quiet.colour}`);
});

test("S $73..$76 reaches a rack: the pattern can override its principal's NNA", () => {
  // Operator 0 says Note Cut, so the rack leaves nothing behind on its own —
  // and a per-note override is the pattern's way of saying otherwise, which on
  // a metainstrument's lane used to be a no-op (item 191.1).
  const run = (rows) => {
    const eng = makeEngine();
    uploadCycle(eng, 1, 0, { nna: 1, fadeout: 8 });
    eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
    loadSong(eng, rows);
    render(eng, CHUNKS_PER_TICK * 6 + 1);
    return ghostRacks(eng);
  };
  assert.equal(run([
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5400, inst: 3 },
  ]).length, 0, "premise: the principal's own NNA cuts it");

  const fading = run([
    { row: 0, note: 0x5000, inst: 3, effect: EffectOp.OP_S, arg: 0x7600 },
    { row: 1, note: 0x5400, inst: 3 },
  ]);
  assert.equal(fading.length, 1, "S $76 rang the whole rack on instead");
  assert.ok(fading[0].noteFading);
  assert.notEqual(fading[0].fmRig.voices[1], null, "…whole, modulator included");
});

test("a ghosted rack takes no row-driven effect — it is a background voice", () => {
  // The ghost's operands share the lane with the note that displaced them,
  // so every lane-scoped walk has to tell them apart from the LIVE rack's
  // (isSoundingChild) or a crusher written on the next row would reach back
  // into a note the pattern has already let go.
  const eng = makeEngine();
  uploadCycle(eng, 1, 0, { nna: 2 }); // Continue, so the first rack rings on
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5400, inst: 3, effect: EffectOp.OP_8, arg: 0x1304 },
  ]);
  render(eng, CHUNKS_PER_TICK * 6 + 1);
  const ghost = ghostRacks(eng)[0];
  assert.ok(ghost, "premise: the first rack is still ringing");
  assert.equal(voice0(eng).bitcrusherDepth, 3, "the live rack was crushed");
  assert.equal(liveOperators(eng)[0].bitcrusherDepth, 3, "…its operand too");
  assert.equal(ghost.bitcrusherDepth, 0, "the ghost was not");
  const ghostOp = operators(eng).find((v) => v.fmParent === ghost);
  assert.equal(ghostOp.bitcrusherDepth, 0, "…and neither was its operand");
});
