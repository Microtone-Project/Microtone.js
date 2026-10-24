// The 16-bit quantiser a CLEAN stereo WAV export writes (the gritty export is
// the device's own noise-shaped 8-bit dither, pcm32fToPcm8 in mixer.js).
//
// Plain TPDF dither of one LSB peak, no noise shaping, off its own xorshift32
// stream at the adapter's seed — so an export is the same file every time, and
// the master meter's 16-bit bit-usage census (loudness.js), which runs the
// same stream over the same bus from the start of an offline analysis, counts
// exactly the codes the file holds.
//
// Not part of the device: nothing the engine plays goes through here, which is
// why it owes TSVM nothing. libtaudplay carries the same arithmetic
// (taud_encode_wav), operand order included.

import { makeXorshift32 } from "./rng.js";

/** A fresh dither stream — the generator ditherS16 draws from. */
export function makeDither16() {
  return makeXorshift32();
}

/**
 * One float sample (nominal ±1) → a signed 16-bit code: clamp, scale by 32767
 * (the undithered writer's scale), add a triangular −1…+1 LSB, round. Two draws
 * per sample, the first one positive.
 */
export function ditherS16(next, x) {
  const v = x < -1 ? -1 : x > 1 ? 1 : x;
  const a = next() & 0xffffff;
  const b = next() & 0xffffff;
  const q = Math.round(v * 32767 + (a - b) / 16777216);
  return q < -32768 ? -32768 : q > 32767 ? 32767 : q;
}
