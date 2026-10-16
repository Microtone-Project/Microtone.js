// PSG instrument editing — the patch of a type-9 instrument as fields, and the
// record bytes that carry them (TAUD_FILE_FORMAT §7.9).
//
// As with OPL (opledit.js), a type-9 record is an ordinary instrument record:
// everything but the patch is edited the ordinary way, and the patch lives in
// bytes 197…250, edited as bytes through setInstBytesOp, which TaudInst.setByte
// decodes in place so a sounding voice hears the edit at once.
//
// An oscillator's envelope fields are named as the OPL tab names an
// operator's — AR DR SL RR TL KSL MULT, and the Sustain / Key scale rate
// switches — because they ARE the chip's, number for number.

import {
  PSG_BLOCK_START, PSG_B_FLAGS, PSG_B_OSC, PSG_OSC_BYTES,
  PSG_MIX_MULTIPLY, PSG_MUTE_A, PSG_MUTE_B,
  PSG_OF_KSR, PSG_OF_SUSTAIN, PSG_OF_RESET, PSG_OF_INVERT,
  PSG_OF_TREMOLO_SHIFT, PSG_OF_VIBRATO_SHIFT,
  PSG_WAVE_PULSE_LAST, PSG_NOISE_CYCLES, PSG_NOISE_STEPS_PER_CYCLE,
  encodePsgPatch, psgWaveValue, psgIsNoise,
} from "../../core/engine/psg.js";
import { buildPsgRecord } from "../../core/engine/inst.js";

export { PSG_WAVE_PULSE_LAST, PSG_NOISE_CYCLES, psgIsNoise };

/** Where each oscillator field lives in its six bytes: [byte, shift, mask]. */
const FIELD_BITS = {
  wave: [0, 4, 15], ar: [0, 0, 15],
  dr: [1, 4, 15], sl: [1, 0, 15],
  rr: [2, 4, 15], mult: [2, 0, 15],
  ksl: [3, 6, 3], tl: [3, 0, 63],
  vibrato: [4, PSG_OF_VIBRATO_SHIFT, 3], tremolo: [4, PSG_OF_TREMOLO_SHIFT, 3],
  invert: [4, 3, 1], reset: [4, 2, 1], eg: [4, 1, 1], ksr: [4, 0, 1],
  advance: [5, 0, 255],
};

/** The envelope fields, in the order the OPL tab shows an operator's. */
export const PSG_ENV_FIELDS = [
  { key: "ar", max: 15 }, { key: "dr", max: 15 }, { key: "sl", max: 15 }, { key: "rr", max: 15 },
  { key: "tl", max: 63 }, { key: "ksl", max: 3 }, { key: "mult", max: 15 },
  { key: "eg", max: 1 }, { key: "ksr", max: 1 },
];

/** The record's mix / mute switches. */
export const PSG_SWITCHES = { multiply: PSG_MIX_MULTIPLY, muteA: PSG_MUTE_A, muteB: PSG_MUTE_B };

const rawOf = (inst) => inst.psgRaw;

/** Oscillator `i`'s fields as plain numbers — the sustain level as its 4-bit
 *  field, which the decoded patch has already turned into envelope steps. */
export function psgOscillator(inst, i) {
  const raw = rawOf(inst);
  const o = PSG_B_OSC + i * PSG_OSC_BYTES;
  const out = {};
  for (const [key, [b, shift, mask]] of Object.entries(FIELD_BITS)) {
    out[key] = (raw[o + b] >> shift) & mask;
  }
  return out;
}

/** The patch as the editor reads it. */
export function psgFields(inst) {
  const f = rawOf(inst)[PSG_B_FLAGS];
  return {
    multiply: (f & PSG_MIX_MULTIPLY) !== 0,
    muteA: (f & PSG_MUTE_A) !== 0,
    muteB: (f & PSG_MUTE_B) !== 0,
    osc: [psgOscillator(inst, 0), psgOscillator(inst, 1)],
  };
}

/** [[recordOffset, byte]] pairs that set oscillator `i`'s `key` to `value`. */
export function psgOscBytes(inst, i, key, value) {
  const [b, shift, mask] = FIELD_BITS[key];
  const at = PSG_B_OSC + i * PSG_OSC_BYTES + b;
  const old = rawOf(inst)[at];
  const v = (old & ~(mask << shift)) | ((value & mask) << shift);
  return [[PSG_BLOCK_START + at, v & 0xff]];
}

/** …one of the record's switches (mix model, the two mutes). */
export function psgSwitchBytes(inst, name, on) {
  const bit = PSG_SWITCHES[name];
  const old = rawOf(inst)[PSG_B_FLAGS];
  return [[PSG_BLOCK_START + PSG_B_FLAGS, on ? old | bit : old & ~bit]];
}

/**
 * What a new PSG instrument starts as: a 50% square on oscillator A, held
 * while the key is, oscillator B a triangle an octave down muted beside it —
 * so the pair is one switch away from a fatter sound, and the mute rule is
 * the first thing anyone sees.
 */
export function defaultPsgRecord() {
  const held = { ar: 15, dr: 2, sl: 2, rr: 7, mult: 1, tl: 8, eg: 1 };
  return buildPsgRecord(encodePsgPatch({
    muteB: true,
    osc: [{ ...held, wave: 4 }, { ...held, wave: 9, mult: 0 }],
  }));
}

/** What the list badge says a PSG instrument is: ×, when it multiplies. */
export function psgBadge(inst) {
  return inst.psg.multiply ? "PSG·×" : "PSG";
}

/**
 * Samples of one waveform for the preview window, `n` points over `cycles`
 * cycles, on ±1 — the engine's own psgWaveValue, so the window draws what
 * plays. A noise is drawn as its first bits at its own clock (sixteen a cycle).
 */
export function psgWavePoints(wave, invert, n = 128, cycles = 2) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * cycles;
    const phase = Math.floor((x - Math.floor(x)) * 4294967296);
    const v = psgWaveValue(wave, phase, Math.floor(x * PSG_NOISE_STEPS_PER_CYCLE));
    out[i] = invert ? -v : v;
  }
  return out;
}
