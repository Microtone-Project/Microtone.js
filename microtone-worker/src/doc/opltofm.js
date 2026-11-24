// OPL instrument → Easy Mode FM rack (item 356): the same patch written as
// sample operators, so it can be taken further than the chip goes.
//
// Every number here is read off the chip model the engine runs (engine spec
// §5.5.2, core/engine/c/src/opl.c), at middle C:
//
//   waveform   each operator's OPL waveform, drawn as one cycle of the same
//              shape (core/engine/opl.js's table, evaluated rather than read
//              from the log tables: a 256-frame cycle cannot tell them apart)
//   ratio      MULT_X2[mult] ÷ 2 — ×½, ×1, ×2 … ×15 — as the operator's detune
//   level      the total level, 0.75 dB a step, and the key-scale level the
//              chip applies at middle C. A carrier's level is its loudness: a
//              full-scale operator is one full-scale sample (the chip's
//              c ÷ 4096). A modulator's is a modulation INDEX: the chip adds
//              its output to the carrier's 10-bit phase, so full scale (4084)
//              is 4084 ÷ 1024 cycles; a rack measures phase in cycles too
//              (§5.5.1), so a modulator's gain is that many times its level.
//   feedback   operator 1's own output, (out + prev) ÷ 2 ÷ 2^(8 − FB) phase
//              units: 2^(FB − 8) × 4084 ÷ 1024 cycles per full-scale output,
//              written as the depth of a feedback loop on operator 1
//   envelope   the chip's envelope generator run sample for sample at its own
//              49716 Hz from the key-on — attack, decay to the sustain level,
//              then (an operator without EG-TYP) on down at the release rate —
//              and read back as volume-envelope points every 6 dB down to
//              −42 dB; a sustaining operator holds at the sustain level until
//              the key is let go, and the release follows
//   vibrato    the VIB bit as the operator's auto-vibrato: 7 or 14 cents at
//              the chip's 6.07 Hz (at 125 BPM, the auto-vibrato's tick rate)
//
// What a sample operator has no word for is reported, not guessed: the
// tremolo (AM), the key-scale level and rate ACROSS the keyboard (they are
// taken at middle C only), and the three rhythm voices the chip builds out of
// noise (snare drum, top cymbal, hi-hat), which are refused.
//
// Pure: a decoded patch and the instrument's rate in, a rack spec out.
// bankmerge.js planOplFm writes it.

import {
  OPL_RATE, OPL_C4_RATE, OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_TOM,
  OPL_KIND_SD, OPL_KIND_TC, OPL_KIND_HH, OPL_KIND_OPERATORS,
} from "../../core/engine/opl.js";
import { LINEAR_FREQ_C4_HZ } from "../../core/engine/constants.js";
import { minifloatFromDouble, minifloatToDouble } from "../../core/engine/minifloat.js";

const MULT_X2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
const KSL_ROM = [0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54, 55, 56];
const DUTY = ["10101010", "10101011", "10111011", "10111111"].map((s) => [...s].map(Number));

/** A full-scale operator's output (EXPAND at attenuation 0). */
const OPL_FULL = 4084;
/** The kinds a rack can be made of; the noise drums cannot. */
export const OPL_FM_KINDS = Object.freeze([OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_TOM]);

/** Frames in one cycle of an operator's waveform (fmeasy's sine). */
export const OPL_WAVE_FRAMES = 256;

/** OPL waveform `ws` at 10-bit phase `p`, −1…1. */
export function oplWaveValue(ws, p) {
  p &= 1023;
  const h = (p & 512) !== 0;
  const sin = (q) => Math.sin((2 * Math.PI * (q & 1023)) / 1024);
  switch (ws & 7) {
    case 0: return sin(p);
    case 1: return h ? 0 : sin(p);
    case 2: return Math.abs(sin(p));
    case 3: return p & 256 ? 0 : Math.abs(sin(p & 255));
    case 4: return h ? 0 : sin((p << 1) & 1023);
    case 5: return h ? 0 : Math.abs(sin((p << 1) & 511));
    case 6: return h ? -1 : 1;
    default: { // 7: the logarithmic saw, 96 dB across each half
      const x = h ? 511 - (p & 511) : p & 511;
      const v = 2 ** (-(x << 3) / 256);
      return h ? -v : v;
    }
  }
}

/** One cycle of waveform `ws` as the pool stores it (U8 about 127.5). */
export function oplWavePcm(ws, frames = OPL_WAVE_FRAMES) {
  const out = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) {
    const p = Math.floor((i * 1024) / frames);
    out[i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * oplWaveValue(ws, p))));
  }
  return out;
}

/** The chip's block and F-number for `hz` (engine spec §5.5.2). */
export function oplBlockFnum(hz, lowFnum = false) {
  const x = (hz * 1048576) / OPL_RATE;
  const ceiling = lowFnum ? 686 : 1024;
  for (let b = 0; b <= 7; b++) {
    const f = Math.round(x / 2 ** b);
    if (f < ceiling) return { block: b, fnum: f };
  }
  return { block: 7, fnum: 1023 };
}

/** The key-scale level at block/F-number, in envelope units (0.1875 dB). */
function kslAtt(ksl, block, fnum) {
  if (ksl === 0) return 0;
  const base = Math.max(0, KSL_ROM[(fnum >> 6) & 15] - 8 * (7 - block));
  return (base * 4) >> (ksl === 1 ? 1 : ksl === 2 ? 2 : 0);
}

const ENV_OFF = 0, ENV_ATTACK = 1, ENV_DECAY = 2, ENV_SUSTAIN = 3, ENV_RELEASE = 4;

/** How long the chip may be run for one curve: past this a phase is "never". */
const ENV_LIMIT_SAMPLES = Math.round(OPL_RATE * 60);

/**
 * Run an operator's envelope from a key-on (env 511) with the key held, and,
 * from `releaseFrom` (an attenuation), the release on its own. Returns the
 * held curve as [{t (s), env, phase}] at every change, and the release as
 * [{t, env}] from 0. Engine spec §5.5.2 "The envelope generator".
 */
export function oplEnvelopeCurves(op, ksrOff, releaseFrom = null) {
  const step = (state, k) => {
    const rp = state.phase === ENV_ATTACK ? op.ar : state.phase === ENV_DECAY ? op.dr
      : state.phase === ENV_SUSTAIN ? (op.eg ? 0 : op.rr) : state.phase === ENV_RELEASE ? op.rr : 0;
    if (state.phase === ENV_OFF || rp === 0) return;
    const rate = Math.min(60, rp * 4 + ksrOff);
    const shift = 12 - (rate >> 2);
    let steps;
    if (shift >= 0) {
      if ((k & ((1 << shift) - 1)) !== 0) return;
      steps = DUTY[rate & 3][(k >> shift) & 7];
    } else {
      steps = DUTY[rate & 3][k & 7] << -shift;
    }
    for (let s = 0; s < steps; s++) {
      const before = state.phase;
      if (before === ENV_ATTACK) {
        state.env -= (state.env >> 3) + 1;
        if (state.env <= 0) { state.env = 0; state.phase = ENV_DECAY; }
      } else if (before === ENV_DECAY) {
        state.env += 1;
        if (state.env >= op.sl) { state.env = op.sl; state.phase = ENV_SUSTAIN; }
      } else {
        state.env += 1;
        if (state.env >= 511) { state.env = 511; state.phase = ENV_OFF; }
      }
      if (state.phase !== before) break;
    }
  };
  const run = (state) => {
    const out = [{ t: 0, env: state.env, phase: state.phase }];
    for (let k = 0; k < ENV_LIMIT_SAMPLES; k++) {
      const env = state.env, phase = state.phase;
      step(state, k);
      if (state.env !== env || state.phase !== phase) out.push({ t: (k + 1) / OPL_RATE, env: state.env, phase: state.phase });
      if (state.phase === ENV_OFF) break;
      // Held for ever: nothing more will change while the key is down.
      if (state.phase === ENV_SUSTAIN && (op.eg || op.rr === 0)) break;
      if (state.phase === ENV_DECAY && op.dr === 0) break;
      if (state.phase === ENV_ATTACK && op.ar === 0) break;
      if (state.phase === ENV_RELEASE && op.rr === 0) break;
    }
    return out;
  };
  // A key-on leaves env where it is; a fresh channel's operators start at 511.
  const held = run({ env: 511, phase: ENV_ATTACK });
  const release = releaseFrom === null ? null : run({ env: releaseFrom, phase: ENV_RELEASE });
  return { held, release };
}

/** Attenuation (envelope units) → the level on the 0…63 scale, unrounded
 *  (the operator's record is 8-bit, so a fraction of a 63rd survives). */
const level63 = (env) => 63 * 2 ** (-env / 32);
/** Points every 6 dB (32 units), down to here: −48 dB, an 8-bit envelope's last step. */
const DB_STEP = 32, FLOOR = 256;
/** The envelope's time grid: a node's time to the next is a 3.5 minifloat of
 *  seconds, 1/256 s at the least (core/engine/minifloat.js). */
const MIN_STEP = 1 / 256;

/** The times a curve first reaches each multiple of DB_STEP between two
 *  attenuations (and the end), as [t, level] points. */
function fallPoints(curve, from, to, t0 = 0) {
  const pts = [];
  let next = from + DB_STEP;
  for (const c of curve) {
    while (c.env >= next && next < to) { pts.push([t0 + c.t, level63(next)]); next += DB_STEP; }
    if (c.env >= to) { pts.push([t0 + c.t, level63(to)]); return pts; }
  }
  return pts;
}

/**
 * Points [[t, level]] (t from the key-on, ascending) put on the envelope's
 * own time grid: each node's time to the next is what the record can hold,
 * chosen so that the running total follows the chip's times rather than
 * drifting by a rounding a segment. A point that falls within a step of the
 * last one kept is dropped unless it ends a cluster (a fast fall still lands
 * on its level one step later). `sustain` is re-pointed at what it became.
 */
export function snapEnvelope(points, sustain = null) {
  const out = [[0, points[0][1]]];
  let cum = 0, sus = sustain === 0 ? 0 : null;
  for (let i = 1; i < points.length; i++) {
    const [t, v] = points[i];
    let dt = t - cum;
    if (dt < MIN_STEP) {
      const last = i === points.length - 1;
      if (!last && points[i + 1][0] - cum < 2 * MIN_STEP && i !== sustain) continue;
      dt = MIN_STEP;
    }
    const idx = Math.max(1, minifloatFromDouble(Math.min(15.75, dt)));
    cum += minifloatToDouble(idx);
    out.push([cum, v]);
    if (i === sustain) sus = out.length - 1;
  }
  return { points: out, sustain: sus };
}

/**
 * An operator's volume envelope ({ points: [[s, 0…63]], sustain }) from its
 * chip envelope, or null when it is full and flat from the first sample
 * (attack at its fastest, no decay, sustained). `release` is how long it
 * goes on sounding once the key is let go, in seconds — its release from the
 * sustain level, or, for an operator without EG-TYP, the whole of its fall —
 * and null when it never ends.
 */
export function oplVolumeEnvelope(op, ksrOff) {
  const { held } = oplEnvelopeCurves(op, ksrOff);
  const silent = { env: { points: [[0, 0]], sustain: null }, release: 0, silent: true };
  if (op.ar === 0) return silent;
  const peak = held.find((c) => c.phase !== ENV_ATTACK);
  if (!peak) return silent;
  const tPeak = peak.t;
  const points = [];
  // The attack: from silence to full, the chip's curve at a level every
  // 6 dB from −48 dB (the chip itself is silent until about −72 dB).
  if (tPeak >= MIN_STEP) {
    points.push([0, 0]);
    for (let thr = FLOOR; thr >= DB_STEP; thr -= DB_STEP) {
      const c = held.find((x) => x.env <= thr);
      if (c && c.t < tPeak) points.push([c.t, level63(thr)]);
    }
  }
  points.push([tPeak, 63]);
  // The decay to the sustain level (and on, at the release rate, without EG-TYP).
  const sl = Math.min(op.sl, FLOOR);
  if (op.dr !== 0 && op.sl > 0) {
    points.push(...fallPoints(held.filter((c) => c.t >= tPeak), 0, sl));
    // A sustain level past the floor (up to −93 dB) is silence here too.
    if (op.sl > FLOOR) points.push([points[points.length - 1][0] + MIN_STEP, 0]);
  }
  let sustain = null;
  let release = null;
  if (op.eg || op.rr === 0) {
    // Holds where the decay left it (or at full, when it never decays).
    sustain = points.length - 1;
    if (op.rr !== 0) {
      const from = op.dr === 0 ? 0 : sl;
      const { release: r } = oplEnvelopeCurves(op, ksrOff, from);
      const t0 = points[points.length - 1][0];
      const fall = fallPoints(r, from, FLOOR, t0);
      if (fall.length) {
        points.push(...fall, [fall[fall.length - 1][0] + MIN_STEP, 0]);
        release = fall[fall.length - 1][0] - t0 + MIN_STEP;
      }
    }
  } else if (op.dr !== 0 || op.sl === 0) {
    // No EG-TYP: past the sustain level it keeps falling at the release rate,
    // key or no key — the note ends by itself.
    const tail = held.filter((c) => c.phase === ENV_SUSTAIN || c.phase === ENV_OFF);
    if (tail.length && op.rr !== 0 && sl < FLOOR) {
      const fall = fallPoints(tail, sl, FLOOR);
      if (fall.length) points.push(...fall);
    }
    const end = points[points.length - 1][0] + MIN_STEP;
    points.push([end, 0]);
    release = end;
  }
  const snapped = snapEnvelope(points, sustain);
  const flat = snapped.points.length === 1 && snapped.points[0][1] === 63 && sustain !== null && release === null;
  return { env: flat ? null : { points: snapped.points.slice(0, 25), sustain: snapped.sustain }, release, silent: false };
}

/**
 * The rack for a decoded OPL patch, or { error }. `rate` is the instrument's
 * C2SPD (0 = 8363). Returns
 *   { ops: [{ ws, ratio, gain, env, vibDepth, name }],
 *     mods: [[i…]…], carriers: [i…],
 *     feedback: { gain } | null,         operator 0 into itself, a linear depth
 *     release: s | null,                 the carriers' longest release
 *     lost: ["tremolo", "keyScale"…] }   what the rack does not carry
 */
export function oplRackSpec(patch, rate = 0) {
  if (!OPL_FM_KINDS.includes(patch.kind)) return { error: "noise" };
  const n = OPL_KIND_OPERATORS[patch.kind];
  const hz = LINEAR_FREQ_C4_HZ * ((rate || OPL_C4_RATE) / OPL_C4_RATE);
  const { block, fnum } = oplBlockFnum(hz, patch.lowFnum);
  const ksv = (block << 1) | ((fnum >> (patch.nts ? 8 : 9)) & 1);
  const rhythm = patch.kind === OPL_KIND_BD || patch.kind === OPL_KIND_TOM;

  let mods, carriers;
  if (patch.kind === OPL_KIND_4OP) {
    if (!patch.cntA) {
      mods = patch.cntB ? [[], [0], [], [2]] : [[], [0], [1], [2]];
      carriers = patch.cntB ? [1, 3] : [3];
    } else {
      mods = patch.cntB ? [[], [], [1], []] : [[], [], [1], [2]];
      carriers = patch.cntB ? [0, 2, 3] : [0, 3];
    }
  } else if (patch.kind === OPL_KIND_TOM) {
    mods = [[]];
    carriers = [0];
  } else {
    mods = patch.cntA ? [[], []] : [[], [0]];
    carriers = patch.cntA ? [0, 1] : [1];
  }

  const lost = new Set();
  const ops = [];
  let release = null;
  for (let i = 0; i < n; i++) {
    const op = patch.ops[i];
    const isCarrier = carriers.includes(i);
    const ksrOff = op.ksr ? ksv : ksv >> 2;
    const att = op.tl * 32 + kslAtt(op.ksl, block, fnum) * 8; // 1/256 of a doubling
    const level = 2 ** (-att / 256);
    const gain = isCarrier ? level * (OPL_FULL / 4096) * (rhythm ? 2 : 1) : level * (OPL_FULL / 1024);
    const v = oplVolumeEnvelope(op, ksrOff);
    if (isCarrier && v.release !== null) release = Math.max(release ?? 0, v.release);
    if (op.am) lost.add("tremolo");
    if (op.ksl) lost.add("keyScaleLevel");
    if (op.ksr) lost.add("keyScaleRate");
    ops.push({
      ws: op.ws & 7,
      ratio: MULT_X2[op.mult & 15] / 2,
      gain: v.silent ? 0 : gain,
      env: v.env,
      vibDepth: op.vib ? (patch.deepVibrato ? 14 : 7) : 0,
      name: `OPL op ${i + 1}`,
    });
  }
  // Feedback reaches operator 1 of every kind but the tom-tom (§5.5.2).
  let feedback = null;
  if (patch.feedback > 0 && patch.kind !== OPL_KIND_TOM && ops[0].gain > 0) {
    const level = ops[0].gain / (carriers.includes(0) ? (OPL_FULL / 4096) * (rhythm ? 2 : 1) : OPL_FULL / 1024);
    feedback = { gain: (2 ** (patch.feedback - 8) * (OPL_FULL / 1024) * level) / ops[0].gain };
  }
  return { ops, mods, carriers, feedback, release, lost: [...lost] };
}

/** The noise drums no rack can play. */
export const OPL_NOISE_KINDS = Object.freeze([OPL_KIND_SD, OPL_KIND_TC, OPL_KIND_HH]);
