// Spinner mappings (components/spinner.js mapSpinner) for the instrument
// panels and the notation maker: what a stored number means, shown in the units someone thinks in.
//
// Each map is { toDisplay(raw), fromDisplay(text), step(raw, dir) }: − and +
// walk the STORED units (a mix octet, a table degree, one hex count), while the
// box shows decibels, cents or `$hex`. The Hertz spinner, which needs a reading
// of its own, is components/hzspinner.js.

import { META_MIX_GAIN } from "../../core/engine/tables.js";
import { ANCHOR_NOTE, stepNoteInTable } from "../../core/tuning/pitchtables.js";
import { parseFieldValue, parseNoteName } from "../doc/patternquery.js";
import { parseNumberText, parsePitchText } from "./components/spinner.js";
import { t } from "./i18n.js";

const UNITS_PER_OCTAVE = 4096;
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const minus = (s) => String(s ?? "").replace(/−/g, "-").trim();

// ── decibels over a decibel octet (§7.10) ──────────────────────────────────

/** A mix octet as decibels (159 = 0 dB; 0 = silence). */
export function mixDbLabel(octet) {
  const g = META_MIX_GAIN[octet & 0xff];
  if (!(g > 0)) return "−∞ dB";
  const db = 20 * Math.log10(g);
  return (db >= 0 ? "+" : "−") + Math.abs(db).toFixed(1) + " dB";
}

/** …and back: the octet whose gain is nearest the decibels typed. */
export function mixOctetOfDb(text) {
  const str = minus(text);
  if (str === "" || /-\s*(∞|inf)/i.test(str)) return 0;
  const db = parseFloat(str);
  if (!Number.isFinite(db)) return 0;
  const want = 10 ** (db / 20);
  let best = 0, bestErr = Infinity;
  for (let o = 0; o < 256; o++) {
    const err = Math.abs(META_MIX_GAIN[o] - want);
    if (err < bestErr) { bestErr = err; best = o; }
  }
  return best;
}

/** A layer's or operator's mix (item 156.2): decibels, one octet a press. */
export const MIX_DB_MAP = {
  toDisplay: mixDbLabel,
  fromDisplay: mixOctetOfDb,
  step: (octet, dir) => clampN((octet | 0) + dir, 0, 255),
};

/**
 * Initial attenuation (byte 251, an Ixmp patch's `x` block): the same octet
 * table, but 0 is not silence — it is "unset", unity, the record's own value.
 * Typing a level finds the nearest octet; typing nothing (or "unset") is 0.
 */
export const ATTEN_DB_MAP = {
  toDisplay: (octet) => ((octet & 0xff) === 0 ? t("adv.attenUnset") : mixDbLabel(octet)),
  fromDisplay: (text) => {
    const s = minus(text);
    if (s === "" || !/\d|∞|inf/i.test(s)) return 0;
    return Math.max(1, mixOctetOfDb(s));
  },
  step: (octet, dir) => clampN((octet | 0) + dir, 0, 255),
};

// ── decibels over SoundFont centibels ─────────────────────────────────────

/** SoundFont resonance (centibels above the DC gain, 0…960; `$FFFF` = flat):
 *  shown in dB, one dB a press, typed to a tenth. */
export function sfResoDbMap({ flat = true } = {}) {
  const max = 960;
  return {
    toDisplay: (cb) => (flat && cb >= 0xffff ? t("inst.annFlat") : `${(clampN(cb, 0, max) / 10).toFixed(1)} dB`),
    fromDisplay: (text) => {
      const s = minus(text);
      const db = parseFloat(s);
      if (!Number.isFinite(db)) return flat && /[a-z]/i.test(s) ? 0xffff : 0;
      return clampN(Math.round(db * 10), 0, max);
    },
    step: (cb, dir) => {
      const from = flat && cb >= 0xffff ? (dir > 0 ? -10 : max + 10) : clampN(cb, 0, max);
      return clampN(Math.round(from / 10) * 10 + dir * 10, 0, max);
    },
  };
}

// ── cents over 4096-TET units ──────────────────────────────────────────────

export const centsOfUnits = (units) => (units * 1200) / UNITS_PER_OCTAVE;
export const unitsOfCents = (cents) => (cents * UNITS_PER_OCTAVE) / 1200;

/** A detune in 4096-TET units as cents: to a tenth on a whole unit, to a
 *  hundredth when it carries sixteenths (a 65536-TET step is 0.018 cent). */
export function centsText(units) {
  const c = centsOfUnits(units);
  return `${c.toFixed(Number.isInteger(units) ? 1 : 2)} ¢`;
}

// ── 65536-TET steps ────────────────────────────────────────────────────────
// An instrument's pitch in a format-3 project is held in 4096-TET units that
// carry sixteenths (file format §9.18, doc/pitchedit.js). Whatever a person
// reads or types as a NUMBER of pitch steps is in 65536-TET steps: a hex
// figure (`$51555`, never a hex point), a plain decimal, and what cents and
// ratios land on.

const STEPS_PER_UNIT = 16;
const STEPS_PER_OCTAVE = UNITS_PER_OCTAVE * STEPS_PER_UNIT;

/** A pitch as its 65536-TET step count in hex, five digits at least: C-4 is
 *  `$50000`, an octave below C0 `−$10000`. */
export function stepsHex(units, digits = 5) {
  const n = Math.round(units * STEPS_PER_UNIT) + 0;
  return (n < 0 ? "−$" : "$") + Math.abs(n).toString(16).toUpperCase().padStart(digits, "0");
}

/** …and as a decimal count of them: 1365⅓ units of a third is `21845`. */
export const stepsText = (units) => String(Math.round(units * STEPS_PER_UNIT) + 0);

/** Cents (or anything parsePitchText reads on the 65536 grid) → 4096-TET
 *  units on the 65536-TET grid, computed in one step. */
const unitsOfFineCents = (c) => Math.round((c * STEPS_PER_OCTAVE) / 1200) / STEPS_PER_UNIT;

/**
 * A detune in cents over signed 4096-TET units, kept within [min, max], each
 * press a degree of the song's own pitch table (measured from middle C, as the
 * layer table's detune is). Typing takes cents, `700c`, `3/2` and `$100`.
 *
 * `fine`: the field is a 65536-TET value (file format §9.18). A plain number
 * is cents, as the box shows; `700c` and `3/2` land straight on the nearest
 * 65536-TET step, and hex counts those steps (`$100` is sixteen 4096ths).
 * Text that names no pitch keeps the value the field held.
 */
export function centsMap(preset, min = -0x8000, max = 0x7fff, fine = false) {
  const q = (u) => (fine ? Math.round(u * STEPS_PER_UNIT) / STEPS_PER_UNIT : Math.round(u));
  const clampU = (u) => clampN(q(u), min, max);
  return {
    toDisplay: (u) => centsText(u),
    fromDisplay: fine
      ? (text) => {
        const c = parsePitchText(text, "cents", STEPS_PER_OCTAVE);
        return Number.isFinite(c) ? clampU(unitsOfFineCents(c)) : NaN;
      }
      : (text) => {
        const c = parsePitchText(text, "cents");
        return clampU(Number.isFinite(c) ? unitsOfCents(c) : 0);
      },
    step: (u, dir) => clampU(stepNoteInTable(clampN(ANCHOR_NOTE + u, 0x20, 0xffff + 15 / 16), preset, dir) - ANCHOR_NOTE),
    fine,
  };
}

/**
 * A notation definition's pitch (a degree, the period) as cents over its
 * 65536-TET value: raw is 4096-TET units in sixteenths (what the definition
 * holds, file format §9.7), one press is one 65536-TET step, and `$095C0`,
 * `701.955c` and `3/2` all land on the nearest 65536-TET step. Text that
 * names no pitch keeps the value the field held.
 */
export function fineCentsMap(min = 0, max = 0xffff) {
  const clampU = (u) => clampN(u, min, max);
  const ofCents = (c) => Math.round((c * UNITS_PER_OCTAVE * 16) / 1200) / 16;
  return {
    toDisplay: (u) => ((u * 1200) / UNITS_PER_OCTAVE).toFixed(2),
    fromDisplay: (text) => {
      const c = parsePitchText(text, "cents", UNITS_PER_OCTAVE * 16);
      return Number.isFinite(c) ? clampU(ofCents(c)) : NaN;
    },
    step: (u, dir) => clampU(Math.round(u * 16 + dir) / 16),
    inputMode: "text",
  };
}

// ── hexadecimal ────────────────────────────────────────────────────────────

const hexText = (v, digits) => "$" + (v >>> 0).toString(16).toUpperCase().padStart(digits, "0");

/**
 * A note word (a pitch range's end, the pitch-pan centre) as `$xxxx`: typed as
 * hex (`$5000`, `5000`), as a note name (`C-4`), stepped by degrees of the
 * song's own pitch table. [min, max] is the field's range — a range end may be
 * 0 or $FFFF, past every note the table holds.
 */
export function pitchHexMap(preset, min = 0, max = 0xffff) {
  const clampW = (w) => clampN(Math.round(w), min, max);
  return {
    toDisplay: (w) => hexText(w & 0xffff, 4),
    fromDisplay: (text) => {
      const v = parseFieldValue("note", text);
      return v === null ? clampW(ANCHOR_NOTE) : clampW(v);
    },
    step: (w, dir) => clampW(stepNoteInTable(clampN(w, 0x20, 0xffff), preset, dir)),
    inputMode: "text",
  };
}

/**
 * A pitch — a fixed note, a range bound, the pitch-pan centre — as its
 * 65536-TET step count (file format §9.18): `$50000` is C-4, `$51555` the
 * step above $5155 by five sixteenths, `−$10000` an octave below C0, `$120000`
 * past C15. Typed as a note name (`C-4`), as hex (`$51555`, `0x51555`, a sign
 * in front) or as a plain decimal count of steps (`327680` is C-4) — never with
 * a hex point; stepped by degrees of the song's own table. Text that names no
 * pitch keeps the value the field held.
 *
 *   high  a range's HIGH bound, whose value is the last pitch inside it. A
 *         degree named or stepped to on a whole 4096-TET unit takes the whole
 *         of that unit (C-4 as a top is `$5000F`), as the bound always has; a
 *         typed step count is taken as it stands.
 *   min, max  the reach, in units (default: what a field and its byte hold).
 */
export function widePitchMap(preset, { high = false, min = -8 * 65536, max = 8 * 65536 - 1 / 16 } = {}) {
  const clampW = (w) => clampN(Math.round(w * STEPS_PER_UNIT) / STEPS_PER_UNIT, min, max);
  const topOf = (v) => (high && Number.isInteger(v) ? v + 15 / 16 : v);
  return {
    toDisplay: (w) => stepsHex(w),
    fromDisplay: (text) => {
      const s = minus(text);
      // A name before a number: `Ab4` is a note, not hex.
      const named = /^[+-]?(\$|0x)/i.test(s) ? null : parseNoteName(s);
      if (named !== null) return clampW(topOf(named));
      // Cents and ratios measure an interval, which an absolute pitch is not.
      if (/[c¢/:]/i.test(s.replace(/^[+-]?0x/i, ""))) return NaN;
      const n = parsePitchText(s, "units", STEPS_PER_OCTAVE);
      return Number.isFinite(n) ? clampW(Math.round(n) / STEPS_PER_UNIT) : NaN;
    },
    step: (w, dir) => {
      const from = high && Math.round(w * STEPS_PER_UNIT) % STEPS_PER_UNIT === 15 ? Math.floor(w) : w;
      return clampW(topOf(stepNoteInTable(clampN(from, 0x20, 0xffff + 15 / 16), preset, dir)));
    },
    inputMode: "text",
    fine: true,
  };
}

/** A plain number shown as `digits` hex digits, one count a press; typed as
 *  hex (`$1F00`, `0x1F00`, `1F00`) or as decimal with a `#` in front. */
export function hexMap(digits, min, max) {
  const clampV = (v) => clampN(Math.round(v), min, max);
  return {
    toDisplay: (v) => hexText(v, digits),
    fromDisplay: (text) => {
      const s = minus(text);
      if (s.startsWith("#")) return clampV(Number(s.slice(1)) || 0);
      const n = /^[+-]?[0-9a-fA-F]+$/.test(s) ? Number.parseInt(s, 16) : parseNumberText(s);
      return clampV(Number.isFinite(n) ? n : min);
    },
    step: (v, dir) => clampV(v + dir),
    inputMode: "text",
  };
}
