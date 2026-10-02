// Sample-pool defragmentation (item 178) — slide everything the pool holds
// down against address 0 and hand the gaps back as one run at the top.
//
// WHY IT IS NEEDED. A pool span's length is fixed once allocated and the
// allocator is first-fit (bankmerge.js freeExtents), so a project that has had
// samples replaced, instruments deleted and kits pruned ends up with its 8 MB
// in ribbons: plenty free in total, no single run big enough for the next
// import. Housekeeping frees bytes; it never MOVES any. This is the other half.
//
// WHAT MOVES. Not samples — EXTENTS. Overlapping claims are merged first, so a
// block of memory that two instruments share (or that a stereo patch's two
// channels straddle, or that a region holds) travels as one piece with its
// internal layout untouched. Nothing inside an extent can be torn apart,
// because nothing is ever addressed relative to an extent: every pointer is
// translated by the shift of whichever extent contains it.
//
// WHAT IS REWRITTEN. Base instrument records' bytes 0…3, Ixmp patches' sample
// pointer and their 's' block's extra-channel pointers, and the `SRgn` section
// (§9.11). The Ixmp blobs are patched IN PLACE, four bytes at a time, rather
// than re-encoded from the parsed patches: a defrag touches every instrument in
// the project at once, and the one thing it must not do is quietly rewrite a
// patch record it did not need to touch.
//
// ORDER IS PRESERVED, which is what keeps `SNam` aligned: the census is sorted
// by pointer, compaction never reorders extents and never changes an offset
// inside one, so sample *n* before is sample *n* after and the name table needs
// no rebuilding at all.
//
// The plan is planImport-shaped, so importBankOp gives it undo, DocSync
// re-uploads the pool, and applyPlan already knows what to do with every field.
// Pure and DOM-free.

import { SAMPLEBIN_SIZE, ixmpChanByteOffset, ixmpPatchLen } from "../../core/format/taud-const.js";
import { sampleSpans } from "./document.js";
import { regionSpans, buildRegionPayload, largestFreeRun } from "./sampleregions.js";

/** The pool's address space: [0, POOL_SIZE). */
export const POOL_SIZE = SAMPLEBIN_SIZE;

const u32At = (b, o) =>
  ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) >>> 0) + b[o + 3] * 0x1000000;
function putU32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

/**
 * Merge every occupied span into ascending, non-overlapping extents and give
 * each the address it will move to. `spans` must be {ptr, len} inside the pool.
 * Returns [{ptr, len, to}] — `to` is where the extent's first byte lands.
 */
export function compactExtents(spans) {
  const iv = spans.filter((s) => s.len > 0)
    .map((s) => [s.ptr, s.ptr + s.len])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last.ptr + last.len) last.len = Math.max(last.len, b - last.ptr);
    else out.push({ ptr: a, len: b - a, to: 0 });
  }
  let next = 0;
  for (const e of out) { e.to = next; next += e.len; }
  return out;
}

/**
 * A pointer translator over compacted extents: the address `p` moves to, or
 * `p` itself when no extent holds it (a junk record's pointer, which this never
 * pretends to understand). Binary search — a big project has a few hundred
 * extents and every patch in the bank asks.
 */
export function pointerMapper(extents) {
  return (p) => {
    let lo = 0, hi = extents.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = extents[mid];
      if (p < e.ptr) hi = mid - 1;
      else if (p >= e.ptr + e.len) lo = mid + 1;
      else return p - e.ptr + e.to;
    }
    return p;
  };
}

/**
 * Rewrite every sample pointer in an Ixmp blob through `map`, in place on a
 * copy. Returns {blob, moved} — `moved` counts the pointers that actually
 * changed, so a slot whose patches all stayed put can be left out of the plan.
 */
export function retargetPatchBlob(blob, map) {
  const out = Uint8Array.from(blob);
  let moved = 0;
  let o = 0;
  while (o + 31 <= out.length) {
    const len = ixmpPatchLen(out, o);
    if (len < 31 || o + len > out.length) break;
    // A zero-length patch claims no bytes, so its pointer addresses nothing and
    // is left exactly as it is (the census ignores it for the same reason).
    if ((out[o + 11] | (out[o + 12] << 8)) > 0) {
      const ptr = u32At(out, o + 7);
      const to = map(ptr);
      if (to !== ptr) { putU32(out, o + 7, to); moved++; }
      const so = ixmpChanByteOffset(out[o]);
      if (so >= 0) {
        const extra = (out[o + so] ?? 0) >>> 4;
        for (let k = 0; k < extra; k++) {
          const co = o + so + 4 + 4 * k;
          if (co + 4 > out.length) break;
          const cp = u32At(out, co);
          const cto = map(cp);
          if (cto !== cp) { putU32(out, co, cto); moved++; }
        }
      }
    }
    o += len;
  }
  return { blob: out, moved };
}

/**
 * Plan a pool defragmentation.
 *
 * Returns {error} — with nothing done — or a planImport-shaped plan carrying,
 * besides the fields applyPlan reads, a `report` the confirm dialog quotes:
 *
 *   movedBytes      pool bytes that change address
 *   freedBytes      what the compaction closes up: the holes below the old
 *                   high-water mark, which is exactly what the run at the top
 *                   grows by
 *   highWater/wasHighWater   the last occupied byte, after and before
 *   largestRun/wasLargestRun the biggest single free run, after and before —
 *                   the number that decides whether the next import fits
 *   instruments/patches/regions  how many of each are retargeted
 *   zeroedBytes     vacated bytes that are wiped on the way out
 *
 * `noop: true` comes back when there is nothing to gain (already packed).
 */
export function planPoolDefrag(doc) {
  if (!doc?.sampleInstImage) {
    return { error: "This project has no sample+instrument image." };
  }
  doc._rebuildInstRegion(); // flush pending inst edits into the image first

  const census = doc.sampleList();
  const regions = doc.sampleRegions();

  // Spans that straddle the end of the pool are the one shape this refuses.
  // They are junk instrument records (every module conversion leaves a few),
  // their in-pool tail is pinned where it is, and compacting AROUND a pinned
  // block is a different algorithm for no gain — Housekeeping drops them, and
  // then this works.
  const spans = [];
  let straddling = 0;
  for (const e of census) {
    for (const sp of sampleSpans(e)) {
      if (sp.len <= 0) continue;
      if (sp.ptr >= POOL_SIZE || sp.ptr + sp.len <= 0) continue; // wholly outside: not ours
      if (sp.ptr < 0 || sp.ptr + sp.len > POOL_SIZE) { straddling++; continue; }
      spans.push(sp);
    }
  }
  if (straddling > 0) {
    return { error: `${straddling} sample span(s) run off the end of the pool — ` +
      "run Housekeeping's bank cleanup first, which drops the junk records that claim them." };
  }
  for (const r of regions) {
    for (const sp of regionSpans(r)) {
      if (sp.len > 0 && sp.ptr >= 0 && sp.ptr + sp.len <= POOL_SIZE) spans.push(sp);
    }
  }

  const extents = compactExtents(spans);
  const usedBytes = extents.reduce((n, e) => n + e.len, 0);
  const wasHighWater = extents.length ? extents[extents.length - 1].ptr + extents[extents.length - 1].len : 0;
  const wasLargestRun = largestFreeRun(spans, []);
  if (extents.every((e) => e.to === e.ptr)) {
    return { noop: true, report: { movedBytes: 0, freedBytes: 0, highWater: usedBytes,
      wasHighWater, largestRun: wasLargestRun, wasLargestRun,
      instruments: 0, patches: 0, regions: 0, zeroedBytes: 0 } };
  }
  const map = pointerMapper(extents);

  // ── the pool writes ──────────────────────────────────────────────────────
  // Extents that do not move are not written: the leading run of a lightly
  // fragmented pool is most of it, and every byte written is a byte the undo
  // step has to keep a copy of as well.
  const pool = doc.sampleBin;
  const samples = [];
  let movedBytes = 0;
  for (const e of extents) {
    if (e.to === e.ptr) continue;
    samples.push({
      ptr: e.to,
      bytes: Uint8Array.from(pool.subarray(e.ptr, e.ptr + e.len)),
      srcKeys: [], nameBytes: new Uint8Array(0),
    });
    movedBytes += e.len;
  }
  // …and the ground the compaction vacates. Every destination lies below
  // `usedBytes`, so this span overlaps none of them and the undo step restores
  // the two sets independently.
  let zeroedBytes = 0;
  if (wasHighWater > usedBytes) {
    zeroedBytes = wasHighWater - usedBytes;
    samples.push({
      ptr: usedBytes, bytes: new Uint8Array(zeroedBytes),
      srcKeys: [], nameBytes: new Uint8Array(0),
    });
  }

  // ── the pointers ─────────────────────────────────────────────────────────
  const insts = [];
  let patchesMoved = 0;
  for (const slot of doc.usedInstrumentSlots()) {
    const inst = doc.instruments[slot];
    // A Metainstrument's bytes 0…3 are the $FFFF sentinel, its type nibble and
    // its layer count — not a pointer, and never to be written as one.
    const baseMoves = !inst.isMeta && inst.sampleLength > 0 &&
      map(inst.samplePtr) !== inst.samplePtr;
    const entry = [...doc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === slot);
    let ixmpBlob = entry ? Uint8Array.from(entry.blob) : null;
    let ixmpMoved = 0;
    if (ixmpBlob !== null && !inst.isMeta) {
      const res = retargetPatchBlob(ixmpBlob, map);
      ixmpBlob = res.blob;
      ixmpMoved = res.moved;
    }
    if (!baseMoves && ixmpMoved === 0) continue;
    patchesMoved += ixmpMoved;
    const record = doc.instRecordBytes(slot);
    if (baseMoves) putU32(record, 0, map(inst.samplePtr));
    insts.push({
      srcSlot: -(insts.length + 1), destSlot: slot, topLevel: true,
      record, ixmpBlob, ixmpCount: entry?.count ?? 0,
    });
  }

  // ── the regions ──────────────────────────────────────────────────────────
  let regionsMoved = 0;
  const nextRegions = regions.map((r) => {
    const to = map(r.ptr);
    if (to !== r.ptr) regionsMoved++;
    return { ...r, ptr: to };
  });

  return {
    insts,
    samples,
    inamPayload: null,
    snamNames: new Map(),
    // The census keeps its order and therefore its numbering, so the name table
    // still lines up entry for entry: nothing to rebuild, nothing to write.
    writeSnam: false,
    slotMap: new Map(),
    newSampleBytes: 0,
    dedupedSamples: 0,
    ...(regionsMoved > 0
      ? { regionPayload: nextRegions.length > 0 ? buildRegionPayload(nextRegions) : null }
      : {}),
    report: {
      movedBytes,
      freedBytes: wasHighWater - usedBytes,
      highWater: usedBytes,
      wasHighWater,
      largestRun: POOL_SIZE - usedBytes,
      wasLargestRun,
      instruments: insts.length,
      patches: patchesMoved,
      regions: regionsMoved,
      zeroedBytes,
    },
  };
}
