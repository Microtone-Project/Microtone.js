/* OPL instruments — Metainstrument type 8 (item 209) — port of opl.js.
 *
 * A type-8 instrument is an ordinary instrument record whose sample is a
 * YM3812 / YMF262 channel: two operators, four, or one of the five rhythm-mode
 * drums (TAUD_FILE_FORMAT.md §7.7). Every sounding voice is its own channel;
 * the things a real chip shares between channels — the envelope counter, the
 * LFOs and the sample grid — come from one chip clock per playhead
 * (e->oplFrame), so every voice reads the same counter at the same frame. Each
 * voice runs the chip at 49716 Hz and is read back at the engine rate by
 * linear interpolation between its last two chip samples.
 *
 * Integer arithmetic follows the JS's int32 / uint32 semantics; the two
 * transcendental tables are constants, and `2 ** rational` (js_pow) is the
 * only transcendental used. The LFO tables the JS precomputes are pure
 * functions of the clock, evaluated here with the same expressions instead. */

#include <math.h>
#include <string.h>

#include "taud_internal.h"

#define OPL_CLOCK_HZ 3579545
#define OPL_CLOCKS_PER_SAMPLE 72
static const double OPL_RATE = OPL_RATE_HZ;

#define OPL_B_KIND 0
#define OPL_B_C0A 1
#define OPL_B_C0B 2
#define OPL_B_PARTNER_MULT 3
#define OPL_B_PARTNER_DETUNE 4
#define OPL_B_OPS 6
#define OPL_OP_BYTES 5

#define OPL_KIND_2OP 0
#define OPL_KIND_4OP 1
#define OPL_KIND_BD 2
#define OPL_KIND_SD 3
#define OPL_KIND_TOM 4
#define OPL_KIND_TC 5
#define OPL_KIND_HH 6
#define OPL_KIND_MASK 0x07
#define OPL_FLAG_DEEP_TREMOLO 0x08
#define OPL_FLAG_DEEP_VIBRATO 0x10
#define OPL_FLAG_NTS 0x20
#define OPL_FLAG_LOW_FNUM 0x40

static const uint16_t LOG_SIN[256] = {
    2137, 1731, 1543, 1419, 1326, 1252, 1190, 1137, 1091, 1050, 1013, 979, 949, 920, 894, 869,
    846, 825, 804, 785, 767, 749, 732, 717, 701, 687, 672, 659, 646, 633, 621, 609,
    598, 587, 576, 566, 556, 546, 536, 527, 518, 509, 501, 492, 484, 476, 468, 461,
    453, 446, 439, 432, 425, 418, 411, 405, 399, 392, 386, 380, 375, 369, 363, 358,
    352, 347, 341, 336, 331, 326, 321, 316, 311, 307, 302, 297, 293, 289, 284, 280,
    276, 271, 267, 263, 259, 255, 251, 248, 244, 240, 236, 233, 229, 226, 222, 219,
    215, 212, 209, 205, 202, 199, 196, 193, 190, 187, 184, 181, 178, 175, 172, 169,
    167, 164, 161, 159, 156, 153, 151, 148, 146, 143, 141, 138, 136, 134, 131, 129,
    127, 125, 122, 120, 118, 116, 114, 112, 110, 108, 106, 104, 102, 100, 98, 96,
    94, 92, 91, 89, 87, 85, 83, 82, 80, 78, 77, 75, 74, 72, 70, 69,
    67, 66, 64, 63, 62, 60, 59, 57, 56, 55, 53, 52, 51, 49, 48, 47,
    46, 45, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30,
    29, 28, 27, 26, 25, 24, 23, 23, 22, 21, 20, 20, 19, 18, 17, 17,
    16, 15, 15, 14, 13, 13, 12, 12, 11, 10, 10, 9, 9, 8, 8, 7,
    7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2,
    2, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
};

static const uint16_t EXP_TABLE[256] = {
    0, 3, 6, 8, 11, 14, 17, 20, 22, 25, 28, 31, 34, 37, 40, 42,
    45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90,
    93, 96, 99, 102, 105, 108, 111, 114, 117, 120, 123, 126, 130, 133, 136, 139,
    142, 145, 148, 152, 155, 158, 161, 164, 168, 171, 174, 177, 181, 184, 187, 190,
    194, 197, 200, 204, 207, 210, 214, 217, 220, 224, 227, 231, 234, 237, 241, 244,
    248, 251, 255, 258, 262, 265, 268, 272, 276, 279, 283, 286, 290, 293, 297, 300,
    304, 308, 311, 315, 318, 322, 326, 329, 333, 337, 340, 344, 348, 352, 355, 359,
    363, 367, 370, 374, 378, 382, 385, 389, 393, 397, 401, 405, 409, 412, 416, 420,
    424, 428, 432, 436, 440, 444, 448, 452, 456, 460, 464, 468, 472, 476, 480, 484,
    488, 492, 496, 501, 505, 509, 513, 517, 521, 526, 530, 534, 538, 542, 547, 551,
    555, 560, 564, 568, 572, 577, 581, 585, 590, 594, 599, 603, 607, 612, 616, 621,
    625, 630, 634, 639, 643, 648, 652, 657, 661, 666, 670, 675, 680, 684, 689, 693,
    698, 703, 708, 712, 717, 722, 726, 731, 736, 741, 745, 750, 755, 760, 765, 770,
    774, 779, 784, 789, 794, 799, 804, 809, 814, 819, 824, 829, 834, 839, 844, 849,
    854, 859, 864, 869, 874, 880, 885, 890, 895, 900, 906, 911, 916, 921, 927, 932,
    937, 942, 948, 953, 959, 964, 969, 975, 980, 986, 991, 996, 1002, 1007, 1013, 1018,
};

/* Total attenuation (1/256-log2 units, possibly fractional) to amplitude. */
int te_opl_expand(double att)
{
    int32_t a;
    if (att >= 0x1800) return 0;
    a = js_toint32(att);
    return ((EXP_TABLE[255 - (a & 0xff)] + 1024) << 1) >> (a >> 8);
}

#define OPL_RHYTHM_MIX 2
#define OUTPUT_SCALE (1.0 / 4096)

#define ENV_TO_LOG 8
#define TL_TO_LOG 32
#define SILENCE 0x1000

static const int32_t KSL_ROM[16] = { 0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54, 55, 56 };
static const int32_t KSL_SHIFT[4] = { -1, 1, 2, 0 };
const int32_t OPL_MULTIPLE_X2[16] = { 1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30 };
const int32_t OPL_SUSTAIN_LEVEL[16] = { 0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 496 };
static const int32_t EG_DUTY[4][8] = {
    { 1, 0, 1, 0, 1, 0, 1, 0 },
    { 1, 0, 1, 0, 1, 0, 1, 1 },
    { 1, 0, 1, 1, 1, 0, 1, 1 },
    { 1, 0, 1, 1, 1, 1, 1, 1 },
};

/* ── LFOs: free-running triangles of the chip clock ── */

#define VIBRATO_PERIOD OPL_VIBRATO_PERIOD
#define TREMOLO_PERIOD OPL_TREMOLO_PERIOD

static double triangle(int p, int period)
{
    int half = period >> 1;
    return p < half ? (double)p / half : 2 - (double)p / half;
}

/* TREMOLO_TABLE[depth][p]: Math.round(1/0.1875) = 5, Math.round(4.8/0.1875) = 26.
 * The PSG's oscillators read both tables too (OPL_TREMOLO_TABLE). */
double te_opl_tremolo_at(int deep, int p)
{
    return (deep ? 26 : 5) * ENV_TO_LOG * triangle(p, TREMOLO_PERIOD);
}

/* VIBRATO_TABLE[depth][p]. */
double te_opl_vibrato_at(int deep, int p)
{
    double cents = (deep ? 14 : 7) * (2 * triangle(p, VIBRATO_PERIOD) - 1);
    return cents == 0 ? 1 : js_pow(2, cents / 1200);
}

/* ── waveforms: a 10-bit phase to a log attenuation, and a sign ── */

static int waveform(int shape, int phase, int *sign)
{
    int quarter = phase & 0xff;
    int mirrored = (phase & 0x100) != 0 ? 255 - quarter : quarter;
    bool negative = (phase & 0x200) != 0;
    switch (shape) {
    case 0:
        *sign = negative ? -1 : 1;
        return LOG_SIN[mirrored];
    case 1:
        *sign = 1;
        return negative ? SILENCE : LOG_SIN[mirrored];
    case 2:
        *sign = 1;
        return LOG_SIN[mirrored];
    case 3:
        *sign = 1;
        return (phase & 0x100) != 0 ? SILENCE : LOG_SIN[quarter];
    case 4: {
        int p, q;
        *sign = 1;
        if (negative) return SILENCE;
        p = (phase << 1) & 0x3ff;
        q = p & 0xff;
        *sign = (p & 0x200) != 0 ? -1 : 1;
        return LOG_SIN[(p & 0x100) != 0 ? 255 - q : q];
    }
    case 5: {
        int p, q;
        *sign = 1;
        if (negative) return SILENCE;
        p = (phase << 1) & 0x1ff;
        q = p & 0xff;
        return LOG_SIN[(p & 0x100) != 0 ? 255 - q : q];
    }
    case 6:
        *sign = negative ? -1 : 1;
        return 0;
    default: {
        int ramp = phase & 0x1ff;
        *sign = negative ? -1 : 1;
        return (negative ? 0x1ff - ramp : ramp) << 3;
    }
    }
}

/* ── the patch ── */

/* Which operators reach the output. Four operators: operator 4 always,
 * operator 1 when CNT A is set, and the other pair's last operator when CNT B
 * is — operator 2 when CNT A is clear, operator 3 when it is set (the YMF262
 * data sheet's four connection figures, catalogue 4MF262A6, p. 13). */
static int opl_output_mask(int kind, int cntA, int cntB)
{
    switch (kind) {
    case OPL_KIND_2OP: case OPL_KIND_BD: return cntA ? 3 : 2;
    case OPL_KIND_4OP: return 8 | (cntA ? 1 : 0) | (cntB ? (cntA ? 4 : 2) : 0);
    case OPL_KIND_SD: case OPL_KIND_TOM: case OPL_KIND_TC: case OPL_KIND_HH: return 1;
    default: return 0;
    }
}

/** Unpack the 54-byte block into `into` (decodeOplPatch). */
void te_decode_opl_patch(const uint8_t *bytes, TaudOplPatch *into)
{
    int kindByte = bytes[OPL_B_KIND], c0a = bytes[OPL_B_C0A], c0b = bytes[OPL_B_C0B], pd, i;
    into->kind = kindByte & OPL_KIND_MASK;
    into->deepTremolo = (kindByte & OPL_FLAG_DEEP_TREMOLO) != 0;
    into->deepVibrato = (kindByte & OPL_FLAG_DEEP_VIBRATO) != 0;
    into->nts = (kindByte & OPL_FLAG_NTS) != 0;
    into->lowFnum = (kindByte & OPL_FLAG_LOW_FNUM) != 0;
    into->feedback = (c0a >> 1) & 7;
    into->cntA = c0a & 1;
    into->cntB = c0b & 1;
    into->partnerMult = bytes[OPL_B_PARTNER_MULT] & 0x0f;
    pd = bytes[OPL_B_PARTNER_DETUNE] | (bytes[OPL_B_PARTNER_DETUNE + 1] << 8);
    into->partnerDetune = pd >= 0x8000 ? pd - 0x10000 : pd;
    for (i = 0; i < 4; i++) {
        const uint8_t *o = bytes + OPL_B_OPS + i * OPL_OP_BYTES;
        TaudOplOperator *op = &into->ops[i];
        int r20 = o[0], r40 = o[1], r60 = o[2], r80 = o[3], rE0 = o[4];
        op->am = (r20 >> 7) & 1; op->vib = (r20 >> 6) & 1; op->eg = (r20 >> 5) & 1;
        op->ksr = (r20 >> 4) & 1; op->mult = r20 & 0x0f;
        op->ksl = (r40 >> 6) & 3; op->tl = r40 & 0x3f;
        op->ar = (r60 >> 4) & 0x0f; op->dr = r60 & 0x0f;
        op->sl = OPL_SUSTAIN_LEVEL[(r80 >> 4) & 0x0f]; op->rr = r80 & 0x0f;
        op->ws = rE0 & 7;
    }
    into->outputs = opl_output_mask(into->kind, into->cntA, into->cntB);
    into->gen++;
}

/* The block and F-number a driver would write for `hz`, as block << 10 | fnum. */
static int opl_block_fnum(double hz, bool lowFnum)
{
    double x = (hz * 1048576) / OPL_RATE;
    int ceiling = lowFnum ? 686 : 1024, b;
    for (b = 0; b < 8; b++) {
        double f = js_round(x / (1 << b));
        if (f < ceiling) return (b << 10) | (int)f;
    }
    return (7 << 10) | 1023;
}

/* ── the voice ── */

/* The chip-sample index output frame `frame` falls on, and the fraction past
 * it, in the JS's double arithmetic (num/den exactly while num < 2^53). */
int64_t te_opl_chip_index(const TaudEngine *e, int64_t frame, double *frac)
{
    double num = (double)frame * OPL_CLOCK_HZ;
    double den = (double)OPL_CLOCKS_PER_SAMPLE * e->rate;
    double k = floor(num / den);
    double rem = num - k * den;
    if (rem < 0) { k--; rem += den; }
    else if (rem >= den) { k++; rem -= den; }
    *frac = rem / den;
    return (int64_t)k;
}

static uint32_t noise_seed(int64_t k)
{
    uint32_t s = (((uint32_t)k * 0x9e3779b1u) >> 9) & 0x7fffff;
    return s == 0 ? 1 : s;
}

/* A fresh channel, as `new OplState()` leaves one. */
void te_opl_state_init(TaudOplState *st)
{
    int i;
    memset(st, 0, sizeof *st);
    st->gen = -1;
    st->rate = -1;
    for (i = 0; i < 4; i++) st->env[i] = OPL_ENV_MAX;
    st->noise = 1;
    st->kValid = true;          /* the constructor's k is -1, not NaN */
    st->k = -1;
    st->vol = -1;
}

/* The key scaling an operator at `hz` takes, as retune() works it out for a
 * melodic channel (NTS 0, the ordinary F-number ceiling): out[0] the rate
 * offset KSR adds to every envelope rate, out[1] the key-scale level in
 * envelope units — for the PSG, which borrows the chip's envelope
 * (oplKeyScaling). */
void te_opl_key_scaling(double hz, int ksr, int ksl, int32_t out[2])
{
    int bf = opl_block_fnum(hz, false);
    int block = bf >> 10, fnum = bf & 1023;
    int ksv = (block << 1) | ((fnum >> 9) & 1);
    int kslBase = KSL_ROM[(fnum >> 6) & 15] - 8 * (7 - block);
    int shift;
    if (kslBase < 0) kslBase = 0;
    out[0] = ksr ? ksv : ksv >> 2;
    shift = KSL_SHIFT[ksl & 3];
    out[1] = shift < 0 ? 0 : (kslBase << 2) >> shift;
}

void te_opl_key_on(TaudOplState *st, const TaudOplPatch *patch, bool carry)
{
    int i;
    st->patch = patch;
    st->gen = -1;
    st->rate = -1;
    if (!carry) {
        for (i = 0; i < 4; i++) { st->env[i] = OPL_ENV_MAX; st->out[i] = 0; st->prev[i] = 0; }
        st->cur = 0;
        st->last = 0;
        st->kValid = false;
    }
    for (i = 0; i < 4; i++) {
        st->state[i] = EG_ATTACK;
        st->phase[i] = 0;
    }
    st->hhPhase = 0;
    st->tcPhase = 0;
    st->keyed = true;
}

void te_opl_key_off(TaudOplState *st)
{
    int i;
    for (i = 0; i < 4; i++) if (st->state[i] != EG_OFF) st->state[i] = EG_RELEASE;
    st->keyed = false;
}

void te_opl_reattack(TaudOplState *st)
{
    int i;
    for (i = 0; i < 4; i++) st->state[i] = EG_ATTACK;
    st->keyed = true;
}

#define HZ_PER_SPS (LINEAR_FREQ_C4_HZ / OPL_C4_RATE)

static void retune(const TaudEngine *e, TaudOplState *st, double rate)
{
    const TaudOplPatch *patch = st->patch;
    double hz = rate * e->rate * HZ_PER_SPS;
    int bf = opl_block_fnum(hz, patch->lowFnum);
    int block = bf >> 10, fnum = bf & 1023;
    int ksv = (block << 1) | ((fnum >> (patch->nts ? 8 : 9)) & 1);
    int kslBase = KSL_ROM[(fnum >> 6) & 15] - 8 * (7 - block);
    int i, kind;
    if (kslBase < 0) kslBase = 0;
    for (i = 0; i < 4; i++) {
        const TaudOplOperator *op = &patch->ops[i];
        int shift = KSL_SHIFT[op->ksl];
        st->inc[i] = ((fnum * OPL_MULTIPLE_X2[op->mult]) << block) >> 1;
        st->ksrOffset[i] = op->ksr ? ksv : ksv >> 2;
        st->kslAtt[i] = shift < 0 ? 0 : (kslBase << 2) >> shift;
    }
    kind = patch->kind;
    if (kind == OPL_KIND_SD || kind == OPL_KIND_HH || kind == OPL_KIND_TC) {
        int pbf = opl_block_fnum(hz * js_pow(2, patch->partnerDetune / 4096.0), patch->lowFnum);
        int pInc = (((pbf & 1023) * OPL_MULTIPLE_X2[patch->partnerMult]) << (pbf >> 10)) >> 1;
        int own = st->inc[0];
        if (kind == OPL_KIND_SD) {
            st->hhInc = ((fnum * OPL_MULTIPLE_X2[patch->partnerMult]) << block) >> 1;
            st->tcInc = 0;
        } else if (kind == OPL_KIND_HH) {
            st->hhInc = own;
            st->tcInc = pInc;
        } else {
            st->tcInc = own;
            st->hhInc = pInc;
        }
    }
    st->rate = rate;
    st->gen = patch->gen;
}

/* One envelope tick for one operator (oplAdvanceEnvelope): `state` and `env`
 * point at its entries, `eg` is the chip clock as the JS's int32 bit
 * operations see it. The PSG's oscillators run on it too. */
void te_opl_advance_envelope(uint8_t *stp, int32_t *envp, int32_t ksrOffset, const TaudOplOperator *op, int32_t eg)
{
    int state = *stp, rateParam, rate, shift, steps, n;
    if (state == EG_OFF) return;
    rateParam = state == EG_ATTACK ? op->ar
        : state == EG_DECAY ? op->dr
        : state == EG_SUSTAIN ? (op->eg ? 0 : op->rr)
        : op->rr;
    if (rateParam == 0) return;
    rate = rateParam * 4 + ksrOffset;
    if (rate > 60) rate = 60;
    shift = 12 - (rate >> 2);
    if (shift >= 0) {
        if ((eg & ((1 << shift) - 1)) != 0) return;
        steps = EG_DUTY[rate & 3][asr32(eg, shift) & 7];
    } else {
        steps = EG_DUTY[rate & 3][eg & 7] << -shift;
    }
    for (n = 0; n < steps; n++) {
        int32_t env = *envp;
        switch (*stp) {
        case EG_ATTACK:
            env -= (env >> 3) + 1;
            if (env <= 0) { env = 0; *stp = EG_DECAY; }
            break;
        case EG_DECAY:
            env += 1;
            if (env >= op->sl) { env = op->sl; *stp = EG_SUSTAIN; }
            break;
        default:
            env += 1;
            if (env >= OPL_ENV_MAX) { env = OPL_ENV_MAX; *stp = EG_OFF; }
            break;
        }
        *envp = env < 0 ? 0 : env > OPL_ENV_MAX ? OPL_ENV_MAX : env;
        if (*stp != state) break;
    }
}

static void advance_envelope(TaudOplState *st, int i, const TaudOplOperator *op, int32_t eg)
{
    te_opl_advance_envelope(&st->state[i], &st->env[i], st->ksrOffset[i], op, eg);
}

/* `mod` is the phase modulation in phase steps: an integer, but a double,
 * since an FM rack's offset (st->pm) can carry it anywhere (`& 0x3ff` of the
 * JS's ToInt32 of the sum). */
static int operate(TaudOplState *st, int i, const TaudOplOperator *op, double mod, double extra, double vibrato)
{
    double att = (double)((st->env[i] + st->kslAtt[i]) * ENV_TO_LOG + op->tl * TL_TO_LOG) + extra;
    int32_t inc = st->inc[i];
    int logv, sign, v;
    if (op->vib && vibrato != 1) inc = (int32_t)js_round(inc * vibrato);
    st->phase[i] = st->phase[i] + (uint32_t)inc;
    st->prev[i] = st->out[i];
    if (st->state[i] == EG_OFF) { st->out[i] = 0; return 0; }
    logv = waveform(op->ws, js_toint32((double)(st->phase[i] >> 10) + mod) & 0x3ff, &sign);
    if (logv == SILENCE) { st->out[i] = 0; return 0; }
    v = te_opl_expand(logv + att) * sign;
    st->out[i] = v;
    return v;
}

static int rhythm_operator(TaudOplState *st, int i, const TaudOplOperator *op, int phase, double extra)
{
    int logv, sign, v;
    double att;
    st->prev[i] = st->out[i];
    if (st->state[i] == EG_OFF) { st->out[i] = 0; return 0; }
    logv = waveform(op->ws, phase, &sign);
    if (logv == SILENCE) { st->out[i] = 0; return 0; }
    att = (double)((st->env[i] + st->kslAtt[i]) * ENV_TO_LOG + op->tl * TL_TO_LOG) + extra;
    v = te_opl_expand(att + logv) * sign;
    st->out[i] = v;
    return v;
}

static int feedback_of(const TaudOplState *st, int fb)
{
    if (fb == 0) return 0;
    return js_toint32((double)(st->out[0] + st->prev[0]) / 2 / (1 << (8 - fb)));
}

/* The chip's next sample for this channel at chip clock k (oplChipStep). The
 * four four-operator connections are the YMF262 data sheet's (catalogue
 * 4MF262A6, p. 13): CNT A 0, CNT B 1 is OP1 -> OP2 plus OP3 -> OP4. */
static int opl_chip_step(TaudOplState *st, int64_t k)
{
    const TaudOplPatch *patch = st->patch;
    const TaudOplOperator *ops = patch->ops;
    int32_t eg = (int32_t)(uint32_t)k;
    double trem = te_opl_tremolo_at(patch->deepTremolo, (int)(k % TREMOLO_PERIOD));
    /* The JS reads its vibrato table every sample; only an operator with its
     * VIB bit set uses the value, so it is evaluated only for one. */
    double vibrato = 1;
    int outputs = patch->outputs;
    double va = st->volAtt;
    double x0 = (ops[0].am ? trem : 0) + ((outputs & 1) != 0 ? va : 0);
    /* Outside phase modulation reaches the operators the channel OUTPUTS, the
     * way the chip's own modulator reaches its carrier; 0 changes nothing. */
    double pm = st->pm;
    double p0 = (outputs & 1) != 0 ? pm : 0;
    if (ops[0].vib || ops[1].vib || ops[2].vib || ops[3].vib) {
        vibrato = te_opl_vibrato_at(patch->deepVibrato, (int)(k % VIBRATO_PERIOD));
    }
    switch (patch->kind) {
    case OPL_KIND_2OP: case OPL_KIND_BD: {
        double x1;
        int m, v;
        advance_envelope(st, 0, &ops[0], eg);
        advance_envelope(st, 1, &ops[1], eg);
        x1 = (ops[1].am ? trem : 0) + va;
        m = operate(st, 0, &ops[0], feedback_of(st, patch->feedback) + p0, x0, vibrato);
        v = patch->cntA ? m + operate(st, 1, &ops[1], pm, x1, vibrato)
                        : operate(st, 1, &ops[1], m + pm, x1, vibrato);
        return patch->kind == OPL_KIND_BD ? OPL_RHYTHM_MIX * v : v;
    }
    case OPL_KIND_4OP: {
        double x1, x2, x3, p1, p2;
        int o1, o2, o3, i;
        for (i = 0; i < 4; i++) advance_envelope(st, i, &ops[i], eg);
        x1 = (ops[1].am ? trem : 0) + ((outputs & 2) != 0 ? va : 0);
        x2 = (ops[2].am ? trem : 0) + ((outputs & 4) != 0 ? va : 0);
        x3 = (ops[3].am ? trem : 0) + va;
        p1 = (outputs & 2) != 0 ? pm : 0;
        p2 = (outputs & 4) != 0 ? pm : 0;
        o1 = operate(st, 0, &ops[0], feedback_of(st, patch->feedback) + p0, x0, vibrato);
        if (!patch->cntA) {
            o2 = operate(st, 1, &ops[1], o1 + p1, x1, vibrato);
            if (patch->cntB) {
                /* Two pairs side by side: 1 -> 2, and 3 -> 4. */
                o3 = operate(st, 2, &ops[2], 0, x2, vibrato);
                return o2 + operate(st, 3, &ops[3], o3 + pm, x3, vibrato);
            }
            o3 = operate(st, 2, &ops[2], o2, x2, vibrato);
            return operate(st, 3, &ops[3], o3 + pm, x3, vibrato);
        }
        o2 = operate(st, 1, &ops[1], 0, x1, vibrato);
        o3 = operate(st, 2, &ops[2], o2 + p2, x2, vibrato);
        if (patch->cntB) {
            int sum = o1 + o3;
            return sum + operate(st, 3, &ops[3], pm, x3, vibrato);
        }
        return o1 + operate(st, 3, &ops[3], o3 + pm, x3, vibrato);
    }
    case OPL_KIND_TOM:
        advance_envelope(st, 0, &ops[0], eg);
        return OPL_RHYTHM_MIX * operate(st, 0, &ops[0], pm, x0, vibrato);
    case OPL_KIND_SD: case OPL_KIND_TC: case OPL_KIND_HH: {
        int hp, tp, noise, phase;
        advance_envelope(st, 0, &ops[0], eg);
        st->hhPhase = st->hhPhase + (uint32_t)st->hhInc;
        st->tcPhase = st->tcPhase + (uint32_t)st->tcInc;
        hp = (int)((st->hhPhase >> 10) & 0x3ff);
        tp = (int)((st->tcPhase >> 10) & 0x3ff);
        noise = (int)(st->noise & 1);
        st->noise = (st->noise >> 1) | (((st->noise ^ (st->noise >> 14)) & 1) << 22);
        if (patch->kind == OPL_KIND_SD) {
            phase = (((hp >> 8) & 1) ? 0x200 : 0x100) ^ (noise << 8);
        } else {
            int x = (((hp >> 2) ^ (hp >> 7)) | (hp >> 3) | ((tp >> 5) ^ (tp >> 3))) & 1;
            phase = patch->kind == OPL_KIND_HH ? (x << 9) | ((x ^ noise) ? 0x0d0 : 0x034)
                                               : (x << 9) | 0x100;
        }
        return OPL_RHYTHM_MIX * rhythm_operator(st, 0, &ops[0], js_toint32(phase + pm) & 0x3ff, x0);
    }
    default:
        return 0;
    }
}

bool te_opl_channel_alive(const TaudOplState *st)
{
    const TaudOplPatch *patch = st->patch;
    int i;
    for (i = 0; i < 4; i++) {
        int s;
        if ((patch->outputs & (1 << i)) == 0) continue;
        s = st->state[i];
        if (s == EG_OFF) continue;
        if (st->env[i] >= OPL_ENV_MAX && (s != EG_ATTACK || patch->ops[i].ar == 0)) continue;
        return true;
    }
    return false;
}

/* The note volume as an attenuation: the nearest 1/256-octave step. */
static int volume_attenuation(double vol)
{
    int lo = 0, hi = 0x1800;
    if (vol >= 1) return 0;
    if (!(vol > 0)) return 0x1800;
    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        if (vol >= js_pow(2, -(double)(2 * mid + 1) / 512)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

/* The channel `st` at output frame `frame`, played at playback rate `rate`
 * with note volume `vol`, keyed off once `keyOff` is (oplRender): the voice's
 * render but its deactivation, so that something other than the voice it
 * sounds on can read a chip channel — an FM rack reading it as an operator,
 * a formant instrument as its glottal source. */
double te_opl_render(const TaudEngine *e, TaudOplState *st, int64_t frame, double rate, double vol, bool keyOff)
{
    const TaudOplPatch *patch = st->patch;
    double frac;
    int64_t k;
    if (patch == NULL) return 0;
    if (keyOff && st->keyed) te_opl_key_off(st);
    if (rate != st->rate || patch->gen != st->gen) retune(e, st, rate);
    if (vol != st->vol) { st->vol = vol; st->volAtt = volume_attenuation(vol); }
    k = te_opl_chip_index(e, frame, &frac);
    if (!st->kValid) {
        st->k = k - 1;
        st->kValid = true;
        st->noise = noise_seed(k);
    } else if (k - st->k > 8) {
        st->k = k - 1;
    }
    while (st->k < k) {
        st->k++;
        st->last = st->cur;
        st->cur = opl_chip_step(st, st->k);
    }
    return (st->last + (st->cur - st->last) * frac) * OUTPUT_SCALE;
}

double te_render_opl_voice(TaudEngine *e, TaudVoice *voice, int64_t frame)
{
    TaudOplState *st = voice->opl;
    double s;
    if (st->patch == NULL) return 0;
    s = te_opl_render(e, st, frame, voice->currentPlaybackRate, voice->currentMixVolume, voice->keyOff);
    if (!te_opl_channel_alive(st)) voice->active = false;
    return s;
}
