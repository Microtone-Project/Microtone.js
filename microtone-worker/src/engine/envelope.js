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

import { minifloatToDouble } from "./minifloat.js";
import {
  lfoSample, AUTOVIB_PHASE_STEPS, AUTOVIB_DEPTH_MUL, AUTOVIB_DEPTH_SHIFT,
} from "./tables.js";
import { startRampOut } from "./sampler.js";

/**
 * Resolve the active wrap region from LOOP and SUSTAIN words + key state.
 * LOOP word: 0b0000_0sss_ssXcb_eeeee; SUSTAIN word: 0b0000_0sss_ss00b_eeeee.
 * bit 5 = enable; bits 12..8 = start, bits 4..0 = end. Priority matches
 * schismtracker player/sndmix.c:480-499. outRange[1] = -1 when no wrap.
 */
export function resolveEnvWrap(loopWord, sustainWord, keyOff, outRange) {
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
export function envPresent(loopWord) {
  return ((loopWord >>> 13) & 1) !== 0;
}

/** Envelope-carry test — the `c` bit at LOOP word bit 6 (item 169.1). A carried
 *  envelope keeps its playhead across a retrigger instead of rewinding to node
 *  0; whether the trigger is ALLOWED to carry is the caller's decision (see
 *  triggerNote), because that depends on the voice, not on the envelope. */
export function envCarry(loopWord) {
  return ((loopWord >>> 6) & 1) !== 0;
}

// Reusable scratch (allocation-free per-tick walks; single-threaded per worklet).
const volWrap = new Int32Array(2);
const panWrap = new Int32Array(2);
const pfWrap = new Int32Array(2);
export const pfIdxBox = new Int32Array(1);
export const pfTimeBox = new Float64Array(1);

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
 * "Key Lift" — New Note Action 4, the fifth of them (TAUD_FILE_FORMAT byte 186):
 * a MIDI-exact key release, jumping the volume envelope playhead straight to
 * the sustain-end node on key-off so the release nodes play immediately.
 * Applies wherever key-off is delivered: pattern KEY_OFF (0x0001), the NNA
 * ghost spawned on a new note, DCA Note Off, and past-note S $71.
 */
export function applyKeyLift(voice, inst) {
  if (!inst.nnaKeyLift) return;
  jumpToSustainEnd(voice);
}

/** S $Dxny's $n=4 "Key lift" follow-up action (item 94): forces the same
 *  sustain-end jump as applyKeyLift but bypasses the instrument's own Key
 *  Lift flag — a per-note override, same spirit as S $73..$76's per-voice
 *  NNA override. Distinct from $n=0 "Note off", which respects the flag. */
export function forceKeyLift(voice) {
  jumpToSustainEnd(voice);
}

/** Volume + pan envelope advance (once per tick). */
export function advanceEnvelope(voice, tickSec) {
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
export function advancePfRole(env, loopWord, susWord, keyOff, tickSec, wrapScratch, idxBox, timeBox) {
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
export function seedPfRole(env, loopWord, susWord) {
  pfIdxBox[0] = 0;
  pfTimeBox[0] = 0.0;
  return advancePfRole(env, loopWord, susWord, false, 0.0, pfWrap, pfIdxBox, pfTimeBox);
}

/** Advance the pitch envelope (drives playback rate; 0.5 = unity). */
export function advancePitchEnvelope(voice, tickSec) {
  if (!voice.hasPitchEnv || !voice.pitchEnvOn) return;
  pfIdxBox[0] = voice.envPitchIndex;
  pfTimeBox[0] = voice.envPitchTimeSec;
  voice.envPitchValue = advancePfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
    voice.activePitchEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox);
  voice.envPitchIndex = pfIdxBox[0];
  voice.envPitchTimeSec = pfTimeBox[0];
}

/** Advance the filter envelope (drives cutoff; 0.5 = unity). */
export function advanceFilterEnvelope(voice, tickSec) {
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
export function advanceAutoVibrato(voice, inst) {
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
