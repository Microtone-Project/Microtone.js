// The `IPit` section (file format §9.18): the instruments' pitch extensions.
// Reading it is the engine's (core/engine/inst.js parsePitchExtSection,
// applyPitchExt); this is the WRITING half, for whatever authors one — and the
// arithmetic between a pitch and the two places it is stored.
//
// A pitch field of an instrument is sixteen bits: 4096 steps to the octave,
// sixteen octaves. The section gives a field one more byte, `oooo ffff` — four
// more bits of fraction below it, four more bits of octave above it (a two's-
// complement nibble) — so a pitch is a signed 8.16 number: 65536 steps to the
// octave, 256 octaves.

import {
  IPIT_BASE, IPIT_TABLE, IPIT_PATCHES, pitchExtGuard, pitchExtDelta, pitchExtDeltaHigh,
} from "../engine/inst.js";

export const IPIT_FOURCC = "IPit";

/**
 * A pitch, in the engine's 4096-TET units (on the sixteenth-of-a-unit grid:
 * anything finer is rounded to it), as the sixteen-bit field and the extension
 * byte that together hold it.
 *
 *   signed  the field is a signed offset (a detune, an operator's ratio);
 *           otherwise it is a note word (a range's low bound, a fixed pitch,
 *           the pitch-pan centre).
 *   high    the field is a range's HIGH bound and `value` is the last pitch
 *           inside it: its fraction is stored complemented, so that a zero
 *           byte leaves the bound covering the whole of its last unit.
 *
 * Throws when the pitch is outside what 24 bits hold.
 */
export function splitPitch(value, { signed = false, high = false } = {}) {
  const v = Math.round(value * 16); // 65536-TET units
  const half = signed ? 0x80000 : 0;
  const o = Math.floor((v + half) / 0x100000);
  if (o < -8 || o > 7) throw new RangeError(`pitch ${value} is outside the extension's 256 octaves`);
  const rem = v - o * 0x100000;      // unsigned: 0 … 2^20 − 1; signed: −2^19 … 2^19 − 1
  const field = Math.floor(rem / 16);
  const fine = rem - field * 16;
  return { field: field & 0xffff, ext: ((o & 15) << 4) | (high ? 15 - fine : fine) };
}

/** The pitch a field and its extension byte hold, in 4096-TET units — the
 *  inverse of splitPitch (for a high bound: the last pitch inside it). */
export function joinPitch(field, ext, { signed = false, high = false } = {}) {
  const f = signed && field >= 0x8000 ? field - 0x10000 : field;
  return high ? f + 1 + pitchExtDeltaHigh(ext) - 1 / 16 : f + pitchExtDelta(ext);
}

/**
 * One instrument's entry, from the instrument as it stands (a TaudInst with
 * its record and patches loaded) and the extension bytes to give it:
 *
 *   base     [sampleDetune, pitchPanCentre, kind's own field]   (3 bytes)
 *   table    3 bytes per entry of the record: detune, range low, range high
 *   patches  3 bytes per Ixmp patch, in list order: range start, range end, detune
 *
 * A group left out (or all zeroes) is not written; with nothing to write the
 * result is null. The guard is computed here, over the instrument's sixteen-
 * bit fields as they are NOW — so build the entry after the last edit.
 */
export function pitchExtEntry(inst, { base = null, table = null, patches = null } = {}) {
  const any = (a) => a !== null && a !== undefined && Array.prototype.some.call(a, (b) => b !== 0);
  const has = { base: any(base), table: any(table), patches: any(patches) };
  if (!has.base && !has.table && !has.patches) return null;
  if (has.base && base.length !== 3) throw new RangeError("IPit: a base group is three bytes");
  if (has.table && table.length !== inst.metaEntryCount * 3) throw new RangeError("IPit: the table group has three bytes per entry of the record");
  if (has.patches && patches.length !== (inst.extraPatches?.length ?? 0) * 3) throw new RangeError("IPit: the patch group has three bytes per patch");
  const guard = pitchExtGuard(inst, has);
  if (guard === null) throw new RangeError("IPit: a group that is not about this kind of instrument");
  return {
    instId: inst.index & 0x3ff,
    flags: (has.base ? IPIT_BASE : 0) | (has.table ? IPIT_TABLE : 0) | (has.patches ? IPIT_PATCHES : 0),
    guard,
    base: has.base ? Uint8Array.from(base) : null,
    table: has.table ? Uint8Array.from(table) : null,
    patches: has.patches ? Uint8Array.from(patches) : null,
  };
}

/** The section payload for these entries (pitchExtEntry's, or a parsed
 *  section's with `instId` added), or null when there are none to write. */
export function buildPitchExtSection(entries) {
  const list = (entries ?? []).filter((e) => e !== null && e !== undefined);
  if (list.length === 0) return null;
  const out = [];
  for (const e of list) {
    out.push(e.instId & 0xff, ((e.instId >>> 8) & 0x03) | (e.flags & 0x1c), e.guard & 0xff, (e.guard >>> 8) & 0xff);
    if ((e.flags & IPIT_BASE) !== 0) out.push(...e.base);
    if ((e.flags & IPIT_TABLE) !== 0) out.push(e.table.length / 3, ...e.table);
    if ((e.flags & IPIT_PATCHES) !== 0) {
      const n = e.patches.length / 3;
      out.push(n & 0xff, (n >>> 8) & 0xff, ...e.patches);
    }
  }
  return Uint8Array.from(out);
}
