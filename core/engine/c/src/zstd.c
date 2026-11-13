/* A small, bounds-checked Zstandard decoder (RFC 8878) — frames, raw/RLE/
 * compressed blocks, Huffman literals, FSE sequences, repeat offsets and
 * skippable frames. No dictionaries. Decodes into one growing buffer, so the
 * whole output is the window. Written for the Taud container's sections; the
 * JavaScript library vendors fzstd for the same job. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

/* ── output buffer ── */

typedef struct {
    uint8_t *buf;
    size_t len, cap;
    bool fail;
} Out;

static bool out_reserve(Out *o, size_t extra)
{
    size_t need = o->len + extra;
    if (o->fail) return false;
    if (need < o->len) { o->fail = true; return false; }
    if (need > o->cap || o->buf == NULL) {
        size_t nc = o->cap ? o->cap : 65536;
        uint8_t *nb;
        while (nc < need) { nc *= 2; if (nc < o->cap) { o->fail = true; return false; } }
        nb = (uint8_t *)realloc(o->buf, nc);
        if (nb == NULL) { o->fail = true; return false; }
        o->buf = nb;
        o->cap = nc;
    }
    return true;
}

/* ── backward bit reader: bits are consumed from the END of the stream ── */

typedef struct {
    const uint8_t *p;
    size_t len;
    int64_t pos;        /* bits still unread; negative = read past the start */
} BitsBack;

static bool bb_init(BitsBack *b, const uint8_t *p, size_t len)
{
    int hb = 7;
    b->p = p;
    b->len = len;
    if (len == 0 || p[len - 1] == 0) return false;
    while (((p[len - 1] >> hb) & 1) == 0) hb--;
    b->pos = (int64_t)(len - 1) * 8 + hb;   /* the marker bit itself is dropped */
    return true;
}

static inline uint32_t bb_peek_at(const BitsBack *b, int64_t lo, int n)
{
    /* n bits starting at bit `lo` (LSB-first); bits before the start are 0. */
    uint64_t v = 0;
    int64_t firstByte, k;
    int shift;
    if (n == 0) return 0;
    if (lo < 0) {
        int drop = (int)-lo;
        if (drop >= n) return 0;
        return bb_peek_at(b, 0, n - drop) << drop;
    }
    firstByte = lo >> 3;
    shift = (int)(lo & 7);
    for (k = 0; k < 8 && firstByte + k < (int64_t)b->len; k++) v |= (uint64_t)b->p[firstByte + k] << (8 * k);
    return (uint32_t)((v >> shift) & ((n >= 32) ? 0xffffffffu : ((1u << n) - 1)));
}

static inline uint32_t bb_read(BitsBack *b, int n)
{
    uint32_t v;
    b->pos -= n;
    v = bb_peek_at(b, b->pos, n);
    return v;
}

/* ── forward bit reader (FSE table descriptions) ── */

typedef struct { const uint8_t *p; size_t len; size_t bit; } BitsFwd;

static uint32_t bf_peek(const BitsFwd *b, int n)
{
    uint64_t v = 0;
    size_t byte = b->bit >> 3;
    int k;
    for (k = 0; k < 8 && byte + k < b->len; k++) v |= (uint64_t)b->p[byte + k] << (8 * k);
    return (uint32_t)((v >> (b->bit & 7)) & ((1ull << n) - 1));
}

/* ── FSE ── */

#define FSE_MAX_LOG 9
typedef struct { uint16_t base; uint8_t sym, nb; } FseCell;
typedef struct { int log; FseCell cell[1 << FSE_MAX_LOG]; } FseTable;

static int highbit32(uint32_t v) { int n = -1; while (v) { v >>= 1; n++; } return n; }

static bool fse_build(FseTable *t, const int16_t *prob, int maxSym, int log)
{
    int size = 1 << log, high = size - 1, s, i, pos = 0;
    int step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
    uint16_t next[256];
    t->log = log;
    for (s = 0; s <= maxSym; s++) {
        if (prob[s] == -1) {
            t->cell[high--].sym = (uint8_t)s;
            next[s] = 1;
        } else {
            next[s] = (uint16_t)(prob[s] > 0 ? prob[s] : 0);
        }
    }
    for (s = 0; s <= maxSym; s++) {
        for (i = 0; i < prob[s]; i++) {
            t->cell[pos].sym = (uint8_t)s;
            do pos = (pos + step) & mask; while (pos > high);
        }
    }
    if (pos != 0) return false;
    for (i = 0; i < size; i++) {
        int sym = t->cell[i].sym;
        int ns = next[sym]++;
        int nb = log - highbit32((uint32_t)ns);
        t->cell[i].nb = (uint8_t)nb;
        t->cell[i].base = (uint16_t)((ns << nb) - size);
    }
    return true;
}

/* Read an FSE table description at `src`; returns bytes consumed or 0. */
static size_t fse_read(FseTable *t, const uint8_t *src, size_t len, int maxLog, int maxSym)
{
    BitsFwd b;
    int16_t prob[256];
    int log, remaining, threshold, nbBits, sym = 0;
    if (len < 1) return 0;
    b.p = src; b.len = len; b.bit = 0;
    log = (int)bf_peek(&b, 4) + 5;
    b.bit += 4;
    if (log > maxLog) return 0;
    remaining = (1 << log) + 1;
    threshold = 1 << log;
    nbBits = log + 1;
    memset(prob, 0, sizeof prob);
    while (remaining > 1 && sym <= maxSym) {
        int max = 2 * threshold - 1 - remaining;
        int count;
        uint32_t v = bf_peek(&b, nbBits);
        if ((int)(v & (uint32_t)(threshold - 1)) < max) {
            count = (int)(v & (uint32_t)(threshold - 1));
            b.bit += (size_t)(nbBits - 1);
        } else {
            count = (int)(v & (uint32_t)(2 * threshold - 1));
            if (count >= threshold) count -= max;
            b.bit += (size_t)nbBits;
        }
        count--;
        remaining -= count < 0 ? -count : count;
        prob[sym++] = (int16_t)count;
        if (count == 0) {
            for (;;) {
                int rep = (int)bf_peek(&b, 2);
                b.bit += 2;
                sym += rep;
                if (rep != 3) break;
            }
        }
        while (remaining < threshold && threshold > 1) { nbBits--; threshold >>= 1; }
        if ((b.bit >> 3) > len) return 0;
    }
    if (remaining != 1 || sym > maxSym + 1) return 0;
    if (!fse_build(t, prob, sym - 1, log)) return 0;
    return (b.bit + 7) >> 3;
}

static void fse_rle(FseTable *t, int sym)
{
    t->log = 0;
    t->cell[0].sym = (uint8_t)sym;
    t->cell[0].nb = 0;
    t->cell[0].base = 0;
}

static const int16_t LL_DEFAULT[36] = {
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
    -1, -1, -1, -1
};
static const int16_t ML_DEFAULT[53] = {
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1
};
static const int16_t OF_DEFAULT[29] = {
    1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1
};

static const uint32_t LL_BASE[36] = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536
};
static const uint8_t LL_BITS[36] = {
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
};
static const uint32_t ML_BASE[53] = {
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099,
    8195, 16387, 32771, 65539
};
static const uint8_t ML_BITS[53] = {
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
};

/* ── Huffman ── */

#define HUF_MAX_BITS 11
typedef struct { int maxBits; uint8_t sym[1 << HUF_MAX_BITS]; uint8_t nb[1 << HUF_MAX_BITS]; } HufTable;

static bool huf_build(HufTable *h, const uint8_t *w, int n)
{
    uint32_t total = 0, rest;
    int maxBits, i, lastW;
    int rankStart[HUF_MAX_BITS + 2];
    int rankCount[HUF_MAX_BITS + 2];
    uint8_t weights[256];
    if (n < 1 || n > 255) return false;
    for (i = 0; i < n; i++) {
        if (w[i] > HUF_MAX_BITS) return false;
        if (w[i]) total += 1u << (w[i] - 1);
    }
    if (total == 0) return false;
    maxBits = highbit32(total) + 1;
    if (maxBits > HUF_MAX_BITS) return false;
    rest = (1u << maxBits) - total;
    if (rest == 0 || (rest & (rest - 1)) != 0) return false;
    lastW = highbit32(rest) + 1;
    memcpy(weights, w, (size_t)n);
    weights[n] = (uint8_t)lastW;
    n++;
    memset(rankCount, 0, sizeof rankCount);
    for (i = 0; i < n; i++) rankCount[weights[i]]++;
    {
        int next = 0, r;
        for (r = 1; r <= maxBits; r++) { rankStart[r] = next; next += rankCount[r] << (r - 1); }
        if (next != (1 << maxBits)) return false;
    }
    for (i = 0; i < n; i++) {
        int wt = weights[i], len, u;
        if (wt == 0) continue;
        len = 1 << (wt - 1);
        for (u = rankStart[wt]; u < rankStart[wt] + len; u++) {
            h->sym[u] = (uint8_t)i;
            h->nb[u] = (uint8_t)(maxBits + 1 - wt);
        }
        rankStart[wt] += len;
    }
    h->maxBits = maxBits;
    return true;
}

/* Read a Huffman tree description; returns bytes consumed or 0. */
static size_t huf_read(HufTable *h, const uint8_t *src, size_t len)
{
    uint8_t w[256];
    int n = 0;
    size_t used;
    int hb;
    if (len < 1) return 0;
    hb = src[0];
    if (hb < 128) {
        FseTable t;
        BitsBack b;
        size_t tb;
        int s1, s2;
        if ((size_t)hb + 1 > len) return 0;
        tb = fse_read(&t, src + 1, (size_t)hb, 6, 255);
        if (tb == 0 || tb > (size_t)hb) return 0;
        if (!bb_init(&b, src + 1 + tb, (size_t)hb - tb)) return 0;
        s1 = (int)bb_read(&b, t.log);
        s2 = (int)bb_read(&b, t.log);
        for (;;) {
            if (n >= 255) return 0;
            w[n++] = t.cell[s1].sym;
            s1 = t.cell[s1].base + (int)bb_read(&b, t.cell[s1].nb);
            if (b.pos < 0) { w[n++] = t.cell[s2].sym; break; }
            if (n >= 255) return 0;
            w[n++] = t.cell[s2].sym;
            s2 = t.cell[s2].base + (int)bb_read(&b, t.cell[s2].nb);
            if (b.pos < 0) { w[n++] = t.cell[s1].sym; break; }
        }
        used = (size_t)hb + 1;
    } else {
        int k;
        n = hb - 127;
        used = 1 + (size_t)((n + 1) / 2);
        if (used > len) return 0;
        for (k = 0; k < n; k += 2) {
            w[k] = src[1 + k / 2] >> 4;
            if (k + 1 < n) w[k + 1] = src[1 + k / 2] & 15;
        }
    }
    if (n > 255 || !huf_build(h, w, n)) return 0;
    return used;
}

static bool huf_stream(const HufTable *h, const uint8_t *src, size_t len, uint8_t *out, size_t count)
{
    BitsBack b;
    size_t i;
    int mb = h->maxBits;
    if (!bb_init(&b, src, len)) return false;
    for (i = 0; i < count; i++) {
        uint32_t idx = bb_peek_at(&b, b.pos - mb, mb);
        out[i] = h->sym[idx];
        b.pos -= h->nb[idx];
    }
    return b.pos == 0;
}

/* ── frame state ── */

typedef struct {
    HufTable huf;
    bool hasHuf;
    FseTable ll, of, ml;
    bool hasLL, hasOF, hasML;
    uint32_t rep[3];
    uint8_t *lit;
    size_t litCap;
} Frame;

static bool decode_literals(Frame *f, const uint8_t *src, size_t len, size_t *used, size_t *litLen)
{
    int type, sf;
    size_t regen, comp = 0, hsz;
    if (len < 1) return false;
    type = src[0] & 3;
    sf = (src[0] >> 2) & 3;
    if (type < 2) {
        if (sf == 0 || sf == 2) { hsz = 1; regen = src[0] >> 3; }
        else if (sf == 1) { if (len < 2) return false; hsz = 2; regen = (src[0] >> 4) | ((size_t)src[1] << 4); }
        else { if (len < 3) return false; hsz = 3; regen = (src[0] >> 4) | ((size_t)src[1] << 4) | ((size_t)src[2] << 12); }
    } else {
        uint64_t hdr;
        int bits;
        hsz = sf <= 1 ? 3 : sf == 2 ? 4 : 5;
        if (len < hsz) return false;
        hdr = 0;
        { size_t k; for (k = 0; k < hsz; k++) hdr |= (uint64_t)src[k] << (8 * k); }
        bits = sf <= 1 ? 10 : sf == 2 ? 14 : 18;
        regen = (size_t)((hdr >> 4) & ((1u << bits) - 1));
        comp = (size_t)((hdr >> (4 + bits)) & ((1u << bits) - 1));
    }
    if (f->lit == NULL || regen > f->litCap) {
        uint8_t *nb = (uint8_t *)realloc(f->lit, regen + 64);
        if (nb == NULL) return false;
        f->lit = nb;
        f->litCap = regen + 64;
    }
    if (type == 0) {
        if (hsz + regen > len) return false;
        memcpy(f->lit, src + hsz, regen);
        *used = hsz + regen;
    } else if (type == 1) {
        if (hsz + 1 > len) return false;
        memset(f->lit, src[hsz], regen);
        *used = hsz + 1;
    } else {
        const uint8_t *p = src + hsz;
        size_t avail;
        bool four = sf != 0;
        if (hsz + comp > len) return false;
        avail = comp;
        if (type == 2) {
            size_t t = huf_read(&f->huf, p, avail);
            if (t == 0) return false;
            f->hasHuf = true;
            p += t;
            avail -= t;
        } else if (!f->hasHuf) {
            return false;
        }
        if (!four) {
            if (!huf_stream(&f->huf, p, avail, f->lit, regen)) return false;
        } else {
            size_t s1, s2, s3, s4, seg = (regen + 3) / 4, o = 6;
            if (avail < 6) return false;
            s1 = p[0] | ((size_t)p[1] << 8);
            s2 = p[2] | ((size_t)p[3] << 8);
            s3 = p[4] | ((size_t)p[5] << 8);
            if (o + s1 + s2 + s3 > avail || 3 * seg > regen) return false;
            s4 = avail - o - s1 - s2 - s3;
            if (!huf_stream(&f->huf, p + o, s1, f->lit, seg)) return false;
            o += s1;
            if (!huf_stream(&f->huf, p + o, s2, f->lit + seg, seg)) return false;
            o += s2;
            if (!huf_stream(&f->huf, p + o, s3, f->lit + 2 * seg, seg)) return false;
            o += s3;
            if (!huf_stream(&f->huf, p + o, s4, f->lit + 3 * seg, regen - 3 * seg)) return false;
        }
        *used = hsz + comp;
    }
    *litLen = regen;
    return true;
}

static size_t read_table(FseTable *t, bool *has, int mode, const uint8_t *src, size_t len,
                         const int16_t *def, int defMax, int defLog, int maxLog, int maxSym)
{
    switch (mode) {
    case 0:
        fse_build(t, def, defMax, defLog);
        *has = true;
        return 0;
    case 1:
        if (len < 1 || src[0] > maxSym) return (size_t)-1;
        fse_rle(t, src[0]);
        *has = true;
        return 1;
    case 2: {
        size_t n = fse_read(t, src, len, maxLog, maxSym);
        if (n == 0) return (size_t)-1;
        *has = true;
        return n;
    }
    default:
        return *has ? 0 : (size_t)-1;
    }
}

static bool decode_block(Frame *f, Out *o, const uint8_t *src, size_t len)
{
    size_t used, litLen, p, nseq, litPos = 0, s;
    int modes;
    BitsBack b;
    int sLL, sOF, sML;

    if (!decode_literals(f, src, len, &used, &litLen)) return false;
    p = used;
    if (p >= len) return false;
    nseq = src[p++];
    if (nseq >= 128) {
        if (nseq == 255) {
            if (p + 2 > len) return false;
            nseq = src[p] + ((size_t)src[p + 1] << 8) + 0x7f00;
            p += 2;
        } else {
            if (p + 1 > len) return false;
            nseq = ((nseq - 128) << 8) + src[p];
            p += 1;
        }
    }
    if (nseq == 0) {
        if (!out_reserve(o, litLen)) return false;
        memcpy(o->buf + o->len, f->lit, litLen);
        o->len += litLen;
        return true;
    }
    if (p >= len) return false;
    modes = src[p++];
    if ((modes & 3) != 0) return false;
    {
        size_t n;
        n = read_table(&f->ll, &f->hasLL, (modes >> 6) & 3, src + p, len - p, LL_DEFAULT, 35, 6, 9, 35);
        if (n == (size_t)-1) return false;
        p += n;
        n = read_table(&f->of, &f->hasOF, (modes >> 4) & 3, src + p, len - p, OF_DEFAULT, 28, 5, 8, 31);
        if (n == (size_t)-1) return false;
        p += n;
        n = read_table(&f->ml, &f->hasML, (modes >> 2) & 3, src + p, len - p, ML_DEFAULT, 52, 6, 9, 52);
        if (n == (size_t)-1) return false;
        p += n;
    }
    if (p > len || !bb_init(&b, src + p, len - p)) return false;
    sLL = (int)bb_read(&b, f->ll.log);
    sOF = (int)bb_read(&b, f->of.log);
    sML = (int)bb_read(&b, f->ml.log);

    for (s = 0; s < nseq; s++) {
        int llc = f->ll.cell[sLL].sym, ofc = f->of.cell[sOF].sym, mlc = f->ml.cell[sML].sym;
        uint32_t ofv, offset, ml, ll;
        size_t k;
        if (llc > 35 || mlc > 52 || ofc > 31) return false;
        ofv = (1u << ofc) + bb_read(&b, ofc);
        ml = ML_BASE[mlc] + bb_read(&b, ML_BITS[mlc]);
        ll = LL_BASE[llc] + bb_read(&b, LL_BITS[llc]);
        if (ofv > 3) {
            offset = ofv - 3;
            f->rep[2] = f->rep[1]; f->rep[1] = f->rep[0]; f->rep[0] = offset;
        } else {
            uint32_t idx = ofv + (ll == 0 ? 1 : 0);
            if (idx == 1) offset = f->rep[0];
            else if (idx == 2) { offset = f->rep[1]; f->rep[1] = f->rep[0]; f->rep[0] = offset; }
            else if (idx == 3) { offset = f->rep[2]; f->rep[2] = f->rep[1]; f->rep[1] = f->rep[0]; f->rep[0] = offset; }
            else { offset = f->rep[0] - 1; f->rep[2] = f->rep[1]; f->rep[1] = f->rep[0]; f->rep[0] = offset; }
        }
        if (s + 1 < nseq) {
            sLL = f->ll.cell[sLL].base + (int)bb_read(&b, f->ll.cell[sLL].nb);
            sML = f->ml.cell[sML].base + (int)bb_read(&b, f->ml.cell[sML].nb);
            sOF = f->of.cell[sOF].base + (int)bb_read(&b, f->of.cell[sOF].nb);
        }
        if (litPos + ll > litLen) return false;
        if (!out_reserve(o, (size_t)ll + ml)) return false;
        memcpy(o->buf + o->len, f->lit + litPos, ll);
        o->len += ll;
        litPos += ll;
        if (offset == 0 || offset > o->len) return false;
        {
            uint8_t *dst = o->buf + o->len;
            const uint8_t *from = dst - offset;
            for (k = 0; k < ml; k++) dst[k] = from[k];
            o->len += ml;
        }
    }
    if (b.pos != 0) return false;
    if (!out_reserve(o, litLen - litPos)) return false;
    memcpy(o->buf + o->len, f->lit + litPos, litLen - litPos);
    o->len += litLen - litPos;
    return true;
}

uint8_t *te_zstd_decompress(const uint8_t *src, size_t len, size_t expected, size_t *outLen)
{
    Out o;
    size_t p = 0;
    Frame *f = (Frame *)calloc(1, sizeof *f);
    if (f == NULL) return NULL;
    memset(&o, 0, sizeof o);
    if (expected > 0 && !out_reserve(&o, expected)) { free(f); return NULL; }

    while (p + 4 <= len) {
        uint32_t magic = (uint32_t)src[p] | ((uint32_t)src[p + 1] << 8) | ((uint32_t)src[p + 2] << 16) |
                         ((uint32_t)src[p + 3] << 24);
        if ((magic & 0xfffffff0u) == 0x184d2a50u) {
            uint32_t sz;
            if (p + 8 > len) goto fail;
            sz = (uint32_t)src[p + 4] | ((uint32_t)src[p + 5] << 8) | ((uint32_t)src[p + 6] << 16) |
                 ((uint32_t)src[p + 7] << 24);
            if (sz > len - p - 8) goto fail;
            p += 8 + sz;
            continue;
        }
        if (magic != 0xfd2fb528u) goto fail;
        p += 4;
        {
            int fhd, fcsFlag, single, checksum, dictFlag, fcsSize;
            bool last = false;
            if (p >= len) goto fail;
            fhd = src[p++];
            fcsFlag = fhd >> 6;
            single = (fhd >> 5) & 1;
            checksum = (fhd >> 2) & 1;
            dictFlag = fhd & 3;
            if (fhd & 8) goto fail;
            if (!single) p++;
            p += dictFlag == 3 ? 4 : (size_t)dictFlag;
            fcsSize = fcsFlag == 0 ? (single ? 1 : 0) : 1 << fcsFlag;
            p += (size_t)fcsSize;
            if (p > len) goto fail;
            f->hasHuf = f->hasLL = f->hasOF = f->hasML = false;
            f->rep[0] = 1; f->rep[1] = 4; f->rep[2] = 8;
            while (!last) {
                uint32_t bh;
                int type;
                size_t bsz;
                if (p + 3 > len) goto fail;
                bh = (uint32_t)src[p] | ((uint32_t)src[p + 1] << 8) | ((uint32_t)src[p + 2] << 16);
                p += 3;
                last = (bh & 1) != 0;
                type = (bh >> 1) & 3;
                bsz = bh >> 3;
                if (type == 0) {
                    if (bsz > len - p || !out_reserve(&o, bsz)) goto fail;
                    memcpy(o.buf + o.len, src + p, bsz);
                    o.len += bsz;
                    p += bsz;
                } else if (type == 1) {
                    if (p >= len || !out_reserve(&o, bsz)) goto fail;
                    memset(o.buf + o.len, src[p], bsz);
                    o.len += bsz;
                    p += 1;
                } else if (type == 2) {
                    if (bsz > len - p || !decode_block(f, &o, src + p, bsz)) goto fail;
                    p += bsz;
                } else {
                    goto fail;
                }
            }
            if (checksum) p += 4;
        }
    }
    free(f->lit);
    free(f);
    if (o.len < expected) {
        if (!out_reserve(&o, expected - o.len)) { free(o.buf); return NULL; }
        memset(o.buf + o.len, 0, expected - o.len);
        /* fzstd, handed an output buffer, returns all of it. */
        *outLen = expected;
        return o.buf;
    }
    if (o.buf == NULL) o.buf = (uint8_t *)malloc(1);
    *outLen = o.len;
    return o.buf;

fail:
    free(f->lit);
    free(f);
    free(o.buf);
    return NULL;
}
