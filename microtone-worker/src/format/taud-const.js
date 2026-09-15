// Taud container format constants — mirror of taud.mjs:9-71 (LibTaud) and
// terranmon.txt §"Taud serialisation format".

export const TAUD_MAGIC = Uint8Array.from([0x1f, 0x54, 0x53, 0x56, 0x4d, 0x61, 0x75, 0x64]); // \x1FTSVMaud
export const PROJ_MAGIC = Uint8Array.from([0x1e, 0x54, 0x61, 0x75, 0x64, 0x50, 0x72, 0x4a]); // \x1ETaudPrJ

// Version byte layout: 0b kk x vvvvv
//   vvvvv: format version (1 = legacy cues, 2 = extended cue sheet)
//   x (0x20): Project Data carries an xHDR section (64-channel flag)
//   kk: container kind
export const TAUD_VERSION = 2;
export const TAUD_VERSION_MASK = 0x1f;
export const TAUD_XHDR_FLAG = 0x20;
export const TAUD_KIND_MASK = 0xc0;
export const TAUD_KIND_FULL = 0x00;
export const TAUD_KIND_SAMPLEINST = 0x80; // .tsii
export const TAUD_KIND_PATTERN = 0xc0;    // .tpif

export const TAUD_HEADER_SIZE = 32; // magic(8) + version(1) + numSongs(1) + compSize(4) + projOff(4) + sig(14)
export const TAUD_SONG_ENTRY = 32;

// Sample+instrument image: 8 MB sample pool + 256 K instrument bin.
export const SAMPLEBIN_SIZE = 8388608;
export const INSTBIN_SIZE = 262144; // 1024 inst × 256 bytes
export const SAMPLEINST_SIZE = SAMPLEBIN_SIZE + INSTBIN_SIZE; // 8650752
export const INST_RECORD_SIZE = 256;
export const NUM_INSTRUMENTS = 1024;

export const PATTERN_SIZE = 512; // 64 rows × 8 bytes (format versions 1-2)
/** Format version 3's wide cell: 64 rows × 16 bytes. */
export const PATTERN_SIZE_WIDE = 1024;
/** The version whose pattern cell is 16 bytes wide (surround songs only). */
export const TAUD_VERSION_WIDE = 3;
/** Bytes per pattern image for a format version. */
export function patternSizeFor(fmtVer) {
  return fmtVer >= TAUD_VERSION_WIDE ? PATTERN_SIZE_WIDE : PATTERN_SIZE;
}
export const NUM_PATTERNS_MAX = 0x7fff;

// Cue sheet (v2): 32×Sint16 = 64 bytes; 64-channel mode: 64×Sint16 = 128 bytes.
export const NUM_VOICES = 32;
export const MAX_VOICES = 64;
export const CUE_SIZE = 64;
export const CUE_SIZE_64 = 128;
export const NUM_CUES = 8192;
export const NUM_CUES_64 = 4096;
export const CUE_EMPTY = 0x7fff;

// Legacy v1 cue sheet.
export const CUE_SIZE_V1 = 32;
export const NUM_VOICES_V1 = 20;
export const CUE_EMPTY_V1 = 0xfff;

export const CAPTURE_SIGNATURE = "Microtone.js  "; // 14 bytes, space-padded

// Project-Data section holding the song's own keyboard layout (§9.13): one
// .taudkey document, UTF-8, exactly as an export writes it. Project scope, so
// it stays with the .taud and never splits out into a .tsii bank.
export const KEYMAP_FOURCC = "PKey";

// Ixmp variable-length patch record: version byte (0b x0sPfpvi) + 30 common
// bytes + optional blocks, always in on-wire order x, v, p, f, P, s.
// (taud.mjs:340-345, terranmon.txt:3502-3508)
//
// The 's' (multi-channel) block is the ONLY one whose size is not fixed by the
// version byte — it carries one u32 sample pointer per EXTRA channel — so the
// length walk needs the bytes, not just the version. It is emitted last, which
// keeps every earlier block at the offset a pre-stereo reader expects.

/** Bytes of an 's' block whose channel byte is `chanByte` (0b cccc mmmm). */
export function ixmpChanBlockLen(chanByte) {
  return 4 + 4 * ((chanByte & 0xff) >>> 4); // count/mode u8 + u24 flags + u32 per extra channel
}

/** Offset of a patch's 's' channel byte relative to the record start, or -1
 *  when the record carries no 's' block. */
export function ixmpChanByteOffset(ver) {
  if ((ver & 0x20) === 0) return -1;
  return (
    31 +
    ((ver & 0x80) ? 15 : 0) + // x: u32 flags1 + u32 flags2 + u16 fadeout + u16 cutoff + u16 reson + u8 atten
    ((ver & 0x02) ? 54 : 0) + // v: volume envelope
    ((ver & 0x04) ? 54 : 0) + // p: panning envelope
    ((ver & 0x08) ? 54 : 0) + // f: filter envelope
    ((ver & 0x10) ? 54 : 0)   // P: pitch envelope
  );
}

/** Channels a patch record at `bytes[o]` plays (1 when it carries no 's' block). */
export function ixmpChanCount(bytes, o = 0) {
  const so = ixmpChanByteOffset(bytes[o] & 0xff);
  return so < 0 ? 1 : ((bytes[o + so] ?? 0) >>> 4) + 1;
}

/** Total bytes of the patch record starting at `bytes[o]`. */
export function ixmpPatchLen(bytes, o = 0) {
  const ver = bytes[o] & 0xff;
  const so = ixmpChanByteOffset(ver);
  if (so < 0) {
    return (
      31 +
      ((ver & 0x80) ? 15 : 0) +
      ((ver & 0x02) ? 54 : 0) +
      ((ver & 0x04) ? 54 : 0) +
      ((ver & 0x08) ? 54 : 0) +
      ((ver & 0x10) ? 54 : 0)
    );
  }
  return so + ixmpChanBlockLen(bytes[o + so] ?? 0);
}
