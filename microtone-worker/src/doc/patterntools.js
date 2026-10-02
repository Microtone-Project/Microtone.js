// Pure byte-level pattern transforms. Every one of them works on a whole
// pattern IMAGE and therefore has to know which cell layout that image is in
// (file format §5.5): 64 rows × 8-byte cells (512 bytes) in format version 2,
// 64 rows × 16-byte cells (1024 bytes) in version 3. Callers pass `wide` — the
// document's own `wideCells` flag — and a v2 image transforms exactly as it
// always did.
//
// "Empty" cells follow the converter convention: the volume and panning columns
// carry the FINE-with-0 no-op sentinel, which is vol/pan bytes 0xC0 in the
// narrow cell and 0x33 in the wide cell's shared selector byte — all-zero
// columns would be real "set volume 0" commands, not blanks.

import { PATTERN_SIZE, PATTERN_SIZE_WIDE } from "../../core/format/taud-const.js";

/** Cell stride in bytes for a format. */
export function cellStride(wide) { return wide ? 16 : 8; }

// The selector value that means "one-shot fine delta"; with a zero argument it
// is the no-op sentinel every transform below skips.
const SEL_FINE = 3;

// ── column accessors (file format §5.5) ──
// The 8-byte cell packs a 2-bit selector above a 6-bit value in one byte. The
// 16-byte cell gives volume a whole byte and the panning column a NINE-bit
// azimuth (low byte at +4, bit 8 in the top bit of the shared selector byte
// +8), with both selectors in that byte 8 — so reading a column is not a mask
// on one byte there, and writing one must leave the rest of byte 8 alone.
//
// Exported because Find & Change (doc/patternquery.js) addresses the same
// columns by name: two files working out where the volume lives is how the two
// end up disagreeing about it, so this is the one place that knows.

export function readVol(b, o, wide) {
  return wide
    ? { value: b[o + 3], sel: (b[o + 8] >>> 4) & 3 }
    : { value: b[o + 3] & 0x3f, sel: (b[o + 3] >>> 6) & 3 };
}

export function writeVol(b, o, wide, value) {
  if (wide) b[o + 3] = value & 0xff;
  else b[o + 3] = (b[o + 3] & 0xc0) | (value & 0x3f);
}

/** Volume SELECTOR only, leaving the value (and the rest of byte 8) alone. */
export function writeVolSel(b, o, wide, sel) {
  if (wide) b[o + 8] = ((b[o + 8] & ~0x70) & 0xff) | ((sel & 7) << 4);
  else b[o + 3] = (b[o + 3] & 0x3f) | ((sel & 3) << 6);
}

export function readPan(b, o, wide) {
  return wide
    ? { value: b[o + 4] | ((b[o + 8] & 0x80) << 1), sel: b[o + 8] & 3 }
    : { value: b[o + 4] & 0x3f, sel: (b[o + 4] >>> 6) & 3 };
}

export function writePan(b, o, wide, value) {
  if (wide) {
    b[o + 4] = value & 0xff;
    b[o + 8] = (b[o + 8] & 0x7f) | (((value >>> 8) & 1) << 7);
  } else {
    b[o + 4] = (b[o + 4] & 0xc0) | (value & 0x3f);
  }
}

/** Panning SELECTOR only — the wide cell's low nibble of byte 8, the narrow
 *  cell's top two bits of byte 4. */
export function writePanSel(b, o, wide, sel) {
  if (wide) b[o + 8] = ((b[o + 8] & ~0x0f) & 0xff) | (sel & 0xf);
  else b[o + 4] = (b[o + 4] & 0x3f) | ((sel & 3) << 6);
}

/** Elevation (wide cell only, byte 9): a SIGNED byte, −128…127. */
export function readElev(b, o, wide) {
  if (!wide) return 0;
  const v = b[o + 9];
  return v >= 0x80 ? v - 0x100 : v;
}

export function writeElev(b, o, wide, value) {
  if (wide) b[o + 9] = value & 0xff;
}

/** A fully empty pattern image (the newProject/converter blank-cell shape). */
export function emptyPatternBytes(wide = false) {
  // "Empty" is FINE-by-zero in both columns, whatever the cell's width — in the
  // 8-byte cell that is 0xC0 in each column byte, in the wide cell it is 0x33
  // in the shared selector byte (file format §5.5).
  if (wide) {
    const bytes = new Uint8Array(PATTERN_SIZE_WIDE);
    for (let r = 0; r < 64; r++) bytes[r * 16 + 8] = 0x33;
    return bytes;
  }
  const bytes = new Uint8Array(PATTERN_SIZE);
  for (let r = 0; r < 64; r++) {
    bytes[r * 8 + 3] = 0xc0;
    bytes[r * 8 + 4] = 0xc0;
  }
  return bytes;
}

/** Lengthen ×n: row r → row n·r with blanks between, rows past 63 pushed out
 *  (the Impulse Tracker Alt-F "expand pattern" behaviour, generalised from the
 *  fixed ×2 to any integer factor ≥ 1). */
export function expandPatternBytes(src, factor = 2, wide = false) {
  const n = Math.max(1, factor | 0);
  const w = cellStride(wide);
  const out = emptyPatternBytes(wide);
  for (let r = 0; r * n <= 63; r++) out.set(src.subarray(r * w, r * w + w), r * n * w);
  return out;
}

/** Shorten ÷n: row n·r → row r, the rows between dropped, the tail left blank
 *  (the Impulse Tracker Alt-G "shrink pattern" behaviour, generalised from the
 *  fixed ÷2 to any integer factor ≥ 1). */
export function shrinkPatternBytes(src, factor = 2, wide = false) {
  const n = Math.max(1, factor | 0);
  const w = cellStride(wide);
  const out = emptyPatternBytes(wide);
  for (let r = 0; r * n <= 63; r++) out.set(src.subarray(r * n * w, r * n * w + w), r * w);
  return out;
}

const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ── the three column operations, on ONE cell ──
// These are the whole of the maths; the whole-pattern functions below are loops
// over them, and the editor's block tools (ui/blocktools.js) call them on a
// list of cells that may span several patterns. Keeping one core is what stops
// "Volume… from the toolbar" and "Volume… from the right-click menu" drifting
// apart. Each mutates `buf` in place at cell offset `off`.

/** Volume column: v → clamp(round(v·mult + add)) over the column's own range.
 *  Skips the FINE-with-0 no-op sentinel, so an empty cell is left empty — this
 *  amplifies existing volumes, it does not stamp volume onto cells that carry
 *  none. Returns true when it changed anything. */
export function scaleVolumeAt(buf, off, wide, mult, add) {
  const { value, sel } = readVol(buf, off, wide);
  if (sel === SEL_FINE && value === 0) return false;
  writeVol(buf, off, wide, clampInt(Math.round(value * mult + add), 0, wide ? 0xff : 0x3f));
  return true;
}

/**
 * Panning column: widen/narrow by signed `mult` about centre, then shift by
 * `add`. mult>1 widens, 0<mult<1 narrows, mult<0 swaps L/R. Skips the pan
 * no-op sentinel.
 *
 * The two formats differ in what the column IS, so they differ at the ends.
 * The narrow column is a front ARC (0 left … 3F right, centre 20) and CLAMPS —
 * there is nothing past hard left there. The wide column is an ANGLE on the
 * full circle (512 units per turn, 0 left, 128 front, 256 right) and WRAPS:
 * hard left is not a boundary on a circle, just a direction, and clamping
 * would pile widened sources up on it instead of carrying them round behind
 * the listener, which is where widening past hard left actually points.
 */
export function transformPanAt(buf, off, wide, mult, add) {
  const { value, sel } = readPan(buf, off, wide);
  if (sel === SEL_FINE && value === 0) return false;
  const centre = wide ? 128 : 32;
  const moved = Math.round(centre + (value - centre) * mult + add);
  writePan(buf, off, wide, wide ? ((moved % 512) + 512) % 512 : clampInt(moved, 0, 0x3f));
  return true;
}

/** Instrument byte: from===null → every non-empty instrument becomes `to`;
 *  otherwise only cells whose instrument === from. */
export function changeInstrumentAt(buf, off, wide, from, to) {
  const o = off + 2, cur = buf[o];
  if (from === null ? cur === 0 : cur !== (from & 0xff)) return false;
  buf[o] = to & 0xff;
  return true;
}

/** Scale/offset every SET volume value: v → clamp(round(v·mult + add)), over
 *  the column's own range — 0..63 in the narrow cell, 0..255 in the wide one,
 *  where the volume column is a whole byte. The effect selector is kept, and
 *  the no-op sentinel (FINE with 0) and thus every empty cell are skipped —
 *  this amplifies existing volumes, it does not stamp volume onto cells that
 *  carry none. `rows` limits the span (a [r0,r1] inclusive pair) — omit for the
 *  whole pattern. */
export function scaleVolumeBytes(src, mult, add, rows = null, wide = false) {
  const out = Uint8Array.from(src);
  const w = cellStride(wide);
  const [r0, r1] = rows ?? [0, 63];
  for (let r = r0; r <= r1; r++) scaleVolumeAt(out, r * w, wide, mult, add);
  return out;
}

/**
 * Pan transform: widen/narrow by signed `mult` about centre, then shift by
 * `add`. mult>1 widens, 0<mult<1 narrows, mult<0 swaps L/R. Skips the pan
 * no-op sentinel (FINE with 0).
 *
 * The two formats differ in what the column IS, so they differ at the ends.
 * The narrow column is a front ARC (0 left … 3F right, centre 20) and CLAMPS —
 * there is nothing past hard left there. The wide column is an ANGLE on the
 * full circle (512 units per turn, 0 left, 128 front, 256 right) and WRAPS:
 * hard left is not a boundary on a circle, just a direction, and clamping
 * would pile widened sources up on it instead of carrying them round behind
 * the listener, which is where widening past hard left actually points.
 */
export function transformPanBytes(src, mult, add, rows = null, wide = false) {
  const out = Uint8Array.from(src);
  const w = cellStride(wide);
  const [r0, r1] = rows ?? [0, 63];
  for (let r = r0; r <= r1; r++) transformPanAt(out, r * w, wide, mult, add);
  return out;
}

/** Remap the instrument byte: from===null → change every non-empty inst to
 *  `to`; otherwise only cells whose inst === from. */
export function changeInstrumentBytes(src, from, to, rows = null, wide = false) {
  const out = Uint8Array.from(src);
  const w = cellStride(wide);
  const [r0, r1] = rows ?? [0, 63];
  for (let r = r0; r <= r1; r++) changeInstrumentAt(out, r * w, wide, from, to);
  return out;
}
