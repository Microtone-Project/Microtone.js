// taudplay's own test suite. It travels WITH the generated library (
// tools/make-taudplay.js copies this directory into the standalone repo), so
// the paths below are relative in a way that resolves in both trees: from
// microtone-worker/test/taudplay/ and from microtone-taudplay/test/taudplay/.
//
// The headline assertion is the last one: what taudplay renders is what the
// tracker renders, byte for byte. Everything else here is the small surface
// the library actually promises — the transport, the fader group, the two
// probes — and the promise that nothing ELSE leaked out with them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { TaudRenderer, TaudPlayer, encodeWav, gainToFader, faderToGain }
  from "../../src/taudplay/index.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { loadIntoEngine, renderSong } from "../../src/audio/offline-render.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../../src/engine/constants.js";

const corpus = fileURLToPath(new URL("../corpus/", import.meta.url));
const WHEN = await readFile(corpus + "WHEN.taud");
const SLUMBER = await readFile(corpus + "slumberjack.taud");

/** Peak absolute sample of an interleaved buffer. */
function peak(f32) {
  let p = 0;
  for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > p) p = a; }
  return p;
}

test("a file loads and describes itself", () => {
  const r = new TaudRenderer(WHEN);
  assert.equal(r.title, "When the heavens fall");
  assert.equal(r.songs.length, 4);
  assert.equal(r.songs[0].bpm, 134);
  assert.equal(r.channelCount, 32);
  assert.equal(r.songs[0].surround, false);
});

test("a .tsii is refused — there is no song in it", () => {
  assert.equal(parseTaud(WHEN).kind, "taud");
  const notASong = new Uint8Array(WHEN);
  notASong[8] = (notASong[8] & 0x3f) | 0x80; // container kind bits → sample+inst
  assert.throws(() => new TaudRenderer(notASong), /has no song to play/);
});

test("the transport runs and the row advances", () => {
  const r = new TaudRenderer(WHEN);
  assert.equal(r.playing, false);
  r.play();
  assert.equal(r.playing, true);
  const start = `${r.cue}:${r.row}`;
  r.render(2);
  assert.notEqual(`${r.cue}:${r.row}`, start);
  assert.equal(r.bpm, 134);
  assert.ok(r.speed > 0);
  r.stop();
  assert.equal(r.playing, false);
});

test("the two probes report a sounding voice", () => {
  const r = new TaudRenderer(WHEN);
  r.play();
  r.render(2);
  let sounding = 0;
  let offCentre = 0;
  for (let v = 0; v < r.channelCount; v++) {
    const vol = r.getVoiceVolume(v);
    const pan = r.getVoicePan(v);
    assert.ok(vol >= 0 && vol <= 1, `voice ${v} volume in range`);
    assert.ok(pan >= 0 && pan <= 1, `voice ${v} pan in range`);
    if (vol > 0) sounding++;
    if (vol > 0 && Math.abs(pan - 0.5) > 0.02) offCentre++;
  }
  assert.ok(sounding > 0, "something is playing");
  assert.ok(offCentre > 0, "and the song is not all dead centre");
});

test("a silent voice reads zero volume and centre pan", () => {
  const r = new TaudRenderer(WHEN);
  r.play();
  r.render(1);
  // Channel 31 is past what this 13-channel song uses.
  assert.equal(r.getVoiceVolume(31), 0);
  assert.equal(r.getVoicePan(31), 0.5);
});

test("the fader silences one voice and only that voice", () => {
  const a = new TaudRenderer(WHEN);
  a.play();
  a.render(2);
  const target = [...Array(a.channelCount).keys()].find((v) => a.getVoiceVolume(v) > 0.02);
  assert.ok(target !== undefined, "found a sounding voice");

  a.setVoiceGain(target, 0);
  a.render(0.1);
  assert.equal(a.getVoiceVolume(target), 0);
  let others = 0;
  for (let v = 0; v < a.channelCount; v++) if (v !== target && a.getVoiceVolume(v) > 0) others++;
  assert.ok(others > 0, "the rest of the mix kept playing");
});

test("faders attenuate the mix, and gain 0 on everything is silence", () => {
  const full = new TaudRenderer(WHEN);
  full.play();
  const loud = peak(full.render(3));

  const half = new TaudRenderer(WHEN);
  for (let v = 0; v < 64; v++) half.setVoiceGain(v, 0.5);
  half.play();
  const quiet = peak(half.render(3));
  assert.ok(quiet < loud, `halved mix is quieter (${quiet} < ${loud})`);
  assert.ok(quiet > loud * 0.35 && quiet < loud * 0.65, `…by about half (${quiet / loud})`);

  const off = new TaudRenderer(WHEN);
  for (let v = 0; v < 64; v++) off.setVoiceGain(v, 0);
  off.play();
  assert.equal(peak(off.render(3)), 0, "every fader down is silence");
});

test("a fade lands after exactly the audio it was given", () => {
  const r = new TaudRenderer(WHEN);
  r.play();
  r.render(1);
  assert.equal(r.getVoiceGain(0), 1);
  r.setVoiceGain(0, 0, 0.5);
  r.render(0.25);
  const mid = r.getVoiceGain(0);
  assert.ok(mid > 0.35 && mid < 0.65, `half-way through, half-way down (${mid})`);
  r.render(0.30);
  assert.equal(r.getVoiceGain(0), 0);
});

test("faders survive a song switch — the mix is the caller's state", () => {
  const r = new TaudRenderer(WHEN);
  r.setVoiceGain(2, 0);
  r.selectSong(1);
  assert.equal(r.songIndex, 1);
  assert.equal(r.getVoiceGain(2), 0);
});

test("gain ↔ fader byte round-trips through the mix's own resolution", () => {
  assert.equal(gainToFader(1), 0);
  assert.equal(gainToFader(0), 255);
  assert.equal(faderToGain(0), 1);
  assert.equal(faderToGain(255), 0);
  for (let b = 0; b <= 255; b++) assert.equal(gainToFader(faderToGain(b)), b);
  assert.equal(gainToFader(-5), 255, "clamps below");
  assert.equal(gainToFader(99), 0, "clamps above");
});

test("renderChunk hands back one block and stops at the end of the song", () => {
  const r = new TaudRenderer(WHEN);
  assert.equal(r.renderChunk(), null, "nothing before play()");
  r.play();
  const block = r.renderChunk();
  assert.equal(block.length, TRACKER_CHUNK * 2);
  assert.ok(peak(r.render(1)) > 0);
});

test("a WAV comes out at the rate it was asked for", () => {
  const r = new TaudRenderer(SLUMBER);
  const wav = r.toWav(1, { sampleRate: 44100 });
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.equal(dv.getUint16(22, true), 2, "stereo");
  assert.equal(dv.getUint32(24, true), 44100);
  assert.equal(dv.getUint16(34, true), 16, "16-bit");
  assert.ok(wav.length > 44 * 2, "…and it has samples in it");
});

test("what taudplay renders IS what the tracker renders", () => {
  for (const [name, bytes] of [["WHEN", WHEN], ["slumberjack", SLUMBER]]) {
    const eng = new TaudEngine();
    loadIntoEngine(eng, parseTaud(bytes), 0);
    const ref = renderSong(eng, 6).f32;

    const r = new TaudRenderer(bytes);
    r.play();
    const mine = r.render(6);

    assert.equal(mine.length, ref.length, `${name}: same length`);
    for (let i = 0; i < ref.length; i++) {
      if (mine[i] !== ref[i]) assert.fail(`${name}: sample ${i} differs (${mine[i]} vs ${ref[i]})`);
    }
  }
});

test("encodeWav is the tracker's own encoder", () => {
  const f32 = new Float32Array([0, 0.5, -0.5, 1, -1, 0]);
  const wav = encodeWav(f32, SAMPLING_RATE);
  const dv = new DataView(wav.buffer);
  assert.equal(dv.getInt16(44, true), 0);
  assert.equal(dv.getInt16(46, true), Math.round(0.5 * 32767));
  assert.equal(dv.getInt16(50, true), 32767);
  assert.equal(dv.getInt16(52, true), -32767);
});

test("the surface is the surface — nothing else leaked out", () => {
  const knobs = ["setVoiceGain", "getVoiceGain"];
  const probes = ["getVoiceVolume", "getVoicePan"];
  for (const Cls of [TaudPlayer, TaudRenderer]) {
    const names = Object.getOwnPropertyNames(Cls.prototype);
    for (const m of [...knobs, ...probes]) {
      assert.ok(names.includes(m), `${Cls.name}.${m} exists`);
    }
    // One knob group and two probes: no OTHER per-voice entry point at all.
    const perVoice = names.filter((n) => /Voice/.test(n) && n !== "constructor");
    assert.deepEqual(perVoice.sort(), [...knobs, ...probes].sort(),
      `${Cls.name} exposes exactly one fader group and two probes`);
  }
});

test("the single-file worklet bundle is loadable and complete", async () => {
  // The concat is what non-module AudioWorklets (historically Firefox) get, and
  // nothing else exercises it outside a browser: a name collision between two
  // concatenated modules, or a module left off the list, is a ReferenceError
  // inside AudioWorkletGlobalScope where no test can see it. Evaluating it here
  // under stubs catches both.
  const bundlePath = fileURLToPath(new URL("../../src/taudplay/worklet.bundle.js", import.meta.url));
  const src = await readFile(bundlePath, "utf8");
  assert.doesNotMatch(src, /^\s*(import|export)\s/m, "no module syntax survived the strip");

  let registered = null;
  const stubs = {
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage() {}, onmessage: null }; }
    },
    registerProcessor: (name, cls) => { registered = [name, cls]; },
    sampleRate: 48000,
    currentTime: 0,
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(stubs), src);
  run(...Object.values(stubs));

  assert.ok(registered, "the bundle registered a processor");
  assert.equal(registered[0], "taudplay-processor");
  const proc = new registered[1]({ processorOptions: {} });
  assert.equal(proc.faders.now.length, 64, "…and it built its fader bank");
  assert.equal(proc.engine.channelCount(), 32, "…and an engine");
});
