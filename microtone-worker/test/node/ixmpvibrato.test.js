// Item 170 — an Ixmp patch that says nothing about auto-vibrato inherits the
// base record's whole block, not four zeroes.
//
// The wire has ONE sentinel for five fields (patch byte 30, `$FF` = no
// override), so a converter or an editor with no per-zone vibrato data leaves
// the waveform at $FF and the four numbers at 0. Reading those zeroes switched
// the instrument's own auto-vibrato off on every note a patch matched — which,
// for an instrument with a full keyboard map, is every note it can play.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { setSamplingRate } from "../../core/engine/constants.js";
import {
  makeInstPatch, writePatchesBlob, patchVibratoInherits,
} from "../../core/engine/inst.js";
import { applyActiveSample } from "../../core/engine/trigger.js";
import { Voice } from "../../core/engine/voice.js";

setSamplingRate(32000);

const NOTE_C4 = 0x5000;

/** One instrument with a real auto-vibrato, plus whatever patches are given. */
function makeInst(patches) {
  const eng = new TaudEngine();
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256);       // sampleLength
  w16(6, 32000);     // samplingRate @C4
  w16(12, 256);      // loopEnd
  rec[14] = 1;       // forward loop
  rec[171] = 255;    // instGlobalVolume
  rec[175] = 40;     // auto-vibrato speed
  rec[176] = 12;     // sweep
  rec[182] = 0xff;   // cutoff wide open
  rec[186] = 1 << 2; // instrument flag: vibrato waveform 1 (ramp down)
  rec[187] = 96;     // depth
  rec[188] = 7;      // rate
  rec[196] = 255;    // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  if (patches) eng.uploadInstrumentPatches(1, writePatchesBlob(patches));
  return eng.instruments[1];
}

/** Full-range patch over the base sample, with `fields` layered on top. */
function zone(fields) {
  return makeInstPatch({
    pitchStart: 0x0020, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
    samplePtr: 0, sampleLength: 256, loopEnd: 256, samplingRate: 32000, loopMode: 1,
    ...fields,
  });
}

/** What applyActiveSample puts on a voice for this instrument's C4. */
function activeVibrato(inst) {
  const v = new Voice();
  applyActiveSample(v, inst, inst.resolvePatch(NOTE_C4, 0x3f));
  return {
    speed: v.activeVibratoSpeed, sweep: v.activeVibratoSweep,
    depth: v.activeVibratoDepth, rate: v.activeVibratoRate,
    wave: v.activeVibratoWaveform,
  };
}

const BASE = { speed: 40, sweep: 12, depth: 96, rate: 7, wave: 1 };

test("no patch at all: the base record's auto-vibrato sounds", () => {
  assert.deepEqual(activeVibrato(makeInst(null)), BASE);
});

test("a patch with the $FF sentinel and four zeroes inherits the whole block", () => {
  const inst = makeInst([zone({})]);
  assert.equal(inst.resolvePatch(NOTE_C4, 0x3f) !== null, true, "premise: the patch wins C4");
  assert.deepEqual(activeVibrato(inst), BASE);
});

test("a patch stating ANY number keeps its own vibrato, borrowing only the waveform", () => {
  const inst = makeInst([zone({ vibratoDepth: 8 })]);
  assert.deepEqual(activeVibrato(inst), {
    speed: 0, sweep: 0, depth: 8, rate: 0, wave: 1,
  });
});

test("a patch naming a waveform overrides the block outright, zeroes included", () => {
  // $FF is the only inherit signal there is, so a patch that names a waveform
  // is stating its vibrato in full — including "no depth".
  const inst = makeInst([zone({ vibratoWaveform: 2 })]);
  assert.deepEqual(activeVibrato(inst), {
    speed: 0, sweep: 0, depth: 0, rate: 0, wave: 2,
  });
});

test("patchVibratoInherits is the exact test the engine and the editor share", () => {
  assert.equal(patchVibratoInherits(zone({})), true);
  assert.equal(patchVibratoInherits(zone({ vibratoWaveform: 0 })), false);
  for (const f of ["vibratoSpeed", "vibratoSweep", "vibratoDepth", "vibratoRate"]) {
    assert.equal(patchVibratoInherits(zone({ [f]: 1 })), false, f);
  }
});

test("the inherit block survives a blob round trip", () => {
  // The sentinel has to reach the ENGINE through the wire format, not just the
  // in-memory patch object the editor holds.
  const inst = makeInst([zone({}), zone({ pitchStart: 0x6000, vibratoDepth: 3 })]);
  assert.equal(patchVibratoInherits(inst.extraPatches[0]), true);
  assert.equal(patchVibratoInherits(inst.extraPatches[1]), false);
  assert.deepEqual(activeVibrato(inst), BASE);
});
