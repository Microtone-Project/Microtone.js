// TaudEngine — the device facade, port of AudioAdapter.kt state fields
// (356-397) + AudioJSR223Delegate.kt (the `audio.*` API surface consumed by
// taut.js / playtaud / taud.mjs). One instance ≈ one AudioAdapter.
//
// Differences from the Kotlin device (deliberate, per the port plan):
//  - uploadSampleInstBlob takes the DECOMPRESSED 8650752-byte image
//    (decompression is a format-layer / main-thread concern).
//  - No PCM/MP2/TAD paths, no MMIO/banked windows: callers address the API,
//    playback addresses the 8 MB pool directly (as the Kotlin engine does).
//  - Voice-index clamps mirror the delegate exactly (readbacks clamp to
//    NUM_VOICES-1; jamNote to MAX_VOICES-1).

import {
  SAMPLE_BIN_TOTAL, NUM_PATTERNS, NUM_CUES, NUM_VOICES, MAX_VOICES,
  JAM_VOICES, JAM_VOICE_BASE, TOTAL_VOICES,
  CUE_BYTES, CUE_BYTES_64, TRACKER_CHUNK,
  CELL_BYTES, CELL_BYTES_WIDE, PATTERN_BYTES, PATTERN_BYTES_WIDE,
} from "./constants.js";
import { tuningRatioOf } from "./tables.js";
import { TaudInst, parsePatchesBlob, writePatchesBlob, makeInstPatch, layerNote } from "./inst.js";
import { PlayCue, TaudPlayData, Playhead } from "./state.js";
import { makeXorshift32 } from "./rng.js";
import { SURROUND_STEREO, foldAzimuthToPan, voiceAzimuth, voiceElevation } from "./spatial.js";
import { generateTrackerAudio } from "./mixer.js";
import { triggerMetaOrNote, triggerNote } from "./trigger.js";
import { startCutRamp } from "./sampler.js";
import { reconstructDittoState } from "./row.js";

// Scratch instrument slot for the raw-sample preview (jamSample). It sits just
// past the 1024 addressable bank slots so an audition never borrows a real one;
// every `instruments[voice.instrumentId]` lookup indexes it directly (no & mask).
const AUDITION_SLOT = 1024;

function makePattern() {
  const rows = new Array(64);
  for (let i = 0; i < 64; i++) {
    const c = new TaudPlayData();
    c.pan = 32;
    rows[i] = c;
  }
  return rows;
}

export class TaudEngine {
  constructor() {
    this.sampleBin = new Uint8Array(SAMPLE_BIN_TOTAL);
    this.instruments = new Array(AUDITION_SLOT + 1);
    for (let i = 0; i <= AUDITION_SLOT; i++) this.instruments[i] = new TaudInst(i);
    // Pattern store — lazily allocated (memory scales with actual song size).
    this.playdata = new Array(NUM_PATTERNS).fill(null);
    this.emptyPattern = makePattern();
    this.scratchPattern = makePattern();
    this.cueSheet = new Array(NUM_CUES);
    for (let i = 0; i < NUM_CUES; i++) this.cueSheet[i] = new PlayCue();
    this.is64ChannelMode = false;
    // Format version 3's 16-byte pattern cell — a whole-file property.
    this.wideCells = false;
    this.playheads = [
      new Playhead(this, 0), new Playhead(this, 1),
      new Playhead(this, 2), new Playhead(this, 3),
    ];
    // Dither state (pcm32fToPcm8): per-adapter xorshift32 + error history.
    this.xorshift32 = makeXorshift32();
    this.ditherError = new Float32Array(4); // [L0, L1, R0, R1]
    // Stem-export tap (item 93; JS-only, no Kotlin counterpart). null on every
    // normal path — playback and the WAV export never set it. When non-null the
    // mixer hands each voice's PRE-PAN mono contribution to `add()`; nothing
    // else about the render changes, so the main output stays bit-identical.
    this.stemBus = null;
  }

  channelCount() { return this.is64ChannelMode ? MAX_VOICES : NUM_VOICES; }
  cueByteStride() { return this.is64ChannelMode ? CUE_BYTES_64 : CUE_BYTES; }

  /** Read-only view of pattern idx (shared empty pattern when unallocated). */
  patternRead(idx) {
    if (idx < 0 || idx >= NUM_PATTERNS) return this.emptyPattern;
    return this.playdata[idx] ?? this.emptyPattern;
  }

  /** Writable pattern idx, allocating its 64 rows on first access. */
  patternFor(idx) {
    if (idx < 0 || idx >= NUM_PATTERNS) return this.scratchPattern;
    let p = this.playdata[idx];
    if (p === null) {
      p = makePattern();
      this.playdata[idx] = p;
    }
    return p;
  }

  // ── content upload (AudioJSR223Delegate.kt:343-497, 610-640) ──

  /**
   * Install a DECOMPRESSED sample+instrument image: 8 MB samples followed by
   * 1024 (or fewer, for older files) 256-byte instrument records. Slots absent
   * from the blob are cleared; all Ixmp patches are dropped (they point into
   * the replaced pool).
   */
  uploadSampleInstBlob(image) {
    const sampleSize = SAMPLE_BIN_TOTAL;
    if (image.length < sampleSize + 65536) return 0;
    this.sampleBin.set(image.subarray(0, sampleSize));
    const instCount = Math.min(1024, Math.trunc((image.length - sampleSize) / 256));
    const rec = new Uint8Array(256);
    for (let instIdx = 0; instIdx < 1024; instIdx++) {
      if (instIdx < instCount) {
        rec.set(image.subarray(sampleSize + instIdx * 256, sampleSize + (instIdx + 1) * 256));
      } else {
        rec.fill(0);
      }
      this.instruments[instIdx].loadRecord(rec);
    }
    for (const inst of this.instruments) inst.extraPatches = null;
    return image.length;
  }

  /** Capture the raw 8650752-byte sample+instrument image (save path). */
  captureSampleInstImage() {
    const out = new Uint8Array(SAMPLE_BIN_TOTAL + 1024 * 256);
    out.set(this.sampleBin);
    for (let i = 0; i < 1024 * 256; i++) {
      out[SAMPLE_BIN_TOTAL + i] = this.instruments[(i / 256) | 0].getByte(i % 256);
    }
    return out;
  }

  /** Upload up to 256 bytes defining instrument slot (0-1023; 256+ = aux bin). */
  uploadInstrument(slot, bytes) {
    const inst = this.instruments[slot & 0x3ff];
    const rec = new Uint8Array(256);
    for (let i = 0; i < Math.min(256, bytes.length); i++) rec[i] = bytes[i] & 0xff;
    inst.loadRecord(rec);
  }

  /**
   * Upload an Ixmp "extra samples" block for instrument slot. Patches are
   * variable-length: version byte (0b x00Pfpvi) + 30 common bytes + optional
   * x/v/p/f/P blocks in that order (AudioJSR223Delegate.kt:357-430).
   */
  uploadInstrumentPatches(slot, bytes) {
    const inst = this.instruments[slot & 0x3ff];
    const patches = parsePatchesBlob(bytes);
    inst.extraPatches = patches.length === 0 ? null : patches;
  }

  getInstrumentPatchCount(slot) {
    const p = this.instruments[slot & 0x3ff].extraPatches;
    return p === null ? 0 : p.length;
  }

  /** Exact byte-inverse of uploadInstrumentPatches (capture path). */
  getInstrumentPatches(slot) {
    const patches = this.instruments[slot & 0x3ff].extraPatches;
    if (patches === null) return new Uint8Array(0);
    return writePatchesBlob(patches);
  }

  clearInstrumentPatches(slot) {
    this.instruments[slot & 0x3ff].extraPatches = null;
  }

  /** Deallocate pattern slot back to unallocated (patternRead then falls back
   *  to emptyPattern, same as a slot that was never written) — used to blank
   *  the persistent pattern store's stale tail when a shorter song loads over
   *  a longer one (item 174), the same trouble uploadDocument's cue high-water
   *  blanking already covers for the cue sheet. */
  clearPattern(slot) {
    this.playdata[slot & 0x7fff] = null;
  }

  /** Upload 512 bytes (64 rows × 8) defining pattern slot. */
  uploadPattern(slot, bytes) {
    const pat = this.patternFor(slot & 0x7fff);
    if (this.wideCells) {
      const n = Math.min(PATTERN_BYTES_WIDE, bytes.length);
      for (let i = 0; i < n; i++) {
        pat[(i / CELL_BYTES_WIDE) | 0].setByteWide(i % CELL_BYTES_WIDE, bytes[i] & 0xff);
      }
      return;
    }
    const n = Math.min(PATTERN_BYTES, bytes.length);
    for (let i = 0; i < n; i++) pat[(i / CELL_BYTES) | 0].setByte(i % CELL_BYTES, bytes[i] & 0xff);
  }

  /**
   * Select the file format's cell layout (version 3 = the wide cell). A
   * whole-file property: patterns uploaded afterwards are read in this layout,
   * and the volume columns' width follows it. Set it BEFORE uploading anything.
   */
  setCellFormat(wide) {
    this.wideCells = !!wide;
    for (const p of this.playheads) p.trackerState?.setCellFormat(this.wideCells);
  }
  getCellFormat() { return this.wideCells; }

  /** Upload one cue entry (64 bytes / 128 bytes in 64-channel mode). */
  uploadCue(idx, bytes) {
    const cue = this.cueSheet[idx & (NUM_CUES - 1)];
    const n = Math.min(this.cueByteStride(), bytes.length);
    for (let i = 0; i < n; i++) cue.write(i, bytes[i] & 0xff);
  }

  set64ChannelMode(enabled) { this.is64ChannelMode = enabled; }

  // ── transport / params (delegate 56-139, 328-337, 505-575) ──

  setTrackerMode(ph) { /* PCM mode does not exist here; tracker is the only mode */ }
  play(ph) { this.playheads[ph].isPlaying = true; }

  /**
   * Stop the transport, and end the song's voices with it. Clearing isPlaying
   * is all it takes to go SILENT (the mixer runs only while isPlaying or
   * jamActive), but on its own it leaves every voice FROZEN mid-note for
   * whatever turns the mix back on — see Playhead.silenceSongVoices. Ramped
   * while an audition is still sounding, because that mix keeps running;
   * dropped outright otherwise, where nothing renders and nothing is heard.
   */
  stop(ph) {
    const p = this.playheads[ph];
    p.isPlaying = false;
    p.silenceSongVoices(p.jamActive);
  }

  isPlaying(ph) { return this.playheads[ph].isPlaying; }

  setMasterVolume(ph, volume) { this.playheads[ph].masterVolume = volume & 255; }
  getMasterVolume(ph) { return this.playheads[ph].masterVolume; }
  setMasterPan(ph, pan) { this.playheads[ph].masterPan = pan & 255; }
  getMasterPan(ph) { return this.playheads[ph].masterPan; }

  setBPM(ph, bpm) { this.playheads[ph].bpm = Math.min(Math.max(bpm, 25), 535); }
  getBPM(ph) { return this.playheads[ph].bpm; }
  setTickRate(ph, rate) { this.playheads[ph].tickRate = rate & 255; }
  getTickRate(ph) { return this.playheads[ph].tickRate; }

  /**
   * Song tuning (item 77): `baseNote` sounds at `freq` Hz. Either reading zero
   * means the tracker default (spec) — tuningRatioOf applies that rule. Takes
   * effect on the next tick for notes already sounding, so dialling a tuning
   * while the song plays bends it in place rather than waiting for retriggers.
   */
  setTuning(ph, baseNote, freq) {
    const p = this.playheads[ph];
    p.tuningBaseNote = baseNote & 0xffff;
    p.tuningFreq = freq;
    p.trackerState.tuningRatio = tuningRatioOf(p.tuningBaseNote, p.tuningFreq);
  }
  getTuningRatio(ph) { return this.playheads[ph].trackerState.tuningRatio; }

  setCuePosition(ph, pos) {
    const p = this.playheads[ph];
    p.position = pos & (NUM_CUES - 1);
    p.trackerState.cuePos = p.position;
  }
  getCuePosition(ph) { return this.playheads[ph].position; }
  getTrackerRow(ph) { return this.playheads[ph].trackerState.rowIndex; }

  /** Set the starting row for the next play, resetting timing + silencing every
   *  voice. This is the common pre-play reset point (playFrom / pattern
   *  preview), so it clears the transient per-play state that would otherwise
   *  bleed a prior playback into a fresh start — notably the NNA background
   *  ghosts, which stop() leaves active and a replay would resume (the
   *  "mysteriously lingering notes" bug), and the CHANNEL-scope mixer state the
   *  song's own effects write (item 125: pan, elevation, channel volume). The
   *  playhead's tempo/volume are deliberately NOT touched (a replay must keep
   *  the song's tempo — that's why this is not a full resetParams), and neither
   *  is the host's per-channel fader/mute, which belongs to the desk. */
  setTrackerRow(ph, row) {
    const ts = this.playheads[ph].trackerState;
    ts.rowIndex = Math.min(Math.max(row, 0), 63);
    ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0;
    ts.firstRow = true;
    ts.pendingOrderJump = -1;
    ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    ts.patternDelayRemaining = 0;
    ts.patternDelayActive = false;
    ts.sexWinningChannel = -1;
    ts.finePatternDelayExtra = 0;
    ts.pendingInterrupts = 0;
    for (const v of ts.voices) {
      v.active = false;
      // Clear per-voice pattern-loop (S$Bx) + Ditto (effect 7) memory so a replay
      // never resumes effect status from the previous play (item 44). These are
      // transient playback state, not song settings — the same rationale as the
      // ghost/note clears; resetPatternLoopState normally does this on cue
      // advances, but nothing did it at play START.
      v.loopStartRow = 0; v.loopCount = 0;
      v.dittoActive = false; v.dittoSourceStart = 0; v.dittoLength = 0; v.dittoEndRow = 0;
      // Channel-scope state, back to the song-start defaults (item 125). A
      // trigger deliberately does NOT reset any of this — pan and channel volume
      // belong to the CHANNEL, not the note — so without a clear here the last
      // S $80xx / M / N / P / X / Z of the previous play was still in force, and
      // a song played twice, or a second file opened on top of the first, panned
      // its notes wherever the last one had left them. Same defaults as
      // resetParams (state.js).
      v.channelVolume = ts.volMax;
      v.channelPan = 0x80;
      v.rowPan = 32;
      v.panAzimuth = 128.0;
      v.panElevation = 0.0;
      v.notePan = 0;
      v.noteElevation = 0.0;
      v.spatialTargetAz = 128.0;
      v.spatialTargetEl = 0.0;
      v.spatialSlideActive = false;
      v.panbrelloOffset = 0;
      v.glissandoOn = false;
      // Bitcrusher (8) / Overdrive (9) are channel colouring in exactly the same
      // sense — the song writes them, a trigger deliberately leaves them, and
      // nothing else clears them — so without this a song that crushed once was
      // still crushed on the replay, right through the rows before its next
      // `8 $xxxx`. right.reset() covers the stereo twin's crusher history.
      v.clipMode = 0;
      v.bitcrusherDepth = 0;
      v.bitcrusherSkip = 0;
      v.bitcrusherCounter = 0;
      v.bitcrusherHeld = 0.0;
      v.overdriveAmp = 0;
      v.right.bitcrusherCounter = 0;
      v.right.bitcrusherHeld = 0.0;
      // Per-note S $7x overrides (NNA + the four envelope switches).
      v.nnaOverride = -1;
      v.volEnvOn = true; v.panEnvOn = true; v.pitchEnvOn = true; v.filterEnvOn = true;
    }
    ts.backgroundVoices.length = 0; // drop lingering NNA ghosts from a prior play
    // The mastering chain (item 178) is per-PLAY transient in exactly the sense
    // the ghost pool is: a compressor still holding six decibels of reduction
    // from before the seek, and a look-ahead buffer still holding two
    // milliseconds of the previous playback, both bleed the old take into the
    // new one. Its PARAMETERS are the song's and are left alone, like the tempo.
    ts.mastering?.reset();
    // …and the meter's integration describes one playback, so it starts again
    // with it — including the bit histogram, which is cumulative by design.
    ts.masterMeter?.resetAll();
    // Re-arm any Pattern-Ditto (effect 7) region that a mid-pattern start lands
    // inside, so a ghosted (repeated) row sounds when you play from it (item 81).
    reconstructDittoState(this, ts, ts.rowIndex);
  }

  setTrackerMixerFlags(ph, flags) {
    const p = this.playheads[ph];
    p.initialGlobalFlags = flags;
    p.updateTrackerGlobalBehaviour(flags);
  }
  getTrackerMixerFlags(ph) { return this.playheads[ph].initialGlobalFlags; }

  /**
   * Song-immutable surround model (#998): 0 stereo, 1 planar (360° panning),
   * 2 spatial. Anything but stereo mixes through the object bus.
   */
  setSurroundModel(ph, model) {
    const p = this.playheads[ph];
    p.surroundModel = model & 3;
    p.applySurroundModel();
  }
  getSurroundModel(ph) { return this.playheads[ph].surroundModel; }

  /**
   * Swap the render target the object bus feeds (#998.0). Null = the device's
   * own monitor (see setMonitorMode); an exporter installs e.g. an
   * AmbisonicRenderer and reads `trackerState.spatial.data` after each chunk.
   * No-op for a stereo song.
   */
  setSpatialRenderer(ph, renderer) {
    const p = this.playheads[ph];
    p.spatialRenderer = renderer;
    p.applySurroundModel();
  }

  /**
   * How the device monitors a surround song (#998.3): MONITOR_FOLD folds it
   * onto the stereo pan law, MONITOR_BINAURAL renders it through a head model
   * so elevation and front/back are audible on headphones. Ignored while an
   * exporter's renderer is installed, and irrelevant to a stereo song.
   */
  setMonitorMode(ph, mode) {
    const p = this.playheads[ph];
    p.monitorMode = mode & 1;
    p.applySurroundModel();
  }
  getMonitorMode(ph) { return this.playheads[ph].monitorMode; }

  /**
   * Master-strip analysis tap (item 98): ANALYSIS_OFF, ANALYSIS_STEREO,
   * ANALYSIS_AMBISONIC or a speaker-layout key. Costs nothing while off, so the
   * host turns it on only while the strip is visible.
   */
  setAnalysis(ph, target) { this.playheads[ph].trackerState.setAnalysis(target); }
  getAnalysis(ph) { return this.playheads[ph].trackerState.analysisTarget; }

  /**
   * The song's mastering chain (item 178, TAUD_ENGINE_SPEC.md §12.1). `params`
   * is the decoded `sMst` record; a neutral one costs nothing at all, so this
   * is safe to push on every load whether the song declares a chain or not.
   *
   * A conforming player MUST call this with what the file declares — the
   * chain is part of how the song sounds, not an editor preference.
   */
  setMastering(ph, params) { this.playheads[ph].trackerState.setMastering(params); }
  getMastering(ph) { return this.playheads[ph].trackerState.masteringParams; }

  /**
   * Install (or drop) the Mastering view's metering tap (loudness.js). Like the
   * strip's analysis tap this costs nothing while off, so a host turns it on
   * only while the view that reads it is on screen.
   */
  setMasterMeter(ph, on, scramble = false, bitDepth = undefined) {
    this.playheads[ph].trackerState.setMasterMeter(on, scramble, bitDepth);
  }

  setSongGlobalVolume(ph, volume) { this.playheads[ph].globalVolume = volume & 255; }
  getSongGlobalVolume(ph) { return this.playheads[ph].globalVolume; }
  setSongMixingVolume(ph, volume) { this.playheads[ph].mixingVolume = volume & 255; }
  getSongMixingVolume(ph) { return this.playheads[ph].mixingVolume; }

  resetParams(ph) { this.playheads[ph].resetParams(); }
  resetSampleFxState(ph) { this.playheads[ph].resetSampleFxState(); }

  getFreePlayhead(fallback) {
    for (let i = 0; i < this.playheads.length; i++) {
      if (!this.playheads[i].isPlaying) return i;
    }
    return fallback;
  }

  /** Drain the pending interrupt latch (read-to-acknowledge, edge-triggered). */
  pollTrackerInterrupts(ph) {
    return this.playheads[ph].trackerState.drainInterrupts();
  }

  // ── jam / audition (AudioAdapter.kt:4322-4337) ──

  /** Voice index of jam-bank slot `i` (item 140). Hosts address the bank
   *  through this rather than by arithmetic, so the base can move. */
  jamVoice(i) { return JAM_VOICE_BASE + (((i | 0) % JAM_VOICES) + JAM_VOICES) % JAM_VOICES; }

  jamNote(ph, vi, note, inst, audition = false) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
    note &= 0xffff;
    inst &= 0x3ff;
    triggerMetaOrNote(this, ts, ts.voices[v], v, note, inst, -1);
    // Audition-only (item 51): a STRICT metainstrument only sounds where its
    // Ixmp zones actually place a sample, so an arbitrary jammed pitch is often
    // silent. In pure-audition contexts (Instruments/Samples views) retry at the
    // nearest note it can actually sound, so the user hears the instrument.
    // Note ENTRY (Timeline/Patterns) keeps the exact pitch.
    if (audition && !ts.voices[v].active &&
        !ts.backgroundVoices.some((b) => b.sourceChannel === v && b.active)) {
      const alt = this._auditionNoteFor(inst, note);
      if (alt >= 0) triggerMetaOrNote(this, ts, ts.voices[v], v, alt, inst, -1);
    }
    p.jamActive = true;
  }

  /**
   * Preview the EXACT pooled sample `spec` (ptr/len/rate/loop) on voice `vi`,
   * BYPASSING all instrument / metainstrument zone resolution. The Samples and
   * Instruments editors call this so the audition plays the wave the user is
   * looking at, not whatever a metainstrument would map `note` to (bug #65).
   * JS-only (no Kotlin counterpart): a scratch instrument in AUDITION_SLOT
   * carries the sample and its clean default envelope so the note simply
   * sounds at full volume until jamStop / sample end.
   * `spec`: { ptr, len, rate, playStart?, loopStart, loopEnd, loopMode, detune?,
   * chanPtr2?, chanMode? } — chanPtr2 auditions a STEREO pair (item 90) by
   * hanging a synthetic full-range 's' patch off the scratch instrument, since
   * only an Ixmp patch can carry a second channel.
   */
  jamSample(ph, vi, note, spec) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
    note &= 0xffff;
    const inst = this.instruments[AUDITION_SLOT];
    inst.samplePtr = spec.ptr >>> 0;
    inst.sampleLength = spec.len | 0;
    inst.samplingRate = spec.rate | 0;
    inst.samplePlayStart = spec.playStart | 0;
    inst.sampleLoopStart = spec.loopStart | 0;
    inst.sampleLoopEnd = spec.loopEnd | 0;
    inst.loopMode = (spec.loopMode | 0) & 0x07; // loop mode + sustain, drop percussion bit
    inst.sampleDetune = (spec.detune | 0) & 0xffff;
    inst.extraPatches = spec.chanPtr2
      ? [makeInstPatch({
          pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
          samplePtr: inst.samplePtr, sampleLength: inst.sampleLength,
          playStart: inst.samplePlayStart, loopStart: inst.sampleLoopStart,
          loopEnd: inst.sampleLoopEnd, samplingRate: inst.samplingRate,
          sampleDetune: inst.sampleDetuneSigned, loopMode: inst.loopMode,
          hasChanBlock: true, chanCount: 2, chanMode: spec.chanMode | 0,
          chanPtrs: [spec.chanPtr2 >>> 0],
        })]
      : null;
    triggerNote(this, ts, ts.voices[v], note, AUDITION_SLOT, -1);
    p.jamActive = true;
  }

  /** True when metainstrument `inst` would produce at least one sounding layer
   *  at `note` (mirrors the strict-layer gating in triggerMetaOrNote). */
  _metaSoundsAt(inst, note) {
    // An FM rack stands or falls on operator 0: the rest of the rack is read
    // through it, so a note its rectangle excludes is silent whatever the
    // modulators say (§5.5.1, triggerFmRack).
    if (inst.isFm) {
      const o = inst.metaLayers[0];
      return inst.fmProgram !== null && o.instIdx >= 1 &&
        note >= o.pitchStart && note <= o.pitchEnd && o.volStart <= 0x3f && o.volEnd >= 0x3f;
    }
    let layers = inst.resolveMetaLayers(note, 0x3f);
    if (inst.metaStrict) {
      layers = layers.filter((l) => {
        // The pitch the layer SOUNDS — a fixed-pitch layer's own (item 179).
        let n = layerNote(l, note);
        n = n < 0x20 ? 0x20 : n > 0xffff ? 0xffff : n;
        return this.instruments[l.instIdx].resolvePatch(n, 0x3f) !== null;
      });
    }
    return layers.length > 0;
  }

  /** Nearest note to `note` (within the metainstrument's layer bboxes) that
   *  actually sounds, or -1 if none / not a metainstrument. */
  _auditionNoteFor(instId, note) {
    const inst = this.instruments[instId];
    if (!inst || !inst.isMeta) return -1;
    let lo = 0xffff, hi = 0x20;
    for (const l of inst.metaLayers) {
      if (l.pitchStart < lo) lo = l.pitchStart;
      if (l.pitchEnd > hi) hi = l.pitchEnd;
    }
    if (lo < 0x20) lo = 0x20;
    if (hi < lo) return -1;
    // Sweep outward from the requested note at a fine step, clamped to the
    // bboxes' union (a jam event, so the cost is irrelevant).
    const step = 0x20;
    for (let d = 0; d <= hi - lo; d += step) {
      const up = note + d, dn = note - d;
      if (up >= lo && up <= hi && this._metaSoundsAt(inst, up)) return up;
      if (dn >= lo && dn <= hi && this._metaSoundsAt(inst, dn)) return dn;
    }
    return -1;
  }

  jamStop(ph) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    for (const v of ts.voices) v.active = false;
    for (const v of ts.backgroundVoices) v.active = false;
    p.jamActive = false;
  }

  /**
   * Stop ONE audition voice and everything it spawned (metainstrument layer
   * children, NNA ghosts) — what a released key of a held chord ends, where
   * jamStop's "deactivate the world" would take the song's own voices with it.
   * `vi < 0` stops the whole jam bank, which is the focus-loss panic: still not
   * a single song voice. JS-only (item 140), no Kotlin counterpart.
   *
   * Ramped through the pattern note-cut's own path (note word 0x0002) rather
   * than dropped on the spot: a key release lands wherever the waveform happens
   * to be, and that ramp exists because stepping to zero there clicks.
   */
  jamStopVoice(ph, vi) {
    const ts = this.playheads[ph].trackerState;
    const lo = vi < 0 ? JAM_VOICE_BASE : Math.min(vi, TOTAL_VOICES - 1);
    const hi = vi < 0 ? TOTAL_VOICES - 1 : lo;
    for (let v = lo; v <= hi; v++) startCutRamp(ts.voices[v]);
    for (const bg of ts.backgroundVoices) {
      if (bg.sourceChannel >= lo && bg.sourceChannel <= hi) startCutRamp(bg);
    }
  }

  // ── per-voice readbacks (delegate 144-325; clamps mirror the delegate) ──

  _voice(ph, vi) {
    const v = Math.min(Math.max(vi, 0), NUM_VOICES - 1);
    return this.playheads[ph].trackerState.voices[v];
  }

  setVoiceMute(ph, vi, muted) { this._voice(ph, vi).fader = muted ? 255 : 0; }
  getVoiceMute(ph, vi) { return this._voice(ph, vi).fader === 255; }
  setVoiceFader(ph, vi, fader) { this._voice(ph, vi).fader = fader & 255; }
  getVoiceFader(ph, vi) { return this._voice(ph, vi).fader; }

  getVoiceEffectiveVolume(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 0.0;
    const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
    const faderGain = (255 - v.fader) / 255.0;
    return Math.min(Math.max(effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain, 0.0), 1.0);
  }

  /** Pan as the stereo meters want it: a surround voice reports where the
   *  monitor downmix puts it (rear positions fold onto the front arc). */
  getVoiceEffectivePan(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 128;
    if (this.playheads[ph].surroundModel !== SURROUND_STEREO) {
      return Math.round(foldAzimuthToPan(voiceAzimuth(v)));
    }
    // Panbrello counts here (the surround branch already has it, via
    // voiceAzimuth): it is a commanded movement the meter should show. The
    // random pan swing still does not — that is per-trigger jitter, not a
    // position the song asked for.
    if (v.hasPanEnv && v.panEnvOn) {
      const envPanRaw = Math.min(Math.max(Math.trunc(v.envPan * 255.0), 0), 255);
      return Math.min(Math.max(v.channelPan + v.notePan + envPanRaw - 128 + v.panbrelloOffset,
        0), 255);
    }
    return Math.min(Math.max(v.channelPan + v.notePan + v.panbrelloOffset, 0), 255);
  }

  /** Where a voice actually sits (#998): 512-unit azimuth, 128-unit elevation.
   *  Stereo songs report the pan byte's front-arc position. */
  getVoiceSpatialAzimuth(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[ph].surroundModel === SURROUND_STEREO
      ? clamp(v.channelPan + v.notePan + v.panbrelloOffset, 0, 255) : voiceAzimuth(v);
  }
  getVoiceSpatialElevation(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[ph].surroundModel === SURROUND_STEREO ? 0 : voiceElevation(v);
  }

  getVoiceActive(ph, vi) { return this._voice(ph, vi).active; }

  getActiveNoteCounts(ph) {
    const counts = new Int32Array(1024);
    const ts = this.playheads[ph].trackerState;
    for (const v of ts.voices) {
      if (v.active) counts[v.instrumentId & 0x3ff]++;
    }
    return counts;
  }

  getVoiceInvertSpeed(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.invertSpeed : 0;
  }

  getInstrumentInvertMask(slot) {
    const mask = this.instruments[slot & 0x3ff].invertMask;
    return mask === null ? new Uint8Array(0) : mask.slice();
  }

  /**
   * The instrument's live sample modification (item 130), for the sample view's
   * overlay: the operation, which side of the region it works on, the region as
   * a FRACTION pair plus its comb (item 153), and whatever the operation has
   * accumulated. Plain numbers — the reply crosses a postMessage. The MOD_INVERT
   * bit-mask travels with it as `modMask`.
   *
   * Field names are the instrument's own, so the reply can be handed straight to
   * resolveModGeom / modTouches / extModTouches / modAddressExt / applyExtLevel:
   * the view draws the modification through the engine's own geometry and
   * argument-extension machinery (item 162) rather than a re-implementation of
   * it. The `modOpExt`-and-after fields are only ever live while `modOpExt` is
   * non-zero (see inst.js setModOpExt/clearModState) — harmless to always send.
   */
  getInstrumentSampleMod(slot) {
    const inst = this.instruments[slot & 0x3ff];
    return {
      modOp: inst.modOp, modInvert: inst.modInvert,
      modFrom: inst.modFrom, modTo: inst.modTo,
      modCombBits: inst.modCombBits, modCombOdd: inst.modCombOdd,
      modRot: inst.modRot, modSub: inst.modSub, modOn: inst.modOn,
      modScatter: inst.modScatter, modSeed: inst.modSeed, modEpoch: inst.modEpoch,
      modOpExt: inst.modOpExt, modF: inst.modF, modStepIndex: inst.modStepIndex,
      modXor: inst.modXor, modBitRot: inst.modBitRot,
      modBitPermIdx: inst.modBitPermIdx, modBitPermOn: inst.modBitPermOn,
      modExtSwapA: inst.modExtSwapA, modExtSwapB: inst.modExtSwapB,
      modExtMirror: inst.modExtMirror,
      // 102/12x: the instrument's own funk-repeat walk (item 173 follow-up),
      // for the Samples view's overlay — same idea as SNAP_V_FUNK_POS/LEN
      // above, but this state is the INSTRUMENT's, not a voice's.
      modFunkWalk: inst.modFunkWalk, modFunkPos: inst.modFunkPos, modFunkLen: inst.modFunkLen,
    };
  }

  /** The modification's inversion mask, one bit per SAMPLE byte (item 130). */
  getInstrumentModMask(slot) {
    const mask = this.instruments[slot & 0x3ff].modMask;
    return mask === null ? new Uint8Array(0) : mask.slice();
  }

  getVoiceNote(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.noteVal & 0xffff : 0;
  }

  getVoiceInstrument(ph, vi) {
    const v = this._voice(ph, vi);
    // Pattern-level instrument (meta slot), not the resolved layer child.
    return v.active ? (v.displayInst || v.instrumentId) & 0x3ff : 0;
  }

  getVoiceSamplePos(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.samplePos : -1.0;
  }

  getVoiceSamplePtr(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.activeSamplePtr : -1;
  }

  getVoiceSampleLength(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.activeSampleLength : 0;
  }

  getVoiceEnvVolIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envIndex : -1; }
  getVoiceEnvVolTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envTimeSec : 0.0; }
  getVoiceEnvPanIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanIndex : -1; }
  getVoiceEnvPanTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanTimeSec : 0.0; }
  getVoiceEnvPitchIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchIndex : -1; }
  getVoiceEnvPitchTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchTimeSec : 0.0; }
  getVoiceEnvFilterIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterIndex : -1; }
  getVoiceEnvFilterTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterTimeSec : 0.0; }

  // ── rendering ──

  /**
   * Render one 512-frame chunk (interleaved U8 stereo, 1024 bytes) for playhead
   * ph. Pass a reusable out buffer to avoid allocation; a fresh one is made
   * otherwise. Returns the buffer (or null when the playhead has no state).
   */
  renderChunk(ph, out = new Uint8Array(TRACKER_CHUNK * 2)) {
    return generateTrackerAudio(this, this.playheads[ph], out);
  }
}
