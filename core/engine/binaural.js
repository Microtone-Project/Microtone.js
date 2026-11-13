// Binaural monitoring (#998.3, rebuilt for item 128) — the render target that
// makes a surround song AUDIBLE on headphones while you compose it.
//
// Playback normally folds the rear semicircle onto the front and collapses
// elevation toward the centre (the stereo DOWNMIX). The binaural monitor
// instead treats the object bus as an ambisonic scene (SN3D/ACN, the AmbiX
// export's basis) and decodes it to two ears through the GoogleVR/SADIE
// spherical-harmonic HRIR set — one convolution per channel, summed, the right
// ear free by the m < 0 sign flip. The renderer is the engine's
// (core/engine/c/src/binaural.c, the set in hrir_sadie.c, written by
// tools/make-hrir-table.js); the engine spec's "Binaural monitoring" describes it. What the page needs
// is only the device setting that switches it on.

/** Monitor modes (a device setting on the playhead, not a song property):
 *  the fold onto the stereo pan law, the default, or the head. */
export const MONITOR_FOLD = 0;
export const MONITOR_BINAURAL = 1;
