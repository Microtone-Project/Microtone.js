import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ROW_CODES, ROW_INDEX, rowOfCode, resolveKeymap, keymapNote, keymapStats,
  normaliseKeymap, BUILTIN_KEYMAPS, builtinKeymap, DEFAULT_KEYMAP, fitKeymapToPreset,
  parseTaudkey, buildTaudkey, quoteKeyFields, QUOTE_ACTIONS, QUOTE_DEFAULT,
  nearestRatio, unitsToCents, keymapHas, keymapClaimsZRow, PIANO_KEYMAP, upperRows,
} from "../../src/ui/keymap.js";
import { boardExtent, defaultLegend, BOARD_SIZES } from "../../src/ui/keymapboard.js";
import { JAM_SEMIS, semiToNoteInTable } from "../../src/ui/edit.js";
import { pitchTablePresets, noteForDegree } from "../../src/ui/pitchtables.js";
import { MIDDLE_C } from "../../src/engine/constants.js";

const P12 = pitchTablePresets[120];
const P41 = pitchTablePresets[410];
const P5 = pitchTablePresets[50];
const PT = pitchTablePresets[1];   // ProTracker — absolute, interval 0
const RAW = pitchTablePresets[0];  // no table at all

// ── the regression lock ──
// The Piano built-in must BE the old keyboard, not a re-creation of it: same
// keys, same notes, in every tuning. If this fails, existing users' keyboards
// have changed under them.

test("keymap: the Piano built-in is exactly JAM_SEMIS", () => {
  const piano = builtinKeymap("Piano");
  assert.equal(DEFAULT_KEYMAP, piano, "and it is what a fresh install jams with");
  // Two names for the same layout today, but they answer different questions:
  // "what do we start on" and "are the keys still arranged as a piano". Shipping
  // a different default must only move the first.
  assert.equal(PIANO_KEYMAP, piano, "and it is the one the note-column hint describes");
  const map = resolveKeymap(piano);

  assert.deepEqual(
    [...map.keys()].sort(),
    Object.keys(JAM_SEMIS).sort(),
    "claims exactly the keys the old table did — no more, no fewer",
  );
  for (const [code, semi] of Object.entries(JAM_SEMIS)) {
    assert.equal(map.get(code), semi, `${code} carries its old semitone`);
  }
  for (const preset of [undefined, RAW, P12, P41, P5, PT]) {
    for (const octave of [0, 4, 9]) {
      for (const [code, semi] of Object.entries(JAM_SEMIS)) {
        assert.equal(
          keymapNote(piano, code, octave, preset),
          semiToNoteInTable(octave, semi, preset),
          `${code} at octave ${octave} on ${preset?.name ?? "no preset"}`,
        );
      }
    }
  }
});

test("keymap: an unclaimed key resolves to null, never to a note", () => {
  const piano = builtinKeymap("Piano");
  for (const code of ["Quote", "KeyZ", "Digit1", "Backquote", "Minus", "Equal"]) {
    assert.equal(keymapNote(piano, code, 4, P12), null, code);
  }
});

// ── the lattice ──

test("keymap: the generator walks x per key and y per row", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["N", "Q", "A"], origin: { code: "KeyA", value: 0 }, x: 3, y: 4,
  });
  const map = resolveKeymap(spec);
  assert.equal(map.get("KeyA"), 0);
  assert.equal(map.get("KeyS"), 3, "one key right");
  assert.equal(map.get("Semicolon"), 27, "nine keys right");
  assert.equal(map.get("KeyQ"), 4, "one row up");
  assert.equal(map.get("Digit1"), 8, "two rows up");
  assert.equal(map.get("KeyW"), 7, "up and right is x + y");
  assert.equal(map.size, 30, "three rows of ten");
});

test("keymap: the origin can sit anywhere, and everything is relative to it", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyG", value: 100 }, x: 1, y: 1,
  });
  const map = resolveKeymap(spec);
  assert.equal(map.get("KeyG"), 100);
  assert.equal(map.get("KeyA"), 96, "four keys to the left of G");
  assert.equal(map.get("Semicolon"), 105);
});

test("keymap: an origin outside the active rows falls back to the bottom row", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["Q"], origin: { code: "KeyZ", value: 7 }, x: 1, y: 1,
  });
  assert.equal(spec.origin.code, "KeyQ");
  assert.equal(spec.origin.value, 0);
});

test("keymap: overrides replace the generator outright", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1,
    overrides: { KeyD: -99 },
  });
  const map = resolveKeymap(spec);
  assert.equal(map.get("KeyD"), -99, "not the 2 the generator would give");
  assert.equal(map.get("KeyF"), 3, "its neighbours are untouched");
});

test("keymap: the Z row is opt-in", () => {
  const three = resolveKeymap(normaliseKeymap({ rows: ["N", "Q", "A"] }));
  const four = resolveKeymap(normaliseKeymap({ rows: ["N", "Q", "A", "Z"] }));
  assert.equal(three.has("KeyX"), false, "sentinels keep the bottom row by default");
  assert.equal(four.has("KeyX"), true);
  assert.equal(four.size, 40, "four rows of ten — a full 41-TET period nearly fits");
  assert.equal(rowOfCode("Quote"), null, "and Quote is claimable by nobody");
});

// ── degrees, and how they wrap ──

test("keymap: degrees wrap through periods in both directions", () => {
  const n = P41.table.length;
  assert.equal(n, 41);
  // Degree n is the period root an octave up; degree -1 is the top of the
  // period below. This is the whole reason one integer per key is enough.
  assert.equal(noteForDegree(4, n, P41), MIDDLE_C + 0x1000);
  assert.equal(noteForDegree(4, 0, P41), MIDDLE_C);
  assert.equal(noteForDegree(4, -1, P41), MIDDLE_C - 0x1000 + P41.table[n - 1]);
  assert.equal(noteForDegree(4, 2 * n + 3, P41), MIDDLE_C + 2 * 0x1000 + P41.table[3]);
  // …and the octave argument stacks on top of that.
  assert.equal(noteForDegree(5, 0, P41), MIDDLE_C + 0x1000);
});

test("keymap: one spec plays 5-TET and 41-TET alike, no special-casing", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1,
  });
  // Ten keys of 5-TET is a whole second octave over; ten of 41-TET is a
  // quarter of one. Same spec, no branch anywhere.
  assert.equal(keymapNote(spec, "Semicolon", 4, P5), MIDDLE_C + 0x1000 + P5.table[4]);
  assert.equal(keymapNote(spec, "Semicolon", 4, P41), MIDDLE_C + P41.table[9]);
});

test("keymap: a Raw preset steps one 4096-TET unit per degree", () => {
  const spec = normaliseKeymap({ unit: "deg", rows: ["A"], x: 1, y: 1 });
  assert.equal(keymapNote(spec, "KeyS", 4, RAW), MIDDLE_C + 1);
});

test("keymap: an absolute table indexes directly and clamps at both ends", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1,
  });
  const first = keymapNote(spec, "KeyA", 4, PT);
  const low = normaliseKeymap({ ...spec, origin: { code: "KeyA", value: -50 } });
  assert.equal(keymapNote(low, "KeyA", 4, PT), first, "below the table clamps to its floor");
  const high = normaliseKeymap({ ...spec, origin: { code: "KeyA", value: 999 } });
  const top = keymapNote(high, "KeyA", 4, PT);
  assert.ok(top >= keymapNote(spec, "Semicolon", 4, PT), "above it clamps to its ceiling");
  assert.ok(Number.isFinite(top), "and never spins or overflows");
});

// ── coverage: the number that decides whether a layout is usable ──

test("keymap: the Harmonic Table's axes are swapped for a three-row board", () => {
  // Sheet 2's own orientation on five short Lumatone rows; on three long QWERTY
  // rows it strands three pitch classes (F, A and C#).
  const asPrinted = normaliseKeymap({
    unit: "deg", rows: ["N", "Q", "A"], origin: { code: "KeyA", value: 0 }, x: 4, y: 3,
  });
  assert.equal(keymapStats(asPrinted, P12).reachable, 9);

  // The same lattice reflected — still minor thirds, major thirds and fifths —
  // reaches all twelve. This is why the built-in is x 3 / y 4.
  const shipped = builtinKeymap("Harmonic Table");
  assert.equal(shipped.x, 3);
  assert.equal(shipped.y, 4);
  const stats = keymapStats(shipped, P12);
  assert.equal(stats.reachable, 12);
  assert.equal(stats.total, 12);
});

test("keymap: the isomorphic layouts cover 12-TET completely", () => {
  // Everything except Octave rows, which trades coverage for octave alignment:
  // a physical row is ten keys, so in 12-TET it can only reach ten degrees. It
  // is the layout for LOW tunings, and there it covers them outright (below).
  for (const spec of BUILTIN_KEYMAPS) {
    if (spec.unit !== "deg" || spec.name === "Octave rows") continue;
    assert.equal(keymapStats(spec, P12).reachable, 12, `${spec.name} reaches every pitch class`);
  }
});

test("keymap: Octave rows is the layout for low tunings", () => {
  const oct = builtinKeymap("Octave rows");
  for (const preset of [P5, pitchTablePresets[70], pitchTablePresets[100]]) {
    const fitted = fitKeymapToPreset(oct, preset);
    const stats = keymapStats(fitted, preset);
    assert.equal(stats.reachable, stats.total, `${preset.name} is covered outright`);
  }
  // …and in 12-TET it reaches ten of twelve, which is the trade it makes.
  assert.equal(keymapStats(fitKeymapToPreset(oct, P12), P12).reachable, 10);
});

test("keymap: stats report duplicates and span", () => {
  // Octave rows in 12-TET: each row is the row below an octave up, so the three
  // rows triple up on ten pitches — deliberate doublings, not waste.
  const oct = fitKeymapToPreset(builtinKeymap("Octave rows"), P12);
  const stats = keymapStats(oct, P12);
  assert.equal(stats.keys, 30);
  assert.equal(stats.duplicates, 0, "an octave apart is a different note");
  assert.equal(stats.highest - stats.lowest, 2 * 0x1000 + P12.table[9]);
  assert.equal(stats.reachable, 10, "ten degrees, three times over");
});

test("keymap: Octave rows only means something once a tuning is known", () => {
  assert.equal(fitKeymapToPreset(builtinKeymap("Octave rows"), P41).y, 41);
  assert.equal(fitKeymapToPreset(builtinKeymap("Octave rows"), P5).y, 5);
  assert.equal(fitKeymapToPreset(builtinKeymap("Chromatic run"), P41).y, 10, "others untouched");
});

test("keymap: a chromatic run reaches degrees 12-EDO snapping cannot", () => {
  const run = builtinKeymap("Chromatic run");
  const reached = new Set();
  for (const code of resolveKeymap(run).keys()) {
    reached.add(keymapNote(run, code, 4, P41));
  }
  const piano = builtinKeymap("Piano");
  const pianoReach = new Set();
  for (const code of resolveKeymap(piano).keys()) {
    pianoReach.add(keymapNote(piano, code, 4, P41));
  }
  const extra = [...reached].filter((n) => !pianoReach.has(n));
  assert.ok(extra.length >= 10, `the point of the exercise (${extra.length} new notes)`);
  assert.equal(keymapStats(run, P41).reachable, 30, "30 consecutive degrees of 41");
  assert.ok(keymapStats(piano, P41).reachable < 20, "where the piano map repeats itself");
});

test("keymap: axis read-outs are measured, not idealised", () => {
  const wicki = builtinKeymap("Wicki–Hayden");
  const { axisCents } = keymapStats(wicki, P12);
  assert.ok(Math.abs(axisCents.x - 200) < 1, "a row step is a whole tone");
  assert.ok(Math.abs(axisCents.y - 500) < 1, "a rank step is a fourth");
  const r = nearestRatio(axisCents.y);
  assert.deepEqual([r.n, r.d], [4, 3]);
  assert.equal(Math.round(unitsToCents(4096)), 1200);
});

// ── .taudkey ──

test("taudkey: round-trips a spec unchanged", () => {
  const spec = normaliseKeymap({
    name: "Bosanquet 41", unit: "deg", rows: ["N", "Q", "A"],
    origin: { code: "KeyA", value: 3 }, x: 1, y: 6, notation: 410,
    overrides: { KeyQ: -1, Semicolon: 99 },
  });
  assert.deepEqual(parseTaudkey(buildTaudkey(spec)), spec);
});

test("taudkey: fractional values survive (the Piano map's quarter-tones)", () => {
  const back = parseTaudkey(buildTaudkey(builtinKeymap("Piano")));
  assert.deepEqual(back, builtinKeymap("Piano"));
  assert.equal(back.overrides.KeyQ, -0.5);
});

test("taudkey: comments, blank lines and unknown directives are tolerated", () => {
  const spec = parseTaudkey([
    "! a keymap someone wrote by hand",
    "",
    "TAUDKEY 1",
    "name      Hand written",
    "   ",
    "unit      deg",
    "rows      Q A",
    "origin    KeyA 0",
    "x         1",
    "y         6",
    "colour    puce",          // from some later version
    "@KeyQ     -1",
  ].join("\n"));
  assert.equal(spec.name, "Hand written");
  assert.deepEqual(spec.rows, ["A", "Q"]);
  assert.equal(spec.overrides.KeyQ, -1);
});

test("taudkey: malformed input fails with something a human can read", () => {
  const bad = (text, re) => assert.throws(() => parseTaudkey(text), re);
  bad("", /empty/);
  bad("hello\n", /not a keymap file/);
  bad("TAUDKEY\n", /no version/);
  bad("TAUDKEY 99\nname x\n", /newer than this build/);
  bad("TAUDKEY 1\nunit cents\n", /unknown unit/);
  bad("TAUDKEY 1\nrows Q X\n", /unknown row/);
  bad("TAUDKEY 1\norigin KeyNope 0\n", /unknown key/);
  bad("TAUDKEY 1\nx wide\n", /bad number/);
  bad("TAUDKEY 1\n@Nope 1\n", /unknown key/);
});

// ── the Quote key ──

test("quote key: each setting writes its own sentinel", () => {
  assert.equal(QUOTE_DEFAULT, "cut", "the one sentinel a Z-row map leaves homeless");
  assert.deepEqual(quoteKeyFields("off"), { note: 0x0001 });
  assert.deepEqual(quoteKeyFields("cut"), { note: 0x0002 });
  assert.deepEqual(quoteKeyFields("fade"), { note: 0x0003 });
  assert.deepEqual(quoteKeyFields("fastfade"), { note: 0x0004 });
  assert.deepEqual(quoteKeyFields("clear"), { note: 0, instrment: 0 });
  assert.equal(quoteKeyFields("none"), null);
  assert.equal(quoteKeyFields("nonsense"), null, "an unreadable preference is inert");
  for (const a of QUOTE_ACTIONS) {
    assert.ok(a === "none" || quoteKeyFields(a) !== null, a);
  }
});

// ── the physical rows ──

test("keymap: the rows are ten physical keys each, in reading order", () => {
  for (const [name, codes] of Object.entries(ROW_CODES)) {
    assert.equal(codes.length, 10, name);
    assert.equal(new Set(codes).size, 10, `${name} has no repeats`);
    for (const code of codes) assert.equal(rowOfCode(code), name, code);
  }
  const all = Object.values(ROW_CODES).flat();
  assert.equal(new Set(all).size, 40, "and no key is in two rows");
  // The editor's own keys must never be claimable.
  for (const code of ["Minus", "Equal", "Quote", "Backquote", "BracketLeft", "BracketRight"]) {
    assert.equal(rowOfCode(code), null, code);
  }
  assert.deepEqual(
    Object.entries(ROW_INDEX).sort((a, b) => a[1] - b[1]).map((e) => e[0]),
    ["Z", "A", "Q", "N"],
    "bottom-up",
  );
});

// ── the board's geometry (shared by the tab and the strip) ──

test("board: ortholinear drops the stagger and the interlock", () => {
  const three = normaliseKeymap({ rows: ["N", "Q", "A"] });
  const stag = boardExtent(three, "full", false);
  const ortho = boardExtent(three, "full", true);
  const S = BOARD_SIZES.full;

  // Staggered rows need an extra cap of width for the offset ones to lean into.
  assert.equal(stag.w - ortho.w, S.w, "a column board is exactly ten caps wide");
  // Hexagons interlock, so their rows sit closer than a cap is tall; rectangles
  // would overlap at that pitch, so a column board gives each row its height.
  assert.ok(ortho.h > stag.h, "and each row gets its full height");
  assert.equal(ortho.h, S.pad * 2 + S.h * 3);
  assert.equal(stag.h, S.pad * 2 + S.step * 2 + S.h);

  // Row count still drives the height, ortholinear or not.
  const four = normaliseKeymap({ rows: ["N", "Q", "A", "Z"] });
  assert.equal(boardExtent(four, "full", true).h - ortho.h, S.h);
  assert.equal(boardExtent(three, "compact", true).h < ortho.h, true, "compact is shorter");
});

test("board: the legend falls back to the printed key, symbols included", () => {
  assert.equal(defaultLegend("KeyQ"), "Q");
  assert.equal(defaultLegend("Digit0"), "0");
  assert.equal(defaultLegend("Semicolon"), ";");
  assert.equal(defaultLegend("Slash"), "/");
  assert.equal(defaultLegend("Quote"), "'");
});

// ── manual layouts: the shape "set every key" produces ──

test("keymap: a fully-overridden layout has no generator left to fight it", () => {
  // What the Set-every-key dialog writes: every key an override, x and y zero.
  const rows = ["N", "Q", "A"];
  const overrides = {};
  let v = 0;
  for (const r of rows) for (const code of ROW_CODES[r]) overrides[code] = (v += 3);
  const manual = normaliseKeymap({
    name: "hand placed", unit: "deg", rows, origin: { code: "KeyA", value: 0 },
    x: 0, y: 0, overrides,
  });
  const map = resolveKeymap(manual);
  assert.equal(map.size, 30);
  for (const [code, value] of Object.entries(overrides)) {
    assert.equal(map.get(code), value, code);
  }
  // An inert generator cannot move anything: the origin's own value is the one
  // its override says, not the origin field's.
  assert.equal(map.get("KeyA"), overrides.KeyA);
  // …and it survives the round trip, which is what makes such a layout shareable.
  assert.deepEqual(parseTaudkey(buildTaudkey(manual)), manual);
});

test("keymap: hand-placed keys work on an unequal tuning", () => {
  // The case the dialog exists for: degrees of different sizes, so no pair of
  // steps describes a useful board. Shi'er lü is the shipped unequal example.
  const lu = pitchTablePresets[10123];
  const steps = lu.table.map((v, i, a) => (i === 0 ? v : v - a[i - 1]));
  assert.ok(new Set(steps).size > 1, "the tuning really is unequal");

  const overrides = { KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 7, KeyG: 9, KeyH: 12 };
  const manual = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 },
    x: 0, y: 0, overrides,
  });
  // Degree 12 is the period root an octave up — the wrap still applies to a
  // hand-placed value, so a manual layout is not limited to one period.
  assert.equal(keymapNote(manual, "KeyH", 4, lu), MIDDLE_C + 0x1000);
  assert.equal(keymapNote(manual, "KeyF", 4, lu), MIDDLE_C + lu.table[7]);
  // Keys nobody placed sit at the inert generator's origin value, not at random.
  assert.equal(resolveKeymap(manual).get("KeyL"), 0);
});

// ── silencing a key ──

test("keymap: a null override takes the key off the board", () => {
  const spec = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1,
    overrides: { KeyD: null, KeyF: 3 },
  });
  const map = resolveKeymap(spec);
  assert.equal(map.has("KeyD"), false, "silenced keys leave the map entirely");
  assert.equal(map.get("KeyF"), 3, "its neighbours are untouched");
  assert.equal(map.size, 9, "nine of the row's ten keys still play");
  // Everything downstream reads "not in the map" as "not a piano key", which is
  // what makes silence need no special case beyond the resolver.
  assert.equal(keymapNote(spec, "KeyD", 4, P12), null, "it sounds nothing");
  assert.equal(keymapHas(spec, "KeyD"), false, "and the jam never claims it");
});

test("keymap: silencing is counted out of the readout, not counted as a note", () => {
  const full = normaliseKeymap({
    unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1,
  });
  const holed = normaliseKeymap({ ...full, overrides: { KeyD: null, KeyG: null } });
  assert.equal(keymapStats(full, P12).keys - keymapStats(holed, P12).keys, 2);
  assert.ok(keymapStats(holed, P12).reachable < keymapStats(full, P12).reachable,
    "a degree only that key reached is no longer reachable");
});

test("keymap: silencing z does NOT hand the sentinels back", () => {
  // The trap: the Z row is still the layout's, so x/c/v/b are still notes. If
  // "does this map claim the bottom row" were asked of the z KEY rather than of
  // the ROW, silencing z alone would restore the sentinels onto keys that are
  // busy playing pitches.
  const four = normaliseKeymap({
    unit: "deg", rows: ["N", "Q", "A", "Z"], origin: { code: "KeyA", value: 0 }, x: 1, y: 10,
  });
  assert.equal(keymapClaimsZRow(four), true);
  const zSilent = normaliseKeymap({ ...four, overrides: { KeyZ: null } });
  assert.equal(keymapHas(zSilent, "KeyZ"), false, "z itself plays nothing");
  assert.equal(keymapHas(zSilent, "KeyX"), true, "but x is still a note");
  assert.equal(keymapClaimsZRow(zSilent), true, "so the row is still claimed");
  // A three-row layout is still the one that gives them back.
  assert.equal(keymapClaimsZRow(normaliseKeymap({ rows: ["N", "Q", "A"] })), false);
});

test("taudkey: a silenced key round-trips as \"off\"", () => {
  const spec = normaliseKeymap({
    name: "holed", unit: "deg", rows: ["A"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1,
    overrides: { KeyD: null, KeyF: 3 },
  });
  const text = buildTaudkey(spec);
  assert.match(text, /@KeyD off/, "written as a word, not as a blank");
  assert.deepEqual(parseTaudkey(text), spec);
  // …and it is readable the other way round, typed by hand in either case.
  const typed = parseTaudkey("TAUDKEY 1\nrows A\norigin KeyA 0\nx 1\ny 1\n@KeyD OFF\n");
  assert.equal(typed.overrides.KeyD, null);
});

// ── the shipped Shi'er lü layout ──

test("keymap: Shi'er lü ships as a hand-placed layout bound to its tuning", () => {
  const lu = pitchTablePresets[10123];
  const steps = lu.table.map((v, i, a) => (i === 0 ? v : v - a[i - 1]));
  assert.ok(new Set(steps).size > 1, "the tuning it is for really is unequal");

  const spec = BUILTIN_KEYMAPS.find((k) => k.notation === 10123);
  assert.ok(spec, "it is in the shipped library");
  assert.equal(spec.x, 0);
  assert.equal(spec.y, 0, "no generator — an unequal tuning has no useful lattice");
  assert.equal(Object.keys(spec.overrides).length, 40, "every key of four rows is placed");
  assert.deepEqual(spec.rows, ["Z", "A", "Q", "N"], "it takes the bottom row");

  const stats = keymapStats(spec, lu);
  assert.equal(stats.reachable, 12);
  assert.equal(stats.total, 12, "and reaches the whole tuning");
  assert.ok(stats.keys < 40, `some keys are deliberately silent (${stats.keys} sound)`);
  assert.ok(Object.values(spec.overrides).some((v) => v === null), "…recorded as silence");

  // The binding is what brings it up on its own, so it has to survive the
  // round trip a shared file makes.
  assert.deepEqual(parseTaudkey(buildTaudkey(spec)), spec);
});

test("keymap: Piano stays first, whatever else ships", () => {
  // DEFAULT_KEYMAP and PIANO_KEYMAP are both BUILTIN_KEYMAPS[0]; adding layouts
  // must not disturb that, and nothing may shadow the piano's name.
  assert.equal(BUILTIN_KEYMAPS[0].name, "Piano");
  assert.equal(BUILTIN_KEYMAPS.filter((k) => k.name === "Piano").length, 1);
  assert.equal(new Set(BUILTIN_KEYMAPS.map((k) => k.name)).size, BUILTIN_KEYMAPS.length,
    "and every shipped layout has its own name — the library keys on it");
});

// ── the two-hand split (item 189) ──
//
// A four-row board is two keyboards, one per hand. `upper` moves the top pair
// so the two hands play different registers, which is what turns thirty-odd
// keys of the same half-octave over and over into a board that runs.

test("keymap: the split moves the TOP TWO rows and nothing else", () => {
  const spec = normaliseKeymap({
    rows: ["Z", "A", "Q", "N"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1, upper: 100,
  });
  const map = resolveKeymap(spec);
  assert.deepEqual(upperRows(spec.rows), ["Q", "N"], "Q and N are the upper block");
  assert.equal(map.get("KeyZ"), -1, "Z row: the lattice alone");
  assert.equal(map.get("KeyA"), 0, "A row: the origin");
  assert.equal(map.get("KeyQ"), 101, "Q row: one row up, plus the split");
  assert.equal(map.get("Digit1"), 102, "N row: two rows up, plus the same split");
  // …and the split is one offset for the block, not a per-row one: the interval
  // BETWEEN the two upper rows is still y.
  assert.equal(map.get("Digit1") - map.get("KeyQ"), spec.y);
});

test("keymap: the split is measured from the origin's own block", () => {
  // Anchor the origin in the UPPER block and the origin key is still worth
  // exactly origin.value — the lower block drops away below it instead. The
  // panel shows that one number, and it has to mean what it says either way.
  const spec = normaliseKeymap({
    rows: ["Z", "A", "Q", "N"], origin: { code: "KeyQ", value: 7 }, x: 1, y: 1, upper: 50,
  });
  const map = resolveKeymap(spec);
  assert.equal(map.get("KeyQ"), 7, "the origin key is the origin value");
  assert.equal(map.get("KeyA"), 7 - 1 - 50, "the lower block sits a split below");
  assert.equal(map.get("Digit1"), 8, "the other upper row keeps the plain lattice step");
});

test("keymap: a board with fewer than three rows has no split to make", () => {
  // Two rows ARE the top two, so "move the top two" would move the whole board
  // — which is what origin.value already does. The control is off there, and
  // upperRows is what the panel asks.
  for (const rows of [["A"], ["A", "Q"], ["Z", "A"]]) {
    assert.deepEqual(upperRows(normaliseKeymap({ rows }).rows), [], rows.join(""));
  }
  const two = normaliseKeymap({ rows: ["A", "Q"], origin: { code: "KeyA", value: 0 }, x: 1, y: 10, upper: 100 });
  assert.equal(resolveKeymap(two).get("KeyQ"), 10, "the stored value is simply not applied");
  assert.equal(two.upper, 100, "…and not destroyed either — ticking a third row brings it back");
});

test("keymap: the split reproduces a hand-placed four-row layout exactly", () => {
  // The layout item 189 exists for: Bosanquet–Wilson over nine unequal degrees,
  // the upper hand twenty degrees above the lower. Hand-placed it needed twenty
  // overrides; generated it needs one number, and the two must be the SAME
  // keyboard or the feature has not replaced anything.
  const byHand = normaliseKeymap({
    rows: ["Z", "A", "Q", "N"], origin: { code: "KeyA", value: -1 }, x: 2, y: -1,
    overrides: {
      Digit1: 17, Digit2: 19, Digit3: 21, Digit4: 23, Digit5: 25,
      Digit6: 27, Digit7: 29, Digit8: 31, Digit9: 33, Digit0: 35,
      KeyQ: 18, KeyW: 20, KeyE: 22, KeyR: 24, KeyT: 26,
      KeyY: 28, KeyU: 30, KeyI: 32, KeyO: 34, KeyP: 36,
    },
  });
  const generated = normaliseKeymap({
    rows: ["Z", "A", "Q", "N"], origin: { code: "KeyA", value: -1 }, x: 2, y: -1, upper: 20,
  });
  assert.deepEqual(
    [...resolveKeymap(generated).entries()].sort(),
    [...resolveKeymap(byHand).entries()].sort(),
    "every one of the forty keys",
  );
  assert.equal(Object.keys(generated.overrides).length, 0, "and with no overrides left");
});

test("keymap: the split is read out in cents, like the two axes", () => {
  const P12 = pitchTablePresets[120];
  const split = normaliseKeymap({
    rows: ["Z", "A", "Q", "N"], origin: { code: "KeyA", value: 0 }, x: 1, y: 3, upper: 12,
  });
  assert.equal(Math.round(keymapStats(split, P12).axisCents.upper), 1200,
    "twelve degrees of 12-TET is the octave");
  // No split, no read-out: the panel hides the row rather than showing a dash
  // on every layout that does not use one.
  const plain = normaliseKeymap({ rows: ["N", "Q", "A"], origin: { code: "KeyA", value: 0 }, x: 2, y: 1 });
  assert.equal(keymapStats(plain, P12).axisCents.upper, 0);
  // …and neither does a board too short to split, whatever it stores.
  const two = normaliseKeymap({ rows: ["A", "Q"], origin: { code: "KeyA", value: 0 }, x: 1, y: 1, upper: 12 });
  assert.equal(keymapStats(two, P12).axisCents.upper, 0);
});

test("taudkey: a split file says version 2, and only a split file does", () => {
  const split = normaliseKeymap({
    name: "Split", rows: ["Z", "A", "Q", "N"], origin: { code: "KeyA", value: -1 },
    x: 2, y: -1, upper: 20,
  });
  const text = buildTaudkey(split);
  assert.match(text, /^TAUDKEY 2$/m, "a layout version 1 cannot read declares 2");
  assert.match(text, /^upper\s+20$/m);
  assert.deepEqual(parseTaudkey(text), split, "and it round-trips");

  // Everything else still writes version 1 — a new field must not make every
  // exported file unreadable to a build that would have understood it.
  for (const spec of BUILTIN_KEYMAPS) {
    assert.match(buildTaudkey(spec), /^TAUDKEY 1$/m, spec.name);
    assert.doesNotMatch(buildTaudkey(spec), /^upper\b/m, spec.name);
  }
  // An older file has no split, and reads as one without.
  assert.equal(parseTaudkey(buildTaudkey(BUILTIN_KEYMAPS[1])).upper, 0);
});
