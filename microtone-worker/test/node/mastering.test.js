// Mastering chain, loudness metering and the `sMst` section (item 178).
//
// Three things matter most here and each gets its own guard:
//
//   * a chain nobody has touched must not move a single sample — the whole
//     back catalogue renders through this code path now;
//   * the limiter's ceiling is a PROMISE, so it is checked against material
//     designed to break it, in both peak modes; and
//   * the loudness figures are a standard, so they are checked against the
//     standard's own test signals rather than against themselves.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  MasterChain, defaultMastering, normaliseMastering, cloneMastering,
  masteringEngaged, masteringEqual, responseCurve, dbToGain, RANGE,
  EQ_LOW_SHELF, EQ_PEAKING, EQ_HIGH_SHELF, COMP_RMS, HP_SLOPE_24,
  LIMITER_LOOKAHEAD_MS,
} from "../../src/engine/mastering.js";
import {
  KWeighting, kWeightingCoefficients, LoudnessIntegrator, PhaseScrambler,
  MasterMeterTap, makeMasterMeterReadout, TAP_PRE, TAP_POST, SPEC_FRAMES,
  bitUsage, crestDb, dbfs, gatedMean, loudnessRange, percentile, FRAME_SEC,
  BIT_DEPTHS, DEFAULT_BIT_DEPTH, HIST_BUCKETS,
} from "../../src/engine/loudness.js";
import {
  MASTERING_FOURCC, MASTERING_BLOCK_SIZE, parseMasteringBlock,
  buildMasteringBlock, parseMasteringSection, buildMasteringSection,
  isDefaultMastering,
} from "../../src/format/mastering-section.js";
import {
  Fft, BandAnalyser, hannWindow, spectrumDb, SPECTRUM_BANDS, SPECTRUM_NBANDS,
  SPECTRUM_TILT_DB_PER_OCT, SPECTRUM_TILT_PIVOT_HZ, tiltDbAt, tiltWeights,
} from "../../src/engine/fft.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../../src/engine/constants.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { setMasteringOp } from "../../src/doc/ops.js";
import { loadIntoEngine, renderSong } from "../../src/audio/offline-render.js";
import { analyseSongAsync, gainForTruePeak, gainForLoudness, trimForLoudness }
  from "../../src/audio/master-analysis.js";
import { setRandomSource, makeSeededRandom } from "../../src/engine/rng.js";

const corpusDir = new URL("../corpus/", import.meta.url).pathname;

/** Run a chain over a signal, a block at a time, and return the result. */
function runChain(params, left, right, block = TRACKER_CHUNK) {
  const chain = new MasterChain(params, SAMPLING_RATE);
  const l = Float32Array.from(left);
  const r = Float32Array.from(right);
  for (let o = 0; o < l.length; o += block) {
    const n = Math.min(block, l.length - o);
    chain.process(l.subarray(o, o + n), r.subarray(o, o + n), n);
  }
  return { l, r, chain };
}

/** A dense, unclipped test signal — several partials plus a little noise. */
function testSignal(n, gain = 1) {
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLING_RATE;
    out[i] = Math.fround(gain * (0.35 * (Math.sin(2 * Math.PI * 55 * t) +
      0.7 * Math.sin(2 * Math.PI * 220.5 * t) + 0.5 * Math.sin(2 * Math.PI * 1319 * t)) +
      0.05 * rnd()));
  }
  return out;
}

// ── the chain is absent until it is asked for ───────────────────────────────

test("a neutral chain is not engaged at all", () => {
  const d = defaultMastering();
  assert.equal(masteringEngaged(d), false);
  d.on = true;
  assert.equal(masteringEngaged(d), false, "switched on but nothing set is still nothing");
  d.limOn = true;
  assert.equal(masteringEngaged(d), true);
  d.limOn = false;
  d.outGainDb = 0.5;
  assert.equal(masteringEngaged(d), true, "a gain that is not unity engages it");
  d.outGainDb = 0;
  d.widthOn = true;
  assert.equal(masteringEngaged(d), false, "width at 100% is the identity");
});

test("an engaged but transparent chain leaves the signal alone", () => {
  const src = testSignal(4096);
  const p = defaultMastering();
  p.on = true;
  p.widthOn = true; // width 1.0 short-circuits
  const { l } = runChain(p, src, src);
  for (let i = 0; i < src.length; i++) assert.equal(l[i], src[i]);
});

test("a corpus song renders identically with a neutral chain installed", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const render = (mastering) => {
    setRandomSource(makeSeededRandom(99));
    const doc = parseTaud(bytes);
    doc.songs[0].mastering = mastering;
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    return renderSong(eng, 8).u8;
  };
  const plain = render(null);
  const neutral = render(defaultMastering());
  assert.deepEqual(Array.from(neutral), Array.from(plain));
  setRandomSource(null);
});

// ── block-size independence ─────────────────────────────────────────────────

test("the chain's output does not depend on the block size", () => {
  const p = normaliseMastering({
    on: true, trimDb: -2, hpOn: true, hpFreq: 40, hpSlope: HP_SLOPE_24,
    eqOn: true, compOn: true, compThreshDb: -20, compRatio: 4, compMakeupDb: 3,
    widthOn: true, width: 1.3, limOn: true, limTruePeak: true, outGainDb: 1,
    eq: [
      { on: true, type: EQ_LOW_SHELF, freq: 90, gainDb: 3, q: 0.7 },
      { on: true, type: EQ_PEAKING, freq: 400, gainDb: -2, q: 1.2 },
      { on: false, type: EQ_PEAKING, freq: 2500, gainDb: 0, q: 1 },
      { on: true, type: EQ_HIGH_SHELF, freq: 8000, gainDb: 2, q: 0.7 },
    ],
  });
  const src = testSignal(8192);
  const a = runChain(p, src, src, 128).l;
  const b = runChain(p, src, src, 512).l;
  const c = runChain(p, src, src, 37).l;
  for (let i = 0; i < src.length; i++) {
    assert.equal(a[i], b[i], `block 128 vs 512 at ${i}`);
    assert.equal(a[i], c[i], `block 128 vs 37 at ${i}`);
  }
});

// ── the limiter's promise ───────────────────────────────────────────────────

for (const truePeak of [false, true]) {
  test(`the limiter never exceeds its ceiling (${truePeak ? "true" : "sample"} peak)`, () => {
    const p = defaultMastering();
    p.on = true; p.limOn = true; p.limTruePeak = truePeak;
    p.limCeilingDb = -1; p.limReleaseMs = 50;
    const n = SAMPLING_RATE;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLING_RATE;
      // Sustained overdrive with hard transients punched through it — the two
      // things a look-ahead limiter can get wrong, in one signal.
      let v = 0.6 * Math.sin(2 * Math.PI * 997 * t);
      if (i % 4800 < 20) v += 2.6;
      if (i > n / 2) v *= 3;
      left[i] = Math.fround(v);
      right[i] = Math.fround(v * 0.8);
    }
    const { l, r } = runChain(p, left, right);
    const ceiling = dbToGain(-1);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(l[i]), Math.abs(r[i]));
    assert.ok(worst <= ceiling + 1e-6, `sample peak ${worst} over ceiling ${ceiling}`);
    assert.ok(worst > ceiling * 0.9, "…and it is actually reaching the ceiling");
  });
}

test("the limiter's latency is two look-ahead windows", () => {
  const p = defaultMastering();
  p.on = true; p.limOn = true;
  const chain = new MasterChain(p, SAMPLING_RATE);
  const d = Math.round((LIMITER_LOOKAHEAD_MS / 1000) * SAMPLING_RATE);
  assert.equal(chain.latency, 2 * d);
  p.limOn = false;
  chain.setParams(p);
  assert.equal(chain.latency, 0, "a bypassed limiter delays nothing");
});

// ── the other stages ────────────────────────────────────────────────────────

test("width 0 collapses to mono and width 2 doubles the side", () => {
  const l = Float32Array.from([1, 0.5, -0.25]);
  const r = Float32Array.from([0, 0.5, 0.25]);
  const p = defaultMastering();
  p.on = true; p.widthOn = true; p.width = 0;
  const mono = runChain(p, l, r, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(mono.l[i] - mono.r[i]) < 1e-6, "channels are identical");
    assert.ok(Math.abs(mono.l[i] - (l[i] + r[i]) / 2) < 1e-6, "…and are the mono sum");
  }
  p.width = 2;
  const wide = runChain(p, l, r, 3);
  // m = 0.5, s = 0.5 × 2 = 1 → L = 1.5, R = −0.5.
  assert.ok(Math.abs(wide.l[0] - 1.5) < 1e-6, String(wide.l[0]));
  assert.ok(Math.abs(wide.r[0] - -0.5) < 1e-6, String(wide.r[0]));
});

test("an EQ band's response curve matches what it does to a tone", () => {
  const p = normaliseMastering({
    on: true, eqOn: true,
    eq: [
      { on: false, type: EQ_LOW_SHELF, freq: 100, gainDb: 0, q: 0.707 },
      { on: true, type: EQ_PEAKING, freq: 1000, gainDb: 6, q: 2 },
      { on: false, type: EQ_PEAKING, freq: 2500, gainDb: 0, q: 1 },
      { on: false, type: EQ_HIGH_SHELF, freq: 8000, gainDb: 0, q: 0.707 },
    ],
  });
  const chain = new MasterChain(p, SAMPLING_RATE);
  assert.ok(Math.abs(chain.responseDb(1000) - 6) < 0.05, "curve says +6 dB at the centre");
  assert.ok(Math.abs(chain.responseDb(50)) < 0.2, "…and nothing an octave-and-more away");

  // …and the same figure measured on a rendered tone.
  const n = SAMPLING_RATE;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = Math.fround(0.5 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLING_RATE));
  const { l } = runChain(p, tone, tone);
  let inSq = 0, outSq = 0;
  for (let i = n / 2; i < n; i++) { inSq += tone[i] * tone[i]; outSq += l[i] * l[i]; }
  const measured = 10 * Math.log10(outSq / inSq);
  assert.ok(Math.abs(measured - 6) < 0.1, `measured ${measured.toFixed(3)} dB`);

  const { freq, db } = responseCurve(chain, 20, 20000, 128);
  assert.equal(freq.length, 128);
  assert.ok(freq[0] === 20 && Math.abs(freq[127] - 20000) < 1e-6);
  assert.ok(Math.max(...db) > 5.5, "the curve carries the boost");
});

test("the high-pass removes what it says it removes", () => {
  const p = defaultMastering();
  p.on = true; p.hpOn = true; p.hpFreq = 100; p.hpSlope = HP_SLOPE_24;
  const chain = new MasterChain(p, SAMPLING_RATE);
  assert.ok(Math.abs(chain.responseDb(100) - (-3)) < 0.6, "−3 dB at the corner");
  // 24 dB/oct: two octaves down is about 48 dB.
  const twoDown = chain.responseDb(25);
  assert.ok(twoDown < -40 && twoDown > -56, `two octaves down: ${twoDown.toFixed(1)} dB`);
  assert.ok(Math.abs(chain.responseDb(4000)) < 0.1, "…and nothing in the passband");
});

test("the compressor reduces gain above its threshold and not below", () => {
  const p = defaultMastering();
  p.on = true; p.compOn = true;
  p.compThreshDb = -20; p.compRatio = 4; p.compKneeDb = 0;
  p.compAttackMs = 1; p.compReleaseMs = 50;
  const n = SAMPLING_RATE;
  const level = (amp) => {
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.fround(amp * Math.sin((2 * Math.PI * 200 * i) / SAMPLING_RATE));
    const { l } = runChain(p, sig, sig);
    let sq = 0;
    for (let i = n / 2; i < n; i++) sq += l[i] * l[i];
    return 10 * Math.log10(sq / (n / 2));
  };
  const quiet = level(dbToGain(-40));
  assert.ok(Math.abs(quiet - (-40 - 3.01)) < 0.2, `below threshold, untouched: ${quiet.toFixed(2)}`);
  // A −8 dBFS sine peaks at −8, i.e. 12 dB over; at 4:1 that is 9 dB of
  // reduction on the peak, so the RMS comes down by the same 9 dB.
  const loud = level(dbToGain(-8));
  const expected = -8 - 3.01 - 9;
  assert.ok(Math.abs(loud - expected) < 0.5, `above threshold: ${loud.toFixed(2)} vs ${expected.toFixed(2)}`);
});

test("the RMS detector reaches a short burst more slowly than the peak one", () => {
  const n = 4096;
  const mk = (det, burst) => {
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = i >= 1000 && i < 1000 + burst ? 0.9 : 0.01;
    const p = defaultMastering();
    p.on = true; p.compOn = true; p.compDetector = det;
    p.compThreshDb = -30; p.compRatio = 8; p.compAttackMs = 0.5; p.compReleaseMs = 100;
    // ONE block, so the reported reduction is the minimum over the whole
    // signal rather than over whichever block happened to be last.
    return runChain(p, sig, sig, n).chain.compGrDb;
  };
  // 2 ms is a fifth of the RMS window: peak has the burst's real level at once,
  // the RMS average is still climbing toward it.
  assert.ok(mk(0, 96) < mk(COMP_RMS, 96) - 3,
    `short burst: peak ${mk(0, 96).toFixed(2)} vs rms ${mk(COMP_RMS, 96).toFixed(2)}`);
  // Given a hundred milliseconds they agree — the detector is about speed, not
  // about how much a sustained level is worth.
  assert.ok(Math.abs(mk(0, 4800) - mk(COMP_RMS, 4800)) < 0.1,
    `sustained: peak ${mk(0, 4800).toFixed(2)} vs rms ${mk(COMP_RMS, 4800).toFixed(2)}`);
});

// ── loudness ────────────────────────────────────────────────────────────────

test("K-weighting reproduces the BS.1770 48 kHz coefficient table", () => {
  const [shelf, hp] = kWeightingCoefficients(48000);
  const table = {
    b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
    a1: -1.69065929318241, a2: 0.73248077421585,
  };
  for (const k of Object.keys(table)) {
    assert.ok(Math.abs(shelf[k] - table[k]) < 1e-9, `shelf ${k}: ${shelf[k]}`);
  }
  assert.ok(Math.abs(hp.a1 - (-1.99004745483398)) < 1e-8, `hp a1: ${hp.a1}`);
  assert.ok(Math.abs(hp.a2 - 0.99007225036621) < 1e-8, `hp a2: ${hp.a2}`);
  // …and the derivation still produces a filter at another rate.
  const at32 = kWeightingCoefficients(32000);
  assert.ok(at32[0].b0 !== shelf.b0, "32 kHz gets its own coefficients");
});

/** Measure a stereo tone the way the tap does. */
function measureTone(dbfsLevel, seconds, freq = 1000) {
  const amp = 10 ** (dbfsLevel / 20);
  const kw = [new KWeighting(SAMPLING_RATE), new KWeighting(SAMPLING_RATE)];
  const li = new LoudnessIntegrator(SAMPLING_RATE);
  const block = 4800;
  let sumZ = 0, sumSq = 0, peak = 0, n = 0;
  for (let i = 0; i < SAMPLING_RATE * seconds; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLING_RATE);
    const zl = kw[0].run(v), zr = kw[1].run(v);
    sumZ += zl * zl + zr * zr;
    sumSq += 2 * v * v;
    peak = Math.max(peak, Math.abs(v));
    if (++n === block) { li.push(sumZ, sumSq, peak, 0, n); sumZ = sumSq = 0; peak = 0; n = 0; }
  }
  return li;
}

test("EBU Tech 3341: a −23 dBFS stereo 1 kHz tone reads −23 LUFS", () => {
  const li = measureTone(-23, 20);
  assert.ok(Math.abs(li.momentary - (-23)) < 0.1, `M ${li.momentary}`);
  assert.ok(Math.abs(li.shortTerm - (-23)) < 0.1, `S ${li.shortTerm}`);
  assert.ok(Math.abs(li.integrated - (-23)) < 0.1, `I ${li.integrated}`);
  assert.ok(li.range < 0.1, `LRA of a steady tone: ${li.range}`);
});

test("…and a −33 dBFS one reads −33 LUFS", () => {
  const li = measureTone(-33, 20);
  assert.ok(Math.abs(li.integrated - (-33)) < 0.1, `I ${li.integrated}`);
});

test("the absolute gate drops silence out of the integrated figure", () => {
  // −80 LUFS blocks are below the −70 gate and must not drag the mean down.
  const loud = 10 ** ((-23 + 0.691) / 10);
  const silent = 10 ** ((-80 + 0.691) / 10);
  const mixed = gatedMean([...Array(10).fill(loud), ...Array(30).fill(silent)], -10);
  assert.ok(Math.abs(mixed - (-23)) < 0.05, `${mixed}`);
});

test("loudness range spans the 10th to 95th percentile", () => {
  const z = (lufs) => 10 ** ((lufs + 0.691) / 10);
  const blocks = [];
  for (let i = 0; i < 100; i++) blocks.push(z(-30 + i * 0.2)); // −30 … −10.2 LUFS
  const lra = loudnessRange(blocks);
  assert.ok(lra > 12 && lra < 20, `${lra}`);
  assert.equal(loudnessRange([z(-20)]), 0, "one block has no range");
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

test("the integrator packs arbitrary intervals into the same 100 ms frames", () => {
  const build = (block) => {
    const li = new LoudnessIntegrator(SAMPLING_RATE);
    const total = SAMPLING_RATE * 5;
    const perSample = 0.01;
    for (let done = 0; done < total; done += block) {
      const n = Math.min(block, total - done);
      li.push(perSample * n, perSample * n, 0.5, 0, n);
    }
    return li.integrated;
  };
  const a = build(128), b = build(4801), c = build(1000);
  assert.ok(Math.abs(a - b) < 0.01 && Math.abs(a - c) < 0.01, `${a} ${b} ${c}`);
});

// ── the crest gap ───────────────────────────────────────────────────────────

test("phase scrambling reveals clipping as a crest gap", () => {
  const measure = (drive) => {
    const ap = new PhaseScrambler(SAMPLING_RATE);
    const src = testSignal(SAMPLING_RATE * 2, drive);
    let pk = 0, sq = 0, apk = 0, asq = 0;
    for (let i = 0; i < src.length; i++) {
      const x = Math.max(-0.5, Math.min(0.5, src[i]));
      const y = ap.run(x);
      pk = Math.max(pk, Math.abs(x)); sq += x * x;
      apk = Math.max(apk, Math.abs(y)); asq += y * y;
    }
    return crestDb(apk, asq / src.length) - crestDb(pk, sq / src.length);
  };
  const clean = measure(0.5);
  const crushed = measure(20);
  assert.ok(clean < 1.5, `an unclipped signal has almost no gap: ${clean.toFixed(2)}`);
  assert.ok(crushed > 6, `a hard-clipped one has a wide one: ${crushed.toFixed(2)}`);
  assert.ok(crushed > clean + 5, "…and the difference is the reading");
});

// ── bit usage ───────────────────────────────────────────────────────────────

test("bit usage counts the codes the file actually touches", () => {
  const h = new Float64Array(256);
  assert.equal(bitUsage(h).used, 0, "silence uses nothing");
  h[128] = 100;
  let u = bitUsage(h);
  assert.equal(u.used, 1);
  assert.equal(u.span, 1);
  assert.equal(u.entropyBits, 0, "one code carries no information");
  h.fill(0);
  for (let i = 0; i < 256; i++) h[i] = 1;
  u = bitUsage(h);
  assert.equal(u.used, 256);
  assert.equal(u.span, 256);
  assert.equal(u.effectiveBits, 8);
  assert.ok(Math.abs(u.entropyBits - 8) < 1e-9, "…and a flat distribution carries all eight");
  h.fill(0);
  for (let i = 64; i < 192; i++) h[i] = 1;
  u = bitUsage(h);
  assert.equal(u.effectiveBits, 7, "half the code space is one bit less");
});

// ── the `sMst` section ──────────────────────────────────────────────────────

test("a parameter block round-trips exactly", () => {
  const p = normaliseMastering({
    on: true, trimDb: -1.5, hpOn: true, hpFreq: 32.7, hpSlope: HP_SLOPE_24,
    eqOn: true, compOn: true, compDetector: COMP_RMS, compRatio: 3.33,
    compThreshDb: -16.7, compAttackMs: 12.5, compReleaseMs: 333, compKneeDb: 4.5,
    compMakeupDb: 2.25, widthOn: true, width: 1.23,
    limOn: true, limTruePeak: true, limCeilingDb: -0.3, limReleaseMs: 123.4,
    outGainDb: 0.77,
    eq: [
      { on: true, type: EQ_LOW_SHELF, freq: 90, gainDb: 2.6, q: 0.8 },
      { on: true, type: EQ_PEAKING, freq: 440, gainDb: -3.3, q: 1.7 },
      { on: false, type: EQ_PEAKING, freq: 2500, gainDb: 0, q: 1 },
      { on: true, type: EQ_HIGH_SHELF, freq: 9000, gainDb: -1.3, q: 0.9 },
    ],
  });
  const block = buildMasteringBlock(p);
  assert.equal(block.length, MASTERING_BLOCK_SIZE);
  assert.ok(masteringEqual(p, parseMasteringBlock(block)));
});

test("a block this reader does not understand is dropped, not guessed at", () => {
  const block = buildMasteringBlock(normaliseMastering({ on: true, limOn: true }));
  block[0] = 99; // a version from the future
  assert.equal(parseMasteringBlock(block), null);
  assert.equal(parseMasteringBlock(block.subarray(0, 8)), null, "…and so is a short one");
});

test("an all-default chain writes no section at all", () => {
  assert.ok(isDefaultMastering(defaultMastering()));
  assert.equal(buildMasteringSection({ 0: defaultMastering() }), null);
  const p = defaultMastering();
  p.on = true; p.limOn = true;
  const sec = buildMasteringSection({ 0: defaultMastering(), 1: p, 3: p });
  const back = parseMasteringSection(sec);
  assert.deepEqual(Object.keys(back).map(Number), [1, 3], "only the songs that declare one");
  assert.ok(masteringEqual(back[1], p));
});

test("parameters are narrowed to binary32, so a save cannot drift", () => {
  const p = normaliseMastering({ on: true, eqOn: true, eq: [{ on: true, type: EQ_PEAKING, freq: 1000, gainDb: 0.1, q: 0.8 }] });
  assert.equal(p.eq[0].q, Math.fround(0.8));
  assert.equal(p.trimDb, Math.fround(0));
  const twice = normaliseMastering(cloneMastering(p));
  assert.ok(masteringEqual(p, twice));
});

test("out-of-range values are clamped, never rejected", () => {
  const p = normaliseMastering({ trimDb: 999, compRatio: -5, width: 12, hpFreq: NaN });
  assert.equal(p.trimDb, RANGE.trimDb[1]);
  assert.equal(p.compRatio, RANGE.compRatio[0]);
  assert.equal(p.width, RANGE.width[1]);
  assert.equal(p.hpFreq, defaultMastering().hpFreq,
    "a non-number falls back to the stage's resting value, not the bottom of its range");
});

test("only the outer EQ bands may be shelves", () => {
  const p = normaliseMastering({
    eq: [
      { type: EQ_LOW_SHELF }, { type: EQ_HIGH_SHELF },
      { type: EQ_LOW_SHELF }, { type: EQ_HIGH_SHELF },
    ],
  });
  assert.equal(p.eq[0].type, EQ_LOW_SHELF);
  assert.equal(p.eq[1].type, EQ_PEAKING);
  assert.equal(p.eq[2].type, EQ_PEAKING);
  assert.equal(p.eq[3].type, EQ_HIGH_SHELF);
});

// ── the document, and the file ──────────────────────────────────────────────

test("a mastering edit survives a save and a reload, and undoes cleanly", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const doc = new Document(parseTaud(bytes));
  const undo = new UndoStack(doc);
  assert.ok(isDefaultMastering(doc.mastering(0)), "a fresh project has no chain");

  const p = cloneMastering(doc.mastering(0));
  p.on = true; p.limOn = true; p.limCeilingDb = -1.5; p.compOn = true; p.compRatio = 3;
  undo.apply(setMasteringOp(0, doc.masteringPayloadWith(0, p), null));
  assert.ok(masteringEqual(doc.mastering(0), p));
  assert.ok(doc.projSections.some((s) => s.fourcc === MASTERING_FOURCC));

  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.ok(masteringEqual(reloaded.mastering(0), p), "the section survives the container");
  assert.ok(masteringEqual(parseTaud(doc.toBytes()).songs[0].mastering, p),
    "…and rides on the parsed song record, for players that never build a Document");

  undo.undo();
  assert.ok(isDefaultMastering(doc.mastering(0)));
  assert.equal(doc.projSections.some((s) => s.fourcc === MASTERING_FOURCC), false,
    "undoing the first edit removes the section again");
  undo.redo();
  assert.ok(masteringEqual(doc.mastering(0), p));
});

test("a song with no section still reports a chain, and it is the neutral one", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const doc = new Document(parseTaud(bytes));
  assert.ok(doc.mastering(5) !== null);
  assert.ok(isDefaultMastering(doc.mastering(5)));
});

// ── the engine end to end ───────────────────────────────────────────────────

test("the engine honours the chain a song declares", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const render = (mastering) => {
    setRandomSource(makeSeededRandom(5));
    const doc = parseTaud(bytes);
    doc.songs[0].mastering = mastering;
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    return renderSong(eng, 6).f32;
  };
  const plain = render(null);
  const p = normaliseMastering({ on: true, outGainDb: -6 });
  const quiet = render(p);
  let sumA = 0, sumB = 0;
  for (let i = 0; i < plain.length; i++) { sumA += plain[i] * plain[i]; sumB += quiet[i] * quiet[i]; }
  const drop = 10 * Math.log10(sumB / sumA);
  assert.ok(Math.abs(drop - (-6)) < 0.05, `an output gain of −6 dB drops the render by ${drop.toFixed(3)}`);
  setRandomSource(null);
});

test("a transport reset clears the chain's state", () => {
  const p = defaultMastering();
  p.on = true; p.compOn = true; p.compThreshDb = -40; p.compRatio = 8; p.compReleaseMs = 2000;
  const chain = new MasterChain(p, SAMPLING_RATE);
  const loud = new Float32Array(2048).fill(0.9);
  chain.process(loud, Float32Array.from(loud), 2048);
  assert.ok(chain.comp.grDb < -5, "the compressor is holding reduction");
  chain.reset();
  assert.equal(chain.comp.grDb, 0);
  assert.equal(chain.compGrDb, 0);
});

// ── the metering tap ────────────────────────────────────────────────────────

test("the metering tap measures both sides of the chain", () => {
  // Pinned to the device's own depth so the census assertions below are about
  // the dithered U8 buffer; the 16-bit path has its own tests.
  const tap = new MasterMeterTap(SAMPLING_RATE, { scramble: true, bitDepth: 8 });
  const n = 1024;
  const pre = new Float32Array(n).fill(0.8);
  const post = new Float32Array(n).fill(0.4);
  tap.push(TAP_PRE, pre, pre, n);
  tap.push(TAP_POST, post, post, n);
  tap.binOutput(new Uint8Array(n * 2).fill(200), post, post, n);
  const r = tap.drain(makeMasterMeterReadout());
  assert.equal(r.frames, n, "only the post pass counts frames");
  assert.ok(Math.abs(r.peak[TAP_PRE * 2] - 0.8) < 1e-6);
  assert.ok(Math.abs(r.peak[TAP_POST * 2] - 0.4) < 1e-6);
  assert.ok(r.sumZ[TAP_PRE] > r.sumZ[TAP_POST], "the louder side has more K-weighted energy");
  assert.ok(r.apSumSq[TAP_POST] > 0, "the scrambled measurement ran");
  assert.equal(r.hist[200], n * 2, "the histogram binned the delivered codes");
  const after = tap.drain(makeMasterMeterReadout());
  assert.equal(after.frames, 0, "a drain resets the interval");
  assert.equal(after.hist[200], n * 2, "…but the histogram is cumulative");
  tap.resetAll();
  assert.equal(tap.hist[200], 0);
});

// ── which output the bit census describes ───────────────────────────────────

test("the 8-bit census bins the dithered device codes", () => {
  const tap = new MasterMeterTap(SAMPLING_RATE, { bitDepth: 8 });
  assert.equal(tap.hist.length, 256);
  const n = 64;
  const u8 = new Uint8Array(n * 2).fill(200);
  // The float pair is deliberately somewhere else: at 8 bits the census must
  // read the DITHERED buffer, not re-quantise the bus.
  const f = new Float32Array(n).fill(0.5);
  tap.binOutput(u8, f, f, n);
  assert.equal(tap.hist[200], n * 2);
  assert.equal(tap.hist[Math.round(0.5 * 127.5) + 128], 0);
});

test("the 16-bit census repeats exactly what the WAV encoder writes", () => {
  const tap = new MasterMeterTap(SAMPLING_RATE, { bitDepth: 16 });
  assert.equal(tap.hist.length, 65536);
  const values = [0, 0.5, -0.25, 1, -1, 2, -3];
  const l = Float32Array.from(values);
  const n = values.length;
  // Same buffer both sides; the U8 argument must be ignored at this depth.
  tap.binOutput(new Uint8Array(n * 2).fill(7), l, l, n);
  for (const v of values) {
    const clamped = Math.max(-1, Math.min(1, v));
    const code = Math.round(clamped * 32767) + 32768;  // encodeWav's own rule
    assert.ok(tap.hist[code & 0xffff] >= 2, `${v} → code ${code}`);
  }
  assert.equal(tap.hist[7], 0, "the device buffer was not consulted");
});

test("the drain reports exact figures and a 256-bucket picture at either depth", () => {
  for (const depth of BIT_DEPTHS) {
    const tap = new MasterMeterTap(SAMPLING_RATE, { bitDepth: depth });
    const n = 512;
    const l = new Float32Array(n);
    const u8 = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      l[i] = Math.fround(0.4 * Math.sin((2 * Math.PI * 220 * i) / SAMPLING_RATE));
      u8[i * 2] = u8[i * 2 + 1] = 128 + Math.round(l[i] * 100);
    }
    tap.binOutput(u8, l, l, n);
    const r = tap.drain(makeMasterMeterReadout());
    assert.equal(r.bitDepth, depth);
    assert.equal(r.buckets.length, HIST_BUCKETS, "the wire always carries 256");
    assert.equal(r.bits.total, n * 2);
    // The buckets are the census's top eight bits, so they add back up.
    let bucketTotal = 0;
    for (let i = 0; i < HIST_BUCKETS; i++) bucketTotal += r.buckets[i];
    assert.equal(bucketTotal, r.bits.total);
    // …and the figures are taken at full resolution, so a 16-bit run reports
    // more distinct codes than 256 buckets could ever show.
    assert.ok(r.bits.used > 0 && r.bits.used <= (1 << depth));
    if (depth === 16) assert.ok(r.bits.used > HIST_BUCKETS, `used ${r.bits.used}`);
    assert.ok(Math.abs(r.bits.effectiveBits - Math.log2(r.bits.span)) < 1e-12);
  }
});

test("bitUsage reads a census of any depth", () => {
  const h = new Float64Array(65536);
  h[32768 - 1000] = 5;
  h[32768 + 1000] = 5;
  const u = bitUsage(h, 16);
  assert.equal(u.used, 2);
  assert.equal(u.span, 2001);
  assert.equal(u.total, 10);
  assert.ok(Math.abs(u.entropyBits - 1) < 1e-12, "two equally likely codes carry one bit");
  assert.ok(Math.abs(u.effectiveBits - Math.log2(2001)) < 1e-12);
  assert.equal(bitUsage(new Float64Array(65536), 16).used, 0);
});

test("the offline analysis takes its census at the depth it was asked for", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const run = async (bitDepth) => {
    setRandomSource(makeSeededRandom(3));
    return analyseSongAsync(parseTaud(bytes), 0, 6, { bitDepth });
  };
  const wide = await run(16);
  const narrow = await run(8);
  assert.equal(wide.bitDepth, 16);
  assert.equal(narrow.bitDepth, 8);
  assert.equal(wide.histogram.length, HIST_BUCKETS);
  assert.equal(narrow.histogram.length, HIST_BUCKETS);
  assert.equal(wide.bits.total, narrow.bits.total, "the same render, counted twice");
  assert.ok(wide.bits.used > narrow.bits.used,
    `16-bit sees more codes: ${wide.bits.used} vs ${narrow.bits.used}`);
  assert.ok(narrow.bits.used <= 256);
  assert.ok(wide.bits.effectiveBits > narrow.bits.effectiveBits + 4,
    `${wide.bits.effectiveBits} vs ${narrow.bits.effectiveBits}`);
  // The default is the WAV export's depth.
  assert.equal(DEFAULT_BIT_DEPTH, 16);
  setRandomSource(null);
});

test("the tap does not move a single sample", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const render = (meter) => {
    setRandomSource(makeSeededRandom(11));
    const doc = parseTaud(bytes);
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    if (meter) eng.setMasterMeter(0, true, true);
    return renderSong(eng, 5).u8;
  };
  assert.deepEqual(Array.from(render(true)), Array.from(render(false)));
  setRandomSource(null);
});

// ── the offline analysis, and the measure-and-set arithmetic ────────────────

test("the offline analysis measures the render it makes", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  setRandomSource(makeSeededRandom(3));
  const doc = parseTaud(bytes);
  const a = await analyseSongAsync(doc, 0, 10);
  assert.ok(a.seconds > 9, `rendered ${a.seconds}s`);
  assert.equal(a.hopSec, FRAME_SEC);
  assert.ok(a.post.shortTermLufs.length > 50, "a series over the time axis");
  assert.ok(Number.isFinite(a.post.integratedLufs));
  assert.ok(a.histogram.length === HIST_BUCKETS && a.bits.used > 32, "the code census filled");
  // With no chain the two sides are the same measurement.
  assert.ok(Math.abs(a.pre.integratedLufs - a.post.integratedLufs) < 0.01);
  setRandomSource(null);
});

test("measure-and-set lands the render on the target it was given", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  const analyse = async (mastering) => {
    setRandomSource(makeSeededRandom(3));
    const doc = parseTaud(bytes);
    doc.songs[0].mastering = mastering;
    return analyseSongAsync(doc, 0, 10);
  };
  const first = await analyse(null);

  const p = normaliseMastering({ on: true });
  p.outGainDb = gainForTruePeak(first, -3, 0);
  assert.ok(p.outGainDb !== null);
  const tuned = await analyse(normaliseMastering(p));
  assert.ok(Math.abs(tuned.post.truePeakDb - (-3)) < 0.2,
    `true peak landed at ${tuned.post.truePeakDb.toFixed(3)} dBTP`);

  const q = normaliseMastering({ on: true });
  q.outGainDb = gainForLoudness(first, -20, 0);
  const loudTuned = await analyse(normaliseMastering(q));
  assert.ok(Math.abs(loudTuned.post.integratedLufs - (-20)) < 0.2,
    `loudness landed at ${loudTuned.post.integratedLufs.toFixed(3)} LUFS`);

  // The trim helper answers about the chain's PROCESSING input, which the pre
  // tap sits upstream of — so the target is the pre reading plus the trim.
  const trim = trimForLoudness(first, -18);
  assert.ok(Math.abs(first.pre.integratedLufs + trim - (-18)) < 1e-6, String(trim));
  const r = normaliseMastering({ on: true, trimDb: trim, outGainDb: -trim });
  const trimmed = await analyse(r);
  assert.ok(Math.abs(trimmed.post.integratedLufs - first.post.integratedLufs) < 0.05,
    "…and a trim undone by the output gain leaves the master where it was");
  setRandomSource(null);
});

test("the offline analysis sees what the chain did", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  setRandomSource(makeSeededRandom(3));
  const doc = parseTaud(bytes);
  doc.songs[0].mastering = normaliseMastering({
    on: true, trimDb: 12, limOn: true, limTruePeak: true, limCeilingDb: -24,
  });
  const a = await analyseSongAsync(doc, 0, 10);
  assert.ok(a.post.truePeakDb <= -24 + 0.01, `post ${a.post.truePeakDb.toFixed(3)} dBTP`);
  // The pre tap sits upstream of the whole chain, so it reads the untouched
  // mix — well above the ceiling the limiter is holding.
  assert.ok(a.pre.truePeakDb > a.post.truePeakDb + 6,
    `pre ${a.pre.truePeakDb.toFixed(2)} vs post ${a.post.truePeakDb.toFixed(2)}`);
  assert.ok(a.post.integratedLufs < a.pre.integratedLufs,
    "…and the master came out quieter than the mix it was given");
  // The crest gap is a signed reading, not a magnitude: phase scrambling can
  // lower a crest as well as raise one. Only its SIZE means anything.
  assert.ok(Number.isFinite(a.post.crestGapDb) && Number.isFinite(a.pre.crestGapDb));
  setRandomSource(null);
});

test("dbfs floors rather than returning −Infinity", () => {
  assert.equal(dbfs(0), -144);
  assert.ok(Math.abs(dbfs(0.5) - (-6.0206)) < 1e-3);
  assert.equal(crestDb(0, 0), 0);
});

// ── the EQ bands start engaged ───────────────────────────────────────────────

test("the four EQ bands are on by default and flat, so they change nothing", () => {
  const d = defaultMastering();
  assert.ok(d.eq.every((b) => b.on), "every band starts engaged");
  assert.ok(d.eq.every((b) => b.gainDb === 0), "…at 0 dB");
  assert.equal(d.eqOn, false, "…under an equaliser that is still switched off");
  assert.equal(masteringEngaged(d), false, "so an untouched chain is still absent");
  assert.ok(isDefaultMastering(d), "…and still writes no section");

  // Switched on and left flat, the cascade has to be inaudible.
  const p = defaultMastering();
  p.on = true; p.eqOn = true;
  const chain = new MasterChain(p, SAMPLING_RATE);
  for (const f of [30, 100, 440, 1000, 5000, 15000]) {
    assert.ok(Math.abs(chain.responseDb(f)) < 1e-9, `${f} Hz: ${chain.responseDb(f)}`);
  }
  const src = testSignal(4096);
  const { l } = runChain(p, src, src);
  let worst = 0;
  for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(l[i] - src[i]));
  assert.ok(worst < 1e-9, `worst deviation ${worst}`);
});

// ── the shared spectrum machinery ───────────────────────────────────────────

test("the band analyser puts a tone in the band it belongs to", () => {
  const ba = new BandAnalyser(SAMPLING_RATE);
  const n = SAMPLING_RATE;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * 1000 * i) / SAMPLING_RATE);
  let last = null, frames = 0;
  ba.push(sig, 0, n, (b) => { last = Float64Array.from(b); frames++; });
  assert.ok(frames > 80, `${frames} windows from a second of audio`);
  // 1 kHz sits in band 2 (800 Hz–2 kHz); a full-scale sine's mean square is 0.5.
  assert.ok(Math.abs(10 * Math.log10(last[2]) - -3.01) < 0.05, `band 2: ${last[2]}`);
  for (const b of [0, 1, 3, 4]) {
    assert.ok(10 * Math.log10(last[b] + 1e-30) < -60, `band ${b} leaked: ${last[b]}`);
  }
});

test("…and its answer does not depend on how the samples arrive", () => {
  const run = (block) => {
    const ba = new BandAnalyser(SAMPLING_RATE);
    const n = SAMPLING_RATE / 2;
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * 300 * i) / SAMPLING_RATE);
    const rows = [];
    for (let o = 0; o < n; o += block) {
      ba.push(sig, o, Math.min(block, n - o), (b) => rows.push(Float64Array.from(b)));
    }
    return rows;
  };
  const a = run(128), b = run(1000);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < SPECTRUM_NBANDS; k++) assert.equal(a[i][k], b[i][k]);
  }
});

test("SPECTRUM_BANDS covers the audible range without gaps or overlaps", () => {
  assert.equal(SPECTRUM_NBANDS, 5);
  for (let i = 1; i < SPECTRUM_NBANDS; i++) {
    assert.equal(SPECTRUM_BANDS[i].lo, SPECTRUM_BANDS[i - 1].hi);
  }
  assert.equal(SPECTRUM_BANDS[0].lo, 20);
  assert.equal(SPECTRUM_BANDS[SPECTRUM_NBANDS - 1].hi, 20000);
});

test("spectrumDb reads a ring backwards from a write cursor", () => {
  const n = 256;
  const fft = new Fft(n);
  const { win, sumSq } = hannWindow(n);
  const norm = 1 / ((n / 2) * sumSq);
  const ring = new Float32Array(n);
  // A bin-centred tone, written with the cursor part way round the ring.
  const bin = 20;
  const write = 91;
  for (let i = 0; i < n; i++) {
    ring[(write + i) % n] = Math.fround(Math.sin((2 * Math.PI * bin * i) / n));
  }
  const out = new Float64Array(n >> 1);
  spectrumDb(fft, win, norm, ring, write, out);
  let peak = -Infinity, at = -1;
  for (let k = 1; k < out.length; k++) if (out[k] > peak) { peak = out[k]; at = k; }
  assert.equal(at, bin, `peak landed at bin ${at}`);
  // A Hann-windowed tone spreads over about three bins, so no single one holds
  // the whole −3.01 dB — but their sum does, which is what Parseval buys.
  let power = 0;
  for (let k = bin - 2; k <= bin + 2; k++) power += 10 ** (out[k] / 10);
  assert.ok(Math.abs(10 * Math.log10(power) - -3.01) < 0.1,
    `summed lobe ${(10 * Math.log10(power)).toFixed(3)} dB`);
});

test("the tap keeps a mono spectrum ring for each stage", () => {
  const tap = new MasterMeterTap(SAMPLING_RATE);
  const n = 300;
  const loud = new Float32Array(n).fill(0.5);
  const quiet = new Float32Array(n).fill(0.1);
  tap.push(TAP_PRE, loud, loud, n);
  tap.push(TAP_POST, quiet, quiet, n);
  const r = tap.drain(makeMasterMeterReadout());
  assert.equal(r.specWrite, n, "the cursor advances once per block, not twice");
  assert.equal(r.spec[TAP_PRE].length, SPEC_FRAMES);
  assert.ok(Math.abs(r.spec[TAP_PRE][0] - 0.5) < 1e-6);
  assert.ok(Math.abs(r.spec[TAP_POST][0] - 0.1) < 1e-6);
  assert.equal(r.spec[TAP_PRE][n], 0, "…and stops where the block did");
  tap.resetAll();
  assert.equal(tap.specWrite, 0);
});

test("the offline analysis carries a spectral column per frame", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  setRandomSource(makeSeededRandom(3));
  const a = await analyseSongAsync(parseTaud(bytes), 0, 8);
  const nb = a.post.bandCount;
  assert.equal(nb, SPECTRUM_NBANDS);
  const frames = a.post.bandSeries.length / nb;
  assert.ok(frames > 50, `${frames} columns`);
  assert.equal(frames, a.post.peakSeriesDb.length, "one column per 100 ms frame");
  let sounding = 0;
  for (let i = 0; i < frames; i++) {
    let total = 0;
    for (let b = 0; b < nb; b++) total += a.post.bandSeries[i * nb + b];
    if (total > 0) sounding++;
  }
  assert.ok(sounding > frames * 0.5, `${sounding}/${frames} columns carry energy`);
  setRandomSource(null);
});

// ── the display tilt ────────────────────────────────────────────────────────

test("the display tilt is the pink slope, pivoting at 1 kHz", () => {
  assert.equal(SPECTRUM_TILT_DB_PER_OCT, 3);
  assert.equal(SPECTRUM_TILT_PIVOT_HZ, 1000);
  assert.equal(tiltDbAt(1000), 0, "the pivot is untouched");
  assert.ok(Math.abs(tiltDbAt(2000) - 3) < 1e-12, "an octave up is +3 dB");
  assert.ok(Math.abs(tiltDbAt(500) - -3) < 1e-12, "…and an octave down is −3");
  assert.ok(Math.abs(tiltDbAt(16000) - 12) < 1e-12, "four octaves up is +12");
  assert.equal(tiltDbAt(0), 0, "DC has no octave to be tilted by");

  const w = tiltWeights(2048, 48000);
  assert.equal(w[0], 0, "…and no weight either");
  // The weights are POWER, so +3 dB of level is ×2 of energy. Compare two bins
  // that are EXACTLY an octave apart — k and 2k — rather than the bins nearest
  // 1 and 2 kHz, which are not (a bin is 23.4 Hz wide).
  for (const k of [16, 64, 300]) {
    assert.ok(Math.abs(10 * Math.log10(w[2 * k] / w[k]) - 3) < 1e-9,
      `bins ${k}→${2 * k}: ${10 * Math.log10(w[2 * k] / w[k])}`);
  }
});

test("a tilted band analysis lifts the top of the band and nothing else", () => {
  const n = SAMPLING_RATE * 2;
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const white = new Float64Array(n);
  for (let i = 0; i < n; i++) white[i] = rnd();
  const measure = (tiltDbPerOct) => {
    const ba = new BandAnalyser(SAMPLING_RATE, { tiltDbPerOct });
    const acc = new Float64Array(SPECTRUM_NBANDS);
    let frames = 0;
    ba.push(white, 0, n, (b) => {
      for (let i = 0; i < SPECTRUM_NBANDS; i++) acc[i] += b[i];
      frames++;
    });
    return [...acc].map((v) => 10 * Math.log10(v / frames));
  };
  const flat = measure(0);
  const tilted = measure(SPECTRUM_TILT_DB_PER_OCT);
  // White noise: the tilt moves each band by the mean of +3·log2(f/1kHz) over
  // its bins — down at the bottom of the range, up at the top, monotonically.
  const delta = tilted.map((v, i) => v - flat[i]);
  for (let i = 1; i < SPECTRUM_NBANDS; i++) {
    assert.ok(delta[i] > delta[i - 1], `band ${i} moved less than ${i - 1}: ${delta}`);
  }
  assert.ok(delta[0] < -6, `the bottom band comes down: ${delta[0].toFixed(2)} dB`);
  assert.ok(delta[SPECTRUM_NBANDS - 1] > 6,
    `the top band goes up: ${delta[SPECTRUM_NBANDS - 1].toFixed(2)} dB`);
  // Untilted is still an honest measurement — the default.
  assert.equal(new BandAnalyser(SAMPLING_RATE).tilt, null);
});

test("the offline analysis declares the tilt it drew with", async () => {
  const bytes = new Uint8Array(await readFile(corpusDir + "4THSYM.taud"));
  setRandomSource(makeSeededRandom(3));
  const a = await analyseSongAsync(parseTaud(bytes), 0, 6);
  assert.equal(a.post.bandTiltDbPerOct, SPECTRUM_TILT_DB_PER_OCT);
  setRandomSource(null);
});

// ── the multichannel master (item 178.1) ────────────────────────────────────
// The same chain, as wide as the delivery. Everything below is a statement out
// of engine spec §12.3 turned into a measurement.

/** `nch` channels of decorrelated dense material, channel-major, Float64. */
function planarSignal(nch, frames, gain = 1) {
  const d = new Float64Array(nch * frames);
  for (let c = 0; c < nch; c++) {
    const sig = testSignal(frames, gain);
    // Detune each channel so the linked detector has something to disagree
    // about — identical channels would make every test below trivially true.
    const k = 1 + c * 0.37;
    for (let n = 0; n < frames; n++) d[c * frames + n] = sig[n] * (0.4 + 0.15 * c) * k;
  }
  return d;
}

/** A chain with the static stages doing real work and no dynamics. */
function staticParams() {
  const p = defaultMastering();
  p.on = true;
  p.trimDb = -3.5;
  p.outGainDb = 2.25;
  p.hpOn = true; p.hpFreq = 60; p.hpSlope = HP_SLOPE_24;
  p.eqOn = true;
  p.eq[0] = { on: true, type: EQ_LOW_SHELF, freq: 120, gainDb: 4, q: 0.7 };
  p.eq[1] = { on: true, type: EQ_PEAKING, freq: 800, gainDb: -5, q: 1.4 };
  p.eq[2] = { on: false, type: EQ_PEAKING, freq: 3000, gainDb: 0, q: 1 };
  p.eq[3] = { on: true, type: EQ_HIGH_SHELF, freq: 9000, gainDb: 3, q: 0.7 };
  return normaliseMastering(p);
}

test("a multichannel master filters every channel identically", () => {
  const p = staticParams();
  const nch = 6, frames = 4096;
  const bus = planarSignal(nch, frames);
  const want = Float64Array.from(bus);

  new MasterChain(p, SAMPLING_RATE, nch).processPlanar(bus, frames, frames);
  // The claim is not "similar": one channel through a one-channel chain has to
  // be the SAME arithmetic, because identical coefficients on independent
  // delay lines is all the wide chain is.
  for (let c = 0; c < nch; c++) {
    const one = want.slice(c * frames, (c + 1) * frames);
    new MasterChain(p, SAMPLING_RATE, 1).processPlanar(one, frames, frames);
    for (let n = 0; n < frames; n++) {
      assert.equal(bus[c * frames + n], one[n], `channel ${c}, frame ${n}`);
    }
  }
});

test("…and its result does not depend on how the bus arrives", () => {
  const p = staticParams();
  p.compOn = true; p.compThreshDb = -18; p.compRatio = 4; p.compKneeDb = 6;
  p.limOn = true; p.limCeilingDb = -1;
  const nch = 4, frames = 2048;
  const src = planarSignal(nch, frames, 1.6);

  const runBlocked = (block) => {
    const bus = Float64Array.from(src);
    const chain = new MasterChain(p, SAMPLING_RATE, nch);
    // A block-at-a-time run over a channel-major buffer is a run over the
    // sub-buffer at each offset, with the stride unchanged.
    for (let o = 0; o < frames; o += block) {
      const n = Math.min(block, frames - o);
      chain.processPlanar(bus.subarray(o), n, frames);
    }
    return bus;
  };
  const whole = runBlocked(frames);
  for (const block of [128, 512, 37]) {
    const got = runBlocked(block);
    for (let i = 0; i < got.length; i++) {
      assert.equal(got[i], whole[i], `block ${block}, sample ${i}`);
    }
  }
});

test("the stereo width stage is skipped on a multichannel bus", () => {
  const p = defaultMastering();
  p.on = true; p.widthOn = true; p.width = 2;
  assert.equal(masteringEngaged(p), true, "width alone still engages the chain");

  // On the pair it is the whole point of the stage…
  const src = testSignal(512);
  const other = testSignal(512, 0.6);
  const { l, r } = runChain(p, src, other);
  let moved = 0;
  for (let i = 0; i < src.length; i++) moved = Math.max(moved, Math.abs(l[i] - src[i]));
  assert.ok(moved > 0.01, `the pair widened: ${moved}`);
  assert.ok(r.some((v, i) => v !== other[i]));

  // …and on a bus it is not defined, so the chain has nothing left to do.
  for (const nch of [2, 4, 6, 16]) {
    const bus = planarSignal(nch, 512);
    const want = Float64Array.from(bus);
    new MasterChain(p, SAMPLING_RATE, nch).processPlanar(bus, 512, 512);
    for (let i = 0; i < bus.length; i++) {
      assert.equal(bus[i], want[i], `${nch} channels, sample ${i}`);
    }
  }
});

test("one detector drives the whole sound field", () => {
  // Two channels that are the same signal 6 dB apart. Only linked dynamics
  // keep them 6 dB apart: a detector per channel would compress the loud one
  // harder and the ratio between them would move — which, on a speaker layout,
  // is the image walking across the room.
  const p = defaultMastering();
  p.on = true; p.trimDb = 6;
  p.compOn = true; p.compThreshDb = -24; p.compRatio = 8;
  p.compAttackMs = 2; p.compReleaseMs = 80; p.compKneeDb = 6;
  // Make-up puts back what the ratio took, which is what leaves the limiter
  // something to do — without it the compressor alone ducks under the ceiling.
  p.compMakeupDb = 12;
  p.limOn = true; p.limCeilingDb = -0.5; p.limReleaseMs = 40;

  const frames = 8192;
  const loud = testSignal(frames, 1.4);
  const bus = new Float64Array(2 * frames);
  for (let n = 0; n < frames; n++) {
    bus[n] = loud[n];
    bus[frames + n] = loud[n] * 0.5; // exact: a power of two
  }
  const chain = new MasterChain(normaliseMastering(p), SAMPLING_RATE, 2);
  chain.processPlanar(bus, frames, frames);

  let touched = false;
  for (let n = 0; n < frames; n++) {
    assert.equal(bus[frames + n], bus[n] * 0.5, `frame ${n} lost the ratio`);
    if (bus[n] !== loud[n] * dbToGain(6)) touched = true;
  }
  assert.ok(touched, "the dynamics did have work to do");
  assert.ok(chain.compGrDb < -1, `the compressor moved: ${chain.compGrDb}`);
  assert.ok(chain.limGrDb < 0, `the limiter moved: ${chain.limGrDb}`);
});

test("the limiter's ceiling holds on every channel of a multichannel bus", () => {
  for (const truePeak of [false, true]) {
    for (const nch of [4, 6, 16]) {
      const p = defaultMastering();
      p.on = true;
      p.trimDb = 18;           // drive it hard enough that the promise matters
      p.limOn = true; p.limCeilingDb = -1; p.limReleaseMs = 50;
      p.limTruePeak = truePeak;
      const frames = 8192;
      const bus = planarSignal(nch, frames, 1.0);
      // …plus a bare transient on one channel: a step into full scale is what
      // a moving average alone would let through.
      for (let n = 2000; n < 2200; n++) bus[2 * frames + n] = n % 2 ? 0.98 : -0.98;

      const chain = new MasterChain(normaliseMastering(p), SAMPLING_RATE, nch);
      chain.processPlanar(bus, frames, frames);

      const ceiling = dbToGain(-1);
      let worst = 0;
      for (let i = 0; i < bus.length; i++) worst = Math.max(worst, Math.abs(bus[i]));
      assert.ok(worst <= ceiling + 1e-12,
        `${nch}ch truePeak=${truePeak}: ${worst} over ${ceiling}`);
      assert.ok(worst > ceiling * 0.5, "…and the material really did reach for it");
    }
  }
});

test("a multichannel chain declares the same latency as the pair", () => {
  const p = defaultMastering();
  p.on = true; p.limOn = true;
  const d = Math.round((LIMITER_LOOKAHEAD_MS / 1000) * SAMPLING_RATE);
  for (const nch of [1, 2, 6, 16]) {
    const chain = new MasterChain(normaliseMastering(p), SAMPLING_RATE, nch);
    assert.equal(chain.latency, 2 * d, `${nch} channels`);
  }
  // …and every channel is delayed by it, not just the first.
  const nch = 6, frames = 1024;
  const bus = new Float64Array(nch * frames);
  for (let c = 0; c < nch; c++) bus[c * frames + 100] = 0.25;
  new MasterChain(normaliseMastering(p), SAMPLING_RATE, nch)
    .processPlanar(bus, frames, frames);
  for (let c = 0; c < nch; c++) {
    assert.equal(bus[c * frames + 100 + 2 * d], 0.25, `channel ${c} arrival`);
    assert.equal(bus[c * frames + 100], 0, `channel ${c} left nothing behind`);
  }
});

test("process() refuses a bus that is not the pair", () => {
  const p = defaultMastering();
  p.on = true; p.trimDb = -3;
  const chain = new MasterChain(normaliseMastering(p), SAMPLING_RATE, 6);
  assert.throws(() => chain.process(new Float32Array(8), new Float32Array(8), 8),
    /processPlanar/);
});

test("a neutral chain is skipped on a multichannel bus too", () => {
  const chain = new MasterChain(defaultMastering(), SAMPLING_RATE, 6);
  assert.equal(chain.engaged, false);
  const bus = planarSignal(6, 256);
  const want = Float64Array.from(bus);
  chain.processPlanar(bus, 256, 256);
  for (let i = 0; i < bus.length; i++) assert.equal(bus[i], want[i]);
});
