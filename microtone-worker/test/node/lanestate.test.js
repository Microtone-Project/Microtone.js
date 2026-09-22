// The Timeline lane header's lane-axis readout (item 198.3).
//
// The header reads a lane's volume and position back as the CELL that would
// put it where it already is, so the one property worth pinning is that
// retyping what it shows is a no-op — and that the command it names is the one
// the song's surround model actually obeys.

import { test } from "node:test";
import assert from "node:assert/strict";

import { laneVolumeCell, lanePanCell } from "../../src/ui/lanestate.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { applyEffectRow } from "../../src/engine/effects.js";
import { EffectOp } from "../../src/engine/tables.js";
import {
  SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL,
} from "../../src/engine/spatial.js";

test("lane volume reads back as M $xx00 — the byte in the high half, nothing in the low", () => {
  assert.deepEqual(laneVolumeCell(0x3f), { effect: EffectOp.OP_M, arg: 0x3f00 });
  assert.deepEqual(laneVolumeCell(0), { effect: EffectOp.OP_M, arg: 0x0000 });
  assert.deepEqual(laneVolumeCell(0xff), { effect: EffectOp.OP_M, arg: 0xff00 });
});

test("a stereo song reads its lane pan as S $80xx", () => {
  const { effect, arg } = lanePanCell(SURROUND_STEREO, 0x80, 0);
  assert.equal(effect, EffectOp.OP_S);
  assert.equal(arg, 0x8080, "the 8 is S's sub-command, the byte is the pan");
  assert.equal(lanePanCell(SURROUND_STEREO, 0, 0).arg, 0x8000);
  assert.equal(lanePanCell(SURROUND_STEREO, 255, 0).arg, 0x80ff);
});

test("a planar song reads the whole 9-bit azimuth, which S $8aaa has room for", () => {
  assert.equal(lanePanCell(SURROUND_PLANAR, 384, 0).arg, 0x8180, "behind the listener");
  assert.equal(lanePanCell(SURROUND_PLANAR, 511, 0).arg, 0x81ff);
  // The elevation is not S's to carry, and a planar song has none anyway.
  assert.equal(lanePanCell(SURROUND_PLANAR, 128, 40).arg, 0x8080);
});

test("a spatial song reads X $eeaa instead — the one command that states both halves", () => {
  const { effect, arg } = lanePanCell(SURROUND_SPATIAL, 128, 0);
  assert.equal(effect, EffectOp.OP_X, "S would silently drop the height");
  assert.equal(arg, 0x0040, "azimuth 128 of 512 is X's $40 of $FF — front");
  // Elevation is signed: −90° is $80, and a shade below ear level wraps high.
  assert.equal(lanePanCell(SURROUND_SPATIAL, 0, -128).arg, 0x8000);
  assert.equal(lanePanCell(SURROUND_SPATIAL, 256, 127).arg, 0x7f80);
  assert.equal(lanePanCell(SURROUND_SPATIAL, 128, -1).arg, 0xff40);
});

test("X's 8-bit azimuth rounds to the nearest angle it can express", () => {
  // The register is 9-bit, X's field 8 — a readout rounds, it does not promise
  // to round-trip. Both neighbours of an odd angle must be reachable.
  assert.equal(lanePanCell(SURROUND_SPATIAL, 100, 0).arg & 0xff, 50);
  assert.equal(lanePanCell(SURROUND_SPATIAL, 101, 0).arg & 0xff, 51);
  assert.equal(lanePanCell(SURROUND_SPATIAL, 510, 0).arg & 0xff, 255);
});

// ── stated vs. merely default ──
//
// The header greys an axis the song has never MENTIONED. That cannot be
// decided by comparing against the reset value, because `M $3F00` and
// `S $8080` write exactly those values — so the engine tracks the difference
// and these are the cases that keep it honest.

/** A playhead with one pattern's worth of room, ready to be driven a row at
 *  a time. Anything not stated here is whatever a fresh engine leaves. */
function engineWithRow(cell, { wide = false, surroundModel = 0 } = {}) {
  const eng = new TaudEngine();
  eng.setCellFormat(wide);
  eng.setSurroundModel(0, surroundModel);
  const ts = eng.playheads[0].trackerState;
  const voice = ts.voices[0];
  applyEffectRow(eng, ts, 0, voice, 0, cell.effect, cell.effectArg, cell.ext ?? null);
  return voice;
}

test("an axis nobody has written reads as unstated", () => {
  const eng = new TaudEngine();
  assert.equal(eng.getVoiceChannelVolumeSet(0, 0), false);
  assert.equal(eng.getVoiceChannelPanSet(0, 0), false);
});

test("M and N state the volume axis — including M at the value a reset leaves", () => {
  // The whole point: `M $3F00` sets full volume, which is ALSO the reset
  // value, and it is still the song saying so.
  assert.equal(engineWithRow({ effect: EffectOp.OP_M, effectArg: 0x3f00 }).channelVolumeSet, true);
  assert.equal(engineWithRow({ effect: EffectOp.OP_M, effectArg: 0x0000 }).channelVolumeSet, true);
  assert.equal(engineWithRow({ effect: EffectOp.OP_N, effectArg: 0x0400 }).channelVolumeSet, true);
  // …and a command about some OTHER axis does not.
  assert.equal(engineWithRow({ effect: EffectOp.OP_S, effectArg: 0x8080 }).channelVolumeSet, false);
});

test("S $80xx, P and X state the position axis — S $8080 included", () => {
  const centre = engineWithRow({ effect: EffectOp.OP_S, effectArg: 0x8080 });
  assert.equal(centre.channelPan, 0x80, "…still dead centre");
  assert.equal(centre.channelPanSet, true, "…and still a statement");
  // P's continuous form arms a PER-TICK slide and writes nothing at row time,
  // so the funnel alone would have missed it until tick 1 — as would Z, whose
  // movement is entirely per-tick. Both are marked at the command instead.
  assert.equal(engineWithRow({ effect: EffectOp.OP_P, effectArg: 0x0400 }).channelPanSet, true);
  assert.equal(
    engineWithRow({ effect: EffectOp.OP_Z, effectArg: 0x0040 }, { surroundModel: SURROUND_SPATIAL })
      .channelPanSet, true);
  // Z's OTHER form is funk repeat, which is not a position at all.
  assert.equal(engineWithRow({ effect: EffectOp.OP_Z, effectArg: 0xf010 }).channelPanSet, false);
  assert.equal(
    engineWithRow({ effect: EffectOp.OP_X, effectArg: 0x0040 }, { surroundModel: SURROUND_SPATIAL })
      .channelPanSet, true);
  assert.equal(engineWithRow({ effect: EffectOp.OP_M, effectArg: 0x3f00 }).channelPanSet, false);
});

test("a stereo song ignores X, so X states nothing there", () => {
  // The engine must not be rewarded for a converter that left an IT `Xxx` in
  // place — it changes no position, so it has stated no position.
  const v = engineWithRow({ effect: EffectOp.OP_X, effectArg: 0x0040 }, { surroundModel: SURROUND_STEREO });
  assert.equal(v.channelPanSet, false);
});

test("effect 4 aims a slide without placing the lane, so it states nothing", () => {
  const v = engineWithRow({ effect: EffectOp.OP_4, effectArg: 0x0080 }, { surroundModel: SURROUND_SPATIAL });
  assert.equal(v.channelPanSet, false, "the TARGET moved, the lane did not");
});

test("a reset puts both axes back to unstated", () => {
  const eng = new TaudEngine();
  const ts = eng.playheads[0].trackerState;
  applyEffectRow(eng, ts, 0, ts.voices[0], 0, EffectOp.OP_M, 0x2000, null);
  applyEffectRow(eng, ts, 0, ts.voices[0], 0, EffectOp.OP_S, 0x8040, null);
  assert.equal(eng.getVoiceChannelVolumeSet(0, 0), true);
  assert.equal(eng.getVoiceChannelPanSet(0, 0), true);
  eng.resetParams(0);
  assert.equal(eng.getVoiceChannelVolumeSet(0, 0), false, "a cue start is a clean slate");
  assert.equal(eng.getVoiceChannelPanSet(0, 0), false);
});
