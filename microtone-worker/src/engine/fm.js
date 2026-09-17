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

import { ATTACK_RAMP_SAMPLES } from "./constants.js";
import {
  FM_WORD_OSC, FM_WORD_MOD, FM_WORD_FB, FM_WORD_OP, FM_INDEX_MASK,
  FmOp, FM_STACK_MAX,
} from "./inst.js";
import { META_MIX_GAIN } from "./tables.js";
import { fetchTrackerSample, advanceVolumeRamp, advancePitchRamp } from "./sampler.js";
import { applyVoiceFilter } from "./filter.js";

/**
 * The live rack behind one sounding note. Allocated per trigger, hung off the
 * lane's foreground Voice as `voice.fmRig`, and dropped the moment that
 * voice is retriggered with anything else.
 *
 * `voices[0]` is the lane's OWN voice — operator 0 sounds on it, which is
 * what gives the note a lifetime, an envelope and a place in the mix. Operators
 * 1… are background voices flagged `fmOperator`, so the tick pass maintains
 * them like layer children while the mixer leaves them alone: they are read
 * from here, not summed.
 *
 * A null slot is an operator that is not sounding this note — gated out by its
 * rectangle, pointed at nothing, or simply never named by the algorithm — and
 * reads as a constant 0.
 */
export class FmRig {
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
 * Copy a rack's non-voice state onto a fresh rig — the algorithm, the mix
 * gains and the feedback taps, but not the voices, which the caller re-hangs.
 *
 * This is what lets a rack be GHOSTED (item 191). A New Note Action on a rack
 * has to carry the whole arrangement into the background pool, operands
 * included, or the ghost sounds operator 0's bare sample instead of the patch
 * that was playing; and `last` travels with it so a rack closing a feedback
 * loop keeps its loop closed across the hand-over rather than restarting it
 * from silence mid-note.
 */
export function cloneFmRig(src) {
  const rig = new FmRig(src.count);
  rig.program = src.program;
  rig.gain.set(src.gain);
  rig.last.set(src.last);
  return rig;
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
export function fmReferencedOperators(program, count) {
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
export function fmSeedGains(rig, ops) {
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
    // Operator 0 is the lane's own voice: the mixer runs its filter, its
    // envelope and its ramps over the FINISHED signal (§5.5.1), so doing any of
    // that here would apply them twice. Every other operator is invisible to the
    // mixer and gets the same per-sample maintenance here, in the same order.
    s = applyVoiceFilter(v, s);
    v.envVolMix += v.envVolStep;
    const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
    advanceVolumeRamp(v, ts.volDiv);
    advancePitchRamp(v, spt);
    // NOT the note/lane volume, which §5.5.1's list of what an operator's
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
export function renderFmVoice(eng, ts, voice, interpMode, spt) {
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
 * Detach and silence every operator the FOREGROUND voice of lane `vi` is
 * driving. Called where a layered meta releases its children — but an orphaned
 * operator is not a sound that should be allowed to finish: on its own it is a
 * modulator nobody is reading, so it is cut rather than released.
 *
 * The operands of a rack that has already been GHOSTED (item 191) share the
 * lane but not the rack, so the test is the parent voice and not
 * `sourceChannel`: the ghost is still reading them, and cutting them here
 * would strip the modulators off a note that is meant to ring on.
 */
export function dropFmOperators(ts, vi) {
  const fg = ts.voices[vi];
  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (bg.fmOperator && bg.fmParent === fg) {
      bg.active = false;
      bg.fmOperator = false;
      bg.fmParent = null;
      bg.isLayerChild = false;
      ts.backgroundVoices.splice(i, 1);
    }
  }
}
