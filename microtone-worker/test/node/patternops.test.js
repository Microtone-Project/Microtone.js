// Pattern-view edit operations — the pure byte transforms (patterntools.js),
// the notation-aware single-pattern transpose (pitchtables.js) and the three
// new invertible ops (setPatternBytesOp / appendPatternOp / bulkNotesOp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  emptyPatternBytes, expandPatternBytes, shrinkPatternBytes,
  scaleVolumeBytes, transformPanBytes, changeInstrumentBytes,
} from "../../src/doc/patterntools.js";
import { setPatternBytesOp, appendPatternOp, bulkNotesOp, setCellOp } from "../../src/doc/ops.js";
import {
  pitchTablePresets, transposePatternNotes, transposeAllPatterns, transposeUnitKeys,
  ANCHOR_NOTE,
} from "../../core/tuning/pitchtables.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document, Song } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

test("emptyPatternBytes: converter blank-cell convention (0xC0 vol/pan)", () => {
  const b = emptyPatternBytes();
  assert.equal(b.length, 512);
  for (let r = 0; r < 64; r++) {
    assert.equal(b[r * 8 + 3], 0xc0, `row ${r} vol`);
    assert.equal(b[r * 8 + 4], 0xc0, `row ${r} pan`);
    for (const off of [0, 1, 2, 5, 6, 7]) assert.equal(b[r * 8 + off], 0);
  }
});

test("expand/shrink: IT Alt-F/Alt-G row mapping", () => {
  const src = new Uint8Array(512);
  for (let r = 0; r < 64; r++) for (let b = 0; b < 8; b++) src[r * 8 + b] = (r * 8 + b) & 0xff;

  const ex = expandPatternBytes(src);
  for (let r = 0; r < 32; r++) {
    assert.deepEqual([...ex.subarray(r * 16, r * 16 + 8)], [...src.subarray(r * 8, r * 8 + 8)],
      `row ${r} lands on ${2 * r}`);
    assert.equal(ex[(2 * r + 1) * 8 + 3], 0xc0, `blank between rows is empty-convention`);
  }

  const sh = shrinkPatternBytes(src);
  for (let r = 0; r < 32; r++) {
    assert.deepEqual([...sh.subarray(r * 8, r * 8 + 8)], [...src.subarray(2 * r * 8, 2 * r * 8 + 8)],
      `row ${2 * r} lands on ${r}`);
  }
  assert.equal(sh[40 * 8 + 3], 0xc0, "tail is blank");

  // shrink(expand(x)) restores the first half verbatim
  const round = shrinkPatternBytes(expandPatternBytes(src));
  assert.deepEqual([...round.subarray(0, 32 * 8)], [...src.subarray(0, 32 * 8)]);
});

test("expand/shrink: arbitrary integer factor (TODO #33)", () => {
  const src = new Uint8Array(512);
  for (let r = 0; r < 64; r++) for (let b = 0; b < 8; b++) src[r * 8 + b] = (r * 8 + b) & 0xff;

  // ×3: source row r lands on 3r while 3r ≤ 63 (r = 0..21), rows between blank.
  const ex3 = expandPatternBytes(src, 3);
  for (let r = 0; 3 * r <= 63; r++) {
    assert.deepEqual([...ex3.subarray(3 * r * 8, 3 * r * 8 + 8)], [...src.subarray(r * 8, r * 8 + 8)],
      `row ${r} lands on ${3 * r}`);
    if (3 * r + 1 <= 63) assert.equal(ex3[(3 * r + 1) * 8 + 3], 0xc0, "gap row is empty-convention");
  }
  // the highest source row that fits is r=21 (→63); r=22 (→66) is dropped.
  assert.deepEqual([...ex3.subarray(63 * 8, 63 * 8 + 8)], [...src.subarray(21 * 8, 21 * 8 + 8)]);

  // ÷3: source row 3r lands on r (r = 0..21), tail blank.
  const sh3 = shrinkPatternBytes(src, 3);
  for (let r = 0; 3 * r <= 63; r++) {
    assert.deepEqual([...sh3.subarray(r * 8, r * 8 + 8)], [...src.subarray(3 * r * 8, 3 * r * 8 + 8)],
      `row ${3 * r} lands on ${r}`);
  }
  assert.equal(sh3[22 * 8 + 3], 0xc0, "tail past the last kept row is blank");

  // shrink(expand(x, n), n) restores every fitting source row for any n
  for (const n of [2, 3, 4, 7]) {
    const round = shrinkPatternBytes(expandPatternBytes(src, n), n);
    for (let r = 0; r * n <= 63; r++) {
      assert.deepEqual([...round.subarray(r * 8, r * 8 + 8)], [...src.subarray(r * 8, r * 8 + 8)],
        `factor ${n} round-trip row ${r}`);
    }
  }

  // default factor stays 2 (back-compat with the fixed ×2/÷2 call sites)
  assert.deepEqual([...expandPatternBytes(src)], [...expandPatternBytes(src, 2)]);
  assert.deepEqual([...shrinkPatternBytes(src)], [...shrinkPatternBytes(src, 2)]);
});

/** First pattern whose expansion differs from itself (a lone row-0 note
 *  expands to an identical image, which would make the assertions vacuous). */
function patternWithNotes(doc) {
  for (let p = 0; p < doc.songs[0].patterns.length; p++) {
    const src = doc.patternBytes(0, p);
    const ex = expandPatternBytes(src);
    if (ex.some((v, i) => v !== src[i])) return p;
  }
  throw new Error("corpus has no expandable pattern");
}

test("setPatternBytesOp: whole-pattern swap, undo/redo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const pat = patternWithNotes(doc);
  const src = doc.patternBytes(0, pat);

  const op = setPatternBytesOp(0, pat, expandPatternBytes(src));
  assert.deepEqual(op.dirty(doc), [{ kind: "pattern", song: 0, pat }]);
  undo.apply(op);
  assert.deepEqual([...doc.patternBytes(0, pat)], [...expandPatternBytes(src)]);
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before));

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("item 48: arbitrary-number pattern — edit beyond the end materialises + round-trips", () => {
  const doc = loadWhen();
  const n0 = doc.songs[0].patterns.length;
  const target = n0 + 5; // several past the end

  // ensurePattern grows with NULL gaps and fills only the target.
  doc.ensurePattern(0, target);
  assert.equal(doc.songs[0].patterns.length, target + 1);
  assert.equal(doc.songs[0].patterns[n0], null, "gap stays null (cheap)");
  assert.ok(doc.songs[0].patterns[target], "target materialised");
  assert.equal(doc.ensurePattern(0, target), doc.songs[0].patterns[target], "idempotent");

  // A cell edit through the op path materialises too (from a fresh doc).
  const doc2 = loadWhen();
  const undo = new UndoStack(doc2);
  undo.apply(setCellOp(0, target, 3, { note: 0x5000, instrment: 7 }));
  assert.equal(doc2.songs[0].patterns[target][3].note, 0x5000);

  // Save emits the whole 0..target range (gaps empty); reparse restores it.
  const doc3 = new Document(parseTaud(doc2.toBytes()));
  assert.ok(doc3.songs[0].patterns.length >= target + 1);
  assert.equal(doc3.songs[0].patterns[target][3].note, 0x5000);
  assert.equal(doc3.patternBytes(0, n0)[0], emptyPatternBytes()[0], "gap serialised empty");
  // gap pattern is all-empty
  assert.deepEqual([...doc3.patternBytes(0, n0)], [...emptyPatternBytes()]);
});

test("appendPatternOp: duplicate grows the list; undo pops it byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const n0 = doc.songs[0].patterns.length;
  const undo = new UndoStack(doc);

  const dirty = undo.apply(appendPatternOp(0, doc.patternBytes(0, 2)));
  assert.equal(doc.songs[0].patterns.length, n0 + 1);
  assert.deepEqual(dirty, [{ kind: "pattern", song: 0, pat: n0 }], "dirty names the NEW index");
  assert.deepEqual([...doc.patternBytes(0, n0)], [...doc.patternBytes(0, 2)], "copy is verbatim");

  undo.undo();
  assert.equal(doc.songs[0].patterns.length, n0);
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  // the sync flush of the now-removed index must serve an EMPTY image, not throw
  const blank = doc.patternBytes(0, n0);
  assert.deepEqual([...blank], [...emptyPatternBytes()]);

  undo.redo();
  assert.equal(doc.songs[0].patterns.length, n0 + 1);
});

test("transposePatternNotes: 12-TET semitones + octaves, sentinel/perc skip", () => {
  const preset = pitchTablePresets[120];
  const cellOf = (note, inst = 0) => ({ note, instrment: inst });
  const mkSong = (cells) => ({ patterns: [cells] });

  // +1 semitone in 12-TET = one table step = 0x1000/12 ≈ 0x155 (with rounding
  // from the snap grid); anchor C4 (0x5000) must land exactly on C#4 (0x5155).
  {
    const song = mkSong([cellOf(ANCHOR_NOTE), cellOf(0x0001), cellOf(0x0000)]);
    const changes = transposePatternNotes(song, 0, preset, null, 1, 0);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + preset.table[1]);
    assert.equal(changes.length, 1, "sentinels untouched");
    assert.equal(song.patterns[0][1].note, 0x0001);
  }
  // +1 octave exactly
  {
    const song = mkSong([cellOf(ANCHOR_NOTE)]);
    transposePatternNotes(song, 0, preset, null, 0, 1);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + 0x1000);
  }
  // -1 step from C wraps to B of the period below
  {
    const song = mkSong([cellOf(ANCHOR_NOTE)]);
    transposePatternNotes(song, 0, preset, null, -1, 0);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE - 0x1000 + preset.table[11]);
  }
  // percussion skipped through running-instrument inheritance
  {
    const perc = new Uint8Array(1024);
    perc[5] = 1;
    const song = mkSong([cellOf(ANCHOR_NOTE, 5), cellOf(ANCHOR_NOTE), cellOf(ANCHOR_NOTE, 2)]);
    const changes = transposePatternNotes(song, 0, preset, perc, 1, 0);
    assert.equal(changes.length, 1, "only the inst-2 row moves");
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE);
    assert.equal(song.patterns[0][1].note, ANCHOR_NOTE, "inherited inst 5 keeps it skipped");
    assert.equal(song.patterns[0][2].note, ANCHOR_NOTE + preset.table[1]);
  }
  // Raw preset: fine = raw note units
  {
    const song = mkSong([cellOf(0x5000)]);
    transposePatternNotes(song, 0, pitchTablePresets[0], null, 7, 0);
    assert.equal(song.patterns[0][0].note, 0x5007);
  }
  // Bohlen-Pierce: coarse = one TRITAVE (0x195C), not an octave
  {
    const bp = pitchTablePresets[35130];
    const song = mkSong([cellOf(ANCHOR_NOTE)]);
    transposePatternNotes(song, 0, bp, null, 0, 1);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + bp.interval);
    assert.equal(bp.interval, 0x195c);
  }
  // clamps at the note floor (sentinel range is never entered)
  {
    const song = mkSong([cellOf(0x21)]);
    transposePatternNotes(song, 0, pitchTablePresets[0], null, -100, 0);
    assert.equal(song.patterns[0][0].note, 0x20);
  }
  // row window (block selection, item 58): only rows 1..2 shift, running-inst
  // still accrues across the skipped rows so percussion stays skipped.
  {
    const song = mkSong([cellOf(0x5000), cellOf(0x5000), cellOf(0x5000), cellOf(0x5000)]);
    const changes = transposePatternNotes(song, 0, pitchTablePresets[0], null, 3, 0, 1, 2);
    assert.equal(changes.length, 2, "only rows 1 and 2 change");
    assert.equal(song.patterns[0][0].note, 0x5000, "row 0 outside the window");
    assert.equal(song.patterns[0][1].note, 0x5003);
    assert.equal(song.patterns[0][2].note, 0x5003);
    assert.equal(song.patterns[0][3].note, 0x5000, "row 3 outside the window");
  }
});

// ── item 22: volume / pan / instrument bulk transforms ──

/** A blank pattern with one cell's vol/pan/inst bytes set. */
function patWith(row, { vol, volEff = 0, pan, panEff = 0, inst }) {
  const b = emptyPatternBytes();
  if (vol !== undefined) b[row * 8 + 3] = (volEff << 6) | (vol & 63);
  if (pan !== undefined) b[row * 8 + 4] = (panEff << 6) | (pan & 63);
  if (inst !== undefined) b[row * 8 + 2] = inst & 0xff;
  return b;
}

test("scaleVolumeBytes: amplify set volumes, skip the no-op sentinel", () => {
  const src = patWith(3, { vol: 20 });
  const out = scaleVolumeBytes(src, 2, 0);
  assert.equal(out[3 * 8 + 3] & 63, 40, "20 × 2 = 40");
  assert.equal((out[3 * 8 + 3] >>> 6) & 3, 0, "effect selector kept");
  // empty cells (0xC0 no-op) untouched
  assert.equal(out[0 * 8 + 3], 0xc0, "blank row stays blank");
  // clamps at 63
  assert.equal(scaleVolumeBytes(patWith(0, { vol: 40 }), 3, 0)[3] & 63, 63);
  // add-only, keep slide-up selector (eff 1)
  const slide = scaleVolumeBytes(patWith(0, { vol: 10, volEff: 1 }), 1, 5);
  assert.equal(slide[3] & 63, 15);
  assert.equal((slide[3] >>> 6) & 3, 1);
});

test("transformPanBytes: widen/narrow about centre + shift, L/R swap", () => {
  // widen ×2 about centre 32: 40 (dev +8) → 48
  assert.equal(transformPanBytes(patWith(0, { pan: 40 }), 2, 0)[4] & 63, 48);
  // narrow ×0.5: 48 (dev +16) → 40
  assert.equal(transformPanBytes(patWith(0, { pan: 48 }), 0.5, 0)[4] & 63, 40);
  // negative mult swaps L/R: 40 (dev +8) → 24 (dev −8)
  assert.equal(transformPanBytes(patWith(0, { pan: 40 }), -1, 0)[4] & 63, 24);
  // shift only: +10
  assert.equal(transformPanBytes(patWith(0, { pan: 20 }), 1, 10)[4] & 63, 30);
  // no-op sentinel skipped
  assert.equal(transformPanBytes(emptyPatternBytes(), 2, 5)[4], 0xc0);
});

test("changeInstrumentBytes: matching one vs all", () => {
  const src = new Uint8Array(patWith(0, { inst: 0x05 }));
  src[1 * 8 + 2] = 0x07;
  src[2 * 8 + 2] = 0x05;
  // matching 0x05 → 0x0A leaves 0x07 alone
  const m = changeInstrumentBytes(src, 0x05, 0x0a);
  assert.equal(m[0 * 8 + 2], 0x0a);
  assert.equal(m[1 * 8 + 2], 0x07);
  assert.equal(m[2 * 8 + 2], 0x0a);
  // all (from=null) → every non-empty inst becomes 0x0A; empty (0) stays 0
  const a = changeInstrumentBytes(src, null, 0x0a);
  assert.equal(a[0 * 8 + 2], 0x0a);
  assert.equal(a[1 * 8 + 2], 0x0a);
  assert.equal(a[3 * 8 + 2], 0, "empty inst stays empty");
});

test("bulk transforms: rows span limits the edit", () => {
  const src = new Uint8Array(emptyPatternBytes());
  src[2 * 8 + 3] = 20; // row 2 vol
  src[9 * 8 + 3] = 20; // row 9 vol
  const out = scaleVolumeBytes(src, 2, 0, [0, 5]); // only rows 0..5
  assert.equal(out[2 * 8 + 3] & 63, 40, "row 2 in span scaled");
  assert.equal(out[9 * 8 + 3] & 63, 20, "row 9 outside span untouched");
});

// ── the same transforms on format version 3's 16-byte cell (§5.5) ──
// Every one of these read/wrote at an 8-byte stride before, so on a wide image
// they hit whatever byte happened to sit there: the volume op silently did
// nothing to the row it named, the pan op wrote a 2-bit selector into the
// azimuth's low byte of a DIFFERENT row, and expand/shrink handed back a
// 512-byte image for a 1024-byte pattern.

/** Wide pattern image with one row filled in. `vol`/`az` are the full-width
 *  values (0..255 / 0..511); selectors default to SET. */
function widePatWith(row, { vol, az, inst, volSel = 0, panSel = 0 } = {}) {
  const b = emptyPatternBytes(true);
  const o = row * 16;
  if (vol !== undefined) b[o + 3] = vol & 0xff;
  if (az !== undefined) b[o + 4] = az & 0xff;
  if (inst !== undefined) b[o + 2] = inst & 0xff;
  b[o + 8] = (((az ?? 0) >>> 8) & 1) << 7 | ((volSel & 7) << 4) | (panSel & 0xf);
  return b;
}
const wideVol = (b, row) => b[row * 16 + 3];
const wideAz = (b, row) => b[row * 16 + 4] | ((b[row * 16 + 8] & 0x80) << 1);
const wideSels = (b, row) => b[row * 16 + 8] & 0x7f;

test("wide cell: emptyPatternBytes is 1024 bytes of FINE-0 sentinels", () => {
  const b = emptyPatternBytes(true);
  assert.equal(b.length, 1024);
  for (let r = 0; r < 64; r++) {
    assert.equal(b[r * 16 + 8], 0x33, `row ${r} selectors`);
    for (const off of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12]) {
      assert.equal(b[r * 16 + off], 0, `row ${r} byte ${off}`);
    }
  }
});

test("wide cell: scaleVolumeBytes works on the FULL byte, at the right row", () => {
  const src = widePatWith(3, { vol: 0x40 });
  const out = scaleVolumeBytes(src, 2, 0, null, true);
  assert.equal(out.length, 1024);
  assert.equal(wideVol(out, 3), 0x80, "0x40 × 2 = 0x80 — a whole byte, not 6 bits");
  assert.equal(wideSels(out, 3), 0, "the selector byte is untouched");
  // clamps at 255, not 63
  assert.equal(wideVol(scaleVolumeBytes(widePatWith(0, { vol: 200 }), 2, 0, null, true), 0), 0xff);
  assert.equal(wideVol(scaleVolumeBytes(widePatWith(0, { vol: 100 }), 2, 0, null, true), 0), 200,
    "…and a value a narrow column could not even hold scales normally");
  // the no-op sentinel (FINE with 0) is still skipped, everywhere
  const blank = scaleVolumeBytes(emptyPatternBytes(true), 2, 40, null, true);
  assert.deepEqual([...blank], [...emptyPatternBytes(true)], "blank pattern stays blank");
});

test("wide cell: transformPanBytes moves the 9-bit azimuth about front", () => {
  // centre is 128 (front): 144 is 16 right of front, ×2 → 160
  assert.equal(wideAz(transformPanBytes(widePatWith(0, { az: 144 }), 2, 0, null, true), 0), 160);
  // narrow ×0.5 back again
  assert.equal(wideAz(transformPanBytes(widePatWith(0, { az: 160 }), 0.5, 0, null, true), 0), 144);
  // negative mult swaps L/R about front
  assert.equal(wideAz(transformPanBytes(widePatWith(0, { az: 144 }), -1, 0, null, true), 0), 112);
  // the ninth bit survives a round trip through the shared selector byte
  const hi = transformPanBytes(widePatWith(0, { az: 400 }), 1, 0, null, true);
  assert.equal(wideAz(hi, 0), 400, "an azimuth behind the listener is preserved");
  assert.equal(hi[8] & 0x80, 0x80, "…including its bit 8");
  // it WRAPS rather than clamping — the column is an angle, not an arc
  assert.equal(wideAz(transformPanBytes(widePatWith(0, { az: 40 }), 1, -100, null, true), 0), 452,
    "40 − 100 wraps round to 452, not to hard left");
  assert.equal(wideAz(transformPanBytes(widePatWith(0, { az: 500 }), 1, 100, null, true), 0), 88);
  // sentinel skipped
  assert.deepEqual([...transformPanBytes(emptyPatternBytes(true), 2, 5, null, true)],
    [...emptyPatternBytes(true)]);
});

test("wide cell: transformPanBytes leaves the other columns of byte 8 alone", () => {
  // volume selector 2 (slide down) + panning selector 1 (slide right)
  const src = widePatWith(0, { az: 144, vol: 0x30, volSel: 2, panSel: 1 });
  const out = transformPanBytes(src, 2, 0, null, true);
  assert.equal((out[8] >>> 4) & 7, 2, "the volume selector survived");
  assert.equal(out[8] & 0xf, 1, "…and so did the panning selector");
  assert.equal(wideVol(out, 0), 0x30, "the volume value is not a pan op's business");
});

test("wide cell: changeInstrumentBytes and expand/shrink use the 16-byte stride", () => {
  const src = widePatWith(3, { vol: 0x40, az: 300, inst: 5 });
  assert.equal(changeInstrumentBytes(src, 5, 0x0a, null, true)[3 * 16 + 2], 0x0a);
  assert.equal(changeInstrumentBytes(src, 9, 0x0a, null, true)[3 * 16 + 2], 5, "non-matching kept");

  const ex = expandPatternBytes(src, 2, true);
  assert.equal(ex.length, 1024, "a wide pattern expands to a WIDE image");
  assert.equal(wideVol(ex, 6), 0x40, "row 3 → row 6");
  assert.equal(wideAz(ex, 6), 300, "…carrying its whole azimuth");
  assert.equal(ex[3 * 16 + 8], 0x33, "the row it vacated is a blank wide cell");

  const sh = shrinkPatternBytes(ex, 2, true);
  assert.equal(sh.length, 1024);
  assert.equal(wideVol(sh, 3), 0x40, "…and shrinking ×2 puts it back");
  assert.equal(wideAz(sh, 3), 300);
});

test("wide cell: the row span still limits the edit", () => {
  const src = widePatWith(2, { vol: 20 });
  src.set(widePatWith(9, { vol: 20 }).subarray(9 * 16, 10 * 16), 9 * 16);
  const out = scaleVolumeBytes(src, 2, 0, [0, 5], true);
  assert.equal(wideVol(out, 2), 40, "row 2 in span scaled");
  assert.equal(wideVol(out, 9), 20, "row 9 outside span untouched");
});

test("wide cell: appendPattern's undo captures a WIDE image (redo is exact)", () => {
  const doc = loadWhen();
  doc.upgradeToWideCells();
  const n = doc.songs[0].patterns.length;
  const src = widePatWith(5, { vol: 0x9c, az: 333, inst: 7 });
  const undo = new UndoStack(doc);
  undo.apply(appendPatternOp(0, src));
  assert.deepEqual([...doc.patternBytes(0, n)], [...src], "the appended image is what we gave it");
  undo.undo();
  assert.equal(doc.songs[0].patterns.length, n);
  undo.redo();
  assert.equal(doc.songs[0].patterns.length, n + 1);
  assert.deepEqual([...doc.patternBytes(0, n)], [...src],
    "redo must reproduce the whole 1024-byte image, not the first 512 bytes");
});

test("bulkNotesOp: transpose one pattern on WHEN, single undo step, byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const preset = pitchTablePresets[120];

  // find a pattern with at least one real note
  let patIdx = -1;
  outer: for (let p = 0; p < doc.songs[0].patterns.length; p++) {
    for (const cell of doc.songs[0].patterns[p]) {
      if (cell.note >= 0x20) { patIdx = p; break outer; }
    }
  }
  assert.ok(patIdx >= 0, "corpus has notes");

  const dirty = undo.apply(bulkNotesOp(0,
    (song) => transposePatternNotes(song, patIdx, preset, null, 2, 0)));
  assert.deepEqual(dirty, [{ kind: "pattern", song: 0, pat: patIdx }]);
  assert.equal(undo.undoStack.length, 1);
  assert.ok(!Buffer.from(doc.toBytes()).equals(before), "notes moved");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

// ── item 85: the same transpose as a GLOBAL (whole-song) operation ──

test("transposeAllPatterns: every materialised pattern, gaps left unmaterialised", () => {
  const preset = pitchTablePresets[120];
  const cellOf = (note, inst = 0) => ({ note, instrment: inst });
  const song = {
    patterns: [
      [cellOf(ANCHOR_NOTE), cellOf(0x0001)],
      null,                                     // item 48 gap: nothing to shift
      [cellOf(ANCHOR_NOTE + 0x1000), cellOf(0)],
    ],
  };
  const changes = transposeAllPatterns(song, preset, null, 1, 0);
  assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + preset.table[1]);
  assert.equal(song.patterns[2][0].note, ANCHOR_NOTE + 0x1000 + preset.table[1]);
  assert.equal(song.patterns[1], null, "the gap stays unmaterialised");
  assert.deepEqual(changes.map((c) => c.pat), [0, 2], "changes carry their pattern index");
  assert.equal(song.patterns[0][1].note, 0x0001, "sentinels skipped, as pattern-scoped");
});

test("global transpose on WHEN: one undo step over all patterns, byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const preset = pitchTablePresets[120];

  const dirty = undo.apply(bulkNotesOp(0,
    (song) => transposeAllPatterns(song, preset, null, 0, 1))); // +1 octave
  assert.ok(dirty.length > 1, "more than one pattern moved");
  assert.equal(undo.undoStack.length, 1, "one undo step for the whole song");
  assert.ok(dirty.every((d) => d.kind === "pattern" && d.song === 0));
  assert.ok(!Buffer.from(doc.toBytes()).equals(before), "notes moved");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

// 85.00: a global operation must stop at the current song's edge.
test("global transpose leaves the project's other songs alone", () => {
  const doc = loadWhen();
  // Clone song 0 into a second song (fresh byte images — no aliasing).
  const patterns = doc.songs[0].patterns.map((_, p) => doc.patternBytes(0, p));
  const s0 = doc.songs[0];
  doc.songs.push(new Song({
    numVoices: s0.numVoices, bpm: s0.bpm, tickRate: s0.tickRate,
    tuningBaseNote: s0.tuningBaseNote, tuningFreq: s0.tuningFreq,
    globalFlags: s0.globalFlags, globalVolume: s0.globalVolume,
    mixingVolume: s0.mixingVolume, patterns, cues: s0.cues.map((c) => Uint16Array.from(c)),
  }));
  const snapshot = (si) => doc.songs[si].patterns.map((p) => (p ?? []).map((c) => c.note));
  const song1Before = JSON.stringify(snapshot(1));

  const undo = new UndoStack(doc);
  undo.apply(bulkNotesOp(0,
    (song) => transposeAllPatterns(song, pitchTablePresets[120], null, 2, 0)));
  assert.notEqual(JSON.stringify(snapshot(0)), song1Before, "song 0 moved");
  assert.equal(JSON.stringify(snapshot(1)), song1Before, "song 1 untouched");
});

test("transposeUnitKeys: the unit labels follow the song's tuning", () => {
  // 12 notes per octave (t: 'd') → semitones + octaves…
  assert.deepEqual(transposeUnitKeys(pitchTablePresets[120]),
    { fine: "pat.unitSemitones", coarse: "pat.unitOctaves" });
  // …a denser TET counts table steps…
  assert.equal(transposeUnitKeys(pitchTablePresets[190]).fine, "pat.unitSteps");
  // …Bohlen-Pierce repeats at a tritave, so coarse is periods…
  assert.equal(transposeUnitKeys(pitchTablePresets[35130]).coarse, "pat.unitPeriods");
  // …an absolute table (ProTracker) still moves by octave in pitch…
  assert.equal(transposeUnitKeys(pitchTablePresets[1]).coarse, "pat.unitOctaves");
  // …and Raw (no table) shifts by raw note units.
  assert.deepEqual(transposeUnitKeys(pitchTablePresets[0]),
    { fine: "pat.unitNoteUnits", coarse: "pat.unitOctaves" });
  assert.equal(transposeUnitKeys(null).fine, "pat.unitNoteUnits");
});
