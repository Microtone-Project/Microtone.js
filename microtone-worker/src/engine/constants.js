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
export let SAMPLING_RATE = 48000;
// Batch length of the mixer's per-sample loop. Tick/row timing is per-SAMPLE
// (mixer.js `samplesIntoTick`), so this is pure batching granularity and does
// NOT affect output — verified bit-exact vs the 512 baseline on the whole
// deterministic corpus. DELIBERATE web divergence from Kotlin's 512: the
// AudioWorklet must finish each render inside one ~2.67 ms quantum, and a 512-
// frame (16 ms) block renders in one burst that overruns the callback on slower
// devices (iPad: 5–14 ms/block → xruns); 128 spreads it evenly under budget.
export const TRACKER_CHUNK = 128;

// Per-voice soundscope ring-buffer length. Power of two so wrap-around is a single AND.
export const SCOPE_BUFFER_SIZE = 2048;

// Mixer-private background-voice pool size per playhead. NNA "Continue/Note Off/Note Fade"
// ghosts displaced foreground voices into this pool; oldest is evicted on overflow.
export const MAX_BG_VOICES = 64;

export const MIDDLE_C = 0x5000; // reference C for instrument samplingRate (terranmon.txt:2000)

// Amiga period at MIDDLE_C for a standard 8363 Hz instrument (NTSC clock 3579545 Hz).
export const AMIGA_BASE_PERIOD = 428.0;

// Reference frequency for linear-freq tone mode (toneMode == 2): 12-TET A4 = 440 Hz.
export const LINEAR_FREQ_C4_HZ = 261.6255653005986;

// ── Song tuning (terranmon.txt:3297-3324, §"Note Tuning"; web item 77) ──
// The song table declares "note TUNING base note sounds at TUNING freq Hz";
// tuningRatioOf() (tables.js) folds that pair into the playback-rate multiplier.
//
// Zero point: 12-TET concert C4, i.e. the same A4 = 440 the linear-freq mode
// references — numerically LINEAR_FREQ_C4_HZ, kept as its own name because it
// answers a different question (that one is the toneMode==2 slide reference,
// this one is where "no retune" sits).
export const TUNING_REF_C4_HZ = LINEAR_FREQ_C4_HZ;

// Field defaults for a zero/blank song table — spec: "If zero, assume the
// tracker default value". C9 @ 8363 Hz is the Amiga/tracker convention, which
// is NOT concert pitch: it puts A4 at 439.53 Hz, ~1.87 cents flat of 440. The
// spec quotes 439.548 Hz for the reference tuning from the exact NTSC clock
// ratio (3579545/428 = 8363.42 Hz); the format stores the rounded 8363.0, so
// the honest reading of a default song table lands 0.09 cents below that quote.
export const TUNING_DEFAULT_BASE_NOTE = 0xa000; // C9
export const TUNING_DEFAULT_FREQ_HZ = 8363.0;

// Anti-click ramp-out on sample end/cut: 8 ms (256 samples at Kotlin's 32 kHz).
export let RAMP_OUT_SAMPLES = 384;
const RAMP_OUT_SEC = 0.008;

// Fast note-fade (note word 0x0004): SF2 exclusiveClass choke, ≈ FluidSynth's
// GEN_VOLENVRELEASE = -2000 timecents.
export const FAST_FADE_SEC = 0.3;

// Volume-change anti-click ramp: 2 ms (64 samples at Kotlin's 32 kHz).
// Bypassed on fresh note triggers.
export let VOL_RAMP_SAMPLES = 96;
const VOL_RAMP_SEC = 0.002;

// Volume ramp for Attack (item 139): every fresh note trigger fades IN over this
// many samples on a half-cosine curve, 0 -> unity, instead of stepping straight to
// full gain. 32 samples at 48 kHz (~0.67 ms) is the reference figure the constant
// is named for; ATTACK_RAMP_SEC carries it to other rates the same way RAMP_OUT_SEC
// and VOL_RAMP_SEC do.
export let ATTACK_RAMP_SAMPLES = 32;
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
export const PITCH_GLIDE_FULL_RATIO = 0.014545334937523746;

// Modules whose load-time tables are rate-derived (tables.js's Amiga filter
// coefficients) register here so setSamplingRate can rebuild them. Coefficients
// computed per call — the IT/SF2 voice filters — need no registration.
const rateListeners = new Set();

/** Register a rebuild callback; it fires on every later setSamplingRate. */
export function onSamplingRateChange(fn) {
  rateListeners.add(fn);
  return fn;
}

/**
 * Move the engine's output rate. Call BEFORE constructing an engine: voices
 * already carrying ramp counters or filter state keep the old rate's numbers.
 * Rebuilds every rate-derived table, so the Amiga low-pass stays at 4421 Hz
 * and the anti-click ramps stay at 8 ms / 2 ms whatever the rate.
 */
export function setSamplingRate(rate) {
  SAMPLING_RATE = rate;
  RAMP_OUT_SAMPLES = Math.round(RAMP_OUT_SEC * rate);
  VOL_RAMP_SAMPLES = Math.round(VOL_RAMP_SEC * rate);
  ATTACK_RAMP_SAMPLES = Math.round(ATTACK_RAMP_SEC * rate);
  for (const fn of rateListeners) fn(rate);
}

// Sample bin: 8 MB total (banking is a device-protocol concern; the JS engine
// addresses the pool directly, as the Kotlin playback path does).
export const SAMPLE_BANK_SIZE = 524288;
export const SAMPLE_BANK_COUNT = 16;
export const SAMPLE_BIN_TOTAL = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT;

// Channels / voices. Physical voice & cue storage is always sized MAX_VOICES;
// 32-channel playback leaves the upper half inactive.
export const NUM_VOICES = 32;
export const MAX_VOICES = 64;

// Dedicated audition ("jam") voices, above every addressable song channel.
// JS-only — the Kotlin device jams on a song channel, which is exactly what
// item 140 is about: an audition on a channel is silenced by that channel's
// mute, it hijacks whatever the song is playing there, and one channel can only
// hold one note, so a held chord collapses to its last key. These slots belong
// to no channel, so the desk never mutes them and the song never writes to
// them; the row loop stops at channelCount() while the tick and mix loops walk
// the whole array, so they play but are never played TO.
export const JAM_VOICES = 16;
export const JAM_VOICE_BASE = MAX_VOICES;
export const TOTAL_VOICES = MAX_VOICES + JAM_VOICES;
export const NUM_CUES = 8192;
export const CUE_BYTES = NUM_VOICES * 2;    // 64 bytes / cue (32-ch)
export const CUE_BYTES_64 = MAX_VOICES * 2; // 128 bytes / cue (64-ch)

// Pattern store: 15-bit pattern numbers; 0x7FFF = "no pattern on this channel".
export const NUM_PATTERNS = 0x7fff;
export const PATTERN_EMPTY = 0x7fff;

// ── Cell layouts (file format version) ──
// Versions 1-2 carry an 8-byte pattern cell; version 3 — the surround format —
// carries 16, which is what buys the 8-bit volume column, the spherical panning
// column and a second effect. It is a whole-FILE property, so the engine holds
// one flag and every pattern in it is the same width.
export const ROWS_PER_PATTERN = 64;
export const CELL_BYTES = 8;
export const CELL_BYTES_WIDE = 16;
export const PATTERN_BYTES = ROWS_PER_PATTERN * CELL_BYTES;          // 512
export const PATTERN_BYTES_WIDE = ROWS_PER_PATTERN * CELL_BYTES_WIDE; // 1024

/** Volume ceiling per cell format: 6-bit columns, or v3's 8-bit ones. */
export const VOLUME_MAX = 0x3f;
export const VOLUME_MAX_WIDE = 0xff;
/** What a 6-bit-derived delta (a nibble slide, a tremolo depth) is worth. */
export const VOLUME_STEP_WIDE = 4;

// Interpolation modes (TAUD_NOTE_EFFECTS.md §1, bits 2-4 of global behaviour flags).
export const INTERP_DEFAULT = 0;
export const INTERP_NONE = 1;
export const INTERP_A500 = 2;
export const INTERP_A1200 = 3;
export const INTERP_SNES = 4;
export const INTERP_NES_DPCM = 5;

// Fast Sinc kernel geometry (table itself is generated in tables.js).
export const SINC_WIDTH = 3;
export const SINC_PRECISION_SHIFT = 10;
export const SINC_PRECISION = 1 << SINC_PRECISION_SHIFT; // 1024

// Note-word sentinels (terranmon.txt:3040-3049).
export const NOTE_NOP = 0x0000;
export const NOTE_KEY_OFF = 0x0001;
export const NOTE_CUT = 0x0002;
export const NOTE_FADE = 0x0003;
export const NOTE_FAST_FADE = 0x0004;
export const NOTE_INT_FIRST = 0x0010; // Int0..IntF interrupt notes
export const NOTE_INT_LAST = 0x001f;
export const NUM_INTERRUPTS = 16;
