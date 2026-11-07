// Nothing the engine does to a SOUNDING voice's level may step it in one
// sample: a step mid-waveform is a click. Every test here plays a DC sample, so
// the mix bus IS the gain, and asks for the largest one-sample move across the
// event — which a ramp keeps to a small fraction of the level, and a step makes
// the whole of it. (The fadeout's own test is in engine-scenarios.test.js.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import {
  TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate, VOL_RAMP_SAMPLES, ATTACK_RAMP_SAMPLES, MAX_BG_VOICES,
} from "../../core/engine/constants.js";
import { packDupCheck, buildMetaRecord, makeMetaLayer } from "../../core/engine/inst.js";
import { EffectOp } from "../../core/engine/tables.js";
import { SURROUND_SPATIAL } from "../../core/engine/spatial.js";

setSamplingRate(32000);

const SPT = (SAMPLING_RATE * 2.5) / 125; // samples per tick at 125 BPM

/** A looping DC sample in `slot`; `nna`, `dct`, `dca` as the record says them. */
function uploadDC(eng, slot, { nna = 2, dct = 0, dca = 0 } = {}) {
  for (let i = 0; i < 256; i++) eng.sampleBin[i] = 228;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256); w16(6, 32000); w16(12, 256);
  rec[14] = 1;                       // forward loop
  rec[21] = 0x3f;                    // volume envelope node 0 = full
  rec[171] = 255;
  rec[182] = 0xff;                   // filter open
  rec[186] = nna & 0x03;
  rec[195] = packDupCheck(dct, dca);
  rec[196] = 255;
  eng.uploadInstrument(slot, rec);
}

/**
 * Play `cells` ({row, ch = 0, note, inst, op, arg}) on lanes with a pattern
 * each, for `rows` rows of `speed` ticks, and return the left mix bus. `each`
 * is called before every chunk with the frame it starts at. On a surround
 * playhead `L.bus[c]` is object-bus channel c — where elevation shows (the
 * stereo fold-down leaves it out).
 */
function render(eng, cells, { rows, speed = 6, master = 255, model = null, each = null } = {}) {
  const lanes = Math.max(...cells.map((c) => c.ch ?? 0)) + 1;
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  for (let ch = 0; ch < lanes; ch++) {
    const pat = new Uint8Array(512);
    for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
    for (const c of cells) {
      if ((c.ch ?? 0) !== ch) continue;
      const o = c.row * 8;
      if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
      if (c.inst !== undefined) pat[o + 2] = c.inst;
      if (c.op !== undefined) { pat[o + 5] = c.op; pat[o + 6] = c.arg & 0xff; pat[o + 7] = (c.arg >>> 8) & 0xff; }
    }
    eng.uploadPattern(ch, pat);
    cue[ch * 2] = ch; cue[ch * 2 + 1] = 0;
  }
  eng.uploadCue(0, cue);
  if (model !== null) eng.setSurroundModel(0, model);
  eng.setBPM(0, 125); eng.setTickRate(0, speed); eng.setMasterVolume(0, master);
  eng.setCuePosition(0, 0); eng.play(0);
  const ts = eng.playheads[0].trackerState;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const L = [];
  L.bus = null;
  while (L.length < rows * speed * SPT) {
    if (each !== null) each(L.length, eng);
    eng.renderChunk(0, out);
    for (let n = 0; n < TRACKER_CHUNK; n++) L.push(ts.mixLeft[n]);
    const sp = ts.spatial;
    if (sp !== null) {
      L.bus ??= Array.from({ length: sp.numChannels }, () => []);
      for (let c = 0; c < sp.numChannels; c++) {
        for (let n = 0; n < TRACKER_CHUNK; n++) L.bus[c].push(sp.data[c * sp.frames + n]);
      }
    }
  }
  return L;
}

/** The largest one-sample move in L over [from, to). */
function maxStep(L, from, to) {
  let m = 0;
  for (let i = Math.max(from, 1); i < Math.min(to, L.length); i++) m = Math.max(m, Math.abs(L[i] - L[i - 1]));
  return m;
}

const level = (L, at) => Math.abs(L[at]);

/** The level a ramp of `samples` moves `of` by at most, in one sample —
 *  half-cosine (the attack's) included: its steepest is π/2 of the linear. */
const rampStep = (of, samples) => (of * Math.PI) / 2 / samples;

test("a layered note cut by its New Note Action ramps EVERY layer out", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1, { nna: 1 }); // the layers' own NNA: Note Cut
  eng.uploadInstrument(3, buildMetaRecord([
    makeMetaLayer(1, 255, 0, 0x0000, 0xffff, 0, 63),
    makeMetaLayer(1, 255, 0, 0x0000, 0xffff, 0, 63),
  ]));
  const row = 6 * SPT;
  const L = render(eng, [{ row: 0, note: 0x5000, inst: 3 }, { row: 1, note: 0x5000, inst: 3 }], { rows: 2, master: 16 });
  const held = level(L, row - 10);
  assert.ok(held > 0.05 && held < 0.9, `the layered note sounds, unclipped (${held})`);
  // Each old layer ramps out over a cut ramp while each new one ramps in.
  const bound = 2 * rampStep(held / 2, ATTACK_RAMP_SAMPLES) * 1.05;
  assert.ok(maxStep(L, row - 4, row + 4 * ATTACK_RAMP_SAMPLES) <= bound,
    `largest move ${maxStep(L, row - 4, row + 200)} against ${bound}`);
});

test("a Duplicate Check note cut ramps the old note out", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1, { nna: 2, dct: 1, dca: 0 }); // same note → cut
  const row = 6 * SPT;
  const L = render(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, note: 0x5000, inst: 1 }], { rows: 2 });
  const held = level(L, row - 10);
  assert.ok(held > 0.05);
  const bound = 2 * rampStep(held, ATTACK_RAMP_SAMPLES) * 1.05;
  assert.ok(maxStep(L, row - 4, row + 4 * ATTACK_RAMP_SAMPLES) <= bound,
    `largest move ${maxStep(L, row - 4, row + 200)} against ${bound}`);
  assert.ok(Math.abs(level(L, row + 400) - held) < held * 0.01, "and only one note sounds after it");
});

test("S $70 (Past Note Cut) ramps the lane's ghosts out", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1, { nna: 2 }); // Continue: row 1 leaves row 0 ringing
  const row2 = 2 * 6 * SPT;
  const L = render(eng, [
    { row: 0, note: 0x5000, inst: 1 },
    { row: 1, note: 0x5000, inst: 1 },
    { row: 2, op: EffectOp.OP_S, arg: 0x7000 },
  ], { rows: 3 });
  const two = level(L, row2 - 10);
  const one = level(L, row2 + 400);
  assert.ok(Math.abs(two - 2 * one) < one * 0.01, "two notes, then one");
  assert.ok(maxStep(L, row2 - 4, row2 + 100) <= rampStep(one, ATTACK_RAMP_SAMPLES) * 2 / Math.PI * 1.05,
    `largest move ${maxStep(L, row2 - 4, row2 + 100)}`);
});

test("a ghost evicted by the background-voice cap is ramped out, not dropped", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1, { nna: 2 }); // Continue: every note leaves a ghost ringing
  const lanes = 4;
  const rows = MAX_BG_VOICES / lanes + 4; // past the cap for the last few rows
  const cells = [];
  for (let r = 0; r < rows; r++) for (let ch = 0; ch < lanes; ch++) cells.push({ row: r, ch, note: 0x5000, inst: 1 });
  const L = render(eng, cells, { rows, speed: 1, master: 12 });
  const v = level(L, SPT - 10) / lanes; // one voice
  assert.ok(v > 0);
  const ts = eng.playheads[0].trackerState;
  assert.ok(ts.backgroundVoices.filter((b) => b.active).length <= MAX_BG_VOICES, "the cap holds");
  // Each row: `lanes` notes ramp in, and once the pool is full `lanes` ghosts ramp
  // out — each in its own ramp, all in the same samples.
  const bound = lanes * rampStep(v, ATTACK_RAMP_SAMPLES) * 1.05;
  const full = (MAX_BG_VOICES / lanes + 1) * SPT;
  assert.ok(maxStep(L, full - 4, L.length) <= bound, `largest move ${maxStep(L, full - 4, L.length)} against ${bound}`);
});

test("V (global volume) glides over the volume ramp instead of stepping", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1);
  const row = 6 * SPT;
  const L = render(eng, [
    { row: 0, note: 0x5000, inst: 1, op: EffectOp.OP_V, arg: 0xff00 },
    { row: 1, op: EffectOp.OP_V, arg: 0x4000 },
  ], { rows: 2 });
  const before = level(L, row - 10);
  const after = level(L, row + 2 * VOL_RAMP_SAMPLES);
  assert.ok(Math.abs(after - (before * 0x40) / 0xff) < before * 0.01, "it lands on $40");
  assert.ok(maxStep(L, row - 4, row + 4 * VOL_RAMP_SAMPLES) <= ((before - after) / VOL_RAMP_SAMPLES) * 1.05,
    `largest move ${maxStep(L, row - 4, row + 400)}`);
});

test("muting and unmuting a sounding lane glides — its ghosts with it", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1, { nna: 2 });
  const muteAt = 3 * 6 * SPT;
  const unmuteAt = 4 * 6 * SPT;
  let muted = -1, unmuted = -1;
  const L = render(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, note: 0x5000, inst: 1 }], {
    rows: 5,
    each: (frame, e) => {
      if (muted < 0 && frame >= muteAt) { e.setVoiceMute(0, 0, true); muted = frame; }
      if (unmuted < 0 && frame >= unmuteAt) { e.setVoiceMute(0, 0, false); unmuted = frame; }
    },
  });
  const both = level(L, muted - 10);
  assert.ok(both > 0.1, "a note and its ghost sound");
  assert.equal(level(L, muted + 2 * VOL_RAMP_SAMPLES), 0, "the mute silences the lane and the ghost");
  assert.ok(Math.abs(level(L, unmuted + 2 * VOL_RAMP_SAMPLES) - both) < both * 0.01, "the unmute brings both back");
  const bound = (both / VOL_RAMP_SAMPLES) * 1.05;
  assert.ok(maxStep(L, muted - 4, muted + 4 * VOL_RAMP_SAMPLES) <= bound, `mute: ${maxStep(L, muted - 4, muted + 300)}`);
  assert.ok(maxStep(L, unmuted - 4, unmuted + 4 * VOL_RAMP_SAMPLES) <= bound, `unmute: ${maxStep(L, unmuted - 4, unmuted + 300)}`);
});

test("an elevation change (X) glides the speaker gains like an azimuth change", () => {
  const eng = new TaudEngine();
  uploadDC(eng, 1);
  const row = 6 * SPT;
  // Hard left on the horizon (azimuth 0; 128 is the front), then straight overhead.
  const L = render(eng, [
    { row: 0, note: 0x5000, inst: 1, op: EffectOp.OP_X, arg: 0x0000 },
    { row: 1, op: EffectOp.OP_X, arg: 0x7f00 },
  ], { rows: 2, model: SURROUND_SPATIAL });
  assert.ok(L.bus !== null, "a spatial playhead mixes through the object bus");
  let moved = 0;
  for (const ch of L.bus) {
    const before = ch[row - 10];
    const after = ch[row + 4 * VOL_RAMP_SAMPLES];
    const change = Math.abs(after - before);
    if (change < 1e-3) continue;
    moved++;
    // The gains are a smooth function of the angle, so a 2 ms glide keeps each
    // sample's move to a few times the linear share of the whole change.
    const bound = (4 * change) / VOL_RAMP_SAMPLES;
    assert.ok(maxStep(ch, row - 4, row + 4 * VOL_RAMP_SAMPLES) <= bound,
      `largest move ${maxStep(ch, row - 4, row + 300)} against ${bound}`);
  }
  assert.ok(moved > 0, "the move reaches the bus");
});
