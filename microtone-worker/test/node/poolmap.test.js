// Pool memory map (item 166) — the census resolved back onto the address line.
// The Samples list dedupes by (ptr:len) and says nothing about where the bytes
// are; these are the facts the memory panel draws, so they are pinned here
// rather than in a screenshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { poolMap, claimsIn, POOL_SIZE } from "../../src/doc/poolmap.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document, sampleSpans } from "../../src/doc/document.js";
import { planDeleteSample } from "../../src/doc/cleanup.js";
import { planDuplicateSample } from "../../src/doc/bankmerge.js";
import { importBankOp, cleanupBankOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (f) => new Document(parseTaud(readFileSync(corpusDir + f)));

/** A census-shaped stand-in — poolMap only ever reads what sampleList() emits. */
const entry = (index, ptr, len, extra = {}) => ({
  index, ptr, len, name: "s" + index, users: [1],
  loopStart: 0, loopEnd: 0, loopMode: 0, chanPtrs: [], chanMode: 0, ...extra,
});

test("poolMap: the corpus converters pack from 0 with no gaps and no sharing", () => {
  for (const f of ["WHEN.taud", "Onestop.taud", "town.taud", "flourish.taud"]) {
    const m = poolMap(load(f));
    assert.equal(m.stats.holeCount, 0, `${f} has no holes`);
    assert.equal(m.stats.overlapPairs, 0, `${f} shares no bytes`);
    assert.equal(m.stats.sharedBytes, 0, `${f} claims nothing twice`);
    assert.equal(m.lanes, 1, `${f} needs one lane — every extra lane is a real overlap`);
    assert.equal(m.used.length, 1, `${f} is one contiguous run`);
    assert.equal(m.used[0].ptr, 0, `${f} starts at 0`);
    assert.equal(m.stats.usedBytes, m.stats.claimedBytes,
      `${f}: the census adds up to exactly what the pool holds`);
    assert.equal(m.highWater, m.stats.usedBytes);
    assert.equal(m.stats.staleBytes, 0, `${f} has no leftover audio`);
    assert.equal(m.stats.freeBytes, POOL_SIZE - m.stats.usedBytes);
  }
});

test("poolMap: junk instrument records are flagged, not mapped", () => {
  // 4THSYM keeps three garbage records up at slots $1FD–$1FF, whose pointers
  // land hundreds of megabytes past an 8 MB pool. The Samples list shows them
  // as ordinary samples; the map has to say what they are.
  const m = poolMap(load("4THSYM.taud"));
  assert.equal(m.outside.length, 3);
  assert.equal(m.stats.outsideCount, 3);
  for (const c of m.outside) {
    assert.ok(c.ptr + c.len > POOL_SIZE, `${c.ptr} is outside the pool`);
    assert.ok(!m.used.some((u) => u.ptr <= c.ptr && c.ptr < u.ptr + u.len),
      "an out-of-pool claim contributes no used extent");
  }
  // …and the in-pool part is still measured honestly.
  assert.equal(m.highWater, 8410);
  assert.equal(m.stats.usedBytes, 8410);
  assert.equal(m.stats.spans, 20, "every span is listed, mapped or not");
  assert.equal(m.claims.length - m.outside.length, 17);

  assert.equal(poolMap(load("Insaniq2.taud")).outside.length, 1);
});

test("poolMap: overlapping claims get their own lanes; a sample's own channels do not", () => {
  const doc = { sampleList: () => null, sampleBin: null };
  // 000 covers [0,1000); 001 is a shorter view of the SAME recording; 002 sits
  // clear of both. That is the shape the Samples list cannot show.
  const census = [entry(0, 0, 1000), entry(1, 200, 300), entry(2, 2000, 500)];
  const m = poolMap(doc, { census, scanBytes: false });
  assert.equal(m.lanes, 2, "two overlapping claims, two lanes");
  assert.equal(m.stats.overlapPairs, 1);
  assert.equal(m.stats.sharedBytes, 300, "only the shared range counts twice");
  assert.equal(m.stats.usedBytes, 1500, "the union, not the sum");
  assert.equal(m.stats.claimedBytes, 1800, "…and the sum, for the panel to contrast");
  assert.deepEqual(m.used, [{ ptr: 0, len: 1000 }, { ptr: 2000, len: 500 }]);
  assert.deepEqual(m.holes, [{ ptr: 1000, len: 1000, stale: 0 }]);
  const [a, b, c] = m.claims;
  assert.deepEqual(a.overlaps, [b.slot]);
  assert.deepEqual(b.overlaps, [a.slot]);
  assert.deepEqual(c.overlaps, []);
  assert.notEqual(a.lane, b.lane);

  // A stereo sample is ONE row occupying two spans. They are not an overlap
  // even when the converter lays them back to back.
  const st = poolMap(doc, {
    census: [entry(0, 0, 100, { chanPtrs: [100] })], scanBytes: false,
  });
  assert.equal(st.claims.length, 2);
  assert.equal(st.stats.overlapPairs, 0);
  assert.equal(st.lanes, 1);
  assert.deepEqual(st.claims.map((x) => x.chan), [0, 1]);
});

test("poolMap: identical spans on different rows DO count as sharing", () => {
  // Same bytes, two census rows: only possible via a stereo patch whose second
  // channel is another row's whole sample, and exactly the case a "which of
  // these is the real one?" question comes from.
  const m = poolMap({ sampleList: () => null, sampleBin: null }, {
    census: [entry(0, 0, 100, { chanPtrs: [512] }), entry(1, 512, 100)],
    scanBytes: false,
  });
  assert.equal(m.stats.overlapPairs, 1);
  assert.equal(m.stats.sharedBytes, 100);
  assert.equal(m.lanes, 2);
});

test("poolMap: holes below the high-water mark, and whether they are swept", () => {
  const bin = new Uint8Array(POOL_SIZE);
  bin.fill(0x7f, 1000, 1200);           // 200 bytes of orphaned audio in the gap
  bin[POOL_SIZE - 1] = 0x40;            // and one byte above the high-water mark
  const doc = { sampleList: () => null, sampleBin: bin };
  const census = [entry(0, 0, 1000), entry(1, 2000, 500)];
  const m = poolMap(doc, { census });
  assert.equal(m.stats.holeCount, 1);
  assert.equal(m.holes[0].len, 1000);
  assert.equal(m.holes[0].stale, 200, "a hole reading non-zero has not been swept");
  assert.equal(m.stats.tailStale, 1);
  assert.equal(m.stats.staleBytes, 201);
  assert.equal(m.stats.tailFree, POOL_SIZE - 2500);
  assert.ok(m.stats.scanned);

  // …and the arithmetic-only map is identical apart from the byte verdicts,
  // which is what lets the panel skip the 8 MB walk on a selection change.
  const cheap = poolMap(doc, { census, scanBytes: false });
  assert.equal(cheap.stats.staleBytes, 0);
  assert.ok(!cheap.stats.scanned);
  assert.deepEqual(cheap.used, m.used);
  assert.deepEqual(cheap.holes.map((h) => h.len), m.holes.map((h) => h.len));
});

test("poolMap: a leading gap is a hole too", () => {
  const m = poolMap({ sampleList: () => null, sampleBin: null }, {
    census: [entry(0, 4096, 256)], scanBytes: false,
  });
  assert.deepEqual(m.holes, [{ ptr: 0, len: 4096, stale: 0 }]);
  assert.equal(m.highWater, 4352);
});

test("poolMap: an empty pool maps to nothing at all", () => {
  const m = poolMap({ sampleList: () => [], sampleBin: new Uint8Array(POOL_SIZE) });
  assert.equal(m.claims.length, 0);
  assert.equal(m.highWater, 0);
  assert.equal(m.lanes, 0);
  assert.deepEqual(m.holes, []);
  assert.equal(m.stats.freeBytes, POOL_SIZE);
  assert.equal(m.stats.tailFree, POOL_SIZE);
});

test("claimsIn: what actually lives in a range", () => {
  const m = poolMap({ sampleList: () => null, sampleBin: null }, {
    census: [entry(0, 0, 1000), entry(1, 200, 300), entry(2, 2000, 500)],
    scanBytes: false,
  });
  assert.deepEqual(claimsIn(m, 0, 100).map((c) => c.index), [0]);
  assert.deepEqual(claimsIn(m, 250, 10).map((c) => c.index), [0, 1]);
  assert.deepEqual(claimsIn(m, 1000, 1000).map((c) => c.index), [], "the hole holds nothing");
  assert.deepEqual(claimsIn(m, 1999, 2).map((c) => c.index), [2], "half-open at both ends");
});

test("poolMap tracks a real delete: the hole appears, and it is swept", () => {
  const doc = load("WHEN.taud");
  assert.equal(poolMap(doc).stats.holeCount, 0);
  // Anything but the last sample, so freeing it leaves a gap rather than
  // lowering the high-water mark.
  const victim = doc.sampleList()[3];
  const plan = planDeleteSample(doc, victim);
  assert.ok(!plan.error, plan.error);
  new UndoStack(doc).apply(cleanupBankOp(plan));

  const m = poolMap(doc);
  assert.equal(m.stats.holeCount, 1, "the freed span is a hole in the map");
  assert.equal(m.holes[0].ptr, victim.ptr);
  assert.equal(m.holes[0].len, victim.len);
  assert.equal(m.holes[0].stale, 0, "delete zeroes what it frees, so the hole is clean");
  assert.equal(m.stats.usedBytes, POOL_SIZE - m.stats.freeBytes);
});

test("poolMap tracks a real duplicate: the copy takes the first hole that fits", () => {
  const doc = load("WHEN.taud");
  const victim = doc.sampleList()[3];
  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(planDeleteSample(doc, victim)));
  const hole = poolMap(doc).holes[0];

  const src = doc.sampleList().find((e) => e.len <= hole.len);
  assert.ok(src, "something in WHEN fits the hole we just made");
  const dup = planDuplicateSample(doc, src, new TextEncoder().encode("copy"));
  assert.ok(!dup.error, dup.error);
  undo.apply(importBankOp(dup));

  const m = poolMap(doc);
  const copy = m.claims.find((c) => c.ptr === dup.duplicate.ptr);
  assert.ok(copy, "the copy is on the map");
  assert.equal(copy.ptr, hole.ptr, "first-fit: it lands at the head of the hole");
  assert.equal(m.stats.overlapPairs, 0, "…without treading on anything");
  const rest = hole.len - src.len;
  assert.equal(m.stats.holeBytes, rest, "and shrinks the hole by its own length");
});

test("poolMap: claims carry the census row, so a click on the map finds the list", () => {
  const doc = load("WHEN.taud");
  const census = doc.sampleList();
  const m = poolMap(doc, { census });
  for (const c of m.claims) {
    assert.equal(c.entry, census[c.index], "claim.entry IS the row the list shows");
    assert.equal(c.end, c.ptr + c.len);
  }
  const spans = census.flatMap(sampleSpans);
  assert.equal(m.claims.length, spans.length, "one claim per pool span");
  assert.equal(SAMPLEBIN_SIZE, POOL_SIZE);
});
