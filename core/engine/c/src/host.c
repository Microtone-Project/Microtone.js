/* What a HOST that edits a song asks of the engine and a player never does:
 * the jam bank (auditioning a note without displacing a song voice), the
 * full parameter reset, the chase (a play from a row that finds the song as a
 * play from the start would have left it there) and the desk's per-lane mute
 * and fader. Port of the corresponding parts of engine.js, state.js
 * (Playhead) and chase.js. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

/* ── jam / audition ── */

/* True when metainstrument `inst` would sound at least one layer at `note`
 * (the strict-layer gating of te_trigger_meta_or_note; engine.js
 * _metaSoundsAt). */
static bool meta_sounds_at(const TaudEngine *e, const TaudInst *inst, int note)
{
    const TaudMetaLayer *layers[META_MAX_LAYERS];
    int n, k, kept = 0;
    /* An FM rack stands or falls on operator 0: the rest of the rack is read
     * through it (§5.5.1). */
    if (inst_is_fm(inst)) {
        const TaudMetaLayer *o;
        if (inst->meta->count < 1) return false;
        o = &inst->meta->layers[0];
        return inst->meta->hasProgram && o->instIdx >= 1 &&
            te_pitch_in_range(note, o->pitchStart, o->dLo, o->pitchEnd, o->dHi) &&
            o->volStart <= 0x3f && o->volEnd >= 0x3f;
    }
    n = te_inst_resolve_meta_layers(inst, note, 0x3f, layers);
    if (!inst->meta->strict) return n > 0;
    for (k = 0; k < n; k++) {
        /* The pitch the layer SOUNDS — a fixed-pitch layer's own. */
        double nn = te_layer_note(layers[k], note);
        nn = nn < 0x20 ? 0x20 : nn > 0xffff ? 0xffff : nn;
        if (te_inst_resolve_patch(&e->instruments[layers[k]->instIdx], nn, 0x3f) != NULL) kept++;
    }
    return kept > 0;
}

/* Nearest note to `note`, within the union of the metainstrument's layer
 * rectangles, that actually sounds; -1 for none or for a plain instrument
 * (engine.js _auditionNoteFor). */
static int audition_note_for(const TaudEngine *e, int instId, int note)
{
    const TaudInst *inst = &e->instruments[instId];
    int lo = 0xffff, hi = 0x20, k, d;
    if (!inst_is_meta(inst)) return -1;
    for (k = 0; k < inst->meta->count; k++) {
        const TaudMetaLayer *l = &inst->meta->layers[k];
        if (l->pitchStart < lo) lo = l->pitchStart;
        if (l->pitchEnd > hi) hi = l->pitchEnd;
    }
    if (lo < 0x20) lo = 0x20;
    if (hi < lo) return -1;
    /* Outward from the requested note at a fine step (a jam event: the cost
     * is irrelevant). */
    for (d = 0; d <= hi - lo; d += 0x20) {
        int up = note + d, dn = note - d;
        if (up >= lo && up <= hi && meta_sounds_at(e, inst, up)) return up;
        if (dn >= lo && dn <= hi && meta_sounds_at(e, inst, dn)) return dn;
    }
    return -1;
}

void te_jam_note(TaudEngine *e, int vi, int note, int instId, bool audition)
{
    int v = iclamp(vi, 0, TOTAL_VOICES - 1), i;
    TaudVoice *voice = &e->voices[v];
    bool lyric;
    note &= 0xffff;
    instId &= 0x3ff;
    /* A lyric instrument jammed sings its lyrics on, a syllable a key, over
     * the whole jam bank — the bank rotates voices, so the place is the
     * playhead's, kept per instrument (item 280). */
    lyric = e->instruments[instId].lyric != NULL;
    if (lyric) {
        if (e->jamLyricInst != instId) { e->jamLyricInst = instId; e->jamLyricPos = 0; }
        voice->lyricPos = e->jamLyricPos;
    }
    te_trigger_meta_or_note(e, voice, v, note, instId, -1, !lyric, false);
    if (lyric) e->jamLyricPos = voice->lyricPos;
    /* Audition-only (item 51): a STRICT metainstrument only sounds where its
     * zones place a sample, so an arbitrary jammed pitch is often silent;
     * retry at the nearest note it can sound. Note ENTRY keeps the pitch. */
    if (audition && !voice->active) {
        bool child = false;
        for (i = 0; i < e->bgCount; i++) {
            if (e->bg[i]->sourceChannel == v && e->bg[i]->active) { child = true; break; }
        }
        if (!child) {
            int alt = audition_note_for(e, instId, note);
            if (alt >= 0) te_trigger_meta_or_note(e, voice, v, alt, instId, -1, true, false);
        }
    }
    e->jamActive = true;
}

/* Preview the EXACT pooled sample the host names on voice `vi`, bypassing all
 * instrument and metainstrument resolution: a scratch instrument in
 * AUDITION_SLOT carries the sample and a clean default envelope. chanPtr2 ≠ 0
 * auditions a STEREO pair by hanging a synthetic full-range 's' patch off the
 * scratch instrument, since only an Ixmp patch can carry a second channel. */
void te_jam_sample(TaudEngine *e, int vi, int note, uint32_t ptr, int len, int rate, int playStart,
                   int loopStart, int loopEnd, int loopMode, int detune, uint32_t chanPtr2, int chanMode)
{
    int v = iclamp(vi, 0, TOTAL_VOICES - 1);
    TaudInst *inst = &e->instruments[AUDITION_SLOT];
    note &= 0xffff;
    inst->samplePtr = ptr;
    inst->sampleLength = len;
    inst->samplingRate = rate;
    inst->samplePlayStart = playStart;
    inst->sampleLoopStart = loopStart;
    inst->sampleLoopEnd = loopEnd;
    inst->loopMode = loopMode & 0x07;   /* loop mode + sustain, drop the percussion bit */
    inst->sampleDetune = detune & 0xffff;
    te_retire(e, inst->extraPatches, sizeof(TaudPatch) * (size_t)inst->patchCount);
    inst->extraPatches = NULL;
    inst->patchCount = 0;
    if (chanPtr2 != 0) {
        TaudPatch *p = (TaudPatch *)calloc(1, sizeof *p);
        if (p == NULL) {
            e->oom = true;
        } else {
            /* makeInstPatch's defaults, then the pair. */
            p->pitchStart = 0; p->pitchEnd = 0xffff; p->volumeStart = 0; p->volumeEnd = 63;
            p->samplePtr = inst->samplePtr;
            p->sampleLength = inst->sampleLength;
            p->playStart = inst->samplePlayStart;
            p->loopStart = inst->sampleLoopStart;
            p->loopEnd = inst->sampleLoopEnd;
            p->samplingRate = inst->samplingRate;
            p->sampleDetune = inst_sample_detune_signed(inst);
            p->loopMode = inst->loopMode;
            p->defaultPan = 0xff;
            p->vibratoWaveform = 0xff;
            p->extraCutoff = 0xff;
            p->extraResonance = 0xff;
            p->hasChanBlock = true;
            p->chanCount = 2;
            p->chanMode = chanMode;
            p->chanPtrCount = 1;
            p->chanPtrs[0] = chanPtr2;
            inst->extraPatches = p;
            inst->patchCount = 1;
        }
    }
    te_trigger_note(e, &e->voices[v], note, AUDITION_SLOT, -1, NULL);
    e->jamActive = true;
}

/* Every voice, the song's included (the panic). */
void te_jam_stop(TaudEngine *e)
{
    int i;
    for (i = 0; i < TOTAL_VOICES; i++) e->voices[i].active = false;
    for (i = 0; i < e->bgCount; i++) e->bg[i]->active = false;
    e->jamActive = false;
}

/* ONE audition voice and everything it spawned (layer children, NNA ghosts);
 * vi < 0 is the whole jam bank. Ramped through the note cut's own path: a key
 * release lands wherever the waveform happens to be. */
void te_jam_stop_voice(TaudEngine *e, int vi)
{
    int lo = vi < 0 ? JAM_VOICE_BASE : imin(vi, TOTAL_VOICES - 1);
    int hi = vi < 0 ? TOTAL_VOICES - 1 : lo;
    int v, i;
    for (v = lo; v <= hi; v++) te_start_cut_ramp(e, &e->voices[v]);
    for (i = 0; i < e->bgCount; i++) {
        TaudVoice *bg = e->bg[i];
        if (bg->sourceChannel >= lo && bg->sourceChannel <= hi) te_start_cut_ramp(e, bg);
    }
}

/* RELEASE one audition voice exactly as a pattern key-off releases a lane. */
void te_jam_key_off(TaudEngine *e, int vi)
{
    TaudVoice *voice = &e->voices[iclamp(vi, 0, TOTAL_VOICES - 1)];
    if (!voice->active || voice->keyOff) return;
    voice->keyOff = true;
    te_apply_key_lift(voice, &e->instruments[voice->instrumentId]);
}

/* Whether a key-off alone ends a formant syllable: it has a coda to speak
 * (formant.js formantEndsOnKeyOff). */
static bool formant_ends_on_key_off(const TaudFormantState *st)
{
    if (st->phase == PHASE_CODA || st->phase == PHASE_DONE) return true;
    return st->hasCoda && !st->codaVeto;
}

/* A piano key LIFTED: a formant syllable that a key-off ends by itself is
 * keyed off, so its coda is heard; anything else is cut. */
void te_jam_release(TaudEngine *e, int vi)
{
    TaudVoice *voice = &e->voices[iclamp(vi, 0, TOTAL_VOICES - 1)];
    if (voice->active && !voice->keyOff && voice->formant != NULL && formant_ends_on_key_off(voice->formant)) {
        te_jam_key_off(e, vi);
    } else {
        te_jam_stop_voice(e, vi);
    }
}

/* ── the desk ── */

void te_set_voice_fader(TaudEngine *e, int vi, int fader)
{
    e->voices[iclamp(vi, 0, MAX_VOICES - 1)].fader = fader & 255;
}

int te_get_voice_fader(const TaudEngine *e, int vi)
{
    return e->voices[iclamp(vi, 0, MAX_VOICES - 1)].fader;
}

/* ── resets ── */

/* Per-instrument runtime state a play may have left: the invert mask, the
 * sample modification, the PSG overlay and the notefx 5/6 overrides. */
static void reset_instrument_runtime(TaudEngine *e, bool overrides)
{
    int i;
    for (i = 0; i < NUM_INST_SLOTS; i++) {
        TaudInst *inst = &e->instruments[i];
        inst->invertMaskLen = 0;
        te_inst_reset_mod(inst);
        if (inst->psg != NULL) te_psg_clear_runtime(inst->psg);
        if (overrides) { inst->cutoffOverride = -1; inst->resonanceOverride = -1; }
    }
}

/* A lane voice back to power-on, the desk's fader kept (Voice.resetToPowerOn). */
static void voice_reset_to_power_on(TaudVoice *v, int volMax)
{
    int fader = v->fader;
    te_voice_init(v);
    v->fader = fader;
    v->noteVolume = volMax;
    v->channelVolume = volMax;
    v->rowVolume = volMax;
}

/* Where a freshly loaded song starts — a chase's first step (§15.1). The
 * song's own tempo, tick rate and volumes are the host's to give. The jam
 * bank, the tuning, the surround model and the mastering parameters are not
 * the play's, and are left alone. */
static void reset_to_song_start(TaudEngine *e, int bpm, int tickRate, int globalVolume, int mixingVolume)
{
    int i;
    e->bpm = bpm;
    e->tickRate = tickRate;
    e->globalVolume = globalVolume;
    e->mixingVolume = mixingVolume;
    e->position = 0;
    e->cuePos = 0;
    e->rowIndex = 0;
    te_reset_play_state(e);
    e->toneMode = e->initialGlobalFlags & 3;
    e->interpolationMode = (e->initialGlobalFlags >> 2) & 7;
    e->ledFilterOn = false;
    e->amigaLPStateL = e->amigaLPStateR = 0.0;
    memset(e->amigaLEDStateL, 0, sizeof e->amigaLEDStateL);
    memset(e->amigaLEDStateR, 0, sizeof e->amigaLEDStateR);
    for (i = 0; i < JAM_VOICE_BASE; i++) voice_reset_to_power_on(&e->voices[i], e->volMax);
    reset_instrument_runtime(e, true);
}

/* The full reset a host performs before uploading a document
 * (Playhead.resetParams): spec §5 defaults, every voice silent and back to
 * its defaults, the mastering chain neutral. */
void te_reset_params(TaudEngine *e)
{
    TaudMastering neutral;
    int i;
    e->position = 0;
    e->isPlaying = false;
    e->jamActive = false;
    e->bpm = 125;
    e->tickRate = 6;
    e->globalVolume = 0x80;
    e->mixingVolume = 0x80;
    e->tuningBaseNote = 0;
    e->tuningFreq = 0.0;
    e->tuningRatio = 1.0;
    e->cuePos = 0; e->rowIndex = 0; e->tickInRow = 0;
    e->samplesIntoTick = 0.0; e->firstRow = true;
    e->oplFrame = 0;
    e->psgQuarter = 0;
    e->pendingOrderJump = -1; e->pendingRowJump = -1;
    e->pendingRowJumpLocal = false;
    e->patternDelayRemaining = 0; e->patternDelayActive = false;
    e->sexWinningChannel = -1;
    e->finePatternDelayExtra = 0;
    e->pendingInterrupts = 0;
    memset(e->interruptArgs, 0, sizeof e->interruptArgs);
    e->toneMode = e->initialGlobalFlags & 3;
    e->interpolationMode = (e->initialGlobalFlags >> 2) & 7;
    te_set_surround_model(e, e->surroundModel);
    e->ledFilterOn = false;
    e->amigaLPStateL = e->amigaLPStateR = 0.0;
    memset(e->amigaLEDStateL, 0, sizeof e->amigaLEDStateL);
    memset(e->amigaLEDStateR, 0, sizeof e->amigaLEDStateR);
    /* Mastering goes back to neutral: nothing in a fresh document describes
     * the chain the previous one left installed. */
    te_mastering_default(&neutral);
    te_set_mastering(e, &neutral);
    /* The instrument chains' PARAMETERS are the engine's; their running
     * state is the playback's. */
    te_imix_reset_chains(e);
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *it = &e->voices[i];
        it->active = false;
        it->noteVolume = e->volMax;
        it->channelVolume = e->volMax;
        it->channelVolumeSet = false;
        it->rowVolume = e->volMax;
        it->currentMixVolume = 1.0;
        it->volRampSamples = 0;
        it->volRampStep = 0.0;
        it->currentPan = 128.0; it->panRampSamples = 0; it->panRampStep = 0.0; it->snapPan = true;
        it->snapMixVolume = false;
        it->envVolMix = 1.0;
        it->envVolStep = 0.0;
        it->channelPan = 0x80;
        it->channelPanSet = false;
        it->rowPan = 32;
        it->panbrelloOffset = 0;
        it->panAzimuth = 128.0;
        it->panElevation = 0.0;
        it->notePan = 0;
        it->noteElevation = 0.0;
        it->spatialTargetAz = 128.0;
        it->spatialTargetEl = 0.0;
        it->spatialSlideActive = false;
        it->spatial.valid = false;
        it->glissandoOn = false;
        it->loopStartRow = 0;
        it->loopCount = 0;
        it->dittoActive = false;
        it->dittoSourceStart = 0;
        it->dittoLength = 0;
        it->dittoEndRow = 0;
        it->clipMode = 0;
        it->bitcrusherDepth = 0;
        it->bitcrusherSkip = 0;
        it->bitcrusherCounter = 0;
        it->bitcrusherHeld = 0.0;
        it->overdriveAmp = 0;
        it->invertSpeed = 0;
        it->invertAccumulator = 0;
        it->invertWritePos = 0;
        it->funkSpeed = 0;
        it->funkMode = 0;
        it->funkAccumulator = 0;
        it->funkWalk = -1;
        it->funkPos = -1;
        it->funkWindow = -1;
        it->funkXfade = 0;
        it->modFunkWindow = -1;
        it->modFunkXfade = 0;
        it->modPeriod = 0;
        it->modTickCount = 0;
        it->modWritePos = 0;
        it->modXfade = 0;
        it->fader = 0;
        it->faderCur = NAN;
        it->nnaOverride = -1;
        it->volEnvOn = true; it->panEnvOn = true; it->pitchEnvOn = true; it->filterEnvOn = true;
        it->metaForeground = false;
        it->metaForegroundDetune = 0;
        it->noteFading = false;
        it->layerMixGain = 1.0; it->isLayerChild = false; it->layerRelDetune = 0;
        it->layerFixedNote = -1;
        it->layerRelPan = 0; it->layerRelElevation = 0;
        it->layerPitchMod = 0; it->pitchModDelta = 0;
        it->fmRig = NULL; it->fmOperator = false; it->fmParent = NULL;
        it->opl = NULL; it->oplCarry = false; it->psg = NULL; it->psgCarry = false; it->formant = NULL;
        it->lyricPos = 0;
        it->instrumentId = 0;
        it->displayInst = 0;
        it->activePatchIndex = -1;
        it->samplePos = 0.0;
        it->playbackRate = 1.0;
        it->currentPlaybackRate = 1.0;
        it->pitchRampSamples = 0; it->pitchRampStep = 0.0; it->snapPlaybackRate = true;
        it->forward = true;
        it->keyOff = false;
        it->envIndex = 0; it->envTimeSec = 0.0; it->envVolume = 1.0;
        it->envPanIndex = 0; it->envPanTimeSec = 0.0; it->envPan = 0.5;
        it->hasVolEnv = false;
        it->hasPanEnv = false;
        it->envPitchIndex = 0; it->envPitchTimeSec = 0.0; it->envPitchValue = 0.5;
        it->envFilterIndex = 0; it->envFilterTimeSec = 0.0; it->envFilterValue = 0.5;
        it->hasPitchEnv = false; it->hasFilterEnv = false;
        it->fadeoutVolume = 1.0; it->fadeoutMix = 1.0; it->fadeoutMixStep = 0.0;
        it->rampOutSamples = 0; it->rampOutGain = 0.0; it->rampOutStep = 0.0;
        it->attackRampSamples = 0;
        it->noteVal = 0x0000; it->basePitch = 0x4000;
        it->amigaPeriod = -1.0; it->linearFreq = -1.0;
        it->tonePortaTarget = -1; it->tonePortaSpeed = 0;
        it->filterY1 = 0.0; it->filterY2 = 0.0; it->filterX1 = 0.0; it->filterX2 = 0.0;
        it->filterCutoffCached = -1; it->filterResonanceCached = -1;
        it->sfCents = NAN; it->sfCentsLeft = 0; it->sfQLeft = 0;
        it->currentCutoff = 0xff; it->currentResonance = 0xff;
        it->nesDpcmCounter = 63;
        it->right.filterY1 = 0.0; it->right.filterY2 = 0.0; it->right.filterX1 = 0.0; it->right.filterX2 = 0.0;
        it->right.bitcrusherCounter = 0;
        it->right.bitcrusherHeld = 0.0;
        it->right.nesDpcmCounter = 63;
        it->activeChanCount = 1; it->activeChanMode = 0; it->activeChanPtr2 = 0;
    }
    e->bgCount = 0;
    reset_instrument_runtime(e, true);
}

/* ── the chase (chase.js) ── */

/* How many rows the song's own path is followed for before giving up on it. */
#define CHASE_ROW_BUDGET (1 << 16)

/* One row: its event, then its tick passes and the events scheduled for each
 * later tick — the mixer's clock, unmixed. */
static void chase_row(TaudEngine *e)
{
    te_apply_tracker_row(e);
    do {
        int q;
        te_apply_tracker_tick(e);
        /* The tick's other three PSG quarters, which the mixer would have run. */
        for (q = 1; q <= 3; q++) te_psg_quarter_pass(e);
        e->psgQuarter = 3;
        e->tickInRow++;
        if (e->tickInRow < e->tickRate + e->finePatternDelayExtra) te_apply_tick_events(e);
    } while (e->tickInRow < e->tickRate + e->finePatternDelayExtra);
    e->tickInRow = 0;
}

/* The last cue holding a pattern or an instruction, or -1. */
static int last_used_cue(const TaudEngine *e)
{
    int channels = te_channel_count(e), c, ch;
    for (c = NUM_CUES - 1; c >= 0; c--) {
        const TaudCue *cue;
        /* A block never allocated holds nothing: skip it whole. */
        if (e->cueBlocks[c / CUE_BLOCK] == NULL) { c -= c % CUE_BLOCK; continue; }
        cue = te_cue_at(e, c);
        if (cue->inst0.type != INST_NOP || cue->inst1.type != INST_NOP) return c;
        for (ch = 0; ch < channels; ch++) if ((cue->raw[ch] & 0x7fff) != PATTERN_EMPTY) return c;
    }
    return -1;
}

/* Follow the song's own path from cue 0 row 0 and stop at the FIRST arrival
 * at (cue, row), before that row is applied. False when the song never gets
 * there: it halted, it re-entered a cue at a row it had entered it at before,
 * it went past the last cue holding anything, or the budget ran out. */
static bool chase_song_path(TaudEngine *e, int cue, int row)
{
    int last = last_used_cue(e), rows;
    /* Every (cue, row) the path has ENTERED a cue at: NUM_CUES × 64 bits. */
    uint8_t *entries = (uint8_t *)calloc((size_t)NUM_CUES * 64 / 8, 1);
    bool reached = false;
    if (entries == NULL) { e->oom = true; return false; }
    entries[0] = 1;
    for (rows = 0; rows < CHASE_ROW_BUDGET; rows++) {
        int fromCue, entry;
        bool jumps;
        if (e->cuePos == cue && e->rowIndex == row && !e->patternDelayActive) { reached = true; break; }
        chase_row(e);
        fromCue = e->cuePos;
        jumps = e->pendingOrderJump >= 0 || (e->pendingRowJump >= 0 && !e->pendingRowJumpLocal);
        te_advance_row_position(e);
        if (!e->isPlaying) break;
        if (e->patternDelayActive || (!jumps && e->cuePos == fromCue)) continue;
        if (e->cuePos > last && cue <= last) break;
        entry = e->cuePos * 64 + e->rowIndex;
        if (entries[entry >> 3] & (1 << (entry & 7))) break;
        entries[entry >> 3] |= (uint8_t)(1 << (entry & 7));
    }
    free(entries);
    return reached;
}

/* The fallback, for a row the song's own path never reaches: the cues in
 * their order from the first, every row of each once; flow instructions,
 * halts and jumps ignored, a pattern delay still repeating its row. */
static void chase_cue_order(TaudEngine *e, int cue, int row)
{
    while (e->cuePos < cue || e->rowIndex < row) {
        chase_row(e);
        e->pendingOrderJump = -1;
        e->pendingRowJump = -1;
        e->pendingRowJumpLocal = false;
        if (e->patternDelayRemaining > 0) {
            e->patternDelayRemaining--;
            e->patternDelayActive = true;
            continue;
        }
        e->patternDelayActive = false;
        if (++e->rowIndex < te_cue_row_limit(te_cue_at(e, e->cuePos))) continue;
        if (e->cuePos >= cue || e->cuePos >= NUM_CUES - 1) return;
        e->cuePos++;
        e->rowIndex = 0;
        e->position = e->cuePos;
        te_reset_pattern_loop_state(e);
    }
}

/* Put the playhead on row `row` of cue `cue` in the state the song itself
 * arrives there with (item 215, TAUD_ENGINE_SPEC.md §15.1), ready for play.
 * Returns false when the song's own path never reaches the row and the cues
 * were walked in order instead. */
bool te_chase_tracker_row(TaudEngine *e, int cue, int row)
{
    int bpm = e->bpm, tickRate = e->tickRate, gvol = e->globalVolume, mvol = e->mixingVolume;
    bool wasPlaying = e->isPlaying, reached;
    cue &= NUM_CUES - 1;
    row = iclamp(row, 0, 63);
    /* The walk's halt test: a halt cue clears it. Set directly — te_play
     * would end a jam, which Playhead's setter does too… */
    if (!e->isPlaying && e->jamActive) {
        int i;
        for (i = 0; i < TOTAL_VOICES; i++) e->voices[i].active = false;
        for (i = 0; i < e->bgCount; i++) e->bg[i]->active = false;
        e->jamActive = false;
    }
    e->isPlaying = true;
    reset_to_song_start(e, bpm, tickRate, gvol, mvol);
    reached = chase_song_path(e, cue, row);
    if (!reached) {
        reset_to_song_start(e, bpm, tickRate, gvol, mvol);
        chase_cue_order(e, cue, row);
    }
    e->isPlaying = wasPlaying;
    e->position = cue;
    e->cuePos = cue;
    e->rowIndex = row;
    te_reset_play_state(e);
    return reached;
}
