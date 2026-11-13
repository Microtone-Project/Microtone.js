// PSG instruments — Metainstrument type 9. Two oscillators in place of a sample.
//
// A type-9 instrument is an ORDINARY instrument record — envelopes, fadeout,
// New Note Action, Duplicate Check, default volume and pan, auto-vibrato, the
// one pitch/filter envelope it keeps — whose sample is replaced by a pair of
// programmable-sound-generator oscillators, A and B, mixed by adding them or
// by multiplying them (TAUD_FILE_FORMAT.md §7.9).
//
// Each oscillator is a 0-to-1-volt generator playing a waveform (DC, seven
// pulse widths, saw, triangle, three 1-bit noises with fixed repetition
// cycles, a 4-bit saw and triangle, and silence), its envelope the OPL chip's
// own. The pair, the chip clock it shares with OPL voices and the S $Axxx
// overlay are the engine's (core/engine/c/src/psg.c; engine spec §5.5.4).
// What is here is the patch block as a file holds it and the page edits and
// draws it: layout, codec, the waveforms as the waveform window plots them
// and the auto-advance patterns the picker names.

import { OPL_SUSTAIN_LEVEL } from "./opl.js";

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

const PSG_TWO32 = 4294967296;

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

// ── The voice ─────────────────────────────────────────────────────────────

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

