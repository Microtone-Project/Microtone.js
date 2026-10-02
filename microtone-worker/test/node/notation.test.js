// Notation Maker (item 61) — Scala .scl parsing, the nota section codec,
// Taud-charset symbol mapping, preset bridging, and the Document integration
// (custom notation values 65535..65520 resolving through the "nota" section).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseScl, sclToDef, centsToUnits, buildNotaPayload, parseNotaPayload,
  buildTaudnot, parseTaudnot, symTokenToTaud, taudToSymToken, autoAssignSyms,
  defToPreset, validateDef, notationValueForSlot, slotForNotationValue,
} from "../../src/doc/notation.js";
import { pitchTablePresets, presetForNotation, resolveNoteSymbol, stepNoteInTable, ANCHOR_NOTE }
  from "../../core/tuning/pitchtables.js";
import { setSectionOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

// The two example scales from the item-61 spec.
const BP_SCL = `! bohlen-p_et.scl
!
13-tone equal division of 3/1. Bohlen-Pierce equal approximation
 13
!
 146.30423
 292.60846
 438.91269
 585.21692
 731.52115
 877.82539
 1024.12962
 1170.43385
 1316.73808
 1463.04231
 1609.34654
 1755.65077
 3/1`;

const MADA_SCL = `! madagascar19.scl
Madagascar[19] (19&53&58) hobbit in 313et tuning
19
!
65.17572
138.01917
184.02556
249.20128
314.37700
387.22045
452.39617
498.40256
563.57827
636.42173
701.59744
747.60383
812.77955
885.62300
950.79872
1015.97444
1061.98083
1134.82428
1200.00000
!`;

test("parseScl + sclToDef: Bohlen-Pierce matches the shipped 35130 preset exactly", () => {
  const def = sclToDef(parseScl(BP_SCL), 0);
  const shipped = pitchTablePresets[35130];
  assert.equal(def.interval, 0x195c, "3/1 tritave in 4096-TET");
  assert.deepEqual(def.table, shipped.table, "13 degrees identical to the preset");
  assert.deepEqual(validateDef(def), []);
  assert.equal(def.name, "13-tone equal division of 3/1. Bohlen-Pierce equal approximation");
});

test("parseScl + sclToDef: madagascar19 (cents lines, octave period)", () => {
  const def = sclToDef(parseScl(MADA_SCL), 5);
  assert.equal(def.interval, 0x1000);
  assert.equal(def.table.length, 19);
  assert.equal(def.table[0], 0, "implicit 1/1 is degree 0");
  assert.equal(def.table[1], centsToUnits(65.17572));
  assert.deepEqual(validateDef(def), []);
  assert.equal(def.syms.length, 19, "auto-named");
});

test("parseScl: ratios, bare integers and errors", () => {
  const d = parseScl("!c\nname\n3\n 9/8\n 5/4 a comment\n 2");
  assert.equal(Math.round(d.cents[0]), 204, "9/8 = 203.9c");
  assert.equal(Math.round(d.cents[1]), 386, "5/4 = 386.3c");
  assert.equal(d.cents[2], 1200, "bare 2 = 2/1");
  assert.throws(() => parseScl("only one line"), /header/);
  assert.throws(() => parseScl("name\nnot-a-number\n"), /count/);
  assert.throws(() => parseScl("name\n2\n100.0"), /missing pitch/);
  assert.throws(() => parseScl("name\n1\n 3/0"), /ratio/);
  assert.throws(() => parseScl("name\n0\n"), /empty/);
});

test("Taud charset: every tick × letter × accidental round-trips; CJK + escapes", () => {
  const ticks = [" ", ".", "u", "d", "U", "D"];
  const accs = ["-", "#", "b", "t", "p", "x", "B", "3", "T", "4"];
  for (const tk of ticks) for (const L of ["A", "J", "Z"]) for (const a of accs) {
    const tok = tk + L + a;
    assert.equal(taudToSymToken(symTokenToTaud(tok)), tok, `token ${JSON.stringify(tok)}`);
  }
  for (const c of "黃大太夶姑仲蕤林夷南無應") {
    assert.equal(taudToSymToken(symTokenToTaud(c)), c, "Shi'er lü pair");
  }
  assert.equal(taudToSymToken(symTokenToTaud("宮")), "宮", "arbitrary unicode via 0x84 escape");
  // Kite tokens use the compact one-byte accidentals — like taut's own strings.
  assert.deepEqual(symTokenToTaud(".C#"), [0xf9, 0x43, 0x98]);
  // Normal tokens use two-cell accidentals with no leading space.
  assert.deepEqual(symTokenToTaud(" C-"), [0x43, 0xa2, 0xa3]);
  assert.equal(taudToSymToken([0x01, 0x02]), null, "garbage → null");
});

test("nota payload codec: parse(build(defs)) round-trips and rebuilds byte-exact", () => {
  const d1 = sclToDef(parseScl(BP_SCL), 0);
  const d2 = sclToDef(parseScl(MADA_SCL), 3);
  d2.syms[4] = "黃"; // a CJK token survives the charset
  const payload = buildNotaPayload([d1, d2]);
  const back = parseNotaPayload(payload);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map((d) => [d.slot, d.interval, d.table, d.syms, d.name]),
    [d1, d2].map((d) => [d.slot, d.interval, d.table, d.syms, d.name]));
  assert.deepEqual([...buildNotaPayload(back)], [...payload], "byte-exact rebuild");
});

test(".taudnot wrapper: magic + version guard", () => {
  const def = sclToDef(parseScl(BP_SCL), 2);
  const file = buildTaudnot([def]);
  assert.deepEqual([...file.subarray(0, 8)],
    [0x1e, 0x54, 0x61, 0x75, 0x64, 0x6e, 0x6f, 0x74], "\\x1ETaudnot magic");
  assert.equal(file[8], 0x61, "version 'a'");
  const back = parseTaudnot(file);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].table, def.table);
  assert.equal(parseTaudnot(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseTaudnot(readFileSync(corpusDir + "WHEN.taud").subarray(0, 64)), null);
});

test("defToPreset bridges into the pitch-table machinery (glyphs + stepping)", () => {
  const def = sclToDef(parseScl(BP_SCL), 0);
  const preset = defToPreset(def);
  assert.equal(preset.index, 0xffff, "slot 0 = internal 65535");
  assert.equal(slotForNotationValue(preset.index), 0);
  assert.equal(notationValueForSlot(15), 0xfff0);
  // degree 1 of the tritave resolves + steps like any shipped preset
  const note = ANCHOR_NOTE + def.table[1];
  const sym = resolveNoteSymbol(note, preset);
  assert.ok(sym && !sym.offGrid, "on-grid degree resolves");
  assert.equal(stepNoteInTable(note, preset, -1), ANCHOR_NOTE, "steps down to the root");
  const top = ANCHOR_NOTE + def.table[def.table.length - 1];
  assert.equal(stepNoteInTable(top, preset, +1), ANCHOR_NOTE + def.interval,
    "wraps into the next TRITAVE period");
  // interval-less defs degrade to a Raw-style preset (hex display)
  const rawish = defToPreset({ slot: 1, interval: 0, name: "", table: [], syms: [] });
  assert.equal(rawish.table.length, 0);
  assert.equal(resolveNoteSymbol(0x5000, rawish), null, "renders as hex");
});

test("autoAssignSyms: nearest quarter-tone and letter-sequence modes", () => {
  const eq24 = { table: Array.from({ length: 24 }, (_, i) => Math.round((i * 0x1000) / 24)), interval: 0x1000 };
  assert.deepEqual(autoAssignSyms(eq24, "nearest").slice(0, 4), [" C-", " Ct", " C#", " Dp"]);
  // ≤ 26 degrees: a plain letter each.
  const eq12 = { table: Array.from({ length: 12 }, (_, i) => i * 100), interval: 0x1000 };
  assert.deepEqual(autoAssignSyms(eq12, "sequence").slice(0, 3), [" A-", " B-", " C-"]);
  const eq26 = { table: Array.from({ length: 26 }, (_, i) => i * 100), interval: 0x1000 };
  assert.equal(autoAssignSyms(eq26, "sequence")[25], " Z-");
});

// Item 72.1: past 26 degrees the old scheme ran A..Z then restarted at A with a
// tick, so degree 27 read "·A" — a step DOWN from the Z before it. Degrees now
// spread evenly over all 26 letters, told apart by a variant ladder sized to fit.
test("autoAssignSyms: sequence mode spreads > 26 degrees over the alphabet (item 72.1)", () => {
  const mk = (n) => autoAssignSyms(
    { table: Array.from({ length: n }, (_, i) => Math.round((i * 0x1000) / n)), interval: 0x1000 },
    "sequence");

  const seq30 = mk(30);
  assert.equal(seq30[26], " W-", "no restart at A: degree 26 keeps climbing");
  assert.notEqual(seq30[26], ".A-", "the reported bug is gone");
  assert.equal(seq30[29], " Z-", "the last degree lands on the last letter");
  assert.deepEqual(seq30.slice(0, 3), [" A-", " A#", " B-"], "ladder of 2 = [♮ ♯]");

  // The exact complaint: 27 degrees, one more than the alphabet.
  const seq27 = mk(27);
  assert.deepEqual(seq27.slice(24).map((s) => s[1]), ["X", "Y", "Z"], "tail ascends X → Y → Z");

  // A tick-bearing ladder spells its middle degree with the Kite big-dot '.',
  // like every shipped Kite preset — never a blank tick slot.
  for (const [n, head] of [[52, [" A-", " A#"]],                    // 2: ♮ ♯ (no ticks)
                           [78, ["dA-", ".A-", "uA-"]],             // 3: v · ^
                           [104, ["dA-", ".A-", "uA-", "UA-"]],     // 4: v · ^ ^^
                           [130, ["DA-", "dA-", ".A-", "uA-", "UA-"]]]) { // 5: vv v · ^ ^^
    const s = mk(n);
    assert.deepEqual(s.slice(0, head.length), head, `n=${n} uses the ${head.length}-variant ladder`);
  }

  // The null tick of a tick ladder must match the shipped Kite convention.
  for (const n of [78, 104, 130, 300]) {
    assert.ok(mk(n).every((s) => s[0] !== " "),
      `n=${n}: a tick-bearing table never leaves the tick slot blank`);
  }
  // A ladder is either all-tick or tickless — never a mix.
  for (const n of [52, 200]) {
    assert.ok(mk(n).every((s) => s[0] === " "), `n=${n}: a tickless ladder keeps the blank tick slot`);
  }

  // Invariants across every size: symbols stay unique and letters never step back.
  for (let n = 1; n <= 260; n++) {
    const s = mk(n);
    assert.equal(s.length, n);
    assert.equal(new Set(s).size, n, `n=${n}: every degree has a distinct symbol`);
    for (let i = 1; i < n; i++) {
      assert.ok(s[i][1] >= s[i - 1][1], `n=${n}: letter steps backwards at degree ${i}`);
    }
    if (n > 26) assert.equal(new Set(s.map((x) => x[1])).size, 26, `n=${n}: all 26 letters used`);
  }

  // Degenerate scales (> 1300 degrees) still produce a symbol per degree.
  assert.equal(mk(1400).length, 1400);
});

// Item 88: with only ticks to vary, a letter's run ran out of variants at 5 and
// cycled — a 1200-EDO table repeated the same symbol every 10 degrees. Flats and
// the rest of the accidental palette now carry the distinction.
test("autoAssignSyms: sequence mode uses accidentals past 5 per letter (item 88)", () => {
  const mk = (n) => autoAssignSyms(
    { table: Array.from({ length: n }, (_, i) => Math.round((i * 0x1000) / n)), interval: 0x1000 },
    "sequence");

  // 6..10 per letter: accidentals alone, ♮ in the middle of the run.
  const seq156 = mk(156); // 6 per letter
  assert.deepEqual(seq156.slice(0, 6), [" Ab", " Ap", " A-", " At", " A#", " Ax"]);
  const seq260 = mk(260); // 10 per letter — the whole palette
  assert.deepEqual(seq260.slice(0, 10),
    [" AT", " AB", " Ab", " Ap", " A-", " At", " A#", " Ax", " A3", " A4"]);

  // Past 10 the accidental is the coarse variant and the tick the fine one.
  const seq300 = mk(300); // 12 per letter
  assert.deepEqual(seq300.slice(0, 4), [".Ap", "uAp", "UAp", "DA-"]);

  // The reported case: 1200 equal divisions, every degree named exactly once.
  const seq1200 = mk(1200);
  assert.equal(new Set(seq1200).size, 1200, "no duplicate symbols in 1200-EDO");
  assert.ok(seq1200.some((s) => s[2] === "b"), "flats are used");
  assert.equal(new Set(seq1200.map((s) => s[1])).size, 26, "all 26 letters used");
  for (let i = 1; i < seq1200.length; i++) {
    assert.ok(seq1200[i][1] >= seq1200[i - 1][1], `letter steps backwards at degree ${i}`);
  }
  // 26 letters × 50 variants is the ceiling; beyond it duplicates are inevitable.
  assert.equal(new Set(mk(1300)).size, 1300);
});

test("validateDef issue codes", () => {
  assert.deepEqual(validateDef({ interval: 0x1000, table: [] }), ["count"]);
  assert.deepEqual(validateDef({ interval: 0x1000, table: [5, 10] }), ["zeroFirst"]);
  assert.deepEqual(validateDef({ interval: 0x1000, table: [0, 20, 10] }), ["ascending"]);
  assert.deepEqual(validateDef({ interval: 0x800, table: [0, 0x900] }), ["interval"]);
  assert.ok(validateDef({ interval: 0x1_0000, table: [0] }).includes("range"));
  // interval 0 is the spec's "no interval system" mode, not an error — the
  // degrees are absolute notes, so nothing has to fit inside a period.
  assert.deepEqual(validateDef({ interval: 0, table: [0, 0x900, 0x4000] }), []);
  // ...but the other invariants still apply to it.
  assert.deepEqual(validateDef({ interval: 0, table: [5, 10] }), ["zeroFirst"]);
  assert.ok(validateDef({ interval: -5, table: [0] }).includes("interval"));
});

test("interval-0 definitions become absolute presets, not Raw", () => {
  // Two octaves of 12-TET spelled out note by note: no interval, every note
  // listed. Previously this degraded to a Raw (hex) preset.
  const table = [], syms = [];
  for (let i = 0; i < 24; i++) {
    table.push(Math.round((i * 0x1000) / 12));
    syms.push(pitchTablePresets[120].sym[i % 12]);
  }
  const def = { slot: 3, flags: 0, interval: 0, name: "Absolute", table, syms };
  assert.deepEqual(validateDef(def), []);

  const p = defToPreset(def);
  assert.equal(p.interval, 0);
  assert.equal(p.table.length, 24, "the table survives (Raw would have emptied it)");
  assert.equal(p.t, "d", "density = 12 degrees per octave across the span");

  // It drives the real pitch machinery: notes resolve by name, and the octave
  // digit follows the pitch even though there is no period index to count.
  const at = (i) => ANCHOR_NOTE + p.table[i];
  const r0 = resolveNoteSymbol(at(0), p), r13 = resolveNoteSymbol(at(13), p);
  assert.deepEqual([r0.letter + r0.acc, r0.octave, r0.offGrid], ["C-", 4, false]);
  assert.deepEqual([r13.letter + r13.acc, r13.octave, r13.offGrid], ["C#", 5, false]);
  // Stepping walks the absolute list and clamps at its ends.
  assert.equal(stepNoteInTable(at(0), p, 1), at(1));
  assert.equal(stepNoteInTable(at(0), p, -1), at(0), "bottom of the table clamps");
  assert.equal(stepNoteInTable(at(23), p, 1), at(23), "top of the table clamps");
});

test("nota codec round-trips interval 0 byte-exact", () => {
  const def = { slot: 0, flags: 0, interval: 0, name: "Absolute",
                table: [0, 0x155, 0x1000, 0x4321], syms: [" C-", " C#", " D-", " E-"] };
  const back = parseNotaPayload(buildNotaPayload([def]))[0];
  assert.equal(back.interval, 0);
  assert.deepEqual(back.table, def.table);
  assert.equal(back.name, "Absolute");
  assert.equal(back.base, 0, "an undeclared base stays 0 (= default C4)");
});

test("nota base note: an absolute notation can reach below C4", () => {
  // The frequency table's offsets are unsigned, so without a base note a
  // notation could never name anything under C4. ProTracker's shape: base two
  // octaves down, table rising from it.
  const def = { slot: 2, flags: 0, interval: 0, base: 0x3000, name: "Low",
                table: [0, 0x1000, 0x2000, 0x3000],
                syms: [" C-", " C-", " C-", " C-"] };
  assert.deepEqual(validateDef(def), []);

  const back = parseNotaPayload(buildNotaPayload([def]))[0];
  assert.equal(back.base, 0x3000, "base survives the round trip");
  assert.deepEqual(back.table, def.table);

  const p = defToPreset(back);
  assert.equal(p.base, 0x3000);
  // Degree 0 IS the note two octaves below C4 — unreachable before this field.
  assert.equal(stepNoteInTable(0x3000, p, -1), 0x3000, "bottom clamps at the base");
  assert.equal(stepNoteInTable(0x3000, p, 1), 0x4000);
  assert.equal(resolveNoteSymbol(0x3000, p).octave, 2, "octave digit follows the pitch");
  assert.equal(resolveNoteSymbol(0x5000, p).octave, 4);
});

test("nota base note: 0 means default C4, and interval systems must not set one", () => {
  const abs = { slot: 0, flags: 0, interval: 0, base: 0, table: [0, 0x155],
                syms: [" C-", " C#"] };
  // base 0 = default: presetBase supplies C4, so the preset carries no base.
  const p = defToPreset(abs);
  assert.equal(p.base, undefined);
  assert.equal(resolveNoteSymbol(ANCHOR_NOTE, p).octave, 4);

  // The spec pins the base to 0 for an interval system — there the base note
  // is the root interval's root, and the song table moves the whole tuning.
  assert.deepEqual(validateDef({ interval: 0x1000, base: 0x3000, table: [0, 0x155] }),
    ["base"]);
  assert.deepEqual(validateDef({ interval: 0x1000, base: 0, table: [0, 0x155] }), []);
  assert.ok(validateDef({ interval: 0, base: 0x1_0000, table: [0] }).includes("base"));
});

test("Document: nota section via setSectionOp — resolve, undo byte-exact, reload", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  const def = sclToDef(parseScl(BP_SCL), 0);
  def.name = "BP test";
  undo.apply(setSectionOp("nota", buildNotaPayload([def])));

  assert.equal(doc.customNotations().length, 1, "cache follows the section");
  assert.equal(doc.customNotations()[0].name, "BP test");
  const preset = doc.customPreset(0xffff);
  assert.ok(preset && preset.interval === 0x195c, "customPreset resolves slot 0");
  assert.equal(presetForNotation(0xffff, doc).name, "BP test", "doc-aware resolution");
  assert.equal(presetForNotation(0xffff).index, 120, "docless call falls back to 12-TET");
  assert.equal(presetForNotation(0xfff5, doc).index, 120, "undefined slot falls back");

  // survives a full write → parse round-trip
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.customPreset(0xffff)?.name, "BP test", "nota persisted");
  assert.deepEqual(reloaded.customPreset(0xffff).table, defToPreset(def).table);

  undo.undo();
  assert.equal(doc.customNotations().length, 0, "cache invalidated by the swap");
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.equal(doc.customPreset(0xffff)?.name, "BP test", "redo restores");
});
