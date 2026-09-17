// Item 169.1 — envelope CARRY, the LOOP word's `c` bit (bit 6). With it set,
// a new note on a lane does not rewind that envelope's playhead: the
// envelope carries on from where the last note left it. Without it, every
// trigger starts at node 0, which is what the engine has always done.
//
// The item that asked for this is the ImpulseTracker portamento bug (item 169):
// in IT, a note carrying an instrument number AND a tone portamento silently
// keeps the envelope running whatever the Carry flag says. The Taud engine
// does NOT reproduce that (it re-attacks, item 124 / TAUD_ENGINE_SPEC §5.4) —
// carry is how a song says it on purpose instead, and the requirement was that
// with carry ON the "instrument byte + G" chain sound like the one written
// without instrument bytes. The third test here is exactly that comparison.
//
// The disqualifiers are IT's own (schismtracker player/effects.c, env_reset's
// `always` argument): a released note and an instrument change both rewind
// regardless of the bit.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";

setSamplingRate(32000);

const NOTE_C4 = 0x5000;
const NOTE_D4 = 0x5400;
const NOTE_E4 = 0x5800;

const ENV_PRESENT = 0x2000;
const ENV_CARRY = 0x0040;

/**
 * One looping instrument whose volume and pan envelopes both walk slowly
 * forward and hold, so "did the playhead rewind" is readable straight off
 * envIndex / envPanIndex. `carry` is a set of "vol" / "pan" names.
 */
function makeEngine(carry = new Set(), slot = 1) {
  const eng = new TaudEngine();
  for (let i = 0; i < 256; i++) eng.sampleBin[i] = i < 128 ? 0x00 : 0xff; // square
  eng.uploadInstrument(slot, makeRecord(carry));
  return eng;
}

function makeRecord(carry) {
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256);       // sampleLength
  w16(6, 32000);     // samplingRate @C4
  w16(12, 256);      // loopEnd
  rec[14] = 1;       // forward loop
  // Volume envelope: four nodes, each 1/16 s, walking 63 → 48 → 32 → 16.
  // minifloat 16 = 16/256 s = 62.5 ms ≈ one row at speed 6 / 125 BPM.
  const volVals = [63, 48, 32, 16];
  for (let n = 0; n < 4; n++) { rec[21 + n * 2] = volVals[n]; rec[22 + n * 2] = n < 3 ? 16 : 0; }
  w16(15, ENV_PRESENT | (carry.has("vol") ? ENV_CARRY : 0));
  // Pan envelope (nodes at bytes 71.., LOOP word 17) — same shape.
  const panVals = [0, 64, 128, 192];
  for (let n = 0; n < 4; n++) { rec[71 + n * 2] = panVals[n]; rec[72 + n * 2] = n < 3 ? 16 : 0; }
  w16(17, ENV_PRESENT | (carry.has("pan") ? ENV_CARRY : 0));
  rec[171] = 255;    // instGlobalVolume
  rec[182] = 0xff;   // default cutoff wide open (a zeroed record closes it)
  rec[196] = 255;    // defaultNoteVolume
  return rec;
}

/**
 * Pattern: row 0 triggers C4 with `inst`, and rows `at` carry the cells under
 * test. Every cell is {row, note, inst, effect, arg}.
 */
function uploadProbe(eng, cells, inst = 1) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = NOTE_C4 & 0xff; pat[1] = NOTE_C4 >>> 8; pat[2] = inst;
  for (const c of cells) {
    const o = c.row * 8;
    pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff;
    pat[o + 2] = c.inst ?? 0;
    pat[o + 5] = c.effect ?? 0;
    pat[o + 6] = (c.arg ?? 0) & 0xff; pat[o + 7] = ((c.arg ?? 0) >>> 8) & 0xff;
  }
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

/** A plain retrigger every other row, from row 2 to row 8. */
const RETRIGGERS = [2, 4, 6, 8].map((row) => ({ row, note: NOTE_D4, inst: 1 }));
/** The same notes tied by G, each naming the instrument — IT's "cue $1". */
const TIED_WITH_INST = [2, 4, 6, 8].map((row) => ({
  row, note: NOTE_D4, inst: 1, effect: EffectOp.OP_G, arg: 0x0140,
}));
/** …and written the way that sounds right today: no instrument byte at all. */
const TIED_NO_INST = [2, 4, 6, 8].map((row) => ({
  row, note: NOTE_D4, inst: 0, effect: EffectOp.OP_G, arg: 0x0140,
}));

test("carry OFF: every retrigger rewinds the envelope to node 0", () => {
  const eng = makeEngine();
  uploadProbe(eng, RETRIGGERS);
  const v = renderToRow(eng, 8);
  assert.equal(v.envIndex, 0, "volume playhead back at node 0");
  assert.equal(v.envPanIndex, 0, "pan playhead back at node 0");
});

test("carry ON: a retrigger continues the envelope instead", () => {
  const eng = makeEngine(new Set(["vol", "pan"]));
  uploadProbe(eng, RETRIGGERS);
  const v = renderToRow(eng, 8);
  assert.ok(v.envIndex > 0, `volume playhead kept walking (got ${v.envIndex})`);
  assert.ok(v.envPanIndex > 0, `pan playhead kept walking (got ${v.envPanIndex})`);
});

test("carry ON makes 'instrument byte + G' sound like the same chain without it", () => {
  // THE REQUIREMENT of item 169.1, in one comparison. Both engines run the
  // identical note chain; only the instrument bytes differ.
  const withInst = makeEngine(new Set(["vol", "pan"]));
  uploadProbe(withInst, TIED_WITH_INST);
  const a = renderToRow(withInst, 8);

  const withoutInst = makeEngine(new Set(["vol", "pan"]));
  uploadProbe(withoutInst, TIED_NO_INST);
  const b = renderToRow(withoutInst, 8);

  assert.equal(a.envIndex, b.envIndex, "same volume playhead");
  assert.equal(a.envPanIndex, b.envPanIndex, "same pan playhead");
  assert.ok(a.envIndex > 0, "…and it is a CONTINUED one, not two rewinds agreeing");

  // The premise: with carry off, the two spellings do NOT agree — which is the
  // bug report this item came from.
  const off = makeEngine();
  uploadProbe(off, TIED_WITH_INST);
  const c = renderToRow(off, 8);
  assert.equal(c.envIndex, 0, "carry off: the instrument byte re-attacks (item 124)");
});

test("carry is ignored after a key-off", () => {
  const eng = makeEngine(new Set(["vol", "pan"]));
  uploadProbe(eng, [
    { row: 2, note: 0x0001 },                     // key off
    { row: 8, note: NOTE_D4, inst: 1 },
  ]);
  const released = renderToRow(eng, 6);
  assert.equal(released.keyOff, true, "premise: the note is released at row 6");
  const v = renderToRow(eng, 8);
  assert.equal(v.envIndex, 0, "a released envelope rewinds whatever the bit says");
  assert.equal(v.envPanIndex, 0, "…both of them");
});

test("carry is ignored when the trigger changes instrument", () => {
  const eng = makeEngine(new Set(["vol", "pan"]));
  eng.uploadInstrument(2, makeRecord(new Set(["vol", "pan"])));
  uploadProbe(eng, [{ row: 8, note: NOTE_D4, inst: 2 }]);
  const v = renderToRow(eng, 8);
  assert.equal(v.instrumentId, 2, "premise: the instrument really changed");
  assert.equal(v.envIndex, 0, "the playhead belongs to the old envelope — rewind");
  assert.equal(v.envPanIndex, 0, "…both of them");
});

test("carry is per envelope: the bit is read from each LOOP word", () => {
  const eng = makeEngine(new Set(["pan"]));
  uploadProbe(eng, RETRIGGERS);
  const v = renderToRow(eng, 8);
  assert.equal(v.envIndex, 0, "volume has no carry bit — rewinds");
  assert.ok(v.envPanIndex > 0, `pan carries (got ${v.envPanIndex})`);
});

test("a fresh channel carries nothing — there is no playhead to keep", () => {
  const eng = makeEngine(new Set(["vol", "pan"]));
  uploadProbe(eng, [{ row: 8, note: NOTE_E4, inst: 1 }]);
  // Row 0's own trigger is the first note on the lane: it must start at 0.
  const first = renderToRow(eng, 0);
  assert.equal(first.envIndex, 0, "the very first note starts at node 0");
  assert.equal(first.envPanIndex, 0);
});
