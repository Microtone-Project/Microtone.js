// A lane's and an instrument's own notation (item 374, TAUD_FILE_FORMAT.md
// §9.19, §9.20, §9.7's spelled bit, notation 10128). What is pinned: the `INtn`
// codec and its guard; the lane record's notation field beside the fx2 flag;
// that an entry belongs to the instrument it was written for (a rename here
// carries it, one elsewhere sheds it, a renumber moves it, a save retires what
// no longer applies); which instruments are drum kits; the precedence
// instrument > lane > song, with the drum names as a kit's default; the drum
// names themselves and the spelled cell; a spelled `nota` definition; and the
// note tools that read a note's own notation (transpose, retune).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INTN_FOURCC, INTN_FOLLOW, parseInstNotationSection, buildInstNotationSection, instNotationGuard,
} from "../../core/format/inst-notation-section.js";
import {
  LANE_FOURCC, LANE_FLAG_FX2, LANE_FLAG_NOTATION, parseLaneSection, buildLaneSection, laneByte,
} from "../../core/format/lane-section.js";
import {
  pitchTablePresets, presetForNotation, resolveNoteSymbol, GM_DRUM_NOTATION, gmDrumName,
  transposePatternNotes, retuneAllPatterns, finePreset,
} from "../../core/tuning/pitchtables.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { setSectionOp, renumberInstrumentOp } from "../../src/doc/ops.js";
import { planRenumberInstrument } from "../../src/doc/cleanup.js";
import {
  NOTA_SPELLED, buildNotaPayload, parseNotaPayload, defToPreset, autoAssignSyms, isSpelledDef,
  symTokenToTaud, taudToSymToken,
} from "../../src/doc/notation.js";
import { Store } from "../../src/ui/store.js";
import { noteCellText } from "../../src/ui/cellpaint.js";
import { cellNotation, runningInst } from "../../src/ui/notationat.js";

const demo = (name) => fileURLToPath(new URL(`../../assets/demo_projects/${name}.taud`, import.meta.url));
const load = (name) => new Document(parseTaud(readFileSync(demo(name))));
const keyNote = (k) => 0x5000 + ((k - 60) * 0x1000) / 12; // MIDI key 60 = C4

test("INtn: the codec reads what it writes, and stops at a reserved bit", () => {
  const map = new Map([
    [3, { flags: 0, notation: 190, guard: 0x1234 }],
    [1, { flags: INTN_FOLLOW, notation: 0, guard: 0xbeef }],
  ]);
  const payload = buildInstNotationSection(map);
  assert.equal(payload.length, 16);
  const back = parseInstNotationSection(payload);
  assert.deepEqual([...back.keys()], [1, 3], "written in instrument order");
  assert.deepEqual(back.get(3), { flags: 0, notation: 190, guard: 0x1234 });
  assert.equal(back.get(1).flags, INTN_FOLLOW);
  const bad = Uint8Array.from([...payload.slice(0, 8), 2, 0, 2, 0, 120, 0, 0, 0, ...payload.slice(8)]);
  assert.deepEqual([...parseInstNotationSection(bad).keys()], [1], "a reserved flag bit ends the walk");
  assert.equal(buildInstNotationSection(new Map()), null, "nothing to say, no section");
  // CRC-16/CCITT-FALSE's check value, as IPit's guard (§9.18).
  assert.equal(instNotationGuard("123456789"), 0x29b1);
});

test("a lane's notation sits beside its fx2 flag, and 0 (raw) is a notation", async () => {
  const doc = load("Huygens_clock");
  doc.setLaneFlag(0, 2, LANE_FLAG_FX2, true);
  assert.equal(doc.laneNotation(0, 2), null);
  assert.ok(doc.setLaneNotation(0, 2, 0));
  assert.equal(doc.laneNotation(0, 2), 0, "raw numbers, not 'none'");
  assert.ok(doc.setLaneNotation(0, 5, 310));
  assert.equal(doc.laneFlags(0, 2), LANE_FLAG_FX2 | LANE_FLAG_NOTATION, "the fx2 flag is kept");
  const again = new Document(parseTaud(await doc.toBytes()));
  assert.equal(again.laneNotation(0, 5), 310);
  assert.equal(again.laneNotation(0, 2), 0);
  assert.equal(again.laneNotation(0, 3), null);
  assert.ok(doc.setLaneNotation(0, 2, null));
  assert.equal(doc.laneFlags(0, 2), LANE_FLAG_FX2);
  const e = parseLaneSection(doc.projSections.find((s) => s.fourcc === LANE_FOURCC).payload).get(0);
  assert.equal(laneByte(e, 2, 2) | laneByte(e, 2, 3), 0, "the field is cleared with the bit");
  // A one-byte record (a writer that knew only the fx2 flag) has no notation.
  const one = { count: 8, stride: 1, bytes: Uint8Array.from([0, LANE_FLAG_NOTATION, 0, 0, 0, 0, 0, 0]) };
  doc.setSection(LANE_FOURCC, buildLaneSection(new Map([[0, one]])));
  assert.equal(doc.laneNotation(0, 1), 0, "bit set, field past the stride: reads as 0");
});

test("an instrument's entry is its own: guarded by its name, carried by a rename here", async () => {
  const doc = load("Huygens_clock");
  const undo = new UndoStack(doc);
  const slot = doc.selectableInstrumentSlots().find((s) => !doc.isDrumKit(s));
  undo.apply(setSectionOp(INTN_FOURCC, doc.instNotationPayloadWith(slot, 310)));
  assert.equal(doc.instNotation(slot), 310);
  // Another editor renames it without knowing the section: the entry stands down.
  doc.setSection("INam", doc.buildInstrumentNames(slot, "Renamed elsewhere"));
  assert.equal(doc.instNotation(slot), null);
  // …and a save retires it.
  const saved = new Document(parseTaud(await doc.toBytes()));
  assert.equal(saved.projSections.some((s) => s.fourcc === INTN_FOURCC), false);
  // A rename here carries it.
  const doc2 = load("Huygens_clock");
  doc2.setSection(INTN_FOURCC, doc2.instNotationPayloadWith(slot, 310));
  doc2.setSection(INTN_FOURCC, doc2.instNotationRenamed(slot, "Renamed here"));
  doc2.setSection("INam", doc2.buildInstrumentNames(slot, "Renamed here"));
  assert.equal(doc2.instNotation(slot), 310);
  const back = new Document(parseTaud(await doc2.toBytes()));
  assert.equal(back.instNotation(slot), 310, "and it survives a save");
});

test("a renumber moves the entry with its instrument, and the undo moves it back", () => {
  const doc = load("Huygens_clock");
  const slot = doc.selectableInstrumentSlots().find((s) => s < 0x100 && !doc.isDrumKit(s));
  doc.setSection(INTN_FOURCC, doc.instNotationPayloadWith(slot, 240));
  const used = new Set(doc.usedInstrumentSlots());
  let to = 0x40;
  while (used.has(to)) to++;
  const plan = planRenumberInstrument(doc, slot, to);
  assert.ok(!plan.error, plan.error);
  const undo = new UndoStack(doc);
  undo.apply(renumberInstrumentOp(plan));
  assert.equal(doc.instNotation(to), 240);
  assert.equal(doc.instNotation(slot), null);
  undo.undo();
  assert.equal(doc.instNotation(slot), 240);
});

test("a drum kit is a percussion instrument split over the keys", () => {
  const huygens = load("Huygens_clock");
  assert.equal(huygens.instrumentName(1), "Standard Kit");
  assert.equal(huygens.isDrumKit(1), true);
  const eighth = load("Eighth");
  assert.equal(eighth.instruments[37].isPercussion, true, "FM Kick is percussion…");
  assert.equal(eighth.isDrumKit(37), false, "…but one drum, not a kit");
  for (const s of huygens.selectableInstrumentSlots()) {
    if (!huygens.instruments[s].isPercussion) assert.equal(huygens.isDrumKit(s), false);
  }
});

test("a note is spelled in its instrument's notation, else its lane's, else the song's", () => {
  const store = new Store();
  store.doc = load("Huygens_clock");
  store.songIndex = 0;
  store.pitchPreset = presetForNotation(store.doc.meta.songMeta[0]?.notation ?? 120, store.doc);
  const doc = store.doc;
  const plain = doc.selectableInstrumentSlots().find((s) => !doc.isDrumKit(s));
  assert.equal(store.notationFor(4, plain), store.pitchPreset, "nothing said: the song's");
  store.setLaneNotation(4, 190);
  assert.equal(store.notationFor(4, plain).index, 190, "the lane's");
  assert.equal(store.notationFor(4, 0).index, 190, "a note with no instrument known: the lane's");
  assert.equal(store.notationFor(5, plain), store.pitchPreset, "another lane: the song's");
  doc.setSection(INTN_FOURCC, doc.instNotationPayloadWith(plain, 310));
  store.emit("edit");
  assert.equal(store.notationFor(4, plain).index, 310, "the instrument's beats the lane's");
  // A drum kit: the drum names unless it says otherwise.
  assert.equal(store.notationFor(4, 1).index, GM_DRUM_NOTATION);
  doc.setSection(INTN_FOURCC, doc.instNotationPayloadWith(1, "follow"));
  store.emit("edit");
  assert.equal(store.notationFor(4, 1).index, 190, "follow: the lane's after all");
  assert.equal(store.notationFor(5, 1), store.pitchPreset);
  // The wide (65536-TET) document gets the fine views, one object per index.
  assert.equal(store.notationFor(4, 0).fine, doc.wideCells === true ? true : undefined);
  assert.equal(store.notationFor(4, 0), store.notationFor(4, 0));
});

test("a note with no instrument is played by the last one named above it", () => {
  const store = new Store();
  store.doc = load("Huygens_clock");
  const rows = Array.from({ length: 64 }, () => ({ instrment: 0, note: 0 }));
  rows[3].instrment = 1;
  rows[9].instrment = 2;
  assert.equal(runningInst(store, rows, 0), 0);
  assert.equal(runningInst(store, rows, 5), 1);
  assert.equal(runningInst(store, rows, 63), 2);
  assert.equal(cellNotation(store, -1, rows, 2, () => 1).index, GM_DRUM_NOTATION,
    "above the pattern's first, the instrument the lane came in with");
});

test("the General MIDI drum names: spelled on the drum keys, 12-TET elsewhere, exact at 65536-TET", () => {
  const p = pitchTablePresets[GM_DRUM_NOTATION];
  const fine = finePreset(p);
  for (const [key, name] of [[35, "Kick2"], [36, "Kick1"], [38, "Snar1"], [42, "HHCls"], [46, "HHOpn"],
    [49, "Crsh1"], [81, "OTri"], [27, "HighQ"], [87, "OSurd"]]) {
    assert.equal(gmDrumName(key), name);
    const r = resolveNoteSymbol(Math.round(keyNote(key) * 16) / 16, fine);
    assert.deepEqual(r, { spelled: name, offGrid: false }, `key ${key}`);
    assert.ok(name.length <= 5);
  }
  const c7 = resolveNoteSymbol(keyNote(96), fine); // key 96, C7: no drum
  assert.equal(c7.letter, "C");
  assert.equal(c7.octave, 7);
  const cell = noteCellText(Math.round(keyNote(42) * 16) / 16, fine, false, true);
  assert.deepEqual(cell, { text: "HHCls", ink: "note", spelled: true });
  assert.equal(noteCellText(keyNote(42), fine, true, true).spelled, undefined, "raw view shows the hex");
});

test("a spelled nota definition: names in ASCII, an interval system cannot be spelled", () => {
  const def = { slot: 2, flags: NOTA_SPELLED, interval: 0, base: 0x2000, name: "My kit",
    table: [0, 0x155, 0x2ab], syms: [], spells: ["Boom", "Tské!!", ""] };
  def.syms = autoAssignSyms(def, "nearest");
  const [back] = parseNotaPayload(buildNotaPayload([def]));
  assert.equal(isSpelledDef(back), true);
  assert.deepEqual(back.spells, ["Boom", "Tsk?!", ""], "printable ASCII, five at most");
  const preset = defToPreset(back);
  assert.deepEqual(preset.spell, ["Boom", "Tsk?!", null]);
  assert.equal(resolveNoteSymbol(0x2000, preset).spelled, "Boom");
  assert.equal(resolveNoteSymbol(0x22ab, preset).spelled, undefined, "an empty spelling: a name");
  const periodic = { ...def, interval: 0x1000, base: 0 };
  const [p2] = parseNotaPayload(buildNotaPayload([periodic]));
  assert.equal(p2.flags & NOTA_SPELLED, 0, "never written on an interval system");
  assert.equal(defToPreset(p2).spell, undefined);
});

test("transpose moves an instrument's notes by its own notation's degrees", () => {
  const song = { patterns: [Array.from({ length: 64 }, () => ({ instrment: 0, note: 0 }))] };
  const rows = song.patterns[0];
  rows[0].instrment = 5; rows[0].note = 0x5000;
  rows[1].instrment = 6; rows[1].note = 0x5000;
  const t12 = finePreset(pitchTablePresets[120]);
  const t31 = finePreset(pitchTablePresets[310]);
  transposePatternNotes(song, 0, t31, null, 1, 0, 0, Infinity, null, (inst) => (inst === 6 ? t12 : null));
  assert.equal(rows[0].note, 0x5000 + t31.table[1], "the pattern's notation: a 31-TET step");
  assert.equal(rows[1].note, 0x5000 + t12.table[1], "its own: a semitone");
});

test("retune leaves the patterns only lanes with their own notation play", () => {
  const mk = (note) => {
    const rows = Array.from({ length: 64 }, () => ({ instrment: 0, note: 0 }));
    rows[0].note = note;
    return rows;
  };
  const off = 0x5000 + 0x155 + 7; // 7 units sharp of C#4
  const song = { patterns: [mk(off), mk(off)] };
  const t12 = pitchTablePresets[120];
  const changes = retuneAllPatterns(song, t12, t12, null, "pitch", (p) => p === 1);
  assert.equal(changes.length, 1);
  assert.equal(song.patterns[0][0].note, 0x5155);
  assert.equal(song.patterns[1][0].note, off, "skipped");
});

test("the sesquisharp and sesquiflat are written as taut.js writes them, and read back", () => {
  // taut.js sym.sesquiflat "\u0090\u0091"; sym.sesquisharp "\u0084132u\u0085" —
  // its left half is TSVM's unicode-escape byte, so it goes as that escape.
  assert.deepEqual(symTokenToTaud(" Df"), [0x44, 0x90, 0x91]);
  assert.deepEqual(symTokenToTaud(" Cs"), [0x43, 0x84, 0x31, 0x33, 0x32, 0x75, 0x85]);
  for (const tok of [" Cs", " Df", "uCs", "dGf", " C#", " Bp"]) assert.equal(taudToSymToken(symTokenToTaud(tok)), tok);
  const cell = noteCellText(0x5000, { index: -1, table: [0], interval: 0x1000, sym: [" Cs"] }, false, true);
  assert.equal([...cell.text].length, 3, "letter, the two-cell sesquisharp, octave");
});
