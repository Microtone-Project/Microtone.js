// A frequency field: a value stored in ABSOLUTE CENTS (SoundFont's unit for a
// filter cutoff, 8.176 Hz × 2^(cents / 1200)) read and typed in hertz.
//
//   ┌─┬──────────┬─┐
//   │–│ 1.25 kHz │+│     − / + move a semitone (100 cents);
//   └─┴──────────┴─┘     typing takes 440, 440 Hz, 1.2k, 1.2 kHz, 6900c.
//
// It is a mapping for the app's own value control (spinner.js mapSpinner), so
// it looks and steps like every other spinner; `hzSpinner` attaches it. A
// field whose top value means "off" ($FFFF for a cutoff) passes `off`, and the
// box then reads Off there, + past the top turns it off and − from Off comes
// back to the top.

import { mapSpinner } from "./spinner.js";

/** SoundFont's reference: 0 absolute cents = 8.176 Hz (MIDI note 0). */
export const HZ_AT_ZERO_CENTS = 8.176;

/** Absolute cents → hertz. */
export function hzOfCents(cents) {
  return HZ_AT_ZERO_CENTS * 2 ** (cents / 1200);
}

/** Hertz → the nearest whole absolute cent. */
export function centsOfHz(hz) {
  return Math.round(1200 * Math.log2(hz / HZ_AT_ZERO_CENTS));
}

/** A frequency the way the panels print one: 440 Hz, 1.25 kHz, 12 kHz. */
export function formatHz(hz) {
  if (hz >= 10000) return `${Math.round(hz / 1000)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}

const HZ_TEXT = /^(\d+(?:\.\d*)?|\.\d+)\s*(k|khz|hz)?$/i;
const CENTS_TEXT = /^(\d+(?:\.\d*)?|\.\d+)\s*[c¢]$/i;

/**
 * A typed frequency in hertz, or NaN: `440`, `440 Hz`, `1.2k`, `1.2 kHz`
 * (case and spacing free), or absolute cents as `6900c` for someone reading a
 * SoundFont's own numbers.
 */
export function parseHzText(text) {
  const s = String(text ?? "").trim().replace(/,/g, "");
  const c = CENTS_TEXT.exec(s);
  if (c !== null) return hzOfCents(Number(c[1]));
  const m = HZ_TEXT.exec(s);
  if (m === null) return NaN;
  const k = m[2] !== undefined && m[2].toLowerCase().startsWith("k");
  return Number(m[1]) * (k ? 1000 : 1);
}

/**
 * The mapping: stored cents within [min, max] (SoundFont's own cutoff range,
 * 1500…13500, by default); `off`, when given, is the stored value meaning
 * "no filter" and `offLabel` what the box says there.
 */
export function hzSpinnerMap({ min = 1500, max = 13500, step = 100, off = null, offLabel = "Off" } = {}) {
  const clampC = (c) => Math.min(Math.max(Math.round(c), min), max);
  const isOff = (c) => off !== null && c === off;
  return {
    toDisplay: (c) => (isOff(c) ? offLabel : formatHz(hzOfCents(clampC(c)))),
    fromDisplay: (text) => {
      if (off !== null && String(text ?? "").trim().toLowerCase() === String(offLabel).toLowerCase()) return off;
      const hz = parseHzText(text);
      return Number.isFinite(hz) && hz > 0 ? clampC(centsOfHz(hz)) : clampC(min);
    },
    step: (c, dir) => {
      if (isOff(c)) return dir < 0 ? max : off;
      const next = clampC(c) + dir * step;
      if (off !== null && next > max) return off;
      return clampC(next);
    },
  };
}

/** Make `input` a frequency field over `cents` (see hzSpinnerMap for opts).
 *  Its `rawValue` is the stored cents; listen for `change` as for any field. */
export function hzSpinner(input, cents, opts = {}) {
  return mapSpinner(input, hzSpinnerMap(opts), cents);
}
