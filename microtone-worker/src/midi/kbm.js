// Scala keyboard mappings (.kbm) for the master keyboard (item 379).
//
// A .kbm says which MIDI key plays which DEGREE of a scale; in Microtone the
// scale is the notation the note is written in (the song's, a lane's or an
// instrument's), so a mapping works unchanged on any tuning — degrees wrap
// through periods there (pitchtables.js noteForDegree). The file is Scala's
// own (https://www.huygens-fokker.org/scala/help.htm#mappings): `!` starts a
// comment line, and the values come one per line, in this order:
//
//   size          keys in the repeating pattern; 0 = linear (a key a degree)
//   first, last   the MIDI keys mapped at all (others are silent)
//   middle        the key the pattern's first entry is mapped to
//   reference     the key whose frequency is given, and
//   frequency     that frequency in Hz
//   octave        the degree one pattern is above the last (the formal
//                 octave; 0 = the scale's own size)
//   size entries  a degree for each key of the pattern from `middle` up, or
//                 `x` for a key left silent; missing ones at the end are `x`
//
// The reference key and frequency are read and shown, never applied: a
// song's pitch is its notation's and its own tuning's (조율), not the
// keyboard's. Anything after the value on a line is a comment, as Scala reads
// it. Pure: no DOM, no storage.

/** A key a degree, from key 60: what a keyboard plays with no mapping. */
export const LINEAR_KBM = Object.freeze({
  size: 0, first: 0, last: 127, middle: 60, reference: 69, frequency: 440, octave: 0, map: Object.freeze([]),
});

/**
 * Read a .kbm's text. Returns the mapping {size, first, last, middle,
 * reference, frequency, octave, map}, map[i] a degree or null; throws an
 * Error saying what is wrong with a file that is not one.
 */
export function parseKbm(text) {
  const lines = String(text).split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("!"));
  let at = 0;
  const next = (what) => {
    if (at >= lines.length) throw new Error(`the file ends before the ${what}`);
    return lines[at++].split(/\s+/)[0];
  };
  const int = (what, lo, hi) => {
    const s = next(what);
    if (!/^[+-]?\d+$/.test(s)) throw new Error(`the ${what} is not a whole number: ${s}`);
    const v = Number(s);
    if (v < lo || v > hi) throw new Error(`the ${what} is out of range: ${v}`);
    return v;
  };
  const size = int("size of the map", 0, 1 << 16);
  const first = int("first key", 0, 127);
  const last = int("last key", 0, 127);
  const middle = int("middle key", 0, 127);
  const reference = int("reference key", 0, 127);
  const fs = next("reference frequency");
  const frequency = Number(fs);
  if (!Number.isFinite(frequency) || frequency <= 0) throw new Error(`the reference frequency is not a frequency: ${fs}`);
  const octave = int("formal octave", -(1 << 16), 1 << 16);
  const map = [];
  for (let i = 0; i < size && at < lines.length; i++) {
    const s = lines[at++].split(/\s+/)[0];
    if (/^x$/i.test(s)) { map.push(null); continue; }
    if (!/^[+-]?\d+$/.test(s)) throw new Error(`mapping entry ${i + 1} is neither a degree nor x: ${s}`);
    map.push(Number(s));
  }
  while (map.length < size) map.push(null);
  return { size, first, last, middle, reference, frequency, octave, map };
}

/**
 * The degree MIDI key `key` plays under `kbm` (null: LINEAR_KBM), or null for
 * a key the mapping leaves silent. `period` stands in for a formal octave of
 * 0: the scale's own size, which is the notation's table length.
 */
export function kbmDegree(kbm, key, period = 0) {
  const m = kbm ?? LINEAR_KBM;
  if (key < m.first || key > m.last) return null;
  const d = key - m.middle;
  if (m.size === 0) return d;
  const rep = Math.floor(d / m.size);
  const entry = m.map[d - rep * m.size];
  if (entry === null || entry === undefined) return null;
  const octave = m.octave !== 0 ? m.octave : period;
  return rep * octave + entry;
}
