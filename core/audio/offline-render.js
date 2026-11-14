// Offline rendering — pure engine, runs identically in Node (tools/
// render-taud.js) and the browser (WAV export). Uploads in taud.mjs's
// uploadTaudFile order, the one every host uses.

import { TaudEngine } from "../engine/engine.js";
import {
  TRACKER_CHUNK, SAMPLING_RATE, MAX_VOICES, NUM_VOICES, MONITOR_BINAURAL,
} from "../engine/constants.js";
import { instantiateEngine } from "../engine/wasm-module.js";

/**
 * The two stereo WAV characters. CLEAN is 16-bit with a plain TPDF dither
 * of one LSB; GRITTY is 8-bit through the device's own noise-shaped dither —
 * at the engine's rate, the very bytes the device would have played.
 */
export const WAV_CLEAN = "clean";
export const WAV_GRITTY = "gritty";

/** Load a parsed .taud (or Document-adapted) song into a fresh engine. */
export function loadIntoEngine(eng, doc, songIndex = 0) {
  const song = doc.songs[songIndex];
  if (!song) throw new Error("songIndex out of range");

  eng.set64ChannelMode(doc.is64Channel);
  // Before any pattern upload: it decides how those bytes are read (§5.5).
  eng.setCellFormat(doc.wideCells ?? (doc.fmtVer ?? 2) >= 3);
  if (doc.sampleInstImage) eng.uploadSampleInstBlob(doc.sampleInstImage);

  for (let p = 0; p < song.patterns.length; p++) eng.uploadPattern(p, song.patterns[p]);

  const chans = doc.is64Channel ? MAX_VOICES : NUM_VOICES;
  const cueBytes = new Uint8Array(chans * 2);
  for (let c = 0; c < song.cues.length; c++) {
    const words = song.cues[c];
    for (let ch = 0; ch < chans; ch++) {
      cueBytes[ch * 2] = words[ch] & 0xff;
      cueBytes[ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
    }
    eng.uploadCue(c, cueBytes);
  }

  eng.setTrackerMode(0);
  eng.setBPM(0, song.bpm);
  eng.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
  eng.setTuning(0, song.tuningBaseNote, song.tuningFreq);
  eng.setTrackerMixerFlags(0, song.globalFlags);
  eng.setSurroundModel(0, song.surroundModel ?? 0);
  eng.setSongGlobalVolume(0, song.globalVolume);
  eng.setSongMixingVolume(0, song.mixingVolume);
  eng.setMasterVolume(0, 255);
  // The song's mastering chain (item 178). An exported file is exactly what a
  // conforming player would produce, so the chain belongs on every render path,
  // not only on the one the editor listens to.
  eng.setMastering(0, song.mastering ?? doc.meta?.mastering?.[songIndex] ?? null);
  // …and the instruments' mixing chains (item 217), for the same reason.
  eng.setImix(doc.imix ?? []);
  // …and the lyric instruments' lyrics (item 280): which syllable a note sings.
  eng.setLyrics(doc.lyrics ?? []);

  for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
  // …and the instruments' pitch extensions (§9.18): what the records and the
  // patches above could not hold of their pitches.
  eng.setPitchExt(doc.pitchExt ?? null);
}

/** Render up to `seconds`; returns U8 device output + f32 mix-bus tap. */
export function renderSong(eng, seconds) {
  const maxFrames = seconds * SAMPLING_RATE;
  const nChunks = Math.ceil(maxFrames / TRACKER_CHUNK);
  const u8out = new Uint8Array(nChunks * TRACKER_CHUNK * 2);
  const f32out = new Float32Array(nChunks * TRACKER_CHUNK * 2);
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;

  eng.setCuePosition(0, 0);
  eng.play(0);

  let frames = 0;
  let chunkIdx = 0;
  let halted = false;
  while (frames < maxFrames) {
    if (!eng.isPlaying(0)) { halted = true; break; }
    if (eng.renderChunk(0, chunk) === null) { halted = true; break; }
    u8out.set(chunk, chunkIdx * TRACKER_CHUNK * 2);
    for (let n = 0; n < TRACKER_CHUNK; n++) {
      f32out[(chunkIdx * TRACKER_CHUNK + n) * 2] = ts.mixLeft[n];
      f32out[(chunkIdx * TRACKER_CHUNK + n) * 2 + 1] = ts.mixRight[n];
    }
    frames += TRACKER_CHUNK;
    chunkIdx++;
  }

  return {
    u8: u8out.subarray(0, chunkIdx * TRACKER_CHUNK * 2),
    f32: f32out.subarray(0, chunkIdx * TRACKER_CHUNK * 2),
    frames,
    halted,
  };
}

/**
 * Same as renderSong but batched + async: yields to the event loop every
 * `yieldMs` of wall time so a progress UI can paint (the render is otherwise a
 * multi-second main-thread block). `onProgress(frac 0..1)` is called at each
 * yield; `signal` (AbortSignal) stops early. Bit-identical output to renderSong
 * for the same input (chunk granularity is decoupled from timing). */
export async function renderSongAsync(eng, seconds, { onProgress = null, signal = null, yieldMs = 60 } = {}) {
  const maxFrames = seconds * SAMPLING_RATE;
  const nChunks = Math.ceil(maxFrames / TRACKER_CHUNK);
  const u8out = new Uint8Array(nChunks * TRACKER_CHUNK * 2);
  const f32out = new Float32Array(nChunks * TRACKER_CHUNK * 2);
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;

  eng.setCuePosition(0, 0);
  eng.play(0);

  let frames = 0;
  let chunkIdx = 0;
  let halted = false;
  let aborted = false;
  let lastYield = (typeof performance !== "undefined" ? performance.now() : Date.now());
  while (frames < maxFrames) {
    if (signal?.aborted) { aborted = true; break; }
    if (!eng.isPlaying(0)) { halted = true; break; }
    if (eng.renderChunk(0, chunk) === null) { halted = true; break; }
    u8out.set(chunk, chunkIdx * TRACKER_CHUNK * 2);
    for (let n = 0; n < TRACKER_CHUNK; n++) {
      f32out[(chunkIdx * TRACKER_CHUNK + n) * 2] = ts.mixLeft[n];
      f32out[(chunkIdx * TRACKER_CHUNK + n) * 2 + 1] = ts.mixRight[n];
    }
    frames += TRACKER_CHUNK;
    chunkIdx++;

    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - lastYield >= yieldMs) {
      lastYield = now;
      onProgress?.(Math.min(frames / maxFrames, 1));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);

  return {
    u8: u8out.subarray(0, chunkIdx * TRACKER_CHUNK * 2),
    f32: f32out.subarray(0, chunkIdx * TRACKER_CHUNK * 2),
    frames,
    halted,
    aborted,
  };
}

/** Encode a rendered f32 mix bus (engine rate) as a stereo WAV at `outRate`;
 *  the 48 kHz default needs no resampling at all (item 108). `quality` is
 *  WAV_CLEAN (16-bit, TPDF-dithered) or WAV_GRITTY (8-bit, noise-shaped like
 *  the device). Either dither starts afresh, so a render is one file every time.
 *  Exported for taudplay (item 179), whose renderer writes the same files. */
export function encodeWav(f32, outRate = 48000, quality = WAV_CLEAN) {
  // The engine's own encoder (player.c taud_encode_wav_quality): its resampler
  // and both quantisers, the very ones the device and the Mastering view's
  // census use. An instance of its own, dropped afterwards, so the memory a
  // long render needs is given back.
  const x = instantiateEngine();
  const n = f32.length;
  const src = x.malloc(n * 4) >>> 0;
  const lenAt = x.malloc(4) >>> 0;
  if (!src || !lenAt) throw new Error("taud engine: out of memory");
  new Float32Array(x.memory.buffer, src, n).set(f32);
  const wav = x.taud_encode_wav_quality(src, n >> 1, SAMPLING_RATE, outRate,
    quality === WAV_GRITTY ? 1 : 0, lenAt) >>> 0;
  if (!wav) throw new Error("taud engine: out of memory");
  return new Uint8Array(x.memory.buffer, wav, new Uint32Array(x.memory.buffer, lenAt, 1)[0]).slice();
}

/**
 * Stereo downmix mode for the exports (#998.3). "fold" is the pan-law fold the
 * device has always used; "binaural" runs the surround song through the head
 * model, so an ordinary stereo file carries the height and front/back the
 * composer heard. A stereo SONG has no object bus, so it ignores this.
 */
function applyMonitor(eng, monitor) {
  if (monitor === "binaural") eng.setMonitorMode(0, MONITOR_BINAURAL);
}

/** Offline-render a Document's song to a stereo WAV, resampled to `outRate`
 *  (default 48 kHz), taken from the pre-dither float mix bus and quantised as
 *  `quality` says (encodeWav). Returns {bytes, seconds, halted}. */
export function renderToWav(docLike, songIndex, maxSeconds, outRate = 48000, monitor = "fold",
                            quality = WAV_CLEAN, makeEngine = null) {
  const eng = makeEngine !== null ? makeEngine() : new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  applyMonitor(eng, monitor);
  const r = renderSong(eng, maxSeconds);
  return { bytes: encodeWav(r.f32, outRate, quality), seconds: r.frames / SAMPLING_RATE, halted: r.halted };
}

/** Async twin of renderToWav — yields to the event loop so a progress UI can
 *  paint (`onProgress(frac)`) and `signal` can cancel. Returns the same shape,
 *  plus `aborted`; `bytes` is null when aborted. */
export async function renderToWavAsync(docLike, songIndex, maxSeconds,
                                       { outRate = 48000, onProgress = null, signal = null,
                                         monitor = "fold", quality = WAV_CLEAN, makeEngine = null } = {}) {
  // `makeEngine` lets a host supply the engine object (one it has set up, or
  // the bare wasm-engine.js); by default it is engine.js's TaudEngine.
  const eng = makeEngine !== null ? makeEngine() : new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  applyMonitor(eng, monitor);
  const r = await renderSongAsync(eng, maxSeconds, { onProgress, signal });
  if (r.aborted) return { bytes: null, seconds: r.frames / SAMPLING_RATE, halted: r.halted, aborted: true };
  return {
    bytes: encodeWav(r.f32, outRate, quality), seconds: r.frames / SAMPLING_RATE, halted: r.halted, aborted: false,
  };
}
