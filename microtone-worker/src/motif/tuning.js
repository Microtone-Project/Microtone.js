// Motif tunings: what a pitch IS in a TML program. A pitch is a whole number of
// steps of the song's notation, counted from degree 0 of period 0 — so in
// 31-TET, C0 is 0, C4 is 124 and adding 31 goes up an octave. Names are the
// Timeline's own spelling of that notation, with the period number after them:
// "Cp4" is degree 30 of period 4, just below C5.

import { pitchTablePresets, ANCHOR_NOTE, finePreset, quantiseNote } from "../../core/tuning/pitchtables.js";
import { autoAssignSyms, buildNotaPayload, notationValueForSlot, validateDef } from "../doc/notation.js";
import { MotifError } from "./lexer.js";

/** A sym token (" C#", ".C-", "uD-", a CJK glyph) → the name TML spells it by:
 *  the tick (u d U D; the plain and big-dot ticks are silent), the letter and
 *  the accidental (none for a natural). */
export function symName(tok) {
  if (!tok) return null;
  if (tok.length !== 3) return tok.trim() || null;
  const tick = tok[0] === " " || tok[0] === "." ? "" : tok[0];
  const acc = tok[2] === "-" ? "" : tok[2];
  return tick + tok[1] + acc;
}

export class Tuning {
  /**
   * A tuning reads its notes at either resolution (setFine): 4096-TET words,
   * what a format-2 song holds, or 65536-TET pitches — sixteenths of a unit —
   * in a format-3 one. A built-in notation's two tables are its two forms
   * (pitchtables.js finePreset); a custom one keeps its exact degrees and
   * rounds them either way, its nota definition with them.
   *
   * @param notation  the sMet notation value (310 = 31-TET; 0xFFFF = custom slot 0)
   * @param preset    {name, table, interval, sym} — a built-in, or a custom
   *                  notation's exact degrees (4096-TET units, unrounded)
   * @param def       a custom tuning's nota definition (its table and interval
   *                  exact), or null for a built-in
   */
  constructor(notation, preset, def = null) {
    this.notation = notation;
    this.name = preset.name;
    this.preset = preset;
    this.def = def;
    this.n = preset.table.length;
    this.setFine(false);
    this.names = preset.sym.map(symName);
    this.byName = new Map();
    this.ambiguous = new Set();
    this.names.forEach((nm, d) => {
      if (!nm) return;
      if (this.byName.has(nm)) this.ambiguous.add(nm);
      else this.byName.set(nm, d);
    });
    this.longest = Math.max(1, ...this.names.map((nm) => (nm ? nm.length : 0)));
  }

  /** Read notes at 65536-TET (`fine`, a format-3 song) or 4096-TET. */
  setFine(fine) {
    this.fine = fine === true;
    const round = this.fine ? quantiseNote : Math.round;
    if (this.def) {
      this.table = this.preset.table.map(round);
      this.interval = round(this.preset.interval);
      this.nota = buildNotaPayload([{ ...this.def, table: this.table, interval: this.interval }]);
    } else {
      const p = this.fine ? finePreset(this.preset) : this.preset;
      this.table = p.table.slice();
      this.interval = p.interval;
      this.nota = null;
    }
  }

  /** "Cp4" → its step. */
  parse(text) {
    const s = String(text).trim();
    for (let len = Math.min(this.longest, s.length - 1); len >= 1; len--) {
      const name = s.slice(0, len);
      const rest = s.slice(len);
      if (!this.byName.has(name) || !/^-?\d+$/.test(rest)) continue;
      if (this.ambiguous.has(name)) throw new MotifError(`"${name}" names more than one degree of ${this.name}`);
      return Number(rest) * this.n + this.byName.get(name);
    }
    throw new MotifError(`"${s}" is not a note of ${this.name} (a note is a name and its period, like ${this.example()})`);
  }

  /** A degree name with no period ("Bb") → its degree, 0…n−1. */
  degree(name) {
    const s = String(name).trim();
    if (!this.byName.has(s)) throw new MotifError(`"${s}" is not a degree of ${this.name}`);
    if (this.ambiguous.has(s)) throw new MotifError(`"${s}" names more than one degree of ${this.name}`);
    return this.byName.get(s);
  }

  /** step → "Cp4" */
  nameOf(step) {
    const p = Math.floor(step / this.n);
    const d = step - p * this.n;
    return (this.names[d] ?? `#${d}`) + p;
  }

  /** step → its note, exactly on the notation's grid: a 4096-TET word, or a
   *  65536-TET pitch (sixteenths of a unit) in a format-3 song. */
  word(step) {
    if (!Number.isInteger(step)) throw new MotifError(`a pitch is a whole number of steps, not ${step}`);
    const p = Math.floor(step / this.n);
    const w = ANCHOR_NOTE + (p - 4) * this.interval + this.table[step - p * this.n];
    if (w < 0x20 || w > (this.fine ? 0xffff + 15 / 16 : 0xffff)) throw new MotifError(`${this.nameOf(step)} (step ${step}) is outside the playable range`);
    return w;
  }

  /** The step a note word sits on exactly, or null when it is off the grid. */
  stepOfWord(w) {
    const p = Math.floor((w - ANCHOR_NOTE) / this.interval) + 4;
    for (let q = p - 1; q <= p + 1; q++) {
      const d = this.table.indexOf(w - ANCHOR_NOTE - (q - 4) * this.interval);
      if (d >= 0) return q * this.n + d;
    }
    return null;
  }

  /** The name of a note word that sits exactly on the grid, or null. */
  nameOfWord(w) {
    const p = Math.floor((w - ANCHOR_NOTE) / this.interval) + 4;
    for (let q = p - 1; q <= p + 1; q++) {
      const d = this.table.indexOf(w - ANCHOR_NOTE - (q - 4) * this.interval);
      if (d >= 0) return this.nameOf(q * this.n + d);
    }
    return null;
  }

  /** The step nearest a MIDI key (60 = C4); a tie takes the lower step, so a
   *  tritone reads as the sharp a GM drum map spells it. */
  midi(key) {
    const target = ANCHOR_NOTE + ((key - 60) * 4096) / 12;
    const p0 = Math.floor((target - ANCHOR_NOTE) / this.interval) + 4;
    let best = null, bestD = Infinity;
    for (let p = p0 - 1; p <= p0 + 1; p++) {
      for (let d = 0; d < this.n; d++) {
        const w = ANCHOR_NOTE + (p - 4) * this.interval + this.table[d];
        const dist = Math.abs(w - target);
        const step = p * this.n + d;
        if (dist < bestD - 1e-9 || (Math.abs(dist - bestD) <= 1e-9 && step < best)) { best = step; bestD = dist; }
      }
    }
    return best;
  }

  example() {
    const d = this.names.findIndex(Boolean);
    return d < 0 ? "C4" : `${this.names[d]}4`;
  }
}

const EDO_NAME = /^(\d+)[- ]?(?:tet|edo)$/i;

/** An equal division of the octave as a custom notation in slot 0, its degrees
 *  named by the nearest quarter-tone (the Notation Maker's default). */
function customEdo(n, name) {
  if (!Number.isInteger(n) || n < 1 || n > 4096) throw new MotifError(`an equal temperament needs 1 to 4096 steps, not ${n}`);
  const table = [];
  for (let k = 0; k < n; k++) table.push((k * 4096) / n); // exact: setFine rounds
  return customDef(name ?? `${n}-TET`, table, 0x1000, null);
}

function customDef(name, table, interval, names) {
  // Checked, and its names chosen, in the whole units a format-2 song holds;
  // the exact degrees ride along for setFine to round.
  const whole = { slot: 0, flags: 0, interval: Math.round(interval), base: 0, name, table: table.map(Math.round), syms: [] };
  const issues = validateDef(whole);
  if (issues.length) throw new MotifError(`the tuning "${name}" is not valid (${issues.join(", ")})`);
  whole.syms = names ? names.map(nameToSym) : autoAssignSyms(whole, "nearest");
  if (whole.syms.length !== table.length) throw new MotifError(`the tuning "${name}" has ${table.length} degrees but ${whole.syms.length} names`);
  const notation = notationValueForSlot(0);
  return new Tuning(notation, { name, table, interval, sym: whole.syms }, whole);
}

/** "C#" → " C#", "uD" → "uD-", "C" → " C-" (the notation table's own tokens). */
function nameToSym(nm) {
  const m = /^([udUD]?)([A-J])([-#btpxB34T]?)$/.exec(String(nm));
  if (!m) throw new MotifError(`"${nm}" cannot be a degree name: a name is a letter A–J, optionally an up/down tick (u d U D) before it and an accidental (# b t p x B 3 4 T) after it`);
  return (m[1] || " ") + m[2] + (m[3] || "-");
}

/**
 * The tuning a `song { tuning: … }` value selects:
 *   "31-TET", "53-TET (Kite)", "Shi'er lü"  a built-in notation, by name
 *   310                                       …or by its notation number
 *   "29-TET" with no built-in                 an equal temperament, made custom
 *   { name, edo: 29 }                         the same, named
 *   { name, cents: [0, 182.4, …], period: 1200, names: […] }   any scale
 */
export function tuningFrom(spec, rec = null) {
  if (typeof spec === "number") {
    const p = pitchTablePresets[spec];
    if (!p) throw new MotifError(`${spec} is not a notation number Microtone knows`);
    return presetTuning(p);
  }
  if (typeof spec === "string") {
    const want = spec.trim().toLowerCase();
    const hit = Object.values(pitchTablePresets).find((p) => p.name.toLowerCase() === want);
    if (hit) return presetTuning(hit);
    const m = EDO_NAME.exec(spec.trim());
    if (m) {
      const n = Number(m[1]);
      const reg = pitchTablePresets[n * 10];
      if (reg && reg.interval === 0x1000 && reg.table.length === n) return presetTuning(reg);
      return customEdo(n, `${n}-TET`);
    }
    const names = Object.values(pitchTablePresets).map((p) => `"${p.name}"`).join(", ");
    throw new MotifError(`"${spec}" is not a tuning Microtone knows. Built in: ${names}; or write "N-TET" for any equal temperament`);
  }
  if (rec) {
    const name = rec.get("name") ?? "Custom";
    if (rec.has("edo")) return customEdo(rec.get("edo"), name);
    if (rec.has("cents")) {
      const cents = rec.get("cents");
      if (!Array.isArray(cents) || !cents.length) throw new MotifError("a tuning's cents is a list of the degrees' offsets, starting at 0");
      const period = rec.get("period") ?? 1200;
      const toUnits = (c) => (c * 4096) / 1200; // exact: setFine rounds
      const names = rec.get("names") ?? null;
      return customDef(name, cents.map(toUnits), toUnits(period), names);
    }
    throw new MotifError("a custom tuning gives edo: N or cents: [...]");
  }
  throw new MotifError("tuning must be a notation's name, its number, or a record");
}

function presetTuning(p) {
  if (p.interval === 0) throw new MotifError(`${p.name} names a fixed list of notes rather than a scale of periods; Motif cannot count steps in it`);
  if (!p.table.length) throw new MotifError(`${p.name} has no degrees to count`);
  return new Tuning(p.index, p);
}
