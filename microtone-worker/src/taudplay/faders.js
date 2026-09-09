// The library's one group of knobs: a ramped fader per voice.
//
// The engine's `Voice.fader` is a plain 0..255 attenuation byte read straight
// into the gain — no smoothing anywhere, because in the tracker it only ever
// changes when a human clicks mute. A game moving it every animation frame
// would step the gain 60 times a second, and on a sustained note that steps
// audibly. So the ramp lives here, above the engine: the caller says "voice 4
// to a third over two seconds" once, and the bank walks the byte there in
// whatever increments the render is already using.
//
// Shared by both hosts (the worklet and the offline renderer) so a fade sounds
// the same whether it is played or written to a file.

import { MAX_VOICES } from "../engine/constants.js";

export class FaderBank {
  constructor() {
    this.now = new Float64Array(MAX_VOICES);    // current attenuation, 0..255
    this.target = new Float64Array(MAX_VOICES);
    this.step = new Float64Array(MAX_VOICES);   // per frame
    this.remain = new Float64Array(MAX_VOICES); // frames left in the ramp
    this.dirty = true;                          // something to write out
  }

  /** Aim voice `v` at attenuation `value` (0 = open, 255 = silent) over
   *  `samples` frames. `samples <= 0` snaps. */
  set(v, value, samples) {
    if (v < 0 || v >= MAX_VOICES) return;
    const target = value < 0 ? 0 : value > 255 ? 255 : value;
    this.target[v] = target;
    if (samples <= 0) {
      this.now[v] = target;
      this.remain[v] = 0;
      this.step[v] = 0;
    } else {
      this.step[v] = (target - this.now[v]) / samples;
      this.remain[v] = samples;
    }
    this.dirty = true;
  }

  /** Step every live ramp by `frames`. */
  advance(frames) {
    for (let v = 0; v < MAX_VOICES; v++) {
      const left = this.remain[v];
      if (left <= 0) continue;
      if (left <= frames) {
        this.now[v] = this.target[v];
        this.remain[v] = 0;
      } else {
        this.now[v] += this.step[v] * frames;
        this.remain[v] = left - frames;
      }
      this.dirty = true;
    }
  }

  /**
   * Push the bytes into a TrackerState's voices.
   *
   * Not through `TaudEngine.setVoiceFader`, which clamps the voice index to
   * NUM_VOICES-1 (32) because the TSVM delegate clamps its readbacks there. A
   * fader is a host control rather than a device readback, and a 64-channel
   * song has 64 channels to fade, so the byte goes to the voice directly.
   */
  writeInto(ts) {
    if (!this.dirty) return;
    this.dirty = false;
    for (let v = 0; v < MAX_VOICES; v++) {
      const b = Math.round(this.now[v]) & 255;
      if (ts.voices[v].fader !== b) ts.voices[v].fader = b;
    }
  }
}

/** Gain (1 = as written, 0 = silent) → the engine's attenuation byte. */
export function gainToFader(gain) {
  const g = gain < 0 ? 0 : gain > 1 ? 1 : gain;
  return Math.round((1 - g) * 255);
}

/** …and back. A gain read out is the byte-quantised one — 256 steps over the
 *  range, which is the resolution the mix actually has. */
export function faderToGain(fader) {
  return (255 - fader) / 255;
}
