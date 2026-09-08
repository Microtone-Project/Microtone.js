// Sample fetch + interpolators + anti-click ramps — port of AudioAdapter.kt
// computePlaybackRate (1515), readSamplePoint (2211), fetchTrackerSample (2221),
// startRampOut (2341), startFastFade (2357), advanceVolumeRamp (2376).
//
// `eng` is the TaudEngine instance (carries sampleBin as a Uint8Array; playback
// addresses the 8 MB pool directly by samplePtr — banking is a device-protocol
// concern that does not exist here).

import {
  SAMPLING_RATE, MIDDLE_C, SAMPLE_BIN_TOTAL,
  INTERP_DEFAULT, INTERP_NONE, INTERP_A500, INTERP_A1200, INTERP_SNES, INTERP_NES_DPCM,
  SINC_WIDTH, RAMP_OUT_SAMPLES, ATTACK_RAMP_SAMPLES, FAST_FADE_SEC, VOL_RAMP_SAMPLES,
  PITCH_GLIDE_FULL_RATIO,
} from "./constants.js";
import { sincTap, SNES_GAUSS } from "./tables.js";
import {
  MOD_OFF, MOD_XFADE_SAMPLES, modTouches, modAddress, resolveModGeom,
  extModTouches, modAddressExt, applyExtLevel, applyExtLevelPrev, isExtFunkOp,
} from "./samplemod.js";

/**
 * Active-sample-aware playback rate (patch-aware via the voice snapshot).
 *
 * `tuningRatio` is the song's tuning (item 77, ts.tuningRatio) — a whole-song
 * frequency scale applied last. Concert-tuned songs pass exactly 1.0, which is
 * an identity multiply, so they render bit-for-bit as if tuning did not exist.
 */
export function computePlaybackRate(voice, noteVal, tuningRatio = 1.0) {
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
export function readSamplePoint(eng, voice, inst, idx, sampleLen, binMax,
                                basePtr = voice.activeSamplePtr) {
  const i0 = Math.min(Math.max(idx, 0), sampleLen - 1);
  const ls = voice.activeSampleLoopStart;
  const le = voice.activeSampleLoopEnd;
  const extended = inst.modOpExt !== 0;
  // Nothing live and nothing fading out: the plain fetch. `modOn` alone is not
  // the guard, because a step that lands on the identity mapping (a jump that
  // throws to zero) still has the PREVIOUS one to fade out of.
  if ((inst.modOp === MOD_OFF && !extended) || (!inst.modOn && voice.modXfade === 0)) {
    return (poolByte(eng, voice, inst, i0, binMax, basePtr, ls, le) - 127.5) / 127.5;
  }
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

  switch (interpMode) {
    case INTERP_DEFAULT: {
      let acc = 0.0;
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
      const oldest = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 - 1, sampleLen, binMax, basePtr));
      const olders = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr));
      const olds = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 + 1, sampleLen, binMax, basePtr));
      const news = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 + 2, sampleLen, binMax, basePtr));
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
      const target = readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
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
      return readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
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
export const FUNK_XFADE_SAMPLES = 64;

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
export function fetchTrackerSampleStereo(eng, voice, inst, interpMode, out) {
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
export function fetchTrackerSample(eng, voice, inst, interpMode, posOffset = 0) {
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
export function startRampOut(voice) {
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
export function startCutRamp(voice) {
  beginRampOut(voice, ATTACK_RAMP_SAMPLES);
}

/** Fast note-fade (note word 0x0004 — SF2 exclusiveClass choke, ≈0.3 s). */
export function startFastFade(voice, playhead) {
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
export function advancePitchRamp(voice, spt) {
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
export function advancePanRamp(voice, target, wrap = false) {
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
export function advanceVolumeRamp(voice, div = 63.0) {
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
