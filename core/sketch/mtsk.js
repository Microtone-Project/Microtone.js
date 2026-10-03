// The Microtone Touch sketch file, .mtsk (microtone-worker/assets/
// MICROTONE_SKETCH_FORMAT.md) — and the one place that says what Taud song a
// sketch IS.
//
// A sketch file is a .taud with everything a phone cannot change taken out:
// no sample or instrument image (the pack in pack.js stands in for it, built
// by whichever app opens the file), no song table (eight lanes, six ticks a
// row, one cue per section — all fixed by the format), and no cue sheet (the
// sections play A, B, C… in order). What is left is a 32-byte header, the 128
// pattern images of sections A…P compressed as one blob, and a few
// Project-Data blocks. A sent sketch is a few hundred bytes where the .taud
// it stands for is seventy kilobytes, nearly all of it the pack.
//
// Touch's transport plays sketchTaudDoc of its own fields, and the tracker
// opens a file through the same function, so a sketch sounds the same in
// both by construction rather than by two copies agreeing.

import { gzipSync } from "../vendor/fflate.esm.js";
import { decomp } from "../format/compress.js";
import { writeTaud } from "../format/taud-write.js";
import { escapeNonAscii, encodeProjectString, decodeProjectString } from "../format/names.js";
import { PROJ_MAGIC, PATTERN_SIZE, CUE_EMPTY, NUM_VOICES } from "../format/taud-const.js";
import { buildBank, packNames } from "./pack.js";

/** `\x1FMTskech` */
export const MTSK_MAGIC = Uint8Array.from([0x1f, 0x4d, 0x54, 0x73, 0x6b, 0x65, 0x63, 0x68]);
export const MTSK_VERSION = 1;
export const MTSK_HEADER_SIZE = 32;
export const MTSK_EXTENSION = ".mtsk";
export const MTSK_LANES = 8;
/** Sections A…P. */
export const MTSK_SECTIONS = 16;
export const MTSK_PATTERNS = MTSK_SECTIONS * MTSK_LANES;
/** The pattern blob's size once decompressed, whatever the sketch holds. */
export const MTSK_PATTERN_BYTES = MTSK_PATTERNS * PATTERN_SIZE;
/** A sketch has a tempo, not a speed. */
export const MTSK_TICKS_PER_ROW = 6;
export const MTSK_SIGNATURE = "MicrotoneTouch";
/** BPM is stored as BPM − 25 in ten bits. */
export const MTSK_BPM_MIN = 25;
export const MTSK_BPM_MAX = 25 + 0x3ff;

/** The header's three named tunings, by their `tt` code; 3 = the `tune` block. */
export const MTSK_TUNINGS = Object.freeze([
  Object.freeze({ baseNote: 0x5c00, freq: 440 }), // A4 @ 440 Hz
  Object.freeze({ baseNote: 0x5000, freq: 262 }), // C4 @ 262 Hz, the Chinese a-ak
  Object.freeze({ baseNote: 0x5000, freq: 311 }), // C4 @ 311 Hz, the Korean hyang-ak
]);
const TT_TUNE = 3;

/** Pattern number of `lane` in `section`, in the blob and in the Taud song alike. */
export const mtskPattern = (section, lane) => section * MTSK_LANES + lane;

export class SketchFormatError extends Error {}
const invalid = (why) => new SketchFormatError(`mtsk: ${why}`);

export function isSketch(bytes) {
  if (!bytes || bytes.length < MTSK_HEADER_SIZE) return false;
  for (let i = 0; i < MTSK_MAGIC.length; i++) if (bytes[i] !== MTSK_MAGIC[i]) return false;
  return true;
}

/** The pattern blob as Touch compresses it: gzip at its best, no timestamp. */
export const gzipBest = (bytes) => gzipSync(bytes, { level: 9, mtime: 0 });

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * A sketch as bytes. `sketch` = {
 *   name,         display text (escaped on the way in, as .taud's PNam is)
 *   bpm,          25…1048
 *   loop,         true: the last section jumps back to A
 *   sections,     1…16
 *   notation,     sMet notation index (TAUD_FILE_FORMAT.md §9.6)
 *   tuning,       { baseNote, freq } — one of MTSK_TUNINGS rides the header;
 *                 anything else travels as a `tune` block
 *   patterns,     Uint8Array(MTSK_PATTERN_BYTES): patterns 0…127, eight per section
 *   nota,         OPTIONAL: a `nota` payload, verbatim (custom notations)
 * }
 * `compress` makes the pattern blob: gzip or zstd, anything decomp() sniffs.
 */
export function writeSketch(sketch, compress = gzipBest) {
  const { patterns } = sketch;
  if (!(patterns instanceof Uint8Array) || patterns.length !== MTSK_PATTERN_BYTES) {
    throw new RangeError(`mtsk: the pattern blob must be ${MTSK_PATTERN_BYTES} bytes`);
  }
  const sections = sketch.sections;
  if (!Number.isInteger(sections) || sections < 1 || sections > MTSK_SECTIONS) {
    throw new RangeError(`mtsk: ${sections} sections (1…${MTSK_SECTIONS})`);
  }
  const bpm = Math.min(MTSK_BPM_MAX, Math.max(MTSK_BPM_MIN, Math.round(sketch.bpm))) - 25;
  const baseNote = sketch.tuning.baseNote;
  const freq = Math.fround(sketch.tuning.freq);
  let tt = MTSK_TUNINGS.findIndex((t) => t.baseNote === baseNote && t.freq === freq);
  if (tt < 0) tt = TT_TUNE;

  const blocks = [];
  if (sketch.name) blocks.push(["PNam", encodeProjectString("PNam", sketch.name)]);
  if (sketch.nota?.length) blocks.push(["nota", sketch.nota]);
  if (tt === TT_TUNE) {
    const tune = new Uint8Array(6);
    const dv = new DataView(tune.buffer);
    dv.setUint16(0, baseNote, true);
    dv.setFloat32(2, freq, true);
    blocks.push(["tune", tune]);
  }

  const packed = compress(patterns);
  const projOff = blocks.length > 0 ? MTSK_HEADER_SIZE + packed.length : 0;
  const head = new Uint8Array(MTSK_HEADER_SIZE);
  const dv = new DataView(head.buffer);
  head.set(MTSK_MAGIC, 0);
  head[8] = MTSK_VERSION;
  head[9] = ((sections - 1) << 4) | (sketch.loop ? 1 : 0);
  head[10] = (tt << 2) | (bpm >>> 8);
  head[11] = bpm & 0xff;
  dv.setUint16(12, sketch.notation, true);
  dv.setUint32(14, projOff, true);
  const sig = (sketch.signature ?? MTSK_SIGNATURE).padEnd(14, " ").slice(0, 14);
  for (let i = 0; i < 14; i++) head[18 + i] = sig.charCodeAt(i) & 0xff;

  const parts = [head, packed];
  if (blocks.length > 0) {
    parts.push(PROJ_MAGIC, new Uint8Array(8));
    for (const [fourcc, payload] of blocks) {
      const tag = new Uint8Array(8);
      for (let i = 0; i < 4; i++) tag[i] = fourcc.charCodeAt(i);
      new DataView(tag.buffer).setUint32(4, payload.length, true);
      parts.push(tag, payload);
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Bytes as a sketch — the shape writeSketch takes, plus `version` and
 * `signature`. Throws SketchFormatError on anything the specification calls
 * INVALID; skips what it calls RESERVED or IGNORED.
 */
export function parseSketch(bytes) {
  if (!isSketch(bytes)) throw invalid("not a sketch (no \\x1FMTskech magic)");
  const version = bytes[8];
  if (version !== MTSK_VERSION) throw invalid(`format version ${version} is not one this reader knows`);
  const songFlags = bytes[9];
  const features = bytes[10];
  const tt = (features >>> 2) & 3;
  const bpm = 25 + ((((features & 3) << 8) | bytes[11]));
  const notation = u16(bytes, 12);
  const projOff = u32(bytes, 14);
  let signature = "";
  for (let i = 18; i < 32; i++) signature += String.fromCharCode(bytes[i]);

  if (projOff !== 0 && (projOff <= MTSK_HEADER_SIZE || projOff + 16 > bytes.length)) {
    throw invalid(`Project Data offset ${projOff} is outside the file`);
  }
  const blobEnd = projOff || bytes.length;
  let patterns;
  try {
    patterns = decomp(bytes.subarray(MTSK_HEADER_SIZE, blobEnd), MTSK_PATTERN_BYTES);
  } catch (err) {
    throw invalid(`the pattern blob does not decompress (${err.message})`);
  }
  if (patterns.length !== MTSK_PATTERN_BYTES) {
    throw invalid(`the pattern blob is ${patterns.length} bytes, not ${MTSK_PATTERN_BYTES}`);
  }

  const blocks = new Map();
  if (projOff) {
    for (let i = 0; i < 8; i++) {
      if (bytes[projOff + i] !== PROJ_MAGIC[i]) throw invalid("Project Data without its \\x1ETaudPrJ magic");
    }
    let p = projOff + 16;
    while (p < bytes.length) {
      if (p + 8 > bytes.length) throw invalid("a Project-Data block header runs off the end");
      const fourcc = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      const len = u32(bytes, p + 4);
      if (p + 8 + len > bytes.length) throw invalid(`block ${fourcc} runs off the end`);
      if (!blocks.has(fourcc)) blocks.set(fourcc, bytes.slice(p + 8, p + 8 + len));
      p += 8 + len;
    }
  }

  let tuning;
  if (tt === TT_TUNE) {
    const tune = blocks.get("tune");
    if (!tune || tune.length < 6) throw invalid("tuning code 3 without a `tune` block");
    const dv = new DataView(tune.buffer, tune.byteOffset, tune.byteLength);
    const baseNote = dv.getUint16(0, true);
    const freq = dv.getFloat32(2, true);
    if (baseNote < 1 || baseNote > 65533 || !(freq > 0) || !Number.isFinite(freq)) {
      throw invalid(`\`tune\` declares note ${baseNote} at ${freq} Hz`);
    }
    tuning = { baseNote, freq };
  } else {
    tuning = { ...MTSK_TUNINGS[tt] };
  }

  const pnam = blocks.get("PNam");
  let name = "";
  if (pnam) {
    const nul = pnam.indexOf(0);
    name = decodeProjectString("PNam", new TextDecoder().decode(nul < 0 ? pnam : pnam.subarray(0, nul)));
  }

  return {
    version,
    signature,
    name,
    bpm,
    loop: (songFlags & 1) !== 0,
    sections: (songFlags >>> 4) + 1,
    notation,
    tuning,
    patterns,
    nota: blocks.get("nota") ?? null,
  };
}

// ── what a sketch plays as ──────────────────────────────────────────────────

const JMP_TO_START = 0xf000; // JMP 0 — "this is how a song loops"
const HALT = 0x0100;

/** The cue's lane words with `word0` spread over lanes 0…15's sign bits (Taud §6.2). */
function cueWords(section, word0) {
  const words = new Uint16Array(64).fill(CUE_EMPTY);
  for (let l = 0; l < MTSK_LANES; l++) words[l] = mtskPattern(section, l);
  for (let c = 0; c < 16; c++) {
    if ((word0 >>> c) & 1) words[c] |= 0x8000;
  }
  return words;
}

const utf8z = (s) => Uint8Array.from([...new TextEncoder().encode(s), 0]);

/**
 * The Taud song a sketch is (the specification's "Playing a sketch"), in the
 * shape parseTaud returns and AudioSystem.loadDocument and writeTaud take.
 * `pack` is buildBank()'s { image, names }. With `only` set, the song is that
 * one section looping — what Touch's transport plays while a section is being
 * worked on; the patterns are always every section's, so pattern numbers
 * never move.
 */
export function sketchTaudDoc(sketch, pack, { only = null } = {}) {
  const patterns = [];
  for (let p = 0; p < sketch.sections * MTSK_LANES; p++) {
    patterns.push(sketch.patterns.slice(p * PATTERN_SIZE, (p + 1) * PATTERN_SIZE));
  }
  const order = only === null ? Array.from({ length: sketch.sections }, (_, i) => i) : [only];
  const cues = order.map((s, i) => {
    const last = i === order.length - 1;
    return cueWords(s, last ? (sketch.loop || only !== null ? JMP_TO_START : HALT) : 0);
  });

  const name = escapeNonAscii(sketch.name ?? "");
  const smetBody = [
    sketch.notation & 0xff, sketch.notation >>> 8,
    4, 16, // beat divisions: four rows a beat, sixteen a bar
    ...utf8z(name), 0, 0, // song name; no composer, no copyright
  ];
  const smet = new Uint8Array(5 + smetBody.length);
  new DataView(smet.buffer).setUint32(1, smetBody.length, true); // smet[0]: song 0
  smet.set(smetBody, 5);
  const projSections = [];
  if (name) projSections.push({ fourcc: "PNam", payload: encodeProjectString("PNam", sketch.name) });
  projSections.push(
    { fourcc: "INam", payload: packNames(pack) },
    { fourcc: "sMet", payload: smet },
  );
  if (sketch.nota?.length) projSections.push({ fourcc: "nota", payload: Uint8Array.from(sketch.nota) });

  return {
    kind: "taud",
    fmtVer: 2,
    is64Channel: false,
    signature: MTSK_SIGNATURE,
    sampleInstImage: pack.image,
    songs: [{
      numVoices: NUM_VOICES,
      numPats: patterns.length,
      bpm: sketch.bpm, // a .taud song table holds the same ten bits
      tickRate: MTSK_TICKS_PER_ROW,
      tuningBaseNote: sketch.tuning.baseNote,
      tuningFreq: sketch.tuning.freq,
      globalFlags: 0,
      globalVolume: 0x80,
      mixingVolume: 0x80,
      surroundModel: 0,
      numCuesStored: cues.length,
      patterns,
      cues,
    }],
    projSections,
    ixmp: [],
  };
}

/** A .mtsk file as the .taud bytes it stands for, the pack built in — how
 *  the tracker opens one. Throws SketchFormatError if the file is INVALID. */
export function sketchFileToTaud(bytes, pack = buildBank()) {
  return writeTaud(sketchTaudDoc(parseSketch(bytes), pack));
}
