// .taud / .tsii / .tpif container parser — mirror of taud.mjs#uploadTaudFile
// (assets/disk0/tvdos/include/taud.mjs:180-391) parsing straight into JS
// structures instead of device uploads. Raw byte payloads (sample+inst image,
// 512-byte patterns, u16 cue words, Project-Data sections) are kept as the
// source of truth so a re-serialise round-trips content-exactly.

import {
  TAUD_MAGIC, PROJ_MAGIC,
  TAUD_VERSION_MASK, TAUD_XHDR_FLAG,
  TAUD_KIND_MASK, TAUD_KIND_FULL, TAUD_KIND_SAMPLEINST, TAUD_KIND_PATTERN,
  TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
  SAMPLEINST_SIZE, SAMPLEBIN_SIZE,
  PATTERN_SIZE,
  patternSizeFor,
  NUM_VOICES, MAX_VOICES, CUE_SIZE, CUE_SIZE_64, NUM_CUES, NUM_CUES_64,
  CUE_EMPTY, CUE_SIZE_V1, NUM_VOICES_V1, CUE_EMPTY_V1,
  ixmpPatchLen,
} from "./taud-const.js";
import { decomp } from "./compress.js";
import { parseMasteringSection } from "./mastering-section.js";

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
function f32(b, o) {
  return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
}
function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
// Byte-per-char string (mirrors taud.mjs _strBytesNul / String.fromCharCode readers).
function strNul(b, o, end) {
  let s = "";
  while (o < end && b[o] !== 0) s += String.fromCharCode(b[o++]);
  return { str: s, next: o + 1 };
}

// _v1CueToV2 (taud.mjs:123-144), producing u16 cue words instead of bytes:
// 20 voices × 12-bit patterns in lo/mid/hi nibble planes + 16-bit instruction
// word in bytes 30/31 → 64 u16 words (low 15 bits pattern, sign bit = word0 bit).
export function v1CueToWords(cueBin, off) {
  const b = cueBin.subarray(off, off + CUE_SIZE_V1);
  const word0 = (b[30] << 8) | b[31];
  const out = new Uint16Array(MAX_VOICES).fill(CUE_EMPTY);
  for (let ch = 0; ch < NUM_VOICES; ch++) {
    let pat = CUE_EMPTY;
    if (ch < NUM_VOICES_V1) {
      const bi = ch >> 1;
      const lo = (ch & 1) ? (b[bi] & 0xf) : ((b[bi] >> 4) & 0xf);
      const mi = (ch & 1) ? (b[10 + bi] & 0xf) : ((b[10 + bi] >> 4) & 0xf);
      const hi = (ch & 1) ? (b[20 + bi] & 0xf) : ((b[20 + bi] >> 4) & 0xf);
      const p12 = (hi << 8) | (mi << 4) | lo;
      pat = p12 === CUE_EMPTY_V1 ? CUE_EMPTY : p12;
    }
    let val = pat & 0x7fff;
    if (ch < 16 && (word0 >> ch) & 1) val |= 0x8000;
    out[ch] = val;
  }
  return out;
}

// Decode a cue's two instruction words from its u16 channel words
// (sign bits of ch0-15 = word0, ch16-31 = word1; terranmon.txt §"Cue sheet").
export function cueInstructionWords(words) {
  let w0 = 0, w1 = 0;
  for (let ch = 0; ch < 16; ch++) if (words[ch] & 0x8000) w0 |= 1 << ch;
  for (let ch = 16; ch < 32; ch++) if (words[ch] & 0x8000) w1 |= 1 << (ch - 16);
  return [w0, w1];
}

function parseXHDR64(payload) {
  return payload.length >= 1 && (payload[0] & 0x01) !== 0;
}

// Ixmp section payload → [{instId, count, blob}] with the blob kept verbatim
// (taud.mjs:354-381; 4-byte entry header carries a 10-bit inst id).
export function parseIxmpSection(payload) {
  const entries = [];
  let q = 0;
  const qEnd = payload.length;
  while (q + 4 <= qEnd) {
    const instId = payload[q] | ((payload[q + 3] & 0x03) << 8);
    const patchCnt = payload[q + 1] | (payload[q + 2] << 8);
    q += 4;
    let blobLen = 0, scan = q, ok = true;
    for (let i = 0; i < patchCnt; i++) {
      if (scan + 31 > qEnd) { ok = false; break; }
      const len = ixmpPatchLen(payload, scan);
      if (scan + len > qEnd) { ok = false; break; }
      scan += len;
      blobLen += len;
    }
    if (!ok) break;
    entries.push({ instId, count: patchCnt, blob: payload.subarray(q, q + blobLen) });
    q += blobLen;
  }
  return entries;
}

// sMet section payload → per-song metadata (mirror of the capture writer
// taud.mjs:555-570: u8 songIndex, u32 subLen, { notation u16, beatPri u8,
// beatSec u8, name\0 composer\0 copyright\0 }).
export function parseSMetSection(payload) {
  const out = {};
  let p = 0;
  while (p + 5 <= payload.length) {
    const songIndex = payload[p];
    const subLen = u32(payload, p + 1);
    const sub = p + 5;
    if (sub + subLen > payload.length) break;
    const notation = u16(payload, sub);
    const beatPri = payload[sub + 2];
    const beatSec = payload[sub + 3];
    let o = sub + 4;
    const name = strNul(payload, o, sub + subLen); o = name.next;
    const composer = strNul(payload, o, sub + subLen); o = composer.next;
    const copyright = strNul(payload, o, sub + subLen);
    out[songIndex] = {
      notation, beatPri, beatSec,
      name: name.str, composer: composer.str, copyright: copyright.str,
    };
    p = sub + subLen;
  }
  return out;
}

/**
 * Parse a Taud container.
 * @param {Uint8Array} file
 * @returns parsed structure:
 * {
 *   kind: 'taud'|'tsii'|'tpif', fmtVer, is64Channel, signature,
 *   sampleInstImage: Uint8Array(8650752)|null,   // decompressed; samples [0,8M) + inst records [8M,+256K)
 *   songs: [{ numVoices, numPats, bpm, tickRate, tuningBaseNote, tuningFreq,
 *             globalFlags, globalVolume, mixingVolume, numCuesStored, surroundModel,
 *             patterns: Uint8Array(512)[],       // raw pattern images
 *             cues: Uint16Array(64)[] }],        // raw u16 channel words (pattern | sign bit)
 *   projSections: [{fourcc, payload: Uint8Array}],  // verbatim, in file order
 *   ixmp: [{instId, count, blob}],               // decoded view of the Ixmp section
 *   meta: { projectName, songMeta: {idx: {...}},  // decoded views of PNam / sMet
 *           mastering: {idx: {...}} }             // …and of sMst (§9.12)
 * }
 */
export function parseTaud(file) {
  for (let i = 0; i < 8; i++) {
    if (file[i] !== TAUD_MAGIC[i]) {
      throw new Error(`taud: bad magic byte 0x${file[i].toString(16)} at index ${i}`);
    }
  }
  const version = file[8];
  const numSongs = file[9];
  const compSize = u32(file, 10);
  const projOff = u32(file, 14);
  let signature = "";
  for (let i = 18; i < 32; i++) signature += String.fromCharCode(file[i]);

  const kindBits = version & TAUD_KIND_MASK;
  const kind =
    kindBits === TAUD_KIND_SAMPLEINST ? "tsii" :
    kindBits === TAUD_KIND_PATTERN ? "tpif" :
    kindBits === TAUD_KIND_FULL ? "taud" : null;
  if (kind === null) throw new Error(`taud: invalid container kind bits 0b01`);
  const fmtVer = version & TAUD_VERSION_MASK;

  // ── Project Data sections (walked first: the xHDR 64-ch flag changes the cue stride) ──
  const projSections = [];
  if (projOff !== 0 && projOff + 16 <= file.length) {
    let prjOk = true;
    for (let i = 0; i < 8; i++) if (file[projOff + i] !== PROJ_MAGIC[i]) { prjOk = false; break; }
    if (prjOk) {
      let p = projOff + 16;
      while (p + 8 <= file.length) {
        const fc = fourcc(file, p);
        const secLen = u32(file, p + 4);
        const payload = p + 8;
        if (payload + secLen > file.length) break;
        projSections.push({ fourcc: fc, payload: file.subarray(payload, payload + secLen) });
        p = payload + secLen;
      }
    }
  }
  const findSec = (fc) => projSections.find((s) => s.fourcc === fc);

  const is64Channel =
    (version & TAUD_XHDR_FLAG) !== 0 && !!findSec("xHDR") && parseXHDR64(findSec("xHDR").payload);

  // ── sample+instrument image (absent for .tpif) ──
  let sampleInstImage = null;
  if (kind !== "tpif" && compSize > 0) {
    sampleInstImage = decomp(file.subarray(TAUD_HEADER_SIZE, TAUD_HEADER_SIZE + compSize), SAMPLEINST_SIZE);
    if (sampleInstImage.length !== SAMPLEINST_SIZE) {
      // Tolerate short images (pad) — the device treats missing tail as zeros.
      const full = new Uint8Array(SAMPLEINST_SIZE);
      full.set(sampleInstImage.subarray(0, Math.min(sampleInstImage.length, SAMPLEINST_SIZE)));
      sampleInstImage = full;
    }
  }

  // ── song table + per-song pattern/cue bins ──
  const songs = [];
  if (kind !== "tsii") {
    const tableOff = TAUD_HEADER_SIZE + compSize;
    for (let s = 0; s < numSongs; s++) {
      const e = tableOff + s * TAUD_SONG_ENTRY;
      const songOffset = u32(file, e);
      const numVoices = file[e + 4];
      const numPats = u16(file, e + 5);
      let bpmStored = file[e + 7];
      const tickPacked = file[e + 8];
      const tickRate = tickPacked & 0x7f;
      bpmStored |= (tickPacked & 0x80) << 1;
      const tuningBaseNote = u16(file, e + 9);
      const tuningFreq = f32(file, e + 11);
      const globalFlags = file[e + 15];
      const globalVolume = file[e + 16];
      const mixingVolume = file[e + 17];
      const patComp = u32(file, e + 18);
      const cueComp = u32(file, e + 22);
      const numCuesStored = u16(file, e + 26);
      // Immutable song flags: `ss` = surround model (#998) — 0 stereo,
      // 1 planar (360° panning), 2 spatial.
      const surroundModel = file[e + 28] & 3;

      // Version 3 doubles the cell (and so the pattern image) — see the file
      // format's §5.5. Everything else about a song is unchanged by it.
      const patSize = patternSizeFor(fmtVer);
      const patBin = decomp(file.subarray(songOffset, songOffset + patComp), numPats * patSize);
      const patterns = [];
      for (let p = 0; p < numPats; p++) {
        patterns.push(patBin.subarray(p * patSize, (p + 1) * patSize));
      }

      const cueBin = decomp(file.subarray(songOffset + patComp, songOffset + patComp + cueComp));
      const cues = [];
      if (fmtVer >= 2) {
        const stride = is64Channel ? CUE_SIZE_64 : CUE_SIZE;
        const chans = is64Channel ? MAX_VOICES : NUM_VOICES;
        const maxCues = is64Channel ? NUM_CUES_64 : NUM_CUES;
        const numCues = Math.min((cueBin.length / stride) | 0, maxCues);
        for (let c = 0; c < numCues; c++) {
          const words = new Uint16Array(MAX_VOICES).fill(CUE_EMPTY);
          for (let ch = 0; ch < chans; ch++) words[ch] = u16(cueBin, c * stride + ch * 2);
          cues.push(words);
        }
      } else {
        const numCues = (cueBin.length / CUE_SIZE_V1) | 0;
        for (let c = 0; c < numCues; c++) cues.push(v1CueToWords(cueBin, c * CUE_SIZE_V1));
      }

      songs.push({
        numVoices, numPats, bpm: bpmStored + 25, tickRate,
        tuningBaseNote, tuningFreq, globalFlags, globalVolume, mixingVolume,
        numCuesStored, surroundModel, patterns, cues,
      });
    }
  }

  // ── decoded views ──
  const ixmpSec = findSec("Ixmp");
  const ixmp = ixmpSec ? parseIxmpSection(ixmpSec.payload) : [];
  const pnamSec = findSec("PNam");
  const smetSec = findSec("sMet");
  const smstSec = findSec("sMst");
  // Mastering (item 178, §9.12) is one of the three Project-Data sections a
  // PLAYER has to honour, so it is decoded here rather than left to the editor:
  // it also rides on each song record, which is what makes a bare parsed file
  // enough for audio-system.loadDocument and the offline renderer.
  const mastering = smstSec ? parseMasteringSection(smstSec.payload) : {};
  for (let i = 0; i < songs.length; i++) songs[i].mastering = mastering[i] ?? null;
  const meta = {
    projectName: pnamSec ? strNul(pnamSec.payload, 0, pnamSec.payload.length).str : null,
    songMeta: smetSec ? parseSMetSection(smetSec.payload) : {},
    mastering,
  };

  return { kind, fmtVer, is64Channel, signature, sampleInstImage, songs, projSections, ixmp, meta };
}
