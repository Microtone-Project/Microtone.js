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
 * JavaScript face.
 *
 * Beyond a voice's walks, the pieces a test drives on their own: the binaural
 * head, an instrument mixing chain, an OPL channel and a PSG pair keyed by
 * hand, the sample-modification decoders and the engine's tables. A pointer
 * one of these returns lives until the matching _free (or the instance). */

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

/* ── jsmath.c ── */

/* The engine's own pow and exp (V8's fdlibm ports): what a test's reference
 * formula calls to be the engine's arithmetic to the bit on any platform. */
TW_EXPORT(tw_part_pow)
double tw_part_pow(double x, double y) { return js_pow(x, y); }

TW_EXPORT(tw_part_exp)
double tw_part_exp(double x) { return js_exp(x); }

/* ── binaural.c ── */

TW_EXPORT(tw_part_binaural_new)
TaudBinaural *tw_part_binaural_new(int sphere, int rate) { return te_binaural_new(sphere != 0, rate); }

TW_EXPORT(tw_part_binaural_free)
void tw_part_binaural_free(TaudBinaural *b) { te_binaural_free(b); }

TW_EXPORT(tw_part_binaural_reset)
void tw_part_binaural_reset(TaudBinaural *b) { te_binaural_reset(b); }

TW_EXPORT(tw_part_binaural_channel_gains)
void tw_part_binaural_channel_gains(const TaudBinaural *b, double az, double el, double *out, int off)
{
    te_binaural_channel_gains(b, az, el, out, off);
}

/* A whole bus of `frames` frames, channel-major, decoded frame by frame in
 * order into `left` and `right` (monitorStereo once per frame). */
TW_EXPORT(tw_part_binaural_decode)
void tw_part_binaural_decode(TaudBinaural *b, const double *data, int frames, double *left, double *right)
{
    double pair[2];
    int n;
    for (n = 0; n < frames; n++) {
        te_binaural_monitor_stereo(b, data, frames, n, pair);
        left[n] = pair[0];
        right[n] = pair[1];
    }
}

/* The measured set as it is stored: 16 channels × 256 taps, int16, channel-major. */
TW_EXPORT(tw_part_hrir_table)
const int16_t *tw_part_hrir_table(void) { return HRIR_SADIE; }

/* ── spatial.c ── */

TW_EXPORT(tw_part_encode_sn3d)
void tw_part_encode_sn3d(double az, double el, int order, double *out) { te_encode_sn3d(az, el, order, out); }

TW_EXPORT(tw_part_sample_channel_layout)
double tw_part_sample_channel_layout(int chans, int k) { return te_sample_channel_layout(chans, k); }

TW_EXPORT(tw_part_sample_channel_angles)
void tw_part_sample_channel_angles(double az, double el, double localAz, double *out)
{
    te_sample_channel_angles(az, el, localAz, out);
}

/* ── imix.c ── */

/* A chain on the first valid block of an IMix section payload (the bytes a
 * file carries), or NULL when the payload holds none. */
TW_EXPORT(tw_part_imix_chain_new)
TaudImxChain *tw_part_imix_chain_new(const uint8_t *payload, int len, int rate, int nch, int stereo, int ambisonic)
{
    TaudImixBlock *blocks = NULL;
    TaudImxChain *c = NULL;
    int n = te_imix_parse_section(payload, (size_t)len, &blocks);
    if (n > 0) c = te_imx_chain_new(&blocks[0], rate, nch, stereo != 0, ambisonic != 0);
    free(blocks);
    return c;
}

/* Install the first valid block of `payload` (setBlock); 0 when it holds none. */
TW_EXPORT(tw_part_imix_chain_set_block)
int tw_part_imix_chain_set_block(TaudImxChain *c, const uint8_t *payload, int len)
{
    TaudImixBlock *blocks = NULL;
    int n = te_imix_parse_section(payload, (size_t)len, &blocks);
    if (n > 0) te_imx_chain_set_block(c, &blocks[0]);
    free(blocks);
    return n > 0;
}

TW_EXPORT(tw_part_imix_chain_free)
void tw_part_imix_chain_free(TaudImxChain *c) { te_imx_chain_free(c); }

TW_EXPORT(tw_part_imix_chain_reset)
void tw_part_imix_chain_reset(TaudImxChain *c) { te_imx_chain_reset(c); }

TW_EXPORT(tw_part_imix_chain_note_on)
void tw_part_imix_chain_note_on(TaudImxChain *c) { te_imx_chain_note_on(c); }

TW_EXPORT(tw_part_imix_chain_idle)
int tw_part_imix_chain_idle(const TaudImxChain *c) { return te_imx_chain_idle(c); }

TW_EXPORT(tw_part_imix_chain_process)
void tw_part_imix_chain_process(TaudImxChain *c, double *data, int stride, int n0, int n1, int bpm, int fed)
{
    te_imx_chain_process(c, data, stride, n0, n1, bpm, fed != 0);
}

TW_EXPORT(tw_part_imix_chain_read_gr)
void tw_part_imix_chain_read_gr(const TaudImxChain *c, TaudImxGr *out) { te_imx_chain_read_gr(c, out); }

/* The unison's live detune and width into out[0], out[1]; 0 without one. */
TW_EXPORT(tw_part_imix_chain_unison_now)
int tw_part_imix_chain_unison_now(const TaudImxChain *c, double *out)
{
    return te_imx_chain_unison_now(c, &out[0], &out[1]);
}

/* An LFO's phase increment per sample (a double: it fits in 32 bits). */
TW_EXPORT(tw_part_imix_lfo_increment)
double tw_part_imix_lfo_increment(int sync, double rate, int bpm, int fs)
{
    return (double)te_imx_lfo_increment(sync != 0, (uint32_t)rate, bpm, fs);
}

/* ── opl.c ── */

/* A patch decoded from its 54-byte block, of its own. */
TW_EXPORT(tw_part_opl_patch_new)
TaudOplPatch *tw_part_opl_patch_new(const uint8_t *block)
{
    TaudOplPatch *p = (TaudOplPatch *)calloc(1, sizeof *p);
    if (p != NULL) te_decode_opl_patch(block, p);
    return p;
}

/* A fresh channel, as a voice is given one. */
TW_EXPORT(tw_part_opl_state_new)
TaudOplState *tw_part_opl_state_new(void)
{
    TaudOplState *st = (TaudOplState *)calloc(1, sizeof *st);
    if (st != NULL) te_opl_state_init(st);
    return st;
}

TW_EXPORT(tw_part_opl_key_on)
void tw_part_opl_key_on(TaudOplState *st, const TaudOplPatch *patch, int carry) { te_opl_key_on(st, patch, carry != 0); }

TW_EXPORT(tw_part_opl_key_off)
void tw_part_opl_key_off(TaudOplState *st) { te_opl_key_off(st); }

TW_EXPORT(tw_part_opl_render)
double tw_part_opl_render(TaudEngine *e, TaudOplState *st, double frame, double rate, double vol, int keyOff)
{
    return te_opl_render(e, st, (int64_t)frame, rate, vol, keyOff != 0);
}

TW_EXPORT(tw_part_opl_chip_step)
int tw_part_opl_chip_step(TaudOplState *st, double k) { return te_opl_chip_step(st, (int64_t)k); }

TW_EXPORT(tw_part_opl_expand)
int tw_part_opl_expand(double att) { return te_opl_expand(att); }

TW_EXPORT(tw_part_opl_block_fnum)
int tw_part_opl_block_fnum(double hz, int lowFnum) { return te_opl_block_fnum(hz, lowFnum != 0); }

TW_EXPORT(tw_part_opl_log_sin)
const uint16_t *tw_part_opl_log_sin(void) { return OPL_LOG_SIN; }

TW_EXPORT(tw_part_opl_exp)
const uint16_t *tw_part_opl_exp(void) { return OPL_EXP; }

/* ── psg.c ── */

TW_EXPORT(tw_part_psg_patch_new)
TaudPsgPatch *tw_part_psg_patch_new(const uint8_t *block)
{
    TaudPsgPatch *p = (TaudPsgPatch *)calloc(1, sizeof *p);
    if (p == NULL) return NULL;
    te_psg_clear_runtime(p);    /* no S $Axxx overlay: the record's own values */
    te_decode_psg_patch(block, p);
    return p;
}

TW_EXPORT(tw_part_psg_state_new)
TaudPsgState *tw_part_psg_state_new(void)
{
    TaudPsgState *st = (TaudPsgState *)calloc(1, sizeof *st);
    if (st != NULL) te_psg_state_init(st);
    return st;
}

TW_EXPORT(tw_part_psg_key_on)
void tw_part_psg_key_on(TaudPsgState *st, TaudPsgPatch *patch, int carry) { te_psg_key_on(st, patch, carry != 0); }

TW_EXPORT(tw_part_psg_key_off)
void tw_part_psg_key_off(TaudPsgState *st) { te_psg_key_off(st); }

TW_EXPORT(tw_part_psg_quarter_tick)
void tw_part_psg_quarter_tick(TaudPsgState *st) { te_psg_quarter_tick(st); }

TW_EXPORT(tw_part_psg_current_wave)
int tw_part_psg_current_wave(const TaudPsgState *st, int i) { return te_psg_current_wave(st, i); }

TW_EXPORT(tw_part_psg_render)
double tw_part_psg_render(TaudEngine *e, TaudPsgState *st, double frame, double rate, int keyOff)
{
    return te_psg_render(e, st, (int64_t)frame, rate, keyOff != 0);
}

TW_EXPORT(tw_part_psg_write_register)
int tw_part_psg_write_register(TaudPsgPatch *patch, int reg) { return te_psg_write_register(patch, reg); }

TW_EXPORT(tw_part_psg_level)
int tw_part_psg_level(const TaudPsgPatch *patch, int i) { return te_psg_level(patch, i); }

TW_EXPORT(tw_part_psg_muted)
int tw_part_psg_muted(const TaudPsgPatch *patch, int i) { return te_psg_muted(patch, i); }

/* ── samplemod.c ── */

TW_EXPORT(tw_part_decode_sample_region)
int tw_part_decode_sample_region(int se, double *out) { return te_decode_sample_region(se, out); }

TW_EXPORT(tw_part_mod_step_period)
int tw_part_mod_step_period(int y) { return te_mod_step_period(y); }

TW_EXPORT(tw_part_jump_rot)
int tw_part_jump_rot(TaudEngine *e, int op, int domainLen) { return te_jump_rot(e, op, domainLen); }

TW_EXPORT(tw_part_scatter_reach)
int tw_part_scatter_reach(int op, int domainLen) { return te_scatter_reach(op, domainLen); }

/* The decoded extended operation: its kind (EXT_KIND_*) returned, its
 * parameter in *param. */
TW_EXPORT(tw_part_decode_ext_op)
int tw_part_decode_ext_op(int code, double *param)
{
    TaudExtOp op = te_decode_ext_op(code);
    *param = op.param;
    return op.kind;
}

TW_EXPORT(tw_part_ext_jitter_frac)
double tw_part_ext_jitter_frac(int x) { return te_ext_jitter_frac(x); }

TW_EXPORT(tw_part_ext_yk_period_ticks)
double tw_part_ext_yk_period_ticks(int yk) { return te_ext_yk_period_ticks(yk); }

TW_EXPORT(tw_part_apply_ext_level_prev)
int tw_part_apply_ext_level_prev(const TaudInst *inst, int b) { return te_apply_ext_level_prev(inst, b); }

/* ── formant.c ── */

TW_EXPORT(tw_part_equal_loudness_db)
double tw_part_equal_loudness_db(const TaudEngine *e, double f)
{
    int j = 0;
    return te_elw_db(&e->formantTables, f, &j);
}

/* ── tables.c ── */

TW_EXPORT(tw_part_lfo_sample_wide)
int tw_part_lfo_sample_wide(TaudEngine *e, int pos, int wave) { return te_lfo_sample_wide(e, pos, wave); }

TW_EXPORT(tw_part_advance_lfo_phase)
int tw_part_advance_lfo_phase(int pos, int speed) { return te_advance_lfo_phase(pos, speed); }

/* A read-only table of the engine's, by name: its address, and its length
 * (elements) in *len. 0 for a name it does not have. */
TW_EXPORT(tw_part_table)
const void *tw_part_table(int which, int *len)
{
    switch (which) {
    case 0: *len = 512; return SNES_GAUSS;
    case 1: *len = 64; return MOD_SIN_TABLE;
    case 2: *len = 16; return MOD_STEP;
    case 3: *len = 2; return MOD_JUMP_SLICES;
    case 4: *len = 3; return MOD_SCATTER_FRAC;
    case 5: *len = 16; return EXT_JUMP_N;
    case 6: *len = 16; return EXT_SCATTER_FRAC;
    default: *len = 0; return NULL;
    }
}
