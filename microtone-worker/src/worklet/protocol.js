// Message protocol shared by the AudioWorklet processor and the main thread.
// The master-strip block's geometry comes from the analysis tap itself, so the
// wire layout cannot drift from what fills it.
//
// Commands (main → worklet) are plain {t, ...} messages, deliberately
// isomorphic to the TSVM `audio.*` calls taut.js makes; bulk payloads ride as
// transferred ArrayBuffers. Snapshots (worklet → main) are recycled
// Float32Array buffers with the fixed layout below.

import { ANALYSIS_MAX_METERS, SCOPE_FRAMES, SCOPE_CHANNELS } from "../engine/analysis.js";
import { SPEC_FRAMES, TAP_STAGES, HIST_BUCKETS } from "../engine/loudness.js";
import { TOTAL_VOICES } from "../engine/constants.js";

export const CMD = Object.freeze({
  INIT: "init",
  UPLOAD_SAMPLE_INST_BLOB: "uploadSampleInstBlob", // {image: ArrayBuffer} (decompressed)
  UPLOAD_INSTRUMENT: "uploadInstrument",           // {slot, bytes: ArrayBuffer}
  UPLOAD_INSTRUMENT_PATCHES: "uploadInstrumentPatches", // {slot, bytes: ArrayBuffer}
  CLEAR_INSTRUMENT_PATCHES: "clearInstrumentPatches",   // {slot}
  UPLOAD_PATTERN: "uploadPattern",                 // {slot, bytes: ArrayBuffer}
  UPLOAD_PATTERNS: "uploadPatterns",               // {slots: int[], blob: ArrayBuffer} (bulk, 512 B each)
  CLEAR_PATTERN: "clearPattern",                   // {slot} — blank a stale pattern slot (item 174)
  UPLOAD_CUE: "uploadCue",                         // {idx, bytes: ArrayBuffer}
  SET_64CH: "set64ChannelMode",                    // {on}
  SET_CELL_FORMAT: "setCellFormat",                // {wide} — format v3's 16-byte cell
  SET_BPM: "setBPM",                               // {ph, bpm}
  SET_TICK_RATE: "setTickRate",                    // {ph, rate}
  SET_TUNING: "setTuning",                         // {ph, baseNote, freq} — song tuning (item 77)
  SET_SONG_GLOBAL_VOLUME: "setSongGlobalVolume",   // {ph, volume}
  SET_SONG_MIXING_VOLUME: "setSongMixingVolume",   // {ph, volume}
  SET_MASTER_VOLUME: "setMasterVolume",            // {ph, volume}
  SET_MASTER_PAN: "setMasterPan",                  // {ph, pan}
  SET_TRACKER_MIXER_FLAGS: "setTrackerMixerFlags", // {ph, flags}
  SET_SURROUND_MODEL: "setSurroundModel",          // {ph, model} — #998 song flag
  SET_MONITOR_MODE: "setMonitorMode",              // {ph, mode} — #998.3 fold / binaural
  SET_ANALYSIS: "setAnalysis",                     // {ph, target} — item 98 master-strip tap
  SET_MASTERING: "setMastering",                   // {ph, params} — item 178, the song's sMst chain
  SET_MASTER_METER: "setMasterMeter",              // {ph, on} — item 178 Mastering-view tap
  PLAY: "play",                                    // {ph}
  STOP: "stop",                                    // {ph}
  SET_CUE_POSITION: "setCuePosition",              // {ph, pos}
  SET_TRACKER_ROW: "setTrackerRow",                // {ph, row}
  RESET_PARAMS: "resetParams",                     // {ph}
  RESET_SAMPLE_FX_STATE: "resetSampleFxState",     // {ph} — invert masks, funk windows, notefx 2/3
  JAM_NOTE: "jamNote",                             // {ph, voice, note, inst}
  JAM_SAMPLE: "jamSample",                         // {ph, voice, note, spec} — raw pooled-sample preview
  JAM_STOP: "jamStop",                             // {ph} — every voice (panic)
  JAM_STOP_VOICE: "jamStopVoice",                  // {ph, voice} — one audition voice; voice < 0 = the whole jam bank
  SET_VOICE_MUTE: "setVoiceMute",                  // {ph, voice, muted}
  SET_VOICE_FADER: "setVoiceFader",                // {ph, voice, fader}
  QUERY_INVERT_MASK: "queryInvertMask",            // {slot} → MSG.INVERT_MASK
  SNAPSHOT_RETURN: "snapshotReturn",               // {buffer: ArrayBuffer} (recycle)
  USE_SAB: "useSab",                               // {sab: SharedArrayBuffer} — switch to shared-memory snapshots
  USE_AUDIO_SAB: "useAudioSab",                    // {sab: SharedArrayBuffer} — Tier 2 audio ring (worklet consumes; worker produces)
});

export const MSG = Object.freeze({
  SNAPSHOT: "snapshot", // {buffer: ArrayBuffer} — Float32Array, layout below
  // {slot, mask: ArrayBuffer, mod} — S $F0xx / notefx 2 invert-loop bit mask, plus
  // the instrument's notefx 2/3 region geometry (engine getInstrumentSampleMod).
  INVERT_MASK: "invertMask",
  READY: "ready",
  PROFILE: "profile",   // {cpuFrac, renderFrac, ...} — dev profiler, ~1/s (opt-in)
});

// ── Snapshot layout (Float32Array; integers are exact in f32 up to 2^24) ──
export const SNAP_CUE_POS = 0;
export const SNAP_ROW_INDEX = 1;
export const SNAP_TICK_IN_ROW = 2;
export const SNAP_BPM = 3;
export const SNAP_TICK_RATE = 4;
export const SNAP_FLAGS = 5;          // bit0 isPlaying, bit1 jamActive
export const SNAP_INTERRUPT_MASK = 6; // drained latch (edge-triggered)
export const SNAP_CHANNEL_COUNT = 7;
// Song global volume (0..255). Effects V and W move it DURING playback, which
// is what the master fader follows (item 98).
export const SNAP_GLOBAL_VOLUME = 8;
// ── Master-strip analysis (item 98) ──
// All of these are zero while the tap is off. The meter/correlation figures are
// sums over SNAP_AN_FRAMES samples — one snapshot interval — and the UI owns
// the ballistics.
export const SNAP_AN_METERS = 9;      // metered channel count (0 = tap off)
export const SNAP_AN_FRAMES = 10;     // samples integrated since the last snapshot
export const SNAP_AN_FIELD = 11;      // Σ (W²+X²+Y²+Z²)/2 — acoustic energy density
export const SNAP_AN_CORR_LL = 12;    // Σ L², Σ R², Σ L·R of the stereo (decode)
export const SNAP_AN_CORR_RR = 13;
export const SNAP_AN_CORR_LR = 14;
export const SNAP_AN_RING_WRITE = 15; // next frame index in the scope ring
// ── Mastering meter (item 178) ──
// Zero while the Mastering view's own tap is off. Gain reduction is the peak
// over the interval, in dB and never positive; the histogram total is what the
// normalised bins below are fractions of.
export const SNAP_MM_FRAMES = 16;     // samples integrated since the last snapshot (0 = tap off)
export const SNAP_MM_COMP_GR = 17;    // compressor gain reduction, dB (≤ 0)
export const SNAP_MM_LIM_GR = 18;     // limiter gain reduction, dB (≤ 0)
export const SNAP_MM_HIST_TOTAL = 19; // samples binned into the histogram so far
export const SNAP_MM_SPEC_WRITE = 20; // next frame index in the spectrum rings
// Bit usage, computed by the engine over the FULL code census (65536 entries at
// 16 bits) — an exact `used` and `span` cannot be recovered from the 256
// buckets the wire carries, so the figures travel beside the picture.
export const SNAP_MM_HIST_DEPTH = 21;   // bits per sample the census was taken at
export const SNAP_MM_HIST_USED = 22;    // codes that occur at all
export const SNAP_MM_HIST_MIN = 23;     // lowest and highest code seen
export const SNAP_MM_HIST_MAX = 24;
export const SNAP_MM_HIST_ENTROPY = 25; // Shannon entropy of the distribution, bits
export const SNAP_HEADER_SIZE = 26;

// Per-voice block, stride SNAP_VOICE_STRIDE, SNAP_MAX_VOICES blocks.
export const SNAP_V_ACTIVE = 0;
export const SNAP_V_EFF_VOL = 1;      // 0..1 (getVoiceEffectiveVolume)
export const SNAP_V_EFF_PAN = 2;      // 0..255 (getVoiceEffectivePan)
export const SNAP_V_NOTE = 3;      // per-tick sounding pitch (renderPitch; follows slides/arp/vibrato)
export const SNAP_V_INST = 4;
export const SNAP_V_SAMPLE_POS = 5;
export const SNAP_V_SAMPLE_PTR = 6;
export const SNAP_V_SAMPLE_LEN = 7;
export const SNAP_V_ENV_VOL_IDX = 8;
export const SNAP_V_ENV_VOL_TIME = 9;
export const SNAP_V_ENV_PAN_IDX = 10;
export const SNAP_V_ENV_PAN_TIME = 11;
export const SNAP_V_ENV_PITCH_IDX = 12;
export const SNAP_V_ENV_PITCH_TIME = 13;
export const SNAP_V_ENV_FILTER_IDX = 14;
export const SNAP_V_ENV_FILTER_TIME = 15;
export const SNAP_V_AZIMUTH = 16;     // #998: 512-unit angle (0 left, 128 front, CLOCKWISE)
export const SNAP_V_ELEVATION = 17;   // #998: signed, 128 units = 90° (always 0 in a stereo song)
// Funk repeat (item 161), for the Samples view's window overlay: where the
// voice's loop actually IS (-1 = the sample's own), where the walk will put it
// at the next restart (-1 = it has not stepped), and how wide the window is —
// the voice's ACTIVE loop length, which an Ixmp patch can change under it, so
// the overlay cannot get the width from the document and be right (item 116).
export const SNAP_V_FUNK_WINDOW = 18;
export const SNAP_V_FUNK_POS = 19;
export const SNAP_V_FUNK_LEN = 20;
// …and which walk is hopping it (item 163's `$f`): the overlay names the
// command it is drawing, and the hop's SIZE is the loop length shifted right by
// the low two bits, so a half- or eighth-block walk is stepped through at the
// spacing it really uses instead of the loop length.
export const SNAP_V_FUNK_MODE = 21;
// Extended `2`/`3 $sexy : $fuuk`'s own funk repeat (`$xuu` 102/12x, item 173
// follow-up): a SEPARATE window from Z's above — the two "do not share state"
// (TAUD_NOTE_EFFECTS.md) and can be live on one voice at once. Only the
// voice's own latched restart point needs a snapshot slot; the walk's
// pending target and window WIDTH are the instrument's (inst.modFunkPos/
// modFunkLen), already carried by the invert-mask query reply
// (engine.js getInstrumentSampleMod) the Samples view already polls.
export const SNAP_V_MOD_FUNK_WINDOW = 22;
export const SNAP_VOICE_STRIDE = 23;

// Every PHYSICAL voice, so the jam bank (item 140) is visible to the views that
// follow a sounding audition — the Instruments/Samples editors scan the block
// looking for the voice their preview landed on, and it no longer lands on a
// song channel.
export const SNAP_MAX_VOICES = TOTAL_VOICES;

// ── Master-strip blocks (item 98), after the voice array ──
// Per metered channel: peak, true peak (4× oversampled), mean square over the
// interval, and the number of samples that hit full scale.
export const SNAP_METER_BASE = SNAP_HEADER_SIZE + SNAP_MAX_VOICES * SNAP_VOICE_STRIDE;
export const SNAP_M_PEAK = 0;
export const SNAP_M_TRUE_PEAK = 1;
export const SNAP_M_MEAN_SQUARE = 2;
export const SNAP_M_CLIP = 3;
export const SNAP_METER_STRIDE = 4;

// The vectorscope ring: SCOPE_FRAMES frames of first-order B-format, frame
// interleaved (W, Y, Z, X), written continuously and read backwards from
// SNAP_AN_RING_WRITE. See src/engine/analysis.js for why the scopes are always
// B-format whatever the metering target is.
export const SNAP_SCOPE_BASE = SNAP_METER_BASE + ANALYSIS_MAX_METERS * SNAP_METER_STRIDE;

// ── Mastering meter blocks (item 178), after the scope ring ──
// Two stages — pre-chain then post-chain — each carrying the K-weighted energy
// the loudness figures are built from and, per channel, the same four numbers
// the strip's meters use. Measuring BOTH sides every chunk is what makes the
// view's pre/post toggle instant and its two readings describe one moment.
export const SNAP_MM_BASE = SNAP_SCOPE_BASE + SCOPE_FRAMES * SCOPE_CHANNELS;
export const SNAP_MM_SUM_Z = 0;        // Σ (K-weighted L² + K-weighted R²)
export const SNAP_MM_CH = 1;           // …then 2 channels of:
export const SNAP_MM_C_PEAK = 0;
export const SNAP_MM_C_TRUE_PEAK = 1;
export const SNAP_MM_C_MEAN_SQUARE = 2;
export const SNAP_MM_C_CLIP = 3;
export const SNAP_MM_C_STRIDE = 4;
export const SNAP_MM_STAGE_STRIDE = SNAP_MM_CH + 2 * SNAP_MM_C_STRIDE;
export const SNAP_MM_STAGES = 2;

// Delivered 8-bit code histogram (item 178.4's "bit usage"). Shipped NORMALISED
// — each bin is its share of SNAP_MM_HIST_TOTAL — because a raw count passes
// 2^24 after about six minutes on one bin and stops being exact in a float32.
export const SNAP_HIST_BASE = SNAP_MM_BASE + SNAP_MM_STAGES * SNAP_MM_STAGE_STRIDE;
export const SNAP_HIST_BINS = HIST_BUCKETS;

// Two mono rings — the mix going into the chain and the master coming out —
// for the Mastering view's live spectrometer. Written continuously and read
// backwards from SNAP_MM_SPEC_WRITE, exactly like the scope ring above. 16 KiB
// on the wire, and only while that view is on screen.
export const SNAP_SPEC_BASE = SNAP_HIST_BASE + SNAP_HIST_BINS;
export const SNAP_SPEC_FRAMES = SPEC_FRAMES;
export const SNAP_SPEC_STAGES = TAP_STAGES;

export const SNAP_FLOATS = SNAP_SPEC_BASE + SNAP_SPEC_STAGES * SNAP_SPEC_FRAMES;

// SAB fast path (crossOriginIsolated deploys): one shared buffer holding the
// float snapshot region plus a trailing Int32 interrupt-latch cell that the
// worklet ORs into (Atomics.or) and the main thread drains
// (Atomics.exchange 0). The float SNAP_INTERRUPT_MASK slot is only used by
// the postMessage fallback.
export const SNAP_SAB_BYTES = SNAP_FLOATS * 4 + 4;
