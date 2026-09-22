// The Timeline lane header's lane-axis readout (item 198.3).
//
// The header reads a lane's volume and position back as the CELL that would
// put it where it already is, so the one property worth pinning is that
// retyping what it shows is a no-op — and that the command it names is the one
// the song's surround model actually obeys.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  laneVolumeCell, lanePanCell, laneVolumeAtRest, lanePanAtRest,
} from "../../src/ui/lanestate.js";
import { EffectOp } from "../../src/engine/tables.js";
import {
  SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL,
} from "../../src/engine/spatial.js";
import { VOLUME_MAX, VOLUME_MAX_WIDE } from "../../src/engine/constants.js";

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

test("at-rest is full volume and dead centre, whatever the cell format", () => {
  assert.equal(laneVolumeAtRest(VOLUME_MAX, VOLUME_MAX), true);
  assert.equal(laneVolumeAtRest(VOLUME_MAX_WIDE, VOLUME_MAX_WIDE), true);
  assert.equal(laneVolumeAtRest(VOLUME_MAX, VOLUME_MAX_WIDE), false, "$3F is not full in a v3 song");
  assert.equal(laneVolumeAtRest(0, VOLUME_MAX), false);

  assert.equal(lanePanAtRest(128, 0), true, "pan byte $80 ≡ azimuth 128, front");
  assert.equal(lanePanAtRest(127, 0), false);
  assert.equal(lanePanAtRest(128, 12), false, "…and being off the horizon counts");
});
