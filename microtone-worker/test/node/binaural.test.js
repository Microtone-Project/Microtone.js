// Binaural monitoring (#998.3), rebuilt on the GoogleVR/SADIE spherical-
// harmonic HRIR set (item 128). The filters are MEASURED, so there is nothing
// here to fit by ear and nothing to transcribe: the tests assert that the
// decode is wired the way the set is defined — SN3D/ACN in, the m < 0 sign flip
// out, one convolution per harmonic — and then that the cues which come out the
// far end are a real head's. A wrong channel order, a dropped harmonic or a
// flipped ear all survive a "does it make sound" check and none of these.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BinauralRenderer, binauralChannelList, binauralHrirTable,
  MONITOR_FOLD, MONITOR_BINAURAL,
} from "../../core/engine/binaural.js";
import {
  HRIR_ORDER, HRIR_CHANNELS, HRIR_LENGTH, HRIR_RATE, decodeShHrir,
} from "../../core/engine/hrir-sadie.js";
import {
  StereoRenderer, encodeSN3D, SURROUND_PLANAR, SURROUND_SPATIAL,
} from "../../core/engine/spatial.js";
import { SAMPLING_RATE } from "../../core/engine/constants.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";

/** The head's own impulse response for a source at (az, el): [L, R]. */
function headIR(r, az, el, frames = 512) {
  const gains = new Float64Array(r.numChannels);
  r.channelGains(az, el, gains, 0);
  const bus = new Float64Array(r.numChannels * frames);
  for (let c = 0; c < r.numChannels; c++) bus[c * frames] = gains[c];
  return decode(r, bus, frames);
}

/** Push a filled bus through the renderer frame by frame; returns [L, R]. */
function decode(r, bus, frames) {
  const l = new Float64Array(frames);
  const rr = new Float64Array(frames);
  const pair = new Float64Array(2);
  r.reset();
  for (let n = 0; n < frames; n++) {
    r.monitorStereo(bus, frames, n, pair);
    l[n] = pair[0];
    rr[n] = pair[1];
  }
  return [l, rr];
}

/** One DFT bin of an impulse response, as [re, im]. */
function bin(ir, f, rate) {
  let re = 0;
  let im = 0;
  for (let n = 0; n < ir.length; n++) {
    const w = (-2 * Math.PI * f * n) / rate;
    re += ir[n] * Math.cos(w);
    im += ir[n] * Math.sin(w);
  }
  return [re, im];
}

const magAt = (ir, f, rate) => Math.hypot(...bin(ir, f, rate));
const energy = (a) => a.reduce((s, v) => s + v * v, 0);
const db = (x) => 10 * Math.log10(x);

/** Interaural PHASE delay in ms at `f` — positive when the left ear leads. */
function itdMs(l, r, f, rate) {
  const [lr, li] = bin(l, f, rate);
  const [rr, ri] = bin(r, f, rate);
  let d = Math.atan2(li, lr) - Math.atan2(ri, rr);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return (d / (2 * Math.PI * f)) * 1000;
}

/** Energy in a band of the response, sampled every 100 Hz. */
function band(ir, lo, hi, rate) {
  let s = 0;
  for (let f = lo; f <= hi; f += 100) s += magAt(ir, f, rate) ** 2;
  return s;
}

/** The height cue, in one number: how the pinna band sits against the one
 *  below it. Rises as a source climbs. */
const heightTilt = (ir, rate) => db(band(ir, 6000, 10000, rate) / band(ir, 2000, 5000, rate));

/** The front/back cue: the concha's 3–6 kHz boost, which a source in front gets
 *  and one behind does not. */
const frontTilt = (ir, rate) => db(band(ir, 3000, 6000, rate) / band(ir, 500, 2000, rate));

test("the harmonic sets are ACN, and the planar one is exactly the horizon's", () => {
  const sphere = binauralChannelList(true);
  assert.equal(sphere.length, (HRIR_ORDER + 1) ** 2);
  assert.deepEqual([...sphere], [...sphere.keys()], "a spatial head keeps the whole set, in ACN order");

  // Y_lm vanishes on the horizon whenever l − |m| is odd; those are the six a
  // planar song can never excite.
  const planar = binauralChannelList(false);
  assert.deepEqual([...planar], [0, 1, 3, 4, 6, 8, 9, 11, 13, 15]);
  const sh = new Float64Array((HRIR_ORDER + 1) ** 2);
  const kept = new Set(planar);
  for (let az = 0; az < 512; az += 7) {
    encodeSN3D(az, 0, HRIR_ORDER, sh);
    for (let k = 0; k < sh.length; k++) {
      if (!kept.has(k)) assert.ok(Math.abs(sh[k]) < 1e-15, `ACN ${k} is not zero on the horizon`);
    }
  }
});

test("a horizontal source decodes identically through either head", () => {
  // Which is the whole claim the planar reduction makes: not "close enough",
  // the same samples.
  const spatial = new BinauralRenderer(true);
  const planar = new BinauralRenderer(false);
  for (const az of [0, 37, 128, 200, 256, 400]) {
    const [ls, rs] = headIR(spatial, az, 0);
    const [lp, rp] = headIR(planar, az, 0);
    assert.deepEqual(lp, ls, `left ear differs at az=${az}`);
    assert.deepEqual(rp, rs, `right ear differs at az=${az}`);
  }
});

test("the bus carries the same ambisonic scene the AmbiX export writes", () => {
  const r = new BinauralRenderer(true);
  const acn = binauralChannelList(true);
  const got = new Float64Array(r.numChannels);
  const want = new Float64Array((HRIR_ORDER + 1) ** 2);
  for (const [az, el] of [[128, 0], [0, 0], [383, -40], [64, 96]]) {
    r.channelGains(az, el, got, 0);
    encodeSN3D(az, el, HRIR_ORDER, want);
    for (let c = 0; c < acn.length; c++) {
      assert.equal(got[c], want[acn[c]], `channel ${c} (ACN ${acn[c]}) at az=${az} el=${el}`);
    }
  }
  // W is unity for every direction — the encode is SN3D, not N3D.
  for (const [az, el] of [[0, 0], [128, 128], [300, -70]]) {
    r.channelGains(az, el, got, 0);
    assert.equal(got[0], 1.0);
  }
});

test("the HRIR module decodes to the set it advertises", () => {
  assert.equal(HRIR_CHANNELS, (HRIR_ORDER + 1) ** 2);
  const raw = decodeShHrir();
  assert.equal(raw.length, HRIR_CHANNELS * HRIR_LENGTH);
  for (const v of raw) assert.ok(v > -1 && v < 1, "samples are int16 scaled to ±1");

  // The base64 decoder is hand-rolled (AudioWorkletGlobalScope has no atob),
  // so check it against the platform's, on the real payload.
  const src = readFileSync(fileURLToPath(new URL("../../core/engine/hrir-sadie.js", import.meta.url)), "utf8");
  const b64 = [...src.matchAll(/^ {2}"([A-Za-z0-9+/=]+)",$/gm)].map((m) => m[1]).join("");
  assert.ok(b64.length > 0, "no payload found in hrir-sadie.js");
  const bytes = Buffer.from(b64, "base64");
  assert.equal(bytes.length, raw.length * 2);
  for (let i = 0; i < raw.length; i++) {
    assert.equal(raw[i], bytes.readInt16LE(i * 2) / 32768, `sample ${i}`);
  }
});

test("the near ear leads by a real head's interaural delay", () => {
  const r = new BinauralRenderer(true);
  const rate = SAMPLING_RATE;
  const at = (az) => {
    const [l, rr] = headIR(r, az, 0);
    return itdMs(l, rr, 500, rate);
  };
  // Woodworth's textbook maximum is (a/c)(1 + π/2) ≈ 0.66 ms of pure delay; the
  // LOW-frequency phase delay of a real head runs half again as long (3a/c).
  const left = at(0);
  assert.ok(left > 0.6 && left < 1.0, `hard left ITD ${left.toFixed(2)} ms`);
  assert.ok(Math.abs(at(256) + left) < 1e-9, "hard right must mirror it");
  assert.ok(Math.abs(at(128)) < 1e-9, "front has no interaural delay");
  assert.ok(Math.abs(at(384)) < 1e-9, "behind has none either");
  // …and it grows as the source swings out from the front.
  let prev = 0;
  for (const az of [112, 96, 64, 32, 0]) {
    const itd = at(az);
    assert.ok(itd > prev, `ITD must grow toward the side (az=${az}: ${itd.toFixed(2)} ms)`);
    prev = itd;
  }
});

test("the far ear sits in the head's shadow", () => {
  const r = new BinauralRenderer(true);
  const rate = SAMPLING_RATE;
  const [l, rr] = headIR(r, 0, 0); // hard left
  assert.ok(db(energy(l) / energy(rr)) > 8, "broadband ILD at 90° is ~10 dB");
  // The shadow is a low-pass: at 6 kHz the far ear loses far more than at 300.
  const lo = 20 * Math.log10(magAt(l, 300, rate) / magAt(rr, 300, rate));
  const hi = 20 * Math.log10(magAt(l, 6000, rate) / magAt(rr, 6000, rate));
  assert.ok(hi > lo + 6, `shadow is not frequency-dependent (${lo.toFixed(1)} → ${hi.toFixed(1)} dB)`);
});

test("left and right are mirror images of each other", () => {
  const r = new BinauralRenderer(true);
  for (const [az, el] of [[64, 40], [32, 0], [420, -60]]) {
    const [l1, r1] = headIR(r, az, el);
    const [l2, r2] = headIR(r, 256 - az, el); // mirrored about the front axis
    assert.deepEqual(r2, l1, "R(−θ) must equal L(θ)");
    assert.deepEqual(l2, r1, "L(−θ) must equal R(θ)");
  }
});

test("height and front/back are audible, which is the entire point", () => {
  const r = new BinauralRenderer(true);
  const rate = SAMPLING_RATE;
  const tiltAt = (az, el) => {
    const [l, rr] = headIR(r, az, el);
    return (heightTilt(l, rate) + heightTilt(rr, rate)) / 2;
  };
  // Climbing from ear level to overhead lifts the pinna band, monotonically.
  let prev = -Infinity;
  for (const el of [0, 32, 64, 96]) {
    const t = tiltAt(128, el);
    assert.ok(t > prev, `height cue not monotone at el=${el} (${t.toFixed(2)} dB)`);
    prev = t;
  }
  // Below the horizon the spectrum is nobody's straight line, but the level is:
  // a source under you is quieter than the same source over you.
  const powerAt = (az, el) => {
    const [l, rr] = headIR(r, az, el);
    return db(energy(l) + energy(rr));
  };
  for (const el of [64, 96, 128]) {
    assert.ok(powerAt(128, -el) < powerAt(128, el) - 1,
      `below must sit under above at ±${el}`);
  }
  // Front/back: a source ahead gets the concha's 3–6 kHz boost and one behind
  // does not, and it is louder besides. The fold cannot tell the two apart at
  // all, which is what this monitor exists to fix.
  const frontAt = (az, el) => {
    const [l, rr] = headIR(r, az, el);
    return (frontTilt(l, SAMPLING_RATE) + frontTilt(rr, SAMPLING_RATE)) / 2;
  };
  assert.ok(frontAt(128, 0) > frontAt(384, 0) + 3, "front must read brighter than behind");
  assert.ok(powerAt(128, 0) > powerAt(384, 0) + 2, "front must read louder than behind");

  const fold = new StereoRenderer();
  const g = new Float64Array(2);
  const gb = new Float64Array(2);
  fold.channelGains(128, 0, g, 0);
  fold.channelGains(384, 0, gb, 0);
  assert.deepEqual([...g], [...gb], "the fold really does collapse front onto back");
});

test("a centred source keeps exactly the level the fold gives it", () => {
  const r = new BinauralRenderer(true);
  // cos² + sin² = 1: the pan law hands a centred source unit power, 0.707 per
  // ear, and the calibration pins the head to the same figure.
  const [l, rr] = headIR(r, 128, 0);
  assert.ok(Math.abs(energy(l) + energy(rr) - 1) < 1e-12, "front is not unit power");
  assert.ok(Math.abs(energy(l) - energy(rr)) < 1e-12, "front is not centred");

  // Everywhere else the head is free to differ — and does, because a real one
  // does. What must not happen is a direction dropping out of the mix.
  let lo = Infinity;
  let hi = -Infinity;
  for (let az = 0; az < 512; az += 16) {
    for (const el of [-128, -64, 0, 64, 128]) {
      const [a, b] = headIR(r, az, el);
      const p = db(energy(a) + energy(b));
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
  }
  assert.ok(hi < 1.5, `something is louder than the fold: ${hi.toFixed(2)} dB`);
  assert.ok(lo > -8, `something nearly vanished: ${lo.toFixed(2)} dB`);
});

test("the pan stays continuous all the way round", () => {
  for (const sphere of [false, true]) {
    const r = new BinauralRenderer(sphere);
    const gains = new Float64Array(r.numChannels);
    let prev = null;
    for (let az = 0; az < 512; az += 4) {
      r.channelGains(az, 0, gains, 0);
      if (prev !== null) {
        let d = 0;
        for (let i = 0; i < gains.length; i++) d += (gains[i] - prev[i]) ** 2;
        assert.ok(Math.sqrt(d) < 0.2, `pan jumps at az=${az}`);
      }
      prev = Float64Array.from(gains);
    }
  }
});

test("the set follows the engine's rate (item 108)", () => {
  const rates = [32000, HRIR_RATE, 96000];
  const itds = [];
  for (const rate of rates) {
    const r = new BinauralRenderer(true, rate);
    const want = Math.ceil((HRIR_LENGTH * rate) / HRIR_RATE);
    assert.ok(r.taps >= want && r.taps < want + 4, `${rate} Hz: ${r.taps} taps, wanted ~${want}`);
    assert.equal(r.taps % 4, 0, "the unrolled convolution needs a multiple of four");
    // Rate conversion must not move the level contract or the interaural delay.
    const [l, rr] = headIR(r, 128, 0, r.taps * 2);
    assert.ok(Math.abs(energy(l) + energy(rr) - 1) < 1e-12, `${rate} Hz: front is not unit power`);
    const [ll, lr] = headIR(r, 0, 0, r.taps * 2);
    itds.push(itdMs(ll, lr, 500, rate));
  }
  for (const itd of itds) {
    assert.ok(Math.abs(itd / itds[1] - 1) < 0.05, `ITD moved with the rate: ${itds.join(", ")} ms`);
  }
  assert.equal(new BinauralRenderer(true, HRIR_RATE).taps, HRIR_LENGTH,
    "at the measured rate the set must be used as measured");
  assert.equal(binauralHrirTable(HRIR_RATE), binauralHrirTable(HRIR_RATE),
    "the table is built once per rate, not once per renderer");
});

test("the engine installs and removes the head on demand", () => {
  const eng = new TaudEngine();
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  assert.equal(eng.getMonitorMode(0), MONITOR_FOLD);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "stereo");

  eng.setMonitorMode(0, MONITOR_BINAURAL);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-3d");
  // The model switch has to rebuild the head — a planar song decodes ten
  // harmonics, not sixteen.
  eng.setSurroundModel(0, SURROUND_PLANAR);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-2d");
  assert.equal(eng.playheads[0].trackerState.spatial.numChannels, 10);

  // An exporter's renderer outranks the monitor, and giving it back restores it.
  eng.setSpatialRenderer(0, new StereoRenderer());
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "stereo");
  eng.setSpatialRenderer(0, null);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-2d");

  // A stereo song has no object bus at all, whatever the monitor says.
  eng.setSurroundModel(0, 0);
  assert.equal(eng.playheads[0].trackerState.spatial, null);
});

test("a whole song renders through the head: finite, audible, and not the fold", () => {
  // The decode runs inside the audio thread, where a NaN or a runaway sum is an
  // instant dead output. Render a real song both ways and compare.
  const doc = new Document(parseTaud(
    readFileSync(fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url))))).toRenderable(0);

  const render = (monitor) => {
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    eng.setSurroundModel(0, SURROUND_SPATIAL);
    if (monitor) eng.setMonitorMode(0, MONITOR_BINAURAL);
    return renderSong(eng, 3);
  };
  const head = render(true);
  const fold = render(false);

  assert.ok(head.frames > 0);
  let peak = 0;
  for (let i = 0; i < head.f32.length; i++) {
    assert.ok(Number.isFinite(head.f32[i]), `non-finite sample at ${i}`);
    const a = Math.abs(head.f32[i]);
    if (a > peak) peak = a;
  }
  assert.ok(peak > 0.01, `the head produced near-silence (peak ${peak})`);
  assert.ok(peak <= 1.0, `the head clipped (peak ${peak})`);
  assert.notDeepEqual(head.f32, fold.f32, "binaural must differ from the fold");

  // Loudness has to survive the trip, or nobody will leave it switched on.
  const rmsOf = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };
  const ratio = rmsOf(head.f32) / rmsOf(fold.f32);
  assert.ok(ratio > 0.7 && ratio < 1.45, `level moved by ${(20 * Math.log10(ratio)).toFixed(1)} dB`);
});

test("the monitor mode is a device setting, not a song property", () => {
  const eng = new TaudEngine();
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  eng.setMonitorMode(0, MONITOR_BINAURAL);
  eng.resetParams(0);
  assert.equal(eng.getMonitorMode(0), MONITOR_BINAURAL);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-3d");
});
