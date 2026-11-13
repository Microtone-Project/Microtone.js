/* Lookup tables + pitch math — port of tables.js and minifloat.js. */

#include <stdlib.h>

#include "taud_internal.h"

/* ── SNES BRR 4-tap gaussian table (512 entries) ── */
const int32_t SNES_GAUSS[512] = {
  0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
  0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
  0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
  0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00a, 0x00a, 0x00a,
  0x00b, 0x00b, 0x00b, 0x00c, 0x00c, 0x00d, 0x00d, 0x00e, 0x00e, 0x00f, 0x00f, 0x00f, 0x010, 0x010, 0x011, 0x011,
  0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01a, 0x01b, 0x01b,
  0x01c, 0x01d, 0x01d, 0x01e, 0x01f, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
  0x029, 0x02a, 0x02b, 0x02c, 0x02d, 0x02e, 0x02f, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
  0x03a, 0x03b, 0x03c, 0x03d, 0x03e, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04a, 0x04c, 0x04d,
  0x04e, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05a, 0x05c, 0x05e, 0x05f, 0x061, 0x063, 0x064, 0x066,
  0x068, 0x06a, 0x06b, 0x06d, 0x06f, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07a, 0x07c, 0x07e, 0x080, 0x082, 0x084,
  0x086, 0x089, 0x08b, 0x08d, 0x08f, 0x091, 0x093, 0x096, 0x098, 0x09a, 0x09c, 0x09f, 0x0a1, 0x0a3, 0x0a6, 0x0a8,
  0x0ab, 0x0ad, 0x0af, 0x0b2, 0x0b4, 0x0b7, 0x0ba, 0x0bc, 0x0bf, 0x0c1, 0x0c4, 0x0c7, 0x0c9, 0x0cc, 0x0cf, 0x0d2,
  0x0d4, 0x0d7, 0x0da, 0x0dd, 0x0e0, 0x0e3, 0x0e6, 0x0e9, 0x0ec, 0x0ef, 0x0f2, 0x0f5, 0x0f8, 0x0fb, 0x0fe, 0x101,
  0x104, 0x107, 0x10b, 0x10e, 0x111, 0x114, 0x118, 0x11b, 0x11e, 0x122, 0x125, 0x129, 0x12c, 0x130, 0x133, 0x137,
  0x13a, 0x13e, 0x141, 0x145, 0x148, 0x14c, 0x150, 0x153, 0x157, 0x15b, 0x15f, 0x162, 0x166, 0x16a, 0x16e, 0x172,
  0x176, 0x17a, 0x17d, 0x181, 0x185, 0x189, 0x18d, 0x191, 0x195, 0x19a, 0x19e, 0x1a2, 0x1a6, 0x1aa, 0x1ae, 0x1b2,
  0x1b7, 0x1bb, 0x1bf, 0x1c3, 0x1c8, 0x1cc, 0x1d0, 0x1d5, 0x1d9, 0x1dd, 0x1e2, 0x1e6, 0x1eb, 0x1ef, 0x1f3, 0x1f8,
  0x1fc, 0x201, 0x205, 0x20a, 0x20f, 0x213, 0x218, 0x21c, 0x221, 0x226, 0x22a, 0x22f, 0x233, 0x238, 0x23d, 0x241,
  0x246, 0x24b, 0x250, 0x254, 0x259, 0x25e, 0x263, 0x267, 0x26c, 0x271, 0x276, 0x27b, 0x280, 0x284, 0x289, 0x28e,
  0x293, 0x298, 0x29d, 0x2a2, 0x2a6, 0x2ab, 0x2b0, 0x2b5, 0x2ba, 0x2bf, 0x2c4, 0x2c9, 0x2ce, 0x2d3, 0x2d8, 0x2dc,
  0x2e1, 0x2e6, 0x2eb, 0x2f0, 0x2f5, 0x2fa, 0x2ff, 0x304, 0x309, 0x30e, 0x313, 0x318, 0x31d, 0x322, 0x326, 0x32b,
  0x330, 0x335, 0x33a, 0x33f, 0x344, 0x349, 0x34e, 0x353, 0x357, 0x35c, 0x361, 0x366, 0x36b, 0x370, 0x374, 0x379,
  0x37e, 0x383, 0x388, 0x38c, 0x391, 0x396, 0x39b, 0x39f, 0x3a4, 0x3a9, 0x3ad, 0x3b2, 0x3b7, 0x3bb, 0x3c0, 0x3c5,
  0x3c9, 0x3ce, 0x3d2, 0x3d7, 0x3dc, 0x3e0, 0x3e5, 0x3e9, 0x3ed, 0x3f2, 0x3f6, 0x3fb, 0x3ff, 0x403, 0x408, 0x40c,
  0x410, 0x415, 0x419, 0x41d, 0x421, 0x425, 0x42a, 0x42e, 0x432, 0x436, 0x43a, 0x43e, 0x442, 0x446, 0x44a, 0x44e,
  0x452, 0x455, 0x459, 0x45d, 0x461, 0x465, 0x468, 0x46c, 0x470, 0x473, 0x477, 0x47a, 0x47e, 0x481, 0x485, 0x488,
  0x48c, 0x48f, 0x492, 0x496, 0x499, 0x49c, 0x49f, 0x4a2, 0x4a6, 0x4a9, 0x4ac, 0x4af, 0x4b2, 0x4b5, 0x4b7, 0x4ba,
  0x4bd, 0x4c0, 0x4c3, 0x4c5, 0x4c8, 0x4cb, 0x4cd, 0x4d0, 0x4d2, 0x4d5, 0x4d7, 0x4d9, 0x4dc, 0x4de, 0x4e0, 0x4e3,
  0x4e5, 0x4e7, 0x4e9, 0x4eb, 0x4ed, 0x4ef, 0x4f1, 0x4f3, 0x4f5, 0x4f6, 0x4f8, 0x4fa, 0x4fb, 0x4fd, 0x4ff, 0x500,
  0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50a, 0x50b, 0x50c, 0x50d, 0x50e, 0x50f, 0x510, 0x511, 0x511, 0x512,
  0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519,
};

const int32_t MOD_SIN_TABLE[64] = {
  0x00, 0x0c, 0x19, 0x25, 0x31, 0x3c, 0x47, 0x51,
  0x5a, 0x62, 0x6a, 0x70, 0x75, 0x7a, 0x7d, 0x7e,
  0x7f, 0x7e, 0x7d, 0x7a, 0x75, 0x70, 0x6a, 0x62,
  0x5a, 0x51, 0x47, 0x3c, 0x31, 0x25, 0x19, 0x0c,
  0x00, -0x0c, -0x19, -0x25, -0x31, -0x3c, -0x47, -0x51,
  -0x5a, -0x62, -0x6a, -0x70, -0x75, -0x7a, -0x7d, -0x7e,
  -0x7f, -0x7e, -0x7d, -0x7a, -0x75, -0x70, -0x6a, -0x62,
  -0x5a, -0x51, -0x47, -0x3c, -0x31, -0x25, -0x19, -0x0c,
};

const int32_t FINETUNE_OFFSET[16] = {
  -0x0154, -0x0132, -0x0111, -0x00e4, -0x00b8, -0x008b, -0x005d, -0x003b,
  0x0000, 0x0023, 0x0046, 0x0074, 0x0098, 0x00c8, 0x00f9, 0x0110,
};

/* "Perceptually Significant Octet to Decibel Table" as linear amplitude.
 * Octet 0 = silence, 159 = unity, 255 = +24 dB. */
const double META_MIX_GAIN[256] = {
  0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
  0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
  0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
  0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
  0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
  0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
  0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
  0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
  0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
  0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
  0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
  0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
  0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
  0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
  0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
  0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
  0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
  0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
  0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
  0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
  1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
  1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
  1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
  1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
  1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
  1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
  2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
  2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
  3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
  4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
  6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
  10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932,
};

/* ThreeFiveMiniUfloat: e = i>>5, m = i&31; e=0 → m/256, else (32+m)·2^(e−1)/256.
 * Every value is an exact binary fraction, so a literal table is exact. */
#define MF(i) ((((i) >> 5) == 0) ? (float)((i) & 31) / 256.0f \
              : (float)((32 + ((i) & 31)) * (1 << (((i) >> 5) - 1))) / 256.0f)
#define MF8(b) MF(b), MF(b + 1), MF(b + 2), MF(b + 3), MF(b + 4), MF(b + 5), MF(b + 6), MF(b + 7)
#define MF32(b) MF8(b), MF8(b + 8), MF8(b + 16), MF8(b + 24)
const float MINIFLOAT_LUT[256] = {
  MF32(0), MF32(32), MF32(64), MF32(96), MF32(128), MF32(160), MF32(192), MF32(224)
};

/* Amiga filter cut-offs (physical RC / Sallen-Key corners of the hardware). */
#define AMIGA_A500_LP_FC 4420.971
#define AMIGA_LED_FC 3090.533
#define AMIGA_LED_Q 0.660225

/* The modified Bessel function I0, by its series (a Kaiser window's shape). */
double te_bessel_i0(double x)
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

/* The FM racks' rate at this engine rate, and the low-pass they come down
 * through (spec §5.5.1): an eighth-order Butterworth at FM_DEC_CUTOFF of the
 * ENGINE's rate, designed at the rack's — so its place in the oversampled
 * spectrum is 2π × FM_DEC_CUTOFF ÷ factor, whatever the rate. Four RBJ
 * low-pass sections on the Butterworth pole angles, lowest Q first. */
static void build_fm_decimator(TaudEngine *e)
{
    const double pi = 3.141592653589793;
    int n = (FM_OVERSAMPLE_RATE + e->rate - 1) / e->rate;
    double w0, cosw, sinw;
    int k;
    if (n < 1) n = 1;
    if (n > FM_OVERSAMPLE_MAX) n = FM_OVERSAMPLE_MAX;
    e->fmOversample = n;
    w0 = (2.0 * pi * FM_DEC_CUTOFF) / n;
    cosw = js_cos(w0);
    sinw = js_sin(w0);
    for (k = 0; k < FM_DEC_SECTIONS; k++) {
        double q = 1.0 / (2.0 * js_cos(((2 * k + 1) * pi) / (4.0 * FM_DEC_SECTIONS)));
        double alpha = sinw / (2.0 * q);
        double a0 = 1.0 + alpha;
        e->fmDec[k][0] = ((1.0 - cosw) * 0.5) / a0;
        e->fmDec[k][1] = (1.0 - cosw) / a0;
        e->fmDec[k][2] = ((1.0 - cosw) * 0.5) / a0;
        e->fmDec[k][3] = (-2.0 * cosw) / a0;
        e->fmDec[k][4] = (1.0 - alpha) / a0;
    }
}

/* One sample through the racks' low-pass: each section in transposed direct
 * form II, `state` its two numbers a section. */
double te_fm_decimate(const TaudEngine *e, double *state, double x)
{
    int k;
    for (k = 0; k < FM_DEC_SECTIONS; k++) {
        const double *c = e->fmDec[k];
        double y = c[0] * x + state[2 * k];
        state[2 * k] = c[1] * x - c[3] * y + state[2 * k + 1];
        state[2 * k + 1] = c[2] * x - c[4] * y;
        x = y;
    }
    return x;
}

void te_build_tables(TaudEngine *e)
{
    const double pi = 3.141592653589793;
    double winFreq = pi / SINC_WIDTH / SINC_PRECISION;
    double rate = e->rate;
    double aBase, bBase;
    int i;

    e->sincTable[0] = 1.0;
    for (i = 1; i < SINC_TABLE_SIZE; i++) {
        double t = (i * pi) / SINC_PRECISION;
        double win = 0.5 + 0.5 * js_cos(winFreq * i);
        e->sincTable[i] = (js_sin(t) / t) * win;
    }
    e->sincTable[SINC_TABLE_SIZE] = 0.0;
    /* Tap j of phase p sits |j·SINC_PRECISION − p| table steps from the centre. */
    for (i = 0; i < SINC_PRECISION; i++) {
        int j;
        for (j = 1 - SINC_WIDTH; j <= SINC_WIDTH; j++) {
            e->sincPhase[i * SINC_TAPS + (j + SINC_WIDTH - 1)] = e->sincTable[abs(j * SINC_PRECISION - i)];
        }
    }

    for (i = 0; i < 256; i++) e->pcmU8[i] = (i - 127.5) / 127.5;

    build_fm_decimator(e);

    e->a500B1 = js_exp((-2.0 * pi * AMIGA_A500_LP_FC) / rate);
    e->a500A0 = 1.0 - e->a500B1;
    aBase = 1.0 / js_tan((pi * AMIGA_LED_FC) / rate);
    bBase = 1.0 / AMIGA_LED_Q;
    e->ledA1 = 1.0 / (1.0 + bBase * aBase + aBase * aBase);
    e->ledA2 = 2.0 * e->ledA1;
    e->ledB1 = 2.0 * (1.0 - aBase * aBase) * e->ledA1;
    e->ledB2 = (1.0 - bBase * aBase + aBase * aBase) * e->ledA1;
}


/* ── command LFOs (H, U, R, Y) — 64 entries × 17 steps ── */

int te_advance_lfo_phase(int pos, int speed) { return (pos + speed) % LFO_PHASE_STEPS; }

int te_lfo_sample(TaudEngine *e, int pos, int wave)
{
    int idx = ((unsigned)pos >> 2) & 0x3f;
    switch (wave & 3) {
    case 0: return MOD_SIN_TABLE[idx];
    case 1: return 0x7f - (idx << 2);
    case 2: return idx < 32 ? 0x7f : -0x7f;
    default: return ((int)(te_random(e) * 256) & 0xff) - 0x80;
    }
}

int te_lfo_sample_wide(TaudEngine *e, int pos, int wave)
{
    return te_lfo_sample(e, (pos / LFO_STEPS_PER_ENTRY) << 2, wave);
}

double te_atten_gain_of(int octet) { return octet <= 0 ? 1.0 : META_MIX_GAIN[octet & 0xff]; }

/* ── pitch conversions ── */

double te_note_val_to_amiga_period(double noteVal)
{
    return AMIGA_BASE_PERIOD * js_pow(2.0, -(noteVal - MIDDLE_C) / 4096.0);
}

int te_amiga_period_to_note_val(double period)
{
    return (int)js_round(MIDDLE_C + 4096.0 * js_log2(AMIGA_BASE_PERIOD / period));
}

double te_note_val_to_freq_hz(double noteVal)
{
    return LINEAR_FREQ_C4_HZ * js_pow(2.0, (noteVal - MIDDLE_C) / 4096.0);
}

int te_freq_hz_to_note_val(double freq)
{
    return (int)js_round(MIDDLE_C + 4096.0 * js_log2(freq / LINEAR_FREQ_C4_HZ));
}

/** Song tuning pair → playback-rate multiplier. A pure ratio, no log/exp round
 *  trip: a concert declaration returns exactly 1.0. */
double te_tuning_ratio_of(int baseNote, double freq)
{
    int b = baseNote > 0 ? baseNote : TUNING_DEFAULT_BASE_NOTE;
    double f = freq > 0 ? freq : TUNING_DEFAULT_FREQ_HZ; /* also catches NaN */
    return (f / js_pow(2.0, (b - MIDDLE_C) / 4096.0)) / TUNING_REF_C4_HZ;
}

int te_amiga_slide_tick(TaudVoice *v, int slideArg)
{
    if (v->amigaPeriod < 0.0) v->amigaPeriod = te_note_val_to_amiga_period(v->noteVal);
    v->amigaPeriod = dmax(v->amigaPeriod - slideArg, 1.0);
    return te_amiga_period_to_note_val(v->amigaPeriod);
}

int te_amiga_slide_once(double noteVal, int slideArg)
{
    double period = te_note_val_to_amiga_period(noteVal);
    double np = dmax(period - slideArg, 1.0);
    return te_amiga_period_to_note_val(np);
}

int te_linear_freq_slide_tick(TaudVoice *v, int slideArg)
{
    if (v->linearFreq < 0.0) v->linearFreq = te_note_val_to_freq_hz(v->noteVal);
    v->linearFreq = dmax(v->linearFreq + slideArg, 1.0);
    return te_freq_hz_to_note_val(v->linearFreq);
}

int te_linear_freq_slide_once(double noteVal, int slideArg)
{
    double freq = te_note_val_to_freq_hz(noteVal);
    double nf = dmax(freq + slideArg, 1.0);
    return te_freq_hz_to_note_val(nf);
}
