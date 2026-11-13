/* Per-voice filters + Taud voice FX — port of filter.js.
 *  - IT/tracker path: all-pole 2-pole resonant LPF, no feedforward terms.
 *  - filterSfMode path: FluidSynth's RBJ biquad (cents→Hz, −3.01 dB Q offset,
 *    1/√Q gain normalisation). */

#include "taud_internal.h"

/* The rate a voice's filter runs at: the engine's, or its rack's for an FM
 * operator past the first (voice.filterOversample). */
static double filter_rate(const TaudEngine *e, const TaudVoice *v)
{
    return v->filterOversample > 1 ? (double)e->rate * v->filterOversample : (double)e->rate;
}

/* RBJ cookbook low-pass, normalised to a0; SF2 §2.01 p.59 1/√Q gain-norm. */
static void sf_biquad(const TaudEngine *e, TaudVoice *v, double fres, double qLin)
{
    const double pi = 3.141592653589793;
    double omega = (2.0 * pi * fres) / filter_rate(e, v);
    double sinC = js_sin(omega);
    double cosC = js_cos(omega);
    double alpha = sinC / (2.0 * qLin);
    double a0inv = 1.0 / (1.0 + alpha);
    double gain = a0inv / sqrt(qLin);
    v->filterBqB1 = (1.0 - cosC) * gain;
    v->filterBqB02 = v->filterBqB1 * 0.5;
    v->filterBqA1 = -2.0 * cosC * a0inv;
    v->filterBqA2 = (1.0 - alpha) * a0inv;
}

/* Forget a SoundFont-mode glide: the filter is off, or in IT mode. */
static void stop_sf_glide(TaudVoice *v)
{
    v->sfCents = NAN;
    v->sfCentsLeft = 0;
    v->sfQLeft = 0;
}

void te_refresh_voice_filter(const TaudEngine *e, TaudVoice *v)
{
    const double pi = 3.141592653589793;
    int cut = v->currentCutoff;
    int res = v->currentResonance;
    double rate = filter_rate(e, v);
    double nyquist = rate * 0.5 - 1.0;
    double itCutoff, itResonance, frequency, dmpfac, r, d, ee, denom;
    if (cut == v->filterCutoffCached && res == v->filterResonanceCached) return;
    v->filterCutoffCached = cut;
    v->filterResonanceCached = res;

    if (v->filterSfMode) {
        double fres, qDb, qLin, diff;
        int qcb;
        bool fresh;
        if (cut >= 0xffff) { v->filterActive = false; stop_sf_glide(v); return; }
        fres = dmin(dmax(8.176 * js_pow(2.0, cut / 1200.0), 5.0), 0.45 * rate);
        qcb = res >= 0xffff ? 0 : res;
        qDb = dmin(dmax(qcb / 10.0, 0.0), 96.0) - 3.01;
        qLin = dmax(js_pow(10.0, qDb / 20.0), 0.001);
        /* The coefficients follow a new cutoff / Q a sample at a time
         * (te_advance_filter_glide), as FluidSynth's do; a voice's first
         * refresh, and one that turns the biquad on, lands at once. The glide
         * runs in the cutoff's own cents (no logarithm) and is clamped as Hz
         * at every step. */
        fresh = isnan(v->sfCents) || !v->filterActive || !v->filterIsBiquad;
        v->sfHzAim = fres;
        v->sfCentsAim = cut;
        v->filterIsBiquad = true;
        v->filterActive = true;
        if (fresh) {
            v->sfCents = cut;
            v->sfQ = qLin;
            v->sfQAim = qLin;
            v->sfCentsLeft = 0;
            v->sfQLeft = 0;
            sf_biquad(e, v, fres, qLin);
            return;
        }
        if (qLin != v->sfQAim) {
            v->sfQAim = qLin;
            v->sfQIncr = (qLin - v->sfQ) / e->sfFilterGlideSamples;
            v->sfQLeft = e->sfFilterGlideSamples;
        }
        diff = cut - v->sfCents;
        if (fabs(diff) > 1.0) {
            double count = e->sfFilterGlideSamples * dmin(dmax(v->sfQ, 1.0), 5.0);
            v->sfCentsIncr = diff / count;
            v->sfCentsLeft = (int)js_round(count);
        } else {
            v->sfCents = cut;
            v->sfCentsLeft = 0;
        }
        if (v->sfCentsLeft == 0 && v->sfQLeft == 0) sf_biquad(e, v, fres, qLin);
        return;
    }

    stop_sf_glide(v);
    if (iclamp(cut, 0, 255) >= 255) { v->filterActive = false; return; }
    itCutoff = iclamp(cut, 0, 254) * 0.5;
    itResonance = res >= 255 ? 0.0 : iclamp(res, 0, 254) * 0.5;
    frequency = dmin(110.0 * js_pow(2.0, itCutoff / 24.0 + 0.25), nyquist);
    dmpfac = js_pow(10.0, (-itResonance * (24.0 / 128.0)) / 20.0);

    r = rate / (2.0 * pi * frequency);
    d = dmpfac * r + dmpfac - 1.0;
    ee = r * r;
    denom = 1.0 + d + ee;

    v->filterA0 = 1.0 / denom;
    v->filterB0 = (d + ee + ee) / denom;
    v->filterB1 = -ee / denom;
    v->filterIsBiquad = false;
    v->filterActive = true;
}

static inline double filter_run(const TaudVoice *v, double x0, double *x1, double *x2, double *y1, double *y2)
{
    double y0;
    if (v->filterIsBiquad) {
        y0 = v->filterBqB02 * (x0 + *x2) +
             v->filterBqB1 * *x1 -
             v->filterBqA1 * *y1 -
             v->filterBqA2 * *y2;
        *x2 = *x1;
        *x1 = x0;
        *y2 = *y1;
        *y1 = y0;
        return y0;
    } else {
        double y1c = dmin(dmax(*y1, -2.0), 2.0);
        double y2c = dmin(dmax(*y2, -2.0), 2.0);
        y0 = v->filterA0 * x0 + v->filterB0 * y1c + v->filterB1 * y2c;
        *y2 = *y1;
        *y1 = y0;
        return y0;
    }
}

/* One frame of a SoundFont-mode filter glide, after every channel of the frame
 * has been filtered (filter.js advanceFilterGlide). */
void te_advance_filter_glide(const TaudEngine *e, TaudVoice *v)
{
    double hz;
    if (v->sfCentsLeft == 0 && v->sfQLeft == 0) return;
    if (v->sfCentsLeft > 0) {
        v->sfCents += v->sfCentsIncr;
        v->sfCentsLeft--;
    }
    if (v->sfQLeft > 0) {
        v->sfQLeft--;
        v->sfQ = v->sfQLeft == 0 ? v->sfQAim : v->sfQ + v->sfQIncr;
    }
    if (v->sfCentsLeft == 0 && v->sfQLeft == 0) {
        v->sfCents = v->sfCentsAim;
        sf_biquad(e, v, v->sfHzAim, v->sfQAim);
        return;
    }
    hz = v->sfCentsLeft == 0
        ? v->sfHzAim
        : dmin(dmax(8.176 * js_pow(2.0, v->sfCents / 1200.0), 5.0), 0.45 * filter_rate(e, v));
    sf_biquad(e, v, hz, v->sfQ);
}

/* The voice's own delay line (mono, or the first channel of a pair). */
double te_apply_voice_filter_self(TaudVoice *v, double x0)
{
    if (!v->filterActive) return x0;
    return filter_run(v, x0, &v->filterX1, &v->filterX2, &v->filterY1, &v->filterY2);
}

/* A separate delay line (a stereo pair's second channel). */
double te_apply_voice_filter(const TaudVoice *v, double x0, TaudChannelState *st)
{
    if (!v->filterActive) return x0;
    return filter_run(v, x0, &st->filterX1, &st->filterX2, &st->filterY1, &st->filterY2);
}

/* Shared clipper for effects 8/9: 0 clamp, 1 fold (triangle), 2 wrap (sawtooth). */
static double clip_sample(double x, int mode)
{
    switch (mode & 3) {
    case 1: {
        double v = x;
        while (v > 1.0) v = 2.0 - v;
        while (v < -1.0) v = -2.0 - v;
        return v;
    }
    case 2: {
        double v = fmod(x + 1.0, 2.0);
        if (v < 0.0) v += 2.0;
        return v - 1.0;
    }
    default:
        return dmin(dmax(x, -1.0), 1.0);
    }
}

/* Overdrive (9) → shared clipper → bitcrusher (8). The crusher's hold/counter
 * state is passed in (the voice's own, or a stereo pair's second channel's). */
double te_apply_taud_voice_fx(const TaudVoice *v, double sample, int *bitcrusherCounter, double *bitcrusherHeld)
{
    double s = sample;
    bool overdriveOn = v->overdriveAmp > 0;
    bool depthQuantises = v->bitcrusherDepth >= 1 && v->bitcrusherDepth <= 7;
    bool skipActive = v->bitcrusherSkip > 0;
    bool crushActive = depthQuantises || skipActive;

    if (overdriveOn) {
        s *= (16 + v->overdriveAmp) / 16.0;
        s = clip_sample(s, v->clipMode);
    }
    if (crushActive) {
        if (*bitcrusherCounter == 0) {
            if (depthQuantises) {
                int levels = (1 << v->bitcrusherDepth) - 1;
                double clipped = dmin(dmax(clip_sample(s, v->clipMode), -1.0), 1.0);
                double q = dmin(dmax(floor((clipped + 1.0) * 0.5 * levels + 0.5), 0.0), levels);
                s = (q / levels) * 2.0 - 1.0;
            }
            *bitcrusherHeld = s;
        } else {
            s = *bitcrusherHeld;
        }
        if (skipActive) *bitcrusherCounter = (*bitcrusherCounter + 1) % (v->bitcrusherSkip + 1);
        else *bitcrusherCounter = 0;
    }
    return s;
}
