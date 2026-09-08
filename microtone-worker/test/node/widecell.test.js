// Format version 3 — the 16-byte pattern cell (file format §5.5): 8-bit
// volume, a panning column that carries a whole spherical position, and a
// second effect.
//
// The property that matters most is the one that is NOT about v3: a version-2
// song must render exactly as it always did, because the volume state widened
// underneath it. The conformance suite pins that against the JVM oracle; the
// first test here pins the arithmetic that made the widening possible.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import {
  TRACKER_CHUNK, PATTERN_BYTES_WIDE, CELL_BYTES_WIDE, SAMPLING_RATE, setSamplingRate,
} from "../../src/engine/constants.js";
import { TaudPlayData } from "../../src/engine/state.js";
import { EffectOp } from "../../src/engine/tables.js";
import { applyEffectRow } from "../../src/engine/effects.js";
import { SURROUND_PLANAR, SURROUND_SPATIAL } from "../../src/engine/spatial.js";
import { readSamplePoint } from "../../src/engine/sampler.js";

// Pinned to the Kotlin engine's 32 kHz (item 108 moved the web default to
// 48 kHz): the expectations below are sample counts and reference renders
// taken from AudioAdapter.kt, and they stay diffable against it.
setSamplingRate(32000);

/** Engine with a looping ramp sample in slot 1, in the wide-cell format. */
function makeWideEngine(surroundModel = SURROUND_SPATIAL) {
  const eng = new TaudEngine();
  eng.setCellFormat(true);
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1;
  rec[21] = 0x3f;
  rec[171] = 255;
  rec[196] = 255;
  eng.uploadInstrument(1, rec);
  eng.setSurroundModel(0, surroundModel);
  return eng;
}

/**
 * rows: [{row, note, inst, vol, volEff, azimuth, elevation, panEff,
 *         effect, arg, effect2, arg2}] → uploaded as pattern 0.
 * Untouched columns get the FINE-by-zero sentinel, exactly as an editor writes.
 */
function loadWideSong(eng, rows) {
  const pat = new Uint8Array(PATTERN_BYTES_WIDE);
  for (let r = 0; r < 64; r++) pat[r * CELL_BYTES_WIDE + 8] = 0x33; // vol+pan = FINE 0
  for (const c of rows) {
    const o = c.row * CELL_BYTES_WIDE;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    let sel = pat[o + 8];
    if (c.vol !== undefined) {
      pat[o + 3] = c.vol & 0xff;
      sel = (sel & 0x8f) | ((c.volEff ?? 0) << 4);
    }
    if (c.azimuth !== undefined) {
      pat[o + 4] = c.azimuth & 0xff;
      sel = (sel & 0x7f) | (((c.azimuth >>> 8) & 1) << 7);
      sel = (sel & 0xf0) | (c.panEff ?? 0);
    }
    if (c.elevation !== undefined) pat[o + 9] = c.elevation & 0xff;
    pat[o + 8] = sel;
    if (c.effect !== undefined) {
      pat[o + 5] = c.effect;
      pat[o + 6] = c.arg & 0xff;
      pat[o + 7] = (c.arg >>> 8) & 0xff;
    }
    if (c.effect2 !== undefined) {
      pat[o + 10] = c.effect2;
      pat[o + 11] = c.arg2 & 0xff;
      pat[o + 12] = (c.arg2 >>> 8) & 0xff;
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
function render(eng, ticks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < ticks * CHUNKS_PER_TICK; i++) eng.renderChunk(0, out);
}
const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];

// ── the codec ────────────────────────────────────────────────────────────

test("the wide cell round-trips every field through its 16 bytes", () => {
  const cell = new TaudPlayData();
  cell.note = 0x5123;
  cell.instrment = 0xab;
  cell.volume = 0xcd;
  cell.volumeEff = 5;
  cell.azimuth = 0x1a4;      // needs the ninth bit
  cell.elevation = -40;
  cell.panEff = 0xd;
  cell.effect = EffectOp.OP_X;
  cell.effectArg = 0x40c0;
  cell.effect2 = EffectOp.OP_Z;
  cell.effectArg2 = 0x0123;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = cell.getByteWide(i);
  const back = new TaudPlayData();
  for (let i = 0; i < 16; i++) back.setByteWide(i, bytes[i]);

  for (const k of ["note", "instrment", "volume", "volumeEff", "azimuth", "elevation",
    "panEff", "effect", "effectArg", "effect2", "effectArg2"]) {
    assert.equal(back[k], cell[k], `${k} did not survive the round trip`);
  }
  // The selector byte is the documented packing, not something incidental.
  assert.equal(bytes[8], 0x80 | (5 << 4) | 0xd);
  assert.equal(bytes[9], 0xd8, "elevation is signed on the wire");
  assert.deepEqual([...bytes.subarray(13)], [0, 0, 0], "reserved bytes stay clear");
});

test("an untouched wide cell is FINE-by-zero in both columns", () => {
  const cell = new TaudPlayData();
  cell.volumeEff = 3;
  cell.panEff = 3;
  assert.equal(cell.getByteWide(8), 0x33);
  assert.equal(cell.getByteWide(3), 0);
  assert.equal(cell.getByteWide(4), 0);
});

// ── volume ───────────────────────────────────────────────────────────────

test("the volume column is eight bits and the state widens with it", () => {
  const eng = makeWideEngine();
  assert.equal(eng.playheads[0].trackerState.volMax, 255);
  loadWideSong(eng, [{ row: 0, note: 0x5000, inst: 1, vol: 200, volEff: 0 }]);
  render(eng, 2);
  assert.equal(voice0(eng).noteVolume, 200, "a value a 6-bit column could not hold");
});

test("a nibble volume slide moves at the rate it always did", () => {
  // D $01 is one 6-bit unit per tick; in a wide cell that has to be four of
  // its own units, or every converted song slides four times too slowly.
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, vol: 255, volEff: 0 },
    { row: 1, effect: EffectOp.OP_D, arg: 0x0100 }, // slide down 1/tick
  ]);
  render(eng, 6);          // row 0
  const start = voice0(eng).noteVolume;
  render(eng, 6);          // row 1: five non-first ticks
  const moved = start - voice0(eng).noteVolume;
  assert.equal(moved, 5 * 4, `slid ${moved} units, expected 5 ticks × 4`);
});

test("the volume column's own slide keeps its full 8-bit precision", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, vol: 255, volEff: 0 },
    { row: 1, vol: 1, volEff: 2 }, // slide DOWN by one unit per tick
  ]);
  render(eng, 6);
  const start = voice0(eng).noteVolume;
  render(eng, 6);
  assert.equal(start - voice0(eng).noteVolume, 5, "one unit per tick — not four");
});

test("FINE moves its direction flag to the top of the wider field", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, vol: 100, volEff: 0 },
    { row: 1, vol: 0x80 | 20, volEff: 3 }, // fine UP by 20
    { row: 2, vol: 20, volEff: 3 },        // fine DOWN by 20
  ]);
  // A row's pass runs on the FIRST tick of the row, so one tick is enough to
  // see row 0 and six carry us into each of the rows after it.
  render(eng, 1);
  assert.equal(voice0(eng).noteVolume, 100);
  render(eng, 6);
  assert.equal(voice0(eng).noteVolume, 120);
  render(eng, 6);
  assert.equal(voice0(eng).noteVolume, 100);
});

test("velocity layers still see a 6-bit axis (instrument data does not widen)", () => {
  // A patch covering the top half of the 6-bit volume axis must be picked by a
  // wide cell's 255, and not by its 100.
  const eng = makeWideEngine();
  const patch = new Uint8Array([
    0x01,             // version: base fields only
    0x20, 0x00,       // pitchStart
    0xff, 0xff,       // pitchEnd
    32, 63,           // volumeStart..volumeEnd — the top half
    0, 0, 0, 0,       // samplePtr
    0xe8, 0x03,       // sampleLength 1000
    0, 0,             // playStart
    0, 0,             // loopStart
    0xe8, 0x03,       // loopEnd
    0x00, 0x7d,       // samplingRate 32000
    0, 0,             // detune
    1,                // loopMode
    0xff,             // defaultPan sentinel
    0,                // defaultNoteVolume sentinel
    0, 0, 0, 0, 0xff, // vibrato + waveform sentinel
  ]);
  eng.uploadInstrumentPatches(1, patch);

  loadWideSong(eng, [{ row: 0, note: 0x5000, inst: 1, vol: 255, volEff: 0 }]);
  render(eng, 2);
  assert.equal(voice0(eng).activePatchIndex, 0, "255 → 63 must land inside the rectangle");

  const quiet = makeWideEngine();
  quiet.uploadInstrumentPatches(1, patch);
  loadWideSong(quiet, [{ row: 0, note: 0x5000, inst: 1, vol: 100, volEff: 0 }]);
  render(quiet, 2);
  assert.equal(voice0(quiet).activePatchIndex, -1, "100 → 25 must fall outside it");
});

// ── panning ──────────────────────────────────────────────────────────────

test("the panning column places a source anywhere on the sphere", () => {
  const eng = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 384, elevation: 64, panEff: 0 },
  ]);
  render(eng, 2);
  // Item 117: the panning column is the NOTE axis in a wide cell too, so the
  // pair it writes is an offset from the channel's direction — which, with the
  // channel at its default front, puts the source exactly where the cell says.
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0), 384, "behind — the ninth bit reached the engine");
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 64);
  assert.equal(voice0(eng).panAzimuth, 128, "the channel's own direction is untouched");
});

test("a planar song keeps the column's azimuth and drops its elevation", () => {
  const eng = makeWideEngine(SURROUND_PLANAR);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 300, elevation: 100, panEff: 0 },
  ]);
  render(eng, 2);
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0), 300);
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 0);
  assert.equal(voice0(eng).noteElevation, 0, "dropped at the write, not at the mixer");
});

test("a Z on the same row makes the column a slide TARGET, not a jump", () => {
  const eng = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 128, elevation: 0, panEff: 0 },
    { row: 1, azimuth: 256, elevation: 64, panEff: 0, effect: EffectOp.OP_Z, arg: 0x010 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).panAzimuth, 128, "row 0 places the source at the front");
  render(eng, 2); // into row 1: the row pass has run and the slide has stepped
  const v = voice0(eng);
  assert.equal(v.spatialTargetAz, 256, "the column set the target");
  assert.equal(v.spatialTargetEl, 64);
  assert.ok(v.panAzimuth > 128 && v.panAzimuth < 256,
    `the source should be travelling, not teleported (at ${v.panAzimuth})`);
});

test("the column's pan slides rotate by their low byte per tick", () => {
  const eng = makeWideEngine(SURROUND_PLANAR);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 128, elevation: 0, panEff: 0 },
    { row: 1, azimuth: 10, panEff: 1 }, // slide right by 10 per tick
  ]);
  render(eng, 6);
  const start = eng.getVoiceSpatialAzimuth(0, 0);
  render(eng, 6);
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0) - start, 50, "five non-first ticks × 10");
  assert.equal(voice0(eng).panAzimuth, 128, "a column slide turns the note, not the channel");
});

// ── the second effect ────────────────────────────────────────────────────

test("both effect slots run, and the second one lands last", () => {
  const eng = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng, [{
    row: 0, note: 0x5000, inst: 1,
    effect: EffectOp.OP_X, arg: 0x0040,   // place: front, ear level
    effect2: EffectOp.OP_M, arg2: 0x8000, // …and set the channel volume
  }]);
  render(eng, 2);
  const v = voice0(eng);
  assert.equal(v.panAzimuth, 128, "effect 1 ran");
  assert.equal(v.channelVolume, 0x80, "effect 2 ran — and at full 8-bit range");

  // Two writes to the same state: the second must win.
  const eng2 = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng2, [{
    row: 0, note: 0x5000, inst: 1,
    effect: EffectOp.OP_X, arg: 0x0040,
    effect2: EffectOp.OP_X, arg2: 0x00c0, // behind
  }]);
  render(eng2, 2);
  assert.equal(voice0(eng2).panAzimuth, 384, "the later effect wins");
});

test("a narrow-cell engine never reads the second effect", () => {
  // Same 16 bytes fed to an 8-byte reader would be nonsense, so the guard is
  // that the format flag — not the data — decides.
  const eng = new TaudEngine();
  assert.equal(eng.getCellFormat(), false);
  assert.equal(eng.playheads[0].trackerState.volMax, 0x3f);
  eng.setCellFormat(true);
  assert.equal(eng.getCellFormat(), true);
  assert.equal(eng.playheads[0].trackerState.volMax, 255);
  assert.equal(eng.playheads[0].trackerState.volStep, 4);
  assert.equal(eng.playheads[0].trackerState.volDiv, 255);
});

// ── the document and the container ───────────────────────────────────────

test("a version-3 file round-trips through parse → document → write", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { writeTaud } = await import("../../src/format/taud-write.js");
  const { Document } = await import("../../src/doc/document.js");

  // Start from a real song and widen it by hand — the upgrade FLOW is stage 2;
  // what this pins is that the container, the document and the codec agree.
  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const parsed = parseTaud(readFileSync(path));
  parsed.fmtVer = 3;
  parsed.songs[0].surroundModel = SURROUND_SPATIAL;
  parsed.songs.forEach((song) => {
    song.patterns = song.patterns.map((p8) => {
      const p16 = new Uint8Array(PATTERN_BYTES_WIDE);
      for (let r = 0; r < 64; r++) {
        p16[r * 16 + 8] = 0x33;
        for (let b = 0; b < 3; b++) p16[r * 16 + b] = p8[r * 8 + b]; // note + inst
      }
      return p16;
    });
  });
  // A position the narrow cell could not have expressed at all.
  parsed.songs[0].patterns[0][4] = 0x80;  // azimuth low byte
  parsed.songs[0].patterns[0][8] = 0x80;  // A bit + SET in both columns
  parsed.songs[0].patterns[0][9] = 0x40;  // elevation +45°

  const bytes = writeTaud(parsed);
  assert.equal(bytes[8] & 0x1f, 3, "the header must declare version 3");

  const again = parseTaud(bytes);
  assert.equal(again.fmtVer, 3);
  assert.equal(again.songs[0].patterns[0].length, PATTERN_BYTES_WIDE);
  assert.deepEqual(again.songs[0].patterns[0], parsed.songs[0].patterns[0]);

  const doc = new Document(again);
  assert.equal(doc.wideCells, true);
  const cell = doc.songs[0].patterns[0][0];
  assert.equal(cell.azimuth, 384, "the ninth bit survived the whole trip");
  assert.equal(cell.elevation, 64);
  assert.deepEqual(doc.patternBytes(0, 0), parsed.songs[0].patterns[0],
    "the document re-encodes the pattern byte-for-byte");
  assert.equal(doc.toBytes()[8] & 0x1f, 3, "…and saves as version 3, never down");
});

test("an empty wide pattern is empty in the wide sense", async () => {
  const { emptyPatternBytes } = await import("../../src/doc/patterntools.js");
  const narrow = emptyPatternBytes();
  const wide = emptyPatternBytes(true);
  assert.equal(narrow.length, 512);
  assert.equal(wide.length, PATTERN_BYTES_WIDE);
  assert.equal(narrow[3], 0xc0);
  assert.equal(wide[8], 0x33, "FINE in both columns");
  assert.equal(wide[3], 0, "…with a zero value, which is what makes it a no-op");
});

test("a wide document renders through the offline path", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { renderToWav } = await import("../../src/audio/offline-render.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const parsed = parseTaud(readFileSync(path));
  parsed.fmtVer = 3;
  parsed.songs[0].surroundModel = SURROUND_SPATIAL;
  parsed.songs.forEach((song) => {
    song.patterns = song.patterns.map((p8) => {
      const p16 = new Uint8Array(PATTERN_BYTES_WIDE);
      for (let r = 0; r < 64; r++) {
        p16[r * 16 + 8] = 0x33;
        for (let b = 0; b < 3; b++) p16[r * 16 + b] = p8[r * 8 + b];
        p16[r * 16 + 3] = 255;                       // full 8-bit volume
        p16[r * 16 + 8] = (p16[r * 16 + 8] & 0x0f);  // volume SET
      }
      return p16;
    });
  });
  const doc = new Document(parsed);
  const wav = renderToWav(doc.toRenderable(0), 0, 1);
  assert.ok(wav.bytes.length > 44, "produced audio");
  let peak = 0;
  const dv = new DataView(wav.bytes.buffer, 44);
  for (let i = 0; i + 1 < dv.byteLength; i += 2) peak = Math.max(peak, Math.abs(dv.getInt16(i, true)));
  assert.ok(peak > 1000, `a wide-cell song must actually sound (peak ${peak})`);
});

// ── the version-2 → version-3 upgrade ────────────────────────────────────

test("widening a cell preserves what every field meant", async () => {
  const { widenPattern, widenVolume } = await import("../../src/doc/upgrade.js");
  const src = new Uint8Array(512);
  const put = (r, bytes) => src.set(bytes, r * 8);
  //     note      inst  vol         pan         fx    arg
  put(0, [0x00, 0x50, 1, 0x3f, 0x20, EffectOp.OP_A, 0x34, 0x12]); // vol SET 63, pan SET 32
  put(1, [0, 0, 0, 0x40 | 8, 0x80 | 5, 0, 0, 0]);                 // vol slide up 8, pan slide L 5
  put(2, [0, 0, 0, 0xc0 | 0x20 | 10, 0xc0 | 0x20 | 7, 0, 0, 0]);  // FINE up 10 / right 7
  put(3, [0, 0, 0, 0xc0, 0xc0, EffectOp.OP_M, 0x00, 0x30]);       // empty cols + M $3000
  const out = widenPattern(src);

  const sel = (r) => out[r * 16 + 8];
  // row 0 — SET in both columns.
  assert.equal(out[3], 255, "volume 63 must become full scale, exactly");
  // Pan value 32 of 63 → the byte the v2 engine derived: (32<<2)|(32>>4) = 130.
  assert.equal(out[4], 130, "pan SET → the front-arc byte the v2 engine derived");
  assert.equal(sel(0) & 0x80, 0, "…which needs no ninth bit");
  assert.equal((sel(0) >> 4) & 7, 0);
  assert.equal(sel(0) & 0xf, 0);
  assert.equal(out[5], EffectOp.OP_A, "the effect moves to slot 1 untouched");
  assert.equal(out[6] | (out[7] << 8), 0x1234);
  assert.deepEqual([...out.subarray(10, 16)], [0, 0, 0, 0, 0, 0], "slot 2 + reserved stay clear");

  // row 1 — slides: volume scales, panning does not (same units either way).
  assert.equal(out[16 + 3], widenVolume(8));
  assert.equal((sel(1) >> 4) & 7, 1);
  assert.equal(out[16 + 4], 5, "a pan-byte step IS an azimuth step");
  assert.equal(sel(1) & 0xf, 2);

  // row 2 — FINE: the direction flag moves to the top of each wider field.
  assert.equal(out[32 + 3] & 0x80, 0x80, "volume fine UP");
  assert.equal(out[32 + 3] & 0x7f, widenVolume(10));
  assert.equal(sel(2) & 0x80, 0x80, "pan fine RIGHT rides the A bit");
  assert.equal(out[32 + 4], 7, "…with its magnitude unchanged");

  // row 3 — the empty-column sentinel survives as the wide one, and M scales.
  assert.equal(sel(3), 0x33);
  assert.equal(out[48 + 3], 0);
  assert.equal(out[48 + 4], 0);
  assert.equal(out[48 + 7], widenVolume(0x30), "M sets a LEVEL, so it rescales");
});

test("the upgrade is one undo step and puts the exact bytes back", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { upgradeCellFormatOp } = await import("../../src/doc/ops.js");
  const { UndoStack } = await import("../../src/doc/undo.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const doc = new Document(parseTaud(readFileSync(path)));
  const before = doc.toBytes();
  const wasVer = doc.fmtVer; // the corpus holds version-1 files too
  assert.equal(doc.wideCells, false);

  const undo = new UndoStack(doc);
  undo.apply(upgradeCellFormatOp(0, 2));
  assert.equal(doc.wideCells, true);
  assert.equal(doc.fmtVer, 3);
  assert.equal(doc.songs[0].surroundModel, 2, "the model rides in the same op");
  assert.equal(doc.patternBytes(0, 0).length, PATTERN_BYTES_WIDE);
  assert.equal(doc.toBytes()[8] & 0x1f, 3);

  undo.undo();
  assert.equal(doc.wideCells, false);
  assert.equal(doc.fmtVer, wasVer);
  assert.equal(doc.songs[0].surroundModel, 0, "…and comes back with it");
  assert.deepEqual(doc.toBytes(), before, "undo must restore the file byte for byte");

  undo.redo();
  assert.equal(doc.wideCells, true, "…and redo widens it again");
});

test("a widened song sounds like the one it came from", async () => {
  // The upgrade's whole claim: the same music, in a cell that can say more.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { renderToWav } = await import("../../src/audio/offline-render.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const narrow = new Document(parseTaud(readFileSync(path)));
  const wide = new Document(parseTaud(readFileSync(path)));
  wide.upgradeToWideCells();

  const a = renderToWav(narrow.toRenderable(0), 0, 4);
  const b = renderToWav(wide.toRenderable(0), 0, 4);
  assert.equal(a.bytes.length, b.bytes.length);

  // Not bit-exact — 8-bit volume quantises the mix differently — but the two
  // renders have to be the same performance, so compare them as signals.
  const pcm = (w) => {
    const dv = new DataView(w.bytes.buffer, 44);
    const out = new Float64Array(dv.byteLength >> 1);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
    return out;
  };
  const pa = pcm(a);
  const pb = pcm(b);
  let dot = 0, ea = 0, eb = 0, worst = 0;
  for (let i = 0; i < pa.length; i++) {
    dot += pa[i] * pb[i];
    ea += pa[i] * pa[i];
    eb += pb[i] * pb[i];
    worst = Math.max(worst, Math.abs(pa[i] - pb[i]));
  }
  const corr = dot / Math.sqrt(ea * eb);
  assert.ok(corr > 0.9999, `the widened song drifted (correlation ${corr.toFixed(6)})`);
  assert.ok(worst < 0.02, `sample-level difference too large (${worst.toFixed(4)})`);
});

// ── the editor's wide columns (stage 3) ─────────────────────────────────

test("the cursor walks the wide cell's extra panning digits", async () => {
  const E = await import("../../src/ui/edit.js");
  assert.deepEqual(E.subNibbles(false), [1, 2, 3, 3, 1, 4]);
  assert.deepEqual(E.subNibbles(true), [1, 2, 3, 6, 1, 4], "panning gains el + 3-digit azimuth");
  assert.equal(E.subPositions(false).length, 14);
  assert.equal(E.subPositions(true).length, 17);
  assert.equal(E.cellChars(false), 21);
  assert.equal(E.cellChars(true), 24);

  // Clicking maps to the same places the painter draws.
  assert.deepEqual(E.charToSub(12, true), [E.SUB_PAN, 0], "symbol");
  assert.deepEqual(E.charToSub(13, true), [E.SUB_PAN, 1], "elevation hi");
  assert.deepEqual(E.charToSub(15, true), [E.SUB_PAN, 3], "azimuth hi");
  assert.deepEqual(E.charToSub(17, true), [E.SUB_PAN, 5], "azimuth lo");
  assert.deepEqual(E.charToSub(19, true), [E.SUB_FX_OP, 0], "the effect moved right");
  assert.deepEqual(E.charToSub(20, true), [E.SUB_FX_ARG, 0]);
  // …and the narrow layout is untouched.
  assert.deepEqual(E.charToSub(16, false), [E.SUB_FX_OP, 0]);
  assert.deepEqual(E.subCharPos(E.SUB_FX_OP, 0, true), [19, 1]);
  assert.deepEqual(E.subCharPos(E.SUB_FX_OP, 0, false), [16, 1]);
});

test("typing an 8-bit volume into a wide cell", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.volumeEff = 3; cell.panEff = 3; // empty
  const ctx = { octave: 4, currentInst: 1, preset: null, rawHex: false, wideCells: true };
  const key = (k, sub, nib, c) => E.interpretEditKey({ code: "Key", key: k }, sub, nib, c, ctx);

  // "F" then "F" on the two digits → 255, which a 6-bit column could not hold.
  let a = key("f", E.SUB_VOL, 1, cell);
  assert.equal(a.fields.volume, 0xf0);
  assert.equal(a.fields.volumeEff, 0, "an empty column promotes to SET");
  Object.assign(cell, a.fields);
  a = key("f", E.SUB_VOL, 2, cell);
  assert.equal(a.fields.volume, 0xff);
  assert.ok(a.advanceRow, "the last digit steps to the next row");
});

test("the wide panning column edits elevation and a 9-bit azimuth", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.volumeEff = 3; cell.panEff = 3;
  const ctx = { octave: 4, currentInst: 1, preset: null, rawHex: false, wideCells: true };
  const key = (k, nib, c) => E.interpretEditKey({ code: "Key", key: k }, E.SUB_PAN, nib, c, ctx);

  // Elevation "C0" = −64 (45° below).
  let a = key("c", 1, cell);
  Object.assign(cell, a.fields);
  a = key("0", 2, cell);
  Object.assign(cell, a.fields);
  assert.equal(cell.elevation, -64, "elevation is a SIGNED byte");

  // Azimuth "180" = behind the listener — three digits, nine bits.
  a = key("1", 3, cell);
  Object.assign(cell, a.fields);
  a = key("8", 4, cell);
  Object.assign(cell, a.fields);
  a = key("0", 5, cell);
  Object.assign(cell, a.fields);
  assert.equal(cell.azimuth, 0x180);
  assert.equal(cell.panEff, 0, "…as a SET");
  assert.ok(a.advanceRow, "the last azimuth digit steps to the next row");

  // Clearing blanks the whole column, elevation included.
  const clear = E.interpretEditKey({ code: "Delete", key: "Delete" }, E.SUB_PAN, 4, cell, ctx);
  assert.deepEqual(clear.fields, { azimuth: 0, elevation: 0, panEff: 3 });
});

test("FINE's direction flag follows the field it lives in", async () => {
  const E = await import("../../src/ui/edit.js");
  // Volume: bit 5 of six becomes bit 7 of eight.
  const narrow = new TaudPlayData();
  narrow.volume = 10; narrow.volumeEff = 0;
  assert.equal(E.volPanSelect(false, "fineUp", narrow, false).volume, 0x20 | 10);
  const wide = new TaudPlayData();
  wide.volume = 10; wide.volumeEff = 0;
  assert.equal(E.volPanSelect(false, "fineUp", wide, true).volume, 0x80 | 10);
  // Panning: the flag is the azimuth's ninth bit, which IS `A` on the wire.
  const wp = new TaudPlayData();
  wp.azimuth = 40; wp.panEff = 0;
  const f = E.volPanSelect(true, "fineUp", wp, true);
  assert.equal(f.azimuth, 0x100 | 40);
  assert.equal(E.volPanOp(f.azimuth, f.panEff, true, true), "fineUp");
  assert.equal(E.volPanArg(f.azimuth, f.panEff, true, true), 40, "…and the digits show the magnitude");
});

test("an empty wide panning column knows the elevation counts", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.panEff = 3; cell.azimuth = 0; cell.elevation = 0;
  assert.equal(E.subIsEmpty(E.SUB_PAN, cell), true);
  cell.elevation = 30;
  assert.equal(E.subIsEmpty(E.SUB_PAN, cell), false, "a height alone is not nothing");
});

test("a spatial song states ear level instead of hiding it", async () => {
  // On the sphere 00 is a POSITION — the composer chose ear level — so the
  // column says so. A planar song has no height to state, and under a slide
  // selector the elevation field is reserved, so both keep the dots.
  const { elevationCellText } = await import("../../src/ui/glyphs.js");
  assert.equal(elevationCellText(0, "set", true), "00", "spatial + placing → stated");
  assert.equal(elevationCellText(0, "set", false), "··", "planar has no height");
  assert.equal(elevationCellText(0, "none", true), "··", "an empty column stays empty");
  assert.equal(elevationCellText(0, "up", true), "··", "reserved under a slide");
  assert.equal(elevationCellText(0, "fineUp", true), "··");
  // A real height is always shown, in every model — including a negative one,
  // which is a signed byte on the wire.
  assert.equal(elevationCellText(64, "set", false), "40");
  assert.equal(elevationCellText(-64, "set", true), "C0");
  assert.equal(elevationCellText(-1, "up", false), "FF");
});

// ── the second effect column (§5.5, exposed 2026-08-10) ──────────────────

test("exposing the second effect appends a sixth column group", async () => {
  const E = await import("../../src/ui/edit.js");
  // Hidden, the wide cell is what it always was — this is the guarantee that
  // turning the column off leaves every other geometry read untouched.
  assert.deepEqual(E.subNibbles(true, false), [1, 2, 3, 6, 1, 4]);
  assert.equal(E.cellChars(true, false), 24);
  assert.equal(E.subPositions(true, false).length, 17);
  // …and shown, one opcode + a 4-nibble argument more.
  assert.deepEqual(E.subNibbles(true, true), [1, 2, 3, 6, 1, 4, 1, 4]);
  assert.equal(E.cellChars(true, true), 30);
  assert.equal(E.subPositions(true, true).length, 22);
  // The 8-byte cell has no second effect, so the flag cannot widen it.
  assert.equal(E.cellChars(false, true), 21, "a v2 cell has no second effect");
  assert.deepEqual(E.subNibbles(false, true), [1, 2, 3, 3, 1, 4]);

  // Clicking maps to the same places the painter draws: fx1 19…23, then a
  // separating space, then fx2 25…29.
  assert.deepEqual(E.subCharPos(E.SUB_FX2_OP, 0, true), [25, 1]);
  assert.deepEqual(E.subCharPos(E.SUB_FX2_ARG, 3, true), [29, 1]);
  assert.deepEqual(E.charToSub(25, true, true), [E.SUB_FX2_OP, 0]);
  assert.deepEqual(E.charToSub(26, true, true), [E.SUB_FX2_ARG, 0]);
  assert.deepEqual(E.charToSub(29.5, true, true), [E.SUB_FX2_ARG, 3]);
  assert.deepEqual(E.charToSub(24.5, true, true), [E.SUB_FX_ARG, 3],
    "the gap between the groups belongs to the first one");
  // With the column hidden, those characters do not exist: a click that far
  // right stays on the first effect's last digit rather than falling off.
  assert.deepEqual(E.charToSub(26, true, false), [E.SUB_FX_ARG, 3]);

  // The selection highlight has a span for it, and a degenerate one when it is
  // hidden — so `range[colHi][1]` is always readable.
  assert.deepEqual(E.colCharRange(true, true)[E.COL_FX2], [24, 30]);
  assert.deepEqual(E.colCharRange(true, false)[E.COL_FX2], [24, 24]);
  assert.deepEqual(E.colCharRange(false)[E.COL_FX2], [21, 21]);

  assert.equal(E.lastSub(true), E.SUB_FX2_ARG);
  assert.equal(E.lastSub(false), E.SUB_FX_ARG);
});

test("typing into the second effect column writes effect2, not effect", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.volumeEff = 3; cell.panEff = 3;
  cell.effect = 0x1c; cell.effectArg = 0x8100; // an S command already in slot 1
  const ctx = { octave: 4, currentInst: 1, preset: null, rawHex: false, wideCells: true };
  const key = (k, sub, nib, c) =>
    E.interpretEditKey({ code: "Key" + k.toUpperCase(), key: k }, sub, nib, c, ctx);

  // "M" is base-36 0x16 — the channel-volume command.
  let a = key("m", E.SUB_FX2_OP, 0, cell);
  assert.deepEqual(a.fields, { effect2: 0x16 });
  assert.ok(a.advanceNib, "the opcode steps into its argument");
  Object.assign(cell, a.fields);

  for (const [i, d] of [..."8000"].entries()) {
    a = key(d, E.SUB_FX2_ARG, i, cell);
    Object.assign(cell, a.fields);
  }
  assert.equal(cell.effectArg2, 0x8000);
  assert.ok(a.advanceRow, "the last argument digit steps to the next row");
  // Slot 1 never moved.
  assert.equal(cell.effect, 0x1c);
  assert.equal(cell.effectArg, 0x8100);

  // Clearing the second opcode clears only the second pair.
  const clear = E.interpretEditKey({ code: "Delete", key: "Delete" }, E.SUB_FX2_OP, 0, cell, ctx);
  assert.deepEqual(clear.fields, { effect2: 0, effectArg2: 0 });
  const clearArg = E.interpretEditKey({ code: "Delete", key: "Delete" }, E.SUB_FX2_ARG, 2, cell, ctx);
  assert.deepEqual(clearArg.fields, { effectArg2: 0 }, "the opcode survives an argument clear");

  // An empty second effect is "nothing to step" for the wheel, exactly as an
  // empty first one is.
  const blank = new TaudPlayData();
  assert.equal(E.subIsEmpty(E.SUB_FX2_OP, blank), true);
  blank.effect2 = 0x16;
  assert.equal(E.subIsEmpty(E.SUB_FX2_OP, blank), false);
  assert.equal(E.subIsEmpty(E.SUB_FX2_ARG, blank), false);
});

test("the two effect columns copy and paste independently", async () => {
  const C = await import("../../src/doc/clipboard.js");
  const E = await import("../../src/ui/edit.js");
  const src = new TaudPlayData();
  src.volumeEff = 3; src.panEff = 3;
  src.effect = 0x0d; src.effectArg = 0x0102;   // D
  src.effect2 = 0x16; src.effectArg2 = 0x8000; // M
  const dst = new TaudPlayData();
  dst.volumeEff = 3; dst.panEff = 3;
  dst.effect = 0x10; dst.effectArg = 0x0300;   // G
  dst.effect2 = 0x21; dst.effectArg2 = 0x00c0; // X

  const sb = C.cellToBytes(src, true);
  // Copying the FIRST effect column alone leaves the destination's second one
  // exactly where it was — before the column was exposed, COL_FX dragged the
  // hidden effect 2 along with it.
  const a = new TaudPlayData();
  const ab = C.overlayCols(C.cellToBytes(dst, true), sb, [E.COL_FX], true);
  for (let i = 0; i < 16; i++) a.setByteWide(i, ab[i]);
  assert.equal(a.effect, 0x0d);
  assert.equal(a.effectArg, 0x0102);
  assert.equal(a.effect2, 0x21, "the destination's second effect is untouched");
  assert.equal(a.effectArg2, 0x00c0);

  // …and the second column alone moves only the second pair.
  const b = new TaudPlayData();
  const bb = C.overlayCols(C.cellToBytes(dst, true), sb, [E.COL_FX2], true);
  for (let i = 0; i < 16; i++) b.setByteWide(i, bb[i]);
  assert.equal(b.effect, 0x10, "the destination's first effect is untouched");
  assert.equal(b.effectArg, 0x0300);
  assert.equal(b.effect2, 0x16);
  assert.equal(b.effectArg2, 0x8000);

  // A whole-cell copy still carries both, and naming COL_FX2 on an 8-byte cell
  // is a no-op rather than an out-of-range write.
  const narrow = Uint8Array.from([0x00, 0x50, 0x05, 0x20, 0x30, 0x0a, 0x00, 0x0f]);
  const kept = C.overlayCols(Uint8Array.from(narrow), new Uint8Array(8), [E.COL_FX2]);
  assert.deepEqual([...kept], [...narrow], "a v2 cell has no second effect to overwrite");
});

test("an effect block pastes into whichever effect column the caret is on", async () => {
  const C = await import("../../src/doc/clipboard.js");
  const E = await import("../../src/ui/edit.js");

  // A block covering ONE effect column is slot-agnostic; anything else is not.
  assert.deepEqual(C.fxPasteRemap([E.COL_FX2], E.COL_FX, true), { from: E.COL_FX2, to: E.COL_FX });
  assert.deepEqual(C.fxPasteRemap([E.COL_FX], E.COL_FX2, true), { from: E.COL_FX, to: E.COL_FX2 });
  assert.equal(C.fxPasteRemap([E.COL_FX], E.COL_FX, true), null, "same slot = nothing to move");
  assert.equal(C.fxPasteRemap([E.COL_FX2], E.COL_VOL, true), null, "a non-effect caret is left alone");
  assert.equal(C.fxPasteRemap([E.COL_VOL], E.COL_FX, true), null, "…and so is a non-effect block");
  assert.equal(C.fxPasteRemap(E.ALL_COLS, E.COL_FX, true), null, "a whole-cell block is not a slot");
  assert.equal(C.fxPasteRemap([E.COL_FX, E.COL_FX2], E.COL_FX, true), null, "…nor a two-column one");
  // A v2 cell has no second slot to receive one, but its effect column can
  // happily take a second effect's bytes.
  assert.equal(C.fxPasteRemap([E.COL_FX], E.COL_FX2, false), null, "nowhere to put it in a v2 cell");
  assert.deepEqual(C.fxPasteRemap([E.COL_FX2], E.COL_FX, false), { from: E.COL_FX2, to: E.COL_FX },
    "…but a second effect pastes down into one");

  // The bytes really move, and the slot they came from is not disturbed —
  // overlayCols only writes the destination column.
  const src = new TaudPlayData();
  src.volumeEff = 3; src.panEff = 3;
  src.effect = 0x0d; src.effectArg = 0x0102;   // D in slot 1
  src.effect2 = 0x16; src.effectArg2 = 0x8000; // M in slot 2
  const dst = new TaudPlayData();
  dst.volumeEff = 3; dst.panEff = 3;
  dst.effect = 0x10; dst.effectArg = 0x0300;   // G in slot 1
  const sb = C.cellToBytes(src, true);

  const read = (bytes) => {
    const c = new TaudPlayData();
    for (let i = 0; i < bytes.length; i++) c.setByteWide(i, bytes[i]);
    return c;
  };
  // slot 2 → slot 1: the M lands on the G, and the source cell's own slot 1 (D)
  // never enters into it.
  const down = C.fxPasteRemap([E.COL_FX2], E.COL_FX, true);
  const a = read(C.overlayCols(C.cellToBytes(dst, true), C.remapFxBytes(sb, down, true),
    [down.to], true));
  assert.equal(a.effect, 0x16, "the second effect became the first");
  assert.equal(a.effectArg, 0x8000);
  assert.equal(a.effect2, 0, "…and the destination's own second slot is untouched");

  // slot 1 → slot 2, the other way round.
  const up = C.fxPasteRemap([E.COL_FX], E.COL_FX2, true);
  const b = read(C.overlayCols(C.cellToBytes(dst, true), C.remapFxBytes(sb, up, true),
    [up.to], true));
  assert.equal(b.effect, 0x10, "the destination keeps its first effect");
  assert.equal(b.effectArg, 0x0300);
  assert.equal(b.effect2, 0x0d, "…and the copied first effect became its second");
  assert.equal(b.effectArg2, 0x0102);

  // No remap = the bytes are handed through untouched (identity, not a copy).
  assert.equal(C.remapFxBytes(sb, null, true), sb);

  // Pasting a v3 second effect DOWN into a v2 cell: the output is sized for the
  // destination, so overlayCols reads bytes that exist.
  const narrowDst = Uint8Array.from([0x00, 0x50, 0x05, 0x20, 0x30, 0x10, 0x00, 0x03]);
  const moved = C.remapFxBytes(sb, C.fxPasteRemap([E.COL_FX2], E.COL_FX, false), false);
  assert.equal(moved.length, 8, "sized for the destination cell");
  const out = C.overlayCols(Uint8Array.from(narrowDst), moved, [E.COL_FX], false);
  assert.deepEqual([...out.subarray(5, 8)], [0x16, 0x00, 0x80], "M $8000 in the v2 effect column");
  assert.deepEqual([...out.subarray(0, 5)], [...narrowDst.subarray(0, 5)], "…and nothing else moved");
});

// ═══════════════════════════════════════════════════════════════════════════
// Argument extension (item 162): `:` paired with J / O / 2 / 3, Format 3 only.
// Pure-function coverage of $f / $xuu / $yk lives in samplemod.test.js; these
// drive real rows through the tracker so the row-level pairing (row.js) and
// the sub-tick clock (mixer.js) are the ones actually wired into playback.
// ═══════════════════════════════════════════════════════════════════════════

test("J extended: two full 4096-TET offsets, order-independent of which slot carries `:`", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_J, arg: 0x0234,
      effect2: EffectOp.OP_COLON, arg2: 0x0567 },
  ]);
  const base = 0x5000;
  render(eng, 1);
  assert.equal(voice0(eng).renderPitch, base, "tick 0: base pitch");
  render(eng, 1);
  assert.equal(voice0(eng).renderPitch, base + 0x0234, "tick 1: J's own arg, full resolution");
  render(eng, 1);
  assert.equal(voice0(eng).renderPitch, base + 0x0567, "tick 2: the paired `:`'s arg");

  // Swapped slots — `:` first, J second — must read exactly the same.
  const swapped = makeWideEngine();
  loadWideSong(swapped, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_COLON, arg: 0x0567,
      effect2: EffectOp.OP_J, arg2: 0x0234 },
  ]);
  render(swapped, 1);
  assert.equal(voice0(swapped).renderPitch, base);
  render(swapped, 1);
  assert.equal(voice0(swapped).renderPitch, base + 0x0234);
  render(swapped, 1);
  assert.equal(voice0(swapped).renderPitch, base + 0x0567);
});

test("J extended does not disturb classic J's own memory (different units, private)", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_J, arg: 0x0500 }, // classic: off1 = $05<<8
  ]);
  render(eng, 1);
  render(eng, 1);
  assert.equal(voice0(eng).renderPitch, 0x5000 + (0x05 << 8), "classic J still <<8-scales its byte");
});

test("O extended: a 32-bit offset, O's own argument the HIGH word", () => {
  // Driven directly against applyEffectRow rather than through the tracker's
  // per-sample loop: O only ever touches the voice it is passed (no eng/ts/
  // playhead reads), and normal playback keeps advancing samplePos every
  // output sample once set — a chunk-quantised render() would drift a few
  // hundred samples past the value O just wrote before a test could see it.
  const voice = {
    activeLoopMode: 0, activeSampleLoopStart: 0, activeSampleLoopEnd: 0,
    samplePos: 0, mem: { o: 0, oExt: 0 },
  };
  applyEffectRow(null, null, null, voice, 0, EffectOp.OP_O, 0x0001, 0x0002);
  assert.equal(voice.samplePos, 1 * 65536 + 2, "O's arg is the high word, `:`'s the low word");

  // Recall: a combined argument of $00000000 recalls the last 32-bit value —
  // separately from the classic 16-bit memory (different units, item 162).
  applyEffectRow(null, null, null, voice, 0, EffectOp.OP_O, 0x0000, 0x0000);
  assert.equal(voice.samplePos, 1 * 65536 + 2, "recalled the extended memory");
});

test("O extended combines arithmetically, not with a 32-bit shift (no signed overflow)", () => {
  // rawArg's top bit set is exactly where `high << 16` would overflow a
  // signed 32-bit int; `high * 65536 + low` must not.
  const voice = {
    activeLoopMode: 0, activeSampleLoopStart: 0, activeSampleLoopEnd: 0,
    samplePos: 0, mem: { o: 0, oExt: 0 },
  };
  applyEffectRow(null, null, null, voice, 0, EffectOp.OP_O, 0x8001, 0x0002);
  assert.equal(voice.samplePos, 0x8001 * 65536 + 2);
  assert.ok(voice.samplePos > 0, "positive, not wrapped negative");
});

test("`:` in BOTH effect slots of one row is inert — nothing left for it to extend", () => {
  const withColons = makeWideEngine();
  loadWideSong(withColons, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_COLON, arg: 0x1234,
      effect2: EffectOp.OP_COLON, arg2: 0x5678 },
  ]);
  const bare = makeWideEngine();
  loadWideSong(bare, [{ row: 0, note: 0x5000, inst: 1 }]);
  const bufA = new Uint8Array(TRACKER_CHUNK * 2);
  const bufB = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < 8; i++) {
    withColons.renderChunk(0, bufA);
    bare.renderChunk(0, bufB);
    assert.deepEqual([...bufA], [...bufB], `chunk ${i} diverged`);
  }
});

test("2/3 extended: $xuu rotate steps on the sub-tick $yk clock", () => {
  const eng = makeWideEngine();
  // $se = $0F (whole domain), $x = 2 (rotate-left group); `:` supplies uu=$01
  // (rotate 1 byte/step) and k=$8 -> $yk = $08, period 0 + 8/16 = 0.5 tick —
  // two steps per tick, so a full 6-tick row steps twelve times.
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f20,
      effect2: EffectOp.OP_COLON, arg2: 0x0018 },
  ]);
  render(eng, 6);
  const inst = eng.instruments[1];
  assert.equal(inst.modOpExt, 0x201, "$xuu combined from both slots' nibbles");
  assert.equal(inst.modRot, 12 % 1000, "twelve 1-byte steps over the row, wrapped into the domain");
});

test("2/3 extended: the classic per-tick clock never runs for an extended voice", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f20,
      effect2: EffectOp.OP_COLON, arg2: 0x0018 },
  ]);
  render(eng, 1);
  assert.equal(voice0(eng).modExtended, true);
  assert.equal(voice0(eng).modPeriod, 0, "the tick-count clock stays parked");
});

/** Instrument slot 1, sampleLen bytes, with a loop [0, loopEnd) — or NO loop
 *  at all when loopEnd is 0 (loopMode left off), matching how an Ixmp patch
 *  can clear an instrument's loop entirely (item 173 follow-up repro,
 *  "samplemodtest_widecell.taud": inst 1's patch has loopStart=loopEnd=0). */
/**
 * `physLen` is the size of the underlying sample DATA (the funk walk's true
 * search space); `loopEnd` is the instrument's own declared loop [0, loopEnd)
 * — the "replen" that becomes the hop. `physLen` may exceed `loopEnd` to give
 * the walk room, exactly the way a Z $Ffxx instrument needs slack past its
 * own loop.
 */
function makeFunkTestEngine(physLen, loopEnd) {
  const eng = makeWideEngine();
  for (let i = 0; i < physLen; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, physLen); w16(6, 32000); w16(12, loopEnd);
  rec[14] = loopEnd > 0 ? 1 : 0; // forward loop, or no loop at all
  rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);
  return eng;
}

test("2/3 extended: $102 funk repeat walks the WHOLE SAMPLE, replen (the loop's own length) a hop at a time", () => {
  // The corrected model (item 173 follow-up, "funking must be done on the
  // entire sample as the domain... the 'loop' interpreted by funking... is
  // 'add replen to repeat'"): $se's resolved region (here the declared
  // 4000-byte loop) is the HOP, not a boundary the walk wraps inside of — the
  // walk instead searches the true physical sample (8000 bytes: 4000 of loop
  // plus 4000 of slack past it) for room, exactly like Z $Ffxx does. Finest
  // hop = loopLen>>3 = 500 bytes; room = physLen - loopLen - loopStart = 4000,
  // so the grid has 8 hops of headroom before it wraps home.
  const eng = makeFunkTestEngine(8000, 4000);
  // $se = $0F (whole domain = the loop), $x = 1, uu = $02 ($102 = funk
  // repeat), yk = $10 -> y=1,k=0 -> exactly 1 tick/step.
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f11,
      effect2: EffectOp.OP_COLON, arg2: 0x0020 },
  ]);
  const inst = eng.instruments[1];
  const walks = [];
  for (let r = 1; r <= 9; r++) { render(eng, 1); walks.push(inst.modFunkWalk); }
  assert.equal(inst.modOpExt, 0x102);
  // Reaches all the way to 4000 — deep into the slack PAST the declared
  // loop, which is exactly what a domain-bounded walk (the old, wrong model)
  // could never do — before wrapping home on the 9th step.
  assert.deepEqual(walks, [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 0],
    "an even 500-byte grid walk through the physical sample, reaching past the declared loop");
});

test("2/3 extended: $102 funk repeat is inert when the loop already fills the whole sample, same as Z $Ffxx", () => {
  // A loop with no room to move keeps 1.0C's inert behaviour (the rule Z
  // $Ffxx already follows) — this is no longer a special case this command
  // routes around, it is the SAME formula: replen (4000) leaves zero slack
  // in a 4000-byte physical sample.
  const eng = makeFunkTestEngine(4000, 4000);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f11,
      effect2: EffectOp.OP_COLON, arg2: 0x0020 },
  ]);
  const inst = eng.instruments[1];
  const walks = [];
  for (let r = 1; r <= 9; r++) { render(eng, 1); walks.push(inst.modFunkWalk); }
  assert.deepEqual(walks, [0, 0, 0, 0, 0, 0, 0, 0, 0],
    "no room past the domain -> permanently at the loop start, exactly Z's own rule");
});

test("2/3 extended: $12x funk-jittered rides a jitter ON TOP OF the same grid walk, not in place of it", () => {
  const eng = makeFunkTestEngine(8000, 4000);
  // $xuu = $120 (funk repeat, jittered, reach rung 0 — the narrowest), same
  // region and clock as above.
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f11,
      effect2: EffectOp.OP_COLON, arg2: 0x0200 },
  ]);
  const inst = eng.instruments[1];
  for (let r = 1; r <= 8; r++) {
    render(eng, 1);
    // The jittered pointer (modFunkPos) must stay close to the SAME
    // deterministic walk (modFunkWalk) it is measured from every step, not
    // wander off on its own — reach rung 0 is at most one 500-byte hop away.
    assert.ok(Math.abs(inst.modFunkPos - inst.modFunkWalk) <= 500,
      `step ${r}: modFunkPos ${inst.modFunkPos} must stay near modFunkWalk ${inst.modFunkWalk} (a jitter, not a free throw)`);
  }
  assert.equal(inst.modOpExt, 0x120);
});

test("2/3 extended: $102 funk repeat relocates the voice's OWN loop window at the wrap, like Z $Ffxx", () => {
  // The engine-level regression this whole rewrite is about: a funk'd voice
  // must actually be heard playing past the declared loop once its window
  // has walked there, not stay stuck reading the same small loop forever.
  const eng = makeFunkTestEngine(8000, 4000);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f11,
      effect2: EffectOp.OP_COLON, arg2: 0x0020 },
  ]);
  const v = voice0(eng);
  render(eng, 1); // one step: inst.modFunkWalk/modFunkPos -> 500, but the
                   // voice has not WRAPPED its loop yet, so it is not windowed.
  assert.equal(v.modFunkWindow, -1, "no wrap yet -> the voice has not latched a window");
  // Run long enough for the loop (4000 bytes at rate ~1) to wrap several
  // times, latching the walked window each time.
  render(eng, 40);
  assert.ok(v.modFunkWindow > 0,
    `after several wraps the voice should be sounding a relocated window, got ${v.modFunkWindow}`);
  assert.ok(v.samplePos >= v.modFunkWindow && v.samplePos < v.modFunkWindow + 4000,
    "the voice's own read position must sit INSIDE the window it latched");
});

test("2/3 extended: $101 invert toggles the byte in what the voice actually PLAYS, not just its own mask", () => {
  // Regression (item 173 follow-up, user report: "11x-touched samples are
  // not read by the engine; engine still reads pre-modified samples"):
  // readSamplePoint's extended branch ran applyExtLevel (which only knows
  // about the sub/xor/bit-rotate/bit-permute kinds) and never consulted
  // inst.modMask at all — so $101/$11x kept the mask itself correct
  // (toggleModBit, and the sample view's overlay, which reads modMask
  // directly) while the actual audio fetch silently played the UNMODIFIED
  // byte every time.
  const eng = makeWideEngine();
  // $se = $0F (whole domain), $x = 1, uu = $01 ($101 = invert), yk = $10 ->
  // 1 tick/step, so several bytes are toggled well within one row.
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f11,
      effect2: EffectOp.OP_COLON, arg2: 0x0010 },
  ]);
  render(eng, 6);
  const inst = eng.instruments[1];
  const voice = voice0(eng);
  assert.equal(inst.modOpExt, 0x101);
  assert.ok(inst.modMask !== null, "the walk toggled at least one bit");
  let toggled = -1;
  for (let k = 0; k < inst.modMask.length * 8 && k < 1000; k++) {
    if ((inst.modMask[k >>> 3] >>> (k & 7)) & 1) { toggled = k; break; }
  }
  assert.ok(toggled >= 0, "found a toggled byte to check");
  const raw = eng.sampleBin[voice.activeSamplePtr + toggled];
  const played = readSamplePoint(eng, voice, inst, toggled, 1000,
    eng.sampleBin.length - 1, voice.activeSamplePtr);
  const expected = ((raw ^ 0xff) - 127.5) / 127.5;
  assert.ok(Math.abs(played - expected) < 1e-9,
    `byte ${toggled}: engine must PLAY the inverted byte (raw ${raw}), got ${played} not ${expected}`);
});

test("2/3 extended: $11x (invert, jittered) is audible the same way $101 is", () => {
  const eng = makeWideEngine();
  // $xuu = $110 (invertJit, reach rung 0 — the narrowest jitter), same clock.
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_3, arg: 0x0f11,
      effect2: EffectOp.OP_COLON, arg2: 0x0100 },
  ]);
  render(eng, 6);
  const inst = eng.instruments[1];
  const voice = voice0(eng);
  assert.equal(inst.modOpExt, 0x110);
  assert.ok(inst.modMask !== null, "the jittered walk toggled at least one bit");
  let toggled = -1;
  for (let k = 0; k < inst.modMask.length * 8 && k < 1000; k++) {
    if ((inst.modMask[k >>> 3] >>> (k & 7)) & 1) { toggled = k; break; }
  }
  assert.ok(toggled >= 0, "found a toggled byte to check");
  const raw = eng.sampleBin[voice.activeSamplePtr + toggled];
  const played = readSamplePoint(eng, voice, inst, toggled, 1000,
    eng.sampleBin.length - 1, voice.activeSamplePtr);
  const expected = ((raw ^ 0xff) - 127.5) / 127.5;
  assert.ok(Math.abs(played - expected) < 1e-9,
    `byte ${toggled}: engine must PLAY the inverted byte (raw ${raw}), got ${played} not ${expected}`);
});
