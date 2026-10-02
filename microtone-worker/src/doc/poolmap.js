// Pool memory map (item 166) — the sample pool as ADDRESSES, not as a list.
//
// sampleList() is a census: it dedupes by (ptr:len) and hands back one tidy
// object per distinct claim. That is the right abstraction for naming, editing
// and exporting, and it is a lie about memory. Two instruments can claim
// overlapping byte ranges of one recording with different lengths and loops and
// get two rows; a deleted sample leaves a hole the list cannot mention; a junk
// instrument record (every S3M/IT conversion has a few, up at slots $1FD–$1FF)
// claims a pointer nowhere near the 8 MB pool and still gets a row that looks
// exactly like a real sample. This module resolves the census back onto the
// address line so all of that becomes visible.
//
// Pure and DOM-free — the Samples view's memory panel draws it, tests read it.

import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { sampleSpans } from "./document.js";
import { regionSpans } from "./sampleregions.js";

/** The pool's address space: [0, POOL_SIZE). */
export const POOL_SIZE = SAMPLEBIN_SIZE;

/** Merge [{ptr,len}] into ascending non-overlapping extents. */
function merged(spans) {
  const iv = spans.map((s) => [s.ptr, s.ptr + s.len]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => ({ ptr: a, len: b - a }));
}

/** Bytes covered by two or more of `spans` (a depth sweep, not a byte loop —
 *  the pool is 8 MB and this runs on every refresh of the panel). */
function overlappedBytes(spans) {
  const ev = [];
  for (const s of spans) { ev.push([s.ptr, 1], [s.ptr + s.len, -1]); }
  ev.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let depth = 0, prev = 0, total = 0;
  for (const [x, d] of ev) {
    if (depth >= 2) total += x - prev;
    depth += d;
    prev = x;
  }
  return total;
}

/**
 * Lay claims out in as few lanes as their overlaps allow (interval
 * partitioning): a lane holds any number of claims as long as they do not
 * touch, so a pool with no overlaps at all draws on ONE line, and every extra
 * lane on screen is a real overlap rather than a layout artefact.
 * `claims` must already be sorted by ptr.
 */
function assignLanes(claims) {
  const laneEnd = [];
  for (const c of claims) {
    let lane = laneEnd.findIndex((e) => e <= c.ptr);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = c.end;
    c.lane = lane;
  }
  return laneEnd.length;
}

/** Non-zero bytes in [from,to) — leftover audio nothing points at any more.
 *  Housekeeping's pool sweep zeroes what it frees, so a hole reading all-zero
 *  is genuinely reclaimed and one reading otherwise is not yet.
 *
 *  The free tail of a small project is most of 8 MB and this runs on every
 *  panel refresh, so the aligned interior is walked a WORD at a time and only
 *  the words that turn out to be non-zero are re-read byte-wise. */
function countNonZero(bin, from, to) {
  if (!bin) return 0;
  let i = Math.max(0, from);
  const end = Math.min(to, bin.length);
  let n = 0;
  const base = bin.byteOffset + i;
  if (end - i >= 32 && (base & 3) === 0) {
    const words = (end - i) >>> 2;
    const w = new Uint32Array(bin.buffer, base, words);
    for (let k = 0; k < words; k++) {
      if (w[k] === 0) continue;
      const o = i + k * 4;
      for (let b = o; b < o + 4; b++) if (bin[b] !== 0) n++;
    }
    i += words * 4;
  }
  for (; i < end; i++) if (bin[i] !== 0) n++;
  return n;
}

/**
 * The pool's actual layout.
 *
 * @param doc      the Document (its `sampleBin` is read only when scanning).
 * @param census   a sampleList() result to reuse (the view already has one).
 * @param scanBytes read the free bytes to tell a swept hole from a stale one.
 *                  Off makes the map arithmetic-only (no 8 MB walk).
 *
 * Returns:
 *   claims   [{index, chan, ptr, len, end, lane, outside, overlaps[], entry}]
 *            — one per POOL SPAN, so a stereo sample contributes two. `index`
 *            is the census row, which is what the Samples list selects by.
 *   regions  [{index, chan, ptr, len, end, entry}] — one per REGION span (item
 *            175). A region is pool memory nothing claims, so it is not a
 *            claim; it is used memory all the same, and every extent, hole and
 *            byte count below counts it.
 *   used     merged extents actually claimed or reserved, ascending
 *   holes    [{ptr, len, stale}] free gaps BELOW the high-water mark
 *   outside  the claims that fall outside [0, POOL_SIZE) — dangling pointers
 *   stats    the numbers the panel prints
 */
export function poolMap(doc, { census = null, regions = null, scanBytes = true } = {}) {
  const list = census ?? doc?.sampleList() ?? [];
  const regionList = regions ?? doc?.sampleRegions?.() ?? [];
  const bin = scanBytes ? (doc?.sampleBin ?? null) : null;

  const claims = [];
  for (const e of list) {
    for (const sp of sampleSpans(e)) {
      claims.push({
        index: e.index, chan: sp.chan, ptr: sp.ptr, len: sp.len, end: sp.ptr + sp.len,
        entry: e, lane: 0, overlaps: [],
        outside: sp.ptr < 0 || sp.ptr + sp.len > POOL_SIZE,
      });
    }
  }
  claims.sort((a, b) => a.ptr - b.ptr || a.len - b.len || a.chan - b.chan);
  claims.forEach((c, i) => { c.slot = i; });

  // Who shares bytes with whom. Sorted by ptr, so the scan stops at the first
  // claim that starts past this one's end.
  let overlapPairs = 0;
  for (let i = 0; i < claims.length; i++) {
    const a = claims[i];
    for (let j = i + 1; j < claims.length && claims[j].ptr < a.end; j++) {
      const b = claims[j];
      if (a.index === b.index && a.chan !== b.chan) continue; // one sample's own channels
      a.overlaps.push(b.slot);
      b.overlaps.push(a.slot);
      overlapPairs++;
    }
  }

  // Region spans: used memory that no claim describes (item 175).
  const regionRects = [];
  for (const r of regionList) {
    for (const sp of regionSpans(r)) {
      if (sp.ptr < 0 || sp.ptr + sp.len > POOL_SIZE) continue;
      regionRects.push({
        index: r.index ?? 0, chan: sp.chan, ptr: sp.ptr, len: sp.len,
        end: sp.ptr + sp.len, entry: r,
      });
    }
  }
  regionRects.sort((a, b) => a.ptr - b.ptr);

  const inPool = claims.filter((c) => !c.outside);
  const outside = claims.filter((c) => c.outside);
  const used = merged([...inPool, ...regionRects]);
  const highWater = used.length ? used[used.length - 1].ptr + used[used.length - 1].len : 0;
  const lanes = assignLanes(inPool);

  const holes = [];
  let pos = 0;
  for (const u of used) {
    if (u.ptr > pos) holes.push({ ptr: pos, len: u.ptr - pos, stale: countNonZero(bin, pos, u.ptr) });
    pos = u.ptr + u.len;
  }
  const tailStale = countNonZero(bin, highWater, POOL_SIZE);

  const usedBytes = used.reduce((n, u) => n + u.len, 0);
  const claimedBytes = inPool.reduce((n, c) => n + c.len, 0);
  const regionBytes = regionRects.reduce((n, r) => n + r.len, 0);
  return {
    poolSize: POOL_SIZE,
    claims, regions: regionRects, used, holes, outside, lanes, highWater,
    stats: {
      entries: list.length,
      spans: claims.length,
      regionCount: regionList.length,
      regionSpans: regionRects.length,
      regionBytes,
      usedBytes,
      // What the census would ADD UP TO if every row owned its bytes: bigger
      // than usedBytes exactly when rows share, which is the panel's whole point.
      claimedBytes,
      sharedBytes: overlappedBytes(inPool),
      overlapPairs,
      holeCount: holes.length,
      holeBytes: holes.reduce((n, h) => n + h.len, 0),
      staleBytes: holes.reduce((n, h) => n + h.stale, 0) + tailStale,
      tailStale,
      tailFree: POOL_SIZE - highWater,
      freeBytes: POOL_SIZE - usedBytes,
      outsideCount: outside.length,
      scanned: bin !== null,
    },
  };
}

/** The claims covering any part of [ptr, ptr+len), ascending. */
export function claimsIn(map, ptr, len) {
  return map.claims.filter((c) => !c.outside && c.ptr < ptr + len && c.end > ptr);
}
