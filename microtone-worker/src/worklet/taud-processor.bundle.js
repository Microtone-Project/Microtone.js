// GENERATED FILE — do not edit. Rebuild with: node tools/make-worklet-bundle.js
// Single-file concat of src/engine/* + src/worklet/* for non-module AudioWorklets.
"use strict";

// ══ src/engine/constants.js ══
// Taud engine constants — port of AudioAdapter.kt companion object (scalar part).
// Source: tsvm_core/src/net/torvald/tsvm/peripheral/AudioAdapter.kt:149-250
// Lookup tables (sinc, SNES gauss, Amiga filter coefficients) live in tables.js.

// ── Output sampling rate (web item 108) ───────────────────────────────────
// DELIBERATE web divergence from Kotlin's fixed 32000. Browsers run their
// AudioContext at 48 kHz, so a 32 kHz engine had to be resampled on the way
// out — for playback AND for the default 48 kHz WAV export. Rendering at
// 48 kHz deletes that stage from both default paths: at a 48 kHz context the
// worklet's read cursor steps by exactly 1.0 and one TRACKER_CHUNK is exactly
// one render quantum.
//
// Everything rate-derived (tick length, the IT/SF2 filter coefficients, the
// Amiga LPF/LED coefficients, the anti-click ramps) is computed FROM this
// value, so the audible parameters stay where they are in Hz and in
// milliseconds — what changes is that they are now realised on a 48 kHz grid.
//
// It is a `let`, not a const: setSamplingRate() below puts the engine back on
// 32 kHz for the JVM-oracle conformance tests and the Kotlin-mirroring
// scenario tests, which compare against 32 kHz reference renders. Set it ONCE
// before rendering — like rng.js's seed, it is start-up configuration, not a
// per-render parameter.
let SAMPLING_RATE = 48000;
// Batch length of the mixer's per-sample loop. Tick/row timing is per-SAMPLE
// (mixer.js `samplesIntoTick`), so this is pure batching granularity and does
// NOT affect output — verified bit-exact vs the 512 baseline on the whole
// deterministic corpus. DELIBERATE web divergence from Kotlin's 512: the
// AudioWorklet must finish each render inside one ~2.67 ms quantum, and a 512-
// frame (16 ms) block renders in one burst that overruns the callback on slower
// devices (iPad: 5–14 ms/block → xruns); 128 spreads it evenly under budget.
const TRACKER_CHUNK = 128;

// Per-voice soundscope ring-buffer length. Power of two so wrap-around is a single AND.
const SCOPE_BUFFER_SIZE = 2048;

// Mixer-private background-voice pool size per playhead. NNA "Continue/Note Off/Note Fade"
// ghosts displaced foreground voices into this pool; oldest is evicted on overflow.
const MAX_BG_VOICES = 64;

const MIDDLE_C = 0x5000; // reference C for instrument samplingRate (terranmon.txt:2000)

// Amiga period at MIDDLE_C for a standard 8363 Hz instrument (NTSC clock 3579545 Hz).
const AMIGA_BASE_PERIOD = 428.0;

// Reference frequency for linear-freq tone mode (toneMode == 2): 12-TET A4 = 440 Hz.
const LINEAR_FREQ_C4_HZ = 261.6255653005986;

// ── Song tuning (terranmon.txt:3297-3324, §"Note Tuning"; web item 77) ──
// The song table declares "note TUNING base note sounds at TUNING freq Hz";
// tuningRatioOf() (tables.js) folds that pair into the playback-rate multiplier.
//
// Zero point: 12-TET concert C4, i.e. the same A4 = 440 the linear-freq mode
// references — numerically LINEAR_FREQ_C4_HZ, kept as its own name because it
// answers a different question (that one is the toneMode==2 slide reference,
// this one is where "no retune" sits).
const TUNING_REF_C4_HZ = LINEAR_FREQ_C4_HZ;

// Field defaults for a zero/blank song table — spec: "If zero, assume the
// tracker default value". C9 @ 8363 Hz is the Amiga/tracker convention, which
// is NOT concert pitch: it puts A4 at 439.53 Hz, ~1.87 cents flat of 440. The
// spec quotes 439.548 Hz for the reference tuning from the exact NTSC clock
// ratio (3579545/428 = 8363.42 Hz); the format stores the rounded 8363.0, so
// the honest reading of a default song table lands 0.09 cents below that quote.
const TUNING_DEFAULT_BASE_NOTE = 0xa000; // C9
const TUNING_DEFAULT_FREQ_HZ = 8363.0;

// Anti-click ramp-out on sample end/cut: 8 ms (256 samples at Kotlin's 32 kHz).
let RAMP_OUT_SAMPLES = 384;
const RAMP_OUT_SEC = 0.008;

// Fast note-fade (note word 0x0004): SF2 exclusiveClass choke, ≈ FluidSynth's
// GEN_VOLENVRELEASE = -2000 timecents.
const FAST_FADE_SEC = 0.3;

// Volume-change anti-click ramp: 2 ms (64 samples at Kotlin's 32 kHz).
// Bypassed on fresh note triggers.
let VOL_RAMP_SAMPLES = 96;
const VOL_RAMP_SEC = 0.002;

// Volume ramp for Attack (item 139): every fresh note trigger fades IN over this
// many samples on a half-cosine curve, 0 -> unity, instead of stepping straight to
// full gain. 32 samples at 48 kHz (~0.67 ms) is the reference figure the constant
// is named for; ATTACK_RAMP_SEC carries it to other rates the same way RAMP_OUT_SEC
// and VOL_RAMP_SEC do.
let ATTACK_RAMP_SAMPLES = 32;
const ATTACK_RAMP_SEC = 32 / 48000;

// Pitch-glide budget (item 144). The per-sample pitch glide spreads a tick's
// pitch change across the tick, which is what a CONTROL move wants — a vibrato
// or an ordinary slide moves a cent or two per tick and the spreading is what
// removes the staircase. An EVENT does not: an arpeggio step or a fast tone
// portamento arriving is meant to be at its new pitch NOW, and a tick-long bend
// across it is heard as a bend. So the glide's budget is (interval × time), not
// time: a move this wide is given the whole tick, and anything wider gets
// proportionally less of one (sampler.js pitchGlideSamples), never below the
// attack ramp's ~⅔ ms. The figure is 25 cents — an eighth of a 12-TET semitone,
// wider than any vibrato or slide moves between ticks, narrower than the
// smallest interval a listener would call a note change.
//
// It is stated as the frequency RATIO's excess over unity, 2^(25/1200) − 1,
// written out rather than computed: the glide's length has to agree bit-for-bit
// across implementations, and the spec's rule against logarithm round trips
// (TAUD_ENGINE_SPEC.md §3.3) applies here too. Comparing ratios keeps the whole
// decision on IEEE divides, which do agree everywhere.
const PITCH_GLIDE_FULL_RATIO = 0.014545334937523746;

// Modules whose load-time tables are rate-derived (tables.js's Amiga filter
// coefficients) register here so setSamplingRate can rebuild them. Coefficients
// computed per call — the IT/SF2 voice filters — need no registration.
const rateListeners = new Set();

/** Register a rebuild callback; it fires on every later setSamplingRate. */
function onSamplingRateChange(fn) {
  rateListeners.add(fn);
  return fn;
}

/**
 * Move the engine's output rate. Call BEFORE constructing an engine: voices
 * already carrying ramp counters or filter state keep the old rate's numbers.
 * Rebuilds every rate-derived table, so the Amiga low-pass stays at 4421 Hz
 * and the anti-click ramps stay at 8 ms / 2 ms whatever the rate.
 */
function setSamplingRate(rate) {
  SAMPLING_RATE = rate;
  RAMP_OUT_SAMPLES = Math.round(RAMP_OUT_SEC * rate);
  VOL_RAMP_SAMPLES = Math.round(VOL_RAMP_SEC * rate);
  ATTACK_RAMP_SAMPLES = Math.round(ATTACK_RAMP_SEC * rate);
  for (const fn of rateListeners) fn(rate);
}

// Sample bin: 8 MB total (banking is a device-protocol concern; the JS engine
// addresses the pool directly, as the Kotlin playback path does).
const SAMPLE_BANK_SIZE = 524288;
const SAMPLE_BANK_COUNT = 16;
const SAMPLE_BIN_TOTAL = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT;

// Channels / voices. Physical voice & cue storage is always sized MAX_VOICES;
// 32-channel playback leaves the upper half inactive.
const NUM_VOICES = 32;
const MAX_VOICES = 64;

// Dedicated audition ("jam") voices, above every addressable song channel.
// JS-only — the Kotlin device jams on a song channel, which is exactly what
// item 140 is about: an audition on a channel is silenced by that channel's
// mute, it hijacks whatever the song is playing there, and one channel can only
// hold one note, so a held chord collapses to its last key. These slots belong
// to no channel, so the desk never mutes them and the song never writes to
// them; the row loop stops at channelCount() while the tick and mix loops walk
// the whole array, so they play but are never played TO.
const JAM_VOICES = 16;
const JAM_VOICE_BASE = MAX_VOICES;
const TOTAL_VOICES = MAX_VOICES + JAM_VOICES;
const NUM_CUES = 8192;
const CUE_BYTES = NUM_VOICES * 2;    // 64 bytes / cue (32-ch)
const CUE_BYTES_64 = MAX_VOICES * 2; // 128 bytes / cue (64-ch)

// Pattern store: 15-bit pattern numbers; 0x7FFF = "no pattern on this channel".
const NUM_PATTERNS = 0x7fff;
const PATTERN_EMPTY = 0x7fff;

// ── Cell layouts (file format version) ──
// Versions 1-2 carry an 8-byte pattern cell; version 3 — the surround format —
// carries 16, which is what buys the 8-bit volume column, the spherical panning
// column and a second effect. It is a whole-FILE property, so the engine holds
// one flag and every pattern in it is the same width.
const ROWS_PER_PATTERN = 64;
const CELL_BYTES = 8;
const CELL_BYTES_WIDE = 16;
const PATTERN_BYTES = ROWS_PER_PATTERN * CELL_BYTES;          // 512
const PATTERN_BYTES_WIDE = ROWS_PER_PATTERN * CELL_BYTES_WIDE; // 1024

/** Volume ceiling per cell format: 6-bit columns, or v3's 8-bit ones. */
const VOLUME_MAX = 0x3f;
const VOLUME_MAX_WIDE = 0xff;
/** What a 6-bit-derived delta (a nibble slide, a tremolo depth) is worth. */
const VOLUME_STEP_WIDE = 4;

// Interpolation modes (TAUD_NOTE_EFFECTS.md §1, bits 2-4 of global behaviour flags).
const INTERP_DEFAULT = 0;
const INTERP_NONE = 1;
const INTERP_A500 = 2;
const INTERP_A1200 = 3;
const INTERP_SNES = 4;
const INTERP_NES_DPCM = 5;

// Fast Sinc kernel geometry (table itself is generated in tables.js).
const SINC_WIDTH = 3;
const SINC_PRECISION_SHIFT = 10;
const SINC_PRECISION = 1 << SINC_PRECISION_SHIFT; // 1024

// Note-word sentinels (terranmon.txt:3040-3049).
const NOTE_NOP = 0x0000;
const NOTE_KEY_OFF = 0x0001;
const NOTE_CUT = 0x0002;
const NOTE_FADE = 0x0003;
const NOTE_FAST_FADE = 0x0004;
const NOTE_INT_FIRST = 0x0010; // Int0..IntF interrupt notes
const NOTE_INT_LAST = 0x001f;
const NUM_INTERRUPTS = 16;

// ══ src/engine/minifloat.js ══
// ThreeFiveMiniUfloat — port of tsvm_core/src/net/torvald/tsvm/ThreeFiveMinifloat.kt.
// 3.5 unsigned minifloat (3-bit exponent + 5-bit mantissa) scaled so the smallest
// non-zero step is 1/256 s ≈ 3.91 ms and the max is 15.75 s. Used for Taud
// envelope point offsets.
//
// The LUT is generated by the minifloat formula (e = i>>5, m = i&31;
// denormal e=0 → m/256, else (32+m)·2^(e−1)/256) — values are exact binary
// fractions, so this reproduces the Kotlin float LUT bit-exactly.

const MINIFLOAT_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const e = i >> 5;
  const m = i & 31;
  MINIFLOAT_LUT[i] = e === 0 ? m / 256 : ((32 + m) * 2 ** (e - 1)) / 256;
}

function minifloatToDouble(index) {
  return MINIFLOAT_LUT[index & 0xff];
}

// fromFloatToIndex (ThreeFiveMinifloat.kt:24-27): binary-search the interval,
// then "round to nearest even" — if the lower bound index is even take it,
// else take the upper bound. Ported verbatim, quirk included.
function minifloatFromDouble(fval) {
  let low = 0;
  let high = MINIFLOAT_LUT.length - 1;
  let llim, hlim;
  for (;;) {
    if (low > high) {
      llim = Math.max(high, 0);
      hlim = Math.min(low, MINIFLOAT_LUT.length - 1);
      break;
    }
    const mid = (low + high) >>> 1;
    const midVal = MINIFLOAT_LUT[mid];
    if (fval < midVal) high = mid - 1;
    else if (fval > midVal) low = mid + 1;
    else { llim = mid; hlim = mid; break; }
  }
  return llim % 2 === 0 ? llim : hlim;
}

// ══ src/engine/rng.js ══
// Randomness seams for the Taud engine. No engine file may call Math.random
// directly — everything routes through here so conformance tests can seed it.
//
// Two independent streams, mirroring AudioAdapter.kt:
//  - xorshift32: the noise-shaped dither PRNG in pcm32fToPcm8 (deterministic,
//    seeded constant per adapter instance — AudioAdapter.kt:1199-1214)
//  - random(): Math.random uses — vol/pan swing at trigger (2593-2597) and the
//    random LFO waveform 3 (1432). Musically intended nondeterminism in
//    production; injectable for tests.

function makeXorshift32(seed = 0x9e3779b9) {
  let x = seed >>> 0;
  return function xorshift32() {
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x = x >>> 0;
    return x;
  };
}

// Injectable uniform [0,1) source.
let _random = Math.random;

function random() {
  return _random();
}

/** Replace the uniform source (pass null to restore Math.random). */
function setRandomSource(fn) {
  _random = fn ?? Math.random;
}

/** Simple seedable mulberry32 for tests. */
function makeSeededRandom(seed = 1) {
  let a = seed >>> 0;
  return function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ══ src/engine/tables.js ══
// Lookup tables + pitch math — port of AudioAdapter.kt companion object tables
// (149-340), MOD_SIN_TABLE / FINETUNE_OFFSET (1406-1422), META_MIX_GAIN (1480),
// EffectOp (1438), lfoSample (1426), pitch conversions (1632-1690).



// ── Fast Sinc: 6-tap windowed sinc, 1024 sub-sample positions (251-273) ──
const SINC_TABLE = (() => {
  const n = SINC_PRECISION * SINC_WIDTH;
  const out = new Float64Array(n);
  const winFreq = Math.PI / SINC_WIDTH / SINC_PRECISION;
  out[0] = 1.0;
  for (let i = 1; i < n; i++) {
    const t = (i * Math.PI) / SINC_PRECISION;
    const win = 0.5 + 0.5 * Math.cos(winFreq * i);
    out[i] = (Math.sin(t) / t) * win;
  }
  return out;
})();

/** Windowed-sinc kernel value for fractional offset frac ∈ [0,1) and signed tap. */
function sincTap(frac, tap) {
  const x = (tap - frac) * SINC_PRECISION;
  const ax = Math.abs(x);
  const idx = Math.trunc(ax);
  if (idx >= SINC_PRECISION * SINC_WIDTH - 1) return 0.0;
  const f = ax - idx;
  return SINC_TABLE[idx] * (1.0 - f) + SINC_TABLE[idx + 1] * f;
}

// ── SNES BRR 4-tap gaussian table (512 entries; AudioAdapter.kt:283-316) ──
// The quad {gauss[i], gauss[0xff-i], gauss[0x100+i], gauss[0x1ff-i]} is meant to
// sum to 0x800 but the ROM is slightly bugged and lands on 0x7ff..0x801 (0x7ff at
// 42 phases, 0x800 at 168, 0x801 at 46). The 0x801 phases are the ones that can
// overrun int16 on rail-level input, and the DSP lets that partial sum WRAP —
// the famous "SNES gauss overflow chirp". See sampler.js INTERP_SNES.
const SNES_GAUSS = Int32Array.from([
  0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
  0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
  0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
  0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00a, 0x00a, 0x00a,
  0x00b, 0x00b, 0x00b, 0x00c, 0x00c, 0x00d, 0x00d, 0x00e, 0x00e, 0x00f, 0x00f, 0x00f, 0x010, 0x010, 0x011, 0x011,
  0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01a, 0x01b, 0x01b,
  0x01c, 0x01d, 0x01d, 0x01e, 0x01f, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
  0x029, 0x02a, 0x02b, 0x02c, 0x02d, 0x02e, 0x02f, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
  0x03a, 0x03b, 0x03c, 0x03d, 0x03e, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04a, 0x04c, 0x04d,
  0x04e, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05a, 0x05c, 0x05e, 0x05f, 0x061, 0x063, 0x064, 0x066,
  0x068, 0x06a, 0x06b, 0x06d, 0x06f, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07a, 0x07c, 0x07e, 0x080, 0x082, 0x084,
  0x086, 0x089, 0x08b, 0x08d, 0x08f, 0x091, 0x093, 0x096, 0x098, 0x09a, 0x09c, 0x09f, 0x0a1, 0x0a3, 0x0a6, 0x0a8,
  0x0ab, 0x0ad, 0x0af, 0x0b2, 0x0b4, 0x0b7, 0x0ba, 0x0bc, 0x0bf, 0x0c1, 0x0c4, 0x0c7, 0x0c9, 0x0cc, 0x0cf, 0x0d2,
  0x0d4, 0x0d7, 0x0da, 0x0dd, 0x0e0, 0x0e3, 0x0e6, 0x0e9, 0x0ec, 0x0ef, 0x0f2, 0x0f5, 0x0f8, 0x0fb, 0x0fe, 0x101,
  0x104, 0x107, 0x10b, 0x10e, 0x111, 0x114, 0x118, 0x11b, 0x11e, 0x122, 0x125, 0x129, 0x12c, 0x130, 0x133, 0x137,
  0x13a, 0x13e, 0x141, 0x145, 0x148, 0x14c, 0x150, 0x153, 0x157, 0x15b, 0x15f, 0x162, 0x166, 0x16a, 0x16e, 0x172,
  0x176, 0x17a, 0x17d, 0x181, 0x185, 0x189, 0x18d, 0x191, 0x195, 0x19a, 0x19e, 0x1a2, 0x1a6, 0x1aa, 0x1ae, 0x1b2,
  0x1b7, 0x1bb, 0x1bf, 0x1c3, 0x1c8, 0x1cc, 0x1d0, 0x1d5, 0x1d9, 0x1dd, 0x1e2, 0x1e6, 0x1eb, 0x1ef, 0x1f3, 0x1f8,
  0x1fc, 0x201, 0x205, 0x20a, 0x20f, 0x213, 0x218, 0x21c, 0x221, 0x226, 0x22a, 0x22f, 0x233, 0x238, 0x23d, 0x241,
  0x246, 0x24b, 0x250, 0x254, 0x259, 0x25e, 0x263, 0x267, 0x26c, 0x271, 0x276, 0x27b, 0x280, 0x284, 0x289, 0x28e,
  0x293, 0x298, 0x29d, 0x2a2, 0x2a6, 0x2ab, 0x2b0, 0x2b5, 0x2ba, 0x2bf, 0x2c4, 0x2c9, 0x2ce, 0x2d3, 0x2d8, 0x2dc,
  0x2e1, 0x2e6, 0x2eb, 0x2f0, 0x2f5, 0x2fa, 0x2ff, 0x304, 0x309, 0x30e, 0x313, 0x318, 0x31d, 0x322, 0x326, 0x32b,
  0x330, 0x335, 0x33a, 0x33f, 0x344, 0x349, 0x34e, 0x353, 0x357, 0x35c, 0x361, 0x366, 0x36b, 0x370, 0x374, 0x379,
  0x37e, 0x383, 0x388, 0x38c, 0x391, 0x396, 0x39b, 0x39f, 0x3a4, 0x3a9, 0x3ad, 0x3b2, 0x3b7, 0x3bb, 0x3c0, 0x3c5,
  0x3c9, 0x3ce, 0x3d2, 0x3d7, 0x3dc, 0x3e0, 0x3e5, 0x3e9, 0x3ed, 0x3f2, 0x3f6, 0x3fb, 0x3ff, 0x403, 0x408, 0x40c,
  0x410, 0x415, 0x419, 0x41d, 0x421, 0x425, 0x42a, 0x42e, 0x432, 0x436, 0x43a, 0x43e, 0x442, 0x446, 0x44a, 0x44e,
  0x452, 0x455, 0x459, 0x45d, 0x461, 0x465, 0x468, 0x46c, 0x470, 0x473, 0x477, 0x47a, 0x47e, 0x481, 0x485, 0x488,
  0x48c, 0x48f, 0x492, 0x496, 0x499, 0x49c, 0x49f, 0x4a2, 0x4a6, 0x4a9, 0x4ac, 0x4af, 0x4b2, 0x4b5, 0x4b7, 0x4ba,
  0x4bd, 0x4c0, 0x4c3, 0x4c5, 0x4c8, 0x4cb, 0x4cd, 0x4d0, 0x4d2, 0x4d5, 0x4d7, 0x4d9, 0x4dc, 0x4de, 0x4e0, 0x4e3,
  0x4e5, 0x4e7, 0x4e9, 0x4eb, 0x4ed, 0x4ef, 0x4f1, 0x4f3, 0x4f5, 0x4f6, 0x4f8, 0x4fa, 0x4fb, 0x4fd, 0x4ff, 0x500,
  0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50a, 0x50b, 0x50c, 0x50d, 0x50e, 0x50f, 0x510, 0x511, 0x511, 0x512,
  0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519,
]);

// ── Amiga filter coefficients (AudioAdapter.kt:318-339) ──
// Kotlin precomputes these at its fixed 32 kHz; the web engine's rate is
// settable (item 108), so they are recomputed whenever it moves — the cutoffs
// below are the physical RC/Sallen-Key corner frequencies of the real hardware
// and must land on the same Hz at any output rate.
const AMIGA_A500_LP_FC = 4420.971;
const AMIGA_LED_FC = 3090.533;
const AMIGA_LED_Q = 0.660225;

let AMIGA_A500_B1, AMIGA_A500_A0;
let AMIGA_LED_A1, AMIGA_LED_A2, AMIGA_LED_B1, AMIGA_LED_B2;

function rebuildAmigaCoeffs(rate) {
  AMIGA_A500_B1 = Math.exp((-2.0 * Math.PI * AMIGA_A500_LP_FC) / rate);
  AMIGA_A500_A0 = 1.0 - AMIGA_A500_B1;

  const aBase = 1.0 / Math.tan((Math.PI * AMIGA_LED_FC) / rate);
  const bBase = 1.0 / AMIGA_LED_Q;
  AMIGA_LED_A1 = 1.0 / (1.0 + bBase * aBase + aBase * aBase);
  AMIGA_LED_A2 = 2.0 * AMIGA_LED_A1;
  AMIGA_LED_B1 = 2.0 * (1.0 - aBase * aBase) * AMIGA_LED_A1;
  AMIGA_LED_B2 = (1.0 - bBase * aBase + aBase * aBase) * AMIGA_LED_A1;
}
rebuildAmigaCoeffs(SAMPLING_RATE);
onSamplingRateChange(rebuildAmigaCoeffs);

// ── 64-entry signed sine table (OpenMPT-style; 1407) ──
const MOD_SIN_TABLE = Int32Array.from([
  0x00, 0x0c, 0x19, 0x25, 0x31, 0x3c, 0x47, 0x51,
  0x5a, 0x62, 0x6a, 0x70, 0x75, 0x7a, 0x7d, 0x7e,
  0x7f, 0x7e, 0x7d, 0x7a, 0x75, 0x70, 0x6a, 0x62,
  0x5a, 0x51, 0x47, 0x3c, 0x31, 0x25, 0x19, 0x0c,
  0x00, -0x0c, -0x19, -0x25, -0x31, -0x3c, -0x47, -0x51,
  -0x5a, -0x62, -0x6a, -0x70, -0x75, -0x7a, -0x7d, -0x7e,
  -0x7f, -0x7e, -0x7d, -0x7a, -0x75, -0x70, -0x6a, -0x62,
  -0x5a, -0x51, -0x47, -0x3c, -0x31, -0x25, -0x19, -0x0c,
]);

// ── ST3-style fine-tune offsets in 4096-TET units (S $2x00; 1419) ──
const FINETUNE_OFFSET = Int32Array.from([
  -0x0154, -0x0132, -0x0111, -0x00e4, -0x00b8, -0x008b, -0x005d, -0x003b,
  0x0000, 0x0023, 0x0046, 0x0074, 0x0098, 0x00c8, 0x00f9, 0x0110,
]);

// ── The command LFOs' phase (H, U, R, Y) ────────────────────────────────
// 64 table entries × 17 steps each. The 17 is not arbitrary and the total is
// deliberately not a power of two: every 4-bit tracker field converts into
// Taud by NIBBLE-REPEAT, which multiplies by 17, so a phase whose step count
// carries that same factor makes a converted speed byte reproduce the source
// tracker's oscillator EXACTLY rather than approximately.
//
// A tracker advances an 8-bit phase by `speed × 4` and indexes `(pos >> 2) &
// 63`, giving index `x·t mod 64` at tick t. Here a converted byte `17x`
// advances by `17x` through 1088 and indexes `pos / 17`, giving
// `(17·x·t mod 1088) / 17` = `x·t mod 64` — the same index, every tick,
// forever. A power-of-two 1024 would have been 17/16 = 6.25% fast instead.
//
// Both are once per voice per TICK, never per sample, so the division and the
// modulo cost nothing worth a power-of-two compromise.
const LFO_PHASE_STEPS = 1088;
const LFO_STEPS_PER_ENTRY = 17;

/** Advance a command LFO's phase by its speed byte. */
function advanceLfoPhase(pos, speed) {
  return (pos + speed) % LFO_PHASE_STEPS;
}

// ── Auto-vibrato's phase (the instrument record's own LFO) ───────────────
// 1024 steps advanced by the speed byte, indexed ⌊phase ÷ 16⌋. The source
// trackers run a 256-step phase advanced by their 0…64 speed field and index
// `(phase >> 2) & 63`, so a full cycle is `256 ÷ speed` ticks; a record byte
// is that field × 4 (IT `Vis` 0…64 → 0…255), and 4× the phase length keeps
// `(4·speed·t mod 1024) >> 4` = `(speed·t mod 256) >> 2` — the same table
// entry on the same tick, exactly.
//
// A 256-step phase advanced by `speed × 2` (what this was) could not carry
// the widened byte at all: every multiple of 64 stepped only between table
// entries 0 and 32, which are both zero, so the most ordinary IT speeds
// (`Vis` 16 and 32 → bytes 64 and 128) played no vibrato whatsoever.
const AUTOVIB_PHASE_STEPS = 1024;

// Auto-vibrato depth calibration. IT plays `Vid` 64 — its maximum — as ±1
// semitone (openmpt123 measures ±99.6 cents; `Vid` 32 → ±51.6, `Vid` 15 →
// ±25.6, i.e. linear), and a record byte is `Vid × 4`, so byte 255 has to
// reach 4096÷12 = 341 units of 4096-TET. `(lfo × depth × 43) >> 12` lands on
// 340 with the ±127 LFO. The old `>> 10` reached 31 — a tenth of IT's
// deepest wobble at the record's own maximum.
const AUTOVIB_DEPTH_MUL = 43;
const AUTOVIB_DEPTH_SHIFT = 12;

/** Sample a command LFO's 1088-step phase (H, U, R, Y). */
function lfoSampleWide(pos, wave) {
  // `idx << 2` re-enters lfoSample at the position its own `>> 2` undoes, so
  // the two phase scales share one waveform switch (and one random draw).
  return lfoSample(Math.trunc(pos / LFO_STEPS_PER_ENTRY) << 2, wave);
}

/** LFO sample; `pos` indexes `(pos >> 2) & 63` (see the two callers' scales). */

function lfoSample(pos, wave) {
  const idx = (pos >>> 2) & 0x3f;
  switch (wave & 3) {
    case 0: return MOD_SIN_TABLE[idx];                       // sine
    case 1: return 0x7f - (idx << 2);                        // ramp down
    case 2: return idx < 32 ? 0x7f : -0x7f;                  // square
    default: return (Math.trunc(random() * 256) & 0xff) - 0x80; // random
  }
}

// ── Effect opcode constants (base-36 digit values; 1438-1472) ──
const EffectOp = Object.freeze({
  OP_NONE: 0x00,
  OP_1: 0x01, OP_2: 0x02, OP_3: 0x03, OP_4: 0x04,
  OP_5: 0x05, OP_6: 0x06, OP_7: 0x07, OP_8: 0x08, OP_9: 0x09,
  OP_A: 0x0a, OP_B: 0x0b, OP_C: 0x0c, OP_D: 0x0d, OP_E: 0x0e, OP_F: 0x0f,
  OP_G: 0x10, OP_H: 0x11, OP_I: 0x12, OP_J: 0x13, OP_K: 0x14, OP_L: 0x15,
  OP_M: 0x16, OP_N: 0x17, OP_O: 0x18, OP_P: 0x19, OP_Q: 0x1a, OP_R: 0x1b,
  OP_S: 0x1c, OP_T: 0x1d, OP_U: 0x1e, OP_V: 0x1f, OP_W: 0x20, OP_X: 0x21,
  OP_Y: 0x22, OP_Z: 0x23,
  // ── ASCII-symbol space (item 162): the base-36 range above is full, so a
  //    symbol effect's on-disk opcode is its ASCII code + $80 ($A0..$FE);
  //    the in-memory value is that same byte, no translation table needed.
  OP_COLON: 0xba, // ':' — argument extension, Format 3 only (TAUD_NOTE_EFFECTS.md)
});

/** Which opcodes read `:`'s argument when paired with it (effects.js's `ext`
 *  parameter) — J, O and the sample-mod pair. Shared with the UI so the
 *  pattern grid's "this pairing needs a second look" highlight (see
 *  glyphs.js paintFxCell) agrees with what the engine actually does. */
const EXT_CAPABLE_OPS = Object.freeze(new Set([
  EffectOp.OP_J, EffectOp.OP_O, EffectOp.OP_2, EffectOp.OP_3,
]));

// ── Metainstrument mix-gain: "Perceptually Significant Octet to Decibel Table"
//    as linear amplitude (1480-1513). Octet 0 = silence, 159 = unity, 255 = +24 dB.
const META_MIX_GAIN = Float64Array.from([
  0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
  0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
  0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
  0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
  0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
  0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
  0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
  0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
  0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
  0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
  0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
  0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
  0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
  0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
  0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
  0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
  0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
  0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
  0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
  0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
  1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
  1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
  1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
  1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
  1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
  1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
  2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
  2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
  3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
  4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
  6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
  10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932,
]);

/** initialAttenuation octet → linear amplitude multiplier (0 = unity sentinel). */
function attenGainOf(octet) {
  return octet <= 0 ? 1.0 : META_MIX_GAIN[octet & 0xff];
}

// ── Pitch conversions (1632-1690) ──

function noteValToAmigaPeriod(noteVal) {
  return AMIGA_BASE_PERIOD * 2 ** (-(noteVal - MIDDLE_C) / 4096.0);
}

function amigaPeriodToNoteVal(period) {
  return Math.round(MIDDLE_C + 4096.0 * Math.log2(AMIGA_BASE_PERIOD / period));
}

function noteValToFreqHz(noteVal) {
  return LINEAR_FREQ_C4_HZ * 2 ** ((noteVal - MIDDLE_C) / 4096.0);
}

function freqHzToNoteVal(freq) {
  return Math.round(MIDDLE_C + 4096.0 * Math.log2(freq / LINEAR_FREQ_C4_HZ));
}

/**
 * Song tuning pair → playback-rate multiplier (item 77).
 *
 * Step 1 of terranmon.txt §"Note Tuning" folds the declared "note `baseNote`
 * sounds at `freq` Hz" down to a C4 frequency (the spec's own worked example:
 * A4/440 → C4/261.6255653). The engine's zero point is concert C4, so the
 * multiplier is just how far the song's C4 sits from it. Every note the
 * playhead sounds is scaled by this, so the song retunes as a whole.
 *
 * Deliberately a pure ratio with NO log/exp round trip. `2 **` with a rational
 * exponent is the one transcendental the engine already trusts to agree with
 * the JVM bit-for-bit (computePlaybackRate leans on it), whereas Math.log2 has
 * no such guarantee — routing the tuning through a log would put the whole
 * bit-exact gate at the mercy of a last-ulp difference between platforms.
 *
 * A concert declaration returns EXACTLY 1.0: 440 is f32-representable and
 * `440 / 2**0.75 === TUNING_REF_C4_HZ` bit-for-bit, and `x * 1.0 === x`, so
 * A4@440 songs render without a single bit disturbed. The tracker default
 * (C9 @ 8363) returns 0.99892… — ~1.87 cents flat, which is what an Amiga
 * actually does and what the spec means by "tracker default tuning at A4 is
 * 439.548 Hz".
 */
function tuningRatioOf(baseNote, freq) {
  // Spec: either field reading zero means "assume the tracker default".
  const b = baseNote > 0 ? baseNote : TUNING_DEFAULT_BASE_NOTE;
  const f = freq > 0 ? freq : TUNING_DEFAULT_FREQ_HZ; // also catches NaN
  return (f / 2 ** ((b - MIDDLE_C) / 4096.0)) / TUNING_REF_C4_HZ;
}

/** One tick of Amiga-mode pitch slide; persists period state on the voice. */
function amigaSlideTick(voice, slideArg) {
  if (voice.amigaPeriod < 0.0) voice.amigaPeriod = noteValToAmigaPeriod(voice.noteVal);
  voice.amigaPeriod = Math.max(voice.amigaPeriod - slideArg, 1.0);
  return amigaPeriodToNoteVal(voice.amigaPeriod);
}

/** One-shot Amiga slide (fine EFx/FFx) — no persistent state mutation. */
function amigaSlideOnce(noteVal, slideArg) {
  const period = noteValToAmigaPeriod(noteVal);
  const newPeriod = Math.max(period - slideArg, 1.0);
  return amigaPeriodToNoteVal(newPeriod);
}

/** Per-tick linear-freq slide (toneMode 2, Hz/tick). */
function linearFreqSlideTick(voice, slideArg) {
  if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal);
  voice.linearFreq = Math.max(voice.linearFreq + slideArg, 1.0);
  return freqHzToNoteVal(voice.linearFreq);
}

/** One-shot linear-freq slide for fine E/F. */
function linearFreqSlideOnce(noteVal, slideArg) {
  const freq = noteValToFreqHz(noteVal);
  const newFreq = Math.max(freq + slideArg, 1.0);
  return freqHzToNoteVal(newFreq);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ══ src/engine/spatial.js ══
// Surround and ambisonics core — TODO #998.0/.1/.2.
//
// The engine's spatial model is OBJECT-based: a sounding voice is a source with
// a DIRECTION and a gain, and nothing in the mixer knows what the eventual
// output format will be. A SpatialRenderer turns those objects into the
// channels of a SpatialBus, so a file format is always a render TARGET, never
// the thing the engine holds: playback installs StereoRenderer (the device is
// stereo), and an export installs whatever the chosen format wants —
// AmbisonicRenderer today, ITU speaker layouts when #998.5 lands — then
// re-renders the song through the very same mixer.
//
// ── Units ──
// Azimuth is the 9-bit angle of the extended `S $8xxx` command (#998.1): 512
// units to a full turn, 0 = left (0°), 128 = front (90°), 256 = right (180°),
// 384 = behind (270°), increasing CLOCKWISE seen from above. Its low 8 bits are
// exactly the legacy pan byte, so pan $00 / $80 / $FF still mean left / centre
// / right and every ordinary pan write lands on the front arc.
// Elevation is effect X's signed byte: 128 units to 90°, −128 = below, +127 ≈
// above. Both are kept as doubles — a Z slide (#998.2) moves continuously.
//
// Direction vectors use the AmbiX axes: +x front, +y left, +z up.
//
// This is not a port: the Kotlin engine has no surround yet, so this file IS
// the reference implementation. Behaviour contract: TAUD_NOTE_EFFECTS.md
// ("Spatial panning effects" + S $80xx), terranmon.txt (song flag `ss`).


/** Song-immutable surround model (terranmon.txt song table, `ss` bits). */
const SURROUND_STEREO = 0;
const SURROUND_PLANAR = 1;   // 360° panning, horizontal only
const SURROUND_SPATIAL = 2;  // full sphere

/** Azimuth units in a full turn (the S $8xxx angle). */
const AZIMUTH_TURN = 512;
/** Elevation units in a quarter turn (effect X's signed byte). */
const ELEVATION_QUARTER = 128;
/** Widest multi-channel sample the placement table knows (terranmon.txt 's'). */
const MAX_SAMPLE_CHANNELS = 8;

const AZ_TO_RAD = (2 * Math.PI) / AZIMUTH_TURN;
const EL_TO_RAD = Math.PI / 2 / ELEVATION_QUARTER;
const AZ_PER_DEG = AZIMUTH_TURN / 360;
/** Taud azimuth 128 is straight ahead — the ambisonic 0° — and runs the other way. */
const AZ_FRONT = 128;

/** Fold an azimuth into [0, 512). */
function wrapAzimuth(a) {
  const r = a % AZIMUTH_TURN;
  return r < 0 ? r + AZIMUTH_TURN : r;
}

/**
 * Fold a full-circle azimuth onto the legacy pan byte (0..255) by mirroring the
 * rear arc onto the front one. Two speakers cannot render front/back, so a
 * stereo downmix keeps the left/right axis and drops the other; the mapping is
 * the identity on the front arc, which is what makes ordinary pan values behave
 * identically in every surround model.
 */
function foldAzimuthToPan(az) {
  const a = wrapAzimuth(az);
  const p = a <= 256 ? a : AZIMUTH_TURN - a;
  return p > 255 ? 255 : p;
}

/** Unit vector for (azimuth, elevation). */
function directionFromAngles(az, el, out) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cph = Math.cos(ph);
  out[0] = cph * Math.cos(th);
  out[1] = cph * Math.sin(th);
  out[2] = Math.sin(ph);
  return out;
}

/** (azimuth, elevation) of a unit vector — the inverse of directionFromAngles. */
function anglesFromDirection(x, y, z, out) {
  out[0] = wrapAzimuth(AZ_FRONT - Math.atan2(y, x) / AZ_TO_RAD);
  out[1] = Math.asin(clamp(z, -1.0, 1.0)) / EL_TO_RAD;
  return out;
}

const layoutOf = (...deg) => Float64Array.from(deg, (d) => d * AZ_PER_DEG);

/**
 * ITU-style placement of a MULTI-CHANNEL sample's channels (#998.0), as azimuth
 * offsets from the source's own direction, in WAV channel order. Stereo is the
 * ±30° "equilateral triangle" of BS.775; the surround sets are the BS.775 /
 * BS.2051 angles. Only 1 and 2 are reachable today — the sampler plays at most
 * two pool spans (terranmon.txt Ixmp note 8) — but the placement RULE is what
 * #998.0 pins down, so the whole table lives here.
 */
const SAMPLE_CHANNEL_LAYOUT = Object.freeze({
  1: layoutOf(0),
  2: layoutOf(-30, 30),                            // L R
  4: layoutOf(-30, 30, -110, 110),                 // L R Ls Rs
  6: layoutOf(-30, 30, 0, 0, -110, 110),           // L R C LFE Ls Rs
  8: layoutOf(-30, 30, 0, 0, -90, 90, -135, 135),  // L R C LFE Lss Rss Lrs Rrs
});

/**
 * World (azimuth, elevation) of a sample channel sitting `localAz` off the
 * source's own direction. The layout is a rigid body aimed at the source: it
 * yaws AND pitches with it, so a stereo pair keeps its 60° width however high
 * the source flies instead of collapsing at the poles the way a plain azimuth
 * offset would.
 */
function sampleChannelAngles(az, el, localAz, out) {
  if (localAz === 0) { out[0] = az; out[1] = el; return out; }
  if (el === 0) { out[0] = az + localAz; out[1] = 0; return out; } // exact, and the common case
  const psi = -localAz * AZ_TO_RAD; // layout offset is clockwise; ambisonic azimuth is not
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cpsi = Math.cos(psi), spsi = Math.sin(psi);
  const cph = Math.cos(ph), sph = Math.sin(ph);
  const cth = Math.cos(th), sth = Math.sin(th);
  return anglesFromDirection(
    cpsi * cph * cth - spsi * sth,
    cpsi * cph * sth + spsi * cth,
    cpsi * sph,
    out,
  );
}

/**
 * Orthogonal projection of a direction onto the listener's left–right axis:
 * −1 hard left … 0 centre … +1 hard right. It is the SHADOW the source casts
 * on that line — height and depth both collapse onto it, so a source overhead
 * or directly behind reads centre, and a hard-left source 60° up reads
 * half-left. The channel-header pan strip draws exactly this (#998.6), which
 * is why it lines up with the radar dot above it.
 *
 * Not the same thing as the audible downmix position (foldAzimuthToPan mirrors
 * the rear arc instead of foreshortening it) — this one is a POSITION display.
 */
function lateralProjection(az, el) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  return -Math.cos(el * EL_TO_RAD) * Math.sin(th);
}

/**
 * Decode an X / 4 argument (`$eeaa`) into [azimuth, elevation]. The commands
 * and any UI that writes them share this pair so the two encodings cannot
 * drift: azimuth is a byte over the full turn (half the engine's resolution),
 * elevation is signed.
 */
function anglesFromSpatialArg(arg, out) {
  const ee = (arg >>> 8) & 0xff;
  out[0] = (arg & 0xff) * 2;
  out[1] = ee >= 0x80 ? ee - 256 : ee;
  return out;
}

/** Encode (azimuth, elevation) back into an X / 4 argument. */
function spatialArgFromAngles(az, el) {
  const a = Math.round(wrapAzimuth(az) / 2) & 0xff;
  const e = clamp(Math.round(el), -128, 127) & 0xff;
  return (e << 8) | a;
}

const slerpA = new Float64Array(3);
const slerpB = new Float64Array(3);

/**
 * One tick of a Z slide (#998.2): rotate (az, el) toward (tgtAz, tgtEl) along
 * the great circle by at most `stepUnits` azimuth units, at constant angular
 * velocity — the SLERP the spec RECOMMENDS. Identical directions do nothing;
 * ANTIPODAL ones (where the great circle is undefined) take the CLOCKWISE path,
 * matching effect P's rule. Writes [azimuth, elevation] into `out`.
 */
function stepTowardTarget(az, el, tgtAz, tgtEl, stepUnits, out) {
  const a = directionFromAngles(az, el, slerpA);
  const b = directionFromAngles(tgtAz, tgtEl, slerpB);
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1.0, 1.0);
  const omega = Math.acos(dot);
  const step = stepUnits * AZ_TO_RAD;
  if (!(omega > 1e-12) || step <= 0.0) { out[0] = az; out[1] = el; return out; }
  if (step >= omega) { out[0] = wrapAzimuth(tgtAz); out[1] = tgtEl; return out; }

  let vx, vy, vz;
  if (omega > Math.PI - 1e-9) {
    // Antipodal: pick the axis whose rotation makes the azimuth INCREASE, i.e.
    // the part of −z perpendicular to the source (front → right → behind).
    let kx = a[2] * a[0];
    let ky = a[2] * a[1];
    let kz = a[2] * a[2] - 1.0;
    let len = Math.hypot(kx, ky, kz);
    if (len < 1e-9) {
      // Source is straight up or down: rotate through its own azimuth instead.
      const th = (AZ_FRONT - az) * AZ_TO_RAD;
      const hx = Math.cos(th), hy = Math.sin(th);
      kx = -a[2] * hy;
      ky = a[2] * hx;
      kz = a[0] * hy - a[1] * hx;
      len = Math.hypot(kx, ky, kz);
    }
    kx /= len; ky /= len; kz /= len;
    // Rodrigues, with k ⟂ a so the k(k·a) term vanishes.
    const c = Math.cos(step), s = Math.sin(step);
    vx = a[0] * c + (ky * a[2] - kz * a[1]) * s;
    vy = a[1] * c + (kz * a[0] - kx * a[2]) * s;
    vz = a[2] * c + (kx * a[1] - ky * a[0]) * s;
  } else {
    const sinOmega = Math.sin(omega);
    const c0 = Math.sin(omega - step) / sinOmega;
    const c1 = Math.sin(step) / sinOmega;
    vx = a[0] * c0 + b[0] * c1;
    vy = a[1] * c0 + b[1] * c1;
    vz = a[2] * c0 + b[2] * c1;
  }
  return anglesFromDirection(vx, vy, vz, out);
}

// ── Renderers ─────────────────────────────────────────────────────────────
// A renderer answers one question — "what gain does a source at (az, el) get in
// each of my channels?" — plus a monitoring stereo pair so any render target
// can be auditioned on the device. Everything format-specific stops here.

/**
 * Stereo render target: the device path, and the stereo downmix every other
 * format offers. Sources on the FRONT ARC hit exactly the legacy equal-energy
 * pan law (same expression, same order of operations), so a song that only uses
 * ordinary pan renders bit-for-bit like it does in stereo mode. Behind the
 * listener the image folds back onto the front, and elevation collapses it
 * toward the centre — at ±90° a source is dead centre, the only choice that
 * stays continuous at the poles.
 */
class StereoRenderer {
  constructor() {
    this.numChannels = 2;
    this.name = "stereo";
  }

  channelGains(az, el, out, off) {
    const p = foldAzimuthToPan(az);
    const pan = el === 0 ? p : 128 + (p - 128) * Math.cos(el * EL_TO_RAD);
    out[off] = Math.cos((Math.PI * pan) / 512.0);
    out[off + 1] = Math.sin((Math.PI * pan) / 512.0);
  }

  monitorStereo(data, frames, n, out) {
    out[0] = data[n];
    out[1] = data[frames + n];
  }
}

/** ACN indices carried by an order-N basis; planar keeps the horizontal (|m| = l) set. */
function acnChannelList(order, planar) {
  const list = [];
  for (let l = 0; l <= order; l++) {
    for (let m = -l; m <= l; m++) {
      if (!planar || Math.abs(m) === l) list.push(l * l + l + m);
    }
  }
  return Int32Array.from(list);
}

const SQRT3 = Math.sqrt(3.0);
const SQRT15 = Math.sqrt(15.0);
const SQRT5_8 = Math.sqrt(5.0 / 8.0);
const SQRT3_8 = Math.sqrt(3.0 / 8.0);

/**
 * Real spherical harmonics up to `order` (≤ 3) for one direction, SN3D
 * normalised and ACN ordered — the AmbiX convention (#998.4's export format,
 * and a perfectly good internal scene basis). Fills out[0 .. (order+1)²).
 */
function encodeSN3D(az, el, order, out) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cph = Math.cos(ph);
  const x = cph * Math.cos(th);
  const y = cph * Math.sin(th);
  const z = Math.sin(ph);

  out[0] = 1.0;
  if (order < 1) return out;
  out[1] = y;
  out[2] = z;
  out[3] = x;
  if (order < 2) return out;
  out[4] = SQRT3 * x * y;
  out[5] = SQRT3 * y * z;
  out[6] = (3.0 * z * z - 1.0) * 0.5;
  out[7] = SQRT3 * x * z;
  out[8] = SQRT3 * (x * x - y * y) * 0.5;
  if (order < 3) return out;
  out[9] = SQRT5_8 * y * (3.0 * x * x - y * y);
  out[10] = SQRT15 * x * y * z;
  out[11] = SQRT3_8 * y * (5.0 * z * z - 1.0);
  out[12] = z * (5.0 * z * z - 3.0) * 0.5;
  out[13] = SQRT3_8 * x * (5.0 * z * z - 1.0);
  out[14] = SQRT15 * z * (x * x - y * y) * 0.5;
  out[15] = SQRT5_8 * x * (x * x - 3.0 * y * y);
  return out;
}

/** Highest ambisonic order encodeSN3D implements. */
const AMBISONIC_ORDER_MAX = 3;

/**
 * Ambisonic (scene-based) render target — the export basis for #998.4, and the
 * proof that the mixer is format-agnostic: same voices, same objects, a
 * different set of channels. `planar` drops the harmonics a horizontal-only
 * song cannot excite (7 channels instead of 16 at order 3); an AmbiX writer
 * zero-fills the missing ACNs.
 */
class AmbisonicRenderer {
  constructor(order = AMBISONIC_ORDER_MAX, planar = false) {
    this.order = Math.min(order, AMBISONIC_ORDER_MAX);
    this.planar = planar;
    this.acn = acnChannelList(this.order, planar);
    this.numChannels = this.acn.length;
    this.name = `ambisonic${planar ? "2d" : "3d"}-o${this.order}`;
    this._sh = new Float64Array((this.order + 1) * (this.order + 1));
  }

  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, this.order, this._sh);
    const acn = this.acn;
    for (let c = 0; c < acn.length; c++) out[off + c] = sh[acn[c]];
  }

  /** Coincident cardioid pair at ±90° — W ± Y, the classic FOA monitor decode. */
  monitorStereo(data, frames, n, out) {
    const w = data[n];
    const yy = data[frames + n]; // ACN 1 is bus channel 1 in both bases
    out[0] = 0.5 * (w + yy);
    out[1] = 0.5 * (w - yy);
  }
}

// ── Bus ───────────────────────────────────────────────────────────────────

/**
 * The channel bus a renderer writes into: channel-major, one chunk deep, and
 * Float64 because the legacy stereo path accumulates in double locals — an
 * export tap (or #998.3's downmix) reads `data` directly.
 */
class SpatialBus {
  constructor(renderer, frames) {
    this.renderer = renderer;
    this.numChannels = renderer.numChannels;
    this.frames = frames;
    this.data = new Float64Array(this.numChannels * frames);
    this.pair = new Float64Array(2);
  }

  clear() { this.data.fill(0.0); }

  /**
   * Accumulate one positioned source sample into frame `n`. The factor order
   * matches the stereo path's `s * vol * gain * ramp` exactly — do not
   * "simplify" it, that is what keeps a planar song bit-identical to stereo.
   */
  addSource(n, value, gains, off, ramp) {
    const d = this.data;
    const nc = this.numChannels;
    const f = this.frames;
    for (let c = 0; c < nc; c++) d[c * f + n] += (value * gains[off + c]) * ramp;
  }

  /** The device's stereo pair for frame `n`, as the renderer defines it. */
  stereoAt(n) {
    this.renderer.monitorStereo(this.data, this.frames, n, this.pair);
    return this.pair;
  }
}

// ── Per-voice spatial state ───────────────────────────────────────────────
// Legacy pan writes funnel through applyPanSet / applyPanSlide so that the
// stereo model keeps its exact arithmetic (clamped 0..255 integers) while the
// surround models track the continuous azimuth that the mixer and the Z slide
// actually use. `voice.channelPan` stays the integer mirror the UI reads.

/** Channel-pan write: absolute. `pan` is the legacy byte, or a 9-bit angle. */
function applyPanSet(ts, voice, pan) {
  if (ts.surroundModel === SURROUND_STEREO) {
    voice.channelPan = pan & 0xff;
  } else {
    voice.panAzimuth = wrapAzimuth(pan);
    voice.channelPan = mirrorPanByte(voice.panAzimuth);
  }
  voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
}

/** Channel-pan write: signed delta — clamped in stereo, wrapped in surround. */
function applyPanSlide(ts, voice, delta) {
  if (ts.surroundModel === SURROUND_STEREO) {
    voice.channelPan = delta < 0
      ? Math.max(voice.channelPan + delta, 0)
      : Math.min(voice.channelPan + delta, 0xff);
  } else {
    voice.panAzimuth = wrapAzimuth(voice.panAzimuth + delta);
    voice.channelPan = mirrorPanByte(voice.panAzimuth);
  }
  voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
}

/** Elevation write (effect X / 4). Planar songs stay on the horizon. */
function applyElevation(ts, voice, el) {
  voice.panElevation = ts.surroundModel === SURROUND_SPATIAL ? el : 0.0;
}

// ── Note-pan axis ─────────────────────────────────────────────────────────
// The channel trio above places the CHANNEL; this pair offsets the note within
// it. The offset is stored signed with 0 = neutral, so the writers take the
// same 128-is-centre values every other pan command takes and subtract the
// centre themselves — an Ixmp patch pan of $80 and a column SET of centre both
// mean "no shift", whatever the channel is doing.

/** Fold a note offset into range: clamped like a stereo pan, wrapped like an angle. */
function boundNotePan(ts, off) {
  return boundNoteOffset(ts, off);
}

function boundNoteOffset(ts, off) {
  if (ts.surroundModel === SURROUND_STEREO) return clamp(off, -0xff, 0xff);
  return wrapAzimuth(off + AZIMUTH_TURN / 2) - AZIMUTH_TURN / 2;
}

/** Note-pan write: absolute. `pan` is a legacy byte or 9-bit angle, 128 = centre. */
function applyNotePanSet(ts, voice, pan) {
  voice.notePan = boundNoteOffset(ts, pan - AZ_FRONT);
}

/** Note-pan write: signed delta. */
function applyNotePanSlide(ts, voice, delta) {
  voice.notePan = boundNoteOffset(ts, voice.notePan + delta);
}

/** Note-elevation write (wide panning column). Planar songs stay on the horizon. */
function applyNoteElevation(ts, voice, el) {
  voice.noteElevation = ts.surroundModel === SURROUND_SPATIAL ? el : 0.0;
}

/** The integer pan the UI and ghost copies see: the monitoring (folded) byte. */
function mirrorPanByte(az) {
  return Math.round(foldAzimuthToPan(az));
}

/**
 * Effective azimuth of a voice: its own angle plus the note-pan offset, the pan
 * envelope's offset, the instrument's random pan swing and the panbrello LFO —
 * the surround twin of the stereo path's pan sum, wrapping where that one
 * clamps. So a Y that sweeps a stereo song across the front arc sweeps a
 * surround song along the same arc, and keeps turning past its ends.
 */
function voiceAzimuth(voice) {
  if (voice.hasPanEnv && voice.panEnvOn) {
    let envPanRaw = Math.round(voice.envPan * 255.0);
    envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
    return wrapAzimuth(voice.panAzimuth + voice.notePan + envPanRaw - 128 + voice.randomPanBias +
      voice.panbrelloOffset);
  }
  return wrapAzimuth(voice.panAzimuth + voice.notePan + voice.randomPanBias + voice.panbrelloOffset);
}

/**
 * Effective STEREO pan of a voice: the channel and note axes, the pan
 * envelope's offset, the instrument's random pan swing and the panbrello LFO,
 * clamped to the byte the equal-energy law takes. The twin of voiceAzimuth
 * above, and the ONE place that sum is written — the meters used to keep their
 * own copy of it and quietly lost the pan swing (item 155).
 */
function voicePanByte(voice) {
  let pan;
  if (voice.hasPanEnv && voice.panEnvOn) {
    let envPanRaw = Math.round(voice.envPan * 255.0);
    envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
    pan = voice.channelPan + voice.notePan + envPanRaw - 128 + voice.randomPanBias +
      voice.panbrelloOffset;
  } else {
    pan = voice.channelPan + voice.notePan + voice.randomPanBias + voice.panbrelloOffset;
  }
  return pan < 0 ? 0 : pan > 255 ? 255 : pan;
}

/** Effective elevation: the channel's height plus the note's own offset. */
function voiceElevation(voice) {
  return voice.panElevation + voice.noteElevation;
}

// ── Where a channel SOUNDS, for the meters ────────────────────────────────
// Everything above answers for ONE voice. A metainstrument is several at once,
// and the foreground voice is only its layer 0 — so a kit whose layers pan
// apart was being drawn at the first layer's position rather than at the
// note's (item 155.1). The displayed position is the mix-weighted MEAN of the
// constituents: for a plain instrument that is the voice's own value unchanged,
// and for a kit whose layers agree on panning it is still that value.

/** A voice's share of the channel's output, as the mixer weights it. */
function displayWeight(v) {
  const env = v.volEnvOn ? v.envVolMix : 1.0;
  return env * v.fadeoutVolume * v.currentMixVolume * v.layerMixGain *
    ((255 - v.fader) / 255.0);
}

/** Every voice channel `vi` is sounding — the foreground plus its layer
 *  children — visited with its display weight. */
function forEachSoundingLayer(ts, vi, voice, fn) {
  fn(voice, displayWeight(voice));
  if (!voice.metaForeground) return;
  for (const bg of ts.backgroundVoices) {
    if (bg.active && bg.isLayerChild && bg.sourceChannel === vi) fn(bg, displayWeight(bg));
  }
}

/** The stereo pan the METERS show for channel `vi` (item 155.1). */
function displayPanByte(ts, vi, voice) {
  let sum = 0.0, wsum = 0.0;
  forEachSoundingLayer(ts, vi, voice, (v, w) => { sum += voicePanByte(v) * w; wsum += w; });
  // A kit whose every layer has faded to nothing still has to be drawn
  // somewhere: fall back to the foreground voice's own position.
  return wsum > 1e-9 ? sum / wsum : voicePanByte(voice);
}

/** …and the same for a surround song, as [azimuth, elevation] into `out`.
 *  Angles are averaged as DIRECTIONS, so two layers either side of front
 *  average to front rather than to the back of the room. */
function displayAngles(ts, vi, voice, out) {
  let x = 0.0, y = 0.0, z = 0.0, wsum = 0.0;
  forEachSoundingLayer(ts, vi, voice, (v, w) => {
    directionFromAngles(voiceAzimuth(v), voiceElevation(v), dirScratch);
    x += dirScratch[0] * w; y += dirScratch[1] * w; z += dirScratch[2] * w;
    wsum += w;
  });
  // Weightless, or layers exactly opposite each other (whose directions cancel):
  // neither has a mean direction, so the foreground voice speaks for the note.
  const len = Math.sqrt(x * x + y * y + z * z);
  if (wsum <= 1e-9 || len < 1e-6) {
    out[0] = voiceAzimuth(voice);
    out[1] = voiceElevation(voice);
    return out;
  }
  // The mean of unit vectors is shorter than one; anglesFromDirection reads the
  // z component as a sine, so it has to be put back on the sphere first.
  anglesFromDirection(x / len, y / len, z / len, out);
  return out;
}

const dirScratch = new Float64Array(3);

const angleScratch = new Float64Array(2);

/**
 * Renderer gains for every channel of `voice`, cached in `sc` and recomputed
 * only when the source actually moves (a direction changes at most once per
 * tick, the mixer asks once per sample). Returns the cache entry, which the
 * caller stores back — each BUS needs its own, or two buses alternating on the
 * same voice would invalidate each other's on every single sample.
 */
function voiceGainsCache(bus, voice, sc) {
  const nc = bus.numChannels;
  const layout = SAMPLE_CHANNEL_LAYOUT[voice.activeChanCount] ?? SAMPLE_CHANNEL_LAYOUT[1];
  const chans = layout.length;
  // The RAMPED azimuth (item 141) — the mixer advanced it once for this sample,
  // and the stereo path is smoothing the very same number, which is what keeps a
  // planar song rendering identically to its stereo twin.
  const az = voice.currentPan;
  const el = voiceElevation(voice);
  if (sc === null || sc.gains.length < nc * MAX_SAMPLE_CHANNELS) {
    sc = {
      az: NaN, el: NaN, chans: 0, renderer: null,
      gains: new Float64Array(nc * MAX_SAMPLE_CHANNELS),
    };
  }
  if (sc.az !== az || sc.el !== el || sc.chans !== chans || sc.renderer !== bus.renderer) {
    for (let k = 0; k < chans; k++) {
      sampleChannelAngles(az, el, layout[k], angleScratch);
      bus.renderer.channelGains(angleScratch[0], angleScratch[1], sc.gains, k * nc);
    }
    sc.az = az; sc.el = el; sc.chans = chans; sc.renderer = bus.renderer;
  }
  return sc;
}

/** Gains for the MONITOR / export bus (voice.spatial). */
function spatialVoiceGains(bus, voice) {
  return (voice.spatial = voiceGainsCache(bus, voice, voice.spatial)).gains;
}

/** Gains for the master-strip analysis bus (item 98) — its own cache slot. */
function analysisVoiceGains(bus, voice) {
  return (voice.analysisSpatial = voiceGainsCache(bus, voice, voice.analysisSpatial)).gains;
}

// ══ src/engine/hrir-sadie.js ══
// GENERATED FILE — do not edit. Rebuild with: node tools/make-hrir-table.js
//
// GoogleVR / SADIE spherical-harmonic HRIR set, order 3 (16 ambisonic
// channels), 256 taps at 48000 Hz, as taken from Google Omnitone
// (src/resources/sh_hrir_order_3.wav, md5 310d2836b94909a9b49a84c2ebbf3552).
//
// Copyright (c) 2017 Google Inc. and (c) 2017 University of York, licensed
// under the Apache License 2.0 — see vendor/VENDOR-VERSIONS.md. The
// measurements are the SADIE project's Google/VR binaural filter set:
// https://www.york.ac.uk/sadie-project/GoogleVRSADIE.html
//
// ── What these numbers ARE ──
// Channel k is the LEFT ear's impulse response for ambisonic channel k in ACN
// order, SN3D normalised. Decoding an ambisonic scene to headphones is then one
// convolution per channel and a sum — no per-source filtering, no head model to
// tune — and the right ear comes free: mirroring a listener left↔right flips the
// sign of every harmonic with m < 0 and leaves the rest alone, so
// L = Σ_{m≥0} + Σ_{m<0} and R = Σ_{m≥0} − Σ_{m<0}. The set already carries the
// max-rE weighting Google baked in, which is why the decoder applies no shelf,
// no near-field compensation and no gain of its own beyond one calibration
// scalar (see binaural.js).
//
// Stored channel-major as int16 little-endian, base64'd: the layout the
// convolver reads, so decodeShHrir() is a scale and a copy.

/** Ambisonic order the set decodes, and the channel count that implies. */
const HRIR_ORDER = 3;
const HRIR_CHANNELS = 16;
/** Taps per channel, and the rate they were measured at. */
const HRIR_LENGTH = 256;
const HRIR_RATE = 48000;

const HRIR_BASE64 = [
  "/v/z//3/AgD//wYAAAAKAN7/sv9RAHUBe/4//LsDzQQV/736/PfwAXT/MvkAAnADoAfjDQcNWAHw/UECSv7RA4UECAoGCPf8",
  "d//p+Rz8L/4x/1cBx//6AHf8ggHhAEQAMwFM/SD/9/sq/xv++/3f/z/9kf+N/f3+uv6c/vv+Vf6C/3P9yf4Y/sb+L/92/pr+",
  "rv2y/ur9N//M/p7+5P7+/fL+gf4V/5T+6f6b/lT+/v5b/iH/wP70/r3+tP7P/rD+Lf+F/g//vv7P/gv/2P4h//P+HP/L/h7/",
  "7P4M/0L/6P5R/y3/Rf9E/1P/N/9M/23/Lv9o/yb/Qf9Q/0D/Vf9b/2H/Sv9+/1n/d/99/2j/hP9v/3n/c/+K/3n/if+D/3j/",
  "mv99/47/iP+K/43/jP+Q/5b/o/+g/8L/qP+2/8b/q//A/8P/xf/R/9L/v//R/8b/vP/d/8H/0P/b/8T/1//e/83/3P/h/8j/",
  "4f/Y/8n/4//S/9H/4v/S/9L/4//R/9f/5P/P/9z/4P/Q/9//3//S/+D/3P/S/+L/2v/W/+T/2P/Z/+T/2P/c/+T/2P/g/+P/",
  "2f/i/+L/2v/l/+H/3P/m/+D/3//m/+D/4f/n/+D/4//n/+D/5f/m/+D/5v/l/+L/5//k/+H/5f/h/+H/5P/h/+T/5v/n/+r/",
  "7f/v//P/9f8EABgACgAAAAIA8//x/+//e//T/vAAEwWT/LT1wAdmCNj7+fNB75wLvwYu9AID4AYNEdkQ8RVfELP6HwcyBkoB",
  "lf9Y+9f7j/mX/wr7FP14/+f8PftR90/8cfgf+WH5cvli/Hf6V/4L/Zj+xPxC/Nr/AP6S/rr8rP3Q/MH8WP3D/XX/xP17/1L+",
  "IP/Y/9T+6v+d/1wAQ//p/3H/2/98ADX/SADA/zUATgCHAF0AMgCTAOj/xQBJAIsApAAkAFQAUwB1ABQApwA6AFoAfwAjAK4A",
  "ZABEADEATgAKADAANwDm/0EA+v8uAEcAEQATADUAHQAIAEUA9f8tACsACwA+ABMABQAbAB4AAgA8ABEA/v8gAPT/FwAXAA8A",
  "FQAYAPH/EQAnAPD/HwD1//v/JQDp/wAAJAD+/xkASwAOAC0APAAXAEcAOAAuAEgANwAxAEsAMAAuAEYAFQAmACwAAwAZABIA",
  "9v8PAAsA8f8UAAIA8/8UAPv//P8RAPX//f8NAPH//v8IAO7/AwADAO//BQD///L/CAD9//b/CgD6//n/CgD4//3/CAD3/wAA",
  "BwD3/wQABAD4/wYAAwD6/wgAAQD9/wkA/v///wgA/v8CAAcA/f8DAAYA/f8GAAQA/v8GAAIA//8GAAEAAAAFAP//AQADAP//",
  "AQABAP//AAAAAP//AAD//////v8AAAAAAQAAAP3/BAD5/wkA+v/3/x0A+v/C/vj+dwUAAmj5Ev7d/5sDxf8p/YcJmgDt9GH8",
  "9ggZAKLzkwGGCacGJAS6Be/67PEdAeoCWAT+Bkb8wvrL/Nz/8AEfA4ICAf3d/Mr9QwD2Aq8BpQAg/pH81f5xAXoB1QDP/zv+",
  "Z/5y/z4AtwBuAFr/7v42/6P/kgDVACUAxP+u/4//7/9MAEMA3/97/6r/7P/v/+D/EgABAMz/+//g/+L/IgAaAPr/5//Q/+r/",
  "OQA1AD8APgDw/wYADAD2/zcARgAPAAIAGQAhAD4AJQD8/xgADgAWABwA7f/i//b/9P/0//z/6v/8/xQA/P8DAAgA+P8KAA0A",
  "9v8BAP3/9/8GAPr/+f8BAPv/CAAPAPf/+f8CAPn////6//7/CQDx//P/DgDz/+f/AQD3//v/BwABAPz/8f/1//7/+v8EAAIA",
  "7/8BAAMA9f8MAAMA+f8KAPv/+v8IAPr/+/8JAPf/+/8HAPX/AwAHAPf/AwABAPb/BgABAPf/BQD7//f/BQD6//v/BQD5//3/",
  "BAD4/wAAAwD4/wEAAQD5/wIA///6/wMA/v/7/wMA/P/9/wMA+//+/wIA+////wEA+/8BAAAA+/8CAP///f8CAP7//f8CAP3/",
  "//8BAP7///8AAP7/AAD//////////////////wAAAAAAAP//AAD+/wIAAAD+/wwA+/+l/43/+ABPAS0ACP/o/FYATwGL+yf9",
  "TwVvDUb+tPS5C+YD/fQM+zH9aQkQBLb7bgB6/Yn95/xAAcgAEgD4AVP/IgIn/Gn9AwHMAL4CRP+yAJT8b/4oAcz/hgLC/kD/",
  "lv4IAMkB2QDTAcP/iwB7/+L/PgAiAHcAbf9OACL/oQBgAAcAmQBv/87/ZP9vAOj/FQAXALr/ZQCV/0wA7v/j//b/+P/+/8X/",
  "PgC8/0MA7f/T/yIA8/8jAAcAIAC3/xwA3//N/yAA3/9DACMAKgAeACoA+v8EACIAxP8OAOT/8v8GAO7/7v/t/wIA4v8VAOP/",
  "9v8MAOb/CwD//wAA+f8JAO7/AwAGAO3/GAD4////DQABAPz/EgD9/+7/FgD//wsAAQAHABQA7f/5/wIAAQAMAA0A+f8OAAQA",
  "9f8WAPn/AQAQAPz/BQAKAPb/BQAOAPX/DQAEAPD/CgD8//j/CgD8//f/CgD5//z/DQD3/wQACQD3/wUABQD3/wcAAwD3/wkA",
  "///6/wkA/f/9/wcA+////wcA+f8BAAUA+f8DAAMA+v8EAAEA+/8FAP///P8FAP3//v8EAPz///8DAPv/AQACAPv/AgAAAPz/",
  "AgAAAP3/AwD/////AgD//wAAAAD//wAAAAAAAAAAAAD///////8AAP////8AAP3/AwD//wEADAD+/37/Yf9gAdkBZwAh/hT8",
  "cALV/6P0DAILD/ECTP6KCPsFwvlQ9zj4+fl8AJEDDwFIAR0BHP04/+IA6f7YASYCt/5z/IL+wQEQAFIBxAG3/r3+FP9CAJ0B",
  "0QHhALz/cf8N/6X//f8qANX/nf8GAJ7//P9wAI4AjACTAA0Auf+SAAMA3/9aAP7/HQA8AAoA+v8RAOb/IAAHALf/LgAjAPr/",
  "FgD1/+z/LQARAPf/LwDy/xMANADp/wIAEgDe//j/DgDA/+P/9P/R/xMADgABADQAEQD0/xwA+P/1/xgA6/8AABIA6v8MABgA",
  "7P8QABkA/P8fAAIA8f8TAPr/AgAdAAUABwATAPP/CQAVAPn/FQAOAPj/FQAFAOf/DQAXAAEAFgAWAAoAEQAEAAAAAwD7/wEA",
  "BAD7/wYAAAD3/wkA/f/9/w4A+v/6/wgA+P///wcA+P8CAAQA+f8GAAQA/f8JAAMA/f8IAP3//P8GAPv//v8FAPn/AAAEAPr/",
  "AwAEAPv/BAACAPz/BQAAAP3/BQD///7/BQD+/wAABQD9/wEABAD9/wIAAwD9/wMAAQD+/wMAAQD+/wQAAAD//wMA//8AAAMA",
  "/v8BAAIA/v8BAAEA/v8CAAAA//8BAAAAAAABAAAAAAAAAAAAAAAAAP///v//////AAAAAPz/CAD3/w4A+v/z/y8A9P9Q/rH+",
  "tQdUAl32jP49AOUEOgG7+tkFQP1Z/ecCCgZpALrwjwIICXED3ACf+dz7dftwA94EygJyA4r9a/2K/MoBVANKAJ7/JP3t/sD/",
  "FwIFATYAiP+2/bD/nP9OAlsBMgDh/xr+DgB3ADEBSQAhAIH/Ev+wAOn/wgBlAAIA9f+O/zQARAB+AAQAfQAgAPT/cQAEAGUA",
  "PQAKAMP//f/t/+D/OwC6/wcABQDb/xIAGgAkADoAHwDZ/zUA+v/3/zcAz//l////2//z/xkA4f/5/wIA3P8bAPf/7P8QAPz/",
  "9/8WAAkA/f8hAPH/9/8KAOX//P8EAOv///8EAOj/DwABAOz/CQDp/+v/EAD+/+3/CgD1//v/EwDt/wkACQDj/wcADQDu//7/",
  "/v/3/xAA/P/5/wMA6v/6/wYA9f8EAAgA8P8CAAEA7/8FAPX/7v8CAPP/9v8EAPb//P8FAPL//v8EAPP/AwAAAPP/AgD9//X/",
  "AwD8//f/BgD7//v/BgD6////BAD5////AgD4/wEAAQD5/wIA///6/wMA/f/7/wMA/P/8/wMA+//+/wIA+v///wAA+v8BAAAA",
  "+/8BAP///P8CAP3//f8BAP3//v8AAPz//v////3///////7////+//7////////////8//3///8AAAIAAgAIAEEAnABv/wH9",
  "XgGiBJn8nf75BKoCXQJv+936+gKd+un1HQOxApv29vmQ/8X+tgBs/xX+vwUhC04Eg/+fAh0BjQKxBr8CpAJH/477///m/5cC",
  "rQIFANAA3/+GAEUALQFOAAoAyv8m/fL+XP9TAE8AOf9a/+f+z//j/6YAw//m/zYAKf9ZAB0ANAAgAAEA7v/m/zwA0P9IANb/",
  "GwAxALL/EwACAAsAGQBWANv/8f8DAMv/NgD4//j/4v/S/9j/HAAMANj/DACY/9//FADv/wIA1P/K/97/9v/G/+3/5//r/y4A",
  "+f8HABIABgAlADIABQAWADAACAAsABcAAAAYAAkABQAVAAIA9f8RAO3//f8cAPT/EAAfAPr/DwARAOn/FwAEANH/DAD1/9T/",
  "BADp/9b/CgDm/+D/FADv//7/GAD1/wsAEgD6/xYAEgD3/xEAAgD3/xQA///+/xIA/f8AABEA+f8DAA8A9/8EAAUA9P8GAAMA",
  "9v8HAP7/9v8IAPv/+f8HAPn/+/8FAPf//v8EAPf/AQACAPj/AgAAAPn/BAD+//r/BAD8//z/BAD8//7/AwD7////AgD7/wEA",
  "AQD7/wIA///8/wMA///9/wIA/f/+/wMA/f8AAAEA/f8AAAAA/f8AAAAA//8AAAAA//8AAAAAAAD///3///8AAAAAAgD//wQA",
  "//8FAAcA+P8ZABQABwAF/w0A9gHW/93/TP/A/6f+W/3CBO8AbP5jAB0BnQOK+sQANgLY9vYAUAgUACb8/wGB+4/9iQag/nED",
  "KQKq+87+gQAjAiQARwH9/WX+JgFBAD8CSAA1AL3+l/9HAEEA6QHO/00A5v6T/0EAQwA2Aav/TwBb/wQAhwANADcAzv/v/2b/",
  "IADE/2IASwBX/9f/hP/6/wwAHwCN/8L/5/+j/2UAyf8eAFYANwBRAEkAJwABAFgA4f9MADYA3P82APr/CAAoADYA9v8oAP3/",
  "5/81AOD/DgALAO//DwAqAPf/+/8bAM7/HAAUAOn/CADx/+z/CQAIAOn/HADz//D/GADn//z/DADx//j/DwDo/wIADADl/w4A",
  "9//v/wsA9f/v/w0A+P/s/wwA7f/v//7/9v/4//P/+v/w//H/+f/2//f/BQD5//L/CQD2//v/CQDx//v/AgDz//3/AgDw////",
  "/v/w/wMA/P/3/wYA+//4/wUA+f/7/wcA9//+/wUA9/8BAAIA+P8CAAAA9/8DAP7/+f8EAPz/+/8DAPv//P8CAPn//v8BAPn/",
  "//8AAPn/AAD///r/AQD9//v/AQD9//3/AQD9//3/AQD8////AAD8/wAA///9/////v/+//////////////////7/+f/7////",
  "//8FAAgABwB5AA4BAf/V+iECtght+/L7WQNPCY4LJe8v85oELQBC/grwb/8e/ELraQUp+c3xGQieDBsYoRT3BxEDZwE+AxkC",
  "6gYuBsUBE/09+2n9Uv3rA9YBbv7+/Zf8FwBZ/lwBHQFE/hj+ovp4/Zb+l/6Y/uT9lv5v/uL/GwBCALL/8v+0/z//mgBbAJwA",
  "/P8jADkAKgDTAJAA4QAsAF0ATQAtAJIAZwCMAD8AgQANABAANgAOAEgA4v/n/9z/EAAIACoAIwDf/xcA2v8NAAEA9P8AABkA",
  "RwBLAH8ANABIADcAKgBbACUAFgAQACQAAwARAA0A+v8fAA8AIwAgABkAGgAaAAcACAAYAAAAIQAOAAcAIgAGAAYAGgAKABIA",
  "GQDr/xsAHADn/wsA/v/0//b/6P/j/9j/5v8EAAsAGgAjABAALAAkABcAMQAhABwAIgATAA4AFQAKAA8AFQAEAA8ACAABAA0A",
  "CAAFAAkAAAD8/wcA/f/9/wUA+P/+/wAA9///////9/8AAPz/9/8CAPv/+v8CAPr//P8BAPr//v8CAPr/AAABAPv/AQAAAPz/",
  "AwAAAP3/AwD///7/AwD+////AgD9/wAAAgD8/wEAAQD9/wEAAAD9/wIA///+/wIA//8AAAIAAAAAAAEAAAAAAAAAAAAAAAAA",
  "//////7/AAD//wEAAgACAEwAowBC/0L8sABABZ7/TABcAEcEoAQP8az1j/4/+z/+CAAuCgULXgafAlH8N/6zAQkDngG7AskA",
  "qf3Z/78AUAHNARQAMvuK+gv8IP0VALP/3f7F/Zj9of60/1YBMAGaAJ3/GgBqAQkCWwIRAmwBFwABAA4A/f8OAKv/fP8+/07/",
  "bv/Z//j/AADi/4v/w//M//T/GgAiAAsA/v/b/8n/DQDg//v/AwDp/wwACgAgACgAHgD3//r/6f/n/xQA7P/c/93/0P/a/+b/",
  "1v/m//D/3f8GAAYA/v8SAAQA/f/9//D/6v/1/+P/6//4/+X/9P/3/+3/+P/5//f/AQD4//X/AwD0//j/+v/p//L/9f/1//j/",
  "9f/3/wUABwDw//T//f/s/+//+v/0/wIACwD//wgA/v/3//7/8P/1//z/6//w//j/7v/9/wEA8P/9//v/7/8BAPv/8/8BAPf/",
  "9f8DAPj/+/8GAPf///8FAPn/BAAFAPz/BgADAPv/BwABAP3/CAD+//7/BQD8////BQD7/wAAAwD6/wEAAQD7/wIA///7/wIA",
  "/v/8/wMA/f/9/wIA/P///wIA/P8AAAEA/f8BAAAA/f8CAP///f8CAP7//v8BAP7//v8BAP3///8AAP7/AAAAAP7/AAD/////",
  "//////////8AAAAAAAAAAP//AAD+/wAA/f8BAAMA9/8QAA0A/v8u/w0AoAHg/8//Wf/L/xH/Ov1gA2cCWP72/ioCHQOb/LD+",
  "iP0T/rQD/wCzAncA/f22/tr/ZgIUAWYBkf70/vn/e//CAUwATACx/qD+gv8nAGcBCAC/AGj/Yf/F/63/qQD9/0EAVv8p/0f/",
  "8P8/AN7/NABp/wsA/f8OAFsAGgADAM7/PwDJ/yAA+P/c/0QA8P8pABUALwAbADsA7f/e/yAAwf8xABAA7f8DAPD/4v/3/wkA",
  "z/8XAM//0P/9/8n/+////+v/8f8hAPf/DQAQANr/GwABAPT/BADy/+b/CQAAAO//GADs/wcAGwD1/wQAAADs//7/CQDp/wsA",
  "/v/p/w0A9v/4/wgA9v/1/wsA9P/8/wkA5/8GAAUA8P8FAAMA9P8CAP7/8P8FAPX/9/8GAPb//P8AAPr/AQAHAPz/BAADAPj/",
  "BgD+//v/BAD7//v/AwD8//7/BgD8/wIABQD6/wMAAgD7/wMAAAD6/wIA/v/7/wMA/P/8/wIA+//+/wIA+////wEA+/8AAAAA",
  "+/8BAP///P8CAP7//f8CAP7//v8CAP7///8BAP3/AAABAP3/AQAAAP7/AQD///7/AQD///7/AQD+////AAD+////AAD+////",
  "AAD//wAA/////////////////////wAA//8BAP//BgA4AIIAb/8T/a0AswPw/kcBiQNtAA7/aPlI+V//tvpF9pQFCww8BnEF",
  "pP2W/lUDmAJKACL/8ALQ/r7/JwG4/ckA//+g/ksAdgDg/rz9lP3y/sb+kv6//9X99f7V/0UArQAiAD4BBgB1AK4AJwGEAekA",
  "9wCr/yIABQBkAIYALQANAHf/AQBZ/9j/x/97/6z/ev/d/5X/+f+r/+//6v++/zUAyP8IANb/9//1/wcAHgDz/y0A1v8cAPv/",
  "AwA7ABcABwDl/wcA0/8eAP//3v8CANH////7/wIA+/8WAPL//P8ZANz/GAD+/wMAGAAAAAMACgAPAPj/EwDw//z/DAD0/xAA",
  "BgD+/wMACwD0/wcABQDv/w0A/P/+/wMA9f/w/wAA8//k/wkA+f/6/w0A//8CABAAAgD7/woA9//+//7/7f/5//j/9//6//r/",
  "+f////r/9/////X/+f/9//X/+P/9//j//f////f/AAD9//n/AgD9//z/AgD9//3/AwD9/wAABQD//wMABAD+/wMAAwD+/wMA",
  "AQD9/wIA///9/wIA/v/+/wIA/f///wEA/f8AAAAA/f8AAAAA/f8BAP///v8BAP///v8BAP7///8BAP7///8AAP7/AAAAAP7/",
  "AAD///7/AAD/////AAD/////AAD/////AAAAAAAA/////////////////P8BAPz/AQD5/ygAcQCq/+z9ZP9RBCQAIvzSAsD/",
  "af4JBI/+zvrR/PABXgW//+H9YANrA2UBXwN+AG/+mgBK/2j/4QBZ/rL8xP1P/sv/hQDW/wv/hP74/nz/VwC0/4r/3v8y/5T/",
  "q/8TAPH/xf8QAK3/nv+H/7r/wv/g/6//sv/v/7T/NAD2/9//OQAtADIAHwA2ACMAQQAYAC4AVAAAACEAHAAIACQAPQAXABYA",
  "GgAAADQAFAAFACUAFwAcAEAAJwAJACcABwAhABsA5/8OAA4A//8aACMAEAAzAC0ADgAmAAUAAAAiAAkAAgAdAAUAAgALAO//",
  "AAAFAPL/BgAGAPD/BgAIAPH/DwAGAP3/GgAHAP7/EAAIAAUAEAAEAAgACQADAA0A///+/woABQAEAAYABwAKAAwADAAQAAgA",
  "DAAOAAUADwALAAEACAAEAP//CQACAP7/CAD//wEACQD+/wMACQD+/wMABwD9/wUABQD+/wcAAwD+/wYAAgD//wcAAAAAAAYA",
  "/v8BAAUA/v8CAAQA/v8DAAMA/v8DAAIA//8EAAEA//8EAAAAAAAEAP//AQADAP//AgADAP//AgACAAAAAwABAAAAAwABAAAA",
  "AgAAAAEAAgAAAAEAAQAAAAEAAQAAAAEAAQAAAAAAAAAAAAEAAAD//////v/9////+/////3/9f8CAB0AWQCV/5j+aP+1AwEC",
  "4PgJAZoG+fz8/an8ywDzA8r8cgD6Aa4CSf4t/SYFuP/f/eP/EAAnAln/rv4NAHn/4P4iALsAtf8O/7v+IP/EAFoBtP9V/yj/",
  "j/8kAGYArgDV/5v/9f6g/ygA/v87AIH/if9q//P/HwBCAFkAy/8oAMn/DgA1ABEACwDn/ysACQBHACMAWQB3AB8AIAD4/+T/",
  "7v9BAPn/6f/l/8X/DwDk/+v/6P/n/9H/8P8IAO3/KADx//P/CAD5/wMA8P/M/83//f/Y/wIACwDt/xkACgAOABoADwAAABMA",
  "BQAIACMA//8PAA8A/f8LAAYA8v/8//r/6v8IAPj/9v8IAPX//v8KAP//9v8KAAUAAgAKAP//AgAHAAMABQAVAAoABwAPAAYA",
  "DwAJAAkADwAIAAkACQAFAAcABgABAAYAAgAAAAQA//8CAAYAAQACAAQA//8BAAMA/v8DAAEA/v8DAAEA//8DAAEA//8DAP//",
  "AAADAP//AQADAP//AQACAP//AgABAP//AwABAP//AwABAAAABAAAAAEAAwAAAAEAAwAAAAIAAgAAAAIAAgAAAAIAAQAAAAIA",
  "AQAAAAIAAAABAAIAAAABAAEAAAABAAEAAAABAAEAAAABAAAAAAAAAAAAAAAAAAAA/////wIA+f8GAPj///8PANX/EwABATYA",
  "kfp4AX0IU/pF/84BX/p/BRoC4/4K/Aj+IQRz/lQEof7E/KL/WwAACkT/8voj/nj+MQMoApcAkP5U/0j+4P89AZr/DgDj/Wb+",
  "Vv5vAGAAqv/6ALb+HgCg/wYAlAAAALwAkP9HAAEARAA1AO3/JQDE/z8Axv9rAFMALAAiALL/DAAXAG8A7f/2/+3/4f/z/6H/",
  "CQD6/xAA8//l/9L/3P8WAOz/FgDt//D/5//n//b//v8TAOb/DADq/woAKwALABUADgAdAAwAGgDy//P/BAD1/xsA9v/t/wIA",
  "AAD5/wsAAQD5/xUA9v8CAAEA8P8AAPr/7//4//z/8P8JAPj/8P8KAPj/+f8HAAUA9v8JAAQA9/8NAAIA+f8EAAIA+v8IAP//",
  "/P8FAPT/AQAIAPv/+/////7/AgALAP7/BQAIAPv/BAAAAPf/AQD+//X////6//f/AwD6//r/AgD5//z/AgD5//7/AQD5////",
  "AAD4/wEAAAD7/wMA/v/8/wQA/v/+/wMA/f///wQA/P8AAAIA/P8BAAEA/f8CAAAA/f8CAP///f8CAP7///8BAP7///8BAP7/",
  "//8AAP3/AAAAAP7/AQD///7/AQD/////AQD/////AAD//wAAAAD//wAAAAAAAAAA////////AAAAAAAAAAABAP//AgAAAP7/",
  "AQA9AEcAXv8g/8L/NgGtAQD++QA9B0n85PW0BAkA1/LzAXoHHAHTBGwFkQRRAMn8xvx6ADwBoPxM/yf98P1gAYj/UQEqABQB",
  "7v92APIB7/5/AEj/z/9w/3L/MgE7/6AAof/T/4IABgByAJH/4P8r/zcAFAAkAM8A4f9zADUAhwAvAEwAEwDg/1gAkv9VABIA",
  "BwAkAOT/CADy/y4Ayf9CAOb/3/8pALj/DwDt/+7/2P8GANj/8/8kALn/GgDZ/9z/BQDe/9z/AAAfAAgAXgAhADMASQAKAC8A",
  "CQDs//P/EADm/wUABQDj/yUA9f/+/xEA8//1/wYA7f/o/wwA5v8IAAYA8P8UAAMAAAAOAAAA9f8TAPL/9v8dAO//+f8SAPP/",
  "5/8DAPT/8f8IAPP/AgAGAPf/AAAEAPj///8CAPL/AgD7//b/AwD5//z/AQD7//z/BAD3////AwD1/wMA///4/wMA/v/4/wMA",
  "/f/4/wUA+f/6/wQA+P/9/wMA+P/+/wMA+P8BAAEA+P8CAP//+v8DAP7/+/8DAP3//f8DAPz//v8DAPz/AAABAPv/AQAAAPv/",
  "AQD///z/AQD+//3/AQD9//3/AQD8//7/AAD8///////9/wAA///+/wAA//////////////////8=",
].join("");

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 → bytes. Hand-rolled because `atob` is a window/worker global that
 * AudioWorkletGlobalScope does not carry, and this module runs there.
 */
function b64Bytes(s) {
  const lut = new Int32Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) lut[B64_ALPHABET.charCodeAt(i)] = i;
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // '='
  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | lut[s.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * The set as one channel-major Float64Array of HRIR_CHANNELS × HRIR_LENGTH,
 * scaled to ±1. Built once per call — binaural.js caches the rate-converted
 * table it derives from this.
 */
function decodeShHrir() {
  const bytes = b64Bytes(HRIR_BASE64);
  const out = new Float64Array(HRIR_CHANNELS * HRIR_LENGTH);
  for (let i = 0; i < out.length; i++) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768.0;
  }
  return out;
}

// ══ src/engine/binaural.js ══
// Binaural monitoring (#998.3, rebuilt for item 128) — the render target that
// makes a surround song AUDIBLE on headphones while you compose it.
//
// Why this exists: playback normally installs StereoRenderer, which folds the
// rear semicircle onto the front and collapses elevation toward the centre. It
// is the right stereo DOWNMIX, but it is a projection: behind sounds exactly
// like in front, and height is inaudible. Authoring a position you cannot hear
// is a non-starter, so this file adds a second monitor path.
//
// ── How it works ──
// The bus channels ARE an ambisonic scene: `channelGains` is the SN3D/ACN
// encode (the same basis as the AmbiX export, spatial.js `encodeSN3D`), so a
// voice is amplitude-encoded into spherical harmonics exactly as it is for a
// B-format render. `monitorStereo` then decodes that scene to two ears with the
// GoogleVR/SADIE spherical-harmonic HRIR set — one 256-tap convolution per
// ambisonic channel, summed. Because the set is measured, the interaural delay,
// the head shadow and the pinna's spectral cues arrive with it; there is no
// head model here to tune, and no per-source filtering at all. The mixer calls
// `monitorStereo` once per frame IN ORDER, which is what lets this renderer be
// stateful (the convolution history) while every other renderer stays a pure
// function.
//
// The right ear costs nothing extra: a listener mirrored left↔right is the same
// listener, and mirroring flips the sign of every harmonic with m < 0 and
// leaves the rest alone. So one convolution per channel serves both ears —
// L = Σ_{m≥0} + Σ_{m<0}, R = Σ_{m≥0} − Σ_{m<0}. This is the trick Omnitone's
// HOAConvolver builds out of Web Audio nodes; here it is the two accumulators
// in the frame loop.
//
// See hrir-sadie.js for the data, its provenance and its licence. What replaced
// what: this used to be a parametric head (Woodworth ITD, Brown & Duda shadow,
// a tuned pinna notch) driven from a ring of virtual speakers. Measured beats
// parametric — front/back and height are now cues a real head measured rather
// than curves fitted by ear — and the ambisonic basis is both cheaper per
// source (no per-speaker filter bank) and honest about what the bus carries.
//
// Not a port: the Kotlin engine has no surround at all, so this file — like
// spatial.js — IS the reference implementation.




/** Monitor modes (playhead state). Fold = StereoRenderer, the default. */
const MONITOR_FOLD = 0;
const MONITOR_BINAURAL = 1;

/** The order the HRIR set decodes, capped by the basis spatial.js implements. */
const BIN_ORDER = Math.min(HRIR_ORDER, AMBISONIC_ORDER_MAX);
const BIN_SH_COUNT = (BIN_ORDER + 1) * (BIN_ORDER + 1);

/** Azimuth of the front axis — the direction the level contract is fixed at. */
const BIN_FRONT_AZIMUTH = 128;

/** Rate conversion of the HRIR set: Kaiser-windowed sinc, resampler.js's β. */
const BIN_RESAMP_HALF = 24;
const BIN_RESAMP_BETA = 8.0;

/**
 * ACN channels a source ON THE HORIZON can excite. Y_lm vanishes on the horizon
 * whenever l − |m| is odd, so for a planar song — where nothing ever leaves the
 * horizon — dropping those is EXACT, not an approximation, and it buys back six
 * of the sixteen convolutions. A spatial song keeps the whole set.
 */
function binauralChannelList(sphere) {
  const list = [];
  for (let l = 0; l <= BIN_ORDER; l++) {
    for (let m = -l; m <= l; m++) {
      if (sphere || (l - Math.abs(m)) % 2 === 0) list.push(l * l + l + m);
    }
  }
  return Int32Array.from(list);
}

/** +1 where mirroring the listener leaves the harmonic alone (m ≥ 0), −1 where
 *  it flips the sign (m < 0) — the right ear, in one array. */
function binauralMirrorSigns(acn) {
  const out = new Int8Array(acn.length);
  for (let i = 0; i < acn.length; i++) {
    const k = acn[i];
    const l = Math.floor(Math.sqrt(k));
    out[i] = k - (l * l + l) >= 0 ? 1 : -1; // k − (l²+l) IS m
  }
  return out;
}

function binBesselI0(x) {
  let sum = 1.0;
  let term = 1.0;
  const half = x * 0.5;
  for (let k = 1; k < 24; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Rate-convert the whole set (item 108: the engine runs at 48 kHz, which is the
 * rate the HRIRs were measured at, but a test or a future device may not).
 * These are IMPULSE RESPONSES, not signals, so the taps are scaled by 1/ratio:
 * what has to survive is the filter's response Σh·e^{−jωn}, not the sequence's
 * amplitude. Length is rounded up to a multiple of four for the convolver's
 * unrolled inner loop.
 */
function binauralResample(src, srcLen, channels, rate) {
  const ratio = rate / HRIR_RATE;
  const cutoff = ratio < 1.0 ? ratio : 1.0;      // of the SOURCE Nyquist
  const half = Math.ceil(BIN_RESAMP_HALF / cutoff);
  const dstLen = (Math.ceil(srcLen * ratio) + 3) & ~3;
  const out = new Float64Array(channels * dstLen);
  const norm = binBesselI0(BIN_RESAMP_BETA);
  const scale = 1.0 / ratio;
  for (let n = 0; n < dstLen; n++) {
    const t = n / ratio;
    const lo = Math.max(0, Math.ceil(t - half));
    const hi = Math.min(srcLen - 1, Math.floor(t + half));
    for (let i = lo; i <= hi; i++) {
      const d = t - i;
      const u = cutoff * d;
      const sinc = Math.abs(u) < 1e-9 ? 1.0 : Math.sin(Math.PI * u) / (Math.PI * u);
      const x = d / half;
      const w = binBesselI0(BIN_RESAMP_BETA * Math.sqrt(1.0 - x * x)) / norm;
      const g = cutoff * sinc * w * scale;
      for (let c = 0; c < channels; c++) out[c * dstLen + n] += src[c * srcLen + i] * g;
    }
  }
  return out;
}

/**
 * Level contract: a source dead ahead must leave the head carrying the same
 * total power the stereo pan law gives it (cos² + sin² = 1, i.e. 0.707 per ear,
 * exactly what the fold delivers). One scalar does it, folded into the table.
 * Every other direction is then free to differ, and does — a real head is
 * quieter behind and below, and that level cue is part of what makes the
 * direction audible rather than an artefact to flatten out.
 */
function binauralCalibration(hrir, len) {
  const sh = new Float64Array(BIN_SH_COUNT);
  encodeSN3D(BIN_FRONT_AZIMUTH, 0.0, BIN_ORDER, sh);
  const all = Int32Array.from({ length: BIN_SH_COUNT }, (_, k) => k);
  const mirror = binauralMirrorSigns(all);
  let energy = 0.0;
  for (let n = 0; n < len; n++) {
    let p = 0.0;
    let q = 0.0;
    for (let k = 0; k < BIN_SH_COUNT; k++) {
      const v = sh[k] * hrir[k * len + n];
      if (mirror[k] > 0) p += v; else q += v;
    }
    energy += (p + q) * (p + q) + (p - q) * (p - q);
  }
  return 1.0 / Math.sqrt(energy);
}

/** The decoded, rate-converted, calibrated set — one build per rate, ever. */
const binauralTables = new Map();

function binauralHrirTable(rate = SAMPLING_RATE) {
  let t = binauralTables.get(rate);
  if (t !== undefined) return t;
  const raw = decodeShHrir();
  const hrir = rate === HRIR_RATE
    ? raw
    : binauralResample(raw, HRIR_LENGTH, HRIR_CHANNELS, rate);
  const taps = hrir.length / HRIR_CHANNELS;
  const gain = binauralCalibration(hrir, taps);
  for (let i = 0; i < hrir.length; i++) hrir[i] *= gain;
  t = { hrir, taps };
  binauralTables.set(rate, t);
  return t;
}

/**
 * Headphone render target: the bus carries an ambisonic scene, and the monitor
 * pair is that scene decoded through the SADIE HRIRs. `numChannels` is the
 * harmonic count — 16 for a spatial song, 10 for a planar one — so the decode
 * costs that many taps-long convolutions per frame, and the encode costs the
 * same handful of multiplies per voice the AmbiX export costs.
 */
class BinauralRenderer {
  constructor(sphere = true, sampleRate = SAMPLING_RATE) {
    this.sphere = sphere;
    this.acn = binauralChannelList(sphere);
    this.numChannels = this.acn.length;
    this.name = `binaural-${sphere ? "3d" : "2d"}`;
    this.sampleRate = sampleRate;
    this.order = BIN_ORDER;

    const table = binauralHrirTable(sampleRate);
    this.taps = table.taps;
    // The set's channels, gathered into bus order so the frame loop walks both
    // the history and the taps straight forward.
    this.hrir = new Float64Array(this.numChannels * this.taps);
    for (let c = 0; c < this.numChannels; c++) {
      this.hrir.set(table.hrir.subarray(this.acn[c] * this.taps, (this.acn[c] + 1) * this.taps),
        c * this.taps);
    }
    this.mirror = binauralMirrorSigns(this.acn);

    // Convolution history: every sample is written twice, `taps` apart, so a
    // backwards run of `taps` taps is always one contiguous stretch — no
    // index masking in the innermost loop.
    this.hist = new Float64Array(this.numChannels * this.taps * 2);
    this.histPos = 0;
    this._sh = new Float64Array(BIN_SH_COUNT);
  }

  /** Drop the convolution history (a new song, or a monitor switch). */
  reset() {
    this.hist.fill(0.0);
    this.histPos = 0;
  }

  /** Ambisonic encode — the bus channel gains for a source at (az, el). */
  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, BIN_ORDER, this._sh);
    const acn = this.acn;
    for (let c = 0; c < acn.length; c++) out[off + c] = sh[acn[c]];
  }

  /**
   * Decode one frame to two ears (the mixer calls this in frame order, which is
   * what makes the history below legal): one FIR per ambisonic channel, summed
   * into the symmetric and antisymmetric halves, then L = P + N, R = P − N.
   */
  monitorStereo(data, frames, n, out) {
    const nc = this.numChannels;
    const taps = this.taps;
    const hrir = this.hrir;
    const hist = this.hist;
    const mirror = this.mirror;
    const pos = this.histPos;
    let p = 0.0;
    let q = 0.0;

    for (let c = 0; c < nc; c++) {
      const base = c * taps * 2;
      const x = data[c * frames + n];
      hist[base + pos] = x;
      hist[base + pos + taps] = x;

      // Four accumulators: the tap loop is one long dependent chain of adds
      // otherwise, and breaking it is worth ~35 % of the whole decode.
      const hb = c * taps;
      const head = base + pos + taps;
      let a0 = 0.0;
      let a1 = 0.0;
      let a2 = 0.0;
      let a3 = 0.0;
      for (let i = 0; i < taps; i += 4) {
        a0 += hrir[hb + i] * hist[head - i];
        a1 += hrir[hb + i + 1] * hist[head - i - 1];
        a2 += hrir[hb + i + 2] * hist[head - i - 2];
        a3 += hrir[hb + i + 3] * hist[head - i - 3];
      }
      const acc = (a0 + a1) + (a2 + a3);
      if (mirror[c] > 0) p += acc; else q += acc;
    }

    this.histPos = pos + 1 === taps ? 0 : pos + 1;
    out[0] = p + q;
    out[1] = p - q;
  }
}

// ══ src/engine/speakers.js ══
// ITU speaker layouts and their render target (#998.6) — quadraphonic, 5.1 and
// 7.1 export.
//
// Like every other renderer, this one only answers "what gain does a source at
// (az, el) get in each of my channels?" — the mixer, the voices and the effects
// know nothing about it. It is not loaded by the worklet: playback monitors in
// stereo or binaural, and speaker feeds are an EXPORT target.
//
// ── Placement ──
// Angles are BS.775 / BS.2051: ±30° front pair, centre dead ahead, ±110°
// surrounds (quad drops the centre and the LFE), and for 7.1 the BS.2051
// System C split of ±90° sides and ±135° rears. Channel ORDER is the Microsoft
// WAVEFORMATEXTENSIBLE order that goes with each mask (…, BL, BR, SL, SR),
// which is what every DAW expects from a .wav; the ADM labels below carry the
// ITU names, where the sign convention is the opposite one (M+030 is LEFT).
// Note this is a different ordering question from a multi-channel SAMPLE's
// channels (spatial.js SAMPLE_CHANNEL_LAYOUT) — that order is fixed by the
// file format's 's' block, this one by the container we write.
//
// ── The LFE ──
// stays silent. There is no bass-management stage in this engine, and folding
// low frequencies into a separate channel would change the sound of the mix for
// anyone whose player redirects it back. The channel exists because the format
// has it; a mastering engineer fills it.


const SPK_AZ_PER_DEG = AZIMUTH_TURN / 360;
const SPK_EL_TO_RAD = Math.PI / 256; // 128 elevation units = 90°

/**
 * `deg` is degrees CLOCKWISE from front (negative = left), the same convention
 * as SAMPLE_CHANNEL_LAYOUT; `label` is the WAV/DAW name and `adm` the BS.2051
 * one. `mask` is the WAVEFORMATEXTENSIBLE dwChannelMask for the whole layout.
 */
const SPEAKER_LAYOUTS = Object.freeze({
  quad: {
    name: "quad",
    mask: 0x0033, // FL | FR | BL | BR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "Ls", adm: "M+110", deg: -110 },
      { label: "Rs", adm: "M-110", deg: 110 },
    ],
  },
  "5.1": {
    name: "5.1",
    mask: 0x003f, // FL | FR | FC | LFE | BL | BR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "C", adm: "M+000", deg: 0 },
      { label: "LFE", adm: "LFE1", deg: 0, lfe: true },
      { label: "Ls", adm: "M+110", deg: -110 },
      { label: "Rs", adm: "M-110", deg: 110 },
    ],
  },
  "7.1": {
    name: "7.1",
    mask: 0x063f, // FL | FR | FC | LFE | BL | BR | SL | SR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "C", adm: "M+000", deg: 0 },
      { label: "LFE", adm: "LFE1", deg: 0, lfe: true },
      { label: "Lrs", adm: "M+135", deg: -135 },
      { label: "Rrs", adm: "M-135", deg: 135 },
      { label: "Lss", adm: "M+090", deg: -90 },
      { label: "Rss", adm: "M-090", deg: 90 },
    ],
  },
});

/** Layout names in the order the UI offers them (fewest channels first). */
const SPEAKER_LAYOUT_NAMES = Object.freeze(["quad", "5.1", "7.1"]);

/** Engine azimuth of a speaker (front = 128, clockwise). */
function speakerAzimuth(deg) {
  return wrapAzimuth(128 + deg * SPK_AZ_PER_DEG);
}

/**
 * Speaker-feed render target. Sources are panned pairwise around the horizontal
 * ring — constant power between the two speakers that bracket them, which is
 * the classic surround panner and is exact at every speaker — and elevation,
 * which no ITU layout can reproduce, spreads the source evenly over the ring as
 * it climbs, reaching a fully diffuse image at the poles. That keeps the level
 * constant and the movement continuous, and it is the same idea as the stereo
 * fold's collapse toward the centre, generalised to n speakers.
 */
class SpeakerRenderer {
  constructor(layoutName) {
    const layout = SPEAKER_LAYOUTS[layoutName];
    if (!layout) throw new Error(`unknown speaker layout: ${layoutName}`);
    this.layout = layout;
    this.name = `speakers-${layout.name}`;
    this.numChannels = layout.speakers.length;

    // Ring = every non-LFE speaker, sorted by azimuth so the bracketing pair is
    // a search away rather than a special case per layout.
    const ring = [];
    for (let i = 0; i < layout.speakers.length; i++) {
      const s = layout.speakers[i];
      if (s.lfe) continue;
      ring.push({ channel: i, az: speakerAzimuth(s.deg) });
    }
    ring.sort((a, b) => a.az - b.az);
    this.ringChannel = Int32Array.from(ring, (r) => r.channel);
    this.ringAz = Float64Array.from(ring, (r) => r.az);
    this.ringSize = ring.length;

    // Stereo monitor: fold each speaker as if it were itself a source, so the
    // preview agrees with what the stereo export of the same song would give.
    const fold = new StereoRenderer();
    this.monitorGains = new Float64Array(this.numChannels * 2);
    for (let i = 0; i < layout.speakers.length; i++) {
      if (layout.speakers[i].lfe) continue;
      fold.channelGains(speakerAzimuth(layout.speakers[i].deg), 0, this.monitorGains, i * 2);
    }
  }

  channelGains(az, el, out, off) {
    const n = this.numChannels;
    for (let c = 0; c < n; c++) out[off + c] = 0.0;

    const size = this.ringSize;
    const a = wrapAzimuth(az);
    // The bracketing pair, with the wrap-around arc as the last segment.
    let i = size - 1;
    for (let k = 0; k < size; k++) {
      if (a < this.ringAz[k]) { i = (k - 1 + size) % size; break; }
    }
    const j = (i + 1) % size;
    const a0 = this.ringAz[i];
    let span = this.ringAz[j] - a0;
    if (span <= 0) span += AZIMUTH_TURN;
    let d = a - a0;
    if (d < 0) d += AZIMUTH_TURN;
    const t = (d / span) * (Math.PI / 2);
    out[off + this.ringChannel[i]] = Math.cos(t);
    out[off + this.ringChannel[j]] = Math.sin(t);

    // Height has nowhere to go in a planar layout: spread it instead.
    const w = Math.abs(Math.sin(el * SPK_EL_TO_RAD));
    if (w > 0) {
      const diffuse = w / size;
      for (let k = 0; k < size; k++) {
        const c = off + this.ringChannel[k];
        out[c] = Math.sqrt((1 - w) * out[c] * out[c] + diffuse);
      }
    }
  }

  monitorStereo(data, frames, n, out) {
    let l = 0.0;
    let r = 0.0;
    for (let c = 0; c < this.numChannels; c++) {
      const v = data[c * frames + n];
      l += v * this.monitorGains[c * 2];
      r += v * this.monitorGains[c * 2 + 1];
    }
    out[0] = l;
    out[1] = r;
  }
}

// ══ src/engine/analysis.js ══
// Master-bus analysis tap (item 98) — what the mastering strip looks at.
//
// The strip asks two different questions, and they want two different signals:
//
//   * "where is the energy in the room?" — the vectorscopes. That is a question
//     about the SOUND FIELD, not about any particular set of speakers, so the
//     scope tap is always first-order B-format (ACN/SN3D: W Y Z X). The three
//     Goniometer views are then literally axis pairs of that field — top = Y·X
//     (left-right against front-back), front = Y·Z, side = X·Z — and no view
//     needs a decode. A STEREO song has no front-back axis at all, so its tap
//     is taken from the finished mix instead: W = (L+R)/√2, Y = (L−R)/√2, which
//     is exactly the stereo→B-format encoding of a ±90° pair, and makes the top
//     view the classic mid/side goniometer. One display, every model.
//
//   * "will it clip, and how loud is it?" — the meters. That IS a question
//     about a target: 5.1's centre channel is only a thing if you are mastering
//     for 5.1. So the meters read a metering TARGET the user picks, rendered
//     through the very same renderers the exporter uses (speakers.js), which is
//     what makes the bars agree with the file that comes out.
//
// ── The ambisonic case ──
// There are no speakers to meter, so per-speaker levels are meaningless. What
// IS meaningful is the acoustic energy density of the encoded field,
//
//     E = (W² + X² + Y² + Z²) / 2
//
// which for SN3D order 1 reads p² for a plane wave from ANY direction and sums
// correctly over uncorrelated sources — a direction-invariant loudness that
// needs no decode and no listening position. Peak is per encoded CHANNEL (that
// is what clips in the exported file), oversampled 4× for the inter-sample
// peaks a later decode or resample would expose.
//
// Not a port: the Kotlin engine has no surround and no analysis tap, so this
// file — like spatial.js and binaural.js — IS the reference implementation.
//
// COST: everything here is opt-in. The tap is built only while the strip is on
// screen, and a stereo song never pays for a bus at all (its tap is two adds on
// the finished mix). See TrackerState.setAnalysis.




/** Metering targets. The value is the wire form (CMD.SET_ANALYSIS.target). */
const ANALYSIS_OFF = "off";
const ANALYSIS_STEREO = "stereo";
const ANALYSIS_AMBISONIC = "ambisonic";
/** …plus every key of SPEAKER_LAYOUTS ("quad", "5.1", "7.1"). */

/**
 * Scope ring: frames of B-format held for the vectorscopes. 4096 frames is
 * 85 ms at 48 kHz — five snapshot intervals, so a 60 fps strip never misses a
 * sample, and the cloud it draws is a WIDE window: many points, and only about
 * an eighth of them replaced per frame, which is what makes the shape settle
 * instead of flickering. The ring rides in the snapshot (64 KiB), so this is
 * also what the wire pays.
 */
const SCOPE_FRAMES = 4096;
/**
 * SECOND-ORDER ACN/SN3D — W Y Z X, then the five order-2 harmonics, in the
 * ring's interleave order.
 *
 * The scopes and the radiation surface only ever read the first four, and for
 * them order 1 IS the field. The soundfield cloud needs the rest, because at
 * first order some genuinely different scenes are the SAME four numbers: two
 * sources in anti-phase cancel in W entirely, and a pair at ±15° then encodes
 * identically to a pair at ±90°. Nothing downstream can undo that. The order-2
 * quadrupole breaks the tie and recovers both bearings exactly (see cloud.js).
 *
 * COST: the ring is the snapshot's largest block, and this takes it from 64 KiB
 * to 144 KiB. It is still built only while the strip is on screen.
 */
const SCOPE_CHANNELS = 9;
const SCOPE_W = 0, SCOPE_Y = 1, SCOPE_Z = 2, SCOPE_X = 3;
/** First of the five order-2 harmonics (ACN 4..8). */
const SCOPE_ORDER2 = 4;
/** The ambisonic order the ring carries. */
const SCOPE_ORDER = 2;

/** Widest metered channel set (7.1). Bounds the snapshot's meter block. */
const ANALYSIS_MAX_METERS = 8;

const SQRT1_2 = Math.SQRT1_2;

/** Which signals the meters read for a given target. */
const METER_MIX = 0;       // the finished stereo mix (fold or binaural)
const METER_FOA = 1;       // the encoded field's own channels
const METER_SPEAKERS = 2;  // speaker feeds, exactly as the exporter writes them

/**
 * Channel labels for a target, in meter order — the UI draws these under the
 * bars, and they are the same names speakers.js gives the exporter.
 */
function meterLabels(target) {
  if (target === ANALYSIS_STEREO) return ["L", "R"];
  // Meter order is W Y X Z, not the ring's ACN order: it puts the three
  // channels a planar song can actually excite first, so its meter strip is
  // three live bars instead of three live bars and a dead one.
  if (target === ANALYSIS_AMBISONIC) return ["W", "Y", "X", "Z"];
  const layout = SPEAKER_LAYOUTS[target];
  return layout ? layout.speakers.map((s) => s.label) : [];
}

/**
 * How a speaker layout's bars are ARRANGED on screen: left to right the way the
 * speakers stand around the listener, rather than in the file's channel order.
 * The LFE is not drawn at all — the exporter leaves it silent by design
 * (speakers.js), so a bar for it would only ever be a dead one.
 */
const METER_ARRANGEMENT = Object.freeze({
  quad: ["Ls", "L", "R", "Rs"],
  "5.1": ["Ls", "L", "C", "R", "Rs"],
  "7.1": ["Lrs", "Lss", "L", "C", "R", "Rss", "Rrs"],
});

/**
 * The meter strip as it is drawn: {label, channel} pairs, where `channel` is
 * the index the tap meters that signal on. Anything the arrangement leaves out
 * (the LFE) simply has no entry.
 */
function meterDisplay(target) {
  const labels = meterLabels(target);
  const order = METER_ARRANGEMENT[target];
  if (!order) return labels.map((label, channel) => ({ label, channel }));
  const out = [];
  for (const label of order) {
    const channel = labels.indexOf(label);
    if (channel >= 0) out.push({ label, channel });
  }
  return out;
}

/**
 * The targets that make sense for a surround model. A stereo song has exactly
 * one (there is nowhere else for the sound to go); a planar song can be
 * mastered for any ring; a spatial one additionally for a full-sphere basis.
 * The UI hides everything not listed here — item 98's "nonsensical options are
 * hidden" rule, applied to the meters.
 */
function availableTargets(model) {
  if (model === SURROUND_STEREO) return [ANALYSIS_STEREO];
  return [ANALYSIS_STEREO, "quad", "5.1", "7.1", ANALYSIS_AMBISONIC];
}

// ── 4× true-peak oversampler ────────────────────────────────────────────────
// A 32-tap windowed sinc split into 4 polyphase branches of 8 taps. Each branch
// is normalised to unity DC gain on its own, so a constant input reads back as
// itself and the oversampled peak can never sit BELOW the sample peak for a
// steady signal. No branch is the identity (the linear-phase delay 15.5 is not
// a multiple of 4), so the sample peak is tracked separately and folded in.

const TP_PHASES = 4;
const TP_TAPS = 8;

const TP_COEF = (() => {
  const n = TP_PHASES * TP_TAPS;
  const h = new Float64Array(n);
  const centre = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - centre) / TP_PHASES;
    const sinc = t === 0 ? 1.0 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
  }
  // Per-branch DC normalisation (see above).
  for (let p = 0; p < TP_PHASES; p++) {
    let s = 0.0;
    for (let k = 0; k < TP_TAPS; k++) s += h[k * TP_PHASES + p];
    if (s !== 0) for (let k = 0; k < TP_TAPS; k++) h[k * TP_PHASES + p] /= s;
  }
  return h;
})();

/**
 * Per-channel inter-sample peak detector. `channels` histories are kept side by
 * side; `push` returns nothing and `peak(c)` is read at drain time.
 */
class TruePeakDetector {
  constructor(channels) {
    this.channels = channels;
    this.hist = new Float64Array(channels * TP_TAPS); // newest first
    this.peaks = new Float64Array(channels);
  }

  reset() {
    this.hist.fill(0.0);
    this.peaks.fill(0.0);
  }

  /** Feed one sample of channel `c` and fold its 4 interpolated points in. */
  push(c, v) {
    const base = c * TP_TAPS;
    const h = this.hist;
    for (let k = TP_TAPS - 1; k > 0; k--) h[base + k] = h[base + k - 1];
    h[base] = v;
    let hi = this.peaks[c];
    for (let p = 0; p < TP_PHASES; p++) {
      let acc = 0.0;
      for (let k = 0; k < TP_TAPS; k++) acc += h[base + k] * TP_COEF[k * TP_PHASES + p];
      const a = acc < 0 ? -acc : acc;
      if (a > hi) hi = a;
    }
    this.peaks[c] = hi;
  }

  clearPeaks() { this.peaks.fill(0.0); }
}

/**
 * The same oversampler, one channel at a time, reporting the instantaneous
 * inter-sample peak instead of accumulating one.
 *
 * The mastering limiter (mastering.js) uses this for its true-peak mode, which
 * is why it lives here beside the detector rather than being written out again
 * over there: a limiter and a meter that disagree about what "true peak" means
 * would make the ceiling a suggestion.
 */
class TruePeakProbe {
  constructor() { this.hist = new Float64Array(TP_TAPS); }
  reset() { this.hist.fill(0.0); }
  /** Largest magnitude among `v` and the four points interpolated around it. */
  push(v) {
    const h = this.hist;
    for (let k = TP_TAPS - 1; k > 0; k--) h[k] = h[k - 1];
    h[0] = v;
    let hi = v < 0 ? -v : v;
    for (let p = 0; p < TP_PHASES; p++) {
      let acc = 0.0;
      for (let k = 0; k < TP_TAPS; k++) acc += h[k] * TP_COEF[k * TP_PHASES + p];
      const a = acc < 0 ? -acc : acc;
      if (a > hi) hi = a;
    }
    return hi;
  }
}

// ── The analysis render target ──────────────────────────────────────────────

/**
 * Channels 0..3 are always the B-format scope tap; a speaker target appends its
 * own feeds after them, so ONE bus serves both halves of the strip and every
 * voice's gains are computed once per direction change.
 *
 * It is a SpatialRenderer like any other — the mixer cannot tell it apart from
 * the exporter's — but it is never a monitor, so `monitorStereo` is only the
 * FOA virtual-stereo decode the correlation meter uses.
 */
class AnalysisRenderer {
  constructor(speakerLayout = null) {
    this.speakers = speakerLayout === null ? null : new SpeakerRenderer(speakerLayout);
    this.numChannels = SCOPE_CHANNELS + (this.speakers === null ? 0 : this.speakers.numChannels);
    this.name = `analysis-${speakerLayout ?? "foa"}`;
    this._sh = new Float64Array(SCOPE_CHANNELS);
  }

  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, SCOPE_ORDER, this._sh);
    for (let c = 0; c < SCOPE_CHANNELS; c++) out[off + c] = sh[c];
    if (this.speakers !== null) this.speakers.channelGains(az, el, out, off + SCOPE_CHANNELS);
  }

  /** W ± Y — the coincident cardioid pair, i.e. the stereo the field would fold to. */
  monitorStereo(data, frames, n, out) {
    const w = data[n];
    const y = data[frames + n];
    out[0] = (w + y) * SQRT1_2;
    out[1] = (w - y) * SQRT1_2;
  }
}

// ── The tap ─────────────────────────────────────────────────────────────────

/**
 * Accumulates everything the strip needs over a chunk and hands it to the
 * snapshot: a ring of B-format frames (scopes), per-channel peak / true peak /
 * mean square / clip count (meters), the field energy integral (the ambisonic
 * RMS) and the three correlation sums.
 *
 * Meters and correlation are drained per snapshot (~16 ms) and integrated by
 * the UI, which is where the ballistics belong — the engine ships numbers, not
 * a look.
 */
class AnalysisTap {
  /**
   * @param {string} target one of ANALYSIS_STEREO / ANALYSIS_AMBISONIC / a SPEAKER_LAYOUTS key
   * @param {number} model  the song's surround model (SURROUND_*)
   */
  constructor(target, model) {
    this.target = target;
    this.model = model;
    const stereoSong = model === SURROUND_STEREO;
    const layout = SPEAKER_LAYOUTS[target] ? target : null;

    // A stereo song's field is derived from the finished mix (two adds per
    // frame), so it needs no bus and no per-voice work whatsoever. Any other
    // model already runs an object bus for the monitor; this is the second one.
    this.bus = stereoSong ? null : new SpatialBus(new AnalysisRenderer(layout), TRACKER_CHUNK);

    if (stereoSong || target === ANALYSIS_STEREO) {
      this.meterSource = METER_MIX;
      this.meterCount = 2;
    } else if (layout !== null) {
      this.meterSource = METER_SPEAKERS;
      this.meterCount = SPEAKER_LAYOUTS[layout].speakers.length;
    } else {
      this.meterSource = METER_FOA;
      // A planar song can never excite Z; metering it would be a permanently
      // dead bar, so the ambisonic meter drops it (the exported AmbiX file
      // still carries the full basis — see #998.4).
      this.meterCount = model === SURROUND_SPATIAL ? 4 : 3;
    }

    this.ring = new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS);
    this.ringWrite = 0; // frame index into the ring (wraps; the UI reads backwards)

    this.peak = new Float64Array(ANALYSIS_MAX_METERS);
    this.sumsq = new Float64Array(ANALYSIS_MAX_METERS);
    this.clip = new Float64Array(ANALYSIS_MAX_METERS);
    this.tp = new TruePeakDetector(this.meterCount);
    this.frames = 0;
    this.fieldEnergy = 0.0;
    this.corrLL = 0.0;
    this.corrRR = 0.0;
    this.corrLR = 0.0;
    this._meters = new Float64Array(ANALYSIS_MAX_METERS);
  }

  /** Per-chunk: the bus is an accumulator like the monitor's. */
  begin() {
    if (this.bus !== null) this.bus.clear();
  }

  /**
   * Fold one rendered chunk in. `mixL`/`mixR` are the finished device pair
   * (post fold/binaural, post Amiga filter, post clamp) — which is exactly what
   * a stereo export writes, so the stereo meters read the delivered signal
   * rather than the pre-master bus.
   */
  finish(frames, mixL, mixR) {
    const bus = this.bus;
    const data = bus === null ? null : bus.data;
    const busFrames = bus === null ? 0 : bus.frames;
    const nc = this.meterCount;
    const src = this.meterSource;
    const ring = this.ring;
    const m = this._meters;

    for (let n = 0; n < frames; n++) {
      let w, y, z, x;
      if (data === null) {
        // Stereo song: the ±90° pair encoding, which is also the inverse of the
        // monitorStereo decode above.
        const l = mixL[n];
        const r = mixR[n];
        w = (l + r) * SQRT1_2;
        y = (l - r) * SQRT1_2;
        z = 0.0;
        x = 0.0;
      } else {
        w = data[n];
        y = data[busFrames + n];
        z = data[2 * busFrames + n];
        x = data[3 * busFrames + n];
      }

      const rw = this.ringWrite * SCOPE_CHANNELS;
      ring[rw] = w;
      ring[rw + 1] = y;
      ring[rw + 2] = z;
      ring[rw + 3] = x;
      // The order-2 harmonics ride along untouched; a stereo song has none (it
      // has no bus at all), and its ring simply carries zeros there.
      if (data === null) {
        for (let c = SCOPE_ORDER2; c < SCOPE_CHANNELS; c++) ring[rw + c] = 0;
      } else {
        for (let c = SCOPE_ORDER2; c < SCOPE_CHANNELS; c++) {
          ring[rw + c] = data[c * busFrames + n];
        }
      }
      this.ringWrite = (this.ringWrite + 1) % SCOPE_FRAMES;

      this.fieldEnergy += (w * w + x * x + y * y + z * z) * 0.5;

      // Correlation is always measured on a stereo pair: the mix itself when
      // there is one, otherwise the field's virtual stereo decode.
      let cl, cr;
      if (data === null) {
        cl = mixL[n];
        cr = mixR[n];
      } else {
        cl = (w + y) * SQRT1_2;
        cr = (w - y) * SQRT1_2;
      }
      this.corrLL += cl * cl;
      this.corrRR += cr * cr;
      this.corrLR += cl * cr;

      if (src === METER_MIX) {
        m[0] = mixL[n];
        m[1] = mixR[n];
      } else if (src === METER_FOA) {
        m[0] = w; m[1] = y; m[2] = x; m[3] = z; // meterLabels order, not ACN
      } else {
        for (let c = 0; c < nc; c++) m[c] = data[(SCOPE_CHANNELS + c) * busFrames + n];
      }
      for (let c = 0; c < nc; c++) {
        const v = m[c];
        const a = v < 0 ? -v : v;
        if (a > this.peak[c]) this.peak[c] = a;
        this.sumsq[c] += v * v;
        // The mix bus is hard-clamped to ±1, so a sample AT full scale is a
        // clipped one; an object/speaker bus is unclamped and only exceeding
        // full scale would clip the file it is written to.
        if (a >= 1.0) this.clip[c] += 1;
        this.tp.push(c, v);
      }
    }
    this.frames += frames;
  }

  /** Snapshot readout; resets the accumulators (peaks included — the UI holds
   *  the hold/decay, so a stale peak can never stick here). */
  drain(out) {
    out.frames = this.frames;
    out.fieldEnergy = this.fieldEnergy;
    out.corrLL = this.corrLL;
    out.corrRR = this.corrRR;
    out.corrLR = this.corrLR;
    out.ringWrite = this.ringWrite;
    out.meterCount = this.meterCount;
    for (let c = 0; c < this.meterCount; c++) {
      const tp = this.tp.peaks[c];
      out.peak[c] = this.peak[c];
      out.truePeak[c] = tp > this.peak[c] ? tp : this.peak[c];
      out.meanSquare[c] = this.frames > 0 ? this.sumsq[c] / this.frames : 0.0;
      out.clip[c] = this.clip[c];
    }
    this.frames = 0;
    this.fieldEnergy = 0.0;
    this.corrLL = this.corrRR = this.corrLR = 0.0;
    this.peak.fill(0.0);
    this.sumsq.fill(0.0);
    this.clip.fill(0.0);
    this.tp.clearPeaks();
    return out;
  }
}

/** A drain target, so the snapshot fill allocates nothing. */
function makeAnalysisReadout() {
  return {
    frames: 0, fieldEnergy: 0, corrLL: 0, corrRR: 0, corrLR: 0, ringWrite: 0, meterCount: 0,
    peak: new Float64Array(ANALYSIS_MAX_METERS),
    truePeak: new Float64Array(ANALYSIS_MAX_METERS),
    meanSquare: new Float64Array(ANALYSIS_MAX_METERS),
    clip: new Float64Array(ANALYSIS_MAX_METERS),
  };
}

// ══ src/engine/mastering.js ══
// Master-bus mastering chain (item 178) — the last thing that touches the mix
// before it narrows to 8 bits.
//
// It sits inside the output stage: the voices sum in binary64, the Amiga chain
// runs, the pair narrows to binary32 — and THEN this runs, before the clamp and
// the dither. That position is the whole point. A limiter downstream of the
// clamp would have nothing left to do, and a chain upstream of the Amiga filter
// would be mastering a signal the device never delivers.
//
// ── What it is not ──
// It makes no judgements. Every stage is a textbook block with the parameter it
// says on the tin, in a FIXED order, and nothing here looks at the music and
// decides anything. That is a design constraint, not a shortcoming: the meters
// (loudness.js) tell you what the song is doing, and you decide.
//
//     trim → high-pass → 4-band EQ → compressor → width → limiter → gain
//
// Every stage has its own on/off; the chain as a whole has one more. With
// nothing engaged the chain is not merely transparent, it is ABSENT —
// masteringEngaged() returns false and the mixer keeps the untouched legacy
// path, so a song that has never been near this tab still renders bit-for-bit
// as it did before the tab existed.
//
// Not a port: the Kotlin engine has no mastering stage, so this file — like
// spatial.js, binaural.js and analysis.js — IS the reference implementation.
// See TAUD_ENGINE_SPEC.md §12.1 for the normative description and
// TAUD_FILE_FORMAT.md §9.12 for the `sMst` section that carries the parameters.
//
// DETERMINISM: coefficients are computed in binary64 from binary32 parameters
// (the section stores f32), and the per-sample maths is binary64 like the rest
// of the mix bus. The narrowing to binary32 still happens exactly once, after
// this, where it always did.


// The limiter's true-peak mode reads the same 4× polyphase oversampler the
// master-strip meters do (analysis.js) — one kernel, so the ceiling the limiter
// holds and the number the meter reports are the same measurement.

// ── Parameter model ─────────────────────────────────────────────────────────

/** EQ band shapes. The value is the wire form (`sMst` band type byte). */
const EQ_LOW_SHELF = 0;
const EQ_PEAKING = 1;
const EQ_HIGH_SHELF = 2;
/** Bands in the EQ. Fixed: four is enough to be useful and few enough to read. */
const EQ_BANDS = 4;

/** Compressor detector. Peak is what a limiter-ish setting wants; RMS is what a
 *  levelling setting wants. Both are LINKED across the pair — a detector per
 *  channel moves the stereo image whenever one side is louder, which is a thing
 *  no one has ever asked a mastering compressor to do. */
const COMP_PEAK = 0;
const COMP_RMS = 1;

/** High-pass slopes, in dB/octave. 12 is one Butterworth section, 24 is two. */
const HP_SLOPE_12 = 0;
const HP_SLOPE_24 = 1;

/**
 * Look-ahead, in milliseconds, of the limiter's gain computer — and therefore
 * the chain's latency whenever the limiter is on (twice this: see LimiterStage
 * for why the delay is two windows and not one). Fixed rather than exposed:
 * it is the one number in here whose value is a trade against latency rather
 * than against sound, and 1 ms of it is enough to turn every attack into a
 * ramp at every tempo.
 */
const LIMITER_LOOKAHEAD_MS = 1.0;

/** Parameter ranges, as the UI and the codec both clamp them. */
const RANGE = Object.freeze({
  trimDb: [-24, 24],
  hpFreq: [10, 500],
  eqFreq: [20, 20000],
  eqGainDb: [-18, 18],
  eqQ: [0.1, 12],
  compThreshDb: [-60, 0],
  compRatio: [1, 20],
  compAttackMs: [0.1, 300],
  compReleaseMs: [5, 3000],
  compKneeDb: [0, 24],
  compMakeupDb: [-12, 24],
  width: [0, 2],
  limCeilingDb: [-24, 0],
  limReleaseMs: [1, 1000],
  outGainDb: [-24, 24],
});

/**
 * Clamp to a control's range AND narrow to binary32.
 *
 * The narrowing is not incidental: `sMst` stores every parameter as an IEEE
 * binary32, so a value the editor holds in binary64 would come back from a save
 * as something very slightly different and the chain would drift a hair on
 * every round trip. Rounding here makes the document hold exactly what the file
 * will hold, which is also what lets a saved song be compared byte-for-byte
 * with the one still on screen.
 */
const clampRange = (v, key, fallback) => {
  const [lo, hi] = RANGE[key];
  // A field the caller left out (or a NaN a corrupt file produced) falls back
  // to the stage's own resting value, NOT to the bottom of its range: a partial
  // record is "these are the parts I care about", and reading the rest as
  // −24 dB of trim would silently rebuild the chain around it.
  if (!Number.isFinite(v)) return Math.fround(fallback);
  return Math.fround(v < lo ? lo : v > hi ? hi : v);
};

/**
 * The neutral chain. Every stage off, every control at the value it would rest
 * at — so turning a stage on changes nothing until you move something, which is
 * what makes A/B against the untouched mix mean anything.
 */
function defaultMastering() {
  // Narrowed to binary32 like everything else that reaches the chain (see
  // clampRange): the default record has to be a FIXED POINT of
  // normaliseMastering, or "is this chain untouched?" — which decides whether
  // the file carries an `sMst` section at all — is false for a project nobody
  // has been near.
  return f32Record({
    on: false,
    trimDb: 0,
    hpOn: false, hpFreq: 20, hpSlope: HP_SLOPE_12,
    eqOn: false,
    // The four bands start ENGAGED. At 0 dB an RBJ section is the identity
    // (A = 1 makes its numerator and denominator the same three numbers), so a
    // live band that nobody has moved changes nothing — and switching the
    // equaliser on then dragging a gain slider does what it looks like it
    // should, instead of doing nothing until you find the band's own switch.
    // The unit switch above is still off, so an untouched chain is still
    // entirely absent.
    eq: [
      { on: true, type: EQ_LOW_SHELF, freq: 100, gainDb: 0, q: 0.707 },
      { on: true, type: EQ_PEAKING, freq: 400, gainDb: 0, q: 1.0 },
      { on: true, type: EQ_PEAKING, freq: 2500, gainDb: 0, q: 1.0 },
      { on: true, type: EQ_HIGH_SHELF, freq: 8000, gainDb: 0, q: 0.707 },
    ],
    compOn: false, compDetector: COMP_PEAK,
    compThreshDb: -18, compRatio: 2, compAttackMs: 20, compReleaseMs: 200,
    compKneeDb: 6, compMakeupDb: 0,
    widthOn: false, width: 1,
    limOn: false, limTruePeak: false, limCeilingDb: -1, limReleaseMs: 100,
    outGainDb: 0,
  });
}

/** Narrow every number in a parameter record (its EQ bands included) to f32. */
function f32Record(p) {
  for (const k of Object.keys(p)) {
    if (typeof p[k] === "number") p[k] = Math.fround(p[k]);
  }
  for (const b of p.eq) {
    for (const k of Object.keys(b)) {
      if (typeof b[k] === "number") b[k] = Math.fround(b[k]);
    }
  }
  return p;
}

/** Fill in what a partial record leaves out and clamp what it declares, so
 *  anything downstream (the DSP, the codec, the UI) reads a complete object. */
function normaliseMastering(p) {
  const d = defaultMastering();
  if (!p || typeof p !== "object") return d;
  const eq = [];
  for (let i = 0; i < EQ_BANDS; i++) {
    const b = p.eq?.[i] ?? d.eq[i];
    const type = b.type === EQ_LOW_SHELF || b.type === EQ_HIGH_SHELF ? b.type : EQ_PEAKING;
    eq.push({
      on: !!b.on,
      // Only the outer bands may be shelves; a shelf in the middle of the
      // stack is legal maths and an unreadable control surface.
      type: i === 0 || i === EQ_BANDS - 1 ? type : EQ_PEAKING,
      freq: clampRange(+b.freq, "eqFreq", d.eq[i].freq),
      gainDb: clampRange(+b.gainDb, "eqGainDb", d.eq[i].gainDb),
      q: clampRange(+b.q, "eqQ", d.eq[i].q),
    });
  }
  return {
    on: !!p.on,
    trimDb: clampRange(+p.trimDb, "trimDb", d.trimDb),
    hpOn: !!p.hpOn,
    hpFreq: clampRange(+p.hpFreq, "hpFreq", d.hpFreq),
    hpSlope: p.hpSlope === HP_SLOPE_24 ? HP_SLOPE_24 : HP_SLOPE_12,
    eqOn: !!p.eqOn,
    eq,
    compOn: !!p.compOn,
    compDetector: p.compDetector === COMP_RMS ? COMP_RMS : COMP_PEAK,
    compThreshDb: clampRange(+p.compThreshDb, "compThreshDb", d.compThreshDb),
    compRatio: clampRange(+p.compRatio, "compRatio", d.compRatio),
    compAttackMs: clampRange(+p.compAttackMs, "compAttackMs", d.compAttackMs),
    compReleaseMs: clampRange(+p.compReleaseMs, "compReleaseMs", d.compReleaseMs),
    compKneeDb: clampRange(+p.compKneeDb, "compKneeDb", d.compKneeDb),
    compMakeupDb: clampRange(+p.compMakeupDb, "compMakeupDb", d.compMakeupDb),
    widthOn: !!p.widthOn,
    width: clampRange(+p.width, "width", d.width),
    limOn: !!p.limOn,
    limTruePeak: !!p.limTruePeak,
    limCeilingDb: clampRange(+p.limCeilingDb, "limCeilingDb", d.limCeilingDb),
    limReleaseMs: clampRange(+p.limReleaseMs, "limReleaseMs", d.limReleaseMs),
    outGainDb: clampRange(+p.outGainDb, "outGainDb", d.outGainDb),
  };
}

/**
 * Would this chain change ANY sample? Off, or on with nothing engaged and both
 * gains at unity, is not "transparent" — it is skipped outright, which is what
 * keeps the legacy render path bit-exact for every song that does not use the
 * feature. A stage counts as engaged when its switch is on, whatever its
 * settings say: an EQ band flat at 0 dB still costs a biquad, and pretending
 * otherwise would make the chain's latency depend on a gain value.
 */
function masteringEngaged(p) {
  if (!p || !p.on) return false;
  return p.trimDb !== 0 || p.outGainDb !== 0 ||
    p.hpOn || p.eqOn || p.compOn || p.limOn || (p.widthOn && p.width !== 1);
}

/** Deep copy — params travel over postMessage and into undo records. */
function cloneMastering(p) {
  const n = normaliseMastering(p);
  n.eq = n.eq.map((b) => ({ ...b }));
  return n;
}

/** Structural equality, for "did this edit change anything?" checks. */
function masteringEqual(a, b) {
  const x = normaliseMastering(a), y = normaliseMastering(b);
  for (const k of Object.keys(x)) {
    if (k === "eq") continue;
    if (x[k] !== y[k]) return false;
  }
  for (let i = 0; i < EQ_BANDS; i++) {
    for (const k of ["on", "type", "freq", "gainDb", "q"]) {
      if (x.eq[i][k] !== y.eq[i][k]) return false;
    }
  }
  return true;
}

const dbToGain = (db) => 10 ** (db / 20);
const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

// ── Biquad ──────────────────────────────────────────────────────────────────
// RBJ cookbook sections, Direct Form I, normalised to a0. Coefficients live in
// the section and the delay line is per channel, so ONE section serves every
// channel of the bus it is installed on — which is also the statement that
// makes a multichannel master well defined: the same filter, coefficient for
// coefficient, on all of them (§12.3 of the engine spec).

class Biquad {
  constructor(channels = 2) {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = new Float64Array(channels); this.x2 = new Float64Array(channels);
    this.y1 = new Float64Array(channels); this.y2 = new Float64Array(channels);
  }

  reset() {
    this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0);
  }

  /** One sample of channel `c`. */
  run(c, x) {
    const y = this.b0 * x + this.b1 * this.x1[c] + this.b2 * this.x2[c] -
      this.a1 * this.y1[c] - this.a2 * this.y2[c];
    this.x2[c] = this.x1[c]; this.x1[c] = x;
    this.y2[c] = this.y1[c]; this.y1[c] = y;
    return y;
  }

  _set(b0, b1, b2, a0, a1, a2) {
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
  }

  highPass(freq, q, rate) {
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    this._set((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
  }

  peaking(freq, gainDb, q, rate) {
    const A = 10 ** (gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    this._set(1 + alpha * A, -2 * cw, 1 - alpha * A,
              1 + alpha / A, -2 * cw, 1 - alpha / A);
  }

  lowShelf(freq, gainDb, q, rate) {
    const A = 10 ** (gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const tsa = 2 * Math.sqrt(A) * alpha;
    this._set(A * ((A + 1) - (A - 1) * cw + tsa),
              2 * A * ((A - 1) - (A + 1) * cw),
              A * ((A + 1) - (A - 1) * cw - tsa),
              (A + 1) + (A - 1) * cw + tsa,
              -2 * ((A - 1) + (A + 1) * cw),
              (A + 1) + (A - 1) * cw - tsa);
  }

  highShelf(freq, gainDb, q, rate) {
    const A = 10 ** (gainDb / 40);
    const w = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const tsa = 2 * Math.sqrt(A) * alpha;
    this._set(A * ((A + 1) + (A - 1) * cw + tsa),
              -2 * A * ((A - 1) + (A + 1) * cw),
              A * ((A + 1) + (A - 1) * cw - tsa),
              (A + 1) - (A - 1) * cw + tsa,
              2 * ((A - 1) - (A + 1) * cw),
              (A + 1) - (A - 1) * cw - tsa);
  }
}

// ── Sliding-window minimum ──────────────────────────────────────────────────
// A monotonic deque over a fixed window, O(1) amortised. The limiter's whole
// no-overshoot guarantee rests on this: see LimiterStage.

class SlidingMin {
  /** Rebase point for the sample counter: an Int32 index would wrap after
   *  about twelve hours of continuous playback, and a worklet does run for
   *  days. Every stored index is shifted down when the counter reaches this. */
  static REBASE = 0x20000000;

  constructor(width) {
    this.width = width;
    // The deque can hold `width` candidates at once, and head === tail means
    // empty — so the ring needs one spare slot to tell "full" from "empty".
    this.cap = width + 1;
    this.val = new Float64Array(this.cap);  // ring of candidate values
    this.at = new Int32Array(this.cap);     // …and the index each arrived at
    this.head = 0; this.tail = 0;           // [head, tail), tail = newest end
    this.n = 0;                             // samples pushed so far
    this.reset();
  }

  reset(fill = 1.0) {
    // Prime with one candidate dated far enough back that it retires as soon
    // as the window has rolled past it — so the very first outputs read `fill`
    // (silence needs no gain reduction) instead of an empty deque's nothing.
    this.n = 0;
    this.val[0] = fill; this.at[0] = 0;
    this.head = 0; this.tail = 1;
  }

  /** Push `v`, return the minimum over the last `width` samples. */
  push(v) {
    const i = this.n++;
    const cap = this.cap;
    // Drop candidates this sample dominates: anything ≥ v can never be the
    // minimum again while v is in the window.
    while (this.tail !== this.head) {
      const prev = (this.tail - 1 + cap) % cap;
      if (this.val[prev] >= v) this.tail = prev; else break;
    }
    this.val[this.tail] = v; this.at[this.tail] = i;
    this.tail = (this.tail + 1) % cap;
    // …and retire the front once it has fallen out of the window.
    while (this.at[this.head] <= i - this.width) this.head = (this.head + 1) % cap;
    if (this.n >= SlidingMin.REBASE) {
      for (let k = this.head; k !== this.tail; k = (k + 1) % cap) {
        this.at[k] -= SlidingMin.REBASE;
      }
      this.n -= SlidingMin.REBASE;
    }
    return this.val[this.head];
  }
}

// ── The stages ──────────────────────────────────────────────────────────────

/** Two Butterworth sections' worth of high-pass; the 12 dB/oct slope uses one. */
class HighPassStage {
  constructor(channels = 2) {
    this.s1 = new Biquad(channels); this.s2 = new Biquad(channels); this.two = false;
  }
  configure(p, rate) {
    this.two = p.hpSlope === HP_SLOPE_24;
    if (this.two) {
      // Cascaded Butterworth 4th order: the two section Qs of a normalised
      // Butterworth quartic, 1/(2 cos(π/8)) and 1/(2 cos(3π/8)).
      this.s1.highPass(p.hpFreq, 0.5411961001461969, rate);
      this.s2.highPass(p.hpFreq, 1.3065629648763766, rate);
    } else {
      this.s1.highPass(p.hpFreq, Math.SQRT1_2, rate);
    }
  }
  reset() { this.s1.reset(); this.s2.reset(); }
  run(c, x) {
    const y = this.s1.run(c, x);
    return this.two ? this.s2.run(c, y) : y;
  }
}

/** Four cascaded RBJ sections; a band that is off is simply not in the list. */
class EqStage {
  constructor(channels = 2) {
    this.sections = [];
    for (let i = 0; i < EQ_BANDS; i++) this.sections.push(new Biquad(channels));
    this.live = [];
  }
  configure(p, rate) {
    this.live = [];
    for (let i = 0; i < EQ_BANDS; i++) {
      const b = p.eq[i];
      if (!b.on) continue;
      const s = this.sections[i];
      if (b.type === EQ_LOW_SHELF) s.lowShelf(b.freq, b.gainDb, b.q, rate);
      else if (b.type === EQ_HIGH_SHELF) s.highShelf(b.freq, b.gainDb, b.q, rate);
      else s.peaking(b.freq, b.gainDb, b.q, rate);
      this.live.push(s);
    }
  }
  reset() { for (const s of this.sections) s.reset(); }
  run(c, x) {
    let y = x;
    for (let i = 0; i < this.live.length; i++) y = this.live[i].run(c, y);
    return y;
  }
}

/**
 * Feed-forward compressor with a quadratic soft knee, computed in dB and
 * smoothed in dB — the arrangement that gives a ratio the meaning the label
 * claims at every level, instead of one that drifts with the detector.
 *
 * The detector is LINKED (one envelope drives every channel), which is the only
 * arrangement that leaves the image where the mixer put it — for a pair, and
 * just as much for a speaker layout or an ambisonic scene, where a per-channel
 * envelope would pull the whole sound field about whenever one direction got
 * loud.
 */
class CompressorStage {
  constructor() {
    this.grDb = 0;        // current gain reduction, dB (negative)
    this.rms = 0;         // RMS detector's mean-square state
    this.rmsCoef = 0;
    this.attackCoef = 0; this.releaseCoef = 0;
    this.thresh = 0; this.ratio = 1; this.knee = 0; this.makeup = 1;
    this.peakMode = true;
  }
  configure(p, rate) {
    this.peakMode = p.compDetector !== COMP_RMS;
    this.thresh = p.compThreshDb;
    this.ratio = p.compRatio;
    this.knee = p.compKneeDb;
    this.makeup = dbToGain(p.compMakeupDb);
    this.attackCoef = onePole(p.compAttackMs, rate);
    this.releaseCoef = onePole(p.compReleaseMs, rate);
    // A 10 ms window is the usual "programme level" compromise: long enough to
    // ignore a single cycle of a bass note, short enough to follow a phrase.
    this.rmsCoef = onePole(10, rate);
  }
  reset() { this.grDb = 0; this.rms = 0; }

  /** Update the envelope from the frame's linked detector and return the
   *  linear gain to apply (makeup folded in). */
  step(l, r) {
    let level;
    if (this.peakMode) {
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      level = al > ar ? al : ar;
    } else {
      const ms = (l * l + r * r) * 0.5;
      this.rms += (ms - this.rms) * this.rmsCoef;
      level = Math.sqrt(this.rms);
    }
    return this.advance(level);
  }

  /**
   * The same detector over `nch` planar channels of a channel-major buffer:
   * the peak over EVERY channel of the frame, or the mean square of all of
   * them. Both reduce to `step`'s arithmetic exactly at nch = 2 (`sum / 2` and
   * `(l² + r²) × 0.5` are the same IEEE-754 number), so a two-channel bus put
   * through here reads the level a stereo pair reads.
   */
  stepPlanar(data, n, stride, nch) {
    let level;
    if (this.peakMode) {
      level = 0;
      for (let c = 0; c < nch; c++) {
        const x = data[c * stride + n];
        const a = x < 0 ? -x : x;
        if (a > level) level = a;
      }
    } else {
      let sum = 0;
      for (let c = 0; c < nch; c++) { const x = data[c * stride + n]; sum += x * x; }
      this.rms += (sum / nch - this.rms) * this.rmsCoef;
      level = Math.sqrt(this.rms);
    }
    return this.advance(level);
  }

  /** Gain computer + envelope, shared by both detectors. */
  advance(level) {
    // −120 dBFS floor: below it the gain computer has nothing to say and the
    // logarithm has nowhere to go.
    const levelDb = level > 1e-6 ? 20 * Math.log10(level) : -120;
    const over = levelDb - this.thresh;
    const half = this.knee * 0.5;
    let targetDb;
    if (this.knee > 0 && over > -half && over < half) {
      const t = over + half;
      targetDb = -((1 - 1 / this.ratio) * t * t) / (2 * this.knee);
    } else if (over > 0) {
      targetDb = -over * (1 - 1 / this.ratio);
    } else {
      targetDb = 0;
    }
    // More reduction is an ATTACK, less is a RELEASE.
    const coef = targetDb < this.grDb ? this.attackCoef : this.releaseCoef;
    this.grDb += (targetDb - this.grDb) * coef;
    return dbToGain(this.grDb) * this.makeup;
  }
}

/**
 * Look-ahead brickwall limiter.
 *
 * The construction is the one that CANNOT overshoot, which matters more here
 * than anywhere else in the chain: this is the stage whose only job is a
 * promise about the ceiling.
 *
 *   1. `g[n]` — the gain sample n would need to sit at the ceiling.
 *   2. A sliding MINIMUM of g over 2D+1 samples.
 *   3. A rise-rate limit (the release), which can only push the gain lower.
 *   4. A moving AVERAGE over D+1 samples, which turns every step into a ramp.
 *   5. The audio, delayed by 2D.
 *
 * Steps 2 and 4 are what buy the guarantee. Every value the average at time n
 * covers is a minimum over a window that still contains sample n−2D, so every
 * term is ≤ g[n−2D] and so is their mean — and the rise limit only ever lowers
 * it further. A moving average alone (the common shortcut) does not have that
 * property and lets transients through by a decibel or so.
 *
 * The cost is 2D of latency, which is why D is one millisecond and not ten.
 */
class LimiterStage {
  constructor(channels = 2) {
    this.nch = channels;
    this.d = 0;
    // Channel-major, `2D` deep per channel — one allocation whatever the
    // channel count, and the same index arithmetic for a pair and for sixteen
    // ambisonic channels.
    this.delay = null; this.dstride = 0; this.dpos = 0;
    this.min = null;
    this.avg = null; this.avgSum = 0; this.apos = 0;
    this.env = 1;
    this.releaseCoef = 0;
    this.ceiling = 1;
    this.truePeak = false;
    this.probes = [];
    for (let c = 0; c < channels; c++) this.probes.push(new TruePeakProbe());
    this.grDb = 0; // most recent reduction, dB (negative), for the meter
  }

  configure(p, rate) {
    const d = Math.max(1, Math.round((LIMITER_LOOKAHEAD_MS / 1000) * rate));
    const geometryChanged = d !== this.d;
    if (geometryChanged) {
      this.d = d;
      this.dstride = 2 * d;
      this.delay = new Float64Array(this.nch * this.dstride);
      this.min = new SlidingMin(2 * d + 1);
      this.avg = new Float64Array(d + 1);
    }
    this.ceiling = dbToGain(p.limCeilingDb);
    this.truePeak = !!p.limTruePeak;
    this.releaseCoef = onePole(p.limReleaseMs, rate);
    // New buffers hold nothing; existing ones hold audio that is still on its
    // way out, and dropping it mid-drag is a click for every knob turn.
    if (geometryChanged) this.reset();
  }

  /** Total latency in samples — what the rest of the chain has to declare. */
  get latency() { return this.d === 0 ? 0 : 2 * this.d; }

  reset() {
    if (this.d === 0) return;
    this.delay.fill(0); this.dpos = 0;
    this.min.reset(1.0);
    this.avg.fill(1.0); this.avgSum = this.avg.length; this.apos = 0;
    this.env = 1;
    for (let c = 0; c < this.nch; c++) this.probes[c].reset();
    this.grDb = 0;
  }

  /**
   * Steps 1-4 for one frame: fold the frame's peak into the gain computer and
   * hand back the gain the frame now leaving the delay line is to be given.
   * The peak is taken across ALL channels — which is what makes the ceiling a
   * statement about the delivered samples rather than about one of them.
   */
  advance(peak) {
    const need = peak > this.ceiling ? this.ceiling / peak : 1;

    const m = this.min.push(need);
    // Rise limit = release. A fall is instantaneous; the sliding minimum has
    // already moved it D samples early, and step 4 turns that into a ramp.
    this.env = m < this.env ? m : this.env + (m - this.env) * this.releaseCoef;

    const w = this.avg.length;
    this.avgSum += this.env - this.avg[this.apos];
    this.avg[this.apos] = this.env;
    this.apos = this.apos + 1 === w ? 0 : this.apos + 1;
    const gain = this.avgSum / w;

    if (gain < 1) {
      const db = 20 * Math.log10(gain);
      if (db < this.grDb) this.grDb = db;
    }
    return gain;
  }

  /** Feed one frame, get the delayed and limited frame back in `out`. */
  step(l, r, out) {
    const pl = this.truePeak ? this.probes[0].push(l) : (l < 0 ? -l : l);
    const pr = this.truePeak ? this.probes[1].push(r) : (r < 0 ? -r : r);
    const gain = this.advance(pl > pr ? pl : pr);

    const d = this.delay, s = this.dstride, i = this.dpos;
    const dl = d[i];
    const dr = d[s + i];
    d[i] = l;
    d[s + i] = r;
    this.dpos = i + 1 === s ? 0 : i + 1;

    out[0] = dl * gain;
    out[1] = dr * gain;
  }

  /** The same, in place over `nch` planar channels of a channel-major buffer. */
  stepPlanar(data, n, stride) {
    const nch = this.nch;
    let peak = 0;
    for (let c = 0; c < nch; c++) {
      const x = data[c * stride + n];
      const a = this.truePeak ? this.probes[c].push(x) : (x < 0 ? -x : x);
      if (a > peak) peak = a;
    }
    const gain = this.advance(peak);

    const d = this.delay, s = this.dstride, i = this.dpos;
    for (let c = 0; c < nch; c++) {
      const j = c * s + i;
      const k = c * stride + n;
      const held = d[j];
      d[j] = data[k];
      data[k] = held * gain;
    }
    this.dpos = i + 1 === s ? 0 : i + 1;
  }
}

/** One-pole smoothing coefficient for a time constant in milliseconds. */
function onePole(ms, rate) {
  const n = (ms / 1000) * rate;
  return n <= 0 ? 1 : 1 - Math.exp(-1 / n);
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * The whole thing, stateful, one instance per playhead. `process` runs over a
 * block of the mix bus in place; the block size is irrelevant to the result
 * (everything is per-sample state), which is what keeps a render at one chunk
 * size identical to a render at another.
 *
 * `channels` is how wide the bus is. Two — the output stage's pair — is the
 * default and the only width the monitor path ever uses. A wider chain is what
 * a multichannel delivery gets (item 178.1, engine spec §12.3): the same
 * parameters, the same coefficients and the same envelopes, but with every
 * channel filtered identically, ONE dynamics detector reading all of them, and
 * the stereo width stage skipped — a mid/side round trip has no meaning on six
 * speaker feeds or sixteen ambisonic channels, and forcing one would rotate the
 * sound field. Use `processPlanar` for those; `process` is the pair.
 */
class MasterChain {
  constructor(params = null, rate = SAMPLING_RATE, channels = 2) {
    this.rate = rate;
    this.channels = channels;
    this.hp = new HighPassStage(channels);
    this.eq = new EqStage(channels);
    this.comp = new CompressorStage();
    this.lim = new LimiterStage(channels);
    this.params = defaultMastering();
    this._pair = [0, 0];
    /** Peak gain reduction over the block just processed, dB (≤ 0). Drained by
     *  the metering tap; the UI owns the ballistics, as everywhere else. */
    this.compGrDb = 0;
    this.limGrDb = 0;
    // Always, even for a null argument: `engaged` and the two gain scalars are
    // set here and nowhere else, so a chain that skipped it would read them as
    // undefined on its first block.
    this.setParams(params ?? this.params);
  }

  /** Install a parameter set. Coefficients are recomputed; the DELAY LINES are
   *  not cleared, so dragging a knob while the song plays does not click. */
  setParams(params) {
    const p = normaliseMastering(params);
    this.params = p;
    this.trimGain = dbToGain(p.trimDb);
    this.outGain = dbToGain(p.outGainDb);
    this.width = p.width;
    if (p.hpOn) this.hp.configure(p, this.rate);
    if (p.eqOn) this.eq.configure(p, this.rate);
    if (p.compOn) this.comp.configure(p, this.rate);
    if (p.limOn) this.lim.configure(p, this.rate);
    this.engaged = masteringEngaged(p);
  }

  /** Latency this chain adds, in samples (the limiter's look-ahead, or zero). */
  get latency() { return this.params.limOn ? this.lim.latency : 0; }

  /** Clear every delay line and envelope. A transport reset owes the chain
   *  this: a compressor still holding 6 dB of reduction from before a seek, or
   *  a look-ahead buffer still holding two milliseconds of the previous
   *  playback, is exactly the class of lingering state §15 of the engine spec
   *  is about. */
  reset() {
    this.hp.reset();
    this.eq.reset();
    this.comp.reset();
    this.lim.reset();
    this.compGrDb = 0;
    this.limGrDb = 0;
  }

  /**
   * Process `frames` of the mix bus in place. `left`/`right` are the binary32
   * mix buffers; the maths runs in binary64 and the result is stored back,
   * narrowing once, exactly as an unmastered mix narrows once.
   */
  process(left, right, frames) {
    const p = this.params;
    if (!this.engaged) return;
    if (this.channels !== 2) throw new Error("process() is the stereo pair; use processPlanar");
    const trim = this.trimGain;
    const out = this.outGain;
    const doHp = p.hpOn, doEq = p.eqOn, doComp = p.compOn;
    const doWidth = p.widthOn && this.width !== 1;
    const doLim = p.limOn;
    const w = this.width;
    const pair = this._pair;
    let compGr = 0;
    this.lim.grDb = 0;

    for (let n = 0; n < frames; n++) {
      let l = left[n] * trim;
      let r = right[n] * trim;
      if (doHp) { l = this.hp.run(0, l); r = this.hp.run(1, r); }
      if (doEq) { l = this.eq.run(0, l); r = this.eq.run(1, r); }
      if (doComp) {
        const g = this.comp.step(l, r);
        l *= g; r *= g;
        if (this.comp.grDb < compGr) compGr = this.comp.grDb;
      }
      if (doWidth) {
        const m = (l + r) * 0.5;
        const s = (l - r) * 0.5 * w;
        l = m + s; r = m - s;
      }
      if (doLim) {
        this.lim.step(l, r, pair);
        l = pair[0]; r = pair[1];
      }
      left[n] = l * out;
      right[n] = r * out;
    }
    this.compGrDb = compGr;
    this.limGrDb = this.lim.grDb;
  }

  /**
   * Process `frames` of a CHANNEL-MAJOR bus in place — `data[c * stride + n]`,
   * which is the shape of the object bus a surround or ambisonic export is
   * written from (spatial.js `SpatialBus.data`). The chain is the one declared
   * for the song; only two things differ from the pair, and both are forced by
   * what a channel bus is:
   *
   *   * the stereo WIDTH stage is skipped — see the class docstring;
   *   * the compressor's and the limiter's detectors read every channel, so
   *     one gain moves the whole field and nothing about its geometry changes.
   *
   * Everything else — trim, high-pass, EQ, output gain — is applied to each
   * channel with the identical coefficients, which is exactly the condition
   * under which the filtering commutes with any linear decode of the bus.
   *
   * There is no narrowing here: the bus is binary64 all the way (§12.2's
   * binary32 step exists for the 8-bit device, which a multichannel file is
   * not), and the samples narrow once, where the file is written, at whatever
   * depth it is written in. `data` MUST therefore be a Float64Array — unlike
   * `process`, which keeps the frame in locals, this writes each stage's result
   * back into the buffer, so a narrower array would round at every stage
   * boundary instead of once at the end.
   */
  processPlanar(data, frames, stride) {
    const p = this.params;
    if (!this.engaged) return;
    const nch = this.channels;
    const trim = this.trimGain;
    const out = this.outGain;
    const doHp = p.hpOn, doEq = p.eqOn, doComp = p.compOn, doLim = p.limOn;
    let compGr = 0;
    this.lim.grDb = 0;

    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < nch; c++) {
        const i = c * stride + n;
        let x = data[i] * trim;
        if (doHp) x = this.hp.run(c, x);
        if (doEq) x = this.eq.run(c, x);
        data[i] = x;
      }
      if (doComp) {
        const g = this.comp.stepPlanar(data, n, stride, nch);
        for (let c = 0; c < nch; c++) data[c * stride + n] *= g;
        if (this.comp.grDb < compGr) compGr = this.comp.grDb;
      }
      if (doLim) this.lim.stepPlanar(data, n, stride);
      if (out !== 1) for (let c = 0; c < nch; c++) data[c * stride + n] *= out;
    }
    this.compGrDb = compGr;
    this.limGrDb = this.lim.grDb;
  }

  /**
   * The chain's magnitude response at `freq`, in dB — the static stages only
   * (trim, high-pass, EQ, output gain), which is exactly what an EQ curve is
   * supposed to draw. The dynamics stages are deliberately absent: a
   * compressor has no frequency response, and drawing its makeup into the
   * curve would be a lie about what the line means.
   */
  responseDb(freq) {
    const p = this.params;
    if (!p.on) return 0;
    let db = p.trimDb + p.outGainDb;
    if (p.hpOn) {
      db += biquadDb(this.hp.s1, freq, this.rate);
      if (this.hp.two) db += biquadDb(this.hp.s2, freq, this.rate);
    }
    if (p.eqOn) {
      for (let i = 0; i < EQ_BANDS; i++) {
        if (p.eq[i].on) db += biquadDb(this.eq.sections[i], freq, this.rate);
      }
    }
    return db;
  }
}

/** |H(e^{jw})| of one configured section, in dB. */
function biquadDb(s, freq, rate) {
  const w = (2 * Math.PI * freq) / rate;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = s.b0 + s.b1 * cw + s.b2 * c2;
  const ni = -(s.b1 * sw + s.b2 * s2);
  const dr = 1 + s.a1 * cw + s.a2 * c2;
  const di = -(s.a1 * sw + s.a2 * s2);
  const num = nr * nr + ni * ni;
  const den = dr * dr + di * di;
  if (den === 0 || num === 0) return -120;
  return 10 * Math.log10(num / den);
}

/** A configured chain's response curve over `n` log-spaced points from `lo` to
 *  `hi` Hz — what the EQ display plots. Returns {freq, db} Float64Arrays. */
function responseCurve(chain, lo = 20, hi = 20000, n = 256) {
  const freq = new Float64Array(n);
  const db = new Float64Array(n);
  const k = Math.log(hi / lo) / (n - 1);
  for (let i = 0; i < n; i++) {
    freq[i] = lo * Math.exp(k * i);
    db[i] = chain.responseDb(freq[i]);
  }
  return { freq, db };
}

// ══ src/engine/loudness.js ══
// Loudness and delivery metering (item 178) — the numbers the Mastering view
// draws, and the numbers its measure-and-set buttons act on.
//
// The split here follows the same rule the master-strip tap (analysis.js)
// follows: the ENGINE ships sums, the caller owns the windows and the look. So
// this file holds two kinds of thing —
//
//   * the per-sample filters a loudness measurement needs (K-weighting, the
//     phase-scrambling all-pass cascade), which run on the audio thread inside
//     the metering tap; and
//   * the integrators and gates that turn a stream of per-interval sums into
//     LUFS, LRA, crest and a bit histogram, which run wherever the caller is —
//     the UI for the live meters, the offline analyser for the time plots.
//
// Nothing in here is a judgement. A number is reported, its units are named,
// and what it means for the music is the composer's business.
//
// ── References ──
// Loudness is ITU-R BS.1770-4 / EBU R 128: K-weighted mean square, −0.691 dB
// offset, 400 ms momentary and 3 s short-term windows, and the two-stage gate
// (absolute −70 LUFS, then relative at −10 LU) for the integrated figure. LRA
// is EBU Tech 3342: 3 s windows, a −20 LU relative gate, and the span from the
// 10th to the 95th percentile.
//
// The all-pass cascade is NOT from a standard. It is this project's own, and it
// is spelled out in TAUD_ENGINE_SPEC.md so a second implementation can produce
// the same figure; see PHASE_SCRAMBLE_HZ for what it is for.


// ── K-weighting (BS.1770) ───────────────────────────────────────────────────
// Two sections: a high-frequency shelf standing in for the head's acoustics,
// then the RLB high-pass. The standard tabulates coefficients at 48 kHz only,
// so they are DERIVED here from the analogue prototype and the bilinear
// transform — that way 32 kHz (the engine's other rate) is measured properly
// rather than with 48 kHz numbers used out of place.

/** Shelf prototype: corner, gain and Q of BS.1770's stage 1. */
const KW_SHELF_F0 = 1681.974450955533;
const KW_SHELF_G = 3.999843853973347;
const KW_SHELF_Q = 0.7071752369554196;
/** …and the exponent relating the shelf's mid gain to its high gain. */
const KW_SHELF_VB_EXP = 0.4996667741545416;
/** RLB high-pass prototype: corner and Q of BS.1770's stage 2. */
const KW_HP_F0 = 38.13547087602444;
const KW_HP_Q = 0.5003270373238773;

/** The −0.691 dB offset BS.1770 applies so a reference signal reads its own level. */
const LUFS_OFFSET_DB = -0.691;
/** Absolute gate, in LUFS: blocks quieter than this never count. */
const GATE_ABSOLUTE_LUFS = -70;
/** Relative gate for the integrated figure, in LU below the ungated mean. */
const GATE_RELATIVE_LU = -10;
/** …and the wider one LRA uses. */
const LRA_RELATIVE_LU = -20;

/**
 * BS.1770 stage 1 + stage 2 coefficients for `rate`, as two
 * {b0,b1,b2,a1,a2} records normalised to a0.
 */
function kWeightingCoefficients(rate) {
  // Stage 1 — high-frequency shelf.
  const k1 = Math.tan((Math.PI * KW_SHELF_F0) / rate);
  const vh = 10 ** (KW_SHELF_G / 20);
  const vb = vh ** KW_SHELF_VB_EXP;
  const d1 = 1 + k1 / KW_SHELF_Q + k1 * k1;
  const shelf = {
    b0: (vh + (vb * k1) / KW_SHELF_Q + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - vh)) / d1,
    b2: (vh - (vb * k1) / KW_SHELF_Q + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / KW_SHELF_Q + k1 * k1) / d1,
  };
  // Stage 2 — RLB high-pass. Its numerator is the ideal (1, −2, 1).
  const k2 = Math.tan((Math.PI * KW_HP_F0) / rate);
  const d2 = 1 + k2 / KW_HP_Q + k2 * k2;
  const hp = {
    b0: 1, b1: -2, b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / KW_HP_Q + k2 * k2) / d2,
  };
  return [shelf, hp];
}

/** One channel's K-weighting filter pair, Direct Form I. */
class KWeighting {
  constructor(rate) {
    const [shelf, hp] = kWeightingCoefficients(rate);
    this.s = shelf;
    this.h = hp;
    this.reset();
  }

  reset() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;   // stage 1
    this.u1 = 0; this.u2 = 0; this.v1 = 0; this.v2 = 0;   // stage 2
  }

  /** Feed one sample, get the K-weighted sample back. */
  run(x) {
    const s = this.s;
    const y = s.b0 * x + s.b1 * this.x1 + s.b2 * this.x2 - s.a1 * this.y1 - s.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    const h = this.h;
    const v = h.b0 * y + h.b1 * this.u1 + h.b2 * this.u2 - h.a1 * this.v1 - h.a2 * this.v2;
    this.u2 = this.u1; this.u1 = y;
    this.v2 = this.v1; this.v1 = v;
    return v;
  }
}

/** LUFS from a K-weighted mean square summed over the channels of a pair. */
function lufsFromMeanSquare(sumOfChannelMeanSquares) {
  if (!(sumOfChannelMeanSquares > 0)) return -Infinity;
  return LUFS_OFFSET_DB + 10 * Math.log10(sumOfChannelMeanSquares);
}

// ── Phase-scrambling all-pass cascade ───────────────────────────────────────
//
// WHY: a clipped or hard-limited mix has flat tops, and a flat top has a LOW
// crest factor — the peak has been carved off while the energy stayed. Run the
// same signal through a cascade of all-pass sections and the magnitude spectrum
// is untouched while the phases are scattered; the flat tops become peaks again
// and the crest factor jumps back up. The GAP between the two crest figures is
// therefore a direct reading of how much peak the processing has eaten, which
// is the measurement MasVis made famous.
//
// The cascade below is this project's own definition, not MasVis's: eight
// second-order all-pass sections at octave spacing from 31.25 Hz to 4 kHz, all
// at Q = 0.5. Octave spacing puts a phase rotation in every part of the band a
// mix has energy in, and Q = 0.5 makes each rotation broad rather than local.

const PHASE_SCRAMBLE_HZ = Object.freeze([31.25, 62.5, 125, 250, 500, 1000, 2000, 4000]);
const PHASE_SCRAMBLE_Q = 0.5;

/** The cascade, one channel, Direct Form I. */
class PhaseScrambler {
  constructor(rate) {
    const n = PHASE_SCRAMBLE_HZ.length;
    this.n = n;
    this.b0 = new Float64Array(n);
    this.b1 = new Float64Array(n);
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * Math.min(PHASE_SCRAMBLE_HZ[i], rate * 0.49)) / rate;
      const alpha = Math.sin(w) / (2 * PHASE_SCRAMBLE_Q);
      const a0 = 1 + alpha;
      // All-pass: b = (1−α, −2cos w, 1+α), a = (1+α, −2cos w, 1−α). Normalised,
      // b2 is 1 and a1 mirrors b1, so only three numbers need storing.
      this.b0[i] = (1 - alpha) / a0;
      this.b1[i] = (-2 * Math.cos(w)) / a0;
      this.a1[i] = (-2 * Math.cos(w)) / a0;
      this.a2[i] = (1 - alpha) / a0;
    }
    this.x1 = new Float64Array(n); this.x2 = new Float64Array(n);
    this.y1 = new Float64Array(n); this.y2 = new Float64Array(n);
    this.reset();
  }

  reset() { this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0); }

  run(x) {
    let v = x;
    for (let i = 0; i < this.n; i++) {
      const y = this.b0[i] * v + this.b1[i] * this.x1[i] + this.x2[i] -
        this.a1[i] * this.y1[i] - this.a2[i] * this.y2[i];
      this.x2[i] = this.x1[i]; this.x1[i] = v;
      this.y2[i] = this.y1[i]; this.y1[i] = y;
      v = y;
    }
    return v;
  }
}

// ── dB helpers ──────────────────────────────────────────────────────────────

/** Amplitude → dBFS, with a floor rather than −Infinity so a bar can draw it. */
function dbfs(x, floor = -144) {
  const a = x < 0 ? -x : x;
  return a > 0 ? Math.max(20 * Math.log10(a), floor) : floor;
}

/** Crest factor of a block, in dB: peak over RMS. Zero for silence. */
function crestDb(peak, meanSquare) {
  if (!(meanSquare > 0) || !(peak > 0)) return 0;
  return 20 * Math.log10(peak / Math.sqrt(meanSquare));
}

// ── Integration ─────────────────────────────────────────────────────────────

/** Length of one accumulation frame, in seconds. Every window this file
 *  reports is a whole number of these: 400 ms momentary is four, 3 s short-term
 *  is thirty, and the gated figures hop by one. */
const FRAME_SEC = 0.1;

/**
 * Turns a stream of per-interval sums into every loudness figure the view
 * shows. Feed it whatever intervals you have — a 16 ms snapshot, a 128-frame
 * render chunk — and it packs them into 100 ms frames itself, so the reading
 * does not depend on how the audio arrived.
 *
 * `capFrames` bounds the frame history a live meter accumulates (the integrated
 * figure needs all of it). The default is a bit over five hours, which is long
 * enough that no session reaches it and short enough that nothing leaks.
 */
class LoudnessIntegrator {
  constructor(rate, { capFrames = 200000 } = {}) {
    this.rate = rate;
    this.frameSamples = Math.max(1, Math.round(FRAME_SEC * rate));
    this.capFrames = capFrames;
    /** Per-frame K-weighted mean square, channel-summed (the BS.1770 `z`). */
    this.frames = [];
    /** …and the same frames' plain (unweighted) mean square and peak, which is
     *  what the crest and PLR readings are built from. */
    this.framePeak = [];
    this.frameMs = [];
    this.reset();
  }

  reset() {
    this.frames.length = 0;
    this.framePeak.length = 0;
    this.frameMs.length = 0;
    this._accZ = 0;
    this._accMs = 0;
    this._accPeak = 0;
    this._accN = 0;
    this.truePeak = 0;
    this.samplePeak = 0;
  }

  /**
   * Add one interval.
   * @param sumZ  Σ over the interval of (K-weighted L² + K-weighted R²)
   * @param sumSq Σ over the interval of (L² + R²) — unweighted
   * @param peak  largest |sample| in the interval, either channel
   * @param truePeak  largest 4×-oversampled magnitude, or 0 if not measured
   * @param n     samples in the interval
   */
  push(sumZ, sumSq, peak, truePeak, n) {
    if (!(n > 0)) return;
    if (peak > this.samplePeak) this.samplePeak = peak;
    if (truePeak > this.truePeak) this.truePeak = truePeak;
    this._accZ += sumZ;
    this._accMs += sumSq;
    if (peak > this._accPeak) this._accPeak = peak;
    this._accN += n;
    while (this._accN >= this.frameSamples) {
      // The interval that completes a frame usually overruns it. Splitting the
      // sums proportionally is the honest reading — they are sums of squares,
      // so a share of the samples is a share of the energy.
      const share = this.frameSamples / this._accN;
      const z = this._accZ * share;
      const ms = this._accMs * share;
      this._pushFrame(z / this.frameSamples, ms / this.frameSamples, this._accPeak);
      this._accZ -= z;
      this._accMs -= ms;
      this._accN -= this.frameSamples;
      // The peak is not divisible; it belongs to both frames it straddles.
    }
    if (this._accN === 0) this._accPeak = 0;
  }

  _pushFrame(z, ms, peak) {
    if (this.frames.length >= this.capFrames) {
      this.frames.shift(); this.frameMs.shift(); this.framePeak.shift();
    }
    this.frames.push(z);
    this.frameMs.push(ms);
    this.framePeak.push(peak);
  }

  /** Mean of the last `sec` seconds of frames as LUFS; −Infinity when there is
   *  not a whole window yet, so a meter can say "—" rather than a wrong number. */
  window(sec) {
    const need = Math.round(sec / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return -Infinity;
    let s = 0;
    for (let i = n - need; i < n; i++) s += this.frames[i];
    return lufsFromMeanSquare(s / need);
  }

  /** 400 ms window (BS.1770 momentary). */
  get momentary() { return this.window(0.4); }
  /** 3 s window (BS.1770 short-term). */
  get shortTerm() { return this.window(3); }

  /** Every 400 ms block on a 100 ms hop, as LUFS. */
  blocks(sec = 0.4) {
    const need = Math.round(sec / FRAME_SEC);
    const out = [];
    if (this.frames.length < need) return out;
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    out.push(lufsFromMeanSquare(s / need));
    for (let i = need; i < this.frames.length; i++) {
      s += this.frames[i] - this.frames[i - need];
      out.push(lufsFromMeanSquare(s / need));
    }
    return out;
  }

  /**
   * Gated integrated loudness (BS.1770 / R 128). Two passes: drop everything
   * below −70 LUFS, take the mean of what is left, then drop everything more
   * than 10 LU below THAT and take the mean again.
   */
  get integrated() {
    const need = Math.round(0.4 / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return -Infinity;
    const zs = [];
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    zs.push(s / need);
    for (let i = need; i < n; i++) { s += this.frames[i] - this.frames[i - need]; zs.push(s / need); }
    return gatedMean(zs, GATE_RELATIVE_LU);
  }

  /** Loudness range (EBU Tech 3342), in LU. */
  get range() {
    const need = Math.round(3 / FRAME_SEC);
    const n = this.frames.length;
    if (n < need) return 0;
    const zs = [];
    let s = 0;
    for (let i = 0; i < need; i++) s += this.frames[i];
    zs.push(s / need);
    for (let i = need; i < n; i++) { s += this.frames[i] - this.frames[i - need]; zs.push(s / need); }
    return loudnessRange(zs);
  }

  /** Peak-to-loudness ratio, in LU: how much headroom the peaks keep over the
   *  integrated level. Falls as a master is squashed, which is exactly what
   *  makes it worth watching. */
  get plr() {
    const i = this.integrated;
    if (!Number.isFinite(i)) return NaN;
    const p = this.truePeak > 0 ? this.truePeak : this.samplePeak;
    if (!(p > 0)) return NaN;
    return 20 * Math.log10(p) - i;
  }
}

/** The two-pass gate, over an array of block mean squares. */
function gatedMean(zs, relativeLu) {
  const absolute = 10 ** ((GATE_ABSOLUTE_LUFS - LUFS_OFFSET_DB) / 10);
  let sum = 0, count = 0;
  for (const z of zs) if (z > absolute) { sum += z; count++; }
  if (count === 0) return -Infinity;
  const relative = (sum / count) * 10 ** (relativeLu / 10);
  const gate = Math.max(absolute, relative);
  sum = 0; count = 0;
  for (const z of zs) if (z > gate) { sum += z; count++; }
  if (count === 0) return -Infinity;
  return lufsFromMeanSquare(sum / count);
}

/** EBU Tech 3342 loudness range from an array of 3 s block mean squares. */
function loudnessRange(zs) {
  const absolute = 10 ** ((GATE_ABSOLUTE_LUFS - LUFS_OFFSET_DB) / 10);
  let sum = 0, count = 0;
  for (const z of zs) if (z > absolute) { sum += z; count++; }
  if (count === 0) return 0;
  const gate = Math.max(absolute, (sum / count) * 10 ** (LRA_RELATIVE_LU / 10));
  const kept = [];
  for (const z of zs) if (z > gate) kept.push(lufsFromMeanSquare(z));
  if (kept.length < 2) return 0;
  kept.sort((a, b) => a - b);
  return percentile(kept, 0.95) - percentile(kept, 0.10);
}

/** Linear-interpolated percentile of a SORTED array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return -Infinity;
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ── Bit usage ───────────────────────────────────────────────────────────────

/**
 * How much of the delivered code space a render actually touches.
 *
 * "How many codes did this song use?" is a real question about the FILE rather
 * than a curiosity: a mix that peaks at −12 dBFS throws away two of its bits
 * before any dither gets a say, and the histogram shows it as a narrow spike
 * instead of a spread. At 16 bits `used` against `span` is a second reading —
 * a dense span is a signal that has really been processed at that depth, and a
 * gappy one is a coarser source blown up to fit.
 *
 * @param hist  a census of length 2^depth, indexed by the delivered code
 * @param depth bits per sample the census was taken at
 * @returns {{used, span, effectiveBits, entropyBits, total, peakCode, minCode, maxCode}}
 *   `used` counts codes that occur at all, `span` is max−min+1 (the range the
 *   signal swings over), `effectiveBits` is log2 of that span, and
 *   `entropyBits` is the Shannon entropy of the code distribution — the honest
 *   "how many bits is this actually carrying" figure, always ≤ effectiveBits.
 */
function bitUsage(hist, depth = 8) {
  const codes = 1 << depth;
  const mid = codes >> 1;
  let total = 0, used = 0, minCode = -1, maxCode = -1, peakCode = 0, peakCount = -1;
  for (let i = 0; i < codes; i++) {
    const c = hist[i];
    if (c > 0) {
      used++;
      if (minCode < 0) minCode = i;
      maxCode = i;
      total += c;
      if (c > peakCount) { peakCount = c; peakCode = i; }
    }
  }
  if (total === 0) {
    return { used: 0, span: 0, effectiveBits: 0, entropyBits: 0, total: 0,
             peakCode: mid, minCode: mid, maxCode: mid };
  }
  let h = 0;
  for (let i = 0; i < codes; i++) {
    const c = hist[i];
    if (c > 0) { const p = c / total; h -= p * Math.log2(p); }
  }
  const span = maxCode - minCode + 1;
  return {
    used, span, total, peakCode, minCode, maxCode,
    effectiveBits: Math.log2(span),
    entropyBits: h,
  };
}

/** Display depths the bit-usage census can be taken at. 16 is what a stereo
 *  WAV export writes (straight off the float bus); 8 is what the Taud device
 *  itself delivers, dither and all. */
const BIT_DEPTHS = Object.freeze([16, 8]);
const DEFAULT_BIT_DEPTH = 16;
/** Buckets the census is downsampled to for the wire and the picture. At 8 bits
 *  a bucket IS a code; at 16 it is the code's top eight bits, which is the same
 *  shape drawn at the same width. */
const HIST_BUCKETS = 256;

// ── The metering tap ────────────────────────────────────────────────────────

/** Tap stages. The view shows one at a time; the tap always measures both, so
 *  the toggle is instant and the two figures describe the SAME moment. */
const TAP_PRE = 0;
const TAP_POST = 1;
const TAP_STAGES = 2;

/**
 * Frames of mono audio the tap keeps per stage, for whoever wants a SPECTRUM
 * rather than a level.
 *
 * 2048 is one analysis window at the sizes fft.js uses — 43 ms at 48 kHz, 23 Hz
 * a bin — which is all a live spectrometer needs, and it is what the offline
 * analyser reads its samples out of a chunk at a time. Mono (the L+R sum): a
 * spectrum display asks where the energy is, not which side it came from, and
 * one ring is half the wire and half the transform.
 */
const SPEC_FRAMES = 2048;

/**
 * Everything the Mastering view's live readouts need, measured on the device
 * stereo pair on both sides of the chain.
 *
 * It is deliberately NOT the master strip's tap (analysis.js). That one answers
 * "where is the energy in the room?" and follows the song's surround model;
 * this one answers "what is going into the file, and what did the chain do to
 * it?", which is a question about two specific points in the signal path and
 * about the pair that gets dithered. Running both at once costs a few biquads
 * and buys an A/B that needs no re-render.
 *
 * Per stage, per channel: sample peak, true peak (4× oversampled), mean square
 * and a clip count. Per stage: the K-weighted energy the loudness figures are
 * built from. Post only: the histogram of the delivered 8-bit codes, because
 * "bit usage" is a question about the file and the pre-chain signal is not one.
 *
 * COST: opt-in, like every other tap here. It exists only while the Mastering
 * view is on screen.
 */
class MasterMeterTap {
  /**
   * @param rate      engine sampling rate
   * @param scramble  also measure the phase-scrambled peak and energy, for the
   *                  crest-gap reading. OFF for the live meters: eight biquads
   *                  per channel per stage is real work for a figure whose
   *                  whole point is a comparison over a WHOLE song, which is
   *                  the offline analyser's job.
   */
  constructor(rate, { scramble = false, bitDepth = DEFAULT_BIT_DEPTH } = {}) {
    this.rate = rate;
    this.scramble = scramble;
    /** Which delivered format the bit-usage census describes. See binOutput. */
    this.bitDepth = bitDepth === 8 ? 8 : 16;
    this.kw = [];
    this.tp = [];
    this.ap = [];
    for (let s = 0; s < TAP_STAGES; s++) {
      this.kw.push([new KWeighting(rate), new KWeighting(rate)]);
      this.tp.push(new TruePeakDetector(2));
      this.ap.push(scramble ? [new PhaseScrambler(rate), new PhaseScrambler(rate)] : null);
    }
    /** Phase-scrambled peak and Σ x², per stage (channel-summed). */
    this.apPeak = new Float64Array(TAP_STAGES);
    this.apSumSq = new Float64Array(TAP_STAGES);
    this.sumZ = new Float64Array(TAP_STAGES);        // channel-summed K-weighted
    this.sumSq = new Float64Array(TAP_STAGES * 2);   // [stage][channel]
    this.peak = new Float64Array(TAP_STAGES * 2);
    this.clip = new Float64Array(TAP_STAGES * 2);
    // A census of the delivered CODE, at the chosen depth: 256 entries for the
    // device's 8-bit output, 65536 for a 16-bit WAV. Never shipped whole — the
    // drain downsamples it to HIST_BUCKETS for the picture and computes the
    // figures from the full-resolution original.
    this.hist = new Float64Array(1 << this.bitDepth);
    this.buckets = new Float64Array(HIST_BUCKETS);
    /** Per-stage mono ring + its shared write cursor (both stages advance
     *  together, since they see the same block). Read backwards from
     *  `specWrite`, exactly like the strip's scope ring. */
    this.spec = [];
    for (let s = 0; s < TAP_STAGES; s++) this.spec.push(new Float32Array(SPEC_FRAMES));
    this.specWrite = 0;
    this.frames = 0;
    this.compGrDb = 0;
    this.limGrDb = 0;
  }

  /** Clear the filters AND the accumulators — what a transport reset owes a
   *  meter whose integration is supposed to describe one playback. */
  resetAll() {
    for (const pair of this.kw) for (const k of pair) k.reset();
    for (const d of this.tp) d.reset();
    for (const pair of this.ap) if (pair) for (const a of pair) a.reset();
    this.sumZ.fill(0); this.sumSq.fill(0); this.peak.fill(0); this.clip.fill(0);
    this.apPeak.fill(0); this.apSumSq.fill(0);
    this.hist.fill(0);
    for (const r of this.spec) r.fill(0);
    this.specWrite = 0;
    this.frames = 0;
    this.compGrDb = 0;
    this.limGrDb = 0;
  }

  /**
   * Fold one rendered block in at `stage`. Called twice per chunk with the SAME
   * buffer — once before the chain runs over it and once after — so no copy of
   * the pre-chain mix is ever made.
   */
  push(stage, left, right, frames) {
    const kw = this.kw[stage];
    const tp = this.tp[stage];
    const so = stage * 2;
    let z = this.sumZ[stage];
    let sqL = this.sumSq[so], sqR = this.sumSq[so + 1];
    let pkL = this.peak[so], pkR = this.peak[so + 1];
    let clL = this.clip[so], clR = this.clip[so + 1];
    for (let n = 0; n < frames; n++) {
      const l = left[n];
      const r = right[n];
      const zl = kw[0].run(l);
      const zr = kw[1].run(r);
      z += zl * zl + zr * zr;
      sqL += l * l; sqR += r * r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      // At and above full scale the delivered sample is a clipped one: the mix
      // bus is hard-clamped, so the pre-chain signal reaching ±1 is exactly the
      // material the chain is there to catch.
      if (al >= 1) clL += 1;
      if (ar >= 1) clR += 1;
      tp.push(0, l);
      tp.push(1, r);
    }
    if (this.scramble) {
      const ap = this.ap[stage];
      let apk = this.apPeak[stage];
      let asq = this.apSumSq[stage];
      for (let n = 0; n < frames; n++) {
        const sl = ap[0].run(left[n]);
        const sr = ap[1].run(right[n]);
        const a = Math.abs(sl) > Math.abs(sr) ? Math.abs(sl) : Math.abs(sr);
        if (a > apk) apk = a;
        asq += sl * sl + sr * sr;
      }
      this.apPeak[stage] = apk;
      this.apSumSq[stage] = asq;
    }
    // The mono ring. The write cursor belongs to the POST pass, which is the
    // second of the two and therefore the one that has seen a whole block —
    // PRE writes at the same positions on the way past.
    const ring = this.spec[stage];
    let w = this.specWrite;
    for (let n = 0; n < frames; n++) {
      ring[w] = (left[n] + right[n]) * 0.5;
      w = w + 1 === SPEC_FRAMES ? 0 : w + 1;
    }
    if (stage === TAP_POST) this.specWrite = w;

    this.sumZ[stage] = z;
    this.sumSq[so] = sqL; this.sumSq[so + 1] = sqR;
    this.peak[so] = pkL; this.peak[so + 1] = pkR;
    this.clip[so] = clL; this.clip[so + 1] = clR;
    if (stage === TAP_POST) this.frames += frames;
  }

  /**
   * Bin one block of delivered output. Both channels go into ONE census — the
   * question is what codes the file uses, not which side used them.
   *
   * The two depths come from two different places, deliberately:
   *
   *   * 8 bits is the DEVICE's output, so it is binned from the dithered,
   *     noise-shaped U8 buffer the engine actually produced. Re-quantising the
   *     float would miss the dither, which at eight bits is most of the point.
   *   * 16 bits is what a stereo WAV export writes, and that path takes the
   *     PRE-DITHER float bus straight to `round(clamp(x) × 32767)` — so the
   *     census repeats exactly that. (An export resampled to another rate
   *     re-quantises after the resampler; at the default 48 kHz, which is the
   *     engine's own rate, the codes are identical.)
   */
  binOutput(u8, left, right, frames) {
    const h = this.hist;
    if (this.bitDepth === 8) {
      for (let i = 0; i < frames * 2; i++) h[u8[i]] += 1;
      return;
    }
    for (let n = 0; n < frames; n++) {
      const l = left[n], r = right[n];
      h[(Math.round((l < -1 ? -1 : l > 1 ? 1 : l) * 32767) + 32768) & 0xffff] += 1;
      h[(Math.round((r < -1 ? -1 : r > 1 ? 1 : r) * 32767) + 32768) & 0xffff] += 1;
    }
  }

  /** Snapshot readout; resets the per-interval accumulators. The histogram is
   *  cumulative and is NOT reset here — it describes the playback so far, and
   *  the host clears it when playback restarts. */
  drain(out) {
    out.frames = this.frames;
    for (let s = 0; s < TAP_STAGES; s++) {
      out.sumZ[s] = this.sumZ[s];
      for (let c = 0; c < 2; c++) {
        const i = s * 2 + c;
        const tp = this.tp[s].peaks[c];
        out.peak[i] = this.peak[i];
        out.truePeak[i] = tp > this.peak[i] ? tp : this.peak[i];
        out.meanSquare[i] = this.frames > 0 ? this.sumSq[i] / this.frames : 0;
        out.clip[i] = this.clip[i];
      }
    }
    for (let s = 0; s < TAP_STAGES; s++) {
      out.apPeak[s] = this.apPeak[s];
      out.apSumSq[s] = this.apSumSq[s];
    }
    out.compGrDb = this.compGrDb;
    out.limGrDb = this.limGrDb;
    out.hist = this.hist;
    out.bitDepth = this.bitDepth;
    // The figures come from the FULL census — an exact `used` and `span` at 16
    // bits cannot be recovered from 256 buckets — and only the buckets go on
    // the wire. One walk does both.
    out.bits = bitUsage(this.hist, this.bitDepth);
    const shift = this.bitDepth - 8;
    this.buckets.fill(0);
    if (shift === 0) this.buckets.set(this.hist);
    else for (let i = 0; i < this.hist.length; i++) this.buckets[i >> shift] += this.hist[i];
    out.buckets = this.buckets;
    out.spec = this.spec;
    out.specWrite = this.specWrite;
    this.sumZ.fill(0); this.sumSq.fill(0); this.peak.fill(0); this.clip.fill(0);
    this.apPeak.fill(0); this.apSumSq.fill(0);
    for (const d of this.tp) d.clearPeaks();
    this.frames = 0;
    this.compGrDb = 0;
    this.limGrDb = 0;
    return out;
  }
}

/** A drain target, so the snapshot fill allocates nothing. */
function makeMasterMeterReadout() {
  return {
    frames: 0, compGrDb: 0, limGrDb: 0, hist: null, histTotal: 0,
    buckets: null, bits: null, bitDepth: DEFAULT_BIT_DEPTH,
    spec: null, specWrite: 0,
    sumZ: new Float64Array(TAP_STAGES),
    apPeak: new Float64Array(TAP_STAGES),
    apSumSq: new Float64Array(TAP_STAGES),
    peak: new Float64Array(TAP_STAGES * 2),
    truePeak: new Float64Array(TAP_STAGES * 2),
    meanSquare: new Float64Array(TAP_STAGES * 2),
    clip: new Float64Array(TAP_STAGES * 2),
  };
}

// ══ src/engine/samplemod.js ══
// Sample-modification note effects (items 130, 152, 153) — notefx 2 and 3, ONE
// command with two spellings: `3` names the region to modify, `2` names the
// region to leave alone. Both are NON-DESTRUCTIVE views over the sample pool,
// exactly as S $Fxxx is: the state lives on the INSTRUMENT and is applied when
// a byte is read (sampler.js readSamplePoint), so the pool itself is never
// written.
//
// Behavioural contract: TAUD_NOTE_EFFECTS.md §"2 $sexy and 3 $sexy".
//
//   $s $e   the region (see decodeSampleRegion)
//   $x      the operation — one at a time, so an instrument carries ONE
//           modification and writing either opcode replaces it
//   $y      the step period in TICKS: $F every tick, $E every other one, down
//           to $1 every fifteenth; $0 freezes (see modStepPeriod)
//
// EVERYTHING IS RELATIVE TO THE LOOP REGION (item 153). The command's domain is
// the sounding voice's loop when it has one and the whole sample when it does
// not, and every selector, every comb, every wrap and every jump quantum is
// measured against THAT — never against raw byte counts and never against the
// base record, so an Ixmp-patched voice follows its own loop (item 116) and a
// region written for one sample means the same thing on the next. The extent is
// therefore stored as a FRACTION pair and resolved per voice at read time
// (resolveModGeom), which is also what lets $A's eighths land on the eighths of
// a bar-length loop rather than of the file that contains it.
//
// Region argument, decoded once here so the two spellings cannot drift apart:
//
//   $00        the whole domain — the loop region, as S $Fxxx has always meant
//              it (same span as $0F, which is the spelling to reach for when
//              the point is "all of it" rather than "the loop")
//   $s..$e     s <= e: from s/16 to (e+1)/16 of the domain, rounded
//              — so $0F is all of it and $4B the middle half
//   $10        middle half            $20 first two thirds   $21 last two thirds
//   $30 $31 $32  first / middle / last third
//   $F0..$FE   COMB, even bristles: cut the extent into 2^(n+1) equal chunks
//              and keep the 0th, 2nd, 4th… — $F0 is the first HALF, $F1 is
//              '1-3-' of four, $FE is 32768 bristles
//   $E0..$ED   COMB, odd bristles: the same cut keeping the 1st, 3rd, 5th…
//              — $E0 is the second half, $E1 is '-2-4' of four
//   otherwise (s > e)  reserved — the whole command is ignored


/** decodeSampleRegion result: nothing (reserved argument). */
const REGION_NONE = 0;
/** decodeSampleRegion result: out = [from, to, combBits, combOdd] — a whole region. */
const REGION_SET = 1;
/** decodeSampleRegion result: out[2..3] = the comb only; the extent is kept. */
const REGION_COMB = 2;

// ── the operations ($x) ──────────────────────────────────────────────────────
// ROL rotates the region's BYTES left by 1/2/4/8 per step (there is no
// rotate-right: a left rotation of n and a right rotation of span−n are the
// same picture, and the ladder is more useful spent on step sizes). SUB
// subtracts from each byte's U8 value, wrapping through zero, by 2/8/32/128 per
// step — a running level slide that folds rather than clips.
//
// The rest of the nibble is two random families that share the ROL ladder's
// address transform and differ in what they apply it to. Every draw in both is
// UNIFORM (item 153.10).
//
// JUMP ($A $B $C) throws the WHOLE region to a new offset each step — the
// waveform arrives intact, somewhere else, a randomised `O $xxyy`, one draw a
// step. All three reach the whole domain and they differ in GRAIN: $A lands
// only on eighths of it and $B only on sixteenths, so a one-bar drum loop is
// re-dealt a slice at a time and every throw lands where a hit starts; $C lands
// anywhere, mid-transient included.
//
// SCATTER ($D $E $F) throws EVERY BYTE its own way, within 1/512, 1/64 or 1/8
// of the domain: the region is shuffled rather than moved. The ladder stops at
// an eighth on purpose — wider than that, the bytes a throw lands among have
// nothing to do with the ones it left, the interpolator averages strangers, and
// every setting past it arrives at the same quiet white noise. Kept near home
// the throw is a glitch in the waveform rather than a replacement for it, which
// is the sound this family is for.
const MOD_OFF = 0x0;
const MOD_INVERT = 0x1;
const MOD_ROL1 = 0x2;
const MOD_ROL8 = 0x5;
const MOD_SUB2 = 0x6;
const MOD_SUB128 = 0x9;
const MOD_JUMP8 = 0xa;
const MOD_JUMP16 = 0xb;
const MOD_JUMP_ALL = 0xc;
const MOD_RND512 = 0xd;
const MOD_RND8 = 0xf;
/** Highest operation; every $x nibble is assigned since item 152's second half. */
const MOD_MAX = MOD_RND8;

/** Step size per operation — bytes for the ROLs, U8 levels for the SUBs. The
 *  random operations take their reach from their own tables, so they read 0. */
const MOD_STEP = Object.freeze(
  [0, 0, 1, 2, 4, 8, 2, 8, 32, 128, 0, 0, 0, 0, 0, 0]);

/** How many equal slices a quantised jump throws to, by op − MOD_JUMP8. Eight
 *  is a bar of eighths and sixteen a bar of sixteenths, which is what makes the
 *  throw land where a drum loop's hits start. */
const MOD_JUMP_SLICES = Object.freeze([8, 16]);

/** SCATTER reach as a fraction of the wrap domain, by op − MOD_RND512. Each
 *  BYTE is thrown up to this far, uniformly and independently of its
 *  neighbours, so the fraction is a hard bound rather than a typical throw. */
const MOD_SCATTER_FRAC = Object.freeze([1 / 512, 1 / 64, 1 / 8]);

/** Largest comb exponent: $FE cuts the extent into 2^15 = 32768 bristles. The
 *  odd-bristle ladder stops at $ED (16384) because $EE and $EF already read as
 *  ordinary s <= e extents. */
const MOD_COMB_MAX = 0xe;
const MOD_COMB_ODD_MAX = 0xd;

/**
 * How far the INVERT walk may scan for the next byte the modification touches.
 * An inverted region can exclude almost the whole domain, and the walk must
 * not turn into a linear search for the one byte that is left — past this many
 * misses the step simply does not land. Well above any musically useful comb.
 */
const MOD_WALK_SCAN = 4096;

/**
 * Anti-click crossfade, in output samples (item 153.5). Every step of an
 * address or level transform is a discontinuity — a jump teleports the
 * waveform, a scatter re-deals it, SUB128 inverts it — and at $y = $F that is
 * one discontinuity per tick, which is what the clicking IS. So a step does not
 * take effect instantly: for 2 ms the voice reads BOTH mappings and crossfades
 * between them, which costs one extra pool read per tap for 64 samples and
 * turns the click into a transition. Long enough to bury the edge, short enough
 * to leave the effect its bite.
 */
const MOD_XFADE_SAMPLES = 64;

const isRolOp = (op) => op >= MOD_ROL1 && op <= MOD_ROL8;
const isSubOp = (op) => op >= MOD_SUB2 && op <= MOD_SUB128;
const isJumpOp = (op) => op >= MOD_JUMP8 && op <= MOD_JUMP_ALL;
const isRndOp = (op) => op >= MOD_RND512 && op <= MOD_RND8;

/**
 * The step period in TICKS for speed nibble $y (item 153.1): $F every tick, $E
 * every other tick, … $1 every fifteenth, $0 frozen.
 *
 * ProTracker's funk-speed ladder is gone from this command. That table is an
 * accumulator divisor — it exists because EFx had to fit its timing into a
 * running sum, which buys an uneven ladder whose steps land where the arithmetic
 * puts them rather than where the bar does. Nothing here needs that compromise,
 * and $A in particular is worth nothing without exact timing: a randomised drum
 * loop has to re-deal itself ON the tick grid or it is not in time. (S $Fxxx
 * keeps the historical ladder — it is ProTracker's effect and stays its own.)
 */
function modStepPeriod(y) {
  return (y & 0xf) === 0 ? 0 : 16 - (y & 0xf);
}

/**
 * One JUMP step's displacement ($A $B $C): a single offset for the whole region,
 * drawn afresh from its ORIGINAL position every step rather than added to the
 * last one — a random WALK would have made the three the same effect arriving
 * at different speeds. All three draw from the whole domain uniformly; the
 * difference is where they are allowed to LAND.
 *
 * `$A` and `$B` QUANTISE, to eighths and to sixteenths of the domain. That is
 * the difference between a beat repeat and a glitch: a one-bar loop cut into
 * eight lands every throw on a hit rather than in the middle of one, so what
 * comes back is the loop re-ordered, still in time; sixteenths halve the grain
 * for anything busier than a backbeat. `$C` is the free throw — anywhere,
 * transients included.
 *
 * Read back through the same transform ROL uses (the region moves as one
 * piece), so what comes out is the sample intact and re-seated — which is the
 * whole difference between this family and the scatter below.
 */
function jumpRot(op, domainLen) {
  if (domainLen < 2) return 0;
  if (op === MOD_JUMP8 || op === MOD_JUMP16) {
    // Round the slice, don't truncate it: a 1000-byte domain slices at 125, and
    // the last slice would otherwise drift a byte further from home each time.
    const slices = MOD_JUMP_SLICES[op - MOD_JUMP8];
    const slice = Math.max(1, Math.round(domainLen / slices));
    return (Math.min(Math.floor(random() * slices), slices - 1) * slice) % domainLen;
  }
  if (op !== MOD_JUMP_ALL) return 0;
  return Math.min(Math.floor(random() * domainLen), domainLen - 1);
}

/**
 * How far one scatter step may throw a byte, in bytes (0 = it cannot) — the
 * hard bound of a uniform draw, so a byte is as likely to land at the edge of
 * it as next door.
 */
function scatterReach(op, domainLen) {
  const frac = MOD_SCATTER_FRAC[op - MOD_RND512];
  if (frac === undefined || domainLen < 2) return 0;
  return Math.max(1, Math.min(Math.round(domainLen * frac), domainLen));
}

/** A fresh scramble for the next step. One draw per step — the per-byte spread
 *  comes out of the hash below, not out of 65535 more calls to the RNG. */
function scatterSeed() {
  return (random() * 0x100000000) >>> 0;
}

/**
 * Integer avalanche (the murmur3 finaliser's shape): (seed, i) → a uint32 with
 * no visible structure. It has to be a pure FUNCTION of the byte's index, not a
 * stream — one output sample reads the same position through every sinc tap and
 * every channel, and a fresh draw per read would smear the whole sample into
 * white noise regardless of the reach. This IS the per-byte randomness.
 */
function scatterHash(seed, i) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ i, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Where sample byte `i` is READ FROM under a live scatter (items 152, 153): its
 * own position displaced by its own random amount within ±`reach`, wrapped into
 * [domainStart, domainStart + domainLen). Every byte draws separately, so this
 * shuffles the region rather than moving it.
 *
 * The draw is UNIFORM over that range (item 153.10). A bell was tried, on the
 * reasoning that it would keep the narrow settings recognisable; what it
 * actually did was leave most bytes at home and fling a few, which reads as
 * white noise mixed under the sample rather than as the sample breaking up.
 * The glitch is in every byte moving a little, so the flat draw is the one that
 * sounds like the effect — and the ladder gets its range from `reach` instead,
 * which is why it now stops at an eighth of the domain.
 *
 * The mapping is not a permutation: a source byte may be drawn twice and
 * another not at all. Wanting one would mean shuffling an index table the size
 * of the sample on every step, which is not a thing to do inside a tick, and
 * a draw-with-replacement scramble is indistinguishable from a permutation at
 * this grain anyway.
 */
function scatterSource(i, domainStart, domainLen, reach, seed) {
  if (reach <= 0 || domainLen < 2) return i;
  const span = 2 * reach + 1;
  // Map the hash onto [0, span) by multiply-shift: no modulo, and the product
  // stays exact in a double (2^32 × 2^17 well under 2^53).
  const d = ((scatterHash(seed, i) * span) / 4294967296 | 0) - reach;
  let k = (i - domainStart + d) % domainLen;
  if (k < 0) k += domainLen;
  return domainStart + k;
}

/** Scratch quad for the decoders (callers own theirs; engine never allocates
 *  inside a tick): [from, to, combBits, combOdd]. */
const regionScratch = new Float64Array(4);

/**
 * Decode the $se region byte into a FRACTION of the command's domain. Nothing
 * here knows how long anything is: the same $se means the same thing on every
 * sample, and resolveModGeom below is what turns it into byte offsets against
 * whichever loop the voice is actually sounding.
 *
 * Writes [from, to, combBits, combOdd] into `out` and returns one of the
 * REGION_* codes. `combBits` is -1 for a solid region, else n where the extent
 * is cut into 2^(n+1) chunks; `combOdd` picks which alternate chunks are kept.
 */
function decodeSampleRegion(se, out) {
  const s = (se >>> 4) & 0xf;
  const e = se & 0xf;
  // The two comb ladders come first, so $F0..$FE and $E0..$ED stay combs rather
  // than falling into the s > e reserved space. $FF, $EE and $EF have s <= e
  // and are ordinary extents — which is exactly why the odd ladder is one rung
  // shorter than the even one.
  if (s === 0xf && e !== 0xf) { out[2] = e; out[3] = 0; return REGION_COMB; }
  if (s === 0xe && e <= MOD_COMB_ODD_MAX) { out[2] = e; out[3] = 1; return REGION_COMB; }
  // A new extent clears the comb: the two are independent halves of one region,
  // but a region written from scratch is written solid.
  out[2] = -1;
  out[3] = 0;
  // $00 is the whole domain — the loop region, as S $Fxxx has always meant it.
  // Listed before the s <= e rule, which would otherwise read it as the first
  // sixteenth (unreachable, and no loss: $01 is the first two).
  if (se === 0x00) { out[0] = 0; out[1] = 1; return REGION_SET; }
  if (s <= e) { out[0] = s / 16; out[1] = (e + 1) / 16; return REGION_SET; }
  switch (se) {
    case 0x10: out[0] = 1 / 4; out[1] = 3 / 4; break;
    case 0x20: out[0] = 0;     out[1] = 2 / 3; break;
    case 0x21: out[0] = 1 / 3; out[1] = 1;     break;
    case 0x30: out[0] = 0;     out[1] = 1 / 3; break;
    case 0x31: out[0] = 1 / 3; out[1] = 2 / 3; break;
    case 0x32: out[0] = 2 / 3; out[1] = 1;     break;
    default: return REGION_NONE; // $40..$DD with s > e — reserved
  }
  return REGION_SET;
}

/**
 * One voice's resolved view of the instrument's region: the fractions above cut
 * against the loop the voice is really sounding. Cached on the Voice and
 * refreshed by resolveModGeom when either side moves, because the read path
 * costs two multiplies and a divide to build and is walked once per
 * interpolator tap.
 */
class ModGeom {
  constructor() {
    // Cache key: the instrument's region and the voice's domain.
    this.epoch = -1;
    this.inst = null;
    this.base = -1;
    this.len = -1;
    // Resolved geometry.
    this.live = false;      // is there anything for the read path to do?
    this.es = 0;            // extent, in absolute sample bytes
    this.ee = 0;
    this.combN = 0;         // chunks the extent is cut into (0 = solid)
    this.combOdd = false;   // keep the odd chunks rather than the even ones
    this.combScale = 0;     // combN / extent length — chunk index by multiply
    this.ds = 0;            // wrap domain for the address transforms
    this.dl = 0;
  }
}

/**
 * Resolve `inst`'s region against the loop the voice is sounding, into `g`.
 * Returns `g`. The domain is the loop region when there is one and the whole
 * sample when there is not — the same test §8.4's invert mask makes, so the two
 * features cover the same bytes.
 *
 * `inst` is duck-typed: anything carrying modFrom / modTo / modCombBits /
 * modCombOdd / modInvert / modEpoch will do, which is how the sample view draws
 * the modification through the engine's own geometry instead of a copy of it.
 */
function resolveModGeom(g, inst, loopStart, loopEnd, sampleLen) {
  const looped = loopEnd > loopStart;
  const base = looped ? loopStart : 0;
  const len = looped ? loopEnd - loopStart : sampleLen;
  if (g.epoch === inst.modEpoch && g.inst === inst && g.base === base && g.len === len) return g;
  g.epoch = inst.modEpoch;
  g.inst = inst;
  g.base = base;
  g.len = len;
  const es = base + Math.round(len * inst.modFrom);
  const ee = base + Math.round(len * inst.modTo);
  g.es = es;
  g.ee = ee;
  g.live = len >= 2 && ee - es >= 2;
  const bits = inst.modCombBits;
  g.combN = bits < 0 ? 0 : 2 << bits;
  g.combOdd = inst.modCombOdd;
  g.combScale = g.combN / Math.max(ee - es, 1);
  // An inverted region's touched set reaches both ends of the DOMAIN, so that
  // is the span its address transform wraps in; a plain region wraps in itself.
  g.ds = inst.modInvert ? base : es;
  g.dl = inst.modInvert ? len : ee - es;
  return g;
}

/**
 * Does the modification touch sample byte `i`? The extent and its comb decide,
 * and notefx 2's inversion flips the answer — which is the ONLY difference
 * between the two opcodes. Nothing outside the domain is ever touched, by
 * either spelling: `2` spares its region and modifies the REST OF THE LOOP, not
 * the rest of the file.
 */
function modTouches(g, invert, i) {
  let inside = i >= g.es && i < g.ee;
  if (inside && g.combN > 0) {
    // Which bristle: the extent cut into combN equal chunks, truncated. One
    // multiply, because the divide that makes combScale is done per geometry
    // rather than per read.
    inside = ((((i - g.es) * g.combScale) | 0) & 1) === (g.combOdd ? 1 : 0);
  }
  return invert ? !inside && i >= g.ds && i < g.ds + g.dl : inside;
}

/**
 * Where a touched byte is actually READ FROM: the address transform of whatever
 * operation is live, wrapped into the geometry's domain. `rot` moves every byte
 * together (ROL and JUMP), `scatter` gives each its own throw; only one of the
 * two is ever non-zero, since an instrument carries one operation.
 */
function modAddress(g, i, rot, scatter, seed) {
  const dl = g.dl;
  if (dl < 2) return i;
  if (scatter > 0) return scatterSource(i, g.ds, dl, scatter, seed);
  if (rot === 0) return i;
  let k = (i - g.ds + rot) % dl;
  if (k < 0) k += dl;
  return g.ds + k;
}

// ═══════════════════════════════════════════════════════════════════════════
// Argument extension (item 162) — notefx 2/3 paired with `:`. Base behaviour
// above is untouched; everything below is new, parallel machinery reached
// only when an instrument's modOpExt is non-zero (mutually exclusive with the
// classic 4-bit modOp — writing one clears the other, see inst.js
// setModOpExt/setModOp). Spec: TAUD_NOTE_EFFECTS.md "`:` $xxxx — Argument
// extension" and its "Extended" subsections under 2/3, J and O.
// ═══════════════════════════════════════════════════════════════════════════

// ── $f — sub-range modifier, layered on top of $se's already-resolved extent ──
//
// $1..$9 are STATIC further cuts of the extent (same shape as $se's own
// $10/$20..$32 rows, just measured against [es,ee) instead of the domain).
// $A..$D ALTERNATE between two such cuts, one step at a time — which, because
// the two halves/quarters of an alternating pair are exactly a comb's even and
// odd chunks, is nothing more than a 2- or 4-way comb whose `odd` flips with
// the step counter (`voice.modStepIndex`) rather than staying fixed. $E/$F are
// a fixed BYTE-count comb (4-of-8, 1-of-2) rather than a fraction of the
// extent, for when the extent itself is too short for $se's own comb ladder to
// bite.
const F_STATIC_RANGE = Object.freeze({
  0x1: [0, 1 / 2], 0x2: [1 / 2, 1],
  0x3: [0, 1 / 3], 0x7: [1 / 3, 2 / 3], 0x8: [2 / 3, 1],
  0x4: [0, 1 / 4], 0x5: [1 / 2, 3 / 4], 0x6: [1 / 4, 3 / 4], 0x9: [3 / 4, 1],
});

/**
 * Does `$f` (0..$F) keep sample byte `i`, given the extent [es,ee) $se already
 * resolved and this instrument's step counter (for the $A-$D alternation)?
 * Called ANDed with the ordinary extent+comb test — a byte must clear both.
 */
function fModTouches(f, i, es, ee, stepIndex) {
  if (f === 0) return true;
  const len = ee - es;
  if (len < 1) return true;
  const rel = i - es;
  const range = F_STATIC_RANGE[f];
  if (range !== undefined) {
    const lo = es + Math.round(len * range[0]);
    const hi = es + Math.round(len * range[1]);
    return i >= lo && i < hi;
  }
  if (f >= 0xa && f <= 0xd) {
    const n = f >= 0xc ? 4 : 2; // A/B halves, C/D quarters
    const chunk = Math.min(Math.floor((rel * n) / len), n - 1);
    const startOdd = (f === 0xb || f === 0xd) ? 1 : 0; // B/D open on the "second" piece
    return (chunk & 1) === ((stepIndex + startOdd) & 1);
  }
  if (f === 0xe) return (rel & 7) < 4;   // 1234----
  if (f === 0xf) return (rel & 1) === 0; // 1-3-5-
  return true;
}

// ── $xuu — the extended operation table (0x000..0xFFF) ──
const EXT_OP_NOOP = 0x100;
const EXT_OP_INVERT = 0x101;
const EXT_OP_FUNK = 0x102;
const EXT_OP_SIMPLE_INVERT = 0x103;
const EXT_OP_REVERSE = 0x104;

/** True for `$102` and `$12x` — the funk-repeat kinds, checked from
 *  sampler.js's per-output-sample loop-wrap test, so it must not allocate
 *  the way decodeExtOp's `{kind, param}` object does. */
function isExtFunkOp(code) {
  return code === EXT_OP_FUNK || (code >= 0x120 && code <= 0x12f);
}

/** Quantised-jump / bounded-jitter N-table, indexed by the code's low nibble
 *  (16 entries) — shared by $13x/$14x/$15x. */
const EXT_JUMP_N = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 18, 21, 24, 32]);

/** Jitter reach as a fraction of the domain for $11x/$12x's low nibble:
 *  ±100/2^(15-x) %, i.e. 2^(x-15) — a 16-rung geometric ladder from ~0.003%
 *  to 100%. */
function extJitterFrac(x) { return Math.pow(2, (x & 0xf) - 15); }

/** Scatter reach ladder for $161..$16F (16 levels, finer than the base
 *  command's 3): 1/16384 at $1 down to "fully" (reach = whole domain) at $F. */
const EXT_SCATTER_FRAC = Object.freeze([
  0, 1 / 16384, 1 / 8192, 1 / 4096, 1 / 2048, 1 / 1024, 1 / 512, 1 / 256,
  1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1,
]);

// Bit-permutation table for $920..$927 — each entry is a byte->byte LUT.
// Built from three involutions (reverse the 8 bits, swap the two nibbles,
// swap each adjacent bit pair) whose compositions match the TODO's worked
// examples exactly (abcdefgh -> ... for each of the eight codes):
//   920 NOT              921 reverse            922 swap nibbles
//   923 reverse+nibbles  924 swap twobits        925 reverse+twobits
//   926 nibbles+twobits  927 all three (commute)
function revBits8(b) {
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
  return b & 0xff;
}
const swapNibbles8 = (b) => ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
const swapTwobits8 = (b) => ((b & 0xaa) >> 1) | ((b & 0x55) << 1);

function buildBitpermLUT(fn) {
  const t = new Uint8Array(256);
  for (let b = 0; b < 256; b++) t[b] = fn(b);
  return t;
}
/** [920, 921, ..., 927] -> Uint8Array(256) LUT, indexed by (code & 7). */
const EXT_BITPERM_LUT = Object.freeze([
  buildBitpermLUT((b) => b ^ 0xff),                                  // 920 NOT
  buildBitpermLUT(revBits8),                                          // 921
  buildBitpermLUT(swapNibbles8),                                      // 922
  buildBitpermLUT((b) => swapNibbles8(revBits8(b))),                  // 923
  buildBitpermLUT(swapTwobits8),                                      // 924
  buildBitpermLUT((b) => swapTwobits8(revBits8(b))),                  // 925
  buildBitpermLUT((b) => swapTwobits8(swapNibbles8(b))),              // 926
  buildBitpermLUT((b) => swapTwobits8(swapNibbles8(revBits8(b)))),    // 927
]);

/**
 * Classify a 12-bit $xuu code into a step-function KIND plus its numeric
 * parameter — the one place that knows the table's shape, so the stepper
 * (tick.js advanceSampleModExtended) and nothing else has to.
 */
function decodeExtOp(code) {
  if (code === 0 || code === EXT_OP_NOOP) return { kind: "noop", param: 0 };
  if (code === EXT_OP_INVERT) return { kind: "invert", param: 0 };
  if (code === EXT_OP_FUNK) return { kind: "funk", param: 0 };
  if (code === EXT_OP_SIMPLE_INVERT) return { kind: "xor", param: 0xff };
  if (code === EXT_OP_REVERSE) return { kind: "mirror", param: 0 };
  if (code >= 0x110 && code <= 0x11f) return { kind: "invertJit", param: code & 0xf };
  if (code >= 0x120 && code <= 0x12f) return { kind: "funkJit", param: code & 0xf };
  // $13x "no domain restriction" and $14x "restricted to $se+$f" land in the
  // same wrap domain either way — this command's architecture already scopes
  // every address transform to the resolved extent (g.ds/g.dl), so the two
  // codes are the same jump under it; see TAUD_NOTE_EFFECTS.md's note on this.
  if (code >= 0x130 && code <= 0x14f) return { kind: "jumpN", param: EXT_JUMP_N[code & 0xf] };
  if (code >= 0x150 && code <= 0x15f) return { kind: "jumpNBounded", param: EXT_JUMP_N[code & 0xf] };
  if (code === 0x160) return { kind: "swap", param: 0 };
  if (code >= 0x161 && code <= 0x16f) return { kind: "scatter", param: EXT_SCATTER_FRAC[code & 0xf] };
  if (code >= 0x200 && code <= 0x2ff) return { kind: "rol", param: code & 0xff };
  if (code >= 0x300 && code <= 0x3ff) return { kind: "rol", param: -(code & 0xff) };
  if (code >= 0x400 && code <= 0x4ff) return { kind: "rol", param: (code & 0xff) * 256 };
  if (code >= 0x500 && code <= 0x5ff) return { kind: "rol", param: -(code & 0xff) * 256 };
  if (code >= 0x600 && code <= 0x6ff) return { kind: "sub", param: code & 0xff };
  if (code >= 0x700 && code <= 0x7ff) return { kind: "sub", param: -(code & 0xff) };
  if (code >= 0x800 && code <= 0x8ff) return { kind: "xor", param: code & 0xff };
  if (code >= 0x900 && code <= 0x90f) return { kind: "bitrot", param: code & 0xf };
  if (code >= 0x910 && code <= 0x91f) return { kind: "bitrot", param: -(code & 0xf) };
  if (code >= 0x920 && code <= 0x927) return { kind: "bitperm", param: code & 0x7 };
  return { kind: "noop", param: 0 };
}

// ── $yk — extended speed ──
//
// $y = 0x0..0xE: period (ticks) = y + k/16 — the linear formula the TODO
// gives for y=0,1,2 simply continues through the whole fine ladder, 1/16-tick
// resolution from 0 up to ~14.94 ticks. $00 is the one exception: "stop"
// (frozen), not "period 0". $y = 0xF: the TODO's own coarse ladder, for
// periods the fine ladder's ~15-tick ceiling can't reach.
const EXT_YK_COARSE = Object.freeze([15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]);

/** $yk -> period in TICKS (float), or 0 = frozen ($00 only). */
function extYkPeriodTicks(yk) {
  const y = (yk >>> 4) & 0xf;
  const k = yk & 0xf;
  if (yk === 0) return 0;
  if (y === 0xf) return EXT_YK_COARSE[k];
  return y + k / 16;
}

/**
 * Where a touched byte is read from, for the address-transform kinds only
 * (`rol`/jump family reuse the classic accumulator via `modAddress`; `mirror`
 * and `swap` need their own map). Level-transform kinds (`sub`/`xor`/`bitrot`/
 * `bitperm`) don't move the address — see applyExtLevel below.
 */
function modAddressExt(g, i, inst) {
  if (inst.modExtSwapA >= 0) {
    if (i === inst.modExtSwapA) return inst.modExtSwapB;
    if (i === inst.modExtSwapB) return inst.modExtSwapA;
    return i;
  }
  if (inst.modExtMirror) {
    const dl = g.dl;
    if (dl < 2) return i;
    let k = (i - g.ds) % dl;
    if (k < 0) k += dl;
    return g.ds + (dl - 1 - k);
  }
  return modAddress(g, i, inst.modRot, inst.modScatter, inst.modSeed);
}

/** Rotate the low 3 bits of `amt` worth of bit-rotation into byte `b` (left
 *  for amt>0, right for amt<0 — modBitRot is stored net-left, mod 8). */
function bitRotate8(b, amt) {
  const n = ((amt % 8) + 8) % 8;
  if (n === 0) return b;
  return ((b << n) | (b >>> (8 - n))) & 0xff;
}

/** Apply the CURRENT extended level transform (sub/add share `modSub`'s
 *  accumulator — see inst.js; xor/103/920 share `modXor`'s). */
function applyExtLevel(inst, b) {
  if (inst.modSub !== 0) b = (b - inst.modSub) & 0xff;
  if (inst.modXor !== 0) b ^= inst.modXor;
  if (inst.modBitRot !== 0) b = bitRotate8(b, inst.modBitRot);
  if (inst.modBitPermOn) b = EXT_BITPERM_LUT[inst.modBitPermIdx][b];
  return b;
}

/** Apply the PREVIOUS step's level transform, for the crossfade — only the
 *  kinds that get one (sub/add, xor/103/920) carry a Prev snapshot. */
function applyExtLevelPrev(inst, b) {
  if (inst.modPrevSub !== 0) b = (b - inst.modPrevSub) & 0xff;
  if (inst.modPrevXor !== 0) b ^= inst.modPrevXor;
  return b;
}

/** modTouches, ANDed with $f's further narrowing — the one gate both the
 *  extended read path and the INVERT-family walk test against. */
function extModTouches(g, invert, f, stepIndex, i) {
  return modTouches(g, invert, i) && fModTouches(f, i, g.es, g.ee, stepIndex);
}

// ══ src/engine/inst.js ══
// Taud instrument data model — port of AudioAdapter.kt TaudInstEnvPoint (5246),
// TaudInstPatch (5261), MetaLayer (5312), TaudInst (5378-5766).
// Envelope point `offset` is the ThreeFiveMiniUfloat LUT index (0..255);
// use minifloatToDouble(pt.offset) for seconds.

function envPoint(value, offset = 0) {
  return { value, offset };
}

function makeEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * One Ixmp "extra sample" patch — overlays sample-scope state on a base
 * instrument for a (noteVal, rowVolume) rectangle. Optional v/p/f/P/x blocks
 * additionally override envelopes and fadeout/cutoff/resonance; anything left
 * absent (null env / hasExtra=false) defers to the base TaudInst.
 * Sentinels: defaultPan 0xFF, defaultNoteVolume 0, vibratoWaveform 0xFF all
 * mean "inherit the base instrument's value".
 *
 * The 's' block (hasChanBlock) makes the patch MULTI-CHANNEL: every channel is
 * a separate pool span sharing this record's length / loop / rate geometry,
 * with `chanPtrs` holding the pointers for channels 2..chanCount (channel 1 is
 * samplePtr). Only stereo (chanCount 2) is played today; the format's
 * quadraphonic/ambisonic cases are TODO #998.
 */
function makeInstPatch(fields) {
  return {
    pitchStart: 0, pitchEnd: 0, volumeStart: 0, volumeEnd: 0,
    samplePtr: 0, sampleLength: 0, playStart: 0, loopStart: 0, loopEnd: 0,
    samplingRate: 0, sampleDetune: 0, loopMode: 0,
    defaultPan: 0xff, defaultNoteVolume: 0,
    vibratoSpeed: 0, vibratoSweep: 0, vibratoDepth: 0, vibratoRate: 0,
    vibratoWaveform: 0xff,
    volEnv: null, volEnvLoop: 0, volEnvSustain: 0,
    panEnv: null, panEnvLoop: 0, panEnvSustain: 0,
    filterEnv: null, filterEnvLoop: 0, filterEnvSustain: 0,
    pitchEnv: null, pitchEnvLoop: 0, pitchEnvSustain: 0,
    hasExtra: false, fadeoutStep: 0, filterSfMode: false,
    extraCutoff: 0xff, extraResonance: 0xff, extraInitialAttenOctet: 0,
    hasChanBlock: false, chanCount: 1, chanMode: CHAN_MODE_DISCRETE,
    chanFlags: 0, chanPtrs: [],
    ...fields,
  };
}

/** 's' block channel modes (low nibble of the count/mode byte). */
const CHAN_MODE_DISCRETE = 0; // XY stereo, 4-track quad — one channel per speaker feed
const CHAN_MODE_MATRIX = 1;   // M/S stereo, ambisonic B-format — decoded before panning

function patchSampleLoopSustain(patch) {
  return (patch.loopMode & 0x04) !== 0;
}

/** Every pool span the patch plays, channel order: [samplePtr, ...chanPtrs]. */
function patchChannelPtrs(patch) {
  return patch.hasChanBlock && patch.chanCount > 1
    ? [patch.samplePtr, ...patch.chanPtrs.slice(0, patch.chanCount - 1)]
    : [patch.samplePtr];
}

/**
 * The Ixmp patch a voice is actually sounding, from the index applyActiveSample
 * recorded on it (-1 = the base record). Bounds-checked: a mid-playback patch
 * re-upload (the Advanced editor) can shorten the list under a live voice.
 */
function patchAt(inst, patchIndex) {
  if (inst == null || patchIndex < 0) return null;
  const patches = inst.extraPatches;
  return patches !== null && patchIndex < patches.length ? patches[patchIndex] : null;
}

/** True when the patch plays exactly two channels (the only multi-channel case
 *  the mixer renders today). */
function patchIsStereo(patch) {
  return patch.hasChanBlock && patch.chanCount === 2 && patch.chanPtrs.length >= 1;
}

/** Base-record field name → the Ixmp patch field it is duplicated into, for
 *  the sample geometry every patch record carries independently (spec §9.11:
 *  "Loop mode ... identical to base record byte 14"). Used to keep a base
 *  stereo patch (below) in sync when the instrument's own sample fields are
 *  edited (item 180). */
const BASE_TO_PATCH_FIELD = {
  samplePtr: "samplePtr", sampleLength: "sampleLength", samplingRate: "samplingRate",
  samplePlayStart: "playStart", sampleLoopStart: "loopStart", sampleLoopEnd: "loopEnd",
  sampleDetune: "sampleDetune", loopMode: "loopMode",
};

/**
 * Index of the Ixmp patch that exists ONLY to add channels to this
 * instrument's OWN base sample (item 90/180): a base record cannot itself
 * carry the 's' block, so a stereo canonical sample gets one extra,
 * full-range patch that duplicates the base record's sample geometry and adds
 * the 's' block. Matched by sample identity (same samplePtr/sampleLength as
 * the base record) plus `hasChanBlock`, not by rectangle bounds — that is the
 * same condition `Document.sampleList()` uses to decide a base record and a
 * patch describe "the same sample" (its `chanPtrs` merge rule), so an
 * ordinary same-sample zone that carries no 's' block is never matched here.
 * Because its rectangle is the whole keyboard, this patch always wins patch
 * selection, so the base record's own copy of these fields is otherwise dead
 * for playback — it must be kept in sync, not edited independently. -1 when
 * the instrument has none.
 */
function baseStereoPatchIndex(inst) {
  const patches = inst.extraPatches;
  if (!patches) return -1;
  return patches.findIndex((p) => p.hasChanBlock && p.chanCount > 1 &&
    p.samplePtr === inst.samplePtr && p.sampleLength === inst.sampleLength);
}

/**
 * True when the patch says nothing about auto-vibrato and the base record's
 * block should be used whole (item 170). The wire has one sentinel for five
 * fields — the $FF waveform — and a patch that carries it while leaving all
 * four numbers at zero is stating "inherit", not "no vibrato": reading its
 * zeroes switched the instrument's own vibrato off on every note a keyboard
 * map covered. Any non-zero number means the patch IS stating its own vibrato
 * and only borrows the waveform.
 */
function patchVibratoInherits(patch) {
  return patch.vibratoWaveform === 0xff && patch.vibratoSpeed === 0 &&
    patch.vibratoSweep === 0 && patch.vibratoDepth === 0 && patch.vibratoRate === 0;
}

/**
 * Parse a flat variable-length Ixmp patch blob (wire format) into patch
 * objects — the codec from AudioJSR223Delegate.kt:357-430, shared by the
 * engine upload path and the document layer. Returns [] for a short blob.
 */
function parsePatchesBlob(bytes) {
  if (bytes.length < 31) return [];
  const u8 = (o) => bytes[o] & 0xff;
  const u16 = (o) => (bytes[o] & 0xff) | ((bytes[o + 1] & 0xff) << 8);
  const s16 = (o) => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v; };
  const u32 = (o) =>
    ((bytes[o] & 0xff) | ((bytes[o + 1] & 0xff) << 8) | ((bytes[o + 2] & 0xff) << 16)) +
    (bytes[o + 3] & 0xff) * 0x1000000;

  const patches = [];
  let o = 0;
  outer: while (o + 31 <= bytes.length) {
    const ver = u8(o);
    let p = o + 31;
    let hasExtra = false, fadeoutStep = 0, extraCutoff = 0xff, extraResonance = 0xff;
    let extraAttenOctet = 0, filterSfMode = false;
    if ((ver & 0x80) !== 0) { // 'x' block (15 bytes)
      if (p + 15 > bytes.length) break;
      filterSfMode = (u8(p) & 0x01) !== 0;
      fadeoutStep = u16(p + 8);
      extraCutoff = u16(p + 10);
      extraResonance = u16(p + 12);
      extraAttenOctet = u8(p + 14);
      hasExtra = true;
      p += 15;
    }
    const readEnv = () => {
      if (p + 54 > bytes.length) return null;
      const loop = u16(p);
      const sus = u16(p + 2);
      const arr = new Array(25);
      for (let k = 0; k < 25; k++) arr[k] = envPoint(u8(p + 4 + 2 * k), u8(p + 5 + 2 * k));
      p += 54;
      return { arr, loop, sus };
    };
    let volEnv = null, volLoop = 0, volSus = 0;
    let panEnv = null, panLoop = 0, panSus = 0;
    let filEnv = null, filLoop = 0, filSus = 0;
    let pitEnv = null, pitLoop = 0, pitSus = 0;
    if ((ver & 0x02) !== 0) { const e = readEnv(); if (e === null) break outer; volEnv = e.arr; volLoop = e.loop; volSus = e.sus; }
    if ((ver & 0x04) !== 0) { const e = readEnv(); if (e === null) break outer; panEnv = e.arr; panLoop = e.loop; panSus = e.sus; }
    if ((ver & 0x08) !== 0) { const e = readEnv(); if (e === null) break outer; filEnv = e.arr; filLoop = e.loop; filSus = e.sus; }
    if ((ver & 0x10) !== 0) { const e = readEnv(); if (e === null) break outer; pitEnv = e.arr; pitLoop = e.loop; pitSus = e.sus; }
    // 's' block LAST (terranmon.txt Ixmp Note 6): u8 count/mode + u24 flags +
    // one u32 sample pointer per EXTRA channel.
    let hasChanBlock = false, chanCount = 1, chanMode = CHAN_MODE_DISCRETE;
    let chanFlags = 0, chanPtrs = [];
    if ((ver & 0x20) !== 0) {
      if (p + 4 > bytes.length) break;
      const cb = u8(p);
      chanCount = (cb >>> 4) + 1;
      chanMode = cb & 0x0f;
      chanFlags = u8(p + 1) | (u8(p + 2) << 8) | (u8(p + 3) << 16);
      if (p + 4 + 4 * (chanCount - 1) > bytes.length) break;
      for (let k = 0; k < chanCount - 1; k++) chanPtrs.push(u32(p + 4 + 4 * k));
      hasChanBlock = true;
      p += 4 + 4 * (chanCount - 1);
    }
    patches.push(makeInstPatch({
      pitchStart: u16(o + 1),
      pitchEnd: u16(o + 3),
      volumeStart: u8(o + 5),
      volumeEnd: u8(o + 6),
      samplePtr: u32(o + 7),
      sampleLength: u16(o + 11),
      playStart: u16(o + 13),
      loopStart: u16(o + 15),
      loopEnd: u16(o + 17),
      samplingRate: u16(o + 19),
      sampleDetune: s16(o + 21),
      loopMode: u8(o + 23),
      defaultPan: u8(o + 24),
      defaultNoteVolume: u8(o + 25),
      vibratoSpeed: u8(o + 26),
      vibratoSweep: u8(o + 27),
      vibratoDepth: u8(o + 28),
      vibratoRate: u8(o + 29),
      vibratoWaveform: u8(o + 30),
      volEnv, volEnvLoop: volLoop, volEnvSustain: volSus,
      panEnv, panEnvLoop: panLoop, panEnvSustain: panSus,
      filterEnv: filEnv, filterEnvLoop: filLoop, filterEnvSustain: filSus,
      pitchEnv: pitEnv, pitchEnvLoop: pitLoop, pitchEnvSustain: pitSus,
      hasExtra, fadeoutStep, filterSfMode,
      extraCutoff, extraResonance, extraInitialAttenOctet: extraAttenOctet,
      hasChanBlock, chanCount, chanMode, chanFlags, chanPtrs,
    }));
    o = p;
  }
  return patches;
}

/**
 * Serialise patch objects back to the flat wire blob — the exact byte-inverse
 * of parsePatchesBlob (blocks emitted in on-wire order x, v, p, f, P, s).
 * Shared by the engine capture path (getInstrumentPatches) and the document
 * layer's Ixmp patch editor.
 */
function writePatchesBlob(patches) {
  const out = [];
  const w8 = (v) => out.push(v & 0xff);
  const w16 = (v) => { out.push(v & 0xff, (v >>> 8) & 0xff); };
  const w32 = (v) => { w16(v); w16(v >>> 16); };
  const wEnv = (env, loop, sus) => {
    w16(loop); w16(sus);
    for (let k = 0; k < 25; k++) { w8(env[k].value); w8(env[k].offset); }
  };
  for (const p of patches) {
    let ver = 0x01;
    if (p.hasExtra) ver |= 0x80;
    if (p.volEnv !== null) ver |= 0x02;
    if (p.panEnv !== null) ver |= 0x04;
    if (p.filterEnv !== null) ver |= 0x08;
    if (p.pitchEnv !== null) ver |= 0x10;
    if (p.hasChanBlock) ver |= 0x20;
    w8(ver);
    w16(p.pitchStart); w16(p.pitchEnd);
    w8(p.volumeStart); w8(p.volumeEnd);
    w32(p.samplePtr);
    w16(p.sampleLength); w16(p.playStart); w16(p.loopStart); w16(p.loopEnd);
    w16(p.samplingRate); w16(p.sampleDetune); // two's complement round-trips
    w8(p.loopMode); w8(p.defaultPan); w8(p.defaultNoteVolume);
    w8(p.vibratoSpeed); w8(p.vibratoSweep); w8(p.vibratoDepth);
    w8(p.vibratoRate); w8(p.vibratoWaveform);
    if (p.hasExtra) {
      w32(p.filterSfMode ? 1 : 0); w32(0);
      w16(p.fadeoutStep); w16(p.extraCutoff); w16(p.extraResonance);
      w8(p.extraInitialAttenOctet);
    }
    if (p.volEnv !== null) wEnv(p.volEnv, p.volEnvLoop, p.volEnvSustain);
    if (p.panEnv !== null) wEnv(p.panEnv, p.panEnvLoop, p.panEnvSustain);
    if (p.filterEnv !== null) wEnv(p.filterEnv, p.filterEnvLoop, p.filterEnvSustain);
    if (p.pitchEnv !== null) wEnv(p.pitchEnv, p.pitchEnvLoop, p.pitchEnvSustain);
    if (p.hasChanBlock) {
      const extra = Math.max(0, Math.min(15, p.chanCount - 1));
      w8(((extra & 0x0f) << 4) | (p.chanMode & 0x0f));
      w8(p.chanFlags); w8(p.chanFlags >>> 8); w8(p.chanFlags >>> 16);
      for (let k = 0; k < extra; k++) w32(p.chanPtrs[k] ?? 0);
    }
  }
  return Uint8Array.from(out);
}

/**
 * One layer of a Metainstrument. mixOctet is the raw PSO-dB octet (159 = unity).
 *
 * `fixedPitch` is the type-0 NON-MELODIC flag (item 179, §7.4 byte +9 bit 6):
 * the layer sounds one pitch whatever key was struck, and `detune` stops being
 * a signed offset and becomes that pitch — an UNSIGNED 4096-TET note word, the
 * same units a pattern cell writes. Everything else about the layer is
 * unchanged, the gating rectangle included: which keys reach the layer is still
 * a question the rectangle answers, and only what it then sounds is fixed.
 */
function makeMetaLayer(instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd,
                              fixedPitch = false) {
  return { instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd, fixedPitch };
}

/** Layer byte +9, bit 6 — the type-0 fixed-pitch flag. RESERVED in every other
 *  kind: a type-4 rack's entries read the bit as nothing at all. */
const META_LAYER_FIXED_PITCH = 0x40;

/**
 * The note word a layer sounds for a trigger at `noteVal`, before clamping — a
 * fixed-pitch layer's own absolute pitch, or the trigger displaced by the
 * layer's detune. The one place the flag changes an arithmetic, so every reader
 * (trigger, audition probe, editor preview) goes through it.
 */
function layerNote(layer, noteVal) {
  return layer.fixedPitch ? (layer.detune & 0xffff) : noteVal + layer.detune;
}

/** Layers a 256-byte metainstrument record can hold: byte 0 flags + byte 1
 *  count + bytes 2..3 sentinel, then 10 bytes per layer. */
const META_MAX_LAYERS = 25;

// ── Metainstrument types (record byte 0, high nibble) ─────────────────────
/** Type 0 — LAYERED: every layer whose rectangle covers the trigger sounds on
 *  its own voice, mixed in parallel (§7.4). */
const META_TYPE_LAYERED = 0;
/**
 * Type 4 — FM (item 159): the layer table becomes an OPERATOR RACK and the
 * bytes after it carry an RPN program saying how the operators feed each other.
 * The rack is one voice, not `n` of them: operator 0 sounds on the channel and
 * the rest are read by the program.
 */
const META_TYPE_FM = 4;

/**
 * Operators an FM rack can hold. The whole rack — 10 bytes an operator plus the
 * program — has to fit the 252 bytes a record has left after the header, so this
 * is a floor on the room the program gets: 16 operators leave 92 bytes = 46
 * words, which is more than any 16-operator algorithm needs (n pushes + n−1
 * combining operators + END = 32 words at the very worst).
 */
const FM_MAX_OPERATORS = 16;

/** Bytes of a 256-byte record the operator rack and its program share. */
const FM_BUDGET_BYTES = 252;

// ── RPN word classes (§7.6) ──────────────────────────────────────────────
// A word is read as (class, operand): the top nibble pair picks the class and
// the low 10 bits the operator it addresses. $FFxx is the operator space, which
// no operand word can collide with because an operand's index is 10-bit.
const FM_WORD_OSC = 0x0000;  // $0000-$03FF — push operator n, free-running
const FM_WORD_MOD = 0x0400;  // $0400-$07FF — push operator n, phase-modulated by TOS
const FM_WORD_FB  = 0x0800;  // $0800-$0BFF — push operator n's PREVIOUS output (z-1)
const FM_WORD_OP  = 0xff00;  // $FF00-$FFFE — a stack operator
const FM_INDEX_MASK = 0x03ff;

/** Stack operators. Opcode = the word's low byte. */
const FmOp = {
  ADD: 0xff00,   // pop b, a -> push a + b            (parallel carriers)
  MUL: 0xff01,   // pop b, a -> push a * b            (ring modulation)
  NEG: 0xff02,   // pop a    -> push -a               (inverted modulator)
  DUP: 0xff03,   // pop a    -> push a, a
  SWAP: 0xff04,  // pop b, a -> push b, a
  END: 0xffff,   // stop; the stack top is the patch's output
};

/** Deepest the evaluation stack may go. A program that pushes past it is
 *  invalid (buildFmProgram refuses it; the engine treats the overflow as END). */
const FM_STACK_MAX = 16;

/**
 * The default algorithm for an `n`-operator rack: a straight modulation CHAIN,
 * operator n−1 into n−2 into … into 0, with 0 as the carrier. One push and
 * n−1 modulated pushes — the shape every FM patch starts life as.
 */
function defaultFmProgram(n) {
  const count = Math.max(1, Math.min(n | 0, FM_MAX_OPERATORS));
  const out = [count - 1];
  for (let k = count - 2; k >= 0; k--) out.push(FM_WORD_MOD | k);
  return Uint16Array.from(out);
}

/**
 * How many stack cells a word pops and pushes — the whole of what validation
 * needs to know about it, and the reason an unknown word can be rejected rather
 * than guessed at. Returns null for a word that is not a legal operand or
 * operator against a rack of `opCount` operators.
 */
function fmWordArity(word, opCount) {
  const w = word & 0xffff;
  if (w >= FM_WORD_OP) {
    switch (w) {
      case FmOp.ADD: case FmOp.MUL: return { pop: 2, push: 1 };
      case FmOp.NEG: return { pop: 1, push: 1 };
      case FmOp.DUP: return { pop: 1, push: 2 };
      case FmOp.SWAP: return { pop: 2, push: 2 };
      default: return null; // END is handled by the caller; the rest is reserved
    }
  }
  const idx = w & FM_INDEX_MASK;
  if (idx >= opCount) return null;
  switch (w & ~FM_INDEX_MASK) {
    case FM_WORD_OSC: case FM_WORD_FB: return { pop: 0, push: 1 };
    case FM_WORD_MOD: return { pop: 1, push: 1 };
    default: return null;
  }
}

/**
 * Read the RPN program packed at byte `off` of a type-4 record and hand back
 * its words WITHOUT the END terminator, or null when it does not parse.
 *
 * Rejecting outright is deliberate. An FM rack whose algorithm is half-read is
 * not a patch that sounds a bit wrong — it is a stack machine running on
 * whatever the record's tail happened to hold, so the engine treats a program
 * it cannot verify as no program at all and the instrument stays silent.
 */
function decodeFmProgram(b, off, opCount) {
  const words = [];
  let depth = 0;
  let ended = false;
  for (let o = off; o + 2 <= 256; o += 2) {
    const w = (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8);
    if (w === FmOp.END) { ended = true; break; }
    const arity = fmWordArity(w, opCount);
    if (arity === null) return null;
    if (depth < arity.pop) return null;                    // stack underflow
    depth += arity.push - arity.pop;
    if (depth > FM_STACK_MAX) return null;                 // stack overflow
    words.push(w);
  }
  // A program that fills the record to the last byte ends there; one that stops
  // early must say so, or the words after it are being ignored by accident.
  if (!ended && off + words.length * 2 + 2 <= 256) return null;
  return depth >= 1 ? Uint16Array.from(words) : null;
}

/** Bytes an `n`-operator rack with a `words`-word program occupies of the 252 —
 *  the END terminator counted, because the record has to carry it too. */
function fmRecordBytes(n, words) {
  return n * 10 + (words + 1) * 2;
}

/**
 * Pack a 256-byte metainstrument record — the byte-inverse of loadRecord's meta
 * branch. `layers` are makeMetaLayer shapes; layer 0 is the FOREGROUND layer and
 * the rest spawn as background children (trigger.js triggerMetaOrNote). Layers
 * beyond the type's capacity are dropped.
 *
 * A layer child must NOT itself be a metainstrument: triggerMetaOrNote resolves
 * layers through triggerNote, which never re-enters the meta branch, so a nested
 * meta's record would be read as sample fields.
 *
 * `type` picks the metainstrument kind (§7.4). META_TYPE_FM makes `layers` an
 * OPERATOR RACK and appends `program` — the RPN algorithm — after it, terminated
 * by END. Program words past the 252-byte budget are dropped, which is why the
 * editor keeps a memory meter: the rack and the algorithm share one record.
 */
function buildMetaRecord(layers, {
  strict = false, percussion = false, type = META_TYPE_LAYERED, program = null,
} = {}) {
  const fm = type === META_TYPE_FM;
  const use = layers.slice(0, fm ? FM_MAX_OPERATORS : META_MAX_LAYERS);
  const b = new Uint8Array(256);
  // samplePtr high 16 bits = 0xFFFF is the Metainstrument sentinel; the low
  // bytes carry the flags (byte 0) and the layer count (byte 1) instead.
  b[0] = ((type & 0x0f) << 4) | (strict ? 0x01 : 0) | (percussion ? 0x02 : 0);
  b[1] = use.length & 0xff;
  b[2] = 0xff;
  b[3] = 0xff;
  let o = 4;
  for (const l of use) {
    const idx = l.instIdx & 0x3ff;
    const det = l.detune & 0xffff; // two's complement round-trips
    b[o] = idx & 0xff;
    b[o + 1] = l.mixOctet & 0xff;
    b[o + 2] = det & 0xff;
    b[o + 3] = (det >>> 8) & 0xff;
    b[o + 4] = l.pitchStart & 0xff;
    b[o + 5] = (l.pitchStart >>> 8) & 0xff;
    b[o + 6] = l.pitchEnd & 0xff;
    b[o + 7] = (l.pitchEnd >>> 8) & 0xff;
    // Layer inst index bits 8..9 ride in the vol-start byte's top two bits.
    b[o + 8] = (l.volStart & 0x3f) | (((idx >>> 8) & 0x3) << 6);
    // …and the fixed-pitch flag in the vol-end byte's bit 6, which is where a
    // type-0 layer says its pitch is its own (item 179). A rack's entries never
    // carry it: the bit is RESERVED in every kind but Layered, and `fixedPitch`
    // is false on every operator the editor builds.
    b[o + 9] = (l.volEnd & 0x3f) | (!fm && l.fixedPitch ? META_LAYER_FIXED_PITCH : 0);
    o += 10;
  }
  if (fm) {
    const prog = program === null ? defaultFmProgram(use.length) : program;
    // The END word is the packer's, not the caller's: a program is a word LIST
    // everywhere above this line, and the terminator only exists because the
    // record's tail has to say where the algorithm stops.
    for (const w of prog) {
      if ((w & 0xffff) === FmOp.END || o + 4 > 256) break;
      b[o] = w & 0xff;
      b[o + 1] = (w >>> 8) & 0xff;
      o += 2;
    }
    if (o + 2 <= 256) { b[o] = 0xff; b[o + 1] = 0xff; }
  }
  return b;
}

/**
 * 256-byte instrument record (terranmon.txt:2001+). See AudioAdapter.kt:5322-5376
 * for the full byte layout. Envelopes have LOOP (always-active wrap) and SUSTAIN
 * (key-on-only wrap) words; playback priority matches schismtracker sndmix.c.
 */
class TaudInst {
  constructor(index) {
    this.index = index;

    this.samplePtr = 0;
    this.sampleLength = 0;
    this.samplingRate = 0;
    this.samplePlayStart = 0;
    this.sampleLoopStart = 0;
    this.sampleLoopEnd = 0;
    this.loopMode = 0;            // byte 14: bits 0-1 mode, bit 2 sustain, bit 4 percussion,
                                  //          bit 5 spatial azimuth MSB (#998)
    this.volEnvLoop = 0;          // bytes 15-16 (LOOP word)
    this.panEnvLoop = 0;          // bytes 17-18
    this.pfEnvLoop = 0;           // bytes 19-20
    this.instGlobalVolume = 0xff;
    this.volEnvelopes = makeEnv(0x3f);
    this.panEnvelopes = makeEnv(0x80);
    this.pfEnvelopes = makeEnv(0x80);
    this.volumeFadeoutLow = 0;
    this.fadeoutHigh = 0;
    this.volumeSwing = 0;
    this.vibratoSpeed = 0;
    this.vibratoSweep = 0;
    this.defaultPan = 0x80;
    this.pitchPanCentre = 0x5000;
    this.pitchPanSeparation = 0;
    this.panSwing = 0;
    this.defaultCutoff = 0xff;
    this.defaultResonance = 0;    // matches Kotlin secondary-ctor default order
    this.sampleDetune = 0;
    this.instrumentFlag = 0;
    this.vibratoDepth = 0;
    this.vibratoRate = 0;
    this.volEnvSustainWord = 0;
    this.panEnvSustainWord = 0;
    this.pfEnvSustainWord = 0;
    this.dupCheckFlag = 0;
    this.defaultNoteVolume = 0;   // byte 196; 0 = legacy fall back to 0x3F
    this.pf2EnvLoop = 0;          // bytes 197-198
    this.pf2EnvSustainWord = 0;   // bytes 199-200
    this.pf2Envelopes = makeEnv(0x80); // bytes 201-250

    // Reserved padding at offsets 251..255; note the Kotlin indexing quirk:
    // getByte(252..255) reads reserved[offset-251] (reserved[0] unused), and
    // defaultCutoff16/defaultResonance16 read reserved[1]/reserved[2].
    this.reserved = new Uint8Array(5);
    this.initialAttenOctet = 0;   // byte 251; 0 = unity sentinel

    // Runtime notefx 5/6 overrides (-1 = none).
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;

    // Ixmp patches (null when none uploaded).
    this.extraPatches = null;

    // Metainstrument state.
    this.metaLayers = null;
    this.metaRaw = null;          // verbatim 256-byte record for lossless capture
    this.metaStrict = false;
    this.metaType = META_TYPE_LAYERED; // record byte 0's high nibble (§7.4)
    // FM rack (type 4, item 159): the RPN algorithm packed after the operator
    // table, END-terminated and already validated by decodeFmProgram — null for
    // every other type AND for an FM record whose program does not parse, which
    // is what makes the instrument silent rather than unpredictable.
    this.fmProgram = null;

    // Invert loop (S $F0xx) XOR bit-mask over the loop region.
    this.invertMask = null;

    // Sample modification (items 130, 152, 153, notefx 2 / 3) — ONE per
    // instrument: the opcodes are the same command, `2` inverting which side of
    // the region is touched. The extent is a FRACTION of the sounding voice's
    // loop region (item 153), so it means the same thing whatever is loaded and
    // wherever an Ixmp patch moves the loop; combBits -1 = solid. Only the
    // ACTIVE operation's accumulator is ever non-zero.
    this.modOp = 0;               // MOD_OFF
    this.modInvert = false;       // notefx 2: the region is what is NOT touched
    this.modFrom = 0;             // extent, as a fraction of the domain
    this.modTo = 1;
    this.modCombBits = -1;        // comb: the extent cut into 2^(n+1) chunks
    this.modCombOdd = false;      // ...keeping the odd ones ($Ex) or the even ($Fx)
    this.modMask = null;          // MOD_INVERT: one bit per sample byte
    this.modRot = 0;              // MOD_ROL*/MOD_JUMP*: byte displacement
    this.modSub = 0;              // MOD_SUB*: running subtrahend, 0..255
    this.modScatter = 0;          // MOD_RND*: per-byte throw, in bytes (0 = off)
    this.modSeed = 0;             // MOD_RND*: this step's scramble
    this.modOn = false;           // hot-path guard: does it change any byte yet?
    this.modEpoch = 0;            // bumped whenever the GEOMETRY moves, so a
                                  // voice's resolved view knows to rebuild
    // The state the last step replaced, for the anti-click crossfade (item
    // 153.5): for MOD_XFADE_SAMPLES output samples a voice reads both mappings.
    this.modPrevRot = 0;
    this.modPrevSub = 0;
    this.modPrevScatter = 0;
    this.modPrevSeed = 0;

    // Argument extension (item 162): notefx 2/3 paired with `:`. Mutually
    // exclusive with modOp above — writing either clears the other (see
    // setModOp/setModOpExt) — so every field below is only ever live while
    // modOpExt is non-zero. $se's own extent/comb (modFrom/modTo/modCombBits)
    // is shared with the classic path; everything here is the extended-only
    // remainder: $f's sub-range, the step counter it alternates on, and the
    // wider operation table's own accumulators. modRot/modSub/modScatter/
    // modSeed above are reused as-is for the extended rotate/jump/scatter/
    // sub/add kinds (see samplemod.js decodeExtOp) rather than duplicated.
    this.modOpExt = 0;            // 0x000..0xFFF, 0 = off ($xuu)
    this.modF = 0;                 // $f sub-range modifier
    this.modStepIndex = 0;        // counts steps, for $f's A-D alternation
    this.modXor = 0;               // xor / "simply invert" (103) / NOT (920) accumulator
    this.modPrevXor = 0;
    this.modBitRot = 0;            // 90x/91x: net bit-rotation, mod 8 (no crossfade)
    this.modBitPermIdx = 0;        // 921-927: which permutation (920 folds into modXor)
    this.modBitPermOn = false;     // toggled each step (an involution applied twice is identity)
    this.modExtSwapA = -1;         // 160: swapped byte-pair addresses (no crossfade)
    this.modExtSwapB = -1;
    this.modExtMirror = false;     // 104: reverse, toggled each step (no crossfade)
    // 102/12x: this instrument's own funk-repeat walk — an ABSOLUTE SAMPLE
    // BYTE POSITION (like Z $Ffxx's voice.funkWalk/funkPos, -1 = never
    // walked), NOT bounded to the resolved region: the formal Funk Repeat
    // spec moves the loop itself through the whole physical sample, replen
    // (the region's own length) at a time. modFunkWalk is the deterministic
    // grid position; modFunkPos is this step's pointer WITH $12x's jitter
    // added — latched into a sounding voice's own modFunkWindow only when
    // that voice's loop actually wraps (sampler.js advanceSamplePos), same
    // as Z's funkPos -> funkWindow latch.
    this.modFunkWalk = -1;
    this.modFunkPos = -1;
    this.modFunkLen = 0;          // this step's window width (= dl, the resolved
                                   // region's own length) — stashed here because
                                   // sampler.js's advanceSamplePos runs on the
                                   // per-sample clock and must not re-resolve
                                   // modGeom itself to find it
  }

  get sampleLoopSustain() { return (this.loopMode & 0x04) !== 0; }
  get isPercussion() {
    return this.metaRaw !== null
      ? (this.metaRaw[0] & 0x02) !== 0
      : (this.loopMode & 0x10) !== 0;
  }
  /**
   * The instrument's default position as a 9-bit azimuth (#998): record byte
   * 177 is its LOW byte and byte 14's bit 5 (`A`) the ninth — exactly the
   * relationship `S $8xxx` has with the legacy pan byte, which is what makes
   * this backwards compatible. An old file has bit 5 clear, so its pan lands on
   * the front arc it always meant, and a stereo song reads byte 177 alone.
   */
  get defaultAzimuth() {
    return ((this.loopMode & 0x20) !== 0 ? 256 : 0) | (this.defaultPan & 0xff);
  }
  /** Default elevation (#998), record byte 254, signed. Spatial songs only. */
  get defaultElevation() {
    const b = this.reserved[3] & 0xff; // byte 254 → reserved[254 − 251]
    return b >= 0x80 ? b - 256 : b;
  }
  get nnaKeyLift() { return ((this.instrumentFlag >>> 5) & 1) !== 0; }
  /** 0=note off, 1=note cut, 2=continue, 3=note fade. */
  get newNoteAction() { return this.instrumentFlag & 0x03; }
  /** 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2). */
  get vibratoWaveform() { return (this.instrumentFlag >>> 2) & 0x07; }
  get sampleDetuneSigned() {
    const v = this.sampleDetune & 0xffff;
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  get duplicateCheckType() { return this.dupCheckFlag & 0x03; }
  get duplicateCheckAction() { return (this.dupCheckFlag >>> 2) & 0x03; }
  /** byte 173 bit 4: false = ImpulseTracker filter units, true = SoundFont. */
  get filterSfMode() { return ((this.fadeoutHigh >>> 4) & 1) !== 0; }
  get isMeta() { return this.metaLayers !== null; }
  /** True for a type-4 rack: the layer table is an OPERATOR rack read by
   *  `fmProgram`, not a set of parallel layers (§7.6). */
  get isFm() { return this.metaLayers !== null && this.metaType === META_TYPE_FM; }

  get defaultCutoff16() {
    if (this.cutoffOverride >= 0) return this.cutoffOverride;
    return this.filterSfMode
      ? ((this.defaultCutoff & 0xff) << 8) | (this.reserved[1] & 0xff)
      : this.defaultCutoff;
  }
  get defaultResonance16() {
    if (this.resonanceOverride >= 0) return this.resonanceOverride;
    return this.filterSfMode
      ? ((this.defaultResonance & 0xff) << 8) | (this.reserved[2] & 0xff)
      : this.defaultResonance;
  }

  /** First Ixmp patch whose pitch+volume rectangle contains the trigger, else null. */
  resolvePatch(noteVal, rowVolume) {
    const patches = this.extraPatches;
    if (patches === null) return null;
    for (const p of patches) {
      if (noteVal >= p.pitchStart && noteVal <= p.pitchEnd &&
          rowVolume >= p.volumeStart && rowVolume <= p.volumeEnd) return p;
    }
    return null;
  }

  /** All meta layers whose rectangle contains the trigger, in record order. */
  resolveMetaLayers(noteVal, rowVolume) {
    const layers = this.metaLayers;
    if (layers === null) return [];
    return layers.filter(
      (l) => noteVal >= l.pitchStart && noteVal <= l.pitchEnd &&
             rowVolume >= l.volStart && rowVolume <= l.volEnd
    );
  }

  /** Load a full 256-byte record; detects the Metainstrument sentinel
   *  (samplePtr high 16 bits == 0xFFFF) and parses its layer table — which for
   *  a type-4 record is an operator rack followed by an RPN program (§7.6). */
  loadRecord(b) {
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;
    const sp = ((b[0] & 0xff) | ((b[1] & 0xff) << 8) | ((b[2] & 0xff) << 16)) + (b[3] & 0xff) * 0x1000000;
    if (((sp >>> 16) & 0xffff) === 0xffff) {
      const type = (b[0] >>> 4) & 0x0f;
      const fm = type === META_TYPE_FM;
      const rawCount = (sp >>> 8) & 0xff; // byte 1 = layer / operator count
      const count = fm ? Math.min(rawCount, FM_MAX_OPERATORS) : rawCount;
      const layers = [];
      let o = 4;
      for (let n = 0; n < count; n++) {
        if (o + 10 > b.length) break;
        // 10-bit layer inst index: low 8 in byte 0, bits 8..9 in bits 6..7 of vol-start (+8).
        const instIdx = (b[o] & 0xff) | (((b[o + 8] >>> 6) & 0x3) << 8);
        const mixOctet = b[o + 1] & 0xff;
        const detRaw = (b[o + 2] & 0xff) | ((b[o + 3] & 0xff) << 8);
        // A fixed-pitch layer's detune field is an unsigned NOTE WORD, not a
        // signed offset (item 179), so the sign conversion has to know which it
        // is looking at. The flag is the Layered kind's alone: in a rack those
        // bits are reserved and the field stays a frequency ratio.
        const fixedPitch = !fm && (b[o + 9] & META_LAYER_FIXED_PITCH) !== 0;
        const detune = fixedPitch ? detRaw : (detRaw >= 0x8000 ? detRaw - 0x10000 : detRaw);
        const pStart = (b[o + 4] & 0xff) | ((b[o + 5] & 0xff) << 8);
        const pEnd = (b[o + 6] & 0xff) | ((b[o + 7] & 0xff) << 8);
        const vStart = b[o + 8] & 0x3f;
        const vEnd = b[o + 9] & 0x3f;
        const usable = instIdx >= 1 && instIdx <= 1023 && instIdx !== this.index;
        // A layered record DROPS an unusable layer; an FM rack MUTES it in
        // place, because the program addresses operators by POSITION and
        // compacting the rack would rewire the algorithm under it.
        if (usable || fm) {
          const layer = makeMetaLayer(usable ? instIdx : 0, mixOctet, detune,
            pStart, pEnd, vStart, vEnd, fixedPitch);
          layer.rawOffset = o; // metaRaw byte offset of this layer (editors target it)
          layers.push(layer);
        }
        o += 10;
      }
      this.metaLayers = layers.length === 0 ? null : layers;
      this.metaRaw = this.metaLayers !== null ? Uint8Array.from(b.slice(0, 256)) : null;
      this.metaStrict = this.metaLayers !== null && (b[0] & 0x01) !== 0;
      this.metaType = this.metaLayers !== null ? type : META_TYPE_LAYERED;
      this.fmProgram = this.metaLayers !== null && fm
        ? decodeFmProgram(b, o, layers.length) : null;
      this.extraPatches = null;
    } else {
      this.metaLayers = null;
      this.metaRaw = null;
      this.metaStrict = false;
      this.metaType = META_TYPE_LAYERED;
      this.fmProgram = null;
      const n = Math.min(256, b.length);
      for (let i = 0; i < n; i++) this.setByte(i, b[i] & 0xff);
    }
  }

  // Invert-loop mask — sized for the loop length; stale masks are discarded.
  // `loopLen` is the SOUNDING voice's active loop length — an Ixmp patch brings
  // its own loop points, so sizing the mask off the base record would index a
  // patched voice's inversion into the wrong bytes (item 116). Defaults to the
  // base record's loop for a voice with no patch.
  toggleInvertBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    const len = Math.max(loopLen, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.invertMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.invertMask = mask;
    }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
  }

  invertBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    const mask = this.invertMask;
    if (mask === null) return false;
    const len = Math.max(loopLen, 1);
    if (mask.length !== (len + 7) >> 3) { this.invertMask = null; return false; }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    return ((mask[idx >> 3] >>> (idx & 7)) & 1) !== 0;
  }

  /**
   * Point the modification at a new extent (item 130), as a fraction of the
   * sounding voice's domain. Its accumulated state is indexed against that
   * region, so a move invalidates it, and a fresh extent is always solid — the
   * comb is the other half of the same argument and is written after it.
   * Returns whether anything MOVED, which is what tells the caller to restart
   * the walk: writing the same region every row must not keep resetting it.
   */
  setModRegion(from, to) {
    if (this.modFrom === from && this.modTo === to && this.modCombBits === -1) return false;
    this.modFrom = from;
    this.modTo = to;
    this.modCombBits = -1;
    this.modCombOdd = false;
    this.modEpoch++;
    this.clearModState();
    return true;
  }

  /** Comb the extent without moving its ends ($Fn even bristles, $En odd). */
  setModComb(bits, odd) {
    if (this.modCombBits === bits && this.modCombOdd === odd) return false;
    this.modCombBits = bits;
    this.modCombOdd = odd;
    this.modEpoch++;
    this.clearModState();
    return true;
  }

  /** Select the operation and which side of the region it works on. Changing
   *  either starts the new operation from scratch — a rotation offset means
   *  nothing to a subtract. Classic and extended ($xuu, item 162) are mutually
   *  exclusive, so writing the classic op also turns any extended one off. */
  setModOp(op, invert) {
    if (this.modOp === op && this.modInvert === invert && this.modOpExt === 0) return false;
    this.modOp = op;
    this.modInvert = invert;
    this.modOpExt = 0;
    this.modF = 0;
    this.modEpoch++;   // the inversion decides the wrap domain, so it is geometry
    this.clearModState();
    return true;
  }

  /** Extended counterpart of setModOp (item 162): a 12-bit $xuu code plus the
   *  $f sub-range modifier, mutually exclusive with the classic modOp. */
  setModOpExt(code, invert, f) {
    if (this.modOpExt === code && this.modInvert === invert && this.modF === f && this.modOp === 0) return false;
    this.modOp = 0;
    this.modOpExt = code;
    this.modInvert = invert;
    this.modF = f;
    this.modEpoch++;
    this.clearModState();
    return true;
  }

  /** Drop what the operation has accumulated, keeping its region. */
  clearModState() {
    this.modMask = null;
    this.modRot = 0;
    this.modSub = 0;
    this.modScatter = 0;
    this.modSeed = 0;
    this.modOn = false;
    this.modPrevRot = 0;
    this.modPrevSub = 0;
    this.modPrevScatter = 0;
    this.modPrevSeed = 0;
    this.modStepIndex = 0;
    this.modXor = 0;
    this.modPrevXor = 0;
    this.modBitRot = 0;
    this.modBitPermIdx = 0;
    this.modBitPermOn = false;
    this.modExtSwapA = -1;
    this.modExtSwapB = -1;
    this.modExtMirror = false;
    this.modFunkWalk = -1;
    this.modFunkPos = -1;
    this.modFunkLen = 0;
  }

  /** Remember what the next step is replacing, for the crossfade that covers
   *  it (item 153.5). Called immediately BEFORE the step lands. */
  snapshotModState() {
    this.modPrevRot = this.modRot;
    this.modPrevSub = this.modSub;
    this.modPrevScatter = this.modScatter;
    this.modPrevSeed = this.modSeed;
    this.modPrevXor = this.modXor;
  }

  /** $x = 0 — the modification, region and all. */
  resetMod() {
    this.modOp = 0;
    this.modOpExt = 0;
    this.modF = 0;
    this.modInvert = false;
    this.modFrom = 0;
    this.modTo = 1;
    this.modCombBits = -1;
    this.modCombOdd = false;
    this.modEpoch++;
    this.clearModState();
  }

  /** Flip the modification's inversion bit for sample byte `i` (MOD_INVERT). The
   *  mask spans the whole SAMPLE — an inverted region's touched set is not a
   *  contiguous span, so there is no smaller origin to index from. */
  toggleModBit(i, sampleLen) {
    const len = Math.max(sampleLen, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.modMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.modMask = mask;
    }
    const idx = Math.min(Math.max(i, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
    this.modOn = true;
  }

  modBit(i) {
    const mask = this.modMask;
    if (mask === null) return false;
    const byte = i >> 3;
    if (byte < 0 || byte >= mask.length) return false;
    return ((mask[byte] >>> (i & 7)) & 1) !== 0;
  }

  _envPointGet(env, base, offset) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    return (rel & 1) === 0 ? pt.value & 0xff : pt.offset & 0xff;
  }

  _envPointSet(env, base, offset, byte) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    if ((rel & 1) === 0) pt.value = byte;
    else pt.offset = byte & 0xff;
  }

  /** Read one record byte (0..255). Metainstruments serve verbatim metaRaw. */
  getByte(offset) {
    if (this.metaRaw !== null) return this.metaRaw[offset] & 0xff;
    return this.getByteNormal(offset);
  }

  getByteNormal(o) {
    if (o >= 21 && o <= 70) return this._envPointGet(this.volEnvelopes, 21, o);
    if (o >= 71 && o <= 120) return this._envPointGet(this.panEnvelopes, 71, o);
    if (o >= 121 && o <= 170) return this._envPointGet(this.pfEnvelopes, 121, o);
    if (o >= 201 && o <= 250) return this._envPointGet(this.pf2Envelopes, 201, o);
    if (o >= 252 && o <= 255) return this.reserved[o - 251];
    switch (o) {
      case 0: return this.samplePtr & 0xff;
      case 1: return (this.samplePtr >>> 8) & 0xff;
      case 2: return (this.samplePtr >>> 16) & 0xff;
      case 3: return (this.samplePtr >>> 24) & 0xff;
      case 4: return this.sampleLength & 0xff;
      case 5: return (this.sampleLength >>> 8) & 0xff;
      case 6: return this.samplingRate & 0xff;
      case 7: return (this.samplingRate >>> 8) & 0xff;
      case 8: return this.samplePlayStart & 0xff;
      case 9: return (this.samplePlayStart >>> 8) & 0xff;
      case 10: return this.sampleLoopStart & 0xff;
      case 11: return (this.sampleLoopStart >>> 8) & 0xff;
      case 12: return this.sampleLoopEnd & 0xff;
      case 13: return (this.sampleLoopEnd >>> 8) & 0xff;
      case 14: return this.loopMode & 0x37;
      case 15: return this.volEnvLoop & 0xff;
      case 16: return (this.volEnvLoop >>> 8) & 0xff;
      case 17: return this.panEnvLoop & 0xff;
      case 18: return (this.panEnvLoop >>> 8) & 0xff;
      case 19: return this.pfEnvLoop & 0xff;
      case 20: return (this.pfEnvLoop >>> 8) & 0xff;
      case 171: return this.instGlobalVolume & 0xff;
      case 172: return this.volumeFadeoutLow & 0xff;
      case 173: return this.fadeoutHigh & 0xff;
      case 174: return this.volumeSwing & 0xff;
      case 175: return this.vibratoSpeed & 0xff;
      case 176: return this.vibratoSweep & 0xff;
      case 177: return this.defaultPan & 0xff;
      case 178: return this.pitchPanCentre & 0xff;
      case 179: return (this.pitchPanCentre >>> 8) & 0xff;
      case 180: return this.pitchPanSeparation & 0xff;
      case 181: return this.panSwing & 0xff;
      case 182: return this.defaultCutoff & 0xff;
      case 183: return this.defaultResonance & 0xff;
      case 184: return this.sampleDetune & 0xff;
      case 185: return (this.sampleDetune >>> 8) & 0xff;
      case 186: return this.instrumentFlag & 0xff;
      case 187: return this.vibratoDepth & 0xff;
      case 188: return this.vibratoRate & 0xff;
      case 189: return this.volEnvSustainWord & 0xff;
      case 190: return (this.volEnvSustainWord >>> 8) & 0xff;
      case 191: return this.panEnvSustainWord & 0xff;
      case 192: return (this.panEnvSustainWord >>> 8) & 0xff;
      case 193: return this.pfEnvSustainWord & 0xff;
      case 194: return (this.pfEnvSustainWord >>> 8) & 0xff;
      case 195: return this.dupCheckFlag & 0xff;
      case 196: return this.defaultNoteVolume & 0xff;
      case 197: return this.pf2EnvLoop & 0xff;
      case 198: return (this.pf2EnvLoop >>> 8) & 0xff;
      case 199: return this.pf2EnvSustainWord & 0xff;
      case 200: return (this.pf2EnvSustainWord >>> 8) & 0xff;
      case 251: return this.initialAttenOctet & 0xff;
      default: throw new Error(`Bad offset ${o}`);
    }
  }

  setByte(o, byte) {
    if (o >= 21 && o <= 70) return this._envPointSet(this.volEnvelopes, 21, o, byte);
    if (o >= 71 && o <= 120) return this._envPointSet(this.panEnvelopes, 71, o, byte);
    if (o >= 121 && o <= 170) return this._envPointSet(this.pfEnvelopes, 121, o, byte);
    if (o >= 201 && o <= 250) return this._envPointSet(this.pf2Envelopes, 201, o, byte);
    if (o >= 252 && o <= 255) { this.reserved[o - 251] = byte & 0xff; return; }
    switch (o) {
      case 0: this.samplePtr = (this.samplePtr & 0xffffff00) | byte; break;
      case 1: this.samplePtr = (this.samplePtr & 0xffff00ff) | (byte << 8); break;
      case 2: this.samplePtr = (this.samplePtr & 0xff00ffff) | (byte << 16); break;
      case 3: this.samplePtr = ((this.samplePtr & 0x00ffffff) | (byte << 24)) >>> 0; break;
      case 4: this.sampleLength = (this.sampleLength & 0xff00) | byte; break;
      case 5: this.sampleLength = (this.sampleLength & 0x00ff) | (byte << 8); break;
      case 6: this.samplingRate = (this.samplingRate & 0xff00) | byte; break;
      case 7: this.samplingRate = (this.samplingRate & 0x00ff) | (byte << 8); break;
      case 8: this.samplePlayStart = (this.samplePlayStart & 0xff00) | byte; break;
      case 9: this.samplePlayStart = (this.samplePlayStart & 0x00ff) | (byte << 8); break;
      case 10: this.sampleLoopStart = (this.sampleLoopStart & 0xff00) | byte; break;
      case 11: this.sampleLoopStart = (this.sampleLoopStart & 0x00ff) | (byte << 8); break;
      case 12: this.sampleLoopEnd = (this.sampleLoopEnd & 0xff00) | byte; break;
      case 13: this.sampleLoopEnd = (this.sampleLoopEnd & 0x00ff) | (byte << 8); break;
      case 14: this.loopMode = byte & 0x37; break;
      case 15: this.volEnvLoop = (this.volEnvLoop & 0xff00) | byte; break;
      case 16: this.volEnvLoop = (this.volEnvLoop & 0x00ff) | (byte << 8); break;
      case 17: this.panEnvLoop = (this.panEnvLoop & 0xff00) | byte; break;
      case 18: this.panEnvLoop = (this.panEnvLoop & 0x00ff) | (byte << 8); break;
      case 19: this.pfEnvLoop = (this.pfEnvLoop & 0xff00) | byte; break;
      case 20: this.pfEnvLoop = (this.pfEnvLoop & 0x00ff) | (byte << 8); break;
      case 171: this.instGlobalVolume = byte & 0xff; break;
      case 172: this.volumeFadeoutLow = byte & 0xff; break;
      case 173: this.fadeoutHigh = byte & 0x1f; break; // bits 0-3 fadeout high, bit 4 SF filter mode
      case 174: this.volumeSwing = byte & 0xff; break;
      case 175: this.vibratoSpeed = byte & 0xff; break;
      case 176: this.vibratoSweep = byte & 0xff; break;
      case 177: this.defaultPan = byte & 0xff; break;
      case 178: this.pitchPanCentre = (this.pitchPanCentre & 0xff00) | byte; break;
      case 179: this.pitchPanCentre = (this.pitchPanCentre & 0x00ff) | (byte << 8); break;
      case 180: this.pitchPanSeparation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 181: this.panSwing = byte & 0xff; break;
      case 182: this.defaultCutoff = byte & 0xff; break;
      case 183: this.defaultResonance = byte & 0xff; break;
      case 184: this.sampleDetune = (this.sampleDetune & 0xff00) | byte; break;
      case 185: this.sampleDetune = (this.sampleDetune & 0x00ff) | (byte << 8); break;
      case 186: this.instrumentFlag = byte & 0xff; break;
      case 187: this.vibratoDepth = byte & 0xff; break;
      case 188: this.vibratoRate = byte & 0xff; break;
      case 189: this.volEnvSustainWord = (this.volEnvSustainWord & 0xff00) | byte; break;
      case 190: this.volEnvSustainWord = (this.volEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 191: this.panEnvSustainWord = (this.panEnvSustainWord & 0xff00) | byte; break;
      case 192: this.panEnvSustainWord = (this.panEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 193: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0xff00) | byte; break;
      case 194: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 195: this.dupCheckFlag = byte & 0x0f; break;
      case 196: this.defaultNoteVolume = byte & 0xff; break;
      case 197: this.pf2EnvLoop = (this.pf2EnvLoop & 0xff00) | byte; break;
      case 198: this.pf2EnvLoop = (this.pf2EnvLoop & 0x00ff) | (byte << 8); break;
      case 199: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0xff00) | byte; break;
      case 200: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0x00ff) | (byte << 8); break;
      case 251: this.initialAttenOctet = byte & 0xff; break;
      default: throw new Error(`Bad offset ${o}`);
    }
  }
}

// ══ src/engine/voice.js ══
// Voice + MemorySlots — port of AudioAdapter.kt:4497-4878. All fields are
// initialised in the constructor (monomorphic shape for the JIT); defaults
// match the Kotlin field initialisers exactly. Envelope point `offset` fields
// hold ThreeFiveMiniUfloat LUT indices.




/** Per-channel effect memory cohorts and private slots (TAUD_NOTE_EFFECTS.md §6). */
class MemorySlots {
  constructor() {
    this.ef = 0;        // shared E/F (pitch slide)
    this.g = 0;         // G (tone porta) private speed
    this.huSpeed = 0;   // shared H/U vibrato
    this.huDepth = 0;
    this.rSpeed = 0;    // R (tremolo)
    this.rDepth = 0;
    this.ySpeed = 0;    // Y (panbrello)
    this.yDepth = 0;
    this.d = 0;
    this.i = 0;
    this.j = 0;
    this.jExt1 = 0;      // item 162: J extended by `:` — private, different units to `j`
    this.jExt2 = 0;
    this.o = 0;
    this.oExt = 0;       // item 162: O extended by `:` — 32-bit offset, private, different units to `o`
    this.q = 0;
    this.tslide = 0;
    this.w = 0;
    this.k = 0;
    this.l = 0;
    this.n = 0;
    this.p = 0;
    this.z = 0;         // Z (spherical panning slide speed, #998.2)
  }
}

function makeActiveEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * Per-channel DSP history for a multi-channel (Ixmp 's') voice — item 90.
 * Channel 1 uses the Voice's OWN fields (so the mono path is untouched); this
 * mirrors the same field names for channel 2, which is why applyVoiceFilter /
 * applyTaudVoiceFx / fetchTrackerSample can take either object as their state
 * holder. Coefficients, envelopes and pitch stay shared — only the history
 * that must not be crossed between channels lives here.
 */
class ChannelState {
  constructor() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  /** Trigger-time reset — mirrors what triggerNote does to the Voice's own. */
  reset() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  copyFrom(src) {
    this.filterY1 = src.filterY1;
    this.filterY2 = src.filterY2;
    this.filterX1 = src.filterX1;
    this.filterX2 = src.filterX2;
    this.bitcrusherCounter = src.bitcrusherCounter;
    this.bitcrusherHeld = src.bitcrusherHeld;
    this.nesDpcmCounter = src.nesDpcmCounter;
  }
}

class Voice {
  constructor() {
    this.active = false;
    // Host-owned 256-step attenuator (0 = unity, 255 = silence/mute sentinel).
    this.fader = 0;
    this.samplePos = 0.0;
    this.playbackRate = 1.0;
    // Per-sample interpolation of the pitch (item 141). playbackRate is the
    // TARGET the tick just set; currentPlaybackRate is what the sampler steps
    // by, glided toward it across the tick so a slide or a vibrato is a
    // continuous bend rather than a staircase of 50 steps a second.
    this.currentPlaybackRate = 1.0;
    this.pitchRampSamples = 0;
    this.pitchRampStep = 0.0;
    this.snapPlaybackRate = true;
    this.forward = true;
    this.instrumentId = 0;
    // Display-only: the pattern-level instrument that triggered this voice (a
    // metainstrument's SLOT, not the layer-child it resolves to) — so the
    // Timeline voice header shows the number the user sees in the pattern. No
    // Kotlin counterpart (write-only, like renderPitch).
    this.displayInst = 0;

    // -1 for live foreground voices; 0..NUM_VOICES-1 = source channel for background ghosts.
    this.sourceChannel = -1;

    // ── Stem-export taps (item 93; JS-only, never read by the DSP) ──
    // Index into inst.extraPatches of the Ixmp patch this trigger resolved to,
    // -1 = the base record. Lets the exporter put each drum of a percussion
    // instrument on its own track.
    this.activePatchIndex = -1;
    // Memoised stem routing: stemKey is the (displayInst, instrumentId,
    // activePatchIndex) triple the exporter last resolved, stemIndex its answer.
    // Declared here so the Voice shape stays monomorphic.
    this.stemKey = -1;
    this.stemIndex = -1;

    // ── Metainstrument layering ──
    this.isLayerChild = false;
    this.layerRelDetune = 0;
    // A NON-MELODIC layer's own note (item 179), or -1 for the ordinary kind
    // that tracks the parent. The per-tick sync reads it instead of deriving a
    // pitch from the parent's, which is the whole of "always the same pitch
    // regardless of the keyed note" once the trigger has run.
    this.layerFixedNote = -1;
    // How far this layer sits from the meta's centre (layer 0), in note-axis
    // units — the pan twin of layerRelDetune, re-added by the per-tick sync so
    // the arrangement ROTATES with the note rather than collapsing (item 118).
    this.layerRelPan = 0;
    this.layerRelElevation = 0;
    this.layerMixGain = 1.0;
    // The parent channel's per-tick pitch overlay (vibrato / glissando /
    // arpeggio), copied down by the per-tick sync so an effect that bends the
    // note bends the WHOLE metainstrument and not just layer 0 (item 154).
    this.layerPitchMod = 0;
    this.nnaOverride = -1;
    // Per-voice envelope gates (S $77..$7E).
    this.volEnvOn = true;
    this.panEnvOn = true;
    this.pitchEnvOn = true;
    this.filterEnvOn = true;
    this.metaForeground = false;
    // How far THIS voice's own noteVal sits from the raw note it was
    // triggered at — layer 0's (or the FM rack's operator 0's) own detune,
    // the same quantity layerRelDetune measures for a CHILD relative to layer
    // 0. A subsequent tone-portamento row's target is a raw pattern note, so
    // it needs the same offset applied before it means anything against this
    // voice's own (detuned) noteVal coordinate (row.js, item 176).
    this.metaForegroundDetune = 0;
    this.noteFading = false;

    // ── FM operator rack (Metainstrument type 4, item 159) ──
    // On a channel's foreground voice: the live rack this note is sounding
    // (engine/fm.js FmRig), or null for every ordinary voice — which is what
    // the mixer branches on, so nothing that never plays a rack pays for it.
    this.fmRig = null;
    // On a background voice: this is an OPERATOR of some channel's rack, not a
    // sound of its own. The tick pass maintains it like a layer child; the
    // mixer skips it, because the rack's own render is what reads it.
    this.fmOperator = false;

    // Two-axis volume AND pan model (TAUD_NOTE_EFFECTS.md §3). Both axes work
    // the same way on either side: the instrument seeds the NOTE axis and the
    // pattern's channel commands own the CHANNEL axis, and the two combine at
    // the mixer — volume multiplies, pan adds.
    this.noteVolume = 0x3f;
    this.channelVolume = 0x3f;
    this.rowVolume = 63;
    this.channelPan = 0x80;
    this.rowPan = 32;
    // Note-pan axis: a signed OFFSET from the channel's position, in the same
    // 512-units-to-a-turn space as panAzimuth (so on the front arc it is just a
    // pan-byte delta). 0 = neutral, which is what keeps a song that never
    // touches it rendering exactly as it did under the single-register model.
    // Seeded by the Ixmp patch's `default pan` and written by the panning
    // column; nothing else may write it.
    this.notePan = 0;
    this.noteElevation = 0.0;      // the wide panning column's elevation half

    // ── Spatial position (#998) — used only when the song is planar/spatial.
    // channelPan stays the legacy integer (and the UI's mirror); panAzimuth is
    // the continuous 512-unit angle the mixer and the Z slide work in.
    this.panAzimuth = 128.0;       // 0 = left, 128 = front, 256 = right
    this.panElevation = 0.0;       // 128 units = 90°
    this.spatialTargetAz = 128.0;  // effect 4
    this.spatialTargetEl = 0.0;
    this.spatialSlideActive = false; // armed by Z for the current row
    // Mixer-side cache of the renderer gains: {az, el, chans, renderer, gains}.
    this.spatial = null;
    // The same, for the master strip's analysis bus (item 98) — a separate slot
    // so the two buses do not invalidate each other every sample.
    this.analysisSpatial = null;

    // Anti-click volume ramp.
    this.currentMixVolume = 1.0;
    this.volRampSamples = 0;
    this.volRampStep = 0.0;
    // …and of the pan (item 141), for the same reason: the pan law is evaluated
    // per sample but every input to it moves once a tick, so a slide, a
    // panbrello or a pan envelope stepped the gain 50 times a second.
    this.currentPan = 128.0;
    this.panRampSamples = 0;
    this.panRampStep = 0.0;
    this.snapPan = true;
    this.snapMixVolume = false;

    this.keyOff = false;
    this.envIndex = 0;
    this.envTimeSec = 0.0;
    this.envVolume = 1.0;
    // Per-sample smoothed copy of envVolume (see AudioAdapter.kt:4615-4624).
    this.envVolMix = 1.0;
    this.envVolStep = 0.0;
    this.envPanIndex = 0;
    this.envPanTimeSec = 0.0;
    this.envPan = 0.5;
    this.hasPanEnv = false;

    // Pitch and filter envelopes (0.5 = unity).
    this.hasPitchEnv = false;
    this.envPitchIndex = 0;
    this.envPitchTimeSec = 0.0;
    this.envPitchValue = 0.5;
    this.hasFilterEnv = false;
    this.envFilterIndex = 0;
    this.envFilterTimeSec = 0.0;
    this.envFilterValue = 0.5;

    this.fadeoutVolume = 1.0;

    // MilkyTracker-style anti-click ramp-out.
    this.rampOutSamples = 0;
    this.rampOutGain = 0.0;
    this.rampOutStep = 0.0;

    // Volume ramp for Attack (item 139). Counts down from ATTACK_RAMP_SAMPLES to 0
    // on every fresh triggerNote(); the mixer reads it as a half-cosine fade-in gain
    // and folds it into the same per-sample rampGain the sample-end ramp-out uses.
    this.attackRampSamples = 0;

    // Auto-vibrato.
    this.autoVibPhase = 0;
    this.autoVibTicksSinceTrigger = 0;

    // Active-sample view (snapshot by applyActiveSample at trigger).
    this.activeSamplePtr = 0;
    this.activeSampleLength = 0;
    this.activeSamplePlayStart = 0;
    this.activeSampleLoopStart = 0;
    this.activeSampleLoopEnd = 0;
    this.activeSamplingRate = 0;
    this.activeSampleDetune = 0; // signed 4096-TET
    this.activeLoopMode = 0;     // bits 0-1 direction, bit 2 sustain
    this.activeVibratoSpeed = 0;
    this.activeVibratoSweep = 0;
    this.activeVibratoDepth = 0;
    this.activeVibratoRate = 0;
    this.activeVibratoWaveform = 0;
    // Multi-channel view (Ixmp 's' block, item 90). 1 = mono — the only case
    // before stereo, and the only one the base instrument can express. 2 = the
    // sample is a stereo PAIR: chanPtr2 is the right channel's pool span, which
    // shares every geometry field above (length / play-start / loop / rate).
    // chanMode 0 = discrete L,R; 1 = matrix M,S (decoded at mix time).
    this.activeChanCount = 1;
    this.activeChanMode = 0;
    this.activeChanPtr2 = 0;
    this.right = new ChannelState();

    // Active-envelope view (snapshot by resolveActiveEnvelopes at trigger).
    this.activeVolEnv = makeActiveEnv(0x3f);
    this.activeVolEnvLoop = 0;
    this.activeVolEnvSustain = 0;
    this.activePanEnv = makeActiveEnv(0x80);
    this.activePanEnvLoop = 0;
    this.activePanEnvSustain = 0;
    this.activePitchEnv = makeActiveEnv(0x80);
    this.activePitchEnvLoop = 0;
    this.activePitchEnvSustain = 0;
    this.activeFilterEnv = makeActiveEnv(0x80);
    this.activeFilterEnvLoop = 0;
    this.activeFilterEnvSustain = 0;
    this.activeFadeoutStep = 0;
    this.activeDefaultCutoff = 0xff;
    this.activeDefaultResonance = 0xff;
    // false = IT filter units (bytes), true = SoundFont (cents / centibels).
    this.filterSfMode = false;
    this.activeAttenGain = 1.0;

    // NES 2A03 DMC counter for INTERP_NES_DPCM.
    this.nesDpcmCounter = 63;

    // Filter state.
    this.currentCutoff = 0xff;
    this.currentResonance = 0xff;
    this.filterActive = false;
    // IT 2-pole IIR-only: y[n] = A0·x[n] + B0·y[n-1] + B1·y[n-2]
    this.filterA0 = 1.0;
    this.filterB0 = 0.0;
    this.filterB1 = 0.0;
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    // SF2 RBJ biquad: y[n] = b02·(x[n]+x[n-2]) + b1·x[n-1] − a1·y[n-1] − a2·y[n-2]
    this.filterIsBiquad = false;
    this.filterBqB02 = 0.0;
    this.filterBqB1 = 0.0;
    this.filterBqA1 = 0.0;
    this.filterBqA2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.filterCutoffCached = -1;
    this.filterResonanceCached = -1;

    // Per-trigger random vol/pan swing biases.
    this.randomVolBias = 0;
    this.randomPanBias = 0;

    // Pitch state (4096-TET).
    this.noteVal = 0x0000;
    this.basePitch = 0x4000;
    this.amigaPeriod = -1.0; // -1.0 = needs reseed
    this.linearFreq = -1.0;
    // JS-only display tap (no Kotlin counterpart): the last per-tick sounding
    // pitch (finalPitch — after slides/arpeggio/vibrato/pitch-env), so the
    // Timeline header can show what the voice is ACTUALLY playing per tick, not
    // just the row-triggered noteVal. Never read by the DSP.
    this.renderPitch = 0x0000;
    // This tick's pitch OVERLAY — vibrato / glissando / arpeggio, as a signed
    // delta on noteVal. A metainstrument's layer children read it off their
    // parent so the bend reaches every layer (item 154; layerPitchMod).
    this.pitchModDelta = 0;

    // Per-row effect state.
    this.rowEffect = 0;
    this.rowEffectArg = 0;
    this.slideMode = 0;
    this.slideArg = 0;
    this.tonePortaTarget = -1;
    this.tonePortaSpeed = 0;
    this.arpOff1 = 0;
    this.arpOff2 = 0;
    this.arpActive = false;
    this.lastArpVoice = 0;
    this.tremorOn = 0;
    this.tremorOnTime = 1;
    this.tremorOffTime = 1;
    this.tremorPhaseOn = true;
    this.tremorTickInPhase = 0;

    // Vibrato (H / U).
    this.vibratoActive = false;
    this.vibratoLfoPos = 0;   // 1088-step phase (lfoSampleWide), not the auto-vib 256
    this.vibratoWave = 0;
    this.vibratoRetrig = true;
    this.vibratoFineShift = 6; // 6 for H, 8 for U

    // Tremolo (R).
    this.tremoloActive = false;
    this.tremoloLfoPos = 0;
    this.tremoloWave = 0;
    this.tremoloRetrig = true;

    // Panbrello (Y). `panbrelloOffset` is a signed pan offset the mixer sums
    // alongside notePan and randomPanBias — an OFFSET rather than a write to
    // either axis, so the LFO swings around wherever the channel and the note
    // have put the voice without eating the instrument's own pan seed, and so
    // it reaches the surround path (voiceAzimuth) unchanged.
    this.panbrelloActive = false;
    this.panbrelloLfoPos = 0;
    this.panbrelloWave = 0;
    this.panbrelloRetrig = true;
    this.panbrelloOffset = 0;

    this.glissandoOn = false;

    // Q retrigger.
    this.retrigCounter = 0;
    this.retrigInterval = 0;
    this.retrigVolMod = 0;
    this.retrigActive = false;

    // Note delay (S$Dx) + its optional post-trigger action (S$Dxny, item 94;
    // JS-only so far — TSVM has no `n`/`y` handling yet, only `x`).
    this.noteDelayTick = -1;
    this.delayedNote = 0;
    this.delayedInst = 0;
    this.delayedVol = -1;
    // The argument a DELAYED Int0..IntF marker is holding (item 181).
    // `delayedNote` carries the marker itself, but a note word has no room for
    // a second 16-bit number, so the argument needs its own slot.
    this.delayedInterruptArg = 0;
    this.noteActionTick = -1; // absolute tick-in-row for the S$Dxny follow-up ($x+$y)
    this.delayedAction = -1;  // the $n value (0..4), or -1 = none scheduled

    // Note cut (S$Cx).
    this.cutAtTick = -1;
    this.noteWasCut = false;

    // Invert loop (S $F0xx).
    this.invertSpeed = 0;
    this.invertAccumulator = 0;
    this.invertWritePos = 0;

    // Funk repeat (Z $Ffxx) — ProTracker 1.0C's OTHER EFx, which hops the
    // sounding LOOP WINDOW through the sample instead of inverting bytes.
    // `funkPos` is the walking pointer (PT's n_wavestart: an absolute byte
    // index, -1 = never walked) and `funkWindow` is the window the voice is
    // actually sounding — Paula reloaded AUDxLC at the loop wrap, so the
    // pointer may be ahead of the window that is playing. `funkMode` is item
    // 163's `$f`: the hop's size and what it does (tick.js funkWalkStep /
    // funkWalkPointer), 0 being 1.0C's own whole-block hop forward.
    // `funkWalk` is where the DETERMINISTIC walk has got to, which is the same
    // as funkPos except under `$8`-`$B`, whose throw is measured from it every
    // step so the jitter cannot accumulate. Speed, mode and accumulator are all
    // CHANNEL state: nothing resets them but a transport reset (§2.1).
    this.funkSpeed = 0;
    this.funkMode = 0;
    this.funkAccumulator = 0;
    this.funkWalk = -1;
    this.funkPos = -1;
    this.funkWindow = -1;
    // Anti-click crossfade over the seam a hop opens (item 163.2), the sample
    // modifications' idea applied to a moved loop: `funkXfade` counts down
    // output samples out of `funkXfadeLen`, and the ghost read is the live
    // position shifted by `funkXfadeOffset` — (old window − new window), so it
    // follows the voice's own rate and direction without a second cursor.
    this.funkXfade = 0;
    this.funkXfadeLen = 1;
    this.funkXfadeOffset = 0;

    // Sample modification (notefx 2 / 3) — the operation and its region live on
    // the instrument; the channel only drives the clock. `modPeriod` is the step
    // period in TICKS (item 153.1), 0 = frozen, and modTickCount counts up to it.
    this.modPeriod = 0;
    this.modTickCount = 0;
    this.modWritePos = 0;
    // Countdown of the anti-click crossfade between the mapping the last step
    // replaced and the one it installed (item 153.5), in output samples.
    this.modXfade = 0;
    // Argument extension (item 162): a `:`-paired 2/3 clocks itself in SAMPLES
    // rather than whole ticks, since $yk reaches periods under one tick —
    // modExtended picks which clock owns this voice's step (mixer.js's
    // per-sample accumulator vs tick.js's per-tick one; never both).
    this.modExtended = false;
    this.modStepTicks = 0;        // period in TICKS (float, may be < 1) — tempo-
                                   // independent, like modPeriod; mixer.js turns
                                   // it into samples fresh every sample (spt
                                   // itself is recomputed there every sample,
                                   // for T-slide correctness) rather than baking
                                   // a stale sample count in at row-apply time.
    this.modSamplesIntoStep = 0;
    // This voice's resolved view of the instrument's region — the fractions cut
    // against the loop THIS voice is sounding. Rebuilt only when either moves.
    this.modGeom = new ModGeom();

    // Extended $102/$12x (funk repeat / funk repeat, jittered — item 173
    // follow-up): the SAME "hop the sounding loop window through the sample"
    // trick Z $Ffxx's funkWindow/funkPos/funkXfade* are, on this command's own
    // clock and state (inst.modFunkWalk/modFunkPos), never Z's. Per the formal
    // Funk Repeat spec ("add replen to repeat"), the walked window is NOT
    // bounded to $se's resolved region the way ROL/JUMP/SCATTER are — it moves
    // the loop itself, replen (= the resolved region's own length) at a time,
    // anywhere the physical sample has room. So this is applied at the loop
    // WRAP (sampler.js advanceSamplePos), exactly where Z's own hop lands, not
    // as a per-byte address transform — a funk'd voice's samplePos, once
    // windowed, simply IS somewhere else in the sample; nothing has to move
    // where each byte is read from once it gets there.
    this.modFunkWindow = -1;  // this voice's own latched restart point, -1 = never windowed
    this.modFunkXfade = 0;
    this.modFunkXfadeLen = 1;
    this.modFunkXfadeOffset = 0;

    // Pattern loop (S$Bx).
    this.loopStartRow = 0;
    this.loopCount = 0;

    // Pattern ditto (effect 7).
    this.dittoActive = false;
    this.dittoSourceStart = 0;
    this.dittoLength = 0;
    this.dittoEndRow = 0;

    // Tempo slide (T $00xy).
    this.tempoSlideDir = 0;
    this.tempoSlideAmount = 0;

    // Global volume slide (W $xy00).
    this.wSlideDir = 0;
    this.wSlideAmount = 0;

    // Volume / pan column slides.
    this.volColSlideUp = 0;
    this.volColSlideDown = 0;
    // Per-tick pan slides, one pair per axis — the pan twin of nSlideDir (N,
    // channel volume) vs volColSlide* (the volume column, note volume).
    this.panColSlideRight = 0;   // the panning column's, on the note axis
    this.panColSlideLeft = 0;
    this.chanPanSlideRight = 0;  // effect P's, on the channel axis
    this.chanPanSlideLeft = 0;
    this.nSlideDir = 0;

    // Bitcrusher (8) / Overdrive (9).
    this.clipMode = 0;
    this.bitcrusherDepth = 0;
    this.bitcrusherSkip = 0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.overdriveAmp = 0;

    this.mem = new MemorySlots();

    // Equal-energy pan-law memo (item 179). `advancePanRamp` returns a pan that
    // is CONSTANT whenever the voice is not being moved — it lands exactly on
    // its target and stays there — so the cosine and sine the law needs are
    // computed on a change and reused on every sample in between. NaN so the
    // first comparison always misses.
    this.panLawPan = NaN;
    this.panLawL = 0.0;
    this.panLawR = 0.0;
    // Soundscope ring buffer (visualisation only).
    this.scopeBuffer = new Float32Array(SCOPE_BUFFER_SIZE);
    this.scopeWritePos = 0;
  }

  get activeSampleLoopSustain() { return (this.activeLoopMode & 0x04) !== 0; }
  /** True when this voice renders a stereo pair (see activeChanCount). */
  get isStereo() { return this.activeChanCount === 2; }
}

// ══ src/engine/state.js ══
// PlayCue / PlayInstruction / TaudPlayData / TrackerState / Playhead —
// port of AudioAdapter.kt:4412-4494, 4880-5208, 5210-5244.









// ── PlayInstruction (4484-4494) — tagged objects ──
const INST_NOP = 0;
const INST_GOBACK = 1;
const INST_SKIP = 2;
const INST_JUMP = 3;
const INST_PATLEN = 4;
const INST_HALTAT = 5;
const INST_HALT = 6;

const PLAY_INST_NOP = Object.freeze({ type: INST_NOP, arg: 0 });
const PLAY_INST_HALT = Object.freeze({ type: INST_HALT, arg: 0 });

/** Per-cue playback data: 64 u16 channel words (pattern | signBit<<15). */
class PlayCue {
  constructor() {
    this.raw = new Int32Array(MAX_VOICES).fill(PATTERN_EMPTY);
    this.inst0 = PLAY_INST_NOP;
    this.inst1 = PLAY_INST_NOP;
  }

  /** Pattern number for channel ch (0..0x7FFE), or PATTERN_EMPTY. */
  pattern(ch) { return this.raw[ch] & 0x7fff; }

  _instWord(base) {
    let w = 0;
    for (let k = 0; k < 16; k++) w |= ((this.raw[base + k] >>> 15) & 1) << k;
    return w;
  }

  recomputeInstructions() {
    this.inst0 = decodeInstWord(this._instWord(0));
    this.inst1 = decodeInstWord(this._instWord(16));
  }

  /** Effective playable row count: a LEN or "halt at x" in either word shortens it. */
  rowLimit() { return Math.min(rowsOf(this.inst0), rowsOf(this.inst1)); }

  /** True if either instruction word halts playback. */
  isHalt() {
    return this.inst0.type === INST_HALT || this.inst0.type === INST_HALTAT ||
           this.inst1.type === INST_HALT || this.inst1.type === INST_HALTAT;
  }

  /** The flow instruction (BAK / FWD / JMP) carried by either word, else NOP. */
  flowInstruction() {
    const t0 = this.inst0.type;
    if (t0 === INST_GOBACK || t0 === INST_SKIP || t0 === INST_JUMP) return this.inst0;
    const t1 = this.inst1.type;
    if (t1 === INST_GOBACK || t1 === INST_SKIP || t1 === INST_JUMP) return this.inst1;
    return PLAY_INST_NOP;
  }

  write(index, byte) {
    const ch = index >>> 1;
    this.raw[ch] = (index & 1) === 0
      ? (this.raw[ch] & 0xff00) | (byte & 0xff)
      : (this.raw[ch] & 0x00ff) | ((byte & 0xff) << 8);
    this.recomputeInstructions();
  }

  read(index) {
    const ch = index >>> 1;
    return (index & 1) === 0 ? this.raw[ch] & 0xff : (this.raw[ch] >>> 8) & 0xff;
  }
}

function decodeInstWord(w) {
  if (w === 0) return PLAY_INST_NOP;
  const b30 = (w >>> 8) & 0xff;
  const b31 = w & 0xff;
  if (b30 === 0x02) return { type: INST_PATLEN, arg: (b31 & 0x3f) + 1, rows: (b31 & 0x3f) + 1 };
  if (b30 === 0x01) {
    // HALT family: arg 01xxxxxx ⇒ "halt at x" (x = 0 ⇒ full length); else plain HALT.
    if ((b31 & 0xc0) === 0x40) {
      const x = b31 & 0x3f;
      return { type: INST_HALTAT, arg: x === 0 ? 64 : x, rows: x === 0 ? 64 : x };
    }
    return PLAY_INST_HALT;
  }
  if ((b30 & 0xf0) === 0x80) return { type: INST_GOBACK, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0x90) return { type: INST_SKIP, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0xf0) return { type: INST_JUMP, arg: ((b30 & 0xf) << 8) | b31 };
  return PLAY_INST_NOP;
}

function rowsOf(inst) {
  return inst.type === INST_PATLEN || inst.type === INST_HALTAT ? inst.rows : 64;
}

// ── TaudPlayData — one pattern cell (5210-5244) ──
// Two wire layouts share these fields: the 8-byte cell of format versions 1-2
// (getByte/setByte) and version 3's 16-byte WIDE cell (getByteWide/setByteWide).
// The wide layout is a superset in meaning, not in encoding — its volume is a
// whole byte and its panning column is an azimuth plus an elevation rather than
// a 6-bit front-arc value — so the two codecs stay separate and the v2 path is
// untouched, which is what keeps it bit-exact.
class TaudPlayData {
  constructor() {
    this.note = 0;       // 0..65535
    this.instrment = 0;  // 0..255 (sic — Kotlin field name kept for diffability)
    this.volume = 0;     // 0..63, or 0..255 in a wide cell
    this.volumeEff = 0;  // 0..3, or 0..7 in a wide cell
    this.pan = 0;        // 0..63 — the 8-byte cell's front-arc column value
    this.panEff = 0;     // 0..3, or 0..15 in a wide cell
    this.effect = 0;     // 0..255
    this.effectArg = 0;  // 0..65535
    // ── wide cell only (#v3) ──
    this.azimuth = 0;    // 0..511, the panning column's 9-bit angle
    this.elevation = 0;  // -128..127, signed
    this.effect2 = 0;    // second effect, applied after the first
    this.effectArg2 = 0;
  }

  /** Wide-cell byte view — see the file format's §5.5 table. */
  getByteWide(offset) {
    switch (offset) {
      case 0: return this.note & 0xff;
      case 1: return (this.note >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return this.volume & 0xff;
      case 4: return this.azimuth & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      case 8: return (((this.azimuth >>> 8) & 1) << 7) |
                     ((this.volumeEff & 7) << 4) | (this.panEff & 0xf);
      case 9: return this.elevation & 0xff;
      case 10: return this.effect2 & 0xff;
      case 11: return this.effectArg2 & 0xff;
      case 12: return (this.effectArg2 >>> 8) & 0xff;
      case 13: case 14: case 15: return 0; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByteWide(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 0xff; break;
      case 4: this.azimuth = (this.azimuth & 0x100) | byte; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      case 8:
        this.azimuth = (this.azimuth & 0xff) | ((byte & 0x80) << 1);
        this.volumeEff = (byte >>> 4) & 7;
        this.panEff = byte & 0xf;
        break;
      case 9: this.elevation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 10: this.effect2 = byte; break;
      case 11: this.effectArg2 = (this.effectArg2 & 0xff00) | byte; break;
      case 12: this.effectArg2 = (this.effectArg2 & 0x00ff) | (byte << 8); break;
      case 13: case 14: case 15: break; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  getByte(offset) {
    switch (offset) {
      case 0: return this.note & 0xff;
      case 1: return (this.note >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return (this.volume | (this.volumeEff << 6)) & 0xff;
      case 4: return (this.pan | (this.panEff << 6)) & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByte(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 63; this.volumeEff = (byte >>> 6) & 3; break;
      case 4: this.pan = byte & 63; this.panEff = (byte >>> 6) & 3; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }
}

// ── TrackerState (4880-4947) ──
class TrackerState {
  constructor() {
    this.cuePos = 0;
    this.rowIndex = 0;
    this.tickInRow = 0;
    this.samplesIntoTick = 0.0;
    this.firstRow = true;
    // Always MAX_VOICES so 64-channel mode has slots for every channel, plus
    // the dedicated jam bank above them (JAM_VOICE_BASE…, item 140) — the tick
    // and mix loops run the whole array, the row loop only the channels.
    this.voices = new Array(TOTAL_VOICES);
    for (let i = 0; i < TOTAL_VOICES; i++) this.voices[i] = new Voice();

    // Tone-slide mode: 0=linear 4096-TET, 1=Amiga period, 2=linear-frequency (Hz).
    this.toneMode = 0;
    this.interpolationMode = INTERP_DEFAULT;
    this.ledFilterOn = false;

    // Cell format (file format version 3 — the wide cell). It sets the width of
    // the volume column, and with it the whole volume STATE: note, row and
    // channel volume are 0…63 in a v2 song and 0…255 in a v3 one. `volStep` is
    // what a 6-bit-derived delta is worth (a nibble slide, a tremolo depth), so
    // `D $01` moves at the same musical rate in both; `volDiv` normalises to
    // gain. Instrument data — envelope nodes, Ixmp velocity rectangles — stays
    // 6-bit in both, so a bank loads into either.
    this.wideCells = false;
    this.volMax = VOLUME_MAX;
    this.volStep = 1;
    this.volDiv = 63.0;

    // Surround model (#998; song-immutable `ss` flag) + the object bus it mixes
    // into. Null bus = the stereo model, which keeps the plain two-accumulator
    // path untouched — see mixer.js.
    this.surroundModel = SURROUND_STEREO;
    this.spatial = null;
    // Master-strip analysis tap (item 98) — null unless a host asked for one.
    this.analysis = null;
    this.analysisTarget = ANALYSIS_OFF;
    // Mastering chain (item 178) — the song's own, uploaded from its `sMst`
    // section. `mastering` is null whenever the chain would not change a
    // sample, which is what keeps the untouched output path bit-exact; the
    // PARAMETERS are kept either way so a readback returns what was uploaded.
    this.masteringParams = defaultMastering();
    this.mastering = null;
    // …and its metering tap (loudness.js), null unless the Mastering view asked
    // for one. Independent of the strip's tap: different signal, different
    // question, and both are opt-in.
    this.masterMeter = null;
    // Per-voice soundscope ring, ditto (item 179). The Kotlin device fills
    // `Voice.scopeBuffer` unconditionally because a TSVM guest can read the
    // scope window through MMIO whenever it likes; nothing here can, so the
    // ring is filled only while a host has asked for it (setVoiceScopeTap).
    this.scopeOn = false;

    // Song tuning as a playback-rate multiplier (item 77) — mirrored down from
    // the playhead by setTuning, like toneMode/interpolationMode are from the
    // global-behaviour flags, so the per-sample path reads it off `ts` alone.
    // 1.0 = concert; the tracker default (C9 @ 8363) is 0.99892 (~1.87c flat).
    this.tuningRatio = 1.0;

    // Post-mix Amiga filter state (stereo bus).
    this.amigaLPStateL = 0.0;
    this.amigaLPStateR = 0.0;
    this.amigaLEDStateL = new Float64Array(4); // [in_z1, in_z2, out_z1, out_z2]
    this.amigaLEDStateR = new Float64Array(4);

    // Pending row-end events.
    this.pendingOrderJump = -1;
    this.pendingRowJump = -1;
    this.pendingRowJumpLocal = false;

    // Pattern delay (S$Ex).
    this.patternDelayRemaining = 0;
    this.patternDelayActive = false;
    this.sexWinningChannel = -1;

    // Fine pattern delay (S$6x).
    this.finePatternDelayExtra = 0;

    // Interrupt-note latch (Int0..IntF). Plain int — the engine is single-threaded
    // inside the worklet; the drain happens in snapshot assembly (edge-triggered,
    // level-collapsed semantics preserved).
    this.pendingInterrupts = 0;
    // …and the argument each pending Int carried (item 181): the `:` on the same
    // row, or 0 where the row has none. Only the words whose mask bit is set
    // mean anything; a bit that fires twice before the host drains it keeps the
    // LAST argument, which is the same level-collapsing the mask already does.
    this.interruptArgs = new Uint16Array(NUM_INTERRUPTS);

    // Pre-allocated mix buffers (Float32 — matches the Kotlin FloatArray mix bus).
    this.mixLeft = new Float32Array(TRACKER_CHUNK);
    this.mixRight = new Float32Array(TRACKER_CHUNK);

    // Mixer-private background voices (NNA ghosts); index 0 = oldest.
    this.backgroundVoices = [];
  }

  /**
   * Install the cell format (file format version 3). Rescales the running
   * volume state so a switch cannot leave a voice at a quarter of its intended
   * level; in practice this is called once, before anything is uploaded.
   */
  setCellFormat(wide) {
    if (this.wideCells === !!wide) return;
    this.wideCells = !!wide;
    this.volMax = wide ? VOLUME_MAX_WIDE : VOLUME_MAX;
    this.volStep = wide ? VOLUME_STEP_WIDE : 1;
    this.volDiv = this.volMax * 1.0;
    for (const v of this.voices) {
      v.noteVolume = this.volMax;
      v.channelVolume = this.volMax;
      v.rowVolume = this.volMax;
    }
  }

  /**
   * Install the song's surround model (#998). The stereo model keeps `spatial`
   * null — the mixer's legacy two-accumulator path, untouched; anything else
   * allocates the object bus for `renderer`, which is the device's
   * StereoRenderer unless an exporter asked for a different render target.
   */
  setSurroundModel(model, renderer = null) {
    this.surroundModel = model & 3;
    this.spatial = this.surroundModel === SURROUND_STEREO
      ? null
      : new SpatialBus(renderer ?? new StereoRenderer(), TRACKER_CHUNK);
    this.setAnalysis(this.analysisTarget); // the tap's shape follows the model
  }

  /**
   * Install (or remove) the master-strip analysis tap (item 98). ANALYSIS_OFF
   * frees it: nothing on the render path may cost anything while the strip is
   * hidden, which is also why this is a command and not a permanent fixture.
   */
  setAnalysis(target) {
    this.analysisTarget = target;
    this.analysis = (target === ANALYSIS_OFF || target === undefined)
      ? null
      : new AnalysisTap(target, this.surroundModel);
  }

  /**
   * Install the song's mastering chain (item 178). A parameter set that would
   * not change a sample installs NOTHING — the mixer then keeps the plain
   * narrow-and-clamp it has always had, so every song that predates the
   * Mastering tab still renders bit-for-bit as it did.
   *
   * Reconfiguring a chain that is already up keeps its delay lines, so moving a
   * control while the song plays does not click.
   */
  setMastering(params) {
    this.masteringParams = params;
    if (!masteringEngaged(params)) { this.mastering = null; return; }
    if (this.mastering === null) this.mastering = new MasterChain(params);
    else this.mastering.setParams(params);
  }

  /** Install (or drop) the Mastering view's metering tap. `scramble` adds the
   *  phase-scrambled crest measurement, which only the offline analyser asks
   *  for (loudness.js explains why it is not on the live path); `bitDepth`
   *  picks which delivered format the bit-usage census describes. */
  setMasterMeter(on, scramble = false, bitDepth = DEFAULT_BIT_DEPTH) {
    if (!on) { this.masterMeter = null; return; }
    const depth = bitDepth === 8 ? 8 : 16;
    if (this.masterMeter === null || this.masterMeter.scramble !== !!scramble ||
        this.masterMeter.bitDepth !== depth) {
      this.masterMeter = new MasterMeterTap(SAMPLING_RATE,
        { scramble: !!scramble, bitDepth: depth });
    }
  }

  drainInterrupts() {
    const m = this.pendingInterrupts;
    this.pendingInterrupts = 0;
    return m;
  }

  /** The argument latched with Int `n` (item 181). Meaningful only for a bit
   *  the matching drain returned — the words outlive the mask, so reading one
   *  for an interrupt that did not fire yields whatever fired last. */
  interruptArg(n) { return this.interruptArgs[n & (NUM_INTERRUPTS - 1)]; }
}

// ── Playhead (4949-5207), tracker-mode-only port ──
// PCM mode, audio devices and MMIO byte protocol are host concerns and omitted.
class Playhead {
  constructor(parent, index) {
    this.parent = parent;
    this.index = index;

    this.position = 0;
    this.masterVolume = 0;
    this.masterPan = 128;
    this.bpm = 125;      // 25..535
    this.tickRate = 6;
    this.patBank1 = 0;
    this.patBank2 = 0;
    this.globalVolume = 0x80;
    this.mixingVolume = 0x80;
    // Declared song tuning (item 77), kept for readback; the hot path uses the
    // multiplier setTuning derives onto trackerState. Untuned until a song
    // load pushes the file's pair — the engine has no song table of its own,
    // so the spec's "if zero, assume the tracker default" rule lives in
    // tuningRatioOf, on the values the host hands over.
    this.tuningBaseNote = 0;
    this.tuningFreq = 0.0;

    this.trackerState = new TrackerState();
    this.jamActive = false;
    this.initialGlobalFlags = 0;
    // Song-immutable surround model + the render target it mixes through
    // (#998). Null renderer = the device's own monitor, picked by monitorMode
    // (fold or binaural, #998.3); an exporter overrides it with the format's
    // renderer and the engine never learns which format asked.
    this.surroundModel = SURROUND_STEREO;
    this.spatialRenderer = null;
    this.monitorMode = MONITOR_FOLD;
    this.binauralRenderer = null; // built on demand, kept across model switches

    this._isPlaying = false;
  }

  /**
   * The render target the object bus should use right now (#998.3): an
   * exporter's explicit renderer if one is installed, otherwise the device
   * monitor this playhead is set to — null for the fold (the bus builds its own
   * StereoRenderer), or a binaural head matching the song's model. The binaural
   * renderer is stateful, so it is kept across model switches and reset each
   * time it is (re-)installed.
   */
  effectiveSpatialRenderer() {
    if (this.spatialRenderer !== null) return this.spatialRenderer;
    if (this.monitorMode !== MONITOR_BINAURAL || this.surroundModel === SURROUND_STEREO) return null;
    const sphere = this.surroundModel === SURROUND_SPATIAL;
    if (this.binauralRenderer === null || this.binauralRenderer.sphere !== sphere) {
      this.binauralRenderer = new BinauralRenderer(sphere);
    }
    this.binauralRenderer.reset();
    return this.binauralRenderer;
  }

  /** (Re-)install the surround model on the tracker state with that target. */
  applySurroundModel() {
    this.trackerState.setSurroundModel(this.surroundModel, this.effectiveSpatialRenderer());
  }

  updateTrackerGlobalBehaviour(flags) {
    const ts = this.trackerState;
    if (ts !== null) {
      ts.toneMode = flags & 3;
      ts.interpolationMode = (flags >>> 2) & 7;
    }
  }

  /**
   * Silence every voice the SONG owns — the channels plus the NNA / layer
   * ghosts hanging off them — leaving the jam bank alone, so an audition held
   * across a stop keeps sounding (JS-only, item 140: the Kotlin device has no
   * jam bank and stops the lot).
   *
   * Stopping the transport only clears isPlaying: the mixer runs while
   * isPlaying or jamActive, so it switches off, but every voice stays FROZEN
   * mid-note. Whatever turns the mix back on — a jammed key — would otherwise
   * resume the whole cut-off chord along with the note actually struck, and a
   * Stop pressed while an audition rang would not stop the song at all (nothing
   * ever goes silent, so jamActive never auto-clears either). Called from both
   * ends of the transport: TaudEngine.stop and the mixer's halt-cue tail.
   *
   * `ramp` cuts through the note-cut ramp, for a mix that is still running: a
   * hard drop mid-waveform clicks. With nothing rendering, drop them outright —
   * a ramp nobody renders is just the revival deferred to the next jam.
   */
  silenceSongVoices(ramp) {
    const ts = this.trackerState;
    if (ts === null) return;
    const cut = (v) => {
      if (!v.active) return;
      if (ramp) startCutRamp(v); else v.active = false;
    };
    for (let vi = 0; vi < JAM_VOICE_BASE; vi++) cut(ts.voices[vi]);
    for (const bg of ts.backgroundVoices) {
      if (bg.sourceChannel < JAM_VOICE_BASE) cut(bg);
    }
  }

  get isPlaying() { return this._isPlaying; }
  set isPlaying(value) {
    // Starting real playback ends any jam audition: drop leftover jammed voices
    // so a held audition can't bleed into the first rows of the song.
    if (!this._isPlaying && value && this.jamActive) {
      const ts = this.trackerState;
      if (ts !== null) {
        for (const v of ts.voices) v.active = false;
        for (const v of ts.backgroundVoices) v.active = false;
      }
      this.jamActive = false;
    }
    this._isPlaying = value;
  }

  setCuePosition(pos) {
    this.position = pos;
    const ts = this.trackerState;
    if (ts !== null) ts.cuePos = Math.min(pos, NUM_CUES - 1);
  }

  resetParams() {
    this.position = 0;
    this.isPlaying = false;
    this.jamActive = false;
    // Spec §5 defaults — applied on every reset so song-start state is well-defined.
    this.bpm = 125;
    this.tickRate = 6;
    this.globalVolume = 0x80;
    this.mixingVolume = 0x80;
    this.tuningBaseNote = 0;
    this.tuningFreq = 0.0;
    const ts = this.trackerState;
    if (ts === null) return;
    ts.tuningRatio = 1.0;
    ts.cuePos = 0; ts.rowIndex = 0; ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0; ts.firstRow = true;
    ts.pendingOrderJump = -1; ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    ts.patternDelayRemaining = 0; ts.patternDelayActive = false;
    ts.sexWinningChannel = -1;
    ts.finePatternDelayExtra = 0;
    ts.pendingInterrupts = 0;
    ts.interruptArgs.fill(0);
    ts.toneMode = this.initialGlobalFlags & 3;
    ts.interpolationMode = (this.initialGlobalFlags >>> 2) & 7;
    this.applySurroundModel();
    ts.ledFilterOn = false;
    ts.amigaLPStateL = 0.0; ts.amigaLPStateR = 0.0;
    ts.amigaLEDStateL.fill(0.0); ts.amigaLEDStateR.fill(0.0);
    // Mastering (item 178) goes back to neutral for the same reason the tuning
    // does: nothing in a fresh document describes the chain the previous one
    // left installed, and a full reset is what a host performs before uploading
    // one. The song's own `sMst` parameters are pushed straight after.
    ts.setMastering(defaultMastering());
    ts.masterMeter?.resetAll();
    for (const it of ts.voices) {
      it.active = false;
      it.noteVolume = ts.volMax;
      it.channelVolume = ts.volMax;
      it.rowVolume = ts.volMax;
      it.currentMixVolume = 1.0;
      it.volRampSamples = 0;
      it.volRampStep = 0.0;
      it.currentPan = 128.0; it.panRampSamples = 0; it.panRampStep = 0.0; it.snapPan = true;
      it.snapMixVolume = false;
      it.envVolMix = 1.0;
      it.envVolStep = 0.0;
      it.channelPan = 0x80;
      it.rowPan = 32;
      it.panbrelloOffset = 0;
      it.panAzimuth = 128.0;
      it.panElevation = 0.0;
      it.notePan = 0;
      it.noteElevation = 0.0;
      it.spatialTargetAz = 128.0;
      it.spatialTargetEl = 0.0;
      it.spatialSlideActive = false;
      it.spatial = null;
      it.glissandoOn = false;
      it.loopStartRow = 0;
      it.loopCount = 0;
      it.dittoActive = false;
      it.dittoSourceStart = 0;
      it.dittoLength = 0;
      it.dittoEndRow = 0;
      // Bitcrusher (8) / Overdrive (9) — the CHANNEL's colouring, written by the
      // song's own effects and cleared by nothing else, so a full reset owes
      // them the same clean slate as the panning above (§15).
      it.clipMode = 0;
      it.bitcrusherDepth = 0;
      it.bitcrusherSkip = 0;
      it.bitcrusherCounter = 0;
      it.bitcrusherHeld = 0.0;
      it.overdriveAmp = 0;
      it.invertSpeed = 0;
      it.invertAccumulator = 0;
      it.invertWritePos = 0;
      it.funkSpeed = 0;
      it.funkMode = 0;
      it.funkAccumulator = 0;
      it.funkWalk = -1;
      it.funkPos = -1;
      it.funkWindow = -1;
      it.funkXfade = 0;
      it.modFunkWindow = -1;
      it.modFunkXfade = 0;
      it.modPeriod = 0;
      it.modTickCount = 0;
      it.modWritePos = 0;
      it.modXfade = 0;
      it.fader = 0;
      it.nnaOverride = -1;
      it.volEnvOn = true; it.panEnvOn = true; it.pitchEnvOn = true; it.filterEnvOn = true;
      it.metaForeground = false;
      it.metaForegroundDetune = 0;
      it.noteFading = false;
      it.layerMixGain = 1.0; it.isLayerChild = false; it.layerRelDetune = 0;
      it.layerFixedNote = -1;
      it.layerRelPan = 0; it.layerRelElevation = 0;
      it.layerPitchMod = 0; it.pitchModDelta = 0;
      it.fmRig = null; it.fmOperator = false;
      // "What's playing" state — cleared alongside the volume reset so a stale
      // instrumentId can't survive into a fresh session (AudioAdapter.kt:5130-5142).
      it.instrumentId = 0;
      it.displayInst = 0;
      it.activePatchIndex = -1; // stem tap, cleared with the rest of "what's playing"
      it.samplePos = 0.0;
      it.playbackRate = 1.0;
      it.currentPlaybackRate = 1.0;
      it.pitchRampSamples = 0; it.pitchRampStep = 0.0; it.snapPlaybackRate = true;
      it.forward = true;
      it.keyOff = false;
      it.envIndex = 0; it.envTimeSec = 0.0; it.envVolume = 1.0;
      it.envPanIndex = 0; it.envPanTimeSec = 0.0; it.envPan = 0.5;
      it.hasPanEnv = false;
      it.envPitchIndex = 0; it.envPitchTimeSec = 0.0; it.envPitchValue = 0.5;
      it.envFilterIndex = 0; it.envFilterTimeSec = 0.0; it.envFilterValue = 0.5;
      it.hasPitchEnv = false; it.hasFilterEnv = false;
      it.fadeoutVolume = 1.0;
      it.rampOutSamples = 0; it.rampOutGain = 0.0; it.rampOutStep = 0.0;
      it.attackRampSamples = 0;
      it.noteVal = 0x0000; it.basePitch = 0x4000;
      it.amigaPeriod = -1.0; it.linearFreq = -1.0;
      it.tonePortaTarget = -1; it.tonePortaSpeed = 0;
      it.filterY1 = 0.0; it.filterY2 = 0.0; it.filterX1 = 0.0; it.filterX2 = 0.0;
      it.filterCutoffCached = -1; it.filterResonanceCached = -1;
      it.currentCutoff = 0xff; it.currentResonance = 0xff;
      it.nesDpcmCounter = 63;
      it.right.reset();
      it.activeChanCount = 1; it.activeChanMode = 0; it.activeChanPtr2 = 0;
    }
    ts.backgroundVoices.length = 0;
    // Sample modifications (invert masks + notefx 2/3 regions) and notefx 5/6
    // overrides are per-instrument runtime state — clear so a replay (or song
    // loop) starts from the file defaults.
    for (const inst of this.parent.instruments) {
      inst.invertMask = null;
      inst.resetMod();
      inst.cutoffOverride = -1;
      inst.resonanceOverride = -1;
    }
  }

  /** Clear the sample-effect state only: the invert loop's per-voice speeds
   *  and per-instrument masks, funk repeat's per-voice loop windows, and the
   *  notefx 2/3 modifications (regions and rotations). */
  resetSampleFxState() {
    const ts = this.trackerState;
    if (ts !== null) {
      for (const it of ts.voices) {
        it.invertSpeed = 0;
        it.invertAccumulator = 0;
        it.invertWritePos = 0;
        it.funkSpeed = 0;
        it.funkMode = 0;
        it.funkAccumulator = 0;
        it.funkWalk = -1;
        it.funkPos = -1;
        it.funkWindow = -1;
        it.funkXfade = 0;
        it.modFunkWindow = -1;
        it.modFunkXfade = 0;
        it.modPeriod = 0;
        it.modTickCount = 0;
        it.modWritePos = 0;
        it.modXfade = 0;
      }
    }
    for (const inst of this.parent.instruments) {
      inst.invertMask = null;
      inst.resetMod();
    }
  }
}

// ══ src/engine/sampler.js ══
// Sample fetch + interpolators + anti-click ramps — port of AudioAdapter.kt
// computePlaybackRate (1515), readSamplePoint (2211), fetchTrackerSample (2221),
// startRampOut (2341), startFastFade (2357), advanceVolumeRamp (2376).
//
// `eng` is the TaudEngine instance (carries sampleBin as a Uint8Array; playback
// addresses the 8 MB pool directly by samplePtr — banking is a device-protocol
// concern that does not exist here).




/**
 * Active-sample-aware playback rate (patch-aware via the voice snapshot).
 *
 * `tuningRatio` is the song's tuning (item 77, ts.tuningRatio) — a whole-song
 * frequency scale applied last. Concert-tuned songs pass exactly 1.0, which is
 * an identity multiply, so they render bit-for-bit as if tuning did not exist.
 */
function computePlaybackRate(voice, noteVal, tuningRatio = 1.0) {
  return (voice.activeSamplingRate / SAMPLING_RATE) *
         2 ** ((noteVal - MIDDLE_C + voice.activeSampleDetune) / 4096.0) *
         tuningRatio;
}

/**
 * The pool byte at `i` with S $Fxxx's own mask applied — the plain fetch of
 * spec §8.1, and the point both halves of a sample-modification crossfade meet.
 *
 * Loop points come from the ACTIVE view: an Ixmp patch replaces them, and the
 * invert mask is sized and indexed against whichever loop is sounding (item 116).
 * The mask is tested against the byte ACTUALLY READ — a modification that moved
 * the read moved which mask bit answers for it.
 */
function poolByte(eng, voice, inst, i, binMax, basePtr, ls, le) {
  const b = eng.sampleBin[Math.min(basePtr + i, binMax)];
  if (inst.invertMask !== null && le > ls && i >= ls && i < le && inst.invertBit(i - ls, le - ls)) {
    return b ^ 0xff;
  }
  return b;
}

/**
 * Read one PCM sample (in [-1,1]) at integer index idx, honouring the
 * instrument's sample modifications — notefx 2/3's address transform (which
 * moves WHICH byte is read), its value transform, and the invert-loop mask
 * (which inverts the byte read). Caller wraps loop regions first.
 * `basePtr` is the pool address of the channel being read — voice.activeSamplePtr
 * for a mono voice or the first channel of a stereo pair, voice.activeChanPtr2
 * for its right channel (both channels share the invert mask and geometry).
 *
 * The modification's region is resolved against the loop THIS voice is sounding
 * (item 153) — the fractions on the instrument cut against the voice's own
 * domain — so an Ixmp-patched voice follows its own loop (item 116) and every
 * voice on a shared instrument hears the region its own sample defines.
 */
function readSamplePoint(eng, voice, inst, idx, sampleLen, binMax,
                                basePtr = voice.activeSamplePtr) {
  // The plain fetch is taken HERE rather than inside the body below, so this
  // function stays small enough for the JIT to inline it into a caller's tap
  // loop — the sinc interpolator takes seven of these per output sample per
  // channel, and inlining is most of what makes that affordable.
  if (plainFetchOnly(voice, inst)) return poolPoint(eng, sampleLen, binMax, basePtr, idx);
  return readModifiedSamplePoint(eng, voice, inst, idx, sampleLen, binMax, basePtr);
}

/**
 * True when every read of this (voice, instrument) pair reduces to the plain
 * pool fetch of spec §8.1 — no live sample modification, no crossfade tail left
 * by the one before it, no invert-loop mask. `modOn` alone is not the guard,
 * because a step that lands on the identity mapping (a jump that throws to
 * zero) still has the PREVIOUS one to fade out of.
 *
 * It is a property of the PAIR, not of the index, so an interpolator can test
 * it once and then read the pool directly for all of its taps.
 */
function plainFetchOnly(voice, inst) {
  return inst.invertMask === null &&
    ((inst.modOp === MOD_OFF && inst.modOpExt === 0) || (!inst.modOn && voice.modXfade === 0));
}

/** The plain fetch alone: clamp to the sample, clamp to the pool, scale to
 *  [-1,1] — exactly what readSamplePoint → poolByte compute when
 *  `plainFetchOnly` holds, written small so it inlines. */
function poolPoint(eng, sampleLen, binMax, basePtr, idx) {
  const hi = sampleLen - 1;
  const i = idx < 0 ? 0 : idx > hi ? hi : idx;
  const p = basePtr + i;
  return (eng.sampleBin[p > binMax ? binMax : p] - 127.5) / 127.5;
}

/** readSamplePoint's slow half — reached only while a sample modification is
 *  live, is fading out, or an invert-loop mask is installed. */
function readModifiedSamplePoint(eng, voice, inst, idx, sampleLen, binMax, basePtr) {
  const i0 = Math.min(Math.max(idx, 0), sampleLen - 1);
  const ls = voice.activeSampleLoopStart;
  const le = voice.activeSampleLoopEnd;
  const extended = inst.modOpExt !== 0;
  const g = resolveModGeom(voice.modGeom, inst, ls, le, sampleLen);
  // The touch test is evaluated at the byte's ORIGINAL position — that is where
  // the region and its comb are defined — and it does not move under a step, so
  // both sides of the crossfade agree on which bytes are in play. Extended mode
  // ANDs in $f's further narrowing (item 162) — same idea, one more gate.
  const touches = extended
    ? extModTouches(g, inst.modInvert, inst.modF, inst.modStepIndex, i0)
    : modTouches(g, inst.modInvert, i0);
  if (!g.live || !touches) {
    return (poolByte(eng, voice, inst, i0, binMax, basePtr, ls, le) - 127.5) / 127.5;
  }
  // ONE operation is live at a time, so an address transform and an INVERT/SUB
  // value transform never meet.
  const i = extended ? modAddressExt(g, i0, inst) : modAddress(g, i0, inst.modRot, inst.modScatter, inst.modSeed);
  let b = poolByte(eng, voice, inst, i, binMax, basePtr, ls, le);
  if (extended) {
    // $101/$11x (invert, invertJit) accumulate through the SAME modMask
    // toggleModBit already fills for the classic form — applyExtLevel only
    // knows about the OTHER extended level kinds (sub/add, xor, bit-rotate,
    // bit-permute) and never reads the mask, so without this the state kept
    // toggling correctly (samples.js's overlay, which reads modMask
    // directly, showed it right) while playback never heard it at all.
    if (inst.modMask !== null) { if (inst.modBit(i)) b ^= 0xff; }
    b = applyExtLevel(inst, b);
  } else if (inst.modMask !== null) { if (inst.modBit(i)) b = b ^ 0xff; }
  else if (inst.modSub !== 0) b = (b - inst.modSub) & 0xff;
  if (voice.modXfade > 0) {
    // Anti-click crossfade (item 153.5): the mapping the last step replaced,
    // read through the same geometry, mixed in on a falling weight. Costs one
    // extra pool read per tap for 2 ms after each step. Extended mode's
    // address-transform kinds (rol/jump/scatter) reuse the same modPrevRot/
    // modPrevScatter/modPrevSeed fields the classic path snapshots, so this
    // read is unchanged; its own level-transform kinds (sub/add, xor) read
    // applyExtLevelPrev instead. The kinds that don't get a crossfade (bit
    // rotate, bit permutation, mirror, swap, invert) never arm voice.modXfade
    // in the first place, so this block simply never runs for them.
    // Only rot/scatter kinds (classic or extended) ever arm the crossfade, and
    // both share modPrevRot/modPrevScatter/modPrevSeed, so one formula covers
    // both sides regardless of `extended`.
    const j = modAddress(g, i0, inst.modPrevRot, inst.modPrevScatter, inst.modPrevSeed);
    let p = poolByte(eng, voice, inst, j, binMax, basePtr, ls, le);
    if (extended) p = applyExtLevelPrev(inst, p);
    else if (inst.modMask !== null) { if (inst.modBit(j)) p = p ^ 0xff; }
    else if (inst.modPrevSub !== 0) p = (p - inst.modPrevSub) & 0xff;
    const w = voice.modXfade / MOD_XFADE_SAMPLES;
    b = p * w + b * (1.0 - w);
  }
  return (b - 127.5) / 127.5;
}

/**
 * Promote a [-1,1] PCM sample to the SNES DSP's signed 15-bit domain
 * (-4000h..+3FFFh). The gaussian's four coefficients sum to ~800h while every
 * tap is only SAR 10, so the running sum sits at ~2x the sample and stays
 * inside int16 ONLY while the input is 15-bit — feed the DSP 16-bit samples and
 * the mid-sum wrap fires on everything past half scale, folding loud waveforms
 * inside out instead of chirping on the rare hardware case. -1.0 must map to
 * exactly -16384, which is what arms the documented 801h overflow (three
 * max-negative samples read back as +3FF8h).
 */
function pcmTo15Bit(x) {
  return Math.min(Math.round(x * 16384.0), 16383);
}

/**
 * Interpolate ONE channel at the voice's current position WITHOUT advancing it.
 * `basePtr` selects the channel's pool span and `st` its DPCM counter (the
 * Voice itself for channel 1, voice.right for a stereo right channel).
 */
function interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st) {
  const i0 = Math.min(Math.max(Math.trunc(voice.samplePos), 0), sampleLen - 1);
  const frac = voice.samplePos - i0;
  // Whether the reads reduce to the plain pool fetch is a property of the
  // (voice, instrument) pair, not of the tap — so it is decided ONCE here and
  // the tap loop below reads the pool straight out. Every branch this hoists
  // used to be re-walked seven times per output sample per channel.
  const plain = plainFetchOnly(voice, inst);

  switch (interpMode) {
    case INTERP_DEFAULT: {
      let acc = 0.0;
      if (plain) {
        // Interior kernel: when the whole 2·SINC_WIDTH+1 window sits inside
        // both the sample and the pool, every clamp poolPoint would apply is
        // the identity, so the taps become plain indexed loads off one base.
        // That is the case for all but the first and last few frames of a
        // sample, which is to say almost always.
        const base = basePtr + i0;
        if (i0 >= SINC_WIDTH && i0 + SINC_WIDTH <= sampleLen - 1 && base + SINC_WIDTH <= binMax) {
          const bin = eng.sampleBin;
          for (let j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
            const coeff = sincTap(frac, j);
            if (coeff !== 0.0) acc += ((bin[base + j] - 127.5) / 127.5) * coeff;
          }
          return acc;
        }
        for (let j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
          const coeff = sincTap(frac, j);
          if (coeff !== 0.0) acc += poolPoint(eng, sampleLen, binMax, basePtr, i0 + j) * coeff;
        }
        return acc;
      }
      for (let j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
        const coeff = sincTap(frac, j);
        if (coeff !== 0.0) acc += readSamplePoint(eng, voice, inst, i0 + j, sampleLen, binMax, basePtr) * coeff;
      }
      return acc;
    }
    case INTERP_SNES: {
      // SNES BRR 4-tap gaussian, with the hardware's partial overflow handling
      // preserved: of the three additions the 2nd WRAPS (the gauss "chirp") and
      // only the 3rd saturates (fullsnes §snesapudspbrrpitch).
      const oldest = pcmTo15Bit(plain ? poolPoint(eng, sampleLen, binMax, basePtr, i0 - 1)
        : readSamplePoint(eng, voice, inst, i0 - 1, sampleLen, binMax, basePtr));
      const olders = pcmTo15Bit(plain ? poolPoint(eng, sampleLen, binMax, basePtr, i0)
        : readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr));
      const olds = pcmTo15Bit(plain ? poolPoint(eng, sampleLen, binMax, basePtr, i0 + 1)
        : readSamplePoint(eng, voice, inst, i0 + 1, sampleLen, binMax, basePtr));
      const news = pcmTo15Bit(plain ? poolPoint(eng, sampleLen, binMax, basePtr, i0 + 2)
        : readSamplePoint(eng, voice, inst, i0 + 2, sampleLen, binMax, basePtr));
      const offset = Math.min(Math.max(Math.trunc(frac * 256.0), 0), 255);
      let out = (SNES_GAUSS[0xff - offset] * oldest) >> 10;
      out += (SNES_GAUSS[0x1ff - offset] * olders) >> 10;   // 1st add: cannot overflow
      out += (SNES_GAUSS[0x100 + offset] * olds) >> 10;     // 2nd add: overflows for i<0x20…
      out = (out << 16) >> 16;                              // …and the hardware lets it wrap
      out += (SNES_GAUSS[offset] * news) >> 10;             // 3rd add: saturated, not wrapped
      out = Math.min(Math.max(out, -32768), 32767);
      return (out >> 1) / 16384.0;
    }
    case INTERP_NES_DPCM: {
      // NES 2A03 DMC 1-bit sigma-delta simulation (±2 slew on a 7-bit counter).
      const target = plain ? poolPoint(eng, sampleLen, binMax, basePtr, i0)
        : readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
      const targetLevel = Math.min(Math.max(Math.trunc((target + 1.0) * 63.5), 0), 127);
      if (targetLevel > st.nesDpcmCounter && st.nesDpcmCounter <= 125) {
        st.nesDpcmCounter += 2;
      } else if (targetLevel < st.nesDpcmCounter && st.nesDpcmCounter >= 2) {
        st.nesDpcmCounter -= 2;
      }
      return (st.nesDpcmCounter - 63.5) / 63.5;
    }
    case INTERP_NONE:
    case INTERP_A500:
    case INTERP_A1200:
    default:
      // Paula-style ZOH; aliasing removed by the post-mix Amiga LPFs.
      return plain ? poolPoint(eng, sampleLen, binMax, basePtr, i0)
        : readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
  }
}

/**
 * Anti-click crossfade for funk repeat's hop (item 163.2), the same idea as the
 * sample modifications' (§8.5) and there for the same reason: the restart that
 * installs a walked window jumps the read into a part of the sample that has
 * nothing to do with the one just playing, and a step discontinuity between two
 * output samples is a click — one per hop, up to one per tick at `$xx = $80`.
 *
 * Latching at the loop restart (which is what Paula did) removes the click a
 * MID-BLOCK move would make; it does nothing about the seam itself, because a
 * loop point is only continuous when someone chose it to be and the walk lands
 * where the arithmetic says. So the seam is crossfaded: for `funkXfade` output
 * samples the voice also reads through the window the hop replaced — the SAME
 * position offset back by `funkXfadeOffset`, which is what "the previous
 * mapping" means here — and the two are mixed on a falling weight.
 *
 * The window is capped at one grain (`loopLen / rate` output samples), so a
 * crossfade always finishes before the restart that would re-arm it: on the
 * short loops this effect is written for — ProTracker's manual says $10, $20,
 * $40, $80 bytes — a fixed 2 ms would span several grains and smear the walk
 * into a comb filter instead of smoothing it.
 */
const FUNK_XFADE_SAMPLES = 64;

/** Arm the seam crossfade. `offset` is (old window − new window) in bytes, so
 *  the ghost read is just `samplePos + offset`, and 0 (the window did not move)
 *  arms nothing — an ordinary loop wrap must sound exactly as it always has. */
function armFunkXfade(voice, offset, windowLen) {
  if (offset === 0) return;
  const rate = Math.abs(voice.currentPlaybackRate);
  const grain = rate > 0 ? Math.floor(windowLen / rate) : FUNK_XFADE_SAMPLES;
  const len = Math.min(FUNK_XFADE_SAMPLES, Math.max(1, grain));
  voice.funkXfade = len;
  voice.funkXfadeLen = len;
  voice.funkXfadeOffset = offset;
}

/** Same seam crossfade as `armFunkXfade`, on extended $102/$12x's own
 *  independent window (`voice.modFunkWindow`/`modFunkXfade*`) — a separate
 *  ghost channel because the two commands "do not share state"
 *  (TAUD_NOTE_EFFECTS.md) and can be live on one voice at once. */
function armModFunkXfade(voice, offset, windowLen) {
  if (offset === 0) return;
  const rate = Math.abs(voice.currentPlaybackRate);
  const grain = rate > 0 ? Math.floor(windowLen / rate) : FUNK_XFADE_SAMPLES;
  const len = Math.min(FUNK_XFADE_SAMPLES, Math.max(1, grain));
  voice.modFunkXfade = len;
  voice.modFunkXfadeLen = len;
  voice.modFunkXfadeOffset = offset;
}

/**
 * One channel read through the window the hop replaced. The position is the
 * live one shifted back, so it follows the voice's own rate and direction for
 * free; the DPCM slew counter is saved and restored because the ghost must not
 * advance the state the real trajectory is keeping.
 */
function funkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st) {
  const keepPos = voice.samplePos;
  const keepDpcm = st.nesDpcmCounter;
  voice.samplePos = keepPos + voice.funkXfadeOffset;
  const g = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st);
  voice.samplePos = keepPos;
  st.nesDpcmCounter = keepDpcm;
  return g;
}

/** `funkGhostChannel`, reading through extended $102/$12x's own
 *  `modFunkXfadeOffset` instead of Z's `funkXfadeOffset`. */
function modFunkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st) {
  const keepPos = voice.samplePos;
  const keepDpcm = st.nesDpcmCounter;
  voice.samplePos = keepPos + voice.modFunkXfadeOffset;
  const g = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st);
  voice.samplePos = keepPos;
  st.nesDpcmCounter = keepDpcm;
  return g;
}

/**
 * Fetch BOTH channels of a stereo voice at one position, then advance once —
 * the pair is one sample of one voice, so pitch, loop wrapping and the
 * sample-end ramp are shared. Writes [ch1, ch2] into `out` (a length-2 array
 * the mixer recycles). Channel meaning is the patch's chanMode: discrete L,R
 * or matrix M,S (the mixer decodes).
 */
function fetchTrackerSampleStereo(eng, voice, inst, interpMode, out) {
  if (inst.index === 0) { out[0] = 0.0; out[1] = 0.0; return out; }
  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const binMax = SAMPLE_BIN_TOTAL - 1;
  out[0] = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeSamplePtr, voice);
  out[1] = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeChanPtr2, voice.right);
  if (voice.funkXfade > 0) {
    // One weight per output sample, shared by both channels — the crossfade of
    // the two windows is then exactly the crossfade of the two signals.
    const w = voice.funkXfade / voice.funkXfadeLen;
    out[0] = funkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax,
      voice.activeSamplePtr, voice) * w + out[0] * (1.0 - w);
    out[1] = funkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax,
      voice.activeChanPtr2, voice.right) * w + out[1] * (1.0 - w);
    voice.funkXfade--;
  }
  if (voice.modFunkXfade > 0) {
    const w = voice.modFunkXfade / voice.modFunkXfadeLen;
    out[0] = modFunkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax,
      voice.activeSamplePtr, voice) * w + out[0] * (1.0 - w);
    out[1] = modFunkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax,
      voice.activeChanPtr2, voice.right) * w + out[1] * (1.0 - w);
    voice.modFunkXfade--;
  }
  if (voice.modXfade > 0) voice.modXfade--;
  if (voice.rampOutSamples <= 0) advanceSamplePos(voice, inst, sampleLen);
  return out;
}

/**
 * The read position a phase-modulated fetch (item 159) lands on: the voice's
 * own position displaced by `offset` FRAMES and folded back into the waveform.
 *
 * Folding is what makes the displacement a PHASE. A looping voice wraps into
 * its loop, so a modulator big enough to sweep several cycles keeps sweeping
 * them instead of running off the end of the sample and clamping to a constant
 * — which is the difference between FM and a click. A one-shot has no cycle to
 * wrap into, so it clamps.
 */
function wrapReadPos(voice, pos, sampleLen) {
  const mode = voice.activeLoopMode & 3;
  const ls = voice.activeSampleLoopStart;
  const le = voice.activeSampleLoopEnd;
  if ((mode === 1 || mode === 2) && le > ls) {
    const span = le - ls;
    let p = (pos - ls) % span;
    if (p < 0) p += span;
    return ls + p;
  }
  return Math.min(Math.max(pos, 0), sampleLen - 1);
}

/**
 * `posOffset` (item 159) displaces the READ without touching the trajectory:
 * the sample is taken `posOffset` frames away from where the voice is, and the
 * voice then advances from where it actually was. That separation is the whole
 * of phase modulation — the carrier keeps its own pitch, and the modulator only
 * says where in the waveform this one output sample is drawn from.
 *
 * It defaults to 0, which restores the position, the branch and the arithmetic
 * exactly as they were: an ordinary voice fetches bit-for-bit as it always has.
 */
function fetchTrackerSample(eng, voice, inst, interpMode, posOffset = 0) {
  if (inst.index === 0) return 0.0;

  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const binMax = SAMPLE_BIN_TOTAL - 1;
  const keepPos = voice.samplePos;
  if (posOffset !== 0) voice.samplePos = wrapReadPos(voice, keepPos + posOffset, sampleLen);
  let sample = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeSamplePtr, voice);
  if (voice.funkXfade > 0) {
    const w = voice.funkXfade / voice.funkXfadeLen;
    sample = funkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax,
      voice.activeSamplePtr, voice) * w + sample * (1.0 - w);
    voice.funkXfade--;
  }
  if (voice.modFunkXfade > 0) {
    const w = voice.modFunkXfade / voice.modFunkXfadeLen;
    sample = modFunkGhostChannel(eng, voice, inst, interpMode, sampleLen, binMax,
      voice.activeSamplePtr, voice) * w + sample * (1.0 - w);
    voice.modFunkXfade--;
  }
  if (posOffset !== 0) voice.samplePos = keepPos;

  // The crossfades run on the OUTPUT clock, once per sample however many taps
  // read through them, and keep running while the voice ramps out.
  if (voice.modXfade > 0) voice.modXfade--;
  // While ramping out at sample end, hold position (mixer emits with decaying gain).
  if (voice.rampOutSamples > 0) return sample;
  advanceSamplePos(voice, inst, sampleLen);
  return sample;
}

/**
 * Step samplePos by the playback rate and apply the loop/end rules.
 *
 * Funk repeat (Z $F0xx, item 161) is the one thing that can move the loop out
 * from under the position: its walk carries a window of the loop's own length
 * through the sample, and the window becomes the loop the voice sounds. The
 * window only changes where the HARDWARE changed it — Paula latches the repeat
 * pointer when the loop restarts, so the block being played always finishes
 * first. Until the walk has stepped once (`funkPos < 0`) this is the same
 * arithmetic on the same numbers it has always been.
 *
 * Extended `2`/`3 $102`/`$12x` (item 173 follow-up) is the SAME trick on its
 * own independent window (`voice.modFunkWindow`/`inst.modFunkWalk`/
 * `modFunkPos`) — "walks the region the way `Z $Ffxx` walks a loop"
 * (TAUD_NOTE_EFFECTS.md): the resolved region (`inst.modFunkLen`, stashed by
 * tick.js's stepExtendedModOnce, since re-resolving modGeom here on every
 * output sample would be wasteful) is the hop, and the physical sample —
 * not the region — is where it may land, exactly like Z searching past its
 * own declared loop for room. The two commands "do not share state"
 * (TAUD_NOTE_EFFECTS.md's implementation notes) — they are independent
 * windows, so when both are live on one voice the extended one (this note's
 * own row) is what the voice actually sounds; Z's own walk keeps running
 * underneath, ready the moment the row's `2`/`3` stops overriding it.
 */
function advanceSamplePos(voice, inst, sampleLen) {
  // An NNA ghost inherits the window without inheriting the walk, so either
  // half of the pair on its own means the voice is sounding a moved loop.
  const zWindowed = voice.funkPos >= 0 || voice.funkWindow >= 0;
  const zLoopStart = voice.funkWindow >= 0 ? voice.funkWindow : voice.activeSampleLoopStart;
  const zLoopEnd = zWindowed
    ? zLoopStart + Math.max(voice.activeSampleLoopEnd - voice.activeSampleLoopStart, 1.0)
    : Math.max(voice.activeSampleLoopEnd, 1.0);

  const extFunkLive = isExtFunkOp(inst.modOpExt);
  const extWindowed = extFunkLive && (inst.modFunkPos >= 0 || voice.modFunkWindow >= 0);
  const extLoopStart = extWindowed && voice.modFunkWindow >= 0
    ? voice.modFunkWindow : voice.activeSampleLoopStart;
  const extLoopEnd = extWindowed
    ? extLoopStart + Math.max(inst.modFunkLen, 1.0)
    : zLoopEnd;

  const loopStart = extWindowed ? extLoopStart : zLoopStart;
  const loopEnd = extWindowed ? extLoopEnd : zLoopEnd;
  if (voice.forward) {
    voice.samplePos += voice.currentPlaybackRate;
    // Sustain bit set + key-off ⇒ escape the loop (loopMode 0 semantics).
    const effectiveLoopMode =
      voice.activeSampleLoopSustain && voice.keyOff ? 0 : voice.activeLoopMode & 3;
    switch (effectiveLoopMode) {
      case 0:
        if (voice.samplePos >= sampleLen) {
          voice.samplePos = Math.max(sampleLen - 1, 0.0);
          startRampOut(voice);
        }
        break;
      case 1:
        if (voice.samplePos >= loopEnd) {
          const overshoot = voice.samplePos - loopEnd;
          if (extWindowed) {
            // The restart is where the walk's pointer has got to by now, and
            // the seam it opens is crossfaded (item 163.2), on this command's
            // OWN ghost channel.
            const prevWindow = extLoopStart;
            if (inst.modFunkPos >= 0) voice.modFunkWindow = inst.modFunkPos;
            armModFunkXfade(voice, prevWindow - voice.modFunkWindow, loopEnd - loopStart);
            voice.samplePos = voice.modFunkWindow + overshoot;
          } else if (zWindowed) {
            const prevWindow = zLoopStart;
            if (voice.funkPos >= 0) voice.funkWindow = voice.funkPos;
            armFunkXfade(voice, prevWindow - voice.funkWindow, loopEnd - loopStart);
            voice.samplePos = voice.funkWindow + overshoot;
          } else {
            voice.samplePos -= Math.max(loopEnd - loopStart, 1.0);
          }
        }
        break;
      case 2:
        // Ping-pong latches on the way UP (below), so one down-and-back counts
        // as the single loop iteration it sounds like.
        if (voice.samplePos >= loopEnd) { voice.samplePos = loopEnd; voice.forward = false; }
        break;
      case 3:
        if (voice.samplePos >= sampleLen) {
          voice.samplePos = Math.max(sampleLen - 1, 0.0);
          startRampOut(voice);
        }
        break;
    }
  } else {
    voice.samplePos -= voice.currentPlaybackRate;
    if (voice.samplePos < loopStart) {
      if (extWindowed) {
        const prevWindow = extLoopStart;
        if (inst.modFunkPos >= 0) voice.modFunkWindow = inst.modFunkPos;
        armModFunkXfade(voice, prevWindow - voice.modFunkWindow, loopEnd - loopStart);
        voice.samplePos = voice.modFunkWindow;
      } else if (zWindowed) {
        const prevWindow = zLoopStart;
        if (voice.funkPos >= 0) voice.funkWindow = voice.funkPos;
        armFunkXfade(voice, prevWindow - voice.funkWindow, loopEnd - loopStart);
        voice.samplePos = voice.funkWindow;
      } else {
        voice.samplePos = loopStart;
      }
      voice.forward = true;
    }
  }
}

/** Engage a linear ramp to silence over `samples`, and stop there. No-op if one
 *  is already running — a voice that is already fading does not restart. */
function beginRampOut(voice, samples) {
  if (voice.rampOutSamples > 0) return;
  voice.rampOutSamples = samples;
  voice.rampOutGain = 1.0;
  voice.rampOutStep = 1.0 / samples;
}

/** Engage the MilkyTracker-style sample-end ramp (no-op if already ramping). */
function startRampOut(voice) {
  beginRampOut(voice, RAMP_OUT_SAMPLES);
}

/**
 * Note-cut ramp (note word 0x0002, and S $Dxny's $n=1). A cut used to drop
 * `active` on the spot, so a cut landing mid-cycle stepped straight to zero and
 * clicked — audible on anything with body to it.
 *
 * The ramp is the ATTACK one's 32 samples (~0.67 ms at 48 kHz), not the 8 ms
 * sample-end ramp: a cut is a rhythmic event, often on a fast row, and 8 ms
 * would round off the very transient the cut is being used to place. Short
 * enough to still read as a cut, long enough to have no edge in it.
 *
 * Note the sample position FREEZES while ramping (see the caller of
 * advanceSamplePos), so this is the last sample held and faded rather than
 * playback continuing under a fade — which is what the sample-end ramp does
 * too, and over 32 samples the difference is inaudible.
 */
function startCutRamp(voice) {
  beginRampOut(voice, ATTACK_RAMP_SAMPLES);
}

/** Fast note-fade (note word 0x0004 — SF2 exclusiveClass choke, ≈0.3 s). */
function startFastFade(voice, playhead) {
  if (!voice.active) return;
  voice.noteFading = true;
  const ticks = Math.max(FAST_FADE_SEC * playhead.bpm * 0.4, 1.0);
  voice.activeFadeoutStep = Math.min(Math.max(Math.round(1024.0 / ticks), 1), 0xfff);
}

/**
 * How many samples the glide to a new pitch may take, out of a tick's `spt`
 * (item 144).
 *
 * A whole tick is right for a CONTROL move and wrong for an EVENT. A vibrato or
 * an ordinary slide walks the pitch by a cent or two per tick, and spreading
 * that across the tick is the entire point of the glide; an arpeggio step, a
 * fast tone portamento arriving, a big pitch slide are somewhere else NOW, and
 * bending 2 semitones over a tick's 20 ms is heard as a bend — three of those
 * and a row of quick portamento notes has become one continuous swoop.
 *
 * The two are told apart by how far the pitch has to move, on a budget of
 * (interval × time): PITCH_GLIDE_FULL_RATIO (25 cents) gets the whole tick,
 * twice that gets half of one, and so on down to the attack ramp's ~⅔ ms — long
 * enough to round off the corner, far too short to hear as pitch movement.
 * Being a curve rather than a threshold, a slide that speeds up shortens its
 * glide smoothly instead of snapping between two behaviours mid-slide.
 *
 * The interval is the frequency ratio's excess over unity, taken the way up
 * whichever way it goes, so that a fall and the rise back cost the same.
 */
function pitchGlideSamples(cur, target, spt) {
  const tick = spt >= 1 ? Math.round(spt) : 1;
  // Both rates are positive by construction (computePlaybackRate is a product of
  // positive terms); a zero would only come from a malformed sample header, and
  // there is no ratio to glide along then.
  if (!(cur > 0.0) || !(target > 0.0)) return 1;
  const up = target / cur;
  const down = cur / target;
  const interval = (up > down ? up : down) - 1.0;
  if (interval <= PITCH_GLIDE_FULL_RATIO) return tick;
  const n = Math.round((tick * PITCH_GLIDE_FULL_RATIO) / interval);
  const floor = ATTACK_RAMP_SAMPLES < tick ? ATTACK_RAMP_SAMPLES : tick;
  return n < floor ? floor : n;
}

/**
 * Per-sample pitch glide toward the tick's playbackRate, so the control signal
 * is INTERPOLATED rather than stepped. A fresh trigger snaps: a new note starts
 * at its own pitch, it does not bend up from whatever the channel was last
 * playing.
 */
function advancePitchRamp(voice, spt) {
  const target = voice.playbackRate;
  if (voice.snapPlaybackRate) {
    voice.currentPlaybackRate = target;
    voice.pitchRampSamples = 0;
    voice.pitchRampStep = 0.0;
    voice.snapPlaybackRate = false;
    return;
  }
  if (voice.pitchRampSamples > 0) {
    voice.currentPlaybackRate += voice.pitchRampStep;
    voice.pitchRampSamples--;
    if (voice.pitchRampSamples === 0) voice.currentPlaybackRate = target;
  } else if (voice.currentPlaybackRate !== target) {
    const n = pitchGlideSamples(voice.currentPlaybackRate, target, spt);
    if (n <= 1) {
      voice.currentPlaybackRate = target;
      voice.pitchRampSamples = 0;
      voice.pitchRampStep = 0.0;
    } else {
      voice.pitchRampStep = (target - voice.currentPlaybackRate) / n;
      voice.pitchRampSamples = n - 1;
      voice.currentPlaybackRate += voice.pitchRampStep;
    }
  }
}

/**
 * Per-sample pan ramp toward `target` (0..255), the sibling of the volume ramp
 * and over the same 2 ms. Ramping the PAN rather than the two gains means one
 * ramp covers everything that moves it — the slide, the panbrello, the pan
 * envelope, the pan column and S $80xx all feed this one number.
 *
 * Returns the value to use this sample.
 */
function advancePanRamp(voice, target, wrap = false) {
  // A surround azimuth WRAPS at AZIMUTH_TURN (512 units, the 9-bit S $8xxx
  // circle — NOT the stereo pan's 256): ramping 500 -> 12 the arithmetic way
  // would sweep the long way round the whole circle. Take the short way.
  if (wrap && !voice.snapPan) {
    const d = target - voice.currentPan;
    if (d > 256) voice.currentPan += 512;
    else if (d < -256) voice.currentPan -= 512;
  }
  if (voice.snapPan) {
    voice.currentPan = target;
    voice.panRampSamples = 0;
    voice.panRampStep = 0.0;
    voice.snapPan = false;
    return target;
  }
  if (voice.panRampSamples > 0) {
    voice.currentPan += voice.panRampStep;
    voice.panRampSamples--;
    if (voice.panRampSamples === 0) voice.currentPan = target;
  } else if (voice.currentPan !== target) {
    voice.panRampStep = (target - voice.currentPan) / VOL_RAMP_SAMPLES;
    voice.panRampSamples = VOL_RAMP_SAMPLES - 1;
    voice.currentPan += voice.panRampStep;
  }
  if (wrap) {
    if (voice.currentPan < 0) voice.currentPan += 512;
    else if (voice.currentPan >= 512) voice.currentPan -= 512;
  }
  return voice.currentPan;
}

/** Per-sample volume-ramp tick toward (rowVolume/max)·(channelVolume/max).
 *  `div` is the volume column's ceiling: 63 as ever, 255 for a wide cell. */
function advanceVolumeRamp(voice, div = 63.0) {
  const target = (voice.rowVolume / div) * (voice.channelVolume / div);
  if (voice.snapMixVolume) {
    voice.currentMixVolume = target;
    voice.volRampSamples = 0;
    voice.volRampStep = 0.0;
    voice.snapMixVolume = false;
    return;
  }
  if (voice.volRampSamples > 0) {
    voice.currentMixVolume += voice.volRampStep;
    voice.volRampSamples--;
    if (voice.volRampSamples === 0) voice.currentMixVolume = target;
  } else if (voice.currentMixVolume !== target) {
    voice.volRampStep = (target - voice.currentMixVolume) / VOL_RAMP_SAMPLES;
    voice.volRampSamples = VOL_RAMP_SAMPLES - 1;
    voice.currentMixVolume += voice.volRampStep;
  }
}

// ══ src/engine/filter.js ══
// Per-voice filters + Taud voice FX — port of AudioAdapter.kt refreshVoiceFilter
// (2001), applyVoiceFilter (2071), applyTaudVoiceFx (2101), clipSample (2141).
//
// TWO topologies, both mandatory:
//  - IT/tracker path: all-pole 2-pole resonant LPF (reference_materials/
//    tracker_filter/) — NO feedforward terms; byte-faithful for tracker playback.
//  - filterSfMode path: FluidSynth's RBJ biquad (reference_materials/fluidsynth/)
//    with cents→Hz cutoff, −3.01 dB Butterworth Q offset and 1/√Q gain-norm.


/** Recompute filter coefficients when cutoff/resonance changed since last refresh. */
function refreshVoiceFilter(voice) {
  const cut = voice.currentCutoff;
  const res = voice.currentResonance;
  if (cut === voice.filterCutoffCached && res === voice.filterResonanceCached) return;
  voice.filterCutoffCached = cut;
  voice.filterResonanceCached = res;

  const nyquist = SAMPLING_RATE * 0.5 - 1.0;
  if (voice.filterSfMode) {
    // SoundFont mode: cutoff = absolute cents, resonance = centibels above DC gain.
    if (cut >= 0xffff) { voice.filterActive = false; return; }
    const fres = Math.min(Math.max(8.176 * 2 ** (cut / 1200.0), 5.0), 0.45 * SAMPLING_RATE);

    // SF2 Q (cB) → linear, with FluidSynth's −3.01 dB offset (Q=0 cB ⇒ Butterworth).
    const qcb = res >= 0xffff ? 0 : res;
    const qDb = Math.min(Math.max(qcb / 10.0, 0.0), 96.0) - 3.01;
    const qLin = Math.max(10 ** (qDb / 20.0), 0.001);

    // RBJ cookbook low-pass, normalised to a0; SF2 §2.01 p.59 1/√Q gain-norm.
    const omega = (2.0 * Math.PI * fres) / SAMPLING_RATE;
    const sinC = Math.sin(omega);
    const cosC = Math.cos(omega);
    const alpha = sinC / (2.0 * qLin);
    const a0inv = 1.0 / (1.0 + alpha);
    const gain = a0inv / Math.sqrt(qLin);
    voice.filterBqB1 = (1.0 - cosC) * gain;
    voice.filterBqB02 = voice.filterBqB1 * 0.5;
    voice.filterBqA1 = -2.0 * cosC * a0inv;
    voice.filterBqA2 = (1.0 - alpha) * a0inv;
    voice.filterIsBiquad = true;
    voice.filterActive = true;
    return;
  }

  if (Math.min(Math.max(cut, 0), 255) >= 255) { voice.filterActive = false; return; }
  const itCutoff = Math.min(Math.max(cut, 0), 254) * 0.5; // 0..127
  const itResonance = res >= 255 ? 0.0 : Math.min(Math.max(res, 0), 254) * 0.5;
  const frequency = Math.min(110.0 * 2 ** (itCutoff / 24.0 + 0.25), nyquist);
  const dmpfac = 10 ** ((-itResonance * (24.0 / 128.0)) / 20.0);

  const r = SAMPLING_RATE / (2.0 * Math.PI * frequency);
  const d = dmpfac * r + dmpfac - 1.0;
  const e = r * r;
  const denom = 1.0 + d + e;

  voice.filterA0 = 1.0 / denom;
  voice.filterB0 = (d + e + e) / denom;
  voice.filterB1 = -e / denom;
  voice.filterIsBiquad = false;
  voice.filterActive = true;
}

/**
 * Apply the cached voice low-pass to one sample. Coefficients come from the
 * voice; the delay line comes from `st`, which is the voice itself for a mono
 * voice (or a stereo pair's first channel) and voice.right for the second
 * channel of a stereo pair — same coefficients, independent history.
 */
function applyVoiceFilter(voice, x0, st = voice) {
  if (!voice.filterActive) return x0;
  if (voice.filterIsBiquad) {
    // FluidSynth RBJ biquad, Direct Form I (unclamped — the SF2 gain-norm bounds it).
    const y0 = voice.filterBqB02 * (x0 + st.filterX2) +
               voice.filterBqB1 * st.filterX1 -
               voice.filterBqA1 * st.filterY1 -
               voice.filterBqA2 * st.filterY2;
    st.filterX2 = st.filterX1;
    st.filterX1 = x0;
    st.filterY2 = st.filterY1;
    st.filterY1 = y0;
    return y0;
  }
  // IT all-pole recurrence; history taps clipped ±2.0 (OpenMPT ClipFilter).
  const y1Clipped = Math.min(Math.max(st.filterY1, -2.0), 2.0);
  const y2Clipped = Math.min(Math.max(st.filterY2, -2.0), 2.0);
  const y0 = voice.filterA0 * x0 + voice.filterB0 * y1Clipped + voice.filterB1 * y2Clipped;
  st.filterY2 = st.filterY1;
  st.filterY1 = y0;
  return y0;
}

/** Shared clipper for effects 8/9: 0 clamp, 1 fold (triangle), 2 wrap (sawtooth). */
function clipSample(x, mode) {
  switch (mode & 3) {
    case 1: {
      let v = x;
      while (v > 1.0) v = 2.0 - v;
      while (v < -1.0) v = -2.0 - v;
      return v;
    }
    case 2: {
      let v = (x + 1.0) % 2.0;
      if (v < 0.0) v += 2.0;
      return v - 1.0;
    }
    default:
      return Math.min(Math.max(x, -1.0), 1.0);
  }
}

/** Overdrive (9) → shared clipper → bitcrusher (8): per output sample, per voice.
 *  `st` holds the crusher's hold/counter state (voice.right for a stereo pair's
 *  second channel) — the parameters themselves are always the voice's. */
function applyTaudVoiceFx(voice, sample, st = voice) {
  let s = sample;
  const overdriveOn = voice.overdriveAmp > 0;
  const depthQuantises = voice.bitcrusherDepth >= 1 && voice.bitcrusherDepth <= 7;
  const skipActive = voice.bitcrusherSkip > 0;
  const crushActive = depthQuantises || skipActive;

  if (overdriveOn) {
    s *= (16 + voice.overdriveAmp) / 16.0;
    s = clipSample(s, voice.clipMode);
  }

  if (crushActive) {
    if (st.bitcrusherCounter === 0) {
      if (depthQuantises) {
        const levels = (1 << voice.bitcrusherDepth) - 1;
        const clipped = Math.min(Math.max(clipSample(s, voice.clipMode), -1.0), 1.0);
        const q = Math.min(Math.max(Math.floor((clipped + 1.0) * 0.5 * levels + 0.5), 0.0), levels);
        s = (q / levels) * 2.0 - 1.0;
      }
      st.bitcrusherHeld = s;
    } else {
      s = st.bitcrusherHeld;
    }
    if (skipActive) {
      st.bitcrusherCounter = (st.bitcrusherCounter + 1) % (voice.bitcrusherSkip + 1);
    } else {
      st.bitcrusherCounter = 0;
    }
  }
  return s;
}

// ══ src/engine/fm.js ══
// FM operator racks — Metainstrument type 4 (item 159). No Kotlin counterpart
// yet: this is a Microtone-first format extension, specified in
// TAUD_FILE_FORMAT.md §7.6 and TAUD_ENGINE_SPEC.md §5.5.1.
//
// A layered metainstrument (type 0) is `n` instruments sounding side by side.
// A type-4 rack is the opposite arrangement: the same 10-byte table, but its
// entries are OPERATORS that feed each other, and the whole rack is ONE voice.
// The wiring is an RPN program packed into the record's tail, so an algorithm
// is data — there is no fixed set of "algorithm 1…32" to choose from.
//
// The oscillator of a classic FM chip is a sine table. Here it is an ordinary
// Taud instrument: its sample IS the waveform, its loop IS the cycle, and its
// envelope, filter, auto-vibrato and detune all keep working. Modulate a
// single-cycle loop and the result is textbook phase modulation; modulate a
// drum hit and it is something no DX7 could do.






/**
 * The live rack behind one sounding note. Allocated per trigger, hung off the
 * channel's foreground Voice as `voice.fmRig`, and dropped the moment that
 * voice is retriggered with anything else.
 *
 * `voices[0]` is the channel's OWN voice — operator 0 sounds on it, which is
 * what gives the note a lifetime, an envelope and a place in the mix. Operators
 * 1… are background voices flagged `fmOperator`, so the tick pass maintains
 * them like layer children while the mixer leaves them alone: they are read
 * from here, not summed.
 *
 * A null slot is an operator that is not sounding this note — gated out by its
 * rectangle, pointed at nothing, or simply never named by the algorithm — and
 * reads as a constant 0.
 */
class FmRig {
  constructor(count) {
    this.count = count;
    this.voices = new Array(count).fill(null);
    this.gain = new Float64Array(count);   // the mix octet's linear gain
    this.cur = new Float64Array(count);    // this output sample's value
    this.last = new Float64Array(count);   // …and the previous one's, for $08xx
    this.done = new Uint8Array(count);     // evaluated yet, this sample?
    this.program = null;                   // Uint16Array, END already stripped
    this.stack = new Float64Array(FM_STACK_MAX + 2);
  }
}

/**
 * Which operators the algorithm actually reads, as a boolean per slot.
 *
 * Only `$00xx` and `$04xx` count. A `$08xx` feedback tap reads what an operator
 * left behind LAST sample, so it cannot be the thing that makes an operator
 * sound — an operator named by nothing but feedback taps would have to produce
 * the value its own tap then reads, and there is no such value. Naming it
 * anyway is harmless and reads as 0, which is also what the tap of a gated-out
 * operator gives.
 *
 * The point of asking at all is that a rack triggers only the operators it
 * reads: an unread operator costs no voice, no sample fetch and no envelope.
 */
function fmReferencedOperators(program, count) {
  const used = new Uint8Array(count);
  if (program === null) return used;
  for (const w of program) {
    if (w >= FM_WORD_OP) continue;
    const cls = w & ~FM_INDEX_MASK;
    if (cls !== FM_WORD_OSC && cls !== FM_WORD_MOD) continue;
    const k = w & FM_INDEX_MASK;
    if (k < count) used[k] = 1;
  }
  return used;
}

/** Seed a rack's per-operator mix gains from the rack's own table. */
function fmSeedGains(rig, ops) {
  for (let k = 0; k < rig.count && k < ops.length; k++) {
    rig.gain[k] = META_MIX_GAIN[ops[k].mixOctet & 0xff];
  }
}

/**
 * The frame count one unit of modulation is worth for `v` — its CYCLE.
 *
 * A looping operator's cycle is its loop, so a modulator swinging ±1 sweeps the
 * carrier a whole cycle either way and the mix octet reads as an FM index in
 * the ordinary sense (unity = ±1 cycle, +24 dB ≈ ±16). Give the operator a
 * single-cycle loop and that is exactly classic phase modulation. A one-shot
 * has no cycle, so its whole length stands in for one — a modulator at unity
 * scrubs the entire sample, which is the useful reading of "as far as this
 * waveform goes".
 */
function fmCycleFrames(v) {
  const span = v.activeSampleLoopEnd - v.activeSampleLoopStart;
  if ((v.activeLoopMode & 3) !== 0 && span > 0) return span;
  return Math.max(v.activeSampleLength, 1);
}

/**
 * One operator, evaluated at most ONCE per output sample. Naming an operator
 * twice in one algorithm — the natural way to write "operator 5 modulates both
 * 4 and 2" — gives the same value both times, because an operator is one
 * oscillator with one phase and not a function that can be called again.
 *
 * `offset` is the phase modulation in units of the operator's own cycle; 0 is
 * a free-running read.
 */
function fmEvalOperator(eng, ts, rig, k, interpMode, spt, offset) {
  if (rig.done[k] !== 0) return rig.cur[k];
  rig.done[k] = 1;
  const v = rig.voices[k];
  if (v === null || !v.active) { rig.cur[k] = 0.0; return 0.0; }
  const inst = eng.instruments[v.instrumentId];
  const frames = offset === 0 ? 0 : offset * fmCycleFrames(v);
  let s = fetchTrackerSample(eng, v, inst, interpMode, frames);
  let g = rig.gain[k];
  if (k !== 0) {
    // Operator 0 is the channel's own voice: the mixer runs its filter, its
    // envelope and its ramps over the FINISHED signal (§5.5.1), so doing any of
    // that here would apply them twice. Every other operator is invisible to the
    // mixer and gets the same per-sample maintenance here, in the same order.
    s = applyVoiceFilter(v, s);
    v.envVolMix += v.envVolStep;
    const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
    advanceVolumeRamp(v, ts.volDiv);
    advancePitchRamp(v, spt);
    // NOT the note/channel volume, which §5.5.1's list of what an operator's
    // value is multiplied by deliberately omits. A rack is ONE voice: the
    // mixer applies that volume to the finished patch through operator 0, and
    // applying it here as well would put it on the carrier twice and — worse —
    // make an operator's modulation INDEX follow the volume column, so playing
    // a patch quietly would also play it duller. An operator's level is its
    // index; the note's volume belongs to the note.
    g *= effEnvVol * v.fadeoutVolume * v.activeAttenGain *
      (inst.instGlobalVolume / 255.0);
    if (v.rampOutSamples > 0) {
      g *= v.rampOutGain;
      v.rampOutGain -= v.rampOutStep;
      v.rampOutSamples--;
      if (v.rampOutSamples === 0) v.active = false;
    }
    if (v.attackRampSamples > 0) {
      const elapsed = ATTACK_RAMP_SAMPLES - v.attackRampSamples;
      g *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
      v.attackRampSamples--;
    }
  }
  const out = s * g;
  rig.cur[k] = out;
  return out;
}

/**
 * Run the rack's algorithm for one output sample and return the patch's signal.
 *
 * The stack machine is straight-line: every word runs every sample, in order,
 * so there is nothing to schedule and no graph to walk. A modulator is simply
 * an operand that was pushed before the operator it modulates is read — which
 * is what RPN gives for free, and the reason the format stores the algorithm
 * this way rather than as a matrix of "who feeds whom".
 *
 * The program was verified when the record was read (inst.js decodeFmProgram),
 * so the underflow and overflow guards here are the belt to that braces: a rig
 * whose program is null renders silence and never reaches this loop at all.
 */
function renderFmVoice(eng, ts, voice, interpMode, spt) {
  const rig = voice.fmRig;
  const prog = rig.program;
  if (prog === null) return 0.0;
  const stack = rig.stack;
  const done = rig.done;
  done.fill(0);
  let sp = 0;

  for (let i = 0; i < prog.length; i++) {
    const w = prog[i];
    if (w >= FM_WORD_OP) {
      switch (w) {
        case FmOp.ADD:
          if (sp >= 2) { const b = stack[--sp]; stack[sp - 1] += b; }
          break;
        case FmOp.MUL:
          if (sp >= 2) { const b = stack[--sp]; stack[sp - 1] *= b; }
          break;
        case FmOp.NEG:
          if (sp >= 1) stack[sp - 1] = -stack[sp - 1];
          break;
        case FmOp.DUP:
          if (sp >= 1 && sp < FM_STACK_MAX) { stack[sp] = stack[sp - 1]; sp++; }
          break;
        case FmOp.SWAP:
          if (sp >= 2) { const b = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = b; }
          break;
        default:
          break; // reserved: a no-op, so a newer record still makes a sound here
      }
      continue;
    }
    const k = w & FM_INDEX_MASK;
    if (k >= rig.count) continue;
    const cls = w & ~FM_INDEX_MASK;
    if (cls === FM_WORD_FB) {
      if (sp < FM_STACK_MAX) stack[sp++] = rig.last[k];
      continue;
    }
    const offset = cls === FM_WORD_MOD && sp > 0 ? stack[--sp] : 0.0;
    if (sp < FM_STACK_MAX) stack[sp++] = fmEvalOperator(eng, ts, rig, k, interpMode, spt, offset);
  }

  // The z⁻¹ taps move on together, AFTER the whole program: a feedback word
  // reads the previous output sample even when it sits after the operator it
  // taps, which is what lets a rack close a loop on itself in one pass.
  for (let k = 0; k < rig.count; k++) if (done[k] !== 0) rig.last[k] = rig.cur[k];
  return sp > 0 ? stack[sp - 1] : 0.0;
}

/**
 * Detach and silence every operator voice channel `vi` is driving. Called where
 * a layered meta releases its children — but an orphaned operator is not a
 * sound that should be allowed to finish: on its own it is a modulator nobody
 * is reading, so it is cut rather than released.
 */
function dropFmOperators(ts, vi) {
  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (bg.fmOperator && bg.sourceChannel === vi) {
      bg.active = false;
      bg.fmOperator = false;
      bg.isLayerChild = false;
      ts.backgroundVoices.splice(i, 1);
    }
  }
}

// ══ src/engine/envelope.js ══
// Envelope walkers — port of AudioAdapter.kt resolveEnvWrap (1708), envPresent
// (1728), applyKeyLift (1755), advanceEnvelope (1768), advancePfRole (1881),
// seedPfRole (1945), advancePitchEnvelope (1951), advanceFilterEnvelope (1960),
// advanceAutoVibrato (2166).
//
// Envelope point offsets are ThreeFiveMiniUfloat LUT indices; read seconds via
// minifloatToDouble. CRITICAL semantics carried over:
//  - advancePfRole SKIPS zero-duration nodes (instant transitions), stopping at
//    a sustain/loop boundary or maxIdx.
//  - seedPfRole settles the note-on seed past leading zero-duration nodes.
//  - the vol/pan walker (advanceEnvelope) FREEZES on zero-offset nodes — IT
//    terminator semantics — and is NOT seeded that way.




/**
 * Resolve the active wrap region from LOOP and SUSTAIN words + key state.
 * LOOP word: 0b0000_0sss_ssXcb_eeeee; SUSTAIN word: 0b0000_0sss_ss00b_eeeee.
 * bit 5 = enable; bits 12..8 = start, bits 4..0 = end. Priority matches
 * schismtracker player/sndmix.c:480-499. outRange[1] = -1 when no wrap.
 */
function resolveEnvWrap(loopWord, sustainWord, keyOff, outRange) {
  const susB = ((sustainWord >>> 5) & 1) !== 0;
  const loopB = ((loopWord >>> 5) & 1) !== 0;
  if (susB && !keyOff) {
    outRange[0] = (sustainWord >>> 8) & 0x1f;
    outRange[1] = sustainWord & 0x1f;
  } else if (loopB) {
    outRange[0] = (loopWord >>> 8) & 0x1f;
    outRange[1] = loopWord & 0x1f;
  } else {
    outRange[0] = -1;
    outRange[1] = -1;
  }
}

/** Envelope-present test — the P bit at LOOP word bit 13. */
function envPresent(loopWord) {
  return ((loopWord >>> 13) & 1) !== 0;
}

/** Envelope-carry test — the `c` bit at LOOP word bit 6 (item 169.1). A carried
 *  envelope keeps its playhead across a retrigger instead of rewinding to node
 *  0; whether the trigger is ALLOWED to carry is the caller's decision (see
 *  triggerNote), because that depends on the voice, not on the envelope. */
function envCarry(loopWord) {
  return ((loopWord >>> 6) & 1) !== 0;
}

// Reusable scratch (allocation-free per-tick walks; single-threaded per worklet).
const volWrap = new Int32Array(2);
const panWrap = new Int32Array(2);
const pfWrap = new Int32Array(2);
const pfIdxBox = new Int32Array(1);
const pfTimeBox = new Float64Array(1);

/** Jump the volume envelope playhead straight to the sustain-end node, so the
 *  release nodes play immediately instead of walking the remaining pre-sustain
 *  nodes first. The shared core of applyKeyLift (gated) and forceKeyLift
 *  (unconditional). Reads the ACTIVE (patch-or-base) envelope. */
function jumpToSustainEnd(voice) {
  const sus = voice.activeVolEnvSustain;
  if (((sus >>> 5) & 1) === 0) return;
  const susEnd = sus & 0x1f;
  if (voice.envIndex >= susEnd) return;
  voice.envIndex = susEnd;
  voice.envTimeSec = 0.0;
  voice.envVolume = Math.min(Math.max(voice.activeVolEnv[susEnd].value / 63.0, 0.0), 1.0);
}

/**
 * "Key Lift" (instrument flag bit 5): MIDI-exact key release — jump the volume
 * envelope playhead straight to the sustain-end node on key-off so the release
 * nodes play immediately. Applies wherever key-off is delivered: pattern
 * KEY_OFF (0x0001), the NNA ghost spawned on a new note, DCA Note Off, and
 * past-note S $71 (terranmon.txt instrument-flag byte 186).
 */
function applyKeyLift(voice, inst) {
  if (!inst.nnaKeyLift) return;
  jumpToSustainEnd(voice);
}

/** S $Dxny's $n=4 "Key lift" follow-up action (item 94): forces the same
 *  sustain-end jump as applyKeyLift but bypasses the instrument's own Key
 *  Lift flag — a per-note override, same spirit as S $73..$76's per-voice
 *  NNA override. Distinct from $n=0 "Note off", which respects the flag. */
function forceKeyLift(voice) {
  jumpToSustainEnd(voice);
}

/** Volume + pan envelope advance (once per tick). */
function advanceEnvelope(voice, tickSec) {
  const maxIdx = 24;

  // Volume envelope — gated only by voice.volEnvOn; wrap bits gate WRAPPING,
  // not whether the envelope runs (Schism player/sndmix.c:470-502).
  const volEnv = voice.activeVolEnv;
  if (voice.volEnvOn) {
    resolveEnvWrap(voice.activeVolEnvLoop, voice.activeVolEnvSustain, voice.keyOff, volWrap);
    const wStart = volWrap[0];
    const wEnd = volWrap[1];
    const wrapping = wStart >= 0;

    if (wrapping && voice.envIndex === wEnd && wStart === wEnd) {
      // Hold at the wrap point (FT2 single-point sustain).
      voice.envVolume = Math.min(Math.max(volEnv[voice.envIndex].value / 63.0, 0.0), 1.0);
    } else if (wrapping && voice.envIndex === wEnd) {
      voice.envTimeSec = 0.0;
      voice.envIndex = wStart;
      voice.envVolume = Math.min(Math.max(volEnv[voice.envIndex].value / 63.0, 0.0), 1.0);
    } else if (voice.envIndex >= maxIdx) {
      const vEnd = volEnv[maxIdx].value;
      voice.envVolume = Math.min(Math.max(vEnd / 63.0, 0.0), 1.0);
      // Schism's "envelope-end + last-value-0 ⇒ cut" rule — fall-through only.
      if (vEnd === 0 && !wrapping) startRampOut(voice);
    } else {
      const vOffset = minifloatToDouble(volEnv[voice.envIndex].offset);
      const vCurValue = volEnv[voice.envIndex].value;
      if (vOffset === 0.0) {
        // Reached a terminator point — envelope holds here (IT semantics).
        voice.envVolume = Math.min(Math.max(vCurValue / 63.0, 0.0), 1.0);
        if (vCurValue === 0 && !wrapping) startRampOut(voice);
      } else {
        voice.envTimeSec += tickSec;
        if (voice.envTimeSec >= vOffset) {
          voice.envTimeSec -= vOffset;
          const nextIdx = wrapping && voice.envIndex === wEnd
            ? wStart
            : Math.min(voice.envIndex + 1, maxIdx);
          voice.envIndex = nextIdx;
          voice.envVolume = Math.min(Math.max(volEnv[voice.envIndex].value / 63.0, 0.0), 1.0);
        } else {
          const cur = Math.min(Math.max(vCurValue / 63.0, 0.0), 1.0);
          const nxt = Math.min(
            Math.max(volEnv[Math.min(voice.envIndex + 1, maxIdx)].value / 63.0, 0.0), 1.0);
          voice.envVolume = cur + (nxt - cur) * (voice.envTimeSec / vOffset);
        }
      }
    }
  }

  // Pan envelope.
  if (!voice.hasPanEnv || !voice.panEnvOn) return;
  const panEnv = voice.activePanEnv;
  resolveEnvWrap(voice.activePanEnvLoop, voice.activePanEnvSustain, voice.keyOff, panWrap);
  const pStart = panWrap[0];
  const pEnd = panWrap[1];
  const pWrapping = pStart >= 0;

  if (pWrapping && voice.envPanIndex === pEnd && pStart === pEnd) {
    voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
  } else if (pWrapping && voice.envPanIndex === pEnd) {
    voice.envPanTimeSec = 0.0;
    voice.envPanIndex = pStart;
    voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
  } else if (voice.envPanIndex >= maxIdx) {
    voice.envPan = panEnv[maxIdx].value / 255.0;
  } else {
    const pOffset = minifloatToDouble(panEnv[voice.envPanIndex].offset);
    if (pOffset === 0.0) {
      voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
    } else {
      voice.envPanTimeSec += tickSec;
      if (voice.envPanTimeSec >= pOffset) {
        voice.envPanTimeSec -= pOffset;
        const nextIdx = pWrapping && voice.envPanIndex === pEnd
          ? pStart
          : Math.min(voice.envPanIndex + 1, maxIdx);
        voice.envPanIndex = nextIdx;
        voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
      } else {
        const cur = panEnv[voice.envPanIndex].value / 255.0;
        const nxt = panEnv[Math.min(voice.envPanIndex + 1, maxIdx)].value / 255.0;
        voice.envPan = cur + (nxt - cur) * (voice.envPanTimeSec / pOffset);
      }
    }
  }
}

/**
 * Generic 25-node envelope walk shared by pitch and filter envelopes.
 * Returns the new value (0..1, 0.5 = unity); advanced index/time via
 * idxBox[0] / timeBox[0]. MUST skip zero-duration nodes (instant transitions),
 * not freeze on them — see the AudioAdapter.kt:1899-1907 rationale.
 */
function advancePfRole(env, loopWord, susWord, keyOff, tickSec, wrapScratch, idxBox, timeBox) {
  const maxIdx = 24;
  resolveEnvWrap(loopWord, susWord, keyOff, wrapScratch);
  const susStart = wrapScratch[0];
  const susEnd = wrapScratch[1];
  const susOn = susStart >= 0;
  let idx = idxBox[0];
  if (susOn && idx === susEnd && susStart === susEnd) {
    return env[idx].value / 255.0;
  } else if (susOn && idx === susEnd) {
    timeBox[0] = 0.0;
    idx = susStart;
    idxBox[0] = idx;
    return env[idx].value / 255.0;
  } else if (idx >= maxIdx) {
    return env[maxIdx].value / 255.0;
  } else {
    while (idx < maxIdx && !(susOn && idx === susEnd) && minifloatToDouble(env[idx].offset) === 0.0) {
      idx++;
    }
    if (susOn && idx === susEnd) {
      if (susStart !== susEnd) { timeBox[0] = 0.0; idx = susStart; }
      idxBox[0] = idx;
      return env[idx].value / 255.0;
    }
    idxBox[0] = idx;
    if (idx >= maxIdx) {
      return env[maxIdx].value / 255.0;
    }
    const offset = minifloatToDouble(env[idx].offset);
    timeBox[0] += tickSec;
    if (timeBox[0] >= offset) {
      timeBox[0] -= offset;
      idx = Math.min(idx + 1, maxIdx);
      idxBox[0] = idx;
      return env[idx].value / 255.0;
    }
    const cur = env[idx].value / 255.0;
    const nxt = env[Math.min(idx + 1, maxIdx)].value / 255.0;
    return cur + (nxt - cur) * (timeBox[0] / offset);
  }
}

/** Seed a pf-envelope playhead at note-on, settling past leading zero-duration
 *  nodes. The settled index + time carry are left in pfIdxBox[0] / pfTimeBox[0]. */
function seedPfRole(env, loopWord, susWord) {
  pfIdxBox[0] = 0;
  pfTimeBox[0] = 0.0;
  return advancePfRole(env, loopWord, susWord, false, 0.0, pfWrap, pfIdxBox, pfTimeBox);
}

/** Advance the pitch envelope (drives playback rate; 0.5 = unity). */
function advancePitchEnvelope(voice, tickSec) {
  if (!voice.hasPitchEnv || !voice.pitchEnvOn) return;
  pfIdxBox[0] = voice.envPitchIndex;
  pfTimeBox[0] = voice.envPitchTimeSec;
  voice.envPitchValue = advancePfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
    voice.activePitchEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox);
  voice.envPitchIndex = pfIdxBox[0];
  voice.envPitchTimeSec = pfTimeBox[0];
}

/** Advance the filter envelope (drives cutoff; 0.5 = unity). */
function advanceFilterEnvelope(voice, tickSec) {
  if (!voice.hasFilterEnv || !voice.filterEnvOn) return;
  pfIdxBox[0] = voice.envFilterIndex;
  pfTimeBox[0] = voice.envFilterTimeSec;
  voice.envFilterValue = advancePfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
    voice.activeFilterEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox);
  voice.envFilterIndex = pfIdxBox[0];
  voice.envFilterTimeSec = pfTimeBox[0];
}

/**
 * IT-style auto-vibrato: returns a 4096-TET pitch delta for the current tick
 * and advances the LFO phase. Reads the voice's active-sample snapshot
 * (patch-aware); [inst] retained in the signature for callsite continuity.
 */
function advanceAutoVibrato(voice, inst) {
  const depth0 = voice.activeVibratoDepth;
  if (depth0 === 0 || voice.activeVibratoSpeed === 0) return 0;

  // FT2 vibratoSweep = "ticks to fully ramp"; IT vibratoRate = ramp acceleration.
  const ftSweep = voice.activeVibratoSweep;
  const itRate = voice.activeVibratoRate;
  const t = voice.autoVibTicksSinceTrigger;
  let rampDepth;
  if (ftSweep !== 0) rampDepth = Math.min(Math.trunc((depth0 * t) / ftSweep), depth0);
  else if (itRate !== 0) rampDepth = Math.min((t * itRate) >>> 8, depth0);
  else rampDepth = depth0;
  voice.autoVibTicksSinceTrigger++;

  // 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (negated ramp-down).
  // `phase >> 2` re-enters lfoSample at the position its own `>> 2` completes,
  // making the index ⌊phase ÷ 16⌋ over the 1024-step scale (tables.js).
  const wave = voice.activeVibratoWaveform;
  const pos = voice.autoVibPhase >> 2;
  const rawSample = wave === 4 ? -lfoSample(pos, 1) : lfoSample(pos, wave & 3);
  // Depth: byte 255 (= IT Vid 64) → ±341/4096 octave = ±1 semitone, as IT.
  const pitchDelta = (rawSample * rampDepth * AUTOVIB_DEPTH_MUL) >> AUTOVIB_DEPTH_SHIFT;
  voice.autoVibPhase =
    (voice.autoVibPhase + voice.activeVibratoSpeed) & (AUTOVIB_PHASE_STEPS - 1);
  return pitchDelta;
}

// ══ src/engine/trigger.js ══
// Trigger path + NNA/Metainstrument machinery — port of AudioAdapter.kt
// applyActiveSample (1529), resolveActiveEnvelopes (1574), attenGainOf (1629),
// rowVolumeFromDefault (2413), capBackgroundVoices (2421), release/cutLayerChildren
// (2431/2445), triggerMetaOrNote (2469), triggerNote (2524), applyDuplicateCheck
// (2693), maybeSpawnBackgroundForNNA (2748), ghostVoice (2768),
// applyPastNoteAction (2887), applyVolColumn (2905), applyPanColumn (2927).










/**
 * Scratch out-box for triggerNote: [notePan, noteElevation, present] as the
 * INSTRUMENT left them for the trigger just run — `present` is 0 when the
 * instrument said nothing about panning at all. Only triggerMetaOrNote reads
 * it, immediately after each triggerNote call, to measure a layer's offset
 * from layer 0's (item 118). Same one-shot-box idiom as envelope.js's
 * pfIdxBox / pfTimeBox, and for the same reason: no per-voice field for a
 * value nothing keeps.
 */
const notePanSeedBox = new Float64Array(3);

/**
 * Snapshot the sample-scope state for voice from the base instrument or a
 * resolved Ixmp patch. Patch sentinels: defaultPan 0xFF, defaultNoteVolume 0,
 * vibratoWaveform 0xFF defer to the base instrument.
 */
function applyActiveSample(voice, inst, patch) {
  // Stem-export tap (item 93): which patch sounded. indexOf runs once per
  // trigger over a handful of patches; nothing in the DSP reads it back.
  voice.activePatchIndex =
    patch === null || inst.extraPatches === null ? -1 : inst.extraPatches.indexOf(patch);
  if (patch === null) {
    voice.activeSamplePtr = inst.samplePtr;
    voice.activeSampleLength = inst.sampleLength;
    voice.activeSamplePlayStart = inst.samplePlayStart;
    voice.activeSampleLoopStart = inst.sampleLoopStart;
    voice.activeSampleLoopEnd = inst.sampleLoopEnd;
    voice.activeSamplingRate = inst.samplingRate;
    voice.activeSampleDetune = inst.sampleDetuneSigned;
    voice.activeLoopMode = inst.loopMode;
    voice.activeVibratoSpeed = inst.vibratoSpeed;
    voice.activeVibratoSweep = inst.vibratoSweep;
    voice.activeVibratoDepth = inst.vibratoDepth;
    voice.activeVibratoRate = inst.vibratoRate;
    voice.activeVibratoWaveform = inst.vibratoWaveform;
    // A base instrument record has no channel block: always mono.
    voice.activeChanCount = 1;
    voice.activeChanMode = 0;
    voice.activeChanPtr2 = 0;
  } else {
    voice.activeSamplePtr = patch.samplePtr;
    voice.activeSampleLength = patch.sampleLength;
    voice.activeSamplePlayStart = patch.playStart;
    voice.activeSampleLoopStart = patch.loopStart;
    voice.activeSampleLoopEnd = patch.loopEnd;
    voice.activeSamplingRate = patch.samplingRate;
    voice.activeSampleDetune = patch.sampleDetune;
    voice.activeLoopMode = patch.loopMode;
    // Auto-vibrato: the $FF waveform sentinel defers the WHOLE block when the
    // patch brings no numbers of its own (item 170, patchVibratoInherits).
    const vibDefer = patchVibratoInherits(patch);
    voice.activeVibratoSpeed = vibDefer ? inst.vibratoSpeed : patch.vibratoSpeed;
    voice.activeVibratoSweep = vibDefer ? inst.vibratoSweep : patch.vibratoSweep;
    voice.activeVibratoDepth = vibDefer ? inst.vibratoDepth : patch.vibratoDepth;
    voice.activeVibratoRate = vibDefer ? inst.vibratoRate : patch.vibratoRate;
    voice.activeVibratoWaveform =
      patch.vibratoWaveform === 0xff ? inst.vibratoWaveform : patch.vibratoWaveform;
    // Ixmp 's' block (item 90). Only the stereo case is rendered; a patch with
    // more channels (quad / ambisonic — TODO #998) plays its first channel as
    // mono rather than guessing a downmix.
    if (patchIsStereo(patch)) {
      voice.activeChanCount = 2;
      voice.activeChanMode = patch.chanMode;
      voice.activeChanPtr2 = patch.chanPtrs[0];
    } else {
      voice.activeChanCount = 1;
      voice.activeChanMode = 0;
      voice.activeChanPtr2 = 0;
    }
  }
  resolveActiveEnvelopes(voice, inst, patch);
}

/**
 * Snapshot the active vol/pan/pitch/filter envelopes + fadeout/cutoff/resonance
 * scalars onto voice, from the base instrument or a resolved Ixmp patch. The
 * base instrument's two pf-env slots are routed by their m-bit (LOOP bit 7:
 * 0 = pitch, 1 = filter); a patch's 'P'/'f' blocks override the matching role.
 */
function resolveActiveEnvelopes(voice, inst, patch) {
  const volEnv = patch !== null ? patch.volEnv : null;
  if (volEnv !== null) {
    voice.activeVolEnv = volEnv;
    voice.activeVolEnvLoop = patch.volEnvLoop;
    voice.activeVolEnvSustain = patch.volEnvSustain;
  } else {
    voice.activeVolEnv = inst.volEnvelopes;
    voice.activeVolEnvLoop = inst.volEnvLoop;
    voice.activeVolEnvSustain = inst.volEnvSustainWord;
  }
  const panEnv = patch !== null ? patch.panEnv : null;
  if (panEnv !== null) {
    voice.activePanEnv = panEnv;
    voice.activePanEnvLoop = patch.panEnvLoop;
    voice.activePanEnvSustain = patch.panEnvSustain;
  } else {
    voice.activePanEnv = inst.panEnvelopes;
    voice.activePanEnvLoop = inst.panEnvLoop;
    voice.activePanEnvSustain = inst.panEnvSustainWord;
  }

  let pitEnv = inst.pfEnvelopes, pitLoop = 0, pitSus = 0, pitOn = false;
  let filEnv = inst.pfEnvelopes, filLoop = 0, filSus = 0, filOn = false;
  // base slot 1 (bytes 19..)
  if (envPresent(inst.pfEnvLoop)) {
    if (((inst.pfEnvLoop >>> 7) & 1) !== 0) {
      filEnv = inst.pfEnvelopes; filLoop = inst.pfEnvLoop; filSus = inst.pfEnvSustainWord; filOn = true;
    } else {
      pitEnv = inst.pfEnvelopes; pitLoop = inst.pfEnvLoop; pitSus = inst.pfEnvSustainWord; pitOn = true;
    }
  }
  // base slot 2 (bytes 197..)
  if (envPresent(inst.pf2EnvLoop)) {
    if (((inst.pf2EnvLoop >>> 7) & 1) !== 0) {
      filEnv = inst.pf2Envelopes; filLoop = inst.pf2EnvLoop; filSus = inst.pf2EnvSustainWord; filOn = true;
    } else {
      pitEnv = inst.pf2Envelopes; pitLoop = inst.pf2EnvLoop; pitSus = inst.pf2EnvSustainWord; pitOn = true;
    }
  }
  // patch overrides by role
  const pPit = patch !== null ? patch.pitchEnv : null;
  if (pPit !== null) {
    pitEnv = pPit; pitLoop = patch.pitchEnvLoop; pitSus = patch.pitchEnvSustain;
    pitOn = envPresent(patch.pitchEnvLoop);
  }
  const pFil = patch !== null ? patch.filterEnv : null;
  if (pFil !== null) {
    filEnv = pFil; filLoop = patch.filterEnvLoop; filSus = patch.filterEnvSustain;
    filOn = envPresent(patch.filterEnvLoop);
  }
  voice.activePitchEnv = pitEnv; voice.activePitchEnvLoop = pitLoop;
  voice.activePitchEnvSustain = pitSus; voice.hasPitchEnv = pitOn;
  voice.activeFilterEnv = filEnv; voice.activeFilterEnvLoop = filLoop;
  voice.activeFilterEnvSustain = filSus; voice.hasFilterEnv = filOn;

  if (patch !== null && patch.hasExtra) {
    voice.activeFadeoutStep = patch.fadeoutStep;
    voice.filterSfMode = patch.filterSfMode;
    voice.activeDefaultCutoff = patch.extraCutoff;
    voice.activeDefaultResonance = patch.extraResonance;
    voice.activeAttenGain = attenGainOf(patch.extraInitialAttenOctet);
  } else {
    voice.activeFadeoutStep = inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8);
    voice.filterSfMode = inst.filterSfMode;
    voice.activeDefaultCutoff = inst.defaultCutoff16;
    voice.activeDefaultResonance = inst.defaultResonance16;
    voice.activeAttenGain = attenGainOf(inst.initialAttenOctet);
  }
}

/** Trigger-time noteVolume seed from Default Note Volume (byte 196; 0 = legacy
 *  full volume). The record's field is 8-bit: a 6-bit column narrows it, a wide
 *  cell's 8-bit volume state takes it as it stands. */
function rowVolumeFromDefault(inst, patch = null, volMax = 0x3f) {
  const patchDnv = patch !== null && patch.defaultNoteVolume !== 0 ? patch.defaultNoteVolume : null;
  const dnv = patchDnv !== null ? patchDnv : inst.defaultNoteVolume;
  if (dnv === 0) return volMax;
  return volMax === 0xff ? dnv : Math.trunc((dnv * 63 + 127) / 255);
}

/** Cap backgroundVoices to MAX_BG_VOICES, preferring to evict the oldest NON-layer ghost. */
function capBackgroundVoices(ts) {
  while (ts.backgroundVoices.length > MAX_BG_VOICES) {
    // Plain NNA ghosts go first, then layer children. An FM operator goes LAST
    // and, when it does go, is deactivated rather than merely dropped: its rack
    // still holds a reference to it, and a culled operand that kept sounding
    // would be an operand nothing was ageing any more.
    let idx = ts.backgroundVoices.findIndex((v) => !v.isLayerChild && !v.fmOperator);
    if (idx < 0) idx = ts.backgroundVoices.findIndex((v) => !v.fmOperator);
    if (idx < 0) idx = 0;
    ts.backgroundVoices[idx].active = false;
    ts.backgroundVoices.splice(idx, 1);
  }
}

/** Release channel vi's layer children (fresh trigger): detach + apply their own NNA. */
function releaseLayerChildren(eng, ts, vi) {
  for (const bg of ts.backgroundVoices) {
    if (!bg.isLayerChild || bg.sourceChannel !== vi) continue;
    if (bg.fmOperator) continue; // dropFmOperators cuts these outright
    bg.isLayerChild = false;
    // A detached child runs no effects any more, so it drops back to its own
    // note rather than freezing mid-bend — the same rule the plain NNA ghost
    // follows (ghostVoice keeps no pitch overlay either).
    bg.layerPitchMod = 0;
    switch (eng.instruments[bg.instrumentId].newNoteAction) {
      case 0:
        if (!bg.keyOff) { bg.keyOff = true; applyKeyLift(bg, eng.instruments[bg.instrumentId]); }
        break;
      case 1: bg.active = false; break; // note cut
      case 3: bg.noteFading = true; break; // note fade
      // 2 = continue
    }
  }
}

/** Cut channel vi's layer children (pattern note-cut 0x0002). Ramped like the
 *  parent — they are one note, and a clean parent over clicking children would
 *  be worse than either on its own. */
function cutLayerChildren(ts, vi) {
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) startCutRamp(bg);
  }
}

/**
 * Trigger noteVal/instId on channel vi's foreground voice; a Metainstrument
 * fans out into layer children. rowVolOverride is the V-column trigger velocity
 * (or -1), used for velocity-conditional layer/patch resolution.
 */
function triggerMetaOrNote(eng, ts, voice, vi, noteVal, instId, rowVolOverride) {
  // Remember the pattern-level instrument for the Timeline header (a meta's slot,
  // not the layer child triggerNote resolves it to). A note with no instrument
  // byte keeps the last one, matching what the pattern shows.
  if (instId !== 0) voice.displayInst = instId;
  releaseLayerChildren(eng, ts, vi);
  dropFmOperators(ts, vi);
  const inst = instId !== 0 ? eng.instruments[instId] : eng.instruments[voice.instrumentId];
  if (!inst.isMeta) {
    triggerNote(eng, ts, voice, noteVal, instId, rowVolOverride);
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    voice.layerFixedNote = -1;
    voice.layerRelPan = 0;
    voice.layerRelElevation = 0;
    voice.isLayerChild = false;
    return;
  }
  // Layer gating is an INSTRUMENT-side rectangle, so the axis is 6-bit whatever
  // the column's width: narrow a wide cell's volume to it.
  const gateVol = ts.wideCells ? rowVolOverride >> 2 : rowVolOverride;
  const seedVol = gateVol >= 0 && gateVol <= 0x3f ? gateVol : 0x3f;
  if (inst.isFm) {
    triggerFmRack(eng, ts, voice, vi, noteVal, inst, rowVolOverride, seedVol);
    return;
  }
  let layers = inst.resolveMetaLayers(noteVal, seedVol);
  // What each layer SOUNDS, which for a fixed-pitch layer (item 179) is its own
  // note and not the trigger's. The gating above still asked about the trigger:
  // the rectangle says which keys reach the layer, the flag says what it plays
  // when one does.
  const pitchOf = (l) => clamp(layerNote(l, noteVal), 0x20, 0xffff);
  // STRICT layering: drop layers whose patches don't cover the note (the gating
  // bbox is loose; strict converters emit each layer's canonical into its patches).
  if (inst.metaStrict) {
    layers = layers.filter((l) =>
      eng.instruments[l.instIdx].resolvePatch(pitchOf(l), seedVol) !== null);
  }
  if (layers.length === 0) { // no layer sounds this note: silence
    voice.active = false;
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    voice.layerFixedNote = -1;
    return;
  }
  const l0 = layers[0];
  // CHANNEL pan context as it stands before layer 0 retriggers — a channel the
  // pattern placed carries to every layer, and capturing it first keeps layer
  // 0's own trigger from feeding back into its siblings. Where each layer sits
  // WITHIN that channel is the note axis's business, handled per child below.
  const chanPan = voice.channelPan, chanRowPan = voice.rowPan;
  const chanPanbrello = voice.panbrelloOffset;
  const chanAzimuth = voice.panAzimuth, chanElevation = voice.panElevation;
  triggerNote(eng, ts, voice, pitchOf(l0), l0.instIdx, rowVolOverride);
  // Layer 0 IS the meta's position — the centre the other layers sit around, in
  // pan exactly as it already is in pitch (layerRelDetune below). A layer that
  // says nothing about panning has no opinion about where it sits relative to
  // that centre, so its baseline is 0 rather than layer 0's own value; that is
  // what keeps a pan-less layer sitting wherever the meta sits (item 116) while
  // a layer with a pan of its own keeps its distance (item 118).
  const l0HasPan = notePanSeedBox[2] !== 0;
  const l0Pan = l0HasPan ? notePanSeedBox[0] : 0;
  const l0Elevation = l0HasPan ? notePanSeedBox[1] : 0;
  voice.layerMixGain = META_MIX_GAIN[l0.mixOctet & 0xff];
  voice.layerRelDetune = 0;
  // Layer 0 itself may be the fixed-pitch one (item 179's third consequence,
  // explicitly anticipated by the spec): its sounding note is then its own
  // field, not the trigger's, exactly as pitchOf(l0) already read it above —
  // recorded the same way a fixed-pitch CHILD is, so a later portamento row
  // (row.js) knows this voice's note does not track the pattern at all.
  voice.layerFixedNote = l0.fixedPitch ? pitchOf(l0) : -1;
  voice.layerRelPan = 0;
  voice.layerRelElevation = 0;
  voice.isLayerChild = false;
  voice.metaForeground = true;
  // How far this voice's own noteVal sits from the raw trigger note — layer
  // 0's detune, exactly as layerRelDetune measures it for a child (item 176:
  // a subsequent G row's target has to cross into this same coordinate).
  voice.metaForegroundDetune = l0.detune;
  for (let k = 1; k < layers.length; k++) {
    const lk = layers[k];
    const child = new Voice();
    // Match layer 0's channel context so M/pan and the first tick agree; the
    // trigger below may then move the child's pan to its own default.
    child.channelVolume = voice.channelVolume;
    child.channelPan = chanPan;
    child.rowPan = chanRowPan;
    child.panbrelloOffset = chanPanbrello;
    child.panAzimuth = chanAzimuth;
    child.panElevation = chanElevation;
    // …and the channel's DSP colouring, which outlives the note that armed it:
    // a crusher already running when the meta is struck has to be running on
    // every layer of it, not just layer 0 (item 154).
    child.clipMode = voice.clipMode;
    child.bitcrusherDepth = voice.bitcrusherDepth;
    child.bitcrusherSkip = voice.bitcrusherSkip;
    child.overdriveAmp = voice.overdriveAmp;
    triggerNote(eng, ts, child, pitchOf(lk), lk.instIdx, rowVolOverride);
    child.isLayerChild = true;
    child.sourceChannel = vi;
    child.displayInst = voice.displayInst; // export/display tap: the meta SLOT, not the layer's inst
    // How far this layer sits from layer 0 on the note axis, measured BEFORE
    // the clamp so an extreme detune keeps its true interval. With both layers
    // melodic that is exactly `lk.detune - l0.detune`, which is what it was
    // before item 179; written as a difference of NOTES it also holds when
    // layer 0 is the fixed-pitch one.
    child.layerRelDetune = layerNote(lk, noteVal) - layerNote(l0, noteVal);
    // …and a fixed-pitch child tracks no parent at all: the per-tick sync holds
    // it at this note instead of re-deriving one (tick.js).
    child.layerFixedNote = lk.fixedPitch ? pitchOf(lk) : -1;
    // The pan twin of layerRelDetune (item 118): how far this layer sits from
    // the meta's centre, held across the whole note by the per-tick sync so a
    // note-pan SET ROTATES the arrangement instead of collapsing it onto one
    // spot. A layer with no pan of its own rides at offset 0.
    if (notePanSeedBox[2] !== 0) {
      child.layerRelPan = notePanSeedBox[0] - l0Pan;
      child.layerRelElevation = notePanSeedBox[1] - l0Elevation;
    } else {
      child.layerRelPan = 0;
      child.layerRelElevation = 0;
    }
    child.notePan = boundNotePan(ts, voice.notePan + child.layerRelPan);
    child.noteElevation = voice.noteElevation + child.layerRelElevation;
    child.layerMixGain = META_MIX_GAIN[lk.mixOctet & 0xff];
    ts.backgroundVoices.push(child);
  }
  capBackgroundVoices(ts);
}

/**
 * Sound a type-4 FM rack (item 159) on channel vi's foreground voice.
 *
 * The shape deliberately mirrors the layered path above — operator 0 takes the
 * channel's own voice and the rest spawn background children carrying relative
 * detune — because everything downstream of the trigger (the per-tick sync, Q's
 * whole-instrument retrigger, the release of the previous note) then works on a
 * rack for exactly the reasons it works on a stack of layers.
 *
 * What differs is what the children are FOR. A layer child is a sound; an
 * operator is an operand. So an operator carries no position of its own (the
 * rack is one signal, and it sits where the channel sits), its mix octet is
 * applied by the rack rather than by the mixer, and it is only spawned at all
 * when the algorithm names it.
 */
function triggerFmRack(eng, ts, voice, vi, noteVal, inst, rowVolOverride, seedVol) {
  const ops = inst.metaLayers;
  const program = inst.fmProgram;
  const sounds = (o) =>
    o.instIdx >= 1 && o.instIdx <= 1023 && !eng.instruments[o.instIdx].isMeta &&
    noteVal >= o.pitchStart && noteVal <= o.pitchEnd &&
    seedVol >= o.volStart && seedVol <= o.volEnd;
  // No algorithm, or no principal operator, is silence — the same answer the
  // layered path gives when no layer covers the note, and for the same reason:
  // there is nothing here to sound, and guessing at one would be worse.
  if (program === null || !sounds(ops[0])) {
    voice.active = false;
    voice.fmRig = null;
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    voice.layerFixedNote = -1;
    return;
  }
  const referenced = fmReferencedOperators(program, ops.length);
  const rig = new FmRig(ops.length);
  rig.program = program;
  fmSeedGains(rig, ops);

  // The channel's pan context as it stands BEFORE operator 0 retriggers — read
  // once, for the same reason the layered path reads it (a child's own trigger
  // must not inherit a sibling's).
  const chanPan = voice.channelPan, chanRowPan = voice.rowPan;
  const chanPanbrello = voice.panbrelloOffset;
  const chanAzimuth = voice.panAzimuth, chanElevation = voice.panElevation;
  triggerNote(eng, ts, voice, clamp(noteVal + ops[0].detune, 0x20, 0xffff),
    ops[0].instIdx, rowVolOverride);
  // The rack applies every operator's mix level itself, operator 0's included,
  // so the mixer's layer gain stays out of it: leaving operator 0's octet here
  // would scale the whole finished patch by one operand's level.
  voice.layerMixGain = 1.0;
  voice.layerRelDetune = 0;
  voice.layerFixedNote = -1;
  voice.layerRelPan = 0;
  voice.layerRelElevation = 0;
  voice.isLayerChild = false;
  voice.metaForeground = true;
  // Same coordinate-shift bookkeeping as the layered path, for operator 0's
  // own detune (item 176) — a rack's operators never carry the fixed-pitch
  // flag (it is reserved outside the Layered kind), so no layerFixedNote
  // handling belongs here.
  voice.metaForegroundDetune = ops[0].detune;
  voice.fmRig = rig;
  rig.voices[0] = voice;

  for (let k = 1; k < ops.length; k++) {
    if (referenced[k] === 0 || !sounds(ops[k])) continue;
    const op = new Voice();
    op.channelVolume = voice.channelVolume;
    op.channelPan = chanPan;
    op.rowPan = chanRowPan;
    op.panbrelloOffset = chanPanbrello;
    op.panAzimuth = chanAzimuth;
    op.panElevation = chanElevation;
    op.clipMode = voice.clipMode;
    op.bitcrusherDepth = voice.bitcrusherDepth;
    op.bitcrusherSkip = voice.bitcrusherSkip;
    op.overdriveAmp = voice.overdriveAmp;
    triggerNote(eng, ts, op, clamp(noteVal + ops[k].detune, 0x20, 0xffff),
      ops[k].instIdx, rowVolOverride);
    op.isLayerChild = true;
    op.fmOperator = true;
    op.sourceChannel = vi;
    op.displayInst = voice.displayInst;
    op.layerRelDetune = ops[k].detune - ops[0].detune;
    op.layerMixGain = 1.0;
    // An operand has no place of its own: the rack is one signal at the
    // channel's position, so an operator never pulls it sideways.
    op.layerRelPan = 0;
    op.layerRelElevation = 0;
    op.notePan = voice.notePan;
    op.noteElevation = voice.noteElevation;
    rig.voices[k] = op;
    ts.backgroundVoices.push(op);
  }
  capBackgroundVoices(ts);
}

/**
 * Narrow a note volume onto the Ixmp/meta rectangle's velocity axis. That axis
 * is INSTRUMENT data and stays 6-bit in every format version (file format §5.5),
 * so a wide cell's 8-bit volume must be scaled down for it — 255 → 63. Every
 * resolvePatch/resolveMetaLayers call site goes through here; one that forgets
 * silently misses every patch in a v3 song (item 116).
 */
function narrowVolAxis(ts, v) {
  return clamp(ts.wideCells ? v >> 2 : v, 0, 0x3f);
}

function triggerNote(eng, ts, voice, noteVal, instId, volOverride) {
  // Envelope carry (LOOP word bit 6, item 169.1) is decided from the state the
  // voice is in BEFORE this trigger touches any of it. Three things disqualify
  // a carry, all of them IT's own (schismtracker effects.c env_reset, whose
  // `always` argument is exactly this test): nothing was sounding, the note
  // had been released — a carried release position starts the new note
  // somewhere down its own decay — or the trigger changes the instrument, in
  // which case the playhead belongs to a different envelope. Whether each of
  // the four playheads then carries is its OWN envelope's `c` bit, resolved
  // below once the patch has said which envelopes are active.
  const mayCarry = voice.active && !voice.keyOff && !voice.noteFading
    && (instId === 0 || instId === voice.instrumentId);
  if (instId !== 0) voice.instrumentId = instId;
  const inst = eng.instruments[voice.instrumentId];
  // Resolve the Ixmp patch for this trigger (volume axis = pre-patch seed).
  const narrow = (v) => narrowVolAxis(ts, v);
  let seedVolForLookup;
  if (volOverride >= 0) seedVolForLookup = narrow(volOverride);
  else if (instId !== 0) seedVolForLookup = rowVolumeFromDefault(inst, null);
  else seedVolForLookup = narrow(voice.noteVolume);
  const patch = inst.resolvePatch(noteVal, seedVolForLookup);
  applyActiveSample(voice, inst, patch);
  voice.tonePortaTarget = -1; // fresh note trigger cancels any running porta
  voice.samplePos = voice.activeSamplePlayStart;
  voice.forward = true;
  voice.active = true;
  voice.keyOff = false;
  if (!(mayCarry && envCarry(voice.activeVolEnvLoop))) {
    voice.envIndex = 0;
    voice.envTimeSec = 0.0;
    voice.envVolume = clamp(voice.activeVolEnv[0].value / 63.0, 0.0, 1.0);
    // Snap the per-sample-smoothed envelope so attacks land at node-0 immediately.
    voice.envVolMix = voice.envVolume;
    voice.envVolStep = 0.0;
  }
  // A carried playhead keeps envVolume / envVolMix too: they already hold the
  // value at that node, and advanceEnvelope re-reads both from the ACTIVE
  // envelope later in this same tick, so a patch swap under a carry costs
  // nothing. Snapping them would step the gain mid-waveform for no reason.
  voice.hasPanEnv = envPresent(voice.activePanEnvLoop);
  if (!(mayCarry && envCarry(voice.activePanEnvLoop))) {
    voice.envPanIndex = 0;
    voice.envPanTimeSec = 0.0;
    voice.envPan = voice.activePanEnv[0].value / 255.0;
  }
  // Pitch / filter envelope seeds — settle past leading zero-duration nodes.
  if (!voice.hasPitchEnv) {
    voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
  } else if (!(mayCarry && envCarry(voice.activePitchEnvLoop))) {
    voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
      voice.activePitchEnvSustain);
    voice.envPitchIndex = pfIdxBox[0];
    voice.envPitchTimeSec = pfTimeBox[0];
  }
  if (!voice.hasFilterEnv) {
    voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
  } else if (!(mayCarry && envCarry(voice.activeFilterEnvLoop))) {
    voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
      voice.activeFilterEnvSustain);
    voice.envFilterIndex = pfIdxBox[0];
    voice.envFilterTimeSec = pfTimeBox[0];
  }
  voice.fadeoutVolume = 1.0;
  // Cancel any leftover sample-end ramp — a fresh attack must not be muted.
  voice.rampOutSamples = 0;
  voice.rampOutGain = 0.0;
  // Arm the Attack fade-in (item 139); see constants.js ATTACK_RAMP_SAMPLES.
  voice.attackRampSamples = ATTACK_RAMP_SAMPLES;
  voice.autoVibPhase = 0;
  voice.autoVibTicksSinceTrigger = 0;
  voice.nesDpcmCounter = 63;
  voice.right.reset(); // stereo channel 2's filter/crusher/DPCM history
  // Invert loop: PT2 resets n_wavestart on fresh trigger; speed/accumulator persist.
  voice.invertWritePos = 0;
  // Funk repeat: the window goes back to the sample's own loop. PT re-seeded
  // n_wavestart from n_loopstart only when the ROW CARRIED A SAMPLE NUMBER
  // (FUNK_REPEAT.md §2.1, §7.3) — a bare note left the walk where it stood. A
  // deliberate divergence: here the window is an offset into the ACTIVE sample
  // view, which a trigger rebuilds, so carrying it across a re-trigger would
  // aim it into a sample that may not be the one it was measured against. The
  // speed and the accumulator persist, which is the part that carries the feel.
  voice.funkWalk = -1;
  voice.funkPos = -1;
  voice.funkWindow = -1;
  voice.funkXfade = 0;
  // Extended $102/$12x's own window (item 173 follow-up): same rule, this
  // voice's restart point goes back to the sample's own loop. The walk
  // itself (inst.modFunkWalk/modFunkPos) is the INSTRUMENT's, shared by
  // every voice sounding it, so a fresh trigger on this one voice must not
  // touch it — exactly as a fresh trigger never touches inst.modRot.
  voice.modFunkWindow = -1;
  voice.modFunkXfade = 0;
  // Random vol/pan swing biases — seeded once per trigger.
  voice.randomVolBias = inst.volumeSwing !== 0
    ? Math.trunc(random() * (2 * inst.volumeSwing + 1)) - inst.volumeSwing : 0;
  voice.randomPanBias = inst.panSwing !== 0
    ? Math.trunc(random() * (2 * inst.panSwing + 1)) - inst.panSwing : 0;
  // Default pan / pitch-pan separation: only when the row carried an instrument byte.
  notePanSeedBox[2] = 0;
  if (instId !== 0) {
    // Everything an INSTRUMENT says about panning lands on the note axis (item
    // 117), never on the channel's own position — the exact mirror of the
    // volume side, where an instrument seeds `note_vol` and only M / N may
    // touch `channel_vol`. That is what lets `S $80xx` ROTATE a zone-panned
    // instrument instead of being flattened by its next note: the channel says
    // where the part sits, the instrument says where the note sits within it.
    //
    // Two sources, in specificity order, and mutually EXCLUSIVE because they
    // are the same statement at two levels — an SF2 bank that applied its
    // record pan AND its zone pan would double every displacement:
    //
    //  - An Ixmp patch's default pan is per-ZONE, so a patched instrument's pan
    //    changes with the note being played. It carries its own sentinel
    //    (0xFF = no override) and applies whether or not 'p' is set: the patch
    //    is free to bring its own pan envelope, whose LOOP word REPLACES the
    //    base record's, so gating a patch override on 'p' would let the patch
    //    disable its own pan (item 116). SF2-derived banks are the common case.
    //  - Otherwise pan LOOP word bit 7 = 'p' ("use default pan") gates the base
    //    record's byte 177.
    //
    // The seed gate is unchanged: a trigger that brings NEITHER leaves the note
    // axis alone, so a pan column SET survives it exactly as it did when both
    // axes lived in one register.
    const patchPan = patch !== null && patch.defaultPan !== 0xff ? patch.defaultPan : null;
    if (patchPan !== null) {
      applyNotePanSet(ts, voice, patchPan);
      notePanSeedBox[2] = 1;
    } else if (((voice.activePanEnvLoop >>> 7) & 1) !== 0) {
      notePanSeedBox[2] = 1;
      if (ts.surroundModel === SURROUND_STEREO) {
        applyNotePanSet(ts, voice, inst.defaultPan);
      } else {
        // Surround: the instrument's default is a POSITION (#998). Its azimuth
        // is nine bits (byte 177 + byte 14's `A`), so it can sit behind the
        // listener, and its elevation comes from record byte 254. Both are read
        // as offsets from the channel's direction, so an instrument that wants
        // to sound half-left of wherever the part is placed can say so.
        applyNotePanSet(ts, voice, inst.defaultAzimuth);
        applyNoteElevation(ts, voice, inst.defaultElevation);
      }
    }
    // Pitch-pan separation — an instrument property, and pitch-derived, so it
    // shifts the note axis on top of whichever seed above ran. It still
    // ACCUMULATES across notes on an instrument that brings no default pan of
    // its own, which is IT's arithmetic (IT adds PPS to the pan it is holding
    // and only the default pan re-seeds that); it accumulates in note-axis
    // units now instead of channel-axis ones.
    if (inst.pitchPanSeparation !== 0) {
      const noteDelta = (noteVal - inst.pitchPanCentre) / 4096.0;
      const panShift = Math.trunc(noteDelta * inst.pitchPanSeparation * 4.0);
      applyNotePanSlide(ts, voice, panShift);
      notePanSeedBox[2] = 1;
    }
    // What this instrument said about panning, for triggerMetaOrNote to measure
    // a layer's offset against layer 0's (item 118). Reported as the RESULTING
    // note-axis value rather than the delta, because a seed replaces where a
    // slide accumulates; the two callers only ever subtract two of these, so a
    // pan column value both of them inherited cancels out.
    notePanSeedBox[0] = voice.notePan;
    notePanSeedBox[1] = voice.noteElevation;
  }
  // Filter defaults (ACTIVE values; patch 'x' block overrides base inst).
  voice.currentCutoff = voice.activeDefaultCutoff;
  voice.currentResonance = voice.activeDefaultResonance;
  voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0;
  voice.filterCutoffCached = -1;
  voice.filterResonanceCached = -1;
  voice.noteVal = noteVal;
  voice.basePitch = noteVal;
  voice.renderPitch = noteVal; // display tap: seed before the first tick runs
  voice.amigaPeriod = -1.0;
  voice.linearFreq = -1.0;
  voice.playbackRate = computePlaybackRate(voice, noteVal, ts.tuningRatio);
  // noteVolume seed (IT `chan->volume = psmp->volume` rule; channelVolume survives).
  if (volOverride >= 0) voice.noteVolume = clamp(volOverride, 0, ts.volMax);
  else if (instId !== 0) voice.noteVolume = rowVolumeFromDefault(inst, patch, ts.volMax);
  // else: note-only retrigger inherits the channel's existing note volume.
  voice.rowVolume = voice.noteVolume;
  // Deferred anti-click ramp snap (applyVolColumn/applyEffectRow run after this).
  voice.snapMixVolume = true;
  voice.volRampSamples = 0;
  voice.volRampStep = 0.0;
  // A fresh note starts AT its pitch and AT its pan — it does not bend or slide
  // in from whatever the channel was last playing (item 141).
  voice.snapPlaybackRate = true;
  voice.snapPan = true;
  voice.noteWasCut = false;
  voice.noteFading = false;
  // S $73..$7E per-note overrides reset on each fresh trigger.
  voice.nnaOverride = -1;
  voice.volEnvOn = true;
  voice.panEnvOn = true;
  voice.pitchEnvOn = true;
  voice.filterEnvOn = true;
  voice.metaForeground = false; // triggerMetaOrNote re-sets for the meta path
  voice.metaForegroundDetune = 0;
  // A rack belongs to the note that built it, so ANY fresh trigger drops it —
  // including the ones that never go through triggerMetaOrNote (the audition
  // path, a layer child). triggerFmRack re-hangs it after this returns.
  voice.fmRig = null;
  if (voice.vibratoRetrig) voice.vibratoLfoPos = 0;
  if (voice.tremoloRetrig) voice.tremoloLfoPos = 0;
  if (voice.panbrelloRetrig) voice.panbrelloLfoPos = 0;
}

/**
 * IT-style Duplicate Check (DCT/DCA), run BEFORE NNA on every fresh foreground
 * trigger. Reference: schismtracker effects.c:1664-1764.
 */
function applyDuplicateCheck(eng, ts, channel, newInstId, newNote) {
  if (newInstId === 0) return;
  const newInst = eng.instruments[newInstId];
  const newPatch = newInst.resolvePatch(newNote, 0x3f);
  const newSmpPtr = newPatch !== null ? newPatch.samplePtr : newInst.samplePtr;
  const newSmpLen = newPatch !== null ? newPatch.sampleLength : newInst.sampleLength;

  const isDuplicate = (v) => {
    const existInst = eng.instruments[v.instrumentId];
    switch (existInst.duplicateCheckType) {
      case 1: return v.noteVal === newNote && v.instrumentId === newInstId;
      case 2: return v.instrumentId === newInstId &&
                     v.activeSamplePtr === newSmpPtr &&
                     v.activeSampleLength === newSmpLen;
      case 3: return v.instrumentId === newInstId;
      default: return false;
    }
  };

  const applyAction = (v) => {
    const existInst = eng.instruments[v.instrumentId];
    switch (existInst.duplicateCheckAction) {
      case 0: v.fadeoutVolume = 0.0; v.active = false; break;
      case 1: v.keyOff = true; applyKeyLift(v, existInst); break;
      case 2: v.noteFading = true; break;
    }
  };

  const fg = ts.voices[channel];
  if (fg.active && eng.instruments[fg.instrumentId].duplicateCheckType !== 0 && isDuplicate(fg)) {
    applyAction(fg);
  }

  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (bg.sourceChannel !== channel || !bg.active) continue;
    if (eng.instruments[bg.instrumentId].duplicateCheckType === 0) continue;
    if (!isDuplicate(bg)) continue;
    applyAction(bg);
    if (!bg.active) ts.backgroundVoices.splice(i, 1);
  }
}

/**
 * On a fresh foreground trigger, migrate the existing voice into the background
 * pool per the New Note Action (instrument default unless S $73..$76 override).
 */
function maybeSpawnBackgroundForNNA(eng, ts, voice, channel) {
  if (!voice.active) return;
  // An FM rack (item 159) does not ghost. A ghost is a snapshot of ONE voice,
  // and a rack is a voice plus the operators that shape it — copy the snapshot
  // alone and the ghost sounds operator 0's raw sample, which is not the note
  // that was playing and not a sound the patch can make at all. So the new note
  // simply takes the channel — triggerMetaOrNote's dropFmOperators, a moment
  // later, cuts the operands with it, and the incoming note's attack ramp
  // covers the seam the way it does for a Note Cut.
  if (voice.fmRig !== null) return;
  const nna = voice.nnaOverride >= 0
    ? voice.nnaOverride
    : eng.instruments[voice.instrumentId].newNoteAction;
  if (nna === 1) {
    // Note Cut. The voice is about to be REUSED for the new note, so "cut" used
    // to mean dropping the old one wherever its waveform happened to be — a step
    // from that value to whatever the new note starts at. That is the retrigger
    // click, and it is loudest exactly where it is least wanted: a fast run of
    // notes on one channel, or a tone portamento re-attacking (item 142).
    //
    // So the outgoing note is ghosted just long enough to ramp out. It fades
    // over the same span the incoming note's attack ramp fades IN, which makes
    // the pair a crossfade rather than a splice. The ghost costs one background
    // voice for ~0.7 ms and deactivates itself.
    const cut = ghostVoice(voice, channel);
    startCutRamp(cut);
    ts.backgroundVoices.push(cut);
    capBackgroundVoices(ts);
    return;
  }

  const bg = ghostVoice(voice, channel);
  if (nna === 0) { // Note Off
    bg.keyOff = true;
    applyKeyLift(bg, eng.instruments[bg.instrumentId]);
  } else if (nna === 3) { // Note Fade
    bg.noteFading = true;
  }
  // 2 (Continue) — ghost continues unchanged.
  ts.backgroundVoices.push(bg);
  capBackgroundVoices(ts);
}

/** Snapshot the playback-relevant state of src into a fresh Voice for channel.
 *  MUST copy the full active-sample + active-envelope views AND both filter
 *  state sets (incl. SF2 biquad coefficients/history) — see the port notes. */
function ghostVoice(src, channel) {
  const v = new Voice();
  v.active = true;
  v.fader = src.fader;
  v.instrumentId = src.instrumentId;
  v.displayInst = src.displayInst;       // export/display tap: the ghost is still "that" instrument
  v.samplePos = src.samplePos;
  v.playbackRate = src.playbackRate;
  v.currentPlaybackRate = src.currentPlaybackRate;
  v.currentPan = src.currentPan;
  v.forward = src.forward;
  v.noteVolume = src.noteVolume;
  v.channelVolume = src.channelVolume;
  v.rowVolume = src.rowVolume;
  v.channelPan = src.channelPan;
  v.rowPan = src.rowPan;
  // Spatial position travels with the ghost: it keeps sounding where it was —
  // both axes, since the note it is still sounding brought its own offset.
  v.panAzimuth = src.panAzimuth;
  v.panElevation = src.panElevation;
  v.notePan = src.notePan;
  v.noteElevation = src.noteElevation;
  v.spatialTargetAz = src.spatialTargetAz;
  v.spatialTargetEl = src.spatialTargetEl;
  v.currentMixVolume = src.currentMixVolume;
  // A very fast retrigger can ghost a voice while its own Attack fade-in (item 139)
  // is still running — copy it so the ghost keeps fading up from where the
  // foreground voice left off, instead of jumping straight to unity.
  v.attackRampSamples = src.attackRampSamples;
  v.keyOff = src.keyOff;
  v.envIndex = src.envIndex;
  v.envTimeSec = src.envTimeSec;
  v.envVolume = src.envVolume;
  v.envVolMix = src.envVolMix;
  v.envVolStep = src.envVolStep;
  v.envPanIndex = src.envPanIndex;
  v.envPanTimeSec = src.envPanTimeSec;
  v.envPan = src.envPan;
  v.hasPanEnv = src.hasPanEnv;
  v.hasPitchEnv = src.hasPitchEnv;
  v.envPitchIndex = src.envPitchIndex;
  v.envPitchTimeSec = src.envPitchTimeSec;
  v.envPitchValue = src.envPitchValue;
  v.hasFilterEnv = src.hasFilterEnv;
  v.envFilterIndex = src.envFilterIndex;
  v.envFilterTimeSec = src.envFilterTimeSec;
  v.envFilterValue = src.envFilterValue;
  v.fadeoutVolume = src.fadeoutVolume;
  v.autoVibPhase = src.autoVibPhase;
  v.autoVibTicksSinceTrigger = src.autoVibTicksSinceTrigger;
  v.currentCutoff = src.currentCutoff;
  v.currentResonance = src.currentResonance;
  v.filterSfMode = src.filterSfMode;
  v.filterActive = src.filterActive;
  v.filterA0 = src.filterA0;
  v.filterB0 = src.filterB0;
  v.filterB1 = src.filterB1;
  v.filterY1 = src.filterY1;
  v.filterY2 = src.filterY2;
  v.filterIsBiquad = src.filterIsBiquad;
  v.filterBqB02 = src.filterBqB02;
  v.filterBqB1 = src.filterBqB1;
  v.filterBqA1 = src.filterBqA1;
  v.filterBqA2 = src.filterBqA2;
  v.filterX1 = src.filterX1;
  v.filterX2 = src.filterX2;
  v.filterCutoffCached = src.filterCutoffCached;
  v.filterResonanceCached = src.filterResonanceCached;
  v.randomVolBias = src.randomVolBias;
  v.randomPanBias = src.randomPanBias;
  // A ghost runs no effects, so its panbrello freezes at the offset it had when
  // the new note pushed it out of the channel — it keeps sounding where it was.
  v.panbrelloOffset = src.panbrelloOffset;
  v.noteVal = src.noteVal;
  v.basePitch = src.basePitch;
  v.amigaPeriod = src.amigaPeriod;
  v.linearFreq = src.linearFreq;
  v.volEnvOn = src.volEnvOn;
  v.panEnvOn = src.panEnvOn;
  v.pitchEnvOn = src.pitchEnvOn;
  v.filterEnvOn = src.filterEnvOn;
  v.metaForeground = src.metaForeground;
  v.metaForegroundDetune = src.metaForegroundDetune;
  v.noteFading = src.noteFading;
  v.layerMixGain = src.layerMixGain;
  v.layerRelPan = src.layerRelPan;
  v.layerRelElevation = src.layerRelElevation;
  v.clipMode = src.clipMode;
  v.bitcrusherDepth = src.bitcrusherDepth;
  v.bitcrusherSkip = src.bitcrusherSkip;
  v.bitcrusherCounter = src.bitcrusherCounter;
  v.bitcrusherHeld = src.bitcrusherHeld;
  v.overdriveAmp = src.overdriveAmp;
  v.sourceChannel = channel;
  // Active-sample snapshot follows the foreground voice.
  v.activeSamplePtr = src.activeSamplePtr;
  v.activeSampleLength = src.activeSampleLength;
  v.activeSamplePlayStart = src.activeSamplePlayStart;
  v.activeSampleLoopStart = src.activeSampleLoopStart;
  v.activeSampleLoopEnd = src.activeSampleLoopEnd;
  v.activeSamplingRate = src.activeSamplingRate;
  v.activeSampleDetune = src.activeSampleDetune;
  v.activeLoopMode = src.activeLoopMode;
  // The window funk repeat had walked to travels with the ghost — its sample
  // position is INSIDE that window — but the walk itself does not: the pointer
  // is the channel's, and a ghost is no longer addressable from the pattern.
  v.funkWindow = src.funkWindow;
  // Same rule for extended $102/$12x's own window (item 173 follow-up): the
  // ghost's sample position is inside it, but inst.modFunkWalk/modFunkPos
  // stay with the instrument, not the ghost.
  v.modFunkWindow = src.modFunkWindow;
  v.activeVibratoSpeed = src.activeVibratoSpeed;
  v.activeVibratoSweep = src.activeVibratoSweep;
  v.activeVibratoDepth = src.activeVibratoDepth;
  v.activeVibratoRate = src.activeVibratoRate;
  v.activeVibratoWaveform = src.activeVibratoWaveform;
  v.activePatchIndex = src.activePatchIndex; // stem tap: the ghost keeps the patch it sounded
  // A ghost of a stereo note keeps playing BOTH channels, with its own copy of
  // the second channel's filter/crusher history (same rule as the voice's own).
  v.activeChanCount = src.activeChanCount;
  v.activeChanMode = src.activeChanMode;
  v.activeChanPtr2 = src.activeChanPtr2;
  v.right.copyFrom(src.right);
  // Active-envelope view follows too — ghosts keep their patch's envelopes.
  v.activeVolEnv = src.activeVolEnv;
  v.activeVolEnvLoop = src.activeVolEnvLoop;
  v.activeVolEnvSustain = src.activeVolEnvSustain;
  v.activePanEnv = src.activePanEnv;
  v.activePanEnvLoop = src.activePanEnvLoop;
  v.activePanEnvSustain = src.activePanEnvSustain;
  v.activePitchEnv = src.activePitchEnv;
  v.activePitchEnvLoop = src.activePitchEnvLoop;
  v.activePitchEnvSustain = src.activePitchEnvSustain;
  v.activeFilterEnv = src.activeFilterEnv;
  v.activeFilterEnvLoop = src.activeFilterEnvLoop;
  v.activeFilterEnvSustain = src.activeFilterEnvSustain;
  v.activeFadeoutStep = src.activeFadeoutStep;
  v.activeDefaultCutoff = src.activeDefaultCutoff;
  v.activeDefaultResonance = src.activeDefaultResonance;
  v.activeAttenGain = src.activeAttenGain;
  return v;
}

/** Past-note action (S $70..$72) on all background voices spawned by channel. */
function applyPastNoteAction(eng, ts, channel, action) {
  switch (action) {
    case 0: { // Past Note Cut — drop them.
      for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
        if (ts.backgroundVoices[i].sourceChannel === channel) ts.backgroundVoices.splice(i, 1);
      }
      break;
    }
    case 1: // Past Note Off — sustain release.
      for (const bg of ts.backgroundVoices) {
        if (bg.sourceChannel === channel) {
          bg.keyOff = true;
          applyKeyLift(bg, eng.instruments[bg.instrumentId]);
        }
      }
      break;
    case 2: // Past Note Fade.
      for (const bg of ts.backgroundVoices) {
        if (bg.sourceChannel === channel) bg.noteFading = true;
      }
      break;
  }
}

/** Volume column (value = 6-bit field, sel = 2-bit selector). */
function applyVolColumn(ts, voice, value, sel) {
  // FINE packs its direction into the TOP bit of the column's value field, so
  // the flag and the magnitude mask move with the field's width (bit 5 of six,
  // bit 7 of eight). Everything else is the same in both formats — a wide
  // cell's numbers are simply four times as fine.
  const dirBit = ts.wideCells ? 0x80 : 0x20;
  switch (sel) {
    case 0:
      voice.noteVolume = clamp(value, 0, ts.volMax);
      voice.rowVolume = voice.noteVolume;
      break;
    case 1: voice.volColSlideUp = value; break;
    case 2: voice.volColSlideDown = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & (dirBit - 1);
      voice.noteVolume = (value & dirBit) !== 0
        ? Math.min(voice.noteVolume + mag, ts.volMax)
        : Math.max(voice.noteVolume - mag, 0);
      voice.rowVolume = voice.noteVolume;
      break;
    }
  }
}

/**
 * Pan column — the NOTE pan axis (item 117), the exact counterpart of the
 * volume column owning `note_vol` while M / N own `channel_vol`. All four
 * selectors write it, so a column SET places THIS note and leaves the channel's
 * own position (S $80xx, P, X, Z) standing underneath: on a zone-panned Ixmp
 * instrument the SET is what overrides the zone, and the channel commands are
 * what rotate it. There is consequently nothing left to arbitrate when a row
 * carries both a SET and an S $80xx — they address different registers, so both
 * apply.
 *
 * The 6-bit SET keeps its front-arc mapping in every surround model — the
 * column has no room for a 360° angle, and S $8xxx / X are the commands that
 * do. The slides, however, wrap with the rest of the pan machinery.
 */
function applyPanColumn(ts, voice, value, sel) {
  switch (sel) {
    case 0:
      applyNotePanSet(ts, voice, (value << 2) | (value >>> 4));
      break;
    case 1: voice.panColSlideRight = value; break;
    case 2: voice.panColSlideLeft = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & 0x1f;
      applyNotePanSlide(ts, voice, (value & 0x20) !== 0 ? mag : -mag);
      break;
    }
  }
}

/**
 * A WIDE cell's panning column (format version 3): a 9-bit azimuth and a signed
 * elevation, so the column alone can place a source anywhere on the sphere —
 * the six bits of the narrow cell only ever reached the front arc.
 *
 * Like the narrow column it is the NOTE axis (item 117) — the wide cell is the
 * same two lanes at higher resolution, exactly as its volume column is still
 * `note_vol` with a whole byte instead of six bits — so its azimuth and
 * elevation are both offsets from wherever the channel is pointing.
 *
 * The one exception is a `Z` slide on the same row, which turns the SET into
 * that slide's TARGET rather than a jump (the column says what effect `4` would
 * have said, and outranks a `4` on the same row for being the more specific
 * statement). A Z target names an absolute direction for the CHANNEL to travel
 * to, so on those rows — and only those — the column speaks for the channel.
 */
function applyPanColumnWide(ts, voice, row) {
  switch (row.panEff) {
    case 0: {
      if (rowSlidesSpatially(row)) {
        voice.spatialTargetAz = row.azimuth;
        voice.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? row.elevation : 0;
      } else {
        applyNotePanSet(ts, voice, row.azimuth);
        applyNoteElevation(ts, voice, row.elevation);
      }
      break;
    }
    // Slides rotate the azimuth by the LOW byte per tick; the elevation byte is
    // reserved for these selectors.
    case 1: voice.panColSlideRight = row.azimuth & 0xff; break;
    case 2: voice.panColSlideLeft = row.azimuth & 0xff; break;
    case 3: {
      const mag = row.azimuth & 0xff;
      if (mag === 0) return;
      applyNotePanSlide(ts, voice, (row.azimuth & 0x100) !== 0 ? mag : -mag);
      break;
    }
  }
}

/** Does this row arm a Z slide (in either effect slot)? */
function rowSlidesSpatially(row) {
  return (row.effect === EffectOp.OP_Z && (row.effectArg & 0xfff) !== 0) ||
         (row.effect2 === EffectOp.OP_Z && (row.effectArg2 & 0xfff) !== 0);
}

// ══ src/engine/effects.js ══
// Effect-column dispatch — port of AudioAdapter.kt resolveArg (3214),
// applyEffectRow (3216), applySEffect (3538), forEachLayerTarget (3633),
// applyFilterParamEffect (3650), applyRetrigVolMod (4090).
// Behavioural contract: TAUD_NOTE_EFFECTS.md; implementation truth: the Kotlin.








/** Scratch [azimuth, elevation] for the X / 4 argument decode. */
const spatialArg = new Float64Array(2);

/** Resolve a non-zero argument or recall from cohort memory. */
function resolveArg(arg, mem) { return arg !== 0 ? arg : mem; }

/**
 * `ext` (item 162): the argument of a `:` sharing this row with `op`, or null
 * when there isn't one (any Format 1/2 row, or a Format 3 row where `op`
 * isn't paired). Only OP_J / OP_O / OP_2 / OP_3 read it; every other case
 * ignores it, and a colon reaching this switch in its OWN slot (unpaired, or
 * paired with another colon) hits OP_COLON's bare `break` — a genuine no-op.
 */
function applyEffectRow(eng, ts, playhead, voice, vi, op, rawArg, ext = null) {
  switch (op) {
    case EffectOp.OP_NONE: break;
    case EffectOp.OP_COLON: break; // argument extension — a modifier, never a command of its own
    case EffectOp.OP_7:
      // Pattern Ditto marker — consumed by applyTrackerRow's row-time expansion.
      break;
    case EffectOp.OP_1: {
      // 1 $xx00 — Global behaviour flags in the high byte.
      const flags = rawArg >>> 8;
      playhead.updateTrackerGlobalBehaviour(flags);
      break;
    }
    // 2 spares the region it names; 3 modifies it. Same command otherwise.
    case EffectOp.OP_2: applySampleModEffect(eng, ts, voice, vi, rawArg, true, ext); break;
    case EffectOp.OP_3: applySampleModEffect(eng, ts, voice, vi, rawArg, false, ext); break;
    case EffectOp.OP_5: applyFilterParamEffect(eng, ts, voice, vi, rawArg, false); break;
    case EffectOp.OP_6: applyFilterParamEffect(eng, ts, voice, vi, rawArg, true); break;
    case EffectOp.OP_8: {
      // 8 $xyzz — Bitcrusher: x = clip mode, y = bit depth, zz = sample-skip.
      // The crusher is the CHANNEL's colouring, so it lands on every voice the
      // channel is sounding — a metainstrument's layer children included, or
      // only its first layer would be crushed (item 154).
      const x = (rawArg >>> 12) & 0xf;
      const y = (rawArg >>> 8) & 0xf;
      const z = rawArg & 0xff;
      forEachLayerTarget(ts, voice, vi, (v) => {
        v.clipMode = x & 3;
        if (rawArg === 0) {
          v.bitcrusherDepth = 0;
          v.bitcrusherSkip = 0;
          v.bitcrusherCounter = 0;
          v.right.bitcrusherCounter = 0;
        } else if (y === 0 && z === 0) {
          // x000 — clip mode only.
        } else {
          v.bitcrusherDepth = y;
          v.bitcrusherSkip = z;
          v.bitcrusherCounter = 0;
          v.right.bitcrusherCounter = 0;
        }
      });
      break;
    }
    case EffectOp.OP_9: {
      // 9 $x0zz — Overdrive: x = clip mode, zz = amplification index. Fans out
      // across a metainstrument exactly as the bitcrusher does (item 154).
      const x = (rawArg >>> 12) & 0xf;
      const z = rawArg & 0xff;
      forEachLayerTarget(ts, voice, vi, (v) => {
        v.clipMode = x & 3;
        if (rawArg === 0) v.overdriveAmp = 0;
        else if (z !== 0) v.overdriveAmp = z;
      });
      break;
    }
    case EffectOp.OP_A: {
      const tr = (rawArg >>> 8) & 0xff;
      if (tr !== 0) playhead.tickRate = tr;
      break;
    }
    case EffectOp.OP_B:
      if (ts.pendingOrderJump < 0) ts.pendingOrderJump = clamp(rawArg, 0, NUM_CUES - 1);
      break;
    case EffectOp.OP_C:
      if (ts.pendingRowJump < 0) ts.pendingRowJump = clamp(rawArg, 0, 63);
      break;
    case EffectOp.OP_D: {
      // Per-note volume slide: fine forms at tick 0, coarse arms slideMode 5.
      const arg = resolveArg(rawArg, voice.mem.d);
      if (rawArg !== 0) voice.mem.d = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) {
        voice.noteVolume = Math.min(voice.noteVolume + 0xf * ts.volStep, ts.volMax); voice.rowVolume = voice.noteVolume;
      } else if (hin === 0xf && lo !== 0) {
        voice.noteVolume = Math.max(voice.noteVolume - lo * ts.volStep, 0); voice.rowVolume = voice.noteVolume;
      } else if (lo === 0xf && hin !== 0) {
        voice.noteVolume = Math.min(voice.noteVolume + hin * ts.volStep, ts.volMax); voice.rowVolume = voice.noteVolume;
      } else if (hin === 0 && lo !== 0) {
        voice.slideMode = 5; voice.slideArg = -lo;
      } else if (lo === 0 && hin !== 0) {
        voice.slideMode = 5; voice.slideArg = hin;
      }
      break;
    }
    case EffectOp.OP_E: {
      const arg = resolveArg(rawArg, voice.mem.ef);
      if (rawArg !== 0) voice.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = arg & 0x0fff;
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(voice.noteVal, -mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(voice.noteVal, -mag);
        else nv = voice.noteVal - mag;
        voice.noteVal = clamp(nv, 0x20, 0xffff);
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
        voice.playbackRate = computePlaybackRate(voice, voice.noteVal, ts.tuningRatio);
      } else {
        voice.slideMode = 1; voice.slideArg = -arg;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_F: {
      const arg = resolveArg(rawArg, voice.mem.ef);
      if (rawArg !== 0) voice.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = arg & 0x0fff;
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(voice.noteVal, mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(voice.noteVal, mag);
        else nv = voice.noteVal + mag;
        voice.noteVal = clamp(nv, 0x20, 0xffff);
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
        voice.playbackRate = computePlaybackRate(voice, voice.noteVal, ts.tuningRatio);
      } else {
        voice.slideMode = 2; voice.slideArg = arg;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_G: {
      const arg = resolveArg(rawArg, voice.mem.g);
      if (rawArg !== 0) voice.mem.g = arg;
      voice.tonePortaSpeed = arg;
      break;
    }
    case EffectOp.OP_H: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.huSpeed = sp;
      if (dp !== 0) voice.mem.huDepth = dp;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 6;
      break;
    }
    case EffectOp.OP_I: {
      const arg = resolveArg(rawArg, voice.mem.i);
      if (rawArg !== 0) voice.mem.i = arg;
      voice.tremorOn = 1;
      voice.tremorOnTime = ((arg >>> 8) & 0xff) + 1;
      voice.tremorOffTime = (arg & 0xff) + 1;
      break;
    }
    case EffectOp.OP_J: {
      voice.arpActive = true;
      if (ext !== null) {
        // Extended (item 162): both bytes become full 16-bit 4096-TET deltas
        // instead of <<8-scaled ones — off1 is J's own arg, off2 the paired
        // colon's, order-independent. Private memory, separate from classic
        // J's (the units don't agree, so one must never recall the other).
        const off1 = resolveArg(rawArg, voice.mem.jExt1);
        const off2 = resolveArg(ext, voice.mem.jExt2);
        if (rawArg !== 0) voice.mem.jExt1 = off1;
        if (ext !== 0) voice.mem.jExt2 = off2;
        voice.arpOff1 = off1;
        voice.arpOff2 = off2;
      } else {
        const arg = resolveArg(rawArg, voice.mem.j);
        if (rawArg !== 0) voice.mem.j = arg;
        voice.arpOff1 = ((arg >>> 8) & 0xff) << 8;
        voice.arpOff2 = (arg & 0xff) << 8;
      }
      break;
    }
    case EffectOp.OP_K: {
      // K $xy00 — vibrato continuation + volume slide (down wins, ST3 quirk).
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (voice.mem.k = raw) : voice.mem.k;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 6;
      if (lo !== 0) voice.volColSlideDown = lo;
      else if (hi !== 0) voice.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_L: {
      // L $xy00 — tone-porta continuation + volume slide (porta speed from G's memory).
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (voice.mem.l = raw) : voice.mem.l;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      voice.tonePortaSpeed = voice.mem.g;
      if (lo !== 0) voice.volColSlideDown = lo;
      else if (hi !== 0) voice.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_M:
      // M $xx00 — set channel volume (literal, no recall; IT $40 clamps to $3F).
      // A wide cell's volume state is 8-bit, so the byte lands unscaled there.
      voice.channelVolume = Math.min((rawArg >>> 8) & 0xff, ts.volMax);
      break;
    case EffectOp.OP_N: {
      // N $xy00 — channel-volume slide (D nibble decoding, channel axis only).
      const arg = resolveArg(rawArg, voice.mem.n);
      if (rawArg !== 0) voice.mem.n = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) voice.channelVolume = Math.min(voice.channelVolume + 0xf * ts.volStep, ts.volMax);
      else if (hin === 0xf && lo !== 0) voice.channelVolume = Math.max(voice.channelVolume - lo * ts.volStep, 0);
      else if (lo === 0xf && hin !== 0) voice.channelVolume = Math.min(voice.channelVolume + hin * ts.volStep, ts.volMax);
      else if (hin === 0 && lo !== 0) voice.nSlideDir = -lo;
      else if (lo === 0 && hin !== 0) voice.nSlideDir = hin;
      break;
    }
    case EffectOp.OP_P: {
      // P $xy00 — channel-panning slide (IT convention: low nibble right, high left).
      const arg = resolveArg(rawArg, voice.mem.p);
      if (rawArg !== 0) voice.mem.p = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      // In a surround song the pan runs right round the circle: the slide
      // wraps where the stereo law clamps (TAUD_NOTE_EFFECTS.md, effect P).
      if (hi === 0xff || hi === 0xf0) {
        applyPanSlide(ts, voice, -0xf);
      } else if (hin === 0xf && lo !== 0) {
        applyPanSlide(ts, voice, lo);
      } else if (lo === 0xf && hin !== 0) {
        applyPanSlide(ts, voice, -hin);
      } else if (hin === 0 && lo !== 0) {
        voice.chanPanSlideRight = lo;
      } else if (lo === 0 && hin !== 0) {
        voice.chanPanSlideLeft = hin;
      }
      break;
    }
    case EffectOp.OP_O: {
      // Sample offset — clamps into the active sample's loop region.
      let off;
      if (ext !== null) {
        // Extended (item 162): O's own arg is the high word, the paired
        // colon's is the low word — a 32-bit offset. Combined ARITHMETICALLY,
        // never with `<<16`: that overflows into JS's signed 32-bit bitwise
        // domain the moment rawArg's top bit is set. Private memory, since a
        // 32-bit value doesn't fit where the classic 16-bit recall lives.
        const combined = rawArg * 65536 + ext;
        off = combined !== 0 ? combined : voice.mem.oExt;
        if (combined !== 0) voice.mem.oExt = combined;
      } else {
        off = resolveArg(rawArg, voice.mem.o);
        if (rawArg !== 0) voice.mem.o = off;
      }
      if ((voice.activeLoopMode & 3) !== 0 &&
          voice.activeSampleLoopEnd > voice.activeSampleLoopStart &&
          off > voice.activeSampleLoopEnd) {
        const loopLen = Math.max(voice.activeSampleLoopEnd - voice.activeSampleLoopStart, 1);
        off = voice.activeSampleLoopStart + ((off - voice.activeSampleLoopStart) % loopLen);
      }
      voice.samplePos = off;
      break;
    }
    case EffectOp.OP_Q: {
      // Q $xy00 — x = retrigVolMod (bits 12-15), y = retrigInterval (bits 8-11).
      const arg = resolveArg(rawArg, voice.mem.q);
      const y = (arg >>> 8) & 0xf;
      if (y !== 0) {
        voice.mem.q = arg;
        voice.retrigInterval = y;
        voice.retrigVolMod = (arg >>> 12) & 0xf;
        voice.retrigActive = true;
        // Counter persists across rows per spec.
      }
      // y == 0 → entire effect ignored, even memory.
      break;
    }
    case EffectOp.OP_R: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.rSpeed = sp;
      if (dp !== 0) voice.mem.rDepth = dp;
      voice.tremoloActive = true;
      break;
    }
    case EffectOp.OP_S: applySEffect(eng, ts, voice, vi, rawArg); break;
    case EffectOp.OP_T: {
      const hi = (rawArg >>> 8) & 0xff;
      if (hi === 0xff) {
        // T $FFxx — extended set-tempo: BPM = $xx + $118 (280..535).
        playhead.bpm = clamp((rawArg & 0xff) + 0x118, 25, 535);
      } else if (hi !== 0) {
        // T $xx00 — set-tempo: BPM = $xx + $19 (25..280).
        playhead.bpm = clamp(hi + 0x19, 25, 535);
      } else {
        const low = rawArg & 0xff;
        switch (low & 0xf0) {
          case 0x00: voice.tempoSlideDir = -1; voice.tempoSlideAmount = low & 0x0f; voice.mem.tslide = low; break;
          case 0x10: voice.tempoSlideDir = +1; voice.tempoSlideAmount = low & 0x0f; voice.mem.tslide = low; break;
        }
      }
      break;
    }
    case EffectOp.OP_U: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.huSpeed = sp;
      if (dp !== 0) voice.mem.huDepth = dp;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 8;
      break;
    }
    case EffectOp.OP_V:
      playhead.globalVolume = (rawArg >>> 8) & 0xff;
      break;
    case EffectOp.OP_W: {
      const arg = resolveArg(rawArg, voice.mem.w);
      if (rawArg !== 0) voice.mem.w = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff) playhead.globalVolume = Math.min(playhead.globalVolume + 0xf, 0xff);
      else if (hin === 0xf && lo !== 0) playhead.globalVolume = Math.max(playhead.globalVolume - lo, 0);
      else if (lo === 0xf && hin !== 0) playhead.globalVolume = Math.min(playhead.globalVolume + hin, 0xff);
      else if (hin === 0 && lo !== 0) { voice.wSlideDir = -1; voice.wSlideAmount = lo; }
      else if (lo === 0 && hin !== 0) { voice.wSlideDir = +1; voice.wSlideAmount = hin; }
      break;
    }
    case EffectOp.OP_Y: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.ySpeed = sp;
      if (dp !== 0) voice.mem.yDepth = dp;
      voice.panbrelloActive = true;
      break;
    }
    // ── Spatial panning (#998.2) — reserved for songs whose surround model
    //    says so; a stereo song ignores all three (converters are required to
    //    turn IT's X "fine set panning" into S $80xx instead).
    case EffectOp.OP_X: {
      // X $eeaa — place the source: azimuth $aa over the full turn, elevation
      // $ee signed ($80 = −90°, $7F ≈ +90°). Channel axis, not note axis —
      // applyPanSet is the SAME call S $80xx makes (case 0x8 below), so the two
      // share one register and either can overwrite the other's azimuth.
      if (ts.surroundModel === SURROUND_STEREO) break;
      anglesFromSpatialArg(rawArg, spatialArg);
      applyPanSet(ts, voice, spatialArg[0]);
      applyElevation(ts, voice, spatialArg[1]);
      break;
    }
    case EffectOp.OP_4:
      // 4 $eeaa — where a Z slide is heading. Channel state: it outlives the row.
      if (ts.surroundModel === SURROUND_STEREO) break;
      anglesFromSpatialArg(rawArg, spatialArg);
      voice.spatialTargetAz = spatialArg[0];
      voice.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? spatialArg[1] : 0.0;
      break;
    case EffectOp.OP_Z: {
      // Z $Ffxx — funk repeat, ProTracker 1.0C's EFx (item 161), with item
      // 163's walk selector in `$f`. Not a spatial command at all: Z
      // multiplexes on its first nibble the way S does, and this form is live
      // in EVERY song, stereo included. `xx` is the funk ladder's speed value,
      // the same 8-bit scale S $F0xx reads, and `$f` picks the walk that speed
      // drives — `$0` being 1.0C's own, so every `Z $F0xx` ever written keeps
      // meaning what it meant.
      //
      // Speed and walk are both CHANNEL state and sticky (PT kept the speed in
      // n_glissfunk's high nibble, alongside glissando's low one), and writing
      // either leaves the accumulator running — PT's mt_FunkIt never cleared
      // n_funkoffset, not on a speed change and not on Z $F000, so the phase
      // carries across the lot. The walk is written even by `Z $Ff00`, which
      // arms a mode for the speed that follows it.
      if ((rawArg & 0xf000) === 0xf000) {
        voice.funkMode = (rawArg >>> 8) & 0xf;
        voice.funkSpeed = rawArg & 0xff;
        break;
      }
      // Z $0xxx — arm the slide for this row at $xxx/16 azimuth units per tick.
      if (ts.surroundModel === SURROUND_STEREO) break;
      const raw = rawArg & 0xfff;
      const arg = resolveArg(raw, voice.mem.z);
      if (raw !== 0) voice.mem.z = arg;
      if (arg !== 0) voice.spatialSlideActive = true;
      break;
    }
  }
}

function applySEffect(eng, ts, voice, vi, arg) {
  const sub = (arg >>> 12) & 0xf;
  const x = (arg >>> 8) & 0xf;
  switch (sub) {
    case 0x0:
      // S $0000 = LED filter on, S $0100 = off (PT E00/E01); Amiga modes only.
      if (ts.interpolationMode === INTERP_A500 || ts.interpolationMode === INTERP_A1200) {
        ts.ledFilterOn = x === 0;
      }
      break;
    case 0x1: voice.glissandoOn = x !== 0; break;
    case 0x2:
      voice.noteVal = clamp(voice.noteVal + FINETUNE_OFFSET[x], 0x20, 0xffff);
      voice.basePitch = voice.noteVal;
      voice.amigaPeriod = -1.0;
      voice.linearFreq = -1.0;
      voice.playbackRate = computePlaybackRate(voice, voice.noteVal, ts.tuningRatio);
      break;
    case 0x3: voice.vibratoWave = x & 3; voice.vibratoRetrig = (x & 4) === 0; break;
    case 0x4: voice.tremoloWave = x & 3; voice.tremoloRetrig = (x & 4) === 0; break;
    case 0x5: voice.panbrelloWave = x & 3; voice.panbrelloRetrig = (x & 4) === 0; break;
    case 0x6: ts.finePatternDelayExtra += x; break;
    case 0x7: {
      // S$7x — Note/Instrument actions. $0..$6 are no-ops on a metainstrument;
      // $7..$E fan out across the meta's constituents (forEachLayerTarget).
      const isMeta = voice.metaForeground;
      switch (x) {
        case 0x0: if (!isMeta) applyPastNoteAction(eng, ts, vi, 0); break;
        case 0x1: if (!isMeta) applyPastNoteAction(eng, ts, vi, 1); break;
        case 0x2: if (!isMeta) applyPastNoteAction(eng, ts, vi, 2); break;
        case 0x3: if (!isMeta) voice.nnaOverride = 1; break; // NNA Note Cut
        case 0x4: if (!isMeta) voice.nnaOverride = 2; break; // NNA Note Continue
        case 0x5: if (!isMeta) voice.nnaOverride = 0; break; // NNA Note Off
        case 0x6: if (!isMeta) voice.nnaOverride = 3; break; // NNA Note Fade
        case 0x7: forEachLayerTarget(ts, voice, vi, (v) => { v.volEnvOn = false; }); break;
        case 0x8: forEachLayerTarget(ts, voice, vi, (v) => { v.volEnvOn = true; }); break;
        case 0x9: forEachLayerTarget(ts, voice, vi, (v) => { v.panEnvOn = false; }); break;
        case 0xa: forEachLayerTarget(ts, voice, vi, (v) => { v.panEnvOn = true; }); break;
        // $B/$C: pitch env when defined, else filter env (IT "pitch or filter").
        case 0xb: forEachLayerTarget(ts, voice, vi, (v) => {
          if (v.hasPitchEnv) v.pitchEnvOn = false; else if (v.hasFilterEnv) v.filterEnvOn = false;
        }); break;
        case 0xc: forEachLayerTarget(ts, voice, vi, (v) => {
          if (v.hasPitchEnv) v.pitchEnvOn = true; else if (v.hasFilterEnv) v.filterEnvOn = true;
        }); break;
        case 0xd: forEachLayerTarget(ts, voice, vi, (v) => { v.filterEnvOn = false; }); break;
        case 0xe: forEachLayerTarget(ts, voice, vi, (v) => { v.filterEnvOn = true; }); break;
      }
      break;
    }
    case 0x8:
      // S$80xx — full 8-bit pan. A surround song reads one bit more (#998.1):
      // S$8xxx is a 9-bit angle, $000 left · $080 front · $100 right · $180
      // behind, of which $000..$0FF are exactly the old pan bytes.
      applyPanSet(ts, voice, arg & (ts.surroundModel === SURROUND_STEREO ? 0xff : 0x1ff));
      break;
    case 0xb:
      if (x === 0) voice.loopStartRow = ts.rowIndex;
      else {
        if (voice.loopCount === 0) {
          voice.loopCount = x;
          ts.pendingRowJump = voice.loopStartRow;
          ts.pendingRowJumpLocal = true;
        } else if (!ts.patternDelayActive) {
          voice.loopCount--;
          if (voice.loopCount > 0) {
            ts.pendingRowJump = voice.loopStartRow;
            ts.pendingRowJumpLocal = true;
          }
        }
      }
      break;
    case 0xc: if (x !== 0) voice.cutAtTick = x; break;
    case 0xd: break; // note delay — handled in the row's note section
    case 0xe:
      // Pattern delay — first SEx in ascending channel order wins.
      if (ts.sexWinningChannel < 0) {
        ts.sexWinningChannel = vi;
        ts.patternDelayRemaining = x;
      }
      break;
    case 0xf:
      // S $F0xx — invert loop. `$x` is RESERVED (item 163.1 paints it dim), so
      // it is not read: every spelling of the command clears the accumulator,
      // which is the difference from Z $Ffxx's free-running phase.
      voice.invertSpeed = arg & 0xff;
      voice.invertAccumulator = 0;
      break;
  }
}

/**
 * notefx 2 and notefx 3 — the sample-modification command (item 130). `invert`
 * is what tells them apart: `3 $sexy` names the region to modify, `2 $sexy`
 * names the region to LEAVE ALONE. Everything else is identical, and an
 * instrument carries ONE modification, so either opcode replaces it.
 *
 *   $se  region        $x  operation (0 = reset)      $y  step period in ticks
 *
 * The state splits the way S $Fxxx's does: the modification belongs to the
 * INSTRUMENT (every channel sounding it hears the same sample) and the clock
 * driving it to the CHANNEL. A reserved region is ignored WHOLE, speed and all,
 * so a typo cannot drive a modification the writer never named.
 */
function applySampleModEffect(eng, ts, voice, vi, rawArg, invert, ext = null) {
  if (ext !== null) {
    applySampleModEffectExt(eng, ts, voice, vi, rawArg, invert, ext);
    return;
  }
  const op = (rawArg >>> 4) & 0xf;
  // A metainstrument is one note made of several instruments, so the command
  // reaches all of them — otherwise only layer 0's sample would ever be
  // modified (item 154). One CLOCK per instrument per channel, though: two
  // layers sounding the same instrument must not step it twice a tick, which is
  // what the `seen` set below is for. Non-meta channels have one target and
  // behave exactly as before.
  const seen = new Set();
  forEachLayerTarget(ts, voice, vi, (v) => {
    const inst = eng.instruments[v.instrumentId];
    const dup = seen.has(v.instrumentId);
    seen.add(v.instrumentId);
    if (op === MOD_OFF) {
      if (!dup) inst.resetMod();
      v.modPeriod = 0;
      v.modTickCount = 0;
      v.modWritePos = 0;
      v.modExtended = false;
      return;
    }
    const code = decodeSampleRegion((rawArg >>> 8) & 0xff, regionScratch);
    if (code === REGION_NONE) return;
    if (dup) { v.modPeriod = 0; return; }
    const moved = code === REGION_COMB
      ? inst.setModComb(regionScratch[2], regionScratch[3] !== 0)
      : inst.setModRegion(regionScratch[0], regionScratch[1]);
    const swapped = inst.setModOp(op, invert);
    // A changed region or operation restarts the walk; re-stating the SAME
    // command row after row must not, or it would never get past its first step.
    if (moved || swapped) {
      v.modTickCount = 0;
      v.modWritePos = 0;
    }
    v.modPeriod = modStepPeriod(rawArg & 0xf);
    v.modExtended = false;
  });
}

/**
 * Extended notefx 2/3 (item 162, `2`/`3 $sexy : $fuuk`): `$se` region as
 * above, `$f` a further sub-range (samplemod.js fModTouches), `$xuu` a 12-bit
 * operation replacing `$x`'s 4-bit one, `$yk` a two-digit speed replacing
 * `$y`'s one-digit ladder, clocked in samples rather than whole ticks (see
 * voice.modStepTicks / mixer.js's per-sample accumulator).
 */
function applySampleModEffectExt(eng, ts, voice, vi, rawArg, invert, ext) {
  const f = (ext >>> 12) & 0xf;
  const xuu = (((rawArg >>> 4) & 0xf) << 8) | ((ext >>> 4) & 0xff);
  const yk = ((rawArg & 0xf) << 4) | (ext & 0xf);
  const seen = new Set();
  forEachLayerTarget(ts, voice, vi, (v) => {
    const inst = eng.instruments[v.instrumentId];
    const dup = seen.has(v.instrumentId);
    seen.add(v.instrumentId);
    if (xuu === 0) {
      if (!dup) inst.resetMod();
      v.modPeriod = 0;
      v.modTickCount = 0;
      v.modWritePos = 0;
      v.modExtended = false;
      v.modStepTicks = 0;
      v.modSamplesIntoStep = 0;
      return;
    }
    const code = decodeSampleRegion((rawArg >>> 8) & 0xff, regionScratch);
    if (code === REGION_NONE) return;
    if (dup) { v.modPeriod = 0; v.modExtended = false; return; }
    const moved = code === REGION_COMB
      ? inst.setModComb(regionScratch[2], regionScratch[3] !== 0)
      : inst.setModRegion(regionScratch[0], regionScratch[1]);
    const swapped = inst.setModOpExt(xuu, invert, f);
    if (moved || swapped) {
      v.modTickCount = 0;
      v.modWritePos = 0;
      v.modSamplesIntoStep = 0;
    }
    v.modPeriod = 0;
    v.modExtended = true;
    v.modStepTicks = extYkPeriodTicks(yk);
  });
}

/**
 * Every voice channel `vi` is sounding as ONE note: the foreground voice plus —
 * for a metainstrument — its layer children. Anything the pattern says about
 * the note as a whole goes through here (env toggles S $77..$7E, the bitcrusher
 * and overdrive, the sample-modification command), or it would reach layer 0
 * alone and leave the rest of the kit untouched (item 154). An ordinary
 * instrument has no layer children, so only the foreground voice is visited.
 */
function forEachLayerTarget(ts, voice, vi, action) {
  action(voice);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) action(bg);
  }
}

/**
 * notefx 5 (cutoff) / 6 (resonance) — instrument-wide filter parameter control.
 * $FFFF clears the override; IT mode takes the high byte, SF mode the full 16 bits.
 */
function applyFilterParamEffect(eng, ts, voice, vi, rawArg, isResonance) {
  const targets = new Set();
  targets.add(voice.instrumentId);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) targets.add(bg.instrumentId);
  }

  for (const id of targets) {
    const ti = eng.instruments[id];
    let value;
    if (rawArg === 0xffff) value = -1;
    else if (ti.filterSfMode) value = rawArg & 0xffff;
    else value = (rawArg >>> 8) & 0xff;
    if (isResonance) ti.resonanceOverride = value;
    else ti.cutoffOverride = value;
  }

  const push = (v) => {
    if (!targets.has(v.instrumentId)) return;
    const ti = eng.instruments[v.instrumentId];
    // The override is instrument-wide and ABSOLUTE: while one is in force every
    // voice takes it, patch or not. Clearing it ($FFFF) must return each voice
    // to its OWN default, and for a voice sounding an Ixmp patch with an 'x'
    // block that is the PATCH's value — falling back to the base record would
    // retune a patched voice's filter and, when the two disagree on SF vs IT
    // mode, reinterpret the number in the wrong units (item 116).
    const patch = patchAt(ti, v.activePatchIndex);
    const patchExtra = patch !== null && patch.hasExtra;
    const overridden = ti.cutoffOverride >= 0 || ti.resonanceOverride >= 0;
    v.filterSfMode = patchExtra && !overridden ? patch.filterSfMode : ti.filterSfMode;
    if (isResonance) {
      v.activeDefaultResonance = ti.resonanceOverride < 0 && patchExtra
        ? patch.extraResonance : ti.defaultResonance16;
      v.currentResonance = v.activeDefaultResonance;
    } else {
      v.activeDefaultCutoff = ti.cutoffOverride < 0 && patchExtra
        ? patch.extraCutoff : ti.defaultCutoff16;
      v.currentCutoff = v.activeDefaultCutoff;
    }
    v.filterCutoffCached = -1;
    v.filterResonanceCached = -1;
  };
  for (const v of ts.voices) if (v.active) push(v);
  for (const bg of ts.backgroundVoices) if (bg.active) push(bg);
}

/** Q's volume modifiers. The additive cases are stated in 6-bit units, so they
 *  scale with the cell format the way every other nibble delta does; the
 *  multiplicative ones are ratios and do not. */
function applyRetrigVolMod(vol, x, step = 1, max = 0x3f) {
  let v;
  switch (x & 0xf) {
    case 0: case 8: v = vol; break;
    case 1: v = vol - 0x01 * step; break;
    case 2: v = vol - 0x02 * step; break;
    case 3: v = vol - 0x04 * step; break;
    case 4: v = vol - 0x08 * step; break;
    case 5: v = vol - 0x10 * step; break;
    case 6: v = Math.trunc((vol * 2) / 3); break;
    case 7: v = vol >> 1; break;
    case 9: v = vol + 0x01 * step; break;
    case 0xa: v = vol + 0x02 * step; break;
    case 0xb: v = vol + 0x04 * step; break;
    case 0xc: v = vol + 0x08 * step; break;
    case 0xd: v = vol + 0x10 * step; break;
    case 0xe: v = Math.trunc((vol * 3) / 2); break;
    case 0xf: v = vol << 1; break;
    default: v = vol; break;
  }
  return clamp(v, 0, max);
}

// ══ src/engine/row.js ══
// Row processing + cue advance — port of AudioAdapter.kt applyTrackerRow (2948),
// advanceTrackerCue (4101), resetPatternLoopState (4117), advanceRow (4343).








/**
 * The argument an Int0..IntF marker on this row carries (item 181): the `:`
 * sharing the row, or 0 when there is none — an interrupt with nothing to say
 * still fires, it just says 0.
 *
 * Which `:`, when a wide cell holds two, is the one rule the format needs
 * here: **the first slot wins**. A row carrying only one `:` means the same
 * thing in either slot, so a composer never has to think about column order;
 * a row carrying two has to resolve somehow, and "the left one" is the rule a
 * reader can apply at a glance (the editor paints the losing cell red —
 * src/ui/notenames.js fxColonWarns). Format 1/2 has no second slot, so the
 * question cannot arise there and the first slot is simply the only slot.
 *
 * This reads the `:` WITHOUT consuming it: the same colon still extends a
 * J / O / 2 / 3 sharing the row, exactly as it would on a row with no
 * interrupt marker on it.
 */
function interruptArgOf(ts, row) {
  if (row.effect === EffectOp.OP_COLON) return row.effectArg & 0xffff;
  if (ts.wideCells && row.effect2 === EffectOp.OP_COLON) return row.effectArg2 & 0xffff;
  return 0;
}

/** S $Dxny (item 94, extended item 97): schedule the $n follow-up action at
 *  absolute tick $x+$y within the row (independent of whichever note-event
 *  branch deferred the trigger by $x, or fired it immediately when $x is 0,
 *  or — on a note-less row — deferred nothing at all, see the `note === 0`
 *  caller). No-op unless $y is nonzero — a zero $y never carries an action
 *  (TAUD_NOTE_EFFECTS.md "S $Dxny" table: "If $y is zero" has no action row).
 *  A schedule past the row's tick count self-discards: tick.js only fires on
 *  an exact tickInRow match, and row entry unconditionally resets
 *  noteActionTick to -1 before the next row's ticks can reach it — the same
 *  trick sDelayTick relies on. */
function scheduleDxnyAction(voice, row, delayTick) {
  if (row.effect !== EffectOp.OP_S || ((row.effectArg >>> 12) & 0xf) !== 0xd) return;
  const y = row.effectArg & 0xf;
  if (y === 0) return;
  voice.noteActionTick = delayTick + y;
  voice.delayedAction = (row.effectArg >>> 4) & 0xf;
}

function applyTrackerRow(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  // Reset row-scope state before scanning channels.
  if (!ts.patternDelayActive) ts.sexWinningChannel = -1;
  ts.finePatternDelayExtra = 0;

  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rawRow = eng.patternRead(patIdx)[ts.rowIndex];
    const voice = ts.voices[vi];

    // ── Pattern Ditto (effect 7) row-time expansion ──
    const n = ts.rowIndex;
    const isArmer = rawRow.effect === EffectOp.OP_7 && rawRow.effectArg !== 0;
    if (isArmer) {
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        const patLen = cue.rowLimit();
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave previously-armed ditto state alone.
    }

    const dittoArmRow = voice.dittoSourceStart + voice.dittoLength;
    let row;
    if (voice.dittoActive && n >= dittoArmRow && n <= voice.dittoEndRow) {
      const rel = (n - voice.dittoSourceStart) % voice.dittoLength;
      const srcRow = voice.dittoSourceStart + rel;
      const src = eng.patternRead(patIdx)[srcRow];

      // Vol-/pan-column "no-op" sentinel is SEL_FINE (3) with value 0 — in a
      // wide cell the pan column's "value" is the azimuth AND the elevation.
      const volIsSet = !(rawRow.volumeEff === 3 && rawRow.volume === 0);
      const panIsSet = ts.wideCells
        ? !(rawRow.panEff === 3 && rawRow.azimuth === 0 && rawRow.elevation === 0)
        : !(rawRow.panEff === 3 && rawRow.pan === 0);

      const destOp = isArmer ? 0 : rawRow.effect;
      const destArg = isArmer ? 0 : rawRow.effectArg;
      let effOp, effArg;
      if (destOp !== 0) { effOp = destOp; effArg = destArg; }
      else if (src.effect !== EffectOp.OP_7) { effOp = src.effect; effArg = src.effectArg; }
      else { effOp = 0; effArg = 0; }

      row = new TaudPlayData();
      row.note = rawRow.note !== 0x0000 ? rawRow.note : src.note;
      row.instrment = rawRow.instrment !== 0 ? rawRow.instrment : src.instrment;
      row.volume = volIsSet ? rawRow.volume : src.volume;
      row.volumeEff = volIsSet ? rawRow.volumeEff : src.volumeEff;
      row.pan = panIsSet ? rawRow.pan : src.pan;
      row.panEff = panIsSet ? rawRow.panEff : src.panEff;
      row.azimuth = panIsSet ? rawRow.azimuth : src.azimuth;
      row.elevation = panIsSet ? rawRow.elevation : src.elevation;
      row.effect = effOp;
      row.effectArg = effArg;
      // The second effect follows the first: a ditto that inherits one command
      // inherits the pair the source row actually carried.
      const dittoUsedSrc = destOp === 0 && effOp !== 0;
      row.effect2 = dittoUsedSrc ? src.effect2 : rawRow.effect2;
      row.effectArg2 = dittoUsedSrc ? src.effectArg2 : rawRow.effectArg2;
    } else {
      row = rawRow;
    }

    // Reset per-row transient state.
    voice.cutAtTick = -1;
    voice.noteDelayTick = -1;
    voice.noteActionTick = -1;
    voice.delayedAction = -1;
    voice.slideMode = 0;
    voice.slideArg = 0;
    voice.arpActive = false;
    voice.tremorOn = 0;
    voice.vibratoActive = false;
    voice.tremoloActive = false;
    voice.panbrelloActive = false; // the offset itself is the tick pass's (tick.js)
    voice.retrigActive = false;
    voice.tempoSlideDir = 0;
    voice.wSlideDir = 0;
    voice.volColSlideUp = 0; voice.volColSlideDown = 0;
    voice.panColSlideRight = 0; voice.panColSlideLeft = 0;
    voice.chanPanSlideRight = 0; voice.chanPanSlideLeft = 0;
    voice.spatialSlideActive = false; // Z re-arms per row, like every other slide
    voice.nSlideDir = 0;
    voice.rowEffect = row.effect;
    voice.rowEffectArg = row.effectArg;
    // Row boundary: rebase rowVolume to the persistent noteVolume.
    voice.rowVolume = voice.noteVolume;

    // ── Note ──
    // OP_L also takes a porta target without retriggering (continues a G porta).
    const toneG = row.effect === EffectOp.OP_G || row.effect === EffectOp.OP_L;
    const note = row.note;
    const sDelayTick = row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd
      ? (row.effectArg >>> 8) & 0xf : 0;

    if (note === 0x0000) {
      const pitchFx = row.effect === EffectOp.OP_E || row.effect === EffectOp.OP_F ||
        row.effect === EffectOp.OP_G;
      if (row.instrment !== 0 && pitchFx && voice.noteVal >= 0x20) {
        // Note 0 + instrument + a pitch effect (E porta-down / F porta-up /
        // G tone-porta) TRIGGERS the note at the voice's current pitch, so the
        // slide has a sounding note to move — previously this only latched the
        // instrument and stayed silent (item 43; needs the same TSVM fix).
        applyDuplicateCheck(eng, ts, vi, row.instrment, voice.noteVal);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, voice.noteVal, row.instrment, trigVol);
      } else if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
        // No note + instrument byte: latch instrument, re-seed from its DNV
        // (PT/FT2/IT/Schism all do this; see AudioAdapter.kt:3050-3061).
        voice.instrumentId = row.instrment;
        const newInst = eng.instruments[voice.instrumentId];
        const newPatch = newInst.resolvePatch(voice.noteVal,
          narrowVolAxis(ts, voice.noteVolume));
        // applyActiveSample without retrigger (Schism csf_instrument_change).
        applyInstrumentChange(eng, ts, voice, newInst, newPatch);
      }
      // A note-less row has nothing for S$D's $x to trigger, but the $n
      // follow-up action still applies to whatever voice is already sounding
      // (TAUD_NOTE_EFFECTS.md: FastTracker Kxx → S $D00xx, OpenMPT :xy →
      // S $Dx1y — both act on the current note without a note column entry).
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0001) {
      // Key-off (sub-row delay via S$Dx defers it).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0001;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.keyOff = true;
        applyKeyLift(voice, eng.instruments[voice.instrumentId]);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0002) {
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0002;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startCutRamp(voice);
        cutLayerChildren(ts, vi);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0004) {
      // Fast note-fade (SF2 exclusiveClass choke).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0004;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startFastFade(voice, playhead);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0003) {
      // IT-style note fade: fadeout without sustain release.
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0003;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.noteFading = true;
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note >= 0x0005 && note <= 0x000f) {
      // reserved sentinel range, no engine handler
    } else if (note >= 0x0010 && note <= 0x001f) {
      // Int0..IntF: latch the interrupt, and the argument a `:` on the same row
      // hands it (item 181), for the host to drain. The marker itself produces
      // no sound and touches no voice state; every other column on the row —
      // instrument, volume, panning, a second effect — is the interrupt's
      // business not at all, and still does whatever it would ordinarily do.
      //
      // A sub-row `S $Dx` defers it exactly as it defers a key-off or a cut:
      // a tick is 20 ms at the default tempo, which is well inside what a
      // lighting or animation cue can be heard to miss. `x >= speed` therefore
      // discards the marker with the rest of the row's note event (the row
      // reset above clears noteDelayTick, so it cannot leak into the next row
      // either) — a delay that never arrives fires nothing, which is what the
      // same argument says for a note that never sounds.
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = note;
        voice.delayedInst = 0; voice.delayedVol = -1;
        voice.delayedInterruptArg = interruptArgOf(ts, row);
      } else {
        ts.pendingInterrupts |= 1 << (note - 0x0010);
        ts.interruptArgs[note - 0x0010] = interruptArgOf(ts, row);
      }
    } else {
      if (toneG && voice.active) {
        // Tone porta: target the note, do not retrigger sample.
        //
        // `note` is the pattern's raw note word, but a metainstrument's
        // foreground voice does not sound it directly — triggerMetaOrNote /
        // triggerFmRack seed voice.noteVal from `note + layer0's own detune`
        // (or, when layer 0 is fixed-pitch, from a pitch that ignores `note`
        // entirely), so the target has to cross into that same coordinate or
        // the glide chases a point that is a whole detune away from where it
        // actually needs to land — arriving late if at all, so the NEXT G row
        // retargets it before it gets there and the bend never seems to stop
        // (item 176). An ordinary instrument's foreground carries no such
        // offset (metaForegroundDetune stays 0), so this is a no-op for it.
        voice.tonePortaTarget = voice.metaForeground && voice.layerFixedNote >= 0
          ? -1 // layer 0 is fixed-pitch: its note never tracked the trigger, so there is nothing to glide to
          : clamp(note + voice.metaForegroundDetune, 0x20, 0xffff);
        // Inst byte on a porta row reloads the default volume + clears fade state
        // without retriggering (Schism csf_instrument_change semantics), and
        // RE-ATTACKS the envelopes: the instrument byte is what makes a porta
        // row after a key-off audible again (item 124). FT2 runs its whole
        // retrigEnvelopeVibrato here — envelope playheads back to node 0,
        // sustain re-armed, fadeout reset — and only the sample position stays
        // put. Without the playhead half, a release that had already decayed
        // stayed decayed and swallowed the note.
        if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
          // Envelope carry (item 169.1) applies to THIS re-attack too, and this
          // is the row shape it was asked for: a chain of notes tied by G, each
          // naming its instrument. Same disqualifiers as a fresh trigger — a
          // released note, or an instrument change — read before either is
          // overwritten below.
          const mayCarry = !voice.keyOff && !voice.noteFading
            && row.instrment === voice.instrumentId;
          voice.instrumentId = row.instrment;
          const newInst = eng.instruments[voice.instrumentId];
          const newPatch = newInst.resolvePatch(voice.noteVal,
            narrowVolAxis(ts, voice.noteVolume));
          applyInstrumentChange(eng, ts, voice, newInst, newPatch, true, mayCarry);
        }
      } else if (row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd) {
        // Note delay: defer trigger; NNA fires when the deferred trigger executes.
        voice.noteDelayTick = (row.effectArg >>> 8) & 0xf;
        voice.delayedNote = note;
        voice.delayedInst = row.instrment;
        // Only a SEL_SET vol cell is an override on the deferred trigger.
        voice.delayedVol = row.volumeEff === 0 ? row.volume : -1;
        scheduleDxnyAction(voice, row, sDelayTick);
      } else {
        applyDuplicateCheck(eng, ts, vi, row.instrment, note);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, note, row.instrment, trigVol);
        scheduleDxnyAction(voice, row, sDelayTick);
      }
    }

    // ── Volume / pan columns ──
    applyVolColumn(ts, voice, row.volume, row.volumeEff);
    if (ts.wideCells) applyPanColumnWide(ts, voice, row);
    else applyPanColumn(ts, voice, row.pan, row.panEff);

    // ── Effect columns ──
    // A wide cell carries two, applied in order, so the second lands last where
    // both write the same channel state.
    //
    // Argument extension (item 162): a `:` in either slot is a modifier, not a
    // command of its own — it hands its argument to whichever OTHER effect
    // shares the row, order-independent ("J : " reads the same as ": J").
    // Format 1/2 has no second slot, so pairing is structurally impossible
    // there — the no-op the TODO requires falls out for free rather than
    // needing a format-version check inside every consumer.
    let ext1 = null, ext2 = null;
    if (ts.wideCells) {
      if (row.effect === EffectOp.OP_COLON && row.effect2 !== EffectOp.OP_COLON) {
        ext2 = row.effectArg;
      } else if (row.effect2 === EffectOp.OP_COLON && row.effect !== EffectOp.OP_COLON) {
        ext1 = row.effectArg2;
      }
    }
    applyEffectRow(eng, ts, playhead, voice, vi, row.effect, row.effectArg, ext1);
    if (ts.wideCells && row.effect2 !== 0) {
      applyEffectRow(eng, ts, playhead, voice, vi, row.effect2, row.effectArg2, ext2);
    }
  }
}

// Shared "instrument byte without retrigger" path (no-note-inst and porta+inst rows).
// `reAttack` additionally rewinds the four envelope playheads the way a fresh
// trigger does (triggerNote), WITHOUT touching the sample position — the porta
// row's half of FT2 retrigEnvelopeVibrato. A note-less instrument byte does not
// re-attack: FT2 leaves such a row decaying, and re-arming its sustain would
// hold a released note up for ever.

function applyInstrumentChange(eng, ts, voice, newInst, newPatch,
                              reAttack = false, mayCarry = false) {
  applyActiveSample(voice, newInst, newPatch);
  const seedVol = rowVolumeFromDefault(newInst, newPatch, ts.volMax);
  voice.noteVolume = seedVol;
  voice.rowVolume = seedVol;
  voice.keyOff = false;
  voice.noteFading = false;
  voice.fadeoutVolume = 1.0;
  if (!reAttack) return;
  if (!(mayCarry && envCarry(voice.activeVolEnvLoop))) {
    voice.envIndex = 0;
    voice.envTimeSec = 0.0;
    voice.envVolume = clamp(voice.activeVolEnv[0].value / 63.0, 0.0, 1.0);
  }
  // envVolMix is deliberately NOT snapped here (item 142). This re-attack does
  // not restart the sample and arms no attack ramp, so snapping the smoothed
  // envelope steps the gain mid-waveform — a tone portamento onto a note whose
  // envelope starts below where the last one had got to clicks, every time. The
  // per-sample glide (envVolStep, re-armed each tick) walks it to node 0
  // instead. A FRESH trigger still snaps, in triggerNote, because there the
  // sample restarts from zero and the attack ramp covers the discontinuity.
  voice.hasPanEnv = envPresent(voice.activePanEnvLoop);
  if (!(mayCarry && envCarry(voice.activePanEnvLoop))) {
    voice.envPanIndex = 0;
    voice.envPanTimeSec = 0.0;
    voice.envPan = voice.activePanEnv[0].value / 255.0;
  }
  // Pitch / filter envelope seeds — settle past leading zero-duration nodes.
  if (!voice.hasPitchEnv) {
    voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
  } else if (!(mayCarry && envCarry(voice.activePitchEnvLoop))) {
    voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
      voice.activePitchEnvSustain);
    voice.envPitchIndex = pfIdxBox[0];
    voice.envPitchTimeSec = pfTimeBox[0];
  }
  if (!voice.hasFilterEnv) {
    voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
  } else if (!(mayCarry && envCarry(voice.activeFilterEnvLoop))) {
    voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
      voice.activeFilterEnvSustain);
    voice.envFilterIndex = pfIdxBox[0];
    voice.envFilterTimeSec = pfTimeBox[0];
  }
}

function advanceTrackerCue(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  if (cue.isHalt()) { playhead.isPlaying = false; return; }
  const instr = cue.flowInstruction();
  switch (instr.type) {
    case INST_GOBACK: ts.cuePos = Math.max(ts.cuePos - instr.arg, 0); break;
    case INST_SKIP: ts.cuePos = Math.min(ts.cuePos + instr.arg, NUM_CUES - 1); break;
    case INST_JUMP: ts.cuePos = clamp(instr.arg, 0, NUM_CUES - 1); break;
    default: ts.cuePos = Math.min(ts.cuePos + 1, NUM_CUES - 1); break;
  }
  playhead.position = ts.cuePos;
}

/**
 * Rebuild each voice's Pattern-Ditto (effect 7) arm state as if the current
 * cue's pattern had been played from row 0 up to (but NOT including) startRow.
 * This lets playback that STARTS mid-pattern on a ghosted (repeated) row still
 * sound it — the ghost cells are painted from the same static expansion but the
 * engine only re-derives them at play time once dittoActive is set on the
 * arming row, so seeking past the arm left the ghosts silent (item 81).
 *
 * Faithful mirror of the arm branch in applyTrackerRow (reads RAW rows only, so
 * cascaded/re-armed regions resolve exactly like the running engine); call it
 * right after the play-time voice reset in setTrackerRow. [needs the same TSVM
 * + taut.js fix].
 */
function reconstructDittoState(eng, ts, startRow) {
  const cue = eng.cueSheet[ts.cuePos];
  const patLen = cue.rowLimit();
  const limit = Math.min(startRow, patLen);
  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const voice = ts.voices[vi];
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rows = eng.patternRead(patIdx);
    for (let n = 0; n < limit; n++) {
      const rawRow = rows[n];
      if (rawRow.effect !== EffectOp.OP_7 || rawRow.effectArg === 0) continue;
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave a previously-armed ditto alone.
    }
  }
}

/** Per-pattern voice state reset (S$Bx loop counters + ditto), on every cue advance. */
function resetPatternLoopState(ts) {
  for (const voice of ts.voices) {
    voice.loopStartRow = 0;
    voice.loopCount = 0;
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
  }
}

/**
 * Advance to the next row: resolves pending B/C jumps and pattern-delay repeats.
 * Called once when tickInRow has just wrapped past tickRate.
 */
function advanceRow(eng, ts, playhead) {
  // Pattern delay (S$Ex): replay the same row patternDelayRemaining more times.
  if (ts.patternDelayRemaining > 0) {
    ts.patternDelayRemaining--;
    ts.patternDelayActive = true;
    applyTrackerRow(eng, ts, playhead);
    return;
  }
  ts.patternDelayActive = false;

  const pendingB = ts.pendingOrderJump;
  const pendingC = ts.pendingRowJump;
  const pendingLocal = ts.pendingRowJumpLocal;
  ts.pendingOrderJump = -1;
  ts.pendingRowJump = -1;
  ts.pendingRowJumpLocal = false;

  if (pendingB >= 0) {
    ts.cuePos = Math.min(pendingB, NUM_CUES - 1);
    ts.rowIndex = pendingC >= 0 ? pendingC : 0;
    playhead.position = ts.cuePos;
    resetPatternLoopState(ts);
  } else if (pendingC >= 0 && pendingLocal) {
    // S$Bx pattern loop — stay in the current cue, rewind the row.
    ts.rowIndex = clamp(pendingC, 0, 63);
  } else if (pendingC >= 0) {
    // C$xx pattern break — advance cue then jump to row.
    advanceTrackerCue(eng, ts, playhead);
    ts.rowIndex = clamp(pendingC, 0, 63);
    resetPatternLoopState(ts);
  } else {
    ts.rowIndex++;
    // LEN / "halt at x" shorten the effective row count.
    const rowLimit = eng.cueSheet[ts.cuePos].rowLimit();
    if (ts.rowIndex >= rowLimit) {
      ts.rowIndex = 0;
      advanceTrackerCue(eng, ts, playhead);
      resetPatternLoopState(ts);
    }
  }
  applyTrackerRow(eng, ts, playhead);
}

// ══ src/engine/tick.js ══
// Per-tick voice processing — port of AudioAdapter.kt applyTrackerTick (3689-4087).
//
// CRITICAL: after a mid-tick note-delay trigger (S$Dx) fires, the local `inst`
// binding MUST be re-fetched — triggerNote may have swapped the voice's
// instrument, and the rest of the tick (playback-rate recompute, envelopes,
// fadeout) must see the instrument that just fired (AudioAdapter.kt:3727-3733).











/** Scratch [azimuth, elevation] for the Z slide — one voice steps at a time. */
const spatialStep = new Float64Array(2);

// ── Funk repeat's walk (Z $Ffxx, item 163) ───────────────────────────────────
// ProTracker 1.0C took one walk: forward, a whole loop length a step, home when
// the next block would not fit. Item 163 keeps that as `$f = 0` and reads the
// nibble as two independent choices, which is granular synthesis' own pair of
// knobs — the GRAIN is the loop, and this picks the HOP:
//
//   $f & 3   the hop's size: the loop length shifted right by it, so $0 is a
//            whole block (no overlap), $1 a half, $2 a quarter, $3 an eighth —
//            each finer setting overlaps the grains further and smooths the
//            scan into a slur rather than a stutter
//   $f >> 2  what the hop DOES: 0 forward, 1 backward, 2 forward with the
//            landing JITTERED, 3 a free throw across the whole sample
//
// The walk lives on a GRID of hop-sized positions rooted at the loop start, and
// the grid stops at the last position whose whole window still fits before the
// sample end (§3.3's test, in the general case) — so `K` below is the walk's
// whole territory, `K + 1` positions, and a loop with no room to move keeps
// 1.0C's inert behaviour whatever `$f` says.
//
// TWO POINTERS, and the difference is the whole of `$8`-`$B`. `funkWalk` is
// where the WALK is — it steps forward (or backward) one hop a time and nothing
// random ever touches it — and `funkPos` is where THIS grain landed, which is
// the walk plus a fresh throw. The throw is measured from the walk every time,
// never from the previous throw, which is the rule the sample modifications'
// jumps and scatters follow for the same reason (ENGINE_SPEC §8.5, "the random
// operations do not accumulate"): feed a throw back into the next one and the
// bound stops meaning anything after a few seconds — the narrowest setting
// diffuses into the widest, and every rung of the ladder ends up the same
// effect with a different rise time. A jittery walk is still a walk.
const FUNK_JITTER_DIVISOR = 16;   // `$8`-`$B` throw within ±1/16 of the territory

/**
 * Extended $102/$12x's own funk-repeat walk (item 173 follow-up) — literally
 * `Z $Ffxx`'s walk, reused: "walks the region the way `Z $Ffxx` walks a loop"
 * (TAUD_NOTE_EFFECTS.md) means the resolved region (`g.ds`, `dl`) plays the
 * part `Z`'s declared loop plays for it — `dl` is the hop ("add replen to
 * repeat", the formal Funk Repeat spec's own wording: the loop's OWN length
 * is the step, not a boundary) — while the SEARCH SPACE is `sampleLen`, the
 * true physical sample, exactly as `Z` searches past its loop for room. A
 * region that already spans the whole sample (no loop, §8.4's domain test)
 * is simply a walk with `dl === sampleLen` and nowhere to go, same as `Z`
 * pointed at an unlooped instrument — not a special case, the same formula.
 * This command has no `$f` hop-selector of its own (§"Implementation notes"),
 * so it always walks forward at the grid's smallest hop (`Z`'s `$f = 3`).
 */
const EXT_FUNK_MODE = 3; // forward, hop = dl >> 3 — the only setting this command exposes

/** The hop, in bytes: the loop length shifted by `$f`'s low two bits. */
function funkHop(funkMode, loopLen) {
  return Math.max(1, loopLen >> (funkMode & 3));
}

/**
 * The last grid position whose window still fits whole (§3.3), as an index.
 * Zero means the loop sits at its sample's tail with nowhere to go: every
 * candidate overshoots and the effect is silent — not broken, out of room.
 */
function funkGridTop(hop, loopStart, loopLen, sampleLen) {
  return Math.floor((sampleLen - loopLen - loopStart) / hop);
}

/**
 * `pos` as a grid index, re-quantised onto THIS hop's grid: `$f` may have
 * changed under a running walk, and a finer grid contains every coarser one, so
 * going finer never moves the pointer and going coarser moves it to the nearest
 * whole hop. -1 (never walked) reads as the loop start.
 */
function funkGridIndex(pos, hop, loopStart, K) {
  if (pos < 0) return 0;
  return Math.min(Math.max(Math.round((pos - loopStart) / hop), 0), K);
}

/** A uniform integer in [0, n). */
function uniformInt(n) {
  return Math.min(Math.floor(random() * n), n - 1);
}

/**
 * Step the WALK: forward for `$0`-`$3` and `$8`-`$B`, backward for `$4`-`$7`,
 * and forward for `$C`-`$F` too, where nothing reads it but switching back to a
 * directional `$f` should carry on from somewhere sensible rather than from the
 * last throw. Deterministic — this is the pointer the throws measure from.
 * `walk` is where it is now (-1 = it has never moved); the result is an
 * absolute byte offset.
 */
function funkWalkStep(funkMode, walk, loopStart, loopLen, sampleLen) {
  const hop = funkHop(funkMode, loopLen);
  const K = funkGridTop(hop, loopStart, loopLen, sampleLen);
  if (K <= 0) return loopStart;
  const n = funkGridIndex(walk, hop, loopStart, K);
  // Forward snaps home when the next window would not fit; backward is the
  // mirror and wraps to the TOP — the last position that does fit — so a walk
  // that has never moved goes there on its first backward step instead of
  // sitting at the bottom with nowhere below it.
  const next = (funkMode >> 2) === 1
    ? (n - 1 < 0 ? K : n - 1)
    : (n + 1 > K ? 0 : n + 1);
  return loopStart + next * hop;
}

/**
 * Where the grain actually goes, given the walk `funkWalkStep` just produced.
 * `$0`-`$7` sound the walk itself; `$8`-`$B` throw once around it, within ±1/8
 * of the territory, clamped to the ends (a clamp cannot pile up here — the walk
 * has moved on by the next step, which is exactly what an accumulating walk
 * could not say); `$C`-`$F` ignore the walk and throw over the whole territory,
 * which is what "no restriction on the next position" means.
 *
 * One draw per STEP, from rng.js — never a draw per output sample, and never
 * one measured from the previous throw.
 */
function funkWalkPointer(funkMode, walk, loopStart, loopLen, sampleLen) {
  const family = funkMode >> 2;
  if (family < 2) return walk;
  const hop = funkHop(funkMode, loopLen);
  const K = funkGridTop(hop, loopStart, loopLen, sampleLen);
  if (K <= 0) return loopStart;
  if (family === 3) return loopStart + uniformInt(K + 1) * hop;
  const n = funkGridIndex(walk, hop, loopStart, K);
  const reach = Math.max(1, Math.round((K + 1) / FUNK_JITTER_DIVISOR));
  const thrown = n + uniformInt(2 * reach + 1) - reach;
  return loopStart + Math.min(Math.max(thrown, 0), K) * hop;
}

/**
 * Arm the anti-click crossfade on every voice sounding `instId` (item 153.5).
 * The modification is instrument-scope, so one channel's step is heard by every
 * voice bound to that instrument — NNA ghosts and layer children included — and
 * each needs its own countdown because each is at its own point in its own
 * output. The state being faded FROM is the instrument's (one snapshot, taken
 * where the step is made), so this is a counter and nothing else.
 */
function armModXfade(ts, instId) {
  for (const v of ts.voices) {
    if (v.active && v.instrumentId === instId) v.modXfade = MOD_XFADE_SAMPLES;
  }
  for (const bg of ts.backgroundVoices) {
    if (bg.active && bg.instrumentId === instId) bg.modXfade = MOD_XFADE_SAMPLES;
  }
}

function applyTrackerTick(eng, ts, playhead) {
  const tickSec = 2.5 / playhead.bpm;
  // Samples-per-tick — used to spread the per-tick envVolume jump across the
  // upcoming tick interval. Recomputed every tick (BPM can change mid-row).
  const spt = SAMPLING_RATE * tickSec;
  for (let vi = 0; vi < ts.voices.length; vi++) {
    const voice = ts.voices[vi];
    if (!voice.active && voice.noteDelayTick < 0 && voice.noteActionTick < 0) continue;
    let inst = eng.instruments[voice.instrumentId];

    // Note cut: zero noteVolume/rowVolume, leave channelVolume alone.
    if (voice.cutAtTick === ts.tickInRow) {
      voice.noteVolume = 0;
      voice.rowVolume = 0;
      voice.noteWasCut = true;
    }

    // Note delay — fire the deferred event when the requested tick arrives.
    if (voice.noteDelayTick === ts.tickInRow) {
      switch (voice.delayedNote) {
        case 0x0001: // delayed KEY_OFF
          voice.keyOff = true;
          applyKeyLift(voice, eng.instruments[voice.instrumentId]);
          break;
        case 0x0002: // delayed note cut
          startCutRamp(voice);
          cutLayerChildren(ts, vi);
          break;
        case 0x0003: // delayed note fade
          voice.noteFading = true;
          break;
        case 0x0004: // delayed fast fade
          startFastFade(voice, playhead);
          break;
        default:
          if (voice.delayedNote >= 0x0010 && voice.delayedNote <= 0x001f) {
            // Delayed Int0..IntF (item 181). Alone among the cases here it
            // touches no voice state at all — the marker sounds nothing; it
            // only latches, carrying the `:` argument row.js parked on the
            // voice because a note word has no room for a second number.
            ts.pendingInterrupts |= 1 << (voice.delayedNote - 0x0010);
            ts.interruptArgs[voice.delayedNote - 0x0010] = voice.delayedInterruptArg;
            break;
          }
          applyDuplicateCheck(eng, ts, vi, voice.delayedInst, voice.delayedNote);
          maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
          triggerMetaOrNote(eng, ts, voice, vi, voice.delayedNote, voice.delayedInst, voice.delayedVol);
          break;
      }
      voice.noteDelayTick = -1;
      // Re-bind: triggerNote may have swapped in a new instrument (see header note).
      inst = eng.instruments[voice.instrumentId];
    }

    // S$Dxny follow-up action — fires $y ticks after the (possibly deferred)
    // trigger, independent of whether that trigger left the voice active.
    if (voice.noteActionTick === ts.tickInRow) {
      switch (voice.delayedAction) {
        case 0: // Note off
          voice.keyOff = true;
          applyKeyLift(voice, eng.instruments[voice.instrumentId]);
          break;
        case 1: // Note cut
          startCutRamp(voice);
          cutLayerChildren(ts, vi);
          break;
        case 2: // Note continue — no-op.
          break;
        case 3: // Note fade
          voice.noteFading = true;
          break;
        case 4: // Key lift — forced, bypasses the instrument's own flag.
          voice.keyOff = true;
          forceKeyLift(voice);
          break;
      }
      voice.noteActionTick = -1;
      inst = eng.instruments[voice.instrumentId];
    }

    if (!voice.active) {
      advanceEnvelope(voice, tickSec);
      voice.envVolStep = spt > 0.0 ? (voice.envVolume - voice.envVolMix) / spt : 0.0;
      continue;
    }

    // Pitch slides (E/F coarse on tick > 0).
    if (ts.tickInRow > 0 && (voice.slideMode === 1 || voice.slideMode === 2)) {
      let nv;
      if (ts.toneMode === 1) nv = amigaSlideTick(voice, voice.slideArg);
      else if (ts.toneMode === 2) nv = linearFreqSlideTick(voice, voice.slideArg);
      else nv = voice.noteVal + voice.slideArg;
      voice.noteVal = clamp(nv, 0x20, 0xffff);
      voice.basePitch = voice.noteVal;
    }

    // Tone portamento (G).
    if (voice.tonePortaTarget >= 0 && ts.tickInRow > 0) {
      const target = voice.tonePortaTarget;
      const sp = voice.tonePortaSpeed;
      if (ts.toneMode === 2) {
        if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal);
        const targetFreq = noteValToFreqHz(target);
        const dir = targetFreq > voice.linearFreq ? +1.0 : -1.0;
        voice.linearFreq += dir * sp;
        if ((dir > 0 && voice.linearFreq >= targetFreq) ||
            (dir < 0 && voice.linearFreq <= targetFreq)) {
          voice.linearFreq = targetFreq;
          voice.noteVal = target;
          voice.tonePortaTarget = -1;
        } else {
          voice.noteVal = clamp(freqHzToNoteVal(voice.linearFreq), 0x20, 0xffff);
        }
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
      } else {
        const delta = target > voice.noteVal ? sp : -sp;
        voice.noteVal += delta;
        if ((delta > 0 && voice.noteVal >= target) || (delta < 0 && voice.noteVal <= target)) {
          voice.noteVal = target;
          voice.tonePortaTarget = -1;
        }
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0; // porta works in linear noteVal space
        voice.linearFreq = -1.0;
      }
    }

    // Volume slides (D coarse on tick > 0).
    if (ts.tickInRow > 0 && voice.slideMode === 5) {
      voice.noteVolume = clamp(voice.noteVolume + voice.slideArg * ts.volStep, 0, ts.volMax);
      voice.rowVolume = voice.noteVolume;
    }

    // Vol-col slides (selectors 1/2) + N coarse slide + pan-col slides.
    if (ts.tickInRow > 0) {
      if (voice.volColSlideUp !== 0) {
        voice.noteVolume = Math.min(voice.noteVolume + voice.volColSlideUp, ts.volMax);
        voice.rowVolume = voice.noteVolume;
      }
      if (voice.volColSlideDown !== 0) {
        voice.noteVolume = Math.max(voice.noteVolume - voice.volColSlideDown, 0);
        voice.rowVolume = voice.noteVolume;
      }
      if (voice.nSlideDir !== 0) {
        voice.channelVolume = clamp(voice.channelVolume + voice.nSlideDir * ts.volStep, 0, ts.volMax);
      }
      // The panning column slides the NOTE axis, as its SET does (item 117);
      // P slides the CHANNEL axis, as S $80xx sets it.
      if (voice.panColSlideRight !== 0) {
        applyNotePanSlide(ts, voice, voice.panColSlideRight);
      }
      if (voice.panColSlideLeft !== 0) {
        applyNotePanSlide(ts, voice, -voice.panColSlideLeft);
      }
      if (voice.chanPanSlideRight !== 0) {
        applyPanSlide(ts, voice, voice.chanPanSlideRight);
      }
      if (voice.chanPanSlideLeft !== 0) {
        applyPanSlide(ts, voice, -voice.chanPanSlideLeft);
      }
      // Spherical panning slide (Z, #998.2): one great-circle step per non-first
      // tick, at $xxx/16 azimuth units — X's units, so /8 in the engine's.
      if (voice.spatialSlideActive) {
        stepTowardTarget(
          voice.panAzimuth, voice.panElevation,
          voice.spatialTargetAz, voice.spatialTargetEl,
          voice.mem.z / 8, spatialStep,
        );
        applyPanSet(ts, voice, spatialStep[0]);
        voice.panElevation = spatialStep[1];
      }
    }

    // Tremor (I) — gates output volume.
    if (voice.tremorOn !== 0) {
      voice.tremorTickInPhase++;
      const limit = voice.tremorPhaseOn ? voice.tremorOnTime : voice.tremorOffTime;
      if (voice.tremorTickInPhase >= limit) {
        voice.tremorTickInPhase = 0;
        voice.tremorPhaseOn = !voice.tremorPhaseOn;
      }
      if (!voice.tremorPhaseOn) voice.rowVolume = 0;
    }

    // Vibrato (H/U) — base-pitch overlay.
    let pitchToMixer = voice.noteVal;
    if (voice.vibratoActive) {
      const sine = lfoSampleWide(voice.vibratoLfoPos, voice.vibratoWave);
      const pitchDelta = (sine * voice.mem.huDepth) >> voice.vibratoFineShift;
      pitchToMixer = clamp(voice.noteVal + pitchDelta, 0x20, 0xffff);
      voice.vibratoLfoPos = advanceLfoPhase(voice.vibratoLfoPos, voice.mem.huSpeed);
    }

    // Glissando (S$1x) — snap pitchToMixer to nearest semitone (noteVal stays smooth).
    if (voice.glissandoOn) {
      const semis = Math.trunc((pitchToMixer * 12 + 2048) / 4096);
      pitchToMixer = clamp(Math.trunc((semis * 4096) / 12), 0x20, 0xffff);
    }

    // Tremolo (R) — modulates rowVolume around noteVolume (IT semantics).
    if (voice.tremoloActive) {
      const sine = lfoSampleWide(voice.tremoloLfoPos, voice.tremoloWave);
      const volDelta = (sine * voice.mem.rDepth) >> 9;
      voice.rowVolume = clamp(voice.noteVolume + volDelta * ts.volStep, 0, ts.volMax);
      voice.tremoloLfoPos = advanceLfoPhase(voice.tremoloLfoPos, voice.mem.rSpeed);
    }

    // Panbrello (Y) — a signed offset onto the mixer's pan sum. The shift is 7,
    // not the 9 the 6-bit pan register wanted, because the sum it joins is the
    // 8-bit one; the swing per depth unit is the same.
    //
    // The zero case belongs HERE and not in the per-row reset: a row boundary
    // runs applyTrackerRow AFTER this pass (mixer.js), so a value cleared there
    // stays cleared for the whole of the new row's first tick — which is one
    // tick of dead-centre in the middle of a sweep that spans several rows.
    if (voice.panbrelloActive) {
      const sine = lfoSampleWide(voice.panbrelloLfoPos, voice.panbrelloWave);
      voice.panbrelloOffset = (sine * voice.mem.yDepth) >> 7;
      voice.panbrelloLfoPos = advanceLfoPhase(voice.panbrelloLfoPos, voice.mem.ySpeed);
    } else {
      voice.panbrelloOffset = 0;
    }

    // Arpeggio (J) — overrides pitchToMixer for this tick. arpOff1/arpOff2
    // are stored as full pitch deltas already (item 162's extension writes
    // its two 4096-TET units straight in; classic J pre-scales its bytes by
    // <<8 at write time — see effects.js OP_J), so no shift belongs here.
    if (voice.arpActive) {
      const voiceIdx = ts.tickInRow % 3;
      const arpDelta = voiceIdx === 1 ? voice.arpOff1 : voiceIdx === 2 ? voice.arpOff2 : 0;
      pitchToMixer = clamp(voice.basePitch + arpDelta, 0x20, 0xffff);
      voice.lastArpVoice = voiceIdx;
    }

    // Q retrigger. A metainstrument retriggers WHOLE — every layer restarts
    // together, or the kit would fall apart into layer 0 stuttering over a
    // sustained remainder (item 154). The volume modifier is the channel's, so
    // it is applied once, on the foreground voice the children sync from.
    if (voice.retrigActive && !voice.noteWasCut) {
      voice.retrigCounter++;
      if (voice.retrigCounter >= voice.retrigInterval) {
        voice.retrigCounter = 0;
        restartVoice(voice);
        for (const bg of ts.backgroundVoices) {
          if (bg.isLayerChild && bg.sourceChannel === vi) restartVoice(bg);
        }
        voice.noteVolume = applyRetrigVolMod(voice.noteVolume, voice.retrigVolMod, ts.volStep, ts.volMax);
        voice.rowVolume = voice.noteVolume;
      }
    }

    // What the row's effects did to the pitch this tick, as a delta — the
    // layer children of a metainstrument re-add it below so a vibrato, a
    // glissando or an arpeggio bends the whole kit (item 154). Auto-vibrato and
    // the pitch envelope are NOT in it: those are the instrument's own, and
    // each layer already runs its own copy.
    voice.pitchModDelta = pitchToMixer - voice.noteVal;

    // Auto-vibrato — added on top of pitchToMixer.
    const autoVibDelta = advanceAutoVibrato(voice, inst);

    // Pitch envelope contribution (±16 semitones full-scale; Schism sndmix.c:455-462).
    const pitchEnvDelta = voice.hasPitchEnv && voice.pitchEnvOn
      ? Math.trunc(((voice.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
      : 0;

    const finalPitch = clamp(pitchToMixer + autoVibDelta + pitchEnvDelta, 0x20, 0xffff);
    voice.playbackRate = computePlaybackRate(voice, finalPitch, ts.tuningRatio);
    voice.renderPitch = finalPitch; // display tap (Timeline header per-tick pitch)

    // Filter envelope: currentCutoff = baseCut × envFilterValue (0.5 = unity at IFC).
    if (voice.hasFilterEnv && voice.filterEnvOn) {
      if (voice.filterSfMode) {
        const baseCut = voice.activeDefaultCutoff < 0xffff ? voice.activeDefaultCutoff : 13500;
        voice.currentCutoff = clamp(Math.trunc(baseCut * voice.envFilterValue), 0, 0xffff);
      } else {
        const baseCut = voice.activeDefaultCutoff < 255 ? voice.activeDefaultCutoff : 254;
        voice.currentCutoff = clamp(Math.trunc(baseCut * voice.envFilterValue), 0, 254);
      }
    }

    // Refresh filter coefficients once per tick (recomputes only when changed).
    refreshVoiceFilter(voice);

    // Volume fadeout: after key-off OR Note-Fade NNA, decrement per tick.
    if (voice.keyOff || voice.noteFading) {
      const fadeStep = voice.activeFadeoutStep;
      if (fadeStep > 0) {
        voice.fadeoutVolume = Math.max(voice.fadeoutVolume - fadeStep / 1024.0, 0.0);
        if (voice.fadeoutVolume <= 0.0) voice.active = false;
      }
    }

    advanceEnvelope(voice, tickSec);
    // Per-sample slope so envVolMix walks smoothly to the new envVolume.
    voice.envVolStep = spt > 0.0 ? (voice.envVolume - voice.envVolMix) / spt : 0.0;
    advancePitchEnvelope(voice, tickSec);
    advanceFilterEnvelope(voice, tickSec);
  }

  // Tempo slide — applied once per tick at the playhead level.
  for (const voice of ts.voices) {
    if (voice.tempoSlideDir !== 0 && ts.tickInRow > 0) {
      const tempoByte = clamp(
        playhead.bpm - 0x19 + voice.tempoSlideDir * voice.tempoSlideAmount, 0, 0xff);
      playhead.bpm = clamp(tempoByte + 0x19, 25, 280);
    }
  }

  // Global volume slide (W coarse) — once per non-first tick per armed channel.
  if (ts.tickInRow > 0) {
    for (const voice of ts.voices) {
      if (voice.wSlideDir !== 0) {
        playhead.globalVolume = clamp(
          playhead.globalVolume + voice.wSlideDir * voice.wSlideAmount, 0, 0xff);
      }
    }
  }

  // Invert loop (S $F0xx) — advance the per-instrument XOR mask (PT2 updateFunk).
  for (const voice of ts.voices) {
    if (voice.invertSpeed === 0 || !voice.active) continue;
    const inst = eng.instruments[voice.instrumentId];
    // ACTIVE loop, not the base record's — an Ixmp patch brings its own (item 116).
    if (voice.activeSampleLoopEnd <= voice.activeSampleLoopStart) continue;
    voice.invertAccumulator += voice.invertSpeed;
    if (voice.invertAccumulator >= 0x80) {
      voice.invertAccumulator = 0;
      const loopLen = Math.max(
        voice.activeSampleLoopEnd - voice.activeSampleLoopStart, 1);
      voice.invertWritePos = (voice.invertWritePos + 1) % loopLen;
      inst.toggleInvertBit(voice.invertWritePos, loopLen);
    }
  }

  // Funk repeat (Z $Ffxx) — walk the loop WINDOW through the sample (item 161,
  // extended by item 163). ProTracker 1.0C's EFx, from the transcription in
  // FUNK_REPEAT.md §3: what 1.1B kept of it is the ladder, the accumulator and
  // the name; the step body it threw away moved Paula's AUDxLC by ONE WHOLE
  // LOOP LENGTH a time, so the loop window hops block by block through the
  // sample and snaps back to the real loop start as soon as the next block
  // would not fit whole. The window the sampler sounds is latched at the loop
  // restart, as the DMA latched it. `$f` sizes the hop and picks what it does
  // (funkWalkStep / funkWalkPointer above); `$f = 0` is 1.0C's own, unchanged.
  //
  // The accumulator is deliberately NOT reset here, or by Z $F000, or by a
  // fresh note: PT never touched n_funkoffset outside this block (§2.1), so a
  // speed change lands its first step at whatever interval the running phase
  // leaves — which is the difference between the ladder and a period counter.
  for (const voice of ts.voices) {
    if (voice.funkSpeed === 0 || !voice.active) continue;
    const mode = voice.activeLoopMode & 3;
    if (mode !== 1 && mode !== 2) continue;   // "will need a short loop to work"
    const loopStart = voice.activeSampleLoopStart;
    const loopLen = voice.activeSampleLoopEnd - loopStart;
    const sampleLen = voice.activeSampleLength;
    if (loopLen <= 0 || loopStart + loopLen > sampleLen) continue;
    voice.funkAccumulator = (voice.funkAccumulator + voice.funkSpeed) & 0xff;
    if ((voice.funkAccumulator & 0x80) !== 0) {
      voice.funkAccumulator = 0;             // reset, not -= 0x80: no jitter
      // The walk steps first and the grain is placed against it: `$8`-`$B`'s
      // throw is measured from where the WALK is, never from where the last
      // throw landed, so the jitter cannot diffuse into a wider setting.
      voice.funkWalk = funkWalkStep(
        voice.funkMode, voice.funkWalk, loopStart, loopLen, sampleLen);
      voice.funkPos = funkWalkPointer(
        voice.funkMode, voice.funkWalk, loopStart, loopLen, sampleLen);
    }
  }

  // Sample modification (notefx 2 / 3) — one step of the instrument's live
  // operation every $y ticks (item 153.1: $F every tick, $1 every fifteenth),
  // counted per channel because the clock is the channel's and the operation
  // the instrument's. A metainstrument's layer children carry a clock too
  // (item 154), one per distinct instrument — applySampleModEffect zeroes the
  // duplicates' modPeriod, so a kit whose layers share a sample still steps it
  // once a tick.
  for (const voice of ts.voices) advanceSampleMod(eng, ts, voice);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild) advanceSampleMod(eng, ts, bg);
  }

  // Background (NNA-ghost) voices: passive maintenance only.
  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (!bg.active) { ts.backgroundVoices.splice(i, 1); continue; }
    // Layer child: re-sync pitch / key-off / volume / pan from the parent each tick.
    if (bg.isLayerChild) {
      const parent = bg.sourceChannel >= 0 && bg.sourceChannel < ts.voices.length
        ? ts.voices[bg.sourceChannel] : null;
      // An FM operator outlives its rack for no one: nothing reads it once the
      // rack is gone, and the mixer never summed it, so a detached operator
      // would be an inaudible voice ageing forever. It dies with the note.
      if (bg.fmOperator && (parent === null || !parent.active ||
          parent.fmRig === null || parent.fmRig.voices[0] !== parent)) {
        bg.active = false;
        bg.fmOperator = false;
        ts.backgroundVoices.splice(i, 1);
        continue;
      }
      if (parent === null || !parent.active) {
        // Parent ended. If it was RELEASED and its fast fadeout deactivated it in
        // the SAME tick the release fired, the sync below never ran — inherit the
        // release before detaching (the meta KEY_OFF race fix; AudioAdapter.kt:4020-4035).
        if (parent !== null && !bg.keyOff && !bg.noteFading) {
          if (parent.keyOff) {
            bg.keyOff = true;
            applyKeyLift(bg, eng.instruments[bg.instrumentId]);
          } else if (parent.noteFading) {
            bg.noteFading = true;
          }
        }
        bg.isLayerChild = false;
        bg.layerPitchMod = 0;
        bg.layerFixedNote = -1;
      } else {
        // A NON-MELODIC layer (item 179) holds its own note: it is not sitting
        // at an interval from the parent, it is sitting at a pitch. Everything
        // else below still follows the parent — the pitch OVERLAY included, so
        // a vibrato written on the channel still bends it. What the flag takes
        // away is the keyed note, not the pattern's reach over the note.
        bg.noteVal = bg.layerFixedNote >= 0
          ? bg.layerFixedNote
          : clamp(parent.noteVal + bg.layerRelDetune, 0x20, 0xffff);
        bg.layerPitchMod = parent.pitchModDelta;
        bg.basePitch = bg.noteVal;
        bg.amigaPeriod = -1.0;
        bg.linearFreq = -1.0;
        if (parent.keyOff && !bg.keyOff) {
          bg.keyOff = true;
          applyKeyLift(bg, eng.instruments[bg.instrumentId]);
        }
        if (parent.noteFading && !bg.noteFading) bg.noteFading = true;
        bg.channelVolume = parent.channelVolume;
        bg.noteVolume = parent.noteVolume;
        bg.rowVolume = parent.rowVolume;
        bg.channelPan = parent.channelPan;
        bg.rowPan = parent.rowPan;
        bg.panbrelloOffset = parent.panbrelloOffset;
        bg.panAzimuth = parent.panAzimuth;
        bg.panElevation = parent.panElevation;
        // Both axes follow the parent, the note axis carrying each layer's own
        // offset from the meta's centre with it (item 118) — the exact shape of
        // the pitch resync above, `parent + relative`. So the pattern's panning
        // column and S $80xx reach every layer, AND a kit whose layers pan
        // apart stays apart for the whole note instead of collapsing onto
        // layer 0 at the first tick.
        bg.notePan = boundNotePan(ts, parent.notePan + bg.layerRelPan);
        bg.noteElevation = parent.noteElevation + bg.layerRelElevation;
      }
    }
    const inst = eng.instruments[bg.instrumentId];
    advanceEnvelope(bg, tickSec);
    bg.envVolStep = spt > 0.0 ? (bg.envVolume - bg.envVolMix) / spt : 0.0;
    advancePitchEnvelope(bg, tickSec);
    advanceFilterEnvelope(bg, tickSec);
    if (bg.keyOff || bg.noteFading) {
      const fadeStep = bg.activeFadeoutStep;
      if (fadeStep > 0) {
        bg.fadeoutVolume = Math.max(bg.fadeoutVolume - fadeStep / 1024.0, 0.0);
      }
    }
    // Auto-vibrato keeps running on backgrounds.
    const autoVibDelta = advanceAutoVibrato(bg, inst);
    const pitchEnvDelta = bg.hasPitchEnv && bg.pitchEnvOn
      ? Math.trunc(((bg.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
      : 0;
    const finalPitch = clamp(bg.noteVal + bg.layerPitchMod + autoVibDelta + pitchEnvDelta,
      0x20, 0xffff);
    bg.playbackRate = computePlaybackRate(bg, finalPitch, ts.tuningRatio);
    bg.renderPitch = finalPitch; // display tap (per-tick pitch)
    // Filter envelope — MUST branch on SF mode too (cents vs IT byte range).
    if (bg.hasFilterEnv && bg.filterEnvOn) {
      if (bg.filterSfMode) {
        const baseCut = bg.activeDefaultCutoff < 0xffff ? bg.activeDefaultCutoff : 13500;
        bg.currentCutoff = clamp(Math.trunc(baseCut * bg.envFilterValue), 0, 0xffff);
      } else {
        const baseCut = bg.activeDefaultCutoff < 255 ? bg.activeDefaultCutoff : 254;
        bg.currentCutoff = clamp(Math.trunc(baseCut * bg.envFilterValue), 0, 254);
      }
    }
    refreshVoiceFilter(bg);
    // Reap fully-faded ghosts.
    if ((bg.keyOff || bg.noteFading) && bg.fadeoutVolume <= 0.0) {
      bg.active = false;
      ts.backgroundVoices.splice(i, 1);
    }
  }
}

/**
 * One tick of channel-clocked sample modification (notefx 2 / 3) for `voice`:
 * step the instrument's live operation when this voice's period elapses. Split
 * out of the tick loop because a metainstrument's layer children run it too
 * (item 154) — the clock is the voice's, the operation the instrument's.
 */
function advanceSampleMod(eng, ts, voice) {
  // Argument extension (item 162): an extended voice clocks itself in samples
  // via advanceSampleModExtended (mixer.js's per-sample loop), never here —
  // the two clocks never touch the same voice's step count.
  if (voice.modPeriod === 0 || !voice.active || voice.modExtended) return;
  const inst = eng.instruments[voice.instrumentId];
  if (inst.modOp === MOD_OFF) return;
  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const g = resolveModGeom(voice.modGeom, inst, voice.activeSampleLoopStart,
    voice.activeSampleLoopEnd, sampleLen);
  if (!g.live) return;
  if (++voice.modTickCount < voice.modPeriod) return;
  voice.modTickCount = 0;
  const step = MOD_STEP[inst.modOp];
  if (inst.modOp === MOD_INVERT) {
    // Walk to the next byte the region actually touches and flip it. An
    // inverted region can exclude a long stretch, so the scan is bounded —
    // past MOD_WALK_SCAN misses this step simply does not land. One byte is
    // not a discontinuity, so this is the one operation with no crossfade.
    for (let n = 0; n < MOD_WALK_SCAN; n++) {
      voice.modWritePos = (voice.modWritePos + 1) % Math.max(g.dl, 1);
      const i = g.ds + voice.modWritePos;
      if (modTouches(g, inst.modInvert, i)) { inst.toggleModBit(i, sampleLen); break; }
    }
    return;
  }
  // Everything else replaces a mapping wholesale, so the voices sounding this
  // instrument crossfade out of the old one rather than cutting to the new
  // (item 153.5).
  inst.snapshotModState();
  if (isRolOp(inst.modOp)) {
    inst.modRot = (inst.modRot + step) % g.dl;
    inst.modOn = inst.modRot !== 0;
  } else if (isJumpOp(inst.modOp)) {
    // Jump (item 152): the ROL displacement, thrown instead of stepped. One
    // offset for the whole region, measured from home rather than from the
    // last throw, so $A paces around it instead of wandering off.
    inst.modRot = jumpRot(inst.modOp, g.dl);
    inst.modOn = inst.modRot !== 0;
  } else if (isRndOp(inst.modOp)) {
    // Scatter (item 152): one new scramble of the whole region per step. The
    // per-byte throws live in the seed, so a step is a single draw however
    // many bytes it rearranges, and each is measured from where its byte
    // really belongs — nothing accumulates, so $D stays within its 1/512 of
    // the domain however long the effect runs.
    inst.modScatter = scatterReach(inst.modOp, g.dl);
    inst.modSeed = scatterSeed();
    inst.modOn = inst.modScatter > 0;
  } else {
    inst.modSub = (inst.modSub + step) & 0xff;
    inst.modOn = inst.modSub !== 0;
  }
  armModXfade(ts, voice.instrumentId);
}

/**
 * Argument-extension counterpart of advanceSampleMod (item 162): same shape
 * — resolve the geometry, wait out the period, step once — but clocked in
 * SAMPLES (voice.modStepTicks may be under 1 tick) rather than whole ticks,
 * which is why it is called from mixer.js's per-sample loop instead of the
 * per-tick one. `spt` is that loop's own samples-per-tick, recomputed fresh
 * every sample there (T-slide correctness) and threaded straight through
 * rather than cached, so a mid-row tempo change retimes this the same way it
 * retimes the tick clock itself.
 */
function advanceSampleModExtended(eng, ts, voice, spt) {
  if (!voice.modExtended || !voice.active) return;
  const inst = eng.instruments[voice.instrumentId];
  if (inst.modOpExt === 0 || voice.modStepTicks <= 0) return;
  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const g = resolveModGeom(voice.modGeom, inst, voice.activeSampleLoopStart,
    voice.activeSampleLoopEnd, sampleLen);
  if (!g.live) return;
  voice.modSamplesIntoStep += 1.0;
  const periodSamples = voice.modStepTicks * spt;
  if (periodSamples <= 0 || voice.modSamplesIntoStep < periodSamples) return;
  voice.modSamplesIntoStep -= periodSamples;
  stepExtendedModOnce(ts, voice, inst, g, sampleLen);
}

/**
 * One step of an extended (`:`-paired) 2/3, dispatched on the decoded $xuu
 * kind — see samplemod.js decodeExtOp for the code table this switches on and
 * the design note on 920's fold into `xor`, 13x/14x's shared `jumpN`, and
 * which kinds get the anti-click crossfade (rot/sub/xor family: the same
 * accumulate-and-replace shape the base command's ROL/SUB/JUMP/SCATTER get)
 * versus which don't (bit-rotate, bit-permutation, mirror, swap, invert — all
 * either a single-byte flip like classic INVERT, or a toggle between two
 * states, neither of which clicks the way replacing a whole mapping does).
 */
function stepExtendedModOnce(ts, voice, inst, g, sampleLen) {
  inst.modStepIndex++; // $f's A-D alternation reads this
  const { kind, param } = decodeExtOp(inst.modOpExt);
  const dl = Math.max(g.dl, 1);
  switch (kind) {
    case "noop":
      break;
    case "invert": {
      for (let n = 0; n < MOD_WALK_SCAN; n++) {
        voice.modWritePos = (voice.modWritePos + 1) % dl;
        const i = g.ds + voice.modWritePos;
        if (extModTouches(g, inst.modInvert, inst.modF, inst.modStepIndex, i)) {
          inst.toggleModBit(i, sampleLen);
          break;
        }
      }
      break;
    }
    case "invertJit": {
      const reach = Math.max(1, Math.round(extJitterFrac(param) * dl));
      for (let n = 0; n < MOD_WALK_SCAN; n++) {
        const jitter = Math.floor(random() * (2 * reach + 1)) - reach;
        voice.modWritePos = (((voice.modWritePos + 1 + jitter) % dl) + dl) % dl;
        const i = g.ds + voice.modWritePos;
        if (extModTouches(g, inst.modInvert, inst.modF, inst.modStepIndex, i)) {
          inst.toggleModBit(i, sampleLen);
          break;
        }
      }
      break;
    }
    case "funk":
    case "funkJit": {
      // Whole-physical-sample domain (see EXT_FUNK_MODE above): `g.ds`/`dl`
      // stand in for Z's loopStart/loopLen, `sampleLen` is the true sample —
      // NOT `dl`. This is a loop-window relocation, not an address remap:
      // it never touches inst.modOn/modRot/armModXfade (those drive
      // readSamplePoint's per-byte transform and its shared crossfade,
      // neither of which this kind uses — §"the anti-click crossfade... does
      // NOT cover... $102/$12x funk"). The actual relocation happens at the
      // voice's own loop wrap (sampler.js advanceSamplePos), which reads
      // inst.modFunkWalk/modFunkPos the same way it already reads Z's own
      // voice.funkWalk/funkPos.
      inst.modFunkLen = dl;
      inst.modFunkWalk = funkWalkStep(EXT_FUNK_MODE, inst.modFunkWalk, g.ds, dl, sampleLen);
      let pos = inst.modFunkWalk;
      if (kind === "funkJit") {
        const hop = funkHop(EXT_FUNK_MODE, dl);
        const K = funkGridTop(hop, g.ds, dl, sampleLen);
        if (K > 0) {
          const reach = Math.max(1, Math.round(extJitterFrac(param) * (K + 1)));
          const n = funkGridIndex(inst.modFunkWalk, hop, g.ds, K);
          const thrown = n + uniformInt(2 * reach + 1) - reach;
          pos = g.ds + Math.min(Math.max(thrown, 0), K) * hop;
        }
      }
      inst.modFunkPos = pos;
      break;
    }
    case "mirror": {
      inst.modExtMirror = !inst.modExtMirror;
      inst.modOn = inst.modExtMirror;
      break;
    }
    case "swap": {
      if (dl >= 2) {
        const a = g.ds + Math.floor(random() * dl);
        let b2 = g.ds + Math.floor(random() * dl);
        if (b2 === a) b2 = g.ds + ((a - g.ds + 1) % dl);
        inst.modExtSwapA = a;
        inst.modExtSwapB = b2;
        inst.modOn = true;
      }
      break;
    }
    case "rol": {
      inst.snapshotModState();
      inst.modRot = ((inst.modRot + param) % dl + dl) % dl;
      inst.modOn = inst.modRot !== 0;
      armModXfade(ts, voice.instrumentId);
      break;
    }
    case "jumpN": {
      inst.snapshotModState();
      const slice = Math.max(1, Math.round(dl / param));
      const idx = Math.min(Math.floor(random() * param), param - 1);
      inst.modRot = (idx * slice) % dl;
      inst.modOn = true;
      armModXfade(ts, voice.instrumentId);
      break;
    }
    case "jumpNBounded": {
      inst.snapshotModState();
      const reach = Math.max(1, Math.round(dl / param));
      const thrown = Math.floor(random() * (2 * reach + 1)) - reach;
      inst.modRot = ((thrown % dl) + dl) % dl;
      inst.modOn = true;
      armModXfade(ts, voice.instrumentId);
      break;
    }
    case "scatter": {
      inst.snapshotModState();
      inst.modScatter = Math.max(1, Math.min(Math.round(dl * param), dl));
      inst.modSeed = scatterSeed();
      inst.modOn = inst.modScatter > 0;
      armModXfade(ts, voice.instrumentId);
      break;
    }
    case "sub": {
      inst.snapshotModState();
      inst.modSub = (inst.modSub + param) & 0xff;
      inst.modOn = inst.modSub !== 0;
      armModXfade(ts, voice.instrumentId);
      break;
    }
    case "xor": {
      inst.snapshotModState();
      inst.modXor = (inst.modXor ^ param) & 0xff;
      inst.modOn = inst.modXor !== 0;
      armModXfade(ts, voice.instrumentId);
      break;
    }
    case "bitrot": {
      inst.modBitRot = (((inst.modBitRot + param) % 8) + 8) % 8;
      inst.modOn = inst.modBitRot !== 0;
      break;
    }
    case "bitperm": {
      inst.modBitPermIdx = param;
      inst.modBitPermOn = !inst.modBitPermOn;
      inst.modOn = inst.modBitPermOn;
      break;
    }
  }
}

/**
 * Restart one voice's note without re-resolving the instrument: sample back to
 * the start, all four envelope playheads re-seeded, fade and filter history
 * cleared. What Q's retrigger does to a voice — and, since a metainstrument is
 * one note, to each of its layer children as well (item 154).
 */
function restartVoice(v) {
  v.samplePos = v.activeSamplePlayStart; // patch-aware
  v.keyOff = false;
  v.envIndex = 0; v.envTimeSec = 0.0;
  v.envPanIndex = 0; v.envPanTimeSec = 0.0;
  v.envPan = v.activePanEnv[0].value / 255.0;
  // Re-seed pf-envs past leading zero-duration nodes (as at fresh trigger).
  if (v.hasPitchEnv) {
    v.envPitchValue = seedPfRole(v.activePitchEnv, v.activePitchEnvLoop,
      v.activePitchEnvSustain);
    v.envPitchIndex = pfIdxBox[0]; v.envPitchTimeSec = pfTimeBox[0];
  } else {
    v.envPitchValue = 0.5; v.envPitchIndex = 0; v.envPitchTimeSec = 0.0;
  }
  if (v.hasFilterEnv) {
    v.envFilterValue = seedPfRole(v.activeFilterEnv, v.activeFilterEnvLoop,
      v.activeFilterEnvSustain);
    v.envFilterIndex = pfIdxBox[0]; v.envFilterTimeSec = pfTimeBox[0];
  } else {
    v.envFilterValue = 0.5; v.envFilterIndex = 0; v.envFilterTimeSec = 0.0;
  }
  v.fadeoutVolume = 1.0;
  v.autoVibPhase = 0;
  v.autoVibTicksSinceTrigger = 0;
  v.filterY1 = 0.0; v.filterY2 = 0.0; v.filterX1 = 0.0; v.filterX2 = 0.0;
  v.right.reset();
}

// ══ src/engine/mixer.js ══
// Mixer + output quantiser — port of AudioAdapter.kt generateTrackerAudio
// (4128-4315) and pcm32fToPcm8 (839-873).
//
// The mix bus is Float32 (ts.mixLeft/mixRight Float32Array; typed-array stores
// round like Kotlin's .toFloat()). pcm32fToPcm8 runs Kotlin-Float semantics via
// Math.fround at every arithmetic step, and draws its TPDF dither from the
// engine's seeded xorshift32 stream — so the U8 output is deterministic.











const fround = Math.fround;

/** Scratch pair for fetchTrackerSampleStereo — one voice is mixed at a time. */
const stereoPair = [0.0, 0.0];

/**
 * One voice's contribution as a [left, right] PAIR, before pan and gain.
 * Mono voices put the same sample on both sides, which is what makes the
 * stereo path a strict generalisation: a stereo sample whose channels are
 * identical mixes bit-for-bit like the mono sample it was made from.
 *
 * Channel mode 0 (discrete) is the sample's own L,R. Mode 1 (matrix) holds
 * M,S and decodes L = M+S, R = M−S — the inverse of the M=(L+R)/2,
 * S=(L−R)/2 encoding. The decode happens BEFORE the filter and the voice FX
 * so those act on speaker feeds (the filter is linear so its result is the
 * same either way; the bitcrusher/overdrive are not, and crushing a speaker
 * feed is the sane reading). In a surround song the pair is not a pair of
 * speaker feeds at all — spatial.js places each channel as its own source at
 * the ITU angle for the sample's channel count (#998.0). Anything not
 * stereo-shaped stays mono here.
 */
function renderVoicePair(eng, ts, voice, inst, interpMode, spt, out) {
  // An FM rack (item 159) replaces the voice's own sample fetch, and nothing
  // else: the filter, the voice FX and every gain below still act on the
  // finished patch exactly as they act on a sampled one.
  if (voice.fmRig !== null) {
    const s = applyTaudVoiceFx(voice, applyVoiceFilter(voice,
      renderFmVoice(eng, ts, voice, interpMode, spt)));
    out[0] = s;
    out[1] = s;
    return out;
  }
  if (voice.activeChanCount !== 2) {
    const s = applyTaudVoiceFx(voice, applyVoiceFilter(voice,
      fetchTrackerSample(eng, voice, inst, interpMode)));
    out[0] = s;
    out[1] = s;
    return out;
  }
  fetchTrackerSampleStereo(eng, voice, inst, interpMode, out);
  let c0 = out[0], c1 = out[1];
  if (voice.activeChanMode === CHAN_MODE_MATRIX) {
    const m = c0, s = c1;
    c0 = m + s;
    c1 = m - s;
  }
  out[0] = applyTaudVoiceFx(voice, applyVoiceFilter(voice, c0));
  out[1] = applyTaudVoiceFx(voice, applyVoiceFilter(voice, c1, voice.right), voice.right);
  return out;
}

/** urand: (xorshift32() & 0xFFFFFF) / 16777216 — exact in Float32. */
function urand(eng) {
  return (eng.xorshift32() & 0xffffff) / 16777216.0;
}

/** TPDF noise in [-1, +1) — difference of two urands, exact in Float32. */
function tpdf1(eng) {
  return urand(eng) - urand(eng);
}

/**
 * Noise-shaped dither 32f → interleaved U8, writing into out (length ≥ 2·sampleCount).
 * State: eng.ditherError = Float32Array(4) [L0, L1, R0, R1].
 */
function pcm32fToPcm8(eng, fleft, fright, sampleCount, out) {
  const b1 = 1.5;
  const b2 = -0.75;
  const scale = 127.5;
  const bias = 128;
  const ditherScale = 0.2; // fround(0.2) applied at the multiply below
  const err = eng.ditherError;

  for (let i = 0; i < sampleCount; i++) {
    // --- LEFT channel ---
    const feedbackL = fround(fround(b1 * err[0]) + fround(b2 * err[1]));
    const ditherL = fround(fround(ditherScale) * tpdf1(eng));
    let shapedL = fround(fround(fleft[i] + feedbackL) + fround(ditherL / scale));
    shapedL = shapedL < -1.0 ? -1.0 : shapedL > 1.0 ? 1.0 : shapedL;

    let qL = Math.round(fround(shapedL * scale));
    qL = qL < -128 ? -128 : qL > 127 ? 127 : qL;
    out[i * 2] = (qL + bias) & 0xff;

    const qerrL = fround(shapedL - fround(qL / scale));
    err[1] = err[0];
    err[0] = qerrL;

    // --- RIGHT channel ---
    const feedbackR = fround(fround(b1 * err[2]) + fround(b2 * err[3]));
    const ditherR = fround(fround(ditherScale) * tpdf1(eng));
    let shapedR = fround(fround(fright[i] + feedbackR) + fround(ditherR / scale));
    shapedR = shapedR < -1.0 ? -1.0 : shapedR > 1.0 ? 1.0 : shapedR;

    let qR = Math.round(fround(shapedR * scale));
    qR = qR < -128 ? -128 : qR > 127 ? 127 : qR;
    out[i * 2 + 1] = (qR + bias) & 0xff;

    const qerrR = fround(shapedR - fround(qR / scale));
    err[3] = err[2];
    err[2] = qerrR;
  }
}

/**
 * Render one 512-frame chunk for playhead into out (Uint8Array(1024), interleaved
 * U8 L,R). Returns null when the playhead has no tracker state.
 */
function generateTrackerAudio(eng, playhead, out) {
  const ts = playhead.trackerState;
  if (ts === null) return null;

  // Jam mode mixes voices without advancing rows/cues.
  const advancing = playhead.isPlaying;
  // Stem-export tap (item 93) — null on every playback path. See TaudEngine.stemBus.
  const stems = eng.stemBus;
  // Surround object bus (#998) — null for the stereo model, which keeps the
  // plain mixL/mixR accumulators below and stays bit-exact against the JVM.
  const spatial = ts.spatial;
  if (spatial !== null) spatial.clear();
  // Master-strip analysis tap (item 98) — null unless the strip is on screen.
  // Its bus is null for a stereo song, whose tap is taken from the finished
  // mix below, so the legacy path stays exactly as it was.
  const analysis = ts.analysis;
  const abus = analysis === null ? null : analysis.bus;
  if (analysis !== null) analysis.begin();
  // Per-voice soundscope ring (item 179): the Kotlin device fills it on every
  // sample because a TSVM guest can read the window at any instant; here
  // nothing can, so it is filled only for a host that asked. Two stores per
  // voice per sample — 80 voices' worth, active or not — for a buffer no one
  // is looking at is the single cheapest thing in the mix loop to not do.
  const scopeOn = ts.scopeOn;
  const voices = ts.voices;
  const nVoices = voices.length;

  if (advancing && ts.firstRow) {
    ts.firstRow = false;
    applyTrackerRow(eng, ts, playhead);
  }

  // The rate and the Amiga coefficients are settable module bindings (item
  // 108) — read them ONCE per chunk so the per-sample loop below works on
  // plain locals, as it did when they were compile-time constants.
  const srate = SAMPLING_RATE;
  const a500A0 = AMIGA_A500_A0, a500B1 = AMIGA_A500_B1;
  const ledA1 = AMIGA_LED_A1, ledA2 = AMIGA_LED_A2;
  const ledB1 = AMIGA_LED_B1, ledB2 = AMIGA_LED_B2;

  for (let n = 0; n < TRACKER_CHUNK; n++) {
    // Recompute samples-per-tick every iteration (T/T-slide mutate BPM mid-row).
    const spt = (srate * 2.5) / playhead.bpm;
    if (advancing) {
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
        ts.tickInRow++;
        if (ts.tickInRow >= playhead.tickRate + ts.finePatternDelayExtra) {
          ts.tickInRow = 0;
          advanceRow(eng, ts, playhead);
        }
      }
    } else { // jamActive: evolve envelopes only, never advance the song
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
      }
    }

    let mixL = 0.0;
    let mixR = 0.0;
    const gvol = playhead.globalVolume / 255.0;
    const mvol = playhead.mixingVolume / 255.0;
    // Loop-invariant across the voice loop: every voice is scaled by it, and
    // nothing inside the loop can change it.
    const globalGain = (gvol * mvol * playhead.masterVolume) / 255.0;
    for (let vi = 0; vi < nVoices; vi++) {
      const voice = voices[vi];
      if (!voice.active || voice.fader === 255) {
        if (scopeOn) { // keep the soundscope flat between notes / while muted
          voice.scopeBuffer[voice.scopeWritePos] = 0;
          voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
        }
        continue;
      }
      const voiceInst = eng.instruments[voice.instrumentId];
      // Argument extension (item 162): an extended 2/3's clock runs in
      // samples, not ticks, so it steps HERE rather than in applyTrackerTick
      // — same per-sample-accumulator shape ts.samplesIntoTick uses above,
      // scoped to this one voice's instrument.
      advanceSampleModExtended(eng, ts, voice, spt);
      renderVoicePair(eng, ts, voice, voiceInst, ts.interpolationMode, spt, stereoPair);
      const sL = stereoPair[0];
      const sR = stereoPair[1];
      // Soundscope shows the mono sum — a stereo voice is still one voice.
      const sScope = voice.activeChanCount === 2 ? (sL + sR) * 0.5 : sL;
      const instGv = voiceInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + voice.randomVolBias / 255.0;
      // Per-sample envelope smoothing.
      voice.envVolMix += voice.envVolStep;
      const effEnvVol = voice.volEnvOn ? voice.envVolMix : 1.0;
      advanceVolumeRamp(voice, ts.volDiv);
      advancePitchRamp(voice, spt);
      const faderGain = (255 - voice.fader) / 255.0;
      const perVoiceGain = effEnvVol * voice.fadeoutVolume * voice.currentMixVolume *
        swingScale * instGv * faderGain * voice.layerMixGain * voice.activeAttenGain;
      const vol = perVoiceGain * globalGain;
      // ONE pan ramp, above the branch, because both paths smooth the same
      // composed number: every input to it moves once a TICK while the pan law
      // (and the ambisonic encode) is evaluated every sample, so without this
      // the gain stepped 50 times a second (item 141). Sharing it is also what
      // keeps a planar song rendering identically to its stereo twin.
      let lGain = 0.0;
      let rGain = 0.0;
      if (spatial === null) {
        // equal-energy pan law, memoised on the pan itself (item 179): two
        // transcendentals per voice per sample is a lot to pay for a number
        // that only moves while something is actually panning the voice.
        const pan = advancePanRamp(voice, voicePanByte(voice));
        if (pan !== voice.panLawPan) {
          voice.panLawPan = pan;
          voice.panLawL = Math.cos((Math.PI * pan) / 512.0);
          voice.panLawR = Math.sin((Math.PI * pan) / 512.0);
        }
        lGain = voice.panLawL;
        rGain = voice.panLawR;
      } else {
        advancePanRamp(voice, voiceAzimuth(voice), true);
      }
      // Sample-end ramp-out.
      let rampGain;
      if (voice.rampOutSamples > 0) {
        rampGain = voice.rampOutGain;
        voice.rampOutGain -= voice.rampOutStep;
        voice.rampOutSamples--;
        if (voice.rampOutSamples === 0) voice.active = false;
      } else {
        rampGain = 1.0;
      }
      // Volume ramp for Attack (item 139): half-cosine fade-in folded into the same
      // rampGain, so every downstream use (scope, stems, mix, spatial) picks it up for free.
      if (voice.attackRampSamples > 0) {
        const elapsed = ATTACK_RAMP_SAMPLES - voice.attackRampSamples;
        rampGain *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
        voice.attackRampSamples--;
      }
      if (scopeOn) {
        voice.scopeBuffer[voice.scopeWritePos] = sScope * perVoiceGain * rampGain;
        voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
      }
      if (stems !== null) stems.add(voice, vi, n, sScope * vol * rampGain);
      if (spatial === null) {
        mixL += sL * vol * lGain * rampGain;
        mixR += sR * vol * rGain * rampGain;
      } else {
        // One positioned source per sample channel: a stereo sample is a pair
        // of objects sitting ±30° apart, not two speaker feeds (#998.0).
        const g = spatialVoiceGains(spatial, voice);
        spatial.addSource(n, sL * vol, g, 0, rampGain);
        if (voice.activeChanCount === 2) {
          spatial.addSource(n, sR * vol, g, spatial.numChannels, rampGain);
        }
      }
      if (abus !== null) {
        const ag = analysisVoiceGains(abus, voice);
        abus.addSource(n, sL * vol, ag, 0, rampGain);
        if (voice.activeChanCount === 2) {
          abus.addSource(n, sR * vol, ag, abus.numChannels, rampGain);
        }
      }
    }
    // Background (NNA-ghost + metainstrument layer-child) voices.
    for (const bg of ts.backgroundVoices) {
      // An FM operator is an OPERAND, not a sound: the rack that owns it read
      // it (and aged it) in the foreground pass above, so summing it here would
      // put the modulators into the mix beside the note they shaped.
      if (bg.fmOperator) continue;
      // Muting a channel must also silence the NNA ghosts and layer children it
      // spawned (item 45): fold the source channel's fader into the bg voice's
      // own, so a channel mute/solo covers everything that came from it.
      const srcVoice = voices[bg.sourceChannel];
      const bgFader = srcVoice && srcVoice.fader > bg.fader ? srcVoice.fader : bg.fader;
      if (!bg.active || bgFader === 255) continue;
      const bgInst = eng.instruments[bg.instrumentId];
      // A metainstrument's layer children carry the sample-mod clock too
      // (item 154) — mirrors applyTrackerTick's own `if (bg.isLayerChild)`
      // gate on advanceSampleMod, just at sample instead of tick rate.
      if (bg.isLayerChild) advanceSampleModExtended(eng, ts, bg, spt);
      renderVoicePair(eng, ts, bg, bgInst, ts.interpolationMode, spt, stereoPair);
      const sL = stereoPair[0];
      const sR = stereoPair[1];
      const instGv = bgInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + bg.randomVolBias / 255.0;
      bg.envVolMix += bg.envVolStep;
      const effEnvVol = bg.volEnvOn ? bg.envVolMix : 1.0;
      advanceVolumeRamp(bg, ts.volDiv);
      advancePitchRamp(bg, spt);
      const faderGain = (255 - bgFader) / 255.0;
      const vol = (effEnvVol * bg.fadeoutVolume * bg.currentMixVolume *
        swingScale * gvol * mvol * instGv * faderGain * bg.layerMixGain * bg.activeAttenGain *
        playhead.masterVolume) / 255.0;
      let lGain = 0.0;
      let rGain = 0.0;
      if (spatial === null) {
        const pan = advancePanRamp(bg, voicePanByte(bg));
        if (pan !== bg.panLawPan) {
          bg.panLawPan = pan;
          bg.panLawL = Math.cos((Math.PI * pan) / 512.0);
          bg.panLawR = Math.sin((Math.PI * pan) / 512.0);
        }
        lGain = bg.panLawL;
        rGain = bg.panLawR;
      } else {
        advancePanRamp(bg, voiceAzimuth(bg), true);
      }
      let rampGain;
      if (bg.rampOutSamples > 0) {
        rampGain = bg.rampOutGain;
        bg.rampOutGain -= bg.rampOutStep;
        bg.rampOutSamples--;
        if (bg.rampOutSamples === 0) bg.active = false;
      } else {
        rampGain = 1.0;
      }
      if (bg.attackRampSamples > 0) {
        const elapsed = ATTACK_RAMP_SAMPLES - bg.attackRampSamples;
        rampGain *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
        bg.attackRampSamples--;
      }
      // Ghosts and layer children belong to the stem of the channel that spawned them.
      if (stems !== null) {
        const sBg = bg.activeChanCount === 2 ? (sL + sR) * 0.5 : sL;
        stems.add(bg, bg.sourceChannel, n, sBg * vol * rampGain);
      }
      if (spatial === null) {
        mixL += sL * vol * lGain * rampGain;
        mixR += sR * vol * rGain * rampGain;
      } else {
        const g = spatialVoiceGains(spatial, bg);
        spatial.addSource(n, sL * vol, g, 0, rampGain);
        if (bg.activeChanCount === 2) {
          spatial.addSource(n, sR * vol, g, spatial.numChannels, rampGain);
        }
      }
      if (abus !== null) {
        const ag = analysisVoiceGains(abus, bg);
        abus.addSource(n, sL * vol, ag, 0, rampGain);
        if (bg.activeChanCount === 2) {
          abus.addSource(n, sR * vol, ag, abus.numChannels, rampGain);
        }
      }
    }

    // Fold the object bus down to the device's pair — for the stereo renderer
    // that IS the mix; another render target hands back its own monitor decode.
    if (spatial !== null) {
      const pair = spatial.stereoAt(n);
      mixL = pair[0];
      mixR = pair[1];
    }

    // Amiga interpolation modes: post-mix LPF chain.
    if (ts.interpolationMode === INTERP_A500) {
      ts.amigaLPStateL = mixL * a500A0 + ts.amigaLPStateL * a500B1;
      ts.amigaLPStateR = mixR * a500A0 + ts.amigaLPStateR * a500B1;
      mixL = ts.amigaLPStateL;
      mixR = ts.amigaLPStateR;
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * ledA1 + sl[0] * ledA2 + sl[1] * ledA1 - sl[2] * ledB1 - sl[3] * ledB2;
        const outR = mixR * ledA1 + sr[0] * ledA2 + sr[1] * ledA1 - sr[2] * ledB1 - sr[3] * ledB2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    } else if (ts.interpolationMode === INTERP_A1200) {
      // The A1200's own 1-pole LPF sits at ~34 kHz — above Nyquist at 32 kHz
      // AND at 48 kHz — so it stays bypassed (pt2-clone).
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * ledA1 + sl[0] * ledA2 + sl[1] * ledA1 - sl[2] * ledB1 - sl[3] * ledB2;
        const outR = mixR * ledA1 + sr[0] * ledA2 + sr[1] * ledA1 - sr[2] * ledB1 - sr[3] * ledB2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    }

    // Double → Float32 (like Kotlin .toFloat()). The clamp that used to sit
    // here now runs below, after the mastering chain — clamping first would
    // hand the limiter a signal whose peaks had already been destroyed. With
    // no chain installed the two forms are identical: `fl` is stored to a
    // Float32Array either way, so the clamp reads back exactly the value it
    // used to compare.
    ts.mixLeft[n] = fround(mixL);
    ts.mixRight[n] = fround(mixR);
  }

  // ── Output stage (TAUD_ENGINE_SPEC.md §12) ──
  // Mastering (item 178) acts here: after the mix has narrowed to binary32 and
  // before it is clamped and dithered. `master` is null unless the song's own
  // `sMst` chain would actually change a sample.
  const master = ts.mastering;
  const meter = ts.masterMeter;
  // The meter reads the same buffer twice — once now, once after the chain —
  // so the "pre" figures cost no copy of the mix.
  if (meter !== null) meter.push(TAP_PRE, ts.mixLeft, ts.mixRight, TRACKER_CHUNK);
  if (master !== null) master.process(ts.mixLeft, ts.mixRight, TRACKER_CHUNK);
  for (let n = 0; n < TRACKER_CHUNK; n++) {
    const fl = ts.mixLeft[n];
    const fr = ts.mixRight[n];
    if (fl < -1.0) ts.mixLeft[n] = -1.0; else if (fl > 1.0) ts.mixLeft[n] = 1.0;
    if (fr < -1.0) ts.mixRight[n] = -1.0; else if (fr > 1.0) ts.mixRight[n] = 1.0;
  }

  // Meters/scopes read the FINISHED pair (post fold/binaural, post Amiga
  // filter, post mastering, post clamp) and, for a surround target, the
  // analysis bus above.
  if (analysis !== null) analysis.finish(TRACKER_CHUNK, ts.mixLeft, ts.mixRight);
  if (meter !== null) {
    meter.push(TAP_POST, ts.mixLeft, ts.mixRight, TRACKER_CHUNK);
    meter.compGrDb = master === null ? 0 : master.compGrDb;
    meter.limGrDb = master === null ? 0 : master.limGrDb;
  }

  pcm32fToPcm8(eng, ts.mixLeft, ts.mixRight, TRACKER_CHUNK, out);
  // Bit usage is a question about the DELIVERED codes, and which those are
  // depends on what the file is going to be — the device's dithered 8-bit
  // output, or the 16 bits a stereo WAV export writes off this same float bus.
  // The tap is given both and bins whichever its depth names.
  if (meter !== null) meter.binOutput(out, ts.mixLeft, ts.mixRight, TRACKER_CHUNK);

  // A halt cue (row.js) clears isPlaying mid-chunk — the transport's OTHER
  // stop, bypassing TaudEngine.stop and its silencing. The rest of THIS chunk
  // still rings out (that is how the song ends, and the chunk is written just
  // above), but what it leaves behind is the same frozen leftover a Stop would
  // have left, waiting for the next jam to resume it. End it here instead.
  if (advancing && !playhead.isPlaying) playhead.silenceSongVoices(playhead.jamActive);

  // Stop the jam-render spin once the audition has gone fully silent.
  if (playhead.jamActive && !playhead.isPlaying &&
      !ts.voices.some((v) => v.active) && !ts.backgroundVoices.some((v) => v.active)) {
    playhead.jamActive = false;
  }

  return out;
}

// ══ src/engine/engine.js ══
// TaudEngine — the device facade, port of AudioAdapter.kt state fields
// (356-397) + AudioJSR223Delegate.kt (the `audio.*` API surface consumed by
// taut.js / playtaud / taud.mjs). One instance ≈ one AudioAdapter.
//
// Differences from the Kotlin device (deliberate, per the port plan):
//  - uploadSampleInstBlob takes the DECOMPRESSED 8650752-byte image
//    (decompression is a format-layer / main-thread concern).
//  - No PCM/MP2/TAD paths, no MMIO/banked windows: callers address the API,
//    playback addresses the 8 MB pool directly (as the Kotlin engine does).
//  - Voice-index clamps mirror the delegate exactly (readbacks clamp to
//    NUM_VOICES-1; jamNote to MAX_VOICES-1).











// Scratch instrument slot for the raw-sample preview (jamSample). It sits just
// past the 1024 addressable bank slots so an audition never borrows a real one;
// every `instruments[voice.instrumentId]` lookup indexes it directly (no & mask).
const AUDITION_SLOT = 1024;

function makePattern() {
  const rows = new Array(64);
  for (let i = 0; i < 64; i++) {
    const c = new TaudPlayData();
    c.pan = 32;
    rows[i] = c;
  }
  return rows;
}

class TaudEngine {
  constructor() {
    this.sampleBin = new Uint8Array(SAMPLE_BIN_TOTAL);
    this.instruments = new Array(AUDITION_SLOT + 1);
    for (let i = 0; i <= AUDITION_SLOT; i++) this.instruments[i] = new TaudInst(i);
    // Pattern store — lazily allocated (memory scales with actual song size).
    this.playdata = new Array(NUM_PATTERNS).fill(null);
    this.emptyPattern = makePattern();
    this.scratchPattern = makePattern();
    this.cueSheet = new Array(NUM_CUES);
    for (let i = 0; i < NUM_CUES; i++) this.cueSheet[i] = new PlayCue();
    this.is64ChannelMode = false;
    // Format version 3's 16-byte pattern cell — a whole-file property.
    this.wideCells = false;
    this.playheads = [
      new Playhead(this, 0), new Playhead(this, 1),
      new Playhead(this, 2), new Playhead(this, 3),
    ];
    // Dither state (pcm32fToPcm8): per-adapter xorshift32 + error history.
    this.xorshift32 = makeXorshift32();
    this.ditherError = new Float32Array(4); // [L0, L1, R0, R1]
    // Stem-export tap (item 93; JS-only, no Kotlin counterpart). null on every
    // normal path — playback and the WAV export never set it. When non-null the
    // mixer hands each voice's PRE-PAN mono contribution to `add()`; nothing
    // else about the render changes, so the main output stays bit-identical.
    this.stemBus = null;
  }

  channelCount() { return this.is64ChannelMode ? MAX_VOICES : NUM_VOICES; }
  cueByteStride() { return this.is64ChannelMode ? CUE_BYTES_64 : CUE_BYTES; }

  /** Read-only view of pattern idx (shared empty pattern when unallocated). */
  patternRead(idx) {
    if (idx < 0 || idx >= NUM_PATTERNS) return this.emptyPattern;
    return this.playdata[idx] ?? this.emptyPattern;
  }

  /** Writable pattern idx, allocating its 64 rows on first access. */
  patternFor(idx) {
    if (idx < 0 || idx >= NUM_PATTERNS) return this.scratchPattern;
    let p = this.playdata[idx];
    if (p === null) {
      p = makePattern();
      this.playdata[idx] = p;
    }
    return p;
  }

  // ── content upload (AudioJSR223Delegate.kt:343-497, 610-640) ──

  /**
   * Install a DECOMPRESSED sample+instrument image: 8 MB samples followed by
   * 1024 (or fewer, for older files) 256-byte instrument records. Slots absent
   * from the blob are cleared; all Ixmp patches are dropped (they point into
   * the replaced pool).
   */
  uploadSampleInstBlob(image) {
    const sampleSize = SAMPLE_BIN_TOTAL;
    if (image.length < sampleSize + 65536) return 0;
    this.sampleBin.set(image.subarray(0, sampleSize));
    const instCount = Math.min(1024, Math.trunc((image.length - sampleSize) / 256));
    const rec = new Uint8Array(256);
    for (let instIdx = 0; instIdx < 1024; instIdx++) {
      if (instIdx < instCount) {
        rec.set(image.subarray(sampleSize + instIdx * 256, sampleSize + (instIdx + 1) * 256));
      } else {
        rec.fill(0);
      }
      this.instruments[instIdx].loadRecord(rec);
    }
    for (const inst of this.instruments) inst.extraPatches = null;
    return image.length;
  }

  /** Capture the raw 8650752-byte sample+instrument image (save path). */
  captureSampleInstImage() {
    const out = new Uint8Array(SAMPLE_BIN_TOTAL + 1024 * 256);
    out.set(this.sampleBin);
    for (let i = 0; i < 1024 * 256; i++) {
      out[SAMPLE_BIN_TOTAL + i] = this.instruments[(i / 256) | 0].getByte(i % 256);
    }
    return out;
  }

  /** Upload up to 256 bytes defining instrument slot (0-1023; 256+ = aux bin). */
  uploadInstrument(slot, bytes) {
    const inst = this.instruments[slot & 0x3ff];
    const rec = new Uint8Array(256);
    for (let i = 0; i < Math.min(256, bytes.length); i++) rec[i] = bytes[i] & 0xff;
    inst.loadRecord(rec);
  }

  /**
   * Upload an Ixmp "extra samples" block for instrument slot. Patches are
   * variable-length: version byte (0b x00Pfpvi) + 30 common bytes + optional
   * x/v/p/f/P blocks in that order (AudioJSR223Delegate.kt:357-430).
   */
  uploadInstrumentPatches(slot, bytes) {
    const inst = this.instruments[slot & 0x3ff];
    const patches = parsePatchesBlob(bytes);
    inst.extraPatches = patches.length === 0 ? null : patches;
  }

  getInstrumentPatchCount(slot) {
    const p = this.instruments[slot & 0x3ff].extraPatches;
    return p === null ? 0 : p.length;
  }

  /** Exact byte-inverse of uploadInstrumentPatches (capture path). */
  getInstrumentPatches(slot) {
    const patches = this.instruments[slot & 0x3ff].extraPatches;
    if (patches === null) return new Uint8Array(0);
    return writePatchesBlob(patches);
  }

  clearInstrumentPatches(slot) {
    this.instruments[slot & 0x3ff].extraPatches = null;
  }

  /** Deallocate pattern slot back to unallocated (patternRead then falls back
   *  to emptyPattern, same as a slot that was never written) — used to blank
   *  the persistent pattern store's stale tail when a shorter song loads over
   *  a longer one (item 174), the same trouble uploadDocument's cue high-water
   *  blanking already covers for the cue sheet. */
  clearPattern(slot) {
    this.playdata[slot & 0x7fff] = null;
  }

  /** Upload 512 bytes (64 rows × 8) defining pattern slot. */
  uploadPattern(slot, bytes) {
    const pat = this.patternFor(slot & 0x7fff);
    if (this.wideCells) {
      const n = Math.min(PATTERN_BYTES_WIDE, bytes.length);
      for (let i = 0; i < n; i++) {
        pat[(i / CELL_BYTES_WIDE) | 0].setByteWide(i % CELL_BYTES_WIDE, bytes[i] & 0xff);
      }
      return;
    }
    const n = Math.min(PATTERN_BYTES, bytes.length);
    for (let i = 0; i < n; i++) pat[(i / CELL_BYTES) | 0].setByte(i % CELL_BYTES, bytes[i] & 0xff);
  }

  /**
   * Select the file format's cell layout (version 3 = the wide cell). A
   * whole-file property: patterns uploaded afterwards are read in this layout,
   * and the volume columns' width follows it. Set it BEFORE uploading anything.
   */
  setCellFormat(wide) {
    this.wideCells = !!wide;
    for (const p of this.playheads) p.trackerState?.setCellFormat(this.wideCells);
  }
  getCellFormat() { return this.wideCells; }

  /** Upload one cue entry (64 bytes / 128 bytes in 64-channel mode). */
  uploadCue(idx, bytes) {
    const cue = this.cueSheet[idx & (NUM_CUES - 1)];
    const n = Math.min(this.cueByteStride(), bytes.length);
    for (let i = 0; i < n; i++) cue.write(i, bytes[i] & 0xff);
  }

  set64ChannelMode(enabled) { this.is64ChannelMode = enabled; }

  // ── transport / params (delegate 56-139, 328-337, 505-575) ──

  setTrackerMode(ph) { /* PCM mode does not exist here; tracker is the only mode */ }
  play(ph) { this.playheads[ph].isPlaying = true; }

  /**
   * Stop the transport, and end the song's voices with it. Clearing isPlaying
   * is all it takes to go SILENT (the mixer runs only while isPlaying or
   * jamActive), but on its own it leaves every voice FROZEN mid-note for
   * whatever turns the mix back on — see Playhead.silenceSongVoices. Ramped
   * while an audition is still sounding, because that mix keeps running;
   * dropped outright otherwise, where nothing renders and nothing is heard.
   */
  stop(ph) {
    const p = this.playheads[ph];
    p.isPlaying = false;
    p.silenceSongVoices(p.jamActive);
  }

  isPlaying(ph) { return this.playheads[ph].isPlaying; }

  setMasterVolume(ph, volume) { this.playheads[ph].masterVolume = volume & 255; }
  getMasterVolume(ph) { return this.playheads[ph].masterVolume; }
  setMasterPan(ph, pan) { this.playheads[ph].masterPan = pan & 255; }
  getMasterPan(ph) { return this.playheads[ph].masterPan; }

  setBPM(ph, bpm) { this.playheads[ph].bpm = Math.min(Math.max(bpm, 25), 535); }
  getBPM(ph) { return this.playheads[ph].bpm; }
  setTickRate(ph, rate) { this.playheads[ph].tickRate = rate & 255; }
  getTickRate(ph) { return this.playheads[ph].tickRate; }

  /**
   * Song tuning (item 77): `baseNote` sounds at `freq` Hz. Either reading zero
   * means the tracker default (spec) — tuningRatioOf applies that rule. Takes
   * effect on the next tick for notes already sounding, so dialling a tuning
   * while the song plays bends it in place rather than waiting for retriggers.
   */
  setTuning(ph, baseNote, freq) {
    const p = this.playheads[ph];
    p.tuningBaseNote = baseNote & 0xffff;
    p.tuningFreq = freq;
    p.trackerState.tuningRatio = tuningRatioOf(p.tuningBaseNote, p.tuningFreq);
  }
  getTuningRatio(ph) { return this.playheads[ph].trackerState.tuningRatio; }

  setCuePosition(ph, pos) {
    const p = this.playheads[ph];
    p.position = pos & (NUM_CUES - 1);
    p.trackerState.cuePos = p.position;
  }
  getCuePosition(ph) { return this.playheads[ph].position; }
  getTrackerRow(ph) { return this.playheads[ph].trackerState.rowIndex; }

  /** Set the starting row for the next play, resetting timing + silencing every
   *  voice. This is the common pre-play reset point (playFrom / pattern
   *  preview), so it clears the transient per-play state that would otherwise
   *  bleed a prior playback into a fresh start — notably the NNA background
   *  ghosts, which stop() leaves active and a replay would resume (the
   *  "mysteriously lingering notes" bug), and the CHANNEL-scope mixer state the
   *  song's own effects write (item 125: pan, elevation, channel volume). The
   *  playhead's tempo/volume are deliberately NOT touched (a replay must keep
   *  the song's tempo — that's why this is not a full resetParams), and neither
   *  is the host's per-channel fader/mute, which belongs to the desk. */
  setTrackerRow(ph, row) {
    const ts = this.playheads[ph].trackerState;
    ts.rowIndex = Math.min(Math.max(row, 0), 63);
    ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0;
    ts.firstRow = true;
    ts.pendingOrderJump = -1;
    ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    ts.patternDelayRemaining = 0;
    ts.patternDelayActive = false;
    ts.sexWinningChannel = -1;
    ts.finePatternDelayExtra = 0;
    ts.pendingInterrupts = 0;
    ts.interruptArgs.fill(0);
    for (const v of ts.voices) {
      v.active = false;
      // Clear per-voice pattern-loop (S$Bx) + Ditto (effect 7) memory so a replay
      // never resumes effect status from the previous play (item 44). These are
      // transient playback state, not song settings — the same rationale as the
      // ghost/note clears; resetPatternLoopState normally does this on cue
      // advances, but nothing did it at play START.
      v.loopStartRow = 0; v.loopCount = 0;
      v.dittoActive = false; v.dittoSourceStart = 0; v.dittoLength = 0; v.dittoEndRow = 0;
      // Channel-scope state, back to the song-start defaults (item 125). A
      // trigger deliberately does NOT reset any of this — pan and channel volume
      // belong to the CHANNEL, not the note — so without a clear here the last
      // S $80xx / M / N / P / X / Z of the previous play was still in force, and
      // a song played twice, or a second file opened on top of the first, panned
      // its notes wherever the last one had left them. Same defaults as
      // resetParams (state.js).
      v.channelVolume = ts.volMax;
      v.channelPan = 0x80;
      v.rowPan = 32;
      v.panAzimuth = 128.0;
      v.panElevation = 0.0;
      v.notePan = 0;
      v.noteElevation = 0.0;
      v.spatialTargetAz = 128.0;
      v.spatialTargetEl = 0.0;
      v.spatialSlideActive = false;
      v.panbrelloOffset = 0;
      v.glissandoOn = false;
      // Bitcrusher (8) / Overdrive (9) are channel colouring in exactly the same
      // sense — the song writes them, a trigger deliberately leaves them, and
      // nothing else clears them — so without this a song that crushed once was
      // still crushed on the replay, right through the rows before its next
      // `8 $xxxx`. right.reset() covers the stereo twin's crusher history.
      v.clipMode = 0;
      v.bitcrusherDepth = 0;
      v.bitcrusherSkip = 0;
      v.bitcrusherCounter = 0;
      v.bitcrusherHeld = 0.0;
      v.overdriveAmp = 0;
      v.right.bitcrusherCounter = 0;
      v.right.bitcrusherHeld = 0.0;
      // Per-note S $7x overrides (NNA + the four envelope switches).
      v.nnaOverride = -1;
      v.volEnvOn = true; v.panEnvOn = true; v.pitchEnvOn = true; v.filterEnvOn = true;
    }
    ts.backgroundVoices.length = 0; // drop lingering NNA ghosts from a prior play
    // The mastering chain (item 178) is per-PLAY transient in exactly the sense
    // the ghost pool is: a compressor still holding six decibels of reduction
    // from before the seek, and a look-ahead buffer still holding two
    // milliseconds of the previous playback, both bleed the old take into the
    // new one. Its PARAMETERS are the song's and are left alone, like the tempo.
    ts.mastering?.reset();
    // …and the meter's integration describes one playback, so it starts again
    // with it — including the bit histogram, which is cumulative by design.
    ts.masterMeter?.resetAll();
    // Re-arm any Pattern-Ditto (effect 7) region that a mid-pattern start lands
    // inside, so a ghosted (repeated) row sounds when you play from it (item 81).
    reconstructDittoState(this, ts, ts.rowIndex);
  }

  setTrackerMixerFlags(ph, flags) {
    const p = this.playheads[ph];
    p.initialGlobalFlags = flags;
    p.updateTrackerGlobalBehaviour(flags);
  }
  getTrackerMixerFlags(ph) { return this.playheads[ph].initialGlobalFlags; }

  /**
   * Song-immutable surround model (#998): 0 stereo, 1 planar (360° panning),
   * 2 spatial. Anything but stereo mixes through the object bus.
   */
  setSurroundModel(ph, model) {
    const p = this.playheads[ph];
    p.surroundModel = model & 3;
    p.applySurroundModel();
  }
  getSurroundModel(ph) { return this.playheads[ph].surroundModel; }

  /**
   * Swap the render target the object bus feeds (#998.0). Null = the device's
   * own monitor (see setMonitorMode); an exporter installs e.g. an
   * AmbisonicRenderer and reads `trackerState.spatial.data` after each chunk.
   * No-op for a stereo song.
   */
  setSpatialRenderer(ph, renderer) {
    const p = this.playheads[ph];
    p.spatialRenderer = renderer;
    p.applySurroundModel();
  }

  /**
   * How the device monitors a surround song (#998.3): MONITOR_FOLD folds it
   * onto the stereo pan law, MONITOR_BINAURAL renders it through a head model
   * so elevation and front/back are audible on headphones. Ignored while an
   * exporter's renderer is installed, and irrelevant to a stereo song.
   */
  setMonitorMode(ph, mode) {
    const p = this.playheads[ph];
    p.monitorMode = mode & 1;
    p.applySurroundModel();
  }
  getMonitorMode(ph) { return this.playheads[ph].monitorMode; }

  /**
   * Master-strip analysis tap (item 98): ANALYSIS_OFF, ANALYSIS_STEREO,
   * ANALYSIS_AMBISONIC or a speaker-layout key. Costs nothing while off, so the
   * host turns it on only while the strip is visible.
   */
  setAnalysis(ph, target) { this.playheads[ph].trackerState.setAnalysis(target); }
  getAnalysis(ph) { return this.playheads[ph].trackerState.analysisTarget; }

  /**
   * The song's mastering chain (item 178, TAUD_ENGINE_SPEC.md §12.1). `params`
   * is the decoded `sMst` record; a neutral one costs nothing at all, so this
   * is safe to push on every load whether the song declares a chain or not.
   *
   * A conforming player MUST call this with what the file declares — the
   * chain is part of how the song sounds, not an editor preference.
   */
  setMastering(ph, params) { this.playheads[ph].trackerState.setMastering(params); }
  getMastering(ph) { return this.playheads[ph].trackerState.masteringParams; }

  /**
   * Install (or drop) the Mastering view's metering tap (loudness.js). Like the
   * strip's analysis tap this costs nothing while off, so a host turns it on
   * only while the view that reads it is on screen.
   */
  setMasterMeter(ph, on, scramble = false, bitDepth = undefined) {
    this.playheads[ph].trackerState.setMasterMeter(on, scramble, bitDepth);
  }

  setSongGlobalVolume(ph, volume) { this.playheads[ph].globalVolume = volume & 255; }
  getSongGlobalVolume(ph) { return this.playheads[ph].globalVolume; }
  setSongMixingVolume(ph, volume) { this.playheads[ph].mixingVolume = volume & 255; }
  getSongMixingVolume(ph) { return this.playheads[ph].mixingVolume; }

  resetParams(ph) { this.playheads[ph].resetParams(); }
  resetSampleFxState(ph) { this.playheads[ph].resetSampleFxState(); }

  getFreePlayhead(fallback) {
    for (let i = 0; i < this.playheads.length; i++) {
      if (!this.playheads[i].isPlaying) return i;
    }
    return fallback;
  }

  /** Drain the pending interrupt latch (read-to-acknowledge, edge-triggered). */
  pollTrackerInterrupts(ph) {
    return this.playheads[ph].trackerState.drainInterrupts();
  }

  /** Argument that fired with Int `n` (item 181) — read alongside the mask the
   *  drain above returned, and only for the bits it actually set. */
  interruptArg(ph, n) {
    return this.playheads[ph].trackerState.interruptArg(n);
  }

  // ── jam / audition (AudioAdapter.kt:4322-4337) ──

  /** Voice index of jam-bank slot `i` (item 140). Hosts address the bank
   *  through this rather than by arithmetic, so the base can move. */
  jamVoice(i) { return JAM_VOICE_BASE + (((i | 0) % JAM_VOICES) + JAM_VOICES) % JAM_VOICES; }

  jamNote(ph, vi, note, inst, audition = false) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
    note &= 0xffff;
    inst &= 0x3ff;
    triggerMetaOrNote(this, ts, ts.voices[v], v, note, inst, -1);
    // Audition-only (item 51): a STRICT metainstrument only sounds where its
    // Ixmp zones actually place a sample, so an arbitrary jammed pitch is often
    // silent. In pure-audition contexts (Instruments/Samples views) retry at the
    // nearest note it can actually sound, so the user hears the instrument.
    // Note ENTRY (Timeline/Patterns) keeps the exact pitch.
    if (audition && !ts.voices[v].active &&
        !ts.backgroundVoices.some((b) => b.sourceChannel === v && b.active)) {
      const alt = this._auditionNoteFor(inst, note);
      if (alt >= 0) triggerMetaOrNote(this, ts, ts.voices[v], v, alt, inst, -1);
    }
    p.jamActive = true;
  }

  /**
   * Preview the EXACT pooled sample `spec` (ptr/len/rate/loop) on voice `vi`,
   * BYPASSING all instrument / metainstrument zone resolution. The Samples and
   * Instruments editors call this so the audition plays the wave the user is
   * looking at, not whatever a metainstrument would map `note` to (bug #65).
   * JS-only (no Kotlin counterpart): a scratch instrument in AUDITION_SLOT
   * carries the sample and its clean default envelope so the note simply
   * sounds at full volume until jamStop / sample end.
   * `spec`: { ptr, len, rate, playStart?, loopStart, loopEnd, loopMode, detune?,
   * chanPtr2?, chanMode? } — chanPtr2 auditions a STEREO pair (item 90) by
   * hanging a synthetic full-range 's' patch off the scratch instrument, since
   * only an Ixmp patch can carry a second channel.
   */
  jamSample(ph, vi, note, spec) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
    note &= 0xffff;
    const inst = this.instruments[AUDITION_SLOT];
    inst.samplePtr = spec.ptr >>> 0;
    inst.sampleLength = spec.len | 0;
    inst.samplingRate = spec.rate | 0;
    inst.samplePlayStart = spec.playStart | 0;
    inst.sampleLoopStart = spec.loopStart | 0;
    inst.sampleLoopEnd = spec.loopEnd | 0;
    inst.loopMode = (spec.loopMode | 0) & 0x07; // loop mode + sustain, drop percussion bit
    inst.sampleDetune = (spec.detune | 0) & 0xffff;
    inst.extraPatches = spec.chanPtr2
      ? [makeInstPatch({
          pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
          samplePtr: inst.samplePtr, sampleLength: inst.sampleLength,
          playStart: inst.samplePlayStart, loopStart: inst.sampleLoopStart,
          loopEnd: inst.sampleLoopEnd, samplingRate: inst.samplingRate,
          sampleDetune: inst.sampleDetuneSigned, loopMode: inst.loopMode,
          hasChanBlock: true, chanCount: 2, chanMode: spec.chanMode | 0,
          chanPtrs: [spec.chanPtr2 >>> 0],
        })]
      : null;
    triggerNote(this, ts, ts.voices[v], note, AUDITION_SLOT, -1);
    p.jamActive = true;
  }

  /** True when metainstrument `inst` would produce at least one sounding layer
   *  at `note` (mirrors the strict-layer gating in triggerMetaOrNote). */
  _metaSoundsAt(inst, note) {
    // An FM rack stands or falls on operator 0: the rest of the rack is read
    // through it, so a note its rectangle excludes is silent whatever the
    // modulators say (§5.5.1, triggerFmRack).
    if (inst.isFm) {
      const o = inst.metaLayers[0];
      return inst.fmProgram !== null && o.instIdx >= 1 &&
        note >= o.pitchStart && note <= o.pitchEnd && o.volStart <= 0x3f && o.volEnd >= 0x3f;
    }
    let layers = inst.resolveMetaLayers(note, 0x3f);
    if (inst.metaStrict) {
      layers = layers.filter((l) => {
        // The pitch the layer SOUNDS — a fixed-pitch layer's own (item 179).
        let n = layerNote(l, note);
        n = n < 0x20 ? 0x20 : n > 0xffff ? 0xffff : n;
        return this.instruments[l.instIdx].resolvePatch(n, 0x3f) !== null;
      });
    }
    return layers.length > 0;
  }

  /** Nearest note to `note` (within the metainstrument's layer bboxes) that
   *  actually sounds, or -1 if none / not a metainstrument. */
  _auditionNoteFor(instId, note) {
    const inst = this.instruments[instId];
    if (!inst || !inst.isMeta) return -1;
    let lo = 0xffff, hi = 0x20;
    for (const l of inst.metaLayers) {
      if (l.pitchStart < lo) lo = l.pitchStart;
      if (l.pitchEnd > hi) hi = l.pitchEnd;
    }
    if (lo < 0x20) lo = 0x20;
    if (hi < lo) return -1;
    // Sweep outward from the requested note at a fine step, clamped to the
    // bboxes' union (a jam event, so the cost is irrelevant).
    const step = 0x20;
    for (let d = 0; d <= hi - lo; d += step) {
      const up = note + d, dn = note - d;
      if (up >= lo && up <= hi && this._metaSoundsAt(inst, up)) return up;
      if (dn >= lo && dn <= hi && this._metaSoundsAt(inst, dn)) return dn;
    }
    return -1;
  }

  jamStop(ph) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    for (const v of ts.voices) v.active = false;
    for (const v of ts.backgroundVoices) v.active = false;
    p.jamActive = false;
  }

  /**
   * Stop ONE audition voice and everything it spawned (metainstrument layer
   * children, NNA ghosts) — what a released key of a held chord ends, where
   * jamStop's "deactivate the world" would take the song's own voices with it.
   * `vi < 0` stops the whole jam bank, which is the focus-loss panic: still not
   * a single song voice. JS-only (item 140), no Kotlin counterpart.
   *
   * Ramped through the pattern note-cut's own path (note word 0x0002) rather
   * than dropped on the spot: a key release lands wherever the waveform happens
   * to be, and that ramp exists because stepping to zero there clicks.
   */
  jamStopVoice(ph, vi) {
    const ts = this.playheads[ph].trackerState;
    const lo = vi < 0 ? JAM_VOICE_BASE : Math.min(vi, TOTAL_VOICES - 1);
    const hi = vi < 0 ? TOTAL_VOICES - 1 : lo;
    for (let v = lo; v <= hi; v++) startCutRamp(ts.voices[v]);
    for (const bg of ts.backgroundVoices) {
      if (bg.sourceChannel >= lo && bg.sourceChannel <= hi) startCutRamp(bg);
    }
  }

  // ── per-voice readbacks (delegate 144-325; clamps mirror the delegate) ──

  _voice(ph, vi) {
    const v = Math.min(Math.max(vi, 0), NUM_VOICES - 1);
    return this.playheads[ph].trackerState.voices[v];
  }

  setVoiceMute(ph, vi, muted) { this._voice(ph, vi).fader = muted ? 255 : 0; }
  getVoiceMute(ph, vi) { return this._voice(ph, vi).fader === 255; }
  setVoiceFader(ph, vi, fader) { this._voice(ph, vi).fader = fader & 255; }
  getVoiceFader(ph, vi) { return this._voice(ph, vi).fader; }

  getVoiceEffectiveVolume(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 0.0;
    const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
    const faderGain = (255 - v.fader) / 255.0;
    return Math.min(Math.max(effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain, 0.0), 1.0);
  }

  /** Pan as the stereo meters want it: a surround voice reports where the
   *  monitor downmix puts it (rear positions fold onto the front arc). */
  getVoiceEffectivePan(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 128;
    if (this.playheads[ph].surroundModel !== SURROUND_STEREO) {
      return Math.round(foldAzimuthToPan(voiceAzimuth(v)));
    }
    // Panbrello counts here (the surround branch already has it, via
    // voiceAzimuth): it is a commanded movement the meter should show. The
    // random pan swing still does not — that is per-trigger jitter, not a
    // position the song asked for.
    if (v.hasPanEnv && v.panEnvOn) {
      const envPanRaw = Math.min(Math.max(Math.trunc(v.envPan * 255.0), 0), 255);
      return Math.min(Math.max(v.channelPan + v.notePan + envPanRaw - 128 + v.panbrelloOffset,
        0), 255);
    }
    return Math.min(Math.max(v.channelPan + v.notePan + v.panbrelloOffset, 0), 255);
  }

  /** Where a voice actually sits (#998): 512-unit azimuth, 128-unit elevation.
   *  Stereo songs report the pan byte's front-arc position. */
  getVoiceSpatialAzimuth(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[ph].surroundModel === SURROUND_STEREO
      ? clamp(v.channelPan + v.notePan + v.panbrelloOffset, 0, 255) : voiceAzimuth(v);
  }
  getVoiceSpatialElevation(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[ph].surroundModel === SURROUND_STEREO ? 0 : voiceElevation(v);
  }

  getVoiceActive(ph, vi) { return this._voice(ph, vi).active; }

  /**
   * Fill the per-voice soundscope rings (`Voice.scopeBuffer`) or not. Off by
   * default: the Kotlin device has no such switch because a TSVM guest can read
   * the scope window through MMIO at any instant, whereas here a host that
   * wants waveforms has to ask for them — and the two stores per voice per
   * sample the ring costs are charged over all 80 voice slots, sounding or not.
   */
  setVoiceScopeTap(ph, on) { this.playheads[ph].trackerState.scopeOn = !!on; }

  getActiveNoteCounts(ph) {
    const counts = new Int32Array(1024);
    const ts = this.playheads[ph].trackerState;
    for (const v of ts.voices) {
      if (v.active) counts[v.instrumentId & 0x3ff]++;
    }
    return counts;
  }

  getVoiceInvertSpeed(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.invertSpeed : 0;
  }

  getInstrumentInvertMask(slot) {
    const mask = this.instruments[slot & 0x3ff].invertMask;
    return mask === null ? new Uint8Array(0) : mask.slice();
  }

  /**
   * The instrument's live sample modification (item 130), for the sample view's
   * overlay: the operation, which side of the region it works on, the region as
   * a FRACTION pair plus its comb (item 153), and whatever the operation has
   * accumulated. Plain numbers — the reply crosses a postMessage. The MOD_INVERT
   * bit-mask travels with it as `modMask`.
   *
   * Field names are the instrument's own, so the reply can be handed straight to
   * resolveModGeom / modTouches / extModTouches / modAddressExt / applyExtLevel:
   * the view draws the modification through the engine's own geometry and
   * argument-extension machinery (item 162) rather than a re-implementation of
   * it. The `modOpExt`-and-after fields are only ever live while `modOpExt` is
   * non-zero (see inst.js setModOpExt/clearModState) — harmless to always send.
   */
  getInstrumentSampleMod(slot) {
    const inst = this.instruments[slot & 0x3ff];
    return {
      modOp: inst.modOp, modInvert: inst.modInvert,
      modFrom: inst.modFrom, modTo: inst.modTo,
      modCombBits: inst.modCombBits, modCombOdd: inst.modCombOdd,
      modRot: inst.modRot, modSub: inst.modSub, modOn: inst.modOn,
      modScatter: inst.modScatter, modSeed: inst.modSeed, modEpoch: inst.modEpoch,
      modOpExt: inst.modOpExt, modF: inst.modF, modStepIndex: inst.modStepIndex,
      modXor: inst.modXor, modBitRot: inst.modBitRot,
      modBitPermIdx: inst.modBitPermIdx, modBitPermOn: inst.modBitPermOn,
      modExtSwapA: inst.modExtSwapA, modExtSwapB: inst.modExtSwapB,
      modExtMirror: inst.modExtMirror,
      // 102/12x: the instrument's own funk-repeat walk (item 173 follow-up),
      // for the Samples view's overlay — same idea as SNAP_V_FUNK_POS/LEN
      // above, but this state is the INSTRUMENT's, not a voice's.
      modFunkWalk: inst.modFunkWalk, modFunkPos: inst.modFunkPos, modFunkLen: inst.modFunkLen,
    };
  }

  /** The modification's inversion mask, one bit per SAMPLE byte (item 130). */
  getInstrumentModMask(slot) {
    const mask = this.instruments[slot & 0x3ff].modMask;
    return mask === null ? new Uint8Array(0) : mask.slice();
  }

  getVoiceNote(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.noteVal & 0xffff : 0;
  }

  getVoiceInstrument(ph, vi) {
    const v = this._voice(ph, vi);
    // Pattern-level instrument (meta slot), not the resolved layer child.
    return v.active ? (v.displayInst || v.instrumentId) & 0x3ff : 0;
  }

  getVoiceSamplePos(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.samplePos : -1.0;
  }

  getVoiceSamplePtr(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.activeSamplePtr : -1;
  }

  getVoiceSampleLength(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.activeSampleLength : 0;
  }

  getVoiceEnvVolIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envIndex : -1; }
  getVoiceEnvVolTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envTimeSec : 0.0; }
  getVoiceEnvPanIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanIndex : -1; }
  getVoiceEnvPanTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanTimeSec : 0.0; }
  getVoiceEnvPitchIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchIndex : -1; }
  getVoiceEnvPitchTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchTimeSec : 0.0; }
  getVoiceEnvFilterIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterIndex : -1; }
  getVoiceEnvFilterTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterTimeSec : 0.0; }

  // ── rendering ──

  /**
   * Render one 512-frame chunk (interleaved U8 stereo, 1024 bytes) for playhead
   * ph. Pass a reusable out buffer to avoid allocation; a fresh one is made
   * otherwise. Returns the buffer (or null when the playhead has no state).
   */
  renderChunk(ph, out = new Uint8Array(TRACKER_CHUNK * 2)) {
    return generateTrackerAudio(this, this.playheads[ph], out);
  }
}

// ══ src/worklet/protocol.js ══
// Message protocol shared by the AudioWorklet processor and the main thread.
// The master-strip block's geometry comes from the analysis tap itself, so the
// wire layout cannot drift from what fills it.
//
// Commands (main → worklet) are plain {t, ...} messages, deliberately
// isomorphic to the TSVM `audio.*` calls taut.js makes; bulk payloads ride as
// transferred ArrayBuffers. Snapshots (worklet → main) are recycled
// Float32Array buffers with the fixed layout below.




const CMD = Object.freeze({
  INIT: "init",
  UPLOAD_SAMPLE_INST_BLOB: "uploadSampleInstBlob", // {image: ArrayBuffer} (decompressed)
  UPLOAD_INSTRUMENT: "uploadInstrument",           // {slot, bytes: ArrayBuffer}
  UPLOAD_INSTRUMENT_PATCHES: "uploadInstrumentPatches", // {slot, bytes: ArrayBuffer}
  CLEAR_INSTRUMENT_PATCHES: "clearInstrumentPatches",   // {slot}
  UPLOAD_PATTERN: "uploadPattern",                 // {slot, bytes: ArrayBuffer}
  UPLOAD_PATTERNS: "uploadPatterns",               // {slots: int[], blob: ArrayBuffer} (bulk, 512 B each)
  CLEAR_PATTERN: "clearPattern",                   // {slot} — blank a stale pattern slot (item 174)
  UPLOAD_CUE: "uploadCue",                         // {idx, bytes: ArrayBuffer}
  SET_64CH: "set64ChannelMode",                    // {on}
  SET_CELL_FORMAT: "setCellFormat",                // {wide} — format v3's 16-byte cell
  SET_BPM: "setBPM",                               // {ph, bpm}
  SET_TICK_RATE: "setTickRate",                    // {ph, rate}
  SET_TUNING: "setTuning",                         // {ph, baseNote, freq} — song tuning (item 77)
  SET_SONG_GLOBAL_VOLUME: "setSongGlobalVolume",   // {ph, volume}
  SET_SONG_MIXING_VOLUME: "setSongMixingVolume",   // {ph, volume}
  SET_MASTER_VOLUME: "setMasterVolume",            // {ph, volume}
  SET_MASTER_PAN: "setMasterPan",                  // {ph, pan}
  SET_TRACKER_MIXER_FLAGS: "setTrackerMixerFlags", // {ph, flags}
  SET_SURROUND_MODEL: "setSurroundModel",          // {ph, model} — #998 song flag
  SET_MONITOR_MODE: "setMonitorMode",              // {ph, mode} — #998.3 fold / binaural
  SET_ANALYSIS: "setAnalysis",                     // {ph, target} — item 98 master-strip tap
  SET_MASTERING: "setMastering",                   // {ph, params} — item 178, the song's sMst chain
  SET_MASTER_METER: "setMasterMeter",              // {ph, on} — item 178 Mastering-view tap
  PLAY: "play",                                    // {ph}
  STOP: "stop",                                    // {ph}
  SET_CUE_POSITION: "setCuePosition",              // {ph, pos}
  SET_TRACKER_ROW: "setTrackerRow",                // {ph, row}
  RESET_PARAMS: "resetParams",                     // {ph}
  RESET_SAMPLE_FX_STATE: "resetSampleFxState",     // {ph} — invert masks, funk windows, notefx 2/3
  JAM_NOTE: "jamNote",                             // {ph, voice, note, inst}
  JAM_SAMPLE: "jamSample",                         // {ph, voice, note, spec} — raw pooled-sample preview
  JAM_STOP: "jamStop",                             // {ph} — every voice (panic)
  JAM_STOP_VOICE: "jamStopVoice",                  // {ph, voice} — one audition voice; voice < 0 = the whole jam bank
  SET_VOICE_MUTE: "setVoiceMute",                  // {ph, voice, muted}
  SET_VOICE_FADER: "setVoiceFader",                // {ph, voice, fader}
  QUERY_INVERT_MASK: "queryInvertMask",            // {slot} → MSG.INVERT_MASK
  SNAPSHOT_RETURN: "snapshotReturn",               // {buffer: ArrayBuffer} (recycle)
  USE_SAB: "useSab",                               // {sab: SharedArrayBuffer} — switch to shared-memory snapshots
  USE_AUDIO_SAB: "useAudioSab",                    // {sab: SharedArrayBuffer} — Tier 2 audio ring (worklet consumes; worker produces)
});

const MSG = Object.freeze({
  SNAPSHOT: "snapshot", // {buffer: ArrayBuffer} — Float32Array, layout below
  // {slot, mask: ArrayBuffer, mod} — S $F0xx / notefx 2 invert-loop bit mask, plus
  // the instrument's notefx 2/3 region geometry (engine getInstrumentSampleMod).
  INVERT_MASK: "invertMask",
  READY: "ready",
  PROFILE: "profile",   // {cpuFrac, renderFrac, ...} — dev profiler, ~1/s (opt-in)
});

// ── Snapshot layout (Float32Array; integers are exact in f32 up to 2^24) ──
const SNAP_CUE_POS = 0;
const SNAP_ROW_INDEX = 1;
const SNAP_TICK_IN_ROW = 2;
const SNAP_BPM = 3;
const SNAP_TICK_RATE = 4;
const SNAP_FLAGS = 5;          // bit0 isPlaying, bit1 jamActive
const SNAP_INTERRUPT_MASK = 6; // drained latch (edge-triggered)
const SNAP_CHANNEL_COUNT = 7;
// Song global volume (0..255). Effects V and W move it DURING playback, which
// is what the master fader follows (item 98).
const SNAP_GLOBAL_VOLUME = 8;
// ── Master-strip analysis (item 98) ──
// All of these are zero while the tap is off. The meter/correlation figures are
// sums over SNAP_AN_FRAMES samples — one snapshot interval — and the UI owns
// the ballistics.
const SNAP_AN_METERS = 9;      // metered channel count (0 = tap off)
const SNAP_AN_FRAMES = 10;     // samples integrated since the last snapshot
const SNAP_AN_FIELD = 11;      // Σ (W²+X²+Y²+Z²)/2 — acoustic energy density
const SNAP_AN_CORR_LL = 12;    // Σ L², Σ R², Σ L·R of the stereo (decode)
const SNAP_AN_CORR_RR = 13;
const SNAP_AN_CORR_LR = 14;
const SNAP_AN_RING_WRITE = 15; // next frame index in the scope ring
// ── Mastering meter (item 178) ──
// Zero while the Mastering view's own tap is off. Gain reduction is the peak
// over the interval, in dB and never positive; the histogram total is what the
// normalised bins below are fractions of.
const SNAP_MM_FRAMES = 16;     // samples integrated since the last snapshot (0 = tap off)
const SNAP_MM_COMP_GR = 17;    // compressor gain reduction, dB (≤ 0)
const SNAP_MM_LIM_GR = 18;     // limiter gain reduction, dB (≤ 0)
const SNAP_MM_HIST_TOTAL = 19; // samples binned into the histogram so far
const SNAP_MM_SPEC_WRITE = 20; // next frame index in the spectrum rings
// Bit usage, computed by the engine over the FULL code census (65536 entries at
// 16 bits) — an exact `used` and `span` cannot be recovered from the 256
// buckets the wire carries, so the figures travel beside the picture.
const SNAP_MM_HIST_DEPTH = 21;   // bits per sample the census was taken at
const SNAP_MM_HIST_USED = 22;    // codes that occur at all
const SNAP_MM_HIST_MIN = 23;     // lowest and highest code seen
const SNAP_MM_HIST_MAX = 24;
const SNAP_MM_HIST_ENTROPY = 25; // Shannon entropy of the distribution, bits
// ── Interrupt arguments (item 181) ──
// 16 words, one per Int0..IntF, carrying the `:` argument the marker row named.
// Only the entries whose SNAP_INTERRUPT_MASK bit is set mean anything. Written
// on the postMessage path only; the SAB path carries them in its Int32 tail.
const SNAP_INTERRUPT_ARGS = 26;
const SNAP_HEADER_SIZE = SNAP_INTERRUPT_ARGS + NUM_INTERRUPTS;

// Per-voice block, stride SNAP_VOICE_STRIDE, SNAP_MAX_VOICES blocks.
const SNAP_V_ACTIVE = 0;
const SNAP_V_EFF_VOL = 1;      // 0..1 (getVoiceEffectiveVolume)
const SNAP_V_EFF_PAN = 2;      // 0..255 (getVoiceEffectivePan)
const SNAP_V_NOTE = 3;      // per-tick sounding pitch (renderPitch; follows slides/arp/vibrato)
const SNAP_V_INST = 4;
const SNAP_V_SAMPLE_POS = 5;
const SNAP_V_SAMPLE_PTR = 6;
const SNAP_V_SAMPLE_LEN = 7;
const SNAP_V_ENV_VOL_IDX = 8;
const SNAP_V_ENV_VOL_TIME = 9;
const SNAP_V_ENV_PAN_IDX = 10;
const SNAP_V_ENV_PAN_TIME = 11;
const SNAP_V_ENV_PITCH_IDX = 12;
const SNAP_V_ENV_PITCH_TIME = 13;
const SNAP_V_ENV_FILTER_IDX = 14;
const SNAP_V_ENV_FILTER_TIME = 15;
const SNAP_V_AZIMUTH = 16;     // #998: 512-unit angle (0 left, 128 front, CLOCKWISE)
const SNAP_V_ELEVATION = 17;   // #998: signed, 128 units = 90° (always 0 in a stereo song)
// Funk repeat (item 161), for the Samples view's window overlay: where the
// voice's loop actually IS (-1 = the sample's own), where the walk will put it
// at the next restart (-1 = it has not stepped), and how wide the window is —
// the voice's ACTIVE loop length, which an Ixmp patch can change under it, so
// the overlay cannot get the width from the document and be right (item 116).
const SNAP_V_FUNK_WINDOW = 18;
const SNAP_V_FUNK_POS = 19;
const SNAP_V_FUNK_LEN = 20;
// …and which walk is hopping it (item 163's `$f`): the overlay names the
// command it is drawing, and the hop's SIZE is the loop length shifted right by
// the low two bits, so a half- or eighth-block walk is stepped through at the
// spacing it really uses instead of the loop length.
const SNAP_V_FUNK_MODE = 21;
// Extended `2`/`3 $sexy : $fuuk`'s own funk repeat (`$xuu` 102/12x, item 173
// follow-up): a SEPARATE window from Z's above — the two "do not share state"
// (TAUD_NOTE_EFFECTS.md) and can be live on one voice at once. Only the
// voice's own latched restart point needs a snapshot slot; the walk's
// pending target and window WIDTH are the instrument's (inst.modFunkPos/
// modFunkLen), already carried by the invert-mask query reply
// (engine.js getInstrumentSampleMod) the Samples view already polls.
const SNAP_V_MOD_FUNK_WINDOW = 22;
const SNAP_VOICE_STRIDE = 23;

// Every PHYSICAL voice, so the jam bank (item 140) is visible to the views that
// follow a sounding audition — the Instruments/Samples editors scan the block
// looking for the voice their preview landed on, and it no longer lands on a
// song channel.
const SNAP_MAX_VOICES = TOTAL_VOICES;

// ── Master-strip blocks (item 98), after the voice array ──
// Per metered channel: peak, true peak (4× oversampled), mean square over the
// interval, and the number of samples that hit full scale.
const SNAP_METER_BASE = SNAP_HEADER_SIZE + SNAP_MAX_VOICES * SNAP_VOICE_STRIDE;
const SNAP_M_PEAK = 0;
const SNAP_M_TRUE_PEAK = 1;
const SNAP_M_MEAN_SQUARE = 2;
const SNAP_M_CLIP = 3;
const SNAP_METER_STRIDE = 4;

// The vectorscope ring: SCOPE_FRAMES frames of first-order B-format, frame
// interleaved (W, Y, Z, X), written continuously and read backwards from
// SNAP_AN_RING_WRITE. See src/engine/analysis.js for why the scopes are always
// B-format whatever the metering target is.
const SNAP_SCOPE_BASE = SNAP_METER_BASE + ANALYSIS_MAX_METERS * SNAP_METER_STRIDE;

// ── Mastering meter blocks (item 178), after the scope ring ──
// Two stages — pre-chain then post-chain — each carrying the K-weighted energy
// the loudness figures are built from and, per channel, the same four numbers
// the strip's meters use. Measuring BOTH sides every chunk is what makes the
// view's pre/post toggle instant and its two readings describe one moment.
const SNAP_MM_BASE = SNAP_SCOPE_BASE + SCOPE_FRAMES * SCOPE_CHANNELS;
const SNAP_MM_SUM_Z = 0;        // Σ (K-weighted L² + K-weighted R²)
const SNAP_MM_CH = 1;           // …then 2 channels of:
const SNAP_MM_C_PEAK = 0;
const SNAP_MM_C_TRUE_PEAK = 1;
const SNAP_MM_C_MEAN_SQUARE = 2;
const SNAP_MM_C_CLIP = 3;
const SNAP_MM_C_STRIDE = 4;
const SNAP_MM_STAGE_STRIDE = SNAP_MM_CH + 2 * SNAP_MM_C_STRIDE;
const SNAP_MM_STAGES = 2;

// Delivered 8-bit code histogram (item 178.4's "bit usage"). Shipped NORMALISED
// — each bin is its share of SNAP_MM_HIST_TOTAL — because a raw count passes
// 2^24 after about six minutes on one bin and stops being exact in a float32.
const SNAP_HIST_BASE = SNAP_MM_BASE + SNAP_MM_STAGES * SNAP_MM_STAGE_STRIDE;
const SNAP_HIST_BINS = HIST_BUCKETS;

// Two mono rings — the mix going into the chain and the master coming out —
// for the Mastering view's live spectrometer. Written continuously and read
// backwards from SNAP_MM_SPEC_WRITE, exactly like the scope ring above. 16 KiB
// on the wire, and only while that view is on screen.
const SNAP_SPEC_BASE = SNAP_HIST_BASE + SNAP_HIST_BINS;
const SNAP_SPEC_FRAMES = SPEC_FRAMES;
const SNAP_SPEC_STAGES = TAP_STAGES;

const SNAP_FLOATS = SNAP_SPEC_BASE + SNAP_SPEC_STAGES * SNAP_SPEC_FRAMES;

// SAB fast path (crossOriginIsolated deploys): one shared buffer holding the
// float snapshot region plus a trailing Int32 block — cell 0 is the interrupt
// latch the worklet ORs into (Atomics.or) and the main thread drains
// (Atomics.exchange 0), cells 1..16 the argument each Int carried (item 181).
// The float SNAP_INTERRUPT_MASK / SNAP_INTERRUPT_ARGS slots are only used by
// the postMessage fallback.
const SNAP_SAB_I32_MASK = 0;
const SNAP_SAB_I32_ARGS = 1;
const SNAP_SAB_I32_CELLS = SNAP_SAB_I32_ARGS + NUM_INTERRUPTS;
const SNAP_SAB_BYTES = SNAP_FLOATS * 4 + SNAP_SAB_I32_CELLS * 4;

// ══ src/audio/audio-ring.js ══
// SharedArrayBuffer audio ring for Tier 2 (off-audio-thread rendering).
//
// A render Worker (producer) fills engine-rate float L/R frames; the AudioWorklet
// (consumer) reads them with a fractional resample cursor and copies to output.
// Single-producer / single-consumer, so the two absolute frame counters
// (AR_WRITE by the worker, AR_READ by the worklet) need only be published with
// Atomics.store / read with Atomics.load — no locks. AR_EPOCH is bumped by the
// worker on a transport reset (play / seek / stop) so the worklet drops the
// stale buffered tail instead of playing ~one ring of old audio.
//
// This module is imported by BOTH the module worker and the AudioWorklet, so it
// must stay bundle-safe (plain export forms, unique top-level names) — it goes
// into tools/make-worklet-bundle.js for the non-module-worklet fallback.

const AR_FRAMES = 8192;            // ring capacity in frames (power of two) — 171 ms @ 48 kHz
const AR_MASK = AR_FRAMES - 1;
const AR_CTRL_LEN = 6;             // Int32 control slots
const AR_WRITE = 0;                // absolute frames produced (worker → worklet), Int32-wrapping
const AR_READ = 1;                 // absolute frames consumed (worklet → worker), Int32-wrapping
const AR_STATE = 2;                // bit0: producer active (playing/jam) — informational
const AR_EPOCH = 3;                // transport-reset generation (worker bumps; worklet re-syncs)
const AR_FLUSH_POS = 4;            // write frame at the last flush — the worklet jumps its read cursor here,
                                          //   dropping the stale tail (counters stay monotonic; no reset race)
// Target ring occupancy the worker keeps buffered. 1024 frames ≈ 21 ms @ 48 kHz
// = the jam-latency / cursor-lead / underrun-safety knob (user-chosen balanced).
const AR_HIGH_WATER = 1024;
const AR_SAB_BYTES = AR_CTRL_LEN * 4 + AR_FRAMES * 4 * 2;

/** Map Int32 control + Float32 L/R views over an audio-ring SharedArrayBuffer. */
function audioRingViews(sab) {
  const ctrl = new Int32Array(sab, 0, AR_CTRL_LEN);
  const floatBase = AR_CTRL_LEN * 4;
  const L = new Float32Array(sab, floatBase, AR_FRAMES);
  const R = new Float32Array(sab, floatBase + AR_FRAMES * 4, AR_FRAMES);
  return { ctrl, L, R };
}

// ══ src/audio/resampler.js ══
// Kaiser-windowed-sinc resampling — the ONE interpolator every rate conversion
// in the app goes through:
//
//   * the AudioWorklet's engine→context read cursor (both the local render ring
//     and the Tier 2 SAB ring) — src/worklet/taud-processor.js
//   * the offline stereo WAV + mono stem exports — src/audio/offline-render.js
//   * the streaming multichannel export — src/audio/surround-export.js
//   * the sample Lab / import knife — src/doc/wavelab.js, which is ALSO the
//     float twin of the Python converters' taud_common.resample_bandlimited
//
// β=8 (~-70 dB stop-band), 512 phases, 8..24 half-taps, cutoff following the
// ratio so a DOWN-conversion anti-aliases on the way down, each phase row
// DC-normalised so a constant passes through unchanged. Those are the Python
// original's numbers, so the app and the converters shave a sample identically.
//
// Imported by the AudioWorklet, so this file must stay bundle-safe (plain
// export forms, unique top-level names) — it is in tools/make-worklet-bundle.js.

const RESAMP_BETA = 8.0;
const RESAMP_PHASES = 512; // power of two: the phase index is a mask away

function resampBesselI0(x) {
  let s = 1.0, t = 1.0, k = 1;
  for (;;) {
    t *= (x * x) / (4.0 * k * k);
    s += t;
    if (t < 1e-12 * s) return s;
    k++;
  }
}

const resampRowCache = new Map();
const resampKernelCache = new Map();

/**
 * Half-taps for a conversion by `ratio` (dst/src): 12 either side, widened as a
 * downsample narrows the transition band, capped at 24 so the cost stays bounded.
 */
function resampHalfWidth(ratio) {
  return Math.max(8, Math.min(24, Math.round(12.0 / Math.min(1.0, ratio))));
}

/**
 * Kernel rows of 2·halfWidth taps, row p being the kernel for fractional offset
 * p/phases. There are phases+1 of them: the last (frac = 1.0) is the endpoint
 * the read loops interpolate TOWARDS — see kaiserKernel. Cached, since the
 * tables are pure functions of their arguments and a handful of them cover
 * every rate pair the app ever sees.
 */
function kaiserSincRows(cutoff, halfWidth, phases = RESAMP_PHASES) {
  const key = `${Math.round(cutoff * 1e6)}:${halfWidth}:${phases}`;
  const cached = resampRowCache.get(key);
  if (cached) return cached;
  const nTaps = 2 * halfWidth;
  const invI0 = 1.0 / resampBesselI0(RESAMP_BETA);
  const rows = [];
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    const row = new Float64Array(nTaps);
    let s = 0.0;
    for (let k = 0; k < nTaps; k++) {
      const x = (k - (halfWidth - 1)) - frac;
      const a = 2.0 * cutoff * x;
      const sinc = a === 0.0 ? 1.0 : Math.sin(Math.PI * a) / (Math.PI * a);
      const r = x / halfWidth;
      const win = resampBesselI0(RESAMP_BETA * Math.sqrt(Math.max(0.0, 1.0 - r * r))) * invI0;
      row[k] = sinc * win;
      s += row[k];
    }
    const inv = s !== 0 ? 1.0 / s : 1.0;
    for (let k = 0; k < nTaps; k++) row[k] *= inv;
    rows.push(row);
  }
  resampRowCache.set(key, rows);
  return rows;
}

/**
 * Everything a read loop needs to convert srcRate → dstRate. The tap window for
 * output position `pos` is [⌊pos⌋−history, ⌊pos⌋+lead]: `lead` FUTURE frames
 * must already be buffered, which is why the streaming callers keep a look-ahead
 * the linear cursor never needed.
 *
 * `rows` is paired with `deltas` (row p+1 − row p) so a read loop can BLEND the
 * two rows bracketing the true phase: `w = rows[p][t] + deltas[p][t]·g`. Picking
 * the nearest row instead quantises the read position to 1/2·phases of a sample,
 * and that timing jitter is a ~−52 dB noise floor at 10 kHz — audible hiss riding
 * the music, and far worse than the −70 dB stop-band the window buys. One extra
 * multiply-add per tap buys it back.
 */
function kaiserKernel(srcRate, dstRate) {
  const cached = resampKernelCache.get(`${srcRate}:${dstRate}`);
  if (cached) return cached;
  const ratio = dstRate / srcRate;
  const halfWidth = resampHalfWidth(ratio);
  const nTaps = 2 * halfWidth;
  const rows = kaiserSincRows(0.5 * Math.min(1.0, ratio), halfWidth, RESAMP_PHASES);
  const deltas = [];
  for (let p = 0; p < RESAMP_PHASES; p++) {
    const d = new Float64Array(nTaps);
    for (let t = 0; t < nTaps; t++) d[t] = rows[p + 1][t] - rows[p][t];
    deltas.push(d);
  }
  const kernel = {
    rows,
    deltas,
    phases: RESAMP_PHASES,
    halfWidth,
    nTaps,
    history: halfWidth - 1,
    lead: halfWidth,
    step: srcRate / dstRate,
  };
  resampKernelCache.set(`${srcRate}:${dstRate}`, kernel);
  return kernel;
}

/**
 * Resample an interleaved Float32 buffer srcRate → dstRate in one go. Edge taps
 * clamp to the first/last frame (same as wavelab's whole-buffer resample).
 * Equal rates return the input untouched.
 */
function resampleInterleaved(f32, channels, srcRate, dstRate) {
  if (srcRate === dstRate) return f32;
  const srcFrames = f32.length / channels;
  const dstFrames = Math.floor((srcFrames * dstRate) / srcRate);
  const out = new Float32Array(dstFrames * channels);
  const { rows, deltas, phases, history, nTaps, step } = kaiserKernel(srcRate, dstRate);
  const acc = new Float64Array(channels);
  const last = srcFrames - 1;
  for (let n = 0; n < dstFrames; n++) {
    const pos = n * step;
    const i0 = Math.floor(pos);
    const fp = (pos - i0) * phases;
    const p = fp | 0;
    const g = fp - p;
    const row = rows[p], dRow = deltas[p];
    const base = i0 - history;
    acc.fill(0.0);
    for (let t = 0; t < nTaps; t++) {
      let idx = base + t;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      const o = idx * channels;
      const w = row[t] + dRow[t] * g;
      for (let c = 0; c < channels; c++) acc[c] += f32[o + c] * w;
    }
    const oo = n * channels;
    for (let c = 0; c < channels; c++) out[oo + c] = acc[c];
  }
  return out;
}

/**
 * Chunk-at-a-time resampler for the multichannel export, which encodes as it
 * renders. It carries the kernel's history AND its look-ahead across the block
 * boundary — a sinc needs `lead` frames that have not been rendered yet, so
 * output lags the input by that much and `flush()` drains the tail.
 */
class StreamResampler {
  constructor(channels, srcRate, dstRate) {
    this.channels = channels;
    this.step = srcRate / dstRate;
    this.k = srcRate === dstRate ? null : kaiserKernel(srcRate, dstRate);
    // Source position of the next output frame, relative to the current block's
    // first frame. Goes NEGATIVE (into the history) by up to the look-ahead.
    this.phase = 0.0;
    this.histFrames = this.k ? this.k.nTaps + 2 : 0;
    this.hist = new Float32Array(this.histFrames * channels);
    this.acc = new Float64Array(channels);
  }

  /** Upper bound on the output frames one `frames`-long block can produce. */
  maxOut(frames) { return Math.ceil(frames / this.step) + 2; }

  /** @returns the number of frames written into `out`. */
  process(input, frames, out) {
    const ch = this.channels;
    if (this.k === null) { // equal rates: a copy, not a filter
      out.set(input.subarray(0, frames * ch));
      return frames;
    }
    const { rows, deltas, phases, history, lead, nTaps } = this.k;
    const hist = this.hist, histFrames = this.histFrames, acc = this.acc;
    // The newest tap of output frame ⌊phase⌋ is ⌊phase⌋+lead, so stop as soon
    // as that would read past the end of this block.
    const limit = frames - 1 - lead;
    let phase = this.phase;
    let n = 0;
    while (Math.floor(phase) <= limit) {
      const i0 = Math.floor(phase);
      const fp = (phase - i0) * phases;
      const p = fp | 0;
      const g = fp - p;
      const row = rows[p], dRow = deltas[p];
      const base = i0 - history;
      acc.fill(0.0);
      for (let t = 0; t < nTaps; t++) {
        const idx = base + t;
        const w = row[t] + dRow[t] * g;
        if (idx >= 0) {
          const o = idx * ch;
          for (let c = 0; c < ch; c++) acc[c] += input[o + c] * w;
        } else {
          const o = Math.max(idx + histFrames, 0) * ch;
          for (let c = 0; c < ch; c++) acc[c] += hist[o + c] * w;
        }
      }
      const oo = n * ch;
      for (let c = 0; c < ch; c++) out[oo + c] = acc[c];
      n++;
      phase += this.step;
    }
    this.phase = phase - frames;
    // Carry the tail of this block as the next block's history (short blocks
    // push the older history along instead of replacing it).
    const carry = Math.min(histFrames, frames);
    if (carry < histFrames) hist.copyWithin(0, carry * ch);
    hist.set(input.subarray((frames - carry) * ch, frames * ch), (histFrames - carry) * ch);
    return n;
  }

  /** Emit the frames still held back by the look-ahead. Zero-padded: a render
   *  ends in silence, and a click at the very last sample is worse than a
   *  half-millisecond of decay. Call once, after the last process(). */
  flush(out) {
    if (this.k === null) return 0;
    const pad = this.k.lead + 1;
    return this.process(new Float32Array(pad * this.channels), pad, out);
  }
}

// ══ src/worklet/engine-commands.js ══
// Engine command dispatch + snapshot fill, shared by the AudioWorklet
// (render-mode fallback) and the Tier 2 render Worker. Both host a TaudEngine
// and speak the same audio.*-shaped CMD protocol, so this keeps the mutation
// path in one place (no drift between the two hosts). Bundle-safe (plain export
// forms, unique names) — included in tools/make-worklet-bundle.js.






/** Reused drain targets — the snapshot path never allocates. */
const analysisReadout = makeAnalysisReadout();
const masterMeterReadout = makeMasterMeterReadout();
/** …and the scratch [azimuth, elevation] the position readout writes into. */
const angleBox = new Float64Array(2);

/**
 * Apply an engine-mutating command to `eng`. Returns true if handled here.
 * Transport/reply commands (INIT, USE_SAB, USE_AUDIO_SAB, SNAPSHOT_RETURN,
 * QUERY_INVERT_MASK) return false — each host handles those itself.
 */
function applyAudioCommand(eng, m) {
  switch (m.t) {
    case CMD.UPLOAD_SAMPLE_INST_BLOB: eng.uploadSampleInstBlob(new Uint8Array(m.image)); return true;
    case CMD.UPLOAD_INSTRUMENT: eng.uploadInstrument(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_INSTRUMENT_PATCHES: eng.uploadInstrumentPatches(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.CLEAR_INSTRUMENT_PATCHES: eng.clearInstrumentPatches(m.slot); return true;
    case CMD.UPLOAD_PATTERN: eng.uploadPattern(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_PATTERNS: {
      const blob = new Uint8Array(m.blob);
      // Stride follows the file's cell layout, which SET_CELL_FORMAT installed
      // before the first pattern was ever sent.
      const size = eng.getCellFormat() ? PATTERN_BYTES_WIDE : PATTERN_BYTES;
      for (let i = 0; i < m.slots.length; i++) {
        eng.uploadPattern(m.slots[i], blob.subarray(i * size, (i + 1) * size));
      }
      return true;
    }
    case CMD.CLEAR_PATTERN: eng.clearPattern(m.slot); return true;
    case CMD.UPLOAD_CUE: eng.uploadCue(m.idx, new Uint8Array(m.bytes)); return true;
    case CMD.SET_64CH: eng.set64ChannelMode(m.on); return true;
    case CMD.SET_CELL_FORMAT: eng.setCellFormat(m.wide); return true;
    case CMD.SET_BPM: eng.setBPM(m.ph, m.bpm); return true;
    case CMD.SET_TUNING: eng.setTuning(m.ph, m.baseNote, m.freq); return true;
    case CMD.SET_TICK_RATE: eng.setTickRate(m.ph, m.rate); return true;
    case CMD.SET_SONG_GLOBAL_VOLUME: eng.setSongGlobalVolume(m.ph, m.volume); return true;
    case CMD.SET_SONG_MIXING_VOLUME: eng.setSongMixingVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_VOLUME: eng.setMasterVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_PAN: eng.setMasterPan(m.ph, m.pan); return true;
    case CMD.SET_TRACKER_MIXER_FLAGS: eng.setTrackerMixerFlags(m.ph, m.flags); return true;
    case CMD.SET_SURROUND_MODEL: eng.setSurroundModel(m.ph, m.model); return true;
    case CMD.SET_MONITOR_MODE: eng.setMonitorMode(m.ph, m.mode); return true;
    case CMD.SET_ANALYSIS: eng.setAnalysis(m.ph, m.target); return true;
    case CMD.SET_MASTERING: eng.setMastering(m.ph, m.params); return true;
    case CMD.SET_MASTER_METER:
      eng.setMasterMeter(m.ph, m.on, m.scramble, m.bitDepth); return true;
    case CMD.PLAY: eng.play(m.ph); return true;
    case CMD.STOP: eng.stop(m.ph); return true;
    case CMD.SET_CUE_POSITION: eng.setCuePosition(m.ph, m.pos); return true;
    case CMD.SET_TRACKER_ROW: eng.setTrackerRow(m.ph, m.row); return true;
    case CMD.RESET_PARAMS: eng.resetParams(m.ph); return true;
    case CMD.RESET_SAMPLE_FX_STATE: eng.resetSampleFxState(m.ph); return true;
    case CMD.JAM_NOTE: eng.jamNote(m.ph, m.voice, m.note, m.inst, m.audition); return true;
    case CMD.JAM_SAMPLE: eng.jamSample(m.ph, m.voice, m.note, m.spec); return true;
    case CMD.JAM_STOP: eng.jamStop(m.ph); return true;
    case CMD.JAM_STOP_VOICE: eng.jamStopVoice(m.ph, m.voice); return true;
    case CMD.SET_VOICE_MUTE: eng.setVoiceMute(m.ph, m.voice, m.muted); return true;
    case CMD.SET_VOICE_FADER: eng.setVoiceFader(m.ph, m.voice, m.fader); return true;
    default: return false;
  }
}

/** True for the transport commands that reset the play position (worker mode
 *  must flush the audio ring so no stale buffered tail plays after them). */
function isTransportReset(t) {
  return t === CMD.PLAY || t === CMD.STOP ||
    t === CMD.SET_CUE_POSITION || t === CMD.SET_TRACKER_ROW || t === CMD.RESET_PARAMS;
}

/** Detached copy of instrument `slot`'s S$Fx invert-loop bit mask (reply payload). */
function invertMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentInvertMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/** Detached copy of notefx 2/3's inversion mask for `slot` (item 130). */
function modMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentModMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/**
 * Drain the playhead's interrupt latch into whichever wire this host uses, and
 * with it the argument each Int carried (item 181).
 *
 * `i32` is the shared buffer's Int32 tail on a SAB deploy and null on the
 * postMessage fallback. The two differ in more than storage: the shared cells
 * ACCUMULATE (the main thread drains them on its own clock, so an OR is the
 * only way no fire is lost between two reads), while a posted snapshot is a
 * fresh message the main thread merges itself. Arguments are stored before the
 * mask bit that makes them readable, so a reader that sees the bit sees the
 * word that came with it.
 */
function drainInterruptsInto(eng, playhead, f, i32 = null) {
  const ts = eng.playheads[playhead].trackerState;
  const mask = ts.drainInterrupts();
  if (i32 !== null) {
    f[SNAP_INTERRUPT_MASK] = 0; // the float slot is the fallback's, not this path's
    if (mask === 0) return;
    for (let n = 0; n < 16; n++) {
      if (mask & (1 << n)) Atomics.store(i32, SNAP_SAB_I32_ARGS + n, ts.interruptArg(n));
    }
    Atomics.or(i32, SNAP_SAB_I32_MASK, mask);
    return;
  }
  f[SNAP_INTERRUPT_MASK] = mask;
  for (let n = 0; n < 16; n++) {
    if (mask & (1 << n)) f[SNAP_INTERRUPT_ARGS + n] = ts.interruptArg(n);
  }
}

/** Write every snapshot field except the interrupt latch into `f`. */
function fillSnapshotInto(eng, playhead, f) {
  const ph = eng.playheads[playhead];
  const ts = ph.trackerState;
  f[SNAP_CUE_POS] = ts.cuePos;
  f[SNAP_ROW_INDEX] = ts.rowIndex;
  f[SNAP_TICK_IN_ROW] = ts.tickInRow;
  f[SNAP_BPM] = ph.bpm;
  f[SNAP_TICK_RATE] = ph.tickRate;
  f[SNAP_FLAGS] = (ph.isPlaying ? 1 : 0) | (ph.jamActive ? 2 : 0);
  f[SNAP_CHANNEL_COUNT] = eng.channelCount();
  f[SNAP_GLOBAL_VOLUME] = ph.globalVolume;
  for (let vi = 0; vi < SNAP_MAX_VOICES; vi++) {
    const v = ts.voices[vi];
    const o = SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE;
    const active = v.active;
    f[o + SNAP_V_ACTIVE] = active ? 1 : 0;
    if (active) {
      const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
      const faderGain = (255 - v.fader) / 255.0;
      let ev = effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain;
      f[o + SNAP_V_EFF_VOL] = ev < 0 ? 0 : ev > 1 ? 1 : ev;
      // Where the channel SOUNDS — the same sum the mixer pans by (pan swing
      // included, item 155), and for a metainstrument the mix-weighted mean of
      // its layers rather than layer 0's own position (item 155.1).
      f[o + SNAP_V_EFF_PAN] = displayPanByte(ts, vi, v);
      // Spatial position (#998). EFF_PAN above stays the stereo meters' 0..255
      // value — in a surround song that is where the monitor downmix puts the
      // voice, which is what those meters are drawing.
      if (ts.surroundModel !== SURROUND_STEREO) {
        displayAngles(ts, vi, v, angleBox);
        f[o + SNAP_V_EFF_PAN] = Math.round(foldAzimuthToPan(angleBox[0]));
        f[o + SNAP_V_AZIMUTH] = angleBox[0];
        f[o + SNAP_V_ELEVATION] = angleBox[1];
      } else {
        f[o + SNAP_V_AZIMUTH] = f[o + SNAP_V_EFF_PAN];
        f[o + SNAP_V_ELEVATION] = 0;
      }
      f[o + SNAP_V_NOTE] = (v.renderPitch > 0 ? v.renderPitch : v.noteVal) & 0xffff;
      // Show the pattern-level instrument (a meta's slot), not the resolved
      // layer child; fall back to instrumentId before the first meta/plain trigger.
      f[o + SNAP_V_INST] = (v.displayInst || v.instrumentId) & 0x3ff;
      f[o + SNAP_V_SAMPLE_POS] = v.samplePos;
      f[o + SNAP_V_SAMPLE_PTR] = v.activeSamplePtr;
      f[o + SNAP_V_SAMPLE_LEN] = v.activeSampleLength;
      f[o + SNAP_V_ENV_VOL_IDX] = v.envIndex;
      f[o + SNAP_V_ENV_VOL_TIME] = v.envTimeSec;
      f[o + SNAP_V_ENV_PAN_IDX] = v.envPanIndex;
      f[o + SNAP_V_ENV_PAN_TIME] = v.envPanTimeSec;
      f[o + SNAP_V_ENV_PITCH_IDX] = v.envPitchIndex;
      f[o + SNAP_V_ENV_PITCH_TIME] = v.envPitchTimeSec;
      f[o + SNAP_V_ENV_FILTER_IDX] = v.envFilterIndex;
      f[o + SNAP_V_ENV_FILTER_TIME] = v.envFilterTimeSec;
      f[o + SNAP_V_FUNK_WINDOW] = v.funkWindow;
      f[o + SNAP_V_FUNK_POS] = v.funkPos;
      f[o + SNAP_V_FUNK_LEN] = v.activeSampleLoopEnd - v.activeSampleLoopStart;
      f[o + SNAP_V_FUNK_MODE] = v.funkMode;
      f[o + SNAP_V_MOD_FUNK_WINDOW] = v.modFunkWindow;
    } else {
      for (let k = 1; k < SNAP_VOICE_STRIDE; k++) f[o + k] = 0;
      f[o + SNAP_V_EFF_PAN] = 128;
      f[o + SNAP_V_AZIMUTH] = 128; // centre/front, matching EFF_PAN's rest value
      f[o + SNAP_V_SAMPLE_POS] = -1;
      f[o + SNAP_V_SAMPLE_PTR] = -1;
      f[o + SNAP_V_ENV_VOL_IDX] = -1;
      f[o + SNAP_V_ENV_PAN_IDX] = -1;
      f[o + SNAP_V_ENV_PITCH_IDX] = -1;
      f[o + SNAP_V_ENV_FILTER_IDX] = -1;
      f[o + SNAP_V_FUNK_WINDOW] = -1;
      f[o + SNAP_V_FUNK_POS] = -1;
      f[o + SNAP_V_MOD_FUNK_WINDOW] = -1;
    }
  }
  fillAnalysisInto(ts, f);
  fillMasterMeterInto(ts, f);
}

/**
 * Mastering-meter block (item 178). Drains the view's own tap — the K-weighted
 * energy, the per-channel peak/true-peak/mean-square/clip figures on BOTH sides
 * of the chain, the chain's gain reduction, and the delivered 8-bit code
 * histogram. With the tap off only the "no frames" marker is written.
 */
function fillMasterMeterInto(ts, f) {
  const tap = ts.masterMeter;
  if (tap === null) {
    f[SNAP_MM_FRAMES] = 0;
    f[SNAP_MM_COMP_GR] = 0;
    f[SNAP_MM_LIM_GR] = 0;
    f[SNAP_MM_HIST_TOTAL] = 0;
    f[SNAP_MM_SPEC_WRITE] = 0;
    f[SNAP_MM_HIST_DEPTH] = 0;
    f[SNAP_MM_HIST_USED] = 0;
    f[SNAP_MM_HIST_MIN] = 0;
    f[SNAP_MM_HIST_MAX] = 0;
    f[SNAP_MM_HIST_ENTROPY] = 0;
    return;
  }
  const r = tap.drain(masterMeterReadout);
  f[SNAP_MM_FRAMES] = r.frames;
  f[SNAP_MM_COMP_GR] = r.compGrDb;
  f[SNAP_MM_LIM_GR] = r.limGrDb;
  for (let s = 0; s < SNAP_MM_STAGES; s++) {
    const o = SNAP_MM_BASE + s * SNAP_MM_STAGE_STRIDE;
    f[o + SNAP_MM_SUM_Z] = r.sumZ[s];
    for (let c = 0; c < 2; c++) {
      const co = o + SNAP_MM_CH + c * SNAP_MM_C_STRIDE;
      const i = s * 2 + c;
      f[co + SNAP_MM_C_PEAK] = r.peak[i];
      f[co + SNAP_MM_C_TRUE_PEAK] = r.truePeak[i];
      f[co + SNAP_MM_C_MEAN_SQUARE] = r.meanSquare[i];
      f[co + SNAP_MM_C_CLIP] = r.clip[i];
    }
  }
  // Normalised buckets (see protocol.js): a raw count leaves float32's exact
  // integer range after a few minutes on one code. The FIGURES come from the
  // full-resolution census the tap kept, not from these.
  const bits = r.bits;
  const total = bits.total;
  f[SNAP_MM_HIST_TOTAL] = total;
  f[SNAP_MM_HIST_DEPTH] = r.bitDepth;
  f[SNAP_MM_HIST_USED] = bits.used;
  f[SNAP_MM_HIST_MIN] = bits.minCode;
  f[SNAP_MM_HIST_MAX] = bits.maxCode;
  f[SNAP_MM_HIST_ENTROPY] = bits.entropyBits;
  const inv = total > 0 ? 1 / total : 0;
  for (let i = 0; i < SNAP_HIST_BINS; i++) f[SNAP_HIST_BASE + i] = r.buckets[i] * inv;
  f[SNAP_MM_SPEC_WRITE] = r.specWrite;
  for (let s = 0; s < SNAP_MM_STAGES; s++) {
    f.set(r.spec[s], SNAP_SPEC_BASE + s * SNAP_SPEC_FRAMES);
  }
}

/**
 * Master-strip block (item 98). Drains the analysis tap — meters, correlation
 * sums, field energy and the B-format scope ring — into the snapshot. With the
 * tap off, only the "no meters" marker is written; the ring keeps whatever it
 * last held, which nothing reads.
 */
function fillAnalysisInto(ts, f) {
  const tap = ts.analysis;
  if (tap === null) {
    f[SNAP_AN_METERS] = 0;
    f[SNAP_AN_FRAMES] = 0;
    f[SNAP_AN_FIELD] = 0;
    f[SNAP_AN_CORR_LL] = 0;
    f[SNAP_AN_CORR_RR] = 0;
    f[SNAP_AN_CORR_LR] = 0;
    return;
  }
  const r = tap.drain(analysisReadout);
  f[SNAP_AN_METERS] = r.meterCount;
  f[SNAP_AN_FRAMES] = r.frames;
  f[SNAP_AN_FIELD] = r.fieldEnergy;
  f[SNAP_AN_CORR_LL] = r.corrLL;
  f[SNAP_AN_CORR_RR] = r.corrRR;
  f[SNAP_AN_CORR_LR] = r.corrLR;
  f[SNAP_AN_RING_WRITE] = r.ringWrite;
  for (let c = 0; c < ANALYSIS_MAX_METERS; c++) {
    const o = SNAP_METER_BASE + c * SNAP_METER_STRIDE;
    const live = c < r.meterCount;
    f[o + SNAP_M_PEAK] = live ? r.peak[c] : 0;
    f[o + SNAP_M_TRUE_PEAK] = live ? r.truePeak[c] : 0;
    f[o + SNAP_M_MEAN_SQUARE] = live ? r.meanSquare[c] : 0;
    f[o + SNAP_M_CLIP] = live ? r.clip[c] : 0;
  }
  f.set(tap.ring, SNAP_SCOPE_BASE);
}

// ══ src/worklet/taud-processor.js ══
// TaudProcessor — AudioWorkletProcessor with two modes:
//
//   RENDER mode (non-isolated fallback): hosts the TaudEngine and renders
//     engine-rate U8/float chunks into a local FIFO ring, reading them back
//     with a fractional resample cursor. This is the original single-thread path.
//
//   CONSUME mode (Tier 2, crossOriginIsolated): the engine lives in a separate
//     render Worker that fills a SharedArrayBuffer audio ring; process() only
//     resamples + copies from that ring, so it can never overrun. Entered on
//     CMD.USE_AUDIO_SAB; no engine commands are routed here in this mode.
//
// The engine renders at SAMPLING_RATE — 48 kHz since item 108, which is the
// rate audio-system.js asks the AudioContext for, so the common case reads the
// ring back one frame at a time with no interpolation at all (step === 1: a
// straight copy, not even a kernel). A context that insists on another rate
// (44.1 kHz hardware) is served by a fractional cursor reading through the
// Kaiser-windowed sinc in audio/resampler.js — the same kernel the exporters
// and the sample Lab use. That kernel needs `lead` frames AHEAD of the cursor,
// so both modes buffer that much extra look-ahead. Loaded via
// audioWorklet.addModule() as an ES module; the committed single-file concat
// (taud-processor.bundle.js) is the non-module-worklet fallback — regenerate
// with tools/make-worklet-bundle.js after any change here.







const RING_FRAMES = 4096; // power of two (render-mode local ring)

class TaudProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new TaudEngine();
    this.playhead = 0; // the browser player drives playhead 0

    this.chunk = new Uint8Array(TRACKER_CHUNK * 2);
    this.ringL = new Float32Array(RING_FRAMES);
    this.ringR = new Float32Array(RING_FRAMES);
    this.ringWrite = 0;      // absolute frame counter (wraps via mask)
    this.ringReadPos = 0.0;  // fractional absolute read cursor
    this.ringFloor = 0;      // oldest frame the kernel may read (flush barrier)
    this.step = SAMPLING_RATE / sampleRate; // 1.0 at a 48 kHz context
    // null at a matching context rate — then a frame is a frame and the read
    // loops copy. Otherwise the sinc kernel both read cursors run through.
    this.rs = this.step === 1.0 ? null : kaiserKernel(SAMPLING_RATE, sampleRate);

    // CONSUME mode (Tier 2): audio-ring SAB views + wrap-safe read cursor.
    this.audioRing = null;
    this.arEpoch = -1;       // forces a re-sync on the first callback
    this.arReadBase = 0;     // Int32-wrapping integer read frame
    this.arReadFrac = 0.0;   // 0..1 fractional accumulator
    this.arFloor = 0;        // ditto, on the SAB ring's wrapping counter

    const opts = options?.processorOptions ?? {};
    this.snapshotIntervalFrames =
      Math.max(1, Math.round(((opts.snapshotIntervalMs ?? 16) / 1000) * sampleRate));
    this.framesSinceSnapshot = 0;
    // Recycled snapshot buffers (transferred out, posted back via SNAPSHOT_RETURN).
    this.snapshotPool = [
      new ArrayBuffer(SNAP_FLOATS * 4),
      new ArrayBuffer(SNAP_FLOATS * 4),
    ];
    // SAB fast path (CMD.USE_SAB): write snapshots straight into shared memory.
    this.sabF32 = null;
    this.sabI32 = null;

    // ── dev profiler (opt-in via processorOptions.profile; zero cost when off) ──
    // Times the whole process() callback (the true xrun predictor) AND the
    // engine.renderChunk DSP alone. In CONSUME mode renderChunk is never called,
    // so renderCount≈0 — which is exactly the point: the audio thread stops
    // rendering. Reports rolling stats to the main thread ≈ once per second.
    this.profiling = !!opts.profile;
    // AudioWorkletGlobalScope does not reliably expose performance.now on older
    // iPad Safari — feature-detect and fall back to the 1 ms-resolution
    // Date.now, reporting which clock is live so the numbers stay interpretable.
    const hasPerf = (typeof performance !== "undefined" && typeof performance.now === "function");
    this.clockNow = hasPerf ? () => performance.now() : () => Date.now();
    this.hiResClock = hasPerf;
    this.clockResMs = hasPerf ? 0.005 : 1; // nominal resolution
    this.profileIntervalFrames = Math.max(1, Math.round(sampleRate)); // ≈ 1 s window
    this.pfReset();

    this.port.onmessage = (e) => this.onCommand(e.data);
    this.port.postMessage({ t: MSG.READY });
  }

  pfReset() {
    this.pfFrames = 0;
    this.pfProcBusy = 0; this.pfProcMax = 0; this.pfProcCount = 0; this.pfXruns = 0;
    this.pfRenderBusy = 0; this.pfRenderMax = 0; this.pfRenderCount = 0;
    this.pfPeakVoices = 0;
    this.pfUnderruns = 0; // CONSUME mode: callbacks starved while the producer was active
  }

  onCommand(m) {
    // Enter CONSUME mode: the worker owns the engine now; free ours (~8 MB).
    if (m.t === CMD.USE_AUDIO_SAB) {
      this.audioRing = audioRingViews(m.sab);
      this.engine = null;
      return;
    }
    if (this.audioRing) return; // consume mode: no engine commands routed here

    const eng = this.engine;
    if (applyAudioCommand(eng, m)) {
      // Transport reset (play/seek/stop): drop the local look-ahead ring's
      // buffered tail, or a block rendered against the OLD tracker state
      // leaks into the new playback (item 96) — render.worker.js's
      // flushRing/AR_EPOCH does the same job for the Tier 2 SAB path; this
      // mode never had the equivalent, since applyAudioCommand only touches
      // `eng`, not the processor's own ring pointers.
      if (isTransportReset(m.t)) this.flushRing();
      return;
    }
    switch (m.t) {
      case CMD.INIT:
        if (m.snapshotIntervalMs) {
          this.snapshotIntervalFrames =
            Math.max(1, Math.round((m.snapshotIntervalMs / 1000) * sampleRate));
        }
        break;
      case CMD.QUERY_INVERT_MASK: {
        const buf = invertMaskBuffer(eng, m.slot);
        const modBuf = modMaskBuffer(eng, m.slot);
        this.port.postMessage({
          t: MSG.INVERT_MASK, slot: m.slot, mask: buf,
          mod: eng.getInstrumentSampleMod(m.slot), modMask: modBuf,
        }, [buf, modBuf]);
        break;
      }
      case CMD.SNAPSHOT_RETURN:
        if (this.snapshotPool.length < 2) this.snapshotPool.push(m.buffer);
        break;
      case CMD.USE_SAB:
        this.sabF32 = new Float32Array(m.sab, 0, SNAP_FLOATS);
        this.sabI32 = new Int32Array(m.sab, SNAP_FLOATS * 4, SNAP_SAB_I32_CELLS);
        break;
    }
  }

  /** Discard whatever look-ahead audio is still queued (not yet read out) —
   *  it was rendered against the tracker state from BEFORE this transport
   *  reset. renderAndPlay re-fills from the current (already-reset) engine
   *  state starting exactly at the read cursor, so nothing is left to leak. */
  flushRing() {
    this.ringReadPos = this.ringWrite;
    // …and the sinc's history taps must not reach back across the cut either:
    // those frames are the discarded tail, and half a kernel of it would be
    // mixed into the first frames of the new playback.
    this.ringFloor = this.ringWrite;
  }

  renderIntoRing() {
    const t0 = this.profiling ? this.clockNow() : 0;
    const out = this.engine.renderChunk(this.playhead, this.chunk);
    if (this.profiling) {
      const dt = this.clockNow() - t0;
      this.pfRenderBusy += dt;
      if (dt > this.pfRenderMax) this.pfRenderMax = dt;
      this.pfRenderCount++;
      const ts0 = this.engine.playheads[this.playhead].trackerState;
      let nv = ts0.backgroundVoices.length;
      for (let i = 0; i < ts0.voices.length; i++) if (ts0.voices[i].active) nv++;
      if (nv > this.pfPeakVoices) this.pfPeakVoices = nv;
    }
    const mask = RING_FRAMES - 1;
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = 0;
        this.ringR[w] = 0;
      }
    } else {
      // Feed the pre-dither Float32 mix bus directly — clean output, no 8-bit
      // dithering. (renderChunk still fills the dithered U8 `out` so the engine
      // stays bit-exact for the JVM-oracle conformance tests; playback ignores it.)
      const ts = this.engine.playheads[this.playhead].trackerState;
      const mL = ts.mixLeft;
      const mR = ts.mixRight;
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = mL[n];
        this.ringR[w] = mR[n];
      }
    }
    this.ringWrite += TRACKER_CHUNK;
  }

  assembleSnapshot() {
    if (this.sabF32 !== null) {
      // Shared-memory path: fill in place; interrupts accumulate in the
      // trailing Int32 cell until the main thread drains it atomically.
      fillSnapshotInto(this.engine, this.playhead, this.sabF32);
      drainInterruptsInto(this.engine, this.playhead, this.sabF32, this.sabI32);
      return;
    }
    const buffer = this.snapshotPool.pop();
    if (!buffer) return; // main thread slow returning — skip, never allocate
    const f = new Float32Array(buffer);
    fillSnapshotInto(this.engine, this.playhead, f);
    drainInterruptsInto(this.engine, this.playhead, f);
    this.port.postMessage({ t: MSG.SNAPSHOT, buffer }, [buffer]);
  }

  // RENDER mode: keep the local ring one chunk ahead, then read it out resampled.
  renderAndPlay(outL, outR, frames) {
    const ph = this.engine.playheads[this.playhead];
    const mask = RING_FRAMES - 1;
    const rs = this.rs;
    if (ph.isPlaying || ph.jamActive || this.ringReadPos < this.ringWrite) {
      // The last output frame's newest tap sits `lead` frames past its cursor.
      const lead = (rs === null ? 0 : rs.lead) + 2;
      while (this.ringWrite < this.ringReadPos + frames * this.step + lead) {
        if (ph.isPlaying || ph.jamActive) {
          this.renderIntoRing();
        } else {
          const w = this.ringWrite & mask;
          this.ringL[w] = 0;
          this.ringR[w] = 0;
          this.ringWrite += 1;
        }
      }
      if (rs === null) {
        const i0 = this.ringReadPos;
        for (let n = 0; n < frames; n++) {
          const a = (i0 + n) & mask;
          outL[n] = this.ringL[a];
          outR[n] = this.ringR[a];
        }
        this.ringReadPos = i0 + frames;
      } else {
        const { rows, deltas, phases, history, nTaps } = rs;
        const floor = this.ringFloor;
        for (let n = 0; n < frames; n++) {
          const pos = this.ringReadPos;
          const i0 = Math.floor(pos);
          const fp = (pos - i0) * phases;
          const p = fp | 0;
          const g = fp - p;
          const row = rows[p], dRow = deltas[p];
          const base = i0 - history;
          let l = 0.0, r = 0.0;
          for (let t = 0; t < nTaps; t++) {
            const src = base + t;
            const a = (src < floor ? floor : src) & mask;
            const w = row[t] + dRow[t] * g;
            l += this.ringL[a] * w;
            r += this.ringR[a] * w;
          }
          outL[n] = l;
          outR[n] = r;
          this.ringReadPos = pos + this.step;
        }
      }
    } else {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
    }

    this.framesSinceSnapshot += frames;
    if (this.framesSinceSnapshot >= this.snapshotIntervalFrames) {
      this.framesSinceSnapshot = 0;
      this.assembleSnapshot();
    }
  }

  // CONSUME mode: read the worker's SAB ring resampled to the context rate.
  consumeFromRing(outL, outR, frames) {
    const { ctrl, L, R } = this.audioRing;
    // A transport reset (play/seek/stop) bumps the epoch and publishes a flush
    // mark — jump the read cursor there, dropping the stale buffered tail.
    const rs = this.rs;
    const epoch = Atomics.load(ctrl, AR_EPOCH) | 0;
    if (epoch !== this.arEpoch) {
      this.arEpoch = epoch;
      this.arReadBase = Atomics.load(ctrl, AR_FLUSH_POS) | 0;
      this.arReadFrac = 0;
      this.arFloor = this.arReadBase; // no history taps into the dropped tail
    }
    const write = Atomics.load(ctrl, AR_WRITE) | 0;
    const avail = (write - this.arReadBase) | 0;
    // …+ the frames the kernel's newest tap needs beyond the last read cursor.
    const need = Math.ceil(frames * this.step) + (rs === null ? 0 : rs.lead) + 2;
    if (avail < need) {
      // Silence, hold the cursor. If the PRODUCER is active (playing/jam) this
      // is a real dropout — the worker isn't refilling the ring in time; that is
      // the Tier 2 glitch signal the audio-thread xrun counter can no longer see.
      if (this.profiling && Atomics.load(ctrl, AR_STATE)) this.pfUnderruns++;
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      Atomics.store(ctrl, AR_READ, this.arReadBase);
      return;
    }
    let base = this.arReadBase, frac = this.arReadFrac;
    const step = this.step;
    if (rs === null) {
      for (let n = 0; n < frames; n++) {
        const a = base & AR_MASK;
        outL[n] = L[a];
        outR[n] = R[a];
        base = (base + 1) | 0;
      }
    } else {
      const { rows, deltas, phases, history, nTaps } = rs;
      const floor = this.arFloor;
      for (let n = 0; n < frames; n++) {
        const fp = frac * phases;
        const p = fp | 0;
        const g = fp - p;
        const row = rows[p], dRow = deltas[p];
        const first = (base - history) | 0;
        let l = 0.0, r = 0.0;
        for (let t = 0; t < nTaps; t++) {
          // Counters are Int32-wrapping, so "older than the floor" is a signed
          // DIFFERENCE, never a plain <.
          const src = (first + t) | 0;
          const a = (((src - floor) | 0) < 0 ? floor : src) & AR_MASK;
          const w = row[t] + dRow[t] * g;
          l += L[a] * w;
          r += R[a] * w;
        }
        outL[n] = l;
        outR[n] = r;
        frac += step;
        while (frac >= 1) { frac -= 1; base = (base + 1) | 0; }
      }
    }
    this.arReadBase = base;
    this.arReadFrac = frac;
    Atomics.store(ctrl, AR_READ, base);
  }

  emitProfile(quantumMs) {
    const audioMs = this.pfFrames / sampleRate * 1000;
    this.port.postMessage({
      t: MSG.PROFILE,
      cpuFrac: audioMs > 0 ? this.pfProcBusy / audioMs : 0,
      renderFrac: audioMs > 0 ? this.pfRenderBusy / audioMs : 0,
      procMeanMs: this.pfProcCount ? this.pfProcBusy / this.pfProcCount : 0,
      procMaxMs: this.pfProcMax,
      renderMeanMs: this.pfRenderCount ? this.pfRenderBusy / this.pfRenderCount : 0,
      renderMaxMs: this.pfRenderMax,
      quantumMs,
      xruns: this.pfXruns,
      underruns: this.pfUnderruns,
      procCount: this.pfProcCount,
      renderCount: this.pfRenderCount,
      peakVoices: this.pfPeakVoices,
      windowMs: audioMs,
      sampleRate,
      step: this.step,
      sab: this.sabF32 !== null || this.audioRing !== null,
      workerRender: this.audioRing !== null,
      hiResClock: this.hiResClock,
      clockResMs: this.clockResMs,
    });
    this.pfReset();
  }

  process(_inputs, outputs) {
    const t0 = this.profiling ? this.clockNow() : 0;
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : outputs[0][0];
    const frames = outL.length;

    if (this.audioRing) {
      this.consumeFromRing(outL, outR, frames);
    } else {
      this.renderAndPlay(outL, outR, frames);
    }

    if (this.profiling) {
      // Measure the whole callback — the work the audio thread must finish
      // within one quantum. The report post itself is excluded (dt before emit).
      const dt = this.clockNow() - t0;
      this.pfProcBusy += dt;
      if (dt > this.pfProcMax) this.pfProcMax = dt;
      this.pfProcCount++;
      const quantumMs = frames / sampleRate * 1000;
      if (dt > quantumMs) this.pfXruns++;
      this.pfFrames += frames;
      if (this.pfFrames >= this.profileIntervalFrames) this.emitProfile(quantumMs);
    }
    return true;
  }
}

registerProcessor("taud-processor", TaudProcessor);
