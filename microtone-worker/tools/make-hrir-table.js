#!/usr/bin/env node
// Compile the GoogleVR/SADIE spherical-harmonic HRIR set into the table the
// engine's binaural monitor reads (item 128): core/engine/c/src/hrir_sadie.c.
//
//   node tools/make-hrir-table.js [path/to/sh_hrir_order_3.wav]
//
// Source: Omnitone's pristine copy of the GoogleVR resource
// (/home/torvald/Documents/omnitone/src/resources/sh_hrir_order_3.wav), a
// 16-channel 48 kHz 16-bit WAV, 256 frames. Channel k IS ambisonic channel k in
// ACN order — the left ear's response to it, SN3D-normalised (binaural.c says
// how the set is decoded; vendor/VENDOR-VERSIONS.md has the licence).
//
// Output is COMMITTED; the engine never parses a WAV at run time. The samples
// are stored CHANNEL-MAJOR as int16 — the layout the convolver reads. After a
// change, rebuild the module (node tools/make-engine-wasm.js);
// test/node/binaural.test.js checks the module's table against the WAV.

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

const md5 = createHash("md5").update(wav).digest("hex");
const rows = [];
for (let i = 0; i < flat.length / 2; i += 16) {
  const vals = [];
  for (let k = i; k < Math.min(i + 16, flat.length / 2); k++) vals.push(flat.readInt16LE(k * 2));
  rows.push(`  ${vals.join(", ")},`);
}
const out = `/* GENERATED FILE — do not edit. Rebuild with: node tools/make-hrir-table.js
 *
 * GoogleVR / SADIE spherical-harmonic HRIR set, order ${order} (${channels} ambisonic
 * channels), ${length} taps at ${fmt.rate} Hz, as taken from Google Omnitone
 * (src/resources/sh_hrir_order_${order}.wav, md5 ${md5}). Channel k is the LEFT
 * ear's impulse response for ambisonic channel k in ACN order, SN3D normalised;
 * stored channel-major as int16 (value / 32768 = tap).
 *
 * Copyright (c) 2017 Google Inc. and (c) 2017 University of York, licensed
 * under the Apache License 2.0. The measurements are the SADIE project's
 * Google/VR binaural filter set:
 * https://www.york.ac.uk/sadie-project/GoogleVRSADIE.html
 */

#include "taud_internal.h"

const int16_t HRIR_SADIE[${channels} * ${length}] = {
${rows.join("\n")}
};
`;

writeFileSync(root + "../core/engine/c/src/hrir_sadie.c", out);
console.log(`wrote core/engine/c/src/hrir_sadie.c (${out.length} bytes) from ${src}`);
console.log(`  order ${order}, ${channels} channels × ${length} taps @ ${fmt.rate} Hz, md5 ${md5}`);
