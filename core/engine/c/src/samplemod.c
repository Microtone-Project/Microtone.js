/* Sample-modification note effects (notefx 2 / 3) — port of samplemod.js.
 * Non-destructive views over the sample pool, applied when a byte is read. */

#include "taud_internal.h"

const int MOD_STEP[16] = { 0, 0, 1, 2, 4, 8, 2, 8, 32, 128, 0, 0, 0, 0, 0, 0 };
static const int MOD_JUMP_SLICES[2] = { 8, 16 };
static const double MOD_SCATTER_FRAC[3] = { 1.0 / 512, 1.0 / 64, 1.0 / 8 };
#define MOD_COMB_ODD_MAX 0xd

/** Step period in TICKS for speed nibble $y: $F every tick … $1 every 15th, $0 frozen. */
int te_mod_step_period(int y) { return (y & 0xf) == 0 ? 0 : 16 - (y & 0xf); }

static int uniform_floor(TaudEngine *e, double n) { return (int)floor(te_random(e) * n); }

int te_jump_rot(TaudEngine *e, int op, int domainLen)
{
    if (domainLen < 2) return 0;
    if (op == MOD_JUMP8 || op == MOD_JUMP16) {
        int slices = MOD_JUMP_SLICES[op - MOD_JUMP8];
        int slice = imax(1, (int)js_round((double)domainLen / slices));
        return (imin(uniform_floor(e, slices), slices - 1) * slice) % domainLen;
    }
    if (op != MOD_JUMP_ALL) return 0;
    return imin(uniform_floor(e, domainLen), domainLen - 1);
}

int te_scatter_reach(int op, int domainLen)
{
    int k = op - MOD_RND512;
    if (k < 0 || k > 2 || domainLen < 2) return 0;
    return imax(1, imin((int)js_round(domainLen * MOD_SCATTER_FRAC[k]), domainLen));
}

uint32_t te_scatter_seed(TaudEngine *e) { return js_touint32(te_random(e) * 4294967296.0); }

static uint32_t scatter_hash(uint32_t seed, int i)
{
    uint32_t h = (seed ^ 0x9e3779b9u) * 0x85ebca6bu;
    h ^= h >> 13;
    h = (h ^ (uint32_t)i) * 0xc2b2ae35u;
    h ^= h >> 16;
    return h;
}

static int scatter_source(int i, int domainStart, int domainLen, int reach, uint32_t seed)
{
    int span, d, k;
    if (reach <= 0 || domainLen < 2) return i;
    span = 2 * reach + 1;
    d = (int)(((uint64_t)scatter_hash(seed, i) * (uint64_t)span) >> 32) - reach;
    k = (i - domainStart + d) % domainLen;
    if (k < 0) k += domainLen;
    return domainStart + k;
}

/* Decode the $se region byte into [from, to, combBits, combOdd]. */
int te_decode_sample_region(int se, double out[4])
{
    int s = (se >> 4) & 0xf;
    int e = se & 0xf;
    if (s == 0xf && e != 0xf) { out[2] = e; out[3] = 0; return REGION_COMB; }
    if (s == 0xe && e <= MOD_COMB_ODD_MAX) { out[2] = e; out[3] = 1; return REGION_COMB; }
    out[2] = -1;
    out[3] = 0;
    if (se == 0x00) { out[0] = 0; out[1] = 1; return REGION_SET; }
    if (s <= e) { out[0] = s / 16.0; out[1] = (e + 1) / 16.0; return REGION_SET; }
    switch (se) {
    case 0x10: out[0] = 1.0 / 4; out[1] = 3.0 / 4; break;
    case 0x20: out[0] = 0;       out[1] = 2.0 / 3; break;
    case 0x21: out[0] = 1.0 / 3; out[1] = 1;       break;
    case 0x30: out[0] = 0;       out[1] = 1.0 / 3; break;
    case 0x31: out[0] = 1.0 / 3; out[1] = 2.0 / 3; break;
    case 0x32: out[0] = 2.0 / 3; out[1] = 1;       break;
    default: return REGION_NONE;
    }
    return REGION_SET;
}

const TaudModGeom *te_resolve_mod_geom(TaudModGeom *g, const TaudInst *inst, int loopStart, int loopEnd, int sampleLen)
{
    bool looped = loopEnd > loopStart;
    int base = looped ? loopStart : 0;
    int len = looped ? loopEnd - loopStart : sampleLen;
    int es, ee, bits;
    if (g->epoch == inst->modEpoch && g->inst == inst && g->base == base && g->len == len) return g;
    g->epoch = inst->modEpoch;
    g->inst = inst;
    g->base = base;
    g->len = len;
    es = base + (int)js_round(len * inst->modFrom);
    ee = base + (int)js_round(len * inst->modTo);
    g->es = es;
    g->ee = ee;
    g->live = len >= 2 && ee - es >= 2;
    bits = inst->modCombBits;
    g->combN = bits < 0 ? 0 : 2 << bits;
    g->combOdd = inst->modCombOdd;
    g->combScale = (double)g->combN / imax(ee - es, 1);
    g->ds = inst->modInvert ? base : es;
    g->dl = inst->modInvert ? len : ee - es;
    return g;
}

bool te_mod_touches(const TaudModGeom *g, bool invert, int i)
{
    bool inside = i >= g->es && i < g->ee;
    if (inside && g->combN > 0) {
        inside = (js_toint32((i - g->es) * g->combScale) & 1) == (g->combOdd ? 1 : 0);
    }
    return invert ? (!inside && i >= g->ds && i < g->ds + g->dl) : inside;
}

int te_mod_address(const TaudModGeom *g, int i, int rot, int scatter, uint32_t seed)
{
    int dl = g->dl, k;
    if (dl < 2) return i;
    if (scatter > 0) return scatter_source(i, g->ds, dl, scatter, seed);
    if (rot == 0) return i;
    k = (i - g->ds + rot) % dl;
    if (k < 0) k += dl;
    return g->ds + k;
}

/* ── argument extension (item 162) ── */

static bool f_static_range(int f, double *lo, double *hi)
{
    switch (f) {
    case 0x1: *lo = 0;       *hi = 1.0 / 2; return true;
    case 0x2: *lo = 1.0 / 2; *hi = 1;       return true;
    case 0x3: *lo = 0;       *hi = 1.0 / 3; return true;
    case 0x7: *lo = 1.0 / 3; *hi = 2.0 / 3; return true;
    case 0x8: *lo = 2.0 / 3; *hi = 1;       return true;
    case 0x4: *lo = 0;       *hi = 1.0 / 4; return true;
    case 0x5: *lo = 1.0 / 2; *hi = 3.0 / 4; return true;
    case 0x6: *lo = 1.0 / 4; *hi = 3.0 / 4; return true;
    case 0x9: *lo = 3.0 / 4; *hi = 1;       return true;
    default: return false;
    }
}

static bool f_mod_touches(int f, int i, int es, int ee, int stepIndex)
{
    int len, rel;
    double rlo, rhi;
    if (f == 0) return true;
    len = ee - es;
    if (len < 1) return true;
    rel = i - es;
    if (f_static_range(f, &rlo, &rhi)) {
        int lo = es + (int)js_round(len * rlo);
        int hi = es + (int)js_round(len * rhi);
        return i >= lo && i < hi;
    }
    if (f >= 0xa && f <= 0xd) {
        int n = f >= 0xc ? 4 : 2;
        int chunk = imin((int)floor((double)(rel * n) / len), n - 1);
        int startOdd = (f == 0xb || f == 0xd) ? 1 : 0;
        return (chunk & 1) == ((stepIndex + startOdd) & 1);
    }
    if (f == 0xe) return (rel & 7) < 4;
    if (f == 0xf) return (rel & 1) == 0;
    return true;
}

bool te_ext_mod_touches(const TaudModGeom *g, bool invert, int f, int stepIndex, int i)
{
    return te_mod_touches(g, invert, i) && f_mod_touches(f, i, g->es, g->ee, stepIndex);
}

static const int EXT_JUMP_N[16] = { 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 18, 21, 24, 32 };

double te_ext_jitter_frac(int x) { return js_pow(2.0, (x & 0xf) - 15); }

static const double EXT_SCATTER_FRAC[16] = {
    0, 1.0 / 16384, 1.0 / 8192, 1.0 / 4096, 1.0 / 2048, 1.0 / 1024, 1.0 / 512, 1.0 / 256,
    1.0 / 128, 1.0 / 64, 1.0 / 32, 1.0 / 16, 1.0 / 8, 1.0 / 4, 1.0 / 2, 1,
};

static uint8_t rev_bits8(int b)
{
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
    return (uint8_t)(b & 0xff);
}
static int swap_nibbles8(int b) { return (((b & 0xf0) >> 4) | ((b & 0x0f) << 4)) & 0xff; }
static int swap_twobits8(int b) { return (((b & 0xaa) >> 1) | ((b & 0x55) << 1)) & 0xff; }

static int bitperm(int idx, int b)
{
    switch (idx & 7) {
    case 0: return b ^ 0xff;
    case 1: return rev_bits8(b);
    case 2: return swap_nibbles8(b);
    case 3: return swap_nibbles8(rev_bits8(b));
    case 4: return swap_twobits8(b);
    case 5: return swap_twobits8(rev_bits8(b));
    case 6: return swap_twobits8(swap_nibbles8(b));
    default: return swap_twobits8(swap_nibbles8(rev_bits8(b)));
    }
}

TaudExtOp te_decode_ext_op(int code)
{
    TaudExtOp r;
    r.kind = EXT_KIND_NOOP;
    r.param = 0;
    if (code == 0 || code == 0x100) return r;
    if (code == 0x101) { r.kind = EXT_KIND_INVERT; return r; }
    if (code == 0x102) { r.kind = EXT_KIND_FUNK; return r; }
    if (code == 0x103) { r.kind = EXT_KIND_XOR; r.param = 0xff; return r; }
    if (code == 0x104) { r.kind = EXT_KIND_MIRROR; return r; }
    if (code >= 0x110 && code <= 0x11f) { r.kind = EXT_KIND_INVERT_JIT; r.param = code & 0xf; return r; }
    if (code >= 0x120 && code <= 0x12f) { r.kind = EXT_KIND_FUNK_JIT; r.param = code & 0xf; return r; }
    if (code >= 0x130 && code <= 0x14f) { r.kind = EXT_KIND_JUMP_N; r.param = EXT_JUMP_N[code & 0xf]; return r; }
    if (code >= 0x150 && code <= 0x15f) { r.kind = EXT_KIND_JUMP_N_BOUNDED; r.param = EXT_JUMP_N[code & 0xf]; return r; }
    if (code == 0x160) { r.kind = EXT_KIND_SWAP; return r; }
    if (code >= 0x161 && code <= 0x16f) { r.kind = EXT_KIND_SCATTER; r.param = EXT_SCATTER_FRAC[code & 0xf]; return r; }
    if (code >= 0x200 && code <= 0x2ff) { r.kind = EXT_KIND_ROL; r.param = code & 0xff; return r; }
    if (code >= 0x300 && code <= 0x3ff) { r.kind = EXT_KIND_ROL; r.param = -(code & 0xff); return r; }
    if (code >= 0x400 && code <= 0x4ff) { r.kind = EXT_KIND_ROL; r.param = (code & 0xff) * 256; return r; }
    if (code >= 0x500 && code <= 0x5ff) { r.kind = EXT_KIND_ROL; r.param = -(code & 0xff) * 256; return r; }
    if (code >= 0x600 && code <= 0x6ff) { r.kind = EXT_KIND_SUB; r.param = code & 0xff; return r; }
    if (code >= 0x700 && code <= 0x7ff) { r.kind = EXT_KIND_SUB; r.param = -(code & 0xff); return r; }
    if (code >= 0x800 && code <= 0x8ff) { r.kind = EXT_KIND_XOR; r.param = code & 0xff; return r; }
    if (code >= 0x900 && code <= 0x90f) { r.kind = EXT_KIND_BITROT; r.param = code & 0xf; return r; }
    if (code >= 0x910 && code <= 0x91f) { r.kind = EXT_KIND_BITROT; r.param = -(code & 0xf); return r; }
    if (code >= 0x920 && code <= 0x927) { r.kind = EXT_KIND_BITPERM; r.param = code & 0x7; return r; }
    return r;
}

static const int EXT_YK_COARSE[16] = { 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64 };

double te_ext_yk_period_ticks(int yk)
{
    int y = (yk >> 4) & 0xf;
    int k = yk & 0xf;
    if (yk == 0) return 0;
    if (y == 0xf) return EXT_YK_COARSE[k];
    return y + k / 16.0;
}

int te_mod_address_ext(const TaudModGeom *g, int i, const TaudInst *inst)
{
    if (inst->modExtSwapA >= 0) {
        if (i == inst->modExtSwapA) return inst->modExtSwapB;
        if (i == inst->modExtSwapB) return inst->modExtSwapA;
        return i;
    }
    if (inst->modExtMirror) {
        int dl = g->dl, k;
        if (dl < 2) return i;
        k = (i - g->ds) % dl;
        if (k < 0) k += dl;
        return g->ds + (dl - 1 - k);
    }
    return te_mod_address(g, i, inst->modRot, inst->modScatter, inst->modSeed);
}

static int bit_rotate8(int b, int amt)
{
    int n = ((amt % 8) + 8) % 8;
    if (n == 0) return b;
    return ((b << n) | (b >> (8 - n))) & 0xff;
}

int te_apply_ext_level(const TaudInst *inst, int b)
{
    if (inst->modSub != 0) b = (b - inst->modSub) & 0xff;
    if (inst->modXor != 0) b ^= inst->modXor;
    if (inst->modBitRot != 0) b = bit_rotate8(b, inst->modBitRot);
    if (inst->modBitPermOn) b = bitperm(inst->modBitPermIdx, b);
    return b;
}

int te_apply_ext_level_prev(const TaudInst *inst, int b)
{
    if (inst->modPrevSub != 0) b = (b - inst->modPrevSub) & 0xff;
    if (inst->modPrevXor != 0) b ^= inst->modPrevXor;
    return b;
}
