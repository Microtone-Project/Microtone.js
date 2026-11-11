// Spinner mappings (components/spinner.js mapSpinner) for the instrument
// panels: what a stored number means, shown in the units someone thinks in.
//
// Each map is { toDisplay(raw), fromDisplay(text), step(raw, dir) }: − and +
// walk the STORED units (a mix octet, a table degree, one hex count), while the
// box shows decibels, cents or `$hex`. The Hertz spinner, which needs a reading
// of its own, is components/hzspinner.js.

import { META_MIX_GAIN } from "../../core/engine/tables.js";
import { ANCHOR_NOTE, stepNoteInTable } from "../../core/tuning/pitchtables.js";
import { parseFieldValue } from "../doc/patternquery.js";
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

/**
 * A detune in cents over signed 4096-TET units, kept within [min, max], each
 * press a degree of the song's own pitch table (measured from middle C, as the
 * layer table's detune is). Typing takes cents, `700c`, `3/2` and `$100`.
 */
export function centsMap(preset, min = -0x8000, max = 0x7fff) {
  const clampU = (u) => clampN(Math.round(u), min, max);
  return {
    toDisplay: (u) => `${centsOfUnits(u).toFixed(1)} ¢`,
    fromDisplay: (text) => {
      const c = parsePitchText(text, "cents");
      return clampU(Number.isFinite(c) ? unitsOfCents(c) : 0);
    },
    step: (u, dir) => clampU(stepNoteInTable(clampN(ANCHOR_NOTE + u, 0x20, 0xffff), preset, dir) - ANCHOR_NOTE),
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
