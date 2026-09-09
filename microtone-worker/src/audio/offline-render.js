// Offline rendering — pure engine, runs identically in Node (tools/
// render-taud.js) and the browser (WAV export). Mirrors the JVM oracle's
// upload sequence exactly (taud.mjs uploadTaudFile order).

import { TaudEngine } from "../engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, MAX_VOICES, NUM_VOICES } from "../engine/constants.js";
import { MONITOR_BINAURAL } from "../engine/binaural.js";
import { resampleInterleaved } from "./resampler.js";

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

  for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
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

/** Encode a rendered f32 mix bus (engine rate) as a 16-bit stereo WAV at
 *  `outRate`; the 48 kHz default needs no resampling at all (item 108). */
function encodeWav(f32, outRate) {
  const pcm = resampleInterleaved(f32, 2, SAMPLING_RATE, outRate);
  const numSamples = pcm.length; // interleaved stereo samples
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 2, true);           // stereo
  dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 4, true); // byte rate (16-bit stereo)
  dv.setUint16(32, 4, true);           // block align
  dv.setUint16(34, 16, true);          // bits
  wstr(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return new Uint8Array(buf);
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

/** Offline-render a Document's song to a 16-bit stereo WAV, resampled to
 *  `outRate` (default 48 kHz), taken from the pre-dither float mix bus (no
 *  dithering). Returns {bytes, seconds, halted}. */
export function renderToWav(docLike, songIndex, maxSeconds, outRate = 48000, monitor = "fold") {
  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  applyMonitor(eng, monitor);
  const r = renderSong(eng, maxSeconds);
  return { bytes: encodeWav(r.f32, outRate), seconds: r.frames / SAMPLING_RATE, halted: r.halted };
}

/** Async twin of renderToWav — yields to the event loop so a progress UI can
 *  paint (`onProgress(frac)`) and `signal` can cancel. Returns the same shape,
 *  plus `aborted`; `bytes` is null when aborted. */
export async function renderToWavAsync(docLike, songIndex, maxSeconds,
                                       { outRate = 48000, onProgress = null, signal = null,
                                         monitor = "fold" } = {}) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  applyMonitor(eng, monitor);
  const r = await renderSongAsync(eng, maxSeconds, { onProgress, signal });
  if (r.aborted) return { bytes: null, seconds: r.frames / SAMPLING_RATE, halted: r.halted, aborted: true };
  return { bytes: encodeWav(r.f32, outRate), seconds: r.frames / SAMPLING_RATE, halted: r.halted, aborted: false };
}
