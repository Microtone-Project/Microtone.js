// Engine command dispatch + snapshot fill, shared by the AudioWorklet
// (render-mode fallback) and the Tier 2 render Worker. Both host a TaudEngine
// and speak the same audio.*-shaped CMD protocol, so this keeps the mutation
// path in one place (no drift between the two hosts). Bundle-safe (plain export
// forms, unique names) — included in tools/make-worklet-bundle.js.

import { PATTERN_BYTES, PATTERN_BYTES_WIDE } from "../engine/constants.js";
import {
  CMD, SNAP_HEADER_SIZE, SNAP_INTERRUPT_MASK, SNAP_INTERRUPT_ARGS, SNAP_SAB_I32_MASK,
  SNAP_SAB_I32_ARGS, SNAP_METER_BASE, SNAP_MM_BASE, SNAP_IM_BASE, SNAP_FLOATS,
} from "./protocol.js";

/**
 * Apply an engine-mutating command to `eng`. Returns true if handled here.
 * Transport/reply commands (INIT, USE_SAB, USE_AUDIO_SAB, USE_AUDIO_PORT,
 * SNAPSHOT_RETURN, QUERY_INVERT_MASK) return false — each host handles those
 * itself.
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
 *  engine writes them all (snapshot.c, imixtap.c, meters.c — the offsets are
 *  protocol.js's, through snap_layout.h) into a buffer of its own, draining
 *  the meters as it goes, and they are copied from there. A meter that is
 *  off leaves its block in `f` as it was: only its "off" marker moves. */
export function fillSnapshotInto(eng, playhead, f) {
  const ts = eng.playheads[playhead].trackerState;
  const v = eng.snapshotView(SNAP_FLOATS);
  // A caller's buffer may stop short of the later blocks (a test that only
  // wants the voices): each range is cut to what `f` holds.
  const put = (from, to) => {
    const end = Math.min(to, f.length);
    if (end > from) f.set(v.subarray(from, end), from);
  };
  // The playhead's fields and the meters' sit either side of the interrupt
  // latch's slot, which is drainInterruptsInto's and must not be written over.
  put(0, SNAP_INTERRUPT_MASK);
  put(SNAP_INTERRUPT_MASK + 1, SNAP_INTERRUPT_ARGS);
  put(SNAP_HEADER_SIZE, SNAP_METER_BASE);
  if (ts.analysis !== null) put(SNAP_METER_BASE, SNAP_MM_BASE);  // the strip's meters and scope ring
  if (ts.masterMeter !== null) put(SNAP_MM_BASE, SNAP_IM_BASE);   // the Mastering view's figures and rings
  put(SNAP_IM_BASE, SNAP_FLOATS); // the Mixing-tab seats, then the envelope playheads
}
