// PlayCue / PlayInstruction / TaudPlayData / TrackerState / Playhead —
// port of AudioAdapter.kt:4412-4494, 4880-5208, 5210-5244.

import {
  MAX_VOICES, TOTAL_VOICES, JAM_VOICE_BASE, PATTERN_EMPTY, NUM_CUES, TRACKER_CHUNK,
  INTERP_DEFAULT, VOLUME_MAX, VOLUME_MAX_WIDE, VOLUME_STEP_WIDE, SAMPLING_RATE,
  NUM_INTERRUPTS,
} from "./constants.js";
import { Voice } from "./voice.js";
import { startCutRamp } from "./sampler.js";
import { SURROUND_STEREO, SURROUND_SPATIAL, SpatialBus, StereoRenderer } from "./spatial.js";
import { MONITOR_FOLD, MONITOR_BINAURAL, BinauralRenderer } from "./binaural.js";
import { ANALYSIS_OFF, AnalysisTap } from "./analysis.js";
import { MasterChain, defaultMastering, masteringEngaged } from "./mastering.js";
import { MasterMeterTap, DEFAULT_BIT_DEPTH } from "./loudness.js";

// ── PlayInstruction (4484-4494) — tagged objects ──
export const INST_NOP = 0;
export const INST_GOBACK = 1;
export const INST_SKIP = 2;
export const INST_JUMP = 3;
export const INST_PATLEN = 4;
export const INST_HALTAT = 5;
export const INST_HALT = 6;

const PLAY_INST_NOP = Object.freeze({ type: INST_NOP, arg: 0 });
const PLAY_INST_HALT = Object.freeze({ type: INST_HALT, arg: 0 });

/** Per-cue playback data: 64 u16 channel words (pattern | signBit<<15). */
export class PlayCue {
  constructor() {
    this.raw = new Int32Array(MAX_VOICES).fill(PATTERN_EMPTY);
    this.inst0 = PLAY_INST_NOP;
    this.inst1 = PLAY_INST_NOP;
  }

  /** Pattern number for channel ch (0..0x7FFE), or PATTERN_EMPTY. */
  pattern(ch) { return this.raw[ch] & 0x7fff; }

  _instWord(base) {
    let w = 0;
    for (let k = 0; k < 16; k++) w |= ((this.raw[base + k] >>> 15) & 1) << k;
    return w;
  }

  recomputeInstructions() {
    this.inst0 = decodeInstWord(this._instWord(0));
    this.inst1 = decodeInstWord(this._instWord(16));
  }

  /** Effective playable row count: a LEN or "halt at x" in either word shortens it. */
  rowLimit() { return Math.min(rowsOf(this.inst0), rowsOf(this.inst1)); }

  /** True if either instruction word halts playback. */
  isHalt() {
    return this.inst0.type === INST_HALT || this.inst0.type === INST_HALTAT ||
           this.inst1.type === INST_HALT || this.inst1.type === INST_HALTAT;
  }

  /** The flow instruction (BAK / FWD / JMP) carried by either word, else NOP. */
  flowInstruction() {
    const t0 = this.inst0.type;
    if (t0 === INST_GOBACK || t0 === INST_SKIP || t0 === INST_JUMP) return this.inst0;
    const t1 = this.inst1.type;
    if (t1 === INST_GOBACK || t1 === INST_SKIP || t1 === INST_JUMP) return this.inst1;
    return PLAY_INST_NOP;
  }

  write(index, byte) {
    const ch = index >>> 1;
    this.raw[ch] = (index & 1) === 0
      ? (this.raw[ch] & 0xff00) | (byte & 0xff)
      : (this.raw[ch] & 0x00ff) | ((byte & 0xff) << 8);
    this.recomputeInstructions();
  }

  read(index) {
    const ch = index >>> 1;
    return (index & 1) === 0 ? this.raw[ch] & 0xff : (this.raw[ch] >>> 8) & 0xff;
  }
}

export function decodeInstWord(w) {
  if (w === 0) return PLAY_INST_NOP;
  const b30 = (w >>> 8) & 0xff;
  const b31 = w & 0xff;
  if (b30 === 0x02) return { type: INST_PATLEN, arg: (b31 & 0x3f) + 1, rows: (b31 & 0x3f) + 1 };
  if (b30 === 0x01) {
    // HALT family: arg 01xxxxxx ⇒ "halt at x" (x = 0 ⇒ full length); else plain HALT.
    if ((b31 & 0xc0) === 0x40) {
      const x = b31 & 0x3f;
      return { type: INST_HALTAT, arg: x === 0 ? 64 : x, rows: x === 0 ? 64 : x };
    }
    return PLAY_INST_HALT;
  }
  if ((b30 & 0xf0) === 0x80) return { type: INST_GOBACK, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0x90) return { type: INST_SKIP, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0xf0) return { type: INST_JUMP, arg: ((b30 & 0xf) << 8) | b31 };
  return PLAY_INST_NOP;
}

function rowsOf(inst) {
  return inst.type === INST_PATLEN || inst.type === INST_HALTAT ? inst.rows : 64;
}

// ── TaudPlayData — one pattern cell (5210-5244) ──
// Two wire layouts share these fields: the 8-byte cell of format versions 1-2
// (getByte/setByte) and version 3's 16-byte WIDE cell (getByteWide/setByteWide).
// The wide layout is a superset in meaning, not in encoding — its volume is a
// whole byte and its panning column is an azimuth plus an elevation rather than
// a 6-bit front-arc value — so the two codecs stay separate and the v2 path is
// untouched, which is what keeps it bit-exact.
export class TaudPlayData {
  constructor() {
    this.note = 0;       // 0..65535
    this.instrment = 0;  // 0..255 (sic — Kotlin field name kept for diffability)
    this.volume = 0;     // 0..63, or 0..255 in a wide cell
    this.volumeEff = 0;  // 0..3, or 0..7 in a wide cell
    this.pan = 0;        // 0..63 — the 8-byte cell's front-arc column value
    this.panEff = 0;     // 0..3, or 0..15 in a wide cell
    this.effect = 0;     // 0..255
    this.effectArg = 0;  // 0..65535
    // ── wide cell only (#v3) ──
    this.azimuth = 0;    // 0..511, the panning column's 9-bit angle
    this.elevation = 0;  // -128..127, signed
    this.effect2 = 0;    // second effect, applied after the first
    this.effectArg2 = 0;
  }

  /** Wide-cell byte view — see the file format's §5.5 table. */
  getByteWide(offset) {
    switch (offset) {
      case 0: return this.note & 0xff;
      case 1: return (this.note >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return this.volume & 0xff;
      case 4: return this.azimuth & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      case 8: return (((this.azimuth >>> 8) & 1) << 7) |
                     ((this.volumeEff & 7) << 4) | (this.panEff & 0xf);
      case 9: return this.elevation & 0xff;
      case 10: return this.effect2 & 0xff;
      case 11: return this.effectArg2 & 0xff;
      case 12: return (this.effectArg2 >>> 8) & 0xff;
      case 13: case 14: case 15: return 0; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByteWide(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 0xff; break;
      case 4: this.azimuth = (this.azimuth & 0x100) | byte; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      case 8:
        this.azimuth = (this.azimuth & 0xff) | ((byte & 0x80) << 1);
        this.volumeEff = (byte >>> 4) & 7;
        this.panEff = byte & 0xf;
        break;
      case 9: this.elevation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 10: this.effect2 = byte; break;
      case 11: this.effectArg2 = (this.effectArg2 & 0xff00) | byte; break;
      case 12: this.effectArg2 = (this.effectArg2 & 0x00ff) | (byte << 8); break;
      case 13: case 14: case 15: break; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  getByte(offset) {
    switch (offset) {
      case 0: return this.note & 0xff;
      case 1: return (this.note >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return (this.volume | (this.volumeEff << 6)) & 0xff;
      case 4: return (this.pan | (this.panEff << 6)) & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByte(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 63; this.volumeEff = (byte >>> 6) & 3; break;
      case 4: this.pan = byte & 63; this.panEff = (byte >>> 6) & 3; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }
}

// ── TrackerState (4880-4947) ──
export class TrackerState {
  constructor() {
    this.cuePos = 0;
    this.rowIndex = 0;
    this.tickInRow = 0;
    this.samplesIntoTick = 0.0;
    this.firstRow = true;
    // Always MAX_VOICES so 64-channel mode has slots for every channel, plus
    // the dedicated jam bank above them (JAM_VOICE_BASE…, item 140) — the tick
    // and mix loops run the whole array, the row loop only the channels.
    this.voices = new Array(TOTAL_VOICES);
    for (let i = 0; i < TOTAL_VOICES; i++) this.voices[i] = new Voice();

    // Tone-slide mode: 0=linear 4096-TET, 1=Amiga period, 2=linear-frequency (Hz).
    this.toneMode = 0;
    this.interpolationMode = INTERP_DEFAULT;
    this.ledFilterOn = false;

    // Cell format (file format version 3 — the wide cell). It sets the width of
    // the volume column, and with it the whole volume STATE: note, row and
    // channel volume are 0…63 in a v2 song and 0…255 in a v3 one. `volStep` is
    // what a 6-bit-derived delta is worth (a nibble slide, a tremolo depth), so
    // `D $01` moves at the same musical rate in both; `volDiv` normalises to
    // gain. Instrument data — envelope nodes, Ixmp velocity rectangles — stays
    // 6-bit in both, so a bank loads into either.
    this.wideCells = false;
    this.volMax = VOLUME_MAX;
    this.volStep = 1;
    this.volDiv = 63.0;

    // Surround model (#998; song-immutable `ss` flag) + the object bus it mixes
    // into. Null bus = the stereo model, which keeps the plain two-accumulator
    // path untouched — see mixer.js.
    this.surroundModel = SURROUND_STEREO;
    this.spatial = null;
    // Master-strip analysis tap (item 98) — null unless a host asked for one.
    this.analysis = null;
    this.analysisTarget = ANALYSIS_OFF;
    // Mastering chain (item 178) — the song's own, uploaded from its `sMst`
    // section. `mastering` is null whenever the chain would not change a
    // sample, which is what keeps the untouched output path bit-exact; the
    // PARAMETERS are kept either way so a readback returns what was uploaded.
    this.masteringParams = defaultMastering();
    this.mastering = null;
    // …and its metering tap (loudness.js), null unless the Mastering view asked
    // for one. Independent of the strip's tap: different signal, different
    // question, and both are opt-in.
    this.masterMeter = null;
    // Per-voice soundscope ring, ditto (item 179). The Kotlin device fills
    // `Voice.scopeBuffer` unconditionally because a TSVM guest can read the
    // scope window through MMIO whenever it likes; nothing here can, so the
    // ring is filled only while a host has asked for it (setVoiceScopeTap).
    this.scopeOn = false;

    // Song tuning as a playback-rate multiplier (item 77) — mirrored down from
    // the playhead by setTuning, like toneMode/interpolationMode are from the
    // global-behaviour flags, so the per-sample path reads it off `ts` alone.
    // 1.0 = concert; the tracker default (C9 @ 8363) is 0.99892 (~1.87c flat).
    this.tuningRatio = 1.0;

    // Post-mix Amiga filter state (stereo bus).
    this.amigaLPStateL = 0.0;
    this.amigaLPStateR = 0.0;
    this.amigaLEDStateL = new Float64Array(4); // [in_z1, in_z2, out_z1, out_z2]
    this.amigaLEDStateR = new Float64Array(4);

    // Pending row-end events.
    this.pendingOrderJump = -1;
    this.pendingRowJump = -1;
    this.pendingRowJumpLocal = false;

    // Pattern delay (S$Ex).
    this.patternDelayRemaining = 0;
    this.patternDelayActive = false;
    this.sexWinningChannel = -1;

    // Fine pattern delay (S$6x).
    this.finePatternDelayExtra = 0;

    // Interrupt-note latch (Int0..IntF). Plain int — the engine is single-threaded
    // inside the worklet; the drain happens in snapshot assembly (edge-triggered,
    // level-collapsed semantics preserved).
    this.pendingInterrupts = 0;
    // …and the argument each pending Int carried (item 181): the `:` on the same
    // row, or 0 where the row has none. Only the words whose mask bit is set
    // mean anything; a bit that fires twice before the host drains it keeps the
    // LAST argument, which is the same level-collapsing the mask already does.
    this.interruptArgs = new Uint16Array(NUM_INTERRUPTS);

    // Pre-allocated mix buffers (Float32 — matches the Kotlin FloatArray mix bus).
    this.mixLeft = new Float32Array(TRACKER_CHUNK);
    this.mixRight = new Float32Array(TRACKER_CHUNK);

    // Mixer-private background voices (NNA ghosts); index 0 = oldest.
    this.backgroundVoices = [];
  }

  /**
   * Install the cell format (file format version 3). Rescales the running
   * volume state so a switch cannot leave a voice at a quarter of its intended
   * level; in practice this is called once, before anything is uploaded.
   */
  setCellFormat(wide) {
    if (this.wideCells === !!wide) return;
    this.wideCells = !!wide;
    this.volMax = wide ? VOLUME_MAX_WIDE : VOLUME_MAX;
    this.volStep = wide ? VOLUME_STEP_WIDE : 1;
    this.volDiv = this.volMax * 1.0;
    for (const v of this.voices) {
      v.noteVolume = this.volMax;
      v.channelVolume = this.volMax;
      v.rowVolume = this.volMax;
    }
  }

  /**
   * Install the song's surround model (#998). The stereo model keeps `spatial`
   * null — the mixer's legacy two-accumulator path, untouched; anything else
   * allocates the object bus for `renderer`, which is the device's
   * StereoRenderer unless an exporter asked for a different render target.
   */
  setSurroundModel(model, renderer = null) {
    this.surroundModel = model & 3;
    this.spatial = this.surroundModel === SURROUND_STEREO
      ? null
      : new SpatialBus(renderer ?? new StereoRenderer(), TRACKER_CHUNK);
    this.setAnalysis(this.analysisTarget); // the tap's shape follows the model
  }

  /**
   * Install (or remove) the master-strip analysis tap (item 98). ANALYSIS_OFF
   * frees it: nothing on the render path may cost anything while the strip is
   * hidden, which is also why this is a command and not a permanent fixture.
   */
  setAnalysis(target) {
    this.analysisTarget = target;
    this.analysis = (target === ANALYSIS_OFF || target === undefined)
      ? null
      : new AnalysisTap(target, this.surroundModel);
  }

  /**
   * Install the song's mastering chain (item 178). A parameter set that would
   * not change a sample installs NOTHING — the mixer then keeps the plain
   * narrow-and-clamp it has always had, so every song that predates the
   * Mastering tab still renders bit-for-bit as it did.
   *
   * Reconfiguring a chain that is already up keeps its delay lines, so moving a
   * control while the song plays does not click.
   */
  setMastering(params) {
    this.masteringParams = params;
    if (!masteringEngaged(params)) { this.mastering = null; return; }
    if (this.mastering === null) this.mastering = new MasterChain(params);
    else this.mastering.setParams(params);
  }

  /** Install (or drop) the Mastering view's metering tap. `scramble` adds the
   *  phase-scrambled crest measurement, which only the offline analyser asks
   *  for (loudness.js explains why it is not on the live path); `bitDepth`
   *  picks which delivered format the bit-usage census describes. */
  setMasterMeter(on, scramble = false, bitDepth = DEFAULT_BIT_DEPTH) {
    if (!on) { this.masterMeter = null; return; }
    const depth = bitDepth === 8 ? 8 : 16;
    if (this.masterMeter === null || this.masterMeter.scramble !== !!scramble ||
        this.masterMeter.bitDepth !== depth) {
      this.masterMeter = new MasterMeterTap(SAMPLING_RATE,
        { scramble: !!scramble, bitDepth: depth });
    }
  }

  drainInterrupts() {
    const m = this.pendingInterrupts;
    this.pendingInterrupts = 0;
    return m;
  }

  /** The argument latched with Int `n` (item 181). Meaningful only for a bit
   *  the matching drain returned — the words outlive the mask, so reading one
   *  for an interrupt that did not fire yields whatever fired last. */
  interruptArg(n) { return this.interruptArgs[n & (NUM_INTERRUPTS - 1)]; }
}

// ── Playhead (4949-5207), tracker-mode-only port ──
// PCM mode, audio devices and MMIO byte protocol are host concerns and omitted.
export class Playhead {
  constructor(parent, index) {
    this.parent = parent;
    this.index = index;

    this.position = 0;
    this.masterVolume = 0;
    this.masterPan = 128;
    this.bpm = 125;      // 25..535
    this.tickRate = 6;
    this.patBank1 = 0;
    this.patBank2 = 0;
    this.globalVolume = 0x80;
    this.mixingVolume = 0x80;
    // Declared song tuning (item 77), kept for readback; the hot path uses the
    // multiplier setTuning derives onto trackerState. Untuned until a song
    // load pushes the file's pair — the engine has no song table of its own,
    // so the spec's "if zero, assume the tracker default" rule lives in
    // tuningRatioOf, on the values the host hands over.
    this.tuningBaseNote = 0;
    this.tuningFreq = 0.0;

    this.trackerState = new TrackerState();
    this.jamActive = false;
    this.initialGlobalFlags = 0;
    // Song-immutable surround model + the render target it mixes through
    // (#998). Null renderer = the device's own monitor, picked by monitorMode
    // (fold or binaural, #998.3); an exporter overrides it with the format's
    // renderer and the engine never learns which format asked.
    this.surroundModel = SURROUND_STEREO;
    this.spatialRenderer = null;
    this.monitorMode = MONITOR_FOLD;
    this.binauralRenderer = null; // built on demand, kept across model switches

    this._isPlaying = false;
  }

  /**
   * The render target the object bus should use right now (#998.3): an
   * exporter's explicit renderer if one is installed, otherwise the device
   * monitor this playhead is set to — null for the fold (the bus builds its own
   * StereoRenderer), or a binaural head matching the song's model. The binaural
   * renderer is stateful, so it is kept across model switches and reset each
   * time it is (re-)installed.
   */
  effectiveSpatialRenderer() {
    if (this.spatialRenderer !== null) return this.spatialRenderer;
    if (this.monitorMode !== MONITOR_BINAURAL || this.surroundModel === SURROUND_STEREO) return null;
    const sphere = this.surroundModel === SURROUND_SPATIAL;
    if (this.binauralRenderer === null || this.binauralRenderer.sphere !== sphere) {
      this.binauralRenderer = new BinauralRenderer(sphere);
    }
    this.binauralRenderer.reset();
    return this.binauralRenderer;
  }

  /** (Re-)install the surround model on the tracker state with that target. */
  applySurroundModel() {
    this.trackerState.setSurroundModel(this.surroundModel, this.effectiveSpatialRenderer());
  }

  updateTrackerGlobalBehaviour(flags) {
    const ts = this.trackerState;
    if (ts !== null) {
      ts.toneMode = flags & 3;
      ts.interpolationMode = (flags >>> 2) & 7;
    }
  }

  /**
   * Silence every voice the SONG owns — the channels plus the NNA / layer
   * ghosts hanging off them — leaving the jam bank alone, so an audition held
   * across a stop keeps sounding (JS-only, item 140: the Kotlin device has no
   * jam bank and stops the lot).
   *
   * Stopping the transport only clears isPlaying: the mixer runs while
   * isPlaying or jamActive, so it switches off, but every voice stays FROZEN
   * mid-note. Whatever turns the mix back on — a jammed key — would otherwise
   * resume the whole cut-off chord along with the note actually struck, and a
   * Stop pressed while an audition rang would not stop the song at all (nothing
   * ever goes silent, so jamActive never auto-clears either). Called from both
   * ends of the transport: TaudEngine.stop and the mixer's halt-cue tail.
   *
   * `ramp` cuts through the note-cut ramp, for a mix that is still running: a
   * hard drop mid-waveform clicks. With nothing rendering, drop them outright —
   * a ramp nobody renders is just the revival deferred to the next jam.
   */
  silenceSongVoices(ramp) {
    const ts = this.trackerState;
    if (ts === null) return;
    const cut = (v) => {
      if (!v.active) return;
      if (ramp) startCutRamp(v); else v.active = false;
    };
    for (let vi = 0; vi < JAM_VOICE_BASE; vi++) cut(ts.voices[vi]);
    for (const bg of ts.backgroundVoices) {
      if (bg.sourceChannel < JAM_VOICE_BASE) cut(bg);
    }
  }

  get isPlaying() { return this._isPlaying; }
  set isPlaying(value) {
    // Starting real playback ends any jam audition: drop leftover jammed voices
    // so a held audition can't bleed into the first rows of the song.
    if (!this._isPlaying && value && this.jamActive) {
      const ts = this.trackerState;
      if (ts !== null) {
        for (const v of ts.voices) v.active = false;
        for (const v of ts.backgroundVoices) v.active = false;
      }
      this.jamActive = false;
    }
    this._isPlaying = value;
  }

  setCuePosition(pos) {
    this.position = pos;
    const ts = this.trackerState;
    if (ts !== null) ts.cuePos = Math.min(pos, NUM_CUES - 1);
  }

  resetParams() {
    this.position = 0;
    this.isPlaying = false;
    this.jamActive = false;
    // Spec §5 defaults — applied on every reset so song-start state is well-defined.
    this.bpm = 125;
    this.tickRate = 6;
    this.globalVolume = 0x80;
    this.mixingVolume = 0x80;
    this.tuningBaseNote = 0;
    this.tuningFreq = 0.0;
    const ts = this.trackerState;
    if (ts === null) return;
    ts.tuningRatio = 1.0;
    ts.cuePos = 0; ts.rowIndex = 0; ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0; ts.firstRow = true;
    ts.pendingOrderJump = -1; ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    ts.patternDelayRemaining = 0; ts.patternDelayActive = false;
    ts.sexWinningChannel = -1;
    ts.finePatternDelayExtra = 0;
    ts.pendingInterrupts = 0;
    ts.interruptArgs.fill(0);
    ts.toneMode = this.initialGlobalFlags & 3;
    ts.interpolationMode = (this.initialGlobalFlags >>> 2) & 7;
    this.applySurroundModel();
    ts.ledFilterOn = false;
    ts.amigaLPStateL = 0.0; ts.amigaLPStateR = 0.0;
    ts.amigaLEDStateL.fill(0.0); ts.amigaLEDStateR.fill(0.0);
    // Mastering (item 178) goes back to neutral for the same reason the tuning
    // does: nothing in a fresh document describes the chain the previous one
    // left installed, and a full reset is what a host performs before uploading
    // one. The song's own `sMst` parameters are pushed straight after.
    ts.setMastering(defaultMastering());
    ts.masterMeter?.resetAll();
    for (const it of ts.voices) {
      it.active = false;
      it.noteVolume = ts.volMax;
      it.channelVolume = ts.volMax;
      it.rowVolume = ts.volMax;
      it.currentMixVolume = 1.0;
      it.volRampSamples = 0;
      it.volRampStep = 0.0;
      it.currentPan = 128.0; it.panRampSamples = 0; it.panRampStep = 0.0; it.snapPan = true;
      it.snapMixVolume = false;
      it.envVolMix = 1.0;
      it.envVolStep = 0.0;
      it.channelPan = 0x80;
      it.rowPan = 32;
      it.panbrelloOffset = 0;
      it.panAzimuth = 128.0;
      it.panElevation = 0.0;
      it.notePan = 0;
      it.noteElevation = 0.0;
      it.spatialTargetAz = 128.0;
      it.spatialTargetEl = 0.0;
      it.spatialSlideActive = false;
      it.spatial = null;
      it.glissandoOn = false;
      it.loopStartRow = 0;
      it.loopCount = 0;
      it.dittoActive = false;
      it.dittoSourceStart = 0;
      it.dittoLength = 0;
      it.dittoEndRow = 0;
      // Bitcrusher (8) / Overdrive (9) — the CHANNEL's colouring, written by the
      // song's own effects and cleared by nothing else, so a full reset owes
      // them the same clean slate as the panning above (§15).
      it.clipMode = 0;
      it.bitcrusherDepth = 0;
      it.bitcrusherSkip = 0;
      it.bitcrusherCounter = 0;
      it.bitcrusherHeld = 0.0;
      it.overdriveAmp = 0;
      it.invertSpeed = 0;
      it.invertAccumulator = 0;
      it.invertWritePos = 0;
      it.funkSpeed = 0;
      it.funkMode = 0;
      it.funkAccumulator = 0;
      it.funkWalk = -1;
      it.funkPos = -1;
      it.funkWindow = -1;
      it.funkXfade = 0;
      it.modFunkWindow = -1;
      it.modFunkXfade = 0;
      it.modPeriod = 0;
      it.modTickCount = 0;
      it.modWritePos = 0;
      it.modXfade = 0;
      it.fader = 0;
      it.nnaOverride = -1;
      it.volEnvOn = true; it.panEnvOn = true; it.pitchEnvOn = true; it.filterEnvOn = true;
      it.metaForeground = false;
      it.metaForegroundDetune = 0;
      it.noteFading = false;
      it.layerMixGain = 1.0; it.isLayerChild = false; it.layerRelDetune = 0;
      it.layerFixedNote = -1;
      it.layerRelPan = 0; it.layerRelElevation = 0;
      it.layerPitchMod = 0; it.pitchModDelta = 0;
      it.fmRig = null; it.fmOperator = false;
      // "What's playing" state — cleared alongside the volume reset so a stale
      // instrumentId can't survive into a fresh session (AudioAdapter.kt:5130-5142).
      it.instrumentId = 0;
      it.displayInst = 0;
      it.activePatchIndex = -1; // stem tap, cleared with the rest of "what's playing"
      it.samplePos = 0.0;
      it.playbackRate = 1.0;
      it.currentPlaybackRate = 1.0;
      it.pitchRampSamples = 0; it.pitchRampStep = 0.0; it.snapPlaybackRate = true;
      it.forward = true;
      it.keyOff = false;
      it.envIndex = 0; it.envTimeSec = 0.0; it.envVolume = 1.0;
      it.envPanIndex = 0; it.envPanTimeSec = 0.0; it.envPan = 0.5;
      it.hasPanEnv = false;
      it.envPitchIndex = 0; it.envPitchTimeSec = 0.0; it.envPitchValue = 0.5;
      it.envFilterIndex = 0; it.envFilterTimeSec = 0.0; it.envFilterValue = 0.5;
      it.hasPitchEnv = false; it.hasFilterEnv = false;
      it.fadeoutVolume = 1.0;
      it.rampOutSamples = 0; it.rampOutGain = 0.0; it.rampOutStep = 0.0;
      it.attackRampSamples = 0;
      it.noteVal = 0x0000; it.basePitch = 0x4000;
      it.amigaPeriod = -1.0; it.linearFreq = -1.0;
      it.tonePortaTarget = -1; it.tonePortaSpeed = 0;
      it.filterY1 = 0.0; it.filterY2 = 0.0; it.filterX1 = 0.0; it.filterX2 = 0.0;
      it.filterCutoffCached = -1; it.filterResonanceCached = -1;
      it.currentCutoff = 0xff; it.currentResonance = 0xff;
      it.nesDpcmCounter = 63;
      it.right.reset();
      it.activeChanCount = 1; it.activeChanMode = 0; it.activeChanPtr2 = 0;
    }
    ts.backgroundVoices.length = 0;
    // Sample modifications (invert masks + notefx 2/3 regions) and notefx 5/6
    // overrides are per-instrument runtime state — clear so a replay (or song
    // loop) starts from the file defaults.
    for (const inst of this.parent.instruments) {
      inst.invertMask = null;
      inst.resetMod();
      inst.cutoffOverride = -1;
      inst.resonanceOverride = -1;
    }
  }

  /** Clear the sample-effect state only: the invert loop's per-voice speeds
   *  and per-instrument masks, funk repeat's per-voice loop windows, and the
   *  notefx 2/3 modifications (regions and rotations). */
  resetSampleFxState() {
    const ts = this.trackerState;
    if (ts !== null) {
      for (const it of ts.voices) {
        it.invertSpeed = 0;
        it.invertAccumulator = 0;
        it.invertWritePos = 0;
        it.funkSpeed = 0;
        it.funkMode = 0;
        it.funkAccumulator = 0;
        it.funkWalk = -1;
        it.funkPos = -1;
        it.funkWindow = -1;
        it.funkXfade = 0;
        it.modFunkWindow = -1;
        it.modFunkXfade = 0;
        it.modPeriod = 0;
        it.modTickCount = 0;
        it.modWritePos = 0;
        it.modXfade = 0;
      }
    }
    for (const inst of this.parent.instruments) {
      inst.invertMask = null;
      inst.resetMod();
    }
  }
}
