// Shared "blinkenlight" ballistics (user request) — every play-indicator lamp
// in the app (the Instruments/Samples tabs' row dot, the instrument lookup's
// own lit number) reads brightness the same way:
//
//   * driven by each voice's CONTROL volume (audio.getVoiceEffectiveVolume —
//     the same number the Timeline lane header's own VU bar already
//     shows), never a measured/audible level;
//   * several simultaneous voices lighting the same row (one instrument
//     played as a chord, or several instruments sharing one sample) combine
//     as a probabilistic OR, not a sum that could blow past full brightness;
//   * a fast attack and a slow decay, so it snaps on with the note but fades
//     like an afterglow rather than switching off — the same ballistics
//     shape a VU meter's needle uses, just asymmetric the other way (a meter
//     falls fast and holds its peak; a lamp lights fast and lingers).

import { slewTowards } from "./views/masterstrip.js";

/** Exponential time constants (ms), not linear rates — frame-rate
 *  independent, and a value already near its target never overshoots. Reuses
 *  the master strip's own slewTowards (analysis.test.js already exercises
 *  its maths) rather than a second copy of the same exponential-approach
 *  formula. */
export const LAMP_ATTACK_MS = 5;
export const LAMP_DECAY_MS = 50;

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Probabilistic OR of independent brightnesses: 1 - ∏(1 - v). N voices at
 *  the same level climb toward full brightness without ever exceeding it,
 *  and a second quiet voice visibly brightens an already-lit lamp less than
 *  a lone one would. An empty list is silence (0). */
export function combineBrightness(volumes) {
  let dark = 1;
  for (const v of volumes) dark *= 1 - clamp01(v);
  return 1 - dark;
}

// Guarded rather than called at module load: lamp.js's math is plain enough
// to unit-test from Node (test/node/lamp.test.js), which has no `matchMedia`.
const REDUCED_MOTION = typeof matchMedia === "function"
  ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

/** One lamp's smoothed brightness (0..1). Call `update` once a frame with the
 *  instantaneous target and the frame's dt in ms. */
export class Lamp {
  constructor() { this.value = 0; }

  update(target, dtMs) {
    target = clamp01(target);
    if (REDUCED_MOTION.matches) { this.value = target; return this.value; }
    const tau = target > this.value ? LAMP_ATTACK_MS : LAMP_DECAY_MS;
    this.value = slewTowards(this.value, target, dtMs, tau);
    if (Math.abs(this.value - target) < 0.002) this.value = target; // settle exactly, no eternal creep
    return this.value;
  }
}

/**
 * Every active voice's effective volume, bucketed by `keyOf(voiceIndex)`
 * (an instrument slot, a sample pointer, …) and collapsed per bucket through
 * combineBrightness — the per-row target a Lamp then slews toward. `keyOf`
 * returning null/undefined excludes that voice.
 */
export function liveBrightnessByKey(audio, totalVoices, keyOf) {
  const volumesByKey = new Map();
  for (let vi = 0; vi < totalVoices; vi++) {
    if (!audio.getVoiceActive(vi)) continue;
    const key = keyOf(vi);
    if (key == null) continue;
    let list = volumesByKey.get(key);
    if (!list) volumesByKey.set(key, list = []);
    list.push(audio.getVoiceEffectiveVolume(vi));
  }
  const brightnessByKey = new Map();
  for (const [key, vols] of volumesByKey) brightnessByKey.set(key, combineBrightness(vols));
  return brightnessByKey;
}
