// Spatial panner (#998.6) — the pure half: pointer ↔ angle mapping, the labels,
// and the X / 4 argument codec the dials write through. The codec is the
// engine's own (effects.js decodes with the same pair), so a round-trip failure
// here means the dial and the playing note would disagree.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pointerAzimuth, azimuthOffset, pointerElevation, elevationOffset,
  pointerPan, panColumnValue,
} from "../../src/ui/popups/panner.js";
// The labels are shared with the Instruments view's default-position fields.
import { azimuthLabel, elevationLabel, panLabel } from "../../src/ui/units.js";
import {
  AZIMUTH_TURN, ELEVATION_QUARTER, wrapAzimuth,
  anglesFromSpatialArg, spatialArgFromAngles,
} from "../../src/engine/spatial.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const out = new Float64Array(2);

test("the top dial reads front UP and right RIGHT", () => {
  near(pointerAzimuth(0, -100), 128);   // up    → front
  near(pointerAzimuth(100, 0), 256);    // right → right
  near(pointerAzimuth(0, 100), 384);    // down  → behind
  near(pointerAzimuth(-100, 0), 0);     // left  → left
});

test("pointer ↔ offset round-trips all the way round", () => {
  for (let az = 0; az < AZIMUTH_TURN; az += 3) {
    azimuthOffset(az, out);
    near(Math.hypot(out[0], out[1]), 1);
    near(wrapAzimuth(pointerAzimuth(out[0] * 100, out[1] * 100)), az, 1e-9);
  }
});

test("the side dial maps up/down to ±90°, and mirrors the left half", () => {
  near(pointerElevation(100, 0), 0);
  near(pointerElevation(0, -100), ELEVATION_QUARTER - 1); // clamped below +128
  near(pointerElevation(0, 100), -ELEVATION_QUARTER);
  // A pointer on the left half means the same elevation, not the antipode.
  near(pointerElevation(-100, -100), pointerElevation(100, -100));
});

test("elevation offset is the unit vector for that angle", () => {
  elevationOffset(0, out);
  near(out[0], 1); near(out[1], 0);
  elevationOffset(ELEVATION_QUARTER, out);
  near(out[0], 0, 1e-12); near(out[1], -1);
  elevationOffset(-ELEVATION_QUARTER, out);
  near(out[0], 0, 1e-12); near(out[1], 1);
  elevationOffset(64, out);
  near(Math.hypot(out[0], out[1]), 1);
});

test("X / 4 argument codec round-trips every byte the dial can produce", () => {
  for (let a = 0; a < 256; a++) {
    for (const e of [-128, -64, -1, 0, 1, 63, 127]) {
      const arg = spatialArgFromAngles(a * 2, e);
      anglesFromSpatialArg(arg, out);
      assert.equal(out[0], a * 2);
      assert.equal(out[1], e);
    }
  }
});

test("the codec quantises to the command's byte and wraps at the top", () => {
  assert.equal(spatialArgFromAngles(0, 0), 0x0000);         // left
  assert.equal(spatialArgFromAngles(128, 0), 0x0040);       // front
  assert.equal(spatialArgFromAngles(256, 0), 0x0080);       // right
  assert.equal(spatialArgFromAngles(384, 0), 0x00c0);       // behind
  assert.equal(spatialArgFromAngles(511, 0), 0x0000);       // rounds onto left
  // The command carries half the engine's azimuth resolution, so odd units
  // round to the nearest byte rather than truncating toward the front.
  assert.equal(spatialArgFromAngles(129, 0), 0x0041);
  assert.equal(spatialArgFromAngles(127, 0), 0x0040);
  assert.equal(spatialArgFromAngles(130, 0), 0x0041);
  assert.equal(spatialArgFromAngles(128, 64), 0x4040);      // +45° up
  assert.equal(spatialArgFromAngles(128, -64), 0xc040);     // 45° down
  assert.equal(spatialArgFromAngles(128, -999), 0x8040);    // clamped to −128
  assert.equal(spatialArgFromAngles(128, 999), 0x7f40);     // clamped to +127
});

test("labels name the direction a musician would say", () => {
  assert.match(azimuthLabel(128), /^90\.0° front$/);
  assert.match(azimuthLabel(0), /left$/);
  assert.match(azimuthLabel(256), /right$/);
  assert.match(azimuthLabel(384), /behind$/);
  assert.match(azimuthLabel(320), /behind-right$/);
  assert.equal(elevationLabel(0), "+0.0°");
  assert.equal(elevationLabel(64), "+45.0°");
  assert.equal(elevationLabel(-128), "-90.0°");
});

// ── the stereo half-dial ──

test("the half-dial reads left / centre / right on the front arc", () => {
  near(pointerPan(-100, 0), 0);     // nine o'clock → hard left
  near(pointerPan(0, -100), 128);   // straight up  → centre
  near(pointerPan(100, 0), 255);    // three o'clock → hard right (the byte's top)
  near(pointerPan(-70.71, -70.71), 64, 1e-3); // 45° left of centre
});

test("below the baseline the half-dial pins to the nearer end", () => {
  near(pointerPan(-100, 60), 0);
  near(pointerPan(100, 60), 255);
  near(pointerPan(-1, 100), 0);
  near(pointerPan(1, 100), 255);
});

test("the half-dial draws its own pan byte where the pointer put it", () => {
  // The stereo pan byte is the azimuth on the front arc, so the top view's
  // offset is the half-dial's too — this is what makes the live dots line up.
  for (let p = 0; p < 256; p += 5) {
    azimuthOffset(p, out);
    assert.ok(out[1] <= 1e-12, `pan ${p} drawn below the baseline`);
    near(pointerPan(out[0] * 100, out[1] * 100), p, 1e-9);
  }
});

test("a v2 panning-column SET is the nearest six-bit value to the pan byte", () => {
  const widen = (v) => (v << 2) | (v >>> 4);
  assert.equal(panColumnValue(0), 0);
  assert.equal(panColumnValue(255), 63);
  // Every column value round-trips through the byte it widens to.
  for (let v = 0; v < 64; v++) assert.equal(panColumnValue(widen(v)), v);
  // And no byte lands further than half a column step from what it plays.
  for (let p = 0; p < 256; p++) assert.ok(Math.abs(widen(panColumnValue(p)) - p) <= 2, `pan ${p}`);
});

test("the stereo readout names the side and reaches 100% at both ends", () => {
  assert.match(panLabel(128), /centre/);
  assert.match(panLabel(0), /100% left/);
  assert.match(panLabel(255), /100% right/);
  assert.match(panLabel(64), /50% left/);
});
