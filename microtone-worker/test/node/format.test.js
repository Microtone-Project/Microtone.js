import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseTaud, v1CueToWords, cueInstructionWords } from "../../src/format/taud-parse.js";
import { writeTaud } from "../../src/format/taud-write.js";
import { SAMPLEINST_SIZE, CUE_EMPTY } from "../../src/format/taud-const.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const corpusFiles = (await readdir(corpusDir)).filter((f) => f.endsWith(".taud")).sort();

function eqBytes(a, b, label) {
  assert.equal(a.length, b.length, `${label}: length ${a.length} vs ${b.length}`);
  assert.ok(Buffer.from(a.buffer, a.byteOffset, a.length)
    .equals(Buffer.from(b.buffer, b.byteOffset, b.length)), `${label}: bytes differ`);
}

/** Cue count after trailing-empty trimming (a cue is empty when every lane
 *  word is CUE_EMPTY); mirrors taud-write / finalize_cue_sheet. Keeps ≥ 1. */
function trimmedCueCount(cues) {
  let last = 0;
  for (let c = 0; c < cues.length; c++) {
    if (!cues[c].every((w) => w === CUE_EMPTY)) last = c;
  }
  return last + 1;
}

for (const name of corpusFiles) {
  test(`parse ${name}`, async () => {
    const doc = parseTaud(await readFile(corpusDir + name));
    assert.equal(doc.kind, "taud");
    assert.ok(doc.fmtVer === 1 || doc.fmtVer === 2, `fmtVer ${doc.fmtVer}`);
    assert.equal(doc.sampleInstImage.length, SAMPLEINST_SIZE);
    assert.ok(doc.songs.length >= 1);
    for (const song of doc.songs) {
      assert.ok(song.patterns.length >= 1);
      assert.ok(song.cues.length >= 1);
      assert.ok(song.bpm >= 25 && song.bpm <= 535, `bpm ${song.bpm}`);
      assert.ok(song.tickRate >= 1 && song.tickRate <= 127, `tickRate ${song.tickRate}`);
      // every cue lane word: pattern number in range or empty sentinel
      for (const words of song.cues) {
        for (let ch = 0; ch < 64; ch++) {
          const pat = words[ch] & 0x7fff;
          assert.ok(pat <= 0x7fff);
        }
      }
    }
  });

  test(`round-trip ${name}`, async () => {
    const doc = parseTaud(await readFile(corpusDir + name));
    const doc2 = parseTaud(writeTaud(doc));

    assert.equal(doc2.kind, doc.kind);
    assert.equal(doc2.is64Channel, doc.is64Channel);
    assert.equal(doc2.fmtVer, 2); // always saved as v2
    eqBytes(doc2.sampleInstImage, doc.sampleInstImage, "sampleInstImage");

    assert.equal(doc2.songs.length, doc.songs.length);
    for (let s = 0; s < doc.songs.length; s++) {
      const a = doc.songs[s], b = doc2.songs[s];
      for (const k of ["numVoices", "bpm", "tickRate", "tuningBaseNote",
                       "globalFlags", "globalVolume", "mixingVolume"]) {
        assert.equal(b[k], a[k], `song${s}.${k}`);
      }
      assert.ok(Math.abs(b.tuningFreq - a.tuningFreq) < 1e-3, `song${s}.tuningFreq`);
      assert.equal(b.patterns.length, a.patterns.length, `song${s}.numPats`);
      for (let p = 0; p < a.patterns.length; p++) eqBytes(b.patterns[p], a.patterns[p], `song${s}.pat${p}`);
      // The writer trims TRAILING empty cues (taud.mjs captureTrackerDataToFile /
      // taud_common.finalize_cue_sheet), so the round-trip keeps every non-empty
      // cue verbatim and drops only the empty tail (which never affects playback).
      const kept = trimmedCueCount(a.cues);
      assert.equal(b.cues.length, kept, `song${s}.numCues (trimmed)`);
      for (let c = 0; c < kept; c++) {
        assert.deepEqual(Array.from(b.cues[c]), Array.from(a.cues[c]), `song${s}.cue${c}`);
      }
      for (let c = kept; c < a.cues.length; c++) {
        assert.ok(a.cues[c].every((w) => w === 0x7fff), `song${s}.cue${c} dropped tail was empty`);
      }
    }

    assert.equal(doc2.projSections.length, doc.projSections.length);
    for (let i = 0; i < doc.projSections.length; i++) {
      assert.equal(doc2.projSections[i].fourcc, doc.projSections[i].fourcc);
      eqBytes(doc2.projSections[i].payload, doc.projSections[i].payload,
        `projSection ${doc.projSections[i].fourcc}`);
    }

    assert.equal(doc2.ixmp.length, doc.ixmp.length);
    for (let i = 0; i < doc.ixmp.length; i++) {
      assert.equal(doc2.ixmp[i].instId, doc.ixmp[i].instId);
      assert.equal(doc2.ixmp[i].count, doc.ixmp[i].count);
      eqBytes(doc2.ixmp[i].blob, doc.ixmp[i].blob, `ixmp inst ${doc.ixmp[i].instId}`);
    }
  });
}

test("v1 cue translation (synthetic)", () => {
  // Build a v1 cue: 20 voices as 12-bit nibble planes. Voice 0 → pattern 0x123,
  // voice 1 → 0x456, voice 5 → 0x00F, others empty (0xFFF).
  // Nibble packing (taud.mjs:130-135): byte bi=ch>>1; even ch = HIGH nibble.
  const b = new Uint8Array(32).fill(0xff);
  const setPat = (buf, ch, p12) => {
    const bi = ch >> 1;
    const put = (base, nib) => {
      if (ch & 1) buf[base + bi] = (buf[base + bi] & 0xf0) | nib;
      else buf[base + bi] = (buf[base + bi] & 0x0f) | (nib << 4);
    };
    put(0, p12 & 0xf);          // lo plane
    put(10, (p12 >> 4) & 0xf);  // mid plane
    put(20, (p12 >> 8) & 0xf);  // hi plane
  };
  setPat(b, 0, 0x123);
  setPat(b, 1, 0x456);
  setPat(b, 5, 0x00f);
  // instruction word: bytes 30 (hi) / 31 (lo): set bits 0 and 9
  const word0 = 0b0000_0010_0000_0001;
  b[30] = word0 >> 8;
  b[31] = word0 & 0xff;

  const words = v1CueToWords(b, 0);
  assert.equal(words[0] & 0x7fff, 0x123);
  assert.equal(words[1] & 0x7fff, 0x456);
  assert.equal(words[5] & 0x7fff, 0x00f);
  assert.equal(words[2] & 0x7fff, CUE_EMPTY);
  assert.equal(words[19] & 0x7fff, CUE_EMPTY); // v1 empty voice
  assert.equal(words[20] & 0x7fff, CUE_EMPTY); // beyond v1's 20 voices
  const [w0, w1] = cueInstructionWords(words);
  assert.equal(w0, word0);
  assert.equal(w1, 0);
});
