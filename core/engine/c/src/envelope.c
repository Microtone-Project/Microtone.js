/* Envelope walkers — port of envelope.js.
 *  - advancePfRole SKIPS zero-duration nodes, stopping at a sustain/loop
 *    boundary or maxIdx; seedPfRole settles the note-on seed past them.
 *  - the vol/pan walker FREEZES on zero-offset nodes (IT terminator). */

#include "taud_internal.h"

#define MAX_IDX 24

/* A 25-node envelope indexed by a node number. LOOP/SUSTAIN words can name
 * nodes up to 31; the JS throws on those (the array has 25 entries), so any
 * reading here is ours to choose — the last node — and every index a file the
 * JS can play produces reads exactly what it reads. */
#define NODE(env, i) ((env)[(i) > MAX_IDX ? MAX_IDX : (i)])

/* Resolve the active wrap region from LOOP and SUSTAIN words + key state.
 * range[1] = -1 when no wrap. */
static void resolve_env_wrap(int loopWord, int sustainWord, bool keyOff, int range[2])
{
    bool susB = ((sustainWord >> 5) & 1) != 0;
    bool loopB = ((loopWord >> 5) & 1) != 0;
    if (susB && !keyOff) {
        range[0] = (sustainWord >> 8) & 0x1f;
        range[1] = sustainWord & 0x1f;
    } else if (loopB) {
        range[0] = (loopWord >> 8) & 0x1f;
        range[1] = loopWord & 0x1f;
    } else {
        range[0] = -1;
        range[1] = -1;
    }
}

/* A node's volume out of the voice's full scale: 63, or 255 when the
 * instrument's byte 14 bit 6 says its envelopes are 8-bit (§7.2). Divided by
 * the integer, never multiplied by a reciprocal, as the reference does. */
static inline double vol_of(const TaudVoice *v, int value)
{
    return dmin(dmax(value / (double)v->activeVolEnvMax, 0.0), 1.0);
}

static void jump_to_sustain_end(TaudVoice *v)
{
    int sus = v->activeVolEnvSustain, susEnd;
    if (((sus >> 5) & 1) == 0) return;
    susEnd = sus & 0x1f;
    if (v->envIndex >= susEnd) return;
    v->envIndex = susEnd;
    v->envTimeSec = 0.0;
    v->envVolume = vol_of(v, NODE(v->activeVolEnv, susEnd).value);
}

void te_apply_key_lift(TaudVoice *v, const TaudInst *inst)
{
    if (!inst_nna_key_lift(inst)) return;
    jump_to_sustain_end(v);
}

void te_force_key_lift(TaudVoice *v) { jump_to_sustain_end(v); }

/* Volume + pan envelope advance (once per tick). */
void te_advance_envelope(TaudEngine *e, TaudVoice *v, double tickSec)
{
    const TaudEnvPoint *volEnv = v->activeVolEnv;
    const TaudEnvPoint *panEnv;
    int w[2], pStart, pEnd;
    bool pWrapping;

    if (v->hasVolEnv && v->volEnvOn) {
        int wStart, wEnd;
        bool wrapping;
        resolve_env_wrap(v->activeVolEnvLoop, v->activeVolEnvSustain, v->keyOff, w);
        wStart = w[0];
        wEnd = w[1];
        wrapping = wStart >= 0;

        if (wrapping && v->envIndex == wEnd && wStart == wEnd) {
            v->envVolume = vol_of(v, NODE(volEnv, v->envIndex).value);
        } else if (wrapping && v->envIndex == wEnd) {
            v->envTimeSec = 0.0;
            v->envIndex = wStart;
            v->envVolume = vol_of(v, NODE(volEnv, v->envIndex).value);
        } else if (v->envIndex >= MAX_IDX) {
            int vEnd = NODE(volEnv, MAX_IDX).value;
            v->envVolume = vol_of(v, vEnd);
            if (vEnd == 0 && !wrapping) te_start_ramp_out(e, v);
        } else {
            double vOffset = minifloat_to_double(NODE(volEnv, v->envIndex).offset);
            int vCurValue = NODE(volEnv, v->envIndex).value;
            if (vOffset == 0.0) {
                v->envVolume = vol_of(v, vCurValue);
                if (vCurValue == 0 && !wrapping) te_start_ramp_out(e, v);
            } else {
                v->envTimeSec += tickSec;
                if (v->envTimeSec >= vOffset) {
                    int nextIdx;
                    v->envTimeSec -= vOffset;
                    nextIdx = wrapping && v->envIndex == wEnd ? wStart : imin(v->envIndex + 1, MAX_IDX);
                    v->envIndex = nextIdx;
                    v->envVolume = vol_of(v, NODE(volEnv, v->envIndex).value);
                } else {
                    double cur = vol_of(v, vCurValue);
                    double nxt = vol_of(v, NODE(volEnv, imin(v->envIndex + 1, MAX_IDX)).value);
                    v->envVolume = cur + (nxt - cur) * (v->envTimeSec / vOffset);
                }
            }
        }
    }

    if (!v->hasPanEnv || !v->panEnvOn) return;
    panEnv = v->activePanEnv;
    resolve_env_wrap(v->activePanEnvLoop, v->activePanEnvSustain, v->keyOff, w);
    pStart = w[0];
    pEnd = w[1];
    pWrapping = pStart >= 0;

    if (pWrapping && v->envPanIndex == pEnd && pStart == pEnd) {
        v->envPan = NODE(panEnv, v->envPanIndex).value / 255.0;
    } else if (pWrapping && v->envPanIndex == pEnd) {
        v->envPanTimeSec = 0.0;
        v->envPanIndex = pStart;
        v->envPan = NODE(panEnv, v->envPanIndex).value / 255.0;
    } else if (v->envPanIndex >= MAX_IDX) {
        v->envPan = NODE(panEnv, MAX_IDX).value / 255.0;
    } else {
        double pOffset = minifloat_to_double(NODE(panEnv, v->envPanIndex).offset);
        if (pOffset == 0.0) {
            v->envPan = NODE(panEnv, v->envPanIndex).value / 255.0;
        } else {
            v->envPanTimeSec += tickSec;
            if (v->envPanTimeSec >= pOffset) {
                v->envPanTimeSec -= pOffset;
                v->envPanIndex = pWrapping && v->envPanIndex == pEnd ? pStart : imin(v->envPanIndex + 1, MAX_IDX);
                v->envPan = NODE(panEnv, v->envPanIndex).value / 255.0;
            } else {
                double cur = NODE(panEnv, v->envPanIndex).value / 255.0;
                double nxt = NODE(panEnv, imin(v->envPanIndex + 1, MAX_IDX)).value / 255.0;
                v->envPan = cur + (nxt - cur) * (v->envPanTimeSec / pOffset);
            }
        }
    }
}

/* Generic 25-node walk shared by pitch and filter envelopes. */
static double advance_pf_role(const TaudEnvPoint *env, int loopWord, int susWord, bool keyOff,
                              double tickSec, int *idxBox, double *timeBox)
{
    int w[2], susStart, susEnd, idx;
    bool susOn;
    double offset;
    resolve_env_wrap(loopWord, susWord, keyOff, w);
    susStart = w[0];
    susEnd = w[1];
    susOn = susStart >= 0;
    idx = *idxBox;
    if (susOn && idx == susEnd && susStart == susEnd) {
        return NODE(env, idx).value / 255.0;
    } else if (susOn && idx == susEnd) {
        *timeBox = 0.0;
        idx = susStart;
        *idxBox = idx;
        return NODE(env, idx).value / 255.0;
    } else if (idx >= MAX_IDX) {
        return NODE(env, MAX_IDX).value / 255.0;
    }
    while (idx < MAX_IDX && !(susOn && idx == susEnd) && minifloat_to_double(NODE(env, idx).offset) == 0.0) idx++;
    if (susOn && idx == susEnd) {
        if (susStart != susEnd) { *timeBox = 0.0; idx = susStart; }
        *idxBox = idx;
        return NODE(env, idx).value / 255.0;
    }
    *idxBox = idx;
    if (idx >= MAX_IDX) return NODE(env, MAX_IDX).value / 255.0;
    offset = minifloat_to_double(NODE(env, idx).offset);
    *timeBox += tickSec;
    if (*timeBox >= offset) {
        *timeBox -= offset;
        idx = imin(idx + 1, MAX_IDX);
        *idxBox = idx;
        return NODE(env, idx).value / 255.0;
    }
    {
        double cur = NODE(env, idx).value / 255.0;
        double nxt = NODE(env, imin(idx + 1, MAX_IDX)).value / 255.0;
        return cur + (nxt - cur) * (*timeBox / offset);
    }
}

double te_seed_pf_role(const TaudEnvPoint *env, int loopWord, int susWord, int *idxOut, double *timeOut)
{
    *idxOut = 0;
    *timeOut = 0.0;
    return advance_pf_role(env, loopWord, susWord, false, 0.0, idxOut, timeOut);
}

void te_advance_pitch_envelope(TaudVoice *v, double tickSec)
{
    if (!v->hasPitchEnv || !v->pitchEnvOn) return;
    v->envPitchValue = advance_pf_role(v->activePitchEnv, v->activePitchEnvLoop,
        v->activePitchEnvSustain, v->keyOff, tickSec, &v->envPitchIndex, &v->envPitchTimeSec);
}

void te_advance_filter_envelope(TaudVoice *v, double tickSec)
{
    if (!v->hasFilterEnv || !v->filterEnvOn) return;
    v->envFilterValue = advance_pf_role(v->activeFilterEnv, v->activeFilterEnvLoop,
        v->activeFilterEnvSustain, v->keyOff, tickSec, &v->envFilterIndex, &v->envFilterTimeSec);
}

/* IT-style auto-vibrato: a 4096-TET pitch delta for this tick. */
int te_advance_auto_vibrato(TaudEngine *e, TaudVoice *v)
{
    int depth0 = v->activeVibratoDepth;
    int ftSweep, itRate, rampDepth, wave, pos, rawSample, pitchDelta;
    int64_t t;
    if (depth0 == 0 || v->activeVibratoSpeed == 0) return 0;

    ftSweep = v->activeVibratoSweep;
    itRate = v->activeVibratoRate;
    t = v->autoVibTicksSinceTrigger;
    if (ftSweep != 0) {
        int64_t q = ((int64_t)depth0 * t) / ftSweep;
        rampDepth = q < depth0 ? (int)q : depth0;
    } else if (itRate != 0) {
        uint32_t q = (uint32_t)(t * itRate) >> 8;
        rampDepth = q < (uint32_t)depth0 ? (int)q : depth0;
    } else {
        rampDepth = depth0;
    }
    v->autoVibTicksSinceTrigger++;

    wave = v->activeVibratoWaveform;
    pos = asr32(v->autoVibPhase, 2);
    rawSample = wave == 4 ? -te_lfo_sample(e, pos, 1) : te_lfo_sample(e, pos, wave & 3);
    pitchDelta = asr32(rawSample * rampDepth * AUTOVIB_DEPTH_MUL, AUTOVIB_DEPTH_SHIFT);
    v->autoVibPhase = (v->autoVibPhase + v->activeVibratoSpeed) & (AUTOVIB_PHASE_STEPS - 1);
    return pitchDelta;
}
