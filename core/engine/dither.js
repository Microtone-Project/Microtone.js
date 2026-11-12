// The two quantisers a float mix is delivered through.
//
// pcm32fToPcm8 is the DEVICE's: the noise-shaped 8-bit dither the Taud adapter
// plays through (and a GRITTY WAV export is written with). It is here rather
// than in the mixer so that what only needs the dither — the WAV encoder, the
// player library — does not carry a mixer along; the C engine has its twin
// (te_dither_u8).
//
// ditherS16 is the 16-bit quantiser a CLEAN stereo WAV export writes.
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

const ditherFround = Math.fround;

/** urand: (xorshift32() & 0xFFFFFF) / 16777216 — exact in Float32. */
function urand(eng) {
  return (eng.xorshift32() & 0xffffff) / 16777216.0;
}

/** TPDF noise in [-1, +1) — difference of two urands, exact in Float32. */
function tpdf1(eng) {
  return urand(eng) - urand(eng);
}

/**
 * Noise-shaped dither 32f → interleaved U8, writing into out (length ≥ 2·sampleCount).
 * State: eng.ditherError = Float32Array(4) [L0, L1, R0, R1].
 */
export function pcm32fToPcm8(eng, fleft, fright, sampleCount, out) {
  const b1 = 1.5;
  const b2 = -0.75;
  const scale = 127.5;
  const bias = 128;
  const ditherScale = 0.2; // ditherFround(0.2) applied at the multiply below
  const err = eng.ditherError;

  for (let i = 0; i < sampleCount; i++) {
    // --- LEFT channel ---
    const feedbackL = ditherFround(ditherFround(b1 * err[0]) + ditherFround(b2 * err[1]));
    const ditherL = ditherFround(ditherFround(ditherScale) * tpdf1(eng));
    let shapedL = ditherFround(ditherFround(fleft[i] + feedbackL) + ditherFround(ditherL / scale));
    shapedL = shapedL < -1.0 ? -1.0 : shapedL > 1.0 ? 1.0 : shapedL;

    let qL = Math.round(ditherFround(shapedL * scale));
    qL = qL < -128 ? -128 : qL > 127 ? 127 : qL;
    out[i * 2] = (qL + bias) & 0xff;

    const qerrL = ditherFround(shapedL - ditherFround(qL / scale));
    err[1] = err[0];
    err[0] = qerrL;

    // --- RIGHT channel ---
    const feedbackR = ditherFround(ditherFround(b1 * err[2]) + ditherFround(b2 * err[3]));
    const ditherR = ditherFround(ditherFround(ditherScale) * tpdf1(eng));
    let shapedR = ditherFround(ditherFround(fright[i] + feedbackR) + ditherFround(ditherR / scale));
    shapedR = shapedR < -1.0 ? -1.0 : shapedR > 1.0 ? 1.0 : shapedR;

    let qR = Math.round(ditherFround(shapedR * scale));
    qR = qR < -128 ? -128 : qR > 127 ? 127 : qR;
    out[i * 2 + 1] = (qR + bias) & 0xff;

    const qerrR = ditherFround(shapedR - ditherFround(qR / scale));
    err[3] = err[2];
    err[2] = qerrR;
  }
}
