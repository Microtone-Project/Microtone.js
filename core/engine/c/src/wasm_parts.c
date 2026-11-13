/* The engine's parts, callable one at a time — for the tests.
 *
 * A song played from the top exercises every one of these, and the golden
 * gate pins the result; but a rule such as "a zero-duration envelope node is
 * skipped by the pitch walk and held by the volume walk" is pinned far more
 * sharply by calling the walk on a voice made for the purpose. The JavaScript
 * engine allowed that by exporting its functions; these exports are the same
 * functions of this one, under the same names (tw_part_<the function>).
 *
 * Nothing in the apps calls them. test/fixtures/engine-parts.js is their
 * JavaScript face. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

/* A voice of its own: not a lane's, not in the background list, not from the
 * pool (so the pool's collector never hands it out again). It lives as long
 * as the module instance does. */
TW_EXPORT(tw_part_voice_new)
TaudVoice *tw_part_voice_new(void)
{
    TaudVoice *v = (TaudVoice *)calloc(1, sizeof *v);
    if (v != NULL) te_voice_init(v);
    return v;
}

/* A fresh voice IN the background list, as an NNA would have left one. */
TW_EXPORT(tw_part_bg_voice)
TaudVoice *tw_part_bg_voice(TaudEngine *e)
{
    TaudVoice *v = te_voice_alloc(e);
    if (v != NULL) te_bg_push(e, v);
    return v;
}

/* ── envelope.c ── */

TW_EXPORT(tw_part_advance_auto_vibrato)
int tw_part_advance_auto_vibrato(TaudEngine *e, TaudVoice *v) { return te_advance_auto_vibrato(e, v); }

TW_EXPORT(tw_part_apply_key_lift)
void tw_part_apply_key_lift(TaudVoice *v, const TaudInst *inst) { te_apply_key_lift(v, inst); }

TW_EXPORT(tw_part_force_key_lift)
void tw_part_force_key_lift(TaudVoice *v) { te_force_key_lift(v); }

TW_EXPORT(tw_part_advance_envelope)
void tw_part_advance_envelope(TaudEngine *e, TaudVoice *v, double tickSec) { te_advance_envelope(e, v, tickSec); }

TW_EXPORT(tw_part_seed_pf_role)
double tw_part_seed_pf_role(const TaudEnvPoint *env, int loopWord, int susWord, int *idxOut, double *timeOut)
{
    return te_seed_pf_role(env, loopWord, susWord, idxOut, timeOut);
}

TW_EXPORT(tw_part_advance_pf_role)
double tw_part_advance_pf_role(const TaudEnvPoint *env, int loopWord, int susWord, int keyOff,
                               double tickSec, int *idxBox, double *timeBox)
{
    return te_advance_pf_role(env, loopWord, susWord, keyOff != 0, tickSec, idxBox, timeBox);
}

/* ── filter.c ── */

TW_EXPORT(tw_part_refresh_voice_filter)
void tw_part_refresh_voice_filter(TaudEngine *e, TaudVoice *v) { te_refresh_voice_filter(e, v); }

TW_EXPORT(tw_part_advance_filter_glide)
void tw_part_advance_filter_glide(TaudEngine *e, TaudVoice *v) { te_advance_filter_glide(e, v); }

/* ── sampler.c ── */

TW_EXPORT(tw_part_fetch_tracker_sample)
double tw_part_fetch_tracker_sample(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode)
{
    return te_fetch_tracker_sample(e, v, inst, interpMode, 0.0);
}

TW_EXPORT(tw_part_read_sample_point)
double tw_part_read_sample_point(TaudEngine *e, TaudVoice *v, TaudInst *inst, int idx,
                                 int sampleLen, int binMax, uint32_t basePtr)
{
    return te_read_sample_point(e, v, inst, idx, sampleLen, binMax, basePtr);
}

TW_EXPORT(tw_part_advance_pitch_ramp)
void tw_part_advance_pitch_ramp(TaudEngine *e, TaudVoice *v, double spt) { te_advance_pitch_ramp(e, v, spt); }

/* ── trigger.c ── */

TW_EXPORT(tw_part_apply_active_sample)
void tw_part_apply_active_sample(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch)
{
    te_apply_active_sample(v, inst, patch);
}

TW_EXPORT(tw_part_resolve_active_envelopes)
void tw_part_resolve_active_envelopes(TaudVoice *v, const TaudInst *inst, const TaudPatch *patch)
{
    te_resolve_active_envelopes(v, inst, patch);
}

/* The copy an NNA takes of a sounding voice. It comes from the pool and is in
 * no list yet (the caller of the real thing pushes it): read it at once. */
TW_EXPORT(tw_part_ghost_voice)
TaudVoice *tw_part_ghost_voice(TaudEngine *e, const TaudVoice *src, int channel)
{
    return te_ghost_voice(e, src, channel);
}

/* ── effects.c ── */

TW_EXPORT(tw_part_apply_effect_row)
void tw_part_apply_effect_row(TaudEngine *e, TaudVoice *v, int vi, int op, int rawArg, int ext, int hasExt)
{
    te_apply_effect_row(e, v, vi, op, rawArg, ext, hasExt != 0);
}

TW_EXPORT(tw_part_apply_filter_param_effect)
void tw_part_apply_filter_param_effect(TaudEngine *e, TaudVoice *v, int vi, int rawArg, int isResonance)
{
    te_apply_filter_param_effect(e, v, vi, rawArg, isResonance != 0);
}

/* ── fm.c ── */

TW_EXPORT(tw_part_fm_referenced_operators)
void tw_part_fm_referenced_operators(const uint16_t *program, int len, int count, uint8_t *used)
{
    te_fm_referenced_operators(program, len, count, used);
}
