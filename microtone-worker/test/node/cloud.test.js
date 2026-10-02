// Soundfield cloud (item 133) — the estimator, not the paint.
//
// The radial axis is a PERCEPTUAL claim: a pair at ±θ images at cos θ, so a
// single source is on the rim and a pair equidistant either side of you is at
// the centre, which is where such a pair is actually heard. That is testable,
// because |Ia| / P comes out as cos θ exactly — nothing here is fitted.
//
// And a pair in ANTI-phase has no phantom centre at all: you hear two separate
// sources. The pressure cancels while the air still moves, and the display has
// to say so rather than dropping it in the middle beside the in-phase case.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOPE_FRAMES, SCOPE_CHANNELS, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
} from "../../core/engine/analysis.js";
import { encodeSN3D, anglesFromDirection } from "../../core/engine/spatial.js";
import { RAD_BANDS, RAD_NBANDS } from "../../src/ui/radiation.js";
import {
  CloudField, CloudView, CLOUD_FILL, CLOUD_HOP, CLOUD_SIG_MIN, CLOUD_SIG_MAX,
  CLOUD_ALPHA_MIN,
  cloudRadius, cloudPairRadius, cloudHalfAngle, cloudSigma, cloudLevelAlpha,
  cloudDecay, cloudAlpha, cloudDepthDim, cloudDepthBlur,
} from "../../src/ui/cloud.js";

const RATE = 48000;
const deg = (rad) => (rad * 180) / Math.PI;
const bearing = (d, e = 0) => {
  const a = (d * Math.PI) / 180, el = (e * Math.PI) / 180, ce = Math.cos(el);
  return [ce * Math.cos(a), ce * Math.sin(a), Math.sin(el)];
};
const FRONT = bearing(0), LEFT = bearing(90), RIGHT = bearing(-90);

/** Azimuth/elevation in the engine's units, from a bearing in degrees. */
const AZ = (d) => 128 - (d * 512) / 360;
const EL = (e) => (e * 128) / 90;

/**
 * A ring carrying `sources` encoded to the tap's own order — the real
 * encoder, so the order-2 harmonics the cloud reads are the ones the engine
 * would actually have produced.
 */
function ringOf(sources) {
  const ring = new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS);
  const sh = new Float64Array(16);
  for (const { at, hz, amp = 1, phase = 0 } of sources) {
    encodeSN3D(AZ(at[0]), EL(at[1] ?? 0), 2, sh);
    for (let i = 0; i < SCOPE_FRAMES; i++) {
      const v = amp * Math.sin((2 * Math.PI * hz * i) / RATE + phase);
      const o = i * SCOPE_CHANNELS;
      for (let c = 0; c < SCOPE_CHANNELS; c++) ring[o + c] += v * sh[c];
    }
  }
  return ring;
}

const S_STRIDE = 7, S_DX = 0, S_DY = 1, S_DZ = 2, S_R = 3, S_SIG = 4, S_A = 5;

/** The splats, heaviest first, as plain objects. */
function splatsOf(f) {
  const out = [];
  for (let i = 0; i < f.count; i++) {
    const o = i * S_STRIDE;
    out.push({
      d: [f.splats[o + S_DX], f.splats[o + S_DY], f.splats[o + S_DZ]],
      r: f.splats[o + S_R], sig: f.splats[o + S_SIG], alpha: f.splats[o + S_A],
    });
  }
  return out;
}

// ── the radial axis ───────────────────────────────────────────────────────

test("the radius is cos of the half-angle, and reads back", () => {
  // The spec: a pair at ±θ images at cos θ. ±60° is 0.5 because cos 60° is.
  assert.equal(cloudPairRadius(0), 1);
  assert.ok(Math.abs(cloudPairRadius(Math.PI / 3) - 0.5) < 1e-12, "±60° is half way");
  assert.ok(Math.abs(cloudPairRadius(Math.PI / 2)) < 1e-12, "±90° is the centre");
  for (let d = 0; d <= 90; d += 5) {
    const half = (d * Math.PI) / 180;
    assert.ok(Math.abs(cloudHalfAngle(cloudPairRadius(half)) - half) < 1e-9, `${d}°`);
  }
  // …and the analyser's own radius is |Ia| / P, which is that same cosine.
  assert.equal(cloudRadius(0, 0), 0);
  assert.equal(cloudRadius(5, 1), 1, "more velocity than pressure clamps at the rim");
  assert.ok(Math.abs(cloudRadius(0.5, 1) - 0.5) < 1e-12);
});

test("an in-phase pair images at cos θ, measured end to end", () => {
  for (const t of [0, 15, 30, 45, 60, 75, 90]) {
    const f = new CloudField();
    const src = t === 0
      ? [{ at: [0], hz: 700, amp: 2 }]
      : [{ at: [t], hz: 700 }, { at: [-t], hz: 700 }];
    f.analyse(ringOf(src), 0, RATE, 0);
    const s = splatsOf(f);
    assert.ok(s.length > 0, `±${t}° produced nothing`);
    const want = cloudPairRadius((t * Math.PI) / 180);
    for (const sp of s) {
      assert.ok(Math.abs(sp.r - want) < 0.02, `±${t}°: r ${sp.r.toFixed(3)} want ${want.toFixed(3)}`);
    }
  }
});

test("splat size is the level in decibels", () => {
  assert.ok(Math.abs(cloudSigma(0) - CLOUD_SIG_MAX) < 1e-12, "the loudest tile is the biggest");
  assert.ok(cloudSigma(-6) < cloudSigma(0));
  assert.ok(cloudSigma(-24) < cloudSigma(-6));
  assert.equal(cloudSigma(-999), CLOUD_SIG_MIN, "and it floors rather than vanishing");
  // Equal decibel steps are equal size steps — that is the point of using dB.
  const a = cloudSigma(-10) - cloudSigma(-20);
  const b = cloudSigma(-20) - cloudSigma(-30);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
});

test("the accumulator's curves", () => {
  assert.equal(cloudDecay(0), 1);
  assert.ok(cloudDecay(230) < 0.4 && cloudDecay(230) > 0.3, "one tau is ~1/e");
  // Frame-rate independence: one long step equals many short ones.
  let k = 1;
  for (let i = 0; i < 10; i++) k *= cloudDecay(10);
  assert.ok(Math.abs(k - cloudDecay(100)) < 1e-9);
  assert.equal(cloudAlpha(0), 0);
  assert.ok(cloudAlpha(1) > cloudAlpha(0.1), "denser is more opaque");
  assert.ok(cloudAlpha(1e6) <= 1);
});

// ── the analysis ──────────────────────────────────────────────────────────

test("a single source lands at the rim, in its own direction", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ at: [35, 20], hz: 700 }]), 0, RATE, 0);
  const s = splatsOf(f);
  assert.ok(s.length > 0, "something was found");
  const want = bearing(35, 20);
  for (const sp of s) {
    assert.ok(sp.r > CLOUD_FILL * 0.9, `radius ${sp.r} should be at the rim`);
    const dot = sp.d[0] * want[0] + sp.d[1] * want[1] + sp.d[2] * want[2];
    assert.ok(dot > 0.999, `direction off by ${deg(Math.acos(dot)).toFixed(2)}°`);
  }
});

test("an in-phase pair either side of you is in-head; an ANTI-phase one is not", () => {
  // In phase: the classic phantom centre, heard inside the head.
  const inp = new CloudField();
  inp.analyse(ringOf([{ at: [90], hz: 700 }, { at: [-90], hz: 700 }]), 0, RATE, 0);
  for (const sp of splatsOf(inp)) assert.ok(sp.r < 0.05, `radius ${sp.r} should be in-head`);

  // Invert one and there is no phantom centre at all — you hear two separate
  // sources. Order 2 puts them back where they ACTUALLY are: the order-2
  // quadrupole carries the bearing the pair straddles, which order 1 alone
  // cannot (at first order a pair at ±15° and one at ±90° are the same four
  // numbers, so a first-order display has to fling both to the edges).
  for (const [phi, th] of [[0, 15], [0, 30], [0, 60], [40, 25], [-70, 45], [110, 20]]) {
    const f = new CloudField();
    f.analyse(ringOf([
      { at: [phi + th], hz: 700 },
      { at: [phi - th], hz: 700, phase: Math.PI },
    ]), 0, RATE, 0);
    const s = splatsOf(f);
    assert.ok(s.length > 0, `${phi}°±${th}° produced nothing`);
    for (const sp of s) assert.ok(sp.r > 0.95, `${phi}°±${th}°: r ${sp.r} should be at the rim`);
    // Every splat lands on one of the two true bearings, and both are used.
    const want = [phi + th, phi - th].map((b) => bearing(b));
    let hitA = 0, hitB = 0;
    for (const sp of s) {
      const dot = (w) => sp.d[0] * w[0] + sp.d[1] * w[1] + sp.d[2] * w[2];
      const a = dot(want[0]), b = dot(want[1]);
      assert.ok(Math.max(a, b) > 0.999,
        `${phi}°±${th}°: splat off both bearings by ${deg(Math.acos(Math.max(a, b))).toFixed(1)}°`);
      if (a > b) hitA++; else hitB++;
    }
    assert.ok(hitA > 0 && hitB > 0, `${phi}°±${th}°: only one bearing used (${hitA}/${hitB})`);
    assert.equal(hitA, hitB, `${phi}°±${th}°: the pair should be balanced`);
  }
});

test("uncorrelated sources separate — the reading the surface cannot give", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ at: [90], hz: 700 }, { at: [-90], hz: 1600 }]), 0, RATE, 0);
  const s = splatsOf(f);
  const left = s.filter((x) => x.d[1] > 0.9 && x.r > CLOUD_FILL * 0.9);
  const right = s.filter((x) => x.d[1] < -0.9 && x.r > CLOUD_FILL * 0.9);
  assert.ok(left.length > 0, "the left source is at the rim on the left");
  assert.ok(right.length > 0, "the right source is at the rim on the right");
});

test("silence produces no splats at all", () => {
  const f = new CloudField();
  f.analyse(new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS), 0, RATE, 0);
  assert.equal(f.count, 0);
});

test("the analysis is paced by the audio, not the frame rate", () => {
  const f = new CloudField();
  const ring = ringOf([{ at: [0], hz: 700 }]);
  assert.equal(f.analyse(ring, 0, RATE, 0), true, "the first window always runs");
  assert.equal(f.analyse(ring, 0, RATE, 8), false, "8 frames is not a hop");
  assert.equal(f.analyse(ring, 0, RATE, CLOUD_HOP), true, "a hop's worth is");
  f.reset();
  assert.equal(f.count, 0);
  assert.equal(f.ready, false);
});

// ── size and opacity are one reading ────────────────────────────────────────

test("opacity follows the level, on the same decibels as the size", () => {
  assert.equal(cloudLevelAlpha(0), 1, "the loudest bin is fully opaque");
  assert.ok(cloudLevelAlpha(-6) < 1 && cloudLevelAlpha(-6) > cloudLevelAlpha(-24));
  assert.equal(cloudLevelAlpha(-999), CLOUD_ALPHA_MIN, "the quiet end thins, not vanishes");
  // Size and opacity move together — never one up and the other down.
  let prevA = Infinity, prevS = Infinity;
  for (let db = 0; db >= -50; db -= 5) {
    const a = cloudLevelAlpha(db), sg = cloudSigma(db);
    assert.ok(a <= prevA + 1e-12 && sg <= prevS + 1e-12, `${db} dB went the wrong way`);
    prevA = a; prevS = sg;
  }
});

test("a loud bin is bigger AND more opaque than a quiet one", () => {
  const f = new CloudField();
  f.analyse(ringOf([
    { at: [60], hz: 700, amp: 1 },
    { at: [-60], hz: 1600, amp: 0.05 },
  ]), 0, RATE, 0);
  const s = splatsOf(f);
  const loud = s.filter((x) => x.d[1] > 0.5);
  const quiet = s.filter((x) => x.d[1] < -0.5);
  assert.ok(loud.length && quiet.length, "both sources produced splats");
  const big = Math.max(...loud.map((x) => x.sig));
  const small = Math.max(...quiet.map((x) => x.sig));
  assert.ok(big > small, `sizes ${big} vs ${small}`);
  assert.ok(Math.max(...loud.map((x) => x.alpha)) > Math.max(...quiet.map((x) => x.alpha)));
});

test("the auto-gain slews rather than re-referencing every window", () => {
  const f = new CloudField();
  const loud = ringOf([{ at: [0], hz: 700, amp: 1 }]);
  const quiet = ringOf([{ at: [0], hz: 700, amp: 0.1 }]);   // 20 dB down
  for (let i = 0; i < 200; i++) f.analyse(loud, 0, RATE, CLOUD_HOP);
  const settled = f.ref;
  assert.ok(settled > 0, "the reference settled on the loud material");

  // One window of the quiet take must NOT drag the reference down with it —
  // that instant re-reference is what made the whole display flicker.
  f.analyse(quiet, 0, RATE, CLOUD_HOP);
  assert.ok(f.ref > settled * 0.9, `one window moved the gain to ${f.ref / settled}`);
  for (let i = 0; i < 60; i++) f.analyse(quiet, 0, RATE, CLOUD_HOP);
  assert.ok(f.ref < settled, "…but it does follow, given time");
  assert.ok(f.ref > settled * 0.5, "…slowly (a 20 dB drop is not a 20 dB jump)");

  // Rising is quicker than falling: a transient must not blow the display out.
  const a = new CloudField();
  for (let i = 0; i < 40; i++) a.analyse(quiet, 0, RATE, CLOUD_HOP);
  const low = a.ref;
  for (let i = 0; i < 20; i++) a.analyse(loud, 0, RATE, CLOUD_HOP);
  const up = a.ref / low;
  const b = new CloudField();
  for (let i = 0; i < 40; i++) b.analyse(loud, 0, RATE, CLOUD_HOP);
  const high = b.ref;
  for (let i = 0; i < 20; i++) b.analyse(quiet, 0, RATE, CLOUD_HOP);
  assert.ok(up > high / b.ref, "attack should outrun release");
});

test("depth: what points away from the camera recedes", () => {
  assert.ok(Math.abs(cloudDepthDim(1) - 1) < 1e-12, "toward you is undimmed");
  assert.ok(cloudDepthDim(-1) < cloudDepthDim(0) && cloudDepthDim(0) < cloudDepthDim(1));
  assert.ok(cloudDepthBlur(-1) > cloudDepthBlur(1), "…and softer");
  assert.ok(Math.abs(cloudDepthBlur(1) - 1) < 1e-12, "toward you is in focus");

  // The same source, seen by a camera facing it and by one behind it.
  const f = new CloudField();
  f.analyse(ringOf([{ at: [0], hz: 700 }]), 0, RATE, 0);
  const bandLin = RAD_BANDS.map(() => [1, 1, 1]);
  const lay = (dz) => {
    const v = new CloudView(64);
    v.splat(f, { h: [0, -1, 0], v: [0, 0, 1], d: [dz, 0, 0] }, bandLin, 1);
    return v.totalEnergy();
  };
  const near = lay(1), far = lay(-1);
  assert.ok(near > far * 1.5, `near ${near.toFixed(2)} vs far ${far.toFixed(2)}`);
});

// ── the accumulator ───────────────────────────────────────────────────────

test("the cloud accumulates and then dies away", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ at: [30, 10], hz: 700 }]), 0, RATE, 0);
  const view = new CloudView(64);
  const bandLin = RAD_BANDS.map(() => [1, 1, 1]);
  const basis = { h: [0, -1, 0], v: [1, 0, 0], d: [0, 0, 1] };
  assert.equal(view.totalEnergy(), 0);
  view.splat(f, basis, bandLin, 1);
  const one = view.totalEnergy();
  assert.ok(one > 0, "one window lays something down");
  view.splat(f, basis, bandLin, 1);
  assert.ok(view.totalEnergy() > one * 1.9, "…and a second adds to it rather than replacing it");
  // Stop feeding it and it fades, frame-rate independently.
  const lit = view.totalEnergy();
  for (let i = 0; i < 40; i++) view.decay(25); // ~1 s
  assert.ok(view.totalEnergy() < lit * 0.02, `fell from ${lit} to ${view.totalEnergy()}`);
  view.clear();
  assert.equal(view.totalEnergy(), 0);
});

test("develop paints where the cloud is and nowhere else", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ at: [90], hz: 700 }]), 0, RATE, 0); // hard left
  const size = 64;
  const view = new CloudView(size);
  view.splat(f, { h: [0, -1, 0], v: [1, 0, 0], d: [0, 0, 1] },
    RAD_BANDS.map(() => [1, 1, 1]), 1);
  const px = new Uint8ClampedArray(size * size * 4);
  view.develop(px, [255, 255, 255]);
  let sx = 0, n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (px[(y * size + x) * 4 + 3] === 0) continue;
      sx += (x + 0.5) / size * 2 - 1;
      n++;
    }
  }
  assert.ok(n > 0, "something was painted");
  assert.ok(sx / n < -0.5, `a hard-left source paints on the left (centroid ${(sx / n).toFixed(2)})`);
});

test("every band is drawable", () => {
  assert.equal(RAD_BANDS.length, RAD_NBANDS);
  const f = new CloudField();
  const src = RAD_BANDS.map((b, i) => ({
    at: [i * 60], hz: Math.sqrt(b.lo * b.hi), amp: 1,
  }));
  f.analyse(ringOf(src), 0, RATE, 0);
  const bands = new Set();
  for (let i = 0; i < f.count; i++) bands.add(f.splats[i * S_STRIDE + 6]);
  assert.equal(bands.size, RAD_NBANDS, `only bands ${[...bands]} appeared`);
});
