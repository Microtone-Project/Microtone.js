// Pool regions (item 175) — the `SRgn` section, and the four plans that make
// a long recording a first-class thing the pool holds.
//
// The premise the whole feature turns on: an instrument's `sampleLength` is a
// U16, so no claim can ever exceed 65535 bytes, and the census is derived from
// claims. A 4 MB recording therefore has NO representation in the census, and
// the only reason its bytes survive is that these plans reserve them. That is
// what is pinned here: allocation avoids a region, Housekeeping spares it,
// deleting a sample cut out of it does not eat it, and it round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseRegionPayload, buildRegionPayload, regionSpans, regionBytes,
  largestFreeRun, wholeMemoryRegion, MAX_REGION_CHANNELS, POOL_SIZE,
} from "../../src/doc/sampleregions.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document, sampleSpans } from "../../src/doc/document.js";
import {
  planImportRegion, planDeleteRegion, planRenameRegion, planRegionSlice,
  planSampleImport, planDuplicateSample,
} from "../../src/doc/bankmerge.js";
import { planBankCleanup, planDeleteSample, planDeleteInstrument } from "../../src/doc/cleanup.js";
import { importBankOp, cleanupBankOp, deleteInstrumentOp } from "../../src/doc/ops.js";
import { poolMap } from "../../src/doc/poolmap.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (f) => new Document(parseTaud(readFileSync(corpusDir + f)));
const enc = (s) => new TextEncoder().encode(s);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** A recording no instrument could ever claim: three times the length ceiling. */
function longPcm(n = 200000, seed = 1) {
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = (128 + Math.round(100 * Math.sin((i + seed) / 40))) & 0xff;
  return p;
}

/** Load a corpus doc and put one long recording in it. */
function docWithRegion(file = "WHEN.taud", opts = {}) {
  const doc = load(file);
  const undo = new UndoStack(doc);
  const pcm = opts.pcm ?? longPcm();
  const plan = planImportRegion(doc, {
    channels: opts.channels ?? [pcm], rate: opts.rate ?? 16000,
    nameBytes: enc(opts.name ?? "long break"),
  });
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(importBankOp(plan));
  return { doc, undo, pcm, region: doc.sampleRegions()[0] };
}

// ── the section codec ───────────────────────────────────────────────────────

test("SRgn: entries round-trip, in pointer order, names and all", () => {
  const src = [
    { ptr: 5000, len: 100, rate: 22050, chan: 2, name: "two" },
    { ptr: 10, len: 40, rate: 8000, chan: 1, name: "one" },
    { ptr: 900000, len: 4096, rate: 32000, chan: 1, name: "" },
  ];
  const back = parseRegionPayload(buildRegionPayload(src));
  assert.deepEqual(back.map((r) => r.ptr), [10, 5000, 900000], "ascending by pointer");
  assert.deepEqual(back.map((r) => r.name), ["one", "two", ""]);
  assert.deepEqual(back.map((r) => [r.len, r.rate, r.chan]),
    [[40, 8000, 1], [100, 22050, 2], [4096, 32000, 1]]);
  assert.deepEqual(back.map((r) => r.index), [0, 1, 2], "index is the pool order");
  // Re-encoding the parsed list is byte-identical — the section is canonical.
  assert.deepEqual(buildRegionPayload(back), buildRegionPayload(src));
});

test("SRgn: a UTF-8 name survives, and an empty list encodes to nothing", () => {
  const back = parseRegionPayload(buildRegionPayload([
    { ptr: 0, len: 8, rate: 1, chan: 1, name: "café ♭" },
  ]));
  assert.equal(back[0].name, "café ♭");
  assert.equal(buildRegionPayload([]).length, 0);
  assert.deepEqual(parseRegionPayload(new Uint8Array(0)), []);
  assert.deepEqual(parseRegionPayload(null), []);
});

test("SRgn: entries that cannot be true are dropped, not repaired", () => {
  // Hand-rolled, because the WRITER clamps: an out-of-range channel count can
  // only ever reach the reader from a foreign or corrupt file, which is exactly
  // the case the drop rule is for.
  const entry = (ptr, len, rate, chan, name) => {
    const nb = new TextEncoder().encode(name);
    const out = new Uint8Array(12 + nb.length + 1);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, ptr, false);
    dv.setUint32(4, len, false);
    dv.setUint16(8, rate, false);
    out[10] = chan;
    out.set(nb, 12);
    return out;
  };
  const rows = parseRegionPayload(concat([
    entry(0, 0, 1, 1, "empty"),                        // no bytes
    entry(POOL_SIZE - 10, 100, 1, 1, "over"),          // off the end
    entry(0, 5000000, 1, 2, "twochan"),                // ×2 runs off
    entry(100, 10, 1, MAX_REGION_CHANNELS + 1, "chans"),
    entry(100, 10, 1, 0, "nochans"),
    entry(100, 10, 1, 1, "fine"),
  ]));
  assert.deepEqual(rows.map((r) => r.name), ["fine"]);
});

test("SRgn: a truncated tail stops the walk, keeping what came before", () => {
  const full = buildRegionPayload([
    { ptr: 0, len: 8, rate: 1, chan: 1, name: "first" },
    { ptr: 100, len: 8, rate: 1, chan: 1, name: "second" },
  ]);
  const cut = full.subarray(0, full.length - 3);
  assert.deepEqual(parseRegionPayload(cut).map((r) => r.name), ["first"]);
});

test("regionSpans: channel k starts at ptr + k × len, and the block is contiguous", () => {
  const r = { ptr: 1000, len: 256, rate: 1, chan: 3, name: "" };
  assert.deepEqual(regionSpans(r), [
    { ptr: 1000, len: 256, chan: 0 },
    { ptr: 1256, len: 256, chan: 1 },
    { ptr: 1512, len: 256, chan: 2 },
  ]);
  assert.equal(regionBytes(r), 768);
  assert.equal(regionBytes({ ptr: 0, len: 40, chan: 1 }), 40);
});

test("largestFreeRun: what the import dialog quotes, counting regions as used", () => {
  const claims = [{ ptr: 0, len: 1000 }];
  assert.equal(largestFreeRun(claims, []), POOL_SIZE - 1000);
  // A region 2000 bytes in leaves a 1000-byte gap and the tail; the tail wins.
  assert.equal(largestFreeRun(claims, [{ ptr: 2000, len: 500, chan: 1 }]), POOL_SIZE - 2500);
  // …and a region right at the end shrinks the answer to that gap.
  assert.equal(largestFreeRun(claims, [{ ptr: 2000, len: POOL_SIZE - 2000, chan: 1 }]), 1000);
});

// ── the implicit recording every project has ────────────────────────────────

test("wholeMemoryRegion: the occupied pool, for a project that declares none", () => {
  const doc = load("WHEN.taud");
  const spans = doc.sampleList().flatMap(sampleSpans);
  const whole = wholeMemoryRegion(spans, doc.sampleRegions());
  assert.equal(doc.sampleRegions().length, 0, "WHEN has no SRgn — that is the point");
  assert.ok(whole, "…and still has a recording to look at");
  assert.equal(whole.ptr, 0);
  assert.equal(whole.len, Math.max(...spans.map((s) => s.ptr + s.len)),
    "it ends at the last occupied byte");
  assert.equal(whole.synthetic, true, "marked, so no plan can be handed it by accident");
  assert.equal(whole.rate, 0,
    "no single rate: a hundred samples at a hundred rates have none between them");
  assert.equal(whole.chan, 1);
});

test("wholeMemoryRegion: junk records pointing outside the pool do not stretch it", () => {
  // 4THSYM carries three instrument records whose pointers land hundreds of
  // megabytes past the 8 MB pool. Counting them would make "the whole memory"
  // almost entirely imaginary.
  const doc = load("4THSYM.taud");
  const spans = doc.sampleList().flatMap(sampleSpans);
  assert.ok(spans.some((s) => s.ptr + s.len > POOL_SIZE), "the junk records are there");
  const whole = wholeMemoryRegion(spans, []);
  assert.ok(whole.len <= POOL_SIZE);
  assert.equal(whole.len, Math.max(...spans
    .filter((s) => s.ptr >= 0 && s.ptr + s.len <= POOL_SIZE)
    .map((s) => s.ptr + s.len)));
});

test("wholeMemoryRegion: a declared recording counts as occupied too, and empty is null", () => {
  const { doc, region } = docWithRegion();
  const whole = wholeMemoryRegion(doc.sampleList().flatMap(sampleSpans), doc.sampleRegions());
  assert.equal(whole.len, region.ptr + region.len,
    "the recording is the last thing in memory, so it sets the end");
  assert.equal(wholeMemoryRegion([], []), null, "a pool with nothing in it has no recording");
});

// ── the document ────────────────────────────────────────────────────────────

test("a long recording lands in the pool and no census row claims it", () => {
  const { doc, pcm, region } = docWithRegion();
  assert.equal(doc.sampleRegions().length, 1);
  assert.equal(region.len, pcm.length);
  assert.equal(region.rate, 16000);
  assert.equal(region.name, "long break");
  assert.deepEqual([...doc.sampleBin.subarray(region.ptr, region.ptr + 16)],
    [...pcm.subarray(0, 16)], "the bytes are really there");
  for (const e of doc.sampleList()) {
    for (const sp of sampleSpans(e)) {
      assert.ok(sp.ptr + sp.len <= region.ptr || sp.ptr >= region.ptr + region.len,
        `census row ${e.index} must not overlap the region`);
    }
  }
});

test("sampleRegions() is cached by payload identity, so undo invalidates it", () => {
  const { doc, undo, region } = docWithRegion();
  const first = doc.sampleRegions();
  assert.equal(doc.sampleRegions(), first, "same payload, same array");
  undo.undo();
  assert.equal(doc.sampleRegions().length, 0);
  undo.redo();
  assert.equal(doc.sampleRegions()[0].ptr, region.ptr);
});

test("the allocator will not put a new sample inside a region", () => {
  const { doc, region } = docWithRegion();
  const clear = (ptr, len) =>
    ptr + len <= region.ptr || ptr >= region.ptr + region.len;
  for (let i = 0; i < 4; i++) {
    const plan = planSampleImport(doc, { pcm: new Uint8Array(30000).fill(i + 1), rate: 32000, nameBytes: enc("h" + i) });
    assert.equal(plan.error, undefined, plan.error);
    for (const s of plan.samples) {
      assert.ok(clear(s.ptr, s.bytes.length),
        `import ${i} landed at ${s.ptr}, inside the region at ${region.ptr}`);
    }
    new UndoStack(doc).apply(importBankOp(plan));
  }
  // …nor a duplicate, which allocates through the same free list.
  const dup = planDuplicateSample(doc, doc.sampleList()[0], enc("copy"));
  assert.equal(dup.error, undefined, dup.error);
  for (const s of dup.samples) assert.ok(clear(s.ptr, s.bytes.length), "duplicate is clear too");
});

test("a region that fills the pool leaves nothing to import into", () => {
  const doc = load("WHEN.taud");
  const used = Math.max(...doc.sampleList().map((e) => e.ptr + e.len));
  const huge = planImportRegion(doc, {
    channels: [new Uint8Array(POOL_SIZE - used)], rate: 32000, nameBytes: enc("all"),
  });
  assert.equal(huge.error, undefined, huge.error);
  new UndoStack(doc).apply(importBankOp(huge));
  const after = planSampleImport(doc, { pcm: new Uint8Array(1000), rate: 32000, nameBytes: enc("x") });
  assert.match(after.error ?? "", /pool full/i, "the pool is genuinely full now");
});

test("planImportRegion refuses what it cannot represent", () => {
  const doc = load("WHEN.taud");
  assert.match(planImportRegion(doc, { channels: [], rate: 1 }).error, /empty/i);
  assert.match(planImportRegion(doc, {
    channels: [new Uint8Array(10), new Uint8Array(11)], rate: 1,
  }).error, /same length/i);
  assert.match(planImportRegion(doc, {
    channels: Array.from({ length: MAX_REGION_CHANNELS + 1 }, () => new Uint8Array(4)), rate: 1,
  }).error, /channels/i);
});

// ── cutting instruments out of one ──────────────────────────────────────────

test("a window cut out of a region copies no bytes and inherits its rate", () => {
  const { doc, undo, pcm, region } = docWithRegion();
  const before = doc.sampleList().length;
  const plan = planRegionSlice(doc, region, { from: 1000, len: 8000, nameBytes: enc("break 1") });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.samples.length, 0, "no pool write");
  undo.apply(importBankOp(plan));

  const inst = doc.instruments[plan.slot];
  assert.equal(inst.samplePtr, region.ptr + 1000);
  assert.equal(inst.sampleLength, 8000);
  assert.equal(inst.samplingRate, 16000);
  assert.equal(inst.loopMode & 3, 0, "no loop unless asked for");
  assert.equal(doc.sampleList().length, before + 1, "the census gains the window");
  assert.equal(doc.instrumentName(plan.slot), "break 1");
  const row = doc.sampleList().find((e) => e.ptr === region.ptr + 1000 && e.len === 8000);
  assert.equal(doc.sampleName(row.index), "break 1", "SNam realigned to the new pool order");
  assert.equal(doc.sampleBin[region.ptr + 1000], pcm[1000], "it plays the recording's own bytes");

  undo.undo();
  assert.equal(doc.sampleList().length, before, "one undo step");
});

test("a window is capped by the 16-bit length field and by the region's end", () => {
  const { doc, region } = docWithRegion();
  assert.match(planRegionSlice(doc, region, { from: 0, len: 70000 }).error ?? "", /65535/);
  assert.match(planRegionSlice(doc, region, { from: 0, len: 0 }).error ?? "", /empty/i);
  const tail = planRegionSlice(doc, region, { from: region.len - 100, len: 8000 });
  assert.equal(tail.error, undefined, tail.error);
  assert.equal(tail.sliceLen, 100, "clamped to what is left of the recording");
});

test("a stereo region cuts a stereo instrument (an Ixmp 's' patch)", () => {
  const l = longPcm(50000, 1);
  const r = longPcm(50000, 7);
  const { doc, undo } = docWithRegion("WHEN.taud", { channels: [l, r], name: "pair" });
  const region = doc.sampleRegions()[0];
  assert.equal(region.chan, 2);
  assert.equal(regionBytes(region), 100000);
  assert.equal(doc.sampleBin[region.ptr + 50000 + 3], r[3], "channel 2 sits after channel 1");

  const plan = planRegionSlice(doc, region, { from: 200, len: 4000, nameBytes: enc("pair 1") });
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(importBankOp(plan));
  const patches = doc.instruments[plan.slot].extraPatches;
  assert.equal(patches.length, 1);
  assert.equal(patches[0].samplePtr, region.ptr + 200);
  assert.equal(patches[0].chanCount, 2);
  assert.equal(patches[0].chanPtrs[0], region.ptr + 50000 + 200,
    "the right channel is the same window of channel 2");
});

test("a window cut with `loop` sustains: a forward loop over the whole window", () => {
  const { doc, region } = docWithRegion();
  const plan = planRegionSlice(doc, region, { from: 0, len: 1024, loop: true });
  assert.equal(plan.error, undefined, plan.error);
  const rec = plan.insts[0].record;
  assert.equal(rec[14] & 3, 1, "forward loop");
  assert.equal(rec[12] | (rec[13] << 8), 1024, "…to the end of the window");
});

// ── the destructive paths must all leave a region alone ─────────────────────

test("Housekeeping spares a recording nothing claims", () => {
  const { doc, region, pcm } = docWithRegion();
  const plan = planBankCleanup(doc);
  assert.deepEqual([...plan.image.subarray(region.ptr, region.ptr + 16)],
    [...pcm.subarray(0, 16)], "the pool sweep skipped it");
  // And the SNam table still lines up with the census, which never sees regions.
  new UndoStack(doc).apply(cleanupBankOp(plan));
  const census = doc.sampleList();
  assert.ok(census.every((e) => e.index < 1000));
  assert.equal(doc.sampleRegions().length, 1, "Housekeeping never drops a recording");
});

test("deleting a sample cut out of a region does not eat the recording", () => {
  const { doc, undo, pcm, region } = docWithRegion();
  const cut = planRegionSlice(doc, region, { from: 4000, len: 2000, nameBytes: enc("w") });
  undo.apply(importBankOp(cut));
  const row = doc.sampleList().find((e) => e.ptr === region.ptr + 4000 && e.len === 2000);
  const del = planDeleteSample(doc, row);
  assert.equal(del.error, undefined, del.error);
  undo.apply(cleanupBankOp(del));
  assert.equal(doc.sampleBin[region.ptr + 4000], pcm[4000],
    "the bytes belong to the recording, and it is still there");
  assert.equal(del.freedSampleBytes, 0, "nothing was freed: the region still holds them");
});

test("deleting the INSTRUMENT with its samples does not eat the recording either", () => {
  const { doc, undo, pcm, region } = docWithRegion();
  const cut = planRegionSlice(doc, region, { from: 6000, len: 2000, nameBytes: enc("w") });
  undo.apply(importBankOp(cut));
  const plan = planDeleteInstrument(doc, cut.slot, { freeSamples: true });
  assert.equal(plan.error, undefined, plan.error);
  undo.apply(deleteInstrumentOp(plan));
  assert.equal(doc.sampleBin[region.ptr + 6000], pcm[6000]);
});

test("deleting the region frees everything except the windows cut out of it", () => {
  const { doc, undo, pcm, region } = docWithRegion();
  const cut = planRegionSlice(doc, region, { from: 4000, len: 2000, nameBytes: enc("w") });
  undo.apply(importBankOp(cut));

  const del = planDeleteRegion(doc, region);
  assert.equal(del.error, undefined, del.error);
  assert.equal(del.keptSpans, 1, "the window is named as kept");
  undo.apply(importBankOp(del));

  assert.equal(doc.sampleRegions().length, 0);
  assert.equal(doc.sampleBin[region.ptr + 4000], pcm[4000], "the window keeps its audio");
  assert.equal(doc.sampleBin[region.ptr + 100], 0, "the rest is swept");
  assert.equal(doc.sampleBin[region.ptr + region.len - 1], 0);

  undo.undo();
  assert.equal(doc.sampleRegions().length, 1, "undo restores the section…");
  assert.equal(doc.sampleBin[region.ptr + 100], pcm[100], "…and the bytes");
});

test("renaming a region touches the section and nothing else", () => {
  const { doc, undo, region } = docWithRegion();
  const poolBefore = Uint8Array.from(doc.sampleBin.subarray(region.ptr, region.ptr + 32));
  const plan = planRenameRegion(doc, region, enc("the break"));
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.samples.length, 0);
  assert.equal(plan.insts.length, 0);
  undo.apply(importBankOp(plan));
  assert.equal(doc.sampleRegions()[0].name, "the break");
  assert.equal(doc.sampleRegions()[0].ptr, region.ptr, "and it stays put");
  assert.deepEqual([...doc.sampleBin.subarray(region.ptr, region.ptr + 32)], [...poolBefore]);
  undo.undo();
  assert.equal(doc.sampleRegions()[0].name, "long break");
});

test("a region a document does not hold cannot be renamed or deleted", () => {
  const doc = load("WHEN.taud");
  const ghost = { ptr: 999, len: 5, rate: 1, chan: 1, name: "ghost" };
  assert.match(planRenameRegion(doc, ghost, enc("x")).error ?? "", /not in this project/);
  assert.match(planDeleteRegion(doc, ghost).error ?? "", /not in this project/);
});

// ── the file, and the map ───────────────────────────────────────────────────

test("SRgn survives a save/reload, with the pool bytes", () => {
  const { doc, pcm, region } = docWithRegion();
  const back = new Document(parseTaud(doc.toBytes()));
  const r = back.sampleRegions();
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].ptr, r[0].len, r[0].rate, r[0].chan, r[0].name],
    [region.ptr, region.len, region.rate, region.chan, region.name]);
  assert.deepEqual([...back.sampleBin.subarray(region.ptr, region.ptr + 32)],
    [...pcm.subarray(0, 32)]);
});

test("poolMap counts a region as used memory, not as a hole", () => {
  const { doc, region } = docWithRegion();
  const map = poolMap(doc);
  assert.equal(map.stats.regionCount, 1);
  assert.equal(map.stats.regionBytes, region.len);
  assert.equal(map.regions[0].ptr, region.ptr);
  assert.ok(map.highWater >= region.ptr + region.len, "the high-water mark moved with it");
  assert.ok(!map.holes.some((h) => h.ptr >= region.ptr && h.ptr < region.ptr + region.len),
    "a recording is not a gap");
  // The census still says nothing about it — that is the whole point.
  assert.ok(!map.claims.some((c) => c.ptr === region.ptr));
});
