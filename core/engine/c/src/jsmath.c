/* The transcendental functions JavaScript engines compute — fdlibm 5.3 as
 * carried by V8's base/ieee754 (with FreeBSD msun's log2/log10/atan2) —
 * so the port gets the same bits as the reference on every platform, whatever
 * its libm. `tests/jsmath_check` verifies each against Node over millions of
 * arguments.
 *
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this software is freely
 * granted, provided that this notice is preserved.
 */

#include <string.h>

#include "taud_internal.h"

#undef js_pow

static inline int32_t hi_word(double x)
{
    uint64_t u;
    memcpy(&u, &x, 8);
    return (int32_t)(uint32_t)(u >> 32);
}

static inline uint32_t lo_word(double x)
{
    uint64_t u;
    memcpy(&u, &x, 8);
    return (uint32_t)u;
}

static inline double from_words(uint32_t hi, uint32_t lo)
{
    uint64_t u = ((uint64_t)hi << 32) | lo;
    double d;
    memcpy(&d, &u, 8);
    return d;
}

static inline double with_lo(double x, uint32_t lo) { return from_words((uint32_t)hi_word(x), lo); }
static inline double with_hi(double x, uint32_t hi) { return from_words(hi, lo_word(x)); }

/* ── trigonometric kernels ── */

static const double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
    S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
    S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;

static double k_sin(double x, double y, int iy)
{
    double z, r, v;
    int32_t ix = hi_word(x) & 0x7fffffff;
    if (ix < 0x3e400000) { if ((int)x == 0) return x; }
    z = x * x;
    v = z * x;
    r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if (iy == 0) return x + v * (S1 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

static const double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
    C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
    C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

static double k_cos(double x, double y)
{
    double a, hz, z, r, qx;
    int32_t ix = hi_word(x) & 0x7fffffff;
    if (ix < 0x3e400000) { if ((int)x == 0) return 1.0; }
    z = x * x;
    r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if (ix < 0x3fd33333) return 1.0 - (0.5 * z - (z * r - x * y));
    if (ix > 0x3fe90000) qx = 0.28125;
    else qx = from_words((uint32_t)(ix - 0x00200000), 0);
    hz = 0.5 * z - qx;
    a = 1.0 - qx;
    return a - (hz - (z * r - x * y));
}

static const double T[] = {
    3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02,
    2.18694882948595424599e-02, 8.86323982359930005737e-03, 3.59207910759131235356e-03,
    1.45620945432529025516e-03, 5.88041240820264096874e-04, 2.46463134818469906812e-04,
    7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
    2.59073051863633712884e-05,
};
#define PIO4 7.85398163397448278999e-01
#define PIO4LO 3.06161699786838301793e-17

static double k_tan(double x, double y, int iy)
{
    double z, r, v, w, s;
    int32_t hx = hi_word(x), ix = hx & 0x7fffffff;
    if (ix < 0x3e300000) {
        if ((int)x == 0) {
            if (((ix | (int32_t)lo_word(x)) | (iy + 1)) == 0) return 1.0 / fabs(x);
            if (iy == 1) return x;
            {
                double a, t;
                z = w = x + y;
                z = with_lo(z, 0);
                v = y - (z - x);
                t = a = -1.0 / w;
                t = with_lo(t, 0);
                s = 1.0 + t * z;
                return t + a * (s + t * v);
            }
        }
    }
    if (ix >= 0x3fe59428) {
        if (hx < 0) { x = -x; y = -y; }
        z = PIO4 - x;
        w = PIO4LO - y;
        x = z + w;
        y = 0.0;
    }
    z = x * x;
    w = z * z;
    r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
    v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
    s = z * x;
    r = y + z * (s * (r + v) + y);
    r += T[0] * s;
    w = x + r;
    if (ix >= 0x3fe59428) {
        v = (double)iy;
        return (double)(1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if (iy == 1) return w;
    {
        double a, t;
        z = with_lo(w, 0);
        v = r - (z - x);
        t = a = -1.0 / w;
        t = with_lo(t, 0);
        s = 1.0 + t * z;
        return t + a * (s + t * v);
    }
}

static const int32_t npio2_hw[] = {
    0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb,
    0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb,
    0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c,
    0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
};

static const double invpio2 = 6.36619772367581382433e-01,
    pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
    pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21,
    pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;

/* Argument reduction for |x| up to 2^19·π/2; returns 0x7fffffff beyond that
 * (the engine never gets near it — the callers fall back to the C library). */
static int32_t rem_pio2(double x, double *y)
{
    double z, w, t, r, fn;
    int32_t i, j, n, ix, hx = hi_word(x);
    ix = hx & 0x7fffffff;
    if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0; }
    if (ix < 0x4002d97c) {
        if (hx > 0) {
            z = x - pio2_1;
            if (ix != 0x3ff921fb) { y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t; }
            else { z -= pio2_2; y[0] = z - pio2_2t; y[1] = (z - y[0]) - pio2_2t; }
            return 1;
        }
        z = x + pio2_1;
        if (ix != 0x3ff921fb) { y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t; }
        else { z += pio2_2; y[0] = z + pio2_2t; y[1] = (z - y[0]) + pio2_2t; }
        return -1;
    }
    if (ix <= 0x413921fb) {
        t = fabs(x);
        n = (int32_t)(t * invpio2 + 0.5);
        fn = (double)n;
        r = t - fn * pio2_1;
        w = fn * pio2_1t;
        if (n < 32 && ix != npio2_hw[n - 1]) {
            y[0] = r - w;
        } else {
            uint32_t high;
            j = ix >> 20;
            y[0] = r - w;
            high = (uint32_t)hi_word(y[0]);
            i = j - (int32_t)((high >> 20) & 0x7ff);
            if (i > 16) {
                t = r;
                w = fn * pio2_2;
                r = t - w;
                w = fn * pio2_2t - ((t - r) - w);
                y[0] = r - w;
                high = (uint32_t)hi_word(y[0]);
                i = j - (int32_t)((high >> 20) & 0x7ff);
                if (i > 49) {
                    t = r;
                    w = fn * pio2_3;
                    r = t - w;
                    w = fn * pio2_3t - ((t - r) - w);
                    y[0] = r - w;
                }
            }
        }
        y[1] = (r - y[0]) - w;
        if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n; }
        return n;
    }
    return 0x7fffffff;
}

double js_sin(double x)
{
    double y[2];
    int32_t n, ix = hi_word(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return k_sin(x, 0.0, 0);
    if (ix >= 0x7ff00000) return x - x;
    n = rem_pio2(x, y);
    if (n == 0x7fffffff) return sin(x);
    switch (n & 3) {
    case 0: return k_sin(y[0], y[1], 1);
    case 1: return k_cos(y[0], y[1]);
    case 2: return -k_sin(y[0], y[1], 1);
    default: return -k_cos(y[0], y[1]);
    }
}

double js_cos(double x)
{
    double y[2];
    int32_t n, ix = hi_word(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return k_cos(x, 0.0);
    if (ix >= 0x7ff00000) return x - x;
    n = rem_pio2(x, y);
    if (n == 0x7fffffff) return cos(x);
    switch (n & 3) {
    case 0: return k_cos(y[0], y[1]);
    case 1: return -k_sin(y[0], y[1], 1);
    case 2: return -k_cos(y[0], y[1]);
    default: return k_sin(y[0], y[1], 1);
    }
}

double js_tan(double x)
{
    double y[2];
    int32_t n, ix = hi_word(x) & 0x7fffffff;
    if (ix <= 0x3fe921fb) return k_tan(x, 0.0, 1);
    if (ix >= 0x7ff00000) return x - x;
    n = rem_pio2(x, y);
    if (n == 0x7fffffff) return tan(x);
    return k_tan(y[0], y[1], 1 - ((n & 1) << 1));
}

/* ── exp ── */

double js_exp(double x)
{
    static const double halF[2] = { 0.5, -0.5 },
        o_threshold = 7.09782712893383973096e+02, u_threshold = -7.45133219101941108420e+02,
        ln2HI[2] = { 6.93147180369123816490e-01, -6.93147180369123816490e-01 },
        ln2LO[2] = { 1.90821492927058770002e-10, -1.90821492927058770002e-10 },
        invln2 = 1.44269504088896338700e+00,
        P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03,
        P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06,
        P5 = 4.13813679705723846039e-08, E = 2.718281828459045,
        twom1000 = 9.33263618503218878990e-302, two1023 = 8.988465674311579539e307;
    double y, hi = 0.0, lo = 0.0, c, t, twopk;
    int32_t k = 0, xsb;
    uint32_t hx = (uint32_t)hi_word(x);
    xsb = (int32_t)((hx >> 31) & 1);
    hx &= 0x7fffffff;
    if (hx >= 0x40862e42) {
        if (hx >= 0x7ff00000) {
            if (((hx & 0xfffff) | lo_word(x)) != 0) return x + x;
            return xsb == 0 ? x : 0.0;
        }
        if (x > o_threshold) return HUGE_VAL;
        if (x < u_threshold) return 0.0;
    }
    if (hx > 0x3fd62e42) {
        if (hx < 0x3ff0a2b2) {
            if (x == 1.0) return E;
            hi = x - ln2HI[xsb];
            lo = ln2LO[xsb];
            k = 1 - xsb - xsb;
        } else {
            k = (int32_t)(invln2 * x + halF[xsb]);
            t = k;
            hi = x - t * ln2HI[0];
            lo = t * ln2LO[0];
        }
        x = hi - lo;
    } else if (hx < 0x3e300000) {
        return 1.0 + x;
    } else {
        k = 0;
    }
    t = x * x;
    if (k >= -1021) twopk = from_words(0x3ff00000u + ((uint32_t)k << 20), 0);
    else twopk = from_words(0x3ff00000u + ((uint32_t)(k + 1000) << 20), 0);
    c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k == 0) return 1.0 - ((x * c) / (c - 2.0) - x);
    y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if (k >= -1021) {
        if (k == 1024) return y * 2.0 * two1023;
        return y * twopk;
    }
    return y * twopk * twom1000;
}

/* ── logarithms ── */

static const double Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01,
    Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01,
    Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01,
    Lg7 = 1.479819860511658591e-01;
static const double two54 = 1.80143985094819840000e+16;

static double ieee_log(double x)
{
    static const double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10;
    double hfsq, f, s, z, R, w, t1, t2, dk;
    int32_t k = 0, hx = hi_word(x), i, j;
    uint32_t lx = lo_word(x);
    if (hx < 0x00100000) {
        if (((hx & 0x7fffffff) | (int32_t)lx) == 0) return -HUGE_VAL;
        if (hx < 0) return NAN;
        k -= 54;
        x *= two54;
        hx = hi_word(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = with_hi(x, (uint32_t)(hx | (i ^ 0x3ff00000)));
    k += (i >> 20);
    f = x - 1.0;
    if ((0x000fffff & (2 + hx)) < 3) {
        if (f == 0.0) {
            if (k == 0) return 0.0;
            dk = (double)k;
            return dk * ln2_hi + dk * ln2_lo;
        }
        R = f * f * (0.5 - 0.33333333333333333 * f);
        if (k == 0) return f - R;
        dk = (double)k;
        return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
    s = f / (2.0 + f);
    dk = (double)k;
    z = s * s;
    i = hx - 0x6147a;
    w = z * z;
    j = 0x6b851 - hx;
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    i |= j;
    R = t2 + t1;
    if (i > 0) {
        hfsq = 0.5 * f * f;
        if (k == 0) return f - (hfsq - s * (hfsq + R));
        return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
    }
    if (k == 0) return f - s * (f - R);
    return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

double js_log(double x) { return ieee_log(x); }

double js_log10(double x)
{
    static const double ivln10 = 4.34294481903251816668e-01,
        log10_2hi = 3.01029995663611771306e-01, log10_2lo = 3.69423907715893078616e-13;
    double y, z;
    int32_t i, k = 0, hx = hi_word(x);
    uint32_t lx = lo_word(x);
    if (hx < 0x00100000) {
        if (((hx & 0x7fffffff) | (int32_t)lx) == 0) return -HUGE_VAL;
        if (hx < 0) return NAN;
        k -= 54;
        x *= two54;
        hx = hi_word(x);
        lx = lo_word(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    if (hx == 0x3ff00000 && lx == 0) return 0.0;
    k += (hx >> 20) - 1023;
    i = (int32_t)(((uint32_t)k & 0x80000000u) >> 31);
    hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
    y = k + i;
    x = from_words((uint32_t)hx, lx);
    z = y * log10_2lo + ivln10 * ieee_log(x);
    return z + y * log10_2hi;
}

static double k_log1p(double f)
{
    double hfsq, s, z, R, w, t1, t2;
    s = f / (2.0 + f);
    z = s * s;
    w = z * z;
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    R = t2 + t1;
    hfsq = 0.5 * f * f;
    return s * (hfsq + R);
}

double js_log2(double x)
{
    static const double ivln2hi = 1.44269504072144627571e+00, ivln2lo = 1.67517131648865118353e-10;
    double f, hfsq, hi, lo, r, val_hi, val_lo, w, y;
    int32_t i, k = 0, hx = hi_word(x);
    uint32_t lx = lo_word(x);
    if (hx < 0x00100000) {
        if (((hx & 0x7fffffff) | (int32_t)lx) == 0) return -HUGE_VAL;
        if (hx < 0) return NAN;
        k -= 54;
        x *= two54;
        hx = hi_word(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    if (hx == 0x3ff00000 && lx == 0) return 0.0;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = with_hi(x, (uint32_t)(hx | (i ^ 0x3ff00000)));
    k += (i >> 20);
    y = (double)k;
    f = x - 1.0;
    hfsq = 0.5 * f * f;
    r = k_log1p(f);
    hi = f - hfsq;
    hi = with_lo(hi, 0);
    lo = (f - hi) - hfsq + r;
    val_hi = hi * ivln2hi;
    val_lo = (lo + hi) * ivln2lo + lo * ivln2hi;
    w = y + val_hi;
    val_lo += (y - w) + val_hi;
    val_hi = w;
    return val_lo + val_hi;
}

/* ── inverse trigonometry ── */

static const double pio2_hi = 1.57079632679489655800e+00, pio2_lo = 6.12323399573676603587e-17,
    pio4_hi = 7.85398163397448278999e-01,
    pS0 = 1.66666666666666657415e-01, pS1 = -3.25565818622400915405e-01,
    pS2 = 2.01212532134862925881e-01, pS3 = -4.00555345006794114027e-02,
    pS4 = 7.91534994289814532176e-04, pS5 = 3.47933107596021167570e-05,
    qS1 = -2.40339491173441421878e+00, qS2 = 2.02094576023350569471e+00,
    qS3 = -6.88283971605453293030e-01, qS4 = 7.70381505559019352791e-02;

double js_acos(double x)
{
    static const double pi = 3.14159265358979311600e+00;
    double z, p, q, r, w, s, c, df;
    int32_t hx = hi_word(x), ix = hx & 0x7fffffff;
    if (ix >= 0x3ff00000) {
        if (((ix - 0x3ff00000) | (int32_t)lo_word(x)) == 0) {
            if (hx > 0) return 0.0;
            return pi + 2.0 * pio2_lo;
        }
        return NAN;
    }
    if (ix < 0x3fe00000) {
        if (ix <= 0x3c600000) return pio2_hi + pio2_lo;
        z = x * x;
        p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
        q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
        r = p / q;
        return pio2_hi - (x - (pio2_lo - x * r));
    } else if (hx < 0) {
        z = (1.0 + x) * 0.5;
        p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
        q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
        s = sqrt(z);
        r = p / q;
        w = r * s - pio2_lo;
        return pi - 2.0 * (s + w);
    }
    z = (1.0 - x) * 0.5;
    s = sqrt(z);
    df = with_lo(s, 0);
    c = (z - df * df) / (s + df);
    p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
    q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
    r = p / q;
    w = r * s + c;
    return 2.0 * (df + w);
}

double js_asin(double x)
{
    double t = 0.0, w, p, q, c, r, s;
    int32_t hx = hi_word(x), ix = hx & 0x7fffffff;
    if (ix >= 0x3ff00000) {
        if (((ix - 0x3ff00000) | (int32_t)lo_word(x)) == 0) return x * pio2_hi + x * pio2_lo;
        return NAN;
    } else if (ix < 0x3fe00000) {
        if (ix < 0x3e400000) return x;
        t = x * x;
        p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
        q = 1.0 + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
        w = p / q;
        return x + x * w;
    }
    w = 1.0 - fabs(x);
    t = w * 0.5;
    p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
    q = 1.0 + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
    s = sqrt(t);
    if (ix >= 0x3fef3333) {
        w = p / q;
        t = pio2_hi - (2.0 * (s + s * w) - pio2_lo);
    } else {
        w = with_lo(s, 0);
        c = (t - w * w) / (s + w);
        r = p / q;
        p = 2.0 * s * r - (pio2_lo - 2.0 * c);
        q = pio4_hi - 2.0 * w;
        t = pio4_hi - (p - q);
    }
    return hx > 0 ? t : -t;
}

static const double atanhi[] = {
    4.63647609000806093515e-01, 7.85398163397448278999e-01,
    9.82793723247329054082e-01, 1.57079632679489655800e+00,
};
static const double atanlo[] = {
    2.26987774529616870924e-17, 3.06161699786838301793e-17,
    1.39033110312309984516e-17, 6.12323399573676603587e-17,
};
static const double aT[] = {
    3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
    -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
    6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
    -3.65315727442169155270e-02, 1.62858201153657823623e-02,
};

static double js_atan(double x)
{
    double w, s1, s2, z;
    int32_t ix, hx = hi_word(x), id;
    ix = hx & 0x7fffffff;
    if (ix >= 0x44100000) {
        if (ix > 0x7ff00000 || (ix == 0x7ff00000 && lo_word(x) != 0)) return x + x;
        return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3];
    }
    if (ix < 0x3fdc0000) {
        if (ix < 0x3e200000) return x;
        id = -1;
    } else {
        x = fabs(x);
        if (ix < 0x3ff30000) {
            if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
            else { id = 1; x = (x - 1.0) / (x + 1.0); }
        } else {
            if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); }
            else { id = 3; x = -1.0 / x; }
        }
    }
    z = x * x;
    w = z * z;
    s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
    s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
    if (id < 0) return x - x * (s1 + s2);
    z = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x);
    return hx < 0 ? -z : z;
}

double js_atan2(double y, double x)
{
    static const double pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00,
        pi = 3.1415926535897931160e+00, pi_lo = 1.2246467991473531772e-16;
    double z;
    int32_t k, m, hx, hy, ix, iy;
    uint32_t lx, ly;
    hx = hi_word(x); ix = hx & 0x7fffffff; lx = lo_word(x);
    hy = hi_word(y); iy = hy & 0x7fffffff; ly = lo_word(y);
    if (isnan(x) || isnan(y)) return x + y;
    if (hx == 0x3ff00000 && lx == 0) return js_atan(y);
    m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if ((iy | (int32_t)ly) == 0) {
        switch (m) {
        case 0: case 1: return y;
        case 2: return pi;
        default: return -pi;
        }
    }
    if ((ix | (int32_t)lx) == 0) return hy < 0 ? -pi_o_2 : pi_o_2;
    if (ix == 0x7ff00000) {
        if (iy == 0x7ff00000) {
            switch (m) {
            case 0: return pi_o_4;
            case 1: return -pi_o_4;
            case 2: return 3.0 * pi_o_4;
            default: return -3.0 * pi_o_4;
            }
        }
        switch (m) {
        case 0: return 0.0;
        case 1: return -0.0;
        case 2: return pi;
        default: return -pi;
        }
    }
    if (iy == 0x7ff00000) return hy < 0 ? -pi_o_2 : pi_o_2;
    k = (iy - ix) >> 20;
    if (k > 60) { z = pi_o_2 + 0.5 * pi_lo; m &= 1; }
    else if (hx < 0 && k < -60) z = 0.0;
    else z = js_atan(fabs(y / x));
    switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return pi - (z - pi_lo);
    default: return (z - pi_lo) - pi;
    }
}

/* ── pow ── */

double js_fdlibm_pow(double x, double y)
{
    static const double bp[] = { 1.0, 1.5 },
        dp_h[] = { 0.0, 5.84962487220764160156e-01 }, dp_l[] = { 0.0, 1.35003920212974897128e-08 },
        two53 = 9007199254740992.0,
        L1 = 5.99999999999994648725e-01, L2 = 4.28571428578550184252e-01,
        L3 = 3.33333329818377432918e-01, L4 = 2.72728123808534006489e-01,
        L5 = 2.30660745775561754067e-01, L6 = 2.06975017800338417784e-01,
        P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03,
        P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06,
        P5 = 4.13813679705723846039e-08,
        lg2 = 6.93147180559945286227e-01, lg2_h = 6.93147182464599609375e-01,
        lg2_l = -1.90465429995776804525e-09, ovt = 8.0085662595372944372e-17,
        cp = 9.61796693925975554329e-01, cp_h = 9.61796700954437255859e-01,
        cp_l = -7.02846165095275826516e-09, ivln2 = 1.44269504088896338700e+00,
        ivln2_h = 1.44269502162933349609e+00, ivln2_l = 1.92596299112661746887e-08;
    double z, ax, z_h, z_l, p_h, p_l, y1, t1, t2, r, s, t, u, v, w;
    int32_t i, j, k, yisint, n, hx, hy, ix, iy;
    uint32_t lx, ly;

    hx = hi_word(x); lx = lo_word(x);
    hy = hi_word(y); ly = lo_word(y);
    ix = hx & 0x7fffffff; iy = hy & 0x7fffffff;

    if ((iy | (int32_t)ly) == 0) return 1.0;
    if (isnan(x) || isnan(y)) return x + y;

    yisint = 0;
    if (hx < 0) {
        if (iy >= 0x43400000) yisint = 2;
        else if (iy >= 0x3ff00000) {
            k = (iy >> 20) - 0x3ff;
            if (k > 20) {
                uint32_t jj = ly >> (52 - k);
                if ((jj << (52 - k)) == ly) yisint = 2 - (int32_t)(jj & 1);
            } else if (ly == 0) {
                j = iy >> (20 - k);
                if ((j << (20 - k)) == iy) yisint = 2 - (j & 1);
            }
        }
    }

    if (ly == 0) {
        if (iy == 0x7ff00000) {
            if (((ix - 0x3ff00000) | (int32_t)lx) == 0) return NAN;
            if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
            return hy < 0 ? -y : 0.0;
        }
        if (iy == 0x3ff00000) return hy < 0 ? 1.0 / x : x;
        if (hy == 0x40000000) return x * x;
        if (hy == 0x3fe00000 && hx >= 0) return sqrt(x);
    }

    ax = fabs(x);
    if (lx == 0) {
        if (ix == 0x7ff00000 || ix == 0 || ix == 0x3ff00000) {
            z = ax;
            if (hy < 0) z = 1.0 / z;
            if (hx < 0) {
                if (((ix - 0x3ff00000) | yisint) == 0) z = NAN;
                else if (yisint == 1) z = -z;
            }
            return z;
        }
    }

    n = (int32_t)(((uint32_t)hx >> 31)) ? 0 : 1;
    if ((n | yisint) == 0) return NAN;

    s = 1.0;
    if ((n | (yisint - 1)) == 0) s = -1.0;

    if (iy > 0x41e00000) {
        if (iy > 0x43f00000) {
            if (ix <= 0x3fefffff) return hy < 0 ? HUGE_VAL : 0.0;
            if (ix >= 0x3ff00000) return hy > 0 ? HUGE_VAL : 0.0;
        }
        if (ix < 0x3fefffff) return hy < 0 ? s * HUGE_VAL : s * 0.0;
        if (ix > 0x3ff00000) return hy > 0 ? s * HUGE_VAL : s * 0.0;
        t = ax - 1.0;
        w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        u = ivln2_h * t;
        v = t * ivln2_l - w * ivln2;
        t1 = u + v;
        t1 = with_lo(t1, 0);
        t2 = v - (t1 - u);
    } else {
        double ss, s2, s_h, s_l, t_h, t_l;
        n = 0;
        if (ix < 0x00100000) { ax *= two53; n -= 53; ix = hi_word(ax); }
        n += ((ix) >> 20) - 0x3ff;
        j = ix & 0x000fffff;
        ix = j | 0x3ff00000;
        if (j <= 0x3988e) k = 0;
        else if (j < 0xbb67a) k = 1;
        else { k = 0; n += 1; ix -= 0x00100000; }
        ax = with_hi(ax, (uint32_t)ix);

        u = ax - bp[k];
        v = 1.0 / (ax + bp[k]);
        ss = u * v;
        s_h = with_lo(ss, 0);
        t_h = from_words((uint32_t)(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18)), 0);
        t_l = ax - (t_h - bp[k]);
        s_l = v * ((u - s_h * t_h) - s_h * t_l);
        s2 = ss * ss;
        r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        t_h = 3.0 + s2 + r;
        t_h = with_lo(t_h, 0);
        t_l = r - ((t_h - 3.0) - s2);
        u = s_h * t_h;
        v = s_l * t_h + t_l * ss;
        p_h = u + v;
        p_h = with_lo(p_h, 0);
        p_l = v - (p_h - u);
        z_h = cp_h * p_h;
        z_l = cp_l * p_h + p_l * cp + dp_l[k];
        t = (double)n;
        t1 = (((z_h + z_l) + dp_h[k]) + t);
        t1 = with_lo(t1, 0);
        t2 = z_l - (((t1 - t) - dp_h[k]) - z_h);
    }

    y1 = with_lo(y, 0);
    p_l = (y - y1) * t1 + y * t2;
    p_h = y1 * t1;
    z = p_l + p_h;
    j = hi_word(z);
    i = (int32_t)lo_word(z);
    if (j >= 0x40900000) {
        if (((j - 0x40900000) | i) != 0) return s * HUGE_VAL;
        if (p_l + ovt > z - p_h) return s * HUGE_VAL;
    } else if ((j & 0x7fffffff) >= 0x4090cc00) {
        if ((((uint32_t)j - 0xc090cc00u) | (uint32_t)i) != 0) return s * 0.0;
        if (p_l <= z - p_h) return s * 0.0;
    }
    i = j & 0x7fffffff;
    k = (i >> 20) - 0x3ff;
    n = 0;
    if (i > 0x3fe00000) {
        n = j + (0x00100000 >> (k + 1));
        k = ((n & 0x7fffffff) >> 20) - 0x3ff;
        t = from_words((uint32_t)(n & ~(0x000fffff >> k)), 0);
        n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
        if (j < 0) n = -n;
        p_h -= t;
    }
    t = p_l + p_h;
    t = with_lo(t, 0);
    u = t * lg2_h;
    v = (p_l - (t - p_h)) * lg2 + t * lg2_l;
    z = u + v;
    w = v - (z - u);
    t = z * z;
    t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    /* V8's grouping, not fdlibm's (z*t1)/(t1-2) - (w+z*w): base/ieee754.cc
     * divides by the whole bracket, and Math.pow is what it computes. */
    r = (z * t1) / ((t1 - 2.0) - (w + z * w));
    z = 1.0 - (r - z);
    j = hi_word(z);
    j += (int32_t)((uint32_t)n << 20);
    if ((j >> 20) <= 0) z = ldexp(z, n);
    else z = with_hi(z, (uint32_t)j);
    return s * z;
}

/* ── log1p, expm1, tanh (V8 14.6 base/ieee754.cc, fdlibm's s_log1p.c,
 *    s_expm1.c and s_tanh.c; tsvm reference_materials/v8-ieee754/) ── */

double js_log1p(double x)
{
    static const double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10,
        Lp1 = 6.666666666666735130e-01, Lp2 = 3.999999999940941908e-01,
        Lp3 = 2.857142874366239149e-01, Lp4 = 2.222219843214978396e-01,
        Lp5 = 1.818357216161805012e-01, Lp6 = 1.531383769920937332e-01,
        Lp7 = 1.479819860511658591e-01;
    double hfsq, f = 0.0, c = 0.0, s, z, R, u;
    int32_t k, hx = hi_word(x), hu = 0, ax = hx & 0x7fffffff;
    k = 1;
    if (hx < 0x3fda827a) {                  /* 1+x < sqrt(2)+ */
        if (ax >= 0x3ff00000) {             /* x <= -1.0 */
            if (x == -1.0) return -HUGE_VAL;
            return NAN;
        }
        if (ax < 0x3e200000) {              /* |x| < 2**-29 */
            if (two54 + x > 0.0 && ax < 0x3c900000) return x;
            return x - x * x * 0.5;
        }
        if (hx > 0 || hx <= (int32_t)0xbfd2bec4) { k = 0; f = x; hu = 1; }
    }
    if (hx >= 0x7ff00000) return x + x;
    if (k != 0) {
        if (hx < 0x43400000) {
            u = 1.0 + x;
            hu = hi_word(u);
            k = (hu >> 20) - 1023;
            c = k > 0 ? 1.0 - (u - x) : x - (u - 1.0);
            c /= u;
        } else {
            u = x;
            hu = hi_word(u);
            k = (hu >> 20) - 1023;
            c = 0;
        }
        hu &= 0x000fffff;
        if (hu < 0x6a09e) {
            u = with_hi(u, (uint32_t)(hu | 0x3ff00000));
        } else {
            k += 1;
            u = with_hi(u, (uint32_t)(hu | 0x3fe00000));
            hu = (0x00100000 - hu) >> 2;
        }
        f = u - 1.0;
    }
    hfsq = 0.5 * f * f;
    if (hu == 0) {                          /* |f| < 2**-20 */
        if (f == 0.0) {
            if (k == 0) return 0.0;
            c += k * ln2_lo;
            return k * ln2_hi + c;
        }
        R = hfsq * (1.0 - 0.66666666666666666 * f);
        if (k == 0) return f - R;
        return k * ln2_hi - ((R - (k * ln2_lo + c)) - f);
    }
    s = f / (2.0 + f);
    z = s * s;
    R = z * (Lp1 + z * (Lp2 + z * (Lp3 + z * (Lp4 + z * (Lp5 + z * (Lp6 + z * Lp7))))));
    if (k == 0) return f - (hfsq - s * (hfsq + R));
    return k * ln2_hi - ((hfsq - (s * (hfsq + R) + (k * ln2_lo + c))) - f);
}

double js_expm1(double x)
{
    static const double tiny = 1.0e-300, huge = 1.0e+300,
        o_threshold = 7.09782712893383973096e+02,
        ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10,
        invln2 = 1.44269504088896338700e+00,
        Q1 = -3.33333333333331316428e-02, Q2 = 1.58730158725481460165e-03,
        Q3 = -7.93650757867487942473e-05, Q4 = 4.00821782732936239552e-06,
        Q5 = -2.01099218183624371326e-07;
    double y, hi, lo, c = 0.0, t, e, hxs, hfx, r1, twopk;
    int32_t k, xsb;
    uint32_t hx = (uint32_t)hi_word(x);
    xsb = (int32_t)(hx & 0x80000000u);
    hx &= 0x7fffffff;
    if (hx >= 0x4043687a) {                 /* |x| >= 56*ln2 */
        if (hx >= 0x40862e42) {             /* |x| >= 709.78... */
            if (hx >= 0x7ff00000) {
                if (((hx & 0xfffff) | lo_word(x)) != 0) return x + x;
                return xsb == 0 ? x : -1.0;
            }
            if (x > o_threshold) return HUGE_VAL;
        }
        if (xsb != 0) {
            if (x + tiny < 0.0) return tiny - 1.0;
        }
    }
    if (hx > 0x3fd62e42) {                  /* |x| > 0.5 ln2 */
        if (hx < 0x3ff0a2b2) {              /* and |x| < 1.5 ln2 */
            if (xsb == 0) { hi = x - ln2_hi; lo = ln2_lo; k = 1; }
            else { hi = x + ln2_hi; lo = -ln2_lo; k = -1; }
        } else {
            k = (int32_t)(invln2 * x + (xsb == 0 ? 0.5 : -0.5));
            t = k;
            hi = x - t * ln2_hi;
            lo = t * ln2_lo;
        }
        x = hi - lo;
        c = (hi - x) - lo;
    } else if (hx < 0x3c900000) {           /* |x| < 2**-54: x */
        t = huge + x;
        return x - (t - (huge + x));
    } else {
        k = 0;
    }
    hfx = 0.5 * x;
    hxs = x * hfx;
    r1 = 1.0 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
    t = 3.0 - r1 * hfx;
    e = hxs * ((r1 - t) / (6.0 - x * t));
    if (k == 0) return x - (x * e - hxs);
    twopk = from_words(0x3ff00000u + ((uint32_t)k << 20), 0);
    e = (x * (e - c) - c);
    e -= hxs;
    if (k == -1) return 0.5 * (x - e) - 0.5;
    if (k == 1) {
        if (x < -0.25) return -2.0 * (e - (x + 0.5));
        return 1.0 + 2.0 * (x - e);
    }
    if (k <= -2 || k > 56) {
        y = 1.0 - (e - x);
        if (k == 1024) y = y * 2.0 * 8.98846567431158e+307;
        else y = y * twopk;
        return y - 1.0;
    }
    t = 1.0;
    if (k < 20) {
        t = with_hi(t, (uint32_t)(0x3ff00000 - (0x200000 >> k)));    /* 1 - 2^-k */
        y = t - (e - x);
        y = y * twopk;
    } else {
        t = with_hi(t, (uint32_t)((0x3ff - k) << 20));               /* 2^-k */
        y = x - (e + t);
        y += 1.0;
        y = y * twopk;
    }
    return y;
}

double js_tanh(double x)
{
    static const double tiny = 1.0e-300, huge = 1.0e300;
    double t, z;
    int32_t jx = hi_word(x), ix = jx & 0x7fffffff;
    if (ix >= 0x7ff00000) {                 /* INF or NaN */
        if (jx >= 0) return 1.0 / x + 1.0;
        return 1.0 / x - 1.0;
    }
    if (ix < 0x40360000) {                  /* |x| < 22 */
        if (ix < 0x3e300000) {              /* |x| < 2**-28 */
            if (huge + x > 1.0) return x;
        }
        if (ix >= 0x3ff00000) {             /* |x| >= 1 */
            t = js_expm1(2.0 * fabs(x));
            z = 1.0 - 2.0 / (t + 2.0);
        } else {
            t = js_expm1(-2.0 * fabs(x));
            z = -t / (t + 2.0);
        }
    } else {
        z = 1.0 - tiny;
    }
    return jx >= 0 ? z : -z;
}
