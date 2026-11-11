// 8-bit volume envelopes (file format §7.2, byte 14 bit 6).
//
// A volume-envelope node's value was 0…63 for as long as the record has
// existed; byte 14's bit 6 (INST_VOLENV8) says the record's volume envelopes —
// its own and its Ixmp patches' — hold 0…255 instead, the units every other
// volume in a format-3 song is written in. The bit is one-way in the editor:
// every instrument a format-3 project holds is converted when it arrives
// (Document.upgradeVolEnvelopes on open, bankmerge applyPlan on import), and
// nothing clears it. Banks and converters may still write 0…63 records; the
// engine plays both.
//
// Everything here is pure byte work over records and patch blobs, so the open
// path and the import path share one implementation.

import { TaudInst, INST_VOLENV8 } from "../../core/engine/inst.js";
import { widenVolume, narrowVolume } from "./upgrade.js";

export { INST_VOLENV8 };

/** Record offset of the volume envelope's 25 nodes (value, offset). */
const VOL_NODES = 21;

/** Full volume of a volume-envelope node in a record whose byte 14 is `b14`. */
export function volEnvMaxOf(b14) {
  return (b14 & INST_VOLENV8) !== 0 ? 255 : 63;
}

/** True when `record` has the byte map, and so a volume envelope: everything
 *  but a metainstrument with a table (layered, FM rack — §7.4). */
function hasVolEnvelope(record) {
  const inst = new TaudInst(0);
  inst.loadRecord(record);
  return !inst.isMeta;
}

/**
 * `record` with its volume envelope in 8-bit units and the bit set, or the
 * SAME array when there is nothing to do (already 8-bit, or a table
 * metainstrument). Every node is converted, present or not: a record that turns
 * its envelope on later must find it in the units the bit claims.
 */
export function widenRecordVolEnv(record) {
  if ((record[14] & INST_VOLENV8) !== 0 || !hasVolEnvelope(record)) return record;
  const out = Uint8Array.from(record);
  for (let k = 0; k < 25; k++) out[VOL_NODES + 2 * k] = widenVolume(out[VOL_NODES + 2 * k]);
  out[14] |= INST_VOLENV8;
  return out;
}

/** Walk a patch blob (the layout parsePatchesBlob reads) and hand each volume
 *  envelope's first node offset to `fn`. */
function eachPatchVolEnv(blob, fn) {
  let o = 0;
  while (o + 31 <= blob.length) {
    const ver = blob[o];
    let p = o + 31;
    if ((ver & 0x80) !== 0) p += 15;                 // 'x' block
    if ((ver & 0x02) !== 0) {
      if (p + 54 > blob.length) return;
      fn(p + 4);                                      // after LOOP + SUSTAIN words
    }
    for (const bit of [0x02, 0x04, 0x08, 0x10]) if ((ver & bit) !== 0) p += 54;
    if ((ver & 0x20) !== 0) {                         // 's' block, last
      if (p + 4 > blob.length) return;
      p += 4 + 4 * ((blob[p] >>> 4) & 0x0f);
    }
    if (p > blob.length) return;
    o = p;
  }
}

/** An Ixmp patch blob with every patch's volume envelope widened to 8 bits;
 *  the SAME array when no patch has one. Only for an instrument that was 6-bit. */
export function widenPatchesBlobVolEnv(blob) {
  if (blob === null) return blob;
  let out = blob;
  eachPatchVolEnv(blob, (at) => {
    if (out === blob) out = Uint8Array.from(blob);
    for (let k = 0; k < 25; k++) out[at + 2 * k] = widenVolume(out[at + 2 * k]);
  });
  return out;
}

/**
 * An instrument arriving in a format-3 project: its record and its patch blob
 * (or null), both in 8-bit units. The patches follow the record — they are in
 * its units — so a record already 8-bit leaves the blob alone.
 */
export function widenInstrumentVolEnv(record, blob) {
  const rec = widenRecordVolEnv(record);
  if (rec === record) return { record, blob };
  return { record: rec, blob: widenPatchesBlobVolEnv(blob) };
}

/** A node value back in 0…63 — for a format that has only those (MOD, IT). */
export function volEnvValue63(value, eightBit) {
  return eightBit ? narrowVolume(value) : Math.min(63, value);
}

/** A level on the 0…63 scale (fractions welcome) as a node value of an
 *  envelope whose full volume is `max`, rounded once. */
export function volEnvFrom63(v, max) {
  const c = Math.max(0, Math.min(63, Number(v) || 0));
  return max === 255 ? Math.round((c * 255) / 63) : Math.round(c);
}
