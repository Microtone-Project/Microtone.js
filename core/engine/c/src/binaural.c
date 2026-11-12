/* Binaural monitoring — port of binaural.js.
 *
 * The bus channels ARE an ambisonic scene (SN3D/ACN); the monitor pair is that
 * scene decoded through the SADIE HRIRs, one convolution per channel, summed.
 * The right ear is free: mirroring the listener flips the sign of every
 * harmonic with m < 0, so L = Σ(m≥0) + Σ(m<0), R = Σ(m≥0) − Σ(m<0). */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

#define HRIR_ORDER 3
#define HRIR_CHANNELS 16
#define HRIR_LENGTH 256
#define HRIR_RATE 48000
#define BIN_ORDER 3
#define BIN_SH_COUNT 16
#define BIN_FRONT_AZIMUTH 128
#define BIN_RESAMP_HALF 24
#define BIN_RESAMP_BETA 8.0

static int binaural_channel_list(bool sphere, int *out)
{
    int l, m, n = 0;
    for (l = 0; l <= BIN_ORDER; l++) {
        for (m = -l; m <= l; m++) {
            if (sphere || (l - abs(m)) % 2 == 0) out[n++] = l * l + l + m;
        }
    }
    return n;
}

static void binaural_mirror_signs(const int *acn, int n, int8_t *out)
{
    int i;
    for (i = 0; i < n; i++) {
        int k = acn[i];
        int l = (int)floor(sqrt((double)k));
        out[i] = (int8_t)(k - (l * l + l) >= 0 ? 1 : -1);
    }
}

static double bin_bessel_i0(double x)
{
    double sum = 1.0, term = 1.0, half = x * 0.5;
    int k;
    for (k = 1; k < 24; k++) {
        term *= (half / k) * (half / k);
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

/* Rate-convert the whole set; taps scaled by 1/ratio (impulse responses). */
static double *binaural_resample(const double *src, int srcLen, int channels, int rate, int *dstLenOut)
{
    double ratio = (double)rate / HRIR_RATE;
    double cutoff = ratio < 1.0 ? ratio : 1.0;
    double half = ceil(BIN_RESAMP_HALF / cutoff);
    int dstLen = ((int)ceil(srcLen * ratio) + 3) & ~3;
    double norm = bin_bessel_i0(BIN_RESAMP_BETA);
    double scale = 1.0 / ratio;
    double *out = (double *)calloc((size_t)channels * dstLen, sizeof(double));
    int n;
    if (out == NULL) return NULL;
    for (n = 0; n < dstLen; n++) {
        double t = n / ratio;
        int lo = (int)dmax(0, ceil(t - half));
        int hi = (int)dmin(srcLen - 1, floor(t + half));
        int i, c;
        for (i = lo; i <= hi; i++) {
            double d = t - i;
            double u = cutoff * d;
            double sinc = fabs(u) < 1e-9 ? 1.0 : js_sin(3.141592653589793 * u) / (3.141592653589793 * u);
            double x = d / half;
            double w = bin_bessel_i0(BIN_RESAMP_BETA * sqrt(1.0 - x * x)) / norm;
            double g = cutoff * sinc * w * scale;
            for (c = 0; c < channels; c++) out[c * dstLen + n] += src[c * srcLen + i] * g;
        }
    }
    *dstLenOut = dstLen;
    return out;
}

/* Level contract: a source dead ahead leaves the head with the power the pan
 * law gives it. */
static double binaural_calibration(const double *hrir, int len)
{
    double sh[BIN_SH_COUNT];
    int all[BIN_SH_COUNT], k, n;
    int8_t mirror[BIN_SH_COUNT];
    double energy = 0.0;
    te_encode_sn3d(BIN_FRONT_AZIMUTH, 0.0, BIN_ORDER, sh);
    for (k = 0; k < BIN_SH_COUNT; k++) all[k] = k;
    binaural_mirror_signs(all, BIN_SH_COUNT, mirror);
    for (n = 0; n < len; n++) {
        double p = 0.0, q = 0.0;
        for (k = 0; k < BIN_SH_COUNT; k++) {
            double v = sh[k] * hrir[k * len + n];
            if (mirror[k] > 0) p += v; else q += v;
        }
        energy += (p + q) * (p + q) + (p - q) * (p - q);
    }
    return 1.0 / sqrt(energy);
}

TaudBinaural *te_binaural_new(bool sphere, int rate)
{
    TaudBinaural *b = (TaudBinaural *)calloc(1, sizeof *b);
    double *raw, *hrir;
    int taps, i, c;
    double gain;
    if (b == NULL) return NULL;
    raw = (double *)malloc(sizeof(double) * HRIR_CHANNELS * HRIR_LENGTH);
    if (raw == NULL) { free(b); return NULL; }
    for (i = 0; i < HRIR_CHANNELS * HRIR_LENGTH; i++) raw[i] = HRIR_SADIE[i] / 32768.0;
    if (rate == HRIR_RATE) {
        hrir = raw;
        taps = HRIR_LENGTH;
    } else {
        hrir = binaural_resample(raw, HRIR_LENGTH, HRIR_CHANNELS, rate, &taps);
        free(raw);
        if (hrir == NULL) { free(b); return NULL; }
    }
    gain = binaural_calibration(hrir, taps);
    for (i = 0; i < HRIR_CHANNELS * taps; i++) hrir[i] *= gain;

    b->sphere = sphere;
    b->numChannels = binaural_channel_list(sphere, b->acn);
    b->taps = taps;
    b->hrir = (double *)malloc(sizeof(double) * b->numChannels * taps);
    b->hist = (double *)calloc((size_t)b->numChannels * taps * 2, sizeof(double));
    if (b->hrir == NULL || b->hist == NULL) {
        free(hrir);
        te_binaural_free(b);
        return NULL;
    }
    for (c = 0; c < b->numChannels; c++) {
        memcpy(b->hrir + (size_t)c * taps, hrir + (size_t)b->acn[c] * taps, sizeof(double) * taps);
    }
    free(hrir);
    binaural_mirror_signs(b->acn, b->numChannels, b->mirror);
    b->histPos = 0;
    return b;
}

void te_binaural_free(TaudBinaural *b)
{
    if (b == NULL) return;
    free(b->hrir);
    free(b->hist);
    free(b);
}

void te_binaural_reset(TaudBinaural *b)
{
    memset(b->hist, 0, sizeof(double) * b->numChannels * b->taps * 2);
    b->histPos = 0;
}

void te_binaural_channel_gains(const TaudBinaural *b, double az, double el, double *out, int off)
{
    double sh[BIN_SH_COUNT];
    int c;
    te_encode_sn3d(az, el, BIN_ORDER, sh);
    for (c = 0; c < b->numChannels; c++) out[off + c] = sh[b->acn[c]];
}

/* Decode one frame to two ears. Called once per frame, in frame order. */
void te_binaural_monitor_stereo(TaudBinaural *b, const double *data, int frames, int n, double out[2])
{
    int nc = b->numChannels, taps = b->taps, pos = b->histPos, c, i;
    const double *hrir = b->hrir;
    double *hist = b->hist;
    double p = 0.0, q = 0.0;

    for (c = 0; c < nc; c++) {
        int base = c * taps * 2;
        double x = data[c * frames + n];
        int hb = c * taps;
        int head = base + pos + taps;
        double a0 = 0.0, a1 = 0.0, a2 = 0.0, a3 = 0.0, acc;
        hist[base + pos] = x;
        hist[base + pos + taps] = x;
        for (i = 0; i < taps; i += 4) {
            a0 += hrir[hb + i] * hist[head - i];
            a1 += hrir[hb + i + 1] * hist[head - i - 1];
            a2 += hrir[hb + i + 2] * hist[head - i - 2];
            a3 += hrir[hb + i + 3] * hist[head - i - 3];
        }
        acc = (a0 + a1) + (a2 + a3);
        if (b->mirror[c] > 0) p += acc; else q += acc;
    }
    b->histPos = pos + 1 == taps ? 0 : pos + 1;
    out[0] = p + q;
    out[1] = p - q;
}
