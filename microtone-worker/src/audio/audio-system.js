// AudioSystem — main-thread side of the worklet: AudioContext lifecycle,
// command senders shaped like the TSVM `audio.*` API, and the snapshot store.
//
// The main thread owns the canonical document; the worklet holds a playback
// copy fed by upload commands (exactly how taut.js treats the TSVM device).
// Worklet state arrives as recycled snapshots (~16 ms); reads are synchronous
// against the latest snapshot, so UI code keeps taut.js's synchronous idiom.

import {
  CMD, MSG,
  SNAP_CUE_POS, SNAP_ROW_INDEX, SNAP_BPM, SNAP_TICK_RATE, SNAP_FLAGS,
  SNAP_INTERRUPT_MASK, SNAP_CHANNEL_COUNT, SNAP_HEADER_SIZE,
  SNAP_V_ACTIVE, SNAP_V_EFF_VOL, SNAP_V_EFF_PAN, SNAP_V_NOTE, SNAP_V_INST,
  SNAP_V_AZIMUTH, SNAP_V_ELEVATION,
  SNAP_V_SAMPLE_POS, SNAP_V_SAMPLE_PTR, SNAP_V_SAMPLE_LEN,
  SNAP_V_ENV_VOL_IDX, SNAP_V_ENV_VOL_TIME, SNAP_V_ENV_PAN_IDX, SNAP_V_ENV_PAN_TIME,
  SNAP_V_ENV_PITCH_IDX, SNAP_V_ENV_PITCH_TIME, SNAP_V_ENV_FILTER_IDX, SNAP_V_ENV_FILTER_TIME,
  SNAP_VOICE_STRIDE, SNAP_FLOATS, SNAP_SAB_BYTES, SNAP_GLOBAL_VOLUME,
  SNAP_V_FUNK_WINDOW, SNAP_V_FUNK_POS, SNAP_V_FUNK_LEN, SNAP_V_FUNK_MODE,
  SNAP_V_MOD_FUNK_WINDOW,
  SNAP_AN_METERS, SNAP_AN_FRAMES, SNAP_AN_FIELD,
  SNAP_AN_CORR_LL, SNAP_AN_CORR_RR, SNAP_AN_CORR_LR, SNAP_AN_RING_WRITE,
  SNAP_METER_BASE, SNAP_METER_STRIDE,
  SNAP_M_PEAK, SNAP_M_TRUE_PEAK, SNAP_M_MEAN_SQUARE, SNAP_M_CLIP,
  SNAP_SCOPE_BASE,
  SNAP_MM_FRAMES, SNAP_MM_COMP_GR, SNAP_MM_LIM_GR, SNAP_MM_HIST_TOTAL,
  SNAP_MM_BASE, SNAP_MM_SUM_Z, SNAP_MM_CH, SNAP_MM_C_PEAK, SNAP_MM_C_TRUE_PEAK,
  SNAP_MM_C_MEAN_SQUARE, SNAP_MM_C_CLIP, SNAP_MM_C_STRIDE, SNAP_MM_STAGE_STRIDE,
  SNAP_MM_STAGES, SNAP_HIST_BASE, SNAP_HIST_BINS,
  SNAP_MM_SPEC_WRITE, SNAP_SPEC_BASE, SNAP_SPEC_FRAMES,
  SNAP_MM_HIST_DEPTH, SNAP_MM_HIST_USED, SNAP_MM_HIST_MIN, SNAP_MM_HIST_MAX,
  SNAP_MM_HIST_ENTROPY,
} from "../worklet/protocol.js";
import {
  NUM_VOICES, TOTAL_VOICES, JAM_VOICES, JAM_VOICE_BASE,
  PATTERN_BYTES, PATTERN_BYTES_WIDE,
} from "../engine/constants.js";
import { AR_SAB_BYTES } from "./audio-ring.js";
import { ANALYSIS_OFF, SCOPE_FRAMES, SCOPE_CHANNELS } from "../engine/analysis.js";
import { DEFAULT_BIT_DEPTH } from "../engine/loudness.js";

const WORKLET_MODULE = new URL("../worklet/taud-processor.js", import.meta.url);
const WORKLET_BUNDLE = new URL("../worklet/taud-processor.bundle.js", import.meta.url);
const RENDER_WORKER = new URL("./render.worker.js", import.meta.url);

export class AudioSystem {
  constructor() {
    this.context = null;
    this.node = null;
    this.snapshot = new Float32Array(SNAP_FLOATS);
    this.snapshot[SNAP_CHANNEL_COUNT] = NUM_VOICES;
    this.interruptMask = 0; // accumulated between pollTrackerInterrupts calls
    this.onSnapshot = null; // optional callback(snapshot Float32Array; postMessage path only)
    this.usedBundleFallback = false;
    this.usingSab = false;  // shared-memory snapshots (crossOriginIsolated deploys)
    this.sabI32 = null;     // Int32Array view over the SAB interrupt latch
    this.worker = null;         // Tier 2 render Worker (isolated hosts); null in render mode
    this.usingWorker = false;   // engine renders off the audio thread (Tier 2)
    this._cueHighWater = 0;     // highest cue index+1 ever uploaded to the engine
                                // (the cueSheet persists across loads — blank the
                                // stale tail when a shorter song loads over it)
    this._patternHighWater = 0; // highest pattern slot+1 ever uploaded (item 174):
                                // the engine's pattern store is just as persistent
                                // as the cueSheet — same stale-tail trouble, same fix
    this.engineTarget = null;   // where engine commands go: worklet port or the worker
    this.invertMasks = new Map(); // slot → Uint8Array (latest queried S$Fx invert mask)
    this.sampleMods = new Map(); // slot → notefx 2/3 modification state (item 130)
    this.modMasks = new Map();   // slot → Uint8Array (its inversion mask)
    this.wideCells = false; // format v3's 16-byte cell (set by loadDocument)
    this.monitorMode = 0;   // #998.3 fold/binaural — re-sent on every song load
    this.analysisTarget = ANALYSIS_OFF; // item 98 master-strip tap; the strip owns it
    this.masterMeterOn = false; // item 178 Mastering-view tap; that view owns it
    this.masterMeterDepth = DEFAULT_BIT_DEPTH; // …and which output its census describes
    this.profile = null;    // latest worklet profiler report (opt-in; null when off)
    this.onProfile = null;  // optional callback(profile) when a report arrives
  }

  /** Create the context + node. Must be called once; audio starts suspended
   *  until resume() is called from a user gesture.
   *  Test knobs: forceBundle loads the single-file worklet concat; sampleRate
   *  overrides the context rate (exercises the engine→context resampler —
   *  at the default 48 kHz the engine's rate IS the context rate). */
  async init({ snapshotIntervalMs = 16, forceBundle = false, sampleRate = 48000, profile = false } = {}) {
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
    } catch {
      ctx = new AudioContext({ latencyHint: "interactive" }); // resampler path
    }
    this.context = ctx;

    if (forceBundle) {
      await ctx.audioWorklet.addModule(WORKLET_BUNDLE);
      this.usedBundleFallback = true;
    } else {
      try {
        await ctx.audioWorklet.addModule(WORKLET_MODULE);
      } catch (e) {
        // Firefox (no module-worklet import support): committed single-file concat.
        await ctx.audioWorklet.addModule(WORKLET_BUNDLE);
        this.usedBundleFallback = true;
      }
    }

    this.node = new AudioWorkletNode(ctx, "taud-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { snapshotIntervalMs, profile },
    });
    this.node.port.onmessage = (e) => this._onEngineMessage(e.data);
    this.node.connect(ctx.destination);
    this.engineTarget = this.node.port; // render mode: engine lives in the worklet

    // On cross-origin-isolated pages (COOP/COEP) we get SharedArrayBuffer, so:
    //   1. snapshots live in shared memory (no message traffic), and
    //   2. Tier 2 — a render Worker hosts the engine and streams audio into a
    //      SAB ring, leaving the AudioWorklet to only resample+copy (it can
    //      never overrun, whatever the channel/voice load). Non-isolated hosts
    //      keep the engine in the worklet (render mode) with postMessage snapshots.
    if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      const snapSab = new SharedArrayBuffer(SNAP_SAB_BYTES);
      const view = new Float32Array(snapSab, 0, SNAP_FLOATS);
      view.set(this.snapshot); // carry the pre-init defaults (channel count)
      this.snapshot = view;
      this.sabI32 = new Int32Array(snapSab, SNAP_FLOATS * 4, 1);
      this.usingSab = true;

      try {
        this.worker = new Worker(RENDER_WORKER, { type: "module" });
        this.worker.onmessage = (e) => this._onEngineMessage(e.data);
        const audioSab = new SharedArrayBuffer(AR_SAB_BYTES);
        this.node.port.postMessage({ t: CMD.USE_AUDIO_SAB, sab: audioSab }); // worklet → consume
        this.worker.postMessage({ t: CMD.USE_SAB, sab: snapSab });           // worker fills snapshots
        this.worker.postMessage({ t: CMD.USE_AUDIO_SAB, sab: audioSab });    // worker produces into the ring
        this.worker.postMessage({ t: CMD.INIT, snapshotIntervalMs });
        this.engineTarget = this.worker; // route engine commands to the worker
        this.usingWorker = true;
      } catch (e) {
        // Module Worker unavailable → keep the engine in the worklet, just with
        // SAB snapshots (the pre-Tier-2 isolated path).
        this.worker = null;
        this.node.port.postMessage({ t: CMD.USE_SAB, sab: snapSab });
        this.node.port.postMessage({ t: CMD.INIT, snapshotIntervalMs });
      }
    } else {
      this.node.port.postMessage({ t: CMD.INIT, snapshotIntervalMs });
    }
    return this;
  }

  /** Messages from whichever thread hosts the engine (worklet port in render
   *  mode, the Worker in Tier 2). Snapshots only arrive via postMessage in
   *  render mode without SAB. */
  _onEngineMessage(m) {
    if (m.t === MSG.SNAPSHOT) {
      const f = new Float32Array(m.buffer);
      // A snapshot posted before a USE_SAB switch landed must not clobber the
      // live shared view — but its latched interrupts still count.
      this.interruptMask |= f[SNAP_INTERRUPT_MASK];
      if (!this.usingSab) {
        this.snapshot.set(f);
        if (this.onSnapshot) this.onSnapshot(this.snapshot);
      }
      this.node.port.postMessage({ t: CMD.SNAPSHOT_RETURN, buffer: m.buffer }, [m.buffer]);
    } else if (m.t === MSG.INVERT_MASK) {
      this.invertMasks.set(m.slot, new Uint8Array(m.mask));
      if (m.mod) this.sampleMods.set(m.slot, m.mod);
      if (m.modMask) this.modMasks.set(m.slot, new Uint8Array(m.modMask));
    } else if (m.t === MSG.PROFILE) {
      // Enrich the worklet report with main-side facts it cannot see.
      m.usingSab = this.usingSab;
      m.usingWorker = this.usingWorker;
      m.bundleFallback = this.usedBundleFallback;
      m.contextSampleRate = this.context.sampleRate;
      this.profile = m;
      if (this.onProfile) this.onProfile(m);
    }
  }

  get running() { return this.context?.state === "running"; }

  /** Call from a user gesture (pointerdown/keydown). */
  async resume() {
    if (this.context && this.context.state !== "running") await this.context.resume();
  }

  // Engine commands go to whichever thread hosts the engine (the worklet port
  // in render mode, the render Worker in Tier 2). Both share the postMessage
  // (msg, transfer) signature.
  _post(msg, transfer) { this.engineTarget.postMessage(msg, transfer ?? []); }

  // ── document upload (mirror of taud.mjs uploadTaudFile order) ──

  /**
   * Push a parsed Taud document (the shape taud-parse returns) to the worklet
   * for playback of song songIndex. Copies the sample+inst image (the caller's
   * document keeps its own).
   */
  loadDocument(doc, songIndex = 0) {
    const song = doc.songs[songIndex];
    if (!song) throw new Error("songIndex out of range");

    this._post({ t: CMD.SET_64CH, on: doc.is64Channel });
    // Cell layout BEFORE any pattern upload — it decides how they are read.
    this.wideCells = (doc.fmtVer ?? 2) >= 3;
    this._post({ t: CMD.SET_CELL_FORMAT, wide: this.wideCells });

    // Then wipe the engine's playback state (item 125), exactly as taut.js's
    // resetAudioDevice() precedes every taud.uploadTaudFile: the new document
    // brings patterns, cues and instruments, but nothing in it says where the
    // previous song's S $80xx left each channel pointing, so without this a file
    // opened on top of another inherited its panning, channel volumes and
    // tone/interpolation modes. It follows the cell format because the reset
    // seeds the per-voice volumes from the layout's full-scale value.
    // Everything the song table DOES set is written below, after the reset.
    this._post({ t: CMD.STOP, ph: 0 });
    this._post({ t: CMD.RESET_PARAMS, ph: 0 });

    if (doc.sampleInstImage) {
      const image = doc.sampleInstImage.slice().buffer;
      this._post({ t: CMD.UPLOAD_SAMPLE_INST_BLOB, image }, [image]);
    }

    // Bulk pattern upload (one transfer).
    const nPats = song.patterns.length;
    const patSize = this.wideCells ? PATTERN_BYTES_WIDE : PATTERN_BYTES;
    const blob = new Uint8Array(nPats * patSize);
    const slots = new Array(nPats);
    for (let p = 0; p < nPats; p++) {
      blob.set(song.patterns[p], p * patSize);
      slots[p] = p;
    }
    this._post({ t: CMD.UPLOAD_PATTERNS, slots, blob: blob.buffer }, [blob.buffer]);
    // Blank any patterns left over from a longer previously-loaded song (the
    // engine's playdata store is just as persistent as the cueSheet below) —
    // without this, a cue whose own song only reaches pattern nPats-1 could
    // still land on a HIGHER slot that a prior, longer song had populated and
    // never had reset out from under it, and play that song's rows instead
    // (item 174: the "random low notes" a stale slot leaves behind).
    for (let p = nPats; p < this._patternHighWater; p++) {
      this._post({ t: CMD.CLEAR_PATTERN, slot: p });
    }
    this._patternHighWater = nPats;

    const chans = doc.is64Channel ? 64 : 32;
    for (let c = 0; c < song.cues.length; c++) {
      const words = song.cues[c];
      const bytes = new Uint8Array(chans * 2);
      for (let ch = 0; ch < chans; ch++) {
        bytes[ch * 2] = words[ch] & 0xff;
        bytes[ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
      }
      this._post({ t: CMD.UPLOAD_CUE, idx: c, bytes: bytes.buffer }, [bytes.buffer]);
    }
    // Blank any cues left over from a longer previously-loaded song (the engine
    // keeps one persistent cueSheet). Without this a doc grown into that stale
    // tail — now reachable via the Cues view's full-range scroll — could replay
    // the old song's patterns. 0x7FFF = CUE_EMPTY (bytes 0xFF, 0x7F).
    for (let c = song.cues.length; c < this._cueHighWater; c++) {
      const empty = new Uint8Array(chans * 2);
      for (let i = 0; i < chans * 2; i += 2) { empty[i] = 0xff; empty[i + 1] = 0x7f; }
      this._post({ t: CMD.UPLOAD_CUE, idx: c, bytes: empty.buffer }, [empty.buffer]);
    }
    this._cueHighWater = song.cues.length;

    this.setBPM(0, song.bpm);
    this.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
    this.setTuning(0, song.tuningBaseNote, song.tuningFreq);
    this.setTrackerMixerFlags(0, song.globalFlags);
    this.setSurroundModel(0, song.surroundModel ?? 0);
    this.setMonitorMode(0, this.monitorMode); // survives a context rebuild
    this.setSongGlobalVolume(0, song.globalVolume);
    this.setSongMixingVolume(0, song.mixingVolume);
    this.setMasterVolume(0, 255);
    // The song's mastering chain (item 178) — one of the three Project-Data
    // sections a player has to honour, so it is pushed on every load whether
    // the file declares one or not: the reset above left the chain neutral, and
    // a song that declares none is meant to stay that way.
    this.setMastering(0, song.mastering ?? null);
    // …and the Mastering view's tap survives a context rebuild the way the
    // monitor mode does.
    if (this.masterMeterOn) this.setMasterMeter(0, true, this.masterMeterDepth);

    for (const entry of doc.ixmp) {
      const bytes = entry.blob.slice().buffer;
      this._post({ t: CMD.UPLOAD_INSTRUMENT_PATCHES, slot: entry.instId, bytes }, [bytes]);
    }
  }

  // ── audio.*-shaped command surface ──

  play(ph = 0) { this._post({ t: CMD.PLAY, ph }); }
  stop(ph = 0) { this._post({ t: CMD.STOP, ph }); }
  setCuePosition(ph, pos) { this._post({ t: CMD.SET_CUE_POSITION, ph, pos }); }
  setTrackerRow(ph, row) { this._post({ t: CMD.SET_TRACKER_ROW, ph, row }); }
  setBPM(ph, bpm) { this._post({ t: CMD.SET_BPM, ph, bpm }); }
  setTickRate(ph, rate) { this._post({ t: CMD.SET_TICK_RATE, ph, rate }); }
  setTuning(ph, baseNote, freq) { this._post({ t: CMD.SET_TUNING, ph, baseNote, freq }); }
  setSongGlobalVolume(ph, volume) { this._post({ t: CMD.SET_SONG_GLOBAL_VOLUME, ph, volume }); }
  setSongMixingVolume(ph, volume) { this._post({ t: CMD.SET_SONG_MIXING_VOLUME, ph, volume }); }
  setMasterVolume(ph, volume) { this._post({ t: CMD.SET_MASTER_VOLUME, ph, volume }); }
  setMasterPan(ph, pan) { this._post({ t: CMD.SET_MASTER_PAN, ph, pan }); }
  setTrackerMixerFlags(ph, flags) { this._post({ t: CMD.SET_TRACKER_MIXER_FLAGS, ph, flags }); }
  setSurroundModel(ph, model) { this._post({ t: CMD.SET_SURROUND_MODEL, ph, model }); }
  /** #998.3: 0 = stereo fold, 1 = binaural head model (surround songs only). */
  setMonitorMode(ph, mode) {
    if (ph === 0) this.monitorMode = mode;
    this._post({ t: CMD.SET_MONITOR_MODE, ph, mode });
  }
  /**
   * Item 98: install (or drop) the master strip's analysis tap. The engine
   * spends nothing while it is ANALYSIS_OFF, so the strip turns it off the
   * moment it is hidden or the view changes.
   */
  setAnalysis(ph, target) {
    if (ph === 0) this.analysisTarget = target;
    this._post({ t: CMD.SET_ANALYSIS, ph, target });
  }
  /**
   * Item 178: install the song's mastering chain. `params` may be null (a song
   * with no `sMst` section), which installs the neutral chain — and a neutral
   * chain is not merely transparent, it is skipped entirely.
   */
  setMastering(ph, params) { this._post({ t: CMD.SET_MASTERING, ph, params }); }
  /** Item 178: install (or drop) the Mastering view's own metering tap. Costs
   *  nothing while off, so the view turns it off the moment it is hidden. */
  setMasterMeter(ph, on, bitDepth = undefined) {
    if (ph === 0) {
      this.masterMeterOn = !!on;
      if (bitDepth !== undefined) this.masterMeterDepth = bitDepth;
    }
    this._post({ t: CMD.SET_MASTER_METER, ph, on: !!on, bitDepth: this.masterMeterDepth });
  }
  resetParams(ph = 0) { this._post({ t: CMD.RESET_PARAMS, ph }); }
  resetSampleFxState(ph = 0) { this._post({ t: CMD.RESET_SAMPLE_FX_STATE, ph }); }
  jamNote(ph, voice, note, inst, audition = false) { this._post({ t: CMD.JAM_NOTE, ph, voice, note, inst, audition }); }
  /** Preview the exact pooled sample `spec` (ptr/len/rate/loop), no zone lookup (bug #65). */
  jamSample(ph, voice, note, spec) { this._post({ t: CMD.JAM_SAMPLE, ph, voice, note, spec }); }
  jamStop(ph = 0) { this._post({ t: CMD.JAM_STOP, ph }); }
  /** Stop one audition voice + what it spawned (item 140). `voice < 0` clears
   *  the whole jam bank; neither form touches a song voice, so a released key
   *  never cuts the playing song the way jamStop does. */
  jamStopVoice(ph = 0, voice = -1) { this._post({ t: CMD.JAM_STOP_VOICE, ph, voice }); }
  /** Voice index of jam-bank slot `i` — the audition voices, above every song
   *  channel: no fader, no mute, and never written to by playback. */
  jamVoice(i) { return JAM_VOICE_BASE + (((i | 0) % JAM_VOICES) + JAM_VOICES) % JAM_VOICES; }
  setVoiceMute(ph, voice, muted) { this._post({ t: CMD.SET_VOICE_MUTE, ph, voice, muted }); }
  setVoiceFader(ph, voice, fader) { this._post({ t: CMD.SET_VOICE_FADER, ph, voice, fader }); }
  uploadPattern(slot, bytes) {
    if (slot + 1 > this._patternHighWater) this._patternHighWater = slot + 1;
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_PATTERN, slot, bytes: buf }, [buf]);
  }
  /** Highest pattern slot+1 the engine's persistent pattern store has ever been
   *  given — same trouble as cueHighWater, and the same reason to track it. */
  get patternHighWater() { return this._patternHighWater; }
  /** Blank pattern slot back to unallocated (item 174) — used on the stale tail
   *  a shorter song leaves behind in the engine's persistent pattern store. */
  clearPattern(slot) { this._post({ t: CMD.CLEAR_PATTERN, slot }); }
  /** Highest cue index+1 the engine's persistent cueSheet has ever been given.
   *  A resync after the cue list SHRANK (a row delete, item 136.2) has to run
   *  out to here to blank what it left behind. */
  get cueHighWater() { return this._cueHighWater; }
  uploadCue(idx, bytes) {
    if (idx + 1 > this._cueHighWater) this._cueHighWater = idx + 1;
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_CUE, idx, bytes: buf }, [buf]);
  }
  uploadInstrument(slot, bytes) {
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_INSTRUMENT, slot, bytes: buf }, [buf]);
  }
  /** Replace the whole 8650752-byte sample+inst image (bank import/undo).
   *  Clears all uploaded Ixmp patch state — re-send the blobs afterwards. */
  uploadSampleInstImage(image) {
    const buf = image.slice().buffer;
    this._post({ t: CMD.UPLOAD_SAMPLE_INST_BLOB, image: buf }, [buf]);
  }
  uploadInstrumentPatches(slot, blob) {
    const buf = blob.slice().buffer;
    this._post({ t: CMD.UPLOAD_INSTRUMENT_PATCHES, slot, bytes: buf }, [buf]);
  }
  set64ChannelMode(on) { this._post({ t: CMD.SET_64CH, on }); }

  /** Ask the worklet for instrument `slot`'s live S$Fx invert-loop bit mask;
   *  the reply lands in invertMasks (read via getInvertMask, ~1 frame later). */
  requestInvertMask(slot) { this._post({ t: CMD.QUERY_INVERT_MASK, slot }); }
  /** Latest queried invert mask for `slot` (Uint8Array; empty when none). */
  getInvertMask(slot) { return this.invertMasks.get(slot) ?? null; }
  /** Latest queried notefx 2/3 modification for `slot` (item 130), or null.
   *  Arrives with the invert mask — one query answers for all of it. */
  getSampleMod(slot) { return this.sampleMods.get(slot) ?? null; }
  /** …and its inversion mask (Uint8Array; empty when the operation is not one). */
  getModMask(slot) { return this.modMasks.get(slot) ?? null; }

  // ── snapshot-backed synchronous readbacks (audio.*-shaped) ──

  isPlaying() { return (this.snapshot[SNAP_FLAGS] & 1) !== 0; }
  getCuePosition() { return this.snapshot[SNAP_CUE_POS]; }
  getTrackerRow() { return this.snapshot[SNAP_ROW_INDEX]; }
  getBPM() { return this.snapshot[SNAP_BPM]; }
  getTickRate() { return this.snapshot[SNAP_TICK_RATE]; }
  channelCount() { return this.snapshot[SNAP_CHANNEL_COUNT] || NUM_VOICES; }

  /** Edge-triggered latch, accumulated across snapshots; reading clears.
   *  SAB path: the worklet ORs into the shared Int32 cell; draining is one
   *  atomic exchange. (Both sources merge — snapshots posted before the
   *  USE_SAB switch landed still count.) */
  pollTrackerInterrupts() {
    let m = this.interruptMask;
    this.interruptMask = 0;
    if (this.sabI32 !== null) m |= Atomics.exchange(this.sabI32, 0, 0);
    return m;
  }

  _v(vi, field) {
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
    return this.snapshot[SNAP_HEADER_SIZE + v * SNAP_VOICE_STRIDE + field];
  }

  getVoiceActive(vi) { return this._v(vi, SNAP_V_ACTIVE) !== 0; }
  getVoiceEffectiveVolume(vi) { return this._v(vi, SNAP_V_EFF_VOL); }
  getVoiceEffectivePan(vi) { return this._v(vi, SNAP_V_EFF_PAN); }
  getVoiceNote(vi) { return this._v(vi, SNAP_V_NOTE); }
  getVoiceInstrument(vi) { return this._v(vi, SNAP_V_INST); }
  getVoiceSamplePos(vi) { return this._v(vi, SNAP_V_SAMPLE_POS); }
  getVoiceSamplePtr(vi) { return this._v(vi, SNAP_V_SAMPLE_PTR); }
  getVoiceSampleLength(vi) { return this._v(vi, SNAP_V_SAMPLE_LEN); }
  /** Funk repeat (Z $F0xx): the loop window this voice is SOUNDING, as a byte
   *  offset into its sample, or -1 while it is still on the sample's own loop. */
  getVoiceFunkWindow(vi) { return this._v(vi, SNAP_V_FUNK_WINDOW); }
  /** Where the walk will put the window at the next loop restart (-1 = it has
   *  not stepped yet). Runs AHEAD of getVoiceFunkWindow between restarts. */
  getVoiceFunkPos(vi) { return this._v(vi, SNAP_V_FUNK_POS); }
  /** The window's width — the voice's active loop length, which an Ixmp patch
   *  may have replaced, so it is not the document sample's. */
  getVoiceFunkLen(vi) { return this._v(vi, SNAP_V_FUNK_LEN); }
  /** Which walk is hopping the window (item 163's `$f` nibble): the low two
   *  bits are the hop size (loop length >> them), the high two the family. */
  getVoiceFunkMode(vi) { return this._v(vi, SNAP_V_FUNK_MODE); }
  /** Extended `2`/`3 $sexy : $fuuk`'s own funk repeat (`$xuu` 102/12x, item 173
   *  follow-up) — a SEPARATE window from Z's above. The walk's pending target
   *  and window width live on the instrument instead (getSampleMod's
   *  modFunkPos/modFunkLen), since that state is shared by every voice
   *  sounding the instrument rather than per-voice like Z's own. */
  getVoiceModFunkWindow(vi) { return this._v(vi, SNAP_V_MOD_FUNK_WINDOW); }
  getVoiceEnvVolIndex(vi) { return this._v(vi, SNAP_V_ENV_VOL_IDX); }
  getVoiceEnvVolTime(vi) { return this._v(vi, SNAP_V_ENV_VOL_TIME); }
  getVoiceEnvPanIndex(vi) { return this._v(vi, SNAP_V_ENV_PAN_IDX); }
  getVoiceEnvPanTime(vi) { return this._v(vi, SNAP_V_ENV_PAN_TIME); }
  getVoiceEnvPitchIndex(vi) { return this._v(vi, SNAP_V_ENV_PITCH_IDX); }
  getVoiceEnvPitchTime(vi) { return this._v(vi, SNAP_V_ENV_PITCH_TIME); }
  getVoiceEnvFilterIndex(vi) { return this._v(vi, SNAP_V_ENV_FILTER_IDX); }
  getVoiceEnvFilterTime(vi) { return this._v(vi, SNAP_V_ENV_FILTER_TIME); }
  /** #998: where the voice actually sits — 512-unit azimuth (0 left, 128 front,
   *  clockwise) and signed elevation (128 units = 90°). A stereo song reports
   *  its pan byte on the front arc and zero elevation. */
  getVoiceAzimuth(vi) { return this._v(vi, SNAP_V_AZIMUTH); }
  getVoiceElevation(vi) { return this._v(vi, SNAP_V_ELEVATION); }

  /** Song global volume as the ENGINE currently has it (0..255) — effects V and
   *  W move it while the song plays, which is what the master fader follows. */
  getLiveGlobalVolume() { return this.snapshot[SNAP_GLOBAL_VOLUME]; }

  /**
   * Item 98: the master-strip block for the interval this snapshot covers.
   * Fills `out` (see makeAnalysisReadout) and returns it; meterCount 0 means
   * the tap is off. Sums, not levels — the strip owns the ballistics.
   */
  readAnalysis(out) {
    const f = this.snapshot;
    const n = f[SNAP_AN_METERS] | 0;
    out.meterCount = n;
    out.frames = f[SNAP_AN_FRAMES];
    out.fieldEnergy = f[SNAP_AN_FIELD];
    out.corrLL = f[SNAP_AN_CORR_LL];
    out.corrRR = f[SNAP_AN_CORR_RR];
    out.corrLR = f[SNAP_AN_CORR_LR];
    out.ringWrite = f[SNAP_AN_RING_WRITE] | 0;
    for (let c = 0; c < n; c++) {
      const o = SNAP_METER_BASE + c * SNAP_METER_STRIDE;
      out.peak[c] = f[o + SNAP_M_PEAK];
      out.truePeak[c] = f[o + SNAP_M_TRUE_PEAK];
      out.meanSquare[c] = f[o + SNAP_M_MEAN_SQUARE];
      out.clip[c] = f[o + SNAP_M_CLIP];
    }
    return out;
  }

  /** The B-format scope ring (W, Y, Z, X interleaved), newest frame at
   *  readAnalysis().ringWrite − 1. A live view: on the SAB path the worklet may
   *  be part way through rewriting it, which costs a scope trace at worst. */
  scopeRing() {
    return this.snapshot.subarray(SNAP_SCOPE_BASE, SNAP_SCOPE_BASE + SCOPE_FRAMES * SCOPE_CHANNELS);
  }

  /**
   * Item 178: drain the Mastering view's metering block. Both stages every
   * time — the chain's input and its output — so the view's pre/post toggle
   * costs nothing and the two readings describe the same moment.
   * `frames` is 0 while the tap is off.
   */
  readMasterMeter(out) {
    const f = this.snapshot;
    out.frames = f[SNAP_MM_FRAMES];
    out.compGrDb = f[SNAP_MM_COMP_GR];
    out.limGrDb = f[SNAP_MM_LIM_GR];
    out.histTotal = f[SNAP_MM_HIST_TOTAL];
    out.specWrite = f[SNAP_MM_SPEC_WRITE] | 0;
    out.histDepth = f[SNAP_MM_HIST_DEPTH] | 0;
    out.histUsed = f[SNAP_MM_HIST_USED];
    out.histMin = f[SNAP_MM_HIST_MIN] | 0;
    out.histMax = f[SNAP_MM_HIST_MAX] | 0;
    out.histEntropy = f[SNAP_MM_HIST_ENTROPY];
    for (let s = 0; s < SNAP_MM_STAGES; s++) {
      const o = SNAP_MM_BASE + s * SNAP_MM_STAGE_STRIDE;
      out.sumZ[s] = f[o + SNAP_MM_SUM_Z];
      for (let c = 0; c < 2; c++) {
        const co = o + SNAP_MM_CH + c * SNAP_MM_C_STRIDE;
        const i = s * 2 + c;
        out.peak[i] = f[co + SNAP_MM_C_PEAK];
        out.truePeak[i] = f[co + SNAP_MM_C_TRUE_PEAK];
        out.meanSquare[i] = f[co + SNAP_MM_C_MEAN_SQUARE];
        out.clip[i] = f[co + SNAP_MM_C_CLIP];
      }
    }
    return out;
  }

  /** The delivered 8-bit code histogram, as fractions of readMasterMeter()'s
   *  `histTotal`. A live view into the snapshot, like scopeRing(). */
  bitHistogram() {
    return this.snapshot.subarray(SNAP_HIST_BASE, SNAP_HIST_BASE + SNAP_HIST_BINS);
  }

  /** One stage's mono spectrum ring (0 = into the chain, 1 = the master), a
   *  power-of-two ring read backwards from readMasterMeter().specWrite. A live
   *  view into the snapshot, like scopeRing(). */
  masterSpectrumRing(stage) {
    const o = SNAP_SPEC_BASE + (stage & 1) * SNAP_SPEC_FRAMES;
    return this.snapshot.subarray(o, o + SNAP_SPEC_FRAMES);
  }
}
