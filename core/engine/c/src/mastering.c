/* Master-bus mastering chain — port of mastering.js, the TruePeakProbe of
 * analysis.js and the `sMst` block decoder of mastering-section.js. The
 * biquad, the compressor and the limiter are exported (te_bq_*, te_comp_*,
 * te_lim_*) at any channel count up to TE_MAX_BUS_CH, for the instrument
 * chains (imix.c), as mastering.js exports them to imix.js.
 *
 *     trim → high-pass → 4-band EQ → compressor → width → limiter → gain
 *
 * Coefficients in binary64 from binary32 parameters; per-sample maths in
 * binary64; the mix narrows to binary32 once, after this, as it always did. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

#define PI 3.141592653589793
#define LIMITER_LOOKAHEAD_MS 1.0

double te_db_to_gain(double db) { return js_pow(10.0, db / 20); }
#define db_to_gain te_db_to_gain

/* ── parameters ── */

static float clamp_range(double v, double lo, double hi, double fallback)
{
    if (!isfinite(v)) return (float)fallback;
    return (float)(v < lo ? lo : v > hi ? hi : v);
}

void te_mastering_default(TaudMastering *p)
{
    memset(p, 0, sizeof *p);
    p->on = false;
    p->trimDb = 0;
    p->hpOn = false; p->hpFreq = 20; p->hpSlope = HP_SLOPE_12;
    p->eqOn = false;
    p->eq[0].on = true; p->eq[0].type = EQ_LOW_SHELF;  p->eq[0].freq = 100;  p->eq[0].gainDb = 0; p->eq[0].q = 0.707f;
    p->eq[1].on = true; p->eq[1].type = EQ_PEAKING;    p->eq[1].freq = 400;  p->eq[1].gainDb = 0; p->eq[1].q = 1.0f;
    p->eq[2].on = true; p->eq[2].type = EQ_PEAKING;    p->eq[2].freq = 2500; p->eq[2].gainDb = 0; p->eq[2].q = 1.0f;
    p->eq[3].on = true; p->eq[3].type = EQ_HIGH_SHELF; p->eq[3].freq = 8000; p->eq[3].gainDb = 0; p->eq[3].q = 0.707f;
    p->compOn = false; p->compDetector = COMP_PEAK;
    p->compThreshDb = -18; p->compRatio = 2; p->compAttackMs = 20; p->compReleaseMs = 200;
    p->compKneeDb = 6; p->compMakeupDb = 0;
    p->widthOn = false; p->width = 1;
    p->limOn = false; p->limTruePeak = false; p->limCeilingDb = -1; p->limReleaseMs = 100;
    p->outGainDb = 0;
}

bool te_mastering_engaged(const TaudMastering *p)
{
    if (p == NULL || !p->on) return false;
    return p->trimDb != 0 || p->outGainDb != 0 ||
        p->hpOn || p->eqOn || p->compOn || p->limOn || (p->widthOn && p->width != 1);
}

static float rd_f32(const uint8_t *b)
{
    union { uint32_t u; float f; } c;
    c.u = (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
    return c.f;
}

#define MASTERING_BLOCK_SIZE 160
#define EQ_BASE 20
#define EQ_STRIDE 16
#define COMP_BASE 84
#define WIDTH_BASE 112
#define LIM_BASE 120
#define OUT_GAIN 132

/* Decode one version-1 parameter block (normalised as the JS does). */
bool te_mastering_parse_block(const uint8_t *b, size_t len, TaudMastering *p)
{
    TaudMastering d;
    int i;
    if (len < MASTERING_BLOCK_SIZE) return false;
    if (b[0] != 1) return false;
    te_mastering_default(&d);
    for (i = 0; i < EQ_BANDS; i++) {
        int o = EQ_BASE + i * EQ_STRIDE;
        int type = b[o + 1];
        type = type == EQ_LOW_SHELF || type == EQ_HIGH_SHELF ? type : EQ_PEAKING;
        p->eq[i].on = (b[o] & 1) != 0;
        p->eq[i].type = i == 0 || i == EQ_BANDS - 1 ? type : EQ_PEAKING;
        p->eq[i].freq = clamp_range(rd_f32(b + o + 4), 20, 20000, d.eq[i].freq);
        p->eq[i].gainDb = clamp_range(rd_f32(b + o + 8), -18, 18, d.eq[i].gainDb);
        p->eq[i].q = clamp_range(rd_f32(b + o + 12), 0.1, 12, d.eq[i].q);
    }
    p->on = (b[1] & 1) != 0;
    p->trimDb = clamp_range(rd_f32(b + 4), -24, 24, d.trimDb);
    p->hpOn = (b[8] & 1) != 0;
    p->hpSlope = (b[8] & 2) != 0 ? HP_SLOPE_24 : HP_SLOPE_12;
    p->hpFreq = clamp_range(rd_f32(b + 12), 10, 500, d.hpFreq);
    p->eqOn = (b[16] & 1) != 0;
    p->compOn = (b[COMP_BASE] & 1) != 0;
    p->compDetector = (b[COMP_BASE] & 2) != 0 ? COMP_RMS : COMP_PEAK;
    p->compThreshDb = clamp_range(rd_f32(b + COMP_BASE + 4), -60, 0, d.compThreshDb);
    p->compRatio = clamp_range(rd_f32(b + COMP_BASE + 8), 1, 20, d.compRatio);
    p->compAttackMs = clamp_range(rd_f32(b + COMP_BASE + 12), 0.1, 300, d.compAttackMs);
    p->compReleaseMs = clamp_range(rd_f32(b + COMP_BASE + 16), 5, 3000, d.compReleaseMs);
    p->compKneeDb = clamp_range(rd_f32(b + COMP_BASE + 20), 0, 24, d.compKneeDb);
    p->compMakeupDb = clamp_range(rd_f32(b + COMP_BASE + 24), -12, 24, d.compMakeupDb);
    p->widthOn = (b[WIDTH_BASE] & 1) != 0;
    p->width = clamp_range(rd_f32(b + WIDTH_BASE + 4), 0, 2, d.width);
    p->limOn = (b[LIM_BASE] & 1) != 0;
    p->limTruePeak = (b[LIM_BASE] & 2) != 0;
    p->limCeilingDb = clamp_range(rd_f32(b + LIM_BASE + 4), -24, 0, d.limCeilingDb);
    p->limReleaseMs = clamp_range(rd_f32(b + LIM_BASE + 8), 1, 1000, d.limReleaseMs);
    p->outGainDb = clamp_range(rd_f32(b + OUT_GAIN), -24, 24, d.outGainDb);
    return true;
}

/* ── biquad (RBJ, Direct Form I, normalised to a0) ── */

void te_bq_init(TaudBiquad *s) { memset(s, 0, sizeof *s); s->b0 = 1; }
void te_bq_reset(TaudBiquad *s)
{
    memset(s->x1, 0, sizeof s->x1); memset(s->x2, 0, sizeof s->x2);
    memset(s->y1, 0, sizeof s->y1); memset(s->y2, 0, sizeof s->y2);
}

static void bq_set(TaudBiquad *s, double b0, double b1, double b2, double a0, double a1, double a2)
{
    double inv = 1 / a0;
    s->b0 = b0 * inv; s->b1 = b1 * inv; s->b2 = b2 * inv;
    s->a1 = a1 * inv; s->a2 = a2 * inv;
}

void te_bq_high_pass(TaudBiquad *s, double freq, double q, double rate)
{
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    bq_set(s, (1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
}

void te_bq_low_pass(TaudBiquad *s, double freq, double q, double rate)
{
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    bq_set(s, (1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha);
}

/* Constant 0 dB peak gain (a dynamic EQ's sensor). */
void te_bq_band_pass(TaudBiquad *s, double freq, double q, double rate)
{
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    bq_set(s, alpha, 0, -alpha, 1 + alpha, -2 * cw, 1 - alpha);
}

void te_bq_notch(TaudBiquad *s, double freq, double q, double rate)
{
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    bq_set(s, 1, -2 * cw, 1, 1 + alpha, -2 * cw, 1 - alpha);
}

/* At Q = 1/√2, what a Linkwitz–Riley 4th-order low-pass and high-pass at the
 * same frequency sum to (a multiband split's phase matching). */
void te_bq_all_pass(TaudBiquad *s, double freq, double q, double rate)
{
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    bq_set(s, 1 - alpha, -2 * cw, 1 + alpha, 1 + alpha, -2 * cw, 1 - alpha);
}

void te_bq_peaking(TaudBiquad *s, double freq, double gainDb, double q, double rate)
{
    double A = js_pow(10.0, gainDb / 40);
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    bq_set(s, 1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A);
}

void te_bq_low_shelf(TaudBiquad *s, double freq, double gainDb, double q, double rate)
{
    double A = js_pow(10.0, gainDb / 40);
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    double tsa = 2 * sqrt(A) * alpha;
    bq_set(s, A * ((A + 1) - (A - 1) * cw + tsa),
              2 * A * ((A - 1) - (A + 1) * cw),
              A * ((A + 1) - (A - 1) * cw - tsa),
              (A + 1) + (A - 1) * cw + tsa,
              -2 * ((A - 1) + (A + 1) * cw),
              (A + 1) + (A - 1) * cw - tsa);
}

void te_bq_high_shelf(TaudBiquad *s, double freq, double gainDb, double q, double rate)
{
    double A = js_pow(10.0, gainDb / 40);
    double w = (2 * PI * dmin(freq, rate * 0.49)) / rate;
    double cw = js_cos(w), sw = js_sin(w);
    double alpha = sw / (2 * q);
    double tsa = 2 * sqrt(A) * alpha;
    bq_set(s, A * ((A + 1) + (A - 1) * cw + tsa),
              -2 * A * ((A - 1) + (A + 1) * cw),
              A * ((A + 1) + (A - 1) * cw - tsa),
              (A + 1) - (A - 1) * cw + tsa,
              2 * ((A - 1) - (A + 1) * cw),
              (A + 1) - (A - 1) * cw - tsa);
}

/* ── sliding-window minimum (monotonic deque) ── */

#define SLIDING_REBASE 0x20000000

typedef TaudSlidingMin SlidingMin;

static bool sm_init(SlidingMin *m, int width)
{
    m->width = width;
    m->cap = width + 1;
    m->val = (double *)calloc((size_t)m->cap, sizeof(double));
    m->at = (int32_t *)calloc((size_t)m->cap, sizeof(int32_t));
    return m->val != NULL && m->at != NULL;
}

static void sm_free(SlidingMin *m) { free(m->val); free(m->at); m->val = NULL; m->at = NULL; }

static void sm_reset(SlidingMin *m, double fill)
{
    m->n = 0;
    m->val[0] = fill; m->at[0] = 0;
    m->head = 0; m->tail = 1;
}

static double sm_push(SlidingMin *m, double v)
{
    int32_t i = m->n++;
    int cap = m->cap;
    while (m->tail != m->head) {
        int prev = (m->tail - 1 + cap) % cap;
        if (m->val[prev] >= v) m->tail = prev; else break;
    }
    m->val[m->tail] = v; m->at[m->tail] = i;
    m->tail = (m->tail + 1) % cap;
    while (m->at[m->head] <= i - m->width) m->head = (m->head + 1) % cap;
    if (m->n >= SLIDING_REBASE) {
        int k;
        for (k = m->head; k != m->tail; k = (k + 1) % cap) m->at[k] -= SLIDING_REBASE;
        m->n -= SLIDING_REBASE;
    }
    return m->val[m->head];
}

/* ── true-peak probe (4× polyphase, 8 taps a phase) ── */

void te_tp_coef(double h[TP_PHASES * TP_TAPS])
{
    int n = TP_PHASES * TP_TAPS, i, p, k;
    double centre = (n - 1) / 2.0;
    for (i = 0; i < n; i++) {
        double t = (i - centre) / TP_PHASES;
        double sinc = t == 0 ? 1.0 : js_sin(PI * t) / (PI * t);
        h[i] = sinc * (0.5 - 0.5 * js_cos((2 * PI * i) / (n - 1)));
    }
    for (p = 0; p < TP_PHASES; p++) {
        double s = 0.0;
        for (k = 0; k < TP_TAPS; k++) s += h[k * TP_PHASES + p];
        if (s != 0) for (k = 0; k < TP_TAPS; k++) h[k * TP_PHASES + p] /= s;
    }
}

double te_tp_push(TaudTruePeakProbe *pr, const double *coef, double v)
{
    double *h = pr->hist, hi;
    int k, p;
    for (k = TP_TAPS - 1; k > 0; k--) h[k] = h[k - 1];
    h[0] = v;
    hi = v < 0 ? -v : v;
    for (p = 0; p < TP_PHASES; p++) {
        double acc = 0.0, a;
        for (k = 0; k < TP_TAPS; k++) acc += h[k] * coef[k * TP_PHASES + p];
        a = acc < 0 ? -acc : acc;
        if (a > hi) hi = a;
    }
    return hi;
}

/* ── stages ── */

double te_one_pole(double ms, double rate)
{
    double n = (ms / 1000) * rate;
    return n <= 0 ? 1 : 1 - js_exp(-1 / n);
}
#define one_pole te_one_pole

void te_comp_configure(TaudCompressor *c, int detector, double threshDb, double ratio, double attackMs,
                       double releaseMs, double kneeDb, double makeupDb, double rate)
{
    c->peakMode = detector != COMP_RMS;
    c->thresh = threshDb;
    c->ratio = ratio;
    c->knee = kneeDb;
    c->makeup = db_to_gain(makeupDb);
    c->attackCoef = one_pole(attackMs, rate);
    c->releaseCoef = one_pole(releaseMs, rate);
    c->rmsCoef = one_pole(10, rate);
}

void te_comp_reset(TaudCompressor *c) { c->grDb = 0; c->rms = 0; c->levelDb = -120; }

static void comp_configure(TaudCompressor *c, const TaudMastering *p, double rate)
{
    te_comp_configure(c, p->compDetector, p->compThreshDb, p->compRatio, p->compAttackMs,
                      p->compReleaseMs, p->compKneeDb, p->compMakeupDb, rate);
}

static double comp_advance(TaudCompressor *c, double level)
{
    double levelDb = level > 1e-6 ? 20 * js_log10(level) : -120;
    double over = levelDb - c->thresh;
    double half = c->knee * 0.5;
    double targetDb, coef;
    c->levelDb = levelDb;
    if (c->knee > 0 && over > -half && over < half) {
        double t = over + half;
        targetDb = -((1 - 1 / c->ratio) * t * t) / (2 * c->knee);
    } else if (over > 0) {
        targetDb = -over * (1 - 1 / c->ratio);
    } else {
        targetDb = 0;
    }
    coef = targetDb < c->grDb ? c->attackCoef : c->releaseCoef;
    c->grDb += (targetDb - c->grDb) * coef;
    return db_to_gain(c->grDb) * c->makeup;
}

static double comp_step(TaudCompressor *c, double l, double r)
{
    double level;
    if (c->peakMode) {
        double al = l < 0 ? -l : l;
        double ar = r < 0 ? -r : r;
        level = al > ar ? al : ar;
    } else {
        double ms = (l * l + r * r) * 0.5;
        c->rms += (ms - c->rms) * c->rmsCoef;
        level = sqrt(c->rms);
    }
    return comp_advance(c, level);
}

/* The same detector over `nch` planar channels of a channel-major buffer
 * (stepPlanar): the peak over every channel of the frame, or the mean square
 * of all of them. */
double te_comp_step_planar(TaudCompressor *c, const double *data, int n, int stride, int nch)
{
    double level;
    int ch;
    if (c->peakMode) {
        level = 0;
        for (ch = 0; ch < nch; ch++) {
            double x = data[ch * stride + n];
            double a = x < 0 ? -x : x;
            if (a > level) level = a;
        }
    } else {
        double sum = 0;
        for (ch = 0; ch < nch; ch++) { double x = data[ch * stride + n]; sum += x * x; }
        c->rms += (sum / nch - c->rms) * c->rmsCoef;
        level = sqrt(c->rms);
    }
    return comp_advance(c, level);
}

void te_lim_init(TaudLimiter *L, int nch)
{
    memset(L, 0, sizeof *L);
    L->nch = nch;
    te_tp_coef(L->tpCoef);
}

void te_lim_free(TaudLimiter *L)
{
    free(L->delay);
    free(L->avg);
    if (L->hasMin) sm_free(&L->min);
    L->delay = NULL; L->avg = NULL; L->hasMin = false;
}

void te_lim_reset(TaudLimiter *L)
{
    int i;
    if (L->d == 0) return;
    memset(L->delay, 0, sizeof(double) * (size_t)L->nch * L->dstride);
    L->dpos = 0;
    sm_reset(&L->min, 1.0);
    for (i = 0; i < L->avgLen; i++) L->avg[i] = 1.0;
    L->avgSum = L->avgLen;
    L->apos = 0;
    L->env = 1;
    memset(L->probes, 0, sizeof L->probes);
    L->grDb = 0;
}

bool te_lim_configure(TaudLimiter *L, double ceilingDb, bool truePeak, double releaseMs, double rate)
{
    int d = imax(1, (int)js_round((LIMITER_LOOKAHEAD_MS / 1000) * rate));
    bool geometryChanged = d != L->d;
    if (geometryChanged) {
        te_lim_free(L);
        L->d = d;
        L->dstride = 2 * d;
        L->delay = (double *)calloc((size_t)L->nch * L->dstride, sizeof(double));
        L->hasMin = sm_init(&L->min, 2 * d + 1);
        L->avgLen = d + 1;
        L->avg = (double *)calloc((size_t)L->avgLen, sizeof(double));
        if (L->delay == NULL || !L->hasMin || L->avg == NULL) { L->d = 0; return false; }
    }
    L->ceiling = db_to_gain(ceilingDb);
    L->truePeak = truePeak;
    L->releaseCoef = one_pole(releaseMs, rate);
    if (geometryChanged) te_lim_reset(L);
    return true;
}

static bool lim_configure(TaudLimiter *L, const TaudMastering *p, double rate)
{
    return te_lim_configure(L, p->limCeilingDb, p->limTruePeak, p->limReleaseMs, rate);
}

static double lim_advance(TaudLimiter *L, double peak)
{
    double need = peak > L->ceiling ? L->ceiling / peak : 1;
    double m = sm_push(&L->min, need);
    int w = L->avgLen;
    double gain;
    L->env = m < L->env ? m : L->env + (m - L->env) * L->releaseCoef;
    L->avgSum += L->env - L->avg[L->apos];
    L->avg[L->apos] = L->env;
    L->apos = L->apos + 1 == w ? 0 : L->apos + 1;
    gain = L->avgSum / w;
    if (gain < 1) {
        double db = 20 * js_log10(gain);
        if (db < L->grDb) L->grDb = db;
    }
    return gain;
}

/* One frame in place over `nch` planar channels of a channel-major buffer
 * (stepPlanar): the peak across every channel, then the delayed frame out. */
void te_lim_step_planar(TaudLimiter *L, double *data, int n, int stride)
{
    int nch = L->nch, ch, s = L->dstride, i = L->dpos;
    double peak = 0, gain;
    for (ch = 0; ch < nch; ch++) {
        double x = data[ch * stride + n];
        double a = L->truePeak ? te_tp_push(&L->probes[ch], L->tpCoef, x) : (x < 0 ? -x : x);
        if (a > peak) peak = a;
    }
    gain = lim_advance(L, peak);
    for (ch = 0; ch < nch; ch++) {
        int j = ch * s + i;
        int k = ch * stride + n;
        double held = L->delay[j];
        L->delay[j] = data[k];
        data[k] = held * gain;
    }
    L->dpos = i + 1 == s ? 0 : i + 1;
}

/* ── the chain ── */

struct TaudMasterChain {
    double rate;
    TaudMastering params;
    TaudBiquad hp1, hp2;
    bool hpTwo;
    TaudBiquad eq[EQ_BANDS];
    int eqLive[EQ_BANDS];
    int eqLiveCount;
    TaudCompressor comp;
    TaudLimiter lim;
    double trimGain, outGain, width;
    bool engaged;
    /* The chunk's deepest gain reduction, dB (≤ 0), for the Mastering view. */
    double compGrDb, limGrDb;
};

TaudMasterChain *te_master_chain_new(const TaudMastering *p, int rate)
{
    TaudMasterChain *c = (TaudMasterChain *)calloc(1, sizeof *c);
    int i;
    if (c == NULL) return NULL;
    c->rate = rate;
    te_bq_init(&c->hp1);
    te_bq_init(&c->hp2);
    for (i = 0; i < EQ_BANDS; i++) te_bq_init(&c->eq[i]);
    te_lim_init(&c->lim, 2);
    te_mastering_default(&c->params);
    te_master_chain_set_params(c, p != NULL ? p : &c->params);
    return c;
}

void te_master_chain_free(TaudMasterChain *c)
{
    if (c == NULL) return;
    te_lim_free(&c->lim);
    free(c);
}

void te_master_chain_set_params(TaudMasterChain *c, const TaudMastering *pp)
{
    TaudMastering p = *pp;
    c->params = p;
    c->trimGain = db_to_gain(p.trimDb);
    c->outGain = db_to_gain(p.outGainDb);
    c->width = p.width;
    if (p.hpOn) {
        c->hpTwo = p.hpSlope == HP_SLOPE_24;
        if (c->hpTwo) {
            te_bq_high_pass(&c->hp1, p.hpFreq, 0.5411961001461969, c->rate);
            te_bq_high_pass(&c->hp2, p.hpFreq, 1.3065629648763766, c->rate);
        } else {
            te_bq_high_pass(&c->hp1, p.hpFreq, 0.7071067811865476, c->rate);
        }
    }
    if (p.eqOn) {
        int i;
        c->eqLiveCount = 0;
        for (i = 0; i < EQ_BANDS; i++) {
            const TaudEqBand *b = &p.eq[i];
            if (!b->on) continue;
            if (b->type == EQ_LOW_SHELF) te_bq_low_shelf(&c->eq[i], b->freq, b->gainDb, b->q, c->rate);
            else if (b->type == EQ_HIGH_SHELF) te_bq_high_shelf(&c->eq[i], b->freq, b->gainDb, b->q, c->rate);
            else te_bq_peaking(&c->eq[i], b->freq, b->gainDb, b->q, c->rate);
            c->eqLive[c->eqLiveCount++] = i;
        }
    }
    if (p.compOn) comp_configure(&c->comp, &p, c->rate);
    if (p.limOn) lim_configure(&c->lim, &p, c->rate);
    c->engaged = te_mastering_engaged(&p);
}

void te_master_chain_reset(TaudMasterChain *c)
{
    int i;
    te_bq_reset(&c->hp1);
    te_bq_reset(&c->hp2);
    for (i = 0; i < EQ_BANDS; i++) te_bq_reset(&c->eq[i]);
    te_comp_reset(&c->comp);
    te_lim_reset(&c->lim);
    c->compGrDb = 0;
    c->limGrDb = 0;
}

void te_master_chain_process(TaudMasterChain *c, float *left, float *right, int frames)
{
    const TaudMastering *p = &c->params;
    double trim, out, w;
    bool doHp, doEq, doComp, doWidth, doLim;
    int n, i;
    if (!c->engaged) return;
    trim = c->trimGain;
    out = c->outGain;
    doHp = p->hpOn; doEq = p->eqOn; doComp = p->compOn;
    doWidth = p->widthOn && c->width != 1;
    doLim = p->limOn && c->lim.d != 0;
    w = c->width;
    c->lim.grDb = 0;
    c->compGrDb = 0;

    for (n = 0; n < frames; n++) {
        double l = left[n] * trim;
        double r = right[n] * trim;
        if (doHp) {
            l = te_bq_run(&c->hp1, 0, l);
            if (c->hpTwo) l = te_bq_run(&c->hp2, 0, l);
            r = te_bq_run(&c->hp1, 1, r);
            if (c->hpTwo) r = te_bq_run(&c->hp2, 1, r);
        }
        if (doEq) {
            for (i = 0; i < c->eqLiveCount; i++) l = te_bq_run(&c->eq[c->eqLive[i]], 0, l);
            for (i = 0; i < c->eqLiveCount; i++) r = te_bq_run(&c->eq[c->eqLive[i]], 1, r);
        }
        if (doComp) {
            double g = comp_step(&c->comp, l, r);
            l *= g; r *= g;
            if (c->comp.grDb < c->compGrDb) c->compGrDb = c->comp.grDb;
        }
        if (doWidth) {
            double m = (l + r) * 0.5;
            double s = (l - r) * 0.5 * w;
            l = m + s; r = m - s;
        }
        if (doLim) {
            TaudLimiter *L = &c->lim;
            double pl = L->truePeak ? te_tp_push(&L->probes[0], L->tpCoef, l) : (l < 0 ? -l : l);
            double pr = L->truePeak ? te_tp_push(&L->probes[1], L->tpCoef, r) : (r < 0 ? -r : r);
            double gain = lim_advance(L, pl > pr ? pl : pr);
            int s = L->dstride, di = L->dpos;
            double dl = L->delay[di];
            double dr = L->delay[s + di];
            L->delay[di] = l;
            L->delay[s + di] = r;
            L->dpos = di + 1 == s ? 0 : di + 1;
            l = dl * gain;
            r = dr * gain;
        }
        left[n] = (float)(l * out);
        right[n] = (float)(r * out);
    }
    c->limGrDb = c->lim.grDb;
}

double te_master_chain_comp_gr(const TaudMasterChain *c) { return c != NULL ? c->compGrDb : 0.0; }
double te_master_chain_lim_gr(const TaudMasterChain *c) { return c != NULL ? c->limGrDb : 0.0; }
