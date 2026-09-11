// Per-tick voice processing — port of AudioAdapter.kt applyTrackerTick (3689-4087).
//
// CRITICAL: after a mid-tick note-delay trigger (S$Dx) fires, the local `inst`
// binding MUST be re-fetched — triggerNote may have swapped the voice's
// instrument, and the rest of the tick (playback-rate recompute, envelopes,
// fadeout) must see the instrument that just fired (AudioAdapter.kt:3727-3733).

import { SAMPLING_RATE } from "./constants.js";
import {
  lfoSampleWide, advanceLfoPhase, amigaSlideTick, linearFreqSlideTick,
  noteValToFreqHz, freqHzToNoteVal,
  clamp,
} from "./tables.js";
import { computePlaybackRate, startFastFade, startCutRamp } from "./sampler.js";
import { refreshVoiceFilter } from "./filter.js";
import {
  advanceEnvelope, advancePitchEnvelope, advanceFilterEnvelope,
  advanceAutoVibrato, applyKeyLift, forceKeyLift, seedPfRole, pfIdxBox, pfTimeBox,
} from "./envelope.js";
import {
  triggerMetaOrNote, applyDuplicateCheck, maybeSpawnBackgroundForNNA, cutLayerChildren,
} from "./trigger.js";
import { applyRetrigVolMod } from "./effects.js";
import {
  MOD_OFF, MOD_INVERT, MOD_STEP, MOD_WALK_SCAN, MOD_XFADE_SAMPLES,
  isRolOp, isJumpOp, isRndOp, modTouches, resolveModGeom,
  jumpRot, scatterReach, scatterSeed,
  decodeExtOp, extModTouches, extJitterFrac,
} from "./samplemod.js";
import {
  applyPanSet, applyPanSlide, applyNotePanSlide, boundNotePan, stepTowardTarget,
} from "./spatial.js";
import { random } from "./rng.js";

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
export function funkWalkStep(funkMode, walk, loopStart, loopLen, sampleLen) {
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
export function funkWalkPointer(funkMode, walk, loopStart, loopLen, sampleLen) {
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

export function applyTrackerTick(eng, ts, playhead) {
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
export function advanceSampleModExtended(eng, ts, voice, spt) {
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
