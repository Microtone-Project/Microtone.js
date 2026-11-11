// The volume axis of an instrument's gating rectangles — a metainstrument
// layer's or FM operator's range, and an Ixmp patch's — in the units a note's
// volume is written in.
//
// The record keeps it six-bit: instrument data is format-neutral (file format
// §5.5), so one bank loads into any project. A format-3 song's volume is
// 0…255, and the engine gates it by `v >> 2` (trigger.js narrowVolAxis), so a
// stored value k answers the volumes 4k…4k+3. The low bound of a range
// therefore reads 4k and the high bound 4k+3 (63 → 255): showing anything else
// would claim a gate the engine does not apply.

export const VEL_SHOWN_MAX = 0xff;

/** Stored 0…63 → the volume a bound reads: its step's first (low) or last (high). */
export function velShown(v, high) {
  const k = Math.max(0, Math.min(0x3f, v | 0));
  return high ? (k << 2) | 3 : k << 2;
}

/** A typed 0…255 volume → the record's 0…63: the step that volume falls in,
 *  so the volume typed is always one the range answers. */
export function velStored(shown) {
  const w = Math.round(Number(shown));
  return Number.isFinite(w) ? Math.max(0, Math.min(VEL_SHOWN_MAX, w)) >> 2 : 0;
}

/** A range as text, `lo‥hi`, in shown units. */
export function velRangeText(lo, hi) {
  return `${velShown(lo, false)}‥${velShown(hi, true)}`;
}
