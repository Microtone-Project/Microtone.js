// The Microtone Touch sketch file (.mtsk) — core/sketch/mtsk.js against
// assets/MICROTONE_SKETCH_FORMAT.md, and the instrument pack (core/sketch/
// pack.js) against the committed assets/MicrotoneTouch.tsii it is defined by.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  writeSketch, parseSketch, isSketch, sketchTaudDoc, sketchFileToTaud, gzipBest, mtskPattern,
  MTSK_MAGIC, MTSK_HEADER_SIZE, MTSK_PATTERN_BYTES, MTSK_TUNINGS, MTSK_SIGNATURE, SketchFormatError,
} from "../../core/sketch/mtsk.js";
import { buildBank, PRESETS, DRUMS } from "../../core/sketch/pack.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { writeTaud } from "../../core/format/taud-write.js";
import { PROJ_MAGIC, PATTERN_SIZE, CUE_EMPTY } from "../../core/format/taud-const.js";
import { loadZstd } from "../../core/format/zstd.js";
import { gunzipSync } from "../../core/vendor/fflate.esm.js";
import { SKETCH_SIZE_LIMIT, SKETCH_LIMIT } from "../../server/online/util.js";

const bank = buildBank();

/** A sketch's fields with a recognisable pattern blob: pattern p's first
 *  cell holds note $3000 + p and every cell's columns read "no intent". */
function fields(over = {}) {
  const patterns = new Uint8Array(MTSK_PATTERN_BYTES);
  for (let p = 0; p < 128; p++) {
    for (let r = 0; r < 64; r++) {
      patterns[p * PATTERN_SIZE + r * 8 + 3] = 0xc0;
      patterns[p * PATTERN_SIZE + r * 8 + 4] = 0xc0;
    }
    patterns[p * PATTERN_SIZE] = p;
    patterns[p * PATTERN_SIZE + 1] = 0x30;
    patterns[p * PATTERN_SIZE + 2] = 4; // pluck
  }
  return {
    name: "Riff", bpm: 120, loop: true, sections: 3, notation: 120,
    tuning: { ...MTSK_TUNINGS[0] }, patterns, ...over,
  };
}

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The Project-Data blocks of a file, by FourCC. */
function blocks(bytes) {
  const off = u32(bytes, 14);
  const out = {};
  if (!off) return out;
  for (let p = off + 16; p < bytes.length;) {
    const len = u32(bytes, p + 4);
    out[String.fromCharCode(...bytes.subarray(p, p + 4))] = bytes.subarray(p + 8, p + 8 + len);
    p += 8 + len;
  }
  return out;
}

test("header: 32 bytes laid out as the specification's table", () => {
  const bytes = writeSketch(fields({ sections: 5, loop: true, bpm: 300, notation: 10123, tuning: { ...MTSK_TUNINGS[2] } }));
  assert.deepEqual([...bytes.subarray(0, 8)], [...MTSK_MAGIC]);
  assert.equal(String.fromCharCode(...bytes.subarray(1, 8)), "MTskech");
  assert.equal(bytes[8], 1, "format version");
  assert.equal(bytes[9], (4 << 4) | 1, "sections − 1 in the high nibble, loop in bit 0");
  // BPM 300 → 275 = $113: pp = 1, low = $13; tt = 2 (C4 @ 311 Hz)
  assert.equal(bytes[10], (2 << 2) | 1);
  assert.equal(bytes[11], 0x13);
  assert.equal(bytes[12] | (bytes[13] << 8), 10123);
  const projOff = u32(bytes, 14);
  assert.ok(projOff > MTSK_HEADER_SIZE);
  assert.deepEqual([...bytes.subarray(projOff, projOff + 8)], [...PROJ_MAGIC]);
  assert.deepEqual([...bytes.subarray(projOff + 8, projOff + 16)], new Array(8).fill(0), "RESERVED");
  assert.equal(String.fromCharCode(...bytes.subarray(18, 32)), MTSK_SIGNATURE);
  // the blob between the header and Project Data is the 64 KiB of patterns, gzip
  const blob = gunzipSync(bytes.subarray(MTSK_HEADER_SIZE, projOff));
  assert.equal(blob.length, MTSK_PATTERN_BYTES);
});

test("round trip: every field, at the edges of its range", () => {
  for (const over of [
    { sections: 1, loop: false, bpm: 25 },
    { sections: 16, loop: true, bpm: 25 + 1023 },
    { bpm: 280 }, { bpm: 281 }, { bpm: 535 }, { bpm: 536 },
    { tuning: { ...MTSK_TUNINGS[1] }, notation: 10123 },
    { tuning: { baseNote: 0x5c00, freq: 432 } },
    { tuning: { baseNote: 0x5000, freq: 256 }, notation: 35130 },
    { name: "가락 ‘sketch’ — 黃鐘" },
  ]) {
    const want = fields(over);
    const got = parseSketch(writeSketch(want));
    assert.equal(got.version, 1);
    assert.equal(got.signature, MTSK_SIGNATURE);
    for (const k of ["name", "bpm", "loop", "sections", "notation"]) assert.equal(got[k], want[k], `${k} of ${JSON.stringify(over)}`);
    assert.deepEqual(got.tuning, want.tuning);
    assert.deepEqual(got.patterns, want.patterns);
    assert.equal(got.nota, null);
  }
});

test("Project Data: only what is needed, and the name escaped exactly as .taud's PNam", () => {
  // a plain name on a named tuning: PNam only
  assert.deepEqual(Object.keys(blocks(writeSketch(fields()))), ["PNam"]);
  // no name and a named tuning: no Project Data at all
  const bare = writeSketch(fields({ name: "" }));
  assert.equal(u32(bare, 14), 0);
  assert.equal(parseSketch(bare).name, "");
  // any other tuning travels as `tune`: U16 base note, F32 Hz
  const tuned = blocks(writeSketch(fields({ tuning: { baseNote: 0x5c00, freq: 432 } })));
  const dv = new DataView(tuned.tune.buffer, tuned.tune.byteOffset, 6);
  assert.equal(tuned.tune.length, 6);
  assert.equal(dv.getUint16(0, true), 0x5c00);
  assert.equal(dv.getFloat32(2, true), 432);
  // PNam is ASCII with \uHHHH escapes and a NUL — byte for byte what a .taud holds
  const pnam = blocks(writeSketch(fields({ name: "가락" }))).PNam;
  assert.equal(new TextDecoder().decode(pnam), "\\uAC00\\uB77D\0");
  const taudPnam = sketchTaudDoc(fields({ name: "가락" }), bank).projSections.find((s) => s.fourcc === "PNam");
  assert.deepEqual(taudPnam.payload, pnam);
  // a custom notation rides along verbatim, into the .taud as well
  const nota = Uint8Array.from([0, 3, 0, 0, 0, 1, 2, 3]);
  const withNota = writeSketch(fields({ nota, notation: 65535 }));
  assert.deepEqual(parseSketch(withNota).nota, nota);
  const doc = parseTaud(sketchFileToTaud(withNota, bank));
  assert.deepEqual(doc.projSections.find((s) => s.fourcc === "nota").payload, nota);
});

test("a reader decompresses gzip and zstd alike, and skips blocks it does not know", async () => {
  const zstd = await loadZstd();
  const want = fields({ sections: 7 });
  const z = writeSketch(want, (b) => zstd.compress(b, 19));
  assert.deepEqual([...z.subarray(32, 36)], [0x28, 0xb5, 0x2f, 0xfd]);
  assert.deepEqual(parseSketch(z).patterns, want.patterns);

  // an unknown block, and a `tune` the header does not call for: IGNORED
  const bytes = writeSketch(fields({ tuning: { baseNote: 0x5c00, freq: 432 } }));
  const extra = new Uint8Array(bytes.length + 8 + 3);
  extra.set(bytes);
  extra.set([0x78, 0x79, 0x7a, 0x7a, 3, 0, 0, 0, 1, 2, 3], bytes.length); // "xyzz", 3 bytes
  extra[10] &= ~0x0c; // tt = 0: A4 @ 440, whatever `tune` says
  const got = parseSketch(extra);
  assert.deepEqual(got.tuning, MTSK_TUNINGS[0]);
  assert.equal(got.name, "Riff");
});

test("INVALID files are refused, each with its reason", () => {
  const good = writeSketch(fields({ tuning: { baseNote: 0x5c00, freq: 432 } }));
  const projOff = u32(good, 14);
  const mutate = (fn) => { const b = good.slice(); fn(b); return b; };
  const cases = {
    "bad magic": mutate((b) => { b[3] = 0x78; }),
    "unknown version": mutate((b) => { b[8] = 2; }),
    "short header": good.subarray(0, 20),
    "Project Data offset past the end": mutate((b) => new DataView(b.buffer).setUint32(14, b.length + 5, true)),
    "Project Data offset inside the header": mutate((b) => new DataView(b.buffer).setUint32(14, 8, true)),
    "Project Data without its magic": mutate((b) => { b[projOff + 1] = 0; }),
    "a block running off the end": good.subarray(0, good.length - 2),
    "tuning code 3 without `tune`": writeSketch(fields({ name: "" })).map((v, i) => (i === 10 ? v | 0x0c : v)),
    "a `tune` with base note 0": mutate((b) => { b[b.length - 6] = 0; b[b.length - 5] = 0; }),
    "a short pattern blob": writeSketch(fields(), () => gzipBest(new Uint8Array(MTSK_PATTERN_BYTES - 512))),
    "a blob that is not compressed": writeSketch(fields(), (b) => b.slice(0, 100)),
  };
  for (const [why, bytes] of Object.entries(cases)) {
    assert.throws(() => parseSketch(bytes), SketchFormatError, why);
  }
  assert.equal(isSketch(cases["bad magic"]), false);
  assert.equal(isSketch(good), true);
  assert.throws(() => writeSketch(fields({ sections: 17 })), RangeError);
  assert.throws(() => writeSketch(fields({ patterns: new Uint8Array(512) })), RangeError);
});

test("playing a sketch: the Taud song it stands for", () => {
  const f = fields({ sections: 3, bpm: 140, tuning: { ...MTSK_TUNINGS[1] }, notation: 10123 });
  const doc = parseTaud(sketchFileToTaud(writeSketch(f), bank));
  const song = doc.songs[0];
  assert.equal(doc.kind, "taud");
  assert.equal(doc.songs.length, 1);
  assert.equal(song.numPats, 24, "eight patterns a section, only the sections in use");
  assert.equal(song.tickRate, 6);
  assert.equal(song.bpm, 140);
  assert.equal(song.tuningBaseNote, 0x5000);
  assert.equal(song.tuningFreq, 262);
  assert.equal(song.globalFlags, 0);
  assert.equal(doc.meta.songMeta[0].notation, 10123);
  assert.equal(doc.meta.projectName, "Riff");
  for (let p = 0; p < 24; p++) assert.deepEqual(song.patterns[p], f.patterns.subarray(p * 512, (p + 1) * 512));
  // one cue a section, lanes 0…7 = its patterns, the rest empty; JMP 0 on the last
  assert.equal(song.cues.length, 3);
  song.cues.forEach((words, s) => {
    for (let l = 0; l < 8; l++) assert.equal(words[l] & 0x7fff, mtskPattern(s, l));
    for (let l = 8; l < 32; l++) assert.equal(words[l] & 0x7fff, CUE_EMPTY);
    let word0 = 0;
    for (let c = 0; c < 16; c++) word0 |= (words[c] >>> 15) << c;
    assert.equal(word0, s === 2 ? 0xf000 : 0);
  });
  // no loop: HALT instead
  const halt = parseTaud(sketchFileToTaud(writeSketch({ ...f, loop: false }), bank)).songs[0].cues[2];
  let word0 = 0;
  for (let c = 0; c < 16; c++) word0 |= (halt[c] >>> 15) << c;
  assert.equal(word0, 0x0100);
  // the pack, whole, and its names
  assert.deepEqual(doc.sampleInstImage, bank.image);
  const inam = new TextDecoder().decode(doc.projSections.find((s) => s.fourcc === "INam").payload).split("\x1e");
  assert.deepEqual(inam, bank.names);
  // a .taud song table holds the sketch's whole tempo range, so nothing clamps
  for (const bpm of [900, 25 + 1023]) {
    assert.equal(sketchTaudDoc(fields({ bpm }), bank).songs[0].bpm, bpm);
    assert.equal(parseTaud(sketchFileToTaud(writeSketch(fields({ bpm })), bank)).songs[0].bpm, bpm);
  }
});

test("the instrument pack: its slots, and the committed .tsii that defines its sound", () => {
  // slots are part of the format: 1…7 melodic in picker order, 8…15 the kit
  assert.deepEqual(bank.slots, {
    piano: 1, epiano: 2, bass: 3, pluck: 4, lead: 5, pad: 6, organ: 7, drums: [8, 9, 10, 11, 12, 13, 14, 15],
  });
  assert.deepEqual(PRESETS.map((p) => p.id), ["piano", "epiano", "bass", "pluck", "lead", "pad", "organ", "drums"]);
  assert.deepEqual(DRUMS.map((d) => d.id), ["kick", "snare", "hatc", "hato", "clap", "toml", "tomh", "rim"]);
  const path = fileURLToPath(new URL("../../assets/MicrotoneTouch.tsii", import.meta.url));
  const tsii = parseTaud(new Uint8Array(readFileSync(path)));
  assert.equal(tsii.kind, "tsii");
  assert.ok(
    tsii.sampleInstImage.every((v, i) => v === bank.image[i]),
    "the pack no longer builds what assets/MicrotoneTouch.tsii holds — a sound change needs a new " +
    "sketch format version, then `node tools/make-touch-pack.js`",
  );
  const names = new TextDecoder().decode(tsii.projSections.find((s) => s.fourcc === "INam").payload);
  assert.deepEqual(names.split("\x1e"), bank.names);
});

test("size: an empty sketch is a couple of hundred bytes, and no sketch can outgrow its slot", () => {
  const empty = new Uint8Array(MTSK_PATTERN_BYTES);
  for (let i = 0; i < empty.length; i += 8) empty[i + 3] = empty[i + 4] = 0xc0;
  assert.ok(writeSketch(fields({ sections: 1, patterns: empty })).length < 300);
  // the worst any encoder can do: incompressible patterns, the longest name
  // the server takes, a big custom notation — still inside the slot ceiling
  let seed = 7;
  const noise = Uint8Array.from({ length: MTSK_PATTERN_BYTES }, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24));
  const worst = writeSketch(fields({ patterns: noise, name: "가".repeat(115), nota: new Uint8Array(16384) }));
  assert.ok(worst.length < SKETCH_SIZE_LIMIT, `${worst.length} bytes`);
  assert.ok(SKETCH_LIMIT * SKETCH_SIZE_LIMIT <= 8 * 1024 * 1024, "64 full slots stay within 8 MiB");
});

test("the Taud doc is what writeTaud and the parser agree on", () => {
  const f = fields({ sections: 16 });
  const once = writeTaud(sketchTaudDoc(f, bank));
  assert.deepEqual(writeTaud(parseTaud(once)), once, "a re-save of an opened sketch changes nothing");
});
