// Sample-pool regions (item 175) — the `SRgn` Project-Data section, §9.11.
//
// THE PREMISE: a Taud instrument's `sampleLength` is a U16, so no instrument
// and no Ixmp patch can ever claim more than 65535 bytes. The census
// (Document.sampleList) is derived from those claims and therefore cannot
// describe a recording longer than 64 KB at all — yet the pool is 8 MB, and
// the working method item 175 asks for is exactly "load a handful of very long
// recordings into memory, then cut every instrument out of them".
//
// A region is that recording: a named, rate-carrying span of the pool that
// exists WITHOUT an instrument claiming it. It changes no playback — a player
// that skips the section hears the same song (§9.8) — and does three things
// for the editor:
//
//   * it RESERVES its bytes, so the first-fit allocator and Housekeeping's
//     pool sweep both leave them alone (the bytes are, by construction,
//     claimed by nothing);
//   * it NAMES them, so the map view has something to draw and label;
//   * it carries the source rate, so an instrument cut out of it is in tune
//     without the user re-typing the number every time.
//
// Pure and DOM-free: the document model, the ops and the tests all read it.

import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";

/** The pool's address space: [0, POOL_SIZE). */
export const POOL_SIZE = SAMPLEBIN_SIZE;

/** Fixed part of one `SRgn` entry: ptr, len, rate, channels, flags. */
const ENTRY_HEAD = 12;

/** Channels a region may carry. One span per channel, laid consecutively. */
export const MAX_REGION_CHANNELS = 8;

/** The rate to assume where nothing declares one — the engine's own render
 *  rate, so bytes cut out of unlabelled memory play back at pitch. */
export const DEFAULT_RATE = 32000;

/**
 * Decode an `SRgn` payload into [{ptr, len, rate, chan, name}], ascending by
 * pointer. Entries that cannot be true — empty, too many channels, or running
 * off the end of the pool — are DROPPED rather than repaired: they can only
 * come from a corrupt file, and a region that lies about its extent would
 * reserve the wrong bytes, which is worse than not existing.
 *
 * A truncated tail stops the walk (the section is a concatenation, so a short
 * last entry means the file was cut, not that the earlier ones are suspect).
 */
export function parseRegionPayload(payload) {
  const out = [];
  if (!payload || payload.length === 0) return out;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const dec = new TextDecoder();
  let p = 0;
  while (p + ENTRY_HEAD <= payload.length) {
    const ptr = dv.getUint32(p, false);
    const len = dv.getUint32(p + 4, false);
    const rate = dv.getUint16(p + 8, false);
    const chan = payload[p + 10];
    // byte 11 is flags — RESERVED, read and ignored.
    let end = p + ENTRY_HEAD;
    while (end < payload.length && payload[end] !== 0) end++;
    if (end >= payload.length) break; // unterminated name: truncated file
    const name = dec.decode(payload.subarray(p + ENTRY_HEAD, end));
    p = end + 1;
    if (len > 0 && chan >= 1 && chan <= MAX_REGION_CHANNELS &&
        ptr + len * chan <= POOL_SIZE) {
      out.push({ ptr, len, rate, chan, name });
    }
  }
  out.sort((a, b) => a.ptr - b.ptr);
  out.forEach((r, i) => { r.index = i; });
  return out;
}

/** Encode [{ptr, len, rate, chan, name}] as an `SRgn` payload, ptr-ascending.
 *  An empty list encodes to an empty payload — callers pass null to setSection
 *  instead, so the section disappears from a project that has no regions. */
export function buildRegionPayload(regions) {
  const enc = new TextEncoder();
  const rows = [...regions].sort((a, b) => a.ptr - b.ptr).map((r) => ({
    r, name: enc.encode(r.name ?? ""),
  }));
  const total = rows.reduce((n, x) => n + ENTRY_HEAD + x.name.length + 1, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const { r, name } of rows) {
    dv.setUint32(p, r.ptr >>> 0, false);
    dv.setUint32(p + 4, r.len >>> 0, false);
    dv.setUint16(p + 8, Math.max(0, Math.min(0xffff, r.rate | 0)), false);
    out[p + 10] = Math.max(1, Math.min(MAX_REGION_CHANNELS, r.chan | 0));
    out[p + 11] = 0; // flags — RESERVED
    out.set(name, p + ENTRY_HEAD);
    p += ENTRY_HEAD + name.length + 1;
  }
  return out;
}

/**
 * Every pool span a region occupies: [{ptr, len, chan}], channel 0 first.
 * Channel *k* begins at `ptr + k × len`, so a stereo region is one contiguous
 * block of `2 × len` bytes — the same shape sampleSpans() gives a census entry,
 * so every consumer that walks one can walk the other.
 */
export function regionSpans(r) {
  const n = Math.max(1, r.chan | 0);
  const out = [];
  for (let c = 0; c < n; c++) out.push({ ptr: r.ptr + c * r.len, len: r.len, chan: c });
  return out;
}

/** Total pool bytes a region holds (all its channels). */
export function regionBytes(r) {
  return r.len * Math.max(1, r.chan | 0);
}

/** The largest contiguous block the pool could still take: what the "load a
 *  recording" dialog quotes against the size of the file being loaded.
 *  `censusSpans` and `regionList` are both {ptr, len}-shaped. */
export function largestFreeRun(censusSpans, regionList) {
  const iv = [
    ...censusSpans.map((s) => [s.ptr, Math.min(s.ptr + s.len, POOL_SIZE)]),
    ...regionList.flatMap(regionSpans).map((s) => [s.ptr, Math.min(s.ptr + s.len, POOL_SIZE)]),
  ].filter(([a, b]) => b > 0 && a < POOL_SIZE).sort((a, b) => a[0] - b[0]);
  let pos = 0, best = 0;
  for (const [a, b] of iv) {
    if (a > pos) best = Math.max(best, a - pos);
    pos = Math.max(pos, b);
  }
  return Math.max(best, POOL_SIZE - pos);
}

/**
 * The occupied pool as ONE region: the implicit recording every project has,
 * including every project made before `SRgn` existed.
 *
 * The point of the map view and the cut-a-window tool is not the section — it
 * is that the pool is a long stretch of audio you can look at and take from.
 * That is true of a project full of converted module samples packed end to end
 * just as much as it is of a deliberately loaded recording, so the view offers
 * this whether or not the document declares a single region. It is a VIEW
 * only: it is never written to the file, it reserves nothing, and nothing
 * allocates or frees against it — `synthetic` marks it so no caller can pass
 * it to a plan by accident.
 *
 * The extent is 0 … the last occupied byte. Claims that fall outside the pool
 * (the junk instrument records every module conversion leaves behind, pointing
 * hundreds of megabytes past the end) are skipped, or the "whole memory" would
 * be mostly imaginary. Returns null for a pool with nothing in it.
 *
 * `rate` is 0 on purpose: a hundred samples at a hundred rates have no single
 * one between them, and a window cut out of this takes the rate of whatever
 * sample it lands in instead.
 */
export function wholeMemoryRegion(censusSpans, regionList = []) {
  let end = 0;
  for (const s of [...censusSpans, ...regionList.flatMap(regionSpans)]) {
    if (s.ptr < 0 || s.ptr + s.len > POOL_SIZE) continue;
    end = Math.max(end, s.ptr + s.len);
  }
  if (end <= 0) return null;
  return { ptr: 0, len: end, rate: 0, chan: 1, name: "", index: -1, synthetic: true };
}
