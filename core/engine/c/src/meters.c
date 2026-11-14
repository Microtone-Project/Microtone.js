/* The master bus's meters — what the master strip (item 98) and the Mastering
 * view (item 178) draw from. Ported from analysis.js AnalysisTap and
 * loudness.js MasterMeterTap, and from engine-commands.js, which drained
 * them into the snapshot.
 *
 * The rule both follow: the ENGINE ships sums, the page owns the windows and
 * the look. A tap accumulates over a snapshot interval; draining it (the
 * snapshot, or a host's own drain) hands the interval over and starts the
 * next. The integrators that turn those sums into LUFS, LRA and the rest are
 * the page's (loudness.js), because they work over the intervals, not the
 * samples.
 *
 * ── The analysis tap (the master strip) ──
 * Two questions, two signals. "Where is the energy in the room?" — the
 * scopes — is always read off second-order ACN/SN3D B-format: a surround
 * song's analysis bus (spatial.c te_set_analysis_bus), or, for a stereo song,
 * the finished pair encoded as a ±90° pair (W = (L+R)/√2, Y = (L−R)/√2), so
 * the top view is the classic mid/side goniometer. "Will it clip, how loud
 * is it?" — the meters — read a TARGET: the pair, the field's own channels
 * (W Y X Z, Z dropped for a planar song), or a speaker layout's feeds,
 * rendered by the same renderer an export uses. Peaks per channel are also
 * read 4× oversampled (the true-peak kernel of mastering.c).
 *
 * ── The meter tap (the Mastering view) ──
 * The device pair on BOTH sides of the mastering chain, per stage: sample
 * and true peak, mean square, a clip count, the K-weighted energy loudness
 * is built from (ITU-R BS.1770: a shelf and the RLB high-pass, derived from
 * the analogue prototype so 32 kHz is measured with 32 kHz numbers), and —
 * when asked — the peak and energy after a phase-scrambling all-pass cascade
 * (eight second-order sections at octave spacing from 31.25 Hz to 4 kHz, all
 * at Q = 0.5: this project's own definition), which the ALLPASSED CREST is
 * read from. After the chain only: a census of the delivered codes — the
 * device's dithered 8 bits, or the 16 bits a clean WAV export writes off its
 * own TPDF stream — over the whole take and over two rolling spans (3 s and
 * 400 ms), expired exactly. Plus a mono and a stereo ring per stage for the
 * spectrum and the goniometer.
 *
 * Every number here is metering, not playback: nothing a song sounds like
 * depends on it, and nothing in it owes TSVM anything. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"
#include "snap_layout.h"

#define PI 3.141592653589793
#define SQRT1_2 0.7071067811865476

/* ── the analysis tap ─────────────────────────────────────────────────── */

#define METER_MIX 0
#define METER_FOA 1
#define METER_SPEAKERS 2

struct TaudAnalysisTap {
    int target, layout;
    bool stereoSong;
    int meterSource, meterCount;
    float ring[SCOPE_FRAMES * SCOPE_CHANNELS];
    int ringWrite;
    double peak[ANALYSIS_MAX_METERS], sumsq[ANALYSIS_MAX_METERS], clip[ANALYSIS_MAX_METERS];
    TaudTruePeakProbe probes[ANALYSIS_MAX_METERS];
    double tpPeak[ANALYSIS_MAX_METERS];
    double tpCoef[TP_PHASES * TP_TAPS];
    int frames;
    double fieldEnergy, corrLL, corrRR, corrLR;
};

/* The speaker layouts' channel counts, in speakers.js's order (quad, 5.1, 7.1). */
static const int LAYOUT_SPEAKERS[4] = { 0, 4, 6, 8 };

/* A tap for `target` (AN_TARGET_*; a speaker target's layout 1…3) on a song of
 * surround `model`. A stereo song's is fed from the pair alone; any other
 * model's also reads an analysis bus (te_analysis_bus_new(layout)). */
TaudAnalysisTap *te_analysis_tap_new(int target, int layout, int model)
{
    TaudAnalysisTap *t = (TaudAnalysisTap *)calloc(1, sizeof *t);
    if (t == NULL) return NULL;
    if (target != AN_TARGET_SPEAKERS || layout < 1 || layout > 3) layout = 0;
    t->target = target;
    t->layout = layout;
    t->stereoSong = model == SURROUND_STEREO;
    if (t->stereoSong || target == AN_TARGET_STEREO) {
        t->meterSource = METER_MIX;
        t->meterCount = 2;
    } else if (layout != 0) {
        t->meterSource = METER_SPEAKERS;
        t->meterCount = LAYOUT_SPEAKERS[layout];
    } else {
        t->meterSource = METER_FOA;
        /* A planar song can never excite Z: no permanently dead bar. */
        t->meterCount = model == SURROUND_SPATIAL ? 4 : 3;
    }
    te_tp_coef(t->tpCoef);
    return t;
}

int te_analysis_meter_count(const TaudAnalysisTap *t) { return t->meterCount; }
int te_analysis_meter_source(const TaudAnalysisTap *t) { return t->meterSource; }
bool te_analysis_needs_bus(const TaudAnalysisTap *t) { return !t->stereoSong; }
int te_analysis_layout(const TaudAnalysisTap *t) { return t->layout; }

/* Install (target ≥ 0) or drop (target < 0) the strip's tap. A new tap starts
 * empty; its shape follows the song's surround model as it stands, so the
 * host installs it again when the model or the render target moves. */
void te_set_analysis(TaudEngine *e, int target, int layout)
{
    TaudAnalysisTap *t;
    free(e->analysisTap);
    e->analysisTap = NULL;
    if (target < 0) { te_set_analysis_bus(e, -1); return; }
    t = te_analysis_tap_new(target, layout, e->ts_surroundModel);
    if (t == NULL) { e->oom = true; te_set_analysis_bus(e, -1); return; }
    /* A stereo song's field comes off the finished pair (two adds a frame):
     * no bus, no per-voice work. Any other model runs a second object bus. */
    te_set_analysis_bus(e, t->stereoSong ? -1 : t->layout);
    if (!t->stereoSong && e->analysisBus == NULL) { free(t); e->oom = true; return; }
    e->analysisTap = t;
}

/* Fold the chunk just rendered in: the finished device pair (post fold,
 * post chain, post clamp) and, for a surround song, the analysis bus. */
void te_analysis_finish(TaudAnalysisTap *t, const double *data, const float *mixL, const float *mixR, int frames)
{
    const int bf = TRACKER_CHUNK;
    int nc = t->meterCount, n, c;
    double m[ANALYSIS_MAX_METERS];
    for (n = 0; n < frames; n++) {
        double w, y, z, x, cl, cr;
        float *rw = t->ring + t->ringWrite * SCOPE_CHANNELS;
        if (data == NULL) {
            double l = mixL[n], r = mixR[n];
            w = (l + r) * SQRT1_2;
            y = (l - r) * SQRT1_2;
            z = 0.0;
            x = 0.0;
        } else {
            w = data[n];
            y = data[bf + n];
            z = data[2 * bf + n];
            x = data[3 * bf + n];
        }
        rw[0] = (float)w; rw[1] = (float)y; rw[2] = (float)z; rw[3] = (float)x;
        for (c = 4; c < SCOPE_CHANNELS; c++) rw[c] = data == NULL ? 0.0f : (float)data[c * bf + n];
        t->ringWrite = (t->ringWrite + 1) % SCOPE_FRAMES;

        t->fieldEnergy += (w * w + x * x + y * y + z * z) * 0.5;

        /* Correlation is always of a stereo pair: the mix itself, or the
         * field's coincident cardioid decode W ± Y. */
        if (data == NULL) { cl = mixL[n]; cr = mixR[n]; }
        else { cl = (w + y) * SQRT1_2; cr = (w - y) * SQRT1_2; }
        t->corrLL += cl * cl;
        t->corrRR += cr * cr;
        t->corrLR += cl * cr;

        if (t->meterSource == METER_MIX) { m[0] = mixL[n]; m[1] = mixR[n]; }
        else if (t->meterSource == METER_FOA) { m[0] = w; m[1] = y; m[2] = x; m[3] = z; }
        else for (c = 0; c < nc; c++) m[c] = data[(SCOPE_CHANNELS + c) * bf + n];
        for (c = 0; c < nc; c++) {
            double v = m[c];
            double a = v < 0 ? -v : v;
            double tp;
            if (a > t->peak[c]) t->peak[c] = a;
            t->sumsq[c] += v * v;
            /* The mix bus is clamped to ±1, so a sample AT full scale is a
             * clipped one; an object bus is not, and only exceeding it would
             * clip the file it is written to. */
            if (a >= 1.0) t->clip[c] += 1;
            tp = te_tp_push(&t->probes[c], t->tpCoef, v);
            if (tp > t->tpPeak[c]) t->tpPeak[c] = tp;
        }
    }
    t->frames += frames;
}

/* The interval's figures, in the readout's order (te_analysis_drain): */
#define AN_R_METERS 0
#define AN_R_FRAMES 1
#define AN_R_FIELD 2
#define AN_R_CORR_LL 3
#define AN_R_CORR_RR 4
#define AN_R_CORR_LR 5
#define AN_R_RING_WRITE 6
#define AN_R_PEAK 7
#define AN_R_TRUE_PEAK (AN_R_PEAK + ANALYSIS_MAX_METERS)
#define AN_R_MEAN_SQUARE (AN_R_TRUE_PEAK + ANALYSIS_MAX_METERS)
#define AN_R_CLIP (AN_R_MEAN_SQUARE + ANALYSIS_MAX_METERS)

/* Hand the interval over (`out`: AN_READOUT doubles) and start the next. The
 * peaks go too: the page holds the hold and the decay. */
void te_analysis_drain(TaudAnalysisTap *t, double *out)
{
    int c;
    out[AN_R_METERS] = t->meterCount;
    out[AN_R_FRAMES] = t->frames;
    out[AN_R_FIELD] = t->fieldEnergy;
    out[AN_R_CORR_LL] = t->corrLL;
    out[AN_R_CORR_RR] = t->corrRR;
    out[AN_R_CORR_LR] = t->corrLR;
    out[AN_R_RING_WRITE] = t->ringWrite;
    for (c = 0; c < ANALYSIS_MAX_METERS; c++) {
        bool live = c < t->meterCount;
        double tp = t->tpPeak[c];
        out[AN_R_PEAK + c] = live ? t->peak[c] : 0;
        out[AN_R_TRUE_PEAK + c] = live ? (tp > t->peak[c] ? tp : t->peak[c]) : 0;
        out[AN_R_MEAN_SQUARE + c] = live && t->frames > 0 ? t->sumsq[c] / t->frames : 0;
        out[AN_R_CLIP + c] = live ? t->clip[c] : 0;
    }
    t->frames = 0;
    t->fieldEnergy = 0.0;
    t->corrLL = t->corrRR = t->corrLR = 0.0;
    memset(t->peak, 0, sizeof t->peak);
    memset(t->sumsq, 0, sizeof t->sumsq);
    memset(t->clip, 0, sizeof t->clip);
    memset(t->tpPeak, 0, sizeof t->tpPeak);
}

const float *te_analysis_ring(const TaudAnalysisTap *t) { return t->ring; }

/* ── the meter tap: K-weighting (BS.1770) ─────────────────────────────── */

#define KW_SHELF_F0 1681.974450955533
#define KW_SHELF_G 3.999843853973347
#define KW_SHELF_Q 0.7071752369554196
#define KW_SHELF_VB_EXP 0.4996667741545416
#define KW_HP_F0 38.13547087602444
#define KW_HP_Q 0.5003270373238773

/* Stage 1 (the shelf) then stage 2 (the RLB high-pass, numerator 1, −2, 1),
 * as {b0, b1, b2, a1, a2} each, normalised to a0. */
void te_kw_coefficients(double rate, double shelf[5], double hp[5])
{
    double k1 = js_tan((PI * KW_SHELF_F0) / rate);
    double vh = js_pow(10.0, KW_SHELF_G / 20);
    double vb = js_pow(vh, KW_SHELF_VB_EXP);
    double d1 = 1 + k1 / KW_SHELF_Q + k1 * k1;
    double k2 = js_tan((PI * KW_HP_F0) / rate);
    double d2 = 1 + k2 / KW_HP_Q + k2 * k2;
    shelf[0] = (vh + (vb * k1) / KW_SHELF_Q + k1 * k1) / d1;
    shelf[1] = (2 * (k1 * k1 - vh)) / d1;
    shelf[2] = (vh - (vb * k1) / KW_SHELF_Q + k1 * k1) / d1;
    shelf[3] = (2 * (k1 * k1 - 1)) / d1;
    shelf[4] = (1 - k1 / KW_SHELF_Q + k1 * k1) / d1;
    hp[0] = 1; hp[1] = -2; hp[2] = 1;
    hp[3] = (2 * (k2 * k2 - 1)) / d2;
    hp[4] = (1 - k2 / KW_HP_Q + k2 * k2) / d2;
}

/* One channel's pair of sections, Direct Form I: x1 x2 y1 y2 u1 u2 v1 v2. */
double te_kw_run(const double *s, const double *h, double st[8], double x)
{
    double y = s[0] * x + s[1] * st[0] + s[2] * st[1] - s[3] * st[2] - s[4] * st[3];
    double v;
    st[1] = st[0]; st[0] = x;
    st[3] = st[2]; st[2] = y;
    v = h[0] * y + h[1] * st[4] + h[2] * st[5] - h[3] * st[6] - h[4] * st[7];
    st[5] = st[4]; st[4] = y;
    st[7] = st[6]; st[6] = v;
    return v;
}

/* ── the phase-scrambling all-pass cascade ── */

static const double PHASE_SCRAMBLE_HZ[AP_SECTIONS] = { 31.25, 62.5, 125, 250, 500, 1000, 2000, 4000 };
#define PHASE_SCRAMBLE_Q 0.5

/* b0, b1, a1, a2 of each section (b2 = 1). */
void te_ap_coefficients(double rate, double c[AP_SECTIONS][4])
{
    int i;
    for (i = 0; i < AP_SECTIONS; i++) {
        double w = (2 * PI * dmin(PHASE_SCRAMBLE_HZ[i], rate * 0.49)) / rate;
        double alpha = js_sin(w) / (2 * PHASE_SCRAMBLE_Q);
        double a0 = 1 + alpha;
        c[i][0] = (1 - alpha) / a0;
        c[i][1] = (-2 * js_cos(w)) / a0;
        c[i][2] = (-2 * js_cos(w)) / a0;
        c[i][3] = (1 - alpha) / a0;
    }
}

/* One channel through the cascade; `st` is x1 x2 y1 y2 per section. */
double te_ap_run(const double c[AP_SECTIONS][4], double st[AP_SECTIONS][4], double x)
{
    double v = x;
    int i;
    for (i = 0; i < AP_SECTIONS; i++) {
        double y = c[i][0] * v + c[i][1] * st[i][0] + st[i][1] - c[i][2] * st[i][2] - c[i][3] * st[i][3];
        st[i][1] = st[i][0]; st[i][0] = v;
        st[i][3] = st[i][2]; st[i][2] = y;
        v = y;
    }
    return v;
}

/* ── the meter tap ── */

#define HIST_SPAN_ALL 0
#define HIST_SPAN_LONG 1
#define HIST_SPAN_SHORT 2

struct TaudMasterMeter {
    double rate;
    bool scramble;
    int bitDepth, histSpan;
    double kwShelf[5], kwHp[5];
    double kw[MM_STAGES][2][8];
    TaudTruePeakProbe probes[MM_STAGES][2];
    double tpCoef[TP_PHASES * TP_TAPS];
    double tpPeak[MM_STAGES * 2];
    double ap[AP_SECTIONS][4];
    double apSt[MM_STAGES][2][AP_SECTIONS][4];
    double apPeak[MM_STAGES], apSumSq[MM_STAGES];
    double sumZ[MM_STAGES], sumSq[MM_STAGES * 2], peak[MM_STAGES * 2], clip[MM_STAGES * 2];
    /* The census of the delivered code at bitDepth: the whole take, and the
     * two rolling spans over ONE ring of the codes themselves (the short span
     * is a suffix of the long one: two tails, one tape). Expiry is exact — a
     * code counted as "used" must stop being counted when it leaves. */
    double *hist, *histLong, *histShort;
    uint16_t *codeRing;
    int ringLen, shortLag, ringWrite;
    bool ringFull;
    /* The clean WAV export's dither stream (player.c te_dither_s16), started
     * again with the census, so a census from the top counts the file's codes. */
    uint32_t dither16;
    double buckets[MM_HIST_BUCKETS];
    float spec[MM_STAGES][MM_SPEC_FRAMES];
    float pair[MM_STAGES][MM_SPEC_FRAMES * 2];
    int specWrite;
    int frames;
    double compGrDb, limGrDb;
};

static int codes_for(double sec, double rate)
{
    int n = (int)js_round(sec * rate);
    return (n < 1 ? 1 : n) * 2;
}

void te_master_meter_reset_all(TaudMasterMeter *t)
{
    size_t codes = (size_t)1 << t->bitDepth;
    memset(t->kw, 0, sizeof t->kw);
    memset(t->probes, 0, sizeof t->probes);
    memset(t->tpPeak, 0, sizeof t->tpPeak);
    memset(t->apSt, 0, sizeof t->apSt);
    memset(t->sumZ, 0, sizeof t->sumZ);
    memset(t->sumSq, 0, sizeof t->sumSq);
    memset(t->peak, 0, sizeof t->peak);
    memset(t->clip, 0, sizeof t->clip);
    memset(t->apPeak, 0, sizeof t->apPeak);
    memset(t->apSumSq, 0, sizeof t->apSumSq);
    memset(t->hist, 0, codes * sizeof(double));
    memset(t->histLong, 0, codes * sizeof(double));
    memset(t->histShort, 0, codes * sizeof(double));
    t->ringWrite = 0;
    t->ringFull = false;
    t->dither16 = TE_XORSHIFT_SEED;
    memset(t->spec, 0, sizeof t->spec);
    memset(t->pair, 0, sizeof t->pair);
    t->specWrite = 0;
    t->frames = 0;
    t->compGrDb = 0;
    t->limGrDb = 0;
}

void te_master_meter_free(TaudMasterMeter *t)
{
    if (t == NULL) return;
    free(t->hist);
    free(t->histLong);
    free(t->histShort);
    free(t->codeRing);
    free(t);
}

TaudMasterMeter *te_master_meter_new(double rate, bool scramble, int bitDepth)
{
    TaudMasterMeter *t = (TaudMasterMeter *)calloc(1, sizeof *t);
    size_t codes;
    if (t == NULL) return NULL;
    t->rate = rate;
    t->scramble = scramble;
    t->bitDepth = bitDepth == 8 ? 8 : 16;
    codes = (size_t)1 << t->bitDepth;
    te_kw_coefficients(rate, t->kwShelf, t->kwHp);
    te_tp_coef(t->tpCoef);
    te_ap_coefficients(rate, t->ap);
    t->ringLen = codes_for(3.0, rate);
    t->shortLag = codes_for(0.4, rate);
    if (t->shortLag > t->ringLen) t->shortLag = t->ringLen;
    t->hist = (double *)calloc(codes, sizeof(double));
    t->histLong = (double *)calloc(codes, sizeof(double));
    t->histShort = (double *)calloc(codes, sizeof(double));
    t->codeRing = (uint16_t *)calloc((size_t)t->ringLen, sizeof(uint16_t));
    if (t->hist == NULL || t->histLong == NULL || t->histShort == NULL || t->codeRing == NULL) {
        te_master_meter_free(t);
        return NULL;
    }
    t->histSpan = HIST_SPAN_ALL;
    te_master_meter_reset_all(t);
    return t;
}

/* Install, keep or drop (on = false) the Mastering view's tap. A different
 * scramble choice or depth is a new tap; the census span is only a reporting
 * choice and carries over. */
void te_set_master_meter(TaudEngine *e, bool on, bool scramble, int bitDepth, int histSpan)
{
    int depth = bitDepth == 8 ? 8 : 16;
    if (!on) {
        te_master_meter_free(e->masterMeter);
        e->masterMeter = NULL;
        e->preTap = false;
        return;
    }
    if (e->masterMeter == NULL || e->masterMeter->scramble != scramble || e->masterMeter->bitDepth != depth) {
        TaudMasterMeter *t = te_master_meter_new(e->rate, scramble, depth);
        if (t == NULL) { e->oom = true; return; }
        te_master_meter_free(e->masterMeter);
        e->masterMeter = t;
    }
    te_master_meter_set_span(e->masterMeter, histSpan);
    e->preTap = true;
}

/* Fold one block in at `stage`: before the chain runs over the mix, then
 * after it. */
void te_master_meter_push(TaudMasterMeter *t, int stage, const float *left, const float *right, int frames)
{
    int so = stage * 2, n, w;
    double z = t->sumZ[stage];
    double sqL = t->sumSq[so], sqR = t->sumSq[so + 1];
    double pkL = t->peak[so], pkR = t->peak[so + 1];
    double clL = t->clip[so], clR = t->clip[so + 1];
    float *ring = t->spec[stage], *pair = t->pair[stage];
    for (n = 0; n < frames; n++) {
        double l = left[n], r = right[n];
        double zl = te_kw_run(t->kwShelf, t->kwHp, t->kw[stage][0], l);
        double zr = te_kw_run(t->kwShelf, t->kwHp, t->kw[stage][1], r);
        double al = l < 0 ? -l : l, ar = r < 0 ? -r : r, tp;
        z += zl * zl + zr * zr;
        sqL += l * l; sqR += r * r;
        if (al > pkL) pkL = al;
        if (ar > pkR) pkR = ar;
        /* At full scale the delivered sample is a clipped one. */
        if (al >= 1) clL += 1;
        if (ar >= 1) clR += 1;
        tp = te_tp_push(&t->probes[stage][0], t->tpCoef, l);
        if (tp > t->tpPeak[so]) t->tpPeak[so] = tp;
        tp = te_tp_push(&t->probes[stage][1], t->tpCoef, r);
        if (tp > t->tpPeak[so + 1]) t->tpPeak[so + 1] = tp;
    }
    if (t->scramble) {
        double apk = t->apPeak[stage], asq = t->apSumSq[stage];
        for (n = 0; n < frames; n++) {
            double sl = te_ap_run(t->ap, t->apSt[stage][0], left[n]);
            double sr = te_ap_run(t->ap, t->apSt[stage][1], right[n]);
            double asl = sl < 0 ? -sl : sl, asr = sr < 0 ? -sr : sr;
            double a = asl > asr ? asl : asr;
            if (a > apk) apk = a;
            asq += sl * sl + sr * sr;
        }
        t->apPeak[stage] = apk;
        t->apSumSq[stage] = asq;
    }
    /* The rings. The cursor belongs to the POST pass, the second of the two;
     * PRE writes at the same places on its way past. */
    w = t->specWrite;
    for (n = 0; n < frames; n++) {
        ring[w] = (float)(((double)left[n] + (double)right[n]) * 0.5);
        pair[w * 2] = left[n];
        pair[w * 2 + 1] = right[n];
        w = w + 1 == MM_SPEC_FRAMES ? 0 : w + 1;
    }
    if (stage == MM_TAP_POST) t->specWrite = w;
    t->sumZ[stage] = z;
    t->sumSq[so] = sqL; t->sumSq[so + 1] = sqR;
    t->peak[so] = pkL; t->peak[so + 1] = pkR;
    t->clip[so] = clL; t->clip[so + 1] = clR;
    if (stage == MM_TAP_POST) t->frames += frames;
}

/* One code through all three censuses. `w` is where it is about to land, so
 * ring[w] is the oldest code the long span holds and ring[w − lag] the oldest
 * the short one does; before the ring has wrapped, `w` is also the count. */
static inline void census(TaudMasterMeter *t, unsigned code)
{
    int w = t->ringWrite, cap = t->ringLen, lag = t->shortLag;
    t->hist[code] += 1;
    if (t->ringFull) t->histLong[t->codeRing[w]] -= 1;
    if (t->ringFull || w >= lag) t->histShort[t->codeRing[(w - lag + cap) % cap]] -= 1;
    t->codeRing[w] = (uint16_t)code;
    t->histLong[code] += 1;
    t->histShort[code] += 1;
    if (++w == cap) { w = 0; t->ringFull = true; }
    t->ringWrite = w;
}

/* Bin one block of delivered output: at 8 bits the device's own dithered
 * codes; at 16 the codes a clean WAV export writes from the float pair, off
 * the export's own dither stream (left before right, as it interleaves). */
void te_master_meter_bin(TaudMasterMeter *t, const uint8_t *u8, const float *left, const float *right, int frames)
{
    int i;
    if (t->bitDepth == 8) {
        for (i = 0; i < frames * 2; i++) census(t, u8[i]);
        return;
    }
    for (i = 0; i < frames; i++) {
        census(t, (unsigned)(te_dither_s16(&t->dither16, left[i]) + 32768) & 0xffff);
        census(t, (unsigned)(te_dither_s16(&t->dither16, right[i]) + 32768) & 0xffff);
    }
}

/* How much of the code space a census touches (loudness.js bitUsage):
 * out = used, span, total, peakCode, minCode, maxCode, effectiveBits,
 * entropyBits. */
void te_bit_usage(const double *hist, int depth, double out[8])
{
    int codes = 1 << depth, mid = codes >> 1, i;
    double total = 0, used = 0, peakCount = -1, h = 0;
    int minCode = -1, maxCode = -1, peakCode = 0;
    for (i = 0; i < codes; i++) {
        double c = hist[i];
        if (c > 0) {
            used++;
            if (minCode < 0) minCode = i;
            maxCode = i;
            total += c;
            if (c > peakCount) { peakCount = c; peakCode = i; }
        }
    }
    if (total == 0) {
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = mid; out[4] = mid; out[5] = mid; out[6] = 0; out[7] = 0;
        return;
    }
    for (i = 0; i < codes; i++) {
        double c = hist[i];
        if (c > 0) { double p = c / total; h -= p * js_log2(p); }
    }
    out[0] = used;
    out[1] = maxCode - minCode + 1;
    out[2] = total;
    out[3] = peakCode;
    out[4] = minCode;
    out[5] = maxCode;
    out[6] = js_log2(maxCode - minCode + 1);
    out[7] = h;
}

static const double *census_for(const TaudMasterMeter *t, int span)
{
    return span == HIST_SPAN_LONG ? t->histLong : span == HIST_SPAN_SHORT ? t->histShort : t->hist;
}

/* A census at full resolution: 1 << bitDepth counts. */
const double *te_master_meter_hist(const TaudMasterMeter *t, int span) { return census_for(t, span); }

/* A census's figures (out: te_bit_usage's eight) and its picture, downsampled
 * to MM_HIST_BUCKETS raw counts (at 16 bits a bucket is a code's top 8 bits). */
void te_master_meter_census(TaudMasterMeter *t, int span, double bits[8], double *buckets)
{
    const double *c = census_for(t, span);
    int shift = t->bitDepth - 8, n = 1 << t->bitDepth, i;
    te_bit_usage(c, t->bitDepth, bits);
    memset(buckets, 0, MM_HIST_BUCKETS * sizeof(double));
    if (shift == 0) memcpy(buckets, c, MM_HIST_BUCKETS * sizeof(double));
    else for (i = 0; i < n; i++) buckets[i >> shift] += c[i];
}

/* Hand the interval over (`out`: MM_READOUT doubles — the MM_R_* fields) and
 * start the next. The census is the take's and stays; the figures and the
 * buckets are those of the span the view reports. */
void te_master_meter_drain(TaudMasterMeter *t, double *out)
{
    int s, c;
    out[MM_R_FRAMES] = t->frames;
    out[MM_R_COMP_GR] = t->compGrDb;
    out[MM_R_LIM_GR] = t->limGrDb;
    for (s = 0; s < MM_STAGES; s++) {
        out[MM_R_SUM_Z + s] = t->sumZ[s];
        for (c = 0; c < 2; c++) {
            int i = s * 2 + c;
            double tp = t->tpPeak[i];
            out[MM_R_PEAK + i] = t->peak[i];
            out[MM_R_TRUE_PEAK + i] = tp > t->peak[i] ? tp : t->peak[i];
            out[MM_R_MEAN_SQUARE + i] = t->frames > 0 ? t->sumSq[i] / t->frames : 0;
            out[MM_R_CLIP + i] = t->clip[i];
        }
        out[MM_R_AP_PEAK + s] = t->apPeak[s];
        out[MM_R_AP_SUM_SQ + s] = t->apSumSq[s];
    }
    out[MM_R_BIT_DEPTH] = t->bitDepth;
    out[MM_R_HIST_SPAN] = t->histSpan;
    out[MM_R_SPEC_WRITE] = t->specWrite;
    te_master_meter_census(t, t->histSpan, out + MM_R_BITS, t->buckets);
    memcpy(out + MM_R_BUCKETS, t->buckets, sizeof t->buckets);
    memset(t->sumZ, 0, sizeof t->sumZ);
    memset(t->sumSq, 0, sizeof t->sumSq);
    memset(t->peak, 0, sizeof t->peak);
    memset(t->clip, 0, sizeof t->clip);
    memset(t->apPeak, 0, sizeof t->apPeak);
    memset(t->apSumSq, 0, sizeof t->apSumSq);
    memset(t->tpPeak, 0, sizeof t->tpPeak);
    t->frames = 0;
    t->compGrDb = 0;
    t->limGrDb = 0;
}

void te_master_meter_set_span(TaudMasterMeter *t, int span)
{
    t->histSpan = span == HIST_SPAN_LONG || span == HIST_SPAN_SHORT ? span : HIST_SPAN_ALL;
}

const float *te_master_meter_rings(const TaudMasterMeter *t) { return &t->spec[0][0]; }
const float *te_master_meter_pairs(const TaudMasterMeter *t) { return &t->pair[0][0]; }
int te_master_meter_depth(const TaudMasterMeter *t) { return t->bitDepth; }

/* ── the engine's side ────────────────────────────────────────────────── */

/* After a chunk is rendered (te_render_chunk): the mix into the chain was
 * kept in preLeft/Right, the finished pair is mixLeft/Right. */
void te_meters_after_render(TaudEngine *e)
{
    TaudMasterMeter *mm = e->masterMeter;
    if (mm != NULL) te_master_meter_push(mm, MM_TAP_PRE, e->preLeft, e->preRight, TRACKER_CHUNK);
    if (e->analysisTap != NULL) {
        te_analysis_finish(e->analysisTap, e->analysisBus != NULL ? e->analysisBus->data : NULL,
                           e->mixLeft, e->mixRight, TRACKER_CHUNK);
    }
    if (mm != NULL) {
        te_master_meter_push(mm, MM_TAP_POST, e->mixLeft, e->mixRight, TRACKER_CHUNK);
        mm->compGrDb = te_master_chain_comp_gr(e->mastering);
        mm->limGrDb = te_master_chain_lim_gr(e->mastering);
    }
}

/* Drain both taps into the snapshot, at protocol.js's offsets. A tap that is
 * off writes its "off" marker and leaves its block alone. */
void te_fill_meters(TaudEngine *e, float *f)
{
    double r[MM_READOUT > AN_READOUT ? MM_READOUT : AN_READOUT];
    int s, c, i;
    if (e->analysisTap == NULL) {
        f[SNAP_AN_METERS] = 0;
        f[SNAP_AN_FRAMES] = 0;
        f[SNAP_AN_FIELD] = 0;
        f[SNAP_AN_CORR_LL] = 0;
        f[SNAP_AN_CORR_RR] = 0;
        f[SNAP_AN_CORR_LR] = 0;
    } else {
        te_analysis_drain(e->analysisTap, r);
        f[SNAP_AN_METERS] = (float)r[AN_R_METERS];
        f[SNAP_AN_FRAMES] = (float)r[AN_R_FRAMES];
        f[SNAP_AN_FIELD] = (float)r[AN_R_FIELD];
        f[SNAP_AN_CORR_LL] = (float)r[AN_R_CORR_LL];
        f[SNAP_AN_CORR_RR] = (float)r[AN_R_CORR_RR];
        f[SNAP_AN_CORR_LR] = (float)r[AN_R_CORR_LR];
        f[SNAP_AN_RING_WRITE] = (float)r[AN_R_RING_WRITE];
        for (c = 0; c < ANALYSIS_MAX_METERS; c++) {
            float *o = f + SNAP_METER_BASE + c * SNAP_METER_STRIDE;
            o[SNAP_M_PEAK] = (float)r[AN_R_PEAK + c];
            o[SNAP_M_TRUE_PEAK] = (float)r[AN_R_TRUE_PEAK + c];
            o[SNAP_M_MEAN_SQUARE] = (float)r[AN_R_MEAN_SQUARE + c];
            o[SNAP_M_CLIP] = (float)r[AN_R_CLIP + c];
        }
        memcpy(f + SNAP_SCOPE_BASE, e->analysisTap->ring, sizeof e->analysisTap->ring);
    }
    if (e->masterMeter == NULL) {
        f[SNAP_MM_FRAMES] = 0;
        f[SNAP_MM_COMP_GR] = 0;
        f[SNAP_MM_LIM_GR] = 0;
        f[SNAP_MM_HIST_TOTAL] = 0;
        f[SNAP_MM_SPEC_WRITE] = 0;
        f[SNAP_MM_HIST_DEPTH] = 0;
        f[SNAP_MM_HIST_USED] = 0;
        f[SNAP_MM_HIST_MIN] = 0;
        f[SNAP_MM_HIST_MAX] = 0;
        f[SNAP_MM_HIST_ENTROPY] = 0;
    } else {
        TaudMasterMeter *t = e->masterMeter;
        double total, inv;
        te_master_meter_drain(t, r);
        f[SNAP_MM_FRAMES] = (float)r[MM_R_FRAMES];
        f[SNAP_MM_COMP_GR] = (float)r[MM_R_COMP_GR];
        f[SNAP_MM_LIM_GR] = (float)r[MM_R_LIM_GR];
        for (s = 0; s < MM_STAGES; s++) {
            float *o = f + SNAP_MM_BASE + s * SNAP_MM_STAGE_STRIDE;
            o[SNAP_MM_SUM_Z] = (float)r[MM_R_SUM_Z + s];
            for (c = 0; c < 2; c++) {
                float *co = o + SNAP_MM_CH + c * SNAP_MM_C_STRIDE;
                i = s * 2 + c;
                co[SNAP_MM_C_PEAK] = (float)r[MM_R_PEAK + i];
                co[SNAP_MM_C_TRUE_PEAK] = (float)r[MM_R_TRUE_PEAK + i];
                co[SNAP_MM_C_MEAN_SQUARE] = (float)r[MM_R_MEAN_SQUARE + i];
                co[SNAP_MM_C_CLIP] = (float)r[MM_R_CLIP + i];
            }
            o[SNAP_MM_AP_PEAK] = (float)r[MM_R_AP_PEAK + s];
            o[SNAP_MM_AP_SUM_SQ] = (float)r[MM_R_AP_SUM_SQ + s];
        }
        /* Normalised buckets: a raw count leaves float32's exact integers
         * after a few minutes on one code. The figures are the full census's. */
        total = r[MM_R_BITS + 2];
        f[SNAP_MM_HIST_TOTAL] = (float)total;
        f[SNAP_MM_HIST_DEPTH] = (float)r[MM_R_BIT_DEPTH];
        f[SNAP_MM_HIST_USED] = (float)r[MM_R_BITS + 0];
        f[SNAP_MM_HIST_MIN] = (float)r[MM_R_BITS + 4];
        f[SNAP_MM_HIST_MAX] = (float)r[MM_R_BITS + 5];
        f[SNAP_MM_HIST_ENTROPY] = (float)r[MM_R_BITS + 7];
        inv = total > 0 ? 1 / total : 0;
        for (i = 0; i < SNAP_HIST_BINS; i++) f[SNAP_HIST_BASE + i] = (float)(r[MM_R_BUCKETS + i] * inv);
        f[SNAP_MM_SPEC_WRITE] = (float)r[MM_R_SPEC_WRITE];
        for (s = 0; s < MM_STAGES; s++) {
            memcpy(f + SNAP_SPEC_BASE + s * SNAP_SPEC_FRAMES, t->spec[s], sizeof t->spec[s]);
            memcpy(f + SNAP_PAIR_BASE + s * 2 * SNAP_SPEC_FRAMES, t->pair[s], sizeof t->pair[s]);
        }
    }
}
