// TaudRenderer — taudplay without Web Audio. Same file, same songs, same
// knobs and the same two probes, pulled by the caller instead of by an audio
// callback: `renderChunk()` hands back one block of interleaved stereo float
// and the probes describe the state at the end of it.
//
// This is the half that runs in Node (render a song to a WAV, bounce a stem
// pack, test a mix in CI) and it is also the half a browser can use with no
// AudioContext at all — for an OfflineAudioContext bounce, or to draw a
// waveform of a song nobody is listening to yet.

import { parseTaud } from "../format/taud-parse.js";
import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../engine/constants.js";
import { MONITOR_BINAURAL, MONITOR_FOLD } from "../engine/binaural.js";
import { displayPanByte } from "../engine/spatial.js";
import { loadIntoEngine, encodeWav } from "../audio/offline-render.js";
import { FaderBank, gainToFader, faderToGain } from "./faders.js";
import { makeInterruptBank, setInterruptIn, dispatchInterruptsFromState } from "./interrupts.js";

/** One rendered block of interleaved stereo float, reused between calls. */
const CHUNK_FLOATS = TRACKER_CHUNK * 2;

export class TaudRenderer {
  /**
   * `bytes` is a full .taud file. `songIndex` picks the song, `binaural` runs a
   * SURROUND song through the head model instead of folding it to stereo.
   */
  constructor(bytes, { songIndex = 0, binaural = false } = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = parseTaud(u8);
    if (doc.kind !== "taud") {
      throw new Error(`taudplay: .${doc.kind} has no song to play (need a full .taud)`);
    }
    this.doc = doc;
    this.engine = new TaudEngine();
    this.faders = new FaderBank();
    this._interrupts = makeInterruptBank();
    this.monitor = binaural ? MONITOR_BINAURAL : MONITOR_FOLD;
    this.songIndex = -1;
    this._u8 = new Uint8Array(CHUNK_FLOATS);   // the engine's dithered output
    this._out = new Float32Array(CHUNK_FLOATS); // …and the float bus we hand back
    this.selectSong(songIndex);
  }

  /** The file's songs, as plain descriptors (identical to TaudPlayer.songs). */
  get songs() {
    return this.doc.songs.map((s, i) => ({
      index: i,
      name: this.doc.meta?.songMeta?.[i]?.name || `song ${i}`,
      patterns: s.patterns.length,
      bpm: s.bpm,
      channels: s.numVoices,
      surround: (s.surroundModel ?? 0) !== 0,
    }));
  }

  get title() { return this.doc.meta?.projectName ?? null; }
  get channelCount() { return this.engine.channelCount(); }
  get playing() { return this.engine.isPlaying(0); }
  get cue() { return this._ts().cuePos; }
  get row() { return this._ts().rowIndex; }
  get bpm() { return this.engine.playheads[0].bpm; }
  get speed() { return this.engine.playheads[0].tickRate; }

  selectSong(index) {
    if (index < 0 || index >= this.doc.songs.length) throw new RangeError("songIndex out of range");
    this.songIndex = index;
    this.engine.stop(0);
    loadIntoEngine(this.engine, this.doc, index);
    this.engine.setMonitorMode(0, this.monitor);
    this.faders.dirty = true; // a fresh upload zeroed the voices' faders
    this.faders.writeInto(this._ts());
  }

  // ── transport ──

  play() {
    this.engine.resetSampleFxState(0);
    this.engine.setCuePosition(0, 0);
    this.engine.setTrackerRow(0, 0);
    this.engine.play(0);
  }
  stop() { this.engine.stop(0); }
  seekCue(cue) {
    this.engine.setCuePosition(0, Math.max(0, cue | 0));
    this.engine.setTrackerRow(0, 0);
  }
  /** Master volume, 0..1 — the whole mix, not a voice. */
  setVolume(gain) {
    const g = gain < 0 ? 0 : gain > 1 ? 1 : gain;
    this.engine.setMasterVolume(0, Math.round(g * 255));
  }

  // ── the knobs ──

  /** Voice `v` to `gain` (1 = as written, 0 = silent), optionally faded there
   *  over `fadeSeconds` of RENDERED time — the ramp advances as chunks are
   *  pulled, so it lands after exactly that much audio either way. */
  setVoiceGain(v, gain, fadeSeconds = 0) {
    this.faders.set(v, gainToFader(gain), Math.max(0, Math.round(fadeSeconds * SAMPLING_RATE)));
    this.faders.writeInto(this._ts());
  }
  /** Voice `v`'s fader gain right now — mid-fade, where the fade has got to.
   *  The browser half reports the same thing off its own ramp mirror. */
  getVoiceGain(v) { return faderToGain(Math.round(this.faders.now[v])); }

  // ── interrupts: the song calling out ──

  /**
   * Register the callback for interrupt `n` (0…15) — `fn(arg)`, where `arg` is
   * the 0…65535 the song's `:` named on the marker row. `null` unregisters.
   *
   * Here the callbacks fire from `renderChunk()`, on the calling thread, once
   * per rendered block — so a bounce that wants a cue sheet gets one at block
   * resolution (2.7 ms at 48 kHz) rather than the browser's ~16 ms, and gets it
   * deterministically: the same file renders the same cues every time.
   */
  setInterrupt(n, fn) { setInterruptIn(this._interrupts, n, fn); }

  /** Drop every registered interrupt callback. */
  clearInterrupts() { this._interrupts.fill(null); }

  // ── the probes ──

  /** How loud voice `v` was at the end of the last chunk, 0..1. */
  getVoiceVolume(v) {
    const voice = this._ts().voices[v];
    if (!voice || !voice.active) return 0;
    const effEnvVol = voice.volEnvOn ? voice.envVolMix : 1.0;
    const faderGain = (255 - voice.fader) / 255.0;
    const ev = effEnvVol * voice.fadeoutVolume * voice.currentMixVolume * faderGain;
    return ev < 0 ? 0 : ev > 1 ? 1 : ev;
  }

  /** Where voice `v` sat, 0 (left) … 0.5 … 1 (right). */
  getVoicePan(v) {
    const ts = this._ts();
    const voice = ts.voices[v];
    if (!voice || !voice.active) return 0.5;
    return displayPanByte(ts, v, voice) / 255.0;
  }

  // ── rendering ──

  /**
   * Render one block. Returns an interleaved stereo Float32Array of
   * TRACKER_CHUNK frames — a view onto an internal buffer, valid until the next
   * call — or null once the song has halted.
   */
  renderChunk() {
    if (!this.engine.isPlaying(0)) return null;
    this.faders.advance(TRACKER_CHUNK);
    this.faders.writeInto(this._ts());
    if (this.engine.renderChunk(0, this._u8) === null) return null;
    const ts = this._ts();
    // The block just rendered is the block the interrupts fired in, so they are
    // dispatched before it is handed over — a caller writing a cue sheet as it
    // bounces stamps them at the right frame.
    dispatchInterruptsFromState(this._interrupts, ts);
    const out = this._out;
    for (let n = 0; n < TRACKER_CHUNK; n++) {
      out[n * 2] = ts.mixLeft[n];
      out[n * 2 + 1] = ts.mixRight[n];
    }
    return out;
  }

  /**
   * Render up to `seconds` from the current position into one interleaved
   * stereo Float32Array at the engine's own rate. `onChunk(renderer, frame)` is
   * called after each block, which is where a caller reads the probes if it
   * wants a fader automation curve rather than a static mix.
   */
  render(seconds, onChunk = null) {
    const maxFrames = Math.round(seconds * SAMPLING_RATE);
    const nChunks = Math.ceil(maxFrames / TRACKER_CHUNK);
    const acc = new Float32Array(nChunks * CHUNK_FLOATS);
    let frames = 0;
    for (let c = 0; c < nChunks; c++) {
      const block = this.renderChunk();
      if (block === null) break;
      acc.set(block, c * CHUNK_FLOATS);
      frames += TRACKER_CHUNK;
      onChunk?.(this, frames);
    }
    return acc.subarray(0, (frames / TRACKER_CHUNK) * CHUNK_FLOATS);
  }

  /**
   * Play from the top and encode `seconds` as a 16-bit stereo WAV at
   * `sampleRate` (48 kHz needs no resampling at all). Returns a Uint8Array
   * ready to write to disk or hand to a Blob.
   */
  toWav(seconds, { sampleRate = 48000, onChunk = null } = {}) {
    this.play();
    return encodeWav(this.render(seconds, onChunk), sampleRate);
  }

  _ts() { return this.engine.playheads[0].trackerState; }
}

/** Interleaved stereo float at the engine rate → a 16-bit stereo WAV at
 *  `outRate`. Re-exported from the tracker's own exporter, so a file written
 *  here is byte-for-byte the file the tracker would have written. */
export { encodeWav };
