// Export a song as an Impulse Tracker module (item 268) — the inverse of
// vendor/converters/it2taud.py. Taud's instrument record began as IT's, so
// most of the way back is the importer read backwards: envelopes, New Note
// Actions, duplicate checks, pitch-pan, swings, filters and the effect column
// all have an IT word. What IT lacks is made up for, best effort:
//
// - MICROTONES. An IT note is a whole semitone, and a sample's C-5 speed is
//   the only pitch IT lets a file choose freely. So every note is split into
//   the nearest semitone (the KEY the pattern shows) and what is left over
//   (the FRACTION), and the fraction goes into a copy of the sample header
//   whose C-5 speed is detuned by it (the copies share one set of sample data).
//   An instrument's keyboard maps each key to its own sample, so one IT
//   instrument holds one fraction per key: a tuning with twelve notes to the
//   octave fits in one, and only a key that is played at two different
//   fractions makes a second instrument (a VARIANT) necessary. A song's tuning
//   off standard pitch detunes every sample the same way.
// - VELOCITY LAYERS. IT has no velocity, so an Ixmp key map whose patches are
//   split by volume becomes one IT instrument per volume band the song plays,
//   the band chosen from the note's volume — while the module has room for
//   them (Impulse Tracker's 99); otherwise every band plays the loudest one.
// - METAINSTRUMENTS (layered, FM, formant) and the OPL and PSG chips are
//   RENDERED: one held note per octave they are played in, bounced through the
//   engine (modchip.js) into samples on a keyboard map.
// - SOUNDFONT PARAMETERS. A SoundFont filter (cents, centibels) becomes IT's
//   cutoff and resonance by the frequencies they mean; per-zone envelopes,
//   fadeout and filters, which IT keeps per instrument, come from the zone the
//   song plays most; an initial attenuation becomes the sample's global volume.
//
// Mixing chains (IMix) and the mastering chain are dropped, with a warning.
//
// Only two things stop an export (ERRORS): a version-3 (surround) project and
// a tone-slide mode IT does not have (linear frequency); and, past those, the
// format's own limits — orders, patterns, instrument and sample numbers.
// Everything else is a WARNING: {code, args, count, where}, worded by the UI.
//
// Pure: no DOM. Runs in Node too (tools/taud2it.js).

import { EffectOp, tuningRatioOf, attenGainOf } from "../../core/engine/tables.js";
import { MIDDLE_C } from "../../core/engine/constants.js";
import { envPresent } from "../../core/engine/envelope.js";
import { minifloatToDouble } from "../../core/engine/minifloat.js";
import { patchVibratoInherits, patchIsStereo } from "../../core/engine/inst.js";
import { unescapeName } from "../../core/format/names.js";
import { isDefaultMastering } from "../../core/format/mastering-section.js";
import { cueInfo } from "../doc/document.js";
import { narrowedForExport } from "../doc/upgrade.js";
import {
  findings, opChar, hex, playedCues, playedRows, median, latin1, vol64,
} from "./modexport.js";
import { bounceImage, referenceSlot, referenceLevel, bounceChipInstrument } from "./modchip.js";
import { volEnvValue63 } from "../doc/volenv.js";

export const IT_CHANNELS = 64;
/** Orders a module plays; the list carries one more, the end marker. */
export const IT_ORDERS = 255;
/** Schism Tracker's and OpenMPT's limit; Impulse Tracker itself stops at 200. */
export const IT_PATTERNS = 240;
/** Instrument and sample numbers are bytes (a keyboard entry names a sample in one). */
export const IT_SLOTS = 255;
/** What Impulse Tracker's own editor reaches. */
export const IT_CLASSIC = 99;
const IT_CLASSIC_PATTERNS = 200;
const IT_MESSAGE_MAX = 8000;

const SEMITONE = 4096 / 12;
const IT_C5 = 60;                       // IT C-5 ≡ Taud C4, as it2taud anchors it
const IT_KEYS = 120;
/** Fractions closer than this (in 4096-TET units, ~0.4 cents) are one pitch:
 *  a 12-TET note is rounded to the unit, so it sits up to ⅔ unit off the grid. */
const FRACTION_TOLERANCE = 1.5;
const TUNING_TOLERANCE_CENTS = 3;
const BPM_MIN = 32, BPM_MAX = 255;
const C5_SPEED_MAX = 9999999;
const ENV_TICK_MAX = 9999;
/** Octaves a rendered instrument is bounced at, at most. */
const MAX_BOUNCES = 8;
/** A rendered instrument that sustains and has no fadeout of its own fades
 *  over this many IT units (1024 ÷ 64 = 16 ticks) once released. */
const RENDERED_FADEOUT = 64;
/**
 * When a song needs more samples or instruments than a module has numbers
 * for, the export is run again a step coarser: first the instruments the
 * song never plays stay behind, then every velocity layer plays its loudest, then the fractions are rounded to these many cents —
 * the last step, a semitone, leaves none at all.
 */
const FRACTION_STEPS_CENTS = [2, 5, 10, 25, 100];

/** The next coarser attempt after `opts`, or null when there is none. */
function coarser(opts) {
  if (!opts.dropUnused) return { ...opts, dropUnused: true };
  if (!opts.mergeBands) return { ...opts, mergeBands: true };
  const next = (opts.coarsen ?? 0) + 1;
  return next <= FRACTION_STEPS_CENTS.length ? { ...opts, coarsen: next } : null;
}

const OP = EffectOp;
const NOTE_KEYOFF = 1, NOTE_CUT = 2, NOTE_FADE = 3, NOTE_FAST_FADE = 4;
const SEL_SET = 0, SEL_UP = 1, SEL_DOWN = 2;
const IT_NOTE_OFF = 255, IT_NOTE_CUT = 254, IT_NOTE_FADE = 246;
/** An IT effect letter as its command number (A = 1). */
const fx = (letter) => letter.charCodeAt(0) - 64;

// ── effects ─────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Python's round(): halves to even, as it2taud rounds. */
const roundHalfEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/**
 * IT's 0…64 for a Taud 0…63 (a pan, an envelope's volume): of the IT values
 * the importer reads as `p` (round-half-even of v × 63/64), the one nearest
 * `p` itself — so the centre (32), both ends and every imported value come
 * back as they went in.
 */
const IT64 = Array.from({ length: 64 }, (_, p) => {
  let best = -1;
  for (let v = 0; v <= 64; v++) {
    if (roundHalfEven((v * 63) / 64) === p && (best < 0 || Math.abs(v - p) < Math.abs(best - p))) best = v;
  }
  return best;
});
const it64 = (p) => IT64[clamp(p, 0, 63)];

/** A byte nibble-repeated by the importer ($xx = x × $11), read back. */
function nibbleOf(b, rounded) {
  if (b === 0) return 0;
  const x = clamp(Math.round(b / 17), 1, 15);
  if (x * 17 !== b) rounded();
  return x;
}

const J_SEMI = [0x00, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x09,
  0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x13, 0x14];

function semitonesOf(b, rounded) {
  const x = Math.min(15, Math.round(b * 0.75));
  if (J_SEMI[x] !== b) rounded();
  return x;
}

/** Taud's H/U/R/I/Y argument, two nibble-repeated bytes, as IT's $xy. */
function nibblePair(a, rounded) {
  return (nibbleOf((a >>> 8) & 0xff, rounded) << 4) | nibbleOf(a & 0xff, rounded);
}

/**
 * A coarse E/F slide. Linear songs: Taud units ÷ 64/3 (IT's 1/16 semitone);
 * Amiga songs: period units, as they came. Never 0, which in IT is a recall.
 */
function coarseSlide(letter, a, linear, rounded) {
  let x = linear ? Math.round((a * 3) / 64) : a;
  if (linear && Math.abs((x * 64) / 3 - a) > 0.5) rounded();
  if (x < 1) { x = 1; rounded(); }
  if (x > 0xdf) { x = 0xdf; rounded(); }  // $E0 and up are the fine forms
  return { fx: letter, arg: x };
}

/** A fine (once-per-row) slide of `m` units: IT's fine form is the coarse
 *  unit once (EFx = 4 × EEx), its extra-fine a quarter of it. */
function fineSlide(letter, m, linear, rounded) {
  if (!linear) {
    if (m > 15) rounded();
    return { fx: letter, arg: 0xf0 | clamp(m, 1, 15) };
  }
  const quarters = Math.round((m * 3) / 16);
  if (Math.abs((quarters * 16) / 3 - m) > 0.5) rounded();
  if (quarters % 4 === 0 && quarters / 4 <= 15 && quarters > 0) return { fx: letter, arg: 0xf0 | (quarters / 4) };
  if (quarters >= 1 && quarters <= 15) return { fx: letter, arg: 0xe0 | quarters };
  rounded();
  return { fx: letter, arg: 0xf0 | clamp(Math.round(quarters / 4), 1, 15) };
}

/**
 * The IT effect for a cell's effect column, {fx, arg}, or null for none.
 * `st.mem` resolves the recalls IT keeps differently: Taud's D, K and L each
 * have a private memory, IT's three share one. `ctx.drop(code)` reports an
 * effect IT has no word for, `ctx.rounded()` an argument that does not
 * survive exactly.
 */
function effectColumn(cell, st, ctx) {
  const op = cell.fx, a = cell.arg;
  const hi = (a >>> 8) & 0xff, lo = a & 0xff;
  const { rounded, drop, linear } = ctx;
  switch (op) {
    case 0: return null;
    case OP.OP_1:
      // Global behaviour flags: a module's slide mode is the header's.
      if ((hi & 3) === ctx.toneMode) return null;
      drop("1");
      return null;
    case OP.OP_A:
      return hi === 0 ? null : { fx: fx("A"), arg: hi };
    case OP.OP_B:
      if (a > 0xff) rounded();
      return { fx: fx("B"), arg: Math.min(a, 0xff) };
    case OP.OP_C:
      if (a > 0xff) rounded();
      return { fx: fx("C"), arg: Math.min(a, 0xff) };
    case OP.OP_D:
    case OP.OP_K:
    case OP.OP_L: {
      const key = op === OP.OP_D ? "d" : op === OP.OP_K ? "k" : "l";
      const v = hi !== 0 ? hi : st.mem[key];
      if (hi !== 0) st.mem[key] = hi;
      const letter = op === OP.OP_D ? "D" : op === OP.OP_K ? "K" : "L";
      if (v === 0) return op === OP.OP_D ? null : { fx: fx(op === OP.OP_K ? "H" : "G"), arg: 0 };
      return { fx: fx(letter), arg: v };
    }
    case OP.OP_E:
    case OP.OP_F: {
      const letter = fx(op === OP.OP_E ? "E" : "F");
      if (a === 0) return { fx: letter, arg: 0 };         // E and F share a memory in both
      if ((a & 0xf000) === 0xf000) {
        const m = a & 0x0fff;
        return m === 0 ? null : fineSlide(letter, m, linear, rounded);
      }
      return coarseSlide(letter, a, linear, rounded);
    }
    case OP.OP_G: {
      if (a === 0) return { fx: fx("G"), arg: 0 };
      const s = clamp(Math.round((a * 3) / 64), 1, 0xff);
      if (Math.round((s * 64) / 3) !== a) rounded();
      return { fx: fx("G"), arg: s };
    }
    case OP.OP_H: return { fx: fx("H"), arg: nibblePair(a, rounded) };
    case OP.OP_U: return { fx: fx("U"), arg: nibblePair(a, rounded) };
    case OP.OP_R: return { fx: fx("R"), arg: nibblePair(a, rounded) };
    case OP.OP_I: return { fx: fx("I"), arg: nibblePair(a, rounded) };
    case OP.OP_Y: return { fx: fx("Y"), arg: nibblePair(a, rounded) };
    case OP.OP_J: {
      if (a === 0) return { fx: fx("J"), arg: 0 };
      const arg = (semitonesOf(hi, rounded) << 4) | semitonesOf(lo, rounded);
      if (arg === 0) { rounded(); return null; }
      return { fx: fx("J"), arg };
    }
    case OP.OP_M:
      // A format-3 lane volume is 0…255: IT's 0…64 is round(v × 64 ÷ 255) of
      // it, the exact inverse of it2taud's; a 6-bit one's 63 is IT's 64.
      if (cell.lane8 !== null && cell.lane8 !== undefined) {
        return { fx: fx("M"), arg: Math.min(0x40, Math.round((cell.lane8 * 64) / 255)) };
      }
      return { fx: fx("M"), arg: hi >= 0x3f ? 0x40 : hi };
    case OP.OP_N: return { fx: fx("N"), arg: hi };
    case OP.OP_P: return { fx: fx("P"), arg: hi };
    case OP.OP_W: return { fx: fx("W"), arg: hi };
    case OP.OP_O: {
      // The nearest 256 bytes; but never 0 for a real offset, which IT reads as
      // a recall (an importer that resampled a sample leaves offsets under $100).
      if (a === 0) return { fx: fx("O"), arg: 0 };
      if (lo !== 0) rounded();
      return { fx: fx("O"), arg: clamp(Math.round(a / 256), 1, 0xff) };
    }
    case OP.OP_Q: {
      // A Taud Q whose interval is 0 is ignored, memory and all; IT's would
      // recall its interval.
      if (a !== 0 && ((a >>> 8) & 0xf) === 0) { rounded(); return null; }
      return { fx: fx("Q"), arg: hi };
    }
    case OP.OP_S: {
      const sub = (a >>> 12) & 0xf, x = (a >>> 8) & 0xf;
      const s = (n) => ({ fx: fx("S"), arg: (n << 4) | x });
      switch (sub) {
        case 0x1: case 0x3: case 0x4: case 0x5: case 0x7: case 0xb:
          return s(sub);
        case 0x6: case 0xc: case 0xe:
          return x === 0 ? null : s(sub); // a zero there does nothing in Taud
        case 0xd:
          if (lo !== 0) rounded();         // IT's delay takes no follow-up action
          return x === 0 ? null : s(sub);
        case 0x8:
          if (x !== 0) { drop("S $8xxx"); return null; }
          // A nibble-repeated pan is IT's own S8x, as it came in.
          return lo % 17 === 0 ? { fx: fx("S"), arg: 0x80 | (lo / 17) } : { fx: fx("X"), arg: lo };
        default:
          drop("S $" + hex(sub, 1) + "x");
          return null;
      }
    }
    case OP.OP_T: {
      let bpm;
      if (hi >= 0xfc && lo !== 0) bpm = Math.min(0x118 + (0xff - hi) * 0xff + lo, 1048);
      else if (hi === 0xfb && lo !== 0) return null;   // reserved: ignored
      else if (hi !== 0) bpm = hi + 0x19;
      // T $000x / $001x: the tempo slides, IT's own T0x / T1x.
      else if ((lo & 0xe0) === 0) return { fx: fx("T"), arg: lo };
      else return null;
      if (bpm < BPM_MIN || bpm > BPM_MAX) rounded();
      return { fx: fx("T"), arg: clamp(bpm, BPM_MIN, BPM_MAX) };
    }
    case OP.OP_V:
      return { fx: fx("V"), arg: Math.min(0x80, Math.round(hi / 2)) };
    case OP.OP_COLON:
      return null; // an interrupt's argument, or an extension IT has no use for
    default:
      drop(opChar(op));
      return null;
  }
}

/** The volume column: {vc} with an IT volume-column byte, and `alt`, the
 *  effect that says it better when the effect column is free (a slide past
 *  the column's 9). */
function volumeColumn(cell) {
  const v = cell.vol;
  switch (cell.volEff) {
    case SEL_SET:
      return { vc: vol64(cell) };
    case SEL_UP:
      if (v === 0) return null;
      return v <= 9 ? { vc: 85 + v } : { vc: 94, alt: { fx: fx("D"), arg: Math.min(v, 15) << 4 } };
    case SEL_DOWN:
      if (v === 0) return null;
      return v <= 9 ? { vc: 95 + v } : { vc: 104, alt: { fx: fx("D"), arg: Math.min(v, 15) } };
    default: {
      const mag = v & 0x1f;
      if (mag === 0) return null;
      const up = (v & 0x20) !== 0;
      if (mag <= 9) return { vc: (up ? 65 : 75) + mag };
      const m = Math.min(mag, 15);
      return { vc: up ? 74 : 84, alt: { fx: fx("D"), arg: up ? (m << 4) | 0xf : 0xf0 | m } };
    }
  }
}

/** The panning column: a SET is a volume-column pan (or an X), a slide P. */
function panColumn(cell) {
  const v = cell.pan;
  switch (cell.panEff) {
    case SEL_SET:
      return { set: true, vc: 128 + it64(v), alt: { fx: fx("X"), arg: Math.round((v * 255) / 63) } };
    case SEL_UP:
      return v === 0 ? null : { fx: fx("P"), arg: Math.min(v, 15) };
    case SEL_DOWN:
      return v === 0 ? null : { fx: fx("P"), arg: Math.min(v, 15) << 4 };
    default: {
      const mag = v & 0x1f;
      if (mag === 0) return null;
      const m = Math.min(mag, 15);
      return { fx: fx("P"), arg: (v & 0x20) !== 0 ? 0xf0 | m : (m << 4) | 0xf };
    }
  }
}

// ── pitch: key + fraction ───────────────────────────────────────────────────

const keyPitch = (k) => MIDDLE_C + (k - IT_C5) * SEMITONE;

/** The IT key a Taud note is written as (clamped to IT's ten octaves; a note
 *  beyond them keeps its pitch in its fraction). */
function keyOf(note) {
  return clamp(IT_C5 + Math.round((note - MIDDLE_C) / SEMITONE), 0, IT_KEYS - 1);
}

/**
 * The fractions one instrument (in one velocity band) is played at, grouped
 * into variants: each key's fractions are counted, the commonest goes to
 * variant 0, the next to variant 1 and so on — so a tuning with one pitch per
 * key needs only variant 0.
 */
function planVariants(notes, quant) {
  const perKey = new Map();
  for (const n of notes) {
    const k = keyOf(n);
    const f = quant(n - keyPitch(k));
    let list = perKey.get(k);
    if (!list) perKey.set(k, (list = []));
    const c = list.find((x) => Math.abs(x.f - f) <= FRACTION_TOLERANCE);
    if (c) { c.sum += f; c.n++; c.f = c.sum / c.n; } else list.push({ f, sum: f, n: 1 });
  }
  let count = 1;
  for (const list of perKey.values()) {
    list.sort((x, y) => y.n - x.n || x.f - y.f);
    count = Math.max(count, list.length);
  }
  const variants = [];
  for (let v = 0; v < count; v++) {
    const used = new Map();
    for (const [k, list] of perKey) if (list[v]) used.set(k, list[v].f);
    variants.push(fillFractions(used));
  }
  return variants;
}

/** A fraction for every key: a played key its own, any other its nearest
 *  played neighbour's (so it shares that key's sample), 0 if none is played. */
function fillFractions(used) {
  const out = new Float64Array(IT_KEYS);
  const keys = [...used.keys()].sort((a, b) => a - b);
  const nearest = new Int16Array(IT_KEYS).fill(-1);
  if (keys.length === 0) return { used, frac: out, nearest };
  for (let k = 0, j = 0; k < IT_KEYS; k++) {
    while (j + 1 < keys.length && Math.abs(keys[j + 1] - k) <= Math.abs(keys[j] - k)) j++;
    nearest[k] = keys[j];
    const f = used.get(keys[j]);
    // A note past IT's ten octaves keeps its distance in its fraction; that
    // is its key's alone, not a neighbour's to borrow.
    out[k] = used.has(k) || Math.abs(f) <= SEMITONE / 2 ? f : 0;
  }
  return { used, frac: out, nearest };
}

// ── instruments ─────────────────────────────────────────────────────────────

function fadeoutOf(inst) {
  return (inst.volumeFadeoutLow & 0xff) | ((inst.fadeoutHigh & 0x0f) << 8);
}

/** Does a note of this instrument set the pan itself (a default pan, or a
 *  key-map zone's)? */
function pansItself(inst) {
  if ((inst.panEnvLoop & 0x80) !== 0) return true;
  return inst.extraPatches !== null && inst.extraPatches.some((p) => p.defaultPan !== 0xff);
}

/** IT's instrument DfP wins over every sample's pan (Schism
 *  csf_set_instrument_panning), Taud's key-map zone pan over the record's
 *  `p` default: so the record's default is the IT instrument's only while no
 *  zone brings a pan of its own. Otherwise each sample carries the pan it
 *  plays at — its zone's, else the record's. */
function instrumentPans(inst) {
  return (inst.panEnvLoop & 0x80) !== 0
    && !(inst.extraPatches !== null && inst.extraPatches.some((p) => p.defaultPan !== 0xff));
}

function samplePan(inst, p) {
  if (p !== null && p.defaultPan !== 0xff) return p.defaultPan;
  return (inst.panEnvLoop & 0x80) !== 0 && !instrumentPans(inst) ? inst.defaultPan : 0xff;
}

function isRendered(inst) {
  return inst.isMeta || inst.isOpl || inst.isPsg || inst.isFormant;
}

/** The note volume a trigger resolves its key-map patch at (trigger.js). */
function defaultVolume(inst) {
  const dnv = inst.defaultNoteVolume & 0xff;
  return dnv === 0 ? 63 : Math.trunc((dnv * 63 + 127) / 255);
}

/**
 * The volume bands of an instrument's key map: the volume axis cut wherever
 * a patch's range starts or ends, adjacent bands that choose the same patch
 * for every key merged again. One band ({0…63}) when nothing is split.
 */
function volumeBands(inst) {
  const patches = inst.extraPatches;
  if (patches === null || patches.length === 0) return [{ lo: 0, hi: 63 }];
  const cuts = new Set([0, 64]);
  for (const p of patches) {
    cuts.add(clamp(p.volumeStart, 0, 64));
    cuts.add(clamp(p.volumeEnd + 1, 0, 64));
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const band = { lo: edges[i], hi: edges[i + 1] - 1 };
    const sig = [];
    for (let k = 0; k < IT_KEYS; k++) sig.push(patches.indexOf(inst.resolvePatch(clamp(Math.round(keyPitch(k)), 0x20, 0xffff), band.hi)));
    band.sig = sig.join(",");
    const prev = bands[bands.length - 1];
    if (prev && prev.sig === band.sig) prev.hi = band.hi;
    else bands.push(band);
  }
  return bands;
}

const bandOf = (bands, vol) => {
  const i = bands.findIndex((b) => vol >= b.lo && vol <= b.hi);
  return i < 0 ? bands.length - 1 : i;
};

/** The sound a key-map patch (or the base record, `patch` null) plays, as the
 *  module will hold it — null when there is none. */
function sampledSource(inst, slot, patch, index) {
  const p = patch;
  const len = p ? p.sampleLength : inst.sampleLength;
  if (len <= 0) return null;
  const vib = p === null || patchVibratoInherits(p)
    ? { speed: inst.vibratoSpeed, sweep: inst.vibratoSweep, depth: inst.vibratoDepth, rate: inst.vibratoRate, wave: inst.vibratoWaveform }
    : { speed: p.vibratoSpeed, sweep: p.vibratoSweep, depth: p.vibratoDepth, rate: p.vibratoRate,
        wave: p.vibratoWaveform === 0xff ? inst.vibratoWaveform : p.vibratoWaveform };
  return {
    id: `p${slot}:${index}`, kind: "pool", patch: p,
    ptr: p ? p.samplePtr : inst.samplePtr, len,
    chan2: p && patchIsStereo(p) ? p.chanPtrs[0] : -1,
    rate: p ? p.samplingRate : inst.samplingRate,
    detune: p ? p.sampleDetune : inst.sampleDetuneSigned,
    playStart: p ? p.playStart : inst.samplePlayStart,
    loopStart: p ? p.loopStart : inst.sampleLoopStart,
    loopEnd: p ? p.loopEnd : inst.sampleLoopEnd,
    loopMode: p ? p.loopMode : inst.loopMode,
    dnv: p && p.defaultNoteVolume !== 0 ? p.defaultNoteVolume : inst.defaultNoteVolume & 0xff,
    pan: samplePan(inst, p),
    atten: p && p.hasExtra ? p.extraInitialAttenOctet : inst.initialAttenOctet,
    vib,
  };
}

// ── envelopes ───────────────────────────────────────────────────────────────

const ENV_DEFAULT = { vol: 64, pan: 0, pf: 0 };

/** An IT envelope block (82 bytes) from a Taud one. `kind`: vol, pan, pitch
 *  or filter. Times are seconds in Taud and ticks in IT: converted at the
 *  song's starting tempo. */
function itEnvelope(nodes, loopWord, susWord, kind, tps, counts) {
  const out = new Uint8Array(82);
  const dv = new DataView(out.buffer);
  const present = nodes !== null && envPresent(loopWord);
  const def = kind === "vol" ? ENV_DEFAULT.vol : 0;
  if (!present) {
    out[1] = 2;
    out[6] = def & 0xff; dv.setUint16(7, 0, true);
    out[9] = def & 0xff; dv.setUint16(10, 100, true);
    return { bytes: out, on: false };
  }
  let count = 25;
  for (let i = 0; i < 25; i++) if (nodes[i].offset === 0) { count = i + 1; break; }
  const value = (v) => kind === "vol"
    ? it64(v)
    : clamp(Math.round((v * 64) / 255 - 32), -32, 32);
  // The importer's stand-in for "no envelope": flat at full volume (it sets
  // the loop bit so the single node is read).
  if (kind === "vol" && nodes.slice(0, count).every((n) => n.value === 63)) {
    return itEnvelope(null, 0, 0, kind, tps, counts);
  }
  // Each segment rounded to whole ticks on its own: an imported envelope's
  // segments were whole ticks, and come back as exactly those.
  let tick = 0;
  let clipped = false;
  for (let i = 0; i < count; i++) {
    if (tick > ENV_TICK_MAX) { tick = ENV_TICK_MAX; clipped = true; }
    out[6 + i * 3] = value(nodes[i].value) & 0xff;
    dv.setUint16(7 + i * 3, tick, true);
    tick += Math.round(minifloatToDouble(nodes[i].offset) * tps);
  }
  if (clipped) counts.envelopeLength++;
  const node = (w, shift) => Math.min((w >>> shift) & 0x1f, count - 1);
  let flags = 1;
  if (loopWord & 0x20) flags |= 2;
  if (susWord & 0x20) flags |= 4;
  if (loopWord & 0x40) flags |= 8;               // carry
  if (kind === "filter") flags |= 0x80;
  out[0] = flags;
  out[1] = count;
  out[2] = node(loopWord, 8); out[3] = node(loopWord, 0);
  out[4] = node(susWord, 8); out[5] = node(susWord, 0);
  return { bytes: out, on: true };
}

/** IT's cutoff (0…127) for a SoundFont cutoff in absolute cents, by the
 *  frequency each means (core/engine/filter.js: 110 × 2^(c/24 + 1/4) Hz). */
function itCutoffOfCents(cents) {
  const hz = 8.176 * 2 ** (cents / 1200);
  return Math.round(24 * (Math.log2(hz / 110) - 0.25));
}

/** {ifc, ifr} bytes (bit 7 = enabled) for an instrument's default filter. */
function itFilter(sfMode, cutoff, resonance) {
  if (sfMode) {
    if (cutoff >= 0xffff) return { ifc: 0, ifr: 0 };
    const c = itCutoffOfCents(cutoff);
    const q = resonance >= 0xffff ? 0 : clamp(Math.round(((resonance / 10) * 128) / 24), 0, 127);
    if (c >= 127 && q === 0) return { ifc: 0, ifr: 0 };   // open: no filter
    return { ifc: 0x80 | clamp(c, 0, 127), ifr: q > 0 ? 0x80 | q : 0 };
  }
  const ifc = cutoff >= 0xff ? 0 : 0x80 | clamp(Math.round(cutoff / 2), 0, 127);
  const ifr = resonance >= 0xff || (resonance === 0 && ifc === 0) ? 0 : 0x80 | clamp(Math.round(resonance / 2), 0, 127);
  return { ifc, ifr };
}

// ── names ───────────────────────────────────────────────────────────────────

function nameBytes(text, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < Math.min(n - 1, text.length); i++) {
    const c = text.charCodeAt(i);
    out[i] = c < 0x20 || (c >= 0x7f && c < 0xa0) || c > 0xff ? 0x3f : c;
  }
  return out;
}

const cents = (units) => {
  const c = Math.round((units * 1200) / 4096);
  return (c >= 0 ? "+" : "") + c + "c";
};

// ── the export ──────────────────────────────────────────────────────────────

/**
 * Export one song. Returns {title, errors, warnings, bytes} — `bytes` is the
 * .it, or null when any error stands (nothing is written then).
 */
export function exportItSong(doc, songIndex, opts = {}) {
  // A module is a version-2 world (one effect a row, a 6-bit volume, a front-arc
  // panning column): read the format-3 project through its narrow view, and
  // say what it could not carry.
  const narrowed = narrowedForExport(doc, songIndex);
  doc = narrowed.doc;
  opts.bounces ??= new Map();     // one render per instrument and note, whatever the attempt
  const song = doc.songs[songIndex];
  const stepUnits = opts.coarsen ? (FRACTION_STEPS_CENTS[opts.coarsen - 1] * 4096) / 1200 : 0;
  // A 12-tone note is stored rounded to the unit, so it sits a fraction of
  // one off the grid: that is no microtone.
  const quant = (f) => (Math.abs(f) <= FRACTION_TOLERANCE ? 0
    : stepUnits > 0 ? Math.round(f / stepUnits) * stepUnits : f);
  const errors = findings();
  const warnings = findings();
  const storedTitle = doc.meta?.songMeta?.[songIndex]?.name || doc.meta?.projectName || "";
  const title = unescapeName(storedTitle);

  // ── the song's own settings ──
  if (narrowed.lost.effect2 > 0) warnings.add("effect2", { n: narrowed.lost.effect2 });
  if (narrowed.lost.position > 0) warnings.add("position", { n: narrowed.lost.position });
  const toneMode = song.globalFlags & 3;
  if (toneMode > 1) errors.add("toneMode");
  const linear = toneMode === 0;
  const orders = playedCues(song);
  if (orders > IT_ORDERS) errors.add("orders", { n: orders });
  if (errors.size > 0) return { title, errors: errors.list(), warnings: warnings.list(), bytes: null };

  if (song.bpm < BPM_MIN || song.bpm > BPM_MAX) warnings.add("tempo", { bpm: song.bpm });
  if ((song.surroundModel ?? 0) !== 0) warnings.add("surround");
  if (!isDefaultMastering(doc.mastering(songIndex))) warnings.add("mastering");
  // Standard pitch (C9 @ 8363 — the importer's own declaration — A4 @ 440 and
  // C4 @ 262 lie within 2.5 cents) is IT's; any other tuning detunes every sample.
  const ratio = tuningRatioOf(song.tuningBaseNote, song.tuningFreq);
  const tuning = Math.abs(1200 * Math.log2(ratio)) <= TUNING_TOLERANCE_CENTS ? 1 : ratio;
  if (tuning !== 1) warnings.add("tuning");
  if (opts.coarsen) warnings.add("coarsened", { cents: FRACTION_STEPS_CENTS[opts.coarsen - 1] });

  const infos = [];
  for (let c = 0; c < orders; c++) infos.push(cueInfo(song.cues[c]));
  const lanes = Math.min(doc.channelCount, IT_CHANNELS);

  // ── walk the song in cue order: Taud cells → IT cells (notes pending) ──
  const counts = { rounded: 0, dropped: 0, fastFade: 0, porta: 0, envelopeLength: 0 };
  const rounded = () => { counts.rounded++; };
  const referenced = new Set();
  const triggers = new Map();      // slot → [{note, vol}]
  const chnPan = new Array(IT_CHANNELS).fill(null);
  // `pan` is the pan IT's channel holds (6-bit; null = unknown): IT keeps a
  // channel's pan from note to note, so a pan SET restating it says nothing.
  const state = Array.from({ length: lanes }, () => ({ slot: 0, vol: 63, pan: null, mem: { d: 0, k: 0, l: 0 } }));
  const grid = [];
  for (let c = 0; c < orders; c++) {
    const rowLimit = infos[c].rowLimit;
    const chans = [];
    for (let ch = 0; ch < lanes; ch++) {
      const rows = playedRows(doc, songIndex, song.cues[c][ch], rowLimit);
      const st = state[ch];
      const out = [];
      for (let r = 0; r < rowLimit; r++) {
        const it = { note: -1, taudNote: 0, slot: 0, inst: 0, vol: 0, porta: false, vc: -1, fx: 0, arg: 0 };
        out.push(it);
        const cell = rows?.[r];
        if (!cell) continue;
        const where = { cue: c, lane: ch, row: r };
        const ctx = { linear, toneMode, rounded, drop: (code) => warnings.add("effect", { fx: code }, where) };

        if (cell.inst !== 0) {
          st.slot = cell.inst;
          it.inst = cell.inst;
          referenced.add(cell.inst);
        }
        if (cell.note >= 0x20) {
          const inst = doc.instruments[st.slot];
          const vol = cell.volEff === SEL_SET ? cell.vol
            : cell.inst !== 0 ? defaultVolume(inst) : st.vol;
          // The IT volume it stands for, kept from the wide SET where there is one.
          const v64 = cell.volEff === SEL_SET ? vol64(cell)
            : cell.inst !== 0 ? vol64({ vol: defaultVolume(inst) }) : st.v64;
          it.taudNote = cell.note;
          it.slot = st.slot;
          it.vol = vol;
          it.v64 = v64;
          // A tone portamento slides to the note; it plays nothing new.
          it.porta = cell.fx === OP.OP_G || cell.fx === OP.OP_L;
          st.vol = vol;
          st.v64 = v64;
          // An instrument with a pan of its own sets the channel's at the note.
          if (!it.porta && pansItself(inst)) st.pan = null;
          if (st.slot !== 0) {
            referenced.add(st.slot);
            if (!it.porta) {
              if (!triggers.has(st.slot)) triggers.set(st.slot, []);
              triggers.get(st.slot).push({ note: cell.note, vol });
            }
          }
        } else if (cell.note === NOTE_KEYOFF) it.note = IT_NOTE_OFF;
        else if (cell.note === NOTE_CUT) it.note = IT_NOTE_CUT;
        else if (cell.note === NOTE_FADE) it.note = IT_NOTE_FADE;
        else if (cell.note === NOTE_FAST_FADE) { it.note = IT_NOTE_CUT; counts.fastFade++; }
        if (cell.inst !== 0 && cell.note < 0x20) {
          st.vol = defaultVolume(doc.instruments[cell.inst]);
          st.v64 = vol64({ vol: st.vol });
        }
        if (cell.volEff === SEL_SET && cell.note < 0x20) { st.vol = cell.vol; st.v64 = vol64(cell); }

        let main = effectColumn(cell, st, ctx);
        const vol = volumeColumn(cell);
        let pan = panColumn(cell);
        // The lane's opening pan is the channel's (the header), and the
        // row-0 pan the importer writes into every pattern only restates it.
        if (pan?.set && r === 0) {
          if (c === 0 && chnPan[ch] === null) chnPan[ch] = cell.pan;
          if (chnPan[ch] === cell.pan) { pan = null; st.pan = cell.pan; }
        }
        if (pan?.set && st.pan === cell.pan) pan = null;
        else if (pan?.set) st.pan = cell.pan;
        else if (pan) st.pan = null;
        let vc = -1;
        if (vol) {
          if (vol.alt && main === null) main = vol.alt;
          else { vc = vol.vc; if (vol.alt) rounded(); }
        }
        if (pan) {
          if (pan.set && vc < 0) vc = pan.vc;
          else if (main === null) main = pan.set ? pan.alt : pan;
          else counts.dropped++;
        }
        it.vc = vc;
        if (main) { it.fx = main.fx; it.arg = main.arg; }
        // An effect that moves the channel's pan leaves it unknown.
        if (main && (main.fx === fx("X") || main.fx === fx("P") || main.fx === fx("Y") ||
            (main.fx === fx("S") && (main.arg >>> 4) === 8))) st.pan = null;
      }
      chans.push(out);
    }
    grid.push({ rows: rowLimit, chans });
  }

  // ── instrument plans: velocity bands × variants per Taud slot ──
  const slots = [...referenced].filter((s) => s >= 1).sort((a, b) => a - b);
  const plans = new Map();
  for (const slot of slots) {
    const inst = doc.instruments[slot];
    const rendered = isRendered(inst);
    const bands = rendered ? [{ lo: 0, hi: 63 }] : volumeBands(inst);
    const evs = triggers.get(slot) ?? [];
    const byBand = bands.map(() => []);
    for (const e of evs) byBand[bandOf(bands, e.vol)].push(e.note);
    plans.set(slot, { slot, inst, rendered, bands, byBand });
  }
  const variantsOf = (plan) => {
    const used = plan.bands.map((_, b) => b).filter((b) => plan.byBand[b].length > 0);
    if (used.length === 0) used.push(plan.bands.length - 1);
    return used.map((b) => ({ band: b, variants: planVariants(plan.byBand[b], quant) }));
  };
  for (const plan of plans.values()) plan.layout = variantsOf(plan);
  const total = () => [...plans.values()].reduce((n, p) => n + p.layout.reduce((m, l) => m + l.variants.length, 0), 0);
  // No room for every volume band: each instrument plays its loudest.
  if (opts.mergeBands || total() > IT_CLASSIC) {
    const merged = [];
    for (const plan of plans.values()) {
      if (plan.layout.length < 2) continue;
      const top = plan.bands.length - 1;
      plan.byBand = plan.bands.map((_, b) => (b === top ? plan.byBand.flat() : []));
      plan.layout = variantsOf(plan);
      merged.push(hex(plan.slot, 2));
    }
    if (merged.length > 0) warnings.add("velocityMerged", { slots: merged.join(", ") });
  }
  const bandSplit = [...plans.values()].filter((p) => p.layout.length > 1).map((p) => hex(p.slot, 2));
  if (bandSplit.length > 0) warnings.add("velocitySplit", { slots: bandSplit.join(", ") });

  // IT instruments, numbered as the slots were when each is one instrument
  // and they fit Impulse Tracker's 99 (an imported module comes back as it
  // went in), else packed in slot order.
  const itInsts = [];
  for (const plan of plans.values()) {
    plan.it = new Map();
    for (const { band, variants } of plan.layout) {
      variants.forEach((v, vi) => {
        const entry = { plan, band, variant: vi, frac: v.frac, used: v.used, nearest: v.nearest };
        itInsts.push(entry);
        plan.it.set(`${band}:${vi}`, entry);
      });
    }
  }
  const identity = itInsts.length === plans.size && slots.every((s) => s <= IT_CLASSIC);
  // Numbered as they are, the instruments the song does not play come along
  // too (sampled ones: a rendered instrument needs notes to bounce), so an
  // imported module keeps them — unless that is what runs out of numbers.
  if (identity && !opts.dropUnused) {
    for (const slot of doc.usedInstrumentSlots()) {
      if (slot < 1 || slot > IT_CLASSIC || plans.has(slot)) continue;
      const inst = doc.instruments[slot];
      if (isRendered(inst)) continue;
      const bands = volumeBands(inst);
      const plan = { slot, inst, rendered: false, bands, byBand: bands.map(() => []), spare: true };
      plan.layout = variantsOf(plan);
      const v = plan.layout[0].variants[0];
      const entry = { plan, band: plan.layout[0].band, variant: 0, frac: v.frac, used: v.used, nearest: v.nearest };
      plan.it = new Map([[`${entry.band}:0`, entry]]);
      plans.set(slot, plan);
      itInsts.push(entry);
    }
  }
  itInsts.forEach((e, i) => { e.number = identity ? e.plan.slot : i + 1; });
  const instCount = itInsts.reduce((n, e) => Math.max(n, e.number), 0);
  // Past the format's numbers with velocity layers split: unify them and try again.
  if (instCount > IT_SLOTS && coarser(opts) !== null) return exportItSong(doc, songIndex, coarser(opts));
  if (instCount > IT_SLOTS) errors.add("instruments", { n: instCount });
  const variantSlots = [...plans.values()].filter((p) => p.layout.some((l) => l.variants.length > 1));
  if (variantSlots.length > 0) warnings.add("variants", { slots: variantSlots.map((p) => hex(p.slot, 2)).join(", ") });
  if (errors.size > 0) return { title, errors: errors.list(), warnings: warnings.list(), bytes: null };

  // ── notes: the key the pattern shows, the IT instrument that plays it ──
  const tpsOf = Math.max(song.bpm, 1) * 2 / 5;
  /** The IT instrument a trigger of `slot` at (note, vol) plays, and its key. */
  const resolveTrigger = (slot, note, vol) => {
    const plan = plans.get(slot);
    const k = keyOf(note);
    const f = quant(note - keyPitch(k));
    const top = plan.layout[plan.layout.length - 1].band;
    let b = bandOf(plan.bands, vol);
    if (!plan.layout.some((l) => l.band === b)) b = top;
    const layout = plan.layout.find((l) => l.band === b);
    let vi = layout.variants.findIndex((v) => v.used.has(k) && Math.abs(v.used.get(k) - f) <= FRACTION_TOLERANCE);
    if (vi < 0) vi = 0;
    return { entry: plan.it.get(`${b}:${vi}`), key: k };
  };
  for (let ch = 0; ch < lanes; ch++) {
    let held = null;          // the IT instrument the channel holds
    for (const { chans } of grid) {
      for (const it of chans[ch]) {
        if (it.taudNote !== 0 && it.slot !== 0) {
          const heldOk = held !== null && held.plan.slot === it.slot;
          if (it.porta && heldOk) {
            // Sliding to a note keeps the sample: the key is whichever lands
            // nearest the pitch with the held instrument's fractions.
            let k = keyOf(it.taudNote);
            k = keyOf(it.taudNote - held.frac[k]);
            if (Math.abs(it.taudNote - keyPitch(k) - held.frac[k]) > FRACTION_TOLERANCE) counts.porta++;
            it.note = k;
            if (it.inst !== 0) it.inst = held.number;
          } else {
            const { entry, key } = resolveTrigger(it.slot, it.taudNote, it.vol);
            it.note = key;
            if (it.inst !== 0 || entry !== held) {
              // A new instrument number sets the sample's default volume; a
              // bare note in Taud kept the lane's, so the volume column says so.
              if (it.inst === 0 && it.vc < 0) it.vc = it.v64 ?? Math.min(64, it.vol >= 63 ? 64 : it.vol);
              it.inst = entry.number;
            }
            held = entry;
          }
        } else if (it.taudNote !== 0) {
          it.note = keyOf(it.taudNote);     // a note with no instrument yet: silent in both
        } else if (it.inst !== 0) {
          // An instrument number alone: the slot's first IT instrument, or the
          // one already held when it belongs to the same slot.
          const plan = plans.get(it.inst);
          const entry = held !== null && held.plan === plan ? held : plan.it.values().next().value;
          it.inst = entry.number;
          held = entry;
        }
      }
    }
  }
  if (counts.porta > 0) warnings.add("porta", { n: counts.porta });

  // ── rendered instruments: one bounce per octave played ──
  let renderable = null, projectImage = null, chipImage = null, chipLevel = 0, chipRef = 0;
  const bounces = new Map();     // slot → [{note, src}]
  const renderedNames = [];
  const silentNames = [];
  for (const plan of plans.values()) {
    if (!plan.rendered) continue;
    if (plan.byBand.flat().length === 0) continue;
    if (chipImage === null) {
      renderable = doc.toRenderable(songIndex);
      projectImage = renderable.sampleInstImage;
      chipRef = referenceSlot(plan.slot);
      chipImage = bounceImage(projectImage, chipRef);
      chipLevel = referenceLevel(song, chipImage, chipRef);
    } else if (chipRef === plan.slot) {
      chipRef = referenceSlot(plan.slot);
      chipImage = bounceImage(projectImage, chipRef);
    }
    // A melodic instrument is bounced once an octave; a percussion one (a drum
    // kit: every key its own drum) once a key.
    const perc = plan.inst.isPercussion;
    const events = triggers.get(plan.slot) ?? [];
    const octaves = new Map();
    for (const e of events) {
      const o = perc ? keyOf(e.note) : Math.floor(keyOf(e.note) / 12);
      if (!octaves.has(o)) octaves.set(o, []);
      octaves.get(o).push(e);
    }
    let groups = [...octaves.entries()].sort((a, b) => a[0] - b[0]).map(([, es]) => es);
    const mid = (es) => median(es.map((e) => e.note));
    while (!perc && groups.length > MAX_BOUNCES) {
      // Too many octaves: the two neighbouring groups closest together merge.
      let best = 0;
      for (let i = 1; i + 1 < groups.length; i++) {
        if (mid(groups[i + 1]) - mid(groups[i]) < mid(groups[best + 1]) - mid(groups[best])) best = i;
      }
      groups.splice(best, 2, groups[best].concat(groups[best + 1]));
    }
    // Each group is bounced at a note AND volume the song plays, the one
    // nearest the group's middle: a SoundFont preset trimmed to the song may
    // answer at nothing else (its key maps hold only the zones played, at the
    // volumes played). One that still sounds nothing gives way to the next.
    const bounceOf = (note, vol) => {
      const bKey = `${plan.slot}:${note}:${vol}`;
      if (!opts.bounces.has(bKey)) {
        opts.bounces.set(bKey, bounceChipInstrument(song, chipImage, plan.slot, note, chipLevel, renderable.ixmp, chipRef, vol));
      }
      return opts.bounces.get(bKey);
    };
    const list = groups.map((es, i) => {
      const m = mid(es);
      const seen = new Set();
      const tries = [...es]
        .filter((e) => e.vol > 0)
        .sort((a, b) => Math.abs(a.note - m) - Math.abs(b.note - m) || b.vol - a.vol)
        .filter((e) => !seen.has(`${e.note}:${e.vol}`) && seen.add(`${e.note}:${e.vol}`))
        .slice(0, 4);
      if (tries.length === 0) tries.push({ note: Math.round(m), vol: 63 });
      let pick = tries[0], b = null;
      for (const t of tries) {
        pick = t;
        b = bounceOf(t.note, t.vol);
        if (!b.silent) break;
      }
      return {
        note: pick.note,
        src: {
          id: `r${plan.slot}:${i}`, kind: "f32", pcm: b.pcm, rate: b.rate, detune: 0,
          playStart: 0, len: b.pcm.length, chan2: -1,
          loopStart: b.loopStart, loopEnd: b.loopEnd, loopMode: b.loopStart >= 0 ? 1 : 0,
          dnv: plan.inst.defaultNoteVolume & 0xff, pan: 0xff, atten: 0, vib: null, patch: null,
          looped: b.loopStart >= 0, silent: b.silent === true,
        },
      };
    });
    bounces.set(plan.slot, list);
    const shown = unescapeName(doc.instrumentName(plan.slot)) || `#${plan.slot}`;
    renderedNames.push(shown);
    if (list.some((b) => b.src.silent)) silentNames.push(shown);
  }
  if (renderedNames.length > 0) warnings.add("rendered", { names: renderedNames.join(", ") });
  if (silentNames.length > 0) warnings.add("silent", { names: silentNames.join(", ") });

  // ── samples and instruments ──
  const sources = new Map();      // `${slot}:${patchIndex}` → source
  const sourceOf = (plan, patch) => {
    const patches = plan.inst.extraPatches;
    const index = patch === null ? -1 : patches.indexOf(patch);
    const key = `${plan.slot}:${index}`;
    if (!sources.has(key)) sources.set(key, sampledSource(plan.inst, plan.slot, patch, index));
    return sources.get(key);
  };
  const samples = [];             // IT samples, in number order
  const sampleIndex = new Map();
  const bySlot = new Map();
  const slotWarn = (slot, code) => {
    if (!bySlot.has(code)) bySlot.set(code, new Set());
    bySlot.get(code).add(slot);
  };
  const instruments = new Array(instCount).fill(null);
  const sampleKey = (src, f) => {
    let c5 = src.rate * 2 ** ((src.detune + f) / 4096) * tuning;
    const off = c5 > C5_SPEED_MAX || c5 < 1;
    c5 = Math.round(clamp(c5, 1, C5_SPEED_MAX));
    return { key: `${src.id}|${c5}`, c5, off };
  };
  /** The IT sample number that plays `src` detuned by `f`, made on first use. */
  const sampleFor = (src, f, slot, baseName) => {
    const { key, c5, off } = sampleKey(src, f);
    if (off) slotWarn(slot, "c5Speed");
    let n = sampleIndex.get(key);
    if (n === undefined) {
      n = samples.length + 1;
      const fracName = Math.abs(f) > FRACTION_TOLERANCE ? " " + cents(f) : "";
      samples.push({ src, c5, name: baseName.slice(0, 25 - fracName.length) + fracName });
      sampleIndex.set(key, n);
    }
    return n <= IT_SLOTS ? n : 0;
  };
  const unplayed = [];
  for (const entry of itInsts) {
    const { plan } = entry;
    const { inst, slot } = plan;
    const keyboard = new Uint8Array(IT_KEYS * 2);
    const usage = new Map();      // source → keys played with it, for the dominant zone
    const notesHere = entry.used;
    const bandVol = plan.bands[entry.band].hi;
    const baseName = unescapeName(doc.instrumentName(slot));
    // A key the song plays sounds its own zone. Any other is filled in once
    // every instrument's played keys are (below): with its own zone too when
    // that costs no new sample or there is room, else its nearest played
    // neighbour's, transposed — a module has 255 sample numbers.
    const keySource = new Array(IT_KEYS).fill(null);
    const zoneOf = (k) => {
      const pitch = keyPitch(k) + entry.frac[k];
      if (plan.rendered) {
        const list = bounces.get(slot);
        return list ? list.reduce((a, b) => (Math.abs(b.note - pitch) < Math.abs(a.note - pitch) ? b : a)).src : null;
      }
      return sourceOf(plan, inst.resolvePatch(clamp(Math.round(pitch), 0x20, 0xffff), bandVol));
    };
    for (let k = 0; k < IT_KEYS; k++) {
      keyboard[k * 2] = k;
      if (notesHere.size > 0 && !notesHere.has(k)) continue;
      const src = keySource[k] = zoneOf(k);
      if (src === null) continue;
      if (notesHere.has(k)) usage.set(src, (usage.get(src) ?? 0) + 1);
      keyboard[k * 2 + 1] = sampleFor(src, entry.frac[k], slot, baseName);
    }
    if (notesHere.size > 0) unplayed.push({ entry, keyboard, keySource, zoneOf, slot, baseName });
    // The zone the song plays most speaks for the instrument where IT keeps a
    // thing per instrument and Taud per zone: envelopes, fadeout, filter.
    let dominant = null, best = -1;
    for (const [src, n] of usage) if (n > best) { best = n; dominant = src; }
    const zone = dominant?.patch ?? null;
    const patchesDiffer = !plan.rendered && inst.extraPatches !== null &&
      inst.extraPatches.some((p) => p.volEnv !== null || p.panEnv !== null || p.filterEnv !== null ||
        p.pitchEnv !== null || p.hasExtra) && new Set(usage.keys()).size > 1;
    if (patchesDiffer) slotWarn(slot, "zoneUnified");

    let volEnv, panEnv, pfEnv;
    let fadeout, filter;
    if (plan.rendered) {
      // The bounce already carries the envelopes, filter and vibrato.
      volEnv = itEnvelope(null, 0, 0, "vol", tpsOf, counts);
      panEnv = itEnvelope(null, 0, 0, "pan", tpsOf, counts);
      pfEnv = itEnvelope(null, 0, 0, "pitch", tpsOf, counts);
      const sustains = (bounces.get(slot) ?? []).some((b) => b.src.looped);
      fadeout = fadeoutOf(inst) > 0 ? fadeoutOf(inst) : sustains ? RENDERED_FADEOUT : 0;
      filter = { ifc: 0, ifr: 0 };
    } else {
      // IT's volume envelope is Taud's 0…63 one: an 8-bit envelope narrows
      // back (exactly, for one that was widened from 0…63).
      const vol63 = (nodes) => (inst.volEnv8
        ? nodes.map((n) => ({ value: volEnvValue63(n.value, true), offset: n.offset })) : nodes);
      volEnv = zone?.volEnv
        ? itEnvelope(vol63(zone.volEnv), zone.volEnvLoop, zone.volEnvSustain, "vol", tpsOf, counts)
        : itEnvelope(vol63(inst.volEnvelopes), inst.volEnvLoop, inst.volEnvSustainWord, "vol", tpsOf, counts);
      panEnv = zone?.panEnv
        ? itEnvelope(zone.panEnv, zone.panEnvLoop, zone.panEnvSustain, "pan", tpsOf, counts)
        : itEnvelope(inst.panEnvelopes, inst.panEnvLoop, inst.panEnvSustainWord, "pan", tpsOf, counts);
      // IT has ONE pitch-or-filter envelope; a SoundFont zone drives both.
      const roles = { pitch: null, filter: null };
      for (const [nodes, loop, sus] of [
        [inst.pfEnvelopes, inst.pfEnvLoop, inst.pfEnvSustainWord],
        [inst.pf2Envelopes, inst.pf2EnvLoop, inst.pf2EnvSustainWord],
      ]) {
        if (envPresent(loop)) roles[(loop & 0x80) !== 0 ? "filter" : "pitch"] = [nodes, loop, sus];
      }
      if (zone?.pitchEnv) roles.pitch = envPresent(zone.pitchEnvLoop) ? [zone.pitchEnv, zone.pitchEnvLoop, zone.pitchEnvSustain] : null;
      if (zone?.filterEnv) roles.filter = envPresent(zone.filterEnvLoop) ? [zone.filterEnv, zone.filterEnvLoop, zone.filterEnvSustain] : null;
      if (roles.pitch && roles.filter) slotWarn(slot, "pitchAndFilter");
      pfEnv = roles.filter ? itEnvelope(...roles.filter, "filter", tpsOf, counts)
        : roles.pitch ? itEnvelope(...roles.pitch, "pitch", tpsOf, counts)
        : itEnvelope(null, 0, 0, "pitch", tpsOf, counts);
      fadeout = zone?.hasExtra ? zone.fadeoutStep : fadeoutOf(inst);
      filter = zone?.hasExtra
        ? itFilter(zone.filterSfMode, zone.extraCutoff, zone.extraResonance)
        : itFilter(inst.filterSfMode, inst.defaultCutoff16, inst.defaultResonance16);
      if (inst.filterSfMode || zone?.filterSfMode) slotWarn(slot, "soundfont");
    }
    if (inst.imixId !== 0) slotWarn(slot, "imix");
    const nna = [2, 0, 1, 3, 2][inst.newNoteAction];       // Taud's order → IT's; release = note off
    let dct = inst.duplicateCheckType, dca = inst.duplicateCheckAction;
    if (dct > 3) { dct = 3; slotWarn(slot, "laneCheck"); } // "lane": the instrument is the nearest IT has
    if (dca > 2) dca = 0;
    const panP = instrumentPans(inst);
    const suffix = entry.variant > 0 ? ` v${entry.variant + 1}` : "";
    const bandSuffix = plan.layout.length > 1 ? ` ${plan.bands[entry.band].lo}-${plan.bands[entry.band].hi}` : "";
    const tag = bandSuffix + suffix;
    instruments[entry.number - 1] = {
      name: baseName.slice(0, 25 - tag.length) + tag,
      nna, dct, dca,
      fadeout: Math.min(fadeout, 1024),
      pps: clamp(inst.pitchPanSeparation, -32, 32),
      ppc: keyOf(inst.pitchPanCentre),
      gbv: clamp(Math.round(((inst.instGlobalVolume & 0xff) * 128) / 255), 0, 128),
      dfp: panP ? clamp(Math.round((inst.defaultPan * 64) / 255), 0, 64) : 32 | 0x80,
      rv: clamp(Math.round((inst.volumeSwing * 100) / 255), 0, 100),
      rp: clamp(Math.round((inst.panSwing * 64) / 255), 0, 64),
      ifc: filter.ifc, ifr: filter.ifr,
      keyboard, volEnv: volEnv.bytes, panEnv: panEnv.bytes, pfEnv: pfEnv.bytes,
      filterEnv: pfEnv.bytes[0] & 0x80,
    };
  }
  for (const { entry, keyboard, keySource, zoneOf, slot, baseName } of unplayed) {
    for (let k = 0; k < IT_KEYS; k++) {
      if (entry.used.has(k)) continue;
      const f = entry.frac[k];
      const own = zoneOf(k);
      const src = own !== null && (sampleIndex.has(sampleKey(own, f).key) || samples.length < IT_CLASSIC)
        ? own : keySource[entry.nearest[k]];
      if (src !== null) keyboard[k * 2 + 1] = sampleFor(src, f, slot, baseName);
    }
  }
  // An instrument with no sample on any key plays nothing, and its pan with
  // it: left unused, as it2taud reads such an instrument (it makes no record).
  for (const ins of instruments) {
    if (ins && !ins.keyboard.some((v, i) => (i & 1) === 1 && v !== 0)) ins.dfp = 32 | 0x80;
  }
  if (samples.length > IT_SLOTS && coarser(opts) !== null) return exportItSong(doc, songIndex, coarser(opts));
  if (samples.length > IT_SLOTS) errors.add("samples", { n: samples.length });
  if (errors.size > 0) return { title, errors: errors.list(), warnings: warnings.list(), bytes: null };

  // ── sample data: written once, every header that plays it pointing there ──
  const data = new Map();
  const itSamples = samples.map(({ src, c5, name }) => {
    let start = 0, playLost = false;
    const mode = src.loopMode & 3;
    let loop = mode === 1 || mode === 2;
    let ls = src.loopStart, le = Math.min(src.loopEnd, src.len);
    if (src.playStart > 0 && src.playStart < src.len) {
      if (!loop || ls >= src.playStart) start = src.playStart;
      else playLost = true;
    }
    if (playLost) slotWarn(src.id.slice(1).split(":")[0] | 0, "playStart");
    ls -= start; le -= start;
    if (le - ls < 1 || ls < 0) loop = false;
    const len = src.len - start;
    const dKey = src.kind === "pool" ? `${src.ptr + start}:${len}:${src.chan2 < 0 ? -1 : src.chan2 + start}` : src.id;
    if (!data.has(dKey)) data.set(dKey, { src, start, len, offset: 0 });
    const vib = src.vib;
    let vis = 0, vid = 0, vir = 0, vit = 0;
    if (vib && vib.depth > 0) {
      vis = clamp(Math.round((vib.speed * 64) / 255), 0, 64);
      vid = clamp(Math.round((vib.depth * 64) / 255), 1, 64);
      // IT ramps the depth in by ViR/256 a tick; FT2's sweep is the ticks to
      // full depth, and none at all (0) is full depth at once.
      vir = vib.rate > 0 ? vib.rate : vib.sweep > 0 ? clamp(Math.round((vid * 256) / vib.sweep), 1, 255) : 255;
      vit = vib.wave <= 3 ? vib.wave : 1;
    }
    const gain = attenGainOf(src.atten);
    const gvl = clamp(Math.round(64 * gain), 0, 64);
    return {
      name, c5, dKey, len, stereo: src.chan2 >= 0, bits16: src.kind === "f32",
      loop, sustain: loop && (src.loopMode & 4) !== 0, pingpong: mode === 2,
      ls: loop ? ls : 0, le: loop ? le : 0,
      gvl, vol: src.dnv === 0 ? 64 : clamp(Math.round((src.dnv * 64) / 255), 0, 64),
      dfp: src.pan === 0xff ? 32 : 0x80 | clamp(Math.round((src.pan * 64) / 255), 0, 64),
      vis, vid, vir, vit,
    };
  });
  for (const [code, set] of bySlot) {
    warnings.add(code, { slots: [...set].sort((a, b) => a - b).map((s) => hex(s, 2)).join(", ") });
  }

  // ── what the cue sheet says, written into the patterns ──
  let flowLost = 0;
  const place = (chans, row, fxn, arg) => {
    // The first free effect slot on the row, lanes first, then the channels
    // past them.
    for (let ch = 0; ch < IT_CHANNELS; ch++) {
      chans[ch] ??= [];
      const c = chans[ch][row];
      if (!c) { chans[ch][row] = { note: -1, inst: 0, vc: -1, fx: fxn, arg }; return; }
      if (c.fx === 0 && c.arg === 0) { c.fx = fxn; c.arg = arg; return; }
    }
    flowLost++;
  };
  for (let c = 0; c < orders; c++) {
    const flow = infos[c].flow;
    if (flow === null) continue;
    const { chans, rows } = grid[c];
    const last = rows - 1;
    if (chans.some((rs) => rs[last] && (rs[last].fx === fx("B") || rs[last].fx === fx("C")))) continue;
    // GOBACK, SKIP and JUMP: the order after this one is somewhere else.
    const target = flow.type === 1 ? Math.max(c - flow.arg, 0) : flow.type === 2 ? c + flow.arg : flow.arg;
    if (target > 0xff) { rounded(); continue; }
    place(chans, last, fx("B"), target);
  }
  if (flowLost > 0) warnings.add("flowLost", { n: flowLost });

  // ── patterns: one per order, the same ones shared ──
  const patterns = [];
  const patternIndex = new Map();
  const orderList = [];
  for (const { rows, chans } of grid) {
    const bytes = packPattern(chans, rows);
    const key = bytes.join(",");
    let idx = patternIndex.get(key);
    if (idx === undefined) {
      idx = patterns.length;
      patternIndex.set(key, idx);
      patterns.push(bytes);
    }
    orderList.push(idx);
  }
  if (patterns.length > IT_PATTERNS) {
    errors.add("patterns", { n: patterns.length });
    return { title, errors: errors.list(), warnings: warnings.list(), bytes: null };
  }
  if (patterns.length > IT_CLASSIC_PATTERNS) warnings.add("manyPatterns", { n: patterns.length });
  if (instCount > IT_CLASSIC || samples.length > IT_CLASSIC) {
    warnings.add("manySlots", { n: Math.max(instCount, samples.length) });
  }
  if (counts.dropped > 0) warnings.add("dropped", { n: counts.dropped });
  if (counts.rounded > 0) warnings.add("rounded", { n: counts.rounded });
  if (counts.fastFade > 0) warnings.add("fastFade", { n: counts.fastFade });
  if (counts.envelopeLength > 0) warnings.add("envelopeLength", { n: counts.envelopeLength });
  if (data.size > 0 && [...data.values()].some((d) => d.src.chan2 >= 0)) warnings.add("stereo");

  // ── the message ──
  let message = (doc.projectString?.("PMsg") ?? "").replace(/\r\n?/g, "\n");
  if (message.length > IT_MESSAGE_MAX) { message = message.slice(0, IT_MESSAGE_MAX); warnings.add("message"); }

  // A speed or tempo set on the first row is the song's starting one: the
  // header says so too (as it2taud reads a module), the row keeping it.
  let speed = song.tickRate, tempo = clamp(song.bpm, BPM_MIN, BPM_MAX);
  for (const rs of grid[0]?.chans ?? []) {
    const c = rs[0];
    if (c?.fx === fx("A") && c.arg > 0) speed = c.arg;
    if (c?.fx === fx("T") && c.arg >= 0x20) tempo = c.arg;
  }
  // A channel past the last one the song writes into is not a lane to an
  // importer (it2taud keeps a gap, never a tail), so its pan stays the
  // default rather than one nothing plays (a subsong of a project whose other
  // songs use more lanes).
  let lastUsed = -1;
  for (const { chans } of grid) {
    chans.forEach((rs, ch) => {
      if (ch > lastUsed && rs.some((it) => it.note >= 0 || it.inst > 0 || it.vc >= 0 || it.fx !== 0)) lastUsed = ch;
    });
  }
  chnPan.fill(null, lastUsed + 1);
  const meta = doc.meta?.songMeta?.[songIndex];
  return {
    title, errors: [], warnings: warnings.list(),
    bytes: writeIt({
      title: latin1(storedTitle, 26),
      highlight: [meta?.beatPri || 4, meta?.beatSec || 16],
      linear, speed, tempo,
      globalVolume: clamp(Math.round((song.globalVolume * 128) / 255), 0, 128),
      mixVolume: clamp(Math.round((song.mixingVolume * 128) / 255), 0, 128),
      chnPan: chnPan.map((p) => (p === null ? 32 : it64(p))),
      orderList, instruments, samples: itSamples, data, patterns,
      message: [...message].map((ch) => (ch === "\n" ? "\r" : ch)).join(""),
      doc,
    }),
  };
}

/** Every song of the project, each its own module. */
export function exportItSongs(doc) {
  return doc.songs.map((_, i) => ({ songIndex: i, ...exportItSong(doc, i) }));
}

/** The file name for song `songIndex` of a project saved as `base`. */
export function itFileName(base, songIndex, songCount) {
  return songCount > 1 ? `${base}-${songIndex + 1}.it` : `${base}.it`;
}

// ── the file ────────────────────────────────────────────────────────────────

/**
 * One pattern, packed as IT packs it (Schism Tracker's save_it_pattern): per
 * channel, a mask that names the fields present, and the last value of each
 * field recalled instead of repeated.
 */
function packPattern(chans, rows) {
  const out = [];
  const last = Array.from({ length: IT_CHANNELS }, () => ({ note: -1, inst: -1, vc: -1, fx: -1, arg: -1, mask: -1 }));
  for (let r = 0; r < rows; r++) {
    for (let ch = 0; ch < IT_CHANNELS; ch++) {
      const c = chans[ch]?.[r];
      if (!c) continue;
      let m = 0;
      if (c.note >= 0) m |= 1;
      if (c.inst > 0) m |= 2;
      if (c.vc >= 0) m |= 4;
      if (c.fx > 0 || c.arg > 0) m |= 8;
      if (m === 0) continue;
      const l = last[ch];
      if ((m & 1) && c.note === l.note) { m = (m & ~1) | 0x10; } else if (m & 1) l.note = c.note;
      if ((m & 2) && c.inst === l.inst) { m = (m & ~2) | 0x20; } else if (m & 2) l.inst = c.inst;
      if ((m & 4) && c.vc === l.vc) { m = (m & ~4) | 0x40; } else if (m & 4) l.vc = c.vc;
      if ((m & 8) && c.fx === l.fx && c.arg === l.arg) { m = (m & ~8) | 0x80; } else if (m & 8) { l.fx = c.fx; l.arg = c.arg; }
      if (m === l.mask) out.push(ch + 1);
      else { l.mask = m; out.push((ch + 1) | 0x80, m); }
      if (m & 1) out.push(c.note);
      if (m & 2) out.push(c.inst);
      if (m & 4) out.push(c.vc);
      if (m & 8) out.push(c.fx, c.arg);
    }
    out.push(0);
  }
  const bytes = new Uint8Array(8 + out.length);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, out.length, true);
  dv.setUint16(2, rows, true);
  bytes.set(out, 8);
  return bytes;
}

const HEADER = 0xc0;
const INSTRUMENT_SIZE = 554;
const SAMPLE_SIZE = 80;

function writeIt(m) {
  const insCount = m.instruments.length;
  const smpCount = m.samples.length;
  const ordCount = m.orderList.length + 1;
  const msgBytes = m.message.length > 0 ? m.message.length + 1 : 0;
  const paraEnd = HEADER + ordCount + 4 * (insCount + smpCount + m.patterns.length);
  const msgOffset = paraEnd;
  let pos = msgOffset + msgBytes;
  const insAt = [], smpAt = [], patAt = [];
  for (let i = 0; i < insCount; i++) { insAt.push(pos); pos += INSTRUMENT_SIZE; }
  for (let i = 0; i < smpCount; i++) { smpAt.push(pos); pos += SAMPLE_SIZE; }
  for (const p of m.patterns) { patAt.push(pos); pos += p.length; }
  for (const d of m.data.values()) {
    d.offset = pos;
    const frames = d.len * (d.src.chan2 >= 0 ? 2 : 1);
    pos += d.src.kind === "f32" ? frames * 2 : frames;
  }

  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x4d, 0x50, 0x4d], 0);               // IMPM
  out.set(m.title.subarray(0, 25), 4);
  out[0x1e] = m.highlight[0] & 0xff;
  out[0x1f] = m.highlight[1] & 0xff;
  dv.setUint16(0x20, ordCount, true);
  dv.setUint16(0x22, insCount, true);
  dv.setUint16(0x24, smpCount, true);
  dv.setUint16(0x26, m.patterns.length, true);
  const filters = m.instruments.some((i) => i && (i.ifc || i.ifr || i.filterEnv));
  dv.setUint16(0x28, 0x0214, true);                    // Cwt/v: IT 2.14, for IT-compatible playback
  dv.setUint16(0x2a, filters ? 0x0217 : 0x0214, true); // Cmwt: filters arrived in 2.17
  dv.setUint16(0x2c, 0x01 | 0x04 | (m.linear ? 0x08 : 0), true); // stereo, instruments, slides
  dv.setUint16(0x2e, (msgBytes > 0 ? 1 : 0) | 4, true);           // message, row highlight
  out[0x30] = m.globalVolume;
  out[0x31] = m.mixVolume;
  out[0x32] = m.speed & 0xff;
  out[0x33] = m.tempo & 0xff;
  out[0x34] = 128;                                     // panning separation
  dv.setUint16(0x36, msgBytes, true);
  dv.setUint32(0x38, msgBytes > 0 ? msgOffset : 0, true);
  for (let ch = 0; ch < IT_CHANNELS; ch++) {
    out[0x40 + ch] = m.chnPan[ch];
    out[0x80 + ch] = 64;
  }
  m.orderList.forEach((p, i) => { out[HEADER + i] = p; });
  out[HEADER + m.orderList.length] = 0xff;
  let o = HEADER + ordCount;
  for (const a of insAt) { dv.setUint32(o, a, true); o += 4; }
  for (const a of smpAt) { dv.setUint32(o, a, true); o += 4; }
  for (const a of patAt) { dv.setUint32(o, a, true); o += 4; }
  for (let i = 0; i < m.message.length; i++) {
    const c = m.message.charCodeAt(i);
    out[msgOffset + i] = c === 0x0d ? 0x0d : c < 0x20 || (c >= 0x7f && c < 0xa0) || c > 0xff ? 0x3f : c;
  }

  m.instruments.forEach((ins, i) => writeInstrument(out, insAt[i], ins));
  m.samples.forEach((s, i) => writeSample(out, smpAt[i], s, m.data.get(s.dKey).offset));
  m.patterns.forEach((p, i) => out.set(p, patAt[i]));
  const bin = m.doc.sampleBin;
  for (const d of m.data.values()) {
    const { src, start, len, offset } = d;
    if (src.kind === "f32") {
      for (let i = 0; i < len; i++) {
        dv.setInt16(offset + i * 2, clamp(Math.round(src.pcm[i] * 32767), -32768, 32767), true);
      }
      continue;
    }
    // The pool is unsigned; IT samples are signed (Cvt bit 0). A stereo pair
    // goes channel after channel, as IT stores it.
    const spans = src.chan2 >= 0 ? [src.ptr + start, src.chan2 + start] : [src.ptr + start];
    spans.forEach((p, c) => {
      for (let j = 0; j < len; j++) out[offset + c * len + j] = bin[p + j] ^ 0x80;
    });
  }
  return out;
}

function writeInstrument(out, at, ins) {
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x4d, 0x50, 0x49], at);              // IMPI
  if (ins === null) {
    // A slot no IT instrument lands in (identity numbering): empty, but valid.
    out[at + 0x19] = 32 | 0x80;
    out[at + 0x18] = 128;
    out[at + 0x17] = IT_C5;
    out[at + 0x3d] = 0xff;
    dv.setUint16(at + 0x3e, 0xffff, true);
    for (let k = 0; k < IT_KEYS; k++) out[at + 0x40 + k * 2] = k;
    const blank = itEnvelope(null, 0, 0, "vol", 1, null).bytes;
    out.set(blank, at + 0x130);
    out.set(itEnvelope(null, 0, 0, "pan", 1, null).bytes, at + 0x182);
    out.set(itEnvelope(null, 0, 0, "pitch", 1, null).bytes, at + 0x1d4);
    return;
  }
  out[at + 0x11] = ins.nna;
  out[at + 0x12] = ins.dct;
  out[at + 0x13] = ins.dca;
  dv.setUint16(at + 0x14, ins.fadeout, true);
  dv.setInt8(at + 0x16, ins.pps);
  out[at + 0x17] = ins.ppc;
  out[at + 0x18] = ins.gbv;
  out[at + 0x19] = ins.dfp;
  out[at + 0x1a] = ins.rv;
  out[at + 0x1b] = ins.rp;
  out.set(nameBytes(ins.name, 26), at + 0x20);
  out[at + 0x3a] = ins.ifc;
  out[at + 0x3b] = ins.ifr;
  out[at + 0x3c] = 0;                                  // MIDI channel: off
  out[at + 0x3d] = 0xff;                               // MIDI program: off
  dv.setUint16(at + 0x3e, 0xffff, true);               // MIDI bank: off
  out.set(ins.keyboard, at + 0x40);
  out.set(ins.volEnv, at + 0x130);
  out.set(ins.panEnv, at + 0x182);
  out.set(ins.pfEnv, at + 0x1d4);
}

function writeSample(out, at, s, dataOffset) {
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x4d, 0x50, 0x53], at);              // IMPS
  out[at + 0x11] = s.gvl;
  let flags = 0x01;
  if (s.bits16) flags |= 0x02;
  if (s.stereo) flags |= 0x04;
  if (s.loop && !s.sustain) flags |= 0x10 | (s.pingpong ? 0x40 : 0);
  if (s.loop && s.sustain) flags |= 0x20 | (s.pingpong ? 0x80 : 0);
  out[at + 0x12] = flags;
  out[at + 0x13] = s.vol;
  out.set(nameBytes(s.name, 26), at + 0x14);
  out[at + 0x2e] = 0x01;                               // signed samples
  out[at + 0x2f] = s.dfp;
  dv.setUint32(at + 0x30, s.len, true);
  dv.setUint32(at + (s.sustain ? 0x40 : 0x34), s.ls, true);
  dv.setUint32(at + (s.sustain ? 0x44 : 0x38), s.le, true);
  dv.setUint32(at + 0x3c, s.c5, true);
  dv.setUint32(at + 0x48, dataOffset, true);
  out[at + 0x4c] = s.vis;
  out[at + 0x4d] = s.vid;
  out[at + 0x4e] = s.vir;
  out[at + 0x4f] = s.vit;
}
