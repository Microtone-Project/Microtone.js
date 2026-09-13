// Pitch-table presets — data port of taut.js pitchTablePresets (taut.js:219-281).
// `table` entries are 4096-TET offsets within one `interval` (0x1000 = octave;
// Bohlen-Pierce uses a tritave). The preset index doubles as the sMet
// `notation` field, so a song's active tuning comes from its metadata.
//
// `interval: 0` is the spec's second mode (terranmon.txt §nota): "If you are
// not using an interval system (which means you are responsible for defining
// every note expressible), this must be 0". Such a preset is ABSOLUTE — the
// table is a finite ascending list of every note the notation can express,
// offset from `base` (default ANCHOR_NOTE), with no repeating lattice. It
// exists for grids that are not octave-periodic at all; ProTracker pitch is
// the built-in example.
//
// `sym` carries one 3-char token per degree, transcribed from taut's custom-
// font sym strings into a compact DSL rendered by src/ui/glyphs.js:
//   [0] tick:   ' ' none · '.' Kite big-dot · 'u'/'d' up/down tick ·
//               'U'/'D' double up/down tick
//   [1] letter: A-J note letter (H/J are Bohlen-Pierce)
//   [2] accidental: '-' natural · '#' sharp · 'b' flat · 't' demisharp ·
//               'p' demiflat · 'x' double sharp · 'B' double flat ·
//               '3' triple sharp · 'T' triple flat · '4' quadruple sharp
// Shi'er lü uses single CJK tokens rendered with a conventional font.

import { MIDDLE_C } from "../engine/constants.js";

export const ANCHOR_NOTE = 0x5000; // C4 — fixed reference for all periods

const SYM_12 = [" C-", " C#", " D-", " D#", " E-", " F-", " F#", " G-", " G#", " A-", " A#", " B-"];
const SYM_24 = [" C-", " Ct", " C#", " Dp", " D-", " Dt", " D#", " Ep", " E-", " Et", " F-", " Ft",
                " F#", " Gp", " G-", " Gt", " G#", " Ap", " A-", " At", " A#", " Bp", " B-", " Bt"];
// 96-TET (Kite): per 24-TET degree emit [big-dot, up, double-up, down-of-next].
const SYM_96 = (() => {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const cur = SYM_24[i].slice(1);
    const nxt = SYM_24[(i + 1) % 24].slice(1);
    out.push("." + cur, "u" + cur, "U" + cur, "d" + nxt);
  }
  return out;
})();

// ── ProTracker pitch (notation index 1) ──
// The Amiga's grid is hardware-first: Paula divides a reference clock by an
// integer period counter, so ProTracker ships a fixed TABLE of periods rather
// than a tuning formula — period = round(3579545 / (32 × freq)), which
// reproduces PT's middle octave exactly. Integer rounding then makes that
// table only APPROXIMATELY octave-periodic: E-3 is 170, not 339/2 = 169.5, so
// it sounds 5.3 cents flat against its own octave (likewise D-3, G-3, G#3 and
// B-1). No single period of a repeating lattice can express that — hence
// `interval: 0`, the table below listing every PT note outright.
//
// Octaves 1-3 are ProTracker's own table verbatim. Octaves 0 and 4 are the
// de-facto extension used by FT2/OpenMPT and PT clones — NOT in ProTracker's
// source (PT itself clamps periods to 113..856), included so .mods written in
// modern trackers stay on-grid.
const PT_PERIODS = [
  1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 907, // oct 0 (ext)
   856,  808,  762,  720,  678,  640,  604,  570,  538,  508, 480, 453, // oct 1
   428,  404,  381,  360,  339,  320,  302,  285,  269,  254, 240, 226, // oct 2
   214,  202,  190,  180,  170,  160,  151,  143,  135,  127, 120, 113, // oct 3
   107,  101,   95,   90,   85,   80,   75,   71,   67,   63,  60,  56, // oct 4 (ext)
];
// mod2taud anchors PT period 428 (PT's own "C-2") to Taud C4, so a period's
// pitch is 4096·log2(428/period) from C4. The base is the lowest note: period
// 1712 = 4×428, i.e. EXACTLY two octaves below C4, which keeps every offset
// unsigned with table[0] = 0 — the shape the nota spec's Uint16 table wants.
const PT_REFERENCE_PERIOD = 428;
const PT_BASE = ANCHOR_NOTE - 2 * 0x1000; // 0x3000 ≡ period 1712
const ptNoteFor = (period) =>
  Math.round(ANCHOR_NOTE + 4096 * Math.log2(PT_REFERENCE_PERIOD / period));

export const pitchTablePresets = {
  0: { index: 0, name: "Raw format", table: [], interval: 0x1000, t: "" },
  1: {
    index: 1, name: "ProTracker Temperament", interval: 0, base: PT_BASE, t: "d",
    table: PT_PERIODS.map((p) => ptNoteFor(p) - PT_BASE),
    sym: PT_PERIODS.map((_, i) => SYM_12[i % 12]),
  },
  10: { index: 10, name: "Octave only", table: [0x0], interval: 0x1000, t: "M", sym: [" C-"] },
  20: { index: 20, name: "2-TET", table: [0x0, 0x800], interval: 0x1000, t: "M", sym: [" C-", " F#"] },
  30: { index: 30, name: "3-TET", table: [0x0, 0x555, 0xaab], interval: 0x1000, t: "M", sym: [" C-", " E-", " G#"] },
  40: { index: 40, name: "4-TET", table: [0x0, 0x400, 0x800, 0xc00], interval: 0x1000, t: "M", sym: [" C-", " D#", " F#", " A-"] },
  50: { index: 50, name: "5-TET", table: [0x0, 0x333, 0x666, 0x99a, 0xccd], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " G-", " A-"] },
  60: { index: 60, name: "6-TET", table: [0x0, 0x2ab, 0x555, 0x800, 0xaab, 0xd55], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " F#", " G#", " A#"] },
  70: { index: 70, name: "7-TET", table: [0x0, 0x249, 0x492, 0x6db, 0x925, 0xb6e, 0xdb7], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " F-", " G-", " A-", " B-"] },
  80: { index: 80, name: "8-TET", table: [0x0, 0x200, 0x400, 0x600, 0x800, 0xa00, 0xc00, 0xe00], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " F-", " F#", " G#", " A-", " B-"] },
  90: { index: 90, name: "9-TET", table: [0x0, 0x1c7, 0x38e, 0x555, 0x71c, 0x8e4, 0xaab, 0xc72, 0xe39], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " E#", " F-", " G-", " A-", " B-", " B#"] },
  100: { index: 100, name: "10-TET", table: [0x0, 0x19a, 0x333, 0x4cd, 0x666, 0x800, 0x99a, 0xb33, 0xccd, 0xe66], interval: 0x1000, t: "M", sym: [" C-", " Db", " D-", " Eb", " E-", " E#", " G-", " G#", " A-", " A#"] },
  120: { index: 120, name: "12-TET", table: [0x0, 0x155, 0x2ab, 0x400, 0x555, 0x6ab, 0x800, 0x955, 0xaab, 0xc00, 0xd55, 0xeab], interval: 0x1000, t: "d", sym: SYM_12 },
  150: { index: 150, name: "15-TET", table: [0x0, 0x111, 0x222, 0x333, 0x444, 0x555, 0x666, 0x777, 0x889, 0x99a, 0xaab, 0xbbc, 0xccd, 0xdde, 0xeef], interval: 0x1000, t: "m", sym: [" C-", " C#", " Db", " D-", " Eb", " E-", " F", " F#", " Gb", " G-", " Ab", " A-", " Bb", " Bp", " B-"] },
  160: { index: 160, name: "16-TET", table: [0x0, 0x100, 0x200, 0x300, 0x400, 0x500, 0x600, 0x700, 0x800, 0x900, 0xa00, 0xb00, 0xc00, 0xd00, 0xe00, 0xf00], interval: 0x1000, t: "m", sym: [" C-", " C#", " Db", " D-", " Eb", " E-", " Fb", " F-", " F#", " G-", " G#", " Ab", " A-", " Bb", " Bp", " B-"] },
  170: { index: 170, name: "17-TET", table: [0x0, 0xf1, 0x1e2, 0x2d3, 0x3c4, 0x4b5, 0x5a6, 0x697, 0x788, 0x878, 0x969, 0xa5a, 0xb4b, 0xc3c, 0xd2d, 0xe1e, 0xf0f], interval: 0x1000, t: "m", sym: [" C-", " Db", " C#", " D-", " Eb", " D#", " E-", " F-", " Gb", " F#", " G-", " Ab", " G#", " A-", " Bb", " A#", " B-"] },
  190: { index: 190, name: "19-TET", table: [0x0, 0xd8, 0x1af, 0x287, 0x35e, 0x436, 0x50d, 0x5e5, 0x6bd, 0x794, 0x86c, 0x943, 0xa1b, 0xaf3, 0xbca, 0xca2, 0xd79, 0xe51, 0xf28], interval: 0x1000, t: "m", sym: [" C-", " C#", " Db", " D-", " D#", " Eb", " E-", " E#", " F-", " F#", " Gb", " G-", " G#", " Ab", " A-", " A#", " Bb", " B-", " B#"] },
  220: { index: 220, name: "22-TET", table: [0x0, 0xba, 0x174, 0x22f, 0x2e9, 0x3a3, 0x45d, 0x517, 0x5d1, 0x68c, 0x746, 0x800, 0x8ba, 0x974, 0xa2f, 0xae9, 0xba3, 0xc5d, 0xd17, 0xdd1, 0xe8c, 0xf46], interval: 0x1000, t: "m", sym: [" C-", " Ct", " C#", " Dp", " D-", " Dt", " D#", " Ep", " E-", " F-", " Ft", " F#", " Gp", " G-", " Gt", " G#", " Ap", " A-", " At", " A#", " Bp", " B-"] },
  240: { index: 240, name: "24-TET", table: [0x0, 0xab, 0x155, 0x200, 0x2ab, 0x355, 0x400, 0x4ab, 0x555, 0x600, 0x6ab, 0x755, 0x800, 0x8ab, 0x955, 0xa00, 0xaab, 0xb55, 0xc00, 0xcab, 0xd55, 0xe00, 0xeab, 0xf55], interval: 0x1000, t: "m", sym: SYM_24 },
  310: { index: 310, name: "31-TET", table: [0x0, 0x84, 0x108, 0x18c, 0x211, 0x295, 0x319, 0x39d, 0x421, 0x4a5, 0x529, 0x5ad, 0x632, 0x6b6, 0x73a, 0x7be, 0x842, 0x8c6, 0x94a, 0x9ce, 0xa53, 0xad7, 0xb5b, 0xbdf, 0xc63, 0xce7, 0xd6b, 0xdef, 0xe74, 0xef8, 0xf7c], interval: 0x1000, t: "m", sym: [" C-", " Ct", " C#", " Db", " Dp", " D-", " Dt", " D#", " Eb", " Ep", " E-", " Et", " Fp", " F-", " Ft", " F#", " Gb", " Gp", " G-", " Gt", " G#", " Ab", " Ap", " A-", " At", " A#", " Bb", " Bp", " B-", " Bt", " Cp"] },
  410: { index: 410, name: "41-TET (Kite)", table: [0x0, 0x64, 0xc8, 0x12c, 0x190, 0x1f4, 0x257, 0x2bb, 0x31f, 0x383, 0x3e7, 0x44b, 0x4af, 0x513, 0x577, 0x5db, 0x63e, 0x6a2, 0x706, 0x76a, 0x7ce, 0x832, 0x896, 0x8fa, 0x95e, 0x9c2, 0xa25, 0xa89, 0xaed, 0xb51, 0xbb5, 0xc19, 0xc7d, 0xce1, 0xd45, 0xda9, 0xe0c, 0xe70, 0xed4, 0xf38, 0xf9c], interval: 0x1000, t: "m", sym: [".C-", "uC-", "DC#", "dC#", ".C#", "uC#", "dD-", ".D-", "uD-", "DD#", "dD#", ".D#", "uD#", "dE-", ".E-", "uE-", "UE-", ".F-", "uF-", "DF#", "dF#", ".F#", "uF#", "dG-", ".G-", "uG-", "DG#", "dG#", ".G#", "uG#", "dA-", ".A-", "uA-", "DA#", "dA#", ".A#", "uA#", "dB-", ".B-", "uB-", "UB-"] },
  530: { index: 530, name: "53-TET (Kite)", table: [0x0, 0x4d, 0x9b, 0xe8, 0x135, 0x182, 0x1d0, 0x21d, 0x26a, 0x2b8, 0x305, 0x352, 0x39f, 0x3ed, 0x43a, 0x487, 0x4d5, 0x522, 0x56f, 0x5bc, 0x60a, 0x657, 0x6a4, 0x6f2, 0x73f, 0x78c, 0x7d9, 0x827, 0x874, 0x8c1, 0x90e, 0x95c, 0x9a9, 0x9f6, 0xa44, 0xa91, 0xade, 0xb2b, 0xb79, 0xbc6, 0xc13, 0xc61, 0xcae, 0xcfb, 0xd48, 0xd96, 0xde3, 0xe30, 0xe7e, 0xecb, 0xf18, 0xf65, 0xfb3], interval: 0x1000, t: "m", sym: [".C-", "uC-", "UC-", "DC#", "dC#", ".C#", "uC#", "DD-", "dD-", ".D-", "uD-", "UD-", "DD#", "dD#", ".D#", "uD#", "DE-", "dE-", ".E-", "uE-", "UE-", "dF-", ".F-", "uF-", "UF-", "DF#", "dF#", ".F#", "uF#", "DG-", "dG-", ".G-", "uG-", "UG-", "DG#", "dG#", ".G#", "uG#", "DA-", "dA-", ".A-", "uA-", "UA-", "DA#", "dA#", ".A#", "uA#", "DB-", "dB-", ".B-", "uB-", "UB-", "dC-"] },
  531: { index: 531, name: "53-TET (Pythagorean)", table: [0x0, 0x4d, 0x9b, 0xe8, 0x135, 0x182, 0x1d0, 0x21d, 0x26a, 0x2b8, 0x305, 0x352, 0x39f, 0x3ed, 0x43a, 0x487, 0x4d5, 0x522, 0x56f, 0x5bc, 0x60a, 0x657, 0x6a4, 0x6f2, 0x73f, 0x78c, 0x7d9, 0x827, 0x874, 0x8c1, 0x90e, 0x95c, 0x9a9, 0x9f6, 0xa44, 0xa91, 0xade, 0xb2b, 0xb79, 0xbc6, 0xc13, 0xc61, 0xcae, 0xcfb, 0xd48, 0xd96, 0xde3, 0xe30, 0xe7e, 0xecb, 0xf18, 0xf65, 0xfb3], interval: 0x1000, t: "m", sym: [" C-", " B#", " A3", " ET", " Db", " C#", " Bx", " FT", " EB", " D-", " Cx", " B3", " FB", " Eb", " D#", " C3", " GT", " Fb", " E-", " Dx", " C4", " GB", " F-", " E#", " D3", " AT", " Gb", " F#", " Ex", " D4", " AB", " G-", " Fx", " E3", " BT", " Ab", " G#", " F3", " CT", " BB", " A-", " Gx", " F4", " CB", " Bb", " A#", " G3", " DT", " Cb", " B-", " Ax", " G4", " DB"] },
  960: { index: 960, name: "96-TET (Kite)", table: (() => { const t = []; for (let i = 0; i < 96; i++) t.push(Math.round((i * 0x1000) / 96)); return t; })(), interval: 0x1000, t: "m", sym: SYM_96 },
  10121: { index: 10121, name: "Pythagorean dim. 5th", table: [0x0, 0x134, 0x2b8, 0x3ec, 0x570, 0x6a4, 0x7d8, 0x95c, 0xa90, 0xc14, 0xd48, 0xecc], interval: 0x1000, t: "d", sym: SYM_12 },
  10122: { index: 10122, name: "Pythagorean aug. 4th", table: [0x0, 0x134, 0x2b8, 0x3ec, 0x570, 0x6a4, 0x828, 0x95c, 0xa90, 0xc14, 0xd48, 0xecc], interval: 0x1000, t: "d", sym: SYM_12 },
  10123: { index: 10123, name: "Shi'er lü", table: [0x0, 0x184, 0x2b8, 0x43c, 0x570, 0x6f4, 0x828, 0x95c, 0xae0, 0xc14, 0xd98, 0xecc], interval: 0x1000, t: "d", sym: ["\u9EC3", "\u5927", "\u592A", "\u593E", "\u59D1", "\u4EF2", "\u8564", "\u6797", "\u5937", "\u5357", "\u7121", "\u61C9"] },
  35130: { index: 35130, name: "Equal-Tempered Bohlen-Pierce", table: [0x0, 0x1f3, 0x3e7, 0x5da, 0x7ce, 0x9c1, 0xbb4, 0xda8, 0xf9b, 0x118e, 0x1382, 0x1575, 0x1769], interval: 0x195c, t: "M", sym: [" C-", " C#", " D-", " E-", " F-", " F#", " G-", " H-", " H#", " J-", " A-", " A#", " B-"] },
};

/** True for an `interval: 0` preset: `table` is the complete, absolute note
 *  list rather than one period of a lattice (terranmon.txt §nota). */
export function isAbsolute(preset) {
  return preset?.interval === 0 && preset.table.length > 0;
}

/** Snap a note word to the nearest degree an absolute (`interval: 0`) preset
 *  can express. The table IS the full expressible range, so this clamps to the
 *  ends rather than wrapping — the same semantics as stepNoteInTable. */
export function snapToAbsoluteDegree(note, preset) {
  const i = nearestAbsIndex(note, preset);
  return Math.min(Math.max(presetBase(preset) + preset.table[i], 0x20), 0xffff);
}

/** Note that an absolute preset's degree `i` names. Interval presets are
 *  implicitly based at ANCHOR_NOTE; an absolute one may sit lower (ProTracker
 *  starts two octaves below C4) so it can keep its offsets unsigned. */
function presetBase(preset) {
  return preset?.base ?? ANCHOR_NOTE;
}

/** Index of the degree nearest `note` in an absolute preset. */
function nearestAbsIndex(note, preset) {
  const base = presetBase(preset), table = preset.table;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(base + table[i] - note);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Octave digit for an absolute preset. There is no period index to count, so
 *  the digit follows the 12-TET octave the pitch actually falls in — for
 *  ProTracker that maps each PT octave onto exactly one digit (oct0..4 → 2..6). */
function absOctave(note) {
  return 4 + Math.floor((note - ANCHOR_NOTE) / 0x1000);
}

/** Preset for an sMet notation value; unknown/absent → 12-TET. Values in the
 *  custom range (65520..65535) resolve against `doc`'s "nota" section when a
 *  document is given (item 61 Notation Maker). */
export function presetForNotation(notation, doc = null) {
  if (doc && notation >= 0xfff0) {
    const p = doc.customPreset?.(notation);
    if (p) return p;
  }
  return pitchTablePresets[notation] ?? pitchTablePresets[120];
}

/**
 * Degree label for a non-12 preset: base-36 degree + octave (period) digit,
 * or null when the note is off-grid (> ±2 units) — caller falls back to the
 * 12-EDO name with a cents marker.
 */
export function noteDegreeLabel(note, preset) {
  if (!preset || preset.index === 120 || preset.table.length === 0) return null;
  if (isAbsolute(preset)) {
    const octave = absOctave(note);
    if (octave < 0 || octave > 9) return null;
    return nearestAbsIndex(note, preset).toString(36).toUpperCase().padStart(2, "0") + octave;
  }
  const rel = note - ANCHOR_NOTE;
  const k = Math.floor(rel / preset.interval);
  const inPeriod = rel - k * preset.interval;
  let best = -1, bestD = 3;
  for (let i = 0; i < preset.table.length; i++) {
    const d = Math.abs(preset.table[i] - inPeriod);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  const octave = 4 + k;
  if (octave < 0 || octave > 9) return null;
  return best.toString(36).toUpperCase().padStart(2, "0") + octave;
}

/**
 * Which degree of `preset` a note sits on, wrap-aware and with no tolerance
 * gate: `{index, period}` where index is 0..table.length-1 and period counts
 * whole intervals from C4 (so the note is period·interval + table[index], give
 * or take the rounding that put it off the grid). Unlike noteDegreeLabel this
 * never returns null for an off-grid note — it answers "nearest", which is what
 * a keymap needs to colour a key by its degree and to count coverage.
 * Absolute tables report period 0, since they have no lattice to count.
 */
export function nearestDegreeIndex(note, preset) {
  if (!preset || preset.table.length === 0) return { index: 0, period: 0 };
  if (isAbsolute(preset)) return { index: nearestAbsIndex(note, preset), period: 0 };
  const table = preset.table;
  const rel = note - ANCHOR_NOTE;
  let period = Math.floor(rel / preset.interval);
  const inPeriod = rel - period * preset.interval;
  let index = 0, bestD = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - inPeriod);
    if (d < bestD) { bestD = d; index = i; }
  }
  // The next period's root can be nearer than the top entry of this one.
  if (preset.interval - inPeriod < bestD) { index = 0; period += 1; }
  return { index, period };
}

/** How far off a degree (in 4096-TET units) a note may sit and still read as in
 *  tune. Beyond this it paints yellow, and surveyTuning counts it out of tune —
 *  one constant so the warning can never disagree with what the user sees. */
export const OFF_GRID_TOL = 2;

/**
 * Resolve a playable note against a preset's symbol table. Always snaps to
 * the NEAREST degree (wrap-aware); notes farther than ±OFF_GRID_TOL units off
 * the grid carry offGrid: true — "out of tune", painted yellow by the painter.
 * Returns null only when the preset has no syms (Raw) or the period is out
 * of display range; else
 *   {cjk, octave, offGrid}              for Shi'er lü tokens, or
 *   {tick, letter, acc, octave, offGrid} decoded from the 3-char token DSL.
 */
export function resolveNoteSymbol(note, preset) {
  if (!preset || !preset.sym || preset.table.length === 0) return null;
  let best, bestD, octave;
  if (isAbsolute(preset)) {
    best = nearestAbsIndex(note, preset);
    bestD = Math.abs(presetBase(preset) + preset.table[best] - note);
    octave = absOctave(note);
  } else {
    const rel = note - ANCHOR_NOTE;
    let k = Math.floor(rel / preset.interval);
    const inPeriod = rel - k * preset.interval;
    best = 0; bestD = Infinity;
    for (let i = 0; i < preset.table.length; i++) {
      const d = Math.abs(preset.table[i] - inPeriod);
      if (d < bestD) { bestD = d; best = i; }
    }
    // The next period's root may be closer than the top table entry.
    if (preset.interval - inPeriod < bestD) {
      bestD = preset.interval - inPeriod;
      best = 0;
      k += 1;
    }
    octave = 4 + k;
  }
  if (octave < 0 || octave > 9) return null;
  const offGrid = bestD > OFF_GRID_TOL;
  const token = preset.sym[best];
  if (token.length === 1) return { cjk: token, octave, offGrid };
  return { tick: token[0], letter: token[1], acc: token[2], octave, offGrid };
}

/** 12-EDO note word for semitone offset from C at `octave` (C4 = MIDDLE_C). */
export function semiToNote(octave, semi) {
  const val = MIDDLE_C + (octave - 4) * 4096 + Math.round((semi * 4096) / 12);
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/**
 * Notation-aware jam note: map a 12-EDO semitone (-0.5..16 across the two jam
 * rows) to a note word in the active pitch table by snapping the semitone's
 * fractional period position to the NEAREST table degree — the port of taut.js
 * semitoneToNote. So a non-12-TET song's keyboard plays that tuning's degrees
 * (CDEFGAB… mapped into its grid) instead of fixed 12-EDO. The Raw preset
 * (empty table) and 12-TET fall back to the exact 12-EDO note.
 *
 * This is what a `semi`-unit keymap resolves through (keymap.js); a `deg`-unit
 * one goes to noteForDegree below instead, which is the difference between a
 * keyboard that APPROXIMATES a tuning and one that plays its actual degrees.
 */
export function semiToNoteInTable(octave, semi, preset) {
  if (!preset || preset.table.length === 0 || preset.index === 120) {
    return semiToNote(octave, semi);
  }
  // An absolute (`interval: 0`) table — e.g. ProTracker pitch — has no period
  // lattice, so the period-wrap loop below would spin forever (pos -= 0). Map
  // the jam key to its 12-EDO pitch and snap to the nearest expressible degree.
  if (isAbsolute(preset)) {
    return snapToAbsoluteDegree(semiToNote(octave, semi), preset);
  }
  const interval = preset.interval;
  const table = preset.table;
  let pos = Math.round((semi / 12) * interval);
  let carry = 0;
  while (pos >= interval) { pos -= interval; carry++; } // semitone 12 wraps to next period root
  while (pos < 0) { pos += interval; carry--; }         // q (semitone -0.5) borrows from the period below
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - pos);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  // The next period's root (one interval up) can be the true nearest degree.
  let off = table[bestIdx], periodAdj = carry;
  if (interval - pos < bestDist) { off = table[0]; periodAdj = carry + 1; }
  const val = MIDDLE_C + (octave - 4) * interval + periodAdj * interval + off;
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/**
 * Note word for degree `d` of `preset` at `octave` — the resolution an
 * isomorphic keymap needs, and the reason one integer per key is enough.
 *
 * `d` is unbounded in both directions: it wraps through periods by floor
 * division, so degree 41 of 41-TET is the period root an octave up and degree
 * -1 is the top degree of the period below. That is what lets a single spec
 * ("one degree per key, six per row") work on 5-TET and 96-TET alike, with no
 * per-tuning special-casing — the tuning's own cardinality does the wrapping.
 *
 * An absolute table (`interval: 0`, e.g. ProTracker pitch) has no lattice to
 * wrap through: it is a finite list of every note the notation can express, so
 * the degree indexes it directly and CLAMPS at both ends, exactly as
 * stepNoteInTable does. `octave` shifts it by whole octaves of pitch first,
 * then the result re-snaps onto the nearest expressible note.
 */
export function noteForDegree(octave, d, preset) {
  if (!preset || preset.table.length === 0) {
    // Raw (no table): a degree is one 4096-TET unit, anchored at the octave.
    return Math.min(Math.max(MIDDLE_C + (octave - 4) * 0x1000 + d, 0x20), 0xffff);
  }
  const table = preset.table;
  if (isAbsolute(preset)) {
    const i = Math.min(Math.max(d, 0), table.length - 1);
    const val = presetBase(preset) + table[i] + (octave - 4) * 0x1000;
    return snapToAbsoluteDegree(Math.min(Math.max(val, 0x20), 0xffff), preset);
  }
  const n = table.length;
  const period = Math.floor(d / n);
  const idx = d - period * n; // floored modulo: always 0..n-1
  const val = MIDDLE_C + (octave - 4) * preset.interval + period * preset.interval + table[idx];
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/**
 * Step a note by `dir` (±1) degrees of the active pitch table: snap to the
 * nearest degree, then move one table entry, wrapping across periods.
 * 12-TET steps a semitone, 24-TET a quarter-tone, etc. The Raw preset
 * (empty table) steps one raw 4096-TET unit.
 */
export function stepNoteInTable(note, preset, dir) {
  if (!preset || preset.table.length === 0) {
    return Math.min(Math.max(note + dir, 0x20), 0xffff);
  }
  if (isAbsolute(preset)) {
    // An absolute table is finite: its ends ARE the highest and lowest notes
    // the notation can express, so stepping clamps rather than wrapping.
    const i = Math.min(Math.max(nearestAbsIndex(note, preset) + dir, 0),
                       preset.table.length - 1);
    return Math.min(Math.max(presetBase(preset) + preset.table[i], 0x20), 0xffff);
  }
  const table = preset.table;
  const rel = note - ANCHOR_NOTE;
  let k = Math.floor(rel / preset.interval);
  const inPeriod = rel - k * preset.interval;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - inPeriod);
    if (d < bestD) { bestD = d; best = i; }
  }
  let i = best + dir;
  if (i < 0) { k--; i = table.length - 1; }
  else if (i >= table.length) { k++; i = 0; }
  const out = ANCHOR_NOTE + k * preset.interval + table[i];
  return Math.min(Math.max(out, 0x20), 0xffff);
}

/**
 * Every note of `preset` that could plausibly be the nearest to `absRef`: the
 * table over the surrounding three periods, plus each period's root. Shared by
 * the retune snap and the tuning survey so they can't disagree about what
 * "nearest" means.
 */
function eachCandidate(preset, absRef, fn) {
  const { table, interval } = preset;
  if (isAbsolute(preset)) {
    // No lattice to walk: the whole table is the candidate set.
    const base = presetBase(preset);
    for (let i = 0; i < table.length; i++) {
      const cand = base + table[i];
      if (cand >= 0 && cand <= 0xffff) fn(cand);
    }
    return;
  }
  const baseK = Math.floor((absRef - ANCHOR_NOTE) / interval);
  for (let dK = -1; dK <= 1; dK++) {
    const root = ANCHOR_NOTE + (baseK + dK) * interval;
    for (let i = 0; i < table.length; i++) {
      const cand = root + table[i];
      if (cand >= 0 && cand <= 0xffff) fn(cand);
    }
    const nextRoot = root + interval;
    if (nextRoot >= 0 && nextRoot <= 0xffff) fn(nextRoot);
  }
}

/** Distance from `note` to the nearest degree of `preset`; 0 = exactly on it. */
function gridDistance(note, preset) {
  let best = Infinity;
  eachCandidate(preset, note, (cand) => {
    const d = Math.abs(cand - note);
    if (d < best) best = d;
  });
  return best;
}

/**
 * SIGNED distance from `note` to the nearest degree of `preset`, in 4096-TET
 * units — positive means the note sits sharp of the degree the glyph painter
 * names it by. Raw (no table) has no grid to be off, so it reads 0. Used by
 * the chord maker (item 89) to say how far a just interval lands from the
 * notation's own nearest degree.
 */
export function gridDelta(note, preset) {
  if (!preset || preset.table.length === 0) return 0;
  let best = 0, bestAbs = Infinity;
  eachCandidate(preset, note, (cand) => {
    const d = note - cand;
    if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); best = d; }
  });
  return best;
}

/**
 * Survey how a song's notes sit on `preset`'s grid (item 73). Uses exactly the
 * skip rules of retuneAllPatterns (sentinels < 0x20, percussion by running
 * instrument), so the counts describe the same notes a retune would touch:
 *   total       notes a retune would consider;
 *   offGrid     notes the Timeline paints yellow as out of tune (> OFF_GRID_TOL
 *               from any degree) — the ones a .mod's period table produces;
 *   wouldChange notes a nearest-pitch retune onto this same table would rewrite.
 * A song with wouldChange > 0 has a real snap-to-grid cleanup available; the
 * two differ because a note ≤ OFF_GRID_TOL off still reads as in tune but is
 * not exactly on a degree.
 */
export function surveyTuning(song, preset, percSlots) {
  const out = { total: 0, offGrid: 0, wouldChange: 0 };
  if (!preset || preset.table.length === 0) return out; // Raw: no grid to be off
  for (const ptn of song.patterns) {
    if (!ptn) continue; // null gap (item 48)
    let runningInst = 0;
    for (const cell of ptn) {
      if (cell.instrment !== 0) runningInst = cell.instrment;
      const note = cell.note;
      if (note >= 0x0000 && note <= 0x001f) continue; // sentinels/interrupts
      const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
      if (percSlots && eInst >= 1 && percSlots[eInst]) continue;
      out.total++;
      const d = gridDistance(note, preset);
      if (d > OFF_GRID_TOL) out.offGrid++;
      if (d !== 0) out.wouldChange++;
    }
  }
  return out;
}

// ── retune tension / harmonic fields (taut.js:340-489) ──
const FIFTH_PC = 0x95a;   // abstract 3:2 fifth in 0x1000-per-octave units
const TONIC_TOL = 0x40;   // narrow tonic neighbourhood for the k=0 tension gate

/** Fifth-circle tonal tension of pitch `p` relative to `tonic` ('cadence'). */
function cadTension(p, tonic, interval) {
  const half = interval >>> 1;
  const d = (((p - tonic) % interval) + interval) % interval;
  const cyclic = d <= half ? d : interval - d;
  let bestT = cyclic <= TONIC_TOL ? cyclic : Infinity;
  for (let k = -6; k <= 6; k++) {
    if (k === 0) continue;
    const target = (((k * FIFTH_PC) % interval) + interval) % interval;
    let dist = Math.abs(d - target);
    if (dist > half) dist = interval - dist;
    const candT = Math.abs(k) * 0x100 + dist;
    if (candT < bestT) bestT = candT;
  }
  return bestT;
}

// Just-intonation attractor field A(P) for the 'harmonic' method: [offset, weight].
const HARM_REFS = [
  [0x0, 1.0], [0x1d2, 4.0], [0x435, 3.0], [0x527, 3.0], [0x6a4, 2.0],
  [0x95b, 2.0], [0xab7, 3.0], [0xbcb, 3.0], [0xd3d, 4.0],
];
function harmonicCost(p, tonic, interval) {
  const half = interval >>> 1;
  const d = (((p - tonic) % interval) + interval) % interval;
  let best = Infinity;
  for (const [off, w] of HARM_REFS) {
    let dist = Math.abs(d - off);
    if (dist > half) dist = interval - dist;
    const cost = w * dist;
    if (cost < best) best = cost;
  }
  return best;
}

/**
 * Retune every pattern note in `song` from `srcPreset` to `newPreset` — the
 * four methods of taut.js retuneAllPatterns (taut.js:522+), ported verbatim:
 *   'pitch'    nearest-note: snap each pitch to the closest new-table entry.
 *   'delta'    nearest-delta: first note nearest-pitch; each later note keeps
 *              the interval from the previous mapped note closest to the
 *              original interval ("preserve the melody's shape").
 *   'cadence'  nearest-cadence: like delta, but scored by how well the mapped
 *              step reproduces the tonal-tension change of the source step.
 *   'harmonic' cadence-aware nearest-harmonic: delta + a duration-weighted
 *              pull toward JI attractors (long notes pull harder).
 * Percussion notes are skipped via percSlots (inst byte14 bit4 / meta byte0
 * bit1). Mutates cells; returns [{pat, row, prev}] for the inverse.
 */
export function retuneAllPatterns(song, newPreset, srcPreset, percSlots, method = "pitch") {
  if (method !== "delta" && method !== "cadence" && method !== "harmonic") method = "pitch";
  const newTable = newPreset.table;
  if (newTable.length === 0) return [];
  // Tension/harmonic shapes are read from the SOURCE tuning's modular space —
  // they describe the composition the user wrote, not the snap grid.
  const srcInterval = srcPreset?.interval || 0x1000;

  const forEachCandidate = (absRef, fn) => eachCandidate(newPreset, absRef, fn);

  const changes = [];
  for (let p = 0; p < song.patterns.length; p++) {
    const ptn = song.patterns[p];
    if (!ptn) continue; // null gap: an arbitrary-numbered pattern (item 48)
    let prevOrigAbs = -1, prevMappedAbs = 0, tonic = 0;

    // Tonic = the first non-percussion, non-sentinel note in the pattern.
    if (method === "cadence" || method === "harmonic") {
      let runningInst = 0;
      for (let row = 0; row < ptn.length; row++) {
        const cell = ptn[row];
        if (cell.instrment !== 0) runningInst = cell.instrment;
        const note = cell.note;
        if (note >= 0x0000 && note <= 0x001f) continue;
        const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
        if (percSlots && eInst >= 1 && percSlots[eInst]) continue;
        tonic = note;
        break;
      }
    }

    let runningInst = 0;
    for (let row = 0; row < ptn.length; row++) {
      const cell = ptn[row];
      if (cell.instrment !== 0) runningInst = cell.instrment;
      const note = cell.note;
      if (note >= 0x0000 && note <= 0x001f) continue; // sentinels/interrupts
      const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
      if (percSlots && eInst >= 1 && percSlots[eInst]) continue;
      const origAbs = note;
      let newAbs;

      if ((method === "delta" || method === "cadence" || method === "harmonic") && prevOrigAbs >= 0) {
        const targetAbs = prevMappedAbs + (origAbs - prevOrigAbs);
        let targetDeltaT = 0, tMappedPrev = 0, lambda = 0;
        if (method === "cadence") {
          targetDeltaT = cadTension(origAbs, tonic, srcInterval) - cadTension(prevOrigAbs, tonic, srcInterval);
          tMappedPrev = cadTension(prevMappedAbs, tonic, srcInterval);
        } else if (method === "harmonic") {
          let duration = 1; // held length = trailing key-off (0x0001) run
          for (let r = row + 1; r < ptn.length; r++) {
            if (ptn[r].note !== 0x0001) break;
            duration++;
          }
          lambda = 1 - Math.exp(-(duration - 1) / 4);
        }
        let bestAbs = 0, bestScore = Infinity;
        forEachCandidate(targetAbs, (cand) => {
          const pitchErr = Math.abs(cand - targetAbs);
          let score = pitchErr;
          if (method === "cadence") {
            const candDeltaT = cadTension(cand, tonic, srcInterval) - tMappedPrev;
            score = Math.abs(candDeltaT - targetDeltaT) * 2 + pitchErr;
          } else if (method === "harmonic") {
            score = pitchErr + lambda * harmonicCost(cand, tonic, srcInterval);
          }
          if (score < bestScore) { bestScore = score; bestAbs = cand; }
        });
        newAbs = bestAbs;
      } else {
        let bestAbs = 0, bestDist = Infinity;
        forEachCandidate(origAbs, (cand) => {
          const d = Math.abs(cand - origAbs);
          if (d < bestDist) { bestDist = d; bestAbs = cand; }
        });
        newAbs = bestAbs;
      }

      newAbs = Math.min(Math.max(newAbs, 0), 0xffff) & 0xffff;
      if (newAbs !== note) {
        changes.push({ pat: p, row, prev: note });
        cell.note = newAbs;
      }
      prevOrigAbs = origAbs;
      prevMappedAbs = newAbs;
    }
  }
  return changes;
}

/** Nearest-pitch retune (back-compat wrapper). */
export function retuneNearest(song, newPreset, percSlots) {
  return retuneAllPatterns(song, newPreset, null, percSlots, "pitch");
}

/**
 * Transpose every note of ONE pattern, notation-aware:
 *   - table presets: snap to the nearest degree, move `fine` table steps
 *     (wrapping across periods) plus `coarse` whole periods;
 *   - Raw (empty table): `fine` raw 4096-TET note units plus `coarse` periods.
 * Sentinels/interrupts (< 0x20) and percussion instruments are skipped, with
 * the same running-instrument inheritance as retuneAllPatterns. Mutates the
 * cells; returns [{pat, row, prev}] for restoreNotesOp (via bulkNotesOp).
 */
export function transposePatternNotes(song, patIdx, preset, percSlots, fine, coarse,
                                      rowLo = 0, rowHi = Infinity, rowFilter = null) {
  const ptn = song.patterns[patIdx];
  const useTable = preset && preset.table.length > 0;
  const interval = preset?.interval || 0x1000;
  const changes = [];
  let runningInst = 0;
  for (let row = 0; row < ptn.length; row++) {
    const cell = ptn[row];
    if (cell.instrment !== 0) runningInst = cell.instrment;
    const note = cell.note;
    if (note >= 0x0000 && note <= 0x001f) continue; // sentinels/interrupts
    const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
    if (percSlots && eInst >= 1 && percSlots[eInst]) continue;
    // Row window (a block selection): rows outside it still feed running-inst
    // above, but are not transposed (item 58). `rowFilter` is the same idea for
    // a set of rows rather than a span — a Timeline block can reach one pattern
    // through several cues, so its rows need not be contiguous.
    if (row < rowLo || row > rowHi) continue;
    if (rowFilter !== null && !rowFilter(row)) continue;

    let out;
    if (!useTable) {
      out = note + fine + coarse * interval;
    } else if (isAbsolute(preset)) {
      const table = preset.table;
      const base = presetBase(preset);
      // Fine steps degrees and clamps: an absolute table's ends are the limit
      // of what the notation can say.
      const idx = Math.min(Math.max(nearestAbsIndex(note, preset) + fine, 0),
                           table.length - 1);
      out = base + table[idx];
      // There is no period to count, so coarse moves a whole octave in PITCH
      // and re-snaps — exact for ProTracker, which is 12 degrees per octave.
      if (coarse !== 0) out = base + table[nearestAbsIndex(out + coarse * 0x1000, preset)];
    } else {
      const table = preset.table;
      const rel = note - ANCHOR_NOTE;
      let k = Math.floor(rel / interval);
      const inPeriod = rel - k * interval;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < table.length; i++) {
        const d = Math.abs(table[i] - inPeriod);
        if (d < bestD) { bestD = d; best = i; }
      }
      // the next period's root may be nearer than the top table entry
      if (interval - inPeriod < bestD) { k += 1; best = 0; }
      let idx = best + fine;
      k += Math.floor(idx / table.length) + coarse;
      idx = ((idx % table.length) + table.length) % table.length;
      out = ANCHOR_NOTE + k * interval + table[idx];
    }
    out = Math.min(Math.max(Math.round(out), 0x20), 0xffff);
    if (out !== note) {
      changes.push({ pat: patIdx, row, prev: note });
      cell.note = out;
    }
  }
  return changes;
}

/**
 * The same transpose over EVERY materialised pattern of one song (item 85 —
 * the Project view's global operation). Unmaterialised pattern numbers (item
 * 48 gaps) hold nothing to shift, so they stay unmaterialised. Other songs in
 * the project are never touched: `song` is the only thing this reads.
 * Returns the concatenated [{pat, row, prev}] list for restoreNotesOp.
 */
export function transposeAllPatterns(song, preset, percSlots, fine, coarse) {
  const changes = [];
  for (let p = 0; p < song.patterns.length; p++) {
    if (!song.patterns[p]) continue;
    for (const c of transposePatternNotes(song, p, preset, percSlots, fine, coarse)) {
      changes.push(c);
    }
  }
  return changes;
}

/**
 * i18n keys naming the two transpose units for a preset, so the pattern-scoped
 * and global dialogs always agree. The fine unit follows the song's tuning
 * (semitones in the 12-notes-per-octave family, table steps elsewhere, raw
 * note units with no table) and the coarse unit is octaves — or periods when
 * the tuning isn't octave-based, e.g. Bohlen-Pierce tritaves. Interval 0 is an
 * absolute table (ProTracker): coarse moves an octave in pitch and re-snaps.
 */
export function transposeUnitKeys(preset) {
  const raw = !preset || preset.table.length === 0;
  const iv = preset?.interval ?? 0x1000;
  return {
    fine: raw ? "pat.unitNoteUnits"
      : preset.t === "d" ? "pat.unitSemitones" : "pat.unitSteps",
    coarse: (iv === 0x1000 || iv === 0) ? "pat.unitOctaves" : "pat.unitPeriods",
  };
}
