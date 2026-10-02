#!/usr/bin/env node
// Compile the GoogleVR/SADIE spherical-harmonic HRIR set into the engine data
// module the binaural monitor reads (item 128).
//
//   node tools/make-hrir-table.js [path/to/sh_hrir_order_3.wav]
//
// Source: Omnitone's pristine copy of the GoogleVR resource
// (/home/torvald/Documents/omnitone/src/resources/sh_hrir_order_3.wav), a
// 16-channel 48 kHz 16-bit WAV, 256 frames. Channel k IS ambisonic channel k in
// ACN order — see core/engine/hrir-sadie.js for what the numbers mean and
// vendor/VENDOR-VERSIONS.md for the licence.
//
// Output is COMMITTED (core/engine/hrir-sadie.js); the engine never parses a WAV
// at run time. The samples are stored CHANNEL-MAJOR, as int16 little-endian,
// base64'd — the layout the convolver wants, so decoding is a straight copy.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = process.argv[2] ?? "/home/torvald/Documents/omnitone/src/resources/sh_hrir_order_3.wav";

const wav = readFileSync(src);
if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
  throw new Error(`${src}: not a RIFF/WAVE file`);
}

let fmt = null;
let data = null;
for (let off = 12; off + 8 <= wav.length;) {
  const id = wav.toString("ascii", off, off + 4);
  const size = wav.readUInt32LE(off + 4);
  if (id === "fmt ") {
    fmt = {
      format: wav.readUInt16LE(off + 8),
      channels: wav.readUInt16LE(off + 10),
      rate: wav.readUInt32LE(off + 12),
      bits: wav.readUInt16LE(off + 22),
    };
  } else if (id === "data") {
    data = wav.subarray(off + 8, off + 8 + size);
  }
  off += 8 + size + (size & 1);
}
if (fmt === null || data === null) throw new Error(`${src}: missing fmt/data chunk`);
if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${src}: want 16-bit PCM, got ${JSON.stringify(fmt)}`);

const channels = fmt.channels;
const order = Math.round(Math.sqrt(channels)) - 1;
if ((order + 1) * (order + 1) !== channels) {
  throw new Error(`${src}: ${channels} channels is not a complete ambisonic set`);
}
const length = data.length / (channels * 2);
if (!Number.isInteger(length)) throw new Error(`${src}: ragged data chunk`);

// Interleaved → channel-major, still int16 LE.
const flat = Buffer.alloc(data.length);
for (let c = 0; c < channels; c++) {
  for (let n = 0; n < length; n++) {
    flat.writeInt16LE(data.readInt16LE((n * channels + c) * 2), (c * length + n) * 2);
  }
}

const b64 = flat.toString("base64");
const ROW = 96;
const rows = [];
for (let i = 0; i < b64.length; i += ROW) rows.push(`  "${b64.slice(i, i + ROW)}",`);

const md5 = createHash("md5").update(wav).digest("hex");
const out = `// GENERATED FILE — do not edit. Rebuild with: node tools/make-hrir-table.js
//
// GoogleVR / SADIE spherical-harmonic HRIR set, order ${order} (${channels} ambisonic
// channels), ${length} taps at ${fmt.rate} Hz, as taken from Google Omnitone
// (src/resources/sh_hrir_order_${order}.wav, md5 ${md5}).
//
// Copyright (c) 2017 Google Inc. and (c) 2017 University of York, licensed
// under the Apache License 2.0 — see vendor/VENDOR-VERSIONS.md. The
// measurements are the SADIE project's Google/VR binaural filter set:
// https://www.york.ac.uk/sadie-project/GoogleVRSADIE.html
//
// ── What these numbers ARE ──
// Channel k is the LEFT ear's impulse response for ambisonic channel k in ACN
// order, SN3D normalised. Decoding an ambisonic scene to headphones is then one
// convolution per channel and a sum — no per-source filtering, no head model to
// tune — and the right ear comes free: mirroring a listener left↔right flips the
// sign of every harmonic with m < 0 and leaves the rest alone, so
// L = Σ_{m≥0} + Σ_{m<0} and R = Σ_{m≥0} − Σ_{m<0}. The set already carries the
// max-rE weighting Google baked in, which is why the decoder applies no shelf,
// no near-field compensation and no gain of its own beyond one calibration
// scalar (see binaural.js).
//
// Stored channel-major as int16 little-endian, base64'd: the layout the
// convolver reads, so decodeShHrir() is a scale and a copy.

/** Ambisonic order the set decodes, and the channel count that implies. */
export const HRIR_ORDER = ${order};
export const HRIR_CHANNELS = ${channels};
/** Taps per channel, and the rate they were measured at. */
export const HRIR_LENGTH = ${length};
export const HRIR_RATE = ${fmt.rate};

const HRIR_BASE64 = [
${rows.join("\n")}
].join("");

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 → bytes. Hand-rolled because \`atob\` is a window/worker global that
 * AudioWorkletGlobalScope does not carry, and this module runs there.
 */
function b64Bytes(s) {
  const lut = new Int32Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) lut[B64_ALPHABET.charCodeAt(i)] = i;
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // '='
  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | lut[s.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * The set as one channel-major Float64Array of HRIR_CHANNELS × HRIR_LENGTH,
 * scaled to ±1. Built once per call — binaural.js caches the rate-converted
 * table it derives from this.
 */
export function decodeShHrir() {
  const bytes = b64Bytes(HRIR_BASE64);
  const out = new Float64Array(HRIR_CHANNELS * HRIR_LENGTH);
  for (let i = 0; i < out.length; i++) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768.0;
  }
  return out;
}
`;

writeFileSync(root + "core/engine/hrir-sadie.js", out);
console.log(`wrote core/engine/hrir-sadie.js (${out.length} bytes) from ${src}`);
console.log(`  order ${order}, ${channels} channels × ${length} taps @ ${fmt.rate} Hz, md5 ${md5}`);
