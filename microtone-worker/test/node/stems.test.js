// Stem export (item 93): the mixer tap must be inert, the tracks must partition
// the mix exactly, percussion must split per drum, and the 24-bit mono WAV +
// stored ZIP must be readable by a third party (fflate's own unzip).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { unzipSync } from "../../vendor/fflate.esm.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { loadIntoEngine, renderSong } from "../../src/audio/offline-render.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../src/engine/constants.js";
import {
  StemBus, renderStemsAsync, encodeWav24Mono, zipStems, labelStems,
  sanitiseName, stemFileName,
} from "../../src/audio/stem-export.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (name) => new Document(parseTaud(readFileSync(corpusDir + name + ".taud")));
const renderable = (name) => load(name).toRenderable(0);

/** Render `seconds` with a stem bus attached, returning the device output too. */
function renderWithBus(docLike, seconds, perVoice) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, 0);
  const nChunks = Math.ceil((seconds * SAMPLING_RATE) / TRACKER_CHUNK);
  const bus = new StemBus(eng, perVoice, nChunks * TRACKER_CHUNK);
  bus.attach();
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  const u8 = new Uint8Array(nChunks * TRACKER_CHUNK * 2);
  const f32 = new Float32Array(nChunks * TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  eng.setCuePosition(0, 0);
  eng.play(0);
  let frames = 0;
  for (let c = 0; c < nChunks; c++) {
    bus.base = frames;
    if (!eng.isPlaying(0) || eng.renderChunk(0, chunk) === null) break;
    u8.set(chunk, c * TRACKER_CHUNK * 2);
    for (let n = 0; n < TRACKER_CHUNK; n++) {
      f32[(c * TRACKER_CHUNK + n) * 2] = ts.mixLeft[n];
      f32[(c * TRACKER_CHUNK + n) * 2 + 1] = ts.mixRight[n];
    }
    frames += TRACKER_CHUNK;
  }
  bus.detach();
  return { stems: bus.finish(frames), frames, u8: u8.subarray(0, frames * 2), f32: f32.subarray(0, frames * 2) };
}

test("attaching a stem bus leaves the main render bit-identical", () => {
  for (const name of ["WHEN", "Onestop"]) {
    const doc = renderable(name);
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    const plain = renderSong(eng, 4);
    for (const perVoice of [false, true]) {
      const tapped = renderWithBus(renderable(name), 4, perVoice);
      assert.equal(tapped.frames, plain.frames, `${name} frame count`);
      assert.deepEqual(tapped.u8, plain.u8, `${name} u8 output (perVoice=${perVoice})`);
      assert.deepEqual(tapped.f32, plain.f32, `${name} f32 mix bus (perVoice=${perVoice})`);
    }
  }
});

test("stems partition the same signal in both arrangements", () => {
  // Per-voice and per-instrument slice the SAME set of voice contributions, so
  // their sample-wise totals must agree (float grouping order aside).
  const byInst = renderWithBus(renderable("Onestop"), 4, false);
  const byVoice = renderWithBus(renderable("Onestop"), 4, true);
  assert.ok(byInst.stems.length > 1 && byVoice.stems.length > 1, "several tracks each way");

  let worst = 0;
  let energy = 0;
  for (let i = 0; i < byInst.frames; i++) {
    let a = 0;
    let b = 0;
    for (const s of byInst.stems) a += s.buf[i];
    for (const s of byVoice.stems) b += s.buf[i];
    worst = Math.max(worst, Math.abs(a - b));
    energy += Math.abs(a);
  }
  assert.ok(energy > 0, "the render was not silent");
  assert.ok(worst < 1e-5, `totals agree (worst delta ${worst})`);
});

test("a silent channel gets no track, and per-voice tracks stay on their channel", () => {
  const r = renderWithBus(renderable("WHEN"), 4, true);
  const channels = r.stems.map((s) => s.channel);
  assert.deepEqual(channels, [...channels].sort((a, b) => a - b), "ordered by channel");
  assert.equal(new Set(channels).size, channels.length, "one track per channel");
  for (const s of r.stems) assert.ok(s.peak > 0, `channel ${s.channel} is audible`);
});

test("a percussion instrument splits into one track per drum", () => {
  // Onestop is a GM MIDI conversion: its drum kit is a percussion-flagged
  // instrument whose sub-instruments/patches are the individual drums.
  const doc = load("Onestop");
  const r = renderWithBus(doc.toRenderable(0), 20, false);
  const rectOf = (s) => {
    const p = doc.instruments[s.sub].extraPatches[s.patchIdx];
    return `${p.pitchStart}..${p.pitchEnd}`;
  };
  const percTops = new Set();
  for (const s of r.stems) if (s.split) percTops.add(s.top);
  assert.ok(percTops.size > 0, "a percussion instrument sounded");
  for (const top of percTops) {
    const drums = r.stems.filter((s) => s.top === top);
    assert.ok(drums.length > 1, `slot ${top} split into ${drums.length} tracks`);
    // One track per DRUM: a kick layered from two metainstrument sub-instruments
    // is one track, not two, so the pitch rects must all be distinct.
    const rects = drums.map(rectOf);
    assert.equal(new Set(rects).size, rects.length, "no drum is split across tracks");
    assert.ok(drums.every((s) => s.patchIdx >= 0), "every drum track came from a patch");
  }
  // Non-percussion instruments stay whole, one track each.
  const melodic = r.stems.filter((s) => !s.split).map((s) => s.top);
  assert.equal(new Set(melodic).size, melodic.length, "one track per melodic instrument");
});

test("labels name melodic tracks by instrument and drums by sample", () => {
  const doc = load("Onestop");
  const r = renderWithBus(doc.toRenderable(0), 8, false);
  labelStems(r.stems, doc, "instrument");
  for (const s of r.stems) {
    assert.match(s.label, /^I[0-9A-F]{2} .+/, `label "${s.label}"`);
    assert.equal(s.label, sanitiseName(s.label), "labels are already filename-safe");
  }
  const names = r.stems.map((s) => s.label);
  assert.equal(new Set(names).size, names.length, "labels are unique");

  const v = renderWithBus(doc.toRenderable(0), 4, true);
  labelStems(v.stems, doc, "voice");
  for (const s of v.stems) assert.match(s.label, /^Lane\d\d/, `lane label "${s.label}"`);
});

test("sanitiseName strips path separators and keeps non-ASCII", () => {
  assert.equal(sanitiseName("Lead/Bass:2"), "Lead Bass 2");
  assert.equal(sanitiseName("../../etc/passwd"), "etc passwd");
  assert.equal(sanitiseName("  "), "track");
  assert.equal(sanitiseName("", "fallback"), "fallback");
  assert.equal(sanitiseName("피아노"), "피아노");
  assert.equal(sanitiseName("\\u D0DC"[0] + "a"), "a"); // stray escape debris
  assert.equal(stemFileName("song", 3, "Kick Drum 1"), "song_03_Kick Drum 1.wav");
  assert.equal(stemFileName("song", 12, "Hat/Open"), "song_12_Hat Open.wav");
});

test("encodeWav24Mono writes a 24-bit 48 kHz mono header and exact samples", () => {
  const src = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const wav = encodeWav24Mono(src, 48000, 48000); // source already at 48 kHz: no resampling
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.equal(dv.getUint16(20, true), 1, "PCM");
  assert.equal(dv.getUint16(22, true), 1, "mono");
  assert.equal(dv.getUint32(24, true), 48000, "48 kHz");
  assert.equal(dv.getUint32(28, true), 48000 * 3, "byte rate");
  assert.equal(dv.getUint16(32, true), 3, "block align");
  assert.equal(dv.getUint16(34, true), 24, "24 bits");
  assert.equal(dv.getUint32(40, true), src.length * 3, "data size");
  assert.equal(wav.length % 2, 0, "RIFF word alignment");

  const sample = (i) => {
    const o = 44 + i * 3;
    const u = wav[o] | (wav[o + 1] << 8) | (wav[o + 2] << 16);
    return u >= 0x800000 ? u - 0x1000000 : u;
  };
  assert.equal(sample(0), 0);
  assert.equal(sample(1), Math.round(0.5 * 8388607));
  assert.equal(sample(2), Math.round(-0.5 * 8388607)); // half-up, like the 16-bit encoder
  assert.equal(sample(3), 8388607, "+1.0 is full scale");
  assert.equal(sample(4), -8388607);
  assert.equal(sample(5), 8388607, "clamped");
  assert.equal(sample(6), -8388607, "clamped");
});

test("encodeWav24Mono resamples 32 kHz → 48 kHz", () => {
  const src = new Float32Array(32000); // 1 s at 32 kHz
  const wav = encodeWav24Mono(src, 48000, 32000);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(dv.getUint32(40, true) / 3, 48000, "one second at 48 kHz");
});

test("zipStems produces an archive fflate can read back", () => {
  const files = [
    { name: "song_01_Piano.wav", bytes: encodeWav24Mono(new Float32Array([0.25, -0.25]), SAMPLING_RATE, SAMPLING_RATE) },
    { name: "song_02_피아노.wav", bytes: encodeWav24Mono(new Float32Array([0.5]), SAMPLING_RATE, SAMPLING_RATE) },
  ];
  const chunks = zipStems(files);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const zip = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { zip.set(c, o); o += c.length; }

  const out = unzipSync(zip);
  assert.deepEqual(Object.keys(out).sort(), files.map((f) => f.name).sort());
  for (const f of files) assert.deepEqual(out[f.name], f.bytes, `${f.name} round-trips byte-exact`);
});

test("renderStemsAsync honours the cap, reports progress and can be aborted", async () => {
  const doc = renderable("WHEN");
  const r = await renderStemsAsync(doc, 0, 2, { mode: "instrument", yieldMs: 0 });
  assert.ok(r.stems.length > 0, "produced tracks");
  assert.equal(r.frames, 2 * SAMPLING_RATE, "stopped at the cap");
  for (const s of r.stems) assert.equal(s.buf.length, r.frames, "tracks are trimmed to the render");

  const ctrl = new AbortController();
  let ticks = 0;
  const aborted = await renderStemsAsync(doc, 0, 60, {
    yieldMs: 0,
    signal: ctrl.signal,
    onProgress: () => { if (++ticks === 2) ctrl.abort(); },
  });
  assert.equal(aborted.aborted, true);
  assert.deepEqual(aborted.stems, []);
});

test("track buffers grow past the initial allocation without a seam", async () => {
  // Buffers start at 1<<20 frames (~33 s) and double; a longer render must
  // cross that boundary with the audio intact and every track the same length.
  const BOUNDARY = 1 << 20;
  const r = await renderStemsAsync(renderable("WHEN"), 0, 40, { mode: "voice", yieldMs: 1000 });
  assert.ok(r.frames > BOUNDARY, "the render crossed the growth boundary");
  for (const s of r.stems) assert.equal(s.buf.length, r.frames, "all tracks are the full length");

  const rms = (buf, from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / (to - from));
  };
  const loudest = r.stems.reduce((a, b) => (a.peak >= b.peak ? a : b));
  const before = rms(loudest.buf, BOUNDARY - 16000, BOUNDARY);
  const after = rms(loudest.buf, BOUNDARY, BOUNDARY + 16000);
  assert.ok(before > 0 && after > 0, `audio on both sides (${before} / ${after})`);
  assert.ok(after / before > 0.1 && after / before < 10, "no level seam at the boundary");
});

test("stem content is the pre-pan voice signal (a hard-panned voice keeps full level)", async () => {
  // WHEN's lanes carry real pan values; the stem must not be attenuated by
  // the pan law, so its peak is >= the peak of either mix side it feeds.
  const doc = renderable("WHEN");
  const r = renderWithBus(doc, 4, true);
  let mixPeak = 0;
  for (let i = 0; i < r.f32.length; i++) mixPeak = Math.max(mixPeak, Math.abs(r.f32[i]));
  const stemTotal = r.stems.reduce((a, s) => a + s.peak, 0);
  assert.ok(stemTotal >= mixPeak, "pre-pan tracks are at least as loud as the mix");
});
