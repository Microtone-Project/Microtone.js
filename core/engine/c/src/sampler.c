/* Sample fetch + interpolators + anti-click ramps — port of sampler.js. */

#include <stdlib.h>

#include "taud_internal.h"

#define FUNK_XFADE_SAMPLES 64

double te_compute_playback_rate(const TaudEngine *e, const TaudVoice *v, double noteVal, double tuningRatio)
{
    return ((double)v->activeSamplingRate / e->rate) *
           js_pow(2.0, (noteVal - MIDDLE_C + v->activeSampleDetune) / 4096.0) *
           tuningRatio;
}

/* The pool byte at `i` with S $Fxxx's own mask applied. */
static int pool_byte(TaudEngine *e, TaudInst *inst, int i, int binMax, uint32_t basePtr, int ls, int le)
{
    int64_t p = (int64_t)basePtr + i;
    int b = te_pool_at(e, p < binMax ? p : binMax);
    if (inst->invertMaskLen != 0 && le > ls && i >= ls && i < le && te_inst_invert_bit(inst, i - ls, le - ls)) {
        return b ^ 0xff;
    }
    return b;
}

static inline bool plain_fetch_only(const TaudVoice *v, const TaudInst *inst)
{
    return inst->invertMaskLen == 0 &&
        ((inst->modOp == MOD_OFF && inst->modOpExt == 0) || (!inst->modOn && v->modXfade == 0));
}

static inline double pool_point(const TaudEngine *e, int sampleLen, int binMax, uint32_t basePtr, int idx)
{
    int hi = sampleLen - 1;
    int i = idx < 0 ? 0 : idx > hi ? hi : idx;
    int64_t p = (int64_t)basePtr + i;
    return e->pcmU8[te_pool_at(e, p > binMax ? binMax : p)];
}

static double read_modified_sample_point(TaudEngine *e, TaudVoice *v, TaudInst *inst, int idx,
                                         int sampleLen, int binMax, uint32_t basePtr)
{
    int i0 = iclamp(idx, 0, sampleLen - 1);
    int ls = v->activeSampleLoopStart;
    int le = v->activeSampleLoopEnd;
    bool extended = inst->modOpExt != 0;
    const TaudModGeom *g = te_resolve_mod_geom(&v->modGeom, inst, ls, le, sampleLen);
    bool touches = extended
        ? te_ext_mod_touches(g, inst->modInvert, inst->modF, inst->modStepIndex, i0)
        : te_mod_touches(g, inst->modInvert, i0);
    int i;
    double b;
    if (!g->live || !touches) {
        return e->pcmU8[pool_byte(e, inst, i0, binMax, basePtr, ls, le) & 0xff];
    }
    i = extended ? te_mod_address_ext(g, i0, inst)
                 : te_mod_address(g, i0, inst->modRot, inst->modScatter, inst->modSeed);
    {
        int bb = pool_byte(e, inst, i, binMax, basePtr, ls, le);
        if (extended) {
            if (inst->modMaskLen != 0) { if (te_inst_mod_bit(inst, i)) bb ^= 0xff; }
            bb = te_apply_ext_level(inst, bb);
        } else if (inst->modMaskLen != 0) { if (te_inst_mod_bit(inst, i)) bb = bb ^ 0xff; }
        else if (inst->modSub != 0) bb = (bb - inst->modSub) & 0xff;
        b = bb;
    }
    if (v->modXfade > 0) {
        int j = te_mod_address(g, i0, inst->modPrevRot, inst->modPrevScatter, inst->modPrevSeed);
        int p = pool_byte(e, inst, j, binMax, basePtr, ls, le);
        double w;
        if (extended) p = te_apply_ext_level_prev(inst, p);
        else if (inst->modMaskLen != 0) { if (te_inst_mod_bit(inst, j)) p = p ^ 0xff; }
        else if (inst->modPrevSub != 0) p = (p - inst->modPrevSub) & 0xff;
        w = (double)v->modXfade / MOD_XFADE_SAMPLES;
        b = p * w + b * (1.0 - w);
    }
    return (b - 127.5) / 127.5;
}

static inline double read_sample_point(TaudEngine *e, TaudVoice *v, TaudInst *inst, int idx,
                                       int sampleLen, int binMax, uint32_t basePtr)
{
    if (plain_fetch_only(v, inst)) return pool_point(e, sampleLen, binMax, basePtr, idx);
    return read_modified_sample_point(e, v, inst, idx, sampleLen, binMax, basePtr);
}

static int pcm_to_15bit(double x)
{
    return (int)dmin(js_round(x * 16384.0), 16383);
}

#define READ(ix) (plain ? pool_point(e, sampleLen, binMax, basePtr, (ix)) \
                        : read_sample_point(e, v, inst, (ix), sampleLen, binMax, basePtr))

#if SINC_WIDTH != 3
#error "interpolate_channel's sinc path is written out for a kernel of width 3"
#endif

/* Interpolate ONE channel at the voice's current position WITHOUT advancing it. */
static double interpolate_channel(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode,
                                  int sampleLen, int binMax, uint32_t basePtr, int *dpcm)
{
    int i0 = iclamp((int)trunc(dclamp(v->samplePos, -2147483648.0, 2147483647.0)), 0, sampleLen - 1);
    double frac = v->samplePos - i0;
    bool plain = plain_fetch_only(v, inst);

    switch (interpMode) {
    case INTERP_DEFAULT: {
        /* The windowed sinc of spec §8.3: the position's fraction picks one
         * of SINC_PRECISION phases (downwards — the kernel is not
         * interpolated between them), and the phase's coefficients weigh the
         * bytes around the position. */
        double acc = 0.0;
        double qd;
        int q, j;
        if (plain) {
            int64_t base = (int64_t)basePtr + i0;
            /* The JS guard is `base + SINC_WIDTH <= binMax`; a trimmed pool
             * also needs every tap inside it, and when one is not the
             * clamped path below reads the same zeros the full pool holds. */
            if (i0 >= SINC_WIDTH && i0 + SINC_WIDTH <= sampleLen - 1 && base + SINC_WIDTH <= binMax &&
                (uint64_t)(base + SINC_WIDTH) < e->samplePoolLen) {
                /* The interior, which is nearly always: every tap is inside
                 * the sample and the pool, and i0 was not clamped, so frac is
                 * in [0, 1) and the phase is a row of the table. */
                const uint8_t *bin = e->sampleBin + base;
                const double *pcm = e->pcmU8;
                const double *k = e->sincPhase + SINC_TAPS * (int)(frac * SINC_PRECISION);
                acc += pcm[bin[-2]] * k[0];
                acc += pcm[bin[-1]] * k[1];
                acc += pcm[bin[0]] * k[2];
                acc += pcm[bin[1]] * k[3];
                acc += pcm[bin[2]] * k[4];
                acc += pcm[bin[3]] * k[5];
                return acc;
            }
        }
        /* The same sum where a tap may fall off the sample (it reads the
         * nearest byte the sample has), where the position itself has left
         * it (frac is then outside [0, 1), and the taps it still reaches are
         * the ones within SINC_WIDTH of it), or where the instrument's bytes
         * are being modified as they are read. */
        qd = floor(frac * SINC_PRECISION);
        if (!(qd >= -2.0 * SINC_TABLE_SIZE && qd <= 2.0 * SINC_TABLE_SIZE)) return 0.0; /* out of every tap's reach */
        q = (int)qd;
        for (j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
            int idx = abs(j * SINC_PRECISION - q);
            if (idx >= SINC_TABLE_SIZE) continue;
            acc += (plain ? pool_point(e, sampleLen, binMax, basePtr, i0 + j)
                          : read_sample_point(e, v, inst, i0 + j, sampleLen, binMax, basePtr)) * e->sincTable[idx];
        }
        return acc;
    }
    case INTERP_SNES: {
        int oldest = pcm_to_15bit(READ(i0 - 1));
        int olders = pcm_to_15bit(READ(i0));
        int olds = pcm_to_15bit(READ(i0 + 1));
        int news = pcm_to_15bit(READ(i0 + 2));
        int offset = (int)dclamp(trunc(frac * 256.0), 0.0, 255.0);
        int32_t out = asr32(SNES_GAUSS[0xff - offset] * oldest, 10);
        out += asr32(SNES_GAUSS[0x1ff - offset] * olders, 10);
        out += asr32(SNES_GAUSS[0x100 + offset] * olds, 10);
        out &= 0xffff;
        if (out >= 0x8000) out -= 0x10000;
        out += asr32(SNES_GAUSS[offset] * news, 10);
        out = iclamp(out, -32768, 32767);
        return asr32(out, 1) / 16384.0;
    }
    case INTERP_NES_DPCM: {
        double target = READ(i0);
        int targetLevel = iclamp((int)trunc((target + 1.0) * 63.5), 0, 127);
        if (targetLevel > *dpcm && *dpcm <= 125) *dpcm += 2;
        else if (targetLevel < *dpcm && *dpcm >= 2) *dpcm -= 2;
        return (*dpcm - 63.5) / 63.5;
    }
    case INTERP_NONE:
    case INTERP_A500:
    case INTERP_A1200:
    default:
        return READ(i0);
    }
}
#undef READ

static void arm_funk_xfade(TaudVoice *v, int offset, double windowLen)
{
    double rate, grain;
    int len;
    if (offset == 0) return;
    rate = fabs(v->currentPlaybackRate);
    grain = rate > 0 ? floor(windowLen / rate) : FUNK_XFADE_SAMPLES;
    len = (int)dmin(FUNK_XFADE_SAMPLES, dmax(1, grain));
    v->funkXfade = len;
    v->funkXfadeLen = len;
    v->funkXfadeOffset = offset;
}

static void arm_mod_funk_xfade(TaudVoice *v, int offset, double windowLen)
{
    double rate, grain;
    int len;
    if (offset == 0) return;
    rate = fabs(v->currentPlaybackRate);
    grain = rate > 0 ? floor(windowLen / rate) : FUNK_XFADE_SAMPLES;
    len = (int)dmin(FUNK_XFADE_SAMPLES, dmax(1, grain));
    v->modFunkXfade = len;
    v->modFunkXfadeLen = len;
    v->modFunkXfadeOffset = offset;
}

static double ghost_channel(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode,
                            int sampleLen, int binMax, uint32_t basePtr, int *dpcm, int offset)
{
    double keepPos = v->samplePos;
    int keepDpcm = *dpcm;
    double g;
    v->samplePos = keepPos + offset;
    g = interpolate_channel(e, v, inst, interpMode, sampleLen, binMax, basePtr, dpcm);
    v->samplePos = keepPos;
    *dpcm = keepDpcm;
    return g;
}

static void begin_ramp_out(TaudVoice *v, int samples)
{
    if (v->rampOutSamples > 0) return;
    v->rampOutSamples = samples;
    v->rampOutGain = 1.0;
    v->rampOutStep = 1.0 / samples;
}

void te_start_ramp_out(TaudEngine *e, TaudVoice *v) { begin_ramp_out(v, e->rampOutSamples); }
void te_start_cut_ramp(TaudEngine *e, TaudVoice *v) { begin_ramp_out(v, e->attackRampSamples); }

/* Step samplePos by the playback rate and apply the loop/end rules. */
static void advance_sample_pos(TaudEngine *e, TaudVoice *v, TaudInst *inst, int sampleLen)
{
    bool zWindowed = v->funkPos >= 0 || v->funkWindow >= 0;
    double zLoopStart = v->funkWindow >= 0 ? v->funkWindow : v->activeSampleLoopStart;
    double zLoopEnd = zWindowed
        ? zLoopStart + dmax(v->activeSampleLoopEnd - v->activeSampleLoopStart, 1.0)
        : dmax(v->activeSampleLoopEnd, 1.0);

    bool extFunkLive = te_is_ext_funk_op(inst->modOpExt);
    bool extWindowed = extFunkLive && (inst->modFunkPos >= 0 || v->modFunkWindow >= 0);
    double extLoopStart = extWindowed && v->modFunkWindow >= 0
        ? v->modFunkWindow : v->activeSampleLoopStart;
    double extLoopEnd = extWindowed ? extLoopStart + dmax(inst->modFunkLen, 1.0) : zLoopEnd;

    double loopStart = extWindowed ? extLoopStart : zLoopStart;
    double loopEnd = extWindowed ? extLoopEnd : zLoopEnd;

    if (v->forward) {
        int effectiveLoopMode;
        v->samplePos += v->currentPlaybackRate;
        effectiveLoopMode = ((v->activeLoopMode & 0x04) != 0 && v->keyOff) ? 0 : v->activeLoopMode & 3;
        switch (effectiveLoopMode) {
        case 0:
        case 3:
            if (v->samplePos >= sampleLen) {
                v->samplePos = dmax(sampleLen - 1, 0.0);
                te_start_ramp_out(e, v);
            }
            break;
        case 1:
            if (v->samplePos >= loopEnd) {
                double overshoot = v->samplePos - loopEnd;
                if (extWindowed) {
                    double prevWindow = extLoopStart;
                    if (inst->modFunkPos >= 0) v->modFunkWindow = inst->modFunkPos;
                    arm_mod_funk_xfade(v, (int)(prevWindow - v->modFunkWindow), loopEnd - loopStart);
                    v->samplePos = v->modFunkWindow + overshoot;
                } else if (zWindowed) {
                    double prevWindow = zLoopStart;
                    if (v->funkPos >= 0) v->funkWindow = v->funkPos;
                    arm_funk_xfade(v, (int)(prevWindow - v->funkWindow), loopEnd - loopStart);
                    v->samplePos = v->funkWindow + overshoot;
                } else {
                    v->samplePos -= dmax(loopEnd - loopStart, 1.0);
                }
            }
            break;
        case 2:
            if (v->samplePos >= loopEnd) { v->samplePos = loopEnd; v->forward = false; }
            break;
        }
    } else {
        v->samplePos -= v->currentPlaybackRate;
        if (v->samplePos < loopStart) {
            if (extWindowed) {
                double prevWindow = extLoopStart;
                if (inst->modFunkPos >= 0) v->modFunkWindow = inst->modFunkPos;
                arm_mod_funk_xfade(v, (int)(prevWindow - v->modFunkWindow), loopEnd - loopStart);
                v->samplePos = v->modFunkWindow;
            } else if (zWindowed) {
                double prevWindow = zLoopStart;
                if (v->funkPos >= 0) v->funkWindow = v->funkPos;
                arm_funk_xfade(v, (int)(prevWindow - v->funkWindow), loopEnd - loopStart);
                v->samplePos = v->funkWindow;
            } else {
                v->samplePos = loopStart;
            }
            v->forward = true;
        }
    }
}

void te_fetch_tracker_sample_stereo(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode, double out[2])
{
    int sampleLen, binMax = SAMPLE_BIN_TOTAL - 1;
    if (inst->index == 0) { out[0] = 0.0; out[1] = 0.0; return; }
    sampleLen = imax(v->activeSampleLength, 1);
    out[0] = interpolate_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeSamplePtr, &v->nesDpcmCounter);
    out[1] = interpolate_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeChanPtr2, &v->right.nesDpcmCounter);
    if (v->funkXfade > 0) {
        double w = (double)v->funkXfade / v->funkXfadeLen;
        out[0] = ghost_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeSamplePtr,
                               &v->nesDpcmCounter, v->funkXfadeOffset) * w + out[0] * (1.0 - w);
        out[1] = ghost_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeChanPtr2,
                               &v->right.nesDpcmCounter, v->funkXfadeOffset) * w + out[1] * (1.0 - w);
        v->funkXfade--;
    }
    if (v->modFunkXfade > 0) {
        double w = (double)v->modFunkXfade / v->modFunkXfadeLen;
        out[0] = ghost_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeSamplePtr,
                               &v->nesDpcmCounter, v->modFunkXfadeOffset) * w + out[0] * (1.0 - w);
        out[1] = ghost_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeChanPtr2,
                               &v->right.nesDpcmCounter, v->modFunkXfadeOffset) * w + out[1] * (1.0 - w);
        v->modFunkXfade--;
    }
    if (v->modXfade > 0) v->modXfade--;
    if (v->rampOutSamples <= 0) advance_sample_pos(e, v, inst, sampleLen);
}

/* The read position a phase-modulated fetch lands on. */
static double wrap_read_pos(const TaudVoice *v, double pos, int sampleLen)
{
    int mode = v->activeLoopMode & 3;
    int ls = v->activeSampleLoopStart;
    int le = v->activeSampleLoopEnd;
    if ((mode == 1 || mode == 2) && le > ls) {
        int span = le - ls;
        double p = fmod(pos - ls, span);
        if (p < 0) p += span;
        return ls + p;
    }
    return dmin(dmax(pos, 0), sampleLen - 1);
}

double te_fetch_tracker_sample(TaudEngine *e, TaudVoice *v, TaudInst *inst, int interpMode, double posOffset)
{
    int sampleLen, binMax = SAMPLE_BIN_TOTAL - 1;
    double keepPos, sample;
    if (inst->index == 0) return 0.0;

    sampleLen = imax(v->activeSampleLength, 1);
    keepPos = v->samplePos;
    if (posOffset != 0) v->samplePos = wrap_read_pos(v, keepPos + posOffset, sampleLen);
    sample = interpolate_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeSamplePtr, &v->nesDpcmCounter);
    if (v->funkXfade > 0) {
        double w = (double)v->funkXfade / v->funkXfadeLen;
        sample = ghost_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeSamplePtr,
                               &v->nesDpcmCounter, v->funkXfadeOffset) * w + sample * (1.0 - w);
        v->funkXfade--;
    }
    if (v->modFunkXfade > 0) {
        double w = (double)v->modFunkXfade / v->modFunkXfadeLen;
        sample = ghost_channel(e, v, inst, interpMode, sampleLen, binMax, v->activeSamplePtr,
                               &v->nesDpcmCounter, v->modFunkXfadeOffset) * w + sample * (1.0 - w);
        v->modFunkXfade--;
    }
    if (posOffset != 0) v->samplePos = keepPos;

    if (v->modXfade > 0) v->modXfade--;
    if (v->rampOutSamples > 0) return sample;
    advance_sample_pos(e, v, inst, sampleLen);
    return sample;
}

void te_start_fast_fade(TaudEngine *e, TaudVoice *v)
{
    double ticks;
    if (!v->active) return;
    v->noteFading = true;
    ticks = dmax(FAST_FADE_SEC * e->bpm * 0.4, 1.0);
    v->activeFadeoutStep = (int)dmin(dmax(js_round(1024.0 / ticks), 1), 0xfff);
}

static int pitch_glide_samples(const TaudEngine *e, double cur, double target, double spt)
{
    int tick = spt >= 1 ? (int)js_round(spt) : 1;
    double up, down, interval;
    int n, fl;
    if (!(cur > 0.0) || !(target > 0.0)) return 1;
    up = target / cur;
    down = cur / target;
    interval = (up > down ? up : down) - 1.0;
    if (interval <= PITCH_GLIDE_FULL_RATIO) return tick;
    n = (int)js_round((tick * PITCH_GLIDE_FULL_RATIO) / interval);
    fl = e->attackRampSamples < tick ? e->attackRampSamples : tick;
    return n < fl ? fl : n;
}

void te_advance_pitch_ramp(TaudEngine *e, TaudVoice *v, double spt)
{
    double target = v->playbackRate;
    if (v->snapPlaybackRate) {
        v->currentPlaybackRate = target;
        v->pitchRampSamples = 0;
        v->pitchRampStep = 0.0;
        v->snapPlaybackRate = false;
        return;
    }
    if (v->pitchRampSamples > 0) {
        v->currentPlaybackRate += v->pitchRampStep;
        v->pitchRampSamples--;
        if (v->pitchRampSamples == 0) v->currentPlaybackRate = target;
    } else if (v->currentPlaybackRate != target) {
        int n = pitch_glide_samples(e, v->currentPlaybackRate, target, spt);
        if (n <= 1) {
            v->currentPlaybackRate = target;
            v->pitchRampSamples = 0;
            v->pitchRampStep = 0.0;
        } else {
            v->pitchRampStep = (target - v->currentPlaybackRate) / n;
            v->pitchRampSamples = n - 1;
            v->currentPlaybackRate += v->pitchRampStep;
        }
    }
}

double te_advance_pan_ramp(TaudEngine *e, TaudVoice *v, double target, bool wrap)
{
    if (wrap && !v->snapPan) {
        double d = target - v->currentPan;
        if (d > 256) v->currentPan += 512;
        else if (d < -256) v->currentPan -= 512;
    }
    if (v->snapPan) {
        v->currentPan = target;
        v->panRampSamples = 0;
        v->panRampStep = 0.0;
        v->snapPan = false;
        return target;
    }
    if (v->panRampSamples > 0) {
        v->currentPan += v->panRampStep;
        v->panRampSamples--;
        if (v->panRampSamples == 0) v->currentPan = target;
    } else if (v->currentPan != target) {
        v->panRampStep = (target - v->currentPan) / e->volRampSamples;
        v->panRampSamples = e->volRampSamples - 1;
        v->currentPan += v->panRampStep;
    }
    if (wrap) {
        if (v->currentPan < 0) v->currentPan += 512;
        else if (v->currentPan >= 512) v->currentPan -= 512;
    }
    return v->currentPan;
}

void te_advance_volume_ramp(TaudEngine *e, TaudVoice *v, double div)
{
    double target = (v->rowVolume / div) * (v->channelVolume / div);
    if (v->snapMixVolume) {
        v->currentMixVolume = target;
        v->volRampSamples = 0;
        v->volRampStep = 0.0;
        v->snapMixVolume = false;
        return;
    }
    if (v->volRampSamples > 0) {
        v->currentMixVolume += v->volRampStep;
        v->volRampSamples--;
        if (v->volRampSamples == 0) v->currentMixVolume = target;
    } else if (v->currentMixVolume != target) {
        v->volRampStep = (target - v->currentMixVolume) / e->volRampSamples;
        v->volRampSamples = e->volRampSamples - 1;
        v->currentMixVolume += v->volRampStep;
    }
}

/* Per-sample fadeout glide (sampler.js advanceFadeout): walk fadeoutMix down
 * the slope the tick set, never below the tick's own multiplier — where the
 * glide ends, and what makes a reset to 1 land at once. */
double te_advance_fadeout(TaudVoice *v)
{
    double m = v->fadeoutMix + v->fadeoutMixStep;
    v->fadeoutMix = m > v->fadeoutVolume ? m : v->fadeoutVolume;
    return v->fadeoutMix;
}

/* One frame of a song-level gain's glide (sampler.js ByteGlide.fill, a frame
 * at a time): over the volume ramp, re-aimed whenever the value moves. */
double te_byte_glide_next(const TaudEngine *e, TaudByteGlide *g, int target)
{
    if (isnan(g->cur)) { g->cur = target; g->aim = target; g->left = 0; }
    if (target != g->aim) {
        g->aim = target;
        g->step = (target - g->cur) / e->volRampSamples;
        g->left = e->volRampSamples;
    }
    if (g->left > 0) {
        g->left--;
        g->cur = g->left == 0 ? target : g->cur + g->step;
    }
    return g->cur;
}

/* Per-sample glide of a voice's lane fader (sampler.js advanceFaderRamp). */
double te_advance_fader_ramp(const TaudEngine *e, TaudVoice *v, int target)
{
    if (isnan(v->faderCur)) {
        v->faderCur = target; v->faderAim = target; v->faderLeft = 0;
        return target;
    }
    if (target != v->faderAim) {
        v->faderAim = target;
        v->faderStep = (target - v->faderCur) / e->volRampSamples;
        v->faderLeft = e->volRampSamples;
    }
    if (v->faderLeft > 0) {
        v->faderLeft--;
        v->faderCur = v->faderLeft == 0 ? target : v->faderCur + v->faderStep;
    }
    return v->faderCur;
}

/* Per-sample glide of a voice's elevation (sampler.js advanceElevRamp). */
double te_advance_elev_ramp(const TaudEngine *e, TaudVoice *v, double target)
{
    if (isnan(v->elevCur)) {
        v->elevCur = target; v->elevAim = target; v->elevLeft = 0;
        return target;
    }
    if (target != v->elevAim) {
        v->elevAim = target;
        v->elevStep = (target - v->elevCur) / e->volRampSamples;
        v->elevLeft = e->volRampSamples;
    }
    if (v->elevLeft > 0) {
        v->elevLeft--;
        v->elevCur = v->elevLeft == 0 ? target : v->elevCur + v->elevStep;
    }
    return v->elevCur;
}

/* One point of a voice's sample, modifications and all (wasm_parts.c). */
double te_read_sample_point(TaudEngine *e, TaudVoice *v, TaudInst *inst, int idx,
                            int sampleLen, int binMax, uint32_t basePtr)
{
    return read_sample_point(e, v, inst, idx, sampleLen, binMax, basePtr);
}
