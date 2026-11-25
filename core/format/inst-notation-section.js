// `INtn` — the Project-Data section that gives an INSTRUMENT a notation of its
// own (item 374, TAUD_FILE_FORMAT.md §9.20). Display and note entry only,
// never playback: a player skips it.
//
// Instrument-scoped, so a `.tsii` bank carries it with its instruments. One
// 8-byte entry per instrument that says anything:
//
//   U16  instrument ID (bits 0…9; bits 10…15 RESERVED, 0)
//   U16  flags — bit 0 FOLLOW: the instrument has no notation of its own and
//        follows its lane's or the song's; an editor must not give it one of
//        its own choosing (Microtone gives a drum kit General MIDI drum names)
//        bits 1…15 RESERVED, 0
//   U16  notation index, as sMet's (§9.6; 65520…65535 name the `nota` slots)
//   U16  guard — CRC-16/CCITT-FALSE over the instrument's `INam` entry as its
//        bytes stand in the file
//
// The guard is what lets an editor that does not know this section carry it
// along: such an editor renumbers, deletes, imports over and renames
// instruments without moving the entries, and an entry whose guard no longer
// matches the name at its slot is ignored rather than spelling some other
// instrument's notes. A reader stops at an entry with a reserved bit set (it
// cannot know what that entry means), keeping the ones before it.

export const INTN_FOURCC = "INtn";
export const INTN_ENTRY = 8;
/** Flags bit 0: no notation of its own — it follows the lane or the song. */
export const INTN_FOLLOW = 0x0001;

const te = new TextEncoder();

/** The guard for an instrument whose stored (`INam`, escaped) name is `name`:
 *  CRC-16/CCITT-FALSE (poly $1021, init $FFFF, MSB first, no final XOR), as
 *  `IPit`'s guard (§9.18). */
export function instNotationGuard(name) {
  let crc = 0xffff;
  for (const b of te.encode(name ?? "")) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * The payload → Map(instrument id → {flags, notation, guard}). An entry with a
 * reserved bit set ends the walk; a second entry for one instrument is
 * ignored (the first stands).
 */
export function parseInstNotationSection(payload) {
  const out = new Map();
  if (!payload) return out;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let o = 0; o + INTN_ENTRY <= payload.length; o += INTN_ENTRY) {
    const id = dv.getUint16(o, true);
    const flags = dv.getUint16(o + 2, true);
    if ((id & ~0x3ff) !== 0 || (flags & ~INTN_FOLLOW) !== 0) break;
    if (out.has(id)) continue;
    out.set(id, { flags, notation: dv.getUint16(o + 4, true), guard: dv.getUint16(o + 6, true) });
  }
  return out;
}

/** Map(id → {flags, notation, guard}) → payload, ascending by id; null when
 *  the map is empty (the section is then dropped). */
export function buildInstNotationSection(map) {
  if (!map || map.size === 0) return null;
  const ids = [...map.keys()].sort((a, b) => a - b);
  const out = new Uint8Array(ids.length * INTN_ENTRY);
  const dv = new DataView(out.buffer);
  ids.forEach((id, i) => {
    const e = map.get(id);
    const o = i * INTN_ENTRY;
    dv.setUint16(o, id & 0x3ff, true);
    dv.setUint16(o + 2, e.flags & INTN_FOLLOW, true);
    dv.setUint16(o + 4, (e.notation ?? 0) & 0xffff, true);
    dv.setUint16(o + 6, e.guard & 0xffff, true);
  });
  return out;
}
