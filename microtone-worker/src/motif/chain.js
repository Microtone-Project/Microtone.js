// A mixing chain written in TML (item 260): a `chain NAME { … }` declaration,
// or a record given straight to an instrument's `chain`, read into the block
// the Instruments view's Mixing tab edits (TAUD_FILE_FORMAT.md §9.15; the
// engine's imix.js). Every piece takes the tab's own words, snake_case; a
// piece named is inserted, one left out is not in the chain at all.
//
// Every value is checked against the range the tab offers (imix.js IMX_RANGE)
// and refused outside it, rather than clamped as the codec clamps a file: a
// program that asks for a 30 dB trim has made a mistake worth hearing about.

import {
  IMX_ITRM, IMX_EQU1, IMX_EQU2, IMX_COMP, IMX_DEQ1, IMX_DEQ2, IMX_SATU, IMX_UNIS, IMX_VERB, IMX_DLAY,
  IMX_LIMI, IMX_MXTL, IMX_RANGE, IMX_EQ_MAX_BANDS, IMX_COMP_MAX_BANDS, IMX_UNIS_MIN_VOICES, IMX_UNIS_MAX_VOICES,
  IMX_WET_APPLICABLE, FX16, defaultEquipment, defaultCompBand, defaultCrossovers, normaliseEquipment,
  isCutShape,
} from "../../core/engine/imix.js";
import { asList, fail } from "./values.js";
import { str, bool, int, num, oneOf, any, readOptions } from "./options.js";

/** The pieces by the name a program gives them, in the chain's own order. */
export const CHAIN_PIECES = Object.freeze({
  input_trim: IMX_ITRM, equaliser_1: IMX_EQU1, dynamic_eq_1: IMX_DEQ1, compressor: IMX_COMP,
  equaliser_2: IMX_EQU2, dynamic_eq_2: IMX_DEQ2, unison: IMX_UNIS, saturator: IMX_SATU,
  tape_delay: IMX_DLAY, reverb: IMX_VERB, limiter: IMX_LIMI, mix_tool: IMX_MXTL,
});

const CHAIN = {
  name: str, on: bool,
  mode: oneOf({ separate: false, bus: true }),
  order: oneOf({ delay_reverb: 0, reverb_delay: 1 }),
  ...Object.fromEntries(Object.keys(CHAIN_PIECES).map((k) => [k, any])),
};

/** A number in one of IMX_RANGE's ranges, `scale` converting what the
 *  program writes into what the range counts (ms → 16.16 s, say). */
const ranged = (key, scale = 1, unit = "") => (v, what) => {
  const [lo, hi] = IMX_RANGE[key];
  const fmt = (x) => `${Number((x / scale).toPrecision(3))}`;
  if (typeof v !== "number" || !Number.isFinite(v)) throw fail(`${what} must be a number`);
  const x = v * scale;
  if (x < lo - 1e-9 || x > hi + 1e-9) throw fail(`${what} must be ${fmt(lo)}…${fmt(hi)}${unit}, not ${v}${unit}`);
  return x;
};
const MS_FX = FX16 / 1000;          // milliseconds → 16.16 seconds
const TICK_QT = 4 * FX16;           // ticks → 16.16 quarter ticks
/** The titlebar's Mix: how much of the processed sound replaces the dry one. */
const mix = num(0, 1);

const EQ_SHAPES = { high_pass: 0, low_shelf: 1, bell: 2, high_shelf: 3, low_pass: 4, notch: 5 };
const EQ_BAND = {
  on: bool, shape: oneOf(EQ_SHAPES), freq: ranged("eqFreq"), gain: ranged("eqGainDb"), q: ranged("eqQ"),
  slope: (v, what) => {
    if (v === 12 || v === 24 || v === 36 || v === 48) return v / 12 - 1;
    throw fail(`${what} is 12, 24, 36 or 48 (dB per octave)`);
  },
};
const COMP_BAND = {
  on: bool, threshold: ranged("compThreshDb"), ratio: ranged("compRatio"), attack: ranged("compAttackMs"),
  release: ranged("compReleaseMs"), knee: ranged("compKneeDb"), make_up: ranged("compMakeupDb"),
};
const DEQ_BAND = {
  on: bool, freq: ranged("eqFreq"), q: ranged("eqQ"), gain: ranged("eqGainDb"),
  threshold: ranged("compThreshDb"), ratio: ranged("compRatio"), attack: ranged("compAttackMs"),
  release: ranged("compReleaseMs"), range: ranged("deqRangeDb"), actor_gain: ranged("deqActorDb"),
  above: oneOf({ cut: false, boost: true }), sensor_freq: ranged("eqFreq"), sensor_q: ranged("eqQ"),
};
/** A dynamic EQ's six bands, by the names its band buttons carry (LS B1…B4
 *  HS), and where each sits in the piece's fixed band list. */
const DEQ_BANDS = { low_shelf: 0, bell_1: 2, bell_2: 3, bell_3: 4, bell_4: 5, high_shelf: 1 };
const LFO = {
  waveform: oneOf({ sine: 0, triangle: 1, square: 2, saw_up: 3, saw_down: 4, random: 5 }),
  rate: ranged("lfoHz", FX16, " Hz"), period_ticks: ranged("lfoQt", TICK_QT, " ticks"),
  depth: ranged("lfoDepth"), restart: bool,
};
const PIECE = {
  [IMX_ITRM]: { on: bool, gain: ranged("trimDb") },
  [IMX_EQU1]: { on: bool, bands: any },
  [IMX_COMP]: { ...COMP_BAND, on: bool, mix, detector: oneOf({ peak: 0, rms: 1 }), crossovers: any, bands: any },
  [IMX_DEQ1]: { on: bool, ...Object.fromEntries(Object.keys(DEQ_BANDS).map((k) => [k, any])) },
  [IMX_UNIS]: {
    on: bool, mix, voices: int(IMX_UNIS_MIN_VOICES, IMX_UNIS_MAX_VOICES), detune: ranged("unisDetune"),
    width: ranged("unisWidth"), spacing: ranged("unisSpacing"), detune_lfo: any, width_lfo: any,
  },
  [IMX_SATU]: {
    on: bool, mix, curve: oneOf({ tape: 0, soft_clip: 1, hard_clip: 2, tube: 3, wavefolder: 4 }),
    drive: ranged("satDriveDb"), input: ranged("satTrimDb"), output: ranged("satTrimDb"), bias: ranged("satBias"),
  },
  [IMX_DLAY]: {
    on: bool, mix, time: ranged("dlaySec", MS_FX, " ms"), time_ticks: ranged("dlayQt", TICK_QT, " ticks"),
    feedback: ranged("dlayFeedback"), high_cut: ranged("dlayHighCut"), low_cut: ranged("dlayLowCut"),
    wow: ranged("dlayWow"), drive: ranged("dlayDriveDb"), ping_pong: bool,
  },
  [IMX_VERB]: {
    on: bool, mix, size: ranged("verbSize"), decay: ranged("verbDecay"), damping: ranged("verbDamping"),
    pre_delay: ranged("verbPreDelay", MS_FX, " ms"),
  },
  [IMX_LIMI]: { on: bool, ceiling: ranged("limCeilingDb"), release: ranged("limReleaseMs"), gain: ranged("limGainDb"), true_peak: bool },
  [IMX_MXTL]: {
    on: bool, gain: ranged("mxGainDb"), width: ranged("mxWidth"), swap: bool, invert_left: bool,
    invert_right: bool, remove_dc: bool,
  },
};
PIECE[IMX_EQU2] = PIECE[IMX_EQU1];
PIECE[IMX_DEQ2] = PIECE[IMX_DEQ1];

const COMP_FIELDS = { threshold: "threshDb", ratio: "ratio", attack: "attackMs", release: "releaseMs", knee: "kneeDb", make_up: "makeupDb" };

function lfoOf(v, what) {
  const o = readOptions(v, LFO, what);
  if (o.rate !== undefined && o.period_ticks !== undefined) throw fail(`${what}: give its rate (Hz) or its period in ticks, not both`);
  const sync = o.period_ticks !== undefined;
  return {
    wave: o.waveform ?? 0, retrigger: o.restart ?? false, sync,
    rate: Math.round(sync ? o.period_ticks : o.rate ?? FX16 / 2), depth: o.depth ?? 0,
  };
}

/** One piece's record → its parameters, starting from what the tab inserts. */
function pieceOf(id, v, what) {
  const o = readOptions(v, PIECE[id], what);
  const e = defaultEquipment(id);
  e.bypass = o.on === false;
  if (o.mix !== undefined) e.dry = Math.round(255 * (1 - o.mix));
  switch (id) {
    case IMX_ITRM: if (o.gain !== undefined) e.gainDb = o.gain; break;
    case IMX_EQU1: case IMX_EQU2:
      if (o.bands !== undefined) {
        const list = asList(o.bands, `${what}'s bands`);
        if (list.length > IMX_EQ_MAX_BANDS) throw fail(`${what} has at most ${IMX_EQ_MAX_BANDS} bands, not ${list.length}`);
        e.bands = list.map((b, i) => {
          const w = `${what}'s band ${i + 1}`;
          const f = readOptions(b, EQ_BAND, w);
          if (f.shape === undefined) throw fail(`${w} needs a shape: ${Object.keys(EQ_SHAPES).map((x) => `"${x}"`).join(", ")}`);
          if (f.slope !== undefined && !isCutShape(f.shape)) throw fail(`${w}: only a high_pass or a low_pass has a slope`);
          const bell = f.shape === 2 || f.shape === 5;
          return {
            on: f.on ?? true, shape: f.shape, slope: f.slope ?? 0, freq: f.freq ?? 1000, gainDb: f.gain ?? 0,
            q: f.q ?? (bell ? 1 : Math.SQRT1_2),
          };
        });
      }
      break;
    case IMX_COMP: {
      if (o.detector !== undefined) e.detector = o.detector;
      const top = Object.keys(COMP_FIELDS).filter((k) => o[k] !== undefined);
      if (o.bands !== undefined) {
        if (top.length) throw fail(`${what}: with bands, give ${top[0]} to each band`);
        const list = asList(o.bands, `${what}'s bands`);
        if (!list.length || list.length > IMX_COMP_MAX_BANDS) throw fail(`${what} has 1…${IMX_COMP_MAX_BANDS} bands, not ${list.length}`);
        e.bands = list.map((b, i) => compBand(readOptions(b, COMP_BAND, `${what}'s band ${i + 1}`)));
      } else e.bands = [compBand({ ...o, on: undefined })]; // a one-band compressor: its `on` is the piece's
      const n = e.bands.length;
      if (o.crossovers !== undefined) {
        const xs = asList(o.crossovers, `${what}'s crossovers`).map((x, i) => ranged("xover")(x, `${what}'s crossover ${i + 1}`));
        if (xs.length !== n - 1) throw fail(`${what}: ${n} band${n === 1 ? "" : "s"} take${n === 1 ? "s" : ""} ${n - 1} crossover${n === 2 ? "" : "s"}, not ${xs.length}`);
        for (let i = 1; i < xs.length; i++) if (!(xs[i] > xs[i - 1])) throw fail(`${what}'s crossovers must rise`);
        e.crossovers = xs;
      } else e.crossovers = defaultCrossovers(n);
      break;
    }
    case IMX_DEQ1: case IMX_DEQ2:
      for (const [name, at] of Object.entries(DEQ_BANDS)) {
        if (o[name] === undefined) continue;
        const w = `${what}'s ${name}`;
        const f = readOptions(o[name], DEQ_BAND, w);
        const b = e.bands[at];
        b.on = f.on ?? true;
        if (f.freq !== undefined) b.freq = f.freq;
        if (f.q !== undefined) b.q = f.q;
        if (f.gain !== undefined) b.gainDb = f.gain;
        for (const [k, to] of [["threshold", "threshDb"], ["ratio", "ratio"], ["attack", "attackMs"],
          ["release", "releaseMs"], ["range", "rangeDb"], ["actor_gain", "actorDb"]]) if (f[k] !== undefined) b[to] = f[k];
        if (f.above !== undefined) b.boost = f.above;
        b.unlinked = f.sensor_freq !== undefined || f.sensor_q !== undefined;
        b.senseFreq = f.sensor_freq ?? b.freq;
        b.senseQ = f.sensor_q ?? b.q;
      }
      break;
    case IMX_UNIS:
      for (const [k, to] of [["voices", "voices"], ["detune", "detune"], ["width", "width"], ["spacing", "spacing"]]) {
        if (o[k] !== undefined) e[to] = o[k];
      }
      if (o.detune_lfo !== undefined) e.detuneLfo = lfoOf(o.detune_lfo, `${what}'s detune_lfo`);
      if (o.width_lfo !== undefined) e.widthLfo = lfoOf(o.width_lfo, `${what}'s width_lfo`);
      break;
    case IMX_SATU:
      for (const [k, to] of [["curve", "curve"], ["drive", "driveDb"], ["input", "inDb"], ["output", "outDb"], ["bias", "bias"]]) {
        if (o[k] !== undefined) e[to] = o[k];
      }
      break;
    case IMX_DLAY:
      if (o.time !== undefined && o.time_ticks !== undefined) throw fail(`${what}: give its time in ms or in ticks, not both`);
      if (o.time !== undefined) { e.sync = false; e.time = Math.round(o.time); }
      if (o.time_ticks !== undefined) { e.sync = true; e.time = Math.round(o.time_ticks); }
      for (const [k, to] of [["feedback", "feedback"], ["high_cut", "highCut"], ["low_cut", "lowCut"], ["wow", "wow"],
        ["drive", "driveDb"], ["ping_pong", "pingPong"]]) if (o[k] !== undefined) e[to] = o[k];
      break;
    case IMX_VERB:
      for (const [k, to] of [["size", "size"], ["decay", "decay"], ["damping", "damping"]]) if (o[k] !== undefined) e[to] = o[k];
      if (o.pre_delay !== undefined) e.preDelay = Math.round(o.pre_delay);
      break;
    case IMX_LIMI:
      for (const [k, to] of [["ceiling", "ceilingDb"], ["release", "releaseMs"], ["gain", "gainDb"], ["true_peak", "truePeak"]]) {
        if (o[k] !== undefined) e[to] = o[k];
      }
      break;
    case IMX_MXTL:
      for (const [k, to] of [["gain", "gainDb"], ["width", "width"], ["swap", "swap"], ["invert_left", "invL"],
        ["invert_right", "invR"], ["remove_dc", "removeDc"]]) if (o[k] !== undefined) e[to] = o[k];
      break;
    default: throw fail(`internal error: no piece ${id}`);
  }
  if (!IMX_WET_APPLICABLE.has(id)) e.dry = 0;
  return normaliseEquipment(id, e);
}

function compBand(f) {
  const b = defaultCompBand();
  if (f.on !== undefined) b.on = f.on;
  for (const [k, to] of Object.entries(COMP_FIELDS)) if (f[k] !== undefined) b[to] = f[k];
  return b;
}

/**
 * A chain's record → {name, enabled, bus, order, equipment} — an IMix block
 * still without its id, which the build gives it. `name` is the chain's name
 * in the project (IMcn); `fallbackName` is used when the record names none.
 */
export function chainOf(value, what, fallbackName = null) {
  const o = readOptions(value, CHAIN, what);
  const equipment = {};
  for (const [k, id] of Object.entries(CHAIN_PIECES)) {
    if (o[k] !== undefined) equipment[id] = pieceOf(id, o[k], `${what}'s ${k}`);
  }
  return {
    name: o.name ?? fallbackName, enabled: o.on ?? true, bus: o.mode ?? false, order: o.order ?? 0,
    equipment, unknown: [],
  };
}
