// The song's WRITTEN level (item 373): how loud the song itself asks to be
// right now — the global volume (V, W) × the loudest sounding lane's note
// volume (the volume column, D, K, L, Q) × its lane volume (M, N), 0…1. It is
// what a composer's fade-out moves, and nothing else: envelopes, instrument
// volumes, the host's faders and the listener's volume are left out on
// purpose, so a note decaying into a rest, or a listener turning the sound
// down, is not a fade. −1 while no lane sounds at all (a rest says nothing
// about how loud the song is).
//
// The Microtone Player's radio reads it off taudplay's snapshot, and the
// Music Hub's catalogue walk off its own engine — the same function, so the
// two agree on which songs fade out (src/player/radio.js).

/** `engine`: a TaudEngine (core/engine/engine.js — the one with views). */
export function writtenLevel(engine) {
  const ph = engine.playheads[0];
  const voices = ph.trackerState.voices;
  const lanes = engine.channelCount();
  let loudest = -1;
  for (let vi = 0; vi < lanes; vi++) {
    const v = voices[vi];
    if (v.active && v.currentMixVolume > loudest) loudest = v.currentMixVolume;
  }
  if (loudest < 0) return -1;
  return (ph.globalVolume / 255) * Math.min(1, loudest);
}
