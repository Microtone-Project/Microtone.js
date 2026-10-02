// Ambisonic spectral radiation monitor (item 129) — the physics, not the paint.
//
// Every claim item 129 §5 makes about what the display SHOWS is a claim about
// arithmetic, because the surface has no special cases in it: two sources are
// summed as complex spectra and only then squared. So the phenomena are
// testable, and this is where they are tested — identical geometry, identical
// levels, and three completely different surfaces depending only on phase and
// coherence.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOPE_FRAMES, SCOPE_CHANNELS, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
} from "../../core/engine/analysis.js";
import {
  Fft, RadiationField, RadiationView, RAD_BANDS, RAD_NBANDS, RAD_VIEWS, RAD_VERTS,
  RAD_MERIDIANS, RAD_PARALLELS, RAD_FILL, RAD_SILENCE, G_LEN,
  RAD_TILT_DB_PER_OCT, RAD_TILT_PIVOT_HZ,
  radBandOfBin, radMonomials, radEnergy, radFollow, radScale, radTilt,
  srgbToLinear, linearToSrgb,
} from "../../src/ui/radiation.js";

const RATE = 48000;

/** Unit direction from a horizontal bearing in degrees, left positive. */
function bearing(deg, elDeg = 0) {
  const a = (deg * Math.PI) / 180;
  const e = (elDeg * Math.PI) / 180;
  const ce = Math.cos(e);
  return [ce * Math.cos(a), ce * Math.sin(a), Math.sin(e)]; // front, left, up
}

const FRONT = bearing(0);
const LEFT = bearing(90);
const RIGHT = bearing(-90);
const BACK = bearing(180);
const UP = bearing(0, 90);

/**
 * A B-format scope ring carrying `sources`, each an SN3D-encoded sine. This IS
 * the encoding — W = s, (Y, Z, X) = s · (dy, dz, dx) — so the ring is exactly
 * what the engine's own bus would have produced for those directions.
 */
function ringOf(sources) {
  const ring = new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS);
  for (const { dir, hz, amp = 1, phase = 0 } of sources) {
    for (let i = 0; i < SCOPE_FRAMES; i++) {
      const v = amp * Math.sin((2 * Math.PI * hz * i) / RATE + phase);
      const o = i * SCOPE_CHANNELS;
      ring[o + SCOPE_W] += v;
      ring[o + SCOPE_Y] += v * dir[1];
      ring[o + SCOPE_Z] += v * dir[2];
      ring[o + SCOPE_X] += v * dir[0];
    }
  }
  return ring;
}

/** A settled field: one analysis, then enough smoothing to be the raw answer. */
function fieldOf(sources) {
  const f = new RadiationField();
  f.analyse(ringOf(sources), 0, RATE, 0);
  f.smooth(1e6); // dt so long that both copies land exactly on the window
  return f;
}

/** The bands added up — the matrix the GEOMETRY comes from. */
function totalG(f, which = "geo") {
  const g = new Float64Array(G_LEN);
  for (let b = 0; b < RAD_NBANDS; b++) {
    for (let k = 0; k < G_LEN; k++) g[k] += f[which][b * G_LEN + k];
  }
  return g;
}

const mono = new Float64Array(G_LEN);
/** |p(d)|² for one direction against a packed matrix. */
function energyAt(g, dir) {
  radMonomials(dir[0], dir[1], dir[2], mono, 0);
  return radEnergy(g, 0, mono, 0);
}
const ampAt = (g, dir) => Math.sqrt(energyAt(g, dir));

// ── the small pure pieces ─────────────────────────────────────────────────

test("the FFT agrees with a direct transform", () => {
  const n = 64;
  const fft = new Fft(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) { ar[i] = re[i] = rnd(); ai[i] = im[i] = rnd(); }
  fft.run(re, im);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const w = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(w);
      const s = Math.sin(w);
      sr += ar[t] * c - ai[t] * s;
      si += ar[t] * s + ai[t] * c;
    }
    assert.ok(Math.abs(re[k] - sr) < 1e-9 && Math.abs(im[k] - si) < 1e-9, `bin ${k}`);
  }
  assert.throws(() => new Fft(48), /power of two/);
});

test("bins map onto the bands, and DC belongs to none of them", () => {
  const binHz = RATE / 2048;
  assert.equal(radBandOfBin(0, binHz), -1, "DC is nobody's — an offset must not inflate the bass");
  assert.equal(radBandOfBin(Math.round(100 / binHz), binHz), 0);
  assert.equal(radBandOfBin(Math.round(500 / binHz), binHz), 1);
  assert.equal(radBandOfBin(Math.round(1500 / binHz), binHz), 2);
  assert.equal(radBandOfBin(Math.round(4000 / binHz), binHz), 3);
  assert.equal(radBandOfBin(Math.round(12000 / binHz), binHz), 4);
  assert.equal(radBandOfBin(Math.round(22000 / binHz), binHz), -1, "over 20 kHz");
  // The edges tile without a gap and without an overlap.
  for (let b = 1; b < RAD_NBANDS; b++) assert.equal(RAD_BANDS[b].lo, RAD_BANDS[b - 1].hi);
});

test("sRGB and linear light round-trip", () => {
  for (const v of [0, 1, 17, 128, 200, 254, 255]) {
    assert.equal(linearToSrgb(srgbToLinear(v)), v, `byte ${v}`);
  }
  assert.equal(linearToSrgb(-1), 0);
  assert.equal(linearToSrgb(9), 255);
});

test("the followers are frame-rate independent, and attack beats release", () => {
  // One 100 ms step, cut two ways, lands in the same place.
  let a = 0;
  for (let i = 0; i < 10; i++) a = radFollow(a, 1, 10, 50, 400);
  const b = radFollow(0, 1, 100, 50, 400);
  assert.ok(Math.abs(a - b) < 1e-3, `${a} vs ${b}`);
  // Rising is faster than falling, which is what keeps a transient.
  assert.ok(radFollow(0, 1, 20, 25, 220) > 1 - radFollow(1, 0, 20, 25, 220));
});

test("the radius scale fills the dial, and lets silence shrink", () => {
  // Whatever the peak, an audible field fills the dial — the shape is the
  // reading and the meters below it are the absolute one.
  assert.ok(Math.abs(0.5 * radScale(0.5, 0.5) - RAD_FILL) < 1e-12, "a loud field fills the dial");
  assert.ok(Math.abs(2 * radScale(2, 0.5) - RAD_FILL) < 1e-12, "…and so does a louder one");
  // The shrink follows the LEVEL, not the peak it divides by: the peak is a
  // tilted quantity, so keying it there would collapse a loud bass-only
  // passage — which has a small tilted peak and is not quiet at all.
  const loudBass = radScale(RAD_SILENCE / 20, 0.5);
  assert.ok(Math.abs((RAD_SILENCE / 20) * loudBass - RAD_FILL) < 1e-12,
    "a tilted-down peak at a healthy level still fills the dial");
  const quiet = RAD_SILENCE / 4;
  assert.ok(0.5 * radScale(0.5, quiet) < RAD_FILL / 3, "…and a genuinely quiet one shrinks");
  assert.equal(radScale(0, 0.5), 0);
});

test("the analysis is tilted +4.5 dB/octave, and the level is not", () => {
  // The weight is a POWER one, so an octave up is 4.5 dB of level = 10^0.45.
  assert.ok(Math.abs(radTilt(RAD_TILT_PIVOT_HZ) - 1) < 1e-12, "unity at the pivot");
  const perOct = 10 ** (RAD_TILT_DB_PER_OCT / 10);
  assert.ok(Math.abs(radTilt(2000) / radTilt(1000) - perOct) < 1e-9, "an octave up");
  assert.ok(Math.abs(radTilt(500) / radTilt(1000) - 1 / perOct) < 1e-9, "an octave down");
  assert.ok(radTilt(100) < 1 && radTilt(10000) > 1, "lows down, highs up");

  // The same source, an octave apart, reads 4.5 dB louder to the SHAPE…
  const lo = fieldOf([{ dir: FRONT, hz: 1000 }]);
  const hi = fieldOf([{ dir: FRONT, hz: 2000 }]);
  const gLo = totalG(lo);
  const gHi = totalG(hi);
  assert.ok(Math.abs(energyAt(gHi, FRONT) / energyAt(gLo, FRONT) - perOct) < 0.05,
    `${energyAt(gHi, FRONT)} vs ${energyAt(gLo, FRONT)}`);
  // …and exactly the same to the LEVEL, which is what the presence envelope and
  // the silence floor read. Tilting that would have faded out a loud bass note.
  assert.ok(Math.abs(hi.density / lo.density - 1) < 0.02,
    `density ${hi.density} vs ${lo.density}`);
  lo.build(1e6, WHITE);
  hi.build(1e6, WHITE);
  assert.ok(Math.abs(hi.presence - lo.presence) < 1e-6, "so both are equally present");
});

test("the quadratic form is the beam it claims to be", () => {
  // One source dead ahead: E(d) = P·(1 + dx)², the first-order cardioid.
  const g = totalG(fieldOf([{ dir: FRONT, hz: 1000 }]));
  const peak = energyAt(g, FRONT);
  assert.ok(Math.abs(energyAt(g, LEFT) / peak - 0.25) < 0.02, "90° off is a quarter of the power");
  assert.ok(energyAt(g, BACK) / peak < 1e-3, "the antipode is a null");
  // …and it really is steered: the peak sits ON the source, not near it.
  for (const deg of [-60, -20, 20, 60]) {
    assert.ok(energyAt(g, bearing(deg)) < peak, `${deg}° should be under the source`);
  }
  // Energy is never negative, however the matrix is sliced.
  for (let i = 0; i < RAD_VERTS; i++) {
    assert.ok(radEnergy(g, 0, fieldOf([{ dir: UP, hz: 5000 }]).mono, i * G_LEN) >= 0);
  }
});

// ── item 129 §5: the phenomena ────────────────────────────────────────────
// Same two sources, same levels, same directions in each pair — only the phase
// relationship differs, and nothing in the renderer knows about any of it.

test("§5: two coherent sources 60° apart draw ONE lobe between them", () => {
  const g = totalG(fieldOf([
    { dir: bearing(30), hz: 1000 },
    { dir: bearing(-30), hz: 1000 },
  ]));
  const centre = energyAt(g, FRONT);
  assert.ok(centre > energyAt(g, bearing(30)), "the phantom centre beats either source");
  assert.ok(centre > energyAt(g, bearing(-30)));
  // A single maximum, dead ahead — not two.
  for (let deg = -180; deg < 180; deg += 5) {
    if (deg === 0) continue;
    assert.ok(energyAt(g, bearing(deg)) < centre, `${deg}° should be under the centre`);
  }
});

test("§5: invert one of them and the phantom centre becomes a null", () => {
  const g = totalG(fieldOf([
    { dir: bearing(30), hz: 1000 },
    { dir: bearing(-30), hz: 1000, phase: Math.PI },
  ]));
  const side = energyAt(g, LEFT);
  assert.ok(energyAt(g, FRONT) / side < 1e-3, "dead ahead cancels");
  assert.ok(energyAt(g, BACK) / side < 1e-3, "and so does dead behind");
  assert.ok(Math.abs(energyAt(g, RIGHT) / side - 1) < 1e-6, "two opposed lobes, equal");
});

test("§5: two coherent sources 180° apart collapse to no direction at all", () => {
  const g = totalG(fieldOf([
    { dir: LEFT, hz: 1000 },
    { dir: RIGHT, hz: 1000 },
  ]));
  // W adds, Y cancels: the field is omnidirectional. A per-channel meter would
  // have drawn two lobes here; the coherent sum says there is nowhere to point.
  const ref = energyAt(g, FRONT);
  for (const d of [LEFT, RIGHT, BACK, UP, bearing(45), bearing(-135, 30)]) {
    assert.ok(Math.abs(energyAt(g, d) / ref - 1) < 1e-3, "a sphere");
  }
});

test("§5: invert one of THOSE and the field is maximally two-sided", () => {
  const g = totalG(fieldOf([
    { dir: LEFT, hz: 1000 },
    { dir: RIGHT, hz: 1000, phase: Math.PI },
  ]));
  const side = energyAt(g, LEFT);
  assert.ok(Math.abs(energyAt(g, RIGHT) / side - 1) < 1e-6, "two equal opposed lobes");
  // The whole median plane is a null — front, back, above and below alike.
  for (const d of [FRONT, BACK, UP, bearing(180, -45)]) {
    assert.ok(energyAt(g, d) / side < 1e-3, "the plane between them cancels");
  }
});

test("coherence is what decides it, not level: the same pair, uncorrelated", () => {
  // Identical directions and identical levels to the collapsing pair above —
  // but at different frequencies, so the cross-spectra vanish and the two
  // sources stop interfering. A sphere becomes a peanut.
  //
  // The amplitudes are pre-compensated for the analysis tilt, so the two are
  // equal AS THE DISPLAY WEIGHTS THEM: this test is about coherence, and a
  // lopsided peanut would only be measuring the tilt (which has its own test).
  const g = totalG(fieldOf([
    { dir: LEFT, hz: 1000, amp: 1 / Math.sqrt(radTilt(1000)) },
    { dir: RIGHT, hz: 1500, amp: 1 / Math.sqrt(radTilt(1500)) },
  ]));
  const side = energyAt(g, LEFT);
  assert.ok(Math.abs(energyAt(g, RIGHT) / side - 1) < 0.05, "both sides sound");
  assert.ok(energyAt(g, FRONT) / side < 0.6, "…and the middle does not");
});

// ── item 129 §4: bands and colour ─────────────────────────────────────────

test("§4: the bands point in their own directions", () => {
  const f = fieldOf([
    { dir: LEFT, hz: 100 },     // band 0
    { dir: RIGHT, hz: 12000 },  // band 4
  ]);
  const bass = new Float64Array(f.geo.buffer, 0, G_LEN);
  const air = f.geo.subarray(4 * G_LEN, 5 * G_LEN);
  assert.ok(energyAt(bass, LEFT) > 10 * energyAt(bass, RIGHT), "the bass is on the left");
  assert.ok(energyAt(air, RIGHT) > 10 * energyAt(air, LEFT), "the air is on the right");
  // The middle bands saw nothing at all.
  for (const b of [1, 2, 3]) {
    const g = f.geo.subarray(b * G_LEN, (b + 1) * G_LEN);
    assert.ok(g[0] < bass[0] * 1e-3, `band ${b} should be quiet`);
  }
});

test("§9: colour is the spectrum, and level does not touch it", () => {
  const bandLin = RAD_BANDS.map((_, b) => [b === 0 ? 1 : 0, b === 4 ? 1 : 0, 0]);
  const loud = fieldOf([{ dir: LEFT, hz: 100 }]);
  const quiet = fieldOf([{ dir: LEFT, hz: 100, amp: 0.05 }]);
  loud.build(1e6, bandLin);
  quiet.build(1e6, bandLin);
  const v = RAD_MERIDIANS * (RAD_PARALLELS / 2) + RAD_MERIDIANS / 4; // the equator, to the left
  assert.deepEqual(
    [...loud.ink.subarray(v * 3, v * 3 + 3)], [...quiet.ink.subarray(v * 3, v * 3 + 3)],
    "a quiet bass note and a loud one are the same colour",
  );
  assert.ok(loud.ink[v * 3] > 0, "…and it is the bass band's own ink");
  assert.equal(loud.ink[v * 3 + 1], 0, "with nothing of the air band's in it");
  // …while the SIZE is entirely different.
  assert.ok(loud.peak > 10 * quiet.peak, `${loud.peak} vs ${quiet.peak}`);
});

// ── the surface, and the three cameras ────────────────────────────────────

const WHITE = RAD_BANDS.map(() => [1, 1, 1]);

/** Centre of mass of everything the view painted, in −1…1 screen units. */
function centroid(px, size) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (px[(y * size + x) * 4 + 3] === 0) continue;
      sx += (x + 0.5) / size * 2 - 1;
      sy += 1 - (y + 0.5) / size * 2;
      n++;
    }
  }
  return { x: n ? sx / n : 0, y: n ? sy / n : 0, n };
}

function renderView(f, name, size = 96) {
  const view = new RadiationView(size);
  const px = new Uint8ClampedArray(size * size * 4);
  view.render(f, RAD_VIEWS[name], px, [0, 0, 0], [255, 255, 255]);
  return { px, size, view };
}

test("a uniform field is a sphere, and a steered one is a lobe", () => {
  const flat = fieldOf([{ dir: LEFT, hz: 1000 }, { dir: RIGHT, hz: 1000 }]);
  flat.build(1e6, WHITE);
  let lo = Infinity;
  let hi = 0;
  for (let v = 0; v < RAD_VERTS; v++) {
    const r = Math.hypot(flat.pos[v * 3], flat.pos[v * 3 + 1], flat.pos[v * 3 + 2]);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  assert.ok(hi - lo < 1e-4, `a sphere, not ${lo}…${hi}`);
  assert.ok(Math.abs(hi - RAD_FILL) < 1e-3, "scaled to fill the dial");

  const lobe = fieldOf([{ dir: FRONT, hz: 1000 }]);
  lobe.build(1e6, WHITE);
  const front = lobe.pos[(RAD_MERIDIANS * (RAD_PARALLELS / 2)) * 3];
  assert.ok(Math.abs(front - RAD_FILL) < 1e-3, "the lobe reaches the rim dead ahead");
});

test("the three cameras look at the one surface from three places", () => {
  // A source up and to the front-left, so every view has something to say and
  // no two of them can agree by accident.
  const f = fieldOf([{ dir: bearing(40, 35), hz: 1000 }]);
  f.build(1e6, WHITE);

  const top = renderView(f, "top");
  const front = renderView(f, "front");
  const side = renderView(f, "side");
  for (const [name, r] of [["top", top], ["front", front], ["side", side]]) {
    assert.ok(r.n !== 0 || true);
    const c = centroid(r.px, r.size);
    assert.ok(c.n > 200, `${name}: painted ${c.n} pixels`);
  }
  // Top: left-right against front-back. The lobe is front and to the LEFT, so
  // the mass sits up and to the left of centre.
  const ct = centroid(top.px, top.size);
  assert.ok(ct.x < -0.02 && ct.y > 0.02, `top centroid ${ct.x}, ${ct.y}`);
  // Front: left-right against height. Left and UP.
  const cf = centroid(front.px, front.size);
  assert.ok(cf.x < -0.02 && cf.y > 0.02, `front centroid ${cf.x}, ${cf.y}`);
  // Side: front-back against height, front to the LEFT. Front and up.
  const cs = centroid(side.px, side.size);
  assert.ok(cs.x < -0.02 && cs.y > 0.02, `side centroid ${cs.x}, ${cs.y}`);

  // A source dead behind puts the top view's mass BELOW centre, which is the
  // check that the cameras are not all quietly the same one.
  const b = fieldOf([{ dir: BACK, hz: 1000 }]);
  b.build(1e6, WHITE);
  assert.ok(centroid(renderView(b, "top").px, 96).y < -0.02, "back is down in the top view");
});

test("the surface stays inside the dial, and silence paints nothing", () => {
  const f = fieldOf([{ dir: bearing(15, -20), hz: 1000 }]);
  f.build(1e6, WHITE);
  const size = 96;
  for (const name of ["top", "front", "side"]) {
    const { px } = renderView(f, name, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (px[(y * size + x) * 4 + 3] === 0) continue;
        const dx = (x + 0.5) - size / 2;
        const dy = (y + 0.5) - size / 2;
        assert.ok(Math.hypot(dx, dy) <= size / 2, `${name}: ink outside the rim at ${x},${y}`);
      }
    }
  }

  // Fed nothing, the field is not live and the panel is blank rather than a
  // magnified sphere of dither.
  const quiet = new RadiationField();
  quiet.analyse(ringOf([{ dir: FRONT, hz: 1000, amp: 1e-6 }]), 0, RATE, 0);
  quiet.smooth(1e6);
  quiet.build(1e6, WHITE);
  assert.equal(quiet.live, false);
  assert.equal(centroid(renderView(quiet, "top").px, 96).n, 0, "nothing painted");
});

test("a stopped take fades instead of freezing on its last window", () => {
  const f = fieldOf([{ dir: FRONT, hz: 1000 }]);
  f.build(1e6, WHITE);
  assert.ok(f.peak > RAD_SILENCE);
  assert.ok(Math.abs(f.presence - 1) < 1e-6, "a full-scale field is fully present");
  assert.equal(centroid(renderView(f, "top").px, 96).n > 200, true);

  // The ring keeps its last window forever, so the level has to be told the
  // take ended. It then fades — quickly enough to read as stopping, slowly
  // enough to read as a decay.
  const maxRadius = () => {
    let m = 0;
    for (let v = 0; v < RAD_VERTS; v++) {
      m = Math.max(m, Math.hypot(f.pos[v * 3], f.pos[v * 3 + 1], f.pos[v * 3 + 2]));
    }
    return m;
  };
  assert.ok(Math.abs(maxRadius() - RAD_FILL) < 1e-3, "playing, it fills the dial");

  f.fade();
  // It DIES AWAY: the surface shrinks as it thins out, rather than collapsing
  // to a point the instant the ring stops being topped up. (Regression: the
  // shrink read the raw level, which drops to zero in one frame.)
  f.smooth(16);
  f.build(16, WHITE);
  const oneFrame = maxRadius();
  assert.ok(oneFrame > RAD_FILL * 0.8, `one frame after the stop: ${oneFrame}`);
  for (let i = 0; i < 29; i++) { f.smooth(16); f.build(16, WHITE); } // ~0.5 s
  assert.ok(maxRadius() < oneFrame * 0.85, `half a second in: ${maxRadius()}`);
  assert.ok(f.presence < 0.35 && f.live, `half a second in: ${f.presence}`);
  for (let i = 0; i < 90; i++) { f.smooth(16); f.build(16, WHITE); } // ~2 s total
  assert.equal(f.live, false, `presence ${f.presence}`);
  assert.equal(centroid(renderView(f, "top").px, 96).n, 0, "and paints nothing");
});

test("the analysis is paced by the audio, not by the frame rate", () => {
  const f = new RadiationField();
  const ring = ringOf([{ dir: FRONT, hz: 1000 }]);
  assert.equal(f.analyse(ring, 0, RATE, 0), true, "the first window always runs");
  assert.equal(f.analyse(ring, 0, RATE, 8), false, "8 frames of new audio is not a hop");
  assert.equal(f.analyse(ring, 0, RATE, 8), false);
  assert.equal(f.analyse(ring, 0, RATE, 4096), true, "…a hop's worth is");
  f.reset();
  assert.equal(f.ready, false);
  assert.equal(f.peak, 0);
});
