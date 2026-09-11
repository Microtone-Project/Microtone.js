// Voice + MemorySlots — port of AudioAdapter.kt:4497-4878. All fields are
// initialised in the constructor (monomorphic shape for the JIT); defaults
// match the Kotlin field initialisers exactly. Envelope point `offset` fields
// hold ThreeFiveMiniUfloat LUT indices.

import { SCOPE_BUFFER_SIZE } from "./constants.js";
import { envPoint } from "./inst.js";
import { ModGeom } from "./samplemod.js";

/** Per-channel effect memory cohorts and private slots (TAUD_NOTE_EFFECTS.md §6). */
export class MemorySlots {
  constructor() {
    this.ef = 0;        // shared E/F (pitch slide)
    this.g = 0;         // G (tone porta) private speed
    this.huSpeed = 0;   // shared H/U vibrato
    this.huDepth = 0;
    this.rSpeed = 0;    // R (tremolo)
    this.rDepth = 0;
    this.ySpeed = 0;    // Y (panbrello)
    this.yDepth = 0;
    this.d = 0;
    this.i = 0;
    this.j = 0;
    this.jExt1 = 0;      // item 162: J extended by `:` — private, different units to `j`
    this.jExt2 = 0;
    this.o = 0;
    this.oExt = 0;       // item 162: O extended by `:` — 32-bit offset, private, different units to `o`
    this.q = 0;
    this.tslide = 0;
    this.w = 0;
    this.k = 0;
    this.l = 0;
    this.n = 0;
    this.p = 0;
    this.z = 0;         // Z (spherical panning slide speed, #998.2)
  }
}

function makeActiveEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * Per-channel DSP history for a multi-channel (Ixmp 's') voice — item 90.
 * Channel 1 uses the Voice's OWN fields (so the mono path is untouched); this
 * mirrors the same field names for channel 2, which is why applyVoiceFilter /
 * applyTaudVoiceFx / fetchTrackerSample can take either object as their state
 * holder. Coefficients, envelopes and pitch stay shared — only the history
 * that must not be crossed between channels lives here.
 */
export class ChannelState {
  constructor() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  /** Trigger-time reset — mirrors what triggerNote does to the Voice's own. */
  reset() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  copyFrom(src) {
    this.filterY1 = src.filterY1;
    this.filterY2 = src.filterY2;
    this.filterX1 = src.filterX1;
    this.filterX2 = src.filterX2;
    this.bitcrusherCounter = src.bitcrusherCounter;
    this.bitcrusherHeld = src.bitcrusherHeld;
    this.nesDpcmCounter = src.nesDpcmCounter;
  }
}

export class Voice {
  constructor() {
    this.active = false;
    // Host-owned 256-step attenuator (0 = unity, 255 = silence/mute sentinel).
    this.fader = 0;
    this.samplePos = 0.0;
    this.playbackRate = 1.0;
    // Per-sample interpolation of the pitch (item 141). playbackRate is the
    // TARGET the tick just set; currentPlaybackRate is what the sampler steps
    // by, glided toward it across the tick so a slide or a vibrato is a
    // continuous bend rather than a staircase of 50 steps a second.
    this.currentPlaybackRate = 1.0;
    this.pitchRampSamples = 0;
    this.pitchRampStep = 0.0;
    this.snapPlaybackRate = true;
    this.forward = true;
    this.instrumentId = 0;
    // Display-only: the pattern-level instrument that triggered this voice (a
    // metainstrument's SLOT, not the layer-child it resolves to) — so the
    // Timeline voice header shows the number the user sees in the pattern. No
    // Kotlin counterpart (write-only, like renderPitch).
    this.displayInst = 0;

    // -1 for live foreground voices; 0..NUM_VOICES-1 = source channel for background ghosts.
    this.sourceChannel = -1;

    // ── Stem-export taps (item 93; JS-only, never read by the DSP) ──
    // Index into inst.extraPatches of the Ixmp patch this trigger resolved to,
    // -1 = the base record. Lets the exporter put each drum of a percussion
    // instrument on its own track.
    this.activePatchIndex = -1;
    // Memoised stem routing: stemKey is the (displayInst, instrumentId,
    // activePatchIndex) triple the exporter last resolved, stemIndex its answer.
    // Declared here so the Voice shape stays monomorphic.
    this.stemKey = -1;
    this.stemIndex = -1;

    // ── Metainstrument layering ──
    this.isLayerChild = false;
    this.layerRelDetune = 0;
    // A NON-MELODIC layer's own note (item 179), or -1 for the ordinary kind
    // that tracks the parent. The per-tick sync reads it instead of deriving a
    // pitch from the parent's, which is the whole of "always the same pitch
    // regardless of the keyed note" once the trigger has run.
    this.layerFixedNote = -1;
    // How far this layer sits from the meta's centre (layer 0), in note-axis
    // units — the pan twin of layerRelDetune, re-added by the per-tick sync so
    // the arrangement ROTATES with the note rather than collapsing (item 118).
    this.layerRelPan = 0;
    this.layerRelElevation = 0;
    this.layerMixGain = 1.0;
    // The parent channel's per-tick pitch overlay (vibrato / glissando /
    // arpeggio), copied down by the per-tick sync so an effect that bends the
    // note bends the WHOLE metainstrument and not just layer 0 (item 154).
    this.layerPitchMod = 0;
    this.nnaOverride = -1;
    // Per-voice envelope gates (S $77..$7E).
    this.volEnvOn = true;
    this.panEnvOn = true;
    this.pitchEnvOn = true;
    this.filterEnvOn = true;
    this.metaForeground = false;
    // How far THIS voice's own noteVal sits from the raw note it was
    // triggered at — layer 0's (or the FM rack's operator 0's) own detune,
    // the same quantity layerRelDetune measures for a CHILD relative to layer
    // 0. A subsequent tone-portamento row's target is a raw pattern note, so
    // it needs the same offset applied before it means anything against this
    // voice's own (detuned) noteVal coordinate (row.js, item 176).
    this.metaForegroundDetune = 0;
    this.noteFading = false;

    // ── FM operator rack (Metainstrument type 4, item 159) ──
    // On a channel's foreground voice: the live rack this note is sounding
    // (engine/fm.js FmRig), or null for every ordinary voice — which is what
    // the mixer branches on, so nothing that never plays a rack pays for it.
    this.fmRig = null;
    // On a background voice: this is an OPERATOR of some channel's rack, not a
    // sound of its own. The tick pass maintains it like a layer child; the
    // mixer skips it, because the rack's own render is what reads it.
    this.fmOperator = false;

    // Two-axis volume AND pan model (TAUD_NOTE_EFFECTS.md §3). Both axes work
    // the same way on either side: the instrument seeds the NOTE axis and the
    // pattern's channel commands own the CHANNEL axis, and the two combine at
    // the mixer — volume multiplies, pan adds.
    this.noteVolume = 0x3f;
    this.channelVolume = 0x3f;
    this.rowVolume = 63;
    this.channelPan = 0x80;
    this.rowPan = 32;
    // Note-pan axis: a signed OFFSET from the channel's position, in the same
    // 512-units-to-a-turn space as panAzimuth (so on the front arc it is just a
    // pan-byte delta). 0 = neutral, which is what keeps a song that never
    // touches it rendering exactly as it did under the single-register model.
    // Seeded by the Ixmp patch's `default pan` and written by the panning
    // column; nothing else may write it.
    this.notePan = 0;
    this.noteElevation = 0.0;      // the wide panning column's elevation half

    // ── Spatial position (#998) — used only when the song is planar/spatial.
    // channelPan stays the legacy integer (and the UI's mirror); panAzimuth is
    // the continuous 512-unit angle the mixer and the Z slide work in.
    this.panAzimuth = 128.0;       // 0 = left, 128 = front, 256 = right
    this.panElevation = 0.0;       // 128 units = 90°
    this.spatialTargetAz = 128.0;  // effect 4
    this.spatialTargetEl = 0.0;
    this.spatialSlideActive = false; // armed by Z for the current row
    // Mixer-side cache of the renderer gains: {az, el, chans, renderer, gains}.
    this.spatial = null;
    // The same, for the master strip's analysis bus (item 98) — a separate slot
    // so the two buses do not invalidate each other every sample.
    this.analysisSpatial = null;

    // Anti-click volume ramp.
    this.currentMixVolume = 1.0;
    this.volRampSamples = 0;
    this.volRampStep = 0.0;
    // …and of the pan (item 141), for the same reason: the pan law is evaluated
    // per sample but every input to it moves once a tick, so a slide, a
    // panbrello or a pan envelope stepped the gain 50 times a second.
    this.currentPan = 128.0;
    this.panRampSamples = 0;
    this.panRampStep = 0.0;
    this.snapPan = true;
    this.snapMixVolume = false;

    this.keyOff = false;
    this.envIndex = 0;
    this.envTimeSec = 0.0;
    this.envVolume = 1.0;
    // Per-sample smoothed copy of envVolume (see AudioAdapter.kt:4615-4624).
    this.envVolMix = 1.0;
    this.envVolStep = 0.0;
    this.envPanIndex = 0;
    this.envPanTimeSec = 0.0;
    this.envPan = 0.5;
    this.hasPanEnv = false;

    // Pitch and filter envelopes (0.5 = unity).
    this.hasPitchEnv = false;
    this.envPitchIndex = 0;
    this.envPitchTimeSec = 0.0;
    this.envPitchValue = 0.5;
    this.hasFilterEnv = false;
    this.envFilterIndex = 0;
    this.envFilterTimeSec = 0.0;
    this.envFilterValue = 0.5;

    this.fadeoutVolume = 1.0;

    // MilkyTracker-style anti-click ramp-out.
    this.rampOutSamples = 0;
    this.rampOutGain = 0.0;
    this.rampOutStep = 0.0;

    // Volume ramp for Attack (item 139). Counts down from ATTACK_RAMP_SAMPLES to 0
    // on every fresh triggerNote(); the mixer reads it as a half-cosine fade-in gain
    // and folds it into the same per-sample rampGain the sample-end ramp-out uses.
    this.attackRampSamples = 0;

    // Auto-vibrato.
    this.autoVibPhase = 0;
    this.autoVibTicksSinceTrigger = 0;

    // Active-sample view (snapshot by applyActiveSample at trigger).
    this.activeSamplePtr = 0;
    this.activeSampleLength = 0;
    this.activeSamplePlayStart = 0;
    this.activeSampleLoopStart = 0;
    this.activeSampleLoopEnd = 0;
    this.activeSamplingRate = 0;
    this.activeSampleDetune = 0; // signed 4096-TET
    this.activeLoopMode = 0;     // bits 0-1 direction, bit 2 sustain
    this.activeVibratoSpeed = 0;
    this.activeVibratoSweep = 0;
    this.activeVibratoDepth = 0;
    this.activeVibratoRate = 0;
    this.activeVibratoWaveform = 0;
    // Multi-channel view (Ixmp 's' block, item 90). 1 = mono — the only case
    // before stereo, and the only one the base instrument can express. 2 = the
    // sample is a stereo PAIR: chanPtr2 is the right channel's pool span, which
    // shares every geometry field above (length / play-start / loop / rate).
    // chanMode 0 = discrete L,R; 1 = matrix M,S (decoded at mix time).
    this.activeChanCount = 1;
    this.activeChanMode = 0;
    this.activeChanPtr2 = 0;
    this.right = new ChannelState();

    // Active-envelope view (snapshot by resolveActiveEnvelopes at trigger).
    this.activeVolEnv = makeActiveEnv(0x3f);
    this.activeVolEnvLoop = 0;
    this.activeVolEnvSustain = 0;
    this.activePanEnv = makeActiveEnv(0x80);
    this.activePanEnvLoop = 0;
    this.activePanEnvSustain = 0;
    this.activePitchEnv = makeActiveEnv(0x80);
    this.activePitchEnvLoop = 0;
    this.activePitchEnvSustain = 0;
    this.activeFilterEnv = makeActiveEnv(0x80);
    this.activeFilterEnvLoop = 0;
    this.activeFilterEnvSustain = 0;
    this.activeFadeoutStep = 0;
    this.activeDefaultCutoff = 0xff;
    this.activeDefaultResonance = 0xff;
    // false = IT filter units (bytes), true = SoundFont (cents / centibels).
    this.filterSfMode = false;
    this.activeAttenGain = 1.0;

    // NES 2A03 DMC counter for INTERP_NES_DPCM.
    this.nesDpcmCounter = 63;

    // Filter state.
    this.currentCutoff = 0xff;
    this.currentResonance = 0xff;
    this.filterActive = false;
    // IT 2-pole IIR-only: y[n] = A0·x[n] + B0·y[n-1] + B1·y[n-2]
    this.filterA0 = 1.0;
    this.filterB0 = 0.0;
    this.filterB1 = 0.0;
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    // SF2 RBJ biquad: y[n] = b02·(x[n]+x[n-2]) + b1·x[n-1] − a1·y[n-1] − a2·y[n-2]
    this.filterIsBiquad = false;
    this.filterBqB02 = 0.0;
    this.filterBqB1 = 0.0;
    this.filterBqA1 = 0.0;
    this.filterBqA2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.filterCutoffCached = -1;
    this.filterResonanceCached = -1;

    // Per-trigger random vol/pan swing biases.
    this.randomVolBias = 0;
    this.randomPanBias = 0;

    // Pitch state (4096-TET).
    this.noteVal = 0x0000;
    this.basePitch = 0x4000;
    this.amigaPeriod = -1.0; // -1.0 = needs reseed
    this.linearFreq = -1.0;
    // JS-only display tap (no Kotlin counterpart): the last per-tick sounding
    // pitch (finalPitch — after slides/arpeggio/vibrato/pitch-env), so the
    // Timeline header can show what the voice is ACTUALLY playing per tick, not
    // just the row-triggered noteVal. Never read by the DSP.
    this.renderPitch = 0x0000;
    // This tick's pitch OVERLAY — vibrato / glissando / arpeggio, as a signed
    // delta on noteVal. A metainstrument's layer children read it off their
    // parent so the bend reaches every layer (item 154; layerPitchMod).
    this.pitchModDelta = 0;

    // Per-row effect state.
    this.rowEffect = 0;
    this.rowEffectArg = 0;
    this.slideMode = 0;
    this.slideArg = 0;
    this.tonePortaTarget = -1;
    this.tonePortaSpeed = 0;
    this.arpOff1 = 0;
    this.arpOff2 = 0;
    this.arpActive = false;
    this.lastArpVoice = 0;
    this.tremorOn = 0;
    this.tremorOnTime = 1;
    this.tremorOffTime = 1;
    this.tremorPhaseOn = true;
    this.tremorTickInPhase = 0;

    // Vibrato (H / U).
    this.vibratoActive = false;
    this.vibratoLfoPos = 0;   // 1088-step phase (lfoSampleWide), not the auto-vib 256
    this.vibratoWave = 0;
    this.vibratoRetrig = true;
    this.vibratoFineShift = 6; // 6 for H, 8 for U

    // Tremolo (R).
    this.tremoloActive = false;
    this.tremoloLfoPos = 0;
    this.tremoloWave = 0;
    this.tremoloRetrig = true;

    // Panbrello (Y). `panbrelloOffset` is a signed pan offset the mixer sums
    // alongside notePan and randomPanBias — an OFFSET rather than a write to
    // either axis, so the LFO swings around wherever the channel and the note
    // have put the voice without eating the instrument's own pan seed, and so
    // it reaches the surround path (voiceAzimuth) unchanged.
    this.panbrelloActive = false;
    this.panbrelloLfoPos = 0;
    this.panbrelloWave = 0;
    this.panbrelloRetrig = true;
    this.panbrelloOffset = 0;

    this.glissandoOn = false;

    // Q retrigger.
    this.retrigCounter = 0;
    this.retrigInterval = 0;
    this.retrigVolMod = 0;
    this.retrigActive = false;

    // Note delay (S$Dx) + its optional post-trigger action (S$Dxny, item 94;
    // JS-only so far — TSVM has no `n`/`y` handling yet, only `x`).
    this.noteDelayTick = -1;
    this.delayedNote = 0;
    this.delayedInst = 0;
    this.delayedVol = -1;
    // The argument a DELAYED Int0..IntF marker is holding (item 181).
    // `delayedNote` carries the marker itself, but a note word has no room for
    // a second 16-bit number, so the argument needs its own slot.
    this.delayedInterruptArg = 0;
    this.noteActionTick = -1; // absolute tick-in-row for the S$Dxny follow-up ($x+$y)
    this.delayedAction = -1;  // the $n value (0..4), or -1 = none scheduled

    // Note cut (S$Cx).
    this.cutAtTick = -1;
    this.noteWasCut = false;

    // Invert loop (S $F0xx).
    this.invertSpeed = 0;
    this.invertAccumulator = 0;
    this.invertWritePos = 0;

    // Funk repeat (Z $Ffxx) — ProTracker 1.0C's OTHER EFx, which hops the
    // sounding LOOP WINDOW through the sample instead of inverting bytes.
    // `funkPos` is the walking pointer (PT's n_wavestart: an absolute byte
    // index, -1 = never walked) and `funkWindow` is the window the voice is
    // actually sounding — Paula reloaded AUDxLC at the loop wrap, so the
    // pointer may be ahead of the window that is playing. `funkMode` is item
    // 163's `$f`: the hop's size and what it does (tick.js funkWalkStep /
    // funkWalkPointer), 0 being 1.0C's own whole-block hop forward.
    // `funkWalk` is where the DETERMINISTIC walk has got to, which is the same
    // as funkPos except under `$8`-`$B`, whose throw is measured from it every
    // step so the jitter cannot accumulate. Speed, mode and accumulator are all
    // CHANNEL state: nothing resets them but a transport reset (§2.1).
    this.funkSpeed = 0;
    this.funkMode = 0;
    this.funkAccumulator = 0;
    this.funkWalk = -1;
    this.funkPos = -1;
    this.funkWindow = -1;
    // Anti-click crossfade over the seam a hop opens (item 163.2), the sample
    // modifications' idea applied to a moved loop: `funkXfade` counts down
    // output samples out of `funkXfadeLen`, and the ghost read is the live
    // position shifted by `funkXfadeOffset` — (old window − new window), so it
    // follows the voice's own rate and direction without a second cursor.
    this.funkXfade = 0;
    this.funkXfadeLen = 1;
    this.funkXfadeOffset = 0;

    // Sample modification (notefx 2 / 3) — the operation and its region live on
    // the instrument; the channel only drives the clock. `modPeriod` is the step
    // period in TICKS (item 153.1), 0 = frozen, and modTickCount counts up to it.
    this.modPeriod = 0;
    this.modTickCount = 0;
    this.modWritePos = 0;
    // Countdown of the anti-click crossfade between the mapping the last step
    // replaced and the one it installed (item 153.5), in output samples.
    this.modXfade = 0;
    // Argument extension (item 162): a `:`-paired 2/3 clocks itself in SAMPLES
    // rather than whole ticks, since $yk reaches periods under one tick —
    // modExtended picks which clock owns this voice's step (mixer.js's
    // per-sample accumulator vs tick.js's per-tick one; never both).
    this.modExtended = false;
    this.modStepTicks = 0;        // period in TICKS (float, may be < 1) — tempo-
                                   // independent, like modPeriod; mixer.js turns
                                   // it into samples fresh every sample (spt
                                   // itself is recomputed there every sample,
                                   // for T-slide correctness) rather than baking
                                   // a stale sample count in at row-apply time.
    this.modSamplesIntoStep = 0;
    // This voice's resolved view of the instrument's region — the fractions cut
    // against the loop THIS voice is sounding. Rebuilt only when either moves.
    this.modGeom = new ModGeom();

    // Extended $102/$12x (funk repeat / funk repeat, jittered — item 173
    // follow-up): the SAME "hop the sounding loop window through the sample"
    // trick Z $Ffxx's funkWindow/funkPos/funkXfade* are, on this command's own
    // clock and state (inst.modFunkWalk/modFunkPos), never Z's. Per the formal
    // Funk Repeat spec ("add replen to repeat"), the walked window is NOT
    // bounded to $se's resolved region the way ROL/JUMP/SCATTER are — it moves
    // the loop itself, replen (= the resolved region's own length) at a time,
    // anywhere the physical sample has room. So this is applied at the loop
    // WRAP (sampler.js advanceSamplePos), exactly where Z's own hop lands, not
    // as a per-byte address transform — a funk'd voice's samplePos, once
    // windowed, simply IS somewhere else in the sample; nothing has to move
    // where each byte is read from once it gets there.
    this.modFunkWindow = -1;  // this voice's own latched restart point, -1 = never windowed
    this.modFunkXfade = 0;
    this.modFunkXfadeLen = 1;
    this.modFunkXfadeOffset = 0;

    // Pattern loop (S$Bx).
    this.loopStartRow = 0;
    this.loopCount = 0;

    // Pattern ditto (effect 7).
    this.dittoActive = false;
    this.dittoSourceStart = 0;
    this.dittoLength = 0;
    this.dittoEndRow = 0;

    // Tempo slide (T $00xy).
    this.tempoSlideDir = 0;
    this.tempoSlideAmount = 0;

    // Global volume slide (W $xy00).
    this.wSlideDir = 0;
    this.wSlideAmount = 0;

    // Volume / pan column slides.
    this.volColSlideUp = 0;
    this.volColSlideDown = 0;
    // Per-tick pan slides, one pair per axis — the pan twin of nSlideDir (N,
    // channel volume) vs volColSlide* (the volume column, note volume).
    this.panColSlideRight = 0;   // the panning column's, on the note axis
    this.panColSlideLeft = 0;
    this.chanPanSlideRight = 0;  // effect P's, on the channel axis
    this.chanPanSlideLeft = 0;
    this.nSlideDir = 0;

    // Bitcrusher (8) / Overdrive (9).
    this.clipMode = 0;
    this.bitcrusherDepth = 0;
    this.bitcrusherSkip = 0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.overdriveAmp = 0;

    this.mem = new MemorySlots();

    // Equal-energy pan-law memo (item 179). `advancePanRamp` returns a pan that
    // is CONSTANT whenever the voice is not being moved — it lands exactly on
    // its target and stays there — so the cosine and sine the law needs are
    // computed on a change and reused on every sample in between. NaN so the
    // first comparison always misses.
    this.panLawPan = NaN;
    this.panLawL = 0.0;
    this.panLawR = 0.0;
    // Soundscope ring buffer (visualisation only).
    this.scopeBuffer = new Float32Array(SCOPE_BUFFER_SIZE);
    this.scopeWritePos = 0;
  }

  get activeSampleLoopSustain() { return (this.activeLoopMode & 0x04) !== 0; }
  /** True when this voice renders a stereo pair (see activeChanCount). */
  get isStereo() { return this.activeChanCount === 2; }
}
