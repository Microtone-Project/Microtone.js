// Engine command dispatch + snapshot fill, shared by the AudioWorklet
// (render-mode fallback) and the Tier 2 render Worker. Both host a TaudEngine
// and speak the same audio.*-shaped CMD protocol, so this keeps the mutation
// path in one place (no drift between the two hosts). Bundle-safe (plain export
// forms, unique names) — included in tools/make-worklet-bundle.js.

import { PATTERN_BYTES, PATTERN_BYTES_WIDE } from "../engine/constants.js";
import {
  CMD, SNAP_HEADER_SIZE, SNAP_INTERRUPT_MASK, SNAP_INTERRUPT_ARGS, SNAP_SAB_I32_MASK,
  SNAP_SAB_I32_ARGS, SNAP_AN_METERS, SNAP_AN_FRAMES, SNAP_AN_FIELD, SNAP_AN_CORR_LL,
  SNAP_AN_CORR_RR, SNAP_AN_CORR_LR, SNAP_AN_RING_WRITE, SNAP_METER_BASE, SNAP_METER_STRIDE,
  SNAP_M_PEAK, SNAP_M_TRUE_PEAK, SNAP_M_MEAN_SQUARE, SNAP_M_CLIP, SNAP_SCOPE_BASE, SNAP_MM_FRAMES,
  SNAP_MM_COMP_GR, SNAP_MM_LIM_GR, SNAP_MM_HIST_TOTAL, SNAP_MM_BASE, SNAP_MM_SUM_Z, SNAP_MM_CH,
  SNAP_MM_C_PEAK, SNAP_MM_C_TRUE_PEAK, SNAP_MM_C_MEAN_SQUARE, SNAP_MM_C_CLIP, SNAP_MM_C_STRIDE,
  SNAP_MM_STAGE_STRIDE, SNAP_MM_AP_PEAK, SNAP_MM_AP_SUM_SQ, SNAP_MM_STAGES, SNAP_HIST_BASE,
  SNAP_HIST_BINS, SNAP_MM_SPEC_WRITE, SNAP_SPEC_BASE, SNAP_SPEC_FRAMES, SNAP_PAIR_BASE,
  SNAP_MM_HIST_DEPTH, SNAP_MM_HIST_USED, SNAP_MM_HIST_MIN, SNAP_MM_HIST_MAX, SNAP_MM_HIST_ENTROPY,
  SNAP_IM_BASE, SNAP_FLOATS,
} from "./protocol.js";
import { ANALYSIS_MAX_METERS, makeAnalysisReadout } from "../engine/analysis.js";
import { makeMasterMeterReadout } from "../engine/loudness.js";

/** Reused drain targets — the snapshot path never allocates. */
const analysisReadout = makeAnalysisReadout();
const masterMeterReadout = makeMasterMeterReadout();

/**
 * Apply an engine-mutating command to `eng`. Returns true if handled here.
 * Transport/reply commands (INIT, USE_SAB, USE_AUDIO_SAB, SNAPSHOT_RETURN,
 * QUERY_INVERT_MASK) return false — each host handles those itself.
 */
export function applyAudioCommand(eng, m) {
  switch (m.t) {
    case CMD.UPLOAD_SAMPLE_INST_BLOB: eng.uploadSampleInstBlob(new Uint8Array(m.image)); return true;
    case CMD.UPLOAD_INSTRUMENT: eng.uploadInstrument(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_INSTRUMENT_PATCHES: eng.uploadInstrumentPatches(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.CLEAR_INSTRUMENT_PATCHES: eng.clearInstrumentPatches(m.slot); return true;
    case CMD.UPLOAD_PATTERN: eng.uploadPattern(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_PATTERNS: {
      const blob = new Uint8Array(m.blob);
      // Stride follows the file's cell layout, which SET_CELL_FORMAT installed
      // before the first pattern was ever sent.
      const size = eng.getCellFormat() ? PATTERN_BYTES_WIDE : PATTERN_BYTES;
      for (let i = 0; i < m.slots.length; i++) {
        eng.uploadPattern(m.slots[i], blob.subarray(i * size, (i + 1) * size));
      }
      return true;
    }
    case CMD.CLEAR_PATTERN: eng.clearPattern(m.slot); return true;
    case CMD.UPLOAD_CUE: eng.uploadCue(m.idx, new Uint8Array(m.bytes)); return true;
    case CMD.SET_64CH: eng.set64ChannelMode(m.on); return true;
    case CMD.SET_CELL_FORMAT: eng.setCellFormat(m.wide); return true;
    case CMD.SET_BPM: eng.setBPM(m.ph, m.bpm); return true;
    case CMD.SET_TUNING: eng.setTuning(m.ph, m.baseNote, m.freq); return true;
    case CMD.SET_TICK_RATE: eng.setTickRate(m.ph, m.rate); return true;
    case CMD.SET_SONG_GLOBAL_VOLUME: eng.setSongGlobalVolume(m.ph, m.volume); return true;
    case CMD.SET_SONG_MIXING_VOLUME: eng.setSongMixingVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_VOLUME: eng.setMasterVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_PAN: eng.setMasterPan(m.ph, m.pan); return true;
    case CMD.SET_TRACKER_MIXER_FLAGS: eng.setTrackerMixerFlags(m.ph, m.flags); return true;
    case CMD.SET_SURROUND_MODEL: eng.setSurroundModel(m.ph, m.model); return true;
    case CMD.SET_MONITOR_MODE: eng.setMonitorMode(m.ph, m.mode); return true;
    case CMD.SET_ANALYSIS: eng.setAnalysis(m.ph, m.target); return true;
    case CMD.SET_MASTERING: eng.setMastering(m.ph, m.params); return true;
    case CMD.SET_MASTER_METER:
      eng.setMasterMeter(m.ph, m.on, m.scramble, m.bitDepth, m.histSpan); return true;
    case CMD.SET_IMIX: eng.setImix(m.blocks); return true;
    case CMD.SET_LYRICS: eng.setLyrics(m.entries); return true;
    case CMD.SET_PITCH_EXT: eng.setPitchExt(m.bytes ? new Uint8Array(m.bytes) : null); return true;
    case CMD.SET_IMIX_METER: eng.setImixMeter(m.ph, m.slot, m.seat ?? 0); return true;
    case CMD.PLAY: eng.play(m.ph); return true;
    case CMD.STOP: eng.stop(m.ph); return true;
    case CMD.SET_CUE_POSITION: eng.setCuePosition(m.ph, m.pos); return true;
    case CMD.SET_TRACKER_ROW: eng.setTrackerRow(m.ph, m.row); return true;
    case CMD.CHASE_TRACKER_ROW: eng.chaseTrackerRow(m.ph, m.cue, m.row); return true;
    case CMD.RESET_PARAMS: eng.resetParams(m.ph); return true;
    case CMD.RESET_SAMPLE_FX_STATE: eng.resetSampleFxState(m.ph); return true;
    case CMD.JAM_NOTE: eng.jamNote(m.ph, m.voice, m.note, m.inst, m.audition); return true;
    case CMD.JAM_SAMPLE: eng.jamSample(m.ph, m.voice, m.note, m.spec); return true;
    case CMD.JAM_STOP: eng.jamStop(m.ph); return true;
    case CMD.JAM_STOP_VOICE: eng.jamStopVoice(m.ph, m.voice); return true;
    case CMD.JAM_KEY_OFF: eng.jamKeyOff(m.ph, m.voice); return true;
    case CMD.JAM_RELEASE: eng.jamRelease(m.ph, m.voice); return true;
    case CMD.SET_VOICE_MUTE: eng.setVoiceMute(m.ph, m.voice, m.muted); return true;
    case CMD.SET_VOICE_FADER: eng.setVoiceFader(m.ph, m.voice, m.fader); return true;
    default: return false;
  }
}

/** True for the transport commands that reset the play position (worker mode
 *  must flush the audio ring so no stale buffered tail plays after them). */
export function isTransportReset(t) {
  return t === CMD.PLAY || t === CMD.STOP ||
    t === CMD.SET_CUE_POSITION || t === CMD.SET_TRACKER_ROW ||
    t === CMD.CHASE_TRACKER_ROW || t === CMD.RESET_PARAMS;
}

/** Detached copy of instrument `slot`'s S$Fx invert-loop bit mask (reply payload). */
export function invertMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentInvertMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/** Detached copy of notefx 2/3's inversion mask for `slot` (item 130). */
export function modMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentModMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/**
 * Drain the playhead's interrupt latch into whichever wire this host uses, and
 * with it the argument each Int carried (item 181).
 *
 * `i32` is the shared buffer's Int32 tail on a SAB deploy and null on the
 * postMessage fallback. The two differ in more than storage: the shared cells
 * ACCUMULATE (the main thread drains them on its own clock, so an OR is the
 * only way no fire is lost between two reads), while a posted snapshot is a
 * fresh message the main thread merges itself. Arguments are stored before the
 * mask bit that makes them readable, so a reader that sees the bit sees the
 * word that came with it.
 */
export function drainInterruptsInto(eng, playhead, f, i32 = null) {
  const ts = eng.playheads[playhead].trackerState;
  const mask = ts.drainInterrupts();
  if (i32 !== null) {
    f[SNAP_INTERRUPT_MASK] = 0; // the float slot is the fallback's, not this path's
    if (mask === 0) return;
    for (let n = 0; n < 16; n++) {
      if (mask & (1 << n)) Atomics.store(i32, SNAP_SAB_I32_ARGS + n, ts.interruptArg(n));
    }
    Atomics.or(i32, SNAP_SAB_I32_MASK, mask);
    return;
  }
  f[SNAP_INTERRUPT_MASK] = mask;
  for (let n = 0; n < 16; n++) {
    if (mask & (1 << n)) f[SNAP_INTERRUPT_ARGS + n] = ts.interruptArg(n);
  }
}

/** Write every snapshot field except the interrupt latch into `f`. The
 *  engine writes the playhead, the voice blocks, the Mixing tab's meter blocks
 *  and the envelope playheads itself (snapshot.c, imixtap.c — the offsets are
 *  protocol.js's, through snap_layout.h) into a buffer of its own, and they are
 *  copied from there; the master strip's and the Mastering view's taps are
 *  JavaScript (analysis.js, loudness.js) and drain here. */
export function fillSnapshotInto(eng, playhead, f) {
  const ts = eng.playheads[playhead].trackerState;
  const v = eng.snapshotView(SNAP_FLOATS);
  // A caller's buffer may stop short of the later blocks (a test that only
  // wants the voices): each range is cut to what `f` holds.
  const put = (from, to) => {
    const end = Math.min(to, f.length);
    if (end > from) f.set(v.subarray(from, end), from);
  };
  // The playhead's fields sit either side of the interrupt latch's slot,
  // which is drainInterruptsInto's and must not be written over.
  put(0, SNAP_INTERRUPT_MASK);
  put(SNAP_INTERRUPT_MASK + 1, SNAP_AN_METERS);
  put(SNAP_HEADER_SIZE, SNAP_METER_BASE);
  put(SNAP_IM_BASE, SNAP_FLOATS); // the Mixing-tab seats, then the envelope playheads
  fillAnalysisInto(ts, f);
  fillMasterMeterInto(ts, f);
}

/**
 * Mastering-meter block (item 178). Drains the view's own tap — the K-weighted
 * energy, the allpassed crest's peak and energy, the per-channel
 * peak/true-peak/mean-square/clip figures on BOTH sides of the chain, the
 * chain's gain reduction, and the delivered 8-bit code histogram. With the tap
 * off only the "no frames" marker is written.
 */
function fillMasterMeterInto(ts, f) {
  const tap = ts.masterMeter;
  if (tap === null) {
    f[SNAP_MM_FRAMES] = 0;
    f[SNAP_MM_COMP_GR] = 0;
    f[SNAP_MM_LIM_GR] = 0;
    f[SNAP_MM_HIST_TOTAL] = 0;
    f[SNAP_MM_SPEC_WRITE] = 0;
    f[SNAP_MM_HIST_DEPTH] = 0;
    f[SNAP_MM_HIST_USED] = 0;
    f[SNAP_MM_HIST_MIN] = 0;
    f[SNAP_MM_HIST_MAX] = 0;
    f[SNAP_MM_HIST_ENTROPY] = 0;
    return;
  }
  const r = tap.drain(masterMeterReadout);
  f[SNAP_MM_FRAMES] = r.frames;
  f[SNAP_MM_COMP_GR] = r.compGrDb;
  f[SNAP_MM_LIM_GR] = r.limGrDb;
  for (let s = 0; s < SNAP_MM_STAGES; s++) {
    const o = SNAP_MM_BASE + s * SNAP_MM_STAGE_STRIDE;
    f[o + SNAP_MM_SUM_Z] = r.sumZ[s];
    for (let c = 0; c < 2; c++) {
      const co = o + SNAP_MM_CH + c * SNAP_MM_C_STRIDE;
      const i = s * 2 + c;
      f[co + SNAP_MM_C_PEAK] = r.peak[i];
      f[co + SNAP_MM_C_TRUE_PEAK] = r.truePeak[i];
      f[co + SNAP_MM_C_MEAN_SQUARE] = r.meanSquare[i];
      f[co + SNAP_MM_C_CLIP] = r.clip[i];
    }
    f[o + SNAP_MM_AP_PEAK] = r.apPeak[s];
    f[o + SNAP_MM_AP_SUM_SQ] = r.apSumSq[s];
  }
  // Normalised buckets (see protocol.js): a raw count leaves float32's exact
  // integer range after a few minutes on one code. The FIGURES come from the
  // full-resolution census the tap kept, not from these.
  const bits = r.bits;
  const total = bits.total;
  f[SNAP_MM_HIST_TOTAL] = total;
  f[SNAP_MM_HIST_DEPTH] = r.bitDepth;
  f[SNAP_MM_HIST_USED] = bits.used;
  f[SNAP_MM_HIST_MIN] = bits.minCode;
  f[SNAP_MM_HIST_MAX] = bits.maxCode;
  f[SNAP_MM_HIST_ENTROPY] = bits.entropyBits;
  const inv = total > 0 ? 1 / total : 0;
  for (let i = 0; i < SNAP_HIST_BINS; i++) f[SNAP_HIST_BASE + i] = r.buckets[i] * inv;
  f[SNAP_MM_SPEC_WRITE] = r.specWrite;
  for (let s = 0; s < SNAP_MM_STAGES; s++) {
    f.set(r.spec[s], SNAP_SPEC_BASE + s * SNAP_SPEC_FRAMES);
    f.set(r.pair[s], SNAP_PAIR_BASE + s * 2 * SNAP_SPEC_FRAMES);
  }
}

/**
 * Master-strip block (item 98). Drains the analysis tap — meters, correlation
 * sums, field energy and the B-format scope ring — into the snapshot. With the
 * tap off, only the "no meters" marker is written; the ring keeps whatever it
 * last held, which nothing reads.
 */
function fillAnalysisInto(ts, f) {
  const tap = ts.analysis;
  if (tap === null) {
    f[SNAP_AN_METERS] = 0;
    f[SNAP_AN_FRAMES] = 0;
    f[SNAP_AN_FIELD] = 0;
    f[SNAP_AN_CORR_LL] = 0;
    f[SNAP_AN_CORR_RR] = 0;
    f[SNAP_AN_CORR_LR] = 0;
    return;
  }
  const r = tap.drain(analysisReadout);
  f[SNAP_AN_METERS] = r.meterCount;
  f[SNAP_AN_FRAMES] = r.frames;
  f[SNAP_AN_FIELD] = r.fieldEnergy;
  f[SNAP_AN_CORR_LL] = r.corrLL;
  f[SNAP_AN_CORR_RR] = r.corrRR;
  f[SNAP_AN_CORR_LR] = r.corrLR;
  f[SNAP_AN_RING_WRITE] = r.ringWrite;
  for (let c = 0; c < ANALYSIS_MAX_METERS; c++) {
    const o = SNAP_METER_BASE + c * SNAP_METER_STRIDE;
    const live = c < r.meterCount;
    f[o + SNAP_M_PEAK] = live ? r.peak[c] : 0;
    f[o + SNAP_M_TRUE_PEAK] = live ? r.truePeak[c] : 0;
    f[o + SNAP_M_MEAN_SQUARE] = live ? r.meanSquare[c] : 0;
    f[o + SNAP_M_CLIP] = live ? r.clip[c] : 0;
  }
  f.set(tap.ring, SNAP_SCOPE_BASE);
}
