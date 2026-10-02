// SharedArrayBuffer audio ring for Tier 2 (off-audio-thread rendering).
//
// A render Worker (producer) fills engine-rate float L/R frames; the AudioWorklet
// (consumer) reads them with a fractional resample cursor and copies to output.
// Single-producer / single-consumer, so the two absolute frame counters
// (AR_WRITE by the worker, AR_READ by the worklet) need only be published with
// Atomics.store / read with Atomics.load — no locks. AR_EPOCH is bumped by the
// worker on a transport reset (play / seek / stop) so the worklet drops the
// stale buffered tail instead of playing ~one ring of old audio. AR_DOORBELL
// is not about the audio at all: it is the main thread's "you have mail" to
// the worker, and it lives here only because this is the SAB both of them hold.
//
// This module is imported by BOTH the module worker and the AudioWorklet, so it
// must stay bundle-safe (plain export forms, unique top-level names) — it goes
// into tools/make-worklet-bundle.js for the non-module-worklet fallback.

export const AR_FRAMES = 8192;            // ring capacity in frames (power of two) — 171 ms @ 48 kHz
export const AR_MASK = AR_FRAMES - 1;
export const AR_CTRL_LEN = 6;             // Int32 control slots
export const AR_WRITE = 0;                // absolute frames produced (worker → worklet), Int32-wrapping
export const AR_READ = 1;                 // absolute frames consumed (worklet → worker), Int32-wrapping
export const AR_STATE = 2;                // bit0: producer active (playing/jam) — informational
export const AR_EPOCH = 3;                // transport-reset generation (worker bumps; worklet re-syncs)
export const AR_FLUSH_POS = 4;            // write frame at the last flush — the worklet jumps its read cursor here,
                                          //   dropping the stale tail (counters stay monotonic; no reset race)
export const AR_DOORBELL = 5;             // messages the main thread has posted to the worker, bumped (+ notify)
                                          //   AFTER each postMessage — the worker's clock sleeps on it (render.worker.js)
// Target ring occupancy the worker keeps buffered. 1024 frames ≈ 21 ms @ 48 kHz
// = the jam-latency / cursor-lead / underrun-safety knob (user-chosen balanced).
export const AR_HIGH_WATER = 1024;
export const AR_SAB_BYTES = AR_CTRL_LEN * 4 + AR_FRAMES * 4 * 2;

/** Map Int32 control + Float32 L/R views over an audio-ring SharedArrayBuffer. */
export function audioRingViews(sab) {
  const ctrl = new Int32Array(sab, 0, AR_CTRL_LEN);
  const floatBase = AR_CTRL_LEN * 4;
  const L = new Float32Array(sab, floatBase, AR_FRAMES);
  const R = new Float32Array(sab, floatBase + AR_FRAMES * 4, AR_FRAMES);
  return { ctrl, L, R };
}
