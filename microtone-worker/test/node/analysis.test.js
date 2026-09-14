// Master-strip analysis tap (item 98) — the maths behind the meters and the
// vectorscopes, plus the guard that matters most: the tap is a TAP. Turning it
// on must not move a single sample of the mix.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ANALYSIS_OFF, ANALYSIS_STEREO, ANALYSIS_AMBISONIC,
  ANALYSIS_MAX_METERS, SCOPE_FRAMES, SCOPE_CHANNELS, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
  METER_MIX, METER_FOA, METER_SPEAKERS,
  AnalysisTap, AnalysisRenderer, TruePeakDetector,
  availableTargets, meterLabels, meterDisplay, makeAnalysisReadout,
} from "../../src/engine/analysis.js";
import {
  SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL, SpatialBus,
} from "../../src/engine/spatial.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../src/engine/constants.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { loadIntoEngine, renderSong } from "../../src/audio/offline-render.js";
import {
  dbfs, meterFrac, correlation, availableScopes, effectiveScopes, SCOPE_KINDS,
  scopeAxes, scopeLabels, blobView, radView, MeterBallistics, RMS_SLOW_MS,
  scopePanelHeight, scopePanelsThatFit, parseInk,
  slewTowards, integrateCorrelation, SCOPE_GAIN_SLEW_MS, CORR_INTEGRATE_MS,
  scopeAutoGain, SCOPE_GAIN_FILL, SCOPE_GAIN_HEADROOM, SCOPE_GAIN_MAX,
  METER_MIN_DB, SCOPE_BLOBS, SCOPE_BLOBS_FRONT, SCOPE_BLOBS_SIDE,
  SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE,
  SCOPE_RAD, SCOPE_RAD_FRONT, SCOPE_RAD_SIDE,
  SCOPE_CLOUD, SCOPE_CLOUD_FRONT, SCOPE_CLOUD_SIDE,
  SCOPE_SELECT_H, SCOPE_CORR_H, SPLIT_H, MAX_SCOPE_PANELS,
} from "../../src/ui/views/masterstrip.js";

const corpusDir = new URL("../corpus/", import.meta.url).pathname;

/**
 * Push `frames` samples through a tap the way the mixer does — the object bus
 * is ONE chunk deep, so anything longer has to be fed a chunk at a time — and
 * drain it. `fill(tap, mixL, mixR, n, frame0)` writes one chunk.
 */
function feed(tap, frames, fill) {
  const mixL = new Float32Array(TRACKER_CHUNK);
  const mixR = new Float32Array(TRACKER_CHUNK);
  for (let f0 = 0; f0 < frames; f0 += TRACKER_CHUNK) {
    const n = Math.min(TRACKER_CHUNK, frames - f0);
    mixL.fill(0);
    mixR.fill(0);
    tap.begin();
    fill(tap, mixL, mixR, n, f0);
    tap.finish(n, mixL, mixR);
  }
  return tap.drain(makeAnalysisReadout());
}

/** A 400 Hz plane wave from (az, el), written straight into the tap's bus. */
function planeWave(az, el, amp = 1) {
  let gains = null;
  return (tap, mixL, mixR, n, f0) => {
    const bus = tap.bus;
    if (gains === null) {
      gains = new Float64Array(bus.numChannels);
      bus.renderer.channelGains(az, el, gains, 0);
    }
    for (let i = 0; i < n; i++) {
      bus.addSource(i, amp * Math.sin((2 * Math.PI * 400 * (f0 + i)) / 32000), gains, 0, 1.0);
    }
  };
}

// ── the ambisonic reading ──────────────────────────────────────────────────

test("field energy is the same from every direction (SN3D order 1)", () => {
  const frames = 3200;
  const readings = [];
  for (const [az, el] of [[128, 0], [0, 0], [256, 0], [384, 0], [128, 128], [64, -64], [300, 40]]) {
    const tap = new AnalysisTap(ANALYSIS_AMBISONIC, SURROUND_SPATIAL);
    const r = feed(tap, frames, planeWave(az, el));
    readings.push(r.fieldEnergy / r.frames);
  }
  // A sine of amplitude 1 has mean square 0.5, and E = (W²+X²+Y²+Z²)/2 reads
  // exactly p² for a plane wave — so every direction lands on the same number.
  for (const e of readings) assert.ok(Math.abs(e - 0.5) < 1e-9, `energy ${e}`);
});

test("uncorrelated sources sum their energy", () => {
  const frames = 6400;
  const tap = new AnalysisTap(ANALYSIS_AMBISONIC, SURROUND_SPATIAL);
  const g1 = new Float64Array(tap.bus.numChannels);
  const g2 = new Float64Array(tap.bus.numChannels);
  tap.bus.renderer.channelGains(0, 0, g1, 0);     // hard left
  tap.bus.renderer.channelGains(256, 60, g2, 0);  // right and above
  const r = feed(tap, frames, (t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) {
      // Two different frequencies → uncorrelated over the window.
      t.bus.addSource(i, Math.sin((2 * Math.PI * 400 * (f0 + i)) / 32000), g1, 0, 1.0);
      t.bus.addSource(i, Math.sin((2 * Math.PI * 933 * (f0 + i)) / 32000), g2, 0, 1.0);
    }
  });
  assert.ok(Math.abs(r.fieldEnergy / r.frames - 1.0) < 5e-3, `${r.fieldEnergy / r.frames}`);
});

test("a planar song meters three ambisonic channels, a spatial one four", () => {
  assert.equal(new AnalysisTap(ANALYSIS_AMBISONIC, SURROUND_PLANAR).meterCount, 3);
  assert.equal(new AnalysisTap(ANALYSIS_AMBISONIC, SURROUND_SPATIAL).meterCount, 4);
  // …and the label order is the one that makes those three the live ones.
  assert.deepEqual(meterLabels(ANALYSIS_AMBISONIC), ["W", "Y", "X", "Z"]);
});

test("the ambisonic meters read the encoded channels, in label order", () => {
  const frames = 3200;
  const tap = new AnalysisTap(ANALYSIS_AMBISONIC, SURROUND_SPATIAL);
  // Straight up: W = 1·p, Z = 1·p, X = Y = 0.
  const r = feed(tap, frames, planeWave(128, 128));
  const rms = (c) => Math.sqrt(r.meanSquare[c]);
  assert.ok(Math.abs(rms(0) - Math.SQRT1_2) < 1e-6, `W ${rms(0)}`);   // W
  assert.ok(rms(1) < 1e-9, `Y ${rms(1)}`);                            // Y
  assert.ok(rms(2) < 1e-9, `X ${rms(2)}`);                            // X
  assert.ok(Math.abs(rms(3) - Math.SQRT1_2) < 1e-6, `Z ${rms(3)}`);   // Z
});

// ── the speaker targets ────────────────────────────────────────────────────

test("a speaker target meters the layout's own channels", () => {
  const tap = new AnalysisTap("5.1", SURROUND_PLANAR);
  assert.equal(tap.meterSource, METER_SPEAKERS);
  assert.equal(tap.meterCount, 6);
  // The bus carries the scope's B-format FIRST, then the speaker feeds.
  assert.equal(tap.bus.numChannels, SCOPE_CHANNELS + 6);
  assert.deepEqual(meterLabels("5.1"), ["L", "R", "C", "LFE", "Ls", "Rs"]);

  // A source at the centre speaker lands in C and nowhere else (the LFE stays
  // silent by design — speakers.js).
  const r = feed(tap, 3200, planeWave(128, 0));
  assert.ok(Math.sqrt(r.meanSquare[2]) > 0.7, `C ${r.meanSquare[2]}`);
  for (const c of [0, 1, 3, 4, 5]) {
    assert.ok(r.meanSquare[c] < 1e-12, `channel ${c} should be silent`);
  }
});

test("speaker meters are arranged like the speakers, and the LFE is not drawn", () => {
  const lab = (target) => meterDisplay(target).map((b) => b.label).join(" ");
  assert.equal(lab("quad"), "Ls L R Rs");
  assert.equal(lab("5.1"), "Ls L C R Rs");
  // Angular order: rearmost outermost, so the strip reads the way the speakers
  // stand from the left rear round to the right rear.
  assert.equal(lab("7.1"), "Lrs Lss L C R Rss Rrs");
  for (const target of ["quad", "5.1", "7.1"]) {
    assert.ok(!meterDisplay(target).some((b) => b.label === "LFE"), `${target} draws an LFE bar`);
  }

  // Each bar still points at the channel the TAP meters that speaker on — the
  // arrangement is a display order, not a re-routing.
  const engine51 = meterLabels("5.1"); // file order: L R C LFE Ls Rs
  for (const bar of meterDisplay("5.1")) {
    assert.equal(engine51[bar.channel], bar.label, `${bar.label} → channel ${bar.channel}`);
  }
  assert.deepEqual(meterDisplay("5.1").map((b) => b.channel), [4, 0, 2, 1, 5]);

  // Targets without a speaker layout keep their own order, one bar per channel.
  assert.deepEqual(meterDisplay(ANALYSIS_STEREO), [
    { label: "L", channel: 0 }, { label: "R", channel: 1 },
  ]);
  assert.deepEqual(meterDisplay(ANALYSIS_AMBISONIC).map((b) => b.label), ["W", "Y", "X", "Z"]);
});

test("a stereo song's tap needs no bus at all", () => {
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  assert.equal(tap.bus, null);
  assert.equal(tap.meterSource, METER_MIX);
  assert.equal(tap.meterCount, 2);
});

test("targets on offer follow the surround model", () => {
  assert.deepEqual(availableTargets(SURROUND_STEREO), [ANALYSIS_STEREO]);
  assert.deepEqual(availableTargets(SURROUND_PLANAR),
    [ANALYSIS_STEREO, "quad", "5.1", "7.1", ANALYSIS_AMBISONIC]);
  assert.deepEqual(availableTargets(SURROUND_SPATIAL), availableTargets(SURROUND_PLANAR));
});

// ── the stereo tap and the goniometer identity ─────────────────────────────

test("a stereo song's field is the ±90° encoding of its mix", () => {
  const frames = 512;
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  const r = feed(tap, frames, (t, mixL, mixR, n, f0) => {
    for (let i = 0; i < n; i++) {
      mixL[i] = Math.sin((2 * Math.PI * 400 * (f0 + i)) / 32000);
      mixR[i] = 0.25 * Math.sin((2 * Math.PI * 400 * (f0 + i)) / 32000);
    }
  });
  // W = (L+R)/√2 and Y = (L−R)/√2 — the mid/side pair the top view plots.
  const ring = tap.ring;
  const f0 = (r.ringWrite - frames + SCOPE_FRAMES) % SCOPE_FRAMES;
  for (let k = 1; k < 20; k++) {
    const o = ((f0 + k) % SCOPE_FRAMES) * SCOPE_CHANNELS;
    const s = Math.sin((2 * Math.PI * 400 * k) / 32000);
    assert.ok(Math.abs(ring[o + SCOPE_W] - (1.25 * s) * Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(ring[o + SCOPE_Y] - (0.75 * s) * Math.SQRT1_2) < 1e-6);
    assert.equal(ring[o + SCOPE_Z], 0);
    assert.equal(ring[o + SCOPE_X], 0);
  }
});

test("correlation: mono +1, anti-phase −1, independent ≈ 0", () => {
  const frames = 6400;
  const run = (fill) => {
    const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
    const r = feed(tap, frames, fill);
    return correlation(r.corrLL, r.corrRR, r.corrLR);
  };
  const mono = run((t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) { l[i] = Math.sin((f0 + i) * 0.1); rr[i] = Math.sin((f0 + i) * 0.1); }
  });
  const anti = run((t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) { l[i] = Math.sin((f0 + i) * 0.1); rr[i] = -Math.sin((f0 + i) * 0.1); }
  });
  const indep = run((t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) { l[i] = Math.sin((f0 + i) * 0.1); rr[i] = Math.cos((f0 + i) * 0.1); }
  });
  assert.ok(Math.abs(mono - 1) < 1e-9, `mono ${mono}`);
  assert.ok(Math.abs(anti + 1) < 1e-9, `anti ${anti}`);
  assert.ok(Math.abs(indep) < 0.02, `independent ${indep}`);
  assert.equal(correlation(0, 0, 0), 1); // silence is not a phase problem
});

// ── true peak ──────────────────────────────────────────────────────────────

test("true peak never reads below the sample peak, and finds what sits between", () => {
  const frames = 4096;
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  // A half-Nyquist sine sampled off its crest: the samples miss the top, the
  // 4× oversampler does not.
  const r = feed(tap, frames, (t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) {
      const v = 0.9 * Math.sin((2 * Math.PI * (8000 * (f0 + i) + 4000)) / 32000);
      l[i] = v;
      rr[i] = v;
    }
  });
  assert.ok(r.peak[0] < 0.9 * 0.9999, `sample peak ${r.peak[0]} should miss the crest`);
  assert.ok(r.truePeak[0] > r.peak[0], `true peak ${r.truePeak[0]} vs ${r.peak[0]}`);
  assert.ok(r.truePeak[0] > 0.85 && r.truePeak[0] < 0.95, `true peak ${r.truePeak[0]}`);
});

test("true peak of a constant is that constant (unity DC gain per branch)", () => {
  const tp = new TruePeakDetector(1);
  for (let i = 0; i < 64; i++) tp.push(0, 0.5);
  // The measurement starts once the history is steady: the step from silence
  // into the constant is itself a real inter-sample overshoot (Gibbs), and a
  // true-peak meter is supposed to report that.
  tp.clearPeaks();
  for (let i = 0; i < 8; i++) tp.push(0, 0.5);
  assert.ok(Math.abs(tp.peaks[0] - 0.5) < 1e-12, String(tp.peaks[0]));
});

test("clip counts samples at full scale", () => {
  const frames = 128;
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  const r = feed(tap, frames, (t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) { l[i] = f0 + i < 5 ? 1.0 : 0.5; rr[i] = 0.5; }
  });
  assert.equal(r.clip[0], 5);
  assert.equal(r.clip[1], 0);
});

// ── the ring ───────────────────────────────────────────────────────────────

test("the scope ring wraps and keeps the newest frames", () => {
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  const frames = SCOPE_FRAMES + 100;
  const r = feed(tap, frames, (t, l, rr, n, f0) => {
    for (let i = 0; i < n; i++) { l[i] = (f0 + i) / frames; rr[i] = (f0 + i) / frames; }
  });
  assert.equal(r.ringWrite, frames % SCOPE_FRAMES);
  // The newest frame sits just behind the write cursor.
  const newest = ((r.ringWrite - 1 + SCOPE_FRAMES) % SCOPE_FRAMES) * SCOPE_CHANNELS;
  const want = ((frames - 1) / frames) * Math.SQRT2; // W = (L+R)/√2 with L=R
  assert.ok(Math.abs(tap.ring[newest + SCOPE_W] - want) < 1e-6);
});

test("draining resets everything the UI integrates", () => {
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  feed(tap, 256, (t, l, rr, n) => { for (let i = 0; i < n; i++) { l[i] = 0.5; rr[i] = 0.5; } });
  const second = tap.drain(makeAnalysisReadout());
  assert.equal(second.frames, 0);
  assert.equal(second.peak[0], 0);
  assert.equal(second.clip[0], 0);
  assert.equal(second.fieldEnergy, 0);
});

// ── THE guard: a tap does not change the mix ───────────────────────────────

test("analysis never moves a sample of the mix", async () => {
  const doc = parseTaud(new Uint8Array(await readFile(corpusDir + "WHEN.taud")));
  const render = (model, target) => {
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    eng.setSurroundModel(0, model);
    if (target !== ANALYSIS_OFF) eng.setAnalysis(0, target);
    return renderSong(eng, 4);
  };
  for (const model of [SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL]) {
    const off = render(model, ANALYSIS_OFF);
    for (const target of [ANALYSIS_STEREO, "5.1", ANALYSIS_AMBISONIC]) {
      const on = render(model, target);
      assert.deepEqual(on.u8, off.u8, `u8 differs: model ${model}, target ${target}`);
      assert.deepEqual(on.f32, off.f32, `f32 differs: model ${model}, target ${target}`);
    }
  }
});

test("the tap can be installed and dropped mid-song", () => {
  const eng = new TaudEngine();
  const ts = eng.playheads[0].trackerState;
  assert.equal(ts.analysis, null);
  eng.setAnalysis(0, ANALYSIS_AMBISONIC);
  assert.ok(ts.analysis !== null);
  assert.equal(eng.getAnalysis(0), ANALYSIS_AMBISONIC);
  eng.setAnalysis(0, ANALYSIS_OFF);
  assert.equal(ts.analysis, null);
});

test("switching the surround model rebuilds the tap for it", () => {
  const eng = new TaudEngine();
  eng.setAnalysis(0, ANALYSIS_AMBISONIC);
  assert.equal(eng.playheads[0].trackerState.analysis.bus, null); // stereo song
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  const tap = eng.playheads[0].trackerState.analysis;
  assert.ok(tap.bus !== null, "a spatial song encodes from the voices");
  assert.equal(tap.meterCount, 4);
});

// ── the strip's own display maths ──────────────────────────────────────────

test("dBFS and the meter scale", () => {
  assert.ok(Math.abs(dbfs(1) - 0) < 1e-12);
  assert.ok(Math.abs(dbfs(0.5) + 6.0206) < 1e-3);
  assert.equal(dbfs(0), METER_MIN_DB - 1);
  assert.equal(meterFrac(METER_MIN_DB - 20), 0);
  assert.equal(meterFrac(999), 1);
  assert.ok(meterFrac(0) > meterFrac(-6));
});

test("scopes on offer, and their axes", () => {
  // A stereo or planar song has no height, so only the top of each family
  // survives — the radiation monitor's included: with no Z it is a figure of
  // revolution about the left-right axis, which is still a reading.
  assert.deepEqual(availableScopes(SURROUND_STEREO),
    [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD]);
  assert.deepEqual(availableScopes(SURROUND_PLANAR),
    [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD]);
  // Spatial: all four families, three planes each, each family whole.
  assert.deepEqual(availableScopes(SURROUND_SPATIAL),
    [SCOPE_BLOBS, SCOPE_BLOBS_FRONT, SCOPE_BLOBS_SIDE, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE,
      SCOPE_RAD, SCOPE_RAD_FRONT, SCOPE_RAD_SIDE,
      SCOPE_CLOUD, SCOPE_CLOUD_FRONT, SCOPE_CLOUD_SIDE]);

  // A stereo song's top view is the mid/side goniometer; a surround song's is
  // left-right against front-back.
  assert.deepEqual(scopeAxes(SCOPE_TOP, true).v, SCOPE_W);
  assert.deepEqual(scopeAxes(SCOPE_TOP, false).v, SCOPE_X);
  assert.equal(scopeAxes(SCOPE_TOP, true).h, SCOPE_Y);
  assert.equal(scopeAxes(SCOPE_FRONT, false).v, SCOPE_Z);
  assert.equal(scopeAxes(SCOPE_SIDE, false).h, SCOPE_X);
  assert.equal(scopeAxes(SCOPE_BLOBS, false), null);
});

test("all three families draw the same three planes", () => {
  assert.equal(blobView(SCOPE_BLOBS), "top");
  assert.equal(blobView(SCOPE_BLOBS_FRONT), "front");
  assert.equal(blobView(SCOPE_BLOBS_SIDE), "side");
  assert.equal(blobView(SCOPE_TOP), null, "a Goniometer kind is not a blobs kind");
  assert.equal(radView(SCOPE_RAD), "top");
  assert.equal(radView(SCOPE_RAD_FRONT), "front");
  assert.equal(radView(SCOPE_RAD_SIDE), "side");
  assert.equal(radView(SCOPE_BLOBS), null, "a blobs kind is not a radiation kind");
  assert.equal(blobView(SCOPE_RAD), null, "…and the other way round");

  // Panels of the same plane must be oriented the same way whatever family they
  // belong to, or a pair of them side by side would contradict each other.
  for (const [plane, kinds] of [
    ["front", [SCOPE_BLOBS_FRONT, SCOPE_FRONT, SCOPE_RAD_FRONT, SCOPE_CLOUD_FRONT]],
    ["side", [SCOPE_BLOBS_SIDE, SCOPE_SIDE, SCOPE_RAD_SIDE, SCOPE_CLOUD_SIDE]],
    // The top trio agrees too — for a surround song, where all three have a
    // front-back axis. (A stereo song's Goniometer top plots the mono sum
    // instead, and says so on its own edges.)
    ["top", [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD]],
  ]) {
    const want = scopeLabels(kinds[0], false);
    for (const kind of kinds.slice(1)) {
      const got = scopeLabels(kind, false);
      assert.deepEqual(
        [got.left, got.right, got.top, got.bottom],
        [want.left, want.right, want.top, want.bottom],
        `${plane}: ${kind} vs ${kinds[0]}`,
      );
    }
  }
  assert.equal(scopeLabels(SCOPE_BLOBS, true).top, "F", "a blobs dial is a map, whatever the song");
  assert.equal(scopeLabels(SCOPE_RAD, true).top, "F", "…and so is a radiation dial");

  // A new panel is handed the three TOP views first — one of each family, which
  // is the strip at its most useful — then the rest of the planes, and the two
  // extra blobs views last of all: those are a CHOICE, not something the strip
  // hands you on its own.
  assert.deepEqual(SCOPE_KINDS.slice(0, 4),
    [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD]);
  assert.deepEqual(SCOPE_KINDS.slice(-2), [SCOPE_BLOBS_FRONT, SCOPE_BLOBS_SIDE]);
});

test("a panel's choice survives a song that cannot show it", () => {
  const wishes = [SCOPE_BLOBS, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE];
  // Spatial: everything asked for, exactly as asked for.
  assert.deepEqual(effectiveScopes(wishes, SURROUND_SPATIAL), wishes);
  // Stereo/planar: no vertical plane, so those two panels are not drawn at all
  // rather than repeating a view — and the WISHES are untouched, which is what
  // makes them come back when the song goes spatial again.
  assert.deepEqual(effectiveScopes(wishes, SURROUND_STEREO),
    [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD]);
  assert.deepEqual(effectiveScopes(wishes, SURROUND_PLANAR),
    [SCOPE_BLOBS, SCOPE_TOP, SCOPE_RAD, SCOPE_CLOUD]);
  assert.deepEqual(wishes, [SCOPE_BLOBS, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE], "wishes mutated");

  // An unshowable wish borrows a view nothing else is showing…
  assert.deepEqual(effectiveScopes([SCOPE_FRONT, SCOPE_SIDE], SURROUND_STEREO),
    [SCOPE_BLOBS, SCOPE_TOP]);

  // ONE PANEL PER VIEW is a hard ceiling: a stereo or planar song draws as many
  // as it has views, whatever is configured and however tall the window is. One
  // more would only repeat what the panel beside it is already showing.
  for (const model of [SURROUND_STEREO, SURROUND_PLANAR]) {
    for (const wish of [
      [SCOPE_BLOBS, SCOPE_TOP, SCOPE_TOP],           // a duplicate…
      [SCOPE_TOP, SCOPE_TOP, SCOPE_TOP, SCOPE_TOP],  // …several of them
      [SCOPE_BLOBS, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE],
      SCOPE_KINDS,
    ]) {
      const drawn = effectiveScopes(wish, model).filter((k) => k !== null);
      // Every panel that CAN be filled is, with no repeats — so the count is
      // the smaller of "how many panels were asked for" and "how many views
      // this song has". Duplicated wishes are spent on the unused views.
      const want = Math.min(wish.length, availableScopes(model).length);
      assert.equal(drawn.length, want, `model ${model}, wishes ${wish}: drew ${drawn}`);
    }
  }
  // A spatial song has twelve views, so twelve panels is its ceiling.
  assert.equal(
    effectiveScopes([...SCOPE_KINDS, SCOPE_TOP], SURROUND_SPATIAL).filter((k) => k !== null).length,
    availableScopes(SURROUND_SPATIAL).length);
  // Every kind is offered to a new panel before any is repeated.
  assert.equal(new Set(SCOPE_KINDS).size, SCOPE_KINDS.length);
});

test("meter ballistics: RMS integrates, the peak holds then falls", () => {
  const m = new MeterBallistics();
  for (let i = 0; i < 60; i++) m.update(0.25, 0.5, false, 16); // ~1 s of −6 dB
  assert.ok(Math.abs(m.rmsDb() + 6.02) < 0.5, `rms ${m.rmsDb()}`);
  assert.ok(Math.abs(m.peakDb + 6.0206) < 1e-3, `peak ${m.peakDb}`);

  const held = m.peakDb;
  m.update(0, 0, false, 500);   // inside the hold window
  assert.equal(m.peakDb, held, "peak holds");
  m.update(0, 0, false, 1000);  // hold expired
  m.update(0, 0, false, 1000);  // …now falling at 20 dB/s
  assert.ok(m.peakDb < -20, `peak fell to ${m.peakDb}`);

  assert.equal(m.clipping(), false);
  m.update(0, 1, true, 16);
  assert.equal(m.clipping(), true);
});

test("…on the window BOTH meters read from, so the two views cannot drift", () => {
  // The Mastering tab's Levels bars run the same leaky integrator over the same
  // constant; a bar that said a different thing in two places would be worse
  // than a bar in only one of them. So the constant is pinned to its behaviour:
  // one time constant reaches 1 − 1/e of a step.
  assert.equal(RMS_SLOW_MS, 300);
  const m = new MeterBallistics();
  const step = 0.25;                       // −6 dB
  const dt = 5;
  for (let t = 0; t < RMS_SLOW_MS; t += dt) m.update(step, 0, false, dt);
  assert.ok(Math.abs(m.rms / step - (1 - 1 / Math.E)) < 0.01, `reached ${m.rms / step}`);
  // …and it is frame-rate independent: the same wall time, one big step.
  const coarse = new MeterBallistics();
  coarse.update(step, 0, false, RMS_SLOW_MS);
  assert.ok(Math.abs(coarse.rms - m.rms) < 1e-9, `${coarse.rms} vs ${m.rms}`);
});

test("the clip lamp latches until the next take", () => {
  const m = new MeterBallistics();
  m.update(0.5, 1, true, 16);
  assert.equal(m.clipping(), true);
  // Silence for a quarter of an hour does NOT put it out — that is the point.
  for (let i = 0; i < 60 * 60; i++) m.update(0, 0, false, 250);
  assert.equal(m.clipping(), true, "the lamp is still lit");
  assert.ok(m.rmsDb() < METER_MIN_DB, "…even though everything else fell away");
  m.clearClip();
  assert.equal(m.clipping(), false, "starting playback again clears it");
  // reset() (a song/target change) clears it too.
  m.update(0, 1, true, 16);
  m.reset();
  assert.equal(m.clipping(), false);
});

test("a scope panel is a fixed size, so the viewport decides how many fit", () => {
  // Chooser + square dial + correlation bar: the strip's WIDTH sets the height.
  assert.equal(scopePanelHeight(168), SCOPE_SELECT_H + 168 + SCOPE_CORR_H);
  const panelH = scopePanelHeight(168);
  const head = 24;

  // A short strip has room for one; a tall one for more.
  assert.equal(scopePanelsThatFit(head + SPLIT_H + 200 + panelH, head, 200, panelH), 1);
  assert.equal(scopePanelsThatFit(head + SPLIT_H + 200 + panelH * 3, head, 200, panelH), 3);
  // Shrinking the meter frees room for another — once it frees a whole panel.
  const stripH = head + SPLIT_H + 200 + panelH * 2 + 150;
  assert.equal(scopePanelsThatFit(stripH, head, 200, panelH), 2);
  assert.equal(scopePanelsThatFit(stripH, head, 160, panelH), 2, "half a panel is not a panel");
  assert.equal(scopePanelsThatFit(stripH, head, 100, panelH), 3);
  assert.equal(scopePanelsThatFit(100, head, 200, panelH), 0, "never negative");
  // No arbitrary ceiling: a tall enough strip fits as many as it fits. What you
  // GET is that against the views the song has — one panel per view, which the
  // kind list bounds.
  assert.ok(scopePanelsThatFit(99999, head, 112, panelH) > MAX_SCOPE_PANELS,
    "geometry alone is not capped");
  assert.equal(MAX_SCOPE_PANELS, SCOPE_KINDS.length,
    "the panel ceiling IS the number of views, not a magic number");
});

test("correlation is integrated over a window of AUDIO, not one interval", () => {
  const sums = { ll: 0, rr: 0, lr: 0 };
  // 16 ms intervals of a mono signal: the reading settles at +1.
  const chunk = Math.round(SAMPLING_RATE * 0.016); // one ~16 ms snapshot interval
  let c = 0;
  for (let i = 0; i < 60; i++) c = integrateCorrelation(sums, 100, 100, 100, chunk);
  assert.ok(Math.abs(c - 1) < 1e-9, `mono ${c}`);

  // One anti-phase interval cannot yank the bar across — that twitchiness is
  // exactly what the window is for. The raw reading for that interval is −1.
  const after = integrateCorrelation(sums, 100, 100, -100, chunk);
  assert.equal(correlation(100, 100, -100), -1, "the interval itself is anti-phase");
  assert.ok(after > 0.8, `one bad interval moved it to ${after}`);

  // Sustained anti-phase does get there, over roughly the window length.
  let d = after;
  for (let i = 0; i < 200; i++) d = integrateCorrelation(sums, 100, 100, -100, chunk);
  assert.ok(d < -0.99, `sustained ${d}`);

  // The window is a length of AUDIO: the same total, delivered in one big
  // interval or many small ones, weights the history the same way.
  const a = { ll: 1, rr: 1, lr: 1 };
  const b = { ll: 1, rr: 1, lr: 1 };
  integrateCorrelation(a, 0, 0, 0, 3200);
  for (let i = 0; i < 10; i++) integrateCorrelation(b, 0, 0, 0, 320);
  assert.ok(Math.abs(a.ll - b.ll) < 1e-12, `${a.ll} vs ${b.ll}`);
  assert.ok(CORR_INTEGRATE_MS >= 300, "the window is long enough to be a statistic");
});

test("the vectorscope auto-gain leaves headroom for a full-scale mix", () => {
  // The peak it divides by is a B-format COMPONENT, so full scale reads
  // differently depending on how wide the mix is — and the case that must NOT
  // be magnified is the loudest one.
  const S = Math.SQRT1_2;
  assert.equal(scopeAutoGain(Math.SQRT2), 1, "mono at full scale: W = √2");
  assert.equal(scopeAutoGain(1), 1, "and anything between");
  // Hard-panned full scale is the widest a clipping mix can read, and the
  // headroom takes what used to be a 1.3× magnification of it down to
  // effectively none — the trace lands at three quarters of the radius.
  assert.ok(SCOPE_GAIN_FILL / S > 1.25, "…which is what it asked for before");
  assert.ok(scopeAutoGain(S) <= 1.05, String(scopeAutoGain(S)));
  assert.ok(S * scopeAutoGain(S) < 0.8, String(S * scopeAutoGain(S)));
  // A quiet mix is still magnified, and a silent one does not blow up.
  assert.ok(scopeAutoGain(0.1) > 5 && scopeAutoGain(0.1) < 8, String(scopeAutoGain(0.1)));
  assert.equal(scopeAutoGain(0), SCOPE_GAIN_MAX);
  assert.equal(scopeAutoGain(1e-9), SCOPE_GAIN_MAX);
  // Monotone, and it fills the dial short of the rim.
  assert.ok(scopeAutoGain(0.05) > scopeAutoGain(0.2));
  assert.ok(0.2 * scopeAutoGain(0.2) < 0.92, String(0.2 * scopeAutoGain(0.2)));
});

test("the vectorscope auto-gain slews in wall time", () => {
  // One time constant gets ~63% of the way there, in either direction.
  assert.ok(Math.abs(slewTowards(1, 11, SCOPE_GAIN_SLEW_MS, SCOPE_GAIN_SLEW_MS) - (1 + 10 * 0.6321)) < 0.01);
  assert.ok(Math.abs(slewTowards(11, 1, SCOPE_GAIN_SLEW_MS, SCOPE_GAIN_SLEW_MS) - (11 - 10 * 0.6321)) < 0.01,
    "coming down is slewed too — it used to snap");
  // Frame-rate independent: ten small steps land exactly where one big one does.
  let a = 1;
  for (let i = 0; i < 10; i++) a = slewTowards(a, 11, 30, 300);
  assert.ok(Math.abs(a - slewTowards(1, 11, 300, 300)) < 1e-9, `${a}`);
  // Converges, and a zero-length frame changes nothing.
  let b = 1;
  for (let i = 0; i < 500; i++) b = slewTowards(b, 4, 16, 300);
  assert.ok(Math.abs(b - 4) < 1e-6, String(b));
  assert.equal(slewTowards(3, 9, 0, 300), 3);
});

test("trace ink parsing", () => {
  // The beam's own curves are in test/node/crtbeam.test.js; this is the theme
  // colour it is developed through.
  assert.deepEqual(parseInk("#ffc043"), [255, 192, 67]);
  assert.deepEqual(parseInk("#abc"), [170, 187, 204]);
  assert.deepEqual(parseInk("rgb(1, 2, 3)"), [1, 2, 3]);
  assert.deepEqual(parseInk("nonsense"), [128, 128, 128]);
});

test("the scope ring outlasts a displayed frame several times over", () => {
  // 128 ms at 32 kHz. The scopes draw the samples that arrived since the last
  // frame, so the ring only has to cover the gaps: a snapshot burst, a slow
  // frame, a browser that throttled the tab for a moment.
  assert.equal(SCOPE_FRAMES, 4096);
  const ms = (SCOPE_FRAMES / 32000) * 1000;
  assert.ok(ms >= 100 && ms <= 200, `${ms} ms window`);
});

test("the snapshot's meter block is wide enough for every target", () => {
  for (const target of ["stereo", "quad", "5.1", "7.1", "ambisonic"]) {
    const tap = new AnalysisTap(target, SURROUND_SPATIAL);
    assert.ok(tap.meterCount <= ANALYSIS_MAX_METERS, `${target} needs ${tap.meterCount}`);
  }
});

test("the analysis renderer is a SpatialRenderer like any other", () => {
  const r = new AnalysisRenderer("quad");
  const bus = new SpatialBus(r, 8);
  assert.equal(bus.numChannels, SCOPE_CHANNELS + 4);
  const g = new Float64Array(bus.numChannels);
  r.channelGains(128, 0, g, 0);
  assert.ok(Math.abs(g[0] - 1) < 1e-12, "W is omnidirectional");
  assert.ok(Math.abs(g[3] - 1) < 1e-12, "X points front");
  assert.equal(r.numChannels, bus.numChannels);
  // Its monitorStereo is the virtual stereo decode the correlation meter uses.
  const data = new Float64Array(bus.numChannels * 8);
  data[0] = 1;       // W
  data[8] = 1;       // Y (hard left)
  const out = new Float64Array(2);
  r.monitorStereo(data, 8, 0, out);
  assert.ok(out[0] > out[1], "left louder than right");
});

// ── item 126: is the RMS bar a TRUE RMS? ───────────────────────────────────
// Asked against a square wave, whose RMS equals its own peak, where the strip
// showed the two bars ~3 dB apart. It is a true RMS — the gap is on the PEAK
// side, which is a TRUE peak: the level between the samples. A hard square's
// edges are reconstructed with overshoot, so its inter-sample peak legitimately
// sits above every sample it was built from, while its RMS sits exactly on
// them. (Checked against the real engine too: a square-wave instrument reads
// rms == sample peak at every pitch, and true peak 1.8 dB above at its own
// rate, up to ~3 dB where the resampler puts the edges between output samples.)

/** Steady-state readout of a periodic signal fed to both channels of the mix. */
function steadyMix(gen, frames = 32768) {
  const tap = new AnalysisTap(ANALYSIS_STEREO, SURROUND_STEREO);
  const mixL = new Float32Array(TRACKER_CHUNK);
  const mixR = new Float32Array(TRACKER_CHUNK);
  const push = (f0) => {
    for (let n = 0; n < TRACKER_CHUNK; n++) mixL[n] = mixR[n] = gen(f0 + n);
    tap.begin();
    tap.finish(TRACKER_CHUNK, mixL, mixR);
  };
  push(0); // warm-up: the true-peak detector's 8-tap history has to fill first
  tap.drain(makeAnalysisReadout());
  for (let f0 = TRACKER_CHUNK; f0 < frames; f0 += TRACKER_CHUNK) push(f0);
  return tap.drain(makeAnalysisReadout());
}

test("the RMS reading is a true RMS", () => {
  // A square wave: RMS === peak, to the last bit the Float32 mix bus carries.
  const A = Math.fround(0.8);
  const sq = steadyMix((i) => ((i % 64) < 32 ? 0.8 : -0.8));
  assert.equal(sq.peak[0], A);
  assert.ok(Math.abs(Math.sqrt(sq.meanSquare[0]) - A) < 1e-12,
    `square RMS ${Math.sqrt(sq.meanSquare[0])} should equal its ${A} peak`);

  // A sine: RMS === peak/√2, i.e. exactly 3.01 dB down. Nothing in the meter
  // applies that factor itself — it comes out of the waveform.
  const sine = steadyMix((i) => 0.8 * Math.sin((2 * Math.PI * 500 * i) / 32000));
  assert.ok(Math.abs(Math.sqrt(sine.meanSquare[0]) - 0.8 * Math.SQRT1_2) < 1e-4,
    `sine RMS ${Math.sqrt(sine.meanSquare[0])}`);

  // Half-amplitude for half the time: mean square is the average, not the peak.
  const duty = steadyMix((i) => ((i % 64) < 32 ? 0.8 : 0.0));
  assert.ok(Math.abs(Math.sqrt(duty.meanSquare[0]) - A * Math.SQRT1_2) < 1e-9,
    `50% duty RMS ${Math.sqrt(duty.meanSquare[0])}`);
});

test("the peak reading is a TRUE peak, which is why a square shows a gap", () => {
  const sq = steadyMix((i) => ((i % 64) < 32 ? 0.8 : -0.8));
  const rms = Math.sqrt(sq.meanSquare[0]);
  assert.ok(sq.truePeak[0] > sq.peak[0],
    "a square's inter-sample peak is above the samples it is made of");
  const gapDb = 20 * Math.log10(sq.truePeak[0] / rms);
  assert.ok(gapDb > 1 && gapDb < 3, `square peak-to-RMS gap ${gapDb.toFixed(2)} dB`);

  // A band-limited signal has nothing between its samples to find: both
  // readings land on the same number, so the gap there is the honest 3.01 dB
  // of a sine and nothing more.
  const sine = steadyMix((i) => 0.8 * Math.sin((2 * Math.PI * 500 * i) / 32000));
  assert.ok(Math.abs(sine.truePeak[0] - sine.peak[0]) < 1e-3, "sine: true peak == sample peak");

  // And a steady DC level reads back as itself — the oversampler's branches are
  // each normalised to unity DC gain, so it can never invent level out of one.
  const dc = steadyMix(() => 0.8);
  assert.ok(Math.abs(dc.truePeak[0] - Math.fround(0.8)) < 1e-9, `DC true peak ${dc.truePeak[0]}`);
  assert.ok(Math.abs(Math.sqrt(dc.meanSquare[0]) - Math.fround(0.8)) < 1e-9,
    "…and so does its RMS");
});
