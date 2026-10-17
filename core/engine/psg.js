// PSG instruments — Metainstrument type 9. Two oscillators in place of a sample.
//
// A type-9 instrument is an ORDINARY instrument record — envelopes, fadeout,
// New Note Action, Duplicate Check, default volume and pan, auto-vibrato, the
// one pitch/filter envelope it keeps — whose sample is replaced by a pair of
// programmable-sound-generator oscillators, A and B, mixed by adding them or
// by multiplying them (TAUD_FILE_FORMAT.md §7.9). This module is that pair,
// one per sounding voice.
//
// Each oscillator is a 0-to-1-volt generator playing a waveform (DC, seven
// pulse widths, saw, triangle, three 1-bit noises with fixed repetition
// cycles, a 4-bit saw and triangle, and silence). The pair is added or
// multiplied in volts, and the volts are then mapped onto the lane's whole
// range, 0 V to −1 and 1 V to +1; each oscillator's envelope scales what the
// mapping makes of it, so a silenced oscillator sits at 0, not at −1. That
// envelope is the OPL chip's own, number for number: the same attack / decay / sustain / release rates, sustain levels, total
// level, key-scale rate and level, multiplier, and the same tremolo and
// vibrato. So the PSG shares the OPL instrument's clock arrangement (opl.js):
// every voice runs at the chip's 49716 Hz on its playhead's chip clock
// (`ts.oplFrame`), is read back by linear interpolation, and steps its
// envelopes on the same samples an OPL voice beside it does. A PSG voice is
// deliberately not band-limited; its edges alias the way a chip's do.
//
// What is NOT the chip's is the oscillator's "internal status" — its phase,
// the noise generator's position, the waveform auto-advance and the origin
// its tremolo and vibrato run from. A PSG channel keeps all of it across the
// notes a lane plays, as a real PSG keeps counting between key-ons; an
// oscillator whose X flag is set starts it afresh at every trigger instead.
//
// The record bytes are the patch; `S $Axxx` writes a handful of them at run
// time (auto-advance, level, mute — TAUD_NOTE_EFFECTS.md) into a per-
// instrument overlay that lasts until the next playback, as invert loop's
// mask does. Nothing here touches the record.
//
// Everything is integer or IEEE-double computation; the noise tables are
// generated at load from integer shift registers, and the only transcendental
// is the OPL tables' `2 ** rational`.

import { SAMPLING_RATE, LINEAR_FREQ_C4_HZ } from "./constants.js";
import {
  OPL_RATE, OPL_C4_RATE, OPL_MULTIPLE_X2, OPL_SUSTAIN_LEVEL, OPL_ENV_MAX,
  OPL_TREMOLO_TABLE, OPL_VIBRATO_TABLE, OPL_TREMOLO_PERIOD, OPL_VIBRATO_PERIOD,
  EG_OFF, EG_ATTACK, EG_RELEASE,
  oplExpand, oplAdvanceEnvelope, oplKeyScaling, oplChipIndex, oplChipFrac,
} from "./opl.js";

/** A PSG instrument plays at its C2SPD exactly as an OPL one does: 0 reads as
 *  the tracker convention, 8363, at which note $5000 sounds concert C4. */
export const PSG_C4_RATE = OPL_C4_RATE;
const PSG_HZ_PER_SPS = LINEAR_FREQ_C4_HZ / OPL_C4_RATE;

// ── The record ────────────────────────────────────────────────────────────
// The patch occupies the second pitch/filter envelope slot, bytes 197…250,
// as OPL's does (§7.9). Offsets below are relative to PSG_BLOCK_START.

export const PSG_BLOCK_START = 197;
export const PSG_BLOCK_LEN = 54;
/** `0b 0000 XY0m`: m the mix model, Y mute B, X mute A. */
export const PSG_B_FLAGS = 0;
/** RESERVED. */
export const PSG_B_RESERVED = 1;
/** Oscillator A's twelve bytes (record 199…210), then oscillator B's
 *  (211…222); 223…250 are RESERVED. */
export const PSG_B_OSC = 2;
export const PSG_OSC_BYTES = 12;
/** Within an oscillator's twelve (+7…+11 RESERVED). */
export const PSG_O_WAVE_AR = 0;   // 0b wwww aaaa
export const PSG_O_DR_SL = 1;     // 0b dddd ssss
export const PSG_O_RR_MULT = 2;   // 0b rrrr mmmm
export const PSG_O_KSL_TL = 3;    // 0b KK LLLLLL
export const PSG_O_FLAGS = 4;     // 0b VVTT IXsR
export const PSG_O_ADVANCE = 5;   // auto-advance period, QUARTER ticks (0 = off, 4 = a tick)
export const PSG_O_PATTERN = 6;   // 0b 0000 00pp: which auto-advance pattern

export const PSG_MIX_MULTIPLY = 0x01;
export const PSG_MUTE_B = 0x04;
export const PSG_MUTE_A = 0x08;

export const PSG_OF_KSR = 0x01;
export const PSG_OF_SUSTAIN = 0x02;
export const PSG_OF_RESET = 0x04;
export const PSG_OF_INVERT = 0x08;
export const PSG_OF_TREMOLO_SHIFT = 4;
export const PSG_OF_VIBRATO_SHIFT = 6;

// ── Waveforms ─────────────────────────────────────────────────────────────

export const PSG_WAVE_DC = 0x0;
/** 1…7: pulses, high for (8 − n) eighths of the cycle and low for n. */
export const PSG_WAVE_PULSE_LAST = 0x7;
export const PSG_WAVE_SAW = 0x8;
export const PSG_WAVE_TRIANGLE = 0x9;
export const PSG_WAVE_NOISE_LONG = 0xa;
export const PSG_WAVE_NOISE_MID = 0xb;
export const PSG_WAVE_NOISE_SHORT = 0xc;
export const PSG_WAVE_SAW4 = 0xd;
export const PSG_WAVE_TRIANGLE4 = 0xe;
export const PSG_WAVE_SILENCE = 0xf;

/** The exact repetition cycle of each noise, in noise steps. */
export const PSG_NOISE_CYCLES = Object.freeze({ 0xa: 32767, 0xb: 2047, 0xc: 127 });
/** Noise steps per oscillator cycle: a noise is clocked at sixteen times the
 *  note, as the SID's is, so it moves with the pitch it is played at. */
export const PSG_NOISE_STEPS_PER_CYCLE = 16;

/**
 * One period of a Fibonacci shift register's output, `taps` its feedback bits
 * from a seed of 1. A maximal register of n bits repeats every 2ⁿ − 1 steps,
 * so all three cycles are authentic registers: 15 bits (x¹⁵ + x¹⁴ + 1) and 7
 * bits (x⁷ + x⁶ + 1), the two a Famicom's noise channel runs in, and 11 bits
 * (x¹¹ + x⁹ + 1) between them.
 */
function psgLfsrTable(bits, tapA, tapB, len) {
  const t = new Uint8Array(len);
  let r = 1;
  for (let i = 0; i < len; i++) {
    t[i] = r & 1;
    const fb = ((r >>> tapA) ^ (r >>> tapB)) & 1;
    r = (r >>> 1) | (fb << (bits - 1));
  }
  return t;
}
const PSG_NOISE_TABLE_SET = Object.freeze({
  0xa: psgLfsrTable(15, 0, 1, 32767),
  0xb: psgLfsrTable(11, 0, 2, 2047),
  0xc: psgLfsrTable(7, 0, 1, 127),
});
export const PSG_NOISE_TABLES = PSG_NOISE_TABLE_SET;

const PSG_TWO32 = 4294967296;
const PSG_TWO28 = 268435456;
/** The noise counter wraps at a common multiple of the three cycles (32767 =
 *  7·31·151, 2047 = 23·89 and 127 are pairwise coprime), so every noise stays
 *  exact across the wrap. ≈ 8.5 × 10⁹: an integer a double holds exactly. */
const PSG_NOISE_WRAP = 32767 * 2047 * 127;

/**
 * Waveform `w` at 32-bit phase `p`, on 0…1, before the invert flag — the
 * noises excepted, whose value is the table bit at `noisePos` and which ignore
 * the phase. An oscillator is a 0-to-1-volt generator, as a PSG's DAC is: DC is
 * 1, silence is 0, and inverting one gives the other. Shared with the editor's
 * waveform preview (psgedit.js), so what the window draws is what plays.
 */
export function psgWaveValue(w, p, noisePos = 0) {
  switch (w) {
    case PSG_WAVE_DC: return 1;
    case 1: case 2: case 3: case 4: case 5: case 6: case 7:
      return (p >>> 29) < 8 - w ? 1 : 0;
    case PSG_WAVE_SAW: return 1 - p / PSG_TWO32;
    case PSG_WAVE_TRIANGLE: {
      const x = p / PSG_TWO32;
      return x < 0.5 ? 2 * x : 2 - 2 * x;
    }
    case PSG_WAVE_NOISE_LONG: case PSG_WAVE_NOISE_MID: case PSG_WAVE_NOISE_SHORT: {
      const t = PSG_NOISE_TABLE_SET[w];
      return t[noisePos % t.length];
    }
    case PSG_WAVE_SAW4: return (15 - (p >>> 28)) / 15;
    case PSG_WAVE_TRIANGLE4: {
      const s = p >>> 27;                        // 32 steps a cycle
      return (s < 16 ? s : 31 - s) / 15;
    }
    default: return 0;
  }
}

/** Whether `w` is one of the noises. */
export function psgIsNoise(w) {
  return w >= PSG_WAVE_NOISE_LONG && w <= PSG_WAVE_NOISE_SHORT;
}

// ── The patch ─────────────────────────────────────────────────────────────

/** One oscillator's twelve bytes, unpacked. `sl` is in envelope steps, as an
 *  OplOperator's is, so the chip's envelope generator reads it unchanged. */
export class PsgOscillator {
  constructor() {
    this.wave = 0;
    this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0;
    this.mult = 0; this.ksl = 0; this.tl = 0;
    this.ksr = 0; this.eg = 0; this.reset = false; this.invert = false;
    this.tremolo = 0;   // 0 off, 1 = 1 dB, 2 = 4.8 dB (3 RESERVED, read as off)
    this.vibrato = 0;   // 0 off, 1 = 7 cents, 2 = 14 cents (3 RESERVED, read as off)
    this.advance = 0;   // auto-advance period in quarter ticks, 0 = off
    this.pattern = 0;   // auto-advance pattern, 0…3 (PSG_ADVANCE_PATTERNS)
  }
}

/**
 * A decoded type-9 patch, decoded IN PLACE by decodePsgPatch so a sounding
 * voice hears an edit at once, as an OPL patch does. `gen` counts decodes.
 *
 * The run-time overlay `S $Axxx` writes lives here too, beside the decode but
 * never touched by it: `rtAdvance` / `rtLevel` per oscillator and `rtMute`,
 * each −1 while the record's own value stands. It is per INSTRUMENT, lasts
 * across notes, and is cleared on a new playback (psgClearRuntime), exactly
 * as invert loop's mask is.
 */
export class PsgPatch {
  constructor() {
    this.gen = 0;
    this.multiply = false;
    this.muteA = false;
    this.muteB = false;
    this.osc = [new PsgOscillator(), new PsgOscillator()];
    this.rtAdvance = Int16Array.from([-1, -1]);
    this.rtLevel = Int16Array.from([-1, -1]);
    this.rtMute = -1;
    /** Counts overlay writes, so a memo of what the patch sounds like (a
     *  formant instrument's measurement of its source) knows it is stale. */
    this.rtGen = 0;
  }
}

/** Unpack the 54-byte block (`bytes[at…]`) into `into`. */
export function decodePsgPatch(bytes, at = 0, into = new PsgPatch()) {
  const f = bytes[at + PSG_B_FLAGS] & 0xff;
  into.multiply = (f & PSG_MIX_MULTIPLY) !== 0;
  into.muteA = (f & PSG_MUTE_A) !== 0;
  into.muteB = (f & PSG_MUTE_B) !== 0;
  for (let i = 0; i < 2; i++) {
    const o = at + PSG_B_OSC + i * PSG_OSC_BYTES;
    const osc = into.osc[i];
    const b0 = bytes[o] & 0xff, b1 = bytes[o + 1] & 0xff, b2 = bytes[o + 2] & 0xff;
    const b3 = bytes[o + 3] & 0xff, b4 = bytes[o + 4] & 0xff;
    osc.wave = b0 >> 4; osc.ar = b0 & 15;
    osc.dr = b1 >> 4; osc.sl = OPL_SUSTAIN_LEVEL[b1 & 15];
    osc.rr = b2 >> 4; osc.mult = b2 & 15;
    osc.ksl = b3 >> 6; osc.tl = b3 & 63;
    osc.ksr = b4 & PSG_OF_KSR ? 1 : 0;
    osc.eg = b4 & PSG_OF_SUSTAIN ? 1 : 0;
    osc.reset = (b4 & PSG_OF_RESET) !== 0;
    osc.invert = (b4 & PSG_OF_INVERT) !== 0;
    const tt = (b4 >> PSG_OF_TREMOLO_SHIFT) & 3;
    const vv = (b4 >> PSG_OF_VIBRATO_SHIFT) & 3;
    osc.tremolo = tt === 3 ? 0 : tt;
    osc.vibrato = vv === 3 ? 0 : vv;
    osc.advance = bytes[o + PSG_O_ADVANCE] & 0xff;
    osc.pattern = bytes[o + PSG_O_PATTERN] & 3;
  }
  into.gen++;
  return into;
}

/**
 * Pack a patch description into the 54-byte block — decodePsgPatch's inverse.
 * `osc` are field-shaped {wave, ar, dr, sl (the 4-bit FIELD), rr, mult, ksl,
 * tl, ksr, eg, reset, invert, tremolo, vibrato, advance, pattern}; missing ones zero.
 */
export function encodePsgPatch({ multiply = false, muteA = false, muteB = false, osc = [] } = {}) {
  const b = new Uint8Array(PSG_BLOCK_LEN);
  b[PSG_B_FLAGS] = (multiply ? PSG_MIX_MULTIPLY : 0) | (muteA ? PSG_MUTE_A : 0) |
    (muteB ? PSG_MUTE_B : 0);
  for (let i = 0; i < 2; i++) {
    const s = osc[i];
    if (!s) continue;
    const o = PSG_B_OSC + i * PSG_OSC_BYTES;
    b[o] = (((s.wave ?? 0) & 15) << 4) | ((s.ar ?? 0) & 15);
    b[o + 1] = (((s.dr ?? 0) & 15) << 4) | ((s.sl ?? 0) & 15);
    b[o + 2] = (((s.rr ?? 0) & 15) << 4) | ((s.mult ?? 0) & 15);
    b[o + 3] = (((s.ksl ?? 0) & 3) << 6) | ((s.tl ?? 0) & 63);
    b[o + 4] = (s.ksr ? PSG_OF_KSR : 0) | (s.eg ? PSG_OF_SUSTAIN : 0) |
      (s.reset ? PSG_OF_RESET : 0) | (s.invert ? PSG_OF_INVERT : 0) |
      (((s.tremolo ?? 0) & 3) << PSG_OF_TREMOLO_SHIFT) |
      (((s.vibrato ?? 0) & 3) << PSG_OF_VIBRATO_SHIFT);
    b[o + PSG_O_ADVANCE] = (s.advance ?? 0) & 0xff;
    b[o + PSG_O_PATTERN] = (s.pattern ?? 0) & 3;
  }
  return b;
}

// ── The run-time overlay (S $Axxx) ────────────────────────────────────────

/** Drop every run-time write: the patch sounds as its record says again. */
export function psgClearRuntime(patch) {
  if (patch.rtAdvance[0] === -1 && patch.rtAdvance[1] === -1 &&
      patch.rtLevel[0] === -1 && patch.rtLevel[1] === -1 && patch.rtMute === -1) return;
  patch.rtAdvance.fill(-1);
  patch.rtLevel.fill(-1);
  patch.rtMute = -1;
  patch.rtGen++;
}

/**
 * `S $Axxx` on a voice sounding this patch, `reg` the argument's low twelve
 * bits. $000…$0FF and $800…$8FF set oscillator A's or B's auto-advance;
 * $100…$13F and $900…$93F its level; $F00…$F03 the two mutes outright (bit 0
 * A, bit 1 B). Anything else is RESERVED and does nothing. Returns whether
 * the write was one.
 */
export function psgWriteRegister(patch, reg) {
  const r = reg & 0xfff;
  const i = (r & 0x800) !== 0 ? 1 : 0;
  const hi = (r >>> 8) & 0x7;
  if (r >= 0xf00) {
    if (r > 0xf03) return false;
    patch.rtMute = r & 3;
  } else if (hi === 0) {
    patch.rtAdvance[i] = r & 0xff;
  } else if (hi === 1 && (r & 0xff) <= 0x3f) {
    patch.rtLevel[i] = r & 0x3f;
  } else {
    return false;
  }
  patch.rtGen++;
  return true;
}

/** Oscillator `i`'s level (TL, 0…63) as it sounds now: the overlay's or the record's. */
export function psgLevel(patch, i) {
  const v = patch.rtLevel[i];
  return v >= 0 ? v : patch.osc[i].tl;
}
/** …its auto-advance period. */
export function psgAdvance(patch, i) {
  const v = patch.rtAdvance[i];
  return v >= 0 ? v : patch.osc[i].advance;
}
/** …whether it is muted. */
export function psgMuted(patch, i) {
  if (patch.rtMute >= 0) return ((patch.rtMute >> i) & 1) !== 0;
  return i === 0 ? patch.muteA : patch.muteB;
}

// ── The voice ─────────────────────────────────────────────────────────────

/**
 * One sounding PSG channel — two oscillators — hung off a Voice as
 * `voice.psg`. The field names that oplAdvanceEnvelope reads (`state`, `env`,
 * `ksrOffset`) are the OPL channel's, so the chip's envelope generator runs
 * on this unchanged.
 */
export class PsgState {
  constructor() {
    this.patch = null;
    this.gen = -1;
    this.rate = -1;
    this.state = new Uint8Array(2);
    this.env = new Int32Array(2).fill(OPL_ENV_MAX);
    this.ksrOffset = new Int32Array(2);
    this.gain = new Float64Array(2);        // this chip sample's gain, 0…4084 (psgOscStep)
    this.kslAtt = new Int32Array(2);
    this.inc = new Float64Array(2);
    // The internal status (see the head of this file): kept across key-ons
    // unless the oscillator's X flag says otherwise.
    this.phase = new Float64Array(2);       // 0 ≤ phase < 2³², integral
    this.noise = new Float64Array(2);       // noise steps taken, mod PSG_NOISE_WRAP
    this.adv = new Uint8Array(2);           // auto-advance position in its pattern
    this.advCount = new Int32Array(2);      // quarter ticks toward the next advance
    this.lfo = new Float64Array(2);         // chip sample the LFOs run from
    this.keyed = false;
    this.k = -1;
    this.cur = 0;
    this.last = 0;
    /** Phase modulation from an FM rack, a 32-bit phase offset (fm.js). */
    this.pm = 0;
  }
}

/** A copy for an NNA ghost: the whole channel, mid-note. */
export function clonePsgState(src) {
  const s = new PsgState();
  s.patch = src.patch;
  s.gen = src.gen; s.rate = src.rate;
  s.state.set(src.state); s.env.set(src.env);
  s.ksrOffset.set(src.ksrOffset); s.gain.set(src.gain); s.kslAtt.set(src.kslAtt); s.inc.set(src.inc);
  s.phase.set(src.phase); s.noise.set(src.noise);
  s.adv.set(src.adv); s.advCount.set(src.advCount); s.lfo.set(src.lfo);
  s.keyed = src.keyed;
  s.k = src.k; s.cur = src.cur; s.last = src.last;
  return s;
}

/**
 * Key the channel on. `carry` keeps the envelopes where they stand (a
 * retrigger its New Note Action cuts, as OPL's); without it both start from
 * silence and the channel joins the chip clock at the first frame it renders.
 * The internal status is kept, oscillator by oscillator, unless that
 * oscillator's X flag resets it here.
 */
export function psgKeyOn(st, patch, carry) {
  st.patch = patch;
  st.gen = -1;
  st.rate = -1;
  if (!carry) {
    st.env.fill(OPL_ENV_MAX);
    st.cur = 0;
    st.last = 0;
    st.k = NaN;
  }
  for (let i = 0; i < 2; i++) {
    st.state[i] = EG_ATTACK;
    if (patch.osc[i].reset) {
      st.phase[i] = 0;
      st.noise[i] = 0;
      st.adv[i] = 0;
      st.advCount[i] = 0;
      st.lfo[i] = NaN;                     // anchored at the first frame rendered
    }
  }
  st.keyed = true;
}

/** Key off: both oscillators go to their release. */
export function psgKeyOff(st) {
  for (let i = 0; i < 2; i++) if (st.state[i] !== EG_OFF) st.state[i] = EG_RELEASE;
  st.keyed = false;
}

/** Re-attack both oscillators from where they stand — an instrument byte on a
 *  tone-portamento row, or Q's retrigger (spec §5.5.4). */
export function psgReattack(st) {
  for (let i = 0; i < 2; i++) st.state[i] = EG_ATTACK;
  st.keyed = true;
}

/**
 * The auto-advance's four patterns (byte +6), as OFFSETS from the record's
 * waveform among the seven pulses: 1 is the waveform itself and 7 is six
 * pulses on, wrapping from $7 to $1 — DC is no pulse width and is never
 * walked to — so a record waveform of 4 walks 4 5 6 7 1 2 3 2 1 7 6 5 under
 * pattern 0. Each pattern starts at its first entry and repeats.
 */
export const PSG_ADVANCE_PATTERNS = Object.freeze([
  Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2]),
  Uint8Array.from([1, 3, 5, 7, 5, 3]),
  Uint8Array.from([1, 4, 7, 4]),
  Uint8Array.from([1, 4]),
]);

/** Whether waveform `w` is one the auto-advance walks: a pulse, 1…7. DC and
 *  everything past the pulses hold. */
export function psgAdvances(w) {
  return w >= 1 && w <= PSG_WAVE_PULSE_LAST;
}

/** The pulse a pattern's offset `k` plays from record pulse `w`: 1 is `w`,
 *  counting on among the seven pulses and wrapping from 7 to 1. The editor's
 *  pattern labels go through this too, so they name what plays. */
export function psgPatternWave(w, k) {
  return ((w - 1 + k - 1) % 7) + 1;
}

/** The waveform oscillator `i` is playing now: its record's, moved along its
 *  pattern by the auto-advance when the record's is a pulse. */
export function psgCurrentWave(st, i) {
  const osc = st.patch.osc[i];
  const w = osc.wave;
  if (!psgAdvances(w)) return w;
  const pat = PSG_ADVANCE_PATTERNS[osc.pattern];
  return psgPatternWave(w, pat[st.adv[i] % pat.length]);
}

/**
 * One QUARTER tick of the auto-advance: an oscillator whose record waveform is
 * a pulse, 1…7, counts one, and every `N` quarters (byte +5, 4 = once a tick) takes the
 * next step of its pattern. N is the overlay's when `S $Axxx` has written one,
 * else the record's; 0 holds. The tick pass runs the first quarter of every
 * tick and the mixer the other three at their own frames (tick.js
 * psgQuarterPass, mixer.js).
 */
export function psgQuarterTick(st) {
  const patch = st.patch;
  if (patch === null) return;
  for (let i = 0; i < 2; i++) {
    const n = psgAdvance(patch, i);
    if (n === 0 || !psgAdvances(patch.osc[i].wave)) { st.advCount[i] = 0; continue; }
    if (++st.advCount[i] >= n) {
      st.advCount[i] = 0;
      st.adv[i] = (st.adv[i] + 1) % PSG_ADVANCE_PATTERNS[patch.osc[i].pattern].length;
    }
  }
}

/** The quarter of its tick a playhead is in, `into` frames into a tick of
 *  `spt` frames: 0…3. */
export function psgQuarterAt(into, spt) {
  const q = Math.floor((into * 4) / spt);
  return q < 0 ? 0 : q > 3 ? 3 : q;
}

const psgScaleBox = new Int32Array(2);

/** Recompute the frequency-derived values for the voice's current pitch. */
function psgRetune(st, rate) {
  const patch = st.patch;
  const hz = rate * SAMPLING_RATE * PSG_HZ_PER_SPS;
  for (let i = 0; i < 2; i++) {
    const osc = patch.osc[i];
    oplKeyScaling(hz, osc.ksr, osc.ksl, psgScaleBox);
    st.ksrOffset[i] = psgScaleBox[0];
    st.kslAtt[i] = psgScaleBox[1];
    const inc = Math.round((hz * OPL_MULTIPLE_X2[osc.mult] * PSG_TWO32) / (2 * OPL_RATE));
    st.inc[i] = inc < 0 ? 0 : inc >= PSG_TWO32 ? PSG_TWO32 - 1 : inc;
  }
  st.rate = rate;
  st.gen = patch.gen;
}

const PSG_ENV_TO_LOG = 8;
const PSG_TL_TO_LOG = 32;
/** Oscillator output to the engine's scale: a full-level oscillator swings the
 *  lane's whole ±1, the height of a full-scale OPL operator. */
const PSG_OUTPUT_SCALE = 1 / 4096;

/**
 * Oscillator `i` for one chip sample at chip clock `k`, advancing it. Returns
 * its waveform in VOLTS, 0…1 with the invert applied, and leaves its gain —
 * envelope, level, key scaling, tremolo, 0…4084 — in `st.gain[i]`. The two
 * stay apart because the pair is mixed in volts and only then mapped onto the
 * lane, where the gain acts (psgChipStep).
 */
function psgOscStep(st, i, k) {
  const patch = st.patch;
  const osc = patch.osc[i];
  oplAdvanceEnvelope(st, i, osc, k);
  if (Number.isNaN(st.lfo[i])) st.lfo[i] = k;
  const lk = k - st.lfo[i];
  let inc = st.inc[i];
  if (osc.vibrato !== 0) {
    const vib = OPL_VIBRATO_TABLE[osc.vibrato - 1][lk % OPL_VIBRATO_PERIOD];
    if (vib !== 1) inc = Math.round(inc * vib);
  }
  // The noise is clocked by the phase: one step each 1/16 of a cycle crossed.
  const old = st.phase[i];
  const next = old + inc;
  const steps = Math.floor(next / PSG_TWO28) - Math.floor(old / PSG_TWO28);
  if (steps !== 0) st.noise[i] = (st.noise[i] + steps) % PSG_NOISE_WRAP;
  st.phase[i] = next >= PSG_TWO32 ? next - PSG_TWO32 * Math.floor(next / PSG_TWO32) : next;
  if (st.state[i] === EG_OFF) { st.gain[i] = 0; return 0; }
  let att = (st.env[i] + st.kslAtt[i]) * PSG_ENV_TO_LOG + psgLevel(patch, i) * PSG_TL_TO_LOG;
  if (osc.tremolo !== 0) att += OPL_TREMOLO_TABLE[osc.tremolo - 1][lk % OPL_TREMOLO_PERIOD];
  st.gain[i] = oplExpand(att);
  const w = psgCurrentWave(st, i);
  const p = (st.phase[i] + st.pm) % PSG_TWO32;
  const v = psgWaveValue(w, p, st.noise[i]);
  return osc.invert ? 1 - v : v;             // 0…1 turned over: DC ↔ silence
}

/**
 * The pair's next chip sample at chip clock `k`. Both oscillators always run,
 * muted or not, so a mute lifted mid-note brings the oscillator back where it
 * would have been; the mixer then adds or multiplies what is not muted, and
 * with one of the two muted it passes the other through untouched (§7.9).
 */
export function psgChipStep(st, k) {
  const a = psgOscStep(st, 0, k);
  const b = psgOscStep(st, 1, k);
  const ga = st.gain[0], gb = st.gain[1];
  const patch = st.patch;
  const ma = psgMuted(patch, 0), mb = psgMuted(patch, 1);
  // Volts to the lane: 0 V is −1, 1 V is +1, and the gain scales the result,
  // so an oscillator the envelope has silenced sits at 0, not at −1.
  if (ma) return mb ? 0 : (2 * b - 1) * gb;
  if (mb) return (2 * a - 1) * ga;
  // Multiplied in volts, then mapped: 0 V on either side is −1, DC (1 V) on
  // one side leaves the other as it is, and the two gains multiply.
  return patch.multiply
    ? (2 * a * b - 1) * ((ga * gb) / 4084)
    : (2 * a - 1) * ga + (2 * b - 1) * gb;
}

/** Whether oscillator `i` can still make a sound (opl.js oplChannelAlive's rule). */
function psgOscAlive(st, i) {
  const s = st.state[i];
  if (s === EG_OFF) return false;
  return !(st.env[i] >= OPL_ENV_MAX && (s !== EG_ATTACK || st.patch.osc[i].ar === 0));
}

/** Whether the channel can still make a sound: either oscillator can. */
export function psgChannelAlive(st) {
  if (st.patch === null) return false;
  return psgOscAlive(st, 0) || psgOscAlive(st, 1);
}

/**
 * The channel `st` at output frame `frame`, played at playback rate `rate`,
 * keyed off once `keyOff` is, on the lane's ±1: the oscillators' 0…1 volts
 * mapped onto it, scaled by their envelopes. The note volume is
 * NOT applied: the mixer applies it to the pair's output, as to a sample's, so
 * the multiplying mix does not square it.
 */
export function psgRender(st, frame, rate, keyOff) {
  const patch = st.patch;
  if (patch === null) return 0;
  if (keyOff && st.keyed) psgKeyOff(st);
  if (rate !== st.rate || patch.gen !== st.gen) psgRetune(st, rate);
  const k = oplChipIndex(frame);
  const frac = oplChipFrac();
  if (Number.isNaN(st.k) || k - st.k > 8) st.k = k - 1;
  while (st.k < k) {
    st.k++;
    st.last = st.cur;
    st.cur = psgChipStep(st, st.k);
  }
  return (st.last + (st.cur - st.last) * frac) * PSG_OUTPUT_SCALE;
}

/** renderPsgVoice: psgRender for the voice it sounds on, which it ends once
 *  nothing can sound. */
export function renderPsgVoice(voice, frame) {
  const st = voice.psg;
  if (st.patch === null) return 0;
  const s = psgRender(st, frame, voice.currentPlaybackRate, voice.keyOff);
  if (!psgChannelAlive(st)) voice.active = false;
  return s;
}
