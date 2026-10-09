// Composition toolkit for the 31-TET demo: pitch arithmetic in 31-EDO steps,
// per-lane event maps, melody strings, and the compiler that turns them into
// Taud patterns and cues (TAUD_FILE_FORMAT.md §5, §6).

import { pitchTablePresets } from "../../core/tuning/pitchtables.js";

// ── timing ──────────────────────────────────────────────────────────────────
export const BAR_ROWS = 14;          // 7/8 at two rows per eighth
export const CUE_BARS = 4;
export const CUE_ROWS = BAR_ROWS * CUE_BARS; // 56
export const NBARS = 64;
export const NCUES = NBARS / CUE_BARS;
export const SPEED = 6;
/** Absolute row of `row` (0..13) in 1-based `bar`. */
export const R = (bar, row = 0) => (bar - 1) * BAR_ROWS + row;

// ── pitch ───────────────────────────────────────────────────────────────────
const T31 = pitchTablePresets[310].table;
export const NAMES = ["C", "Ct", "C#", "Db", "Dp", "D", "Dt", "D#", "Eb", "Ep", "E", "Et", "Fp", "F",
  "Ft", "F#", "Gb", "Gp", "G", "Gt", "G#", "Ab", "Ap", "A", "At", "A#", "Bb", "Bp", "B", "Bt", "Cp"];
export const DEG = Object.fromEntries(NAMES.map((n, i) => [n, i]));

/** Absolute 31-EDO step (C0 = 0) from a name such as "D4", "Cp4", "F#3". The
 *  octave digit is the PERIOD, as the tracker shows it: "Cp4" is degree 30 of
 *  period 4, which sounds just below C5. */
export function st(name) {
  const m = /^([A-G](?:t|#|b|p)?)(\d)$/.exec(name);
  if (!m || !(m[1] in DEG)) throw new Error(`bad note name ${name}`);
  return 31 * Number(m[2]) + DEG[m[1]];
}
export function stepName(step) {
  const o = Math.floor(step / 31);
  return NAMES[step - 31 * o] + o;
}
/** 4096-TET note word of a 31-EDO step, exactly on the 31-TET notation grid. */
export function noteWord(step) {
  const o = Math.floor(step / 31);
  const w = 0x5000 + (o - 4) * 0x1000 + T31[step - 31 * o];
  if (w < 0x20 || w > 0xffff) throw new Error(`step ${step} out of range`);
  return w;
}
/** Nearest 31-EDO step to a MIDI key (drum zones span ±50 cents, so this always lands in the key's zone). */
// Ties (the tritone keys: GM 42, 54, 66, 78) take the lower step, so a hi-hat
// reads F#2 as a GM drum map spells it rather than Gb2.
export const midiStep = (k) => {
  const x = ((k - 60) * 31) / 12;
  return 124 + (x - Math.floor(x) === 0.5 ? Math.floor(x) : Math.round(x));
};

// ── effects ─────────────────────────────────────────────────────────────────
const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const op = (ch) => { const i = B36.indexOf(ch); if (i < 0) throw new Error(`bad opcode ${ch}`); return i; };

// ── lanes and events ────────────────────────────────────────────────────────
export const lanes = [];
export const L = {};
export function defLane(id, inst, pan, label, trim = 1, jitter = 0) {
  L[id] = lanes.length;
  lanes.push({ id, inst, pan, label, trim, jitter, ev: new Map() });
}

/** Deterministic ±1 noise per (lane, row): the same song every build. */
function noise(li, row) {
  let t = (Math.imul(li + 1, 0x9e3779b1) ^ Math.imul(row + 7, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

const KEY_OFF = 0x0001;

/** Merge fields into a cell; a clash between two different values is a composing bug. */
export function put(laneId, row, f) {
  const lane = lanes[L[laneId]];
  if (!lane) throw new Error(`no lane ${laneId}`);
  if (row < 0 || row >= NBARS * BAR_ROWS) throw new Error(`${laneId}: row ${row} outside the song`);
  const c = lane.ev.get(row) ?? {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null) continue;
    if (k === "note" && c.note === KEY_OFF && v !== KEY_OFF) { c.note = v; continue; }
    if (c[k] !== undefined && c[k] !== v) {
      throw new Error(`${laneId} @ bar ${Math.floor(row / BAR_ROWS) + 1} row ${row % BAR_ROWS}: ${k} ${c[k]} vs ${v}`);
    }
    c[k] = v;
  }
  lane.ev.set(row, c);
}
export const has = (laneId, row) => lanes[L[laneId]].ev.has(row);
export const cellAt = (laneId, row) => lanes[L[laneId]].ev.get(row);

/** Trigger `step` on a lane (instrument from the lane) with note volume `vol`. */
export function hit(laneId, row, step, vol, fxCh = null, arg = 0) {
  put(laneId, row, {
    note: noteWord(step), inst: lanes[L[laneId]].inst, vol,
    fx: fxCh === null ? undefined : op(fxCh), arg: fxCh === null ? undefined : arg,
  });
}
export function keyOff(laneId, row) {
  // A key-off never overrides a note that something else already put there.
  const c = cellAt(laneId, row);
  if (c?.note !== undefined) return;
  put(laneId, row, { note: KEY_OFF });
}
export function fx(laneId, row, ch, arg) { put(laneId, row, { fx: op(ch), arg }); }
/** Volume-column fine slide down by `mag` (0..31) on tick 0 (selector 3, direction bit clear). */
export function volFineDown(laneId, row, mag) { put(laneId, row, { volRaw: 0xc0 | (mag & 0x1f) }); }
export function volFineUp(laneId, row, mag) { put(laneId, row, { volRaw: 0xc0 | 0x20 | (mag & 0x1f) }); }
/** Volume-column slide down / up by `x` per non-first tick (selectors 2 / 1). */
export function volSlideDown(laneId, row, x) { put(laneId, row, { volRaw: 0x80 | (x & 0x3f) }); }
export function volSlideUp(laneId, row, x) { put(laneId, row, { volRaw: 0x40 | (x & 0x3f) }); }

/** Tone portamento into `step` without re-attacking (no instrument byte). */
export function glide(laneId, row, step, speed) {
  put(laneId, row, { note: noteWord(step), fx: op("G"), arg: speed });
}
/** G speed (4096-TET units per tick) that covers `fromStep`→`toStep` in `rows` rows. */
export function glideSpeed(fromStep, toStep, rows) {
  const units = Math.abs(noteWord(toStep) - noteWord(fromStep));
  return Math.max(1, Math.ceil(units / (rows * (SPEED - 1))));
}

/** Vibrato on rows [from, to): the first row states speed/depth, the rest recall
 *  it. Rows that already carry an effect are skipped (H must be restated per row). */
export function vibrato(laneId, from, to, speed, depth) {
  let first = true;
  for (let r = from; r < to; r++) {
    const c = cellAt(laneId, r);
    if (c?.fx !== undefined) { first = true; continue; }
    if (c?.note === KEY_OFF) break;
    fx(laneId, r, "H", first ? ((speed << 8) | depth) : 0);
    first = false;
  }
}

/**
 * A melody line from a token string, starting at absolute row `start`:
 *   NAME:LEN        a note (NAME like D5, Cp4, F#5), LEN in rows
 *   ~NAME:LEN       glide into it from the previous note (no re-attack)
 *   r:LEN           rest (the previous note is keyed off)
 *   suffix @VOL     note volume for this note
 *   suffix v        vibrato from two rows in, if the note is long enough
 *   suffix >        tie: no key-off after it even if a rest/end follows
 * Returns the row after the line.
 */
export function melody(laneId, start, text, { vol = 48, vib = [0x7d, 0x14], glideRows = 1, transpose = 0 } = {}) {
  let row = start;
  let prev = null; // {step, row, len, tie}
  const ends = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === "|") {
      if ((row - start) % BAR_ROWS !== 0) throw new Error(`${laneId}: bar line at ${row - start} rows into a line starting bar ${Math.floor(start / BAR_ROWS) + 1}`);
      continue;
    }
    const m = /^(~?)([A-Gr](?:t|#|b|p)?\d?):(\d+)(?:@(\d+))?([v>]*)$/.exec(tok);
    if (!m) throw new Error(`bad melody token ${tok}`);
    const [, tilde, name, lenS, volS, flags] = m;
    const len = Number(lenS);
    if (name === "r") {
      if (prev && !prev.tie) keyOff(laneId, row);
      prev = null;
      row += len;
      continue;
    }
    const step = st(name) + transpose;
    const v = volS ? Number(volS) : vol;
    if (tilde && prev) {
      glide(laneId, row, step, glideSpeed(prev.step, step, glideRows));
      if (volS) put(laneId, row, { vol: v });
    } else {
      hit(laneId, row, step, v);
    }
    if (flags.includes("v") && len >= 4) ends.push([row + 2, row + len]);
    prev = { step, row, len, tie: flags.includes(">") };
    row += len;
  }
  if (prev && !prev.tie) keyOff(laneId, row);
  for (const [a, b] of ends) vibrato(laneId, a, b, vib[0], vib[1]);
  return row;
}

// ── chords and voicing ──────────────────────────────────────────────────────
/** Pitch classes of a chord: root class + intervals in steps. */
export const pcs = (chord) => chord.ivs.map((iv) => (chord.root + iv) % 31);

/**
 * Spread `chord` over `n` lanes, one note each, inside [lo, hi], moving as
 * little as possible from `prev` (the steps those lanes hold now) and covering
 * every pitch class when n allows; ties prefer the lower voicing. Brute force —
 * the spaces are tiny.
 */
export function voiceLead(prev, chord, lo, hi, { n = prev.length, needRoot = false } = {}) {
  const classes = pcs(chord);
  const cand = [];
  for (let s = lo; s <= hi; s++) if (classes.includes(s % 31)) cand.push(s);
  let best = null;
  const pick = [];
  const rec = (i, minS) => {
    if (i === n) {
      const got = new Set(pick.map((s) => s % 31));
      const need = Math.min(n, classes.length);
      if (got.size < need) return;
      if (needRoot && !got.has(chord.root % 31)) return;
      let cost = 0;
      for (let k = 0; k < n; k++) cost += Math.abs(pick[k] - prev[k]);
      if (best === null || cost < best.cost) best = { cost, v: pick.slice() };
      return;
    }
    for (const s of cand) {
      if (s <= minS) continue;
      pick.push(s); rec(i + 1, s); pick.pop();
    }
  };
  rec(0, -1);
  if (!best) throw new Error(`no voicing for ${chord.name} in ${lo}..${hi}`);
  return best.v;
}

// ── compiler ────────────────────────────────────────────────────────────────
function cellBytes(c, trim = 1, jit = 0) {
  const b = new Uint8Array(8);
  b[3] = 0xc0; b[4] = 0xc0;
  if (!c) return b;
  const note = c.note ?? 0;
  b[0] = note & 0xff; b[1] = note >>> 8;
  b[2] = c.inst ?? 0;
  if (c.volRaw !== undefined) b[3] = c.volRaw;
  else if (c.vol !== undefined) b[3] = Math.max(1, Math.min(63, Math.round(c.vol * trim + jit))); // selector 0 = SET
  if (c.panRaw !== undefined) b[4] = c.panRaw;
  if (c.fx !== undefined) {
    b[5] = c.fx;
    b[6] = (c.arg ?? 0) & 0xff; b[7] = ((c.arg ?? 0) >>> 8) & 0xff;
  }
  return b;
}

const LEN_WORD = 0x0200 | (CUE_ROWS - 1);   // LEN 56
const HALT_WORD = 0x0100;                    // play the cue, then stop

/**
 * Patterns + cues for the song. Each lane's 56-row slice of each cue becomes a
 * pattern (rows 56..63 empty), byte-identical slices share one pattern, and an
 * empty slice leaves the lane's cue word empty. Returns {patterns, cues, names}.
 */
export function compile(sectionOfCue) {
  const patterns = [];
  const names = [];
  const byKey = new Map();
  const cues = [];
  for (let c = 0; c < NCUES; c++) {
    const words = new Uint16Array(64).fill(0x7fff);
    lanes.forEach((lane, li) => {
      const base = c * CUE_ROWS;
      let any = false;
      const bytes = new Uint8Array(512);
      for (let r = 0; r < 64; r++) {
        const ev = r < CUE_ROWS ? lane.ev.get(base + r) : undefined;
        if (ev) any = true;
        bytes.set(cellBytes(ev, lane.trim, lane.jitter ? Math.round(noise(li, r) * lane.jitter) : 0), r * 8);
      }
      if (!any) return;
      let key = "";
      for (let i = 0; i < 512; i++) key += String.fromCharCode(bytes[i]);
      let idx = byKey.get(key);
      if (idx === undefined) {
        idx = patterns.length;
        byKey.set(key, idx);
        patterns.push(bytes);
        names.push(`${lane.label} ${sectionOfCue(c)}`);
      }
      words[li] = idx;
    });
    const w0 = LEN_WORD;
    const w1 = c === NCUES - 1 ? HALT_WORD : 0;
    for (let b = 0; b < 16; b++) {
      if ((w0 >> b) & 1) words[b] |= 0x8000;
      if ((w1 >> b) & 1) words[16 + b] |= 0x8000;
    }
    cues.push(words);
  }
  // Number repeated names so the Timeline can tell same-named patterns apart.
  const seen = new Map();
  for (let i = 0; i < names.length; i++) {
    const n = (seen.get(names[i]) ?? 0) + 1;
    seen.set(names[i], n);
  }
  const counter = new Map();
  for (let i = 0; i < names.length; i++) {
    if (seen.get(names[i]) > 1) {
      const k = (counter.get(names[i]) ?? 0) + 1;
      counter.set(names[i], k);
      names[i] = `${names[i]} ${k}`;
    }
  }
  return { patterns, cues, names };
}
