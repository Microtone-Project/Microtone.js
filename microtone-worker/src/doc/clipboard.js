// Block clipboard for the pattern grids (Timeline + Pattern views). A block is
// a rectangular region of cells captured as raw 8-byte images (row-major); the
// same shape serves both views — the Pattern view is just a 1-channel block.
// Cross-view paste clips the block to whatever the destination can hold.
//
// "Empty" cells follow the converter convention: vol/pan bytes 0xC0
// (SEL_FINE-0 no-ops), everything else zero — NOT all-zero (that is a real
// "set volume 0" command). Overwrite-paste of an empty source cell therefore
// blanks the destination, which is the standard tracker paste semantic.

/** Bytes per cell for a block: format version 3's cell is twice as wide. */
export function cellSize(wide) { return wide ? 16 : 8; }

/** Blank-cell image — FINE-by-zero in both columns, whichever the format. */
export function emptyCellBytes(wide = false) {
  const b = new Uint8Array(cellSize(wide));
  if (wide) {
    b[8] = 0x33; // both selectors FINE, values zero (file format §5.5)
  } else {
    b[3] = 0xc0;
    b[4] = 0xc0;
  }
  return b;
}

/** Serialise a TaudPlayData cell to its raw bytes, in the format's layout. */
export function cellToBytes(cell, wide = false) {
  const n = cellSize(wide);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = wide ? cell.getByteWide(i) : cell.getByte(i);
  return b;
}

/** Allocate a rows×chans block pre-filled with blank cells. */
export function makeBlock(rows, chans, wide = false) {
  const n = cellSize(wide);
  const cells = new Uint8Array(rows * chans * n);
  const empty = emptyCellBytes(wide);
  for (let i = 0; i < rows * chans; i++) cells.set(empty, i * n);
  return { rows, chans, wide, cells };
}

/** Mutable view of block cell (r, c). */
export function blockCell(block, r, c) {
  const n = cellSize(block.wide === true);
  const off = (r * block.chans + c) * n;
  return block.cells.subarray(off, off + n);
}

// ── Cue-block clipboard (Cues view) ──
// A cue block is a rows×chans grid of 16-bit words cut from the Cues grid, in
// ONE of its two spaces — never both, because the two do not hold the same kind
// of thing and a rectangle straddling the boundary would mean nothing:
//
//   PATTERN blocks (`cmd` false): the columns are CHANNELS and each word is a
//     pattern index (low 15 bits). The per-cue command sign bits are NOT
//     carried: they are bit-packed across the channels of one cue, so a
//     rectangular copy that moves channels around would scramble them. Paste
//     therefore preserves each destination cell's own command bit and overlays
//     only the pasted pattern index.
//
//   COMMAND blocks (`cmd` true): the columns are the two Cmd word SLOTS — at
//     most two of them — and each word is a whole instruction (LEN/HALT/BAK/
//     FWD/JMP as the engine decodes it). Pasting one rewrites the sign bits of
//     channels 0-15 / 16-31 and leaves every pattern index alone, which is the
//     exact mirror of the above.
//
// `chans` is the block's column count either way; on a command block it counts
// Cmd slots rather than voices.
import { CUE_EMPTY } from "../format/taud-const.js";

/** Allocate a rows×chans cue block pre-filled with "nothing here": an empty
 *  pattern index, or — for a command block — the NOP instruction word. */
export function makeCueBlock(rows, chans, cmd = false) {
  return {
    rows, chans, cmd,
    words: new Uint16Array(rows * chans).fill(cmd ? 0 : CUE_EMPTY),
  };
}

/** Flat index of cue-block cell (r, c) into block.words (row-major). */
export function cueBlockIndex(block, r, c) { return r * block.chans + c; }

/** Merge a copied pattern word onto a destination cue word, keeping the
 *  destination's command sign bit (bit 15) intact. */
export function mergeCueWord(destWord, srcWord) {
  return (destWord & 0x8000) | (srcWord & 0x7fff);
}

// Byte offsets per logical column, as [offset, mask] pairs (duplicated from
// edit.js so this pure module stays DOM/UI-free): note / inst / vol / pan / fx /
// fx2. The wide cell needs the masks — its byte 8 carries BOTH column selectors
// and the azimuth's ninth bit, so a per-column paste works in bits there.
// The 8-byte cell has no second effect, so its COL_FX2 entry claims no bytes and
// naming that column there does nothing at all.
const COL_BYTE_MASKS = [[[0, 0xff], [1, 0xff]], [[2, 0xff]], [[3, 0xff]], [[4, 0xff]],
  [[5, 0xff], [6, 0xff], [7, 0xff]], []];
const COL_BYTE_MASKS_WIDE = [
  [[0, 0xff], [1, 0xff]],
  [[2, 0xff]],
  [[3, 0xff], [8, 0x70]],
  [[4, 0xff], [9, 0xff], [8, 0x8f]],
  [[5, 0xff], [6, 0xff], [7, 0xff]],
  [[10, 0xff], [11, 0xff], [12, 0xff]],
];

// ── the two effect columns are interchangeable (item 127) ──
// Effect 1 and effect 2 are the SAME column twice over — same opcode, same
// 16-bit argument, differing only in which runs first — so a block cut from one
// has to be pastable into the other. The clipboard therefore treats a block
// covering exactly ONE effect column as slot-agnostic: it lands in whichever
// effect column the caret is standing on, and only the byte offsets differ.
// (Column ids duplicated from edit.js, like the mask tables above, so this
// module stays DOM/UI-free.)
const COL_FX = 4, COL_FX2 = 5;
/** First byte of each effect column in a wide cell (§5.5). */
const FX_SLOT_BYTE = { [COL_FX]: 5, [COL_FX2]: 10 };

/**
 * The slot move a paste needs, or null for "paste where it came from".
 *
 * `targetCol` is the column the CARET is on — not the block's own, and not the
 * selection's: the caret is the one part of this the user is holding, so it is
 * what picks the slot, and it stays put across a paste so repeating one goes to
 * the same place. Everything else (a multi-column block, a non-effect target, a
 * cell with no second effect to speak of) is left exactly as it was.
 */
export function fxPasteRemap(blockCols, targetCol, wide) {
  if (!blockCols || blockCols.length !== 1) return null;
  const from = blockCols[0];
  if (!(from in FX_SLOT_BYTE) || !(targetCol in FX_SLOT_BYTE)) return null;
  if (from === targetCol) return null;
  // Only a wide cell HAS a second slot to receive one. The other direction
  // needs no such guard: a second effect carries nothing a version-2 effect
  // column cannot hold, so it pastes into one as happily as into a v3 one.
  if (targetCol === COL_FX2 && !wide) return null;
  return { from, to: targetCol };
}

/**
 * A block cell's bytes with its effect slot moved per `remap`, sized for the
 * DESTINATION cell so `overlayCols` can read the target offsets — a block
 * copied from a narrow project is only 8 bytes and has no byte 10 to read.
 * Returns `cellBytes` untouched when there is nothing to move.
 */
export function remapFxBytes(cellBytes, remap, wide = true) {
  if (!remap) return cellBytes;
  const out = new Uint8Array(cellSize(wide));
  out.set(cellBytes.subarray(0, Math.min(cellBytes.length, out.length)));
  const from = FX_SLOT_BYTE[remap.from], to = FX_SLOT_BYTE[remap.to];
  for (let i = 0; i < 3; i++) out[to + i] = cellBytes[from + i] ?? 0;
  return out;
}

/** Overlay only `cols` (logical column ids) of `src` onto `dest` (same format);
 *  returns `dest`. Columns outside the set keep dest's bytes — this is what
 *  makes a partial-column paste leave the other columns unaffected, and what
 *  keeps a HIDDEN second effect intact when a block is pasted over it. */
export function overlayCols(dest, src, cols, wide = false) {
  const table = wide ? COL_BYTE_MASKS_WIDE : COL_BYTE_MASKS;
  for (const col of cols) {
    for (const [b, mask] of table[col] ?? []) {
      dest[b] = (dest[b] & ~mask & 0xff) | (src[b] & mask);
    }
  }
  return dest;
}
