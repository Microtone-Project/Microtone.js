// taudplay wire protocol — main thread ⇄ AudioWorklet.
//
// Deliberately tiny next to Microtone's own (src/worklet/protocol.js): that one
// carries everything an EDITOR wants to see — per-voice envelope cursors, sample
// read positions, funk windows, the master analysis field, loudness histograms,
// spectra. A player wants none of it. What is left is the transport, and two
// numbers per voice: how loud it is and where it sits.
//
// Snapshots travel by postMessage on a recycled pair of ArrayBuffers (~16 ms).
// There is no SharedArrayBuffer path and no render-worker tier: 848 bytes every
// 16 ms is 53 kB/s of structured clone, which is not worth a COOP/COEP deploy
// requirement to avoid. Dropping both is most of why this file is short.

/** Commands the main thread sends to the worklet. */
export const CMD = {
  LOAD: "load",            // {doc, songIndex} — parsed .taud, worklet keeps it
  SELECT_SONG: "song",     // {songIndex} — re-upload from the retained doc
  PLAY: "play",            // {}
  STOP: "stop",            // {}
  SEEK_CUE: "seekCue",     // {cue}
  SET_VOLUME: "volume",    // {volume} 0..255 master
  SET_MONITOR: "monitor",  // {mode} 0 = fold, 1 = binaural (surround songs)
  SET_FADER: "fader",      // {voice, value, samples} — value 0..255, ramped over `samples`
  SNAPSHOT_RETURN: "snapRet", // {buffer} — hand a snapshot buffer back for reuse
};

/** Messages the worklet sends back. */
export const MSG = {
  READY: "ready",
  SNAPSHOT: "snapshot",
  LOADED: "loaded",  // {songIndex, channelCount} — the upload finished
};

// ── snapshot layout (Float32Array) ──
export const SNAP_PLAYING = 0;       // 0 | 1
export const SNAP_CUE = 1;
export const SNAP_ROW = 2;
export const SNAP_BPM = 3;
export const SNAP_TICK_RATE = 4;
export const SNAP_CHANNELS = 5;      // 32 or 64
export const SNAP_SONG_INDEX = 6;
export const SNAP_HEADER = 8;        // voice block starts here (padded to 8)

/** Per-voice block: the two probes plus the gate that says whether to believe
 *  them. `active` is not a third probe — it is what tells a meter to fall to
 *  zero rather than hold the last note's level. */
export const SNAP_V_ACTIVE = 0;
export const SNAP_V_VOLUME = 1;      // 0..1
export const SNAP_V_PAN = 2;         // 0..1, 0.5 = centre
export const SNAP_V_STRIDE = 3;

/** Voices reported. 64 is the format's maximum channel count; the jam bank
 *  above it does not exist here, because this library cannot jam. */
export const SNAP_VOICES = 64;
export const SNAP_FLOATS = SNAP_HEADER + SNAP_VOICES * SNAP_V_STRIDE;
