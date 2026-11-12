/* Effect-column dispatch — port of effects.js. */

#include "taud_internal.h"

static inline int resolve_arg(int arg, int mem) { return arg != 0 ? arg : mem; }

/* Every voice lane `vi` is sounding as ONE note: the foreground plus, for a
 * metainstrument, its layer children. */
#define FOR_EACH_LAYER_TARGET(e, voice, vi, v, ...)                           \
    do {                                                                      \
        int fe_i_;                                                            \
        TaudVoice *v = (voice);                                               \
        __VA_ARGS__;                                                          \
        for (fe_i_ = 0; fe_i_ < (e)->bgCount; fe_i_++) {                      \
            if (te_is_sounding_child((e), (e)->bg[fe_i_], (vi))) {            \
                v = (e)->bg[fe_i_];                                           \
                __VA_ARGS__;                                                  \
            }                                                                 \
        }                                                                     \
    } while (0)

static void apply_s_effect(TaudEngine *e, TaudVoice *voice, int vi, int arg);
static void apply_sample_mod_effect(TaudEngine *e, TaudVoice *voice, int vi, int rawArg, bool invert, int ext, bool hasExt);
static void apply_filter_param_effect(TaudEngine *e, TaudVoice *voice, int vi, int rawArg, bool isResonance);

void te_apply_effect_row(TaudEngine *e, TaudVoice *voice, int vi, int op, int rawArg, int ext, bool hasExt)
{
    switch (op) {
    case OP_NONE: break;
    case OP_COLON: break;
    case OP_7: break;
    case OP_1:
        te_update_global_behaviour(e, rawArg >> 8);
        break;
    case OP_2: apply_sample_mod_effect(e, voice, vi, rawArg, true, ext, hasExt); break;
    case OP_3: apply_sample_mod_effect(e, voice, vi, rawArg, false, ext, hasExt); break;
    case OP_5: apply_filter_param_effect(e, voice, vi, rawArg, false); break;
    case OP_6: apply_filter_param_effect(e, voice, vi, rawArg, true); break;
    case OP_8: {
        int x = (rawArg >> 12) & 0xf;
        int y = (rawArg >> 8) & 0xf;
        int z = rawArg & 0xff;
        FOR_EACH_LAYER_TARGET(e, voice, vi, v, {
            v->clipMode = x & 3;
            if (rawArg == 0) {
                v->bitcrusherDepth = 0;
                v->bitcrusherSkip = 0;
                v->bitcrusherCounter = 0;
                v->right.bitcrusherCounter = 0;
            } else if (y == 0 && z == 0) {
                /* x000 — clip mode only */
            } else {
                v->bitcrusherDepth = y;
                v->bitcrusherSkip = z;
                v->bitcrusherCounter = 0;
                v->right.bitcrusherCounter = 0;
            }
        });
        break;
    }
    case OP_9: {
        int x = (rawArg >> 12) & 0xf;
        int z = rawArg & 0xff;
        FOR_EACH_LAYER_TARGET(e, voice, vi, v, {
            v->clipMode = x & 3;
            if (rawArg == 0) v->overdriveAmp = 0;
            else if (z != 0) v->overdriveAmp = z;
        });
        break;
    }
    case OP_A: {
        int tr = (rawArg >> 8) & 0xff;
        if (tr != 0) e->tickRate = tr;
        break;
    }
    case OP_B:
        if (e->pendingOrderJump < 0) e->pendingOrderJump = iclamp(rawArg, 0, NUM_CUES - 1);
        break;
    case OP_C:
        if (e->pendingRowJump < 0) e->pendingRowJump = iclamp(rawArg, 0, 63);
        break;
    case OP_D: {
        int arg = resolve_arg(rawArg, voice->mem.d);
        int hi, lo, hin;
        if (rawArg != 0) voice->mem.d = arg;
        hi = (arg >> 8) & 0xff;
        lo = hi & 0x0f;
        hin = (hi >> 4) & 0x0f;
        if (hi == 0xff || hi == 0xf0) {
            voice->noteVolume = imin(voice->noteVolume + 0xf * e->volStep, e->volMax); voice->rowVolume = voice->noteVolume;
        } else if (hin == 0xf && lo != 0) {
            voice->noteVolume = imax(voice->noteVolume - lo * e->volStep, 0); voice->rowVolume = voice->noteVolume;
        } else if (lo == 0xf && hin != 0) {
            voice->noteVolume = imin(voice->noteVolume + hin * e->volStep, e->volMax); voice->rowVolume = voice->noteVolume;
        } else if (hin == 0 && lo != 0) {
            voice->slideMode = 5; voice->slideArg = -lo;
        } else if (lo == 0 && hin != 0) {
            voice->slideMode = 5; voice->slideArg = hin;
        }
        break;
    }
    case OP_E:
    case OP_F: {
        int arg = resolve_arg(rawArg, voice->mem.ef);
        bool up = op == OP_F;
        if (rawArg != 0) voice->mem.ef = arg;
        if ((arg & 0xf000) == 0xf000) {
            int mag = arg & 0x0fff;
            int delta = up ? mag : -mag;
            double nv;
            if (e->toneMode == 1) nv = te_amiga_slide_once(voice->noteVal, delta);
            else if (e->toneMode == 2) nv = te_linear_freq_slide_once(voice->noteVal, delta);
            else nv = voice->noteVal + delta;
            voice->noteVal = dclamp(nv, 0x20, 0xffff);
            voice->basePitch = voice->noteVal;
            voice->amigaPeriod = -1.0;
            voice->linearFreq = -1.0;
            voice->playbackRate = te_compute_playback_rate(e, voice, voice->noteVal, e->tuningRatio);
        } else {
            voice->slideMode = up ? 2 : 1;
            voice->slideArg = up ? arg : -arg;
            voice->amigaPeriod = -1.0;
            voice->linearFreq = -1.0;
        }
        break;
    }
    case OP_G: {
        int arg = resolve_arg(rawArg, voice->mem.g);
        if (rawArg != 0) voice->mem.g = arg;
        voice->tonePortaSpeed = arg;
        break;
    }
    case OP_H:
    case OP_U: {
        int sp = (rawArg >> 8) & 0xff;
        int dp = rawArg & 0xff;
        if (sp != 0) voice->mem.huSpeed = sp;
        if (dp != 0) voice->mem.huDepth = dp;
        voice->vibratoActive = true;
        voice->vibratoFineShift = op == OP_H ? 6 : 8;
        break;
    }
    case OP_I: {
        int arg = resolve_arg(rawArg, voice->mem.i);
        if (rawArg != 0) voice->mem.i = arg;
        voice->tremorOn = 1;
        voice->tremorOnTime = ((arg >> 8) & 0xff) + 1;
        voice->tremorOffTime = (arg & 0xff) + 1;
        break;
    }
    case OP_J: {
        voice->arpActive = true;
        if (hasExt) {
            int off1 = resolve_arg(rawArg, voice->mem.jExt1);
            int off2 = resolve_arg(ext, voice->mem.jExt2);
            if (rawArg != 0) voice->mem.jExt1 = off1;
            if (ext != 0) voice->mem.jExt2 = off2;
            voice->arpOff1 = off1;
            voice->arpOff2 = off2;
        } else {
            int arg = resolve_arg(rawArg, voice->mem.j);
            if (rawArg != 0) voice->mem.j = arg;
            voice->arpOff1 = ((arg >> 8) & 0xff) << 8;
            voice->arpOff2 = (arg & 0xff) << 8;
        }
        break;
    }
    case OP_K: {
        int raw = (rawArg >> 8) & 0xff;
        int arg = raw != 0 ? (voice->mem.k = raw) : voice->mem.k;
        int hi = (arg >> 4) & 0xf, lo = arg & 0xf;
        voice->vibratoActive = true;
        voice->vibratoFineShift = 6;
        if (lo != 0) voice->volColSlideDown = lo;
        else if (hi != 0) voice->volColSlideUp = hi;
        break;
    }
    case OP_L: {
        int raw = (rawArg >> 8) & 0xff;
        int arg = raw != 0 ? (voice->mem.l = raw) : voice->mem.l;
        int hi = (arg >> 4) & 0xf, lo = arg & 0xf;
        voice->tonePortaSpeed = voice->mem.g;
        if (lo != 0) voice->volColSlideDown = lo;
        else if (hi != 0) voice->volColSlideUp = hi;
        break;
    }
    case OP_M:
        voice->channelVolume = imin((rawArg >> 8) & 0xff, e->volMax);
        voice->channelVolumeSet = true;
        break;
    case OP_N: {
        int arg, hi, lo, hin;
        voice->channelVolumeSet = true;
        arg = resolve_arg(rawArg, voice->mem.n);
        if (rawArg != 0) voice->mem.n = arg;
        hi = (arg >> 8) & 0xff;
        lo = hi & 0x0f;
        hin = (hi >> 4) & 0x0f;
        if (hi == 0xff || hi == 0xf0) voice->channelVolume = imin(voice->channelVolume + 0xf * e->volStep, e->volMax);
        else if (hin == 0xf && lo != 0) voice->channelVolume = imax(voice->channelVolume - lo * e->volStep, 0);
        else if (lo == 0xf && hin != 0) voice->channelVolume = imin(voice->channelVolume + hin * e->volStep, e->volMax);
        else if (hin == 0 && lo != 0) voice->nSlideDir = -lo;
        else if (lo == 0 && hin != 0) voice->nSlideDir = hin;
        break;
    }
    case OP_P: {
        int arg, hi, lo, hin;
        voice->channelPanSet = true;
        arg = resolve_arg(rawArg, voice->mem.p);
        if (rawArg != 0) voice->mem.p = arg;
        hi = (arg >> 8) & 0xff;
        lo = hi & 0x0f;
        hin = (hi >> 4) & 0x0f;
        if (hi == 0xff || hi == 0xf0) te_apply_pan_slide(e, voice, -0xf);
        else if (hin == 0xf && lo != 0) te_apply_pan_slide(e, voice, lo);
        else if (lo == 0xf && hin != 0) te_apply_pan_slide(e, voice, -hin);
        else if (hin == 0 && lo != 0) voice->chanPanSlideRight = lo;
        else if (lo == 0 && hin != 0) voice->chanPanSlideLeft = hin;
        break;
    }
    case OP_O: {
        double off;
        if (hasExt) {
            double combined = (double)rawArg * 65536 + ext;
            off = combined != 0 ? combined : voice->mem.oExt;
            if (combined != 0) voice->mem.oExt = combined;
        } else {
            off = resolve_arg(rawArg, voice->mem.o);
            if (rawArg != 0) voice->mem.o = (int)off;
        }
        if ((voice->activeLoopMode & 3) != 0 &&
            voice->activeSampleLoopEnd > voice->activeSampleLoopStart &&
            off > voice->activeSampleLoopEnd) {
            int loopLen = imax(voice->activeSampleLoopEnd - voice->activeSampleLoopStart, 1);
            off = voice->activeSampleLoopStart + fmod(off - voice->activeSampleLoopStart, loopLen);
        }
        voice->samplePos = off;
        break;
    }
    case OP_Q: {
        int arg = resolve_arg(rawArg, voice->mem.q);
        int y = (arg >> 8) & 0xf;
        if (y != 0) {
            voice->mem.q = arg;
            voice->retrigInterval = y;
            voice->retrigVolMod = (arg >> 12) & 0xf;
            voice->retrigActive = true;
        }
        break;
    }
    case OP_R: {
        int sp = (rawArg >> 8) & 0xff;
        int dp = rawArg & 0xff;
        if (sp != 0) voice->mem.rSpeed = sp;
        if (dp != 0) voice->mem.rDepth = dp;
        voice->tremoloActive = true;
        break;
    }
    case OP_S: apply_s_effect(e, voice, vi, rawArg); break;
    case OP_T: {
        int hi = (rawArg >> 8) & 0xff;
        int lo = rawArg & 0xff;
        if (hi >= 0xfc && lo != 0) {
            /* T $FFxx..$FCxx (xx > 0): each prefix carries on where the one
             * above stops — $FF 281..535, $FE 536..790, $FD 791..1045, $FC 1046.. */
            e->bpm = iclamp(0x118 + (0xff - hi) * 0xff + lo, BPM_MIN, BPM_MAX);
        } else if (hi == 0xfb && lo != 0) {
            /* T $FBxx (xx > 0): RESERVED, ignored. */
        } else if (hi != 0) {
            e->bpm = iclamp(hi + 0x19, BPM_MIN, BPM_MAX);
        } else {
            int low = rawArg & 0xff;
            switch (low & 0xf0) {
            case 0x00: voice->tempoSlideDir = -1; voice->tempoSlideAmount = low & 0x0f; voice->mem.tslide = low; break;
            case 0x10: voice->tempoSlideDir = 1; voice->tempoSlideAmount = low & 0x0f; voice->mem.tslide = low; break;
            default: break;
            }
        }
        break;
    }
    case OP_V:
        e->globalVolume = (rawArg >> 8) & 0xff;
        break;
    case OP_W: {
        int arg = resolve_arg(rawArg, voice->mem.w);
        int hi, lo, hin;
        if (rawArg != 0) voice->mem.w = arg;
        hi = (arg >> 8) & 0xff;
        lo = hi & 0x0f;
        hin = (hi >> 4) & 0x0f;
        if (hi == 0xff) e->globalVolume = imin(e->globalVolume + 0xf, 0xff);
        else if (hin == 0xf && lo != 0) e->globalVolume = imax(e->globalVolume - lo, 0);
        else if (lo == 0xf && hin != 0) e->globalVolume = imin(e->globalVolume + hin, 0xff);
        else if (hin == 0 && lo != 0) { voice->wSlideDir = -1; voice->wSlideAmount = lo; }
        else if (lo == 0 && hin != 0) { voice->wSlideDir = 1; voice->wSlideAmount = hin; }
        break;
    }
    case OP_Y: {
        int sp = (rawArg >> 8) & 0xff;
        int dp = rawArg & 0xff;
        if (sp != 0) voice->mem.ySpeed = sp;
        if (dp != 0) voice->mem.yDepth = dp;
        voice->panbrelloActive = true;
        break;
    }
    case OP_X: {
        double ang[2];
        if (e->ts_surroundModel == SURROUND_STEREO) break;
        te_angles_from_spatial_arg(rawArg, ang);
        te_apply_pan_set(e, voice, ang[0]);
        te_apply_elevation(e, voice, ang[1]);
        break;
    }
    case OP_4: {
        double ang[2];
        if (e->ts_surroundModel == SURROUND_STEREO) break;
        te_angles_from_spatial_arg(rawArg, ang);
        voice->spatialTargetAz = ang[0];
        voice->spatialTargetEl = e->ts_surroundModel == SURROUND_SPATIAL ? ang[1] : 0.0;
        break;
    }
    case OP_Z: {
        int raw, arg;
        if ((rawArg & 0xf000) == 0xf000) {
            voice->funkMode = (rawArg >> 8) & 0xf;
            voice->funkSpeed = rawArg & 0xff;
            break;
        }
        if (e->ts_surroundModel == SURROUND_STEREO) break;
        raw = rawArg & 0xfff;
        arg = resolve_arg(raw, voice->mem.z);
        if (raw != 0) voice->mem.z = arg;
        if (arg != 0) { voice->spatialSlideActive = true; voice->channelPanSet = true; }
        break;
    }
    default:
        break;
    }
}

static void apply_s_effect(TaudEngine *e, TaudVoice *voice, int vi, int arg)
{
    int sub = (arg >> 12) & 0xf;
    int x = (arg >> 8) & 0xf;
    switch (sub) {
    case 0x0:
        if (e->interpolationMode == INTERP_A500 || e->interpolationMode == INTERP_A1200) e->ledFilterOn = x == 0;
        break;
    case 0x1: voice->glissandoOn = x != 0; break;
    case 0x2:
        voice->noteVal = dclamp(voice->noteVal + FINETUNE_OFFSET[x], 0x20, 0xffff);
        voice->basePitch = voice->noteVal;
        voice->amigaPeriod = -1.0;
        voice->linearFreq = -1.0;
        voice->playbackRate = te_compute_playback_rate(e, voice, voice->noteVal, e->tuningRatio);
        break;
    case 0x3: voice->vibratoWave = x & 3; voice->vibratoRetrig = (x & 4) == 0; break;
    case 0x4: voice->tremoloWave = x & 3; voice->tremoloRetrig = (x & 4) == 0; break;
    case 0x5: voice->panbrelloWave = x & 3; voice->panbrelloRetrig = (x & 4) == 0; break;
    case 0x6: e->finePatternDelayExtra += x; break;
    case 0x7: {
        bool isMeta = voice->metaForeground;
        switch (x) {
        case 0x0: if (!isMeta) te_apply_past_note_action(e, vi, 0); break;
        case 0x1: if (!isMeta) te_apply_past_note_action(e, vi, 1); break;
        case 0x2: if (!isMeta) te_apply_past_note_action(e, vi, 2); break;
        case 0x3: voice->nnaOverride = 1; break;
        case 0x4: voice->nnaOverride = 2; break;
        case 0x5: voice->nnaOverride = 0; break;
        case 0x6: voice->nnaOverride = 3; break;
        case 0x7: FOR_EACH_LAYER_TARGET(e, voice, vi, v, { v->volEnvOn = false; }); break;
        case 0x8: FOR_EACH_LAYER_TARGET(e, voice, vi, v, { v->volEnvOn = true; }); break;
        case 0x9: FOR_EACH_LAYER_TARGET(e, voice, vi, v, { v->panEnvOn = false; }); break;
        case 0xa: FOR_EACH_LAYER_TARGET(e, voice, vi, v, { v->panEnvOn = true; }); break;
        case 0xb: FOR_EACH_LAYER_TARGET(e, voice, vi, v, {
            if (v->hasPitchEnv) v->pitchEnvOn = false; else if (v->hasFilterEnv) v->filterEnvOn = false;
        }); break;
        case 0xc: FOR_EACH_LAYER_TARGET(e, voice, vi, v, {
            if (v->hasPitchEnv) v->pitchEnvOn = true; else if (v->hasFilterEnv) v->filterEnvOn = true;
        }); break;
        case 0xd: FOR_EACH_LAYER_TARGET(e, voice, vi, v, { v->filterEnvOn = false; }); break;
        case 0xe: FOR_EACH_LAYER_TARGET(e, voice, vi, v, { v->filterEnvOn = true; }); break;
        default: break;
        }
        break;
    }
    case 0xa:
        /* S $Apsd — on an FM rack (§5.5.1), operator p's auto-vibrato: speed
         * s × 17, depth d × 17, for this note. The rack takes the command
         * whole, so a PSG operator inside it takes no register write. */
        if (voice->fmRig != NULL) {
            te_fm_set_operator_vibrato(voice->fmRig, x, (arg >> 4) & 0xf, arg & 0xf);
            break;
        }
        /* S $Afgr — on a voice sounding a formant instrument (item 212), the
         * vowel: openness f, frontness g, roundness r. The note's whole tract
         * hears it, layer children included.
         * S $Axxx — on a voice sounding a PSG instrument (§7.9), a register
         * write into that INSTRUMENT's run-time overlay: auto-advance, level,
         * mute, lasting until the next playback as invert loop's mask does.
         * On any other instrument it does nothing. */
        FOR_EACH_LAYER_TARGET(e, voice, vi, v, {
            if (v->formant != NULL) te_formant_set_vowel(v->formant, x, (arg >> 4) & 0xf, arg & 0xf);
            else if (v->psg != NULL && v->psg->patch != NULL) te_psg_write_register(v->psg->patch, arg & 0xfff);
        });
        break;
    case 0x9:
        /* S $9xxx — formant control (item 292), on every voice sounding a
         * formant instrument, layer children included: $90kx sets the vowel's
         * nasalisation and r-colouring and calls the coda, $91xx the note's
         * glide time. On any other instrument it does nothing. */
        FOR_EACH_LAYER_TARGET(e, voice, vi, v, {
            if (v->formant != NULL) te_formant_command(e, v->formant, arg & 0xfff);
        });
        break;
    case 0x8:
        te_apply_pan_set(e, voice, arg & (e->ts_surroundModel == SURROUND_STEREO ? 0xff : 0x1ff));
        break;
    case 0xb:
        if (x == 0) voice->loopStartRow = e->rowIndex;
        else if (voice->loopCount == 0) {
            voice->loopCount = x;
            e->pendingRowJump = voice->loopStartRow;
            e->pendingRowJumpLocal = true;
        } else if (!e->patternDelayActive) {
            voice->loopCount--;
            if (voice->loopCount > 0) {
                e->pendingRowJump = voice->loopStartRow;
                e->pendingRowJumpLocal = true;
            }
        }
        break;
    case 0xc: if (x != 0) voice->cutAtTick = x; break;
    case 0xd: break;
    case 0xe:
        if (e->sexWinningChannel < 0) {
            e->sexWinningChannel = vi;
            e->patternDelayRemaining = x;
        }
        break;
    case 0xf:
        voice->invertSpeed = arg & 0xff;
        voice->invertAccumulator = 0;
        break;
    default:
        break;
    }
}

/* One instrument per layer target is stepped: `seen` holds the ids visited. */
typedef struct { int ids[META_MAX_LAYERS + 1 + MAX_BG_VOICES * 2]; int n; } SeenSet;

static bool seen_add(SeenSet *s, int id)
{
    int i;
    for (i = 0; i < s->n; i++) if (s->ids[i] == id) return true;
    if (s->n < (int)(sizeof s->ids / sizeof s->ids[0])) s->ids[s->n++] = id;
    return false;
}

static void sample_mod_classic(TaudEngine *e, TaudVoice *v, int rawArg, bool invert, SeenSet *seen)
{
    TaudInst *inst = &e->instruments[v->instrumentId];
    int op = (rawArg >> 4) & 0xf;
    bool dup = seen_add(seen, v->instrumentId);
    double region[4];
    int code;
    bool moved, swapped;
    if (op == MOD_OFF) {
        if (!dup) te_inst_reset_mod(inst);
        v->modPeriod = 0;
        v->modTickCount = 0;
        v->modWritePos = 0;
        v->modExtended = false;
        return;
    }
    code = te_decode_sample_region((rawArg >> 8) & 0xff, region);
    if (code == REGION_NONE) return;
    if (dup) { v->modPeriod = 0; return; }
    moved = code == REGION_COMB
        ? te_inst_set_mod_comb(inst, (int)region[2], region[3] != 0)
        : te_inst_set_mod_region(inst, region[0], region[1]);
    swapped = te_inst_set_mod_op(inst, op, invert);
    if (moved || swapped) {
        v->modTickCount = 0;
        v->modWritePos = 0;
    }
    v->modPeriod = te_mod_step_period(rawArg & 0xf);
    v->modExtended = false;
}

static void sample_mod_ext(TaudEngine *e, TaudVoice *v, int rawArg, bool invert, int ext, SeenSet *seen)
{
    TaudInst *inst = &e->instruments[v->instrumentId];
    int f = (ext >> 12) & 0xf;
    int xuu = (((rawArg >> 4) & 0xf) << 8) | ((ext >> 4) & 0xff);
    int yk = ((rawArg & 0xf) << 4) | (ext & 0xf);
    bool dup = seen_add(seen, v->instrumentId);
    double region[4];
    int code;
    bool moved, swapped;
    if (xuu == 0) {
        if (!dup) te_inst_reset_mod(inst);
        v->modPeriod = 0;
        v->modTickCount = 0;
        v->modWritePos = 0;
        v->modExtended = false;
        v->modStepTicks = 0;
        v->modSamplesIntoStep = 0;
        return;
    }
    code = te_decode_sample_region((rawArg >> 8) & 0xff, region);
    if (code == REGION_NONE) return;
    if (dup) { v->modPeriod = 0; v->modExtended = false; return; }
    moved = code == REGION_COMB
        ? te_inst_set_mod_comb(inst, (int)region[2], region[3] != 0)
        : te_inst_set_mod_region(inst, region[0], region[1]);
    swapped = te_inst_set_mod_op_ext(inst, xuu, invert, f);
    if (moved || swapped) {
        v->modTickCount = 0;
        v->modWritePos = 0;
        v->modSamplesIntoStep = 0;
    }
    v->modPeriod = 0;
    v->modExtended = true;
    v->modStepTicks = te_ext_yk_period_ticks(yk);
}

static void apply_sample_mod_effect(TaudEngine *e, TaudVoice *voice, int vi, int rawArg, bool invert, int ext, bool hasExt)
{
    SeenSet seen;
    seen.n = 0;
    if (hasExt) {
        FOR_EACH_LAYER_TARGET(e, voice, vi, v, { sample_mod_ext(e, v, rawArg, invert, ext, &seen); });
    } else {
        FOR_EACH_LAYER_TARGET(e, voice, vi, v, { sample_mod_classic(e, v, rawArg, invert, &seen); });
    }
}

static void filter_param_push(TaudEngine *e, TaudVoice *v, const SeenSet *targets, bool isResonance)
{
    int i;
    bool found = false;
    const TaudInst *ti;
    const TaudPatch *patch;
    bool patchExtra, overridden;
    for (i = 0; i < targets->n; i++) if (targets->ids[i] == v->instrumentId) { found = true; break; }
    if (!found) return;
    ti = &e->instruments[v->instrumentId];
    patch = te_patch_at(ti, v->activePatchIndex);
    patchExtra = patch != NULL && patch->hasExtra;
    overridden = ti->cutoffOverride >= 0 || ti->resonanceOverride >= 0;
    v->filterSfMode = patchExtra && !overridden ? patch->filterSfMode : inst_filter_sf_mode(ti);
    if (isResonance) {
        v->activeDefaultResonance = ti->resonanceOverride < 0 && patchExtra
            ? patch->extraResonance : inst_default_resonance16(ti);
        v->currentResonance = v->activeDefaultResonance;
    } else {
        v->activeDefaultCutoff = ti->cutoffOverride < 0 && patchExtra
            ? patch->extraCutoff : inst_default_cutoff16(ti);
        v->currentCutoff = v->activeDefaultCutoff;
    }
    v->filterCutoffCached = -1;
    v->filterResonanceCached = -1;
}

/* notefx 5 (cutoff) / 6 (resonance) — instrument-wide filter parameters. */
static void apply_filter_param_effect(TaudEngine *e, TaudVoice *voice, int vi, int rawArg, bool isResonance)
{
    SeenSet targets;
    int i;
    targets.n = 0;
    seen_add(&targets, voice->instrumentId);
    for (i = 0; i < e->bgCount; i++) {
        if (te_is_sounding_child(e, e->bg[i], vi)) seen_add(&targets, e->bg[i]->instrumentId);
    }
    for (i = 0; i < targets.n; i++) {
        TaudInst *ti = &e->instruments[targets.ids[i]];
        int value;
        if (rawArg == 0xffff) value = -1;
        else if (inst_filter_sf_mode(ti)) value = rawArg & 0xffff;
        else value = (rawArg >> 8) & 0xff;
        if (isResonance) ti->resonanceOverride = value;
        else ti->cutoffOverride = value;
    }
    for (i = 0; i < TOTAL_VOICES; i++) if (e->voices[i].active) filter_param_push(e, &e->voices[i], &targets, isResonance);
    for (i = 0; i < e->bgCount; i++) if (e->bg[i]->active) filter_param_push(e, e->bg[i], &targets, isResonance);
}

int te_apply_retrig_vol_mod(int vol, int x, int step, int max)
{
    int v;
    switch (x & 0xf) {
    case 0: case 8: v = vol; break;
    case 1: v = vol - 0x01 * step; break;
    case 2: v = vol - 0x02 * step; break;
    case 3: v = vol - 0x04 * step; break;
    case 4: v = vol - 0x08 * step; break;
    case 5: v = vol - 0x10 * step; break;
    case 6: v = (vol * 2) / 3; break;
    case 7: v = asr32(vol, 1); break;
    case 9: v = vol + 0x01 * step; break;
    case 0xa: v = vol + 0x02 * step; break;
    case 0xb: v = vol + 0x04 * step; break;
    case 0xc: v = vol + 0x08 * step; break;
    case 0xd: v = vol + 0x10 * step; break;
    case 0xe: v = (vol * 3) / 2; break;
    case 0xf: v = vol << 1; break;
    default: v = vol; break;
    }
    return iclamp(v, 0, max);
}
