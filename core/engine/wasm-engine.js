// TaudEngine over WebAssembly — the JavaScript half of the engine's host API
// (core/engine/c/src/wasm_api.c). One object ≈ one device, with the method
// names engine.js has always had, so the worklet's command dispatcher, the
// render Worker and the offline renderer drive either engine the same way.
//
// Each engine is a WebAssembly INSTANCE of its own (wasm-module.js): its own
// linear memory, given back when the object is collected. Nothing here needs
// freeing by hand.
//
// What crosses the boundary:
//  - numbers, as numbers;
//  - bytes (patterns, cues, instrument records, patch blobs), copied into a
//    scratch buffer in the module's memory;
//  - the sample pool, copied ONCE into a buffer the engine then owns, trimmed
//    to its last non-zero byte (a read past it is the zero the pool holds);
//  - the mastering chain, the mixing chains and the lyrics, as the bytes the
//    FILE holds them in — built here by the section codecs, read there by the
//    parsers a file is read with.
//
// A pointer comes back from the module as a SIGNED 32-bit integer, so an
// address in the upper half of a 4 GiB memory arrives negative: every one is
// taken `>>> 0` before it is used as an offset on this side.
//
// The playhead argument every transport call takes is kept for the callers'
// sake; this engine has one playhead, 0.

import { instantiateEngine } from "./wasm-module.js";
import {
  SAMPLE_BIN_TOTAL, SAMPLING_RATE, TRACKER_CHUNK, MAX_VOICES, NUM_VOICES, CUE_BYTES, CUE_BYTES_64,
  JAM_VOICES, JAM_VOICE_BASE, TOTAL_VOICES,
} from "./constants.js";
import { engineSeed } from "./rng.js";
import {
  ANALYSIS_OFF, ANALYSIS_STEREO, ANALYSIS_AMBISONIC, ANALYSIS_MAX_METERS, SCOPE_FRAMES, SCOPE_CHANNELS,
} from "./analysis.js";
import {
  TAP_STAGES, SPEC_FRAMES, HIST_BUCKETS, DEFAULT_BIT_DEPTH, HIST_SPAN_ALL, HIST_SPAN_LONG, HIST_SPAN_SHORT,
} from "./loudness.js";
import { defaultMastering } from "./mastering.js";
import { SPEAKER_LAYOUT_NAMES } from "./speakers.js";
import { buildMasteringBlock } from "../format/mastering-section.js";
import { buildImixSection } from "../format/imix-section.js";

const WASM_NO_BYTES = new Uint8Array(0);

// The meters' readouts (core/engine/c/src/meters.c; the MM_R_* and
// AN_READOUT of taud_internal.h): flat arrays of doubles.
const MM_R_FRAMES = 0, MM_R_COMP_GR = 1, MM_R_LIM_GR = 2, MM_R_SUM_Z = 3, MM_R_PEAK = 5;
const MM_R_TRUE_PEAK = 9, MM_R_MEAN_SQUARE = 13, MM_R_CLIP = 17, MM_R_AP_PEAK = 21, MM_R_AP_SUM_SQ = 23;
const MM_R_BIT_DEPTH = 25, MM_R_HIST_SPAN = 26, MM_R_SPEC_WRITE = 27, MM_R_BITS = 28, MM_R_BUCKETS = 36;
const MM_READOUT = MM_R_BUCKETS + HIST_BUCKETS;
const AN_READOUT = 7 + 4 * ANALYSIS_MAX_METERS;

/** te_bit_usage's eight figures as loudness.js has always named them. */
function bitsFrom(d, o) {
  return {
    used: d[o], span: d[o + 1], total: d[o + 2], peakCode: d[o + 3],
    minCode: d[o + 4], maxCode: d[o + 5], effectiveBits: d[o + 6], entropyBits: d[o + 7],
  };
}

/** Read te_analysis_drain's readout (AN_READOUT doubles at `p` in `buf`)
 *  into an analysis.js makeAnalysisReadout. */
export function readAnalysisReadout(buf, p, out) {
  const r = new Float64Array(buf, p, AN_READOUT);
  out.meterCount = r[0];
  out.frames = r[1];
  out.fieldEnergy = r[2];
  out.corrLL = r[3];
  out.corrRR = r[4];
  out.corrLR = r[5];
  out.ringWrite = r[6];
  const M = ANALYSIS_MAX_METERS;
  for (let c = 0; c < M; c++) {
    out.peak[c] = r[7 + c];
    out.truePeak[c] = r[7 + M + c];
    out.meanSquare[c] = r[7 + 2 * M + c];
    out.clip[c] = r[7 + 3 * M + c];
  }
  return out;
}

/** Read te_master_meter_drain's readout (MM_READOUT doubles at `p`) into a
 *  loudness.js makeMasterMeterReadout, its rings as views of the tap's at
 *  `rings` and `pairs` (valid until the module's memory next moves). */
export function readMasterMeterReadout(buf, p, rings, pairs, out) {
  const r = new Float64Array(buf, p, MM_READOUT);
  out.frames = r[MM_R_FRAMES];
  out.compGrDb = r[MM_R_COMP_GR];
  out.limGrDb = r[MM_R_LIM_GR];
  for (let s = 0; s < TAP_STAGES; s++) {
    out.sumZ[s] = r[MM_R_SUM_Z + s];
    out.apPeak[s] = r[MM_R_AP_PEAK + s];
    out.apSumSq[s] = r[MM_R_AP_SUM_SQ + s];
  }
  for (let i = 0; i < TAP_STAGES * 2; i++) {
    out.peak[i] = r[MM_R_PEAK + i];
    out.truePeak[i] = r[MM_R_TRUE_PEAK + i];
    out.meanSquare[i] = r[MM_R_MEAN_SQUARE + i];
    out.clip[i] = r[MM_R_CLIP + i];
  }
  out.bitDepth = r[MM_R_BIT_DEPTH];
  out.histSpan = r[MM_R_HIST_SPAN];
  out.specWrite = r[MM_R_SPEC_WRITE];
  out.bits = bitsFrom(r, MM_R_BITS);
  out.histTotal = out.bits.total;
  if (!out.buckets) out.buckets = new Float64Array(HIST_BUCKETS);
  out.buckets.set(r.subarray(MM_R_BUCKETS, MM_R_BUCKETS + HIST_BUCKETS));
  out.spec = [];
  out.pair = [];
  for (let s = 0; s < TAP_STAGES; s++) {
    out.spec.push(new Float32Array(buf, rings + s * SPEC_FRAMES * 4, SPEC_FRAMES));
    out.pair.push(new Float32Array(buf, pairs + s * SPEC_FRAMES * 8, SPEC_FRAMES * 2));
  }
  return out;
}

/** A census's eight figures and HIST_BUCKETS counts (te_master_meter_census's
 *  output at `p`), as { bits, buckets }. */
export function readCensus(buf, p) {
  const r = new Float64Array(buf, p, 8 + HIST_BUCKETS);
  return { bits: bitsFrom(r, 0), buckets: r.slice(8, 8 + HIST_BUCKETS) };
}

/**
 * The master strip's tap as the page knows it — the tap itself is the
 * engine's (meters.c). `drain` hands an interval over into a readout of
 * analysis.js makeAnalysisReadout's shape and starts the next; the snapshot
 * drains it the same way (tw_fill_snapshot).
 */
export class WasmAnalysisTap {
  constructor(eng, target) {
    this._eng = eng;
    this.target = target;
  }
  drain(out) {
    const eng = this._eng;
    const p = eng._readout();
    if (!eng._x.tw_analysis_drain(eng._e, p)) return null;
    return readAnalysisReadout(eng._x.memory.buffer, p, out);
  }
  /** The B-format scope ring (SCOPE_FRAMES frames of SCOPE_CHANNELS), a view
   *  of the module's memory valid until the next call into the engine. */
  get ring() {
    const x = this._eng._x;
    return new Float32Array(x.memory.buffer, x.tw_analysis_ring(this._eng._e) >>> 0, SCOPE_FRAMES * SCOPE_CHANNELS);
  }
}

/**
 * The Mastering view's tap as the page knows it — the tap itself is the
 * engine's (meters.c). `drain` fills a loudness.js makeMasterMeterReadout;
 * its rings are views of the module's memory, valid until the next call into
 * the engine.
 */
export class WasmMasterMeter {
  constructor(eng, scramble, bitDepth, histSpan) {
    this._eng = eng;
    this.scramble = scramble;
    this.bitDepth = bitDepth;
    this._span = histSpan;
  }
  /** Which census `drain` reports (HIST_SPAN_*): a reporting choice only. */
  get histSpan() { return this._span; }
  set histSpan(span) {
    this._span = span;
    this._eng._x.tw_set_master_meter(this._eng._e, 1, this.scramble ? 1 : 0, this.bitDepth, span);
  }
  drain(out) {
    const eng = this._eng;
    const x = eng._x;
    const p = eng._readout();
    if (!x.tw_master_meter_drain(eng._e, p)) return null;
    return readMasterMeterReadout(x.memory.buffer, p, x.tw_master_meter_rings(eng._e) >>> 0,
      x.tw_master_meter_pairs(eng._e) >>> 0, out);
  }
  /** One census's figures and its HIST_BUCKETS raw counts — `span` the take
   *  (HIST_SPAN_ALL, the default) or a rolling one. Drains nothing. */
  census(span = HIST_SPAN_ALL) {
    const eng = this._eng;
    const x = eng._x;
    const p = eng._readout();
    const depth = x.tw_master_meter_census(eng._e, span, p, p + 8 * 8);
    return { bitDepth: depth, ...readCensus(x.memory.buffer, p) };
  }
}

/**
 * One `ILyr` entry (file format §9.17) as the engine reads it: the header,
 * the recipes and the syllables, and none of the editor's tail (the text, the
 * overrides), which is not the engine's business — and whose codec
 * (format/lyric-section.js) needs a TextEncoder, which an AudioWorklet may
 * not have. Byte for byte lyric-section.js's buildLyricEntry up to that tail.
 */
function lyricEntryBytes(instId, syllables, recipes) {
  const S = Math.min(syllables.length, 0xffff);
  const R = Math.min(recipes.length, 0xff);
  const bodyLen = 4 + R * 12 + S * 12;
  const out = new Uint8Array(6 + bodyLen);
  out[0] = instId & 0xff; out[1] = (instId >>> 8) & 0x03;
  out[2] = bodyLen & 0xff; out[3] = (bodyLen >>> 8) & 0xff;
  out[4] = (bodyLen >>> 16) & 0xff; out[5] = (bodyLen >>> 24) & 0xff;
  let o = 6;
  out[o] = S & 0xff; out[o + 1] = S >>> 8; out[o + 2] = R; out[o + 3] = 0;
  o += 4;
  for (let k = 0; k < R; k++) {
    const r = recipes[k];
    out[o] = r.cons & 0xff;
    out[o + 1] = r.ptr & 0xff; out[o + 2] = (r.ptr >>> 8) & 0xff; out[o + 3] = (r.ptr >>> 16) & 0xff;
    out[o + 4] = r.len & 0xff; out[o + 5] = (r.len >>> 8) & 0xff;
    out[o + 6] = r.offset & 0xff; out[o + 7] = (r.offset >>> 8) & 0xff;
    out[o + 8] = r.rate & 0xff; out[o + 9] = (r.rate >>> 8) & 0xff;
    out[o + 10] = r.tilt & 0xff;
    out[o + 11] = r.gain & 0xff;
    o += 12;
  }
  for (let k = 0; k < S; k++) {
    const s = syllables[k];
    out[o] = s.front & 0xff; out[o + 1] = s.open & 0xff; out[o + 2] = s.round & 0xff;
    out[o + 3] = (s.vowel ? 0x01 : 0) | (s.nasal ? 0x02 : 0);
    out[o + 4] = s.gr & 0xff;
    for (let c = 0; c < 3; c++) out[o + 5 + c] = s.cons[c] & 0xff;
    for (let c = 0; c < 4; c++) out[o + 8 + c] = s.timing[c] & 0xff;
    o += 12;
  }
  return out;
}

/** The one playhead's readable state, in the shape callers reach for
 *  (`eng.playheads[0].trackerState.mixLeft`). */
export class WasmTrackerState {
  constructor(eng) {
    this._eng = eng;
    // The master strip's and the Mastering view's taps (meters.c) — handles
    // on the engine's own, null = off, and then they cost nothing. The
    // Mixing tab's (imixtap.c) have no handle: the snapshot is their face.
    this.analysis = null;
    this.analysisTarget = ANALYSIS_OFF;
    this.masterMeter = null;
  }

  drainInterrupts() { return this._eng._x.tw_poll_interrupts(this._eng._e) >>> 0; }
  interruptArg(n) { return this._eng._x.tw_interrupt_arg(this._eng._e, n); }
  get surroundModel() { return this._eng._x.tw_get_surround_model(this._eng._e); }
  /** Voices sounding now — lanes, jam bank and background list (a profiler's reading). */
  get soundingVoices() { return this._eng._x.tw_sounding_voices(this._eng._e); }

  /** The float mix bus of the chunk just rendered — views into the module's
   *  memory, valid until the next call into the engine. */
  get mixLeft() { return this._eng._mixView(0); }
  get mixRight() { return this._eng._mixView(1); }
  get cuePos() { return this._eng._x.tw_get_cue_pos(this._eng._e); }
  get rowIndex() { return this._eng._x.tw_get_tracker_row(this._eng._e); }
  get tickInRow() { return this._eng._x.tw_get_tick_in_row(this._eng._e); }
  get tuningRatio() { return this._eng._x.tw_get_tuning_ratio(this._eng._e); }
}

export class WasmPlayhead {
  constructor(eng, trackerState = new WasmTrackerState(eng)) {
    this._eng = eng;
    this.trackerState = trackerState;
  }
  get isPlaying() { return this._eng._x.tw_is_playing(this._eng._e) !== 0; }
  get jamActive() { return this._eng._x.tw_jam_active(this._eng._e) !== 0; }
  get position() { return this._eng._x.tw_get_cue_position(this._eng._e); }
  get bpm() { return this._eng._x.tw_get_bpm(this._eng._e); }
  get tickRate() { return this._eng._x.tw_get_tick_rate(this._eng._e); }
  get globalVolume() { return this._eng._x.tw_get_song_global_volume(this._eng._e); }
  get mixingVolume() { return this._eng._x.tw_get_song_mixing_volume(this._eng._e); }
  get masterVolume() { return this._eng._x.tw_get_master_volume(this._eng._e); }
  get masterPan() { return this._eng._x.tw_get_master_pan(this._eng._e); }
}

export class WasmTaudEngine {
  /** `rate`: the engine's output rate, fixed for its life (the JavaScript
   *  engine reads constants.js's SAMPLING_RATE as it goes; this one is built
   *  at whatever that is now). */
  constructor(rate = SAMPLING_RATE) {
    const x = instantiateEngine();
    this._x = x;
    this._e = x.tw_new(rate);
    if (!this._e) throw new Error("taud engine: out of memory");
    x.tw_seed(this._e, engineSeed());
    this._u8v = null;
    this._mixBuf = null;
    this._mixViews = null;
    this._scratchPtr = 0;
    this._scratchLen = 0;
    this._snapPtr = 0;
    this._snapLen = 0;
    this._mastering = defaultMastering();
    this._stemBus = null;
    this._stemVoices = null;
    this._chunkPtr = x.malloc(TRACKER_CHUNK * 2) >>> 0;
    this._readPtr = 0;
    this.rate = rate;
    this.playheads = [this._makePlayhead()];
  }

  /** Bytes of WebAssembly memory this engine's instance holds (it only grows) —
   *  a profiler's reading. */
  get memoryBytes() { return this._x.memory.buffer.byteLength; }

  /** The playhead object (a subclass that can see inside the engine makes a
   *  fuller one: core/engine/engine.js). */
  _makePlayhead() { return new WasmPlayhead(this); }

  // ── memory ──

  /** The module's memory as bytes. A view dies whenever the memory grows, so
   *  it is taken afresh after anything that may have allocated. */
  _u8() {
    const buf = this._x.memory.buffer;
    if (this._u8v === null || this._u8v.buffer !== buf) this._u8v = new Uint8Array(buf);
    return this._u8v;
  }

  /** A buffer in the module's memory for a meter's readout (doubles). */
  _readout() {
    if (!this._readPtr) {
      this._readPtr = this._x.malloc(MM_READOUT * 8) >>> 0;
      if (!this._readPtr) throw new Error("taud engine: out of memory");
    }
    return this._readPtr;
  }

  _f32(ptr, n) {
    return new Float32Array(this._x.memory.buffer, ptr, n);
  }

  /** The mix bus's left (0) or right (1) side, one view kept per side for as
   *  long as the memory stands still — callers read it a sample at a time. */
  _mixView(side) {
    const buf = this._x.memory.buffer;
    if (this._mixBuf !== buf) {
      this._mixBuf = buf;
      this._mixViews = [
        new Float32Array(buf, this._x.tw_mix_left(this._e) >>> 0, TRACKER_CHUNK),
        new Float32Array(buf, this._x.tw_mix_right(this._e) >>> 0, TRACKER_CHUNK),
      ];
    }
    return this._mixViews[side];
  }

  /** `bytes` copied into the scratch buffer; returns where. */
  _put(bytes) {
    const n = bytes.length;
    if (n > this._scratchLen) {
      if (this._scratchPtr) this._x.free(this._scratchPtr);
      this._scratchLen = Math.max(n, 4096);
      this._scratchPtr = this._x.malloc(this._scratchLen) >>> 0;
      if (!this._scratchPtr) {
        this._scratchLen = 0;
        throw new Error("taud engine: out of memory");
      }
    }
    this._u8().set(bytes, this._scratchPtr);
    return this._scratchPtr;
  }

  /**
   * Free whatever replaced instrument data no voice points at any more, and
   * return how many blocks are still held. The engine sweeps by itself as the
   * list grows — a re-uploaded instrument's old tables stay alive under the
   * notes still playing from them, as a garbage collector would keep them —
   * so this is for a test, or a host that wants the memory back at once.
   */
  retireSweep() { return this._x.tw_retire_sweep(this._e); }

  /** True once an allocation inside the engine has failed. */
  get outOfMemory() { return this._x.tw_oom(this._e) !== 0; }

  channelCount() { return this.is64ChannelMode ? MAX_VOICES : NUM_VOICES; }
  cueByteStride() { return this.is64ChannelMode ? CUE_BYTES_64 : CUE_BYTES; }
  get is64ChannelMode() { return this._x.tw_get_64_channel_mode(this._e) !== 0; }
  get wideCells() { return this._x.tw_get_cell_format(this._e) !== 0; }

  // ── content upload ──

  /** Install a DECOMPRESSED sample+instrument image: 8 MB of samples, then up
   *  to 1024 256-byte instrument records. Returns the bytes taken (0 when the
   *  image is too short to be one). */
  uploadSampleInstBlob(image) {
    const x = this._x;
    if (image.length < SAMPLE_BIN_TOTAL + 65536) return 0;
    let n = SAMPLE_BIN_TOTAL;
    while (n > 0 && image[n - 1] === 0) n--;
    let pool = 0;
    if (n > 0) {
      pool = x.malloc(n) >>> 0;
      if (!pool) throw new Error("taud engine: out of memory");
      this._u8().set(image.subarray(0, n), pool);
    }
    const instCount = Math.min(1024, Math.trunc((image.length - SAMPLE_BIN_TOTAL) / 256));
    const inst = this._put(image.subarray(SAMPLE_BIN_TOTAL, SAMPLE_BIN_TOTAL + instCount * 256));
    x.tw_upload_sample_inst(this._e, pool, n, inst, instCount);
    return image.length;
  }

  /** Upload up to 256 bytes defining instrument slot (0-1023). */
  uploadInstrument(slot, bytes) {
    const b = bytes.length > 256 ? bytes.subarray(0, 256) : bytes;
    this._x.tw_upload_instrument(this._e, slot, this._put(b), b.length);
  }

  /** Upload an Ixmp "extra samples" block for instrument slot. */
  uploadInstrumentPatches(slot, bytes) {
    this._x.tw_upload_instrument_patches(this._e, slot, this._put(bytes), bytes.length);
  }

  getInstrumentPatchCount(slot) { return this._x.tw_instrument_patch_count(this._e, slot); }
  clearInstrumentPatches(slot) { this._x.tw_clear_instrument_patches(this._e, slot); }

  /** Name the mixing chain an instrument runs through, overriding byte 255 of
   *  its record without rewriting it. */
  setInstrumentImixId(slot, id) { this._x.tw_set_instrument_imix_id(this._e, slot, id); }

  clearPattern(slot) { this._x.tw_clear_pattern(this._e, slot); }

  uploadPattern(slot, bytes) {
    this._x.tw_upload_pattern(this._e, slot, this._put(bytes), bytes.length);
  }

  /** Select the file format's cell layout (version 3 = the wide cell). Set it
   *  BEFORE uploading anything. */
  setCellFormat(wide) { this._x.tw_set_cell_format(this._e, wide ? 1 : 0); }
  getCellFormat() { return this.wideCells; }

  uploadCue(idx, bytes) {
    this._x.tw_upload_cue(this._e, idx, this._put(bytes), bytes.length);
  }

  set64ChannelMode(enabled) { this._x.tw_set_64_channel_mode(this._e, enabled ? 1 : 0); }

  // ── the song's chains and lyrics ──

  /** The song's mastering chain: the decoded `sMst` record, or null. */
  setMastering(ph, params) {
    this._mastering = params ?? null;
    if (params === null || params === undefined) {
      this._x.tw_set_mastering(this._e, 0, 0);
      return;
    }
    const block = buildMasteringBlock(params);
    this._x.tw_set_mastering(this._e, this._put(block), block.length);
  }

  /** The chain's parameters as they were given (neutral until a host gives some). */
  getMastering(ph) { return this._mastering; }

  /**
   * A multichannel export's chain (engine spec §12.3): `params` run over the
   * render target's bus — as wide as it is NOW, so install the target first —
   * after every chunk, or null for none. The pair's own chain is the
   * caller's to switch off (setMastering).
   */
  setBusMastering(ph, params) {
    if (params === null || params === undefined) {
      this._x.tw_set_bus_mastering(this._e, 0, 0);
      return;
    }
    const block = buildMasteringBlock(params);
    this._x.tw_set_bus_mastering(this._e, this._put(block), block.length);
  }

  /** The project's instrument mixing chains: every IMix block (an array or a
   *  Map by id). Replaces the whole set; a block that keeps its id keeps its
   *  running state. */
  setImix(blocks) {
    const list = !blocks ? [] : blocks instanceof Map ? [...blocks.values()] : [...blocks];
    const section = buildImixSection(list) ?? WASM_NO_BYTES;
    if (this._x.tw_set_imix(this._e, this._put(section), section.length) < 0) {
      throw new Error("taud engine: out of memory");
    }
  }

  /** The instruments' pitch extensions: the whole `IPit` payload (file format
   *  §9.18), or null / empty for none. Applied now, and again whenever an
   *  instrument's record or patch list is uploaded. */
  setPitchExt(bytes) {
    const n = bytes ? bytes.length : 0;
    this._x.tw_set_pitch_ext(this._e, n > 0 ? this._put(bytes) : 0, n);
    if (this._x.tw_oom(this._e)) throw new Error("taud engine: out of memory");
  }

  /** The project's lyrics: decoded `ILyr` entries, replacing what was there.
   *  The first entry for an instrument wins; one without syllables is none. */
  setLyrics(entries) {
    const seen = new Set();
    const parts = [];
    let total = 0;
    for (const e of entries ?? []) {
      const id = e.instId & 0x3ff;
      if (seen.has(id) || !e.syllables || e.syllables.length === 0) continue;
      seen.add(id);
      const part = lyricEntryBytes(id, e.syllables, e.recipes ?? []);
      parts.push(part);
      total += part.length;
    }
    const section = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { section.set(p, o); o += p.length; }
    if (this._x.tw_set_lyrics(this._e, this._put(section), section.length) < 0) {
      throw new Error("taud engine: out of memory");
    }
  }

  // ── transport / params ──

  setTrackerMode(ph) { /* the tracker is the only mode */ }
  play(ph) { this._x.tw_play(this._e); }
  stop(ph) { this._x.tw_stop(this._e); }
  isPlaying(ph) { return this._x.tw_is_playing(this._e) !== 0; }

  setMasterVolume(ph, volume) { this._x.tw_set_master_volume(this._e, volume); }
  getMasterVolume(ph) { return this._x.tw_get_master_volume(this._e); }
  setMasterPan(ph, pan) { this._x.tw_set_master_pan(this._e, pan); }
  getMasterPan(ph) { return this._x.tw_get_master_pan(this._e); }

  setBPM(ph, bpm) { this._x.tw_set_bpm(this._e, bpm); }
  getBPM(ph) { return this._x.tw_get_bpm(this._e); }
  setTickRate(ph, rate) { this._x.tw_set_tick_rate(this._e, rate); }
  getTickRate(ph) { return this._x.tw_get_tick_rate(this._e); }

  setTuning(ph, baseNote, freq) { this._x.tw_set_tuning(this._e, baseNote, freq); }
  getTuningRatio(ph) { return this._x.tw_get_tuning_ratio(this._e); }

  setCuePosition(ph, pos) { this._x.tw_set_cue_position(this._e, pos); }
  getCuePosition(ph) { return this._x.tw_get_cue_position(this._e); }
  setTrackerRow(ph, row) { this._x.tw_set_tracker_row(this._e, row); }
  getTrackerRow(ph) { return this._x.tw_get_tracker_row(this._e); }

  setTrackerMixerFlags(ph, flags) { this._x.tw_set_tracker_mixer_flags(this._e, flags); }
  getTrackerMixerFlags(ph) { return this._x.tw_get_tracker_mixer_flags(this._e); }

  setSurroundModel(ph, model) {
    this._x.tw_set_surround_model(this._e, model);
    // The tap's shape follows the model (TrackerState.setSurroundModel).
    this.setAnalysis(0, this.playheads[0].trackerState.analysisTarget);
  }

  // ── metering taps ──

  /**
   * Master-strip analysis tap: ANALYSIS_OFF, ANALYSIS_STEREO, ANALYSIS_AMBISONIC
   * or a speaker-layout key. Costs nothing while off. The tap is the engine's
   * (meters.c); its shape follows the song's surround model and the render
   * target as they stand, which is why every call that moves either installs
   * it again here.
   */
  setAnalysis(ph, target) {
    const x = this._x;
    const ts = this.playheads[0].trackerState;
    ts.analysisTarget = target;
    if (target === ANALYSIS_OFF || target === undefined) {
      x.tw_set_analysis(this._e, -1, 0);
      ts.analysis = null;
      return;
    }
    // 0 the pair, 1 the field, 2 a speaker layout (1… in speakers.js's order;
    // a name that is none of them meters the field).
    if (target === ANALYSIS_STEREO) x.tw_set_analysis(this._e, 0, 0);
    else if (target === ANALYSIS_AMBISONIC) x.tw_set_analysis(this._e, 1, 0);
    else x.tw_set_analysis(this._e, 2, SPEAKER_LAYOUT_NAMES.indexOf(target) + 1);
    ts.analysis = new WasmAnalysisTap(this, target);
  }
  getAnalysis(ph) { return this.playheads[0].trackerState.analysisTarget; }

  /** Install, keep or drop the Mastering view's metering tap (meters.c). A
   *  new all-pass choice or census depth is a new tap; the span carries. */
  setMasterMeter(ph, on, scramble = false, bitDepth = DEFAULT_BIT_DEPTH, histSpan = HIST_SPAN_ALL) {
    const ts = this.playheads[0].trackerState;
    if (!on) {
      this._x.tw_set_master_meter(this._e, 0, 0, DEFAULT_BIT_DEPTH, 0);
      ts.masterMeter = null;
      return;
    }
    const depth = bitDepth === 8 ? 8 : 16;
    const s = histSpan | 0;
    const span = s === HIST_SPAN_LONG || s === HIST_SPAN_SHORT ? s : HIST_SPAN_ALL;
    this._x.tw_set_master_meter(this._e, 1, scramble ? 1 : 0, depth, span);
    if (ts.masterMeter === null || ts.masterMeter.scramble !== !!scramble || ts.masterMeter.bitDepth !== depth) {
      ts.masterMeter = new WasmMasterMeter(this, !!scramble, depth, span);
    }
    ts.masterMeter._span = span;
  }

  /** Install (or drop, slot < 0) the Mixing tab's tap on one instrument's
   *  bus, in `seat` (one per split pane). The tap runs inside the engine, in
   *  the chain it meters; fillSnapshot writes its block. */
  setImixMeter(ph, slot, seat = 0) { this._x.tw_set_imix_meter(this._e, slot, seat); }
  getSurroundModel(ph) { return this._x.tw_get_surround_model(this._e); }
  /**
   * Swap the render target the object bus feeds: null = the device's own
   * monitor; an exporter passes one of spatial.js's or speakers.js's renderers
   * (a stereo fold, an ambisonic basis, a speaker layout). The renderer object
   * only NAMES the target — the engine has its own of each kind — and the bus
   * is `spatialBus()`. No-op for a stereo song.
   */
  setSpatialRenderer(ph, renderer) {
    const x = this._x;
    if (renderer === null || renderer === undefined) {
      x.tw_set_spatial_renderer(this._e, -1, 0, 0, 0);
    } else {
      const name = String(renderer.name);
      const ambi = name.match(/^ambisonic(2d|3d)-o(\d)$/);
      const spk = name.match(/^speakers-(.+)$/);
      if (name === "stereo") x.tw_set_spatial_renderer(this._e, 0, 0, 0, 0);
      else if (ambi) x.tw_set_spatial_renderer(this._e, 3, +ambi[2], ambi[1] === "2d" ? 1 : 0, 0);
      else if (spk && SPEAKER_LAYOUT_NAMES.includes(spk[1])) {
        x.tw_set_spatial_renderer(this._e, 4, 0, 0, SPEAKER_LAYOUT_NAMES.indexOf(spk[1]) + 1);
      } else throw new Error(`taud engine: no render target "${name}"`);
    }
    // Re-applying the surround model starts the tap afresh, as it always has.
    this.setAnalysis(0, this.playheads[0].trackerState.analysisTarget);
  }

  /** The object bus of the chunk just rendered — channel-major, TRACKER_CHUNK
   *  frames a channel, a view of the module's memory — or null for a stereo
   *  song. */
  spatialBus() {
    const p = this._x.tw_spatial_bus(this._e) >>> 0;
    if (!p) return null;
    return new Float64Array(this._x.memory.buffer, p, this._x.tw_spatial_bus_channels(this._e) * TRACKER_CHUNK);
  }

  setMonitorMode(ph, mode) {
    this._x.tw_set_monitor_mode(this._e, mode);
    // Re-applying the surround model starts the tap afresh, as it always has.
    this.setAnalysis(0, this.playheads[0].trackerState.analysisTarget);
  }
  getMonitorMode(ph) { return this._x.tw_get_monitor_mode(this._e); }

  setSongGlobalVolume(ph, volume) { this._x.tw_set_song_global_volume(this._e, volume); }
  getSongGlobalVolume(ph) { return this._x.tw_get_song_global_volume(this._e); }
  setSongMixingVolume(ph, volume) { this._x.tw_set_song_mixing_volume(this._e, volume); }
  getSongMixingVolume(ph) { return this._x.tw_get_song_mixing_volume(this._e); }

  resetSampleFxState(ph) { this._x.tw_reset_sample_fx_state(this._e); }
  resetParams(ph) {
    this._x.tw_reset_params(this._e);
    this._mastering = defaultMastering(); // the reset puts the chain back to neutral
    const ts = this.playheads[0].trackerState;
    this.setAnalysis(0, ts.analysisTarget); // the reset re-applies the surround model
  }

  /** Put the playhead on row `row` of cue `cue` in the state the song itself
   *  arrives there with (the chase, engine spec §15.1), ready for play().
   *  Returns false when the song's own path never reaches that row. */
  chaseTrackerRow(ph, cue, row) {
    return this._x.tw_chase_tracker_row(this._e, cue, row) !== 0;
  }

  getFreePlayhead(fallback) { return this.isPlaying(0) ? fallback : 0; }

  // ── jam / audition ──

  /** Voice index of jam-bank slot `i`. */
  jamVoice(i) { return JAM_VOICE_BASE + (((i | 0) % JAM_VOICES) + JAM_VOICES) % JAM_VOICES; }

  jamNote(ph, vi, note, inst, audition = false) {
    this._x.tw_jam_note(this._e, vi, note, inst, audition ? 1 : 0);
  }

  /** Preview the EXACT pooled sample `spec` names on voice `vi`:
   *  { ptr, len, rate, playStart?, loopStart, loopEnd, loopMode, detune?,
   *  chanPtr2?, chanMode? }. */
  jamSample(ph, vi, note, spec) {
    const p = this._put(new Uint8Array(48));
    const w = new Int32Array(this._x.memory.buffer, p, 12);
    w[0] = spec.ptr >>> 0;
    w[1] = spec.len | 0;
    w[2] = spec.rate | 0;
    w[3] = spec.playStart | 0;
    w[4] = spec.loopStart | 0;
    w[5] = spec.loopEnd | 0;
    w[6] = spec.loopMode | 0;
    w[7] = spec.detune | 0;
    w[8] = spec.chanPtr2 ? spec.chanPtr2 >>> 0 : 0;
    w[9] = spec.chanMode | 0;
    this._x.tw_jam_sample(this._e, vi, note, p);
  }

  jamStop(ph) { this._x.tw_jam_stop(this._e); }
  jamStopVoice(ph, vi) { this._x.tw_jam_stop_voice(this._e, vi); }
  jamKeyOff(ph, vi) { this._x.tw_jam_key_off(this._e, vi); }
  jamRelease(ph, vi) { this._x.tw_jam_release(this._e, vi); }
  /** True while an audition is sounding with the transport stopped. */
  get jamActive() { return this._x.tw_jam_active(this._e) !== 0; }

  // ── the desk ──

  setVoiceMute(ph, vi, muted) { this._x.tw_set_voice_fader(this._e, vi, muted ? 255 : 0); }
  getVoiceMute(ph, vi) { return this._x.tw_get_voice_fader(this._e, vi) === 255; }
  setVoiceFader(ph, vi, fader) { this._x.tw_set_voice_fader(this._e, vi, fader); }
  getVoiceFader(ph, vi) { return this._x.tw_get_voice_fader(this._e, vi); }

  /** Drain the pending interrupt latch (read-to-acknowledge, edge-triggered). */
  pollTrackerInterrupts(ph) { return this._x.tw_poll_interrupts(this._e) >>> 0; }
  interruptArg(ph, n) { return this._x.tw_interrupt_arg(this._e, n); }

  // ── what the page draws from ──

  /**
   * Have the engine write its part of a snapshot — the playhead, every voice's
   * block, the Mixing tab's meter blocks and the envelope playheads — into a
   * buffer of `floats` floats in the module's memory, at the offsets the build
   * took from core/worklet/protocol.js, and return that buffer (valid until
   * the next call into the engine). The host copies what it wants out of it
   * (core/worklet/engine-commands.js); everything else in it is untouched.
   */
  snapshotView(floats) {
    const x = this._x;
    if (!this._snapPtr || this._snapLen < floats) {
      if (this._snapPtr) x.free(this._snapPtr);
      this._snapPtr = x.malloc(floats * 4) >>> 0;
      this._snapLen = floats;
      if (!this._snapPtr) throw new Error("taud engine: out of memory");
    }
    x.tw_fill_snapshot(this._e, this._snapPtr);
    return new Float32Array(x.memory.buffer, this._snapPtr, floats);
  }

  /** A copy of instrument `slot`'s S $Fx invert-loop bit mask (empty = none). */
  getInstrumentInvertMask(slot) { return this._mask(this._x.tw_get_invert_mask, slot); }
  /** …and of notefx 2/3's inversion mask, one bit per sample byte. */
  getInstrumentModMask(slot) { return this._mask(this._x.tw_get_mod_mask, slot); }

  _mask(fn, slot) {
    const cap = 8192;
    const p = this._put(new Uint8Array(cap));
    let n = fn(this._e, slot, p, cap);
    if (n <= 0) return new Uint8Array(0);
    if (n > cap) {
      const q = this._put(new Uint8Array(n));
      n = fn(this._e, slot, q, n);
      return this._u8().slice(q, q + n);
    }
    return this._u8().slice(p, p + n);
  }

  /** The instrument's live sample modification, under the instrument's own
   *  field names (see engine.js getInstrumentSampleMod). */
  getInstrumentSampleMod(slot) {
    const p = this._put(new Uint8Array(25 * 8));
    this._x.tw_get_sample_mod(this._e, slot, p);
    const d = new Float64Array(this._x.memory.buffer, p, 25);
    return {
      modOp: d[0], modInvert: d[1] !== 0, modFrom: d[2], modTo: d[3],
      modCombBits: d[4], modCombOdd: d[5] !== 0,
      modRot: d[6], modSub: d[7], modOn: d[8] !== 0,
      modScatter: d[9], modSeed: d[10], modEpoch: d[11],
      modOpExt: d[12], modF: d[13], modStepIndex: d[14],
      modXor: d[15], modBitRot: d[16],
      modBitPermIdx: d[17], modBitPermOn: d[18] !== 0,
      modExtSwapA: d[19], modExtSwapB: d[20], modExtMirror: d[21] !== 0,
      modFunkWalk: d[22], modFunkPos: d[23], modFunkLen: d[24],
    };
  }

  /** A PSG instrument's live state, or null for any other instrument. */
  getInstrumentPsgState(slot) {
    const p = this._put(new Uint8Array(8 * 4));
    if (!this._x.tw_get_psg_state(this._e, slot, p)) return null;
    const w = new Int32Array(this._x.memory.buffer, p, 8);
    return {
      rtAdvance: [w[0], w[1]],
      rtLevel: [w[2], w[3]],
      rtMute: w[4],
      wave: w[7] ? [w[5], w[6]] : null,
    };
  }

  /** A formant instrument's live state, or null for any other instrument:
   *  { voices: [{own, front, open, round, toFront, toOpen, toRound, nasal,
   *  rhotic, glide, coda}], lyric: [syllable indices] }. */
  getInstrumentFormantState(slot) {
    const VOICES = 8, DOUBLES = 13, LYRIC = TOTAL_VOICES;
    const bytes = VOICES * DOUBLES * 8 + VOICES * 2 * 4 + LYRIC * 4 + 2 * 4;
    const p = this._put(new Uint8Array(bytes));
    const pExtra = p + VOICES * DOUBLES * 8;
    const pLyric = pExtra + VOICES * 2 * 4;
    const pCounts = pLyric + LYRIC * 4;
    if (!this._x.tw_get_formant_state(this._e, slot, p, pExtra, pLyric, LYRIC, pCounts)) return null;
    const buf = this._x.memory.buffer;
    const d = new Float64Array(buf, p, VOICES * DOUBLES);
    const extra = new Int32Array(buf, pExtra, VOICES * 2);
    const counts = new Int32Array(buf, pCounts, 2);
    const voices = [];
    for (let i = 0; i < counts[0]; i++) {
      const o = i * DOUBLES;
      voices.push({
        own: d[o] !== 0,
        front: d[o + 1], open: d[o + 2], round: d[o + 3],
        toFront: d[o + 4], toOpen: d[o + 5], toRound: d[o + 6],
        nasal: d[o + 7] !== 0 ? { v: d[o + 8], to: d[o + 9] } : null,
        rhotic: d[o + 10] !== 0 ? { v: d[o + 11], to: d[o + 12] } : null,
        glide: extra[i * 2],
        coda: extra[i * 2 + 1] !== 0,
      });
    }
    return { voices, lyric: [...new Int32Array(buf, pLyric, counts[1])] };
  }

  getActiveNoteCounts(ph) {
    const p = this._put(new Uint8Array(1024 * 4));
    this._x.tw_get_active_note_counts(this._e, p);
    return new Int32Array(this._x.memory.buffer, p, 1024).slice();
  }

  // ── rendering ──

  /**
   * Mix one TRACKER_CHUNK. Fills `out` with the device's dithered unsigned
   * 8-bit stereo and returns it, or returns null when the song has halted;
   * the float bus is `playheads[0].trackerState.mixLeft` / `mixRight`.
   */
  renderChunk(ph, out = new Uint8Array(TRACKER_CHUNK * 2)) {
    const x = this._x;
    // The engine runs its own meters over the chunk (meters.c), and the
    // census over the codes it delivers.
    if (!x.tw_render_chunk(this._e)) return null;
    x.tw_pcm8(this._e, this._chunkPtr);
    out.set(this._u8().subarray(this._chunkPtr, this._chunkPtr + TRACKER_CHUNK * 2));
    if (this._stemBus !== null) this._feedStems();
    return out;
  }

  /**
   * Stem-export tap: an object with `add(voice, lane, frame, sample)`, or null.
   * While one is set the engine logs every voice's pre-pan mono contribution
   * to each frame of a chunk, and after the chunk they are handed to `add` in
   * the order the mixer made them. `voice` there is not an engine voice but a
   * stand-in carrying what a stem is routed by — displayInst, instrumentId,
   * activePatchIndex — and whatever the tap memoises on it.
   */
  get stemBus() { return this._stemBus; }
  set stemBus(bus) {
    this._stemBus = bus ?? null;
    this._stemVoices = new Map();
    this._x.tw_set_stem_tap(this._e, this._stemBus !== null ? 1 : 0);
  }

  _feedStems() {
    const x = this._x;
    const count = x.tw_stem_count(this._e);
    if (count === 0) return;
    const p = x.tw_stem_log(this._e) >>> 0;
    const buf = x.memory.buffer;
    const ints = new Int32Array(buf, p, count * 8);
    const vals = new Float64Array(buf, p, count * 4);
    const bus = this._stemBus;
    const voices = this._stemVoices;
    for (let i = 0; i < count; i++) {
      const o = i * 8;
      const lane = ints[o + 1], top = ints[o + 2], sub = ints[o + 3], patch = ints[o + 4];
      // One stand-in per (lane, instrument, sub-instrument, patch): what a
      // voice IS, as far as a stem's routing can tell.
      const key = ((lane + 1) * 1025 + top) * 1025 * 256 + sub * 256 + (patch + 1);
      let v = voices.get(key);
      if (v === undefined) {
        v = { displayInst: top, instrumentId: sub, activePatchIndex: patch, stemKey: -1, stemIndex: -1 };
        voices.set(key, v);
      }
      bus.add(v, lane, ints[o], vals[i * 4 + 3]);
    }
  }
}
