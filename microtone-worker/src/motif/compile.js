// Motif's compiler: a score's per-lane events → Taud patterns and cues
// (TAUD_FILE_FORMAT.md §5, §6). Each lane's slice of each cue becomes one
// pattern; byte-identical slices share a pattern; a lane with nothing in a
// cue leaves that cue's word empty. Lane trim and jitter are applied here,
// to every volume SET a lane writes.

import { noise2 } from "./stdlib.js";
import { opByte } from "./music.js";

const EMPTY = 0x7fff;

/** One version-2 cell (8 bytes). */
function cell8(c, trim, jit) {
  const b = new Uint8Array(8);
  b[3] = 0xc0; b[4] = 0xc0; // FINE by zero: the empty columns
  if (!c) return b;
  const note = c.note ?? 0;
  b[0] = note & 0xff; b[1] = note >>> 8;
  b[2] = c.inst ? c.inst.slot : 0;
  if (c.volRaw !== undefined) b[3] = c.volRaw;
  else if (c.vol !== undefined) b[3] = setVolume(c.vol, trim, jit, 63); // selector 0 = SET
  if (c.panRaw !== undefined) b[4] = c.panRaw;
  if (c.fx !== undefined) {
    b[5] = c.fx;
    b[6] = (c.arg ?? 0) & 0xff; b[7] = ((c.arg ?? 0) >>> 8) & 0xff;
  }
  return b;
}

/** One version-3 wide cell (16 bytes, §5.5). */
function cell16(c, trim, jit) {
  const b = new Uint8Array(16);
  b[8] = 0x33; // FINE / FINE: the empty columns
  if (!c) return b;
  const note = c.note ?? 0;
  b[0] = note & 0xff; b[1] = note >>> 8;
  b[2] = c.inst ? c.inst.slot : 0;
  let volSel = 3, volVal = 0;
  if (c.volSel !== undefined) { volSel = c.volSel; volVal = c.volRaw; }
  else if (c.vol !== undefined) { volSel = 0; volVal = setVolume(c.vol, trim, jit, 255); }
  let panSel = 3, az = 0, el = 0;
  if (c.az !== undefined) { panSel = 0; az = c.az; el = c.el ?? 0; }
  b[3] = volVal;
  b[4] = az & 0xff;
  b[8] = (((az >>> 8) & 1) << 7) | ((volSel & 7) << 4) | (panSel & 0xf);
  b[9] = el & 0xff;
  if (c.fx !== undefined) { b[5] = c.fx; b[6] = (c.arg ?? 0) & 0xff; b[7] = ((c.arg ?? 0) >>> 8) & 0xff; }
  if (c.fx2 !== undefined) { b[10] = c.fx2; b[11] = (c.arg2 ?? 0) & 0xff; b[12] = ((c.arg2 ?? 0) >>> 8) & 0xff; }
  return b;
}

/** A written volume through the lane's trim and jitter. A note written at 0
 *  stays silent; anything else stays audible (at least 1). */
function setVolume(v, trim, jit, max) {
  if (v === 0) return 0;
  return Math.max(1, Math.min(max, Math.round(v * trim + jit)));
}

/** One cell as pattern bytes, in either layout — the preview's encoder. */
export function encodeCell(c, trim, jit, wide) {
  return wide ? cell16(c, trim, jit) : cell8(c, trim, jit);
}

/** One empty pattern image. */
export function emptyPattern(wide) {
  const size = wide ? 16 : 8;
  const bytes = new Uint8Array(64 * size);
  for (let r = 0; r < 64; r++) {
    if (wide) bytes[r * 16 + 8] = 0x33;
    else { bytes[r * 8 + 3] = 0xc0; bytes[r * 8 + 4] = 0xc0; }
  }
  return bytes;
}

const LEN = 0x0200;  // instruction: the cue plays this many rows (low 6 bits = rows − 1)
const HALT = 0x0100; // instruction: play the cue, then stop

/** Returns {patterns, cues, names} for the score's song. */
export function compileScore(score) {
  const { song, lanes } = score;
  const wide = score.wide;
  const size = wide ? 16 : 8;
  const encode = wide ? cell16 : cell8;
  const cueRows = song.barRows * song.cueBars;
  const nCues = Math.ceil(song.bars / song.cueBars);
  const patterns = [];
  const names = [];
  const byKey = new Map();
  const cues = [];
  for (let c = 0; c < nCues; c++) {
    const words = new Uint16Array(64).fill(EMPTY);
    const base = c * cueRows;
    const rowsHere = Math.min(cueRows, score.rows - base);
    lanes.forEach((lane, li) => {
      let any = false;
      const bytes = new Uint8Array(64 * size);
      for (let r = 0; r < 64; r++) {
        const ev = r < rowsHere ? lane.ev.get(base + r) : undefined;
        if (ev) any = true;
        // jitter: a fixed nudge per lane and row-in-pattern, so a repeated
        // slice still compiles to one shared pattern
        const jit = lane.jitter ? Math.round(noise2(li, r) * lane.jitter) : 0;
        bytes.set(encode(ev, lane.trim, jit), r * size);
      }
      if (!any) return;
      let key = "";
      for (let i = 0; i < bytes.length; i++) key += String.fromCharCode(bytes[i]);
      let idx = byKey.get(key);
      if (idx === undefined) {
        idx = patterns.length;
        byKey.set(key, idx);
        patterns.push(bytes);
        const section = score.sectionOfCue(c);
        names.push(section ? `${lane.label} ${section}` : lane.label);
      }
      words[li] = idx;
    });
    const w0 = rowsHere < 64 ? LEN | (rowsHere - 1) : 0;
    const w1 = c === nCues - 1 ? HALT : 0;
    for (let b = 0; b < 16; b++) {
      if ((w0 >> b) & 1) words[b] |= 0x8000;
      if ((w1 >> b) & 1) words[16 + b] |= 0x8000;
    }
    cues.push(words);
  }
  // Number repeated names so the Timeline can tell same-named patterns apart.
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  const counter = new Map();
  for (let i = 0; i < names.length; i++) {
    if (seen.get(names[i]) > 1) {
      const k = (counter.get(names[i]) ?? 0) + 1;
      counter.set(names[i], k);
      names[i] = `${names[i]} ${k}`;
    }
  }
  placePans(score, { patterns, cues, names, wide });
  return { patterns, cues, names };
}

/**
 * A lane's `pan` is an S $80xx on the song's first row. A lane that plays
 * nothing in cue 0 gets a pattern holding only that; one whose cue-0 pattern
 * is used anywhere else gets its own copy, so the pan is set exactly once.
 */
function placePans(score, { patterns, cues, names, wide }) {
  const S = opByte("S");
  const cue0 = cues[0];
  score.lanes.forEach((lane, li) => {
    if (lane.pan === null) return;
    let p = cue0[li] & EMPTY;
    if (p === EMPTY) {
      p = patterns.length;
      patterns.push(emptyPattern(wide));
      names.push(`${lane.label} setup`);
      cue0[li] = (cue0[li] & 0x8000) | p;
    } else if (cues.some((w, c) => w.some((x, lj) => (x & EMPTY) === p && (c > 0 || lj !== li)))) {
      patterns.push(patterns[p].slice());
      names.push(`${names[p]} (setup)`);
      p = patterns.length - 1;
      cue0[li] = (cue0[li] & 0x8000) | p;
    }
    const bytes = patterns[p];
    if (bytes[5] !== 0) {
      throw score.clash(lane, 0, "fx", bytes[5], S);
    }
    const arg = 0x8000 | lane.pan;
    bytes[5] = S;
    bytes[6] = arg & 0xff; bytes[7] = arg >>> 8;
  });
}
