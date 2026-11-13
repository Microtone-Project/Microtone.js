/* PSG instruments — Metainstrument type 9 — port of psg.js.
 *
 * A type-9 instrument is an ordinary instrument record whose sample is a pair
 * of programmable-sound-generator oscillators, A and B, mixed by adding them
 * or by multiplying them (TAUD_FILE_FORMAT.md §7.9). Each oscillator is a
 * 0-to-1-volt generator playing a waveform; the pair is added or multiplied in
 * volts, then mapped onto the lane's ±1, each oscillator's envelope scaling
 * what the mapping makes of it. The envelope is the OPL chip's own, number for
 * number, and the PSG runs on the same chip clock (e->oplFrame) at 49716 Hz,
 * read back by linear interpolation (opl.c).
 *
 * What is not the chip's is the oscillator's internal status — its phase, the
 * noise position and the auto-advance — which a lane keeps across notes unless
 * the oscillator's X flag resets it at a key-on. The origin its LFOs run from
 * follows the same flag but is never carried: X puts it at the note's first
 * frame, and without X it is the chip clock's 0.
 *
 * Integer or IEEE-double arithmetic throughout, in the JS's order; the noise
 * tables are integer shift registers (te_psg_tables_init). */

#include <math.h>
#include <string.h>

#include "taud_internal.h"

#define PSG_HZ_PER_SPS (LINEAR_FREQ_C4_HZ / OPL_C4_RATE)

#define PSG_B_FLAGS 0
#define PSG_B_OSC 2
#define PSG_OSC_BYTES 12
#define PSG_O_ADVANCE 5
#define PSG_O_PATTERN 6

#define PSG_MIX_MULTIPLY 0x01
#define PSG_MUTE_B 0x04
#define PSG_MUTE_A 0x08

#define PSG_OF_KSR 0x01
#define PSG_OF_SUSTAIN 0x02
#define PSG_OF_RESET 0x04
#define PSG_OF_INVERT 0x08
#define PSG_OF_TREMOLO_SHIFT 4
#define PSG_OF_VIBRATO_SHIFT 6

#define PSG_WAVE_DC 0x0
#define PSG_WAVE_PULSE_LAST 0x7
#define PSG_WAVE_SAW 0x8
#define PSG_WAVE_TRIANGLE 0x9
#define PSG_WAVE_NOISE_LONG 0xa
#define PSG_WAVE_NOISE_MID 0xb
#define PSG_WAVE_NOISE_SHORT 0xc
#define PSG_WAVE_SAW4 0xd
#define PSG_WAVE_TRIANGLE4 0xe

#define PSG_TWO32 4294967296.0
#define PSG_TWO28 268435456.0
/* A common multiple of the three noise cycles, so every noise stays exact
 * across the counter's wrap. */
#define PSG_NOISE_WRAP (32767.0 * 2047 * 127)

#define PSG_ENV_TO_LOG 8
#define PSG_TL_TO_LOG 32
#define PSG_OUTPUT_SCALE (1.0 / 4096)

/* One period of a Fibonacci shift register's output from a seed of 1
 * (psgLfsrTable): 15 bits (x^15 + x^14 + 1), 11 bits (x^11 + x^9 + 1) and
 * 7 bits (x^7 + x^6 + 1). */
static void lfsr_table(uint8_t *t, int bits, int tapA, int tapB, int len)
{
    uint32_t r = 1;
    int i;
    for (i = 0; i < len; i++) {
        uint32_t fb;
        t[i] = (uint8_t)(r & 1);
        fb = ((r >> tapA) ^ (r >> tapB)) & 1;
        r = (r >> 1) | (fb << (bits - 1));
    }
}

void te_psg_tables_init(TaudEngine *e)
{
    lfsr_table(e->psgNoiseLong, 15, 0, 1, PSG_NOISE_LONG_LEN);
    lfsr_table(e->psgNoiseMid, 11, 0, 2, PSG_NOISE_MID_LEN);
    lfsr_table(e->psgNoiseShort, 7, 0, 1, PSG_NOISE_SHORT_LEN);
}

/* ToUint32 then `>>> n`, as the JS's `p >>> n` on a phase that may be NaN. */
static inline uint32_t ushr(double p, int n) { return js_touint32(p) >> n; }

/* Waveform w at 32-bit phase p, on 0…1, before the invert flag
 * (psgWaveValue); a noise reads its table at noisePos instead. A noise read
 * the JS answers `undefined` (a NaN position) is NaN here, which every use of
 * it then carries exactly as the JS carries undefined. */
static double wave_value(const TaudEngine *e, int w, double p, double noisePos)
{
    switch (w) {
    case PSG_WAVE_DC: return 1;
    case 1: case 2: case 3: case 4: case 5: case 6: case 7:
        return ushr(p, 29) < (uint32_t)(8 - w) ? 1 : 0;
    case PSG_WAVE_SAW: return 1 - p / PSG_TWO32;
    case PSG_WAVE_TRIANGLE: {
        double x = p / PSG_TWO32;
        return x < 0.5 ? 2 * x : 2 - 2 * x;
    }
    case PSG_WAVE_NOISE_LONG: case PSG_WAVE_NOISE_MID: case PSG_WAVE_NOISE_SHORT: {
        const uint8_t *t = w == PSG_WAVE_NOISE_LONG ? e->psgNoiseLong
            : w == PSG_WAVE_NOISE_MID ? e->psgNoiseMid : e->psgNoiseShort;
        int len = w == PSG_WAVE_NOISE_LONG ? PSG_NOISE_LONG_LEN
            : w == PSG_WAVE_NOISE_MID ? PSG_NOISE_MID_LEN : PSG_NOISE_SHORT_LEN;
        double i = fmod(noisePos, len);
        if (!(i >= 0)) return NAN;
        return t[(int)i];
    }
    case PSG_WAVE_SAW4: return (15 - (int)ushr(p, 28)) / 15.0;
    case PSG_WAVE_TRIANGLE4: {
        int s = (int)ushr(p, 27);                /* 32 steps a cycle */
        return (s < 16 ? s : 31 - s) / 15.0;
    }
    default: return 0;
    }
}

/* ── the patch ── */

void te_decode_psg_patch(const uint8_t *bytes, TaudPsgPatch *into)
{
    int f = bytes[PSG_B_FLAGS], i;
    into->multiply = (f & PSG_MIX_MULTIPLY) != 0;
    into->muteA = (f & PSG_MUTE_A) != 0;
    into->muteB = (f & PSG_MUTE_B) != 0;
    for (i = 0; i < 2; i++) {
        const uint8_t *o = bytes + PSG_B_OSC + i * PSG_OSC_BYTES;
        TaudPsgOscillator *osc = &into->osc[i];
        int b0 = o[0], b1 = o[1], b2 = o[2], b3 = o[3], b4 = o[4];
        int tt = (b4 >> PSG_OF_TREMOLO_SHIFT) & 3, vv = (b4 >> PSG_OF_VIBRATO_SHIFT) & 3;
        osc->wave = b0 >> 4; osc->op.ar = b0 & 15;
        osc->op.dr = b1 >> 4; osc->op.sl = OPL_SUSTAIN_LEVEL[b1 & 15];
        osc->op.rr = b2 >> 4; osc->op.mult = b2 & 15;
        osc->op.ksl = b3 >> 6; osc->op.tl = b3 & 63;
        osc->op.ksr = (b4 & PSG_OF_KSR) != 0 ? 1 : 0;
        osc->op.eg = (b4 & PSG_OF_SUSTAIN) != 0 ? 1 : 0;
        osc->reset = (b4 & PSG_OF_RESET) != 0;
        osc->invert = (b4 & PSG_OF_INVERT) != 0;
        osc->tremolo = tt == 3 ? 0 : tt;
        osc->vibrato = vv == 3 ? 0 : vv;
        osc->advance = o[PSG_O_ADVANCE];
        osc->pattern = o[PSG_O_PATTERN] & 3;
    }
    into->gen++;
}

/* ── the run-time overlay (S $Axxx) ── */

void te_psg_clear_runtime(TaudPsgPatch *patch)
{
    if (patch->rtAdvance[0] == -1 && patch->rtAdvance[1] == -1 &&
        patch->rtLevel[0] == -1 && patch->rtLevel[1] == -1 && patch->rtMute == -1) return;
    patch->rtAdvance[0] = patch->rtAdvance[1] = -1;
    patch->rtLevel[0] = patch->rtLevel[1] = -1;
    patch->rtMute = -1;
    patch->rtGen++;
}

/* $000…$0FF / $800…$8FF an auto-advance, $100…$13F / $900…$93F a level,
 * $F00…$F03 the two mutes outright; anything else does nothing. */
bool te_psg_write_register(TaudPsgPatch *patch, int reg)
{
    int r = reg & 0xfff;
    int i = (r & 0x800) != 0 ? 1 : 0;
    int hi = (r >> 8) & 0x7;
    if (r >= 0xf00) {
        if (r > 0xf03) return false;
        patch->rtMute = r & 3;
    } else if (hi == 0) {
        patch->rtAdvance[i] = r & 0xff;
    } else if (hi == 1 && (r & 0xff) <= 0x3f) {
        patch->rtLevel[i] = r & 0x3f;
    } else {
        return false;
    }
    patch->rtGen++;
    return true;
}

static int psg_level(const TaudPsgPatch *patch, int i)
{
    int v = patch->rtLevel[i];
    return v >= 0 ? v : patch->osc[i].op.tl;
}

static int psg_advance(const TaudPsgPatch *patch, int i)
{
    int v = patch->rtAdvance[i];
    return v >= 0 ? v : patch->osc[i].advance;
}

static bool psg_muted(const TaudPsgPatch *patch, int i)
{
    if (patch->rtMute >= 0) return ((patch->rtMute >> i) & 1) != 0;
    return i == 0 ? patch->muteA : patch->muteB;
}

/* ── the voice ── */

/* A fresh pair, as `new PsgState()` leaves one. */
void te_psg_state_init(TaudPsgState *st)
{
    memset(st, 0, sizeof *st);
    st->gen = -1;
    st->rate = -1;
    st->env[0] = st->env[1] = OPL_ENV_MAX;
    st->kValid = true;          /* the constructor's k is -1, not NaN */
    st->k = -1;
}

void te_psg_key_on(TaudPsgState *st, TaudPsgPatch *patch, bool carry)
{
    int i;
    st->patch = patch;
    st->gen = -1;
    st->rate = -1;
    if (!carry) {
        st->env[0] = st->env[1] = OPL_ENV_MAX;
        st->cur = 0;
        st->last = 0;
        st->kValid = false;
    }
    for (i = 0; i < 2; i++) {
        st->state[i] = EG_ATTACK;
        if (patch->osc[i].reset) {
            st->phase[i] = 0;
            st->noise[i] = 0;
            st->adv[i] = 0;
            st->advCount[i] = 0;
            st->lfo[i] = NAN;               /* anchored at the first frame rendered */
        } else {
            st->lfo[i] = 0;                 /* the chip clock itself */
        }
    }
    st->keyed = true;
}

void te_psg_key_off(TaudPsgState *st)
{
    int i;
    for (i = 0; i < 2; i++) if (st->state[i] != EG_OFF) st->state[i] = EG_RELEASE;
    st->keyed = false;
}

void te_psg_reattack(TaudPsgState *st)
{
    st->state[0] = st->state[1] = EG_ATTACK;
    st->keyed = true;
}

/* The auto-advance's four patterns, as offsets from the record's pulse. */
static const uint8_t PATTERN0[12] = { 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2 };
static const uint8_t PATTERN1[6] = { 1, 3, 5, 7, 5, 3 };
static const uint8_t PATTERN2[4] = { 1, 4, 7, 4 };
static const uint8_t PATTERN3[2] = { 1, 4 };
static const uint8_t *const PATTERNS[4] = { PATTERN0, PATTERN1, PATTERN2, PATTERN3 };
static const int PATTERN_LEN[4] = { 12, 6, 4, 2 };

static bool advances(int w) { return w >= 1 && w <= PSG_WAVE_PULSE_LAST; }

int te_psg_current_wave(const TaudPsgState *st, int i)
{
    const TaudPsgOscillator *osc = &st->patch->osc[i];
    int w = osc->wave, k;
    if (!advances(w)) return w;
    k = PATTERNS[osc->pattern][st->adv[i] % PATTERN_LEN[osc->pattern]];
    return ((w - 1 + k - 1) % 7) + 1;
}

/* One quarter tick of the auto-advance (psgQuarterTick). */
void te_psg_quarter_tick(TaudPsgState *st)
{
    const TaudPsgPatch *patch = st->patch;
    int i;
    if (patch == NULL) return;
    for (i = 0; i < 2; i++) {
        int n = psg_advance(patch, i);
        if (n == 0 || !advances(patch->osc[i].wave)) { st->advCount[i] = 0; continue; }
        if (++st->advCount[i] >= n) {
            st->advCount[i] = 0;
            st->adv[i] = (uint8_t)((st->adv[i] + 1) % PATTERN_LEN[patch->osc[i].pattern]);
        }
    }
}

/* The quarter of its tick a playhead is in, `into` frames into a tick of
 * `spt` frames: 0…3. */
int te_psg_quarter_at(double into, double spt)
{
    double q = floor((into * 4) / spt);
    return q < 0 ? 0 : q > 3 ? 3 : (int)q;
}

static void psg_retune(const TaudEngine *e, TaudPsgState *st, double rate)
{
    const TaudPsgPatch *patch = st->patch;
    double hz = rate * e->rate * PSG_HZ_PER_SPS;
    int i;
    for (i = 0; i < 2; i++) {
        const TaudPsgOscillator *osc = &patch->osc[i];
        int32_t scale[2];
        double inc;
        te_opl_key_scaling(hz, osc->op.ksr, osc->op.ksl, scale);
        st->ksrOffset[i] = scale[0];
        st->kslAtt[i] = scale[1];
        inc = js_round((hz * OPL_MULTIPLE_X2[osc->op.mult] * PSG_TWO32) / (2 * OPL_RATE_HZ));
        st->inc[i] = inc < 0 ? 0 : inc >= PSG_TWO32 ? PSG_TWO32 - 1 : inc;
    }
    st->rate = rate;
    st->gen = patch->gen;
}

/* Oscillator i for one chip sample at chip clock k (psgOscStep): its waveform
 * in volts, 0…1 with the invert applied, and its gain left in st->gain[i]. */
static double psg_osc_step(const TaudEngine *e, TaudPsgState *st, int i, int64_t k)
{
    const TaudPsgPatch *patch = st->patch;
    const TaudPsgOscillator *osc = &patch->osc[i];
    double lk, inc, old, next, steps, att, p, v;
    int w;
    te_opl_advance_envelope(&st->state[i], &st->env[i], st->ksrOffset[i], &osc->op, (int32_t)(uint32_t)k);
    if (isnan(st->lfo[i])) st->lfo[i] = (double)k;
    lk = (double)k - st->lfo[i];                /* never negative: every key-on sets the origin */
    inc = st->inc[i];
    if (osc->vibrato != 0) {
        double vib = te_opl_vibrato_at(osc->vibrato - 1, (int)fmod(lk, OPL_VIBRATO_PERIOD));
        if (vib != 1) inc = js_round(inc * vib);
    }
    /* The noise is clocked by the phase: one step each 1/16 of a cycle crossed. */
    old = st->phase[i];
    next = old + inc;
    steps = floor(next / PSG_TWO28) - floor(old / PSG_TWO28);
    if (steps != 0) st->noise[i] = fmod(st->noise[i] + steps, PSG_NOISE_WRAP);
    st->phase[i] = next >= PSG_TWO32 ? next - PSG_TWO32 * floor(next / PSG_TWO32) : next;
    if (st->state[i] == EG_OFF) { st->gain[i] = 0; return 0; }
    att = (st->env[i] + st->kslAtt[i]) * PSG_ENV_TO_LOG + psg_level(patch, i) * PSG_TL_TO_LOG;
    if (osc->tremolo != 0) att += te_opl_tremolo_at(osc->tremolo - 1, (int)fmod(lk, OPL_TREMOLO_PERIOD));
    st->gain[i] = te_opl_expand(att);
    w = te_psg_current_wave(st, i);
    p = fmod(st->phase[i] + st->pm, PSG_TWO32);
    v = wave_value(e, w, p, st->noise[i]);
    return osc->invert ? 1 - v : v;             /* 0…1 turned over: DC <-> silence */
}

/* The pair's next chip sample (psgChipStep). Both oscillators always run,
 * muted or not; with one muted the other passes through untouched. */
static double psg_chip_step(const TaudEngine *e, TaudPsgState *st, int64_t k)
{
    double a = psg_osc_step(e, st, 0, k);
    double b = psg_osc_step(e, st, 1, k);
    double ga = st->gain[0], gb = st->gain[1];
    const TaudPsgPatch *patch = st->patch;
    bool ma = psg_muted(patch, 0), mb = psg_muted(patch, 1);
    if (ma) return mb ? 0 : (2 * b - 1) * gb;
    if (mb) return (2 * a - 1) * ga;
    return patch->multiply
        ? (2 * a * b - 1) * ((ga * gb) / 4084)
        : (2 * a - 1) * ga + (2 * b - 1) * gb;
}

static bool psg_osc_alive(const TaudPsgState *st, int i)
{
    int s = st->state[i];
    if (s == EG_OFF) return false;
    return !(st->env[i] >= OPL_ENV_MAX && (s != EG_ATTACK || st->patch->osc[i].op.ar == 0));
}

bool te_psg_channel_alive(const TaudPsgState *st)
{
    if (st->patch == NULL) return false;
    return psg_osc_alive(st, 0) || psg_osc_alive(st, 1);
}

/* The pair at output frame `frame`, on the lane's ±1 (psgRender). The note
 * volume is not applied: the mixer applies it, as to a sample's. */
double te_psg_render(const TaudEngine *e, TaudPsgState *st, int64_t frame, double rate, bool keyOff)
{
    const TaudPsgPatch *patch = st->patch;
    double frac;
    int64_t k;
    if (patch == NULL) return 0;
    if (keyOff && st->keyed) te_psg_key_off(st);
    if (rate != st->rate || patch->gen != st->gen) psg_retune(e, st, rate);
    k = te_opl_chip_index(e, frame, &frac);
    if (!st->kValid || k - st->k > 8) { st->k = k - 1; st->kValid = true; }
    while (st->k < k) {
        st->k++;
        st->last = st->cur;
        st->cur = psg_chip_step(e, st, st->k);
    }
    return (st->last + (st->cur - st->last) * frac) * PSG_OUTPUT_SCALE;
}

double te_render_psg_voice(TaudEngine *e, TaudVoice *voice, int64_t frame)
{
    TaudPsgState *st = voice->psg;
    double s;
    if (st->patch == NULL) return 0;
    s = te_psg_render(e, st, frame, voice->currentPlaybackRate, voice->keyOff);
    if (!te_psg_channel_alive(st)) voice->active = false;
    return s;
}
