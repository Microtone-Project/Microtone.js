// Bank merge — import selected instruments (with their samples, Ixmp patches
// and meta layers) from a source Document (.taud or .tsii) into the current
// one. Pure doc-layer planning/apply/restore; the invertible op lives in
// ops.js (importBankOp). Strategy:
//   * selecting a Metainstrument pulls its layer instruments in (closure);
//   * samples dedupe by CONTENT against the destination pool and within the
//     batch, then first-fit into free pool extents (8 MB budget);
//   * top-level imports take free slots 1..255 (the pattern-cell instrument
//     byte can't address higher); every sub-instrument — a source of another
//     instrument in the batch, picked or not — fills $3FF downward to $100;
//   * instrument records and Ixmp blobs are kept verbatim except the
//     remapped sample pointers / layer indices; INam entries splice by slot,
//     SNam rebuilds by sample identity (ptr:len) AFTER apply so the name
//     order always matches the post-merge sampleList() census.

import { SAMPLEBIN_SIZE, ixmpPatchLen, ixmpChanByteOffset } from "../../core/format/taud-const.js";
import {
  parsePatchesBlob, TaudInst, buildMetaRecord, makeMetaLayer, META_MAX_LAYERS,
  META_TYPE_FM, FM_MAX_OPERATORS, FM_BUDGET_BYTES, defaultFmProgram, fmRecordBytes,
  patchChannelPtrs, makeInstPatch, writePatchesBlob, CHAN_MODE_DISCRETE,
} from "../../core/engine/inst.js";
import { sampleSpans } from "./document.js";
import { buildImixSection, freeImixId } from "../../core/format/imix-section.js";
import {
  regionSpans, buildRegionPayload, MAX_REGION_CHANNELS,
} from "./sampleregions.js";
import {
  formantInstSpans, formantRecordSpans, retargetFormantRecord, remapFormantSource,
} from "./formantedit.js";
import {
  metaLayers, metaRecordOf, defaultLayer, linkCount, repointLayer, metaFlags,
} from "./metaedit.js";
import {
  easyNeeds, easyFill, easyCompile, easyDecode, easySinePcm, easyDcPcm, easyCycleTuning,
  EASY_SINE_FRAMES, EASY_PRINCIPAL_FADEOUT, OCTET_UNITY,
} from "./fmeasy.js";
import { fmValidate, fmOperators, fmProgramOf } from "./fmedit.js";
import { FM_WORD_OSC, FmOp } from "../../core/engine/inst.js";

const sampleKey = (ptr, len) => `${ptr}:${len}`;

// ── 0x1E-separated name tables, handled at the BYTE level so imported names
//    round-trip whatever encoding/escapes the source file used ──

export function splitNameTable(payload) {
  if (!payload || payload.length === 0) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i <= payload.length; i++) {
    if (i === payload.length || payload[i] === 0x1e) {
      parts.push(payload.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

export function joinNameTable(parts) {
  const trimmed = [...parts];
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1]?.length ?? 0) === 0) trimmed.pop();
  const total = trimmed.reduce((n, p) => n + (p?.length ?? 0), 0) + Math.max(0, trimmed.length - 1);
  const out = new Uint8Array(total);
  let o = 0;
  trimmed.forEach((p, i) => {
    if (i > 0) out[o++] = 0x1e;
    if (p) { out.set(p, o); o += p.length; }
  });
  return out;
}

function sectionPayload(doc, fc) {
  return doc.projSections.find((s) => s.fourcc === fc)?.payload ?? null;
}

/** Ixmp section payload from decoded entries (inverse of parseIxmpSection). */
export function buildIxmpSection(entries) {
  const total = entries.reduce((n, e) => n + 4 + e.blob.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const e of entries) {
    out[o] = e.instId & 0xff;
    out[o + 1] = e.count & 0xff;
    out[o + 2] = (e.count >>> 8) & 0xff;
    out[o + 3] = (e.instId >>> 8) & 0x03;
    out.set(e.blob, o + 4);
    o += 4 + e.blob.length;
  }
  return out;
}

/** Slots a metainstrument names as sources — its layer table, or a formant
 *  instrument's OPL source (used slots only). */
function layerDeps(srcDoc, slot, srcUsed) {
  return srcDoc.instruments[slot].sourceSlots.filter((d) => srcUsed.has(d));
}

/**
 * Describe a source document's importable instruments for the picker UI:
 * [{slot, name, isMeta, patchCount, sampleBytes, layerOf: [metaSlot…]}].
 */
export function bankInventory(srcDoc) {
  const used = srcDoc.usedInstrumentSlots();
  const usedSet = new Set(used);
  const layerOf = new Map();
  for (const s of used) {
    for (const d of layerDeps(srcDoc, s, usedSet)) {
      if (!layerOf.has(d)) layerOf.set(d, []);
      layerOf.get(d).push(s);
    }
  }
  return used.map((slot) => {
    const inst = srcDoc.instruments[slot];
    const keys = new Set();
    if (!inst.isMeta && inst.sampleLength > 0) keys.add(sampleKey(inst.samplePtr, inst.sampleLength));
    // A formant instrument's consonant slots cost pool bytes too (item 212).
    for (const sp of formantInstSpans(inst)) keys.add(sampleKey(sp.ptr, sp.len));
    for (const p of inst.extraPatches ?? []) {
      // Both channels of a stereo patch cost pool bytes.
      if (p.sampleLength > 0) {
        for (const ptr of patchChannelPtrs(p)) keys.add(sampleKey(ptr, p.sampleLength));
      }
    }
    let sampleBytes = 0;
    for (const k of keys) sampleBytes += Number(k.split(":")[1]);
    return {
      slot,
      name: srcDoc.instrumentName(slot),
      isMeta: inst.isMeta,
      isFm: inst.isFm,
      layerCount: inst.metaLayers?.length ?? 0,
      patchCount: inst.extraPatches?.length ?? 0,
      sampleBytes,
      layerOf: layerOf.get(slot) ?? [],
    };
  });
}

// Free extents of the destination pool: [0, SAMPLEBIN_SIZE) minus the merged
// [ptr, ptr+len) intervals of every census sample AND every pool region (item
// 175). A region's bytes are claimed by nothing — that is what makes it a
// region — so without this line a 4 MB recording loaded into memory is simply
// the free space the next imported drum hit lands in.
//
// `exempt` puts spans BACK: planReplaceSample hands it the target's own old
// spans, so a sample cut out of a region can still be rewritten over the bytes
// it already occupies instead of being exiled to the end of the pool.
function freeExtents(census, regions = [], exempt = []) {
  const ivs = [
    ...census.flatMap(sampleSpans), // a stereo entry occupies its extra channels' spans too
    ...regions.flatMap(regionSpans),
  ].map((e) => [e.ptr, Math.min(e.ptr + e.len, SAMPLEBIN_SIZE)])
    .sort((a, b) => a[0] - b[0]);
  const free = [];
  let pos = 0;
  for (const [a, b] of ivs) {
    if (a > pos) free.push({ ptr: pos, len: a - pos });
    pos = Math.max(pos, b);
  }
  if (pos < SAMPLEBIN_SIZE) free.push({ ptr: pos, len: SAMPLEBIN_SIZE - pos });
  if (exempt.length === 0) return free;
  const back = exempt.map((e) => ({ ptr: e.ptr, len: Math.min(e.len, SAMPLEBIN_SIZE - e.ptr) }));
  return mergeExtents([...free, ...back]);
}

/** Merge {ptr,len} extents into ascending, non-touching ones. */
function mergeExtents(list) {
  const iv = list.filter((e) => e.len > 0)
    .map((e) => [e.ptr, e.ptr + e.len]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => ({ ptr: a, len: b - a }));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Rewrite a Metainstrument record's 10-bit layer indices (byte o, plus the two
 * high bits in byte o+8) in place through `slotMap`. A layer whose target is
 * NOT in the map is zeroed — index 0 is "no layer" to the record parser, so a
 * stale source index can never alias an unrelated destination instrument.
 */
function remapMetaLayerSlots(rec, slotMap) {
  const count = rec[1];
  for (let n = 0; n < count && 4 + n * 10 + 10 <= 256; n++) {
    const o = 4 + n * 10;
    const mapped = slotMap.get(rec[o] | (((rec[o + 8] >>> 6) & 0x3) << 8));
    if (mapped !== undefined) {
      rec[o] = mapped & 0xff;
      rec[o + 8] = (rec[o + 8] & 0x3f) | (((mapped >>> 8) & 0x3) << 6);
    } else {
      rec[o] = 0;
      rec[o + 8] &= 0x3f;
    }
  }
}

/**
 * Plan an import of `selectedSlots` from srcDoc into destDoc. Pure — computes
 * everything applyPlan will write. Returns {error} on any budget/validity
 * failure, else:
 * {
 *   insts: [{srcSlot, destSlot, topLevel, record, ixmpBlob|null, ixmpCount}],
 *   samples: [{ptr, bytes, srcKeys}],       // new pool writes
 *   inamPayload: Uint8Array|null,           // null = leave INam alone
 *   snamNames: Map<"ptr:len", Uint8Array>,  // identity → name (post-apply rebuild)
 *   writeSnam: boolean,
 *   slotMap: Map<srcSlot, destSlot>, newSampleBytes, dedupedSamples,
 * }
 */
export function planImport(destDoc, srcDoc, selectedSlots) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image to import into." };
  }
  if (srcDoc.sampleInstImage === null) {
    return { error: "The source file carries no sample+instrument image." };
  }
  const srcUsed = new Set(srcDoc.usedInstrumentSlots());
  const selected = [...new Set(selectedSlots)].filter((s) => srcUsed.has(s));
  if (selected.length === 0) return { error: "No instruments selected." };

  // ── dependency closure over meta layer tables ──
  const all = new Set(selected);
  const queue = [...selected];
  while (queue.length > 0) {
    for (const d of layerDeps(srcDoc, queue.pop(), srcUsed)) {
      if (!all.has(d)) { all.add(d); queue.push(d); }
    }
  }
  // A sub-instrument is a component, not something to play (item 59), so it
  // goes to the auxiliary range even when it was ticked — "All" ticks every
  // row, and the source may well have kept it in $01–$FF.
  const sources = new Set();
  for (const s of all) for (const d of layerDeps(srcDoc, s, srcUsed)) sources.add(d);
  const topLevel = new Set(selected.filter((s) => !sources.has(s)));
  const ordered = [...all].sort((a, b) => a - b);

  // ── destination slots: 1..255 ascending for note-addressable imports,
  //    $3FF downward to $100 for sub-instruments, which fall back to the low
  //    range only once the auxiliary one is full ──
  const taken = new Set(destDoc.usedInstrumentSlots());
  const slotMap = new Map();
  let low = 1, high = 1023;
  const nextLow = () => { while (low <= 255 && taken.has(low)) low++; return low <= 255 ? low : null; };
  const nextHigh = () => { while (high >= 256 && taken.has(high)) high--; return high >= 256 ? high : null; };
  for (const srcSlot of ordered) {
    const dest = topLevel.has(srcSlot) ? nextLow() : (nextHigh() ?? nextLow());
    if (dest === null) {
      return {
        error: topLevel.has(srcSlot)
          ? "No free instrument slots left in $01–$FF (note-addressable range)."
          : "No free instrument slots left.",
      };
    }
    taken.add(dest);
    slotMap.set(srcSlot, dest);
  }

  // ── samples: collect unique (ptr:len), dedupe by content, allocate ──
  const srcPool = srcDoc.sampleBin;
  const destPool = destDoc.sampleBin;
  const destCensus = destDoc.sampleList();
  const extents = freeExtents(destCensus, destDoc.sampleRegions());
  const sampleMap = new Map(); // srcKey → dest ptr
  const newSamples = [];       // {ptr, bytes, srcKeys}
  let newSampleBytes = 0, dedupedSamples = 0;

  const wantKeys = [];
  for (const srcSlot of ordered) {
    const inst = srcDoc.instruments[srcSlot];
    if (!inst.isMeta && inst.sampleLength > 0) wantKeys.push([inst.samplePtr, inst.sampleLength]);
    for (const sp of formantInstSpans(inst)) wantKeys.push([sp.ptr, sp.len]);
    for (const p of inst.extraPatches ?? []) {
      if (p.sampleLength > 0) {
        // Each channel of a stereo patch is its own pool span and travels with
        // the patch (they dedupe independently — identical channels collapse).
        for (const ptr of patchChannelPtrs(p)) wantKeys.push([ptr, p.sampleLength]);
      }
    }
  }
  for (const [ptr, len] of wantKeys) {
    const key = sampleKey(ptr, len);
    if (sampleMap.has(key)) continue;
    const end = Math.min(ptr + len, SAMPLEBIN_SIZE);
    if (end <= ptr) { sampleMap.set(key, 0); continue; } // degenerate pointer — keep silent-sample semantics
    const bytes = srcPool.subarray(ptr, end);

    let destPtr = null;
    for (const e of destCensus) {
      if (e.len === bytes.length && bytesEqual(destPool.subarray(e.ptr, e.ptr + e.len), bytes)) {
        destPtr = e.ptr;
        dedupedSamples++;
        break;
      }
    }
    if (destPtr === null) {
      for (const ns of newSamples) {
        if (bytesEqual(ns.bytes, bytes)) { destPtr = ns.ptr; ns.srcKeys.push(key); dedupedSamples++; break; }
      }
    }
    if (destPtr === null) {
      const ext = extents.find((x) => x.len >= bytes.length);
      if (!ext) {
        return { error: `Sample pool full: needs ${bytes.length} more bytes and no free extent is large enough.` };
      }
      destPtr = ext.ptr;
      ext.ptr += bytes.length;
      ext.len -= bytes.length;
      newSamples.push({ ptr: destPtr, bytes: Uint8Array.from(bytes), srcKeys: [key] });
      newSampleBytes += bytes.length;
    }
    sampleMap.set(key, destPtr);
  }

  // ── instrument records (+ Ixmp blobs), pointers/indices remapped ──
  const insts = [];
  for (const srcSlot of ordered) {
    const inst = srcDoc.instruments[srcSlot];
    const rec = srcDoc.instRecordBytes(srcSlot);
    let ixmpBlob = null, ixmpCount = 0;

    if (inst.isMeta) {
      remapMetaLayerSlots(rec, slotMap);
    } else if (inst.isFormant) {
      // Its pointers are the block's and the slots', not bytes 0…3 (§7.6);
      // its source instrument, if it has one, travels with it.
      retargetFormantRecord(rec, (ptr, len) => sampleMap.get(sampleKey(ptr, len)));
      remapFormantSource(rec, (s) => slotMap.get(s));
    } else {
      if (inst.sampleLength > 0) {
        const ptr = sampleMap.get(sampleKey(inst.samplePtr, inst.sampleLength));
        rec[0] = ptr & 0xff;
        rec[1] = (ptr >>> 8) & 0xff;
        rec[2] = (ptr >>> 16) & 0xff;
        rec[3] = (ptr >>> 24) & 0xff;
      }
      // Last Ixmp entry for the slot wins — matches the upload path, where
      // each entry replaces the previous patch set.
      const entry = [...srcDoc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === srcSlot);
      if (entry && entry.blob.length > 0) {
        ixmpBlob = Uint8Array.from(entry.blob);
        ixmpCount = entry.count;
        let o = 0;
        const remapPtrAt = (at, pLen) => {
          const pPtr = (ixmpBlob[at] | (ixmpBlob[at + 1] << 8) | (ixmpBlob[at + 2] << 16)) +
                       ixmpBlob[at + 3] * 0x1000000;
          const ptr = sampleMap.get(sampleKey(pPtr, pLen)) ?? pPtr;
          ixmpBlob[at] = ptr & 0xff;
          ixmpBlob[at + 1] = (ptr >>> 8) & 0xff;
          ixmpBlob[at + 2] = (ptr >>> 16) & 0xff;
          ixmpBlob[at + 3] = (ptr >>> 24) & 0xff;
        };
        while (o + 31 <= ixmpBlob.length) {
          const len = ixmpPatchLen(ixmpBlob, o);
          if (o + len > ixmpBlob.length) break;
          const pLen = ixmpBlob[o + 11] | (ixmpBlob[o + 12] << 8);
          if (pLen > 0) {
            remapPtrAt(o + 7, pLen);
            // 's' block: every extra channel pointer moves with its own span.
            const so = ixmpChanByteOffset(ixmpBlob[o]);
            if (so >= 0) {
              const extra = (ixmpBlob[o + so] ?? 0) >>> 4;
              for (let k = 0; k < extra; k++) remapPtrAt(o + so + 4 + 4 * k, pLen);
            }
          }
          o += len;
        }
      }
    }
    insts.push({ srcSlot, destSlot: slotMap.get(srcSlot), topLevel: topLevel.has(srcSlot), record: rec, ixmpBlob, ixmpCount });
  }

  // ── IMix (item 217): an imported instrument brings its mixing chain. Each
  //    source block lands under a fresh id here, once per import, so two
  //    instruments that shared a chain still share it and none of the
  //    project's own chains is touched. A record naming a block its file does
  //    not hold comes over with no chain. ──
  let imixPayload;
  const srcBlocks = typeof srcDoc.imixMap === "function" ? srcDoc.imixMap().blocks : new Map();
  const destBlocks = new Map(destDoc.imixMap().blocks);
  const imixIds = new Map();
  for (const it of insts) {
    const sid = it.record[255];
    if (sid === 0) continue;
    if (!imixIds.has(sid)) {
      const blk = srcBlocks.get(sid);
      let did = 0;
      if (blk) {
        did = freeImixId(new Set(destBlocks.keys()));
        if (did === 0) return { error: "No free mixing-chain id left in this project (255 in use)." };
        destBlocks.set(did, { ...blk, id: did });
      }
      imixIds.set(sid, did);
    }
    it.record[255] = imixIds.get(sid);
    // A metainstrument's record is applied verbatim, so the byte above is all
    // it takes; every other kind decodes byte 255 into its reserved tail.
  }
  if (destBlocks.size !== destDoc.imixMap().blocks.size) imixPayload = buildImixSection(destBlocks.values());
  // …and its name (IMcn, item 247) goes with it to the new id.
  let imcnPayload;
  const srcImcn = splitNameTable(sectionPayload(srcDoc, "IMcn"));
  if ([...imixIds].some(([sid, did]) => did !== 0 && (srcImcn[sid]?.length ?? 0) > 0)) {
    const parts = splitNameTable(sectionPayload(destDoc, "IMcn"));
    for (const [sid, did] of imixIds) {
      if (did === 0 || (srcImcn[sid]?.length ?? 0) === 0) continue;
      while (parts.length <= did) parts.push(new Uint8Array(0));
      parts[did] = srcImcn[sid];
    }
    imcnPayload = joinNameTable(parts);
  }

  // ── INam: splice imported names in by destination slot ──
  const srcInam = splitNameTable(sectionPayload(srcDoc, "INam"));
  const destInamPayload = sectionPayload(destDoc, "INam");
  const anyInstName = insts.some((it) => (srcInam[it.srcSlot]?.length ?? 0) > 0);
  let inamPayload = null;
  if (anyInstName || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    for (const it of insts) {
      while (parts.length <= it.destSlot) parts.push(new Uint8Array(0));
      parts[it.destSlot] = srcInam[it.srcSlot] ?? new Uint8Array(0);
    }
    inamPayload = joinNameTable(parts);
  }

  // ── SNam: identity → name map; the payload itself is rebuilt after apply
  //    from the real census so name order can never drift ──
  const snamNames = new Map();
  const destSnamPayload = sectionPayload(destDoc, "SNam");
  const destSnam = splitNameTable(destSnamPayload);
  destCensus.forEach((e, i) => snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
  const srcSnam = splitNameTable(sectionPayload(srcDoc, "SNam"));
  const srcNameByKey = new Map();
  srcDoc.sampleList().forEach((e, i) => srcNameByKey.set(sampleKey(e.ptr, e.len), srcSnam[i] ?? new Uint8Array(0)));
  let anySampleName = false;
  for (const ns of newSamples) {
    const name = srcNameByKey.get(ns.srcKeys[0]) ?? new Uint8Array(0);
    if (name.length > 0) anySampleName = true;
    snamNames.set(sampleKey(ns.ptr, ns.bytes.length), name);
  }
  const writeSnam = anySampleName || destSnamPayload !== null;

  return {
    insts,
    samples: newSamples,
    inamPayload,
    imixPayload,
    imcnPayload,
    snamNames,
    writeSnam,
    slotMap,
    newSampleBytes,
    dedupedSamples,
  };
}

/** Fresh single-sample instrument record: TaudInst constructor defaults
 *  (vol-env terminator at 0x3F — a zeroed record's value-0 terminator would
 *  hit the Schism cut rule and ramp the voice out instantly) with the sample
 *  binding filled in. Loop fields default to no-loop; pass them to inherit an
 *  existing pooled sample's loop (item 40). */
export function buildFreshInstRecord({ samplePtr, sampleLength, samplingRate,
                                       sampleLoopStart = 0, sampleLoopEnd = 0, loopMode = 0,
                                       sampleDetune = 0, initialAttenOctet = 0 }) {
  const inst = new TaudInst(0);
  inst.samplePtr = samplePtr;
  inst.sampleLength = sampleLength;
  inst.samplingRate = samplingRate;
  inst.sampleLoopStart = sampleLoopStart;
  inst.sampleLoopEnd = sampleLoopEnd;
  inst.loopMode = loopMode;
  inst.sampleDetune = sampleDetune;
  inst.initialAttenOctet = initialAttenOctet & 0xff;
  const rec = new Uint8Array(256);
  for (let i = 0; i < 256; i++) rec[i] = inst.getByteNormal(i);
  return rec;
}

/**
 * Plan importing ONE raw sample (mono U8 PCM, ≤ 65535 bytes) as a brand-new
 * instrument: pool content is deduped, the PCM first-fits a free extent, the
 * instrument takes the lowest free note-addressable slot, and INam/SNam get
 * `nameBytes`. Returns {error} on failure, else a plan shaped exactly like
 * planImport's — apply it with importBankOp for full undo.
 */
export function planSampleImport(destDoc, item) {
  return planMultiSampleImport(destDoc, [item]);
}

/**
 * The N-sample generalisation (item 84 — the Sample Lab's chopper lands every
 * kept chunk in ONE undo step): `items` is [{nameBytes, pcm, rate, loop, pcmR, detune,
 * attenOctet}].
 * Each item becomes its own instrument (free $01–$FF slots ascending, in item
 * order); PCM dedupes against the pool AND within the batch; INam/SNam names
 * land per item (a deduped span keeps its existing name; for a batch-internal
 * dupe the first item's name wins). Same plan shape, same importBankOp.
 *
 * `detune` (signed, 4096-TET, item 195) defaults to 0 — the waveform-paint
 * caller is the only one that passes it, to land a freshly painted cycle
 * exactly on middle C at C-4 rather than at whatever pitch its raw length
 * happens to loop at.
 *
 * `attenOctet` (byte 251, the decibel octet; 0 = unity) defaults to 0 — a
 * pattern rendered to a sample (item 242) is kept near full scale for its 8
 * bits and carries the rest of its level here.
 *
 * `pcmR` (same length as `pcm`) makes the item STEREO (item 90): the right
 * channel takes its own pool span and the instrument gets a single full-range
 * Ixmp patch carrying the 's' block. The base record still points at the LEFT
 * channel, so a reader that ignores the patch plays the left channel rather
 * than nothing.
 */
export function planMultiSampleImport(destDoc, items) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image to import into." };
  }
  if (!items || items.length === 0) return { error: "The decoded sample is empty." };
  for (const it of items) {
    if (!it.pcm || it.pcm.length === 0) return { error: "The decoded sample is empty." };
    if (it.pcm.length > 0xffff) {
      return { error: `Sample too long: ${it.pcm.length} bytes (65535 max) — resample it first.` };
    }
    if (it.pcmR && it.pcmR.length !== it.pcm.length) {
      return { error: "Stereo channels must be the same length." };
    }
  }

  // ── slots: one per item, lowest free $01–$FF ascending ──
  const taken = new Set(destDoc.usedInstrumentSlots());
  const slots = [];
  let slot = 1;
  for (let i = 0; i < items.length; i++) {
    while (slot <= 255 && taken.has(slot)) slot++;
    if (slot > 255) {
      return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
    }
    taken.add(slot);
    slots.push(slot);
  }

  // ── pool: dedupe (census, then batch), first-fit the rest ──
  const pool = poolPlacer(destDoc);
  const { samples } = pool;
  const placeChannel = pool.place;
  const ptrs = [];
  const ptrsR = [];
  for (const it of items) {
    const left = placeChannel(it.pcm, it.nameBytes);
    if (left.error) return { error: left.error };
    ptrs.push(left.ptr);
    if (it.pcmR) {
      const right = placeChannel(it.pcmR, new Uint8Array(0));
      if (right.error) return { error: right.error };
      ptrsR.push(right.ptr);
    } else {
      ptrsR.push(null);
    }
  }

  const insts = items.map((it, i) => {
    const len = it.pcm.length;
    const rate = Math.max(1, Math.min(0xffff, Math.round(it.rate) || 0));
    const detune = Math.max(-32768, Math.min(32767, Math.round(it.detune) || 0));
    // Optional forward loop over the whole sample — a painted single-cycle
    // waveform (item 53) needs it to sustain as a tone.
    const loopEnd = it.loop ? len : 0;
    const loopMode = it.loop ? 1 : 0;
    const stereo = ptrsR[i] !== null;
    return {
      srcSlot: -(i + 1), // unique synthetic keys so slotMap can't collide
      destSlot: slots[i],
      topLevel: true,
      record: buildFreshInstRecord({
        samplePtr: ptrs[i], sampleLength: len, samplingRate: rate,
        sampleLoopEnd: loopEnd, loopMode, sampleDetune: detune,
        initialAttenOctet: it.attenOctet ?? 0,
      }),
      ixmpBlob: stereo
        ? writePatchesBlob([makeInstPatch({
            pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
            samplePtr: ptrs[i], sampleLength: len, playStart: 0,
            loopStart: 0, loopEnd, samplingRate: rate, sampleDetune: detune, loopMode,
            hasChanBlock: true, chanCount: 2, chanMode: CHAN_MODE_DISCRETE,
            chanPtrs: [ptrsR[i]],
          })])
        : null,
      ixmpCount: stereo ? 1 : 0,
    };
  });

  // INam: splice each instrument name in by slot.
  const destInamPayload = sectionPayload(destDoc, "INam");
  const anyName = items.some((it) => (it.nameBytes?.length ?? 0) > 0);
  let inamPayload = null;
  if (anyName || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    items.forEach((it, i) => {
      while (parts.length <= slots[i]) parts.push(new Uint8Array(0));
      parts[slots[i]] = it.nameBytes ?? new Uint8Array(0);
    });
    inamPayload = joinNameTable(parts);
  }

  return {
    insts,
    samples,
    inamPayload,
    ...pool.snam(anyName),
    slotMap: new Map(insts.map((it) => [it.srcSlot, it.destSlot])),
    newSampleBytes: pool.newSampleBytes(),
    dedupedSamples: pool.dedupedSamples(),
  };
}

/**
 * Sample placement for a plan that brings NEW pcm into the pool: `place(pcm,
 * nameBytes)` reuses an identical span if the pool (or this batch) already
 * holds one, else first-fits a free extent, and returns {ptr} or {error}.
 * `nameBytes` names a NEW span only — a deduped one keeps its existing name.
 * `snam(anyName)` is the plan's {snamNames, writeSnam}: the SNam identity map,
 * whose payload is rebuilt from the real census after apply.
 */
function poolPlacer(destDoc) {
  const destCensus = destDoc.sampleList();
  const destPool = destDoc.sampleBin;
  const extents = freeExtents(destCensus, destDoc.sampleRegions());
  const samples = [];
  let newSampleBytes = 0, dedupedSamples = 0;
  const place = (pcm, nameBytes) => {
    for (const e of destCensus) {
      if (e.len === pcm.length && bytesEqual(destPool.subarray(e.ptr, e.ptr + e.len), pcm)) {
        dedupedSamples++;
        return { ptr: e.ptr };
      }
    }
    for (const ns of samples) {
      if (bytesEqual(ns.bytes, pcm)) { dedupedSamples++; return { ptr: ns.ptr }; }
    }
    const ext = extents.find((x) => x.len >= pcm.length);
    if (!ext) {
      return { error: `Sample pool full: needs ${pcm.length} more bytes and no free extent is large enough.` };
    }
    const ptr = ext.ptr;
    ext.ptr += pcm.length;
    ext.len -= pcm.length;
    samples.push({ ptr, bytes: Uint8Array.from(pcm), srcKeys: [], nameBytes: nameBytes ?? new Uint8Array(0) });
    newSampleBytes += pcm.length;
    return { ptr };
  };
  const snam = (anyName) => {
    const snamNames = new Map();
    const destSnam = splitNameTable(sectionPayload(destDoc, "SNam"));
    destCensus.forEach((e, i) => snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
    for (const ns of samples) snamNames.set(sampleKey(ns.ptr, ns.bytes.length), ns.nameBytes);
    return { snamNames, writeSnam: anyName || sectionPayload(destDoc, "SNam") !== null };
  };
  return {
    samples, place, snam,
    newSampleBytes: () => newSampleBytes,
    dedupedSamples: () => dedupedSamples,
  };
}

/**
 * Plan a brand-new instrument that plays an EXISTING pooled sample (item 40):
 * no new sample bytes, the instrument takes the lowest free note-addressable
 * slot and inherits the sample's loop/rate. The census is unchanged (same set
 * of pooled samples), so SNam is left verbatim. Returns {error} on failure,
 * else a planImport-shaped plan (apply with importBankOp for full undo).
 */
export function planExistingSampleAsInstrument(destDoc, sample, nameBytes = new Uint8Array(0)) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image to import into." };
  }
  if (!sample || sample.len <= 0) return { error: "The selected sample is empty." };

  const taken = new Set(destDoc.usedInstrumentSlots());
  let slot = 1;
  while (slot <= 255 && taken.has(slot)) slot++;
  if (slot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }

  const rate = Math.max(1, Math.min(0xffff, Math.round(sample.rate) || 0));
  const record = buildFreshInstRecord({
    samplePtr: sample.ptr,
    sampleLength: sample.len,
    samplingRate: rate,
    sampleLoopStart: sample.loopStart & 0xffff,
    sampleLoopEnd: sample.loopEnd & 0xffff,
    loopMode: sample.loopMode & 0x17,
  });
  // A stereo sample only sounds as a pair through an Ixmp 's' patch, so the
  // fresh instrument gets the same full-range patch the importer builds.
  const stereo = (sample.chanPtrs?.length ?? 0) > 0;
  const ixmpBlob = stereo
    ? writePatchesBlob([makeInstPatch({
        pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
        samplePtr: sample.ptr, sampleLength: sample.len, playStart: 0,
        loopStart: sample.loopStart & 0xffff, loopEnd: sample.loopEnd & 0xffff,
        samplingRate: rate, loopMode: sample.loopMode & 0x07,
        hasChanBlock: true, chanCount: 1 + sample.chanPtrs.length,
        chanMode: sample.chanMode ?? CHAN_MODE_DISCRETE,
        chanPtrs: [...sample.chanPtrs],
      })])
    : null;

  // INam: splice the instrument name in by slot. SNam untouched — the pooled
  // sample set (and hence the census order) does not change.
  const destInamPayload = sectionPayload(destDoc, "INam");
  let inamPayload = null;
  if (nameBytes.length > 0 || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    while (parts.length <= slot) parts.push(new Uint8Array(0));
    parts[slot] = nameBytes;
    inamPayload = joinNameTable(parts);
  }

  return {
    insts: [{ srcSlot: -1, destSlot: slot, topLevel: true, record, ixmpBlob, ixmpCount: stereo ? 1 : 0 }],
    samples: [],
    inamPayload,
    snamNames: new Map(),
    writeSnam: false,
    slotMap: new Map([[-1, slot]]),
    newSampleBytes: 0,
    dedupedSamples: 1,
  };
}

/**
 * Duplicate a POOLED sample (item 151): copy its bytes into FRESH pool spans
 * and mint an instrument that plays the copy. The point of the copy is that it
 * can be edited on its own, so nothing is deduped here — "New instrument" (
 * planExistingSampleAsInstrument) is the version that shares the bytes, and
 * this one costs `len` bytes per channel.
 *
 * Loop points, rate and loop mode carry over verbatim; a stereo sample (item
 * 90) duplicates BOTH channels and the copy gets the same full-range Ixmp 's'
 * patch the importer builds. The census gains an entry, so SNam is rebuilt
 * from sample identity after apply (the pool order IS the name order).
 *
 * Returns {error} or a planImport-shaped plan (apply with importBankOp), with
 * `duplicate: {ptr, slot}` naming the copy.
 */
export function planDuplicateSample(destDoc, sample, nameBytes = new Uint8Array(0)) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  if (!sample || sample.len <= 0) return { error: "The selected sample is empty." };

  const taken = new Set(destDoc.usedInstrumentSlots());
  let slot = 1;
  while (slot <= 255 && taken.has(slot)) slot++;
  if (slot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }

  // One fresh span per channel. A stereo pair that only got one new span would
  // be half a duplicate sharing half the original.
  const census = destDoc.sampleList();
  const extents = freeExtents(census, destDoc.sampleRegions());
  const spans = sampleSpans(sample);
  const samples = [];
  const newPtrs = [];
  for (const sp of spans) {
    const ptr = carveFirstFit(extents, sp.len);
    if (ptr === null) {
      return { error: `Sample pool full: needs ${sp.len} more bytes and no free extent is large enough.` };
    }
    newPtrs.push(ptr);
    samples.push({
      ptr,
      bytes: Uint8Array.from(destDoc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len)),
      srcKeys: [],
    });
  }

  const rate = Math.max(1, Math.min(0xffff, Math.round(sample.rate) || 0));
  const record = buildFreshInstRecord({
    samplePtr: newPtrs[0],
    sampleLength: sample.len,
    samplingRate: rate,
    sampleLoopStart: sample.loopStart & 0xffff,
    sampleLoopEnd: sample.loopEnd & 0xffff,
    loopMode: sample.loopMode & 0x17,
  });
  const stereo = newPtrs.length > 1;
  const ixmpBlob = stereo
    ? writePatchesBlob([makeInstPatch({
        pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
        samplePtr: newPtrs[0], sampleLength: sample.len, playStart: 0,
        loopStart: sample.loopStart & 0xffff, loopEnd: sample.loopEnd & 0xffff,
        samplingRate: rate, loopMode: sample.loopMode & 0x07,
        hasChanBlock: true, chanCount: newPtrs.length,
        chanMode: sample.chanMode ?? CHAN_MODE_DISCRETE,
        chanPtrs: newPtrs.slice(1),
      })])
    : null;

  // INam: splice the instrument name in by slot.
  const destInamPayload = sectionPayload(destDoc, "INam");
  let inamPayload = null;
  if (nameBytes.length > 0 || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    while (parts.length <= slot) parts.push(new Uint8Array(0));
    parts[slot] = nameBytes;
    inamPayload = joinNameTable(parts);
  }

  // SNam: the census gains an entry, so every existing name has to be re-pinned
  // to its (ptr:len) identity before the payload is rebuilt from the new order.
  const snamNames = new Map();
  const destSnam = splitNameTable(sectionPayload(destDoc, "SNam"));
  census.forEach((e, i) => snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
  snamNames.set(sampleKey(newPtrs[0], sample.len), nameBytes);

  return {
    insts: [{ srcSlot: -1, destSlot: slot, topLevel: true, record, ixmpBlob, ixmpCount: stereo ? 1 : 0 }],
    samples,
    inamPayload,
    snamNames,
    writeSnam: true,
    slotMap: new Map([[-1, slot]]),
    newSampleBytes: sample.len * newPtrs.length,
    dedupedSamples: 0,
    duplicate: { ptr: newPtrs[0], slot },
  };
}

// ── in-place sample replace (item 109) ──

/** Remove [ptr, ptr+len) from a free-extent list; false when no single extent
 *  covers it. Mutates `extents` (splitting the coverer in two). */
function carveExtent(extents, ptr, len) {
  const i = extents.findIndex((x) => x.ptr <= ptr && x.ptr + x.len >= ptr + len);
  if (i < 0) return false;
  const e = extents[i];
  const parts = [];
  if (ptr > e.ptr) parts.push({ ptr: e.ptr, len: ptr - e.ptr });
  const tail = e.ptr + e.len - (ptr + len);
  if (tail > 0) parts.push({ ptr: ptr + len, len: tail });
  extents.splice(i, 1, ...parts);
  return true;
}

/** First-fit `len` bytes out of the free-extent list; null when nothing fits. */
function carveFirstFit(extents, len) {
  const e = extents.find((x) => x.len >= len);
  if (!e) return null;
  const ptr = e.ptr;
  carveExtent(extents, ptr, len);
  return ptr;
}

/** [ptr, ptr+len) minus the `holes` intervals, as a list of {ptr, len}. */
function rangeMinus(ptr, len, holes) {
  let parts = [{ ptr, len }];
  for (const [ha, hb] of holes) {
    const next = [];
    for (const p of parts) {
      const a = p.ptr, b = p.ptr + p.len;
      if (hb <= a || ha >= b) { next.push(p); continue; }
      if (ha > a) next.push({ ptr: a, len: ha - a });
      if (hb < b) next.push({ ptr: hb, len: b - hb });
    }
    parts = next;
  }
  return parts;
}

/**
 * Plan replacing a POOLED sample's audio IN PLACE (item 109) — the Sample Lab's
 * other commit, next to planMultiSampleImport's "import as new". Every
 * instrument and Ixmp patch bound to the sample follows it, so this is the edit
 * that reaches the music already written with it.
 *
 * The length may change (that is the whole point of doing it from the Lab): the
 * new bytes reuse the old span when they fit and first-fit a free extent when
 * they don't, and every reference is rewritten — base records' bytes 0..13 and
 * the matching patches' ptr/len/rate/markers, including a stereo patch's second
 * channel pointer. `mapPos` carries the play/loop markers through whatever the
 * Lab did to the waveform (crop shifts them, cut closes over them); the default
 * scales them proportionally, which is exactly right for a pure resample.
 *
 * Refused, rather than guessed at:
 *   * turning a MONO pooled sample stereo — an instrument only plays a pair
 *     through an Ixmp 's' patch, and synthesising a full-range patch for a slot
 *     that had none would silently take over its vibrato and pan defaults.
 *     Import as new does this properly.
 *   * a length change under a pool where some OTHER sample's span overlaps this
 *     one — moving or shortening these bytes would corrupt that sample.
 * Going the other way (stereo → mono) is fine: the 's' block is simply dropped.
 *
 * Returns {error} or a planImport-shaped plan — apply it with importBankOp, so
 * one undo step puts every pointer, byte and name back.
 */
export function planReplaceSample(destDoc, sample, { pcm, pcmR = null, rate, nameBytes = null, mapPos = null }) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  if (!sample || !(sample.len > 0)) return { error: "The selected sample is empty." };
  if (!pcm || pcm.length === 0) return { error: "The edited sample is empty." };
  if (pcm.length > 0xffff) {
    return { error: `Sample too long: ${pcm.length} bytes (65535 max) — resample it first.` };
  }
  if (pcmR && pcmR.length !== pcm.length) return { error: "Stereo channels must be the same length." };

  const oldSpans = sampleSpans(sample);
  const oldLen = sample.len;
  const newLen = pcm.length;
  const newChanCount = pcmR ? 2 : 1;
  if (newChanCount > oldSpans.length) {
    return { error: "A mono sample can't be replaced by a stereo one in place — import it as a new instrument instead." };
  }
  const newRate = Math.max(1, Math.min(0xffff, Math.round(rate) || 0));
  const moves = newLen !== oldLen || newChanCount !== oldSpans.length;

  // ── pool: the old spans go back to the free list, then the new ones are
  //    carved out of it (preferring the addresses they already had) ──
  const census = destDoc.sampleList();
  const isTarget = (e) => e.ptr === sample.ptr && e.len === oldLen;
  const others = census.filter((e) => !isTarget(e));
  const oldIvs = oldSpans.map((sp) => [sp.ptr, sp.ptr + sp.len]);
  if (moves && others.some((e) => sampleSpans(e).some((sp) =>
    oldIvs.some(([a, b]) => sp.ptr < b && a < sp.ptr + sp.len)))) {
    return { error: "Another sample shares these pool bytes — only an edit that keeps the length can be applied in place." };
  }
  const extents = freeExtents(others, destDoc.sampleRegions(), oldSpans);
  const alloc = (preferPtr) =>
    (carveExtent(extents, preferPtr, newLen) ? preferPtr : carveFirstFit(extents, newLen));
  const newPtrs = [alloc(sample.ptr)];
  if (newChanCount === 2) newPtrs.push(alloc(oldSpans[1].ptr));
  if (newPtrs.some((p) => p === null)) {
    return { error: `Sample pool full: needs ${newLen * newChanCount} bytes and no free extent is large enough.` };
  }

  // Pool writes: free (zero) whatever the old spans keep that the new ones do
  // not cover, THEN lay the new bytes down — applyPlan writes in order.
  const newIvs = newPtrs.map((p) => [p, p + newLen]);
  const samples = [];
  for (const sp of oldSpans) {
    for (const gap of rangeMinus(sp.ptr, sp.len, newIvs)) {
      samples.push({ ptr: gap.ptr, bytes: new Uint8Array(gap.len), srcKeys: [], nameBytes: new Uint8Array(0) });
    }
  }
  const chanBytes = pcmR ? [pcm, pcmR] : [pcm];
  newPtrs.forEach((ptr, i) => {
    samples.push({ ptr, bytes: Uint8Array.from(chanBytes[i]), srcKeys: [], nameBytes: new Uint8Array(0) });
  });

  // ── markers: original frame index → new frame index ──
  const map = mapPos ?? ((p) => (p * newLen) / oldLen);
  const mark = (p) => Math.max(0, Math.min(newLen, Math.round(map(Math.max(0, Math.min(oldLen, p))))));

  // ── references: base records and Ixmp patches bound to the old span ──
  const bindsOld = (o) => o.samplePtr === sample.ptr && o.sampleLength === oldLen;
  const insts = [];
  const userSlots = [];
  let clampedLoops = 0;
  for (const slot of destDoc.usedInstrumentSlots()) {
    const inst = destDoc.instruments[slot];
    // A formant instrument (item 212) is bound by its source and by any consonant
    // slot's noise; its pointers live in the block, its header where an
    // ordinary record's pointer is. A slot's speed scales with the sample's
    // rate, as the source's C4 rate does, so a resample keeps both in tune.
    if (inst.isFormant) {
      const record = destDoc.instRecordBytes(slot);
      const spans = formantRecordSpans(record).filter((sp) => sp.ptr === sample.ptr && sp.len === oldLen);
      if (spans.length === 0) continue;
      userSlots.push(slot);
      const u16 = (o, v) => { record[o] = v & 0xff; record[o + 1] = (v >>> 8) & 0xff; };
      const u24 = (o, v) => { record[o] = v & 0xff; record[o + 1] = (v >>> 8) & 0xff; record[o + 2] = (v >>> 16) & 0xff; };
      const scale = sample.rate > 0 ? newRate / sample.rate : 1;
      const rateOf = (r) => Math.max(1, Math.min(0xffff, Math.round(r * scale)));
      for (const sp of spans) {
        u24(sp.at, newPtrs[0]);
        if (sp.role === "source") {
          const loopStart = mark(inst.sampleLoopStart);
          const loopEnd = Math.max(loopStart, mark(inst.sampleLoopEnd));
          if ((inst.loopMode & 3) !== 0 && loopEnd <= loopStart) clampedLoops++;
          u16(4, newLen);
          u16(6, rateOf(inst.samplingRate));
          u16(8, mark(inst.samplePlayStart));
          u16(10, loopStart);
          u16(12, loopEnd);
        } else {
          const s = inst.formant.slots[sp.role];
          u16(sp.at + 3, newLen);
          u16(sp.at + 5, Math.min(newLen - 1, mark(s.offset)));
          u16(sp.at + 7, rateOf(s.rate));
        }
      }
      insts.push({ srcSlot: -(insts.length + 1), destSlot: slot, topLevel: true, record, ixmpBlob: null, ixmpCount: 0 });
      continue;
    }
    const baseHit = !inst.isMeta && bindsOld(inst);
    const patches = inst.extraPatches ?? [];
    const patchHits = patches.filter(bindsOld);
    if (!baseHit && patchHits.length === 0) continue;
    userSlots.push(slot);

    const record = destDoc.instRecordBytes(slot);
    if (baseHit) {
      const u32 = (o, v) => {
        record[o] = v & 0xff; record[o + 1] = (v >>> 8) & 0xff;
        record[o + 2] = (v >>> 16) & 0xff; record[o + 3] = (v >>> 24) & 0xff;
      };
      const u16 = (o, v) => { record[o] = v & 0xff; record[o + 1] = (v >>> 8) & 0xff; };
      const loopStart = mark(inst.sampleLoopStart);
      const loopEnd = Math.max(loopStart, mark(inst.sampleLoopEnd));
      if ((inst.loopMode & 3) !== 0 && loopEnd <= loopStart) clampedLoops++;
      u32(0, newPtrs[0]);
      u16(4, newLen);
      u16(6, newRate);
      u16(8, mark(inst.samplePlayStart));
      u16(10, loopStart);
      u16(12, loopEnd);
    }

    // A slot listed here has its WHOLE patch list replaced by applyPlan, so an
    // untouched list is passed back verbatim rather than re-encoded.
    const entry = [...destDoc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === slot);
    let ixmpBlob = entry ? Uint8Array.from(entry.blob) : null;
    let ixmpCount = entry?.count ?? 0;
    if (patchHits.length > 0) {
      const next = patches.map((p) => ({ ...p, chanPtrs: [...p.chanPtrs] }));
      for (const p of next) {
        if (!bindsOld(p)) continue;
        const loopStart = mark(p.loopStart);
        const loopEnd = Math.max(loopStart, mark(p.loopEnd));
        if ((p.loopMode & 3) !== 0 && loopEnd <= loopStart) clampedLoops++;
        p.samplePtr = newPtrs[0];
        p.sampleLength = newLen;
        p.samplingRate = newRate;
        p.playStart = mark(p.playStart);
        p.loopStart = loopStart;
        p.loopEnd = loopEnd;
        // Only a patch that ALREADY carried an 's' block follows the channel
        // count — a mono patch on the same span stays mono.
        if (p.hasChanBlock) {
          if (newChanCount === 2) p.chanPtrs = [newPtrs[1], ...p.chanPtrs.slice(1)];
          else { p.hasChanBlock = false; p.chanCount = 1; p.chanPtrs = []; }
        }
      }
      ixmpBlob = writePatchesBlob(next);
      ixmpCount = next.length;
    }
    insts.push({ srcSlot: -(insts.length + 1), destSlot: slot, topLevel: true, record, ixmpBlob, ixmpCount });
  }

  // ── SNam: the census keys by (ptr:len), so a moved or resized sample carries
  //    its name across to the new identity (and takes a rename with it) ──
  const snamNames = new Map();
  const destSnamPayload = sectionPayload(destDoc, "SNam");
  const destSnam = splitNameTable(destSnamPayload);
  census.forEach((e, i) => snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
  const oldName = snamNames.get(sampleKey(sample.ptr, oldLen)) ?? new Uint8Array(0);
  const name = nameBytes ?? oldName;
  snamNames.set(sampleKey(newPtrs[0], newLen), name);

  return {
    insts,
    samples,
    inamPayload: null,
    snamNames,
    writeSnam: name.length > 0 || destSnamPayload !== null,
    slotMap: new Map(),
    newSampleBytes: newLen * newChanCount,
    dedupedSamples: 0,
    // report (the Lab's confirm dialog)
    ptr: newPtrs[0],
    chanPtrs: newPtrs.slice(1),
    len: newLen,
    rate: newRate,
    oldLen,
    moved: newPtrs[0] !== sample.ptr,
    droppedChannel: newChanCount < oldSpans.length,
    userSlots,
    clampedLoops,
  };
}

// ── metainstrument construction (items 72 + 113) ──
//
// A layer child lives at $100+, where nothing but a layer table can reach it,
// and shares its source's sample pointers — so a layer costs one slot out of
// 768 and zero pool bytes. `picks` throughout are either bare slot numbers
// (repeats allowed) or {slot, count} pairs; N of the same source becomes ONE
// child copy carrying N LINKED layers, which is what a unison/chord stack wants
// (retune the piano once and all its voices follow). Splitting one layer off its
// shared child is planUnlinkMetaLayer.

/** Collapse `picks` to Map<slot, layerCount>, dropping anything unused. */
function normalisePicks(picks, used) {
  const counts = new Map();
  for (const p of picks ?? []) {
    const slot = typeof p === "number" ? p : p?.slot;
    const n = typeof p === "number" ? 1 : Math.round(Number(p?.count ?? 1)) || 0;
    if (!Number.isInteger(slot) || !used.has(slot) || n <= 0) continue;
    counts.set(slot, (counts.get(slot) ?? 0) + n);
  }
  return counts;
}

/** Lowest free sub-instrument slot at $100+; adds it to `taken`. */
function allocChildSlot(taken) {
  for (let c = 0x100; c <= 0x3ff; c++) {
    if (!taken.has(c)) { taken.add(c); return c; }
  }
  return -1;
}

/** A plan entry copying `src`'s record + Ixmp blob into `dest` — a layer child
 *  unless `topLevel`. The copy keeps the source's pool pointers verbatim, so it
 *  costs one instrument slot and zero sample bytes. */
function copyEntry(doc, src, dest, topLevel = false) {
  const blob = [...doc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === src);
  return {
    srcSlot: src,
    destSlot: dest,
    topLevel,
    record: doc.instRecordBytes(src),
    ixmpBlob: blob ? blob.blob : null,
    ixmpCount: blob ? blob.count : 0,
  };
}

/** INam payload with `entries` ([[slot, text], …]) spliced in by slot. */
function inamPayloadWith(doc, entries) {
  const parts = splitNameTable(sectionPayload(doc, "INam"));
  const enc = new TextEncoder();
  for (const [slot, text] of entries) {
    while (parts.length <= slot) parts.push(new Uint8Array(0));
    parts[slot] = enc.encode(text);
  }
  return joinNameTable(parts);
}

/** The planImport-shaped envelope every meta plan here returns. */
function metaPlan(insts, inamPayload, extra) {
  return {
    insts,
    samples: [],
    inamPayload,
    snamNames: new Map(),
    writeSnam: false, // copies reuse existing (ptr:len) spans — census unchanged
    slotMap: new Map(insts.map((it) => [it.srcSlot, it.destSlot])),
    newSampleBytes: 0,
    dedupedSamples: 0,
    ...extra,
  };
}

/**
 * Plan a new metainstrument built from instruments already in this project
 * (item 72). Each picked instrument is COPIED into a fresh sub-instrument slot
 * ($100+, which pattern cells can't address) and the copies become the layers,
 * so the picked originals stay in $01–$FF — selectable, jammable and still valid
 * in every pattern cell that references them.
 *
 * A pick must not be a metainstrument (layers resolve through triggerNote, which
 * never re-enters the meta branch — see buildMetaRecord). Picking the same
 * instrument N times gives N linked layers (item 113): one copy, N voices.
 * `name` is the escaped INam text for the new meta.
 * Returns {error} or a planImport-shaped plan (apply with importBankOp).
 */
export function planCreateMeta(destDoc, picks, name = "") {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const used = new Set(destDoc.usedInstrumentSlots());
  const counts = normalisePicks(picks, used);
  if (counts.size === 0) return { error: "No instruments selected." };
  if ([...counts.keys()].some((s) => destDoc.instruments[s].isMeta)) {
    return { error: "A metainstrument can't be layered inside another metainstrument." };
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total > META_MAX_LAYERS) {
    return { error: `A metainstrument holds at most ${META_MAX_LAYERS} layers (${total} selected).` };
  }

  // The meta itself must stay note-addressable ($01–$FF); its layer copies go
  // to $100+ ascending, where only a layer table can reach them.
  const taken = new Set(used);
  let metaSlot = 1;
  while (metaSlot <= 255 && taken.has(metaSlot)) metaSlot++;
  if (metaSlot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }
  taken.add(metaSlot);

  const insts = [];
  const layers = [];
  for (const [src, n] of counts) {
    const child = allocChildSlot(taken);
    if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
    insts.push(copyEntry(destDoc, src, child));
    // Full-rect layers at unity mix, no detune: every layer sounds on every
    // trigger until the user narrows it on the Layers tab.
    for (let k = 0; k < n; k++) layers.push(makeMetaLayer(child, 159, 0, 0x0000, 0xffff, 0, 63));
  }
  insts.push({
    srcSlot: -1,
    destSlot: metaSlot,
    topLevel: true,
    record: buildMetaRecord(layers),
    ixmpBlob: null,
    ixmpCount: 0,
  });

  // INam: the meta's name by slot; each copy inherits its source's name so the
  // layer table reads meaningfully.
  const names = insts.filter((it) => it.srcSlot >= 0)
    .map((it) => [it.destSlot, destDoc.instrumentName(it.srcSlot)]);
  names.push([metaSlot, name]);

  return metaPlan(insts, inamPayloadWith(destDoc, names), {
    metaSlot,
    childSlots: insts.filter((it) => it.srcSlot >= 0).map((it) => it.destSlot),
  });
}

/**
 * Plan a layered metainstrument for a CHORD STACK (item 242): `layers` is
 * [{slot, detune}] in table order, the first being the foreground layer. The
 * same copy-into-$100+ rule as planCreateMeta, with each instrument copied
 * once however many layers sound it (linked, item 113), and every layer at
 * unity mix over the full rectangle. The meta is marked percussion when every
 * layer's instrument is. Returns {error} or a planImport-shaped plan.
 */
export function planChordMeta(destDoc, layers, name = "") {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const used = new Set(destDoc.usedInstrumentSlots());
  if (!layers?.length) return { error: "No instruments selected." };
  if (layers.length > META_MAX_LAYERS) {
    return { error: `A metainstrument holds at most ${META_MAX_LAYERS} layers (${layers.length} selected).` };
  }
  if (layers.some((l) => !used.has(l.slot) || destDoc.instruments[l.slot].isMeta)) {
    return { error: "A metainstrument can't be layered inside another metainstrument." };
  }
  const taken = new Set(used);
  let metaSlot = 1;
  while (metaSlot <= 255 && taken.has(metaSlot)) metaSlot++;
  if (metaSlot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }
  taken.add(metaSlot);

  const insts = [];
  const childOf = new Map();
  for (const { slot } of layers) {
    if (childOf.has(slot)) continue;
    const child = allocChildSlot(taken);
    if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
    childOf.set(slot, child);
    insts.push(copyEntry(destDoc, slot, child));
  }
  const table = layers.map((l) => makeMetaLayer(childOf.get(l.slot), 159, l.detune, 0x0000, 0xffff, 0, 63));
  const percussion = layers.every((l) => destDoc.instruments[l.slot].isPercussion);
  insts.push({
    srcSlot: -1,
    destSlot: metaSlot,
    topLevel: true,
    record: buildMetaRecord(table, { percussion }),
    ixmpBlob: null,
    ixmpCount: 0,
  });
  const names = insts.filter((it) => it.srcSlot >= 0)
    .map((it) => [it.destSlot, destDoc.instrumentName(it.srcSlot)]);
  names.push([metaSlot, name]);
  return metaPlan(insts, inamPayloadWith(destDoc, names), {
    metaSlot,
    childSlots: insts.filter((it) => it.srcSlot >= 0).map((it) => it.destSlot),
  });
}

/**
 * Plan a new type-4 FM rack (item 159) out of instruments already in the
 * project — planCreateMeta's twin, and deliberately the same copy-into-$100+
 * shape, because an operator is an ordinary instrument in every respect the
 * bank cares about.
 *
 * `picks` are read in ORDER and each count expands in place, so what the picker
 * shows top to bottom is the rack top to bottom, and operator 0 — the principal
 * whose envelope is the note's — is the first thing picked. The algorithm it
 * starts with is the plain chain (defaultFmProgram): the last operator into the
 * one before it, all the way down into operator 0.
 */
export function planCreateFm(destDoc, picks, name = "") {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const used = new Set(destDoc.usedInstrumentSlots());
  const counts = normalisePicks(picks, used);
  if (counts.size === 0) return { error: "No instruments selected." };
  if ([...counts.keys()].some((s) => destDoc.instruments[s].isMeta)) {
    return { error: "A metainstrument can't be an FM operator." };
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total > FM_MAX_OPERATORS) {
    return { error: `An FM rack holds at most ${FM_MAX_OPERATORS} operators (${total} selected).` };
  }

  const taken = new Set(used);
  let metaSlot = 1;
  while (metaSlot <= 255 && taken.has(metaSlot)) metaSlot++;
  if (metaSlot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }
  taken.add(metaSlot);

  const insts = [];
  const ops = [];
  for (const [src, n] of counts) {
    const child = allocChildSlot(taken);
    if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
    insts.push(copyEntry(destDoc, src, child));
    // Full-rect operators at unity mix and no detune: a rack that sounds the
    // moment it is made, with every operator in the game until the user tunes
    // one out of it.
    for (let k = 0; k < n; k++) ops.push(makeMetaLayer(child, 159, 0, 0x0000, 0xffff, 0, 63));
  }
  insts.push({
    srcSlot: -1,
    destSlot: metaSlot,
    topLevel: true,
    record: buildMetaRecord(ops, { type: META_TYPE_FM, program: defaultFmProgram(ops.length) }),
    ixmpBlob: null,
    ixmpCount: 0,
  });

  const names = insts.filter((it) => it.srcSlot >= 0)
    .map((it) => [it.destSlot, destDoc.instrumentName(it.srcSlot)]);
  names.push([metaSlot, name]);

  return metaPlan(insts, inamPayloadWith(destDoc, names), {
    metaSlot,
    childSlots: insts.filter((it) => it.srcSlot >= 0).map((it) => it.destSlot),
  });
}

// ── FM Easy Mode (item 247) ─────────────────────────────────────────────────
//
// An Easy rack makes its own instruments: a sine for every operator, a
// constant 1.0 for its principal and one more for the depth of its feedback
// loops. Each operator has an instrument of its OWN, since its volume envelope
// is what shapes it; the loops share one constant, and so may racks — a
// constant has nothing to edit. Both waveforms dedupe against the pool, so a
// project spends 256 + 16 bytes on them however many racks it has.

const EASY_DC_FRAMES = 16;

/** A looped single-cycle record over `ptr` (fmeasy's waveforms). */
function easyCycleRecord(ptr, frames) {
  const { samplingRate, detune } = easyCycleTuning(frames);
  return buildFreshInstRecord({
    samplePtr: ptr, sampleLength: frames, samplingRate,
    sampleLoopEnd: frames, loopMode: 1, sampleDetune: detune,
  });
}

/**
 * A constant's record: 1.0 for ever, and nothing else about it. Its rate is
 * 0, so it never moves off its first frame: the interpolator reads a constant
 * exactly only where it reads no fraction, and a sinc read BETWEEN frames
 * comes out a few tenths of a percent low, rippling with the note's pitch.
 */
function easyConstRecord(ptr) {
  return buildFreshInstRecord({
    samplePtr: ptr, sampleLength: EASY_DC_FRAMES, samplingRate: 0,
    sampleLoopEnd: EASY_DC_FRAMES, loopMode: 1,
  });
}

/** A fresh principal's record: the constant, with a release, so a note
 *  rings out after its key is let go instead of holding for ever. */
function easyPrincipalRecord(ptr) {
  const r = easyConstRecord(ptr);
  r[172] = EASY_PRINCIPAL_FADEOUT & 0xff;
  r[173] = (r[173] & 0xf0) | ((EASY_PRINCIPAL_FADEOUT >>> 8) & 0x0f);
  return r;
}

/**
 * Plan an Easy Mode rack (fmeasy.js model) into `metaSlot`, or into a new
 * top-level slot named `name` when `metaSlot` is null: every operator the
 * model has no instrument for gets a fresh sine, a new rack a fresh principal,
 * and loops that need a depth the rack's constant (or one already in the
 * project, or a fresh one). The record is written with its Easy Mode bit, its
 * other flags and IMix id kept. Returns {error} or a planImport-shaped plan
 * with `metaSlot`, `childSlots` and the filled `model`.
 */
export function planEasyFm(destDoc, metaSlot, model, name = "") {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const used = new Set(destDoc.usedInstrumentSlots());
  const taken = new Set(used);
  let slot = metaSlot;
  if (slot === null) {
    slot = 1;
    while (slot <= 255 && taken.has(slot)) slot++;
    if (slot > 255) return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
    taken.add(slot);
  }
  const inst = metaSlot === null ? null : destDoc.instruments[metaSlot];
  const needs = easyNeeds(model);
  const needPrincipal = (model.principal.instIdx & 0x3ff) === 0;

  const pool = poolPlacer(destDoc);
  const place = (pcm) => {
    const r = pool.place(pcm, new Uint8Array(0));
    if (r.error) throw new Error(r.error);
    return r.ptr;
  };
  const insts = [];
  const names = [];
  const child = (record, label) => {
    const c = allocChildSlot(taken);
    if (c < 0) throw new Error("No free sub-instrument slots left in $100–$3FF.");
    insts.push({ srcSlot: -(insts.length + 1), destSlot: c, topLevel: false, record, ixmpBlob: null, ixmpCount: 0 });
    names.push([c, label]);
    return c;
  };

  let filled;
  try {
    const sinePtr = needs.osc.length > 0 ? place(easySinePcm(EASY_SINE_FRAMES)) : -1;
    const dcPtr = needPrincipal || needs.constant ? place(easyDcPcm(EASY_DC_FRAMES)) : -1;
    const oscSlots = needs.osc.map((i) => child(easyCycleRecord(sinePtr, EASY_SINE_FRAMES), `FM op ${i}`));
    let constSlot = needs.constSlot;
    if (needs.constant) {
      // A constant is the same record wherever it is, so one already in the
      // project (another Easy rack's) is this rack's too.
      const rec = easyConstRecord(dcPtr);
      constSlot = 0;
      for (const s of used) {
        if (s < 0x100 || destDoc.instruments[s].isMeta) continue;
        if (bytesEqual(destDoc.instRecordBytes(s), rec)) { constSlot = s; break; }
      }
      if (constSlot === 0) constSlot = child(rec, "FM const");
    }
    filled = easyFill(model, oscSlots, constSlot);
    if (needPrincipal) filled.principal.instIdx = child(easyPrincipalRecord(dcPtr), "FM out");
  } catch (e) {
    return { error: e.message };
  }

  const { ops, program } = easyCompile(filled);
  const verdict = fmValidate(program, ops.length);
  if (ops.length > FM_MAX_OPERATORS || !verdict.ok) {
    return { error: verdict.error === "budget" || ops.length > FM_MAX_OPERATORS
      ? "This wiring does not fit in an FM rack's record." : "This wiring does not make a valid algorithm." };
  }
  const flags = inst ? metaFlags(inst) : { percussion: false, imixId: 0 };
  insts.push({
    srcSlot: -1000,
    destSlot: slot,
    topLevel: true,
    record: buildMetaRecord(ops, {
      type: META_TYPE_FM, program, easy: true,
      percussion: flags.percussion, imixId: flags.imixId,
    }),
    ixmpBlob: null,
    ixmpCount: 0,
  });
  if (metaSlot === null) names.push([slot, name]);

  return {
    insts,
    samples: pool.samples,
    inamPayload: inamPayloadWith(destDoc, names),
    ...pool.snam(false),
    slotMap: new Map(insts.map((it) => [it.srcSlot, it.destSlot])),
    newSampleBytes: pool.newSampleBytes(),
    dedupedSamples: pool.dedupedSamples(),
    metaSlot: slot,
    childSlots: insts.filter((it) => !it.topLevel).map((it) => it.destSlot),
    model: filled,
  };
}

/**
 * What it takes to put an ordinary rack into Easy Mode: {kind: "flag"} when it
 * already reads as one (only the bit is missing), {kind: "wrap", plan} when it
 * can be made one, or {error, reason} (reason an fmeasy decode reason).
 *
 * Wrapping puts a new principal in front of the rack, the whole patch
 * multiplied by it. The old principal's SHARED part — its envelopes but a
 * pitch one, its filter, fadeout, global volume, swing, attenuation, note
 * actions, pan and mixing chain — moves onto the new one, which the mixer
 * then applies to the finished patch exactly as it applied the old one's; the
 * old principal stays where it was as an operator, on a copy of its instrument
 * with all of that taken off. So the patch sounds as it did. Per-zone
 * envelopes in the old principal's keyboard map stay on the operator, where
 * they now shape it alone.
 */
export function planEasyConvert(destDoc, metaSlot) {
  const inst = destDoc.instruments[metaSlot];
  if (!inst?.isFm) return { error: "Not an FM rack.", reason: "invalid" };
  const ops = fmOperators(inst);
  const program = fmProgramOf(inst);
  const asIs = easyDecode(ops, program);
  if (asIs.ok) return { kind: "flag" };

  const shifted = program.map((w) => (w >= 0xff00 ? w : (w & ~0x3ff) | ((w & 0x3ff) + 1)));
  const wrappedProg = [...shifted, FM_WORD_OSC | 0, FmOp.MUL];
  const p0 = ops[0];
  const wrappedOps = [{ ...p0, mixOctet: OCTET_UNITY, detune: 0 }, ...ops];
  const decoded = easyDecode(wrappedOps, wrappedProg);
  if (!decoded.ok) return { error: "This rack can't be shown in Easy Mode.", reason: decoded.reason };
  if (wrappedOps.length > FM_MAX_OPERATORS || !fmValidate(wrappedProg, wrappedOps.length).ok) {
    return { error: "This rack has no room for a principal.", reason: "full" };
  }
  const src = p0.instIdx & 0x3ff;
  if (src === 0) return { error: "This rack has no principal operator.", reason: "invalid" };

  const old = destDoc.instRecordBytes(src);
  const used = new Set(destDoc.usedInstrumentSlots());
  const taken = new Set(used);
  const pool = poolPlacer(destDoc);
  const dc = pool.place(easyDcPcm(EASY_DC_FRAMES), new Uint8Array(0));
  if (dc.error) return { error: dc.error, reason: "pool" };

  // The new principal: a constant carrying everything shared.
  const principal = easyConstRecord(dc.ptr);
  const copy = (from, to) => { for (let b = from; b <= to; b++) principal[b] = old[b]; };
  principal[14] = (principal[14] & 0x0f) | (old[14] & 0x30); // percussion, azimuth
  copy(15, 18);   // volume and pan LOOP words
  copy(21, 120);  // volume and pan nodes
  copy(171, 174); // global volume, fadeout + filter mode, volume swing
  copy(177, 183); // default pan, pitch-pan, pan swing, cutoff, resonance
  principal[186] = (principal[186] & ~0x23) | (old[186] & 0x23); // the New Note Action
  copy(189, 192); // volume and pan SUSTAIN words
  copy(195, 196); // Duplicate Check, default note volume
  copy(251, 255); // attenuation, SoundFont filter bits, elevation, IMix
  // …and a pitch/filter slot whose role is the FILTER. A chip instrument's
  // second slot is its patch, and a formant's its tract: neither is a slot.
  const chip = destDoc.instruments[src].isOpl || destDoc.instruments[src].isPsg;
  const slots = chip ? [[19, 121, 193]] : [[19, 121, 193], [197, 201, 199]];
  const isFilter = (loop) => ((loop >>> 7) & 1) === 1 && ((loop >>> 13) & 1) === 1;
  const word = (r, o) => r[o] | (r[o + 1] << 8);
  for (const [loop, nodes, sus] of slots) {
    if (!isFilter(word(old, loop))) continue;
    for (let b = 0; b < 2; b++) { principal[loop + b] = old[loop + b]; principal[sus + b] = old[sus + b]; }
    for (let b = 0; b < 50; b++) principal[nodes + b] = old[nodes + b];
  }

  // The old principal, as an operator: the same record with the shared part off.
  const op = Uint8Array.from(old);
  const clearPresent = (o) => { op[o + 1] &= ~0x20; };
  clearPresent(15); // volume envelope absent
  clearPresent(17); // pan envelope absent
  for (const [loop] of slots) if (isFilter(word(old, loop))) clearPresent(loop);
  op[171] = 0xff;                // full global volume
  op[172] = 0;                   // no fadeout…
  op[173] &= 0xf0;               // …keeping the filter-mode bits
  op[174] = 0;                   // no volume swing
  op[182] = 0xff;                // filter off
  op[183] = 0;
  op[251] = 0;                   // unity attenuation
  op[252] = 0; op[253] = 0;
  op[255] = 0;                   // no mixing chain of its own

  const pSlot = allocChildSlot(taken);
  const oSlot = allocChildSlot(taken);
  if (pSlot < 0 || oSlot < 0) return { error: "No free sub-instrument slots left in $100–$3FF.", reason: "slots" };
  const blob = [...destDoc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === src);
  wrappedOps[0] = { ...wrappedOps[0], instIdx: pSlot };
  wrappedOps[1] = { ...wrappedOps[1], instIdx: oSlot };
  const flags = metaFlags(inst);
  const insts = [
    { srcSlot: -1, destSlot: pSlot, topLevel: false, record: principal, ixmpBlob: null, ixmpCount: 0 },
    { srcSlot: -2, destSlot: oSlot, topLevel: false, record: op,
      ixmpBlob: blob ? blob.blob : null, ixmpCount: blob ? blob.count : 0 },
    { srcSlot: -1000, destSlot: metaSlot, topLevel: true, ixmpBlob: null, ixmpCount: 0,
      record: buildMetaRecord(wrappedOps, {
        type: META_TYPE_FM, program: wrappedProg, easy: true,
        percussion: flags.percussion, imixId: flags.imixId,
      }) },
  ];
  const opName = destDoc.instrumentName(src);
  return {
    kind: "wrap",
    plan: {
      insts,
      samples: pool.samples,
      inamPayload: inamPayloadWith(destDoc, [[pSlot, "FM out"], [oSlot, opName]]),
      ...pool.snam(false),
      slotMap: new Map(insts.map((it) => [it.srcSlot, it.destSlot])),
      newSampleBytes: pool.newSampleBytes(),
      dedupedSamples: pool.dedupedSamples(),
      metaSlot,
      childSlots: [pSlot, oSlot],
    },
  };
}

/**
 * Plan a new OPL instrument (item 209): one type-8 record (TAUD_FILE_FORMAT §7.8) in
 * the first free top-level slot. Nothing is copied and no child is made — the
 * patch IS the instrument. Any other kind that is one record and nothing else
 * (a PSG instrument, §7.9; a formant instrument, §7.6) is planned the same way. `record` is the whole 256-byte record; `name` the
 * escaped INam text. Returns {error} or a planImport-shaped plan.
 */
export function planCreateOpl(destDoc, record, name = "") {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const used = new Set(destDoc.usedInstrumentSlots());
  let slot = 1;
  while (slot <= 255 && used.has(slot)) slot++;
  if (slot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }
  const insts = [{
    srcSlot: -1, destSlot: slot, topLevel: true, record, ixmpBlob: null, ixmpCount: 0,
  }];
  return metaPlan(insts, inamPayloadWith(destDoc, [[slot, name]]), {
    metaSlot: slot,
    childSlots: [],
  });
}

/**
 * Append layers to an EXISTING metainstrument (item 113) — the Layers tab's
 * "Add layers…". Same copy-into-a-child rule as planCreateMeta; the meta's
 * current table is kept and the new layers land after it, so the foreground
 * layer (record order 0) doesn't change under the user.
 */
export function planAddMetaLayers(destDoc, metaSlot, picks) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const meta = destDoc.instruments[metaSlot & 0x3ff];
  if (!meta?.isMeta) return { error: "That instrument is not a metainstrument." };
  const used = new Set(destDoc.usedInstrumentSlots());
  const counts = normalisePicks(picks, used);
  if (counts.size === 0) return { error: "No instruments selected." };
  if ([...counts.keys()].some((s) => destDoc.instruments[s].isMeta)) {
    return { error: "A metainstrument can't be layered inside another metainstrument." };
  }
  const existing = metaLayers(meta);
  const total = existing.length + [...counts.values()].reduce((a, b) => a + b, 0);
  // A rack's ceiling is lower than a layer table's, and it is not just a count:
  // the operators and the algorithm share the record's 250 bytes (§7.7).
  if (meta.isFm) {
    const words = meta.fmProgram === null ? 0 : meta.fmProgram.length;
    if (total > FM_MAX_OPERATORS) {
      return { error: `An FM rack holds at most ${FM_MAX_OPERATORS} operators (${total} would result).` };
    }
    if (fmRecordBytes(total, words) > FM_BUDGET_BYTES) {
      return { error: `That would not fit the record: ${total} operators and a ${words}-word algorithm need ` +
        `${fmRecordBytes(total, words)} of ${FM_BUDGET_BYTES} bytes.` };
    }
  } else if (total > META_MAX_LAYERS) {
    return { error: `A metainstrument holds at most ${META_MAX_LAYERS} layers (${total} would result).` };
  }

  const taken = new Set(used);
  const insts = [];
  const added = [];
  for (const [src, n] of counts) {
    const child = allocChildSlot(taken);
    if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
    insts.push(copyEntry(destDoc, src, child));
    for (let k = 0; k < n; k++) added.push(defaultLayer(child));
  }
  insts.push({
    srcSlot: -1,
    destSlot: metaSlot & 0x3ff,
    topLevel: true,
    record: metaRecordOf(meta, [...existing, ...added]),
    ixmpBlob: null,
    ixmpCount: 0,
  });

  const names = insts.filter((it) => it.srcSlot >= 0)
    .map((it) => [it.destSlot, destDoc.instrumentName(it.srcSlot)]);

  return metaPlan(insts, inamPayloadWith(destDoc, names), {
    metaSlot: metaSlot & 0x3ff,
    childSlots: insts.filter((it) => it.srcSlot >= 0).map((it) => it.destSlot),
    addedLayers: added.length,
  });
}

/**
 * Split layer `layerIdx` off the sub-instrument it SHARES with its siblings
 * (item 113): the child is copied into a fresh $100+ slot and only that one
 * layer is repointed, so editing it stops moving the other voices of the stack.
 * A layer that already owns its child outright has nothing to unlink.
 */
export function planUnlinkMetaLayer(destDoc, metaSlot, layerIdx) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const meta = destDoc.instruments[metaSlot & 0x3ff];
  if (!meta?.isMeta) return { error: "That instrument is not a metainstrument." };
  const layers = metaLayers(meta);
  if (layerIdx < 0 || layerIdx >= layers.length) return { error: "No such layer." };
  if (linkCount(layers, layerIdx) < 2) {
    return { error: "This layer already has its own sub-instrument." };
  }

  const src = layers[layerIdx].instIdx & 0x3ff;
  const taken = new Set(destDoc.usedInstrumentSlots());
  const child = allocChildSlot(taken);
  if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };

  const insts = [
    copyEntry(destDoc, src, child),
    {
      srcSlot: -1,
      destSlot: metaSlot & 0x3ff,
      topLevel: true,
      record: metaRecordOf(meta, repointLayer(layers, layerIdx, child)),
      ixmpBlob: null,
      ixmpCount: 0,
    },
  ];

  return metaPlan(insts, inamPayloadWith(destDoc, [[child, destDoc.instrumentName(src)]]), {
    metaSlot: metaSlot & 0x3ff,
    childSlots: [child],
    unlinkedFrom: src,
  });
}

/**
 * Plan a new formant instrument (§7.6) sung from the chip instrument `srcSlot`
 * (OPL or PSG) — the kind made with no samples at all: `record` is the
 * type-1 record, which this points at a copy of `srcSlot` in a fresh $100+
 * sub-instrument, as planSetFormantSource does for one already made. Both
 * land in one plan, so creating it is one undo step. Returns {error} or a
 * planImport-shaped plan.
 */
export function planCreateFormant(destDoc, record, name, srcSlot) {
  const plan = planCreateOpl(destDoc, record, name);
  if (plan.error) return plan;
  const src = srcSlot & 0x3ff;
  const used = new Set(destDoc.usedInstrumentSlots());
  if (!used.has(src) || !(destDoc.instruments[src].isOpl || destDoc.instruments[src].isPsg)) {
    return { error: "A formant instrument can be sung only from an OPL or a PSG instrument." };
  }
  used.add(plan.metaSlot);
  const child = allocChildSlot(used);
  if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
  const self = plan.insts[0];
  self.record[0] = (self.record[0] & 0xfc) | ((child >>> 8) & 0x03);
  self.record[1] = child & 0xff;
  return metaPlan([copyEntry(destDoc, src, child), self],
    inamPayloadWith(destDoc, [[plan.metaSlot, name], [child, destDoc.instrumentName(src)]]),
    { metaSlot: plan.metaSlot, childSlots: [child] });
}

/**
 * Sing formant instrument `formantSlot` from OPL instrument `srcSlot` (§7.6),
 * or from its own sample again when `srcSlot` is 0. The same copy-into-a-child
 * rule as a layer's: the OPL instrument is copied to a $100+ sub-instrument the
 * formant instrument owns, so editing the source never edits the instrument it
 * was picked from, and that one stays where it was in the list. One undo step.
 */
export function planSetFormantSource(destDoc, formantSlot, srcSlot) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const slot = formantSlot & 0x3ff;
  const inst = destDoc.instruments[slot];
  if (!inst?.isFormant) return { error: "That instrument is not a formant instrument." };
  const record = destDoc.instRecordBytes(slot);
  const pointAt = (to) => {
    record[0] = (record[0] & 0xfc) | ((to >>> 8) & 0x03);
    record[1] = to & 0xff;
  };
  const self = { srcSlot: -1, destSlot: slot, topLevel: true, record, ixmpBlob: null, ixmpCount: 0 };
  if ((srcSlot & 0x3ff) === 0) {
    pointAt(0);
    return metaPlan([self], null, { metaSlot: slot, childSlots: [] });
  }
  const src = srcSlot & 0x3ff;
  const used = new Set(destDoc.usedInstrumentSlots());
  if (!used.has(src) || !(destDoc.instruments[src].isOpl || destDoc.instruments[src].isPsg)) {
    return { error: "A formant instrument can be sung only from an OPL or a PSG instrument." };
  }
  const child = allocChildSlot(new Set(used));
  if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
  pointAt(child);
  return metaPlan([copyEntry(destDoc, src, child), self],
    inamPayloadWith(destDoc, [[child, destDoc.instrumentName(src)]]),
    { metaSlot: slot, childSlots: [child] });
}

// ── item 114: duplicate an instrument already in this project ────────────────

/**
 * The copy's INam text: the source's name with the codebase's " (N)" duplicate
 * suffix (stem-export labels use the same), deduped against every name the
 * project already carries — "Piano" → "Piano (2)" → "Piano (3)". Only a
 * trailing " (N)" is stripped before counting, so a name that ENDS in a number
 * keeps it: "Synth Strings 1" duplicates to "Synth Strings 1 (2)", never to
 * "Synth Strings 2" (a different GM instrument). A counter rather than a word
 * because INam is an ASCII-escaped byte table read in every language — a
 * translated "copy" would land \uHHHH-escaped in the file. An unnamed
 * instrument stays unnamed; the list already shows the slot number.
 */
export function duplicateInstrumentName(taken, name) {
  if (name === "") return "";
  const stem = name.replace(/ \(\d+\)$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Duplicate instruments that are already in this project (item 114) — the
 * cheap way to derive a variant (a different fadeout, envelope or filter)
 * without touching the original.
 *
 * SAMPLES ARE NOT COPIED. The record and the Ixmp patch blob keep the source's
 * pool pointers verbatim, so a duplicate costs one instrument slot and zero
 * pool bytes, and the sample census is unchanged — same (ptr:len) set, same
 * order, so SNam needs no rebuild (`writeSnam: false`).
 *
 * A metainstrument duplicates DEEP: its layer children are copied into fresh
 * $100+ slots and the copy's layer table is repointed at them, so editing a
 * layer of the duplicate can never change how the original sounds. Layers that
 * shared one child still share ONE copy — item 113's linking survives, and the
 * duplicate costs the same number of slots as its source.
 *
 * `slots` are source slots (any used slot, including a $100+ layer child —
 * its copy becomes an ordinary note-addressable instrument). Returns {error}
 * or a planImport-shaped plan (apply with importBankOp), with
 * `duplicates: [{srcSlot, destSlot}]` naming the top-level copies in the order
 * they were requested.
 */
export function planDuplicateInstruments(destDoc, slots) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const used = new Set(destDoc.usedInstrumentSlots());
  const sources = [...new Set(slots)].filter((s) => used.has(s));
  if (sources.length === 0) return { error: "No instruments selected." };

  // Copies must stay note-addressable ($01–$FF); their layer children go to
  // $100+, where only a layer table can reach them.
  const taken = new Set(used);
  let low = 1;
  const nextLow = () => { while (low <= 255 && taken.has(low)) low++; return low <= 255 ? low : null; };

  const insts = [];
  const names = [];
  const duplicates = [];
  const usedNames = new Set(splitNameTable(sectionPayload(destDoc, "INam"))
    .map((p) => new TextDecoder().decode(p)));

  for (const src of sources) {
    const dest = nextLow();
    if (dest === null) {
      return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
    }
    taken.add(dest);
    duplicates.push({ srcSlot: src, destSlot: dest });

    // Layer closure: every sub-instrument the source reaches gets its own copy,
    // discovered before any record is built so a nested layer table can be
    // remapped through the finished map.
    const slotMap = new Map([[src, dest]]);
    const children = [];
    const queue = [src];
    while (queue.length > 0) {
      for (const dep of layerDeps(destDoc, queue.shift(), used)) {
        if (slotMap.has(dep)) continue; // a shared child stays shared in the copy
        const child = allocChildSlot(taken);
        if (child < 0) return { error: "No free sub-instrument slots left in $100–$3FF." };
        slotMap.set(dep, child);
        children.push([dep, child]);
        queue.push(dep);
      }
    }

    for (const [srcChild, destChild] of children) {
      const entry = copyEntry(destDoc, srcChild, destChild);
      if (destDoc.instruments[srcChild].isMeta) remapMetaLayerSlots(entry.record, slotMap);
      remapFormantSource(entry.record, (s) => slotMap.get(s));
      insts.push(entry);
      names.push([destChild, destDoc.instrumentName(srcChild)]); // children keep the name
    }
    const top = copyEntry(destDoc, src, dest, true);
    if (destDoc.instruments[src].isMeta) remapMetaLayerSlots(top.record, slotMap);
    remapFormantSource(top.record, (s) => slotMap.get(s));
    insts.push(top);

    const copyName = duplicateInstrumentName(usedNames, destDoc.instrumentName(src));
    usedNames.add(copyName);
    names.push([dest, copyName]);
  }

  // A project with no INam and nothing but unnamed copies keeps no INam.
  const inamPayload = inamPayloadWith(destDoc, names);
  const hadInam = sectionPayload(destDoc, "INam") !== null;
  return metaPlan(insts, hadInam || inamPayload.length > 0 ? inamPayload : null, {
    duplicates,
    childSlots: insts.filter((it) => !it.topLevel).map((it) => it.destSlot),
  });
}

/** Everything applyPlan touches, captured for the invertible op. */
export function captureBankState(doc, plan) {
  doc.instruments; // ensure decoded (slot state lives on the TaudInst objects)
  return {
    spans: plan.samples.map((s) => ({
      ptr: s.ptr,
      bytes: Uint8Array.from(doc.sampleBin.subarray(s.ptr, s.ptr + s.bytes.length)),
    })),
    slots: plan.insts.map((it) => ({
      slot: it.destSlot,
      record: doc.instRecordBytes(it.destSlot),
      used: doc._usedSlots.has(it.destSlot),
      patches: doc.instruments[it.destSlot].extraPatches,
    })),
    ixmp: doc.ixmp.slice(),
    // Whole section list (payload refs are stable — sections get replaced,
    // never mutated) so restore reproduces the section ORDER byte-exactly.
    sections: doc.projSections.map((s) => ({ fourcc: s.fourcc, payload: s.payload })),
  };
}

export function restoreBankState(doc, state) {
  for (const span of state.spans) doc.sampleBin.set(span.bytes, span.ptr);
  for (const s of state.slots) {
    doc.instruments[s.slot].loadRecord(s.record);
    doc.instruments[s.slot].extraPatches = s.patches;
    doc._editedSlots.add(s.slot);
    if (s.used) doc._usedSlots.add(s.slot);
    else doc._usedSlots.delete(s.slot);
  }
  doc._instrumentsEdited = true;
  doc.ixmp = state.ixmp.slice();
  doc.projSections = state.sections.map((s) => ({ fourcc: s.fourcc, payload: s.payload }));
  doc.dirty = true;
}

export function applyPlan(doc, plan) {
  for (const s of plan.samples) doc.sampleBin.set(s.bytes, s.ptr);
  for (const it of plan.insts) {
    const inst = doc.instruments[it.destSlot];
    inst.loadRecord(it.record);
    // Mirror the instruments-getter decode: the live TaudInst carries the
    // patches (census, zones view, jam) — loadRecord alone leaves them stale.
    const patches = it.ixmpBlob !== null ? parsePatchesBlob(it.ixmpBlob) : [];
    inst.extraPatches = patches.length > 0 ? patches : null;
    doc.markInstUsed(it.destSlot);
    doc.ixmp = doc.ixmp.filter((e) => (e.instId & 0x3ff) !== it.destSlot);
    if (it.ixmpBlob !== null) {
      doc.ixmp.push({ instId: it.destSlot, count: it.ixmpCount, blob: it.ixmpBlob });
    }
  }
  if (plan.insts.some((it) => it.ixmpBlob !== null) || sectionPayload(doc, "Ixmp") !== null) {
    doc.setSection("Ixmp", doc.ixmp.length > 0 ? buildIxmpSection(doc.ixmp) : null);
  }
  if (plan.inamPayload !== null) doc.setSection("INam", plan.inamPayload);
  // Mixing chains an import brought (item 217); `undefined` leaves them alone.
  if (plan.imixPayload !== undefined) doc.setSection("IMix", plan.imixPayload);
  if (plan.imcnPayload !== undefined) doc.setSection("IMcn", plan.imcnPayload);
  // Pool regions (item 175). `undefined` leaves the section alone — only the
  // plans that add, rename or drop a region carry the field; `null` removes it,
  // which is what the last region's deletion means.
  if (plan.regionPayload !== undefined) doc.setSection("SRgn", plan.regionPayload);
  if (plan.writeSnam) {
    const names = doc.sampleList().map((e) =>
      plan.snamNames.get(sampleKey(e.ptr, e.len)) ?? new Uint8Array(0));
    doc.setSection("SNam", joinNameTable(names));
  }
  doc.dirty = true;
}

// ── pool regions (item 175) ─────────────────────────────────────────────────
//
// A region is a long recording living in the pool that no instrument claims
// (an instrument's sampleLength is a U16 — 65535 bytes is its ceiling). These
// four plans are the whole life cycle: load one in, cut instruments out of it,
// rename it, throw it away. They are planImport-shaped, so importBankOp gives
// them undo, DocSync re-uploads the pool, and the `regionPayload` field
// applyPlan learned above carries the SRgn section with the same undo step.

/** An empty planImport-shaped plan: the base every region plan builds on. */
function emptyBankPlan() {
  return {
    insts: [], samples: [], inamPayload: null, snamNames: new Map(),
    writeSnam: false, slotMap: new Map(), newSampleBytes: 0, dedupedSamples: 0,
  };
}

/** The SRgn payload for `regions`, or null when the list is empty (a project
 *  with no regions carries no section at all). */
function regionPayloadFor(regions) {
  return regions.length > 0 ? buildRegionPayload(regions) : null;
}

/**
 * Plan loading a long recording into the pool as a REGION (item 175):
 * `channels` is one U8 PCM array per channel, all the same length, and the
 * whole thing takes ONE contiguous block of `len × channels` bytes so
 * regionSpans() can address channel *k* at `ptr + k × len`.
 *
 * Nothing is deduped. A region is the user's master copy of a recording, and
 * silently aliasing it onto an identical one already in the pool would make
 * editing either of them edit both — the opposite of what "load my own copy
 * into memory" asks for.
 *
 * Returns {error} or a plan with `region: {ptr, len, rate, chan, name}`.
 */
export function planImportRegion(destDoc, { channels, rate, nameBytes = new Uint8Array(0) }) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image to load into." };
  }
  const chans = (channels ?? []).filter((c) => c && c.length > 0);
  if (chans.length === 0) return { error: "The decoded recording is empty." };
  if (chans.length > MAX_REGION_CHANNELS) {
    return { error: `Too many channels: ${chans.length} (${MAX_REGION_CHANNELS} max).` };
  }
  const len = chans[0].length;
  if (chans.some((c) => c.length !== len)) {
    return { error: "Every channel of a region must be the same length." };
  }
  const total = len * chans.length;
  if (total > SAMPLEBIN_SIZE) {
    return { error: `Recording too long: ${total} bytes, and the whole pool is ${SAMPLEBIN_SIZE}.` };
  }

  const regions = destDoc.sampleRegions();
  const extents = freeExtents(destDoc.sampleList(), regions);
  const ptr = carveFirstFit(extents, total);
  if (ptr === null) {
    const largest = extents.reduce((n, e) => Math.max(n, e.len), 0);
    return { error: `Sample pool full: needs ${total} contiguous bytes and the largest free run is ${largest}.` };
  }

  const name = new TextDecoder().decode(nameBytes);
  const region = {
    ptr, len, rate: Math.max(1, Math.min(0xffff, Math.round(rate) || 0)),
    chan: chans.length, name,
  };
  const bytes = new Uint8Array(total);
  chans.forEach((c, i) => bytes.set(c, i * len));

  return {
    ...emptyBankPlan(),
    samples: [{ ptr, bytes, srcKeys: [] }],
    newSampleBytes: total,
    regionPayload: regionPayloadFor([...regions, region]),
    region,
  };
}

/**
 * Plan dropping a region. The bytes are ZEROED by default — a region is
 * usually megabytes, and leaving them behind would cost that much in every
 * saved file for a recording the user has just thrown away — except where a
 * census sample still claims part of them: an instrument cut out of the region
 * outlives it, and its window keeps its audio.
 *
 * Returns {error} or a plan, with `keptSpans` naming the windows that survived.
 */
export function planDeleteRegion(destDoc, region) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  const regions = destDoc.sampleRegions();
  const target = regions.find((r) => r.ptr === region.ptr && r.len === region.len);
  if (!target) return { error: "That region is not in this project." };

  // The census spans that lie inside the region — the instruments cut out of it.
  const claimed = [];
  for (const e of destDoc.sampleList()) {
    for (const sp of sampleSpans(e)) {
      for (const rs of regionSpans(target)) {
        const a = Math.max(sp.ptr, rs.ptr);
        const b = Math.min(sp.ptr + sp.len, rs.ptr + rs.len);
        if (b > a) claimed.push([a, b]);
      }
    }
  }
  const pool = destDoc.sampleBin;
  const samples = [];
  let freed = 0;
  for (const rs of regionSpans(target)) {
    for (const part of rangeMinus(rs.ptr, rs.len, claimed)) {
      // Only the bytes that are not already silent are worth an undo record.
      let nz = 0;
      for (let i = part.ptr; i < part.ptr + part.len; i++) if (pool[i] !== 0) nz++;
      if (nz === 0) continue;
      samples.push({ ptr: part.ptr, bytes: new Uint8Array(part.len), srcKeys: [] });
      freed += nz;
    }
  }
  return {
    ...emptyBankPlan(),
    samples,
    regionPayload: regionPayloadFor(regions.filter((r) => r !== target)),
    freedSampleBytes: freed,
    keptSpans: claimed.length,
  };
}

/** Plan renaming a region — SRgn only, no pool bytes, no instruments. */
export function planRenameRegion(destDoc, region, nameBytes) {
  const regions = destDoc.sampleRegions();
  const target = regions.find((r) => r.ptr === region.ptr && r.len === region.len);
  if (!target) return { error: "That region is not in this project." };
  const name = new TextDecoder().decode(nameBytes);
  return {
    ...emptyBankPlan(),
    regionPayload: regionPayloadFor(
      regions.map((r) => (r === target ? { ...r, name } : r))),
  };
}

/**
 * Plan cutting a WINDOW out of a region into a fresh instrument (item 175) —
 * the move the whole feature exists for. `from`/`len` are byte offsets within
 * the region's channel-0 span; a multi-channel region cuts the same window out
 * of every channel and the instrument gets the Ixmp 's' patch that plays them
 * as a pair. No pool bytes are written: the window IS the region's bytes, and
 * editing the instrument's audio later edits the recording it came from.
 *
 * The census gains a row, so SNam is rebuilt from sample identity after apply
 * (the pool order is the name order) — `sampleNameBytes` names the new row.
 *
 * Returns {error} or a planImport-shaped plan with `slot` and `ptr`.
 */
export function planRegionSlice(destDoc, region, {
  from, len, nameBytes = new Uint8Array(0), sampleNameBytes = null, loop = false,
} = {}) {
  if (destDoc.sampleInstImage === null) {
    return { error: "This project has no sample+instrument image." };
  }
  if (!region || !(region.len > 0)) return { error: "That region is empty." };
  const start = Math.max(0, Math.min(from | 0, region.len - 1));
  const count = Math.min(len | 0, region.len - start);
  if (count <= 0) return { error: "The selected window is empty." };
  if (count > 0xffff) {
    return { error: `Window too long: ${count} bytes (65535 max — an instrument's sample length is a 16-bit field).` };
  }

  const taken = new Set(destDoc.usedInstrumentSlots());
  let slot = 1;
  while (slot <= 255 && taken.has(slot)) slot++;
  if (slot > 255) {
    return { error: "No free instrument slots left in $01–$FF (note-addressable range)." };
  }

  const spans = regionSpans(region);
  const ptrs = spans.map((sp) => sp.ptr + start);
  const rate = Math.max(1, Math.min(0xffff, region.rate || 0));
  const loopEnd = loop ? count : 0;
  const loopMode = loop ? 1 : 0;
  const record = buildFreshInstRecord({
    samplePtr: ptrs[0], sampleLength: count, samplingRate: rate,
    sampleLoopStart: 0, sampleLoopEnd: loopEnd, loopMode,
  });
  const stereo = ptrs.length > 1;
  const ixmpBlob = stereo
    ? writePatchesBlob([makeInstPatch({
        pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
        samplePtr: ptrs[0], sampleLength: count, playStart: 0,
        loopStart: 0, loopEnd, samplingRate: rate, loopMode,
        hasChanBlock: true, chanCount: ptrs.length, chanMode: CHAN_MODE_DISCRETE,
        chanPtrs: ptrs.slice(1),
      })])
    : null;

  // INam: splice the instrument name in by slot.
  const destInamPayload = sectionPayload(destDoc, "INam");
  let inamPayload = null;
  if (nameBytes.length > 0 || destInamPayload !== null) {
    const parts = splitNameTable(destInamPayload);
    while (parts.length <= slot) parts.push(new Uint8Array(0));
    parts[slot] = nameBytes;
    inamPayload = joinNameTable(parts);
  }

  // SNam: the window is a NEW census row unless an identical claim already
  // exists, so the table is rebuilt by identity after apply.
  const snamNames = new Map();
  const destSnam = splitNameTable(sectionPayload(destDoc, "SNam"));
  destDoc.sampleList().forEach((e, i) =>
    snamNames.set(sampleKey(e.ptr, e.len), destSnam[i] ?? new Uint8Array(0)));
  const smpName = sampleNameBytes ?? nameBytes;
  if (!snamNames.has(sampleKey(ptrs[0], count))) {
    snamNames.set(sampleKey(ptrs[0], count), smpName);
  }

  return {
    insts: [{ srcSlot: -1, destSlot: slot, topLevel: true, record, ixmpBlob, ixmpCount: stereo ? 1 : 0 }],
    samples: [],
    inamPayload,
    snamNames,
    writeSnam: true,
    slotMap: new Map([[-1, slot]]),
    newSampleBytes: 0,
    dedupedSamples: 1,
    slot,
    ptr: ptrs[0],
    sliceLen: count,
  };
}
