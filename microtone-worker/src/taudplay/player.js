// TaudPlayer — the browser half of taudplay. Owns the AudioContext and the
// worklet node, keeps the latest snapshot, and exposes the whole library:
// a transport, one fader per voice, and two numbers per voice to look at.
//
// Everything a tracker EDITOR needs and a player does not is absent by
// construction, not by configuration — there is no document model, no undo, no
// pattern access, no instrument editing, no jam bank, no analysis tap, no
// loudness metering, no stem or surround export. What is left is the part a
// game or a web page actually wants: press play, fade a voice, draw a meter.

import { parseTaud } from "../format/taud-parse.js";
import { SAMPLING_RATE } from "../engine/constants.js";
import {
  CMD, MSG,
  SNAP_PLAYING, SNAP_CUE, SNAP_ROW, SNAP_BPM, SNAP_TICK_RATE, SNAP_CHANNELS,
  SNAP_INT_MASK, SNAP_INT_ARGS,
  SNAP_HEADER, SNAP_V_ACTIVE, SNAP_V_VOLUME, SNAP_V_PAN, SNAP_V_STRIDE,
  SNAP_VOICES, SNAP_FLOATS,
} from "./protocol.js";
import { makeInterruptBank, setInterruptIn, dispatchInterrupts } from "./interrupts.js";
import { gainToFader, faderToGain } from "./faders.js";

const MODULE_WORKLET = new URL("./worklet.js", import.meta.url);
const BUNDLE_WORKLET = new URL("./worklet.bundle.js", import.meta.url);

export class TaudPlayer {
  constructor() {
    this.context = null;
    this.node = null;
    this.doc = null;          // the parsed file (kept for its song list)
    this.songIndex = 0;
    this.snapshot = new Float32Array(SNAP_FLOATS);
    this.snapshot[SNAP_CHANNELS] = 32;
    /** Called with the player as its argument each time a snapshot lands
     *  (≈60 Hz). Optional — polling the getters from rAF works just as well. */
    this.onSnapshot = null;
    /** Called after a load or song switch completes in the worklet. */
    this.onLoaded = null;
    /** Int0..IntF callbacks (setInterrupt). Sparse on purpose: an unset slot
     *  is a song event nobody is listening for, which costs nothing. */
    this._interrupts = makeInterruptBank();
    this._pendingUpload = false; // load() before init(): upload on init
    this.usedBundleFallback = false; // the module worklet was refused (Firefox)
    // Fader ramp mirror. The ramp itself runs in the worklet; this side keeps
    // the four numbers that describe it so `getVoiceGain` can report where a
    // fade has got to WITHOUT spending a third per-voice slot in the snapshot
    // on something the main thread already knows. The two clocks agree to
    // within the worklet's look-ahead, a few milliseconds.
    this._from = new Float64Array(64);
    this._to = new Float64Array(64);
    this._t0 = new Float64Array(64);  // context time the ramp started
    this._dur = new Float64Array(64); // seconds; 0 = already there
  }

  /** Voice `v`'s fader byte right now, interpolated along any live ramp. */
  _liveFader(v) {
    const dur = this._dur[v];
    if (dur <= 0) return this._to[v];
    const t = (this.context?.currentTime ?? 0) - this._t0[v];
    if (t >= dur) return this._to[v];
    if (t <= 0) return this._from[v];
    return this._from[v] + (this._to[v] - this._from[v]) * (t / dur);
  }

  // ── lifecycle ──

  /**
   * Build the AudioContext and the worklet node. Safe to call once; the
   * context starts suspended on most browsers, so call `resume()` from a user
   * gesture before anything is heard.
   *
   * `context` adopts an AudioContext you already own (a game usually has one);
   * `destination` routes the player's output somewhere other than the speakers
   * — a GainNode you automate, a convolver, an analyser. Both default to the
   * player making and using its own. `workletUrl` overrides where the processor
   * is fetched from, for a bundler that has moved it.
   */
  async init({ context = null, destination = null, snapshotIntervalMs = 16,
               workletUrl = null } = {}) {
    if (this.context) return this;
    // 48 kHz is the engine's own rate since it stopped being a 32 kHz device,
    // so asking for it means the worklet's resampler is never even built.
    this.context = context ?? new AudioContext({
      sampleRate: SAMPLING_RATE, latencyHint: "interactive",
    });
    if (workletUrl) {
      await this.context.audioWorklet.addModule(workletUrl);
    } else {
      try {
        await this.context.audioWorklet.addModule(MODULE_WORKLET);
      } catch {
        // Browsers whose AudioWorklet cannot import ES modules (historically
        // Firefox) get the committed single-file concat instead.
        await this.context.audioWorklet.addModule(BUNDLE_WORKLET);
        this.usedBundleFallback = true;
      }
    }
    this.node = new AudioWorkletNode(this.context, "taudplay-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { snapshotIntervalMs },
    });
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.node.connect(destination ?? this.context.destination);
    // load() is allowed before init() — parsing needs no audio graph, and a
    // game usually has the file long before it has a user gesture to start on.
    if (this._pendingUpload) {
      this._pendingUpload = false;
      this._post({ t: CMD.LOAD, doc: this.doc, songIndex: this.songIndex });
    }
    return this;
  }

  /** True once the context is actually running (a suspended one is silent). */
  get running() { return this.context?.state === "running"; }

  /** The context's real sample rate — 48 kHz unless the host refused, in which
   *  case the worklet is resampling the engine's own 48 kHz onto it. */
  get sampleRate() { return this.context?.sampleRate ?? 0; }

  /** Resume the context (call from a user gesture). */
  async resume() {
    if (this.context && this.context.state !== "running") await this.context.resume();
  }

  /** Release the audio graph. The player is unusable afterwards. */
  async close() {
    if (this.node) { this.node.disconnect(); this.node = null; }
    if (this.context) { await this.context.close(); this.context = null; }
  }

  // ── content ──

  /**
   * Parse and upload a .taud file. `bytes` is a Uint8Array or ArrayBuffer.
   * Returns the song list — `[{index, name, patterns, bpm, channels}]` — so a
   * caller can offer a chooser without reaching into the parsed document.
   *
   * Only full .taud files play: a .tsii (samples and instruments) or .tpif
   * (a bare pattern) has no song in it, and loading one throws.
   */
  async load(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = parseTaud(u8);
    if (doc.kind !== "taud") {
      throw new Error(`taudplay: .${doc.kind} has no song to play (need a full .taud)`);
    }
    this.doc = doc;
    this.songIndex = 0;
    if (this.node) this._post({ t: CMD.LOAD, doc, songIndex: 0 });
    else this._pendingUpload = true;
    return this.songs;
  }

  /** The loaded file's songs, as plain descriptors. Empty before a load. */
  get songs() {
    if (!this.doc) return [];
    return this.doc.songs.map((s, i) => ({
      index: i,
      name: this.doc.meta?.songMeta?.[i]?.name || `song ${i}`,
      patterns: s.patterns.length,
      bpm: s.bpm,
      channels: s.numVoices,
      surround: (s.surroundModel ?? 0) !== 0,
    }));
  }

  /** The file's own title, or null. */
  get title() { return this.doc?.meta?.projectName ?? null; }

  /** What the loaded FILE is, for a "now playing" line. Not a probe — none of
   *  it changes while the song runs. Null before a load. */
  get info() {
    if (!this.doc) return null;
    return {
      title: this.title,
      formatVersion: this.doc.fmtVer,
      channels: this.doc.is64Channel ? 64 : 32,
      songCount: this.doc.songs.length,
      patchedInstruments: this.doc.ixmp.length,
    };
  }

  /** Switch song. Faders carry over — the mix is the caller's state. */
  selectSong(index) {
    if (!this.doc || index < 0 || index >= this.doc.songs.length) return;
    this.songIndex = index;
    this._post({ t: CMD.SELECT_SONG, songIndex: index });
  }

  // ── transport ──

  play() { this._post({ t: CMD.PLAY }); }
  stop() { this._post({ t: CMD.STOP }); }
  seekCue(cue) { this._post({ t: CMD.SEEK_CUE, cue }); }

  /** Master volume, 0..1. Not a per-voice fader: this is the whole mix. */
  setVolume(gain) {
    const g = gain < 0 ? 0 : gain > 1 ? 1 : gain;
    this._post({ t: CMD.SET_VOLUME, volume: Math.round(g * 255) });
  }

  /**
   * Monitor a SURROUND song through a head model instead of folding it to
   * stereo, so height and front/back are audible on headphones. A stereo song
   * has no object bus and ignores this.
   */
  setBinaural(on) { this._post({ t: CMD.SET_MONITOR, mode: on ? 1 : 0 }); }

  // ── the knobs: one fader per voice ──

  /**
   * Set voice `v`'s gain (1 = as written, 0 = silent), optionally fading to it
   * over `fadeMs`. The fade is applied in the worklet at chunk rate — every
   * 2.7 ms at 48 kHz — so a slow fade is smooth without the caller having to
   * drive it frame by frame.
   *
   * The voice's NNA ghosts and metainstrument layer children follow it: a
   * faded-out channel takes everything it spawned with it, which is what makes
   * this usable as a contextual music mixer rather than a mute button.
   */
  setVoiceGain(v, gain, fadeMs = 0) {
    if (v < 0 || v >= 64) return;
    const fader = gainToFader(gain);
    this._from[v] = this._liveFader(v); // a new fade starts where this one is
    this._to[v] = fader;
    this._t0[v] = this.context?.currentTime ?? 0;
    this._dur[v] = Math.max(0, fadeMs) / 1000;
    const rate = this.context ? this.context.sampleRate : SAMPLING_RATE;
    this._post({
      t: CMD.SET_FADER, voice: v, value: fader,
      samples: Math.max(0, Math.round((fadeMs / 1000) * rate)),
    });
  }

  /** Voice `v`'s fader gain right now — mid-fade, that is where the fade has
   *  got to, not where it is going. Byte-quantised, like the mix itself. */
  getVoiceGain(v) {
    return v >= 0 && v < 64 ? faderToGain(Math.round(this._liveFader(v))) : 1;
  }

  // ── interrupts: the song calling out ──

  /**
   * Register the callback for interrupt `n` (0…15) — `fn(arg)`, where `arg` is
   * the 0…65535 the song's `:` named on the marker row (0 where it named none).
   * Pass `null` to unregister. Callbacks run on the main thread, from the
   * snapshot that reported the fire (≈ every 16 ms), so they may do anything a
   * normal event handler may: start an animation, swap a sprite, print a line.
   *
   * A song fires an interrupt by putting `Int0`…`IntF` in a NOTE column. It
   * makes no sound and disturbs no channel — it is the song saying something to
   * the program that is playing it, in time with the music. An interrupt that
   * fires more than once inside one snapshot window arrives once, carrying the
   * last argument.
   */
  setInterrupt(n, fn) { setInterruptIn(this._interrupts, n, fn); }

  /** Drop every registered interrupt callback. */
  clearInterrupts() { this._interrupts.fill(null); }

  // ── the probes: two per voice ──

  /** How loud voice `v` is RIGHT NOW, 0..1 — envelope, fadeout, volume column
   *  and this library's own fader, which is the whole gain the mixer applies.
   *  0 for a silent channel. */
  getVoiceVolume(v) {
    if (v < 0 || v >= SNAP_VOICES) return 0;
    const o = SNAP_HEADER + v * SNAP_V_STRIDE;
    return this.snapshot[o + SNAP_V_ACTIVE] ? this.snapshot[o + SNAP_V_VOLUME] : 0;
  }

  /** Where voice `v` sits in the stereo image, 0 (left) … 0.5 … 1 (right).
   *  A surround song reports where the monitor downmix puts the voice. */
  getVoicePan(v) {
    if (v < 0 || v >= SNAP_VOICES) return 0.5;
    const o = SNAP_HEADER + v * SNAP_V_STRIDE;
    return this.snapshot[o + SNAP_V_ACTIVE] ? this.snapshot[o + SNAP_V_PAN] : 0.5;
  }

  // ── transport read-out (not per-voice; a UI needs somewhere to start) ──

  get playing() { return this.snapshot[SNAP_PLAYING] !== 0; }
  get cue() { return this.snapshot[SNAP_CUE] | 0; }
  get row() { return this.snapshot[SNAP_ROW] | 0; }
  get bpm() { return this.snapshot[SNAP_BPM] | 0; }
  get speed() { return this.snapshot[SNAP_TICK_RATE] | 0; }
  get channelCount() { return this.snapshot[SNAP_CHANNELS] | 0; }

  // ── internals ──

  _post(m) { this.node?.port.postMessage(m); }

  _onMessage(m) {
    switch (m.t) {
      case MSG.SNAPSHOT: {
        this.snapshot.set(new Float32Array(m.buffer));
        this.node.port.postMessage({ t: CMD.SNAPSHOT_RETURN, buffer: m.buffer }, [m.buffer]);
        // Before onSnapshot: an interrupt is a song EVENT, and a listener that
        // reads the transport in the same frame should see the world the event
        // already happened in.
        dispatchInterrupts(this._interrupts, this.snapshot, SNAP_INT_MASK, SNAP_INT_ARGS);
        this.onSnapshot?.(this);
        break;
      }
      case MSG.LOADED:
        this.snapshot[SNAP_CHANNELS] = m.channelCount;
        this.onLoaded?.(this);
        break;
    }
  }
}
