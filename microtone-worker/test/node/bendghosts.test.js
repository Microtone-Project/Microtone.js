// Bend ghosts (src/doc/bendghosts.js) — the DISPLAY trace of a pitch / volume
// / panning bend. The map has to agree with what the engine actually plays, so
// the last test drives the real engine over the same pattern and compares its
// voice state at every row boundary against the predicted trail.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bendGhosts, createBendSim } from "../../src/doc/bendghosts.js";
import { dittoGhosts } from "../../src/doc/ditto.js";
import { TaudPlayData } from "../../src/engine/state.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { EffectOp } from "../../src/engine/tables.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";

// Pinned to the Kotlin engine's 32 kHz, as every other engine-driving test is.
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

/** Put an effect on a row. */
function fx(cell, op, arg) { cell.effect = op; cell.effectArg = arg; }

/** The ghost field of every row, as a compact array for whole-trail asserts. */
const trail = (g, field, n = 8) =>
  Array.from({ length: n }, (_, r) => g[r]?.[field] ?? null);

const OPTS = { rowLimit: 64, speed: 6 }; // 6 ticks/row → 5 slide ticks

// ── nothing to report ──────────────────────────────────────────────────────
test("a pattern with no bend in it has no ghosts at all", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[4].note = 0x5800; p[4].instrment = 1;
  p[8].note = 0x0001;                       // key-off
  assert.deepEqual(bendGhosts(p, OPTS).filter((g) => g !== null), []);
});

test("an unmaterialised pattern gap yields an empty map", () => {
  assert.deepEqual(bendGhosts(null, OPTS), []);
});

// ── pitch ──────────────────────────────────────────────────────────────────
test("F slides up by speed-1 ticks a row, and the trail stops where it does", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_F, 0x0100);
  fx(p[1], EffectOp.OP_F, 0x0100);
  const g = bendGhosts(p, OPTS);
  assert.equal(g[0], null, "the note row shows its own note, never a ghost");
  assert.equal(g[1].note, 0x5500, "5 ticks × $0100 after row 0");
  assert.equal(g[2].note, 0x5a00, "…and 5 more after row 1");
  assert.equal(g[3], null, "the command stopped, so the pitch stopped moving");
});

test("E slides down, and its `$Fxxx` fine form lands on the row itself", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[1], EffectOp.OP_E, 0x0080);
  assert.equal(bendGhosts(p, OPTS)[2].note, 0x5000 - 5 * 0x80);

  const q = blankPattern();
  q[0].note = 0x5000; q[0].instrment = 1;
  fx(q[1], EffectOp.OP_E, 0xf040);          // one-shot, at tick 0
  const g = bendGhosts(q, OPTS);
  assert.equal(g[1].note, 0x5000 - 0x40, "the fine slide shows on its OWN row");
  assert.equal(g[2], null, "and moves nothing afterwards");
});

test("a slide recalls its argument from memory on a $0000 row", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_F, 0x0100);
  fx(p[1], EffectOp.OP_F, 0x0000);          // recall
  const g = bendGhosts(p, OPTS);
  assert.equal(g[2].note, 0x5a00, "the recalled slide moved as far as the first");
});

test("G keeps bending over rows carrying no command, and stops on arrival", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[2].note = 0x5800; fx(p[2], EffectOp.OP_G, 0x0100);
  const g = bendGhosts(p, OPTS);
  assert.equal(g[2], null, "the porta row shows the TARGET in its note column");
  assert.equal(g[3].note, 0x5500, "…and rows 3-4 glide to it with no command at all");
  assert.equal(g[4].note, 0x5800, "arrived");
  assert.equal(g[5], null, "a finished porta leaves nothing behind");
});

test("S $2x finetune ghosts like a fine slide — the result is nowhere on the row", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[1], EffectOp.OP_S, 0x2900);          // +$23 units
  const g = bendGhosts(p, OPTS);
  assert.equal(g[1].note, 0x5023);
  assert.equal(g[2], null);
});

test("a fresh note cancels the bend and re-seeds the trail", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_F, 0x0100);
  p[1].note = 0x4000; p[1].instrment = 1;   // retrigger, written down
  const g = bendGhosts(p, OPTS);
  assert.equal(g[1], null, "the note column says it, so nothing is ghosted");
  assert.equal(g[2], null, "…and the trigger cancelled the slide");
});

test("a note cut ends the trail: nothing bends in silence", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_F, 0x0100);
  p[1].note = 0x0002;                        // ^^^
  fx(p[2], EffectOp.OP_F, 0x0100);
  assert.deepEqual(trail(bendGhosts(p, OPTS), "note", 6),
    [null, null, null, null, null, null]);
});

// ── volume ─────────────────────────────────────────────────────────────────
test("D walks the note volume, and the fine forms land at tick 0", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[0].volume = 0x30; p[0].volumeEff = 0;   // SET 48
  fx(p[0], EffectOp.OP_D, 0x0400);          // −4 a tick
  fx(p[1], EffectOp.OP_D, 0x0400);
  const g = bendGhosts(p, OPTS);
  assert.equal(g[1].vol, 0x30 - 20);
  assert.equal(g[2].vol, 0x30 - 40);
  assert.equal(g[3], null);

  const q = blankPattern();
  q[0].note = 0x5000; q[0].instrment = 1;
  q[0].volume = 0x30; q[0].volumeEff = 0;
  fx(q[1], EffectOp.OP_D, 0xf400);          // fine down 4, at tick 0
  const h = bendGhosts(q, OPTS);
  assert.equal(h[1].vol, 0x30 - 4, "on the row itself");
  assert.equal(h[2], null);
});

test("the volume column's own slide ghosts the same way", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[0].volume = 0x20; p[0].volumeEff = 0;
  p[1].volume = 3; p[1].volumeEff = 1;      // slide up 3/tick
  const g = bendGhosts(p, OPTS);
  assert.equal(g[1], null, "the column states the slide, so its row is not blank");
  assert.equal(g[2].vol, 0x20 + 15);
});

test("a volume the ghost cannot know is not guessed at", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[0].volume = 0x30; p[0].volumeEff = 0;
  fx(p[1], EffectOp.OP_Q, 0x8200);          // retrigger + volume modifier
  fx(p[2], EffectOp.OP_D, 0x0400);
  const g = bendGhosts(p, OPTS);
  assert.equal(trail(g, "vol", 6).every((x) => x === null), true,
    "Q is not simulated, so the axis goes quiet rather than drifting wrong");

  p[4].volume = 0x20; p[4].volumeEff = 0;   // …until something states it again
  fx(p[4], EffectOp.OP_D, 0x0400);
  assert.equal(bendGhosts(p, OPTS)[5].vol, 0x20 - 20);
});

test("a trigger's own default volume is never ghosted — nothing bent it", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[0].volume = 0x10; p[0].volumeEff = 0;
  fx(p[0], EffectOp.OP_D, 0x0400);
  p[2].note = 0x5000; p[2].instrment = 1;   // re-seeds the volume, blank column
  const g = bendGhosts(p, OPTS);
  assert.ok(g[1].vol !== null, "the slide's own row still reports");
  assert.equal(g[2], null, "but a re-seed is not a bend");
});

// ── panning ────────────────────────────────────────────────────────────────
test("P walks the channel pan, reported in the column's own units", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_P, 0x0400);          // right 4 a tick, from centre $80
  fx(p[1], EffectOp.OP_P, 0x0400);
  const g = bendGhosts(p, OPTS);
  assert.equal(g[1].pan, (0x80 + 20) >> 2);
  assert.equal(g[2].pan, (0x80 + 40) >> 2);
  assert.equal(g[3], null);
});

test("the panning column's slide moves the NOTE axis, and both axes sum", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_S, 0x8040);          // channel hard-ish left
  p[1].pan = 4; p[1].panEff = 2;            // column: slide LEFT 4/tick
  const g = bendGhosts(p, OPTS);
  assert.equal(g[0], null, "S $80xx states the position in its own argument");
  assert.equal(g[2].pan, Math.max(0x40 - 20, 0) >> 2);
});

test("S $80xx is a statement, not a bend, so it ghosts nothing", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[1], EffectOp.OP_S, 0x80c0);
  assert.deepEqual(trail(bendGhosts(p, OPTS), "pan", 4), [null, null, null, null]);
});

// ── the row's tick count ───────────────────────────────────────────────────
test("effect A changes how far one row's slide gets", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[0], EffectOp.OP_A, 0x0300);          // speed 3 → 2 slide ticks
  fx(p[1], EffectOp.OP_F, 0x0100);
  assert.equal(bendGhosts(p, OPTS)[2].note, 0x5200);
});

test("S $6x lengthens the row, S $Ex replays it — both stretch the bend", () => {
  const fine = blankPattern();
  fine[0].note = 0x5000; fine[0].instrment = 1;
  fine[1].effect = EffectOp.OP_S; fine[1].effectArg = 0x6200; // +2 ticks
  fine[1].effect2 = EffectOp.OP_F; fine[1].effectArg2 = 0x0100;
  assert.equal(bendGhosts(fine, { ...OPTS, wide: true })[2].note, 0x5000 + 7 * 0x100);

  const delay = blankPattern();
  delay[0].note = 0x5000; delay[0].instrment = 1;
  delay[1].effect = EffectOp.OP_S; delay[1].effectArg = 0xe100;  // row runs twice
  delay[1].effect2 = EffectOp.OP_F; delay[1].effectArg2 = 0x0100;
  assert.equal(bendGhosts(delay, { ...OPTS, wide: true })[2].note, 0x5000 + 10 * 0x100);
});

// ── the ghost rule, and the row limit ──────────────────────────────────────
test("ghosts fill blanks only — anything written wins its own sub-column", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[0].volume = 0x30; p[0].volumeEff = 0;
  fx(p[0], EffectOp.OP_D, 0x0400);
  p[1].note = 0x4800;                        // written note…
  p[2].volume = 0x3f; p[2].volumeEff = 0;    // …written volume
  fx(p[1], EffectOp.OP_D, 0x0400);
  fx(p[2], EffectOp.OP_D, 0x0400);
  const g = bendGhosts(p, OPTS);
  assert.equal(g[1].note ?? null, null, "row 1's note column is occupied");
  assert.ok(g[1].vol !== null, "…but its volume column is not");
  assert.equal(g[2], null, "row 2 states its volume outright");
});

test("the trail stops at the cue's row limit", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  for (let r = 0; r < 12; r++) fx(p[r], EffectOp.OP_F, 0x0100);
  const g = bendGhosts(p, { rowLimit: 4, speed: 6 });
  assert.ok(g[3], "row 3 still bends");
  assert.equal(g[4], null, "rows past the limit never play");
  assert.equal(g.length, 64, "the map still spans the whole pattern");
});

// ── the two ghost kinds together ───────────────────────────────────────────
test("a ditto-repeated slide bends, and the ditto ghost speaks first", () => {
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  fx(p[1], EffectOp.OP_F, 0x0100);
  // 7 $0101 on row 2 repeats row 1 — its F included, though row 2 shows none.
  fx(p[2], EffectOp.OP_7, 0x0101);
  const ditto = dittoGhosts(p, 64);
  const g = bendGhosts(p, { ...OPTS, ditto });
  assert.equal(g[2].note, 0x5500, "row 2 holds what row 1's slide reached");
  assert.equal(g[3].note, 0x5a00, "…and the repeated F moved it again");
});

// ── carried across patterns (what the Timeline chains) ─────────────────────
test("a sim carried into the next pattern keeps bending through the join", () => {
  const head = blankPattern();
  head[62].note = 0x4000; head[62].instrment = 1;
  head[63].note = 0x6000; fx(head[63], EffectOp.OP_G, 0x0100);  // a long way to travel
  const tail = blankPattern();                                   // …and nothing at all here

  // One pattern at a time: the second one knows nothing and shows nothing.
  assert.deepEqual(bendGhosts(tail, OPTS).filter(Boolean), []);

  // Chained, it carries the glide in and goes on bending from row 0.
  const sim = createBendSim({ speed: 6 });
  sim.run(head, { rowLimit: 64 });
  const g = sim.run(tail, { rowLimit: 64 });
  assert.ok(g[0]?.note != null, "row 0 of the second pattern reports the glide");
  assert.ok(g[1].note > g[0].note, "…and it is still climbing");
  const bending = g.filter((x) => x?.note != null).length;
  assert.ok(bending > 4, `the trail runs on (${bending} rows)`);
});

test("a chain carries the volume and the pan across too, not just the pitch", () => {
  const head = blankPattern();
  head[0].note = 0x5000; head[0].instrment = 1;
  head[0].volume = 0x30; head[0].volumeEff = 0;
  fx(head[0], EffectOp.OP_S, 0x8040);          // channel pan well left
  const tail = blankPattern();
  fx(tail[0], EffectOp.OP_D, 0x0400);          // a volume slide with no note of its own
  fx(tail[1], EffectOp.OP_P, 0x0400);

  const sim = createBendSim({ speed: 6 });
  sim.run(head, { rowLimit: 64 });
  const g = sim.run(tail, { rowLimit: 64 });
  assert.equal(g[1].vol, 0x30 - 20, "the volume it fades from came from the pattern before");
  assert.equal(g[2].pan, (0x40 + 20) >> 2, "…and the pan it slides from likewise");
});

test("a null pattern (an empty cue slot) advances nothing", () => {
  const head = blankPattern();
  head[0].note = 0x5000; head[0].instrment = 1;
  fx(head[0], EffectOp.OP_F, 0x0100);
  const tail = blankPattern();
  fx(tail[0], EffectOp.OP_F, 0x0100);

  const straight = createBendSim({ speed: 6 });
  straight.run(head, { rowLimit: 64 });
  const a = straight.run(tail, { rowLimit: 64 });

  const gapped = createBendSim({ speed: 6 });
  gapped.run(head, { rowLimit: 64 });
  assert.deepEqual(gapped.run(null, { rowLimit: 64 }), [], "a gap reports nothing");
  const b = gapped.run(tail, { rowLimit: 64 });
  assert.deepEqual(b.map((x) => x?.note ?? null), a.map((x) => x?.note ?? null),
    "…and leaves the voice holding exactly what it held");
});

// ── engine agreement ───────────────────────────────────────────────────────
test("the ghosted trail is the state the ENGINE is actually in", () => {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);

  // One note, then a pitch slide, a volume slide and a pan slide over it —
  // every axis the ghosts report, bending at once.
  const p = blankPattern();
  p[0].note = 0x5000; p[0].instrment = 1;
  p[0].volume = 0x30; p[0].volumeEff = 0;
  for (const r of [0, 1, 2]) {
    fx(p[r], EffectOp.OP_F, 0x0100);
    p[r].pan = 4; p[r].panEff = 1;          // column: slide right 4 a tick
  }
  fx(p[3], EffectOp.OP_D, 0x0400);
  fx(p[4], EffectOp.OP_G, 0x0200); p[4].note = 0x4000;
  const bytes = new Uint8Array(512);
  for (let r = 0; r < 64; r++) for (let o = 0; o < 8; o++) bytes[r * 8 + o] = p[r].getByte(o);
  eng.uploadPattern(0, bytes);

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
  // One chunk is shorter than one tick (128 < 640 samples @125 BPM, 32 kHz),
  // so tickInRow can never skip a value: sampling at tick 0 or 1 of each row
  // catches the state before that row's first slide tick has run.
  const seen = new Map();
  for (let i = 0; i < 8 * 6 * 640 / TRACKER_CHUNK; i++) {
    eng.renderChunk(0, out);
    if (ts.tickInRow <= 1 && !seen.has(ts.rowIndex)) {
      seen.set(ts.rowIndex, {
        note: v.noteVal,
        vol: v.noteVolume,
        pan: Math.max(0, Math.min(v.channelPan + v.notePan, 0xff)) >> 2,
      });
    }
  }

  const g = bendGhosts(p, { ...OPTS, instruments: eng.instruments });
  for (let r = 1; r <= 6; r++) {
    const engineState = seen.get(r);
    assert.ok(engineState, `row ${r} was rendered`);
    if (g[r]?.note != null) {
      assert.equal(g[r].note, engineState.note, `row ${r}: ghosted pitch`);
    }
    if (g[r]?.vol != null) {
      assert.equal(g[r].vol, engineState.vol, `row ${r}: ghosted volume`);
    }
    if (g[r]?.pan != null) {
      assert.equal(g[r].pan, engineState.pan, `row ${r}: ghosted panning`);
    }
  }
  // …and the trail was not vacuously empty.
  assert.ok(g[1]?.note != null && g[3]?.pan != null && g[4]?.vol != null,
    "all three axes reported somewhere in the trail");
});
