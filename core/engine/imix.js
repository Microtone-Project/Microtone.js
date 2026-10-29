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
// Not a port: like mastering.js, this file IS the reference implementation.

import { SAMPLING_RATE, TRACKER_CHUNK } from "./constants.js";
import { SpatialBus } from "./spatial.js";
import { TruePeakProbe } from "./analysis.js";
import {
  Biquad, CompressorStage, LimiterStage, onePole, biquadDb, dbToGain,
  COMP_PEAK, COMP_RMS,
} from "./mastering.js";

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
/** The transient shaper's level detector: the peak over this window, long
 *  enough to hold across a half-cycle of 20 Hz — so a steady tone reads as a
 *  steady level, and the shaper leaves it exactly alone. */
export const IMX_TSH_WINDOW_SEC = 0.025;
/** …and the one-pole its gain glides through, so a step in the envelopes
 *  never steps the sound. */
export const IMX_TSH_SMOOTH_MS = 1;

/** The expander's detector window, as the transient shaper's (and for the
 *  same reason: a steady tone is a steady level, so the gate below its floor
 *  does not chatter on the tone's cycles). */
export const IMX_EXPD_WINDOW_SEC = 0.025;

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
const TWO32 = 4294967296;

/** The longest delay a tape delay can hold, in seconds. */
export const IMX_DELAY_MAX_SEC = 4;
/** …and a reverb's pre-delay. */
export const IMX_PREDELAY_MAX_SEC = 0.5;

/**
 * Modulated parameters (a unison's detune and width) are re-evaluated every
 * this many samples — a free-running count per piece of equipment, NOT tied to
 * the mixer's spans, so a render cut into other spans steps the same states.
 */
export const IMX_CONTROL_PERIOD = 16;

/**
 * A chain whose input has been exactly zero, and whose output has stayed below
 * IMX_IDLE_LEVEL, for longer than every delay inside it plus this margin, goes
 * IDLE: its state is cleared and it stops running until a voice feeds it again.
 * That is a rule of the engine, not an optimisation the output may differ by —
 * the tail it cuts lies below −144 dBFS.
 */
export const IMX_IDLE_LEVEL = 2 ** -24;
export const IMX_IDLE_MARGIN_SEC = 0.05;

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

/** The mix tool's DC blocker (item 247): Opus's dc_reject, a one-pole at
 *  3 Hz whose coefficient is `6.3 × 3 ÷ fs` — 6.3 standing in for 2π, as the
 *  encoder writes it. */
export const IMX_DC_HZ = 3;
export const IMX_DC_K = 6.3;

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
      ...base, sync: true, pingPong: false, time: 48 * FX16, feedback: 0.35,
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

// ── LFO ─────────────────────────────────────────────────────────────────────

/**
 * Phase increment per sample, a U32 on a 2^32-per-cycle phase.
 *
 *   Hz mode:   floor(R · 2^16 / fs), R the 16.16 rate in Hz.
 *   sync mode: floor(2^51 · bpm / (5 · P · fs)), P the 16.16 period in
 *              quarter ticks — a tick being fs · 2.5 / bpm samples.
 *
 * The sync form is computed in 64-bit integers (BigInt here, a Long in a
 * port): its numerator passes 2^53. Both are recomputed only when the rate,
 * the tempo or the sampling rate changes.
 */
export function lfoIncrement(sync, rate, bpm, fs) {
  let inc;
  if (!sync) {
    inc = Math.floor((rate * FX16) / fs);
  } else {
    const num = (1n << 51n) * BigInt(bpm | 0);
    const den = 5n * BigInt(rate) * BigInt(fs | 0);
    inc = Number(num / den);
  }
  // A cycle shorter than two samples is aliasing, not modulation.
  return inc > 0x7fffffff ? 0x7fffffff : inc < 0 ? 0 : inc;
}

/** One LFO: a U32 phase, a waveform, and (for S&H) its own random stream. */
class ImxLfo {
  constructor() {
    this.p = defaultImixLfo();
    this.phase = 0;
    this.inc = 0;
    this.kSync = -1; this.kRate = -1; this.kBpm = -1; this.kFs = -1;
    this.held = 0;
    this.rng = 0x9e3779b9;
  }
  configure(p) { this.p = p; this.kSync = -1; }
  reset() { this.phase = 0; this.held = 0; this.rng = 0x9e3779b9; }
  /** Bring the increment up to date with the tempo (cheap when unchanged). */
  tempo(bpm, fs) {
    const sync = this.p.sync ? 1 : 0;
    if (sync !== this.kSync || this.p.rate !== this.kRate || fs !== this.kFs ||
        (sync === 1 && bpm !== this.kBpm)) {
      this.kSync = sync; this.kRate = this.p.rate; this.kBpm = bpm; this.kFs = fs;
      this.inc = lfoIncrement(this.p.sync, this.p.rate, bpm, fs);
    }
  }
  /** Advance one sample. */
  step() {
    const next = this.phase + this.inc;
    if (next >= TWO32) {
      if (this.p.wave === IMX_LFO_RANDOM) this._draw();
      this.phase = next - TWO32;
    } else {
      this.phase = next;
    }
  }
  /** Advance `n` samples at once (an idle chain still keeps time). */
  skip(n) {
    const total = this.phase + this.inc * n;
    const wraps = Math.floor(total / TWO32);
    if (this.p.wave === IMX_LFO_RANDOM) for (let i = 0; i < wraps; i++) this._draw();
    this.phase = total - wraps * TWO32;
  }
  _draw() {
    let x = this.rng;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng = x;
    this.held = (x / TWO32) * 2 - 1;
  }
  /** The waveform at the current phase, in [−1, 1]. */
  value() {
    const ph = this.phase / TWO32;
    switch (this.p.wave) {
      case IMX_LFO_SINE: return Math.sin(2 * Math.PI * ph);
      case IMX_LFO_TRIANGLE: return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
      case IMX_LFO_SQUARE: return ph < 0.5 ? 1 : -1;
      case IMX_LFO_SAW_UP: return 2 * ph - 1;
      case IMX_LFO_SAW_DOWN: return 1 - 2 * ph;
      default: return this.held;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Butterworth section Qs for a cascade of k second-order sections. */
function butterQs(k) {
  const qs = [];
  for (let i = 1; i <= k; i++) qs.push(1 / (2 * Math.cos(((2 * i - 1) * Math.PI) / (4 * k))));
  return qs;
}

/** 4-point, 3rd-order Hermite read of a circular buffer at a fractional delay
 *  of `delay` samples behind write index `w` (which holds the newest sample).
 *  `delay` MUST be at least 1. */
function hermiteRead(buf, off, len, w, delay) {
  const di = Math.floor(delay);
  const f = delay - di;
  let i0 = w - di + 1; if (i0 < 0) i0 += len; if (i0 >= len) i0 -= len;
  let i1 = i0 - 1; if (i1 < 0) i1 += len;
  let i2 = i1 - 1; if (i2 < 0) i2 += len;
  let i3 = i2 - 1; if (i3 < 0) i3 += len;
  const xm1 = buf[off + i0], x0 = buf[off + i1], x1 = buf[off + i2], x2 = buf[off + i3];
  const c0 = x0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + c0;
}

/** sin²(π·i/4096) for i ∈ [0, 4096] — a pitch shifter's crossfade window. */
const IMX_XFADE = (() => {
  const t = new Float64Array(4097);
  for (let i = 0; i <= 4096; i++) { const s = Math.sin((Math.PI * i) / 4096); t[i] = s * s; }
  return t;
})();

function xfadeAt(phase) {
  const x = (phase / TWO32) * 4096;
  const i = Math.floor(x);
  const f = x - i;
  return IMX_XFADE[i] + (IMX_XFADE[i + 1] - IMX_XFADE[i]) * f;
}

/** Wet/dry crossfade, in place: data ← wet·(1 − d) + dry·d over [n0, n1). */
function mixDry(data, dryBuf, nch, stride, n0, n1, d) {
  if (d <= 0) return;
  const w = 1 - d;
  for (let c = 0; c < nch; c++) {
    const o = c * stride;
    for (let n = n0; n < n1; n++) data[o + n] = data[o + n] * w + dryBuf[o + n] * d;
  }
}

function copySpan(src, dst, nch, stride, n0, n1) {
  for (let c = 0; c < nch; c++) {
    const o = c * stride;
    for (let n = n0; n < n1; n++) dst[o + n] = src[o + n];
  }
}

// ── The equipment ───────────────────────────────────────────────────────────
// Every piece: configure(params, rate) (keeps state), reset(), and
// process(data, stride, n0, n1, ctx) over a CHANNEL-MAJOR Float64Array in
// place. `ctx` carries the bus's geometry ({nch, stereo}), the tempo, a dry
// scratch buffer and the gain-reduction readings the meter wants.

class ImxTrim {
  constructor() { this.g = 1; }
  configure(p) { this.g = dbToGain(p.gainDb); }
  reset() {}
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const g = this.g;
    if (g === 1) return;
    for (let c = 0; c < ctx.nch; c++) {
      const o = c * stride;
      for (let n = n0; n < n1; n++) data[o + n] *= g;
    }
  }
}

/**
 * Downward expander with a gate below its floor (item 261). At or above the
 * threshold it leaves the sound alone; between the floor and the threshold it
 * expands — pushes the level down by (threshold − level) × (ratio − 1) dB, at
 * most `range`; under the floor it SHUTS, to −range, and stays shut until the
 * level is back `hysteresis` above the floor, so a level hovering at the floor
 * does not chatter. A floor of −∞ is a pure expander; a floor at the threshold
 * a pure gate. The gain moves toward that target at the attack time when it
 * rises (opening), and at the release time when it falls — but only once the
 * target has stayed below the gain for `hold`.
 *
 * The detector is linked across the bus and reads the sound through the key
 * filter (a high-pass and a low-pass, 12 dB/octave each) when that is on — so
 * a kick's boom need not open the hi-hat's gate. Peak detection is the peak
 * over the last IMX_EXPD_WINDOW_SEC, as the transient shaper's: a steady tone
 * is a steady level, which neither ripples an expander's gain nor chatters a
 * gate on the tone's own cycles. RMS is the compressor's 10 ms mean square.
 */
class ImxExpander {
  constructor(nch) {
    this.nch = nch;
    this.p = null;
    this.rate = SAMPLING_RATE;
    this.win = new ImxPeakWindow(1);
    this.hp = new Biquad(nch);
    this.lp = new Biquad(nch);
    this.atk = 0; this.rel = 0; this.rmsCoef = 0; this.holdN = 0;
    this.g = 0;        // the gain, dB (≤ 0)
    this.hold = 0;     // samples of hold left
    this.shut = false; // under the floor, and not yet back above floor + hysteresis
    this.ms = 0;       // RMS detector's mean square
    this.gr = 0;       // reading for the meter: the span's deepest gain, dB
    this.lvl = -120;   // …and its loudest detector level, dB
  }
  configure(p, rate) {
    this.p = p;
    const w = Math.max(1, Math.round(IMX_EXPD_WINDOW_SEC * rate));
    if (w !== this.win.w) this.win = new ImxPeakWindow(w);
    this.rate = rate;
    this.atk = onePole(p.attackMs, rate);
    this.rel = onePole(p.releaseMs, rate);
    this.rmsCoef = onePole(10, rate);
    this.holdN = Math.round((p.holdMs * rate) / 1000);
    this.hp.highPass(p.keyLowCut, Math.SQRT1_2, rate);
    this.lp.lowPass(p.keyHighCut, Math.SQRT1_2, rate);
  }
  reset() {
    this.win.reset();
    this.hp.reset(); this.lp.reset();
    this.g = 0; this.hold = 0; this.shut = false; this.ms = 0;
    this.gr = 0; this.lvl = -120;
  }
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const nch = ctx.nch;
    const p = this.p;
    const dry = ctx.dry;
    if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
    const key = p.keyFilter, peak = p.detector !== COMP_RMS;
    const T = p.threshDb, slope = p.ratio - 1, range = p.rangeDb;
    const floor = p.floorDb, reopen = floor + p.hysteresisDb;
    let g = this.g, hold = this.hold, shut = this.shut, ms = this.ms;
    let gr = 0, lvl = -120;
    for (let i = n0; i < n1; i++) {
      // The detector: every channel, through the key filter when it is on.
      let l = 0, sum = 0;
      for (let c = 0; c < nch; c++) {
        let x = data[c * stride + i];
        if (key) x = this.lp.run(c, this.hp.run(c, x));
        if (peak) { const a = x < 0 ? -x : x; if (a > l) l = a; } else sum += x * x;
      }
      let level;
      if (peak) level = this.win.push(l);
      else { ms += (sum / nch - ms) * this.rmsCoef; level = Math.sqrt(ms); }
      const L = level > 1e-6 ? 20 * Math.log10(level) : -120;
      if (L > lvl) lvl = L;
      // The gain computer.
      if (L < floor) shut = true;
      else if (L >= reopen) shut = false;
      let target;
      if (shut) target = -range;
      else if (L < T) {
        const under = (T - L) * slope;
        target = under > range ? -range : -under;
      } else target = 0;
      // Opening at the attack; closing at the release, once the hold is over.
      if (target >= g) { g += (target - g) * this.atk; hold = this.holdN; }
      else if (hold > 0) hold--;
      else g += (target - g) * this.rel;
      if (g < gr) gr = g;
      const k = dbToGain(g);
      for (let c = 0; c < nch; c++) data[c * stride + i] *= k;
    }
    this.g = g; this.hold = hold; this.shut = shut; this.ms = ms;
    this.gr = gr; this.lvl = lvl;
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
}

/** Up to eight bands; a cut band is a Butterworth cascade of up to four
 *  sections, every other shape one RBJ section. A band that is off is not in
 *  the list at all. */
class ImxEq {
  constructor(nch) {
    this.nch = nch;
    this.bands = [];   // per band: Biquad[] (allocated on demand)
    this.live = [];    // the sections that run, in order
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
      while (secs.length < k) secs.push(new Biquad(this.nch));
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
  reset() { for (const secs of this.bands) for (const s of secs) s.reset(); }
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const live = this.live;
    if (live.length === 0) return;
    for (let c = 0; c < ctx.nch; c++) {
      const o = c * stride;
      for (let n = n0; n < n1; n++) {
        let y = data[o + n];
        for (let i = 0; i < live.length; i++) y = live[i].run(c, y);
        data[o + n] = y;
      }
    }
  }
  /** Magnitude response at `freq` (dB) — for the display. */
  responseDb(freq, rate) {
    let db = 0;
    for (const s of this.live) db += biquadDb(s, freq, rate);
    return db;
  }
}

/**
 * Dynamic equaliser. Each band is a SENSOR and an ACTOR. The actor is a shelf
 * or a bell whose gain is the band's static gain plus a dynamic part; the
 * sensor (low-pass for the low shelf, high-pass for the high one, band-pass
 * for the bells) is what hears the level that drives that dynamic part — at
 * the actor's own frequency, or, unlinked, at a range of its own. Above the
 * threshold the dynamic part e moves toward (level − threshold)·(1 − 1/ratio)
 * dB, at most `range`, downward (a cut) or upward (a boost), with the attack
 * and release a compressor has; the actor applies e × 10^(actor gain / 20),
 * so the actor gain scales every movement (0 dB = as computed). The sensor is
 * linked across the bus, like every dynamics detector here.
 *
 * The act filter's coefficients follow the gain every IMX_CONTROL_PERIOD
 * samples.
 */
class ImxDeq {
  constructor(nch) {
    this.nch = nch;
    this.act = [];
    this.sense = [];
    for (let i = 0; i < IMX_DEQ_BANDS; i++) {
      this.act.push(new Biquad(nch));
      this.sense.push(new Biquad(nch));
    }
    this.env = new Float64Array(IMX_DEQ_BANDS);   // dynamic gain, dB (signed), before the actor gain
    this.actor = new Float64Array(IMX_DEQ_BANDS).fill(1);  // 10^(actorDb/20): what the actor multiplies e by
    this.ctl = 0;
    this.p = null;
    this.rate = SAMPLING_RATE;
    this.atk = new Float64Array(IMX_DEQ_BANDS);
    this.rel = new Float64Array(IMX_DEQ_BANDS);
    this.live = [];
    this.gr = new Float64Array(IMX_DEQ_BANDS);    // reading for the meter
    this.lvl = new Float64Array(IMX_DEQ_BANDS).fill(-120);  // loudest sense level of the span, dB
  }
  configure(p, rate) {
    this.p = p;
    this.rate = rate;
    this.live = [];
    for (let i = 0; i < IMX_DEQ_BANDS; i++) {
      const b = p.bands[i];
      if (!b.on) continue;
      this.live.push(i);
      this.atk[i] = onePole(b.attackMs, rate);
      this.actor[i] = dbToGain(b.actorDb);
      this.rel[i] = onePole(b.releaseMs, rate);
      const s = this.sense[i];
      if (i === IMX_DEQ_LOW_SHELF_BAND) s.lowPass(b.senseFreq, b.senseQ, rate);
      else if (i === IMX_DEQ_HIGH_SHELF_BAND) s.highPass(b.senseFreq, b.senseQ, rate);
      else s.bandPass(b.senseFreq, b.senseQ, rate);
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
  reset() {
    for (const s of this.act) s.reset();
    for (const s of this.sense) s.reset();
    this.env.fill(0);
    this.ctl = 0;
    this.gr.fill(0);
    if (this.p) for (const i of this.live) this._setAct(i);
  }
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const live = this.live;
    if (live.length === 0) return;
    const nch = ctx.nch;
    const bands = this.p.bands;
    this.gr.fill(0);
    this.lvl.fill(-120);
    for (let n = n0; n < n1; n++) {
      if (this.ctl === 0) for (const i of live) this._setAct(i);
      this.ctl = this.ctl + 1 === IMX_CONTROL_PERIOD ? 0 : this.ctl + 1;
      for (let k = 0; k < live.length; k++) {
        const i = live[k];
        const b = bands[i];
        // Sense on the band's INPUT (the bands run in series, so each one
        // listens to what the bands before it have left).
        let level = 0;
        for (let c = 0; c < nch; c++) {
          const sv = this.sense[i].run(c, data[c * stride + n]);
          const a = sv < 0 ? -sv : sv;
          if (a > level) level = a;
        }
        const levelDb = level > 1e-6 ? 20 * Math.log10(level) : -120;
        if (levelDb > this.lvl[i]) this.lvl[i] = levelDb;
        const over = levelDb - b.threshDb;
        let amt = over > 0 ? over * (1 - 1 / b.ratio) : 0;
        if (amt > b.rangeDb) amt = b.rangeDb;
        const target = b.boost ? amt : -amt;
        const cur = this.env[i];
        const away = (target < 0 ? -target : target) > (cur < 0 ? -cur : cur);
        this.env[i] = cur + (target - cur) * (away ? this.atk[i] : this.rel[i]);
        // The meter reads what the actor applies.
        const e = this.env[i] * this.actor[i];
        if ((e < 0 ? -e : e) > (this.gr[i] < 0 ? -this.gr[i] : this.gr[i])) this.gr[i] = e;
        const s = this.act[i];
        for (let c = 0; c < nch; c++) {
          const j = c * stride + n;
          data[j] = s.run(c, data[j]);
        }
      }
    }
  }
  /** Static response (every live band at its static gain plus its CURRENT
   *  dynamic gain) — what the display draws. */
  responseDb(freq, rate) {
    let db = 0;
    for (const i of this.live) db += biquadDb(this.act[i], freq, rate);
    return db;
  }
  /** For a display copy only: put the bands' dynamic gains (dB per band, as
   *  the meter reads them; null = at rest) into the act filters, so
   *  responseDb draws the equaliser as it stands at that moment. */
  showGains(env) {
    // `env` is the APPLIED dynamic gain (the meter's), so the actor comes back out.
    if (env) for (let i = 0; i < IMX_DEQ_BANDS; i++) this.env[i] = env[i] / this.actor[i];
    else this.env.fill(0);
    if (this.p) for (const i of this.live) this._setAct(i);
  }
}

/**
 * The multiband split the compressor and the transient shaper share:
 * Linkwitz–Riley 4th-order crossovers in a cascade — band k is the low side of
 * crossover k taken from the high side of k − 1 — and each band then passes
 * through the all-pass of every LATER crossover, so all of them carry the same
 * phase and their sum, untouched, is the input through one all-pass per
 * crossover. That sum is also what the dry signal is for a multiband piece's
 * wet/dry: mixing against the untouched input would put notches at every
 * crossover.
 */
class ImxSplit {
  constructor(nch) {
    this.nch = nch;
    this.bandsN = 0;
    this.lp = []; this.hp = []; this.ap = [];  // per crossover: [s1, s2] / per band: Biquad[]
    this.bufs = null;                          // per band, channel-major span scratch
    this.cap = 0;
  }
  /** Make room for n bands; true when the count changed, so the caller's
   *  per-band state starts again too. */
  resize(n) {
    if (n === this.bandsN) return false;
    this.bandsN = n;
    this.lp = []; this.hp = []; this.ap = [];
    for (let k = 0; k < n - 1; k++) {
      this.lp.push([new Biquad(this.nch), new Biquad(this.nch)]);
      this.hp.push([new Biquad(this.nch), new Biquad(this.nch)]);
    }
    for (let k = 0; k < n; k++) {
      const aps = [];
      for (let j = k + 1; j < n - 1; j++) aps.push(new Biquad(this.nch));
      this.ap.push(aps);
    }
    this.bufs = null;
    return true;
  }
  configure(crossovers, rate) {
    const n = this.bandsN;
    for (let k = 0; k < n - 1; k++) {
      const f = crossovers[k];
      for (const s of this.lp[k]) s.lowPass(f, Math.SQRT1_2, rate);
      for (const s of this.hp[k]) s.highPass(f, Math.SQRT1_2, rate);
    }
    for (let k = 0; k < n; k++) {
      for (let j = k + 1; j < n - 1; j++) this.ap[k][j - k - 1].allPass(crossovers[j], Math.SQRT1_2, rate);
    }
  }
  reset() {
    for (const pair of this.lp) for (const s of pair) s.reset();
    for (const pair of this.hp) for (const s of pair) s.reset();
    for (const aps of this.ap) for (const s of aps) s.reset();
  }
  /** Split [n0, n1) of `data` into the bands (returned, channel-major, stride
   *  `stride`), and — when `dryBuf` is given — their untouched sum into it. */
  split(data, stride, n0, n1, nch, dryBuf) {
    const n = this.bandsN;
    if (this.bufs === null || this.cap !== stride) {
      this.cap = stride;
      this.bufs = [];
      for (let k = 0; k < n; k++) this.bufs.push(new Float64Array(this.nch * stride));
    }
    const bufs = this.bufs;
    // Split: rest ← input; band k ← LR4 low of rest; rest ← LR4 high of rest.
    for (let c = 0; c < nch; c++) {
      const o = c * stride;
      for (let i = n0; i < n1; i++) {
        let rest = data[o + i];
        for (let k = 0; k < n - 1; k++) {
          const [l1, l2] = this.lp[k];
          const [h1, h2] = this.hp[k];
          bufs[k][o + i] = l2.run(c, l1.run(c, rest));
          rest = h2.run(c, h1.run(c, rest));
        }
        bufs[n - 1][o + i] = rest;
        // Phase-match each band to the crossovers it did not pass through.
        for (let k = 0; k < n - 2; k++) {
          let y = bufs[k][o + i];
          const aps = this.ap[k];
          for (let j = 0; j < aps.length; j++) y = aps[j].run(c, y);
          bufs[k][o + i] = y;
        }
      }
    }
    if (dryBuf !== null) this.sum(dryBuf, stride, n0, n1, nch);
    return bufs;
  }
  /** The bands summed into `out` over [n0, n1). */
  sum(out, stride, n0, n1, nch) {
    const n = this.bandsN;
    const bufs = this.bufs;
    for (let c = 0; c < nch; c++) {
      const o = c * stride;
      for (let i = n0; i < n1; i++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += bufs[k][o + i];
        out[o + i] = s;
      }
    }
  }
  /** Band k's crossover magnitude at `freq` (linear). An LR4 section pair is
   *  one Butterworth section squared. */
  magnitude(k, freq, rate) {
    let m = 1;
    for (let j = 0; j < k; j++) m *= 10 ** (biquadDb(this.hp[j][0], freq, rate) / 10);
    if (k < this.bandsN - 1) m *= 10 ** (biquadDb(this.lp[k][0], freq, rate) / 10);
    return m;
  }
}

/**
 * Compressor, one to six bands. One band is an ordinary compressor (the
 * mastering chain's, with its detector linked across the bus). More is a
 * multiband one over ImxSplit's bands, each compressed by its own detector and
 * gain computer and the bands summed.
 */
class ImxComp {
  constructor(nch) {
    this.nch = nch;
    this.bandsN = 0;
    this.xo = new ImxSplit(nch);
    this.comps = [];
    this.p = null;
    this.gr = new Float64Array(IMX_COMP_MAX_BANDS);
    this.lvl = new Float64Array(IMX_COMP_MAX_BANDS).fill(-120);  // loudest detector reading of the span, dB
    this.showGr = new Float64Array(IMX_COMP_MAX_BANDS);
  }
  configure(p, rate) {
    this.p = p;
    const n = p.bands.length;
    if (this.xo.resize(n)) {
      this.bandsN = n;
      this.comps = [];
      for (let k = 0; k < n; k++) this.comps.push(new CompressorStage());
    }
    this.xo.configure(p.crossovers, rate);
    for (let k = 0; k < n; k++) {
      const b = p.bands[k];
      this.comps[k].configure({
        compDetector: p.detector, compThreshDb: b.threshDb, compRatio: b.ratio,
        compAttackMs: b.attackMs, compReleaseMs: b.releaseMs, compKneeDb: b.kneeDb,
        compMakeupDb: b.makeupDb,
      }, rate);
    }
  }
  reset() {
    this.xo.reset();
    for (const c of this.comps) c.reset();
    this.gr.fill(0);
  }
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const nch = ctx.nch;
    const p = this.p;
    const n = this.bandsN;
    const dry = ctx.dry;
    this.gr.fill(0);
    this.lvl.fill(-120);
    if (n === 1) {
      if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
      const comp = this.comps[0];
      if (p.bands[0].on) {
        for (let i = n0; i < n1; i++) {
          const g = comp.stepPlanar(data, i, stride, nch);
          for (let c = 0; c < nch; c++) data[c * stride + i] *= g;
          if (comp.grDb < this.gr[0]) this.gr[0] = comp.grDb;
          if (comp.levelDb > this.lvl[0]) this.lvl[0] = comp.levelDb;
        }
      }
      mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
      return;
    }
    const bufs = this.xo.split(data, stride, n0, n1, nch, dry > 0 ? ctx.dryBuf : null);
    for (let k = 0; k < n; k++) {
      if (!p.bands[k].on) continue;   // an unused band passes, unprocessed
      const comp = this.comps[k];
      const b = bufs[k];
      for (let i = n0; i < n1; i++) {
        const g = comp.stepPlanar(b, i, stride, nch);
        for (let c = 0; c < nch; c++) b[c * stride + i] *= g;
        if (comp.grDb < this.gr[k]) this.gr[k] = comp.grDb;
        if (comp.levelDb > this.lvl[k]) this.lvl[k] = comp.levelDb;
      }
    }
    this.xo.sum(data, stride, n0, n1, nch);
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
  /** For a display copy only: the bands' gain reductions (dB, ≤ 0; null = at
   *  rest) that responseDb draws the compressor at. */
  showGains(gr) {
    if (gr) this.showGr.set(gr.subarray ? gr.subarray(0, IMX_COMP_MAX_BANDS) : gr);
    else this.showGr.fill(0);
  }
  /**
   * The compressor's response at `freq` (dB) at the gains showGains gave it:
   * every band at its reduction plus its make-up, weighted by its crossover
   * magnitudes, and the wet/dry against the dry sum. The bands carry one
   * phase (the all-pass matching above), so their magnitudes add.
   */
  responseDb(freq, rate) {
    const p = this.p;
    const n = this.bandsN;
    if (!p || n === 0) return 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const b = p.bands[k];
      sum += (b.on ? dbToGain(this.showGr[k] + b.makeupDb) : 1) * this.xo.magnitude(k, freq, rate);
    }
    const d = p.dry / 255;
    const y = sum * (1 - d) + d;
    return y > 1e-9 ? 20 * Math.log10(y) : -180;
  }
}

/**
 * The peak of a level over the last W samples, this one included (0 before a
 * reset) — the detector of the transient shaper and the expander (item 261).
 * A monotonic deque of the samples that can still be the peak, oldest first,
 * levels strictly falling: a sample W old leaves at the front, one no louder
 * than the newest leaves at the back, as it can never be the peak again. Any
 * way of taking the max over the window gives the same number.
 */
class ImxPeakWindow {
  constructor(w) {
    this.w = w;
    this.idx = new Int32Array(w);
    this.val = new Float64Array(w);
    this.head = 0; this.len = 0;
    this.t = 0;          // sample counter, mod 2^31
  }
  reset() { this.head = 0; this.len = 0; this.t = 0; }
  /** Take the next sample's level; return the window's peak. */
  push(l) {
    const W = this.w, idx = this.idx, val = this.val;
    const ix = this.t;
    this.t = (ix + 1) & 0x7fffffff;
    let head = this.head, len = this.len;
    if (len > 0 && ((ix - idx[head]) & 0x7fffffff) >= W) { head = head + 1 === W ? 0 : head + 1; len--; }
    while (len > 0) {
      let back = head + len - 1;
      if (back >= W) back -= W;
      if (val[back] > l) break;
      len--;
    }
    let at = head + len;
    if (at >= W) at -= W;
    idx[at] = ix; val[at] = l;
    this.head = head; this.len = len + 1;
    return val[head];
  }
}

/**
 * Transient shaper, one to six bands (item 261) — over ImxSplit's bands like
 * the compressor, but blind to LEVEL: it reshapes each note's envelope, the
 * attack louder or softer, the sustain longer or shorter, whatever the note's
 * loudness.
 *
 * A band's detector is the peak over the last IMX_TSH_WINDOW_SEC (every
 * channel linked), P. A 25 ms window holds across a half-cycle of any audible
 * tone, so a steady sound reads as a steady P (to within where its samples
 * fall on its peaks, a few parts in a million) and the shaper leaves it alone
 * — the detector has no ripple to turn into distortion. Two envelopes follow P:
 *
 *   S  rises toward P at the band's attack time and falls with it at once;
 *      while it lags a rise, 1 − S/P is the TRANSIENT, 1 at the first sample
 *      of a note, 0 once it has settled;
 *   L  rises with P at once and falls toward it at the band's release time;
 *      while P falls away from it, 1 − P/L is the SUSTAIN, 0 until the sound
 *      begins to decay and growing as it does.
 *
 * The band's gain is attack × transient + sustain × sustain (dB), glided
 * through a 1 ms one-pole, plus its output gain. The window is an
 * ImxPeakWindow; everything after it is binary64.
 */
class ImxTransient {
  constructor(nch) {
    this.nch = nch;
    this.bandsN = 0;
    this.xo = new ImxSplit(nch);
    this.p = null;
    this.rate = SAMPLING_RATE;
    this.win = 1;
    // Per band: the detector window, the envelopes and the glided gain.
    this.peak = [];
    this.S = new Float64Array(IMX_TSH_MAX_BANDS);
    this.L = new Float64Array(IMX_TSH_MAX_BANDS);
    this.e = new Float64Array(IMX_TSH_MAX_BANDS);        // glided dynamic gain, dB
    this.atk = new Float64Array(IMX_TSH_MAX_BANDS);
    this.rel = new Float64Array(IMX_TSH_MAX_BANDS);
    this.smooth = onePole(IMX_TSH_SMOOTH_MS, SAMPLING_RATE);
    this.gr = new Float64Array(IMX_TSH_MAX_BANDS);       // reading for the meter: signed, the span's extreme
    this.showGr = new Float64Array(IMX_TSH_MAX_BANDS);
  }
  configure(p, rate) {
    this.p = p;
    const n = p.bands.length;
    const win = Math.max(1, Math.round(IMX_TSH_WINDOW_SEC * rate));
    if (this.xo.resize(n) || win !== this.win || rate !== this.rate) {
      this.bandsN = n;
      this.win = win;
      this.peak = [];
      for (let k = 0; k < n; k++) this.peak.push(new ImxPeakWindow(win));
      this._clear();
    }
    this.rate = rate;
    this.smooth = onePole(IMX_TSH_SMOOTH_MS, rate);
    this.xo.configure(p.crossovers, rate);
    for (let k = 0; k < n; k++) {
      this.atk[k] = onePole(p.bands[k].attackMs, rate);
      this.rel[k] = onePole(p.bands[k].releaseMs, rate);
    }
  }
  _clear() {
    for (const w of this.peak) w.reset();
    this.S.fill(0); this.L.fill(0); this.e.fill(0);
  }
  reset() {
    this.xo.reset();
    this._clear();
    this.gr.fill(0);
  }
  get memory() { return 0; }
  /** Band k over [n0, n1) of `b`, in place. */
  _band(k, b, stride, n0, n1, nch) {
    const band = this.p.bands[k];
    const win = this.peak[k];
    let S = this.S[k], L = this.L[k], e = this.e[k];
    const atk = this.atk[k], rel = this.rel[k], sm = this.smooth;
    const ga = band.attackDb, gs = band.sustainDb, out = band.outDb;
    let gr = this.gr[k];
    for (let i = n0; i < n1; i++) {
      let l = 0;
      for (let c = 0; c < nch; c++) {
        const x = b[c * stride + i];
        const a = x < 0 ? -x : x;
        if (a > l) l = a;
      }
      const P = win.push(l);
      S = P > S ? S + (P - S) * atk : P;
      L = P < L ? L + (P - L) * rel : P;
      const tr = P > 0 ? 1 - S / P : 0;
      const su = L > 0 ? 1 - P / L : 0;
      e += (ga * tr + gs * su - e) * sm;
      if ((e < 0 ? -e : e) > (gr < 0 ? -gr : gr)) gr = e;
      const g = dbToGain(e + out);
      for (let c = 0; c < nch; c++) b[c * stride + i] *= g;
    }
    this.S[k] = S; this.L[k] = L; this.e[k] = e;
    this.gr[k] = gr;
  }
  process(data, stride, n0, n1, ctx) {
    const nch = ctx.nch;
    const p = this.p;
    const n = this.bandsN;
    const dry = ctx.dry;
    this.gr.fill(0);
    if (n === 1) {
      if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
      if (p.bands[0].on) this._band(0, data, stride, n0, n1, nch);
    } else {
      const bufs = this.xo.split(data, stride, n0, n1, nch, dry > 0 ? ctx.dryBuf : null);
      for (let k = 0; k < n; k++) if (p.bands[k].on) this._band(k, bufs[k], stride, n0, n1, nch);
      this.xo.sum(data, stride, n0, n1, nch);
    }
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
  /** For a display copy only: the bands' dynamic gains (dB, signed; null =
   *  at rest) that responseDb draws the shaper at. */
  showGains(gr) {
    if (gr) this.showGr.set(gr.subarray ? gr.subarray(0, IMX_TSH_MAX_BANDS) : gr);
    else this.showGr.fill(0);
  }
  /** The shaper's response at `freq` (dB) at those gains: every band at its
   *  dynamic gain plus its output, weighted by its crossover magnitudes, and
   *  the wet/dry against the dry sum. */
  responseDb(freq, rate) {
    const p = this.p;
    const n = this.bandsN;
    if (!p || n === 0) return 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const b = p.bands[k];
      sum += (b.on ? dbToGain(this.showGr[k] + b.outDb) : 1) * this.xo.magnitude(k, freq, rate);
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

// Saturator transfer functions f and their antiderivatives F (F(0) = 0) —
// the pair first-order antiderivative anti-aliasing needs:
//   y[n] = (F(u[n]) − F(u[n−1])) / (u[n] − u[n−1])
// which is the mean of f over the segment the signal just travelled, and
// falls back to f at the midpoint when the segment is too short to divide by.
const LN2 = Math.LN2;
function lnCosh(x) {
  const a = x < 0 ? -x : x;
  return a + Math.log1p(Math.exp(-2 * a)) - LN2;
}
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
function satAD(curve, x) {
  switch (curve) {
    case IMX_SAT_SOFT: {
      const a = x < 0 ? -x : x;
      if (a >= 1) return a - 0.375;
      const x2 = x * x;
      return 1.5 * (x2 * 0.5 - (x2 * x2) / 12);
    }
    case IMX_SAT_HARD: {
      const a = x < 0 ? -x : x;
      return a > 1 ? a - 0.5 : x * x * 0.5;
    }
    case IMX_SAT_TUBE: return x >= 0 ? lnCosh(x) : 0.25 * lnCosh(2 * x);
    case IMX_SAT_FOLD: return 1 - Math.cos(x);
    default: return lnCosh(x);
  }
}
const SAT_EPS = 1e-5;

class ImxSat {
  constructor(nch) {
    this.nch = nch;
    this.u1 = new Float64Array(nch);      // previous shaper input, per channel
    this.dcX = new Float64Array(nch);
    this.dcY = new Float64Array(nch);
    this.p = null;
    this.gIn = 1; this.gOut = 1; this.fb = 0; this.dcR = 0;
  }
  configure(p, rate) {
    this.p = p;
    this.gIn = dbToGain(p.inDb) * dbToGain(p.driveDb);
    this.gOut = dbToGain(p.outDb);
    this.fb = satF(p.curve, p.bias);
    // A 5 Hz DC blocker follows an asymmetric curve: the offset an uneven
    // shape adds depends on the signal, so f(bias) alone cannot remove it.
    this.dcR = 1 - (2 * Math.PI * 5) / rate;
    if (this._curve !== p.curve || this._bias !== p.bias) {
      this._curve = p.curve; this._bias = p.bias;
      this.u1.fill(p.bias);
    }
  }
  reset() {
    this.u1.fill(this.p ? this.p.bias : 0);
    this.dcX.fill(0); this.dcY.fill(0);
  }
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const p = this.p;
    const nch = ctx.nch;
    const dry = ctx.dry;
    if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
    const curve = p.curve, bias = p.bias, gIn = this.gIn, gOut = this.gOut, fb = this.fb;
    const dc = bias !== 0 || curve === IMX_SAT_TUBE;
    const R = this.dcR;
    for (let c = 0; c < nch; c++) {
      const o = c * stride;
      let u1 = this.u1[c];
      let F1 = satAD(curve, u1);
      let dx = this.dcX[c], dy = this.dcY[c];
      for (let n = n0; n < n1; n++) {
        const u = data[o + n] * gIn + bias;
        const d = u - u1;
        let y;
        let F0;
        if (d > SAT_EPS || d < -SAT_EPS) {
          F0 = satAD(curve, u);
          y = (F0 - F1) / d;
        } else {
          F0 = satAD(curve, u);
          y = satF(curve, (u + u1) * 0.5);
        }
        u1 = u; F1 = F0;
        y -= fb;
        if (dc) {
          const yy = y - dx + R * dy;
          dx = y; dy = yy; y = yy;
        }
        data[o + n] = y * gOut;
      }
      this.u1[c] = u1;
      this.dcX[c] = dx; this.dcY[c] = dy;
    }
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
}

/** The window a unison voice's pitch shifter sweeps, in seconds. */
const UNIS_WINDOW_SEC = 0.025;

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

/**
 * Unison: 2…8 copies of the bus, each pitch-shifted by its share of the detune
 * and, on a stereo bus, panned by its share of the width. A copy is a
 * delay-line pitch shifter: two taps half a window apart sweeping the window
 * at (1 − ratio) samples per sample, crossfaded by sin². The sweep is a U32
 * phase (the accumulating quantity, so fixed point), its increment recomputed
 * every IMX_CONTROL_PERIOD samples from the LFO-modulated detune.
 *
 * The copies sum at 1/√n, which holds the power of n uncorrelated copies at
 * the input's. On a bus that is not a stereo pair the width means nothing and
 * every copy keeps its channels.
 */
class ImxUnison {
  constructor(nch) {
    this.nch = nch;
    this.len = 0;
    this.buf = null;
    this.w = 0;
    this.win = 0;
    this.phase = new Float64Array(IMX_UNIS_MAX_VOICES);
    this.inc = new Float64Array(IMX_UNIS_MAX_VOICES);
    this.pan = new Float64Array(IMX_UNIS_MAX_VOICES);
    this.pos = null;
    this.lfoD = new ImxLfo();
    this.lfoW = new ImxLfo();
    this.ctl = 0;
    this.p = null;
    this.rate = SAMPLING_RATE;
    // The detune (cents) and width the last control period set: the meter's.
    this.curCents = 0;
    this.curWidth = 0;
  }
  configure(p, rate) {
    this.p = p;
    this.rate = rate;
    const win = Math.round(UNIS_WINDOW_SEC * rate);
    if (win !== this.win) {
      this.win = win;
      this.len = win + 8;
      this.buf = new Float64Array(this.nch * this.len);
      this.w = 0;
    }
    this.pos = unisonPositions(p.voices, p.spacing);
    this.lfoD.configure(p.detuneLfo);
    this.lfoW.configure(p.widthLfo);
    this.ctl = 0;
  }
  reset() {
    if (this.buf) this.buf.fill(0);
    this.w = 0;
    // Staggered start: voices that began in step would comb against each
    // other until their sweeps drifted apart.
    for (let k = 0; k < IMX_UNIS_MAX_VOICES; k++) this.phase[k] = Math.floor((k * TWO32) / IMX_UNIS_MAX_VOICES);
    this.lfoD.reset();
    this.lfoW.reset();
    this.ctl = 0;
  }
  get memory() { return this.len; }
  retrigger() {
    if (this.p.detuneLfo.retrigger) this.lfoD.phase = 0;
    if (this.p.widthLfo.retrigger) this.lfoW.phase = 0;
  }
  skip(frames, ctx) {
    this.lfoD.tempo(ctx.bpm, this.rate); this.lfoW.tempo(ctx.bpm, this.rate);
    this.lfoD.skip(frames); this.lfoW.skip(frames);
  }
  _control() {
    const p = this.p;
    const nv = p.voices;
    const dl = this.lfoD.value() * p.detuneLfo.depth;
    const wl = this.lfoW.value() * p.widthLfo.depth;
    let cents = p.detune * (1 + dl);
    cents = cents < 0 ? 0 : cents > 100 ? 100 : cents;
    let width = p.width * (1 + wl);
    width = width < 0 ? 0 : width > 1 ? 1 : width;
    this.curCents = cents;
    this.curWidth = width;
    for (let k = 0; k < nv; k++) {
      const r = 2 ** ((this.pos[k] * cents) / 1200);
      // The sweep moves (1 − r) samples per sample across a window of `win`:
      // as a U32 phase, (1 − r)·2^32 / win, rounded to an integer.
      this.inc[k] = Math.round(((1 - r) * TWO32) / this.win);
      this.pan[k] = this.pos[k] * width;
    }
  }
  process(data, stride, n0, n1, ctx) {
    const p = this.p;
    const nch = ctx.nch;
    const nv = p.voices;
    const dry = ctx.dry;
    if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
    this.lfoD.tempo(ctx.bpm, this.rate);
    this.lfoW.tempo(ctx.bpm, this.rate);
    const len = this.len, win = this.win, buf = this.buf;
    const norm = 1 / Math.sqrt(nv);
    const stereo = ctx.stereo && nch === 2;
    for (let n = n0; n < n1; n++) {
      if (this.ctl === 0) this._control();
      this.ctl = this.ctl + 1 === IMX_CONTROL_PERIOD ? 0 : this.ctl + 1;
      this.lfoD.step();
      this.lfoW.step();
      const w = this.w;
      for (let c = 0; c < nch; c++) buf[c * len + w] = data[c * stride + n];
      // Each voice's two taps, crossfaded.
      if (stereo) {
        let L = 0, R = 0;
        for (let k = 0; k < nv; k++) {
          const ph = this.phase[k];
          const ph2 = ph >= 2147483648 ? ph - 2147483648 : ph + 2147483648;
          const g1 = xfadeAt(ph);
          const d1 = 2 + (ph / TWO32) * win;
          const d2 = 2 + (ph2 / TWO32) * win;
          const yl = hermiteRead(buf, 0, len, w, d1) * g1 + hermiteRead(buf, 0, len, w, d2) * (1 - g1);
          const yr = hermiteRead(buf, len, len, w, d1) * g1 + hermiteRead(buf, len, len, w, d2) * (1 - g1);
          // Stereo pan: a pair moved as a pair, its image intact at the centre.
          const pp = this.pan[k];
          if (pp >= 0) { L += yl * (1 - pp); R += yr + yl * pp; }
          else { L += yl + yr * -pp; R += yr * (1 + pp); }
          let nx = ph + this.inc[k];
          if (nx >= TWO32) nx -= TWO32; else if (nx < 0) nx += TWO32;
          this.phase[k] = nx;
        }
        data[n] = L * norm;
        data[stride + n] = R * norm;
      } else {
        for (let c = 0; c < nch; c++) {
          let s = 0;
          for (let k = 0; k < nv; k++) {
            const ph = this.phase[k];
            const ph2 = ph >= 2147483648 ? ph - 2147483648 : ph + 2147483648;
            const g1 = xfadeAt(ph);
            s += hermiteRead(buf, c * len, len, w, 2 + (ph / TWO32) * win) * g1 +
              hermiteRead(buf, c * len, len, w, 2 + (ph2 / TWO32) * win) * (1 - g1);
          }
          data[c * stride + n] = s * norm;
        }
        for (let k = 0; k < nv; k++) {
          let nx = this.phase[k] + this.inc[k];
          if (nx >= TWO32) nx -= TWO32; else if (nx < 0) nx += TWO32;
          this.phase[k] = nx;
        }
      }
      this.w = w + 1 === len ? 0 : w + 1;
    }
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
}

/** Delay lines of the reverb at size 1, 48 kHz — mutually prime, 51…104 ms. */
const VERB_LINES = [2473, 2767, 3217, 3557, 3907, 4127, 4639, 4999];
/** Input diffusers (Schroeder all-passes), 48 kHz lengths. */
const VERB_DIFFUSERS = [245, 371, 479, 605];
const VERB_DIFFUSE_G = 0.5;

/**
 * Reverb: an eight-line feedback delay network with a Householder matrix
 * (orthogonal, so the loop's energy is set by the line gains alone), a
 * one-pole damping low-pass in every line, line gains from the decay time
 * (−60 dB after `decay` seconds: g = 10^(−3·len / (decay·fs))), four
 * Schroeder all-passes of input diffusion and a pre-delay.
 *
 * A stereo bus feeds its left channel to the even lines and its right to the
 * odd ones and takes them back the same way. Any other bus feeds the network
 * the mean of its channels and gives channel c the output of line c mod 8 —
 * eight mutually decorrelated outputs spread over the field, which is what a
 * diffuse tail is.
 */
class ImxVerb {
  constructor(nch) {
    this.nch = nch;
    this.rate = 0;
    this.lines = [];
    this.lens = new Int32Array(8);
    this.pos = new Int32Array(8);
    this.g = new Float64Array(8);
    this.z = new Float64Array(8);
    this.damp = 0;
    this.diff = [];
    this.dpos = [];
    this.pre = null; this.preLen = 0; this.prePos = 0; this.preD = 0;
    this.p = null;
    this.ins = 2;
    this.o = new Float64Array(8);
    this.f = new Float64Array(8);
  }
  configure(p, rate) {
    this.p = p;
    this.ins = this.nch === 2 ? 2 : 1;
    if (rate !== this.rate || this.lines.length === 0) {
      this.rate = rate;
      this.lines = VERB_LINES.map((l) => new Float64Array(Math.ceil((l * rate) / 48000) + 2));
      this.diff = [];
      this.dpos = [];
      for (let c = 0; c < this.ins; c++) {
        this.diff.push(VERB_DIFFUSERS.map((l) => new Float64Array(Math.max(1, Math.round((l * rate) / 48000)))));
        this.dpos.push(new Int32Array(VERB_DIFFUSERS.length));
      }
      this.preLen = Math.ceil(IMX_PREDELAY_MAX_SEC * rate) + 2;
      this.pre = new Float64Array(this.ins * this.preLen);
    }
    const scale = (0.15 + 0.85 * p.size) * (rate / 48000);
    for (let i = 0; i < 8; i++) {
      const len = Math.max(16, Math.min(this.lines[i].length - 1, Math.round(VERB_LINES[i] * scale)));
      this.lens[i] = len;
      this.g[i] = 10 ** ((-3 * len) / (p.decay * rate));
      if (this.pos[i] >= this.lines[i].length) this.pos[i] = 0;
    }
    this.damp = 1 - Math.exp((-2 * Math.PI * p.damping) / rate);
    // Pre-delay in whole samples, from 16.16 seconds: floor(P·fs / 2^16).
    this.preD = Math.min(this.preLen - 1, Math.floor((p.preDelay * rate) / FX16));
  }
  reset() {
    for (const l of this.lines) l.fill(0);
    this.pos.fill(0);
    this.z.fill(0);
    for (const ds of this.diff) for (const d of ds) d.fill(0);
    for (const dp of this.dpos) dp.fill(0);
    if (this.pre) this.pre.fill(0);
    this.prePos = 0;
  }
  get memory() {
    let m = this.preD;
    for (let i = 0; i < 8; i++) m += this.lens[i];
    for (const l of VERB_DIFFUSERS) m += Math.round((l * this.rate) / 48000);
    return m;
  }
  _diffuse(c, x) {
    const ds = this.diff[c];
    const dp = this.dpos[c];
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      const k = dp[i];
      const v = d[k];
      const y = v - VERB_DIFFUSE_G * x;
      d[k] = x + VERB_DIFFUSE_G * y;
      dp[i] = k + 1 === d.length ? 0 : k + 1;
      x = y;
    }
    return x;
  }
  process(data, stride, n0, n1, ctx) {
    const nch = ctx.nch;
    const dry = ctx.dry;
    if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
    const stereo = this.ins === 2;
    const lines = this.lines, lens = this.lens, pos = this.pos, g = this.g, z = this.z;
    const damp = this.damp;
    const preLen = this.preLen, preD = this.preD;
    const o = this.o, f = this.f;
    for (let n = n0; n < n1; n++) {
      // Inputs: per channel (stereo) or the mean of every channel.
      let inL, inR;
      if (stereo) { inL = data[n]; inR = data[stride + n]; }
      else {
        let s = 0;
        for (let c = 0; c < nch; c++) s += data[c * stride + n];
        inL = s / nch; inR = 0;
      }
      // Pre-delay.
      const pp = this.prePos;
      const rp = pp - preD < 0 ? pp - preD + preLen : pp - preD;
      this.pre[pp] = inL;
      const dL = this.pre[rp];
      let dR = 0;
      if (stereo) { this.pre[preLen + pp] = inR; dR = this.pre[preLen + rp]; }
      this.prePos = pp + 1 === preLen ? 0 : pp + 1;
      const xL = this._diffuse(0, dL);
      const xR = stereo ? this._diffuse(1, dR) : xL;
      // Read each line, damp it (one pole) and give it its decay gain.
      let sum = 0;
      for (let i = 0; i < 8; i++) {
        const line = lines[i];
        let r = pos[i] - lens[i];
        if (r < 0) r += line.length;
        const v = line[r];
        o[i] = v;
        z[i] += (v - z[i]) * damp;
        f[i] = z[i] * g[i];
        sum += f[i];
      }
      // Householder (I − (2/8)·11ᵀ), written back with the input.
      const h = sum * 0.25;
      for (let i = 0; i < 8; i++) {
        const line = lines[i];
        const inj = stereo ? ((i & 1) === 0 ? xL : xR) : xL;
        line[pos[i]] = f[i] - h + inj * 0.5;
        pos[i] = pos[i] + 1 === line.length ? 0 : pos[i] + 1;
      }
      if (stereo) {
        data[n] = 0.5 * (o[0] - o[2] + o[4] - o[6]);
        data[stride + n] = 0.5 * (o[1] - o[3] + o[5] - o[7]);
      } else {
        for (let c = 0; c < nch; c++) data[c * stride + n] = (c & 8 ? -0.5 : 0.5) * o[c & 7];
      }
    }
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
}

// Wow and flutter: two fixed sines on the read delay, 16.16 Hz rates.
const WOW_RATE = FX16 / 2;              // 0.5 Hz
const FLUTTER_RATE = 6 * FX16 + FX16 / 2; // 6.5 Hz
const WOW_SEC = 0.002;
const FLUTTER_SEC = 0.00015;
/** The glide toward a new delay time: 1/2048 of the distance per sample. */
const GLIDE_SHIFT = 2048;

/**
 * Tape delay. The time is 16.16 seconds or 16.16 quarter ticks (and follows
 * the tempo); the read head GLIDES to a new time instead of jumping — as a
 * tape machine's does, so a tempo change bends the echoes rather than clicking
 * them — by an integer 1/2048 of the remaining distance every sample, held in
 * 1/65536-sample units. The feedback path runs through a low cut, a high cut
 * and a soft saturator (tanh(g·x)/g); ping-pong crosses the feedback between
 * the channels of a stereo pair and feeds the pair's mid into the left.
 */
class ImxDelay {
  constructor(nch) {
    this.nch = nch;
    this.len = 0;
    this.buf = null;
    this.w = 0;
    this.d = 0;        // current delay, 1/65536 samples (an integer)
    this.t = 0;        // target, same units
    this.started = false;
    this.wow = 0; this.flutter = 0;
    this.wowInc = 0; this.flutInc = 0;
    this.lc = new Biquad(nch);
    this.hc = new Biquad(nch);
    this.fbs = new Float64Array(nch);
    this.xs = new Float64Array(nch);
    this.p = null;
    this.rate = SAMPLING_RATE;
    this.g = 1;
  }
  configure(p, rate) {
    this.p = p;
    if (rate !== this.rate || this.buf === null) {
      this.rate = rate;
      this.len = Math.ceil(IMX_DELAY_MAX_SEC * rate) + 16;
      this.buf = new Float64Array(this.nch * this.len);
      this.w = 0;
      this.started = false;
    }
    this.lc.highPass(p.lowCut, Math.SQRT1_2, rate);
    this.hc.lowPass(p.highCut, Math.SQRT1_2, rate);
    this.g = dbToGain(p.driveDb);
    this.wowInc = Math.floor((WOW_RATE * FX16) / rate);
    this.flutInc = Math.floor((FLUTTER_RATE * FX16) / rate);
    this._key = "";
  }
  reset() {
    if (this.buf) this.buf.fill(0);
    this.w = 0;
    this.lc.reset(); this.hc.reset();
    this.fbs.fill(0);
    this.wow = 0; this.flutter = 0;
    this.started = false;
  }
  get memory() { return this.len; }
  /** The target delay in 1/65536 samples for this tempo. */
  _target(bpm) {
    const p = this.p;
    const fs = this.rate;
    let t;
    if (p.sync) {
      // P quarter ticks · (fs · 2.5 / bpm) / 4 samples, ×2^16: P·fs·5 / (8·bpm).
      t = Math.floor((p.time * fs * 5) / (8 * bpm));
    } else {
      t = p.time * fs;     // 16.16 seconds × fs = samples × 2^16, exactly
    }
    const lo = 2 * FX16;
    const hi = (this.len - 8) * FX16;
    return t < lo ? lo : t > hi ? hi : t;
  }
  skip(frames) {
    this.wow = (this.wow + this.wowInc * frames) % TWO32;
    this.flutter = (this.flutter + this.flutInc * frames) % TWO32;
  }
  process(data, stride, n0, n1, ctx) {
    const p = this.p;
    const nch = ctx.nch;
    const dry = ctx.dry;
    if (dry > 0) copySpan(data, ctx.dryBuf, nch, stride, n0, n1);
    this.t = this._target(ctx.bpm);
    if (!this.started) { this.d = this.t; this.started = true; }
    const len = this.len, buf = this.buf;
    const fs = this.rate;
    const fb = p.feedback, g = this.g;
    const wowAmp = p.wow * WOW_SEC * fs;
    const flutAmp = p.wow * FLUTTER_SEC * fs;
    const pingPong = p.pingPong && ctx.stereo && nch === 2;
    const fbs = this.fbs, xs = this.xs;
    for (let n = n0; n < n1; n++) {
      // Glide (integer arithmetic on exact binary64 integers).
      const diff = this.t - this.d;
      if (diff >= GLIDE_SHIFT || diff <= -GLIDE_SHIFT) this.d += Math.trunc(diff / GLIDE_SHIFT);
      else this.d = this.t;
      let delay = this.d / FX16;
      if (wowAmp !== 0) {
        delay += wowAmp * Math.sin((2 * Math.PI * this.wow) / TWO32) +
          flutAmp * Math.sin((2 * Math.PI * this.flutter) / TWO32);
      }
      if (delay < 2) delay = 2;
      this.wow += this.wowInc; if (this.wow >= TWO32) this.wow -= TWO32;
      this.flutter += this.flutInc; if (this.flutter >= TWO32) this.flutter -= TWO32;
      const w = this.w;
      // Read every channel first (the write below may cross them). The
      // newest sample in the line is the PREVIOUS one, so D samples of delay
      // is D − 1 behind it.
      for (let c = 0; c < nch; c++) {
        xs[c] = data[c * stride + n];
        const y = hermiteRead(buf, c * len, len, w === 0 ? len - 1 : w - 1, delay - 1);
        let f = this.hc.run(c, this.lc.run(c, y * fb));
        f = Math.tanh(g * f) / g;
        fbs[c] = f;
        data[c * stride + n] = y;
      }
      if (pingPong) {
        const mid = (xs[0] + xs[1]) * 0.5;
        buf[w] = mid + fbs[1];
        buf[len + w] = fbs[0];
      } else {
        for (let c = 0; c < nch; c++) buf[c * len + w] = xs[c] + fbs[c];
      }
      this.w = w + 1 === len ? 0 : w + 1;
    }
    mixDry(data, ctx.dryBuf, nch, stride, n0, n1, dry);
  }
}

/** The mastering chain's look-ahead limiter, on the bus, after a gain. */
class ImxLimiter {
  constructor(nch) {
    this.stage = new LimiterStage(nch);
    this.g = 1;
    this.gr = 0;
  }
  configure(p, rate) {
    this.g = dbToGain(p.gainDb);
    this.stage.configure({
      limCeilingDb: p.ceilingDb, limTruePeak: p.truePeak, limReleaseMs: p.releaseMs,
    }, rate);
  }
  reset() { this.stage.reset(); this.gr = 0; }
  get memory() { return this.stage.latency; }
  process(data, stride, n0, n1, ctx) {
    const g = this.g;
    const nch = ctx.nch;
    this.stage.grDb = 0;
    for (let n = n0; n < n1; n++) {
      if (g !== 1) for (let c = 0; c < nch; c++) data[c * stride + n] *= g;
      this.stage.stepPlanar(data, n, stride);
    }
    this.gr = this.stage.grDb;
  }
}

/**
 * Mix tool: DC removal, gain, stereo width (mid/side, skipped at exactly 1),
 * channel swap and polarity. On a bus that is not a stereo pair the width and
 * the swap mean nothing and are skipped, and the polarity can only be the whole
 * field's: it is inverted when BOTH invert switches are on, and left alone
 * otherwise. On an AMBISONIC bus the width is surround width (item 247): every
 * channel but W (bus channel 0) is scaled by it, the mastering chain's rule.
 * The DC blocker runs first, on every channel: Opus's dc_reject
 * (`y = x − m`, then `m = a·x + (1 − a)·m`, a = IMX_DC_K × IMX_DC_HZ ÷ fs).
 */
class ImxMixTool {
  constructor(nch) { this.p = null; this.g = 1; this.a = 0; this.m = new Float64Array(nch); }
  configure(p, rate) {
    this.p = p;
    this.g = dbToGain(p.gainDb);
    this.a = (IMX_DC_K * IMX_DC_HZ) / rate;
  }
  reset() { this.m.fill(0); }
  get memory() { return 0; }
  process(data, stride, n0, n1, ctx) {
    const p = this.p;
    const nch = ctx.nch;
    const g = this.g;
    if (p.removeDc) {
      const a = this.a, b = 1 - a;
      const mem = this.m;
      for (let c = 0; c < nch; c++) {
        const o = c * stride;
        let m = mem[c];
        for (let n = n0; n < n1; n++) {
          const x = data[o + n];
          data[o + n] = x - m;
          m = a * x + b * m;
        }
        mem[c] = m;
      }
    }
    if (ctx.stereo && nch === 2) {
      const gl = (p.invL ? -g : g);
      const gr = (p.invR ? -g : g);
      const w = p.width;
      for (let n = n0; n < n1; n++) {
        let l = data[n], r = data[stride + n];
        if (p.swap) { const t = l; l = r; r = t; }
        if (w !== 1) {
          const m = (l + r) * 0.5;
          const s = (l - r) * 0.5 * w;
          l = m + s; r = m - s;
        }
        data[n] = l * gl;
        data[stride + n] = r * gr;
      }
      return;
    }
    if (ctx.ambisonic && p.width !== 1) {
      const w = p.width;
      for (let c = 1; c < nch; c++) {
        const o = c * stride;
        for (let n = n0; n < n1; n++) data[o + n] *= w;
      }
    }
    const gg = p.invL && p.invR ? -g : g;
    if (gg === 1) return;
    for (let c = 0; c < nch; c++) {
      const o = c * stride;
      for (let n = n0; n < n1; n++) data[o + n] *= gg;
    }
  }
}

function makeStage(id, nch) {
  switch (id) {
    case IMX_ITRM: return new ImxTrim();
    case IMX_EXPD: return new ImxExpander(nch);
    case IMX_EQU1: case IMX_EQU2: return new ImxEq(nch);
    case IMX_DEQ1: case IMX_DEQ2: return new ImxDeq(nch);
    case IMX_TSH1: return new ImxTransient(nch);
    case IMX_COMP: return new ImxComp(nch);
    case IMX_SATU: return new ImxSat(nch);
    case IMX_UNIS: return new ImxUnison(nch);
    case IMX_VERB: return new ImxVerb(nch);
    case IMX_DLAY: return new ImxDelay(nch);
    case IMX_LIMI: return new ImxLimiter(nch);
    case IMX_MXTL: return new ImxMixTool(nch);
    default: throw new Error(`imix: unknown equipment ${id}`);
  }
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * One bus's chain: the block's equipment in its pipeline's order, running
 * over that bus — one instrument's, or in bus mode every instrument's on the
 * block. Stateful; one per bus per playhead. `process` runs a span of the bus in place, and the result does not
 * depend on how the bus is cut into spans — every state, control counter and
 * phase is per sample.
 *
 * `nch` is the bus's width and `stereo` whether it is a left/right pair (a
 * stereo song, or the device's own render of a surround one) rather than a
 * speaker layout or an ambisonic scene; `ambisonic` whether it is the last
 * (channel 0 W, ACN order — an AmbiX export's, or the binaural monitor's).
 */
export class InstrumentChain {
  constructor(block, rate = SAMPLING_RATE, nch = 2, stereo = true, ambisonic = false) {
    this.rate = rate;
    this.nch = nch;
    this.stereo = stereo;
    this.ambisonic = ambisonic && !stereo && nch > 1;
    this.stages = new Map();   // id → stage, kept across setBlock
    this.active = [];          // [{id, stage, dry}] in pipeline order
    this.dryBuf = null;
    this.idle = true;
    this.silentRun = 0;
    this.idleAfter = 0;
    this.block = null;
    this.ctx = { nch, stereo, ambisonic: this.ambisonic, bpm: 125, dry: 0, dryBuf: null };
    this._stride = 0;
    /** The Mixing tab's tap while it meters this bus (else null): told the
     *  span each piece is about to process, so it can record what goes in. */
    this.probe = null;
    this.setBlock(block);
  }

  /** Install a block's settings. Delay lines and envelopes are kept, so a
   *  control moved during playback does not click. */
  setBlock(block) {
    const b = normaliseImixBlock(block);
    this.block = b;
    const order = IMX_PIPELINES[b.order] ?? IMX_PIPELINES[0];
    const was = new Set(this.active.map((a) => a.id));
    this.active = [];
    let memory = 0;
    for (const id of order) {
      const e = b.equipment[id];
      if (!e || e.bypass) continue;  // bypassed equipment is not processed at all
      let stage = this.stages.get(id);
      if (!stage) {
        stage = makeStage(id, this.nch);
        this.stages.set(id, stage);
      }
      stage.configure(e, this.rate);
      // A piece coming (back) into the chain starts clean: whatever it held
      // when it was bypassed is a different moment of the song.
      if (!was.has(id)) stage.reset();
      this.active.push({ id, stage, dry: IMX_WET_APPLICABLE.has(id) ? e.dry / 255 : 0 });
      memory += stage.memory;
    }
    this.idleAfter = memory + Math.round(IMX_IDLE_MARGIN_SEC * this.rate);
  }

  /** Clear every delay line, envelope and phase (a transport reset, §15). */
  reset() {
    for (const s of this.stages.values()) s.reset();
    this.idle = true;
    this.silentRun = 0;
  }

  /** A note of an instrument on this bus has started: phase-reset its
   *  retriggering LFOs. */
  noteOn() {
    const u = this.stages.get(IMX_UNIS);
    if (u && u.p) u.retrigger();
  }

  _buffers(stride) {
    if (this._stride !== stride || this.dryBuf === null) {
      this._stride = stride;
      this.dryBuf = new Float64Array(this.nch * stride);
      this.ctx.dryBuf = this.dryBuf;
    }
  }

  /**
   * Run [n0, n1) of the bus in place. `fed` says whether any voice wrote into
   * this span — a chain that is idle and was not fed does nothing at all (its
   * output is the zeros already in the buffer) except keep its LFOs in time.
   */
  process(data, stride, n0, n1, bpm, fed) {
    const nch = this.nch;
    const frames = n1 - n0;
    const ctx = this.ctx;
    ctx.bpm = bpm;
    if (this.idle) {
      // Wake on the first non-zero SAMPLE, not at the top of the span: where
      // a chain starts must not depend on where the span was cut. Before it,
      // an idle chain only keeps its LFOs in time.
      const m = fed ? firstSignal(data, nch, stride, n0, n1) : -1;
      if (m < 0) {
        for (const a of this.active) if (a.stage.skip) a.stage.skip(frames, ctx);
        return;
      }
      if (m > n0) for (const a of this.active) if (a.stage.skip) a.stage.skip(m - n0, ctx);
      n0 = m;
      this.idle = false;
      this.silentRun = 0;
    }
    this._buffers(stride);
    // The last non-zero input sample of the span: the idle rule needs it.
    let lastIn = -1;
    for (let n = n1 - 1; n >= n0 && lastIn < 0; n--) {
      for (let c = 0; c < nch; c++) if (data[c * stride + n] !== 0) { lastIn = n; break; }
    }
    const probe = this.probe;
    for (const a of this.active) {
      if (probe !== null) probe.stageIn(a.id, n0, n1);
      ctx.dry = a.dry;
      a.stage.process(data, stride, n0, n1, ctx);
    }
    // Idle rule: count the trailing run of samples that had no input AND
    // left the chain below the idle level, sample by sample, so where the
    // chain stops does not depend on where the span was cut.
    for (let n = n0; n < n1; n++) {
      let quiet = n > lastIn;
      if (quiet) {
        for (let c = 0; c < nch; c++) {
          const y = data[c * stride + n];
          if (y >= IMX_IDLE_LEVEL || y <= -IMX_IDLE_LEVEL) { quiet = false; break; }
        }
      }
      if (!quiet) { this.silentRun = 0; continue; }
      if (++this.silentRun >= this.idleAfter) {
        // Idle from the NEXT sample: clear state, and the rest of the span is
        // what a cleared chain fed silence produces — silence.
        for (let m = n + 1; m < n1; m++) for (let c = 0; c < nch; c++) data[c * stride + m] = 0;
        const remain = n1 - (n + 1);
        for (const s of this.stages.values()) s.reset();
        for (const a of this.active) if (a.stage.skip && remain > 0) a.stage.skip(remain, ctx);
        this.idle = true;
        this.silentRun = 0;
        break;
      }
    }
  }

  /** Gain-reduction readings of the span just processed (dB), for the meter:
   *  comp bands (≤ 0), the two dynamic EQs' bands (signed), the transient
   *  shaper's bands (signed, its output gain left out), the expander (≤ 0),
   *  the limiter (≤ 0);
   *  and the loudest detector reading of the expander and of every comp and
   *  dynamic-EQ band (dB,
   *  −120 = nothing), which is what each band's threshold is compared with. */
  readGr(out) {
    out.comp.fill(0); out.deq1.fill(0); out.deq2.fill(0); out.tsh1.fill(0); out.lim = 0;
    out.compLvl.fill(-120); out.deq1Lvl.fill(-120); out.deq2Lvl.fill(-120);
    out.expd = 0; out.expdLvl = -120;
    for (const a of this.active) {
      if (a.id === IMX_EXPD) { out.expd = a.stage.gr; out.expdLvl = a.stage.lvl; }
      if (a.id === IMX_COMP) { out.comp.set(a.stage.gr); out.compLvl.set(a.stage.lvl); }
      else if (a.id === IMX_TSH1) out.tsh1.set(a.stage.gr);
      else if (a.id === IMX_DEQ1) { out.deq1.set(a.stage.gr); out.deq1Lvl.set(a.stage.lvl); }
      else if (a.id === IMX_DEQ2) { out.deq2.set(a.stage.gr); out.deq2Lvl.set(a.stage.lvl); }
      else if (a.id === IMX_LIMI) out.lim = a.stage.gr;
    }
    return out;
  }

  /** The static magnitude response (dB) of the chain's equalisers, at `freq` —
   *  both static EQs, and both dynamic EQs at their current gains. The
   *  display's curve; the dynamics have no frequency response to draw. */
  responseDb(freq) {
    let db = 0;
    for (const a of this.active) {
      if (a.stage instanceof ImxEq || a.stage instanceof ImxDeq) db += a.stage.responseDb(freq, this.rate);
    }
    return db;
  }

  /** For a display copy: give piece `id` the dynamic gains the meter read
   *  (a dynamic EQ's or a transient shaper's signed band gains, a
   *  compressor's reductions; null = at rest) before stageResponseDb draws it. */
  showGains(id, gains) {
    const s = this.stages.get(id);
    if (s && s.p && s.showGains) s.showGains(gains);
  }

  /** One piece's own magnitude response at `freq` (dB): an equaliser's, a
   *  dynamic EQ's, a transient shaper's or a compressor's (at the gains
   *  showGains gave them). */
  stageResponseDb(id, freq) {
    const s = this.stages.get(id);
    if (!s || !s.responseDb) return 0;
    return s.responseDb(freq, this.rate);
  }

  /** The unison stage while it is in the chain (its curCents and curWidth
   *  are what its last control period set), or null. */
  unisonNow() {
    for (const a of this.active) if (a.id === IMX_UNIS) return a.stage;
    return null;
  }
}

/** The first frame in [n0, n1) with a non-zero sample on any channel, or −1. */
function firstSignal(data, nch, stride, n0, n1) {
  for (let n = n0; n < n1; n++) {
    for (let c = 0; c < nch; c++) if (data[c * stride + n] !== 0) return n;
  }
  return -1;
}

/** A gain-reduction readout object for InstrumentChain.readGr. */
export function makeImixGrReadout() {
  return {
    comp: new Float64Array(IMX_COMP_MAX_BANDS),
    deq1: new Float64Array(IMX_DEQ_BANDS),
    deq2: new Float64Array(IMX_DEQ_BANDS),
    tsh1: new Float64Array(IMX_TSH_MAX_BANDS),
    expd: 0, expdLvl: -120,
    lim: 0,
    compLvl: new Float64Array(IMX_COMP_MAX_BANDS).fill(-120),
    deq1Lvl: new Float64Array(IMX_DEQ_BANDS).fill(-120),
    deq2Lvl: new Float64Array(IMX_DEQ_BANDS).fill(-120),
  };
}

// ── Buses and routing ───────────────────────────────────────────────────────

/** Slots a route table covers: the 1024 bank slots and the audition slot. */
export const IMX_ROUTE_SLOTS = 1025;

/**
 * One bus on one playhead: a chunk of channel-major binary64 (stride
 * TRACKER_CHUNK) in the song's own channel layout — the stereo pair, or, in a
 * surround song, the object bus's channels, filled through a SpatialBus of the
 * same renderer so a voice lands in it exactly where it would have landed in
 * the master — and the chain that runs over it. A separate-mode block gives
 * every instrument naming it a bus of its own; a bus-mode block gives them ONE,
 * which `slots` lists, ascending — `slot` is the first of them, and the place
 * the bus takes in the mix.
 */
export class InstrumentBus {
  constructor(slot, block, master, rate) {
    this.slot = slot;
    this.slots = [slot];
    this.blockId = block.id;
    this.renderer = master === null ? null : master.renderer;
    if (master === null) {
      this.space = null;
      this.nch = 2;
      this.stereo = true;
      this.data = new Float64Array(2 * TRACKER_CHUNK);
    } else {
      this.space = new SpatialBus(master.renderer, TRACKER_CHUNK);
      this.nch = this.space.numChannels;
      // The device renders a surround song through a StereoRenderer: its two
      // channels ARE a left/right pair, and the stereo-only controls apply.
      this.stereo = this.nch === 2 && master.renderer.name === "stereo";
      this.data = this.space.data;
    }
    const scene = master !== null && /^(ambisonic|binaural)/.test(master.renderer.name);
    this.chain = new InstrumentChain(block, rate, this.nch, this.stereo, scene);
    /** Did any voice write into the current span? */
    this.fed = false;
  }

  /** Zero frames [n0, n1) of every channel. */
  clear(n0, n1) {
    const d = this.data;
    for (let c = 0; c < this.nch; c++) d.fill(0, c * TRACKER_CHUNK + n0, c * TRACKER_CHUNK + n1);
    this.fed = false;
  }
}

/**
 * Rebuild a playhead's route table from the engine's blocks and instruments.
 * A slot gets a bus when its record names a block that exists and is engaged
 * (imixBlockEngaged); every other slot routes nowhere and its voices take the
 * plain path. In bus mode the first slot naming the block makes the bus and
 * every later one joins it. A bus that survives — same first slot, same layout
 * — keeps its chain and is only re-set, so editing a block while the song plays
 * keeps the reverb's tail ringing (switching a block's mode included: the first
 * slot's bus carries on either way).
 */
export function syncImixRoutes(eng, ts) {
  ts.imixGen = eng.imixGen;
  ts.imixRate = SAMPLING_RATE;
  const master = ts.spatial;
  const old = ts.imixBuses;
  const next = new Map();
  const shared = new Map(); // bus-mode block id → its bus
  for (let slot = 1; slot < 1024; slot++) {
    const id = eng.instruments[slot].imixId;
    if (id === 0) continue;
    const block = eng.imixBlocks.get(id);
    if (block === undefined || !imixBlockEngaged(block)) continue;
    if (block.bus) {
      const joined = shared.get(id);
      if (joined !== undefined) {
        joined.slots.push(slot);
        continue;
      }
    }
    let bus = old.get(slot);
    if (bus !== undefined && bus.renderer === (master === null ? null : master.renderer) &&
        bus.chain.rate === SAMPLING_RATE) {
      bus.blockId = id;
      bus.chain.setBlock(block);
    } else {
      bus = new InstrumentBus(slot, block, master, SAMPLING_RATE);
    }
    bus.slots = [slot];
    if (block.bus) shared.set(id, bus);
    next.set(slot, bus);
  }
  ts.imixBuses = next;
  ts.imixRoutes.fill(null);
  ts.imixList = [];
  for (const bus of next.values()) {
    for (const s of bus.slots) ts.imixRoutes[s] = bus;
    ts.imixList.push(bus);
  }
  // Ascending slot order: the order the buses join the mix is part of the sum.
  ts.imixList.sort((a, b) => a.slot - b.slot);
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

// ── The Mixing tab's meter tap ──────────────────────────────────────────────

/** Frames in the tap's rings — one spectrometer window. */
export const IMX_RING_FRAMES = 2048;
export const IMX_TAP_PRE = 0;
export const IMX_TAP_POST = 1;
/** The pieces whose INPUT the tap also rings (mono), for the spectra drawn
 *  inside their units — in this order in the readout and the snapshot. */
export const IMX_TAP_STAGES = Object.freeze([IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2]);

/**
 * Fold one frame of a bus to the stereo pair the meters read: the pair itself,
 * a speaker layout's own monitor fold (stateless), or — for an ambisonic or a
 * binaural scene — the coincident cardioid pair W ± Y. The binaural renderer's
 * own decode is NOT called: it keeps a convolution history that belongs to the
 * master bus.
 */
function imxMeterPair(bus, n, out) {
  const d = bus.data;
  if (bus.space === null || bus.stereo || bus.nch === 2) {
    out[0] = d[n]; out[1] = d[TRACKER_CHUNK + n];
  } else if (bus.renderer.name.startsWith("speakers")) {
    bus.renderer.monitorStereo(d, TRACKER_CHUNK, n, out);
  } else {
    const w = d[n], y = d[TRACKER_CHUNK + n];
    out[0] = 0.5 * (w + y); out[1] = 0.5 * (w - y);
  }
  return out;
}

/**
 * What the Mixing tab draws for ONE instrument's bus: level figures on both
 * sides of the chain (peak, true peak, energy, samples at full scale), the
 * chain's gain reductions, a stereo ring after the chain (goniometer and
 * spectrometer) and a mono ring before it (the spectrometer's comparison);
 * a mono ring at the input of each IMX_TAP_STAGES piece (the chain's probe —
 * a piece out of circuit leaves its ring as it was), and the unison's
 * detune and width. Like every tap here it exists only while the view that
 * reads it is up.
 */
export class ImixMeterTap {
  constructor(slot) {
    this.slot = slot;
    this.ring = new Float32Array(IMX_RING_FRAMES * 2);
    this.ringPre = new Float32Array(IMX_RING_FRAMES);
    this.write = 0;
    this.probes = [new TruePeakProbe(), new TruePeakProbe(), new TruePeakProbe(), new TruePeakProbe()];
    this.peak = new Float64Array(4);
    this.truePeak = new Float64Array(4);
    this.sumSq = new Float64Array(4);
    this.clip = new Float64Array(4);
    this.frames = 0;
    this.gr = makeImixGrReadout();
    this.grSpan = makeImixGrReadout();
    this._pair = [0, 0];
    this._preWrite = 0;
    this.stageRings = IMX_TAP_STAGES.map(() => new Float32Array(IMX_RING_FRAMES));
    this.stageWrite = new Int32Array(IMX_TAP_STAGES.length);
    this._bus = null;
    this.unisLive = false;
    this.unisCents = 0;
    this.unisWidth = 0;
  }
  resetAll() {
    this.ring.fill(0); this.ringPre.fill(0);
    for (const r of this.stageRings) r.fill(0);
    this.stageWrite.fill(0);
    this.write = 0; this._preWrite = 0;
    for (const p of this.probes) p.reset();
    this._clearInterval();
  }
  _clearInterval() {
    this.peak.fill(0); this.truePeak.fill(0); this.sumSq.fill(0); this.clip.fill(0);
    this.frames = 0;
    this.gr.comp.fill(0); this.gr.deq1.fill(0); this.gr.deq2.fill(0); this.gr.tsh1.fill(0); this.gr.lim = 0;
    this.gr.expd = 0; this.gr.expdLvl = -120;
    this.gr.compLvl.fill(-120); this.gr.deq1Lvl.fill(-120); this.gr.deq2Lvl.fill(-120);
    this.unisLive = false;
  }
  _stage(stage, bus, n0, n1) {
    const pair = this._pair;
    const base = stage * 2;
    for (let n = n0; n < n1; n++) {
      imxMeterPair(bus, n, pair);
      for (let c = 0; c < 2; c++) {
        const x = pair[c];
        const a = x < 0 ? -x : x;
        const i = base + c;
        if (a > this.peak[i]) this.peak[i] = a;
        const tp = this.probes[i].push(x);
        if (tp > this.truePeak[i]) this.truePeak[i] = tp;
        this.sumSq[i] += x * x;
        if (a >= 1) this.clip[i]++;
      }
      if (stage === IMX_TAP_POST) {
        const w = this.write;
        this.ring[w * 2] = pair[0];
        this.ring[w * 2 + 1] = pair[1];
        this.write = (w + 1) & (IMX_RING_FRAMES - 1);
      } else {
        this.ringPre[this._preWrite] = (pair[0] + pair[1]) * 0.5;
        this._preWrite = (this._preWrite + 1) & (IMX_RING_FRAMES - 1);
      }
    }
  }
  /** The bus as it enters the chain. */
  pushPre(bus, n0, n1) { this._bus = bus; this._stage(IMX_TAP_PRE, bus, n0, n1); }
  /** The chain's probe: piece `id` is about to process [n0, n1) of the bus. */
  stageIn(id, n0, n1) {
    const k = IMX_TAP_STAGES.indexOf(id);
    if (k < 0 || this._bus === null) return;
    const ring = this.stageRings[k];
    const pair = this._pair;
    let w = this.stageWrite[k];
    for (let n = n0; n < n1; n++) {
      imxMeterPair(this._bus, n, pair);
      ring[w] = (pair[0] + pair[1]) * 0.5;
      w = (w + 1) & (IMX_RING_FRAMES - 1);
    }
    this.stageWrite[k] = w;
  }
  /** …and as it leaves, with the chain's gain reductions over the span. */
  pushPost(bus, n0, n1) {
    this._stage(IMX_TAP_POST, bus, n0, n1);
    this.frames += n1 - n0;
    const g = bus.chain.readGr(this.grSpan);
    const gr = this.gr;
    for (let i = 0; i < g.comp.length; i++) if (g.comp[i] < gr.comp[i]) gr.comp[i] = g.comp[i];
    for (let i = 0; i < g.deq1.length; i++) {
      if (Math.abs(g.deq1[i]) > Math.abs(gr.deq1[i])) gr.deq1[i] = g.deq1[i];
      if (Math.abs(g.deq2[i]) > Math.abs(gr.deq2[i])) gr.deq2[i] = g.deq2[i];
    }
    for (let i = 0; i < g.tsh1.length; i++) if (Math.abs(g.tsh1[i]) > Math.abs(gr.tsh1[i])) gr.tsh1[i] = g.tsh1[i];
    if (g.lim < gr.lim) gr.lim = g.lim;
    if (g.expd < gr.expd) gr.expd = g.expd;
    if (g.expdLvl > gr.expdLvl) gr.expdLvl = g.expdLvl;
    for (const k of ["compLvl", "deq1Lvl", "deq2Lvl"]) {
      const a = g[k], b = gr[k];
      for (let i = 0; i < a.length; i++) if (a[i] > b[i]) b[i] = a[i];
    }
    const u = bus.chain.unisonNow();
    if (u !== null) { this.unisLive = true; this.unisCents = u.curCents; this.unisWidth = u.curWidth; }
  }
  /** Hand the interval's figures to `out` and start the next interval. */
  drain(out) {
    out.slot = this.slot;
    out.frames = this.frames;
    out.write = this.write;
    out.peak.set(this.peak); out.truePeak.set(this.truePeak);
    for (let i = 0; i < 4; i++) out.meanSquare[i] = this.frames > 0 ? this.sumSq[i] / this.frames : 0;
    out.clip.set(this.clip);
    out.comp.set(this.gr.comp); out.deq1.set(this.gr.deq1); out.deq2.set(this.gr.deq2);
    out.tsh1.set(this.gr.tsh1);
    out.expd = this.gr.expd; out.expdLvl = this.gr.expdLvl;
    out.lim = this.gr.lim;
    out.compLvl.set(this.gr.compLvl); out.deq1Lvl.set(this.gr.deq1Lvl); out.deq2Lvl.set(this.gr.deq2Lvl);
    out.ring = this.ring;
    out.ringPre = this.ringPre;
    out.unisCents = this.unisLive ? this.unisCents : -1;
    out.unisWidth = this.unisWidth;
    out.stageWrite.set(this.stageWrite);
    out.stageRings = this.stageRings;
    this._clearInterval();
    return out;
  }
}

/** A reusable readout for ImixMeterTap.drain. */
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
