// A sketch — Touch's whole document — and how it becomes a Taud song.
//
// The model is deliberately much smaller than Taud's: LANES lanes, each
// playing ONE preset; a song is a run of SECTIONS, and a section is one cue,
// one 64-row pattern per lane. A cell holds a note (or a key-off) and at most
// one of a handful of effects, with no volume and no pan column. Everything
// the full tracker can say about a song is still reachable afterwards:
// Microtone opens a sketch saved online as an ordinary project.
//
// A sketch travels as a .mtsk (core/sketch/mtsk.js): the Taud pattern images
// and a header, without the instrument pack, which every app that opens one
// builds for itself. What it PLAYS as is decided there, once, for Touch's
// transport and for Microtone alike.
//
// An effect here LASTS: written on a note, it carries on down the lane until
// the next note or key-off. Taud's own G/H/Q/D act only on the rows that
// carry them, so the export writes the command on every row of that run —
// which is exactly what a tracker user would have typed.

import { PATTERN_SIZE } from "../core/format/taud-const.js";
import { writeTaud } from "../core/format/taud-write.js";
import {
  writeSketch, parseSketch, sketchTaudDoc, mtskPattern,
  MTSK_PATTERN_BYTES, MTSK_SECTIONS, MTSK_TICKS_PER_ROW, MTSK_EXTENSION,
} from "../core/sketch/mtsk.js";
import { EffectOp } from "../core/engine/tables.js";
import { DRUMS, PRESETS, presetById } from "../core/sketch/pack.js";

export const LANES = 8;
export const ROWS = 64;
export const MAX_SECTIONS = MTSK_SECTIONS;
export const NOTE_OFF = 0x0001;
export const SKETCH_VERSION = 1;
/** Ticks per row. Fixed: a sketch has a tempo, not a speed. */
export const TICKS_PER_ROW = MTSK_TICKS_PER_ROW;

/**
 * The tunings Touch offers. `notation` is the sMet notation index (§9.6) —
 * which pitch table the degrees come from — and `baseNote` / `freq` the
 * song's tuning declaration (§4 Tuning). `name` is English, for messages and
 * the tests; the page shows the language's own (lang/*.js tuning.<id>, and
 * tuning.edo for the equal divisions). Most declare concert pitch, A4 at
 * 440 Hz; the two Shi'er lü standards are the same twelve lü pitched by their
 * own conventions, C4 at 262 Hz (the Chinese a-ak) and at 311 Hz (the Korean
 * hyang-ak), and they travel as that declaration, not as different degrees.
 */
const CONCERT = { baseNote: 0x5c00, freq: 440 };
const edo = (n) => ({ id: String(n), notation: n * 10, name: `${n}-TET`, ...CONCERT });
export const TUNINGS = Object.freeze([
  ...[4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 19, 22, 24, 31, 41, 43, 53].map(edo),
  { id: "bp", notation: 35130, name: "Bohlen–Pierce", ...CONCERT },
  { id: "aak", notation: 10123, name: "A-ak (C 262 Hz)", baseNote: 0x5000, freq: 262 },
  { id: "hyangak", notation: 10123, name: "Hyang-ak (C 311 Hz)", baseNote: 0x5000, freq: 311 },
].map(Object.freeze));
export const DEFAULT_TUNING = "12";
export const tuningById = (id) => TUNINGS.find((t) => t.id === id) ?? tuningById(DEFAULT_TUNING);

/** The handful of effects — Slide, Vibrato, Roll and Fade, as the language
 *  names them (lang/*.js fx.<id>). `args` are the light / medium / strong
 *  settings. */
export const FX = Object.freeze({
  slide: { op: EffectOp.OP_G, args: [0x0040, 0x0100, 0x0400] },
  vibrato: { op: EffectOp.OP_H, args: [0x7120, 0x7140, 0x7180] },
  roll: { op: EffectOp.OP_Q, args: [0x0300, 0x0200, 0x0100] },
  fade: { op: EffectOp.OP_D, args: [0x0100, 0x0200, 0x0400] },
});
export const FX_IDS = Object.freeze(Object.keys(FX));

const DEFAULT_LANES = ["piano", "bass", "drums", "pad", "pluck", "lead", "epiano", "organ"];

export function emptySection() {
  return { cells: Array.from({ length: LANES }, () => new Array(ROWS).fill(null)) };
}

export function newSketch() {
  return {
    v: SKETCH_VERSION,
    name: "Sketch",
    bpm: 120,
    tuning: DEFAULT_TUNING,
    loop: true,
    lanes: DEFAULT_LANES.map((preset) => ({ preset, mute: false })),
    sections: [emptySection()],
  };
}

const clampInt = (v, lo, hi, dflt) =>
  Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

function normaliseCell(c) {
  if (!c || typeof c !== "object") return null;
  if (c.n === NOTE_OFF) return { n: NOTE_OFF };
  if (!Number.isInteger(c.n) || c.n < 0x20 || c.n > 0xffff) return null;
  const out = { n: c.n };
  if (Number.isInteger(c.d) && c.d >= 0 && c.d < DRUMS.length) out.d = c.d;
  if (FX_IDS.includes(c.fx)) { out.fx = c.fx; out.lv = clampInt(c.lv, 0, 2, 1); }
  return out;
}

/** A sketch from untrusted JSON (local storage, an older version): whatever
 *  does not fit the model is dropped rather than trusted. */
export function normaliseSketch(obj) {
  const s = newSketch();
  if (!obj || typeof obj !== "object" || obj.v !== SKETCH_VERSION) return s;
  if (typeof obj.name === "string" && obj.name.trim()) s.name = obj.name.slice(0, 64);
  s.bpm = clampInt(obj.bpm, 30, 300, s.bpm);
  if (TUNINGS.some((t) => t.id === obj.tuning)) s.tuning = obj.tuning;
  else if (TUNINGS.some((t) => t.notation === obj.notation)) {
    s.tuning = TUNINGS.find((t) => t.notation === obj.notation).id; // a sketch from before tuning ids
  }
  s.loop = obj.loop !== false;
  if (Array.isArray(obj.lanes)) {
    s.lanes = s.lanes.map((dflt, l) => {
      const src = obj.lanes[l];
      return {
        preset: PRESETS.some((p) => p.id === src?.preset) ? src.preset : dflt.preset,
        mute: src?.mute === true,
      };
    });
  }
  if (Array.isArray(obj.sections) && obj.sections.length > 0) {
    s.sections = obj.sections.slice(0, MAX_SECTIONS).map((sec) => {
      const out = emptySection();
      for (let l = 0; l < LANES; l++) {
        for (let r = 0; r < ROWS; r++) out.cells[l][r] = normaliseCell(sec?.cells?.[l]?.[r]);
      }
      return out;
    });
  }
  return s;
}

/** A short fingerprint of everything a sketch holds — FNV-1a over its JSON,
 *  and the JSON's length — to tell whether it has changed since it was saved. */
export function sketchDigest(sketch) {
  const json = JSON.stringify(sketch);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}:${json.length}`;
}

/** True when nothing has been written yet. */
export function isBlank(sketch) {
  return sketch.sections.every((sec) => sec.cells.every((lane) => lane.every((c) => c === null)));
}

// ── to and from the file ─────────────────────────────────────────────────────

/** Pattern number of `lane` in `section` — fixed, so an edit re-uploads one. */
export const patternSlot = mtskPattern;

/** The instrument a cell plays on a lane holding `preset`. */
function cellInstrument(cell, preset, bank) {
  const slot = bank.slots[preset];
  return Array.isArray(slot) ? slot[cell.d ?? 0] : slot;
}

/** One lane of one section as a version-2 pattern image (8-byte cells),
 *  written into `out` at `offset` when given. */
export function patternBytes(sketch, section, lane, bank, out = new Uint8Array(PATTERN_SIZE), offset = 0) {
  const bytes = out.subarray(offset, offset + PATTERN_SIZE);
  const preset = sketch.lanes[lane].preset;
  const cells = sketch.sections[section].cells[lane];
  let fx = null; // the effect still running from the last note: [op, arg]
  for (let r = 0; r < ROWS; r++) {
    const o = r * 8;
    bytes[o + 3] = 0xc0; // FINE by zero: "no volume intent" (§5)
    bytes[o + 4] = 0xc0;
    const c = cells[r];
    if (c) {
      bytes[o] = c.n & 0xff;
      bytes[o + 1] = c.n >>> 8;
      if (c.n === NOTE_OFF) {
        fx = null;
      } else {
        bytes[o + 2] = cellInstrument(c, preset, bank);
        fx = c.fx ? [FX[c.fx].op, FX[c.fx].args[c.lv ?? 1]] : null;
      }
    }
    if (fx) {
      bytes[o + 5] = fx[0];
      bytes[o + 6] = fx[1] & 0xff;
      bytes[o + 7] = fx[1] >>> 8;
    }
  }
  return out;
}

/** An empty lane: no notes, both columns at "no intent". */
function emptyPattern(out, offset) {
  for (let r = 0; r < ROWS; r++) {
    out[offset + r * 8 + 3] = 0xc0;
    out[offset + r * 8 + 4] = 0xc0;
  }
}

/** The sketch as the file's fields (core/sketch/mtsk.js writeSketch). */
export function sketchFields(sketch, bank) {
  const patterns = new Uint8Array(MTSK_PATTERN_BYTES);
  for (let s = 0; s < MTSK_SECTIONS; s++) {
    for (let l = 0; l < LANES; l++) {
      const at = patternSlot(s, l) * PATTERN_SIZE;
      if (s < sketch.sections.length) patternBytes(sketch, s, l, bank, patterns, at);
      else emptyPattern(patterns, at);
    }
  }
  const tuning = tuningById(sketch.tuning);
  return {
    name: sketch.name,
    bpm: sketch.bpm,
    loop: sketch.loop,
    sections: sketch.sections.length,
    notation: tuning.notation,
    tuning: { baseNote: tuning.baseNote, freq: tuning.freq },
    patterns,
  };
}

/**
 * The parsed-document shape parseTaud returns (and AudioSystem.loadDocument
 * and writeTaud take) — exactly what Microtone makes of the saved file. With
 * `only` set, the song is that one section looping, which is what the
 * transport plays while a section is being worked on.
 */
export function toTaudDoc(sketch, bank, { only = null } = {}) {
  return sketchTaudDoc(sketchFields(sketch, bank), bank, { only });
}

/** The .taud bytes — the file a download carries, which opens anywhere. */
export function sketchToTaud(sketch, bank) {
  return writeTaud(toTaudDoc(sketch, bank));
}

/** The .mtsk bytes — what an online save puts there. */
export function sketchToFile(sketch, bank) {
  return writeSketch(sketchFields(sketch, bank));
}

/**
 * A .mtsk file read back into a sketch. What the model cannot hold is left
 * behind: a lane plays the preset of its first note's instrument (an empty
 * lane keeps its default), a note's effect is the one on its own row when it
 * is one of the four at one of their three settings, and the volume and pan
 * columns, other effects and other sentinels are dropped. Throws
 * SketchFormatError for a file the format calls INVALID.
 */
export function sketchFromFile(bytes, bank) {
  const file = parseSketch(bytes);
  const byInst = new Map(); // instrument slot → { preset, d }
  for (const [preset, slot] of Object.entries(bank.slots)) {
    if (Array.isArray(slot)) slot.forEach((inst, d) => byInst.set(inst, { preset, d }));
    else byInst.set(slot, { preset });
  }
  const fxByWord = new Map(); // op << 16 | arg → { fx, lv }
  for (const id of FX_IDS) FX[id].args.forEach((arg, lv) => fxByWord.set(FX[id].op * 65536 + arg, { fx: id, lv }));

  const at = (s, l, r) => (patternSlot(s, l) * ROWS + r) * 8;
  const p = file.patterns;
  const lanes = newSketch().lanes.map((dflt, l) => {
    for (let s = 0; s < file.sections; s++) {
      for (let r = 0; r < ROWS; r++) {
        const o = at(s, l, r);
        if ((p[o] | (p[o + 1] << 8)) >= 0x20 && byInst.has(p[o + 2])) {
          return { preset: byInst.get(p[o + 2]).preset, mute: false };
        }
      }
    }
    return dflt;
  });
  const sections = Array.from({ length: file.sections }, (_, s) => ({
    cells: lanes.map((lane, l) => Array.from({ length: ROWS }, (_, r) => {
      const o = at(s, l, r);
      const n = p[o] | (p[o + 1] << 8);
      if (n === NOTE_OFF) return { n };
      if (n < 0x20) return null;
      const cell = { n };
      const inst = byInst.get(p[o + 2]);
      if (inst?.preset === lane.preset && inst.d !== undefined) cell.d = inst.d;
      const fx = fxByWord.get(p[o + 5] * 65536 + (p[o + 6] | (p[o + 7] << 8)));
      if (fx) Object.assign(cell, fx);
      return cell;
    })),
  }));
  const tuning = TUNINGS.find((t) => t.notation === file.notation &&
    t.baseNote === file.tuning.baseNote && t.freq === file.tuning.freq);
  return normaliseSketch({
    v: SKETCH_VERSION,
    name: file.name || "Sketch",
    bpm: file.bpm,
    tuning: tuning?.id,
    notation: file.notation, // no exact match: the nearest by notation alone
    loop: file.loop,
    lanes,
    sections,
  });
}

/** A file name for the sketch: the name, made safe for every filesystem —
 *  `.taud` for the file a download carries, MTSK_EXTENSION online. */
export function sketchFileName(sketch, ext = ".taud") {
  const base = sketch.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").trim() || "Sketch";
  return `${base}${ext}`;
}

export { MTSK_EXTENSION };

export { presetById };
