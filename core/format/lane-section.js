// `sLan` — the Project-Data section that carries a song's per-LANE settings
// (TAUD_FILE_FORMAT.md §9.19). Editor state, never playback: a player skips it.
//
// Song-scoped like `sMet` and `sMst` (an index, a length, then a body), and the
// body is a table of fixed-size LANE RECORDS whose size and count it states
// itself — so a later version can give every lane more fields (a wider
// stride) or the song more lanes (up to 256) without this reader misreading
// either: a field past the stride it was given reads as 0, a lane past the
// count reads as all zero, and bytes this version does not know are kept
// verbatim through an edit of the ones it does.
//
// Record layout (byte 0 is the only one defined so far):
//   byte 0  flags — bit 0: the second effect column is shown on this lane
//   bytes 1…stride−1  RESERVED, 0

export const LANE_FOURCC = "sLan";
/** Lanes a song can describe — the format's ceiling, not today's 32/64. */
export const LANE_MAX = 256;
/** Bytes per lane record this writer emits (the reader takes any ≥ 1). */
export const LANE_STRIDE = 16;

/** Byte 0, bit 0: show the second effect column on this lane. */
export const LANE_FLAG_FX2 = 0x01;

/**
 * Decode the section into Map<songIndex, {count, stride, bytes}>, `bytes`
 * being `count × stride` long. An entry that cannot be read whole ends the
 * walk (what it held is lost, the rest of the file is not).
 */
export function parseLaneSection(payload) {
  const out = new Map();
  if (!payload) return out;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let o = 0;
  while (o + 5 <= payload.length) {
    const song = payload[o];
    const size = dv.getUint32(o + 1, true);
    const body = o + 5;
    if (size < 4 || body + size > payload.length) break;
    const count = Math.min(dv.getUint16(body, true), LANE_MAX);
    const stride = dv.getUint16(body + 2, true);
    const avail = size - 4;
    if (stride >= 1 && count * stride <= avail) {
      out.set(song, { count, stride, bytes: payload.slice(body + 4, body + 4 + count * stride) });
    }
    o = body + size;
  }
  return out;
}

/** Encode Map<songIndex, {count, stride, bytes}>; null when nothing is left
 *  to say (every entry empty), so the section can be dropped. */
export function buildLaneSection(entries) {
  const songs = [...entries.keys()].filter((k) => !laneEntryEmpty(entries.get(k))).sort((a, b) => a - b);
  if (songs.length === 0) return null;
  let len = 0;
  for (const s of songs) len += 5 + 4 + entries.get(s).bytes.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const s of songs) {
    const e = entries.get(s);
    out[o] = s & 0xff;
    dv.setUint32(o + 1, 4 + e.bytes.length, true);
    dv.setUint16(o + 5, e.count, true);
    dv.setUint16(o + 7, e.stride, true);
    out.set(e.bytes, o + 9);
    o += 9 + e.bytes.length;
  }
  return out;
}

export function laneEntryEmpty(e) {
  return !e || e.bytes.every((b) => b === 0);
}

/** A record's byte `field` of lane `lane` (0 past the stride or the count). */
export function laneByte(e, lane, field = 0) {
  if (!e || lane < 0 || lane >= e.count || field >= e.stride) return 0;
  return e.bytes[lane * e.stride + field];
}

/**
 * The entry grown to hold lane `lane` (and at least `minCount` lanes) at this
 * writer's stride, existing bytes kept — a wider stride from a newer writer is
 * kept as it is. Returns a NEW entry; the old one is not touched.
 */
export function laneEntryFor(e, lane, minCount = 0) {
  const stride = Math.max(e?.stride ?? 0, LANE_STRIDE);
  const count = Math.min(Math.max(e?.count ?? 0, lane + 1, minCount), LANE_MAX);
  const bytes = new Uint8Array(count * stride);
  if (e) {
    for (let l = 0; l < e.count; l++) {
      bytes.set(e.bytes.subarray(l * e.stride, (l + 1) * e.stride), l * stride);
    }
  }
  return { count, stride, bytes };
}
