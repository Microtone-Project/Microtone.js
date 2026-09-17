// Project cleanup / renumber ops (item 60): pure pattern planners + the
// invertible remapPatternsOp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  referencedPatterns, planCleanupPatterns, planMergeDuplicatePatterns, planRenumberPatterns,
  applyPatternOrder, encodeNameTable, usedInstrumentSlots,
  planRenumberInstrument, instrumentCellRefs, planIxmpCleanup, reachablePatchSets,
} from "../../src/doc/cleanup.js";
import { TaudPlayData } from "../../src/engine/state.js";
import { EffectOp } from "../../src/engine/tables.js";
import { remapPatternsOp, cleanupBankOp, renumberInstrumentOp, importBankOp } from "../../src/doc/ops.js";
import { writePatchesBlob } from "../../src/engine/inst.js";
import { buildIxmpSection, planCreateMeta } from "../../src/doc/bankmerge.js";
import { planBankCleanup } from "../../src/doc/cleanup.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

// A tiny synthetic song: patterns 0..3, one cue that plays pattern 2 (ch0) and
// pattern 0 (ch2); patterns 1 and 3 are unreferenced. An empty slot is 0x7FFF.
function synthSong() {
  const mkPat = (mark) => { const rows = new Array(64).fill(null).map(() => ({ mark: -1 })); rows[0] = { mark }; return rows; };
  const E = 0x7fff;
  return {
    patterns: [mkPat(0xa), mkPat(0xb), mkPat(0xc), mkPat(0xd)],
    cues: [
      Uint16Array.from([2 | 0x8000, E, 0, E]),  // ch0 → pat 2 (with an instruction sign bit), ch2 → pat 0
      Uint16Array.from([2, E, E, E]),            // ch0 → pat 2 again
    ],
  };
}

test("referencedPatterns: first-appearance order, empties skipped", () => {
  assert.deepEqual(referencedPatterns(synthSong()), [2, 0]);
});

test("planCleanupPatterns: only referenced patterns, ascending", () => {
  assert.deepEqual(planCleanupPatterns(synthSong()), [0, 2]);
});

test("planRenumberPatterns: referenced first (play order), then extras", () => {
  // referenced 2,0 (appearance) then unreferenced-materialised 1,3
  assert.deepEqual(planRenumberPatterns(synthSong()), [2, 0, 1, 3]);
});

test("applyPatternOrder: rewrites cue refs, keeps the instruction sign bit", () => {
  const song = synthSong();
  const order = planCleanupPatterns(song); // [0, 2] → new indices 0→0, 2→1
  const { patterns, cues } = applyPatternOrder(song, order, []);
  assert.equal(patterns.length, 2);
  assert.equal(patterns[0][0].mark, 0xa); // old pattern 0
  assert.equal(patterns[1][0].mark, 0xc); // old pattern 2
  // cue 0: ch0 old pat 2 → new 1 (sign bit kept), ch2 old pat 0 → new 0
  assert.equal(cues[0][0] & 0x7fff, 1);
  assert.equal(cues[0][0] & 0x8000, 0x8000, "instruction sign bit preserved");
  assert.equal(cues[0][2] & 0x7fff, 0);
  assert.equal(cues[0][1], 0x7fff, "empty slot untouched");
});

// A song with real (getByte-capable) patterns: 0 and 2 are byte-identical, 1 differs.
function dupSong() {
  const mk = (note) => {
    const rows = [];
    for (let r = 0; r < 64; r++) { const c = new TaudPlayData(); c.volumeEff = 3; c.panEff = 3; rows.push(c); }
    rows[0].note = note;
    return rows;
  };
  const E = 0x7fff;
  return {
    patterns: [mk(0x5000), mk(0x6000), mk(0x5000)], // pattern 2 duplicates pattern 0
    cues: [Uint16Array.from([0, 1, 2, E])],          // plays 0, 1, 2
  };
}

test("planMergeDuplicatePatterns: identical content collapses onto the lowest copy", () => {
  const song = dupSong();
  const referenced = planCleanupPatterns(song); // [0, 1, 2]
  const { order, canon } = planMergeDuplicatePatterns(song, referenced);
  assert.deepEqual(order, [0, 1], "duplicate pattern 2 dropped from the keep-order");
  assert.equal(canon.get(0), 0);
  assert.equal(canon.get(1), 1);
  assert.equal(canon.get(2), 0, "pattern 2 merges onto pattern 0");
});

test("applyPatternOrder with canon: cue words pointing at a duplicate follow the survivor", () => {
  const song = dupSong();
  const referenced = planCleanupPatterns(song);
  const { order, canon } = planMergeDuplicatePatterns(song, referenced);
  const { patterns, cues } = applyPatternOrder(song, order, [], canon);
  assert.equal(patterns.length, 2);
  assert.equal(cues[0][0] & 0x7fff, 0);
  assert.equal(cues[0][1] & 0x7fff, 1);
  assert.equal(cues[0][2] & 0x7fff, 0, "the duplicate re-targets the survivor");
  assert.equal(cues[0][3], 0x7fff, "empty slot untouched");
});

test("planMergeDuplicatePatterns: no duplicates is an identity (order + canon)", () => {
  const s = dupSong(); s.patterns[2][0].note = 0x7000; // now all three differ
  const { order, canon } = planMergeDuplicatePatterns(s, [0, 1, 2]);
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(canon.get(2), 2);
});

test("cleanup merges byte-identical duplicates on WHEN: cues keep their content; undo byte-exact", () => {
  const doc = loadWhen();
  const song = doc.songs[0];
  const referenced = planCleanupPatterns(song);
  assert.ok(referenced.length >= 2, "WHEN references at least two patterns");
  const [p, q] = referenced; // two distinct referenced patterns
  // Overwrite q with a byte-identical copy of p so they de-dupe.
  song.patterns[q] = song.patterns[p].map((cell) => {
    const c = new TaudPlayData();
    for (let b = 0; b < 8; b++) c.setByte(b, cell.getByte(b));
    return c;
  });

  const before = Buffer.from(doc.toBytes());
  const playBytes = () => {
    const out = [];
    for (const words of doc.songs[0].cues) for (const w of words) {
      const pat = w & 0x7fff;
      if (pat !== 0x7fff) out.push(Buffer.from(doc.patternBytes(0, pat)).toString("hex"));
    }
    return out;
  };
  const playedBefore = playBytes();

  const { order, canon } = planMergeDuplicatePatterns(song, referenced);
  assert.equal(canon.get(q), p, "duplicate q merges onto p");
  assert.ok(!order.includes(q), "q dropped from the keep-order");
  const plan = applyPatternOrder(song, order, doc._nameTable("pNam"), canon);

  const undo = new UndoStack(doc);
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, encodeNameTable(plan.pNam)));

  assert.deepEqual(playBytes(), playedBefore, "every cue plays the same content after the merge");
  assert.equal(doc.songs[0].patterns.length, order.length, "pattern count dropped by the merge");

  undo.undo();
  assert.deepEqual([...doc.toBytes()], [...before], "undo byte-exact");
});

test("encodeNameTable round-trips through the 0x1E split", () => {
  const payload = encodeNameTable(["intro", "", "chorus"]);
  const doc = loadWhen();
  doc.setSection("pNam", payload);
  assert.deepEqual(doc._nameTable("pNam").slice(0, 3), ["intro", "", "chorus"]);
  assert.equal(encodeNameTable([]), null);
});

test("remapPatternsOp on WHEN: cleanup preserves what each cue plays; undo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const song = doc.songs[0];

  // Snapshot the bytes each (cue,ch) plays.
  const playBytes = () => {
    const out = [];
    for (const words of doc.songs[0].cues) {
      for (const w of words) {
        const pat = w & 0x7fff;
        if (pat !== 0x7fff) out.push(Buffer.from(doc.patternBytes(0, pat)).toString("hex"));
      }
    }
    return out;
  };
  const playedBefore = playBytes();

  const order = planCleanupPatterns(song);
  const plan = applyPatternOrder(song, order, doc._nameTable("pNam"));
  const undo = new UndoStack(doc);
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, encodeNameTable(plan.pNam)));

  assert.equal(doc.songs[0].patterns.length, order.length, "pattern count = referenced set");
  assert.deepEqual(playBytes(), playedBefore, "every cue plays the same content after remap");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("usedInstrumentSlots: pattern cells + meta-layer closure", () => {
  // inst 5 used by a cell; meta 5 has layer child 200 (also a used slot)
  const song = { patterns: [[{ instrment: 5 }, ...new Array(63).fill({ instrment: 0 })]], cues: [] };
  const allUsed = new Set([5, 200, 99]);
  const instAt = (s) => (s === 5 ? { metaLayers: [{ instIdx: 200 }] } : null);
  const used = usedInstrumentSlots(song, allUsed, instAt);
  assert.ok(used.has(5) && used.has(200), "cell inst + its meta child are used");
  assert.ok(!used.has(99), "unreferenced slot is not used");
});

test("planBankCleanup + cleanupBankOp on WHEN: removes unused insts; survivors intact; undo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());

  // The instruments patterns actually reference must survive verbatim.
  const usedInPatterns = new Set();
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const c of p) if (c.instrment) usedInPatterns.add(c.instrment & 0xff);
  }
  const survivorRecords = new Map();
  for (const s of usedInPatterns) survivorRecords.set(s, Buffer.from(doc.instRecordBytes(s)));

  const plan = planBankCleanup(doc);
  assert.ok(plan.removedInstruments >= 1, "WHEN has ≥1 unused instrument to remove");

  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(plan));

  for (const [s, rec] of survivorRecords) {
    assert.ok(Buffer.from(doc.instRecordBytes(s)).equals(rec), `used inst $${s.toString(16)} intact`);
  }
  assert.ok(!Buffer.from(doc.toBytes()).equals(before), "cleanup changed the file");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

// ── item 73: renumber one instrument ──

test("planRenumberInstrument moves the record + name + Ixmp; wiring follows", () => {
  const doc = loadWhen();
  const from = doc.selectableInstrumentSlots()[0];
  const to = 0xfe; // free in WHEN
  assert.ok(!doc.usedInstrumentSlots().includes(to));
  const record = doc.instRecordBytes(from);
  const name = doc.instrumentName(from);
  const refs = instrumentCellRefs(doc, from);
  assert.ok(refs.length > 0, "the fixture instrument should be played somewhere");

  const plan = planRenumberInstrument(doc, from, to);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.cells.length, 0); // patterns untouched by default
  const undo = new UndoStack(doc);
  undo.apply(renumberInstrumentOp(plan));

  assert.deepEqual([...doc.instRecordBytes(to)], [...record]);
  assert.ok(doc.instRecordBytes(from).every((b) => b === 0), "old slot is cleared");
  assert.equal(doc.instrumentName(to), name);
  assert.equal(doc.instrumentName(from), "");
  assert.ok(doc.usedInstrumentSlots().includes(to));
  assert.ok(!doc.usedInstrumentSlots().includes(from));
  // Default: the notes still name the OLD number (the user didn't ask to move them).
  assert.equal(instrumentCellRefs(doc, from).length, refs.length);
  assert.equal(instrumentCellRefs(doc, to).length, 0);
});

test("planRenumberInstrument with remapPatterns moves the notes too", () => {
  const doc = loadWhen();
  const from = doc.selectableInstrumentSlots()[0];
  const to = 0xfe;
  const refs = instrumentCellRefs(doc, from).length;
  const plan = planRenumberInstrument(doc, from, to, { remapPatterns: true });
  assert.equal(plan.cells.length, refs);
  const undo = new UndoStack(doc);
  undo.apply(renumberInstrumentOp(plan));
  assert.equal(instrumentCellRefs(doc, to).length, refs);
  assert.equal(instrumentCellRefs(doc, from).length, 0);
  // Every touched pattern is flagged for re-upload.
  const tags = renumberInstrumentOp(plan).dirty();
  assert.ok(tags.some((x) => x.kind === "bank"));
  assert.ok(tags.filter((x) => x.kind === "pattern").length > 0);
});

test("renumbering a metainstrument's layer child rewrites the layer table", () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "M_E1M1.taud")));
  const metaSlot = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const child = doc.instruments[metaSlot].metaLayers[0].instIdx & 0x3ff;
  const layerIdx = 0;
  const to = [...Array(255).keys()].map((i) => i + 1)
    .find((s) => !doc.usedInstrumentSlots().includes(s));
  const plan = planRenumberInstrument(doc, child, to);
  assert.ok(!plan.error, plan.error);
  const undo = new UndoStack(doc);
  undo.apply(renumberInstrumentOp(plan));
  assert.equal(doc.instruments[metaSlot].metaLayers[layerIdx].instIdx, to);
  assert.equal(doc.instruments[metaSlot].isMeta, true);
});

test("planRenumberInstrument refuses occupied targets and out-of-range numbers", () => {
  const doc = loadWhen();
  const [a, b] = doc.selectableInstrumentSlots();
  assert.match(planRenumberInstrument(doc, a, b).error ?? "", /already taken/);
  assert.match(planRenumberInstrument(doc, a, 0).error ?? "", /\$01–\$FF/);
  assert.match(planRenumberInstrument(doc, a, 0x100).error ?? "", /\$01–\$FF/);
  assert.match(planRenumberInstrument(doc, a, a).error ?? "", /already has/);
  const free = [...Array(255).keys()].map((i) => i + 1)
    .find((s) => !doc.usedInstrumentSlots().includes(s));
  assert.match(planRenumberInstrument(doc, free, 0xfe).error ?? "", /empty/);
});

test("renumberInstrumentOp undo is byte-exact (with and without pattern remap)", () => {
  for (const remapPatterns of [false, true]) {
    const doc = loadWhen();
    const baseline = doc.toBytes();
    const from = doc.selectableInstrumentSlots()[0];
    const plan = planRenumberInstrument(doc, from, 0xfe, { remapPatterns });
    const undo = new UndoStack(doc);
    undo.apply(renumberInstrumentOp(plan));
    assert.notEqual(Buffer.compare(Buffer.from(doc.toBytes()), Buffer.from(baseline)), 0);
    undo.undo();
    assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)),
      `undo byte-exact (remapPatterns=${remapPatterns})`);
    undo.redo();
    assert.ok(doc.usedInstrumentSlots().includes(0xfe));
  }
});

// ── item 74: unreachable instrument patches ──

/** Patch stub with just the fields the planner reads. */
const mkPatch = (pitchStart, pitchEnd, volumeStart, volumeEnd, extra = {}) => ({
  pitchStart, pitchEnd, volumeStart, volumeEnd,
  samplePtr: 0, sampleLength: 16, playStart: 0, loopStart: 0, loopEnd: 0,
  samplingRate: 8363, sampleDetune: 0, loopMode: 0, defaultPan: 0xff,
  defaultNoteVolume: 0, vibratoSpeed: 0, vibratoSweep: 0, vibratoDepth: 0,
  vibratoRate: 0, vibratoWaveform: 0xff, hasExtra: false,
  volEnv: null, panEnv: null, filterEnv: null, pitchEnv: null, ...extra,
});

test("planIxmpCleanup drops degenerate, shadowed and orphan patches", () => {
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots()[0];
  const orphan = [...Array(1023).keys()].find((s) => s > 0 && !doc.usedInstrumentSlots().includes(s));
  const patches = [
    mkPatch(0x1000, 0x8000, 0, 63),         // 0 keep
    mkPatch(0x2000, 0x3000, 10, 40),        // 1 DROP — inside patch 0
    mkPatch(0x9000, 0xa000, 0, 63),         // 2 keep
    mkPatch(0x9000, 0xa000, 0, 63, { sampleLength: 0 }), // 3 DROP — no sample
    mkPatch(0xb000, 0xa000, 0, 63),         // 4 DROP — empty pitch range
    mkPatch(0x1000, 0xa000, 0, 63),         // 5 keep — only PARTLY covered
  ];
  doc.ixmp = [
    { instId: slot, count: patches.length, blob: writePatchesBlob(patches) },
    { instId: orphan, count: 1, blob: writePatchesBlob([mkPatch(0, 0xffff, 0, 63)]) },
  ];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  const plan = planIxmpCleanup(doc);
  assert.ok(!plan.noop);
  assert.equal(plan.removedPatches, 4);  // 3 unreachable + the orphan's 1
  assert.equal(plan.removedBlobs, 1);    // the orphan blob
  assert.equal(plan.ixmp.length, 1);
  assert.ok(!plan.ixmp.some((e) => (e.instId & 0x3ff) === orphan));

  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(plan));
  const kept = doc.instruments[slot].extraPatches;
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((p) => p.pitchStart), [0x1000, 0x9000, 0x1000]);
  assert.equal(doc.instruments[orphan].extraPatches, null);
});

test("planIxmpCleanup frees the sample bytes only a dropped patch used; a kept patch's sample survives", () => {
  // Regression: the planner dropped patch entries but passed `image` straight
  // through unmodified, so a shadowed/degenerate patch's uniquely-owned sample
  // bytes never got zeroed even though the patch (and its SNam entry) was gone.
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots()[0];

  const uniquePtr = 900000, uniqueLen = 500;   // only the DROPPED patch uses this
  const keptPtr = 910000, keptLen = 500;       // the COVERING patch's own sample
  const img = doc.sampleInstImage;
  img.fill(0x42, uniquePtr, uniquePtr + uniqueLen);
  img.fill(0x43, keptPtr, keptPtr + keptLen);

  const patches = [
    mkPatch(0x0000, 0xffff, 0, 63, { samplePtr: keptPtr, sampleLength: keptLen }),      // keep, covers all
    mkPatch(0x1000, 0x2000, 10, 40, { samplePtr: uniquePtr, sampleLength: uniqueLen }), // DROP — shadowed
  ];
  doc.ixmp = [{ instId: slot, count: patches.length, blob: writePatchesBlob(patches) }];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  const plan = planIxmpCleanup(doc);
  assert.ok(!plan.noop);
  assert.equal(plan.removedPatches, 1);
  assert.ok(plan.freedSampleBytes >= uniqueLen, "reports the freed bytes");
  assert.ok([...plan.image.subarray(uniquePtr, uniquePtr + uniqueLen)].every((b) => b === 0),
    "the dropped patch's unique sample is zeroed");
  assert.ok([...plan.image.subarray(keptPtr, keptPtr + keptLen)].every((b) => b === 0x43),
    "the kept patch's sample is untouched");

  const baseline = doc.toBytes();
  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(plan));
  assert.ok([...doc.sampleBin.subarray(uniquePtr, uniquePtr + uniqueLen)].every((b) => b === 0));
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
});

test("planIxmpCleanup prunes patches no pattern cell actually plays (usage-based, item 74 extension)", () => {
  // The reported scenario: an imported drum kit carries one Ixmp patch per
  // drum piece, each on its OWN disjoint pitch — geometrically none of them
  // shadow each other, so the pre-existing rectangle-coverage pass alone finds
  // nothing to remove even when the song only ever plays one of them.
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots().find((s) => !doc.instruments[s].isMeta);
  assert.ok(slot !== undefined, "WHEN has a plain (non-meta) instrument");

  // Scrub every existing reference to `slot` so the ONLY trigger left is the
  // one this test controls.
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const cell of p) if ((cell.instrment & 0xff) === slot) cell.instrment = 0;
  }

  const usedPtr = 900000, usedLen = 500;     // "kick" — actually played
  const unusedPtr = 901000, unusedLen = 500; // "snare" — never played
  const img = doc.sampleInstImage;
  img.fill(0x11, usedPtr, usedPtr + usedLen);
  img.fill(0x22, unusedPtr, unusedPtr + unusedLen);

  const patches = [
    mkPatch(0x1000, 0x1000, 0, 63, { samplePtr: usedPtr, sampleLength: usedLen }),
    mkPatch(0x2000, 0x2000, 0, 63, { samplePtr: unusedPtr, sampleLength: unusedLen }),
  ];
  doc.ixmp = [{ instId: slot, count: patches.length, blob: writePatchesBlob(patches) }];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  // One trigger cell: the kick's exact pitch, an explicit volume-column SET.
  const pat = doc.songs[0].patterns.find((p) => p);
  assert.ok(pat, "WHEN has at least one pattern");
  pat[0].note = 0x1000;
  pat[0].instrment = slot;
  pat[0].volumeEff = 0;
  pat[0].volume = doc.wideCells ? 0xff : 0x3f; // full-scale SET, narrows to 63 either way

  const plan = planIxmpCleanup(doc);
  assert.ok(!plan.noop);
  assert.equal(plan.removedPatches, 1, "only the never-played patch drops");
  assert.ok(plan.freedSampleBytes >= unusedLen, "its private sample is freed too");
  assert.ok([...plan.image.subarray(unusedPtr, unusedPtr + unusedLen)].every((b) => b === 0));
  assert.ok([...plan.image.subarray(usedPtr, usedPtr + usedLen)].every((b) => b === 0x11),
    "the played patch's sample survives");

  const baseline = doc.toBytes();
  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(plan));
  assert.equal(doc.instruments[slot].extraPatches.length, 1);
  assert.equal(doc.instruments[slot].extraPatches[0].pitchStart, 0x1000);
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo byte-exact");
});

test("planIxmpCleanup leaves a slot's patches untouched by usage-pruning when a trigger row is ambiguous", () => {
  // An instrument-byte-only row (no note) resolves its pitch from whatever the
  // lane was already holding — not statically knowable from the cell alone
  // — so a static scan must NOT guess it can never reach the second patch.
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots().find((s) => !doc.instruments[s].isMeta);
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const cell of p) if ((cell.instrment & 0xff) === slot) cell.instrment = 0;
  }

  const patches = [mkPatch(0x1000, 0x1000, 0, 63), mkPatch(0x2000, 0x2000, 0, 63)];
  doc.ixmp = [{ instId: slot, count: patches.length, blob: writePatchesBlob(patches) }];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  const pat = doc.songs[0].patterns.find((p) => p);
  pat[0].note = 0x1000; pat[0].instrment = slot; pat[0].volumeEff = 0; pat[0].volume = 0x3f;
  pat[1].note = 0x0000; pat[1].instrment = slot; // instrument-byte-only: ambiguous

  assert.ok(planIxmpCleanup(doc).noop, "an ambiguous trigger row blocks usage-pruning for this slot");
});

test("planIxmpCleanup leaves a slot's patches untouched by usage-pruning across a tone-portamento row", () => {
  // A G/L row that continues an already-sounding note resolves pitch from the
  // lane's CURRENT position, not the row's own note column.
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots().find((s) => !doc.instruments[s].isMeta);
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const cell of p) if ((cell.instrment & 0xff) === slot) cell.instrment = 0;
  }

  const patches = [mkPatch(0x1000, 0x1000, 0, 63), mkPatch(0x2000, 0x2000, 0, 63)];
  doc.ixmp = [{ instId: slot, count: patches.length, blob: writePatchesBlob(patches) }];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  const pat = doc.songs[0].patterns.find((p) => p);
  pat[0].note = 0x1000; pat[0].instrment = slot; pat[0].volumeEff = 0; pat[0].volume = 0x3f;
  pat[1].note = 0x3000; pat[1].instrment = slot; pat[1].effect = EffectOp.OP_G; // tone porta

  assert.ok(planIxmpCleanup(doc).noop, "a tone-portamento row blocks usage-pruning for this slot");
});

test("planIxmpCleanup: a union of earlier patches shadows, one that misses a corner doesn't", () => {
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots()[0];
  const covered = [
    mkPatch(0x1000, 0x2000, 0, 31),   // lower half
    mkPatch(0x1000, 0x2000, 32, 63),  // upper half — together they cover…
    mkPatch(0x1000, 0x2000, 0, 63),   // …this one exactly → DROP
  ];
  const notCovered = [
    mkPatch(0x1000, 0x2000, 0, 31),
    mkPatch(0x1000, 0x2000, 32, 62),  // one velocity short
    mkPatch(0x1000, 0x2000, 0, 63),   // → keep
  ];
  const run = (patches) => {
    const d = loadWhen();
    d.ixmp = [{ instId: slot, count: patches.length, blob: writePatchesBlob(patches) }];
    d.setSection("Ixmp", buildIxmpSection(d.ixmp));
    d._resetInstrumentCache();
    return planIxmpCleanup(d);
  };
  assert.equal(run(covered).removedPatches, 1);
  assert.equal(run(notCovered).noop, true);
});

test("planIxmpCleanup is a no-op on the real corpus and undo stays byte-exact", () => {
  for (const file of ["WHEN.taud", "M_E1M1.taud", "flourish.taud"]) {
    const doc = new Document(parseTaud(readFileSync(corpusDir + file)));
    const plan = planIxmpCleanup(doc);
    assert.equal(plan.noop, true, `${file}: converter output has no unreachable patches`);
  }
  // Undo of a real cleanup restores the file bytes exactly.
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots()[0];
  doc.ixmp = [{ instId: slot, count: 2, blob: writePatchesBlob([
    mkPatch(0x1000, 0x8000, 0, 63), mkPatch(0x2000, 0x3000, 10, 40),
  ]) }];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();
  const baseline = doc.toBytes();
  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(planIxmpCleanup(doc)));
  assert.notEqual(Buffer.compare(Buffer.from(doc.toBytes()), Buffer.from(baseline)), 0);
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo is byte-exact");
});

test("cleanupBankOp rebuilds the Ixmp SECTION, so a cleanup survives a save/reload", () => {
  // Regression: toBytes() writes projSections, not doc.ixmp — an op that only
  // swapped doc.ixmp left the dropped patches in the saved file, and reloading
  // brought them back (and re-marked the slot used).
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots()[0];
  const orphan = [...Array(1023).keys()].find((s) => s > 0 && !doc.usedInstrumentSlots().includes(s));
  doc.ixmp = [
    { instId: slot, count: 1, blob: writePatchesBlob([mkPatch(0x1000, 0x8000, 0, 63)]) },
    { instId: orphan, count: 1, blob: writePatchesBlob([mkPatch(0, 0xffff, 0, 63)]) },
  ];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(planIxmpCleanup(doc)));
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.ok(!reloaded.ixmp.some((e) => (e.instId & 0x3ff) === orphan), "orphan blob is gone from the file");
  assert.ok(reloaded.ixmp.some((e) => (e.instId & 0x3ff) === slot), "the live slot keeps its patches");
  assert.equal(reloaded.instruments[orphan].extraPatches, null);
});

test("renumbering carries the Ixmp patches in the SAVED file, not just live", () => {
  // Regression: the op swapped doc.ixmp but not the "Ixmp" SECTION, and toBytes()
  // writes sections — so a save/reload re-bound the patches to the OLD number
  // (an orphan blob) while the live doc looked right. WHEN has no Ixmp at all,
  // which is why the first round of tests missed this.
  const doc = new Document(parseTaud(readFileSync(corpusDir + "M_E1M1.taud")));
  const metaSlot = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const child = doc.instruments[metaSlot].metaLayers
    .map((l) => l.instIdx & 0x3ff)
    .find((c) => (doc.instruments[c].extraPatches?.length ?? 0) > 0);
  const patches = doc.instruments[child].extraPatches.length;
  const to = [...Array(255).keys()].map((i) => i + 1)
    .find((s) => !doc.usedInstrumentSlots().includes(s));

  const baseline = doc.toBytes();
  const undo = new UndoStack(doc);
  undo.apply(renumberInstrumentOp(planRenumberInstrument(doc, child, to)));

  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.instruments[to].extraPatches?.length, patches, "patches followed the move");
  assert.ok(!reloaded.ixmp.some((e) => (e.instId & 0x3ff) === child), "no orphan blob at the old number");
  assert.equal(reloaded.instruments[metaSlot].metaLayers.some((l) => l.instIdx === to), true,
    "the meta layer points at the new number");
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(Buffer.from(baseline)), "undo is byte-exact");
});

test("instrumentCellRefs never masks a $100+ sub-instrument onto an $01-$FF slot", () => {
  // Regression: `(cell.instrment & 0xff) === (slot & 0xff)` matched slot $101
  // against every cell playing $01, so renumbering a meta child with "remap
  // patterns" ticked would have repointed an unrelated instrument's notes.
  // The reachable path: item 72 puts the copies at $100, $101, … and item 71's
  // Edit… opens them, so $101 (low byte $01) is one Renumber… away.
  const doc = loadWhen();
  const picks = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta).slice(0, 2);
  const undo = new UndoStack(doc);
  undo.apply(importBankOp(planCreateMeta(doc, picks, "Stack")));
  const child = 0x101;
  assert.ok(doc.metaChildSlots().has(child), "item 72 puts the second copy at $101");

  // $01 IS played by real cells; $101 can't be (the cell byte is 8-bit).
  const lowRefs = instrumentCellRefs(doc, 0x01).length;
  assert.ok(lowRefs > 0, "$01 should be a real, played instrument");
  assert.equal(instrumentCellRefs(doc, child).length, 0);

  const plan = planRenumberInstrument(doc, child, 0xfe, { remapPatterns: true });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.cells.length, 0, "no pattern cell may follow a sub-instrument move");
  undo.apply(renumberInstrumentOp(plan));
  assert.equal(instrumentCellRefs(doc, 0x01).length, lowRefs, "$01's cells are untouched");
  assert.equal(doc.instruments[0xfe].isMeta, false);
  // Slot $100's low byte is $00 = "no instrument" — it must not match empty cells either.
  assert.equal(instrumentCellRefs(doc, 0x100).length, 0);
});

// ── item 147: the usage pass reaches through metainstruments ──

/** WHEN with `slot` carrying two patches on disjoint pitches (each with its own
 *  pool span), wrapped in a fresh metainstrument whose layer child inherits
 *  them. Returns {doc, meta, child, lowPitch, highPitch, lowPtr, highPtr, len}. */
function kitDoc() {
  const doc = loadWhen();
  const slot = doc.selectableInstrumentSlots().find((s) => !doc.instruments[s].isMeta);
  const lowPtr = 900000, highPtr = 901000, len = 500;
  doc.sampleInstImage.fill(0x11, lowPtr, lowPtr + len);
  doc.sampleInstImage.fill(0x22, highPtr, highPtr + len);
  const patches = [
    mkPatch(0x1000, 0x1000, 0, 63, { samplePtr: lowPtr, sampleLength: len }),
    mkPatch(0x2000, 0x2000, 0, 63, { samplePtr: highPtr, sampleLength: len }),
  ];
  doc.ixmp = [{ instId: slot, count: patches.length, blob: writePatchesBlob(patches) }];
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  doc._resetInstrumentCache();

  const plan = planCreateMeta(doc, [slot], "Kit");
  assert.ok(!plan.error, plan.error);
  new UndoStack(doc).apply(importBankOp(plan));
  const meta = plan.insts.find((it) => it.topLevel).destSlot;
  const child = plan.insts.find((it) => !it.topLevel).destSlot;
  assert.ok(doc.instruments[meta].isMeta && doc.metaChildSlots().has(child));

  // The kit is played on ONE note, at one velocity — the item 147 report.
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const cell of p) {
      cell.note = 0; cell.instrment = 0; cell.effect = 0; cell.volumeEff = 1;
    }
  }
  const pat = doc.songs[0].patterns.find((p) => p);
  pat[0].note = 0x1000;
  pat[0].instrment = meta;
  pat[0].volumeEff = 0;
  pat[0].volume = doc.wideCells ? 0xff : 0x3f;
  return { doc, meta, child, lowPtr, highPtr, len };
}

test("planIxmpCleanup prunes a metainstrument layer child's unplayed patches (item 147)", () => {
  const { doc, child, lowPtr, highPtr, len } = kitDoc();
  const plan = planIxmpCleanup(doc);
  assert.ok(!plan.noop, "a meta's children used to be skipped entirely");
  const kept = plan.report.find((r) => r.slot === child);
  assert.ok(kept, "the layer child was analysed");
  assert.equal(kept.kept, 1, "only the patch the one played note reaches survives");
  assert.equal(kept.keep[0].samplePtr, lowPtr);
  assert.ok([...plan.image.subarray(highPtr, highPtr + len)].every((b) => b === 0),
    "the unplayed patch's sample is freed");
  assert.ok([...plan.image.subarray(lowPtr, lowPtr + len)].every((b) => b === 0x11),
    "the played one's is not");
});

test("the layer's detune moves which patch the child reaches", () => {
  const { doc, child } = kitDoc();
  // Retune the layer a whole 0x1000 up: the cell's 0x1000 now lands the child
  // on 0x2000, so the OTHER patch is the reachable one.
  for (const l of doc.instruments[doc.selectableInstrumentSlots().find(
    (s) => doc.instruments[s].isMeta && doc.instruments[s].metaLayers?.some(
      (x) => (x.instIdx & 0x3ff) === child))].metaLayers) {
    if ((l.instIdx & 0x3ff) === child) l.detune = 0x1000;
  }
  const sets = reachablePatchSets(doc);
  const reachable = [...sets.get(child)];
  assert.equal(reachable.length, 1);
  assert.equal(reachable[0].pitchStart, 0x2000, "the detuned pitch is what resolves");
});

test("planBankCleanup frees a kept instrument's unreachable patch samples (item 147)", () => {
  const { doc, meta, child, lowPtr, highPtr, len } = kitDoc();
  const before = Buffer.from(doc.toBytes());
  const plan = planBankCleanup(doc);
  assert.ok(plan.removedPatches > 0, "the survivors' dead patches go with the dead instruments");
  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(plan));

  assert.ok(doc.usedInstrumentSlots().includes(meta), "the played metainstrument stays");
  assert.deepEqual((doc.instruments[child].extraPatches ?? []).map((p) => p.samplePtr), [lowPtr]);
  assert.ok(doc.sampleBin.subarray(highPtr, highPtr + len).every((b) => b === 0),
    "and the sample only the dropped patch used is freed");
  // Idempotent: a second pass over the cleaned document finds nothing.
  const again = planBankCleanup(doc);
  assert.equal(again.removedInstruments, 0);
  assert.equal(again.removedPatches, 0);
  assert.equal(again.freedSampleBytes, 0);

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("a note with no instrument byte keeps every candidate's patches", () => {
  // The lane's latched instrument sounds it, and which one that is depends on
  // what came before — so the note must not be read as "only what the row says".
  const { doc, child } = kitDoc();
  const pat = doc.songs[0].patterns.find((p) => p);
  pat[1].note = 0x2000; // no instrument byte: any latched instrument could sound it
  pat[1].volumeEff = 1;
  const reachable = reachablePatchSets(doc).get(child);
  assert.equal(reachable.size, 2, "both patches stay reachable");
});

test("planBankCleanup on the real corpus prunes no patch — everything there is played", () => {
  for (const f of ["Onestop.taud", "town.taud", "flourish.taud"]) {
    const doc = new Document(parseTaud(readFileSync(corpusDir + f)));
    const plan = planBankCleanup(doc);
    assert.equal(plan.removedPatches, 0, `${f} keeps every patch`);
  }
});
