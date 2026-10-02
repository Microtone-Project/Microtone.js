// Height cue for the spatial dials (#998.6). A dial seen from above cannot
// distinguish up from down on its own — these numbers are what does, so they
// are pinned: monotone in elevation, symmetric about ear level, and anchored
// at the floor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { spatialDotCue, LIGHT_ELEVATION_DEG } from "../../src/ui/spatialdot.js";
import { ELEVATION_QUARTER } from "../../core/engine/spatial.js";

const DIAL = 80, DOT = 5;
const cue = (el) => spatialDotCue(el, DIAL, DOT);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test("a source on the floor sits ON its shadow, sharp; overhead it is furthest and softest", () => {
  const floor = cue(-ELEVATION_QUARTER);
  const ear = cue(0);
  const sky = cue(ELEVATION_QUARTER);

  near(floor.height, 0);
  near(floor.offset, 0);           // shadow exactly beneath the dot
  near(ear.height, 1);
  near(sky.height, 2);

  assert.ok(floor.blur < ear.blur && ear.blur < sky.blur, "shadow softens with height");
  assert.ok(floor.alpha > ear.alpha && ear.alpha > sky.alpha, "…and fades with it");
  assert.ok(floor.offset < ear.offset && ear.offset < sky.offset, "…and slides away from the light");
});

test("the dot grows above ear level and shrinks below it", () => {
  assert.ok(cue(ELEVATION_QUARTER).radius > cue(0).radius);
  assert.ok(cue(0).radius > cue(-ELEVATION_QUARTER).radius);
  near(cue(0).radius, DOT); // ear level is the nominal size
  // Symmetric: as much bigger above as smaller below.
  const up = cue(ELEVATION_QUARTER).radius - DOT;
  const down = DOT - cue(-ELEVATION_QUARTER).radius;
  near(up, down, 1e-12);
});

test("the shadow geometry is the stated light: height / tan(elevation)", () => {
  // Ear level is half the sphere's height, so its offset is (dialR/2)/tan(light).
  // The light angle itself is a tunable, eyeballed in the gallery — the test
  // pins the RELATION to it, not the value, so a visual tweak is not a failure.
  const want = (DIAL * 0.5) / Math.tan((LIGHT_ELEVATION_DEG * Math.PI) / 180);
  near(cue(0).offset, want);
  near(cue(ELEVATION_QUARTER).offset, 2 * want);
  assert.ok(LIGHT_ELEVATION_DEG > 45 && LIGHT_ELEVATION_DEG < 90, "a key light, not a sunset");
});

test("everything varies monotonically with elevation", () => {
  let prev = cue(-ELEVATION_QUARTER);
  for (let el = -ELEVATION_QUARTER + 4; el <= ELEVATION_QUARTER; el += 4) {
    const c = cue(el);
    assert.ok(c.radius > prev.radius, `radius at ${el}`);
    assert.ok(c.offset > prev.offset, `offset at ${el}`);
    assert.ok(c.blur > prev.blur, `blur at ${el}`);
    assert.ok(c.alpha < prev.alpha, `alpha at ${el}`);
    prev = c;
  }
});

test("the shadow stays visible at every height", () => {
  for (const el of [-128, -64, 0, 64, 127]) {
    const c = cue(el);
    assert.ok(c.alpha > 0.15 && c.alpha <= 0.4, `alpha ${c.alpha} at ${el}`);
    assert.ok(c.core > 0 && c.blur > 0);
  }
});

test("the cue scales with the dial it is drawn on", () => {
  const small = spatialDotCue(64, 20, 3);
  const big = spatialDotCue(64, 80, 3);
  near(big.offset / small.offset, 4);           // offset is dial-relative…
  near(big.blur, small.blur);                   // …blur and size are dot-relative
  near(big.radius, small.radius);
});

test("tiny dots still get a readable shadow (the header radars)", () => {
  const tiny = spatialDotCue(0, 17, 2);
  const small = spatialDotCue(0, 17, 4);
  near(tiny.core, small.core);   // floored, so a 2 px dot is not a smudge
  near(tiny.blur, small.blur);
  assert.ok(tiny.core + tiny.blur > tiny.radius,
    "the shadow still spreads wider than the dot it belongs to");
});

test("the shadow stays a shadow, not a halo — it never dwarfs its dot", () => {
  for (const el of [-128, -64, 0, 64, 127]) {
    const c = spatialDotCue(el, 80, 7);
    assert.ok(c.core + c.blur < 2.4 * c.radius,
      `outer ${(c.core + c.blur).toFixed(1)} vs dot ${c.radius.toFixed(1)} at ${el}`);
  }
});
