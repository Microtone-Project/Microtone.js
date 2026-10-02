// Spatial core (#998.0): angle conventions, ITU sample placement, the Z
// slide's great-circle step, and the two render targets. The ambisonic encoder
// is checked against the DEFINITION of SN3D (Gauss-Legendre quadrature over the
// sphere), not against transcribed numbers — a typo in a harmonic would break
// orthonormality and nothing else would notice.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL,
  AZIMUTH_TURN, ELEVATION_QUARTER, SAMPLE_CHANNEL_LAYOUT,
  wrapAzimuth, foldAzimuthToPan, lateralProjection, directionFromAngles, anglesFromDirection,
  sampleChannelAngles, stepTowardTarget, encodeSN3D, acnChannelList,
  StereoRenderer, AmbisonicRenderer, SpatialBus,
} from "../../core/engine/spatial.js";

const vec = new Float64Array(3);
const ang = new Float64Array(2);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

// ── angles ────────────────────────────────────────────────────────────────

test("azimuth cardinal points: 0 left, 128 front, 256 right, 384 behind", () => {
  directionFromAngles(0, 0, vec);
  near(vec[0], 0); near(vec[1], 1); near(vec[2], 0);      // left
  directionFromAngles(128, 0, vec);
  near(vec[0], 1); near(vec[1], 0); near(vec[2], 0);      // front
  directionFromAngles(256, 0, vec);
  near(vec[0], 0); near(vec[1], -1); near(vec[2], 0);     // right
  directionFromAngles(384, 0, vec);
  near(vec[0], -1); near(vec[1], 0); near(vec[2], 0);     // behind
});

test("elevation +128 is straight up, −128 straight down", () => {
  directionFromAngles(128, 128, vec);
  near(vec[2], 1);
  directionFromAngles(128, -128, vec);
  near(vec[2], -1);
});

test("angles ↔ direction round-trip", () => {
  for (const az of [0, 37, 128, 255, 256, 300, 384, 511]) {
    for (const el of [-90, -30, 0, 45, 100]) {
      directionFromAngles(az, el, vec);
      anglesFromDirection(vec[0], vec[1], vec[2], ang);
      near(ang[0], az, 1e-9);
      near(ang[1], el, 1e-9);
    }
  }
});

test("wrapAzimuth folds into [0, 512)", () => {
  assert.equal(wrapAzimuth(0), 0);
  assert.equal(wrapAzimuth(512), 0);
  assert.equal(wrapAzimuth(600), 88);
  assert.equal(wrapAzimuth(-8), 504);
});

test("rear azimuths fold onto the front arc, front arc is the identity", () => {
  for (let a = 0; a <= 255; a++) assert.equal(foldAzimuthToPan(a), a);
  assert.equal(foldAzimuthToPan(256), 255);   // hard right (clamped off 256)
  assert.equal(foldAzimuthToPan(384), 128);   // behind → centre
  assert.equal(foldAzimuthToPan(511), 1);     // just left of behind-left
  assert.equal(foldAzimuthToPan(-1), 1);
});

// ── ITU sample placement (#998.0) ────────────────────────────────────────

test("a stereo sample sits ±30° around its source, on the horizon", () => {
  const layout = SAMPLE_CHANNEL_LAYOUT[2];
  near(layout[0], -30 * (AZIMUTH_TURN / 360));
  near(layout[1], 30 * (AZIMUTH_TURN / 360));
  // Source dead front: L 30° to the left of front, R 30° to the right.
  sampleChannelAngles(128, 0, layout[0], ang);
  near(ang[0], 128 - 42.666666666666664);
  near(ang[1], 0);
  sampleChannelAngles(128, 0, layout[1], ang);
  near(ang[0], 128 + 42.666666666666664);
});

test("the sample layout is rigid: it keeps its width when the source is elevated", () => {
  const layout = SAMPLE_CHANNEL_LAYOUT[2];
  const l = new Float64Array(3);
  const r = new Float64Array(3);
  for (const el of [0, 40, 90, 128]) {
    sampleChannelAngles(200, el, layout[0], ang);
    directionFromAngles(ang[0], ang[1], l);
    sampleChannelAngles(200, el, layout[1], ang);
    directionFromAngles(ang[0], ang[1], r);
    const dot = l[0] * r[0] + l[1] * r[1] + l[2] * r[2];
    near(Math.acos(dot) * 180 / Math.PI, 60, 1e-6); // 60° apart at every height
  }
});

// ── Z slide (#998.2) ─────────────────────────────────────────────────────

test("slide moves at constant angular velocity and stops on arrival", () => {
  // 8 units per tick, 64 units of travel → exactly 8 ticks.
  let az = 128, el = 0;
  for (let i = 0; i < 8; i++) {
    stepTowardTarget(az, el, 192, 0, 8, ang);
    az = ang[0]; el = ang[1];
    near(az, 128 + 8 * (i + 1), 1e-9);
  }
  stepTowardTarget(az, el, 192, 0, 8, ang);
  near(ang[0], 192);
  assert.equal(ang[1], 0);
});

test("slide takes the SHORT way round the circle", () => {
  // 500 → 20 is 32 units forward (clockwise), not 480 back.
  stepTowardTarget(500, 0, 20, 0, 8, ang);
  near(wrapAzimuth(ang[0]), 508);
});

test("identical directions do nothing", () => {
  stepTowardTarget(77, 12, 77, 12, 64, ang);
  near(ang[0], 77);
  near(ang[1], 12);
});

test("antipodal directions slide CLOCKWISE (front → right → behind)", () => {
  stepTowardTarget(128, 0, 384, 0, 16, ang);
  near(ang[0], 144);   // toward right, not toward left
  near(ang[1], 0, 1e-9);
});

test("an antipodal slide over the poles is deterministic, not NaN", () => {
  stepTowardTarget(128, 128, 0, -128, 16, ang);
  assert.ok(Number.isFinite(ang[0]) && Number.isFinite(ang[1]));
  near(ang[1], 112); // 16 units down from straight up
});

test("a diagonal slide interpolates elevation too", () => {
  // Quarter of the way from (front, horizon) to (front, up).
  stepTowardTarget(128, 0, 128, 128, 32, ang);
  near(ang[0], 128);
  near(ang[1], 32);
});

// ── ambisonic encoder ────────────────────────────────────────────────────

/** Gauss-Legendre nodes/weights on [-1, 1] via Newton on the Legendre polys. */
function gaussLegendre(n) {
  const x = new Float64Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let pp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = 0;
      for (let j = 0; j < n; j++) {
        const p2 = p1;
        p1 = p0;
        p0 = ((2 * j + 1) * z * p1 - j * p2) / (j + 1);
      }
      pp = (n * (z * p0 - p1)) / (z * z - 1);
      const dz = p0 / pp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = z;
    w[i] = 2 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
}

test("SN3D harmonics are orthogonal and normalised to 4π/(2l+1)", () => {
  const order = 3;
  const nch = (order + 1) * (order + 1);
  const { x: gx, w: gw } = gaussLegendre(24);
  const nAz = 64;
  const sh = new Float64Array(nch);
  const gram = new Float64Array(nch * nch);
  for (let i = 0; i < gx.length; i++) {
    const z = gx[i];
    const el = (Math.asin(z) / (Math.PI / 2)) * 128;
    for (let j = 0; j < nAz; j++) {
      const az = (j / nAz) * AZIMUTH_TURN;
      const wgt = gw[i] * ((2 * Math.PI) / nAz);
      encodeSN3D(az, el, order, sh);
      for (let a = 0; a < nch; a++) {
        for (let b = 0; b < nch; b++) gram[a * nch + b] += wgt * sh[a] * sh[b];
      }
    }
  }
  for (let a = 0; a < nch; a++) {
    const l = Math.floor(Math.sqrt(a));
    for (let b = 0; b < nch; b++) {
      const want = a === b ? (4 * Math.PI) / (2 * l + 1) : 0;
      near(gram[a * nch + b], want, 1e-9);
    }
  }
});

test("W is direction-independent and the order-1 channels are the direction itself", () => {
  const sh = new Float64Array(16);
  encodeSN3D(200, 40, 3, sh);
  directionFromAngles(200, 40, vec);
  near(sh[0], 1);
  near(sh[1], vec[1]); // ACN 1 = Y
  near(sh[2], vec[2]); // ACN 2 = Z
  near(sh[3], vec[0]); // ACN 3 = X
});

test("the planar basis keeps only the horizontal harmonics", () => {
  assert.deepEqual([...acnChannelList(3, true)], [0, 1, 3, 4, 8, 9, 15]);
  assert.equal(acnChannelList(3, false).length, 16);
  assert.equal(new AmbisonicRenderer(3, true).numChannels, 7);
  assert.equal(new AmbisonicRenderer(3, false).numChannels, 16);
});

// ── renderers ────────────────────────────────────────────────────────────

test("StereoRenderer reproduces the legacy equal-energy pan law on the front arc", () => {
  const r = new StereoRenderer();
  const g = new Float64Array(2);
  for (const pan of [0, 1, 64, 128, 200, 255]) {
    r.channelGains(pan, 0, g, 0);
    // Bit-for-bit the mixer's own expression — that is the compatibility claim.
    assert.equal(g[0], Math.cos((Math.PI * pan) / 512.0));
    assert.equal(g[1], Math.sin((Math.PI * pan) / 512.0));
  }
});

test("StereoRenderer: rear sources keep their side and their level", () => {
  const r = new StereoRenderer();
  const front = new Float64Array(2);
  const rear = new Float64Array(2);
  r.channelGains(64, 0, front, 0);    // half-left, in front
  r.channelGains(448, 0, rear, 0);    // half-left, behind
  near(front[0], rear[0]);
  near(front[1], rear[1]);
  // Energy is preserved all the way round.
  for (let a = 0; a < 512; a += 7) {
    r.channelGains(a, 0, front, 0);
    near(front[0] * front[0] + front[1] * front[1], 1, 1e-12);
  }
});

test("StereoRenderer: elevation collapses the image toward the centre", () => {
  const r = new StereoRenderer();
  const g = new Float64Array(2);
  r.channelGains(0, 128, g, 0);       // hard left, straight up
  near(g[0], Math.cos(Math.PI * 128 / 512));
  near(g[1], Math.sin(Math.PI * 128 / 512));
  r.channelGains(0, 64, g, 0);        // hard left, 45° up → part-way in
  assert.ok(g[1] > 0 && g[1] < Math.sin(Math.PI * 128 / 512));
});

test("AmbisonicRenderer monitor decode places left/right/front sanely", () => {
  const r = new AmbisonicRenderer(1, false);
  const bus = new SpatialBus(r, 4);
  const g = new Float64Array(r.numChannels * 2);
  const at = (az) => {
    bus.clear();
    r.channelGains(az, 0, g, 0);
    bus.addSource(0, 1.0, g, 0, 1.0);
    const p = bus.stereoAt(0);
    return [p[0], p[1]];
  };
  const [ll, lr] = at(0);      // hard left
  near(ll, 1); near(lr, 0);
  const [rl, rr] = at(256);    // hard right
  near(rl, 0); near(rr, 1);
  const [fl, fr] = at(128);    // front
  near(fl, 0.5); near(fr, 0.5);
});

test("SpatialBus accumulates per channel and clears", () => {
  const bus = new SpatialBus(new StereoRenderer(), 8);
  const g = Float64Array.from([0.25, 0.75]);
  bus.addSource(3, 2.0, g, 0, 1.0);
  bus.addSource(3, 2.0, g, 0, 0.5);
  near(bus.data[3], 0.25 * 2 + 0.25 * 1);
  near(bus.data[8 + 3], 0.75 * 2 + 0.75 * 1);
  bus.clear();
  assert.equal(bus.data[3], 0);
});

test("surround model constants match the file format's ss field", () => {
  assert.equal(SURROUND_STEREO, 0);
  assert.equal(SURROUND_PLANAR, 1);
  assert.equal(SURROUND_SPATIAL, 2);
});

// ── channel-header projection (#998.6) ───────────────────────────────────

test("the pan strip's projection is the radar dot's horizontal shadow", () => {
  // Cardinals, at ear level.
  near(lateralProjection(0, 0), -1);      // hard left
  near(lateralProjection(256, 0), 1);     // hard right
  near(lateralProjection(128, 0), 0);     // front → centre
  near(lateralProjection(384, 0), 0);     // behind → centre too (depth collapses)
  // The case the design is stated by: hard left, 60° up or down = half-left.
  const sixty = (60 / 90) * ELEVATION_QUARTER;
  near(lateralProjection(0, sixty), -0.5);
  near(lateralProjection(0, -sixty), -0.5);
  // Overhead is dead centre whatever the azimuth.
  for (const az of [0, 100, 256, 400]) near(lateralProjection(az, ELEVATION_QUARTER), 0, 1e-12);
  // Front-left 45° reads √½ of the way left.
  near(lateralProjection(64, 0), -Math.SQRT1_2);
  // Mirror symmetry about the front/back axis.
  for (let az = 0; az < 512; az += 7) {
    near(lateralProjection(az, 12), -lateralProjection(wrapAzimuth(256 - az), 12), 1e-12);
  }
});
