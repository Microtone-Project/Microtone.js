/* FM operator racks — Metainstrument type 4 — port of fm.js.
 *
 * An operator may also be a low-meta instrument — an OPL channel or a PSG
 * pair — which is a generator rather than a waveform to read at an offset:
 * the modulation goes into the phase of what the channel outputs.
 *
 * A rig lives inside the voice that owns it (voice.rigStore): in the JS every
 * rig belongs to exactly one voice, is created by that voice's trigger (or by
 * a ghost's clone), and dies when the voice drops it, so embedding is exact. */

#include <string.h>

#include "taud_internal.h"

void te_fm_rig_init(TaudFmRig *rig, int count)
{
    memset(rig, 0, sizeof *rig);
    rig->count = count;
}

/* The rack's non-voice state onto a fresh rig: algorithm, gains, feedback taps. */
void te_fm_rig_clone(TaudFmRig *dst, const TaudFmRig *src)
{
    int k;
    te_fm_rig_init(dst, src->count);
    dst->program = src->program;
    dst->programLen = src->programLen;
    for (k = 0; k < src->count; k++) {
        dst->gain[k] = src->gain[k];
        dst->last[k] = src->last[k];
    }
}

void te_fm_referenced_operators(const uint16_t *program, int len, int count, uint8_t *used)
{
    int i;
    memset(used, 0, (size_t)count);
    if (program == NULL) return;
    for (i = 0; i < len; i++) {
        int w = program[i], cls, k;
        if (w >= FM_WORD_OP) continue;
        cls = w & ~FM_INDEX_MASK;
        if (cls != FM_WORD_OSC && cls != FM_WORD_MOD) continue;
        k = w & FM_INDEX_MASK;
        if (k < count) used[k] = 1;
    }
}

void te_fm_seed_gains(TaudFmRig *rig, const TaudMeta *meta)
{
    int k;
    for (k = 0; k < rig->count && k < meta->count; k++) {
        rig->gain[k] = META_MIX_GAIN[meta->layers[k].mixOctet & 0xff];
    }
}

static double fm_cycle_frames(const TaudVoice *v)
{
    int span = v->activeSampleLoopEnd - v->activeSampleLoopStart;
    if ((v->activeLoopMode & 3) != 0 && span > 0) return span;
    return imax(v->activeSampleLength, 1);
}

/* An OPL operator's value at output frame `frame`, read with `offset` cycles
 * of phase modulation (one cycle = 1024 of the chip's phase steps), at unity
 * volume. A channel that has rung out ends its operator. */
static double fm_chip_operator(TaudEngine *e, TaudVoice *v, int64_t frame, double offset)
{
    TaudOplState *st = v->opl;
    double s;
    st->pm = offset == 0 ? 0 : js_round(offset * 1024);
    s = te_opl_render(e, st, frame, v->currentPlaybackRate, 1.0, v->keyOff);
    st->pm = 0;
    if (!te_opl_channel_alive(st)) v->active = false;
    return s;
}

/* A PSG operator, read the same way: one cycle of the oscillator a cycle. */
static double fm_psg_operator(TaudEngine *e, TaudVoice *v, int64_t frame, double offset)
{
    TaudPsgState *st = v->psg;
    double s;
    st->pm = offset == 0 ? 0 : fmod(js_round((offset - floor(offset)) * 4294967296.0), 4294967296.0);
    s = te_psg_render(e, st, frame, v->currentPlaybackRate, v->keyOff);
    st->pm = 0;
    if (!te_psg_channel_alive(st)) v->active = false;
    return s;
}

static double fm_eval_operator(TaudEngine *e, TaudFmRig *rig, int k, int interpMode, double spt, double offset,
                               int64_t frame)
{
    TaudVoice *v;
    TaudInst *inst;
    double frames, s, g, out;
    if (rig->done[k] != 0) return rig->cur[k];
    rig->done[k] = 1;
    v = rig->voices[k];
    if (v == NULL || !v->active) { rig->cur[k] = 0.0; return 0.0; }
    inst = &e->instruments[v->instrumentId];
    if (v->opl != NULL) {
        s = fm_chip_operator(e, v, frame, offset);
    } else if (v->psg != NULL) {
        s = fm_psg_operator(e, v, frame, offset);
    } else {
        frames = offset == 0 ? 0 : offset * fm_cycle_frames(v);
        s = te_fetch_tracker_sample(e, v, inst, interpMode, frames);
    }
    g = rig->gain[k];
    if (k != 0) {
        double effEnvVol;
        s = te_apply_voice_filter_self(v, s);
        te_advance_filter_glide(e, v);
        v->envVolMix += v->envVolStep;
        effEnvVol = v->hasVolEnv && v->volEnvOn ? v->envVolMix : 1.0;
        te_advance_volume_ramp(e, v, e->volDiv);
        te_advance_pitch_ramp(e, v, spt);
        g *= effEnvVol * te_advance_fadeout(v) * v->activeAttenGain * (inst->instGlobalVolume / 255.0);
        if (v->rampOutSamples > 0) {
            g *= v->rampOutGain;
            v->rampOutGain -= v->rampOutStep;
            v->rampOutSamples--;
            if (v->rampOutSamples == 0) v->active = false;
        }
        if (v->attackRampSamples > 0) {
            int elapsed = e->attackRampSamples - v->attackRampSamples;
            g *= 0.5 - 0.5 * js_cos((3.141592653589793 * elapsed) / e->attackRampSamples);
            v->attackRampSamples--;
        }
    }
    out = s * g;
    rig->cur[k] = out;
    return out;
}

/* Run the rack's algorithm for one output sample. */
double te_render_fm_voice(TaudEngine *e, TaudVoice *voice, int interpMode, double spt, int64_t frame)
{
    TaudFmRig *rig = voice->fmRig;
    const uint16_t *prog = rig->program;
    double *stack = rig->stack;
    int sp = 0, i, k;
    if (prog == NULL) return 0.0;
    memset(rig->done, 0, sizeof rig->done);

    for (i = 0; i < rig->programLen; i++) {
        int w = prog[i], cls;
        double offset;
        if (w >= FM_WORD_OP) {
            switch (w) {
            case FMOP_ADD:
                if (sp >= 2) { double b = stack[--sp]; stack[sp - 1] += b; }
                break;
            case FMOP_MUL:
                if (sp >= 2) { double b = stack[--sp]; stack[sp - 1] *= b; }
                break;
            case FMOP_NEG:
                if (sp >= 1) stack[sp - 1] = -stack[sp - 1];
                break;
            case FMOP_DUP:
                if (sp >= 1 && sp < FM_STACK_MAX) { stack[sp] = stack[sp - 1]; sp++; }
                break;
            case FMOP_SWAP:
                if (sp >= 2) { double b = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = b; }
                break;
            default:
                break;
            }
            continue;
        }
        k = w & FM_INDEX_MASK;
        if (k >= rig->count) continue;
        cls = w & ~FM_INDEX_MASK;
        if (cls == FM_WORD_FB) {
            if (sp < FM_STACK_MAX) stack[sp++] = rig->last[k];
            continue;
        }
        offset = cls == FM_WORD_MOD && sp > 0 ? stack[--sp] : 0.0;
        if (sp < FM_STACK_MAX) stack[sp++] = fm_eval_operator(e, rig, k, interpMode, spt, offset, frame);
    }

    for (k = 0; k < rig->count; k++) if (rig->done[k] != 0) rig->last[k] = rig->cur[k];
    return sp > 0 ? stack[sp - 1] : 0.0;
}

/* True when operator 0 is a DSP-ONLY principal (fmPrincipalIsDsp): the
 * program ends by multiplying everything above it by operator 0 (`$0000
 * $FF01`) and names it nowhere else — the layout an editor's Easy Mode
 * writes, and what `S $Apsd` counts its operators past (§5.5.1). */
bool te_fm_principal_is_dsp(const uint16_t *program, int len)
{
    int i;
    if (program == NULL || len < 3 || program[len - 1] != FMOP_MUL || program[len - 2] != FM_WORD_OSC) return false;
    for (i = 0; i < len - 2; i++) {
        int w = program[i];
        if (w < FM_WORD_OP && (w & FM_INDEX_MASK) == 0) return false;
    }
    return true;
}

/* S $Apsd on a rack (fmSetOperatorVibrato): operator p's auto-vibrato speed
 * and depth, s × 17 and d × 17, for the note now sounding. p counts the
 * oscillators — from entry 1 when the principal is DSP-only, else from 0. An
 * operator that is not sounding this note, or past the rack's end, takes
 * nothing. */
void te_fm_set_operator_vibrato(TaudFmRig *rig, int p, int s, int d)
{
    int k = te_fm_principal_is_dsp(rig->program, rig->programLen) ? p + 1 : p;
    TaudVoice *v = k < rig->count ? rig->voices[k] : NULL;
    if (v == NULL) return;
    v->activeVibratoSpeed = s * 17;
    v->activeVibratoDepth = d * 17;
}

/* Detach and silence every operator the foreground voice of lane `vi` drives. */
void te_drop_fm_operators(TaudEngine *e, int vi)
{
    TaudVoice *fg = &e->voices[vi];
    int i;
    for (i = e->bgCount - 1; i >= 0; i--) {
        TaudVoice *bg = e->bg[i];
        if (bg->fmOperator && bg->fmParent == fg) {
            bg->active = false;
            bg->fmOperator = false;
            bg->fmParent = NULL;
            bg->isLayerChild = false;
            te_bg_remove_at(e, i);
        }
    }
}
