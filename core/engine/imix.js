// Per-instrument mixing chains — IMix (item 217, TAUD_ENGINE_SPEC.md §12.4,
// TAUD_FILE_FORMAT.md §9.15).
//
// An instrument whose record names an IMix block (byte 255) does not mix its
// voices straight into the master: they sum into the instrument's OWN bus,
// that bus runs the block's chain, and the result joins the master. Two
// instruments naming the same block share its SETTINGS; whether they share its
// BUS is the block's MODE (item 247). Separate, the default, gives each its own
// instance, so a compressor on the kick never ducks the snare; bus mode sums
// every instrument on the block into one bus and runs the chain once over the
// sum — a group bus, where the kick DOES duck the snare.
//
// The pipeline is FIXED; a block only says which equipment it holds and how
// each piece is set, and the order byte picks one of two arrangements:
//
//   order 0: itrm → expd → equ1 → deq1 → tsh1 → comp → equ2 → deq2 → unis → satu → dlay → verb → limi → mxtl
//   order 1: itrm → expd → equ1 → deq1 → tsh1 → comp → equ2 → deq2 → unis → satu → verb → dlay → limi → mxtl
//
// (`tsh2`, a second transient shaper after the compressor, is a RESERVED
// identifier and place: no reader knows it yet, so a block holding one keeps
// it as unknown equipment.)
//
// ── Where it sits in the gain structure ──
// The bus is fed every per-voice gain the mixer applies (note and lane volume,
// envelopes, fadeout, instrument global volume, swing, the lane fader, the
// sample-end and attack ramps, the pan law) but NOT the song's global × mixing
// × master volume: those are the master fader, and an insert chain sits ahead
// of it. The chain's output is scaled by them as it joins the mix.
//
// ── Bit-exactness for everything else ──
// A block that is switched off, or holds nothing that is not bypassed, makes
// no bus at all: the instrument's voices take the plain path, and a song that
// never touched the feature renders exactly as before it existed. Routing
// through a bus — even an identity one — changes the order of the additions
// and so the last bits of the sum, which is why "engaged" is decided here and
// not by the arithmetic.
//
// ── Determinism ──
// Everything that ACCUMULATES — an LFO's phase, a pitch shifter's sweep, a
// tape delay's glide toward a new time, its wow and flutter — is integer
// arithmetic on 16.16 fixed-point quantities (exact in binary64), so a port
// steps through the same states. Filters and envelopes are binary64 like the
// rest of the mix. The randomness an S&H LFO draws is its own xorshift32,
// seeded with a constant, never the engine's dither stream.
//
// ── This module ──
// The chains run in the engine (core/engine/c/src/imix.c, the reference
// implementation; engine spec §12.4). Here is what the page and the codec
// share: the identifiers, defaults, ranges and normalisation of a block
// (core/format/imix-section.js reads and writes the bytes), the responses the
// Mixing tab draws, and the shape of its meter readout.

import { SAMPLING_RATE } from "./constants.js";
import { Biquad, biquadDb, dbToGain, COMP_PEAK, COMP_RMS } from "./mastering.js";

// ── Identifiers ─────────────────────────────────────────────────────────────

/** Every equipment FourCC this engine knows. An identifier is never retired or
 *  reused (§9.15): a block that names one must mean the same thing forever. */
export const IMX_ITRM = "itrm";
export const IMX_EXPD = "expd";
export const IMX_EQU1 = "equ1";
export const IMX_DEQ1 = "deq1";
export const IMX_TSH1 = "tsh1";
export const IMX_COMP = "comp";
export const IMX_EQU2 = "equ2";
export const IMX_DEQ2 = "deq2";
export const IMX_UNIS = "unis";
export const IMX_SATU = "satu";
export const IMX_DLAY = "dlay";
export const IMX_VERB = "verb";
export const IMX_LIMI = "limi";
export const IMX_MXTL = "mxtl";

/** The two pipelines, indexed by the block's order nibble. */
export const IMX_PIPELINES = Object.freeze([
  Object.freeze([IMX_ITRM, IMX_EXPD, IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2,
    IMX_UNIS, IMX_SATU, IMX_DLAY, IMX_VERB, IMX_LIMI, IMX_MXTL]),
  Object.freeze([IMX_ITRM, IMX_EXPD, IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2,
    IMX_UNIS, IMX_SATU, IMX_VERB, IMX_DLAY, IMX_LIMI, IMX_MXTL]),
]);

/** Every known identifier, in pipeline-0 order. */
export const IMX_EQUIPMENT = IMX_PIPELINES[0];

/** Equipment whose wet/dry byte means something. Everything else MUST carry 0
 *  there — a mix control on a trim or a limiter is a contradiction (§9.15). */
export const IMX_WET_APPLICABLE = Object.freeze(new Set([
  IMX_EXPD, IMX_TSH1, IMX_COMP, IMX_UNIS, IMX_SATU, IMX_DLAY, IMX_VERB,
]));

/** Highest equipment payload version this reader understands (all are 0). */
export const IMX_KNOWN_VERSION = 0;

/** IMix ids are a byte, and 0 means "no chain". */
export const IMX_MAX_ID = 255;

// Equaliser band shapes (§9.15). Value = the wire byte.
export const IMX_EQ_HIGH_PASS = 0;
export const IMX_EQ_LOW_SHELF = 1;
export const IMX_EQ_BELL = 2;
export const IMX_EQ_HIGH_SHELF = 3;
export const IMX_EQ_LOW_PASS = 4;
export const IMX_EQ_NOTCH = 5;
export const IMX_EQ_SHAPES = 6;
/** Bands an equaliser holds at most. */
export const IMX_EQ_MAX_BANDS = 8;
/** Cut-filter slopes: n → (n + 1) × 12 dB/octave. */
export const IMX_SLOPES = 4;

/** Compressor bands: 1 is an ordinary compressor, up to 6 a multiband one. */
export const IMX_COMP_MAX_BANDS = 6;

/** Transient-shaper bands: 1 is the whole signal, up to 6 split like the
 *  compressor's. */
export const IMX_TSH_MAX_BANDS = 6;

/** A dynamic equaliser's six bands, by index. */
export const IMX_DEQ_BANDS = 6;
export const IMX_DEQ_LOW_SHELF_BAND = 0;
export const IMX_DEQ_HIGH_SHELF_BAND = 1;

// Saturator transfer functions.
export const IMX_SAT_TAPE = 0;   // tanh
export const IMX_SAT_SOFT = 1;   // cubic soft clip
export const IMX_SAT_HARD = 2;   // hard clip
export const IMX_SAT_TUBE = 3;   // asymmetric tanh: even harmonics
export const IMX_SAT_FOLD = 4;   // sine wavefolder
export const IMX_SAT_CURVES = 5;

/** Unison voice count. */
export const IMX_UNIS_MIN_VOICES = 2;
export const IMX_UNIS_MAX_VOICES = 8;

// LFO waveforms.
export const IMX_LFO_SINE = 0;
export const IMX_LFO_TRIANGLE = 1;
export const IMX_LFO_SQUARE = 2;
export const IMX_LFO_SAW_UP = 3;
export const IMX_LFO_SAW_DOWN = 4;
export const IMX_LFO_RANDOM = 5;
export const IMX_LFO_WAVES = 6;

/** 16.16 fixed point: one unit. */
export const FX16 = 65536;

/** The longest delay a tape delay can hold, in seconds. */
export const IMX_DELAY_MAX_SEC = 4;
/** …and a reverb's pre-delay. */
export const IMX_PREDELAY_MAX_SEC = 0.5;


/** Parameter ranges, as the UI and the codec both clamp them. */
export const IMX_RANGE = Object.freeze({
  trimDb: [-24, 24],
  eqFreq: [20, 20000],
  eqGainDb: [-24, 24],
  eqQ: [0.1, 18],
  compThreshDb: [-60, 0],
  compRatio: [1, 20],
  compAttackMs: [0.1, 300],
  compReleaseMs: [5, 3000],
  compKneeDb: [0, 24],
  compMakeupDb: [-12, 24],
  xover: [20, 20000],
  deqRangeDb: [0, 24],
  tshGainDb: [-24, 24],
  tshAttackMs: [1, 300],
  tshReleaseMs: [10, 3000],
  tshOutDb: [-24, 24],
  expdThreshDb: [-80, 0],
  expdRangeDb: [0, 80],
  expdHoldMs: [0, 2000],
  expdHysteresisDb: [0, 12],
  keyLowCut: [20, 2000],
  keyHighCut: [500, 20000],
  deqActorDb: [-24, 24],
  satDriveDb: [0, 36],
  satTrimDb: [-24, 24],
  satBias: [-1, 1],
  unisDetune: [0, 100],
  unisWidth: [0, 1],
  unisSpacing: [0, 1],
  lfoDepth: [0, 1],
  lfoHz: [655, 40 * FX16],          // 16.16 Hz: 0.01…40 Hz
  lfoQt: [FX16, 4096 * FX16],       // 16.16 quarter ticks per cycle
  verbSize: [0, 1],
  verbDecay: [0.1, 30],
  verbDamping: [1000, 20000],
  verbPreDelay: [0, IMX_PREDELAY_MAX_SEC * FX16], // 16.16 seconds
  dlaySec: [66, IMX_DELAY_MAX_SEC * FX16],        // 16.16 seconds: 1 ms…4 s
  dlayQt: [FX16 / 4, 1024 * FX16],                // 16.16 quarter ticks
  dlayFeedback: [0, 1.2],
  dlayHighCut: [500, 20000],
  dlayLowCut: [20, 2000],
  dlayWow: [0, 1],
  dlayDriveDb: [0, 24],
  limCeilingDb: [-24, 0],
  limReleaseMs: [1, 1000],
  limGainDb: [-12, 24],
  mxGainDb: [-24, 24],
  mxWidth: [0, 2],
});


const imxClamp = (v, key, fallback) => {
  const [lo, hi] = IMX_RANGE[key];
  if (!Number.isFinite(v)) return Math.fround(fallback);
  return Math.fround(v < lo ? lo : v > hi ? hi : v);
};
/** The 16.16 fields are U32 in the file: integers, clamped. */
const imxClampFx = (v, key, fallback) => {
  const [lo, hi] = IMX_RANGE[key];
  if (!Number.isFinite(v)) return fallback;
  const i = Math.round(v);
  return i < lo ? lo : i > hi ? hi : i;
};
const imxByte = (v, lo, hi, fallback) => {
  const i = Number.isFinite(v) ? Math.round(v) : fallback;
  return i < lo ? lo : i > hi ? hi : i;
};

// ── Defaults ────────────────────────────────────────────────────────────────

/** Default LFO: a slow sine at depth 0 — present, and changing nothing. */
export function defaultImixLfo() {
  return { wave: IMX_LFO_SINE, retrigger: false, sync: false, rate: FX16 / 2, depth: 0 };
}

function defaultEqBands() {
  return [
    { on: true, shape: IMX_EQ_LOW_SHELF, slope: 0, freq: 100, gainDb: 0, q: Math.SQRT1_2 },
    { on: true, shape: IMX_EQ_BELL, slope: 0, freq: 500, gainDb: 0, q: 1 },
    { on: true, shape: IMX_EQ_BELL, slope: 0, freq: 2000, gainDb: 0, q: 1 },
    { on: true, shape: IMX_EQ_HIGH_SHELF, slope: 0, freq: 8000, gainDb: 0, q: Math.SQRT1_2 },
  ];
}

/** A compressor band's resting values. */
export function defaultCompBand() {
  return { on: true, threshDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, kneeDb: 6, makeupDb: 0 };
}

/** Where the crossovers of an n-band split start: log-spaced over 80 Hz…8 kHz. */
export function defaultCrossovers(n) {
  const out = [];
  for (let i = 1; i < n; i++) out.push(80 * 100 ** ((i - 1) / Math.max(1, n - 2)));
  if (n === 2) out[0] = 400;
  return out;
}

/** The closest two neighbouring crossovers may sit (a ratio): the editor keeps
 *  them 1 % apart, which also keeps them strictly ascending in binary32. */
export const IMX_XOVER_GAP = 1.01;

/**
 * Give a multiband piece (the compressor, the transient shaper) `n` bands, in
 * place, WITHOUT moving a crossover it already has. Fewer bands drops the top
 * ones and the crossovers above them. Each band added splits one, at the
 * geometric middle of its range: the top band while there is room above the
 * last crossover, else the widest band; the new band (from `makeBand`) takes
 * the upper half, and every other band keeps its range. A piece of one band
 * has no crossovers to keep, and starts from defaultCrossovers.
 */
export function resizeSplit(e, n, makeBand) {
  const [lo, hi] = IMX_RANGE.xover;
  if (n <= e.bands.length) {
    e.bands.length = n;
    e.crossovers.length = n - 1;
    return e;
  }
  if (e.bands.length === 1) {
    while (e.bands.length < n) e.bands.push(makeBand());
    e.crossovers = defaultCrossovers(n).map(Math.fround);
    return e;
  }
  while (e.bands.length < n) {
    const xs = e.crossovers;
    const edge = (k) => (k < 0 ? lo : k >= xs.length ? hi : xs[k]);
    // Band k spans edge(k − 1) … edge(k); split the top one if it is wide
    // enough to take a crossover a gap away from both ends, else the widest.
    const top = xs.length;
    const fits = (k) => edge(k) / edge(k - 1) > IMX_XOVER_GAP * IMX_XOVER_GAP;
    let k = top;
    if (!fits(top)) {
      for (let j = 0; j <= top; j++) if (edge(j) / edge(j - 1) > edge(k) / edge(k - 1)) k = j;
      if (!fits(k)) break; // nowhere left to split
    }
    xs.splice(k, 0, Math.fround(Math.sqrt(edge(k - 1) * edge(k))));
    e.bands.splice(k + 1, 0, makeBand());
  }
  return e;
}

/** A transient-shaper band's resting values: neither the attack nor the
 *  sustain moved, so a fresh shaper changes nothing. */
export function defaultTshBand() {
  return { on: true, attackDb: 0, sustainDb: 0, attackMs: 20, releaseMs: 250, outDb: 0 };
}

const DEQ_DEFAULT_FREQS = [100, 8000, 250, 1000, 3000, 6000];

function defaultDeqBands() {
  const bands = [];
  for (let i = 0; i < IMX_DEQ_BANDS; i++) {
    const f = DEQ_DEFAULT_FREQS[i];
    const q = i < 2 ? Math.SQRT1_2 : 1;
    bands.push({
      on: false, unlinked: false, boost: false,
      freq: f, q, gainDb: 0, senseFreq: f, senseQ: q,
      threshDb: -24, ratio: 3, attackMs: 5, releaseMs: 100, rangeDb: 6, actorDb: 0,
    });
  }
  return bands;
}

/** The resting dry amount of each kind (0 = all wet, 255 = all dry). A delay
 *  or a reverb is an effect you add TO the sound; the rest replace it. */
const DEFAULT_DRY = { [IMX_DLAY]: 179, [IMX_VERB]: 191 };

/**
 * A freshly inserted piece of equipment: enabled, and — wherever that is
 * possible — changing nothing until a control moves (an EQ flat at 0 dB, a
 * dynamic EQ with every band off). A saturator, a unison, a delay and a reverb
 * cannot be inserted silently; they are the sound you asked for.
 */
export function defaultEquipment(id) {
  const base = { bypass: false, dry: DEFAULT_DRY[id] ?? 0 };
  switch (id) {
    case IMX_ITRM: return { ...base, gainDb: 0 };
    case IMX_EXPD: return {
      ...base, detector: COMP_PEAK, threshDb: -50, floorDb: -Infinity, ratio: 2, rangeDb: 24,
      attackMs: 1, holdMs: 20, releaseMs: 150, hysteresisDb: 4,
      keyFilter: false, keyLowCut: 80, keyHighCut: 12000,
    };
    case IMX_EQU1:
    case IMX_EQU2: return { ...base, bands: defaultEqBands() };
    case IMX_COMP: return { ...base, detector: COMP_PEAK, crossovers: [], bands: [defaultCompBand()] };
    case IMX_TSH1: return { ...base, crossovers: [], bands: [defaultTshBand()] };
    case IMX_DEQ1:
    case IMX_DEQ2: return { ...base, bands: defaultDeqBands() };
    case IMX_SATU: return { ...base, curve: IMX_SAT_TAPE, driveDb: 6, inDb: 0, outDb: 0, bias: 0 };
    case IMX_UNIS: return {
      ...base, voices: 4, detune: 15, width: 0.8, spacing: 0,
      detuneLfo: defaultImixLfo(), widthLfo: defaultImixLfo(),
    };
    case IMX_VERB: return { ...base, size: 0.5, decay: 1.8, damping: 8000, preDelay: 1311 };
    case IMX_DLAY: return {
      ...base, sync: true, pingPong: false, pingRight: false, time: 48 * FX16, feedback: 0.35,
      highCut: 6000, lowCut: 120, wow: 0.2, driveDb: 3,
    };
    case IMX_LIMI: return { ...base, truePeak: false, ceilingDb: -1, releaseMs: 60, gainDb: 0 };
    case IMX_MXTL: return { ...base, swap: false, invL: false, invR: false, removeDc: false, gainDb: 0, width: 1 };
    default: throw new Error(`imix: unknown equipment ${id}`);
  }
}

/** A new, empty, enabled block in separate mode — no equipment until
 *  something is touched. */
export function defaultImixBlock(id) {
  return { id: id & 0xff, enabled: true, bus: false, order: 0, equipment: {}, unknown: [] };
}

// ── Normalisation ───────────────────────────────────────────────────────────

function normLfo(l) {
  const d = defaultImixLfo();
  if (!l || typeof l !== "object") return d;
  const sync = !!l.sync;
  return {
    wave: imxByte(l.wave, 0, IMX_LFO_WAVES - 1, d.wave),
    retrigger: !!l.retrigger,
    sync,
    rate: imxClampFx(l.rate, sync ? "lfoQt" : "lfoHz", sync ? 16 * FX16 : d.rate),
    depth: imxClamp(+l.depth, "lfoDepth", d.depth),
  };
}

/**
 * Fill in and clamp one piece of equipment, narrowing every float to binary32
 * — the file stores binary32, so the document must hold exactly what a save
 * will hold (mastering.js explains the drift this prevents). Structure that
 * cannot be clamped into sense (a band count, a shape byte) is clamped too:
 * the CODEC is where malformed input is refused, and anything that reaches
 * this function is the editor's own.
 */
export function normaliseEquipment(id, e) {
  const d = defaultEquipment(id);
  if (!e || typeof e !== "object") e = d;
  const out = {
    bypass: !!e.bypass,
    // The editor's: the piece's panel is folded shut (§9.15). Playback never
    // reads it.
    folded: !!e.folded,
    dry: IMX_WET_APPLICABLE.has(id) ? imxByte(e.dry, 0, 255, d.dry) : 0,
  };
  switch (id) {
    case IMX_ITRM:
      out.gainDb = imxClamp(+e.gainDb, "trimDb", 0);
      break;
    case IMX_EXPD:
      out.detector = e.detector === COMP_RMS ? COMP_RMS : COMP_PEAK;
      out.threshDb = imxClamp(+e.threshDb, "expdThreshDb", d.threshDb);
      // No floor is −∞ (a pure expander); one above the threshold is brought
      // down to it (a pure gate) — the editor raises the threshold instead
      // when it is the floor that was moved (instmixing.js).
      out.floorDb = e.floorDb === undefined || e.floorDb === null || e.floorDb === -Infinity || Number.isNaN(+e.floorDb)
        ? -Infinity : Math.min(imxClamp(+e.floorDb, "expdThreshDb", out.threshDb), out.threshDb);
      out.ratio = imxClamp(+e.ratio, "compRatio", d.ratio);
      out.rangeDb = imxClamp(+e.rangeDb, "expdRangeDb", d.rangeDb);
      out.attackMs = imxClamp(+e.attackMs, "compAttackMs", d.attackMs);
      out.holdMs = imxClamp(+e.holdMs, "expdHoldMs", d.holdMs);
      out.releaseMs = imxClamp(+e.releaseMs, "compReleaseMs", d.releaseMs);
      out.hysteresisDb = imxClamp(+e.hysteresisDb, "expdHysteresisDb", d.hysteresisDb);
      out.keyFilter = !!e.keyFilter;
      out.keyLowCut = imxClamp(+e.keyLowCut, "keyLowCut", d.keyLowCut);
      out.keyHighCut = imxClamp(+e.keyHighCut, "keyHighCut", d.keyHighCut);
      break;
    case IMX_EQU1:
    case IMX_EQU2: {
      const src = Array.isArray(e.bands) ? e.bands.slice(0, IMX_EQ_MAX_BANDS) : d.bands;
      out.bands = src.map((b) => ({
        on: !!b.on,
        shape: imxByte(b.shape, 0, IMX_EQ_SHAPES - 1, IMX_EQ_BELL),
        slope: isCutShape(b.shape) ? imxByte(b.slope, 0, IMX_SLOPES - 1, 0) : 0,
        freq: imxClamp(+b.freq, "eqFreq", 1000),
        gainDb: imxClamp(+b.gainDb, "eqGainDb", 0),
        q: imxClamp(+b.q, "eqQ", Math.SQRT1_2),
      }));
      break;
    }
    case IMX_COMP: {
      const src = Array.isArray(e.bands) && e.bands.length > 0
        ? e.bands.slice(0, IMX_COMP_MAX_BANDS) : d.bands;
      out.detector = e.detector === COMP_RMS ? COMP_RMS : COMP_PEAK;
      out.bands = src.map((b) => {
        const db = defaultCompBand();
        return {
          on: b.on === undefined ? true : !!b.on,
          threshDb: imxClamp(+b.threshDb, "compThreshDb", db.threshDb),
          ratio: imxClamp(+b.ratio, "compRatio", db.ratio),
          attackMs: imxClamp(+b.attackMs, "compAttackMs", db.attackMs),
          releaseMs: imxClamp(+b.releaseMs, "compReleaseMs", db.releaseMs),
          kneeDb: imxClamp(+b.kneeDb, "compKneeDb", db.kneeDb),
          makeupDb: imxClamp(+b.makeupDb, "compMakeupDb", db.makeupDb),
        };
      });
      out.crossovers = normCrossovers(e.crossovers, out.bands.length);
      break;
    }
    case IMX_TSH1: {
      const src = Array.isArray(e.bands) && e.bands.length > 0
        ? e.bands.slice(0, IMX_TSH_MAX_BANDS) : d.bands;
      out.bands = src.map((b) => {
        const db = defaultTshBand();
        return {
          on: b.on === undefined ? true : !!b.on,
          attackDb: imxClamp(+b.attackDb, "tshGainDb", db.attackDb),
          sustainDb: imxClamp(+b.sustainDb, "tshGainDb", db.sustainDb),
          attackMs: imxClamp(+b.attackMs, "tshAttackMs", db.attackMs),
          releaseMs: imxClamp(+b.releaseMs, "tshReleaseMs", db.releaseMs),
          outDb: imxClamp(+b.outDb, "tshOutDb", db.outDb),
        };
      });
      out.crossovers = normCrossovers(e.crossovers, out.bands.length);
      break;
    }
    case IMX_DEQ1:
    case IMX_DEQ2: {
      const dbands = defaultDeqBands();
      out.bands = dbands.map((db, i) => {
        const b = Array.isArray(e.bands) && e.bands[i] ? e.bands[i] : db;
        const freq = imxClamp(+b.freq, "eqFreq", db.freq);
        const q = imxClamp(+b.q, "eqQ", db.q);
        const unlinked = !!b.unlinked;
        return {
          on: !!b.on, unlinked, boost: !!b.boost,
          freq, q,
          gainDb: imxClamp(+b.gainDb, "eqGainDb", 0),
          // A linked band senses where it acts — and says so in the file.
          senseFreq: unlinked ? imxClamp(+b.senseFreq, "eqFreq", freq) : freq,
          senseQ: unlinked ? imxClamp(+b.senseQ, "eqQ", q) : q,
          threshDb: imxClamp(+b.threshDb, "compThreshDb", db.threshDb),
          ratio: imxClamp(+b.ratio, "compRatio", db.ratio),
          attackMs: imxClamp(+b.attackMs, "compAttackMs", db.attackMs),
          releaseMs: imxClamp(+b.releaseMs, "compReleaseMs", db.releaseMs),
          rangeDb: imxClamp(+b.rangeDb, "deqRangeDb", db.rangeDb),
          actorDb: imxClamp(+b.actorDb, "deqActorDb", db.actorDb),
        };
      });
      break;
    }
    case IMX_SATU:
      out.curve = imxByte(e.curve, 0, IMX_SAT_CURVES - 1, d.curve);
      out.driveDb = imxClamp(+e.driveDb, "satDriveDb", d.driveDb);
      out.inDb = imxClamp(+e.inDb, "satTrimDb", 0);
      out.outDb = imxClamp(+e.outDb, "satTrimDb", 0);
      out.bias = imxClamp(+e.bias, "satBias", 0);
      break;
    case IMX_UNIS:
      out.voices = imxByte(e.voices, IMX_UNIS_MIN_VOICES, IMX_UNIS_MAX_VOICES, d.voices);
      out.detune = imxClamp(+e.detune, "unisDetune", d.detune);
      out.width = imxClamp(+e.width, "unisWidth", d.width);
      out.spacing = imxClamp(+e.spacing, "unisSpacing", 0);
      out.detuneLfo = normLfo(e.detuneLfo);
      out.widthLfo = normLfo(e.widthLfo);
      break;
    case IMX_VERB:
      out.size = imxClamp(+e.size, "verbSize", d.size);
      out.decay = imxClamp(+e.decay, "verbDecay", d.decay);
      out.damping = imxClamp(+e.damping, "verbDamping", d.damping);
      out.preDelay = imxClampFx(e.preDelay, "verbPreDelay", d.preDelay);
      break;
    case IMX_DLAY:
      out.sync = !!e.sync;
      out.pingPong = !!e.pingPong;
      out.pingRight = out.pingPong && !!e.pingRight;   // which side the first echo takes
      out.time = imxClampFx(e.time, out.sync ? "dlayQt" : "dlaySec", out.sync ? d.time : FX16 / 4);
      out.feedback = imxClamp(+e.feedback, "dlayFeedback", d.feedback);
      out.highCut = imxClamp(+e.highCut, "dlayHighCut", d.highCut);
      out.lowCut = imxClamp(+e.lowCut, "dlayLowCut", d.lowCut);
      out.wow = imxClamp(+e.wow, "dlayWow", d.wow);
      out.driveDb = imxClamp(+e.driveDb, "dlayDriveDb", d.driveDb);
      break;
    case IMX_LIMI:
      out.truePeak = !!e.truePeak;
      out.ceilingDb = imxClamp(+e.ceilingDb, "limCeilingDb", d.ceilingDb);
      out.releaseMs = imxClamp(+e.releaseMs, "limReleaseMs", d.releaseMs);
      out.gainDb = imxClamp(+e.gainDb, "limGainDb", 0);
      break;
    case IMX_MXTL:
      out.swap = !!e.swap;
      out.invL = !!e.invL;
      out.invR = !!e.invR;
      out.removeDc = !!e.removeDc;
      out.gainDb = imxClamp(+e.gainDb, "mxGainDb", 0);
      out.width = imxClamp(+e.width, "mxWidth", 1);
      break;
    default:
      throw new Error(`imix: unknown equipment ${id}`);
  }
  return out;
}

/**
 * n bands, n − 1 crossovers, strictly ascending. A list that is not is
 * re-spread rather than sorted: sorting would reassign bands' settings to
 * different frequency ranges without saying so.
 */
function normCrossovers(list, n) {
  let xs = Array.isArray(list) ? list.slice(0, n - 1) : [];
  xs = xs.map((x) => imxClamp(+x, "xover", 1000));
  let ok = xs.length === n - 1;
  for (let i = 1; ok && i < xs.length; i++) if (!(xs[i] > xs[i - 1])) ok = false;
  return ok ? xs : defaultCrossovers(n).map(Math.fround);
}

/** True for the two shapes whose slope byte means something. */
export function isCutShape(shape) {
  return shape === IMX_EQ_HIGH_PASS || shape === IMX_EQ_LOW_PASS;
}

/** A complete, clamped block — every touched piece normalised, unknown
 *  records carried through verbatim. */
export function normaliseImixBlock(b) {
  const id = imxByte(b?.id, 1, IMX_MAX_ID, 1);
  const out = {
    id,
    enabled: b?.enabled === undefined ? true : !!b.enabled,
    // Bus mode: every instrument naming the block sums into ONE bus (item 247).
    bus: !!b?.bus,
    order: b?.order === 1 ? 1 : 0,
    equipment: {},
    unknown: Array.isArray(b?.unknown)
      ? b.unknown.map((u) => ({ fourcc: u.fourcc, bytes: Uint8Array.from(u.bytes) }))
      : [],
  };
  for (const eqId of IMX_EQUIPMENT) {
    const e = b?.equipment?.[eqId];
    if (e) out.equipment[eqId] = normaliseEquipment(eqId, e);
  }
  return out;
}

/** Deep copy (blocks travel over postMessage and into undo records). */
export function cloneImixBlock(b) {
  return normaliseImixBlock(b);
}

/**
 * Would a chain built from this block change a sample? Off, or holding nothing
 * that is not bypassed, is not "transparent" — it is ABSENT: no bus, the plain
 * path. A piece that is in, whatever its settings, counts (an EQ flat at 0 dB
 * still costs its sections, and pretending otherwise would make whether a bus
 * exists depend on a gain value).
 */
export function imixBlockEngaged(b) {
  if (!b || !b.enabled) return false;
  for (const id of IMX_EQUIPMENT) {
    const e = b.equipment[id];
    if (e && !e.bypass) return true;
  }
  return false;
}

/** Structural equality of two normalised blocks. */
export function imixBlockEqual(a, b) {
  return JSON.stringify(imixComparable(a)) === JSON.stringify(imixComparable(b));
}

function imixComparable(b) {
  const n = normaliseImixBlock(b);
  // Folding is how an editor shows the chain, not the chain (§9.15).
  const equipment = {};
  for (const [id, e] of Object.entries(n.equipment)) equipment[id] = { ...e, folded: false };
  return { ...n, equipment, unknown: n.unknown.map((u) => [u.fourcc, [...u.bytes]]) };
}

// ── What the Mixing tab draws ───────────────────────────────────────────────
// The chains that run are the engine's (core/engine/c/src/imix.c; engine spec
// §12.4): every piece's processing, the LFOs, the delay lines, the idle rule,
// the buses and the routing. What the Mixing tab DRAWS is computed here from
// the same designs — an equaliser's response, a dynamic EQ's, a compressor's
// or a transient shaper's at the gains the meter reads, the saturator's
// static transfer, where the unison puts its copies — so a curve on the panel
// is the filter the engine runs, coefficient for coefficient.

/** Butterworth section Qs for a cascade of k second-order sections. */
function butterQs(k) {
  const qs = [];
  for (let i = 1; i <= k; i++) qs.push(1 / (2 * Math.cos(((2 * i - 1) * Math.PI) / (4 * k))));
  return qs;
}


/** Up to eight bands; a cut band is a Butterworth cascade of up to four
 *  sections, every other shape one RBJ section. A band that is off is not in
 *  the list at all. */
class ImxEq {
  constructor() {
    this.bands = [];   // per band: Biquad[] (allocated on demand)
    this.live = [];    // the sections of the bands that are on, in order
  }
  configure(p, rate) {
    this.live = [];
    for (let i = 0; i < p.bands.length; i++) {
      const b = p.bands[i];
      if (!this.bands[i]) this.bands[i] = [];
      const secs = this.bands[i];
      if (!b.on) continue;
      const cut = isCutShape(b.shape);
      const k = cut ? b.slope + 1 : 1;
      while (secs.length < k) secs.push(new Biquad(1));
      // A 12 dB/octave cut is one section at the band's own Q (its resonance);
      // a steeper one is a maximally flat Butterworth cascade, whose section
      // Qs are not a choice.
      const qs = cut && k > 1 ? butterQs(k) : [b.q];
      for (let j = 0; j < k; j++) {
        const s = secs[j];
        switch (b.shape) {
          case IMX_EQ_HIGH_PASS: s.highPass(b.freq, qs[j], rate); break;
          case IMX_EQ_LOW_PASS: s.lowPass(b.freq, qs[j], rate); break;
          case IMX_EQ_LOW_SHELF: s.lowShelf(b.freq, b.gainDb, b.q, rate); break;
          case IMX_EQ_HIGH_SHELF: s.highShelf(b.freq, b.gainDb, b.q, rate); break;
          case IMX_EQ_NOTCH: s.notch(b.freq, b.q, rate); break;
          default: s.peaking(b.freq, b.gainDb, b.q, rate); break;
        }
        this.live.push(s);
      }
    }
  }
  /** Magnitude response at `freq` (dB). */
  responseDb(freq, rate) {
    let db = 0;
    for (const s of this.live) db += biquadDb(s, freq, rate);
    return db;
  }
}

/**
 * Dynamic equaliser. Each band's ACTOR is a shelf or a bell whose gain is the
 * band's static gain plus a dynamic part e that its sensor drives (engine spec
 * §12.4 `deq1`); the actor applies e × 10^(actor gain / 20). The display draws
 * the actors at the dynamic gains the meter read.
 */
class ImxDeq {
  constructor() {
    this.act = [];
    for (let i = 0; i < IMX_DEQ_BANDS; i++) this.act.push(new Biquad(1));
    this.env = new Float64Array(IMX_DEQ_BANDS);   // dynamic gain, dB (signed), before the actor gain
    this.actor = new Float64Array(IMX_DEQ_BANDS).fill(1);  // 10^(actorDb/20)
    this.p = null;
    this.rate = SAMPLING_RATE;
    this.live = [];
  }
  configure(p, rate) {
    this.p = p;
    this.rate = rate;
    this.live = [];
    for (let i = 0; i < IMX_DEQ_BANDS; i++) {
      const b = p.bands[i];
      if (!b.on) continue;
      this.live.push(i);
      this.actor[i] = dbToGain(b.actorDb);
      this._setAct(i);
    }
  }
  _setAct(i) {
    const b = this.p.bands[i];
    const g = b.gainDb + this.env[i] * this.actor[i];
    const s = this.act[i];
    if (i === IMX_DEQ_LOW_SHELF_BAND) s.lowShelf(b.freq, g, b.q, this.rate);
    else if (i === IMX_DEQ_HIGH_SHELF_BAND) s.highShelf(b.freq, g, b.q, this.rate);
    else s.peaking(b.freq, g, b.q, this.rate);
  }
  /** Every live band at its static gain plus the dynamic gain showGains gave it. */
  responseDb(freq, rate) {
    let db = 0;
    for (const i of this.live) db += biquadDb(this.act[i], freq, rate);
    return db;
  }
  /** Put the bands' dynamic gains (dB per band, as the meter reads them; null
   *  = at rest) into the actors, so responseDb draws the equaliser as it
   *  stands at that moment. */
  showGains(env) {
    // `env` is the APPLIED dynamic gain (the meter's), so the actor comes back out.
    if (env) for (let i = 0; i < IMX_DEQ_BANDS; i++) this.env[i] = env[i] / this.actor[i];
    else this.env.fill(0);
    if (this.p) for (const i of this.live) this._setAct(i);
  }
}

/**
 * The multiband split the compressor and the transient shaper share:
 * Linkwitz–Riley 4th-order crossovers in a cascade, every band phase-matched
 * to the crossovers it did not pass through, so the bands' magnitudes add.
 * The display needs each band's crossover magnitude.
 */
class ImxSplit {
  constructor() {
    this.bandsN = 0;
    this.lp = []; this.hp = [];  // per crossover: one Butterworth section each
  }
  /** Make room for n bands. */
  resize(n) {
    if (n === this.bandsN) return;
    this.bandsN = n;
    this.lp = []; this.hp = [];
    for (let k = 0; k < n - 1; k++) { this.lp.push(new Biquad(1)); this.hp.push(new Biquad(1)); }
  }
  configure(crossovers, rate) {
    for (let k = 0; k < this.bandsN - 1; k++) {
      this.lp[k].lowPass(crossovers[k], Math.SQRT1_2, rate);
      this.hp[k].highPass(crossovers[k], Math.SQRT1_2, rate);
    }
  }
  /** Band k's crossover magnitude at `freq` (linear). An LR4 section pair is
   *  one Butterworth section squared. */
  magnitude(k, freq, rate) {
    let m = 1;
    for (let j = 0; j < k; j++) m *= 10 ** (biquadDb(this.hp[j], freq, rate) / 10);
    if (k < this.bandsN - 1) m *= 10 ** (biquadDb(this.lp[k], freq, rate) / 10);
    return m;
  }
}

/**
 * The compressor (one to six bands) and the transient shaper (likewise) as the
 * display draws them: every band at the gain showGains gave it plus its
 * make-up or output gain, weighted by its crossover magnitude, and the
 * wet/dry against the dry sum.
 */
class ImxBands {
  constructor(max, outKey) {
    this.xo = new ImxSplit();
    this.p = null;
    this.showGr = new Float64Array(max);
    this.outKey = outKey;
  }
  configure(p, rate) {
    this.p = p;
    this.xo.resize(p.bands.length);
    this.xo.configure(p.crossovers, rate);
  }
  /** The bands' gains (dB: a compressor's reductions, ≤ 0; a shaper's,
   *  signed; null = at rest). */
  showGains(gr) {
    if (gr) this.showGr.set(gr.subarray ? gr.subarray(0, this.showGr.length) : gr);
    else this.showGr.fill(0);
  }
  responseDb(freq, rate) {
    const p = this.p;
    const n = this.xo.bandsN;
    if (!p || n === 0) return 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const b = p.bands[k];
      sum += (b.on ? dbToGain(this.showGr[k] + b[this.outKey]) : 1) * this.xo.magnitude(k, freq, rate);
    }
    const d = p.dry / 255;
    const y = sum * (1 - d) + d;
    return y > 1e-9 ? 20 * Math.log10(y) : -180;
  }
}

/**
 * The saturator's static transfer at input sample `x` — drive, trims, bias,
 * curve and wet/dry, with the bias's own offset taken out the way the DC
 * blocker takes it out of a steady signal. For the display; the audio path
 * runs the anti-aliased form in ImxSat.
 */
export function imxSatTransfer(p, x) {
  const u = x * dbToGain(p.inDb) * dbToGain(p.driveDb) + p.bias;
  const wet = (satF(p.curve, u) - satF(p.curve, p.bias)) * dbToGain(p.outDb);
  const d = p.dry / 255;
  return wet * (1 - d) + x * d;
}


/** A saturator curve f (the engine runs the anti-aliased form, over its
 *  antiderivative). */
function satF(curve, x) {
  switch (curve) {
    case IMX_SAT_SOFT:
      if (x >= 1) return 1;
      if (x <= -1) return -1;
      return 1.5 * (x - (x * x * x) / 3);
    case IMX_SAT_HARD: return x > 1 ? 1 : x < -1 ? -1 : x;
    case IMX_SAT_TUBE: return x >= 0 ? Math.tanh(x) : 0.5 * Math.tanh(2 * x);
    case IMX_SAT_FOLD: return Math.sin(x);
    default: return Math.tanh(x);
  }
}


/**
 * Where voice k of n sits in [−1, 1]: uniform spacing blended toward the
 * quantiles of a raised-cosine (bell) distribution, which crowds the voices
 * toward the centre. For n < 4 the two coincide — two voices are the two
 * edges and a third is the centre whatever the spacing.
 */
export function unisonPositions(n, spacing) {
  const out = new Float64Array(n);
  // Below four voices the two spacings place the voices identically, and the
  // uniform positions are the exact ones.
  if (n < 4) spacing = 0;
  for (let k = 0; k < n; k++) {
    const q = n === 1 ? 0.5 : k / (n - 1);
    const u = 2 * q - 1;
    // F(x) = (x + 1)/2 + sin(πx)/(2π) is the bell's CDF on [−1, 1]; invert by
    // bisection (monotone, and 64 halvings reach binary64's resolution).
    let lo = -1, hi = 1;
    for (let it = 0; it < 64; it++) {
      const mid = (lo + hi) * 0.5;
      const F = (mid + 1) * 0.5 + Math.sin(Math.PI * mid) / (2 * Math.PI);
      if (F < q) lo = mid; else hi = mid;
    }
    const b = q === 0 ? -1 : q === 1 ? 1 : (lo + hi) * 0.5;
    out[k] = (1 - spacing) * u + spacing * b;
  }
  return out;
}


/** The pieces the display has a curve for; null for the rest. */
function makeDisplayStage(id) {
  switch (id) {
    case IMX_EQU1: case IMX_EQU2: return new ImxEq();
    case IMX_DEQ1: case IMX_DEQ2: return new ImxDeq();
    case IMX_COMP: return new ImxBands(IMX_COMP_MAX_BANDS, "makeupDb");
    case IMX_TSH1: return new ImxBands(IMX_TSH_MAX_BANDS, "outDb");
    default: return null;
  }
}

/**
 * A chain as the Mixing tab draws it: the block's pieces that have a frequency
 * response, configured as the engine configures them. `responseDb` is the
 * chain's equalisers together (both static EQs, both dynamic EQs at the gains
 * showGains gave them); `stageResponseDb` is one piece's.
 */
export class InstrumentChain {
  constructor(block, rate = SAMPLING_RATE) {
    this.rate = rate;
    this.stages = new Map();   // id → display stage (or null), kept across setBlock
    this.active = [];          // [{id, stage}] in pipeline order
    this.block = null;
    this.setBlock(block);
  }

  /** Install a block's settings. */
  setBlock(block) {
    const b = normaliseImixBlock(block);
    this.block = b;
    const order = IMX_PIPELINES[b.order] ?? IMX_PIPELINES[0];
    this.active = [];
    for (const id of order) {
      const e = b.equipment[id];
      if (!e || e.bypass) continue;
      let stage = this.stages.get(id);
      if (stage === undefined) {
        stage = makeDisplayStage(id);
        this.stages.set(id, stage);
      }
      if (stage === null) continue;
      stage.configure(e, this.rate);
      this.active.push({ id, stage });
    }
  }

  /** The magnitude response (dB) of the chain's equalisers at `freq`: both
   *  static EQs, and both dynamic EQs at their shown gains. */
  responseDb(freq) {
    let db = 0;
    for (const a of this.active) {
      if (a.stage instanceof ImxEq || a.stage instanceof ImxDeq) db += a.stage.responseDb(freq, this.rate);
    }
    return db;
  }

  /** Give piece `id` the dynamic gains the meter read (a dynamic EQ's or a
   *  transient shaper's signed band gains, a compressor's reductions; null =
   *  at rest) before stageResponseDb draws it. */
  showGains(id, gains) {
    const s = this.stages.get(id);
    if (s && s.p) s.showGains(gains);
  }

  /** One piece's own magnitude response at `freq` (dB): an equaliser's, a
   *  dynamic EQ's, a transient shaper's or a compressor's. */
  stageResponseDb(id, freq) {
    const s = this.stages.get(id);
    return s ? s.responseDb(freq, this.rate) : 0;
  }
}

/** Validate-and-install shape for TaudEngine.setImix: an iterable of blocks
 *  (or a Map id → block) → Map id → normalised block. */
export function imixBlockMap(blocks) {
  const out = new Map();
  if (!blocks) return out;
  const list = blocks instanceof Map ? [...blocks.values()] : [...blocks];
  for (const b of list) {
    const n = normaliseImixBlock(b);
    out.set(n.id, n);
  }
  return out;
}


// ── The Mixing tab's meter readout ──────────────────────────────────────────
// The tap itself is the engine's (core/engine/c/src/imixtap.c): it rings what
// goes into and comes out of the metered bus and each spectrum-drawing piece,
// and the snapshot carries it (core/worklet/protocol.js SNAP_IM_*).

/** Frames in the tap's rings — one spectrometer window. */
export const IMX_RING_FRAMES = 2048;
/** The pieces whose INPUT the tap also rings (mono), for the spectra drawn
 *  inside their units — in this order in the readout and the snapshot. */
export const IMX_TAP_STAGES = Object.freeze([IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2]);
/** How many Mixing-tab taps the engine keeps at once: one per split pane, so
 *  two panes can each meter an instrument of their own. */
export const IMX_METER_SEATS = 2;

/** A reusable readout the snapshot's Mixing block is read into. */
export function makeImixMeterReadout() {
  return {
    slot: -1, frames: 0, write: 0,
    peak: new Float64Array(4), truePeak: new Float64Array(4),
    meanSquare: new Float64Array(4), clip: new Float64Array(4),
    comp: new Float64Array(IMX_COMP_MAX_BANDS), deq1: new Float64Array(IMX_DEQ_BANDS),
    deq2: new Float64Array(IMX_DEQ_BANDS), lim: 0,
    // The transient shaper's bands' dynamic gains (dB, signed), the extreme.
    tsh1: new Float64Array(IMX_TSH_MAX_BANDS),
    // The expander's deepest gain (dB, ≤ 0) and its loudest detector level.
    expd: 0, expdLvl: -120,
    // The loudest detector reading of each band over the interval (dB; −120 =
    // nothing) — what its threshold is compared with.
    compLvl: new Float64Array(IMX_COMP_MAX_BANDS).fill(-120),
    deq1Lvl: new Float64Array(IMX_DEQ_BANDS).fill(-120),
    deq2Lvl: new Float64Array(IMX_DEQ_BANDS).fill(-120),
    ring: null, ringPre: null,
    // The unison's live detune (cents; −1 = it did not run) and width.
    unisCents: -1, unisWidth: 0,
    stageWrite: new Int32Array(IMX_TAP_STAGES.length), stageRings: null,
  };
}
