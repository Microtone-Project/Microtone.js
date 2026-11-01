// Invert loop — `S $F0xx`'s per-instrument mask (TAUD_ENGINE_SPEC.md §8.4).
//
// The mask is sized against the loop the voice is sounding, so two voices of
// one instrument on different Ixmp patches can disagree about its size. A STEP
// (tick time, voices in lane order in every port) starts a fresh mask for its
// own loop; a READ must not touch it. A read that discarded the mismatched
// mask made what a voice heard depend on the order the mixer visits voices in
// — span by span here, sample by sample in libtaudplay and TSVM — and an NNA
// ghost on another patch wiped the inversion out from under the lane writing
// it (item 262: taudplay-c fuzz seeds 106 and 129).

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";

function inst() {
  const eng = new TaudEngine();
  const rec = new Uint8Array(256);
  rec[4] = 0x00; rec[5] = 0x01;   // sample length 256
  rec[10] = 125; rec[12] = 231;   // loop 125…231: 106 bytes
  rec[14] = 1;
  eng.uploadInstrument(6, rec);
  return eng.instruments[6];
}

test("a read against another loop length sees no inversion and keeps the mask", () => {
  const i6 = inst();
  i6.toggleInvertBit(1, 106);
  const mask = i6.invertMask;
  assert.ok(i6.invertBit(1, 106));
  // A ghost on a 14-byte patch loop reads the same instrument.
  assert.equal(i6.invertBit(1, 14), false);
  assert.equal(i6.invertMask, mask, "the read must not discard the mask");
  assert.ok(i6.invertBit(1, 106), "the lane writing the mask still hears it");
});

test("reads are order-free: interleaving readers changes no answer", () => {
  const readers = [106, 14, 106, 1, 106];
  const answers = (order) => {
    const i6 = inst();
    for (const k of [1, 2, 5, 9]) i6.toggleInvertBit(k, 106);
    const out = new Map();
    for (const r of order) out.set(r, [0, 1, 2, 5, 9, 13].map((k) => i6.invertBit(k, readers[r])));
    return out;
  };
  const fwd = answers([0, 1, 2, 3, 4]);
  const rev = answers([4, 3, 2, 1, 0]);
  for (let r = 0; r < readers.length; r++) assert.deepEqual(fwd.get(r), rev.get(r));
  assert.deepEqual(fwd.get(0), [false, true, true, true, true, false]);
  assert.deepEqual(fwd.get(1), [false, false, false, false, false, false]);
});

test("a step against another loop length starts a fresh, cleared mask", () => {
  const i6 = inst();
  i6.toggleInvertBit(1, 106);
  i6.toggleInvertBit(3, 14);
  assert.equal(i6.invertMask.length, 2);
  assert.equal(i6.invertBit(1, 14), false);
  assert.ok(i6.invertBit(3, 14));
  assert.equal(i6.invertBit(1, 106), false, "the 106-byte mask is gone");
});
