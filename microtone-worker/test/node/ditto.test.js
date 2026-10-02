// Pattern-Ditto (effect 7) DISPLAY expansion — src/doc/ditto.js. The map must
// agree with what the engine actually plays (core/engine/row.js), so the last
// test drives the real engine over the same pattern and checks the note the
// ghost predicts is the note that sounds.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dittoGhosts, OP_DITTO } from "../../src/doc/ditto.js";
import { TaudPlayData } from "../../core/engine/state.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";

// Pinned to the Kotlin engine's 32 kHz (item 108 moved the web default to
// 48 kHz): the expectations below are sample counts and reference renders
// taken from AudioAdapter.kt, and they stay diffable against it.
setSamplingRate(32000);

// ── helpers ────────────────────────────────────────────────────────────────
/** 64 blank rows (vol/pan carry the SEL_FINE-0 no-op, the blank convention). */
function blankPattern(rows = 64) {
  const p = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const c = new TaudPlayData();
    c.volumeEff = 3; c.volume = 0;
    c.panEff = 3; c.pan = 0;
    p[r] = c;
  }
  return p;
}

/** 7$llrr — repeat the ll rows above this one, rr times. */
function arm(cell, len, repeats) {
  cell.effect = OP_DITTO;
  cell.effectArg = ((len & 0xff) << 8) | (repeats & 0xff);
}

test("no effect 7 anywhere → no ghosts at all", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  assert.deepEqual(dittoGhosts(p, 64).filter((g) => g !== null), []);
});

test("the ARMING row is itself the first repeat", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 3;
  arm(p[1], 1, 3);                 // rows 1,2,3 repeat row 0
  const g = dittoGhosts(p, 64);
  assert.equal(g[0], null, "the source row is never a ghost");
  for (const r of [1, 2, 3]) {
    assert.ok(g[r], `row ${r} covered`);
    assert.equal(g[r].srcRow, 0);
    assert.equal(g[r].note, 0x5000);
    assert.equal(g[r].inst, 3);
  }
  assert.equal(g[4], null, "region ends at srcStart + len*repeats - 1");
});

test("multi-row blocks cycle through the source rows in order", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[1].note = 0x5100; p[2].note = 0x5200;
  arm(p[3], 3, 2);                 // rows 3..8 repeat rows 0,1,2 twice
  const g = dittoGhosts(p, 64);
  const src = [3, 4, 5, 6, 7, 8].map((r) => g[r].srcRow);
  assert.deepEqual(src, [0, 1, 2, 0, 1, 2]);
  assert.deepEqual([3, 4, 5, 6, 7, 8].map((r) => g[r].note),
    [0x5000, 0x5100, 0x5200, 0x5000, 0x5100, 0x5200]);
  assert.equal(g[9], null);
});

test("ghosts fill ONLY the sub-columns the repeated row leaves blank", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 7;
  p[0].volume = 0x20; p[0].volumeEff = 0;
  p[0].pan = 0x10; p[0].panEff = 0;
  p[0].effect = 0x01; p[0].effectArg = 0x0123;
  arm(p[1], 1, 2);
  // Row 2 overrides the note and the volume; the rest is inherited.
  p[2].note = 0x5c00;
  p[2].volume = 0x3f; p[2].volumeEff = 0;
  const g = dittoGhosts(p, 64);

  assert.equal(g[1].note, 0x5000);
  assert.deepEqual(g[1].vol, [0x20, 0]);
  assert.deepEqual(g[1].pan, [0x10, 0]);
  // The arming row's OWN 7$llrr stays visible — the display never covers real
  // content, even though the engine substitutes the source's effect there.
  assert.equal(g[1].fx, null);

  assert.equal(g[2].note, null, "explicit note wins");
  assert.equal(g[2].vol, null, "explicit volume wins");
  assert.equal(g[2].inst, 7, "instrument still inherited");
  assert.deepEqual(g[2].fx, [0x01, 0x0123], "effect inherited into a blank fx column");
});

test("a source row's own ditto opcode is never inherited", () => {
  const p = blankPattern();
  p[0].note = 0x5000;
  arm(p[1], 1, 1);                 // row 1 repeats row 0
  arm(p[2], 2, 2);                 // rows 2..5 repeat rows 0,1 — row 1 carries a 7
  const g = dittoGhosts(p, 64);
  assert.equal(g[3].srcRow, 1);
  assert.equal(g[3].fx, null, "src.effect === OP_7 → no fx ghost");
});

test("malformed arms (zero length/repeats, or reaching above row 0) are ignored", () => {
  const p = blankPattern();
  p[0].note = 0x5000;
  arm(p[1], 0, 4);                 // length 0
  arm(p[2], 4, 1);                 // length > row index
  arm(p[3], 2, 0);                 // repeats 0
  assert.deepEqual(dittoGhosts(p, 64).filter((g) => g !== null), []);
  // effectArg 0 isn't an arm at all, and must not disturb a live region.
  const q = blankPattern();
  q[0].note = 0x5000;
  arm(q[1], 1, 3);
  q[2].effect = OP_DITTO; q[2].effectArg = 0;
  const g = dittoGhosts(q, 64);
  assert.equal(g[3].srcRow, 0, "the live region survives a bare 7$0000");
});

test("a second arm re-binds the region", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[4].note = 0x5c00;
  arm(p[1], 1, 8);                 // would run rows 1..8 off row 0
  arm(p[5], 1, 2);                 // rebinds at row 5 → rows 5,6 repeat row 4
  const g = dittoGhosts(p, 64);
  assert.equal(g[3].srcRow, 0);
  assert.equal(g[5].srcRow, 4);
  assert.equal(g[6].note, 0x5c00);
  assert.equal(g[7], null, "the new, shorter region ends the old one");
});

test("the region is clamped to the cue's row limit", () => {
  const p = blankPattern();
  p[0].note = 0x5000;
  arm(p[1], 1, 60);
  const g = dittoGhosts(p, 8);     // cue plays only 8 rows
  assert.ok(g[7], "row 7 covered");
  assert.equal(g[8], null, "nothing past the row limit");
  assert.equal(g.length, 64, "map still spans the whole pattern");
});

test("an unmaterialised pattern gap yields an empty map", () => {
  assert.deepEqual(dittoGhosts(null, 64), []);
});

// ── engine agreement ───────────────────────────────────────────────────────
test("the ghosted note is the note the ENGINE actually plays", () => {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);

  // Row 0 plays C4 on inst 1; row 1 is blank but carries 7$0101, so the engine
  // must retrigger C4 there. Row 2 is plain blank — nothing new.
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  arm(p[1], 1, 1);
  const bytes = new Uint8Array(512);
  for (let r = 0; r < 64; r++) for (let o = 0; o < 8; o++) bytes[r * 8 + o] = p[r].getByte(o);
  eng.uploadPattern(0, bytes);

  const g = dittoGhosts(p, 64);
  assert.equal(g[1].note, 0x5000, "display predicts a C4 on row 1");

  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255); eng.setCuePosition(0, 0);
  eng.play(0);

  const ts = eng.playheads[0].trackerState;
  const v = ts.voices[0];
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const rowSamples = 6 * 640; // 6 ticks × 640 samples/tick @125 BPM, 32 kHz
  const renderTo = (samples) => {
    for (let i = 0; i < Math.ceil(samples / TRACKER_CHUNK); i++) eng.renderChunk(0, out);
  };

  renderTo(rowSamples * 0.5);
  assert.equal(ts.rowIndex, 0);
  const posBeforeRow1 = v.samplePos;
  assert.ok(posBeforeRow1 > 0, "row 0 note is sounding");

  renderTo(rowSamples * 0.6); // into row 1 — the ditto repeat
  assert.equal(ts.rowIndex, 1);
  assert.equal(v.noteVal, 0x5000, "engine plays the ghosted note");
  assert.ok(v.samplePos < posBeforeRow1, "the ditto row RETRIGGERED the sample");
});
