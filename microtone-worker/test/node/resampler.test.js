// item 111: the Kaiser-windowed-sinc resampler that replaced the linear
// interpolation on every rate-converting output path (playback at a context
// rate other than the engine's, the WAV/stem/surround exports).
//
// The point of the change is inaudibility, so the assertions are the two
// numbers that decide it: how much of the signal survives unaltered (SNR in the
// pass-band) and how much of what CANNOT survive a downsample is thrown away
// instead of folding back into the audible band (alias rejection). Both are
// measured against the linear interpolator this replaced, computed right here,
// so the comparison can't drift out of date.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESAMP_PHASES, resampHalfWidth, kaiserSincRows, kaiserKernel,
  resampleInterleaved, StreamResampler,
} from "../../core/audio/resampler.js";

const AMP = 0.5;
const db = (x) => 20 * Math.log10(x);

function tone(freq, rate, frames, amp = AMP) {
  const b = new Float32Array(frames);
  for (let i = 0; i < frames; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return b;
}

/** RMS over [from, to), skipping the edges where the kernel hangs off the buffer. */
function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
}

/** The interpolator this replaced, kept as the yardstick. */
function linearResample(f32, srcRate, dstRate) {
  const srcFrames = f32.length;
  const dstFrames = Math.floor((srcFrames * dstRate) / srcRate);
  const out = new Float32Array(dstFrames);
  const step = srcRate / dstRate;
  for (let n = 0; n < dstFrames; n++) {
    const pos = n * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    out[n] = f32[i0] * (1 - frac) + f32[Math.min(i0 + 1, srcFrames - 1)] * frac;
  }
  return out;
}

/** SNR against the ideal tone at the OUTPUT rate, in dB. */
function toneSnrDb(got, freq, rate, guard = 2000) {
  const err = new Float32Array(got.length);
  for (let i = 0; i < got.length; i++) err[i] = got[i] - AMP * Math.sin((2 * Math.PI * freq * i) / rate);
  return db(AMP / Math.SQRT2 / rms(err, guard, got.length - guard));
}

test("every phase row is DC-normalised, so a constant survives the conversion", () => {
  for (const ratio of [1.0, 44100 / 48000, 32000 / 48000, 1.5]) {
    const halfWidth = resampHalfWidth(ratio);
    const rows = kaiserSincRows(0.5 * Math.min(1, ratio), halfWidth);
    // phases + 1: the last row is the frac = 1.0 endpoint the read loops
    // interpolate towards, not a phase of its own.
    assert.equal(rows.length, RESAMP_PHASES + 1);
    for (const row of rows) {
      assert.equal(row.length, 2 * halfWidth);
      let s = 0;
      for (const w of row) s += w;
      assert.ok(Math.abs(s - 1) < 1e-12, `row sums to ${s} at ratio ${ratio}`);
    }
  }
  const dc = new Float32Array(2000).fill(0.37);
  const out = resampleInterleaved(dc, 1, 48000, 44100);
  for (let i = 100; i < out.length - 100; i++) {
    assert.ok(Math.abs(out[i] - 0.37) < 1e-6, `DC drifted to ${out[i]} at ${i}`);
  }
});

test("an unchanged rate is a pass-through, not a filter", () => {
  const buf = tone(1000, 48000, 256);
  assert.equal(resampleInterleaved(buf, 1, 48000, 48000), buf);

  const r = new StreamResampler(2, 32000, 32000);
  const input = Float32Array.from([1, -1, 0.5, -0.5, 0.25, -0.25]);
  const out = new Float32Array(r.maxOut(3) * 2);
  assert.equal(r.process(input, 3, out), 3);
  assert.deepEqual([...out.subarray(0, 6)], [...input]);
});

test("the output length is ⌊frames · dst/src⌋, whatever the channel count", () => {
  for (const ch of [1, 2, 6]) {
    const src = new Float32Array(4800 * ch);
    const out = resampleInterleaved(src, ch, 48000, 44100);
    assert.equal(out.length / ch, Math.floor((4800 * 44100) / 48000));
  }
});

test("a tone comes back a tone: ≥80 dB SNR, where linear managed 16 dB at 10 kHz", () => {
  for (const freq of [1000, 5000, 10000]) {
    const src = tone(freq, 48000, 48000);
    const sinc = toneSnrDb(resampleInterleaved(src, 1, 48000, 44100), freq, 44100);
    const lin = toneSnrDb(linearResample(src, 48000, 44100), freq, 44100);
    assert.ok(sinc > 80, `${freq} Hz: only ${sinc.toFixed(1)} dB SNR`);
    assert.ok(sinc - lin > 25, `${freq} Hz: only ${(sinc - lin).toFixed(1)} dB better than linear`);
  }
});

test("the pass-band is flat: nothing audible is coloured on the way out", () => {
  for (const freq of [100, 1000, 10000, 15000]) {
    const src = tone(freq, 48000, 48000);
    const out = resampleInterleaved(src, 1, 48000, 44100);
    const gain = db(rms(out, 3000, out.length - 3000) / (AMP / Math.SQRT2));
    assert.ok(Math.abs(gain) < 0.1, `${freq} Hz landed at ${gain.toFixed(3)} dB`);
  }
});

test("a downsample throws away what will not fit instead of folding it back", () => {
  // 48 → 32 kHz: everything above 16 kHz has nowhere to go. Linear interpolation
  // does not filter at all, so a 20 kHz tone comes back at nearly full level —
  // as a 12 kHz whistle sitting on top of the music.
  for (const freq of [20000, 23000]) {
    const src = tone(freq, 48000, 48000);
    const sinc = resampleInterleaved(src, 1, 48000, 32000);
    const lin = linearResample(src, 48000, 32000);
    const sincDb = db(rms(sinc, 2000, sinc.length - 2000) / (AMP / Math.SQRT2));
    const linDb = db(rms(lin, 2000, lin.length - 2000) / (AMP / Math.SQRT2));
    assert.ok(sincDb < -60, `${freq} Hz survived at ${sincDb.toFixed(1)} dB`);
    assert.ok(linDb > -10, `sanity: linear should barely touch it (${linDb.toFixed(1)} dB)`);
  }
});

test("the streaming resampler tracks the whole-buffer one sample for sample", () => {
  // Same kernel, same phases — feeding it in blocks may only change WHEN a
  // frame comes out, never what it is.
  const src = tone(3000, 48000, 8192);
  const oneShot = resampleInterleaved(src, 1, 48000, 44100);

  const r = new StreamResampler(1, 48000, 44100);
  const block = 512;
  const out = new Float32Array(r.maxOut(block));
  const got = [];
  for (let off = 0; off + block <= src.length; off += block) {
    const n = r.process(src.subarray(off, off + block), block, out);
    for (let i = 0; i < n; i++) got.push(out[i]);
  }
  const tail = r.flush(out);
  for (let i = 0; i < tail; i++) got.push(out[i]);

  assert.ok(Math.abs(got.length - oneShot.length) <= 2,
    `${got.length} streamed frames vs ${oneShot.length} in one shot`);
  // Interiors only: the one-shot clamps its edge taps to the first/last frame,
  // the stream zero-pads them — the two disagree about what lies outside the
  // signal, and nothing else. Inside, frames are bit-identical EXCEPT where a
  // read position lands exactly on an input frame: the accumulated phase gets
  // there as "frac = 1 of the previous frame" and the multiplied one as
  // "frac = 0 of this frame", which are the same kernel shifted by one tap and
  // so differ by the two window END taps — ~-100 dB, and only there.
  const halfWidth = kaiserKernel(48000, 44100).halfWidth;
  let worst = 0;
  for (let i = halfWidth; i < oneShot.length - halfWidth; i++) {
    worst = Math.max(worst, Math.abs(got[i] - oneShot[i]));
  }
  assert.ok(worst < 5e-5, `streamed and one-shot diverge by ${db(worst / AMP).toFixed(1)} dB`);
});

test("the stream's look-ahead tail is drained, not dropped", () => {
  const r = new StreamResampler(1, 48000, 44100);
  const out = new Float32Array(r.maxOut(512));
  const held = r.process(new Float32Array(512).fill(0.5), 512, out);
  const drained = r.flush(out);
  assert.ok(drained > 0, "flush() must emit the frames the kernel held back");
  // Within a frame or two of the whole-buffer count — the padding buys a couple
  // of extra positions on the way down to silence.
  const want = Math.floor((512 * 44100) / 48000);
  assert.ok(Math.abs(held + drained - want) <= 2, `${held} + ${drained} vs ${want}`);
});
