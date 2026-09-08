// Engine command dispatch + snapshot fill, shared by the AudioWorklet
// (render-mode fallback) and the Tier 2 render Worker. Both host a TaudEngine
// and speak the same audio.*-shaped CMD protocol, so this keeps the mutation
// path in one place (no drift between the two hosts). Bundle-safe (plain export
// forms, unique names) — included in tools/make-worklet-bundle.js.

import { PATTERN_BYTES, PATTERN_BYTES_WIDE } from "../engine/constants.js";
import {
  CMD,
  SNAP_CUE_POS, SNAP_ROW_INDEX, SNAP_TICK_IN_ROW, SNAP_BPM, SNAP_TICK_RATE,
  SNAP_FLAGS, SNAP_CHANNEL_COUNT, SNAP_HEADER_SIZE,
  SNAP_V_ACTIVE, SNAP_V_EFF_VOL, SNAP_V_EFF_PAN, SNAP_V_NOTE, SNAP_V_INST,
  SNAP_V_SAMPLE_POS, SNAP_V_SAMPLE_PTR, SNAP_V_SAMPLE_LEN,
  SNAP_V_ENV_VOL_IDX, SNAP_V_ENV_VOL_TIME, SNAP_V_ENV_PAN_IDX, SNAP_V_ENV_PAN_TIME,
  SNAP_V_ENV_PITCH_IDX, SNAP_V_ENV_PITCH_TIME, SNAP_V_ENV_FILTER_IDX, SNAP_V_ENV_FILTER_TIME,
  SNAP_V_AZIMUTH, SNAP_V_ELEVATION,
  SNAP_VOICE_STRIDE, SNAP_MAX_VOICES, SNAP_GLOBAL_VOLUME,
  SNAP_V_FUNK_WINDOW, SNAP_V_FUNK_POS, SNAP_V_FUNK_LEN, SNAP_V_FUNK_MODE,
  SNAP_V_MOD_FUNK_WINDOW,
  SNAP_AN_METERS, SNAP_AN_FRAMES, SNAP_AN_FIELD,
  SNAP_AN_CORR_LL, SNAP_AN_CORR_RR, SNAP_AN_CORR_LR, SNAP_AN_RING_WRITE,
  SNAP_METER_BASE, SNAP_METER_STRIDE,
  SNAP_M_PEAK, SNAP_M_TRUE_PEAK, SNAP_M_MEAN_SQUARE, SNAP_M_CLIP,
  SNAP_SCOPE_BASE,
} from "./protocol.js";
import {
  SURROUND_STEREO, foldAzimuthToPan, displayPanByte, displayAngles,
} from "../engine/spatial.js";
import { ANALYSIS_MAX_METERS, makeAnalysisReadout } from "../engine/analysis.js";

/** Reused drain target — the snapshot path never allocates. */
const analysisReadout = makeAnalysisReadout();
/** …and the scratch [azimuth, elevation] the position readout writes into. */
const angleBox = new Float64Array(2);

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
    case CMD.PLAY: eng.play(m.ph); return true;
    case CMD.STOP: eng.stop(m.ph); return true;
    case CMD.SET_CUE_POSITION: eng.setCuePosition(m.ph, m.pos); return true;
    case CMD.SET_TRACKER_ROW: eng.setTrackerRow(m.ph, m.row); return true;
    case CMD.RESET_PARAMS: eng.resetParams(m.ph); return true;
    case CMD.RESET_SAMPLE_FX_STATE: eng.resetSampleFxState(m.ph); return true;
    case CMD.JAM_NOTE: eng.jamNote(m.ph, m.voice, m.note, m.inst, m.audition); return true;
    case CMD.JAM_SAMPLE: eng.jamSample(m.ph, m.voice, m.note, m.spec); return true;
    case CMD.JAM_STOP: eng.jamStop(m.ph); return true;
    case CMD.JAM_STOP_VOICE: eng.jamStopVoice(m.ph, m.voice); return true;
    case CMD.SET_VOICE_MUTE: eng.setVoiceMute(m.ph, m.voice, m.muted); return true;
    case CMD.SET_VOICE_FADER: eng.setVoiceFader(m.ph, m.voice, m.fader); return true;
    default: return false;
  }
}

/** True for the transport commands that reset the play position (worker mode
 *  must flush the audio ring so no stale buffered tail plays after them). */
export function isTransportReset(t) {
  return t === CMD.PLAY || t === CMD.STOP ||
    t === CMD.SET_CUE_POSITION || t === CMD.SET_TRACKER_ROW || t === CMD.RESET_PARAMS;
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

/** Write every snapshot field except the interrupt latch into `f`. */
export function fillSnapshotInto(eng, playhead, f) {
  const ph = eng.playheads[playhead];
  const ts = ph.trackerState;
  f[SNAP_CUE_POS] = ts.cuePos;
  f[SNAP_ROW_INDEX] = ts.rowIndex;
  f[SNAP_TICK_IN_ROW] = ts.tickInRow;
  f[SNAP_BPM] = ph.bpm;
  f[SNAP_TICK_RATE] = ph.tickRate;
  f[SNAP_FLAGS] = (ph.isPlaying ? 1 : 0) | (ph.jamActive ? 2 : 0);
  f[SNAP_CHANNEL_COUNT] = eng.channelCount();
  f[SNAP_GLOBAL_VOLUME] = ph.globalVolume;
  for (let vi = 0; vi < SNAP_MAX_VOICES; vi++) {
    const v = ts.voices[vi];
    const o = SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE;
    const active = v.active;
    f[o + SNAP_V_ACTIVE] = active ? 1 : 0;
    if (active) {
      const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
      const faderGain = (255 - v.fader) / 255.0;
      let ev = effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain;
      f[o + SNAP_V_EFF_VOL] = ev < 0 ? 0 : ev > 1 ? 1 : ev;
      // Where the channel SOUNDS — the same sum the mixer pans by (pan swing
      // included, item 155), and for a metainstrument the mix-weighted mean of
      // its layers rather than layer 0's own position (item 155.1).
      f[o + SNAP_V_EFF_PAN] = displayPanByte(ts, vi, v);
      // Spatial position (#998). EFF_PAN above stays the stereo meters' 0..255
      // value — in a surround song that is where the monitor downmix puts the
      // voice, which is what those meters are drawing.
      if (ts.surroundModel !== SURROUND_STEREO) {
        displayAngles(ts, vi, v, angleBox);
        f[o + SNAP_V_EFF_PAN] = Math.round(foldAzimuthToPan(angleBox[0]));
        f[o + SNAP_V_AZIMUTH] = angleBox[0];
        f[o + SNAP_V_ELEVATION] = angleBox[1];
      } else {
        f[o + SNAP_V_AZIMUTH] = f[o + SNAP_V_EFF_PAN];
        f[o + SNAP_V_ELEVATION] = 0;
      }
      f[o + SNAP_V_NOTE] = (v.renderPitch > 0 ? v.renderPitch : v.noteVal) & 0xffff;
      // Show the pattern-level instrument (a meta's slot), not the resolved
      // layer child; fall back to instrumentId before the first meta/plain trigger.
      f[o + SNAP_V_INST] = (v.displayInst || v.instrumentId) & 0x3ff;
      f[o + SNAP_V_SAMPLE_POS] = v.samplePos;
      f[o + SNAP_V_SAMPLE_PTR] = v.activeSamplePtr;
      f[o + SNAP_V_SAMPLE_LEN] = v.activeSampleLength;
      f[o + SNAP_V_ENV_VOL_IDX] = v.envIndex;
      f[o + SNAP_V_ENV_VOL_TIME] = v.envTimeSec;
      f[o + SNAP_V_ENV_PAN_IDX] = v.envPanIndex;
      f[o + SNAP_V_ENV_PAN_TIME] = v.envPanTimeSec;
      f[o + SNAP_V_ENV_PITCH_IDX] = v.envPitchIndex;
      f[o + SNAP_V_ENV_PITCH_TIME] = v.envPitchTimeSec;
      f[o + SNAP_V_ENV_FILTER_IDX] = v.envFilterIndex;
      f[o + SNAP_V_ENV_FILTER_TIME] = v.envFilterTimeSec;
      f[o + SNAP_V_FUNK_WINDOW] = v.funkWindow;
      f[o + SNAP_V_FUNK_POS] = v.funkPos;
      f[o + SNAP_V_FUNK_LEN] = v.activeSampleLoopEnd - v.activeSampleLoopStart;
      f[o + SNAP_V_FUNK_MODE] = v.funkMode;
      f[o + SNAP_V_MOD_FUNK_WINDOW] = v.modFunkWindow;
    } else {
      for (let k = 1; k < SNAP_VOICE_STRIDE; k++) f[o + k] = 0;
      f[o + SNAP_V_EFF_PAN] = 128;
      f[o + SNAP_V_AZIMUTH] = 128; // centre/front, matching EFF_PAN's rest value
      f[o + SNAP_V_SAMPLE_POS] = -1;
      f[o + SNAP_V_SAMPLE_PTR] = -1;
      f[o + SNAP_V_ENV_VOL_IDX] = -1;
      f[o + SNAP_V_ENV_PAN_IDX] = -1;
      f[o + SNAP_V_ENV_PITCH_IDX] = -1;
      f[o + SNAP_V_ENV_FILTER_IDX] = -1;
      f[o + SNAP_V_FUNK_WINDOW] = -1;
      f[o + SNAP_V_FUNK_POS] = -1;
      f[o + SNAP_V_MOD_FUNK_WINDOW] = -1;
    }
  }
  fillAnalysisInto(ts, f);
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
