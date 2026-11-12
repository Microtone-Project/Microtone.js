/* A compact, bounds-checked inflate (RFC 1951) behind a gzip wrapper
 * (RFC 1952), and the section-codec dispatcher of compress.js: TSVM sniffs
 * the magic, so a section may be gzip or zstd. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

typedef struct {
    const uint8_t *src;
    size_t len, pos;
    uint32_t bitbuf;
    int bitcnt;
    uint8_t *out;
    size_t outLen, outCap;
    bool fail;
} Inflate;

static int getbit(Inflate *s, int n)
{
    uint32_t v;
    while (s->bitcnt < n) {
        if (s->pos >= s->len) { s->fail = true; return 0; }
        s->bitbuf |= (uint32_t)s->src[s->pos++] << s->bitcnt;
        s->bitcnt += 8;
    }
    v = s->bitbuf & ((1u << n) - 1);
    s->bitbuf >>= n;
    s->bitcnt -= n;
    return (int)v;
}

static bool put(Inflate *s, size_t extra)
{
    if (s->outLen + extra > s->outCap || s->out == NULL) {
        size_t nc = s->outCap ? s->outCap : 65536;
        uint8_t *nb;
        while (nc < s->outLen + extra) nc *= 2;
        nb = (uint8_t *)realloc(s->out, nc);
        if (nb == NULL) { s->fail = true; return false; }
        s->out = nb;
        s->outCap = nc;
    }
    return true;
}

typedef struct { int16_t count[16]; int16_t symbol[320]; } Huff;

static bool huff_build(Huff *h, const uint8_t *lengths, int n)
{
    int16_t offs[16];
    int len, sym, left = 1;
    memset(h->count, 0, sizeof h->count);
    for (sym = 0; sym < n; sym++) h->count[lengths[sym]]++;
    if (h->count[0] == n) return true;
    for (len = 1; len < 16; len++) {
        left <<= 1;
        left -= h->count[len];
        if (left < 0) return false;
    }
    offs[1] = 0;
    for (len = 1; len < 15; len++) offs[len + 1] = (int16_t)(offs[len] + h->count[len]);
    for (sym = 0; sym < n; sym++) if (lengths[sym] != 0) h->symbol[offs[lengths[sym]]++] = (int16_t)sym;
    return true;
}

static int huff_decode(Inflate *s, const Huff *h)
{
    int code = 0, first = 0, index = 0, len;
    for (len = 1; len < 16; len++) {
        int count;
        code |= getbit(s, 1);
        if (s->fail) return -1;
        count = h->count[len];
        if (code - count < first) return h->symbol[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    s->fail = true;
    return -1;
}

static const int16_t LBASE[29] = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
                                   67, 83, 99, 115, 131, 163, 195, 227, 258 };
static const int16_t LEXT[29] = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
                                  5, 5, 5, 5, 0 };
static const int16_t DBASE[30] = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
                                   769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 };
static const int16_t DEXT[30] = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
                                  11, 11, 12, 12, 13, 13 };

static bool codes(Inflate *s, const Huff *lencode, const Huff *distcode)
{
    for (;;) {
        int sym = huff_decode(s, lencode);
        if (s->fail || sym < 0) return false;
        if (sym < 256) {
            if (!put(s, 1)) return false;
            s->out[s->outLen++] = (uint8_t)sym;
        } else if (sym == 256) {
            return true;
        } else {
            int len, dsym;
            size_t dist, k;
            sym -= 257;
            if (sym >= 29) return false;
            len = LBASE[sym] + getbit(s, LEXT[sym]);
            dsym = huff_decode(s, distcode);
            if (s->fail || dsym < 0 || dsym >= 30) return false;
            dist = (size_t)(DBASE[dsym] + getbit(s, DEXT[dsym]));
            if (s->fail || dist > s->outLen || !put(s, (size_t)len)) return false;
            for (k = 0; k < (size_t)len; k++) { s->out[s->outLen] = s->out[s->outLen - dist]; s->outLen++; }
        }
    }
}

static bool inflate_block_stored(Inflate *s)
{
    unsigned len, nlen;
    s->bitbuf = 0;
    s->bitcnt = 0;
    if (s->pos + 4 > s->len) return false;
    len = s->src[s->pos] | (s->src[s->pos + 1] << 8);
    nlen = s->src[s->pos + 2] | (s->src[s->pos + 3] << 8);
    s->pos += 4;
    if (len != (~nlen & 0xffff) || s->pos + len > s->len || !put(s, len)) return false;
    memcpy(s->out + s->outLen, s->src + s->pos, len);
    s->outLen += len;
    s->pos += len;
    return true;
}

static bool inflate_block_fixed(Inflate *s)
{
    Huff lc, dc;
    uint8_t lengths[320];
    int sym;
    for (sym = 0; sym < 144; sym++) lengths[sym] = 8;
    for (; sym < 256; sym++) lengths[sym] = 9;
    for (; sym < 280; sym++) lengths[sym] = 7;
    for (; sym < 288; sym++) lengths[sym] = 8;
    huff_build(&lc, lengths, 288);
    for (sym = 0; sym < 30; sym++) lengths[sym] = 5;
    huff_build(&dc, lengths, 30);
    return codes(s, &lc, &dc);
}

static bool inflate_block_dynamic(Inflate *s)
{
    static const uint8_t order[19] = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 };
    uint8_t lengths[320];
    Huff lc, dc;
    int nlen = getbit(s, 5) + 257, ndist = getbit(s, 5) + 1, ncode = getbit(s, 4) + 4, index;
    if (s->fail || nlen > 286 || ndist > 30) return false;
    for (index = 0; index < ncode; index++) lengths[order[index]] = (uint8_t)getbit(s, 3);
    for (; index < 19; index++) lengths[order[index]] = 0;
    if (s->fail || !huff_build(&lc, lengths, 19)) return false;
    index = 0;
    while (index < nlen + ndist) {
        int sym = huff_decode(s, &lc), len = 0, rep;
        if (s->fail || sym < 0) return false;
        if (sym < 16) { lengths[index++] = (uint8_t)sym; continue; }
        if (sym == 16) {
            if (index == 0) return false;
            len = lengths[index - 1];
            rep = 3 + getbit(s, 2);
        } else if (sym == 17) {
            rep = 3 + getbit(s, 3);
        } else {
            rep = 11 + getbit(s, 7);
        }
        if (index + rep > nlen + ndist) return false;
        while (rep--) lengths[index++] = (uint8_t)len;
    }
    if (lengths[256] == 0) return false;
    if (!huff_build(&lc, lengths, nlen) || !huff_build(&dc, lengths + nlen, ndist)) return false;
    return codes(s, &lc, &dc);
}

uint8_t *te_gunzip(const uint8_t *src, size_t len, size_t expected, size_t *outLen)
{
    Inflate s;
    size_t p = 10;
    int flg, last;
    memset(&s, 0, sizeof s);
    if (len < 18 || src[0] != 0x1f || src[1] != 0x8b || src[2] != 8) return NULL;
    flg = src[3];
    if (flg & 4) { if (p + 2 > len) return NULL; p += 2 + (src[p] | (src[p + 1] << 8)); }
    if (flg & 8) { while (p < len && src[p]) p++; p++; }
    if (flg & 16) { while (p < len && src[p]) p++; p++; }
    if (flg & 2) p += 2;
    if (p > len) return NULL;
    s.src = src;
    s.len = len;
    s.pos = p;
    if (expected > 0 && !put(&s, expected)) return NULL;
    do {
        int type;
        bool ok;
        last = getbit(&s, 1);
        type = getbit(&s, 2);
        if (s.fail) break;
        if (type == 0) ok = inflate_block_stored(&s);
        else if (type == 1) ok = inflate_block_fixed(&s);
        else if (type == 2) ok = inflate_block_dynamic(&s);
        else ok = false;
        if (!ok) { s.fail = true; break; }
    } while (!last);
    if (s.fail) { free(s.out); return NULL; }
    *outLen = s.outLen;
    if (s.outLen < expected) {
        if (!put(&s, expected - s.outLen)) { free(s.out); return NULL; }
        memset(s.out + s.outLen, 0, expected - s.outLen);
    }
    if (s.out == NULL) s.out = (uint8_t *)malloc(1);
    return s.out;
}

uint8_t *te_decompress(const uint8_t *src, size_t len, size_t expected, size_t *outLen)
{
    *outLen = 0;
    if (len >= 3 && src[0] == 0x1f && src[1] == 0x8b && src[2] == 0x08) {
        return te_gunzip(src, len, expected, outLen);
    }
    if (len >= 4 && src[0] == 0x28 && src[1] == 0xb5 && src[2] == 0x2f && src[3] == 0xfd) {
        return te_zstd_decompress(src, len, expected, outLen);
    }
    return NULL;
}
