/* Metainstrument type 1 — the FORMANT INSTRUMENT (item 212) — port of formant.js.
 *
 * An ordinary instrument record whose sample is a glottal source, played
 * through Klatt's cascade/parallel formant synthesiser (Klatt 1980), and whose
 * second pitch/filter slot holds what the tract says: a vowel on Catford's
 * cardinal-vowel chart, an onset cluster and a coda (one CCVC syllable, with an
 * optional glide), and how the formants follow pitch. formant.js carries the
 * phonetics; this file keeps its arithmetic, expression for expression.
 *
 * Every transcendental is the JS's own (jsmath.c): exp, log, log2, log10, cos,
 * sin, pow; sqrt is correctly rounded on both sides. */

#include <string.h>

#include "taud_internal.h"

#define PI 3.141592653589793

#define FB_SOURCE 0
#define FB_FRONT 3
#define FB_OPEN 4
#define FB_ROUND 5
#define FB_TRACK 6
#define FB_REF 7
#define FB_GLIDE 9
#define FB_TIMING 10
#define FB_RANGE_LO 11
#define FB_RANGE_HI 14
#define FB_SLOTS 17
#define FB_GR 53
#define FORMANT_SLOT_BYTES 12

/* The reference note a record with NO vowel sizes its consonants by: C3. */
#define FORMANT_DEFAULT_REF 0x4000

/* The onset's secondary articulation (FB_GR bits 3–4) and the coda's own
 * articulation (bits 5–6), which shares the two in the middle. */
#define ART_NONE 0
#define ART_PALATAL 1
#define ART_DARK 2
#define ART_GLOTTAL 3
#define CODA_RELEASED 0
#define CODA_UNRELEASED 1
#define CODA_DARK 2
#define CODA_GLOTTAL 3

/* A glottalised consonant: the glottis shut this long past the consonant's
 * release (or at a sonorant's start), the voicing then in this fast; a
 * stop's voicing lags its burst by no more than GLOT_LAG; in a coda the
 * voicing stops in GLOT_STOP. */
#define GLOT_CATCH 10
#define GLOT_RISE 2
#define GLOT_LAG 10
#define GLOT_STOP 3
/* What a hissing nucleus takes to let its hiss go before the coda. */
#define NUCLEUS_RELEASE 10

static int fu16(const uint8_t *b, int o) { return b[o] | (b[o + 1] << 8); }
static uint32_t fu24(const uint8_t *b, int o) { return (uint32_t)b[o] | ((uint32_t)b[o + 1] << 8) | ((uint32_t)b[o + 2] << 16); }

/* The glide, the articulations and R (the block's +53, a lyric syllable's
 * +4) into `patch`; a glide code 5…7 is RESERVED and sounds as none. */
static void decode_gr(TaudFormantPatch *patch, int gr)
{
    patch->semivowel = (gr & 7) <= 4 ? gr & 7 : 0;
    patch->secondary = (gr >> 3) & 3;
    patch->codaArt = (gr >> 5) & 3;
    patch->rhotic = (gr & 0x80) != 0;
}

void te_decode_formant_block(const uint8_t *raw, TaudFormantPatch *patch)
{
    int i;
    patch->srcPtr = fu24(raw, FB_SOURCE);
    patch->front = raw[FB_FRONT];
    patch->open = raw[FB_OPEN];
    patch->round = raw[FB_ROUND];
    patch->track = raw[FB_TRACK];
    patch->refNote = fu16(raw, FB_REF) & 0x7fff;
    patch->nasal = (fu16(raw, FB_REF) & 0x8000) != 0;
    patch->glide = raw[FB_GLIDE];
    patch->timing = raw[FB_TIMING];
    patch->rangeLo = fu24(raw, FB_RANGE_LO);
    patch->rangeHi = fu24(raw, FB_RANGE_HI);
    decode_gr(patch, raw[FB_GR]);
    for (i = 0; i < FORMANT_SLOTS; i++) {
        const uint8_t *o = raw + FB_SLOTS + i * FORMANT_SLOT_BYTES;
        TaudFormantSlot *s = &patch->slots[i];
        int t = o[10];
        s->cons = o[0];
        s->ptr = fu24(o, 1);
        s->len = fu16(o, 4);
        s->offset = fu16(o, 6);
        s->rate = fu16(o, 8);
        s->tilt = t >= 0x80 ? t - 0x100 : t;
        s->gain = o[11];
    }
}

/* ── the vowel ── */

static const int CARDINAL_VOWELS[4][4][2] = {
    { { 240, 2400 }, { 235, 2100 }, { 300, 1390 }, { 250, 595 } },
    { { 390, 2300 }, { 370, 1900 }, { 460, 1310 }, { 360, 640 } },
    { { 610, 1900 }, { 585, 1710 }, { 600, 1170 }, { 500, 700 } },
    { { 850, 1610 }, { 820, 1530 }, { 750, 940 }, { 700, 760 } },
};

static void vowel_f1f2(const TaudFormantTables *T, double front, double open, double round, double out[2])
{
    double x = dmin(dmax(front / 255, 0), 1);
    double r = dmin(dmax(round / 255, 0), 1);
    double h = dmin(dmax(open / 255, 0), 1) * 3;
    int i = (int)dmin(2, floor(h)), n;
    double u = h - i;
    double w0 = x * (1 - r), w1 = x * r, w2 = (1 - x) * (1 - r), w3 = (1 - x) * r;
    for (n = 0; n < 2; n++) {
        const double (*lo)[2] = T->logCard[i], (*hi)[2] = T->logCard[i + 1];
        double a0 = lo[0][n] + (hi[0][n] - lo[0][n]) * u;
        double a1 = lo[1][n] + (hi[1][n] - lo[1][n]) * u;
        double a2 = lo[2][n] + (hi[2][n] - lo[2][n]) * u;
        double a3 = lo[3][n] + (hi[3][n] - lo[3][n]) * u;
        out[n] = js_exp(w0 * a0 + w1 * a1 + w2 * a2 + w3 * a3);
    }
}

static double vowel_f1_at(const TaudEngine *e, double front, double open, double round)
{
    double f[2];
    vowel_f1f2(&e->formantTables, front, open, round, f);
    return f[0];
}

#define RHOTIC_F3 1711
#define RHOTIC_F2 1379
#define RHOTIC_F4 3335

static void vowel_formants(const TaudFormantTables *T, double front, double open, double round, double *F, bool rhotic)
{
    double f12[2], f1, f2, f3u, f3r, f3, f4, f5;
    vowel_f1f2(T, front, open, round, f12);
    f1 = f12[0];
    f2 = f12[1];
    f3u = dmax(2500, f2 + 700);
    f3r = dmax(2200, f2 + 250);
    f3 = f3u * js_pow(f3r / f3u, dmin(dmax(round, 0), 255) / 255);
    if (rhotic) {
        f3 = dmin(f3, RHOTIC_F3);
        f2 = dmin(f2, (f3 * RHOTIC_F2) / RHOTIC_F3);
    }
    f4 = dmax(3500, f3 + 400);
    if (rhotic) f4 = dmin(f4, RHOTIC_F4);
    f5 = dmax(4500, f4 + 500);
    F[0] = f1; F[1] = f2; F[2] = f3; F[3] = f4; F[4] = f5;
}

/* A syllable without a vowel (reference note 0) is a syllabic consonant. */
static bool has_vowel(const TaudFormantPatch *patch) { return patch->refNote != 0; }
static double ref_note(const TaudFormantPatch *patch)
{
    return patch->refNote != 0 ? patch->refNote + patch->dRefNote : FORMANT_DEFAULT_REF;
}

static double note_hz(int note)
{
    return LINEAR_FREQ_C4_HZ * js_pow(2, (note - MIDDLE_C) / 4096.0);
}

static double vowel_at_pitch(const TaudEngine *e, double front, double open, double round, double f0,
                             double refHz, int track, double *F, double *B, bool rhotic)
{
    double s = f0 > 0 && refHz > 0 ? js_pow(f0 / refHz, track / 256.0) : 1.0;
    double o = open, ceil;
    bool tuned = f0 > vowel_f1_at(e, front, open, round) * s;
    int n;
    if (tuned) {
        double want = f0 / s;
        if (vowel_f1_at(e, front, 255, round) <= want) {
            o = 255;
        } else {
            double a = open, b = 255;
            int i;
            for (i = 0; i < 24; i++) {
                double m = (a + b) / 2;
                if (vowel_f1_at(e, front, m, round) < want) a = m; else b = m;
            }
            o = (a + b) / 2;
        }
    }
    vowel_formants(&e->formantTables, front, o, round, F, rhotic);
    for (n = 0; n < 5; n++) F[n] *= s;
    if (tuned) F[0] = f0;
    ceil = 0.45 * e->rate;
    for (n = 1; n < 5; n++) if (F[n] < F[n - 1] * 1.15) F[n] = F[n - 1] * 1.15;
    for (n = 0; n < 5; n++) {
        if (F[n] > ceil) F[n] = ceil;
        B[n] = dmax(F[n] / 10, 50);
    }
    return s;
}

/* ── the consonants ── */

#define MANNER_STOP 1
#define MANNER_AFFRICATE 2
#define MANNER_FRICATIVE 3
#define MANNER_ASPIRATE 4
#define MANNER_NASAL 5
#define MANNER_APPROX 6
#define MANNER_TAP 7
#define MANNER_TRILL 8
#define MANNER_GLOTTAL 9

/* `dorsal`: the place follows the vowel (a velar); `bankBack`, when present,
 * the bank before a back vowel; `breath`: the row's frication is BREATH — its
 * noise goes through the cascade, as an aspirate's does ([ʔ͡h]). */
typedef struct TaudConsonant {
    int id, manner;
    bool voiced;
    double F[3], B[3], bank[6];
    double lvl, dur, burst, vot, trans, av, fnz;
    bool dorsal, hasBankBack;
    double bankBack[6];
    bool breath;
} TaudConsonant;

/* Generated from formant.js's ROWS: id, manner, voiced, F, B, bank (A2…A6,
 * AB), lvl, dur, burst, vot, trans, av, fnz, dorsal, bankBack, breath. The velar
 * stops' front bank is K_K_FRONT, their back one K_K_BACK. */
static const TaudConsonant ROWS[] = {
    { 1, 1, 0, { 400, 1100, 2150 }, { 300, 150, 220 }, { 0, 0, 0, 0, 0, 63 }, -12, 0, 5, 12, 40, 0, 0, 0, 0, { 0 }, 0 }, /* p */
    { 2, 1, 1, { 200, 1100, 2150 }, { 60, 110, 130 }, { 0, 0, 0, 0, 0, 63 }, -14, 0, 5, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* b */
    { 3, 1, 0, { 400, 1600, 2600 }, { 300, 120, 250 }, { 0, 30, 45, 57, 63, 0 }, -10, 0, 10, 18, 45, 0, 0, 0, 0, { 0 }, 0 }, /* t */
    { 4, 1, 1, { 200, 1600, 2600 }, { 60, 100, 170 }, { 0, 47, 60, 62, 60, 0 }, -12, 0, 8, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* d */
    { 5, 1, 0, { 400, 1500, 1900 }, { 300, 120, 250 }, { 0, 50, 55, 50, 45, 0 }, -10, 0, 10, 18, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ʈ */
    { 6, 1, 1, { 200, 1500, 1900 }, { 60, 100, 170 }, { 0, 50, 55, 50, 45, 0 }, -12, 0, 8, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ɖ */
    { 7, 1, 0, { 300, 2100, 2900 }, { 250, 160, 330 }, { 0, 45, 55, 50, 40, 0 }, -10, 0, 15, 22, 50, 0, 0, 0, 0, { 0 }, 0 }, /* c */
    { 8, 1, 1, { 200, 2100, 2900 }, { 60, 150, 280 }, { 0, 45, 55, 50, 40, 0 }, -12, 0, 12, 0, 50, 0, 0, 0, 0, { 0 }, 0 }, /* ɟ */
    { 9, 1, 0, { 300, 1990, 2850 }, { 250, 160, 330 }, { 0, 60, 43, 45, 45, 0 }, -10, 0, 20, 25, 50, 0, 0, 1, 1, { 60, 53, 43, 45, 45, 0 }, 0 }, /* k */
    { 10, 1, 1, { 200, 1990, 2850 }, { 60, 150, 280 }, { 0, 60, 43, 45, 45, 0 }, -12, 0, 15, 0, 50, 0, 0, 1, 1, { 60, 53, 43, 45, 45, 0 }, 0 }, /* ɡ */
    { 11, 1, 0, { 400, 1200, 2400 }, { 250, 150, 300 }, { 55, 45, 35, 30, 30, 0 }, -10, 0, 20, 25, 50, 0, 0, 0, 0, { 0 }, 0 }, /* q */
    { 12, 1, 1, { 250, 1200, 2400 }, { 60, 120, 250 }, { 55, 45, 35, 30, 30, 0 }, -12, 0, 15, 0, 50, 0, 0, 0, 0, { 0 }, 0 }, /* ɢ */
    { 13, 9, 0, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0, 0, 0, 0 }, 0, 0, 0, 0, 0, 0, 0, 0, 0, { 0 }, 0 }, /* ʔ */
    { 14, 1, 0, { 400, 1100, 2150 }, { 300, 150, 220 }, { 0, 0, 0, 0, 0, 63 }, -12, 0, 5, 58, 40, 0, 0, 0, 0, { 0 }, 0 }, /* pʰ */
    { 15, 1, 0, { 400, 1600, 2600 }, { 300, 120, 250 }, { 0, 30, 45, 57, 63, 0 }, -10, 0, 10, 70, 45, 0, 0, 0, 0, { 0 }, 0 }, /* tʰ */
    { 16, 1, 0, { 300, 1990, 2850 }, { 250, 160, 330 }, { 0, 60, 43, 45, 45, 0 }, -10, 0, 20, 80, 50, 0, 0, 1, 1, { 60, 53, 43, 45, 45, 0 }, 0 }, /* kʰ */
    { 17, 1, 0, { 400, 1500, 1900 }, { 300, 120, 250 }, { 0, 50, 55, 50, 45, 0 }, -10, 0, 10, 60, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ʈʰ */
    { 18, 1, 1, { 200, 1100, 2150 }, { 60, 110, 130 }, { 0, 0, 0, 0, 0, 63 }, -14, 0, 5, 31, 40, 0, 0, 0, 0, { 0 }, 0 }, /* bʱ */
    { 19, 1, 1, { 200, 1600, 2600 }, { 60, 100, 170 }, { 0, 47, 60, 62, 60, 0 }, -12, 0, 8, 35, 45, 0, 0, 0, 0, { 0 }, 0 }, /* dʱ */
    { 20, 1, 1, { 200, 1500, 1900 }, { 60, 100, 170 }, { 0, 50, 55, 50, 45, 0 }, -12, 0, 8, 36, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ɖʱ */
    { 21, 1, 1, { 200, 1990, 2850 }, { 60, 150, 280 }, { 0, 60, 43, 45, 45, 0 }, -12, 0, 15, 44, 50, 0, 0, 1, 1, { 60, 53, 43, 45, 45, 0 }, 0 }, /* ɡʱ */
    { 32, 5, 1, { 480, 1270, 2130 }, { 40, 200, 200 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 35, 0.5, 450, 0, 0, { 0 }, 0 }, /* m */
    { 33, 5, 1, { 480, 1200, 2100 }, { 40, 200, 200 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 35, 0.5, 450, 0, 0, { 0 }, 0 }, /* ɱ */
    { 34, 5, 1, { 480, 1340, 2470 }, { 40, 300, 300 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 35, 0.5, 450, 0, 0, { 0 }, 0 }, /* n */
    { 35, 5, 1, { 480, 1400, 1900 }, { 40, 300, 300 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 35, 0.5, 450, 0, 0, { 0 }, 0 }, /* ɳ */
    { 36, 5, 1, { 480, 2000, 2900 }, { 40, 300, 300 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 40, 0.5, 450, 0, 0, { 0 }, 0 }, /* ɲ */
    { 37, 5, 1, { 480, 1900, 2700 }, { 40, 300, 300 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 40, 0.5, 450, 1, 0, { 0 }, 0 }, /* ŋ */
    { 38, 5, 1, { 480, 1200, 2400 }, { 40, 300, 300 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 40, 0.5, 450, 0, 0, { 0 }, 0 }, /* ɴ */
    { 40, 8, 1, { 300, 1100, 2150 }, { 70, 110, 130 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 50, 0, 0, 0, 0, { 0 }, 0 }, /* ʙ */
    { 41, 8, 1, { 300, 1500, 2500 }, { 70, 100, 150 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 50, 0, 0, 0, 0, { 0 }, 0 }, /* r */
    { 42, 8, 1, { 400, 1200, 2300 }, { 80, 120, 200 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 50, 0, 0, 0, 0, { 0 }, 0 }, /* ʀ */
    { 44, 7, 1, { 300, 1100, 2080 }, { 60, 90, 120 }, { 0, 0, 0, 0, 0, 0 }, 0, 20, 0, 0, 35, 0, 0, 0, 0, { 0 }, 0 }, /* ⱱ */
    { 45, 7, 1, { 300, 1600, 2600 }, { 60, 100, 170 }, { 0, 0, 0, 0, 0, 0 }, 0, 20, 0, 0, 35, 0, 0, 0, 0, { 0 }, 0 }, /* ɾ */
    { 46, 7, 1, { 300, 1500, 1900 }, { 60, 100, 170 }, { 0, 0, 0, 0, 0, 0 }, 0, 20, 0, 0, 35, 0, 0, 0, 0, { 0 }, 0 }, /* ɽ */
    { 48, 3, 0, { 340, 1000, 2100 }, { 200, 120, 150 }, { 0, 0, 0, 0, 0, 55 }, -24, 100, 0, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* ɸ */
    { 49, 3, 1, { 220, 1000, 2100 }, { 60, 90, 120 }, { 0, 0, 0, 0, 0, 55 }, -28, 70, 0, 0, 40, 0.35, 0, 0, 0, { 0 }, 0 }, /* β */
    { 50, 3, 0, { 340, 1100, 2080 }, { 200, 120, 150 }, { 0, 0, 0, 0, 0, 57 }, -22, 100, 0, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* f */
    { 51, 3, 1, { 220, 1100, 2080 }, { 60, 90, 120 }, { 0, 0, 0, 0, 0, 57 }, -26, 70, 0, 0, 40, 0.35, 0, 0, 0, { 0 }, 0 }, /* v */
    { 52, 3, 0, { 320, 1290, 2540 }, { 200, 90, 200 }, { 0, 0, 0, 0, 28, 48 }, -24, 100, 0, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* θ */
    { 53, 3, 1, { 270, 1290, 2540 }, { 60, 80, 170 }, { 0, 0, 0, 0, 28, 48 }, -28, 70, 0, 0, 40, 0.35, 0, 0, 0, { 0 }, 0 }, /* ð */
    { 54, 3, 0, { 320, 1390, 2530 }, { 200, 80, 200 }, { 0, 0, 0, 0, 52, 0 }, -8, 120, 0, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* s */
    { 55, 3, 1, { 240, 1390, 2530 }, { 70, 60, 180 }, { 0, 0, 0, 0, 52, 0 }, -12, 90, 0, 0, 40, 0.35, 0, 0, 0, { 0 }, 0 }, /* z */
    { 56, 3, 0, { 300, 1840, 2750 }, { 200, 100, 300 }, { 0, 57, 48, 48, 46, 0 }, -6, 120, 0, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* ʃ */
    { 57, 3, 1, { 240, 1840, 2750 }, { 60, 100, 300 }, { 0, 57, 48, 48, 46, 0 }, -10, 90, 0, 0, 40, 0.35, 0, 0, 0, { 0 }, 0 }, /* ʒ */
    { 58, 3, 0, { 300, 1600, 2000 }, { 200, 100, 250 }, { 0, 57, 50, 40, 30, 0 }, -7, 120, 0, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* ʂ */
    { 59, 3, 1, { 240, 1600, 2000 }, { 60, 100, 250 }, { 0, 57, 50, 40, 30, 0 }, -11, 90, 0, 0, 40, 0.35, 0, 0, 0, { 0 }, 0 }, /* ʐ */
    { 60, 3, 0, { 300, 2100, 3000 }, { 200, 150, 300 }, { 0, 35, 55, 50, 40, 0 }, -12, 110, 0, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ç */
    { 61, 3, 1, { 240, 2100, 3000 }, { 60, 150, 300 }, { 0, 35, 55, 50, 40, 0 }, -16, 80, 0, 0, 45, 0.35, 0, 0, 0, { 0 }, 0 }, /* ʝ */
    { 62, 3, 0, { 300, 1700, 2600 }, { 200, 150, 300 }, { 57, 50, 40, 35, 30, 0 }, -14, 110, 0, 0, 45, 0, 0, 1, 0, { 0 }, 0 }, /* x */
    { 63, 3, 1, { 240, 1700, 2600 }, { 60, 150, 300 }, { 57, 50, 40, 35, 30, 0 }, -18, 80, 0, 0, 45, 0.35, 0, 1, 0, { 0 }, 0 }, /* ɣ */
    { 64, 3, 0, { 400, 1200, 2400 }, { 200, 150, 300 }, { 58, 45, 35, 30, 25, 0 }, -13, 110, 0, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* χ */
    { 65, 3, 1, { 300, 1200, 2400 }, { 80, 150, 300 }, { 58, 45, 35, 30, 25, 0 }, -17, 80, 0, 0, 45, 0.35, 0, 0, 0, { 0 }, 0 }, /* ʁ */
    { 66, 4, 0, { 700, 1100, 2500 }, { 300, 150, 300 }, { 0, 0, 0, 0, 0, 0 }, -16, 90, 0, 0, 30, 0, 0, 0, 0, { 0 }, 0 }, /* ħ */
    { 67, 4, 1, { 700, 1100, 2500 }, { 100, 150, 300 }, { 0, 0, 0, 0, 0, 0 }, -20, 70, 0, 0, 30, 0.4, 0, 0, 0, { 0 }, 0 }, /* ʕ */
    { 68, 4, 0, { 0, 0, 0 }, { 300, 0, 0 }, { 0, 0, 0, 0, 0, 0 }, -16, 70, 0, 0, 15, 0, 0, 0, 0, { 0 }, 0 }, /* h */
    { 69, 4, 1, { 0, 0, 0 }, { 300, 0, 0 }, { 0, 0, 0, 0, 0, 0 }, -20, 60, 0, 0, 15, 0.4, 0, 0, 0, { 0 }, 0 }, /* ɦ */
    { 70, 3, 0, { 320, 1300, 2600 }, { 200, 90, 200 }, { 0, 0, 45, 50, 48, 40 }, -12, 110, 0, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ɬ */
    { 71, 3, 1, { 240, 1300, 2600 }, { 60, 90, 200 }, { 0, 0, 45, 50, 48, 40 }, -16, 80, 0, 0, 45, 0.35, 0, 0, 0, { 0 }, 0 }, /* ɮ */
    { 72, 3, 0, { 300, 2000, 2900 }, { 200, 120, 300 }, { 0, 45, 57, 50, 45, 0 }, -7, 120, 0, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ɕ */
    { 73, 3, 1, { 240, 2000, 2900 }, { 60, 120, 300 }, { 0, 45, 57, 50, 45, 0 }, -11, 90, 0, 0, 45, 0.35, 0, 0, 0, { 0 }, 0 }, /* ʑ */
    { 74, 3, 0, { 290, 610, 2150 }, { 200, 80, 60 }, { 0, 0, 0, 0, 0, 50 }, -22, 90, 0, 0, 100, 0, 0, 0, 0, { 0 }, 0 }, /* ʍ */
    { 75, 3, 0, { 320, 1390, 2530 }, { 200, 80, 200 }, { 0, 0, 0, 0, 52, 0 }, -8, 90, 0, 53, 40, 0, 0, 0, 0, { 0 }, 0 }, /* sʰ */
    { 80, 6, 1, { 300, 1100, 2200 }, { 60, 90, 150 }, { 0, 0, 0, 0, 0, 0 }, 0, 50, 0, 0, 70, 0.4, 0, 0, 0, { 0 }, 0 }, /* ʋ */
    { 81, 6, 1, { 310, 1060, 1380 }, { 70, 100, 120 }, { 0, 0, 0, 0, 0, 0 }, 0, 50, 0, 0, 90, 0.4, 0, 0, 0, { 0 }, 0 }, /* ɹ */
    { 82, 6, 1, { 310, 1100, 1500 }, { 70, 100, 120 }, { 0, 0, 0, 0, 0, 0 }, 0, 50, 0, 0, 90, 0.4, 0, 0, 0, { 0 }, 0 }, /* ɻ */
    { 83, 6, 1, { 260, 2070, 3020 }, { 40, 250, 500 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 100, 0.4, 0, 0, 0, { 0 }, 0 }, /* j */
    { 84, 6, 1, { 300, 1200, 2400 }, { 50, 90, 150 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 100, 0.4, 0, 0, 0, { 0 }, 0 }, /* ɰ */
    { 85, 6, 1, { 290, 610, 2150 }, { 50, 80, 60 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 100, 0.4, 0, 0, 0, { 0 }, 0 }, /* w */
    { 86, 6, 1, { 260, 1700, 2200 }, { 40, 200, 300 }, { 0, 0, 0, 0, 0, 0 }, 0, 40, 0, 0, 100, 0.4, 0, 0, 0, { 0 }, 0 }, /* ɥ */
    { 88, 6, 1, { 310, 1050, 2880 }, { 50, 100, 280 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 60, 0.4, 0, 0, 0, { 0 }, 0 }, /* l */
    { 89, 6, 1, { 310, 1300, 1900 }, { 50, 100, 200 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 60, 0.4, 0, 0, 0, { 0 }, 0 }, /* ɭ */
    { 90, 6, 1, { 300, 2000, 2800 }, { 50, 150, 250 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 70, 0.4, 0, 0, 0, { 0 }, 0 }, /* ʎ */
    { 91, 6, 1, { 310, 1100, 2700 }, { 50, 100, 250 }, { 0, 0, 0, 0, 0, 0 }, 0, 60, 0, 0, 70, 0.4, 0, 0, 0, { 0 }, 0 }, /* ʟ */
    { 96, 2, 0, { 320, 1500, 2550 }, { 200, 90, 200 }, { 0, 0, 0, 0, 52, 0 }, -8, 70, 8, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* t͡s */
    { 97, 2, 1, { 240, 1500, 2550 }, { 70, 60, 180 }, { 0, 0, 0, 0, 52, 0 }, -12, 60, 8, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* d͡z */
    { 98, 2, 0, { 350, 1800, 2820 }, { 200, 90, 300 }, { 0, 44, 60, 53, 53, 0 }, -6, 70, 8, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* t͡ʃ */
    { 99, 2, 1, { 260, 1800, 2820 }, { 60, 80, 270 }, { 0, 44, 60, 53, 53, 0 }, -10, 60, 8, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* d͡ʒ */
    { 100, 2, 0, { 300, 2000, 2900 }, { 200, 120, 300 }, { 0, 45, 57, 50, 45, 0 }, -7, 70, 10, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* t͡ɕ */
    { 101, 2, 1, { 240, 2000, 2900 }, { 60, 120, 300 }, { 0, 45, 57, 50, 45, 0 }, -11, 60, 10, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* d͡ʑ */
    { 102, 2, 0, { 300, 1600, 2000 }, { 200, 100, 250 }, { 0, 57, 50, 40, 30, 0 }, -7, 70, 10, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ʈ͡ʂ */
    { 103, 2, 1, { 240, 1600, 2000 }, { 60, 100, 250 }, { 0, 57, 50, 40, 30, 0 }, -11, 60, 10, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ɖ͡ʐ */
    { 104, 2, 0, { 340, 1100, 2080 }, { 200, 120, 150 }, { 0, 0, 0, 0, 0, 57 }, -16, 70, 5, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* p͡f */
    { 105, 2, 0, { 300, 1800, 2700 }, { 250, 160, 330 }, { 57, 50, 40, 35, 30, 0 }, -12, 70, 20, 0, 50, 0, 0, 1, 0, { 0 }, 0 }, /* k͡x */
    { 106, 2, 0, { 300, 2100, 3000 }, { 200, 150, 300 }, { 0, 35, 55, 50, 40, 0 }, -12, 70, 15, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* c͡ç */
    { 107, 2, 1, { 240, 2100, 3000 }, { 60, 150, 300 }, { 0, 35, 55, 50, 40, 0 }, -16, 60, 12, 0, 45, 0, 0, 0, 0, { 0 }, 0 }, /* ɟ͡ʝ */
    { 108, 2, 0, { 320, 1290, 2540 }, { 200, 90, 200 }, { 0, 0, 0, 0, 28, 48 }, -18, 70, 8, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* t͡θ */
    { 109, 2, 1, { 270, 1290, 2540 }, { 60, 80, 170 }, { 0, 0, 0, 0, 28, 48 }, -22, 60, 8, 0, 40, 0, 0, 0, 0, { 0 }, 0 }, /* d͡ð */
    { 110, 2, 1, { 240, 1800, 2700 }, { 60, 150, 300 }, { 57, 50, 40, 35, 30, 0 }, -16, 60, 15, 0, 50, 0, 0, 1, 0, { 0 }, 0 }, /* ɡ͡ɣ */
    { 111, 2, 0, { 0, 0, 0 }, { 300, 0, 0 }, { 0, 0, 0, 0, 0, 0 }, -16, 50, 0, 0, 15, 0, 0, 0, 0, { 0 }, 1 }, /* ʔ͡h */
};
#define ROW_COUNT ((int)(sizeof ROWS / sizeof ROWS[0]))

static const TaudConsonant *consonant(int id)
{
    int i;
    for (i = 0; i < ROW_COUNT; i++) if (ROWS[i].id == id) return &ROWS[i];
    return NULL;
}

/* The glides: [code] → the syllabic vowel's chart point and the row. */
static const struct { int front, open, round, row; } SEMIVOWELS[5] = {
    { 0, 0, 0, 0 },
    { 255, 0, 0, 83 },
    { 255, 0, 255, 86 },
    { 0, 0, 0, 84 },
    { 0, 0, 255, 85 },
};

static bool consonant_needs_noise(const TaudConsonant *r)
{
    return r != NULL && (r->manner == MANNER_STOP || r->manner == MANNER_AFFRICATE ||
                         r->manner == MANNER_FRICATIVE || r->manner == MANNER_ASPIRATE);
}

#define CLOSURE_MS 50
#define ASPIRATION_DB (-6)
/* A breathy-voiced stop's release: after its noisy lag (the row's `vot`) the
 * voice comes in BREATHY — the breath laid over it — for this long, rising
 * from MURMUR_AV. */
#define BREATHY_SA 47
#define MURMUR_AV 0.05
/* Is the row a breathy-voiced stop ([bʱ]): voiced, with a release lag? */
static bool is_breathy(const TaudConsonant *r) { return r->manner == MANNER_STOP && r->voiced && r->vot > 0; }
static double db_gain(double db) { return js_pow(10, db / 20); }

/* ── segment tracks ── */

static void tr_reset(TaudFormantTrack *t) { t->n = 0; }

static TaudFormantTrack *tr_at(TaudFormantTrack *t, double time, double v)
{
    if (t->n >= 2 && time < t->p[t->n - 2]) time = t->p[t->n - 2];
    if (t->n + 2 <= FORMANT_TRACK_MAX) { t->p[t->n] = time; t->p[t->n + 1] = v; t->n += 2; }
    return t;
}

static void tr_close(TaudFormantTrack *t, double time, double v)
{
    double lt;
    if (t->n == 0) tr_at(t, 0, v);
    lt = t->p[t->n - 2];
    if (time > lt) tr_at(t, time, v);
    else if (t->p[t->n - 1] != v) tr_at(t, lt, v);
}

static double track_at(const TaudFormantTrack *tr, double t)
{
    const double *p = tr->p;
    int i;
    if (t <= p[0]) return p[1];
    for (i = 2; i < tr->n; i += 2) {
        if (t < p[i]) {
            double t0 = p[i - 2], t1 = p[i], v0 = p[i - 1], v1 = p[i + 1];
            return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
        }
    }
    return p[tr->n - 1];
}

typedef struct { double av, ah, af, nz; } NextStart;

/* Append a point as Float64Array.from does, without at()'s clamp. */
static void tr_push(TaudFormantTrack *t, double time, double v)
{
    if (t->n + 2 <= FORMANT_TRACK_MAX) { t->p[t->n] = time; t->p[t->n + 1] = v; t->n += 2; }
}

/* A closed track with a glottal catch at its START (catchTrack): 0 until t0,
 * back on the track's own value by t1. */
static void catch_track(TaudFormantTrack *tr, double t0, double t1)
{
    TaudFormantTrack out;
    int i;
    out.n = 0;
    tr_push(&out, 0, 0);
    tr_push(&out, t0, 0);
    tr_push(&out, t1, track_at(tr, t1));
    for (i = 0; i < tr->n; i += 2) if (tr->p[i] > t1) tr_push(&out, tr->p[i], tr->p[i + 1]);
    *tr = out;
}

/* The av track's glottal catch for an obstruent's voicing (onsetTracks catchAt). */
static void catch_at(TaudFormantTrack *av, double t, double k, double nxAv)
{
    tr_at(tr_at(tr_at(av, 0, 0), t + GLOT_CATCH * k, 0), t + (GLOT_CATCH + GLOT_RISE) * k, nxAv);
}

/* An onset consonant's tracks (onsetTracks). `art` is its secondary
 * articulation, of which only the glottal one changes a track. Every oral
 * consonant's nasality holds 0 until its own part is over. */
static void onset_tracks_of(const TaudConsonant *r, bool first, const NextStart *nx, double k, int art,
                            TaudFormantSegment *sg)
{
    TaudFormantTrack *w = &sg->w, *av = &sg->av, *ah = &sg->ah, *af = &sg->af, *nz = &sg->nz;
    double L = db_gain(r->lvl);
    double tr = r->trans * k, dur = r->dur * k, end;
    bool glot = art == ART_GLOTTAL, sonorant = false;
    tr_reset(w); tr_reset(av); tr_reset(ah); tr_reset(af); tr_reset(nz);
    switch (r->manner) {
    case MANNER_STOP: {
        double cl = first ? 0 : CLOSURE_MS * k;
        double tb = cl + r->burst * k;
        double tv;
        tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), cl, 0), cl, L), tb, 0.3 * L), tb + 2 * k, 0);
        tr_at(ah, 0, 0);
        tr_at(tr_at(tr_at(tr_at(w, 0, 1), tb, 1), tb + 1 * k, 0.5), tb + tr, 0);
        tr_at(tr_at(nz, 0, 0), tb, 0);
        if (glot) {
            /* The glottis shut through the closure, the voicing in at once. */
            tv = tb + dmin(r->vot, GLOT_LAG) * k;
            tr_at(tr_at(tr_at(av, 0, 0), tv, 0), tv + GLOT_RISE * k, nx->av);
            end = dmax(tv + GLOT_RISE * k, tb + tr);
            break;
        }
        tv = tb + r->vot * k;
        if (is_breathy(r)) {
            /* The closure voiced; the release a noisy lag over a weak voice —
             * its breath at the burst's own level — then the voice rising
             * through it. */
            double ts = tv + BREATHY_SA * k;
            tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(av, 0, cl > 0 ? 0.25 : 0.3), cl, cl > 0 ? 0.25 : 0.3), tb, 0.3),
                  tb + 3 * k, MURMUR_AV), tv, MURMUR_AV), ts, nx->av);
            tr_at(tr_at(tr_at(tr_at(ah, tb, 0), tb + 3 * k, L), tv, 0.7 * L), ts, nx->ah);
            end = dmax(ts, tb + tr);
            break;
        }
        if (r->voiced) {
            tr_at(tr_at(tr_at(tr_at(av, 0, cl > 0 ? 0.25 : 0.3), cl, cl > 0 ? 0.25 : 0.3), tb, 0.3), tb + 10 * k, nx->av);
        } else {
            tr_at(tr_at(tr_at(av, 0, 0), tv, 0), tv + 10 * k, nx->av);
        }
        if (!r->voiced && r->vot > 0) {
            double La = L * db_gain(ASPIRATION_DB);
            tr_at(tr_at(tr_at(tr_at(ah, tb, 0), tb + 3 * k, La), tv, 0.7 * La), tv + 10 * k, nx->ah);
        }
        end = dmax(tv + 10 * k, tb + tr);
        break;
    }
    case MANNER_AFFRICATE: {
        double cl = first ? 0 : CLOSURE_MS * k;
        double tb = cl + r->burst * k;
        double tf = tb + dur;
        tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), cl, 0), cl, L), tb, 0.8 * L), tf - 10 * k, L), tf + 10 * k, nx->af);
        if (glot) catch_at(av, tf, k, nx->av);
        else if (r->voiced) tr_at(tr_at(tr_at(av, 0, 0.3), tf, 0.3), tf + 15 * k, nx->av);
        else tr_at(tr_at(tr_at(av, 0, 0), tf, 0), tf + 15 * k, nx->av);
        tr_at(ah, 0, 0);
        tr_at(tr_at(tr_at(w, 0, 1), tf, 1), tf + tr, 0);
        tr_at(tr_at(nz, 0, 0), tf, 0);
        end = dmax(tf + 15 * k, tf + tr);
        if (glot) end = dmax(end, tf + (GLOT_CATCH + GLOT_RISE) * k);
        break;
    }
    case MANNER_FRICATIVE:
        tr_at(tr_at(tr_at(tr_at(af, 0, 0), 10 * k, L), dur - 10 * k, L), dur + 10 * k, nx->af);
        if (!glot && !r->voiced && r->vot > 0) {
            /* Aspirated: the frication gives way to breath, and the voice
             * waits for the breath to end. */
            double tv = dur + r->vot * k;
            double La = L * db_gain(ASPIRATION_DB);
            tr_at(tr_at(tr_at(tr_at(tr_at(ah, 0, 0), dur - 10 * k, 0), dur, La), tv, 0.7 * La), tv + 10 * k, nx->ah);
            tr_at(tr_at(tr_at(av, 0, 0), tv - 5 * k, 0), tv + 15 * k, nx->av);
            tr_at(tr_at(tr_at(w, 0, 1), dur, 1), dur + tr, 0);
            tr_at(tr_at(nz, 0, 0), tv, 0);
            end = dmax(tv + 15 * k, dur + tr);
            break;
        }
        if (glot) catch_at(av, dur, k, nx->av);
        else if (r->voiced) tr_at(tr_at(tr_at(av, 0, r->av), dur, r->av), dur + 15 * k, nx->av);
        else tr_at(tr_at(tr_at(av, 0, 0), dur - 5 * k, 0), dur + 15 * k, nx->av);
        tr_at(ah, 0, 0);
        tr_at(tr_at(tr_at(w, 0, 1), dur, 1), dur + tr, 0);
        tr_at(tr_at(nz, 0, 0), dur, 0);
        end = dmax(dur + 15 * k, dur + tr);
        if (glot) end = dmax(end, dur + (GLOT_CATCH + GLOT_RISE) * k);
        break;
    case MANNER_ASPIRATE:
        tr_at(tr_at(tr_at(tr_at(ah, 0, 0), 10 * k, L), dur - 10 * k, L), dur + 10 * k, nx->ah);
        if (glot) catch_at(av, dur, k, nx->av);
        else if (r->voiced) tr_at(tr_at(tr_at(av, 0, r->av), dur, r->av), dur + 10 * k, nx->av);
        else tr_at(tr_at(tr_at(av, 0, 0), dur - 10 * k, 0), dur + 10 * k, nx->av);
        tr_at(af, 0, 0);
        tr_at(tr_at(tr_at(w, 0, 1), dur, 1), dur + tr, 0);
        tr_at(tr_at(nz, 0, 0), dur, 0);
        end = dmax(dur + 10 * k, dur + tr);
        if (glot) end = dmax(end, dur + (GLOT_CATCH + GLOT_RISE) * k);
        break;
    case MANNER_NASAL:
        tr_at(tr_at(tr_at(av, 0, r->av), dur, r->av), dur + 10 * k, nx->av);
        tr_at(tr_at(tr_at(nz, 0, 1), dur, 1), dur + 10 * k, nx->nz);
        tr_at(tr_at(tr_at(tr_at(w, 0, 1), dur, 1), dur + 5 * k, 0.5), dur + tr, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0);
        end = dmax(dur + 10 * k, dur + tr);
        sonorant = true;
        break;
    case MANNER_APPROX:
        tr_at(tr_at(tr_at(av, 0, r->av), dur, r->av), dur + tr * 0.5, nx->av);
        tr_at(tr_at(tr_at(w, 0, 1), dur, 1), dur + tr, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, 0), dur, 0);
        end = dur + tr;
        sonorant = true;
        break;
    case MANNER_TAP:
        tr_at(tr_at(tr_at(av, 0, 0.2), dur, 0.2), dur + 5 * k, nx->av);
        tr_at(tr_at(tr_at(w, 0, 1), dur, 1), dur + tr, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, 0), dur, 0);
        end = dmax(dur + 5 * k, dur + tr);
        sonorant = true;
        break;
    case MANNER_TRILL: {
        double c = dur, shut = c * 0.375, tail;
        tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(av, 0, 0.12), shut, 0.12), shut + 3 * k, 0.7), c - 3 * k, 0.7),
              c, 0.12), c + shut, 0.12), c + shut + 3 * k, nx->av);
        tail = c + shut + 3 * k;
        tr_at(tr_at(tr_at(w, 0, 1), tail, 1), tail + tr, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, 0), tail, 0);
        end = tail + tr;
        sonorant = true;
        break;
    }
    default: {
        double cl = first ? 0 : 30 * k;
        tr_at(tr_at(tr_at(av, 0, 0), cl, 0), cl + 3 * k, nx->av);
        tr_at(w, 0, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, 0), cl, 0);
        end = cl + 3 * k;
        break;
    }
    }
    sg->end = end;
    sg->loop = 0;
    tr_close(av, end, nx->av);
    /* A glottalised sonorant is said after a glottal stop: the catch first. */
    if (glot && sonorant) catch_track(av, GLOT_CATCH * k, (GLOT_CATCH + GLOT_RISE) * k);
    tr_close(w, end, 0);
    tr_close(ah, end, nx->ah);
    tr_close(af, end, nx->af);
    tr_close(nz, end, nx->nz);
}

/* Tracks with their two noise paths exchanged (breathed): frication built as
 * a row's `af` sounds through the cascade as `ah`, and the other way about. */
static void breathed(TaudFormantSegment *sg)
{
    TaudFormantTrack t = sg->ah;
    sg->ah = sg->af;
    sg->af = t;
}

/* The onset tracks — a BREATH row's ([ʔ͡h]) frication is its aspiration. */
static void onset_tracks(const TaudConsonant *r, bool first, const NextStart *nx, double k, int art,
                         TaudFormantSegment *sg)
{
    NextStart sw;
    if (!r->breath) { onset_tracks_of(r, first, nx, k, art, sg); return; }
    sw.av = nx->av; sw.ah = nx->af; sw.af = nx->ah; sw.nz = nx->nz;
    onset_tracks_of(r, first, &sw, k, art, sg);
    breathed(sg);
}

/* A NUCLEUS's tracks (nucleusTracks): the consonant a syllable with no vowel
 * is held on. It starts as an onset consonant does and then holds what it can
 * sustain; past `end` every track holds, but a trill's time wraps back by
 * `loop` ms. */
static void nucleus_tracks_of(const TaudConsonant *r, bool first, double k, int art, TaudFormantSegment *sg)
{
    TaudFormantTrack *w = &sg->w, *av = &sg->av, *ah = &sg->ah, *af = &sg->af, *nz = &sg->nz;
    double L = db_gain(r->lvl);
    double dur = r->dur * k, end, loop = 0;
    bool glot = art == ART_GLOTTAL, sonorant = false;
    tr_reset(w); tr_reset(av); tr_reset(ah); tr_reset(af); tr_reset(nz);
    tr_at(w, 0, 1);
    switch (r->manner) {
    case MANNER_STOP: {
        double cl = first ? 0 : CLOSURE_MS * k;
        double tb = cl + r->burst * k;
        tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), cl, 0), cl, L), tb, 0.3 * L), tb + 2 * k, 0);
        tr_at(ah, 0, 0);
        if (glot) {
            double tv = tb + GLOT_LAG * k;
            tr_at(tr_at(tr_at(av, 0, 0), tv, 0), tv + GLOT_RISE * k, r->voiced ? 1 : 0);
            end = tv + GLOT_RISE * k;
        } else if (is_breathy(r)) {
            double a = cl > 0 ? 0.25 : 0.3;
            double tv = tb + r->vot * k, ts = tv + BREATHY_SA * k;
            tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(av, 0, a), cl, a), tb, 0.3), tb + 3 * k, MURMUR_AV), tv, MURMUR_AV), ts, 1);
            tr_at(tr_at(tr_at(tr_at(ah, tb, 0), tb + 3 * k, L), tv, 0.7 * L), ts, 0);
            end = ts;
        } else if (r->voiced) {
            double a = cl > 0 ? 0.25 : 0.3;
            tr_at(tr_at(tr_at(tr_at(av, 0, a), cl, a), tb, 0.3), tb + 10 * k, 1);
            end = tb + 10 * k;
        } else {
            tr_at(av, 0, 0);
            if (r->vot > 0) {
                double La = L * db_gain(ASPIRATION_DB);
                tr_at(tr_at(tr_at(ah, tb, 0), tb + 3 * k, La), tb + 10 * k, 0.7 * La);
            }
            end = tb + 10 * k;
        }
        tr_at(nz, 0, 0);
        break;
    }
    case MANNER_AFFRICATE: {
        double cl = first ? 0 : CLOSURE_MS * k;
        double tb = cl + r->burst * k;
        tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), cl, 0), cl, L), tb, 0.8 * L), tb + 10 * k, L);
        tr_at(av, 0, r->voiced && !glot ? 0.3 : 0);
        tr_at(ah, 0, 0); tr_at(nz, 0, 0);
        end = tb + 10 * k;
        break;
    }
    case MANNER_FRICATIVE:
        tr_at(tr_at(af, 0, 0), 10 * k, L);
        tr_at(av, 0, r->voiced && !glot ? r->av : 0);
        tr_at(ah, 0, 0); tr_at(nz, 0, 0);
        end = 10 * k;
        break;
    case MANNER_ASPIRATE:
        tr_at(tr_at(ah, 0, 0), 10 * k, L);
        tr_at(av, 0, r->voiced && !glot ? r->av : 0);
        tr_at(af, 0, 0); tr_at(nz, 0, 0);
        end = 10 * k;
        break;
    case MANNER_NASAL:
        tr_at(av, 0, 1);
        tr_at(nz, 0, 1);
        tr_at(ah, 0, 0); tr_at(af, 0, 0);
        end = 0;
        sonorant = true;
        break;
    case MANNER_APPROX:
        tr_at(av, 0, 1);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(nz, 0, 0);
        end = 0;
        sonorant = true;
        break;
    case MANNER_TAP:            /* the tap, then the voicing held where it let go */
        tr_at(tr_at(tr_at(av, 0, 0.2), dur, 0.2), dur + 5 * k, 1);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(nz, 0, 0);
        end = dur + 5 * k;
        sonorant = true;
        break;
    case MANNER_TRILL: {        /* two cycles; the second repeats */
        double c = dur, shut = c * 0.375;
        int n;
        for (n = 0; n < 2; n++) {
            double o = n * c;
            tr_at(tr_at(tr_at(tr_at(av, o, 0.12), o + shut, 0.12), o + shut + 3 * k, 0.7), o + c - 3 * k, 0.7);
        }
        tr_at(av, 2 * c, 0.12);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(nz, 0, 0);
        end = 2 * c;
        loop = c;
        sonorant = true;
        break;
    }
    default:                    /* the glottis shut, and nothing to hold */
        tr_at(av, 0, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(nz, 0, 0);
        end = 0;
        break;
    }
    sg->end = end;
    sg->loop = loop;
    tr_close(av, end, av->p[av->n - 1]);
    if (glot && sonorant) catch_track(av, GLOT_CATCH * k, (GLOT_CATCH + GLOT_RISE) * k);
    tr_close(w, end, w->p[w->n - 1]);
    tr_close(ah, end, ah->p[ah->n - 1]);
    tr_close(af, end, af->p[af->n - 1]);
    tr_close(nz, end, nz->p[nz->n - 1]);
}

/* The nucleus tracks — a BREATH row's ([ʔ͡h]) frication is its aspiration. */
static void nucleus_tracks(const TaudConsonant *r, bool first, double k, int art, TaudFormantSegment *sg)
{
    nucleus_tracks_of(r, first, k, art, sg);
    if (r->breath) breathed(sg);
}

/* A CODA consonant's tracks (codaTracks): from the sound before it — the
 * vowel, or a held nucleus with voicing v0 and nasality z0 — into silence.
 * `art` is the coda's own articulation (CODA_*). */
static void coda_tracks_of(const TaudConsonant *r, double k, double v0, double z0, int art, TaudFormantSegment *sg)
{
    TaudFormantTrack *w = &sg->w, *av = &sg->av, *ah = &sg->ah, *af = &sg->af, *nz = &sg->nz;
    double L = db_gain(r->lvl);
    double tr = r->trans * k, dur = r->dur * k, end;
    bool glot = art == CODA_GLOTTAL;
    double gs = GLOT_STOP * k;
    /* Where the coda HOLDS while the key does, after S $9010 (item 292): the
     * end of the consonant's steady part — a stop in its closure, before the
     * burst — and, for a trill, the cycle it repeats there (`loop`). */
    double hold, loop = 0;
    tr_reset(w); tr_reset(av); tr_reset(ah); tr_reset(af); tr_reset(nz);
    switch (r->manner) {
    case MANNER_STOP:
    case MANNER_AFFRICATE: {
        double tc = tr + CLOSURE_MS * k;
        double tb = tc + r->burst * k;
        /* A ms before the release: AT tc the burst's frication has already
         * stepped on (the later of two points at one time holds). */
        hold = tc - k;
        tr_at(tr_at(tr_at(w, 0, 0), tr, 0.5), tr + 5 * k, 1);
        if (glot) tr_at(tr_at(tr_at(av, 0, v0), tr, v0), tr + gs, 0);
        else if (r->voiced) tr_at(tr_at(tr_at(tr_at(tr_at(av, 0, v0), tr, v0), tr + 8 * k, 0.25), tc, 0.2), tc + 5 * k, 0);
        else tr_at(tr_at(tr_at(av, 0, v0), tr, v0), tr + 8 * k, 0);
        if (art == CODA_UNRELEASED) {
            tr_at(af, 0, 0);
            tr_at(ah, 0, 0);
            end = r->voiced ? tc + 5 * k : tr + 8 * k;
        } else if (r->manner == MANNER_STOP) {
            tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), tc, 0), tc, 0.7 * L), tb, 0.2 * L), tb + 2 * k, 0);
            tr_at(ah, 0, 0);
            if (!glot && r->vot > 0) {
                double La = L * db_gain(ASPIRATION_DB);
                tr_at(tr_at(tr_at(ah, tb, 0), tb + 2 * k, 0.5 * La), tb + 30 * k, 0);
                /* A breathy stop's release is murmured: a weak voice under its breath. */
                if (r->voiced) tr_at(tr_at(tr_at(av, tb, 0), tb + 2 * k, MURMUR_AV), tb + 30 * k, 0);
            }
            end = tb + 35 * k;
        } else {
            tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), tc, 0), tc, L), tb + dur, 0.6 * L), tb + dur + 20 * k, 0);
            tr_at(ah, 0, 0);
            end = tb + dur + 20 * k;
        }
        tr_at(tr_at(nz, 0, z0), tr + 5 * k, 0);
        break;
    }
    case MANNER_FRICATIVE: {
        double a = dmax(tr - 15 * k, 0);
        hold = tr + dur;
        tr_at(tr_at(w, 0, 0), tr, 1);
        if (glot) tr_at(tr_at(tr_at(av, 0, v0), a, v0), a + gs, 0);
        else if (r->voiced) tr_at(tr_at(tr_at(tr_at(av, 0, v0), tr, r->av), tr + dur, 0.7 * r->av), tr + dur + 30 * k, 0);
        else tr_at(tr_at(tr_at(av, 0, v0), a, v0), tr + 5 * k, 0);
        tr_at(tr_at(tr_at(tr_at(tr_at(af, 0, 0), a, 0), tr + 5 * k, L), tr + dur, 0.8 * L), tr + dur + 30 * k, 0);
        tr_at(ah, 0, 0); tr_at(tr_at(nz, 0, z0), tr, 0);
        end = tr + dur + 30 * k;
        if (!glot && !r->voiced && r->vot > 0) {   /* aspirated: its breath after it */
            double La = L * db_gain(ASPIRATION_DB);
            tr_at(tr_at(tr_at(ah, tr + dur, 0), tr + dur + 10 * k, 0.5 * La), tr + dur + (r->vot + 30) * k, 0);
            end = tr + dur + (r->vot + 30) * k;
        }
        break;
    }
    case MANNER_ASPIRATE:
        hold = dur;
        tr_at(tr_at(w, 0, 0), 15 * k, 1);
        if (glot) tr_at(tr_at(av, 0, v0), gs, 0);
        else if (r->voiced) tr_at(tr_at(tr_at(tr_at(av, 0, v0), 20 * k, r->av), dur, 0.5 * r->av), dur + 20 * k, 0);
        else tr_at(tr_at(av, 0, v0), 20 * k, 0);
        tr_at(tr_at(tr_at(tr_at(ah, 0, 0), 10 * k, L), dur, 0.5 * L), dur + 30 * k, 0);
        tr_at(af, 0, 0); tr_at(tr_at(nz, 0, z0), 15 * k, 0);
        end = dur + 30 * k;
        break;
    case MANNER_NASAL:
        hold = tr + dur;
        tr_at(tr_at(w, 0, 0), tr, 1);
        tr_at(tr_at(tr_at(nz, 0, z0), dmax(tr - 5 * k, 0), z0), tr, 1);
        tr_at(tr_at(tr_at(av, 0, v0), tr, r->av), tr + dur, 0.8 * r->av);
        end = tr + dur + (glot ? gs : 40 * k);
        tr_at(av, end, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0);
        break;
    case MANNER_APPROX:
        hold = tr + dur;
        tr_at(tr_at(w, 0, 0), tr, 1);
        tr_at(tr_at(tr_at(av, 0, v0), tr, r->av), tr + dur, 0.8 * r->av);
        end = tr + dur + (glot ? gs : 40 * k);
        tr_at(av, end, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, z0), tr, 0);
        break;
    case MANNER_TAP:
        tr_at(tr_at(w, 0, 0), tr, 1);
        tr_at(tr_at(tr_at(tr_at(av, 0, v0), tr, v0), tr + 3 * k, 0.2), tr + dur, 0.2);
        if (glot) {
            end = tr + dur + gs;
            hold = tr + dur;
        } else {
            tr_at(av, tr + dur + 3 * k, 0.6);
            end = tr + dur + 40 * k;
            hold = tr + dur + 3 * k;
        }
        tr_at(av, end, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, z0), tr, 0);
        break;
    case MANNER_TRILL: {
        double c = dur, shut = c * 0.375;
        /* [tr + shut, tr + c + shut) is one whole cycle, closure to closure. */
        hold = tr + c + shut;
        loop = c;
        tr_at(tr_at(w, 0, 0), tr, 1);
        tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(tr_at(av, 0, v0), tr, 0.7), tr + 3 * k, 0.12),
              tr + shut, 0.12), tr + shut + 3 * k, 0.7), tr + c - 3 * k, 0.7), tr + c, 0.12), tr + c + shut, 0.12);
        if (glot) {
            end = tr + c + shut + gs;
        } else {
            tr_at(av, tr + c + shut + 3 * k, 0.6);
            end = tr + c + shut + 35 * k;
        }
        tr_at(av, end, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, z0), tr, 0);
        break;
    }
    default:
        tr_at(w, 0, 0);
        tr_at(tr_at(av, 0, v0), 6 * k, 0);
        tr_at(ah, 0, 0); tr_at(af, 0, 0); tr_at(tr_at(nz, 0, z0), 6 * k, 0);
        end = 6 * k;
        hold = end;
        break;
    }
    sg->end = end;
    sg->hold = dmin(hold, end);
    sg->loop = hold < end ? loop : 0;
    tr_close(w, end, 1);
    tr_close(av, end, 0);
    tr_close(ah, end, 0);
    tr_close(af, end, 0);
    tr_close(nz, end, 0);
}

/* The coda tracks — a BREATH row's ([ʔ͡h]) frication is its aspiration. */
static void coda_tracks(const TaudConsonant *r, double k, double v0, double z0, int art, TaudFormantSegment *sg)
{
    coda_tracks_of(r, k, v0, z0, art, sg);
    if (r->breath) breathed(sg);
}

/* A coda after a nucleus that hisses (afterRelease): the hiss lets go over
 * `rel` ms first, voicing v0 and nasality z0 held, then the coda's tracks. */
static void shift_track(TaudFormantTrack *t, double rel, double v)
{
    TaudFormantTrack out;
    int i;
    out.n = 0;
    tr_push(&out, 0, v);
    for (i = 0; i < t->n; i += 2) tr_push(&out, t->p[i] + rel, t->p[i + 1]);
    *t = out;
}

static void after_release(TaudFormantSegment *sg, double rel, double v0, double a0, double h0, double z0)
{
    sg->end = sg->end + rel;
    sg->hold = sg->hold + rel;
    shift_track(&sg->w, rel, 0);
    shift_track(&sg->av, rel, v0);
    shift_track(&sg->ah, rel, h0);
    shift_track(&sg->af, rel, a0);
    shift_track(&sg->nz, rel, z0);
}

static double timing_scale(int b) { return js_pow(2, (b - 128) / 64.0); }

/* The timing scale of slot `i` (0, 1 the onset, 2 the coda, 3 the glide):
 * the record's, times a lyric syllable's own for the slot. */
static double slot_scale(const TaudFormantPatch *patch, int i)
{
    double k = timing_scale(patch->timing);
    return patch->hasSlotTiming ? k * timing_scale(patch->slotTiming[i]) : k;
}

/* A LYRIC SYLLABLE (spec §5.5.3, "Lyric instruments"): the record's patch
 * `rec` with syllable `syl` of its `ILyr` entry in place — the vowel, whether
 * there is one and whether it is nasalised, the glide, the articulations, R,
 * the three consonants with the noise each reads (the entry's recipes; a
 * consonant with none sounds the generator) and the four timing bytes.
 * Everything else is the record's. Written into `out` IN PLACE, so that a
 * note singing it follows a reload of the record. */
void te_formant_lyric_syllable(const TaudFormantPatch *rec, const TaudLyricSyllable *syl,
                               const TaudLyricEntry *entry, TaudFormantPatch *out)
{
    int i;
    out->srcPtr = rec->srcPtr;
    out->srcInst = rec->srcInst;
    out->front = syl->front & 0xff;
    out->open = syl->open & 0xff;
    out->round = syl->round & 0xff;
    out->track = rec->track;
    out->refNote = syl->vowel ? (rec->refNote != 0 ? rec->refNote : FORMANT_DEFAULT_REF) : 0;
    out->dRefNote = syl->vowel ? rec->dRefNote : 0.0;
    out->nasal = syl->nasal;
    out->glide = rec->glide;
    out->timing = rec->timing;
    out->rangeLo = rec->rangeLo;
    out->rangeHi = rec->rangeHi;
    decode_gr(out, syl->gr & 0xff);
    for (i = 0; i < FORMANT_SLOTS; i++) {
        TaudFormantSlot *s = &out->slots[i];
        int cons = syl->cons[i];
        const TaudLyricRecipe *r = cons != 0 && entry->recipeOf[cons] >= 0 ? &entry->recipes[entry->recipeOf[cons]] : NULL;
        s->cons = cons;
        s->ptr = r != NULL ? r->ptr & 0xffffff : 0;
        s->len = r != NULL ? r->len & 0xffff : 0;
        s->offset = r != NULL ? r->offset & 0xffff : 0;
        s->rate = r != NULL ? r->rate & 0xffff : 0;
        s->tilt = r != NULL ? r->tilt : 0;
        s->gain = r != NULL ? r->gain & 0xff : 0;
    }
    out->hasSlotTiming = true;
    for (i = 0; i < 4; i++) out->slotTiming[i] = syl->timing[i];
    out->lyricOf = rec;
}

/* ── loudness tables ── */

#define NORM_EVERY 8
#define NORM_MIN (1.0 / 256)
#define NORM_MAX 16
#define FORMANT_LEVEL 0.5773502691896258
#define SOURCE_GAIN_MAX 16
#define NOISE_SEED 0x9e3779b9u
#define SOURCE_MEASURE_MAX 16384
#define SOURCE_WINDOW 1024
#define FNP 270
#define BNP 100
#define BNZ 100
#define LOUDNESS_PHON 60

static const double ISO226_F[ISO226_N] = { 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
    500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500 };
static const double ISO226_AF[ISO226_N] = { 0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349,
    0.330, 0.315, 0.301, 0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242,
    0.242, 0.245, 0.254, 0.271, 0.301 };
static const double ISO226_LU[ISO226_N] = { -31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5,
    -3.1, -2.0, -1.1, -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1 };
static const double ISO226_TF[ISO226_N] = { 78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4,
    11.4, 8.6, 6.2, 4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3 };
#define ELW_LAST (ISO226_N - 1)

/* The equal-loudness weighting in dB at f, searching up from index *j. */
double te_elw_db(const TaudFormantTables *T, double f, int *j)
{
    double lf = js_log2(f), u;
    int i = *j;
    if (!(lf > T->elwLogF[0])) { *j = 0; return T->elwDb[0]; }
    if (lf >= T->elwLogF[ELW_LAST]) { *j = ELW_LAST; return T->elwDb[ELW_LAST]; }
    while (lf > T->elwLogF[i + 1]) i++;
    *j = i;
    u = (lf - T->elwLogF[i]) / (T->elwLogF[i + 1] - T->elwLogF[i]);
    return T->elwDb[i] + u * (T->elwDb[i + 1] - T->elwDb[i]);
}

void te_formant_tables_init(TaudFormantTables *T, int rate)
{
    double band;
    int i, h, c, n;
    for (h = 0; h < 4; h++)
        for (c = 0; c < 4; c++)
            for (n = 0; n < 2; n++) T->logCard[h][c][n] = js_log(CARDINAL_VOWELS[h][c][n]);
    /* The tongue a secondary articulation holds behind a consonant (ART_F):
     * ART_PALATAL [i]'s, ART_DARK the back of the tongue drawn back, midway
     * between [ʌ] and [ɑ]. Its formants at a man's size. */
    vowel_formants(T, 255, 0, 0, T->artF[ART_PALATAL], false);
    vowel_formants(T, 0, 212, 0, T->artF[ART_DARK], false);
    for (i = 0; i < ISO226_N; i++) {
        double af = ISO226_AF[i], lu = ISO226_LU[i], tf = ISO226_TF[i];
        double A = 4.47e-3 * (js_pow(10, 0.025 * LOUDNESS_PHON) - 1.15) +
                   js_pow(0.4 * js_pow(10, (tf + lu) / 10 - 9), af);
        T->elwLogF[i] = js_log2(ISO226_F[i]);
        T->elwDb[i] = -((10 / af) * js_log10(A) - lu + 94);
    }
    band = js_pow(2, 1.0 / 12) - js_pow(2, -1.0 / 12);
    T->bankN = 0;
    T->bankRef = 0;
    for (i = 0; 50 * js_pow(2, i / 6.0) <= 0.45 * rate && i < BANK_GRID_MAX; i++) {
        double f = 50 * js_pow(2, i / 6.0), om;
        int j = 0;
        T->bankW[i] = js_pow(10, te_elw_db(T, f, &j) / 10) * f * band;
        om = (2 * PI * f) / rate;
        T->bankC1[i] = js_cos(om);
        T->bankS1[i] = js_sin(om);
        T->bankC2[i] = js_cos(2 * om);
        T->bankS2[i] = js_sin(2 * om);
        T->bankN = i + 1;
    }
    for (i = 0; i < T->bankN; i++) T->bankRef = T->bankRef + T->bankW[i];
}

static const double PAR_F[3] = { 3300, 3750, 4900 }, PAR_B[3] = { 250, 200, 1000 };

/* ── the sounding voice ── */

static void start_noise(const TaudEngine *e, TaudFormantState *st, const TaudFormantSegment *seg);

static void next_start_of(const TaudFormantSegment *s, NextStart *nx)
{
    nx->av = s->av.p[1]; nx->ah = s->ah.p[1]; nx->af = s->af.p[1]; nx->nz = s->nz.p[1];
}

/* The articulation blendInto gives a segment (tractArt): a secondary
 * articulation's tongue — the glottal one changes the tracks, not the tract. */
static int tract_art(int a) { return a == ART_PALATAL || a == ART_DARK ? a : ART_NONE; }

/* A fresh tract, as `new FormantState()` leaves one. */
void te_formant_state_init(TaudFormantState *st)
{
    memset(st, 0, sizeof *st);
    st->phase = PHASE_DONE;
    st->fresh = true;
    st->upd = 48;
    st->nv = 1.0; st->nvGoal = 1.0;
    st->sg = 1.0;
    st->sgDue = true;
    st->nGain = 1.0;
    st->nSeed = NOISE_SEED;
    st->nucleus = -1;
    st->srcKind = CHIP_NONE;
    st->glideOv = -1;
}

/* The coda a record gives a note (buildCoda): slot 2's consonant, from the
 * vowel — or, in a syllable with no vowel, from its nucleus as it holds, a
 * hissing nucleus letting its hiss go first. False with no coda consonant.
 * `vz` is how nasalised the vowel is as the coda leaves it (0…1), when it has
 * one. */
static bool build_coda(TaudFormantState *st, const TaudFormantPatch *patch, double k, double vz)
{
    const TaudConsonant *cr = consonant(patch->slots[2].cons);
    TaudFormantSegment *seg = &st->coda;
    const TaudFormantSegment *nuc;
    int art;
    if (cr == NULL) return false;
    art = patch->codaArt;
    seg->row = cr;
    seg->slot = patch->slots[2];
    seg->next = -1;
    seg->art = art == CODA_DARK ? ART_DARK : ART_NONE;
    seg->noiseAt = 0;
    seg->prevRow = NULL;
    seg->prevArt = ART_NONE;
    if (st->nucleus < 0) {
        double z0 = has_vowel(patch) ? vz : 0;
        st->codaZ0 = z0;
        coda_tracks(cr, k, 1, z0, art, seg);
        return true;
    }
    nuc = &st->onset[st->nucleus];
    {
        double v0 = nuc->av.p[nuc->av.n - 1], z0 = nuc->nz.p[nuc->nz.n - 1];
        double a0 = nuc->af.p[nuc->af.n - 1], h0 = nuc->ah.p[nuc->ah.n - 1];
        bool hiss = a0 > 0 || h0 > 0;
        coda_tracks(cr, k, v0, z0, art, seg);
        if (hiss) {
            after_release(seg, NUCLEUS_RELEASE * k, v0, a0, h0, z0);
            seg->noiseAt = NUCLEUS_RELEASE * k;
            seg->prevRow = nuc->row;
            seg->prevArt = nuc->art;
        }
    }
    return true;
}

/* The coda of a syllable with nothing to say: over before it starts. */
static void silent_coda(TaudFormantSegment *seg)
{
    memset(seg, 0, sizeof *seg);
    seg->next = -1;
    tr_push(&seg->w, 0, 1);
    tr_push(&seg->av, 0, 0);
    tr_push(&seg->ah, 0, 0);
    tr_push(&seg->af, 0, 0);
    tr_push(&seg->nz, 0, 0);
}

/* The note's glide time in ms (glideMsOf): what S $91xx gave it, or its
 * record's. */
static double glide_ms_of(const TaudFormantState *st)
{
    return (st->glideOv >= 0 ? st->glideOv : st->patch != NULL ? st->patch->glide : 0) * 2;
}

/* A note's amount as its trigger starts it: its record's bit (amtReset). */
static void amt_reset(TaudFormantAmount *a, bool on)
{
    a->own = false; a->v = on ? 1 : 0; a->to = a->v; a->step = 0.0; a->left = 0.0; a->rejoin = false;
}

/* Set an amount gliding to `to` over the note's glide time — at once on the
 * note's first row, or with a glide of 0 (amtGlideTo). */
static void amt_glide_to(const TaudFormantState *st, TaudFormantAmount *a, double to)
{
    double ms = glide_ms_of(st);
    a->to = to;
    if (st->fresh || ms <= 0) { a->v = to; a->left = 0.0; return; }
    a->step = (to - a->v) / ms;
    a->left = ms;
}

/* An instrument change: the amount glides to the new record's, which the note
 * then follows (amtRelatch). */
static void amt_relatch(const TaudFormantState *st, TaudFormantAmount *a, bool on)
{
    amt_glide_to(st, a, on ? 1 : 0);
    if (a->left > 0) { a->own = true; a->rejoin = true; }
    else { a->own = false; a->rejoin = false; }
}

/* One control update of an amount: a glide's step (the last landing exactly),
 * or the record's bit while the note has none of its own (amtAdvance). */
static void amt_advance(TaudFormantAmount *a, double dt, bool on)
{
    if (a->left > 0) {
        if (a->left <= dt) {
            a->v = a->to; a->left = 0.0;
            if (a->rejoin) { a->own = false; a->rejoin = false; }
        } else {
            a->v += a->step * dt;
            a->left -= dt;
        }
    } else if (!a->own) {
        a->v = on ? 1 : 0;
    }
}

/* Is the vowel the onset heads for nasalised, at all? The note's own nasality
 * when it has one, else its record's bit (nasalOf). */
static bool nasal_of(const TaudFormantState *st, const TaudFormantPatch *patch)
{
    return st->nasAmt.own ? st->nasAmt.v > 0 : patch->nasal;
}

/* Note-on: build the syllable. `keep` says the syllable again for the SAME
 * note (Q's retrigger, or an S $90kx on the trigger row that changed the
 * nasality the onset heads for): what S $9xxx gave the note stays its own,
 * its glides stopping where they stand, as te_formant_restart keeps the
 * vowel. */
void te_formant_note_on(TaudEngine *e, TaudFormantState *st, const TaudFormantPatch *patch, bool keep)
{
    bool vowel = has_vowel(patch), coda = true, nasal;
    const TaudConsonant *rows[2];
    int rowSlot[2], nrows = 0, i, next;
    NextStart nx;
    st->patch = patch;
    if (!keep) {
        amt_reset(&st->nasAmt, patch->nasal);
        amt_reset(&st->rhoAmt, patch->rhotic);
        st->glideOv = -1;
        st->codaCall = false;
    } else {
        st->nasAmt.left = 0.0; st->nasAmt.rejoin = false;
        st->rhoAmt.left = 0.0; st->rhoAmt.rejoin = false;
    }
    st->atVowel = false;
    for (i = 0; i < 2; i++) {
        const TaudConsonant *r = consonant(patch->slots[i].cons);
        if (r != NULL) { rows[nrows] = r; rowSlot[nrows] = i; nrows++; }
    }
    /* With no vowel, the last onset consonant is the nucleus — or, with no
     * onset, the coda's consonant, which then leaves no coda after it. */
    if (!vowel && nrows == 0) {
        const TaudConsonant *r = consonant(patch->slots[2].cons);
        if (r != NULL) { rows[nrows] = r; rowSlot[nrows] = 2; nrows++; coda = false; }
    }
    /* The glide, if any; a syllable with no vowel has none. */
    st->sv = vowel ? patch->semivowel : 0;
    st->svT = 0.0;
    nasal = vowel && nasal_of(st, patch);
    if (st->sv != 0) {
        const TaudConsonant *r = consonant(SEMIVOWELS[st->sv].row);
        double k = slot_scale(patch, 3);
        double dur = r->dur * k, tr = r->trans * k;
        st->svEnd = dur + tr;
        tr_reset(&st->svW);
        tr_close(tr_at(tr_at(tr_at(&st->svW, 0, 1), dur, 1), dur + tr, 0), st->svEnd, 0);
        tr_reset(&st->svAv);
        tr_close(tr_at(tr_at(tr_at(&st->svAv, 0, r->av), dur, r->av), dur + tr * 0.5, 1), st->svEnd, 1);
        nx.av = st->svAv.p[1]; nx.ah = 0; nx.af = 0; nx.nz = nasal ? 1 : 0;
    } else {
        nx.av = 1; nx.ah = 0; nx.af = 0; nx.nz = nasal ? 1 : 0;
    }
    /* Built back to front; the last consonant carries the secondary
     * articulation, and without a vowel it is the nucleus, and holds. */
    next = -1;
    for (i = nrows - 1; i >= 0; i--) {
        TaudFormantSegment *s = &st->onset[i];
        int art = i == nrows - 1 ? patch->secondary : ART_NONE;
        double k = slot_scale(patch, rowSlot[i]);
        s->row = rows[i];
        s->slot = patch->slots[rowSlot[i]];
        if (!vowel && i == nrows - 1) nucleus_tracks(rows[i], i == 0, k, art, s);
        else onset_tracks(rows[i], i == 0, &nx, k, art, s);
        s->art = tract_art(art);
        s->hold = s->end;
        s->noiseAt = 0;
        s->prevRow = NULL;
        s->prevArt = ART_NONE;
        s->next = next;
        next = i;
        next_start_of(s, &nx);
    }
    st->onsetCount = nrows;
    st->seg = 0;
    st->nucleus = !vowel && nrows > 0 ? nrows - 1 : -1;
    st->held = false;
    st->hasCoda = coda ? build_coda(st, patch, slot_scale(patch, 2), nasal ? st->nasAmt.v : 0) : false;
    st->phase = nrows > 0 ? PHASE_ONSET : PHASE_VOWEL;
    st->t = 0.0;
    st->codaVeto = false;
    st->codaNoise = false;
    st->fresh = true;
    st->upd = imax(1, (int)js_round(e->rate / 1000.0));
    st->ctl = 0;
    st->normCount = 0;
    st->ownVowel = false; st->rejoin = false;
    st->vFront = patch->front; st->vOpen = patch->open; st->vRound = patch->round;
    st->glideLeft = 0.0;
    st->sgDue = true;
    st->av = 0.0; st->avStep = 0.0; st->ah = 0.0; st->ahStep = 0.0; st->af = 0.0; st->afStep = 0.0;
    st->nv = 1.0; st->nvStep = 0.0; st->nvGoal = 1.0;
    memset(st->cy, 0, sizeof st->cy);
    memset(st->by, 0, sizeof st->by);
    st->nOn = false; st->nZ = 0.0;
    /* No vowel and no consonant: nothing to say. The syllable is over at once. */
    if (!vowel && nrows == 0) {
        st->phase = PHASE_CODA;
        silent_coda(&st->coda);
        st->hasCoda = true;
        st->codaNoise = true;
    }
    if (st->phase == PHASE_ONSET) start_noise(e, st, &st->onset[0]);
}

/* ── the glottal source as a chip channel ── */

/* The instrument a formant instrument is sung from (formantChipSource), or
 * NULL when it sings with its own sample: the header names none, or itself,
 * or an instrument that is not a chip one. */
const TaudInst *te_formant_chip_source(const TaudEngine *e, const TaudInst *inst)
{
    int i = inst->formant->srcInst;
    const TaudInst *src;
    if (i < 1 || i > 1023 || i == inst->index) return NULL;
    src = &e->instruments[i];
    return inst_is_chip(src) ? src : NULL;
}

/* The rate a chip source plays the part of the sample's rate with: its own
 * C2SPD, 0 reading as the tracker convention. */
int te_formant_chip_rate(const TaudInst *src)
{
    return src->samplingRate == 0 ? OPL_C4_RATE : src->samplingRate;
}

static int chip_kind_of(const TaudInst *chip) { return chip->opl != NULL ? CHIP_OPL : CHIP_PSG; }

static void chip_key_on(TaudFormantState *st, bool carry)
{
    if (st->srcKind == CHIP_OPL) te_opl_key_on(&st->srcOpl, st->srcOpl.patch, carry);
    else te_psg_key_on(&st->srcPsg, st->srcPsg.patch, carry);
}

/* Key the note's glottal source (formantKeySource): a chip channel playing
 * `chip`'s patch from silence — or none, the sample being the source. A
 * channel of the same kind is reused, as the JS reuses its state object. */
void te_formant_key_source(TaudFormantState *st, const TaudInst *chip)
{
    int kind;
    if (chip == NULL) { st->srcKind = CHIP_NONE; return; }
    kind = chip_kind_of(chip);
    if (st->srcKind != kind) {
        st->srcKind = kind;
        if (kind == CHIP_OPL) te_opl_state_init(&st->srcOpl);
        else te_psg_state_init(&st->srcPsg);
    }
    if (kind == CHIP_OPL) te_opl_key_on(&st->srcOpl, chip->opl, false);
    else te_psg_key_on(&st->srcPsg, chip->psg, false);
    st->sgDue = true;
}

/* An instrument byte without a retrigger hands the note a new record's source
 * (formantRelatchSource): a channel already sounding takes the new patch
 * where it stands; otherwise as a fresh key-on. */
void te_formant_relatch_source(TaudFormantState *st, const TaudInst *chip)
{
    if (chip == NULL) { st->srcKind = CHIP_NONE; return; }
    if (st->srcKind != chip_kind_of(chip)) { te_formant_key_source(st, chip); return; }
    if (st->srcKind == CHIP_OPL) { st->srcOpl.patch = chip->opl; st->srcOpl.gen = -1; }
    else { st->srcPsg.patch = chip->psg; st->srcPsg.gen = -1; }
    st->sgDue = true;
}

void te_formant_restart(TaudEngine *e, TaudFormantState *st)
{
    double f, o, r, sg, sm;
    bool own, due;
    if (st->patch == NULL) return;
    f = st->vFront; o = st->vOpen; r = st->vRound; own = st->ownVowel;
    sg = st->sg; sm = st->sm; due = st->sgDue;
    te_formant_note_on(e, st, st->patch, true);
    st->vFront = f; st->vOpen = o; st->vRound = r; st->ownVowel = own;
    st->sg = sg; st->sm = sm; st->sgDue = due;
    /* A chip source is re-keyed as Q re-keys an OPL note: the attack from
     * where each envelope stands, the phase from zero (§5.5.2). */
    if (st->srcKind == CHIP_OPL ? st->srcOpl.patch != NULL : st->srcKind == CHIP_PSG && st->srcPsg.patch != NULL) {
        chip_key_on(st, true);
    }
}

static void formant_glide_to(TaudFormantState *st, double open, double front, double round)
{
    double ms = glide_ms_of(st);
    if (st->fresh || ms <= 0) {
        st->vOpen = open; st->vFront = front; st->vRound = round;
        st->glideLeft = 0.0;
        return;
    }
    st->gOpen = (open - st->vOpen) / ms;
    st->gFront = (front - st->vFront) / ms;
    st->gRound = (round - st->vRound) / ms;
    st->tOpen = open; st->tFront = front; st->tRound = round;
    st->glideLeft = ms;
}

void te_formant_relatch(TaudEngine *e, TaudFormantState *st, const TaudFormantPatch *patch)
{
    st->patch = patch;
    st->sgDue = true;
    formant_glide_to(st, patch->open, patch->front, patch->round);
    if (st->glideLeft > 0) { st->ownVowel = true; st->rejoin = true; }
    else { st->ownVowel = false; st->rejoin = false; }
    /* The nasalisation and the r-colouring go with the vowel (item 292). */
    amt_relatch(st, &st->nasAmt, patch->nasal);
    amt_relatch(st, &st->rhoAmt, patch->rhotic);
    if (st->phase == PHASE_ONSET || st->phase == PHASE_VOWEL) {
        st->hasCoda = build_coda(st, patch, slot_scale(patch, 2), st->nasAmt.v);
    }
}

/* A sampled note handed a formant instrument mid-note: the tract starts at
 * the vowel — or a syllable with no vowel at its nucleus, holding — with the
 * coda ready. */
void te_formant_start_at_vowel(TaudEngine *e, TaudFormantState *st, const TaudFormantPatch *patch, bool keep)
{
    te_formant_note_on(e, st, patch, keep);
    st->atVowel = true;
    st->sv = 0;
    if (st->phase == PHASE_CODA) return;   /* nothing to say */
    if (st->nucleus >= 0) {
        if (st->nucleus != 0) st->onset[0] = st->onset[st->nucleus];
        st->onset[0].next = -1;
        st->nucleus = 0;
        st->onsetCount = 1;
        st->seg = 0;
        st->phase = PHASE_ONSET;
        st->t = st->onset[0].end;
        st->held = true;
        start_noise(e, st, &st->onset[0]);
        return;
    }
    st->onsetCount = 0;
    st->seg = 0;
    st->phase = PHASE_VOWEL;
    st->nOn = false;
}

void te_formant_set_vowel(TaudFormantState *st, int f, int g, int r)
{
    st->ownVowel = true;
    st->rejoin = false;
    formant_glide_to(st, (f & 15) * 17, (g & 15) * 17, (r & 15) * 17);
}

/* S $91xx: the note's glide time, re-timing what is under way. */
static void formant_set_glide(TaudFormantState *st, int units)
{
    double ms = units * 2;
    int i;
    st->glideOv = units;
    if (st->glideLeft > 0) {
        if (ms <= 0) {
            st->vOpen = st->tOpen; st->vFront = st->tFront; st->vRound = st->tRound;
            st->glideLeft = 0.0;
            if (st->rejoin) { st->ownVowel = false; st->rejoin = false; }
        } else {
            st->gOpen = (st->tOpen - st->vOpen) / ms;
            st->gFront = (st->tFront - st->vFront) / ms;
            st->gRound = (st->tRound - st->vRound) / ms;
            st->glideLeft = ms;
        }
    }
    for (i = 0; i < 2; i++) {
        TaudFormantAmount *a = i == 0 ? &st->nasAmt : &st->rhoAmt;
        if (a->left <= 0) continue;
        if (ms <= 0) {
            a->v = a->to; a->left = 0.0;
            if (a->rejoin) { a->own = false; a->rejoin = false; }
        } else {
            a->step = (a->to - a->v) / ms;
            a->left = ms;
        }
    }
}

/*
 * S $9xxx, formant control (item 292), `arg` the low twelve bits:
 *
 *  - $0kx, x = 00nr — the vowel nasalised (n) and r-coloured (r), SET as
 *    written, each gliding there over the note's glide time as the vowel does
 *    (at once on the trigger row); k = 1 also moves into the coda now, as a
 *    key-off would, without keying the voice off — and HOLDS its consonant
 *    while the key is held; the key-off then lets it go.
 *  - $1xx — the note's glide time, xx in 2 ms units: every glide still under
 *    way covers what is left of it in the new time, and every later one
 *    takes it. The trigger row's own glides are jumps whatever it says.
 *
 * Every other argument is RESERVED and does nothing. All of it is the NOTE's:
 * the next trigger starts from the record again; Q's retrigger keeps it.
 */
void te_formant_command(TaudEngine *e, TaudFormantState *st, int arg)
{
    int sel;
    bool was;
    if (st->patch == NULL) return;
    sel = (arg >> 8) & 0xf;
    if (sel == 1) { formant_set_glide(st, arg & 0xff); return; }
    if (sel != 0 || (arg & 0xec) != 0) return;
    was = nasal_of(st, st->patch);
    st->nasAmt.own = true; st->nasAmt.rejoin = false;
    amt_glide_to(st, &st->nasAmt, (arg & 2) != 0 ? 1 : 0);
    st->rhoAmt.own = true; st->rhoAmt.rejoin = false;
    amt_glide_to(st, &st->rhoAmt, (arg & 1) != 0 ? 1 : 0);
    /* On the trigger row the onset already heads for the vowel it will meet:
     * a changed nasality builds the syllable again, its velum lowered or not. */
    if (st->fresh && nasal_of(st, st->patch) != was && has_vowel(st->patch)) {
        double f = st->vFront, o = st->vOpen, r = st->vRound;
        bool own = st->ownVowel;
        if (st->atVowel) te_formant_start_at_vowel(e, st, st->patch, true);
        else te_formant_note_on(e, st, st->patch, true);
        st->vFront = f; st->vOpen = o; st->vRound = r; st->ownVowel = own;
    }
    if ((arg & 0x10) != 0) st->codaCall = true;
}

static void start_noise(const TaudEngine *e, TaudFormantState *st, const TaudFormantSegment *seg)
{
    const TaudFormantSlot *s = &seg->slot;
    int64_t span, base;
    st->nOn = false;
    if (!consonant_needs_noise(seg->row)) return;
    span = (int64_t)s->len - s->offset;
    base = (int64_t)s->ptr + s->offset;
    if (base + span > SAMPLE_BIN_TOTAL) span = SAMPLE_BIN_TOTAL - base;
    st->nGen = span < 2 || s->rate <= 0;
    st->nOn = true;
    st->nBase = base;
    st->nSpan = (int)span;
    st->nPos = 0.0;
    st->nStep = (double)s->rate / e->rate;
    st->nSeed = NOISE_SEED;
    st->nTilt = s->tilt;
    st->nTiltC = fabs((double)s->tilt) / 128;
    st->nGain = te_atten_gain_of(s->gain);
    st->nZ = 0.0;
}

static double pcm_u8(const TaudEngine *e, int64_t p) { return e->pcmU8[te_pool_at(e, p)]; }

static double read_noise(const TaudEngine *e, TaudFormantState *st)
{
    double x;
    if (st->nGen) {
        uint32_t r = st->nSeed;
        r ^= r << 13; r ^= r >> 17; r ^= r << 5;
        st->nSeed = r;
        x = (st->nSeed / 4294967296.0) * 2 - 1;
    } else {
        int64_t i = (int64_t)st->nPos;
        double fr = st->nPos - (double)i;
        double a = pcm_u8(e, st->nBase + i);
        double b = pcm_u8(e, st->nBase + (i + 1 < st->nSpan ? i + 1 : 0));
        x = a + (b - a) * fr;
        st->nPos += st->nStep;
        while (st->nPos >= st->nSpan) st->nPos -= st->nSpan;
    }
    if (st->nTilt > 0) {
        double y = x - st->nTiltC * st->nZ;
        st->nZ = x;
        x = y;
    } else if (st->nTilt < 0) {
        st->nZ = (1 - st->nTiltC) * x + st->nTiltC * st->nZ;
        x = st->nZ;
    }
    return x * st->nGain;
}

static void set_res(const TaudEngine *e, double *a, int i, double f, double bw)
{
    double T = 1.0 / e->rate;
    double r = js_exp(-PI * bw * T);
    double c = -(r * r);
    double b = 2 * r * js_cos(2 * PI * f * T);
    a[i] = 1 - b - c;
    a[i + 1] = b;
    a[i + 2] = c;
}

static void set_peak_res(const TaudEngine *e, double *a, int i, double f, double bw)
{
    double b, c, w, re, im;
    set_res(e, a, i, f, bw);
    b = a[i + 1]; c = a[i + 2];
    w = (2 * PI * f) / e->rate;
    re = 1 - b * js_cos(w) - c * js_cos(2 * w);
    im = b * js_sin(w) + c * js_sin(2 * w);
    a[i] = sqrt(re * re + im * im);
}

static double bank_norm(const TaudFormantTables *G, const double *bank, const double *g)
{
    double p = 0.0;
    int i, j;
    for (i = 0; i < G->bankN; i++) {
        double re = g[5], im = 0.0;
        for (j = 0; j < 5; j++) {
            double A, b, c, dr, di, k;
            if (g[j] == 0) continue;
            A = bank[j * 3]; b = bank[j * 3 + 1]; c = bank[j * 3 + 2];
            dr = 1 - b * G->bankC1[i] - c * G->bankC2[i];
            di = b * G->bankS1[i] + c * G->bankS2[i];
            k = (g[j] * A) / (dr * dr + di * di);
            re += k * dr;
            im -= k * di;
        }
        p += G->bankW[i] * (re * re + im * im);
    }
    return p > 0 ? sqrt(G->bankRef / p) : 0.0;
}

static double cascade_norm(const TaudEngine *e, const double *co, double f0, const double *w, int wK)
{
    const TaudFormantTables *T = &e->formantTables;
    double R = e->rate, w0, c1, s1, ck, sk, p = 0.0, ref = 0.0, g;
    int K, k, j = 0;
    if (!(f0 > 0)) return 1.0;
    K = (int)dmax(1, dmin(wK, floor((0.45 * R) / f0)));
    w0 = (2 * PI * f0) / R;
    c1 = js_cos(w0); s1 = js_sin(w0);
    ck = c1; sk = s1;
    for (k = 1; k <= K; k++) {
        double c2 = ck * ck - sk * sk, s2 = 2 * sk * ck;
        double h = 1.0, lw, nc;
        int n;
        for (n = 0; n < 7; n++) {
            double A = co[n * 3], b = co[n * 3 + 1], c = co[n * 3 + 2];
            double re = 1 - b * ck - c * c2;
            double im = b * sk + c * s2;
            double gg = (A * A) / (re * re + im * im);
            h *= n == 1 ? 1 / gg : gg;
        }
        lw = w[k] * js_pow(10, te_elw_db(T, k * f0, &j) / 10);
        p += h * lw;
        ref += lw;
        nc = ck * c1 - sk * s1;
        sk = sk * c1 + ck * s1;
        ck = nc;
    }
    g = p > 0 ? sqrt(ref / p) : NORM_MAX;
    return dmin(dmax(g, NORM_MIN), NORM_MAX);
}

/* Mean and AC power of n bytes from p. */
static void ac_of(const TaudEngine *e, int64_t p, int64_t n, double *mean, double *ac)
{
    double sum = 0.0, sq = 0.0, m;
    int64_t i;
    for (i = 0; i < n; i++) {
        double v = pcm_u8(e, p + i);
        sum += v;
        sq += v * v;
    }
    m = sum / n;
    *mean = m;
    *ac = sq / n - m * m;
}

typedef struct { int64_t at, n; double ac; } Loudest;

static Loudest loudest_window(const TaudEngine *e, int64_t p, int64_t n)
{
    Loudest L;
    double mean;
    int64_t o;
    L.at = p; L.n = n > 0 ? n : 0; L.ac = 0.0;
    if (n < 2) return L;
    if (n <= SOURCE_WINDOW) { ac_of(e, p, n, &mean, &L.ac); return L; }
    L.n = SOURCE_WINDOW;
    L.ac = -1.0;
    for (o = 0; ; o += SOURCE_WINDOW >> 1) {
        int64_t q = o < n - SOURCE_WINDOW ? o : n - SOURCE_WINDOW;
        double ac;
        ac_of(e, p + q, SOURCE_WINDOW, &mean, &ac);
        if (ac > L.ac) { L.ac = ac; L.at = p + q; }
        if (q == n - SOURCE_WINDOW) break;
    }
    return L;
}

static void source_gain(const TaudEngine *e, int64_t p, int64_t n, TaudFormantState *st)
{
    double mean, ac;
    st->sm = 0.0;
    st->sg = 1.0;
    if (n < 2) return;
    ac_of(e, p, n, &mean, &ac);
    st->sm = mean;
    if (!(ac > 1e-12)) return;
    st->sg = dmin(dmax(FORMANT_LEVEL / sqrt(ac), 1.0 / SOURCE_GAIN_MAX), SOURCE_GAIN_MAX);
}

static void saw_harmonics(TaudFormantState *st)
{
    int k;
    for (k = 1; k <= NORM_HARMONICS; k++) st->hw[k] = 1.0 / (k * k);
    st->hwK = NORM_HARMONICS;
}

static void source_harmonics(TaudEngine *e, int64_t p, int64_t span, bool whole, double P, TaudFormantState *st)
{
    double *w = st->hw, *x = e->formantTables.dft, mean = 0.0, sum = 0.0;
    int K = P >= 2 ? (int)dmin(NORM_HARMONICS, floor(P / 2)) : 0;
    int64_t N = span < SOURCE_DFT_MAX ? span : SOURCE_DFT_MAX, i;
    bool exact;
    double m;
    int k;
    TaudFormantTables *T = &e->formantTables;
    uint32_t h = 0x811c9dc5u;
    int j;
    if (K < 1 || N < 2) { saw_harmonics(st); return; }
    exact = whole && span <= SOURCE_DFT_MAX;
    m = exact ? dmax(1, js_round(N / P)) : 0;
    /* A pure memo, keyed as the JS keys it, so a chord pays for one. */
    for (i = 0; i < N; i++) h = (h ^ (uint32_t)te_pool_at(e, p + i)) * 16777619u;
    for (j = 0; j < T->memoCount; j++) {
        if (T->memo[j].p == p && T->memo[j].N == N && T->memo[j].m == m && T->memo[j].P == P && T->memo[j].h == h) {
            memcpy(w, T->memo[j].w, (size_t)(T->memo[j].K + 1) * sizeof *w);
            st->hwK = T->memo[j].K;
            return;
        }
    }
    for (i = 0; i < N; i++) mean += pcm_u8(e, p + i);
    mean /= N;
    for (i = 0; i < N; i++) {
        double v = pcm_u8(e, p + i) - mean;
        x[i] = exact ? v : v * (0.5 - 0.5 * js_cos((2 * PI * i) / N));
    }
    for (k = 1; k <= K; k++) {
        double om = exact ? (2 * PI * k * m) / N : (2 * PI * k) / P;
        double c1 = js_cos(om), s1 = js_sin(om);
        double c = 1.0, s = 0.0, re = 0.0, im = 0.0;
        for (i = 0; i < N; i++) {
            double nc;
            re += x[i] * c;
            im -= x[i] * s;
            nc = c * c1 - s * s1;
            s = s * c1 + c * s1;
            c = nc;
        }
        w[k] = re * re + im * im;
        sum += w[k];
    }
    if (!(sum > 0)) { saw_harmonics(st); return; }
    st->hwK = K;
    if (T->memoCount >= 32) T->memoCount = 0;
    T->memo[T->memoCount].p = p;
    T->memo[T->memoCount].N = N;
    T->memo[T->memoCount].m = m;
    T->memo[T->memoCount].P = P;
    T->memo[T->memoCount].h = h;
    T->memo[T->memoCount].K = K;
    memcpy(T->memo[T->memoCount].w, w, (size_t)(K + 1) * sizeof *w);
    T->memoCount++;
}

static void measure_chip_source(TaudEngine *e, const TaudVoice *voice, TaudFormantState *st);

static void measure_source(TaudEngine *e, const TaudVoice *voice, TaudFormantState *st)
{
    int mode = voice->activeLoopMode & 3;
    bool looped = (mode == 1 || mode == 2) && voice->activeSampleLoopEnd > voice->activeSampleLoopStart;
    int64_t base = voice->activeSamplePtr;
    int64_t lim = SAMPLE_BIN_TOTAL - base;
    int64_t p0 = voice->activeSamplePlayStart, at, n;
    bool whole = false;
    if (st->srcKind != CHIP_NONE) { measure_chip_source(e, voice, st); return; }
#define CUT(x) ((int64_t)dmax(0, dmin(dmin((double)(x), voice->activeSampleLength), (double)lim)))
    if (looped) {
        int64_t a = voice->activeSampleLoopStart, preN;
        at = base + a;
        n = CUT(voice->activeSampleLoopEnd) - a;
        whole = n == voice->activeSampleLoopEnd - a;
        preN = CUT(a) - p0;
        if (preN > SOURCE_MEASURE_MAX) preN = SOURCE_MEASURE_MAX;
        if (preN >= 2 && n >= 2) {
            double mean, loopAc;
            Loudest w;
            ac_of(e, at, n < SOURCE_MEASURE_MAX ? n : SOURCE_MEASURE_MAX, &mean, &loopAc);
            w = loudest_window(e, base + p0, preN);
            if (w.ac > loopAc) { at = w.at; n = w.n; whole = false; }
        }
    } else {
        int64_t len = CUT(voice->activeSampleLength) - p0;
        Loudest w = loudest_window(e, base + p0, len < SOURCE_MEASURE_MAX ? len : SOURCE_MEASURE_MAX);
        at = w.at; n = w.n;
    }
#undef CUT
    source_gain(e, at, n < SOURCE_MEASURE_MAX ? n : SOURCE_MEASURE_MAX, st);
    source_harmonics(e, at, n, whole, voice->activeSamplingRate / LINEAR_FREQ_C4_HZ, st);
}

#define CHIP_MEASURE 4096

/* measureSource for a source that is a chip channel (measureChipSource): the
 * note's patch run apart — from key-on, at the note's rate, at unity volume,
 * on a channel of its own — for CHIP_MEASURE output frames, measured as a
 * one-shot is: the gain from the loudest window, its harmonics from the same
 * window, Hann-windowed and read at k ÷ P cycles a frame. */
static void measure_chip_source(TaudEngine *e, const TaudVoice *voice, TaudFormantState *st)
{
    TaudFormantTables *T = &e->formantTables;
    const void *patch = st->srcKind == CHIP_OPL ? (const void *)st->srcOpl.patch : (const void *)st->srcPsg.patch;
    int gen = st->srcKind == CHIP_OPL ? st->srcOpl.patch->gen : st->srcPsg.patch->gen;
    int rtGen = st->srcKind == CHIP_PSG ? st->srcPsg.patch->rtGen : 0;
    double pr = voice->snapPlaybackRate ? voice->playbackRate : voice->currentPlaybackRate;
    double *x = T->chipBuf, *w = st->hw, *y = T->dft;
    double best = -1.0, mean, ac, P, sum = 0.0;
    int at = 0, o, i, j, K;
    /* A pure memo, keyed as the JS keys it: the patch, its decode (and a PSG
     * patch's overlay), the rate. */
    for (j = 0; j < T->chipMemoCount; j++) {
        if (T->chipMemo[j].patch == patch && T->chipMemo[j].kind == st->srcKind && T->chipMemo[j].gen == gen &&
            T->chipMemo[j].rtGen == rtGen && T->chipMemo[j].pr == pr) {
            st->sm = T->chipMemo[j].sm;
            st->sg = T->chipMemo[j].sg;
            memcpy(w, T->chipMemo[j].w, (size_t)(T->chipMemo[j].K + 1) * sizeof *w);
            st->hwK = T->chipMemo[j].K;
            return;
        }
    }
    if (st->srcKind == CHIP_PSG) {
        /* A PSG pair keeps its internal status across key-ons, so it is
         * measured from rest, as a fresh lane meets it. */
        TaudPsgState psg;
        te_psg_state_init(&psg);
        te_psg_key_on(&psg, st->srcPsg.patch, false);
        for (i = 0; i < CHIP_MEASURE; i++) x[i] = te_psg_render(e, &psg, i, pr, false);
    } else {
        TaudOplState opl;
        te_opl_state_init(&opl);
        te_opl_key_on(&opl, st->srcOpl.patch, false);
        for (i = 0; i < CHIP_MEASURE; i++) x[i] = te_opl_render(e, &opl, i, pr, 1.0, false);
    }
    /* The loudest window, every half window; the first of equals wins. */
    for (o = 0; o + SOURCE_WINDOW <= CHIP_MEASURE; o += SOURCE_WINDOW >> 1) {
        double s1 = 0.0, sq = 0.0, m;
        for (i = 0; i < SOURCE_WINDOW; i++) { double v = x[o + i]; s1 += v; sq += v * v; }
        m = s1 / SOURCE_WINDOW;
        ac = sq / SOURCE_WINDOW - m * m;
        if (ac > best) { best = ac; at = o; }
    }
    {
        double s1 = 0.0, sq = 0.0;
        for (i = 0; i < SOURCE_WINDOW; i++) { double v = x[at + i]; s1 += v; sq += v * v; }
        mean = s1 / SOURCE_WINDOW;
        ac = sq / SOURCE_WINDOW - mean * mean;
    }
    st->sm = mean;
    st->sg = ac > 1e-12 ? dmin(dmax(FORMANT_LEVEL / sqrt(ac), 1.0 / SOURCE_GAIN_MAX), SOURCE_GAIN_MAX) : 1.0;
    /* The period in output frames: the chip sounds pr × rate × 261.63 ÷ 8363 Hz. */
    P = pr > 0 ? OPL_C4_RATE / (pr * LINEAR_FREQ_C4_HZ) : 0;
    K = P >= 2 ? (int)dmin(NORM_HARMONICS, floor(P / 2)) : 0;
    if (K >= 1) {
        int k;
        for (i = 0; i < SOURCE_WINDOW; i++) {
            y[i] = (x[at + i] - mean) * (0.5 - 0.5 * js_cos((2 * PI * i) / SOURCE_WINDOW));
        }
        for (k = 1; k <= K; k++) {
            double om = (2 * PI * k) / P;
            double c1 = js_cos(om), s1 = js_sin(om);
            double c = 1.0, s = 0.0, re = 0.0, im = 0.0;
            for (i = 0; i < SOURCE_WINDOW; i++) {
                double nc;
                re += y[i] * c;
                im -= y[i] * s;
                nc = c * c1 - s * s1;
                s = s * c1 + c * s1;
                c = nc;
            }
            w[k] = re * re + im * im;
            sum += w[k];
        }
    }
    if (sum > 0) st->hwK = K;
    else saw_harmonics(st);
    if (T->chipMemoCount >= 32) T->chipMemoCount = 0;
    T->chipMemo[T->chipMemoCount].patch = patch;
    T->chipMemo[T->chipMemoCount].kind = st->srcKind;
    T->chipMemo[T->chipMemoCount].gen = gen;
    T->chipMemo[T->chipMemoCount].rtGen = rtGen;
    T->chipMemo[T->chipMemoCount].pr = pr;
    T->chipMemo[T->chipMemoCount].sm = st->sm;
    T->chipMemo[T->chipMemoCount].sg = st->sg;
    T->chipMemo[T->chipMemoCount].K = st->hwK;
    memcpy(T->chipMemo[T->chipMemoCount].w, w, (size_t)(st->hwK + 1) * sizeof *w);
    T->chipMemoCount++;
}

static double voice_f0(const TaudEngine *e, const TaudVoice *voice)
{
    int rate = voice->activeSamplingRate;
    double pr = voice->snapPlaybackRate ? voice->playbackRate : voice->currentPlaybackRate;
    /* A chip source sounds what the chip makes of the rate, and the chip reads
     * every rate against the tracker convention's 8363. */
    if (voice->formant != NULL && voice->formant->srcKind != CHIP_NONE) {
        return (pr * e->rate * LINEAR_FREQ_C4_HZ) / OPL_C4_RATE;
    }
    return rate > 0 ? (pr * e->rate * LINEAR_FREQ_C4_HZ) / rate : 0.0;
}

static void seg_amps(const TaudFormantSegment *seg, double t, double *out)
{
    out[0] = track_at(&seg->av, t);
    out[1] = track_at(&seg->ah, t);
    out[2] = track_at(&seg->af, t);
}

/* A velar's F2 and F3 meet as close as the order rule lets two formants
 * come: F3 ÷ F2 = 1.15, about the geometric mean of the two it meets. */
#define PINCH 1.0723805294763609
/* A nasalised vowel's F1 rises this much at a man's size (Klatt 1980 §V.B). */
#define NASAL_F1 100

/* Configure the tract for this update (blendInto): the consonant's own
 * tract blended with the next sound's by w. A secondary articulation `art`
 * (palatal, dark) puts its tongue's F2 and F3 in the consonant's; otherwise a
 * velar takes them from the sound it meets, drawn together about their
 * geometric mean. */
static void blend_into(const TaudEngine *e, const TaudConsonant *row, double w, double s, double *F, double *B,
                       const double *NF, const double *NB, int art)
{
    double c2 = 0, c3 = 0;
    int n;
    if (art != ART_NONE) {
        const double *T = e->formantTables.artF[art];
        c2 = T[1] * s; c3 = T[2] * s;
    } else if (row->dorsal) {
        double p = sqrt(NF[1] * NF[2]);
        c2 = p / PINCH; c3 = p * PINCH;
    }
    for (n = 0; n < 3; n++) {
        double cf = n == 1 && c2 > 0 ? c2 : n == 2 && c3 > 0 ? c3 : row->F[n] > 0 ? row->F[n] * s : NF[n];
        double cb = row->B[n] > 0 ? row->B[n] * s : NB[n];
        F[n] = NF[n] + w * (cf - NF[n]);
        B[n] = NB[n] + w * (cb - NB[n]);
    }
    F[3] = NF[3]; F[4] = NF[4]; B[3] = NB[3]; B[4] = NB[4];
}

/* How front the vowel a consonant meets is, 0 (back) … 1 (front): the vowel's
 * tongue, or the glide's while it sounds (metFront). */
static double met_front(const TaudFormantState *st)
{
    double x = st->vFront;
    if (st->sv != 0) x += track_at(&st->svW, st->svT) * (SEMIVOWELS[st->sv].front - x);
    return dmin(dmax(x / 255, 0), 1);
}

/* Where a consonant's nasal zero opens to, in a syllable with nasality beyond
 * its nasal consonants (segZero). */
static double seg_zero(const TaudConsonant *row, double w, double s, double met, double fnp, double ceil)
{
    double own;
    if (!(row->fnz > 0)) return met;
    own = dmin(row->fnz * s, ceil);
    return met == fnp ? own : met + w * (own - met);
}

/* …the zero of the sound an onset consonant heads for: the first nasal of the
 * consonants after it, or the vowel's (onsetMetZero). */
static double onset_met_zero(const TaudFormantState *st, const TaudFormantSegment *seg, double s, double vz, double ceil)
{
    int n;
    for (n = seg->next; n >= 0; n = st->onset[n].next) {
        if (st->onset[n].row->fnz > 0) return dmin(st->onset[n].row->fnz * s, ceil);
    }
    return vz;
}

/* A held coda's time (codaHeldTime): at its hold point and no further — a
 * trill's taken back a cycle at a time, so it goes on trilling. */
static double coda_held_time(const TaudFormantSegment *seg, double t)
{
    if (t <= seg->hold) return t;
    if (seg->loop > 0) {
        while (t >= seg->hold) t -= seg->loop;
        return t;
    }
    return seg->hold;
}

/* One control update (≈ 1 ms): the sequencer, the vowel, the coefficients. */
static void formant_control(TaudEngine *e, TaudVoice *voice, TaudFormantState *st)
{
    int upd = st->upd, n;
    double dt = (upd * 1000.0) / e->rate;
    const TaudFormantPatch *patch = st->patch;
    double f0, ref, s, nzAmt = 0.0, ceil, fnp, fnz, vz, zf, nvEnd, inv;
    double *V = st->V, *VB = st->VB, *F = st->F, *B = st->B, *casc = st->casc;
    double ampNow[3], ampNext[3], nextF[5], nextB[5];
    const TaudFormantSegment *seg = NULL;
    bool holding, sung, nasalV, nasality, steady, codaHeld;
    double ra, na;
    st->ctl = upd;

    /* A fade before the coda has started takes the coda away for good. */
    if (voice->noteFading && st->phase != PHASE_CODA) st->codaVeto = true;
    /* A coda S $9010 called for HOLDS at its steady part while the key is
     * held; the key-off lets it go on through its release (item 292). */
    codaHeld = st->codaCall && !voice->keyOff;
    /* Walk past finished onset consonants into the vowel. A nucleus never
     * finishes: it holds, a trill's time wrapping back by its cycle. */
    while (st->phase == PHASE_ONSET && st->t >= st->onset[st->seg].end) {
        const TaudFormantSegment *cur = &st->onset[st->seg];
        if (st->seg == st->nucleus) {
            st->held = true;
            if (cur->loop > 0) while (st->t >= cur->end) st->t -= cur->loop;
            break;
        }
        st->t -= cur->end;
        st->seg++;
        if (st->seg >= st->onsetCount) { st->phase = PHASE_VOWEL; st->nOn = false; }
        else start_noise(e, st, &st->onset[st->seg]);
    }
    holding = st->phase == PHASE_ONSET && st->held;
    /* A key-off speaks the coda — and so does S $9010 (item 292), with the key
     * still held. */
    if ((st->phase == PHASE_VOWEL || holding) && (voice->keyOff || st->codaCall) && !st->codaVeto &&
        st->hasCoda) {
        /* Leaving a vowel nasalised other than as the coda was built for
         * (S $90kx, an instrument change gliding): the coda leaves it as it is. */
        if (st->nucleus < 0 && st->nasAmt.v != st->codaZ0) {
            st->hasCoda = build_coda(st, patch, slot_scale(patch, 2), st->nasAmt.v);
        }
        st->phase = PHASE_CODA;
        st->t = 0.0;
        /* After a hissing nucleus the coda's own noise waits for the hiss to go. */
        st->codaNoise = st->coda.noiseAt <= 0;
        if (st->codaNoise) start_noise(e, st, &st->coda);
    }
    /* (A coda that holds at its very end — silence — is over there as before.) */
    if (st->phase == PHASE_CODA && st->t >= st->coda.end && !(codaHeld && st->coda.hold < st->coda.end)) {
        st->phase = PHASE_DONE;
        st->av = 0; st->avStep = 0; st->ah = 0; st->ahStep = 0; st->af = 0; st->afStep = 0;
        st->nOn = false;
        te_start_ramp_out(e, voice);
        return;
    }
    if (st->phase == PHASE_CODA && !st->codaNoise && st->t >= st->coda.noiseAt) {
        st->codaNoise = true;
        start_noise(e, st, &st->coda);
    }

    if (st->glideLeft > 0) {
        if (st->glideLeft <= dt) {
            st->vOpen = st->tOpen; st->vFront = st->tFront; st->vRound = st->tRound;
            st->glideLeft = 0.0;
            if (st->rejoin) { st->ownVowel = false; st->rejoin = false; }
        } else {
            st->vOpen += st->gOpen * dt;
            st->vFront += st->gFront * dt;
            st->vRound += st->gRound * dt;
            st->glideLeft -= dt;
        }
    } else if (!st->ownVowel) {
        st->vOpen = patch->open; st->vFront = patch->front; st->vRound = patch->round;
    }
    amt_advance(&st->nasAmt, dt, patch->nasal);
    amt_advance(&st->rhoAmt, dt, patch->rhotic);
    /* A syllable with no vowel still has the tongue's rest — the vowel bytes —
     * for what its consonants take from "the vowel's". */
    sung = st->nucleus < 0;
    f0 = voice_f0(e, voice);
    ref = note_hz(ref_note(patch));
    /* R-coloured part of the way (S $90kx gliding): between the plain vowel
     * and the r-coloured one, in log frequency, as the glide G blends. */
    ra = sung ? st->rhoAmt.v : 0;
    s = vowel_at_pitch(e, st->vFront, st->vOpen, st->vRound, f0, ref, patch->track, V, VB, ra >= 1);
    if (ra > 0 && ra < 1) {
        double *VR = st->VR, *VRB = st->VRB;
        vowel_at_pitch(e, st->vFront, st->vOpen, st->vRound, f0, ref, patch->track, VR, VRB, true);
        for (n = 0; n < 5; n++) {
            V[n] *= js_pow(VR[n] / V[n], ra);
            VB[n] *= js_pow(VRB[n] / VB[n], ra);
        }
    }
    if (st->sv != 0) {
        double gw = track_at(&st->svW, st->svT);
        if (gw > 0) {
            double *VG = st->VG, *VGB = st->VGB;
            vowel_at_pitch(e, SEMIVOWELS[st->sv].front, SEMIVOWELS[st->sv].open, SEMIVOWELS[st->sv].round,
                           f0, ref, patch->track, VG, VGB, false);
            for (n = 0; n < 5; n++) {
                V[n] *= js_pow(VG[n] / V[n], gw);
                VB[n] *= js_pow(VGB[n] / VB[n], gw);
            }
        }
    }
    ceil = 0.45 * e->rate;
    fnp = dmin(FNP * s, ceil);
    /* Nasalised, as Klatt makes it: F1 a hundred hertz higher (at a man's
     * size), the order kept, and the nasal zero midway between that F1 and
     * the nasal pole. */
    /* Nasalised part of the way (S $90kx gliding), F1 rises part of its
     * 100 Hz and the zero opens part of the way from the pole to its place. */
    na = sung ? st->nasAmt.v : 0;
    nasalV = na > 0;
    vz = fnp;
    if (nasalV) {
        double mid;
        V[0] = dmin(V[0] + NASAL_F1 * s * na, ceil);
        VB[0] = dmax(V[0] / 10, 50);
        for (n = 1; n < 5; n++) if (V[n] < V[n - 1] * 1.15) V[n] = dmin(V[n - 1] * 1.15, ceil);
        mid = (V[0] + fnp) / 2;
        vz = na >= 1 ? mid : fnp + na * (mid - fnp);
    }
    nasality = nasalV || (st->nucleus >= 0 && st->onset[st->nucleus].row->fnz > 0);

    zf = fnp;
    if (st->phase == PHASE_ONSET) {
        double w;
        seg = &st->onset[st->seg];
        if (seg->next >= 0) {
            const TaudFormantSegment *nx = &st->onset[seg->next];
            blend_into(e, nx->row, nx->w.p[1], s, nextF, nextB, V, VB, nx->art);
        } else {
            memcpy(nextF, V, sizeof nextF);
            memcpy(nextB, VB, sizeof nextB);
        }
        w = track_at(&seg->w, st->t);
        blend_into(e, seg->row, w, s, F, B, nextF, nextB, seg->art);
        nzAmt = track_at(&seg->nz, st->t);
        if (nasality) zf = seg_zero(seg->row, w, s, onset_met_zero(st, seg, s, vz, ceil), fnp, ceil);
        seg_amps(seg, st->t, ampNow);
        seg_amps(seg, st->t + dt, ampNext);
    } else if (st->phase == PHASE_CODA) {
        double w;
        const TaudFormantSegment *nuc = st->nucleus >= 0 ? &st->onset[st->nucleus] : NULL;
        seg = &st->coda;
        w = track_at(&seg->w, st->t);
        /* From the vowel — or, with none, from the nucleus as it held. */
        if (nuc != NULL) {
            blend_into(e, nuc->row, 1, s, nextF, nextB, V, VB, nuc->art);
            blend_into(e, seg->row, w, s, F, B, nextF, nextB, seg->art);
        } else {
            blend_into(e, seg->row, w, s, F, B, V, VB, seg->art);
        }
        nzAmt = track_at(&seg->nz, st->t);
        if (nasality) {
            double met = nuc != NULL ? (nuc->row->fnz > 0 ? dmin(nuc->row->fnz * s, ceil) : fnp) : vz;
            zf = seg_zero(seg->row, w, s, met, fnp, ceil);
        }
        seg_amps(seg, st->t, ampNow);
        seg_amps(seg, codaHeld ? coda_held_time(seg, st->t + dt) : st->t + dt, ampNext);
    } else {
        bool gl = st->sv != 0;
        memcpy(F, V, 5 * sizeof *F);
        memcpy(B, VB, 5 * sizeof *B);
        ampNow[0] = gl ? track_at(&st->svAv, st->svT) : 1; ampNow[1] = 0; ampNow[2] = 0;
        ampNext[0] = gl ? track_at(&st->svAv, st->svT + dt) : 1; ampNext[1] = 0; ampNext[2] = 0;
        if (nasalV) { nzAmt = 1; zf = vz; }
    }
    /* Without nasality the zero opens only to a nasal consonant's own. */
    fnz = nasality ? zf : seg != NULL && seg->row->fnz > 0 ? dmin(seg->row->fnz * s, ceil) : fnp;
    set_res(e, casc, 0, fnp, BNP * s);
    set_res(e, casc, 3, fnp + nzAmt * (fnz - fnp), BNZ * s);
    for (n = 0; n < 5; n++) set_res(e, casc, 6 + (4 - n) * 3, dmin(F[n], ceil), dmin(B[n], ceil));
    /* The parallel bank, while a consonant can be fricating — in a coda after
     * a hissing nucleus, the nucleus's bank until the coda's own noise starts. */
    if (seg != NULL && st->nOn) {
        bool prev = st->phase == PHASE_CODA && !st->codaNoise;
        const TaudConsonant *row = prev && seg->prevRow != NULL ? seg->prevRow : seg->row;
        int art = prev ? seg->prevArt : seg->art;
        double *bank = st->bank, *g = st->bankGain, back;
        const double *a = row->bank;
        int j;
        set_peak_res(e, bank, 0, dmin(F[1], ceil), dmin(B[1], ceil));
        set_peak_res(e, bank, 3, dmin(F[2], ceil), dmin(B[2], ceil));
        for (j = 0; j < 3; j++) {
            set_peak_res(e, bank, 6 + j * 3, dmin(PAR_F[j] * s, ceil), dmin(PAR_B[j] * s, ceil));
        }
        /* A velar's bank follows the vowel it meets from front (the row's) to
         * back (`bankBack`), its own tongue's when it has a secondary one. */
        back = !row->hasBankBack ? 0 : art == ART_PALATAL ? 0 : art == ART_DARK ? 1 : 1 - met_front(st);
        for (j = 0; j < 6; j++) {
            double gj = a[j] > 0 ? db_gain(a[j] - 60) : 0;
            if (row->hasBankBack) gj += back * ((row->bankBack[j] > 0 ? db_gain(row->bankBack[j] - 60) : 0) - gj);
            g[j] = j == 5 || (j & 1) == 0 ? gj : -gj;
        }
        st->nb = bank_norm(&e->formantTables, bank, g);
    }

    /* The normaliser: in a consonant at every update; in the vowel, and a
     * nucleus holding, every NORM_EVERY updates. */
    steady = st->phase == PHASE_VOWEL || (st->phase == PHASE_ONSET && st->held);
    if (st->fresh || st->normCount <= 0 || !steady) {
        st->nvGoal = cascade_norm(e, casc, f0, st->hw, st->hwK);
        st->normCount = NORM_EVERY;
    }
    st->normCount--;
    nvEnd = st->fresh || (!steady && st->nvGoal < st->nv)
        ? st->nvGoal : st->nv + (st->nvGoal - st->nv) * 0.25;
    if (st->fresh) st->nv = nvEnd;

    inv = 1.0 / upd;
    st->av = ampNow[0]; st->avStep = (ampNext[0] - ampNow[0]) * inv;
    st->ah = ampNow[1]; st->ahStep = (ampNext[1] - ampNow[1]) * inv;
    st->af = ampNow[2]; st->afStep = (ampNext[2] - ampNow[2]) * inv;
    st->nvStep = (nvEnd - st->nv) * inv;
    st->fresh = false;
    if (st->phase != PHASE_VOWEL) st->t += dt;
    if (st->phase == PHASE_CODA && codaHeld) st->t = coda_held_time(&st->coda, st->t);
    if (st->sv != 0 && st->phase != PHASE_ONSET) {
        st->svT += dt;
        if (st->svT >= st->svEnd) st->sv = 0;
    }
}

static double tract_res(const double *co, int i, double *cy, int j, double x)
{
    double y = co[i] * x + co[i + 1] * cy[j] + co[i + 2] * cy[j + 1];
    cy[j + 1] = cy[j];
    cy[j] = y;
    return y;
}

/* A chip source's next sample (chipSource): the note's channel at output
 * frame `frame`, at the voice's rate and at unity volume, keyed off with the
 * voice. A channel that has rung out while the vowel — or a voiced nucleus,
 * holding — still sings ramps the note out, as a sample's end does. */
static double chip_source(TaudEngine *e, TaudVoice *voice, TaudFormantState *st, int64_t frame)
{
    double s;
    bool alive, sustaining;
    if (st->srcKind == CHIP_OPL) {
        s = te_opl_render(e, &st->srcOpl, frame, voice->currentPlaybackRate, 1.0, voice->keyOff);
    } else {
        s = te_psg_render(e, &st->srcPsg, frame, voice->currentPlaybackRate, voice->keyOff);
    }
    sustaining = st->phase == PHASE_VOWEL || (st->phase == PHASE_ONSET && st->held && st->av > 0);
    if (sustaining) {
        alive = st->srcKind == CHIP_OPL ? te_opl_channel_alive(&st->srcOpl) : te_psg_channel_alive(&st->srcPsg);
        if (!alive) te_start_ramp_out(e, voice);
    }
    return s;
}

double te_render_formant_voice(TaudEngine *e, TaudVoice *voice, TaudInst *inst, int interpMode, int64_t frame)
{
    TaudFormantState *st = voice->formant;
    double g, n, x, out;
    double *casc = st->casc, *cy = st->cy;
    if (st->sgDue) { measure_source(e, voice, st); st->sgDue = false; }
    g = st->srcKind != CHIP_NONE ? chip_source(e, voice, st, frame)
                                 : te_fetch_tracker_sample(e, voice, inst, interpMode, 0);
    if (st->phase == PHASE_DONE) return 0.0;
    if (st->ctl <= 0) {
        formant_control(e, voice, st);
        if (st->phase == PHASE_DONE) return 0.0;
    }
    st->ctl--;
    n = st->nOn ? read_noise(e, st) : 0.0;
    x = st->av * st->sg * (g - st->sm) + st->ah * n;
    x = tract_res(casc, 0, cy, 0, x);
    {
        double A = casc[3], b = casc[4], c = casc[5];
        double y = (x - b * cy[2] - c * cy[3]) / A;
        cy[3] = cy[2];
        cy[2] = x;
        x = y;
    }
    x = tract_res(casc, 6, cy, 4, x);
    x = tract_res(casc, 9, cy, 6, x);
    x = tract_res(casc, 12, cy, 8, x);
    x = tract_res(casc, 15, cy, 10, x);
    x = tract_res(casc, 18, cy, 12, x);
    out = st->nv * x;
    if (st->nOn) {
        double *bank = st->bank, *by = st->by, *gb = st->bankGain;
        double f = gb[5] * n;
        int j;
        for (j = 0; j < 5; j++) {
            int i = j * 3;
            double y = bank[i] * n + bank[i + 1] * by[j * 2] + bank[i + 2] * by[j * 2 + 1];
            by[j * 2 + 1] = by[j * 2];
            by[j * 2] = y;
            f += gb[j] * y;
        }
        out += st->af * st->nb * f;
    }
    st->av += st->avStep;
    st->ah += st->ahStep;
    st->af += st->afStep;
    st->nv += st->nvStep;
    return out;
}
