// ITU speaker render targets (#998.6). The claims worth pinning: a source at a
// speaker is IN that speaker, the pan is level-preserving and continuous the
// whole way round, the LFE never receives anything, elevation turns into a
// diffuse spread instead of vanishing, and the layout tables agree with the
// channel masks they ship with.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SPEAKER_LAYOUTS, SPEAKER_LAYOUT_NAMES, SpeakerRenderer, speakerAzimuth,
} from "../../core/engine/speakers.js";
import { AZIMUTH_TURN } from "../../core/engine/spatial.js";

const energy = (g) => g.reduce((s, v) => s + v * v, 0);

test("every layout's channel mask has one bit per channel", () => {
  for (const name of SPEAKER_LAYOUT_NAMES) {
    const layout = SPEAKER_LAYOUTS[name];
    let bits = 0;
    for (let m = layout.mask; m; m >>>= 1) bits += m & 1;
    assert.equal(bits, layout.speakers.length, `${name}: mask ${layout.mask.toString(16)}`);
    assert.equal(layout.speakers.filter((s) => s.lfe).length, name === "quad" ? 0 : 1);
  }
});

test("ADM labels carry the ITU sign convention, which is the opposite one", () => {
  // BS.2051 counts azimuth anticlockwise (M+030 is front LEFT); the engine
  // counts clockwise. A mismatch here would put every export's left on the
  // right, and nothing else in the pipeline would notice.
  for (const name of SPEAKER_LAYOUT_NAMES) {
    for (const s of SPEAKER_LAYOUTS[name].speakers) {
      if (s.lfe) continue;
      const m = /^M([+-])(\d{3})$/.exec(s.adm);
      assert.ok(m, `${name}: unparsable ADM label ${s.adm}`);
      const admDeg = (m[1] === "+" ? 1 : -1) * Number(m[2]);
      // (=== so that the centre speaker's +0 and −0 count as agreeing.)
      assert.ok(admDeg === -s.deg, `${name}: ${s.label} (${s.deg}°) labelled ${s.adm}`);
    }
  }
});

test("a source sitting on a speaker goes entirely into it", () => {
  for (const name of SPEAKER_LAYOUT_NAMES) {
    const r = new SpeakerRenderer(name);
    const g = new Float64Array(r.numChannels);
    const speakers = SPEAKER_LAYOUTS[name].speakers;
    for (let i = 0; i < speakers.length; i++) {
      if (speakers[i].lfe) continue;
      r.channelGains(speakerAzimuth(speakers[i].deg), 0, g, 0);
      assert.ok(Math.abs(g[i] - 1) < 1e-9,
        `${name}: ${speakers[i].label} got ${g[i].toFixed(4)} of its own source`);
      assert.ok(Math.abs(energy(g) - 1) < 1e-9);
    }
  }
});

test("front, right, behind and left land where a listener would point", () => {
  const r = new SpeakerRenderer("5.1");
  const g = new Float64Array(r.numChannels);
  const idx = (label) => SPEAKER_LAYOUTS["5.1"].speakers.findIndex((s) => s.label === label);
  r.channelGains(128, 0, g, 0);          // front
  assert.ok(g[idx("C")] > 0.999, "front must be the centre speaker");
  r.channelGains(0, 0, g, 0);            // hard left
  assert.ok(g[idx("L")] > 0 && g[idx("Ls")] > 0, "hard left sits between L and Ls");
  assert.ok(g[idx("R")] === 0 && g[idx("Rs")] === 0, "…and nothing leaks to the right");
  r.channelGains(256, 0, g, 0);          // hard right
  assert.ok(g[idx("R")] > 0 && g[idx("Rs")] > 0);
  assert.ok(g[idx("L")] === 0 && g[idx("Ls")] === 0);
  r.channelGains(384, 0, g, 0);          // behind
  assert.ok(Math.abs(g[idx("Ls")] - g[idx("Rs")]) < 1e-9, "behind is centred on the surrounds");
  assert.ok(g[idx("C")] === 0, "…and never in the centre speaker");
});

test("the pan is level-preserving and continuous all the way round", () => {
  for (const name of SPEAKER_LAYOUT_NAMES) {
    const r = new SpeakerRenderer(name);
    const g = new Float64Array(r.numChannels);
    let prev = null;
    for (let az = 0; az < AZIMUTH_TURN; az += 1) {
      r.channelGains(az, 0, g, 0);
      assert.ok(Math.abs(energy(g) - 1) < 1e-9, `${name}: energy ${energy(g)} at ${az}`);
      if (prev !== null) {
        let d = 0;
        for (let i = 0; i < g.length; i++) d += (g[i] - prev[i]) ** 2;
        assert.ok(Math.sqrt(d) < 0.05, `${name}: pan jumps at ${az}`);
      }
      prev = Float64Array.from(g);
    }
  }
});

test("the LFE stays silent from every direction", () => {
  for (const name of ["5.1", "7.1"]) {
    const r = new SpeakerRenderer(name);
    const g = new Float64Array(r.numChannels);
    const lfe = SPEAKER_LAYOUTS[name].speakers.findIndex((s) => s.lfe);
    for (let az = 0; az < AZIMUTH_TURN; az += 7) {
      for (const el of [-128, -64, 0, 64, 128]) {
        r.channelGains(az, el, g, 0);
        assert.equal(g[lfe], 0, `${name}: LFE fed from az=${az} el=${el}`);
      }
    }
  }
});

test("elevation spreads into a diffuse image instead of disappearing", () => {
  const r = new SpeakerRenderer("7.1");
  const g = new Float64Array(r.numChannels);
  r.channelGains(128, 128, g, 0); // straight up
  assert.ok(Math.abs(energy(g) - 1) < 1e-9, "overhead must keep its level");
  const ring = [...g].filter((_, i) => !SPEAKER_LAYOUTS["7.1"].speakers[i].lfe);
  for (const v of ring) assert.ok(Math.abs(v - ring[0]) < 1e-9, "overhead must be even");
  // …and it gets there gradually.
  let prevFront = 1;
  for (const el of [0, 32, 64, 96, 128]) {
    r.channelGains(128, el, g, 0);
    const front = g[2]; // C
    assert.ok(front <= prevFront + 1e-12, `centre grew as the source rose (el=${el})`);
    prevFront = front;
  }
});

test("the stereo monitor agrees with the fold each speaker would get", () => {
  const r = new SpeakerRenderer("5.1");
  const frames = 1;
  const bus = new Float64Array(r.numChannels);
  const out = new Float64Array(2);
  const idx = (label) => SPEAKER_LAYOUTS["5.1"].speakers.findIndex((s) => s.label === label);

  bus.fill(0); bus[idx("L")] = 1;
  r.monitorStereo(bus, frames, 0, out);
  assert.ok(out[0] > out[1], "L must lean left");
  bus.fill(0); bus[idx("C")] = 1;
  r.monitorStereo(bus, frames, 0, out);
  assert.ok(Math.abs(out[0] - out[1]) < 1e-12, "C must be centred");
  bus.fill(0); bus[idx("LFE")] = 1;
  r.monitorStereo(bus, frames, 0, out);
  assert.deepEqual([...out], [0, 0], "the LFE is not part of the monitor");
});
