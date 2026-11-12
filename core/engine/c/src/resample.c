/* Kaiser-windowed-sinc resampling — port of resampler.js's
 * resampleInterleaved (β = 8, 512 phases, 8…24 half-taps, cutoff following the
 * ratio, each phase row DC-normalised, adjacent rows blended). */

#include <stdlib.h>

#include "taud_internal.h"

#define RESAMP_BETA 8.0
#define RESAMP_PHASES 512

static double besselI0(double x)
{
    double s = 1.0, t = 1.0;
    int k = 1;
    for (;;) {
        t *= (x * x) / (4.0 * k * k);
        s += t;
        if (t < 1e-12 * s) return s;
        k++;
    }
}

static int half_width(double ratio)
{
    int h = (int)js_round(12.0 / dmin(1.0, ratio));
    return imax(8, imin(24, h));
}

float *te_resample_interleaved(const float *in, size_t frames, int channels, int srcRate, int dstRate, size_t *outFrames)
{
    double ratio = (double)dstRate / srcRate;
    int hw = half_width(ratio), nTaps = 2 * hw, history = hw - 1;
    double cutoff = 0.5 * dmin(1.0, ratio);
    double invI0 = 1.0 / besselI0(RESAMP_BETA);
    double step = (double)srcRate / dstRate;
    size_t dstFrames = (size_t)floor((double)frames * dstRate / srcRate), n;
    double *rows = (double *)malloc(sizeof(double) * (RESAMP_PHASES + 1) * nTaps);
    double *acc = (double *)malloc(sizeof(double) * channels);
    float *out = (float *)malloc(sizeof(float) * (dstFrames * channels + 1));
    int64_t last = (int64_t)frames - 1;
    int p, k, c;

    if (rows == NULL || acc == NULL || out == NULL) { free(rows); free(acc); free(out); return NULL; }
    for (p = 0; p <= RESAMP_PHASES; p++) {
        double frac = (double)p / RESAMP_PHASES, s = 0.0, inv;
        double *row = rows + (size_t)p * nTaps;
        for (k = 0; k < nTaps; k++) {
            double x = (k - (hw - 1)) - frac;
            double a = 2.0 * cutoff * x;
            double sinc = a == 0.0 ? 1.0 : js_sin(3.141592653589793 * a) / (3.141592653589793 * a);
            double r = x / hw;
            double win = besselI0(RESAMP_BETA * sqrt(dmax(0.0, 1.0 - r * r))) * invI0;
            row[k] = sinc * win;
            s += row[k];
        }
        inv = s != 0 ? 1.0 / s : 1.0;
        for (k = 0; k < nTaps; k++) row[k] *= inv;
    }

    for (n = 0; n < dstFrames; n++) {
        double pos = n * step;
        double i0 = floor(pos);
        double fp = (pos - i0) * RESAMP_PHASES;
        int ph = (int)fp;
        double g = fp - ph;
        const double *row = rows + (size_t)ph * nTaps;
        const double *nxt = rows + (size_t)(ph + 1) * nTaps;
        int64_t base = (int64_t)i0 - history;
        int t;
        for (c = 0; c < channels; c++) acc[c] = 0.0;
        for (t = 0; t < nTaps; t++) {
            int64_t idx = base + t;
            double w = row[t] + (nxt[t] - row[t]) * g;
            size_t o;
            if (idx < 0) idx = 0;
            else if (idx > last) idx = last;
            o = (size_t)idx * channels;
            for (c = 0; c < channels; c++) acc[c] += in[o + c] * w;
        }
        for (c = 0; c < channels; c++) out[n * channels + c] = (float)acc[c];
    }
    free(rows);
    free(acc);
    *outFrames = dstFrames;
    return out;
}
