/* Trigger path + NNA/Metainstrument machinery — port of trigger.js. */

#include <string.h>

#include "taud_internal.h"

/* What the INSTRUMENT left on the note-pan axis for the trigger just run:
 * [notePan, noteElevation, present]. Read only by triggerMetaOrNote. */
typedef struct { double pan, elevation; bool present; } NotePanSeed;

static void trigger_note_seed(TaudEngine *e, TaudVoice *v, double noteVal, int instId, int volOverride, NotePanSeed *seed,
                              const TaudFormantPatch *lyricPatch);

void te_apply_active_sample(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch);

static void resolve_active_envelopes(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch)
{
    const TaudEnvPoint *pitEnv = inst->pfEnvelopes, *filEnv = inst->pfEnvelopes;
    int pitLoop = 0, pitSus = 0, filLoop = 0, filSus = 0;
    bool pitOn = false, filOn = false;

    if (patch != NULL && patch->hasVolEnv) {
        v->activeVolEnv = patch->volEnv;
        v->activeVolEnvLoop = patch->volEnvLoop;
        v->activeVolEnvSustain = patch->volEnvSustain;
    } else {
        v->activeVolEnv = inst->volEnvelopes;
        v->activeVolEnvLoop = inst->volEnvLoop;
        v->activeVolEnvSustain = inst->volEnvSustainWord;
    }
    /* An Ixmp patch's volume envelope is in its instrument's units: byte 14's
     * bit 6 says whether a node's full volume is 63 or 255 (file format §7.2). */
    v->activeVolEnvMax = inst_vol_env8(inst) ? 255 : 63;
    /* The volume envelope answers to its P bit like every other envelope (spec
     * §7.2): a record that says "absent" plays at unity whatever its nodes hold. */
    v->hasVolEnv = te_env_present(v->activeVolEnvLoop);
    if (patch != NULL && patch->hasPanEnv) {
        v->activePanEnv = patch->panEnv;
        v->activePanEnvLoop = patch->panEnvLoop;
        v->activePanEnvSustain = patch->panEnvSustain;
    } else {
        v->activePanEnv = inst->panEnvelopes;
        v->activePanEnvLoop = inst->panEnvLoop;
        v->activePanEnvSustain = inst->panEnvSustainWord;
    }

    if (te_env_present(inst->pfEnvLoop)) {
        if (((inst->pfEnvLoop >> 7) & 1) != 0) {
            filEnv = inst->pfEnvelopes; filLoop = inst->pfEnvLoop; filSus = inst->pfEnvSustainWord; filOn = true;
        } else {
            pitEnv = inst->pfEnvelopes; pitLoop = inst->pfEnvLoop; pitSus = inst->pfEnvSustainWord; pitOn = true;
        }
    }
    if (te_env_present(inst->pf2EnvLoop)) {
        if (((inst->pf2EnvLoop >> 7) & 1) != 0) {
            filEnv = inst->pf2Envelopes; filLoop = inst->pf2EnvLoop; filSus = inst->pf2EnvSustainWord; filOn = true;
        } else {
            pitEnv = inst->pf2Envelopes; pitLoop = inst->pf2EnvLoop; pitSus = inst->pf2EnvSustainWord; pitOn = true;
        }
    }
    if (patch != NULL && patch->hasPitchEnv) {
        pitEnv = patch->pitchEnv; pitLoop = patch->pitchEnvLoop; pitSus = patch->pitchEnvSustain;
        pitOn = te_env_present(patch->pitchEnvLoop);
    }
    if (patch != NULL && patch->hasFilterEnv) {
        filEnv = patch->filterEnv; filLoop = patch->filterEnvLoop; filSus = patch->filterEnvSustain;
        filOn = te_env_present(patch->filterEnvLoop);
    }
    v->activePitchEnv = pitEnv; v->activePitchEnvLoop = pitLoop;
    v->activePitchEnvSustain = pitSus; v->hasPitchEnv = pitOn;
    v->activeFilterEnv = filEnv; v->activeFilterEnvLoop = filLoop;
    v->activeFilterEnvSustain = filSus; v->hasFilterEnv = filOn;

    if (patch != NULL && patch->hasExtra) {
        v->activeFadeoutStep = patch->fadeoutStep;
        v->filterSfMode = patch->filterSfMode;
        v->activeDefaultCutoff = patch->extraCutoff;
        v->activeDefaultResonance = patch->extraResonance;
        v->activeAttenGain = te_atten_gain_of(patch->extraInitialAttenOctet);
    } else {
        v->activeFadeoutStep = inst->volumeFadeoutLow | ((inst->fadeoutHigh & 0x0f) << 8);
        v->filterSfMode = inst_filter_sf_mode(inst);
        v->activeDefaultCutoff = inst_default_cutoff16(inst);
        v->activeDefaultResonance = inst_default_resonance16(inst);
        v->activeAttenGain = te_atten_gain_of(inst->initialAttenOctet);
    }
}

void te_apply_active_sample(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch)
{
    v->activePatchIndex = patch == NULL || inst->extraPatches == NULL ? -1 : (int)(patch - inst->extraPatches);
    if (patch == NULL) {
        v->activeSamplePtr = inst->samplePtr;
        v->activeSampleLength = inst->sampleLength;
        v->activeSamplePlayStart = inst->samplePlayStart;
        v->activeSampleLoopStart = inst->sampleLoopStart;
        v->activeSampleLoopEnd = inst->sampleLoopEnd;
        /* An OPL or PSG instrument's rate is its C2SPD; 0 plays at the
         * tracker convention (§7.8, §7.9) — the pitch has to come from
         * somewhere. */
        v->activeSamplingRate = inst_is_chip(inst) && inst->samplingRate == 0 ? OPL_C4_RATE : inst->samplingRate;
        v->activeSampleDetune = inst_sample_detune_signed(inst) + inst->dSampleDetune;
        v->activeLoopMode = inst->loopMode;
        v->activeVibratoSpeed = inst->vibratoSpeed;
        v->activeVibratoSweep = inst->vibratoSweep;
        v->activeVibratoDepth = inst->vibratoDepth;
        v->activeVibratoRate = inst->vibratoRate;
        v->activeVibratoWaveform = inst_vibrato_waveform(inst);
        v->activeChanCount = 1;
        v->activeChanMode = 0;
        v->activeChanPtr2 = 0;
    } else {
        bool vibDefer = te_patch_vibrato_inherits(patch);
        v->activeSamplePtr = patch->samplePtr;
        v->activeSampleLength = patch->sampleLength;
        v->activeSamplePlayStart = patch->playStart;
        v->activeSampleLoopStart = patch->loopStart;
        v->activeSampleLoopEnd = patch->loopEnd;
        v->activeSamplingRate = patch->samplingRate;
        v->activeSampleDetune = patch->sampleDetune + patch->dDetune;
        v->activeLoopMode = patch->loopMode;
        v->activeVibratoSpeed = vibDefer ? inst->vibratoSpeed : patch->vibratoSpeed;
        v->activeVibratoSweep = vibDefer ? inst->vibratoSweep : patch->vibratoSweep;
        v->activeVibratoDepth = vibDefer ? inst->vibratoDepth : patch->vibratoDepth;
        v->activeVibratoRate = vibDefer ? inst->vibratoRate : patch->vibratoRate;
        v->activeVibratoWaveform = patch->vibratoWaveform == 0xff ? inst_vibrato_waveform(inst) : patch->vibratoWaveform;
        if (te_patch_is_stereo(patch)) {
            v->activeChanCount = 2;
            v->activeChanMode = patch->chanMode;
            v->activeChanPtr2 = patch->chanPtrs[0];
        } else {
            v->activeChanCount = 1;
            v->activeChanMode = 0;
            v->activeChanPtr2 = 0;
        }
    }
    resolve_active_envelopes(v, inst, patch);
}

int te_row_volume_from_default(const TaudInst *inst, const TaudPatch *patch, int volMax)
{
    int dnv = patch != NULL && patch->defaultNoteVolume != 0 ? patch->defaultNoteVolume : inst->defaultNoteVolume;
    if (dnv == 0) return volMax;
    return volMax == 0xff ? dnv : (dnv * 63 + 127) / 255;
}

/* Drop bg[idx] on the spot — and, for a ghosted rack, its operands too. */
static void drop_background_voice(TaudEngine *e, int idx)
{
    TaudVoice *culled = e->bg[idx];
    int i;
    culled->active = false;
    te_bg_remove_at(e, idx);
    if (culled->fmRig != NULL) {
        for (i = e->bgCount - 1; i >= 0; i--) {
            TaudVoice *bg = e->bg[i];
            if (!bg->fmOperator || bg->fmParent != culled) continue;
            bg->active = false;
            bg->fmOperator = false;
            bg->fmParent = NULL;
            bg->isLayerChild = false;
            te_bg_remove_at(e, i);
        }
    }
}

/* Already on its way out: no longer counts towards the cap. */
static inline bool bg_leaving(const TaudVoice *v)
{
    return !v->active || v->rampOutSamples > 0 ||
        (v->fmOperator && v->fmParent != NULL && v->fmParent->rampOutSamples > 0);
}

/* Cap the pool at MAX_BG_VOICES SOUNDING voices (trigger.js
 * capBackgroundVoices): the evicted voice is ramped out, not dropped; a hard
 * drop only past twice the cap. */
void te_cap_background_voices(TaudEngine *e)
{
    int live = 0, i;
    for (i = 0; i < e->bgCount; i++) if (!bg_leaving(e->bg[i])) live++;
    while (live > MAX_BG_VOICES) {
        int idx = -1;
        TaudVoice *culled;
        for (i = 0; i < e->bgCount; i++) {
            const TaudVoice *v = e->bg[i];
            if (!bg_leaving(v) && !v->isLayerChild && !v->fmOperator) { idx = i; break; }
        }
        if (idx < 0) for (i = 0; i < e->bgCount; i++) if (!bg_leaving(e->bg[i]) && !e->bg[i]->fmOperator) { idx = i; break; }
        if (idx < 0) for (i = 0; i < e->bgCount; i++) if (!bg_leaving(e->bg[i])) { idx = i; break; }
        culled = e->bg[idx];
        if (culled->fmOperator) {
            drop_background_voice(e, idx);
            live--;
            continue;
        }
        te_start_cut_ramp(e, culled);
        live--;
        if (culled->fmRig != NULL) {
            for (i = 0; i < e->bgCount; i++) {
                const TaudVoice *bg = e->bg[i];
                if (bg->fmOperator && bg->fmParent == culled && bg->active) live--;
            }
        }
    }
    while (e->bgCount > 2 * MAX_BG_VOICES) {
        int idx = -1;
        for (i = 0; i < e->bgCount; i++) if (!e->bg[i]->isLayerChild && !e->bg[i]->fmOperator) { idx = i; break; }
        if (idx < 0) for (i = 0; i < e->bgCount; i++) if (!e->bg[i]->fmOperator) { idx = i; break; }
        if (idx < 0) idx = 0;
        drop_background_voice(e, idx);
    }
}

static void release_layer_children(TaudEngine *e, int vi)
{
    int override = e->voices[vi].nnaOverride, i;
    for (i = 0; i < e->bgCount; i++) {
        TaudVoice *bg = e->bg[i];
        int nna;
        if (!bg->isLayerChild || bg->sourceChannel != vi) continue;
        if (bg->fmOperator) continue;
        bg->isLayerChild = false;
        bg->layerPitchMod = 0;
        nna = override >= 0 ? override : inst_new_note_action(&e->instruments[bg->instrumentId]);
        switch (nna) {
        case 0:
        case 4:
            if (!bg->keyOff) { bg->keyOff = true; te_apply_key_lift(bg, &e->instruments[bg->instrumentId]); }
            break;
        case 1: te_start_cut_ramp(e, bg); break; /* ramped out, as layer 0's ghost is */
        case 3: bg->noteFading = true; break;
        default: break;
        }
    }
}

void te_cut_layer_children(TaudEngine *e, int vi)
{
    int i;
    for (i = 0; i < e->bgCount; i++) {
        if (te_is_sounding_child(e, e->bg[i], vi)) te_start_cut_ramp(e, e->bg[i]);
    }
}

static inline double pitch_of(const TaudMetaLayer *l, double noteVal)
{
    return dclamp(te_layer_note(l, noteVal), 0x20, 0xffff);
}
/* What pitch_of had to leave out: the part of an entry's pitch that lies
 * outside a note value's sixteen octaves (voice.pitchExcess). */
static inline double excess_of(const TaudMetaLayer *l, double noteVal)
{
    double full = te_layer_note(l, noteVal);
    return full - dclamp(full, 0x20, 0xffff);
}

static void seed_child_lane_context(TaudVoice *child, const TaudVoice *voice, int chanPan, int chanRowPan,
                                    int chanPanbrello, double chanAzimuth, double chanElevation)
{
    child->channelVolume = voice->channelVolume;
    child->channelVolumeSet = voice->channelVolumeSet;
    child->channelPanSet = voice->channelPanSet;
    child->channelPan = chanPan;
    child->rowPan = chanRowPan;
    child->panbrelloOffset = chanPanbrello;
    child->panAzimuth = chanAzimuth;
    child->panElevation = chanElevation;
    child->clipMode = voice->clipMode;
    child->bitcrusherDepth = voice->bitcrusherDepth;
    child->bitcrusherSkip = voice->bitcrusherSkip;
    child->overdriveAmp = voice->overdriveAmp;
}

static void trigger_fm_rack(TaudEngine *e, TaudVoice *voice, int vi, double noteVal, const TaudInst *inst,
                            int rowVolOverride, int seedVol);

static bool fm_sounds(TaudEngine *e, const TaudMetaLayer *o, double noteVal, int seedVol)
{
    /* An operator is an ordinary instrument or a low meta (an OPL channel or
     * a PSG pair, read as the chip reads its carriers — fm.c). A high meta is
     * not: a formant instrument, a layer table or another rack is a sound
     * made OUT of sources, and taking one would be recursion (§7.4). */
    return o->instIdx >= 1 && o->instIdx <= 1023 &&
        !inst_is_meta(&e->instruments[o->instIdx]) && !inst_is_high_meta(&e->instruments[o->instIdx]) &&
        te_pitch_in_range(noteVal, o->pitchStart, o->dLo, o->pitchEnd, o->dHi) &&
        seedVol >= o->volStart && seedVol <= o->volEnd;
}

/* The syllable a trigger of a LYRIC INSTRUMENT sings on the lane whose
 * foreground voice is `voice` (spec §5.5.3, "Lyric instruments"), or NULL for
 * any other instrument. An instrument byte starts the lyrics over; every
 * trigger sings the syllable at the lane's position and moves it on, back to
 * the first after the last — unless `lyricReset` is clear: a jammed
 * note keeps the bank's place in the lyrics (te_jam_note).
 *
 * A tone portamento (G, L) that triggers only because nothing is sounding on
 * the lane — a play started after the note it glides, or a note that had run
 * out — is still that note's glide (`glide`): it says the syllable the lane's
 * note was singing again and leaves the position where it is, as a glide from
 * a sounding note does. An instrument byte still starts the lyrics over,
 * handing the note its first syllable when it was singing none of this
 * instrument's (the porta row's instrument change, row.c apply_instrument_change). */
static const TaudFormantPatch *lyric_trigger(TaudVoice *voice, const TaudInst *inst, int instId, bool lyricReset,
                                             bool glide)
{
    const TaudFormantPatch *syl;
    int n;
    if (inst->lyric == NULL) return NULL;
    n = inst->lyricEntry->numSyllables;
    if (glide) {
        const TaudFormantPatch *cur = voice->formant != NULL ? voice->formant->patch : NULL;
        int k = -1, i;
        /* JS inst.lyric.indexOf(cur): the syllable patches are this array. */
        if (cur != NULL) for (i = 0; i < n; i++) if (&inst->lyric[i] == cur) { k = i; break; }
        if (instId != 0 && lyricReset) {
            voice->lyricPos = 0;
            return k >= 0 ? cur : &inst->lyric[0];
        }
        if (k >= 0) return cur;
    }
    if ((instId != 0 && lyricReset) || voice->lyricPos >= n) voice->lyricPos = 0;
    syl = &inst->lyric[voice->lyricPos];
    voice->lyricPos = voice->lyricPos + 1 >= n ? 0 : voice->lyricPos + 1;
    return syl;
}

void te_trigger_meta_or_note(TaudEngine *e, TaudVoice *voice, int vi, double noteVal, int instId, int rowVolOverride,
                             bool lyricReset, bool glide)
{
    const TaudInst *inst;
    const TaudMetaLayer *layers[META_MAX_LAYERS];
    const TaudMetaLayer *l0;
    int nLayers, gateVol, seedVol, k;
    int chanPan, chanRowPan, chanPanbrello;
    double chanAzimuth, chanElevation, l0Pan, l0Elevation;
    bool l0HasPan;
    NotePanSeed seed;

    if (instId != 0) voice->displayInst = instId;
    /* A note on an instrument with a mixing chain (item 217): its bus restarts
     * the LFOs that retrigger on a note, at the top of the span this lands in. */
    e->imixTrig[(voice->displayInst != 0 ? voice->displayInst : voice->instrumentId) & 0x3ff] = 1;
    release_layer_children(e, vi);
    te_drop_fm_operators(e, vi);
    inst = instId != 0 ? &e->instruments[instId] : &e->instruments[voice->instrumentId];
    if (!inst_is_meta(inst)) {
        te_trigger_note(e, voice, noteVal, instId, rowVolOverride, lyric_trigger(voice, inst, instId, lyricReset, glide));
        voice->layerMixGain = 1.0;
        voice->layerRelDetune = 0;
        voice->layerFixedNote = -1;
        voice->layerRelPan = 0;
        voice->layerRelElevation = 0;
        voice->isLayerChild = false;
        return;
    }
    gateVol = e->ts_wideCells ? asr32(rowVolOverride, 2) : rowVolOverride;
    seedVol = gateVol >= 0 && gateVol <= 0x3f ? gateVol : 0x3f;
    if (inst_is_fm(inst)) {
        trigger_fm_rack(e, voice, vi, noteVal, inst, rowVolOverride, seedVol);
        return;
    }
    /* A table of a kind this engine does not know sounds nothing (§7.4): its
     * entries have the Layered shape, but what they mean is the kind's. */
    if (inst->meta->type != META_TYPE_LAYERED) {
        voice->active = false;
        voice->layerMixGain = 1.0;
        voice->layerRelDetune = 0;
        voice->layerFixedNote = -1;
        return;
    }
    nLayers = te_inst_resolve_meta_layers(inst, noteVal, seedVol, layers);
    if (inst->meta->strict) {
        int n = 0;
        for (k = 0; k < nLayers; k++) {
            const TaudMetaLayer *l = layers[k];
            if (te_inst_resolve_patch(&e->instruments[l->instIdx], pitch_of(l, noteVal), seedVol) != NULL) layers[n++] = l;
        }
        nLayers = n;
    }
    if (nLayers == 0) {
        voice->active = false;
        voice->layerMixGain = 1.0;
        voice->layerRelDetune = 0;
        voice->layerFixedNote = -1;
        return;
    }
    l0 = layers[0];
    chanPan = voice->channelPan; chanRowPan = voice->rowPan;
    chanPanbrello = voice->panbrelloOffset;
    chanAzimuth = voice->panAzimuth; chanElevation = voice->panElevation;
    trigger_note_seed(e, voice, pitch_of(l0, noteVal), l0->instIdx, rowVolOverride, &seed, NULL);
    l0HasPan = seed.present;
    l0Pan = l0HasPan ? seed.pan : 0;
    l0Elevation = l0HasPan ? seed.elevation : 0;
    voice->layerMixGain = META_MIX_GAIN[l0->mixOctet & 0xff];
    voice->layerRelDetune = 0;
    voice->layerFixedNote = l0->fixedPitch ? pitch_of(l0, noteVal) : -1;
    voice->pitchExcess = excess_of(l0, noteVal);
    voice->layerRelPan = 0;
    voice->layerRelElevation = 0;
    voice->isLayerChild = false;
    voice->metaForeground = true;
    voice->metaForegroundDetune = l0->detune + l0->dDetune;
    for (k = 1; k < nLayers; k++) {
        const TaudMetaLayer *lk = layers[k];
        TaudVoice *child = te_voice_alloc(e);
        if (child == NULL) break;
        seed_child_lane_context(child, voice, chanPan, chanRowPan, chanPanbrello, chanAzimuth, chanElevation);
        trigger_note_seed(e, child, pitch_of(lk, noteVal), lk->instIdx, rowVolOverride, &seed, NULL);
        child->isLayerChild = true;
        child->sourceChannel = vi;
        child->displayInst = voice->displayInst;
        child->layerRelDetune = te_layer_note(lk, noteVal) - te_layer_note(l0, noteVal);
        child->layerFixedNote = lk->fixedPitch ? pitch_of(lk, noteVal) : -1;
        child->pitchExcess = excess_of(lk, noteVal);
        if (seed.present) {
            child->layerRelPan = seed.pan - l0Pan;
            child->layerRelElevation = seed.elevation - l0Elevation;
        } else {
            child->layerRelPan = 0;
            child->layerRelElevation = 0;
        }
        child->notePan = te_bound_note_pan(e, voice->notePan + child->layerRelPan);
        child->noteElevation = voice->noteElevation + child->layerRelElevation;
        child->layerMixGain = META_MIX_GAIN[lk->mixOctet & 0xff];
        te_bg_push(e, child);
    }
    te_cap_background_voices(e);
}

static void trigger_fm_rack(TaudEngine *e, TaudVoice *voice, int vi, double noteVal, const TaudInst *inst,
                            int rowVolOverride, int seedVol)
{
    const TaudMeta *meta = inst->meta;
    const TaudMetaLayer *ops = meta->layers;
    uint8_t referenced[FM_MAX_OPERATORS];
    TaudFmRig *rig;
    int chanPan, chanRowPan, chanPanbrello, k;
    double chanAzimuth, chanElevation;

    if (!meta->hasProgram || !fm_sounds(e, &ops[0], noteVal, seedVol)) {
        voice->active = false;
        voice->fmRig = NULL;
        voice->layerMixGain = 1.0;
        voice->layerRelDetune = 0;
        voice->layerFixedNote = -1;
        return;
    }
    te_fm_referenced_operators(meta->program, meta->programLen, meta->count, referenced);

    chanPan = voice->channelPan; chanRowPan = voice->rowPan;
    chanPanbrello = voice->panbrelloOffset;
    chanAzimuth = voice->panAzimuth; chanElevation = voice->panElevation;
    /* What each operator SOUNDS: the trigger at its ratio, or a FIXED-
     * frequency operator's own note (item 278, the DX7's FIXED mode). */
    te_trigger_note(e, voice, pitch_of(&ops[0], noteVal), ops[0].instIdx, rowVolOverride, NULL);
    voice->layerMixGain = 1.0;
    voice->layerRelDetune = 0;
    voice->layerFixedNote = ops[0].fixedPitch ? pitch_of(&ops[0], noteVal) : -1;
    voice->pitchExcess = excess_of(&ops[0], noteVal);
    voice->layerRelPan = 0;
    voice->layerRelElevation = 0;
    voice->isLayerChild = false;
    voice->metaForeground = true;
    voice->metaForegroundDetune = ops[0].detune + ops[0].dDetune;

    /* The rig is built after the trigger (which drops any previous one); the
     * JS builds it before, but nothing in between reads it. */
    rig = &voice->rigStore;
    te_fm_rig_init(rig, meta->count);
    rig->program = meta->program;
    rig->programLen = meta->programLen;
    te_fm_seed_gains(rig, meta);
    voice->fmRig = rig;
    rig->voices[0] = voice;

    for (k = 1; k < meta->count; k++) {
        TaudVoice *op;
        if (referenced[k] == 0 || !fm_sounds(e, &ops[k], noteVal, seedVol)) continue;
        op = te_voice_alloc(e);
        if (op == NULL) break;
        seed_child_lane_context(op, voice, chanPan, chanRowPan, chanPanbrello, chanAzimuth, chanElevation);
        /* Its filter runs at the rack's rate (fm.c): said before the trigger
         * makes the first coefficients. */
        op->filterOversample = e->fmOversample;
        te_trigger_note(e, op, pitch_of(&ops[k], noteVal), ops[k].instIdx, rowVolOverride, NULL);
        op->isLayerChild = true;
        op->fmOperator = true;
        op->fmParent = voice;
        op->sourceChannel = vi;
        op->displayInst = voice->displayInst;
        op->layerRelDetune = te_layer_note(&ops[k], noteVal) - te_layer_note(&ops[0], noteVal);
        op->layerFixedNote = ops[k].fixedPitch ? pitch_of(&ops[k], noteVal) : -1;
        op->pitchExcess = excess_of(&ops[k], noteVal);
        op->layerMixGain = 1.0;
        op->layerRelPan = 0;
        op->layerRelElevation = 0;
        op->notePan = voice->notePan;
        op->noteElevation = voice->noteElevation;
        rig->voices[k] = op;
        te_bg_push(e, op);
    }
    te_cap_background_voices(e);
}

int te_narrow_vol_axis(const TaudEngine *e, int v)
{
    return iclamp(e->ts_wideCells ? asr32(v, 2) : v, 0, 0x3f);
}

void te_trigger_note(TaudEngine *e, TaudVoice *voice, double noteVal, int instId, int volOverride,
                     const TaudFormantPatch *lyricPatch)
{
    NotePanSeed seed;
    trigger_note_seed(e, voice, noteVal, instId, volOverride, &seed, lyricPatch);
}

static void trigger_note_seed(TaudEngine *e, TaudVoice *voice, double noteVal, int instId, int volOverride, NotePanSeed *seed,
                              const TaudFormantPatch *lyricPatch)
{
    bool mayCarry = voice->active && !voice->keyOff && !voice->noteFading &&
        (instId == 0 || instId == voice->instrumentId);
    /* An OPL channel handed over by te_maybe_spawn_background_for_nna (a
     * retrigger the New Note Action cuts) keeps its envelopes, as the chip
     * does — read before anything below marks the voice active. */
    bool oplCarry = voice->oplCarry && voice->active && voice->opl != NULL;
    /* …and a PSG pair handed over the same way keeps its envelopes too. */
    bool psgCarry = voice->psgCarry && voice->active && voice->psg != NULL;
    const TaudInst *inst;
    const TaudInst *formantChip;
    const TaudPatch *patch;
    int seedVolForLookup;

    voice->oplCarry = false;
    voice->psgCarry = false;
    voice->pitchExcess = 0.0;   /* a layer's or an operator's is set by its trigger, after this */

    if (instId != 0) voice->instrumentId = instId;
    inst = &e->instruments[voice->instrumentId];
    if (volOverride >= 0) seedVolForLookup = te_narrow_vol_axis(e, volOverride);
    else if (instId != 0) seedVolForLookup = te_row_volume_from_default(inst, NULL, 0x3f);
    else seedVolForLookup = te_narrow_vol_axis(e, voice->noteVolume);
    patch = te_inst_resolve_patch(inst, noteVal, seedVolForLookup);
    te_apply_active_sample(voice, inst, patch);
    /* A formant instrument sung from a chip instrument (§7.6) takes the
     * chip's C2SPD where its sample's rate would be: the pitch is the chip's. */
    formantChip = inst->formant != NULL ? te_formant_chip_source(e, inst) : NULL;
    if (formantChip != NULL) voice->activeSamplingRate = te_formant_chip_rate(formantChip);
    voice->tonePortaTarget = -1;
    voice->samplePos = voice->activeSamplePlayStart;
    voice->forward = true;
    voice->active = true;
    voice->keyOff = false;
    if (!(mayCarry && te_env_carry(voice->activeVolEnvLoop))) {
        voice->envIndex = 0;
        voice->envTimeSec = 0.0;
        voice->envVolume = dclamp(voice->activeVolEnv[0].value / (double)voice->activeVolEnvMax, 0.0, 1.0);
        voice->envVolMix = voice->envVolume;
        voice->envVolStep = 0.0;
    }
    voice->hasPanEnv = te_env_present(voice->activePanEnvLoop);
    if (!(mayCarry && te_env_carry(voice->activePanEnvLoop))) {
        voice->envPanIndex = 0;
        voice->envPanTimeSec = 0.0;
        voice->envPan = voice->activePanEnv[0].value / 255.0;
    }
    if (!voice->hasPitchEnv) {
        voice->envPitchValue = 0.5; voice->envPitchIndex = 0; voice->envPitchTimeSec = 0.0;
    } else if (!(mayCarry && te_env_carry(voice->activePitchEnvLoop))) {
        voice->envPitchValue = te_seed_pf_role(voice->activePitchEnv, voice->activePitchEnvLoop,
            voice->activePitchEnvSustain, &voice->envPitchIndex, &voice->envPitchTimeSec);
    }
    if (!voice->hasFilterEnv) {
        voice->envFilterValue = 0.5; voice->envFilterIndex = 0; voice->envFilterTimeSec = 0.0;
    } else if (!(mayCarry && te_env_carry(voice->activeFilterEnvLoop))) {
        voice->envFilterValue = te_seed_pf_role(voice->activeFilterEnv, voice->activeFilterEnvLoop,
            voice->activeFilterEnvSustain, &voice->envFilterIndex, &voice->envFilterTimeSec);
    }
    voice->fadeoutVolume = 1.0;
    voice->fadeoutMix = 1.0;
    voice->fadeoutMixStep = 0.0;
    voice->rampOutSamples = 0;
    voice->rampOutGain = 0.0;
    /* Not on an OPL or PSG voice: its attack IS the chip's envelope. */
    voice->attackRampSamples = inst_is_chip(inst) ? 0 : e->attackRampSamples;
    voice->autoVibPhase = 0;
    voice->autoVibTicksSinceTrigger = 0;
    voice->nesDpcmCounter = 63;
    memset(&voice->right, 0, sizeof voice->right);
    voice->right.nesDpcmCounter = 63;
    voice->invertWritePos = 0;
    voice->funkWalk = -1;
    voice->funkPos = -1;
    voice->funkWindow = -1;
    voice->funkXfade = 0;
    voice->modFunkWindow = -1;
    voice->modFunkXfade = 0;
    voice->randomVolBias = inst->volumeSwing != 0
        ? (int)(te_random(e) * (2 * inst->volumeSwing + 1)) - inst->volumeSwing : 0;
    voice->randomPanBias = inst->panSwing != 0
        ? (int)(te_random(e) * (2 * inst->panSwing + 1)) - inst->panSwing : 0;

    seed->present = false;
    seed->pan = 0;
    seed->elevation = 0;
    if (instId != 0) {
        if (patch != NULL && patch->defaultPan != 0xff) {
            te_apply_note_pan_set(e, voice, patch->defaultPan);
            seed->present = true;
        } else if (((voice->activePanEnvLoop >> 7) & 1) != 0) {
            seed->present = true;
            if (e->ts_surroundModel == SURROUND_STEREO) {
                te_apply_note_pan_set(e, voice, inst->defaultPan);
            } else {
                te_apply_note_pan_set(e, voice, inst_default_azimuth(inst));
                te_apply_note_elevation(e, voice, inst_default_elevation(inst));
            }
        }
        if (inst->pitchPanSeparation != 0) {
            double noteDelta = (noteVal - (inst->pitchPanCentre + inst->dPitchPanCentre)) / 4096.0;
            double panShift = trunc(noteDelta * inst->pitchPanSeparation * 4.0);
            te_apply_note_pan_slide(e, voice, panShift);
            seed->present = true;
        }
        seed->pan = voice->notePan;
        seed->elevation = voice->noteElevation;
    }
    voice->currentCutoff = voice->activeDefaultCutoff;
    voice->currentResonance = voice->activeDefaultResonance;
    voice->filterY1 = 0.0; voice->filterY2 = 0.0; voice->filterX1 = 0.0; voice->filterX2 = 0.0;
    voice->filterCutoffCached = -1;
    voice->filterResonanceCached = -1;
    voice->sfCents = NAN; voice->sfCentsLeft = 0; voice->sfQLeft = 0; /* a new note's filter lands at once */
    voice->noteVal = noteVal;
    voice->basePitch = noteVal;
    voice->renderPitch = noteVal;
    voice->amigaPeriod = -1.0;
    voice->linearFreq = -1.0;
    voice->playbackRate = te_compute_playback_rate(e, voice, noteVal, e->tuningRatio);
    if (volOverride >= 0) voice->noteVolume = iclamp(volOverride, 0, e->volMax);
    else if (instId != 0) voice->noteVolume = te_row_volume_from_default(inst, patch, e->volMax);
    voice->rowVolume = voice->noteVolume;
    voice->snapMixVolume = true;
    voice->volRampSamples = 0;
    voice->volRampStep = 0.0;
    voice->snapPlaybackRate = true;
    voice->snapPan = true;
    /* …and at its lane's fader and elevation: a fresh note has no waveform
     * for a jump to click in. */
    voice->elevCur = NAN;
    voice->faderCur = NAN;
    voice->noteWasCut = false;
    voice->noteFading = false;
    voice->nnaOverride = -1;
    voice->volEnvOn = true;
    voice->panEnvOn = true;
    voice->pitchEnvOn = true;
    voice->filterEnvOn = true;
    voice->metaForeground = false;
    voice->metaForegroundDetune = 0;
    voice->fmRig = NULL;
    /* The OPL channel (item 209): keyed on here, carried or fresh. */
    if (inst->opl != NULL) {
        if (voice->opl == NULL) { voice->opl = &voice->oplStore; te_opl_state_init(voice->opl); }
        te_opl_key_on(voice->opl, inst->opl, oplCarry);
    } else {
        voice->opl = NULL;
    }
    /* The PSG pair (§7.9): keyed on here, carried or fresh, the voice's own
     * state reused — which keeps an oscillator's internal status from note to
     * note on the lane, unless its X flag resets it at this key-on. */
    if (inst->psg != NULL) {
        if (voice->psg == NULL) { voice->psg = &voice->psgStore; te_psg_state_init(voice->psg); }
        te_psg_key_on(voice->psg, inst->psg, psgCarry);
    } else {
        voice->psg = NULL;
    }
    /* A formant instrument (item 212): every trigger is a fresh syllable. */
    if (inst->formant != NULL) {
        if (voice->formant == NULL) { voice->formant = &voice->formantStore; te_formant_state_init(voice->formant); }
        /* A lyric instrument's note sings the syllable its trigger chose. */
        te_formant_note_on(e, voice->formant, lyricPatch != NULL ? lyricPatch : inst->formant, false);
        te_formant_key_source(voice->formant, formantChip);
    } else {
        voice->formant = NULL;
    }
    if (voice->vibratoRetrig) voice->vibratoLfoPos = 0;
    if (voice->tremoloRetrig) voice->tremoloLfoPos = 0;
    if (voice->panbrelloRetrig) voice->panbrelloLfoPos = 0;
}

/* What a trigger of (instId, note) sounds on the foreground voice: only an FM
 * rack shifts it, to operator 0's instrument and detune. */
static void principal_of(TaudEngine *e, int instId, double note, int *outInst, double *outNote)
{
    const TaudInst *inst = &e->instruments[instId];
    const TaudMetaLayer *op0;
    *outInst = instId;
    *outNote = note;
    if (!inst_is_fm(inst) || inst->meta->count == 0) return;
    op0 = &inst->meta->layers[0];
    if (op0->instIdx < 1 || op0->instIdx > 1023) return;
    *outInst = op0->instIdx;
    *outNote = dclamp(te_layer_note(op0, note), 0x20, 0xffff);
}

typedef struct { int newInstId; double newNote; uint32_t newSmpPtr; int newSmpLen; } DupKey;

static bool is_duplicate(TaudEngine *e, const TaudVoice *v, const DupKey *k, bool bare)
{
    const TaudInst *existInst = &e->instruments[v->instrumentId];
    const TaudInst *newInst = &e->instruments[k->newInstId];
    /* A voice already ramping out is already gone; a formant voice already
     * into its coda is no duplicate: what the check ends is the VOWEL. */
    if (v->rampOutSamples > 0) return false;
    if (v->formant != NULL && v->formant->phase >= PHASE_CODA) return false;
    if (bare && inst_dup_check_type(existInst) != DCT_LANE) return false;
    switch (inst_dup_check_type(existInst)) {
    case 1: return v->noteVal == k->newNote && v->instrumentId == k->newInstId;
    case 2:
        /* Formant instruments' "sample" is the pool range they are made from. */
        if (v->formant != NULL && existInst->formant != NULL && newInst->formant != NULL) {
            return existInst->formant->rangeLo == newInst->formant->rangeLo &&
                   existInst->formant->rangeHi == newInst->formant->rangeHi;
        }
        return v->instrumentId == k->newInstId && v->activeSamplePtr == k->newSmpPtr &&
               v->activeSampleLength == k->newSmpLen;
    case 3: return v->instrumentId == k->newInstId;
    case DCT_LANE: return true;
    default: return false;
    }
}

static TaudVoice *ghost_rig(TaudEngine *e, TaudVoice *voice, int channel);

static void apply_dup_action(TaudEngine *e, TaudVoice *v, bool isFg, int channel)
{
    const TaudInst *existInst = &e->instruments[v->instrumentId];
    switch (inst_dup_check_action(existInst)) {
    case 0: {
        /* Ramped out over the incoming note's attack — the foreground voice
         * through a ghost, since the note is about to reuse it — as a New
         * Note Action's cut is. */
        TaudVoice *r = isFg ? ghost_rig(e, v, channel) : v;
        if (r != NULL) te_start_cut_ramp(e, r);
        if (isFg) { v->active = false; te_cap_background_voices(e); }
        break;
    }
    case 1: v->keyOff = true; te_apply_key_lift(v, existInst); break;
    case 2: v->noteFading = true; break;
    default: break;
    }
}

void te_apply_duplicate_check(TaudEngine *e, int channel, int instId, double note)
{
    DupKey k;
    const TaudInst *newInst;
    const TaudPatch *newPatch;
    TaudVoice *fg;
    int i;
    /* Type 4, Lane (item 216): a note with no instrument byte is checked too,
     * against the lane's instrument; types 1-3 ask only about a named one. */
    bool bare = instId == 0;
    if (bare) instId = e->voices[channel].instrumentId;
    if (instId == 0) return;
    principal_of(e, instId, note, &k.newInstId, &k.newNote);
    newInst = &e->instruments[k.newInstId];
    newPatch = te_inst_resolve_patch(newInst, k.newNote, 0x3f);
    k.newSmpPtr = newPatch != NULL ? newPatch->samplePtr : newInst->samplePtr;
    k.newSmpLen = newPatch != NULL ? newPatch->sampleLength : newInst->sampleLength;

    fg = &e->voices[channel];
    if (fg->active && inst_dup_check_type(&e->instruments[fg->instrumentId]) != 0 && is_duplicate(e, fg, &k, bare)) {
        apply_dup_action(e, fg, true, channel);
    }
    for (i = e->bgCount - 1; i >= 0; i--) {
        TaudVoice *bg = e->bg[i];
        if (bg->sourceChannel != channel || !bg->active) continue;
        if (bg->fmOperator) continue;
        if (inst_dup_check_type(&e->instruments[bg->instrumentId]) == 0) continue;
        if (!is_duplicate(e, bg, &k, bare)) continue;
        apply_dup_action(e, bg, false, channel);
        if (!bg->active) te_bg_remove_at(e, i);
    }
}

/* Snapshot the playback-relevant state of src into a fresh background voice. */
static TaudVoice *ghost_voice(TaudEngine *e, const TaudVoice *src, int channel)
{
    TaudVoice *v = te_voice_alloc(e);
    if (v == NULL) return NULL;
    v->active = true;
    v->fader = src->fader;
    v->faderCur = src->faderCur; v->faderAim = src->faderAim;
    v->faderStep = src->faderStep; v->faderLeft = src->faderLeft;
    v->elevCur = src->elevCur; v->elevAim = src->elevAim;
    v->elevStep = src->elevStep; v->elevLeft = src->elevLeft;
    v->instrumentId = src->instrumentId;
    v->displayInst = src->displayInst;
    v->samplePos = src->samplePos;
    v->playbackRate = src->playbackRate;
    v->currentPlaybackRate = src->currentPlaybackRate;
    v->currentPan = src->currentPan;
    v->forward = src->forward;
    v->noteVolume = src->noteVolume;
    v->channelVolume = src->channelVolume;
    v->channelVolumeSet = src->channelVolumeSet;
    v->channelPanSet = src->channelPanSet;
    v->rowVolume = src->rowVolume;
    v->channelPan = src->channelPan;
    v->rowPan = src->rowPan;
    v->panAzimuth = src->panAzimuth;
    v->panElevation = src->panElevation;
    v->notePan = src->notePan;
    v->noteElevation = src->noteElevation;
    v->spatialTargetAz = src->spatialTargetAz;
    v->spatialTargetEl = src->spatialTargetEl;
    v->currentMixVolume = src->currentMixVolume;
    v->attackRampSamples = src->attackRampSamples;
    v->keyOff = src->keyOff;
    v->envIndex = src->envIndex;
    v->envTimeSec = src->envTimeSec;
    v->envVolume = src->envVolume;
    v->envVolMix = src->envVolMix;
    v->envVolStep = src->envVolStep;
    v->envPanIndex = src->envPanIndex;
    v->envPanTimeSec = src->envPanTimeSec;
    v->envPan = src->envPan;
    v->hasVolEnv = src->hasVolEnv;
    v->hasPanEnv = src->hasPanEnv;
    v->hasPitchEnv = src->hasPitchEnv;
    v->envPitchIndex = src->envPitchIndex;
    v->envPitchTimeSec = src->envPitchTimeSec;
    v->envPitchValue = src->envPitchValue;
    v->hasFilterEnv = src->hasFilterEnv;
    v->envFilterIndex = src->envFilterIndex;
    v->envFilterTimeSec = src->envFilterTimeSec;
    v->envFilterValue = src->envFilterValue;
    v->fadeoutVolume = src->fadeoutVolume;
    v->fadeoutMix = src->fadeoutMix;
    v->fadeoutMixStep = src->fadeoutMixStep;
    v->autoVibPhase = src->autoVibPhase;
    v->autoVibTicksSinceTrigger = src->autoVibTicksSinceTrigger;
    v->currentCutoff = src->currentCutoff;
    v->currentResonance = src->currentResonance;
    v->filterSfMode = src->filterSfMode;
    v->filterActive = src->filterActive;
    v->filterA0 = src->filterA0;
    v->filterB0 = src->filterB0;
    v->filterB1 = src->filterB1;
    v->filterY1 = src->filterY1;
    v->filterY2 = src->filterY2;
    v->filterIsBiquad = src->filterIsBiquad;
    v->filterBqB02 = src->filterBqB02;
    v->filterBqB1 = src->filterBqB1;
    v->filterBqA1 = src->filterBqA1;
    v->filterBqA2 = src->filterBqA2;
    v->filterX1 = src->filterX1;
    v->filterX2 = src->filterX2;
    v->filterCutoffCached = src->filterCutoffCached;
    v->filterOversample = src->filterOversample;
    v->filterResonanceCached = src->filterResonanceCached;
    v->sfCents = src->sfCents; v->sfCentsIncr = src->sfCentsIncr; v->sfCentsLeft = src->sfCentsLeft;
    v->sfCentsAim = src->sfCentsAim; v->sfHzAim = src->sfHzAim; v->sfQ = src->sfQ;
    v->sfQIncr = src->sfQIncr; v->sfQLeft = src->sfQLeft; v->sfQAim = src->sfQAim;
    v->randomVolBias = src->randomVolBias;
    v->randomPanBias = src->randomPanBias;
    v->panbrelloOffset = src->panbrelloOffset;
    v->noteVal = src->noteVal;
    v->basePitch = src->basePitch;
    v->amigaPeriod = src->amigaPeriod;
    v->linearFreq = src->linearFreq;
    v->volEnvOn = src->volEnvOn;
    v->panEnvOn = src->panEnvOn;
    v->pitchEnvOn = src->pitchEnvOn;
    v->filterEnvOn = src->filterEnvOn;
    v->metaForeground = src->metaForeground;
    v->metaForegroundDetune = src->metaForegroundDetune;
    v->noteFading = src->noteFading;
    v->layerMixGain = src->layerMixGain;
    v->layerRelPan = src->layerRelPan;
    v->layerRelElevation = src->layerRelElevation;
    v->clipMode = src->clipMode;
    v->bitcrusherDepth = src->bitcrusherDepth;
    v->bitcrusherSkip = src->bitcrusherSkip;
    v->bitcrusherCounter = src->bitcrusherCounter;
    v->bitcrusherHeld = src->bitcrusherHeld;
    v->overdriveAmp = src->overdriveAmp;
    v->sourceChannel = channel;
    v->activeSamplePtr = src->activeSamplePtr;
    v->activeSampleLength = src->activeSampleLength;
    v->activeSamplePlayStart = src->activeSamplePlayStart;
    v->activeSampleLoopStart = src->activeSampleLoopStart;
    v->activeSampleLoopEnd = src->activeSampleLoopEnd;
    v->activeSamplingRate = src->activeSamplingRate;
    v->activeSampleDetune = src->activeSampleDetune;
    v->pitchExcess = src->pitchExcess;
    v->activeLoopMode = src->activeLoopMode;
    v->funkWindow = src->funkWindow;
    v->modFunkWindow = src->modFunkWindow;
    v->activeVibratoSpeed = src->activeVibratoSpeed;
    v->activeVibratoSweep = src->activeVibratoSweep;
    v->activeVibratoDepth = src->activeVibratoDepth;
    v->activeVibratoRate = src->activeVibratoRate;
    v->activeVibratoWaveform = src->activeVibratoWaveform;
    v->activePatchIndex = src->activePatchIndex;
    v->activeChanCount = src->activeChanCount;
    v->activeChanMode = src->activeChanMode;
    v->activeChanPtr2 = src->activeChanPtr2;
    v->right = src->right;
    v->activeVolEnv = src->activeVolEnv;
    v->activeVolEnvLoop = src->activeVolEnvLoop;
    v->activeVolEnvSustain = src->activeVolEnvSustain;
    v->activeVolEnvMax = src->activeVolEnvMax;
    v->activePanEnv = src->activePanEnv;
    v->activePanEnvLoop = src->activePanEnvLoop;
    v->activePanEnvSustain = src->activePanEnvSustain;
    v->activePitchEnv = src->activePitchEnv;
    v->activePitchEnvLoop = src->activePitchEnvLoop;
    v->activePitchEnvSustain = src->activePitchEnvSustain;
    v->activeFilterEnv = src->activeFilterEnv;
    v->activeFilterEnvLoop = src->activeFilterEnvLoop;
    v->activeFilterEnvSustain = src->activeFilterEnvSustain;
    v->activeFadeoutStep = src->activeFadeoutStep;
    v->activeDefaultCutoff = src->activeDefaultCutoff;
    v->activeDefaultResonance = src->activeDefaultResonance;
    v->activeAttenGain = src->activeAttenGain;
    /* An OPL channel is the voice's whole sound and state: the ghost takes a
     * copy, clock and envelopes and all. A formant ghost keeps saying the
     * syllable it was saying, into its coda once released. */
    if (src->opl != NULL) { v->oplStore = src->oplStore; v->opl = &v->oplStore; }
    if (src->psg != NULL) { v->psgStore = src->psgStore; v->psg = &v->psgStore; }
    if (src->formant != NULL) { v->formantStore = src->formantStore; v->formant = &v->formantStore; }
    return v;
}

/* Ghost `voice` into the background pool — and, for an FM rack, its operands. */
static TaudVoice *ghost_rig(TaudEngine *e, TaudVoice *voice, int channel)
{
    TaudVoice *bg = ghost_voice(e, voice, channel);
    const TaudFmRig *rig;
    TaudFmRig *copy;
    int k;
    if (bg == NULL) return NULL;
    te_bg_push(e, bg);
    rig = voice->fmRig;
    if (rig == NULL) return bg;
    copy = &bg->rigStore;
    te_fm_rig_clone(copy, rig);
    bg->fmRig = copy;
    copy->voices[0] = bg;
    for (k = 1; k < rig->count; k++) {
        const TaudVoice *src = rig->voices[k];
        TaudVoice *op;
        if (src == NULL || !src->active) continue;
        op = ghost_voice(e, src, channel);
        if (op == NULL) break;
        op->isLayerChild = true;
        op->fmOperator = true;
        op->fmParent = bg;
        op->layerRelDetune = src->layerRelDetune;
        op->layerFixedNote = src->layerFixedNote; /* a FIXED operand stays fixed (item 278) */
        op->layerPitchMod = 0;
        op->layerMixGain = src->layerMixGain;
        copy->voices[k] = op;
        te_bg_push(e, op);
    }
    return bg;
}

/* Apply New Note Action `nna` to a freshly spawned ghost. */
static void release_ghost(TaudEngine *e, TaudVoice *bg, int nna)
{
    if (nna == 1) {
        te_start_cut_ramp(e, bg);
    } else if (nna == 0 || nna == 4) {
        bg->keyOff = true;
        te_apply_key_lift(bg, &e->instruments[bg->instrumentId]);
    } else if (nna == 3) {
        bg->noteFading = true;
    }
}

void te_maybe_spawn_background_for_nna(TaudEngine *e, TaudVoice *voice, int channel, int incomingInst)
{
    int nna;
    TaudVoice *bg;
    if (!voice->active) return;
    nna = voice->nnaOverride >= 0 ? voice->nnaOverride : inst_new_note_action(&e->instruments[voice->instrumentId]);
    if (nna == 1 && voice->opl != NULL && voice->fmRig == NULL &&
        inst_is_opl(&e->instruments[incomingInst != 0 ? incomingInst : voice->instrumentId])) {
        /* An OPL note cut by an OPL note is a retrigger of the same channel
         * (§5.5.2): no ghost, no ramp; te_trigger_note picks it up. */
        voice->oplCarry = true;
        return;
    }
    if (nna == 1 && voice->psg != NULL && voice->fmRig == NULL &&
        inst_is_psg(&e->instruments[incomingInst != 0 ? incomingInst : voice->instrumentId])) {
        /* A PSG note cut by a PSG note re-keys the same pair, as OPL does (§5.5.4). */
        voice->psgCarry = true;
        return;
    }
    bg = ghost_rig(e, voice, channel);
    if (bg != NULL) release_ghost(e, bg, nna);
    te_cap_background_voices(e);
}

/* One voice of lane vi's note, for Q's retrigger: false = restart in place. */
static bool hand_off_one(TaudEngine *e, TaudVoice *v, int vi, int override)
{
    const TaudInst *inst = &e->instruments[v->instrumentId];
    TaudVoice *bg;
    int nna;
    if (!inst_retrig_follows_nna(inst)) return false;
    nna = override >= 0 ? override : inst_new_note_action(inst);
    /* An OPL or PSG note cut by a note of its own instrument is the chip
     * keying the same channel on again: no ghost — the plain restart. */
    if (nna == 1 && (v->opl != NULL || v->psg != NULL) && v->fmRig == NULL) return false;
    bg = ghost_rig(e, v, vi);
    if (bg != NULL) release_ghost(e, bg, nna);
    v->retrigFresh = true;
    v->attackRampSamples = inst_is_chip(inst) ? 0 : e->attackRampSamples;
    return true;
}

/* Q's retrigger on lane vi, before the restart (spec §5.7, §6 step 13): every
 * sounding voice of the note whose OWN instrument sets byte 186 bit 6 hands
 * its sound to the background pool per the New Note Action (the lane's
 * S $73…$76 override first), then restarts as a fresh trigger does. Layer
 * children first, the foreground last; FM operands go with their carrier.
 * The pool is capped once, at the end, so the scan never sees it shrink. */
void te_retrig_hand_off(TaudEngine *e, TaudVoice *voice, int vi)
{
    int override = voice->nnaOverride;
    int n = e->bgCount, i;
    for (i = 0; i < n; i++) {
        TaudVoice *bg = e->bg[i];
        if (bg->fmOperator || !bg->active || !te_is_sounding_child(e, bg, vi)) continue;
        hand_off_one(e, bg, vi, override);
    }
    if (voice->active && hand_off_one(e, voice, vi, override) && voice->fmRig != NULL) {
        for (i = 0; i < n; i++) {
            TaudVoice *op = e->bg[i];
            if (!op->fmOperator || !te_is_sounding_child(e, op, vi)) continue;
            op->retrigFresh = true;
            op->attackRampSamples = inst_is_chip(&e->instruments[op->instrumentId]) ? 0 : e->attackRampSamples;
        }
    }
    if (e->bgCount > n) te_cap_background_voices(e);
}

void te_apply_past_note_action(TaudEngine *e, int channel, int action)
{
    int i;
    switch (action) {
    case 0:
        /* Ramped out, as every cut is; an FM operand ends with its carrier. */
        for (i = 0; i < e->bgCount; i++) {
            TaudVoice *bg = e->bg[i];
            if (bg->sourceChannel == channel && !bg->fmOperator) te_start_cut_ramp(e, bg);
        }
        break;
    case 1:
        for (i = 0; i < e->bgCount; i++) {
            TaudVoice *bg = e->bg[i];
            if (bg->sourceChannel == channel) {
                bg->keyOff = true;
                te_apply_key_lift(bg, &e->instruments[bg->instrumentId]);
            }
        }
        break;
    case 2:
        for (i = 0; i < e->bgCount; i++) {
            if (e->bg[i]->sourceChannel == channel) e->bg[i]->noteFading = true;
        }
        break;
    default:
        break;
    }
}

void te_apply_vol_column(TaudEngine *e, TaudVoice *v, int value, int sel)
{
    int dirBit = e->ts_wideCells ? 0x80 : 0x20;
    switch (sel) {
    case 0:
        v->noteVolume = iclamp(value, 0, e->volMax);
        v->rowVolume = v->noteVolume;
        break;
    case 1: v->volColSlideUp = value; break;
    case 2: v->volColSlideDown = value; break;
    case 3: {
        int mag;
        if (value == 0) return;
        mag = value & (dirBit - 1);
        v->noteVolume = (value & dirBit) != 0 ? imin(v->noteVolume + mag, e->volMax) : imax(v->noteVolume - mag, 0);
        v->rowVolume = v->noteVolume;
        break;
    }
    default: break;
    }
}

void te_apply_pan_column(TaudEngine *e, TaudVoice *v, int value, int sel)
{
    switch (sel) {
    case 0:
        te_apply_note_pan_set(e, v, (value << 2) | (value >> 4));
        break;
    case 1: v->panColSlideRight = value; break;
    case 2: v->panColSlideLeft = value; break;
    case 3: {
        int mag;
        if (value == 0) return;
        mag = value & 0x1f;
        te_apply_note_pan_slide(e, v, (value & 0x20) != 0 ? mag : -mag);
        break;
    }
    default: break;
    }
}

static bool row_slides_spatially(const TaudCell *row)
{
    return (row->effect == OP_Z && (row->effectArg & 0xfff) != 0) ||
           (row->effect2 == OP_Z && (row->effectArg2 & 0xfff) != 0);
}

void te_apply_pan_column_wide(TaudEngine *e, TaudVoice *v, const TaudCell *row)
{
    switch (row->panEff) {
    case 0:
        if (row_slides_spatially(row)) {
            v->spatialTargetAz = row->azimuth;
            v->spatialTargetEl = e->ts_surroundModel == SURROUND_SPATIAL ? row->elevation : 0;
        } else {
            te_apply_note_pan_set(e, v, row->azimuth);
            te_apply_note_elevation(e, v, row->elevation);
        }
        break;
    case 1: v->panColSlideRight = row->azimuth & 0xff; break;
    case 2: v->panColSlideLeft = row->azimuth & 0xff; break;
    case 3: {
        int mag = row->azimuth & 0xff;
        if (mag == 0) return;
        te_apply_note_pan_slide(e, v, (row->azimuth & 0x100) != 0 ? mag : -mag);
        break;
    }
    default: break;
    }
}

/* Two of the trigger's steps on their own (wasm_parts.c). */
void te_resolve_active_envelopes(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch)
{
    resolve_active_envelopes(v, inst, patch);
}

TaudVoice *te_ghost_voice(TaudEngine *e, const TaudVoice *src, int channel)
{
    return ghost_voice(e, src, channel);
}
