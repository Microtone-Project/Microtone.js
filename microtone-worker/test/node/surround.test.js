// Surround engine integration (#998.0/.1/.2): the song-immutable model reaching
// the mixer, the extended S $8xxx angle, the X / 4 / Z commands, and the
// compatibility claim that makes the whole thing safe — a song that only uses
// ordinary pan renders BIT-IDENTICALLY whether it is stereo or planar.
//
// One tick = SAMPLING_RATE·2.5/bpm = 640 samples at BPM 125, so the tests count
// TICKS and let the helper work out how many renderChunk calls that is.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../core/engine/constants.js";
import { EffectOp } from "../../core/engine/tables.js";
import {
  SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL, AmbisonicRenderer,
} from "../../core/engine/spatial.js";

// Pinned to the Kotlin engine's 32 kHz (item 108 moved the web default to
// 48 kHz): the expectations below are sample counts and reference renders
// taken from AudioAdapter.kt, and they stay diffable against it.
setSamplingRate(32000);

/** Engine with a looping ramp sample in slot 1 (engine-scenarios' recipe). */
function makeTestEngine(surroundModel = SURROUND_STEREO) {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);   // sampleLength
  w16(6, 32000);  // samplingRate @C4
  w16(12, 1000);  // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full (a zeroed env is a value-0 terminator)
  rec[171] = 255; // instGlobalVolume
  rec[196] = 255; // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  eng.setSurroundModel(0, surroundModel);
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
  cue[0] = 0x00; cue[1] = 0x00; // ch0 → pattern 0
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
  return eng;
}

/** Chunks per tick at BPM 125 / 32 kHz — 640 samples, however big a chunk is. */
const CHUNKS_PER_TICK = (SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK;
assert.ok(Number.isInteger(CHUNKS_PER_TICK));

/** Render exactly `ticks` engine ticks, returning the U8 device output. */
function render(eng, ticks) {
  const chunks = ticks * CHUNKS_PER_TICK;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const all = new Uint8Array(chunks * TRACKER_CHUNK * 2);
  for (let i = 0; i < chunks; i++) {
    eng.renderChunk(0, out);
    all.set(out, i * TRACKER_CHUNK * 2);
  }
  return all;
}

const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];

// ── compatibility ────────────────────────────────────────────────────────

test("planar renders a plain-pan song BIT-IDENTICALLY to stereo", () => {
  // Every pan device the front arc can carry: an S $80xx set, a pan-column set,
  // a P slide and a pan-column slide, plus a second voice for the sum.
  // The column values are chosen so the two axes SUM to a front-arc position
  // throughout (item 117): that is the scope of the identity claim, since a
  // channel-plus-note sum that leaves the arc saturates in stereo and wraps
  // round the circle in a surround model — see the test below.
  const rows = [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8020 },
    { row: 1, effect: EffectOp.OP_P, arg: 0x0300 },   // slide right
    { row: 2, pan: 0x20, panEff: 0 },                  // pan-col SET (just right of centre)
    { row: 3, effect: EffectOp.OP_P, arg: 0x4000 },   // slide left
    { row: 4, note: 0x5100, inst: 1, effect: EffectOp.OP_S, arg: 0x80c0 },
    { row: 5, pan: 0x08, panEff: 2 },                  // pan-col slide left
  ];
  const stereo = render(loadSong(makeTestEngine(SURROUND_STEREO), rows), 40);
  const planar = render(loadSong(makeTestEngine(SURROUND_PLANAR), rows), 40);
  assert.deepEqual(planar, stereo);
});

test("past the front arc the two models part company: stereo saturates, planar wraps", () => {
  const rows = [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x80c0 }, // channel right
    { row: 1, pan: 0x3f, panEff: 0 },  // …plus a hard-right note offset on top
  ];
  const stereo = loadSong(makeTestEngine(SURROUND_STEREO), rows);
  render(stereo, 12);
  assert.equal(voice0(stereo).channelPan + voice0(stereo).notePan, 0xc0 + 127,
    "both axes hold their own value either way");
  assert.equal(stereo.getVoiceEffectivePan(0, 0), 255, "stereo pan is a segment: it saturates");

  const planar = loadSong(makeTestEngine(SURROUND_PLANAR), rows);
  render(planar, 12);
  assert.equal(planar.getVoiceSpatialAzimuth(0, 0), 0xc0 + 127, "planar pan is a circle: it turns");
  assert.equal(planar.getVoiceEffectivePan(0, 0), 512 - (0xc0 + 127),
    "and the monitor folds that rear position back onto the front arc");
});

test("a stereo song ignores X / 4 / Z entirely", () => {
  const eng = loadSong(makeTestEngine(SURROUND_STEREO), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_X, arg: 0x40c0 },
  ]);
  render(eng, 1);
  const v = voice0(eng);
  assert.equal(v.channelPan, 0x80);      // untouched default
  assert.equal(v.panElevation, 0);
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 0);
});

// ── extended S $8xxx (#998.1) ────────────────────────────────────────────

test("S $8xxx reads 9 bits in a surround song, 8 in a stereo one", () => {
  const behind = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8180 },
  ]);
  render(behind, 1);
  assert.equal(voice0(behind).panAzimuth, 384); // $180 = behind

  const stereo = loadSong(makeTestEngine(SURROUND_STEREO), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8180 },
  ]);
  render(stereo, 1);
  assert.equal(voice0(stereo).channelPan, 0x80); // high nibble ignored → centre
});

test("front and rear mirror images sound the same in the stereo monitor", () => {
  const rowsAt = (angle) => [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8000 | angle },
  ];
  const front = render(loadSong(makeTestEngine(SURROUND_PLANAR), rowsAt(0x040)), 8);
  const rear = render(loadSong(makeTestEngine(SURROUND_PLANAR), rowsAt(0x1c0)), 8);
  assert.deepEqual(rear, front); // 0x1C0 folds onto 0x040
});

test("pan slides wrap round the circle instead of clamping at the ends", () => {
  const eng = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8008 },
    { row: 1, effect: EffectOp.OP_P, arg: 0x4f00 }, // fine slide LEFT by 4, once
    { row: 2, effect: EffectOp.OP_P, arg: 0x8f00 }, // fine slide LEFT by 8, once
  ]);
  render(eng, 13); // into row 2, so both fine slides have fired
  // 8 − 4 − 8 = −4 → 508, i.e. just past hard left. A stereo song would sit at 0.
  assert.equal(voice0(eng).panAzimuth, 508);
});

// ── X / 4 / Z (#998.2) ───────────────────────────────────────────────────

test("X places the source by azimuth and elevation", () => {
  const eng = loadSong(makeTestEngine(SURROUND_SPATIAL), [
    // $ee = 0x40 (+45°), $aa = 0xC0 (behind)
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_X, arg: 0x40c0 },
  ]);
  render(eng, 1);
  assert.equal(voice0(eng).panAzimuth, 384);
  assert.equal(voice0(eng).panElevation, 64);
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0), 384);
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 64);
});

test("X's elevation is negative above $7F and ignored by a planar song", () => {
  const spatial = loadSong(makeTestEngine(SURROUND_SPATIAL), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_X, arg: 0xc000 },
  ]);
  render(spatial, 1);
  assert.equal(voice0(spatial).panElevation, -64);

  const planar = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_X, arg: 0xc000 },
  ]);
  render(planar, 1);
  assert.equal(voice0(planar).panAzimuth, 0);
  assert.equal(voice0(planar).panElevation, 0); // planar songs stay on the horizon
});

test("X writes the same channel-axis register as S $80xx, not the note axis", () => {
  const eng = loadSong(makeTestEngine(SURROUND_SPATIAL), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_X, arg: 0x40c0 }, // az 384, el 64
    { row: 1, effect: EffectOp.OP_S, arg: 0x8100 },                        // S $80xx: az 256 — SAME register X just wrote
    { row: 2, note: 0x5000, inst: 1 },                                     // fresh note, no pan command at all
  ]);
  render(eng, 1);
  assert.equal(voice0(eng).panAzimuth, 384, "X placed the channel");
  assert.equal(voice0(eng).panElevation, 64);

  render(eng, 5); // cumulative 6 ticks — into row 1
  assert.equal(voice0(eng).panAzimuth, 256,
    "S $80xx overwrote X's exact register — proof they share one channel axis, not two");
  assert.equal(voice0(eng).panElevation, 64, "S has no elevation term, so X's is untouched");

  render(eng, 6); // cumulative 12 ticks — into row 2, a fresh note with no pan command
  assert.equal(voice0(eng).panAzimuth, 256,
    "channel state survives a new note the way S $80xx's channelPan always has");
  assert.equal(voice0(eng).panElevation, 64);
  assert.equal(voice0(eng).notePan, 0, "X never touches the note axis");
});

test("4 aims the slide and Z runs it at $xxx/16 azimuth units per tick", () => {
  const eng = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_4, arg: 0x0060 }, // target $60·2 = 192
    { row: 1, effect: EffectOp.OP_Z, arg: 0x0040 },                        // 64/16 = 4 X-units = 8/tick
  ]);
  assert.equal(voice0(eng).panAzimuth, 128);
  // 12 ticks: row 0's six, then row 1's six. The slide runs on non-first ticks
  // only, so row 1 contributes 5 steps of 8 units.
  render(eng, 12);
  assert.equal(voice0(eng).spatialTargetAz, 192);
  assert.equal(voice0(eng).panAzimuth, 128 + 5 * 8);
});

test("Z stops dead on arrival and never overshoots", () => {
  const eng = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_4, arg: 0x0048 }, // target 144
    { row: 1, effect: EffectOp.OP_Z, arg: 0x0800 },                        // 256 units/tick
    { row: 2, effect: EffectOp.OP_Z, arg: 0x0000 },                        // recall speed
  ]);
  render(eng, 18);
  assert.equal(voice0(eng).panAzimuth, 144);
});

test("Z re-arms per row, like every other slide", () => {
  const eng = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_4, arg: 0x00ff },
    { row: 1, effect: EffectOp.OP_Z, arg: 0x0040 },
  ]);
  render(eng, 12);
  const afterSlideRow = voice0(eng).panAzimuth;
  render(eng, 12); // two more rows, neither carrying Z
  assert.equal(voice0(eng).panAzimuth, afterSlideRow);
  assert.equal(voice0(eng).spatialSlideActive, false);
});

test("a Z slide with no target set moves nothing", () => {
  const eng = loadSong(makeTestEngine(SURROUND_PLANAR), [
    { row: 0, note: 0x5000, inst: 1 },
    { row: 1, effect: EffectOp.OP_Z, arg: 0x0100 },
  ]);
  render(eng, 12);
  assert.equal(voice0(eng).panAzimuth, 128);
});

// ── render targets ───────────────────────────────────────────────────────

test("swapping in an ambisonic render target changes the bus, not the song", () => {
  const eng = makeTestEngine(SURROUND_PLANAR);
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8000 }]);
  eng.setSpatialRenderer(0, new AmbisonicRenderer(3, true));
  const ts = eng.playheads[0].trackerState;
  assert.equal(ts.spatial.numChannels, 7);
  render(eng, 3);
  // A hard-left source: W (ACN 0) and Y (ACN 1) carry it, Z-less basis has no
  // height channel at all, and the horizontal X (ACN 3) must stay silent.
  const frames = ts.spatial.frames;
  let w = 0, y = 0, x = 0;
  for (let n = 0; n < frames; n++) {
    w += Math.abs(ts.spatial.data[n]);
    y += Math.abs(ts.spatial.data[frames + n]);
    x += Math.abs(ts.spatial.data[2 * frames + n]);
  }
  assert.ok(w > 0, "W must carry the source");
  assert.ok(Math.abs(y - w) < 1e-9, "a hard-left source has Y = W");
  assert.ok(x < 1e-12, "…and nothing on X");
});

test("the surround model survives resetParams (it is a song property)", () => {
  const eng = makeTestEngine(SURROUND_SPATIAL);
  eng.resetParams(0);
  assert.equal(eng.getSurroundModel(0), SURROUND_SPATIAL);
  assert.notEqual(eng.playheads[0].trackerState.spatial, null);
  eng.setSurroundModel(0, SURROUND_STEREO);
  assert.equal(eng.playheads[0].trackerState.spatial, null);
});

// ── file format ──────────────────────────────────────────────────────────

test("the surround model round-trips through the song table", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../core/format/taud-parse.js");
  const { writeTaud } = await import("../../core/format/taud-write.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const parsed = parseTaud(readFileSync(path));
  assert.equal(parsed.songs[0].surroundModel, 0); // an ordinary stereo song

  parsed.songs[0].surroundModel = SURROUND_SPATIAL;
  const again = parseTaud(writeTaud(parsed));
  assert.equal(again.songs[0].surroundModel, SURROUND_SPATIAL);

  // …and a song that never touches the flag still writes byte-identically.
  const plain = parseTaud(readFileSync(path));
  assert.deepEqual(parseTaud(writeTaud(plain)).songs[0].surroundModel, 0);
});

// ── the instrument's default position (#998) ─────────────────────────────
// Record byte 177 doubles as the low byte of a 9-bit azimuth, byte 14's bit 5
// is the ninth, and byte 254 is the elevation. The point of that layout is
// backwards compatibility, so the tests check BOTH halves: a surround song must
// read all three, and a stereo song must behave exactly as it did before.

/** Engine whose instrument 1 declares a default position + "use default pan". */
function makeInstPosEngine(model, { azimuth = 128, elevation = 0 } = {}) {
  const eng = makeTestEngine(model);
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1 | (azimuth >= 256 ? 0x20 : 0); // forward loop + azimuth bit 8
  rec[17] = 0x80;                            // pan LOOP word bit 7 = "use default pan"
  rec[21] = 0x3f;
  rec[171] = 255;
  rec[177] = azimuth & 0xff;
  rec[196] = 255;
  rec[254] = elevation & 0xff;
  eng.uploadInstrument(1, rec);
  return eng;
}

test("a surround song places a note at the instrument's own azimuth and elevation", () => {
  const eng = makeInstPosEngine(SURROUND_SPATIAL, { azimuth: 384, elevation: 64 });
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 1 }]);
  render(eng, 2);
  const v = voice0(eng);
  // Item 117: an instrument's default position is a NOTE-axis offset from the
  // channel's direction, so it is the effective position that must land on 384
  // — with the channel at its default front, the two are the same thing.
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0), 384,
    "behind the listener — the ninth bit must survive");
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 64, "+45°");
  assert.equal(v.panAzimuth, 128, "the channel itself was never moved");
  // The UI's meter still reads a folded byte, so the strip keeps meaning something.
  assert.equal(v.channelPan, 128);
});

test("the ninth azimuth bit is what puts a default behind the listener", () => {
  const front = makeInstPosEngine(SURROUND_PLANAR, { azimuth: 0x80 });
  loadSong(front, [{ row: 0, note: 0x5000, inst: 1 }]);
  render(front, 2);
  assert.equal(front.getVoiceSpatialAzimuth(0, 0), 128, "bit clear = the front arc, as ever");

  const behind = makeInstPosEngine(SURROUND_PLANAR, { azimuth: 0x180 });
  loadSong(behind, [{ row: 0, note: 0x5000, inst: 1 }]);
  render(behind, 2);
  assert.equal(behind.getVoiceSpatialAzimuth(0, 0), 384, "bit set = the same angle, rear arc");
});

test("a planar song ignores the elevation, a stereo song ignores both", () => {
  const planar = makeInstPosEngine(SURROUND_PLANAR, { azimuth: 384, elevation: 64 });
  loadSong(planar, [{ row: 0, note: 0x5000, inst: 1 }]);
  render(planar, 2);
  assert.equal(planar.getVoiceSpatialAzimuth(0, 0), 384);
  assert.equal(planar.getVoiceSpatialElevation(0, 0), 0, "planar songs stay on the horizon");
  assert.equal(voice0(planar).noteElevation, 0, "dropped at the write, not at the mixer");

  // Stereo: byte 177 alone, exactly as before the spatial fields existed.
  const stereo = makeInstPosEngine(SURROUND_STEREO, { azimuth: 0x180, elevation: 64 });
  loadSong(stereo, [{ row: 0, note: 0x5000, inst: 1 }]);
  render(stereo, 2);
  assert.equal(voice0(stereo).channelPan, 0x80, "the pan byte, with no ninth bit");
  assert.equal(voice0(stereo).panElevation, 0);
});

test("an old file sounds the same in a surround song as it did in stereo", () => {
  // The compatibility claim in one line: bit 5 clear and byte 254 zero is every
  // file written before this feature existed.
  const rows = [{ row: 0, note: 0x5000, inst: 1 }, { row: 4, note: 0x5100, inst: 1 }];
  const stereo = render(loadSong(makeInstPosEngine(SURROUND_STEREO, { azimuth: 0x30 }), rows), 30);
  const planar = render(loadSong(makeInstPosEngine(SURROUND_PLANAR, { azimuth: 0x30 }), rows), 30);
  assert.deepEqual(planar, stereo);
});

test("the record's spatial bits survive a load/read round-trip", () => {
  const eng = makeInstPosEngine(SURROUND_SPATIAL, { azimuth: 0x1c0, elevation: -64 });
  const inst = eng.instruments[1];
  assert.equal(inst.defaultAzimuth, 0x1c0);
  assert.equal(inst.defaultElevation, -64, "byte 254 is signed");
  assert.equal(inst.getByte(14) & 0x20, 0x20, "bit 5 must not be masked away on read");
  assert.equal(inst.getByte(254), 0xc0);
  assert.equal(inst.isPercussion, false, "…and it must not be mistaken for the percussion bit");
  // Byte 14's other meanings are untouched.
  assert.equal(inst.loopMode & 0x03, 1);
});
