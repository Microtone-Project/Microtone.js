// Export a song as a ProTracker module (item 219) — the inverse of
// vendor/converters/mod2taud.py, and written as one: every mapping here undoes
// the one the importer makes (TAUD_NOTE_EFFECTS.md, "ProTracker to Taud
// conversion table"), so a .mod that was imported comes back out as the same
// music. A song written in Microtone gets the same treatment, provided it
// keeps to what a four-channel Amiga module can say.
//
// Two kinds of finding come back with every song:
//
// - ERRORS are the prerequisites. Any one of them stops the export: more than
//   four lanes with music on them, pitch slides not in Amiga periods, a tempo
//   or speed out of ProTracker's range, an effect it has no word for, a
//   metainstrument (an OPL or PSG instrument is not one of those: it is
//   bounced into a sample, see modchip.js).
// - WARNINGS are what the module will not keep exactly: a microtonal song (its
//   notes become raw Amiga periods, which ProTracker plays but other trackers
//   may not), notes beyond ProTracker's three octaves, column commands that
//   shared a row with an effect, arguments rounded to fit.
//
// Both are {code, args, count, where} records, so the UI words them (lang/).
//
// Pure: no DOM. The chip bounce runs the engine, which is pure as well, so the
// whole export runs in Node too (tools/taud2mod.js).

import { EffectOp, tuningRatioOf } from "../../core/engine/tables.js";
import { MIDDLE_C } from "../../core/engine/constants.js";
import { envPresent } from "../../core/engine/envelope.js";
import { CUE_EMPTY } from "../../core/format/taud-const.js";
import { PT_PERIODS } from "../../core/tuning/pitchtables.js";
import { unescapeName } from "../../core/format/names.js";
import { cueInfo } from "../doc/document.js";
import { resample } from "../doc/wavelab.js";
import { bounceImage, referenceSlot, referenceLevel, bounceChipInstrument } from "./modchip.js";

export const MOD_CHANNELS = 4;
export const MOD_SAMPLES = 31;
export const MOD_ORDERS = 128;
/** A sample's length is a 16-bit count of words. */
export const MOD_SAMPLE_MAX = 0xffff * 2;

const SEMITONE = 4096 / 12;
const FINETUNE_STEP = 4096 / 96;            // one finetune unit is 1/8 semitone
const PT_REFERENCE_PERIOD = 428;            // ≡ Taud C4, as mod2taud anchors it
const PT_RANGE_LOW = 856;                   // ProTracker's own three octaves
const PT_RANGE_HIGH = 113;
const PERIOD_MAX = PT_PERIODS[0];           // the table's de-facto extension
const PERIOD_MIN = PT_PERIODS[PT_PERIODS.length - 1];
const PT_C4_INDEX = PT_PERIODS.indexOf(PT_REFERENCE_PERIOD);
// ProTracker's table strays up to ~6 cents from 12-TET; a note within 7 cents
// of the 12-tone grid is a 12-tone note.
const TWELVE_TONE_TOLERANCE = 24;
// C9 @ 8363, A4 @ 440 and C4 @ 262 lie within 2.5 cents of each other.
const TUNING_TOLERANCE_CENTS = 3;
const BPM_MIN = 32, BPM_MAX = 255, SPEED_MAX = 31;

// mod2taud's tables, read backwards.
const J_SEMI = [0x00, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x09,
  0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x13, 0x14];
const FUNK = [0, 5, 6, 7, 8, 0x0a, 0x0b, 0x0d, 0x10, 0x13, 0x16, 0x1a, 0x20, 0x2b, 0x40, 0x80];

const OP = EffectOp;
// Note-word sentinels; the interrupt markers ($10…$1F) play nothing and stay behind.
const NOTE_KEYOFF = 1, NOTE_CUT = 2, NOTE_FADE = 3, NOTE_FAST_FADE = 4;
const SEL_SET = 0, SEL_UP = 1, SEL_DOWN = 2, SEL_FINE = 3;

// ── findings ────────────────────────────────────────────────────────────────

function findings() {
  const map = new Map();
  return {
    add(code, args = {}, where = null) {
      const key = code + "\u0000" + JSON.stringify(args);
      const f = map.get(key);
      if (f) f.count++;
      else map.set(key, { code, args, count: 1, where });
    },
    list() { return [...map.values()]; },
    get size() { return map.size; },
  };
}

/** The effect's letter as the grid shows it (notenames.js fxOpChar). */
function opChar(op) {
  return op >= 0xa0 ? String.fromCharCode(op - 0x80) : op.toString(36).toUpperCase();
}

const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, "0");

// ── song structure ──────────────────────────────────────────────────────────

/** The cues the module plays: cue 0 up to the last one with content, or to the
 *  first that halts. One cue is one order. */
function playedCues(song) {
  const last = song.lastUsedCue();
  for (let c = 0; c <= last; c++) if (cueInfo(song.cues[c]).isHalt) return c + 1;
  return last + 1;
}

/**
 * One lane's rows as the engine plays them in one cue: Pattern Ditto (effect
 * 7) expanded exactly as core/engine/row.js does it, rows past the cue's
 * length left out. Null when the lane has no pattern there.
 */
function playedRows(doc, songIndex, word, rowLimit) {
  const p = word & 0x7fff;
  if (p === CUE_EMPTY) return null;
  const pat = doc.patternAt(songIndex, p);
  if (!pat) return null;
  const out = [];
  let active = false, srcStart = 0, len = 0, endRow = 0;
  for (let n = 0; n < rowLimit; n++) {
    const raw = pat[n];
    const isArmer = raw.effect === OP.OP_7 && raw.effectArg !== 0;
    if (isArmer) {
      const l = (raw.effectArg >>> 8) & 0xff;
      const repeats = raw.effectArg & 0xff;
      if (l > 0 && repeats > 0 && l <= n) {
        srcStart = n - l;
        len = l;
        endRow = Math.min(n + l * repeats - 1, rowLimit - 1);
        active = true;
      }
    }
    let cell = {
      note: raw.note, inst: raw.instrment, vol: raw.volume, volEff: raw.volumeEff,
      pan: raw.pan, panEff: raw.panEff, fx: raw.effect, arg: raw.effectArg,
    };
    if (active && n >= srcStart + len && n <= endRow) {
      const src = pat[srcStart + ((n - srcStart) % len)];
      const volSet = !(raw.volumeEff === SEL_FINE && raw.volume === 0);
      const panSet = !(raw.panEff === SEL_FINE && raw.pan === 0);
      const destOp = isArmer ? 0 : raw.effect;
      const destArg = isArmer ? 0 : raw.effectArg;
      let fx = 0, arg = 0;
      if (destOp !== 0) { fx = destOp; arg = destArg; }
      else if (src.effect !== OP.OP_7) { fx = src.effect; arg = src.effectArg; }
      cell = {
        note: raw.note !== 0 ? raw.note : src.note,
        inst: raw.instrment !== 0 ? raw.instrment : src.instrment,
        vol: volSet ? raw.volume : src.volume,
        volEff: volSet ? raw.volumeEff : src.volumeEff,
        pan: panSet ? raw.pan : src.pan,
        panEff: panSet ? raw.panEff : src.panEff,
        fx, arg,
      };
    }
    // A ditto command plays nothing of its own once it has been expanded.
    if (cell.fx === OP.OP_7) { cell.fx = 0; cell.arg = 0; }
    out.push(cell);
  }
  return out;
}

/** True when the cell makes any sound or changes anything a module keeps. The
 *  panning column does not count: the importer writes one on row 0 of every
 *  pattern, and a module's channels sit where Amiga hardware puts them. */
function hasMusic(cell) {
  return cell.note !== 0 || cell.inst !== 0 || cell.fx !== 0 ||
    !(cell.volEff === SEL_FINE && cell.vol === 0);
}

/** ProTracker hard-pans its channels L R R L — the pans mod2taud writes on row 0. */
function amigaPan(ch) {
  return ch % 4 === 0 || ch % 4 === 3 ? 8 : 55;
}

// ── effects ─────────────────────────────────────────────────────────────────

/** A byte nibble-repeated by the importer ($xx = x × $11), read back. */
function nibbleOf(b, rounded) {
  if (b === 0) return 0;
  const x = Math.min(15, Math.max(1, Math.round(b / 17)));
  if (x * 17 !== b) rounded();
  return x;
}

function semitonesOf(b, rounded) {
  const x = Math.min(15, Math.round(b * 0.75));
  if (J_SEMI[x] !== b) rounded();
  return x;
}

function bcd(row) {
  return (Math.floor(row / 10) << 4) | (row % 10);
}

/** A Taud D/K/L-style $xy volume slide as ProTracker's Axy nibbles. Taud's
 *  "down wins" when both are set; ProTracker's up would, so only the down
 *  nibble goes across. */
function slideNibbles(xy) {
  const up = (xy >>> 4) & 0xf, down = xy & 0xf;
  return down !== 0 ? down : up !== 0 ? up << 4 : 0;
}

/**
 * The ProTracker effect for a cell's effect column: {fx, arg} (or {fx: 9, off}
 * for a sample offset, which is scaled once the sample is known), null for
 * nothing. `st` is the lane's state — the Taud effect memories are resolved
 * here, since ProTracker either has none for these effects or keeps them
 * differently. `bad(code, args)` reports a prerequisite failure, `rounded()` an
 * argument that does not survive exactly.
 */
function effectColumn(cell, st, bad, rounded) {
  const op = cell.fx, a = cell.arg;
  const hi = (a >>> 8) & 0xff, lo = a & 0xff;
  switch (op) {
    case 0: return null;
    case OP.OP_1:
      // Global behaviour flags: the module is in Amiga periods, so setting
      // them to that again says nothing.
      if ((hi & 3) === 1) return null;
      bad("effect", { fx: "1" });
      return null;
    case OP.OP_A:
      if (hi === 0) return null;
      if (hi > SPEED_MAX) { bad("speedEffect", { n: hi }); return null; }
      return { fx: 0xf, arg: hi };
    case OP.OP_T: {
      let bpm;
      if (hi >= 0xfc && lo !== 0) bpm = Math.min(0x118 + (0xff - hi) * 0xff + lo, 1048);
      else if (hi === 0xfb && lo !== 0) return null;   // reserved: ignored
      else if (hi !== 0) bpm = hi + 0x19;
      else if ((lo & 0xe0) === 0 && (lo & 0x0f) !== 0) { bad("effect", { fx: "T $00xy" }); return null; }
      else return null;
      if (bpm < BPM_MIN || bpm > BPM_MAX) { bad("tempoEffect", { bpm }); return null; }
      return { fx: 0xf, arg: bpm };
    }
    case OP.OP_B:
      if (a > 0x7f) rounded();
      return { fx: 0xb, arg: Math.min(a, 0x7f) };
    case OP.OP_C:
      if (a > 63) rounded();
      return { fx: 0xd, arg: bcd(Math.min(a, 63)) };
    case OP.OP_D: {
      const v = a !== 0 ? a : st.mem.d;
      if (a !== 0) st.mem.d = a;
      const b = (v >>> 8) & 0xff, up = (b >>> 4) & 0xf, down = b & 0xf;
      if (b === 0xff || b === 0xf0) return { fx: 0xe, arg: 0xaf };
      if (up === 0xf && down !== 0) return { fx: 0xe, arg: 0xb0 | down };
      if (down === 0xf && up !== 0) return { fx: 0xe, arg: 0xa0 | up };
      if (up === 0 && down !== 0) return { fx: 0xa, arg: down };
      if (down === 0 && up !== 0) return { fx: 0xa, arg: up << 4 };
      return null; // both nibbles: the engine slides neither way
    }
    case OP.OP_E:
    case OP.OP_F: {
      const v = a !== 0 ? a : st.mem.ef;
      if (a !== 0) st.mem.ef = a;
      if (v === 0) return null;
      const upward = op === OP.OP_F;
      if ((v & 0xf000) === 0xf000) {
        const mag = v & 0x0fff;
        if (mag === 0) return null;
        if (mag > 0xf) rounded();
        return { fx: 0xe, arg: (upward ? 0x10 : 0x20) | Math.min(mag, 0xf) };
      }
      if (v > 0xff) rounded();
      return { fx: upward ? 1 : 2, arg: Math.min(v, 0xff) };
    }
    case OP.OP_G: {
      if (a === 0) return { fx: 3, arg: 0 };
      const s = Math.min(0xff, Math.max(1, Math.round((a * 3) / 64)));
      if (Math.round((s * 64) / 3) !== a) rounded();
      return { fx: 3, arg: s };
    }
    case OP.OP_H:
      return { fx: 4, arg: (nibbleOf(hi, rounded) << 4) | nibbleOf(lo, rounded) };
    case OP.OP_R:
      return { fx: 7, arg: (nibbleOf(hi, rounded) << 4) | nibbleOf(lo, rounded) };
    case OP.OP_J: {
      const v = a !== 0 ? a : st.mem.j;
      if (a !== 0) st.mem.j = a;
      if (v === 0) return null;
      const arg = (semitonesOf((v >>> 8) & 0xff, rounded) << 4) | semitonesOf(v & 0xff, rounded);
      return arg === 0 ? null : { fx: 0, arg };
    }
    case OP.OP_K:
    case OP.OP_L: {
      const key = op === OP.OP_K ? "k" : "l";
      const v = hi !== 0 ? hi : st.mem[key];
      if (hi !== 0) st.mem[key] = hi;
      const slide = slideNibbles(v);
      const vibrato = op === OP.OP_K;
      if (slide === 0) return { fx: vibrato ? 4 : 3, arg: 0 };
      return { fx: vibrato ? 6 : 5, arg: slide };
    }
    case OP.OP_O:
      if (lo !== 0) rounded();
      return { fx: 9, off: a };
    case OP.OP_Q: {
      const v = a !== 0 ? a : st.mem.q;
      const y = (v >>> 8) & 0xf;
      if (y === 0) return null; // the engine ignores the whole command, memory too
      st.mem.q = v;
      const x = (v >>> 12) & 0xf;
      if (x !== 0 && x !== 8) rounded(); // ProTracker's retrigger keeps the volume
      return { fx: 0xe, arg: 0x90 | y };
    }
    case OP.OP_S: {
      const sub = (a >>> 12) & 0xf, x = (a >>> 8) & 0xf;
      switch (sub) {
        case 0x0: return { fx: 0xe, arg: x };
        case 0x1: return { fx: 0xe, arg: 0x30 | x };
        case 0x2: return { fx: 0xe, arg: 0x50 | x };
        case 0x3: return { fx: 0xe, arg: 0x40 | x };
        case 0x4: return { fx: 0xe, arg: 0x70 | x };
        case 0x8:
          if (x !== 0) { bad("effect", { fx: "S $8xxx" }); return null; }
          return { fx: 8, arg: lo };
        case 0xb: return { fx: 0xe, arg: 0x60 | x };
        case 0xc: return x === 0 ? null : { fx: 0xe, arg: 0xc0 | x }; // S $C000 is a no-op
        case 0xd:
          if ((a & 0xff) !== 0) rounded(); // ProTracker's delay takes no follow-up action
          return x === 0 ? null : { fx: 0xe, arg: 0xd0 | x };
        case 0xe: return x === 0 ? null : { fx: 0xe, arg: 0xe0 | x };
        case 0xf:
          if (x !== 0) { bad("effect", { fx: "S $F" + hex(x, 1) + "xx" }); return null; }
          return funk(lo, rounded);
        default:
          bad("effect", { fx: "S $" + hex(sub, 1) + "x" });
          return null;
      }
    }
    case OP.OP_Z:
      // Z $F0xx is ProTracker 1.0's funk repeat, the meaning EFx began with.
      if (hi === 0xf0) return funk(lo, rounded);
      bad("effect", { fx: "Z" });
      return null;
    default:
      bad("effect", { fx: opChar(op) });
      return null;
  }
}

function funk(speed, rounded) {
  let best = 0;
  for (let i = 1; i < FUNK.length; i++) {
    if (Math.abs(FUNK[i] - speed) < Math.abs(FUNK[best] - speed)) best = i;
  }
  if (FUNK[best] !== speed) rounded();
  return { fx: 0xe, arg: 0xf0 | best };
}

/** The volume column as a ProTracker effect; `slide` marks the two forms that
 *  can ride along with a tone portamento (5xy) or a vibrato (6xy). */
function volumeColumn(cell, rounded) {
  const v = cell.vol;
  switch (cell.volEff) {
    case SEL_SET:
      // Taud's 63 is ProTracker's 64: both are the six-bit ceiling.
      return { fx: 0xc, arg: v >= 63 ? 64 : v };
    case SEL_UP:
      if (v === 0) return null;
      if (v > 0xf) rounded();
      return { fx: 0xa, arg: Math.min(v, 0xf) << 4, slide: true };
    case SEL_DOWN:
      if (v === 0) return null;
      if (v > 0xf) rounded();
      return { fx: 0xa, arg: Math.min(v, 0xf), slide: true };
    default: {
      const mag = v & 0x1f;
      if (mag === 0) return null;
      if (mag > 0xf) rounded();
      return { fx: 0xe, arg: ((v & 0x20) ? 0xa0 : 0xb0) | Math.min(mag, 0xf) };
    }
  }
}

// ── instruments ─────────────────────────────────────────────────────────────

function signed16(v) {
  return v >= 0x8000 ? v - 0x10000 : v;
}

function fadeoutOf(inst) {
  return (inst.volumeFadeoutLow & 0xff) | ((inst.fadeoutHigh & 0x0f) << 8);
}

/** Does a key-off end this instrument's note? ProTracker has no key-off, so
 *  one that matters becomes a cut. */
function releases(inst) {
  return inst.isOpl || inst.isPsg || fadeoutOf(inst) > 0 || inst.sampleLoopSustain;
}

/** A volume envelope that is more than the unit one mod2taud writes. */
function shapedVolumeEnvelope(inst) {
  if (!envPresent(inst.volEnvLoop)) return false;
  for (const p of inst.volEnvelopes) {
    if (p.value !== 63) return true;
    if (p.offset === 0) break;
  }
  return false;
}

/** What a module cannot carry of an instrument besides its sample. */
function droppedFeatures(inst) {
  return shapedVolumeEnvelope(inst) || fadeoutOf(inst) > 0 || inst.vibratoDepth > 0 ||
    inst.defaultCutoff !== 0xff || inst.imixId !== 0;
}

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/**
 * The sample an instrument plays, as the module will hold it before pitch
 * fitting: {pcm (Float32 or the pool's u8), rate, detune, loopStart, loopEnd}.
 * An instrument with a key map (Ixmp) plays the one sample the engine would
 * choose for its middle note, both channels of a stereo one mixed.
 */
function sampledSource(doc, inst, notes, warn) {
  let src = {
    ptr: inst.samplePtr, len: inst.sampleLength, rate: inst.samplingRate,
    detune: inst.sampleDetuneSigned, playStart: inst.samplePlayStart,
    loopStart: inst.sampleLoopStart, loopEnd: inst.sampleLoopEnd, loopMode: inst.loopMode,
    chanPtrs: [],
  };
  const patches = inst.extraPatches;
  if (patches !== null && patches.length > 0) {
    const patch = inst.resolvePatch(notes.length > 0 ? median(notes) : MIDDLE_C, 63) ??
      (src.len > 0 ? null : patches.find((p) => p.sampleLength > 0) ?? null);
    if (patch !== null) {
      src = {
        ptr: patch.samplePtr, len: patch.sampleLength, rate: patch.samplingRate,
        detune: signed16(patch.sampleDetune & 0xffff), playStart: patch.playStart,
        loopStart: patch.loopStart, loopEnd: patch.loopEnd, loopMode: patch.loopMode,
        chanPtrs: patch.hasChanBlock ? patch.chanPtrs.slice(0, patch.chanCount - 1) : [],
      };
    }
    const sources = new Set([inst.sampleLength > 0 ? inst.samplePtr : -1,
      ...patches.map((p) => p.samplePtr)]);
    sources.delete(-1);
    if (sources.size > 1) warn("keyMap");
  }
  if (src.len <= 0) return null;

  const bin = doc.sampleBin;
  const start = Math.min(src.playStart, src.len);
  const len = src.len - start;
  let mode = src.loopMode & 3;
  let loopStart = Math.max(0, src.loopStart - start);
  let loopEnd = Math.min(src.len, src.loopEnd) - start;
  if (mode === 3 || loopEnd - loopStart < 2) mode = 0;  // a one-shot is no loop to a module
  const channels = [src.ptr + start, ...src.chanPtrs.map((p) => p + start)];

  // A ping-pong loop is unrolled into a forward one: the loop, then its way
  // back (and what lay past it, never played, goes). Anything else keeps its
  // every byte, played or not, as the module it may have come from had them.
  const back = mode === 2 ? Math.max(0, loopEnd - loopStart - 2) : 0;
  const total = mode === 2 ? loopEnd + back : len;
  const igv = inst.instGlobalVolume & 0xff;
  if (channels.length === 1 && back === 0 && igv === 0xff) {
    return {
      pcm: bin.subarray(channels[0], channels[0] + total), u8: true, rate: src.rate,
      detune: src.detune, loopStart: mode === 0 ? -1 : loopStart, loopEnd: mode === 0 ? -1 : loopEnd,
    };
  }
  const pcm = new Float32Array(total);
  const gain = igv / 255 / channels.length / 128;
  for (let i = 0; i < total; i++) {
    const j = i < loopEnd || mode !== 2 ? i : loopEnd - 2 - (i - loopEnd);
    let acc = 0;
    for (const p of channels) acc += bin[p + j] - 128;
    pcm[i] = acc * gain;
  }
  if (back > 0) loopEnd += back;
  return {
    pcm, u8: false, rate: src.rate, detune: src.detune,
    loopStart: mode === 0 ? -1 : loopStart, loopEnd: mode === 0 ? -1 : loopEnd,
  };
}

/**
 * Pitch for one instrument: the finetune nibble, and the shift from a played
 * Taud note to the ProTracker note it sounds as. `u` is how far the sample's
 * C4 sits above an 8363 Hz one; whole semitones of it move the notes, the
 * eighths the finetune carries, and what is left over (under a sixteenth of a
 * semitone) is lost in a 12-tone song and kept in a microtonal one.
 */
function pitchPlan(rate, detune) {
  const u = rate > 0 ? 4096 * Math.log2(rate / 8363) + detune : 0;
  const steps = Math.round(u / FINETUNE_STEP);
  let semis = 0, finetune = steps;
  if (steps < -8 || steps > 7) {
    semis = Math.round(steps / 8);
    finetune = steps - 8 * semis;
  }
  return { finetune, semis, shift: u - finetune * FINETUNE_STEP };
}

/**
 * The octave a sample is resampled by (2^k) so that the notes it plays fall in
 * ProTracker's range and the sample fits a module: the size limit first, then
 * the fewest notes out of range, then the smallest change.
 */
function octaveFit(notes, shift, length) {
  const lowest = -4096 * Math.log2(PT_RANGE_LOW / PT_REFERENCE_PERIOD) - 20;
  const highest = 4096 * Math.log2(PT_REFERENCE_PERIOD / PT_RANGE_HIGH) + 20;
  let best = null;
  for (let k = -4; k <= 2; k++) {
    const fits = length * 2 ** k <= MOD_SAMPLE_MAX;
    let out = 0;
    for (const n of notes) {
      const m = n + shift + 4096 * k - MIDDLE_C;
      if (m < lowest || m > highest) out++;
    }
    // Lexicographic: fits, then fewest notes out (or, if nothing fits, the
    // smallest sample), then the smallest change, then the smaller sample.
    const score = [fits ? 0 : 1, fits ? out : k, Math.abs(k), k];
    if (best === null || lexLess(score, best.score)) best = { k, score };
  }
  return best.k;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function toSigned8(x) {
  return Math.max(-128, Math.min(127, Math.round(x * 128)));
}

/** The sample as it goes into the module: signed 8-bit, an even number of
 *  bytes, loop points on words. */
function finishSample(src, k, warn) {
  let pcm, loopStart = src.loopStart, loopEnd = src.loopEnd;
  const ratio = 2 ** k;
  if (k === 0 && src.u8) {
    pcm = new Int8Array(src.pcm.length);
    for (let i = 0; i < src.pcm.length; i++) pcm[i] = src.pcm[i] - 128;
  } else {
    let f32 = src.pcm;
    if (src.u8) {
      f32 = new Float32Array(src.pcm.length);
      for (let i = 0; i < src.pcm.length; i++) f32[i] = (src.pcm[i] - 128) / 128;
    }
    if (k !== 0) {
      f32 = resample(f32, ratio);
      if (loopStart >= 0) {
        loopStart = Math.round(loopStart * ratio);
        loopEnd = Math.min(f32.length, Math.round(loopEnd * ratio));
      }
    }
    pcm = new Int8Array(f32.length);
    for (let i = 0; i < f32.length; i++) pcm[i] = toSigned8(f32[i]);
  }
  if (pcm.length > MOD_SAMPLE_MAX) {
    warn("truncated");
    pcm = pcm.subarray(0, MOD_SAMPLE_MAX);
    if (loopEnd > MOD_SAMPLE_MAX) loopEnd = MOD_SAMPLE_MAX;
  }
  let length = pcm.length + (pcm.length & 1);
  let loop = null;
  if (loopStart >= 0 && loopEnd - loopStart >= 2) {
    const ls = loopStart & ~1;
    const le = Math.min(length, ls + Math.max(2, (loopEnd - ls + 1) & ~1));
    if (le - ls >= 2) loop = { start: ls, length: le - ls };
  }
  const data = new Int8Array(length);
  data.set(pcm);
  return { data, loop };
}

// ── periods ─────────────────────────────────────────────────────────────────

function onTwelveToneGrid(note) {
  const off = (note - MIDDLE_C) / SEMITONE;
  return Math.abs(off - Math.round(off)) * SEMITONE <= TWELVE_TONE_TOLERANCE;
}

/** A note sitting on ProTracker's own table: the "ProTracker Temperament"
 *  notation writes exactly these pitches, and the table's two extension
 *  octaves stray further from 12-TET (up to 71 units) than the grid test lets by. */
function onProTrackerTable(note) {
  const idx = PT_C4_INDEX + Math.round((note - MIDDLE_C) / SEMITONE);
  if (idx < 0 || idx >= PT_PERIODS.length) return false;
  const pitch = MIDDLE_C + 4096 * Math.log2(PT_REFERENCE_PERIOD / PT_PERIODS[idx]);
  return Math.abs(note - pitch) <= TWELVE_TONE_TOLERANCE;
}

/** A played Taud note as the period that sounds it on this instrument. A
 *  12-tone song — or one written in ProTracker's own temperament — takes
 *  ProTracker's table (its finetune does the rest): the periods its editor can
 *  name, and that the replayer finds in the finetune tables. A microtonal one
 *  writes raw periods, which ProTracker plays snapped to the table but never
 *  names. */
function periodFor(note, plan, twelveTone) {
  if (twelveTone) {
    const semi = Math.round((note - MIDDLE_C) / SEMITONE) + plan.semis + 12 * plan.k;
    return PT_PERIODS[Math.max(0, Math.min(PT_PERIODS.length - 1, PT_C4_INDEX + semi))];
  }
  const m = note + plan.shift + 4096 * plan.k - MIDDLE_C;
  const period = Math.round(PT_REFERENCE_PERIOD * 2 ** (-m / 4096));
  return Math.max(PERIOD_MIN, Math.min(PERIOD_MAX, period));
}

// ── names ───────────────────────────────────────────────────────────────────

/** A stored name as the Amiga's Latin-1, cut to `n` bytes. */
function latin1(escaped, n) {
  const s = unescapeName(escaped ?? "");
  const out = new Uint8Array(n);
  for (let i = 0; i < Math.min(n, s.length); i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 0x20 || (c >= 0x7f && c < 0xa0) || c > 0xff ? 0x3f : c;
  }
  return out;
}

// ── the export ──────────────────────────────────────────────────────────────

/**
 * Export one song. Returns {title, errors, warnings, bytes} — `bytes` is the
 * .mod, or null when any error stands (nothing is written then; the errors
 * say why).
 */
export function exportModSong(doc, songIndex) {
  const song = doc.songs[songIndex];
  const errors = findings();
  const warnings = findings();
  const storedTitle = doc.meta?.songMeta?.[songIndex]?.name || doc.meta?.projectName || "";
  const title = unescapeName(storedTitle);

  // ── the song's own settings ──
  if (doc.wideCells) errors.add("format");
  if ((song.globalFlags & 3) !== 1) errors.add("toneMode");
  if (song.tickRate < 1 || song.tickRate > SPEED_MAX) errors.add("speed", { n: song.tickRate });
  if (song.bpm < BPM_MIN || song.bpm > BPM_MAX) errors.add("tempo", { bpm: song.bpm });
  const cents = 1200 * Math.log2(tuningRatioOf(song.tuningBaseNote, song.tuningFreq));
  if (Math.abs(cents) > TUNING_TOLERANCE_CENTS) errors.add("tuning");

  const orders = playedCues(song);
  if (orders > MOD_ORDERS) errors.add("orders", { n: orders });
  const infos = [];
  for (let c = 0; c < orders; c++) infos.push(cueInfo(song.cues[c]));

  // ── which lanes carry music ──
  const lanes = [];
  for (let ch = 0; ch < doc.channelCount; ch++) {
    for (let c = 0; c < orders; c++) {
      const rows = playedRows(doc, songIndex, song.cues[c][ch], infos[c].rowLimit);
      if (rows && rows.some(hasMusic)) { lanes.push(ch); break; }
    }
  }
  if (lanes.length > MOD_CHANNELS) errors.add("lanes", { n: lanes.length });
  // Lanes 1–4 stay where they are (an imported module's silent channel keeps
  // its place, and with it the hardware pan of the ones after it); music on a
  // later lane closes up, in lane order.
  const keepPlace = lanes.every((ch) => ch < MOD_CHANNELS);
  const channelOf = lanes.map((ch, i) => (keepPlace ? ch : i));
  const emptyChannel = () => Array.from({ length: 64 }, () => ({ note: 0, inst: 0, fx: -1, arg: 0, off: -1 }));

  // ── walk the song in cue order: cells → ProTracker cells ──
  const notesOf = new Map();     // slot → Taud notes it plays
  const referenced = new Set();
  const grid = [];               // [order][channel][row] → abstract cell
  const state = lanes.map(() => ({
    inst: 0, cutPending: false,
    mem: { d: 0, ef: 0, j: 0, k: 0, l: 0, q: 0 },
    porta: 0, vibSpeed: 0, vibDepth: 0,
  }));
  let roundedCount = 0, droppedCount = 0, keyOffCount = 0;
  const rounded = () => { roundedCount++; };
  for (let c = 0; c < orders; c++) {
    const rowLimit = infos[c].rowLimit;
    const chans = Array.from({ length: Math.max(MOD_CHANNELS, lanes.length) }, emptyChannel);
    for (let li = 0; li < lanes.length; li++) {
      const ch = lanes[li];
      const st = state[li];
      const rows = playedRows(doc, songIndex, song.cues[c][ch], rowLimit);
      const out = [];
      for (let r = 0; r < 64; r++) {
        const cell = rows?.[r];
        const pt = { note: 0, inst: 0, pitchInst: 0, curInst: st.inst, fx: -1, arg: 0, off: -1 };
        out.push(pt);
        if (!cell) continue;
        const where = { cue: c, lane: ch, row: r };
        const bad = (code, args) => errors.add(code, args, where);

        if (cell.inst !== 0) {
          st.inst = cell.inst;
          pt.inst = cell.inst;
          pt.curInst = cell.inst;
          referenced.add(cell.inst);
        }
        let cut = null;
        if (cell.note >= 0x20) {
          pt.note = cell.note;
          pt.pitchInst = st.inst;
          if (st.inst !== 0) {
            referenced.add(st.inst);
            if (!notesOf.has(st.inst)) notesOf.set(st.inst, []);
            notesOf.get(st.inst).push(cell.note);
          }
          // ProTracker's cut leaves the channel at volume 0, and only a
          // sample number restores it; after a Taud cut the next note sounds.
          if (st.cutPending && pt.inst === 0) pt.inst = st.inst;
          st.cutPending = false;
        } else if (cell.note === NOTE_CUT) {
          cut = { fx: 0xc, arg: 0 };
        } else if (cell.note === NOTE_KEYOFF || cell.note === NOTE_FADE || cell.note === NOTE_FAST_FADE) {
          // Key-off and the fades: the end of a note that would otherwise ring.
          if (st.inst !== 0 && releases(doc.instruments[st.inst])) {
            cut = { fx: 0xc, arg: 0 };
            keyOffCount++;
          }
        }

        let main = effectColumn(cell, st, bad, rounded);
        let vol = volumeColumn(cell, rounded);
        let pan = null;
        if (cell.panEff === SEL_SET) {
          // mod2taud's own row-0 pans are the hardware's, not the song's.
          if (!(r === 0 && cell.pan === amigaPan(channelOf[li]))) {
            pan = { fx: 8, arg: (cell.pan << 2) | (cell.pan >>> 4) };
          }
        } else if (!(cell.panEff === SEL_FINE && cell.pan === 0)) {
          droppedCount++; // a panning slide: the module's channels do not move
        }

        // A volume slide rides along with a tone portamento or a vibrato that
        // only continues (5xy, 6xy) — the shape mod2taud split them from.
        if (main && vol?.slide) {
          const portaGoes = main.fx === 3 && (main.arg === 0 || main.arg === st.porta);
          const vibGoes = main.fx === 4 && (main.arg === 0 ||
            (((main.arg >>> 4) === 0 || (main.arg >>> 4) === st.vibSpeed) &&
             ((main.arg & 0xf) === 0 || (main.arg & 0xf) === st.vibDepth)));
          if (portaGoes || vibGoes) {
            main = { fx: portaGoes ? 5 : 6, arg: vol.arg };
            vol = null;
          }
        }
        const picks = [main, cut, vol, pan].filter(Boolean);
        if (picks.length > 0) {
          const pick = picks[0];
          if (pick.off !== undefined) pt.off = pick.off;
          pt.fx = pick.fx;
          pt.arg = pick.arg ?? 0;
          if (pick === cut) st.cutPending = true;
          droppedCount += picks.length - 1;
          if (pt.fx === 3 && pt.arg !== 0) st.porta = pt.arg;
          if (pt.fx === 4) {
            if (pt.arg >>> 4) st.vibSpeed = pt.arg >>> 4;
            if (pt.arg & 0xf) st.vibDepth = pt.arg & 0xf;
          }
        }
      }
      chans[channelOf[li]] = out;
    }
    grid.push(chans);
  }

  // ── instruments ──
  // One finding per kind of metainstrument, naming every one the song plays.
  const kindOf = (inst) => inst.isFormant ? "formant" : inst.isFm ? "fm" : "layered";
  const metas = new Map();
  for (const slot of [...referenced].sort((x, y) => x - y)) {
    const inst = doc.instruments[slot];
    if (!inst.isHighMeta) continue;
    const kind = kindOf(inst);
    if (!metas.has(kind)) metas.set(kind, []);
    metas.get(kind).push(`${hex(slot, 2)} “${unescapeName(doc.instrumentName(slot))}”`);
  }
  for (const [kind, list] of metas) errors.add("instrument", { kind, list: list.join(", ") });
  const used = doc.usedInstrumentSlots().filter((s) => s >= 1);
  const identity = [...referenced].every((s) => s <= MOD_SAMPLES) && used.every((s) => s <= MOD_SAMPLES);
  const slotMap = new Map();
  if (identity) {
    for (const s of used) {
      const inst = doc.instruments[s];
      if (referenced.has(s) || (!inst.isMeta && !inst.isLowMeta && !inst.isHighMeta)) slotMap.set(s, s);
    }
    for (const s of referenced) slotMap.set(s, s);
  } else {
    if (referenced.size > MOD_SAMPLES) errors.add("instruments", { n: referenced.size });
    [...referenced].sort((x, y) => x - y).forEach((s, i) => slotMap.set(s, i + 1));
  }

  if (errors.size > 0) {
    return { title, errors: errors.list(), warnings: warnings.list(), bytes: null };
  }

  // ── samples ──
  const samples = new Array(MOD_SAMPLES).fill(null);
  const plans = new Map();
  let projectImage = null, chipImage = null, chipLevel = 0, chipRef = 0;
  let resampledCount = 0;
  const chipNames = [];
  // Instrument-scoped warnings, one finding each with every slot it concerns.
  const bySlot = new Map();
  const slotWarn = (slot) => (code) => {
    if (!bySlot.has(code)) bySlot.set(code, new Set());
    bySlot.get(code).add(slot);
  };
  for (const [slot, modSlot] of slotMap) {
    const inst = doc.instruments[slot];
    const notes = notesOf.get(slot) ?? [];
    const name = latin1(doc.instrumentName(slot), 22);
    const dnv = inst.defaultNoteVolume & 0xff;
    const volume = dnv === 0 ? 64 : Math.round((dnv * 64) / 255);
    let src = null;
    if (inst.isOpl || inst.isPsg) {
      if (notes.length === 0) { samples[modSlot - 1] = { name, volume, finetune: 0, data: null, loop: null }; continue; }
      if (chipImage === null) {
        // toRenderable folds pending instrument edits into the image first.
        projectImage = doc.toRenderable(songIndex).sampleInstImage;
        chipRef = referenceSlot(slot);
        chipImage = bounceImage(projectImage, chipRef);
        chipLevel = referenceLevel(song, chipImage, chipRef);
      } else if (chipRef === slot) {
        chipRef = referenceSlot(slot);
        chipImage = bounceImage(projectImage, chipRef);
      }
      const b = bounceChipInstrument(song, chipImage, slot, Math.round(median(notes)), chipLevel);
      src = { pcm: b.pcm, u8: false, rate: b.rate, detune: 0, loopStart: b.loopStart, loopEnd: b.loopEnd };
      chipNames.push(unescapeName(doc.instrumentName(slot)) || `#${slot}`);
    } else if (!inst.isMeta) {
      src = sampledSource(doc, inst, notes, slotWarn(slot));
      if (droppedFeatures(inst)) slotWarn(slot)("instrumentFeatures");
    }
    if (src === null) { samples[modSlot - 1] = { name, volume, finetune: 0, data: null, loop: null }; continue; }
    const plan = pitchPlan(src.rate, src.detune);
    plan.k = octaveFit(notes, plan.shift, src.pcm.length);
    if (plan.k !== 0) resampledCount++;
    plans.set(slot, plan);
    const { data, loop } = finishSample(src, plan.k, slotWarn(slot));
    samples[modSlot - 1] = { name, volume, finetune: plan.finetune, data, loop, ratio: 2 ** plan.k };
  }
  for (const [code, slots] of bySlot) {
    warnings.add(code, { slots: [...slots].sort((x, y) => x - y).map((s) => hex(s, 2)).join(", ") });
  }

  // ── notes → periods ──
  let twelveTone = true;
  for (const notes of notesOf.values()) {
    if (!notes.every((n) => onTwelveToneGrid(n) || onProTrackerTable(n))) { twelveTone = false; break; }
  }
  if (!twelveTone) warnings.add("microtonal");
  const zero = { finetune: 0, semis: 0, shift: 0, k: 0 };
  let outOfRange = 0;
  for (const chans of grid) {
    for (const rows of chans) {
      for (const pt of rows) {
        if (pt.note === 0) continue;
        pt.period = periodFor(pt.note, plans.get(pt.pitchInst) ?? zero, twelveTone);
        if (pt.period > PT_RANGE_LOW || pt.period < PT_RANGE_HIGH) outOfRange++;
      }
    }
  }

  // ── sample offsets follow the sample's resampling ──
  for (const chans of grid) {
    for (const rows of chans) {
      for (const pt of rows) {
        if (pt.off < 0) continue;
        const ratio = samples[(slotMap.get(pt.curInst) ?? 0) - 1]?.ratio ?? 1;
        pt.arg = pt.off === 0 ? 0 : Math.min(0xff, Math.max(1, Math.round((pt.off * ratio) / 256)));
      }
    }
  }

  // ── what the cue sheet and the song table say, written into the patterns ──
  let flowLost = 0;
  const place = (chans, row, fx, arg) => {
    for (let ch = 0; ch < MOD_CHANNELS; ch++) {
      if (chans[ch][row].fx < 0) { chans[ch][row].fx = fx; chans[ch][row].arg = arg; return true; }
    }
    flowLost++;
    return false;
  };
  const hasFx = (chans, row, test) => chans.some((rows) => rows[row].fx >= 0 && test(rows[row]));
  if (grid.length > 0) {
    const first = grid[0];
    if (song.tickRate !== 6 && !hasFx(first, 0, (p) => p.fx === 0xf && p.arg < 0x20)) place(first, 0, 0xf, song.tickRate);
    if (song.bpm !== 125 && !hasFx(first, 0, (p) => p.fx === 0xf && p.arg >= 0x20)) place(first, 0, 0xf, song.bpm);
  }
  for (let c = 0; c < orders; c++) {
    const info = infos[c];
    const last = info.rowLimit - 1;
    const jumps = (p) => p.fx === 0xb || p.fx === 0xd;
    if (hasFx(grid[c], last, jumps)) continue;
    const flow = info.flow;
    if (flow !== null) {
      // GOBACK, SKIP and JUMP: the cue after this one is somewhere else.
      const target = flow.type === 1 ? Math.max(c - flow.arg, 0)
        : flow.type === 2 ? c + flow.arg : flow.arg;
      place(grid[c], last, 0xb, Math.min(target, MOD_ORDERS - 1));
    } else if (info.rowLimit < 64) {
      // A shortened cue (and a cue that halts part-way) ends where it says.
      place(grid[c], last, 0xd, 0);
    }
  }
  if (flowLost > 0) warnings.add("flowLost", { n: flowLost });

  // ── patterns: one per order, the same ones shared ──
  const patterns = [];
  const patternIndex = new Map();
  const orderList = [];
  for (const chans of grid) {
    const bytes = new Uint8Array(64 * MOD_CHANNELS * 4);
    for (let ch = 0; ch < Math.min(MOD_CHANNELS, chans.length); ch++) {
      for (let r = 0; r < 64; r++) {
        const pt = chans[ch][r];
        const period = pt.period ?? 0;
        const smp = pt.inst !== 0 ? slotMap.get(pt.inst) ?? 0 : 0;
        const fx = pt.fx < 0 ? 0 : pt.fx;
        const arg = pt.fx < 0 ? 0 : pt.arg & 0xff;
        const o = (r * MOD_CHANNELS + ch) * 4;
        bytes[o] = (smp & 0xf0) | ((period >>> 8) & 0x0f);
        bytes[o + 1] = period & 0xff;
        bytes[o + 2] = ((smp & 0x0f) << 4) | fx;
        bytes[o + 3] = arg;
      }
    }
    const key = bytes.join(",");
    let idx = patternIndex.get(key);
    if (idx === undefined) {
      idx = patterns.length;
      patternIndex.set(key, idx);
      patterns.push(bytes);
    }
    orderList.push(idx);
  }
  if (patterns.length > 64) warnings.add("patterns", { n: patterns.length });
  if (outOfRange > 0) warnings.add("range", { n: outOfRange });
  if (droppedCount > 0) warnings.add("dropped", { n: droppedCount });
  if (roundedCount > 0) warnings.add("rounded", { n: roundedCount });
  if (keyOffCount > 0) warnings.add("keyOff", { n: keyOffCount });
  if (resampledCount > 0) warnings.add("resampled", { n: resampledCount });
  if (chipNames.length > 0) warnings.add("bounced", { names: chipNames.join(", ") });

  return {
    title, errors: [], warnings: warnings.list(),
    bytes: writeMod({ title: latin1(storedTitle, 20), samples, orderList, patterns }),
  };
}

/** Every song of the project, each its own module. */
export function exportModSongs(doc) {
  return doc.songs.map((_, i) => ({ songIndex: i, ...exportModSong(doc, i) }));
}

// ── the file ────────────────────────────────────────────────────────────────

function writeMod({ title, samples, orderList, patterns }) {
  const sampleBytes = samples.reduce((n, s) => n + (s?.data?.length ?? 0), 0);
  const out = new Uint8Array(1084 + patterns.length * 1024 + sampleBytes);
  const dv = new DataView(out.buffer);
  out.set(title, 0);
  for (let i = 0; i < MOD_SAMPLES; i++) {
    const s = samples[i];
    const o = 20 + i * 30;
    // ProTracker writes a one-word "no loop" into an empty slot as well.
    if (!s) { dv.setUint16(o + 28, 1); continue; }
    out.set(s.name, o);
    const len = s.data?.length ?? 0;
    dv.setUint16(o + 22, len >>> 1);
    out[o + 24] = s.finetune & 0x0f;
    out[o + 25] = Math.min(64, s.volume);
    dv.setUint16(o + 26, s.loop ? s.loop.start >>> 1 : 0);
    dv.setUint16(o + 28, s.loop ? s.loop.length >>> 1 : 1);
  }
  out[950] = orderList.length;
  out[951] = 0x7f;
  orderList.forEach((p, i) => { out[952 + i] = p; });
  out.set(patterns.length > 64 ? [0x4d, 0x21, 0x4b, 0x21] : [0x4d, 0x2e, 0x4b, 0x2e], 1080); // M!K! / M.K.
  let o = 1084;
  for (const p of patterns) { out.set(p, o); o += 1024; }
  for (const s of samples) {
    if (!s?.data) continue;
    out.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.length), o);
    o += s.data.length;
  }
  return out;
}

/** The file name for song `songIndex` of a project saved as `base`. */
export function modFileName(base, songIndex, songCount) {
  return songCount > 1 ? `${base}-${songIndex + 1}.mod` : `${base}.mod`;
}
