// A sketch — Touch's whole document — and how it becomes a Taud song.
//
// The model is deliberately much smaller than Taud's: LANES lanes, each
// playing ONE preset; a song is a run of SECTIONS, and a section is one cue,
// one 64-row pattern per lane. A cell holds a note (or a key-off) and at most
// one of a handful of effects, with no volume and no pan column. Everything
// the full tracker can say about a song is still reachable afterwards: the
// sketch is sent as an ordinary .taud and Microtone opens it like any other.
//
// An effect here LASTS: written on a note, it carries on down the lane until
// the next note or key-off. Taud's own G/H/Q/D act only on the rows that
// carry them, so the export writes the command on every row of that run —
// which is exactly what a tracker user would have typed.

import { CUE_EMPTY, NUM_VOICES, PATTERN_SIZE } from "../core/format/taud-const.js";
import { writeTaud } from "../core/format/taud-write.js";
import { escapeNonAscii } from "../core/format/names.js";
import { EffectOp } from "../core/engine/tables.js";
import { DRUMS, PRESETS, presetById } from "./presets.js";

export const LANES = 8;
export const ROWS = 64;
export const MAX_SECTIONS = 16;
export const NOTE_OFF = 0x0001;
export const SKETCH_VERSION = 1;
/** Ticks per row. Fixed: a sketch has a tempo, not a speed. */
export const TICKS_PER_ROW = 6;
/** The 14-byte header signature (TAUD_FILE_FORMAT.md §2) — diagnostics only. */
export const SIGNATURE = "MicrotoneTouch";

/**
 * The tunings Touch offers. `notation` is the sMet notation index (§9.6) —
 * which pitch table the degrees come from — and `baseNote` / `freq` the
 * song's tuning declaration (§4 Tuning). Most declare concert pitch, A4 at
 * 440 Hz; the two Shi'er lü standards are the same twelve lü pitched by their
 * own conventions, C4 at 262 Hz (the Chinese a-ak) and at 311 Hz (the Korean
 * hyang-ak), and they travel as that declaration, not as different degrees.
 */
const CONCERT = { baseNote: 0x5c00, freq: 440 };
const edo = (n) => ({ id: String(n), notation: n * 10, name: `${n}-TET`, ...CONCERT });
export const TUNINGS = Object.freeze([
  ...[4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 19, 22, 24, 31, 41, 53].map(edo),
  { id: "bp", notation: 35130, name: "Bohlen–Pierce", ...CONCERT },
  { id: "aak", notation: 10123, name: "A-ak (C 262 Hz)", baseNote: 0x5000, freq: 262 },
  { id: "hyangak", notation: 10123, name: "Hyang-ak (C 311 Hz)", baseNote: 0x5000, freq: 311 },
].map(Object.freeze));
export const DEFAULT_TUNING = "12";
export const tuningById = (id) => TUNINGS.find((t) => t.id === id) ?? tuningById(DEFAULT_TUNING);

/** The handful of effects. `args` are the light / medium / strong settings. */
export const FX = Object.freeze({
  slide: { name: "Slide", op: EffectOp.OP_G, args: [0x0040, 0x0100, 0x0400] },
  vibrato: { name: "Vibrato", op: EffectOp.OP_H, args: [0x7120, 0x7140, 0x7180] },
  roll: { name: "Roll", op: EffectOp.OP_Q, args: [0x0300, 0x0200, 0x0100] },
  fade: { name: "Fade", op: EffectOp.OP_D, args: [0x0100, 0x0200, 0x0400] },
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
    sent: null, // { id, etag } of the online project this was last sent as
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
  if (obj.sent && typeof obj.sent.id === "string") {
    s.sent = { id: obj.sent.id, etag: typeof obj.sent.etag === "string" ? obj.sent.etag : null };
  }
  return s;
}

/** True when nothing has been written yet. */
export function isBlank(sketch) {
  return sketch.sections.every((sec) => sec.cells.every((lane) => lane.every((c) => c === null)));
}

// ── to Taud ──────────────────────────────────────────────────────────────────

/** Pattern number of `lane` in `section` — fixed, so an edit re-uploads one. */
export const patternSlot = (section, lane) => section * LANES + lane;

/** The instrument a cell plays on a lane holding `preset`. */
function cellInstrument(cell, preset, bank) {
  const slot = bank.slots[preset];
  return Array.isArray(slot) ? slot[cell.d ?? 0] : slot;
}

/** One lane of one section as a version-2 pattern image (8-byte cells). */
export function patternBytes(sketch, section, lane, bank) {
  const bytes = new Uint8Array(PATTERN_SIZE);
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
  return bytes;
}

/** The cue's lane words with `word0` spread over lanes 0…15's sign bits (§6.2). */
function cueWords(section, word0) {
  const words = new Uint16Array(64).fill(CUE_EMPTY);
  for (let l = 0; l < LANES; l++) words[l] = patternSlot(section, l);
  for (let c = 0; c < 16; c++) {
    if ((word0 >>> c) & 1) words[c] |= 0x8000;
  }
  return words;
}

const JMP_TO_START = 0xf000; // JMP 0 — "this is how a song loops"
const HALT = 0x0100;

function utf8z(s) {
  return Uint8Array.from([...new TextEncoder().encode(s), 0]);
}

function projSections(sketch, bank) {
  const enc = new TextEncoder();
  const name = escapeNonAscii(sketch.name);
  const inam = enc.encode(bank.names.map(escapeNonAscii).join("\x1e"));
  const { notation } = tuningById(sketch.tuning);
  const smetBody = [
    notation & 0xff, notation >>> 8,
    4, 16, // beat divisions: four rows a beat, sixteen a bar
    ...utf8z(name), 0, 0, // song name; no composer, no copyright
  ];
  const smet = new Uint8Array(5 + smetBody.length);
  smet[0] = 0; // song index
  new DataView(smet.buffer).setUint32(1, smetBody.length, true);
  smet.set(smetBody, 5);
  return [
    { fourcc: "PNam", payload: utf8z(name) },
    { fourcc: "INam", payload: inam },
    { fourcc: "sMet", payload: smet },
  ];
}

/**
 * The parsed-document shape parseTaud returns (and AudioSystem.loadDocument
 * and writeTaud take). With `only` set, the song is that one section looping
 * — what the transport plays while a section is being worked on; the
 * patterns are always all of them, so pattern numbers never move.
 */
export function toTaudDoc(sketch, bank, { only = null } = {}) {
  const tuning = tuningById(sketch.tuning);
  const patterns = [];
  for (let s = 0; s < sketch.sections.length; s++) {
    for (let l = 0; l < LANES; l++) patterns.push(patternBytes(sketch, s, l, bank));
  }
  const order = only === null ? sketch.sections.map((_, i) => i) : [only];
  const cues = order.map((s, i) => {
    const last = i === order.length - 1;
    return cueWords(s, last ? (sketch.loop || only !== null ? JMP_TO_START : HALT) : 0);
  });
  return {
    kind: "taud",
    fmtVer: 2,
    is64Channel: false,
    signature: SIGNATURE,
    sampleInstImage: bank.image,
    songs: [{
      numVoices: NUM_VOICES,
      numPats: patterns.length,
      bpm: sketch.bpm,
      tickRate: TICKS_PER_ROW,
      tuningBaseNote: tuning.baseNote,
      tuningFreq: tuning.freq,
      globalFlags: 0,
      globalVolume: 0x80,
      mixingVolume: 0x80,
      surroundModel: 0,
      numCuesStored: cues.length,
      patterns,
      cues,
    }],
    projSections: projSections(sketch, bank),
    ixmp: [],
  };
}

/** The .taud bytes Microtone receives. */
export function sketchToTaud(sketch, bank) {
  return writeTaud(toTaudDoc(sketch, bank));
}

/** A file name for the sketch: the name, made safe for every filesystem. */
export function sketchFileName(sketch) {
  const base = sketch.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").trim() || "Sketch";
  return `${base}.taud`;
}

export { presetById };
