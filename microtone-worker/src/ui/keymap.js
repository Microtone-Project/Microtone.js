// Isomorphic keymaps — the QWERTY as a mini Lumatone.
//
// The jam keyboard used to be one frozen table of 12-EDO semitones (JAM_SEMIS,
// edit.js), snapped to the nearest degree of whatever tuning was loaded. That
// makes a PIANO APPROXIMATION of a tuning: on 41-TET it offers 21 keys that all
// land on 12-EDO positions, so most of the tuning's own degrees cannot be
// played at all. This module replaces the unit of that lookup — degrees of the
// active table, laid out as a rank-2 lattice — so any TET is playable.
//
// A keymap is a GENERATOR plus sparse per-key OVERRIDES, and resolves to
// exactly ONE INTEGER per key:
//
//   value(code) = origin.value + (col - originCol)·x + (row - originRow)·y
//                 + (upper, on the top two rows)
//
// col is the key's index within its physical row and row is the row's own
// index, so "one key right" is x and "one row up" is y. The half-key stagger a
// real keyboard has is cosmetic — the lattice is what defines an isomorphic
// layout, which is also why the built-ins below are oriented for three long
// rows rather than transcribed from the Lumatone's five short ones (a literal
// transcription of the Harmonic Table reaches only 9 of the 12 pitch classes;
// the same lattice with its axes swapped reaches all 12 — see keymapStats).
//
// `upper` is the one thing in a spec that is NOT part of the lattice, and it is
// there because a four-row board is not one keyboard but two: the bottom two
// rows fall under one hand and the top two under the other. Splitting them —
// moving the upper pair a fixed distance so the two hands play different
// registers instead of the same one twice — is how a generalised keyboard is
// actually laid out for a small tuning, where four rows of a plain lattice
// would otherwise wrap through the same half-dozen pitches over and over. See
// upperRows for exactly which rows move.
//
// One integer is enough because degrees WRAP through periods (noteForDegree,
// pitchtables.js): degree 41 of 41-TET is the period root an octave up, degree
// -1 the top degree of the period below. So one spec works unchanged on 5-TET
// and 96-TET, the tuning's own cardinality doing the wrapping.
//
// Keymaps are a PERFORMER preference: they travel as .taudkey text files, and
// nothing here touches the document or the engine. Pure and Node-testable — no
// DOM, no storage. A PROJECT may carry one too (item 189.1, the `PKey` section),
// for a piece that cannot be edited on any other keyboard — but even then what
// the document holds is this module's own .taudkey TEXT, and this module neither
// knows nor cares that it does.

import { semiToNoteInTable, noteForDegree, nearestDegreeIndex } from "./pitchtables.js";

// ── the physical rows ──
//
// Left to right by KeyboardEvent.code, so the shape is the same on QWERTZ,
// AZERTY and Dvorak — the mapping is by physical position, not by legend.
// Minus/Equal and Quote are deliberately absent: the first two are the editor's
// nudge keys, and Quote is the user-definable sentinel slot (QUOTE_ACTIONS),
// which is exactly why it sits one key past where the A row ends.
export const ROW_CODES = Object.freeze({
  N: Object.freeze(["Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
                    "Digit6", "Digit7", "Digit8", "Digit9", "Digit0"]),
  Q: Object.freeze(["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT",
                    "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"]),
  A: Object.freeze(["KeyA", "KeyS", "KeyD", "KeyF", "KeyG",
                    "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"]),
  Z: Object.freeze(["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB",
                    "KeyN", "KeyM", "Comma", "Period", "Slash"]),
});

/** Lattice row number per physical row — A is the origin row, the number row
 *  is two above it, and the Z row sits below. */
export const ROW_INDEX = Object.freeze({ A: 0, Q: 1, N: 2, Z: -1 });

/** Rows in bottom-up order, for anything that draws or iterates the board. */
export const ROW_ORDER = Object.freeze(["Z", "A", "Q", "N"]);

export const ROW_NAMES = Object.freeze(Object.keys(ROW_CODES));

/** Which row a code belongs to, or null for a key no keymap can claim. */
export function rowOfCode(code) {
  for (const name of ROW_NAMES) if (ROW_CODES[name].includes(code)) return name;
  return null;
}

// ── the Quote key: one user-definable sentinel slot (app configuration) ──
//
// Quote sits immediately right of Semicolon, which is where the A row ENDS, so
// no keymap can ever claim it and it never auditions. That makes it the one
// dependable home-row sentinel whatever the active map has taken over — which
// matters because a keymap that claims the Z row displaces the cut/fade/fast-
// fade/interrupt keys that live there.
//
// It is app configuration, NOT part of any keymap: it is never written to a
// .taudkey, and it does not change when you switch maps. The default is `cut`
// because note cut is the sentinel a Z-row map displaces that is most often
// wanted in a hurry — key-off keeps Shift+Z, Delete/Backspace still clear.
export const QUOTE_ACTIONS = Object.freeze(["cut", "off", "fade", "fastfade", "clear", "none"]);
export const QUOTE_DEFAULT = "cut";

/** Cell fields the Quote key writes, or null when it is inert. Shaped like the
 *  other note-column sentinels in edit.js, clear included. */
export function quoteKeyFields(action) {
  switch (action) {
    case "off": return { note: 0x0001 };
    case "cut": return { note: 0x0002 };
    case "fade": return { note: 0x0003 };
    case "fastfade": return { note: 0x0004 };
    case "clear": return { note: 0, instrment: 0 };
    default: return null; // "none", and anything unrecognised
  }
}

// ── the spec ──

export const UNITS = Object.freeze(["deg", "semi"]);

/** What a SILENCED key is written as — in a .taudkey file, and in the editor's
 *  own fields. Declared up here because normaliseKeymap reads it, and that runs
 *  while this module is still evaluating (BUILTIN_KEYMAPS below). */
export const OFF = "off";

/** A spec with every field filled in, so callers never guard for absent ones. */
export function normaliseKeymap(spec) {
  const rows = (Array.isArray(spec?.rows) ? spec.rows : ["Q", "A"])
    .filter((r) => r in ROW_CODES);
  const use = rows.length > 0 ? rows : ["Q", "A"];
  const originCode = spec?.origin?.code;
  const origin = codeInRows(originCode, use)
    ? { code: originCode, value: num(spec.origin.value, 0) }
    : { code: ROW_CODES[lowestRow(use)][0], value: 0 };
  const overrides = {};
  for (const [code, v] of Object.entries(spec?.overrides ?? {})) {
    if (!rowOfCode(code)) continue;
    // null is the SILENCE override: the key keeps its place on the board and
    // plays nothing. A layout that maps 22 degrees over 30 keys wants the
    // leftovers silent rather than sounding something arbitrary, and a scale
    // with a gap in it wants that gap under the fingers.
    overrides[code] = v === null || v === OFF ? null : num(v, 0);
  }
  return {
    name: String(spec?.name ?? "Untitled"),
    unit: UNITS.includes(spec?.unit) ? spec.unit : "deg",
    rows: ROW_ORDER.filter((r) => use.includes(r)),
    origin,
    x: num(spec?.x, 1),
    y: num(spec?.y, 1),
    upper: num(spec?.upper, 0),
    notation: Number.isFinite(spec?.notation) ? spec.notation : null,
    overrides,
  };
}

const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
const codeInRows = (code, rows) => rows.some((r) => ROW_CODES[r].includes(code));
/** The bottom-most active row — where an unusable origin falls back to. */
const lowestRow = (rows) => ROW_ORDER.find((r) => rows.includes(r)) ?? "A";

/**
 * The rows `upper` moves: the TOP TWO of the active ones, and none at all on a
 * board with fewer than three rows.
 *
 * Top two rather than "Q and N" so the split follows the board rather than the
 * keyboard — a four-row layout splits into the two hand blocks it really has,
 * and a three-row one splits two rows over one. Two rows is the whole board
 * when only two are active, and moving the whole board is what `origin.value`
 * already does, so there the control has nothing to say and is switched off.
 *
 * `rows` is expected in ROW_ORDER (bottom-up), which is what normaliseKeymap
 * guarantees — hence the last two, not the first.
 */
export function upperRows(rows) {
  return rows.length >= 3 ? rows.slice(-2) : [];
}

/**
 * Resolve a spec to `Map<code, value>` — the generator over every key of every
 * active row, with overrides replacing individual entries outright. The value's
 * meaning is the spec's `unit`: degrees of the active table, or 12-EDO
 * semitones (which may be fractional — that is how the Piano map keeps its
 * quarter-tone keys).
 */
export function resolveKeymap(spec) {
  const s = normaliseKeymap(spec);
  const originRow = rowOfCode(s.origin.code);
  const originCol = ROW_CODES[originRow].indexOf(s.origin.code);
  // The split is measured from the origin's OWN block, so the origin key is
  // worth origin.value wherever it sits. Anchor it in the upper block and the
  // lower one drops away below it instead — which is the same keyboard, and
  // keeps the one number the panel shows as "Origin value" honest.
  const upper = s.upper === 0 ? new Set() : new Set(upperRows(s.rows));
  const originUpper = upper.has(originRow) ? s.upper : 0;
  const out = new Map();
  for (const name of s.rows) {
    const dRow = ROW_INDEX[name] - ROW_INDEX[originRow];
    const dBlock = (upper.has(name) ? s.upper : 0) - originUpper;
    ROW_CODES[name].forEach((code, col) => {
      out.set(code, s.origin.value + (col - originCol) * s.x + dRow * s.y + dBlock);
    });
  }
  for (const [code, v] of Object.entries(s.overrides)) {
    // A silenced key leaves the map entirely. Everything downstream already
    // treats "not in the map" as "not a piano key" — it does not sound, it does
    // not enter a note, and the board paints it as an unassigned cap — so
    // silence needs no special case anywhere but here.
    if (v === null) out.delete(code);
    else if (out.has(code) || rowOfCode(code)) out.set(code, v);
  }
  return out;
}

// A spec is treated as IMMUTABLE — editing one produces a new object — so a
// resolved map can be cached against its identity. Every keystroke asks for
// one, and rebuilding forty entries per keydown is work nobody needs.
const _resolved = new WeakMap();

/** resolveKeymap, memoised on the spec object. */
export function resolvedKeymap(spec) {
  let map = _resolved.get(spec);
  if (map === undefined) {
    map = resolveKeymap(spec);
    _resolved.set(spec, map);
  }
  return map;
}

/** Does `spec` claim `code`? The membership test the key handlers run first. */
export function keymapHas(spec, code) {
  return resolvedKeymap(spec).has(code);
}

/**
 * Has this map taken the bottom row? That row is where the note column's
 * sentinels live (key-off, cut, fade, fast fade, interrupt) and where mute and
 * solo sit in navigate mode, so a map that claims it displaces all of them onto
 * Shift — the one place the editor has to care which rows a keymap uses.
 *
 * Asked of the ROW, not of any one key: silencing z itself must not hand the
 * sentinels back while x, c and v are still notes, which is what testing a
 * single key for membership would have done.
 */
export function keymapClaimsZRow(spec) {
  return normaliseKeymap(spec).rows.includes("Z");
}

/**
 * Note word key `code` plays at `octave` under `spec`, or null when the map
 * does not claim that key. `deg` goes through the tuning's own degrees; `semi`
 * through the old snap-a-semitone path, which is what keeps the Piano built-in
 * bit-for-bit what the keyboard has always done.
 *
 * `shift` is the keyboard's own transposition (Shift+Alt+←/→), in the layout's
 * unit: a degree of the tuning on a `deg` layout, a semitone on a `semi` one.
 * It moves every key by the same step, so the layout's shape — and every hand
 * shape on it — is untouched.
 */
export function keymapNote(spec, code, octave, preset, resolved = null, shift = 0) {
  const map = resolved ?? resolvedKeymap(spec);
  if (!map.has(code)) return null;
  const value = map.get(code) + shift;
  const unit = UNITS.includes(spec?.unit) ? spec.unit : "deg";
  return unit === "semi"
    ? semiToNoteInTable(octave, value, preset)
    : noteForDegree(octave, value, preset);
}

// ── read-outs ──

/** 4096-TET units → cents. One period of 0x1000 is an octave, whatever the
 *  preset's own interval is, so this holds for tritaves too. */
export const unitsToCents = (units) => (units * 1200) / 4096;

/**
 * What a layout actually gives you in a tuning — the numbers the Keymap tab
 * shows, and the ones that decide whether a layout is usable at all:
 *
 *   reachable / total  distinct degrees of the period the board can play. This
 *                      is the headline: a layout that reaches 9 of 12 has three
 *                      pitch classes you simply cannot type.
 *   duplicates         keys that repeat a note another key already plays —
 *                      wasted on a small board, deliberate "note doublings" on
 *                      a big one.
 *   lowest / highest   the board's span as note words, at `octave`.
 *   axisCents          what one step along each axis is worth, measured from
 *                      the origin so a non-equal table reports what it really
 *                      does rather than an idealised step. `upper` is the same
 *                      measurement for the two-hand split — 0 when there is
 *                      none, which is also how the panel knows not to show it.
 */
export function keymapStats(spec, preset, octave = 4) {
  const s = normaliseKeymap(spec);
  const map = resolveKeymap(s);
  const degrees = new Set();
  const notes = new Map();
  let duplicates = 0, lowest = null, highest = null;
  for (const code of map.keys()) {
    const note = keymapNote(s, code, octave, preset, map);
    if (note === null) continue;
    if (notes.has(note)) duplicates++;
    else notes.set(note, code);
    if (lowest === null || note < lowest) lowest = note;
    if (highest === null || note > highest) highest = note;
    degrees.add(nearestDegreeIndex(note, preset).index);
  }
  const total = preset?.table?.length ?? 0;
  const base = keymapNote(s, s.origin.code, octave, preset, map);
  return {
    reachable: total > 0 ? degrees.size : notes.size,
    total,
    duplicates,
    lowest,
    highest,
    keys: map.size,
    axisCents: {
      x: axisCents(s, preset, octave, map, s.x, base),
      y: axisCents(s, preset, octave, map, s.y, base),
      upper: upperRows(s.rows).length > 0
        ? axisCents(s, preset, octave, map, s.upper, base) : 0,
    },
  };
}

/** What a `step`-unit move from the origin key is worth in cents — measured
 *  from the origin outwards, so an unequal table reports what the layout really
 *  does there rather than an idealised step. */
function axisCents(s, preset, octave, map, step, base) {
  if (base === null || step === 0) return 0;
  const moved = s.unit === "semi"
    ? semiToNoteInTable(octave, map.get(s.origin.code) + step, preset)
    : noteForDegree(octave, map.get(s.origin.code) + step, preset);
  return unitsToCents(moved - base);
}

/** How far a ratio may sit from an axis and still be worth naming, in cents.
 *  Roughly the error 12-TET's own thirds carry, so the intervals a musician
 *  already hears as 5/4 and 6/5 qualify. */
const RATIO_TOL = 18;

/**
 * The SIMPLEST just ratio near a cents value — how the generator panel names an
 * axis ("702¢ ≈ 3/2") so a layout can be reasoned about as intervals rather
 * than degree counts.
 *
 * Simplest, not nearest: 300¢ is 2.5¢ from 19/16 and 16¢ from 6/5, and naming
 * it 19/16 would be arithmetically better and musically useless — nobody hears
 * a minor third as a nineteenth harmonic. So candidates are gathered within
 * RATIO_TOL and the one with the smallest n·d wins, which is the ratio a
 * listener would actually name.
 */
export function nearestRatio(cents) {
  let best = null;
  for (let d = 1; d <= 16; d++) {
    for (let n = d; n <= d * 4; n++) {
      const err = Math.abs(1200 * Math.log2(n / d) - cents);
      if (err > RATIO_TOL) continue;
      const complexity = n * d;
      if (best === null || complexity < best.complexity
          || (complexity === best.complexity && err < best.err)) {
        best = { n, d, err, complexity };
      }
    }
  }
  // Nothing simple is near enough — fall back to the nearest of all, which the
  // caller can reject by looking at `err`.
  if (best === null) {
    best = { n: 1, d: 1, err: Math.abs(cents), complexity: 1 };
    for (let d = 1; d <= 16; d++) {
      for (let n = d; n <= d * 4; n++) {
        const err = Math.abs(1200 * Math.log2(n / d) - cents);
        if (err < best.err - 1e-9) best = { n, d, err, complexity: n * d };
      }
    }
  }
  return best;
}

// ── built-in keymaps ──
//
// Every GENERATED layout below reaches all 12 pitch classes on three rows in
// 12-TET, which is why the axes are what they are; keymapStats is how you check
// the same holds in any other tuning. The two that are not generated —  Piano
// and Shi’er lü — are placed key by key, and say why in their own comments.

/** The keyboard as it has always been — a piano, not a lattice. Kept as the
 *  default so nothing changes for anyone who does not go looking, and expressed
 *  as explicit overrides because a piano's black keys are not isomorphic. */
const PIANO_OVERRIDES = {
  KeyQ: -0.5,
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyR: 4.5, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyI: 11.5, KeyK: 12,
  KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};

export const BUILTIN_KEYMAPS = Object.freeze([
  normaliseKeymap({
    name: "Piano", unit: "semi", rows: ["Q", "A"],
    origin: { code: "KeyA", value: 0 }, x: 0, y: 0,
    overrides: PIANO_OVERRIDES,
  }),
  // Sheet 1 of the Lumatone presets: semitones on one axis, whole tones on the
  // other. The classic generalised keyboard, and the gentlest for a pianist.
  normaliseKeymap({
    name: "Bosanquet–Wilson", unit: "deg", rows: ["N", "Q", "A"],
    origin: { code: "KeyA", value: 0 }, x: 2, y: 1,
  }),
  // Whole tones along a row, fourths and fifths on the two diagonals.
  normaliseKeymap({
    name: "Wicki–Hayden", unit: "deg", rows: ["N", "Q", "A"],
    origin: { code: "KeyA", value: 0 }, x: 2, y: 5,
  }),
  // Sheet 2, with the axes swapped for a three-row board: minor thirds along a
  // row, major thirds between rows, so up-and-right is the fifth. Every major
  // and minor triad is one hand shape.
  normaliseKeymap({
    name: "Harmonic Table", unit: "deg", rows: ["N", "Q", "A"],
    origin: { code: "KeyA", value: 0 }, x: 3, y: 4,
  }),
  // One degree per key, one period per row — the layout for LOW tunings, where
  // a single row would otherwise run through two octaves before it ran out of
  // keys. `y` is patched to the tuning's cardinality when it is applied.
  normaliseKeymap({
    name: "Octave rows", unit: "deg", rows: ["N", "Q", "A"],
    origin: { code: "KeyA", value: 0 }, x: 1, y: 12,
  }),
  // Every degree in order, rows continuing rather than overlapping: 30 (or 40)
  // consecutive degrees, which is how you reach ALL of a high TET at once.
  normaliseKeymap({
    name: "Chromatic run", unit: "deg", rows: ["N", "Q", "A"],
    origin: { code: "KeyA", value: 0 }, x: 1, y: 10,
  }),
  // The shipped layout for Shi’er lü, and the one unequal tuning among
  // them — hand-placed rather than generated, because its twelve degrees are
  // different sizes and no pair of steps describes a board worth playing. It
  // takes the bottom row, and leaves eight keys silent where the scale has
  // nothing to put under them. `notation` brings it up by itself whenever a
  // Shi’er lü song is opened.
  normaliseKeymap({
    name: "Shi'er lü (十二律)", unit: "deg", rows: ["N", "Q", "A", "Z"],
    origin: { code: "KeyA", value: 0 }, x: 0, y: 0,
    notation: 10123,
    overrides: {
      Digit1: null, Digit2: 1, Digit3: null, Digit4: 4, Digit5: 6, Digit6: 8, Digit7: null, Digit8: 11, Digit9: 13, Digit0: null,
      KeyQ: 0, KeyW: 2, KeyE: 3, KeyR: 5, KeyT: 7, KeyY: 9, KeyU: 10, KeyI: 12, KeyO: 14, KeyP: 15,
      KeyA: null, KeyS: -11, KeyD: null, KeyF: -8, KeyG: -6, KeyH: -4, KeyJ: null, KeyK: -1, KeyL: 1, Semicolon: null,
      KeyZ: -12, KeyX: -10, KeyC: -9, KeyV: -7, KeyB: -5, KeyN: -3, KeyM: -2, Comma: 0, Period: 2, Slash: 3,
    },
  }),
  normaliseKeymap({
    name: "Double-Deck Piano 24", unit: "deg", rows: ["N", "Q", "A", "Z"],
    origin: { code: "KeyA", value: 0 }, x: 0, y: 0,
    notation: 240,
    overrides: {
      Comma: 24, Digit0: 31, Digit1: null, Digit2: 3, Digit3: 7, Digit4: null, Digit5: 13, Digit6: 17, Digit7: 21, Digit8: null, Digit9: 27, KeyA: null, KeyB: 14, KeyC: 8, KeyD: 6, KeyE: 9, KeyF: null, KeyG: 12, KeyH: 16, KeyI: 25, KeyJ: 20, KeyK: null, KeyL: 26, KeyM: 22, KeyN: 18, KeyO: 29, KeyP: 33, KeyQ: 1, KeyR: 11, KeyS: 2, KeyT: 15, KeyU: 23, KeyV: 10, KeyW: 5, KeyX: 4, KeyY: 19, KeyZ: 0, Period: 28, Semicolon: 30, Slash: 32
    },
  }),
  normaliseKeymap({
    name: "Double-Deck Piano 12", unit: "deg", rows: ["N", "Q", "A", "Z"],
    origin: { code: "KeyA", value: 0 }, x: 0, y: 0,
    notation: 120,
    overrides: {
      Comma: 12, Digit0: 27, Digit1: null, Digit2: 13, Digit3: 15, Digit4: null, Digit5: 18, Digit6: 20, Digit7: 22, Digit8: null, Digit9: 25, KeyA: null, KeyB: 7, KeyC: 4, KeyD: 3, KeyE: 16, KeyF: null, KeyG: 6, KeyH: 8, KeyI: 24, KeyJ: 10, KeyK: null, KeyL: 13, KeyM: 11, KeyN: 9, KeyO: 26, KeyP: 28, KeyQ: 12, KeyR: 17, KeyS: 1, KeyT: 19, KeyU: 23, KeyV: 5, KeyW: 14, KeyX: 2, KeyY: 21, KeyZ: 0, Period: 14, Semicolon: 15, Slash: 16
    },
  }),
]);

/** Built-in named `name`, or null. Names are the library's identity. */
export function builtinKeymap(name) {
  return BUILTIN_KEYMAPS.find((k) => k.name === name) ?? null;
}

/** The default map — what a fresh install jams with. */
/**
 * The piano layout, by identity rather than by name — a saved layout the user
 * has called "Piano" is a different object and correctly is not this one.
 * Anything asking "are the letter keys still arranged as a piano?" (the note
 * column's hint, which names actual rows of keys) must ask for THIS, not for
 * DEFAULT_KEYMAP: the two happen to be the same layout today, but shipping a
 * different default must not turn that hint into a lie.
 */
export const PIANO_KEYMAP = BUILTIN_KEYMAPS[0];

/** What a fresh install jams with, before anyone has chosen anything. */
export const DEFAULT_KEYMAP = BUILTIN_KEYMAPS[0];

/**
 * "Octave rows" only means anything once a tuning is known, so applying it
 * patches `y` to that tuning's cardinality. Every other map is tuning-agnostic
 * and comes back untouched.
 */
export function fitKeymapToPreset(spec, preset) {
  if (spec?.name !== "Octave rows") return spec;
  const n = preset?.table?.length ?? 0;
  return n > 0 ? { ...spec, y: n } : spec;
}

// ── .taudkey (text) ──
//
// Text rather than binary, unlike .taudnot: a keymap has no device section
// behind it, it is a couple of dozen numbers, and people will want to paste one
// into a forum post or write one in a text editor. '!' comments follow Scala's
// .scl, which the notation importer already reads.

export const TAUDKEY_MAGIC = "TAUDKEY";
export const TAUDKEY_VERSION = 2;

/**
 * The oldest version that can read `s` correctly.
 *
 * Unknown directives are IGNORED by design, which is the right rule for a
 * cosmetic addition and the wrong one for `upper`: a split layout read without
 * its split is not a slightly different keyboard, it is the wrong keyboard on
 * twenty of its keys, silently. So a file says 2 only when it actually carries
 * a split, and everything else still writes — and still reads — as version 1.
 */
const versionFor = (s) => (s.upper !== 0 ? 2 : 1);

/** Serialise a spec. Round-trips through parseTaudkey unchanged. */
export function buildTaudkey(spec) {
  const s = normaliseKeymap(spec);
  const out = [
    "! Microtone keymap",
    `${TAUDKEY_MAGIC} ${versionFor(s)}`,
    `name      ${s.name}`,
    `unit      ${s.unit}`,
    `rows      ${s.rows.join(" ")}`,
    `origin    ${s.origin.code} ${fmt(s.origin.value)}`,
    `x         ${fmt(s.x)}`,
    `y         ${fmt(s.y)}`,
  ];
  if (s.upper !== 0) out.push(`upper     ${fmt(s.upper)}`);
  if (s.notation !== null) out.push(`notation  ${s.notation}`);
  const codes = Object.keys(s.overrides).sort();
  if (codes.length > 0) {
    out.push("! per-key overrides");
    for (const code of codes) {
      const v = s.overrides[code];
      out.push(`@${code} ${v === null ? OFF : fmt(v)}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Fractions survive the round trip (the Piano map's quarter-tone keys). */
const fmt = (v) => String(v);

/**
 * Parse .taudkey text. Throws with a human-readable message on malformed
 * input, in the style of parseScl (doc/notation.js). Unknown directives are
 * IGNORED rather than rejected, so a file written by a later version still
 * loads with the fields this one understands.
 */
export function parseTaudkey(text) {
  const lines = String(text).split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("!"));
  if (lines.length === 0) throw new Error("empty keymap file");
  const head = lines[0].split(/\s+/);
  if (head[0] !== TAUDKEY_MAGIC) throw new Error("not a keymap file (no TAUDKEY header)");
  const version = parseInt(head[1], 10);
  if (!Number.isFinite(version)) throw new Error("keymap header has no version");
  if (version > TAUDKEY_VERSION) throw new Error(`keymap version ${version} is newer than this build reads`);

  const spec = { overrides: {} };
  for (const line of lines.slice(1)) {
    if (line.startsWith("@")) {
      const [code, raw] = splitOnce(line.slice(1));
      if (!rowOfCode(code)) throw new Error(`override for unknown key "${code}"`);
      spec.overrides[code] = raw.toLowerCase() === OFF
        ? null
        : number(raw, `override ${code}`);
      continue;
    }
    const [key, rest] = splitOnce(line);
    switch (key) {
      case "name": spec.name = rest; break;
      case "unit":
        if (!UNITS.includes(rest)) throw new Error(`unknown unit "${rest}" (deg or semi)`);
        spec.unit = rest;
        break;
      case "rows": {
        const rows = rest.split(/\s+/).filter(Boolean);
        for (const r of rows) if (!(r in ROW_CODES)) throw new Error(`unknown row "${r}"`);
        if (rows.length === 0) throw new Error("rows line names no rows");
        spec.rows = rows;
        break;
      }
      case "origin": {
        const [code, value] = splitOnce(rest);
        if (!rowOfCode(code)) throw new Error(`origin names unknown key "${code}"`);
        spec.origin = { code, value: value === "" ? 0 : number(value, "origin") };
        break;
      }
      case "x": spec.x = number(rest, "x"); break;
      case "y": spec.y = number(rest, "y"); break;
      case "upper": spec.upper = number(rest, "upper"); break;
      case "notation": spec.notation = number(rest, "notation"); break;
      default: break; // forwards compatibility
    }
  }
  return normaliseKeymap(spec);
}

/** First token and the rest of the line, both trimmed. */
function splitOnce(line) {
  const i = line.search(/\s/);
  return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1).trim()];
}

function number(raw, what) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) throw new Error(`bad number "${raw}" on ${what}`);
  return v;
}
