// Mixer + output quantiser — port of AudioAdapter.kt generateTrackerAudio
// (4128-4315) and pcm32fToPcm8 (839-873).
//
// The mix bus is Float32 (ts.mixLeft/mixRight Float32Array; typed-array stores
// round like Kotlin's .toFloat()). pcm32fToPcm8 runs Kotlin-Float semantics via
// Math.fround at every arithmetic step, and draws its TPDF dither from the
// engine's seeded xorshift32 stream — so the U8 output is deterministic.

import {
  SAMPLING_RATE, TRACKER_CHUNK, SCOPE_BUFFER_SIZE,
  INTERP_A500, INTERP_A1200, ATTACK_RAMP_SAMPLES,
} from "./constants.js";
import {
  AMIGA_A500_A0, AMIGA_A500_B1,
  AMIGA_LED_A1, AMIGA_LED_A2, AMIGA_LED_B1, AMIGA_LED_B2,
} from "./tables.js";
import {
  fetchTrackerSample, fetchTrackerSampleStereo, advanceVolumeRamp,
  advancePitchRamp, advancePanRamp,
} from "./sampler.js";
import { applyVoiceFilter, applyTaudVoiceFx } from "./filter.js";
import { renderFmVoice } from "./fm.js";
import { CHAN_MODE_MATRIX } from "./inst.js";
import {
  spatialVoiceGains, analysisVoiceGains, voiceAzimuth, voicePanByte,
} from "./spatial.js";
import { applyTrackerRow, advanceRow } from "./row.js";
import { TAP_PRE, TAP_POST } from "./loudness.js";
import { applyTrackerTick, advanceSampleModExtended } from "./tick.js";

const fround = Math.fround;

/** Scratch pair for fetchTrackerSampleStereo — one voice is mixed at a time. */
const stereoPair = [0.0, 0.0];

/**
 * One voice's contribution as a [left, right] PAIR, before pan and gain.
 * Mono voices put the same sample on both sides, which is what makes the
 * stereo path a strict generalisation: a stereo sample whose channels are
 * identical mixes bit-for-bit like the mono sample it was made from.
 *
 * Channel mode 0 (discrete) is the sample's own L,R. Mode 1 (matrix) holds
 * M,S and decodes L = M+S, R = M−S — the inverse of the M=(L+R)/2,
 * S=(L−R)/2 encoding. The decode happens BEFORE the filter and the voice FX
 * so those act on speaker feeds (the filter is linear so its result is the
 * same either way; the bitcrusher/overdrive are not, and crushing a speaker
 * feed is the sane reading). In a surround song the pair is not a pair of
 * speaker feeds at all — spatial.js places each channel as its own source at
 * the ITU angle for the sample's channel count (#998.0). Anything not
 * stereo-shaped stays mono here.
 */
function renderVoicePair(eng, ts, voice, inst, interpMode, spt, out) {
  // An FM rack (item 159) replaces the voice's own sample fetch, and nothing
  // else: the filter, the voice FX and every gain below still act on the
  // finished patch exactly as they act on a sampled one.
  if (voice.fmRig !== null) {
    const s = applyTaudVoiceFx(voice, applyVoiceFilter(voice,
      renderFmVoice(eng, ts, voice, interpMode, spt)));
    out[0] = s;
    out[1] = s;
    return out;
  }
  if (voice.activeChanCount !== 2) {
    const s = applyTaudVoiceFx(voice, applyVoiceFilter(voice,
      fetchTrackerSample(eng, voice, inst, interpMode)));
    out[0] = s;
    out[1] = s;
    return out;
  }
  fetchTrackerSampleStereo(eng, voice, inst, interpMode, out);
  let c0 = out[0], c1 = out[1];
  if (voice.activeChanMode === CHAN_MODE_MATRIX) {
    const m = c0, s = c1;
    c0 = m + s;
    c1 = m - s;
  }
  out[0] = applyTaudVoiceFx(voice, applyVoiceFilter(voice, c0));
  out[1] = applyTaudVoiceFx(voice, applyVoiceFilter(voice, c1, voice.right), voice.right);
  return out;
}

/** urand: (xorshift32() & 0xFFFFFF) / 16777216 — exact in Float32. */
function urand(eng) {
  return (eng.xorshift32() & 0xffffff) / 16777216.0;
}

/** TPDF noise in [-1, +1) — difference of two urands, exact in Float32. */
function tpdf1(eng) {
  return urand(eng) - urand(eng);
}

/**
 * Noise-shaped dither 32f → interleaved U8, writing into out (length ≥ 2·sampleCount).
 * State: eng.ditherError = Float32Array(4) [L0, L1, R0, R1].
 */
export function pcm32fToPcm8(eng, fleft, fright, sampleCount, out) {
  const b1 = 1.5;
  const b2 = -0.75;
  const scale = 127.5;
  const bias = 128;
  const ditherScale = 0.2; // fround(0.2) applied at the multiply below
  const err = eng.ditherError;

  for (let i = 0; i < sampleCount; i++) {
    // --- LEFT channel ---
    const feedbackL = fround(fround(b1 * err[0]) + fround(b2 * err[1]));
    const ditherL = fround(fround(ditherScale) * tpdf1(eng));
    let shapedL = fround(fround(fleft[i] + feedbackL) + fround(ditherL / scale));
    shapedL = shapedL < -1.0 ? -1.0 : shapedL > 1.0 ? 1.0 : shapedL;

    let qL = Math.round(fround(shapedL * scale));
    qL = qL < -128 ? -128 : qL > 127 ? 127 : qL;
    out[i * 2] = (qL + bias) & 0xff;

    const qerrL = fround(shapedL - fround(qL / scale));
    err[1] = err[0];
    err[0] = qerrL;

    // --- RIGHT channel ---
    const feedbackR = fround(fround(b1 * err[2]) + fround(b2 * err[3]));
    const ditherR = fround(fround(ditherScale) * tpdf1(eng));
    let shapedR = fround(fround(fright[i] + feedbackR) + fround(ditherR / scale));
    shapedR = shapedR < -1.0 ? -1.0 : shapedR > 1.0 ? 1.0 : shapedR;

    let qR = Math.round(fround(shapedR * scale));
    qR = qR < -128 ? -128 : qR > 127 ? 127 : qR;
    out[i * 2 + 1] = (qR + bias) & 0xff;

    const qerrR = fround(shapedR - fround(qR / scale));
    err[3] = err[2];
    err[2] = qerrR;
  }
}

/**
 * Render one 512-frame chunk for playhead into out (Uint8Array(1024), interleaved
 * U8 L,R). Returns null when the playhead has no tracker state.
 */
export function generateTrackerAudio(eng, playhead, out) {
  const ts = playhead.trackerState;
  if (ts === null) return null;

  // Jam mode mixes voices without advancing rows/cues.
  const advancing = playhead.isPlaying;
  // Stem-export tap (item 93) — null on every playback path. See TaudEngine.stemBus.
  const stems = eng.stemBus;
  // Surround object bus (#998) — null for the stereo model, which keeps the
  // plain mixL/mixR accumulators below and stays bit-exact against the JVM.
  const spatial = ts.spatial;
  if (spatial !== null) spatial.clear();
  // Master-strip analysis tap (item 98) — null unless the strip is on screen.
  // Its bus is null for a stereo song, whose tap is taken from the finished
  // mix below, so the legacy path stays exactly as it was.
  const analysis = ts.analysis;
  const abus = analysis === null ? null : analysis.bus;
  if (analysis !== null) analysis.begin();
  // Per-voice soundscope ring (item 179): the Kotlin device fills it on every
  // sample because a TSVM guest can read the window at any instant; here
  // nothing can, so it is filled only for a host that asked. Two stores per
  // voice per sample — 80 voices' worth, active or not — for a buffer no one
  // is looking at is the single cheapest thing in the mix loop to not do.
  const scopeOn = ts.scopeOn;
  const voices = ts.voices;
  const nVoices = voices.length;

  if (advancing && ts.firstRow) {
    ts.firstRow = false;
    applyTrackerRow(eng, ts, playhead);
  }

  // The rate and the Amiga coefficients are settable module bindings (item
  // 108) — read them ONCE per chunk so the per-sample loop below works on
  // plain locals, as it did when they were compile-time constants.
  const srate = SAMPLING_RATE;
  const a500A0 = AMIGA_A500_A0, a500B1 = AMIGA_A500_B1;
  const ledA1 = AMIGA_LED_A1, ledA2 = AMIGA_LED_A2;
  const ledB1 = AMIGA_LED_B1, ledB2 = AMIGA_LED_B2;

  for (let n = 0; n < TRACKER_CHUNK; n++) {
    // Recompute samples-per-tick every iteration (T/T-slide mutate BPM mid-row).
    const spt = (srate * 2.5) / playhead.bpm;
    if (advancing) {
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
        ts.tickInRow++;
        if (ts.tickInRow >= playhead.tickRate + ts.finePatternDelayExtra) {
          ts.tickInRow = 0;
          advanceRow(eng, ts, playhead);
        }
      }
    } else { // jamActive: evolve envelopes only, never advance the song
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
      }
    }

    let mixL = 0.0;
    let mixR = 0.0;
    const gvol = playhead.globalVolume / 255.0;
    const mvol = playhead.mixingVolume / 255.0;
    // Loop-invariant across the voice loop: every voice is scaled by it, and
    // nothing inside the loop can change it.
    const globalGain = (gvol * mvol * playhead.masterVolume) / 255.0;
    for (let vi = 0; vi < nVoices; vi++) {
      const voice = voices[vi];
      if (!voice.active || voice.fader === 255) {
        if (scopeOn) { // keep the soundscope flat between notes / while muted
          voice.scopeBuffer[voice.scopeWritePos] = 0;
          voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
        }
        continue;
      }
      const voiceInst = eng.instruments[voice.instrumentId];
      // Argument extension (item 162): an extended 2/3's clock runs in
      // samples, not ticks, so it steps HERE rather than in applyTrackerTick
      // — same per-sample-accumulator shape ts.samplesIntoTick uses above,
      // scoped to this one voice's instrument.
      advanceSampleModExtended(eng, ts, voice, spt);
      renderVoicePair(eng, ts, voice, voiceInst, ts.interpolationMode, spt, stereoPair);
      const sL = stereoPair[0];
      const sR = stereoPair[1];
      // Soundscope shows the mono sum — a stereo voice is still one voice.
      const sScope = voice.activeChanCount === 2 ? (sL + sR) * 0.5 : sL;
      const instGv = voiceInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + voice.randomVolBias / 255.0;
      // Per-sample envelope smoothing.
      voice.envVolMix += voice.envVolStep;
      const effEnvVol = voice.volEnvOn ? voice.envVolMix : 1.0;
      advanceVolumeRamp(voice, ts.volDiv);
      advancePitchRamp(voice, spt);
      const faderGain = (255 - voice.fader) / 255.0;
      const perVoiceGain = effEnvVol * voice.fadeoutVolume * voice.currentMixVolume *
        swingScale * instGv * faderGain * voice.layerMixGain * voice.activeAttenGain;
      const vol = perVoiceGain * globalGain;
      // ONE pan ramp, above the branch, because both paths smooth the same
      // composed number: every input to it moves once a TICK while the pan law
      // (and the ambisonic encode) is evaluated every sample, so without this
      // the gain stepped 50 times a second (item 141). Sharing it is also what
      // keeps a planar song rendering identically to its stereo twin.
      let lGain = 0.0;
      let rGain = 0.0;
      if (spatial === null) {
        // equal-energy pan law, memoised on the pan itself (item 179): two
        // transcendentals per voice per sample is a lot to pay for a number
        // that only moves while something is actually panning the voice.
        const pan = advancePanRamp(voice, voicePanByte(voice));
        if (pan !== voice.panLawPan) {
          voice.panLawPan = pan;
          voice.panLawL = Math.cos((Math.PI * pan) / 512.0);
          voice.panLawR = Math.sin((Math.PI * pan) / 512.0);
        }
        lGain = voice.panLawL;
        rGain = voice.panLawR;
      } else {
        advancePanRamp(voice, voiceAzimuth(voice), true);
      }
      // Sample-end ramp-out.
      let rampGain;
      if (voice.rampOutSamples > 0) {
        rampGain = voice.rampOutGain;
        voice.rampOutGain -= voice.rampOutStep;
        voice.rampOutSamples--;
        if (voice.rampOutSamples === 0) voice.active = false;
      } else {
        rampGain = 1.0;
      }
      // Volume ramp for Attack (item 139): half-cosine fade-in folded into the same
      // rampGain, so every downstream use (scope, stems, mix, spatial) picks it up for free.
      if (voice.attackRampSamples > 0) {
        const elapsed = ATTACK_RAMP_SAMPLES - voice.attackRampSamples;
        rampGain *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
        voice.attackRampSamples--;
      }
      if (scopeOn) {
        voice.scopeBuffer[voice.scopeWritePos] = sScope * perVoiceGain * rampGain;
        voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
      }
      if (stems !== null) stems.add(voice, vi, n, sScope * vol * rampGain);
      if (spatial === null) {
        mixL += sL * vol * lGain * rampGain;
        mixR += sR * vol * rGain * rampGain;
      } else {
        // One positioned source per sample channel: a stereo sample is a pair
        // of objects sitting ±30° apart, not two speaker feeds (#998.0).
        const g = spatialVoiceGains(spatial, voice);
        spatial.addSource(n, sL * vol, g, 0, rampGain);
        if (voice.activeChanCount === 2) {
          spatial.addSource(n, sR * vol, g, spatial.numChannels, rampGain);
        }
      }
      if (abus !== null) {
        const ag = analysisVoiceGains(abus, voice);
        abus.addSource(n, sL * vol, ag, 0, rampGain);
        if (voice.activeChanCount === 2) {
          abus.addSource(n, sR * vol, ag, abus.numChannels, rampGain);
        }
      }
    }
    // Background (NNA-ghost + metainstrument layer-child) voices.
    for (const bg of ts.backgroundVoices) {
      // An FM operator is an OPERAND, not a sound: the rack that owns it read
      // it (and aged it) in the foreground pass above, so summing it here would
      // put the modulators into the mix beside the note they shaped.
      if (bg.fmOperator) continue;
      // Muting a channel must also silence the NNA ghosts and layer children it
      // spawned (item 45): fold the source channel's fader into the bg voice's
      // own, so a channel mute/solo covers everything that came from it.
      const srcVoice = voices[bg.sourceChannel];
      const bgFader = srcVoice && srcVoice.fader > bg.fader ? srcVoice.fader : bg.fader;
      if (!bg.active || bgFader === 255) continue;
      const bgInst = eng.instruments[bg.instrumentId];
      // A metainstrument's layer children carry the sample-mod clock too
      // (item 154) — mirrors applyTrackerTick's own `if (bg.isLayerChild)`
      // gate on advanceSampleMod, just at sample instead of tick rate.
      if (bg.isLayerChild) advanceSampleModExtended(eng, ts, bg, spt);
      renderVoicePair(eng, ts, bg, bgInst, ts.interpolationMode, spt, stereoPair);
      const sL = stereoPair[0];
      const sR = stereoPair[1];
      const instGv = bgInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + bg.randomVolBias / 255.0;
      bg.envVolMix += bg.envVolStep;
      const effEnvVol = bg.volEnvOn ? bg.envVolMix : 1.0;
      advanceVolumeRamp(bg, ts.volDiv);
      advancePitchRamp(bg, spt);
      const faderGain = (255 - bgFader) / 255.0;
      const vol = (effEnvVol * bg.fadeoutVolume * bg.currentMixVolume *
        swingScale * gvol * mvol * instGv * faderGain * bg.layerMixGain * bg.activeAttenGain *
        playhead.masterVolume) / 255.0;
      let lGain = 0.0;
      let rGain = 0.0;
      if (spatial === null) {
        const pan = advancePanRamp(bg, voicePanByte(bg));
        if (pan !== bg.panLawPan) {
          bg.panLawPan = pan;
          bg.panLawL = Math.cos((Math.PI * pan) / 512.0);
          bg.panLawR = Math.sin((Math.PI * pan) / 512.0);
        }
        lGain = bg.panLawL;
        rGain = bg.panLawR;
      } else {
        advancePanRamp(bg, voiceAzimuth(bg), true);
      }
      let rampGain;
      if (bg.rampOutSamples > 0) {
        rampGain = bg.rampOutGain;
        bg.rampOutGain -= bg.rampOutStep;
        bg.rampOutSamples--;
        if (bg.rampOutSamples === 0) bg.active = false;
      } else {
        rampGain = 1.0;
      }
      if (bg.attackRampSamples > 0) {
        const elapsed = ATTACK_RAMP_SAMPLES - bg.attackRampSamples;
        rampGain *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
        bg.attackRampSamples--;
      }
      // Ghosts and layer children belong to the stem of the channel that spawned them.
      if (stems !== null) {
        const sBg = bg.activeChanCount === 2 ? (sL + sR) * 0.5 : sL;
        stems.add(bg, bg.sourceChannel, n, sBg * vol * rampGain);
      }
      if (spatial === null) {
        mixL += sL * vol * lGain * rampGain;
        mixR += sR * vol * rGain * rampGain;
      } else {
        const g = spatialVoiceGains(spatial, bg);
        spatial.addSource(n, sL * vol, g, 0, rampGain);
        if (bg.activeChanCount === 2) {
          spatial.addSource(n, sR * vol, g, spatial.numChannels, rampGain);
        }
      }
      if (abus !== null) {
        const ag = analysisVoiceGains(abus, bg);
        abus.addSource(n, sL * vol, ag, 0, rampGain);
        if (bg.activeChanCount === 2) {
          abus.addSource(n, sR * vol, ag, abus.numChannels, rampGain);
        }
      }
    }

    // Fold the object bus down to the device's pair — for the stereo renderer
    // that IS the mix; another render target hands back its own monitor decode.
    if (spatial !== null) {
      const pair = spatial.stereoAt(n);
      mixL = pair[0];
      mixR = pair[1];
    }

    // Amiga interpolation modes: post-mix LPF chain.
    if (ts.interpolationMode === INTERP_A500) {
      ts.amigaLPStateL = mixL * a500A0 + ts.amigaLPStateL * a500B1;
      ts.amigaLPStateR = mixR * a500A0 + ts.amigaLPStateR * a500B1;
      mixL = ts.amigaLPStateL;
      mixR = ts.amigaLPStateR;
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * ledA1 + sl[0] * ledA2 + sl[1] * ledA1 - sl[2] * ledB1 - sl[3] * ledB2;
        const outR = mixR * ledA1 + sr[0] * ledA2 + sr[1] * ledA1 - sr[2] * ledB1 - sr[3] * ledB2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    } else if (ts.interpolationMode === INTERP_A1200) {
      // The A1200's own 1-pole LPF sits at ~34 kHz — above Nyquist at 32 kHz
      // AND at 48 kHz — so it stays bypassed (pt2-clone).
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * ledA1 + sl[0] * ledA2 + sl[1] * ledA1 - sl[2] * ledB1 - sl[3] * ledB2;
        const outR = mixR * ledA1 + sr[0] * ledA2 + sr[1] * ledA1 - sr[2] * ledB1 - sr[3] * ledB2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    }

    // Double → Float32 (like Kotlin .toFloat()). The clamp that used to sit
    // here now runs below, after the mastering chain — clamping first would
    // hand the limiter a signal whose peaks had already been destroyed. With
    // no chain installed the two forms are identical: `fl` is stored to a
    // Float32Array either way, so the clamp reads back exactly the value it
    // used to compare.
    ts.mixLeft[n] = fround(mixL);
    ts.mixRight[n] = fround(mixR);
  }

  // ── Output stage (TAUD_ENGINE_SPEC.md §12) ──
  // Mastering (item 178) acts here: after the mix has narrowed to binary32 and
  // before it is clamped and dithered. `master` is null unless the song's own
  // `sMst` chain would actually change a sample.
  const master = ts.mastering;
  const meter = ts.masterMeter;
  // The meter reads the same buffer twice — once now, once after the chain —
  // so the "pre" figures cost no copy of the mix.
  if (meter !== null) meter.push(TAP_PRE, ts.mixLeft, ts.mixRight, TRACKER_CHUNK);
  if (master !== null) master.process(ts.mixLeft, ts.mixRight, TRACKER_CHUNK);
  for (let n = 0; n < TRACKER_CHUNK; n++) {
    const fl = ts.mixLeft[n];
    const fr = ts.mixRight[n];
    if (fl < -1.0) ts.mixLeft[n] = -1.0; else if (fl > 1.0) ts.mixLeft[n] = 1.0;
    if (fr < -1.0) ts.mixRight[n] = -1.0; else if (fr > 1.0) ts.mixRight[n] = 1.0;
  }

  // Meters/scopes read the FINISHED pair (post fold/binaural, post Amiga
  // filter, post mastering, post clamp) and, for a surround target, the
  // analysis bus above.
  if (analysis !== null) analysis.finish(TRACKER_CHUNK, ts.mixLeft, ts.mixRight);
  if (meter !== null) {
    meter.push(TAP_POST, ts.mixLeft, ts.mixRight, TRACKER_CHUNK);
    meter.compGrDb = master === null ? 0 : master.compGrDb;
    meter.limGrDb = master === null ? 0 : master.limGrDb;
  }

  pcm32fToPcm8(eng, ts.mixLeft, ts.mixRight, TRACKER_CHUNK, out);
  // Bit usage is a question about the DELIVERED codes, and which those are
  // depends on what the file is going to be — the device's dithered 8-bit
  // output, or the 16 bits a stereo WAV export writes off this same float bus.
  // The tap is given both and bins whichever its depth names.
  if (meter !== null) meter.binOutput(out, ts.mixLeft, ts.mixRight, TRACKER_CHUNK);

  // A halt cue (row.js) clears isPlaying mid-chunk — the transport's OTHER
  // stop, bypassing TaudEngine.stop and its silencing. The rest of THIS chunk
  // still rings out (that is how the song ends, and the chunk is written just
  // above), but what it leaves behind is the same frozen leftover a Stop would
  // have left, waiting for the next jam to resume it. End it here instead.
  if (advancing && !playhead.isPlaying) playhead.silenceSongVoices(playhead.jamActive);

  // Stop the jam-render spin once the audition has gone fully silent.
  if (playhead.jamActive && !playhead.isPlaying &&
      !ts.voices.some((v) => v.active) && !ts.backgroundVoices.some((v) => v.active)) {
    playhead.jamActive = false;
  }

  return out;
}
