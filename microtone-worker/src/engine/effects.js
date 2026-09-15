// Effect-column dispatch — port of AudioAdapter.kt resolveArg (3214),
// applyEffectRow (3216), applySEffect (3538), forEachLayerTarget (3633),
// applyFilterParamEffect (3650), applyRetrigVolMod (4090).
// Behavioural contract: TAUD_NOTE_EFFECTS.md; implementation truth: the Kotlin.

import { NUM_CUES, INTERP_A500, INTERP_A1200 } from "./constants.js";
import {
  EffectOp, FINETUNE_OFFSET,
  amigaSlideOnce, linearFreqSlideOnce, clamp,
} from "./tables.js";
import { computePlaybackRate } from "./sampler.js";
import {
  decodeSampleRegion, regionScratch, REGION_NONE, REGION_COMB,
  MOD_OFF, modStepPeriod, extYkPeriodTicks,
} from "./samplemod.js";
import { patchAt } from "./inst.js";
import { isSoundingChild } from "./voice.js";
import { applyPastNoteAction } from "./trigger.js";
import {
  SURROUND_STEREO, SURROUND_SPATIAL,
  applyPanSet, applyPanSlide, applyElevation, anglesFromSpatialArg,
} from "./spatial.js";

/** Scratch [azimuth, elevation] for the X / 4 argument decode. */
const spatialArg = new Float64Array(2);

/** Resolve a non-zero argument or recall from cohort memory. */
export function resolveArg(arg, mem) { return arg !== 0 ? arg : mem; }

/**
 * `ext` (item 162): the argument of a `:` sharing this row with `op`, or null
 * when there isn't one (any Format 1/2 row, or a Format 3 row where `op`
 * isn't paired). Only OP_J / OP_O / OP_2 / OP_3 read it; every other case
 * ignores it, and a colon reaching this switch in its OWN slot (unpaired, or
 * paired with another colon) hits OP_COLON's bare `break` — a genuine no-op.
 */
export function applyEffectRow(eng, ts, playhead, voice, vi, op, rawArg, ext = null) {
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

export function applySEffect(eng, ts, voice, vi, arg) {
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
      // S$7x — Note/Instrument actions. $0..$2 are no-ops on a metainstrument;
      // $7..$E fan out across the meta's constituents (forEachLayerTarget).
      //
      // $0..$2 are PAST-note actions, and a live meta's layer children are
      // themselves background voices — so on a meta's channel they would cull
      // the very layers making up the sounding note. That hazard is theirs
      // alone. $3..$6 only arm what the note's NEXT displacement does to it,
      // and a metainstrument is ONE note, so the pattern gets to say what
      // happens to all of it (item 191.1). The override is written on the
      // channel's own voice and read from there by both halves of the release:
      // maybeSpawnBackgroundForNNA for the foreground, releaseLayerChildren
      // for the children.
      const isMeta = voice.metaForeground;
      switch (x) {
        case 0x0: if (!isMeta) applyPastNoteAction(eng, ts, vi, 0); break;
        case 0x1: if (!isMeta) applyPastNoteAction(eng, ts, vi, 1); break;
        case 0x2: if (!isMeta) applyPastNoteAction(eng, ts, vi, 2); break;
        case 0x3: voice.nnaOverride = 1; break; // NNA Note Cut
        case 0x4: voice.nnaOverride = 2; break; // NNA Note Continue
        case 0x5: voice.nnaOverride = 0; break; // NNA Note Off
        case 0x6: voice.nnaOverride = 3; break; // NNA Note Fade
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
export function applySampleModEffect(eng, ts, voice, vi, rawArg, invert, ext = null) {
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
export function forEachLayerTarget(ts, voice, vi, action) {
  action(voice);
  for (const bg of ts.backgroundVoices) {
    if (isSoundingChild(ts, bg, vi)) action(bg);
  }
}

/**
 * notefx 5 (cutoff) / 6 (resonance) — instrument-wide filter parameter control.
 * $FFFF clears the override; IT mode takes the high byte, SF mode the full 16 bits.
 */
export function applyFilterParamEffect(eng, ts, voice, vi, rawArg, isResonance) {
  const targets = new Set();
  targets.add(voice.instrumentId);
  for (const bg of ts.backgroundVoices) {
    if (isSoundingChild(ts, bg, vi)) targets.add(bg.instrumentId);
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
export function applyRetrigVolMod(vol, x, step = 1, max = 0x3f) {
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
