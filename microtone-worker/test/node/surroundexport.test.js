// Surround / ambisonic export (#998.4/.5/.6). The exports are files other
// programs have to read, so the tests PARSE THEM BACK: walk the RIFF chunks,
// decode the format block, check the ADM index lines up with the XML, and
// confirm the samples in the container are the ones the renderer produced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import {
  AUDIO_EXPORT_FORMATS, renderMultichannelAsync,
  makeExportRenderer, exportFileSuffix, admChunksFor,
} from "../../src/audio/surround-export.js";
import { StreamResampler } from "../../src/audio/resampler.js";
import { renderToWavAsync } from "../../src/audio/offline-render.js";
import { encodeWavBuffer, quantisePcm } from "../../src/audio/wavwrite.js";
import { acnOrderDegree, buildChna, buildAdmXml, hoaChannelSpecs } from "../../src/audio/adm.js";
import { SPEAKER_LAYOUTS } from "../../src/engine/speakers.js";
import { SAMPLING_RATE } from "../../src/engine/constants.js";
import { defaultMastering, normaliseMastering } from "../../src/engine/mastering.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadSong = (name) => new Document(parseTaud(readFileSync(corpusDir + name))).toRenderable(0);

/** Flatten the block list an export returns. */
function flatten(blocks) {
  const n = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

/** Minimal RIFF walker: {id → {offset, size}} plus the declared RIFF size. */
function riffChunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  assert.equal(str(0, 4), "RIFF");
  assert.equal(str(8, 4), "WAVE");
  const riffSize = dv.getUint32(4, true);
  assert.equal(riffSize + 8, bytes.length, "RIFF size must cover the whole file");
  const out = new Map();
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = str(o, 4);
    const size = dv.getUint32(o + 4, true);
    out.set(id, { offset: o + 8, size });
    o += 8 + size + (size & 1); // chunks are word-aligned
  }
  assert.equal(o, bytes.length, "chunk walk must land exactly on the end");
  return out;
}

function parseFmt(bytes, chunk) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + chunk.offset, chunk.size);
  const fmt = {
    tag: dv.getUint16(0, true),
    channels: dv.getUint16(2, true),
    rate: dv.getUint32(4, true),
    byteRate: dv.getUint32(8, true),
    blockAlign: dv.getUint16(12, true),
    bits: dv.getUint16(14, true),
  };
  if (chunk.size >= 40) {
    fmt.cbSize = dv.getUint16(16, true);
    fmt.validBits = dv.getUint16(18, true);
    fmt.mask = dv.getUint32(20, true);
    fmt.subformat = dv.getUint32(24, true);
  }
  return fmt;
}

test("the format list is internally consistent", () => {
  for (const f of AUDIO_EXPORT_FORMATS) {
    if (f.kind === "stereo") continue;
    const r = makeExportRenderer(f.id);
    assert.equal(r.numChannels, f.channels, `${f.id}: renderer/table channel mismatch`);
    if (f.kind === "speakers") {
      assert.equal(SPEAKER_LAYOUTS[f.layout].speakers.length, f.channels);
    } else {
      // AmbiX carries the complete basis — (order+1)², never the planar subset.
      assert.equal(f.channels, (f.order + 1) ** 2, `${f.id}: not a full ACN set`);
    }
  }
  assert.equal(exportFileSuffix("5.1"), ".wav");
  assert.equal(exportFileSuffix("ambix3"), ".ambix.wav");
});

test("ACN indices map to the orders and degrees ADM has to state", () => {
  assert.deepEqual(acnOrderDegree(0), [0, 0]);
  assert.deepEqual(acnOrderDegree(1), [1, -1]); // Y
  assert.deepEqual(acnOrderDegree(2), [1, 0]);  // Z
  assert.deepEqual(acnOrderDegree(3), [1, 1]);  // X
  assert.deepEqual(acnOrderDegree(8), [2, 2]);
  assert.deepEqual(acnOrderDegree(15), [3, 3]);
  const specs = hoaChannelSpecs(16);
  assert.equal(specs.length, 16);
  for (let acn = 0; acn < 16; acn++) {
    const [l, m] = acnOrderDegree(acn);
    assert.equal(specs[acn].order, l);
    assert.equal(specs[acn].degree, m);
  }
});

test("the chna index is fixed-width and points at the XML's own IDs", () => {
  const chna = buildChna("HOA", 4);
  assert.equal(chna.length, 4 + 4 * 40);
  const dv = new DataView(chna.buffer);
  assert.equal(dv.getUint16(0, true), 4, "numTracks");
  assert.equal(dv.getUint16(2, true), 4, "numUIDs");
  const text = (o, n) => String.fromCharCode(...chna.subarray(o, o + n));
  assert.equal(dv.getUint16(4, true), 1, "track numbers are 1-based");
  assert.equal(text(6, 12), "ATU_00000001");
  assert.equal(text(18, 14), "AT_00041001_01");
  assert.equal(text(32, 11), "AP_00041001");
  // …and the last record is where the fixed stride says it is.
  assert.equal(dv.getUint16(4 + 3 * 40, true), 4);
  assert.equal(text(4 + 3 * 40 + 2, 12), "ATU_00000004");

  const xml = buildAdmXml({
    kind: "HOA", title: "x", packName: "p", channels: hoaChannelSpecs(4),
    sampleRate: 48000, bitDepth: 24,
  });
  for (const id of ["ATU_00000001", "AT_00041001_01", "AP_00041001", "ATU_00000004"]) {
    assert.ok(xml.includes(id), `axml never mentions ${id}, which chna points at`);
  }
});

test("ADM XML escapes the song title instead of breaking the document", () => {
  const xml = buildAdmXml({
    kind: "DirectSpeakers", title: 'Rock & <Roll> "77"', packName: "5.1",
    channels: [{ name: "L", speakerLabel: "M+030", azimuth: 30, elevation: 0 }],
    sampleRate: 48000, bitDepth: 24,
  });
  assert.ok(xml.includes("Rock &amp; &lt;Roll&gt; &quot;77&quot;"));
  assert.ok(!/<Roll>/.test(xml));
  // Every opened element closes: a crude but effective well-formedness check.
  const opens = [...xml.matchAll(/<([a-zA-Z][\w]*)[\s>]/g)].map((m) => m[1]);
  const closes = [...xml.matchAll(/<\/([a-zA-Z][\w]*)>/g)].map((m) => m[1]);
  const selfClosing = opens.filter((n) => !closes.includes(n));
  assert.deepEqual(selfClosing, [], `unclosed elements: ${selfClosing}`);
});

test("the streaming resampler is seamless across chunk boundaries", () => {
  // A 32 kHz ramp resampled to 48 kHz must stay a straight line: any phase or
  // history slip shows up as a kink exactly at a chunk boundary.
  const ch = 1;
  const r = new StreamResampler(ch, 32000, 48000);
  const chunk = 512;
  const out = new Float32Array(r.maxOut(chunk) * ch);
  const got = [];
  let x = 0;
  for (let b = 0; b < 4; b++) {
    const input = new Float32Array(chunk);
    for (let i = 0; i < chunk; i++) input[i] = x++;
    const n = r.process(input, chunk, out);
    for (let i = 0; i < n; i++) got.push(out[i]);
  }
  // The first kernel-width of output is the START of the stream, where the sinc
  // taps hang off the front of the ramp into zero-padding — no resampler can
  // invent the signal before sample 0. The seams are what this test is about.
  const head = 2 * 12;
  for (let i = head + 1; i < got.length; i++) {
    assert.ok(Math.abs((got[i] - got[i - 1]) - 32000 / 48000) < 1e-3,
      `kink at output frame ${i}: ${got[i - 1]} → ${got[i]}`);
  }
  assert.ok(got.length > 4 * chunk * 1.4, "should have produced 1.5× the frames");
});

test("identical rates pass the samples through untouched", () => {
  const r = new StreamResampler(2, 32000, 32000);
  const input = Float32Array.from([1, -1, 0.5, -0.5, 0.25, -0.25]);
  const out = new Float32Array(r.maxOut(3) * 2);
  const n = r.process(input, 3, out);
  assert.equal(n, 3);
  assert.deepEqual([...out.subarray(0, 6)], [...input]);
});

test("a 5.1 export is a readable EXTENSIBLE WAV with ADM metadata", async () => {
  const doc = loadSong("WHEN.taud");
  const r = await renderMultichannelAsync(doc, 0, 2, {
    format: "5.1", outRate: 48000, title: "WHEN",
  });
  assert.equal(r.channels, 6);
  const bytes = flatten(r.blocks);
  const chunks = riffChunks(bytes);

  const fmt = parseFmt(bytes, chunks.get("fmt "));
  assert.equal(fmt.tag, 0xfffe, "more than two channels must be EXTENSIBLE");
  assert.equal(fmt.channels, 6);
  assert.equal(fmt.rate, 48000);
  assert.equal(fmt.bits, 24);
  assert.equal(fmt.blockAlign, 18);
  assert.equal(fmt.byteRate, 48000 * 18);
  assert.equal(fmt.mask, SPEAKER_LAYOUTS["5.1"].mask);
  assert.equal(fmt.subformat, 1, "PCM subformat GUID");

  const data = chunks.get("data");
  assert.equal(data.size % fmt.blockAlign, 0, "whole frames only");
  assert.equal(data.size / fmt.blockAlign, r.frames);
  // ~2 s at 48 kHz, allowing for the render stopping on a chunk boundary.
  assert.ok(Math.abs(r.frames - 96000) < 600, `got ${r.frames} frames`);

  assert.ok(chunks.has("chna"), "no chna index");
  assert.ok(chunks.has("axml"), "no axml document");
  const xml = new TextDecoder().decode(
    bytes.subarray(chunks.get("axml").offset, chunks.get("axml").offset + chunks.get("axml").size));
  assert.ok(xml.includes('typeDefinition="DirectSpeakers"'));
  assert.ok(xml.includes("urn:itu:bs:2051:0:speaker:M+030"), "front left label");
  assert.ok(xml.includes("urn:itu:bs:2051:0:speaker:LFE1"));
  assert.ok(xml.includes("<audioProgrammeID") || xml.includes("audioProgrammeID="));
  assert.ok(xml.includes("WHEN"), "the song's name should reach the metadata");
});

test("an AmbiX export declares ACN/SN3D and leaves the mask unassigned", async () => {
  const doc = loadSong("WHEN.taud");
  const r = await renderMultichannelAsync(doc, 0, 1, {
    format: "ambix1", outRate: 48000, title: "WHEN",
  });
  const bytes = flatten(r.blocks);
  const chunks = riffChunks(bytes);
  const fmt = parseFmt(bytes, chunks.get("fmt "));
  assert.equal(fmt.channels, 4);
  assert.equal(fmt.tag, 0xfffe);
  assert.equal(fmt.mask, 0, "AmbiX declares no speaker assignment");
  const xml = new TextDecoder().decode(
    bytes.subarray(chunks.get("axml").offset, chunks.get("axml").offset + chunks.get("axml").size));
  assert.ok(xml.includes('typeDefinition="HOA"'));
  assert.ok(xml.includes("<normalization>SN3D</normalization>"));
  assert.ok(xml.includes("<order>1</order>"));
  assert.ok(xml.includes("<degree>-1</degree>"), "ACN 1 is (1, −1)");
});

test("the W channel of an AmbiX export is the song, and the rest is the scene", async () => {
  const doc = loadSong("WHEN.taud");
  const r = await renderMultichannelAsync(doc, 0, 2, { format: "ambix1", outRate: SAMPLING_RATE });
  const bytes = flatten(r.blocks);
  const chunks = riffChunks(bytes);
  const data = chunks.get("data");
  // Peak per channel, straight out of the container.
  const peaks = [0, 0, 0, 0];
  const frames = data.size / 12;
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < 4; c++) {
      const o = data.offset + (n * 4 + c) * 3;
      let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      const a = Math.abs(v / 8388607);
      if (a > peaks[c]) peaks[c] = a;
    }
  }
  assert.ok(peaks[0] > 0.01, "W must carry the mix");
  assert.ok(peaks[3] > 0.001, "X must carry the front/back component");
  // WHEN is a stereo song promoted to planar, so nothing is ever off the
  // horizon: Z (ACN 2) has to be silent, which is also a sign convention check.
  assert.equal(peaks[2], 0, "Z must be silent for a horizontal song");
});

test("elevation written in the pattern reaches the exported Z channel", async () => {
  // The whole chain in one assertion: effect X → voice elevation → the
  // ambisonic encoder → the container. Without it, a sign or axis slip anywhere
  // between the cell and the file would still leave every other test green.
  const doc = loadSong("WHEN.taud");
  doc.songs[0].surroundModel = 2; // spatial
  for (const pat of doc.songs[0].patterns) {
    pat[5] = 0x21;   // effect X (EffectOp.OP_X)
    pat[6] = 0x40;   // azimuth $40 = front
    pat[7] = 0x40;   // elevation +$40 = +45°
  }
  const r = await renderMultichannelAsync(doc, 0, 2, { format: "ambix1", outRate: SAMPLING_RATE });
  const bytes = flatten(r.blocks);
  const data = riffChunks(bytes).get("data");
  let peakZ = 0;
  let peakW = 0;
  for (let n = 0; n < data.size / 12; n++) {
    for (const c of [0, 2]) {
      const o = data.offset + (n * 4 + c) * 3;
      let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      const a = Math.abs(v / 8388607);
      if (c === 0) { if (a > peakW) peakW = a; } else if (a > peakZ) peakZ = a;
    }
  }
  assert.ok(peakW > 0.01, "W must still carry the mix");
  // SN3D's Z is sin(elevation) = 0.707 at +45°, so it is a large fraction of W.
  assert.ok(peakZ > 0.3 * peakW, `Z is only ${(peakZ / peakW).toFixed(3)} of W — elevation lost`);
});

test("the same song, same target, twice — byte for byte", async () => {
  const doc = loadSong("WHEN.taud");
  const opts = { format: "quad", outRate: 48000, title: "WHEN" };
  const a = flatten((await renderMultichannelAsync(doc, 0, 1, opts)).blocks);
  const b = flatten((await renderMultichannelAsync(doc, 0, 1, opts)).blocks);
  assert.deepEqual(a, b);
});

test("an aborted export produces no file at all", async () => {
  const doc = loadSong("WHEN.taud");
  const ctrl = new AbortController();
  let ticks = 0;
  const r = await renderMultichannelAsync(doc, 0, 60, {
    format: "5.1", yieldMs: 0, signal: ctrl.signal,
    onProgress: () => { if (++ticks === 2) ctrl.abort(); },
  });
  assert.equal(r.aborted, true);
  assert.equal(r.blocks, null);
});

test("a mono/stereo WAV keeps the plain header every decoder understands", () => {
  const pcm = Float32Array.from([0, 0.5, -0.5, 1]);
  const bytes = encodeWavBuffer(pcm, { channels: 2, sampleRate: 48000, bits: 16 });
  const chunks = riffChunks(bytes);
  const fmt = parseFmt(bytes, chunks.get("fmt "));
  assert.equal(fmt.tag, 1, "stereo must NOT be EXTENSIBLE");
  assert.equal(chunks.get("fmt ").size, 16);
  assert.equal(chunks.get("data").size, 8);
});

test("odd-sized chunks are padded so the walk stays word-aligned", () => {
  // 24-bit mono, 3 frames = 9 bytes of data: the pad byte is what keeps a
  // following chunk legal, and RIFF's size must count it.
  const bytes = encodeWavBuffer(Float32Array.from([0.1, 0.2, 0.3]), {
    channels: 1, sampleRate: 32000, bits: 24,
    after: [], before: [],
  });
  const chunks = riffChunks(bytes);
  assert.equal(chunks.get("data").size, 9);
  assert.equal(bytes.length % 2, 0);
});

test("quantisation clips instead of wrapping round", () => {
  const q16 = quantisePcm(Float32Array.from([2, -2]), 2, 16);
  const dv = new DataView(q16.buffer);
  assert.equal(dv.getInt16(0, true), 32767);
  assert.equal(dv.getInt16(2, true), -32767);
  const q24 = quantisePcm(Float32Array.from([2]), 1, 24);
  assert.deepEqual([...q24], [0xff, 0xff, 0x7f]);
});

test("the binaural stereo downmix differs from the fold, and only for surround", async () => {
  const doc = loadSong("WHEN.taud");
  const fold = await renderToWavAsync(doc, 0, 1, { monitor: "fold" });
  const head = await renderToWavAsync(doc, 0, 1, { monitor: "binaural" });
  // WHEN is a stereo song: it has no object bus, so the head model cannot and
  // must not touch it.
  assert.deepEqual(head.bytes, fold.bytes, "a stereo song must be untouched");

  const surroundDoc = loadSong("WHEN.taud");
  surroundDoc.songs[0].surroundModel = 2;
  const sFold = await renderToWavAsync(surroundDoc, 0, 1, { monitor: "fold" });
  const sHead = await renderToWavAsync(surroundDoc, 0, 1, { monitor: "binaural" });
  assert.notDeepEqual(sHead.bytes, sFold.bytes, "the head model must change a surround song");
  assert.equal(sHead.bytes.length, sFold.bytes.length);
});

test("every listed format renders and lands in a container", async () => {
  const doc = loadSong("WHEN.taud");
  for (const f of AUDIO_EXPORT_FORMATS) {
    if (f.kind === "stereo") continue;
    const r = await renderMultichannelAsync(doc, 0, 0.5, { format: f.id, outRate: 44100 });
    const bytes = flatten(r.blocks);
    const chunks = riffChunks(bytes);
    const fmt = parseFmt(bytes, chunks.get("fmt "));
    assert.equal(fmt.channels, f.channels, `${f.id}`);
    assert.equal(fmt.bits, f.bits, `${f.id}`);
    assert.equal(fmt.rate, 44100, `${f.id}`);
    const adm = admChunksFor(f.id, { title: "t", sampleRate: 44100, bitDepth: f.bits });
    assert.equal(adm.before.length, 1, `${f.id}: chna`);
    assert.equal(adm.after.length, 1, `${f.id}: axml`);
  }
});

// ── the mastering chain reaches these files too (item 178.1) ────────────────
// engine spec §12.3. The stereo chain acts on the pair, which is not this
// file's signal; a multichannel target masters the object bus instead.

/** Every channel of a 24-bit export, as floats in channel-major order. */
function decode24(bytes, channels) {
  const data = riffChunks(bytes).get("data");
  const frames = data.size / (channels * 3);
  const out = new Float64Array(channels * frames);
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < channels; c++) {
      const o = data.offset + (n * channels + c) * 3;
      let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      out[c * frames + n] = v / 8388607;
    }
  }
  return { out, frames };
}

/** A song's renderable with a mastering chain bolted on. */
function masteredSong(name, patch) {
  const doc = loadSong(name);
  doc.songs[0].mastering = normaliseMastering({ ...defaultMastering(), on: true, ...patch });
  return doc;
}

test("a multichannel export carries the song's chain", async () => {
  const opts = { format: "5.1", outRate: SAMPLING_RATE, title: "WHEN" };
  const plain = await renderMultichannelAsync(loadSong("WHEN.taud"), 0, 2, opts);
  assert.equal(plain.mastered, false, "no chain, nothing to do");

  // A chain that is nothing but a scalar: at matching rates the resampler is a
  // copy, so the two files must differ by exactly that scalar on every channel.
  const quiet = await renderMultichannelAsync(
    masteredSong("WHEN.taud", { trimDb: -6 }), 0, 2, opts);
  assert.equal(quiet.mastered, true);

  const a = decode24(flatten(plain.blocks), 6);
  const b = decode24(flatten(quiet.blocks), 6);
  assert.equal(a.frames, b.frames);
  const g = 10 ** (-6 / 20);
  let worst = 0, moved = 0;
  for (let i = 0; i < a.out.length; i++) {
    worst = Math.max(worst, Math.abs(b.out[i] - a.out[i] * g));
    moved = Math.max(moved, Math.abs(b.out[i] - a.out[i]));
  }
  assert.ok(moved > 0.01, `the file did not change at all (${moved})`);
  assert.ok(worst < 1e-6, `off the declared trim by ${worst} — more than 24-bit rounding`);
});

test("…on every channel of an ambisonic export, and with the ceiling held", async () => {
  const opts = { format: "ambix1", outRate: SAMPLING_RATE };
  const doc = masteredSong("WHEN.taud", {
    trimDb: 24, limOn: true, limCeilingDb: -3, limReleaseMs: 60,
  });
  const r = await renderMultichannelAsync(doc, 0, 3, opts);
  assert.equal(r.mastered, true);
  const { out } = decode24(flatten(r.blocks), 4);

  const ceiling = 10 ** (-3 / 20);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  // 24-bit quantisation is the only thing allowed to poke through.
  assert.ok(peak <= ceiling + 1e-6, `${peak} over a ${ceiling} ceiling`);
  assert.ok(peak > ceiling * 0.9, `+24 dB of trim never reached the ceiling (${peak})`);
});

test("a chain whose only stage is width leaves a multichannel file alone", async () => {
  const opts = { format: "quad", outRate: SAMPLING_RATE };
  const plain = flatten((await renderMultichannelAsync(loadSong("WHEN.taud"), 0, 1, opts)).blocks);
  const wide = await renderMultichannelAsync(
    masteredSong("WHEN.taud", { widthOn: true, width: 2 }), 0, 1, opts);
  // The chain IS installed — it just has nothing that means anything here.
  assert.equal(wide.mastered, true);
  assert.deepEqual(flatten(wide.blocks), plain);
});
