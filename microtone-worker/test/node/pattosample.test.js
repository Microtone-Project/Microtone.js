// Pattern to sample (item 242): the render, the rewrite and the chord stack.
//
// The end-to-end checks play the song again after the rewrite and hold it to
// the original: the block rendered, sized and quantised the way the Sample Lab
// imports it, then replayed by one trigger, has to sound where and as loud as
// the block did. Swing is seeded so the two renders draw the same numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import {
  songEffectKind, timelineRegion, patternRegion, findTrigger, renderRegion,
  planSampleReplacement, detectChordStack, planStackReplacement,
} from "../../src/doc/pattosample.js";
import { planMultiSampleImport, planChordMeta } from "../../src/doc/bankmerge.js";
import { importBankOp, setCellsBytesOp } from "../../src/doc/ops.js";
import { fitToBudget, quantiseU8 } from "../../src/doc/wavelab.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { TRACKER_CHUNK, MIDDLE_C, NOTE_KEY_OFF } from "../../core/engine/constants.js";
import { EffectOp } from "../../core/engine/tables.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { blockToolItems, isBlockTool } from "../../src/ui/blocktools.js";
import { COL_NOTE, COL_FX } from "../../src/ui/edit.js";

const DAISY = new URL("../../assets/demo_projects/Daisy_bell.taud", import.meta.url);
const loadDaisy = () => new Document(parseTaud(readFileSync(DAISY)));
const seeded = () => setRandomSource(makeSeededRandom(7));
const restoreRandom = () => setRandomSource(Math.random);

/** The song from (cue, row), chased, for `seconds`, mastering off — what the
 *  render itself hears. */
function playFrom(doc, cue, row, seconds) {
  seeded();
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc.toRenderable(0), 0);
  eng.setMastering(0, null);
  eng.chaseTrackerRow(0, cue, row);
  eng.play(0);
  const n = Math.ceil((seconds * 48000) / TRACKER_CHUNK);
  const L = new Float32Array(n * TRACKER_CHUNK);
  const R = new Float32Array(n * TRACKER_CHUNK);
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  for (let i = 0; i < n; i++) {
    eng.renderChunk(0, chunk);
    L.set(ts.mixLeft, i * TRACKER_CHUNK);
    R.set(ts.mixRight, i * TRACKER_CHUNK);
  }
  restoreRandom();
  return [L, R];
}

/** What the Sample Lab's Import does with an untouched take. */
function labImport(doc, r) {
  const fitted = r.channels.map((ch) => fitToBudget(ch, r.rate, 32000, 32000));
  const q = fitted.map((f) => quantiseU8(f.data));
  assert.ok(!q.some((x) => x.clipped), "the take must not clip on its way into the pool");
  const plan = planMultiSampleImport(doc, [{
    nameBytes: new Uint8Array(0), pcm: q[0].pcm, pcmR: q[1]?.pcm ?? null, rate: fitted[0].rate,
    attenOctet: r.attenOctet, detune: r.detune,
  }]);
  assert.equal(plan.error, undefined);
  return plan;
}

/** Windowed level difference (dB) of `got` against `ref`, over the windows
 *  where `ref` is audible: {mean, worst}. */
function levelDiff(ref, got, W = 4800) {
  let sum = 0, n = 0, worst = 0;
  for (let i = 0; i + W <= ref[0].length; i += W) {
    let a = 0, b = 0;
    for (let k = i; k < i + W; k++) {
      a += ref[0][k] ** 2 + ref[1][k] ** 2;
      b += got[0][k] ** 2 + got[1][k] ** 2;
    }
    if (a < 1e-5) continue;
    const db = 10 * Math.log10(b / a);
    sum += db; n++;
    worst = Math.max(worst, Math.abs(db));
  }
  return { mean: sum / n, worst, n };
}

async function render(doc, region) {
  seeded();
  try { return await renderRegion(doc, 0, region, { yieldMs: 1e9 }); } finally { restoreRandom(); }
}

test("song effects: timing plays in the render, gain and flow do not", () => {
  assert.equal(songEffectKind(EffectOp.OP_A, 0x0600), "timing");
  assert.equal(songEffectKind(EffectOp.OP_T, 0x8000), "timing");
  assert.equal(songEffectKind(EffectOp.OP_S, 0x6100), "timing"); // fine pattern delay
  assert.equal(songEffectKind(EffectOp.OP_S, 0xe200), "timing"); // pattern delay
  assert.equal(songEffectKind(EffectOp.OP_V, 0x4000), "gain");
  assert.equal(songEffectKind(EffectOp.OP_W, 0x1000), "gain");
  assert.equal(songEffectKind(EffectOp.OP_B, 0x0002), "flow");
  assert.equal(songEffectKind(EffectOp.OP_C, 0x0000), "flow");
  assert.equal(songEffectKind(EffectOp.OP_S, 0xb200), "flow");    // pattern loop
  assert.equal(songEffectKind(EffectOp.OP_S, 0x8080), null);      // lane pan is the lane's
  assert.equal(songEffectKind(EffectOp.OP_D, 0x0100), null);
  assert.equal(songEffectKind(EffectOp.OP_M, 0x3f00), null);
});

test("the menu offers To sample only where the view says it renders", () => {
  const ids = (cols, opts) => blockToolItems(cols, opts).map((i) => i.id);
  assert.ok(!ids([COL_NOTE], { block: true }).includes("toSample"));
  assert.deepEqual(ids([COL_NOTE], { block: true, render: true }).slice(-2), ["toSample", "findchange"]);
  // …and on the effect column's palette row too: it is about the block.
  assert.deepEqual(ids([COL_FX], { render: true }).slice(-2), ["toSample", "findchange"]);
  assert.equal(isBlockTool("toSample"), true);
});

test("a Timeline block renders to a sample that replays it, as loud and in time", async () => {
  const doc = loadDaisy();
  const region = timelineRegion(doc.songs[0], 64, 79, 0, 2); // cue 1, rows 0–15
  assert.equal(detectChordStack(doc, 0, region), null);      // a melody and its harmony
  const r = await render(doc, region);
  assert.equal(r.error, undefined);
  // The sample starts at the block's first note (cue 1 row 2, lane 0)…
  assert.deepEqual([r.trigger.cue, r.trigger.row, r.trigger.ch], [1, 2, 0]);
  assert.equal(r.channels.length, 1, "a block that is the same on both sides renders mono");
  assert.ok(r.blockSeconds > 1 && r.seconds > r.blockSeconds, "and rings past the block's end");
  // …kept near full scale, the rest of its level in the attenuation octet.
  let peak = 0;
  for (const v of r.channels[0]) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.9 && peak <= 1, `peak ${peak}`);

  const ref = playFrom(doc, 1, 2, r.blockSeconds);
  const undo = new UndoStack(doc);
  const plan = labImport(doc, r);
  undo.apply(importBankOp(plan));
  const slot = plan.insts[0].destSlot;
  assert.equal(doc.instruments[slot].initialAttenOctet, r.attenOctet);
  undo.apply(setCellsBytesOp(0, planSampleReplacement(doc, 0, region, r.trigger, slot)));

  // The block holds one trigger now.
  const song = doc.songs[0];
  for (let row = 0; row < 16; row++) {
    for (const ch of [0, 1, 2]) {
      const cell = doc.patternAt(0, song.cues[1][ch] & 0x7fff)[row];
      if (ch === 0 && row === 2) {
        assert.equal(cell.note, MIDDLE_C);
        assert.equal(cell.instrment, slot);
      } else {
        assert.equal(cell.note, 0, `lane ${ch} row ${row}`);
      }
    }
  }
  const got = playFrom(doc, 1, 2, r.blockSeconds);
  const d = levelDiff(ref, got);
  assert.ok(d.n >= 10);
  assert.ok(Math.abs(d.mean) < 0.3, `mean ${d.mean} dB`);
  assert.ok(d.worst < 1, `worst ${d.worst} dB`);

  // Two undo steps: the patterns first, then the instrument.
  undo.undo();
  assert.equal(doc.patternAt(0, song.cues[1][0] & 0x7fff)[2].note, 0x4c00);
  assert.ok(doc.usedInstrumentSlots().includes(slot));
  undo.undo();
  assert.ok(!doc.usedInstrumentSlots().includes(slot));
});

test("the lane the trigger took gets its own instrument back on its next bare note", async () => {
  const doc = loadDaisy();
  const song = doc.songs[0];
  // Lane 1's next note after rows 0–15 of cue 1 is row 2 of cue 2 — strip its
  // instrument, so it leans on the running one.
  const pat = song.cues[2][1] & 0x7fff;
  const next = doc.patternAt(0, pat).findIndex((c) => c.note > 0x1f);
  const was = doc.patternAt(0, pat)[next].instrment;
  doc.patternAt(0, pat)[next].instrment = 0;
  const region = timelineRegion(song, 64, 127, 1, 1);
  const trig = findTrigger(doc, 0, region);
  const writes = planSampleReplacement(doc, 0, region, trig, 0x30);
  const fix = writes.find((w) => w.pat === pat && w.row === next);
  assert.ok(fix, "a write on the next note");
  assert.equal(fix.bytes[2], was);
});

test("a song tuned off concert pitch is cancelled by the sample's detune", async () => {
  const doc = loadDaisy();
  doc.songs[0].tuningFreq = 432;
  const region = timelineRegion(doc.songs[0], 64, 79, 0, 2);
  const r = await render(doc, region);
  assert.equal(r.detune, Math.round(-4096 * Math.log2(432 / 440)));
  const ref = playFrom(doc, 1, 2, r.blockSeconds);
  const plan = labImport(doc, r);
  importBankOp(plan).apply(doc);
  setCellsBytesOp(0, planSampleReplacement(doc, 0, region, r.trigger, plan.insts[0].destSlot)).apply(doc);
  const got = playFrom(doc, 1, 2, r.blockSeconds);
  // Played off pitch, the two would drift apart within a few notes.
  let dot = 0, aa = 0, bb = 0;
  for (let k = 0; k < ref[0].length; k++) { dot += ref[0][k] * got[0][k]; aa += ref[0][k] ** 2; bb += got[0][k] ** 2; }
  assert.ok(dot / Math.sqrt(aa * bb) > 0.97);
});

test("a Patterns-view block renders on its own, and the rewrite stays inside it", async () => {
  const doc = loadDaisy();
  const region = patternRegion(3, 0, 15, doc.channelCount);
  const r = await render(doc, region);
  assert.equal(r.error, undefined);
  assert.deepEqual([r.trigger.pat, r.trigger.row], [3, 2]);
  const writes = planSampleReplacement(doc, 0, region, r.trigger, 0x30);
  assert.ok(writes.every((w) => w.pat === 3));
  assert.ok(writes.every((w) => w.row < 16 || w.bytes[2] !== 0x30));
});

test("nothing to render, and too much", async () => {
  const doc = loadDaisy();
  const song = doc.songs[0];
  // Rows 0–1 of cue 1 hold a key-off and nothing else.
  assert.deepEqual(await render(doc, timelineRegion(song, 64, 65, 0, 0)), { error: "empty" });
  // A whole lane of the song is longer than a sample can hold.
  const lane = timelineRegion(song, 0, song.songMap().totalRows - 1, 0, 0);
  assert.equal((await render(doc, lane)).error, "tooLong");
});

/** Write a three-lane chord stack into a fresh cue past the song's end:
 *  C–E–G on rows 0 and 8 (the second a tone up), key-offs on 6 and 14, all
 *  instrument 1, with a tempo command on lane 0 that belongs to the song. */
function withStack(doc, { breakAt = -1 } = {}) {
  const song = doc.songs[0];
  const cue = song.cues.length;
  const words = new Uint16Array(64).fill(0x7fff);
  const shape = [0, 0x555, 0x955];
  for (let ch = 0; ch < 3; ch++) {
    const pat = song.patterns.length;
    const cells = doc.ensurePattern(0, pat);
    words[ch] = pat;
    for (const [row, root] of [[0, 0x4000], [8, 0x4200]]) {
      cells[row].note = root + shape[ch] + (ch === 2 && row === breakAt ? 0x100 : 0);
      cells[row].instrment = 1;
    }
    for (const row of [6, 14]) cells[row].note = NOTE_KEY_OFF;
    if (ch === 0) { cells[4].effect = EffectOp.OP_T; cells[4].effectArg = 0x8000; }
  }
  song.cues.push(words);
  const start = song.songMap().entries[cue].startRow;
  return { cue, region: timelineRegion(song, start, start + 15, 0, 2) };
}

test("a chord stack becomes a layered instrument played on one lane", async () => {
  const doc = loadDaisy();
  const { cue, region } = withStack(doc);
  const stack = detectChordStack(doc, 0, region);
  assert.ok(stack);
  assert.equal(stack.ref, 0);
  assert.deepEqual(stack.layers, [
    { ch: 0, slot: 1, detune: 0 }, { ch: 1, slot: 1, detune: 0x555 }, { ch: 2, slot: 1, detune: 0x955 },
  ]);
  const ref = playFrom(doc, cue, 0, 1.5);

  const plan = planChordMeta(doc, stack.layers, "stack");
  assert.equal(plan.error, undefined);
  assert.equal(plan.childSlots.length, 1, "one instrument, three linked layers");
  importBankOp(plan).apply(doc);
  const meta = doc.instruments[plan.metaSlot];
  assert.ok(meta.isMeta);
  assert.deepEqual(meta.metaLayers.map((l) => l.detune), [0, 0x555, 0x955]);
  setCellsBytesOp(0, planStackReplacement(doc, 0, region, stack, plan.metaSlot)).apply(doc);

  const song = doc.songs[0];
  const at = (ch, row) => doc.patternAt(0, song.cues[cue][ch] & 0x7fff)[row];
  assert.deepEqual([at(0, 0).note, at(0, 0).instrment], [0x4000, plan.metaSlot]);
  assert.deepEqual([at(0, 8).note, at(0, 8).instrment], [0x4200, plan.metaSlot]);
  assert.equal(at(0, 6).note, NOTE_KEY_OFF, "the stack's own key-offs stay");
  assert.equal(at(0, 4).effect, EffectOp.OP_T, "the song's tempo stays where it was");
  for (const ch of [1, 2]) {
    for (let row = 0; row < 16; row++) assert.equal(at(ch, row).note, 0, `lane ${ch} row ${row}`);
  }
  // Same notes, same instrument: only the lanes' panning could tell them apart.
  const got = playFrom(doc, cue, 0, 1.5);
  const d = levelDiff(ref, got);
  assert.ok(d.worst < 1.5, `worst ${d.worst} dB`);
});

test("a stack that changes shape, or strikes apart, is not one", () => {
  const doc = loadDaisy();
  const { region } = withStack(doc, { breakAt: 8 });
  assert.equal(detectChordStack(doc, 0, region), null);
  const doc2 = loadDaisy();
  const { cue, region: r2 } = withStack(doc2);
  const song = doc2.songs[0];
  doc2.patternAt(0, song.cues[cue][1] & 0x7fff)[3].note = 0x4800; // one lane alone
  assert.equal(detectChordStack(doc2, 0, r2), null);
  // A Patterns-view block is one lane: never a stack.
  assert.equal(detectChordStack(doc2, 0, patternRegion(3, 0, 63, doc2.channelCount)), null);
});
