/* Per-tick voice processing — port of tick.js.
 *
 * A mid-tick note-delay trigger (S $Dx) may swap the voice's instrument, so
 * nothing below caches one across it: every use indexes voice->instrumentId
 * afresh. */

#include "taud_internal.h"

#define FUNK_JITTER_DIVISOR 16
#define EXT_FUNK_MODE 3

static int funk_hop(int funkMode, int loopLen) { return imax(1, loopLen >> (funkMode & 3)); }

static int funk_grid_top(int hop, int loopStart, int loopLen, int sampleLen)
{
    return (int)floor((double)(sampleLen - loopLen - loopStart) / hop);
}

static int funk_grid_index(int pos, int hop, int loopStart, int K)
{
    if (pos < 0) return 0;
    return iclamp((int)js_round((double)(pos - loopStart) / hop), 0, K);
}

static int uniform_int(TaudEngine *e, int n)
{
    return imin((int)floor(te_random(e) * n), n - 1);
}

int te_funk_walk_step(int funkMode, int walk, int loopStart, int loopLen, int sampleLen)
{
    int hop = funk_hop(funkMode, loopLen);
    int K = funk_grid_top(hop, loopStart, loopLen, sampleLen);
    int n, next;
    if (K <= 0) return loopStart;
    n = funk_grid_index(walk, hop, loopStart, K);
    next = (funkMode >> 2) == 1 ? (n - 1 < 0 ? K : n - 1) : (n + 1 > K ? 0 : n + 1);
    return loopStart + next * hop;
}

int te_funk_walk_pointer(TaudEngine *e, int funkMode, int walk, int loopStart, int loopLen, int sampleLen)
{
    int family = funkMode >> 2, hop, K, n, reach, thrown;
    if (family < 2) return walk;
    hop = funk_hop(funkMode, loopLen);
    K = funk_grid_top(hop, loopStart, loopLen, sampleLen);
    if (K <= 0) return loopStart;
    if (family == 3) return loopStart + uniform_int(e, K + 1) * hop;
    n = funk_grid_index(walk, hop, loopStart, K);
    reach = imax(1, (int)js_round((double)(K + 1) / FUNK_JITTER_DIVISOR));
    thrown = n + uniform_int(e, 2 * reach + 1) - reach;
    return loopStart + iclamp(thrown, 0, K) * hop;
}

static void arm_mod_xfade(TaudEngine *e, int instId)
{
    int i;
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *v = &e->voices[i];
        if (v->active && v->instrumentId == instId) v->modXfade = MOD_XFADE_SAMPLES;
    }
    for (i = 0; i < e->bgCount; i++) {
        TaudVoice *bg = e->bg[i];
        if (bg->active && bg->instrumentId == instId) bg->modXfade = MOD_XFADE_SAMPLES;
    }
}

/* One quarter tick of every sounding PSG pair's auto-advance — a lane's, a
 * ghost's, an FM operator's (§5.5.4). Quarter 0 is the tick pass's; 1…3 are
 * the mixer's, at the frames a quarter of the tick apart. */
void te_psg_quarter_pass(TaudEngine *e)
{
    int i;
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *v = &e->voices[i];
        if (v->psg != NULL && v->active) te_psg_quarter_tick(v->psg);
    }
    for (i = 0; i < e->bgCount; i++) {
        TaudVoice *v = e->bg[i];
        if (v->psg != NULL && v->active) te_psg_quarter_tick(v->psg);
    }
}

/* Whether any voice is sounding a PSG pair: the mixer runs quarters only then. */
bool te_psg_live(const TaudEngine *e)
{
    int i;
    if (!e->hasPsg) return false;
    for (i = 0; i < TOTAL_VOICES; i++) if (e->voices[i].psg != NULL && e->voices[i].active) return true;
    for (i = 0; i < e->bgCount; i++) if (e->bg[i]->psg != NULL && e->bg[i]->active) return true;
    return false;
}

static void restart_voice(TaudEngine *e, TaudVoice *v)
{
    v->samplePos = v->activeSamplePlayStart;
    v->keyOff = false;
    v->envIndex = 0; v->envTimeSec = 0.0;
    v->envPanIndex = 0; v->envPanTimeSec = 0.0;
    v->envPan = v->activePanEnv[0].value / 255.0;
    if (v->hasPitchEnv) {
        v->envPitchValue = te_seed_pf_role(v->activePitchEnv, v->activePitchEnvLoop,
            v->activePitchEnvSustain, &v->envPitchIndex, &v->envPitchTimeSec);
    } else {
        v->envPitchValue = 0.5; v->envPitchIndex = 0; v->envPitchTimeSec = 0.0;
    }
    if (v->hasFilterEnv) {
        v->envFilterValue = te_seed_pf_role(v->activeFilterEnv, v->activeFilterEnvLoop,
            v->activeFilterEnvSustain, &v->envFilterIndex, &v->envFilterTimeSec);
    } else {
        v->envFilterValue = 0.5; v->envFilterIndex = 0; v->envFilterTimeSec = 0.0;
    }
    v->fadeoutVolume = 1.0;
    v->fadeoutMix = 1.0;
    v->fadeoutMixStep = 0.0;
    v->autoVibPhase = 0;
    v->autoVibTicksSinceTrigger = 0;
    v->filterY1 = 0.0; v->filterY2 = 0.0; v->filterX1 = 0.0; v->filterX2 = 0.0;
    v->right.filterY1 = 0.0; v->right.filterY2 = 0.0;
    v->right.filterX1 = 0.0; v->right.filterX2 = 0.0;
    v->right.bitcrusherCounter = 0;
    v->right.bitcrusherHeld = 0.0;
    v->right.nesDpcmCounter = 63;
    /* An OPL channel restarts the way the chip re-keys one: the attack from
     * wherever each envelope stands, the phase from zero (§5.5.2). */
    /* Unless te_retrig_hand_off gave its sound to a ghost, which took those
     * envelopes along: then it keys on from silence, as for a fresh note. */
    bool carry = !v->retrigFresh;
    v->retrigFresh = false;
    if (v->opl != NULL && v->opl->patch != NULL) te_opl_key_on(v->opl, v->opl->patch, carry);
    /* …and a PSG pair the same way; an oscillator with its X flag set
     * restarts its internal status here too, as at any key-on (§5.5.4). */
    if (v->psg != NULL && v->psg->patch != NULL) te_psg_key_on(v->psg, v->psg->patch, carry);
    /* A voice sounding a formant instrument says its syllable again (item 212). */
    if (v->formant != NULL) te_formant_restart(e, v->formant);
}

static void advance_sample_mod(TaudEngine *e, TaudVoice *voice)
{
    TaudInst *inst;
    int sampleLen, step;
    const TaudModGeom *g;
    if (voice->modPeriod == 0 || !voice->active || voice->modExtended) return;
    inst = &e->instruments[voice->instrumentId];
    if (inst->modOp == MOD_OFF) return;
    sampleLen = imax(voice->activeSampleLength, 1);
    g = te_resolve_mod_geom(&voice->modGeom, inst, voice->activeSampleLoopStart, voice->activeSampleLoopEnd, sampleLen);
    if (!g->live) return;
    if (++voice->modTickCount < voice->modPeriod) return;
    voice->modTickCount = 0;
    step = MOD_STEP[inst->modOp];
    if (inst->modOp == MOD_INVERT) {
        int n;
        for (n = 0; n < MOD_WALK_SCAN; n++) {
            int i;
            voice->modWritePos = (voice->modWritePos + 1) % imax(g->dl, 1);
            i = g->ds + voice->modWritePos;
            if (te_mod_touches(g, inst->modInvert, i)) { te_inst_toggle_mod_bit(inst, i, sampleLen); break; }
        }
        return;
    }
    te_inst_snapshot_mod_state(inst);
    if (te_is_rol_op(inst->modOp)) {
        inst->modRot = (inst->modRot + step) % g->dl;
        inst->modOn = inst->modRot != 0;
    } else if (te_is_jump_op(inst->modOp)) {
        inst->modRot = te_jump_rot(e, inst->modOp, g->dl);
        inst->modOn = inst->modRot != 0;
    } else if (te_is_rnd_op(inst->modOp)) {
        inst->modScatter = te_scatter_reach(inst->modOp, g->dl);
        inst->modSeed = te_scatter_seed(e);
        inst->modOn = inst->modScatter > 0;
    } else {
        inst->modSub = (inst->modSub + step) & 0xff;
        inst->modOn = inst->modSub != 0;
    }
    arm_mod_xfade(e, voice->instrumentId);
}

static void step_extended_mod_once(TaudEngine *e, TaudVoice *voice, TaudInst *inst, const TaudModGeom *g, int sampleLen)
{
    TaudExtOp op;
    int dl;
    inst->modStepIndex++;
    op = te_decode_ext_op(inst->modOpExt);
    dl = imax(g->dl, 1);
    switch (op.kind) {
    case EXT_KIND_NOOP:
        break;
    case EXT_KIND_INVERT: {
        int n;
        for (n = 0; n < MOD_WALK_SCAN; n++) {
            int i;
            voice->modWritePos = (voice->modWritePos + 1) % dl;
            i = g->ds + voice->modWritePos;
            if (te_ext_mod_touches(g, inst->modInvert, inst->modF, inst->modStepIndex, i)) {
                te_inst_toggle_mod_bit(inst, i, sampleLen);
                break;
            }
        }
        break;
    }
    case EXT_KIND_INVERT_JIT: {
        int reach = imax(1, (int)js_round(te_ext_jitter_frac((int)op.param) * dl));
        int n;
        for (n = 0; n < MOD_WALK_SCAN; n++) {
            int jitter = (int)floor(te_random(e) * (2 * reach + 1)) - reach;
            int i;
            voice->modWritePos = (((voice->modWritePos + 1 + jitter) % dl) + dl) % dl;
            i = g->ds + voice->modWritePos;
            if (te_ext_mod_touches(g, inst->modInvert, inst->modF, inst->modStepIndex, i)) {
                te_inst_toggle_mod_bit(inst, i, sampleLen);
                break;
            }
        }
        break;
    }
    case EXT_KIND_FUNK:
    case EXT_KIND_FUNK_JIT: {
        int pos;
        inst->modFunkLen = dl;
        inst->modFunkWalk = te_funk_walk_step(EXT_FUNK_MODE, inst->modFunkWalk, g->ds, dl, sampleLen);
        pos = inst->modFunkWalk;
        if (op.kind == EXT_KIND_FUNK_JIT) {
            int hop = funk_hop(EXT_FUNK_MODE, dl);
            int K = funk_grid_top(hop, g->ds, dl, sampleLen);
            if (K > 0) {
                int reach = imax(1, (int)js_round(te_ext_jitter_frac((int)op.param) * (K + 1)));
                int n = funk_grid_index(inst->modFunkWalk, hop, g->ds, K);
                int thrown = n + uniform_int(e, 2 * reach + 1) - reach;
                pos = g->ds + iclamp(thrown, 0, K) * hop;
            }
        }
        inst->modFunkPos = pos;
        break;
    }
    case EXT_KIND_MIRROR:
        inst->modExtMirror = !inst->modExtMirror;
        inst->modOn = inst->modExtMirror;
        break;
    case EXT_KIND_SWAP:
        if (dl >= 2) {
            int a = g->ds + (int)floor(te_random(e) * dl);
            int b2 = g->ds + (int)floor(te_random(e) * dl);
            if (b2 == a) b2 = g->ds + ((a - g->ds + 1) % dl);
            inst->modExtSwapA = a;
            inst->modExtSwapB = b2;
            inst->modOn = true;
        }
        break;
    case EXT_KIND_ROL:
        te_inst_snapshot_mod_state(inst);
        inst->modRot = ((inst->modRot + (int)op.param) % dl + dl) % dl;
        inst->modOn = inst->modRot != 0;
        arm_mod_xfade(e, voice->instrumentId);
        break;
    case EXT_KIND_JUMP_N: {
        int param = (int)op.param;
        int slice = imax(1, (int)js_round((double)dl / param));
        int idx = imin((int)floor(te_random(e) * param), param - 1);
        te_inst_snapshot_mod_state(inst);
        inst->modRot = (idx * slice) % dl;
        inst->modOn = true;
        arm_mod_xfade(e, voice->instrumentId);
        break;
    }
    case EXT_KIND_JUMP_N_BOUNDED: {
        int reach, thrown;
        te_inst_snapshot_mod_state(inst);
        reach = imax(1, (int)js_round((double)dl / op.param));
        thrown = (int)floor(te_random(e) * (2 * reach + 1)) - reach;
        inst->modRot = ((thrown % dl) + dl) % dl;
        inst->modOn = true;
        arm_mod_xfade(e, voice->instrumentId);
        break;
    }
    case EXT_KIND_SCATTER:
        te_inst_snapshot_mod_state(inst);
        inst->modScatter = imax(1, imin((int)js_round(dl * op.param), dl));
        inst->modSeed = te_scatter_seed(e);
        inst->modOn = inst->modScatter > 0;
        arm_mod_xfade(e, voice->instrumentId);
        break;
    case EXT_KIND_SUB:
        te_inst_snapshot_mod_state(inst);
        inst->modSub = (inst->modSub + (int)op.param) & 0xff;
        inst->modOn = inst->modSub != 0;
        arm_mod_xfade(e, voice->instrumentId);
        break;
    case EXT_KIND_XOR:
        te_inst_snapshot_mod_state(inst);
        inst->modXor = (inst->modXor ^ (int)op.param) & 0xff;
        inst->modOn = inst->modXor != 0;
        arm_mod_xfade(e, voice->instrumentId);
        break;
    case EXT_KIND_BITROT:
        inst->modBitRot = (((inst->modBitRot + (int)op.param) % 8) + 8) % 8;
        inst->modOn = inst->modBitRot != 0;
        break;
    case EXT_KIND_BITPERM:
        inst->modBitPermIdx = (int)op.param;
        inst->modBitPermOn = !inst->modBitPermOn;
        inst->modOn = inst->modBitPermOn;
        break;
    default:
        break;
    }
}

/* Argument-extension clock: stepped per SAMPLE from the mixer. */
void te_advance_sample_mod_extended(TaudEngine *e, TaudVoice *voice, double spt)
{
    TaudInst *inst;
    int sampleLen;
    const TaudModGeom *g;
    double periodSamples;
    if (!voice->modExtended || !voice->active) return;
    inst = &e->instruments[voice->instrumentId];
    if (inst->modOpExt == 0 || voice->modStepTicks <= 0) return;
    sampleLen = imax(voice->activeSampleLength, 1);
    g = te_resolve_mod_geom(&voice->modGeom, inst, voice->activeSampleLoopStart, voice->activeSampleLoopEnd, sampleLen);
    if (!g->live) return;
    voice->modSamplesIntoStep += 1.0;
    periodSamples = voice->modStepTicks * spt;
    if (periodSamples <= 0 || voice->modSamplesIntoStep < periodSamples) return;
    voice->modSamplesIntoStep -= periodSamples;
    step_extended_mod_once(e, voice, inst, g, sampleLen);
}

static void fire_note_action(TaudEngine *e, TaudVoice *voice, int vi)
{
    int i;
    switch (voice->delayedAction) {
    case 0:
        voice->keyOff = true;
        te_apply_key_lift(voice, &e->instruments[voice->instrumentId]);
        break;
    case 1:
        te_start_cut_ramp(e, voice);
        te_cut_layer_children(e, vi);
        break;
    case 2:
        break;
    case 3:
        voice->noteFading = true;
        break;
    case 4:
        voice->keyOff = true;
        te_force_key_lift(voice);
        for (i = 0; i < e->bgCount; i++) {
            TaudVoice *bg = e->bg[i];
            if (te_is_sounding_child(e, bg, vi)) { bg->keyOff = true; te_force_key_lift(bg); }
        }
        break;
    default:
        break;
    }
}

static void update_filter_cutoff(TaudVoice *v)
{
    if (v->hasFilterEnv && v->filterEnvOn) {
        if (v->filterSfMode) {
            int baseCut = v->activeDefaultCutoff < 0xffff ? v->activeDefaultCutoff : 13500;
            v->currentCutoff = (int)dclamp(trunc(baseCut * v->envFilterValue), 0, 0xffff);
        } else {
            int baseCut = v->activeDefaultCutoff < 255 ? v->activeDefaultCutoff : 254;
            v->currentCutoff = (int)dclamp(trunc(baseCut * v->envFilterValue), 0, 254);
        }
    }
}

static int pitch_env_delta(const TaudVoice *v)
{
    return v->hasPitchEnv && v->pitchEnvOn
        ? (int)trunc(((v->envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
        : 0;
}

/* What a row scheduled for a later tick of itself: the note cut (S $Cx), the
 * delayed note event (S $Dx) and the S $Dxny follow-up action. They fire at
 * the boundary that STARTS their tick, as a row's own events fire at the
 * boundary that starts the row (TAUD_ENGINE_SPEC.md §2.2, §6.3): the mixer's
 * clock runs this after the tick pass and the tickInRow increment, whenever
 * the row goes on. Inside the tick pass they fired a tick late (Microtone
 * item 232): S $D1 sounded at tick 2, and a delay of speed − 1 on the next
 * row's first tick. */
void te_apply_tick_events(TaudEngine *e)
{
    int vi;
    for (vi = 0; vi < TOTAL_VOICES; vi++) {
        TaudVoice *voice = &e->voices[vi];
        if (voice->cutAtTick != e->tickInRow && voice->noteDelayTick != e->tickInRow &&
            voice->noteActionTick != e->tickInRow) continue;

        if (voice->cutAtTick == e->tickInRow) {
            voice->noteVolume = 0;
            voice->rowVolume = 0;
            voice->noteWasCut = true;
        }

        if (voice->noteDelayTick == e->tickInRow) {
            /* Only a sentinel (< $20) is a case; a note — which may carry
             * sixteenths — falls through to the trigger. */
            switch (voice->delayedNote < 0x20 ? (int)voice->delayedNote : -1) {
            case 0x0001:
                voice->keyOff = true;
                te_apply_key_lift(voice, &e->instruments[voice->instrumentId]);
                break;
            case 0x0002:
                te_start_cut_ramp(e, voice);
                te_cut_layer_children(e, vi);
                break;
            case 0x0003:
                voice->noteFading = true;
                break;
            case 0x0004:
                te_start_fast_fade(e, voice);
                break;
            default:
                if (voice->delayedNote >= 0x0010 && voice->delayedNote <= 0x001f) {
                    int k = (int)voice->delayedNote - 0x0010;
                    e->pendingInterrupts |= 1u << k;
                    e->interruptArgs[k] = (uint16_t)voice->delayedInterruptArg;
                    break;
                }
                te_apply_duplicate_check(e, vi, voice->delayedInst, voice->delayedNote);
                te_maybe_spawn_background_for_nna(e, voice, vi, voice->delayedInst);
                te_trigger_meta_or_note(e, voice, vi, voice->delayedNote, voice->delayedInst, voice->delayedVol,
                                        true, voice->delayedGlide);
                break;
            }
            voice->noteDelayTick = -1;
        }

        if (voice->noteActionTick == e->tickInRow) {
            fire_note_action(e, voice, vi);
            voice->noteActionTick = -1;
        }
    }
}

void te_apply_tracker_tick(TaudEngine *e)
{
    double tickSec = 2.5 / e->bpm;
    double spt = e->rate * tickSec;
    int vi, i;

    for (vi = 0; vi < TOTAL_VOICES; vi++) {
        TaudVoice *voice = &e->voices[vi];
        double pitchToMixer, finalPitch;
        int autoVibDelta;
        if (!voice->active && voice->noteDelayTick < 0 && voice->noteActionTick < 0) continue;

        if (!voice->active) {
            te_advance_envelope(e, voice, tickSec);
            voice->envVolStep = spt > 0.0 ? (voice->envVolume - voice->envVolMix) / spt : 0.0;
            continue;
        }

        /* Pitch slides (E/F coarse on tick > 0). */
        if (e->tickInRow > 0 && (voice->slideMode == 1 || voice->slideMode == 2)) {
            double nv;
            if (e->toneMode == 1) nv = te_amiga_slide_tick(voice, voice->slideArg);
            else if (e->toneMode == 2) nv = te_linear_freq_slide_tick(voice, voice->slideArg);
            else nv = voice->noteVal + voice->slideArg;
            voice->noteVal = dclamp(nv, 0x20, 0xffff);
            voice->basePitch = voice->noteVal;
        }

        /* Tone portamento (G). */
        if (voice->tonePortaTarget >= 0 && e->tickInRow > 0) {
            double target = voice->tonePortaTarget;
            int sp = voice->tonePortaSpeed;
            if (e->toneMode == 2) {
                double targetFreq, dir;
                if (voice->linearFreq < 0.0) voice->linearFreq = te_note_val_to_freq_hz(voice->noteVal);
                targetFreq = te_note_val_to_freq_hz(target);
                dir = targetFreq > voice->linearFreq ? 1.0 : -1.0;
                voice->linearFreq += dir * sp;
                if ((dir > 0 && voice->linearFreq >= targetFreq) || (dir < 0 && voice->linearFreq <= targetFreq)) {
                    voice->linearFreq = targetFreq;
                    voice->noteVal = target;
                    voice->tonePortaTarget = -1;
                } else {
                    voice->noteVal = dclamp(te_freq_hz_to_note_val(voice->linearFreq), 0x20, 0xffff);
                }
                voice->basePitch = voice->noteVal;
                voice->amigaPeriod = -1.0;
            } else {
                int delta = target > voice->noteVal ? sp : -sp;
                voice->noteVal += delta;
                if ((delta > 0 && voice->noteVal >= target) || (delta < 0 && voice->noteVal <= target)) {
                    voice->noteVal = target;
                    voice->tonePortaTarget = -1;
                }
                voice->basePitch = voice->noteVal;
                voice->amigaPeriod = -1.0;
                voice->linearFreq = -1.0;
            }
        }

        /* Volume slides (D coarse on tick > 0). */
        if (e->tickInRow > 0 && voice->slideMode == 5) {
            voice->noteVolume = iclamp(voice->noteVolume + voice->slideArg * e->volStep, 0, e->volMax);
            voice->rowVolume = voice->noteVolume;
        }

        if (e->tickInRow > 0) {
            if (voice->volColSlideUp != 0) {
                voice->noteVolume = imin(voice->noteVolume + voice->volColSlideUp, e->volMax);
                voice->rowVolume = voice->noteVolume;
            }
            if (voice->volColSlideDown != 0) {
                voice->noteVolume = imax(voice->noteVolume - voice->volColSlideDown, 0);
                voice->rowVolume = voice->noteVolume;
            }
            if (voice->nSlideDir != 0) {
                voice->channelVolume = iclamp(voice->channelVolume + voice->nSlideDir * e->volStep, 0, e->volMax);
            }
            if (voice->panColSlideRight != 0) te_apply_note_pan_slide(e, voice, voice->panColSlideRight);
            if (voice->panColSlideLeft != 0) te_apply_note_pan_slide(e, voice, -voice->panColSlideLeft);
            if (voice->chanPanSlideRight != 0) te_apply_pan_slide(e, voice, voice->chanPanSlideRight);
            if (voice->chanPanSlideLeft != 0) te_apply_pan_slide(e, voice, -voice->chanPanSlideLeft);
            if (voice->spatialSlideActive) {
                double step[2];
                te_step_toward_target(voice->panAzimuth, voice->panElevation,
                    voice->spatialTargetAz, voice->spatialTargetEl, voice->mem.z / 8.0, step);
                te_apply_pan_set(e, voice, step[0]);
                voice->panElevation = step[1];
            }
        }

        /* Tremor (I). */
        if (voice->tremorOn != 0) {
            int limit;
            voice->tremorTickInPhase++;
            limit = voice->tremorPhaseOn ? voice->tremorOnTime : voice->tremorOffTime;
            if (voice->tremorTickInPhase >= limit) {
                voice->tremorTickInPhase = 0;
                voice->tremorPhaseOn = !voice->tremorPhaseOn;
            }
            if (!voice->tremorPhaseOn) voice->rowVolume = 0;
        }

        /* Vibrato (H/U). */
        pitchToMixer = voice->noteVal;
        if (voice->vibratoActive) {
            int sine = te_lfo_sample_wide(e, voice->vibratoLfoPos, voice->vibratoWave);
            int pitchDelta = asr32(sine * voice->mem.huDepth, voice->vibratoFineShift);
            pitchToMixer = dclamp(voice->noteVal + pitchDelta, 0x20, 0xffff);
            voice->vibratoLfoPos = te_advance_lfo_phase(voice->vibratoLfoPos, voice->mem.huSpeed);
        }

        /* Glissando (S $1x). */
        if (voice->glissandoOn) {
            int semis = (int)trunc((pitchToMixer * 12 + 2048) / 4096);
            pitchToMixer = iclamp((semis * 4096) / 12, 0x20, 0xffff);
        }

        /* Tremolo (R). */
        if (voice->tremoloActive) {
            int sine = te_lfo_sample_wide(e, voice->tremoloLfoPos, voice->tremoloWave);
            int volDelta = asr32(sine * voice->mem.rDepth, 9);
            voice->rowVolume = iclamp(voice->noteVolume + volDelta * e->volStep, 0, e->volMax);
            voice->tremoloLfoPos = te_advance_lfo_phase(voice->tremoloLfoPos, voice->mem.rSpeed);
        }

        /* Panbrello (Y). */
        if (voice->panbrelloActive) {
            int sine = te_lfo_sample_wide(e, voice->panbrelloLfoPos, voice->panbrelloWave);
            voice->panbrelloOffset = asr32(sine * voice->mem.yDepth, 7);
            voice->panbrelloLfoPos = te_advance_lfo_phase(voice->panbrelloLfoPos, voice->mem.ySpeed);
        } else {
            voice->panbrelloOffset = 0;
        }

        /* Arpeggio (J). */
        if (voice->arpActive) {
            int voiceIdx = e->tickInRow % 3;
            int arpDelta = voiceIdx == 1 ? voice->arpOff1 : voiceIdx == 2 ? voice->arpOff2 : 0;
            pitchToMixer = dclamp(voice->basePitch + arpDelta, 0x20, 0xffff);
            voice->lastArpVoice = voiceIdx;
        }

        /* Q retrigger — a metainstrument retriggers whole. */
        if (voice->retrigActive && !voice->noteWasCut) {
            voice->retrigCounter++;
            if (voice->retrigCounter >= voice->retrigInterval) {
                voice->retrigCounter = 0;
                /* Byte 186 bit 6: ghost the outgoing sound per its NNA first. */
                te_retrig_hand_off(e, voice, vi);
                restart_voice(e, voice);
                for (i = 0; i < e->bgCount; i++) {
                    if (te_is_sounding_child(e, e->bg[i], vi)) restart_voice(e, e->bg[i]);
                }
                voice->noteVolume = te_apply_retrig_vol_mod(voice->noteVolume, voice->retrigVolMod, e->volStep, e->volMax);
                voice->rowVolume = voice->noteVolume;
            }
        }

        voice->pitchModDelta = pitchToMixer - voice->noteVal;

        autoVibDelta = te_advance_auto_vibrato(e, voice);
        finalPitch = dclamp(pitchToMixer + autoVibDelta + pitch_env_delta(voice), 0x20, 0xffff);
        voice->playbackRate = te_compute_playback_rate(e, voice, finalPitch, e->tuningRatio);
        voice->renderPitch = finalPitch;

        update_filter_cutoff(voice);
        te_refresh_voice_filter(e, voice);

        /* The mixer glides fadeoutMix to the new value across the tick, so
         * the voice ends on the tick AFTER the multiplier reaches 0. */
        if (voice->keyOff || voice->noteFading) {
            int fadeStep = voice->activeFadeoutStep;
            if (fadeStep > 0) {
                if (voice->fadeoutVolume <= 0.0) voice->active = false;
                else voice->fadeoutVolume = dmax(voice->fadeoutVolume - fadeStep / 1024.0, 0.0);
            }
        }
        voice->fadeoutMixStep = spt > 0.0 ? (voice->fadeoutVolume - voice->fadeoutMix) / spt : 0.0;

        te_advance_envelope(e, voice, tickSec);
        voice->envVolStep = spt > 0.0 ? (voice->envVolume - voice->envVolMix) / spt : 0.0;
        te_advance_pitch_envelope(voice, tickSec);
        te_advance_filter_envelope(voice, tickSec);
    }

    /* Tempo slide — once per tick at the playhead level. */
    for (vi = 0; vi < TOTAL_VOICES; vi++) {
        TaudVoice *voice = &e->voices[vi];
        if (voice->tempoSlideDir != 0 && e->tickInRow > 0) {
            int tempoByte = iclamp(e->bpm - 0x19 + voice->tempoSlideDir * voice->tempoSlideAmount, 0, 0xff);
            e->bpm = iclamp(tempoByte + 0x19, 25, 280);
        }
    }

    /* Global volume slide (W coarse). */
    if (e->tickInRow > 0) {
        for (vi = 0; vi < TOTAL_VOICES; vi++) {
            TaudVoice *voice = &e->voices[vi];
            if (voice->wSlideDir != 0) {
                e->globalVolume = iclamp(e->globalVolume + voice->wSlideDir * voice->wSlideAmount, 0, 0xff);
            }
        }
    }

    /* PSG waveform auto-advance (§5.5.4): the tick's first quarter. The mixer
     * runs the other three at their own frames. */
    e->psgQuarter = 0;
    te_psg_quarter_pass(e);

    /* Invert loop (S $F0xx). */
    for (vi = 0; vi < TOTAL_VOICES; vi++) {
        TaudVoice *voice = &e->voices[vi];
        TaudInst *inst;
        if (voice->invertSpeed == 0 || !voice->active) continue;
        inst = &e->instruments[voice->instrumentId];
        if (voice->activeSampleLoopEnd <= voice->activeSampleLoopStart) continue;
        voice->invertAccumulator += voice->invertSpeed;
        if (voice->invertAccumulator >= 0x80) {
            int loopLen = imax(voice->activeSampleLoopEnd - voice->activeSampleLoopStart, 1);
            voice->invertAccumulator = 0;
            voice->invertWritePos = (voice->invertWritePos + 1) % loopLen;
            te_inst_toggle_invert_bit(inst, voice->invertWritePos, loopLen);
        }
    }

    /* Funk repeat (Z $Ffxx). */
    for (vi = 0; vi < TOTAL_VOICES; vi++) {
        TaudVoice *voice = &e->voices[vi];
        int mode, loopStart, loopLen, sampleLen;
        if (voice->funkSpeed == 0 || !voice->active) continue;
        mode = voice->activeLoopMode & 3;
        if (mode != 1 && mode != 2) continue;
        loopStart = voice->activeSampleLoopStart;
        loopLen = voice->activeSampleLoopEnd - loopStart;
        sampleLen = voice->activeSampleLength;
        if (loopLen <= 0 || loopStart + loopLen > sampleLen) continue;
        voice->funkAccumulator = (voice->funkAccumulator + voice->funkSpeed) & 0xff;
        if ((voice->funkAccumulator & 0x80) != 0) {
            voice->funkAccumulator = 0;
            voice->funkWalk = te_funk_walk_step(voice->funkMode, voice->funkWalk, loopStart, loopLen, sampleLen);
            voice->funkPos = te_funk_walk_pointer(e, voice->funkMode, voice->funkWalk, loopStart, loopLen, sampleLen);
        }
    }

    /* Sample modification (notefx 2 / 3), lane-clocked. */
    for (vi = 0; vi < TOTAL_VOICES; vi++) advance_sample_mod(e, &e->voices[vi]);
    for (i = 0; i < e->bgCount; i++) {
        if (e->bg[i]->isLayerChild) advance_sample_mod(e, e->bg[i]);
    }

    /* Background (NNA-ghost) voices: passive maintenance only. */
    for (i = e->bgCount - 1; i >= 0; i--) {
        TaudVoice *bg = e->bg[i];
        int autoVibDelta;
        double finalPitch;
        bool fadedOut;
        if (!bg->active) { te_bg_remove_at(e, i); continue; }
        if (bg->isLayerChild) {
            TaudVoice *parent = bg->fmOperator
                ? bg->fmParent
                : (bg->sourceChannel >= 0 && bg->sourceChannel < TOTAL_VOICES ? &e->voices[bg->sourceChannel] : NULL);
            if (bg->fmOperator && (parent == NULL || !parent->active ||
                parent->fmRig == NULL || parent->fmRig->voices[0] != parent)) {
                bg->active = false;
                bg->fmOperator = false;
                bg->fmParent = NULL;
                te_bg_remove_at(e, i);
                continue;
            }
            if (parent == NULL || !parent->active) {
                if (parent != NULL && !bg->keyOff && !bg->noteFading) {
                    if (parent->keyOff) {
                        bg->keyOff = true;
                        te_apply_key_lift(bg, &e->instruments[bg->instrumentId]);
                    } else if (parent->noteFading) {
                        bg->noteFading = true;
                    }
                }
                bg->isLayerChild = false;
                bg->layerPitchMod = 0;
                bg->layerFixedNote = -1;
            } else {
                if (bg->layerFixedNote >= 0) {
                    bg->noteVal = bg->layerFixedNote; /* its excess is the trigger's */
                } else {
                    /* The parent's pitch, whole, plus this entry's place
                     * against it; what a note value cannot hold goes into
                     * the excess, as at the trigger. */
                    double full = parent->noteVal + parent->pitchExcess + bg->layerRelDetune;
                    bg->noteVal = dclamp(full, 0x20, 0xffff);
                    bg->pitchExcess = full - bg->noteVal;
                }
                bg->layerPitchMod = parent->pitchModDelta;
                bg->basePitch = bg->noteVal;
                bg->amigaPeriod = -1.0;
                bg->linearFreq = -1.0;
                if (parent->keyOff && !bg->keyOff) {
                    bg->keyOff = true;
                    te_apply_key_lift(bg, &e->instruments[bg->instrumentId]);
                }
                if (parent->noteFading && !bg->noteFading) bg->noteFading = true;
                bg->channelVolume = parent->channelVolume;
                bg->channelVolumeSet = parent->channelVolumeSet;
                bg->channelPanSet = parent->channelPanSet;
                bg->noteVolume = parent->noteVolume;
                bg->rowVolume = parent->rowVolume;
                bg->channelPan = parent->channelPan;
                bg->rowPan = parent->rowPan;
                bg->panbrelloOffset = parent->panbrelloOffset;
                bg->panAzimuth = parent->panAzimuth;
                bg->panElevation = parent->panElevation;
                bg->notePan = te_bound_note_pan(e, parent->notePan + bg->layerRelPan);
                bg->noteElevation = parent->noteElevation + bg->layerRelElevation;
            }
        }
        te_advance_envelope(e, bg, tickSec);
        bg->envVolStep = spt > 0.0 ? (bg->envVolume - bg->envVolMix) / spt : 0.0;
        te_advance_pitch_envelope(bg, tickSec);
        te_advance_filter_envelope(bg, tickSec);
        /* Faded out on an EARLIER tick: its glide to silence is done. */
        fadedOut = (bg->keyOff || bg->noteFading) && bg->fadeoutVolume <= 0.0;
        if (bg->keyOff || bg->noteFading) {
            int fadeStep = bg->activeFadeoutStep;
            if (fadeStep > 0) bg->fadeoutVolume = dmax(bg->fadeoutVolume - fadeStep / 1024.0, 0.0);
        }
        bg->fadeoutMixStep = spt > 0.0 ? (bg->fadeoutVolume - bg->fadeoutMix) / spt : 0.0;
        autoVibDelta = te_advance_auto_vibrato(e, bg);
        finalPitch = dclamp(bg->noteVal + bg->layerPitchMod + autoVibDelta + pitch_env_delta(bg), 0x20, 0xffff);
        bg->playbackRate = te_compute_playback_rate(e, bg, finalPitch, e->tuningRatio);
        bg->renderPitch = finalPitch;
        update_filter_cutoff(bg);
        te_refresh_voice_filter(e, bg);
        if (fadedOut) {
            bg->active = false;
            te_bg_remove_at(e, i);
        }
    }
}
